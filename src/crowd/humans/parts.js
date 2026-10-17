import * as THREE from 'three';

// Runtime-generated parts merged into the figure geometries.
// The skirt / dress / long-coat shell is a (angle, length) grid: its actual shape (waist
// and hip fit, flare, drape folds, hem length) and its skinning are computed in the
// vertex shader from the wearer's look row, so one mesh serves every skirt.

const REGION_SKIRT = 15;
const REGION_PHONE = 21;
const BONE_HAND_R = 13;
const ATTRS = ['position', 'aNrm', 'aBoneI', 'aBoneW', 'aMorph', 'aBody', 'aShape'];

export function makeSkirtPart(nTheta, nT, partId) {
  const nv = (nTheta + 1) * (nT + 1);
  const pos = new Float32Array(nv * 3);
  const body = new Uint8Array(nv * 4);
  let v = 0;
  for (let j = 0; j <= nT; j++) {
    // denser rings near the waist where the fit changes fastest
    const t = Math.pow(j / nT, 1.25);
    for (let i = 0; i <= nTheta; i++, v++) {
      pos[v * 3] = (i / nTheta) * Math.PI * 2;
      pos[v * 3 + 1] = t;
      body[v * 4] = REGION_SKIRT;
      body[v * 4 + 1] = partId;
    }
  }
  const idx = [];
  const at = (i, j) => j * (nTheta + 1) + i;
  for (let j = 0; j < nT; j++) {
    for (let i = 0; i < nTheta; i++) {
      // outward facing: down the skirt, then around (+x from the back)
      idx.push(at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i + 1, j));
    }
  }
  const nrm = new Int8Array(nv * 4);
  for (let k = 0; k < nv; k++) { nrm[k * 4 + 1] = 127; nrm[k * 4 + 3] = 120; }
  return {
    count: nv,
    attributes: {
      position: pos, aNrm: nrm, aBoneI: new Uint8Array(nv * 4), aBoneW: new Uint8Array(nv * 4),
      aMorph: new Int8Array(nv * 4), aBody: body, aShape: new Int8Array(nv * 4),
    },
    index: idx,
  };
}

/**
 * A phone held in the right palm (rest pose: the hand hangs, palm facing the thigh): a
 * 7 x 14.5 x 0.8 cm rounded slab along the hand, its glass face turned away from the palm.
 * aux0 marks the glass face, aux1 the distance from the screen centre (1 at the bezel).
 */
export function makePhonePart(rig, info, partId) {
  const R = rig.rest;
  const k = info.H / 1.76;
  const wrist = R[BONE_HAND_R].clone();
  const df = wrist.clone().sub(R[BONE_HAND_R - 1]).normalize();
  const a = df.clone().add(new THREE.Vector3(0, 0, -0.05)).normalize();             // along the fingers
  const pn = new THREE.Vector3().crossVectors(a, new THREE.Vector3(0, 0, 1)).normalize(); // palm normal
  const wd = new THREE.Vector3().crossVectors(a, pn).normalize();                          // across the palm (wd, a, pn right-handed)
  const hx = 0.035, hy = 0.0725, hz = 0.004, rr = 0.0036;
  const centre = wrist.clone().addScaledVector(a, 0.078 * k).addScaledVector(pn, 0.027 * k);
  const box = new THREE.BoxGeometry(2 * hx, 2 * hy, 2 * hz, 6, 12, 1);
  const bp = box.attributes.position;
  const nv = bp.count;
  const pos = new Float32Array(nv * 3), nrm = new Int8Array(nv * 4), bi = new Uint8Array(nv * 4), bw = new Uint8Array(nv * 4);
  const body = new Uint8Array(nv * 4);
  const inner = new THREE.Vector3(hx - rr, hy - rr, hz - rr * 0.9);
  const v = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), w = new THREE.Vector3();
  for (let i = 0; i < nv; i++) {
    v.fromBufferAttribute(bp, i);
    c.set(THREE.MathUtils.clamp(v.x, -inner.x, inner.x), THREE.MathUtils.clamp(v.y, -inner.y, inner.y), THREE.MathUtils.clamp(v.z, -inner.z, inner.z));
    n.subVectors(v, c);
    if (n.lengthSq() < 1e-12) n.set(0, 0, Math.sign(v.z) || 1);
    n.normalize();
    v.copy(c).addScaledVector(n, rr);
    // local (x across, y along, z out of the glass) -> rest model space
    w.copy(centre).addScaledVector(wd, v.x).addScaledVector(a, v.y).addScaledVector(pn, v.z);
    pos.set([w.x, w.y, w.z], i * 3);
    const nw = new THREE.Vector3().addScaledVector(wd, n.x).addScaledVector(a, n.y).addScaledVector(pn, n.z).normalize();
    nrm.set([Math.round(nw.x * 127), Math.round(nw.y * 127), Math.round(nw.z * 127), 118], i * 4);
    bi[i * 4] = BONE_HAND_R; bw[i * 4] = 255;
    const face = n.z > 0.7;
    const edge = Math.min(1, Math.max(Math.abs(v.x) / (hx - 0.0035), Math.abs(v.y) / (hy - 0.008)));
    body.set([REGION_PHONE, partId, face ? 255 : 0, Math.round(edge * 255)], i * 4);
  }
  const index = Array.from(box.index.array);
  box.dispose();
  return {
    count: nv,
    attributes: { position: pos, aNrm: nrm, aBoneI: bi, aBoneW: bw, aMorph: new Int8Array(nv * 4), aBody: body, aShape: new Int8Array(nv * 4) },
    index,
  };
}

/** New instanced geometry = base geometry + part (same attribute layout). */
export function appendPart(geo, part) {
  const n0 = geo.attributes.position.count;
  const g = new THREE.InstancedBufferGeometry();
  for (const name of ATTRS) {
    const a = geo.attributes[name];
    const add = part.attributes[name];
    const arr = new a.array.constructor(a.array.length + add.length);
    arr.set(a.array, 0);
    arr.set(add, a.array.length);
    g.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  // same buffer as 'normal' too: without a normal attribute three.js flat-shades lit materials
  g.setAttribute('normal', g.attributes.aNrm);
  const i0 = geo.index.array;
  const total = n0 + part.count;
  const IA = total > 65535 ? Uint32Array : Uint16Array;
  const idx = new IA(i0.length + part.index.length);
  idx.set(i0, 0);
  for (let k = 0; k < part.index.length; k++) idx[i0.length + k] = part.index[k] + n0;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = geo.boundingSphere.clone();
  g.userData.shared = true;
  return g;
}

/** Triangle ranges per part id in a merged figure geometry (index order is grouped by part). */
export function partRanges(geo) {
  const idx = geo.index.array, body = geo.attributes.aBody.array;
  const ranges = new Map();
  for (let t = 0; t < idx.length; t += 3) {
    const pid = body[idx[t] * 4 + 1];
    const r = ranges.get(pid);
    if (!r) ranges.set(pid, { start: t, count: 3 });
    else r.count = t + 3 - r.start;
  }
  return ranges;
}

/** Geometry sharing `geo`'s buffers but drawing only [start, start + count) of its index. */
export function subGeometry(geo, start, count) {
  const g = new THREE.InstancedBufferGeometry();
  for (const [name, a] of Object.entries(geo.attributes)) if (name !== 'iRow') g.setAttribute(name, a);
  g.setIndex(geo.index);
  g.setDrawRange(start, count);
  g.boundingSphere = geo.boundingSphere.clone();
  g.userData.shared = true;
  return g;
}
