// The live audio graph. It runs against any BaseAudioContext, so the same code
// drives the speakers (AudioContext) and the offline test harness
// (OfflineAudioContext, with update() stepped on a virtual clock before rendering).
//
//   inside buses (rolling, traction, aux, brakes, doors) ─────────────────────────┐
//   doors ─ send ─► cab/saloon reverb (small room) ───────────────────────────────┤
//   bell, squeal, joints ─► near shell (cab body, mild) ──────────────────────────┤
//   ambience ─► far shell (closed cab: -15 dB, dark; window / doors open it up) ──┼─► mix ─► compressor ─► limiter ─► soft clip ─► volume ─► out
//   outside sources ─ sends ─► street reverb (narrow / wide canyon) ─► far shell ─┘
//
// Spatial frame: the listener and all panners live in a tram-local frame (x right,
// y up, z backwards from the cab reference point on the ride track). Sources fixed
// to the tram (bell, doors, squealing wheel) then never move, and only the listener
// orientation and world-anchored emitters (birds, footsteps, voices) are updated, at
// 25 Hz with linear ramps.
import { RNG } from '../../core/rng.js';
import { TRACK_OFFSET } from '../../core/config.js';
import { glide, rampTo, softClipCurve, clamp, lerp } from './dsp.js';
import { trackFeatures } from './track.js';
import { BellLayer } from './layers/bell.js';
import { RollingLayer } from './layers/rolling.js';
import { SquealLayer } from './layers/squeal.js';
import { TractionLayer } from './layers/traction.js';
import { StopLayer } from './layers/stop.js';
import { AmbienceLayer } from './layers/ambience.js';

/** Mixer buses, also the units the test harness reports levels for. */
export const BUSES = ['bell', 'rolling', 'joints', 'squeal', 'traction', 'aux', 'brakes', 'doors', 'ambience'];

// outside sources reflected by the facades (heard through the cab shell)
const STREET_SEND = { bell: 0.3, squeal: 0.05, joints: 0.03, brakes: 0.03, ambience: 0.15 };
// sounds inside the car body: dense small-room reflections (doors, chime, beeps;
// the always-running HVAC is diffuse already and would keep the convolver busy)
const CAB_SEND = { doors: 0.3 };
// exterior buses and the shell they are heard through (wheel / rail impacts: their
// airborne crack; the floor thump passes the near shell's low end unchanged)
const SHELL_OF = { bell: 'near', squeal: 'near', joints: 'near', ambience: 'far' };
const TICK = 1 / 25;

export class AudioEngine {
  /** Load the worklet processors into `ctx` (once). Resolves true when available. */
  static async prepare(ctx) {
    if (ctx.__tramWorklet !== undefined) return ctx.__tramWorklet;
    let ok = false;
    try {
      if (ctx.audioWorklet) {
        await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
        ok = true;
      }
    } catch (e) {
      console.warn('[audio] AudioWorklet unavailable, falling back to buffer noise', e);
    }
    ctx.__tramWorklet = ok;
    return ok;
  }

  /**
   * @param ctx    BaseAudioContext (call AudioEngine.prepare(ctx) first for the worklets)
   * @param bank   Bank (buffers may still be arriving)
   * @param world  {route, layout, features?, crowd?: () => agents[] | null, tod?: () => t}
   * @param opts   {solo: bus name, raw: skip dynamics, seed}
   */
  constructor(ctx, bank, world, opts = {}) {
    this.ctx = ctx;
    this.bank = bank;
    this.route = world.route;
    this.layout = world.layout;
    this.features = world.features || trackFeatures(world.route, world.layout);
    this.crowd = world.crowd || null;
    this.opts = opts;
    this.worklet = ctx.__tramWorklet === true;
    this.rng = RNG.from('audio-engine', opts.seed ?? 1);
    this.doorsOpen = false;
    this.open = 0;          // how open the cab is to the street: 0 closed, 0.5 driver's window, 1 doors
    this.now = 0;
    this._v = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
    this._l = { x: 0, y: 0, z: 0 };
    this.frame = { ox: 0, oy: 0, oz: 0, c: 1, s: 0, v: 0, at: null };
    this.listenerLocal = { x: 0, y: 2.75, z: 0, fx: 0, fy: 0, fz: -1 };
    this.emitters = new Set();
    this._tick = -1;
    this._revT = -1;

    // ---- master chain. Dynamics come before the volume so turning the volume down
    // doesn't change the mix's character. (The compressor applies its own makeup gain.)
    this.mix = new GainNode(ctx, { gain: 0.7 });
    this.master = new GainNode(ctx, { gain: opts.raw ? 1 : 0 });
    if (opts.raw) {
      this.mix.connect(this.master).connect(ctx.destination);
    } else {
      this.comp = new DynamicsCompressorNode(ctx, { threshold: -24, knee: 10, ratio: 2.5, attack: 0.008, release: 0.3 });
      this.limiter = new DynamicsCompressorNode(ctx, { threshold: -4, knee: 0, ratio: 20, attack: 0.001, release: 0.12 });
      this.clip = new WaveShaperNode(ctx, { curve: softClipCurve(4096, 0.84) }); // above the limiter: rarely engaged
      this.mix.connect(this.comp).connect(this.limiter).connect(this.clip).connect(this.master).connect(ctx.destination);
    }

    // ---- the cab shell: what reaches the driver from outside
    const shell = (shelfHz) => {
      const input = new GainNode(ctx, { gain: 1 });
      const hs = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: shelfHz, gain: 0 });
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 16000, Q: 0.5 });
      const g = new GainNode(ctx, { gain: 1 });
      input.connect(hs).connect(lp).connect(g).connect(this.mix);
      return { input, hs, lp, g };
    };
    this.shell = { far: shell(500), near: shell(2000) };

    // ---- buses (solo mutes everything else, for per-layer measurements)
    this.bus = {};
    for (const name of BUSES) {
      const g = new GainNode(ctx, { gain: opts.solo && opts.solo !== name ? 0 : 1 });
      g.connect(SHELL_OF[name] ? this.shell[SHELL_OF[name]].input : this.mix);
      this.bus[name] = g;
    }

    // ---- street reverb: two canyon widths. The local facade spacing picks one (with
    // hysteresis) and the switch crossfades at the convolver inputs, so the idle
    // convolver receives silence and the browser stops processing it.
    this.reverbIn = new GainNode(ctx, { gain: 1 });
    this.revN = new ConvolverNode(ctx, { disableNormalization: true });
    this.revW = new ConvolverNode(ctx, { disableNormalization: true });
    this.revNg = new GainNode(ctx, { gain: 1 });
    this.revWg = new GainNode(ctx, { gain: 0 });
    this.wide = false;
    this.reverbTone = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 7000, Q: 0.5 });
    this.reverbOut = new GainNode(ctx, { gain: 0.9 });
    this.reverbIn.connect(this.revNg).connect(this.revN).connect(this.reverbTone);
    this.reverbIn.connect(this.revWg).connect(this.revW).connect(this.reverbTone);
    this.reverbTone.connect(this.reverbOut).connect(this.shell.far.input);
    for (const [name, amt] of Object.entries(STREET_SEND)) this.bus[name].connect(new GainNode(ctx, { gain: amt })).connect(this.reverbIn);

    // ---- cab / saloon reverb
    this.cabIn = new GainNode(ctx, { gain: 1 });
    this.cabRev = new ConvolverNode(ctx, { disableNormalization: true });
    this.cabOut = new GainNode(ctx, { gain: 0.8 });
    this.cabIn.connect(this.cabRev).connect(this.cabOut).connect(this.mix);
    for (const [name, amt] of Object.entries(CAB_SEND)) this.bus[name].connect(new GainNode(ctx, { gain: amt })).connect(this.cabIn);

    this._noise = null;
    this._noiseUsed = 0;
    this._fbNoise = null;

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

  /** Per-frame update. st: see audio.js _gather(); now: audio-clock time for automation. */
  update(dt, st, now) {
    this.now = now;
    const b = this.bank;
    if (!this.revN.buffer && b.get('irN')) this.revN.buffer = b.get('irN');
    if (!this.revW.buffer && b.get('irW')) this.revW.buffer = b.get('irW');
    if (!this.cabRev.buffer && b.get('irCab')) this.cabRev.buffer = b.get('irCab');
    this._shell(dt, st, now);
    const tick = this._tick < 0 || now - this._tick >= TICK || now < this._tick;
    if (tick) { this._tick = now; this._setFrame(st); }
    for (const k in this.layers) this.layers[k].update(dt, st, now, tick);
    if (tick) { this._listener(st.listener, now); this._emitters(now); this._reverb(st, now); }
  }

  /** Discrete events from the app (bell, doors, ...). */
  event(type, data, when) {
    this.now = Math.max(this.now, when - 0.01);
    const L = this.layers;
    if (type === 'bell') L.bell.ring(when, data);
    else if (type === 'doors') L.stop.doors(!!data?.open, when);
  }

  // ------------------------------------------------------------------ the cab shell

  _shell(dt, st, now) {
    // moving: closed; standing: the driver's window is open; doors open: wide open
    const target = this.doorsOpen ? 1 : st.speed < 0.3 ? 0.5 : 0;
    this.open += (target - this.open) * (dt > 0 ? 1 - Math.exp(-dt / 0.5) : 0);
    const o = this.open;
    const seg = (a, b, c) => (o < 0.5 ? lerp(a, b, o / 0.5) : lerp(b, c, (o - 0.5) / 0.5));
    const db = (x) => Math.pow(10, x / 20);
    const F = this.shell.far, N = this.shell.near;
    glide(F.g.gain, db(seg(-15, -7, 0)), now, 0.1, 2e-3);
    glide(F.lp.frequency, Math.pow(2, seg(Math.log2(1500), Math.log2(6000), Math.log2(16000))), now, 0.1, 2e-3);
    glide(F.hs.gain, seg(-6, -2, 0), now, 0.1, 2e-3);
    glide(N.g.gain, db(seg(-3, -1.5, 0)), now, 0.1, 2e-3);
    glide(N.lp.frequency, Math.pow(2, seg(Math.log2(8000), Math.log2(12000), Math.log2(18000))), now, 0.1, 2e-3);
    glide(N.hs.gain, seg(-6, -2, 0), now, 0.1, 2e-3);
  }

  /** Street reverb: the canyon width in use, fewer reflections where a side opens up. */
  _reverb(st, now) {
    if (st.t - this._revT < 0.5 && st.t >= this._revT) return;
    this._revT = st.t;
    const L = this.layout, s = st.s + 8;
    const W = L.halfWidth(s, 1) + L.halfWidth(s, -1);
    const wide = this.wide ? W > 23.8 : W > 25.2;
    if (wide !== this.wide) {
      this.wide = wide;
      const at = (g, v) => { g.gain.cancelScheduledValues(now); g.gain.setTargetAtTime(v, now, 0.4); g.gain.__last = v; };
      at(this.revNg, wide ? 0 : 1);
      at(this.revWg, wide ? 1 : 0);
    }
    let open = 0;
    if (L.isInCrossStreet(s, 1, 4)) open++;
    if (L.isInCrossStreet(s, -1, 4)) open++;
    glide(this.reverbIn.gain, 1 - 0.22 * open, now, 0.6, 2e-3);
  }

  // ------------------------------------------------------------------ spatial frame

  _setFrame(st) {
    const r = this.route, f = this.frame;
    const o = r.toWorld(st.s, TRACK_OFFSET, 0, this._v);
    const yaw = r.yawAt(st.s);
    f.ox = o.x; f.oy = o.y; f.oz = o.z;
    f.c = Math.cos(yaw); f.s = Math.sin(yaw);
    f.v = st.speed;
  }

  /** World point -> tram-local point (reused object). */
  toLocal(p, out = this._l) {
    const f = this.frame, dx = p.x - f.ox, dz = p.z - f.oz;
    out.x = dx * f.c - dz * f.s;
    out.y = p.y - f.oy;
    out.z = dx * f.s + dz * f.c;
    return out;
  }

  _listener(L, now) {
    if (!L || !Number.isFinite(L.px)) return;
    const f = this.frame, l = this.ctx.listener, Q = this.listenerLocal;
    const p = this.toLocal({ x: L.px, y: L.py, z: L.pz });
    Q.x = p.x; Q.y = p.y; Q.z = p.z;
    Q.fx = L.fx * f.c - L.fz * f.s; Q.fy = L.fy; Q.fz = L.fx * f.s + L.fz * f.c;
    const ux = L.ux * f.c - L.uz * f.s, uy = L.uy, uz = L.ux * f.s + L.uz * f.c;
    const t = now + TICK * 1.25;
    if (l.positionX) {
      rampTo(l.positionX, Q.x, now, t, 5); rampTo(l.positionY, Q.y, now, t, 5); rampTo(l.positionZ, Q.z, now, t, 5);
      rampTo(l.forwardX, Q.fx, now, t); rampTo(l.forwardY, Q.fy, now, t); rampTo(l.forwardZ, Q.fz, now, t);
      rampTo(l.upX, ux, now, t); rampTo(l.upY, uy, now, t); rampTo(l.upZ, uz, now, t);
    } else {
      l.setPosition(Q.x, Q.y, Q.z);
      l.setOrientation(Q.fx, Q.fy, Q.fz, ux, uy, uz);
    }
  }

  /** Listener-relative direction of a world point: {dist, pan (-1 left .. 1 right), front (-1..1)}. */
  relative(p, out = {}) {
    const q = this.toLocal(p), Q = this.listenerLocal;
    const dx = q.x - Q.x, dy = q.y - Q.y, dz = q.z - Q.z;
    const dist = Math.hypot(dx, dy, dz) || 1e-3;
    // right = forward x up(0,1,0) = (-fz, 0, fx)
    const rx = -Q.fz, rz = Q.fx, rn = Math.hypot(rx, rz) || 1;
    out.dist = dist;
    out.pan = clamp((dx * rx + dz * rz) / rn / dist, -1, 1);
    out.front = clamp((dx * Q.fx + dy * Q.fy + dz * Q.fz) / dist, -1, 1);
    return out;
  }

  /** Panner fixed to the tram at local (x, y, z). */
  vehiclePanner(x, y, z, ref = 2, model = 'HRTF') {
    const p = this.panner(ref, 1, model);
    this.setLocal(p, x, y, z);
    return p;
  }

  setLocal(p, x, y, z) {
    if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; } else p.setPosition(x, y, z);
  }

  /**
   * Anchor panner `p` in the world until time `until`: `where` is a world point
   * {x,y,z} or a function (t) -> world point. Positioned now, then updated each tick.
   */
  anchor(p, where, until) {
    const em = p.__em || (p.__em = { p, where: null, until: 0 });
    em.where = where; em.until = until;
    this.emitters.add(em);
    this._place(em, this.now, true);
    return em;
  }

  _place(em, now, jump) {
    const w = typeof em.where === 'function' ? em.where(now) : em.where;
    if (!w) return;
    const q = this.toLocal(w);
    const p = em.p;
    if (!p.positionX) { p.setPosition(q.x, q.y, q.z); return; }
    if (jump) {
      for (const [a, v] of [[p.positionX, q.x], [p.positionY, q.y], [p.positionZ, q.z]]) { a.__last = undefined; rampTo(a, v, now, now); }
      return;
    }
    // aim where the source will be at the end of the ramp (the tram keeps moving)
    const lead = TICK * 1.25, t = now + lead;
    const w2 = typeof em.where === 'function' ? em.where(t) : w;
    const q2 = this.toLocal(w2);
    rampTo(p.positionX, q2.x, now, t, 20);
    rampTo(p.positionY, q2.y, now, t, 20);
    rampTo(p.positionZ, q2.z + this.frame.v * lead, now, t, 20);
  }

  _emitters(now) {
    for (const em of this.emitters) {
      if (em.until < now) { this.emitters.delete(em); continue; }
      this._place(em, now, false);
    }
  }

  // ------------------------------------------------------------------ helpers for layers

  /** World position of a route coordinate (reused object; copy if you keep it). */
  at(s, d, h) { return this.route.toWorld(s, d, h, this._v); }

  /** Start a looping buffer into `dest` (faded in) once its buffer exists; null until then. */
  loop(name, dest, opts = {}) {
    const buf = this.bank.get(name);
    if (!buf) return null;
    const ctx = this.ctx, t = Math.max(this.now, opts.when ?? 0);
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true, playbackRate: opts.rate ?? 1 });
    const fade = new GainNode(ctx, { gain: 0 });
    fade.gain.setValueAtTime(0, t);
    fade.gain.linearRampToValueAtTime(1, t + (opts.fadeIn ?? 2));
    src.connect(fade).connect(dest);
    src.start(t, (opts.offset ?? this.rng.next()) * buf.duration);
    return src;
  }

  /** Fire-and-forget buffer playback. Returns the source (its gain node is src.out) or null. */
  shot(buf, dest, when, gain = 1, rate = 1, offset = 0, dur) {
    if (typeof buf === 'string') buf = this.bank.get(buf);
    if (!buf) return null;
    const ctx = this.ctx;
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, playbackRate: rate });
    const g = new GainNode(ctx, { gain });
    src.connect(g).connect(dest);
    if (dur !== undefined) src.start(Math.max(when, ctx.currentTime), offset, dur);
    else src.start(Math.max(when, ctx.currentTime), offset);
    src.onended = () => { try { g.disconnect(); } catch { /* already gone */ } };
    src.out = g;
    return src;
  }

  /** Panner for a point source (HRTF unless model = 'equalpower'). */
  panner(ref = 2, rolloff = 1, model = 'HRTF') {
    return new PannerNode(this.ctx, {
      panningModel: model, distanceModel: 'inverse', refDistance: ref, rolloffFactor: rolloff,
      maxDistance: 10000, coneInnerAngle: 360, coneOuterAngle: 360,
    });
  }

  /** An independent, non-repeating white-noise source (unit RMS), as a GainNode output. */
  noise() {
    const ctx = this.ctx;
    const g = new GainNode(ctx, { gain: 1 });
    if (this.worklet) {
      if (!this._noise || this._noiseUsed >= 8) {
        const node = new AudioWorkletNode(ctx, 'tram-noise', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [8],
          processorOptions: { channels: 8, seed: this.rng.int(1, 1e6) },
        });
        this._noise = new ChannelSplitterNode(ctx, { numberOfOutputs: 8 });
        node.connect(this._noise);
        this._noiseUsed = 0;
      }
      this._noise.connect(g, this._noiseUsed++);
    } else {
      const buf = this._fallbackNoise();
      const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true, playbackRate: this.rng.range(0.91, 1.09) });
      src.connect(g);
      src.start(0, this.rng.next() * buf.duration);
    }
    return g;
  }

  /** Smooth random modulation (roughly unit RMS) with `rate` random points per second. */
  drift(rate) {
    const ctx = this.ctx;
    if (this.worklet) {
      return new AudioWorkletNode(ctx, 'tram-drift', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { seed: this.rng.int(1, 1e6) }, parameterData: { rate },
      });
    }
    // fallback: white noise read `rate` samples per second (linear interpolation), smoothed
    const buf = this._fallbackNoise();
    const src = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true, playbackRate: rate / buf.sampleRate });
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: rate * 0.6, Q: 0.5 });
    const g = new GainNode(ctx, { gain: 1.4 });
    src.connect(lp).connect(g);
    src.start(0, this.rng.next() * buf.duration);
    return g;
  }

  _fallbackNoise() {
    if (this._fbNoise) return this._fbNoise;
    const sr = this.ctx.sampleRate, n = 1 << 18;
    const buf = new AudioBuffer({ numberOfChannels: 1, length: n, sampleRate: sr });
    const d = buf.getChannelData(0), r = RNG.from('audio-fallback-noise');
    for (let i = 0; i < n; i++) d[i] = (r.next() * 2 - 1) * 1.7320508;
    this._fbNoise = buf;
    return buf;
  }

  /** Stop everything and release the nodes. */
  dispose() {
    for (const k in this.layers) this.layers[k].dispose?.();
    try { this.master.disconnect(); } catch { /* ignore */ }
  }
}
