// Shared helpers for the facade infill builders: colour palettes, polygon utilities and
// the per-chunk "kit" (one Batch per material).
import { Batch, lin } from './geo.js';

export const PAINT = {
  darkgreen: 0x2f4637, brown: 0x4a3324, white: 0xd5d1c4, grey: 0x6a6d69, black: 0x232425, teal: 0x2c5b5d,
};
export const paint = (name) => lin(PAINT[name] ?? PAINT.grey);

/** Standard opening profile values (metres). */
export const FR = {
  fw: 0.075,      // window casing width (in plane)
  zf: 0.035,      // casing front (local z, + towards the street)
  zb: -0.05,      // casing back
  ch: 0.012,      // chamfer on front edges
};

/** Rectangle ring (CCW) with per-side insets [left, bottom, right, top] at depth z. */
export function rectRing(x0, y0, x1, y1, ins, z) {
  return [[x0 + ins[0], y0 + ins[1], z], [x1 - ins[2], y0 + ins[1], z], [x1 - ins[2], y1 - ins[3], z], [x0 + ins[0], y1 - ins[3], z]];
}

/** Inset a convex CCW polygon by d (miter joins). */
export function insetPoly(pts, d) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    let e1x = p[0] - a[0], e1y = p[1] - a[1]; const l1 = Math.hypot(e1x, e1y) || 1; e1x /= l1; e1y /= l1;
    let e2x = b[0] - p[0], e2y = b[1] - p[1]; const l2 = Math.hypot(e2x, e2y) || 1; e2x /= l2; e2y /= l2;
    // inward normals (left of CCW edges)
    const n1x = -e1y, n1y = e1x, n2x = -e2y, n2y = e2x;
    let mx = n1x + n2x, my = n1y + n2y;
    const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
    const cos = mx * n1x + my * n1y;
    const k = d / Math.max(0.2, cos);
    out.push([p[0] + mx * k, p[1] + my * k]);
  }
  return out;
}

/** Horizontal span [xmin, xmax] of a convex polygon at height y (null if outside). */
export function spanAtY(pts, y) {
  let lo = Infinity, hi = -Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    if ((a[1] - y) * (b[1] - y) > 0) continue;
    if (a[1] === b[1]) { lo = Math.min(lo, a[0], b[0]); hi = Math.max(hi, a[0], b[0]); continue; }
    const t = (y - a[1]) / (b[1] - a[1]);
    const x = a[0] + (b[0] - a[0]) * t;
    lo = Math.min(lo, x); hi = Math.max(hi, x);
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Per-chunk set of batches, created on first use. */
export class Kit {
  constructor(mats, lod) {
    this.mats = mats; this.lod = lod; this.b = {};
  }
  get(key) {
    if (!this.b[key]) {
      const def = this.mats[key];
      this.b[key] = new Batch(def.material, { color: def.color !== false, extra: def.extra || null });
    }
    return this.b[key];
  }
  meshes(group, name) {
    for (const key in this.b) {
      const def = this.mats[key];
      const m = this.b[key].mesh(`${name}:${key}`, { castShadow: def.castShadow !== false && this.lod === 0, receiveShadow: def.receiveShadow !== false });
      if (m) { if (def.renderOrder) m.renderOrder = def.renderOrder; group.add(m); }
    }
  }
}
