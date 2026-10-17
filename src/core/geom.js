import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Geometry helpers shared by generators. UV convention: metres (1 UV unit = 1 m).

const _p = new THREE.Vector3();

/** Horizontal strip following the route between lateral offsets dA(s) and dB(s) (numbers or functions).
 *  u = distance along the strip (route s), v = lateral metres. Normal up. */
export function ribbonGeometry(route, s0, s1, dA, dB, { h = 0, step = 2, uOffset = 0 } = {}) {
  const fA = typeof dA === 'function' ? dA : () => dA;
  const fB = typeof dB === 'function' ? dB : () => dB;
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const pos = [], uv = [], nor = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    const a = fA(s), b = fB(s);
    route.toWorld(s, a, h, _p); pos.push(_p.x, _p.y, _p.z); uv.push(s + uOffset, a); nor.push(0, 1, 0);
    route.toWorld(s, b, h, _p); pos.push(_p.x, _p.y, _p.z); uv.push(s + uOffset, b); nor.push(0, 1, 0);
    if (i < n) {
      const k = i * 2;
      // ensure upward facing regardless of dA < dB
      if (a < b) idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      else idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** Sweep a 2D cross-section profile [[d, h], ...] (in route lateral/height) along the route.
 *  The profile must run counter-clockwise in the (d right, h up) plane so normals face outward.
 *  u = s along the route, v = accumulated profile length. Normals computed from the profile. */
export function sweepProfile(route, s0, s1, profile, { step = 2, closed = false, dOffset = 0, smooth = false } = {}) {
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const m = profile.length;
  const segs = closed ? m : m - 1;
  const pos = [], uv = [], nor = [], idx = [];
  const smp = {};
  // per profile edge, duplicate vertices for flat shading unless smooth
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    route.sample(s, smp);
    let acc = 0;
    for (let e = 0; e < segs; e++) {
      const A = profile[e], B = profile[(e + 1) % m];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      // 2D outward normal of the edge (d, h) -> rotate (dx, dh) by -90°
      const nd = (B[1] - A[1]) / len, nh = -(B[0] - A[0]) / len;
      for (const [P, v] of [[A, acc], [B, acc + len]]) {
        const d = P[0] + dOffset;
        pos.push(smp.pos.x + smp.right.x * d, smp.pos.y + P[1], smp.pos.z + smp.right.z * d);
        nor.push(smp.right.x * nd, nh, smp.right.z * nd);
        uv.push(s, v);
      }
      acc += len;
    }
  }
  const per = segs * 2;
  for (let i = 0; i < n; i++) {
    for (let e = 0; e < segs; e++) {
      const a = i * per + e * 2, b = a + 1, c = a + per, d = b + per;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  if (smooth) g.computeVertexNormals();
  return g;
}

/** Collects geometries per material and merges them into one mesh per material. */
export class MeshBatcher {
  constructor() { this.map = new Map(); }
  add(material, geometry, matrix = null) {
    if (!geometry) return;
    let g = geometry;
    if (matrix) { g = geometry.clone(); g.applyMatrix4(matrix); }
    if (!this.map.has(material)) this.map.set(material, []);
    this.map.get(material).push(g);
  }
  build({ castShadow = true, receiveShadow = true, name = 'batch' } = {}) {
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, list] of this.map) {
      const norm = normalizeAttributes(list);
      const merged = norm.length === 1 ? norm[0] : mergeGeometries(norm, false);
      if (!merged) { console.warn('merge failed for', mat.name); continue; }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
      mesh.name = `${name}:${mat.name}`;
      group.add(mesh);
      for (const g of list) if (g !== merged) g.dispose();
    }
    this.map.clear();
    return group;
  }
}

/** Make every geometry indexed and give them the same attribute set (missing ones filled). */
export function normalizeAttributes(list) {
  const names = new Set();
  for (const g of list) for (const k of Object.keys(g.attributes)) names.add(k);
  return list.map((g0) => {
    let g = g0.index ? g0 : indexify(g0);
    for (const k of names) {
      if (!g.attributes[k]) {
        const count = g.attributes.position.count;
        const ref = list.find((x) => x.attributes[k]).attributes[k];
        const arr = new Float32Array(count * ref.itemSize);
        if (k === 'color') arr.fill(1);
        g.setAttribute(k, new THREE.BufferAttribute(arr, ref.itemSize));
      }
    }
    for (const k of Object.keys(g.attributes)) if (!names.has(k)) g.deleteAttribute(k);
    return g;
  });
}

function indexify(g) {
  const count = g.attributes.position.count;
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/** Fill a 'color' attribute with a constant (e.g. tint / baked AO). */
export function setColor(g, r, gg, b) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = r; arr[i * 3 + 1] = gg; arr[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
