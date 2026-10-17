import * as THREE from 'three';

// Fast geometry assembly for facade infill.
//  - Tpl: a small mesh built once in opening-local coordinates (x across, y up, z out),
//    with a per-vertex shade (baked occlusion / dirt multiplier).
//  - Batch: one growable vertex buffer per material per chunk. Templates are appended
//    with a rigid transform and a colour, so a chunk becomes one draw call per material.
// UVs are metres (1 UV unit = 1 m) as everywhere else in the project.

class FBuf {
  constructor(n = 1024) { this.a = new Float32Array(n); this.n = 0; }
  ensure(k) {
    if (this.n + k <= this.a.length) return;
    let len = this.a.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new Float32Array(len); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  view() { return this.a.slice(0, this.n); }
}
class IBuf {
  constructor(n = 1024) { this.a = new Uint32Array(n); this.n = 0; }
  ensure(k) {
    if (this.n + k <= this.a.length) return;
    let len = this.a.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new Uint32Array(len); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
}

const _n = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();

/** Template mesh in local coordinates (typed growable buffers: little garbage). */
export class Tpl {
  constructor() {
    this.P = new FBuf(768); this.N = new FBuf(768); this.T = new FBuf(512); this.S = new FBuf(256); this.I = new IBuf(512);
    this.k = 1;        // shade multiplier for the piece being added (per-piece value jitter)
    this._piece = 0;
  }
  get count() { return this.P.n / 3; }
  /** Start a new piece: its shade varies by ±amp around 1 (deterministic per template). */
  piece(amp = 0.06) {
    const h = Math.sin(++this._piece * 127.1 + this.P.n * 0.013) * 43758.5453;
    this.k = 1 + amp * (2 * (h - Math.floor(h)) - 1);
    return this;
  }
  v(x, y, z, nx, ny, nz, u, w, shade = 1) {
    const P = this.P, N = this.N, T = this.T, S = this.S;
    P.ensure(3); N.ensure(3); T.ensure(2); S.ensure(1);
    const k = P.n;
    P.a[k] = x; P.a[k + 1] = y; P.a[k + 2] = z; P.n = k + 3;
    N.a[k] = nx; N.a[k + 1] = ny; N.a[k + 2] = nz; N.n = k + 3;
    T.a[T.n] = u; T.a[T.n + 1] = w; T.n += 2;
    S.a[S.n++] = shade * this.k;
    return k / 3;
  }
  /** Push triangle indices (any multiple of three). */
  ix(...idx) {
    const I = this.I; I.ensure(idx.length);
    for (let k = 0; k < idx.length; k++) I.a[I.n++] = idx[k];
  }
  tri(a, b, c) { this.ix(a, b, c); }
  /** Planar quad (CCW seen from the front). UVs projected on the dominant plane. */
  quad(p0, p1, p2, p3, shade = 1, shadeTop = shade) {
    const ax_ = p1[0] - p0[0], ay_ = p1[1] - p0[1], az_ = p1[2] - p0[2];
    const bx = p3[0] - p0[0], by = p3[1] - p0[1], bz = p3[2] - p0[2];
    let nx = ay_ * bz - az_ * by, ny = az_ * bx - ax_ * bz, nz = ax_ * by - ay_ * bx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const mode = az >= ax && az >= ay ? 0 : ax >= ay ? 1 : 2;
    const b = this.count;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p0 : k === 1 ? p1 : k === 2 ? p2 : p3;
      const u = mode === 1 ? q[2] : q[0], w = mode === 2 ? q[2] : q[1];
      this.v(q[0], q[1], q[2], nx, ny, nz, u, w, k < 2 ? shade : shadeTop);
    }
    const I = this.I; I.ensure(6);
    const a = I.a; let n = I.n;
    a[n] = b; a[n + 1] = b + 1; a[n + 2] = b + 2; a[n + 3] = b; a[n + 4] = b + 2; a[n + 5] = b + 3; I.n = n + 6;
  }
  /** Axis-aligned box; faces: bit mask 1 front(+z) 2 back(-z) 4 left(-x) 8 right(+x) 16 bottom 32 top. */
  box(x0, y0, z0, x1, y1, z1, faces = 1 | 4 | 8 | 16 | 32, shade = 1, shadeTop = shade) {
    if (faces & 1) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], shade, shadeTop);
    if (faces & 2) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], shade, shadeTop);
    if (faces & 4) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], shade, shadeTop);
    if (faces & 8) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], shade, shadeTop);
    if (faces & 16) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], shade, shade);
    if (faces & 32) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], shadeTop, shadeTop);
  }
  /**
   * Straight bar from a to b (2D points in the xy plane) with a cross-section profile
   * [[lateral, z], ...] running from one side round the front to the other side.
   * Lateral is measured to the left of a→b. Ends are left open (they butt into frames).
   */
  bar(a, b, profile, shade = 1) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    const tx = dx / L, ty = dy / L, lx = -ty, ly = tx;
    for (let k = 0; k + 1 < profile.length; k++) {
      const [l0, z0] = profile[k], [l1, z1] = profile[k + 1];
      const pA0 = [a[0] + lx * l0, a[1] + ly * l0, z0], pB0 = [b[0] + lx * l0, b[1] + ly * l0, z0];
      const pA1 = [a[0] + lx * l1, a[1] + ly * l1, z1], pB1 = [b[0] + lx * l1, b[1] + ly * l1, z1];
      // profile runs right→front→left (lateral increasing) so the face normal points out
      this.quad(pA0, pB0, pB1, pA1, shade);
    }
  }
  /**
   * Loft between corresponding rings: rings[k] is a list of [x, y, z] points along a
   * (closed or open) outline. Normals are per strip, smoothed along the outline.
   */
  loft(rings, closed, shade = 1) {
    const m = rings[0].length;
    for (let k = 0; k + 1 < rings.length; k++) {
      const A = rings[k], B = rings[k + 1];
      const base = this.count;
      let acc = 0;
      const segs = closed ? m : m - 1;
      for (let j = 0; j < m; j++) {
        const jp = closed ? (j + 1) % m : Math.min(m - 1, j + 1), jm = closed ? (j - 1 + m) % m : Math.max(0, j - 1);
        // tangent along the outline, profile direction across
        const tx = A[jp][0] - A[jm][0], ty = A[jp][1] - A[jm][1], tz = A[jp][2] - A[jm][2];
        const px = B[j][0] - A[j][0], py = B[j][1] - A[j][1], pz = B[j][2] - A[j][2];
        let nx = ty * pz - tz * py, ny = tz * px - tx * pz, nz = tx * py - ty * px;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1; nx /= l; ny /= l; nz /= l;
        if (j > 0) acc += Math.hypot(A[j][0] - A[j - 1][0], A[j][1] - A[j - 1][1]);
        const pl = Math.sqrt(px * px + py * py + pz * pz);
        this.v(A[j][0], A[j][1], A[j][2], nx, ny, nz, acc, 0, shade);
        this.v(B[j][0], B[j][1], B[j][2], nx, ny, nz, acc, pl, shade);
      }
      for (let j = 0; j < segs; j++) {
        const j1 = (j + 1) % m;
        const a = base + j * 2, b = base + j1 * 2;
        this.ix(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  /** Convex polygon (CCW in xy) at depth z, fan-triangulated from its centroid. */
  poly(pts, z, shade = 1) {
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    const c = this.v(cx, cy, z, 0, 0, 1, cx, cy, shade);
    const b = this.count;
    for (const p of pts) this.v(p[0], p[1], z, 0, 0, 1, p[0], p[1], shade);
    for (let k = 0; k < pts.length; k++) this.ix(c, b + k, b + ((k + 1) % pts.length));
  }
  /** Append template t rotated about the vertical axis through (px, *, pz) by angle a. */
  appendRotY(t, px, pz, a) {
    const c = Math.cos(a), s = Math.sin(a);
    const b = this.count, P = t.P.a, N = t.N.a, T = t.T.a, S = t.S.a;
    for (let k = 0; k < t.count; k++) {
      const x = P[k * 3] - px, z = P[k * 3 + 2] - pz;
      const nx = N[k * 3], nz = N[k * 3 + 2];
      this.v(px + x * c + z * s, P[k * 3 + 1], pz - x * s + z * c, nx * c + nz * s, N[k * 3 + 1], -nx * s + nz * c, T[k * 2], T[k * 2 + 1], S[k]);
    }
    for (let k = 0; k < t.I.n; k++) { this.I.ensure(1); this.I.a[this.I.n++] = t.I.a[k] + b; }
  }
  /** Multiply the per-vertex shade by fn(x, y, z). */
  shadeBy(fn) {
    const P = this.P.a, S = this.S.a;
    for (let k = 0; k < this.S.n; k++) S[k] *= fn(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]);
    return this;
  }
  /** Freeze into compact typed arrays for fast appending. */
  bake() {
    return { p: this.P.view(), n: this.N.view(), t: this.T.view(), s: this.S.view(), i: this.I.a.slice(0, this.I.n), count: this.count };
  }
}

/** Per-chunk vertex buffer for one material. extra: {name: itemSize}. */
export class Batch {
  constructor(material, { color = true, extra = null } = {}) {
    this.material = material;
    this.P = new FBuf(4096); this.N = new FBuf(4096); this.T = new FBuf(2048);
    this.C = color ? new FBuf(4096) : null;
    this.I = new IBuf(4096);
    this.extra = {};
    if (extra) for (const k in extra) this.extra[k] = { size: extra[k], buf: new FBuf(2048) };
    this.count = 0;
  }
  /** Append a baked template with matrix m (rigid) and colour rgb (multiplied by shade). */
  add(tpl, m, r = 1, g = 1, b = 1, extraVals = null) {
    const e = m.elements, n = tpl.count, base = this.count;
    const P = this.P, N = this.N, T = this.T, C = this.C;
    P.ensure(n * 3); N.ensure(n * 3); T.ensure(n * 2); if (C) C.ensure(n * 3);
    const pa = P.a, na = N.a, ta = T.a, ca = C ? C.a : null;
    let pi = P.n, ti = T.n;
    const sp = tpl.p, sn = tpl.n, st = tpl.t, ss = tpl.s;
    for (let k = 0; k < n; k++) {
      const x = sp[k * 3], y = sp[k * 3 + 1], z = sp[k * 3 + 2];
      pa[pi] = e[0] * x + e[4] * y + e[8] * z + e[12];
      pa[pi + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      pa[pi + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const nx = sn[k * 3], ny = sn[k * 3 + 1], nz = sn[k * 3 + 2];
      na[pi] = e[0] * nx + e[4] * ny + e[8] * nz;
      na[pi + 1] = e[1] * nx + e[5] * ny + e[9] * nz;
      na[pi + 2] = e[2] * nx + e[6] * ny + e[10] * nz;
      if (ca) { const s = ss[k]; ca[pi] = r * s; ca[pi + 1] = g * s; ca[pi + 2] = b * s; }
      pi += 3;
      ta[ti] = st[k * 2]; ta[ti + 1] = st[k * 2 + 1]; ti += 2;
    }
    P.n = pi; N.n = pi; T.n = ti; if (C) C.n = pi;
    if (extraVals) {
      for (const key in this.extra) {
        const ex = this.extra[key], v = extraVals[key], sz = ex.size;
        ex.buf.ensure(n * sz);
        const a = ex.buf.a;
        let o = ex.buf.n;
        if (typeof v === 'function') for (let k = 0; k < n; k++) { v(k, sp, a, o); o += sz; }
        else for (let k = 0; k < n; k++) { for (let q = 0; q < sz; q++) a[o + q] = v[q]; o += sz; }
        ex.buf.n = o;
      }
    }
    const I = this.I; I.ensure(tpl.i.length);
    const ia = I.a, si = tpl.i;
    let ii = I.n;
    for (let k = 0; k < si.length; k++) ia[ii++] = si[k] + base;
    I.n = ii;
    this.count += n;
  }
  geometry() {
    if (!this.count) return null;
    const g = new THREE.BufferGeometry();
    const view = (b) => new Float32Array(b.a.buffer, 0, b.n); // no copy: the batch is done
    g.setAttribute('position', new THREE.BufferAttribute(view(this.P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(view(this.N), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(view(this.T), 2));
    if (this.C) g.setAttribute('color', new THREE.BufferAttribute(view(this.C), 3));
    for (const k in this.extra) g.setAttribute(k, new THREE.BufferAttribute(view(this.extra[k].buf), this.extra[k].size));
    const idx = this.count < 65536 ? Uint16Array.from(this.I.a.subarray(0, this.I.n)) : new Uint32Array(this.I.a.buffer, 0, this.I.n);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    // bounding sphere from the AABB (one pass)
    const p = this.P.a, n = this.P.n;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < n; k += 3) {
      const x = p[k], y = p[k + 1], z = p[k + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
    return g;
  }
  mesh(name, { castShadow = true, receiveShadow = true } = {}) {
    const g = this.geometry();
    if (!g) return null;
    const mesh = new THREE.Mesh(g, this.material);
    mesh.name = name;
    mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

/** sRGB hex → linear [r, g, b] (vertex colours are linear). */
const _c = new THREE.Color();
export function lin(hex) { _c.setHex(hex); return [_c.r, _c.g, _c.b]; }
export function scaleRGB(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
