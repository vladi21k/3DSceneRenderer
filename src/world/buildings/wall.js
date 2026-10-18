import { archPoint } from '../facadePlan.js';
import { arcSeg } from './mesh.js';

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

const EPS = 1e-4;
const SLICE = 0.3;   // time slice of a generation step (ms)

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

/** Cut positions across a run [ra, rb], at most maxRun apart, into _cut; returns the count. */
function runCuts(ra, rb, maxRun) {
  const d = rb - ra;
  const n = d > maxRun ? Math.min(511, Math.ceil(d / maxRun)) : 1;
  for (let k = 0; k < n; k++) _cut[k] = ra + (d * k) / n;
  _cut[n] = rb;
  return n + 1;
}

/** Triangle closing a V-joint half at u, facing dir (±u). */
function grooveCap(B, s, u, dir, va, vc, groove, c) {
  s.reserve(3, 3);
  // lower half (groove > 0): face at va, joint root at vc; upper half: root at va, face at vc
  const a = groove > 0 ? B.v(s, u, va, 0, dir, 0, 0, 0, va) : B.v(s, u, va, -c, dir, 0, 0, c, va);
  const b = groove > 0 ? B.v(s, u, vc, -c, dir, 0, 0, c, vc) : B.v(s, u, vc, 0, dir, 0, 0, 0, vc);
  const m = groove > 0 ? B.v(s, u, vc, 0, dir, 0, 0, 0, vc) : B.v(s, u, va, 0, dir, 0, 0, 0, va);
  // (a, b, m) faces +u in both halves
  if (dir > 0) B.tri(s, a, b, m); else B.tri(s, a, m, b);
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
  if (rus) { vb.push(rus.v0, rus.v1); for (const j of rus.joints) vb.push(j - rus.c, j, j + rus.c); }
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
  B.shade = stoneShade;
  const sloped = gHi - gLo > 0.02;
  const k = Math.SQRT1_2;
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
    // rustication: is this row inside the rusticated zone, and is it half of a V joint?
    let rough = false, groove = 0;
    if (rus && vm > rus.v0 && vm < rus.v1) {
      rough = true;
      for (const j of rus.joints) { if (vm > j - rus.c && vm < j) groove = 1; else if (vm > j && vm < j + rus.c) groove = -1; }
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
          if (groove) {
            // V joint: strip from the wall face back to the joint (chamfer at 45°)
            for (let c = 0; c < n; c++) {
              const u = cuts[c];
              if (groove > 0) { B.v(s, u, va, 0, 0, k, k, u, va); B.v(s, u, vc, -rus.c, 0, k, k, u, vc); }
              else { B.v(s, u, va, -rus.c, 0, -k, k, u, va); B.v(s, u, vc, 0, 0, -k, k, u, vc); }
            }
          } else {
            for (let c = 0; c < n; c++) { const u = cuts[c]; B.v(s, u, va, 0, 0, 0, 1, u, va); B.v(s, u, vc, 0, 0, 0, 1, u, vc); }
          }
          for (let c = 0; c < n - 1; c++) { const b = b0 + c * 2; B.quadIdx(s, b, b + 2, b + 3, b + 1); }
          za = zb; zi++;
        }
      }
      B.run = null;
      // close the notch where a V joint stops at an arch spandrel or a corner (a jamb closes it otherwise)
      if (groove && !jamb[i]) grooveCap(B, s, ra, -1, va, vc, groove, rus.c);
      if (groove && !jamb[i + 1]) grooveCap(B, s, rb, 1, va, vc, groove, rus.c);
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
