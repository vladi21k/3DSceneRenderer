// Sample bank: every sound the engine plays from a buffer is synthesized once as an
// AudioBuffer (no recorded samples). Synthesis runs in two module workers in parallel
// (mechanical + street sounds, and the crowd's voices) so the render loop never stalls;
// buffers arrive in priority order and the layers pick each one up as soon as it
// exists. The finished bank is cached in IndexedDB (keyed by sample rate and bank
// version), so later visits start complete. The cache is written and read one buffer
// per transaction (~40 MB in all): cloning the whole bank in one go would stall a frame
// for ~60 ms just as the tram pulls away. Falls back to in-thread synthesis (yielding
// between jobs) if workers cannot be started.
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

/** One read request in its own transaction. */
function get(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

/** One write transaction: fn(store) queues the requests. */
function write(db, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    fn(tx.objectStore(STORE));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Cached bank `key`: an index record {names} plus one record per buffer. Calls
 *  onItem for each buffer as it is read; resolves false when there is no complete copy. */
async function cacheRead(key, onItem) {
  const db = await openDb();
  try {
    const index = await get(db, key);
    if (!index || !Array.isArray(index.names) || !index.names.length) return false;
    // one transaction with every buffer requested up front: each result arrives (and is
    // deserialized) in its own task, in priority order
    return await new Promise((resolve, reject) => {
      const st = db.transaction(STORE, 'readonly').objectStore(STORE);
      let left = index.names.length, complete = true;
      for (const name of index.names) {
        const r = st.get(`${key}/${name}`);
        r.onsuccess = () => {
          const it = r.result;
          if (it && Array.isArray(it.chans)) onItem(it); else complete = false;
          if (--left === 0) resolve(complete);
        };
        r.onerror = () => reject(r.error);
      }
    });
  } finally { db.close(); }
}

/** Stores the bank one buffer per transaction, the index last (so a write cut short is
 *  never read as complete). Older versions / other rates are cleared first: one bank only. */
async function cacheWrite(key, items) {
  const db = await openDb();
  try {
    await write(db, (st) => st.clear());
    for (const it of items) await write(db, (st) => st.put(it, `${key}/${it.name}`));
    await write(db, (st) => st.put({ names: items.map((it) => it.name) }, key));
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
        if (await cacheRead(key, (it) => this._put(it))) {
          this.source = 'cache';
          this.ms = performance.now() - t0;
          this.ready = true;
          return this;
        }
      } catch { /* no cache available: synthesize */ }
      this.map.clear();   // drop a partial read: the whole bank is synthesized (and cached) afresh
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
    if (keep) cacheWrite(key, keep).catch(() => { /* quota / private mode: fine */ });
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
