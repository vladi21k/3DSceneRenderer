import * as THREE from 'three';
import { BONE } from '../anim.js';
import { REGION } from './appearance.js';

// Runtime accessories fitted to each character of the cast, in the cast's vertex layout (mh/cast.js
// mergeMeshes): a phone and a cup (rigid in the right hand), shopping bags in three shapes (plastic,
// paper, a cloth tote; hanging from the right hand, the handles in the fingers), a soft backpack on the
// upper back (padded shoulder straps over the shoulders and down the chest to a buckle at the lower ribs,
// thin webbing back under the arms), a cross-body shoulder bag (a soft bag wrapped against the left hip,
// its strap from the bag's front end across the chest, over the right shoulder and down the back to its
// rear end) and, for characters that can wear it, a waiter's waist apron. Straps lie on the character's
// own clothed surface: their paths start as rays from the torso's axis onto the rest-pose torso found in
// the character's vertices (height-sorted, so a query scans only its band), then settle on it under
// tension (settle: across hollows, never more than ~8 mm off the cloth), skinned like the cloth under them.
// Untextured: flag SOLID, shaded from the wearer's region tints (the apron: the socks region's; a shopping
// bag's print: the strap's).
//
//   buildParts(char, {apron}) -> { phone, cup, shopping, shopping1, shopping2, backpack, backpackFar, shoulder,
//     shoulderFar, sunglasses?, sunglassesFar?, glasses?, apron?, apronFar? } (raw meshes)

export const FLAG = { ALPHA: 1, BACK: 2, DETAIL: 4, SKIRT: 8, SOLID: 16, WHITE: 32 };
const ARM_BONES = new Set([BONE.armL, BONE.foreL, BONE.handL, BONE.armR, BONE.foreR, BONE.handR]);
const _v = new THREE.Vector3(), _n = new THREE.Vector3();

class PartBuilder {
  constructor() { this.P = []; this.N = []; this.UV = []; this.BI = []; this.BW = []; this.T = []; this.I = []; this.n = 0; }

  /** Add a THREE geometry through matrix M, skinned by skin(p) -> [[bone, w], ...] (or a fixed list). */
  geometry(geo, M, skin, region, flags = FLAG.SOLID, ao = 1) {
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    this.warp(geo, (v, n) => { v.applyMatrix4(M); n.applyMatrix3(nm).normalize(); }, skin, region, flags, ao);
  }

  /** Add a THREE geometry through map(v, n) (both changed in place, from the geometry's own space);
   *  ao: a number or a function of the vertex in the geometry's own space. */
  warp(geo, map, skin, region, flags = FLAG.SOLID, ao = 1) {
    const g = geo;
    const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    const v0 = this.n;
    const loc = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      loc.fromBufferAttribute(pos, i);
      _v.copy(loc);
      _n.fromBufferAttribute(nrm, i);
      map(_v, _n);
      const a = typeof ao === 'function' ? ao(loc) : ao;
      this.vertex(_v, _n, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, typeof skin === 'function' ? skin(_v) : skin, region, flags, a);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.I.push(v0 + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) this.I.push(v0 + i);
  }

  /**
   * A strap along a polyline lying on a surface (points pts[i], surface normals nrms[i]): a band of
   * width w(i) with a rounded top t(i) thick (padding) and rounded edges, closed underneath by the body.
   */
  strap(pts, nrms, w, t, skin, region, flags = FLAG.SOLID) {
    const n = pts.length;
    // cross-section (across, up) and its normals: a soft rounded band
    const PRO = [[-0.5, 0], [-0.5, 0.5], [-0.36, 0.92], [-0.12, 1], [0.12, 1], [0.36, 0.92], [0.5, 0.5], [0.5, 0]];
    const PN = [[-1, 0.1], [-0.9, 0.45], [-0.45, 0.9], [-0.1, 1], [0.1, 1], [0.45, 0.9], [0.9, 0.45], [1, 0.1]];
    const rows = [];
    const side = new THREE.Vector3(), up = new THREE.Vector3(), tg = new THREE.Vector3(), q = new THREE.Vector3(), nn = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      tg.copy(pts[Math.min(n - 1, i + 1)]).sub(pts[Math.max(0, i - 1)]).normalize();
      side.crossVectors(tg, nrms[i]).normalize();
      up.crossVectors(side, tg).normalize();
      const sk = typeof skin === 'function' ? skin(pts[i], i) : skin;
      const wi = w(i), ti = t(i);
      const row = [];
      for (let k = 0; k < PRO.length; k++) {
        q.copy(pts[i]).addScaledVector(side, PRO[k][0] * wi).addScaledVector(up, PRO[k][1] * ti);
        nn.copy(side).multiplyScalar(PN[k][0]).addScaledVector(up, PN[k][1]).normalize();
        row.push(this.vertex(q, nn, k / (PRO.length - 1), i / (n - 1), sk, region, flags, k === 0 || k === PRO.length - 1 ? 0.7 : 1));
      }
      rows.push(row);
    }
    for (let i = 0; i < n - 1; i++) {
      for (let k = 0; k < PRO.length - 1; k++) this.quad(rows[i][k], rows[i + 1][k], rows[i + 1][k + 1], rows[i][k + 1]);
    }
  }

  vertex(p, n, u, v, skin, region, flags, ao = 1) {
    this.P.push(p.x, p.y, p.z);
    this.N.push(Math.round(n.x * 127), Math.round(n.y * 127), Math.round(n.z * 127), Math.round(ao * 127));
    this.UV.push(Math.round(THREE.MathUtils.clamp(u, 0, 1) * 65535), Math.round(THREE.MathUtils.clamp(v, 0, 1) * 65535));
    const bi = [0, 0, 0, 0], bw = [0, 0, 0, 0];
    let tot = 0;
    skin.slice(0, 4).forEach(([b, w], k) => { bi[k] = b; bw[k] = w; tot += w; });
    let acc = 0;
    for (let k = 0; k < 4; k++) { bw[k] = Math.round((bw[k] / (tot || 1)) * 255); acc += bw[k]; }
    bw[0] += 255 - acc;
    this.BI.push(...bi); this.BW.push(...bw);
    this.T.push(0, 255, region, flags);
    return this.n++;
  }

  /** A flat strap along a polyline lying on a surface: points p[i], surface normals s[i], width w. */
  ribbon(pts, nrms, w, skin, region, thick = 0.003) {
    const n = pts.length;
    const side = [], up = [];
    for (let i = 0; i < n; i++) {
      const t = pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize();
      const s = new THREE.Vector3().crossVectors(t, nrms[i]).normalize();
      side.push(s);
      up.push(new THREE.Vector3().crossVectors(s, t).normalize());
    }
    // outer face and the two edges (a thin band, closed underneath by the body)
    const rows = [];
    for (let i = 0; i < n; i++) {
      const sk = typeof skin === 'function' ? skin(pts[i]) : skin;
      const o = pts[i].clone().addScaledVector(up[i], thick);
      const a = this.vertex(o.clone().addScaledVector(side[i], -w / 2), up[i], 0, i / (n - 1), sk, region, FLAG.SOLID);
      const b = this.vertex(o.clone().addScaledVector(side[i], w / 2), up[i], 1, i / (n - 1), sk, region, FLAG.SOLID);
      const c = this.vertex(pts[i].clone().addScaledVector(side[i], -w / 2), side[i].clone().negate(), 0, i / (n - 1), sk, region, FLAG.SOLID, 0.7);
      const d = this.vertex(o.clone().addScaledVector(side[i], -w / 2), side[i].clone().negate(), 0, i / (n - 1), sk, region, FLAG.SOLID, 0.85);
      const e = this.vertex(o.clone().addScaledVector(side[i], w / 2), side[i], 1, i / (n - 1), sk, region, FLAG.SOLID, 0.85);
      const f = this.vertex(pts[i].clone().addScaledVector(side[i], w / 2), side[i], 1, i / (n - 1), sk, region, FLAG.SOLID, 0.7);
      rows.push([a, b, c, d, e, f]);
    }
    for (let i = 0; i < n - 1; i++) {
      const [a0, b0, c0, d0, e0, f0] = rows[i], [a1, b1, c1, d1, e1, f1] = rows[i + 1];
      // (winding: outward faces counter-clockwise seen from outside)
      this.quad(a0, a1, b1, b0);
      this.quad(c0, c1, d1, d0);
      this.quad(e0, e1, f1, f0);
    }
  }

  quad(a, b, c, d) { this.I.push(a, b, c, a, c, d); }

  /** Orient every triangle so its face normal agrees with its vertices' normals. */
  fixWinding() {
    const P = this.P, N = this.N, I = this.I;
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], fn = new THREE.Vector3(), vn = new THREE.Vector3();
    for (let t = 0; t < I.length; t += 3) {
      vn.set(0, 0, 0);
      for (let k = 0; k < 3; k++) {
        const v = I[t + k];
        p[k].set(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
        vn.x += N[v * 4]; vn.y += N[v * 4 + 1]; vn.z += N[v * 4 + 2];
      }
      fn.crossVectors(p[1].clone().sub(p[0]), p[2].clone().sub(p[0]));
      if (fn.dot(vn) < 0) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; }
    }
  }

  build() {
    this.fixWinding();
    return {
      n: this.n, pos: new Float32Array(this.P), nrm: new Int8Array(this.N), uv: new Uint16Array(this.UV),
      bi: new Uint8Array(this.BI), bw: new Uint8Array(this.BW), tex: new Uint8Array(this.T), index: new Uint32Array(this.I),
    };
  }
}

/**
 * Rounded box (bevelled) geometry of size w x h x d centred at the origin. `pillow` > 0 swells the
 * faces across the thinnest axis (a soft bag stuffed with things, not a crate): the thinnest
 * dimension grows by up to pillow x its size in the middle of the faces; `taper` narrows the top
 * (x and the thin axis scale by 1 - taper at the top).
 */
function roundBox(w, h, d, r, seg = 3, pillow = 0, taper = 0) {
  const g = new THREE.BoxGeometry(w, h, d, seg * 3, seg * 3, seg * 2);
  const p = g.attributes.position;
  const inner = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r);
  const v = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const dims = [w, h, d];
  const thin = dims.indexOf(Math.min(...dims));
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    c.set(THREE.MathUtils.clamp(v.x, -inner.x, inner.x), THREE.MathUtils.clamp(v.y, -inner.y, inner.y), THREE.MathUtils.clamp(v.z, -inner.z, inner.z));
    n.subVectors(v, c);
    if (n.lengthSq() > 1e-12) {
      n.normalize();
      v.copy(c).addScaledVector(n, r);
    }
    if (pillow > 0) {
      const a = [v.x / (w / 2), v.y / (h / 2), v.z / (d / 2)];
      const o = [0, 1, 2].filter((k) => k !== thin);
      const bulge = (1 - Math.min(1, a[o[0]] ** 2)) * (1 - Math.min(1, a[o[1]] ** 2));
      const comp = ['x', 'y', 'z'][thin];
      v[comp] *= 1 + pillow * bulge * 2;
    }
    if (taper > 0) {
      const t = 1 - taper * THREE.MathUtils.clamp(0.5 + v.y / h, 0, 1);
      v.x *= t;
      if (thin !== 1) v[['x', 'y', 'z'][thin]] *= t;
    }
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * The character's torso surface for laying straps on: rest-pose vertices of LOD 0 other than the
 * arms, hands and hair. surface(p, d) returns the outermost surface point along the ray p + t d
 * (|t| <= 0.35 m, within 2.5 cm of it), pushed out by `off`, or null.
 */
export function torsoSurface(char) {
  const raw = char.raw, n = raw.n;
  const L0 = char.lods[0];
  const pts = [], vid = [];
  const used = new Uint8Array(n);
  for (let i = L0.start; i < L0.start + L0.count; i++) used[raw.index[i]] = 1;
  for (let v = 0; v < n; v++) {
    if (!used[v]) continue;
    const reg = raw.tex[v * 4 + 2];
    if (reg === REGION.hair || reg === REGION.brows || reg === REGION.lashes || reg === REGION.eyes || reg === REGION.beard) continue;
    // dominant bone
    let bw = -1, bb = 0;
    for (let k = 0; k < 4; k++) if (raw.bw[v * 4 + k] > bw) { bw = raw.bw[v * 4 + k]; bb = raw.bi[v * 4 + k]; }
    if (ARM_BONES.has(bb) || bb === BONE.head) continue;
    pts.push(raw.pos[v * 3], raw.pos[v * 3 + 1], raw.pos[v * 3 + 2]);
    vid.push(v);
  }
  // (sorted by height: a query scans only the points within the height band its ray segment can reach)
  const m = pts.length / 3, order = new Uint32Array(m);
  for (let i = 0; i < m; i++) order[i] = i;
  order.sort((a, b) => pts[a * 3 + 1] - pts[b * 3 + 1]);
  const P = new Float32Array(m * 3);
  // (each point's skin weights: what lies on the cloth moves with the cloth under it)
  const SB = new Uint8Array(m * 4), SW = new Uint8Array(m * 4);
  for (let i = 0; i < m; i++) {
    P[i * 3] = pts[order[i] * 3]; P[i * 3 + 1] = pts[order[i] * 3 + 1]; P[i * 3 + 2] = pts[order[i] * 3 + 2];
    const v = vid[order[i]];
    for (let k = 0; k < 4; k++) { SB[i * 4 + k] = raw.bi[v * 4 + k]; SW[i * 4 + k] = raw.bw[v * 4 + k]; }
  }
  const lower = (y) => {      // first point with height >= y
    let lo = 0, hi = m;
    while (lo < hi) { const md = (lo + hi) >> 1; if (P[md * 3 + 1] < y) lo = md + 1; else hi = md; }
    return lo;
  };
  const f = (p, d, off = 0.004, rad = 0.025, tmin = -0.35, tmax = 0.35) => {
    let best = -Infinity;
    const y0 = p.y + Math.min(tmin * d.y, tmax * d.y) - rad, y1 = p.y + Math.max(tmin * d.y, tmax * d.y) + rad;
    for (let i = lower(y0) * 3, e = lower(y1) * 3; i < e; i += 3) {
      const x = P[i] - p.x, y = P[i + 1] - p.y, z = P[i + 2] - p.z;
      const t = x * d.x + y * d.y + z * d.z;
      if (t < tmin || t > tmax || t < best) continue;
      const qx = x - d.x * t, qy = y - d.y * t, qz = z - d.z * t;
      if (qx * qx + qy * qy + qz * qz < rad * rad) best = t;
    }
    return best === -Infinity ? null : p.clone().addScaledVector(d, best + off);
  };
  f.pts = P;
  f.slice = (y0, y1) => [lower(y0), lower(y1)];
  /** Skin weights ([[bone, w], ...]) of the surface point nearest p (within 4 cm of its height). */
  f.skin = (p) => {
    let bd = Infinity, bi = -1;
    for (let i = lower(p.y - 0.04) * 3, e = lower(p.y + 0.04) * 3; i < e; i += 3) {
      const x = P[i] - p.x, y = P[i + 1] - p.y, z = P[i + 2] - p.z;
      const d = x * x + y * y + z * z;
      if (d < bd) { bd = d; bi = i / 3; }
    }
    if (bi < 0) return null;
    const out = [];
    for (let k = 0; k < 4; k++) if (SW[bi * 4 + k] > 0) out.push([SB[bi * 4 + k], SW[bi * 4 + k] / 255]);
    return out.length ? out : null;
  };
  return f;
}

/** Blend of two skin weight lists ((1 - t) a + t b), the four largest kept. */
function mixSkin(a, b, t) {
  const m = new Map();
  for (const [bn, w] of a) m.set(bn, (m.get(bn) || 0) + w * (1 - t));
  for (const [bn, w] of b) m.set(bn, (m.get(bn) || 0) + w * t);
  return [...m.entries()].filter((e) => e[1] > 1e-3).sort((x, y) => y[1] - x[1]).slice(0, 4);
}

/** Cumulative arc length along a polyline. */
function arcLengths(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + pts[i].distanceTo(pts[i - 1]));
  return s;
}

/** The polyline resampled at about `step` spacing (Catmull-Rom through its points; normals interpolated). */
function resamplePath(pts, nrms, step) {
  const s = arcLengths(pts), L = s[s.length - 1];
  const cnt = Math.max(2, Math.round(L / step));
  const op = [], on = [];
  const crv = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  let j = 0;
  for (let i = 0; i <= cnt; i++) {
    const d = (L * i) / cnt;
    while (j < s.length - 2 && s[j + 1] < d) j++;
    const f = (d - s[j]) / Math.max(1e-9, s[j + 1] - s[j]);
    op.push(crv.getPointAt(Math.min(1, d / Math.max(L, 1e-9))));
    on.push(nrms[j].clone().lerp(nrms[j + 1], f).normalize());
  }
  return [op, on];
}

/**
 * A strap under tension laid over the clothed body: the path relaxes (every point towards the middle of
 * its neighbours, so it runs straight across hollows and settles into the valley between the breasts),
 * then goes back onto the cloth after every pass: out of it where smoothing pulled it in, and in to no
 * more than gap(i) off it where it bridged (a strap presses the cloth under it). Its ends stay where they
 * are. Normals are smoothed along the path first (a strap turns gradually over the shoulder).
 */
function settle(surf, pts, nrms, { off = 0.004, gap = () => 0.008, iters = 6, lam = 0.5 } = {}) {
  const n = pts.length;
  for (let it = 0; it < 3; it++) {
    const c = nrms.map((v) => v.clone());
    for (let i = 1; i < n - 1; i++) nrms[i].copy(c[i - 1]).add(c[i + 1]).addScaledVector(c[i], 2).normalize();
  }
  const o = new THREE.Vector3();
  const c = pts.map((p) => p.clone());
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) c[i].copy(pts[i]);
    for (let i = 1; i < n - 1; i++) pts[i].copy(c[i - 1]).add(c[i + 1]).multiplyScalar(0.5 * lam).addScaledVector(c[i], 1 - lam);
    for (let i = 1; i < n - 1; i++) {
      o.copy(pts[i]).addScaledVector(nrms[i], -0.07);
      const q = surf(o, nrms[i], 0, 0.014, 0, 0.16);
      if (!q) continue;
      const h = o.copy(pts[i]).sub(q).dot(nrms[i]);          // height over the cloth along the normal
      const g = Math.max(off, gap(i));
      if (h < off) pts[i].addScaledVector(nrms[i], off - h);
      else if (h > g) pts[i].addScaledVector(nrms[i], g - h);
    }
  }
}

/** The torso's axis: z at height y = the middle of the torso points' depth within 2.5 cm of y. */
function torsoAxis(surf) {
  const P = surf.pts;
  const cache = new Map();
  return (y) => {
    const key = Math.round(y * 200);
    let z = cache.get(key);
    if (z === undefined) {
      let lo = Infinity, hi = -Infinity;
      const [a, b] = surf.slice(y - 0.025, y + 0.025);
      for (let i = a * 3; i < b * 3; i += 3) {
        if (Math.abs(P[i]) > 0.06) continue;
        lo = Math.min(lo, P[i + 2]); hi = Math.max(hi, P[i + 2]);
      }
      z = lo <= hi ? 0.5 * (lo + hi) : 0;
      cache.set(key, z);
    }
    return z;
  };
}

const rigid = (b) => [[b, 1]];

/** Every k-th point of a path (and its normals), its ends kept. */
function coarsePath(pts, nrms, k) {
  const p = [], n = [];
  for (let i = 0; i < pts.length; i += k) { p.push(pts[i]); n.push(nrms[i]); }
  if ((pts.length - 1) % k) { p.push(pts[pts.length - 1]); n.push(nrms[nrms.length - 1]); }
  return [p, n];
}

/**
 * Glasses on the head bone, fitted to the character's eyes, nose bridge and temples (rest pose):
 * sun = true: sunglasses (large dark lenses in a heavier frame, wrapped round the face), else a thin
 * frame with clear lenses (the frame only). Flags SOLID + LENS (128) on the prop region: the shader
 * shades them dark (uv.x 1 the lens: smooth glass; 0 the frame, its tone from the look row). far: a
 * coarse version for the far LODs (a few dozen triangles).
 */
function glasses(char, J, sun, far = false) {
  const e = char.info.eyeR;
  if (!e) return null;
  const ex = Math.abs(e[0]), ey = e[1], ez = e[2];
  const hk = Math.max(0.6, (ex * 2) / 0.064);
  const er = char.eyeR > 0 ? char.eyeR : 0.0125 * hk;
  const hc = char.info.headC || J[BONE.head].toArray();
  // the nose bridge (frontmost skin on the midline at the eyes' height) and the temples' half width
  const raw = char.raw, T = raw.tex, P = raw.pos;
  let bz = Infinity, tw = 0;
  for (let v = 0; v < raw.n; v++) {
    if (T[v * 4 + 2] !== 0) continue;
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (Math.abs(y - ey) > 0.012 * hk) continue;
    if (Math.abs(x) < 0.006 * hk && y > ey - 0.004 * hk) bz = Math.min(bz, z);
    // (the temples in front of the ears: the arms run along them, under the hair)
    if (z > ez + 0.012 * hk && z < ez + 0.045 * hk) tw = Math.max(tw, Math.abs(x));
  }
  if (!(bz < Infinity)) bz = ez - er - 0.006 * hk;
  if (!(tw > 0)) tw = ex + 0.04 * hk;
  const z0 = Math.min(ez - er - 0.012 * hk, bz - 0.003 * hk);
  const w = (sun ? 0.051 : 0.048) * hk, h = (sun ? 0.038 : 0.032) * hk;
  const cx = ex + 0.0025 * hk, cy = ey - (sun ? 0.0065 : 0.003) * hk;
  const wrapK = (sun ? 4.5 : 2.2) / hk;
  const zAt = (x) => z0 + wrapK * Math.max(0, Math.abs(x) - 0.012 * hk) ** 2;
  const dzAt = (x) => Math.sign(x) * 2 * wrapK * Math.max(0, Math.abs(x) - 0.012 * hk);
  const rf = (sun ? 0.0021 : 0.0011) * hk;
  const b = new PartBuilder();
  const sk = rigid(BONE.head);
  const LENS = FLAG.SOLID | 128;
  const NO = far ? 12 : 36;
  const tubeAlong = (pts, closed, r, sides = 6) => {
    if (far) sides = 3;
    const n = pts.length, rows = [];
    const t = new THREE.Vector3(), a = new THREE.Vector3(), c = new THREE.Vector3(), q = new THREE.Vector3(), nn = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const i0 = closed ? (i - 1 + n) % n : Math.max(0, i - 1), i1 = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      t.copy(pts[i1]).sub(pts[i0]).normalize();
      a.set(0, 0, -1).cross(t);
      if (a.lengthSq() < 1e-6) a.set(0, 1, 0).cross(t);
      a.normalize();
      c.crossVectors(t, a).normalize();
      const row = [];
      for (let k = 0; k < sides; k++) {
        const ang = (k / sides) * Math.PI * 2;
        nn.copy(a).multiplyScalar(Math.cos(ang)).addScaledVector(c, Math.sin(ang));
        q.copy(pts[i]).addScaledVector(nn, r);
        row.push(b.vertex(q, nn, 0, 0, sk, REGION.prop, LENS));
      }
      rows.push(row);
    }
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const r0 = rows[i], r1 = rows[(i + 1) % n];
      for (let k = 0; k < sides; k++) b.quad(r0[k], r1[k], r1[(k + 1) % sides], r0[(k + 1) % sides]);
    }
  };
  for (const sx of [-1, 1]) {
    // the rim: a rounded rectangle (a superellipse), sunglasses a little deeper at the outer corner
    const rim = [];
    for (let i = 0; i < NO; i++) {
      const th = (i / NO) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      const pe = sun ? 2.9 : 3.3;
      const px = Math.sign(c) * Math.abs(c) ** (2 / pe), py = Math.sign(s) * Math.abs(s) ** (2 / pe);
      const drop = sun && py < 0 && px > 0 ? 1 + 0.12 * px : 1;
      const x = sx * (cx + px * w * 0.5);
      const y = cy + py * h * 0.5 * drop - (py > 0 ? 0 : 0.0015 * hk * (1 - Math.abs(px)));
      rim.push(new THREE.Vector3(x, y, zAt(x)));
    }
    tubeAlong(rim, true, rf);
    if (sun) {
      // the lens: a fan over the rim, its normal off the wrapped face
      const cxs = sx * cx;
      const ctr = b.vertex(new THREE.Vector3(cxs, cy, zAt(cxs) - 0.0005 * hk), new THREE.Vector3(dzAt(cxs), 0, -1).normalize(), 1, 0, sk, REGION.prop, LENS);
      const ring = rim.map((p) => b.vertex(p, new THREE.Vector3(dzAt(p.x), 0, -1).normalize(), 1, 0, sk, REGION.prop, LENS));
      for (let i = 0; i < NO; i++) b.I.push(ctr, ring[i], ring[(i + 1) % NO]);
    }
    // the arm: from the rim's outer top corner back past the temple to above the ear
    const xo = sx * (cx + w * 0.5), yo = cy + h * 0.28;
    const xa = sx * Math.max(tw + 0.003 * hk, Math.abs(xo) + 0.002 * hk);
    const arm = [];
    for (let i = 0; i <= 6; i++) {
      const u = i / 6;
      const x = xo + (xa - xo) * Math.min(1, u * 3.5);
      arm.push(new THREE.Vector3(x, yo + 0.005 * hk * u, zAt(xo) + (hc[2] + 0.012 * hk - zAt(xo)) * u));
    }
    tubeAlong(arm, false, rf * 0.85, 5);
  }
  // the bridge between the rims over the nose
  const br = [];
  for (let i = 0; i <= 6; i++) {
    const u = i / 6, x = -(cx - w * 0.5) + 2 * (cx - w * 0.5) * u;
    br.push(new THREE.Vector3(x, cy + h * 0.22 + 0.003 * hk * Math.sin(Math.PI * u), Math.min(zAt(x), bz - 0.002 * hk) - 0.0005 * hk));
  }
  tubeAlong(br, false, rf * 0.9, 5);
  return b.build();
}

/**
 * A waiter's long waist apron (café staff): cloth from just below the waist to below the knees,
 * wrapped round the front and sides of the hips (open at the back), falling straight from the widest
 * part of the hips and thighs with a slight flare and soft vertical folds; its inside drawn as the
 * garment's inner face; ties round the back to a knot with two hanging ends (near version). Skinned
 * like a skirt (the pelvis at the waistband, blending to the thighs, each side more to its own leg,
 * towards the hem) and flagged SKIRT, so the shader keeps it outside the striding thighs. Colour: the
 * socks region's tint (no character of the cast wears visible socks).
 */
function apron(char, J, k, surf, hipY, waistY, NT, NY, near) {
  const b = new PartBuilder();
  const yTop = waistY - 0.03 * k, yHem = J[BONE.shinL].y - 0.1 * k;
  const az = 0.5 * (J[BONE.thighL].z + J[BONE.thighR].z);
  const TH = 1.7;                     // (round the front and sides, about +-97 degrees; open at the back)
  const o = new THREE.Vector3(), d = new THREE.Vector3();
  const rayR = (y, th) => {
    o.set(0, y, az); d.set(Math.sin(th), 0, -Math.cos(th));
    const q = surf(o, d, 0, 0.025, 0, 0.45);
    return q ? Math.hypot(q.x, q.z - az) : 0;
  };
  // folds: six soft vertical folds over the panel, unevenly spaced and of uneven depth (rounded ridges,
  // the cloth lying flatter between them), deepening from nothing at the waistband to the hem; the hem
  // waves a little with them
  const seed = (char.id || '').split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  const foldPh = (th) => th * 11 + 0.9 * Math.sin(th * 2.6 + seed) + 0.5 * Math.sin(th * 5.3 + 0.7 * seed);
  const foldH = (th) => {
    const r = (0.5 + 0.5 * Math.cos(foldPh(th))) ** 1.6;
    return r * (0.75 + 0.25 * Math.sin(th * 3.7 + 1.3 * seed));
  };
  // per column: tight on the waist under the waistband (within a few mm of the shirt), then the cloth
  // falls straight from the widest point above it (it hangs), with a slight flare and the folds
  const P = [], N = [];
  const cols = [];
  for (let i = 0; i <= NT; i++) {
    const th = -TH + (2 * TH * i) / NT;
    let rMax = 0;
    const col = [];
    const fh = foldH(th);
    // (the hem a little longer where the cloth folds out, shorter in the valleys; the side edges turn in)
    const hemDy = (near ? 0.012 * (fh - 0.5) : 0) * k - 0.02 * k * THREE.MathUtils.smoothstep(Math.abs(th), TH - 0.35, TH);
    for (let j = 0; j <= NY; j++) {
      const u = j / NY;
      const y = yTop + (yHem + hemDy * u * u - yTop) * u;
      // (sampled between the rows too, so a narrow bulge between them is not missed)
      rMax = Math.max(rMax, rayR(y, th), j > 0 ? rayR(y - (yHem - yTop) / NY * 0.5, th) : 0);
      const ease = THREE.MathUtils.smoothstep(u, 0, 0.3);
      // (clear of the shirt by ~8 mm at the waistband: the shirt moves with the spine, the apron with the
      // pelvis, and the ties cover the edge)
      const r = Math.max(rMax, 0.08 * k) + 0.008 + 0.012 * u * u + (near ? (0.002 + 0.013 * ease * u) * fh : 0.004 * u * u);
      col.push(new THREE.Vector3(Math.sin(th) * r, y, az - Math.cos(th) * r));
    }
    cols.push(col);
  }
  for (let i = 0; i <= NT; i++) {
    for (let j = 0; j <= NY; j++) {
      const a = cols[Math.min(NT, i + 1)][j].clone().sub(cols[Math.max(0, i - 1)][j]);
      const c = cols[i][Math.min(NY, j + 1)].clone().sub(cols[i][Math.max(0, j - 1)]);
      N.push(new THREE.Vector3().crossVectors(c, a).normalize());
      P.push(cols[i][j]);
    }
  }
  // (outward: away from the axis)
  for (let i = 0; i < P.length; i++) {
    const out = new THREE.Vector3(P[i].x, 0, P[i].z - az);
    if (N[i].dot(out) < 0) N[i].negate();
  }
  const skin = (p, th) => {
    const u = THREE.MathUtils.smoothstep((hipY + 0.05 * k - p.y) / Math.max(0.05, hipY + 0.05 * k - yHem), 0, 1);
    const sd = THREE.MathUtils.clamp(Math.sin(th) / 0.7, -1, 1);
    const sk = [[BONE.pelvis, 1 - u], [BONE.thighL, u * (0.5 - 0.3 * sd)], [BONE.thighR, u * (0.5 + 0.3 * sd)]];
    // (the waistband moves with the cloth under it: the cloth's own weights there, without the thighs)
    const top = 1 - THREE.MathUtils.smoothstep((yTop - p.y) / Math.max(0.05, yTop - yHem), 0.0, 0.2);
    if (top <= 0) return sk;
    const ws = (surf.skin(p) || []).filter(([bn]) => bn !== BONE.thighL && bn !== BONE.thighR);
    return ws.length ? mixSkin(sk, ws, top) : sk;
  };
  const FL = FLAG.SOLID | FLAG.SKIRT;
  const layer = (inner) => {
    const v0 = b.n;
    for (let i = 0; i <= NT; i++) {
      const th = -TH + (2 * TH * i) / NT;
      for (let j = 0; j <= NY; j++) {
        const q = i * (NY + 1) + j;
        const p = inner ? P[q].clone().addScaledVector(N[q], -0.0015) : P[q];
        const n = inner ? N[q].clone().negate() : N[q];
        // (the folds' valleys and the hem's underside a little darker)
        const fold = foldH(th);
        const ao = inner ? 0.6 : (near ? 0.78 + 0.22 * (1 - (1 - fold) * (j / NY)) : 0.95) * (j === 0 ? 0.85 : 1);
        b.vertex(p, n, i / NT, 1 - j / NY, skin(p, th), REGION.socks, inner ? FL | FLAG.BACK : FL, ao);
      }
    }
    for (let i = 0; i < NT; i++) {
      for (let j = 0; j < NY; j++) {
        const a = v0 + i * (NY + 1) + j, c = a + NY + 1;
        b.quad(a, a + 1, c + 1, c);
      }
    }
  };
  layer(false);
  layer(true);
  if (near) {
    // the waistband and its ties: all round the waist (over the apron's top in front), to a knot over
    // the small of the back
    const tie = [], tn = [];
    const r0 = cols[NT >> 1][0].distanceTo(new THREE.Vector3(0, yTop, az));
    for (let i = 0; i <= 40; i++) {
      const th = -Math.PI + (2 * Math.PI * i) / 40;
      const front = Math.abs(th) < TH;
      const r = front ? Math.hypot(cols[Math.round(((th + TH) / (2 * TH)) * NT)][0].x, cols[Math.round(((th + TH) / (2 * TH)) * NT)][0].z - az) + 0.001
        : (rayR(yTop + 0.012 * k, th) || r0) + 0.004;
      d.set(Math.sin(th), 0, -Math.cos(th));
      tie.push(new THREE.Vector3(d.x * r, yTop + 0.012 * k, az + d.z * r));
      tn.push(d.clone());
    }
    const tieSkin = [[BONE.pelvis, 0.6], [BONE.spine1, 0.4]];
    const tieAt = (p) => {
      const ws = (surf.skin(p) || []).filter(([bn]) => bn !== BONE.thighL && bn !== BONE.thighR);
      return ws.length ? mixSkin(tieSkin, ws, 0.7) : tieSkin;
    };
    b.strap(tie, tn, () => 0.022 * k, () => 0.003, tieAt, REGION.socks);
    const rb = rayR(yTop + 0.012 * k, Math.PI) || 0.12 * k;
    const knot = new THREE.Vector3(0, yTop + 0.012 * k, az + rb + 0.012);
    b.geometry(new THREE.SphereGeometry(0.016 * k, 8, 6).scale(1.3, 0.9, 0.7), new THREE.Matrix4().makeTranslation(knot.x, knot.y, knot.z), tieSkin, REGION.socks, FLAG.SOLID, 0.85);
    for (const sg of [-1, 1]) {
      const end = [], en = [];
      for (let i = 0; i <= 5; i++) {
        const u = i / 5;
        end.push(new THREE.Vector3(sg * (0.008 + 0.03 * u) * k, knot.y - u * 0.2 * k, knot.z + 0.004 + 0.01 * u));
        en.push(new THREE.Vector3(0, 0, 1));
      }
      b.strap(end, en, () => 0.02 * k, () => 0.003, (p) => (p.y > knot.y - 0.05 * k ? tieSkin : [[BONE.pelvis, 1]]), REGION.socks);
    }
  }
  return b.build();
}

// (deterministic value noise for the bags' crumple)
function hash3(x, y, z) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), sx), l(c(0, 1, 0), c(1, 1, 0), sx), sy),
    l(l(c(0, 0, 1), c(1, 0, 1), sx), l(c(0, 1, 1), c(1, 1, 1), sx), sy), sz);
}

/**
 * A shopping bag (see buildParts) in the right hand: its top a handle's length below the grip, a little
 * out from the thigh. The big faces carry a planar uv (the shader prints on them; the narrow sides get
 * uv 0). Flags: 64 plastic film, 128 paper (mh/shading.js).
 */
function shoppingBag(shape, grip, k) {
  const s = new PartBuilder();
  const kk = Math.min(1, k);
  const D = [{ bw: 0.29, bh: 0.34, bd: 0.12, hl: 0.11 }, { bw: 0.32, bh: 0.33, bd: 0.12, hl: 0.10 }, { bw: 0.36, bh: 0.37, bd: 0.05, hl: 0.17 }][shape];
  const bw = D.bw * kk, bh = D.bh * kk, bd = D.bd * kk, hl = D.hl * k;
  const flags = FLAG.SOLID | (shape === 0 ? 64 : shape === 1 ? 128 : 0);
  const cx = grip.x + 0.02 * k + bd * 0.35, cy = grip.y - hl - bh / 2, cz = grip.z;
  // the body: rounded box; the plastic sack soft and narrowing to its top, crumpled; paper crisp with the
  // gussets folded in; the tote flat with its load in the bottom
  const g = shape === 0 ? roundBox(bd, bh, bw, 0.03 * kk, 4, 0.32, 0.3) : shape === 1 ? roundBox(bd, bh, bw, 0.005 * kk, 4, 0.03, 0)
    : roundBox(bd, bh, bw, 0.02 * kk, 4, 0.25, 0.05);
  const pos = g.attributes.position, nrm = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const amp = [0.007, 0.0018, 0.004][shape] * kk, fq = [26, 14, 18][shape] / kk;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i); n.fromBufferAttribute(nrm, i);
    const yy = v.y / bh + 0.5;
    // (displacements are functions of the position only: the faces' duplicated edge vertices move together)
    const dir = new THREE.Vector3(v.x / (bd / 2), v.y / (bh / 2), v.z / (bw / 2)).normalize();
    if (shape === 1) {
      // gussets: the narrow sides fold in along their middle (a V, deepest at the top)
      const side = THREE.MathUtils.smoothstep(Math.abs(v.z) / (bw / 2), 0.9, 1.0);
      v.z -= Math.sign(v.z) * side * (1 - Math.abs(v.x) / (bd / 2)) * 0.022 * kk * (0.4 + 0.6 * yy);
    } else if (shape === 2) {
      // the load sags into the bottom (fuller low), the top lies flat
      v.x *= 0.55 + 0.75 * (1 - yy);
    } else {
      // the film sags between the handles at the top
      v.y -= 0.03 * kk * THREE.MathUtils.smoothstep(yy, 0.75, 1.0) * (1 - THREE.MathUtils.smoothstep(Math.abs(v.z) / (bw / 2), 0.2, 0.75));
    }
    // crumple: thin film wrinkles in creases a centimetre or two long, cloth in softer dents
    const c = vnoise3(v.x * fq + 3.1 * shape, v.y * fq * 0.6, v.z * fq) * 0.7 + vnoise3(v.x * fq * 2.7, v.y * fq * 2.1 + 7.7, v.z * fq * 2.7) * 0.3;
    v.addScaledVector(dir, amp * (c - 0.5) * 2);
    pos.setXYZ(i, v.x, v.y, v.z);
    const big = Math.abs(n.x) > 0.6;
    uv[i * 2] = big ? THREE.MathUtils.clamp(v.z / bw + 0.5, 0.001, 0.999) : 0;
    uv[i * 2 + 1] = big ? THREE.MathUtils.clamp(yy, 0.001, 0.999) : 0;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  const hand = rigid(BONE.handR);
  s.geometry(g, new THREE.Matrix4().makeTranslation(cx, cy, cz), hand, REGION.bag, flags, (p) => 0.75 + 0.25 * THREE.MathUtils.smoothstep(p.y / bh + 0.5, 0.0, 0.25));
  // handles: one loop from each big face's top edge up into the hand, the two meeting in the fingers
  const topY = cy + bh / 2 - (shape === 0 ? 0.03 * kk : 0.004);
  const z0 = bw * (shape === 0 ? 0.36 : shape === 1 ? 0.2 : 0.26);
  for (const sx of [-1, 1]) {
    const fx = cx + sx * (bd / 2) * (shape === 2 ? 0.55 : 0.8);
    const ctrl = [
      new THREE.Vector3(fx, topY, cz - z0),
      new THREE.Vector3(0.5 * (fx + grip.x), topY + 0.65 * hl, cz - z0 * 0.45),
      new THREE.Vector3(grip.x + sx * 0.005, grip.y + 0.006 * k, cz),
      new THREE.Vector3(0.5 * (fx + grip.x), topY + 0.65 * hl, cz + z0 * 0.45),
      new THREE.Vector3(fx, topY, cz + z0),
    ];
    const crv = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
    const pts = crv.getSpacedPoints(14), nr = pts.map(() => new THREE.Vector3(sx, 0, 0));
    if (shape === 1) s.strap(pts, nr, () => 0.006 * kk, () => 0.005 * kk, hand, REGION.strap);
    else s.strap(pts, nr, () => (shape === 0 ? 0.03 : 0.025) * kk, () => (shape === 0 ? 0.0012 : 0.0025), hand, shape === 0 ? REGION.bag : REGION.strap, flags);
  }
  return s.build();
}

/** opts.apron: also a waiter's waist apron (apron, apronFar). */
export function buildParts(char, opts = {}) {
  const J = char.skeleton.joints.map((j) => new THREE.Vector3(...j));
  const H = char.info.H, k = H / 1.76;
  const out = {};
  // ---- phone in the right palm (rest pose: the hand hangs, palm facing the thigh), glass face out
  {
    const wrist = J[BONE.handR], df = wrist.clone().sub(J[BONE.foreR]).normalize();
    const a = df.clone().add(new THREE.Vector3(0, 0, -0.05)).normalize();               // along the fingers
    const pn = new THREE.Vector3().crossVectors(a, new THREE.Vector3(0, 0, 1)).normalize(); // palm normal
    const wd = new THREE.Vector3().crossVectors(a, pn).normalize();
    const centre = wrist.clone().addScaledVector(a, 0.078 * k).addScaledVector(pn, 0.026 * k);
    const M = new THREE.Matrix4().makeBasis(wd, a, pn).setPosition(centre);
    const b = new PartBuilder();
    b.geometry(roundBox(0.071, 0.147, 0.0085, 0.0035), M, rigid(BONE.handR), REGION.prop);
    // the glass: a slab face just above the casing, facing away from the palm
    const glass = new THREE.PlaneGeometry(0.064, 0.138);
    b.geometry(glass, M.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.00435)), rigid(BONE.handR), REGION.screen);
    out.phone = b.build();
    // ---- cup (espresso / tea glass) held in the right hand's fingers, upright when raised
    const c = new PartBuilder();
    const cup = new THREE.CylinderGeometry(0.034, 0.028, 0.075, 14, 1, true);
    const bottom = new THREE.CircleGeometry(0.028, 14).rotateX(Math.PI / 2).translate(0, -0.0375, 0);
    const cc = wrist.clone().addScaledVector(a, 0.07 * k).addScaledVector(pn, 0.045 * k);
    const Mc = new THREE.Matrix4().makeBasis(wd, a.clone().negate().cross(wd).normalize().negate(), a.clone().negate()).setPosition(cc);
    // (cup axis along the fingers' perpendicular: upright when the palm faces the face)
    const Mc2 = new THREE.Matrix4().makeBasis(pn, wd, a).setPosition(cc);
    void Mc;
    c.geometry(cup, Mc2, rigid(BONE.handR), REGION.prop, FLAG.SOLID | FLAG.WHITE);
    c.geometry(bottom, Mc2, rigid(BONE.handR), REGION.prop, FLAG.SOLID | FLAG.WHITE);
    out.cup = c.build();
    // ---- shopping bags hanging from the right hand, their handles gathered in the fingers: shape 0 a
    // thin plastic carrier (a soft sack, crumpled, its handles cut from the same film), 1 a paper carrier
    // (crisp faces, the side gussets folded in, twisted paper cords), 2 a cloth tote (flat, its load
    // sagging to the bottom, long webbing handles). The person picks one (appearance bagShape).
    const grip = wrist.clone().addScaledVector(a, 0.085 * k).addScaledVector(pn, 0.02 * k);
    for (let shape = 0; shape < 3; shape++) out['shopping' + (shape || '')] = shoppingBag(shape, grip, k);
  }
  const surf = torsoSurface(char);
  const hang = char.info.hang;
  const chest = hang[0], waist = hang[1], hips = hang[2];
  const shR = J[BONE.armR], neck = J[BONE.neck];
  const shoulderTop = (x, z) => {
    // (down from above the shoulder, no higher than the base of the neck)
    const p = surf(new THREE.Vector3(x, shR.y - 0.03 * k, z), new THREE.Vector3(0, 1, 0), 0.004, 0.022, 0, 0.11 * k);
    return p || new THREE.Vector3(x, shR.y + 0.05 * k, z);
  };
  const chestSkin = (p) => {
    // straps and packs ride the chest; below the waist they follow the hips
    const wc = THREE.MathUtils.clamp((p.y - waist[0]) / Math.max(0.05, chest[0] - waist[0]), 0, 1);
    return wc > 0.5 ? [[BONE.spine2, 1]] : [[BONE.spine2, wc + 0.5], [BONE.spine1, 0.5 - wc]];
  };
  // torso axis (rest pose): the middle of the torso's depth at a height, from the surface points
  const axisZ = torsoAxis(surf);
  // the surface along a horizontal ray from the torso's axis at height y, at angle th round it
  // (0 = straight ahead, -z; +pi/2 = the figure's right, +x), pushed out by off
  const _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  const around = (y, th, off = 0.004) => {
    _d.set(Math.sin(th), 0, -Math.cos(th));
    const o = new THREE.Vector3(0, y, axisZ(y));
    const p = surf(o, _d, off, 0.022, 0, 0.45);
    return p ? { p, n: _d.clone() } : null;
  };
  // ---- backpack: a soft, rounded pack on the upper back, two padded shoulder straps
  {
    const b = new PartBuilder(), bf = new PartBuilder();
    const pw = 0.29 * k, ph = 0.38 * k, pd = 0.125 * k;
    const topY = shR.y - 0.02 * k, cy = topY - ph / 2;
    // the back's profile over the pack's height (furthest-back point across its width), then the
    // pack's front face as the tilted line resting on it (top back on the shoulder blades)
    const prof = [];
    for (let i = 0; i <= 8; i++) {
      const y = topY - 0.02 * k - (i / 8) * (ph - 0.03 * k);
      let z = -1;
      for (const x of [-pw * 0.38, -pw * 0.15, 0, pw * 0.15, pw * 0.38]) {
        const p = surf(new THREE.Vector3(x, y, 0), new THREE.Vector3(0, 0, 1), 0, 0.025, 0, 0.3);
        if (p) z = Math.max(z, p.z);
      }
      if (z > -1) prof.push([y, z]);
    }
    if (!prof.length) prof.push([cy, Math.max(chest[3], waist[3])]);
    let best = null;
    for (let ti = 0; ti <= 20; ti++) {
      const tl = -0.05 + ti * 0.02;                     // rad, top tipped back
      let z0 = -1;                                      // front face z at cy: rests on the furthest point
      for (const [y, z] of prof) z0 = Math.max(z0, z - Math.sin(tl) * (y - cy));
      let gap = 0;
      for (const [y, z] of prof) gap += z0 + Math.sin(tl) * (y - cy) - z;
      if (!best || gap < best.gap) best = { tl, z0, gap };
    }
    const tilt = best.tl;
    const M = new THREE.Matrix4().makeRotationX(tilt).setPosition(0, cy - pd / 2 * Math.sin(tilt), best.z0 + 0.006 + pd / 2 * Math.cos(tilt));
    const zBack = best.z0;
    out.fit = { tilt, z0: best.z0, prof };
    const packSkin = [[BONE.spine2, 1]];
    // (a soft pack: deep corner radii, the load bulging its faces, the top rounded and narrower;
    // the panel against the back and the seams in shade)
    const panelAO = (v) => 0.55 + 0.45 * THREE.MathUtils.smoothstep(v.z, -pd * 0.5, -pd * 0.1);
    b.geometry(roundBox(pw, ph, pd, 0.05 * k, 5, 0.13, 0.12), M, packSkin, REGION.bag, FLAG.SOLID, panelAO);
    // front pocket: a flatter, soft pouch low on the face
    b.geometry(roundBox(pw * 0.72, ph * 0.38, pd * 0.22, 0.03 * k, 3, 0.18, 0.06), M.clone().multiply(new THREE.Matrix4().makeTranslation(0, -ph * 0.19, pd * 0.5 * 1.1)),
      packSkin, REGION.bag, FLAG.SOLID, (v) => 0.7 + 0.3 * THREE.MathUtils.smoothstep(v.z, -pd * 0.11, pd * 0.04));
    // a carry loop at the top
    {
      const pts = [], nr = [];
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI * (i / 8);
        pts.push(new THREE.Vector3(Math.cos(a) * 0.035 * k, ph * 0.5 - 0.004 + Math.sin(a) * 0.028 * k, -pd * 0.18).applyMatrix4(M));
        nr.push(new THREE.Vector3(0, 0, 1).transformDirection(M));
      }
      b.strap(pts, nr, () => 0.018 * k, () => 0.004, packSkin, REGION.strap);
    }
    bf.geometry(roundBox(pw, ph, pd, 0.05 * k, 1, 0.13, 0.12), M, packSkin, REGION.bag);
    // shoulder straps: padded, from the pack's top up over the trapezius, over the shoulder and down the
    // front of the chest to the lower ribs, where a buckle takes a thin webbing strap (25 x 2 mm) back
    // round the side under the arm to the pack's lower corner. The paths start on the torso's surface
    // (rays out from the torso's axis; over the shoulder, rays down onto its top), then settle on the
    // cloth under tension (settle). Skin weights: the cloth's under each point, the pack's near it.
    const packAt = (p) => surf.skin(p) || chestSkin(p);
    for (const sg of [-1, 1]) {
      const pts = [], nr = [];
      const add = (q) => { if (q) { pts.push(q.p); nr.push(q.n); } };
      // up the back from the pack's top edge
      pts.push(new THREE.Vector3(sg * pw * 0.3, ph * 0.5 - 0.02 * k, -pd * 0.42).applyMatrix4(M));
      nr.push(new THREE.Vector3(0, 0.4, 1).normalize());
      for (let i = 1; i <= 4; i++) {
        const u = i / 4;
        add(around(topY + u * (shR.y - 0.045 * k - topY), Math.PI - sg * (0.3 + 0.22 * u), 0.005));
      }
      // over the shoulder (back to front)
      for (let i = 0; i <= 4; i++) {
        const u = i / 4;
        const x = sg * (0.095 + 0.012 * u) * k, z = (0.045 - 0.09 * u) * k;
        const q = surf(new THREE.Vector3(x, shR.y - 0.03 * k, z), _up, 0.005, 0.016, 0, 0.11 * k);
        if (q) add({ p: q, n: new THREE.Vector3(0, 1, 0) });
      }
      // down the front of the chest to the lower ribs
      const yA = Math.min(chest[0], shR.y - 0.12 * k) - 0.07 * k;
      for (let i = 0; i <= 6; i++) {
        const u = i / 6;
        add(around(shR.y - 0.05 * k - u * (shR.y - 0.05 * k - yA), sg * (0.56 + 0.2 * u), 0.005));
      }
      if (pts.length < 8) continue;
      let [sp, sn] = resamplePath(pts, nr, 0.02 * k);
      const L = arcLengths(sp), Lt = L[L.length - 1];
      // (free of the back only where it leaves the pack)
      settle(surf, sp, sn, { off: 0.004, gap: (i) => 0.008 + 0.05 * Math.max(0, 1 - L[i] / (0.08 * k)) });
      const W = 0.05 * k, T = 0.011 * k;
      const skinP = (p, i) => {
        const s = packAt(p), u = Math.max(0, 1 - L[i] / (0.1 * k));
        return u > 0 ? mixSkin(s, packSkin, u) : s;
      };
      const sks = sp.map((p, i) => skinP(p, i));
      // (the padding thins to the strap's ends; the last few cm before the buckle flatten)
      b.strap(sp, sn, (i) => W * (L[i] > Lt - 0.04 * k ? 0.75 : 1),
        (i) => T * Math.min(1, 0.45 + L[i] / (0.06 * k)) * (L[i] > Lt - 0.05 * k ? 0.6 : 1), (p, i) => sks[i], REGION.strap);
      // the buckle at the padded strap's end
      const e = sp[sp.length - 1], en = sn[sn.length - 1];
      const et = e.clone().sub(sp[sp.length - 2]).normalize();
      const ex = new THREE.Vector3().crossVectors(et, en).normalize();
      const MB = new THREE.Matrix4().makeBasis(ex, et, new THREE.Vector3().crossVectors(ex, et).normalize())
        .setPosition(e.clone().addScaledVector(en, 0.004 * k));
      b.geometry(roundBox(0.034 * k, 0.022 * k, 0.006 * k, 0.002 * k, 1), MB, sks[sks.length - 1], REGION.strap, FLAG.SOLID, 0.8);
      // the webbing: from the buckle back round the side, under the arm, to the pack's lower corner
      const wp = [e.clone()], wn = [en.clone()];
      const yE = cy - ph * 0.36;
      const th0 = Math.atan2(sg * e.x, -(e.z - axisZ(e.y)));
      for (let i = 1; i <= 7; i++) {
        const u = i / 8;
        const th = th0 + (Math.PI - 0.75 - th0) * THREE.MathUtils.smoothstep(u, 0, 0.8);
        const q = around(e.y - (e.y - yE) * u, sg * th, 0.003);
        if (q) { wp.push(q.p); wn.push(q.n); }
      }
      const end = new THREE.Vector3(sg * pw * 0.42, -ph * 0.36, -pd * 0.32).applyMatrix4(M);
      wp.push(end); wn.push(new THREE.Vector3(sg, 0, 0));
      if (wp.length >= 4) {
        const [wq, wnn] = resamplePath(wp, wn, 0.025 * k);
        const LW = arcLengths(wq), LWt = LW[LW.length - 1];
        settle(surf, wq, wnn, { off: 0.003, gap: (i) => 0.006 + 0.04 * Math.max(0, 1 - (LWt - LW[i]) / (0.08 * k)) });
        const wsk = wq.map((p, i) => mixSkin(packAt(p), packSkin, Math.max(0, 1 - (LWt - LW[i]) / (0.12 * k))));
        b.strap(wq, wnn, () => 0.025 * k, () => 0.0022, (p, i) => wsk[i], REGION.strap);
      }
      // (the far stand-in keeps the straps as flat bands: they do not vanish at the LOD switch)
      const [fp, fn] = coarsePath(sp, sn, 3);
      bf.ribbon(fp, fn, W * 0.9, chestSkin, REGION.strap, 0.006);
    }
    out.backpack = b.build();
    out.backpackFar = bf.build();
  }
  // ---- cross-body shoulder bag: a soft bag lying against the left hip just behind the side line
  // (its inner face follows the hip's curve; the left arm, held a little out by it, swings past its
  // front), its strap from the bag's front end up across the chest, over the right shoulder and down
  // across the back to the bag's rear end
  {
    const b = new PartBuilder(), bf = new PartBuilder();
    const bw = 0.23 * k, bh = 0.175 * k, bd = 0.065 * k;
    const by = hips[0] - 0.01 * k;
    const az = axisZ(by);
    // angle round the hip: phi 0 = the figure's left side (-x), + towards the back
    const dirP = (phi, o) => o.set(-Math.cos(phi), 0, Math.sin(phi));
    const NPH = 33, PH0 = -1.4, PH1 = 1.4;
    const rad = new Float64Array(NPH);
    const _o = new THREE.Vector3(), _dd = new THREE.Vector3();
    for (let i = 0; i < NPH; i++) {
      const phi = PH0 + ((PH1 - PH0) * i) / (NPH - 1);
      let r = 0;
      // (the bag hangs flat down its height: it rests on the outermost surface over it)
      for (const dy of [-0.42, -0.2, 0, 0.2, 0.42]) {
        _o.set(0, by + dy * bh, az);
        const q = surf(_o, dirP(phi, _dd), 0, 0.022, 0, 0.45);
        if (q) r = Math.max(r, Math.hypot(q.x, q.z - az));
      }
      rad[i] = r || 0.17 * k;
    }
    // smoothed (soft leather bridges small hollows)
    for (let it = 0; it < 3; it++) {
      const c = Float64Array.from(rad);
      for (let i = 1; i < NPH - 1; i++) rad[i] = Math.max(c[i], 0.25 * c[i - 1] + 0.5 * c[i] + 0.25 * c[i + 1]);
    }
    const radAt = (phi) => {
      const f = THREE.MathUtils.clamp(((phi - PH0) / (PH1 - PH0)) * (NPH - 1), 0, NPH - 1.001);
      const i = Math.floor(f);
      return rad[i] + (rad[i + 1] - rad[i]) * (f - i);
    };
    const phc = 0.08;
    const rMid = radAt(phc) + 0.005 + bd * 0.5;
    const half = bw / 2 / rMid;
    const _dp = new THREE.Vector3(), _tg = new THREE.Vector3();
    // bag-local (x thin: -bd/2 against the hip .. +bd/2 outside; y up; z along the bag) -> wrapped
    // round the hip
    const wrap = (v, nrm) => {
      const phi = phc + v.z / rMid;
      const r = Math.max(radAt(phi) + 0.003, radAt(phi) + 0.005 + v.x + bd / 2);
      dirP(phi, _dp);
      _tg.set(Math.sin(phi), 0, Math.cos(phi));
      const nx = nrm.x, ny = nrm.y, nz = nrm.z;
      v.set(_dp.x * r, by + v.y, az + _dp.z * r);
      nrm.set(_dp.x * nx + _tg.x * nz, ny, _dp.z * nx + _tg.z * nz).normalize();
    };
    const bagSkin = [[BONE.pelvis, 0.7], [BONE.spine1, 0.3]];
    const innerAO = (v) => 0.5 + 0.5 * THREE.MathUtils.smoothstep(v.x, -bd * 0.5, bd * 0.15);
    b.warp(roundBox(bd, bh, bw, 0.022 * k, 4, 0.12, 0.05), wrap, bagSkin, REGION.bag, FLAG.SOLID, innerAO);
    // the flap over the top two thirds of its face
    // (laid on the bag's swollen face: the same bulge as roundBox's pillow)
    b.warp(roundBox(0.005 * k, bh * 0.64, bw * 1.015, 0.002 * k, 3, 0, 0), (v, n) => {
      const yy = v.y + bh * 0.19, a = yy / (bh / 2), c = v.z / (bw / 2);
      const bul = (1 - Math.min(1, a * a)) * (1 - Math.min(1, c * c));
      v.x += (bd / 2) * (1 + 0.24 * bul) + 0.0025;
      v.y = yy;
      wrap(v, n);
    }, bagSkin, REGION.bag, FLAG.SOLID, 0.92);
    bf.warp(roundBox(bd, bh, bw, 0.02 * k, 1, 0.1, 0.05), wrap, bagSkin, REGION.bag);
    // strap ends: on the bag's top, 1.5 cm in from its ends, at the middle of its depth
    const endAt = (s) => {
      const v = new THREE.Vector3(0, bh / 2 - 0.004, s * (bw / 2 - 0.015 * k)), n = new THREE.Vector3(-1, 0, 0);
      wrap(v, n);
      return v;
    };
    const pF = endAt(-1), pB = endAt(1);
    // (angles round the torso: th = -pi/2 - phi)
    const thF = -Math.PI / 2 - (phc - half * 0.85), thB = -Math.PI / 2 - (phc + half * 0.85);
    const yS = shR.y - 0.06 * k;                          // where the strap leaves the shoulder's top
    const pts = [pF], nr = [dirP(phc - half, new THREE.Vector3())], tk = [];
    // up across the front: from the bag's front end, crossing the chest, to the front of the right shoulder
    const thS = 0.62;
    for (let i = 1; i <= 14; i++) {
      const u = i / 14;
      const q = around(pF.y + (yS - pF.y) * u, thF + (thS - thF) * u, 0.005);
      if (q) { pts.push(q.p); nr.push(q.n); }
    }
    // over the right shoulder, near the neck
    for (let i = 0; i <= 4; i++) {
      const u = i / 4;
      const q = surf(new THREE.Vector3((0.096 + 0.008 * Math.sin(Math.PI * u)) * k, shR.y - 0.03 * k, (-0.045 + 0.09 * u) * k), _up, 0.005, 0.016, 0, 0.11 * k);
      if (q) { pts.push(q); nr.push(new THREE.Vector3(0, 1, 0)); }
    }
    // down across the back to the bag's rear end (th from the back of the right shoulder, round past
    // the spine, to the left side)
    const thS2 = Math.PI - 0.62, thB2 = thB + 2 * Math.PI;
    for (let i = 0; i <= 13; i++) {
      const u = i / 14;
      const q = around(yS + (pB.y - yS) * u, thS2 + (thB2 - thS2) * u, 0.005);
      if (q) { pts.push(q.p); nr.push(q.n); }
    }
    pts.push(pB); nr.push(dirP(phc + half, new THREE.Vector3()));
    // (resampled every 2 cm, then settled on the cloth under tension: across the chest it runs between
    // the breasts and lies on the cloth, free of the body only where it rises from the bag)
    const [sp, sn] = resamplePath(pts, nr, 0.02 * k);
    const L = arcLengths(sp), Lt = L[L.length - 1];
    const endW = (i) => Math.max(0, 1 - Math.min(L[i], Lt - L[i]) / (0.12 * k));
    settle(surf, sp, sn, { off: 0.003, gap: (i) => 0.008 + 0.045 * endW(i), iters: 8 });
    // skinning: the cloth's own weights under each point (the shoulder's top moves with the clavicle and
    // the chest with the ribs), blending into the bag's towards its two ends
    const strapSkin = (p) => {
      if (p.y < waist[0]) {
        const u = THREE.MathUtils.clamp((waist[0] - p.y) / Math.max(0.05, waist[0] - (by + bh / 2)), 0, 1);
        return [[BONE.spine1, 1 - 0.7 * u], [BONE.pelvis, 0.7 * u]];
      }
      const sk = chestSkin(p);
      if (p.x > 0.04 * k && p.y > shR.y - 0.07 * k) return [[BONE.spine2, 0.72], [BONE.clavR, 0.28]];
      return sk;
    };
    const sks = sp.map((p, i) => {
      // (no thigh weights: the strap never follows a striding leg)
      const s = (surf.skin(p) || strapSkin(p)).filter(([bn]) => bn !== BONE.thighL && bn !== BONE.thighR);
      return mixSkin(s.length ? s : strapSkin(p), bagSkin, endW(i) ** 0.7);
    });
    const SW = 0.032 * Math.min(1, k * 1.1);
    b.strap(sp, sn, () => SW, () => 0.003, (p, i) => sks[i], REGION.strap);
    { const [fp, fn] = coarsePath(sp, sn, 3); bf.ribbon(fp, fn, SW, strapSkin, REGION.strap, 0.005); }
    out.shoulder = b.build();
    out.shoulderFar = bf.build();
  }
  // ---- glasses: sunglasses or a thin frame (drawn for the people wearing them, appearance glasses)
  if (char.ageClass !== 'toddler') {
    try {
      const sg = glasses(char, J, true), cg = glasses(char, J, false), sf = glasses(char, J, true, true);
      if (sg) out.sunglasses = sg;
      if (sf) out.sunglassesFar = sf;
      if (cg) out.glasses = cg;
    } catch (e) { /* no glasses for this character */ }
  }
  if (opts.apron) {
    out.apron = apron(char, J, k, surf, hips[0], waist[0], 28, 18, true);
    out.apronFar = apron(char, J, k, surf, hips[0], waist[0], 10, 5, false);
  }
  return out;
}
