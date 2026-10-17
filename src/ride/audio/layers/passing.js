// The other units of the line (app.trams): wheel / rail roar, rumble and the traction
// gear whine of an oncoming tram, heard from outside through the cab shell. One HRTF
// source per unit rides the point of its body nearest the listener (a 32 m tram passing
// at 3 m is a line source: the sound swells while the nose closes in, holds alongside
// and fades behind), with the gear whine Doppler shifted by the closing speed. Its bell
// strikes from its nose. Units further than ~320 m are silent.
import { glide, clamp, smoothstep } from '../dsp.js';
import { TRACK_OFFSET } from '../../../core/config.js';

const C = 343;             // speed of sound, m/s
const RANGE = 320;         // m beyond which a unit is silent
const GEAR_HZ = 52;        // gear mesh whine per m/s

export class PassingLayer {
  constructor(e) {
    this.e = e;
    this.units = [];
  }

  _voice() {
    const e = this.e, ctx = e.ctx;
    const pan = e.panner(6, 1);
    const out = new GainNode(ctx, { gain: 0 });
    pan.connect(out).connect(e.bus.passing);
    // airborne rolling roar and the duller structure / ground rumble
    const roarBp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 700, Q: 0.6 });
    const roarLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3200, Q: 0.7 });
    const roar = new GainNode(ctx, { gain: 0 });
    e.noise().connect(roarBp).connect(roarLp).connect(roar).connect(pan);
    const rumLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 170, Q: 0.8 });
    const rum = new GainNode(ctx, { gain: 0 });
    e.noise().connect(rumLp).connect(rum).connect(pan);
    // gear / inverter whine (two partials), louder under power
    const gear = new OscillatorNode(ctx, { type: 'triangle', frequency: 400 });
    const gear2 = new OscillatorNode(ctx, { type: 'sine', frequency: 800 });
    const gearG = new GainNode(ctx, { gain: 0 }), gear2G = new GainNode(ctx, { gain: 0.35 });
    gear.connect(gearG).connect(pan);
    gear2.connect(gear2G).connect(gearG);
    gear.start(); gear2.start();
    // idle: saloon ventilation while standing
    const hvacBp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 320, Q: 0.9 });
    const hvac = new GainNode(ctx, { gain: 0 });
    e.noise().connect(hvacBp).connect(hvac).connect(pan);
    // bell at the nose
    const bellPan = e.panner(4, 1);
    bellPan.connect(new GainNode(ctx, { gain: 0.6 })).connect(e.bus.passing);
    return { pan, out, roar, rum, gear, gear2, gearG, hvac, bellPan, at: { x: 0, y: 0, z: 0 }, em: null, active: false };
  }

  update(dt, st, now, tick) {
    const list = st.oncoming;
    if (!tick || !list) return;
    const e = this.e, L = e.listenerLocal;
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      const v = this.units[i] || (this.units[i] = this._voice());
      // nearest point of the body (nose at u.s, trailing towards +s) to the listener, along the track
      const rel = e.route.delta(st.s - 1.7, u.s);       // >0: nose ahead of the cab eye
      const along = clamp(-rel, 0, u.length);           // body point level with the listener
      const p = e.at(u.s + along, -TRACK_OFFSET, 1.0);
      v.at.x = p.x; v.at.y = p.y; v.at.z = p.z;
      const q = e.toLocal(v.at);
      const dist = Math.hypot(q.x - L.x, q.y - L.y, q.z - L.z);
      const on = dist < RANGE && u.active !== false;
      if (on && !v.active) { v.em = e.anchor(v.pan, v.at, now + 1e9); }
      if (!on && v.active && v.em) { v.em.until = now; }
      v.active = on;
      if (!on) { glide(v.out.gain, 0, now, 0.3, 1e-4); continue; }
      v.em.where = v.at;
      // levels: rolling ~ v^1.5, gear under power, ventilation when slow
      const sp = Math.max(0, u.speed || 0), k = Math.pow(sp / 12, 1.5);
      glide(v.out.gain, 2, now, 0.2, 1e-3);
      glide(v.roar.gain, 1.3 * k, now, 0.15, 1e-3);
      glide(v.rum.gain, 1.8 * k, now, 0.15, 1e-3);
      glide(v.hvac.gain, 0.05 * (1 - smoothstep(1, 4, sp)), now, 0.4, 1e-3);
      const pow = clamp((u.accel || 0) / 0.8, 0, 1);
      glide(v.gearG.gain, (0.02 + 0.05 * pow) * smoothstep(0.5, 3, sp), now, 0.2, 1e-3);
      // Doppler on the tonal part: closing speed along the line of sight
      const towards = rel > 0 ? 1 : rel < -u.length ? -1 : 0;
      const vRel = towards * (sp + Math.max(0, st.speed)) * Math.min(1, Math.abs(rel > 0 ? rel : rel + u.length) / 8);
      const f = GEAR_HZ * Math.max(1, sp) * C / (C - clamp(vRel, -60, 60));
      glide(v.gear.frequency, f, now, 0.08, 1e-3);
      glide(v.gear2.frequency, 2 * f, now, 0.08, 1e-3);
      const n = e.toLocal(e.at(u.s, -TRACK_OFFSET, 1.1));              // the bell under its nose
      e.setLocal(v.bellPan, n.x, n.y, n.z);
    }
  }

  /** A unit rang its bell: a strike pair from its nose. */
  ring(when, data) {
    const v = data && this.units[data.unit];
    if (!v || !v.active) return;
    const strikes = this.e.bank.variants('bell');
    if (!strikes.length) return;
    const rng = this.e.rng;
    for (let i = 0; i < 2; i++) {
      this.e.shot(strikes[(i + data.unit) % strikes.length], v.bellPan, when + i * (0.21 + rng.range(-0.01, 0.01)), i ? 0.8 : 1, 0.97 + rng.range(-0.01, 0.01));
    }
  }
}
