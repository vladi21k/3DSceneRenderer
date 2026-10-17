// Source-filter voice synthesis for the crowd. Individual voices are never heard
// up close: they are summed into murmur beds (people talking 4-30 m away) and a few
// distant one-shots (a laugh, a call). Each voice: glottal pulse train with jitter,
// intonation and declination, aspiration noise, a cascade of three formant
// resonators gliding between vowel targets at syllable rate, plus fricative and
// stop-burst noise. Distance is applied as level, air absorption and stereo position.
import { arng, Biquad, Resonator, OnePole, SlowNoise, noiseGen, normalize, normalizeRms, makeLoop, compress, limit, yieldTask, clamp } from '../dsp.js';

// adult male formant targets (Hz)
const VOWELS = [
  [730, 1090, 2440], [530, 1840, 2480], [390, 1990, 2550], [270, 2290, 3010],
  [570, 840, 2410], [440, 1020, 2240], [300, 870, 2240], [500, 1500, 2500], [660, 1720, 2410],
];

/** Make a speaker: sex, pitch, vocal-tract scale, speaking rate, breathiness. */
export function makeSpeaker(rng, opts = {}) {
  const female = opts.female ?? rng.chance(0.5);
  const child = opts.child ?? false;
  return {
    female,
    f0: child ? rng.range(260, 330) : female ? rng.range(175, 235) : rng.range(95, 135),
    scale: child ? 1.32 : female ? rng.range(1.12, 1.2) : rng.range(0.95, 1.04),
    rate: rng.range(3.8, 5.8),
    breath: rng.range(0.04, 0.12) + (female ? 0.03 : 0),
    range: rng.range(0.12, 0.3), // intonation range
  };
}

/**
 * Plan an utterance: a list of segments {dur, kind, F, amp, f0m, noiseF}.
 * kind: 'v' voiced vowel/sonorant, 'f' fricative, 's' stop closure (+burst), 'p' pause.
 */
function planUtterance(rng, sp, seconds, style = 'talk') {
  const segs = [];
  let t = 0;
  const vowel = () => VOWELS[rng.int(0, VOWELS.length - 1)].map((f) => f * sp.scale);
  while (t < seconds) {
    const words = rng.int(2, 9);
    const phraseLen = words * 2.2 / sp.rate;
    let pt = 0;
    for (let w = 0; w < words && t < seconds; w++) {
      const syl = style === 'laugh' ? 1 : rng.int(1, 3);
      for (let k = 0; k < syl; k++) {
        const decl = 1 - 0.18 * clamp(pt / phraseLen, 0, 1);
        const accent = rng.chance(0.3) ? 1 + sp.range * rng.range(0.4, 1) : 1 + rng.range(-0.05, 0.06);
        const f0m = decl * accent;
        const amp = rng.range(0.55, 1) * (accent > 1.1 ? 1.15 : 1);
        if (style === 'laugh') {
          segs.push({ dur: rng.range(0.05, 0.08), kind: 'h', F: vowel(), amp: amp * 0.7, f0m, noiseF: 1500 });
        } else if (rng.chance(0.78)) {
          const c = rng.weighted([['s', 0.35], ['f', 0.3], ['n', 0.2], ['l', 0.15]]);
          if (c === 's') segs.push({ dur: rng.range(0.03, 0.07), kind: 's', F: vowel(), amp: amp * 0.8, f0m, noiseF: rng.range(1200, 3800) * sp.scale });
          else if (c === 'f') segs.push({ dur: rng.range(0.06, 0.12), kind: 'f', F: vowel(), amp: amp * 0.5, f0m, noiseF: rng.pick([2600, 3800, 5200, 6400]) * sp.scale });
          else if (c === 'n') segs.push({ dur: rng.range(0.05, 0.08), kind: 'v', F: [260, 1150, 2300].map((f) => f * sp.scale), amp: amp * 0.35, f0m });
          else segs.push({ dur: rng.range(0.04, 0.07), kind: 'v', F: [360, 1250, 2650].map((f) => f * sp.scale), amp: amp * 0.6, f0m });
        }
        const vd = (style === 'laugh' ? rng.range(0.09, 0.13) : rng.range(0.07, 0.19)) * (5 / sp.rate);
        segs.push({ dur: vd, kind: 'v', F: vowel(), amp, f0m });
        t += vd + 0.06; pt += vd + 0.06;
      }
      if (rng.chance(0.25)) { const g = rng.range(0.02, 0.09); segs.push({ dur: g, kind: 'p', F: null, amp: 0, f0m: 1 }); t += g; pt += g; }
    }
    // phrase-final fall (or rise for a question) then a breath pause
    const last = segs[segs.length - 1];
    if (last) last.f0m *= rng.chance(0.25) ? 1.15 : 0.85;
    const pause = style === 'laugh' ? rng.range(0.05, 0.12) : rng.range(0.25, 0.9);
    segs.push({ dur: pause, kind: 'p', F: null, amp: 0, f0m: 1 });
    t += pause;
  }
  return segs;
}

/** Render an utterance into a new mono Float32Array (sr). */
export function renderUtterance(rng, sr, sp, seconds, style = 'talk') {
  const segs = planUtterance(rng, sp, seconds, style);
  const total = segs.reduce((a, s) => a + s.dur, 0);
  const n = Math.ceil((total + 0.15) * sr);
  const out = new Float32Array(n);
  const nz = noiseGen(rng);
  const R = [new Resonator(sr), new Resonator(sr), new Resonator(sr)];
  const BW = [80, 110, 170];
  const fr = new Resonator(sr), frHp = new Biquad(sr, 'highpass', 1700, 0.7), frHp2 = new Biquad(sr, 'highpass', 1700, 0.7);
  const tilt = new OnePole(sr, 900), dcb = new Biquad(sr, 'highpass', 70, 0.7);
  const env = new OnePole(sr, 28), nenv = new OnePole(sr, 45), fsm = new OnePole(sr, 7);
  const F = [500 * sp.scale, 1500 * sp.scale, 2500 * sp.scale];
  const fTarget = F.slice();
  let ph = 0, f0 = sp.f0, jitter = 1;
  let i = 0;
  const BLOCK = 32;
  for (const sg of segs) {
    const m = Math.floor(sg.dur * sr);
    if (sg.F) for (let k = 0; k < 3; k++) fTarget[k] = sg.F[k];
    const vAmp = sg.kind === 'v' ? sg.amp : sg.kind === 'h' ? sg.amp * 0.25 : sg.kind === 'f' ? sg.amp * 0.08 : 0;
    const nAmp = sg.kind === 'f' ? sg.amp * 0.5 : sg.kind === 'h' ? sg.amp * 0.6 : 0;
    if (sg.kind === 'f' || sg.kind === 'h') fr.set(sg.noiseF, sg.kind === 'h' ? 1800 : 1400);
    const burstAt = sg.kind === 's' ? m - Math.floor(0.012 * sr) : -1;
    if (sg.kind === 's') fr.set(sg.noiseF, 2000);
    for (let j = 0; j < m && i < n; j++, i++) {
      if ((j & (BLOCK - 1)) === 0) {
        // coarticulation: formants glide towards the target (~25 ms)
        for (let k = 0; k < 3; k++) { F[k] += (fTarget[k] - F[k]) * 0.07; R[k].set(F[k], BW[k]); }
        jitter = 1 + (nz() * 0.012);
      }
      f0 = fsm.run(sp.f0 * sg.f0m) * jitter;
      ph += f0 / sr;
      let pulse = 0;
      if (ph >= 1) { ph -= 1; pulse = 1; }
      // glottal excitation ~ impulse train with spectral tilt, DC removed
      const glot = dcb.run(tilt.run(pulse * 4));
      const e = env.run(vAmp);
      const ne = nenv.run(nAmp);
      const asp = nz() * sp.breath * e;
      const y = R[2].run(R[1].run(R[0].run(glot * e + asp)));
      // frication and stop bursts: band-limited noise, well below the vowels
      let nx = ne > 1e-4 ? nz() * ne * 0.045 : 0;
      if (sg.kind === 's' && j >= burstAt) nx += nz() * sg.amp * Math.exp(-(j - burstAt) / (0.004 * sr)) * 0.06;
      const x = frHp2.run(frHp.run(fr.run(nx)));
      out[i] = y + x;
    }
  }
  return out;
}

/**
 * Crowd murmur bed: `voices` people talking at 4-30 m, stereo, seamless loop.
 * Async (yields between voices) because it is the heaviest asset.
 */
export async function babbleBed(sr, seconds, seed, voices = 10) {
  const rng = arng('babble', seed);
  const n = Math.floor(seconds * sr), fade = Math.floor(0.6 * sr);
  const L = new Float32Array(n + fade), Rr = new Float32Array(n + fade);
  for (let v = 0; v < voices; v++) {
    const sp = makeSpeaker(rng);
    const dist = 6 + Math.pow(rng.next(), 0.7) * 28;
    const pan = rng.range(-1, 1);
    const g = 6 / dist;
    // air absorption and bodies in the way: darker with distance
    const lpL = new Biquad(sr, 'lowpass', clamp(9000 * Math.pow(4 / dist, 0.55), 1800, 9000), 0.7);
    const lpR = new Biquad(sr, 'lowpass', clamp(9000 * Math.pow(4 / dist, 0.55), 1800, 9000), 0.7);
    const gl = g * Math.cos((pan + 1) * Math.PI / 4), gr = g * Math.sin((pan + 1) * Math.PI / 4);
    // conversation turns: talk for a while, listen for a while
    let t = rng.range(0, 2.5);
    while (t < (n + fade) / sr) {
      const len = rng.range(1.2, 4.5);
      const u = renderUtterance(rng, sr, sp, len);
      const i0 = Math.floor(t * sr);
      for (let i = 0; i < u.length && i0 + i < L.length; i++) {
        L[i0 + i] += lpL.run(u[i]) * gl;
        Rr[i0 + i] += lpR.run(u[i]) * gr;
      }
      t += u.length / sr + rng.range(0.6, 3.5);
    }
    await yieldTask();
  }
  // the far crowd: many more voices than we model, heard as a speech-shaped hubbub
  // with a gentle syllabic flutter
  normalizeRms([L, Rr], 0.1);
  const nz = noiseGen(rng);
  const hub = [[new Biquad(sr, 'bandpass', 520, 0.6), new Biquad(sr, 'highshelf', 1400, 0.7, -6)], [new Biquad(sr, 'bandpass', 520, 0.6), new Biquad(sr, 'highshelf', 1400, 0.7, -6)]];
  const syl = new SlowNoise(sr, 4.5, nz), drift = new SlowNoise(sr, 0.15, nz);
  for (let i = 0; i < L.length; i++) {
    const m = 0.07 * Math.max(0.2, 1 + 0.35 * syl.run() + 0.25 * drift.run());
    L[i] += hub[0][1].run(hub[0][0].run(nz())) * m;
    Rr[i] += hub[1][1].run(hub[1][0].run(nz())) * m;
  }
  // individual nearby voices must not poke out of the bed
  compress([L, Rr], sr, { threshold: 0.2, ratio: 4, attack: 0.004, release: 0.15 });
  const chans = [makeLoop(L, n, fade), makeLoop(Rr, n, fade)];
  normalizeRms(chans, 0.12);
  limit(chans, sr, 0.12 * 3.2);
  normalizeRms(chans, 0.12);
  return chans;
}

/** Distant vocal one-shots: 'laugh', 'call' (short shout) or 'phrase' (a few words). */
export function voiceShot(sr, kind, k) {
  const rng = arng('vshot', kind, k);
  let out;
  if (kind === 'laugh') {
    const sp = makeSpeaker(rng);
    sp.breath += 0.12; sp.f0 *= 1.15;
    out = renderUtterance(rng, sr, sp, rng.range(0.7, 1.2), 'laugh');
  } else if (kind === 'call') {
    const sp = makeSpeaker(rng, { child: rng.chance(0.3) });
    sp.f0 *= 1.35; sp.range = 0.4; sp.rate = 3.2;
    out = renderUtterance(rng, sr, sp, rng.range(0.35, 0.7));
  } else {
    const sp = makeSpeaker(rng);
    out = renderUtterance(rng, sr, sp, rng.range(1.4, 2.6));
  }
  const lp = new Biquad(sr, 'lowpass', 7000, 0.7);
  lp.process(out);
  normalizeRms(out, 0.12);
  limit(out, sr, 0.12 * 4.5); // natural speech crest factor (~13 dB)
  normalize(out, 0.8);
  return out;
}
