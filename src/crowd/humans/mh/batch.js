import * as THREE from 'three';

// One multi-draw call per pass for every figure on the street: all characters of the cast (each with
// four LODs) and their accessories live in one merged vertex / index buffer, and every frame each
// posed figure contributes one sub-draw per part it shows (body at its LOD, phone, bag ...). The mesh
// is drawn by the renderer's batched path (isBatchedMesh: WEBGL_multi_draw, gl_DrawID); the vertex
// shader (mh/shading.js) reads the figure's bone row through an indirect texture (sub-draw -> row).
//
// Draw lists are built here per pass: the view's (culled per figure, front to back) and each shadow
// cascade's (figures whose shadow reaches the cascade, at a coarse LOD the cascade's texels can hold:
// LOD 1 at best, LOD 3 in the far cascades). Every pass keeps its own indirect texture, uploaded only
// when its list changed.

const _all = { boundingSphere: new THREE.Sphere(new THREE.Vector3(), 1e7), matrixWorld: new THREE.Matrix4(), userData: { thinCaster: false } };
const _proxy = { boundingSphere: new THREE.Sphere(), matrixWorld: new THREE.Matrix4(), userData: { thinCaster: false } };
const _vf = new THREE.Frustum();
const _pm = new THREE.Matrix4();
// cascade texel (m) above which shadows use at least LOD 2 / 3
const SHADOW_LOD_TEXEL = [0.03, 0.09];

/** {frustum, texel} of a shadow camera: the light's own (slice-aware) cascade frustum when it has
 *  one, else a plain frustum of the camera. */
const _cascades = new WeakMap();
function cascadeOf(scene, cam) {
  let c = _cascades.get(cam);
  if (!c) {
    c = { frustum: null, shadow: null, plain: new THREE.Frustum() };
    for (const o of scene.children) {
      const sh = o.isLight && o.castShadow && o.shadow;
      if (!sh || !sh.getFrustum || !sh.getCamera) continue;
      for (let i = 0, n = sh.getViewportCount(); i < n; i++) if (sh.getCamera(i) === cam) { c.frustum = sh.getFrustum(i); c.shadow = sh; }
    }
    _cascades.set(cam, c);
  }
  if (!c.frustum) c.plain.setFromProjectionMatrix(_pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse), cam.coordinateSystem, cam.reversedDepth);
  c.texel = cam.isOrthographicCamera ? (cam.right - cam.left) / Math.max(1, c.shadow ? c.shadow.mapSize.x : 2048) : 0;
  return c;
}

function releaseArray() { this.array = null; }

/** Indirect textures (sub-draw -> bone row), one per pass key. */
class IndirectLists {
  constructor() { this.size = 0; this.scratch = null; this.tex = new Map(); this.ensure(256); }

  ensure(n) {
    if (n <= this.size * this.size) return;
    this.size = Math.ceil(Math.sqrt(Math.max(n, 256) * 1.5));
    this.scratch = new Uint32Array(this.size * this.size);
    for (const t of this.tex.values()) t.dispose();
    this.tex.clear();
  }

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
      b.set(a.subarray(0, n));
      t.userData.n = n;
      t.needsUpdate = true;
    }
    return t;
  }
}

/** One stable counting-sort pass on byte `shift` of the keys: (srcI, srcK) -> (dstI, dstK). */
function radixPass(srcI, srcK, dstI, dstK, n, shift, cnt) {
  cnt.fill(0);
  for (let j = 0; j < n; j++) cnt[(srcK[j] >> shift) & 255]++;
  let sum = 0;
  for (let b = 0; b < 256; b++) { const c = cnt[b]; cnt[b] = sum; sum += c; }
  for (let j = 0; j < n; j++) {
    const p = cnt[(srcK[j] >> shift) & 255]++;
    dstI[p] = srcI[j];
    dstK[p] = srcK[j];
  }
}

export class FigureBatch {
  /**
   * geometry: the merged figures (32-bit indices); ranges: index ranges [{start, count}] (in indices)
   * referred to by the sub-draws.
   */
  constructor(app, geometry, ranges, mat, depth, uniforms) {
    this.app = app;
    this.uniforms = uniforms;
    this.ranges = ranges;
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = 'humans.figures';
    // drawn by the renderer's batched path: _multiDraw* lists, batchingIdTexture = indirect texture
    mesh.isBatchedMesh = true;
    mesh._multiDrawStarts = new Int32Array(1024);
    mesh._multiDrawCounts = new Int32Array(1024);
    mesh._multiDrawCount = 0;
    mesh._colorsTexture = null;
    mesh._matricesTexture = new THREE.DataTexture(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), 4, 1, THREE.RGBAFormat, THREE.FloatType);
    mesh._matricesTexture.needsUpdate = true;
    mesh.customDepthMaterial = depth;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    // whole-batch test: the light's cascade frustum skips the cascades it does not redraw this
    // frame; any other frustum keeps the batch (figures are culled per pass)
    mesh.intersectsFrustum = (f) => f.intersectsObject(_all);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    // the CPU copies of the merged vertices and indices are not needed once uploaded (nothing rewrites
    // them; the figures are not raycast: their rest-pose vertices are not where they are drawn)
    for (const a of Object.values(geometry.attributes)) a.onUpload(releaseArray);
    if (geometry.index) geometry.index.onUpload(releaseArray);
    mesh.raycast = () => {};
    this.mesh = mesh;
    this.lists = new IndirectLists();
    // posed figures of this frame (struct of arrays)
    this.cap = 0;
    this.n = 0;
    this._grow(512);
    this.frame = -1;
    this.viewCam = null;
    this.nView = 0;
    this.stats = { view: 0, shadow: 0, tris: 0, shadowTris: 0, passes: 0 };
    const scene = app.scene;
    const self = this;
    mesh.onBeforeRender = function (renderer, sc, camera) { self._viewPass(renderer, camera); self._qBegin('view'); };
    mesh.onBeforeShadow = function (renderer, object, camera, shadowCamera) { self._shadowPass(scene, shadowCamera); self._qBegin('shadow'); };
    // humans_prof=1: GPU time of the figure draws alone (the frame timer is paused: queries cannot nest)
    this.prof = null;
    if (app.params.num('humans_prof', 0)) {
      const gl = app.renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (ext) {
        if (app.gpuTimer) app.gpuTimer.ext = null;
        this.prof = { gl, ext, open: null, pending: [], sum: { view: 0, shadow: 0 }, n: { view: 0, shadow: 0 }, frames: 0, lastFrame: -1, ms: { view: 0, shadow: 0 } };
        mesh.onAfterRender = () => self._qEnd();
        mesh.onAfterShadow = () => self._qEnd();
      }
    }
  }

  _qBegin(kind) {
    const P = this.prof;
    if (!P || P.open) return;
    if (this.app.frame !== P.lastFrame) { P.lastFrame = this.app.frame; P.frames++; }
    const q = P.gl.createQuery();
    P.gl.beginQuery(P.ext.TIME_ELAPSED_EXT, q);
    P.open = { q, kind };
  }

  _qEnd() {
    const P = this.prof;
    if (!P || !P.open) return;
    const gl = P.gl;
    gl.endQuery(P.ext.TIME_ELAPSED_EXT);
    P.pending.push(P.open);
    P.open = null;
    while (P.pending.length) {
      const it = P.pending[0];
      if (!gl.getQueryParameter(it.q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(P.ext.GPU_DISJOINT_EXT)) { P.sum[it.kind] += gl.getQueryParameter(it.q, gl.QUERY_RESULT) / 1e6; }
      gl.deleteQuery(it.q);
      P.pending.shift();
    }
  }

  /** humans_prof=1: mean GPU ms per frame of the view and shadow draws since the last call. */
  profile() {
    const P = this.prof;
    if (!P) return null;
    const f = Math.max(1, P.frames);
    const r = { view: +(P.sum.view / f).toFixed(3), shadow: +(P.sum.shadow / f).toFixed(3), frames: P.frames };
    P.sum.view = P.sum.shadow = 0; P.frames = 0;
    return r;
  }

  _grow(n) {
    if (n <= this.cap) return;
    const cap = Math.max(n, this.cap * 2);
    const F = (old, k = 1) => { const a = new Float32Array(cap * k); if (old) a.set(old); return a; };
    const I = (old, k = 1) => { const a = new Int32Array(cap * k); if (old) a.set(old); return a; };
    this.row = I(this.row); this.sph = F(this.sph, 4); this.depth = F(this.depth); this.inView = I(this.inView);
    this.lod = I(this.lod); this.body = I(this.body, 4); this.extra = I(this.extra, 4); this.extraFar = I(this.extraFar, 4);
    this.shadowExtra = I(this.shadowExtra, 2);
    this.cap = cap;
    this.order = new Uint32Array(cap);
    // (radix sort scratch: indices and 16-bit depth keys, two buffers each)
    this._oA = new Uint32Array(cap); this._oB = new Uint32Array(cap);
    this._kA = new Uint16Array(cap); this._kB = new Uint16Array(cap);
    if (!this._cnt) this._cnt = new Uint32Array(256);
    const m = this.mesh;
    if (m && m._multiDrawStarts.length < cap * 4) {
      m._multiDrawStarts = new Int32Array(cap * 4);
      m._multiDrawCounts = new Int32Array(cap * 4);
    }
    this.lists && this.lists.ensure(cap * 4);
  }

  begin(frame, camera) {
    this.n = 0;
    this.stats.shadow = 0; this.stats.shadowTris = 0;
    this.frame = frame;
    this.viewCam = camera;
  }

  /**
   * A posed figure: bone row, in the view frustum, view LOD, body range ids per LOD [4], accessory range
   * ids drawn at LOD <= 1 (up to 4, -1 none), their far stand-ins for LOD >= 2 (or -1), and accessory
   * ranges that cast shadows (up to 2). Returns its index: the caller writes its world bounding sphere
   * into sph[i * 4 .. i * 4 + 3] and its view depth into depth[i] (floats are not passed as arguments).
   */
  add(row, inView, lod, body, extra, extraFar, shadowExtra) {
    if (this.n >= this.cap) this._grow(this.n + 1);
    const i = this.n++;
    this.row[i] = row;
    this.inView[i] = inView ? 1 : 0;
    this.lod[i] = lod;
    for (let k = 0; k < 4; k++) {
      this.body[i * 4 + k] = body[k];
      this.extra[i * 4 + k] = extra ? extra[k] ?? -1 : -1;
      this.extraFar[i * 4 + k] = extraFar ? extraFar[k] ?? -1 : -1;
    }
    this.shadowExtra[i * 2] = shadowExtra ? shadowExtra[0] ?? -1 : -1;
    this.shadowExtra[i * 2 + 1] = shadowExtra ? shadowExtra[1] ?? -1 : -1;
    return i;
  }

  /** After the frame's figures are added: the view order (front to back), by a two-pass radix sort of
   *  the view depth quantised to 1/32 m (0 .. 2 km; the order only serves early depth rejection), which
   *  makes no garbage (a typed-array sort with a comparator copies and boxes). */
  end() {
    const n = this.n, inView = this.inView, d = this.depth;
    const oA = this._oA, oB = this._oB, kA = this._kA, kB = this._kB;
    let k = 0;
    for (let i = 0; i < n; i++) {
      if (!inView[i]) continue;
      const q = d[i] * 32;
      oA[k] = i;
      kA[k] = q <= 0 ? 0 : q >= 65535 ? 65535 : q | 0;
      k++;
    }
    radixPass(oA, kA, oB, kB, k, 0, this._cnt);
    radixPass(oB, kB, this.order, kA, k, 8, this._cnt);
    this.nView = k;
    this.mesh.visible = n > 0;
    this.stats.passes = 0;
  }

  _push(k, rangeId, row, ind) {
    const R = this.ranges[rangeId];
    const m = this.mesh;
    m._multiDrawStarts[k] = R.start * 4;
    m._multiDrawCounts[k] = R.count;
    ind[k] = row;
    return R.count / 3;
  }

  _viewPass(renderer, camera) {
    const m = this.mesh, ind = this.lists.scratch;
    // alpha to coverage needs a multisampled target: else the shader dithers
    const rt = renderer.getRenderTarget();
    const samples = rt ? rt.samples : ((renderer.getContext().getContextAttributes() || {}).antialias ? 4 : 0);
    if (this.uniforms) this.uniforms.uA2C.value = samples > 1 ? samples : 0;
    let k = 0, tris = 0;
    const generic = camera !== this.viewCam;
    if (generic) _vf.setFromProjectionMatrix(_pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth);
    const S = this.sph;
    const n = generic ? this.n : this.nView;
    const sph = _proxy.boundingSphere;
    for (let j = 0; j < n; j++) {
      const i = generic ? j : this.order[j];
      if (generic) {
        sph.center.set(S[i * 4], S[i * 4 + 1], S[i * 4 + 2]); sph.radius = S[i * 4 + 3];
        if (!_vf.intersectsSphere(sph)) continue;
      }
      const lod = this.lod[i], row = this.row[i];
      tris += this._push(k++, this.body[i * 4 + lod], row, ind);
      const ex = lod <= 1 ? this.extra : this.extraFar;
      for (let e = 0; e < 4; e++) {
        const id = ex[i * 4 + e];
        if (id >= 0) tris += this._push(k++, id, row, ind);
      }
    }
    m._indirectTexture = this.lists.commit(camera, k);
    m._multiDrawCount = k;
    if (!generic) { this.stats.view = k; this.stats.tris = tris; }
  }

  _shadowPass(scene, cam) {
    const m = this.mesh, ind = this.lists.scratch;
    const c = cascadeOf(scene, cam);
    const frustum = c.frustum || c.plain;
    const minLod = c.texel > SHADOW_LOD_TEXEL[1] ? 3 : c.texel > SHADOW_LOD_TEXEL[0] ? 2 : 1;
    const S = this.sph, sph = _proxy.boundingSphere;
    let k = 0, tris = 0;
    for (let i = 0; i < this.n; i++) {
      sph.center.set(S[i * 4], S[i * 4 + 1], S[i * 4 + 2]); sph.radius = S[i * 4 + 3];
      if (!frustum.intersectsObject(_proxy)) continue;
      const lod = Math.max(minLod, this.lod[i]), row = this.row[i];
      tris += this._push(k++, this.body[i * 4 + lod], row, ind);
      for (let e = 0; e < 2; e++) {
        const id = this.shadowExtra[i * 2 + e];
        if (id >= 0) tris += this._push(k++, id, row, ind);
      }
    }
    m._indirectTexture = this.lists.commit(cam, k);
    m._multiDrawCount = k;
    this.stats.shadow += k;
    this.stats.shadowTris += tris;
    this.stats.passes++;
  }
}
