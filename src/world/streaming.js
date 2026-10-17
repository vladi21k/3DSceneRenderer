import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { CHUNK_LEN, VIEW_AHEAD, VIEW_BEHIND, LOD0_DIST } from '../core/config.js';

// Streams the route in CHUNK_LEN pieces around the camera. Each chunk holds one
// Object3D per chunk-building module. Builds are time-sliced (a few ms per frame),
// nearest-first; chunks behind the camera are recycled; chunks crossing LOD0_DIST
// are rebuilt at full detail and swapped in when ready (no popping gaps).
//
// Once the app is running (staged = true) a finished chunk is not shown at once: its
// programs are compiled in the background (compileAsync) and its module parts are then
// revealed a few per frame under a GPU-upload byte budget, swapping each replacement
// part with the old part of the same module, so no single frame uploads a whole chunk.

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
  }

  wanted(sCam) {
    const L = this.app.route.length, n = this.app.layout.nChunks;
    const out = [];
    const i0 = Math.floor((sCam - VIEW_BEHIND) / CHUNK_LEN), i1 = Math.floor((sCam + VIEW_AHEAD) / CHUNK_LEN);
    for (let i = i0; i <= i1; i++) {
      const idx = ((i % n) + n) % n;
      const mid = i * CHUNK_LEN + CHUNK_LEN / 2;
      const dist = Math.max(0, Math.abs(mid - sCam) - CHUNK_LEN / 2);
      out.push({ idx, dist, lod: dist < LOD0_DIST ? 0 : 1 });
    }
    void L;
    return out;
  }

  makeChunk(idx, lod) {
    const L = this.app.route.length;
    const s0 = idx * CHUNK_LEN, s1 = Math.min(L, s0 + CHUNK_LEN);
    const group = new THREE.Group();
    group.name = `chunk${idx}`;
    group.visible = false;
    return {
      index: idx, s0, s1, lod, group,
      parts: new Map(),        // module name -> Object3D
      pending: [...this.builders.map((b) => b.name)],
      ready: false,
      rng: (tag) => RNG.from(this.app.layout.seed, tag, idx),
    };
  }

  /** Synchronously build every wanted chunk within `dist` (used at start-up). */
  async prime(sCam, dist, onProgress) {
    const want = this.wanted(sCam).filter((w) => w.dist <= dist).sort((a, b) => a.dist - b.dist);
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
  upcoming(sCam = this.app.cameraS ?? this.app.startS) {
    const out = [];
    for (const w of this.wanted(sCam)) {
      const c = this.chunks.get(w.idx);
      if (!c || !c.ready || (c.next && !c.next.ready) || w.lod < c.lod) out.push({ index: w.idx, lod: w.lod, dist: w.dist });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** True when every chunk within `dist` metres of sCam is built. */
  readyAround(sCam, dist) {
    return this.wanted(sCam).filter((w) => w.dist <= dist).every((w) => this.chunks.get(w.idx)?.ready);
  }
}

/** Rough GPU upload size of an object's (non-shared) geometry and instance buffers. */
function objectBytes(obj) {
  if (obj.userData.__bytes !== undefined) return obj.userData.__bytes;
  let b = 0;
  obj.traverse((o) => {
    const g = o.geometry;
    if (g && !g.userData?.shared) {
      for (const k in g.attributes) b += g.attributes[k].array?.byteLength || 0;
      if (g.index) b += g.index.array.byteLength;
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
