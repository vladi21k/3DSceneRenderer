import * as THREE from 'three';
import { ATMO_GLSL } from './atmosphere.js';

// Volumetric fair-weather cumulus. A slab from CB metres up (uCloudTop thick) is
// ray-marched at half resolution after the main pass (only where the sky is visible),
// lit by the sun with self-shadowing and a multiple-scattering approximation, and
// composited over the sky in the post prepass. Shapes come from the 2D cloud field in
// sky.js (where the clouds are) and a tileable 3D Perlin-Worley texture (their billows).
// The weather (coverage, cell size, depth) is a per-seed regime chosen by env.js.

const CB = 1500.0;

const NOISE3D_FS = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uLayer;
uniform float uSize;
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float worley3(vec3 x, float P) {
  vec3 i = floor(x), f = fract(x);
  float m = 9.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    vec3 o = vec3(float(xx), float(y), float(z));
    vec3 r = o + hash33(mod(i + o, P)) - f;
    m = min(m, dot(r, r));
  }
  return sqrt(m);
}
float gnoise3(vec3 x, float P) {
  vec3 i = floor(x), f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n = 0.0;
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 g = hash33(mod(i + o, P)) * 2.0 - 1.0;
    float v = dot(g, f - o);
    vec3 w = mix(1.0 - u, u, o);
    n += v * w.x * w.y * w.z;
  }
  return n;
}
void main() {
  vec3 p = vec3(vUv, (uLayer + 0.5) / uSize);
  // R: Perlin-Worley billows
  float pf = gnoise3(p * 4.0, 4.0) * 0.5 + gnoise3(p * 8.0, 8.0) * 0.25 + gnoise3(p * 16.0, 16.0) * 0.125;
  pf = pf * 0.9 + 0.5;
  float wf = 1.0 - (worley3(p * 4.0, 4.0) * 0.625 + worley3(p * 8.0, 8.0) * 0.25 + worley3(p * 16.0, 16.0) * 0.125);
  float pw = clamp((pf - (1.0 - wf)) / max(wf, 1e-3), 0.0, 1.0);
  // G: Worley fbm for edge erosion (finest octave 4 texels per cell, so it does not alias)
  float d = 1.0 - (worley3(p * 4.0 + 0.5, 4.0) * 0.6 + worley3(p * 8.0 + 0.5, 8.0) * 0.27 + worley3(p * 16.0 + 0.5, 16.0) * 0.13);
  gl_FragColor = vec4(clamp(mix(pw, wf, 0.35) * 1.15 - 0.08, 0.0, 1.0), clamp(d * 1.2 - 0.15, 0.0, 1.0), 0.0, 1.0);
}
`;

/** Tileable 3D noise target and the pass that fills it (rendered by renderNoise3D). */
function makeNoise3D(size = 64) {
  const rt = new THREE.WebGL3DRenderTarget(size, size, size, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  const tex = rt.texture;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: NOISE3D_FS, uniforms: { uLayer: { value: 0 }, uSize: { value: size } }, depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  return { rt, quad, size };
}

function renderNoise3D(renderer, { rt, quad, size }) {
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  for (let z = 0; z < size; z++) {
    quad.material.uniforms.uLayer.value = z;
    renderer.setRenderTarget(rt, z);
    renderer.render(quad, cam);
  }
  renderer.setRenderTarget(prev);
  quad.material.dispose(); quad.geometry.dispose();
}

/**
 * Shared cloud GLSL (view pass and environment capture). The includer declares the
 * uniforms uCloudTex, uNoise3D, uCloudOffset, uCloudCover, uCloudScale, uCloudTop,
 * uSunDirA, uSunCloud and defines skyL(dir) and irr(k) (sky-view LUT and sky-irradiance
 * lookups).
 */
export const CLOUD_MARCH_GLSL = /* glsl */ `
#define CB ${CB.toFixed(1)}
#define CLOUD_SIGMA 0.045     // extinction per metre at density 1
#define MS_BOOST 1.9

float cloudDensity(vec3 p, float detail) {
  float hf = (p.y - CB) / uCloudTop;
  if (hf <= 0.0 || hf >= 1.0 || uCloudCover <= 0.0) return 0.0;
  vec2 q = p.xz + uCloudOffset;
  // regional coverage over ~30 km and ~11 km (two octaves): clear gaps and denser fields
  float cv = 0.6 * textureLod(uCloudTex, q / 31000.0, 0.0).b + 0.4 * textureLod(uCloudTex, q / 11000.0 + 0.43, 0.0).b;
  float cov = clamp(uCloudCover + (cv - 0.5) * 0.7, 0.0, 0.92);
  // where the cells are (2D field; a smaller scale gives a field of many small cumulus):
  // two cell sizes, the second turned against the first, both domain-warped by ~1 km,
  // so neither the size nor the spacing of the cells repeats; 3D billows mixed in so
  // cells stay contiguous
  vec2 wq = (vec2(textureLod(uCloudTex, q / 17000.0 + 0.27, 0.0).b, textureLod(uCloudTex, q / 17000.0 + 0.71, 0.0).b) - 0.5) * 2400.0 * uCloudScale;
  const mat2 R37 = mat2(0.7986, 0.6018, -0.6018, 0.7986);
  float field = mix(textureLod(uCloudTex, (q + wq) / (13000.0 * uCloudScale), 0.0).r,
                    textureLod(uCloudTex, R37 * (q - wq) / (22000.0 * uCloudScale) + 0.37, 0.0).r, 0.4);
  field = clamp(0.5 + (field - 0.5) * 1.35, 0.0, 1.0);   // (the blend of two fields is flatter)
  vec4 n = textureLod(uNoise3D, vec3(q.x, p.y * 1.4, q.y) / (4500.0 * uCloudScale), 0.0);
  float shape = field * 0.72 + n.r * 0.28;
  // flat bases, domed tops: the threshold rises with height, so only the cores reach up
  float thr = 1.0 - cov * sqrt(max(1.0 - hf, 0.0)) * smoothstep(0.0, 0.05, hf);
  // dense bodies: the density saturates over the outer part of each cell, so the
  // erosion below carves the boundary into billows and wisps instead of hollowing it
  float d = clamp((shape - thr) / max(0.22 * (1.0 - thr), 1e-3), 0.0, 1.0);
  // fair-weather cumulus come in fields: where the regional coverage is too thin to make
  // a group, or the cell field around this cell (blurred over ~300 m) stays well under
  // the threshold, the odd cell that still pokes over it (a lone round puff) fades
  float grp = mix(textureLod(uCloudTex, (q + wq) / (13000.0 * uCloudScale), 4.5).r,
                  textureLod(uCloudTex, R37 * (q - wq) / (22000.0 * uCloudScale) + 0.37, 4.5).r, 0.4);
  grp = clamp(0.5 + (grp - 0.5) * 1.35, 0.0, 1.0) * 0.72 + 0.14;
  d *= smoothstep(0.24, 0.36, cov) * smoothstep(thr - 0.1, thr - 0.03, grp);
  if (d <= 0.0 || detail <= 0.0) return d;
  // cauliflower edges: billowy Worley erosion, strongest at the base, plus a finer
  // octave that frays the rims into wisps
  float e = textureLod(uNoise3D, vec3(q.x, p.y, q.y) / 520.0 + vec3(0.37, 0.11, 0.73), 0.0).g;
  float ero = (1.0 - e) * mix(0.58, 0.34, hf) * detail;
  if (detail > 0.75) {
    float e2 = textureLod(uNoise3D, vec3(q.x, p.y * 1.3, q.y) / 150.0 + vec3(0.71, 0.29, 0.13), 0.0).g;
    ero += (1.0 - e2) * 0.3 * (1.0 - 0.6 * d);
  }
  return clamp((d - ero) / max(1.0 - ero, 1e-3), 0.0, 1.0);
}

// March the cumulus slab along dir from ro: rgb = in-scattered radiance (with the
// aerial-perspective fade towards the sky colour), a = transmittance.
// nSteps <= 64; lightTaps 2 (environment capture) or 4 (view).
vec4 cloudMarch(vec3 ro, vec3 dir, float jit, int nSteps, int lightTaps, float detail) {
  if (dir.y < 0.003) return vec4(0.0, 0.0, 0.0, 1.0);
  if (uCloudCover <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = (CB - ro.y) / dir.y, t1 = (CB + uCloudTop - ro.y) / dir.y;
  const float TMAX = 45000.0;
  if (t0 > TMAX) return vec4(0.0, 0.0, 0.0, 1.0);
  t1 = min(t1, TMAX);
  float dt = (t1 - t0) / float(nSteps);

  // sunlight at cloud level: it still lights the cloud bases from below for a while
  // after it has left the street
  vec3 sunL = uSunCloud;
  vec3 ambTop = irr(0.0) / ATM_PI * 1.15;
  vec3 ambBot = (uSunCloud * max(uSunDirA.y + 0.035, 0.0) * 0.1 + irr(0.0) * 0.2) / ATM_PI;
  // in twilight the multiply scattered skylight keeps a cloud about as bright as the sky
  // around it (it never reads as a dark blob against the glow)
  float twl = 1.0 - smoothstep(-0.01, 0.12, uSunDirA.y);
  vec3 skyHere = skyL(dir);
  ambTop = mix(ambTop, max(ambTop, skyHere * 1.1), twl);
  ambBot = mix(ambBot, max(ambBot, skyHere * 0.8), twl);
  float cosT = dot(dir, uSunDirA);
  // dual-lobe phase (bright silver lining towards the sun), and two softer lobes for
  // the multiple-scattering octaves
  float ph0 = mix(atmPhaseHG(cosT, 0.8), atmPhaseHG(cosT, -0.25), 0.3);
  float ph1 = mix(atmPhaseHG(cosT, 0.38), atmPhaseHG(cosT, -0.12), 0.35);
  float ph2 = atmPhaseHG(cosT, 0.1);
  vec3 lsd = normalize(uSunDirA + vec3(0.0, 0.08, 0.0));

  vec3 L = vec3(0.0);
  float T = 1.0, tw = 0.0, tsum = 0.0;
  for (int i = 0; i < 64; i++) {
    if (i >= nSteps) break;
    float t = t0 + (float(i) + jit) * dt;
    vec3 p = ro + dir * t;
    float d = cloudDensity(p, detail);
    if (d <= 0.002) continue;
    float sig = d * CLOUD_SIGMA;
    // optical depth towards the sun
    float tau;
    if (lightTaps >= 4) {
      tau = cloudDensity(p + lsd * 60.0, 0.6 * detail) * 60.0
          + cloudDensity(p + lsd * 200.0, 0.4 * detail) * 140.0
          + cloudDensity(p + lsd * 480.0, 0.0) * 280.0
          + cloudDensity(p + lsd * 1000.0, 0.0) * 520.0;
    } else {
      tau = cloudDensity(p + lsd * 120.0, 0.0) * 160.0 + cloudDensity(p + lsd * 600.0, 0.0) * 700.0;
    }
    tau *= CLOUD_SIGMA;
    float hf = clamp((p.y - CB) / uCloudTop, 0.0, 1.0);
    float powder = 1.0 - exp(-sig * 160.0);
    // sun: single scattering plus two multiple-scattering octaves (wider, less attenuated)
    // (flat bases read grey: the light reaching them has crossed the cell, which the four
    // shadow taps under-count for the small cells)
    float base = mix(0.6, 1.0, smoothstep(0.0, 0.35, hf));
    vec3 S = sunL * (exp(-tau) * ph0 + 0.5 * exp(-tau * 0.25) * ph1 + 0.25 * exp(-tau * 0.07) * ph2) * mix(1.0, powder, 0.5) * MS_BOOST * base
           + mix(ambBot, ambTop, smoothstep(0.0, 0.8, hf)) * (0.55 + 0.45 * hf);
    float sT = exp(-sig * dt);
    // energy-conserving integration of the in-scatter over the step (albedo ~1)
    L += T * S * (1.0 - sT);
    tsum += T * (1.0 - sT) * t; tw += T * (1.0 - sT);
    T *= sT;
    if (T < 0.015) break;
  }
  // the march stops once nearly opaque: treat that as opaque (the sun disc is ~10^4
  // times brighter than the cloud and would otherwise show through)
  if (T < 0.015) T = 0.0;
  // aerial perspective: far clouds sink into the sky colour
  float tAvg = tw > 1e-4 ? tsum / tw : t0;
  float fade = exp(-tAvg / 26000.0) * smoothstep(0.003, 0.04, dir.y);
  L = L * fade + (1.0 - T) * skyL(dir) * (1.0 - fade);
  return vec4(L, T);
}
`;

const CLOUD_FS = /* glsl */ `
precision highp sampler3D;
${ATMO_GLSL}
uniform sampler2D uSkyLUT;
uniform sampler2D uSkyIrr;
uniform sampler2D uCloudTex;
uniform sampler3D uNoise3D;
uniform sampler2D tDepth;
uniform vec2 uFullRes;
uniform vec3 uSunDirA;
uniform vec3 uSunCloud;
uniform vec3 uCamPosW;
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform float uCloudScale;
uniform float uCloudTop;
uniform mat4 uCamWorld;
uniform vec2 uProjXY;
uniform float uFrame;
varying vec2 vUv;

vec3 skyL(vec3 d) { return texture2D(uSkyLUT, atmSkyUV(d, uSunDirA)).rgb; }
vec3 irr(float k) { return texture2D(uSkyIrr, vec2((k + 0.5) / 8.0, 0.5)).rgb; }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
${CLOUD_MARCH_GLSL}

void main() {
  // skip blocks with no visible sky (checked on the full-res depth, dilated)
  vec2 fp = vUv * uFullRes;
  float sky = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 c = clamp(ivec2(fp + vec2(float(i), float(j)) * 2.0), ivec2(0), ivec2(uFullRes) - 1);
    sky = max(sky, step(1.0, texelFetch(tDepth, c, 0).r));
  }
  if (sky < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 2.0); return; }  // 2 = no sky here (no history)

  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = normalize((uCamWorld * vec4(ndc.x / uProjXY.x, ndc.y / uProjXY.y, -1.0, 0.0)).xyz);
  float jit = ign(gl_FragCoord.xy + uFrame * 5.588238);
  gl_FragColor = cloudMarch(uCamPosW, dir, jit, CLOUD_STEPS, 4, 1.0);
}
`;

// Temporal accumulation: clouds are effectively at infinity, so reprojecting by view
// direction (camera rotation only) is exact enough; history is clamped to the current
// neighbourhood to avoid ghosting.
const RESOLVE_FS = /* glsl */ `
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform mat4 uCamWorld;
uniform vec2 uProjXY;
uniform mat4 uPrevViewProj;   // previous rotation-only view-projection
uniform vec2 uTexel;
uniform float uBlend;
varying vec2 vUv;
vec4 toYCoCg(vec4 c) {
  return vec4(dot(c.rgb, vec3(0.25, 0.5, 0.25)), dot(c.rgb, vec3(0.5, 0.0, -0.5)), dot(c.rgb, vec3(-0.25, 0.5, -0.25)), c.a);
}
vec4 fromYCoCg(vec4 c) { return vec4(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z, c.a); }
void main() {
  vec4 c = texture2D(tCur, vUv);
  if (c.a > 1.5) { gl_FragColor = c; return; }
  // neighbourhood mean and variance in YCoCg (tighter than a min/max box)
  vec4 cy = toYCoCg(c);
  vec4 m1 = cy, m2 = cy * cy;
  float n = 1.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    vec4 s = texture2D(tCur, vUv + vec2(float(i), float(j)) * uTexel);
    if (s.a > 1.5) continue;
    vec4 sy = toYCoCg(s);
    m1 += sy; m2 += sy * sy; n += 1.0;
  }
  m1 /= n;
  vec4 sd = sqrt(max(m2 / n - m1 * m1, 0.0));
  vec4 mn = m1 - 1.25 * sd, mx = m1 + 1.25 * sd;
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = (uCamWorld * vec4(ndc.x / uProjXY.x, ndc.y / uProjXY.y, -1.0, 0.0)).xyz;
  vec4 pc = uPrevViewProj * vec4(dir, 0.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  if (pc.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) { gl_FragColor = c; return; }
  vec4 h = texture2D(tHist, puv);
  if (h.a > 1.5) { gl_FragColor = c; return; }
  h = fromYCoCg(clamp(toYCoCg(h), mn, mx));
  gl_FragColor = mix(h, c, uBlend);
}
`;

export class Clouds {
  constructor(renderer, skyUniforms, { steps = 44 } = {}) {
    this.renderer = renderer;
    this._noiseJob = makeNoise3D(64);
    this.noise3D = this._noiseJob.rt;
    // shared with the sky (its environment capture marches the same clouds)
    if (skyUniforms.uNoise3D) skyUniforms.uNoise3D.value = this.noise3D.texture;
    this.uniforms = {
      uSkyLUT: skyUniforms.uSkyLUT, uSkyIrr: skyUniforms.uSkyIrr, uCloudTex: skyUniforms.uCloudTex,
      uSunDirA: skyUniforms.uSunDirA, uSunCloud: skyUniforms.uSunCloud, uCamPosW: skyUniforms.uCamPosW,
      uCloudOffset: skyUniforms.uCloudOffset, uCloudCover: skyUniforms.uCloudCover, uMieScale: skyUniforms.uMieScale,
      uCloudScale: skyUniforms.uCloudScale, uCloudTop: skyUniforms.uCloudTop,
      uNoise3D: skyUniforms.uNoise3D || { value: null },
      tDepth: { value: null }, uFullRes: { value: new THREE.Vector2(1, 1) },
      uCamWorld: { value: new THREE.Matrix4() }, uProjXY: { value: new THREE.Vector2(1, 1) },
      uFrame: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: CLOUD_FS, uniforms: this.uniforms, defines: { CLOUD_STEPS: steps },
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.target = null;
    this.history = [null, null];
    this.ping = 0;
    this.prevViewProj = new THREE.Matrix4();
    this.hasHistory = false;
    this.resolveUniforms = {
      tCur: { value: null }, tHist: { value: null },
      uCamWorld: this.uniforms.uCamWorld, uProjXY: this.uniforms.uProjXY,
      uPrevViewProj: { value: this.prevViewProj }, uTexel: { value: new THREE.Vector2() }, uBlend: { value: 0.25 },
    };
    this.resolveQuad = new THREE.Mesh(this.quad.geometry, new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: RESOLVE_FS, uniforms: this.resolveUniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    }));
    this.resolveQuad.frustumCulled = false;
    this._rot = new THREE.Matrix4();
  }

  /** The off-scene passes (for compiling them up front). */
  passes() { return [this.quad, this.resolveQuad, ...(this._noiseJob ? [this._noiseJob.quad] : [])]; }

  /** Fill the 3D noise texture (once, before the clouds are first drawn). */
  renderNoise() {
    if (!this._noiseJob) return;
    renderNoise3D(this.renderer, this._noiseJob);
    this._noiseJob = null;
  }

  setSize(w, h) {
    const hw = Math.max(1, Math.ceil(w / 2)), hh = Math.max(1, Math.ceil(h / 2));
    if (this.target && this.target.width === hw && this.target.height === hh) return;
    for (const t of [this.target, ...this.history]) t && t.dispose();
    const mk = () => new THREE.WebGLRenderTarget(hw, hh, {
      type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    this.target = mk();
    this.history = [mk(), mk()];
    this.hasHistory = false;
    this.uniforms.uFullRes.value.set(w, h);
    this.resolveUniforms.uTexel.value.set(1 / hw, 1 / hh);
  }

  /** March the cloud slab for the current camera; returns the half-res (radiance, transmittance) texture. */
  render(camera, depthTexture, frame) {
    const u = this.uniforms, P = camera.projectionMatrix.elements;
    u.tDepth.value = depthTexture;
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uProjXY.value.set(P[0], P[5]);
    u.uFrame.value = frame % 64;
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.render(this.quad, this.cam);

    // temporal resolve into the history ping-pong
    const ru = this.resolveUniforms;
    const src = this.history[this.ping], dst = this.history[this.ping ^ 1];
    ru.tCur.value = this.target.texture;
    ru.tHist.value = src.texture;
    ru.uBlend.value = this.hasHistory ? 0.25 : 1.0;
    r.setRenderTarget(dst);
    r.render(this.resolveQuad, this.cam);
    this.ping ^= 1;
    this.hasHistory = true;
    // remember this frame's rotation-only view-projection
    this._rot.extractRotation(camera.matrixWorldInverse);
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, this._rot);
    return dst.texture;
  }
}
