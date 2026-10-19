import * as THREE from 'three';

// Fast geometry assembly for facade infill.
//  - Tpl: a small mesh built once in opening-local coordinates (x across, y up, z out),
//    with a per-vertex shade (baked occlusion / dirt multiplier).
//  - Batch: one growable vertex buffer per material per chunk. Templates are appended
//    with a rigid transform and a colour, so a chunk becomes one draw call per material.
// UVs are metres (1 UV unit = 1 m) as everywhere else in the project.
//
// Templates are built into recycled scratch buffers (interleaved, VS floats per vertex)
// and bake() copies the result out, so building the hundreds of small templates of a
// chunk allocates little more than the baked arrays themselves.

/** Floats per template vertex: x y z, nx ny nz, u v, shade. */
export const VS = 9;
/** Vertices whose normal had to be rebuilt at bake time (should stay 0; see fixNormals). */
export const BAD_NORMALS = { count: 0 };

const poolV = [], poolI = [];
const POOL_MAX = 24;
function takeV() { return poolV.pop() || new Float32Array(VS * 128); }
function takeI() { return poolI.pop() || new Uint32Array(384); }

// Baked arrays are views into shared slabs (one allocation per ~1 MB instead of two per
// template); a slab is released once no cached template refers to it any more.
const SLAB = 1 << 18;
let slabF = null, slabFn = SLAB, slabI = null, slabIn = SLAB;
function allocF(n) {
  if (n > SLAB >> 3) return new Float32Array(n);
  if (slabFn + n > SLAB) { slabF = new Float32Array(SLAB); slabFn = 0; }
  const a = slabF.subarray(slabFn, slabFn + n); slabFn += n;
  return a;
}
function allocI16(n) {
  if (n > SLAB >> 3) return new Uint16Array(n);
  if (slabIn + n > SLAB) { slabI = new Uint16Array(SLAB); slabIn = 0; }
  const a = slabI.subarray(slabIn, slabIn + n); slabIn += n;
  return a;
}

/** Template mesh in local coordinates. */
export class Tpl {
  constructor() {
    this.V = takeV(); this.vn = 0;     // interleaved vertices, floats used
    this.I = takeI(); this.in = 0;     // indices used
    this.k = 1;        // shade multiplier for the piece being added (per-piece value jitter)
    this._piece = 0;
    // quads take u along their longer side (joinery: the detail bakes' grain, brush strokes
    // and tile-row lines run along every member, whatever its direction)
    this.uvLong = false;
  }
  get count() { return this.vn / VS; }
  _growV(k) {
    let len = this.V.length * 2;
    while (len < this.vn + k) len *= 2;
    const b = new Float32Array(len); b.set(this.V.subarray(0, this.vn)); this.V = b;
    return b;
  }
  _growI(k) {
    let len = this.I.length * 2;
    while (len < this.in + k) len *= 2;
    const b = new Uint32Array(len); b.set(this.I.subarray(0, this.in)); this.I = b;
    return b;
  }
  /** Start a new piece: its shade varies by ±amp around 1 (deterministic per template). */
  piece(amp = 0.06) {
    const h = Math.sin(++this._piece * 127.1 + (this.vn / VS) * 0.013) * 43758.5453;
    this.k = 1 + amp * (2 * (h - Math.floor(h)) - 1);
    return this;
  }
  v(x, y, z, nx, ny, nz, u, w, shade = 1) {
    const o = this.vn;
    const V = o + VS <= this.V.length ? this.V : this._growV(VS);
    V[o] = x; V[o + 1] = y; V[o + 2] = z;
    V[o + 3] = nx; V[o + 4] = ny; V[o + 5] = nz;
    V[o + 6] = u; V[o + 7] = w; V[o + 8] = shade * this.k;
    this.vn = o + VS;
    return o / VS;
  }
  /** Push triangle indices (any multiple of three). */
  ix(...idx) {
    const I = this.in + idx.length <= this.I.length ? this.I : this._growI(idx.length);
    let n = this.in;
    for (let k = 0; k < idx.length; k++) I[n++] = idx[k];
    this.in = n;
  }
  tri(a, b, c) {
    const I = this.in + 3 <= this.I.length ? this.I : this._growI(3);
    const n = this.in;
    I[n] = a; I[n + 1] = b; I[n + 2] = c; this.in = n + 3;
  }
  /** Two triangles (a b c) (d e f). */
  ix6(a, b, c, d, e, f) {
    const I = this.in + 6 <= this.I.length ? this.I : this._growI(6);
    const n = this.in;
    I[n] = a; I[n + 1] = b; I[n + 2] = c; I[n + 3] = d; I[n + 4] = e; I[n + 5] = f; this.in = n + 6;
  }
  /** Planar quad (CCW seen from the front). UVs projected on the dominant plane. */
  quad(p0, p1, p2, p3, shade = 1, shadeTop = shade) {
    this.q4(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], shade, shadeTop);
  }
  /** quad() with the corners as scalars (no garbage). */
  q4(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, shade = 1, shadeTop = shade) {
    // normal from the diagonals (twice the vector area): exact for planar quads, and still
    // right for a quad with two corners merged (a triangle)
    const ax_ = x2 - x0, ay_ = y2 - y0, az_ = z2 - z0;
    const bx = x3 - x1, by = y3 - y1, bz = z3 - z1;
    let nx = ay_ * bz - az_ * by, ny = az_ * bx - ax_ * bz, nz = ax_ * by - ay_ * bx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l > 1e-12) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 0; nz = 1; }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const mode = az >= ax && az >= ay ? 0 : ax >= ay ? 1 : 2;
    const b = this.vn / VS;
    if (this.uvLong) {
      // planar coordinates (p, q) of the dominant plane; swapped when q is the long side
      // (scalars throughout: no arrays per quad)
      const p0 = mode === 1 ? z0 : x0, p1 = mode === 1 ? z1 : x1, p2 = mode === 1 ? z2 : x2, p3 = mode === 1 ? z3 : x3;
      const q0 = mode === 2 ? z0 : y0, q1 = mode === 2 ? z1 : y1, q2 = mode === 2 ? z2 : y2, q3 = mode === 2 ? z3 : y3;
      const sp = Math.max(p0, p1, p2, p3) - Math.min(p0, p1, p2, p3), sq = Math.max(q0, q1, q2, q3) - Math.min(q0, q1, q2, q3);
      if (sq > sp) {
        this.v(x0, y0, z0, nx, ny, nz, q0, p0, shade); this.v(x1, y1, z1, nx, ny, nz, q1, p1, shade);
        this.v(x2, y2, z2, nx, ny, nz, q2, p2, shadeTop); this.v(x3, y3, z3, nx, ny, nz, q3, p3, shadeTop);
      } else {
        this.v(x0, y0, z0, nx, ny, nz, p0, q0, shade); this.v(x1, y1, z1, nx, ny, nz, p1, q1, shade);
        this.v(x2, y2, z2, nx, ny, nz, p2, q2, shadeTop); this.v(x3, y3, z3, nx, ny, nz, p3, q3, shadeTop);
      }
    } else if (mode === 0) {
      this.v(x0, y0, z0, nx, ny, nz, x0, y0, shade); this.v(x1, y1, z1, nx, ny, nz, x1, y1, shade);
      this.v(x2, y2, z2, nx, ny, nz, x2, y2, shadeTop); this.v(x3, y3, z3, nx, ny, nz, x3, y3, shadeTop);
    } else if (mode === 1) {
      this.v(x0, y0, z0, nx, ny, nz, z0, y0, shade); this.v(x1, y1, z1, nx, ny, nz, z1, y1, shade);
      this.v(x2, y2, z2, nx, ny, nz, z2, y2, shadeTop); this.v(x3, y3, z3, nx, ny, nz, z3, y3, shadeTop);
    } else {
      this.v(x0, y0, z0, nx, ny, nz, x0, z0, shade); this.v(x1, y1, z1, nx, ny, nz, x1, z1, shade);
      this.v(x2, y2, z2, nx, ny, nz, x2, z2, shadeTop); this.v(x3, y3, z3, nx, ny, nz, x3, z3, shadeTop);
    }
    this.ix6(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  /** Axis-aligned box; faces: bit mask 1 front(+z) 2 back(-z) 4 left(-x) 8 right(+x) 16 bottom 32 top. */
  box(x0, y0, z0, x1, y1, z1, faces = 1 | 4 | 8 | 16 | 32, shade = 1, shadeTop = shade) {
    if (faces & 1) this.q4(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, shade, shadeTop);
    if (faces & 2) this.q4(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, shade, shadeTop);
    if (faces & 4) this.q4(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, shade, shadeTop);
    if (faces & 8) this.q4(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, shade, shadeTop);
    if (faces & 16) this.q4(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, shade, shade);
    if (faces & 32) this.q4(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, shadeTop, shadeTop);
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
      const base = this.vn / VS;
      let acc = 0;
      const segs = closed ? m : m - 1;
      for (let j = 0; j < m; j++) {
        const jp = closed ? (j + 1) % m : Math.min(m - 1, j + 1), jm = closed ? (j - 1 + m) % m : Math.max(0, j - 1);
        const a = A[j], b = B[j], ap = A[jp], am = A[jm];
        // tangent along the outline, profile direction across
        const tx = ap[0] - am[0], ty = ap[1] - am[1], tz = ap[2] - am[2];
        const px = b[0] - a[0], py = b[1] - a[1], pz = b[2] - a[2];
        let nx = ty * pz - tz * py, ny = tz * px - tx * pz, nz = tx * py - ty * px;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
        // (a zero-length profile or tangent: bake() repairs the normal from the faces)
        if (l > 1e-12) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 0; nz = 0; }
        if (j > 0) { const q = A[j - 1]; acc += Math.hypot(a[0] - q[0], a[1] - q[1]); }
        const pl = Math.sqrt(px * px + py * py + pz * pz);
        this.v(a[0], a[1], a[2], nx, ny, nz, acc, 0, shade);
        this.v(b[0], b[1], b[2], nx, ny, nz, acc, pl, shade);
      }
      for (let j = 0; j < segs; j++) {
        const j1 = (j + 1) % m;
        const a = base + j * 2, b = base + j1 * 2;
        this.ix6(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  /** Convex polygon (CCW in xy) at depth z, fan-triangulated from its centroid. */
  poly(pts, z, shade = 1) {
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; }
    cx /= pts.length; cy /= pts.length;
    const c = this.v(cx, cy, z, 0, 0, 1, cx, cy, shade);
    const b = this.vn / VS;
    for (const p of pts) this.v(p[0], p[1], z, 0, 0, 1, p[0], p[1], shade);
    for (let k = 0; k < pts.length; k++) this.tri(c, b + k, b + ((k + 1) % pts.length));
  }
  /** Append template t (unbaked) rotated about the vertical axis through (px, *, pz) by angle a. */
  appendRotY(t, px, pz, a) {
    const c = Math.cos(a), s = Math.sin(a);
    const b = this.vn / VS, V = t.V, n = t.count;
    for (let k = 0; k < n; k++) {
      const o = k * VS;
      const x = V[o] - px, z = V[o + 2] - pz;
      const nx = V[o + 3], nz = V[o + 5];
      this.v(px + x * c + z * s, V[o + 1], pz - x * s + z * c, nx * c + nz * s, V[o + 4], -nx * s + nz * c, V[o + 6], V[o + 7], V[o + 8]);
    }
    const I = this.in + t.in <= this.I.length ? this.I : this._growI(t.in);
    for (let k = 0; k < t.in; k++) I[this.in++] = t.I[k] + b;
  }
  /** Multiply the per-vertex shade by fn(x, y, z). */
  shadeBy(fn) {
    const V = this.V;
    for (let o = 0; o < this.vn; o += VS) V[o + 8] *= fn(V[o], V[o + 1], V[o + 2]);
    return this;
  }
  /**
   * Freeze into compact typed arrays for fast appending: {v (interleaved, VS floats per
   * vertex), i, count}. The scratch buffers go back to the pool: the template is spent.
   */
  bake() {
    this.fixNormals();
    const n = this.count, V = this.V, I = this.I;
    const v = allocF(this.vn);
    for (let k = 0; k < this.vn; k++) v[k] = V[k];
    const i = n < 65536 ? allocI16(this.in) : new Uint32Array(this.in);
    for (let k = 0; k < this.in; k++) i[k] = I[k];
    const out = { v, i, count: n };
    this.free();
    return out;
  }
  /**
   * Every vertex must carry a unit normal: a zero (or NaN) one is normalised to NaN by the
   * vertex shader and blackens every triangle that touches it. Such normals (a collapsed
   * row, a zero-length profile) are rebuilt from the area-weighted normals of the faces
   * around the vertex, else set facing out (+z). Counted in BAD_NORMALS for the checks.
   */
  fixNormals() {
    const V = this.V, I = this.I;
    let bad = null;
    for (let o = 0; o < this.vn; o += VS) {
      const x = V[o + 3], y = V[o + 4], z = V[o + 5], l2 = x * x + y * y + z * z;
      if (!(l2 > 0.25)) (bad || (bad = new Set())).add(o / VS);
    }
    if (!bad) return;
    BAD_NORMALS.count += bad.size;
    const acc = new Map();
    for (const k of bad) acc.set(k, [0, 0, 0]);
    for (let t = 0; t + 2 < this.in; t += 3) {
      const a = I[t], b = I[t + 1], c = I[t + 2];
      if (!bad.has(a) && !bad.has(b) && !bad.has(c)) continue;
      const pa = a * VS, pb = b * VS, pc = c * VS;
      const ux = V[pb] - V[pa], uy = V[pb + 1] - V[pa + 1], uz = V[pb + 2] - V[pa + 2];
      const wx = V[pc] - V[pa], wy = V[pc + 1] - V[pa + 1], wz = V[pc + 2] - V[pa + 2];
      const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
      for (const k of [a, b, c]) { const s = acc.get(k); if (s) { s[0] += fx; s[1] += fy; s[2] += fz; } }
    }
    for (const [k, s] of acc) {
      const l = Math.hypot(s[0], s[1], s[2]), o = k * VS;
      if (l > 1e-12) { V[o + 3] = s[0] / l; V[o + 4] = s[1] / l; V[o + 5] = s[2] / l; } else { V[o + 3] = 0; V[o + 4] = 0; V[o + 5] = 1; }
    }
  }
  /** Return the scratch buffers to the pool without baking. */
  free() {
    if (this.V && poolV.length < POOL_MAX && this.V.length <= VS * 65536) poolV.push(this.V);
    if (this.I && poolI.length < POOL_MAX && this.I.length <= 262144) poolI.push(this.I);
    this.V = null; this.I = null;
  }
}

class FBuf {
  constructor(n) { this.a = new Float32Array(Math.max(16, n)); this.n = 0; }
  ensure(k) {
    if (this.n + k <= this.a.length) return;
    let len = this.a.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new Float32Array(len); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
}
class IBuf {
  constructor(n) { this.a = new Uint32Array(Math.max(16, n)); this.n = 0; }
  ensure(k) {
    if (this.n + k <= this.a.length) return;
    let len = this.a.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new Uint32Array(len); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
}

/**
 * Per-chunk vertex buffer for one material. extra: {name: itemSize}; hint: expected
 * {verts, idx} (sized from earlier chunks, so the buffers rarely grow).
 */
export class Batch {
  constructor(material, { color = true, extra = null, hint = null } = {}) {
    this.material = material;
    const nv = hint ? Math.ceil(hint.verts * 1.2) + 64 : 1024, ni = hint ? Math.ceil(hint.idx * 1.2) + 192 : 3072;
    this.P = new FBuf(nv * 3); this.N = new FBuf(nv * 3); this.T = new FBuf(nv * 2);
    this.C = color ? new FBuf(nv * 3) : null;
    this.I = new IBuf(ni);
    this.extra = {};
    if (extra) for (const k in extra) this.extra[k] = { size: extra[k], buf: new FBuf(nv * extra[k]) };
    this.count = 0;
  }
  /**
   * Append a baked template with matrix m (rigid) and colour rgb (multiplied by shade).
   * extraVals: per attribute either a constant array or fn(k, v, out, o) filling vertex k
   * (v = the template's interleaved vertices, position of k at v[k * VS]). du, dv offset
   * the UVs (metres), so detail textures differ between copies of one template.
   */
  add(tpl, m, r = 1, g = 1, b = 1, extraVals = null, du = 0, dv = 0) {
    const e = m.elements, n = tpl.count, base = this.count;
    const P = this.P, N = this.N, T = this.T, C = this.C;
    P.ensure(n * 3); N.ensure(n * 3); T.ensure(n * 2); if (C) C.ensure(n * 3);
    const pa = P.a, na = N.a, ta = T.a, ca = C ? C.a : null;
    const e0 = e[0], e1 = e[1], e2 = e[2], e4 = e[4], e5 = e[5], e6 = e[6], e8 = e[8], e9 = e[9], e10 = e[10], e12 = e[12], e13 = e[13], e14 = e[14];
    const p0 = P.n, t0 = T.n, end = n * VS;
    const sv = tpl.v;
    for (let o = 0, pi = p0, ti = t0; o < end; o += VS, pi += 3, ti += 2) {
      const x = sv[o], y = sv[o + 1], z = sv[o + 2];
      pa[pi] = e0 * x + e4 * y + e8 * z + e12;
      pa[pi + 1] = e1 * x + e5 * y + e9 * z + e13;
      pa[pi + 2] = e2 * x + e6 * y + e10 * z + e14;
      const nx = sv[o + 3], ny = sv[o + 4], nz = sv[o + 5];
      na[pi] = e0 * nx + e4 * ny + e8 * nz;
      na[pi + 1] = e1 * nx + e5 * ny + e9 * nz;
      na[pi + 2] = e2 * nx + e6 * ny + e10 * nz;
      ta[ti] = sv[o + 6] + du; ta[ti + 1] = sv[o + 7] + dv;
    }
    if (ca) {
      for (let o = 8, pi = p0; o < end; o += VS, pi += 3) { const s = sv[o]; ca[pi] = r * s; ca[pi + 1] = g * s; ca[pi + 2] = b * s; }
      C.n = p0 + n * 3;
    }
    P.n = N.n = p0 + n * 3; T.n = t0 + n * 2;
    if (extraVals) {
      for (const key in this.extra) {
        const ex = this.extra[key], v = extraVals[key], sz = ex.size;
        ex.buf.ensure(n * sz);
        const a = ex.buf.a;
        let o = ex.buf.n;
        if (typeof v === 'function') for (let k = 0; k < n; k++) { v(k, sv, a, o); o += sz; }
        else if (sz === 4) { const v0 = v[0], v1 = v[1], v2 = v[2], v3 = v[3]; for (let k = 0; k < n; k++) { a[o] = v0; a[o + 1] = v1; a[o + 2] = v2; a[o + 3] = v3; o += 4; } }
        else for (let k = 0; k < n; k++) { for (let q = 0; q < sz; q++) a[o + q] = v[q]; o += sz; }
        ex.buf.n = o;
      }
    }
    const si = tpl.i;
    const I = this.I; I.ensure(si.length);
    const ia = I.a;
    let ii = I.n;
    for (let k = 0; k < si.length; k++) ia[ii++] = si[k] + base;
    I.n = ii;
    this.count += n;
  }
  geometry() {
    if (!this.count) return null;
    const g = new THREE.BufferGeometry();
    // no copy (the batch is done), unless most of the buffer would be wasted
    const view = (b) => (b.n > b.a.length * 0.5 ? new Float32Array(b.a.buffer, 0, b.n) : b.a.slice(0, b.n));
    g.setAttribute('position', new THREE.BufferAttribute(view(this.P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(view(this.N), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(view(this.T), 2));
    if (this.C) g.setAttribute('color', new THREE.BufferAttribute(view(this.C), 3));
    for (const k in this.extra) g.setAttribute(k, new THREE.BufferAttribute(view(this.extra[k].buf), this.extra[k].size));
    let idx;
    if (this.count < 65536) { idx = new Uint16Array(this.I.n); idx.set(this.I.a.subarray(0, this.I.n)); } else idx = this.I.a.slice(0, this.I.n);
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

/**
 * Copy the baked templates in v (a template, or an object or array of them, two levels
 * deep) out of the shared slabs into arrays of their own: a cached template must not keep
 * a whole slab (and every transient template baked into it) alive.
 */
function compact(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 2) return v;
  if (v.v instanceof Float32Array && v.i && typeof v.count === 'number') {
    if (v.v.byteLength !== v.v.buffer.byteLength) v.v = v.v.slice();
    if (v.i.byteLength !== v.i.buffer.byteLength) v.i = v.i.slice();
    return v;
  }
  if (ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) { for (let k = 0; k < v.length; k++) compact(v[k], depth + 1); return v; }
  for (const k in v) compact(v[k], depth + 1);
  return v;
}

/**
 * Bounded template cache: when full, the oldest quarter is dropped (Map keeps insertion
 * order) rather than everything, so the templates of the building being dressed survive.
 * Cached templates are copied out of the bake slabs (compact).
 */
export class TplCache {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(key, make) {
    let v = this.map.get(key);
    if (v === undefined) {
      if (this.map.size >= this.max) {
        let drop = this.max >> 2;
        for (const k of this.map.keys()) { this.map.delete(k); if (--drop <= 0) break; }
      }
      v = compact(make());
      this.map.set(key, v);
    }
    return v;
  }
}
