import * as THREE from 'three';
import { CHUNK_LEN, VIEW_AHEAD, VIEW_BEHIND } from '../core/config.js';
import { createMaterials, updateLightLevels } from './furniture/materials.js';
import { BatchSet } from './furniture/instancer.js';
import { buildCafeProtos, placeCafes, planAllCafes, chairPose, cafeStyle } from './furniture/cafe.js';
import { buildStreetProtos, placeStreetFurniture } from './furniture/street.js';
import { buildPlatformProtos, placePlatforms } from './furniture/platform.js';

// Street furniture, café terraces and tram-stop platforms. Contract: docs/ARCHITECTURE.md.
// Prototype geometry and materials are built once in init and registered into global
// BatchedMeshes (one per material); a chunk build only adds instances at the layout
// positions (layout.cafes / layout.furniture / layout.stations). Unique per-site geometry
// (platform bodies) is built once, cached and shared. Far chunks keep every item at its
// far detail level; level switches cross-fade (instancer.js).

/** Debug overlay (fpdebug=1): café footprints as lines just above the paving. */
function footprintLines(cafe, st, app) {
  const pts = [], p = new THREE.Vector3();
  const loop = (fn, n) => { for (let i = 0; i < n; i++) { pts.push(...fn(i / n)); pts.push(...fn((i + 1) / n)); } };
  const W = (s, d) => app.route.toWorld(s, d, 0.03, p).toArray();
  const k = st.plan.k;
  const rectAt = (s, d, yaw, hu, hv, du = 0) => {
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const corner = (a, b) => W(s + (c * (du + a) - sn * b) / k, d + sn * (du + a) + c * b);
    const cs = [corner(hu, hv), corner(-hu, hv), corner(-hu, -hv), corner(hu, -hv)];
    for (let i = 0; i < 4; i++) pts.push(...cs[i], ...cs[(i + 1) % 4]);
  };
  for (const c of st.plan.stats.chairs) {
    const f = st.plan.foot;
    rectAt(c.src.s, c.src.d, c.yaw, (f.z1 - f.z0) / 2, f.hx, (f.z0 + f.z1) / 2);
  }
  for (const u of st.umbrellas) {
    if (u.base === 'slab') rectAt(u.s, u.d, u.baseYaw, 0.28, 0.28);
    else if (u.base === 'disc') loop((t) => W(u.s + Math.cos(t * 6.283) * 0.23 / k, u.d + Math.sin(t * 6.283) * 0.23), 16);
    rectAt(u.s, u.d, 0, u.size / 2, u.size / 2);
  }
  for (const t of cafe.tables) loop((q) => W(t.s + Math.cos(q * 6.283) * 0.3 / k, t.d + Math.sin(q * 6.283) * 0.3), 16);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, app.materials.track(new THREE.LineBasicMaterial({ color: 0xff2060, depthTest: false })));
}

function disposeOwn(obj) {
  obj.traverse((o) => { if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose(); });
}

const furniture = {
  name: 'furniture',

  async init(app) {
    const t0 = performance.now();
    this.app = app;
    const T = (this.initTimes = {});
    const lap = (k, t = performance.now()) => { T[k] = +(performance.now() - t).toFixed(1); };
    let t = performance.now();
    this.F = createMaterials(app);
    lap('materials', t); t = performance.now();
    const M = app.materials;
    this.P = { cafe: buildCafeProtos(M, this.F), street: buildStreetProtos(M, this.F), platform: buildPlatformProtos(M, this.F) };
    this.batches = new BatchSet('furniture');
    this.batches.registerTree(this.P);
    lap('protos', t); t = performance.now();
    // collision-free café plans (adjusted chair poses are written back for seated patrons)
    this.cafeAudit = planAllCafes(app);
    lap('plans', t); t = performance.now();
    this.debugFoot = app.params.str('fpdebug') === '1';
    // sizing pass over the whole loop: warms the per-site caches (café styles, platform
    // bodies) and sizes every batch for the busiest stretch of streamed chunks
    const n = app.layout.nChunks, per = [];
    for (let i = 0; i < n; i++) {
      const w = this.batches.countingWriter();
      this._place({ index: i, s0: i * CHUNK_LEN, s1: (i + 1) * CHUNK_LEN, lod: 0 }, app, w, () => {});
      per.push(w.counts);
    }
    // far-range builds too (warms the lod-1 platform bodies so no chunk pays for them later)
    for (let i = 0; i < n; i++) this._place({ index: i, s0: i * CHUNK_LEN, s1: (i + 1) * CHUNK_LEN, lod: 1 }, app, this.batches.countingWriter(), () => {});
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
    lap('sizing', t);
    this.initMs = performance.now() - t0;
  },

  _place(chunk, app, inst, addMesh, debug = null) {
    placeCafes(chunk, app, inst, this.P.cafe, debug);
    placeStreetFurniture(chunk, app, inst, this.P.street);
    placePlatforms(chunk, app, inst, addMesh, this.P.platform, this.F);
  },

  build(chunk, app) {
    const group = new THREE.Group();
    group.name = 'furniture';
    const inst = this.batches.writer(group, app.camera.position);
    // unique per-site geometry (cached, shared): one mesh per geometry
    const addMesh = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    };
    this._place(chunk, app, inst, addMesh, this.debugFoot ? (cafe, st) => group.add(footprintLines(cafe, st, app)) : null);
    return group;
  },

  /** Adjusted café chair pose {s, d, yaw} (yaw: route-relative heading, faces the table). */
  chairPose(cafeId, tableIdx, chairIdx) { return chairPose(this.app, cafeId, tableIdx, chairIdx); },

  /** Planned umbrellas of a café [{s, d, size, base, ...}] (inspection / debugging). */
  cafeUmbrellas(cafeId) { const c = this.app.layout.cafes[cafeId]; return c ? cafeStyle(c, this.app).umbrellas : null; },

  update(dt, app) {
    updateLightLevels(this.F, app);
    this.batches.updateLod(app.camera.position);
  },

  dispose(obj) {
    this.batches.release(obj);
    disposeOwn(obj);
  },
};

export default furniture;
