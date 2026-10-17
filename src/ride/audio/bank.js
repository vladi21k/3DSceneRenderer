// Sample bank: every sound the engine plays from a buffer is synthesized once as an
// AudioBuffer (no recorded samples). Synthesis runs in two module workers in parallel
// (mechanical + street sounds, and the crowd's voices) so the render loop never stalls;
// buffers arrive in priority order and the layers pick each one up as soon as it
// exists. The finished bank is cached in IndexedDB (keyed by sample rate and bank
// version), so later visits start complete. Falls back to in-thread synthesis
// (yielding between jobs) if workers cannot be started.
import { toBuffer, yieldTask } from './dsp.js';
import { synthJobs, BANK_VERSION } from './synth/jobs.js';

const DB_NAME = 'tramline-audio', STORE = 'banks';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } finally { db.close(); }
}

async function cachePut(key, value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      st.clear(); // older versions / other rates: keep one bank only
      st.put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export class Bank {
  /** opts: {inline: synthesize in this thread, cache: use IndexedDB (default true)} */
  constructor(sampleRate, opts = {}) {
    this.sr = sampleRate;
    this.map = new Map();
    this.ready = false;
    this.ms = 0;
    this.source = '';
    this.inline = !!opts.inline;
    this.cache = opts.cache !== false;
    this._building = null;
    this._keep = null;
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

  _put(it) {
    this.map.set(it.name, toBuffer(it.chans, it.rate));
    if (this._keep) this._keep.push(it);
  }

  async _build() {
    const t0 = performance.now();
    const key = `${BANK_VERSION}@${this.sr}`;
    if (this.cache) {
      try {
        const hit = await cacheGet(key);
        if (hit && Array.isArray(hit.items) && hit.items.length) {
          for (const it of hit.items) this._put(it);
          this.source = 'cache';
          this.ms = performance.now() - t0;
          this.ready = true;
          return this;
        }
      } catch { /* no cache available: synthesize */ }
      this._keep = [];
    }
    let done = false;
    if (!this.inline && typeof Worker !== 'undefined') {
      try {
        const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
        await Promise.all((cores >= 3 ? ['a', 'b'] : ['all']).map((part) => this._buildInWorker(part)));
        done = true;
        this.source = 'workers';
      } catch (e) { console.warn('[audio] synthesis worker unavailable, synthesizing in-thread', e); }
    }
    if (!done) {
      for await (const it of synthJobs(this.sr)) { if (!this.map.has(it.name)) this._put(it); await yieldTask(); }
      this.source = 'inline';
    }
    this.ms = performance.now() - t0;
    this.ready = true;
    const keep = this._keep;
    this._keep = null;
    if (keep) cachePut(key, { items: keep }).catch(() => { /* quota / private mode: fine */ });
    return this;
  }

  _buildInWorker(part) {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./synth/worker.js', import.meta.url), { type: 'module' });
      const fail = (err) => { w.terminate(); reject(err); };
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === 'buffer') this._put(m);
        else if (m.type === 'done') { w.terminate(); resolve(); } else fail(new Error(m.message));
      };
      w.onerror = (e) => { e.preventDefault?.(); fail(new Error(e.message || 'worker error')); };
      w.postMessage({ sr: this.sr, part });
    });
  }
}
