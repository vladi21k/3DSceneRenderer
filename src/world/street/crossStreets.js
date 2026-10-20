import { MAIN_RAILS, BAND_IN, GUTTER_OUT, SIDEWALK_RISE, GROUT_W } from './constants.js';
import { RNG } from '../../core/rng.js';
import { SIDE_LOT_START } from '../layout.js';
import { sideFrame, sidePlan, buildSideWear, buildSideIron } from './sideAsphalt.js';
import { paintWear } from './lines.js';

// Cross streets: the side street from the main facade line out to depth + 16 m (+30 m
// run-out): sidewalks, granite kerbs dropped to a ramp at the mouth (the side street is
// closed by bollards behind a light granite edge strip), an aged asphalt carriageway with
// a slight crown, blotchy weathering and dirt along the kerbs, a zebra crossing at the
// mouth and a worn dashed centre line further out; at lod 0 the wear of sideAsphalt.js
// (covers, repairs, cracks, tyre polish, oil drips). The first row reuses the exact mouth
// points of the main sidewalk so the two surfaces meet without a seam. From there the
// side street ramps linearly, over the corner returns (which end SIDE_LOT_START out),
// to the ground its side-street lots stand on (their frames' ground at both facade
// lines, interpolated across the street).
// Also the pedestrian crossing over the tram corridor at the junction (zebra stripes
// between the rails) with tactile warning strips at both corridor edges.

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** Blend from the mouth heights (x = 0) to the side-street level, x metres out. */
const ramp = (x) => Math.min(1, x / SIDE_LOT_START);
const KERB_W = 0.16;
const KERB_H = 0.12;
const EDGE_X = 0.36;          // granite edge strip across the carriageway at the mouth
const ASPHALT_TINT = 1.16;    // aged, oxidised binder: greyer than the library's fresh mix

function dims(c) {
  const w = c.width;
  const sw = Math.min(2.6, Math.max(1.6, w * 0.2));
  return { w, sw, half: w / 2, road: w / 2 - sw };
}

/** Column positions (mouth-line coordinate a) of a side street; main paving rows are
 *  inserted at c.s + a so the mouth seam shares vertices. */
export function sideColumns(c) {
  const { half, road } = dims(c);
  return [-half, -half + 0.7, -road - KERB_W, -road - 0.001, -road, -road * 0.5, 0, road * 0.5, road, road + 0.001, road + KERB_W, half - 0.7, half];
}

/** Ground of a side street at its two facade lines ([a < 0, a > 0], world y): where the
 *  first side-street lot on each edge starts (its frame's ground at the end nearer the
 *  junction `start`), else `flat`. */
function sideLevel(ctx, c, side, start, flat) {
  const key = c.s * 4 + side;
  let v = LEVELS.get(key);
  if (!v) {
    v = [flat, flat];
    for (const edge of [-1, 1]) {
      let first = null;
      for (const lot of ctx.layout.sideLots) {
        if (lot.cross === c && lot.side === side && lot.edge === edge && (!first || lot.x0 < first.x0)) first = lot;
      }
      if (!first) continue;
      const F = first.frame, o = F.origin;
      const d0 = Math.hypot(o.x - start.x, o.z - start.z);
      const d1 = Math.hypot(o.x + F.uDir.x * F.width - start.x, o.z + F.uDir.z * F.width - start.z);
      v[edge > 0 ? 1 : 0] = d0 <= d1 ? F.ground0 : F.ground1;
    }
    LEVELS.set(key, v);
  }
  return v;
}
const LEVELS = new Map();

/** The mouth profile of side street c on `side` (cached on its mouth, see
 *  Surface.mouth): the column offsets `cols` (mouth-line coordinate a, with a column
 *  0.8 m beyond each facade line), the main paving's points on the mouth line at those
 *  columns (`pts`, world; `base`: their y), where the side street's first row meets the
 *  main sidewalk without a seam, and the ground the side street ramps to (`level`, world
 *  y at its two facade lines, see sideLevel). Also completes the mouth frame for other
 *  modules (half, road, sw, kerbH; see street.js mouth()). */
export function sideProfile(ctx, c, side) {
  const { route, surface } = ctx;
  const m = surface.mouth(c, side);
  if (m.prof) return m.prof;
  const { half, road, sw } = dims(c);
  const cols = [-half - 0.8, ...sideColumns(c), half + 0.8];
  const base = new Float64Array(cols.length);
  const pts = [];
  for (let j = 0; j < cols.length; j++) {
    const a = Math.max(-half, Math.min(half, cols[j]));
    const s = c.s + a;
    const d = surface.mouthD(m, s);
    // the main paving's own vertex there (heightAt already holds the shared ground, so
    // it is added to the route elevation, not passed to toWorld as a height above it)
    const p = route.toWorld(s, d, 0);
    p.y = route.elevation(s) + surface.heightAt(s, d);
    pts.push(p);
    base[j] = p.y;
  }
  const level = sideLevel(ctx, c, side, m.start, m.start.y + SIDEWALK_RISE);
  m.half = half; m.road = road; m.sw = sw; m.kerbH = KERB_H; m.rampX = SIDE_LOT_START;
  m.level = level;
  m.prof = { cols, base, pts, level, half, road };
  return m.prof;
}

/** World y of side street c's paving (on `side`) at mouth coordinates (a, x): a across
 *  from its centre line (along the mouth line, + along route travel), x out from the main
 *  facade line (the side street's own frame). The same surface the street mesh is built
 *  from: the main paving's heights along the mouth, ramped over SIDE_LOT_START metres to
 *  the ground of the side street's lots, the carriageway a kerb (KERB_H) down from a few
 *  metres out, with a slight crown. Allocation-free. */
export function sideHeight(ctx, c, side, a, x) {
  const P = sideProfile(ctx, c, side);
  const cols = P.cols, base = P.base, n = cols.length;
  let j = 0;
  while (j < n - 2 && cols[j + 1] < a) j++;
  const t = Math.max(0, Math.min(1, (a - cols[j]) / (cols[j + 1] - cols[j] || 1)));
  const b0 = base[j] + (base[j + 1] - base[j]) * t;
  const xx = x > 0 ? x : 0;
  const half = P.half, lv = P.level;
  const tgt = lv[0] + (lv[1] - lv[0]) * Math.max(0, Math.min(1, (a + half) / (2 * half)));
  return b0 + (tgt - b0) * ramp(xx) + localH(a, xx, P.road);
}

/** sideHeight with its numbers in a Float64Array: reads io[0] (a) and io[1] (x), writes
 *  the world y to io[2]. No number crosses a call boundary (a double returned from or
 *  passed to a call that is not inlined is boxed), so per-pedestrian loops allocate nothing. */
export function sideHeightIO(ctx, c, side, io) {
  const P = sideProfile(ctx, c, side);
  const a = io[0], x = io[1];
  const cols = P.cols, base = P.base, n = cols.length;
  let j = 0;
  while (j < n - 2 && cols[j + 1] < a) j++;
  const dc = cols[j + 1] - cols[j];
  let t = (a - cols[j]) / (dc !== 0 ? dc : 1);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const b0 = base[j] + (base[j + 1] - base[j]) * t;
  const xx = x > 0 ? x : 0;
  const half = P.half, lv = P.level;
  let ta = (a + half) / (2 * half);
  ta = ta < 0 ? 0 : ta > 1 ? 1 : ta;
  const tgt = lv[0] + (lv[1] - lv[0]) * ta;
  const rp = xx / SIDE_LOT_START;
  let y = b0 + (tgt - b0) * (rp < 1 ? rp : 1);
  // localH, inline
  const aa = a < 0 ? -a : a, road = P.road;
  if (aa <= road) {
    let r = (xx - 2.5) / 5;
    r = r <= 0 ? 0 : r >= 1 ? 1 : r * r * (3 - 2 * r);
    const q = aa / road;
    y += (-KERB_H + 0.022 * (1 - q * q)) * r;
  }
  io[2] = y;
}

/** The wear of side street c on `side` (cached on its mouth): its street frame F
 *  (sideAsphalt.js sideFrame, over the side street's surface) and its wear plan
 *  (sidePlan). The street's prefetch makes it ahead (see street.js planChunk). */
export function sideWear(ctx, c, side) {
  const m = ctx.surface.mouth(c, side);
  if (m.wear) return m.wear;
  const P = sideProfile(ctx, c, side);
  const at = (a, x, lift = 0.002) => [m.start.x + m.along.x * a + m.dirOut.x * x, sideHeight(ctx, c, side, a, x) + lift, m.start.z + m.along.z * a + m.dirOut.z * x];
  const F = sideFrame(m, at, P.road);
  m.wear = { F, plan: sidePlan(c, side, m, F, EDGE_X) };
  return m.wear;
}

/** Height profile of the side street relative to the blended base level. */
function localH(a, x, road) {
  const ramp = smooth((x - 2.5) / 5);
  const aa = Math.abs(a);
  if (aa > road) return 0;                                     // sidewalks and kerb tops
  const crown = 0.022 * (1 - (aa / road) ** 2);
  return (-KERB_H + crown) * ramp;
}

/** Side street c on `side` (the part built by chunk): resumable (see street.js), yields
 *  'cross' between its parts. */
export function* buildCrossStreet(ctx, c, side, chunk, bufs, lines) {
  const { surface, mats } = ctx;
  const m = surface.mouth(c, side);
  const { half, road } = dims(c);
  const lod = chunk.lod;
  const xs = [0, EDGE_X, 1.5, 3, 4.5, 6, 7.5, 9, 12, SIDE_LOT_START];
  const xStep = lod === 0 ? 6 : 15;
  for (let x = SIDE_LOT_START + xStep; x < m.len; x += xStep) xs.push(x);
  xs.push(m.len);
  const prof = sideProfile(ctx, c, side);
  const level = prof.level;
  const target = (a) => level[0] + (level[1] - level[0]) * Math.max(0, Math.min(1, (a + half) / (2 * half)));
  const cols = prof.cols, base = prof.base, mouthPts = prof.pts;
  const nc = cols.length, nr = xs.length;

  // grid positions and heights
  const P = new Float32Array(nr * nc * 3);
  for (let i = 0; i < nr; i++) {
    const x = xs[i];
    const k = ramp(x);
    for (let j = 0; j < nc; j++) {
      const a = cols[j];
      const o = (i * nc + j) * 3;
      let px, pz;
      if (i === 0 && Math.abs(a) <= half) { px = mouthPts[j].x; pz = mouthPts[j].z; }
      else {
        px = m.start.x + m.along.x * a + m.dirOut.x * x;
        pz = m.start.z + m.along.z * a + m.dirOut.z * x;
      }
      P[o] = px; P[o + 2] = pz;
      P[o + 1] = base[j] + (target(a) - base[j]) * k + localH(a, x, road);
    }
  }

  yield 'cross';
  // strips [j0, j1, material]: sidewalk | kerb top | carriageway | kerb top | sidewalk
  const jKbL = cols.indexOf(-road - KERB_W), jKfL = cols.indexOf(-road - 0.001), jRL = cols.indexOf(-road);
  const jRR = cols.indexOf(road), jKfR = cols.indexOf(road + 0.001), jKbR = cols.indexOf(road + KERB_W);
  // [j0, j1, material, i0, i1]: the carriageway starts with the granite edge strip
  const strips = [
    [0, jKbL, mats.walk, 0, nr - 1],
    [jKbL, jKfL, mats.kerb, 0, nr - 1],
    [jRL, jRR, mats.band, 0, 1],
    [jRL, jRR, mats.asphalt, 1, nr - 1],
    [jKfR, jKbR, mats.kerb, 0, nr - 1],
    [jKbR, nc - 1, mats.walk, 0, nr - 1],
  ];
  const f = surface.fG;
  for (const [j0, j1, mat, i0, i1] of strips) {
    const b = bufs.get(mat, true);
    const W = j1 - j0 + 1;
    const idx = new Int32Array(nr * W);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const o = (i * nc + j) * 3;
        // normal from grid neighbours (within the strip)
        const jl = Math.max(j0, j - 1), jr = Math.min(j1, j + 1), il = Math.max(0, i - 1), ir = Math.min(nr - 1, i + 1);
        const oa = (i * nc + jl) * 3, ob = (i * nc + jr) * 3, oc = (il * nc + j) * 3, od = (ir * nc + j) * 3;
        const ax = P[ob] - P[oa], ay = P[ob + 1] - P[oa + 1], az = P[ob + 2] - P[oa + 2];
        const bx = P[od] - P[oc], by = P[od + 1] - P[oc + 1], bz = P[od + 2] - P[oc + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const il2 = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
        const x = xs[i], a = cols[j];
        let t = (1 + 0.08 * f.sample(x * 0.5 + 300, a * 0.5)) * (1 + 0.05 * f.sample(x * 2.1, a * 2.1 + 90));
        if (mat === mats.asphalt) {
          // weathered in broad blotches, dirt along the kerbs
          t *= ASPHALT_TINT * (1 + 0.14 * f.sample(x * 0.11 + 57, a * 0.11 + 7)) * (1 - 0.12 * Math.exp(-(road - Math.abs(a)) / 0.3));
          const wt = Math.abs(a) - road * 0.5;
          t *= 1 - 0.07 * Math.exp(-(wt * wt) / 0.4) * smooth((x - 4) / 6);  // polished wheel tracks
        }
        if (mat === mats.walk) t *= 1 - 0.12 * Math.exp(-Math.max(0, half - Math.abs(a)) / 0.4);
        idx[i * (j1 - j0 + 1) + (j - j0)] = b.v(P[o], P[o + 1], P[o + 2], nx * il2, ny * il2, nz * il2, x, a, t, t * 0.995, t * 0.985);
      }
    }
    // winding: a runs along `along`; dirOut is the extrusion. Choose the front face up.
    const flip = side > 0 ? false : true;
    for (let i = i0; i < i1; i++) {
      for (let j = 0; j < W - 1; j++) {
        const q0 = idx[i * W + j], q1 = idx[i * W + j + 1], q2 = idx[(i + 1) * W + j + 1], q3 = idx[(i + 1) * W + j];
        if (flip) b.quad(q0, q1, q2, q3); else b.quad(q0, q3, q2, q1);
      }
    }
  }

  // kerb faces (vertical, facing the carriageway); they vanish where the kerb drops
  const kb = bufs.get(mats.kerb, true);
  for (const [jTop, jBot, sgn] of [[jKfL, jRL, -1], [jKfR, jRR, 1]]) {
    let prev = -1;
    const nx = -m.along.x * sgn, nz = -m.along.z * sgn;
    for (let i = 0; i < nr; i++) {
      const ot = (i * nc + jTop) * 3, o = (i * nc + jBot) * 3;
      const top = P[ot + 1], bot = P[o + 1];
      const v = kb.v(P[o], top, P[o + 2], nx, 0, nz, xs[i], 0, 0.95, 0.95, 0.95);
      kb.v(P[o], bot, P[o + 2], nx, 0, nz, xs[i], top - bot, 0.78, 0.77, 0.76);
      if (prev >= 0 && top - bot > 0.002) {
        if ((sgn > 0) !== (side > 0)) kb.quad(prev, v, v + 1, prev + 1);
        else kb.quad(prev, prev + 1, v + 1, v);
      }
      prev = v;
    }
  }

  yield 'cross';
  if (lod > 0 || !lines) return;
  // surface point at mouth coordinates (a, x), lifted
  const pt = (a, x, lift = 0.002) => [m.start.x + m.along.x * a + m.dirOut.x * x, sideHeight(ctx, c, side, a, x) + lift, m.start.z + m.along.z * a + m.dirOut.z * x];
  const { F, plan } = sideWear(ctx, c, side);
  yield 'cross';
  // wear first: the paint lies over it
  yield* buildSideWear(F, plan, lines);

  // zebra across the carriageway near the mouth (stripes along the side street)
  const rx = -m.dirOut.z, rz = m.dirOut.x; // right of the side street direction
  const nStripes = Math.max(2, Math.round((2 * road - 0.4) / 1.0));
  const sw = (2 * road - 0.4) / nStripes;
  // wheel paths (lane centres ± 0.78 m) wear the stripes they run along much faster
  const wheels = [-road / 2 - 0.78, -road / 2 + 0.78, road / 2 - 0.78, road / 2 + 0.78];
  const wr = RNG.from('zebra', Math.round(c.s * 10), side);
  for (let k = 0; k < nStripes; k++) {
    const a = -road + 0.2 + sw * (k + 0.5);
    let w = 0;
    for (const t of wheels) w = Math.max(w, Math.exp(-((a - t) ** 2) / 0.15));
    const arr = [];
    for (let x = 3.4; x <= 6.41; x += 0.5) { const p = pt(a, x); arr.push(p[0], p[1], p[2], rx, rz, x - 3.4); }
    lines.stripe.add(arr, Math.min(0.25, sw * 0.27), 3.0, wr.range(0.75, 1.1) + 1.6 * w);
  }
  // dashed centre line further out, unevenly worn (each dash its own age), broken where a
  // manhole lies on the crown; the ribbons reach past the dash ends for their coverage
  const crown = plan.covers.filter((q) => q.type === 'manhole' && Math.abs(q.v) < 0.5);
  for (let x0 = SIDE_LOT_START + 1; x0 + 3 < m.len - 4; x0 += 9) {
    const wear = wr.range(1.0, 1.75);
    if (crown.some((q) => q.u + 0.5 > x0 && q.u - 0.5 < x0 + 3)) continue;
    const arr = [];
    for (const x of [x0 - 0.03, x0 + 1.5, x0 + 3.03]) { const p = pt(0, x); arr.push(p[0], p[1], p[2], rx, rz, x - x0); }
    lines.stripe.add(arr, 0.06, 3.0, wear);
  }
  yield 'cross';
  buildSideIron(F, plan, bufs, ctx.mats);
}

/** Pedestrian crossing over the tram corridor at a cross street. */
export function buildCorridorCrossing(ctx, c, chunk, bufs, lines) {
  if (chunk.lod > 0) return;
  const { route, surface } = ctx;
  const L = 4.0;
  // start on a bed joint of the setts (paving u = surface.sp(s), courses every 0.2 m), so
  // the paint's cracks along the joints (lines.js) lie on the real ones
  const kP = surface.sp(1);
  const sA = (Math.round(surface.sp(c.s - L / 2) / 0.2) * 0.2) / kP;
  // free lateral intervals between rails (3 cm clear of the mortar strips)
  const free = [];
  const clear = GROUT_W + 0.03;
  let x = -BAND_IN + 0.12;
  for (const r of MAIN_RAILS) { free.push([x, r.lo - clear]); x = r.hi + clear; }
  free.push([x, BAND_IN - 0.12]);
  const smp = {};
  const rowsS = [];
  for (let k = 0; k <= 8; k++) rowsS.push(sA + (L * k) / 8);
  const rowInfos = rowsS.map((s) => surface.rowInfo(s, {}));
  const wr = RNG.from('corridor-zebra', Math.round(c.s * 10));
  free.forEach(([a, b], iv) => {
    const span = b - a;
    const n = Math.max(1, Math.round((span + 0.45) / 0.95));
    const w = Math.min(0.55, (span - (n - 1) * 0.45) / n);
    const used = n * w + (n - 1) * 0.45;
    // the outermost bars of an interval between rails lie beside them (lines.js wears and
    // greys the film along that edge)
    const margin = (span - used) / 2, nearRail = margin < 0.15;
    let d = a + margin + w / 2;
    for (let k = 0; k < n; k++, d += w + 0.45) {
      if (w < 0.2) continue;
      const wear = wr.range(0.7, 1.45);       // trodden unevenly
      const lo = nearRail && k === 0 && iv > 0, hi = nearRail && k === n - 1 && iv < free.length - 1;
      const arr = [];
      for (let i = 0; i < rowsS.length; i++) {
        route.sample(rowsS[i], smp);
        const h = surface.height(rowInfos[i], d) + 0.0015;
        arr.push(smp.pos.x + smp.right.x * d, smp.pos.y + h, smp.pos.z + smp.right.z * d, smp.right.x, smp.right.z, (rowsS[i] - sA) * kP);
      }
      lines.stripe.add(arr, w / 2, L * kP, paintWear(wear, true, lo, hi));
    }
  });
  // tactile warning strips on both sides, just outside the gutters
  for (const sd of [-1, 1]) {
    const pole = ctx.layout.inChunk('poles', chunk.index).concat(ctx.layout.inChunk('poles', chunk.index + 1), ctx.layout.inChunk('poles', chunk.index - 1))
      .some((p) => p.side === sd && Math.abs(route.delta(p.s, c.s)) < L / 2 + 0.4);
    const d0 = GUTTER_OUT + 0.08, d1 = GUTTER_OUT + 0.68;
    if (pole) continue;
    tactileSlab(ctx, bufs, sA + 0.3, sA + L - 0.3, sd * d0, sd * d1);
  }
}

/** Slightly raised tactile slab between (s0, s1) x (dA, dB) with bevelled sides. */
export function tactileSlab(ctx, bufs, s0, s1, dA, dB) {
  const { route, surface, mats } = ctx;
  const b = bufs.get(mats.tactile, true);
  const da = Math.min(dA, dB), db = Math.max(dA, dB);
  const n = Math.max(1, Math.ceil((s1 - s0) / 0.6));
  const lift = 0.006;
  // trodden grime: the light concrete is greyed, unevenly along the strip
  const gr = RNG.from('tactile', Math.round(s0 * 10), Math.round(dA * 10));
  const tone = () => 0.76 + 0.08 * gr.next();
  const smp = {};
  const ri = {};
  let prev = -1;
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    route.sample(s, smp);
    surface.rowInfo(s, ri);
    const ha = surface.height(ri, da), hb = surface.height(ri, db);
    const hm = Math.max(ha, hb) + lift;
    const x = smp.pos.x, z = smp.pos.z, y = smp.pos.y, rx = smp.right.x, rz = smp.right.z;
    // outer bottom, top, top, outer bottom
    const t = tone(), e = 0.85 * t;
    const v = b.v(x + rx * (da - 0.01), y + ha - 0.002, z + rz * (da - 0.01), -rx * 0.5, 0.86, -rz * 0.5, s, da - 0.01, e, e, e);
    b.v(x + rx * da, y + hm, z + rz * da, 0, 1, 0, s, da, t, t, t);
    b.v(x + rx * db, y + hm, z + rz * db, 0, 1, 0, s, db, t, t, t);
    b.v(x + rx * (db + 0.01), y + hb - 0.002, z + rz * (db + 0.01), rx * 0.5, 0.86, rz * 0.5, s, db + 0.01, e, e, e);
    if (prev >= 0) {
      for (let k = 0; k < 3; k++) b.quad(prev + k, prev + k + 1, v + k + 1, v + k);
    }
    prev = v;
  }
  // end caps
  for (const [i, sgn] of [[0, -1], [n, 1]]) {
    const s = s0 + ((s1 - s0) * i) / n;
    route.sample(s, smp);
    surface.rowInfo(s, ri);
    const ha = surface.height(ri, da), hb = surface.height(ri, db), hm = Math.max(ha, hb) + lift;
    const tx = smp.tanH.x * sgn, tz = smp.tanH.z * sgn;
    const o = 0.01 * sgn;
    const P = (d, h, off) => [smp.pos.x + smp.right.x * d + smp.tanH.x * off, smp.pos.y + h, smp.pos.z + smp.right.z * d + smp.tanH.z * off];
    const p0 = P(da, hm, 0), p1 = P(db, hm, 0), p2 = P(db, hb - 0.002, o), p3 = P(da, ha - 0.002, o);
    const q = [p0, p1, p2, p3].map((p, k) => b.v(p[0], p[1], p[2], tx * 0.5, 0.86, tz * 0.5, s, k < 2 ? 0 : 0.01, 0.68, 0.68, 0.68));
    if (sgn > 0) b.quad(q[0], q[1], q[2], q[3]); else b.quad(q[0], q[3], q[2], q[1]);
  }
}
