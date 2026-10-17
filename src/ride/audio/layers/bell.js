// Tram gong "ding-ding": two hammer strikes on the dome under the cab nose,
// spatialised (HRTF) at the front of the tram, heard through the cab front (near
// shell), with a send into the street reverb.
//
// Ringing rules: a ring is a pair of strikes 0.2 s apart; pairs are separated by a
// rest of at least 0.35 s so the "ding-ding" rhythm survives repeated presses. A
// request that arrives while a pair is pending or began less than 0.45 s ago is
// dropped; otherwise it may wait at most 0.15 s for the rest to end. Each new strike
// briefly damps the dome's ring (the hammer touches it).

const PAIR_GAP = 0.2, REST = 0.35, MIN_SPACING = 0.45, MAX_WAIT = 0.15;

export class BellLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    // gong under the cab nose: just ahead of and below the driver
    this.panner = e.vehiclePanner(0, 1.1, -1.6, 2.5);
    this.gain = new GainNode(ctx, { gain: 0.85 });
    this.panner.connect(this.gain).connect(e.bus.bell);
    this.count = 0;
    this.pairStart = -10;  // first strike of the latest pair
    this.pairEnd = -10;    // its second strike
    this.ringing = [];     // strike gain nodes still sounding
  }

  ring(when) {
    const strikes = this.e.bank.variants('bell');
    if (!strikes.length) return;
    if (when < this.pairStart + MIN_SPACING) return;      // pending, or just begun
    const t0 = Math.max(when, this.pairEnd + REST);
    if (t0 - when > MAX_WAIT) return;
    const rng = this.e.rng;
    const gap = PAIR_GAP + rng.range(-0.012, 0.012);
    for (let i = 0; i < 2; i++) {
      const t = t0 + i * gap;
      this._damp(t);
      const buf = strikes[(this.count++) % strikes.length];
      const g = i === 0 ? 1 : 0.84 + rng.range(-0.05, 0.05);
      const src = this.e.shot(buf, this.panner, t, g, 1 + rng.range(-0.002, 0.002));
      if (src) this.ringing.push({ g: src.out, level: g, end: t + buf.duration });
    }
    this.pairStart = t0;
    this.pairEnd = t0 + gap;
  }

  /** The hammer touching the ringing dome takes ~3 dB off what is still sounding. */
  _damp(t) {
    this.ringing = this.ringing.filter((r) => r.end > t);
    for (const r of this.ringing) {
      r.level *= 0.7;
      r.g.gain.setValueAtTime(r.level / 0.7, t);
      r.g.gain.linearRampToValueAtTime(r.level, t + 0.02);
    }
  }

  update() {}
}
