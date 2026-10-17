// Vertex colour model for the masonry: per-building stone tint, baked ambient
// occlusion (under cornices, string courses and balconies, in reveals, at the base)
// and weathering (greyer, darker splash zone near the paving, faint dirt streaks
// below sills and cornices, large soft patches of stone variation).
// All factors are linear multipliers on the material albedo.

function ihash(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 2D value noise in [0, 1]. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = ihash(ix, iy, seed), b = ihash(ix + 1, iy, seed), c = ihash(ix, iy + 1, seed), d = ihash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function hash1(x, seed = 0) { return ihash(x | 0, 0x3c6ef372, seed); }

/**
 * Per-building stone tint as a multiplier around 1 on the library albedo (the baked
 * texture carries the limestone colour). The plan's absolute tints are taken relative
 * to the cream reference, so cream = 1, honey/golden warmer, pale/grey cooler.
 */
const CREAM = [0.86, 0.80, 0.68];
export function stoneTint(plan, rng) {
  const t = plan.style.tint;
  // a few buildings are noticeably darker (older, never cleaned), a few freshly cleaned
  const bright = rng.weighted([[rng.range(0.94, 1.04), 0.7], [rng.range(0.84, 0.93), 0.2], [rng.range(1.04, 1.1), 0.1]]);
  const warm = rng.range(-0.03, 0.03);
  return [0, 1, 2].map((i) => Math.pow(t[i] / CREAM[i], 1.1) * bright * (1 + warm * (1 - i)));
}

/**
 * Shading context for one facade face (front or corner return). Precomputes a 1D
 * occlusion table along v and bins the local occluders so per-vertex cost stays tiny.
 */
export class FaceShade {
  constructor(face, tint, seed, opts = {}) {
    this.tint = tint;
    this.seed = seed | 0;
    this.groundAt = face.groundAt;
    this.width = face.width;
    const top = face.cornice ? face.cornice.y : 20;
    this.corniceY = top;
    // 1D AO / grime table along v (5 cm steps)
    const vMin = -3, vMax = top + 0.2, step = 0.05;
    const n = Math.ceil((vMax - vMin) / step) + 1;
    const ao = new Float32Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      const v = vMin + i * step;
      let a = 1;
      const dc = top - v;
      if (dc >= 0) a *= 1 - 0.30 * Math.exp(-dc / 0.45) - 0.06 * Math.exp(-dc / 2.0);
      for (const c of face.courses || []) {
        const d = c.y - v;
        if (d >= 0 && d < 1.2) a *= 1 - 0.13 * Math.exp(-d / 0.22);
      }
      ao[i] = a;
    }
    this.ao = ao; this.vMin = vMin; this.step = step; this.n = n;
    // local occluders binned per metre of v: balconies (soffit occlusion over 2.5 m below)
    // and window sills (dirt streaks over 3 m below)
    this.bins = [];
    const bin = (y0, y1, item) => {
      for (let i = Math.max(0, Math.floor(y0 - vMin)); i <= Math.floor(y1 - vMin); i++) (this.bins[i] || (this.bins[i] = [])).push(item);
    };
    for (const b of face.balconies || []) {
      const it = { bal: true, u0: b.u0 - 0.55, u1: b.u1 + 0.55, y: b.y - 0.02, d: b.depth || 0.9 };
      bin(it.y - 2.5, it.y, it);
    }
    for (const o of face.openings || []) {
      if (o.kind !== 'window') continue;
      const it = { bal: false, u0: o.uc - o.w / 2 - 0.05, u1: o.uc + o.w / 2 + 0.05, y: o.y - 0.12, s: 0.6 + 0.8 * hash1(o.uc * 13 + o.y * 7, seed) };
      bin(it.y - 3, it.y, it);
    }
    this.dirt = opts.dirt ?? 1;
  }

  /** Wall field colour at (u, v), written to out. */
  wall(u, v, out) {
    const t = this.tint;
    let i = ((v - this.vMin) / this.step) | 0;
    if (i < 0) i = 0; else if (i >= this.n) i = this.n - 1;
    let a = this.ao[i];
    let streak = 0;
    const list = this.bins[Math.floor(v - this.vMin)];
    if (list) {
      for (let k = 0; k < list.length; k++) {
        const it = list[k];
        if (u < it.u0 || u > it.u1) continue;
        const d = it.y - v;
        if (d < 0) continue;
        if (it.bal) {
          // balcony soffit shadow, fading out over 0.4 m past the slab ends
          const e = Math.min(1, (u - it.u0) / 0.4, (it.u1 - u) / 0.4);
          if (d < 2.5) a *= 1 - 0.30 * e * Math.exp(-d / (0.55 * it.d));
        } else if (d < 3) {
          // dirt washed down from the sill
          const e = Math.min(1, (u - it.u0) / 0.25, (it.u1 - u) / 0.25);
          streak += 0.09 * it.s * e * Math.exp(-d / 1.3);
        }
      }
    }
    // large soft patches (stone batches, cleaning, sun bleaching)
    const p = noise2(u * 0.35, v * 0.28, this.seed) - 0.5 + 0.35 * (noise2(u * 1.3, v * 0.9, this.seed + 7) - 0.5);
    let r = t[0] * (1 + 0.10 * p), g = t[1] * (1 + 0.10 * p), b = t[2] * (1 + 0.11 * p);
    // dirt washed down from the cornice: irregular vertical streaks fading downwards
    const dc = this.corniceY - v;
    if (dc > 0 && dc < 6) {
      const col = noise2(u * 2.3, dc * 0.25, this.seed + 3);
      streak += 0.11 * Math.exp(-dc / (1.2 + 1.6 * col)) * (0.25 + col * col * 1.4);
    }
    // splash zone near the paving: darker, greyer
    const hg = v - this.groundAt(u);
    const gz = hg < 3 ? Math.exp(-Math.max(0, hg) / 0.7) : 0;
    a *= 1 - 0.20 * Math.exp(-Math.max(0, hg) / 0.3);
    streak = streak * this.dirt;
    const grey = Math.min(0.7, 0.55 * gz * this.dirt + streak * 1.4);
    const lum = (r + g + b) / 3;
    r += (lum * 0.9 - r) * grey; g += (lum * 0.9 - g) * grey; b += (lum * 0.93 - b) * grey;
    const dk = a * (1 - streak) * (1 - 0.2 * gz * this.dirt);
    out[0] = r * dk; out[1] = g * dk; out[2] = b * dk;
  }
}

/** Colour of dressed trim stone (surrounds, mouldings): slightly lighter, soffits darker. */
export function trimColor(fs, u, v, nv, out, k = 1.04) {
  fs.wall(u, v, out);
  const soffit = nv < -0.3 ? 0.78 : 1;
  out[0] *= k * soffit; out[1] *= k * soffit; out[2] *= k * soffit;
}
