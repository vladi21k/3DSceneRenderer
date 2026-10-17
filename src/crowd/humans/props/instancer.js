import * as THREE from 'three';

// Instanced drawing of mobility props: one InstancedMesh per (variant, LOD), sharing the kit's
// geometries and the single prop material. Per-instance animation state and look ride on the
// mesh's own instance buffers (see shading.js), so geometries are never copied per user.
//
// Immediate mode (moving props, re-filled every frame):
//   const inst = kit.createInstancer({ capacity: 64 });  scene.add(inst.object);
//   inst.begin(camera, renderer);  inst.add(variant, matrixWorld, anim, look);  inst.end();
// LOD per instance from its projected size in pixels (prop height x pixels per metre / distance).

export const LOD_PX = [470, 120];        // projected prop height (px) above which LOD 0 / 1 are used
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const _sph = new THREE.Sphere();
const _pos = new THREE.Vector3();

/** Pixels per metre at 1 m distance for a perspective camera and drawing-buffer height. */
export function pxPerMetre(camera, renderer) {
  const h = (renderer && renderer.domElement && renderer.domElement.height) || 1080;
  return h / (2 * Math.tan(((camera.fov || 50) * Math.PI) / 360));
}

export function lodFor(sizePx) {
  return sizePx > LOD_PX[0] ? 0 : sizePx > LOD_PX[1] ? 1 : 2;
}

/** Write a prop instance: world matrix (rows 0-2) + anim in the bottom row, look in the colour slot. */
export function writeInstance(mesh, i, matrix, anim, look) {
  const e = matrix.elements, m = mesh.instanceMatrix.array, o = i * 16;
  for (let k = 0; k < 16; k++) m[o + k] = e[k];
  m[o + 3] = anim[0] || 0; m[o + 7] = anim[1] || 0; m[o + 11] = anim[2] || 0; m[o + 15] = anim[3] || 0;
  const c = mesh.instanceColor.array, oc = i * 3;
  c[oc] = look[0]; c[oc + 1] = look[1]; c[oc + 2] = look[2];
}

/** InstancedMesh for prop geometry g with capacity n (bounds are kept by the owner). */
export function propMesh(g, mats, n, name) {
  const mesh = new THREE.InstancedMesh(g, mats.mat, n);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.customDepthMaterial = mats.depth;
  mesh.customDistanceMaterial = mats.dist;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  mesh.name = name;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  // alpha-to-coverage needs MSAA: without it (no post-processing) spokes / wire mesh dither instead
  mesh.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    mats.uniforms.uPropDither.value = rt && rt.samples > 0 ? 0 : 1;
  };
  return mesh;
}

/** Fit a mesh's bounds to world positions (xyz triples) with a margin. */
export function fitBounds(mesh, pts, count, radius) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let k = 0; k < count; k++) {
    const x = pts[k * 3], y = pts[k * 3 + 1], z = pts[k * 3 + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!count) { x0 = y0 = z0 = 0; x1 = y1 = z1 = 0; }
  mesh.boundingBox.min.set(x0 - radius, y0 - radius, z0 - radius);
  mesh.boundingBox.max.set(x1 + radius, y1 + radius * 2, z1 + radius);
  mesh.boundingBox.getBoundingSphere(mesh.boundingSphere);
}

export class PropInstancer {
  /** kit: {variants: [{lods: [g0, g1, g2], size}], mats}; meshes are created lazily per (variant, lod). */
  constructor(kit, { capacity = 32, name = 'props', castShadow = true, shadowLod = 2 } = {}) {
    this.kit = kit;
    this.cap0 = capacity;
    this.object = new THREE.Group();
    this.object.name = name;
    this.castShadow = castShadow;
    this.shadowLod = shadowLod;     // LODs above this one cast no shadow
    this.slots = new Map();         // key -> {mesh, n, pos}
    this.count = 0;
    this.camPos = new THREE.Vector3();
    this.pxm = 1000;
    this.cull = true;
  }

  _slot(v, lod) {
    // a close-up model still being built in the background: use the next level meanwhile
    while (lod < 2 && !this.kit.variants[v].lods[lod]) lod++;
    const key = v * 4 + lod;
    let s = this.slots.get(key);
    if (!s) {
      const g = this.kit.variants[v].lods[lod];
      const mesh = propMesh(g, this.kit.mats, this.cap0, `${this.object.name}.${this.kit.variants[v].id}.lod${lod}`);
      mesh.castShadow = this.castShadow && lod <= this.shadowLod;
      s = { mesh, n: 0, cap: this.cap0, pos: new Float32Array(this.cap0 * 3) };
      this.slots.set(key, s);
      this.object.add(mesh);
    }
    return s;
  }

  _grow(s, v, lod) {
    const cap = s.cap * 2;
    const old = s.mesh;
    const mesh = propMesh(old.geometry, this.kit.mats, cap, old.name);
    mesh.castShadow = old.castShadow;
    mesh.instanceMatrix.array.set(old.instanceMatrix.array);
    mesh.instanceColor.array.set(old.instanceColor.array);
    this.object.remove(old);
    old.dispose();
    this.object.add(mesh);
    const pos = new Float32Array(cap * 3);
    pos.set(s.pos);
    Object.assign(s, { mesh, cap, pos });
    void v; void lod;
  }

  /** Start a frame: camera (for LOD / culling) and renderer (drawing-buffer height). */
  begin(camera, renderer) {
    for (const s of this.slots.values()) s.n = 0;
    this.count = 0;
    if (camera) {
      camera.updateMatrixWorld();
      _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_pm);
      this.camPos.setFromMatrixPosition(camera.matrixWorld);
      this.pxm = pxPerMetre(camera, renderer);
      this.hasCam = true;
    } else this.hasCam = false;
  }

  /**
   * Add one prop: variant index, world matrix (THREE.Matrix4), anim [4] (see kit.anim),
   * look [3] (kit.pick(...).look). lod: force a LOD (default from the projected size).
   * Returns the LOD used, or -1 if culled.
   */
  add(v, matrix, anim, look, lod = -1) {
    const V = this.kit.variants[v];
    if (!V) return -1;
    _pos.setFromMatrixPosition(matrix);
    if (this.hasCam) {
      _sph.center.copy(_pos); _sph.center.y += V.size * 0.5;
      _sph.radius = V.reach || 1.2;
      if (this.cull && !_frustum.intersectsSphere(_sph)) return -1;
      if (lod < 0) lod = lodFor((V.size * this.pxm) / Math.max(0.3, _sph.center.distanceTo(this.camPos)));
    }
    if (lod < 0) lod = 1;
    const s = this._slot(v, lod);
    if (s.n >= s.cap) this._grow(s, v, lod);
    writeInstance(s.mesh, s.n, matrix, anim, look);
    s.pos[s.n * 3] = _pos.x; s.pos[s.n * 3 + 1] = _pos.y; s.pos[s.n * 3 + 2] = _pos.z;
    s.n++;
    this.count++;
    return lod;
  }

  /** Finish the frame: upload instance ranges and refit bounds. */
  end() {
    for (const s of this.slots.values()) {
      const m = s.mesh;
      m.count = s.n;
      m.visible = s.n > 0;
      if (!s.n) continue;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, s.n * 16);
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.clearUpdateRanges();
      m.instanceColor.addUpdateRange(0, s.n * 3);
      m.instanceColor.needsUpdate = true;
      fitBounds(m, s.pos, s.n, 1.3);
    }
  }

  stats() {
    let draws = 0, tris = 0;
    for (const s of this.slots.values()) {
      if (!s.n) continue;
      draws++;
      tris += (s.n * s.mesh.geometry.index.count) / 3;
    }
    return { props: this.count, draws, triangles: Math.round(tris) };
  }

  dispose() {
    for (const s of this.slots.values()) { this.object.remove(s.mesh); s.mesh.dispose(); }
    this.slots.clear();
  }
}

/** Matrix for a prop standing at (x, y, z): heading (yaw, 0 faces -Z), pitch (nose up +), lean (roll, + leans left). */
export function propMatrix(out, x, y, z, heading = 0, lean = 0, pitch = 0) {
  const ch = Math.cos(heading), sh = Math.sin(heading);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cl = Math.cos(lean), sl = Math.sin(lean);
  // R = Ry(heading) * Rx(pitch) * Rz(lean)
  const r00 = cl, r01 = -sl, r02 = 0;
  const r10 = cp * sl, r11 = cp * cl, r12 = -sp;
  const r20 = sp * sl, r21 = sp * cl, r22 = cp;
  const e = out.elements;
  e[0] = ch * r00 + sh * r20; e[4] = ch * r01 + sh * r21; e[8] = ch * r02 + sh * r22; e[12] = x;
  e[1] = r10; e[5] = r11; e[9] = r12; e[13] = y;
  e[2] = -sh * r00 + ch * r20; e[6] = -sh * r01 + ch * r21; e[10] = -sh * r02 + ch * r22; e[14] = z;
  e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
  return out;
}
