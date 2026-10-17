import { archPoint } from '../facadePlan.js';

// Wall field of one facade face: the plane w = 0 between the paving and the cornice,
// with the openings cut out exactly along their outlines. Built as a grid whose lines
// pass through every opening edge, spring line and head, refined with extra rows and
// columns where the baked occlusion changes quickly (under cornices, string courses
// and balconies, near the paving). Arched heads get spandrel strips between the
// curve and the head line. The ground floor may be rusticated: banded courses with
// deep V joints in stone.rough.

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
function find(a, x) {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x - EPS) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * ctx: {B, sinks, fs (FaceShade), q (detail), vBottom, vTop, rustic: {v0, v1, joints[], c} | null}
 * face: plan-like (width, openings, courses, balconies, cornice, groundAt)
 */
export function wallField(ctx, face, openings) {
  const { B, q, fs } = ctx;
  const W = face.width;
  const v0 = ctx.vBottom, v1 = ctx.vTop;
  const ub = [0, W], vb = [v0, v1];
  for (const o of openings) {
    ub.push(o.uc - o.w / 2, o.uc + o.w / 2);
    vb.push(o.y, o.spring, Math.min(v1, o.y + o.h));
  }
  // occlusion helper rows
  const cy = face.cornice ? face.cornice.y : v1;
  for (const d of q.lod ? [0.4] : [0.12, 0.4, 0.9, 1.8]) vb.push(cy - d);
  for (const c of face.courses || []) { vb.push(c.y - 0.1); if (!q.lod) vb.push(c.y - 0.32); }
  for (const b of face.balconies || []) {
    vb.push(b.y - 0.3); if (!q.lod) vb.push(b.y - 0.9);
    ub.push(b.u0 - 0.4, b.u0 - 0.15, b.u1 + 0.15, b.u1 + 0.4);
  }
  const gHi = Math.max(face.groundAt(0), face.groundAt(W)), gLo = Math.min(face.groundAt(0), face.groundAt(W));
  for (const d of q.lod ? [0.4, 1.5] : [0.08, 0.25, 0.6, 1.2, 2.2]) { vb.push(gHi + d); if (gHi - gLo > 0.15) vb.push(gLo + d); }
  // streak columns below sills
  if (!q.lod) for (const o of openings) if (o.kind === 'window') { ub.push(o.uc - o.w / 2 + 0.2, o.uc + o.w / 2 - 0.2); }
  // rustication joints
  const rus = ctx.rustic;
  if (rus) { vb.push(rus.v0, rus.v1); for (const j of rus.joints) vb.push(j - rus.c, j, j + rus.c); }

  let U = uniqSorted(ub.filter((x) => x >= -EPS && x <= W + EPS));
  let V = uniqSorted(vb.filter((x) => x >= v0 - EPS && x <= v1 + EPS));
  U = refine(U, q.gridU); V = refine(V, q.gridV);
  const nc = U.length - 1, nr = V.length - 1;
  const cls = new Uint8Array(nc * nr);
  for (const o of openings) {
    const c0 = find(U, o.uc - o.w / 2), c1 = find(U, o.uc + o.w / 2);
    const r0 = find(V, o.y), r1 = find(V, o.spring), r2 = find(V, Math.min(v1, o.y + o.h));
    for (let c = c0; c < c1; c++) {
      for (let r = r0; r < r1; r++) cls[r * nc + c] = 1;
      for (let r = r1; r < r2; r++) cls[r * nc + c] = 2;
    }
  }
  // grooves: rows that straddle a rustication joint
  const groove = new Int8Array(nr); // 0 flat, +1 lower half of a joint (top chamfer of the block below), -1 upper half
  const inRus = new Uint8Array(nr);
  if (rus) {
    for (let r = 0; r < nr; r++) {
      const m = (V[r] + V[r + 1]) / 2;
      if (m > rus.v0 && m < rus.v1) inRus[r] = 1;
      for (const j of rus.joints) {
        if (m > j - rus.c && m < j) groove[r] = 1;
        else if (m > j && m < j + rus.c) groove[r] = -1;
      }
    }
  }

  // emit flat cells with shared grid nodes (separately per sink)
  const sAsh = ctx.sinks.ashlar, sRough = ctx.sinks.rough || ctx.sinks.ashlar;
  const nodeA = new Int32Array((nc + 1) * (nr + 1)).fill(-1);
  const nodeR = rus ? new Int32Array((nc + 1) * (nr + 1)).fill(-1) : null;
  B.shade = (u, v, w, nu, nv, nw, out) => fs.wall(u, v, out);
  const node = (map, s, c, r) => {
    const k = r * (nc + 1) + c;
    let i = map[k];
    if (i < 0) { i = map[k] = B.v(s, U[c], V[r], 0, 0, 0, 1, U[c], V[r]); }
    return i;
  };
  sAsh.reserve((nc + 1) * (nr + 1), nc * nr * 6);
  if (rus) sRough.reserve((nc + 1) * (nr + 1), nc * nr * 6);
  for (let r = 0; r < nr; r++) {
    const rough = rus && inRus[r];
    const s = rough ? sRough : sAsh, map = rough ? nodeR : nodeA;
    for (let c = 0; c < nc; c++) {
      if (cls[r * nc + c]) continue;
      if (rough && groove[r]) {
        const ua = U[c], ubb = U[c + 1], va = V[r], vbb = V[r + 1], k = Math.SQRT1_2;
        if (groove[r] > 0) B._quad4(s, ua, va, 0, ubb, va, 0, ubb, vbb, -rus.c, ua, vbb, -rus.c, 0, k, k);
        else B._quad4(s, ua, va, -rus.c, ubb, va, -rus.c, ubb, vbb, 0, ua, vbb, 0, 0, -k, k);
        continue;
      }
      B.quadIdx(s, node(map, s, c, r), node(map, s, c + 1, r), node(map, s, c + 1, r + 1), node(map, s, c, r + 1));
    }
  }

  // arched spandrels: strips between the head curve and the head line
  const p = {};
  for (const o of openings) {
    if (!o.rise || o.top === 'flat') continue;
    const top = Math.min(v1, o.y + o.h);
    const rough = rus && o.spring < rus.v1 && o.spring > rus.v0;
    const s = rough ? sRough : sAsh;
    const n = q.archSeg;
    s.reserve((n + 1) * 2, n * 6);
    let pu = 0, pv = 0, iu0 = -1, it0 = -1;
    for (let k = 0; k <= n; k++) {
      archPoint(o, k / n, p);
      const pvv = Math.min(p.v, top);
      const iu = B.v(s, p.u, pvv, 0, 0, 0, 1, p.u, pvv);
      const it = B.v(s, p.u, top, 0, 0, 0, 1, p.u, top);
      if (k > 0 && p.u - pu > 1e-5) B.quadIdx(s, iu0, iu, it, it0);
      pu = p.u; pv = pvv; iu0 = iu; it0 = it;
    }
    void pv;
  }
  B.shade = null;
}
