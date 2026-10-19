import * as THREE from 'three';

// Instancing for street furniture. Every prototype part (shared geometry + material) is
// registered once at init into a global BatchedMesh per material, so all furniture of
// the whole streamed range renders in about one multi-draw call per material, with
// per-instance frustum culling. A chunk build adds instances through a writer bound to
// the chunk's returned Object3D; instances become visible together with the chunk group
// and are freed on dispose. Once the app is running (hideEmpty, after the programs were
// compiled up front), a batch with nothing to show is not drawn at all.
//
// Shadows: every shadow-casting part also gets a twin instance in one shared depth-only
// BatchedMesh (furniture:shadow), so all furniture casts in one multi-draw call per
// cascade. Its draw list is built per cascade (_shadowList): an instance casts only where
// its shadow can reach the cascade's slice of the view (the light's cascade frustum
// decides, so cascades that are not redrawn this frame cost nothing), at no more detail
// than the cascade's texels hold, and not at all once it is smaller than a few texels.
//
// Culling: furniture never moves, so each instance's world bounding sphere (of its most
// detailed level) is stored when it is placed and the draw lists test those directly.
// The view's list is built in the batch's frustum test, so a batch with nothing in view
// is not drawn at all (transparent batches keep BatchedMesh's own sorted lists). Every
// pass (the view, each cascade) keeps its own indirect texture (IndirectLists), uploaded
// only when its list changed instead of once per pass.
//
// Distance LOD per instance: a prototype with `lods` (switch distances in metres) gives
// each part one geometry per level; updateLod() swaps the geometry id of live instances
// as the camera moves (with hysteresis), so detail follows the real distance instead of
// the 200 m chunk LOD. A switch is a short screen-door cross-fade: the new level dithers
// in while a temporary instance with the old level dithers out with the complementary
// pattern (per-instance alpha in the batch colour texture, see patchFade). Shadow twins
// switch at once.

const WHITE = new THREE.Color(1, 1, 1);
const FADE_MS = 450;
// numeric instance keys (batch number * KEY_SPAN + instance id), small integers for up to
// 1000 batches of a million instances: string keys would make garbage on every lookup
const KEY_SPAN = 1048576;
const LOD_STEP = 0.5;   // m of eye movement between two passes over the instance levels
// shadows: cascade texel (m) above which at least level 1 / the coarsest level is drawn,
// and the smallest instance (bounding radius in texels) still worth a shadow
const SHADOW_LEVEL_TEXEL = [0.012, 0.035];
const SHADOW_MIN_TEXELS = 1.5;
const _mat = new THREE.Matrix4();
const _sph = new THREE.Sphere();
const _sph2 = new THREE.Sphere();
const _fr = new THREE.Frustum();
const _pm = new THREE.Matrix4();
// stand-ins handed to the light's cascade frustum: one instance, or the whole batch
// (an instance is presented as a shadow proxy with its world sphere, which the env's
// cascade frustums test as is: slice, sub-texel and box; a plain frustum reads the
// geometry's sphere with an identity transform)
const _one = { geometry: { boundingSphere: _sph }, matrixWorld: new THREE.Matrix4(), userData: { thinCaster: false, shadowProxy: { active: true }, shadowSphere: _sph } };
const _all = { boundingSphere: new THREE.Sphere(new THREE.Vector3(), 1e7), matrixWorld: new THREE.Matrix4(), userData: { thinCaster: false } };

/** Shadow cascades of the scene's shadow-casting lights: frustum -> {shadow, camera}. */
function shadowFrustums(scene, cache) {
  const lights = scene.children.filter((o) => o.isLight && o.castShadow && o.shadow && o.shadow.getFrustum);
  if (cache.map && lights.length === cache.n && lights.every((l, i) => cache.shadows[i] === l.shadow)) return cache.map;
  cache.map = new Map(); cache.n = lights.length; cache.shadows = lights.map((l) => l.shadow);
  for (const l of lights) {
    const sh = l.shadow, n = sh.getViewportCount ? sh.getViewportCount() : 1;
    for (let i = 0; i < n; i++) cache.map.set(sh.getFrustum(i), { shadow: sh, camera: sh.getCamera ? sh.getCamera(i) : sh.camera });
  }
  return cache.map;
}

/**
 * Indirect textures (draw index -> instance) of a BatchedMesh, one per pass key (the view
 * frustum, each shadow camera). three's BatchedMesh refills and re-uploads its single
 * texture for every pass, shadow cascades included, and such an upload can block when
 * the GPU queue is full. Here a list is written into a scratch array (begin) and
 * commit() copies it into the pass's own texture, uploading only when it changed.
 */
class IndirectLists {
  constructor(mesh) { this.mesh = mesh; this.max = -1; this.size = 0; this.scratch = null; this.tex = new Map(); }

  /** Scratch array for a new list (follows the batch's instance capacity). */
  begin() {
    const max = this.mesh._maxInstanceCount;
    if (max !== this.max) {
      this.max = max;
      this.size = Math.ceil(Math.sqrt(max));
      this.scratch = new Uint32Array(this.size * this.size);
      for (const t of this.tex.values()) t.dispose();
      this.tex.clear();
    }
    return this.scratch;
  }

  /** The texture of pass `key` holding the first n scratch entries. */
  commit(key, n) {
    let t = this.tex.get(key);
    if (!t) {
      t = new THREE.DataTexture(new Uint32Array(this.size * this.size), this.size, this.size, THREE.RedIntegerFormat, THREE.UnsignedIntType);
      t.userData.n = -1;
      this.tex.set(key, t);
    }
    const a = this.scratch, b = t.image.data;
    let same = t.userData.n === n;
    for (let i = 0; same && i < n; i++) same = a[i] === b[i];
    if (!same) {
      b.set(n < a.length ? a.subarray(0, n) : a);
      t.userData.n = n;
      t.needsUpdate = true;
    }
    return t;
  }
}

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
  const lv = lods && ps.some((p) => p.geos.length > 1) ? lods : null;
  return { name, parts: ps, lods: lv, lods2: lv ? lv.map((d) => d * d) : null };
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

/** levelFor on squared distances (lods2: squared switch distances; 0.8464 = 0.92²). */
function levelFor2(lods2, d2, cur) {
  let lv = 0;
  while (lv < lods2.length && d2 > lods2[lv] * (cur > lv ? 0.8464 : 1.0)) lv++;
  return lv;
}

export class BatchSet {
  constructor(name = 'furniture') {
    this.name = name;
    this.batches = new Map();
    this.records = new Set();
    this.recList = [];                 // the same records as an array (iterated every frame: no iterator garbage)
    this.syncFrame = -1;
    this.fades = new Map();            // instance key (see KEY_SPAN) -> active fade
    // depth-only twins of the shadow-casting parts (see header)
    this.shadow = { key: 1000 * KEY_SPAN, geos: new Map(), bm: null, live: 0, free: [], shown: 0, levels: null, sph: new Float32Array(256) };
    this._frustums = {};
    this.hideEmpty = false;
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
    this._list = null;
    for (const part of p.parts) {
      const key = part.mat.uuid;
      let b = this.batches.get(key);
      if (!b) { b = { key: this.batches.size * KEY_SPAN, mat: part.mat, geos: new Map(), bm: null, live: 0, free: [], shown: 0, dirty: false, sph: new Float32Array(256) }; this.batches.set(key, b); }
      for (const g of part.geos) if (g && !b.geos.has(g)) b.geos.set(g, -1);
      part.batch = b;
      part.cast = part.cast !== false;
      if (part.cast) for (const g of part.geos) if (g) this.shadow.geos.set(g, -1);
    }
  }

  /** Writer that only counts instances per batch (sizing pass). */
  countingWriter() {
    const counts = new Map();
    return {
      add: (p) => {
        if (!p) return;
        for (const part of p.parts) {
          counts.set(part.batch, (counts.get(part.batch) || 0) + 1);
          if (part.cast) counts.set(this.shadow, (counts.get(this.shadow) || 0) + 1);
        }
      },
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
      // colour texture from the start, so the programs compiled up front (empty batches)
      // are the ones used later
      if (bm._initColorsTexture && !bm._colorsTexture) bm._initColorsTexture();
      bm.name = `${this.name}:${b.mat.name}`;
      bm.perObjectFrustumCulled = true;
      bm.sortObjects = !!b.mat.transparent;
      bm.castShadow = false;               // the shadow twins cast
      bm.receiveShadow = true;
      // instances span the whole route: the batch is culled by its instances (see header)
      bm.frustumCulled = true;
      bm.intersectsFrustum = (f) => { sync(); return this._viewList(b, f, !bm.sortObjects) > 0; };
      const before = bm.onBeforeRender.bind(bm);
      if (bm.sortObjects) bm.onBeforeRender = (...a) => { sync(); before(...a); };
      else bm.onBeforeRender = () => {};  // the list was built by the frustum test
      b.bm = bm;
      b.lists = new IndirectLists(bm);
      scene.add(bm);
    }
    this._finalizeShadow(scene, sync, capacity);
  }

  _finalizeShadow(scene, sync, capacity) {
    const S = this.shadow;
    if (!S.geos.size) return;
    let nv = 0, ni = 0;
    // (a zero normal of one byte per component: the depth pass ignores it, but with it the
    // start-up compile, which also builds a view program for this batch, finds the borrowed
    // material's own program instead of building a flat-shaded variant that is never used)
    const depthGeo = (g) => {
      const d = new THREE.BufferGeometry();
      d.setAttribute('position', g.attributes.position);
      d.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(g.attributes.position.count * 3), 3, true));
      d.setIndex(g.index);
      return d;
    };
    const prepared = [...S.geos.keys()].map((g) => { const d = depthGeo(g); nv += d.attributes.position.count; ni += d.index.count; return [g, d]; });
    // never drawn in the view: its material only picks the depth variant, so it borrows a
    // plain opaque batch material (and a colour texture like the batches), whose program the
    // start-up compile builds anyway, instead of adding one of its own
    const plain = [...this.batches.values()].map((b) => b.mat).find((m) => !m.transparent && m.side === THREE.FrontSide && !m.alphaTest && !m.alphaToCoverage);
    const bm = new THREE.BatchedMesh(Math.max(64, Math.ceil(capacity(S))), nv, ni, plain || new THREE.MeshBasicMaterial({ name: 'furniture.shadow' }));
    if (bm._initColorsTexture && !bm._colorsTexture) bm._initColorsTexture();
    for (const [g, d] of prepared) {
      const id = bm.addGeometry(d);
      S.geos.set(g, id);
      // radius of the geometry, for the sub-texel test
      bm.getBoundingSphereAt(id, _sph);
    }
    bm.name = `${this.name}:shadow`;
    bm.castShadow = true;
    bm.receiveShadow = true;
    bm.perObjectFrustumCulled = true;
    // drawn in the light's shadow cascades only (never in the view), and only in the
    // cascades the light redraws this frame
    const frustums = this._frustums;
    bm.frustumCulled = true;
    bm.intersectsFrustum = (f) => shadowFrustums(scene, frustums).has(f) && f.intersectsObject(_all);
    bm.onBeforeShadow = (renderer, object, camera, shadowCamera) => { sync(); this._shadowList(scene, shadowCamera); };
    S.levels = new Int32Array(Math.max(64, bm.maxInstanceCount) * 3).fill(-1);
    S.bm = bm;
    S.lists = new IndirectLists(bm);
    scene.add(bm);
  }

  /** Store the world bounding sphere of instance `id` (geometry id `gid` under `matrix`). */
  _setSphere(b, id, gid, matrix) {
    if (id * 4 + 4 > b.sph.length) { const a = new Float32Array(Math.max(id * 4 + 4, b.sph.length * 2)); a.set(b.sph); b.sph = a; }
    b.bm.getBoundingSphereAt(gid, _sph).applyMatrix4(matrix);
    b.sph[id * 4] = _sph.center.x; b.sph[id * 4 + 1] = _sph.center.y; b.sph[id * 4 + 2] = _sph.center.z; b.sph[id * 4 + 3] = _sph.radius;
  }

  /** Draw list of a batch for a view frustum from the stored spheres (no sorting); with
   *  write false only counts. Returns the number of instances in view. */
  _viewList(b, frustum, write = true) {
    const m = b.bm, sp = b.sph;
    const info = m._instanceInfo, gInfo = m._geometryInfo;
    const starts = m._multiDrawStarts, counts = m._multiDrawCounts, ind = write ? b.lists.begin() : null;
    const index = m.geometry.getIndex(), bpe = index ? index.array.BYTES_PER_ELEMENT : 1;
    let n = 0;
    for (let i = 0, l = info.length; i < l; i++) {
      const it = info[i];
      if (!it.visible || !it.active) continue;
      _sph.center.set(sp[i * 4], sp[i * 4 + 1], sp[i * 4 + 2]);
      _sph.radius = sp[i * 4 + 3];
      if (!frustum.intersectsSphere(_sph)) continue;
      if (!write) return 1;
      const g = gInfo[it.geometryIndex];
      starts[n] = g.start * bpe;
      counts[n] = g.count;
      ind[n] = i;
      n++;
    }
    if (!write) return 0;
    m._indirectTexture = b.lists.commit(frustum, n);
    m._multiDrawCount = n;
    m._multiDrawBytesPerElement = bpe;
    return n;
  }

  /** Shadow pass draw list for one cascade (replaces BatchedMesh's own culling). */
  _shadowList(scene, cam) {
    const S = this.shadow, m = S.bm;
    let cascade = null;
    for (const [f, c] of shadowFrustums(scene, this._frustums)) if (c.camera === cam) { cascade = { frustum: f, shadow: c.shadow }; break; }
    const frustum = cascade ? cascade.frustum : _fr.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse), cam.coordinateSystem, cam.reversedDepth);
    const texel = cam.isOrthographicCamera ? (cam.right - cam.left) / Math.max(1, cascade ? cascade.shadow.mapSize.x : 2048) : 0;
    const minLv = texel > SHADOW_LEVEL_TEXEL[1] ? 2 : texel > SHADOW_LEVEL_TEXEL[0] ? 1 : 0;
    const minR = SHADOW_MIN_TEXELS * texel;
    const info = m._instanceInfo, gInfo = m._geometryInfo, lv = S.levels, sp = S.sph;
    const starts = m._multiDrawStarts, counts = m._multiDrawCounts, ind = S.lists.begin();
    const bpe = m.geometry.getIndex().array.BYTES_PER_ELEMENT;
    let n = 0;
    // per chunk record: its bounds first (most chunks lie outside a cascade's slice)
    for (let ri = 0, RL = this.recList; ri < RL.length; ri++) {
      const rec = RL[ri];
      if (!rec.vis) continue;
      const b = rec.bound || this._recordBound(rec);
      if (b.radius < 0) continue;
      _sph.copy(b);
      if (!frustum.intersectsObject(_one)) continue;
      const ids = rec.ids;
      for (let k = 2; k < ids.length; k += 3) {
        const i = ids[k];
        if (i < 0) continue;
        const it = info[i];
        if (!it.visible || !it.active || sp[i * 4 + 3] < minR) continue;
        _sph.center.set(sp[i * 4], sp[i * 4 + 1], sp[i * 4 + 2]);
        _sph.radius = sp[i * 4 + 3];
        if (!frustum.intersectsObject(_one)) continue;
        let gid = it.geometryIndex;
        if (minLv) {
          // coarsest of the instance's own level and the cascade's (levels: up to 3, -1 = none)
          const cur = gid === lv[i * 3] ? 0 : gid === lv[i * 3 + 1] ? 1 : 2;
          for (let q = Math.max(cur, minLv); q >= cur; q--) if (lv[i * 3 + q] >= 0) { gid = lv[i * 3 + q]; break; }
        }
        const g = gInfo[gid];
        starts[n] = g.start * bpe;
        counts[n] = g.count;
        ind[n] = i;
        n++;
      }
    }
    m._indirectTexture = S.lists.commit(cam, n);
    m._multiDrawCount = n;
    m._multiDrawBytesPerElement = bpe;
  }

  /** Bounding sphere of a record's shadow twins (radius -1: none), computed once. */
  _recordBound(rec) {
    const sp = this.shadow.sph, b = (rec.bound = new THREE.Sphere(new THREE.Vector3(), -1));
    for (let k = 2; k < rec.ids.length; k += 3) {
      const i = rec.ids[k];
      if (i < 0) continue;
      _sph2.center.set(sp[i * 4], sp[i * 4 + 1], sp[i * 4 + 2]);
      _sph2.radius = sp[i * 4 + 3];
      if (b.radius < 0) b.copy(_sph2); else b.union(_sph2);
    }
    return b;
  }

  /** Show / hide one instance, keeping the batch's count of shown instances. */
  _show(b, id, v) {
    const info = b.bm._instanceInfo[id];
    if (info.visible === v) return;
    b.bm.setVisibleAt(id, v);
    b.shown += v ? 1 : -1;
  }

  /** New hidden instance of geometry id `gid` (recycles our own freed ids). */
  _alloc(b, gid) {
    const bm = b.bm;
    let id;
    if (b.free.length) { id = b.free.pop(); bm.setGeometryIdAt(id, gid); } else {
      if (b.live >= bm.maxInstanceCount) bm.setInstanceCount(bm.maxInstanceCount * 2);
      id = bm.addInstance(gid);
      bm.setVisibleAt(id, false);
    }
    b.live++;
    return id;
  }

  _free(b, id) {
    this._show(b, id, false);
    b.free.push(id);
    b.live--;
  }

  _alpha(b, id, a) {
    b.bm._colorsTexture.image.data[id * 4 + 3] = a;
    b.dirty = true;
  }

  /** Shadow twin of a part instance: level geometries [L0, L1, L2] (-1 = none). */
  _allocShadow(part, matrix, lvGeo) {
    const S = this.shadow;
    const gids = [0, 1, 2].map((k) => { const g = part.geos[Math.min(k, part.geos.length - 1)]; return g ? S.geos.get(g) : -1; });
    const first = gids.find((g) => g >= 0);
    const sid = this._alloc(S, first);
    if (sid * 3 + 3 > S.levels.length) { const a = new Int32Array(Math.max(sid * 3 + 3, S.levels.length * 2)).fill(-1); a.set(S.levels); S.levels = a; }
    S.levels.set(gids, sid * 3);
    S.bm.setMatrixAt(sid, matrix);
    this._setSphere(S, sid, first, matrix);
    if (lvGeo) S.bm.setGeometryIdAt(sid, S.geos.get(lvGeo));
    return sid;
  }

  /** Writer for one chunk build: instances are tied to `obj` (the chunk part).
   *  `eye` (world position) picks the initial LOD level. */
  writer(obj, eye = null) {
    // ids: [batch, id, shadowId (-1: none)] per part instance
    const rec = { obj, ids: [], lod: [], hidden: new Set(), vis: false, temps: [], dead: false, bound: null };
    this.records.add(rec);
    this.recList.push(rec);
    this._lodDirty = true;
    obj.userData.batchRecord = rec;
    return {
      add: (p, matrix, color = null, colors = null) => {
        if (!p) return;
        const e = matrix.elements;
        let lv = 0, item = null;
        if (p.lods) {
          lv = eye ? levelFor(p.lods, Math.hypot(e[12] - eye.x, e[14] - eye.z), 0) : p.lods.length;
          item = { p, x: e[12], z: e[14], lv, ids: [], sids: [] };
          rec.lod.push(item);
        }
        for (const part of p.parts) {
          const g = levelGeo(part, lv);
          const b = part.batch, bm = b.bm;
          const id = this._alloc(b, b.geos.get(g || anyGeo(part)));
          bm.setMatrixAt(id, matrix);
          this._setSphere(b, id, b.geos.get(anyGeo(part)), matrix);
          const c = part.tintKey ? colors?.[part.tintKey] : color;
          bm.setColorAt(id, part.tint && c ? c : WHITE);
          this._alpha(b, id, 1);
          const sid = part.cast && this.shadow.bm ? this._allocShadow(part, matrix, g) : -1;
          rec.ids.push(b, id, sid);
          if (!g) rec.hidden.add(id + b.key);
          if (item) { item.ids.push(id); item.sids.push(sid); }
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
    for (let i = 0; i < rec.ids.length; i += 3) {
      const b = rec.ids[i], id = rec.ids[i + 1], k = id + b.key;
      if (this.fades.has(k)) { this.fades.delete(k); this._alpha(b, id, 1); }
    }
  }

  release(obj) {
    const rec = obj && obj.userData.batchRecord;
    if (!rec) return;
    this._endFades(rec);
    for (let i = 0; i < rec.ids.length; i += 3) {
      this._free(rec.ids[i], rec.ids[i + 1]);
      if (rec.ids[i + 2] >= 0) this._free(this.shadow, rec.ids[i + 2]);
    }
    rec.ids.length = 0;
    rec.lod.length = 0;
    rec.hidden.clear();
    rec.dead = true;
    this.records.delete(rec);
    const RL = this.recList, ri = RL.indexOf(rec);
    if (ri >= 0) { RL[ri] = RL[RL.length - 1]; RL.pop(); }
    obj.userData.batchRecord = null;
    this._showBatches();
  }

  /** Show instances whose chunk group is visible and attached: once per frame from the
   *  module update (so batches that were empty are drawn again) and again right before
   *  the first draw, after the streamer's changes of the frame (exact chunk swaps). */
  sync() {
    let changed = false;
    for (let ri = 0, RL = this.recList; ri < RL.length; ri++) {
      const rec = RL[ri];
      const p = rec.obj.parent;
      const vis = !!(p && p.visible && p.parent);
      if (vis === rec.vis) continue;
      rec.vis = vis;
      changed = true;
      if (!vis) this._endFades(rec);
      for (let i = 0; i < rec.ids.length; i += 3) {
        const b = rec.ids[i], id = rec.ids[i + 1], sid = rec.ids[i + 2];
        const shown = vis && !(rec.hidden.size && rec.hidden.has(id + b.key));
        this._show(b, id, shown);
        if (sid >= 0) this._show(this.shadow, sid, shown);
      }
    }
    if (changed) this._showBatches();
    this._flush();
  }

  /**
   * Start-up warm-up, every frame until the app is ready: one invisible instance per batch
   * (scaled to a few micrometres, a little in front of the eye) so every batch is really
   * drawn behind the loading screen. The start-up compile links each program, but the GPU
   * process still pays a large one-off cost (100-200 ms here, mostly when the browser's
   * shader cache supplied the program) at a program's first draw; a batch that is first
   * seen mid-ride (tableware within 30 m of a laid table, a stop's fittings) would stall
   * a frame a few frames later. `eye` and `dir` (unit) are world vectors.
   */
  warmup(eye, dir) {
    if (!this.warm) {
      this.warm = [];
      for (const b of this.batches.values()) {
        if (!b.bm || !b.geos.size) continue;
        const gid = b.geos.values().next().value;
        const id = this._alloc(b, gid);
        this._alpha(b, id, 1);
        b.bm.setColorAt(id, WHITE);
        this.warm.push(b, id);
      }
    }
    const x = eye.x + dir.x * 2, y = eye.y + dir.y * 2, z = eye.z + dir.z * 2;
    _mat.makeScale(1e-5, 1e-5, 1e-5).setPosition(x, y, z);
    for (let i = 0, W = this.warm; i < W.length; i += 2) {
      const b = W[i], id = W[i + 1];
      b.bm.setMatrixAt(id, _mat);
      this._setSphere(b, id, b.bm._instanceInfo[id].geometryIndex, _mat);
      this._show(b, id, true);
    }
  }

  /** End of the warm-up (the app is ready): free the warm-up instances. */
  endWarmup() {
    if (!this.warm) return;
    for (let i = 0, W = this.warm; i < W.length; i += 2) this._free(W[i], W[i + 1]);
    this.warm = null;
  }

  /** Batches with nothing to show are not drawn (no empty multi-draw calls). */
  _showBatches() {
    if (!this.hideEmpty) return;
    const list = this._list || (this._list = [...this.batches.values()]);
    for (let i = 0; i < list.length; i++) { const b = list[i]; if (b.bm) b.bm.visible = b.shown > 0; }
    if (this.shadow.bm) this.shadow.bm.visible = this.shadow.shown > 0;
  }

  _flush() {
    // (an array: a Map iterator twice a frame is garbage)
    const list = this._list || (this._list = [...this.batches.values()]);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.dirty) { b.dirty = false; if (b.bm._colorsTexture) b.bm._colorsTexture.needsUpdate = true; }
    }
  }

  /** Swap instance geometry to the level matching its distance from `eye`, cross-fading
   *  between the levels over FADE_MS (real time). */
  updateLod(eye, now = performance.now()) {
    let shownChanged = false;
    // levels are re-chosen once the eye has moved LOD_STEP (switches have 8 % hysteresis),
    // or when chunks came or went; fades advance every frame
    const L = this._lodEye || (this._lodEye = { x: 1e9, z: 1e9, n: -1 });
    const ex = eye.x, ez = eye.z, mx = ex - L.x, mz = ez - L.z;
    const recheck = mx * mx + mz * mz > LOD_STEP * LOD_STEP || this.records.size !== L.n || this._lodDirty;
    if (recheck) { L.x = ex; L.z = ez; L.n = this.records.size; this._lodDirty = false; }
    if (recheck) for (let ri = 0, RL = this.recList; ri < RL.length; ri++) {
      const rec = RL[ri];
      const items = rec.lod;
      for (let q = 0, nq = items.length; q < nq; q++) {
        const it = items[q], dx = it.x - ex, dz = it.z - ez;
        const lv = levelFor2(it.p.lods2, dx * dx + dz * dz, it.lv);
        if (lv === it.lv) continue;
        const old = it.lv;
        it.lv = lv;
        shownChanged = true;
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
            if (tid * 4 + 4 > b.sph.length) { const a = new Float32Array(Math.max(tid * 4 + 4, b.sph.length * 2)); a.set(b.sph); b.sph = a; }
            b.sph.copyWithin(tid * 4, id * 4, id * 4 + 4);
            const cd = bm._colorsTexture.image.data;
            cd[tid * 4] = cd[id * 4]; cd[tid * 4 + 1] = cd[id * 4 + 1]; cd[tid * 4 + 2] = cd[id * 4 + 2];
            this._alpha(b, tid, -1e-4);
            this._show(b, tid, true);
            rec.temps.push(b, tid);
            this.fades.set(tid + b.key, { rec, b, id: tid, t0: now, out: true });
          }
          const sid = it.sids[k];
          if (gNew) {
            bm.setGeometryIdAt(id, b.geos.get(gNew));
            rec.hidden.delete(key);
            if (sid >= 0) { this.shadow.bm.setGeometryIdAt(sid, this.shadow.geos.get(gNew)); this._show(this.shadow, sid, rec.vis); }
            if (rec.vis) {
              this._show(b, id, true);
              this._alpha(b, id, 0);
              this.fades.set(key, { rec, b, id, t0: now, out: false });
            }
          } else {
            rec.hidden.add(key);
            this._show(b, id, false);
            if (sid >= 0) this._show(this.shadow, sid, false);
            if (this.fades.delete(key)) this._alpha(b, id, 1);
          }
        }
      }
    }
    // advance the fades (forEach with a bound callback: no iterator entries per frame)
    this._fadeNow = now;
    this._fadeEnded = false;
    if (this.fades.size) this.fades.forEach(this._stepFade || (this._stepFade = this._advanceFade.bind(this)));
    if (shownChanged || this._fadeEnded) this._showBatches();
    this._flush();
  }

  _advanceFade(f, key) {
    const t = (this._fadeNow - f.t0) / FADE_MS;
    if (t < 1) { this._alpha(f.b, f.id, f.out ? -t - 1e-4 : t); return; }
    this.fades.delete(key);
    this._fadeEnded = true;
    if (f.out) {
      const tl = f.rec.temps;
      for (let i = 0; i < tl.length; i += 2) {
        if (tl[i] !== f.b || tl[i + 1] !== f.id) continue;
        tl[i] = tl[tl.length - 2]; tl[i + 1] = tl[tl.length - 1]; tl.length -= 2;  // (order is free)
        break;
      }
      this._free(f.b, f.id);
    } else this._alpha(f.b, f.id, 1);
  }

  stats() {
    const out = {};
    for (const b of this.batches.values()) out[b.bm.name] = b.live;
    if (this.shadow.bm) out[this.shadow.bm.name] = this.shadow.live;
    out.fades = this.fades.size;
    return out;
  }
}

const _smp = {}, _p = new THREE.Vector3(), _f = new THREE.Vector3(), _x = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** How far an upright item with a footprint of radius `foot` (m) must sink at (s, d) so
 *  that no part of its base floats above the sloping paving (grade, cross-fall, tilt). */
export function groundSink(route, s, d, foot) {
  if (!(foot > 0)) return 0;
  const gs = route.groundY(s + 0.25, d) - route.groundY(s - 0.25, d);
  const gd = route.groundY(s, d + 0.25) - route.groundY(s, d - 0.25);
  return foot * 2 * Math.hypot(gs, gd);
}

/**
 * World matrix of an item standing upright at route coordinate (s, d, h). `yaw` is the
 * item's facing in the (s, d) plane: forward = tangent·cos(yaw) + right·sin(yaw), i.e.
 * 0 faces along travel, +π/2 faces right (+d). The item's local +Z is its front.
 * `foot`: radius of its base (m); the item sinks into the paving by groundSink so its
 * downhill edge still touches the ground.
 */
export function placeMatrix(route, s, d, h, yaw, out = new THREE.Matrix4(), foot = 0) {
  route.sample(s, _smp);
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  _f.set(_smp.tanH.x * c + _smp.right.x * sn, 0, _smp.tanH.z * c + _smp.right.z * sn).normalize();
  _x.crossVectors(_up, _f);
  route.toWorld(s, d, h - groundSink(route, s, d, foot), _p);
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
