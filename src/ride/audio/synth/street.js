// Street one-shots: bird notes (phrases are assembled at runtime) and calls,
// footsteps on stone, café clinks, cars passing on distant streets, a far-off horn.
import { arng, Biquad, addMode, noiseGen, normalize, normalizeRms, fadeEnds } from '../dsp.js';

export const NOTES = { sparrow: 18, bulbul: 12 };

const TAU = Math.PI * 2;

/**
 * One bird note; the ambience layer strings these into phrases (random count, order
 * and spacing), so no phrase ever repeats. 'sparrow': a buzzy "cheep" - a rising /
 * falling sweep with fast FM, a few harmonics and ~30 % noise excited at the sweep
 * frequency; 'bulbul': a fuller whistled note with a fast trill.
 */
export function birdNote(sr, kind, k) {
  const rng = arng('bnote', kind, k);
  const nz = noiseGen(rng);
  let d, f, fm, dev, harm, noiseAmt, shape, q;
  if (kind === 'sparrow') {
    d = rng.range(0.045, 0.11);
    const fA = rng.range(2900, 4300), fP = fA + rng.range(400, 1600), fE = fA - rng.range(200, 1100), up = rng.range(0.2, 0.45);
    f = (u) => (u < up ? fA + (fP - fA) * (u / up) : fP + (fE - fP) * ((u - up) / (1 - up)));
    fm = rng.range(80, 150); dev = rng.range(200, 400);
    harm = [1, rng.range(0.2, 0.45), rng.range(0.05, 0.15)];
    noiseAmt = rng.range(0.4, 0.6); shape = rng.range(0.8, 1.6); q = rng.range(7, 11);
  } else {
    d = rng.range(0.1, 0.26);
    const f0 = rng.range(1400, 2700), f1 = f0 * rng.range(0.75, 1.35);
    f = (u) => f0 + (f1 - f0) * u;
    fm = rng.range(18, 30); dev = f0 * rng.range(0.012, 0.025);
    harm = [1, rng.range(0.05, 0.12), rng.range(0.02, 0.05)];
    noiseAmt = rng.range(0.12, 0.22); shape = rng.range(0.5, 0.9); q = 14;
  }
  const n = Math.floor((d + 0.01) * sr), m = Math.floor(d * sr);
  const tone = new Float32Array(n), noise = new Float32Array(n);
  const bp = new Biquad(sr, 'bandpass', f(0), q);
  let ph = 0, fmPh = rng.next();
  for (let i = 0; i < m; i++) {
    const u = i / m;
    fmPh += fm / sr;
    const fi = f(u) + dev * Math.sin(2 * Math.PI * fmPh);
    ph += fi / sr;
    const env = Math.pow(Math.sin(Math.PI * u), shape);
    let x = 0;
    for (let h = 0; h < harm.length; h++) if (fi * (h + 1) < sr * 0.45) x += Math.sin(2 * Math.PI * ph * (h + 1)) * harm[h];
    tone[i] = x * env;
    if ((i & 15) === 0) bp.set('bandpass', fi, q);
    noise[i] = bp.run(nz()) * env;
  }
  normalizeRms(tone, 1); normalizeRms(noise, 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = tone[i] + noise[i] * noiseAmt;
  fadeEnds(out, sr, 0.001, 0.004);
  normalize(out, 0.8);
  return out;
}

/** Bird calls played whole: 'swift' (a screaming party) | 'pigeon' (a coo). */
export function birdCall(sr, kind, k) {
  const rng = arng('bird', kind, k);
  const nz = noiseGen(rng);
  const notes = [];
  if (kind === 'swift') {
    const birds = rng.int(2, 4);
    for (let b = 0; b < birds; b++) {
      const d = rng.range(0.35, 0.8), fc = rng.range(6300, 8400), fm = rng.range(36, 50), dev = rng.range(500, 900);
      notes.push({ t: rng.range(0, 0.45), d, f: (u, tt) => fc * (1 - 0.06 * u) + dev * (2 * ((fm * tt) % 1) - 1), h: [1, 0.12], amp: rng.range(0.5, 1), shape: 0.5, am: fm, noise: 0.35 });
    }
  } else { // pigeon coo: "hoo-hrroo-hoo"
    const f0 = rng.range(400, 470);
    const parts = [[0.0, 0.26, f0, f0 * 1.08, 0.6], [0.36, 0.62, f0 * 1.12, f0 * 1.02, 1], [1.08, 0.3, f0 * 1.02, f0 * 0.94, 0.55]];
    for (const [t, d, a, b, amp] of parts) notes.push({ t, d, f: (u) => a + (b - a) * u, h: [1, 0.35, 0.12, 0.05], amp, shape: 0.8, am: 27, amDepth: 0.55, noise: 0.08 });
  }
  const dur = Math.max(...notes.map((x) => x.t + x.d)) + 0.05;
  const n = Math.floor(dur * sr);
  const out = new Float32Array(n);
  const bp = new Biquad(sr, 'bandpass', 7000, 2);
  for (const nt of notes) {
    const i0 = Math.floor(nt.t * sr), m = Math.floor(nt.d * sr);
    let ph = 0;
    bp.set('bandpass', nt.f(0.5, 0), 3);
    for (let i = 0; i < m && i0 + i < n; i++) {
      const u = i / m, tt = i / sr;
      const f = nt.f(u, tt);
      ph += f / sr;
      let env = Math.pow(Math.sin(Math.PI * u), nt.shape);
      if (nt.am) env *= 1 - (nt.amDepth ?? 0.4) * (0.5 + 0.5 * Math.sin(TAU * nt.am * tt));
      let x = 0;
      for (let h = 0; h < nt.h.length; h++) if (f * (h + 1) < sr * 0.45) x += Math.sin(TAU * ph * (h + 1)) * nt.h[h];
      if (nt.noise) x += bp.run(nz()) * nt.noise * 3;
      out[i0 + i] += x * env * nt.amp;
    }
  }
  if (kind === 'pigeon') new Biquad(sr, 'lowpass', 1600, 0.7).process(out);
  fadeEnds(out, sr, 0.002, 0.02);
  normalize(out, 0.8);
  return out;
}

/** One footfall on stone paving. k % 3: hard sole, trainer, heeled shoe. */
export function footstep(sr, k) {
  const rng = arng('step', k);
  const type = k % 3;
  const n = Math.floor(0.2 * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const body = new Biquad(sr, 'bandpass', type === 1 ? rng.range(700, 1000) : rng.range(1100, 1800), type === 1 ? 0.8 : 1.6);
  const click = new Biquad(sr, 'highpass', type === 2 ? 3000 : 2200, 0.7);
  const thud = new Biquad(sr, 'lowpass', 220, 0.8);
  const scuff = new Biquad(sr, 'bandpass', rng.range(1600, 2600), 0.7);
  const toeAt = Math.floor(rng.range(0.04, 0.075) * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let x = 0;
    if (type === 1) {
      x += scuff.run(nz()) * Math.sin(Math.PI * Math.min(1, t / 0.05)) * Math.exp(-t / 0.03) * 0.5;
      x += thud.run(nz()) * Math.exp(-t / 0.02) * 1.2;
    } else {
      x += click.run(nz()) * Math.exp(-t / (type === 2 ? 0.0012 : 0.002)) * 0.9;
      x += body.run(nz()) * Math.exp(-t / 0.012) * 0.8;
      x += thud.run(nz()) * Math.exp(-t / 0.018) * 0.8;
    }
    if (i >= toeAt) {
      const tt = (i - toeAt) / sr;
      x += body.run(nz()) * Math.exp(-tt / 0.01) * 0.35 + scuff.run(nz()) * Math.exp(-tt / 0.02) * 0.15;
    }
    out[i] = x;
  }
  if (type === 2) addMode(out, sr, 0, rng.range(3000, 4200), 0.08, 0.05);
  fadeEnds(out, sr, 0.0003, 0.02);
  normalize(out, 0.8);
  return out;
}

/** Café tableware: cup on saucer, spoon in cup, glass, cutlery on a plate. */
export function clink(sr, k) {
  const rng = arng('clink', k);
  const kind = k % 4;
  const n = Math.floor(0.7 * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const hits = kind === 1 ? rng.int(3, 6) : rng.int(1, 2);
  let t = 0.005;
  const f0 = kind === 2 ? rng.range(2600, 3600) : kind === 3 ? rng.range(3800, 5200) : rng.range(2200, 3300);
  const ratios = kind === 2 ? [1, 2.32, 4.1] : kind === 3 ? [1, 1.41, 2.73, 3.9] : [1, 1.62, 2.41, 3.33];
  const t60 = kind === 2 ? 0.55 : kind === 3 ? 0.18 : 0.22;
  for (let h = 0; h < hits; h++) {
    const i0 = Math.floor(t * sr), g = rng.range(0.5, 1) * (kind === 1 ? 0.6 : 1);
    ratios.forEach((r, j) => addMode(out, sr, i0, f0 * r * rng.range(0.995, 1.005), g / (1 + j * 0.8), t60 / (1 + j * 0.6), 0.0002));
    const hp = new Biquad(sr, 'highpass', 3000, 0.7);
    for (let i = 0; i < 0.004 * sr; i++) out[i0 + i] += hp.run(nz()) * Math.exp(-i / (0.0007 * sr)) * 0.3 * g;
    t += kind === 1 ? rng.range(0.07, 0.12) : rng.range(0.12, 0.3);
  }
  fadeEnds(out, sr, 0.0002, 0.05);
  normalize(out, 0.7);
  return out;
}

/** Distant car horn (two-tone, sometimes a double tap). */
export function carHorn(sr, k) {
  const rng = arng('horn', k);
  const f1 = rng.range(370, 450), f2 = f1 * rng.range(1.2, 1.27);
  const taps = rng.chance(0.5) ? [[0, rng.range(0.12, 0.2)], [0.26, rng.range(0.15, 0.35)]] : [[0, rng.range(0.3, 0.6)]];
  const dur = taps[taps.length - 1][0] + taps[taps.length - 1][1] + 0.1;
  const n = Math.floor(dur * sr);
  const out = new Float32Array(n);
  for (const [t0, d] of taps) {
    const i0 = Math.floor(t0 * sr), m = Math.floor(d * sr);
    for (let i = 0; i < m; i++) {
      const t = i / sr, env = Math.min(1, t / 0.012) * Math.min(1, (d - t) / 0.03);
      let x = 0;
      for (const f of [f1, f2]) for (let h = 1; h <= 9; h += 2) x += Math.sin(TAU * f * h * t) / h;
      out[i0 + i] += x * env;
    }
  }
  new Biquad(sr, 'lowpass', 2200, 0.7).process(out);
  new Biquad(sr, 'peaking', 900, 1, 4).process(out);
  fadeEnds(out, sr, 0.001, 0.05);
  normalize(out, 0.7);
  return out;
}

/**
 * One vehicle passing on a distant cross street (mono; the ambience layer schedules
 * these at random with their own pan sweep, over a live far-traffic rumble): tyre
 * roar and engine harmonics under a Gaussian pass envelope with a slight Doppler drop.
 */
export function carPass(sr, k) {
  const rng = arng('carpass', k);
  const w = rng.range(1.2, 2.8), heavy = k % 5 === 4;
  const fe = rng.range(26, 46) * (heavy ? 0.7 : 1);
  const n = Math.floor(6 * w * sr), tc = 3 * w;
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const tyre = new Biquad(sr, 'bandpass', rng.range(550, 900), 0.6);
  const eng = new Biquad(sr, 'lowpass', heavy ? 380 : 520, 0.7);
  const dist = new Biquad(sr, 'lowpass', rng.range(1300, 2400), 0.6);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, u = (t - tc) / w;
    const env = Math.exp(-0.5 * u * u);
    ph += (fe * (1 + 0.04 * Math.tanh(-u))) / sr;
    let e = 0;
    for (let h = 1; h <= 6; h++) e += Math.sin(TAU * ph * h + h) / (h * (heavy ? 0.8 : 1.3));
    out[i] = dist.run(tyre.run(nz()) * 0.9 + eng.run(e) * (heavy ? 0.35 : 0.18)) * env;
  }
  fadeEnds(out, sr, 0.05, 0.05);
  normalize(out, 0.8);
  return out;
}
