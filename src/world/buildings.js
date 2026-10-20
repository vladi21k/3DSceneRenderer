import * as THREE from 'three';
import { facadePlan, bindLayout } from './facadePlan.js';
import { CHUNK_LEN, LOD0_DIST, VIEW_AHEAD, VIEW_BEHIND } from '../core/config.js';
import { hashStr, RNG } from '../core/rng.js';
import { SIDE_LOT_START } from './layout.js';
import { Builder } from './buildings/mesh.js';
import { lotSteps, coarseLot, DETAIL } from './buildings/shell.js';
import { grimeStone, litGlass, nightLevels, GRIME_DEBUG } from './buildings/grime.js';
import { rowLayout } from './buildings/coursing.js';
import { makeSlab, slabSteps } from './buildings/skyline.js';
import { laneSteps } from './buildings/lane.js';
import { muralMaterials, advertMaterials } from './buildings/mural.js';
import { U } from '../core/uniforms.js';

// Building shells (masonry) for every lot, generated from facadePlan(lot): see
// src/world/buildings/shell.js for what is built. Facade infill (glass, frames,
// shopfronts, doors, signs) and ironwork are other modules.
//
// Performance: a chunk's buildings are generated as a "job" (one Builder each, so jobs
// interleave freely) in small steps straight into per-material buffers in world space,
// which become the geometry's arrays as they are (no merging, no copies). update()
// advances the jobs the streamer will need next, ordered by how soon each is needed,
// within a per-frame budget in absolute milliseconds that grows with speed (per nominal
// 60 Hz frame, so slow frames are not made slower) and urgency (init prepares the start
// position: the full-detail range up front, the rest of the view in background slices
// while the other modules start and the shaders compile), so build() normally only
// wraps finished geometry. The per-frame
// path (update, prefetch, preUpload) allocates nothing. A far chunk whose
// job is still running gets a coarse stand-in that is swapped for the real shell when
// the job ends, instead of a long synchronous build.
//
// GPU upload: a full-detail chunk is several megabytes of vertex data even in the compact
// format (buildings/mesh.js), and the renderer uploads a geometry the first time it draws
// it, all in one frame. So a finished job's vertex buffers are uploaded ahead, a few
// hundred kilobytes per frame, through never-drawn meshes (see preUpload); when the
// chunk is revealed only its index buffers are left to send.

// sink key -> library material (smoothD: the dressing, the same stone as smooth; dark:
// plaster that casts no shadow)
const MATERIAL = {
  ashlar: 'stone.ashlar', smooth: 'stone.smooth', smoothD: 'stone.smooth', rough: 'stone.rough', plaster: 'plaster',
  dark: 'plaster', tile: 'roof.tile', glass: 'glass.window',
};
// glazing inside the reveals; rooftop equipment (its shadows only fall on the roofs)
const NO_SHADOW = new Set(['glass', 'dark']);
const THIN = new Set(['smoothD']);                 // centimetre relief: near shadow cascades only
// the plaster batch holds the dark boxes behind the openings and the backstops behind the
// walls: drawn after the other opaque work, they are mostly rejected by the depth test
const LATE = new Set(['plaster']);
// weathered materials (aRun: per-pixel run-off; also the murals, painted on the wall);
// plaster and tiles share their program
const RUNOFF = new Set(['ashlar', 'smooth', 'smoothD', 'rough', 'plaster', 'dark', 'tile']);
let MATS = {};                     // buildings-owned material variants by sink key (weathered stone, lit glass)
let ADS = [];                      // advert materials (floodlit at night)
const BASE_MS = 0.8;               // per-frame generation budget when nothing is urgent
const MAX_MS = 4;                  // ... when a chunk is about to be (or already is) requested
const NOMINAL_DT = 1 / 60;         // the speed-driven budget is per nominal frame, not per realDt
const LOOK_LOD0 = 110;             // full detail is prepared up to this far before the switch
const LOOK_FAR = 110;              // far detail is prepared up to this far beyond the view
const UPLOAD_BYTES = 640 << 10;    // vertex data uploaded ahead per frame (at least one buffer)
const ADVERT_EXPOSED = 0.32;       // a floodlit poster's white at night (radiance x exposure)

let FORCE_LOD = null;              // debug: ?blod=0|1 forces one detail level everywhere; ?bgdbg=1|2|3 shows the
                                   // weathering's inputs (height above the paving, trails and grime mask, run-off zones)
const jobs = new Map();            // jobKey(chunkIndex, lod) -> job
const swaps = new Map();           // job -> group showing a coarse stand-in until the job ends
const ends = new Map();            // lotId -> [end0, end1] (lazy)
let endIndex = null;               // spatial hash of facade end points
const backdrops = new Map();       // chunk index -> pseudo-lots closing the far end of side streets
const lanes = new Map();           // chunk index -> asphalt aprons of the lanes in front of them
const vistas = [];                 // side-street ends (sites for a taller block behind the backdrop)
const skyline = new Map();         // chunk index -> taller blocks well behind the frontage
const cost = [0.4, 0.15];          // running generation cost by detail level (ms per metre of route)
let stepAvg = 0.25;                // running cost of one generation step (ms)
let finishAvg = 0.3;               // running cost of closing a finished job (bounds, buffers)
let uploaders = null;              // never-drawn meshes that upload vertex buffers ahead (preUpload)
let metas = null, metasAt = -1e9;  // the stone materials' metadata and row layouts (runJob)
const NO_GEOMETRY = new THREE.BufferGeometry();
NO_GEOMETRY.boundingSphere = new THREE.Sphere();

const buildings = {
  name: 'buildings',
  stats: { jobs: 0, inline: 0, coarse: 0, stepAvg: 0, stepMax: 0, buildMs: 0, budgetMs: 0, cost, preBytes: 0, preMB: 0, revealMB: 0 },
  sync: false,                     // true: build() always generates the full shell (tests)

  async init(app) {
    this.app = app;
    const T = (this.stats.init = {}), t0 = performance.now();
    let tl = t0;
    const lap = (k) => { const t = performance.now(); T[k] = Math.round(t - tl); tl = t; };
    const fl = app.params.str ? app.params.str('blod') : null;
    if (fl === '0' || fl === '1') FORCE_LOD = +fl;
    // (bgdbg=1|2|3: the weathering's inputs as colours, see grime.js)
    GRIME_DEBUG.value = app.params.num ? app.params.num('bgdbg', 0) : 0;
    bindLayout(app.layout);   // corner returns follow the real side-street lines
    // weathered stone (drip trails, rain wash, soot crusts where the baked grime mask
    // says so) and the backdrop lots' glass, lit at night
    if (app.materials.register) {
      MATS = {
        // (the ashlar's worn arrises collect dust, see grime.js BG_ARRIS)
        ashlar: grimeStone(app, 'stone.ashlar', undefined, [1.0, 0.8], { streak: 0.45 }),
        rough: grimeStone(app, 'stone.rough', undefined, [0, 0], { streak: 0.45 }),
        smooth: grimeStone(app, 'stone.smooth', [0.45, 0.55, 0.12, 0.35], [0, 0], { streak: 0.45 }),
        glass: litGlass(app, 'glass.window'),
        // the same shader (one program for all of these): renders, rooftop metal and the
        // dark boxes weather too; tiles carry no grime
        plaster: grimeStone(app, 'plaster', undefined, [0, 0], { render: true }),
        tile: grimeStone(app, 'roof.tile', [0.3, 0.4, 0.1, 0.3]),
      };
      MATS.smoothD = MATS.smooth;
      MATS.dark = MATS.plaster;
      lap('materials');
      // painted murals on a few gables, printed adverts on others (buildings/mural.js)
      muralMaterials(app).forEach((m, k) => { MATS[`mural${k}`] = m; });
      ADS = advertMaterials(app);
      ADS.forEach((m, k) => { MATS[`advert${k}`] = m; });
      lap('murals');
    }
    uploaders = new THREE.Group();
    uploaders.name = 'buildings:upload';
    app.scene.add(uploaders);
    planBackdrops(app);
    planSkyline(app);
    this.debug = { skyline, backdrops, vistas };   // (inspection from the console / tests)
    indexEnds(app.layout);
    lap('plans');
    // Everything the first frames need: the view (chunks beyond it are prefetched while
    // riding), and both levels of the chunks near the full-detail switch (the camera
    // starts a few metres from startS), so the streamer's first builds never generate
    // inline. The full-detail range, which the start-up prime builds, is generated here;
    // the far jobs in the background, in slices between the other modules' start-up work
    // and during the shader compile (the main thread mostly waits there), and the first
    // frame completes whatever is left (see finishStartup), so the first frame sees
    // exactly what a synchronous start-up would have built.
    const around = [app.startS, app.startS - CHUNK_LEN / 2];   // the cab may start a little behind startS
    if (app.params.view) around.push(app.params.view[0]);
    const list = [];
    const add = (c) => { const job = jobs.get(jobKey(c.idx, c.lod)) || newJob(app, c.idx, c.lod); if (list.indexOf(job) < 0) list.push(job); };
    for (const s of around) {
      for (const c of candidates(app, s, false, 0)) add(c);
      for (const c of candidates(app, s, true)) add(c);
    }
    // nearest first; what the start-up prime builds (the full-detail range) is generated
    // right here, the rest in the background
    const d = (j) => Math.abs(app.route.delta(app.startS, j.s));
    list.sort((a, b) => d(a) - d(b));
    for (const job of list) if (job.lod === 0 || d(job) < PRIME_DIST) runJob(app, job, Infinity);
    startup = { list, i: 0, timer: 0 };
    pumpStartup(app);
    lap('jobs');
    T.total = Math.round(performance.now() - t0);
  },

  build(chunk, app) {
    const t0 = performance.now();
    const k = jobKey(chunk.index, chunk.lod);
    let job = jobs.get(k);
    if (!job) job = newJob(app, chunk.index, chunk.lod);
    if (!job.lots.length) { jobs.delete(k); return null; }
    let group;
    // (before the first frame: the start-up prime, built inline as a synchronous start-up would)
    if (!job.done && chunk.lod === 1 && !this.sync && !startup) {
      // far edge not ready: a coarse stand-in now, the real shell once the job is done
      group = coarseGroup(app, job);
      swaps.set(job, group);
      this.stats.coarse++;
    } else {
      if (!job.done) { this.stats.inline++; this.stats.lastInline = [chunk.index, chunk.lod, Math.round(app.cameraS ?? -1), app.frame]; runJob(app, job, Infinity); }
      jobs.delete(k);
      group = new THREE.Group();
      fillGroup(app, group, job.result);
      if (job.result) this.stats.revealMB = +(job.result.left / 1048576).toFixed(2);
    }
    group.name = 'buildings';
    group.matrixAutoUpdate = false;
    this.stats.buildMs = Math.max(this.stats.buildMs * 0.98, performance.now() - t0);
    return group;
  },

  dispose(obj) {
    for (const [job, g] of swaps) if (g === obj) swaps.delete(job);
    obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  },

  /**
   * Buildings-only pseudo-lots in chunk i (facades closing the far end of side streets).
   * Same shape as layout lots (frame, seed, depth, sideStreet: true, backdrop: true), so
   * facadePlan(lot) works and the facades module dresses them like any other lot.
   */
  extraLots(i) {
    const n = this.app.layout.nChunks;
    return backdrops.get(((i % n) + n) % n) || [];
  },

  update(dt, app) {
    // night levels that follow the exposure (lit windows, floodlit adverts), so lit glass
    // and posters keep their colour at full night instead of burning out to white
    const expo = app.env && app.env.exposure > 0 ? app.env.exposure : 1;
    nightLevels(expo);
    // the adverts' floodlights come on with the street lamps
    if (ADS.length) {
      const gain = app.materials.uniforms && app.materials.uniforms.emissiveGain ? app.materials.uniforms.emissiveGain.value : 1;
      const e = Math.min(0.0055, ADVERT_EXPOSED / expo) * Math.min(1, Math.max(0, (U.uNight.value - 0.25) / 0.5)) * gain;
      for (let i = 0; i < ADS.length; i++) ADS[i].emissiveIntensity = e;
    }
    if (startup) finishStartup(app);
    const s = app.cameraS;
    if (s == null || !app.world) return;
    releaseUploads();
    if ((app.frame & 31) === 0) evict(app, s);
    this.prefetch(app, s, null);
    preUpload(app, s);
  },

  /**
   * Advance the jobs the streamer will need next, most urgent first: stand-ins on screen,
   * then by metres of travel until the streamer requests each chunk (at the far edge of
   * the view, or at the full-detail switch). budgetMs null: adaptive (speed, urgency);
   * lookFar: how far beyond the view to work ahead (m).
   */
  prefetch(app, sCam, budgetMs, lookFar = LOOK_FAR) {
    const t0 = performance.now();
    const cands = candidates(app, sCam, false, lookFar);
    if (budgetMs == null) {
      const v = Math.abs(app.train?.speed ?? 10);
      // generation needed per second of travel, with headroom, spread over a nominal
      // 60 Hz frame: a slow frame (contention, GPU wait) gets no more work than a fast one
      // unless a chunk is due, so the budget never feeds back into the frame time
      budgetMs = Math.max(BASE_MS, v * (cost[0] + cost[1]) * NOMINAL_DT * 2);
      const soon = swaps.size ? 0 : cands.length ? cands[0].mtn : Infinity;
      if (soon <= 0) budgetMs = MAX_MS;
      else if (soon < CHUNK_LEN) budgetMs = Math.max(budgetMs, MAX_MS * 0.6);
      budgetMs = Math.min(budgetMs, MAX_MS);
      this.stats.budgetMs = budgetMs;
    }
    for (const [job, g] of swaps) {
      runJob(app, job, budgetMs - (performance.now() - t0));
      // swapped in once its vertex buffers are on the GPU (they go first, see preUpload)
      if (job.done && (!job.result || !job.result.pending.length || !uploaders)) {
        swaps.delete(job); jobs.delete(jobKey(job.idx, job.lod)); swapIn(app, g, job.result);
      }
      if (performance.now() - t0 > budgetMs) return;
    }
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (budgetMs - (performance.now() - t0) < stepAvg * 0.5) return;
      const job = jobs.get(jobKey(c.idx, c.lod)) || newJob(app, c.idx, c.lod);
      runJob(app, job, budgetMs - (performance.now() - t0));
    }
  },
};
export default buildings;

// ------------------------------------------------------------------ start-up jobs

let startup = null;            // {list: jobs, i, timer} until the first frame
const PUMP_MS = 6;             // a background slice (the main thread is otherwise waiting)
const PRIME_DIST = LOD0_DIST + CHUNK_LEN;   // (chunk centres) the start-up prime's range, and a chunk to spare

/** Generate the start-up jobs in background slices, nearest first, until the first frame. */
function pumpStartup(app) {
  const st = startup;
  if (!st) return;
  st.timer = 0;
  const t0 = performance.now();
  while (st.i < st.list.length) {
    const left = PUMP_MS - (performance.now() - t0);
    if (left <= 0) break;
    const job = st.list[st.i];
    if (!job.done) runJob(app, job, left);
    if (job.done) st.i++;
  }
  if (st.i < st.list.length) st.timer = setTimeout(() => pumpStartup(app), 0);
}

/** First frame: complete whatever start-up job the background slices have not finished. */
function finishStartup(app) {
  const st = startup;
  startup = null;
  if (st.timer) clearTimeout(st.timer);
  const t0 = performance.now();
  let n = 0;
  for (let i = st.i; i < st.list.length; i++) if (!st.list[i].done) { runJob(app, st.list[i], Infinity); n++; }
  buildings.stats.init.firstFrame = [n, Math.round(performance.now() - t0)];
}

// ------------------------------------------------------------------ chunk jobs

/** Numeric job key (no string per lookup): a far level of 2 or more shares the far job. */
const jobKey = (idx, lod) => idx * 2 + (lod ? 1 : 0);

/** Side-street lots deep inside the side street are only ever seen from far away. */
function lotLod(lot, chunkLod) {
  if (FORCE_LOD !== null) return FORCE_LOD;
  if (chunkLod) return 1;
  if (lot.backdrop) return 0;            // the focal point of every side-street view
  if (lot.sideStreet && lot.x0 > 30) return 1;
  return 0;
}

/**
 * Unfinished jobs worth advancing now, sorted by metres of travel until the streamer
 * asks for them (0 = asked for already, or will be any moment). Returns a shared array of
 * pooled entries {idx, lod, mtn, dist}, valid until the next call.
 */
const _cands = [], _candPool = [];
/** True while the streamer still has to build our part of chunk ch. */
const partDue = (ch) => !ch.pending || ch.pending.indexOf('buildings') >= 0;
function candidates(app, sCam, boundary = false, lookFar = LOOK_FAR) {
  const W = app.world, n = app.layout.nChunks;
  const iEnd = Math.floor((sCam + VIEW_AHEAD) / CHUNK_LEN);
  const i0 = Math.floor((sCam - VIEW_BEHIND) / CHUNK_LEN), i1 = Math.floor((sCam + VIEW_AHEAD + lookFar) / CHUNK_LEN);
  const out = _cands;
  out.length = 0;
  for (let i = i0; i <= i1; i++) {
    const idx = ((i % n) + n) % n;
    const mid = i * CHUNK_LEN + CHUNK_LEN / 2;
    const dist = Math.max(0, Math.abs(mid - sCam) - CHUNK_LEN / 2);
    const c = W && W.chunks ? W.chunks.get(idx) : null;
    let lod, mtn;
    if (boundary) {
      // both levels of the chunks within a chunk of the full-detail switch
      if (Math.abs(dist - LOD0_DIST) > CHUNK_LEN) continue;
      lod = dist < LOD0_DIST ? 1 : 0; mtn = 0;
    } else if (!c) {
      // created when it enters the view, at the level for its distance then
      lod = dist < LOD0_DIST ? 0 : 1;
      mtn = i <= iEnd ? 0 : i * CHUNK_LEN - (sCam + VIEW_AHEAD);
    } else if (c.next && !c.next.ready) {
      // an upgrade under way: due now, unless our part of it is built already
      if (!partDue(c.next)) continue;
      lod = c.next.lod; mtn = 0;
    } else if (c.lod > 1) {
      // a far-field chunk (lod 2: core/farfield.js) becomes ours when it enters the view
      lod = 1; mtn = i <= iEnd ? 0 : i * CHUNK_LEN - (sCam + VIEW_AHEAD);
    } else if (!c.ready) {
      // (a chunk stays unready while the other modules build and its programs compile:
      // once our part is built, its job is gone and must not be generated again)
      if (!partDue(c)) continue;
      lod = c.lod; mtn = 0;
    }
    else if (c.lod === 1 && mid > sCam) {
      lod = 0; mtn = dist - LOD0_DIST;
      if (mtn > LOOK_LOD0) continue;
    } else continue;
    const job = jobs.get(jobKey(idx, lod));
    if (job && (job.done || swaps.has(job))) continue;
    const e = _candPool[out.length] || (_candPool[out.length] = { idx: 0, lod: 0, mtn: 0, dist: 0 });
    e.idx = idx; e.lod = lod; e.mtn = Math.max(0, mtn); e.dist = dist;
    // insertion sort by (mtn, dist): a few dozen entries, no comparator allocation
    let k = out.length;
    out.push(e);
    while (k > 0 && (out[k - 1].mtn > e.mtn || (out[k - 1].mtn === e.mtn && out[k - 1].dist > e.dist))) { out[k] = out[k - 1]; k--; }
    out[k] = e;
  }
  return out;
}

function newJob(app, idx, lod) {
  const { layout } = app;
  const lots = [...layout.inChunk('lots', idx), ...layout.inChunk('sideLots', idx), ...(backdrops.get(idx) || []), ...(lanes.get(idx) || []), ...(skyline.get(idx) || [])];
  const job = { idx, lod, lots, next: 0, iter: null, B: null, ms: 0, done: false, result: null, s: idx * CHUNK_LEN + CHUNK_LEN / 2 };
  jobs.set(jobKey(idx, lod), job);
  buildings.stats.jobs++;
  return job;
}

/**
 * A job's detail level as an index into DETAIL (0 or 1). Anything else (undefined, NaN,
 * negative, fractional) is clamped, and reported once with the job, so a producer handing
 * out such levels can be found (buildings.stats.badLod).
 */
function detailIndex(job, lot) {
  const raw = job.lod;
  const lod = Math.max(0, Math.min(1, raw | 0));
  if (raw !== lod && !(raw > 1 && Number.isInteger(raw)) && !buildings.stats.badLod) {
    buildings.stats.badLod = { idx: job.idx, lod: String(raw), slab: !!lot.slab, lot: lot.id };
    console.info('[buildings] job with an unexpected detail level (clamped)', buildings.stats.badLod);
  }
  return lod;
}

/**
 * The stone materials' metadata and texture row layouts (for fitting head joints to the
 * openings), refreshed every few seconds rather than built per call.
 */
function stoneMetas(app) {
  const f = app.frame || 0;
  // (not cached while a layout is missing: the materials may still be setting up)
  if (metas && metas.ashlarLay && metas.roughLay && f - metasAt < 240 && f >= metasAt) return metas;
  const M = app.materials, uni = (n) => (M.uniformsOf ? M.uniformsOf(n) : null);
  metas = {
    ashlar: metaOf(M, 'stone.ashlar'), rough: metaOf(M, 'stone.rough'),
    ashlarLay: rowLayout(uni('stone.ashlar')), roughLay: rowLayout(uni('stone.rough')),
  };
  metasAt = f;
  return metas;
}

function metaOf(M, name) {
  const m = M && M.meta;
  if (!m) return null;
  if (typeof m === 'function') return m(name);
  if (m instanceof Map) return m.get(name);
  return m[name] || null;
}

/** Ironwork's published API (console positions), when the module runs. */
function iw(app) {
  const m = app.systems && app.systems.ironwork;
  return m && !m.disabled && typeof m.consolesOf === 'function' ? m : null;
}

/**
 * Generate steps of `job` until it is complete or budgetMs is spent. A step (part of a
 * facade, a few openings, one rooftop item...) is not started when the running average
 * step cost would overrun the budget, except the first one of the call.
 */
function runJob(app, job, budgetMs) {
  if (job.done) return;
  const t0 = performance.now();
  if (!job.B) job.B = new Builder();
  const B = job.B;
  const mt = stoneMetas(app);
  const st = buildings.stats;
  while (job.iter || job.next < job.lots.length) {
    const el = performance.now() - t0;
    if (el > 0.02 && el + stepAvg > budgetMs) break;
    if (!job.iter) {
      const lot = job.lots[job.next++];
      const lod = detailIndex(job, lot);
      // (the consoles under the balconies, which the run-off streaks hang from: ironwork
      // publishes them on the plan, see shade.FaceShade)
      if (!lot.slab && !lot.lane && iw(app)) iw(app).consolesOf(lot);
      job.iter = lot.slab ? slabSteps(B, lot, DETAIL[Math.min(1, lod)]) : lot.lane ? laneSteps(B, lot)
        : lotSteps(B, lot, endsOf(app, lot), DETAIL[lotLod(lot, lod)], mt);
    }
    const ts = performance.now();
    if (job.iter.next().done) job.iter = null;
    const d = performance.now() - ts;
    stepAvg = stepAvg * 0.98 + d * 0.02;
    st.stepAvg = stepAvg;
    st.stepMax = Math.max(st.stepMax * 0.999, d);
  }
  job.ms += performance.now() - t0;
  if (job.iter || job.next < job.lots.length) return;
  // closing the job (bounds over every vertex, handing the buffers over) is a step too
  const el = performance.now() - t0;
  if (el > 0.02 && el + finishAvg > budgetMs) return;
  const tf = performance.now();
  job.result = geometries(B);
  job.B = null;
  job.done = true;
  finishAvg = finishAvg * 0.9 + (performance.now() - tf) * 0.1;
  const cl = job.lod === 0 ? 0 : 1;
  cost[cl] = cost[cl] * 0.8 + (job.ms / CHUNK_LEN) * 0.2;
}

/**
 * A finished batch as one BufferGeometry per material key (compact vertex format, see
 * buildings/mesh.js), sharing the batch's bounds: {geoms: Map key -> geometry, pending:
 * [[geometry, name, attribute]...] vertex attributes not attached yet (preUpload attaches
 * them a few at a time), left: their bytes}.
 */
function geometries(B) {
  const box = new THREE.Box3();
  for (const sk of B.sinks.values()) if (sk.vc) sk.bounds(box);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const geoms = new Map(), pending = [];
  for (const [key, p] of B.finish()) {
    const g = new THREE.BufferGeometry();
    g.setIndex(new THREE.BufferAttribute(p.i, 1));
    g.boundingSphere = sphere.clone();
    g.boundingBox = box.clone();
    geoms.set(key, g);
    pending.push([g, 'position', new THREE.BufferAttribute(p.p, 3)], [g, 'normal', new THREE.BufferAttribute(p.n, 4, true)],
      [g, 'uv', new THREE.BufferAttribute(p.t, 2)], [g, 'color', new THREE.BufferAttribute(p.c, 4, true)]);
    if (RUNOFF.has(key) || key.startsWith('mural')) pending.push([g, 'aRun', new THREE.BufferAttribute(p.r, 4)]);
  }
  // smallest last: popped first, so a frame's budget fills up with small ones
  pending.sort((a, b) => b[2].array.byteLength - a[2].array.byteLength);
  return { geoms, pending, left: pending.reduce((n, a) => n + a[2].array.byteLength, 0) };
}

/**
 * Set a vertex attribute; the packed normal also goes in as aNrmW (the same buffer, sent
 * once): its w is the height above the paving, which the stone materials read (grime.js).
 */
function attach(g, name, a) {
  g.setAttribute(name, a);
  if (name === 'normal') g.setAttribute('aNrmW', a);
}

/**
 * Attach every attribute a result still holds back (the renderer uploads them when
 * drawn). geometry.userData.revealBytes: what drawing it still sends (those attributes
 * and the index), for the streamer's upload budget.
 */
function attachAll(res) {
  for (const g of res.geoms.values()) g.userData.revealBytes = g.index ? g.index.array.byteLength : 0;
  for (const [g, name, a] of res.pending) { attach(g, name, a); g.userData.revealBytes += a.array.byteLength; }
  res.pending.length = 0;
}

/** One mesh per material from a finished job's geometry. */
function fillGroup(app, group, res) {
  if (!res) return group;
  attachAll(res);
  for (const [key, g] of res.geoms) {
    const mesh = new THREE.Mesh(g, MATS[key] || app.materials.get(MATERIAL[key] || 'stone.ashlar', { vertexColors: true }));
    mesh.name = `buildings:${key}`;
    mesh.castShadow = !NO_SHADOW.has(key);
    if (THIN.has(key)) mesh.userData.thinCaster = true;
    if (LATE.has(key)) mesh.renderOrder = 1;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  return group;
}

/** Replace a stand-in group's meshes with the finished shell. */
function swapIn(app, group, res) {
  for (const m of [...group.children]) { group.remove(m); m.geometry.dispose(); }
  fillGroup(app, group, res);
}

/** Coarse stand-in for the lots of a job (see shell.coarseLot). */
function coarseGroup(app, job) {
  const B = new Builder();
  for (const lot of job.lots) if (!lot.slab && !lot.lane) coarseLot(B, lot);
  return fillGroup(app, new THREE.Group(), geometries(B));
}

/** Free the GPU buffers of a finished job that was never shown. */
function dropJob(job) {
  if (!job.result) return;
  job.result.pending.length = 0;
  for (const g of job.result.geoms.values()) g.dispose();   // (frees what preUpload sent)
  job.result = null;
}

// ------------------------------------------------------------------ uploads ahead

/**
 * Upload vertex buffers of finished jobs ahead of their reveal, the most urgent job
 * first (stand-ins waiting for their swap, then by metres of travel until the streamer
 * needs the chunk), UPLOAD_BYTES per frame. A job's geometries start without vertex
 * attributes; each frame attaches a few more and shows the geometries that grew to the
 * renderer through uploader meshes, which have no material (nothing is drawn or
 * compiled) but are visible, so the renderer sends the new vertex buffers when it walks
 * the scene. The geometries are then known to the renderer, so disposing them frees
 * those buffers as usual. Index buffers are only sent by a draw: they go with the reveal.
 */
const _touched = [];
function preUpload(app, sCam) {
  if (!uploaders) return;
  const st = buildings.stats;
  const touched = _touched;
  touched.length = 0;
  let bytes = 0;
  while (true) {
    let best = null, bestNeed = Infinity;
    for (const job of jobs.values()) {
      const r = job.result;
      if (!r || !r.pending.length) continue;
      const need = swaps.has(job) ? -1e9 : app.route.delta(sCam, job.s) - (job.lod ? VIEW_AHEAD : LOD0_DIST);
      if (need < bestNeed) { bestNeed = need; best = r; }
    }
    if (!best) break;
    const p = best.pending[best.pending.length - 1], g = p[0], sz = p[2].array.byteLength;
    if (bytes && bytes + sz > UPLOAD_BYTES) break;
    best.pending.pop();
    best.left -= sz;
    attach(g, p[1], p[2]);
    if (touched.indexOf(g) < 0) touched.push(g);
    bytes += sz;
  }
  for (let i = 0; i < touched.length; i++) {
    let m = uploaders.children[i];
    if (!m) {
      m = new THREE.Mesh(NO_GEOMETRY, []);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      uploaders.add(m);
    }
    m.geometry = touched[i];
  }
  touched.length = 0;
  st.preBytes = bytes;
  if (bytes) st.preMB = +(st.preMB + bytes / 1048576).toFixed(2);
}

/** Let go of the geometries shown to the renderer last frame (their GPU buffers stay). */
function releaseUploads() {
  if (uploaders) for (const m of uploaders.children) m.geometry = NO_GEOMETRY;
}

function evict(app, sCam) {
  for (const [k, j] of jobs) {
    if (swaps.has(j)) continue;
    const d = app.route.delta(sCam, j.s);
    if (d < -VIEW_BEHIND - CHUNK_LEN * 2 || d > VIEW_AHEAD + LOOK_FAR + CHUNK_LEN * 3) { jobs.delete(k); dropJob(j); }
  }
}

// ------------------------------------------------------------------ side-street backdrops

/**
 * Buildings across the far end of every side street, facing back towards the main
 * street, so looking down a side street ends on facades instead of the sky. They stand
 * across a cross lane 9–12 m beyond the last buildings of the side street (a T
 * junction: the street seems to go on to either side), whose arms get an asphalt apron
 * (buildings/lane.js). Two or three lots of different width (and so of different height
 * and style) with small set-backs, so the end of the street is never one symmetric
 * slab. These are buildings-only pseudo-lots (same plan generator and frame conventions
 * as layout lots), published through extraLots() so the facades module dresses them.
 * Each end is also a site for a taller block behind (planSkyline).
 */
function planBackdrops(app) {
  const { route, layout } = app;
  const up = new THREE.Vector3(0, 1, 0);
  // where the side-street rows end (the longer row of each side street)
  const rowEnd = new Map();
  for (const l of layout.sideLots) {
    const k = `${Math.round(l.cross.s)}_${l.side}`;
    rowEnd.set(k, Math.max(rowEnd.get(k) || 0, l.x1));
  }
  const push = (map, idx, item) => { if (!map.has(idx)) map.set(idx, []); map.get(idx).push(item); };
  for (const c of layout.crossStreets) {
    const sides = c.side === 0 ? [-1, 1] : [c.side];
    for (const side of sides) {
      const smp = route.sample(c.s);
      const dirOut = smp.right.clone().multiplyScalar(side).applyAxisAngle(up, c.angle || 0);
      const start = route.toWorld(c.s, side * layout.halfWidth(c.s, side), 0);
      const base = `E${Math.round(c.s)}_${side}`;
      const end = rowEnd.get(`${Math.round(c.s)}_${side}`) ?? c.depth + SIDE_LOT_START;
      const lane = RNG.from(hashStr(base), 'lane').range(9, 12);
      const dist = end + lane;
      const total = c.width + 16;
      const nDir = dirOut.clone().negate();
      const uDir = new THREE.Vector3().crossVectors(up, nDir).normalize(); // uDir × up = nDir
      const centre = start.clone().addScaledVector(dirOut, dist);
      const rng = RNG.from(hashStr(base), 'split');
      const n = total > 25 ? 3 : 2;
      const parts = [];
      for (let k = 0; k < n; k++) parts.push(rng.range(0.65, 1.35));
      const sum = parts.reduce((a, b) => a + b, 0);
      const idx = layout.chunkIndex(c.s);
      let u = -total / 2;
      for (let k = 0; k < n; k++) {
        const width = (parts[k] / sum) * total;
        const back = k === 0 || k === n - 1 ? rng.range(0, 0.8) : rng.range(0, 0.4);
        const origin = new THREE.Vector3(centre.x + uDir.x * u + dirOut.x * back, start.y, centre.z + uDir.z * u + dirOut.z * back);
        const matrix = new THREE.Matrix4().makeBasis(uDir, up, nDir).setPosition(origin);
        const frame = { origin, uDir: uDir.clone(), nDir: nDir.clone(), up: up.clone(), width, ground0: start.y, ground1: start.y, floorRef: start.y, matrix };
        const id = `${base}_${k}`;
        push(backdrops, idx, {
          id, side, cross: c, edge: 0, x0: dist + back, x1: dist + back, len: width, seed: hashStr(id + ':backdrop'), depth: 14,
          sideStreet: true, backdrop: true, frame, s0: c.s, s1: c.s, cornerU0: false, cornerU1: false,
        });
        u += width;
      }
      // the lane's apron: from under the last side-street buildings to under the backdrop,
      // as wide as the backdrop row (frame at the mouth, w = minus the distance out)
      const frame = { origin: new THREE.Vector3(start.x, start.y, start.z), uDir: uDir.clone(), nDir: nDir.clone(), up: up.clone(), width: total, ground0: start.y, ground1: start.y, floorRef: start.y };
      push(lanes, idx, { id: `${base}_lane`, lane: true, frame, u0: -total / 2, u1: total / 2, w0: -(dist + 1.5), w1: -(end - 2), v: -0.03 });
      vistas.push({ c, side, start, dirOut, nDir, uDir, back: dist + 14 });
    }
  }
}

// ------------------------------------------------------------------ skyline

/**
 * Taller blocks 40–110 m behind the frontage, every 150–300 m, on alternating sides, and
 * at the far end of side streets (see buildings/skyline.js). A site is used only when
 * the whole footprint keeps well clear of the street (anywhere on the loop) and of every
 * side street and its lots. (The lots that close the view down the street itself get a
 * taller set-back block of their own: facadePlan tower().)
 */
function planSkyline(app) {
  const { route, layout } = app;
  const L = route.length, up = new THREE.Vector3(0, 1, 0);
  const rng = RNG.from('buildings', 'skyline', layout.seed ?? 0);
  // street centre line samples, and side-street axes (from the mouth to beyond the backdrop)
  const pts = [];
  for (let s = 0; s < L; s += 6) { const p = route.toWorld(s, 0, 0); pts.push(p.x, p.z); }
  const sides = [];
  for (const c of layout.crossStreets) {
    for (const side of c.side === 0 ? [-1, 1] : [c.side]) {
      const dir = route.sample(c.s).right.clone().multiplyScalar(side).applyAxisAngle(up, c.angle || 0);
      const a = route.toWorld(c.s, side * layout.halfWidth(c.s, side), 0);
      const len = c.depth + SIDE_LOT_START + 30;
      sides.push({ ax: a.x, az: a.z, dx: dir.x, dz: dir.z, len, clear: c.width / 2 + 24 });
    }
  }
  // (skip: index of a side street to leave out, for blocks closing its own vista)
  const clearOf = (x, z, r, skip = -1) => {
    for (let i = 0; i < pts.length; i += 2) if ((pts[i] - x) ** 2 + (pts[i + 1] - z) ** 2 < (r + 34) ** 2) return false;
    for (let i = 0; i < sides.length; i++) {
      if (i === skip) continue;
      const q = sides[i];
      const t = Math.max(0, Math.min(q.len, (x - q.ax) * q.dx + (z - q.az) * q.dz));
      if (Math.hypot(q.ax + q.dx * t - x, q.az + q.dz * t - z) < r + q.clear) return false;
    }
    return true;
  };
  const placed = [];                 // [x, z, r] of every block so far
  let side = rng.chance(0.5) ? 1 : -1;
  for (let s = rng.range(60, 200); s < L - 60; s += rng.range(150, 300), side = rng.chance(0.7) ? -side : side) {
    const W = rng.range(18, 30), back = rng.range(40, 110), D = 16;
    const smp = route.sample(s);
    const hw = layout.halfWidth(s, side);
    const nDir = smp.right.clone().multiplyScalar(-side);                 // towards the street
    const uDir = new THREE.Vector3().crossVectors(up, nDir).normalize();
    const front = route.toWorld(s, side * (hw + back), 0);
    const cx = front.x - nDir.x * D / 2, cz = front.z - nDir.z * D / 2;
    if (!clearOf(cx, cz, Math.hypot(W, D) / 2)) continue;
    const origin = front.clone().addScaledVector(uDir, -W / 2);
    origin.y = Math.min(origin.y, route.elevation(s));
    const matrix = new THREE.Matrix4().makeBasis(uDir, up, nDir).setPosition(origin);
    const frame = { origin, uDir, nDir, up: up.clone(), width: W, ground0: origin.y, ground1: origin.y, floorRef: origin.y, matrix };
    const sl = makeSlab(`K${Math.round(s)}_${side}`, frame, RNG.from('buildings', 'slab', Math.round(s)), [8, 14], { side });
    const idx = layout.chunkIndex(s);
    if (!skyline.has(idx)) skyline.set(idx, []);
    skyline.get(idx).push(sl);
    placed.push([cx, cz, Math.hypot(W, D) / 2]);
  }

  // Vista blocks (8–12 storeys): set back behind the backdrop at the end of some side
  // streets, so the view down them ends on a taller block as in the photographs.
  const add = (id, x, z, y, nDir, W, D, s, rr, floors = [8, 12], opts = {}) => {
    const uDir = new THREE.Vector3().crossVectors(up, nDir).normalize();
    // front-left corner: the centre is D / 2 behind the front
    const origin = new THREE.Vector3(x + nDir.x * D / 2 - uDir.x * W / 2, y, z + nDir.z * D / 2 - uDir.z * W / 2);
    const matrix = new THREE.Matrix4().makeBasis(uDir, up, nDir).setPosition(origin);
    const frame = { origin, uDir, nDir: nDir.clone(), up: up.clone(), width: W, ground0: y, ground1: y, floorRef: y, matrix };
    const sl = makeSlab(id, frame, rr, floors, opts);
    sl.D = D;                        // the depth this footprint was placed (and cleared) with
    const idx = layout.chunkIndex(s);
    if (!skyline.has(idx)) skyline.set(idx, []);
    skyline.get(idx).push(sl);
    placed.push([x, z, Math.hypot(W, D) / 2]);
  };
  const apart = (x, z, r) => placed.every(([px, pz, pr]) => Math.hypot(px - x, pz - z) > pr + r + 4);
  vistas.forEach((v, i) => {
    const rr = RNG.from('buildings', 'vista', Math.round(v.c.s), v.side);
    if (!rr.chance(0.6)) return;
    const W = rr.range(18, 28), D = rr.range(12, 16), gap = rr.range(5, 16), off = rr.range(-6, 6);
    const x = v.start.x + v.dirOut.x * (v.back + gap + D / 2) + v.uDir.x * off;
    const z = v.start.z + v.dirOut.z * (v.back + gap + D / 2) + v.uDir.z * off;
    const r = Math.hypot(W, D) / 2;
    if (!clearOf(x, z, r, i) || !apart(x, z, r)) return;
    add(`V${Math.round(v.c.s)}_${v.side}`, x, z, v.start.y - 1, v.nDir, W, D, v.c.s, rr, [8, 12], { mural: rr.chance(0.2), muralFace: 0 });
  });
}

// ------------------------------------------------------------------ neighbours

/** World-space facade end points (u = 0 and u = width) of a lot. */
function endPoints(lot) {
  const f = lot.frame;
  const a = new THREE.Vector3(f.origin.x, f.floorRef, f.origin.z);
  const b = a.clone().addScaledVector(f.uDir, f.width);
  return [a, b];
}

const CELL = 2;   // spatial hash cell (m) of facade end points
const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

function indexEnds(layout) {
  endIndex = new Map();
  const add = (p, item) => {
    const k = cellKey(p.x, p.z);
    if (!endIndex.has(k)) endIndex.set(k, []);
    endIndex.get(k).push(item);
  };
  for (const lot of [...layout.lots, ...layout.sideLots, ...[...backdrops.values()].flat()]) {
    const f = lot.frame;
    endPoints(lot).forEach((p, e) => add(p, { lot, e, p, uDir: f.uDir }));
    // the far ends of corner returns stand next to the first side-street lots
    for (const r of lot.cornerU0 || lot.cornerU1 ? facadePlan(lot).returns || [] : []) {
      if (r.isCut) continue;
      const rf = r.frame;
      const p = new THREE.Vector3(rf.origin.x, rf.floorRef, rf.origin.z);
      if (!r.cornerAtU1) p.addScaledVector(rf.uDir, r.width);
      add(p, { lot, e: r.cornerAtU1 ? 0 : 1, p, uDir: rf.uDir, ret: r });
    }
  }
}

/**
 * Neighbour description at both ends of a lot, in its facade frame (lazy, cached).
 * A neighbour is the facade whose opposite end lies on this end's party-wall line:
 * within 0.6 m along the facade and up to 3 m in front of or behind it (set-backs).
 */
function endsOf(app, lot) {
  let r = ends.get(lot.id);
  if (r) return r;
  const plan = facadePlan(lot);
  const f = lot.frame;
  const pts = endPoints(lot);
  r = [0, 1].map((e) => {
    const corner = e === 0 ? plan.cornerU0 : plan.cornerU1;
    if (corner) return { corner: true, nb: null };
    const p = pts[e];
    let best = null, bestD = Infinity;
    const cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      for (const it of endIndex.get(`${cx + dx},${cz + dz}`) || []) {
        if (it.lot === lot || it.e === e) continue;
        if (it.uDir.x * f.uDir.x + it.uDir.z * f.uDir.z < 0.8) continue;   // roughly parallel fronts only
        const ox = it.p.x - p.x, oz = it.p.z - p.z;
        const du = ox * f.uDir.x + oz * f.uDir.z, dn = ox * f.nDir.x + oz * f.nDir.z;
        if (Math.abs(du) > 0.6 || Math.abs(dn) > 3) continue;
        const d = Math.abs(du) * 2 + Math.abs(dn);
        if (d < bestD) { bestD = d; best = { it, dn }; }
      }
    }
    if (!best) return { corner: false, nb: null };
    const nb = best.it.lot, np = facadePlan(nb);
    const nbTopWorld = nb.frame.floorRef + (np.roof.type === 'tile' ? np.parapet.y : np.totalHeight);
    // a corner return's building reaches back along the main street by the corner lot's width
    const nbDepth = best.it.ret ? np.width : np.depth;
    // (nbClear: above this nothing of the neighbour stands, its set-back storey and the
    // solar heaters on its roofs included)
    const up = np.upper, upTop = up ? nb.frame.floorRef + up.v0 + up.floors * up.floorH + 0.2 : -Infinity;
    const ridge = np.roof.type === 'tile' ? nbTopWorld + np.depth * 0.5 * Math.tan(((np.roof.pitch || 30) * Math.PI) / 180) + 0.6 : 0;
    const nbClear = (np.roof.type === 'tile' ? ridge : Math.max(nbTopWorld, upTop) + 2.9) - f.floorRef;
    // (nbDeck: its roof deck or eaves, below which its building covers this side wall)
    return { corner: false, nb: nb.id, dw: best.dn, nbTop: nbTopWorld - f.floorRef, nbDeck: nb.frame.floorRef + np.parapet.y - f.floorRef, nbDepth, nbClear };
  });
  ends.set(lot.id, r);
  return r;
}
