// 2D path helpers for forged scrollwork (pure JS, no three.js dependency).
//
// Scrolls are built like a smith bends them: a smooth spine (Catmull-Rom through a few
// control points) that runs into spiral terminals whose curvature ramps up linearly
// (clothoid-like), so tangents are continuous and the curl tightens naturally.
// Points are [x, y] in metres in the plane of the ornament.

/** Integrate a turtle path. pieces: [[length, k0, k1], ...] with curvature in 1/m
 *  (+ = counter-clockwise). Returns points including the start. */
export function turtle(x, y, heading, pieces, step = 0.008) {
  const pts = [[x, y]];
  let th = heading;
  for (const [len, k0, k1] of pieces) {
    const n = Math.max(1, Math.ceil(len / step));
    const h = len / n;
    for (let i = 0; i < n; i++) {
      const ka = k0 + (k1 - k0) * (i / n), kb = k0 + (k1 - k0) * ((i + 1) / n);
      const tm = th + 0.5 * h * (ka + (ka + kb) / 2) / 2; // midpoint heading
      x += Math.cos(tm) * h; y += Math.sin(tm) * h;
      th += h * (ka + kb) / 2;
      pts.push([x, y]);
    }
  }
  pts.heading = th;
  return pts;
}

/** Centripetal Catmull-Rom through control points, sampled every ~step metres. */
export function spline(ctrl, step = 0.01) {
  if (ctrl.length < 2) return ctrl.map((p) => [...p]);
  const P = [mirror(ctrl[1], ctrl[0]), ...ctrl, mirror(ctrl[ctrl.length - 2], ctrl[ctrl.length - 1])];
  const out = [];
  for (let i = 1; i < P.length - 2; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2];
    const t01 = Math.pow(dist(p0, p1), 0.5) || 1e-4, t12 = Math.pow(dist(p1, p2), 0.5) || 1e-4, t23 = Math.pow(dist(p2, p3), 0.5) || 1e-4;
    const n = Math.max(2, Math.ceil(dist(p1, p2) / step));
    for (let j = i === 1 ? 0 : 1; j <= n; j++) {
      const t = j / n;
      out.push(cr(p0, p1, p2, p3, t01, t12, t23, t));
    }
  }
  return out;
}

function mirror(a, b) { return [2 * b[0] - a[0], 2 * b[1] - a[1]]; }
function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }
function cr(p0, p1, p2, p3, t01, t12, t23, t) {
  // centripetal Catmull-Rom (Barry-Goldman form) with tangents scaled to the middle interval
  const out = [0, 0];
  for (let c = 0; c < 2; c++) {
    const m1 = (p2[c] - p1[c] + t12 * ((p1[c] - p0[c]) / t01 - (p2[c] - p0[c]) / (t01 + t12)));
    const m2 = (p2[c] - p1[c] + t12 * ((p3[c] - p2[c]) / t23 - (p3[c] - p1[c]) / (t12 + t23)));
    const a = 2 * (p1[c] - p2[c]) + m1 + m2, b = -3 * (p1[c] - p2[c]) - m1 - m1 - m2;
    out[c] = a * t * t * t + b * t * t + m1 * t + p1[c];
  }
  return out;
}

/** Heading (radians) of a polyline at its end (or start when atStart). */
export function endHeading(pts, atStart = false) {
  if (atStart) { const a = pts[0], b = pts[Math.min(2, pts.length - 1)]; return Math.atan2(b[1] - a[1], b[0] - a[0]); }
  const a = pts[Math.max(0, pts.length - 3)], b = pts[pts.length - 1];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

/** A scroll: spline spine with optional spiral terminals.
 *  curl = {len, k0, k1} with signed curvature (+ curls counter-clockwise when walking
 *  outwards from the spine end). startCurl is walked outwards from the first point. */
export function scroll({ ctrl, startCurl = null, endCurl = null, step = 0.008 }) {
  let pts = spline(ctrl, step);
  if (endCurl) {
    const e = pts[pts.length - 1];
    const t = turtle(e[0], e[1], endHeading(pts), curlPieces(endCurl), step);
    pts = pts.concat(t.slice(1));
  }
  if (startCurl) {
    const s = pts[0];
    const t = turtle(s[0], s[1], endHeading(pts, true) + Math.PI, curlPieces(startCurl), step);
    pts = t.slice(1).reverse().concat(pts);
  }
  return pts;
}

function curlPieces(c) {
  if (Array.isArray(c)) return c;
  return [[c.len, c.k0, c.k1]];
}

/** Lowest point of a polyline (used to hang lanterns from a crook). */
export function lowestAfter(pts, fromIndex = 0) {
  let best = pts[fromIndex];
  for (let i = fromIndex; i < pts.length; i++) if (pts[i][1] < best[1]) best = pts[i];
  return best;
}
