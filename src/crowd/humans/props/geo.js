import * as THREE from 'three';

// Geometry builder for the mobility props (bicycles, strollers). Everything is built as
// parametric grid surfaces (sweeps along rotation-minimising frames, surfaces of
// revolution, lofts) with analytic-quality smooth normals from the grid, so thin tubes,
// tyres and fabric shells shade cleanly at any size.
//
// Every vertex carries, besides position / normal / uv:
//   color (vec4)  rgb: linear albedo (or a multiplier for the paint / fabric channels), a: baked occlusion
//   aMat  (vec4)  roughness, metalness, shading channel (CH), channel parameter (clearcoat / tread kind / mesh line width)
//   aPiv  (vec4)  animation pivot xyz (prop-local metres), piece id (PIECE)
//   aAux  (vec4)  piece parameters (steering axis, bottom bracket, slide direction, caster hub)
// The material (shading.js) animates the pieces per instance and shades per channel.

export const PIECE = {
  STATIC: 0,
  STEER: 1,        // rotates about the steering axis (aAux: axis point y, z; head angle; -)
  FWHEEL: 2,       // spins about X through aPiv by anim.y, then steers (aAux as STEER)
  RWHEEL: 3,       // spins about X through aPiv by anim.x
  CRANK: 4,        // spins about X through aPiv (bottom bracket) by anim.z
  PEDAL: 5,        // orbits the bottom bracket (aAux.xy = bb y, z) with the crank, stays level; aPiv = spindle at crank 0
  STAND_DOWN: 6,   // shown when flag STAND is set (collapsed to aPiv otherwise)
  STAND_UP: 7,     // shown when flag STAND is clear
  BABY: 8,         // shown when flag BABY is set
  CASTER: 9,       // swivels about the vertical through aPiv by anim.w
  CASTER_WHEEL: 10,// spins about X through aAux.xyz by anim.y, then swivels about the vertical through aPiv
  SADDLE: 11,      // slides along aAux.xyz (unit) by anim.y metres (saddle height)
  FWHEEL_S: 12,    // stroller front wheel without swivel: spins about X through aPiv by anim.y
};

export const CH = {
  PLAIN: 0,
  PAINT_A: 1,   // albedo x instance colour A (finish / wear from the instance)
  PAINT_B: 2,   // albedo x instance colour B
  TREAD: 3,     // tyre tread relief (aMat.w = tread kind)
  SPOKES: 4,    // alpha from the spoke atlas (uv)
  MESH: 5,      // procedural wire / net grid alpha (uv in cells, aMat.w = line width fraction)
  FABRIC_A: 6,  // fabric with weave, colour = instance colour A x vertex colour
  FABRIC_B: 7,  // fabric, instance colour B
  SKIN: 8,      // baby skin (tone from instance flags)
  CLOTH: 9,     // baby clothes (palette from instance flags)
  LEATHER: 10,  // grain relief (saddles, grips)
  REFLECT: 11,  // red / amber reflector (faint sparkle)
};

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _n3 = new THREE.Matrix3();

export const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Circle profile (CCW in the N-B plane), seg points. */
export function circle(seg, rx = 1, ry = rx, phase = 0) {
  const out = [];
  for (let j = 0; j < seg; j++) {
    const t = phase + (j / seg) * Math.PI * 2;
    out.push([Math.cos(t) * rx, Math.sin(t) * ry]);
  }
  return out;
}

/** Rounded rectangle profile (CCW), half sizes hx, hy, corner radius r. */
export function roundRect(hx, hy, r, cornerSeg = 2) {
  r = Math.min(r, hx, hy);
  const out = [];
  const corners = [[hx - r, hy - r, 0], [-hx + r, hy - r, 1], [-hx + r, -hy + r, 2], [hx - r, -hy + r, 3]];
  for (const [cx, cy, q] of corners) {
    for (let k = 0; k <= cornerSeg; k++) {
      const t = (q + k / cornerSeg) * (Math.PI / 2);
      out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
    }
  }
  return out;
}

/** Points along a curve (THREE.Curve or array of control points through a centripetal Catmull-Rom). */
export function curveOf(pts, closed = false) {
  if (pts.isCurve) return pts;
  if (pts.length === 2) return new THREE.LineCurve3(pts[0], pts[1]);
  return new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
}

/** Sample a curve uniformly by arc length into n+1 points. */
export function samplePath(curve, n) {
  const c = curveOf(curve);
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(c.getPointAt(i / n));
  return pts;
}

/** Number of segments for a curve: one per `step` radians of turning (min 1), plus length cap. */
export function segsFor(curve, stepRad, maxLen = 0.25) {
  const c = curveOf(curve);
  const L = c.getLength();
  let turn = 0;
  const N = 24;
  let prev = c.getTangentAt(0);
  for (let i = 1; i <= N; i++) {
    const t = c.getTangentAt(i / N);
    turn += Math.acos(Math.max(-1, Math.min(1, prev.dot(t))));
    prev = t;
  }
  return Math.max(1, Math.ceil(turn / stepRad), Math.ceil(L / maxLen));
}

/** Rotation-minimising frames (double reflection) along points; N0 seeds the first normal. */
export function rmf(pts, N0, closed = false) {
  const n = pts.length;
  const T = [], N = [], B = [];
  for (let i = 0; i < n; i++) {
    let a = pts[i > 0 ? i - 1 : (closed ? n - 2 : 0)];
    let b = pts[i < n - 1 ? i + 1 : (closed ? 1 : n - 1)];
    T.push(new THREE.Vector3().subVectors(b, a).normalize());
  }
  let r = (N0 ? N0.clone() : new THREE.Vector3(1, 0, 0));
  r.addScaledVector(T[0], -r.dot(T[0]));
  if (r.lengthSq() < 1e-8) { r.set(0, 1, 0).addScaledVector(T[0], -T[0].y); if (r.lengthSq() < 1e-8) r.set(0, 0, 1); }
  r.normalize();
  N.push(r.clone());
  B.push(new THREE.Vector3().crossVectors(T[0], r));
  for (let i = 0; i < n - 1; i++) {
    const v1 = _a.subVectors(pts[i + 1], pts[i]);
    const c1 = v1.dot(v1);
    let rL, tL;
    if (c1 < 1e-14) { rL = N[i].clone(); tL = T[i].clone(); }
    else {
      rL = N[i].clone().addScaledVector(v1, (-2 / c1) * v1.dot(N[i]));
      tL = T[i].clone().addScaledVector(v1, (-2 / c1) * v1.dot(T[i]));
    }
    const v2 = _b.subVectors(T[i + 1], tL);
    const c2 = v2.dot(v2);
    const rn = c2 < 1e-14 ? rL : rL.addScaledVector(v2, (-2 / c2) * v2.dot(rL));
    rn.addScaledVector(T[i + 1], -rn.dot(T[i + 1])).normalize();
    N.push(rn);
    B.push(new THREE.Vector3().crossVectors(T[i + 1], rn));
  }
  return { T, N, B };
}

const DEFAULT_STATE = {
  col: [0.5, 0.5, 0.5], ao: 1, rough: 0.5, metal: 0, ch: CH.PLAIN, w: 0,
  piece: PIECE.STATIC, piv: [0, 0, 0], aux: [0, 0, 0, 0], aoFn: null,
};

export class Builder {
  constructor() {
    this.P = []; this.N = []; this.T = []; this.C = []; this.M = []; this.Q = []; this.X = []; this.I = [];
    this.s = { ...DEFAULT_STATE };
    this.xf = null;
    this.nxf = null;
  }

  get count() { return this.P.length / 3; }

  /** Run fn with a modified state (material, piece...), restoring it afterwards. */
  with(state, fn) {
    const prev = this.s;
    this.s = { ...prev, ...state };
    try { fn(); } finally { this.s = prev; }
    return this;
  }

  /** Run fn with every emitted vertex transformed by matrix m (pivots are NOT transformed). */
  xform(m, fn) {
    const prev = this.xf, prevN = this.nxf;
    this.xf = prev ? prev.clone().multiply(m) : m.clone();
    this.nxf = new THREE.Matrix3().getNormalMatrix(this.xf);
    try { fn(); } finally { this.xf = prev; this.nxf = prevN; }
    return this;
  }

  vert(p, n, u, v) {
    let px = p.x, py = p.y, pz = p.z, nx = n.x, ny = n.y, nz = n.z;
    if (this.xf) {
      _c.set(px, py, pz).applyMatrix4(this.xf); px = _c.x; py = _c.y; pz = _c.z;
      _c.set(nx, ny, nz).applyMatrix3(this.nxf).normalize(); nx = _c.x; ny = _c.y; nz = _c.z;
    }
    const s = this.s;
    this.P.push(px, py, pz);
    this.N.push(nx, ny, nz);
    this.T.push(u, v);
    const ao = s.aoFn ? s.ao * s.aoFn(px, py, pz, nx, ny, nz) : s.ao;
    this.C.push(s.col[0], s.col[1], s.col[2], ao);
    this.M.push(s.rough, s.metal, s.ch, s.w);
    this.Q.push(s.piv[0], s.piv[1], s.piv[2], s.piece);
    this.X.push(s.aux[0], s.aux[1], s.aux[2], s.aux[3]);
    return this.P.length / 3 - 1;
  }

  tri(a, b, c) { this.I.push(a, b, c); }

  /**
   * Grid surface. rows[i][j] are Vector3s. Normals = cross(dP/dj, dP/di) from central differences
   * (wrapping where requested); `out(p, i, j)` returns a reference outward direction used to orient the
   * whole surface by majority vote. uv(i, j) -> [u, v] (default: arc lengths in metres).
   * twoSided emits a second, reversed copy (thin sheets: spoke cones, flags).
   */
  surface(rows, { wrapI = false, wrapJ = false, out = null, uv = null, twoSided = false, flip = null } = {}) {
    const ni = rows.length, nj = rows[0].length;
    const idx = (i, wrap, n) => (wrap ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
    const nor = new Array(ni * nj);
    let vote = 0;
    const tmp1 = new THREE.Vector3(), tmp2 = new THREE.Vector3();
    for (let i = 0; i < ni; i++) {
      for (let j = 0; j < nj; j++) {
        const di = tmp1.subVectors(rows[idx(i + 1, wrapI, ni)][j], rows[idx(i - 1, wrapI, ni)][j]);
        const dj = tmp2.subVectors(rows[i][idx(j + 1, wrapJ, nj)], rows[i][idx(j - 1, wrapJ, nj)]);
        const n = new THREE.Vector3().crossVectors(dj, di);
        const l = n.length();
        nor[i * nj + j] = l > 1e-12 ? n.multiplyScalar(1 / l) : null;
        if (out && nor[i * nj + j]) {
          const o = out(rows[i][j], i, j);
          if (o) vote += Math.sign(nor[i * nj + j].dot(o));
        }
      }
    }
    // degenerate points (collapsed rings / poles): borrow from the nearest valid row, then column
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < ni; i++) {
        for (let j = 0; j < nj; j++) {
          if (nor[i * nj + j]) continue;
          let src = null;
          for (let k = 1; k < Math.max(ni, nj) && !src; k++) {
            for (const [ii, jj] of pass === 0 ? [[i + k, j], [i - k, j]] : [[i, j + k], [i, j - k]]) {
              if (ii >= 0 && ii < ni && jj >= 0 && jj < nj && nor[ii * nj + jj]) { src = nor[ii * nj + jj]; break; }
            }
          }
          if (src) nor[i * nj + j] = src.clone();
        }
      }
    }
    const flipIt = flip !== null ? flip : vote < 0;
    // uv: arc length along i (first column) and along j (first row) by default
    let U = null, Vv = null;
    if (!uv) {
      U = [0]; for (let i = 1; i < ni; i++) U.push(U[i - 1] + rows[i][0].distanceTo(rows[i - 1][0]));
      Vv = [0]; for (let j = 1; j < nj; j++) Vv.push(Vv[j - 1] + rows[0][j].distanceTo(rows[0][j - 1]));
    }
    // seams: wrapped directions get an extra duplicated row / column so uvs can continue
    const NI = wrapI ? ni + 1 : ni, NJ = wrapJ ? nj + 1 : nj;
    const emit = (sign) => {
      const base = this.count;
      for (let I = 0; I < NI; I++) {
        const i = I % ni;
        for (let J = 0; J < NJ; J++) {
          const j = J % nj;
          const n = nor[i * nj + j] || _b.set(0, 1, 0);
          const nn = _a.copy(n).multiplyScalar(flipIt ? -sign : sign);
          let u, v;
          if (uv) [u, v] = uv(I, J);
          else {
            u = I < ni ? U[I] : U[ni - 1] + rows[0][0].distanceTo(rows[ni - 1][0]);
            v = J < nj ? Vv[J] : Vv[nj - 1] + rows[0][0].distanceTo(rows[0][nj - 1]);
          }
          this.vert(rows[i][j], nn, u, v);
        }
      }
      const rev = flipIt ? sign > 0 : sign < 0;
      for (let I = 0; I < NI - 1; I++) {
        for (let J = 0; J < NJ - 1; J++) {
          const a = base + I * NJ + J, b = base + I * NJ + J + 1, c = base + (I + 1) * NJ + J + 1, d = base + (I + 1) * NJ + J;
          if (!rev) { this.tri(a, b, c); this.tri(a, c, d); }
          else { this.tri(a, c, b); this.tri(a, d, c); }
        }
      }
    };
    emit(1);
    if (twoSided) emit(-1);
    return this;
  }

  /**
   * Sweep a closed 2D profile along a path. path: curve or points; n: path segments;
   * scale(t) -> number or [sx, sy] multiplies the profile; N0 seeds the frame normal.
   * caps: 'round' | 'flat' | null at each end ([start, end] or one value for both).
   */
  sweep(path, profile, { n = null, scale = 1, N0 = null, caps = null, stepRad = 0.2, maxLen = 0.25, closedPath = false, twist = 0 } = {}) {
    const curve = Array.isArray(path) && path.length > 2 && !closedPath ? curveOf(path) : (Array.isArray(path) ? null : path);
    let pts;
    if (curve) pts = samplePath(curve, n || segsFor(curve, stepRad, maxLen));
    else pts = path.map((p) => p.clone());
    const fr = rmf(pts, N0, closedPath);
    const np = pts.length;
    const sc = (t) => { const s = typeof scale === 'function' ? scale(t) : scale; return Array.isArray(s) ? s : [s, s]; };
    const L = [0];
    for (let i = 1; i < np; i++) L.push(L[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = L[np - 1] || 1;
    const rows = [];
    const centres = [];
    const ring = (C, Nf, Bf, s, ang) => {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      return profile.map(([x, y]) => {
        const xx = (x * ca - y * sa) * s[0], yy = (x * sa + y * ca) * s[1];
        return new THREE.Vector3().copy(C).addScaledVector(Nf, xx).addScaledVector(Bf, yy);
      });
    };
    const [c0, c1] = Array.isArray(caps) ? caps : [caps, caps];
    const capRings = (end) => {
      const i = end ? np - 1 : 0;
      const s = sc(end ? 1 : 0);
      const T = fr.T[i].clone().multiplyScalar(end ? 1 : -1);
      const out = [];
      const r = Math.max(s[0], s[1]) * profileRadius(profile);
      const K = 3;
      for (let k = 1; k <= K; k++) {
        const ph = (k / K) * (Math.PI / 2);
        const f = Math.cos(ph);
        const C = pts[i].clone().addScaledVector(T, Math.sin(ph) * r * 0.85);
        out.push({ C, row: ring(C, fr.N[i], fr.B[i], [s[0] * Math.max(f, 0.0), s[1] * Math.max(f, 0.0)], twist * (end ? 1 : 0)) });
      }
      return out;
    };
    if (c0 === 'round') for (const r of capRings(false).reverse()) { rows.push(r.row); centres.push(r.C); }
    for (let i = 0; i < np; i++) {
      const t = L[i] / total;
      rows.push(ring(pts[i], fr.N[i], fr.B[i], sc(t), twist * t));
      centres.push(pts[i]);
    }
    if (c1 === 'round') for (const r of capRings(true)) { rows.push(r.row); centres.push(r.C); }
    this.surface(rows, { wrapJ: true, wrapI: closedPath, out: (p, i) => _c.subVectors(p, centres[i]) });
    if (c0 === 'flat') this.disc(pts[0], fr.T[0].clone().negate(), ring(pts[0], fr.N[0], fr.B[0], sc(0), 0));
    if (c1 === 'flat') this.disc(pts[np - 1], fr.T[np - 1].clone(), ring(pts[np - 1], fr.N[np - 1], fr.B[np - 1], sc(1), twist));
    return { pts, frames: fr };
  }

  /** Round tube along a path. r: radius or fn(t). seg: radial segments. */
  tube(path, r, seg = 8, opts = {}) {
    const prof = circle(seg, 1, 1, opts.phase || 0);
    return this.sweep(path, prof, { ...opts, scale: typeof r === 'function' ? (t) => r(t) : r });
  }

  /** Flat polygon fan (cap) with normal n through the ring points. */
  disc(C, n, ringPts) {
    const base = this.count;
    const nn = n.clone().normalize();
    this.vert(C, nn, 0, 0);
    for (const p of ringPts) this.vert(p, nn, p.x - C.x, p.y - C.y);
    const m = ringPts.length;
    // orient fan CCW seen from n
    const e1 = _a.subVectors(ringPts[0], C), e2 = _b.subVectors(ringPts[1 % m], C);
    const ccw = new THREE.Vector3().crossVectors(e1, e2).dot(nn) > 0;
    for (let k = 0; k < m; k++) {
      const a = base + 1 + k, b = base + 1 + ((k + 1) % m);
      if (ccw) this.tri(base, a, b); else this.tri(base, b, a);
    }
    return this;
  }

  /**
   * Surface of revolution about the X axis through `c`. prof: [[x, r], ...] (open polyline);
   * seg around; a0..a1 angular range (default full turn). uvFn(i, j, angle, profS) optional.
   */
  revolveX(c, prof, seg, { a0 = 0, a1 = Math.PI * 2, uv = null, out = null, twoSided = false } = {}) {
    const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-6;
    const ni = full ? seg : seg + 1;
    const rows = [];
    for (let i = 0; i < ni; i++) {
      const a = a0 + ((a1 - a0) * i) / seg;
      const ca = Math.cos(a), sa = Math.sin(a);
      rows.push(prof.map(([x, r]) => new THREE.Vector3(c.x + x, c.y + r * ca, c.z - r * sa)));
    }
    this.surface(rows, { wrapI: full, out: out || ((p) => _c.set(0, p.y - c.y, p.z - c.z)), uv, twoSided });
    return this;
  }

  /** Surface of revolution about the local Y axis (lathe) at c: prof [[r, y], ...]. */
  revolveY(c, prof, seg, { out = null, uv = null } = {}) {
    const rows = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      rows.push(prof.map(([r, y]) => new THREE.Vector3(c.x + r * ca, c.y + y, c.z - r * sa)));
    }
    this.surface(rows, { wrapI: true, out: out || ((p) => _c.set(p.x - c.x, 0, p.z - c.z)), uv });
    return this;
  }

  /** Ellipsoid centred at c with radii (rx, ry, rz). */
  ellipsoid(c, rx, ry, rz, seg = 12, rings = 8) {
    const rows = [];
    for (let i = 0; i <= rings; i++) {
      const th = (i / rings) * Math.PI;
      const row = [];
      for (let j = 0; j < seg; j++) {
        const ph = (j / seg) * Math.PI * 2;
        row.push(new THREE.Vector3(c.x + rx * Math.sin(th) * Math.cos(ph), c.y + ry * Math.cos(th), c.z + rz * Math.sin(th) * Math.sin(ph)));
      }
      rows.push(row);
    }
    this.surface(rows, { wrapJ: true, out: (p) => _c.subVectors(p, c) });
    return this;
  }

  /** Rounded box (superellipsoid-like) of half sizes h = [hx, hy, hz], corner radius r, in matrix m. */
  rbox(hx, hy, hz, r = 0.005, m = null, seg = 2) {
    r = Math.min(r, hx, hy, hz);
    const rows = [];
    const ring = (y, rr) => roundRect(hx - r + rr, hz - r + rr, rr, seg).map(([x, z]) => new THREE.Vector3(x, y, -z));
    const K = Math.max(1, seg);
    for (let k = 0; k <= K; k++) { const a = (k / K) * (Math.PI / 2); rows.push(ring(-hy + r - Math.cos(a) * r, Math.sin(a) * r + 1e-6)); }
    for (let k = 0; k <= K; k++) { const a = (k / K) * (Math.PI / 2); rows.push(ring(hy - r + Math.sin(a) * r, Math.cos(a) * r + 1e-6)); }
    // close the flat end faces at their centres
    rows.unshift(rows[0].map(() => new THREE.Vector3(0, -hy, 0)));
    rows.push(rows[rows.length - 1].map(() => new THREE.Vector3(0, hy, 0)));
    const run = () => this.surface(rows, { wrapJ: true, out: (p) => p });
    if (m) this.xform(m, run); else run();
    return this;
  }

  /** Loft through closed rings (arrays of Vector3 with equal counts). Ends optionally collapsed. */
  loft(rings, { capStart = null, capEnd = null, out = null } = {}) {
    const rows = rings.slice();
    if (capStart) rows.unshift(rings[0].map(() => capStart.clone()));
    if (capEnd) rows.push(rings[rings.length - 1].map(() => capEnd.clone()));
    const cen = rows.map((r) => r.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / r.length));
    this.surface(rows, { wrapJ: true, out: out || ((p, i) => _c.subVectors(p, cen[i])) });
    return this;
  }

  /** Flat closed polygon prism: outline [[x, y]...] (CCW) in the XY plane, extruded along Z from z0 to z1, in matrix m. */
  prism(outline, z0, z1, m = null) {
    const run = () => {
      const n = outline.length;
      // sides (hard edges: each edge its own quad)
      for (let k = 0; k < n; k++) {
        const [x0, y0] = outline[k], [x1, y1] = outline[(k + 1) % n];
        const ex = x1 - x0, ey = y1 - y0, l = Math.hypot(ex, ey) || 1;
        const nn = new THREE.Vector3(ey / l, -ex / l, 0);
        const b = this.count;
        this.vert(V(x0, y0, z0), nn, 0, 0); this.vert(V(x1, y1, z0), nn, l, 0);
        this.vert(V(x1, y1, z1), nn, l, z1 - z0); this.vert(V(x0, y0, z1), nn, 0, z1 - z0);
        this.tri(b, b + 2, b + 1); this.tri(b, b + 3, b + 2);
      }
      // caps (fan from centroid: outlines used here are star-shaped)
      let cx = 0, cy = 0;
      for (const [x, y] of outline) { cx += x; cy += y; }
      cx /= n; cy /= n;
      for (const [z, nz] of [[z1, 1], [z0, -1]]) {
        const b = this.count;
        const nn = V(0, 0, nz);
        this.vert(V(cx, cy, z), nn, cx, cy);
        for (const [x, y] of outline) this.vert(V(x, y, z), nn, x, y);
        for (let k = 0; k < n; k++) {
          const a = b + 1 + k, c = b + 1 + ((k + 1) % n);
          if (nz > 0) this.tri(b, a, c); else this.tri(b, c, a);
        }
      }
    };
    if (m) this.xform(m, run); else run();
    return this;
  }

  /** Merge another builder's output (already in this space). */
  append(o) {
    const base = this.count;
    this.P.push(...o.P); this.N.push(...o.N); this.T.push(...o.T); this.C.push(...o.C);
    this.M.push(...o.M); this.Q.push(...o.Q); this.X.push(...o.X);
    for (const i of o.I) this.I.push(i + base);
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.N), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.T), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.C), 4));
    g.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(this.M), 4));
    g.setAttribute('aPiv', new THREE.BufferAttribute(new Float32Array(this.Q), 4));
    g.setAttribute('aAux', new THREE.BufferAttribute(new Float32Array(this.X), 4));
    const n = this.count;
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? new Uint32Array(this.I) : new Uint16Array(this.I), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    g.userData.shared = true;
    return g;
  }
}

function profileRadius(profile) {
  let r = 0;
  for (const [x, y] of profile) r = Math.max(r, Math.hypot(x, y));
  return r;
}

/** Matrix from translation + Euler XYZ rotation (radians) + optional scale. */
export function M4(t = [0, 0, 0], r = [0, 0, 0], s = null) {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(...t), new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2])), s ? new THREE.Vector3(...(Array.isArray(s) ? s : [s, s, s])) : new THREE.Vector3(1, 1, 1));
  return m;
}

/** Matrix whose local +Y runs from A to B (unit length scaled to |AB| if stretch), X seeded by `side`. */
export function alongY(A, B, side = V(1, 0, 0)) {
  const y = new THREE.Vector3().subVectors(B, A).normalize();
  let x = side.clone().addScaledVector(y, -side.dot(y));
  if (x.lengthSq() < 1e-8) x = new THREE.Vector3(0, 0, 1).addScaledVector(y, -y.z);
  x.normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  m.setPosition(A);
  return m;
}

/** sRGB hex -> linear [r, g, b]. */
export function lin(hex, k = 1) {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
}

export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
