// Street ambience heard from the cab: crowd murmur beds on each side (denser by
// cafés and at stops, thinner at night), distant city traffic, leaves in the wind,
// and spatialised one-shots placed in the world around the listener: birds in the
// street trees and on ledges, swifts screaming overhead, passers-by walking along
// the pavement, distant voices and laughs, café tableware, a far-off car horn.
// Everything outside passes through a "cab" filter that opens up when the tram
// stands (driver's window open) and fully when the doors open.
import { RNG, noise1 } from '../../../core/rng.js';
import { glide, clamp, smoothstep } from '../dsp.js';

const POOL = 7;

export class AmbienceLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    this.pre = new GainNode(ctx, { gain: 1 });
    this.cabLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 4000, Q: 0.5 });
    this.cabG = new GainNode(ctx, { gain: 0.6 });
    this.pre.connect(this.cabLp).connect(this.cabG).connect(e.bus.ambience);

    const bed = (pan) => {
      const p = new StereoPannerNode(ctx, { pan });
      const g = new GainNode(ctx, { gain: 0 });
      p.connect(g).connect(this.pre);
      return { p, g, src: null };
    };
    this.bedL = bed(-0.45);
    this.bedR = bed(0.45);
    this.traffic = { g: new GainNode(ctx, { gain: 0 }), src: null };
    this.traffic.g.connect(this.pre);
    this.leaves = { bp: new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 4800, Q: 0.5 }), g: new GainNode(ctx, { gain: 0 }), src: null };
    this.leaves.bp.connect(this.leaves.g).connect(this.pre);
    // air rushing past the open cab window (not behind the cab filter)
    this.wind = { bp: new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 650, Q: 0.6 }), g: new GainNode(ctx, { gain: 0 }), src: null };
    this.wind.bp.connect(this.wind.g).connect(e.bus.ambience);

    this.slots = [];
    for (let i = 0; i < POOL; i++) {
      const g = new GainNode(ctx, { gain: 0 });
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 16000, Q: 0.6 });
      const p = e.panner(3, 1);
      g.connect(lp).connect(p).connect(this.pre);
      this.slots.push({ g, lp, p, until: -1, mover: null });
    }
    this.rng = RNG.from('audio-amb', e.opts.seed ?? 3);
    this.open = 0.5;
    this.densT = -1;
    this.dens = [0.6, 0.6];
    this.cafe = null;
    this.trees = [];
  }

  update(dt, st, now) {
    const e = this.e, v = st.speed;
    if (!this.bedL.src) this.bedL.src = e.loop('babbleA', this.bedL.p);
    if (!this.bedR.src) this.bedR.src = e.loop('babbleB', this.bedR.p);
    if (!this.traffic.src) this.traffic.src = e.loop('traffic', this.traffic.g);
    if (!this.leaves.src) this.leaves.src = e.loop('noiseP', this.leaves.bp);
    if (!this.wind.src) this.wind.src = e.loop('noiseP', this.wind.bp, { rate: 0.93 });

    // ---- how open the cab is to the street
    const target = e.doorsOpen ? 1 : v < 0.3 ? 0.78 : 0.52;
    this.open += (target - this.open) * (1 - Math.exp(-dt / 0.8));
    glide(this.cabLp.frequency, 1500 * Math.pow(2, this.open * 3.3), now, 0.1);
    glide(this.cabG.gain, 0.35 + 0.65 * this.open, now, 0.1, 1e-3);

    // ---- surroundings (cheap queries, twice a second)
    if (st.t - this.densT > 0.5 || st.t < this.densT) { this.densT = st.t; this._survey(st); }
    const day = 1 - clamp(st.night || 0, 0, 1);
    const people = 0.3 + 0.7 * day;
    glide(this.bedL.g.gain, 0.3 * this.dens[0] * people, now, 1.2, 1e-3);
    glide(this.bedR.g.gain, 0.3 * this.dens[1] * people, now, 1.2, 1e-3);
    glide(this.traffic.g.gain, 0.1 * (0.6 + 0.4 * day), now, 1.5, 1e-3);
    const wind = clamp(st.wind ?? 0.35, 0, 1);
    const gust = 0.6 + 0.4 * noise1(st.t * 0.35, 9);
    glide(this.leaves.g.gain, (0.01 + 0.05 * wind * gust) * (this.trees.length ? 1 : 0.4), now, 0.4, 1e-3);
    glide(this.wind.g.gain, 0.05 * Math.pow(clamp(v / 13.9, 0, 1.2), 2) * (0.4 + 0.6 * this.open), now, 0.3, 1e-3);

    // ---- one-shots (Poisson spawns)
    if (dt > 0) {
      const crowd = 0.5 * (this.dens[0] + this.dens[1]) * people;
      const r = this.rng;
      const P = (rate) => r.next() < rate * dt;
      if (P(0.22 * day)) this._bird(st, now);
      if (P(0.035 * day)) this._swift(st, now);
      if (P(0.16 * crowd)) this._walker(st, now);
      if (P(0.06 * crowd)) this._voice(st, now);
      if (this.cafe && P(0.35 * this.cafe.w * people)) this._clink(st, now);
      if (P(1 / 75)) this._horn(st, now);
    }
    for (const sl of this.slots) {
      if (sl.mover && now < sl.until) { const p = sl.mover(now); e.setPos(sl.p, p.x, p.y, p.z, now, 0.05); }
    }
  }

  _survey(st) {
    const { layout, route } = this.e;
    const s = st.s, ci = layout.chunkIndex(s);
    const dens = [0.55, 0.55];
    let cafe = null;
    const trees = [];
    for (let j = -1; j <= 2; j++) {
      for (const c of layout.inChunk('cafes', ci + j)) {
        const dd = Math.max(0, Math.abs(route.delta(s, (c.s0 + c.s1) / 2)) - (c.s1 - c.s0) / 2);
        const w = clamp(1 - dd / 45, 0, 1);
        if (w <= 0) continue;
        dens[c.side > 0 ? 1 : 0] += 0.45 * w;
        if (!cafe || w > cafe.w) cafe = { c, w };
      }
      for (const t of layout.inChunk('trees', ci + j)) trees.push(t);
    }
    if (layout.isInStation(s, 35)) { dens[0] += 0.35; dens[1] += 0.45; }
    if (layout.isInCrossStreet(s, 1, 15) || layout.isInCrossStreet(s, -1, 15)) { dens[0] += 0.1; dens[1] += 0.1; }
    this.dens = dens.map((d) => clamp(d, 0, 1.6));
    this.cafe = cafe;
    this.trees = trees;
  }

  _slot(now, dur) {
    for (const sl of this.slots) if (sl.until < now) { sl.until = now + dur + 0.25; sl.mover = null; return sl; }
    return null;
  }

  /** Prepare a slot for a sound at world point p (distance-dependent air absorption). */
  _place(sl, p, st, now, gain, ref) {
    const L = st.listener;
    const dist = L ? Math.hypot(p.x - L.px, p.y - L.py, p.z - L.pz) : 10;
    sl.lp.frequency.setValueAtTime(clamp(18000 * Math.pow(8 / Math.max(8, dist), 0.6), 2200, 18000), now);
    sl.g.gain.setValueAtTime(gain, now);
    sl.p.refDistance = ref;
    this.e.setPos(sl.p, p.x, p.y, p.z, now, 0);
  }

  _bird(st, now) {
    const e = this.e, r = this.rng;
    const kinds = e.bank.birdKinds;
    if (!kinds) return;
    const pool = kinds.map((k, i) => [i, k]).filter(([, k]) => k !== 'swift');
    const [idx, kind] = r.pick(pool);
    const buf = e.bank.get('bird' + idx);
    const sl = buf && this._slot(now, buf.duration);
    if (!sl) return;
    let p;
    if (kind === 'pigeon' || !this.trees.length) {
      // on a ledge or balcony
      const side = r.chance(0.5) ? 1 : -1;
      p = e.at(st.s + r.range(-15, 50), side * (e.layout.halfWidth(st.s, side) - 0.4), r.range(5, 14));
    } else {
      const t = r.pick(this.trees);
      p = e.at(t.s + r.range(-1, 1), t.d + r.range(-1, 1), (t.height || 6) * r.range(0.55, 0.9));
    }
    this._place(sl, p, st, now, kind === 'pigeon' ? 0.35 : r.range(0.25, 0.5), 3);
    e.shot(buf, sl.g, now + 0.02, 1, 1 + r.range(-0.04, 0.04));
  }

  _swift(st, now) {
    const e = this.e, r = this.rng;
    const kinds = e.bank.birdKinds;
    if (!kinds) return;
    const idx = kinds.indexOf('swift') + r.int(0, 1);
    const buf = e.bank.get('bird' + idx);
    const sl = buf && this._slot(now, buf.duration);
    if (!sl) return;
    // a small party racing along above the street
    const s0 = st.s + r.range(-20, 60), d0 = r.range(-12, 12), h = r.range(16, 30);
    const dir = r.chance(0.5) ? 1 : -1, sp = r.range(10, 17), lat = r.range(-4, 4);
    const t0 = now;
    sl.mover = (t) => e.at(s0 + dir * sp * (t - t0), d0 + lat * (t - t0), h);
    this._place(sl, sl.mover(now), st, now, r.range(0.12, 0.25), 6);
    e.shot(buf, sl.g, now + 0.02, 1, 1 + r.range(-0.05, 0.05));
  }

  _walker(st, now) {
    const e = this.e, r = this.rng;
    const kind = r.int(0, 2);
    const steps = r.int(7, 16);
    const interval = 1 / r.range(1.75, 2.15);
    const sl = this._slot(now, steps * interval + 0.3);
    if (!sl) return;
    const side = r.chance(0.5) ? 1 : -1;
    const d = side * r.range(4.6, 9.5);
    const s0 = st.s + r.range(-8, 22) + st.speed * 1.2;
    const dir = r.chance(0.5) ? 1 : -1, sp = r.range(1.15, 1.5);
    const t0 = now;
    sl.mover = (t) => e.at(s0 + dir * sp * (t - t0), d, 0.05);
    const g = kind === 1 ? r.range(0.25, 0.4) : r.range(0.35, 0.6);
    this._place(sl, sl.mover(now), st, now, g, 2);
    for (let i = 0; i < steps; i++) {
      const buf = e.bank.get('step' + (kind + 3 * r.int(0, 2)));
      if (!buf) return;
      const accent = i % 2 ? 0.85 : 1; // left/right foot differ a little
      e.shot(buf, sl.g, now + 0.05 + i * interval * (1 + r.range(-0.03, 0.03)), accent * r.range(0.8, 1.1), 1 + r.range(-0.05, 0.05));
    }
  }

  _voice(st, now) {
    const e = this.e, r = this.rng;
    const kind = r.weighted([['phrase', 0.5], ['laugh', 0.3], ['call', 0.2]]);
    const vs = e.bank.variants(kind);
    if (!vs.length) return;
    const buf = r.pick(vs);
    const sl = this._slot(now, buf.duration);
    if (!sl) return;
    const side = r.chance(0.5) ? 1 : -1;
    const far = kind === 'call' ? r.range(12, 35) : r.range(5, 16);
    const p = e.at(st.s + r.range(-10, far * 1.5) + st.speed, side * r.range(4.5, 10.5), r.range(1.45, 1.7));
    const g = kind === 'call' ? r.range(0.4, 0.6) : kind === 'laugh' ? r.range(0.25, 0.4) : r.range(0.2, 0.32);
    this._place(sl, p, st, now, g, 4);
    e.shot(buf, sl.g, now + 0.02, 1, 1 + r.range(-0.03, 0.03));
  }

  _clink(st, now) {
    const e = this.e, r = this.rng;
    const tables = this.cafe.c.tables;
    if (!tables || !tables.length) return;
    const vs = e.bank.variants('clink');
    if (!vs.length) return;
    const buf = r.pick(vs);
    const sl = this._slot(now, buf.duration);
    if (!sl) return;
    const tb = r.pick(tables);
    const p = e.at(tb.s + r.range(-0.4, 0.4), tb.d + r.range(-0.4, 0.4), 0.78);
    this._place(sl, p, st, now, r.range(0.12, 0.25), 1.5);
    e.shot(buf, sl.g, now + 0.02, 1, 1 + r.range(-0.02, 0.02));
  }

  _horn(st, now) {
    const e = this.e, r = this.rng;
    const vs = e.bank.variants('horn');
    if (!vs.length) return;
    const buf = r.pick(vs);
    const sl = this._slot(now, buf.duration + 1.5);
    if (!sl) return;
    const side = r.chance(0.5) ? 1 : -1;
    const p = e.at(st.s + r.range(-60, 180), side * r.range(16, 45), 1.0);
    this._place(sl, p, st, now, r.range(0.3, 0.5), 20);
    e.shot(buf, sl.g, now + 0.02, 1);
  }
}
