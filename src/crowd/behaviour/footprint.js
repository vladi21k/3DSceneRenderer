import { AGENT_R, FOOT, BAND, RIDE_D } from './constants.js';
import { settleShape } from './agent.js';

// Footprints of people with a stroller or a bicycle: the body circle plus the prop as a
// capsule in route coordinates (s metric along the street, d lateral). Used by the
// avoidance (people keep clear of the whole stroller / bicycle), the hard constraints
// (no prop through a pole, a facade or a café terrace) and the tram clearance (the prop is
// kept out of the cab's swept volume exactly like the body).

/** Recompute the prop capsule of `a` for its current facing. Offsets are metric, relative to
 *  the body centre; ext* say how far the prop reaches past the body circle. */
export function updateFoot(a) {
  const F = FOOT[a.mob];
  if (!F) { a.fpR = 0; a.extLo = 0; a.extHi = 0; a.extS = 0; return; }
  footAt(a, a.alpha, a);
}

/** Capsule of a's prop for facing alpha → o.fp0s/fp0d/fp1s/fp1d/fpR and o.extLo/extHi/extS.
 *  Right after getting on or off a bicycle the renderer slides the bicycle from where it was to
 *  its new place over 0.75 s (a.footW 0..1, a.mobPrev): the capsule follows it. */
export function footAt(a, alpha, o) {
  const D = footDims(a), f0 = D.f0, f1 = D.f1, l = D.l, r = D.r;
  const cs = Math.cos(alpha), sn = Math.sin(alpha);
  // forward (cs, sn) and right (−sn, cs) in (s, d)
  const ls = -sn * l, ld = cs * l;
  const s0 = cs * f0 + ls, d0 = sn * f0 + ld, s1 = cs * f1 + ls, d1 = sn * f1 + ld;
  o.fp0s = s0; o.fp0d = d0; o.fp1s = s1; o.fp1d = d1; o.fpR = r;
  o.extLo = Math.max(0, r - Math.min(d0, d1) - AGENT_R);
  o.extHi = Math.max(0, Math.max(d0, d1) + r - AGENT_R);
  o.extS = Math.max(0, Math.max(Math.abs(s0), Math.abs(s1)) + r - AGENT_R);
  return o;
}

/** The prop's capsule in the person's frame now (FOOT, or between two of them while it slides). */
const _dims = settleShape({ f0: 0, f1: 0, l: 0, r: 0 });
export function footDims(a) {
  const F = FOOT[a.mob], w = a.footW, P = w < 1 && a.mobPrev ? FOOT[a.mobPrev] : null;
  if (!P) { _dims.f0 = F.f0; _dims.f1 = F.f1; _dims.l = F.l; _dims.r = F.r; return _dims; }
  _dims.f0 = P.f0 + (F.f0 - P.f0) * w; _dims.f1 = P.f1 + (F.f1 - P.f1) * w;
  _dims.l = P.l + (F.l - P.l) * w; _dims.r = Math.max(P.r, F.r);
  return _dims;
}

/** Start of the slide of the prop to its new place (getting on or off a bicycle). */
export function propMoved(a, prevMob, time) { a.mobPrev = prevMob; a.mobT = time; a.footW = 0; updateFoot(a); }
/** Progress of that slide (0..1, smoothed like the renderer's blend), once per frame. */
export function footBlend(a, time) {
  if (a.footW >= 1) return;
  const u = Math.min(1, Math.max(0, (time - a.mobT) / 0.75));
  a.footW = u >= 1 ? 1 : u * u * (3 - 2 * u);
  if (a.footW >= 1) a.mobPrev = 0;
}

/** Does the footprint (body + prop, as body-centre offsets ext*) reach into the tram band
 *  |d − RIDE_D| < BAND with the body centre at d? */
export function footInBand(a, d = a.d) {
  const dl = d - RIDE_D;
  return dl + a.extHi > -BAND && dl - a.extLo < BAND;
}

/** Distance of the footprint's near edge from the band edge (≥ 0 outside; body-centre terms). */
export function footBandGap(a, d = a.d) {
  const dl = d - RIDE_D;
  return dl >= 0 ? dl - a.extLo - BAND : -dl - a.extHi - BAND;
}

// ---------------------------------------------------------------- distances
// (inputs and results go through typed arrays: doubles written to module-level `let`s, passed to
// a call that is not inlined or returned from one are boxed, and these run thousands of times a
// frame)
const G = settleShape({ gap: 0, ns: 0, nd: 0 });
const P = new Float64Array(10);  // segment pair: 0-3 p0x p0y p1x p1y, 4 rp, 5-8 q0x q0y q1x q1y, 9 rq
const X = new Float64Array(9);   // 0-1 closest point on p, 2-3 on q, 4 best gap, 5-6 its vector (q → p), 7 its length, 8 squared distance

/** Closest points between the segments P[0..3] and P[5..8] → X[0..1] (on p), X[2..3] (on q),
 *  X[8] squared distance. */
function segSeg() {
  const p0x = P[0], p0y = P[1], q0x = P[5], q0y = P[6];
  const ux = P[2] - p0x, uy = P[3] - p0y, vx = P[7] - q0x, vy = P[8] - q0y, wx = p0x - q0x, wy = p0y - q0y;
  const a = ux * ux + uy * uy, b = ux * vx + uy * vy, c = vx * vx + vy * vy, d = ux * wx + uy * wy, e = vx * wx + vy * wy;
  let s = 0, t = 0;
  if (a < 1e-9 && c < 1e-9) { s = 0; t = 0; }
  else if (a < 1e-9) { s = 0; t = e / c; t = t < 0 ? 0 : t > 1 ? 1 : t; }
  else if (c < 1e-9) { t = 0; s = -d / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
  else {
    const den = a * c - b * b;
    s = den > 1e-9 ? (b * e - c * d) / den : 0;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    t = (b * s + e) / c;
    if (t < 0) { t = 0; s = -d / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
    else if (t > 1) { t = 1; s = (b - d) / a; s = s < 0 ? 0 : s > 1 ? 1 : s; }
  }
  const cx = p0x + ux * s, cy = p0y + uy * s, qx = q0x + vx * t, qy = q0y + vy * t;
  X[0] = cx; X[1] = cy; X[2] = qx; X[3] = qy;
  const dx = cx - qx, dy = cy - qy;
  X[8] = dx * dx + dy * dy;
}

/** The pair in P against the best gap so far (X[4..7]). */
function pairTest() {
  segSeg();
  const dist = Math.sqrt(X[8]), g = dist - P[4] - P[9];
  if (g < X[4]) { X[4] = g; X[5] = X[0] - X[2]; X[6] = X[1] - X[3]; X[7] = dist; }
}

/** Smallest gap between the footprints of a and b (bodies + props), b at (dx, dy) = (b.s − a.s
 *  metric, b.d − a.d) from a. Returns G = {gap (negative: overlap), ns, nd (unit, from b to a)}. */
export function footGap(a, b, dx, dy) { FQ[0] = dx; FQ[1] = dy; return footGapQ(a, b); }
/** footGap with b's offset (dx, dy) in FQ[0], FQ[1] (the per-frame callers: nothing boxed). */
export const FQ = new Float64Array(2);
export function footGapQ(a, b) {
  const dx = FQ[0], dy = FQ[1];
  X[4] = 1e9; X[5] = 0; X[6] = 0; X[7] = 0;
  // a: body point (0, 0) and prop capsule; b: body point (dx, dy) and prop capsule
  const aProp = a.mob && a.fpR > 0, bProp = b.mob && b.fpR > 0;
  // body - body
  P[0] = 0; P[1] = 0; P[2] = 0; P[3] = 0; P[4] = AGENT_R;
  P[5] = dx; P[6] = dy; P[7] = dx; P[8] = dy; P[9] = AGENT_R;
  pairTest();
  if (bProp) {
    // a's body - b's prop
    P[5] = dx + b.fp0s; P[6] = dy + b.fp0d; P[7] = dx + b.fp1s; P[8] = dy + b.fp1d; P[9] = b.fpR;
    pairTest();
  }
  if (aProp) {
    // a's prop - b's prop, then a's prop - b's body
    P[0] = a.fp0s; P[1] = a.fp0d; P[2] = a.fp1s; P[3] = a.fp1d; P[4] = a.fpR;
    if (bProp) pairTest();
    P[5] = dx; P[6] = dy; P[7] = dx; P[8] = dy; P[9] = AGENT_R;
    pairTest();
  }
  G.gap = X[4];
  const br = X[7];
  if (br > 1e-4) { G.ns = X[5] / br; G.nd = X[6] / br; }
  else { const l = Math.sqrt(dx * dx + dy * dy) || 1; G.ns = -dx / l; G.nd = -dy / l; }
  return G;
}

/** Closest point of a's prop capsule to the point (rs, rd) (metric, relative to the body):
 *  squared metric distance; the closest point in _foot.s / _foot.d (metric offsets from the body). */
export const _foot = settleShape({ s: 0, d: 0, q: 0 });
export function propPointDist2(a, rs, rd) { FQ[0] = rs; FQ[1] = rd; propPointQ(a); return _foot.q; }
/** propPointDist2 with the point in FQ[0], FQ[1]; the squared distance → _foot.q (nothing boxed). */
export function propPointQ(a) {
  const rs = FQ[0], rd = FQ[1];
  P[0] = a.fp0s; P[1] = a.fp0d; P[2] = a.fp1s; P[3] = a.fp1d;
  P[5] = rs; P[6] = rd; P[7] = rs; P[8] = rd;
  segSeg();
  _foot.s = X[0]; _foot.d = X[1]; _foot.q = X[8];
}
