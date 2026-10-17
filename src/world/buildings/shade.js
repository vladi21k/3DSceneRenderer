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

/** Per-building stone tint relative to the library albedo (the texture carries the base colour). */
export function stoneTint(plan, rng) {
  const t = plan.style.tint;
  const mx = Math.max(t[0], t[1], t[2]);
  const k = 0.55; // how much of the plan hue to apply on top of the texture
  const bright = rng.range(0.9, 1.0);
  return [t[0] / mx, t[1] / mx, t[2] / mx].map((c) => (1 - k + k * c) * bright);
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
    // balconies (soffit occlusion) binned per metre of v
    this.balc = [];
    for (const b of face.balconies || []) this.balc.push({ u0: b.u0 - 0.15, u1: b.u1 + 0.15, y: b.y - 0.02, d: b.depth || 0.9 });
    // sills (streaks below)
    this.sills = [];
    for (const o of face.openings || []) {
      if (o.kind !== 'window') continue;
      this.sills.push({ u0: o.uc - o.w / 2 - 0.05, u1: o.uc + o.w / 2 + 0.05, y: o.y - 0.12, s: 0.6 + 0.8 * hash1(o.uc * 13 + o.y * 7, seed) });
    }
    this.dirt = opts.dirt ?? 1;
  }

  /** Wall field colour at (u, v), written to out. */
  wall(u, v, out) {
    const t = this.tint;
    let i = ((v - this.vMin) / this.step) | 0;
    if (i < 0) i = 0; else if (i >= this.n) i = this.n - 1;
    let a = this.ao[i];
    // balcony soffits
    for (let k = 0; k < this.balc.length; k++) {
      const b = this.balc[k];
      const d = b.y - v;
      if (d < 0 || d > 2.5 || u < b.u0 - 0.4 || u > b.u1 + 0.4) continue;
      const e = Math.min(1, (u - (b.u0 - 0.4)) / 0.4, ((b.u1 + 0.4) - u) / 0.4);
      a *= 1 - 0.30 * e * Math.exp(-d / (0.55 * b.d));
    }
    // large soft patches (stone batches, cleaning, sun bleaching)
    const p = noise2(u * 0.35, v * 0.28, this.seed) - 0.5;
    const p2 = noise2(u * 1.3, v * 0.9, this.seed + 7) - 0.5;
    let r = t[0] * (1 + 0.10 * p + 0.04 * p2), g = t[1] * (1 + 0.10 * p + 0.04 * p2), b = t[2] * (1 + 0.11 * p + 0.04 * p2);
    // streaks below sills
    let streak = 0;
    for (let k = 0; k < this.sills.length; k++) {
      const s = this.sills[k];
      const d = s.y - v;
      if (d < 0 || d > 3 || u < s.u0 || u > s.u1) continue;
      const e = Math.min(1, (u - s.u0) / 0.25, (s.u1 - u) / 0.25);
      streak += 0.09 * s.s * e * Math.exp(-d / 1.3);
    }
    // dirt dripping below the cornice
    const dc = this.corniceY - v;
    if (dc > 0 && dc < 6) streak += 0.07 * Math.exp(-dc / 2.2) * (0.4 + noise2(u * 1.7, 0.5, this.seed + 3));
    // splash zone near the paving: darker, greyer
    const hg = v - this.groundAt(u);
    const gz = hg < 3 ? Math.exp(-Math.max(0, hg) / 0.8) : 0;
    a *= 1 - 0.20 * Math.exp(-Math.max(0, hg) / 0.3);
    streak = streak * this.dirt;
    const grey = Math.min(0.6, 0.45 * gz * this.dirt + streak * 1.4);
    const lum = (r + g + b) / 3;
    r += (lum * 0.92 - r) * grey; g += (lum * 0.92 - g) * grey; b += (lum * 0.95 - b) * grey;
    const dk = a * (1 - streak) * (1 - 0.12 * gz * this.dirt);
    out[0] = r * dk; out[1] = g * dk; out[2] = b * dk;
  }
}

/** Colour of dressed trim stone (surrounds, mouldings): slightly lighter, soffits darker. */
export function trimColor(fs, u, v, nv, out, k = 1.04) {
  fs.wall(u, v, out);
  const soffit = nv < -0.3 ? 0.78 : 1;
  out[0] *= k * soffit; out[1] *= k * soffit; out[2] *= k * soffit;
}
