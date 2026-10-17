import * as THREE from 'three';

// Instancing for street furniture. Every prototype part (shared geometry + material) is
// registered once at init into a global BatchedMesh per (material, casts-shadow) pair, so
// all furniture of the whole streamed range renders in about one multi-draw call per
// material and pass, with per-instance frustum culling (shadow cascades included).
// A chunk build adds instances through a writer bound to the chunk's returned Object3D;
// instances become visible together with the chunk group and are freed on dispose.
//
// Distance LOD per instance: a prototype with `lods` (switch distances in metres) gives
// each part one geometry per level; updateLod() swaps the geometry id of live instances
// as the camera moves (with hysteresis), so detail follows the real distance instead of
// the 200 m chunk LOD.

const WHITE = new THREE.Color(1, 1, 1);

/** Prototype: {name, parts: [{geo | [geoLevel0, geoLevel1, ...], mat, tint?, cast?}], lods?}.
 *  A null level geometry hides that part at that distance (e.g. tableware beyond 30 m). */
export const proto = (name, parts, lods = null) => {
  const ps = parts.filter((p) => p && p.geo).map((p) => ({ ...p, geos: Array.isArray(p.geo) ? p.geo : [p.geo] }));
  return { name, parts: ps, lods: lods && ps.some((p) => p.geos.length > 1) ? lods : null };
};
const levelGeo = (part, lv) => part.geos[Math.min(lv, part.geos.length - 1)];
const anyGeo = (part) => part.geos.find(Boolean);

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

function levelFor(lods, d, cur) {
  let lv = 0;
  while (lv < lods.length && d > lods[lv] * (cur > lv ? 0.92 : 1.0)) lv++; // hysteresis towards the current level
  return lv;
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
      if (!b) { b = { key: `|${this.batches.size}`, mat: part.mat, cast, geos: new Map(), tinted: false, bm: null, live: 0, free: [] }; this.batches.set(key, b); }
      for (const g of part.geos) if (g && !b.geos.has(g)) b.geos.set(g, -1);
      if (part.tint) b.tinted = true;
      part.batch = b;
    }
  }

  /** Writer that only counts instances per batch (sizing pass). */
  countingWriter() {
    const counts = new Map();
    return {
      add: (p) => { if (p) for (const part of p.parts) counts.set(part.batch, (counts.get(part.batch) || 0) + 1); },
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
      if (b.mat.vertexColors) names.add('color'); // vertex-colour materials need the attribute (white = neutral)
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

  /** Writer for one chunk build: instances are tied to `obj` (the chunk part).
   *  `eye` (world position) picks the initial LOD level. */
  writer(obj, eye = null) {
    const rec = { obj, ids: [], lod: [], hidden: new Set(), vis: false };
    this.records.add(rec);
    obj.userData.batchRecord = rec;
    return {
      add: (p, matrix, color = null, colors = null) => {
        if (!p) return;
        const e = matrix.elements;
        let lv = 0, item = null;
        if (p.lods) {
          lv = eye ? levelFor(p.lods, Math.hypot(e[12] - eye.x, e[14] - eye.z), 0) : p.lods.length;
          item = { p, x: e[12], z: e[14], lv, ids: [] };
          rec.lod.push(item);
        }
        for (const part of p.parts) {
          const g = levelGeo(part, lv);
          const b = part.batch, bm = b.bm, gid = b.geos.get(g || anyGeo(part));
          // recycle our own hidden instances (BatchedMesh re-sorts its free list on every add)
          let id;
          if (b.free.length) { id = b.free.pop(); bm.setGeometryIdAt(id, gid); } else {
            if (b.live >= bm.maxInstanceCount) bm.setInstanceCount(bm.maxInstanceCount * 2);
            id = bm.addInstance(gid);
          }
          b.live++;
          bm.setMatrixAt(id, matrix);
          if (b.tinted) {
            const c = part.tintKey ? colors?.[part.tintKey] : color;
            bm.setColorAt(id, part.tint && c ? c : WHITE);
          }
          bm.setVisibleAt(id, false);
          rec.ids.push(b, id);
          if (!g) rec.hidden.add(id + b.key);
          if (item) item.ids.push(id);
        }
      },
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
    rec.lod.length = 0;
    rec.hidden.clear();
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
      for (let i = 0; i < rec.ids.length; i += 2) {
        const b = rec.ids[i], id = rec.ids[i + 1];
        b.bm.setVisibleAt(id, vis && !(rec.hidden.size && rec.hidden.has(id + b.key)));
      }
    }
  }

  /** Swap instance geometry to the level matching its distance from `eye`. */
  updateLod(eye) {
    for (const rec of this.records) {
      for (const it of rec.lod) {
        const lv = levelFor(it.p.lods, Math.hypot(it.x - eye.x, it.z - eye.z), it.lv);
        if (lv === it.lv) continue;
        it.lv = lv;
        const parts = it.p.parts;
        for (let k = 0; k < parts.length; k++) {
          const part = parts[k], b = part.batch, id = it.ids[k], g = levelGeo(part, lv);
          if (g) {
            b.bm.setGeometryIdAt(id, b.geos.get(g));
            if (rec.hidden.delete(id + b.key) && rec.vis) b.bm.setVisibleAt(id, true);
          } else if (!rec.hidden.has(id + b.key)) {
            rec.hidden.add(id + b.key);
            b.bm.setVisibleAt(id, false);
          }
        }
      }
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
