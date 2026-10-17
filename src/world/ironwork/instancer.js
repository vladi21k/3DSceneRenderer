import * as THREE from 'three';

// Collects per-chunk instances keyed by (geometry, material) and emits one InstancedMesh
// per key. Matrices are world-space (facade frame × local placement).

export class Instancer {
  constructor() { this.sets = new Map(); }

  /** color: [r, g, b] or null. opts: {tag, castShadow, receiveShadow, alt} (first add wins).
   *  alt: {geometry, tag} emits a second mesh (another detail level) sharing the same
   *  instance buffers, so both levels cost one set of matrices. */
  add(key, geometry, material, matrix, color = null, opts = {}) {
    let s = this.sets.get(key);
    if (!s) {
      s = { geometry, material, n: 0, m: new Float32Array(16 * 16), c: color ? new Float32Array(16 * 3) : null, opts };
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

  get size() { return this.sets.size; }

  build(group) {
    const meshes = [];
    for (const [key, s] of this.sets) {
      const n = s.n;
      if (!n) continue;
      const mesh = new THREE.InstancedMesh(s.geometry, s.material, 0);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(s.m.slice(0, n * 16), 16);
      mesh.count = n;
      if (s.c) mesh.instanceColor = new THREE.InstancedBufferAttribute(s.c.slice(0, n * 3), 3);
      mesh.castShadow = s.opts.castShadow ?? true;
      mesh.receiveShadow = s.opts.receiveShadow ?? true;
      mesh.userData.tag = s.opts.tag || 'all';
      mesh.userData.key = key;
      mesh.computeBoundingSphere();
      group.add(mesh);
      meshes.push(mesh);
      const alt = s.opts.alt;
      if (alt) {
        const m2 = new THREE.InstancedMesh(alt.geometry, s.material, 0);
        m2.instanceMatrix = mesh.instanceMatrix;
        m2.instanceColor = mesh.instanceColor;
        m2.count = n;
        m2.castShadow = mesh.castShadow; m2.receiveShadow = mesh.receiveShadow;
        m2.userData.tag = alt.tag;
        m2.userData.key = key;
        m2.boundingSphere = mesh.boundingSphere; // both levels switch on the same sphere
        group.add(m2);
        meshes.push(m2);
      }
    }
    this.sets.clear();
    return meshes;
  }
}
