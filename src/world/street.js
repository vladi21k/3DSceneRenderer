import * as THREE from 'three';
import { Surface } from './street/surface.js';
import { buildPaving, buildSlab, inInlayZone } from './street/paving.js';
import { sweepRail, railLinePoints } from './street/rails.js';
import { createLineMaterials, LineBuf, LINE_SHARED } from './street/lines.js';
import { BufSet } from './street/meshbuf.js';
import { MAIN_RAILS } from './street/constants.js';
import { CHUNK_LEN } from '../core/config.js';
import { buildCrossover } from './street/crossover.js';
import { buildCrossStreet, buildCorridorCrossing, sideColumns, tactileSlab } from './street/crossStreets.js';
import { createDetailMaterials } from './street/textures.js';
import { planDetails, buildDetails } from './street/details.js';

// Rail steel finishes (variants of the library rail.head): the running band is polished
// but finely scratched by the wheels (roughness ~0.3); the guard lip has no wheel
// contact and stays dull, dusty steel.
const RAIL_HEAD = { roughness: 1.9 };
const RAIL_LIP = { color: [0.6, 0.56, 0.5], roughness: 2.7 };
// rust on the field-side bevel and lip edge: dark, dirty brown rather than fresh orange
const RAIL_RUST = { color: [0.62, 0.68, 0.78] };

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
    const lines = createLineMaterials();
    for (const m of Object.values(lines)) M.register(m.name, m);
    const details = createDetailMaterials(app.renderer);
    for (const m of Object.values(details)) M.register(m.name, m);
    const mats = {
      corr: M.get('paving.street', { vertexColors: true }),
      band: M.get('paving.band', { vertexColors: true }),
      walk: M.get('paving.sidewalk', { vertexColors: true }),
      slab: M.get('concrete'),
      kerb: M.get('paving.band', { vertexColors: true }),
      asphalt: M.get('asphalt', { vertexColors: true }),
      grout: M.get('asphalt', { vertexColors: true }),
      tactile: M.get('paving.tactile', { vertexColors: true }),
      rail: { head: M.get('rail.head', RAIL_HEAD), lip: M.get('rail.head', RAIL_LIP), side: M.get('rail.side', RAIL_RUST), groove: M.get('rail.groove'), seal: M.get('rubber') },
      lines,
      details,
    };
    // coplanar inlay layers for crossovers (higher layers win the depth test)
    const layer = (name, k, extra = {}) => M.get(name, { polygonOffset: true, polygonOffsetFactor: -k, polygonOffsetUnits: -2 * k, ...extra });
    mats.inlay = {
      grout: layer('asphalt', 0.5, { color: [1.5, 1.5, 1.53] }),   // mortar along diverging rails
      plate: layer('rail.head', 1, { color: [0.4, 0.39, 0.37], roughness: 3.2 }),   // dull cast steel
      seal: layer('rubber', 2),
      side: layer('rail.side', 3, RAIL_RUST),
      head: layer('rail.head', 3, RAIL_HEAD),
      lip: layer('rail.head', 3, RAIL_LIP),
      groove: layer('rail.groove', 4),
      flange: layer('rail.groove', 5),
      check: layer('rail.head', 5, RAIL_HEAD),
      tongueSide: layer('rail.side', 6, RAIL_RUST),
      tongueHead: layer('rail.head', 6, RAIL_HEAD),
    };
    this.surface = surface;
    const I = mats.inlay;
    const inlayBufs = (bufs) => {
      const main = { grout: bufs.get(I.grout), seal: bufs.get(I.seal), side: bufs.get(I.side), head: bufs.get(I.head), lip: bufs.get(I.lip), groove: bufs.get(I.groove) };
      return {
        main,
        tongue: { seal: main.seal, groove: main.groove, side: bufs.get(I.tongueSide), head: bufs.get(I.tongueHead), lip: main.lip },
        plate: bufs.get(I.plate), flange: bufs.get(I.flange), check: bufs.get(I.check),
      };
    };
    this.ctx = { app, route: app.route, layout: app.layout, surface, mats, inlayPad: 1.5, inlayBufs, delta: surface.dl };
    // detail plans are per chunk index and also flatten the paving under covers
    const plans = new Map();
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

    // JIT warm-up: build and discard representative chunks (plain, crossover, cross
    // street; both lods) so streamed chunks never pay first-call compilation costs.
    const L = app.layout;
    const warm = [0, L.chunkIndex(L.crossovers[0]?.s0 ?? 0), L.chunkIndex(L.crossStreets[0]?.s ?? 0)];
    for (const idx of warm) {
      for (const lod of [0, 1]) {
        const s0 = idx * CHUNK_LEN;
        const g = this.build({ index: idx, s0, s1: Math.min(app.route.length, s0 + CHUNK_LEN), lod });
        g.traverse((o) => o.geometry && o.geometry.dispose());
      }
    }
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

    // 3D rails outside crossover inlay zones (every other row on gentle alignments)
    if (chunk.lod === 0) {
      const kmax = Math.max(...samples.map((S) => Math.abs(S.curv)));
      const minGap = kmax < 1 / 400 ? 2.4 : kmax < 1 / 150 ? 1.2 : 0.9;
      let run = [];
      const flush = () => { if (run.length > 1) for (const rl of MAIN_RAILS) sweepRail(bufs, ctx.mats.rail, samples, run, rl.c, rl.g); run = []; };
      for (let r = 0; r < rows.length; r++) {
        const open = r < rows.length - 1 && !inInlayZone(ctx, (rows[r] + rows[r + 1]) / 2);
        const last = run.length ? rows[run[run.length - 1]] : -1e9;
        if (open || run.length) {
          // keep a row when the gap is large enough, at run ends, and at mouth / zone rows
          if (!run.length || !open || rows[r] - last >= minGap || r === rows.length - 1) run.push(r);
        }
        if (!open) flush();
      }
      flush();
    }
    mark('rails3d');
    // line overlays: rails (far-field AA), paint, joints
    const L = this.lineBufs || (this.lineBufs = { rail: new LineBuf(), centre: new LineBuf(), stripe: new LineBuf(), joint: new LineBuf() });
    for (const k in L) L[k].reset();
    for (const c of ctx.layout.inChunk('crossovers', chunk.index)) buildCrossover(ctx, c, chunk, bufs, L.rail);
    for (const c of ctx.layout.inChunk('crossStreets', chunk.index)) {
      for (const side of c.side === 0 ? [-1, 1] : [c.side]) buildCrossStreet(ctx, c, side, chunk, bufs, L);
      buildCorridorCrossing(ctx, c, chunk, bufs, L);
    }
    if (chunk.lod === 0) {
      buildPlatformTactile(ctx, chunk, bufs);
      buildDetails(ctx, chunk, this.planFor(chunk.index), bufs, L.joint);
    }
    mark('special');
    const sphere = chunkSphere(ctx, chunk);
    bufs.build(group, 'street', { sphere });
    mark('meshes');

    for (const rl of MAIN_RAILS) {
      const pts = samples.map((S) => ({ px: S.px + S.rx * rl.c, py: S.py, pz: S.pz + S.rz * rl.c, rx: S.rx, rz: S.rz, along: S.s }));
      const [arr, half, cOff] = railLinePoints(pts, rl.g);
      L.rail.add(arr, half, cOff);
    }

    // worn centre line between the tracks (interrupted at crossovers and crossings)
    let run = [];
    const flush = () => { if (run.length > 6 * 3) L.centre.add(run, 0.055, 0); run = []; };
    const crossings = ctx.layout.crossStreets.filter((c) => Math.abs(ctx.delta(c.s, (chunk.s0 + chunk.s1) / 2)) < 30);
    for (const S of samples) {
      if (inInlayZone(ctx, S.s) || crossings.some((c) => Math.abs(ctx.delta(c.s, S.s)) < 2.6)) { flush(); continue; }
      run.push(S.px, S.py + ctx.surface.height(S.ri, 0), S.pz, S.rx, S.rz, S.s);
    }
    flush();

    const lm = ctx.mats.lines;
    const lineMat = { rail: chunk.lod === 0 ? lm.railNear : lm.railFar, centre: lm.centre, stripe: lm.stripe, joint: lm.joint };
    for (const k of Object.keys(L)) if (!L[k].empty) group.add(L[k].mesh(lineMat[k], `street:${k}Lines`));
    mark('lines');
    return group;
  },

  update(dt, app) {
    app.renderer.getDrawingBufferSize(LINE_SHARED.uViewport.value);
  },
};

/** Row positions (route s) for a chunk: regular steps plus exact rows at crossover
 *  inlay zone ends and cross-street mouth edges. */
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
  for (const c of layout.crossovers) { addAt(c.s0 - ctx.inlayPad); addAt(c.s1 + ctx.inlayPad); }
  const mouths = [];
  for (const c of layout.crossStreets) {
    if (Math.abs(ctx.delta(c.s, (s0 + s1) / 2)) > len / 2 + c.width) continue;
    for (const a of sideColumns(c)) addAt(c.s + a);
    mouths.push(c);
  }
  if (!extra.length) return base;
  // inside a mouth the side-street columns are the rows; elsewhere keep the regular ones
  const inMouth = (s) => mouths.some((c) => Math.abs(ctx.delta(c.s, s)) < c.width / 2 - 0.05);
  const all = base.filter((s) => s === s0 || s === s1 || (!inMouth(s) && !extra.some((e) => Math.abs(e - s) < 0.3)));
  for (const e of extra) all.push(e);
  all.sort((a, b) => a - b);
  return all.filter((s, i) => i === 0 || s - all[i - 1] > 0.02);
}

/** Generous bounding sphere for everything a chunk builds (cross streets included). */
function chunkSphere(ctx, chunk) {
  const mid = (chunk.s0 + chunk.s1) / 2;
  const c = ctx.route.toWorld(mid, 0, 0);
  let r = (chunk.s1 - chunk.s0) / 2 + 60;
  if (ctx.layout.inChunk('crossStreets', chunk.index).length) r += 140;
  return new THREE.Sphere(c, r);
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
