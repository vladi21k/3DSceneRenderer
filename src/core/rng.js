// Deterministic hashing / random numbers. Every generator must derive its randomness
// from these so the world is identical every visit and every run.

export function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function hash2(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}

/** mulberry32 PRNG with helpers. */
export class RNG {
  constructor(seed = 1) { this.state = (seed >>> 0) || 0x6d2b79f5; }
  static from(...parts) {
    let h = 0x1234567;
    for (const p of parts) h = hash2(h, typeof p === 'string' ? hashStr(p) : Math.floor(p * 1000) | 0);
    return new RNG(h);
  }
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); } // inclusive
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  weighted(items) { // [[value, weight], ...]
    let tot = 0; for (const it of items) tot += it[1];
    let r = this.next() * tot;
    for (const it of items) { r -= it[1]; if (r <= 0) return it[0]; }
    return items[items.length - 1][0];
  }
  normal(mean = 0, sd = 1) {
    const u = Math.max(1e-9, this.next()), v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

// Lattice values of the noises in [-1, 1]: hash2(i, seed) (1D) and hash2(hash2(x, y), seed)
// (2D), written out in place into _L (bit-identical to calling hash2). The noises run per
// vertex, per agent and per frame: a call that returns a hash (a uint32 above the small-
// integer range) or a double is not always inlined, and then every return value is a heap
// allocation; here only the noise's own result can be.
const _L = new Float64Array(4);
const _INV = 1 / 4294967296;

/** _L[0] = value at i0, _L[1] = value at i1. */
function _lattice1(i0, i1, seed) {
  const sb = Math.imul((seed | 0) + 0x632be5ab, 0xc2b2ae35);
  let h = Math.imul((i0 | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ sb;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  _L[0] = ((h >>> 0) * _INV) * 2 - 1;
  h = Math.imul((i1 | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ sb;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  _L[1] = ((h >>> 0) * _INV) * 2 - 1;
}

/** _L[k] = value at (k & 1 ? x1 : x0, k & 2 ? y1 : y0). */
function _lattice2(x0, x1, y0, y1, seed) {
  const sb = Math.imul((seed | 0) + 0x632be5ab, 0xc2b2ae35);
  for (let k = 0; k < 4; k++) {
    const a = k & 1 ? x1 : x0, b = k & 2 ? y1 : y0;
    let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    // (the outer hash takes the inner one as an int32: (uint32 | 0) is h itself)
    h = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b) ^ sb;
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    _L[k] = ((h >>> 0) * _INV) * 2 - 1;
  }
}

/** Smooth 1D value noise in [-1,1], deterministic per seed. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  _lattice1(i, i + 1, seed);
  const a = _L[0], b = _L[1];
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/** Smooth 2D value noise in [-1,1], deterministic per seed. */
export function noise2(x, y, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  _lattice2(ix, ix + 1, iy, iy + 1, seed);
  const a = _L[0], b = _L[1], c = _L[2], d = _L[3];
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** 1D value noise in [-1,1] that repeats every `period` lattice cells (period: integer ≥ 1). */
export function noise1p(x, period, seed = 0) {
  const i = Math.floor(x), f = x - i;
  _lattice1(((i % period) + period) % period, (((i + 1) % period) + period) % period, seed);
  const a = _L[0], b = _L[1];
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/** 2D value noise in [-1,1], periodic in x with `periodX` lattice cells. */
export function noise2p(x, y, periodX, seed = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const x0 = ((ix % periodX) + periodX) % periodX, x1 = (((ix + 1) % periodX) + periodX) % periodX;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  _lattice2(x0, x1, iy, iy + 1, seed);
  const a = _L[0], b = _L[1], c = _L[2], d = _L[3];
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Periodic helpers for quantities along the closed route: wavelength is adjusted so a
 *  whole number of cells fits the loop length L (no seam where s wraps). */
export function loopNoise1(s, L, wavelength, seed = 0) {
  const cells = Math.max(1, Math.round(L / wavelength));
  return noise1p((s / L) * cells, cells, seed);
}
export function loopNoise2(s, y, L, wavelength, yScale, seed = 0) {
  const cells = Math.max(1, Math.round(L / wavelength));
  return noise2p((s / L) * cells, y / yScale, cells, seed);
}
