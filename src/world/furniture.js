import * as THREE from 'three';
import { CHUNK_LEN, VIEW_AHEAD, VIEW_BEHIND } from '../core/config.js';
import { createMaterials } from './furniture/materials.js';
import { BatchSet } from './furniture/instancer.js';
import { buildCafeProtos, placeCafes, buildCafeCanopy } from './furniture/cafe.js';
import { buildStreetProtos, placeStreetFurniture } from './furniture/street.js';
import { buildPlatformProtos, placePlatforms } from './furniture/platform.js';

// Street furniture, café terraces and tram-stop platforms. Contract: docs/ARCHITECTURE.md.
// Prototype geometry and materials are built once in init and registered into global
// BatchedMeshes (one per material); a chunk build only adds instances at the layout
// positions (layout.cafes / layout.furniture / layout.stations). Unique per-site geometry
// (platform bodies, café canopy roofs) is built once, cached and shared.

function disposeOwn(obj) {
  obj.traverse((o) => { if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose(); });
}

const furniture = {
  name: 'furniture',

  async init(app) {
    const t0 = performance.now();
    this.F = createMaterials(app);
    const M = app.materials;
    this.P = { cafe: buildCafeProtos(M, this.F), street: buildStreetProtos(M, this.F), platform: buildPlatformProtos(M, this.F) };
    this.batches = new BatchSet('furniture');
    this.batches.registerTree(this.P);
    // sizing pass over the whole loop: warms the per-site caches (café styles, canopy roofs,
    // platform bodies) and sizes every batch for the busiest stretch of streamed chunks
    const n = app.layout.nChunks, per = [];
    for (let i = 0; i < n; i++) {
      const w = this.batches.countingWriter();
      this._place({ index: i, s0: i * 40, s1: i * 40 + 40, lod: 0 }, app, w, () => {});
      per.push(w.counts);
    }
    const win = Math.ceil((VIEW_AHEAD + VIEW_BEHIND) / CHUNK_LEN) + 2;
    this.batches.finalize(app.scene, app.renderer, (b) => {
      let best = 0;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < win; k++) sum += per[(i + k) % n].get(b) || 0;
        best = Math.max(best, sum);
      }
      return best * 1.3 + 32;
    });
    this.initMs = performance.now() - t0;
  },

  _place(chunk, app, inst, addMesh) {
    const canopies = [];
    placeCafes(chunk, app, inst, this.P.cafe, canopies);
    for (const c of canopies) buildCafeCanopy(c, app, addMesh, this.F, inst, this.P.cafe);
    placeStreetFurniture(chunk, app, inst, this.P.street);
    placePlatforms(chunk, app, inst, addMesh, this.P.platform, this.F);
  },

  build(chunk, app) {
    const group = new THREE.Group();
    group.name = 'furniture';
    const inst = this.batches.writer(group);
    // unique per-site geometry (cached, shared): one mesh per geometry
    const addMesh = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    };
    this._place(chunk, app, inst, addMesh);
    return group;
  },

  dispose(obj) {
    this.batches.release(obj);
    disposeOwn(obj);
  },
};

export default furniture;
