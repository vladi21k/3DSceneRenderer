// Shared helpers for the facade infill builders: colour palettes, polygon utilities and
// the per-chunk "kit" (one Batch per material, small parts folded into fewer batches).
import { Batch, lin } from './geo.js';

export const PAINT = {
  darkgreen: 0x2f4637, brown: 0x4a3324, white: 0xd5d1c4, grey: 0x6a6d69, black: 0x232425, teal: 0x2c5b5d,
};
export const paint = (name) => lin(PAINT[name] ?? PAINT.grey);

// Joinery colour swatches (sRGB), weighted as on the street: mostly varnished brown wood
// and white, then dark green, greys, black and a few blue-greys and teals; anodised
// aluminium (silver / bronze) for modern sliders; dark steel for Mandate-era sections.
const SWATCH = {
  timber: [[0x5a3a22, 0.17], [0x6c4529, 0.1], [0x4a2f1d, 0.07], [0xe2dfd4, 0.17], [0xcbc5b2, 0.08], [0x2d4033, 0.11],
    [0x6f716c, 0.08], [0x9a9c97, 0.05], [0x262627, 0.06], [0x4a5a66, 0.05], [0x2c5555, 0.04], [0x6b2b24, 0.02]],
  steel: [[0x2a2b2c, 0.3], [0x2d4033, 0.25], [0x5d605c, 0.2], [0xd8d5ca, 0.15], [0x4a3426, 0.1]],
  alu: [[0xa4a6a4, 0.45], [0x5b4a3b, 0.2], [0xe4e2dc, 0.25], [0x3a3b3c, 0.1]],
  shutter: [[0x34503c, 0.2], [0x5e4430, 0.17], [0x7a7c76, 0.13], [0xd2cdbd, 0.12], [0x53636c, 0.1], [0x5d6146, 0.08],
    [0x8a5a34, 0.08], [0x3e6566, 0.06], [0x9ea29a, 0.06]],
  shop: [[0x1e1f20, 0.2], [0x34373a, 0.18], [0x4a3021, 0.13], [0xa4a6a4, 0.14], [0x5b4a3b, 0.07], [0x2a3d30, 0.1],
    [0xdcd9cf, 0.09], [0x23303d, 0.05], [0x5c1f1c, 0.04]],
};

/** Linear [r, g, b] of a swatch drawn from palette `kind` (timber, steel, alu, shutter, shop). */
export function swatch(kind, rng) { return lin(rng.weighted(SWATCH[kind])); }

/**
 * Weathered variant of a paint colour for one opening: sun fading lifts and greys the
 * colour (strongest on dark paint), plus a little value variation between repaints.
 */
export function weather(c, rng, amount = 1) {
  const fade = rng.next() * 0.22 * amount, k = 0.92 + rng.next() * 0.14;
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const lift = fade * (1 - Math.min(1, l * 2.5)) * 0.12;
  return c.map((x) => (x + (l - x) * fade * 0.6 + lift) * k);
}

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

// Typical batch sizes per (material key, lod), a running mean: new batches start a little
// larger, so their buffers rarely have to grow (and copy) while a chunk is assembled.
const hints = new Map();

/**
 * Per-chunk set of batches, created on first use. A material definition may fold into
 * another batch at a detail level ({near, far}: {key, k}): small parts of far chunks share
 * the frame batch, for instance, with their vertex colours scaled by k so the albedo
 * matches across the two library materials.
 */
export class Kit {
  constructor(mats, lod) {
    this.mats = mats; this.lod = lod; this.b = {}; this.views = {};
  }
  get(key) {
    let v = this.views[key];
    if (v) return v;
    const def = this.mats[key];
    const al = this.lod > 0 ? def.far : def.near;
    if (!al) v = this._batch(key);
    else {
      const tgt = this._batch(al.key), k = al.k;
      v = !k ? tgt : { add: (t, m, r = 1, g = 1, b = 1, ex = null, du = 0, dv = 0) => tgt.add(t, m, r * k[0], g * k[1], b * k[2], ex, du, dv) };
    }
    this.views[key] = v;
    return v;
  }
  _batch(key) {
    let b = this.b[key];
    if (!b) {
      const def = this.mats[key];
      b = this.b[key] = new Batch(def.material, { color: def.color !== false, extra: def.extra || null, hint: hints.get(`${key}:${this.lod}`) });
    }
    return b;
  }
  meshes(group, name) {
    for (const key in this.b) {
      const def = this.mats[key], batch = this.b[key];
      const hk = `${key}:${this.lod}`, h = hints.get(hk);
      if (!h) hints.set(hk, { verts: batch.count, idx: batch.I.n });
      else { h.verts += (batch.count - h.verts) * 0.25; h.idx += (batch.I.n - h.idx) * 0.25; }
      const m = batch.mesh(`${name}:${key}`, { castShadow: def.castShadow !== false && this.lod === 0, receiveShadow: def.receiveShadow !== false });
      if (!m) continue;
      if (def.renderOrder) m.renderOrder = def.renderOrder;
      // thin parts (glazing bars, grilles, louvres, brackets) only cast in the fine cascades
      if (def.thin) m.userData.thinCaster = true;
      group.add(m);
    }
  }
}
