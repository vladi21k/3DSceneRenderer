// Seamless stereo noise loops (white / pink / brown) used as raw material by live
// filters (squeal roughness, flange hiss, leaves, wind).
import { arng, noiseGen, makeLoop, normalizeRms } from '../dsp.js';

export function noiseLoop(sr, color = 'white', seconds = 4) {
  const n = Math.floor(seconds * sr), fade = Math.floor(0.2 * sr);
  const chans = [];
  for (let ch = 0; ch < 2; ch++) {
    const nz = noiseGen(arng('noise', color, ch));
    const x = new Float32Array(n + fade);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
    for (let i = 0; i < x.length; i++) {
      const w = nz();
      if (color === 'pink') { // Paul Kellet's refined pinking filter
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
      } else if (color === 'brown') {
        br = (br + 0.02 * w) / 1.02; x[i] = br;
      } else x[i] = w;
    }
    chans.push(makeLoop(x, n, fade));
  }
  normalizeRms(chans, 0.25);
  return chans;
}
