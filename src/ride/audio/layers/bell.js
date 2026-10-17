// Tram gong "ding-ding": two hammer strikes on the dome under the cab front,
// spatialised (HRTF) at the front of the tram, with a send into the street reverb.
import { TRACK_OFFSET } from '../../../core/config.js';

export class BellLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    this.panner = e.panner(2.5, 1);
    // heard from outside through the open cab window: a little top end lost
    this.tone = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 5000, gain: -3 });
    this.gain = new GainNode(ctx, { gain: 0.85 });
    this.panner.connect(this.tone).connect(this.gain).connect(e.bus.bell);
    this.count = 0;
    this.lastEnd = -10;
  }

  ring(when) {
    const strikes = this.e.bank.variants('bell');
    if (!strikes.length) return;
    const rng = this.e.rng;
    // a ring requested while one is still sounding continues the pattern instead of doubling it
    const t0 = Math.max(when, this.lastEnd);
    const gap = 0.2 + rng.range(-0.012, 0.012);
    for (let i = 0; i < 2; i++) {
      const buf = strikes[(this.count++) % strikes.length];
      const g = i === 0 ? 1 : 0.84 + rng.range(-0.05, 0.05);
      this.e.shot(buf, this.panner, t0 + i * gap, g, 1 + rng.range(-0.002, 0.002));
    }
    this.lastEnd = t0 + gap + 0.18;
  }

  update(dt, st, now) {
    // gong position: centre of the cab front, bumper height
    const p = this.e.at(st.s + 1.6, TRACK_OFFSET, 1.1);
    this.e.setPos(this.panner, p.x, p.y, p.z, now);
  }
}
