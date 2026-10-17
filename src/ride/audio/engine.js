// The live audio graph. It runs against any BaseAudioContext, so the same code
// drives the speakers (AudioContext) and the offline test harness
// (OfflineAudioContext, with update() stepped on a virtual clock before rendering).
//
//   layer buses ─┬─────────────────────────────► mix ─► compressor ─► limiter ─► soft clip ─► volume ─► out
//                └─ sends ─► street reverb (convolution) ─┘
import { RNG } from '../../core/rng.js';
import { glide, softClipCurve, clamp } from './dsp.js';
import { trackFeatures } from './track.js';
import { BellLayer } from './layers/bell.js';
import { RollingLayer } from './layers/rolling.js';
import { SquealLayer } from './layers/squeal.js';
import { TractionLayer } from './layers/traction.js';
import { StopLayer } from './layers/stop.js';
import { AmbienceLayer } from './layers/ambience.js';

/** Mixer buses, also the units the test harness reports levels for. */
export const BUSES = ['bell', 'rolling', 'joints', 'squeal', 'traction', 'aux', 'brakes', 'doors', 'ambience'];

const REVERB_SEND = { bell: 0.32, joints: 0.03, brakes: 0.04, doors: 0.08, ambience: 0.15 };

export class AudioEngine {
  /**
   * @param ctx    BaseAudioContext
   * @param bank   Bank (buffers may still be arriving)
   * @param world  {route, layout, features?}
   * @param opts   {solo: bus name, raw: skip dynamics, seed}
   */
  constructor(ctx, bank, world, opts = {}) {
    this.ctx = ctx;
    this.bank = bank;
    this.route = world.route;
    this.layout = world.layout;
    this.features = world.features || trackFeatures(world.route, world.layout);
    this.opts = opts;
    this.rng = RNG.from('audio-engine', opts.seed ?? 1);
    this.doorsOpen = false;
    this._v = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };

    // ---- master chain. Dynamics come before the volume so turning the volume down
    // doesn't change the mix's character. (The compressor applies its own makeup gain.)
    this.mix = new GainNode(ctx, { gain: 0.7 });
    this.master = new GainNode(ctx, { gain: opts.raw ? 1 : 0 });
    if (opts.raw) {
      this.mix.connect(this.master).connect(ctx.destination);
    } else {
      this.comp = new DynamicsCompressorNode(ctx, { threshold: -24, knee: 10, ratio: 2.5, attack: 0.008, release: 0.3 });
      this.limiter = new DynamicsCompressorNode(ctx, { threshold: -4, knee: 0, ratio: 20, attack: 0.001, release: 0.12 });
      this.clip = new WaveShaperNode(ctx, { curve: softClipCurve(4096, 0.84), oversample: '2x' });
      this.mix.connect(this.comp).connect(this.limiter).connect(this.clip).connect(this.master).connect(ctx.destination);
    }

    // ---- buses (solo mutes everything else, for per-layer measurements)
    this.bus = {};
    for (const name of BUSES) {
      const g = new GainNode(ctx, { gain: opts.solo && opts.solo !== name ? 0 : 1 });
      g.connect(this.mix);
      this.bus[name] = g;
    }

    // ---- street reverb
    this.reverbIn = new GainNode(ctx, { gain: 1 });
    this.reverb = new ConvolverNode(ctx, { disableNormalization: true });
    this.reverbTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000, Q: 0.5 });
    this.reverbOut = new GainNode(ctx, { gain: 0.9 });
    this.reverbIn.connect(this.reverb).connect(this.reverbTone).connect(this.reverbOut).connect(this.mix);
    for (const [name, amt] of Object.entries(REVERB_SEND)) this.bus[name].connect(new GainNode(ctx, { gain: amt })).connect(this.reverbIn);

    this.layers = {
      bell: new BellLayer(this),
      rolling: new RollingLayer(this),
      squeal: new SquealLayer(this),
      traction: new TractionLayer(this),
      stop: new StopLayer(this),
      ambience: new AmbienceLayer(this),
    };
  }

  /** Fade the master in (or to a new level) without clicks. */
  setLevel(v, now = this.ctx.currentTime, tc = 0.08) {
    if (this.opts.raw) return;
    glide(this.master.gain, clamp(v, 0, 1.5), now, tc, 0);
  }

  /** Per-frame update. st: see audio.js gatherState(); now: audio-clock time for automation. */
  update(dt, st, now) {
    if (!this.reverb.buffer && this.bank.get('ir')) this.reverb.buffer = this.bank.get('ir');
    for (const k in this.layers) this.layers[k].update(dt, st, now);
    this._listener(st.listener, now);
  }

  /** Discrete events from the app (bell, doors, station-arrive, ...). */
  event(type, data, when) {
    const L = this.layers;
    if (type === 'bell') L.bell.ring(when, data);
    else if (type === 'doors') L.stop.doors(!!data?.open, when);
  }

  // ------------------------------------------------------------------ helpers for layers

  /** World position of a route coordinate (reused object; copy if you keep it). */
  at(s, d, h) { return this.route.toWorld(s, d, h, this._v); }

  /** Start a looping buffer into `dest` once its buffer exists; null until then. */
  loop(name, dest, opts = {}) {
    const buf = this.bank.get(name);
    if (!buf) return null;
    const src = new AudioBufferSourceNode(this.ctx, { buffer: buf, loop: true, playbackRate: opts.rate ?? 1 });
    src.connect(dest);
    const off = (opts.offset ?? this.rng.next()) * buf.duration;
    src.start(opts.when ?? this.ctx.currentTime, off);
    return src;
  }

  /** Fire-and-forget buffer playback. Returns the source (or null). */
  shot(buf, dest, when, gain = 1, rate = 1) {
    if (typeof buf === 'string') buf = this.bank.get(buf);
    if (!buf) return null;
    const ctx = this.ctx;
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
    const g = new GainNode(ctx, { gain });
    src.connect(g).connect(dest);
    src.start(Math.max(when, ctx.currentTime));
    src.onended = () => { try { g.disconnect(); } catch { /* already gone */ } };
    return src;
  }

  /** Panner for a point source in world space (HRTF unless model = 'equalpower'). */
  panner(ref = 2, rolloff = 1, model = 'HRTF') {
    return new PannerNode(this.ctx, {
      panningModel: model, distanceModel: 'inverse', refDistance: ref, rolloffFactor: rolloff,
      maxDistance: 10000, coneInnerAngle: 360, coneOuterAngle: 360,
    });
  }

  setPos(p, x, y, z, now, tc = 0.03) {
    if (p.positionX) {
      posGlide(p.positionX, x, now, tc); posGlide(p.positionY, y, now, tc); posGlide(p.positionZ, z, now, tc);
    } else p.setPosition(x, y, z);
  }

  _listener(L, now) {
    if (!L) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      posGlide(l.positionX, L.px, now, 0.02); posGlide(l.positionY, L.py, now, 0.02); posGlide(l.positionZ, L.pz, now, 0.02);
      posGlide(l.forwardX, L.fx, now, 0.02, 1e-3); posGlide(l.forwardY, L.fy, now, 0.02, 1e-3); posGlide(l.forwardZ, L.fz, now, 0.02, 1e-3);
      posGlide(l.upX, L.ux, now, 0.02, 1e-3); posGlide(l.upY, L.uy, now, 0.02, 1e-3); posGlide(l.upZ, L.uz, now, 0.02, 1e-3);
    } else {
      l.setPosition(L.px, L.py, L.pz);
      l.setOrientation(L.fx, L.fy, L.fz, L.ux, L.uy, L.uz);
    }
  }

  /** Stop everything and release the nodes. */
  dispose() {
    for (const k in this.layers) this.layers[k].dispose?.();
    try { this.master.disconnect(); } catch { /* ignore */ }
  }
}

/** Glide with an absolute threshold (positions in metres, unit vectors). */
function posGlide(param, v, now, tc, eps = 0.005) {
  if (!Number.isFinite(v)) return;
  const last = param.__last;
  if (tc > 0 && last !== undefined && Math.abs(last - v) <= eps) return;
  param.__last = v;
  // the first value, a jump (teleport) or tc = 0 (a new emitter) is set directly, never swept
  if (tc <= 0 || last === undefined || Math.abs(last - v) > 50) param.setValueAtTime(v, now);
  else param.setTargetAtTime(v, now, tc);
}
