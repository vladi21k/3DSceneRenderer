import * as THREE from 'three';

// Loads the figure meshes built by tools/blender/humans_build.py (humans.json + humans.bin)
// into one BufferGeometry per base body and LOD. Attribute layout (see the builder):
//   position f32x3 · aNrm i8x4 (normal, w = baked AO) · aBoneI u8x4 · aBoneW u8x4 (norm)
//   aMorph i8x4 (heavy-build delta / morphScale) · aBody u8x4 (region, part, aux0, aux1)

const TYPES = { f32: Float32Array, i8: Int8Array, u8: Uint8Array, u16: Uint16Array, u32: Uint32Array };
const NAMES = { position: 'position', normal: 'aNrm', skinIndex: 'aBoneI', skinWeight: 'aBoneW', morph: 'aMorph', body: 'aBody' };

export async function loadHumanAssets(baseUrl) {
  const [meta, buf] = await Promise.all([
    fetch(baseUrl + 'humans.json').then((r) => { if (!r.ok) throw new Error('humans.json ' + r.status); return r.json(); }),
    fetch(baseUrl + 'humans.bin').then((r) => { if (!r.ok) throw new Error('humans.bin ' + r.status); return r.arrayBuffer(); }),
  ]);
  const bases = {};
  for (const [name, base] of Object.entries(meta.bases)) {
    const lods = base.lods.map((L) => {
      const g = new THREE.InstancedBufferGeometry();
      for (const [key, a] of Object.entries(L.attributes)) {
        const T = TYPES[a.type];
        const arr = new T(buf, a.offset, L.count * a.size);
        g.setAttribute(NAMES[key], new THREE.BufferAttribute(arr, a.size, !!a.normalized));
      }
      g.setAttribute('normal', g.attributes.aNrm);   // lit materials flat-shade without one
      const IT = TYPES[L.index.type];
      g.setIndex(new THREE.BufferAttribute(new IT(buf, L.index.offset, L.index.count), 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, base.info.H / 2, 0), base.info.H);
      g.userData.shared = true;
      return g;
    });
    bases[name] = { ...base, lods };
  }
  return { meta, bases };
}
