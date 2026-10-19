import * as THREE from 'three';
import { Surface } from './street/surface.js';
import { buildPaving, buildSlab, inCrossoverZone, pavingHeight } from './street/paving.js';
import { railLinePoints } from './street/rails.js';
import { buildMainRails } from './street/track.js';
import { createLineMaterial, LineBuf, LINE_SHARED, LINE_STYLE } from './street/lines.js';
import { BufSet } from './street/meshbuf.js';
import { MAIN_RAILS, pavingTones, TRACK_OFFSET } from './street/constants.js';
import { CHUNK_LEN, VIEW_AHEAD, VIEW_BEHIND, LOD0_DIST } from '../core/config.js';
import { buildCrossover, crossoverPlan } from './street/crossover.js';
import { buildCrossStreet, buildCorridorCrossing, sideColumns, sideHeight, sideProfile, sideWear, tactileSlab } from './street/crossStreets.js';
import { createDetailMaterials } from './street/textures.js';
import { planDetails, planSteps, buildDetails } from './street/details.js';
import { createMortarMaterial, patchRailSheen, patchCut, patchGrit, RAIL_HEAD_ENV } from './street/shading.js';
import { RELAY_EDGE } from './street/surface.js';

// Rail steel: every steel face of the profile (polished running band, flange-polished
// gauge corner, dusty guard lip, oxidised field bevel) is the library rail.head, whose
// texture carries each finish on its own band of v (see constants.js RAIL_PROFILE); the
// flangeway is rail.groove, its floor filled with grit (shading.js patchGrit). Both take
// vertex colours: the swept profile writes its cavity AO there. The baked micro relief
// is toned down (normalScale): at grazing angles it turned the sky reflection into a
// sparkle of specks rather than a satin sheen.
const RAIL_HEAD = { normalScale: [0.35, 0.35], vertexColors: true };
const RAIL_GROOVE = { vertexColors: true };

const PREFETCH_MS = 0.6;   // planning and building ahead, per frame
const LEAD = 48;           // chunks are built ahead this many metres before the streamer needs them
const MAX_JOBS = 6;

// Street surface and embedded tram track. Builds per chunk:
//   paving (corridor, edge bands, gutters, sidewalks) with camber / unevenness / grime,
//   3D grooved rails (lod 0), far-field anti-aliased rail lines (all lods),
//   crossovers, cross streets, cast-iron details, markings, and a ground slab.
// A build is a sequence of short steps (a generator), so the chunks the streamer will
// ask for next are built ahead a slice per frame (prefetch) and build() hands them over.
// Exposes heightAt(s, d) so other modules can stand things on the real paving, and the
// side streets' mouth frames and paving heights (mouth(c, side), sideHeightAt(c, side, a, x)).

const street = {
  name: 'street',

  async init(app) {
    const M = app.materials;
    const surface = new Surface(app.route, app.layout);
    // tones that follow the setts' albedo (mortar, seals, groove grit, far-rail overlay)
    const tones = pavingTones(M.meta && M.meta['paving.street'] && M.meta['paving.street'].albedo);
    const lines = M.register('street.line', createLineMaterial(tones));
    const details = createDetailMaterials(app.renderer);
    for (const m of Object.values(details)) M.register(m.name, m);
    // Plain rails and mortar carry the crossover cut test too, inactive (no cut
    // attribute: see shading.js patchCut), so they share their programs with the cut
    // variants of crossover chunks.
    const share = (m) => patchCut(m, 'rail', false);
    const mortar = M.register('street.mortar', share(createMortarMaterial(tones.mortar)));
    // rail steel: lengthwise-polish sheen (see shading.js); the environment map holds
    // the street canyon, so the steel reflects it at RAIL_HEAD_ENV (matched to the
    // far-field line overlay and the photographs)
    const steel = (name, opts) => {
      const m = patchRailSheen(M.get(name, opts));
      m.envMapIntensity = RAIL_HEAD_ENV;
      return m;
    };
    const groove = (opts) => patchGrit(M.get('rail.groove', opts), tones.k);
    const mats = {
      corr: M.get('paving.street', { vertexColors: true }),
      band: M.get('paving.band', { vertexColors: true }),
      walk: M.get('paving.sidewalk', { vertexColors: true }),
      asphalt: M.get('asphalt', { vertexColors: true }),
      grout: mortar,
      tactile: M.get('paving.tactile', { vertexColors: true }),
      rail: { head: share(steel('rail.head', RAIL_HEAD)), groove: share(groove(RAIL_GROOVE)), seal: mortar },
      lines,
      details,
    };
    mats.kerb = mats.band;
    mats.rail.gauge = mats.rail.lip = mats.rail.side = mats.rail.head;
    // crossover variants of the same materials: they discard the fragments that lie in
    // another rail's opening (frog flangeways, switch boxes; see crossover.js)
    const cut = (m, mode = 'rail') => patchCut(m, mode);
    const mortarCut = M.register('street.mortar.cut', cut(createMortarMaterial(tones.mortar)));
    mortarCut.name = 'street.mortar.cut';
    mats.cut = {
      head: cut(steel('rail.head', { ...RAIL_HEAD, stCut: 1 })),
      groove: cut(groove({ ...RAIL_GROOVE, stCut: 1 })),
      seal: mortarCut,
      mortar: mortarCut,
      corr: cut(M.get('paving.street', { vertexColors: true, stCut: 2 }), 'pave'),
      // cast floor of switch boxes and frogs (never cut), pushed behind the groove floors
      floor: share(groove({ ...RAIL_GROOVE, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 })),
    };
    mats.cut.gauge = mats.cut.lip = mats.cut.side = mats.cut.head;
    mats.cut.check = mats.cut.head;   // check rails: guard lip polished by wheel backs
    // diverging rails: their swept mortar strips lie over the paving (see rails.js)
    const mortarDiv = M.register('street.mortar.div', cut(createMortarMaterial(tones.mortar)));
    Object.assign(mortarDiv, { name: 'street.mortar.div', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    mats.cutDiv = { ...mats.cut, mortar: mortarDiv };
    this.surface = surface;
    this.tones = tones;
    this.ctx = { app, route: app.route, layout: app.layout, surface, mats, zonePad: 1.5, delta: surface.dl };
    this.jobs = [];            // builds in progress (see prefetch), at most MAX_JOBS
    this.linePool = [];        // LineBuf scratch, one per build in progress
    // detail plans are per chunk index and also flatten the paving under covers; the
    // prefetch makes them ahead a step at a time (planJob: the plan in progress)
    const plans = this.plans = new Map();
    this.planJob = null;
    this.planFor = (ci) => {
      let p = plans.get(ci);
      if (!p) {
        const j = this.planJob;
        if (j && j.ci === ci && !j.running) {
          // finish the one in progress (a generator cannot be restarted); it keeps its
          // detail plan as soon as it has it
          this.planJob = null;
          j.running = true;
          let r = j.it.next();
          while (!r.done) r = j.it.next();
          p = plans.get(ci);
        }
        if (!p) {
          p = planDetails(this.ctx, ci);
          this._keepPlan(ci, p);
        }
      }
      return p;
    };
    surface.planner = (ci) => this.planFor(ci);

    // Warm-up: build representative chunks (plain, crossover, cross street, station;
    // both lods) so streamed chunks never pay first-call JIT costs. The lod 0 ones stay
    // in the scene, far below it (always culled), until the first frames, so the
    // start-up shader compile covers every street program, including those first
    // needed when a crossover or a platform comes close (otherwise a long stall
    // mid-ride: compiling at run time blocks the frame on this driver).
    const L = app.layout;
    const warm = [0, L.crossovers[0]?.s0, L.crossStreets[0]?.s, L.stations[0]?.s].filter((x) => x !== undefined).map((x) => L.chunkIndex(x));
    this.warm = new THREE.Group();
    this.warm.name = 'street:warm';
    this.warm.position.y = -1e4;
    for (const idx of new Set(warm)) {
      for (const lod of [0, 1]) {
        const s0 = idx * CHUNK_LEN;
        const g = this.build({ index: idx, s0, s1: Math.min(app.route.length, s0 + CHUNK_LEN), lod });
        if (lod === 0) this.warm.add(g);
        else g.traverse((o) => o.geometry && o.geometry.dispose());
      }
    }
    this.warm.updateMatrixWorld(true);
    app.scene.add(this.warm);
  },

  /** Paving height above the route elevation at (s, d) (metres). */
  heightAt(s, d) { return this.surface ? this.surface.heightAt(s, d) : 0; },

  /** The frame of cross street c's mouth (c: a layout.crossStreets entry) on `side`
   *  (±1; both sides when c.side is 0), shared and cached (read only):
   *  {c, side, start, along, dirOut, len, hw, half, road, sw, kerbH, rampX, level}.
   *  A point at mouth coordinates (a, x) lies at start + along·a + dirOut·x: a across the
   *  side street from its centre line (+ along route travel; the mouth spans
   *  |a| < half = c.width / 2), x out from the main facade line (up the side street, to
   *  len). start, along and dirOut are horizontal vectors (start on the ground). The
   *  carriageway is |a| < road, a kerb (kerbH) below the sidewalks (sw wide) from a few
   *  metres out; the side street ramps from the main paving at the mouth (x = 0) to the
   *  ground its lots stand on (level: world y at a = -half and a = +half) over rampX
   *  metres. Null before init. */
  mouth(c, side) {
    if (!this.ctx) return null;
    sideProfile(this.ctx, c, side);
    return this.ctx.surface.mouth(c, side);
  },

  /** World y of the paving of cross street c's side street on `side` at mouth
   *  coordinates (a, x) (see mouth()): the surface the street mesh is built from
   *  (sidewalks, kerbs and the crowned carriageway; x <= 0 gives the main paving along
   *  the mouth line). Allocation-free once the mouth is cached. */
  sideHeightAt(c, side, a, x) {
    return this.ctx ? sideHeight(this.ctx, c, side, a, x) : 0;
  },

  _keepPlan(ci, p) {
    const plans = this.plans;
    if (plans.size > 96) plans.delete(plans.keys().next().value);
    plans.set(ci, p);
  },

  /** The street of a chunk. Chunks the streamer is about to ask for are usually built
   *  already, a slice per frame (see prefetch); otherwise all steps run now. */
  build(chunk) {
    const jobs = this.jobs;
    let job = null;
    for (let i = 0; i < jobs.length; i++) {
      const c = jobs[i].chunk;
      if (c.index === chunk.index && c.lod === chunk.lod) { job = jobs[i]; jobs.splice(i, 1); break; }
    }
    if (!job) job = this.startJob(chunk);
    while (!this.stepJob(job));
    return job.group;
  },

  startJob(chunk) {
    const c = { index: chunk.index, s0: chunk.s0, s1: chunk.s1, lod: chunk.lod };
    const job = { chunk: c, bufs: new BufSet(), lines: this.linePool.pop() || new LineBuf(), group: null };
    job.it = this.steps(c, job);
    return job;
  },

  /** Run the next step of a job (true once it has its group). Each step re-focuses the
   *  surface on the job's chunk, since other builds may run between its steps. */
  stepJob(job) {
    if (job.group) return true;
    const t0 = this.timing ? performance.now() : 0;
    this.ctx.surface.focus(job.chunk.s0, job.chunk.s1);
    const r = job.it.next();
    if (this.timing) {
      const k = r.done ? 'meshes' : r.value;
      this.timing[k] = (this.timing[k] || 0) + performance.now() - t0;
    }
    if (!r.done) return false;
    job.group = r.value;
    this.linePool.push(job.lines.reset());
    job.lines = null;
    return true;
  },

  /** Drop a pre-built job the streamer never asked for. */
  dropJob(job) {
    if (job.group) job.group.traverse((o) => o.geometry && o.geometry.dispose());
    else { job.it.return(); job.bufs.release(); this.linePool.push(job.lines.reset()); }
  },

  /** The build as a sequence of steps of well under a millisecond each (it yields the
   *  phase just done, for the debug timings); returns the chunk's group. */
  *steps(chunk, { bufs, lines: LB }) {
    const ctx = this.ctx;
    const rows = makeRows(ctx, chunk, this.planFor(chunk.index));
    yield 'rows';
    const samples = yield* buildPaving(ctx, chunk, rows, bufs);
    buildSlab(ctx, chunk, bufs);
    yield 'paving';

    // 3D main rails (through crossovers too)
    if (chunk.lod === 0) yield* buildMainRails(ctx, chunk, rows, samples, bufs);
    // line overlays (one mesh): rails (far-field AA), paint, joints
    const L = {
      rail: LB.style(chunk.lod === 0 ? LINE_STYLE.railNear : LINE_STYLE.railFar),
      stripe: LB.style(LINE_STYLE.stripe), joint: LB.style(LINE_STYLE.joint),
      seal: LB.style(LINE_STYLE.seal), patch: LB.style(LINE_STYLE.patch), polish: LB.style(LINE_STYLE.polish),
      repair: LB.style(LINE_STYLE.repair), drip: LB.style(LINE_STYLE.drip),
    };
    // drip bands along the middle of both tracks (under the paint and joints)
    buildDripBands(ctx, chunk, samples, L.drip);
    // crossovers overlapping the chunk (each builds only its part inside the chunk)
    for (const c of ctx.surface.near.xo) yield* buildCrossover(ctx, c, chunk, bufs, L.rail);
    for (const c of ctx.layout.inChunk('crossStreets', chunk.index)) {
      if (c.side !== 1) { yield* buildCrossStreet(ctx, c, -1, chunk, bufs, L); yield 'cross'; }
      if (c.side !== -1) { yield* buildCrossStreet(ctx, c, 1, chunk, bufs, L); yield 'cross'; }
      buildCorridorCrossing(ctx, c, chunk, bufs, L);
    }
    if (chunk.lod === 0) {
      buildPlatformTactile(ctx, chunk, bufs);
      yield 'details';
      yield* buildDetails(ctx, chunk, this.planFor(chunk.index), bufs, L, samples.grid);
    }

    for (const rl of MAIN_RAILS) {
      const pts = samples.map((S) => ({ px: S.px + S.rx * rl.c, py: S.py, pz: S.pz + S.rz * rl.c, rx: S.rx, rz: S.rz, u: S.u }));
      const [arr, half, cOff] = railLinePoints(pts, rl.g);
      L.rail.add(arr, half, cOff);
    }

    // (no painted centre line between the tracks: the setts run through, as in the
    // photographs; transverse joints are drawn with the details)
    yield 'lines';

    const group = new THREE.Group();
    group.name = 'street';
    // a step per few thousand vertices of meshes
    let nv = 0;
    for (const n of bufs.meshes(group, 'street')) {
      if ((nv += n) > 6000) { nv = 0; yield 'meshes'; }
    }
    if (!LB.empty) group.add(LB.mesh(ctx.mats.lines, 'street:lines'));
    return group;
  },

  update(dt, app) {
    app.renderer.getDrawingBufferSize(LINE_SHARED.uViewport.value);
    this.prefetch(app);
    if (this.warm && app.frame > 3) {
      app.scene.remove(this.warm);
      this.warm.traverse((o) => o.geometry && o.geometry.dispose());
      this.warm = null;
    }
  },

  /** Work ahead, within PREFETCH_MS a frame, in units of well under a millisecond (or
   *  two at most): first plan what chunk builds would otherwise compute first (the detail
   *  plans of every chunk in view range, which builds read for their neighbours too, and
   *  the plans of the crossovers in it; see planSteps), then build, step by step, the
   *  chunks the streamer will ask for next: lod 0 rebuilds about to come within LOD0_DIST
   *  and new lod 1 chunks about to come within VIEW_AHEAD (the streamer's chunk
   *  distances). Its build() then only hands the group over. Allocates nothing per frame
   *  beyond the work itself. */
  prefetch(app) {
    const sCam = app.cameraS ?? app.startS;
    const t0 = performance.now();
    // plans: a step at a time, within half the budget
    while (performance.now() - t0 < PREFETCH_MS * 0.5) {
      let j = this.planJob;
      if (!j) {
        const ci = this._unplanned(sCam);
        if (ci < 0) break;
        j = this.planJob = { ci, it: planChunk(this, ci), running: false };
      }
      j.running = true;
      const r = j.it.next();
      j.running = false;
      if (r.done && this.planJob === j) this.planJob = null;
    }

    this._ahead(sCam, LOD0_DIST, LOD0_DIST + LEAD, 0);
    this._ahead(sCam, VIEW_AHEAD + 1e-6, VIEW_AHEAD + LEAD, 1);
    // forget jobs whose chunk the streamer has long since built (or will not want)
    const jobs = this.jobs, dl = this.ctx.delta;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const dist = dl(sCam, job.chunk.s0), edge = job.chunk.lod === 0 ? LOD0_DIST : VIEW_AHEAD;
      if (dist < edge - 2 * CHUNK_LEN || dist > edge + LEAD + 2 * CHUNK_LEN || jobs.length > MAX_JOBS) {
        this.dropJob(job);
        jobs.splice(i--, 1);
      }
    }
    // nearest first: a step a frame, more while well inside the budget (a step takes
    // 0.1-1 ms)
    let next = null;
    do {
      next = null;
      let best = Infinity;
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (job.group) continue;
        const dist = dl(sCam, job.chunk.s0);
        if (dist < best) { best = dist; next = job; }
      }
      if (next) this.stepJob(next);
    } while (next && performance.now() - t0 < PREFETCH_MS * 0.5);
  },

  /** First chunk in view range (from VIEW_BEHIND behind the camera on, to a few chunks
   *  beyond the farthest prefetched build, whose rows read their neighbours' plans and
   *  whose side streets are planned two chunks on) without a detail plan, or -1. */
  _unplanned(sCam) {
    const L = this.ctx.layout, n = L.nChunks;
    const c0 = L.chunkIndex(sCam - VIEW_BEHIND);
    const nAhead = Math.ceil((VIEW_BEHIND + VIEW_AHEAD + LEAD) / CHUNK_LEN) + 4;
    for (let k = 0; k < nAhead; k++) {
      const ci = (c0 + k) % n;
      if (!this.plans.has(ci)) return ci;
    }
    return -1;
  },

  /** Start builds of the chunks of `lod` whose start lies [lo, hi) metres ahead. */
  _ahead(sCam, lo, hi, lod) {
    const n = this.ctx.layout.nChunks, len = this.ctx.route.length, jobs = this.jobs;
    const i1 = Math.floor((sCam + hi) / CHUNK_LEN) + 1;
    for (let i = Math.floor((sCam + lo) / CHUNK_LEN); i <= i1; i++) {
      const dist = i * CHUNK_LEN - sCam;
      if (dist < lo || dist >= hi) continue;
      const index = ((i % n) + n) % n;
      let have = false;
      for (let k = 0; k < jobs.length; k++) if (jobs[k].chunk.index === index && jobs[k].chunk.lod === lod) { have = true; break; }
      if (have) continue;
      const s0 = index * CHUNK_LEN;
      jobs.push(this.startJob({ index, s0, s1: Math.min(len, s0 + CHUNK_LEN), lod }));
    }
  },
};

/** The detail plan of chunk ci (kept in street.plans as soon as it is made), then the
 *  plans of the crossovers starting in it and the mouth profiles and wear plans of the
 *  side streets two chunks back (their paving heights read the detail plans of the
 *  chunks round them, planned by now), as short steps (see planSteps). */
function* planChunk(street, ci) {
  const ctx = street.ctx;
  const p = yield* planSteps(ctx, ci);
  // kept now: the side-street steps below read the paving round them (this chunk too)
  if (!street.plans.has(ci)) street._keepPlan(ci, p);
  for (const c of ctx.layout.inChunk('crossovers', ci)) {
    yield 'plan';
    crossoverPlan(c, ctx.delta);
  }
  for (const c of ctx.layout.inChunk('crossStreets', ci - 2)) {
    for (let side = -1; side <= 1; side += 2) {
      if (c.side === -side) continue;
      yield 'plan';
      sideProfile(ctx, c, side);
      yield 'plan';
      sideWear(ctx, c, side);
    }
  }
  return p;
}

/** Row positions (route s) for a chunk: regular steps plus exact rows at crossover
 *  zone ends, switch toes, cross-street mouth edges and the ends of relaid setts (a pair
 *  of rows RELAY_EDGE apart on each end: the tone changes between them, see wear.js). */
function makeRows(ctx, chunk, plan) {
  const { route, layout } = ctx;
  const s0 = chunk.s0, s1 = chunk.s1, len = s1 - s0;
  let kmax = 0;
  for (let s = s0; s <= s1; s += 4) kmax = Math.max(kmax, Math.abs(route.curvature(s)));
  const step = chunk.lod === 0 ? (kmax > 1 / 300 ? 1.0 : 1.25) : kmax > 1 / 300 ? 2 : 4;
  const n = Math.max(2, Math.ceil(len / step));
  const base = [];
  for (let i = 0; i <= n; i++) base.push(s0 + (len * i) / n);
  const extra = [];
  const addAt = (e) => {
    const l = ctx.delta(s0, e);
    if (l > 0.05 && l < len - 0.05) extra.push(s0 + l);
  };
  // crossover zone ends and switch toes
  for (const c of layout.crossovers) { addAt(c.s0 - ctx.zonePad); addAt(c.s0); addAt(c.s1); addAt(c.s1 + ctx.zonePad); }
  const relayRows = [];
  for (const r of plan.relays || []) {
    relayRows.push(r.s0, r.s0 + RELAY_EDGE, r.s1 - RELAY_EDGE, r.s1);
    for (const e of relayRows.slice(-4)) addAt(e);
  }
  const mouths = [];
  for (const c of layout.crossStreets) {
    if (Math.abs(ctx.delta(c.s, (s0 + s1) / 2)) > len / 2 + c.width) continue;
    for (const a of sideColumns(c)) addAt(c.s + a);
    mouths.push(c);
  }
  if (!extra.length) return densify(ctx, chunk, base);
  // inside a mouth the side-street columns are the rows; elsewhere keep the regular ones
  const inMouth = (s) => mouths.some((c) => Math.abs(ctx.delta(c.s, s)) < c.width / 2 - 0.05);
  const all = base.filter((s) => s === s0 || s === s1 || (!inMouth(s) && !extra.some((e) => Math.abs(e - s) < 0.3)));
  for (const e of extra) all.push(e);
  all.sort((a, b) => a - b);
  // (relay edge pairs stay; other rows closer than 2 cm merge)
  const keep = (s) => relayRows.some((e) => Math.abs(e - s) < 1e-6);
  return densify(ctx, chunk, all.filter((s, i) => i === 0 || s - all[i - 1] > 0.02 || (keep(s) && s - all[i - 1] > RELAY_EDGE * 0.5)));
}

/** Dense rows (<= 0.75 m) where crossover rails curve, at lod 0: the cut attributes
 *  are interpolated between rows and must follow the curved diverging rails to about a
 *  millimetre (their mortar overlaps the paving's cut by 2 mm). Along the straight
 *  middle of a crossover the interpolation is exact. */
function densify(ctx, chunk, out) {
  if (chunk.lod > 0) return out;
  const curved = (s) => {
    const c = inCrossoverZone(ctx, s);
    if (!c) return false;
    const p = crossoverPlan(c, ctx.delta), x = ctx.delta(c.s0, s);
    return x < p.arc + 1 || x > p.L - p.arc - 1;
  };
  const dense = [out[0]];
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    if (curved((a + b) / 2)) {
      const n = Math.ceil((b - a) / 0.75 - 1e-6);
      for (let k = 1; k < n; k++) dense.push(a + ((b - a) * k) / n);
    }
    dense.push(b);
  }
  return dense;
}

/** The drip band along the middle of each track (lines.js LINE_STYLE.drip), at both
 *  lods: light and patchy along the line, heavy where the trams stand at the stops and
 *  under their bogies (Surface.stopAt), faded out through crossovers (their diverging
 *  rails cross the four-foot). Points every 2 m (4 m at lod 1) on the built paving. */
const DRIP_HALF = 0.36;
function buildDripBands(ctx, chunk, samples, out) {
  const { route, surface, layout } = ctx;
  const grid = samples.grid, dl = ctx.delta;
  const step = chunk.lod === 0 ? 2 : 4;
  const n = Math.max(1, Math.ceil((chunk.s1 - chunk.s0) / step));
  const smp = {}, w = {};
  const ks = surface.kS;
  for (const t of [-1, 1]) {
    const d = t * TRACK_OFFSET;
    const pts = new Array((n + 1) * 8);
    let any = false;
    for (let i = 0; i <= n; i++) {
      const s = chunk.s0 + ((chunk.s1 - chunk.s0) * i) / n;
      route.sample(s, smp);
      surface.stopAt(s, w);
      const sp = surface.sp(s);
      const st = t > 0 ? w.stopR : w.stopL, bg = t > 0 ? w.bogR : w.bogL;
      const nz = surface.fG.sample(sp * ks[0] + 61.3, t * 9.1 + 2.7);
      let k = 0.4 * (0.5 + 0.9 * Math.max(0, nz + 0.35)) + 0.5 * st + 0.35 * bg;
      for (const c of layout.crossovers) {
        const a = dl(c.s0 - ctx.zonePad - 1, s), b = dl(s, c.s1 + ctx.zonePad + 1);
        if (a > -3 && b > -3) k *= 1 - Math.min(1, Math.min(a + 3, b + 3) / 3);
      }
      k = Math.max(0, Math.min(1.25, k));
      if (k > 0.01) any = true;
      const o = i * 8;
      pts[o] = smp.pos.x + smp.right.x * d;
      pts[o + 1] = smp.pos.y + pavingHeight(grid, s, d, dl) + 0.0015;
      pts[o + 2] = smp.pos.z + smp.right.z * d;
      pts[o + 3] = smp.right.x; pts[o + 4] = smp.right.z; pts[o + 5] = sp; pts[o + 6] = 0; pts[o + 7] = k;
    }
    if (any) out.add(pts, DRIP_HALF, 0, 1, 8);
  }
}

/** Tactile warning strips on the sidewalk at both ends of every platform. */
function buildPlatformTactile(ctx, chunk, bufs) {
  for (const st of ctx.layout.inChunk('stations', chunk.index)) {
    for (const pl of st.platforms) {
      const a = Math.abs(pl.d0) < Math.abs(pl.d1) ? pl.d0 : pl.d1;
      const b = Math.abs(pl.d0) < Math.abs(pl.d1) ? pl.d1 : pl.d0;
      const sd = Math.sign(a + b);
      const dA = sd * (Math.abs(a) + 0.35), dB = sd * (Math.abs(b) - 0.25);
      tactileSlab(ctx, bufs, pl.s1 + 0.4, pl.s1 + 1.0, dA, dB);
      tactileSlab(ctx, bufs, pl.s0 - 1.0, pl.s0 - 0.4, dA, dB);
    }
  }
}

export default street;
