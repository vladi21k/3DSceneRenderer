// Vertex colour model for the masonry: per-building stone tint, baked ambient
// occlusion (under cornices, string courses and balconies, in reveals, at the base),
// large soft patches of stone variation, and a per-vertex grime mask (out[3], the
// aGrime attribute) that tells the weathered stone materials (grime.js) where to put
// drip trails, rain-wash streaks and soot crusts: in strips under sill ends and
// balcony slab ends, under cornice and course soffits, in the splash zone, and all
// over the facades of the few buildings that were never cleaned.
// Colour factors are linear multipliers on the material albedo.

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
/** Hash of two integers and a seed in [0, 1) (per-block variation). */
export function hash3(a, b, seed = 0) { return ihash(a | 0, b | 0, seed); }

/**
 * Per-building stone colour: a multiplier around 1 on the library albedo (the baked
 * texture carries the limestone colour). The plan's absolute tints are taken relative
 * to the cream reference, so cream = 1, honey/golden warmer, pale/grey cooler. Wide
 * enough that neighbours read as golden-honey, grey-white or dirty grey stone, as in
 * the street; about one building in seven was never cleaned (sooty grey, streaked).
 */
const CREAM = [0.86, 0.80, 0.68];
export function stoneStyle(plan, rng) {
  const t = plan.style.tint;
  const bright = rng.weighted([[rng.range(0.93, 1.05), 0.6], [rng.range(0.8, 0.92), 0.25], [rng.range(1.05, 1.12), 0.15]]);
  const warm = rng.range(-0.07, 0.07);
  const uncleaned = rng.chance(0.15) ? rng.range(0.7, 1) : 0;
  const tint = [0, 1, 2].map((i) => Math.pow(t[i] / CREAM[i], 1.25) * bright * (1 + warm * (1 - i)));
  return { tint, uncleaned };
}

// current dressed-block variation (see setBlock), applied by trimColor
let blockH = -1;
/** Per-block tone for the next trim stones (h in [0, 1), or -1 for none). */
export function setBlock(h) { blockH = h; }

/**
 * Shading context for one facade face (front or corner return). Precomputes a 1D
 * occlusion / grime table along v and bins the local occluders so per-vertex cost
 * stays tiny. opts: {dirt (0.6..1.3), uncleaned (0..1), sillExt (sill overhang beyond
 * the jambs, m)}.
 */
export class FaceShade {
  constructor(face, tint, seed, opts = {}) {
    this.tint = tint;
    this.seed = seed | 0;
    this.groundAt = face.groundAt;
    this.width = face.width;
    this.dirt = opts.dirt ?? 1;
    this.unc = opts.uncleaned || 0;
    const top = face.cornice ? face.cornice.y : 20;
    this.corniceY = top;
    // 1D AO and grime tables along v (5 cm steps)
    const vMin = -3, vMax = top + 2, step = 0.05;
    const n = Math.ceil((vMax - vMin) / step) + 1;
    const ao = new Float32Array(n).fill(1), gm = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = vMin + i * step;
      let a = 1, g = 0.06;
      const dc = top - v;
      if (dc >= 0) {
        a *= 1 - 0.30 * Math.exp(-dc / 0.45) - 0.06 * Math.exp(-dc / 2.0);
        // soot crust right under the cornice soffit, rain wash running down from it
        g += 0.7 * Math.exp(-dc / 0.7) + 0.3 * Math.exp(-dc / 3.5);
      }
      for (const c of face.courses || []) {
        const d = c.y - v;
        if (d >= 0 && d < 1.6) { a *= 1 - 0.13 * Math.exp(-d / 0.22); g += 0.38 * Math.exp(-d / 0.5); }
      }
      // never-cleaned facades: soot heavier towards the top, where rain does not wash
      if (this.unc) g += this.unc * (0.25 + 0.3 * Math.min(1, Math.max(0, v / top)));
      ao[i] = a; gm[i] = g;
    }
    this.ao = ao; this.gm = gm; this.vMin = vMin; this.step = step; this.n = n;
    // local occluders binned per metre of v: balconies (soffit occlusion, and water /
    // rust running off the slab ends) and window sills (dirt running off the sill ends)
    this.bins = [];
    const bin = (y0, y1, item) => {
      for (let i = Math.max(0, Math.floor(y0 - vMin)); i <= Math.floor(y1 - vMin); i++) (this.bins[i] || (this.bins[i] = [])).push(item);
    };
    for (const b of face.balconies || []) {
      const it = { bal: true, a: b.u0, b: b.u1, y: b.y - 0.02, d: b.depth || 0.9, s: 0.7 + 0.6 * hash1(b.u0 * 31 + b.y * 5, seed) };
      bin(it.y - BAL_RUN, it.y, it);
    }
    const ext = opts.sillExt ?? 0.15;
    for (const o of face.openings || []) {
      if (o.kind !== 'window') continue;
      const it = { bal: false, a: o.uc - o.w / 2 - ext, b: o.uc + o.w / 2 + ext, y: o.y - 0.12, s: 0.5 + 0.8 * hash1(o.uc * 13 + o.y * 7, seed) };
      bin(it.y - SILL_RUN, it.y, it);
    }
  }

  /** Wall field colour at (u, v) into out[0..2], grime mask into out[3]. */
  wall(u, v, out) {
    const t = this.tint;
    let i = ((v - this.vMin) / this.step) | 0;
    if (i < 0) i = 0; else if (i >= this.n) i = this.n - 1;
    let a = this.ao[i], g = this.gm[i];
    let rust = 0, wash = 0;
    const list = this.bins[Math.floor(v - this.vMin)];
    if (list) {
      for (let k = 0; k < list.length; k++) {
        const it = list[k];
        if (u < it.a - 0.25 || u > it.b + 0.25) continue;
        const d = it.y - v;
        if (d < 0) continue;
        // strips centred just inside each end: water runs off there
        const e = Math.max(tri(u - (it.a + END_IN), END_W), tri(u - (it.b - END_IN), END_W));
        if (it.bal) {
          const inside = Math.min(1, (u - it.a + 0.14) / 0.22, (it.b + 0.14 - u) / 0.22);
          if (inside > 0 && d < 2.5) a *= 1 - 0.30 * inside * Math.exp(-d / (0.55 * it.d));
          if (inside > 0) g += 0.3 * inside * Math.exp(-d / 0.5);
          const run = e * it.s * Math.exp(-d / 3.2);
          g += 0.95 * run; rust += 0.6 * run;
        } else {
          const inside = Math.min(1, (u - it.a) / 0.2, (it.b - u) / 0.2);
          if (inside > 0) g += 0.22 * inside * Math.exp(-d / 0.7);
          const run = e * it.s * Math.exp(-d / 2.4);
          g += 0.8 * run; wash += 0.06 * run;
        }
      }
    }
    // large soft patches (stone batches, cleaning, sun bleaching)
    const n1 = noise2(u * 0.35, v * 0.28, this.seed);
    const p = n1 - 0.5 + 0.35 * (noise2(u * 1.3, v * 0.9, this.seed + 7) - 0.5);
    let r = t[0] * (1 + 0.10 * p), gg = t[1] * (1 + 0.10 * p), b = t[2] * (1 + 0.11 * p);
    // splash zone near the paving: darker, greyer
    const hg = v - this.groundAt(u);
    const gz = hg < 3 ? Math.exp(-Math.max(0, hg) / 0.7) : 0;
    a *= 1 - 0.20 * Math.exp(-Math.max(0, hg) / 0.3);
    g += 0.55 * Math.exp(-Math.max(0, hg) / 0.5);
    // building-scale variation of how dirty the stone is
    g *= this.dirt * (0.6 + 0.8 * n1);
    const grey = Math.min(0.7, 0.45 * gz * this.dirt + wash * 1.4 + 0.35 * this.unc);
    const lum = (r + gg + b) / 3;
    r += (lum * 0.9 - r) * grey; gg += (lum * 0.9 - gg) * grey; b += (lum * 0.93 - b) * grey;
    // never-cleaned stone is darker overall, more so up under the cornice
    const sootK = this.unc ? 1 - this.unc * (0.12 + 0.12 * Math.min(1, Math.max(0, v / this.corniceY))) : 1;
    const dk = a * (1 - wash) * (1 - 0.18 * gz * this.dirt) * sootK;
    // iron from the balcony fixings: a faint warm-brown cast in the run-off strips
    out[0] = r * dk * (1 - 0.08 * rust); out[1] = gg * dk * (1 - 0.13 * rust); out[2] = b * dk * (1 - 0.2 * rust);
    out[3] = Math.min(1, g);
  }
}

// run-off strips: length below the sill / slab, half width, inset from the end
const SILL_RUN = 3.4, BAL_RUN = 3.8, END_W = 0.2, END_IN = 0.08;
/** Columns the wall field needs for the run-off strips of an occluder spanning [a, b]. */
export function runoffSplits(a, b) {
  return [a - 0.14, a + END_IN, a + END_IN + END_W, b - END_IN - END_W, b - END_IN, b + 0.14];
}
export { SILL_RUN, BAL_RUN };
const tri = (x, w) => Math.max(0, 1 - Math.abs(x) / w);

/**
 * Colour of dressed trim stone (surrounds, mouldings): slightly lighter, soffits darker
 * and sootier, tops collecting dirt; per-block tone when setBlock() is active.
 */
export function trimColor(fs, u, v, nv, out, k = 1.04) {
  fs.wall(u, v, out);
  const soffit = nv < -0.3 ? 0.78 : 1;
  let kr = k * soffit, kg = kr, kb = kr;
  if (blockH >= 0) {
    // dressed blocks differ in tone from one another (different beds of the quarry)
    const s = 0.93 + 0.13 * blockH, wc = (hash1(blockH * 7919, 5) - 0.5) * 0.04;
    kr *= s * (1 + wc); kg *= s; kb *= s * (1 - wc);
  }
  out[0] *= kr; out[1] *= kg; out[2] *= kb;
  if (nv < -0.3) out[3] = Math.min(1, out[3] + 0.35);
  else if (nv > 0.5) out[3] = Math.min(1, out[3] + 0.25);
}
