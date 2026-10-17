import * as THREE from 'three';
import { facadePlan, bindLayout } from './facadePlan.js';
import { CHUNK_LEN, LOD0_DIST, VIEW_AHEAD, VIEW_BEHIND } from '../core/config.js';
import { hashStr, RNG } from '../core/rng.js';
import { SIDE_LOT_START } from './layout.js';
import { Builder } from './buildings/mesh.js';
import { lotSteps, coarseLot, DETAIL } from './buildings/shell.js';
import { grimeStone, litGlass } from './buildings/grime.js';

// Building shells (masonry) for every lot, generated from facadePlan(lot): see
// src/world/buildings/shell.js for what is built. Facade infill (glass, frames,
// shopfronts, doors, signs) and ironwork are other modules.
//
// Performance: a chunk's buildings are generated as a "job" (one Builder each, so jobs
// interleave freely) in small steps straight into per-material buffers in world space,
// which become the geometry's arrays as they are (no merging, no copies). update()
// advances the jobs the streamer will need next, ordered by how soon each is needed,
// within a per-frame budget that grows with speed and urgency (init prepares the start
// position up front), so build() normally only wraps finished arrays. A far chunk whose
// job is still running gets a coarse stand-in that is swapped for the real shell when
// the job ends, instead of a long synchronous build.

const MATERIAL = {
  ashlar: 'stone.ashlar', smooth: 'stone.smooth', rough: 'stone.rough', plaster: 'plaster',
  tile: 'roof.tile', metal: 'metal.galvanized', glass: 'glass.window', frame: 'paint.frame',
};
const NO_SHADOW = new Set(['glass', 'frame']);   // joinery inside the reveals
let MATS = {};                     // buildings-owned material variants by sink key (weathered stone, lit glass)
const BASE_MS = 1.5;               // per-frame generation budget when nothing is urgent
const MAX_MS = 5;                  // ... when a chunk is about to be (or already is) requested
const LOOK_LOD0 = 110;             // full detail is prepared up to this far before the switch
const LOOK_FAR = 110;              // far detail is prepared up to this far beyond the view

let FORCE_LOD = null;              // debug: ?blod=0|1 forces one detail level everywhere
const jobs = new Map();            // `${chunkIndex}|${lod}` -> job
const swaps = new Map();           // job -> group showing a coarse stand-in until the job ends
const ends = new Map();            // lotId -> [end0, end1] (lazy)
let endIndex = null;               // spatial hash of facade end points
const backdrops = new Map();       // chunk index -> pseudo-lots closing the far end of side streets
const cost = [0.4, 0.15];          // running generation cost by detail level (ms per metre of route)
let stepAvg = 0.25;                // running cost of one generation step (ms)

const buildings = {
  name: 'buildings',
  stats: { jobs: 0, inline: 0, coarse: 0, stepAvg: 0, stepMax: 0, buildMs: 0, budgetMs: 0, cost },
  sync: false,                     // true: build() always generates the full shell (tests)

  async init(app) {
    this.app = app;
    const fl = app.params.str ? app.params.str('blod') : null;
    if (fl === '0' || fl === '1') FORCE_LOD = +fl;
    bindLayout(app.layout);   // corner returns follow the real side-street lines
    // weathered stone (drip trails, rain wash, soot crusts where the baked grime mask
    // says so) and the backdrop lots' glass, lit at night
    if (app.materials.register) {
      MATS = {
        ashlar: grimeStone(app, 'stone.ashlar'),
        rough: grimeStone(app, 'stone.rough'),
        smooth: grimeStone(app, 'stone.smooth', [0.45, 0.55, 0.12, 0.35]),
        glass: litGlass(app, 'glass.window'),
      };
    }
    planBackdrops(app);
    indexEnds(app.layout);
    // everything the first frames need, before the streamer primes
    const around = [app.startS];
    if (app.params.view) around.push(app.params.view[0]);
    for (const s of around) this.prefetch(app, s, Infinity);
  },

  build(chunk, app) {
    const t0 = performance.now();
    const k = jobKey(chunk.index, chunk.lod);
    let job = jobs.get(k);
    if (!job) job = newJob(app, chunk.index, chunk.lod);
    if (!job.lots.length) { jobs.delete(k); return null; }
    let group;
    if (!job.done && chunk.lod === 1 && !this.sync) {
      // far edge not ready: a coarse stand-in now, the real shell once the job is done
      group = coarseGroup(app, job);
      swaps.set(job, group);
      this.stats.coarse++;
    } else {
      if (!job.done) { this.stats.inline++; runJob(app, job, Infinity); }
      jobs.delete(k);
      group = new THREE.Group();
      fillGroup(app, group, job.result);
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
   * facadePlan(lot) works; they carry their own infill (selfDressed: true).
   */
  extraLots(i) {
    const n = this.app.layout.nChunks;
    return backdrops.get(((i % n) + n) % n) || [];
  },

  update(dt, app) {
    const s = app.cameraS;
    if (s == null || !app.world) return;
    if ((app.frame & 31) === 0) evict(app, s);
    this.prefetch(app, s, null);
  },

  /**
   * Advance the jobs the streamer will need next, most urgent first: stand-ins on screen,
   * then by metres of travel until the streamer requests each chunk (at the far edge of
   * the view, or at the full-detail switch). budgetMs null: adaptive (speed, urgency).
   */
  prefetch(app, sCam, budgetMs) {
    const t0 = performance.now();
    const spent = () => performance.now() - t0;
    const cands = candidates(app, sCam);
    if (budgetMs == null) {
      const v = Math.abs(app.train?.speed ?? 10);
      // generation needed per second of travel, with headroom, spread over this frame
      budgetMs = Math.max(BASE_MS, v * (cost[0] + cost[1]) * (app.realDt || 1 / 60) * 2);
      const soon = swaps.size ? 0 : cands.length ? cands[0].mtn : Infinity;
      if (soon <= 0) budgetMs = MAX_MS;
      else if (soon < CHUNK_LEN) budgetMs = Math.max(budgetMs, MAX_MS * 0.6);
      budgetMs = Math.min(budgetMs, MAX_MS);
      this.stats.budgetMs = budgetMs;
    }
    for (const [job, g] of swaps) {
      runJob(app, job, budgetMs - spent());
      if (job.done) { swaps.delete(job); jobs.delete(jobKey(job.idx, job.lod)); swapIn(app, g, job.result); }
      if (spent() > budgetMs) return;
    }
    for (const c of cands) {
      if (budgetMs - spent() < stepAvg * 0.5) return;
      const job = jobs.get(jobKey(c.idx, c.lod)) || newJob(app, c.idx, c.lod);
      runJob(app, job, budgetMs - spent());
    }
  },
};
export default buildings;

// ------------------------------------------------------------------ chunk jobs

const jobKey = (idx, lod) => `${idx}|${lod}`;

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
 * asks for them (0 = asked for already, or will be any moment).
 */
function candidates(app, sCam) {
  const W = app.world, n = app.layout.nChunks;
  const iEnd = Math.floor((sCam + VIEW_AHEAD) / CHUNK_LEN);
  const i0 = Math.floor((sCam - VIEW_BEHIND) / CHUNK_LEN), i1 = Math.floor((sCam + VIEW_AHEAD + LOOK_FAR) / CHUNK_LEN);
  const out = [];
  for (let i = i0; i <= i1; i++) {
    const idx = ((i % n) + n) % n;
    const mid = i * CHUNK_LEN + CHUNK_LEN / 2;
    const dist = Math.max(0, Math.abs(mid - sCam) - CHUNK_LEN / 2);
    const c = W && W.chunks ? W.chunks.get(idx) : null;
    let lod, mtn;
    if (!c) {
      // created when it enters the view, at the level for its distance then
      lod = dist < LOD0_DIST ? 0 : 1;
      mtn = i <= iEnd ? 0 : i * CHUNK_LEN - (sCam + VIEW_AHEAD);
    } else if (c.next && !c.next.ready) { lod = c.next.lod; mtn = 0; }
    else if (!c.ready) { lod = c.lod; mtn = 0; }
    else if (c.lod === 1 && mid > sCam) {
      lod = 0; mtn = dist - LOD0_DIST;
      if (mtn > LOOK_LOD0) continue;
    } else continue;
    const job = jobs.get(jobKey(idx, lod));
    if (job && (job.done || swaps.has(job))) continue;
    out.push({ idx, lod, mtn: Math.max(0, mtn), dist });
  }
  out.sort((a, b) => a.mtn - b.mtn || a.dist - b.dist);
  return out;
}

function newJob(app, idx, lod) {
  const { layout } = app;
  const lots = [...layout.inChunk('lots', idx), ...layout.inChunk('sideLots', idx), ...(backdrops.get(idx) || [])];
  const job = { idx, lod, lots, next: 0, iter: null, B: null, ms: 0, done: false, result: null, s: idx * CHUNK_LEN + CHUNK_LEN / 2 };
  jobs.set(jobKey(idx, lod), job);
  buildings.stats.jobs++;
  return job;
}

function metaOf(M, name) {
  const m = M && M.meta;
  if (!m) return null;
  if (typeof m === 'function') return m(name);
  if (m instanceof Map) return m.get(name);
  return m[name] || null;
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
  const metas = { ashlar: metaOf(app.materials, 'stone.ashlar'), rough: metaOf(app.materials, 'stone.rough') };
  const st = buildings.stats;
  while (job.iter || job.next < job.lots.length) {
    const el = performance.now() - t0;
    if (el > 0.02 && el + stepAvg > budgetMs) break;
    if (!job.iter) { const lot = job.lots[job.next++]; job.iter = lotSteps(B, lot, endsOf(app, lot), DETAIL[lotLod(lot, job.lod)], metas); }
    const ts = performance.now();
    if (job.iter.next().done) job.iter = null;
    const d = performance.now() - ts;
    stepAvg = stepAvg * 0.98 + d * 0.02;
    st.stepAvg = stepAvg;
    st.stepMax = Math.max(st.stepMax * 0.999, d);
  }
  job.ms += performance.now() - t0;
  if (job.iter || job.next < job.lots.length) return;
  const box = new THREE.Box3();
  for (const sk of B.sinks.values()) if (sk.vc) sk.bounds(box);
  job.result = { parts: B.finish(), box };
  job.B = null;
  job.done = true;
  cost[job.lod] = cost[job.lod] * 0.8 + (job.ms / CHUNK_LEN) * 0.2;
}

/** One mesh per material from a finished job's buffers. */
function fillGroup(app, group, res) {
  if (!res || !res.parts.size) return group;
  const sphere = res.box.getBoundingSphere(new THREE.Sphere());
  for (const [key, p] of res.parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(p.n, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(p.t, 2));
    g.setAttribute('color', new THREE.BufferAttribute(p.c, 3));
    g.setAttribute('aGrime', new THREE.BufferAttribute(p.g, 1));
    g.setIndex(new THREE.BufferAttribute(p.i, 1));
    g.boundingSphere = sphere.clone();
    g.boundingBox = res.box.clone();
    const mesh = new THREE.Mesh(g, MATS[key] || app.materials.get(MATERIAL[key] || 'stone.ashlar', { vertexColors: true }));
    mesh.name = `buildings:${key}`;
    mesh.castShadow = !NO_SHADOW.has(key);
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
  for (const lot of job.lots) coarseLot(B, lot);
  const box = new THREE.Box3();
  for (const sk of B.sinks.values()) if (sk.vc) sk.bounds(box);
  return fillGroup(app, new THREE.Group(), { parts: B.finish(), box });
}

function evict(app, sCam) {
  for (const [k, j] of jobs) {
    if (swaps.has(j)) continue;
    const d = app.route.delta(sCam, j.s);
    if (d < -VIEW_BEHIND - CHUNK_LEN * 2 || d > VIEW_AHEAD + LOOK_FAR + CHUNK_LEN * 3) jobs.delete(k);
  }
}

// ------------------------------------------------------------------ side-street backdrops

/**
 * Buildings across the far end of every side street, facing back towards the main
 * street, so looking down a side street ends on facades instead of the sky. Two or three
 * lots of different width (and so of different height and style) with small set-backs,
 * so the end of the street is never one symmetric slab. These are buildings-only
 * pseudo-lots (same plan generator and frame conventions as layout lots); the facades
 * module does not dress them, so they carry their own infill (selfDressed).
 */
function planBackdrops(app) {
  const { route, layout } = app;
  const up = new THREE.Vector3(0, 1, 0);
  for (const c of layout.crossStreets) {
    const sides = c.side === 0 ? [-1, 1] : [c.side];
    for (const side of sides) {
      const smp = route.sample(c.s);
      const dirOut = smp.right.clone().multiplyScalar(side).applyAxisAngle(up, c.angle || 0);
      const start = route.toWorld(c.s, side * layout.halfWidth(c.s, side), 0);
      const dist = c.depth + SIDE_LOT_START + 2.5;
      const total = c.width + 16;
      const nDir = dirOut.clone().negate();
      const uDir = new THREE.Vector3().crossVectors(up, nDir).normalize(); // uDir × up = nDir
      const centre = start.clone().addScaledVector(dirOut, dist);
      const base = `E${Math.round(c.s)}_${side}`;
      const rng = RNG.from(hashStr(base), 'split');
      const n = total > 25 ? 3 : 2;
      const parts = [];
      for (let k = 0; k < n; k++) parts.push(rng.range(0.65, 1.35));
      const sum = parts.reduce((a, b) => a + b, 0);
      let u = -total / 2;
      for (let k = 0; k < n; k++) {
        const width = (parts[k] / sum) * total;
        const back = k === 0 || k === n - 1 ? rng.range(0, 0.8) : rng.range(0, 0.4);
        const origin = new THREE.Vector3(centre.x + uDir.x * u + dirOut.x * back, start.y, centre.z + uDir.z * u + dirOut.z * back);
        const matrix = new THREE.Matrix4().makeBasis(uDir, up, nDir).setPosition(origin);
        const frame = { origin, uDir: uDir.clone(), nDir: nDir.clone(), up: up.clone(), width, ground0: start.y, ground1: start.y, floorRef: start.y, matrix };
        const id = `${base}_${k}`;
        const lot = {
          id, side, cross: c, edge: 0, x0: dist + back, x1: dist + back, len: width, seed: hashStr(id + ':backdrop'), depth: 14,
          sideStreet: true, backdrop: true, selfDressed: true, frame, s0: c.s, s1: c.s, cornerU0: false, cornerU1: false,
        };
        const idx = layout.chunkIndex(c.s);
        if (!backdrops.has(idx)) backdrops.set(idx, []);
        backdrops.get(idx).push(lot);
        u += width;
      }
    }
  }
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
    return { corner: false, nb: nb.id, dw: best.dn, nbTop: nbTopWorld - f.floorRef, nbDepth };
  });
  ends.set(lot.id, r);
  return r;
}
