// Wheel/rail sounds: the rolling-noise texture loop and the impact family
// (rail joints, switch frogs, check-rail scrape, brake stick-slip at standstill).
import { arng, Biquad, Resonator, SlowNoise, addMode, noiseGen, normalize, normalizeRms, makeLoop, fadeEnds } from '../dsp.js';

export const ROLL_VREF = 10;             // m/s the texture is synthesized at (playbackRate = v / VREF)
export const WHEEL_CIRC = 2.07;          // m, 660 mm wheels

/**
 * Rolling noise heard in the cab at VREF. Everything in it is excitation that scales
 * with speed (roughness, corrugation, wheel out-of-roundness, grit in the groove), so
 * the live layer only changes playbackRate and level; fixed body resonances are
 * applied by live filters afterwards.
 */
export function rollingTexture(sr) {
  const period = WHEEL_CIRC / ROLL_VREF;           // one wheel revolution at VREF
  const n = Math.round(32 * period * sr);          // loop = whole number of revolutions
  const fade = Math.floor(0.25 * sr);
  const chans = [];
  const common = synthRoll(sr, n + fade, 'c', period);
  for (let ch = 0; ch < 2; ch++) {
    const own = synthRoll(sr, n + fade, ch, period);
    const x = new Float32Array(n + fade);
    for (let i = 0; i < x.length; i++) x[i] = common[i] * 0.8 + own[i] * 0.6;
    chans.push(makeLoop(x, n, fade));
  }
  normalizeRms(chans, 0.22);
  normalize(chans, Math.min(0.98, peakOf(chans)));
  return chans;
}

function peakOf(chans) { let m = 0; for (const c of chans) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i])); return m; }

function synthRoll(sr, n, tag, period) {
  const rng = arng('roll', tag);
  const nz = noiseGen(rng);
  const out = new Float32Array(n);
  // structure-borne rumble (axle box -> bogie -> floor)
  const s1 = new Biquad(sr, 'lowpass', 190, 0.9), s2 = new Biquad(sr, 'highpass', 28, 0.7);
  // airborne rolling roar
  const a1 = new Biquad(sr, 'bandpass', 620, 0.55), a2 = new Biquad(sr, 'lowpass', 2400, 0.7);
  // corrugation: quasi-tonal band (lambda ~ 45 mm -> 220 Hz at VREF), with a weaker second
  const c1 = new Resonator(sr).set(222 * rng.range(0.97, 1.03), 22);
  const c2 = new Resonator(sr).set(445 * rng.range(0.97, 1.03), 40);
  // grit / debris in the rail groove: sparse crackle
  const g1 = new Biquad(sr, 'highpass', 1800, 0.7), g2 = new Biquad(sr, 'lowpass', 7000, 0.7);
  const slow = new SlowNoise(sr, 2.5, nz);
  const fw = 1 / period, ph1 = rng.range(0, 6.28), ph2 = rng.range(0, 6.28);
  let grit = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // wheel out-of-roundness modulates the rumble once (and twice) per revolution
    const wheel = 1 + 0.22 * Math.sin(6.2832 * fw * t + ph1) + 0.08 * Math.sin(12.566 * fw * t + ph2);
    const drift = Math.max(0.3, 1 + 0.18 * slow.run());
    const w = nz();
    const sb = s2.run(s1.run(w)) * 2.4 * wheel;
    const ab = a2.run(a1.run(nz())) * 0.9 * drift;
    const cor = (c1.run(nz()) * 0.022 + c2.run(nz()) * 0.012) * wheel;
    if (rng.next() < 26 / sr) grit = rng.range(0.2, 1) ** 2 * 0.9;
    grit *= 0.9965;
    const gr = g2.run(g1.run(nz() * grit)) * 0.5;
    out[i] = sb + ab + cor + gr;
  }
  return out;
}

/** Rail-joint impact as heard in the cab: floor thump, body knock, faint wheel ring. */
export function clack(sr, k) {
  const rng = arng('clack', k);
  const n = Math.floor(0.42 * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const f0 = rng.range(68, 104);
  const dTh = rng.range(0.035, 0.06);
  let ph = 0;
  const body = new Biquad(sr, 'bandpass', rng.range(420, 780), 1.1);
  const click = new Biquad(sr, 'highpass', 1600, 0.7);
  const lp = new Biquad(sr, 'lowpass', 5200, 0.7);
  const second = Math.floor(rng.range(0.003, 0.009) * sr); // wheel lands on the far rail end
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    ph += (6.2832 * f0 * (1 + 0.6 * Math.exp(-t / 0.008))) / sr;
    let x = Math.sin(ph) * Math.exp(-t / dTh) * 1.0;
    x += body.run(nz()) * Math.exp(-t / 0.018) * 1.3;
    x += click.run(nz()) * Math.exp(-t / 0.0012) * 0.35;
    if (i >= second) x += body.run(nz()) * Math.exp(-(i - second) / (0.012 * sr)) * 0.7;
    out[i] = lp.run(x);
  }
  // wheel/rail ring
  for (let j = 0; j < 4; j++) addMode(out, sr, 0, rng.range(900, 1400) * (1 + j * 0.85), rng.range(0.02, 0.06), rng.range(0.05, 0.16));
  fadeEnds(out, sr, 0.0003, 0.05);
  normalize(out, 0.9);
  return out;
}

/** Switch frog: the wheel crosses the flangeway gap - a heavier double knock with ring. */
export function frog(sr, k) {
  const rng = arng('frog', k);
  const n = Math.floor(0.7 * sr);
  const out = new Float32Array(n);
  const a = clack(sr, 100 + k), b = clack(sr, 200 + k);
  const gap = Math.floor(rng.range(0.012, 0.03) * sr);
  for (let i = 0; i < a.length; i++) out[i] += a[i] * 0.8;
  for (let i = 0; i < b.length && i + gap < n; i++) out[i + gap] += b[i];
  for (let j = 0; j < 5; j++) addMode(out, sr, gap, rng.range(600, 950) * (1 + j * 0.9), rng.range(0.04, 0.09), rng.range(0.15, 0.35));
  fadeEnds(out, sr, 0.0003, 0.08);
  normalize(out, 0.95);
  return out;
}

/** Flange against a check rail / switch blade: a short grinding scrape. */
export function scrape(sr, k) {
  const rng = arng('scrape', k);
  const n = Math.floor(0.9 * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const r1 = new Resonator(sr).set(rng.range(1700, 2300), 160);
  const r2 = new Resonator(sr).set(rng.range(2900, 3600), 260);
  const hp = new Biquad(sr, 'highpass', 900, 0.7);
  const jit = new SlowNoise(sr, 35, nz);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.05) * Math.exp(-Math.max(0, t - 0.35) / 0.18);
    const j = 0.4 + Math.abs(jit.run()) * 0.8;
    const x = nz() * j;
    out[i] = hp.run(r1.run(x) * 0.6 + r2.run(x) * 0.4 + x * 0.05) * env;
  }
  fadeEnds(out, sr, 0.002, 0.05);
  normalize(out, 0.8);
  return out;
}

/** Brake stick-slip groan in the last metre before standstill, ending in a settle clunk. */
export function brakeCreak(sr, k) {
  const rng = arng('creak', k);
  const dur = 1.25, n = Math.floor(dur * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const freqs = [rng.range(150, 190), rng.range(380, 460), rng.range(1050, 1300)];
  const rs = freqs.map((f, j) => new Resonator(sr).set(f, [14, 22, 45][j]));
  // a unity-DC resonator rings with amplitude ~ omega, so divide that out to set the balance
  const amps = [1.0, 0.55, 0.22].map((a, j) => a / ((6.2832 * freqs[j]) / sr));
  let ph = 0;
  const end = Math.floor(1.0 * sr);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const rate = 34 - 22 * (t / 1.0);                    // slip events slow as the wheel stops
    ph += rate / sr;
    let pulse = 0;
    if (ph >= 1) { ph -= 1; pulse = rng.range(0.6, 1.2); }
    const env = i < end ? Math.pow(t / 1.0, 0.8) : 0;
    const x = pulse * env + nz() * 0.004 * env;
    out[i] = rs[0].run(x) * amps[0] + rs[1].run(x) * amps[1] + rs[2].run(x) * amps[2];
  }
  // settle clunk: the body pitches back as the tram comes to rest
  const lp = new Biquad(sr, 'lowpass', 180, 0.9);
  for (let i = 0; i < n - end; i++) {
    const t = i / sr;
    out[end + i] += lp.run(Math.sin(6.2832 * 62 * t) * Math.exp(-t / 0.06) + nz() * 0.2 * Math.exp(-t / 0.01)) * 0.9;
  }
  fadeEnds(out, sr, 0.01, 0.04);
  normalize(out, 0.85);
  return out;
}
