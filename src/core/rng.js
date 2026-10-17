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

/** Smooth 1D value noise in [-1,1], deterministic per seed. */
export function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const a = (hash2(i, seed) / 4294967296) * 2 - 1;
  const b = (hash2(i + 1, seed) / 4294967296) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}
