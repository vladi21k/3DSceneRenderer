import * as THREE from 'three';

// One BatchedMesh per material holding every tree / shrub template at three detail levels.
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

const LOD_PX = [380, 130];
const HYST = 0.08;

export class InstancePool {
  constructor(name, material, depthMaterial, geometries, capacity = 512) {
    let vc = 0, ic = 0;
    for (const g of geometries) { vc += g.attributes.position.count; ic += g.index.count; }
    const mesh = new THREE.BatchedMesh(capacity, vc, ic, material);
    mesh.name = name;
    mesh.customDepthMaterial = depthMaterial;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;        // instances span the whole streamed street
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = true;
    this.mesh = mesh;
    this.geomIds = geometries.map((g) => mesh.addGeometry(g));
  }

  add(geomIndex, matrix, color) {
    const m = this.mesh;
    if (m.instanceCount >= m.maxInstanceCount) m.setInstanceCount(Math.ceil(m.maxInstanceCount * 1.5));
    const id = m.addInstance(this.geomIds[geomIndex]);
    m.setMatrixAt(id, matrix);
    if (color) m.setColorAt(id, color);
    m.setVisibleAt(id, false);
    return id;
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
   * Add an instance to a record. lods: geometry indices [L0, L1, L2]; pos: world position;
   * size: world height used for the screen-size LOD metric.
   */
  add(rec, pool, lods, matrix, color, pos, size) {
    const lod = this.forceLod ?? 2;
    const id = pool.add(lods[lod], matrix, color);
    rec.entries.push({ pool, id, lods, x: pos.x, y: pos.y + size * 0.5, z: pos.z, size, lod });
  }

  release(rec) {
    if (!rec || !this.records.has(rec)) return;
    for (const e of rec.entries) e.pool.remove(e.id);
    rec.entries.length = 0;
    this.records.delete(rec);
  }

  /** Once per frame: visibility from the chunk groups, detail level from screen size. */
  sync() {
    const app = this.app;
    if (app.frame === this._frame) return;
    this._frame = app.frame;
    const cam = app.camera, cp = cam.position;
    const k = (app.canvas.height || 1080) / (2 * Math.tan((cam.fov * Math.PI) / 360) * (cam.zoom || 1));
    const forced = this.forceLod;
    for (const rec of this.records) {
      const g = rec.marker.parent;
      const vis = !!(g && g.visible && g.parent);
      if (vis !== rec.visible) {
        rec.visible = vis;
        for (const e of rec.entries) e.pool.setVisible(e.id, vis);
      }
      if (!vis) continue;
      for (const e of rec.entries) {
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
        if (lod !== e.lod) { e.lod = lod; e.pool.setGeometry(e.id, e.lods[lod]); }
      }
    }
  }
}
