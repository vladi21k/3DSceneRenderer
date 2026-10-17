import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { normalizeAttributes } from '../../core/geom.js';

// Geometry kit for street furniture. Everything is built once at init, in metres,
// with UVs in metres (1 UV unit = 1 m) so library materials texture it at true scale.
// Authoring frame of every prototype: +Y up, +Z = the item's front, origin on the ground.

const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const toV = (p) => (p.isVector3 ? p : new THREE.Vector3(p[0], p[1], p[2]));

export function makeGeo(pos, nor, uv, idx, extra = null) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (extra) for (const k in extra) g.setAttribute(k, new THREE.Float32BufferAttribute(extra[k].array, extra[k].size));
  g.setIndex(idx);
  return g;
}

/** Per-point normals of a 2D polyline ([[x, y]...]) with automatic creases.
 *  Returns a list of {p, n, t} where creased points are duplicated. Normal = (dy, -dx). */
function polyNormals(pts, closed, crease) {
  const n = pts.length, edges = [];
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1e-9;
    edges.push([dy / l, -dx / l, l]);
  }
  const cosC = Math.cos(crease);
  const out = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const ePrev = closed ? edges[(i - 1 + m) % m] : edges[i - 1];
    const eNext = closed ? edges[i % m] : edges[i];
    if (i > 0) acc += edges[i - 1][2];
    if (ePrev && eNext) {
      const dot = ePrev[0] * eNext[0] + ePrev[1] * eNext[1];
      if (dot < cosC) {
        out.push({ p: pts[i], n: [ePrev[0], ePrev[1]], t: acc, end: true });
        out.push({ p: pts[i], n: [eNext[0], eNext[1]], t: acc, start: true });
      } else {
        const nx = ePrev[0] + eNext[0], ny = ePrev[1] + eNext[1], l = Math.hypot(nx, ny) || 1;
        out.push({ p: pts[i], n: [nx / l, ny / l], t: acc });
      }
    } else {
      const e = ePrev || eNext;
      out.push({ p: pts[i], n: [e[0], e[1]], t: acc });
    }
  }
  if (closed) { // closing vertex (copy of the first ring entry) so UVs wrap cleanly
    const total = acc + edges[m - 1][2];
    // a creased first point starts with an unused 'end' entry; the closing entry takes its role
    const ePrev = edges[m - 1];
    out.push({ p: pts[0], n: out[0].end ? [ePrev[0], ePrev[1]] : out[0].n, t: total });
  }
  return out;
}

/**
 * Surface of revolution around +Y. profile = [[r, y], ...] listed bottom to top along the
 * outside (normals point outward). Creases are automatic (angle > crease).
 */
export function lathe(profile, segs = 16, { crease = 0.6, phi0 = 0, phiLen = Math.PI * 2 } = {}) {
  const prof = polyNormals(profile, false, crease);
  const rMax = Math.max(...profile.map((p) => p[0]), 0.01);
  const pos = [], nor = [], uv = [], idx = [];
  const cols = segs + 1;
  for (const pp of prof) {
    for (let i = 0; i <= segs; i++) {
      const ph = phi0 + (phiLen * i) / segs;
      const s = Math.sin(ph), c = Math.cos(ph);
      pos.push(pp.p[0] * s, pp.p[1], pp.p[0] * c);
      nor.push(pp.n[0] * s, pp.n[1], pp.n[0] * c);
      uv.push(ph * rMax, pp.t);
    }
  }
  for (let j = 0; j < prof.length - 1; j++) {
    if (prof[j].end && prof[j + 1].start) continue; // crease duplicate, no area
    for (let i = 0; i < segs; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return makeGeo(pos, nor, uv, idx);
}

export function circleProfile(r, n = 8) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; out.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return out;
}

/** Rounded rectangle profile (CCW), w along local N (x), h along local B (y). */
export function rectProfile(w, h, r = 0, cseg = 2) {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
  const out = [];
  const corners = [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI], [w / 2 - r, -h / 2 + r, Math.PI * 1.5]];
  for (const [cx, cy, a0] of corners) {
    if (r <= 1e-4) { out.push([cx, cy]); continue; }
    for (let k = 0; k <= cseg; k++) { const a = a0 + (k / cseg) * Math.PI / 2; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  }
  return out;
}

/** Fillet the corners of a polyline with quadratic arcs (bent tube look). */
function filletPath(pts, bend, bendSegs, closed) {
  const n = pts.length;
  if (bend <= 0 || n < 3) return pts.map((p) => p.clone());
  const out = [];
  for (let i = 0; i < n; i++) {
    const P = pts[i];
    const hasPrev = closed || i > 0, hasNext = closed || i < n - 1;
    if (!hasPrev || !hasNext) { out.push(P.clone()); continue; }
    const A0 = pts[(i - 1 + n) % n], B0 = pts[(i + 1) % n];
    const d1 = _v.subVectors(P, A0), l1 = d1.length(); d1.divideScalar(l1 || 1);
    const d2 = _w.subVectors(B0, P), l2 = d2.length(); d2.divideScalar(l2 || 1);
    const th = Math.acos(THREE.MathUtils.clamp(d1.dot(d2), -1, 1));
    if (th < 0.02) { out.push(P.clone()); continue; }
    const t = Math.min(bend * Math.tan(th / 2), 0.48 * l1, 0.48 * l2);
    const A = P.clone().addScaledVector(d1, -t), B = P.clone().addScaledVector(d2, t);
    const k = Math.max(2, Math.ceil(bendSegs * th / (Math.PI / 2)));
    for (let j = 0; j <= k; j++) {
      const u = j / k, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
      out.push(new THREE.Vector3(A.x * a + P.x * b + B.x * c, A.y * a + P.y * b + B.y * c, A.z * a + P.z * b + B.z * c));
    }
  }
  return out;
}

/**
 * Sweep a closed 2D profile (CCW, [[x, y]...]) along a 3D polyline with filleted corners.
 * u = distance around the profile, v = distance along the path (metres).
 */
export function sweep(path, profile, { bend = 0.05, bendSegs = 4, closed = false, caps = true, up = null, crease = 0.6, scales = null } = {}) {
  let P = filletPath(path.map(toV), bend, bendSegs, closed);
  // drop coincident points
  P = P.filter((p, i) => i === 0 || p.distanceToSquared(P[i - 1]) > 1e-10);
  if (closed && P.length > 2 && P[0].distanceToSquared(P[P.length - 1]) < 1e-10) P.pop();
  const n = P.length;
  const prof = polyNormals(profile, true, crease);
  const T = [], N = [], B = [], L = [0];
  for (let i = 0; i < n; i++) {
    const a = closed ? P[(i - 1 + n) % n] : P[Math.max(0, i - 1)];
    const b = closed ? P[(i + 1) % n] : P[Math.min(n - 1, i + 1)];
    T.push(new THREE.Vector3().subVectors(b, a).normalize());
    if (i > 0) L.push(L[i - 1] + P[i].distanceTo(P[i - 1]));
  }
  const hint = up ? toV(up).clone().normalize() : new THREE.Vector3(0, 1, 0);
  let n0 = hint.clone().addScaledVector(T[0], -hint.dot(T[0]));
  if (n0.lengthSq() < 1e-6) n0 = new THREE.Vector3(1, 0, 0).addScaledVector(T[0], -T[0].x);
  N.push(n0.normalize());
  for (let i = 1; i < n; i++) {
    const v = N[i - 1].clone().addScaledVector(T[i], -N[i - 1].dot(T[i]));
    N.push(v.lengthSq() > 1e-8 ? v.normalize() : N[i - 1].clone());
  }
  for (let i = 0; i < n; i++) B.push(new THREE.Vector3().crossVectors(T[i], N[i]));
  const rows = closed ? n + 1 : n;
  const cols = prof.length;
  const pos = [], nor = [], uv = [], idx = [];
  for (let r = 0; r < rows; r++) {
    const i = r % n, sc = scales ? scales(L[i] / L[n - 1], i) : 1;
    const v = r === n ? L[n - 1] + P[n - 1].distanceTo(P[0]) : L[i];
    for (const pp of prof) {
      const x = pp.p[0] * sc, y = pp.p[1] * sc;
      pos.push(P[i].x + N[i].x * x + B[i].x * y, P[i].y + N[i].y * x + B[i].y * y, P[i].z + N[i].z * x + B[i].z * y);
      const nx = N[i].x * pp.n[0] + B[i].x * pp.n[1], ny = N[i].y * pp.n[0] + B[i].y * pp.n[1], nz = N[i].z * pp.n[0] + B[i].z * pp.n[1];
      nor.push(nx, ny, nz);
      uv.push(pp.t, v);
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let j = 0; j < cols - 1; j++) {
      if (prof[j].end && prof[j + 1].start) continue;
      const a = r * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  if (caps && !closed) {
    for (const [i, sgn] of [[0, -1], [n - 1, 1]]) {
      const base = pos.length / 3;
      const sc = scales ? scales(i === 0 ? 0 : 1, i) : 1;
      pos.push(P[i].x, P[i].y, P[i].z); nor.push(T[i].x * sgn, T[i].y * sgn, T[i].z * sgn); uv.push(0, 0);
      for (const p of profile) {
        const x = p[0] * sc, y = p[1] * sc;
        pos.push(P[i].x + N[i].x * x + B[i].x * y, P[i].y + N[i].y * x + B[i].y * y, P[i].z + N[i].z * x + B[i].z * y);
        nor.push(T[i].x * sgn, T[i].y * sgn, T[i].z * sgn); uv.push(x, y);
      }
      const m = profile.length;
      for (let j = 0; j < m; j++) {
        const a = base + 1 + j, b = base + 1 + ((j + 1) % m);
        if (sgn > 0) idx.push(base, a, b); else idx.push(base, b, a);
      }
    }
  }
  return makeGeo(pos, nor, uv, idx);
}

export const tube = (path, r, opts = {}) => sweep(path, circleProfile(r, opts.radial || 8), { crease: 1.2, ...opts });
export const bar = (path, w, h, opts = {}) => sweep(path, rectProfile(w, h, opts.r ?? Math.min(w, h) * 0.25, opts.cseg ?? 1), opts);

/** Box-projected UVs in metres (dominant normal axis). */
export function boxUV(g) {
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else if (ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Bevelled box centred at the origin (UVs in metres). */
export function rbox(w, h, d, r = 0.005, segs = 2) {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const g = r > 1e-4 ? new RoundedBoxGeometry(w, h, d, segs, r) : new THREE.BoxGeometry(w, h, d);
  return boxUV(g);
}

/** Extrude a THREE.Shape (x, y) along +Z by depth, optionally bevelled; centred on z. */
export function extrude(shape, depth, { bevel = 0, bevelSegs = 2, curveSegs = 8 } = {}) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, depth - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.9,
    bevelSegments: bevelSegs, curveSegments: curveSegs,
  });
  g.translate(0, 0, -depth / 2 + bevel);
  return g;
}

/** Flat quad in the XY plane facing +Z, UVs mapped to an atlas rect [u0, v0, u1, v1]. */
export function quad(w, h, rect = [0, 0, 1, 1]) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, rect[0] + uv.getX(i) * (rect[2] - rect[0]), rect[1] + uv.getY(i) * (rect[3] - rect[1]));
  return g;
}

/** Transform a geometry in place: p = [x, y, z], r = [rx, ry, rz] (radians, XYZ), s = scalar or [sx, sy, sz]. */
export function xf(g, p = [0, 0, 0], r = [0, 0, 0], s = 1) {
  _e.set(r[0], r[1], r[2]);
  _q.setFromEuler(_e);
  const sc = Array.isArray(s) ? _w.set(s[0], s[1], s[2]) : _w.set(s, s, s);
  _m.compose(_v.set(p[0], p[1], p[2]), _q, sc);
  g.applyMatrix4(_m);
  return g;
}

/** Fill a constant vertex colour (used as baked occlusion / per-part tint in own materials). */
export function tint(g, r, gg = r, b = r) {
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = gg; a[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** Height-based ambient occlusion baked into vertex colours: darker towards y0 (e.g. ground). */
export function aoByHeight(g, y0, y1, dark = 0.55) {
  const p = g.attributes.position, n = p.count;
  const prev = g.attributes.color;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = THREE.MathUtils.clamp((p.getY(i) - y0) / (y1 - y0), 0, 1);
    const k = dark + (1 - dark) * Math.sqrt(t);
    for (let c = 0; c < 3; c++) a[i * 3 + c] = (prev ? prev.array[i * 3 + c] : 1) * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** Merge geometries (attribute sets are normalised first). Marks the result shared. */
export function merge(list) {
  const norm = normalizeAttributes(list.filter(Boolean));
  for (const g of norm) for (const k of Object.keys(g.morphAttributes)) delete g.morphAttributes[k];
  const out = norm.length === 1 ? norm[0] : mergeGeometries(norm, false);
  if (!out) throw new Error('furniture kit: merge failed');
  out.computeBoundingSphere();
  out.computeBoundingBox();
  out.userData.shared = true;
  return out;
}

/** Shared-flag a standalone geometry. */
export function shared(g) { g.computeBoundingSphere(); g.userData.shared = true; return g; }

export { toV };

/**
 * Wall swept along a plan curve with a cross-section that may change along it.
 * plan(t) -> [x, z, nx, nz] (point + outward normal in plan), prof(t) -> [[n, y], ...] listed
 * from the outer bottom upwards over the top and down the inner face. Smooth normals.
 */
export function profileWall(nT, plan, prof) {
  const pos = [], uv = [], idx = [];
  let np = 0, acc = 0, prev = null;
  for (let i = 0; i <= nT; i++) {
    const t = i / nT;
    const [px, pz, nx0, nz0] = plan(t);
    const nl = Math.hypot(nx0, nz0) || 1, nx = nx0 / nl, nz = nz0 / nl;
    if (prev) acc += Math.hypot(px - prev[0], pz - prev[1]);
    prev = [px, pz];
    const pr = prof(t);
    np = pr.length;
    let v = 0;
    pr.forEach((p, j) => {
      if (j) v += Math.hypot(p[0] - pr[j - 1][0], p[1] - pr[j - 1][1]);
      pos.push(px + nx * p[0], p[1], pz + nz * p[0]);
      uv.push(acc, v);
    });
  }
  for (let i = 0; i < nT; i++) for (let j = 0; j < np - 1; j++) {
    const a = i * np + j, b = a + 1, c = a + np, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = makeGeo(pos, new Array(pos.length).fill(0), uv, idx);
  g.computeVertexNormals();
  return g;
}
