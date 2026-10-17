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

const LOD_PX = [380, 95];
const HYST = 0.08;
const FADE_S = 0.35;

const _c4 = new THREE.Vector4();
const _m4 = new THREE.Matrix4();

export class InstancePool {
  constructor(name, material, depthMaterial, geometries, capacity = 512, { castShadow = true, receiveShadow = true, sort = true } = {}) {
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
    this.mesh = mesh;
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
  }

  /** New hidden instance; color: THREE.Color (alpha reset to 1 = no fade). */
  add(geomIndex, matrix, color) {
    const m = this.mesh;
    if (m.instanceCount >= m.maxInstanceCount) m.setInstanceCount(Math.ceil(m.maxInstanceCount * 1.5));
    const id = m.addInstance(this.geomIds[geomIndex]);
    m.setMatrixAt(id, matrix);
    _c4.set(color ? color.r : 1, color ? color.g : 1, color ? color.b : 1, 1);
    m.setColorAt(id, _c4);
    m.setVisibleAt(id, false);
    return id;
  }

  /** Copy of an instance (same matrix and colour) with another geometry. */
  clone(id, geomIndex) {
    const m = this.mesh;
    if (m.instanceCount >= m.maxInstanceCount) m.setInstanceCount(Math.ceil(m.maxInstanceCount * 1.5));
    const n = m.addInstance(this.geomIds[geomIndex]);
    m.setMatrixAt(n, m.getMatrixAt(id, _m4));
    m.setColorAt(n, m.getColorAt(id, _c4));
    return n;
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
    const self = this, mesh = pool.mesh;
    const proto = THREE.BatchedMesh.prototype;
    mesh.onBeforeRender = function (...args) { self.sync(); return proto.onBeforeRender.apply(this, args); };
    mesh.onBeforeShadow = function (...args) { self.sync(); return proto.onBeforeShadow.apply(this, args); };
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
    const id = pool.add(fixed ? lods : lods[lod], matrix, color);
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
