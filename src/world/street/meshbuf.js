import * as THREE from 'three';

// Minimal growable vertex buffer: chunk builders write vertices straight into typed
// arrays (no per-geometry merge step), one buffer per material.
//
// Optional per-vertex cut attribute (aStCut, vec4): crossover surfaces discard the
// fragments that lie inside another rail's opening (see shading.js patchCut).
//
// Buffers are scratch space recycled through a small pool: a chunk build borrows them,
// and BufSet.build() copies the written range into exact-size arrays for the
// geometry, then returns them. Steady-state builds therefore allocate only what the
// GPU upload needs (no zero-filled oversized arrays, no growth copies, less GC).
// Each buffer tracks the bounding box of what it holds as vertices are written, so
// every mesh gets tight culling bounds without a pass over its vertices.

export class MeshBuf {
  constructor({ color = false, cut = false, cap = 1024 } = {}) {
    this.hasColor = color;
    this.hasCut = cut;
    this.reset();
    this._alloc(cap, cap * 6);
  }

  _alloc(vc, ic) {
    const grow = (old, size) => { const a = new Float32Array(size); if (old) a.set(old.subarray(0, Math.min(old.length, size))); return a; };
    if (vc !== this.cap) {
      this.pos = grow(this.pos, vc * 3);
      this.nor = grow(this.nor, vc * 3);
      this.uv = grow(this.uv, vc * 2);
      if (this.hasColor) this.col = grow(this.col, vc * 3);
      if (this.hasCut) this.cut = grow(this.cut, vc * 4);
      this.cap = vc;
    }
    if (ic !== this.icap) {
      const idx = new Uint32Array(ic);
      if (this.idx) idx.set(this.idx.subarray(0, this.ni));
      this.idx = idx;
      this.icap = ic;
    }
  }

  reset() {
    this.n = 0; this.ni = 0;
    this.x0 = this.y0 = this.z0 = Infinity; this.x1 = this.y1 = this.z1 = -Infinity;
    return this;
  }

  /** Make room for `nv` more vertices and `nIdx` more indices. */
  reserve(nv, nIdx = nv * 6) {
    if (this.n + nv > this.cap) this._alloc(Math.max(this.cap * 2, this.n + nv), this.icap);
    if (this.ni + nIdx > this.icap) this._alloc(this.cap, Math.max(this.icap * 2, this.ni + nIdx));
  }

  /** Append a vertex, returns its index. */
  v(x, y, z, nx, ny, nz, u, w, r = 1, g = 1, b = 1) {
    if (this.n >= this.cap) this._alloc(this.cap * 2, this.icap);
    const i = this.n++, i3 = i * 3, i2 = i * 2;
    const p = this.pos, n = this.nor;
    if (x < this.x0) this.x0 = x; if (x > this.x1) this.x1 = x;
    if (y < this.y0) this.y0 = y; if (y > this.y1) this.y1 = y;
    if (z < this.z0) this.z0 = z; if (z > this.z1) this.z1 = z;
    p[i3] = x; p[i3 + 1] = y; p[i3 + 2] = z;
    n[i3] = nx; n[i3 + 1] = ny; n[i3 + 2] = nz;
    this.uv[i2] = u; this.uv[i2 + 1] = w;
    if (this.hasColor) { const c = this.col; c[i3] = r; c[i3 + 1] = g; c[i3 + 2] = b; }
    return i;
  }

  /** Cut attribute of vertex i. */
  setCut(i, a, b, c, d) {
    const k = i * 4, x = this.cut;
    x[k] = a; x[k + 1] = b; x[k + 2] = c; x[k + 3] = d;
  }

  tri(a, b, c) {
    if (this.ni + 3 > this.icap) this._alloc(this.cap, this.icap * 2);
    const x = this.idx;
    x[this.ni++] = a; x[this.ni++] = b; x[this.ni++] = c;
  }

  /** Quad a-b-c-d (counter-clockwise seen from the front). */
  quad(a, b, c, d) {
    if (this.ni + 6 > this.icap) this._alloc(this.cap, this.icap * 2);
    const x = this.idx;
    let k = this.ni;
    x[k++] = a; x[k++] = b; x[k++] = c;
    x[k++] = a; x[k++] = c; x[k++] = d;
    this.ni = k;
  }

  get empty() { return this.ni === 0; }

  /** BufferGeometry with exact-size copies of the written range, bounded by the box of
   *  the written vertices. */
  geometry() {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    if (this.hasColor) g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3));
    if (this.hasCut) g.setAttribute('aStCut', new THREE.BufferAttribute(this.cut.slice(0, n * 4), 4));
    const src = this.idx.subarray(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(n <= 65535 ? new Uint16Array(src) : src.slice(), 1));
    const box = new THREE.Box3(new THREE.Vector3(this.x0, this.y0, this.z0), new THREE.Vector3(this.x1, this.y1, this.z1));
    g.boundingBox = box;
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    return g;
  }
}

// scratch buffers waiting to be borrowed, by attribute layout (colour, cut)
const POOL = [[], [], [], []];
const layout = (color, cut) => (color ? 1 : 0) + (cut ? 2 : 0);

function borrow(color, cut, cap) {
  const list = POOL[layout(color, cut)];
  return list.length ? list.pop().reset() : new MeshBuf({ color, cut, cap });
}

function giveBack(b) {
  const list = POOL[layout(b.hasColor, b.hasCut)];
  if (list.length < 48) list.push(b.reset());
}

/** One MeshBuf per material; build() adds their meshes to a group. */
export class BufSet {
  constructor() { this.map = new Map(); }
  /** Buffer for `material`; cap pre-sizes it (vertices) when it is created. A material
   *  patched with patchCut gets a buffer with the cut attribute. */
  get(material, color = false, cap = 1024) {
    let b = this.map.get(material);
    if (!b) {
      b = borrow(color, !!material.userData.stCut, cap);
      if (cap > b.cap) b.reserve(cap, cap * 6);
      this.map.set(material, b);
    }
    return b;
  }
  build(group, name, opts) {
    for (const _ of this.meshes(group, name, opts));
  }
  /** build() one mesh at a time: yields after each mesh (for builds spread over frames). */
  *meshes(group, name, { castShadow = false, receiveShadow = true, renderOrder = 0 } = {}) {
    for (const [mat, b] of this.map) {
      if (b.empty) { giveBack(b); this.map.delete(mat); continue; }
      const m = new THREE.Mesh(b.geometry(), mat);
      m.name = `${name}:${mat.name}`;
      m.castShadow = castShadow; m.receiveShadow = receiveShadow;
      m.renderOrder = renderOrder;
      m.matrixAutoUpdate = false;
      group.add(m);
      const n = b.n;
      giveBack(b);
      this.map.delete(mat);
      yield n;
    }
  }
  /** Return every buffer to the pool unbuilt (an abandoned build). */
  release() {
    for (const b of this.map.values()) giveBack(b);
    this.map.clear();
  }
}
