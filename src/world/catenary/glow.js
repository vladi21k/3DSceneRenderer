import * as THREE from 'three';
import { SU } from './shaders.js';

// Aureole round the lit lantern bowls (from the photocell ramp before sunset on): the
// light the opal bowl and the dusty evening air scatter just around a bright source, the
// soft skirt a camera shows round every street lamp at dusk. One camera-facing quad per
// lamp near the camera (one instanced draw, no shadows), added to the HDR scene so the
// exposure, white balance and post's bloom treat it like the bowl itself.
//
// Size: GLOW_R metres round the bowl, but never under GLOW_PX pixels, so a far lamp keeps a
// skirt of a few pixels; its peak falls with the area, so the scattered light stays about
// the same however far the lamp. The quad sits PULL m in front of the bowl centre (it
// overlays the bowl and the brim's lower edge, as glare does) and is depth tested against
// the scene, so poles, people and leaves in front cover it.
// Strength: a few per cent of the bowl radiance at the bowl's edge, falling off steeply
// into a faint tail (no plateau, so it never reads as a disc). Its brightness on screen at
// the bowl's rim is held under RIM_MAX of white (env.exposure): in the dark the clipped bowl
// would otherwise drag a bright disc with it. Post's bloom adds the wider lens skirt on top.

const GLOW_R = 0.8;      // m
const GLOW_PX = 7;       // smallest radius on screen (px)
const PULL = 0.32;       // m towards the camera
const K = 0.42;          // aureole radiance at its centre, in bowl radiances (uLamp)
const RIM_G = 0.127;     // profile value at the bowl's rim (r 0.2, see the shader)
const RIM_MAX = 0.4;     // highest display value (white = 1) of the aureole at the rim
const RANGE = [-25, 330];  // m of route round the camera that gets aureoles
const MAX = 128;
const WARM = 'vec3(1.0, 0.66, 0.36)';

export function createLampGlow(app, heads) {
  const uGlowA = { value: 0 };   // aureole radiance at its centre (scene units)
  const geo = new THREE.PlaneGeometry(2, 2);   // xy in [-1, 1]
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false });
  mat.name = 'catenary.glow';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowA = uGlowA;
    shader.uniforms.uPxScale = SU.uPxScale;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uPxScale;
        varying vec2 vGlowP;
        varying float vGlowK;`)
      .replace('#include <project_vertex>', `
        // camera-facing quad round the instance origin (the bowl centre)
        vec4 mvC = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
        float gDist = max( -mvC.z, 0.05 );
        float gR = max( ${GLOW_R.toFixed(3)}, ${GLOW_PX.toFixed(1)} * uPxScale * gDist );
        vGlowK = ( ${GLOW_R.toFixed(3)} / gR ) * ( ${GLOW_R.toFixed(3)} / gR );
        mvC.xyz *= max( gDist - ${PULL.toFixed(3)}, 0.02 ) / gDist;
        vec4 mvPosition = mvC + vec4( position.xy * gR, 0.0, 0.0 );
        vGlowP = position.xy;
        gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uGlowA;
        varying vec2 vGlowP;
        varying float vGlowK;`)
      .replace('#include <opaque_fragment>', `
        {
          // radial profile (r = 1 at the quad's edge; the bowl rim lies near r 0.2): a
          // steep exponential skirt plus a faint inverse-square tail, zero at the edge
          float r = length( vGlowP );
          float edge = 1.0 - smoothstep( 0.4, 1.0, r );
          float g = ( 0.7 * exp( -r / 0.085 ) + 0.3 / ( 1.0 + r * r / 0.01 ) ) * edge * edge;
          vec3 c = ${WARM} * uGlowA * g * vGlowK * diffuseColor.rgb;
          gl_FragColor = vec4( c, 1.0 );
        }`);
  };
  mat.customProgramCacheKey = () => 'catGlow2';
  app.materials.register('catenary.glow', mat);

  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.name = 'catenary:glow';
  mesh.frustumCulled = false;    // instances are chosen per frame round the camera
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.renderOrder = 11;         // after the blended wires
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  // per-lamp strength (instance colour): each bowl a little different, as their glass
  const col = new Float32Array(MAX * 3).fill(1);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
  app.scene.add(mesh);

  const ss = heads.map((h) => h.s);
  const L = app.route.length;
  let shown = -1, lastS = NaN;
  return {
    mesh,
    /** Once per frame: the lamps within RANGE of the camera (no garbage). */
    update(sCam, lampOn) {
      if (!(lampOn > 0) || !heads.length) {
        if (shown !== 0) { mesh.count = 0; shown = 0; lastS = NaN; }
        return;
      }
      const ex = app.env && app.env.exposure > 0 ? app.env.exposure : 1;
      uGlowA.value = Math.min(lampOn * K, RIM_MAX / (RIM_G * ex));
      // the set only changes with the camera's route position
      if (Math.abs(sCam - lastS) < 0.5 && shown > 0) return;
      lastS = sCam;
      let a = app.route.wrap(sCam + RANGE[0]);
      let lo = 0, hi = ss.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ss[m] < a) lo = m + 1; else hi = m; }
      const span = RANGE[1] - RANGE[0], arr = mesh.instanceMatrix.array, ca = col;
      let n = 0;
      for (let k = 0; k < heads.length && n < MAX; k++) {
        const h = heads[(lo + k) % heads.length];
        let ds = h.s - a; if (ds < 0) ds += L;
        if (ds > span) break;
        const o = n * 16, p = h.position;
        arr[o] = 1; arr[o + 1] = 0; arr[o + 2] = 0; arr[o + 3] = 0;
        arr[o + 4] = 0; arr[o + 5] = 1; arr[o + 6] = 0; arr[o + 7] = 0;
        arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = 1; arr[o + 11] = 0;
        arr[o + 12] = p.x; arr[o + 13] = p.y; arr[o + 14] = p.z; arr[o + 15] = 1;
        const g = h.glow || 1;
        ca[n * 3] = g; ca[n * 3 + 1] = g; ca[n * 3 + 2] = g;
        n++;
      }
      mesh.count = n;
      shown = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, n * 3);
      mesh.instanceColor.needsUpdate = true;
    },
  };
}
