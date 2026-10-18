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
  }

  wanted(sCam) {
    const n = this.app.layout.nChunks;
    const out = [];
    const i0 = Math.floor((sCam - VIEW_BEHIND) / CHUNK_LEN), i1 = Math.floor((sCam + this.viewAhead) / CHUNK_LEN);
    // the far field only while some builder serves it, and never wrapping onto the near range
    const i2 = this.farBuilders ? Math.min(Math.floor((sCam + this.viewFar) / CHUNK_LEN), i0 + n - 1) : i1;
    for (let i = i0; i <= i2; i++) {
      const idx = ((i % n) + n) % n;
      const mid = i * CHUNK_LEN + CHUNK_LEN / 2;
      const dist = Math.max(0, Math.abs(mid - sCam) - CHUNK_LEN / 2);
      out.push({ idx, dist, lod: i > i1 ? 2 : dist < LOD0_DIST ? 0 : 1 });
    }
    return out;
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
      pending: this.buildersFor(lod).map((b) => b.name),
      ready: false,
      rng: (tag) => RNG.from(this.app.layout.seed, tag, idx),
    };
  }

  /** Synchronously build every wanted chunk within `dist` (used at start-up); `lods`
   *  limits it to those detail levels (the far field is primed apart, it is cheap). */
  async prime(sCam, dist, onProgress, lods = null) {
    const want = this.wanted(sCam).filter((w) => w.dist <= dist && (!lods || lods.includes(w.lod))).sort((a, b) => a.dist - b.dist);
    let done = 0;
    for (const w of want) {
      let c = this.chunks.get(w.idx);
      if (!c) { c = this.makeChunk(w.idx, w.lod); this.chunks.set(w.idx, c); this.root.add(c.group); }
      while (c.pending.length) this._buildPart(c);
      this._finish(c);
      done++;
      onProgress && onProgress(done / want.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  _buildPart(c) {
    const name = c.pending.shift();
    const b = this.builders.find((x) => x.name === name);
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
      const w = this._ride[name] || (this._ride[name] = []);
      w.push(dt); if (w.length > 200) w.shift();
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
    this.revealing.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0));
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
      const b = this.builders.find((x) => x.name === name);
      try {
        if (b && b.dispose) b.dispose(obj, c, this.app);
        else disposeObject(obj);
      } catch (e) { console.error(`[world] dispose ${name}`, e); }
    }
    c.parts.clear();
    this.root.remove(c.group);
    this.stats.disposed++;
  }

  update(sCam) {
    const want = this.wanted(sCam);
    const wantSet = new Map(want.map((w) => [w.idx, w]));
    // recycle
    for (const [idx, c] of this.chunks) {
      if (!wantSet.has(idx)) { this._dispose(c); if (c.next) this._dispose(c.next); this.chunks.delete(idx); }
      else c.dist = wantSet.get(idx).dist;
    }
    this.stats.revealBytes = 0;   // (bytes revealed this frame)
    if (this.revealing.length) this._reveal();
    // create / schedule
    const queue = [];
    for (const w of want) {
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
      if (!c.ready) queue.push({ c, dist: w.dist });
      if (c.next) queue.push({ c: c.next, dist: w.dist, upgrade: c });
    }
    queue.sort((a, b) => a.dist - b.dist);
    this.stats.queue = queue.length;
    const t0 = performance.now();
    for (const q of queue) {
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
    this.stats.lastBuildMs = performance.now() - t0;
  }

  /** Chunks the streamer will build next, nearest first: [{index, lod, dist}]. Public API for
   *  modules that prefetch their own work ahead of build(). */
  upcoming(sCam = this.app.cameraS ?? this.app.startS, lookAhead = 0) {
    const out = [];
    const seen = new Set();
    // what is wanted now, plus what will be wanted (or upgraded to lod 0) within lookAhead metres of travel
    const steps = lookAhead > 0 ? [0, lookAhead] : [0];
    for (const ahead of steps) {
      for (const w of this.wanted(sCam + ahead)) {
        if (w.lod > 1) continue;   // the far field is core's own (no module prefetches it)
        const key = `${w.idx}:${w.lod}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = this.chunks.get(w.idx);
        if (!c || !c.ready || (c.next && !c.next.ready) || w.lod < c.lod) out.push({ index: w.idx, lod: w.lod, dist: w.dist + ahead, future: ahead > 0 });
      }
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** Ride-time chunk build statistics per module: {name: {n, p50, p95, max}} (ms). */
  rideBuildStats() {
    const out = {};
    for (const [name, w] of Object.entries(this._ride)) {
      if (!w.length) continue;
      const a = [...w].sort((x, y) => x - y), q = (f) => +a[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(2);
      out[name] = { n: a.length, p50: q(0.5), p95: q(0.95), max: +a[a.length - 1].toFixed(2) };
    }
    return out;
  }

  /** True when every chunk within `dist` metres of sCam is built. */
  readyAround(sCam, dist) {
    return this.wanted(sCam).filter((w) => w.dist <= dist && w.lod < 2).every((w) => this.chunks.get(w.idx)?.ready);
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
