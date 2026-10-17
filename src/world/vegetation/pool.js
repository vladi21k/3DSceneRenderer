import * as THREE from 'three';

// One BatchedMesh per material holding every tree / shrub template (both LODs). Chunks add
// instances when they are built and remove them when they are recycled, so the whole
// street's foliage is a single draw call (plus one per shadow cascade), with per-instance
// frustum culling and front-to-back sorting (cheaper overdraw for the alpha-tested crowns).
//
// Visibility follows the chunk: the streamer keeps a chunk's group hidden until all its
// modules are built and swaps LOD replacements in atomically, so each chunk's instances
// are toggled to match their marker group right before rendering (see VegetationPools.sync).

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
}

/** Tracks per-chunk instance records and keeps their visibility in step with the chunks. */
export class VegetationPools {
  constructor(app) {
    this.app = app;
    this.pools = [];
    this.records = new Set();
    this._frame = -1;
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

  release(rec) {
    if (!rec || !this.records.has(rec)) return;
    for (const [pool, id] of rec.entries) pool.remove(id);
    rec.entries.length = 0;
    this.records.delete(rec);
  }

  /** Show instances whose chunk group is visible and attached; once per frame. */
  sync() {
    const f = this.app.frame;
    if (f === this._frame) return;
    this._frame = f;
    for (const rec of this.records) {
      const g = rec.marker.parent;
      const vis = !!(g && g.visible && g.parent);
      if (vis !== rec.visible) {
        rec.visible = vis;
        for (const [pool, id] of rec.entries) pool.setVisible(id, vis);
      }
    }
  }
}
