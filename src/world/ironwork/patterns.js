// Wrought-iron railing designs as 2D stroke lists (pure data, metres).
//
// One design describes one repeating bay ("tile") of a railing: x in [0, W] along the
// railing, y in [0, H] up from the balcony slab (H = nominal 1.0 m, scaled per building).
// The same strokes feed the 3D instanced geometry (near range) and the rasterised
// railing card atlas (far range), so both always match.
//
// Scrolls are generated the way a smith forms them: by curvature. The radius of
// curvature grows linearly from a tight eye (a logarithmic spiral) and then quickly
// opens into the body, so C and S scrolls have properly wound eyes.

const H = 1.0;

/** Integrate a curve from its curvature function k(s), s in [0, 1]. */
function integrate(k, n = 700) {
  let x = 0, y = 0, th = 0;
  const pts = [[0, 0]];
  const ds = 1 / n;
  for (let i = 0; i < n; i++) {
    th += k((i + 0.5) * ds) * ds;
    x += Math.cos(th) * ds; y += Math.sin(th) * ds;
    pts.push([x, y]);
  }
  return pts;
}

/** Radius of curvature along a scroll arm: eye spiral, then the open body. */
const rho = (t, { r0 = 0.02, c = 0.25, te = 0.3, q = 20 } = {}) => r0 + c * t + q * Math.max(0, t - te) ** 2;

/** Rotate a polyline so its chord (first -> last point) points straight up from the origin. */
function alignVertical(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const r = Math.PI / 2 - Math.atan2(b[1] - a[1], b[0] - a[0]);
  const c = Math.cos(r), s = Math.sin(r);
  return pts.map(([x, y]) => [(x - a[0]) * c - (y - a[1]) * s, (x - a[0]) * s + (y - a[1]) * c]);
}

const cache = new Map();
/** Canonical unit scrolls with the chord vertical. kind: 'C' (body bows to +x, both eyes
 *  curl back to -x), 'S' (eyes curl to opposite sides), 'J' (a single eye at the start). */
export function scroll(kind, p = {}) {
  const key = kind + JSON.stringify(p);
  if (cache.has(key)) return cache.get(key);
  let k;
  if (kind === 'C') k = (s) => 1 / rho(s, p) + 1 / rho(1 - s, p);
  else if (kind === 'S') k = (s) => 1 / rho(s, p) - 1 / rho(1 - s, p);
  else k = (s) => 1 / rho(s, p);
  let pts = alignVertical(integrate(k));
  // the C must bow to +x (eyes curl back to -x)
  if (kind === 'C') {
    let sx = 0; for (const q of pts) sx += q[0];
    if (sx < 0) pts = pts.map(([x, y]) => [-x, y]);
  }
  cache.set(key, pts);
  return pts;
}

/** Fit a polyline into box [x0, y0, x1, y1] (independent axis scale), optional mirror. */
export function fit(pts, [x0, y0, x1, y1], { flipX = false, flipY = false } = {}) {
  let ax = Infinity, ay = Infinity, bx = -Infinity, by = -Infinity;
  for (const [x, y] of pts) { if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y; }
  return pts.map(([x, y]) => {
    let u = (x - ax) / (bx - ax || 1), v = (y - ay) / (by - ay || 1);
    if (flipX) u = 1 - u;
    if (flipY) v = 1 - v;
    return [x0 + u * (x1 - x0), y0 + v * (y1 - y0)];
  });
}

function circle(cx, cy, r, n = 20) {
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return pts;
}

// Member sections (metres): scroll flat bar seen on edge, square bars, rails.
const SCROLL_W = 0.010, SCROLL_D = 0.018;
const BAR = 0.016;
const HAND = { y0: H - 0.035, y1: H, d: 0.046 };
const UNDER = 0.84, UNDER_T = 0.018;                     // under-rail closing the frieze band
const BAND_C = (UNDER + UNDER_T + HAND.y0) / 2;            // frieze band centre
const BAND_R = (HAND.y0 - UNDER - UNDER_T) / 2 - 0.001;    // ring radius touching both rails

/** Common frame: handrail, optional under-rail (frieze band), bottom rail, and the bay bar at x = 0. */
function frame(W, { under = UNDER, bottom = [0.055, 0.085], mid = null } = {}) {
  const s = [];
  s.push({ k: 'rail', x0: 0, x1: W, y0: HAND.y0, y1: HAND.y1, d: HAND.d, hand: true });
  if (under) s.push({ k: 'rail', x0: 0, x1: W, y0: under, y1: under + UNDER_T, d: 0.014 });
  if (mid) s.push({ k: 'rail', x0: 0, x1: W, y0: mid, y1: mid + 0.016, d: 0.014 });
  s.push({ k: 'rail', x0: 0, x1: W, y0: bottom[0], y1: bottom[1], d: 0.014 });
  s.push({ k: 'bar', x: 0, y0: bottom[0], y1: HAND.y0, s: BAR });
  return s;
}

const curve = (pts, closed = false, w = SCROLL_W, d = SCROLL_D) => ({ k: 'curve', pts, closed, w, d });
const collar = (x, y, vertical = true) => ({ k: 'collar', x, y, w: vertical ? 0.032 : 0.022, h: vertical ? 0.022 : 0.032, d: 0.024 });
const rosette = (x, y, r = 0.028) => ({ k: 'rosette', x, y, r });

const SLIM_C = { r0: 0.02, c: 0.2, te: 0.25, q: 30 };
const STD = { r0: 0.02, c: 0.25, te: 0.3, q: 20 };

/** Design library. Each returns {id, W, strokes}. */
export const DESIGNS = [
  // 0: back-to-back C scrolls ")(" bound by a collar, ring frieze above
  (() => {
    const W = 0.44, s = frame(W);
    const box = [0.10, 0.80];
    const C = scroll('C', SLIM_C);
    s.push(curve(fit(C, [0.03, box[0], W / 2, box[1]])));
    s.push(curve(fit(C, [W / 2, box[0], W - 0.03, box[1]], { flipX: true })));
    s.push(collar(W / 2, (box[0] + box[1]) / 2));
    s.push(curve(circle(W / 2, BAND_C, BAND_R), true));
    return { id: 'lyre', W, strokes: s };
  })(),
  // 1: mirrored S scroll pair forming a vase, rosette between the eyes
  (() => {
    const W = 0.40, s = frame(W);
    const S = scroll('S', STD);
    s.push(curve(fit(S, [0.03, 0.10, W / 2, 0.81])));
    s.push(curve(fit(S, [W / 2, 0.10, W - 0.03, 0.81], { flipX: true })));
    s.push(collar(W / 2, 0.455));
    s.push(rosette(W / 2, BAND_C, 0.03));
    s.push(curve(fit(scroll('C', SLIM_C), [W / 2 - 0.15, UNDER + 0.022, W / 2 - 0.045, HAND.y0 - 0.004])));
    s.push(curve(fit(scroll('C', SLIM_C), [W / 2 + 0.045, UNDER + 0.022, W / 2 + 0.15, HAND.y0 - 0.004], { flipX: true })));
    return { id: 'vase', W, strokes: s };
  })(),
  // 2: Mandate-era bars with ring friezes top and bottom
  (() => {
    const W = 0.36, s = frame(W, { mid: 0.215 });
    for (const x of [0.12, 0.24]) s.push({ k: 'bar', x, y0: 0.055, y1: HAND.y0, s: BAR * 0.85 });
    for (const x of [0.06, 0.18, 0.30]) {
      s.push(curve(circle(x, BAND_C, BAND_R), true));
      s.push(curve(circle(x, 0.15, 0.05), true));
    }
    return { id: 'rings', W, strokes: s };
  })(),
  // 3: twisted balusters with collars and small C arches under the frieze
  (() => {
    const W = 0.27, s = frame(W, { under: 0.80 });
    s.find((m) => m.k === 'bar').twist = [0.3, 0.62, 2]; // the bay bar at x = 0 is twisted too
    s.push({ k: 'bar', x: W / 2, y0: 0.055, y1: HAND.y0, s: BAR, twist: [0.3, 0.62, 2] });
    for (const x of [0, W / 2]) { s.push(collar(x, 0.29)); s.push(collar(x, 0.63)); }
    const J = scroll('J', STD);
    for (const x0 of [0, W / 2]) {
      s.push(curve(fit(J, [x0 + 0.012, 0.822, x0 + W / 4, 0.958], { flipY: true })));
      s.push(curve(fit(J, [x0 + W / 4, 0.822, x0 + W / 2 - 0.012, 0.958], { flipX: true, flipY: true })));
      s.push(curve(circle(x0 + W / 4, 0.16, 0.045), true));
    }
    return { id: 'twist', W, strokes: s };
  })(),
  // 4: Ottoman panel: large ring with rosette, J scrolls to the corners
  (() => {
    const W = 0.56, s = frame(W);
    const cx = W / 2, cy = 0.47, r = 0.13;
    s.push(curve(circle(cx, cy, r, 28), true));
    s.push(rosette(cx, cy, 0.045));
    const J = scroll('J', STD);
    s.push(curve(fit(J, [0.03, cy + r - 0.01, cx, 0.82], { flipX: true })));
    s.push(curve(fit(J, [cx, cy + r - 0.01, W - 0.03, 0.82])));
    s.push(curve(fit(J, [0.03, 0.10, cx, cy - r + 0.01], { flipX: true, flipY: true })));
    s.push(curve(fit(J, [cx, 0.10, W - 0.03, cy - r + 0.01], { flipY: true })));
    s.push(collar(cx, cy + r)); s.push(collar(cx, cy - r));
    s.push(curve(circle(W / 4, BAND_C, BAND_R), true));
    s.push(curve(circle(3 * W / 4, BAND_C, BAND_R), true));
    return { id: 'medallion', W, strokes: s };
  })(),
  // 5: plain square bars (later / modern buildings)
  (() => {
    const W = 0.12, s = frame(W, { under: null });
    return { id: 'bars', W, strokes: s };
  })(),
];

export const RAIL_H = H;
export const designById = (id) => DESIGNS.find((d) => d.id === id);
