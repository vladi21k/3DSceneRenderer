import * as THREE from 'three';
import { facadePlan } from './facadePlan.js';
import { CHUNK_LEN, LOD0_DIST, VIEW_AHEAD, VIEW_BEHIND } from '../core/config.js';
import { hashStr } from '../core/rng.js';
import { SIDE_LOT_START } from './layout.js';
import { Builder } from './buildings/mesh.js';
import { lotSteps, DETAIL } from './buildings/shell.js';

// Building shells (masonry) for every lot, generated from facadePlan(lot): see
// src/world/buildings/shell.js for what is built. Facade infill (glass, frames,
// shopfronts, doors, signs) and ironwork are other modules.
//
// Performance: a chunk's buildings are generated as a "job" straight into pooled
// per-material buffers (world space), one lot at a time. update() advances jobs for
// the chunks the streamer will need next within a small per-frame budget (init does
// the start position up front), so build() normally only wraps finished arrays in
// BufferGeometries: one mesh per material per chunk, no merging, no copies.

const MATERIAL = {
  ashlar: 'stone.ashlar', smooth: 'stone.smooth', rough: 'stone.rough', plaster: 'plaster',
  tile: 'roof.tile', metal: 'metal.galvanized',
};
const PREFETCH_MS = 2.0;           // per-frame budget for generating ahead of the streamer
const LOD0_AHEAD = LOD0_DIST + 90;  // full detail is prepared this far ahead
const FAR_AHEAD = VIEW_AHEAD + 90;

let FORCE_LOD = null;              // debug: ?blod=0|1 forces one detail level everywhere
const jobs = new Map();            // `${chunkIndex}|${lod}` -> job
let active = null;                 // the job currently filling the shared builder
const Bshared = new Builder();     // used by the active (time-sliced) job
const Bsync = new Builder();       // used for synchronous builds while another job is active
const ends = new Map();            // lotId -> [end0, end1] (lazy)
let endIndex = null;               // spatial hash of facade end points
const backdrops = new Map();       // chunk index -> pseudo-lots closing the far end of side streets

const buildings = {
  name: 'buildings',
  stats: { jobs: 0, inline: 0, stepMs: 0, buildMs: 0 },

  async init(app) {
    this.app = app;
    const fl = app.params.str ? app.params.str('blod') : null;
    if (fl === '0' || fl === '1') FORCE_LOD = +fl;
    planBackdrops(app);
    indexEnds(app.layout);
    // everything the first frames need, before the streamer primes
    const around = [app.startS];
    if (app.params.view) around.push(app.params.view[0]);
    for (const s of around) this.prefetch(app, s, Infinity, LOD0_DIST, VIEW_AHEAD);
  },

  build(chunk, app) {
    const t0 = performance.now();
    const k = jobKey(chunk.index, chunk.lod);
    let job = jobs.get(k);
    if (!job) { job = newJob(app, chunk.index, chunk.lod); this.stats.inline++; }
    if (!job.done) runJob(app, job, Infinity);
    jobs.delete(k);
    const res = job.result;
    if (!res || !res.parts.size) return null;
    const group = new THREE.Group();
    group.name = 'buildings';
    const sphere = res.box.getBoundingSphere(new THREE.Sphere());
    for (const [key, p] of res.parts) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.p, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(p.n, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(p.t, 2));
      g.setAttribute('color', new THREE.BufferAttribute(p.c, 3));
      g.setIndex(new THREE.BufferAttribute(p.i, 1));
      g.boundingSphere = sphere.clone();
      g.boundingBox = res.box.clone();
      const mesh = new THREE.Mesh(g, app.materials.get(MATERIAL[key] || 'stone.ashlar', { vertexColors: true }));
      mesh.name = `buildings:${key}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    group.matrixAutoUpdate = false;
    this.stats.buildMs = Math.max(this.stats.buildMs * 0.98, performance.now() - t0);
    return group;
  },

  /**
   * Buildings-only pseudo-lots in chunk i (facades closing the far end of side streets).
   * Same shape as layout lots (frame, seed, depth, sideStreet: true, backdrop: true), so
   * facadePlan(lot) works and other modules may dress them like any side-street lot.
   */
  extraLots(i) {
    const n = this.app.layout.nChunks;
    return backdrops.get(((i % n) + n) % n) || [];
  },

  update(dt, app) {
    const s = app.cameraS;
    if (s == null || !app.world) return;
    if ((app.frame & 31) === 0) evict(app, s);
    this.prefetch(app, s, PREFETCH_MS, LOD0_AHEAD, FAR_AHEAD);
  },

  /** Advance jobs for chunks the streamer will soon build, nearest first, within budgetMs. */
  prefetch(app, sCam, budgetMs, lod0Ahead, farAhead) {
    const t0 = performance.now();
    if (active && !active.done) { runJob(app, active, budgetMs); if (performance.now() - t0 > budgetMs) return; }
    const n = app.layout.nChunks;
    const i0 = Math.floor((sCam - VIEW_BEHIND) / CHUNK_LEN), i1 = Math.floor((sCam + farAhead) / CHUNK_LEN);
    const order = [];
    for (let i = i0; i <= i1; i++) {
      const mid = i * CHUNK_LEN + CHUNK_LEN / 2;
      const dist = Math.max(0, Math.abs(mid - sCam) - CHUNK_LEN / 2);
      order.push({ idx: ((i % n) + n) % n, dist, ahead: mid > sCam - CHUNK_LEN });
    }
    order.sort((a, b) => a.dist - b.dist);
    for (const o of order) {
      let need = o.dist < LOD0_DIST || (o.ahead && o.dist < lod0Ahead) ? 0 : 1;
      const c = app.world && app.world.chunks.get(o.idx);
      if (c) {
        if (c.next) { if (c.next.ready) continue; need = c.next.lod; }   // upgrade in progress
        else if (c.ready) { if (c.lod <= need) continue; }                // built; upgrade coming
        else need = c.lod;                                                // queued at its creation level
      }
      const k = jobKey(o.idx, need);
      let job = jobs.get(k);
      if (job && job.done) continue;
      if (!job) job = newJob(app, o.idx, need);
      runJob(app, job, budgetMs - (performance.now() - t0));
      if (performance.now() - t0 > budgetMs) return;
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
  if (lot.sideStreet && lot.x0 > 30) return 1;
  return 0;
}

function newJob(app, idx, lod) {
  const { layout } = app;
  const lots = [...layout.inChunk('lots', idx), ...layout.inChunk('sideLots', idx), ...(backdrops.get(idx) || [])];
  const job = { idx, lod, lots, next: 0, iter: null, done: false, result: null, s: idx * CHUNK_LEN + CHUNK_LEN / 2 };
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

/** Generate lots of `job` until it is complete or budgetMs is spent (at least one lot). */
function runJob(app, job, budgetMs) {
  if (job.done) return;
  const t0 = performance.now();
  // the shared builder belongs to the active job; any other job runs to completion on Bsync
  let B;
  if (job === active || !active || active.done) {
    if (job !== active) { active = job; Bshared.reset(); job.next = 0; job.iter = null; }
    B = Bshared;
  } else {
    B = Bsync; Bsync.reset(); job.next = 0; budgetMs = Infinity;
  }
  const metas = { ashlar: metaOf(app.materials, 'stone.ashlar'), rough: metaOf(app.materials, 'stone.rough') };
  if (B === Bsync) job.iter = null;
  // step through the lots; one step is a small piece of a lot (a face, a few openings...)
  while (job.iter || job.next < job.lots.length) {
    if (!job.iter) { const lot = job.lots[job.next++]; job.iter = lotSteps(B, lot, endsOf(app, lot), DETAIL[lotLod(lot, job.lod)], metas); }
    const ts = performance.now();
    if (job.iter.next().done) job.iter = null;
    buildings.stats.stepMs = Math.max(buildings.stats.stepMs * 0.995, performance.now() - ts);
    if (performance.now() - t0 > budgetMs) break;
  }
  if (job.iter || job.next < job.lots.length) return;
  const box = new THREE.Box3();
  for (const sk of B.sinks.values()) if (sk.vc) sk.bounds(box);
  job.result = { parts: B.finish(), box };
  job.done = true;
  if (active === job) active = null;
}

function evict(app, sCam) {
  for (const [k, j] of jobs) {
    const d = app.route.delta(sCam, j.s);
    if (d < -VIEW_BEHIND - CHUNK_LEN * 2 || d > FAR_AHEAD + CHUNK_LEN * 3) {
      jobs.delete(k);
      if (active === j) active = null;
    }
  }
}

// ------------------------------------------------------------------ side-street backdrops

/**
 * A building across the far end of every side street, facing back towards the main
 * street, so looking down a side street ends on a facade instead of the sky. These are
 * buildings-only pseudo-lots (same plan generator, frame conventions as layout lots).
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
      const width = c.width + 14;
      const nDir = dirOut.clone().negate();
      const uDir = new THREE.Vector3().crossVectors(up, nDir).normalize(); // uDir × up = nDir
      const centre = start.clone().addScaledVector(dirOut, dist);
      const origin = new THREE.Vector3(centre.x - uDir.x * width / 2, start.y, centre.z - uDir.z * width / 2);
      const matrix = new THREE.Matrix4().makeBasis(uDir, up, nDir).setPosition(origin);
      const frame = { origin, uDir, nDir, up: up.clone(), width, ground0: start.y, ground1: start.y, floorRef: start.y, matrix };
      const id = `E${Math.round(c.s)}_${side}`;
      const lot = { id, side, cross: c, edge: 0, x0: dist, x1: dist, len: width, seed: hashStr(id + ':backdrop'), depth: 14, sideStreet: true, backdrop: true, frame, s0: c.s, s1: c.s, cornerU0: false, cornerU1: false };
      const idx = layout.chunkIndex(c.s);
      if (!backdrops.has(idx)) backdrops.set(idx, []);
      backdrops.get(idx).push(lot);
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

function indexEnds(layout) {
  endIndex = new Map();
  for (const lot of [...layout.lots, ...layout.sideLots, ...[...backdrops.values()].flat()]) {
    endPoints(lot).forEach((p, e) => {
      const k = `${Math.round(p.x)},${Math.round(p.z)}`;
      if (!endIndex.has(k)) endIndex.set(k, []);
      endIndex.get(k).push({ lot, e, p });
    });
  }
}

/** Neighbour description at both ends of a lot, in its facade frame (lazy, cached). */
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
    let best = null, bestD = 0.9;
    const cx = Math.round(p.x), cz = Math.round(p.z);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const it of endIndex.get(`${cx + dx},${cz + dz}`) || []) {
        if (it.lot === lot) continue;
        const d = Math.hypot(it.p.x - p.x, it.p.z - p.z);
        if (d < bestD) { bestD = d; best = it; }
      }
    }
    if (!best) return { corner: false, nb: null };
    const nb = best.lot, np = facadePlan(nb);
    const dw = (best.p.x - p.x) * f.nDir.x + (best.p.z - p.z) * f.nDir.z;
    const nbTopWorld = nb.frame.floorRef + (np.roof.type === 'tile' ? np.parapet.y : np.totalHeight);
    return { corner: false, nb: nb.id, dw, nbTop: nbTopWorld - f.floorRef, nbDepth: np.depth };
  });
  ends.set(lot.id, r);
  return r;
}
