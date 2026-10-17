// Sample bank: every sound the engine plays is synthesized once at start-up as an
// AudioBuffer (no recorded samples). Synthesis runs in a module worker so the
// render loop never stalls; buffers arrive in priority order and the layers pick
// each one up as soon as it exists. Falls back to in-thread synthesis (yielding
// between jobs) if a worker cannot be started.
import { toBuffer, yieldTask } from './dsp.js';
import { synthJobs, BIRD_KINDS } from './synth/jobs.js';

export class Bank {
  constructor(sampleRate, opts = {}) {
    this.sr = sampleRate;
    this.map = new Map();
    this.ready = false;
    this.ms = 0;
    this.birdKinds = BIRD_KINDS;
    this.inline = !!opts.inline;
    this._building = null;
  }

  /** AudioBuffer or null while it is still being synthesized. */
  get(name) { return this.map.get(name) || null; }

  /** All variants name0, name1, ... that exist so far. */
  variants(name) {
    const out = [];
    for (let i = 0; ; i++) { const b = this.map.get(name + i); if (!b) break; out.push(b); }
    return out;
  }

  build() {
    if (!this._building) this._building = this._build();
    return this._building;
  }

  _put(it) { this.map.set(it.name, toBuffer(it.chans, it.rate)); }

  async _build() {
    const t0 = performance.now();
    let done = false;
    if (!this.inline && typeof Worker !== 'undefined') {
      try { await this._buildInWorker(); done = true; } catch (e) { console.warn('[audio] synthesis worker unavailable, synthesizing in-thread', e); }
    }
    if (!done) {
      for await (const it of synthJobs(this.sr)) { this._put(it); await yieldTask(); }
    }
    this.ms = performance.now() - t0;
    this.ready = true;
    return this;
  }

  _buildInWorker() {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./synth/worker.js', import.meta.url), { type: 'module' });
      const fail = (err) => { w.terminate(); reject(err); };
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'buffer') this._put(m);
        else if (m.type === 'done') { w.terminate(); resolve(); } else fail(new Error(m.message));
      };
      w.onerror = (e) => { e.preventDefault?.(); fail(new Error(e.message || 'worker error')); };
      w.postMessage({ sr: this.sr });
    });
  }
}
