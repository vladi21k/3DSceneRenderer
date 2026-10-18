import * as THREE from 'three';

// Street-wide instancing for the lamp standards, their fittings and the signals: one
// BatchedMesh per part (shafts, brackets, lanterns...) holds every instance of the
// streamed range, so each part costs one multi-draw call per pass instead of one draw
// per chunk. A chunk build adds its instances to a record bound to the Object3D it
// returns; the instances follow that group's visibility (the streamer shows a chunk
// once all its modules are built and swaps LOD replacements atomically) and are freed
// on dispose.
//
// Per-chunk geometry that is unique to the chunk (wire ribbons, stickers) goes into
// SlotBatches: fixed-size geometry slots reused as chunks come and go, one instance each.
//
// Detail: a part with levels [hi, mid, lo, far] draws the level of its own camera
// distance (far throughout far chunks); NEAR parts (insulators, clamps...) show only
// while their chunk is near, FAR ones (their ribbon stand-ins) only while it is not.
//
// Shadows: each cascade gets its own draw list (shadowList): an instance casts only where
// its shadow can reach the cascade's slice of the view (the light's cascade frustum
// decides, so cascades that are not redrawn this frame cost nothing), at no more detail
// than the cascade's texels hold, and parts flagged thin stop casting in coarse cascades.
// The view's list is built here too (viewList, per-instance culling). Every pass keeps
// its own indirect texture (IndirectLists), uploaded only when its list changed instead
// of once per pass and cascade.

const _m4 = new THREE.Matrix4();
const _c4 = new THREE.Vector4();
const _sph = new THREE.Sphere();
const _fr = new THREE.Frustum();
const _pm = new THREE.Matrix4();
// stand-in handed to the light's cascade frustum for one instance (presented as a shadow
// proxy with its world sphere, which the env's cascade frustums test as is; a plain
// frustum reads the geometry's sphere with an identity transform)
const _one = { geometry: { boundingSphere: _sph }, matrixWorld: new THREE.Matrix4(), userData: { thinCaster: false, shadowProxy: { active: true }, shadowSphere: _sph } };
const WHITE = new THREE.Color(1, 1, 1);
const NL = 4; // detail levels: hi, mid, lo, far
/** Show modes of a record's instances (see header). */
export const ALWAYS = 0, NEAR = 1, FAR = 2;

/**
 * Indirect textures (draw index -> instance) of a BatchedMesh, one per pass key (the view
 * camera, each shadow camera). three's BatchedMesh refills and re-uploads its single
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

/** View draw list of a batch (per-instance frustum culling, no sorting). */
const _vf = new THREE.Frustum();
function viewList(mesh, lists, camera) {
  const info = mesh._instanceInfo, gInfo = mesh._geometryInfo;
  const md = mesh._matricesTexture.image.data;
  const starts = mesh._multiDrawStarts, counts = mesh._multiDrawCounts, ind = lists.begin();
  const index = mesh.geometry.getIndex(), bpe = index ? index.array.BYTES_PER_ELEMENT : 1;
  _vf.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(mesh.matrixWorld), camera.coordinateSystem, camera.reversedDepth);
  let n = 0;
  for (let i = 0, l = info.length; i < l; i++) {
    const it = info[i];
    if (!it.visible || !it.active) continue;
    const g = gInfo[it.geometryIndex];
    mesh.getBoundingSphereAt(it.geometryIndex, _sph).applyMatrix4(_m4.fromArray(md, i * 16));
    if (!_vf.intersectsSphere(_sph)) continue;
    starts[n] = g.start * bpe;
    counts[n] = g.count;
    ind[n] = i;
    n++;
  }
  mesh._indirectTexture = lists.commit(camera, n);
  mesh._multiDrawCount = n;
  mesh._multiDrawBytesPerElement = bpe;
}

/** World texel (m) of the shadow cascade a frustum belongs to (0: not a cascade). */
const _texels = new WeakMap();
function cascadeTexel(scene, f) {
  let cam = _texels.get(f);
  if (cam === undefined) {
    cam = null;
    for (const o of scene.children) {
      const sh = o.isLight && o.castShadow && o.shadow;
      if (!sh || !sh.getFrustum || !sh.getCamera) continue;
      for (let i = 0, n = sh.getViewportCount(); i < n; i++) if (sh.getFrustum(i) === f) cam = { cam: sh.getCamera(i), shadow: sh };
    }
    _texels.set(f, cam);
  }
  return cam && cam.cam.isOrthographicCamera ? (cam.cam.right - cam.cam.left) / Math.max(1, cam.shadow.mapSize.x) : 0;
}

/** {frustum, texel} of a shadow camera: the light's own (slice-aware) cascade frustum when
 *  it has one, else a plain frustum of the camera. */
const _cascades = new WeakMap();
function cascadeOf(scene, cam) {
  let c = _cascades.get(cam);
  if (!c) {
    c = { frustum: null, shadow: null };
    for (const o of scene.children) {
      const sh = o.isLight && o.castShadow && o.shadow;
      if (!sh || !sh.getFrustum || !sh.getCamera) continue;
      for (let i = 0, n = sh.getViewportCount(); i < n; i++) if (sh.getCamera(i) === cam) { c.frustum = sh.getFrustum(i); c.shadow = sh; }
    }
    _cascades.set(cam, c);
  }
  if (!c.frustum) c.plain = _fr.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse), cam.coordinateSystem, cam.reversedDepth);
  c.texel = cam.isOrthographicCamera ? (cam.right - cam.left) / Math.max(1, c.shadow ? c.shadow.mapSize.x : 2048) : 0;
  return c;
}

/**
 * One part: a BatchedMesh over its geometries.
 *   cast            casts sun shadows
 *   thin            thin caster (coarse cascades skip it, see env)
 *   shadowMaxTexel  no shadow in cascades with coarser texels (m)
 *   shadowLevels    cascade texel (m) above which shadows use at least level 1 / 2 / 3
 */
export class CatBatch {
  constructor(name, material, geometries, capacity = 128, { cast = false, thin = false, shadowMaxTexel = Infinity, shadowLevels = [0.025, 0.07, 0.2] } = {}) {
    let vc = 0, ic = 0;
    for (const g of geometries) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; }
    const mesh = new THREE.BatchedMesh(capacity, vc, ic, material);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = false;
    mesh.userData.thinCaster = thin;
    // colour texture from the start, so the programs compiled up front (empty batches)
    // are the ones used later
    if (mesh._initColorsTexture && !mesh._colorsTexture) mesh._initColorsTexture();
    this.mesh = mesh;
    this.lists = new IndirectLists(mesh);
    this.geomIds = geometries.map((g) => mesh.addGeometry(g));
    for (const id of this.geomIds) mesh.getBoundingSphereAt(id, _sph); // cached per geometry
    this.shadowMaxTexel = shadowMaxTexel;
    this.shadowLevels = shadowLevels;
    this.lodGids = new Int32Array(capacity * NL).fill(-1);
    // bounds of the shown instances (whole-batch culling: no empty draws), kept lazily
    this.bounds = { boundingSphere: new THREE.Sphere(), matrixWorld: new THREE.Matrix4(), userData: { thinCaster: thin }, dirty: true };
  }

  /** The batch's bounds proxy for frustum tests (recomputed after visibility changes). */
  boundsProxy() {
    const b = this.bounds;
    if (b.dirty) {
      b.dirty = false;
      const m = this.mesh, info = m._instanceInfo, md = m._matricesTexture.image.data, gInfo = m._geometryInfo;
      const bs = b.boundingSphere.makeEmpty();
      for (let i = 0; i < info.length; i++) {
        const it = info[i];
        if (!it.visible || !it.active) continue;
        _sph.copy(gInfo[it.geometryIndex].boundingSphere).applyMatrix4(_m4.fromArray(md, i * 16));
        if (bs.isEmpty()) bs.copy(_sph); else bs.union(_sph);
      }
      if (bs.isEmpty()) bs.set(_sph.center.set(0, -1e7, 0), 0); // nothing shown: never intersects
    }
    return b;
  }

  /** New hidden instance. levels: geometry index, or [hi, mid, lo, far] indices. */
  add(levels, level, matrix, color) {
    const m = this.mesh;
    if (m.instanceCount >= m.maxInstanceCount) m.setInstanceCount(Math.ceil(m.maxInstanceCount * 1.5));
    const fixed = typeof levels === 'number';
    const id = m.addInstance(this.geomIds[fixed ? levels : levels[level]]);
    m.setMatrixAt(id, matrix);
    m.setColorAt(id, color || WHITE);
    m.setVisibleAt(id, false);
    this.bounds.dirty = true;
    if (id * NL + NL > this.lodGids.length) {
      const a = new Int32Array(Math.max(id * NL + NL, this.lodGids.length * 2)).fill(-1);
      a.set(this.lodGids);
      this.lodGids = a;
    }
    for (let k = 0; k < NL; k++) this.lodGids[id * NL + k] = fixed ? -1 : this.geomIds[levels[k]];
    return id;
  }

  setLevel(id, level) {
    const g = this.lodGids[id * NL + level];
    if (g >= 0) this.mesh.setGeometryIdAt(id, g);
  }

  remove(id) { this.mesh.deleteInstance(id); this.bounds.dirty = true; }

  setVisible(id, v) {
    const m = this.mesh;
    if (m._instanceInfo[id].visible === v) return;
    m.setVisibleAt(id, v);
    this.bounds.dirty = true;
  }

  /** Shadow pass draw list for one cascade (replaces BatchedMesh's own culling). */
  shadowList(scene, cam) {
    const m = this.mesh, c = cascadeOf(scene, cam);
    const info = m._instanceInfo, gInfo = m._geometryInfo, lod = this.lodGids;
    const starts = m._multiDrawStarts, counts = m._multiDrawCounts, ind = this.lists.begin();
    const md = m._matricesTexture.image.data;
    const index = m.geometry.getIndex();
    const bpe = index ? index.array.BYTES_PER_ELEMENT : 1;
    const frustum = c.frustum || c.plain;
    const L = this.shadowLevels, minLv = c.texel > L[2] ? 3 : c.texel > L[1] ? 2 : c.texel > L[0] ? 1 : 0;
    let n = 0;
    if (c.texel <= this.shadowMaxTexel) {
      for (let i = 0, l = info.length; i < l; i++) {
        const it = info[i];
        if (!it.visible || !it.active) continue;
        let gid = it.geometryIndex;
        if (minLv && lod[i * NL] >= 0) {
          let cur = 0;
          while (cur < NL - 1 && lod[i * NL + cur] !== gid) cur++;
          gid = lod[i * NL + Math.max(cur, minLv)];
        }
        _sph.copy(gInfo[gid].boundingSphere).applyMatrix4(_m4.fromArray(md, i * 16).premultiply(m.matrixWorld));
        if (!frustum.intersectsObject(_one)) continue;
        const g = gInfo[gid];
        starts[n] = g.start * bpe;
        counts[n] = g.count;
        ind[n] = i;
        n++;
      }
    }
    m._indirectTexture = this.lists.commit(cam, n);
    m._multiDrawCount = n;
    m._multiDrawBytesPerElement = bpe;
  }
}

/**
 * Street-wide batch of per-chunk geometry: `slots` geometry slots of up to maxVerts /
 * maxIndex each (template: a geometry with the attribute layout), one identity instance
 * per filled slot. add() returns -1 when no slot is free or the geometry does not fit
 * (the caller keeps its own mesh then).
 */
export class SlotBatch {
  constructor(name, material, template, slots, maxVerts, maxIndex) {
    const mesh = new THREE.BatchedMesh(slots, slots * maxVerts, slots * maxIndex, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = false;
    this.mesh = mesh;
    this.lists = new IndirectLists(mesh);
    this.maxVerts = maxVerts;
    this.maxIndex = maxIndex;
    this.free = [];
    for (let i = 0; i < slots; i++) this.free.push(mesh.addGeometry(template, maxVerts, maxIndex));
    this.free.reverse();
    this.slotOf = new Map();  // instance id -> geometry slot
  }

  add(geometry) {
    const m = this.mesh;
    if (!this.free.length || geometry.attributes.position.count > this.maxVerts || geometry.index.count > this.maxIndex) return -1;
    const gid = this.free.pop();
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    m.setGeometryAt(gid, geometry);
    const id = m.addInstance(gid);
    m.setVisibleAt(id, false);
    this.slotOf.set(id, gid);
    return id;
  }

  remove(id) {
    this.mesh.deleteInstance(id);
    this.free.push(this.slotOf.get(id));
    this.slotOf.delete(id);
  }

  setVisible(id, v) { this.mesh.setVisibleAt(id, v); }
}

/** The parts of the street, the per-chunk records and their visibility / detail level. */
export class CatBatches {
  constructor(app) {
    this.app = app;
    this.batches = [];
    this.records = new Set();
    this._frame = -1;
    this.root = new THREE.Group();
    this.root.name = 'catenary:batches';
    app.scene.add(this.root);
  }

  add(batch) {
    this.batches.push(batch);
    this.root.add(batch.mesh);
    const self = this, mesh = batch.mesh, scene = this.app.scene;
    mesh.onBeforeRender = function (renderer, sc, camera) { self.sync(); viewList(this, batch.lists, camera); };
    if (!batch.shadowList) return batch;
    mesh.onBeforeShadow = function (renderer, object, camera, shadowCamera) { self.sync(); batch.shadowList(scene, shadowCamera); };
    // whole-batch test on the bounds of the shown instances: the light's cascade frustum
    // also skips cascades it does not redraw this frame (and thin parts in coarse ones),
    // as do cascades coarser than the part's limit
    mesh.frustumCulled = true;
    mesh.intersectsFrustum = (f) => { self.sync(); return f.intersectsObject(batch.boundsProxy()) && (batch.shadowMaxTexel === Infinity || cascadeTexel(scene, f) <= batch.shadowMaxTexel); };
    return batch;
  }

  /** New record for a chunk; `marker` is the Object3D returned to the streamer. far:
   *  every part at the far level. */
  record(marker, far) {
    const rec = { marker, entries: [], visible: false, far, near: false };
    marker.userData.catRecord = rec;
    this.records.add(rec);
    return rec;
  }

  /** Add an instance to a record. levels: geometry index or [hi, mid, lo, far] (the
   *  detail follows the instance's distance, see updateLevels); mode: ALWAYS, NEAR, FAR. */
  put(rec, batch, levels, matrix, color = null, mode = ALWAYS) {
    const lv = rec.far ? NL - 1 : 1;
    const id = batch.add(levels, lv, matrix, color);
    const e = matrix.elements;
    rec.entries.push({ batch, id, mode, lv: typeof levels === 'number' ? -1 : lv, x: e[12], z: e[14] });
  }

  /** Put a chunk geometry into a slot batch; false when it has to stay a mesh of its own. */
  putSlot(rec, slots, geometry, mode = ALWAYS) {
    const id = slots.add(geometry);
    if (id < 0) return false;
    rec.entries.push({ batch: slots, id, mode, lv: -1, x: 0, z: 0 });
    return true;
  }

  release(rec) {
    if (!rec || !this.records.has(rec)) return;
    for (const e of rec.entries) e.batch.remove(e.id);
    rec.entries.length = 0;
    this.records.delete(rec);
  }

  _shows(rec, e) { return rec.visible && (e.mode === ALWAYS || (e.mode === NEAR) === rec.near); }

  /** Whether the near parts of a record show (instead of its stand-ins). */
  setNear(rec, near) {
    if (rec.near === near) return;
    rec.near = near;
    for (const e of rec.entries) if (e.mode !== ALWAYS) e.batch.setVisible(e.id, this._shows(rec, e));
  }

  /** Detail level of every full-detail instance by its distance from `eye` (m): level k
   *  below dist[k], the last one beyond (8 % hysteresis against the current level). */
  updateLevels(eye, dist) {
    const d2s = this._d2s && this._d2s.length === dist.length ? this._d2s : (this._d2s = new Float64Array(dist.length));
    for (let k = 0; k < dist.length; k++) d2s[k] = dist[k] * dist[k];
    for (const rec of this.records) {
      if (rec.far) continue;
      for (const e of rec.entries) {
        if (e.lv < 0) continue;
        const dx = e.x - eye.x, dz = e.z - eye.z, d2 = dx * dx + dz * dz;
        let lv = 0;
        while (lv < d2s.length && d2 >= d2s[lv] * (e.lv > lv ? 0.85 : 1.17)) lv++;
        if (lv !== e.lv) { e.lv = lv; e.batch.setLevel(e.id, lv); }
      }
    }
  }

  /** Once per frame: instance visibility from the chunk groups. */
  sync() {
    const frame = this.app.frame;
    if (frame === this._frame) return;
    this._frame = frame;
    for (const rec of this.records) {
      const g = rec.marker.parent;
      const vis = !!(g && g.visible && g.parent);
      if (vis === rec.visible) continue;
      rec.visible = vis;
      for (const e of rec.entries) e.batch.setVisible(e.id, this._shows(rec, e));
    }
  }
}
