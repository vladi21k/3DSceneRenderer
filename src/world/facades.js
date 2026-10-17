import * as THREE from 'three';
import { CHUNK_LEN, LOD0_DIST, VIEW_AHEAD, VIEW_BEHIND } from '../core/config.js';
import { U } from '../core/uniforms.js';
import { facadePlan } from './facadePlan.js';
import { Kit } from './facades/kit.js';
import { createInteriorGlass, GLASS_ATTRS } from './facades/interior.js';
import { createSignMaterials } from './facades/signs.js';
import { createAwningMaterial } from './facades/awnings.js';
import { lanternTpls, signLampTpls, intercomTpl, createLampGlass, createBulbMaterial } from './facades/extras.js';
import { buildFront } from './facades/place.js';
import { createSpillMaterial } from './facades/spill.js';

// Facade infill: windows, shopfronts, doors, shutters, signage, awnings and small wall
// fittings for every opening of facadePlan(lot): main-street lots, side-street lots, the
// side-street backdrops and corner returns alike. Openings are holes with reveals cut by
// `buildings`; the infill sits at w = −opening.recess in the lot frame and follows the hole
// outline exactly (facades/outline.js mirrors facadePlan.archPoint).
//
// Geometry is assembled per chunk into one buffer per material (facades/geo.js) from
// per-opening templates cached by size and style (shopfronts and doors share one or two
// designs per building): about 11 draw calls for a near chunk (plain sign boards join the
// painted shutters) and 4–5 for a far one (lod 1), where doors, shutters, ironwork and
// stone fold into the frame batch too. Far chunks use flat glass 2.5–3 cm proud of the
// infill plane with a depth-offset material, procedural casings, and no small fittings;
// so do the backdrops and deep side-street lots. Café terraces of the 'awning' style get
// one continuous retractable awning along the shop front. At dusk lit rooms also light
// their stone reveals (facades/spill.js; near chunks only, not drawn by day). Chunk
// builds are generators: prefetched a slice per frame ahead of the streamer (update,
// world.upcoming()), or finished synchronously in build() when the prefetch missed.

// side-street lots starting this far from the main street get the far-range infill
const SIDE_FAR = 40;

// albedo of the library bakes relative to the paint of the frame batch (fold-in colours)
const PAINT_ALB = 0.95;
const FOLD = {
  wood: [0.4 / PAINT_ALB, 0.26 / PAINT_ALB, 0.15 / PAINT_ALB],      // wood.door (tint over the wood bake)
  paintwood: [0.88 / PAINT_ALB, 0.88 / PAINT_ALB, 0.88 / PAINT_ALB], // wood.shutter
  stone: [0.61 / PAINT_ALB, 0.555 / PAINT_ALB, 0.44 / PAINT_ALB],   // stone.smooth (tint)
  board: [PAINT_ALB / 0.88, PAINT_ALB / 0.88, PAINT_ALB / 0.88],    // sign.panel paint → painted timber
};

const facades = {
  name: 'facades',

  async init(app) {
    const t0 = performance.now();
    const M = app.materials;
    const white = new THREE.Color(1, 1, 1);
    const vc = (name) => M.get(name, { vertexColors: true, color: white });
    const glass = M.register('facades.glassInterior', createInteriorGlass(M));
    // far range: the same glass (and program) pulled towards the camera in depth, so it
    // never loses the depth test against the buildings' back plate at 200–680 m
    const glassFar = M.register('facades.glassInteriorFar', createInteriorGlass(M, { far: true }));
    const sign = createSignMaterials(M);
    M.register('facades.signBoard', sign.board);
    M.register('facades.signText', sign.text);
    const awning = M.register('facades.awning', createAwningMaterial(M));
    const lamp = M.register('facades.lampGlass', createLampGlass(M));
    const bulb = M.register('facades.bulb', createBulbMaterial(M));
    const spill = M.register('facades.spill', createSpillMaterial(M));
    this.mats = {
      // joinery sits inside the reveals, which already shade it: no shadow casting
      frame: { material: vc('paint.frame'), castShadow: false },
      shutter: { material: vc('wood.shutter'), thin: true, far: { key: 'frame', k: FOLD.paintwood } },
      door: { material: vc('wood.door'), castShadow: false, far: { key: 'frame', k: FOLD.wood } },
      glass: { material: glass, color: false, extra: GLASS_ATTRS, castShadow: false, far: { key: 'glassFar' } },
      glassFar: { material: glassFar, color: false, extra: GLASS_ATTRS, castShadow: false },
      // grilles, brackets and arms: thin casters (fine shadow cascades only)
      metal: { material: vc('metal.iron'), thin: true, far: { key: 'frame' } },
      hardware: { material: vc('metal.steel'), castShadow: false },
      stone: { material: M.get('stone.smooth', { vertexColors: true }), castShadow: false, far: { key: 'frame', k: FOLD.stone } },
      awning: { material: awning, extra: { aStripe: 4, aFlex: 1 } },
      // sign boards that glow (light boxes); plain painted boards join the shutters' timber
      signBoard: { material: sign.board, extra: { aGlow: 1 }, thin: true },
      board: { near: { key: 'shutter', k: FOLD.board }, far: { key: 'frame' } },
      signText: { material: sign.text, extra: { aGlow: 1 }, castShadow: false, renderOrder: 2 },
      lamp: { material: lamp, color: false, castShadow: false, receiveShadow: false, renderOrder: 3 },
      bulb: { material: bulb, color: false, castShadow: false },
      spill: { material: spill, color: false, extra: { aSpill: 3 }, castShadow: false, receiveShadow: false, renderOrder: 1 },
    };
    this.jobs = new Map();          // prefetched chunk builds, key "index:lod"
    this.handed = new Set();        // builds handed to the streamer, until it stops listing them
    this.stats = { sync: 0, syncMs: 0, lastSync: null, prefetched: 0, prefetchMaxMs: 0, warmBuildMs: 0 };
    this.prefetchMs = 0.8;          // per-frame budget for prefetching
    this.idle = 0;                  // frames to wait before looking for work again
    this.assets = [1, 0.4].map((q) => ({ lantern: lanternTpls(q), signLamp: signLampTpls(q), intercom: intercomTpl(q) }));
    const t1 = performance.now();
    await this.warmStart(app);
    // (warm includes the other start-up tasks that run while it yields)
    this.stats.initMs = { setup: Math.round(t1 - t0), warm: Math.round(performance.now() - t1) };
  },

  /**
   * Build the chunks the streamer will ask for first while the loading screen is up:
   * around the start position and, for inspection views, around the view position.
   */
  async warmStart(app) {
    const n = app.layout.nChunks, L = app.route.length;
    let yielded = performance.now();
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
        const tb = performance.now();
        try { this._pump(job, Infinity); } catch (e) { console.warn('[facades] warm start failed for chunk', idx, e); continue; }
        this.stats.warmBuildMs += performance.now() - tb;
        this.jobs.set(key, job);
        // let the loading screen breathe now and then
        if (performance.now() - yielded > 40) { await new Promise((r) => setTimeout(r, 0)); yielded = performance.now(); }
      }
    }
  },

  /**
   * Chunk build as a generator that yields after every opening, so the same work can run
   * either synchronously (build) or time-sliced ahead of need (update → prefetch).
   */
  *buildGen(chunk, app) {
    const { layout } = app;
    // main and side-street lots, plus the buildings' side-street backdrops unless they
    // carry their own infill
    const extra = (app.systems.buildings?.extraLots?.(chunk.index) ?? []).filter((l) => !l.selfDressed);
    const lots = [...layout.inChunk('lots', chunk.index), ...layout.inChunk('sideLots', chunk.index), ...extra];
    if (!lots.length) return null;
    const kit = new Kit(this.mats, chunk.lod);
    for (const lot of lots) {
      const plan = facadePlan(lot);
      // backdrops close the far end of a side street and the deeper side-street lots are
      // only ever seen at grazing angles, 40 m and more from the tram: they take the
      // far-range infill whatever the chunk
      const q = chunk.lod === 0 && !lot.backdrop && !(lot.sideStreet && lot.x0 >= SIDE_FAR) ? 1 : 0.4;
      const assets = this.assets[q === 1 ? 0 : 1];
      const streetW = lot.sideStreet ? lot.cross.width : 2 * Math.abs(lot.d);
      const cafe = !lot.sideStreet && lot.cafe != null ? layout.cafes[lot.cafe] : null;
      const fronts = [{ plan, frame: lot.frame, streetW, cafe: cafe && cafe.style === 'awning' ? cafe : null }];
      // corner returns face the side street
      for (const r of plan.returns || []) fronts.push({ plan: r, frame: r.frame, streetW: 10, cafe: null });
      for (const fr of fronts) {
        const ctx = {
          plan: fr.plan, frame: fr.frame, lot, q, lod: chunk.lod, assets, app,
          streetW: fr.streetW, cafe: fr.cafe,
          angle: Math.atan2(fr.frame.uDir.z, fr.frame.uDir.x),
        };
        yield* buildFront(kit, ctx);
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
    this.handed.add(key);
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

  update(dt, app) {
    // the reveal film is black by day (see spill.js): skip its draws altogether
    const spill = this.mats.spill.material, night = U.uNight.value > 0.18;
    if (spill.visible !== night) spill.visible = night;
    this.prefetch(app);
  },

  /** Prefetch: build the chunks the streamer will ask for next, a slice per frame. */
  prefetch(app) {
    const W = app.world;
    if (app.cameraS == null || !W || !W.upcoming) return;
    // nothing was due last time: look again a few frames later
    if (this.idle > 0) { this.idle--; return; }
    const t0 = performance.now(), until = t0 + this.prefetchMs;
    const cands = [], seen = new Set();
    // what the streamer will build now, and what it will want ~50 m further on
    for (const w of [...W.upcoming(app.cameraS), ...W.upcoming(app.cameraS + 50)]) {
      const key = `${w.index}:${w.lod}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // already handed over (the chunk is listed until every module has built it)
      if (!this.handed.has(key)) cands.push({ key, idx: w.index, lod: w.lod, dist: w.dist });
    }
    for (const k of this.handed) if (!seen.has(k)) this.handed.delete(k);
    cands.sort((a, b) => a.dist - b.dist);
    this.idle = cands.length ? 0 : 5;
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
