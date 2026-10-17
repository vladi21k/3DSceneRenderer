import * as THREE from 'three';

// Collects per-chunk instances keyed by (geometry, material) and emits one InstancedMesh
// per key. Matrices are world-space (facade frame × local placement).
//
// Sets added with {lazy: true} are not turned into meshes at build time: build() returns
// them as pending entries (instance data + distance anchors) and the owner materialises
// them only when the camera first comes close. Most near-range railing meshes are never
// needed (side streets, far floors), so chunk builds skip their cost entirely.

export class Instancer {
  constructor() { this.sets = new Map(); }

  /** color: [r, g, b] or null. opts: {tag, castShadow, receiveShadow, alt, lazy} (first
   *  add wins). alt: {geometry, tag} or an array of them: further meshes (other detail
   *  levels) sharing the same instance buffers, so every level costs one set of matrices. */
  add(key, geometry, material, matrix, color = null, opts = {}) {
    let s = this.sets.get(key);
    if (!s) {
      s = { key, geometry, material, n: 0, m: new Float32Array(16 * 16), c: color ? new Float32Array(16 * 3) : null, opts };
      this.sets.set(key, s);
    }
    if ((s.n + 1) * 16 > s.m.length) {
      const m = new Float32Array(s.m.length * 2); m.set(s.m); s.m = m;
      if (s.c) { const c = new Float32Array(s.c.length * 2); c.set(s.c); s.c = c; }
    }
    s.m.set(matrix.elements, s.n * 16);
    if (s.c) { s.c[s.n * 3] = color[0]; s.c[s.n * 3 + 1] = color[1]; s.c[s.n * 3 + 2] = color[2]; }
    s.n++;
  }

  /** Distance anchor (world x, y, z, radius) for the set `key`: LOD switches on the
   *  nearest anchor instead of the whole bounding sphere. */
  anchor(key, x, y, z, r) {
    const s = this.sets.get(key);
    if (s) (s.anchors ||= []).push(x, y, z, r);
  }

  /** Emits meshes into `group`; returns {meshes, pending} (pending = lazy sets). */
  build(group) {
    const meshes = [], pending = [];
    for (const s of this.sets.values()) {
      if (!s.n) continue;
      s.m = s.m.slice(0, s.n * 16);
      if (s.c) s.c = s.c.slice(0, s.n * 3);
      if (s.anchors) s.anchors = new Float32Array(s.anchors);
      if (s.opts.lazy) pending.push(s);
      else meshes.push(...Instancer.materialize(s, group));
    }
    this.sets.clear();
    return { meshes, pending };
  }

  /** Creates the mesh (and its alternate detail levels) for a collected set. */
  static materialize(s, group) {
    const mesh = new THREE.InstancedMesh(s.geometry, s.material, 0);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(s.m, 16);
    mesh.count = s.n;
    if (s.c) mesh.instanceColor = new THREE.InstancedBufferAttribute(s.c, 3);
    mesh.castShadow = s.opts.castShadow ?? true;
    mesh.receiveShadow = s.opts.receiveShadow ?? true;
    mesh.userData.tag = s.opts.tag || 'all';
    mesh.userData.key = s.key;
    mesh.userData.anchors = s.anchors;
    mesh.computeBoundingSphere();
    group.add(mesh);
    const out = [mesh];
    const alts = !s.opts.alt ? [] : Array.isArray(s.opts.alt) ? s.opts.alt : [s.opts.alt];
    for (const alt of alts) {
      const m2 = new THREE.InstancedMesh(alt.geometry, s.material, 0);
      m2.instanceMatrix = mesh.instanceMatrix;
      m2.instanceColor = mesh.instanceColor;
      m2.count = s.n;
      m2.castShadow = mesh.castShadow; m2.receiveShadow = mesh.receiveShadow;
      m2.userData.tag = alt.tag;
      m2.userData.key = s.key;
      m2.userData.anchors = s.anchors;
      m2.boundingSphere = mesh.boundingSphere; // both levels switch on the same sphere
      group.add(m2);
      out.push(m2);
    }
    return out;
  }
}
