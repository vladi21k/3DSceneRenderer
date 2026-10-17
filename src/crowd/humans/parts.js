import * as THREE from 'three';

// Runtime-generated parts merged into the figure geometries.
// The skirt / dress / long-coat shell is a (angle, length) grid: its actual shape (waist
// and hip fit, flare, drape folds, hem length) and its skinning are computed in the
// vertex shader from the wearer's look row, so one mesh serves every skirt.

const REGION_SKIRT = 15;

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
      aMorph: new Int8Array(nv * 4), aBody: body,
    },
    index: idx,
  };
}

/** New instanced geometry = base geometry + part (same attribute layout). */
export function appendPart(geo, part) {
  const n0 = geo.attributes.position.count;
  const g = new THREE.InstancedBufferGeometry();
  for (const name of ['position', 'aNrm', 'aBoneI', 'aBoneW', 'aMorph', 'aBody']) {
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
