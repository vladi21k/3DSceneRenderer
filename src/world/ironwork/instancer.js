import * as THREE from 'three';

// Collects per-chunk instances keyed by (geometry, material) and emits one InstancedMesh
// per key. Matrices are world-space (facade frame × local placement).

export class Instancer {
  constructor() { this.sets = new Map(); }

  /** color: [r, g, b] or null. opts: {tag, castShadow, receiveShadow} (first add wins). */
  add(key, geometry, material, matrix, color = null, opts = {}) {
    let s = this.sets.get(key);
    if (!s) {
      s = { geometry, material, m: [], c: color ? [] : null, opts };
      this.sets.set(key, s);
    }
    const e = matrix.elements;
    for (let i = 0; i < 16; i++) s.m.push(e[i]);
    if (s.c) s.c.push(color[0], color[1], color[2]);
  }

  get size() { return this.sets.size; }

  build(group) {
    const meshes = [];
    for (const s of this.sets.values()) {
      const n = s.m.length / 16;
      if (!n) continue;
      const mesh = new THREE.InstancedMesh(s.geometry, s.material, 0);
      mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(s.m), 16);
      mesh.count = n;
      if (s.c) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(s.c), 3);
      mesh.castShadow = s.opts.castShadow ?? true;
      mesh.receiveShadow = s.opts.receiveShadow ?? true;
      mesh.userData.tag = s.opts.tag || 'all';
      mesh.computeBoundingSphere();
      group.add(mesh);
      meshes.push(mesh);
    }
    this.sets.clear();
    return meshes;
  }
}
