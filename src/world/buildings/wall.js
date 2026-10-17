import { archPoint } from '../facadePlan.js';

// Wall field of one facade face: the plane w = 0 between the paving and the cornice,
// with the openings cut out exactly along their outlines.
//
// The face is cut into horizontal rows at every opening sill, spring line and head,
// plus extra rows where the baked occlusion changes quickly (under the cornice, string
// courses and balconies, near the paving). Each row is covered by runs of quads
// between the openings, split only where that row needs colour resolution (balcony
// shadows, streaks below sills, soft patches). Arched heads get spandrel strips between
// the curve and the head line. Rows do not share vertices (T-junctions are hidden by
// a dark backstop placed just behind the wall). The ground floor may be rusticated:
// banded courses with deep V joints in stone.rough.

const EPS = 1e-4;

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
const _cuts = [], _out = [];

/** Sorted cut positions across a run [ra, rb]: row splits inside it, then max spacing. */
function runCuts(ra, rb, sp, maxRun) {
  _cuts.length = 0;
  _cuts.push(ra);
  if (sp) {
    for (const u of sp) if (u > ra + 0.02 && u < rb - 0.02) _cuts.push(u);
    if (_cuts.length > 2) _cuts.sort((x, y) => x - y);
  }
  _cuts.push(rb);
  _out.length = 0;
  _out.push(_cuts[0]);
  for (let i = 1; i < _cuts.length; i++) {
    const a = _out[_out.length - 1], d = _cuts[i] - a;
    if (d < EPS) continue;
    if (d > maxRun) { const n = Math.ceil(d / maxRun); for (let k = 1; k < n; k++) _out.push(a + (d * k) / n); }
    _out.push(_cuts[i]);
  }
  return _out;
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
 * ctx: {B, sinks, fs (FaceShade), q (detail), vBottom, vTop, rustic: {v0, v1, joints[], c} | null}
 * face: plan-like (width, openings, courses, balconies, cornice, groundAt)
 */
export function wallField(ctx, face, openings) {
  const { B, q, fs } = ctx;
  const W = face.width;
  const v0 = ctx.vBottom, v1 = ctx.vTop;
  const vb = [v0, v1];
  const holes = [];
  for (const o of openings) {
    const top = Math.min(v1, o.y + o.h);
    holes.push({ u0: o.uc - o.w / 2, u1: o.uc + o.w / 2, y: o.y, spring: o.spring, top });
    vb.push(o.y, o.spring, top);
  }
  holes.sort((a, b) => a.u0 - b.u0);
  // occlusion helper rows and the u-splits they need
  const splits = [];
  const cy = face.cornice ? face.cornice.y : v1;
  for (const d of q.lod ? [0.5] : [0.15, 0.45, 1.0, 2.0]) vb.push(cy - d);
  for (const c of face.courses || []) { vb.push(c.y - 0.1); if (!q.lod) vb.push(c.y - 0.35); }
  if (!q.lod) {
    for (const b of face.balconies || []) {
      vb.push(b.y - 0.3, b.y - 0.9);
      for (const u of [b.u0 - 0.4, b.u0 - 0.1, b.u1 + 0.1, b.u1 + 0.4]) splits.push({ u, v0: b.y - 2.5, v1: b.y });
    }
    for (const o of openings) {
      if (o.kind !== 'window') continue;
      const sy = o.y - 0.12;
      for (const u of [o.uc - o.w / 2 - 0.05, o.uc - o.w / 2 + 0.2, o.uc + o.w / 2 - 0.2, o.uc + o.w / 2 + 0.05]) splits.push({ u, v0: sy - 3, v1: sy });
    }
  }
  // narrow columns in the band under the cornice so the rain-wash streaks can show
  if (!q.lod) for (let u = 0.35; u < W - 0.2; u += 0.42) splits.push({ u, v0: cy - 2.6, v1: cy });
  const gHi = Math.max(face.groundAt(0), face.groundAt(W)), gLo = Math.min(face.groundAt(0), face.groundAt(W));
  for (const d of q.lod ? [0.5] : [0.1, 0.3, 0.7, 1.3, 2.3]) { vb.push(gHi + d); if (gHi - gLo > 0.15) vb.push(gLo + d); }
  const rus = ctx.rustic;
  if (rus) { vb.push(rus.v0, rus.v1); for (const j of rus.joints) vb.push(j - rus.c, j, j + rus.c); }

  let V = uniqSorted(vb.filter((x) => x >= v0 - EPS && x <= v1 + EPS));
  V = refine(V, q.gridV);
  const nr = V.length - 1;
  // splits binned per row
  const rowSplits = new Array(nr);
  for (const sp of splits) {
    for (let r = 0; r < nr; r++) if (V[r + 1] > sp.v0 && V[r] < sp.v1) (rowSplits[r] || (rowSplits[r] = [])).push(sp.u);
  }

  const sAsh = ctx.sinks.ashlar, sRough = ctx.sinks.rough || ctx.sinks.ashlar;
  B.shade = (u, v, w, nu, nv, nw, out) => fs.wall(u, v, out);
  const maxRun = q.gridU;
  const k = Math.SQRT1_2;

  for (let r = 0; r < nr; r++) {
    const va = V[r], vc = V[r + 1], vm = (va + vc) / 2;
    // rustication: is this row inside the rusticated zone, and is it half of a V joint?
    let rough = false, groove = 0;
    if (rus && vm > rus.v0 && vm < rus.v1) {
      rough = true;
      for (const j of rus.joints) { if (vm > j - rus.c && vm < j) groove = 1; else if (vm > j && vm < j + rus.c) groove = -1; }
    }
    const s = rough ? sRough : sAsh;
    // free intervals of this row; jamb[] marks run ends closed by an opening's jamb
    let a = 0, aJamb = false;
    const runs = [], jamb = [];
    for (const h of holes) {
      if (vm <= h.y || vm >= h.top) continue;
      const j = vm < h.spring;
      if (h.u0 - a > EPS) { runs.push(a, h.u0); jamb.push(aJamb, j); }
      a = Math.max(a, h.u1); aJamb = j;
    }
    if (W - a > EPS) { runs.push(a, W); jamb.push(aJamb, false); }
    for (let i = 0; i < runs.length; i += 2) {
      const ra = runs[i], rb = runs[i + 1];
      // cut positions inside this run
      const cuts = runCuts(ra, rb, rowSplits[r], maxRun);
      const n = cuts.length;
      if (groove) {
        // V joint: strip from the wall face back to the joint (chamfer at 45°)
        s.reserve(n * 2, (n - 1) * 6);
        const base = s.vc;
        for (let c = 0; c < n; c++) {
          const u = cuts[c];
          if (groove > 0) { B.v(s, u, va, 0, 0, k, k, u, va); B.v(s, u, vc, -rus.c, 0, k, k, u, vc); }
          else { B.v(s, u, va, -rus.c, 0, -k, k, u, va); B.v(s, u, vc, 0, 0, -k, k, u, vc); }
        }
        for (let c = 0; c < n - 1; c++) { const b = base + c * 2; B.quadIdx(s, b, b + 2, b + 3, b + 1); }
        // close the notch where the joint stops at an arch spandrel or a corner (a jamb closes it otherwise)
        if (!jamb[i]) grooveCap(B, s, ra, -1, va, vc, groove, rus.c);
        if (!jamb[i + 1]) grooveCap(B, s, rb, 1, va, vc, groove, rus.c);
        continue;
      }
      s.reserve(n * 2, (n - 1) * 6);
      const base = s.vc;
      for (let c = 0; c < n; c++) {
        const u = cuts[c];
        B.v(s, u, va, 0, 0, 0, 1, u, va);
        B.v(s, u, vc, 0, 0, 0, 1, u, vc);
      }
      for (let c = 0; c < n - 1; c++) { const b = base + c * 2; B.quadIdx(s, b, b + 2, b + 3, b + 1); }
    }
  }

  // arched spandrels: strips between the head curve and the head line
  for (const o of openings) {
    if (!o.rise || o.top === 'flat') continue;
    const top = Math.min(v1, o.y + o.h);
    const rough = rus && o.spring < rus.v1 && o.spring > rus.v0;
    const s = rough ? sRough : sAsh;
    const n = q.archSeg;
    s.reserve((n + 1) * 2, n * 6);
    let pu = 0, iu0 = -1, it0 = -1;
    for (let c = 0; c <= n; c++) {
      archPoint(o, c / n, _p);
      const pv = Math.min(_p.v, top);
      const iu = B.v(s, _p.u, pv, 0, 0, 0, 1, _p.u, pv);
      const it = B.v(s, _p.u, top, 0, 0, 0, 1, _p.u, top);
      if (c > 0 && _p.u - pu > 1e-5) B.quadIdx(s, iu0, iu, it, it0);
      pu = _p.u; iu0 = iu; it0 = it;
    }
  }
  B.shade = null;
}
