import * as THREE from 'three';
import { ATMO_GLSL, SUN_TRANS_GLSL, SUN_ANGULAR_RADIUS } from './atmosphere.js';
import { CLOUD_MARCH_GLSL } from './clouds.js';

// Sky dome (per-pixel atmosphere + sun disc + cumulus and cirrus layers), the
// tileable cloud noise it samples, a tiny sky-irradiance texture, and the HDR
// environment cube (sky above a street-canyon model) that feeds PMREM.

// ------------------------------------------------------------------ cloud noise

const NOISE_FS = /* glsl */ `
varying vec2 vUv;
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// periodic gradient noise, period P cells per axis
float gnoise(vec2 x, vec2 P) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 g00 = hash22(mod(i, P)) * 2.0 - 1.0;
  vec2 g10 = hash22(mod(i + vec2(1, 0), P)) * 2.0 - 1.0;
  vec2 g01 = hash22(mod(i + vec2(0, 1), P)) * 2.0 - 1.0;
  vec2 g11 = hash22(mod(i + vec2(1, 1), P)) * 2.0 - 1.0;
  float a = dot(g00, f), b = dot(g10, f - vec2(1, 0)), c = dot(g01, f - vec2(0, 1)), d = dot(g11, f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.4;
}
// periodic Worley (F1), returns 0 at feature points
float worley(vec2 x, vec2 P) {
  vec2 i = floor(x), f = fract(x);
  float m = 9.0;
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    vec2 o = vec2(float(xx), float(y));
    vec2 h = hash22(mod(i + o, P));
    vec2 r = o + h - f;
    m = min(m, dot(r, r));
  }
  return sqrt(m);
}
float pfbm(vec2 uv, vec2 f0, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  vec2 fr = f0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * gnoise(uv * fr, fr); n += a;
    a *= 0.5; fr *= 2.0;
  }
  return s / n;
}
float wfbm(vec2 uv, float f0) {
  return 1.0 - (worley(uv * f0, vec2(f0)) * 0.625 + worley(uv * f0 * 2.0, vec2(f0 * 2.0)) * 0.25 + worley(uv * f0 * 4.0, vec2(f0 * 4.0)) * 0.125);
}
void main() {
  vec2 uv = vUv;
  // R: billowy cumulus field (Perlin-Worley)
  float p = pfbm(uv, vec2(4.0), 6) * 0.5 + 0.5;
  float w = wfbm(uv, 4.0);
  float pw = clamp((p - (1.0 - w) * 0.75) / (1.0 - (1.0 - w) * 0.75 + 1e-3), 0.0, 1.0);
  pw = mix(pw, p, 0.25);
  // G: cauliflower detail for edge erosion
  float det = wfbm(uv + 0.37, 16.0);
  // B: regional coverage
  float cov = pfbm(uv + 0.11, vec2(2.0), 3) * 0.5 + 0.5;
  // A: cirrus streaks (anisotropic, domain-warped)
  vec2 wq = vec2(pfbm(uv + 0.53, vec2(3.0), 3), pfbm(uv + 0.71, vec2(3.0), 3));
  vec2 cu = uv + wq * vec2(0.04, 0.12);
  float ci = pfbm(cu, vec2(2.0, 16.0), 5) * 0.5 + 0.5;
  ci *= pfbm(uv + 0.29, vec2(3.0), 3) * 0.5 + 0.6;
  // stretch each channel to use the full range (measured distributions)
  gl_FragColor = vec4(clamp((pw - 0.07) / 0.57, 0.0, 1.0), clamp((det - 0.05) / 0.93, 0.0, 1.0),
                      clamp((cov - 0.29) / 0.42, 0.0, 1.0), clamp((ci - 0.13) / 0.40, 0.0, 1.0));
}
`;

/** Cloud noise target and the pass that fills it (rendered by Sky.initGPU). */
function makeCloudNoise(size = 512) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false,
    wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
  });
  rt.texture.anisotropy = 8;
  const mat = new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: NOISE_FS, depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  return { rt, quad };
}

// ------------------------------------------------------------------ sky irradiance (8x1)
// texel 0: irradiance on an upward surface, 1: mean horizon radiance,
// 2: zenith radiance, 3: irradiance on a canyon wall (vertical, azimuth-averaged,
// from the sky above the opposite roofline only, elevation > 25°),
// 4: radiance 5° above the horizon towards the sun's azimuth, 5: away from it

export const IRR_TEXELS = 8;

const IRR_FS = /* glsl */ `
${ATMO_GLSL}
uniform sampler2D uSkyLUT;
uniform vec3 uSunDirA;
varying vec2 vUv;
vec3 skyL(vec3 d) { return texture2D(uSkyLUT, atmSkyUV(d, uSunDirA)).rgb; }
void main() {
  int k = int(floor(vUv.x * 8.0));
  vec3 acc = vec3(0.0);
  vec2 sh = length(uSunDirA.xz) > 1e-4 ? normalize(uSunDirA.xz) : vec2(1.0, 0.0);
  if (k == 0 || k == 3) {
    const int NA = 16, NE = 8;
    for (int a = 0; a < NA; a++) for (int e = 0; e < NE; e++) {
      float el0 = k == 0 ? 0.0 : 0.436;
      float el = el0 + (float(e) + 0.5) / float(NE) * (0.5 * ATM_PI - el0);
      float az = (float(a) + 0.5) / float(NA) * 2.0 * ATM_PI;
      vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
      float dw = cos(el) * (0.5 * ATM_PI - el0) / (0.5 * ATM_PI); // solid angle weight (band height)
      // vertical wall averaged over its facing direction: mean of max(cos, 0) is 1/pi
      float c = k == 0 ? sin(el) : cos(el) / ATM_PI;
      acc += skyL(d) * c * dw;
    }
    // integral over the hemisphere: sum(L c dw) * (2 pi / sum of full-hemisphere weights)
    acc *= 2.0 * ATM_PI / (float(NA * NE) * (2.0 / ATM_PI));
  } else if (k == 1) {
    for (int a = 0; a < 32; a++) {
      float az = (float(a) + 0.5) / 32.0 * 2.0 * ATM_PI;
      acc += skyL(vec3(cos(az) * 0.9997, 0.025, sin(az) * 0.9997));
    }
    acc /= 32.0;
  } else if (k == 2) {
    acc = skyL(vec3(0.0, 1.0, 0.0));
  } else if (k == 4 || k == 5) {
    vec2 h = k == 4 ? sh : -sh;
    acc = skyL(vec3(h.x * 0.9962, 0.0872, h.y * 0.9962));
  }
  gl_FragColor = vec4(acc, 1.0);
}
`;

// ------------------------------------------------------------------ sky shader

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  #ifdef ENV_CAPTURE
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #else
    vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + position * 1000.0, 1.0);
    p.z = p.w * 0.999995;
    gl_Position = p;
  #endif
}
`;

const SKY_FS = /* glsl */ `
${ATMO_GLSL}
${SUN_TRANS_GLSL}
uniform sampler2D uSkyLUT;
uniform sampler2D uSkyIrr;
uniform sampler2D uCloudTex;
uniform vec3 uSunDirA;
uniform vec3 uSunGround;      // sun illuminance at ground level (rgb, scene units)
uniform vec3 uCamPosW;
uniform vec2 uCloudOffset;
uniform vec2 uCirrusOffset;
uniform vec2 uWindDir;
uniform float uCloudCover;
uniform float uCirrus;
uniform float uSunDiscScale;
uniform float uPixelAngle;    // radians per pixel (mip selection for the cloud march)
#ifdef ENV_CAPTURE
precision highp sampler3D;
uniform sampler3D uNoise3D;
uniform vec3 uStreetRight;    // horizontal unit vector across the street (to the right of travel)
uniform vec3 uStreetAxis;
uniform float uHalfW;         // facade line offset
uniform float uBldH;          // mean cornice height
uniform float uCamD;          // capture point offset from the centre line (along uStreetRight)
uniform float uEyeH;
#endif
varying vec3 vDir;

vec3 skyL(vec3 d) { return texture2D(uSkyLUT, atmSkyUV(d, uSunDirA)).rgb; }
vec3 irr(float k) { return texture2D(uSkyIrr, vec2((k + 0.5) / 8.0, 0.5)).rgb; }
#ifdef ENV_CAPTURE
${CLOUD_MARCH_GLSL}
#endif

// composite cirrus (and, for the environment capture, the cumulus) over L
vec3 clouds(vec3 dir, vec3 L) {
  if (dir.y < 0.004) return L;
  vec3 sunL = uSunGround;      // direct sun reaching the cloud layer (close enough to the ground value)
  vec3 ambUp = irr(0.0) / ATM_PI;
  float cosT = dot(dir, uSunDirA);

  // --- cirrus (8 km)
  {
    float t = 8000.0 / dir.y;
    vec2 p = uCamPosW.xz + dir.xz * t + uCirrusOffset;
    // stretch along the wind
    vec2 w = uWindDir, n = vec2(-w.y, w.x);
    vec2 q = vec2(dot(p, n), dot(p, w)) / 60000.0;
    float c = texture2D(uCloudTex, q).a;
    // finer fibres riding on the broad streaks
    c *= 0.62 + 0.55 * texture2D(uCloudTex, q * vec2(4.3, 3.1) + vec2(0.31, 0.17)).a;
    float cr = texture2D(uCloudTex, p / 150000.0 + 0.4).b;
    c = smoothstep(0.52, 0.9, c) * smoothstep(0.35, 0.7, cr) * uCirrus;
    float a = c * 0.55;
    float ph = mix(atmPhaseHG(cosT, 0.75), atmPhaseHG(cosT, 0.0), 0.6) * 4.0 * ATM_PI;
    vec3 col = sunL * ph * 0.16 + ambUp * 0.9;
    float fade = exp(-t / 60000.0);
    L += a * fade * (col - L);
  }

#ifdef ENV_CAPTURE
  // --- cumulus: the same clouds as the view, marched coarsely (reflections and IBL)
  vec4 cl = cloudMarch(uCamPosW, dir, 0.5, 14, 2, 0.5);
  return L * cl.a + cl.rgb;
#else
  return L;
#endif
}

#ifdef ENV_CAPTURE
// street canyon seen from the capture point: facades, paving and the sky between them
vec3 canyon(vec3 dir, vec3 skyCol) {
  vec3 E_sun = uSunGround;
  vec3 E_sky = irr(0.0);
  vec2 hd = dir.xz;
  float lh = length(hd);
  float sp = lh > 1e-4 ? dot(hd / lh, uStreetRight.xz) : 0.0;
  float tanEl = dir.y / max(lh, 1e-4);
  float side = sp >= 0.0 ? 1.0 : -1.0;
  float Dw = abs(sp) > 1e-3 ? (uHalfW - side * uCamD) / abs(sp) : 1e9;   // horizontal distance to the facade
  float Dg = dir.y < -1e-4 ? uEyeH / -tanEl : 1e9;                          // horizontal distance to the paving
  vec2 sunH = length(uSunDirA.xz) > 1e-4 ? normalize(uSunDirA.xz) : vec2(0.0);
  float tanSun = uSunDirA.y / max(length(uSunDirA.xz), 1e-3);
  float sunUp = smoothstep(-0.02, 0.03, uSunDirA.y);
  vec3 wallAlb = vec3(0.55, 0.49, 0.40);
  vec3 groundAlb = vec3(0.27, 0.26, 0.245);

  // light reaching the canyon floor (fraction of the street width in sun)
  float sunSide = dot(sunH, uStreetRight.xz) >= 0.0 ? 1.0 : -1.0;
  float shadowLen = uBldH * abs(dot(sunH, uStreetRight.xz)) / max(tanSun, 1e-3);
  float floorLit = sunUp * clamp(1.0 - shadowLen / (2.0 * uHalfW), 0.0, 1.0);
  // the facade that faces the sun: mean irradiance over its height (only the part
  // above the opposite roofline's shadow is lit, none of it once the sun is down)
  float facingS = max(abs(dot(sunH, uStreetRight.xz)), 1e-3);
  float zShS = uBldH - 2.0 * uHalfW / facingS * tanSun;
  float litS = sunUp * clamp((uBldH - max(zShS, 0.0)) / uBldH, 0.0, 1.0);
  vec3 E_sunWall = E_sun * facingS * length(uSunDirA.xz) * litS;

  if (Dw < Dg) {
    float z = uEyeH + Dw * tanEl;
    if (z > uBldH + 1.5 * sin(Dw * dot(hd / lh, uStreetAxis.xz) * 0.11)) return skyCol;
    vec2 n = -side * uStreetRight.xz;
    float cosI = dot(vec3(n.x, 0.0, n.y), uSunDirA);
    float facing = max(dot(sunH, n), 1e-3);
    float zShadow = uBldH - 2.0 * uHalfW / facing * tanSun;
    float lit = cosI > 0.0 ? smoothstep(zShadow - 0.8, zShadow + 0.8, z) * sunUp : 0.0;
    // bounce from the opposite facade only counts its sunlit share
    float oppLit = cosI < 0.0 ? litS : 0.0;
    // irradiance: direct + sky slot + bounce from the opposite facade and the floor
    vec3 E = E_sun * max(cosI, 0.0) * lit
           + irr(3.0)
           + (E_sun * max(-cosI, 0.0) * oppLit * 0.5 * wallAlb + E_sun * max(uSunDirA.y, 0.0) * floorLit * groundAlb) * 0.35;
    vec3 col = wallAlb * E / ATM_PI;
    // window grid: dark glass reflecting the sky
    float u = Dw * dot(hd / lh, uStreetAxis.xz);
    vec2 cell = vec2(fract(u / 3.4), fract((z - 4.6) / 3.6));
    float win = step(0.3, cell.x) * step(cell.x, 0.68) * step(0.12, cell.y) * step(cell.y, 0.68) * step(4.6, z);
    col = mix(col, skyCol * 0.12 + col * 0.15, win * 0.85);
    return col;
  }
  if (dir.y < 0.0) {
    float y = uCamD + Dg * sp;                  // lateral offset of the floor point
    float distToSunWall = sunSide * uHalfW - y; // signed, towards the sun-side facade
    float lit = sunUp * smoothstep(-0.6, 0.6, abs(distToSunWall) - shadowLen);
    vec3 E = E_sun * max(uSunDirA.y, 0.0) * lit + E_sky * 0.62
           + E_sunWall * 0.2 * wallAlb;
    vec3 col = groundAlb * E / ATM_PI;
    // distant floor fades into haze
    return mix(col, skyL(normalize(vec3(dir.x, 0.02, dir.z))), 1.0 - exp(-Dg / 2500.0));
  }
  return skyCol;
}
#endif

void main() {
  vec3 dir = normalize(vDir);
  vec3 d = dir;
  d.y = max(d.y, 0.0005);
  d = normalize(d);
  vec3 L = skyL(d);
  float cosA = dot(dir, uSunDirA);
#ifndef ENV_CAPTURE
  // sun disc with limb darkening
  float ang = acos(clamp(cosA, -1.0, 1.0));
  float R = ${SUN_ANGULAR_RADIUS.toFixed(6)};
  if (ang < R * 1.3) {
    float x = clamp(ang / R, 0.0, 1.0);
    float mu = sqrt(max(1.0 - x * x, 0.0));
    float limb = 1.0 - 0.6 * (1.0 - mu) - 0.2 * (1.0 - mu) * (1.0 - mu);
    float edge = 1.0 - smoothstep(0.92, 1.08, ang / R);
    float omega = ATM_PI * R * R;
    L += uSunGround / omega * limb * edge * uSunDiscScale;
  }
#endif
  L = clouds(d, L);
#ifdef ENV_CAPTURE
  L = canyon(dir, L);
#endif
  gl_FragColor = vec4(L, 1.0);
  // only active when drawn straight to the screen (no post-processing)
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CUBE_DIRS = [
  [1, 0, 0, 0, 1, 0], [-1, 0, 0, 0, 1, 0], [0, 1, 0, 0, 0, -1],
  [0, -1, 0, 0, 0, 1], [0, 0, 1, 0, 1, 0], [0, 0, -1, 0, 1, 0],
];

export class Sky {
  constructor(app, atmo, { envSize = 256 } = {}) {
    const { renderer } = app;
    this.app = app;
    this.atmo = atmo;
    this.renderer = renderer;
    this._noiseJob = makeCloudNoise();
    this.cloudNoise = this._noiseJob.rt;

    this.irrRT = new THREE.WebGLRenderTarget(IRR_TEXELS, 1, {
      type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
    });
    this._irrQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: IRR_FS, uniforms: atmo.uniforms, depthTest: false, depthWrite: false,
    }));
    this._irrQuad.frustumCulled = false;
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.uniforms = {
      ...atmo.uniforms,
      uSkyIrr: { value: this.irrRT.texture },
      uCloudTex: { value: this.cloudNoise.texture },
      uNoise3D: { value: null },   // set by Clouds
      uSunGround: { value: new THREE.Vector3(3, 3, 3) },
      uCamPosW: { value: new THREE.Vector3() },
      uCloudOffset: { value: new THREE.Vector2(3100, -5200) },
      uCirrusOffset: { value: new THREE.Vector2(12000, 4000) },
      uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
      uCloudCover: { value: 0.66 },
      uCirrus: { value: 0.5 },
      uSunDiscScale: { value: 1.0 },   // physical disc radiance (the environment capture omits the disc)
      uPixelAngle: { value: 0.0003 },
      // canyon model (env capture only)
      uStreetRight: { value: new THREE.Vector3(1, 0, 0) },
      uStreetAxis: { value: new THREE.Vector3(0, 0, -1) },
      uHalfW: { value: 12 },
      uBldH: { value: 20 },        // 4–6 storeys plus cornice and parapet
      uCamD: { value: 1.6 },
      uEyeH: { value: 2.2 },
    };

    // dome rendered with the scene, after opaque geometry (early-z rejects hidden pixels)
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this.uniforms,
      depthWrite: false, depthTest: true, side: THREE.BackSide, fog: false,
    });
    this.material.name = 'env.sky';
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 100000;
    this.mesh.name = 'sky';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;

    // ---- environment capture
    this.envScene = new THREE.Scene();
    this.envMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this.uniforms, defines: { ENV_CAPTURE: 1 },
      side: THREE.BackSide, depthTest: false, depthWrite: false,
    });
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), this.envMaterial);
    box.frustumCulled = false;
    this.envScene.add(box);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(envSize, {
      type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });
    this.cubeCams = CUBE_DIRS.map(([x, y, z, ux, uy, uz]) => {
      const c = new THREE.PerspectiveCamera(-90, 1, 0.1, 10); // negative fov: cube-map face orientation, as CubeCamera
      c.up.set(ux, uy, uz);
      c.lookAt(x, y, z);
      c.updateMatrixWorld();
      return c;
    });
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // copies a finished progressive update into the live target (compiled up front)
    this._copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tSrc, vUv); }',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false,
    }));
    this._copyQuad.frustumCulled = false;
    this.envRT = null;       // live target (scene.environment)
    this.backRT = null;      // progressive updates are filtered here, then copied over
    this.envSize = envSize;
    this._capStep = -1;      // -1 idle, 0..2 face pairs, 3 = PMREM
    this._capTimer = 0;
    this._envDirty = false;  // another refresh was requested while one was in flight
  }

  /**
   * Allocate the environment targets and publish scene.environment without rendering
   * anything yet (programs are keyed on the environment's format, so it must exist
   * before the start-up compile; the first capture fills it later).
   */
  allocateEnv() {
    if (this.envRT) return;
    const g = this.pmrem;
    if (typeof g._setSize === 'function' && typeof g._allocateTargets === 'function') {
      g._setSize(this.cubeRT.width);
      this.envRT = g._allocateTargets();
      this.backRT = g._allocateTargets();
      this.app.scene.environment = this.envRT.texture;
      g.compileCubemapShader();
    }
  }

  /** The off-scene passes (for compiling them up front). */
  passes() {
    const out = [this._irrQuad, this._copyQuad, ...this.envScene.children];
    if (this._noiseJob) out.push(this._noiseJob.quad);
    const g = this.pmrem;
    if (g._lodMeshes && g._lodMeshes.length && g._ggxMaterial) {
      const m = new THREE.Mesh(g._lodMeshes[0].geometry, g._ggxMaterial);
      m.frustumCulled = false;
      out.push(m);
    }
    return out;
  }

  /** One draw of the swap pass (into the back target, whose content is scratch). */
  warmCopy() {
    if (!this.envRT || !this.backRT || this._capStep >= 0) return;
    const r = this.renderer, rt = this.backRT, prev = r.getRenderTarget();
    this._copyQuad.material.uniforms.tSrc.value = this.envRT.texture;
    rt.scissorTest = false;
    rt.viewport.set(0, 0, rt.width, rt.height);
    r.setRenderTarget(rt);
    r.render(this._copyQuad, this._quadCam);
    r.setRenderTarget(prev);
  }

  /** One-time GPU work: the cloud noise texture. */
  initGPU() {
    if (!this._noiseJob) return;
    const r = this.renderer, { rt, quad } = this._noiseJob, prev = r.getRenderTarget();
    r.setRenderTarget(rt);
    r.render(quad, this._quadCam);
    r.setRenderTarget(prev);
    quad.material.dispose(); quad.geometry.dispose();
    this._noiseJob = null;
  }

  /**
   * Recompute the sky-irradiance texture (after the sky-view LUT changed) and, unless
   * deferred, read it back (4 texels) for exposure.
   */
  updateIrradiance(readback = true) {
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.irrRT);
    r.render(this._irrQuad, this._quadCam);
    r.setRenderTarget(prev);
    if (readback) this.readIrradiance();
  }

  /** Synchronous read of the irradiance texels (a GPU stall: start-up only). */
  readIrradiance() {
    const r = this.renderer;
    const buf = this._irrBuf || (this._irrBuf = new Uint16Array(IRR_TEXELS * 4));
    try {
      r.readRenderTargetPixels(this.irrRT, 0, 0, IRR_TEXELS, 1, buf);
      this._decodeIrradiance(buf);
    } catch (e) {
      this.irradiance = null;
    }
  }

  /**
   * Asynchronous read (pixel-pack buffer + fence, no stall); resolves true once
   * this.irradiance holds the values of the texture as it was when called.
   */
  readIrradianceAsync() {
    const r = this.renderer;
    if (this._irrPending) return this._irrPending;
    const buf = new Uint16Array(IRR_TEXELS * 4);
    this._irrPending = r.readRenderTargetPixelsAsync(this.irrRT, 0, 0, IRR_TEXELS, 1, buf)
      .then(() => { this._decodeIrradiance(buf); return true; })
      .catch(() => { this.readIrradiance(); return true; })
      .finally(() => { this._irrPending = null; });
    return this._irrPending;
  }

  _decodeIrradiance(buf) {
    const h = THREE.DataUtils.fromHalfFloat;
    const px = (i) => new THREE.Vector3(h(buf[i * 4]), h(buf[i * 4 + 1]), h(buf[i * 4 + 2]));
    this.irradiance = {
      horizontal: px(0), horizonMean: px(1), zenith: px(2), vertical: px(3), horizonSun: px(4), horizonAnti: px(5),
    };
  }

  /**
   * Request a fresh environment capture; `immediate` does all of it now. A progressive
   * capture already in flight is never restarted (a dragged time-of-day slider would
   * otherwise keep it from ever finishing): it completes, then another one follows.
   */
  requestEnv(immediate = false) {
    if (immediate || !this.envRT) {
      for (let i = 0; i < 6; i++) this._renderFace(i);
      this._runPMREM();
      this._capStep = -1;
      this._pmremQueue = null;
      this._envDirty = false;
      return;
    }
    if (this._capStep >= 0) this._envDirty = true;
    else this._capStep = 0;
  }

  _renderFace(i) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    const pa = this.uniforms.uPixelAngle.value;
    this.uniforms.uPixelAngle.value = (Math.PI / 2) / this.cubeRT.width;
    r.setRenderTarget(this.cubeRT, i);
    r.render(this.envScene, this.cubeCams[i]);
    this.uniforms.uPixelAngle.value = pa;
    r.setRenderTarget(prev);
    r.xr.enabled = prevXr;
  }

  _runPMREM() {
    const tex = this.cubeRT.texture;
    if (!this.envRT) {
      this.envRT = this.pmrem.fromCubemap(tex);
      this.backRT = this.pmrem.fromCubemap(tex);
      this.app.scene.environment = this.envRT.texture;
    } else {
      this.pmrem.fromCubemap(tex, this.envRT);
    }
  }

  /** Publish a finished progressive update: one full-target copy into the live map. */
  _pmremSwap() {
    const r = this.renderer, rt = this.envRT, prev = r.getRenderTarget();
    this._copyQuad.material.uniforms.tSrc.value = this.backRT.texture;
    rt.scissorTest = false;
    rt.viewport.set(0, 0, rt.width, rt.height);
    r.setRenderTarget(rt);
    r.render(this._copyQuad, this._quadCam);
    r.setRenderTarget(prev);
  }

  /**
   * Queue a progressive PMREM update: the cube is projected into the back target, then
   * the GGX roughness levels are filtered a couple per frame (each level reads the
   * previous one), and the finished set is copied into the live target in one go, so
   * reflections never mix old and new lighting. Relies on PMREMGenerator internals of
   * the vendored three.js; falls back to a one-shot update if they are missing.
   */
  _pmremBegin() {
    const g = this.pmrem;
    if (!this.envRT || !this.backRT || typeof g._applyGGXFilter !== 'function' || typeof g._textureToCubeUV !== 'function' || !g._lodMeshes) {
      this._runPMREM();
      return false;
    }
    this._pmremQueue = [];
    for (let i = 0; i < g._lodMeshes.length; i++) this._pmremQueue.push(i);
    return true;
  }

  _pmremStep(maxSteps) {
    const g = this.pmrem, r = this.renderer, rt = this.backRT;
    const prev = r.getRenderTarget(), ac = r.autoClear;
    r.autoClear = false;
    rt.scissorTest = true;
    for (let n = 0; n < maxSteps && this._pmremQueue.length; n++) {
      const i = this._pmremQueue.shift();
      if (i === 0) g._textureToCubeUV(this.cubeRT.texture, rt);
      else g._applyGGXFilter(rt, i - 1, i);
    }
    rt.scissorTest = false;
    rt.viewport.set(0, 0, rt.width, rt.height);
    rt.scissor.set(0, 0, rt.width, rt.height);
    r.autoClear = ac;
    r.setRenderTarget(prev);
    if (this._pmremQueue.length) return false;
    this._pmremSwap();
    return true;
  }

  /** Progressive capture: two cube faces per frame for three frames, then PMREM two levels per frame. */
  step(dt, refreshEvery = 6) {
    this._capTimer += dt;
    if (this._capStep < 0 && this._capTimer > refreshEvery) this._capStep = 0;
    if (this._capStep < 0) return;
    this._capTimer = 0;
    if (this._capStep < 3) {
      this._renderFace(this._capStep * 2);
      this._renderFace(this._capStep * 2 + 1);
      this._capStep++;
      if (this._capStep === 3 && !this._pmremBegin()) { this._capStep = -1; this._envDirty = false; }
    } else if (this._pmremStep(2)) {
      this._capStep = -1;
      // a refresh requested meanwhile starts right away
      if (this._envDirty) { this._envDirty = false; this._capStep = 0; }
    }
  }
}
