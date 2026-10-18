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
    mesh.onBeforeRender = function (renderer, sc, camera) { self._viewPass(renderer, camera); };
    mesh.onBeforeShadow = function (renderer, object, camera, shadowCamera) { self._shadowPass(scene, shadowCamera); };
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
   * A posed figure: bone row, world bounding sphere, view depth, in the view frustum, view LOD, body
   * range ids per LOD [4], accessory range ids drawn at LOD <= 1 (up to 4, -1 none), their far stand-
   * ins for LOD >= 2 (or -1), and accessory ranges that cast shadows (up to 2).
   */
  add(row, x, y, z, r, depth, inView, lod, body, extra, extraFar, shadowExtra) {
    if (this.n >= this.cap) this._grow(this.n + 1);
    const i = this.n++;
    this.row[i] = row;
    this.sph[i * 4] = x; this.sph[i * 4 + 1] = y; this.sph[i * 4 + 2] = z; this.sph[i * 4 + 3] = r;
    this.depth[i] = depth;
    this.inView[i] = inView ? 1 : 0;
    this.lod[i] = lod;
    for (let k = 0; k < 4; k++) {
      this.body[i * 4 + k] = body[k];
      this.extra[i * 4 + k] = extra ? extra[k] ?? -1 : -1;
      this.extraFar[i * 4 + k] = extraFar ? extraFar[k] ?? -1 : -1;
    }
    this.shadowExtra[i * 2] = shadowExtra ? shadowExtra[0] ?? -1 : -1;
    this.shadowExtra[i * 2 + 1] = shadowExtra ? shadowExtra[1] ?? -1 : -1;
  }

  /** After the frame's figures are added: the view order (front to back). */
  end() {
    const n = this.n, o = this.order, inView = this.inView, d = this.depth;
    let k = 0;
    for (let i = 0; i < n; i++) if (inView[i]) o[k++] = i;
    const sub = o.subarray(0, k);
    sub.sort((a, b) => d[a] - d[b]);
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
