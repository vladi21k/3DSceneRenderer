import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

// Shader patches for the overhead line and lamp standards.
//  - thin(): opaque ironwork keeps at least ~uMinPx on screen by pushing vertices out
//    along the normal when the part (radius `aTube`) becomes sub-pixel. No breakup or
//    crawling dashes on far arms and poles; near geometry is untouched.
//  - wire material: camera-facing ribbons expanded in the vertex shader; width is the
//    real diameter or 1 px, whichever is larger, and alpha carries the true coverage, so
//    a 12 mm wire 300 m away is a faint continuous line instead of flickering pixels.
//  - lantern glass: opal bowl whose emission follows U.uNight.

// Shared screen metrics (updated once per frame by the catenary module).
export const SU = {
  uPxScale: { value: 0.001 },   // world metres per pixel per metre of distance
  uMinPx: { value: 0.85 },      // minimum on-screen width of thin opaque parts
  uWireMinPx: { value: 1.0 },   // minimum on-screen width of wires
};

export function updateScreenUniforms(app) {
  const cam = app.camera;
  const h = app.renderer.domElement.height || 1080;
  SU.uPxScale.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (h * (cam.zoom || 1));
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

/** Sub-pixel inflation for opaque thin parts (geometry must carry `aTube`). */
export function patchThin(mat) {
  if (mat.userData.catenaryThin) return mat;
  mat.userData.catenaryThin = true;
  return chain(mat, 'catThin', (shader) => {
    shader.uniforms.uPxScale = SU.uPxScale;
    shader.uniforms.uMinPx = SU.uMinPx;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTube;\nuniform float uPxScale;\nuniform float uMinPx;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec4 cwp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cwp = instanceMatrix * cwp;
        #endif
        cwp = modelMatrix * cwp;
        float cpx = length(cameraPosition - cwp.xyz) * uPxScale;
        float cneed = 0.5 * uMinPx * cpx - aTube;
        if (cneed > 0.0) transformed += normalize(objectNormal) * cneed;
      }`);
  });
}

/** Material for overhead wires (ribbons built by wires.js). */
export function makeWireMaterial() {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.65,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
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

/** Opal lantern glass: a private variant of the library 'glass.lamp' (whose emission
 *  follows U.uNight and the shared emissive gain), plus a brighter core where the bowl
 *  faces the eye, as a lit opal globe looks. */
export function makeGlassMaterial(M) {
  const m = M.get('glass.lamp', { catenaryLantern: true });
  return chain(m, 'catGlass', (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float facing = clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0);
          totalEmissiveRadiance *= 0.5 + 0.75 * facing * facing;
        }`);
  });
}

/** Fabric with wind billow for pole banners. Banner geometry carries aBanner =
 *  (u across 0..1 from the pole, v up 0..1, phase) and the face normal in `normal`.
 *  The billow is an analytic field, so normals follow it and the cloth shades like fabric. */
export function patchBanner(mat, size = [0.6, 1.6]) {
  return chain(mat, 'catBanner', (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.uniforms.uWindStrength = U.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aBanner;
        uniform float uTime;
        uniform vec2 uWind;
        uniform float uWindStrength;
        // displacement along the face normal: held by rods at top and bottom, the free
        // edge away from the pole billows most; push = wind component through the cloth
        float bannerDisp(float bu, float bv, float ph, float push) {
          float t = uTime;
          float gust = 0.6 + 0.4 * sin(t * 0.37 + ph * 3.1) * sin(t * 0.61 + ph);
          float belly = sin(3.14159 * bv) * (0.35 + 0.65 * bu);
          float ripple = sin(t * 2.7 + bu * 5.0 - bv * 2.2 + ph * 6.0) * 0.45 + sin(t * 4.3 + bu * 9.0 + bv * 4.0 + ph) * 0.2;
          return 0.32 * uWindStrength * gust * belly * (push * 0.8 + ripple);
        }`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        vec3 bN = normalize(objectNormal);
        float bPush = dot(normalize(vec3(uWind.x, 0.0, uWind.y)), normalize(mat3(modelMatrix) * bN));
        float bD = bannerDisp(aBanner.x, aBanner.y, aBanner.z, bPush);
        float bDu = (bannerDisp(aBanner.x + 0.02, aBanner.y, aBanner.z, bPush) - bD) / (0.02 * ${size[0].toFixed(3)});
        float bDv = (bannerDisp(aBanner.x, aBanner.y + 0.02, aBanner.z, bPush) - bD) / (0.02 * ${size[1].toFixed(3)});
        vec3 bTu = cross(bN, vec3(0.0, 1.0, 0.0)); // direction of increasing u (away from the pole)
        objectNormal = normalize(bN - bTu * bDu - vec3(0.0, 1.0, 0.0) * bDv);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed += bN * bD;
        transformed.y -= 0.1 * abs(bD);`);
  });
}
