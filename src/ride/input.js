// Shared keyboard / pointer state for the ride controls. This is not a registered
// module: train.js, cameraRig.js and ui.js import it directly and subscribe to the
// actions they handle. Letters are matched on `event.key` (so Z/X/H/B follow the
// printed keyboard layout); arrows and Space on `event.code`.
//
// Actions:
//   notchUp / notchDown   W, ArrowUp / S, ArrowDown   (auto-repeat events carry repeat:true)
//   auto                  A        toggle automatic driving
//   bell                  B, Space
//   zoomIn / zoomOut      Z / X    (held: query input.held('zoomIn'))
//   hideUi                H
//   fullscreen            F
// Pointer: drag with any button on the canvas to look; wheel to zoom.

const KEYMAP = {
  w: 'notchUp', arrowup: 'notchUp',
  s: 'notchDown', arrowdown: 'notchDown',
  a: 'auto',
  b: 'bell', space: 'bell',
  z: 'zoomIn', x: 'zoomOut',
  h: 'hideUi',
  f: 'fullscreen',
};

function actionOf(e) {
  if (e.code === 'Space') return KEYMAP.space;
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') return KEYMAP[e.code.toLowerCase()];
  const k = (e.key || '').toLowerCase();
  return k.length === 1 ? KEYMAP[k] : undefined;
}

function isTyping(target) {
  if (!target || !target.tagName) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'TEXTAREA' || (tag === 'INPUT' && target.type !== 'range' && target.type !== 'checkbox');
}

export const input = {
  /** When false (start overlay showing) keys and pointer look are ignored. */
  enabled: true,
  attached: false,
  dragging: false,
  _held: new Map(),       // action -> number of physical keys holding it
  _subs: new Map(),       // action -> Set(fn)
  _look: { dx: 0, dy: 0 },
  _wheel: 0,
  _pointerId: null,
  _last: { x: 0, y: 0 },

  /** Subscribe to an action; returns an unsubscribe function. fn({repeat, event}) */
  on(action, fn) {
    if (!this._subs.has(action)) this._subs.set(action, new Set());
    this._subs.get(action).add(fn);
    return () => this._subs.get(action).delete(fn);
  },

  emit(action, data = {}) {
    const subs = this._subs.get(action);
    if (subs) for (const fn of subs) { try { fn(data); } catch (e) { console.error('[input]', action, e); } }
  },

  /** True while a key mapped to `action` is physically held. */
  held(action) { return this.enabled && (this._held.get(action) || 0) > 0; },

  /** Pointer-look delta in CSS pixels accumulated since the last call. */
  consumeLook() {
    const d = { dx: this._look.dx, dy: this._look.dy };
    this._look.dx = 0; this._look.dy = 0;
    return d;
  },

  /** Wheel delta (pixels, + = away from the user / zoom out) since the last call. */
  consumeWheel() { const w = this._wheel; this._wheel = 0; return w; },

  attach(canvas) {
    if (this.attached || typeof window === 'undefined') return;
    this.attached = true;
    this.canvas = canvas;
    const down = new Set();

    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const action = actionOf(e);
      if (!action) return;
      if (!this.enabled) return;            // (Space / Enter still activate the start overlay)
      e.preventDefault();                   // keep Space / arrows from scrolling or nudging a slider
      if (!down.has(e.code)) {
        down.add(e.code);
        this._held.set(action, (this._held.get(action) || 0) + 1);
      }
      this.emit(action, { repeat: e.repeat, event: e });
    });
    window.addEventListener('keyup', (e) => {
      if (!down.has(e.code)) return;
      down.delete(e.code);
      const action = actionOf(e);
      if (action) this._held.set(action, Math.max(0, (this._held.get(action) || 0) - 1));
    });
    const releaseAll = () => {
      down.clear();
      this._held.clear();
      this._endDrag();
    };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

    if (!canvas) return;
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this._pointerId !== null) return;
      this._pointerId = e.pointerId;
      this._last.x = e.clientX; this._last.y = e.clientY;
      this.dragging = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable: fine */ }
      document.body.classList.add('ride-dragging');
      this.emit('dragStart');
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this._pointerId) return;
      this._look.dx += e.clientX - this._last.x;
      this._look.dy += e.clientY - this._last.y;
      this._last.x = e.clientX; this._last.y = e.clientY;
    });
    const end = (e) => { if (e.pointerId === this._pointerId) this._endDrag(); };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('lostpointercapture', end);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      this._wheel += e.deltaY * scale;
      e.preventDefault();
    }, { passive: false });
  },

  _endDrag() {
    if (!this.dragging) return;
    if (this.canvas && this._pointerId !== null) {
      try { this.canvas.releasePointerCapture(this._pointerId); } catch { /* already released */ }
    }
    this._pointerId = null;
    this.dragging = false;
    document.body.classList.remove('ride-dragging');
    this.emit('dragEnd');
  },
};
