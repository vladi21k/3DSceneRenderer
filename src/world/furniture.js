import * as THREE from 'three';
import { MeshBatcher } from '../core/geom.js';
import { createMaterials } from './furniture/materials.js';
import { BatchSet } from './furniture/instancer.js';
import { buildCafeProtos, placeCafes, buildCafeCanopy } from './furniture/cafe.js';

// Street furniture, café terraces and tram-stop platforms. Contract: docs/ARCHITECTURE.md.
// Prototype geometry and materials are built once in init and registered into global
// BatchedMeshes (one per material); a chunk build only adds instances at the layout
// positions (layout.cafes / layout.furniture / layout.stations). Unique per-site geometry
// (platform slabs, café canopies) is merged per chunk.

function disposeOwn(obj) {
  obj.traverse((o) => { if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose(); });
}

const furniture = {
  name: 'furniture',

  async init(app) {
    const t0 = performance.now();
    this.F = createMaterials(app);
    this.P = { cafe: buildCafeProtos(app.materials, this.F) };
    this.batches = new BatchSet('furniture');
    this.batches.registerTree(this.P);
    this.batches.finalize(app.scene, app.renderer);
    this.initMs = performance.now() - t0;
  },

  build(chunk, app) {
    const group = new THREE.Group();
    group.name = 'furniture';
    const inst = this.batches.writer(group);
    const merged = new MeshBatcher();
    const canopies = [];
    placeCafes(chunk, app, inst, this.P.cafe, canopies);
    for (const c of canopies) buildCafeCanopy(c, app, merged, this.F);
    if (merged.map.size) group.add(merged.build({ name: 'furniture-merged' }));
    return group;
  },

  dispose(obj) {
    this.batches.release(obj);
    disposeOwn(obj);
  },
};

export default furniture;
