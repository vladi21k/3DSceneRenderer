import * as THREE from 'three';

// Per-chunk instancing with per-INSTANCE level of detail.
//
// Instances are collected per key (geometry family + material). Each set gets one
// InstancedMesh per detail level; every instance (a railing bay, a console, a plant…)
// is assigned to exactly one level by its own distance to the camera, and the level
// meshes are repacked only when some instance changes level. A long balcony therefore
// refines bay by bay as the camera approaches (no whole-facade switches), at the cost
// of one draw per level actually in use.
//
// Distance classes ('cls') name the limit table the owner passes to partition():
// limits[k] is the distance up to which level k is used; beyond the last limit the
// instance is not drawn. A set with a single level and no class is static.

const _v = new THREE.Vector3();

export class LodInstancer {
  constructor() { this.sets = new Map(); }

  /** levels: geometry per detail level (null = nothing drawn at that level).
   *  color: [r, g, b] or null. opts: {cls, castShadow, receiveShadow, radius} (first add
   *  wins; radius pads the bounding sphere, default from the level-0 geometry). */
  add(key, levels, material, matrix, color = null, opts = {}) {
    let s = this.sets.get(key);
    if (!s) {
      s = { key, levels, material, opts, n: 0, m: new Float32Array(16 * 16), c: color ? new Float32Array(16 * 3) : null };
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

  /** Emits the level meshes into `group`; returns the sets (static ones already filled). */
  build(group) {
    const out = [];
    for (const s of this.sets.values()) {
      if (!s.n) continue;
      s.m = s.m.slice(0, s.n * 16);
      if (s.c) s.c = s.c.slice(0, s.n * 3);
      s.cls = s.opts.cls || null;
      s.lvl = new Uint8Array(s.n).fill(254);
      // bounding sphere of the instance origins, padded by the geometry extent
      let x = 0, y = 0, z = 0;
      for (let i = 0; i < s.n; i++) { x += s.m[i * 16 + 12]; y += s.m[i * 16 + 13]; z += s.m[i * 16 + 14]; }
      x /= s.n; y /= s.n; z /= s.n;
      let r = 0;
      for (let i = 0; i < s.n; i++) {
        const dx = s.m[i * 16 + 12] - x, dy = s.m[i * 16 + 13] - y, dz = s.m[i * 16 + 14] - z;
        r = Math.max(r, dx * dx + dy * dy + dz * dz);
      }
      const g0 = s.levels.find(Boolean);
      if (!g0.boundingSphere) g0.computeBoundingSphere();
      const pad = s.opts.radius ?? g0.boundingSphere.center.length() + g0.boundingSphere.radius;
      s.sphere = new THREE.Sphere(new THREE.Vector3(x, y, z), Math.sqrt(r) + pad * 1.25);
      s.meshes = s.levels.map((geo) => {
        if (!geo) return null;
        // created empty, then given our own buffers (skips the identity fill)
        const mesh = new THREE.InstancedMesh(geo, s.material, 0);
        mesh.instanceMatrix = new THREE.InstancedBufferAttribute(s.cls ? new Float32Array(s.n * 16) : s.m, 16);
        if (s.c) mesh.instanceColor = new THREE.InstancedBufferAttribute(s.cls ? new Float32Array(s.n * 3) : s.c, 3);
        mesh.count = s.cls ? 0 : s.n;
        mesh.visible = !s.cls;
        mesh.castShadow = s.opts.castShadow ?? true;
        mesh.receiveShadow = s.opts.receiveShadow ?? true;
        mesh.boundingSphere = s.sphere;
        mesh.userData.key = s.key;
        group.add(mesh);
        return mesh;
      });
      out.push(s);
    }
    this.sets.clear();
    return out;
  }

  /** Assigns every instance of `s` to a level by its distance from `cam` and repacks the
   *  level meshes if anything changed. Returns true when it repacked. */
  static partition(s, cam, limits) {
    const L = limits.length, m = s.m;
    // whole set beyond the last limit (or inside the first): skip the per-instance pass
    const dc = _v.copy(s.sphere.center).distanceTo(cam);
    let uniform = -1;
    if (dc - s.sphere.radius >= limits[L - 1]) uniform = L;
    else if (dc + s.sphere.radius < limits[0]) uniform = 0;
    let changed = false;
    for (let i = 0; i < s.n; i++) {
      let k = uniform;
      if (k < 0) {
        const dx = m[i * 16 + 12] - cam.x, dy = m[i * 16 + 13] - cam.y, dz = m[i * 16 + 14] - cam.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        k = 0;
        while (k < L && d >= limits[k]) k++;
      }
      if (k !== s.lvl[i]) { s.lvl[i] = k; changed = true; }
    }
    if (!changed) return false;
    const counts = s.meshes.map(() => 0);
    for (let i = 0; i < s.n; i++) {
      const k = s.lvl[i], mesh = s.meshes[k];
      if (!mesh) continue;
      const j = counts[k]++;
      mesh.instanceMatrix.array.set(m.subarray(i * 16, i * 16 + 16), j * 16);
      if (s.c) { const a = mesh.instanceColor.array; a[j * 3] = s.c[i * 3]; a[j * 3 + 1] = s.c[i * 3 + 1]; a[j * 3 + 2] = s.c[i * 3 + 2]; }
    }
    s.meshes.forEach((mesh, k) => {
      if (!mesh) return;
      mesh.count = counts[k];
      mesh.visible = counts[k] > 0;
      if (!counts[k]) return;
      const im = mesh.instanceMatrix;
      im.clearUpdateRanges(); im.addUpdateRange(0, counts[k] * 16); im.needsUpdate = true;
      if (mesh.instanceColor) {
        const ic = mesh.instanceColor;
        ic.clearUpdateRanges(); ic.addUpdateRange(0, counts[k] * 3); ic.needsUpdate = true;
      }
    });
    return true;
  }
}
