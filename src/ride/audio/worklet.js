// AudioWorklet processors used by the live graph (loaded once per context by
// AudioEngine.prepare). They replace looped noise buffers wherever a loop could be
// heard repeating, and synthesize the traction inverter as real PWM.
//   tram-noise  N channels of independent white noise, unit RMS, never repeating
//   tram-drift  one channel of smooth random modulation (cubic-interpolated random
//               points at `rate` Hz), roughly unit RMS
//   tram-pwm    sine-triangle PWM inverter leg (asynchronous carrier, or a synchronous
//               carrier phase-locked to the stator frequency). Output is the leg's
//               current ripple (switching voltage minus its average, integrated by the
//               winding inductance), which is what makes the magnetostrictive whine:
//               the carrier and its sideband clusters fc±2fe, fc±4fe, 2fc±fe, 2fc±3fe,
//               3fc, 3fc±2fe ... with their natural roll-off; the sidebands grow with
//               the modulation index (speed).

function seedState(seed) {
  let h = (seed * 2654435761) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return h | 1;
}

class NoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.n = Math.max(1, o.channels | 0 || 1);
    this.s = new Int32Array(this.n);
    for (let c = 0; c < this.n; c++) this.s[c] = seedState((o.seed | 0) * 131 + c + 1);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    for (let c = 0; c < out.length; c++) {
      const ch = out[c];
      let x = this.s[c % this.n];
      for (let i = 0; i < ch.length; i++) {
        x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
        ch[i] = ((x >>> 0) / 2147483648 - 1) * 1.7320508; // uniform, unit RMS
      }
      this.s[c % this.n] = x;
    }
    return true;
  }
}

class DriftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'rate', defaultValue: 2, minValue: 0.01, maxValue: 400, automationRate: 'k-rate' }];
  }

  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.x = seedState((o.seed | 0) + 7919);
    this.p = [this._g(), this._g(), this._g(), this._g()];
    this.ph = 0;
  }

  /** Approximately Gaussian random point (sum of three uniforms), unit variance. */
  _g() {
    let s = 0;
    for (let k = 0; k < 3; k++) {
      let x = this.x;
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      this.x = x;
      s += (x >>> 0) / 4294967296 - 0.5;
    }
    return s * 2;
  }

  process(inputs, outputs, params) {
    const ch = outputs[0][0];
    if (!ch) return true;
    const step = params.rate[0] / sampleRate;
    const p = this.p;
    for (let i = 0; i < ch.length; i++) {
      this.ph += step;
      if (this.ph >= 1) { this.ph -= 1; p[0] = p[1]; p[1] = p[2]; p[2] = p[3]; p[3] = this._g(); }
      const t = this.ph, t2 = t * t, t3 = t2 * t;
      // Catmull-Rom between p1 and p2 (the interpolation loses ~25 % of the variance; 1.15 restores it)
      ch[i] = 1.15 * 0.5 * (2 * p[1] + (p[2] - p[0]) * t + (2 * p[0] - 5 * p[1] + 4 * p[2] - p[3]) * t2 + (3 * p[1] - p[0] - 3 * p[2] + p[3]) * t3);
    }
    return true;
  }
}

const SIN_N = 4096;
const SIN = new Float32Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN[i] = Math.sin((2 * Math.PI * i) / SIN_N);
function sinT(ph) { // ph in [0, 1)
  const x = ph * SIN_N, i = x | 0, f = x - i;
  return SIN[i] + (SIN[i + 1] - SIN[i]) * f;
}

class PwmProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'fe', defaultValue: 0, minValue: 0, maxValue: 500, automationRate: 'k-rate' },      // stator frequency
      { name: 'fc', defaultValue: 740, minValue: 20, maxValue: 12000, automationRate: 'k-rate' }, // asynchronous carrier
      { name: 'pulses', defaultValue: 0, minValue: 0, maxValue: 99, automationRate: 'k-rate' },   // > 0: synchronous mode
      { name: 'm', defaultValue: 0.1, minValue: 0, maxValue: 1.15, automationRate: 'k-rate' },    // modulation index
    ];
  }

  constructor() {
    super();
    this.pe = 0;   // stator (reference) phase, cycles
    this.pc = 0;   // carrier phase, cycles
    this.i = 0;    // ripple current (integrated ripple voltage)
    this.os = 4;   // oversampling of the switching comparator
  }

  process(inputs, outputs, params) {
    const ch = outputs[0][0];
    if (!ch) return true;
    const os = this.os, dt = 1 / (sampleRate * os);
    const fe = params.fe[0], N = Math.round(params.pulses[0]), m = params.m[0];
    const fc = N > 0 ? N * fe : params.fc[0];
    // ripple current ~ 1/fc (inductive motor); 1000/fc normalises it at a 1 kHz carrier
    const k = 4000 * dt;
    const leak = 1 - 2 * Math.PI * 25 * dt; // 25 Hz leak: no DC drift
    let pe = this.pe, pc = this.pc, cur = this.i;
    for (let n = 0; n < ch.length; n++) {
      let acc = 0;
      for (let j = 0; j < os; j++) {
        pe += fe * dt; if (pe >= 1) pe -= 1;
        if (N > 0) { pc = pe * N; pc -= Math.floor(pc); } else { pc += fc * dt; if (pc >= 1) pc -= 1; }
        const tri = pc < 0.5 ? 4 * pc - 1 : 3 - 4 * pc;
        const ra = m * sinT(pe);
        cur = (cur + ((ra > tri ? 1 : -1) - ra) * k) * leak; // the reference is the PWM average
        acc += cur;
      }
      ch[n] = acc / os;
    }
    this.pe = pe; this.pc = pc; this.i = cur;
    return true;
  }
}

registerProcessor('tram-noise', NoiseProcessor);
registerProcessor('tram-drift', DriftProcessor);
registerProcessor('tram-pwm', PwmProcessor);
