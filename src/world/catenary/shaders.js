import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { GLASS_TOP, GLASS_BOTTOM } from './lantern.js';

// Shader patches for the overhead line and lamp standards.
//  - thin(): ironwork keeps at least ~uMinPx on screen by pushing vertices out along the
//    normal when the part (radius `aTube`) becomes sub-pixel; the widened part then
//    carries its true coverage in alpha (alpha-to-coverage under MSAA, rounded to whole
//    samples: some drivers dither fractional coverage over a screen-fixed 2x2 pixel
//    pattern, a checkerboard on the iron), so far filigree fades to a light haze instead
//    of heavy pen strokes. The same patch adds the paint
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
  uA2C: { value: 0 },           // MSAA samples of the scene target (0: none), for coverage rounding
};

// coverage alpha for alpha-to-coverage: whole samples (see header); 0 discards
const COVERAGE = /* glsl */ `
float catCoverage( float a ) {
  if ( uA2C < 0.5 ) return a;
  a = floor( a * uA2C + 0.5 ) / uA2C;
  if ( a <= 0.0 ) discard;
  return a;
}`;

// Lit bowl radiance at full night (scene units, roughly 3,500 cd/m² of opal glass round
// an LED lamp). From sunset on the lit globe is brighter than the sky behind it, through
// the camera's strong highlight compression at dusk: its core clips to a warm white with
// a bloom skirt (post), the falloff towards the rim keeps it warm.
export const LAMP_RADIANCE = 0.11;
// the hood underside reflects the lamp: a share of the bowl radiance (lower than the
// bowl itself, which would read as a second light source)
const HOOD_GLOW = 0.12;
const WARM = 'vec3(1.0, 0.66, 0.36)'; // ~2800 K lamp behind opal glass, linear (warm white)
const LIGHT_MIN_DIST = 1.0;            // m, see patchThin

export function updateScreenUniforms(app, lampRadiance = LAMP_RADIANCE) {
  const cam = app.camera;
  const h = app.renderer.domElement.height || 1080;
  SU.uPxScale.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (h * (cam.zoom || 1));
  // the street lamps' level is env's (env.state.lamps: the photocells switch them on before
  // sunset, fully on from t 0.72, then the night ramp holds them), so the globes, the real
  // lights, the lantern wash and the far pools come on together; the same ramp locally if
  // env is not running
  const st = app.env && app.env.state;
  const on = st && typeof st.lamps === 'number' ? st.lamps
    : Math.max(THREE.MathUtils.smoothstep(st ? st.t : 0, 0.64, 0.72), THREE.MathUtils.smoothstep(U.uNight.value, 0.02, 0.85));
  SU.uLamp.value = lampRadiance * on;
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
  return chain(mat, `catThin3${coverage ? 'C' : ''}${weather ? 'W' : ''}`, (shader) => {
    shader.uniforms.uPxScale = SU.uPxScale;
    shader.uniforms.uMinPx = SU.uMinPx;
    shader.uniforms.uLamp = SU.uLamp;
    shader.uniforms.uA2C = SU.uA2C;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aTube;
        attribute vec3 aWear;
        uniform float uPxScale;
        uniform float uMinPx;
        varying vec3 vWear;
        varying vec3 vLocal;
        varying float vInflate;
        varying float vSeed;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        // degenerate faces carry zero normals: keep the shading and the push finite
        if (dot(objectNormal, objectNormal) < 1e-12) objectNormal = vec3(0.0, 1.0, 0.0);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec4 cwp = vec4(transformed, 1.0);
        #ifdef USE_BATCHING
          cwp = batchingMatrix * cwp;
        #endif
        #ifdef USE_INSTANCING
          cwp = instanceMatrix * cwp;
        #endif
        cwp = modelMatrix * cwp;
        float chalf = 0.5 * uMinPx * length(cameraPosition - cwp.xyz) * uPxScale;
        float cneed = chalf - aTube;
        float cnl = length(objectNormal);
        if (cneed > 0.0 && cnl > 1e-6) transformed += (objectNormal / cnl) * cneed;
        vInflate = max(1.0, chalf / max(aTube, 1e-4));
        vWear = aWear;
        vLocal = position;
        // per-instance offset of the weathering noise, so no two poles rust alike
        vSeed = 0.0;
        #ifdef USE_BATCHING
          vSeed = fract(dot(batchingMatrix[3].xyz, vec3(0.1731, 0.0, 0.2913))) * 61.0;
        #endif
        #ifdef USE_INSTANCING
          vSeed = fract(dot(instanceMatrix[3].xyz, vec3(0.1731, 0.0, 0.2913))) * 61.0;
        #endif
      }`);
    shader.fragmentShader = shader.fragmentShader
      // local lights no closer than LIGHT_MIN_DIST: a lamp light standing in for both
      // lanterns of a standard sits between the bracket scrolls, which would glow white
      .replace('#include <lights_pars_begin>', THREE.ShaderChunk.lights_pars_begin.replace(
        'pow( lightDistance, decayExponent )', `pow( max( lightDistance, ${LIGHT_MIN_DIST.toFixed(2)} ), decayExponent )`))
      .replace('#include <common>', `#include <common>
        uniform float uLamp;
        uniform float uA2C;
        varying vec3 vWear;
        varying vec3 vLocal;
        varying float vInflate;
        varying float vSeed;
        ${NOISE}
        ${COVERAGE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float catRust = 0.0;
        ${weather ? `
        {
          // rust blooms where the weights allow (foot of the pole, collar edges, scroll
          // tips), with a darker lifted-paint halo; run-off streaks under the ledges.
          // Only some standards are rusting (about 3 in 10, by position): the others were
          // repainted and show little more than chips. Rust is a dark brown, its blooms
          // drawn out downwards into drips (noise stretched vertically).
          float poleH = fract(vSeed * 0.6180339 + 0.31);
          float rusty = smoothstep(0.66, 0.72, poleH);
          float w = vWear.x * mix(0.3, 1.0, rusty);
          vec3 q = vLocal * vec3(11.0, 3.2, 11.0) + vSeed;
          float n = 0.62 * catN(q) + 0.28 * catN(q * 2.7 + 3.1) + 0.1 * catN(q * 7.3);
          float on = step(0.02, w);
          float thr = 1.0 - 0.55 * w;
          catRust = smoothstep(thr, thr + 0.05, n) * on;
          float halo = smoothstep(thr - 0.09, thr, n) * on;
          // chipped paint showing the grey primer, around the rust and on worn edges
          float chip = smoothstep(0.76, 0.79, catN(q * 3.3 + 11.0)) * on * smoothstep(0.15, 0.6, w);
          vec3 rustCol = vec3(0.12, 0.06, 0.03) * (0.7 + 0.5 * catN(q * 4.1 + 7.0));
          diffuseColor.rgb *= 1.0 - 0.22 * halo;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.195, 0.18), chip * (1.0 - catRust));
          diffuseColor.rgb = mix(diffuseColor.rgb, rustCol, catRust);
          float ang = atan(vLocal.z, vLocal.x);
          float st = catN(vec3(ang * 9.0, vLocal.y * 1.6, 0.5 + vSeed)) * catN(vec3(ang * 23.0, vLocal.y * 0.7, 2.5 + vSeed));
          float run = vWear.y * smoothstep(0.12, 0.42, st);
          diffuseColor.rgb *= 1.0 - 0.3 * run;
          // on the rusting standards the run-off below collars and ledges is rust-stained
          diffuseColor.rgb = mix(diffuseColor.rgb, rustCol * 1.4, 0.35 * run * rusty);
        }` : ''}
        ${coverage ? 'diffuseColor.a = catCoverage(1.0 / vInflate);' : ''}`)
      .replace('#include <normal_fragment_begin>', `roughnessFactor = mix(roughnessFactor, 0.9, catRust);
        #include <normal_fragment_begin>`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // hood underside lit by its own lamp at night
        totalEmissiveRadiance += vWear.z * uLamp * ${HOOD_GLOW.toFixed(3)} * diffuseColor.rgb * ${WARM};`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        gl_FragColor.rgb = max(gl_FragColor.rgb, vec3(0.0));`);
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
  // the ribbons face the camera: one pass (a blended DoubleSide material is otherwise
  // drawn twice, re-evaluating its program each time)
  m.forceSinglePass = true;
  m.name = 'catenary.wire';
  return chain(m, coverage ? 'catWire3C' : 'catWire3', (shader) => {
    shader.uniforms.uPxScale = SU.uPxScale;
    shader.uniforms.uWireMinPx = SU.uWireMinPx;
    shader.uniforms.uA2C = SU.uA2C;
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
        // every direction below is guarded: a wire seen end-on (a dropper straight
        // above the eye, a span wire along the line of sight) has no screen-space side
        // or face direction, and a zero tangent (coincident points) none at all
        vec3 wc = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 wV = cameraPosition - wc;
        float wDist = max(length(wV), 1e-3);
        wV /= wDist;
        vec3 wT = mat3(modelMatrix) * aTan;
        float wtl = length(wT);
        wT = wtl > 1e-6 ? wT / wtl : vec3(0.0, 1.0, 0.0);
        vec3 wS = cross(wT, wV);
        float wsl = length(wS);
        if (wsl > 1e-4) wS /= wsl;
        else {
          wS = cross(wT, abs(wT.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
          wS /= max(length(wS), 1e-6);
        }
        float wPx = max(wDist * uPxScale, 1e-7);
        float wHalf = max(max(aWire.y, 0.5 * uWireMinPx * wPx), 1e-6);
        vCover = clamp(aWire.y / wHalf, 0.0, 1.0);
        vSide = aWire.x;
        vPxW = 2.0 * wHalf / wPx;
        vec3 wFace = wV - wT * dot(wV, wT);
        float wfl = length(wFace);
        wFace = wfl > 1e-4 ? wFace / wfl : cross(wS, wT);
        vec3 objectNormal = wS * aWire.x * 0.9 + wFace * 0.45;
        objectNormal /= max(length(objectNormal), 1e-6);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', `vec3 transformed = position + wS * (aWire.x * wHalf);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vCover;\nvarying float vSide;\nvarying float vPxW;\nuniform float uA2C;\n${COVERAGE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // analytic edge AA once the ribbon is several pixels wide
          float fw = max(fwidth(vSide), 1e-4);
          float edge = clamp((1.0 - abs(vSide)) / (fw * 1.2), 0.0, 1.0);
          diffuseColor.a = clamp(diffuseColor.a * vCover * mix(1.0, edge, smoothstep(2.0, 4.0, vPxW)), 0.0, 1.0);
          ${coverage ? 'diffuseColor.a = catCoverage(diffuseColor.a);' : ''}
        }`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        gl_FragColor.rgb = max(gl_FragColor.rgb, vec3(0.0));`);
  });
}

/** Lantern glass: a private variant of the library 'glass.lamp'. By day a clear prismatic
 *  bowl: smooth, fluted (normal perturbation), the dark hood interior and lamp socket
 *  showing through where we look straight in. At night an evenly lit warm diffuser at
 *  SU.uLamp. Geometry uv = (angle around the bowl axis, height below the hang point). */
export function makeGlassMaterial(M) {
  const m = M.get('glass.lamp', { catenaryLantern: true, color: [0.56, 0.55, 0.5], roughness: 0.1, emissive: [0, 0, 0], clearcoat: 0 });
  return chain(m, 'catGlass4', (shader) => {
    shader.uniforms.uLamp = SU.uLamp;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGlass;\nvarying vec3 vAxis;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGlass = uv;
        {
          vec3 ax = vec3(0.0, 1.0, 0.0);
          #ifdef USE_BATCHING
            ax = mat3(batchingMatrix) * ax;
          #endif
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
        // looking through the clear bowl: the shaded hood interior darkens the upper part,
        // the frosted lamp shows as a soft lighter core, the lower part passes the light
        // of the paving below
        float gBulb = exp(-pow((gY - 0.36) / 0.16, 2.0)) * gF * gF * gF;
        diffuseColor.rgb *= mix(1.0, 0.32, gF * gF * (1.0 - 0.85 * gY)) + 0.55 * gBulb;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // lit diffuser: brighter where it faces the eye and round the lamp in the upper
        // half of the bowl (a hot core under the strong highlight compression of dusk), a
        // dimmer warm rim
        totalEmissiveRadiance = uLamp * ${WARM} * (0.72 + 0.38 * gF) * (1.0 + 1.6 * exp(-pow((gY - 0.36) / 0.22, 2.0)) * gF * gF);`);
  });
}

/** Fabric with wind billow for pole banners. Banner geometry carries aBanner =
 *  (u across 0..1 from the pole, v up 0..1, phase) and the face normal in `normal`.
 *  Instanced / batched banners carry per-instance data in the instance colour instead of
 *  a tint: r = wind phase, g = print cell (design index), b = sun fading (0 fresh, 1 the
 *  dyes washed out towards a pale warm grey).
 *  The billow is an analytic field, so normals follow it and the cloth shades like fabric;
 *  the sun shining through the cloth from behind adds a diffuse back-light. */
export function patchBanner(mat, size = [0.6, 1.6], cells = 4) {
  return chain(mat, 'catBanner4', (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.uniforms.uWindStrength = U.uWindStrength;
    shader.uniforms.uSunDir = U.uSunDir;
    shader.uniforms.uSunColor = U.uSunColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aBanner;
        uniform float uTime;
        uniform vec2 uWind;
        uniform float uWindStrength;
        varying vec3 vBackN;
        varying float vBannerFade;
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
      .replace('#include <color_pars_vertex>', `#include <color_pars_vertex>
        // per-instance data (see above)
        vec4 bannerData() {
          #if defined( USE_BATCHING_COLOR )
            return getBatchingColor( getIndirectIndex( gl_DrawID ) );
          #elif defined( USE_INSTANCING_COLOR )
            return vec4( instanceColor, 1.0 );
          #else
            return vec4( 0.0 );
          #endif
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        float bPh = aBanner.z + bannerData().r;
        vBannerFade = bannerData().b;
        vec3 bN = normalize(objectNormal);
        mat3 bM = mat3(modelMatrix);
        #ifdef USE_BATCHING
          bM = bM * mat3(batchingMatrix);
        #endif
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
        #ifdef USE_MAP
          vMapUv.x += bannerData().g / ${cells.toFixed(1)};
        #endif`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        #if defined(USE_INSTANCING_COLOR) || defined(USE_BATCHING_COLOR)
          vColor = vec4(1.0); // instance colour holds data, not a tint
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
        #endif
        {
          // sun-faded dyes: towards a pale, slightly warm grey
          float bL = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(bL) * vec3(1.03, 1.0, 0.95) + 0.035, vBannerFade);
        }`)
      .replace('#include <common>', `#include <common>
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        varying vec3 vBackN;
        varying float vBannerFade;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          // thin printed fabric: sunlight from behind the visible face glows through
          vec3 nW = normalize(vBackN) * (gl_FrontFacing ? 1.0 : -1.0);
          float back = max(0.0, -dot(nW, normalize(uSunDir)));
          reflectedLight.directDiffuse += 0.25 * back * uSunColor * BRDF_Lambert(diffuseColor.rgb);
        }`);
  });
}
