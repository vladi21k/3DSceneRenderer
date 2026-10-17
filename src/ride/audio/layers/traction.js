// Traction and auxiliaries.
//  - Inverter (VVVF) whine under power or electric braking, synthesized as real
//    three-phase PWM (worklet 'tram-pwm'): asynchronous carrier in fixed steps at low
//    speed, then synchronous modes whose carrier is a multiple of the motor frequency
//    (pitch rises with speed, then drops a step when the pulse number changes). The
//    motor current ripple carries the whole sideband family (fc±2fe, fc±4fe, 2fc±fe,
//    2fc±3fe, 3fc±2fe ...), shaped by motor / frame resonances, plus a little switching
//    hash. Fades out when coasting. (Fallback without worklets: sideband oscillators.)
//  - Motor magnetic noise (harmonics of the stator frequency) and gear mesh whine.
//  - Auxiliaries, always running: HVAC / cooling fans with blade tone, the static
//    converter's faint whistle and hum, and the compressor cycling while stopped.
import { noise1 } from '../../../core/rng.js';
import { glide, clamp, smoothstep, periodicWave } from '../dsp.js';

const FE_PER_MS = 6.0;     // stator frequency (Hz) per m/s: 660 mm wheels, 6.2:1 gearing, 4 poles
const GEAR_TEETH = 19;     // pinion teeth -> mesh frequency = teeth x motor rev/s
const VMAX = 13.9;

// asynchronous steps: [fe from, fe to, carrier Hz]
const ASYNC = [[0, 7.5, 740], [7.5, 14, 830], [14, 21, 990], [21, 29, 1110]];
// synchronous modes: [fe from, fe to, pulses per period]
const SYNC = [[29, 41, 33], [41, 55, 21], [55, 70, 15], [70, 1e9, 9]];

function carrier(fe) {
  for (let i = 0; i < ASYNC.length; i++) if (fe < ASYNC[i][1]) return [i, ASYNC[i][2]];
  for (let i = 0; i < SYNC.length; i++) if (fe < SYNC[i][1]) return [ASYNC.length + i, SYNC[i][2] * fe];
  return [9, 9 * fe];
}

export class TractionLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    const bus = e.bus.traction;

    // ---- inverter: PWM ripple -> motor / frame resonances -> band limits
    this.invOut = new GainNode(ctx, { gain: 0 });
    const res = [[780, 2.2, 5], [1850, 3, 4], [3500, 2, 3]].map(([f, Q, g]) => new BiquadFilterNode(ctx, { type: 'peaking', frequency: f, Q, gain: g }));
    this.invHp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 200, Q: 0.7 });
    this.invLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000, Q: 0.6 });
    this.invOut.connect(res[0]).connect(res[1]).connect(res[2]).connect(this.invHp).connect(this.invLp).connect(bus);
    this.osc = [];
    if (e.worklet) {
      this.pwm = new AudioWorkletNode(ctx, 'tram-pwm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      this.pwmLevel = new GainNode(ctx, { gain: 0.7 });
      this.pwm.connect(this.pwmLevel).connect(this.invOut);
      this.P = { fe: this.pwm.parameters.get('fe'), fc: this.pwm.parameters.get('fc'), N: this.pwm.parameters.get('pulses'), m: this.pwm.parameters.get('m') };
    } else {
      // carrier sideband family as plain oscillators: [carrier multiple, fe multiple, weight]
      this.sidebands = [[1, 0, 0.25], [1, -2, 1], [1, 2, 1], [1, -4, 0.5], [1, 4, 0.5], [2, -1, 0.3], [2, 1, 0.3], [2, -3, 0.3], [2, 3, 0.3], [3, -2, 0.15], [3, 2, 0.15]];
      for (const [, , w] of this.sidebands) {
        const o = new OscillatorNode(ctx, { frequency: 740 });
        const g = new GainNode(ctx, { gain: 0.06 * w });
        o.connect(g).connect(this.invOut);
        this.osc.push(o);
      }
    }
    // switching hash: a narrow noise band at the carrier, ~20 dB down
    this.hashBp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 740, Q: 8 });
    this.hashG = new GainNode(ctx, { gain: 0.012 });
    e.noise().connect(this.hashBp).connect(this.hashG).connect(this.invOut);

    // ---- motor magnetic noise and gear whine
    this.mag = new OscillatorNode(ctx, { frequency: 1 });
    this.mag.setPeriodicWave(periodicWave(ctx, [0, 0.25, 0, 0.15, 0, 0.5, 0, 0, 0, 0, 0, 0.35, 0, 0, 0, 0, 0, 0.12, 0, 0, 0, 0, 0, 0.06]));
    this.magG = new GainNode(ctx, { gain: 0 });
    this.gear = new OscillatorNode(ctx, { frequency: 1 });
    this.gear.setPeriodicWave(periodicWave(ctx, [1, 0.32, 0.1]));
    this.gearG = new GainNode(ctx, { gain: 0 });
    this.mechLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 3200, Q: 0.6 });
    this.mag.connect(this.magG).connect(this.mechLp);
    this.gear.connect(this.gearG).connect(this.mechLp);
    this.mechLp.connect(bus);
    for (const o of [this.mag, this.gear, ...this.osc]) o.start();

    // ---- auxiliaries
    const aux = e.bus.aux;
    // HVAC / cooling fans, live: broadband blower noise with a slow wobble and the
    // blade-pass hum (both shift with the fan speed)
    this.fanG = new GainNode(ctx, { gain: 0 });
    this.fanLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2800, Q: 0.5 });
    this.fanG.connect(this.fanLp).connect(aux);
    this.fanBp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 560, Q: 0.45 });
    const fanLp2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2600, Q: 0.6 });
    const wob = new GainNode(ctx, { gain: 0.9 }), wobD = new GainNode(ctx, { gain: 0.07 });
    e.drift(0.6).connect(wobD).connect(wob.gain);
    e.noise().connect(this.fanBp).connect(fanLp2).connect(wob).connect(this.fanG);
    this.fanHum = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 186, Q: 31 });
    const humG = new GainNode(ctx, { gain: 3 });
    e.noise().connect(this.fanHum).connect(humG).connect(this.fanG);
    this.conv = new OscillatorNode(ctx, { frequency: 4270 });
    this.convG = new GainNode(ctx, { gain: 0.00035 });
    this.hum = new OscillatorNode(ctx, { frequency: 100 });
    this.hum.setPeriodicWave(periodicWave(ctx, [1, 0.5, 0.3, 0.1]));
    this.humG = new GainNode(ctx, { gain: 0.006 });
    this.conv.connect(this.convG).connect(aux);
    this.hum.connect(this.humG).connect(aux);
    this.conv.start(); this.hum.start();
    this.compG = new GainNode(ctx, { gain: 0 });
    this.compLp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 1800, Q: 0.6 });
    this.compG.connect(this.compLp).connect(aux);
    this.comp = null;
    this.compOn = false;

    this.effort = 0;
    this.mode = -1;
    this.invOn = true;
    this.pwmMode = -1;
    this.stillT = 0;
  }

  update(dt, st, now) {
    const e = this.e;
    const v = st.speed, fe = FE_PER_MS * v;
    // tractive / electric-braking effort, smoothed (fast up, slower down)
    let target = Math.abs(st.throttle);
    if (st.throttle < 0) target *= smoothstep(0.8, 2.2, v); // friction brakes take over at the end
    if (v < 0.05 && st.throttle <= 0) target = 0;
    const k = target > this.effort ? 1 - Math.exp(-dt / 0.12) : 1 - Math.exp(-dt / 0.4);
    this.effort += (target - this.effort) * (dt > 0 ? k : 0);
    const eff = this.effort;

    // ---- inverter
    const [mode, fc] = carrier(fe);
    const step = mode !== this.mode;
    this.mode = mode;
    const sync = mode >= ASYNC.length ? SYNC[mode - ASYNC.length][2] : 0;
    const load = 0.55 + 0.45 * clamp(Math.abs(st.accel) / 1.2, 0, 1);
    const inv = 0.05 * eff * load * (0.65 + 0.35 * smoothstep(0, 5, v));
    if (inv > 1e-4 || this.invOn) {
      this.invOn = inv > 1e-4;
      if (this.P) {
        // constant V/f up to base speed: the modulation index follows the stator frequency
        glide(this.P.fe, fe, now, 0.03);
        glide(this.P.m, clamp(0.06 + fe / 62, 0.06, 1.0), now, 0.05);
        if (this.pwmMode !== mode) {
          // a mode change is an instant jump of the carrier (the characteristic pitch step)
          this.pwmMode = mode;
          this.P.N.cancelScheduledValues(now); this.P.N.setValueAtTime(sync, now); this.P.N.__last = sync;
          if (!sync) { this.P.fc.cancelScheduledValues(now); this.P.fc.setValueAtTime(fc, now); this.P.fc.__last = fc; }
        }
      } else {
        const tc = step ? 0.006 : 0.03;
        this.sidebands.forEach(([cm, em], i) => glide(this.osc[i].frequency, Math.max(20, cm * fc + em * fe), now, tc));
      }
      glide(this.hashBp.frequency, fc, now, step ? 0.006 : 0.03);
    }
    glide(this.invOut.gain, inv, now, 0.05, 1e-3);

    // ---- motor + gears
    glide(this.mag.frequency, Math.max(0.5, fe * 1.02), now, 0.03);
    glide(this.magG.gain, 0.01 * eff * smoothstep(0.5, 12, fe), now, 0.06, 1e-3);
    const fg = GEAR_TEETH * (fe / 2);
    glide(this.gear.frequency, Math.max(1, fg), now, 0.03);
    glide(this.gearG.gain, 0.022 * Math.pow(clamp(v / VMAX, 0, 1.2), 1.2) * (0.4 + 0.6 * eff) * smoothstep(0.2, 1.5, v), now, 0.08, 1e-3);

    // ---- auxiliaries
    // HVAC switches between two fan speeds every minute or so
    const fanSpeed = noise1(st.t / 70, 31) > 0.1 ? 1 : 0.72;
    glide(this.fanG.gain, 0.05 * fanSpeed, now, 1.5, 1e-3);
    glide(this.fanBp.frequency, 560 * (0.9 + 0.1 * fanSpeed), now, 1.5);
    glide(this.fanHum.frequency, 186 * (0.9 + 0.1 * fanSpeed), now, 1.5);

    // compressor: cuts in for ~15 s at a time while the tram stands
    this.stillT = v < 0.05 ? this.stillT + dt : 0;
    const cycle = (st.t + 23) % 64;
    const want = this.stillT > 2.5 && cycle < 16;
    if (want && !this.comp) this.comp = e.loop('compressor', this.compG, { offset: 0, rate: 0.6, fadeIn: 0.05 });
    if (this.comp && want !== this.compOn) {
      this.compOn = want;
      this.comp.playbackRate.cancelScheduledValues(now);
      this.comp.playbackRate.setTargetAtTime(want ? 1 : 0.6, now, want ? 0.35 : 0.5);
      this.compG.gain.cancelScheduledValues(now);
      this.compG.gain.setTargetAtTime(want ? 0.05 : 0, now, want ? 0.25 : 0.4);
    }
  }

  dispose() { for (const o of [this.mag, this.gear, this.conv, this.hum, ...this.osc]) o.stop(); }
}
