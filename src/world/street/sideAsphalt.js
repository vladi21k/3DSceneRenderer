import { RNG, noise1 } from '../../core/rng.js';
import { IRON_REGIONS } from './textures.js';
import { PATCH_PAD, patchWear } from './lines.js';

// The worn asphalt of a side street, planned once per street (and side) and built at lod 0:
//  - cast iron: gully grates along both kerbs every 20-32 m, one or two manholes in a lane
//    centre or on the crown, valve caps and a utility plate near the kerbs;
//  - saw-cut repairs: reinstatement squares around manholes and valves (the cover cut out),
//    trenches across the carriageway or along a lane, and a few rectangular patches, in a
//    fresh black or an aged grey mix, edged by sealed joints;
//  - cracks: transverse thermal cracks every 4-13 m, the lane joint beside the centre
//    line and the seams along the gutters, mostly overbanded with bitumen, some open
//    hairlines, and short fatigue cracks in the wheel paths; repairs and covers cut them;
//  - tyre polish along the four wheel paths, oil drips and dirt along the lane centres,
//    lighter dust swept to the kerb sides.
// Everything is placed in an orthonormal street frame (u out along the street, v across
// it), so covers stay square and round on skewed junctions.

const ATLAS = 1024;
const LIFT = 0.0015;            // overlays above the asphalt (they also have a polygon offset)
const COVER_LIFT = 0.003;
const PLANS = new Map();

/** Orthonormal frame of a side street over its surface function at(a, x, lift) (grid
 *  coordinates: a along the main street, x out along dirOut): u out along the street, v
 *  across it, to the right of dirOut. The carriageway spans |v| <= roadV. */
export function sideFrame(m, at, road) {
  const ox = m.dirOut.x, oz = m.dirOut.z;
  const kA = -m.along.x * oz + m.along.z * ox;   // v per unit of a
  const kU = m.along.x * ox + m.along.z * oz;    // u per unit of a
  const F = {
    roadV: road * Math.abs(kA),
    /** World point on the surface (lifted) at (u, v). */
    P(u, v, lift = 0) { const a = v / kA; return at(a, u - kU * a, lift); },
    /** (u, v) of grid point (a, x). */
    uv(a, x) { return [x + kU * a, kA * a]; },
    H(u, v) { return F.P(u, v)[1]; },
    /** World horizontal vector of the frame direction (du, dv). */
    dir(du, dv) { return [ox * du - oz * dv, oz * du + ox * dv]; },
  };
  return F;
}

/** LineBuf points (stride 7) along a polyline of (u, v) points [u0, v0, u1, v1, ...]:
 *  the lifted surface point, the right vector, the distance along (from along0) and the
 *  surface's slope along the right vector (wide ribbons lie on the crown). */
function ribbon(F, uv, along0 = 0) {
  const n = uv.length >> 1, out = new Array(n * 7);
  let s = along0;
  const e = 0.2;
  for (let i = 0; i < n; i++) {
    const u = uv[2 * i], v = uv[2 * i + 1];
    const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
    let tu = uv[2 * i1] - uv[2 * i0], tv = uv[2 * i1 + 1] - uv[2 * i0 + 1];
    const tl = Math.hypot(tu, tv) || 1;
    tu /= tl; tv /= tl;
    if (i > 0) s += Math.hypot(u - uv[2 * i - 2], v - uv[2 * i - 1]);
    const p = F.P(u, v, LIFT), r = F.dir(-tv, tu);
    const o = i * 7;
    out[o] = p[0]; out[o + 1] = p[1]; out[o + 2] = p[2]; out[o + 3] = r[0]; out[o + 4] = r[1]; out[o + 5] = s;
    out[o + 6] = (F.H(u - tv * e, v + tu * e) - F.H(u + tv * e, v - tu * e)) / (2 * e);
  }
  return out;
}

/** Crack path offset in [-1, 1] at t (m): a wandering course with smaller kinks. */
const wander = (t, seed) => 0.62 * noise1(t * 0.45, seed) + 0.28 * noise1(t * 1.9, seed + 1) + 0.1 * noise1(t * 8.5, seed + 2);

/** Points from (ua, va) to (ub, vb), at most `step` apart. */
function straight(ua, va, ub, vb, step) {
  const n = Math.max(1, Math.ceil(Math.hypot(ub - ua, vb - va) / step)), out = [];
  for (let i = 0; i <= n; i++) out.push(ua + ((ub - ua) * i) / n, va + ((vb - va) * i) / n);
  return out;
}

/** Deterministic wear plan of side street c on `side` (cached). m: its mouth; F: sideFrame;
 *  edgeX: where the asphalt meets the granite edge strip across the mouth (grid x). */
export function sidePlan(c, side, m, F, edgeX) {
  const key = c.s * 4 + side;
  let plan = PLANS.get(key);
  if (plan) return plan;
  const rng = RNG.from('side-asphalt', Math.round(c.s * 10), side);
  const R = F.roadV, u0 = 1.6, u1 = m.len - 2.5;
  const covers = [], patches = [], cracks = [], polish = [], stains = [];
  // rectangle of a patch in (u, v)
  const box = (p) => (p.dir === 'u'
    ? [p.u - p.len / 2, p.u + p.len / 2, p.v - p.half, p.v + p.half]
    : [p.u - p.half, p.u + p.half, p.v - p.len / 2, p.v + p.len / 2]);
  const inCover = (u, v, r) => covers.some((q) => (u - q.u) ** 2 + (v - q.v) ** 2 < (q.r + r) ** 2);
  const inPatch = (u, v, r) => patches.some((p) => {
    const b = p.box;
    return u > b[0] - r && u < b[1] + r && v > b[2] - r && v < b[3] + r;
  });
  const boxFree = (b, r) => !covers.some((q) => q.u > b[0] - q.r - r && q.u < b[1] + q.r + r && q.v > b[2] - q.r - r && q.v < b[3] + q.r + r)
    && !patches.some((p) => p.box[0] < b[1] + r && p.box[1] > b[0] - r && p.box[2] < b[3] + r && p.box[3] > b[2] - r);
  const addPatch = (p) => { p.box = box(p); patches.push(p); };
  const freshOrAged = () => (rng.chance(0.62) ? -rng.range(0.45, 0.9) : rng.range(0.3, 0.75));

  // gully grates in both gutters, the first just past the ramp
  for (const k of [-1, 1]) {
    for (let u = 8.2 + rng.range(-0.6, 0.6); u < u1 - 2; u += rng.range(20, 32)) covers.push({ type: 'gully', u, v: k * (R - 0.2), rot: 0, r: 0.35 });
  }
  // manholes in a lane centre (or on the crown of a wide street), most in a reinstatement square
  const nMan = rng.int(1, 2);
  for (let i = 0; i < nMan; i++) {
    for (let t = 0; t < 8; t++) {
      const u = rng.range(12, Math.max(13, u1 - 5)), v = R > 3.2 && rng.chance(0.4) ? 0 : (rng.chance(0.5) ? 1 : -1) * R / 2;
      if (inCover(u, v, 3)) continue;
      covers.push({ type: 'manhole', u, v, rot: rng.range(0, Math.PI * 2), r: 0.4 });
      if (rng.chance(0.75)) {
        const s = rng.range(1.2, 1.6);
        addPatch({ u, v, dir: 'u', len: s, half: s / 2, tone: freshOrAged(), hole: 0.405 });
      }
      break;
    }
  }
  // valve caps and a chequer plate near the kerbs
  for (let i = rng.int(0, 2); i > 0; i--) {
    const u = rng.range(10, u1 - 2), v = (rng.chance(0.5) ? 1 : -1) * (R - rng.range(0.6, 1.3));
    if (inCover(u, v, 1) || inPatch(u, v, 0.6)) continue;
    covers.push({ type: 'valve', u, v, rot: rng.range(0, Math.PI * 2), r: 0.16 });
    if (rng.chance(0.5)) {
      const s = rng.range(0.5, 0.7);
      addPatch({ u, v, dir: 'u', len: s, half: s / 2, tone: freshOrAged(), hole: 0.165 });
    }
  }
  if (rng.chance(0.3)) {
    const u = rng.range(10, u1 - 2), v = (rng.chance(0.5) ? 1 : -1) * (R - 0.6);
    if (!inCover(u, v, 1) && !inPatch(u, v, 0.5)) covers.push({ type: 'plate', u, v, rot: 0, r: 0.42 });
  }

  // repairs: trenches across the carriageway (kerb to kerb), one along a lane, patches
  for (let i = rng.chance(0.65) ? rng.int(1, 2) : 0; i > 0; i--) {
    for (let t = 0; t < 6; t++) {
      const p = { u: rng.range(10, Math.max(11, u1 - 8)), v: 0, dir: 'v', len: 2 * R - 0.24, half: rng.range(0.28, 0.45), tone: freshOrAged(), hole: 0 };
      if (boxFree(box(p), 0.5)) { addPatch(p); break; }
    }
  }
  if (rng.chance(0.35)) {
    for (let t = 0; t < 6; t++) {
      const len = rng.range(6, 18), half = rng.range(0.28, 0.4);
      const p = { u: rng.range(9 + len / 2, Math.max(10 + len / 2, u1 - len / 2)), v: rng.range(-R + 0.9, R - 0.9), dir: 'u', len, half, tone: freshOrAged(), hole: 0 };
      if (boxFree(box(p), 0.3)) { addPatch(p); break; }
    }
  }
  for (let i = rng.int(2, 4); i > 0; i--) {
    for (let t = 0; t < 6; t++) {
      const len = rng.range(1.2, 4.2), half = Math.min(R - 0.6, rng.range(0.45, 1.25));
      const p = { u: rng.range(8 + len / 2, Math.max(9 + len / 2, u1 - len / 2)), v: rng.range(-R + 0.5 + half, R - 0.5 - half), dir: 'u', len, half, tone: freshOrAged(), hole: 0 };
      if (boxFree(box(p), 0.4)) { addPatch(p); break; }
    }
  }

  // cracks, split where a cover or a repair lies (cut by the newer work)
  const crack = (uv, half, dust) => {
    let run = [];
    const flush = () => { if (run.length >= 6) cracks.push({ uv: run, half, dust }); run = []; };
    for (let i = 0; i < uv.length; i += 2) {
      if (inCover(uv[i], uv[i + 1], 0.06) || inPatch(uv[i], uv[i + 1], 0.04) || uv[i] < u0 || uv[i] > u1 + 1.5) flush();
      else run.push(uv[i], uv[i + 1]);
    }
    flush();
  };
  const sealed = () => (rng.chance(0.65) ? [rng.range(0.014, 0.032), rng.range(0.05, 0.6)] : [rng.range(0.0025, 0.004), 0]);
  // the sealed joint along the granite edge strip at the mouth (a straight line of the
  // grid, skewed in the street frame)
  {
    const uv = [], a0 = -R / Math.abs(F.uv(1, 0)[1]) + 0.15;
    for (let a = a0; a <= -a0 + 1e-6; a += 0.25) uv.push(...F.uv(a, edgeX + 0.025));
    cracks.push({ uv, half: rng.range(0.016, 0.024), dust: rng.range(0.2, 0.5) });
  }
  // transverse: wandering, now and then only part of the way across
  for (let u = u0 + rng.range(3, 8); u < u1 - 1; u += rng.range(4, 13)) {
    const seed = rng.int(1, 1e6), skew = rng.range(-0.08, 0.08), amp = rng.range(0.12, 0.4);
    let va = -R + 0.22, vb = R - 0.22;
    if (rng.chance(0.35)) { if (rng.chance(0.5)) vb = rng.range(-0.3, 0.6) * R; else va = rng.range(-0.6, 0.3) * R; }
    const uv = [];
    for (let v = va; v <= vb + 1e-6; v += 0.12) uv.push(u + amp * wander(v, seed) + skew * v, v);
    const [half, dust] = sealed();
    crack(uv, half, dust);
  }
  // longitudinal: the lane joint beside the centre line and the seams along the gutters,
  // in runs; short fatigue cracks in the wheel paths
  const along = (v0, uA, uB, amp, sealP, half0) => {
    const seed = rng.int(1, 1e6);
    for (let u = uA + rng.range(0, 4); u < uB - 2;) {
      const len = rng.range(2, 9), uv = [];
      for (let x = u; x <= Math.min(uB, u + len); x += 0.25) uv.push(x, v0 + amp * wander(x, seed));
      if (rng.chance(sealP)) crack(uv, rng.range(half0 * 0.7, half0 * 1.3), rng.range(0.1, 0.6));
      else crack(uv, rng.range(0.0025, 0.004), 0);
      u += len + rng.range(2, 11);
    }
  };
  along((rng.chance(0.5) ? 1 : -1) * rng.range(0.12, 0.22), u0 + 2, u1, 0.05, 0.8, 0.024);
  for (const k of [-1, 1]) if (rng.chance(0.45)) along(k * (R - rng.range(0.28, 0.4)), u0 + 3, u1, 0.03, 0.6, 0.018);
  // tyre polish in the wheel paths (clear of the gullies), fatigue cracks along them
  const wheels = [];
  for (const k of [-1, 1]) {
    wheels.push(k * Math.max(0.3, R / 2 - 0.8), k * Math.min(R / 2 + 0.8, R - 0.75));
  }
  // bands along the street, broken (with a fade) where a cover lies on them
  const band = (v, half, k, ua = 2, ub = u1 + 1) => {
    let a = ua;
    for (const q of covers.filter((c) => Math.abs(c.v - v) < c.r + half * 0.8).sort((x, y) => x.u - y.u)) {
      if (q.u - q.r - 0.3 - a > 3) polish.push({ v, u0: a, u1: q.u - q.r - 0.3, half, k });
      a = Math.max(a, q.u + q.r + 0.3);
    }
    if (ub - a > 3) polish.push({ v, u0: a, u1: ub, half, k });
  };
  for (const k of [-1, 1]) {
    band(k * R / 2 + rng.normal(0, 0.06), 0.42, rng.range(0.45, 0.75), 5);      // oil drips
    band(k * (R - 0.62), 0.3, -rng.range(0.5, 0.9), 4);                          // kerb dust
  }
  for (const v of wheels) {
    band(v, 0.34, rng.range(0.8, 1.25));
    for (let i = rng.int(0, 2); i > 0; i--) {
      const ua = rng.range(8, u1 - 6), seed = rng.int(1, 1e6), uv = [];
      const dv = rng.range(-0.08, 0.08);
      for (let x = ua; x <= ua + rng.range(1.5, 5); x += 0.15) uv.push(x, v + dv + 0.08 * wander(x * 2, seed));
      crack(uv, rng.range(0.0025, 0.0045), 0);
    }
  }
  // oil drips and dirt along the lane centres
  for (let i = rng.int(4, 8); i > 0; i--) {
    const kind = rng.weighted([[1, 0.45], [3, 0.3], [0, 0.25]]);
    const u = rng.range(9, u1 - 2), v = (rng.chance(0.5) ? 1 : -1) * R / 2 + rng.normal(0, 0.2);
    const size = kind === 3 ? rng.range(1.6, 2.8) : rng.range(0.7, 1.6);
    if (inCover(u, v, size / 2 + 0.1) || inPatch(u, v, size / 2)) continue;
    stains.push({ kind, u, v, size, aspect: kind === 3 ? 0.4 : rng.range(0.7, 1.1), rot: kind === 3 ? rng.normal(0, 0.05) : rng.range(0, 6.28) });
  }

  plan = { covers, patches, cracks, polish, stains };
  if (PLANS.size > 64) PLANS.delete(PLANS.keys().next().value);
  PLANS.set(key, plan);
  return plan;
}

/** Overlays of the plan (repairs, polish, cracks) into the chunk's line writers; drawn
 *  in this order, before the paint. Resumable (see street.js): yields 'cross' now and
 *  then. */
export function* buildSideWear(F, plan, lines) {
  for (const p of plan.patches) {
    const h = p.len / 2 + PATCH_PAD;
    const uv = p.dir === 'u' ? straight(p.u - h, p.v, p.u + h, p.v, 1.2) : straight(p.u, p.v - h, p.u, p.v + h, 0.3);
    lines.patch.add(ribbon(F, uv, -PATCH_PAD), p.half + PATCH_PAD, p.len, patchWear(p.hole, p.tone), 7);
  }
  for (const b of plan.polish) lines.polish.add(ribbon(F, straight(b.u0, b.v, b.u1, b.v, 2)), b.half, b.u1 - b.u0, b.k, 7);
  yield 'cross';
  let n = 0;
  for (const c of plan.cracks) {
    const pts = ribbon(F, c.uv);
    lines.seal.add(pts, 2 * c.half, pts[pts.length - 2], c.dust, 7);
    if ((n += pts.length) > 2500) { n = 0; yield 'cross'; }
  }
}

/** Cast-iron covers (iron atlas) and stains (stain atlas) of the plan. */
export function buildSideIron(F, plan, bufs, mats) {
  const iron = bufs.get(mats.details.iron, true);
  for (const q of plan.covers) {
    const R = IRON_REGIONS[q.type];
    const ca = Math.cos(q.rot), sa = Math.sin(q.rot);
    // local (lu, lv): lu along the street (u) for rot = 0
    const vert = (lu, lv) => {
      const p = F.P(q.u + lu * ca - lv * sa, q.v + lu * sa + lv * ca, COVER_LIFT);
      return iron.v(p[0], p[1], p[2], 0, 1, 0, (R.x + (lu / R.mw + 0.5) * R.w) / ATLAS, (R.y + (lv / R.mh + 0.5) * R.h) / ATLAS);
    };
    if (q.type === 'manhole' || q.type === 'valve') {
      const n = q.type === 'manhole' ? 20 : 12, r = R.mw / 2, c0 = vert(0, 0), first = iron.n;
      for (let k = 0; k < n; k++) { const t = (k / n) * Math.PI * 2; vert(Math.cos(t) * r, Math.sin(t) * r); }
      for (let k = 0; k < n; k++) iron.tri(c0, first + ((k + 1) % n), first + k);
    } else {
      const a0 = vert(-R.mw / 2, -R.mh / 2), a1 = vert(R.mw / 2, -R.mh / 2), a2 = vert(R.mw / 2, R.mh / 2), a3 = vert(-R.mw / 2, R.mh / 2);
      iron.quad(a0, a3, a2, a1);
    }
  }
  const st = bufs.get(mats.details.stain, false);
  for (const sn of plan.stains) {
    const hx = sn.size / 2, hy = (sn.size * sn.aspect) / 2;
    const ca = Math.cos(sn.rot), sa = Math.sin(sn.rot);
    const col = sn.kind % 2, row = Math.floor(sn.kind / 2);
    const first = st.n;
    for (const [lu, lv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = F.P(sn.u + lu * hx * ca - lv * hy * sa, sn.v + lu * hx * sa + lv * hy * ca, LIFT);
      st.v(p[0], p[1], p[2], 0, 1, 0, col * 0.5 + (lu * 0.5 + 0.5) * 0.5, 1 - (row + 1) * 0.5 + (lv * 0.5 + 0.5) * 0.5);
    }
    st.quad(first, first + 3, first + 2, first + 1);
  }
}
