import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { CHUNK_LEN, VIEW_AHEAD, VIEW_BEHIND, VIEW_FAR, LOD0_DIST } from '../core/config.js';

// Streams the route in CHUNK_LEN pieces around the camera. Each chunk holds one
// Object3D per chunk-building module. Builds are time-sliced (a few ms per frame),
// nearest-first; chunks behind the camera are recycled; chunks crossing LOD0_DIST
// are rebuilt at full detail and swapped in when ready (no popping gaps).
//
// Once the app is running (staged = true) a finished chunk is not shown at once: its
// programs are compiled in the background (compileAsync), its vertex buffers are sent to
// the GPU ahead, a slice per frame, while its parts are still hidden (see _preload), and
// its module parts are then revealed (the reveal still sends their index buffers),
// swapping each replacement part with the old part of the same module. Uploads ahead and
// reveals share one per-frame byte budget, so no single frame uploads a whole chunk: a
// facade part alone holds 4-11 MB of vertex data, and a frame that sent 9 MB at once
// stalled for 90-100 ms in the GL calls after it.
//
// Detail levels: lod 0 within LOD0_DIST, lod 1 out to VIEW_AHEAD, and lod 2 (the far
// field) from there to VIEW_FAR. A builder is asked for the levels in its `lods` list
// (default [0, 1]); the far field (core/farfield.js) builds lod 2 only. A lod 2 chunk
// coming within VIEW_AHEAD is upgraded like any other: the full chunk is built and
// revealed, then the far-field part is dropped.

const DEFAULT_LODS = [0, 1];
const NO_GEOMETRY = new THREE.BufferGeometry();   // what an idle uploader mesh holds

export class World {
  constructor(app, builders) {
    this.app = app;
    this.builders = builders;          // modules with build(chunk, app)
    this.chunks = new Map();           // index -> chunk
    this.root = new THREE.Group();
    this.root.name = 'world';
    app.scene.add(this.root);
    this.budgetMs = 7;
    // bytes sent to the GPU per frame in staged mode: vertex buffers uploaded ahead plus what
    // the reveals still send (index and instance buffers); one oversized item may go alone
    this.uploadBudget = 2 << 20;
    this.staged = false;               // main switches this on after start-up
    this.revealing = [];               // chunks compiled and waiting to be revealed
    this.stats = { built: 0, disposed: 0, lastBuildMs: 0, queue: 0, buildMsByModule: {}, revealBytes: 0, preBytes: 0, preMB: 0 };
    // uploads ahead (_preload): meshes without material (nothing is drawn or compiled) that
    // hold a hidden part's geometry for one frame, so the renderer sends its vertex buffers
    // when it walks the scene; endFrame() lets go of them after the frame is rendered
    this.uploader = new THREE.Group();
    this.uploader.name = 'world:upload';
    this.uploader.matrixAutoUpdate = false;
    app.scene.add(this.uploader);
    this._upUsed = 0;
    this._sent = new WeakSet();        // geometries whose vertex buffers went ahead
    this._frame = 0;                   // update() calls
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

  /** Fill `list` (reusing its entries) with the wanted chunks around sCam; returns the count.
   *  `ahead` (m) asks for the detail levels the chunks will need after that much travel
   *  (lod 0 and lod 1 reach that much farther; the range kept is unchanged). */
  _fillWanted(sCam, list, ahead = 0) {
    const n = this.app.layout.nChunks;
    const i0 = Math.floor((sCam - VIEW_BEHIND) / CHUNK_LEN), i1 = Math.floor((sCam + this.viewAhead + ahead) / CHUNK_LEN);
    // the far field only while some builder serves it, and never wrapping onto the near range
    const i2 = this.farBuilders ? Math.max(i1, Math.min(Math.floor((sCam + this.viewFar) / CHUNK_LEN), i0 + n - 1)) : i1;
    const lod0 = LOD0_DIST + ahead;
    let k = 0;
    for (let i = i0; i <= i2; i++, k++) {
      const idx = ((i % n) + n) % n;
      const mid = i * CHUNK_LEN + CHUNK_LEN / 2;
      const dist = Math.max(0, Math.abs(mid - sCam) - CHUNK_LEN / 2);
      const lod = i > i1 ? 2 : dist < lod0 ? 0 : 1;
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
      this._planUploads(c);
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

  /** The vertex buffers of a staged chunk's parts to send ahead of its reveal, in reveal
   *  order: c.up = [mesh, geometry, bytes, ...] (flat), c.upAt the next one. Shared
   *  geometries (geometry.userData.shared) are left out; a module that sent part of a
   *  geometry itself says what drawing it still sends in geometry.userData.revealBytes. */
  _planUploads(c) {
    const up = c.up || (c.up = []);
    up.length = 0;
    c.upAt = 0;
    c.upFrame = -1;
    const seen = new Set();
    for (const name of c.toReveal) {
      c.parts.get(name).traverse((o) => {
        const g = o.geometry;
        if (!g || g === NO_GEOMETRY || g.userData?.shared || seen.has(g)) return;
        seen.add(g);
        const b = vertexBytes(g);
        if (b > 0) up.push(o, g, b);
      });
    }
  }

  /** Send vertex buffers of the staged chunks ahead, nearest chunk first, while the frame's
   *  budget lasts (`bytes` already spent by this frame's reveals). Returns the bytes sent. */
  _preload(bytes) {
    let pre = 0;
    const budget = this.uploadBudget, list = this.revealing;
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (c.dead || !c.up) continue;
      while (c.upAt < c.up.length) {
        const o = c.up[c.upAt], g = c.up[c.upAt + 1], sz = c.up[c.upAt + 2];
        if (bytes + pre > 0 && bytes + pre + sz > budget) return pre;
        c.upAt += 3;
        // (a module may have swapped the mesh's geometry out, and disposed it, since the plan)
        if (o.geometry !== g || !o.parent) continue;
        let m = this.uploader.children[this._upUsed];
        if (!m) {
          m = new THREE.Mesh(NO_GEOMETRY, []);
          m.name = 'world:uploader';
          m.frustumCulled = false;
          m.matrixAutoUpdate = false;
          this.uploader.add(m);
        }
        m.geometry = g;
        this._upUsed++;
        this._sent.add(g);
        c.upFrame = this._frame;
        pre += sz;
      }
    }
    return pre;
  }

  /** After the frame is rendered: the uploader meshes let go of the geometries they showed
   *  the renderer (their GPU buffers stay; disposing the geometry frees them as usual). */
  endFrame() {
    for (let i = 0; i < this._upUsed; i++) this.uploader.children[i].geometry = NO_GEOMETRY;
    this._upUsed = 0;
  }

  _reveal() {
    let bytes = 0, shown = 0;
    const budget = this.uploadBudget;
    sortByDist(this.revealing, this.revealing.length);
    reveal: while (this.revealing.length) {
      const c = this.revealing[0];
      if (c.dead) { this.revealing.shift(); continue; }
      // a chunk shows once all of its vertex buffers went ahead, a frame ago or more (so a
      // nearer chunk still uploading holds back the farther ones: nearest first)
      if (c.up && (c.upAt < c.up.length || c.upFrame === this._frame)) break;
      if (c.replaces && !c.orphansHidden) {
        // parts of the old chunk with no counterpart here (the far field under a full
        // chunk) go with the first reveal, so they never overlap the new geometry
        c.orphansHidden = true;
        for (const [n, o] of c.replaces.parts) if (!c.parts.has(n)) o.visible = false;
      }
      while (c.toReveal.length) {
        const name = c.toReveal[0];
        const obj = c.parts.get(name);
        const b = this._revealBytes(obj);
        if (shown && bytes + b > budget) break reveal;
        c.toReveal.shift();
        obj.visible = true;
        bytes += b;
        shown++;
        const old = c.replaces && c.replaces.parts.get(name);
        if (old) old.visible = false;
      }
      this.revealing.shift();
      c.stage = null;
      c.up = null;
      if (c.replaces) this.chunks.set(c.index, c);
      this._finish(c);
    }
    this.stats.revealBytes = bytes;
    return bytes;
  }

  /** Bytes a part's first draw still sends: index and instance buffers, plus the vertex
   *  buffers of geometries that did not go ahead. */
  _revealBytes(obj) {
    let b = 0;
    obj.traverse((o) => {
      const g = o.geometry;
      if (g && !g.userData?.shared) {
        if (this._sent.has(g)) b += g.index ? g.index.array.byteLength : 0;
        else if (g.userData?.revealBytes !== undefined) b += g.userData.revealBytes;   // module pre-uploaded part of it
        else b += vertexBytes(g) + (g.index ? g.index.array.byteLength : 0);
      }
      if (o.isInstancedMesh) b += o.instanceMatrix.array.byteLength + (o.instanceColor ? o.instanceColor.array.byteLength : 0);
    });
    obj.userData.__bytes = b;
    return b;
  }

  _dispose(c) {
    c.dead = true;
    c.up = null;
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

  /** Per frame: recycle, reveal, upload ahead and build around sCam. `ahead` (m, before
   *  the ride starts) builds chunks at the detail they will need after that much travel. */
  update(sCam, ahead = 0) {
    this._frame++;
    if (this._upUsed) this.endFrame();   // (in case the last frame did not call it)
    const want = this._want;
    const nWant = this._fillWanted(sCam, want, ahead);
    const stamp = ++this._stamp;
    for (let k = 0; k < nWant; k++) { const idx = want[k].idx; this._wantStamp[idx] = stamp; this._wantAt[idx] = k; }
    // recycle
    this.chunks.forEach(this._recycleFn);
    this.stats.revealBytes = 0;   // (bytes revealed this frame)
    this.stats.preBytes = 0;      // (vertex bytes sent ahead this frame)
    if (this.revealing.length) {
      const pre = this._preload(this._reveal());
      this.stats.preBytes = pre;
      if (pre) this.stats.preMB += pre / 1048576;
    }
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

/** Bytes of a geometry's vertex buffers the renderer has still to send (each buffer once:
 *  attributes may share one, e.g. interleaved), or, when the module sent part of it itself,
 *  geometry.userData.revealBytes less the index (which only a draw sends). */
function vertexBytes(g) {
  const idx = g.index ? g.index.array.byteLength : 0;
  if (g.userData?.revealBytes !== undefined) return Math.max(0, g.userData.revealBytes - idx);
  let b = 0, n = 0;
  const seen = _bufs;
  for (const k in g.attributes) {
    const at = g.attributes[k], d = at.isInterleavedBufferAttribute ? at.data : at;
    const j = seen.indexOf(d);
    if (j >= 0 && j < n) continue;
    seen[n++] = d;
    b += d.array?.byteLength || 0;
  }
  for (let i = 0; i < n; i++) seen[i] = null;
  return b;
}
const _bufs = [];

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
