import * as THREE from 'three';
import { isThinCaster, hasShadowHooks } from './sunShadow.js';

// Static shadow-caster batching. A depth pass doesn't care about materials: every
// opaque mesh draws with the same depth material. The streamed chunks hold several
// casting meshes per module (one per material), each drawn once per cascade, so the
// sun's depth passes cost hundreds of draw calls. Once a chunk is built and shown, its
// static casters are merged here (in the background, a slice per frame) into depth-only
// proxies per shadow side and thin/solid class; the cascade frustums then skip the
// originals and draw the proxies instead.
//
// Two sets of proxies share each merged vertex buffer. The near cascades (fine texels,
// short depth slices) draw cell proxies: the chunk's triangles sorted into ~13 m cells
// along the street, so a cascade only draws the cells whose shadows can reach its slice.
// The far cascades draw one coarse proxy per chunk without the triangles that are
// smaller than their texels (mouldings, balusters, frames: about half the count and
// under 1% of the shadow area); thin casters never reach them anyway.
//
// Proxies never draw in the main pass: their geometry's bounding sphere lies far
// below the street, so the camera frustum culls them, and the cascade frustums test
// the true sphere kept in userData.shadowSphere.
//
// Only casters whose depth pass is plain qualify (no custom depth material or shadow
// hooks, no alpha test, displacement, clipping, morphs or skinning, not instanced).
// Every frame the merged sources are checked (visibility, castShadow, material,
// geometry, vertex data; transforms on a rolling subset): a source that changes is
// marked volatile and its proxy is dropped and rebuilt without it, so the originals
// cast until then and nothing ever goes missing.

const FAR_SPHERE = new THREE.Sphere(new THREE.Vector3(0, -1e7, 0), 1e-3);
const SIDE_FLIP = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
const MIN_SOURCES = 2;          // a group with fewer sources keeps its originals
const MATRIX_CHECKS = 96;       // source transforms compared per frame (rolling)
const CELL_LEN = 13.5;          // near-cascade cell length along the street (m)
const MAX_CELLS = 6;
const FAR_MIN_EDGE = 0.35;      // far cascades skip triangles whose longest edge is shorter (m)

export class ShadowBatcher {
  constructor(app, shadow, { budgetMs = 1.0 } = {}) {
    this.app = app;
    this.shadow = shadow;
    this.budgetMs = budgetMs;
    this._warm = null;
    this.root = new THREE.Group();
    this.root.name = 'env:shadowProxies';
    this.root.matrixAutoUpdate = false;
    app.scene.add(this.root);
    this.records = new Map();     // chunk group -> record
    this.covered = new WeakMap(); // source mesh -> active record
    this.volatile = new WeakSet();
    this.materials = new Map();   // effective shadow side -> proxy material
    this.job = null;
    this.frame = 0;
    this._mcursor = 0;
    this.stats = { proxies: 0, sources: 0, built: 0, dropped: 0 };
    this._warmup();
  }

  /** True when an active proxy draws this mesh's shadow. */
  covers(object) {
    const r = this.covered.get(object);
    return !!r && r.active;
  }

  update() {
    this.frame++;
    this._warmup();
    const world = this.app.world;
    if (!world || !world.chunks) return;

    // forget chunks that were recycled
    for (const [group, rec] of this.records) {
      if (!group.parent) { this._drop(rec, false); this.records.delete(group); }
    }
    // new, finished chunks
    for (const c of world.chunks.values()) {
      if (!c.ready || !c.group.visible || !c.group.parent) continue;
      if (!this.records.has(c.group)) this.records.set(c.group, { group: c.group, s: 0.5 * (c.s0 + c.s1), active: false, proxies: [], sources: [], retryAt: this.frame + 2 });
    }

    this._validate();

    // build (or rebuild) one chunk at a time, within the frame budget
    const t0 = performance.now();
    if (!this.job) {
      for (const rec of this.records.values()) {
        if (rec.active || rec.building || this.frame < rec.retryAt) continue;
        this.job = this._plan(rec);
        break;
      }
    }
    if (this.job) this._work(t0);
  }

  /**
   * The proxies are plain meshes drawn with the renderer's depth material in each shadow
   * side, combinations the originals may not use. An empty stand-in per side carries
   * those programs from env init through the start-up compile (with the rest of the
   * scene, in parallel) and the shadow pass's warm-up draw, so none compiles mid-ride.
   */
  _warmup() {
    const sh = this.shadow;
    if (sh && sh.warmup && !this._warm) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      geo.boundingSphere = FAR_SPHERE.clone();
      this._warm = [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide].map((side) => {
        const m = new THREE.Mesh(geo, this._material(side));
        m.castShadow = true;
        m.matrixAutoUpdate = false;
        this.root.add(m);
        return m;
      });
    } else if (this._warm && this._warm.length && !(sh && sh.warmup)) {
      for (const m of this._warm) this.root.remove(m);
      this._warm[0].geometry.dispose();
      this._warm.length = 0;
    }
  }

  // ---------------------------------------------------------------- planning

  _eligible(o) {
    if (!o.isMesh || o.isInstancedMesh || o.isBatchedMesh || o.isSkinnedMesh) return false;
    if (!o.castShadow || this.volatile.has(o) || o.userData.dynamicCaster || o.userData.shadowProxy) return false;
    if (o.customDepthMaterial !== undefined || hasShadowHooks(o) || (o.layers.mask & 1) === 0) return false;
    const m = o.material, g = o.geometry;
    if (!m || Array.isArray(m) || !m.visible || m.wireframe || m.alphaTest > 0 || m.displacementMap || m.alphaToCoverage) return false;
    if (m.clippingPlanes && m.clippingPlanes.length) return false;
    if (!g || !g.attributes.position || (g.morphAttributes.position && g.morphAttributes.position.length)) return false;
    if (g.drawRange.start !== 0 || g.drawRange.count !== Infinity) return false;
    return true;
  }

  _plan(rec) {
    rec.building = true;
    const groups = new Map();
    const visit = (o) => {
      if (!o.visible) return;
      if (this._eligible(o)) {
        const m = o.material;
        const side = m.shadowSide ?? SIDE_FLIP[m.side];
        const thin = isThinCaster(o);
        const key = `${side}|${thin ? 1 : 0}`;
        let g = groups.get(key);
        if (!g) groups.set(key, g = { side, thin, sources: [], verts: 0, idx: 0 });
        const geo = o.geometry;
        g.sources.push(o);
        g.verts += geo.attributes.position.count;
        g.idx += geo.index ? geo.index.count : geo.attributes.position.count;
      }
      for (const ch of o.children) visit(ch);
    };
    visit(rec.group);
    const parts = [];
    for (const g of groups.values()) {
      if (g.sources.length < MIN_SOURCES) continue;
      parts.push({
        ...g,
        pos: new Float32Array(g.verts * 3),
        index: g.verts > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx),
        vOff: 0, iOff: 0, next: 0, snap: [], done: false,
      });
    }
    if (!parts.length) { rec.building = false; rec.retryAt = Infinity; return null; }
    return { rec, parts, p: 0 };
  }

  // ---------------------------------------------------------------- merging

  _work(t0) {
    const job = this.job;
    while (job.p < job.parts.length) {
      const part = job.parts[job.p];
      while (part.next < part.sources.length) {
        const o = part.sources[part.next++];
        part.snap.push(this._append(part, o));
        if (performance.now() - t0 > this.budgetMs) return;
      }
      if (!part.done) {
        this._split(part, job.rec);
        part.done = true;
        if (performance.now() - t0 > this.budgetMs) { job.p++; return; }
      }
      job.p++;
    }
    this.job = null;
    this._activate(job);
  }

  /**
   * Sort a merged part's triangles into cells along the street (near cascades) and pick
   * the triangles large enough for the far cascades. Both index the same vertices.
   */
  _split(part, rec) {
    const pos = part.pos, idx = part.index, nTri = part.iOff / 3;
    const smp = this.app.route.sample(rec.s);
    let tx = smp.tan.x, tz = smp.tan.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const ox = smp.pos.x, oz = smp.pos.z;
    const u = new Float32Array(nTri);
    let umin = Infinity, umax = -Infinity;
    const far = part.thin ? null : new idx.constructor(idx.length);
    let nFar = 0;
    const m2 = FAR_MIN_EDGE * FAR_MIN_EDGE;
    for (let t = 0; t < nTri; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      const v = ((pos[a] + pos[b] + pos[c]) / 3 - ox) * tx + ((pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3 - oz) * tz;
      u[t] = v;
      if (v < umin) umin = v;
      if (v > umax && v < Infinity) umax = v;
      if (far) {
        const e1 = (pos[b] - pos[a]) ** 2 + (pos[b + 1] - pos[a + 1]) ** 2 + (pos[b + 2] - pos[a + 2]) ** 2;
        const e2 = (pos[c] - pos[a]) ** 2 + (pos[c + 1] - pos[a + 1]) ** 2 + (pos[c + 2] - pos[a + 2]) ** 2;
        const e3 = (pos[c] - pos[b]) ** 2 + (pos[c + 1] - pos[b + 1]) ** 2 + (pos[c + 2] - pos[b + 2]) ** 2;
        if (e1 >= m2 || e2 >= m2 || e3 >= m2) { far[nFar++] = idx[t * 3]; far[nFar++] = idx[t * 3 + 1]; far[nFar++] = idx[t * 3 + 2]; }
      }
    }
    // (a source with non-finite vertices leaves the range degenerate: one cell)
    const span = umax - umin;
    const n = span > 0 && span < Infinity ? Math.max(1, Math.min(MAX_CELLS, Math.ceil(span / CELL_LEN))) : 1;
    const len = Math.max((umax - umin) / n, 1e-3);
    const cell = new Uint8Array(nTri), count = new Uint32Array(n);
    for (let t = 0; t < nTri; t++) {
      const k = Math.min(n - 1, Math.max(0, Math.floor((u[t] - umin) / len))) || 0;
      cell[t] = k; count[k]++;
    }
    const start = new Uint32Array(n);
    for (let k = 1; k < n; k++) start[k] = start[k - 1] + count[k - 1];
    const near = new idx.constructor(nTri * 3), w = Uint32Array.from(start);
    const box = Array.from({ length: n }, () => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let t = 0; t < nTri; t++) {
      const k = cell[t], o = w[k]++ * 3, bx = box[k];
      for (let j = 0; j < 3; j++) {
        const vi = idx[t * 3 + j], p = vi * 3;
        near[o + j] = vi;
        if (pos[p] < bx[0]) bx[0] = pos[p]; if (pos[p] > bx[3]) bx[3] = pos[p];
        if (pos[p + 1] < bx[1]) bx[1] = pos[p + 1]; if (pos[p + 1] > bx[4]) bx[4] = pos[p + 1];
        if (pos[p + 2] < bx[2]) bx[2] = pos[p + 2]; if (pos[p + 2] > bx[5]) bx[5] = pos[p + 2];
      }
    }
    part.cells = [];
    for (let k = 0; k < n; k++) {
      if (!count[k]) continue;
      const bx = box[k], sphere = new THREE.Sphere();
      sphere.center.set((bx[0] + bx[3]) / 2, (bx[1] + bx[4]) / 2, (bx[2] + bx[5]) / 2);
      sphere.radius = 0.5 * Math.hypot(bx[3] - bx[0], bx[4] - bx[1], bx[5] - bx[2]);
      part.cells.push({ start: start[k] * 3, count: count[k] * 3, sphere });
    }
    part.near = near;
    part.far = far && nFar ? far.slice(0, nFar) : null;
    if (part.far) {
      const bx = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let i = 0; i < nFar; i++) {
        const p = part.far[i] * 3;
        for (let j = 0; j < 3; j++) { const v = pos[p + j]; if (v < bx[j]) bx[j] = v; if (v > bx[j + 3]) bx[j + 3] = v; }
      }
      part.farSphere = new THREE.Sphere(new THREE.Vector3((bx[0] + bx[3]) / 2, (bx[1] + bx[4]) / 2, (bx[2] + bx[5]) / 2),
        0.5 * Math.hypot(bx[3] - bx[0], bx[4] - bx[1], bx[5] - bx[2]));
    }
  }

  _append(part, o) {
    const g = o.geometry, P = g.attributes.position, n = P.count;
    o.updateWorldMatrix(true, false);
    const e = o.matrixWorld.elements, out = part.pos, base = part.vOff;
    let k = base * 3;
    if (P.isInterleavedBufferAttribute) {
      for (let i = 0; i < n; i++, k += 3) {
        const x = P.getX(i), y = P.getY(i), z = P.getZ(i);
        out[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
        out[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        out[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
    } else {
      const a = P.array, s = P.itemSize;
      for (let i = 0, j = 0; i < n; i++, j += s, k += 3) {
        const x = a[j], y = a[j + 1], z = a[j + 2];
        out[k] = e[0] * x + e[4] * y + e[8] * z + e[12];
        out[k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        out[k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
    }
    const idx = part.index;
    let w = part.iOff;
    if (g.index) {
      const ia = g.index.array;
      for (let i = 0, m = g.index.count; i < m; i++) idx[w++] = ia[i] + base;
    } else {
      for (let i = 0; i < n; i++) idx[w++] = base + i;
    }
    part.iOff = w;
    part.vOff += n;
    // what the proxy assumes about this source (checked every frame while active)
    return { o, material: o.material, geometry: g, version: P.version, m: Float64Array.from(e) };
  }

  _material(side) {
    let m = this.materials.get(side);
    if (!m) {
      m = new THREE.MeshDepthMaterial({ side });
      m.shadowSide = side;
      m.name = 'env.shadowProxy';
      this.materials.set(side, m);
    }
    return m;
  }

  _activate(job) {
    const { rec } = job;
    rec.building = false;
    if (!rec.group.parent) return;
    // the sources must still be as merged (they may have changed while the job ran)
    for (const part of job.parts) {
      for (const s of part.snap) {
        if (!this._same(s, rec.group, true)) {
          this.volatile.add(s.o);
          rec.retryAt = this.frame + 30;
          return;
        }
      }
    }
    for (const part of job.parts) {
      const position = new THREE.BufferAttribute(part.pos, 3);
      const near = new THREE.BufferAttribute(part.near, 1);
      for (const c of part.cells) this._proxy(rec, part, position, near, c.start, c.count, c.sphere, false);
      if (part.far) this._proxy(rec, part, position, new THREE.BufferAttribute(part.far, 1), 0, part.far.length, part.farSphere, true);
      for (const s of part.snap) { rec.sources.push(s); this.covered.set(s.o, rec); }
    }
    rec.active = true;
    this.stats.built++;
    this._count();
  }

  /** One depth-only proxy: a draw range of a merged part, for the near or the far cascades. */
  _proxy(rec, part, position, index, start, count, sphere, far) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', position);
    geo.setIndex(index);
    geo.setDrawRange(start, count);
    geo.boundingSphere = FAR_SPHERE.clone();   // culled by the camera, see above
    const mesh = new THREE.Mesh(geo, this._material(part.side));
    mesh.name = `shadowProxy:${rec.group.name}`;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.userData.shadowProxy = rec;
    mesh.userData.shadowSphere = sphere;
    mesh.userData.thinCaster = part.thin;
    mesh.userData.shadowFar = far;
    this.root.add(mesh);
    rec.proxies.push(mesh);
  }

  // ---------------------------------------------------------------- validation

  /** Is a merged source still as it was? (visible up to its chunk, casting, same data) */
  _same(s, group, matrix) {
    const o = s.o;
    if (!o.castShadow || o.material !== s.material || o.geometry !== s.geometry) return false;
    if (o.geometry.attributes.position.version !== s.version || !s.material.visible) return false;
    for (let p = o; p !== group; p = p.parent) if (!p || !p.visible) return false;
    if (matrix) {
      const e = o.matrixWorld.elements, m = s.m;
      for (let i = 0; i < 16; i++) if (Math.abs(e[i] - m[i]) > 1e-4) return false;
    }
    return true;
  }

  _validate() {
    let checks = MATRIX_CHECKS;
    for (const rec of this.records.values()) {
      if (!rec.active) continue;
      if (!rec.group.visible) { this._drop(rec, true); continue; }
      const n = rec.sources.length;
      for (let i = 0; i < n; i++) {
        const s = rec.sources[i];
        const mat = checks > 0 && ((this._mcursor + i) % 8 === 0);
        if (mat) checks--;
        if (!this._same(s, rec.group, mat)) {
          this.volatile.add(s.o);
          this._drop(rec, true);
          break;
        }
      }
    }
    this._mcursor = (this._mcursor + 1) % 8;
  }

  _drop(rec, retry) {
    if (this.job && this.job.rec === rec) this.job = null;
    for (const s of rec.sources) if (this.covered.get(s.o) === rec) this.covered.delete(s.o);
    for (const p of rec.proxies) { this.root.remove(p); p.geometry.dispose(); }
    rec.sources = [];
    rec.proxies = [];
    if (rec.active) this.stats.dropped++;
    rec.active = false;
    rec.building = false;
    rec.retryAt = retry ? this.frame + 30 : Infinity;
    this._count();
  }

  _count() {
    let p = 0, s = 0;
    for (const r of this.records.values()) { p += r.proxies.length; s += r.sources.length; }
    this.stats.proxies = p; this.stats.sources = s;
  }
}
