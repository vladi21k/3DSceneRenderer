import {
  MAIN_RAILS, BAND_IN, CORRIDOR, GUTTER_OUT, SLAB_H, GROUT_W, RAIL_X0, RAIL_X1, FACADE_OVERLAP, railDist,
} from './constants.js';
import { colInfo, railGrime } from './surface.js';
import { crossoverPlan, paveCut, mainCut } from './crossover.js';

// Paving grid for one chunk: corridor (with gaps for the rails and, at lod 0, narrow
// mortar strips along them), light stone edge bands, dished gutters and sidewalks out
// under the facades (with two extra columns in front of each facade, so the dirt band
// along its base stays sharp). One height per grid vertex from the Surface; normals by central
// differences of the Surface's shading height on the grid (with ghost rows beyond the
// chunk ends so neighbouring chunks shade seamlessly). UVs: u = periodic street
// coordinate, v = d (corridor: the material places its rail grime by d), or metres from
// the gutter edge on the sidewalks so a full course runs along the gutter.
// Inside crossover zones the setts and the main rails' mortar go into cut variants
// (crossover.js): the diverging rails, swept with their own mortar, open the paving.

const K_CORR = 0, K_RAIL = 1, K_BAND = 2, K_GUTTER = 3, K_WALK = 4, K_GROUT = 5;
const ROWS_PER_STEP = 4;                   // buildPaving yields after this many rows
const GROUT_WAVE = 0.006;                  // hand-finished mortar edge wanders by ±6 mm
const SLAB_TONE = 0.3;                     // ground slab: dark, seen only through cracks
const SLAB_FAR = -1.2;                     // slab depth under the blocks (m)

/** Interior column offsets between a and b, denser next to rails. */
function fill(out, a, b, nearA, nearB, maxStep) {
  const near = [0.05, 0.14, 0.32];
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
  const d = [], kind = [], jit = [];
  // jit: 0, or a seed for the per-row wander of a mortar strip's outer edge
  const push = (x, k, j = 0) => { d.push(x); kind.push(k); jit.push(j); };
  const corrStep = lod === 0 ? 0.6 : 0.9;
  // left gutter + band
  const gutter = (a, b) => {
    const n = lod === 0 ? 3 : 2;
    for (let i = 0; i < n; i++) push(a + ((b - a) * i) / n, K_GUTTER);
  };
  gutter(-GUTTER_OUT, -CORRIDOR);
  push(-CORRIDOR, K_BAND);
  if (lod === 0) push(-(CORRIDOR + BAND_IN) / 2, K_BAND);
  // corridor with rails
  let x = -BAND_IN;
  let prevRail = false;
  for (let i = 0; i < MAIN_RAILS.length; i++) {
    const r = MAIN_RAILS[i];
    const tmp = [];
    if (lod === 0) {
      // [mortar after the previous rail] setts [mortar before this rail]
      const a = prevRail ? x + GROUT_W : x, b = r.lo - GROUT_W;
      if (prevRail) push(x, K_GROUT);
      fill(tmp, a, b, prevRail, true, corrStep);
      push(a, K_CORR, prevRail ? 2 * i : 0);
      for (const t of tmp) push(t, K_CORR);
      push(b, K_GROUT, 2 * i + 1);
    } else {
      fill(tmp, x, r.lo, false, false, corrStep);
      push(x, K_CORR);
      for (const t of tmp) push(t, K_CORR);
    }
    push(r.lo, K_RAIL);
    x = r.hi;
    prevRail = true;
  }
  {
    const tmp = [];
    if (lod === 0) {
      push(x, K_GROUT);
      fill(tmp, x + GROUT_W, BAND_IN, true, false, corrStep);
      push(x + GROUT_W, K_CORR, 2 * MAIN_RAILS.length);
    } else {
      fill(tmp, x, BAND_IN, false, false, corrStep);
      push(x, K_CORR);
    }
    for (const t of tmp) push(t, K_CORR);
  }
  push(BAND_IN, K_BAND);
  if (lod === 0) push((CORRIDOR + BAND_IN) / 2, K_BAND);
  gutter(CORRIDOR, GUTTER_OUT);
  push(GUTTER_OUT, K_WALK); // last fixed column: its interval kind is set per row assembly
  return { d, kind, jit, ci: d.map((x) => colInfo(x)) };
}

const FIXED = [fixedColumns(0), fixedColumns(1)];

/**
 * Build the paving of a chunk (a resumable step sequence: it yields 'paving' every
 * ROWS_PER_STEP rows, see street.js).
 * rows: sorted s values (first = chunk s0, last = chunk s1).
 * Returns per-row samples (reused by rails and details).
 */
export function* buildPaving(ctx, chunk, rows, out) {
  const { route, surface, mats } = ctx;
  const lod = chunk.lod;
  const fx = FIXED[lod];
  const nFixed = fx.d.length;
  const nr = rows.length;

  // sidewalk column counts (fixed per chunk so rows line up)
  const walkStep = lod === 0 ? 0.9 : 1.8;
  const infos = [];
  let maxL = 0, maxR = 0;
  const rowS = [rows[0] - (rows[1] - rows[0]), ...rows, rows[nr - 1] + (rows[nr - 1] - rows[nr - 2])];
  for (let i = 0; i < rowS.length; i++) {
    const ri = surface.rowInfo(rowS[i], {});
    ri.facL = facadeCol(ri, -1); ri.facR = facadeCol(ri, 1);
    infos.push(ri);
    maxL = Math.max(maxL, ri.facL - GUTTER_OUT);
    maxR = Math.max(maxR, ri.facR - GUTTER_OUT);
    if (i % ROWS_PER_STEP === ROWS_PER_STEP - 1) yield 'paving';
  }
  // per side: the outer edge, a column on the facade line (where the paving meets the
  // building's own ground line exactly), two columns of the facade's dirt band (FB1 and
  // FB2 in front of it), then even columns in to the gutter
  const eL = Math.max(2, Math.ceil(maxL / walkStep)), eR = Math.max(2, Math.ceil(maxR / walkStep));
  const nL = 3 + eL, nR = 3 + eR;
  const nc = nL + nFixed + nR; // left walk cols (excluding -GUTTER_OUT) + fixed + right walk cols
  const NR = rowS.length;

  // column offsets and heights per (ghost-extended) row
  const D = new Float32Array(NR * nc);
  const H = new Float32Array(NR * nc);     // geometric heights
  const HS = new Float32Array(NR * nc);    // shading heights (normals)
  const ciw = {};
  const kW = surface.kW;
  for (let r = 0; r < NR; r++) {
    const ri = infos[r];
    const o = r * nc;
    for (let k = 0; k < nL; k++) {
      const d = k === 0 ? ri.edgeL : -walkCol(ri.facL, k - 1, eL);
      D[o + k] = d; H[o + k] = surface.height(ri, d, colInfo(d, ciw)); HS[o + k] = surface.hShade;
    }
    for (let k = 0; k < nFixed; k++) {
      let d = fx.d[k];
      // (straight inside crossover zones, where swept mortar strips meet these edges)
      if (fx.jit[k]) d += GROUT_WAVE * (1 - ri.xo) * surface.fH.sample(ri.sp * kW, fx.jit[k] * 9.3);
      D[o + nL + k] = d; H[o + nL + k] = surface.height(ri, d, fx.ci[k]); HS[o + nL + k] = surface.hShade;
    }
    for (let k = 1; k <= nR; k++) {
      const c = nL + nFixed - 1 + k, d = k === nR ? ri.edgeR : walkCol(ri.facR, nR - 1 - k, eR);
      D[o + c] = d; H[o + c] = surface.height(ri, d, colInfo(d, ciw)); HS[o + c] = surface.hShade;
    }
    if (r % ROWS_PER_STEP === ROWS_PER_STEP - 1) yield 'paving';
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
      s: rows[r], u: surface.sp(rows[r]), px: smp.pos.x, py: smp.pos.y, pz: smp.pos.z, rx: smp.right.x, rz: smp.right.z,
      tx: smp.tanH.x, tz: smp.tanH.z, grade: smp.grade, curv: smp.curvature, ri: infos[r + 1],
    });
  }

  // buffers
  const nCorr = nFixed + 4;
  const bufs = [out.get(mats.corr, true, nr * nCorr + 64), null, out.get(mats.band, true, nr * 8 + 32), null, out.get(mats.walk, true, nr * (nL + nR + 4) + 64), null];
  bufs[K_GUTTER] = bufs[K_CORR];
  bufs[K_RAIL] = bufs[K_CORR];
  if (lod === 0) bufs[K_GROUT] = out.get(mats.grout, true, nr * 16 + 32);
  // vertex maps per buffer: corridor (+ gutters, rails), band, walk, grout, and the cut
  // variants of corridor and grout inside crossover zones
  const vmap = [];
  for (let i = 0; i < 6; i++) vmap.push(new Int32Array(nr * nc).fill(-1));
  const bufIndex = [0, 0, 1, 0, 2, 3];    // gutters: darker corridor setts
  const tone = [1, 1, 1];
  const cut4 = [0, 0, 0, 0];

  const vert = (r, c, k, plan) => {
    const zoned = plan && (k === K_CORR || k === K_GROUT);
    const bi = zoned ? (k === K_CORR ? 4 : 5) : bufIndex[k];
    const key = r * nc + c;
    let v = vmap[bi][key];
    if (v >= 0) return v;
    const R = r + 1; // index into ghost-extended arrays
    const o = R * nc + c;
    const d = D[o], h = H[o];
    const S = samples[r];
    // central differences of the shading height
    const cl = c > 0 ? c - 1 : c, cr = c < nc - 1 ? c + 1 : c;
    const hd = (HS[R * nc + cr] - HS[R * nc + cl]) / Math.max(1e-4, D[R * nc + cr] - D[R * nc + cl]);
    const hs = (HS[(R + 1) * nc + c] - HS[(R - 1) * nc + c]) / Math.max(1e-4, rowS[R + 1] - rowS[R - 1]);
    // N = Td x Ts with Td = (rx, hd, rz), Ts = (tx, grade + hs, tz)
    const ax = S.rx, ay = hd, az = S.rz, bx = S.tx, by = S.grade + hs, bz = S.tz;
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= il; ny *= il; nz *= il;
    const fc = c - nL;
    const ci = fc >= 0 && fc < nFixed ? fx.ci[fc] : colInfo(d, ciw);
    surface.tone(S.ri, d, tone, 0, ci);
    if (k === K_GROUT) {
      // mortar takes the tone and grime of the setts beside it, a little darker where it
      // meets them (dirt collects along the joint)
      const m = railDist(d) < GROUT_W * 0.5 ? 1.0 : 0.9;
      tone[0] *= m; tone[1] *= m; tone[2] *= m;
    }
    if (k === K_CORR || k === K_GROUT) {
      // relaid setts (wear.js): their tone over their strip, from joint to joint
      const rl = S.ri.relays;
      for (let i = 0; i < rl.length; i++) {
        const q = rl[i];
        if (d < q.d0 - 1e-4 || d > q.d1 + 1e-4) continue;
        tone[0] *= q.tone[0]; tone[1] *= q.tone[1]; tone[2] *= q.tone[2];
      }
    }
    let b = bufs[k];
    if (zoned) {
      if (k === K_CORR) {
        paveCut(plan, S.s, d, cut4);
        // grime along the diverging rails, as along the main ones
        const e = Math.max(0, Math.min(railOut(cut4[0]), railOut(cut4[3])));
        const g = 1 - 0.14 * railGrime(e) - 0.05 * Math.exp(-e / 0.045);
        tone[0] *= g; tone[1] *= g; tone[2] *= g;
        b = out.get(mats.cut.corr, true);
      } else {
        const m = nearestRail(d);
        mainCut(plan, m, S.s, d, 'mortar', m.g * (d - m.c), cut4);
        b = out.get(mats.cut.mortar, true);
      }
    }
    const vv = k === K_WALK ? (d < 0 ? -d : d) - GUTTER_OUT : d;
    v = b.v(S.px + S.rx * d, S.py + h, S.pz + S.rz * d, nx, ny, nz, S.u, vv, tone[0], tone[1], tone[2]);
    if (zoned) b.setCut(v, cut4[0], cut4[1], cut4[2], cut4[3]);
    vmap[bi][key] = v;
    return v;
  };

  // the built grid, so things lying on the paving can follow the actual mesh
  samples.grid = { rowS, nc, D, H };

  for (let r = 0; r < nr - 1; r++) {
    // lod 1 has no 3D rails: the paving runs under the far-field rail lines
    const fillRails = lod > 0;
    const zc = lod === 0 ? inCrossoverZone(ctx, (rows[r] + rows[r + 1]) / 2) : null;
    const plan = zc ? crossoverPlan(zc, ctx.delta) : null;
    for (let c = 0; c < nc - 1; c++) {
      const k = kind[c];
      if (k === K_RAIL && !fillRails) continue;
      const a = vert(r, c, k, plan), b = vert(r, c + 1, k, plan), cc = vert(r + 1, c + 1, k, plan), d = vert(r + 1, c, k, plan);
      const zoned = plan && (k === K_CORR || k === K_GROUT);
      (zoned ? out.get(k === K_CORR ? mats.cut.corr : mats.cut.mortar, true) : bufs[k]).quad(a, b, cc, d);
    }
    if (r % ROWS_PER_STEP === ROWS_PER_STEP - 1) yield 'paving';
  }
  return samples;
}

/**
 * Height of the built paving mesh (above the route elevation, like Surface.height) at
 * route (s, d), from the grid buildPaving kept on its samples: the same triangle split
 * as the mesh. Rows are at constant s and columns run nearly along it, so the cell is
 * found in (row fraction, interpolated column) space. The ghost rows extend the grid by
 * one row at both chunk ends; beyond them the end rows clamp. dl: signed route distance.
 */
export function pavingHeight(grid, s, d, dl) {
  const { rowS, nc, D, H } = grid;
  const x = rowS[0] + dl(rowS[0], s);
  let lo = 0, hi = rowS.length - 1;
  if (x <= rowS[0]) hi = 1;
  else if (x >= rowS[hi]) lo = hi - 1;
  else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rowS[m] <= x) lo = m; else hi = m; }
  const t = Math.max(0, Math.min(1, (x - rowS[lo]) / (rowS[hi] - rowS[lo])));
  const oa = lo * nc, ob = hi * nc;
  const dAt = (c) => D[oa + c] + (D[ob + c] - D[oa + c]) * t;
  let c = 0;
  if (d >= dAt(nc - 1)) c = nc - 2;
  else { let a = 0, b = nc - 1; while (b - a > 1) { const m = (a + b) >> 1; if (dAt(m) <= d) a = m; else b = m; } c = a; }
  const d0 = dAt(c), d1 = dAt(c + 1);
  const u = Math.max(0, Math.min(1, (d - d0) / Math.max(1e-6, d1 - d0)));
  const Ha = H[oa + c], Hb = H[oa + c + 1], Hc = H[ob + c + 1], Hd = H[ob + c];
  // quads are split a-b-c / a-c-d (a = row lo, column c; c = row hi, column c+1)
  return u >= t ? Ha + (Hb - Ha) * u + (Hc - Hb) * t : Ha + (Hc - Hd) * u + (Hd - Ha) * t;
}

// the facade's dirt band columns stand this far in front of the facade line (m), less
// where the sidewalk is narrow (the band fades out from 0.1 to 0.5 m, see Surface.tone)
const FB1 = 0.25, FB2 = 0.6;

/** |d| of sidewalk column j (0 = on the facade line, 1-2 = the facade band columns, then
 *  nEven columns evenly in towards the gutter edge; GUTTER_OUT itself is a fixed column). */
function walkCol(fac, j, nEven) {
  const room = fac - GUTTER_OUT;
  if (j === 0) return fac;
  const f1 = fac - Math.min(FB1, room * 0.25);
  if (j === 1) return f1;
  const f2 = fac - Math.min(FB2, room * 0.5);
  return f2 + ((GUTTER_OUT - f2) * (j - 2)) / nEven;
}

/** |d| of the sidewalk column on the facade line of the row (side -1 | 1); in mouths and
 *  gaps, FACADE_OVERLAP inside the outer edge. */
function facadeCol(ri, side) {
  const e = side < 0 ? -ri.edgeL : ri.edgeR, f = side < 0 ? ri.fL : ri.fR;
  const a = f.d === f.d ? Math.abs(f.d) : e - FACADE_OVERLAP;
  return Math.min(e - 0.05, Math.max(GUTTER_OUT + 0.3, a));
}

/** Distance (m) outside a diverging rail's span from its rail-local coordinate. */
const railOut = (x) => (x < RAIL_X0 ? RAIL_X0 - x : x > RAIL_X1 ? x - RAIL_X1 : 0);

/** Main rail nearest to offset d. */
function nearestRail(d) {
  let best = MAIN_RAILS[0], e = 1e9;
  for (const m of MAIN_RAILS) { const v = Math.abs(d - m.c); if (v < e) { e = v; best = m; } }
  return best;
}

/** The crossover whose zone (its length plus ctx.zonePad at both ends) contains s, where
 *  rails and paving carry cut attributes. */
export function inCrossoverZone(ctx, s) {
  for (const c of ctx.layout.crossovers) {
    if (ctx.delta(c.s0 - ctx.zonePad, s) >= 0 && ctx.delta(c.s1 + ctx.zonePad, s) <= 0) return c;
  }
  return null;
}

/** Cheap ground slab under the whole street and the building blocks (crack catcher).
 *  It is drawn with the sidewalk (dark tone): no draw call or material of its own.
 *  SLAB_H below the street, falling to SLAB_FAR under the blocks, so it stays below
 *  side streets that climb or fall away from the junction. */
export function buildSlab(ctx, chunk, out) {
  const { route, layout, mats } = ctx;
  const b = out.get(mats.walk, true);
  const T = SLAB_TONE;
  const step = 4;
  const n = Math.max(1, Math.ceil((chunk.s1 - chunk.s0) / step));
  const smp = {};
  const D = [0, 0, 0, 0], Y = [SLAB_FAR, SLAB_H, SLAB_H, SLAB_FAR];
  let prev = -1;
  for (let i = 0; i <= n; i++) {
    const s = chunk.s0 + ((chunk.s1 - chunk.s0) * i) / n;
    route.sample(s, smp);
    const k = smp.curvature;
    const hl = layout.halfWidth(s, -1), hr = layout.halfWidth(s, 1);
    let dl = hl + 45, dr = hr + 45;
    if (k > 1e-5) dl = Math.min(dl, 0.85 / k);
    if (k < -1e-5) dr = Math.min(dr, 0.85 / -k);
    D[0] = -dl; D[1] = -Math.min(hl + 2, dl - 1); D[2] = Math.min(hr + 2, dr - 1); D[3] = dr;
    const u = ctx.surface.sp(s);
    const a = b.n;
    for (let j = 0; j < 4; j++) {
      b.v(smp.pos.x + smp.right.x * D[j], smp.pos.y + Y[j], smp.pos.z + smp.right.z * D[j], 0, 1, 0, u, D[j], T, T, T);
    }
    if (prev >= 0) for (let j = 0; j < 3; j++) b.quad(prev + j, prev + j + 1, a + j + 1, a + j);
    prev = a;
  }
}

export { K_CORR, K_RAIL, K_BAND, K_GUTTER, K_WALK, K_GROUT };
