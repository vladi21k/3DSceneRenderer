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
// the pool's geometry and instance data (matrices, colours, visibility) and is drawn
// before everything else, so the real material only shades what is visible. The
// pre-pass only pays off for big crowns close by: it covers the instances shown at full
// detail within PRE_DIST, which the pool's own material (no depth writes) then shades;
// every other instance is drawn once by a third twin with the far material (depth
// writes on, same shader program).
//
// Draw lists are built here, not by BatchedMesh: the view's once per frame (culled per
// instance, front to back when the pool sorts), and the shadow passes' per cascade
// (shadowList): an instance casts only where its shadow can reach the cascade's slice of
// the view (the light's cascade frustum decides, so stale cascades that are not redrawn
// this frame cost nothing), at no more detail than the cascade's texels can hold
// (SHADOW_LEVEL_TEXEL), and pools of thin props stop casting in coarse cascades
// altogether (shadowMaxTexel). Every pass keeps its own indirect texture (IndirectLists),
// uploaded only when its list changed instead of once per pass and cascade.

const LOD_PX = [460, 95];
const HYST = 0.08;
const FADE_S = 0.35;
const PRE_DIST = 60;  // m: crowns closer than this (at full detail) get the depth pre-pass
// cascade texel (m) above which shadows use at least detail level 1 / 2 (per pool option)
const SHADOW_LEVEL_TEXEL = [0.025, 0.07];

const _c4 = new THREE.Vector4();
const _m4 = new THREE.Matrix4();
const _cp = new THREE.Vector3();
const _fw = new THREE.Vector3();
const _sph = new THREE.Sphere();
const _fr = new THREE.Frustum();
const _vf = new THREE.Frustum();
const _pm = new THREE.Matrix4();
// stand-ins handed to the light's cascade frustum: one instance, or the whole pool
// (an instance is presented as a shadow proxy with its world sphere, which the env's
// cascade frustums test as is: slice, sub-texel and box; a plain frustum reads the
// geometry's sphere with an identity transform)
const _one = { geometry: { boundingSphere: _sph }, matrixWorld: new THREE.Matrix4(), userData: { thinCaster: false, shadowProxy: { active: true }, shadowSphere: _sph } };
const _all = { boundingSphere: new THREE.Sphere(new THREE.Vector3(), 1e7), matrixWorld: new THREE.Matrix4(), userData: { thinCaster: false } };

/** World bounding sphere of instance i (geometry sphere bs under the instance matrix at
 *  md[i * 16]) into _sph, without Sphere.applyMatrix4's garbage (Math.max of three). */
function instanceSphere(bs, md, i) {
  const o = i * 16, c = bs.center, x = c.x, y = c.y, z = c.z;
  _sph.center.set(md[o] * x + md[o + 4] * y + md[o + 8] * z + md[o + 12],
    md[o + 1] * x + md[o + 5] * y + md[o + 9] * z + md[o + 13],
    md[o + 2] * x + md[o + 6] * y + md[o + 10] * z + md[o + 14]);
  const sx = md[o] * md[o] + md[o + 1] * md[o + 1] + md[o + 2] * md[o + 2];
  const sy = md[o + 4] * md[o + 4] + md[o + 5] * md[o + 5] + md[o + 6] * md[o + 6];
  const sz = md[o + 8] * md[o + 8] + md[o + 9] * md[o + 9] + md[o + 10] * md[o + 10];
  _sph.radius = bs.radius * Math.sqrt(sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz));
  return _sph;
}

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

/**
 * Indirect textures (draw index -> instance) of a BatchedMesh, one per pass key (the view
 * lists, each shadow camera). three's BatchedMesh refills and re-uploads its single
 * texture for every pass, shadow cascades included, and such an upload can block when
 * the GPU queue is full. Here a list is written into a scratch array (begin) and
 * commit() copies it into the pass's own texture, uploading only when it changed.
 */
export class IndirectLists {
  constructor(mesh) { this.mesh = mesh; this.max = -1; this.size = 0; this.scratch = null; this.tex = new Map(); }

  /** Scratch array for a new list (follows the batch's instance capacity). */
  begin() {
    const max = this.mesh._maxInstanceCount;
    if (max !== this.max) {
      this.max = max;
      this.size = Math.ceil(Math.sqrt(max));
      this.scratch = new Uint32Array(this.size * this.size);
      for (const t of this.tex.values()) t.dispose();
      this.tex.clear();
    }
    return this.scratch;
  }

  /** The texture of pass `key` holding the first n scratch entries. */
  commit(key, n) {
    let t = this.tex.get(key);
    if (!t) {
      t = new THREE.DataTexture(new Uint32Array(this.size * this.size), this.size, this.size, THREE.RedIntegerFormat, THREE.UnsignedIntType);
      t.userData.n = -1;
      this.tex.set(key, t);
    }
    const a = this.scratch, b = t.image.data;
    let same = t.userData.n === n;
    for (let i = 0; same && i < n; i++) same = a[i] === b[i];
    if (!same) {
      b.set(n < a.length ? a.subarray(0, n) : a);
      t.userData.n = n;
      t.needsUpdate = true;
    }
    return t;
  }
}

// Front-to-back order without garbage: TypedArray.sort with a comparator copies the
// array onto the JS heap on every call, so each entry is packed as (quantised depth,
// instance index) into one float64 and the keys are sorted natively.
const IDX_SPAN = 1048576;  // 2^20 instance indices
function sortByDepth(order, n, z, key) {
  if (n < 2) return;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    key[k] = Math.floor(Math.min(Math.max(z[i] + 64, 0), 30000) * 256) * IDX_SPAN + i;
  }
  key.subarray(0, n).sort();
  for (let k = 0; k < n; k++) order[k] = key[k] % IDX_SPAN;
}

/** Fill a target's multi-draw arrays and its pass texture from an instance order. */
function writeList(order, cnt, target, lists, key, info, gInfo, bpe) {
  const starts = target._multiDrawStarts, counts = target._multiDrawCounts, ind = lists.begin();
  for (let k = 0; k < cnt; k++) {
    const i = order[k], g = gInfo[info[i].geometryIndex];
    starts[k] = g.start * bpe;
    counts[k] = g.count;
    ind[k] = i;
  }
  return lists.commit(key, cnt);
}

export class InstancePool {
  constructor(name, material, depthMaterial, geometries, capacity = 512, { castShadow = true, receiveShadow = true, sort = true, shadowMaxTexel = Infinity, shadowLevels = SHADOW_LEVEL_TEXEL, preMaterial = null, farMaterial = null } = {}) {
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
    this.sort = sort;
    this.lists = new IndirectLists(mesh);
    this.view = { frame: -1, camera: null, near: 0, far: 0 };
    this.twin = this.far = null;
    if (preMaterial) {
      // twins: the depth pre-pass (drawn first) and the far instances (far material)
      const twin = (suffix, mat, order) => {
        const t = new THREE.BatchedMesh(1, 3, 3, mat);
        t.name = `${name}:${suffix}`;
        t.frustumCulled = false;
        t.castShadow = false;
        t.receiveShadow = receiveShadow; // same vertex shader as the pool's (invariant depth)
        t.renderOrder = order;
        return t;
      };
      this.twin = twin('pre', preMaterial, -1);
      this.far = twin('far', farMaterial, 0);
      this.linkTwin();
    }
  }

  /** Point the twins at the pool's current data (buffers are replaced on growth). */
  linkTwin() {
    const m = this.mesh;
    for (let k = 0; k < 2; k++) {
      const t = k ? this.far : this.twin;
      t.geometry = m.geometry;
      t._matricesTexture = m._matricesTexture;
      t._colorsTexture = m._colorsTexture;
      t._instanceInfo = m._instanceInfo;
      t._availableInstanceIds = m._availableInstanceIds;
      t._geometryInfo = m._geometryInfo;
      t._geometryCount = m._geometryCount;
      t.visible = m.visible;
    }
    this.twin._maxInstanceCount = m._maxInstanceCount;
    this.twin._multiDrawStarts = m._multiDrawStarts;   // the pre-pass draws the near list
    this.twin._multiDrawCounts = m._multiDrawCounts;
    const f = this.far;
    if (f._maxInstanceCount !== m._maxInstanceCount) {  // the far list has its own
      f._maxInstanceCount = m._maxInstanceCount;
      f._multiDrawStarts = new Int32Array(m._maxInstanceCount);
      f._multiDrawCounts = new Int32Array(m._maxInstanceCount);
      this.farLists = new IndirectLists(m);
    }
  }

  /**
   * View draw lists, once per frame and camera: instances in the frustum (front to back
   * when the pool sorts); with twins, split into the near list (full detail within
   * PRE_DIST: pre-pass + pool material) and the far list (far twin).
   */
  viewLists(camera, frame) {
    const V = this.view;
    if (V.frame === frame && V.camera === camera) return;
    V.frame = frame; V.camera = camera;
    const m = this.mesh, split = !!this.far;
    if (split) this.linkTwin();
    const info = m._instanceInfo, gInfo = m._geometryInfo, lod = this.lodGids;
    const md = m._matricesTexture.image.data;
    const bpe = m.geometry.getIndex().array.BYTES_PER_ELEMENT;
    _vf.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth);
    _cp.setFromMatrixPosition(camera.matrixWorld);
    _fw.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const n = info.length;
    if (!this._z || this._z.length < n) { this._z = new Float32Array(Math.max(64, n * 2)); this._ord = new Uint32Array(this._z.length); this._ordF = new Uint32Array(this._z.length); }
    const z = this._z, near = this._ord, far = this._ordF;
    let nn = 0, nf = 0;
    for (let i = 0; i < n; i++) {
      const it = info[i];
      if (!it.visible || !it.active) continue;
      const gid = it.geometryIndex;
      instanceSphere(gInfo[gid].boundingSphere, md, i);   // (the pool mesh sits at the origin)
      if (!_vf.intersectsSphere(_sph)) continue;
      const d = _sph.center.sub(_cp).dot(_fw);
      z[i] = d;
      if (split && !(lod[i * 3] === gid && d < PRE_DIST)) far[nf++] = i; else near[nn++] = i;
    }
    if (this.sort) {
      if (!this._key || this._key.length < z.length) this._key = new Float64Array(z.length);
      sortByDepth(near, nn, z, this._key);
      sortByDepth(far, nf, z, this._key);
    }
    V.nearTex = writeList(near, nn, m, this.lists, camera, info, gInfo, bpe);
    V.near = nn;
    if (split) { V.farTex = writeList(far, nf, this.far, this.farLists, camera, info, gInfo, bpe); V.far = nf; }
    V.bpe = bpe;
  }

  /** Before a view draw of the pool mesh or one of its twins: its list from viewLists. */
  drawView(target, camera, frame) {
    this.viewLists(camera, frame);
    const V = this.view, isFar = target === this.far;
    target._indirectTexture = isFar ? V.farTex : V.nearTex;
    target._multiDrawCount = isFar ? V.far : V.near;
    target._multiDrawBytesPerElement = V.bpe;
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
    const starts = m._multiDrawStarts, counts = m._multiDrawCounts, ind = this.lists.begin();
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
        instanceSphere(gInfo[gid].boundingSphere, md, i);
        if (!frustum.intersectsObject(_one)) continue;
        const g = gInfo[gid];
        starts[n] = g.start * bpe;
        counts[n] = g.count;
        ind[n] = i;
        n++;
      }
    }
    m._indirectTexture = this.lists.commit(cam, n);
    m._multiDrawCount = n;
    m._multiDrawBytesPerElement = bpe;
    this.view.frame = -1;  // the view lists share the pool's draw arrays: rebuild them after
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
    this.recList = [];         // the same records as an array (iterated every frame: no iterator garbage)
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
    const view = function (renderer, sc, camera) { self.sync(); pool.drawView(this, camera, self.app.frame); };
    mesh.onBeforeRender = view;
    if (pool.twin) {
      this.root.add(pool.twin, pool.far);
      pool.twin.onBeforeRender = view;
      pool.far.onBeforeRender = view;
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
    this.recList.push(rec);
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
    const L = this.recList, i = L.indexOf(rec);
    if (i >= 0) { L[i] = L[L.length - 1]; L.pop(); }
  }

  _endFade(e) {
    e.pool.remove(e.fadeId);
    e.fadeId = -1;
    e.pool.setAlpha(e.id, 1);
    this.fading.delete(e);
  }

  /**
   * Start-up warm-up, every frame until the app is ready: invisible instances (scaled to a
   * few micrometres, a little in front of the eye) in every pool, one in its near list and
   * one in its far list (twins), so every program has its first draw behind the loading
   * screen. The start-up compile links each program, but the GPU process pays a large
   * one-off cost at a program's first draw (100-200 ms, mostly when the browser's shader
   * cache supplied the program): planters first seen mid-ride stalled a frame. `eye`,
   * `dir` (unit): world vectors.
   */
  warmup(eye, dir) {
    _m4.makeScale(1e-5, 1e-5, 1e-5).setPosition(eye.x + dir.x * 2, eye.y + dir.y * 2, eye.z + dir.z * 2);
    if (!this.warm) {
      this.warm = [];
      for (const p of this.pools) {
        this.warm.push(p, p.add(0, _m4, null, [0]));
        if (p.far) this.warm.push(p, p.add(0, _m4, null, null));
      }
    }
    for (let i = 0, W = this.warm; i < W.length; i += 2) {
      const p = W[i], id = W[i + 1];
      p.mesh.setMatrixAt(id, _m4);
      p.setVisible(id, true);
    }
  }

  /** End of the warm-up (the app is ready): remove the warm-up instances. */
  endWarmup() {
    if (!this.warm) return;
    for (let i = 0, W = this.warm; i < W.length; i += 2) W[i].remove(W[i + 1]);
    this.warm = null;
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
    for (let ri = 0, RL = this.recList; ri < RL.length; ri++) {
      const rec = RL[ri];
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
          const dx = e.x - cp.x, dy = e.y - cp.y, dz = e.z - cp.z;   // (Math.hypot of 3 allocates)
          const px = (e.size * k) / Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
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
