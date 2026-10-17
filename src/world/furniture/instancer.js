import * as THREE from 'three';

// Instancing for street furniture. Every prototype part (shared geometry + material) is
// registered once at init into a global BatchedMesh per (material, casts-shadow) pair, so
// all furniture of the whole streamed range renders in about one multi-draw call per
// material and pass, with per-instance frustum culling (shadow cascades included).
// A chunk build adds instances through a writer bound to the chunk's returned Object3D;
// instances become visible together with the chunk group and are freed on dispose.

const WHITE = new THREE.Color(1, 1, 1);

/** Prototype: {name, parts: [{geo, mat, tint?, cast?}]}. */
export const proto = (name, parts) => ({ name, parts: parts.filter((p) => p && p.geo) });

function conform(g, names) {
  let out = g;
  for (const k of names) {
    if (g.attributes[k]) continue;
    if (out === g) { out = g.clone(); }
    const ref = { color: [3, 1], aFlex: [1, 0] }[k] || [g.attributes.position.itemSize, 0];
    const arr = new Float32Array(g.attributes.position.count * ref[0]).fill(ref[1]);
    out.setAttribute(k, new THREE.BufferAttribute(arr, ref[0]));
  }
  return out;
}

export class BatchSet {
  constructor(name = 'furniture') {
    this.name = name;
    this.batches = new Map();
    this.records = new Set();
    this.syncFrame = -1;
  }

  /** Register every prototype found in a (nested) object/array tree. */
  registerTree(tree) {
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o.parts) && o.name) { this.register(o); return; }
      for (const k in o) walk(o[k]);
    };
    walk(tree);
  }

  register(p) {
    for (const part of p.parts) {
      const cast = part.cast !== false;
      const key = `${part.mat.uuid}|${cast}`;
      let b = this.batches.get(key);
      if (!b) { b = { mat: part.mat, cast, geos: new Map(), tinted: false, bm: null, live: 0, free: [] }; this.batches.set(key, b); }
      if (!b.geos.has(part.geo)) b.geos.set(part.geo, -1);
      if (part.tint) b.tinted = true;
      part.batch = b;
    }
  }

  /** Writer that only counts instances per batch (sizing pass). */
  countingWriter() {
    const counts = new Map();
    return {
      add: (p) => { if (p) for (const part of p.parts) counts.set(part.batch, (counts.get(part.batch) || 0) + 1); },
      count: () => 0,
      counts,
    };
  }

  /** Create the BatchedMeshes. capacity(batch) -> initial instance capacity. */
  finalize(scene, renderer, capacity = () => 1024) {
    const sync = () => {
      const f = renderer.info.render.frame;
      if (f === this.syncFrame) return;
      this.syncFrame = f;
      this.sync();
    };
    for (const b of this.batches.values()) {
      const names = new Set();
      for (const g of b.geos.keys()) for (const k in g.attributes) names.add(k);
      let nv = 0, ni = 0;
      const prepared = [];
      for (const g of b.geos.keys()) {
        const gg = conform(g, names);
        prepared.push([g, gg]);
        nv += gg.attributes.position.count; ni += gg.index.count;
      }
      const bm = new THREE.BatchedMesh(Math.max(64, Math.ceil(capacity(b))), nv, ni, b.mat);
      for (const [g, gg] of prepared) b.geos.set(g, bm.addGeometry(gg));
      bm.name = `${this.name}:${b.mat.name}`;
      bm.frustumCulled = false;            // instances span the whole route; culled per instance
      bm.perObjectFrustumCulled = true;
      bm.sortObjects = !!b.mat.transparent;
      bm.castShadow = b.cast;
      bm.receiveShadow = true;
      const before = bm.onBeforeRender.bind(bm), beforeShadow = bm.onBeforeShadow.bind(bm);
      bm.onBeforeRender = (...a) => { sync(); before(...a); };
      bm.onBeforeShadow = (...a) => { sync(); beforeShadow(...a); };
      b.bm = bm;
      scene.add(bm);
    }
  }

  /** Writer for one chunk build: instances are tied to `obj` (the chunk part). */
  writer(obj) {
    const rec = { obj, ids: [], vis: false };
    this.records.add(rec);
    obj.userData.batchRecord = rec;
    return {
      add: (p, matrix, color = null) => {
        if (!p) return;
        for (const part of p.parts) {
          const b = part.batch, bm = b.bm, gid = b.geos.get(part.geo);
          // recycle our own hidden instances (BatchedMesh re-sorts its free list on every add)
          let id;
          if (b.free.length) { id = b.free.pop(); bm.setGeometryIdAt(id, gid); } else {
            if (b.live >= bm.maxInstanceCount) bm.setInstanceCount(bm.maxInstanceCount * 2);
            id = bm.addInstance(gid);
          }
          b.live++;
          bm.setMatrixAt(id, matrix);
          if (b.tinted) bm.setColorAt(id, part.tint && color ? color : WHITE);
          bm.setVisibleAt(id, false);
          rec.ids.push(b, id);
        }
      },
      count: () => rec.ids.length / 2,
    };
  }

  release(obj) {
    const rec = obj && obj.userData.batchRecord;
    if (!rec) return;
    for (let i = 0; i < rec.ids.length; i += 2) {
      const b = rec.ids[i], id = rec.ids[i + 1];
      b.bm.setVisibleAt(id, false);
      b.free.push(id);
      b.live--;
    }
    rec.ids.length = 0;
    this.records.delete(rec);
    obj.userData.batchRecord = null;
  }

  /** Show instances whose chunk group is visible and attached (called once per frame). */
  sync() {
    for (const rec of this.records) {
      const p = rec.obj.parent;
      const vis = !!(p && p.visible && p.parent);
      if (vis === rec.vis) continue;
      rec.vis = vis;
      for (let i = 0; i < rec.ids.length; i += 2) rec.ids[i].bm.setVisibleAt(rec.ids[i + 1], vis);
    }
  }

  stats() {
    const out = {};
    for (const b of this.batches.values()) out[b.bm.name + (b.cast ? '' : '(ns)')] = b.live;
    return out;
  }
}

const _smp = {}, _p = new THREE.Vector3(), _f = new THREE.Vector3(), _x = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * World matrix of an item standing upright at route coordinate (s, d, h). `yaw` is the
 * item's facing in the (s, d) plane: forward = tangent·cos(yaw) + right·sin(yaw), i.e.
 * 0 faces along travel, +π/2 faces right (+d). The item's local +Z is its front.
 */
export function placeMatrix(route, s, d, h, yaw, out = new THREE.Matrix4()) {
  route.sample(s, _smp);
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  _f.set(_smp.tanH.x * c + _smp.right.x * sn, 0, _smp.tanH.z * c + _smp.right.z * sn).normalize();
  _x.crossVectors(_up, _f);
  route.toWorld(s, d, h, _p);
  out.makeBasis(_x, _up, _f);
  out.setPosition(_p);
  return out;
}

/** Uniform scale applied to a placement matrix (in place). */
export function scaleMatrix(m, sx, sy = sx, sz = sx) {
  const e = m.elements;
  e[0] *= sx; e[1] *= sx; e[2] *= sx;
  e[4] *= sy; e[5] *= sy; e[6] *= sy;
  e[8] *= sz; e[9] *= sz; e[10] *= sz;
  return m;
}

const _a = new THREE.Vector3(), _z = new THREE.Vector3(), _y = new THREE.Vector3();
/** Matrix mapping a unit segment prototype (local z from 0 to 1) onto world points A -> B. */
export function segmentMatrix(A, B, out = new THREE.Matrix4()) {
  _z.subVectors(B, A);
  const len = _z.length();
  _a.copy(_z).divideScalar(len || 1);
  _x.crossVectors(Math.abs(_a.y) > 0.95 ? _f.set(1, 0, 0) : _up, _a).normalize();
  _y.crossVectors(_a, _x).normalize();
  out.makeBasis(_x, _y, _z);
  out.setPosition(A);
  return out;
}
