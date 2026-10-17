import * as THREE from 'three';

// One BatchedMesh per material holding every tree / shrub / prop geometry the street uses.
// Chunks add instances when they are built and remove them when recycled, so the whole
// street's foliage is a single draw call (plus one per shadow cascade), with per-instance
// frustum culling and front-to-back sorting (less overdraw for the alpha-tested crowns).
//
// Visibility follows the chunk: the streamer keeps a chunk's group hidden until all its
// modules are built and swaps LOD replacements in atomically, so each chunk's instances
// are toggled to match their marker group right before rendering.
//
// Detail level is chosen per instance and per frame from its projected height on screen
// (so it adapts to the telephoto / wide field of view), with hysteresis against flicker:
//   L0 > LOD_PX[0] px, L1 > LOD_PX[1] px, L2 below.
// A level change cross-fades over FADE_S: a temporary second instance keeps the old
// geometry while both dissolve with complementary screen-space dither patterns (the
// instance's batch colour alpha carries the fade, see vegMaterials.js).
//
// A pool can draw a depth pre-pass first (preMaterial): a twin BatchedMesh that shares
// the pool's geometry and instance data (matrices, colours, visibility, culling) and is
// drawn before everything else, so the real material only shades what is visible.
//
// Shadow passes build their own draw list per cascade (shadowList): an instance casts
// only where its shadow can reach the cascade's slice of the view (the light's cascade
// frustum decides, so stale cascades that are not redrawn this frame cost nothing), at
// no more detail than the cascade's texels can hold (SHADOW_LEVEL_TEXEL), and pools of
// thin props stop casting in coarse cascades altogether (shadowMaxTexel).

const LOD_PX = [380, 95];
const HYST = 0.08;
const FADE_S = 0.35;
// cascade texel (m) above which shadows use at least detail level 1 / 2 (per pool option)
const SHADOW_LEVEL_TEXEL = [0.025, 0.07];

const _c4 = new THREE.Vector4();
const _m4 = new THREE.Matrix4();
const _sph = new THREE.Sphere();
const _fr = new THREE.Frustum();
const _pm = new THREE.Matrix4();
// stand-ins handed to the light's cascade frustum: one instance, or the whole pool
// (an instance is presented as a shadow proxy with its world sphere, which the env's
// cascade frustums test as is: slice, sub-texel and box; a plain frustum reads the
// geometry's sphere with an identity transform)
const _one = { geometry: { boundingSphere: _sph }, matrixWorld: new THREE.Matrix4(), userData: { thinCaster: false, shadowProxy: { active: true }, shadowSphere: _sph } };
const _all = { boundingSphere: new THREE.Sphere(new THREE.Vector3(), 1e7), matrixWorld: new THREE.Matrix4(), userData: { thinCaster: false } };

/** World texel (m) of the shadow cascade a frustum belongs to (0: not a cascade). */
const _texels = new WeakMap();
function cascadeTexel(scene, f) {
  let cam = _texels.get(f);
  if (cam === undefined) {
    cam = null;
    for (const o of scene.children) {
      const sh = o.isLight && o.castShadow && o.shadow;
      if (!sh || !sh.getFrustum || !sh.getCamera) continue;
      for (let i = 0, n = sh.getViewportCount(); i < n; i++) if (sh.getFrustum(i) === f) cam = { cam: sh.getCamera(i), shadow: sh };
    }
    _texels.set(f, cam);
  }
  return cam && cam.cam.isOrthographicCamera ? (cam.cam.right - cam.cam.left) / Math.max(1, cam.shadow.mapSize.x) : 0;
}

/** {frustum, texel} of a shadow camera: the light's own (slice-aware) cascade frustum when
 *  it has one, else a plain frustum of the camera. Cached per camera. */
const _cascades = new WeakMap();
function cascadeOf(scene, cam) {
  let c = _cascades.get(cam);
  if (!c) {
    c = { frustum: null, shadow: null };
    for (const o of scene.children) {
      const sh = o.isLight && o.castShadow && o.shadow;
      if (!sh || !sh.getFrustum || !sh.getCamera) continue;
      for (let i = 0, n = sh.getViewportCount(); i < n; i++) if (sh.getCamera(i) === cam) { c.frustum = sh.getFrustum(i); c.shadow = sh; }
    }
    _cascades.set(cam, c);
  }
  if (!c.frustum) c.plain = _fr.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse), cam.coordinateSystem, cam.reversedDepth);
  c.texel = cam.isOrthographicCamera ? (cam.right - cam.left) / Math.max(1, c.shadow ? c.shadow.mapSize.x : 2048) : 0;
  return c;
}

export class InstancePool {
  constructor(name, material, depthMaterial, geometries, capacity = 512, { castShadow = true, receiveShadow = true, sort = true, shadowMaxTexel = Infinity, shadowLevels = SHADOW_LEVEL_TEXEL, preMaterial = null } = {}) {
    let vc = 0, ic = 0;
    for (const g of geometries) { vc += g.attributes.position.count; ic += g.index.count; }
    const mesh = new THREE.BatchedMesh(capacity, vc, ic, material);
    mesh.name = name;
    if (depthMaterial) mesh.customDepthMaterial = depthMaterial;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.frustumCulled = false;        // instances span the whole streamed street
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = sort;
    // colour texture from the start, so the programs compiled up front (empty pools) are
    // the ones used later
    if (mesh._initColorsTexture && !mesh._colorsTexture) mesh._initColorsTexture();
    this.mesh = mesh;
    this.shadowMaxTexel = shadowMaxTexel;
    this.shadowLevels = shadowLevels;
    this.lodGids = new Int32Array(capacity * 3).fill(-1); // per instance: geometry ids [L0, L1, L2] or -1
    this.geomIds = geometries.map((g) => mesh.addGeometry(g));
    // Per-instance culling uses each geometry's bounding sphere, computed from its vertices.
    // Pad it for wind sway. three r186 caches the sphere in _geometryInfo (vendored, fixed).
    const sphere = new THREE.Sphere();
    geometries.forEach((g, i) => {
      const id = this.geomIds[i];
      mesh.getBoundingSphereAt(id, sphere);
      const info = mesh._geometryInfo && mesh._geometryInfo[id];
      if (info && info.boundingSphere) info.boundingSphere.radius += 0.3 + (g.userData.boundsPad || 0);
    });
    if (preMaterial) {
      const twin = new THREE.BatchedMesh(1, 3, 3, preMaterial);
      twin.name = `${name}:pre`;
      twin.frustumCulled = false;
      twin.perObjectFrustumCulled = true;
      twin.sortObjects = true;          // front to back: the most occlusion for the least work
      twin.castShadow = false;
      twin.receiveShadow = receiveShadow; // same vertex shader as the pool's (invariant depth)
      twin.renderOrder = -1;
      this.twin = twin;
      this.linkTwin();
    }
  }

  /** Point the pre-pass twin at the pool's current data (buffers are replaced on growth). */
  linkTwin() {
    const t = this.twin, m = this.mesh;
    t.geometry = m.geometry;
    t._matricesTexture = m._matricesTexture;
    t._colorsTexture = m._colorsTexture;
    t._indirectTexture = m._indirectTexture;
    t._instanceInfo = m._instanceInfo;
    t._availableInstanceIds = m._availableInstanceIds;
    t._geometryInfo = m._geometryInfo;
    t._geometryCount = m._geometryCount;
    t._maxInstanceCount = m._maxInstanceCount;
    t._multiDrawStarts = m._multiDrawStarts;
    t._multiDrawCounts = m._multiDrawCounts;
    t.visible = m.visible;
  }

  /** New hidden instance; color: THREE.Color (alpha reset to 1 = no fade). lods: the
   *  geometry indices of its detail levels (shadow detail), or null for a fixed geometry. */
  add(geomIndex, matrix, color, lods = null) {
    const m = this.mesh;
    if (m.instanceCount >= m.maxInstanceCount) m.setInstanceCount(Math.ceil(m.maxInstanceCount * 1.5));
    const id = m.addInstance(this.geomIds[geomIndex]);
    m.setMatrixAt(id, matrix);
    _c4.set(color ? color.r : 1, color ? color.g : 1, color ? color.b : 1, 1);
    m.setColorAt(id, _c4);
    m.setVisibleAt(id, false);
    this._setLods(id, lods);
    return id;
  }

  /** Copy of an instance (same matrix, colour and levels) with another geometry. */
  clone(id, geomIndex) {
    const m = this.mesh;
    if (m.instanceCount >= m.maxInstanceCount) m.setInstanceCount(Math.ceil(m.maxInstanceCount * 1.5));
    const n = m.addInstance(this.geomIds[geomIndex]);
    m.setMatrixAt(n, m.getMatrixAt(id, _m4));
    m.setColorAt(n, m.getColorAt(id, _c4));
    this._grow(n);
    this.lodGids.copyWithin(n * 3, id * 3, id * 3 + 3);
    return n;
  }

  _grow(id) {
    if (id * 3 + 3 <= this.lodGids.length) return;
    const a = new Int32Array(Math.max(id * 3 + 3, this.lodGids.length * 2)).fill(-1);
    a.set(this.lodGids);
    this.lodGids = a;
  }

  _setLods(id, lods) {
    this._grow(id);
    for (let k = 0; k < 3; k++) this.lodGids[id * 3 + k] = lods ? this.geomIds[lods[Math.min(k, lods.length - 1)]] : -1;
  }

  /**
   * Shadow pass draw list for one cascade (replaces BatchedMesh's own culling): instances
   * whose shadow can reach the cascade, each at the coarsest of its current level and the
   * level the cascade's texels can hold.
   */
  shadowList(scene, cam) {
    const m = this.mesh, c = cascadeOf(scene, cam);
    const info = m._instanceInfo, gInfo = m._geometryInfo, lod = this.lodGids;
    const starts = m._multiDrawStarts, counts = m._multiDrawCounts, ind = m._indirectTexture.image.data;
    const md = m._matricesTexture.image.data;
    const bpe = m.geometry.getIndex().array.BYTES_PER_ELEMENT;
    const frustum = c.frustum || c.plain;
    const L = this.shadowLevels, minLv = c.texel > L[1] ? 2 : c.texel > L[0] ? 1 : 0;
    let n = 0;
    if (c.texel <= this.shadowMaxTexel) {
      for (let i = 0, l = info.length; i < l; i++) {
        const it = info[i];
        if (!it.visible || !it.active) continue;
        let gid = it.geometryIndex;
        if (minLv && lod[i * 3] >= 0) {
          const cur = gid === lod[i * 3] ? 0 : gid === lod[i * 3 + 1] ? 1 : 2;
          gid = lod[i * 3 + Math.max(cur, minLv)];
        }
        _sph.copy(gInfo[gid].boundingSphere).applyMatrix4(_m4.fromArray(md, i * 16).premultiply(m.matrixWorld));
        if (!frustum.intersectsObject(_one)) continue;
        const g = gInfo[gid];
        starts[n] = g.start * bpe;
        counts[n] = g.count;
        ind[n] = i;
        n++;
      }
    }
    m._indirectTexture.needsUpdate = true;
    m._multiDrawCount = n;
    m._multiDrawBytesPerElement = bpe;
  }

  setAlpha(id, a) {
    const m = this.mesh;
    m.getColorAt(id, _c4);
    _c4.w = a;
    m.setColorAt(id, _c4);
  }

  remove(id) { this.mesh.deleteInstance(id); }
  setVisible(id, v) { this.mesh.setVisibleAt(id, v); }
  setGeometry(id, geomIndex) { this.mesh.setGeometryIdAt(id, this.geomIds[geomIndex]); }
}

/** Tracks per-chunk instance records, their visibility and their detail level. */
export class VegetationPools {
  constructor(app) {
    this.app = app;
    this.pools = [];
    this.records = new Set();
    this.fading = new Set();
    this._frame = -1;
    this.forceLod = null;
    this.root = new THREE.Group();
    this.root.name = 'vegetation:pools';
    app.scene.add(this.root);
  }

  addPool(pool) {
    this.pools.push(pool);
    this.root.add(pool.mesh);
    const self = this, mesh = pool.mesh, scene = this.app.scene;
    const proto = THREE.BatchedMesh.prototype;
    mesh.onBeforeRender = function (...args) { self.sync(); return proto.onBeforeRender.apply(this, args); };
    if (pool.twin) {
      this.root.add(pool.twin);
      pool.twin.onBeforeRender = function (...args) { self.sync(); pool.linkTwin(); return proto.onBeforeRender.apply(this, args); };
    }
    mesh.onBeforeShadow = function (renderer, object, camera, shadowCamera) { self.sync(); pool.shadowList(scene, shadowCamera); };
    // whole-pool test: the light's cascade frustum skips cascades it does not redraw this
    // frame, as do cascades coarser than the pool's limit; any other frustum (the view)
    // keeps the pool (instances are culled per pass)
    mesh.frustumCulled = true;
    mesh.intersectsFrustum = (f) => f.intersectsObject(_all) && (pool.shadowMaxTexel === Infinity || cascadeTexel(scene, f) <= pool.shadowMaxTexel);
    return pool;
  }

  /** New record for a chunk; `marker` is the Object3D returned to the streamer. */
  record(marker) {
    const rec = { marker, entries: [], visible: false };
    marker.userData.vegRecord = rec;
    this.records.add(rec);
    return rec;
  }

  /**
   * Add an instance to a record. lods: geometry indices [L0, L1, L2] (or one index for a
   * fixed geometry); pos: world position; size: world height for the screen-size metric.
   */
  add(rec, pool, lods, matrix, color, pos, size) {
    const fixed = typeof lods === 'number';
    const lod = fixed ? 0 : (this.forceLod ?? 2);
    const id = pool.add(fixed ? lods : lods[lod], matrix, color, fixed ? null : lods);
    rec.entries.push({ pool, id, lods, fixed, x: pos.x, y: pos.y + size * 0.5, z: pos.z, size, lod, fadeId: -1, fadeT0: 0 });
  }

  release(rec) {
    if (!rec || !this.records.has(rec)) return;
    for (const e of rec.entries) {
      if (e.fadeId >= 0) { e.pool.remove(e.fadeId); this.fading.delete(e); }
      e.pool.remove(e.id);
    }
    rec.entries.length = 0;
    this.records.delete(rec);
  }

  _endFade(e) {
    e.pool.remove(e.fadeId);
    e.fadeId = -1;
    e.pool.setAlpha(e.id, 1);
    this.fading.delete(e);
  }

  /** Once per frame: visibility from the chunk groups, detail level from screen size. */
  sync() {
    const app = this.app;
    if (app.frame === this._frame) return;
    this._frame = app.frame;
    const now = performance.now() / 1000;
    const cam = app.camera, cp = cam.position;
    const k = (app.canvas.height || 1080) / (2 * Math.tan((cam.fov * Math.PI) / 360) * (cam.zoom || 1));
    const forced = this.forceLod;
    for (const rec of this.records) {
      const g = rec.marker.parent;
      const vis = !!(g && g.visible && g.parent);
      if (vis !== rec.visible) {
        rec.visible = vis;
        for (const e of rec.entries) {
          if (e.fadeId >= 0) this._endFade(e);
          e.pool.setVisible(e.id, vis);
        }
      }
      if (!vis) continue;
      for (const e of rec.entries) {
        if (e.fixed) continue;
        let lod;
        if (forced !== null) lod = forced;
        else {
          const px = (e.size * k) / Math.max(1, Math.hypot(e.x - cp.x, e.y - cp.y, e.z - cp.z));
          const cur = e.lod;
          // thresholds move by HYST against the current level so a tree on a boundary stays put
          const t0 = LOD_PX[0] * (cur === 0 ? 1 - HYST : 1 + HYST);
          const t1 = LOD_PX[1] * (cur <= 1 ? 1 - HYST : 1 + HYST);
          lod = px > t0 ? 0 : px > t1 ? 1 : 2;
        }
        if (lod === e.lod) continue;
        if (e.fadeId >= 0) this._endFade(e);
        if (forced === null && e.lods[lod] !== e.lods[e.lod]) {
          // cross-fade: the old level stays on a temporary instance and dissolves out
          e.fadeId = e.pool.clone(e.id, e.lods[e.lod]);
          e.fadeT0 = now;
          e.pool.setAlpha(e.fadeId, 1.001);
          e.pool.setAlpha(e.id, 0.001);
          this.fading.add(e);
        }
        e.lod = lod;
        e.pool.setGeometry(e.id, e.lods[lod]);
      }
    }
    for (const e of this.fading) {
      const f = (now - e.fadeT0) / FADE_S;
      if (f >= 1) { this._endFade(e); continue; }
      e.pool.setAlpha(e.id, Math.max(0.001, f));
      e.pool.setAlpha(e.fadeId, 1 + Math.max(0.001, f));
    }
  }
}
