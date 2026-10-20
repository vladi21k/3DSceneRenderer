import * as THREE from 'three';
import { SU } from './shaders.js';

// Aureole round the lit lantern bowls (from the photocell ramp before sunset on): the
// light the opal bowl and the dusty evening air scatter just around a bright source, the
// soft skirt a camera shows round every street lamp at dusk. One camera-facing quad per
// lamp near the camera (one instanced draw, no shadows), added to the HDR scene so the
// exposure, white balance and post's bloom treat it like the bowl itself.
//
// Size and strength follow a camera's glare, not a fixed size in metres: the skirt falls
// off over a few pixels outside the bowl's rim (HALO_PX wide, plus a little more round a
// near bowl), and its brightness follows the light the bowl sends to the camera, its area
// on screen (relative to a bowl at about 15 m through the default lens, REF_PX), so a near
// lamp keeps a crisp, hot bowl inside a bright skirt and a far one is a small hot point
// with a faint halo. The hood shades the skirt above the brim: its dark cone and cap stay
// readable against the glow (the quad sits PULL m in front of the bowl centre, in front of
// the brim, so the hood's outline is cut out of it in the shader). The quad is depth
// tested against the scene, so poles, people and leaves in front cover it.
// Strength at the bowl's rim: K bowl radiances (uLamp), held under RIM_MAX of white
// (env.exposure): in the dark the clipped bowl would otherwise drag a bright disc with it.
// Post's bloom adds the wider lens skirt on top.

const BOWL_R = 0.155;    // m, the bowl's radius
const HALO_PX = 30;      // px of skirt outside a far bowl's rim
const REF_PX = 36;       // px, bowl radius of the reference lamp (15 m, 17° lens)
const PULL = 0.32;       // m towards the camera
const K = 0.06;          // skirt radiance at the bowl's rim, in bowl radiances (uLamp)
const RIM_MAX = 0.4;     // highest display value (white = 1) of the aureole at the rim
const RANGE = [-25, 330];  // m of route round the camera that gets aureoles
const MAX = 128;
const WARM = 'vec3(1.0, 0.62, 0.33)';  // ~3000 K

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
        varying vec3 vGlowK;`)
      .replace('#include <project_vertex>', `
        // camera-facing quad round the instance origin (the bowl centre), sized in pixels
        vec4 mvC = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
        float gDist = max( -mvC.z, 0.05 );
        float pxM = max( uPxScale * gDist, 1e-6 );          // metres per pixel at the bowl
        float bowlPx = ${BOWL_R.toFixed(3)} / pxM;
        float gRpx = ${HALO_PX.toFixed(1)} + 1.6 * bowlPx;
        float pullK = max( gDist - ${PULL.toFixed(3)}, 0.02 ) / gDist;
        mvC.xyz *= pullK;
        vec4 mvPosition = mvC + vec4( position.xy * gRpx * pxM * pullK, 0.0, 0.0 );
        vGlowP = position.xy * gRpx;                         // pixels from the bowl centre
        vGlowK = vec3( min( ( bowlPx / ${REF_PX.toFixed(1)} ) * ( bowlPx / ${REF_PX.toFixed(1)} ), 1.6 ), bowlPx, pxM );
        gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uGlowA;
        varying vec2 vGlowP;
        varying vec3 vGlowK;`)
      .replace('#include <opaque_fragment>', `
        {
          // skirt: steep over the first pixels outside the rim, a faint wider tail, zero at
          // the quad's edge
          float bowlPx = vGlowK.y;
          float rpx = length( vGlowP );
          float e = max( rpx - bowlPx, 0.0 );
          float g = 0.62 * exp( -e / ( 4.0 + 0.12 * bowlPx ) ) + 0.38 / ( 1.0 + e * e / ( 90.0 + 2.0 * bowlPx * bowlPx ) );
          g *= 1.0 - smoothstep( 0.6, 1.0, rpx / ( ${HALO_PX.toFixed(1)} + 1.6 * bowlPx ) );
          // (over the bowl itself the skirt fades out: its body keeps its own warm colour)
          g *= smoothstep( 0.55 * bowlPx, bowlPx, rpx );
          // the hood (brim, cone, drum, cap above the bowl centre) cut out of the skirt
          vec2 m = vGlowP * vGlowK.z;
          float hr = m.y < 0.13 ? 0.3 : m.y < 0.24 ? mix( 0.3, 0.17, ( m.y - 0.13 ) / 0.11 ) : 0.135;
          float hood = smoothstep( 0.075, 0.1, m.y ) * ( 1.0 - smoothstep( hr - 0.015, hr + 0.01, abs( m.x ) ) ) * ( 1.0 - smoothstep( 0.42, 0.46, m.y ) );
          g *= 1.0 - 0.9 * hood;
          vec3 c = ${WARM} * uGlowA * g * vGlowK.x * diffuseColor.rgb;
          gl_FragColor = vec4( c, 1.0 );
        }`);
  };
  mat.customProgramCacheKey = () => 'catGlow3';
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
      if (!app.ready) {
        // start-up: one dark instance far below the street, so the program has its first
        // draw behind the loading screen (a first draw when the lamps come on would stall
        // a frame mid-ride)
        if (shown !== -2) {
          mesh.instanceMatrix.array.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1e4, 0, 1]);
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceMatrix.needsUpdate = true;
          mesh.count = 1;
          shown = -2;
          lastS = NaN;
        }
        uGlowA.value = 0;
        return;
      }
      if (!(lampOn > 0) || !heads.length) {
        if (shown !== 0) { mesh.count = 0; shown = 0; lastS = NaN; }
        return;
      }
      const ex = app.env && app.env.exposure > 0 ? app.env.exposure : 1;
      uGlowA.value = Math.min(lampOn * K, RIM_MAX / ex);
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
