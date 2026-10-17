import * as THREE from 'three';
import { shadowOnly } from './strip.js';

// Module-wide instancing with per-INSTANCE level of detail.
//
// A chunk build collects its instances per key (geometry family + material) into
// entries (InstanceCollector). Each key has one pool for the whole street holding the
// active entries of every chunk, with one InstancedMesh per detail level: a family costs
// one draw per level in use, however many chunks it spans. Every instance (a railing
// bay, a console, a plant…) is assigned to exactly one level by its own distance to the
// camera; an entry is revisited once the camera has moved further than the slack its
// last partition left, and the level meshes are repacked only when some instance
// changed level. A long balcony therefore refines bay by bay as the camera approaches.
//
// Distance classes ('cls') name the limit table passed to partition(): limits[k] is the
// distance up to which level k is used; beyond the last limit the instance is not drawn.
// Entries of sets added with `angle` (railing bays: instance z axis = railing normal)
// scale the last limit by limits.angleK(|n.v|), so foreshortened bays leave earlier.
// Pools never cast shadows: light stand-ins of the casters are merged per chunk into
// the module's shadow strips.

const _v = new THREE.Vector3(), _b = new THREE.Box3(), _bb = new THREE.Box3();

/** Per-chunk instance lists, one per key. */
export class InstanceCollector {
  constructor() { this.sets = new Map(); this.last = null; }

  /** levels: geometry per detail level (null = nothing drawn at that level).
   *  color: [r, g, b] or null. opts: {cls, radius, angle, thin} (first add wins; radius
   *  pads the bounding sphere, default from the level-0 geometry). */
  add(key, levels, material, matrix, color = null, opts = {}) {
    let s = this.last && this.last.key === key ? this.last : this.sets.get(key);
    if (!s) {
      s = { key, levels, material, opts, n: 0, m: new Float32Array(64 * 16), c: color ? new Float32Array(64 * 3) : null };
      this.sets.set(key, s);
    }
    this.last = s;
    if ((s.n + 1) * 16 > s.m.length) {
      const m = new Float32Array(s.m.length * 2); m.set(s.m); s.m = m;
      if (s.c) { const c = new Float32Array(s.c.length * 2); c.set(s.c); s.c = c; }
    }
    const e = matrix.elements, m = s.m, o = s.n * 16;
    for (let k = 0; k < 16; k++) m[o + k] = e[k];
    if (s.c) { s.c[s.n * 3] = color[0]; s.c[s.n * 3 + 1] = color[1]; s.c[s.n * 3 + 2] = color[2]; }
    s.n++;
  }

  /** The collected entries (trimmed, with bounding spheres); empties the collector. */
  entries() {
    const out = [];
    for (const s of this.sets.values()) {
      if (!s.n) continue;
      const m = s.m.slice(0, s.n * 16), c = s.c ? s.c.slice(0, s.n * 3) : null;
      // bounding sphere of the instance origins, padded by the geometry extent
      let x = 0, y = 0, z = 0;
      for (let i = 0; i < s.n; i++) { x += m[i * 16 + 12]; y += m[i * 16 + 13]; z += m[i * 16 + 14]; }
      x /= s.n; y /= s.n; z /= s.n;
      let r = 0;
      for (let i = 0; i < s.n; i++) {
        const dx = m[i * 16 + 12] - x, dy = m[i * 16 + 13] - y, dz = m[i * 16 + 14] - z;
        r = Math.max(r, dx * dx + dy * dy + dz * dz);
      }
      const g0 = s.levels.find(Boolean);
      if (!g0.boundingSphere) g0.computeBoundingSphere();
      const pad = s.opts.radius ?? g0.boundingSphere.center.length() + g0.boundingSphere.radius;
      out.push({
        key: s.key, levels: s.levels, material: s.material, opts: s.opts, n: s.n, m, c,
        sphere: new THREE.Sphere(new THREE.Vector3(x, y, z), Math.sqrt(r) + pad * 1.25),
        lvl: new Uint8Array(s.n).fill(254), cam: null, slack: 0, vis: false,
      });
    }
    this.sets.clear();
    this.last = null;
    return out;
  }
}

/** All active entries of one key, drawn as one InstancedMesh per detail level. */
export class InstancePool {
  constructor(key, levels, material, opts, group) {
    this.key = key;
    this.levels = levels;
    this.material = material;
    this.opts = opts;
    this.cls = opts.cls || null;
    this.colors = false;
    this.group = group;
    this.entries = new Set();
    this.total = 0;
    this.cap = 0;
    this.meshes = levels.map(() => null);
    this.dirty = false;
    this.sphere = new THREE.Sphere();
  }

  /** Adds a chunk's entry (levels are assigned on the next partition). */
  attach(e) {
    this.entries.add(e);
    this.total += e.n;
    if (e.c) this.colors = true;
    e.lvl.fill(254);
    e.cam = null;
    e.vis = false;
    if (this.total > this.cap) this._grow();
    this._bounds();
    this.dirty = true;
  }

  detach(e) {
    if (!this.entries.delete(e)) return;
    this.total -= e.n;
    this._bounds();
    this.dirty = true;
  }

  _bounds() {
    _b.makeEmpty();
    for (const e of this.entries) _b.union(e.sphere.getBoundingBox(_bb));
    if (this.entries.size) _b.getBoundingSphere(this.sphere);
  }

  /** (Re)creates the level meshes with room for the current total (and some). */
  _grow() {
    const cap = Math.max(64, Math.ceil(this.total * 1.5));
    this.meshes = this.levels.map((geo, k) => {
      const old = this.meshes[k];
      if (old) { this.group.remove(old); old.dispose(); }
      if (!geo) return null;
      // created empty, then given buffers of the full capacity (skips the identity fill)
      const mesh = new THREE.InstancedMesh(geo, this.material, 0);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      if (this.colors) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.count = 0;
      mesh.visible = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.userData.thinCaster = !!this.opts.thin; // (should it ever cast)
      mesh.boundingSphere = this.sphere;
      mesh.name = `ironwork:${this.key}:${k}`;
      this.group.add(mesh);
      return mesh;
    });
    this.cap = cap;
  }

  /** Culls the entries (whole chunks) against the view `frustum`, re-partitions those the
   *  camera has moved away from (all with `force`) and repacks the level meshes when an
   *  entry came, went, appeared or vanished, or an instance changed level. */
  update(cam, limits, force, frustum) {
    for (const e of this.entries) {
      const vis = !frustum || frustum.intersectsSphere(e.sphere);
      if (vis !== e.vis) { e.vis = vis; this.dirty = true; if (vis) e.cam = null; }
      if (!vis) continue; // its levels are refreshed when it comes into view
      if (!this.cls) { if (e.lvl[0] !== 0) { e.lvl.fill(0); this.dirty = true; } continue; }
      if (force || !e.cam || e.cam.distanceToSquared(cam) >= e.slack * e.slack) {
        if (InstancePool.partition(e, cam, limits, this.opts.angle)) this.dirty = true;
      }
    }
    if (this.dirty) this.repack();
  }

  /** Assigns every instance of entry `e` to a level by its distance from `cam`; returns
   *  true when one changed. Records the slack: how far the camera can move before any
   *  instance can change level. */
  static partition(e, cam, limits, angle) {
    const L = limits.length, m = e.m;
    const ak = angle ? limits.angleK : null;
    // whole entry beyond the last limit (or inside the first): skip the per-instance pass
    const dc = _v.copy(e.sphere.center).distanceTo(cam);
    let uniform = -1, slack = Infinity;
    if (dc - e.sphere.radius >= limits[L - 1]) { uniform = L; slack = dc - e.sphere.radius - limits[L - 1]; }
    else if (dc + e.sphere.radius < limits[0]) { uniform = 0; slack = limits[0] - dc - e.sphere.radius; }
    let changed = false;
    for (let i = 0; i < e.n; i++) {
      let k = uniform;
      if (k < 0) {
        const dx = m[i * 16 + 12] - cam.x, dy = m[i * 16 + 13] - cam.y, dz = m[i * 16 + 14] - cam.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        k = 0;
        while (k < L && d >= limits[k]) k++;
        const gap = Math.min(k > 0 ? d - limits[k - 1] : Infinity, k < L ? limits[k] - d : Infinity);
        if (gap < slack) slack = gap;
        if (ak && k < L) {
          // 5 % margin: the shaders fade by the angle at each vertex, not at the origin
          const nv = Math.abs(m[i * 16 + 8] * dx + m[i * 16 + 9] * dy + m[i * 16 + 10] * dz) / (d || 1);
          if (d >= limits[L - 1] * Math.min(1, ak(nv) * 1.05)) k = L;
          // the view angle changes as the camera moves: revisit often
          if (slack > 0.5) slack = 0.5;
        }
      }
      if (k !== e.lvl[i]) { e.lvl[i] = k; changed = true; }
    }
    (e.cam ||= new THREE.Vector3()).copy(cam);
    e.slack = slack;
    return changed;
  }

  /** Packs every entry's instances into the mesh of their level. Whole-buffer uploads
   *  (partial update ranges left stale data on the GPU for meshes culled meanwhile). */
  repack() {
    this.dirty = false;
    const counts = this.meshes.map(() => 0);
    const M = this.meshes.map((m) => m && m.instanceMatrix.array), C = this.meshes.map((m) => m && m.instanceColor && m.instanceColor.array);
    for (const e of this.entries) {
      if (!e.vis) continue;
      const em = e.m, ec = e.c;
      for (let i = 0; i < e.n; i++) {
        const k = e.lvl[i], a = M[k];
        if (!a) continue;
        const j = counts[k]++;
        for (let q = 0, o = j * 16, p = i * 16; q < 16; q++) a[o + q] = em[p + q];
        const c = C[k];
        if (c) {
          if (ec) { c[j * 3] = ec[i * 3]; c[j * 3 + 1] = ec[i * 3 + 1]; c[j * 3 + 2] = ec[i * 3 + 2]; }
          else { c[j * 3] = c[j * 3 + 1] = c[j * 3 + 2] = 1; }
        }
      }
    }
    this.meshes.forEach((mesh, k) => {
      if (!mesh) return;
      mesh.count = counts[k];
      mesh.visible = counts[k] > 0;
      if (!counts[k]) return;
      mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, counts[k] * 16); mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) { mesh.instanceColor.clearUpdateRanges(); mesh.instanceColor.addUpdateRange(0, counts[k] * 3); mesh.instanceColor.needsUpdate = true; }
    });
  }
}

/** Flags of every active chunk in one InstancedMesh: matrices plus a per-instance
 *  attribute (design offset in the atlas, wave phase), rebuilt when chunks come or go.
 *  A twin on a coarse grid, sharing the instance buffers, casts the shadows (the depth
 *  material moves it like the cloth) and is never drawn in the view. */
export class FlagPool {
  constructor(geometry, shadowGeometry, material, depthMaterial, group, scene) {
    this.scene = scene;
    this.src = geometry;
    this.srcShadow = shadowGeometry;
    this.material = material;
    this.depthMaterial = depthMaterial;
    this.group = group;
    this.entries = new Set();
    this.mesh = null;
    this.shadow = null;
    this.n = 0;
    this.cap = 0;
    this.dirty = false;
  }

  attach(e) { this.entries.add(e); this.dirty = true; }
  detach(e) { if (this.entries.delete(e)) this.dirty = true; }

  /** Rebuilds the instance buffers if entries changed. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    let n = 0;
    for (const e of this.entries) n += e.n;
    if (n > this.cap) this._grow(Math.max(16, Math.ceil(n * 1.5)));
    if (!this.mesh) return;
    const M = this.mesh.instanceMatrix.array, A = this.mesh.geometry.attributes.aFlag.array;
    let j = 0;
    _b.makeEmpty();
    for (const e of this.entries) {
      M.set(e.m, j * 16);
      A.set(e.a, j * 3);
      j += e.n;
      _b.union(e.box);
    }
    this.n = n;
    this.mesh.count = this.shadow.count = n;
    this.mesh.visible = this.shadow.visible = n > 0;
    // the cloth hangs and moves up to ~1.5 m from the hoist: pad the culling sphere
    if (n) { _b.getBoundingSphere(this.mesh.boundingSphere); this.mesh.boundingSphere.radius += 1.8; }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.attributes.aFlag.needsUpdate = true;
  }

  _grow(cap) {
    for (const m of [this.mesh, this.shadow]) if (m) { this.group.remove(m); m.geometry.dispose(); m.dispose(); }
    const matrices = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
    const aFlag = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const sphere = new THREE.Sphere();
    const make = (src, name) => {
      // own geometry over the shared grid: it carries this pool's per-instance attribute
      const geo = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv']) geo.setAttribute(k, src.attributes[k]);
      geo.setIndex(src.index);
      geo.setAttribute('aFlag', aFlag);
      const mesh = new THREE.InstancedMesh(geo, this.material, 0);
      mesh.instanceMatrix = matrices;
      mesh.boundingSphere = sphere;
      mesh.customDepthMaterial = this.depthMaterial;
      mesh.name = name;
      this.group.add(mesh);
      return mesh;
    };
    this.mesh = make(this.src, 'ironwork:flags');
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.shadow = make(this.srcShadow, 'ironwork:flagShadow');
    this.shadow.castShadow = true;
    this.shadow.receiveShadow = false;
    shadowOnly(this.shadow, this.scene);
    this.cap = cap;
  }
}
