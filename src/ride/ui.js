import { input } from './input.js';

// Cab HUD in #ui-root: a thin cinematic overlay. Contract: docs/ARCHITECTURE.md
//  - bottom left: speed (km/h), master controller strip (applied effort + notch),
//    auto / manual mode, next stop distance and station status;
//  - bottom right: time-of-day and lens (FOV) sliders;
//  - start overlay ("Click to ride" + controls) once the world is ready: the click
//    emits 'start' (audio starts on it) and enables keyboard / pointer controls;
//  - H hides / shows everything, a short controls hint fades after starting;
//  - capture=1: no DOM at all. debug=1 adds a small stats readout.

const TOD_STOPS = [[0, 12.5], [0.55, 18.25], [0.8, 19.5], [1, 20.0]];   // slider t -> clock hour (label only)

function clockOf(t) {
  for (let i = 1; i < TOD_STOPS.length; i++) {
    const [t0, h0] = TOD_STOPS[i - 1], [t1, h1] = TOD_STOPS[i];
    if (t <= t1) {
      const h = h0 + (h1 - h0) * ((t - t0) / (t1 - t0));
      const hh = Math.floor(h), mm = Math.round(((h - hh) * 60) / 5) * 5;
      return `${String(hh + (mm === 60 ? 1 : 0)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
    }
  }
  return '20:00';
}
function todName(t) {
  return t < 0.3 ? 'Midday' : t < 0.47 ? 'Afternoon' : t < 0.68 ? 'Golden hour' : t < 0.88 ? 'Sunset' : 'Dusk';
}
const focalOf = (fov) => 12 / Math.tan((fov * Math.PI) / 360);          // 35 mm equivalent (24 mm frame height)
const fovOf = (f) => (360 / Math.PI) * Math.atan(12 / f);
function fmtDist(d) {
  if (!isFinite(d)) return '—';
  if (d >= 1000) return `${(d / 1000).toFixed(1)} km`;
  if (d >= 100) return `${Math.round(d / 10) * 10} m`;
  return `${Math.max(0, Math.round(d))} m`;
}

const LEGEND = [
  ['W  S', 'Power · brake'],
  ['A', 'Auto drive'],
  ['B  Space', 'Bell'],
  ['Drag', 'Look around'],
  ['Z  X', 'Zoom'],
  ['H', 'Hide interface'],
];

function el(tag, cls, parent, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
}

const ui = {
  name: 'ui',

  async init(app) {
    this.app = app;
    this.root = document.getElementById('ui-root');
    input.attach(app.canvas);
    if (app.params.capture || !this.root) return;   // clean frames for captures

    input.enabled = false;                           // until the start overlay is dismissed
    this.started = false;
    this.hidden = false;
    this._last = {};
    this._build();
    input.on('hideUi', (e) => { if (!e.repeat) this.toggle(); });
    input.on('fullscreen', (e) => {
      if (e.repeat) return;
      const d = document;
      if (d.fullscreenElement) d.exitFullscreen?.();
      else d.documentElement.requestFullscreen?.().catch(() => {});
    });
    app.events.on('ready', () => this._showOverlay());
    app.events.on('tod', ({ t }) => this._setTod(t, false));
    if (app.ready) this._showOverlay();
  },

  _build() {
    const r = this.root;
    r.classList.add('ride-ui');
    this.hud = el('div', 'hud', r);
    el('div', 'hud-shade', this.hud);

    // ---- left: speed, controller, stop
    const left = el('div', 'hud-left', this.hud);
    const spd = el('div', 'spd', left);
    this.$speed = el('span', 'spd-v', spd, '0');
    const unit = el('span', 'spd-side', spd);
    el('span', 'spd-u', unit, 'km/h');
    this.$limit = el('span', 'spd-limit', unit);

    const ctl = el('div', 'ctl', left);
    const track = el('div', 'ctl-track', ctl);
    this.$fill = el('div', 'ctl-fill', track);
    const n = (this.app.train && this.app.train.notches) ? this.app.train.notches.length : 10;
    this.nNotch = n;
    for (let i = 0; i < n; i++) {
      const t = el('i', 'ctl-tick' + (i === 5 ? ' ctl-tick-n' : i === 0 ? ' ctl-tick-eb' : ''), track);
      t.style.left = `${(i / (n - 1)) * 100}%`;
    }
    this.$mark = el('div', 'ctl-mark', track);
    const meta = el('div', 'ctl-meta', ctl);
    this.$notch = el('span', 'ctl-id', meta, 'N');
    this.$mode = el('button', 'ctl-mode', meta, 'Auto');
    this.$mode.type = 'button';
    this.$mode.title = 'Toggle automatic driving (A)';
    this.$mode.addEventListener('click', () => {
      const tr = this.app.train;
      if (tr && tr.setAuto) tr.setAuto(!tr.auto);
      this.$mode.blur();
    });

    const stop = el('div', 'stop', left);
    this.$stopK = el('span', 'stop-k', stop, 'Next stop');
    this.$stopV = el('span', 'stop-v', stop, '');

    // ---- right: sliders
    const right = el('div', 'hud-right', this.hud);
    const mk = (label, min, max, step) => {
      const row = el('label', 'sl', right);
      const head = el('div', 'sl-head', row);
      el('span', 'sl-k', head, label);
      const val = el('span', 'sl-v', head, '');
      const inp = el('input', 'sl-in', row);
      Object.assign(inp, { type: 'range', min, max, step });
      // release focus after use so arrow keys go back to the master controller
      inp.addEventListener('pointerup', () => inp.blur());
      inp.addEventListener('change', () => inp.blur());
      return { inp, val };
    };
    this.tod = mk('Time of day', 0, 1, 0.001);
    this.lens = mk('Lens', Math.log(focalOf(60)), Math.log(focalOf(12)), 0.001);
    this.tod.inp.addEventListener('input', () => this._queueTod(+this.tod.inp.value));
    this.lens.inp.addEventListener('input', () => {
      const rig = this.app.cameraRig;
      const fov = fovOf(Math.exp(+this.lens.inp.value));
      if (rig && rig.setFov) rig.setFov(fov); else { this.app.camera.fov = fov; this.app.camera.updateProjectionMatrix(); }
    });
    const env = this.app.env;
    this._setTod(env?.state?.t ?? env?.t ?? this.app.params.tod ?? 0, true);

    // ---- controls hint (after start) and hidden-UI toast
    this.$hint = el('div', 'hint', this.hud,
      '<span><kbd>W</kbd><kbd>S</kbd> power · brake</span><span><kbd>A</kbd> auto</span><span><kbd>B</kbd> bell</span>'
      + '<span>drag to look</span><span><kbd>Z</kbd><kbd>X</kbd> zoom</span><span><kbd>H</kbd> hide</span>');
    this.$toast = el('div', 'toast', r, 'Press <kbd>H</kbd> to show the interface');

    // ---- start overlay
    this.$overlay = el('button', 'start', r);
    this.$overlay.type = 'button';
    const inner = el('div', 'start-inner', this.$overlay);
    el('div', 'start-eyebrow', inner, 'Cab ride');
    el('div', 'start-title', inner, 'Click to ride');
    el('div', 'start-rule', inner);
    const grid = el('div', 'start-legend', inner);
    for (const [k, v] of LEGEND) {
      el('span', 'lg-k', grid, k.split('  ').map((x) => `<kbd>${x}</kbd>`).join(''));
      el('span', 'lg-v', grid, v);
    }
    this.$overlay.addEventListener('click', () => this._start());

    if (this.app.params.debug) this.$stats = el('pre', 'dbg', r);
  },

  _showOverlay() {
    if (!this.$overlay || this.started) return;
    this.$overlay.classList.add('show');
    try { this.$overlay.focus({ preventScroll: true }); } catch { /* old browsers */ }
  },

  _start() {
    if (this.started) return;
    this.started = true;
    this.$overlay.classList.remove('show');
    this.$overlay.classList.add('gone');
    this.$overlay.blur();
    setTimeout(() => this.$overlay && this.$overlay.remove(), 900);
    input.enabled = true;
    this.hud.classList.add('live');
    this.$hint.classList.add('show');
    clearTimeout(this._hintT);
    this._hintT = setTimeout(() => this.$hint.classList.remove('show'), 7000);
    this.app.events.emit('start', {});
  },

  toggle(force) {
    this.hidden = force ?? !this.hidden;
    this.root.classList.toggle('ui-hidden', this.hidden);
    this.$toast.classList.toggle('show', this.hidden);
    clearTimeout(this._toastT);
    if (this.hidden) this._toastT = setTimeout(() => this.$toast.classList.remove('show'), 2200);
  },

  _queueTod(t) {
    this._todPending = t;
    if (this._todRaf) return;
    this._todRaf = requestAnimationFrame(() => {
      this._todRaf = 0;
      const env = this.app.env;
      if (env && env.setTimeOfDay && !env.disabled) env.setTimeOfDay(this._todPending);
      else this._setTod(this._todPending, false);
    });
  },

  _setTod(t, force) {
    if (!this.tod) return;
    if (force || document.activeElement !== this.tod.inp) this.tod.inp.value = String(t);
    this.tod.val.textContent = `${clockOf(t)}  ·  ${todName(t)}`;
  },

  _set(key, node, text) {
    if (this._last[key] === text) return;
    this._last[key] = text;
    node.textContent = text;
  },

  update(dt, app) {
    if (!this.hud) return;
    const tr = app.train;
    if (tr) {
      // speed: lightly smoothed so the last digit does not flicker
      const kmh = tr.speed * 3.6;
      this._kmh = this._kmh == null ? kmh : this._kmh + (kmh - this._kmh) * Math.min(1, (app.realDt || 0.016) * 8);
      this._set('spd', this.$speed, String(Math.round(this._kmh < 0.3 ? 0 : this._kmh)));
      const lim = tr.limit * 3.6;
      this._set('lim', this.$limit, lim < 46 && tr.speed > 0.1 ? `limit ${Math.round(lim / 5) * 5}` : '');

      // controller strip: applied effort (fill) and selected notch (mark)
      const n = this.nNotch, xN = 5 / (n - 1), xB = 1 / (n - 1);
      const th = tr.emergency ? -1.25 : tr.throttle;
      const x = th >= 0 ? xN + th * (1 - xN) : th >= -1 ? xN + th * (xN - xB) : 0;
      const key = `${x.toFixed(3)}|${th >= 0 ? 1 : 0}`;
      if (this._last.fill !== key) {
        this._last.fill = key;
        this.$fill.style.left = `${Math.min(x, xN) * 100}%`;
        this.$fill.style.width = `${Math.abs(x - xN) * 100}%`;
        this.$fill.classList.toggle('brake', th < 0);
      }
      const manual = !tr.auto;
      this.$mark.style.opacity = manual ? '1' : '0';
      if (manual) this.$mark.style.left = `${(tr.notch / (n - 1)) * 100}%`;
      const notchText = manual ? (tr.notchId || 'N') + (tr.assisting ? ' · stop' : '')
        : tr.throttle > 0.06 ? 'Power' : tr.throttle < -0.06 ? 'Brake' : 'Coast';
      this._set('notch', this.$notch, notchText);
      this._set('mode', this.$mode, tr.auto ? 'Auto' : 'Manual');
      this.$mode.classList.toggle('manual', manual);

      // next stop / station status
      const ph = tr.phase, ns = tr.nextStop || {};
      let k = 'Next stop', v = fmtDist(ns.distance);
      if (ph === 'arriving') { k = 'At platform'; v = ''; }
      else if (ph === 'doors-open') { k = 'Doors open'; v = ''; }
      else if (ph === 'doors-closing') { k = 'Doors closing'; v = ''; }
      else if (ph === 'departing') { k = 'Departing'; v = ''; }
      else if (!ns.station) { k = ''; v = ''; }
      else if (ns.distance < 160 && tr.state === 'brake') k = 'Stopping in';
      this._set('stopK', this.$stopK, k);
      this._set('stopV', this.$stopV, v);
    }

    // lens slider follows zoom from keys / wheel
    const rig = app.cameraRig;
    if (rig && this.lens && document.activeElement !== this.lens.inp) {
      const f = focalOf(rig.targetFov ?? app.camera.fov);
      const val = Math.log(f).toFixed(3);
      if (this._last.lens !== val) { this._last.lens = val; this.lens.inp.value = val; }
    }
    if (this.lens) this._set('lensV', this.lens.val, `${Math.round(focalOf(rig?.fov ?? app.camera.fov))} mm`);

    if (this.$stats) {
      this._statT = (this._statT || 0) + (app.realDt || 0);
      if (this._statT > 0.5 && app.stats) {
        this._statT = 0;
        const s = app.stats();
        this.$stats.textContent = `${s.fps} fps  cpu ${s.cpuMs} ms  gpu ${s.gpuMs} ms\n${s.calls} calls  ${(s.triangles / 1e6).toFixed(2)} M tris\ns ${s.s}  chunks ${s.chunks}  queue ${s.queue}`;
      }
    }
  },
};
export default ui;
