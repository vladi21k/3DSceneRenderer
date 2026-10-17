import { AGENT_R, FOOT, BAND, RIDE_D } from './constants.js';

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

/** Capsule of a's prop for facing alpha → o.fp0s/fp0d/fp1s/fp1d/fpR and o.extLo/extHi/extS. */
export function footAt(a, alpha, o) {
  const F = FOOT[a.mob];
  const cs = Math.cos(alpha), sn = Math.sin(alpha);
  // forward (cs, sn) and right (−sn, cs) in (s, d)
  const ls = -sn * F.l, ld = cs * F.l;
  const s0 = cs * F.f0 + ls, d0 = sn * F.f0 + ld, s1 = cs * F.f1 + ls, d1 = sn * F.f1 + ld;
  o.fp0s = s0; o.fp0d = d0; o.fp1s = s1; o.fp1d = d1; o.fpR = F.r;
  o.extLo = Math.max(0, F.r - Math.min(d0, d1) - AGENT_R);
  o.extHi = Math.max(0, Math.max(d0, d1) + F.r - AGENT_R);
  o.extS = Math.max(0, Math.max(Math.abs(s0), Math.abs(s1)) + F.r - AGENT_R);
  return o;
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
const G = { gap: 0, ns: 0, nd: 0 };
let _cx = 0, _cy = 0, _qx = 0, _qy = 0;

/** Closest points between segments p0p1 and q0q1 (2D) → _c (on p), _q (on q); returns squared distance. */
function segSeg(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y) {
  const ux = p1x - p0x, uy = p1y - p0y, vx = q1x - q0x, vy = q1y - q0y, wx = p0x - q0x, wy = p0y - q0y;
  const a = ux * ux + uy * uy, b = ux * vx + uy * vy, c = vx * vx + vy * vy, d = ux * wx + uy * wy, e = vx * wx + vy * wy;
  let s = 0, t = 0;
  if (a < 1e-9 && c < 1e-9) { s = 0; t = 0; }
  else if (a < 1e-9) { s = 0; t = clamp01(e / c); }
  else if (c < 1e-9) { t = 0; s = clamp01(-d / a); }
  else {
    const den = a * c - b * b;
    s = den > 1e-9 ? clamp01((b * e - c * d) / den) : 0;
    t = (b * s + e) / c;
    if (t < 0) { t = 0; s = clamp01(-d / a); } else if (t > 1) { t = 1; s = clamp01((b - d) / a); }
  }
  _cx = p0x + ux * s; _cy = p0y + uy * s; _qx = q0x + vx * t; _qy = q0y + vy * t;
  const dx = _cx - _qx, dy = _cy - _qy;
  return dx * dx + dy * dy;
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Smallest gap between the footprints of a and b (bodies + props), b at (dx, dy) = (b.s − a.s
 *  metric, b.d − a.d) from a. Returns G = {gap (negative: overlap), ns, nd (unit, from b to a)}. */
export function footGap(a, b, dx, dy) {
  _best = 1e9; _bx = 0; _by = 0; _br = 0;
  // a: body point (0, 0) and prop capsule; b: body point (dx, dy) and prop capsule
  const aProp = a.mob && a.fpR > 0, bProp = b.mob && b.fpR > 0;
  pairTest(0, 0, 0, 0, AGENT_R, dx, dy, dx, dy, AGENT_R);
  if (aProp) pairTest(a.fp0s, a.fp0d, a.fp1s, a.fp1d, a.fpR, dx, dy, dx, dy, AGENT_R);
  if (bProp) pairTest(0, 0, 0, 0, AGENT_R, dx + b.fp0s, dy + b.fp0d, dx + b.fp1s, dy + b.fp1d, b.fpR);
  if (aProp && bProp) pairTest(a.fp0s, a.fp0d, a.fp1s, a.fp1d, a.fpR, dx + b.fp0s, dy + b.fp0d, dx + b.fp1s, dy + b.fp1d, b.fpR);
  G.gap = _best;
  if (_br > 1e-4) { G.ns = _bx / _br; G.nd = _by / _br; }
  else { const l = Math.hypot(dx, dy) || 1; G.ns = -dx / l; G.nd = -dy / l; }
  return G;
}
let _best = 0, _bx = 0, _by = 0, _br = 0;
function pairTest(p0x, p0y, p1x, p1y, rp, q0x, q0y, q1x, q1y, rq) {
  const d2 = segSeg(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y);
  const dist = Math.sqrt(d2), g = dist - rp - rq;
  if (g < _best) { _best = g; _bx = _cx - _qx; _by = _cy - _qy; _br = dist; }
}

/** Closest point of a's prop capsule (absolute route s via k, d) to the point (ps, pd): squared
 *  metric distance; the closest point in _foot.s / _foot.d (metric offsets from the body). */
export const _foot = { s: 0, d: 0 };
export function propPointDist2(a, rs, rd) {
  // rs, rd: point relative to the body (metric)
  const d2 = segSeg(a.fp0s, a.fp0d, a.fp1s, a.fp1d, rs, rd, rs, rd);
  _foot.s = _cx; _foot.d = _cy;
  return d2;
}
