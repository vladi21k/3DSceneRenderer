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
// the 200 m chunk LOD. A switch is a short screen-door cross-fade: the new level dithers
// in while a temporary instance with the old level dithers out with the complementary
// pattern (per-instance alpha in the batch colour texture, see patchFade).

const WHITE = new THREE.Color(1, 1, 1);
const FADE_MS = 450;
const _mat = new THREE.Matrix4();

/** Screen-door dither for batched furniture, driven by the batch colour alpha:
 *  a >= 1 opaque, 0 <= a < 1 keeps pixels whose threshold is below a (fading in),
 *  a < 0 keeps pixels whose threshold is at least -a (fading out, complementary). */
export function patchFade(m) {
  if (m.userData.furnitureFade) return m;
  m.userData.furnitureFade = true;
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (s, r) {
    if (prev) prev.call(this, s, r);
    // the fragment stage sees batch colours as USE_COLOR_ALPHA (USE_BATCHING_COLOR is vertex-only)
    s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', `#ifdef USE_COLOR_ALPHA
      {
        float fFade = vColor.a;
        if ( fFade < 0.999 ) {
          float fTh = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
          if ( fFade >= 0.0 ? fTh >= fFade : fTh < - fFade ) discard;
        }
        diffuseColor.rgb *= vColor.rgb;
      }
      #else
      #include <color_fragment>
      #endif`);
  };
  m.customProgramCacheKey = function () { return `${prevKey ? prevKey.call(this) : ''}|furniture-fade`; };
  m.needsUpdate = true;
  return m;
}

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
    this.fades = new Map();            // id + batch key -> active fade
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
      if (!b) { b = { key: `|${this.batches.size}`, mat: part.mat, cast, geos: new Map(), bm: null, live: 0, free: [], dirty: false }; this.batches.set(key, b); }
      for (const g of part.geos) if (g && !b.geos.has(g)) b.geos.set(g, -1);
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
      patchFade(b.mat);
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

  /** New hidden instance of geometry id `gid` (recycles our own freed ids). */
  _alloc(b, gid) {
    const bm = b.bm;
    let id;
    if (b.free.length) { id = b.free.pop(); bm.setGeometryIdAt(id, gid); } else {
      if (b.live >= bm.maxInstanceCount) bm.setInstanceCount(bm.maxInstanceCount * 2);
      id = bm.addInstance(gid);
    }
    b.live++;
    bm.setVisibleAt(id, false);
    return id;
  }

  _free(b, id) {
    b.bm.setVisibleAt(id, false);
    b.free.push(id);
    b.live--;
  }

  _alpha(b, id, a) {
    b.bm._colorsTexture.image.data[id * 4 + 3] = a;
    b.dirty = true;
  }

  /** Writer for one chunk build: instances are tied to `obj` (the chunk part).
   *  `eye` (world position) picks the initial LOD level. */
  writer(obj, eye = null) {
    const rec = { obj, ids: [], lod: [], hidden: new Set(), vis: false, temps: [], dead: false };
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
          const b = part.batch, bm = b.bm;
          const id = this._alloc(b, b.geos.get(g || anyGeo(part)));
          bm.setMatrixAt(id, matrix);
          const c = part.tintKey ? colors?.[part.tintKey] : color;
          bm.setColorAt(id, part.tint && c ? c : WHITE);
          this._alpha(b, id, 1);
          rec.ids.push(b, id);
          if (!g) rec.hidden.add(id + b.key);
          if (item) item.ids.push(id);
        }
      },
    };
  }

  /** Drop the fades of a record and free its temporary fade-out instances. */
  _endFades(rec) {
    for (let i = 0; i < rec.temps.length; i += 2) {
      const b = rec.temps[i], id = rec.temps[i + 1];
      this.fades.delete(id + b.key);
      this._free(b, id);
    }
    rec.temps.length = 0;
    for (let i = 0; i < rec.ids.length; i += 2) {
      const b = rec.ids[i], id = rec.ids[i + 1], k = id + b.key;
      if (this.fades.has(k)) { this.fades.delete(k); this._alpha(b, id, 1); }
    }
  }

  release(obj) {
    const rec = obj && obj.userData.batchRecord;
    if (!rec) return;
    this._endFades(rec);
    for (let i = 0; i < rec.ids.length; i += 2) this._free(rec.ids[i], rec.ids[i + 1]);
    rec.ids.length = 0;
    rec.lod.length = 0;
    rec.hidden.clear();
    rec.dead = true;
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
      if (!vis) this._endFades(rec);
      for (let i = 0; i < rec.ids.length; i += 2) {
        const b = rec.ids[i], id = rec.ids[i + 1];
        b.bm.setVisibleAt(id, vis && !(rec.hidden.size && rec.hidden.has(id + b.key)));
      }
    }
    this._flush();
  }

  _flush() {
    for (const b of this.batches.values()) if (b.dirty) { b.dirty = false; if (b.bm._colorsTexture) b.bm._colorsTexture.needsUpdate = true; }
  }

  /** Swap instance geometry to the level matching its distance from `eye`, cross-fading
   *  between the levels over FADE_MS (real time). */
  updateLod(eye, now = performance.now()) {
    for (const rec of this.records) {
      for (const it of rec.lod) {
        const lv = levelFor(it.p.lods, Math.hypot(it.x - eye.x, it.z - eye.z), it.lv);
        if (lv === it.lv) continue;
        const old = it.lv;
        it.lv = lv;
        const parts = it.p.parts;
        for (let k = 0; k < parts.length; k++) {
          const part = parts[k], b = part.batch, bm = b.bm, id = it.ids[k];
          const gOld = levelGeo(part, old), gNew = levelGeo(part, lv);
          if (gOld === gNew) continue;
          const key = id + b.key;
          const wasShown = rec.vis && !rec.hidden.has(key);
          if (gOld && wasShown) { // old level fades out on a temporary copy of the instance
            const tid = this._alloc(b, b.geos.get(gOld));
            bm.getMatrixAt(id, _mat); bm.setMatrixAt(tid, _mat);
            const cd = bm._colorsTexture.image.data;
            cd[tid * 4] = cd[id * 4]; cd[tid * 4 + 1] = cd[id * 4 + 1]; cd[tid * 4 + 2] = cd[id * 4 + 2];
            this._alpha(b, tid, -1e-4);
            bm.setVisibleAt(tid, true);
            rec.temps.push(b, tid);
            this.fades.set(tid + b.key, { rec, b, id: tid, t0: now, out: true });
          }
          if (gNew) {
            bm.setGeometryIdAt(id, b.geos.get(gNew));
            rec.hidden.delete(key);
            if (rec.vis) {
              bm.setVisibleAt(id, true);
              this._alpha(b, id, 0);
              this.fades.set(key, { rec, b, id, t0: now, out: false });
            }
          } else {
            rec.hidden.add(key);
            bm.setVisibleAt(id, false);
            if (this.fades.delete(key)) this._alpha(b, id, 1);
          }
        }
      }
    }
    // advance the fades
    for (const [key, f] of this.fades) {
      const t = (now - f.t0) / FADE_MS;
      if (t < 1) { this._alpha(f.b, f.id, f.out ? -t - 1e-4 : t); continue; }
      this.fades.delete(key);
      if (f.out) {
        const tl = f.rec.temps;
        for (let i = 0; i < tl.length; i += 2) if (tl[i] === f.b && tl[i + 1] === f.id) { tl.splice(i, 2); break; }
        this._free(f.b, f.id);
      } else this._alpha(f.b, f.id, 1);
    }
    this._flush();
  }

  stats() {
    const out = {};
    for (const b of this.batches.values()) out[b.bm.name + (b.cast ? '' : '(ns)')] = b.live;
    out.fades = this.fades.size;
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
