import * as THREE from 'three';

const len2 = (a, b) => Math.sqrt(a * a + b * b);

// Low-level geometry writers for the ironwork module. Everything writes straight into
// flat arrays (no intermediate BufferGeometry clones) so chunk builds stay cheap.
// UVs are in metres, like every library material expects.

/** Accumulates an indexed triangle mesh: position, normal, uv, color, in growable typed
 *  arrays. An optional matrix transforms positions (and normals) as they are written. */
export class GeoWriter {
  /** opts.kind: also record a per-vertex float (`aGk`, set with kind()) */
  constructor(cap = 2048, opts = {}) {
    this.n = 0; this.ni = 0;
    this.P = new Float32Array(cap * 3); this.N = new Float32Array(cap * 3);
    this.T = new Float32Array(cap * 2); this.C = new Float32Array(cap * 3);
    this.K = opts.kind ? new Float32Array(cap) : null; this.k = 0;
    this.I = new Uint32Array(cap * 3);
    this.m = null; this.nm = null;
    this._m = new Float32Array(16); this._n3 = new THREE.Matrix3();
    this.r = 1; this.g = 1; this.b = 1;
  }
  get count() { return this.n; }
  /** Empties the writer for reuse; its grown buffers are kept. */
  reset() {
    this.n = 0; this.ni = 0; this.k = 0;
    this.m = this.nm = null;
    this.r = this.g = this.b = 1;
    return this;
  }
  /** Transform for subsequent vertices (copied, so the caller may reuse its matrix). */
  setMatrix(m) {
    if (!m) { this.m = this.nm = null; return this; }
    this._m.set(m.elements);
    this.m = this._m;
    this.nm = this._n3.getNormalMatrix(m).elements;
    return this;
  }
  color(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
  /** Value of the optional per-vertex kind stream for subsequent vertices. */
  kind(k) { this.k = k; return this; }
  /** Make room for `k` more vertices and `t` more indices. */
  reserve(k, t) {
    while ((this.n + k) * 3 > this.P.length) this._grow();
    if (this.ni + t > this.I.length) { const b = new Uint32Array(Math.max(this.I.length * 2, this.ni + t)); b.set(this.I); this.I = b; }
  }
  _grow() {
    const cap = this.P.length / 3 * 2;
    const g = (a, k) => { const b = new a.constructor(cap * k); b.set(a); return b; };
    this.P = g(this.P, 3); this.N = g(this.N, 3); this.T = g(this.T, 2); this.C = g(this.C, 3);
    if (this.K) this.K = g(this.K, 1);
  }
  /** Adds a vertex, returns its index. Optional per-vertex shade multiplies the current colour. */
  v(x, y, z, nx, ny, nz, u, w, shade = 1) {
    if (this.n * 3 >= this.P.length) this._grow();
    const i3 = this.n * 3, P = this.P, N = this.N, m = this.m;
    if (m) {
      P[i3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      P[i3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      P[i3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const n = this.nm;
      const NX = n[0] * nx + n[3] * ny + n[6] * nz;
      const NY = n[1] * nx + n[4] * ny + n[7] * nz;
      const NZ = n[2] * nx + n[5] * ny + n[8] * nz;
      const l = 1 / (Math.sqrt(NX * NX + NY * NY + NZ * NZ) || 1);
      N[i3] = NX * l; N[i3 + 1] = NY * l; N[i3 + 2] = NZ * l;
    } else {
      P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
      N[i3] = nx; N[i3 + 1] = ny; N[i3 + 2] = nz;
    }
    this.T[this.n * 2] = u; this.T[this.n * 2 + 1] = w;
    this.C[i3] = this.r * shade; this.C[i3 + 1] = this.g * shade; this.C[i3 + 2] = this.b * shade;
    if (this.K) this.K[this.n] = this.k;
    return this.n++;
  }
  tri(a, b, c) {
    if (this.ni + 3 > this.I.length) { const b2 = new Uint32Array(this.I.length * 2); b2.set(this.I); this.I = b2; }
    const I = this.I; I[this.ni++] = a; I[this.ni++] = b; I[this.ni++] = c;
  }
  /** Quad a-b-c-d counter-clockwise (front-facing). */
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  /** copy: false hands the writer's buffers to the geometry as views (the writer is then
   *  discarded); true copies the used part, so the writer can be reset and reused. */
  toGeometry({ colors = true, bounds = true, copy = false } = {}) {
    const g = new THREE.BufferGeometry(), n = this.n;
    const a = (arr, k) => (copy ? arr.slice(0, n * k) : arr.subarray(0, n * k));
    g.setAttribute('position', new THREE.BufferAttribute(a(this.P, 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(a(this.N, 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(a(this.T, 2), 2));
    if (colors) g.setAttribute('color', new THREE.BufferAttribute(a(this.C, 3), 3));
    if (this.K) g.setAttribute('aGk', new THREE.BufferAttribute(a(this.K, 1), 1));
    const idx = n > 65535 ? (copy ? this.I.slice(0, this.ni) : this.I.subarray(0, this.ni)) : new Uint16Array(this.I.subarray(0, this.ni));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    if (bounds) g.computeBoundingSphere();
    return g;
  }
}

/** Position-only indexed mesh writer (shadow casters: no normals, uvs or colours, and
 *  vertices shared wherever the position is). Same interface as GeoWriter for the parts
 *  that matter: setMatrix, v(x, y, z), tri, quad, reserve, reset. */
export class PosWriter {
  constructor(cap = 4096) {
    this.n = 0; this.ni = 0;
    this.P = new Float32Array(cap * 3);
    this.I = new Uint32Array(cap * 3);
    this.m = null; this._m = new Float32Array(16);
  }
  get count() { return this.n; }
  reset() { this.n = 0; this.ni = 0; this.m = null; return this; }
  setMatrix(m) {
    if (!m) { this.m = null; return this; }
    this._m.set(m.elements);
    this.m = this._m;
    return this;
  }
  reserve(k, t) {
    if ((this.n + k) * 3 > this.P.length) { const b = new Float32Array(Math.max(this.P.length * 2, (this.n + k) * 3)); b.set(this.P); this.P = b; }
    if (this.ni + t > this.I.length) { const b = new Uint32Array(Math.max(this.I.length * 2, this.ni + t)); b.set(this.I); this.I = b; }
  }
  v(x, y, z) {
    if (this.n * 3 >= this.P.length) this.reserve(1, 0);
    const i3 = this.n * 3, P = this.P, m = this.m;
    if (m) {
      P[i3] = m[0] * x + m[4] * y + m[8] * z + m[12];
      P[i3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      P[i3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    } else { P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z; }
    return this.n++;
  }
  tri(a, b, c) {
    if (this.ni + 3 > this.I.length) this.reserve(0, 3);
    const I = this.I; I[this.ni++] = a; I[this.ni++] = b; I[this.ni++] = c;
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
}

/** Position-only template {P, I, n} of a geometry or writer, with coincident vertices
 *  welded (a shadow caster needs no split normals or seams). */
export function posTemplate(src) {
  const P = src.isBufferGeometry ? src.attributes.position.array : src.P;
  const n = src.isBufferGeometry ? src.attributes.position.count : src.n;
  const I = src.isBufferGeometry ? (src.index ? src.index.array : Uint32Array.from({ length: n }, (_, i) => i)) : src.I.subarray(0, src.ni);
  const map = new Map(), remap = new Uint32Array(n), out = [];
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(P[i * 3] * 1e4)},${Math.round(P[i * 3 + 1] * 1e4)},${Math.round(P[i * 3 + 2] * 1e4)}`;
    let j = map.get(key);
    if (j === undefined) { j = out.length / 3; map.set(key, j); out.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); }
    remap[i] = j;
  }
  const idx = [];
  for (let i = 0; i < I.length; i += 3) {
    const a = remap[I[i]], b = remap[I[i + 1]], c = remap[I[i + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { P: new Float32Array(out), I: new Uint32Array(idx), n: out.length / 3 };
}

/** Welds a template {P, N, T, C, I, n}: coincident vertices whose normals are within
 *  `maxAngle` of the first one met are merged (normal averaged, smooth shading across
 *  facets of a curve; uv and colour of the first). Sharper edges stay split. */
export function weldTemplate(t, maxAngle = 0.7) {
  const cosT = Math.cos(maxAngle), groups = new Map(), remap = new Uint32Array(t.n);
  const P = [], N = [], T = [], C = [];
  for (let i = 0; i < t.n; i++) {
    const x = t.P[i * 3], y = t.P[i * 3 + 1], z = t.P[i * 3 + 2];
    const nx = t.N[i * 3], ny = t.N[i * 3 + 1], nz = t.N[i * 3 + 2];
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    let j = -1;
    for (const [k, fx, fy, fz] of list) if (fx * nx + fy * ny + fz * nz > cosT) { j = k; break; }
    if (j < 0) {
      j = P.length / 3;
      list.push([j, nx, ny, nz]);
      P.push(x, y, z); N.push(0, 0, 0); T.push(t.T[i * 2], t.T[i * 2 + 1]); C.push(t.C[i * 3], t.C[i * 3 + 1], t.C[i * 3 + 2]);
    }
    N[j * 3] += nx; N[j * 3 + 1] += ny; N[j * 3 + 2] += nz;
    remap[i] = j;
  }
  for (let j = 0; j < N.length; j += 3) {
    const l = Math.hypot(N[j], N[j + 1], N[j + 2]) || 1;
    N[j] /= l; N[j + 1] /= l; N[j + 2] /= l;
  }
  const I = new Uint32Array(t.I.length);
  for (let i = 0; i < I.length; i++) I[i] = remap[t.I[i]];
  return { P: new Float32Array(P), N: new Float32Array(N), T: new Float32Array(T), C: new Float32Array(C), I, n: P.length / 3 };
}

/** Writes a position template into a PosWriter with `matrix` (THREE.Matrix4). */
export function writePos(S, t, matrix) {
  S.reserve(t.n, t.I.length);
  const e = matrix.elements, P = t.P, SP = S.P, base = S.n;
  for (let i = 0, o = base * 3; i < t.n * 3; i += 3, o += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    SP[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
    SP[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    SP[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  S.n += t.n;
  const I = S.I, I0 = t.I;
  for (let i = 0; i < I0.length; i++) I[S.ni + i] = base + I0[i];
  S.ni += I0.length;
}

/** Resample a dense polyline: keep a point whenever the heading turned more than
 *  maxTurn radians or maxLen metres were travelled since the last kept point. */
export function simplify(pts, maxTurn = 0.26, maxLen = 0.08) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  let lastDir = Math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0]);
  let acc = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    acc += len2(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
    const dir = Math.atan2(q[1] - p[1], q[0] - p[0]);
    let turn = Math.abs(dir - lastDir); if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > maxTurn || acc > maxLen) { out.push(p); lastDir = dir; acc = 0; }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Sweep a rectangular bar section along a 2D polyline lying in the z = z0 plane.
 *  hw = half width in the plane, hd = half depth (z). Ends capped unless `caps` is false.
 *  Shade per vertex darkens the back face a little (baked occlusion); backFace: false
 *  drops the face pointing to -z (never seen from the street) to save triangles. */
export function sweepBar(W, pts, hw, hd, { closed = false, caps = true, z0 = 0, back = 0.85, backFace = true } = {}) {
  const n = pts.length;
  if (n < 2) return;
  const segs = closed ? n : n - 1;
  // in-plane mitred normals
  const nx = new Float32Array(n), ny = new Float32Array(n), sc = new Float32Array(n);
  const segN = [];
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = len2(dx, dy) || 1;
    segN.push([-dy / l, dx / l]);
  }
  for (let i = 0; i < n; i++) {
    let A, B;
    if (closed) { A = segN[(i - 1 + segs) % segs]; B = segN[i % segs]; }
    else { A = segN[Math.max(0, i - 1)]; B = segN[Math.min(segs - 1, i)]; }
    let mx = A[0] + B[0], my = A[1] + B[1];
    const ml = len2(mx, my) || 1; mx /= ml; my /= ml;
    const d = Math.max(0.35, mx * A[0] + my * A[1]);
    nx[i] = mx; ny[i] = my; sc[i] = 1 / d;
  }
  // arc length for uv
  const len = new Float32Array(n);
  for (let i = 1; i < n; i++) len[i] = len[i - 1] + len2(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const ring = (i) => {
    const p = pts[i], ox = nx[i] * hw * sc[i], oy = ny[i] * hw * sc[i], L = len[i];
    // 4 faces x 2 verts: front (+z), side +n, back (-z), side -n
    const zf = z0 + hd, zb = z0 - hd;
    return [
      W.v(p[0] + ox, p[1] + oy, zf, 0, 0, 1, L, hw), W.v(p[0] - ox, p[1] - oy, zf, 0, 0, 1, L, -hw),
      W.v(p[0] + ox, p[1] + oy, zb, nx[i], ny[i], 0, L, -hd), W.v(p[0] + ox, p[1] + oy, zf, nx[i], ny[i], 0, L, hd),
      W.v(p[0] - ox, p[1] - oy, zb, 0, 0, -1, L, -hw, back), W.v(p[0] + ox, p[1] + oy, zb, 0, 0, -1, L, hw, back),
      W.v(p[0] - ox, p[1] - oy, zf, -nx[i], -ny[i], 0, L, hd), W.v(p[0] - ox, p[1] - oy, zb, -nx[i], -ny[i], 0, L, -hd),
    ];
  };
  const first = ring(0);
  let prev = first;
  for (let i = 1; i <= segs; i++) {
    const cur = (closed && i === n) ? first : ring(i);
    for (let f = 0; f < 4; f++) {
      if (f === 2 && !backFace) continue;
      // (first -> second) x tangent = outward normal, so this quad faces outward
      W.quad(prev[f * 2], prev[f * 2 + 1], cur[f * 2 + 1], cur[f * 2]);
    }
    prev = cur;
  }
  if (caps && !closed) {
    capEnd(W, pts, 0, nx, ny, sc, hw, hd, z0, -1);
    capEnd(W, pts, n - 1, nx, ny, sc, hw, hd, z0, +1);
  }
}

function capEnd(W, pts, i, nx, ny, sc, hw, hd, z0, dirSign) {
  const p = pts[i], q = pts[i + (dirSign > 0 ? -1 : 1)];
  let tx = p[0] - q[0], ty = p[1] - q[1];
  const l = len2(tx, ty) || 1; tx /= l; ty /= l;
  const ox = nx[i] * hw * sc[i], oy = ny[i] * hw * sc[i];
  const a = W.v(p[0] + ox, p[1] + oy, z0 + hd, tx, ty, 0, 0, 0);
  const b = W.v(p[0] - ox, p[1] - oy, z0 + hd, tx, ty, 0, 1, 0);
  const c = W.v(p[0] - ox, p[1] - oy, z0 - hd, tx, ty, 0, 1, 1);
  const d = W.v(p[0] + ox, p[1] + oy, z0 - hd, tx, ty, 0, 0, 1);
  if (dirSign > 0) W.quad(a, b, c, d); else W.quad(a, d, c, b);
}

/** Axis-aligned box centred at (cx, cy, cz). `skip` lists faces never seen, to save
 *  vertices: f/b (+z/-z), r/l (+x/-x), u/d (+y/-y). */
export function box(W, cx, cy, cz, sx, sy, sz, shadeBottom = 1, skip = '') {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
  const F = (ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, n, uvw, s = 1) => {
    const a = W.v(ax, ay, az, n[0], n[1], n[2], uvw[0][0], uvw[0][1], s);
    const b = W.v(bx, by, bz, n[0], n[1], n[2], uvw[1][0], uvw[1][1], s);
    const c = W.v(cx2, cy2, cz2, n[0], n[1], n[2], uvw[2][0], uvw[2][1], s);
    const d = W.v(dx, dy, dz, n[0], n[1], n[2], uvw[3][0], uvw[3][1], s);
    W.quad(a, b, c, d);
  };
  if (!skip.includes('f')) F(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, [0, 0, 1], [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  if (!skip.includes('b')) F(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, [0, 0, -1], [[x1, y0], [x0, y0], [x0, y1], [x1, y1]]);
  if (!skip.includes('r')) F(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, [1, 0, 0], [[z1, y0], [z0, y0], [z0, y1], [z1, y1]]);
  if (!skip.includes('l')) F(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, [-1, 0, 0], [[z0, y0], [z1, y0], [z1, y1], [z0, y1]]);
  if (!skip.includes('u')) F(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, [0, 1, 0], [[x0, z1], [x1, z1], [x1, z0], [x0, z0]]);
  if (!skip.includes('d')) F(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, [0, -1, 0], [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], shadeBottom);
}

/** Position-only box (8 shared corners, same faces and winding as box()). */
export function boxPos(S, cx, cy, cz, sx, sy, sz, skip = '') {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
  const b = S.count;
  // corner k: bit 0 = x1, bit 1 = y1, bit 2 = z1
  for (let k = 0; k < 8; k++) S.v(k & 1 ? x1 : x0, k & 2 ? y1 : y0, k & 4 ? z1 : z0);
  if (!skip.includes('f')) S.quad(b + 4, b + 5, b + 7, b + 6);
  if (!skip.includes('b')) S.quad(b + 1, b + 0, b + 2, b + 3);
  if (!skip.includes('r')) S.quad(b + 5, b + 1, b + 3, b + 7);
  if (!skip.includes('l')) S.quad(b + 0, b + 4, b + 6, b + 2);
  if (!skip.includes('u')) S.quad(b + 6, b + 7, b + 3, b + 2);
  if (!skip.includes('d')) S.quad(b + 0, b + 1, b + 5, b + 4);
}

/** Surface of revolution around +Y. profile: [[r, y], ...] from bottom to top. */
export function lathe(W, profile, segments = 16, { cx = 0, cy = 0, cz = 0, phase = 0, capTop = false, capBottom = false } = {}) {
  const m = profile.length;
  // profile normals (smooth): average of adjacent edge normals
  const pn = [];
  for (let j = 0; j < m; j++) {
    const a = profile[Math.max(0, j - 1)], b = profile[Math.min(m - 1, j + 1)];
    let dr = b[0] - a[0], dy = b[1] - a[1];
    const l = len2(dr, dy) || 1; dr /= l; dy /= l;
    pn.push([dy, -dr]); // outward for a profile going up
  }
  const vlen = [0];
  for (let j = 1; j < m; j++) vlen.push(vlen[j - 1] + len2(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  const base = W.count;
  for (let i = 0; i <= segments; i++) {
    const t = phase + (i / segments) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    for (let j = 0; j < m; j++) {
      const [r, y] = profile[j];
      W.v(cx + c * r, cy + y, cz + s * r, c * pn[j][0], pn[j][1], s * pn[j][0], (i / segments) * Math.PI * 2 * 0.1, vlen[j]);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < m - 1; j++) {
      const a = base + i * m + j, b = base + (i + 1) * m + j;
      W.quad(a, a + 1, b + 1, b);
    }
  }
  if (capTop) {
    const [r, y] = profile[m - 1];
    const c0 = W.v(cx, cy + y, cz, 0, 1, 0, 0, 0);
    const ring = [];
    for (let i = 0; i <= segments; i++) { const t = phase + (i / segments) * Math.PI * 2; ring.push(W.v(cx + Math.cos(t) * r, cy + y, cz + Math.sin(t) * r, 0, 1, 0, Math.cos(t) * r, Math.sin(t) * r)); }
    for (let i = 0; i < segments; i++) W.tri(c0, ring[i + 1], ring[i]);
  }
  if (capBottom) {
    const [r, y] = profile[0];
    const c0 = W.v(cx, cy + y, cz, 0, -1, 0, 0, 0);
    const ring = [];
    for (let i = 0; i <= segments; i++) { const t = phase + (i / segments) * Math.PI * 2; ring.push(W.v(cx + Math.cos(t) * r, cy + y, cz + Math.sin(t) * r, 0, -1, 0, Math.cos(t) * r, Math.sin(t) * r)); }
    for (let i = 0; i < segments; i++) W.tri(c0, ring[i], ring[i + 1]);
  }
}

/** Plan frame of a path: segment normals (sn, 2 per segment), mitre directions and
 *  scales at the points (mu, mw, ms), arc length (plen) and, per interior point, whether
 *  it turns by less than `smoothTurn` radians (smooth). */
function pathFrame(path, smoothTurn = 0) {
  const n = path.length;
  const sn = new Float32Array(Math.max(1, n - 1) * 2);
  for (let i = 0; i < n - 1; i++) {
    const du = path[i + 1][0] - path[i][0], dw = path[i + 1][1] - path[i][1], l = len2(du, dw) || 1;
    sn[i * 2] = -dw / l; sn[i * 2 + 1] = du / l;
  }
  const mu = new Float32Array(n), mw = new Float32Array(n), ms = new Float32Array(n), plen = new Float32Array(n);
  const smooth = new Uint8Array(n), cosT = Math.cos(smoothTurn);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1) * 2, b = Math.min(n - 2, i) * 2;
    let x = sn[a] + sn[b], z = sn[a + 1] + sn[b + 1];
    const l = len2(x, z) || 1; x /= l; z /= l;
    mu[i] = x; mw[i] = z; ms[i] = 1 / Math.max(0.3, x * sn[a] + z * sn[a + 1]);
    if (i > 0) plen[i] = plen[i - 1] + len2(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    smooth[i] = i > 0 && i < n - 1 && sn[a] * sn[b] + sn[a + 1] * sn[b + 1] > cosT ? 1 : 0;
  }
  return { n, sn, mu, mw, ms, plen, smooth };
}

/** Sweep a moulding profile along an open plan path (facade u, w plane).
 *  path: [[u, w], ...] traversed so the outside is on the left of travel when seen from
 *  above (n = (-tw, tu)). profile: [[o, v], ...] where o is the outward offset from the
 *  path (≤ 0 inside) and v the height, ordered from the top edge down to the soffit.
 *  shadeFn(o, v) returns an occlusion factor per profile point. Profile joints from
 *  `smoothFrom` on are smooth (one shared vertex), the others hard; path corners turning
 *  by less than `smoothTurn` radians (rounded corners) share their ring and shade
 *  smoothly along the run, sharper corners are hard. */
export function sweepPath(W, path, profile, { shadeFn = null, smoothFrom = 1e9, smoothTurn = 0.6 } = {}) {
  const m = profile.length;
  const { n, sn, mu, mw, ms, plen, smooth } = pathFrame(path, smoothTurn);
  // profile edge normals in (o, v) and the distance along the profile (uv v)
  const eo = new Float32Array(m - 1), ev = new Float32Array(m - 1), vacc = new Float32Array(m);
  for (let j = 0; j < m - 1; j++) {
    const dO = profile[j + 1][0] - profile[j][0], dV = profile[j + 1][1] - profile[j][1], l = len2(dO, dV) || 1;
    eo[j] = -dV / l; ev[j] = dO / l; vacc[j + 1] = vacc[j] + l;
  }
  // vertex slots across the profile (o, v, normal o, normal v, uv v, shade): one per
  // smooth joint, two per hard joint; edge j runs from slot e0[j] to slot e1[j]
  const S = [], e0 = new Int32Array(m - 1), e1 = new Int32Array(m - 1);
  for (let j = 0; j < m; j++) {
    const o = profile[j][0], v = profile[j][1], sh = shadeFn ? shadeFn(o, v) : 1;
    if (j > 0 && j < m - 1 && j >= smoothFrom) {
      let no = eo[j - 1] + eo[j], nv = ev[j - 1] + ev[j];
      const l = len2(no, nv) || 1; no /= l; nv /= l;
      e1[j - 1] = e0[j] = S.length / 6;
      S.push(o, v, no, nv, vacc[j], sh);
    } else {
      if (j > 0) { e1[j - 1] = S.length / 6; S.push(o, v, eo[j - 1], ev[j - 1], vacc[j], sh); }
      if (j < m - 1) { e0[j] = S.length / 6; S.push(o, v, eo[j], ev[j], vacc[j], sh); }
    }
  }
  const ns = S.length / 6;
  const ring = (i, nx, nz) => {
    const base = W.count, px = path[i][0], pz = path[i][1], kx = mu[i] * ms[i], kz = mw[i] * ms[i], u = plen[i];
    W.reserve(ns, 0);
    for (let k = 0; k < ns * 6; k += 6) {
      const o = S[k], no = S[k + 2];
      W.v(px + kx * o, S[k + 1], pz + kz * o, nx * no, S[k + 3], nz * no, u, S[k + 4], S[k + 5]);
    }
    return base;
  };
  W.reserve(0, (n - 1) * (m - 1) * 6);
  let prev = ring(0, sn[0], sn[1]);
  for (let i = 0; i < n - 1; i++) {
    const last = i + 1 === n - 1, sm = smooth[i + 1];
    const end = sm ? ring(i + 1, mu[i + 1], mw[i + 1]) : ring(i + 1, sn[i * 2], sn[i * 2 + 1]);
    for (let j = 0; j < m - 1; j++) W.quad(prev + e0[j], prev + e1[j], end + e1[j], end + e0[j]);
    // a hard corner starts the next segment on a ring of its own (flat across the mitre)
    prev = sm || last ? end : ring(i + 1, sn[(i + 1) * 2], sn[(i + 1) * 2 + 1]);
  }
}

/** Position-only sweep of a closed or open profile along a path (shadow casters): one
 *  ring per path point, same winding as sweepPath. Returns the ring base indices. */
export function sweepPathPos(S, path, profile) {
  const m = profile.length;
  const { n, mu, mw, ms } = pathFrame(path);
  S.reserve(n * m, (n - 1) * (m - 1) * 6);
  const rings = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    rings[i] = S.count;
    const px = path[i][0], pz = path[i][1], kx = mu[i] * ms[i], kz = mw[i] * ms[i];
    for (let j = 0; j < m; j++) S.v(px + kx * profile[j][0], profile[j][1], pz + kz * profile[j][0]);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    for (let j = 0; j < m - 1; j++) S.quad(a + j, a + j + 1, b + j + 1, b + j);
  }
  return rings;
}

/** Inset a plan path by distance o along its mitred normals (o < 0 moves inside). */
export function insetPath(path, o) {
  const n = path.length;
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const a = path[i], b = path[i + 1];
    const du = b[0] - a[0], dw = b[1] - a[1], l = len2(du, dw) || 1;
    segN.push([-dw / l, du / l]);
  }
  return path.map((P, i) => {
    const A = segN[Math.max(0, i - 1)], B = segN[Math.min(n - 2, i)];
    let mu = A[0] + B[0], mw = A[1] + B[1];
    const l = len2(mu, mw) || 1; mu /= l; mw /= l;
    const s = 1 / Math.max(0.3, mu * A[0] + mw * A[1]);
    return [P[0] + mu * o * s, P[1] + mw * o * s];
  });
}

/** Horizontal cap over a convex plan polygon [[u, w], ...] at height v, facing up (+1) or
 *  down (-1). shade: number or (u, w) => number. */
export function capPolygon(W, poly, v, facing = 1, shade = 1) {
  const idx = poly.map(([u, w]) => W.v(u, v, w, 0, facing, 0, u, w, typeof shade === 'function' ? shade(u, w) : shade));
  for (let i = 1; i < idx.length - 1; i++) {
    if (facing > 0) W.tri(idx[0], idx[i], idx[i + 1]);
    else W.tri(idx[0], idx[i + 1], idx[i]);
  }
}

/** Mark a geometry as shared so chunk disposal leaves it alone. */
export function shared(g) { g.userData.shared = true; return g; }
