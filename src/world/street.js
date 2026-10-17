import * as THREE from 'three';
import { Surface } from './street/surface.js';
import { buildPaving, buildSlab, inInlayZone } from './street/paving.js';
import { sweepRail, railLinePoints } from './street/rails.js';
import { createLineMaterials, LineBuf, LINE_SHARED } from './street/lines.js';
import { BufSet } from './street/meshbuf.js';
import { MAIN_RAILS } from './street/constants.js';

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
    const mats = {
      corr: M.get('paving.street', { vertexColors: true }),
      band: M.get('paving.band', { vertexColors: true }),
      walk: M.get('paving.sidewalk', { vertexColors: true }),
      slab: M.get('concrete'),
      rail: { head: M.get('rail.head'), lip: M.get('rail.head'), side: M.get('rail.side'), groove: M.get('rail.groove'), seal: M.get('rubber') },
      lines,
    };
    this.surface = surface;
    this.ctx = { app, route: app.route, layout: app.layout, surface, mats, inlayPad: 1.5 };
  },

  /** Paving height above the route elevation at (s, d) (metres). */
  heightAt(s, d) { return this.surface ? this.surface.heightAt(s, d) : 0; },

  build(chunk) {
    const ctx = this.ctx;
    const group = new THREE.Group();
    group.name = 'street';
    const rows = makeRows(ctx, chunk);
    const bufs = new BufSet();
    const samples = buildPaving(ctx, chunk, rows, bufs);
    buildSlab(ctx, chunk, bufs);

    // 3D rails outside crossover inlay zones
    if (chunk.lod === 0) {
      let r0 = -1;
      for (let r = 0; r < rows.length; r++) {
        const open = r < rows.length - 1 && !inInlayZone(ctx, (rows[r] + rows[r + 1]) / 2);
        if (open && r0 < 0) r0 = r;
        if (!open && r0 >= 0) {
          for (const rl of MAIN_RAILS) sweepRail(bufs, ctx.mats.rail, samples, r0, r, rl.c, rl.g);
          r0 = -1;
        }
      }
    }
    bufs.build(group, 'street');

    // far-field rail lines
    const lb = new LineBuf();
    for (const rl of MAIN_RAILS) {
      const pts = samples.map((S) => ({ px: S.px + S.rx * rl.c, py: S.py, pz: S.pz + S.rz * rl.c, rx: S.rx, rz: S.rz, along: S.s }));
      const [arr, half, cOff] = railLinePoints(pts, rl.g);
      lb.add(arr, half, cOff);
    }
    group.add(lb.mesh(chunk.lod === 0 ? ctx.mats.lines.railNear : ctx.mats.lines.railFar, 'street:railLines'));

    // centre line between the tracks
    const cl = new LineBuf();
    let run = [];
    const flush = () => { if (run.length > 6) cl.add(run, 0.055, 0); run = []; };
    for (const S of samples) {
      if (inInlayZone(ctx, S.s) || ctx.layout.isInCrossStreet(S.s, 0, 2.5) || ctx.layout.isInCrossStreet(S.s, 1, 2.5) || ctx.layout.isInCrossStreet(S.s, -1, 2.5)) { flush(); continue; }
      run.push(S.px, S.py + ctx.surface.height(S.ri, 0), S.pz, S.rx, S.rz, S.s);
    }
    flush();
    if (!cl.empty) group.add(cl.mesh(ctx.mats.lines.centre, 'street:centreLine'));
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
  const step = chunk.lod === 0 ? 1.0 : kmax > 1 / 300 ? 2 : 4;
  const n = Math.max(2, Math.ceil(len / step));
  const base = [];
  for (let i = 0; i <= n; i++) base.push(s0 + (len * i) / n);
  const extra = [];
  const addAt = (e) => {
    const l = route.delta(s0, e);
    if (l > 0.05 && l < len - 0.05) extra.push(s0 + l);
  };
  for (const c of layout.crossovers) { addAt(c.s0 - ctx.inlayPad); addAt(c.s1 + ctx.inlayPad); }
  for (const c of layout.crossStreets) {
    if (Math.abs(route.delta(c.s, (s0 + s1) / 2)) > len / 2 + c.width) continue;
    addAt(c.s - c.width / 2); addAt(c.s + c.width / 2);
  }
  if (!extra.length) return base;
  const all = base.filter((s) => s === s0 || s === s1 || !extra.some((e) => Math.abs(e - s) < 0.3));
  for (const e of extra) all.push(e);
  all.sort((a, b) => a - b);
  return all.filter((s, i) => i === 0 || s - all[i - 1] > 0.02);
}

export default street;
