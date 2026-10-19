import { archPoint } from '../facadePlan.js';
import { arcSeg } from './mesh.js';
import { hash3 } from './shade.js';

// Wall field of one facade face: the plane w = 0 between the paving and the cornice,
// with the openings cut out exactly along their outlines.
//
// The face is cut into horizontal rows at every opening sill, spring line and head,
// plus extra rows where the baked occlusion changes quickly (under the cornice and
// string courses, near the paving) and at the run-off lines (balcony soffits, sill
// undersides). Each row is covered by runs of quads between the openings, split where
// the run-off occluder above changes (the run-off and the soft patches of the stone are
// shaded per pixel, see shade.js), and near a sloping pavement every gridU metres (the
// splash zone follows the paving). Arched heads get spandrel strips between the curve
// and the head line. Rows do not share vertices (T-junctions are hidden by a dark
// backstop behind the wall). The ground floor may be rusticated: banded courses with
// deep V joints in stone.rough.
//
// V joints (grooveStrip): the band j ± c of a joint is one row holding both chamfers, the
// lower block's (facing up) and the upper block's (facing down), which meet at the root
// c behind the wall face. The root wanders up and down along the joint (piecewise linear,
// knots every GROOVE_G m, up to GROOVE_A of the depth), so the chamfers vary in width
// while their arrises stay on the course lines. Each block's chamfer carries its own
// soiling (dust settles on the upward-facing one; blocks split at the texture's head
// joints), and the texture across a chamfer is the joint band of the rock-faced stone
// (JOINT_BAND texture metres either side of the bed joint): its mortar, occlusion and the
// margin's broken edge, not a clean stretch of the drafted margin.

const EPS = 1e-4;
const SLICE = 0.3;   // time slice of a generation step (ms)
const GROOVE_G = 0.3, GROOVE_A = 0.16;
const JOINT_BAND = 0.025, BAND_VAR = 0.25;
// soiling of a chamfer (colour factor: base + spread × per-block hash), the upward-facing
// one dustier; the grime mask it adds (patchy dirt from the weathering atlas); the dust's
// tint (relative rgb)
const SOIL_UP = [0.75, 0.08], SOIL_DOWN = [0.81, 0.07], SOIL_GRIME = 0.12, SOIL_TINT = [1, 0.95, 0.86];
const BLOCK_L = 0.8;   // block rhythm along a joint without a fitted texture layout

function uniqSorted(a) {
  a.sort((x, y) => x - y);
  const out = [a[0]];
  for (let i = 1; i < a.length; i++) if (a[i] - out[out.length - 1] > EPS) out.push(a[i]);
  return out;
}
function refine(a, maxStep) {
  const out = [a[0]];
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    if (d > maxStep) { const n = Math.ceil(d / maxStep); for (let k = 1; k < n; k++) out.push(a[i - 1] + (d * k) / n); }
    out.push(a[i]);
  }
  return out;
}

const _p = {};
const _pcs = [];
const _cut = new Float64Array(512);                // runCuts output (reused)
const _runs = [], _jamb = [];                      // free runs of a row (reused)
const _gc = new Float64Array(1024);                // grooveStrip columns (reused)
const _hj = [];                                    // head joints inside a piece (reused)

/** Cut positions across a run [ra, rb], at most maxRun apart, into _cut; returns the count. */
function runCuts(ra, rb, maxRun) {
  const d = rb - ra;
  const n = d > maxRun ? Math.min(511, Math.ceil(d / maxRun)) : 1;
  for (let k = 0; k < n; k++) _cut[k] = ra + (d * k) / n;
  _cut[n] = rb;
  return n + 1;
}

/**
 * A V joint: {j (joint line), i (its index), c (depth), seed}. Root height at u: the joint
 * line plus a piecewise-linear wander (knots every GROOVE_G m, the same in every row
 * and pass, so the two chamfers always meet).
 */
function grooveRoot(g, u) {
  const x = u / GROOVE_G, m = Math.floor(x), f = x - m, k = g.i * 7919 + 13;
  const h0 = hash3(m, k, g.seed), h1 = hash3(m + 1, k, g.seed);
  return g.j + GROOVE_A * g.c * (2 * (h0 + (h1 - h0) * f) - 1);
}
/** Texture metres of the joint band shown across a chamfer at u (varying along the joint). */
function grooveBand(g, u) {
  const x = u / GROOVE_G, m = Math.floor(x), f = x - m, k = g.i * 7919 + 29;
  const h0 = hash3(m, k, g.seed), h1 = hash3(m + 1, k, g.seed);
  return JOINT_BAND * (1 + BAND_VAR * (2 * (h0 + (h1 - h0) * f) - 1));
}
/** Depth (w ≤ 0) of the V profile at height v, root r. */
function grooveW(g, r, v) {
  const a0 = g.j - g.c, a1 = g.j + g.c;
  return v <= r ? -g.c * Math.max(0, v - a0) / (r - a0) : -g.c * Math.max(0, a1 - v) / (a1 - r);
}

/**
 * One chamfer of a V joint over [xa, xb] in the row va..vc: side 0 the lower block's
 * (from its arris at j − c up to the root), 1 the upper block's (root to j + c), clamped
 * to the row. A column every GROOVE_G (on the root's knots); texture v across the joint
 * band (sv: the texture's v scale).
 */
function grooveStrip(B, s, g, side, xa, xb, va, vc, sv) {
  const c = g.c, a0 = g.j - c, a1 = g.j + c;
  let n = 1;
  _gc[0] = xa;
  for (let m = Math.floor(xa / GROOVE_G) + 1; m * GROOVE_G < xb - 1e-3 && n < 1022; m++) if (m * GROOVE_G > xa + 1e-3) _gc[n++] = m * GROOVE_G;
  _gc[n++] = xb;
  s.reserve(n * 2, (n - 1) * 6);
  const b0 = s.vc;
  for (let k = 0; k < n; k++) {
    const u = _gc[k], r = grooveRoot(g, u), band = grooveBand(g, u) / sv;
    const lo = side ? Math.max(va, r) : Math.min(va, r), hi = side ? Math.max(vc, r) : Math.min(vc, r);
    // facing up and out (lower chamfer) or down and out (upper chamfer)
    const nv = side ? -c : c, nw = side ? a1 - r : r - a0;
    const tLo = side ? g.j + (band * (lo - r)) / (a1 - r) : g.j - (band * (r - lo)) / (r - a0);
    const tHi = side ? g.j + (band * (hi - r)) / (a1 - r) : g.j - (band * (r - hi)) / (r - a0);
    B.v(s, u, lo, grooveW(g, r, lo), 0, nv, nw, u, tLo);
    B.v(s, u, hi, grooveW(g, r, hi), 0, nv, nw, u, tHi);
  }
  for (let k = 0; k < n - 1; k++) { const b = b0 + k * 2; B.quadIdx(s, b, b + 2, b + 3, b + 1); }
}

/** Closes the notch of a V joint where it stops at u (an arch spandrel or a corner), facing dir (±u). */
function grooveCap(B, s, g, u, dir, va, vc) {
  const r = grooveRoot(g, u);
  s.reserve(5, 9);
  // the section between the wall plane and the profile: convex, counter-clockwise in
  // (v, w), which faces +u
  const b0 = s.vc;
  B.v(s, u, va, 0, dir, 0, 0, 0, va);
  const wa = grooveW(g, r, va);
  B.v(s, u, va, wa, dir, 0, 0, -dir * wa, va);
  let n = 2;
  if (r > va + 1e-4 && r < vc - 1e-4) { B.v(s, u, r, -g.c, dir, 0, 0, dir * g.c, r); n++; }
  const wc = grooveW(g, r, vc);
  B.v(s, u, vc, wc, dir, 0, 0, -dir * wc, vc);
  B.v(s, u, vc, 0, dir, 0, 0, 0, vc);
  n += 2;
  for (let k = 1; k < n - 1; k++) { if (dir > 0) B.tri(s, b0, b0 + k, b0 + k + 1); else B.tri(s, b0, b0 + k + 1, b0 + k); }
}

/**
 * ctx: {B, sinks, fs (FaceShade), q (detail), vBottom, vTop, rustic: {v0, v1, joints[], c} | null,
 *       cover?: (o) => {side, head: {ext, H} | null} | null,
 *       render?: {v0, sink, fs} | null}
 * ctx.render: the wall above v0 is rendered (its own sink and shading, no ashlar fitting).
 * face: plan-like (width, openings, courses, balconies, cornice, groundAt)
 * ctx.cover tells which dressing closes over the wall around an opening: surround jambs
 * `side` wide up to the spring line, a lintel `ext` beyond the jambs and H tall above a
 * flat head. The wall is left out under them (they are closed boxes, set into the wall).
 * A generator: yields every SLICE ms of rows so a large facade can be spread over frames.
 */
export function* wallField(ctx, face, openings) {
  const { B, q, fs } = ctx;
  const W = face.width;
  const uMin = ctx.uMin ?? 0, uMax = ctx.uMax ?? W;   // part of the face that is walled (chamfered corners)
  const v0 = ctx.vBottom, v1 = ctx.vTop;
  const vb = [v0, v1];
  const holes = [];
  for (const o of openings) {
    const top = Math.min(v1, o.y + o.h);
    const cov = ctx.cover ? ctx.cover(o) : null;
    const side = cov ? cov.side : 0, head = cov && cov.head;
    const hTop = head ? Math.min(v1, top + head.H) : top;
    holes.push({ u0: o.uc - o.w / 2, u1: o.uc + o.w / 2, y: o.y, spring: o.spring, top, side, hTop, hExt: head ? head.ext : 0 });
    vb.push(o.y, o.spring, top, hTop);
  }
  holes.sort((a, b) => a.u0 - b.u0);
  // occlusion helper rows (both detail levels keep these rows, so the baked shading does
  // not pop at the switch), and the run-off lines
  const cy = face.cornice ? face.cornice.y : v1;
  for (const d of [0.15, 0.45, 1.0, 2.0]) vb.push(cy - d);
  for (const c of face.courses || []) vb.push(c.y - 0.1, c.y - 0.35);
  const gHi = Math.max(face.groundAt(0), face.groundAt(W)), gLo = Math.min(face.groundAt(0), face.groundAt(W));
  for (const d of q.lod ? [0.1, 0.4, 1.0, 2.3] : [0.1, 0.3, 0.7, 1.3, 2.3]) { vb.push(gHi + d); if (gHi - gLo > 0.15) vb.push(gLo + d); }
  const rus = ctx.rustic, rend = ctx.render || null;
  if (rus) { vb.push(rus.v0, rus.v1); for (const j of rus.joints) vb.push(j - rus.c, j + rus.c); }
  if (rend) vb.push(rend.v0);
  // bed joints of the ashlar texture (outside the rusticated zone, whose rows already
  // follow its V joints), so every row lies inside one course and can be fitted
  const fitA = ctx.fit ? ctx.fit.ashlar : null, fitR = ctx.fit ? ctx.fit.rough : null;
  if (fitA) {
    for (let rg = fitA.row(v0) + 1, v = fitA.bed(rg); v < v1; v = fitA.bed(++rg)) {
      if (!rus || v <= rus.v0 + EPS || v >= rus.v1 - EPS) vb.push(v);
    }
  }

  // run-off lines (balcony soffits, sill undersides), unless a row boundary is close
  const vb0 = vb.slice();
  for (const y of fs.occluderLines()) if (vb0.every((x) => Math.abs(x - y) > 0.08)) vb.push(y);
  let V = uniqSorted(vb.filter((x) => x >= v0 - EPS && x <= v1 + EPS));
  V = refine(V, q.gridV);
  const nr = V.length - 1;

  const sAsh = ctx.sinks.ashlar, sRough = ctx.sinks.rough || ctx.sinks.ashlar;
  const roughBase = sRough.uvx;
  const stoneShade = (u, v, w, nu, nv, nw, out) => fs.wall(u, v, out);
  const rendShade = rend ? (u, v, w, nu, nv, nw, out) => rend.fs.wall(u, v, out) : null;
  // a V-joint chamfer: the wall's shading, soiled by the block's factor gk (darker, and
  // warmer: brown-grey dust, so the sky-lit chamfer does not read as a cold white band),
  // and a little grime for the weathering's patchy dirt
  let gk = 1;
  const grooveShade = (u, v, w, nu, nv, nw, out) => {
    fs.wall(u, v, out);
    out[0] *= gk; out[1] *= gk * SOIL_TINT[1]; out[2] *= gk * SOIL_TINT[2];
    out[3] = Math.min(1, out[3] + SOIL_GRIME);
  };
  const gj = rus ? { j: 0, i: 0, c: rus.c, seed: (fs.seed | 0) ^ 0x6a09 } : null;
  B.shade = stoneShade;
  const sloped = gHi - gLo > 0.02;
  /** Texture transform of a piece: the sink's own base with u replaced by the fitted (k, off). */
  const setPiece = (s, base, kk, off) => {
    const x = s.fitUV || (s.fitUV = [1, 0, 1, 0]);
    x[0] = kk; x[1] = off; x[2] = base[2]; x[3] = base[3];
    s.uvx = x;
  };

  let ts = performance.now();
  for (let r = 0; r < nr; r++) {
    // (a step ends once it has taken SLICE ms)
    if (r && performance.now() - ts > SLICE) { yield; ts = performance.now(); }
    const va = V[r], vc = V[r + 1], vm = (va + vc) / 2;
    // rustication: is this row inside the rusticated zone, and inside a V joint's band?
    let rough = false, groove = false;
    if (rus && vm > rus.v0 && vm < rus.v1) {
      rough = true;
      for (let ji = 0; ji < rus.joints.length; ji++) {
        const j = rus.joints[ji];
        if (vm > j - rus.c && vm < j + rus.c) { groove = true; gj.j = j; gj.i = ji; }
      }
    }
    const rr = !rough && rend && vm > rend.v0;
    const s = rr ? rend.sink : rough ? sRough : sAsh;
    const fit = rr ? null : rough ? fitR : fitA, base = rough ? roughBase : B.uv;
    const rg = fit ? fit.row(vm) : 0;
    B.shade = rr ? rendShade : stoneShade;
    const zones = fs.rowZones(va, vc), zc = zones.cuts;
    const maxRun = sloped && va < gHi + 2.5 ? q.gridU : Infinity;
    // free intervals of this row; jamb[] marks run ends closed by an opening's jamb
    let a = uMin, aJamb = false;
    const runs = _runs, jamb = _jamb;
    runs.length = 0; jamb.length = 0;
    for (const h of holes) {
      if (vm <= h.y || vm >= h.hTop) continue;
      // the opening (widened by its jambs below the spring line), or the lintel above it
      const j = vm < h.spring || vm > h.top;
      const ext = vm > h.top ? h.hExt : vm < h.spring ? h.side : 0;
      const h0 = h.u0 - ext, h1 = h.u1 + ext;
      if (h0 - a > EPS) { runs.push(a, h0); jamb.push(aJamb, j); }
      a = Math.max(a, h1); aJamb = j;
    }
    if (uMax - a > EPS) { runs.push(a, uMax); jamb.push(aJamb, false); }
    for (let i = 0; i < runs.length; i += 2) {
      const ra = runs[i], rb = runs[i + 1];
      if (groove) {
        // V joint: the two chamfers, each in its own course's fitted texture
        B.shade = grooveShade;
        for (let side = 0; side < 2; side++) {
          const rgS = fit ? fit.row(side ? gj.j + 0.01 : gj.j - 0.01) : 0;
          const P = fit ? fit.pieces(rgS, ra, rb, _pcs) : null;
          const np = P ? P.length : 4, soil = side ? SOIL_DOWN : SOIL_UP;
          for (let pi = 0; pi < np; pi += 4) {
            const pa = P ? P[pi] : ra, pb = P ? P[pi + 1] : rb, kk = P ? P[pi + 2] : 1, off = P ? P[pi + 3] : 0;
            if (P) setPiece(s, base, kk, off);
            // blocks: split at the texture's head joints (or an even rhythm)
            const H = _hj;
            H.length = 0;
            if (P) fit.headJoints(rgS, pa, pb, kk, off, H);
            else for (let m = Math.floor(pa / BLOCK_L) + 1; m * BLOCK_L < pb; m++) H.push(m * BLOCK_L);
            let zi = 0, hi = 0;
            while (zi < zc.length && zc[zi] <= pa + 0.01) zi++;
            for (let za = pa; za < pb - EPS;) {
              const zb = zi < zc.length && zc[zi] < pb - 0.01 ? zc[zi] : pb;
              B.run = zones.occ[zi];
              for (let xa = za; xa < zb - EPS;) {
                while (hi < H.length && H[hi] <= xa + EPS) hi++;
                const xb = hi < H.length && H[hi] < zb - EPS ? H[hi] : zb;
                const xm = (xa + xb) / 2;
                const id = P ? fit.blockId(rgS, xm, kk, off) : Math.floor(xm / BLOCK_L);
                gk = soil[0] + soil[1] * hash3(id, rgS * 2 + side + gj.i * 64, gj.seed);
                grooveStrip(B, s, gj, side, xa, xb, va, vc, base[2]);
                xa = xb;
              }
              za = zb; zi++;
            }
          }
        }
        B.run = null;
        if (!rr) s.uvx = roughBase;
        // close the notch where a V joint stops at an arch spandrel or a corner (a jamb closes it otherwise)
        B.shade = stoneShade;
        if (!jamb[i]) grooveCap(B, s, gj, ra, -1, va, vc);
        if (!jamb[i + 1]) grooveCap(B, s, gj, rb, 1, va, vc);
        continue;
      }
      const P = fit ? fit.pieces(rg, ra, rb, _pcs) : null;
      const np = P ? P.length : 4;
      for (let pi = 0; pi < np; pi += 4) {
        const pa = P ? P[pi] : ra, pb = P ? P[pi + 1] : rb;
        if (P) setPiece(s, base, P[pi + 2], P[pi + 3]);
        // one strip per run-off zone inside this piece
        let zi = 0;
        while (zi < zc.length && zc[zi] <= pa + 0.01) zi++;
        for (let za = pa; za < pb - EPS;) {
          const zb = zi < zc.length && zc[zi] < pb - 0.01 ? zc[zi] : pb;
          B.run = zones.occ[zi];
          const n = runCuts(za, zb, maxRun), cuts = _cut;
          s.reserve(n * 2, (n - 1) * 6);
          const b0 = s.vc;
          for (let c = 0; c < n; c++) { const u = cuts[c]; B.v(s, u, va, 0, 0, 0, 1, u, va); B.v(s, u, vc, 0, 0, 0, 1, u, vc); }
          for (let c = 0; c < n - 1; c++) { const b = b0 + c * 2; B.quadIdx(s, b, b + 2, b + 3, b + 1); }
          za = zb; zi++;
        }
      }
      B.run = null;
    }
    if (!rr) s.uvx = rough ? roughBase : null;
  }
  B.shade = stoneShade;

  yield;
  // arched spandrels: strips between the head curve and the head line, cut at the bed
  // joints so each piece takes the fitted transform of its course (left half from the
  // run left of the opening, right half from the run right of it)
  const tr = [0, 0];
  for (const o of openings) {
    if (!o.rise || o.top === 'flat') continue;
    const top = Math.min(v1, o.y + o.h);
    const rough = rus && o.spring < rus.v1 && o.spring > rus.v0;
    const rr = !rough && rend && o.spring > rend.v0;
    const s = rr ? rend.sink : rough ? sRough : sAsh;
    const fit = rr ? null : rough ? fitR : fitA, base = rough ? roughBase : B.uv;
    B.shade = rr ? rendShade : stoneShade;
    const n = arcSeg(q, o);
    B.run = fs.occluderAt(o.uc, top);
    let pu = 0, pv = 0;
    for (let c = 0; c <= n; c++) {
      archPoint(o, c / n, _p);
      const cu = _p.u, cv = Math.min(_p.v, top);
      if (c > 0 && cu - pu > 1e-5) {
        const um = (pu + cu) / 2;
        // levels from the head line down to the chord's upper end
        let hi = top, rgTop = fit ? fit.row(top - 1e-3) : 0;
        const lo = Math.max(pv, cv);
        for (;;) {
          const bed = fit ? fit.bed(rgTop) : -Infinity;
          if (fit) { fit.at(rgTop, um, tr); setPiece(s, base, tr[0], tr[1]); }
          s.reserve(4, 6);
          if (bed > lo + 0.01) {
            // full-width piece of this course
            const i0 = B.v(s, pu, bed, 0, 0, 0, 1, pu, bed), i1 = B.v(s, cu, bed, 0, 0, 0, 1, cu, bed);
            const i2 = B.v(s, cu, hi, 0, 0, 0, 1, cu, hi), i3 = B.v(s, pu, hi, 0, 0, 0, 1, pu, hi);
            B.quadIdx(s, i0, i1, i2, i3);
            hi = bed; rgTop--;
            continue;
          }
          // bottom piece down to the curve
          const i0 = B.v(s, pu, pv, 0, 0, 0, 1, pu, pv), i1 = B.v(s, cu, cv, 0, 0, 0, 1, cu, cv);
          const i2 = B.v(s, cu, hi, 0, 0, 0, 1, cu, hi), i3 = B.v(s, pu, hi, 0, 0, 0, 1, pu, hi);
          if (hi - lo > 1e-4 || hi - Math.min(pv, cv) > 1e-4) B.quadIdx(s, i0, i1, i2, i3);
          break;
        }
      }
      pu = cu; pv = cv;
    }
    if (!rr) s.uvx = rough ? roughBase : null;
  }
  B.run = null;
  B.shade = null;
}
