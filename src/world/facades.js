import * as THREE from 'three';
import { CHUNK_LEN } from '../core/config.js';
import { facadePlan } from './facadePlan.js';
import { Kit } from './facades/kit.js';
import { createInteriorGlass, GLASS_ATTRS } from './facades/interior.js';
import { createSignMaterials } from './facades/signs.js';
import { createAwningMaterial } from './facades/awnings.js';
import { lanternTpls, signLampTpls, intercomTpl, createLampGlass } from './facades/extras.js';
import { buildFront } from './facades/place.js';

// Facade infill: windows, shopfronts, doors, shutters, signage, awnings and small wall
// fittings for every opening of facadePlan(lot): main-street lots, side-street lots and
// corner returns alike. Openings are holes with reveals cut by `buildings`; the infill sits
// at w = −opening.recess in the lot frame and follows the hole outline exactly
// (facades/outline.js mirrors facadePlan.archPoint).
//
// Geometry is assembled per chunk into one buffer per material (facades/geo.js) from
// per-opening templates cached by size and style, so a chunk costs ~12 draw calls.

const facades = {
  name: 'facades',

  async init(app) {
    const M = app.materials;
    const white = new THREE.Color(1, 1, 1);
    const vc = (name) => M.get(name, { vertexColors: true, color: white });
    const glass = M.register('facades.glassInterior', createInteriorGlass());
    const sign = createSignMaterials(M);
    M.register('facades.signBoard', sign.board);
    M.register('facades.signText', sign.text);
    const awning = M.register('facades.awning', createAwningMaterial(M));
    const lamp = M.register('facades.lampGlass', createLampGlass(M));
    this.mats = {
      // joinery sits inside the reveals, which already shade it: no shadow casting
      frame: { material: vc('paint.frame'), castShadow: false },
      shutter: { material: vc('wood.shutter') },
      door: { material: vc('wood.door'), castShadow: false },
      glass: { material: glass, color: false, extra: GLASS_ATTRS, castShadow: false },
      metal: { material: vc('metal.iron') },
      hardware: { material: vc('metal.steel'), castShadow: false },
      stone: { material: M.get('stone.smooth', { vertexColors: true }), castShadow: false },
      awning: { material: awning, extra: { aStripe: 4, aFlex: 1 } },
      signBoard: { material: sign.board, extra: { aGlow: 1 } },
      signText: { material: sign.text, extra: { aGlow: 1 }, castShadow: false, renderOrder: 2 },
      lamp: { material: lamp, color: false, castShadow: false },
    };
    this.jobs = new Map();          // prefetched chunk builds, key "index:lod"
    this.prefetchMs = 1.2;          // per-frame budget for prefetching
    this.assets = [1, 0.4].map((q) => ({ lantern: lanternTpls(q), signLamp: signLampTpls(q), intercom: intercomTpl(q) }));
    if (app.params.str('fwall')) {
      const { DevWall } = await import('./facades/devwall.js');
      this.devWall = new DevWall(app);
    }
  },

  /**
   * Chunk build as a generator that yields after every lot, so the same work can run
   * either synchronously (build) or time-sliced ahead of need (update → prefetch).
   */
  *buildGen(chunk, app) {
    const { layout } = app;
    const lots = [...layout.inChunk('lots', chunk.index), ...layout.inChunk('sideLots', chunk.index)];
    if (!lots.length) return null;
    const kit = new Kit(this.mats, chunk.lod);
    const q = chunk.lod === 0 ? 1 : 0.4;
    const assets = this.assets[chunk.lod === 0 ? 0 : 1];
    for (const lot of lots) {
      const plan = facadePlan(lot);
      const streetW = lot.sideStreet ? lot.cross.width : 2 * lot.d;
      const fronts = [{ plan, frame: lot.frame, streetW }];
      // corner returns face the side street
      for (const r of plan.returns || []) fronts.push({ plan: r, frame: r.frame, streetW: 10 });
      for (const fr of fronts) {
        const ctx = {
          plan: fr.plan, frame: fr.frame, lot, q, lod: chunk.lod, assets,
          streetW: fr.streetW,
          angle: Math.atan2(fr.frame.uDir.z, fr.frame.uDir.x),
        };
        yield* buildFront(kit, ctx);
        if (this.devWall) this.devWall.add(kit, ctx);
      }
    }
    const group = new THREE.Group();
    group.name = 'facades';
    kit.meshes(group, 'facades');
    return group;
  },

  build(chunk, app) {
    const key = `${chunk.index}:${chunk.lod}`;
    let job = this.jobs.get(key);
    if (job) this.jobs.delete(key);
    else job = { it: this.buildGen(chunk, app) };
    if (!job.done) this._pump(job, Infinity);
    return job.result;
  },

  _pump(job, until) {
    let r;
    do { r = job.it.next(); } while (!r.done && performance.now() < until);
    if (r.done) { job.done = true; job.result = r.value; }
  },

  /** Prefetch: build the chunks the streamer will ask for next, a slice per frame. */
  update(dt, app) {
    const W = app.world;
    if (!W || !W.wanted || app.cameraS == null) return;
    const t0 = performance.now(), until = t0 + this.prefetchMs;
    const cands = [];
    for (const w of W.wanted(app.cameraS + 50)) {
      const c = W.chunks.get(w.idx);
      let need = false;
      if (!c) need = true;
      else if (!c.ready && c.lod === w.lod) need = c.pending.includes('facades');
      else if (c.ready && w.lod < c.lod) need = !c.next || c.next.pending.includes('facades');
      else if (c.next && c.next.lod === w.lod) need = c.next.pending.includes('facades');
      if (need) cands.push({ key: `${w.idx}:${w.lod}`, idx: w.idx, lod: w.lod, dist: w.dist });
    }
    cands.sort((a, b) => a.dist - b.dist);
    const keep = new Set(cands.map((c) => c.key));
    // drop prefetched results that are no longer wanted
    for (const [k, j] of this.jobs) {
      if (keep.has(k)) continue;
      if (j.result) j.result.traverse((o) => o.geometry && o.geometry.dispose());
      this.jobs.delete(k);
    }
    for (const c of cands.slice(0, 4)) {
      if (performance.now() >= until) break;
      let job = this.jobs.get(c.key);
      if (!job) {
        const L = app.route.length;
        const s0 = c.idx * CHUNK_LEN;
        job = { it: this.buildGen({ index: c.idx, lod: c.lod, s0, s1: Math.min(L, s0 + CHUNK_LEN) }, app) };
        this.jobs.set(c.key, job);
      }
      if (!job.done) this._pump(job, until);
    }
  },
};

export default facades;
