import * as THREE from 'three';

// Minimal growable vertex buffer: chunk builders write vertices straight into typed
// arrays (no per-geometry merge step), one buffer per material.

export class MeshBuf {
  constructor({ color = false, cap = 1024 } = {}) {
    this.hasColor = color;
    this.n = 0;
    this.ni = 0;
    this._alloc(cap, cap * 2);
  }

  _alloc(vc, ic) {
    const grow = (old, size) => { const a = new Float32Array(size); if (old) a.set(old.subarray(0, Math.min(old.length, size))); return a; };
    this.cap = vc;
    this.pos = grow(this.pos, vc * 3);
    this.nor = grow(this.nor, vc * 3);
    this.uv = grow(this.uv, vc * 2);
    if (this.hasColor) this.col = grow(this.col, vc * 3);
    const idx = new Uint32Array(ic);
    if (this.idx) idx.set(this.idx.subarray(0, this.ni));
    this.idx = idx;
    this.icap = ic;
  }

  /** Append a vertex, returns its index. */
  v(x, y, z, nx, ny, nz, u, w, r = 1, g = 1, b = 1) {
    if (this.n >= this.cap) this._alloc(this.cap * 2, this.icap);
    const i = this.n++, i3 = i * 3, i2 = i * 2;
    const p = this.pos, n = this.nor;
    p[i3] = x; p[i3 + 1] = y; p[i3 + 2] = z;
    n[i3] = nx; n[i3 + 1] = ny; n[i3 + 2] = nz;
    this.uv[i2] = u; this.uv[i2 + 1] = w;
    if (this.hasColor) { const c = this.col; c[i3] = r; c[i3 + 1] = g; c[i3 + 2] = b; }
    return i;
  }

  tri(a, b, c) {
    if (this.ni + 3 > this.icap) this._alloc(this.cap, this.icap * 2);
    const x = this.idx;
    x[this.ni++] = a; x[this.ni++] = b; x[this.ni++] = c;
  }

  /** Quad a-b-c-d (counter-clockwise seen from the front). */
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }

  get empty() { return this.ni === 0; }

  geometry() {
    const g = new THREE.BufferGeometry();
    const n = this.n;
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    if (this.hasColor) g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3));
    const idx = n < 65536 ? new Uint16Array(this.idx.subarray(0, this.ni)) : this.idx.slice(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** One MeshBuf per material; build() returns meshes added to a group. */
export class BufSet {
  constructor() { this.map = new Map(); }
  get(material, color = false) {
    let b = this.map.get(material);
    if (!b) { b = new MeshBuf({ color }); this.map.set(material, b); }
    return b;
  }
  build(group, name, { castShadow = false, receiveShadow = true, renderOrder = 0 } = {}) {
    for (const [mat, b] of this.map) {
      if (b.empty) continue;
      const m = new THREE.Mesh(b.geometry(), mat);
      m.name = `${name}:${mat.name}`;
      m.castShadow = castShadow; m.receiveShadow = receiveShadow;
      m.renderOrder = renderOrder;
      m.matrixAutoUpdate = false;
      group.add(m);
    }
    this.map.clear();
  }
}
