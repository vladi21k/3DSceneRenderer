import * as THREE from 'three';
import { CHUNK_LEN, LOD0_DIST, VIEW_AHEAD, VIEW_BEHIND } from '../core/config.js';
import { facadePlan } from './facadePlan.js';
import { Kit } from './facades/kit.js';
import { createInteriorGlass, GLASS_ATTRS } from './facades/interior.js';
import { createSignMaterials } from './facades/signs.js';
import { createAwningMaterial } from './facades/awnings.js';
import { lanternTpls, signLampTpls, intercomTpl, createLampGlass, createBulbMaterial } from './facades/extras.js';
import { buildFront } from './facades/place.js';
import { createSpillMaterial } from './facades/spill.js';

// Facade infill: windows, shopfronts, doors, shutters, signage, awnings and small wall
// fittings for every opening of facadePlan(lot): main-street lots, side-street lots and
// corner returns alike. Openings are holes with reveals cut by `buildings`; the infill sits
// at w = −opening.recess in the lot frame and follows the hole outline exactly
// (facades/outline.js mirrors facadePlan.archPoint).
//
// Geometry is assembled per chunk into one buffer per material (facades/geo.js) from
// per-opening templates cached by size and style (shopfronts and doors share one or two
// designs per building), so a chunk costs ~14 draw calls. Far chunks (lod 1) use flat
// glass 2.5–3 cm proud of the infill plane with a depth-offset material, procedural
// casings, and no small fittings. At dusk lit rooms also light their stone reveals
// (facades/spill.js). Chunk builds are generators: prefetched a slice per frame ahead
// of the streamer (update), or finished synchronously in build() when the prefetch missed.

const facades = {
  name: 'facades',

  async init(app) {
    const M = app.materials;
    const white = new THREE.Color(1, 1, 1);
    const vc = (name) => M.get(name, { vertexColors: true, color: white });
    const glass = M.register('facades.glassInterior', createInteriorGlass());
    // far range: the same glass pulled towards the camera in depth, so it never loses
    // the depth test against the buildings' back plate at 200–680 m
    const glassFar = M.register('facades.glassInteriorFar', createInteriorGlass({ far: true }));
    const sign = createSignMaterials(M);
    M.register('facades.signBoard', sign.board);
    M.register('facades.signText', sign.text);
    const awning = M.register('facades.awning', createAwningMaterial(M));
    const lamp = M.register('facades.lampGlass', createLampGlass(M));
    const bulb = M.register('facades.bulb', createBulbMaterial());
    const spill = M.register('facades.spill', createSpillMaterial());
    this.mats = {
      // joinery sits inside the reveals, which already shade it: no shadow casting
      frame: { material: vc('paint.frame'), castShadow: false },
      shutter: { material: vc('wood.shutter') },
      door: { material: vc('wood.door'), castShadow: false },
      glass: { material: glass, color: false, extra: GLASS_ATTRS, castShadow: false },
      glassFar: { material: glassFar, color: false, extra: GLASS_ATTRS, castShadow: false },
      metal: { material: vc('metal.iron') },
      hardware: { material: vc('metal.steel'), castShadow: false },
      stone: { material: M.get('stone.smooth', { vertexColors: true }), castShadow: false },
      awning: { material: awning, extra: { aStripe: 4, aFlex: 1 } },
      signBoard: { material: sign.board, extra: { aGlow: 1 } },
      signText: { material: sign.text, extra: { aGlow: 1 }, castShadow: false, renderOrder: 2 },
      lamp: { material: lamp, color: false, castShadow: false, receiveShadow: false, renderOrder: 3 },
      bulb: { material: bulb, color: false, castShadow: false },
      spill: { material: spill, color: false, extra: { aSpill: 3 }, castShadow: false, receiveShadow: false, renderOrder: 1 },
    };
    // development aids: fshop=<type> puts one shop interior everywhere, flod=0|1 forces a
    // detail level, debugStats = {} collects the open-shutter fits (see place.js)
    this.forceShop = app.params.str('fshop') || null;
    this.debugStats = null;
    const fl = app.params.str('flod');
    this.forceLod = fl === '0' || fl === '1' ? +fl : null;
    this.jobs = new Map();          // prefetched chunk builds, key "index:lod"
    this.stats = { sync: 0, syncMs: 0, lastSync: null, prefetched: 0, prefetchMaxMs: 0 };
    this.prefetchMs = 1.2;          // per-frame budget for prefetching
    this.assets = [1, 0.4].map((q) => ({ lantern: lanternTpls(q), signLamp: signLampTpls(q), intercom: intercomTpl(q) }));
    if (app.params.str('fwall')) {
      const { DevWall } = await import('./facades/devwall.js');
      this.devWall = new DevWall(app);
    }
    await this.warmStart(app);
  },

  /**
   * Build the chunks the streamer will ask for first while the loading screen is up:
   * around the start position and, for inspection views, around the view position.
   */
  async warmStart(app) {
    const n = app.layout.nChunks, L = app.route.length;
    const around = [app.startS];
    if (app.params.view) around.push(app.params.view[0]);
    for (const s0 of around) {
      for (let i = Math.floor((s0 - VIEW_BEHIND) / CHUNK_LEN); i <= Math.floor((s0 + VIEW_AHEAD) / CHUNK_LEN); i++) {
        const idx = ((i % n) + n) % n;
        const dist = Math.max(0, Math.abs(i * CHUNK_LEN + CHUNK_LEN / 2 - s0) - CHUNK_LEN / 2);
        const lod = dist < LOD0_DIST ? 0 : 1;
        const key = `${idx}:${lod}`;
        if (this.jobs.has(key)) continue;
        const job = { it: this.buildGen({ index: idx, lod, s0: idx * CHUNK_LEN, s1: Math.min(L, idx * CHUNK_LEN + CHUNK_LEN) }, app) };
        try { this._pump(job, Infinity); } catch (e) { console.warn('[facades] warm start failed for chunk', idx, e); continue; }
        this.jobs.set(key, job);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  },

  /**
   * Chunk build as a generator that yields after every opening, so the same work can run
   * either synchronously (build) or time-sliced ahead of need (update → prefetch).
   */
  *buildGen(chunk, app) {
    const { layout } = app;
    if (this.forceLod !== null) chunk = { ...chunk, lod: this.forceLod };
    // main and side-street lots, plus the buildings' side-street backdrops unless they
    // carry their own (simpler, far-range) infill
    const extra = (app.systems.buildings?.extraLots?.(chunk.index) ?? []).filter((l) => !l.selfDressed);
    const lots = [...layout.inChunk('lots', chunk.index), ...layout.inChunk('sideLots', chunk.index), ...extra];
    if (!lots.length) return null;
    const kit = new Kit(this.mats, chunk.lod);
    const q = chunk.lod === 0 ? 1 : 0.4;
    const assets = this.assets[chunk.lod === 0 ? 0 : 1];
    for (const lot of lots) {
      const plan = facadePlan(lot);
      const streetW = lot.sideStreet ? lot.cross.width : 2 * Math.abs(lot.d);
      const fronts = [{ plan, frame: lot.frame, streetW }];
      // corner returns face the side street
      for (const r of plan.returns || []) fronts.push({ plan: r, frame: r.frame, streetW: 10 });
      for (const fr of fronts) {
        const ctx = {
          plan: fr.plan, frame: fr.frame, lot, q, lod: chunk.lod, assets,
          streetW: fr.streetW,
          angle: Math.atan2(fr.frame.uDir.z, fr.frame.uDir.x),
          forceShop: this.forceShop,
          stats: this.debugStats || null,
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
    const t0 = performance.now(), ready = job.done;
    if (!job.done) this._pump(job, Infinity);
    // misses of the prefetch (built here, synchronously) for the perf overlay / tests
    if (!ready) { const st = this.stats; st.sync++; st.syncMs = Math.max(st.syncMs, performance.now() - t0); st.lastSync = key; }
    else this.stats.prefetched++;
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
    if (app.cameraS == null || !W) return;
    if (!W.wanted || !W.chunks) {
      // the streamer no longer exposes what it will build next: builds run synchronously
      if (!this._warnedPrefetch) { this._warnedPrefetch = true; console.warn('[facades] streamer API changed, prefetch disabled'); }
      return;
    }
    const t0 = performance.now(), until = t0 + this.prefetchMs;
    const cands = [], seen = new Set();
    // what the streamer wants now, and what it will want ~50 m further on
    for (const w of [...W.wanted(app.cameraS), ...W.wanted(app.cameraS + 50)]) {
      const key = `${w.idx}:${w.lod}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = W.chunks.get(w.idx);
      let need = false;
      if (!c) need = true;
      else if (!c.ready && c.lod === w.lod) need = c.pending.includes('facades');
      else if (c.ready && w.lod < c.lod) need = !c.next || c.next.pending.includes('facades');
      else if (c.next && c.next.lod === w.lod) need = c.next.pending.includes('facades');
      if (need) cands.push({ key, idx: w.idx, lod: w.lod, dist: w.dist });
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
      if (!job.done) {
        try { this._pump(job, until); } catch (e) {
          // a failed prefetch is dropped; build() will retry and report through the streamer
          console.warn('[facades] prefetch failed for chunk', c.key, e);
          this.jobs.delete(c.key);
        }
      }
    }
    this.stats.prefetchMaxMs = Math.max(this.stats.prefetchMaxMs * 0.995, performance.now() - t0);
  },
};

export default facades;
