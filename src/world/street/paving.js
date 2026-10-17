import {
  MAIN_RAILS, BAND_IN, CORRIDOR, GUTTER_OUT, SLAB_H,
} from './constants.js';

// Paving grid for one chunk: corridor (with gaps for the rails), light stone edge
// bands, dished gutters and sidewalks out under the facades. One height per grid
// vertex from the Surface; normals by central differences on the grid (with ghost rows
// beyond the chunk ends so neighbouring chunks shade seamlessly).

const K_CORR = 0, K_RAIL = 1, K_BAND = 2, K_GUTTER = 3, K_WALK = 4;

/** Interior column offsets between a and b, denser next to rails. */
function fill(out, a, b, nearA, nearB, maxStep) {
  const near = [0.022, 0.07, 0.16, 0.3];
  const pts = [];
  const span = b - a;
  if (nearA) for (const o of near) if (o < span * 0.45) pts.push(a + o);
  if (nearB) for (const o of near) if (o < span * 0.45) pts.push(b - o);
  pts.sort((x, y) => x - y);
  // uniform fill of the remaining gap(s)
  const all = [a, ...pts, b];
  for (let i = 0; i < all.length - 1; i++) {
    const x0 = all[i], x1 = all[i + 1];
    if (i > 0) out.push(x0);
    const n = Math.ceil((x1 - x0) / maxStep);
    for (let k = 1; k < n; k++) out.push(x0 + ((x1 - x0) * k) / n);
  }
}

/** Fixed columns from -GUTTER_OUT to +GUTTER_OUT with the kind of each interval. */
export function fixedColumns(lod) {
  const d = [], kind = [];
  const push = (x, k) => { d.push(x); kind.push(k); };
  const corrStep = lod === 0 ? 0.42 : 0.9;
  // left gutter + band
  const gutter = (a, b) => {
    const n = lod === 0 ? 4 : 2;
    for (let i = 0; i < n; i++) push(a + ((b - a) * i) / n, K_GUTTER);
  };
  gutter(-GUTTER_OUT, -CORRIDOR);
  push(-CORRIDOR, K_BAND);
  if (lod === 0) push(-(CORRIDOR + BAND_IN) / 2, K_BAND);
  // corridor with rails
  let x = -BAND_IN;
  let prevRail = false;
  for (const r of MAIN_RAILS) {
    const tmp = [];
    if (lod === 0) fill(tmp, x, r.lo, prevRail, true, corrStep);
    else fill(tmp, x, r.lo, false, false, corrStep);
    push(x, K_CORR);
    for (const t of tmp) push(t, K_CORR);
    push(r.lo, K_RAIL);
    x = r.hi;
    prevRail = true;
  }
  {
    const tmp = [];
    fill(tmp, x, BAND_IN, lod === 0, false, corrStep);
    push(x, K_CORR);
    for (const t of tmp) push(t, K_CORR);
  }
  push(BAND_IN, K_BAND);
  if (lod === 0) push((CORRIDOR + BAND_IN) / 2, K_BAND);
  gutter(CORRIDOR, GUTTER_OUT);
  push(GUTTER_OUT, K_WALK); // last fixed column: its interval kind is set per row assembly
  return { d, kind };
}

const FIXED = [fixedColumns(0), fixedColumns(1)];

/**
 * Build the paving of a chunk.
 * rows: sorted s values (first = chunk s0, last = chunk s1).
 * Returns per-row samples (reused by rails and details).
 */
export function buildPaving(ctx, chunk, rows, out) {
  const { route, surface, mats } = ctx;
  const lod = chunk.lod;
  const fx = FIXED[lod];
  const nFixed = fx.d.length;
  const nr = rows.length;

  // sidewalk column counts (fixed per chunk so rows line up)
  const walkStep = lod === 0 ? 0.62 : 1.6;
  const infos = [];
  let maxL = 0, maxR = 0;
  const rowS = [rows[0] - (rows[1] - rows[0]), ...rows, rows[nr - 1] + (rows[nr - 1] - rows[nr - 2])];
  for (let i = 0; i < rowS.length; i++) {
    const ri = surface.rowInfo(rowS[i], {});
    infos.push(ri);
    maxL = Math.max(maxL, -ri.edgeL - GUTTER_OUT);
    maxR = Math.max(maxR, ri.edgeR - GUTTER_OUT);
  }
  const nL = Math.max(2, Math.ceil(maxL / walkStep));
  const nR = Math.max(2, Math.ceil(maxR / walkStep));
  const nc = nL + nFixed + nR; // left walk cols (excluding -GUTTER_OUT) + fixed + right walk cols
  const NR = rowS.length;

  // column offsets and heights per (ghost-extended) row
  const D = new Float32Array(NR * nc);
  const H = new Float32Array(NR * nc);
  for (let r = 0; r < NR; r++) {
    const ri = infos[r];
    const o = r * nc;
    const eL = ri.edgeL, eR = ri.edgeR;
    for (let k = 0; k < nL; k++) D[o + k] = eL + ((-GUTTER_OUT - eL) * k) / nL;
    for (let k = 0; k < nFixed; k++) D[o + nL + k] = fx.d[k];
    for (let k = 1; k <= nR; k++) D[o + nL + nFixed - 1 + k] = GUTTER_OUT + ((eR - GUTTER_OUT) * k) / nR;
    for (let c = 0; c < nc; c++) H[o + c] = surface.height(ri, D[o + c]);
  }
  // interval kinds (nc-1 intervals)
  const kind = new Uint8Array(nc - 1);
  for (let c = 0; c < nc - 1; c++) {
    if (c < nL) kind[c] = K_WALK;
    else if (c < nL + nFixed - 1) kind[c] = fx.kind[c - nL];
    else kind[c] = K_WALK;
  }

  // per-row route samples
  const smp = {};
  const samples = [];
  for (let r = 0; r < nr; r++) {
    route.sample(rows[r], smp);
    samples.push({
      s: rows[r], px: smp.pos.x, py: smp.pos.y, pz: smp.pos.z, rx: smp.right.x, rz: smp.right.z,
      tx: smp.tanH.x, tz: smp.tanH.z, grade: smp.grade, curv: smp.curvature, ri: infos[r + 1],
    });
  }

  // buffers
  const bufs = [out.get(mats.corr, true), null, out.get(mats.band, true), out.get(mats.band, true), out.get(mats.walk, true)];
  bufs[K_RAIL] = bufs[K_CORR];
  const vmap = [new Int32Array(nr * nc).fill(-1), new Int32Array(nr * nc).fill(-1), new Int32Array(nr * nc).fill(-1)];
  const bufIndex = [0, 0, 1, 1, 2];
  const tone = [1, 1, 1];

  const vert = (r, c, k) => {
    const bi = bufIndex[k];
    const key = r * nc + c;
    let v = vmap[bi][key];
    if (v >= 0) return v;
    const R = r + 1; // index into ghost-extended arrays
    const o = R * nc + c;
    const d = D[o], h = H[o];
    const S = samples[r];
    // central differences
    const cl = c > 0 ? c - 1 : c, cr = c < nc - 1 ? c + 1 : c;
    const hd = (H[R * nc + cr] - H[R * nc + cl]) / Math.max(1e-4, D[R * nc + cr] - D[R * nc + cl]);
    const hs = (H[(R + 1) * nc + c] - H[(R - 1) * nc + c]) / Math.max(1e-4, rowS[R + 1] - rowS[R - 1]);
    // N = Td x Ts with Td = (rx, hd, rz), Ts = (tx, grade + hs, tz)
    const ax = S.rx, ay = hd, az = S.rz, bx = S.tx, by = S.grade + hs, bz = S.tz;
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const il = 1 / Math.hypot(nx, ny, nz);
    nx *= il; ny *= il; nz *= il;
    surface.tone(S.ri, d, tone, 0);
    const b = bufs[k];
    v = b.v(S.px + S.rx * d, S.py + h, S.pz + S.rz * d, nx, ny, nz, S.s, d, tone[0], tone[1], tone[2]);
    vmap[bi][key] = v;
    return v;
  };

  for (let r = 0; r < nr - 1; r++) {
    const fillRails = lod > 0 || inInlayZone(ctx, (rows[r] + rows[r + 1]) / 2);
    for (let c = 0; c < nc - 1; c++) {
      const k = kind[c];
      if (k === K_RAIL && !fillRails) continue;
      const a = vert(r, c, k), b = vert(r, c + 1, k), cc = vert(r + 1, c + 1, k), d = vert(r + 1, c, k);
      bufs[k].quad(a, b, cc, d);
    }
  }
  return samples;
}

/** Inside a crossover's inlay zone (rails drawn as inlays over continuous paving). */
export function inInlayZone(ctx, s) {
  for (const c of ctx.layout.crossovers) {
    if (ctx.route.delta(c.s0 - ctx.inlayPad, s) >= 0 && ctx.route.delta(c.s1 + ctx.inlayPad, s) <= 0) return c;
  }
  return null;
}

/** Cheap ground slab under the whole street and the building blocks (crack catcher). */
export function buildSlab(ctx, chunk, out) {
  const { route, layout, mats } = ctx;
  const b = out.get(mats.slab, false);
  const step = 4;
  const n = Math.max(1, Math.ceil((chunk.s1 - chunk.s0) / step));
  const smp = {};
  let prev = -1;
  for (let i = 0; i <= n; i++) {
    const s = chunk.s0 + ((chunk.s1 - chunk.s0) * i) / n;
    route.sample(s, smp);
    const k = smp.curvature;
    let dl = layout.halfWidth(s, -1) + 45, dr = layout.halfWidth(s, 1) + 45;
    if (k > 1e-5) dl = Math.min(dl, 0.85 / k);
    if (k < -1e-5) dr = Math.min(dr, 0.85 / -k);
    const y = smp.pos.y + SLAB_H;
    const a = b.v(smp.pos.x - smp.right.x * dl, y, smp.pos.z - smp.right.z * dl, 0, 1, 0, s, -dl);
    b.v(smp.pos.x + smp.right.x * dr, y, smp.pos.z + smp.right.z * dr, 0, 1, 0, s, dr);
    if (prev >= 0) b.quad(prev, prev + 1, a + 1, a);
    prev = a;
  }
}

export { K_CORR, K_RAIL, K_BAND, K_GUTTER, K_WALK };
