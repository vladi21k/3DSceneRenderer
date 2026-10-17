// Audio: everything is synthesized with WebAudio (no recorded samples).
// Contract: docs/ARCHITECTURE.md. Implementation lives in ./audio/:
//   bank.js      synthesis of every buffer (bell strikes, joints, voices, ...) in
//                workers, cached in IndexedDB
//   worklet.js   AudioWorklet processors: endless noise, smooth random modulation, PWM
//   engine.js    the live graph: layer buses, cab shell, street + cab reverbs,
//                compressor/limiter, tram-local spatial frame
//   layers/*.js  bell, rolling + joints, curve squeal, traction + auxiliaries,
//                brakes + doors, street ambience
//   test.js      OfflineAudioContext harness: app.audio.test({...}) renders a scenario
//                and reports RMS/peak per layer (optionally a WAV)
//
// The AudioContext is created on the 'start' event (the user's click), never in
// capture mode (unless audio=1 is passed, for headless verification).
// API: app.audio.setVolume(0..1), mute(bool), toggleMute(), levels(), test(opts),
//      features (rail joints / turnout parts along the ride track, for the camera rig).
import { params } from '../core/params.js';
import { U } from '../core/uniforms.js';
import { trackFeatures } from './audio/track.js';

const PREFS_KEY = 'tramline.audio';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode etc. */ }
}

const audio = {
  name: 'audio',
  volume: 0.8,
  muted: false,
  started: false,
  ctx: null,
  engine: null,
  bank: null,
  updateMs: 0,

  async init(app) {
    this.app = app;
    const prefs = loadPrefs();
    if (Number.isFinite(prefs.volume)) this.volume = Math.min(1, Math.max(0, prefs.volume));
    this.muted = !!prefs.muted;
    this.features = trackFeatures(app.route, app.layout);
    this.forced = params.str('audio') === '1';
    this.capture = params.capture && !this.forced;
    this._acc = 0;
    this._lastV = null;
    this._st = { t: 0, s: 0, speed: 0, accel: 0, throttle: 0, state: 'run', night: 0, tod: 0, wind: 0.35, listener: { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 } };
    this._live = false;
    if (this.capture) return; // screenshots: no sound at all

    const ev = app.events;
    ev.on('start', () => this.start());
    ev.on('bell', (d) => this._event('bell', d));
    ev.on('doors', (d) => this._event('doors', d));
    // M toggles mute (matched on the printed key, like the ride controls)
    window.addEventListener('keydown', (e) => {
      if ((e.key || '').toLowerCase() !== 'm' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox'))) return;
      this.toggleMute();
    });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else if (!this.muted) this.ctx.resume().catch(() => {});
    });
    if (this.forced) ev.on('ready', () => this.start());
    // no UI module to emit 'start': fall back to the first user gesture
    if (!app.systems.ui) {
      const once = () => { window.removeEventListener('pointerdown', once); window.removeEventListener('keydown', once); this.start(); };
      window.addEventListener('pointerdown', once);
      window.addEventListener('keydown', once);
    }
  },

  /** Create / resume the AudioContext. Must run inside a user gesture (or with autoplay allowed). */
  async start() {
    if (this.capture) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (this.ctx) { if (!this.muted) this.ctx.resume().catch(() => {}); return; }
    let ctx;
    try {
      // headless verification (capture + audio=1) renders without an output device
      const sink = this.forced && params.capture ? { sinkId: { type: 'none' } } : {};
      ctx = new Ctx({ latencyHint: 'interactive', ...sink });
    } catch (e) {
      console.warn('[audio] AudioContext unavailable', e);
      return;
    }
    this.ctx = ctx;
    ctx.resume().catch(() => {});
    const [{ Bank }, { AudioEngine }] = await Promise.all([import('./audio/bank.js'), import('./audio/engine.js')]);
    this.bank = new Bank(ctx.sampleRate, { cache: params.str('audiocache') !== '0' });
    this.bank.build().catch((e) => console.error('[audio] synthesis failed', e));
    await AudioEngine.prepare(ctx);
    const app = this.app;
    this.engine = new AudioEngine(ctx, this.bank, {
      route: app.route, layout: app.layout, features: this.features,
      crowd: () => { const c = app.crowd; return c && !c.disabled && c.agents ? c.agents() : null; },
    });
    this.started = true;
    this._t0 = ctx.currentTime;
    if (this.muted) ctx.suspend().catch(() => {});
  },

  update(dt, app) {
    // nothing to schedule while the clock stands still (muted, hidden tab, not started)
    if (!this.engine || this.ctx.state !== 'running') return;
    const rdt = app.realDt ?? dt;
    const t0 = performance.now();
    const st = this._gather(app, rdt);
    // fade the master in once the reverbs and the first voices exist (at most 1.5 s wait)
    if (!this._live && ((this.bank.get('irN') && this.bank.get('utt7')) || this.ctx.currentTime - this._t0 > 1.5)) {
      this._live = true;
      this._applyLevel(0.5);
    }
    try {
      this.engine.update(rdt, st, this.ctx.currentTime);
      this.updateMs += (performance.now() - t0 - this.updateMs) * 0.05;
    } catch (e) {
      // keep the rest of the app running; report once
      if (!this._warned) { console.error('[audio] update failed', e); this._warned = true; }
    }
  },

  _gather(app, dt) {
    const st = this._st;
    const tr = app.train || {};
    const v = Math.abs(Number.isFinite(tr.speed) ? tr.speed : 0);
    if (this._lastV !== null && dt > 0) {
      const a = (v - this._lastV) / dt;
      this._acc += (a - this._acc) * Math.min(1, dt / 0.3);
    }
    this._lastV = v;
    st.t = this.ctx.currentTime;
    st.s = Number.isFinite(tr.s) ? tr.s : app.cameraS ?? 0;
    st.speed = v;
    st.accel = Number.isFinite(tr.accel) ? tr.accel : this._acc;
    st.throttle = Number.isFinite(tr.throttle) ? tr.throttle
      : st.accel > 0.06 ? Math.min(1, st.accel / 1.2) : st.accel < -0.06 ? Math.max(-1, st.accel / 1.3) : 0;
    st.state = tr.state || 'run';
    st.night = U.uNight.value;
    st.tod = app.env?.state?.t ?? 0;
    st.wind = U.uWindStrength.value;
    // listener = camera (a direct child of the scene); orientation from its quaternion
    const cam = app.camera, L = st.listener, { x, y, z, w } = cam.quaternion;
    L.px = cam.position.x; L.py = cam.position.y; L.pz = cam.position.z;
    L.fx = -2 * (x * z + w * y); L.fy = -2 * (y * z - w * x); L.fz = -(1 - 2 * (x * x + y * y));
    L.ux = 2 * (x * y - w * z); L.uy = 1 - 2 * (x * x + z * z); L.uz = 2 * (y * z + w * x);
    return st;
  },

  _event(type, data) {
    if (!this.engine || this.ctx.state !== 'running') return;
    try { this.engine.event(type, data, this.ctx.currentTime + 0.01); } catch (e) { console.error('[audio] event failed', e); }
  },

  _applyLevel(tc = 0.08) {
    if (!this.engine || !this._live) return;
    const v = this.muted ? 0 : this.volume * this.volume; // perceptual taper
    this.engine.setLevel(v, this.ctx.currentTime, tc);
  },

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, +v || 0));
    savePrefs({ volume: this.volume, muted: this.muted });
    this._applyLevel();
    this.app?.events.emit('audio', { volume: this.volume, muted: this.muted });
  },

  mute(on = true) {
    this.muted = !!on;
    savePrefs({ volume: this.volume, muted: this.muted });
    if (this.ctx) {
      if (this.muted) {
        this._applyLevel(0.03);
        // fade, then stop the audio thread altogether
        clearTimeout(this._suspendT);
        this._suspendT = setTimeout(() => { if (this.muted) this.ctx.suspend().catch(() => {}); }, 250);
      } else {
        clearTimeout(this._suspendT);
        this.ctx.resume().catch(() => {});
        this._applyLevel(0.05);
      }
    }
    this.app?.events.emit('audio', { volume: this.volume, muted: this.muted });
  },

  toggleMute() { this.mute(!this.muted); },

  /** Live RMS level per bus in dBFS (adds analysers on first call). */
  levels() {
    const e = this.engine;
    if (!e) return null;
    if (!this._an) {
      this._an = {};
      // analysers are pulled through a silent path so every browser renders them
      const sink = new GainNode(this.ctx, { gain: 0 });
      sink.connect(this.ctx.destination);
      const tap = (src, k) => { const an = new AnalyserNode(this.ctx, { fftSize: 4096 }); src.connect(an).connect(sink); this._an[k] = an; };
      for (const [k, bus] of Object.entries(e.bus)) tap(bus, k);
      tap(e.master, 'out');
      return { pending: true };
    }
    const buf = new Float32Array(4096), res = {};
    for (const [k, an] of Object.entries(this._an)) {
      an.getFloatTimeDomainData(buf);
      let s = 0, pk = 0;
      for (let i = 0; i < buf.length; i++) { s += buf[i] * buf[i]; pk = Math.max(pk, Math.abs(buf[i])); }
      res[k] = { rms: +(10 * Math.log10(s / buf.length + 1e-12)).toFixed(1), peak: +(20 * Math.log10(pk + 1e-9)).toFixed(1) };
    }
    res.state = this.ctx.state;
    res.bankReady = this.bank.ready;
    res.bankMs = Math.round(this.bank.ms);
    res.bankSource = this.bank.source;
    res.buffers = this.bank.map.size;
    res.worklet = e.worklet;
    res.open = +e.open.toFixed(2);
    res.amb = { ...e.layers.ambience.debug };
    res.updateMs = +this.updateMs.toFixed(3);
    return res;
  },

  /** Offline render of a scenario; see ./audio/test.js. Works in capture mode too. */
  async test(opts = {}) {
    const { runAudioTest } = await import('./audio/test.js');
    return runAudioTest(this.app, opts);
  },
};

export default audio;
