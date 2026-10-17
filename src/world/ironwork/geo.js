import * as THREE from 'three';

// Low-level geometry writers for the ironwork module. Everything writes straight into
// flat arrays (no intermediate BufferGeometry clones) so chunk builds stay cheap.
// UVs are in metres, like every library material expects.

/** Accumulates an indexed triangle mesh: position, normal, uv, color. An optional
 *  matrix transforms positions (and normals) as they are written. */
export class GeoWriter {
  constructor() {
    this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = [];
    this.m = null; this.nm = null;
    this.r = 1; this.g = 1; this.b = 1;
  }
  get count() { return this.pos.length / 3; }
  setMatrix(m) {
    this.m = m ? m.elements.slice() : null;
    this.nm = m ? new THREE.Matrix3().getNormalMatrix(m).elements : null;
    return this;
  }
  color(r, g, b) { this.r = r; this.g = g; this.b = b; return this; }
  /** Adds a vertex, returns its index. Optional per-vertex shade multiplies the current colour. */
  v(x, y, z, nx, ny, nz, u, w, shade = 1) {
    const m = this.m;
    if (m) {
      const X = m[0] * x + m[4] * y + m[8] * z + m[12];
      const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
      const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
      const n = this.nm;
      let NX = n[0] * nx + n[3] * ny + n[6] * nz;
      let NY = n[1] * nx + n[4] * ny + n[7] * nz;
      let NZ = n[2] * nx + n[5] * ny + n[8] * nz;
      const l = Math.hypot(NX, NY, NZ) || 1;
      this.pos.push(X, Y, Z); this.nor.push(NX / l, NY / l, NZ / l);
    } else {
      this.pos.push(x, y, z); this.nor.push(nx, ny, nz);
    }
    this.uv.push(u, w);
    this.col.push(this.r * shade, this.g * shade, this.b * shade);
    return this.pos.length / 3 - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  /** Quad a-b-c-d counter-clockwise (front-facing). */
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  toGeometry({ colors = true } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    const n = this.pos.length / 3;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
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
    acc += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
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
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    segN.push([-dy / l, dx / l]);
  }
  for (let i = 0; i < n; i++) {
    let A, B;
    if (closed) { A = segN[(i - 1 + segs) % segs]; B = segN[i % segs]; }
    else { A = segN[Math.max(0, i - 1)]; B = segN[Math.min(segs - 1, i)]; }
    let mx = A[0] + B[0], my = A[1] + B[1];
    const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
    const d = Math.max(0.35, mx * A[0] + my * A[1]);
    nx[i] = mx; ny[i] = my; sc[i] = 1 / d;
  }
  // arc length for uv
  const len = new Float32Array(n);
  for (let i = 1; i < n; i++) len[i] = len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
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
  const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
  const ox = nx[i] * hw * sc[i], oy = ny[i] * hw * sc[i];
  const a = W.v(p[0] + ox, p[1] + oy, z0 + hd, tx, ty, 0, 0, 0);
  const b = W.v(p[0] - ox, p[1] - oy, z0 + hd, tx, ty, 0, 1, 0);
  const c = W.v(p[0] - ox, p[1] - oy, z0 - hd, tx, ty, 0, 1, 1);
  const d = W.v(p[0] + ox, p[1] + oy, z0 - hd, tx, ty, 0, 0, 1);
  if (dirSign > 0) W.quad(a, b, c, d); else W.quad(a, d, c, b);
}

/** Axis-aligned box (optionally chamfer-free) centred at (cx, cy, cz). */
export function box(W, cx, cy, cz, sx, sy, sz, shadeBottom = 1) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
  const F = (ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, n, uvw, s = 1) => {
    const a = W.v(ax, ay, az, n[0], n[1], n[2], uvw[0][0], uvw[0][1], s);
    const b = W.v(bx, by, bz, n[0], n[1], n[2], uvw[1][0], uvw[1][1], s);
    const c = W.v(cx2, cy2, cz2, n[0], n[1], n[2], uvw[2][0], uvw[2][1], s);
    const d = W.v(dx, dy, dz, n[0], n[1], n[2], uvw[3][0], uvw[3][1], s);
    W.quad(a, b, c, d);
  };
  // +z
  F(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, [0, 0, 1], [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  // -z
  F(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, [0, 0, -1], [[x1, y0], [x0, y0], [x0, y1], [x1, y1]]);
  // +x
  F(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, [1, 0, 0], [[z1, y0], [z0, y0], [z0, y1], [z1, y1]]);
  // -x
  F(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, [-1, 0, 0], [[z0, y0], [z1, y0], [z1, y1], [z0, y1]]);
  // +y
  F(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, [0, 1, 0], [[x0, z1], [x1, z1], [x1, z0], [x0, z0]]);
  // -y
  F(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, [0, -1, 0], [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], shadeBottom);
}

/** Surface of revolution around +Y. profile: [[r, y], ...] from bottom to top. */
export function lathe(W, profile, segments = 16, { cx = 0, cy = 0, cz = 0, phase = 0, capTop = false, capBottom = false } = {}) {
  const m = profile.length;
  // profile normals (smooth): average of adjacent edge normals
  const pn = [];
  for (let j = 0; j < m; j++) {
    const a = profile[Math.max(0, j - 1)], b = profile[Math.min(m - 1, j + 1)];
    let dr = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dr, dy) || 1; dr /= l; dy /= l;
    pn.push([dy, -dr]); // outward for a profile going up
  }
  const vlen = [0];
  for (let j = 1; j < m; j++) vlen.push(vlen[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
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

/** Sweep a moulding profile along an open plan path (facade u, w plane).
 *  path: [[u, w], ...] traversed so the outside is on the left of travel when seen from
 *  above (n = (-tw, tu)). profile: [[o, v], ...] where o is the outward offset from the
 *  path (≤ 0 inside) and v the height, ordered from the top edge down to the soffit.
 *  shadeFn(o, v) returns an occlusion factor per vertex. */
export function sweepPath(W, path, profile, { shadeFn = null, smoothFrom = 1e9 } = {}) {
  const n = path.length, m = profile.length;
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const a = path[i], b = path[i + 1];
    const du = b[0] - a[0], dw = b[1] - a[1], l = Math.hypot(du, dw) || 1;
    segN.push([-dw / l, du / l]);
  }
  const mit = [];
  for (let i = 0; i < n; i++) {
    const A = segN[Math.max(0, i - 1)], B = segN[Math.min(n - 2, i)];
    let mu = A[0] + B[0], mw = A[1] + B[1];
    const l = Math.hypot(mu, mw) || 1; mu /= l; mw /= l;
    mit.push([mu, mw, 1 / Math.max(0.3, mu * A[0] + mw * A[1])]);
  }
  // corners are hard: duplicate rings at interior path points (flat across the mitre)
  const plen = [0];
  for (let i = 1; i < n; i++) plen.push(plen[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  // profile edge normals (per edge) in (o, v)
  const en = [];
  const vacc = [0];
  for (let j = 0; j < m - 1; j++) {
    const dO = profile[j + 1][0] - profile[j][0], dV = profile[j + 1][1] - profile[j][1];
    const l = Math.hypot(dO, dV) || 1;
    en.push([-dV / l, dO / l]);
    vacc.push(vacc[j] + l);
  }
  for (let i = 0; i < n - 1; i++) {
    const segNorm = segN[i];
    // two rings: at path i and i+1 for this segment (flat-shaded across segments)
    const ringIdx = [[], []];
    for (let k = 0; k < 2; k++) {
      const pi = i + k, P = path[pi], M = mit[pi];
      for (let j = 0; j < m - 1; j++) {
        for (let e = 0; e < 2; e++) {
          const [o, v] = profile[j + e];
          // smooth profile normals for curved mouldings: average adjacent edges
          let no = en[j][0], nv = en[j][1];
          if (j + e > 0 && j + e < m - 1 && j + e >= smoothFrom) {
            const a = en[j + e - 1], b = en[Math.min(m - 2, j + e)];
            no = (a[0] + b[0]) / 2; nv = (a[1] + b[1]) / 2;
            const l = Math.hypot(no, nv) || 1; no /= l; nv /= l;
          }
          const x = P[0] + M[0] * o * M[2], z = P[1] + M[1] * o * M[2];
          const shade = shadeFn ? shadeFn(o, v) : 1;
          ringIdx[k].push(W.v(x, v, z, segNorm[0] * no, nv, segNorm[1] * no, plen[pi], vacc[j + e], shade));
        }
      }
    }
    for (let j = 0; j < m - 1; j++) {
      const a0 = ringIdx[0][j * 2], a1 = ringIdx[0][j * 2 + 1], b0 = ringIdx[1][j * 2], b1 = ringIdx[1][j * 2 + 1];
      W.quad(a0, a1, b1, b0);
    }
  }
}

/** Inset a plan path by distance o along its mitred normals (o < 0 moves inside). */
export function insetPath(path, o) {
  const n = path.length;
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const a = path[i], b = path[i + 1];
    const du = b[0] - a[0], dw = b[1] - a[1], l = Math.hypot(du, dw) || 1;
    segN.push([-dw / l, du / l]);
  }
  return path.map((P, i) => {
    const A = segN[Math.max(0, i - 1)], B = segN[Math.min(n - 2, i)];
    let mu = A[0] + B[0], mw = A[1] + B[1];
    const l = Math.hypot(mu, mw) || 1; mu /= l; mw /= l;
    const s = 1 / Math.max(0.3, mu * A[0] + mw * A[1]);
    return [P[0] + mu * o * s, P[1] + mw * o * s];
  });
}

/** Horizontal cap over a convex plan polygon [[u, w], ...] at height v, facing up (+1) or down (-1). */
export function capPolygon(W, poly, v, facing = 1, shade = 1) {
  const idx = poly.map(([u, w]) => W.v(u, v, w, 0, facing, 0, u, w, shade));
  for (let i = 1; i < idx.length - 1; i++) {
    if (facing > 0) W.tri(idx[0], idx[i], idx[i + 1]);
    else W.tri(idx[0], idx[i + 1], idx[i]);
  }
}

/** Mark a geometry as shared so chunk disposal leaves it alone. */
export function shared(g) { g.userData.shared = true; return g; }
