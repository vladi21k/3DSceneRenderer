import * as THREE from 'three';

// One merged mesh per material for the whole street ("strip"), instead of one per chunk.
//
// Each chunk's merged geometry is a block in a ring-allocated vertex / index store:
// chunks stream in ahead and out behind, so blocks are freed roughly in the order they
// were allocated and the ring reuses the space without compaction (a full ring grows and
// compacts once). Vertex data is uploaded when a block is allocated (often while the
// chunk is prefetched); the block is drawn once activated, when its indices are copied
// in (inactive and freed ranges hold zeros: degenerate triangles).
//
// Every pass draws one index range: the span of the active blocks whose bounding
// spheres meet that camera's frustum (main view or shadow cascade), so a strip costs
// one draw call per pass and still culls per chunk. A strip is an InstancedMesh of one
// identity instance so it shares its program with the material's instanced sets, and
// so it can skip a pass outright (count 0). Shadow-only strips (light stand-ins of the
// casters) are culled from every view that is not a light's shadow frustum.

const _m = new THREE.Matrix4(), _f = new THREE.Frustum(), _b = new THREE.Box3(), _bb = new THREE.Box3();

/** Vertex streams of a strip: name -> components (position always). */
const STREAMS = { position: ['P', 3], normal: ['N', 3], uv: ['T', 2], color: ['C', 3], aGk: ['K', 1] };

// A shadow pass culls blocks with its light's own cascade frustum when there is one: it
// knows which slice of the view the cascade serves, how far shadows reach toward it, and
// which casters are too thin for its texels (sunShadow.js). Each block is tested through
// a stand-in object of its own (the frustum may cache per-object data for the frame).
const _frustumOf = new WeakMap();
const IDENTITY = new THREE.Matrix4();

const _shadowFrusta = new WeakMap(); // frustum -> true for a light's shadow frustum

/** Registers the shadow cameras and frusta of the lights in `scene`. */
function scanLights(scene) {
  for (const l of scene ? scene.children : []) {
    const sh = l.isLight && l.castShadow ? l.shadow : null;
    if (!sh || !sh.getFrustum || !sh.getCamera) continue;
    const n = sh.getViewportCount ? sh.getViewportCount() : 1;
    for (let i = 0; i < n; i++) { _frustumOf.set(sh.getCamera(i), sh.getFrustum(i)); _shadowFrusta.set(sh.getFrustum(i), true); }
  }
}

/** The shadow frustum of `camera` (a light's shadow camera in `scene`), or null. */
function shadowFrustum(scene, camera) {
  let f = _frustumOf.get(camera);
  if (f !== undefined) return f;
  scanLights(scene);
  f = _frustumOf.get(camera) || null;
  _frustumOf.set(camera, f);
  return f;
}

/** Makes `mesh` a shadow caster only: the view (any frustum that is not a light's shadow
 *  frustum) culls it before it costs a draw or even a program. */
export function shadowOnly(mesh, scene) {
  mesh.intersectsFrustum = function (frustum) {
    let s = _shadowFrusta.get(frustum);
    if (s === undefined) { scanLights(scene); s = _shadowFrusta.get(frustum) || false; _shadowFrusta.set(frustum, s); }
    return s && frustum.intersectsObject(this);
  };
  return mesh;
}

export class Strip {
  /** streams: list of attribute names besides position; opts: {vCap, iCap, castShadow,
   *  receiveShadow, shadowOnly, thin, instanceColor, name} */
  constructor(material, streams, opts = {}) {
    this.material = material;
    this.streams = ['position', ...streams];
    this.opts = opts;
    this.vCap = opts.vCap || 1 << 15;
    this.iCap = opts.iCap || 1 << 16;
    this.blocks = [];        // allocation order (oldest first)
    this.active = 0;
    this.arrays = {};
    for (const s of this.streams) this.arrays[s] = new Float32Array(this.vCap * STREAMS[s][1]);
    this.index = new Uint32Array(this.iCap);
    this.mesh = new THREE.InstancedMesh(this._geometry(), material, 1);
    if (opts.instanceColor) this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1]), 3);
    this.mesh.name = opts.name || 'ironwork:strip';
    this.mesh.castShadow = !!(opts.castShadow || opts.shadowOnly);
    this.mesh.receiveShadow = opts.receiveShadow ?? !opts.shadowOnly;
    this.mesh.userData.thinCaster = !!opts.thin;
    this.mesh.boundingSphere = new THREE.Sphere();
    this.mesh.visible = false;
    if (opts.shadowOnly) shadowOnly(this.mesh, opts.scene);
    else this.mesh.onBeforeRender = (r, scene, camera) => this._cull(camera, null);
    this.mesh.onBeforeShadow = (r, obj, camera, shadowCamera) => this._cull(shadowCamera, shadowFrustum(opts.scene, shadowCamera));
  }

  _geometry() {
    const g = new THREE.BufferGeometry();
    for (const s of this.streams) g.setAttribute(s, new THREE.BufferAttribute(this.arrays[s], STREAMS[s][1]));
    // a position-only caster still declares normals, aliased to its positions (one buffer,
    // never read by the depth pass): programs are keyed on their presence, and the scene
    // precompile would otherwise build the material a second program just for this mesh
    if (!g.attributes.normal) g.setAttribute('normal', g.attributes.position);
    g.setIndex(new THREE.BufferAttribute(this.index, 1));
    g.setDrawRange(0, 0);
    return g;
  }

  /** First free offset for `n` items after the live blocks (ring order), or -1. */
  _place(n, cap, start, len) {
    const B = this.blocks;
    if (!B.length) return n <= cap ? 0 : -1;
    const t = start(B[0]), last = B[B.length - 1], h = start(last) + len(last);
    if (start(last) >= t) {
      if (h + n <= cap) return h;
      return n <= t ? 0 : -1;
    }
    return h + n <= t ? h : -1;
  }

  /** Copies the writer's geometry into a new (inactive) block; `sphere` bounds it. */
  alloc(W, sphere) {
    const nv = W.n, ni = W.ni;
    if (!nv || !ni) return null;
    const vs = (b) => b.v0, vl = (b) => b.nv, is = (b) => b.i0, il = (b) => b.ni;
    let v0 = this._place(nv, this.vCap, vs, vl), i0 = this._place(ni, this.iCap, is, il);
    if (v0 < 0 || i0 < 0) {
      this._grow(nv, ni);
      v0 = this._place(nv, this.vCap, vs, vl); i0 = this._place(ni, this.iCap, is, il);
    }
    const g = this.mesh.geometry;
    for (const s of this.streams) {
      const [key, k] = STREAMS[s];
      this.arrays[s].set(W[key].subarray(0, nv * k), v0 * k);
      const a = g.attributes[s];
      a.addUpdateRange(v0 * k, nv * k);
      a.needsUpdate = true;
    }
    // the block's indices, already offset (activation is then a plain copy)
    const idx = new Uint32Array(ni), WI = W.I;
    for (let k = 0; k < ni; k++) idx[k] = WI[k] + v0;
    const block = { v0, nv, i0, ni, idx, sphere: sphere.clone(), active: false };
    block.proxy = { geometry: { boundingSphere: block.sphere }, matrixWorld: IDENTITY, userData: this.mesh.userData };
    this.blocks.push(block);
    return block;
  }

  /** Starts drawing a block. */
  activate(block) {
    if (!block || block.active) return;
    this.index.set(block.idx, block.i0);
    block.idx = null;
    block.active = true;
    this.active++;
    this._indexRange(block);
    this._bounds();
  }

  /** Releases a block (drawn or not). */
  free(block) {
    if (!block) return;
    const k = this.blocks.indexOf(block);
    if (k < 0) return;
    this.blocks.splice(k, 1);
    if (block.active) {
      this.index.fill(0, block.i0, block.i0 + block.ni);
      this._indexRange(block);
      block.active = false;
      this.active--;
      this._bounds();
    }
  }

  _indexRange(block) {
    const a = this.mesh.geometry.index;
    a.addUpdateRange(block.i0, block.ni);
    a.needsUpdate = true;
  }

  /** Bounding sphere of the active blocks (whole-object culling). */
  _bounds() {
    _b.makeEmpty();
    for (const b of this.blocks) if (b.active) _b.union(b.sphere.getBoundingBox(_bb));
    this.mesh.visible = this.active > 0;
    if (this.active) _b.getBoundingSphere(this.mesh.boundingSphere);
  }

  /** Draw range for one pass: the index span of the active blocks in `camera`'s view
   *  (or in the light's cascade frustum `lf`, see shadowFrustum). */
  _cull(camera, lf) {
    if (!lf) {
      _m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _f.setFromProjectionMatrix(_m, camera.coordinateSystem, camera.reversedDepth);
    }
    let lo = Infinity, hi = -1;
    for (const b of this.blocks) {
      if (!b.active || !(lf ? lf.intersectsObject(b.proxy) : _f.intersectsSphere(b.sphere))) continue;
      if (b.i0 < lo) lo = b.i0;
      if (b.i0 + b.ni > hi) hi = b.i0 + b.ni;
    }
    this.mesh.count = hi < 0 ? 0 : 1;
    if (hi >= 0) this.mesh.geometry.setDrawRange(lo, hi - lo);
  }

  /** Larger store with the live blocks packed in order (rare: a full ring). */
  _grow(nv, ni) {
    let lv = nv, li = ni;
    for (const b of this.blocks) { lv += b.nv; li += b.ni; }
    const vCap = Math.max(this.vCap, Math.ceil(lv * 1.5)), iCap = Math.max(this.iCap, Math.ceil(li * 1.5));
    const arrays = {};
    for (const s of this.streams) arrays[s] = new Float32Array(vCap * STREAMS[s][1]);
    const index = new Uint32Array(iCap);
    let v = 0, i = 0;
    for (const b of this.blocks) {
      for (const s of this.streams) {
        const k = STREAMS[s][1];
        arrays[s].set(this.arrays[s].subarray(b.v0 * k, (b.v0 + b.nv) * k), v * k);
      }
      if (b.active) for (let q = 0; q < b.ni; q++) index[i + q] = this.index[b.i0 + q] - b.v0 + v;
      else for (let q = 0; q < b.ni; q++) b.idx[q] += v - b.v0;
      b.v0 = v; b.i0 = i;
      v += b.nv; i += b.ni;
    }
    this.vCap = vCap; this.iCap = iCap;
    this.arrays = arrays; this.index = index;
    const old = this.mesh.geometry;
    this.mesh.geometry = this._geometry();
    old.dispose();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
