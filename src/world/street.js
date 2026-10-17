import * as THREE from 'three';
import { Surface } from './street/surface.js';
import { buildPaving, buildSlab, inCrossoverZone } from './street/paving.js';
import { railLinePoints } from './street/rails.js';
import { buildMainRails } from './street/track.js';
import { createLineMaterial, LineBuf, LINE_SHARED, LINE_STYLE } from './street/lines.js';
import { BufSet } from './street/meshbuf.js';
import { MAIN_RAILS } from './street/constants.js';
import { CHUNK_LEN, VIEW_AHEAD, VIEW_BEHIND } from '../core/config.js';
import { buildCrossover, crossoverPlan } from './street/crossover.js';
import { buildCrossStreet, buildCorridorCrossing, sideColumns, tactileSlab } from './street/crossStreets.js';
import { createDetailMaterials } from './street/textures.js';
import { planDetails, buildDetails } from './street/details.js';
import { createMortarMaterial, patchCanyon, patchCut } from './street/shading.js';

// Rail steel: every steel face of the profile (polished running band, flange-polished
// gauge corner, dusty guard lip, oxidised field bevel) is the library rail.head, whose
// texture carries each finish on its own band of v (see constants.js RAIL_PROFILE); the
// flangeway is rail.groove. Both take vertex colours: the swept profile writes its cavity
// AO there. The baked micro relief is toned down (normalScale): at grazing angles it
// turned the sky reflection into a sparkle of specks rather than a satin sheen.
const RAIL_HEAD = { normalScale: [0.35, 0.35], vertexColors: true };
const RAIL_GROOVE = { vertexColors: true };

const PREFETCH_MS = 0.5;   // planning ahead, per frame

// Street surface and embedded tram track. Builds per chunk:
//   paving (corridor, edge bands, gutters, sidewalks) with camber / unevenness / grime,
//   3D grooved rails (lod 0), far-field anti-aliased rail and paint lines (all lods),
//   crossovers, cross streets, cast-iron details, markings, and a ground slab.
// Exposes heightAt(s, d) so other modules can stand things on the real paving.

const street = {
  name: 'street',

  async init(app) {
    const M = app.materials;
    const surface = new Surface(app.route, app.layout);
    const lines = M.register('street.line', createLineMaterial());
    const details = createDetailMaterials(app.renderer);
    for (const m of Object.values(details)) M.register(m.name, m);
    // Plain rails and mortar carry the crossover cut test too, inactive (no cut
    // attribute: see shading.js patchCut), so they share their programs with the cut
    // variants of crossover chunks.
    const share = (m) => patchCut(m, 'rail', false);
    const mortar = M.register('street.mortar', share(createMortarMaterial()));
    // rail steel reflects the street canyon, not open sky (see shading.js)
    const steel = (name, opts) => patchCanyon(M.get(name, opts));
    const mats = {
      corr: M.get('paving.street', { vertexColors: true }),
      band: M.get('paving.band', { vertexColors: true }),
      walk: M.get('paving.sidewalk', { vertexColors: true }),
      kerb: M.get('paving.band', { vertexColors: true }),
      asphalt: M.get('asphalt', { vertexColors: true }),
      grout: mortar,
      tactile: M.get('paving.tactile', { vertexColors: true }),
      rail: { head: share(steel('rail.head', RAIL_HEAD)), groove: share(M.get('rail.groove', RAIL_GROOVE)), seal: mortar },
      lines,
      details,
    };
    mats.rail.gauge = mats.rail.lip = mats.rail.side = mats.rail.head;
    // crossover variants of the same materials: they discard the fragments that lie in
    // another rail's opening (frog flangeways, switch boxes; see crossover.js)
    const cut = (m, mode = 'rail') => patchCut(m, mode);
    const mortarCut = M.register('street.mortar.cut', cut(createMortarMaterial()));
    mortarCut.name = 'street.mortar.cut';
    mats.cut = {
      head: cut(steel('rail.head', { ...RAIL_HEAD, stCut: 1 })),
      groove: cut(M.get('rail.groove', { ...RAIL_GROOVE, stCut: 1 })),
      seal: mortarCut,
      mortar: mortarCut,
      corr: cut(M.get('paving.street', { vertexColors: true, stCut: 2 }), 'pave'),
      // cast floor of switch boxes and frogs (never cut), pushed behind the groove floors
      floor: share(M.get('rail.groove', { ...RAIL_GROOVE, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 })),
    };
    mats.cut.gauge = mats.cut.lip = mats.cut.side = mats.cut.head;
    mats.cut.check = mats.cut.head;   // check rails: guard lip polished by wheel backs
    // diverging rails: their swept mortar strips lie over the paving (see rails.js)
    const mortarDiv = M.register('street.mortar.div', cut(createMortarMaterial()));
    Object.assign(mortarDiv, { name: 'street.mortar.div', polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    mats.cutDiv = { ...mats.cut, mortar: mortarDiv };
    this.surface = surface;
    this.ctx = { app, route: app.route, layout: app.layout, surface, mats, zonePad: 1.5, delta: surface.dl };
    // detail plans are per chunk index and also flatten the paving under covers
    const plans = this.plans = new Map();
    this.planFor = (ci) => {
      let p = plans.get(ci);
      if (!p) {
        p = planDetails(this.ctx, ci);
        if (plans.size > 96) plans.delete(plans.keys().next().value);
        plans.set(ci, p);
      }
      return p;
    };
    surface.planner = (ci) => this.planFor(ci).spots;

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

  build(chunk) {
    const ctx = this.ctx;
    const T = this.timing ? [performance.now()] : null;   // phase timings (debug only)
    const mark = T ? (k) => { const t = performance.now(); this.timing[k] = (this.timing[k] || 0) + t - T[0]; T[0] = t; } : () => {};
    const group = new THREE.Group();
    group.name = 'street';
    ctx.surface.focus(chunk.s0, chunk.s1);
    const rows = makeRows(ctx, chunk);
    const bufs = new BufSet();
    mark('rows');
    const samples = buildPaving(ctx, chunk, rows, bufs);
    buildSlab(ctx, chunk, bufs);
    mark('paving');

    // 3D main rails (through crossovers too)
    if (chunk.lod === 0) buildMainRails(ctx, chunk, rows, samples, bufs);
    mark('rails3d');
    // line overlays (one mesh): rails (far-field AA), paint, joints
    const LB = (this.lineBuf || (this.lineBuf = new LineBuf())).reset();
    const L = {
      rail: LB.style(chunk.lod === 0 ? LINE_STYLE.railNear : LINE_STYLE.railFar),
      centre: LB.style(LINE_STYLE.centre), stripe: LB.style(LINE_STYLE.stripe), joint: LB.style(LINE_STYLE.joint),
    };
    // crossovers overlapping the chunk (each builds only its part inside the chunk)
    for (const c of ctx.surface.near.xo) buildCrossover(ctx, c, chunk, bufs, L.rail);
    for (const c of ctx.layout.inChunk('crossStreets', chunk.index)) {
      for (const side of c.side === 0 ? [-1, 1] : [c.side]) buildCrossStreet(ctx, c, side, chunk, bufs, L);
      buildCorridorCrossing(ctx, c, chunk, bufs, L);
    }
    if (chunk.lod === 0) {
      buildPlatformTactile(ctx, chunk, bufs);
      buildDetails(ctx, chunk, this.planFor(chunk.index), bufs, L.joint, samples.grid);
    }
    mark('special');
    bufs.build(group, 'street');
    mark('meshes');

    for (const rl of MAIN_RAILS) {
      const pts = samples.map((S) => ({ px: S.px + S.rx * rl.c, py: S.py, pz: S.pz + S.rz * rl.c, rx: S.rx, rz: S.rz, u: S.u }));
      const [arr, half, cOff] = railLinePoints(pts, rl.g);
      L.rail.add(arr, half, cOff);
    }

    // worn centre line between the tracks (interrupted at crossovers, crossings and any
    // cover lying on it)
    let run = [];
    const flush = () => { if (run.length > 6 * 3) L.centre.add(run, 0.055, 0); run = []; };
    const crossings = ctx.layout.crossStreets.filter((c) => Math.abs(ctx.delta(c.s, (chunk.s0 + chunk.s1) / 2)) < 30);
    const onLine = chunk.lod === 0 ? this.planFor(chunk.index).items.filter((it) => Math.abs(it.d) < it.r + 0.1) : [];
    for (const S of samples) {
      if (inCrossoverZone(ctx, S.s) || crossings.some((c) => Math.abs(ctx.delta(c.s, S.s)) < 2.6)
        || onLine.some((it) => Math.abs(ctx.delta(it.s, S.s)) < it.r + 0.15)) { flush(); continue; }
      run.push(S.px, S.py + ctx.surface.height(S.ri, 0), S.pz, S.rx, S.rz, S.u);
    }
    flush();

    if (!LB.empty) group.add(LB.mesh(ctx.mats.lines, 'street:lines'));
    mark('lines');
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

  /** Plan ahead, within PREFETCH_MS a frame, what chunk builds would otherwise compute
   *  first: the detail plans of every chunk in view range (builds read their
   *  neighbours' too) and the plans of the crossovers in it. */
  prefetch(app) {
    const L = this.ctx.layout, n = L.nChunks, plans = this.plans;
    const c0 = L.chunkIndex((app.cameraS ?? app.startS) - VIEW_BEHIND);
    const nAhead = Math.ceil((VIEW_BEHIND + VIEW_AHEAD) / CHUNK_LEN) + 2;
    const t0 = performance.now();
    for (let k = 0; k < nAhead && performance.now() - t0 < PREFETCH_MS; k++) {
      const ci = (c0 + k) % n;
      if (plans.has(ci)) continue;
      this.planFor(ci);
      for (const c of L.inChunk('crossovers', ci)) crossoverPlan(c, this.ctx.delta);
    }
  },
};

/** Row positions (route s) for a chunk: regular steps plus exact rows at crossover
 *  crossover zone ends, switch toes and cross-street mouth edges. */
function makeRows(ctx, chunk) {
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
  return densify(ctx, chunk, all.filter((s, i) => i === 0 || s - all[i - 1] > 0.02));
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
