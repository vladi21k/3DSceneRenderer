import * as THREE from 'three';
import { ATMO_GLSL } from './atmosphere.js';

// Volumetric fair-weather cumulus. A slab between CB and CB+CT metres is ray-marched
// at half resolution after the main pass (only where the sky is visible), lit by the
// sun with self-shadowing and a multiple-scattering approximation, and composited
// over the sky in the post prepass. Shapes come from the 2D cloud field in sky.js
// (where the clouds are) and a tileable 3D Perlin-Worley texture (their billows).

const CB = 1500.0, CT = 1300.0;

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
  // G: fine Worley fbm for edge erosion
  float d = 1.0 - (worley3(p * 8.0, 8.0) * 0.625 + worley3(p * 16.0, 16.0) * 0.25 + worley3(p * 32.0, 32.0) * 0.125);
  gl_FragColor = vec4(clamp(mix(pw, wf, 0.35) * 1.15 - 0.08, 0.0, 1.0), clamp(d * 1.2 - 0.15, 0.0, 1.0), 0.0, 1.0);
}
`;

function makeNoise3D(renderer, size = 64) {
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
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  for (let z = 0; z < size; z++) {
    mat.uniforms.uLayer.value = z;
    renderer.setRenderTarget(rt, z);
    renderer.render(quad, cam);
  }
  renderer.setRenderTarget(prev);
  mat.dispose(); quad.geometry.dispose();
  return rt;
}

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
uniform vec3 uSunGround;
uniform vec3 uCamPosW;
uniform vec2 uCloudOffset;
uniform float uCloudCover;
uniform mat4 uCamWorld;
uniform vec2 uProjXY;
uniform float uFrame;
varying vec2 vUv;

#define MS_BOOST 2.2
#define CB ${CB.toFixed(1)}
#define CT ${CT.toFixed(1)}
vec3 skyL(vec3 d) { return texture2D(uSkyLUT, atmSkyUV(d, uSunDirA)).rgb; }
vec3 irr(float k) { return texture2D(uSkyIrr, vec2((k + 0.5) / 4.0, 0.5)).rgb; }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

float density(vec3 p, float detail) {
  float hf = (p.y - CB) / CT;
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  vec2 q = p.xz + uCloudOffset;
  float cov = clamp(uCloudCover + (texture2D(uCloudTex, q / 110000.0).b - 0.5) * 0.5, 0.05, 0.9);
  float field = textureLod(uCloudTex, q / 13000.0, 0.0).r;
  vec4 n = textureLod(uNoise3D, vec3(q.x, p.y * 1.4, q.y) / 2600.0, 0.0);
  float shape = field * 0.72 + n.r * 0.28;
  // flat bases, rounded tops: the threshold rises with height, so only the cores reach up
  float thr = 1.0 - cov * pow(max(1.0 - hf, 0.0), 0.75) * smoothstep(0.0, 0.05, hf);
  float d = clamp((shape - thr) / max(1.0 - thr, 1e-3), 0.0, 1.0);
  if (d <= 0.0 || detail <= 0.0) return d;
  float e = textureLod(uNoise3D, vec3(q.x, p.y, q.y) / 700.0 + vec3(0.37, 0.11, 0.73), 0.0).g;
  float ero = (1.0 - e) * mix(0.55, 0.25, hf) * detail;
  return clamp((d - ero) / max(1.0 - ero, 1e-3), 0.0, 1.0);
}

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
  if (dir.y < 0.003) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  float t0 = (CB - uCamPosW.y) / dir.y, t1 = (CB + CT - uCamPosW.y) / dir.y;
  const float TMAX = 45000.0;
  if (t0 > TMAX) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  t1 = min(t1, TMAX);
  const int N = CLOUD_STEPS;
  float dt = (t1 - t0) / float(N);
  float jit = ign(gl_FragCoord.xy + uFrame * 5.588238);

  vec3 sunL = uSunGround;
  vec3 ambTop = irr(0.0) / ATM_PI * 1.15;
  vec3 ambBot = (uSunGround * max(uSunDirA.y, 0.0) * 0.22 + irr(0.0) * 0.25) / ATM_PI;
  float cosT = dot(dir, uSunDirA);
  // dual-lobe phase, and two softer lobes for the multiple-scattering octaves
  float ph0 = mix(atmPhaseHG(cosT, 0.75), atmPhaseHG(cosT, -0.25), 0.35);
  float ph1 = mix(atmPhaseHG(cosT, 0.38), atmPhaseHG(cosT, -0.12), 0.35);
  float ph2 = atmPhaseHG(cosT, 0.1);
  const float SIGMA = 0.045;   // extinction per metre at density 1
  vec3 lsd = normalize(uSunDirA + vec3(0.0, 0.08, 0.0));

  vec3 L = vec3(0.0);
  float T = 1.0;
  float tw = 0.0, tsum = 0.0;
  for (int i = 0; i < N; i++) {
    float t = t0 + (float(i) + jit) * dt;
    vec3 p = uCamPosW + dir * t;
    float d = density(p, 1.0);
    if (d <= 0.002) continue;
    float sig = d * SIGMA;
    // optical depth towards the sun
    float tau = 0.0;
    tau += density(p + lsd * 60.0, 0.6) * 60.0;
    tau += density(p + lsd * 200.0, 0.4) * 140.0;
    tau += density(p + lsd * 480.0, 0.0) * 280.0;
    tau += density(p + lsd * 1000.0, 0.0) * 520.0;
    tau *= SIGMA;
    float hf = clamp((p.y - CB) / CT, 0.0, 1.0);
    float powder = 1.0 - exp(-sig * 160.0);
    // sun: single scattering plus two multiple-scattering octaves (wider, less attenuated)
    vec3 S = sunL * (exp(-tau) * ph0 + 0.5 * exp(-tau * 0.25) * ph1 + 0.25 * exp(-tau * 0.07) * ph2) * mix(1.0, powder, 0.5) * MS_BOOST
           + mix(ambBot, ambTop, smoothstep(0.0, 0.8, hf)) * (0.6 + 0.4 * hf);
    float sT = exp(-sig * dt);
    // energy-conserving integration of the in-scatter over the step (albedo ~1)
    L += T * S * (1.0 - sT);
    tsum += T * (1.0 - sT) * t; tw += T * (1.0 - sT);
    T *= sT;
    if (T < 0.015) break;
  }
  // aerial perspective: far clouds sink into the sky colour
  float tAvg = tw > 1e-4 ? tsum / tw : t0;
  float fade = exp(-tAvg / 26000.0) * smoothstep(0.003, 0.04, dir.y);
  vec3 skyCol = skyL(dir);
  L = L * fade + (1.0 - T) * skyCol * (1.0 - fade);
  gl_FragColor = vec4(L, T);
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
void main() {
  vec4 c = texture2D(tCur, vUv);
  if (c.a > 1.5) { gl_FragColor = c; return; }
  vec4 mn = c, mx = c;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    vec4 s = texture2D(tCur, vUv + vec2(float(i), float(j)) * uTexel);
    if (s.a > 1.5) continue;
    mn = min(mn, s); mx = max(mx, s);
  }
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = (uCamWorld * vec4(ndc.x / uProjXY.x, ndc.y / uProjXY.y, -1.0, 0.0)).xyz;
  vec4 pc = uPrevViewProj * vec4(dir, 0.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  if (pc.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) { gl_FragColor = c; return; }
  vec4 h = texture2D(tHist, puv);
  if (h.a > 1.5) { gl_FragColor = c; return; }
  h = clamp(h, mn, mx);
  gl_FragColor = mix(h, c, uBlend);
}
`;

export class Clouds {
  constructor(renderer, skyUniforms, { steps = 44 } = {}) {
    this.renderer = renderer;
    this.noise3D = makeNoise3D(renderer, 64);
    this.uniforms = {
      uSkyLUT: skyUniforms.uSkyLUT, uSkyIrr: skyUniforms.uSkyIrr, uCloudTex: skyUniforms.uCloudTex,
      uSunDirA: skyUniforms.uSunDirA, uSunGround: skyUniforms.uSunGround, uCamPosW: skyUniforms.uCamPosW,
      uCloudOffset: skyUniforms.uCloudOffset, uCloudCover: skyUniforms.uCloudCover, uMieScale: skyUniforms.uMieScale,
      uNoise3D: { value: this.noise3D.texture },
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
      uPrevViewProj: { value: this.prevViewProj }, uTexel: { value: new THREE.Vector2() }, uBlend: { value: 0.15 },
    };
    this.resolveQuad = new THREE.Mesh(this.quad.geometry, new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: RESOLVE_FS, uniforms: this.resolveUniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    }));
    this.resolveQuad.frustumCulled = false;
    this._rot = new THREE.Matrix4();
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
    ru.uBlend.value = this.hasHistory ? 0.15 : 1.0;
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
