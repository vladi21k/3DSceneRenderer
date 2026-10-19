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
// changed level or an entry (one chunk's instances of the family) entered or left the
// view: entries outside the view frustum are not packed at all. A long balcony
// therefore refines bay by bay as the camera approaches.
//
// Distance classes ('cls') name the limit table passed to partition(): limits[k] is the
// distance up to which level k is used; beyond the last limit the instance is not drawn.
// Entries of sets added with `angle` (railing bays: instance z axis = railing normal)
// scale the last limit by limits.angleK(|n.v|), so foreshortened bays leave earlier.
// Within a chunk's entry, instances are grouped into clusters (a stretch of a balcony
// at most CLUSTER_R long, one window's attachments: see InstanceCollector.cluster), each
// with its own bounding sphere, culled against the view every frame: a telephoto view
// down the street sees few of the balconies of the chunks it spans (those beside and
// above the camera are outside it).
// Pools never cast shadows: light stand-ins of the casters are merged per chunk into
// the module's shadow strips.
// A pool's level meshes exist from its creation (empty, hidden): the module creates its
// pools at init, so the start-up shader compile covers their programs.

const _v = new THREE.Vector3(), _b = new THREE.Box3(), _bb = new THREE.Box3();

/** Largest distance (m) of a cluster's instance origins from its first one. */
const CLUSTER_R = 2.5;

/** Extent of a geometry from the instance origin (bounding sphere centre distance plus
 *  radius), cached on the geometry. */
function reach(g) {
  if (g.userData.reach === undefined) {
    if (!g.boundingSphere) g.computeBoundingSphere();
    g.userData.reach = g.boundingSphere.center.length() + g.boundingSphere.radius;
  }
  return g.userData.reach;
}

/** Per-chunk instance lists, one per key. */
export class InstanceCollector {
  constructor() { this.sets = new Map(); this.last = null; this.cid = 0; }

  /** Starts a new culling cluster: the instances added from now on (of every key) are
   *  culled apart from those added before (a cluster also ends where its instances
   *  spread beyond CLUSTER_R). */
  cluster() { this.cid++; }

  /** levels: geometry per detail level (null = nothing drawn at that level).
   *  color: [r, g, b] or null. opts: {cls, radius, angle, thin} (first add wins; radius
   *  pads the bounding sphere, default from the level-0 geometry). */
  add(key, levels, material, matrix, color = null, opts = {}) {
    let s = this.last && this.last.key === key ? this.last : this.sets.get(key);
    if (!s) {
      s = { key, levels, material, opts, n: 0, m: new Float32Array(64 * 16), c: color ? new Float32Array(64 * 3) : null, runs: [], cid: -1, o: [0, 0, 0] };
      this.sets.set(key, s);
    }
    this.last = s;
    const e = matrix.elements, so = s.o, dx = e[12] - so[0], dy = e[13] - so[1], dz = e[14] - so[2];
    if (s.cid !== this.cid || dx * dx + dy * dy + dz * dz > CLUSTER_R * CLUSTER_R) {
      s.cid = this.cid; s.runs.push(s.n);
      so[0] = e[12]; so[1] = e[13]; so[2] = e[14];
    }
    if ((s.n + 1) * 16 > s.m.length) {
      const m = new Float32Array(s.m.length * 2); m.set(s.m); s.m = m;
      if (s.c) { const c = new Float32Array(s.c.length * 2); c.set(s.c); s.c = c; }
    }
    const m = s.m, o = s.n * 16;
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
      let gr = 0;
      for (const g of s.levels) if (g) gr = Math.max(gr, reach(g));
      const pad = s.opts.radius ?? gr;
      // clusters: runs of consecutive instances, each bounded by a sphere around its
      // instance origins padded by the scaled extent of the largest level (2 % margin)
      const nc = s.runs.length, c0 = new Uint32Array(nc + 1), cs = new Float32Array(nc * 4);
      c0.set(s.runs); c0[nc] = s.n;
      for (let k = 0; k < nc; k++) {
        const a = c0[k], b = c0[k + 1];
        let cx = 0, cy = 0, cz = 0;
        for (let i = a; i < b; i++) { cx += m[i * 16 + 12]; cy += m[i * 16 + 13]; cz += m[i * 16 + 14]; }
        cx /= b - a; cy /= b - a; cz /= b - a;
        let cr = 0;
        for (let i = a; i < b; i++) {
          const o = i * 16;
          const sc = Math.sqrt(Math.max(m[o] * m[o] + m[o + 1] * m[o + 1] + m[o + 2] * m[o + 2],
            m[o + 4] * m[o + 4] + m[o + 5] * m[o + 5] + m[o + 6] * m[o + 6], m[o + 8] * m[o + 8] + m[o + 9] * m[o + 9] + m[o + 10] * m[o + 10]));
          const dx = m[o + 12] - cx, dy = m[o + 13] - cy, dz = m[o + 14] - cz;
          cr = Math.max(cr, Math.sqrt(dx * dx + dy * dy + dz * dz) + gr * sc * 1.02);
        }
        cs[k * 4] = cx; cs[k * 4 + 1] = cy; cs[k * 4 + 2] = cz; cs[k * 4 + 3] = cr;
      }
      out.push({
        key: s.key, levels: s.levels, material: s.material, opts: s.opts, n: s.n, m, c,
        sphere: new THREE.Sphere(new THREE.Vector3(x, y, z), Math.sqrt(r) + pad * 1.25),
        lvl: new Uint8Array(s.n).fill(254), cam: null, slack: 0, vis: false,
        c0, cs, cv: new Uint8Array(nc).fill(1),
      });
    }
    this.sets.clear();
    this.last = null;
    return out;
  }
}

/** Culls the clusters of a visible entry against `frustum`; true when one changed. */
function cullClusters(e, frustum) {
  const P = frustum.planes, cs = e.cs, cv = e.cv;
  let changed = false;
  for (let k = 0; k < cv.length; k++) {
    const x = cs[k * 4], y = cs[k * 4 + 1], z = cs[k * 4 + 2], r = -cs[k * 4 + 3];
    let v = 1;
    for (let j = 0; j < 6; j++) {
      const p = P[j], n = p.normal;
      if (n.x * x + n.y * y + n.z * z + p.constant < r) { v = 0; break; }
    }
    if (v !== cv[k]) { cv[k] = v; changed = true; }
  }
  return changed;
}

/** All active entries of one key, drawn as one InstancedMesh per detail level. Every
 *  level mesh carries instance colours (white where an entry has none), so all pools of
 *  a material share one program. */
export class InstancePool {
  constructor(key, levels, material, opts, group) {
    this.key = key;
    this.levels = levels;
    this.material = material;
    this.opts = opts;
    this.cls = opts.cls || null;
    this.group = group;
    this.entries = new Set();
    this.list = [];            // the entries again, for allocation-free per-frame loops
    this.total = 0;
    this.cap = 0;
    this.meshes = levels.map(() => null);
    this.counts = new Int32Array(levels.length);
    this.arrays = levels.map(() => null);
    this.colors = levels.map(() => null);
    this.dirty = false;
    this.sphere = new THREE.Sphere();
    this._grow();
  }

  /** Adds a chunk's entry (levels are assigned on the next partition). */
  attach(e) {
    if (this.entries.has(e)) return;
    this.entries.add(e);
    this.list.push(e);
    this.total += e.n;
    e.lvl.fill(254);
    e.cam = null;
    e.vis = false;
    if (this.total > this.cap) this._grow();
    this._bounds();
    this.dirty = true;
  }

  detach(e) {
    if (!this.entries.delete(e)) return;
    this.list.splice(this.list.indexOf(e), 1);
    this.total -= e.n;
    this._bounds();
    this.dirty = true;
  }

  _bounds() {
    _b.makeEmpty();
    for (let i = 0; i < this.list.length; i++) _b.union(this.list[i].sphere.getBoundingBox(_bb));
    if (this.list.length) _b.getBoundingSphere(this.sphere);
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
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
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

  /** Culls the entries (whole chunks) and their clusters against the view `frustum`,
   *  re-partitions the entries the camera has moved away from (all with `force`) and
   *  repacks the level meshes when an entry came or went, or a cluster appeared or
   *  vanished, or an instance changed level. */
  update(cam, limits, force, frustum) {
    const list = this.list;
    for (let q = 0; q < list.length; q++) {
      const e = list[q];
      const vis = !frustum || frustum.intersectsSphere(e.sphere);
      if (vis !== e.vis) { e.vis = vis; this.dirty = true; if (vis) e.cam = null; }
      if (!vis) continue; // its levels are refreshed when it comes into view
      if (!this.cls) { if (e.lvl[0] !== 0) { e.lvl.fill(0); this.dirty = true; } }
      else if (force || !e.cam || e.cam.distanceToSquared(cam) >= e.slack * e.slack) {
        if (InstancePool.partition(e, cam, limits, this.opts.angle)) this.dirty = true;
      }
      // (an entry wholly beyond its last limit draws nothing: no cluster to cull)
      if (frustum && !e.none && cullClusters(e, frustum)) this.dirty = true;
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
    e.none = uniform === L;
    return changed;
  }

  /** Packs every entry's instances into the mesh of their level. Whole-buffer uploads
   *  (partial update ranges left stale data on the GPU for meshes culled meanwhile).
   *  Runs every few frames while the camera moves (some cluster leaves or enters the
   *  view), so it copies with plain index loops: typed-array views (subarray) for
   *  TypedArray.set were ~80 small allocations a frame, and the runs are short (a
   *  frame packs ~150 instances in ~40 runs). */
  repack() {
    this.dirty = false;
    const counts = this.counts, M = this.arrays, C = this.colors, meshes = this.meshes, list = this.list;
    for (let k = 0; k < meshes.length; k++) {
      const m = meshes[k];
      counts[k] = 0;
      M[k] = m && m.instanceMatrix.array;
      C[k] = m && m.instanceColor && m.instanceColor.array;
    }
    for (let r = 0; r < list.length; r++) {
      const e = list[r];
      if (!e.vis) continue;
      const em = e.m, ec = e.c, c0 = e.c0, cv = e.cv;
      for (let q = 0; q < cv.length; q++) {
        if (!cv[q]) continue;
        // runs of consecutive instances on one level are copied in one block
        const end = c0[q + 1], lvl = e.lvl;
        for (let i = c0[q]; i < end;) {
          const k = lvl[i];
          let i1 = i + 1;
          while (i1 < end && lvl[i1] === k) i1++;
          const a = M[k];
          if (a) {
            const j = counts[k], n = i1 - i;
            counts[k] += n;
            for (let s = i * 16, d = j * 16, se = i1 * 16; s < se;) a[d++] = em[s++];
            const ca = C[k];
            if (ec) for (let s = i * 3, d = j * 3, se = i1 * 3; s < se;) ca[d++] = ec[s++];
            else ca.fill(1, j * 3, (j + n) * 3);
          }
          i = i1;
        }
      }
    }
    for (let k = 0; k < meshes.length; k++) {
      const mesh = meshes[k];
      if (!mesh) continue;
      mesh.count = counts[k];
      mesh.visible = counts[k] > 0;
      if (!counts[k]) continue;
      mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceMatrix.addUpdateRange(0, counts[k] * 16); mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) { mesh.instanceColor.clearUpdateRanges(); mesh.instanceColor.addUpdateRange(0, counts[k] * 3); mesh.instanceColor.needsUpdate = true; }
    }
  }
}

/** Flags of every active chunk in one InstancedMesh: matrices plus a per-instance
 *  attribute (design offset in the atlas, wave phase), rebuilt when chunks come or go.
 *  A twin on a coarse grid, sharing the instance buffers, casts the shadows (the depth
 *  material moves it like the cloth) and is never drawn in the view. Both exist from the
 *  start (empty, hidden), so the start-up compiles cover their programs. */
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
    this._grow(16);
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
      mesh.visible = this.n > 0;
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
