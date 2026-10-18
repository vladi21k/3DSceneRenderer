import * as THREE from 'three';
import { BONE } from '../anim.js';
import { REGION } from './appearance.js';

// Runtime accessories fitted to each character of the cast, in the cast's vertex layout (mh/cast.js
// mergeMeshes): a phone and a cup (rigid in the right hand), a shopping bag (hanging from the right
// hand), a backpack and a cross-body shoulder bag (on the back / the left hip, their straps laid on
// the character's own clothed surface: strap points are pushed out of the rest-pose torso found
// in the character's vertices). Untextured: flag SOLID, shaded from the wearer's region tints.
//
//   buildParts(char) -> { phone, cup, shopping, backpack, backpackFar, shoulder, shoulderFar } (raw meshes)

export const FLAG = { ALPHA: 1, BACK: 2, DETAIL: 4, SKIRT: 8, SOLID: 16, WHITE: 32 };
const ARM_BONES = new Set([BONE.armL, BONE.foreL, BONE.handL, BONE.armR, BONE.foreR, BONE.handR]);
const _v = new THREE.Vector3(), _n = new THREE.Vector3();

class PartBuilder {
  constructor() { this.P = []; this.N = []; this.UV = []; this.BI = []; this.BW = []; this.T = []; this.I = []; this.n = 0; }

  /** Add a THREE geometry through matrix M, skinned by skin(p) -> [[bone, w], ...] (or a fixed list). */
  geometry(geo, M, skin, region, flags = FLAG.SOLID, ao = 1) {
    const g = geo.index ? geo : geo;
    const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    const v0 = this.n;
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(M);
      _n.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize();
      this.vertex(_v, _n, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0, typeof skin === 'function' ? skin(_v) : skin, region, flags, ao);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.I.push(v0 + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) this.I.push(v0 + i);
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

/** Rounded box (bevelled) geometry of size w x h x d centred at the origin. */
function roundBox(w, h, d, r, seg = 3) {
  const g = new THREE.BoxGeometry(w, h, d, seg * 3, seg * 3, seg * 2);
  const p = g.attributes.position;
  const inner = new THREE.Vector3(w / 2 - r, h / 2 - r, d / 2 - r);
  const v = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    c.set(THREE.MathUtils.clamp(v.x, -inner.x, inner.x), THREE.MathUtils.clamp(v.y, -inner.y, inner.y), THREE.MathUtils.clamp(v.z, -inner.z, inner.z));
    n.subVectors(v, c);
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    v.copy(c).addScaledVector(n, r);
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
  const pts = [];
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
  }
  const P = new Float32Array(pts);
  return (p, d, off = 0.004, rad = 0.025, tmin = -0.35, tmax = 0.35) => {
    let best = -Infinity;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i] - p.x, y = P[i + 1] - p.y, z = P[i + 2] - p.z;
      const t = x * d.x + y * d.y + z * d.z;
      if (t < tmin || t > tmax || t < best) continue;
      const qx = x - d.x * t, qy = y - d.y * t, qz = z - d.z * t;
      if (qx * qx + qy * qy + qz * qz < rad * rad) best = t;
    }
    return best === -Infinity ? null : p.clone().addScaledVector(d, best + off);
  };
}

const rigid = (b) => [[b, 1]];

export function buildParts(char) {
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
    // ---- shopping bag hanging from the right hand (handles in the fingers)
    const s = new PartBuilder();
    const grip = wrist.clone().addScaledVector(a, 0.085 * k).addScaledVector(pn, 0.02 * k);
    const bw = 0.30 * Math.min(1, k), bh = 0.33 * Math.min(1, k), bd = 0.11 * Math.min(1, k);
    const top = grip.clone().add(new THREE.Vector3(0.025 * k, -0.10 * k, 0));
    const bag = roundBox(bd, bh, bw, 0.012);
    s.geometry(bag, new THREE.Matrix4().makeTranslation(top.x + 0.012, top.y - bh / 2, top.z), rigid(BONE.handR), REGION.bag);
    for (const sz of [-1, 1]) {
      const pts = [], nr = [];
      for (let i = 0; i <= 6; i++) {
        const u = i / 6, ang = Math.PI * u;
        const pz = top.z + sz * 0.012 + Math.cos(ang) * bw * 0.22;
        const py = top.y + Math.sin(ang) * (grip.y - top.y);
        pts.push(new THREE.Vector3(top.x + 0.012 + sz * bd * 0.5, py, pz));
        nr.push(new THREE.Vector3(sz, 0, 0));
      }
      s.ribbon(pts, nr, 0.018, rigid(BONE.handR), REGION.strap, 0.002);
    }
    out.shopping = s.build();
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
  // ---- backpack: a rounded pack on the upper back, two shoulder straps
  {
    const b = new PartBuilder(), bf = new PartBuilder();
    const pw = 0.29 * k, ph = 0.37 * k, pd = 0.13 * k;
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
    const M = new THREE.Matrix4().makeRotationX(tilt).setPosition(0, cy - pd / 2 * Math.sin(tilt), best.z0 + 0.008 + pd / 2 * Math.cos(tilt));
    const zBack = best.z0;
    out.fit = { tilt, z0: best.z0, prof };
    b.geometry(roundBox(pw, ph, pd, 0.04 * k), M, [[BONE.spine2, 1]], REGION.bag);
    // front pocket
    b.geometry(roundBox(pw * 0.72, ph * 0.38, pd * 0.35, 0.025 * k), M.clone().multiply(new THREE.Matrix4().makeTranslation(0, -ph * 0.22, pd / 2 + pd * 0.12)),
      [[BONE.spine2, 1]], REGION.bag);
    bf.geometry(new THREE.BoxGeometry(pw * 0.95, ph * 0.95, pd), M, [[BONE.spine2, 1]], REGION.bag);
    for (const sg of [-1, 1]) {
      const pts = [], nr = [];
      const x0 = sg * 0.07 * k;
      // over the shoulder: from the pack's top, over the trapezius, down the chest, under the arm
      const ctrl = [
        [x0, topY - 0.01 * k, 'back'], [sg * 0.085 * k, neck.y - 0.075 * k, 'back'], ['top', sg * 0.095 * k, -0.005 * k],
        ['top', sg * 0.105 * k, -0.04 * k], [sg * 0.11 * k, shR.y - 0.07 * k, 'front'], [sg * 0.12 * k, chest[0] - 0.04 * k, 'front'],
        [sg * (chest[1] + 0.0) * 0.98, chest[0] - 0.11 * k, 'side'], [sg * pw * 0.42, cy - ph * 0.42, 'back'],
      ];
      for (const c of ctrl) {
        let p;
        if (c[0] === 'top') {
          p = shoulderTop(c[1], c[2]);
          nr.push(new THREE.Vector3(0, 1, 0));
        } else {
          const dir = c[2] === 'back' ? new THREE.Vector3(0, 0, 1) : c[2] === 'front' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(sg, 0, 0);
          const base = new THREE.Vector3(c[0], c[1], c[2] === 'side' ? 0 : 0);
          if (c[2] === 'side') base.x = 0;
          p = surf(base, dir, 0.005) || base.clone().addScaledVector(dir, 0.12 * k);
          if (c[2] === 'back' && c === ctrl[ctrl.length - 1]) p.z = Math.max(p.z, zBack + 0.01);
          nr.push(dir);
        }
        pts.push(p);
      }
      // smooth the polyline (Catmull-Rom) and re-project onto the surface along the averaged normals
      const curve = new THREE.CatmullRomCurve3(pts);
      const sp = curve.getPoints(18), sn = [];
      for (let i = 0; i < sp.length; i++) {
        const u = (i / (sp.length - 1)) * (nr.length - 1), i0 = Math.floor(u), f = u - i0;
        const nrm = nr[i0].clone().lerp(nr[Math.min(nr.length - 1, i0 + 1)], f).normalize();
        const q = surf(sp[i].clone().addScaledVector(nrm, -0.05), nrm, 0.005, 0.02);
        if (q && q.distanceTo(sp[i]) < 0.05) sp[i].copy(q);
        sn.push(nrm);
      }
      b.ribbon(sp, sn, 0.045 * Math.min(1, k * 1.1), chestSkin, REGION.strap, 0.004);
    }
    out.backpack = b.build();
    out.backpackFar = bf.build();
  }
  // ---- cross-body shoulder bag: the strap from the right shoulder across the chest and the back
  // to a bag at the left hip, a little behind the line of the arm swing
  {
    const b = new PartBuilder(), bf = new PartBuilder();
    const bw = 0.25 * k, bh = 0.19 * k, bd = 0.075 * k;
    const hipW = Math.max(hips[1], waist[1]);
    const yaw = 0.45;                                   // turned towards the back
    const by = hips[0] + 0.01 * k;
    // against the hip: the clothed surface along the bag's outward direction (left and back)
    const dirB = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
    let side = null;
    for (const dy of [-0.06, 0, 0.06]) {
      const q = surf(new THREE.Vector3(0, by + dy * k, 0.01), dirB, 0, 0.03, 0, 0.4);
      if (q && (!side || q.dot(dirB) > side.dot(dirB))) side = q.setY(by);
    }
    if (!side) side = new THREE.Vector3(-hipW, by, 0.03);
    const ctr = side.clone().addScaledVector(dirB, bd * 0.5 + 0.006);
    const bx = ctr.x, bz = ctr.z;
    const M = new THREE.Matrix4().makeRotationY(-yaw).setPosition(bx, by, bz);
    const hipSkin = [[BONE.pelvis, 0.7], [BONE.spine1, 0.3]];
    b.geometry(roundBox(bd, bh, bw, 0.02 * k), M, hipSkin, REGION.bag);
    // flap
    b.geometry(roundBox(bd * 0.25, bh * 0.6, bw * 1.02, 0.01 * k), M.clone().multiply(new THREE.Matrix4().makeTranslation(-bd * 0.55, bh * 0.2, 0)), hipSkin, REGION.bag);
    bf.geometry(new THREE.BoxGeometry(bd, bh, bw), M, hipSkin, REGION.bag);
    const top = new THREE.Vector3(bx, by + bh / 2, bz);
    const ring = [];
    // round the torso: angle 0 = the right shoulder top, pi = the left hip
    const N = 26;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2;
      const u = 0.5 - 0.5 * Math.cos(th);            // 0 at the shoulder, 1 at the hip
      const y = (neck.y - 0.03 * k) * (1 - u) + (top.y + 0.02 * k) * u;
      const front = Math.sin(th) > 0;                  // first half runs down the front
      if (u < 0.12) {
        const x = 0.10 * k * (1 - u * 2);
        ring.push({ p: shoulderTop(x + 0.005, (front ? -1 : 1) * 0.02 * k * u / 0.12), n: new THREE.Vector3(0, 1, 0) });
        continue;
      }
      const x = 0.10 * k - (0.10 * k + hipW) * u;
      const dir = new THREE.Vector3(0, 0, front ? -1 : 1);
      const p = surf(new THREE.Vector3(x, y, 0), dir, 0.005, 0.022);
      if (p) ring.push({ p, n: dir });
    }
    // the ends meet the bag's top
    ring.push({ p: top.clone().add(new THREE.Vector3(0, 0.01, 0)), n: new THREE.Vector3(-1, 0, 0) });
    ring.unshift({ p: top.clone().add(new THREE.Vector3(0, 0.01, -0.02)), n: new THREE.Vector3(-1, 0, 0) });
    const curve = new THREE.CatmullRomCurve3(ring.map((r) => r.p), false);
    const sp = curve.getPoints(40), sn = [];
    for (let i = 0; i < sp.length; i++) {
      const u = (i / (sp.length - 1)) * (ring.length - 1), i0 = Math.floor(u), f = u - i0;
      sn.push(ring[i0].n.clone().lerp(ring[Math.min(ring.length - 1, i0 + 1)].n, f).normalize());
    }
    b.ribbon(sp, sn, 0.03 * Math.min(1, k * 1.1), chestSkin, REGION.strap, 0.003);
    out.shoulder = b.build();
    out.shoulderFar = bf.build();
  }
  return out;
}
