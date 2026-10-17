// Small DSP toolkit used to synthesize the sample bank offline (plain JS loops at
// start-up) plus a few helpers for driving WebAudio parameters without zipper noise.
import { RNG } from '../../core/rng.js';

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => 20 * Math.log10(Math.max(1e-9, g));

/** Deterministic RNG for an audio asset. */
export const arng = (...parts) => RNG.from('audio', ...parts);

/** Fast uniform noise source in [-1, 1] (xorshift32), seeded from an RNG. */
export function noiseGen(rng) {
  let x = (Math.floor(rng.next() * 4294967295) | 1) >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 2147483648 - 1;
  };
}

/** RBJ cookbook biquad (transposed direct form II), per-sample. */
export class Biquad {
  constructor(sr, type = 'lowpass', f = 1000, q = 0.707, gainDb = 0) {
    this.sr = sr; this.z1 = 0; this.z2 = 0;
    this.set(type, f, q, gainDb);
  }
  set(type, f, q = 0.707, gainDb = 0) {
    const w = (TAU * clamp(f, 5, this.sr * 0.49)) / this.sr;
    const cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * q), A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; break;
      case 'peaking': b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * (A + 1 - (A - 1) * cw + s); b1 = 2 * A * (A - 1 - (A + 1) * cw); b2 = A * (A + 1 - (A - 1) * cw - s);
        a0 = A + 1 + (A - 1) * cw + s; a1 = -2 * (A - 1 + (A + 1) * cw); a2 = A + 1 + (A - 1) * cw - s; break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * al;
        b0 = A * (A + 1 + (A - 1) * cw + s); b1 = -2 * A * (A - 1 + (A + 1) * cw); b2 = A * (A + 1 + (A - 1) * cw - s);
        a0 = A + 1 - (A - 1) * cw + s; a1 = 2 * (A - 1 - (A + 1) * cw); a2 = A + 1 - (A - 1) * cw - s; break;
      }
      default: throw new Error(`biquad type ${type}`);
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  process(buf, from = 0, to = buf.length) { for (let i = from; i < to; i++) buf[i] = this.run(buf[i]); return buf; }
}

/** Two-pole resonator with unity gain at DC (formant / modal filter). */
export class Resonator {
  constructor(sr) { this.sr = sr; this.y1 = 0; this.y2 = 0; this.A = 1; this.B = 0; this.C = 0; }
  set(f, bw) {
    const r = Math.exp((-Math.PI * bw) / this.sr);
    this.C = -r * r;
    this.B = 2 * r * Math.cos((TAU * f) / this.sr);
    this.A = 1 - this.B - this.C;
    return this;
  }
  run(x) { const y = this.A * x + this.B * this.y1 + this.C * this.y2; this.y2 = this.y1; this.y1 = y; return y; }
}

/** Antiresonator (spectral zero), the inverse of Resonator: Klatt's nasal zero. */
export class AntiResonator {
  constructor(sr) { this.sr = sr; this.x1 = 0; this.x2 = 0; this.A = 1; this.B = 0; this.C = 0; }
  set(f, bw) {
    const r = Math.exp((-Math.PI * bw) / this.sr);
    const C = -r * r, B = 2 * r * Math.cos((TAU * f) / this.sr), A = 1 - B - C;
    this.A = 1 / A; this.B = -B / A; this.C = -C / A;
    return this;
  }
  run(x) { const y = this.A * x + this.B * this.x1 + this.C * this.x2; this.x2 = this.x1; this.x1 = x; return y; }
}

/** One-pole lowpass (cutoff in Hz). */
export class OnePole {
  constructor(sr, f) { this.sr = sr; this.y = 0; this.set(f); }
  set(f) { this.k = 1 - Math.exp((-TAU * f) / this.sr); return this; }
  run(x) { this.y += this.k * (x - this.y); return this.y; }
}

/**
 * Add an exponentially decaying sine (a struck mode) into `out` starting at sample i0.
 * t60 is the time for a 60 dB decay. Uses a rotating phasor, so it is cheap.
 */
export function addMode(out, sr, i0, f, amp, t60, attack = 0.0006, phase = 0) {
  if (f >= sr * 0.48 || amp === 0) return;
  const n = Math.min(out.length - i0, Math.ceil(t60 * 1.1 * sr));
  const decay = Math.exp(-6.907755 / (t60 * sr));
  const w = (TAU * f) / sr, c = Math.cos(w), s = Math.sin(w);
  let re = Math.cos(phase), im = Math.sin(phase), g = amp;
  const na = Math.max(1, Math.floor(attack * sr));
  for (let i = 0; i < n; i++) {
    const a = i < na ? 0.5 - 0.5 * Math.cos((Math.PI * i) / na) : 1;
    out[i0 + i] += im * g * a;
    const r2 = re * c - im * s; im = re * s + im * c; re = r2;
    g *= decay;
  }
}

/** Band-limited random modulation: one-pole lowpassed noise scaled to unit RMS. */
export class SlowNoise {
  constructor(sr, f, nz) {
    this.nz = nz; this.y = 0;
    this.k = 1 - Math.exp((-TAU * f) / sr);
    this.g = 1 / (0.57735 * Math.sqrt(this.k / (2 - this.k)));
  }
  run() { this.y += this.k * (this.nz() - this.y); return this.y * this.g; }
}

/** Peak-normalize in place to `peak`. Works on one or several channels. */
export function normalize(chans, peak = 0.95) {
  const list = Array.isArray(chans) ? chans : [chans];
  let m = 1e-9;
  for (const c of list) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > m) m = a; }
  const g = peak / m;
  for (const c of list) for (let i = 0; i < c.length; i++) c[i] *= g;
  return list;
}

/** RMS-normalize in place. */
export function normalizeRms(chans, rms = 0.2) {
  const list = Array.isArray(chans) ? chans : [chans];
  let e = 0, n = 0;
  for (const c of list) { for (let i = 0; i < c.length; i++) e += c[i] * c[i]; n += c.length; }
  const g = rms / Math.sqrt(e / Math.max(1, n) + 1e-12);
  for (const c of list) for (let i = 0; i < c.length; i++) c[i] *= g;
  return list;
}

/**
 * Feed-forward compressor applied in place (linked channels). threshold is linear
 * amplitude; attack/release in seconds. Used to tame the crest factor of beds.
 */
export function compress(chans, sr, { threshold = 0.3, ratio = 3, attack = 0.005, release = 0.12 } = {}) {
  const list = Array.isArray(chans) ? chans : [chans];
  const ka = 1 - Math.exp(-1 / (attack * sr)), kr = 1 - Math.exp(-1 / (release * sr));
  let env = 0;
  for (let i = 0; i < list[0].length; i++) {
    let a = 0;
    for (const c of list) a = Math.max(a, Math.abs(c[i]));
    env += (a > env ? ka : kr) * (a - env);
    if (env > threshold) {
      const g = Math.pow(env / threshold, 1 / ratio - 1);
      for (const c of list) c[i] *= g;
    }
  }
  return list;
}

/**
 * Look-ahead peak limiter applied in place: the gain never lets |x| exceed `ceiling`,
 * ramps down ahead of each peak (attack) and recovers smoothly (release).
 */
export function limit(chans, sr, ceiling = 0.5, attack = 0.002, release = 0.06) {
  const list = Array.isArray(chans) ? chans : [chans];
  const n = list[0].length, g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (const c of list) a = Math.max(a, Math.abs(c[i]));
    g[i] = a > ceiling ? ceiling / a : 1;
  }
  const ka = 1 - Math.exp(-1 / (attack * sr)), kr = 1 - Math.exp(-1 / (release * sr));
  for (let i = n - 2; i >= 0; i--) g[i] = Math.min(g[i], g[i + 1] + (1 - g[i + 1]) * ka);
  for (let i = 1; i < n; i++) g[i] = Math.min(g[i], g[i - 1] + (1 - g[i - 1]) * kr);
  for (const c of list) for (let i = 0; i < n; i++) c[i] *= g[i];
  return list;
}

/**
 * Turn a buffer that is `fade` samples longer than wanted into a seamless loop of
 * length n: the overshoot is cross-faded (equal power) over the first `fade` samples.
 */
export function makeLoop(x, n, fade) {
  const out = x.slice(0, n);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    out[i] = x[i] * Math.sin(t * Math.PI * 0.5) + x[n + i] * Math.cos(t * Math.PI * 0.5);
  }
  return out;
}

/** Short fade in/out at the buffer ends so one-shots never click. */
export function fadeEnds(c, sr, inS = 0.001, outS = 0.01) {
  const a = Math.floor(inS * sr), b = Math.floor(outS * sr), n = c.length;
  for (let i = 0; i < a && i < n; i++) c[i] *= i / a;
  for (let i = 0; i < b && i < n; i++) c[n - 1 - i] *= i / b;
  return c;
}

/** Wrap a list of Float32Arrays (channels) into an AudioBuffer. */
export function toBuffer(chans, sr) {
  const list = Array.isArray(chans) ? chans : [chans];
  const buf = new AudioBuffer({ numberOfChannels: list.length, length: list[0].length, sampleRate: sr });
  list.forEach((c, i) => buf.copyToChannel(c, i));
  return buf;
}

/** Yield to the event loop so long synthesis jobs never stall a frame for long. */
export const yieldTask = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- live parameter helpers

/**
 * Glide an AudioParam towards `v` (exponential approach, time constant tc) from time `now`.
 * Skips redundant automation events so per-frame updates stay cheap.
 */
export function glide(param, v, now, tc = 0.05, eps = 1e-4) {
  if (!Number.isFinite(v)) return;
  const last = param.__last;
  if (last !== undefined && Math.abs(last - v) <= eps * Math.max(1, Math.abs(v))) return;
  param.__last = v;
  param.setTargetAtTime(v, now, tc);
}

/**
 * Piecewise-linear automation for values updated at a fixed tick (positions,
 * orientation): ramps to `v` so that it arrives at `tEnd`. The first value, a jump
 * larger than `jump` or a call with tEnd <= now is set immediately.
 */
export function rampTo(param, v, now, tEnd, jump = Infinity) {
  if (!Number.isFinite(v)) return;
  const last = param.__last;
  if (last === v) return;
  param.__last = v;
  if (last === undefined || tEnd <= now || Math.abs(v - last) > jump) {
    param.cancelScheduledValues(now);
    param.setValueAtTime(v, now);
    param.__t = now;
    return;
  }
  const t = Math.max(tEnd, (param.__t ?? 0) + 0.002);
  param.linearRampToValueAtTime(v, t);
  param.__t = t;
}

/** Set an AudioParam immediately at `now` (and remember it for glide()). */
export function setNow(param, v, now) { param.__last = v; param.setValueAtTime(v, now); }

/** Soft-clip transfer curve: linear up to `knee`, tanh-shaped above, never exceeds 1. */
export function softClipCurve(n = 4096, knee = 0.8) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** Periodic wave from harmonic amplitudes [h1, h2, ...] (sine phase). */
export function periodicWave(ctx, harmonics) {
  const re = new Float32Array(harmonics.length + 1), im = new Float32Array(harmonics.length + 1);
  harmonics.forEach((a, i) => { im[i + 1] = a; });
  return ctx.createPeriodicWave(re, im, { disableNormalization: false });
}
