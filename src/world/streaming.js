import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { CHUNK_LEN, VIEW_AHEAD, VIEW_BEHIND, VIEW_FAR, LOD0_DIST } from '../core/config.js';

// Streams the route in CHUNK_LEN pieces around the camera. Each chunk holds one
// Object3D per chunk-building module. Builds are time-sliced (a few ms per frame),
// nearest-first; chunks behind the camera are recycled; chunks crossing LOD0_DIST
// are rebuilt at full detail and swapped in when ready (no popping gaps).
//
// Once the app is running (staged = true) a finished chunk is not shown at once: its
// programs are compiled in the background (compileAsync) and its module parts are then
// revealed a few per frame under a GPU-upload byte budget, swapping each replacement
// part with the old part of the same module, so no single frame uploads a whole chunk.
//
// Detail levels: lod 0 within LOD0_DIST, lod 1 out to VIEW_AHEAD, and lod 2 (the far
// field) from there to VIEW_FAR. A builder is asked for the levels in its `lods` list
// (default [0, 1]); the far field (core/farfield.js) builds lod 2 only. A lod 2 chunk
// coming within VIEW_AHEAD is upgraded like any other: the full chunk is built and
// revealed, then the far-field part is dropped.

const DEFAULT_LODS = [0, 1];

export class World {
  constructor(app, builders) {
    this.app = app;
    this.builders = builders;          // modules with build(chunk, app)
    this.chunks = new Map();           // index -> chunk
    this.root = new THREE.Group();
    this.root.name = 'world';
    app.scene.add(this.root);
    this.budgetMs = 7;
    this.uploadBudget = 4 << 20;       // bytes of new geometry revealed per frame (staged mode)
    this.staged = false;               // main switches this on after start-up
    this.revealing = [];               // chunks compiled and waiting to be revealed
    this.stats = { built: 0, disposed: 0, lastBuildMs: 0, queue: 0, buildMsByModule: {}, revealBytes: 0 };
    this._ride = {};                   // module -> recent ride-time build durations (ms)
    this.viewFar = VIEW_FAR;
    // (debug: ffnear=<m> starts the far field nearer, to compare it with the real thing)
    this.viewAhead = Math.min(VIEW_AHEAD, app.params?.num ? app.params.num('ffnear', VIEW_AHEAD) : VIEW_AHEAD);
    this.farBuilders = this.buildersFor(2).length;
    // per-frame bookkeeping without garbage (a major collection is a 20-50 ms hitch): the
    // wanted list, its index lookup and the build queue reuse their entries, and the
    // dedupe of upcoming() uses a stamp table instead of a set of string keys
    const n = app.layout.nChunks;
    this._byName = new Map(builders.map((b) => [b.name, b]));
    this._names = [0, 1, 2].map((lod) => this.buildersFor(lod).map((b) => b.name));
    this._want = [];                       // update(): reusable {idx, dist, lod}
    this._wantU = [];                      // upcoming() / readyAround(): their own list
    this._wantAt = new Int32Array(n);      // chunk index -> slot in _want (valid when stamped)
    this._wantStamp = new Int32Array(n);
    this._stamp = 0;
    this._seen = new Int32Array(n * 4);    // upcoming(): (index, lod) already listed (stamp)
    this._seenStamp = 0;
    this._queue = [];                      // reusable {c, dist, upgrade}
    this._recycleFn = (c, idx) => this._recycle(c, idx);
  }

  /** Fill `list` (reusing its entries) with the wanted chunks around sCam; returns the count. */
  _fillWanted(sCam, list) {
    const n = this.app.layout.nChunks;
    const i0 = Math.floor((sCam - VIEW_BEHIND) / CHUNK_LEN), i1 = Math.floor((sCam + this.viewAhead) / CHUNK_LEN);
    // the far field only while some builder serves it, and never wrapping onto the near range
    const i2 = this.farBuilders ? Math.min(Math.floor((sCam + this.viewFar) / CHUNK_LEN), i0 + n - 1) : i1;
    let k = 0;
    for (let i = i0; i <= i2; i++, k++) {
      const idx = ((i % n) + n) % n;
      const mid = i * CHUNK_LEN + CHUNK_LEN / 2;
      const dist = Math.max(0, Math.abs(mid - sCam) - CHUNK_LEN / 2);
      const lod = i > i1 ? 2 : dist < LOD0_DIST ? 0 : 1;
      const w = list[k];
      if (w) { w.idx = idx; w.dist = dist; w.lod = lod; } else list.push({ idx, dist, lod });
    }
    return k;
  }

  /** The wanted chunks around sCam, [{idx, dist, lod}] (a new array). */
  wanted(sCam) {
    const tmp = [];
    const n = this._fillWanted(sCam, tmp);
    tmp.length = n;
    return tmp;
  }

  /** Builders asked for chunks of detail level `lod`. */
  buildersFor(lod) { return this.builders.filter((b) => (b.lods || DEFAULT_LODS).includes(lod)); }

  makeChunk(idx, lod) {
    const L = this.app.route.length;
    const s0 = idx * CHUNK_LEN, s1 = Math.min(L, s0 + CHUNK_LEN);
    const group = new THREE.Group();
    group.name = `chunk${idx}`;
    group.visible = false;
    return {
      index: idx, s0, s1, lod, group,
      parts: new Map(),        // module name -> Object3D
      pending: (this._names[lod] || this.buildersFor(lod).map((b) => b.name)).slice(),
      ready: false,
      rng: (tag) => RNG.from(this.app.layout.seed, tag, idx),
    };
  }

  /** Synchronously build every wanted chunk within `dist` (used at start-up); `lods`
   *  limits it to those detail levels (the far field is primed apart, it is cheap).
   *  `only` (a Set of module names) builds just those modules' parts and leaves the rest
   *  pending for a later prime, which builds them and finishes the chunks. */
  async prime(sCam, dist, onProgress, lods = null, only = null) {
    const want = this.wanted(sCam).filter((w) => w.dist <= dist && (!lods || lods.includes(w.lod))).sort((a, b) => a.dist - b.dist);
    let done = 0;
    for (const w of want) {
      let c = this.chunks.get(w.idx);
      if (!c) { c = this.makeChunk(w.idx, w.lod); this.chunks.set(w.idx, c); this.root.add(c.group); }
      if (c.ready) continue;
      if (only) {
        const later = [];
        while (c.pending.length) {
          if (only.has(c.pending[0])) this._buildPart(c);
          else later.push(c.pending.shift());
        }
        c.pending = later;
      } else {
        while (c.pending.length) this._buildPart(c);
      }
      if (!c.pending.length) this._finish(c);
      done++;
      onProgress && onProgress(done / want.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  _buildPart(c) {
    const name = c.pending.shift();
    const b = this._byName.get(name);
    if (!b || b.disabled) return;
    const t0 = performance.now();
    try {
      const obj = b.build(c, this.app);
      if (obj) {
        obj.name = obj.name || name;
        c.parts.set(name, obj);
        c.group.add(obj);
      }
    } catch (e) {
      console.error(`[world] ${name}.build(chunk ${c.index}) failed`, e);
      b.errors = (b.errors || 0) + 1;
      if (b.errors > 3) { b.disabled = true; console.error(`[world] module ${name} disabled after repeated errors`); }
    }
    const dt = performance.now() - t0;
    this.stats.buildMsByModule[name] = Math.max(this.stats.buildMsByModule[name] || 0, dt) * 0.98 + dt * 0.02;
    if (this.staged) {   // ride-time samples only (start-up prime and warm-up builds excluded)
      const w = this._ride[name] || (this._ride[name] = { v: new Float32Array(RIDE_KEEP), n: 0 });
      w.v[w.n++ % RIDE_KEEP] = dt;
    }
  }

  _finish(c) {
    c.ready = true;
    c.group.visible = true;
    for (const obj of c.parts.values()) obj.visible = true;
    if (c.replaces) { this._dispose(c.replaces); c.replaces = null; }
  }

  /** All parts built: compile in the background, then reveal under the upload budget. */
  _stage(c) {
    c.stage = 'compile';
    const app = this.app, r = app.renderer;
    const done = () => {
      if (c.dead) return;
      app.touchPrograms && app.touchPrograms(r);
      c.stage = 'reveal';
      c.toReveal = [...c.parts.keys()];
      for (const obj of c.parts.values()) obj.visible = false;
      c.group.visible = true;
      this.revealing.push(c);
    };
    try {
      const rt = app.post && !app.post.disabled ? app.post.sceneRT : null;
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt || null);
      const p = r.compileAsync(c.group, app.camera, app.scene);
      r.setRenderTarget(prev);
      p.then(done, done);
    } catch (e) { done(); }
  }

  _reveal() {
    let bytes = 0, shown = 0;
    sortByDist(this.revealing, this.revealing.length);
    while (this.revealing.length && (shown === 0 || bytes < this.uploadBudget)) {
      const c = this.revealing[0];
      if (c.dead) { this.revealing.shift(); continue; }
      const name = c.toReveal.shift();
      if (c.replaces && !c.orphansHidden) {
        // parts of the old chunk with no counterpart here (the far field under a full
        // chunk) go with the first reveal, so they never overlap the new geometry
        c.orphansHidden = true;
        for (const [n, o] of c.replaces.parts) if (!c.parts.has(n)) o.visible = false;
      }
      if (name !== undefined) {
        const obj = c.parts.get(name);
        obj.visible = true;
        bytes += objectBytes(obj);
        shown++;
        const old = c.replaces && c.replaces.parts.get(name);
        if (old) old.visible = false;
      }
      if (!c.toReveal.length) {
        this.revealing.shift();
        c.stage = null;
        if (c.replaces) this.chunks.set(c.index, c);
        this._finish(c);
      }
    }
    this.stats.revealBytes = bytes;
  }

  _dispose(c) {
    c.dead = true;
    for (const [name, obj] of c.parts) {
      const b = this._byName.get(name);
      try {
        if (b && b.dispose) b.dispose(obj, c, this.app);
        else disposeObject(obj);
      } catch (e) { console.error(`[world] dispose ${name}`, e); }
    }
    c.parts.clear();
    this.root.remove(c.group);
    this.stats.disposed++;
  }

  /** Map.forEach callback of update(): drop a chunk that is no longer wanted. */
  _recycle(c, idx) {
    if (this._wantStamp[idx] !== this._stamp) { this._dispose(c); if (c.next) this._dispose(c.next); this.chunks.delete(idx); }
    else c.dist = this._want[this._wantAt[idx]].dist;
  }

  /** Next build-queue entry (reused between frames). */
  _enqueue(n, c, dist, upgrade) {
    const q = this._queue[n];
    if (q) { q.c = c; q.dist = dist; q.upgrade = upgrade; } else this._queue.push({ c, dist, upgrade });
    return n + 1;
  }

  update(sCam) {
    const want = this._want;
    const nWant = this._fillWanted(sCam, want);
    const stamp = ++this._stamp;
    for (let k = 0; k < nWant; k++) { const idx = want[k].idx; this._wantStamp[idx] = stamp; this._wantAt[idx] = k; }
    // recycle
    this.chunks.forEach(this._recycleFn);
    this.stats.revealBytes = 0;   // (bytes revealed this frame)
    if (this.revealing.length) this._reveal();
    // create / schedule
    const queue = this._queue;
    let nq = 0;
    for (let k = 0; k < nWant; k++) {
      const w = want[k];
      let c = this.chunks.get(w.idx);
      if (!c) {
        c = this.makeChunk(w.idx, w.lod);
        this.chunks.set(w.idx, c);
        this.root.add(c.group);
      } else if (c.ready && w.lod < c.lod && !c.next) {
        // upgrade: build a replacement in the background
        c.next = this.makeChunk(w.idx, w.lod);
        this.root.add(c.next.group);
      }
      if (!c.ready) nq = this._enqueue(nq, c, w.dist, null);
      if (c.next) nq = this._enqueue(nq, c.next, w.dist, c);
    }
    sortByDist(queue, nq);
    this.stats.queue = nq;
    const t0 = performance.now();
    for (let k = 0; k < nq; k++) {
      const q = queue[k];
      while (q.c.pending.length && performance.now() - t0 < this.budgetMs) this._buildPart(q.c);
      if (!q.c.pending.length && !q.c.ready && !q.c.stage) {
        q.c.dist = q.dist;
        if (this.staged) {
          if (q.upgrade) q.c.replaces = q.upgrade;   // the map switches to it once revealed
          this._stage(q.c);
        } else {
          if (q.upgrade) {
            q.c.replaces = q.upgrade;
            this.chunks.set(q.c.index, q.c);
            q.upgrade.next = null;
          }
          this._finish(q.c);
        }
      }
      if (performance.now() - t0 >= this.budgetMs) break;
    }
    // (release the references held by the reused queue entries)
    for (let k = 0; k < nq; k++) { queue[k].c = null; queue[k].upgrade = null; }
    this.stats.lastBuildMs = performance.now() - t0;
  }

  /** Chunks the streamer will build next, nearest first: [{index, lod, dist, future}]. Public
   *  API for modules that prefetch their own work ahead of build(). With `out` (an array
   *  owned by the caller) the result is written into it, reusing its entry objects, and
   *  returned: no garbage for a caller that asks every frame. */
  upcoming(sCam = this.app.cameraS ?? this.app.startS, lookAhead = 0, out = null) {
    const res = out || [];
    // (a caller's array keeps its entry objects in a side pool, so a shorter list one frame
    // does not throw them away)
    const pool = out ? (out._pool || (out._pool = [])) : null;
    let n = 0;
    const seen = this._seen, stamp = ++this._seenStamp;
    // what is wanted now, plus what will be wanted (or upgraded to lod 0) within lookAhead metres of travel
    for (let step = 0; step < (lookAhead > 0 ? 2 : 1); step++) {
      const ahead = step ? lookAhead : 0;
      const list = this._wantU, nw = this._fillWanted(sCam + ahead, list);
      for (let k = 0; k < nw; k++) {
        const w = list[k];
        if (w.lod > 1) continue;   // the far field is core's own (no module prefetches it)
        const key = w.idx * 4 + w.lod;
        if (seen[key] === stamp) continue;
        seen[key] = stamp;
        const c = this.chunks.get(w.idx);
        if (!c || !c.ready || (c.next && !c.next.ready) || w.lod < c.lod) {
          const dist = w.dist + ahead, future = ahead > 0;
          let e = pool ? pool[n] : null;
          if (e) { e.index = w.idx; e.lod = w.lod; e.dist = dist; e.future = future; } else {
            e = { index: w.idx, lod: w.lod, dist, future };
            if (pool) pool[n] = e;
          }
          res[n++] = e;
        }
      }
    }
    res.length = n;
    sortByDist(res, n);
    return res;
  }

  /** Ride-time chunk build statistics per module: {name: {n, p50, p95, max}} (ms), over the
   *  last RIDE_KEEP builds of each. */
  rideBuildStats() {
    const out = {};
    for (const [name, w] of Object.entries(this._ride)) {
      const m = Math.min(w.n, RIDE_KEEP);
      if (!m) continue;
      const a = w.v.slice(0, m).sort(), q = (f) => +a[Math.min(m - 1, Math.floor(f * m))].toFixed(2);
      out[name] = { n: m, p50: q(0.5), p95: q(0.95), max: +a[m - 1].toFixed(2) };
    }
    return out;
  }

  /** True when every chunk within `dist` metres of sCam is built. */
  readyAround(sCam, dist) {
    const list = this._wantU, n = this._fillWanted(sCam, list);
    for (let k = 0; k < n; k++) {
      const w = list[k];
      if (w.dist <= dist && w.lod < 2 && !this.chunks.get(w.idx)?.ready) return false;
    }
    return true;
  }
}

const RIDE_KEEP = 200;   // ride-time build samples kept per module

/** Stable insertion sort of the first n entries of `a` by their `dist` (missing: 0), without
 *  garbage: the lists are a few dozen long, and Array.prototype.sort copies its array (and
 *  a comparator that is not inlined boxes its result) on every call. */
function sortByDist(a, n) {
  for (let i = 1; i < n; i++) {
    const x = a[i], kx = x.dist ?? 0;
    let j = i - 1;
    while (j >= 0 && (a[j].dist ?? 0) > kx) { a[j + 1] = a[j]; j--; }
    a[j + 1] = x;
  }
}

/** Rough GPU upload size of an object's (non-shared) geometry and instance buffers. */
function objectBytes(obj) {
  if (obj.userData.__bytes !== undefined) return obj.userData.__bytes;
  let b = 0;
  obj.traverse((o) => {
    const g = o.geometry;
    if (g && !g.userData?.shared) {
      if (g.userData?.revealBytes !== undefined) b += g.userData.revealBytes;   // module pre-uploaded part of it
      else {
        for (const k in g.attributes) b += g.attributes[k].array?.byteLength || 0;
        if (g.index) b += g.index.array.byteLength;
      }
    }
    if (o.isInstancedMesh) b += o.instanceMatrix.array.byteLength + (o.instanceColor ? o.instanceColor.array.byteLength : 0);
  });
  obj.userData.__bytes = b;
  return b;
}

/** Dispose geometries under obj unless flagged shared (geometry.userData.shared). */
export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose();
    if (o.isInstancedMesh && o.dispose) o.dispose();
    if (o.material && o.userData?.ownMaterial) {
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    }
  });
}
