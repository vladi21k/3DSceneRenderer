import * as THREE from 'three';
import { CHUNK_LEN, LOD0_DIST, VIEW_AHEAD, VIEW_BEHIND } from '../core/config.js';
import { U } from '../core/uniforms.js';
import { facadePlan } from './facadePlan.js';
import { Kit } from './facades/kit.js';
import { createInteriorGlass, GLASS_ATTRS, shopLevels } from './facades/interior.js';
import { createSignMaterials } from './facades/signs.js';
import { createAwningMaterial } from './facades/awnings.js';
import { lanternTpls, signLampTpls, intercomTpl, createLampGlass, createBulbMaterial } from './facades/extras.js';
import { buildFront, frontsOf, frontInfo } from './facades/place.js';
import { planStands, buildStand } from './facades/stands.js';
import { createSpillMaterial } from './facades/spill.js';
import { BAD_NORMALS, withFiniteOutput } from './facades/geo.js';

// Facade infill: windows, shopfronts, doors, shutters, signage, awnings and small wall
// fittings for every opening of facadePlan(lot): main-street lots, side-street lots, the
// side-street backdrops and corner returns alike. Openings are holes with reveals cut by
// `buildings`; the infill sits at w = −opening.recess in the lot frame and follows the hole
// outline exactly (facades/outline.js mirrors facadePlan.archPoint).
//
// Geometry is assembled per chunk into one buffer per material (facades/geo.js) from
// per-opening templates cached by size and style (shopfronts and doors share one or two
// designs per building): about 12 draw calls for a near chunk (historic timber windows on
// the chipped-paint bakes; shopfronts, roller shutters and plain sign boards in one
// powder-coat / enamel batch) and 4–5 for a far one (lod 1), where doors, shutters,
// ironwork and stone fold into that batch too. Far chunks use flat glass 2.5–3 cm proud of the
// infill plane with a depth-offset material, procedural casings, and no small fittings;
// so do the backdrops and deep side-street lots. Café terraces of the 'awning' style get
// one continuous retractable awning along the shop front. At dusk lit rooms also light
// their stone reveals and shops the pavement in front (facades/spill.js; not drawn by
// day), in the colour of each shop's own lamps. Shops are dressed (facades/dressing.js):
// posters, price cards and stickers on the glass, goods hung on the piers; most put up a
// sign of their own where the plan gives them none (fascia, head panel or valance), half
// hang a projecting sign on a pier (a light box with their word, a disc or a blade), and
// the trades that do put their goods out on the pavement (facades/stands.js: crates of
// produce, buckets of flowers, rails of clothes, racks of papers, bakery trays, sacks of
// nuts and spices, sale bins, shoe racks, book carts), planned at init and registered as
// crowd obstacles. A trade other than fashion or food does not repeat within two shops of
// a front, and the rarer ones (pharmacies, jewellers...) keep to one slot per block of a
// street side. Joinery takes a colour per building from a weighted
// palette (facades/kit.js), weathered per opening, on the close-range paint bakes offset
// per opening. The shop a café terrace (any style) is centred on is that café, sign and
// fit-out. Fittings on a rusticated ground floor stand on the bosses' faces (outline.js
// rusticOff), signs ~0.1 m off the wall plane. Chunk
// builds are generators: prefetched a slice per frame ahead of the streamer (update,
// world.upcoming()), or finished synchronously in build() when the prefetch missed.
//
// Debug (URL): facglass=r | t | m | e shows only the glass's reflection, only the room
// behind it, the glass as a perfect mirror of the street stand-in, or a grey card lit by
// the glass's ambient light (facades/interior.js). facclose=0 reads the sign atlas through
// the hardware filter alone, without the close-up (Catmull-Rom) filter (facades/signs.js).

// side-street lots starting this far from the main street get the far-range infill
const SIDE_FAR = 40;

// albedo of the library bakes relative to the paint of the joinery batch (fold-in
// colours): historic frames paint.frameDetail, shutters wood.shutterDetail, sign boards
// sign.panel, shopfronts / shutters / boards paint.frame (the far range folds into it)
const FRAME_ALB = 0.88, SHUTTER_ALB = 0.87, SIGN_ALB = 0.95, PAINT_ALB = 0.95;
const k3 = (x) => [x, x, x];
const FOLD = {
  wood: [0.4 / PAINT_ALB, 0.26 / PAINT_ALB, 0.15 / PAINT_ALB],      // wood.door (tint over the wood bake)
  paintwood: k3(SHUTTER_ALB / PAINT_ALB),                          // shutters
  frame: k3(FRAME_ALB / PAINT_ALB),                                // historic joinery
  stone: [0.61 / PAINT_ALB, 0.555 / PAINT_ALB, 0.44 / PAINT_ALB],   // stone.smooth (tint)
  board: k3(SIGN_ALB / PAINT_ALB),                                 // sign.panel paint → enamelled board
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
      // historic timber windows: close-range painted joinery bakes (brush marks, chips),
      // offset per opening
      frame: { material: vc('paint.frameDetail'), castShadow: false, far: { key: 'joinery', k: FOLD.frame } },
      // shopfronts, roller shutters with their boxes, window rollers and sign boards:
      // powder-coated / anodised metal and enamelled boards, which do not flake (plain
      // paint bake: orange peel, a satin sheen); the far range folds everything into it
      joinery: { material: M.get('paint.frame', { vertexColors: true, color: white, roughness: 1.2 }), castShadow: false },
      // goods stands on the pavement (crates, produce, buckets, racks): the same powder-coat
      // finish, but casting shadows onto the paving
      // (a variant of its own, its radiance kept finite: a few grazing pixels of the stands
      // came out non-finite where they meet the sun's shadow proxies)
      standPaint: { material: withFiniteOutput(M.get('paint.frame', { vertexColors: true, color: white, roughness: 1.2, tag: 'facades.stand' }), 'facades.finite') },
      // fruit and vegetables: waxy, glossy skins (the moulded-plastic bake, vertex colour = albedo)
      // (the crates cast the stand's shadow; the pieces' own occlusion is in their shade)
      produce: { material: M.get('plastic.chair', { vertexColors: true, color: white, roughness: 0.42 }), castShadow: false },
      // wooden crates, carts and trestles: weathered timber (vertex colour tints it)
      standWood: { material: M.get('wood.bench', { vertexColors: true }), far: { key: 'standPaint' } },
      shutter: { material: vc('wood.shutterDetail'), thin: true, far: { key: 'joinery', k: FOLD.paintwood } },
      door: { material: vc('wood.door'), castShadow: false, far: { key: 'joinery', k: FOLD.wood } },
      glass: { material: glass, color: false, extra: GLASS_ATTRS, castShadow: false, far: { key: 'glassFar' } },
      glassFar: { material: glassFar, color: false, extra: GLASS_ATTRS, castShadow: false },
      // grilles, brackets and arms: thin casters (fine shadow cascades only)
      metal: { material: vc('metal.iron'), thin: true, far: { key: 'joinery' } },
      hardware: { material: vc('metal.steel'), castShadow: false },
      stone: { material: M.get('stone.smooth', { vertexColors: true }), castShadow: false, far: { key: 'joinery', k: FOLD.stone } },
      awning: { material: awning, extra: { aStripe: 4, aFlex: 1 }, farShadow: true },
      // sign boards that glow (light boxes); plain painted boards join the joinery batch
      signBoard: { material: sign.board, extra: { aGlow: 1 }, thin: true },
      board: { near: { key: 'joinery', k: FOLD.board }, far: { key: 'joinery', k: FOLD.board } },
      signText: { material: sign.text, extra: { aGlow: 1 }, castShadow: false, renderOrder: 2 },
      lamp: { material: lamp, color: false, castShadow: false, receiveShadow: false, renderOrder: 3 },
      bulb: { material: bulb, color: false, castShadow: false },
      spill: { material: spill, color: false, extra: { aSpill: 4 }, castShadow: false, receiveShadow: false, renderOrder: 1 },
    };
    this.jobs = new Map();          // prefetched chunk builds, key index · 4 + lod
    this.handed = new Set();        // builds handed to the streamer, until it stops listing them
    this.signAtlas = sign.atlas;
    this.stats = { sync: 0, syncMs: 0, lastSync: null, prefetched: 0, prefetchMaxMs: 0, warmBuildMs: 0 };
    // sign atlas: layout now, painting in idle slices (done before the first frame)
    Object.defineProperty(this.stats, 'atlasMs', { get: () => ({ layout: Math.round(sign.atlas.layoutMs || 0), paint: Math.round(sign.atlas.ms), done: sign.atlas.done }), enumerable: true });
    // template vertices whose normal had to be rebuilt at bake time (geo.js fixNormals):
    // a generator producing zero normals; must stay 0 (checked with debug=1)
    Object.defineProperty(this.stats, 'badNormals', { get: () => BAD_NORMALS.count, enumerable: true });
    this.prefetchMs = 0.8;          // per-frame budget for prefetching
    this.idle = 0;                  // frames to wait before looking for work again
    this.assets = [1, 0.4].map((q) => ({ lantern: lanternTpls(q), signLamp: signLampTpls(q), intercom: intercomTpl(q) }));
    // goods stands on the pavement: planned for the whole loop now, so the crowd (whose
    // init runs after every world module's) walks round them
    const tS = performance.now();
    try {
      this.stands = planStands(app, (lot) => frontInfo(app, lot)[0], (lot) => facadePlan(lot));
      app.layout.addObstacles(this.stands.obstacles);
    } catch (e) { console.warn('[facades] goods stands not planned', e); this.stands = null; }
    this.stats.stands = { n: this.stands ? this.stands.obstacles.length : 0, planMs: Math.round(performance.now() - tS) };
    const t1 = performance.now();
    await this.warmStart(app);
    // (warm includes the other start-up tasks that run while it yields)
    this.stats.initMs = { setup: Math.round(t1 - t0), warm: Math.round(performance.now() - t1) };
    if (app.params.debug && BAD_NORMALS.count) console.warn(`[facades] ${BAD_NORMALS.count} template vertices had zero normals (repaired)`);
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
    // the chunks the start-up prime builds (within 240 m) now; the rest of the view range
    // in the background, in the main thread's idle time while the shaders compile
    const later = [];
    const warm = (idx, lod, key) => {
      const job = { it: this.buildGen({ index: idx, lod, s0: idx * CHUNK_LEN, s1: Math.min(L, idx * CHUNK_LEN + CHUNK_LEN) }, app) };
      const tb = performance.now();
      try { this._pump(job, Infinity); } catch (e) { console.warn('[facades] warm start failed for chunk', idx, e); return; }
      this.stats.warmBuildMs += performance.now() - tb;
      this.jobs.set(key, job);
    };
    for (const s0 of around) {
      for (let i = Math.floor((s0 - VIEW_BEHIND) / CHUNK_LEN); i <= Math.floor((s0 + VIEW_AHEAD) / CHUNK_LEN); i++) {
        const idx = ((i % n) + n) % n;
        const dist = Math.max(0, Math.abs(i * CHUNK_LEN + CHUNK_LEN / 2 - s0) - CHUNK_LEN / 2);
        const lod = dist < LOD0_DIST ? 0 : 1;
        const key = idx * 4 + lod;
        if (this.jobs.has(key)) continue;
        if (dist > 250) { later.push([idx, lod, key]); continue; }
        warm(idx, lod, key);
        // let the loading screen breathe now and then
        if (performance.now() - yielded > 40) { await new Promise((r) => setTimeout(r, 0)); yielded = performance.now(); }
      }
    }
    const next = () => {
      // (skipped once the streamer has asked for the chunk or a prefetch has it)
      while (later.length) {
        const [idx, lod, key] = later.shift();
        if (this.jobs.has(key) || this.handed.has(key)) continue;
        warm(idx, lod, key);
        break;
      }
      if (later.length) setTimeout(next, 0);
    };
    setTimeout(next, 0);
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
      // its street face and the corner returns facing the side street
      for (const fr of frontsOf(app, lot, plan)) {
        const ctx = {
          plan: fr.plan, frame: fr.frame, lot, q, lod: chunk.lod, assets, app,
          streetW: fr.streetW, cafe: fr.cafe,
          angle: Math.atan2(fr.frame.uDir.z, fr.frame.uDir.x),
        };
        yield* buildFront(kit, ctx);
      }
      const stands = this.stands && !lot.sideStreet && this.stands.byLot.get(lot.id);
      if (stands) for (const st of stands) buildStand(kit, st, lot.frame, q);
    }
    const group = new THREE.Group();
    group.name = 'facades';
    kit.meshes(group, 'facades');
    return group;
  },

  build(chunk, app) {
    const key = chunk.index * 4 + chunk.lod;
    let job = this.jobs.get(key);
    if (job) this.jobs.delete(key);
    else job = { it: this.buildGen(chunk, app) };
    this.handed.add(key);
    const t0 = performance.now(), ready = job.done;
    if (!job.done) this._pump(job, Infinity);
    // misses of the prefetch (built here, synchronously) for the perf overlay / tests
    if (!ready) { const st = this.stats; st.sync++; st.syncMs = Math.max(st.syncMs, performance.now() - t0); st.lastSync = `${chunk.index}:${chunk.lod}`; }
    else this.stats.prefetched++;
    return job.result;
  },

  _pump(job, until) {
    let r;
    do { r = job.it.next(); } while (!r.done && performance.now() < until);
    if (r.done) { job.done = true; job.result = r.value; }
  },

  update(dt, app) {
    // the sign atlas is painted in the start-up's idle time; finish it should a frame come first
    if (!this.signAtlas.done) this.signAtlas.draw(Infinity);
    // the reveal film is black by day (see spill.js): skip its draws altogether, except
    // while loading, so its program is compiled before the ride starts (not at dusk)
    const spill = this.mats.spill.material, night = U.uNight.value > 0.18 || !app.ready;
    if (spill.visible !== night) spill.visible = night;
    // shop lamps, their spill and the light boxes follow the exposure at dusk
    shopLevels(app.env ? app.env.exposure : 1);
    this.prefetch(app);
  },

  /**
   * Prefetch: build the chunks the streamer will ask for next, a slice per frame. Chunks
   * are keyed index · 4 + lod; the lists are reused, so a frame with nothing to build
   * allocates nothing.
   */
  prefetch(app) {
    const W = app.world;
    if (app.cameraS == null || !W || !W.upcoming) return;
    if (this.idle > 0) { this.idle--; return; }
    const t0 = performance.now(), until = t0 + this.prefetchMs;
    // what the streamer will build now, and what it will want within ~50 m of travel
    const ups = W.upcoming(app.cameraS, 50, this._ups || (this._ups = []));
    const seen = this._seen || (this._seen = new Set());
    const cands = this._cands || (this._cands = []);
    seen.clear(); cands.length = 0;
    for (let i = 0; i < ups.length; i++) {
      const w = ups[i], key = w.index * 4 + w.lod;
      if (seen.has(key)) continue;
      seen.add(key);
      // already handed over (the chunk is listed until every module has built it)
      if (!this.handed.has(key)) cands.push(w);
    }
    if (this.handed.size) this.handed.forEach(this._prune || (this._prune = (k) => { if (!this._seen.has(k)) this.handed.delete(k); }));
    // drop prefetched results that are no longer wanted (the streamer lists them nearest first)
    if (this.jobs.size > cands.length || this.jobs.size > 8) {
      for (const [k, j] of this.jobs) {
        if (seen.has(k) && !this.handed.has(k)) continue;
        if (j.result) j.result.traverse((o) => o.geometry && o.geometry.dispose());
        this.jobs.delete(k);
      }
    }
    let pending = false;
    for (let i = 0; i < cands.length && i < 4; i++) {
      const c = cands[i], key = c.index * 4 + c.lod;
      let job = this.jobs.get(key);
      if (job && job.done) continue;
      pending = true;
      if (performance.now() >= until) break;
      if (!job) {
        const L = app.route.length;
        const s0 = c.index * CHUNK_LEN;
        job = { it: this.buildGen({ index: c.index, lod: c.lod, s0, s1: Math.min(L, s0 + CHUNK_LEN) }, app) };
        this.jobs.set(key, job);
      }
      try { this._pump(job, until); } catch (e) {
        // a failed prefetch is dropped; build() will retry and report through the streamer
        console.warn('[facades] prefetch failed for chunk', `${c.index}:${c.lod}`, e);
        this.jobs.delete(key);
      }
    }
    // nothing left to build ahead: look again a few frames later
    this.idle = pending ? 0 : 5;
    this.stats.prefetchMaxMs = Math.max(this.stats.prefetchMaxMs * 0.995, performance.now() - t0);
  },
};

export default facades;
