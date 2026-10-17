import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { GLASS_TOP, GLASS_BOTTOM } from './lantern.js';

// Shader patches for the overhead line and lamp standards.
//  - thin(): ironwork keeps at least ~uMinPx on screen by pushing vertices out along the
//    normal when the part (radius `aTube`) becomes sub-pixel; the widened part then
//    carries its true coverage in alpha (alpha-to-coverage under MSAA), so far filigree
//    fades to a light haze instead of heavy pen strokes. The same patch adds the paint
//    weathering (rust blooms, run-off streaks; weights in `aWear`) and the lamp-lit glow
//    of the lantern hood underside at night.
//  - wire material: camera-facing ribbons expanded in the vertex shader; width is the
//    real diameter or 1 px, whichever is larger, and alpha carries the true coverage, so
//    a 12 mm wire 300 m away is a faint continuous line instead of flickering pixels.
//    Rendered opaque with alpha-to-coverage when the frame is multisampled, so near
//    wires are solid and in the depth buffer (AO, depth of field and haze see them).
//  - lantern glass: clear prismatic acorn bowl by day, evenly lit warm diffuser at night.

// Shared uniforms (updated once per frame by the catenary module).
export const SU = {
  uPxScale: { value: 0.001 },   // world metres per pixel per metre of distance
  uMinPx: { value: 0.75 },      // minimum on-screen width of thin opaque parts
  uWireMinPx: { value: 1.0 },   // minimum on-screen width of wires
  uLamp: { value: 0 },          // radiance of a lit lantern bowl (scene units)
};

// Lit bowl radiance at full night (scene units). Dusk exposure is about three orders of
// magnitude above midday, so this keeps the opal bowl a bright warm cream after tone
// mapping instead of a clipped white disc.
export const LAMP_RADIANCE = 0.0085;
const WARM = 'vec3(1.0, 0.72, 0.45)'; // ~2900 K, linear

export function updateScreenUniforms(app, lampRadiance = LAMP_RADIANCE) {
  const cam = app.camera;
  const h = app.renderer.domElement.height || 1080;
  SU.uPxScale.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (h * (cam.zoom || 1));
  SU.uLamp.value = lampRadiance * THREE.MathUtils.smoothstep(U.uNight.value, 0.02, 0.85);
}

function chain(mat, key, fn) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    fn(shader, renderer);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|' + key;
  mat.needsUpdate = true;
  return mat;
}

// small 3D value noise for the weathering masks
const NOISE = /* glsl */ `
float catH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float catN(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(catH(i), catH(i + vec3(1, 0, 0)), f.x), mix(catH(i + vec3(0, 1, 0)), catH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(catH(i + vec3(0, 0, 1)), catH(i + vec3(1, 0, 1)), f.x), mix(catH(i + vec3(0, 1, 1)), catH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

/** Sub-pixel inflation, weathering and lamp glow for the ironwork (geometry must carry
 *  `aTube` and `aWear`). opts.coverage: write coverage to alpha (alpha-to-coverage). */
export function patchThin(mat, { coverage = false, weather = true } = {}) {
  if (mat.userData.catenaryThin) return mat;
  mat.userData.catenaryThin = true;
  mat.alphaToCoverage = coverage;
  return chain(mat, `catThin${coverage ? 'C' : ''}${weather ? 'W' : ''}`, (shader) => {
    shader.uniforms.uPxScale = SU.uPxScale;
    shader.uniforms.uMinPx = SU.uMinPx;
    shader.uniforms.uLamp = SU.uLamp;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aTube;
        attribute vec3 aWear;
        uniform float uPxScale;
        uniform float uMinPx;
        varying vec3 vWear;
        varying vec3 vLocal;
        varying float vInflate;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec4 cwp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cwp = instanceMatrix * cwp;
        #endif
        cwp = modelMatrix * cwp;
        float chalf = 0.5 * uMinPx * length(cameraPosition - cwp.xyz) * uPxScale;
        float cneed = chalf - aTube;
        if (cneed > 0.0) transformed += normalize(objectNormal) * cneed;
        vInflate = max(1.0, chalf / max(aTube, 1e-4));
        vWear = aWear;
        vLocal = position;
      }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uLamp;
        varying vec3 vWear;
        varying vec3 vLocal;
        varying float vInflate;
        ${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float catRust = 0.0;
        ${weather ? `
        {
          // rust blooms where the weights allow (foot of the pole, collar edges, scroll
          // tips), with a darker lifted-paint halo; run-off streaks under the ledges
          vec3 q = vLocal * 11.0;
          float n = 0.62 * catN(q) + 0.28 * catN(q * 2.7 + 3.1) + 0.1 * catN(q * 7.3);
          float thr = 1.0 - 0.46 * vWear.x;
          catRust = smoothstep(thr, thr + 0.05, n) * step(0.02, vWear.x);
          float halo = smoothstep(thr - 0.09, thr, n) * step(0.02, vWear.x);
          vec3 rustCol = vec3(0.17, 0.075, 0.035) * (0.65 + 0.7 * catN(q * 4.1 + 7.0));
          diffuseColor.rgb *= 1.0 - 0.22 * halo;
          diffuseColor.rgb = mix(diffuseColor.rgb, rustCol, catRust);
          float ang = atan(vLocal.z, vLocal.x);
          float st = catN(vec3(ang * 9.0, vLocal.y * 1.6, 0.5)) * catN(vec3(ang * 23.0, vLocal.y * 0.7, 2.5));
          diffuseColor.rgb *= 1.0 - 0.3 * vWear.y * smoothstep(0.12, 0.42, st);
        }` : ''}
        ${coverage ? 'diffuseColor.a = 1.0 / vInflate;' : ''}`)
      .replace('#include <normal_fragment_begin>', `roughnessFactor = mix(roughnessFactor, 0.9, catRust);
        #include <normal_fragment_begin>`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // hood underside lit by its own lamp at night
        totalEmissiveRadiance += vWear.z * uLamp * 0.5 * diffuseColor.rgb * ${WARM};`);
  });
}

/** Material for overhead wires (ribbons built by wires.js). coverage: opaque with
 *  alpha-to-coverage (multisampled frames); otherwise alpha-blended. */
export function makeWireMaterial(coverage = false) {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.65, side: THREE.DoubleSide,
  });
  if (coverage) m.alphaToCoverage = true;
  else { m.transparent = true; m.depthWrite = false; }
  m.name = 'catenary.wire';
  return chain(m, 'catWire', (shader) => {
    shader.uniforms.uPxScale = SU.uPxScale;
    shader.uniforms.uWireMinPx = SU.uWireMinPx;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aTan;
        attribute vec2 aWire;   // x: side (-1 / +1), y: true radius (m)
        uniform float uPxScale;
        uniform float uWireMinPx;
        varying float vCover;
        varying float vSide;
        varying float vPxW;`)
      .replace('#include <beginnormal_vertex>', `
        vec3 wc = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 wV = cameraPosition - wc;
        float wDist = max(length(wV), 1e-3);
        wV /= wDist;
        vec3 wT = normalize(mat3(modelMatrix) * aTan);
        vec3 wS = cross(wT, wV);
        float wsl = length(wS);
        wS = wsl > 1e-4 ? wS / wsl : normalize(cross(wT, vec3(0.0, 1.0, 0.0)));
        float wPx = wDist * uPxScale;
        float wHalf = max(aWire.y, 0.5 * uWireMinPx * wPx);
        vCover = clamp(aWire.y / wHalf, 0.0, 1.0);
        vSide = aWire.x;
        vPxW = 2.0 * wHalf / wPx;
        vec3 wFace = normalize(wV - wT * dot(wV, wT));
        vec3 objectNormal = normalize(wS * aWire.x * 0.9 + wFace * 0.45);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = position + wS * (aWire.x * wHalf);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCover;\nvarying float vSide;\nvarying float vPxW;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // analytic edge AA once the ribbon is several pixels wide
          float fw = max(fwidth(vSide), 1e-4);
          float edge = clamp((1.0 - abs(vSide)) / (fw * 1.2), 0.0, 1.0);
          diffuseColor.a *= vCover * mix(1.0, edge, smoothstep(2.0, 4.0, vPxW));
        }`);
  });
}

/** Lantern glass: a private variant of the library 'glass.lamp'. By day a clear prismatic
 *  bowl: smooth, fluted (normal perturbation), the dark hood interior and lamp socket
 *  showing through where we look straight in. At night an evenly lit warm diffuser at
 *  SU.uLamp. Geometry uv = (angle around the bowl axis, height below the hang point). */
export function makeGlassMaterial(M) {
  const m = M.get('glass.lamp', { catenaryLantern: true, color: [0.4, 0.385, 0.34], roughness: 0.15, emissive: [0, 0, 0] });
  return chain(m, 'catGlass2', (shader) => {
    shader.uniforms.uLamp = SU.uLamp;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGlass;\nvarying vec3 vAxis;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGlass = uv;
        {
          vec3 ax = vec3(0.0, 1.0, 0.0);
          #ifdef USE_INSTANCING
            ax = mat3(instanceMatrix) * ax;
          #endif
          vAxis = normalize(mat3(viewMatrix) * (mat3(modelMatrix) * ax));
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uLamp;
        varying vec2 vGlass;
        varying vec3 vAxis;`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          // 24 vertical prisms around the bowl
          vec3 tA = cross(normalize(vAxis), normal);
          float tl = length(tA);
          if (tl > 1e-3) normal = normalize(normal + (tA / tl) * 0.24 * sin(24.0 * vGlass.x));
        }
        float gF = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
        float gY = clamp((vGlass.y - (${GLASS_TOP.toFixed(3)})) / (${(GLASS_BOTTOM - GLASS_TOP).toFixed(3)}), 0.0, 1.0); // 0 top .. 1 tip
        // looking through the clear bowl: shaded hood interior and the lamp socket
        diffuseColor.rgb *= mix(1.0, 0.3, gF * gF * (1.0 - 0.45 * gY));`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // lit diffuser: nearly even, a little brighter where it faces the eye and around
        // the lamp in the upper half of the bowl
        totalEmissiveRadiance = uLamp * ${WARM} * (0.85 + 0.3 * gF) * (1.0 + 0.3 * exp(-pow((gY - 0.35) / 0.22, 2.0)) * gF);`);
  });
}

/** Fabric with wind billow for pole banners. Banner geometry carries aBanner =
 *  (u across 0..1 from the pole, v up 0..1, phase) and the face normal in `normal`.
 *  Instanced banners take the phase from instance attribute aPhase instead.
 *  The billow is an analytic field, so normals follow it and the cloth shades like fabric;
 *  the sun shining through the cloth from behind adds a diffuse back-light. */
export function patchBanner(mat, size = [0.6, 1.6], cells = 4) {
  return chain(mat, 'catBanner2', (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.uniforms.uWindStrength = U.uWindStrength;
    shader.uniforms.uSunDir = U.uSunDir;
    shader.uniforms.uSunColor = U.uSunColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aBanner;
        #ifdef USE_INSTANCING
          attribute float aPhase;
          attribute float aDesign;
        #endif
        uniform float uTime;
        uniform vec2 uWind;
        uniform float uWindStrength;
        varying vec3 vBackN;
        // displacement along the face normal: held by rods at top and bottom, the free
        // edge away from the pole billows most; push = wind component through the cloth
        float bannerDisp(float bu, float bv, float ph, float push) {
          float t = uTime;
          float w = max(uWindStrength, 0.18);
          float gust = 0.6 + 0.4 * sin(t * 0.37 + ph * 3.1) * sin(t * 0.61 + ph);
          float belly = sin(3.14159 * bv) * (0.3 + 0.7 * bu);
          float ripple = sin(t * 2.7 + bu * 5.0 - bv * 2.2 + ph * 6.0) * 0.45 + sin(t * 4.3 + bu * 9.0 + bv * 4.0 + ph) * 0.2;
          return 0.45 * w * gust * belly * (push * 0.8 + ripple);
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        float bPh = aBanner.z;
        #ifdef USE_INSTANCING
          bPh += aPhase;
        #endif
        vec3 bN = normalize(objectNormal);
        mat3 bM = mat3(modelMatrix);
        #ifdef USE_INSTANCING
          bM = bM * mat3(instanceMatrix);
        #endif
        float bPush = dot(normalize(vec3(uWind.x, 0.0, uWind.y)), normalize(bM * bN));
        float bD = bannerDisp(aBanner.x, aBanner.y, bPh, bPush);
        float bDu = (bannerDisp(aBanner.x + 0.02, aBanner.y, bPh, bPush) - bD) / (0.02 * ${size[0].toFixed(3)});
        float bDv = (bannerDisp(aBanner.x, aBanner.y + 0.02, bPh, bPush) - bD) / (0.02 * ${size[1].toFixed(3)});
        vec3 bTu = vec3(-1.0, 0.0, 0.0); // direction of increasing u (away from the pole)
        objectNormal = normalize(bN - bTu * bDu - vec3(0.0, 1.0, 0.0) * bDv);
        vBackN = normalize(bM * objectNormal);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += bN * bD;
        transformed.y -= 0.1 * abs(bD);`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        #if defined(USE_INSTANCING) && defined(USE_MAP)
          vMapUv.x += aDesign / ${cells.toFixed(1)};
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
        {
          // printed through: the back face reads the right way round too
          vec2 bUv = vMapUv;
          float bCell = floor(bUv.x * ${cells.toFixed(1)});
          if (!gl_FrontFacing) bUv.x = (2.0 * bCell + 1.0) / ${cells.toFixed(1)} - bUv.x;
          diffuseColor *= texture2D(map, bUv);
        }
        #endif`)
      .replace('#include <common>', `#include <common>
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        varying vec3 vBackN;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          // thin printed fabric: sunlight from behind the visible face glows through
          vec3 nW = normalize(vBackN) * (gl_FrontFacing ? 1.0 : -1.0);
          float back = max(0.0, -dot(nW, normalize(uSunDir)));
          reflectedLight.directDiffuse += 0.25 * back * uSunColor * BRDF_Lambert(diffuseColor.rgb);
        }`);
  });
}
