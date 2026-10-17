import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

// Sky occlusion under the street trees. A crown hides part of the sky from the paving
// under it, so its shade is deeper than the open shade of the street canyon, while the
// light in the gaps between the leaves (the sun flecks) is full sunlight. The shadow map
// only removes the sun, so each tree gets a soft disc on the paving under its crown that
// darkens only the shaded ground: a shadow-mask material (black, alpha = strength x
// falloff x (1 - sun shadow mask)), drawn first among the transparent surfaces, with no
// depth writes. Sun flecks, sunlit paving and everything standing on the paving are left
// as they are.
//
// Falloff: the cosine-weighted share of the sky a crown of radius r at height h hides
// from a point x away from its foot goes as (h^2 / (h^2 + x^2))^2, so the disc spans about
// the crown's height, not its radius; its strength at the centre (a little above the
// open-sky estimate: neighbouring crowns, the trunk and the canyon add to it) is set per
// tree by vegetation.js.
//
// Per chunk, the discs of its trees are merged into one small mesh that follows the
// ground (route.toWorld), so the darkening hugs the sidewalk's cross-fall and the
// settlement undulation. It fades out with the night (lamps light the paving under the
// crowns from the side, so their light is not occluded).

const RINGS = [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.25];   // radii in crown heights
const SEGS = 20;
const LIFT = 0.012;                                   // m above the paving

/** Falloff of the occlusion with the distance from the crown's foot (in crown heights). */
function falloff(r) {
  const q = 1 / (1 + r * r);
  return q * q * (1 - THREE.MathUtils.smoothstep(r, 0.85, 1.25));
}

export function createGroundShade(app) {
  const mat = new THREE.ShadowMaterial({ color: 0x000000, opacity: 1, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  mat.name = 'vegetation.groundShade';
  mat.fog = false;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -4;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uNight = U.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aShade;\nvarying float vShade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvShade = aShade;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vShade;\nuniform float uNight;')
      .replace('#include <logdepthbuf_fragment>', '#include <logdepthbuf_fragment>\nif ( vShade * ( 1.0 - uNight ) < 0.004 ) discard;')
      .replace('gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );',
        'gl_FragColor = vec4( color, vShade * ( 1.0 - uNight ) * opacity * ( 1.0 - getShadowMask() ) );');
  };
  mat.customProgramCacheKey = () => 'veg-ground-shade-v1';
  app.materials.register('vegetation.groundShade', mat);

  const { route } = app;
  const p = new THREE.Vector3();
  return {
    material: mat,
    /**
     * One mesh for the trees of a chunk. items: [{s, d, side, r (crown radius, m),
     * h (crown centre height, m), k (darkening of the shaded paving at the centre, 0..1)}].
     * Returns null when empty.
     */
    build(items) {
      if (!items.length) return null;
      const nv = RINGS.length * (SEGS + 1);
      const pos = new Float32Array(items.length * nv * 3), shade = new Float32Array(items.length * nv);
      const idx = [];
      let v = 0;
      for (const it of items) {
        const base = v;
        // the crown sits a little away from the tracks (it is pruned clear of them)
        const sc = it.s, dc = it.d + it.side * 0.15 * it.r;
        const os = route.offsetScale(sc, dc);
        for (let i = 0; i < RINGS.length; i++) {
          const rr = RINGS[i] * it.h, f = falloff(RINGS[i]) * it.k;
          for (let j = 0; j <= SEGS; j++) {
            const a = (j / SEGS) * Math.PI * 2;
            route.toWorld(sc + (rr * Math.cos(a)) / os, dc + rr * Math.sin(a), LIFT, p);
            pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z;
            shade[v] = f;
            v++;
          }
        }
        for (let i = 0; i < RINGS.length - 1; i++) {
          for (let j = 0; j < SEGS; j++) {
            const a = base + i * (SEGS + 1) + j, b = a + 1, c = a + SEGS + 1, d = c + 1;
            idx.push(a, c, b, b, c, d);
          }
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('aShade', new THREE.BufferAttribute(shade, 1));
      g.setIndex(idx);
      g.computeVertexNormals();
      // the winding depends on the route's handedness: make the normals point up
      const n = g.attributes.normal;
      if (n.getY(0) < 0 || n.getY(Math.min(n.count - 1, SEGS + 2)) < 0) {
        for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
      }
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = 'vegetation:groundShade';
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.renderOrder = -1;  // first among the transparent surfaces (right after the paving)
      return mesh;
    },
  };
}
