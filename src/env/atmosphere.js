import * as THREE from 'three';

// Physically based atmosphere (after Hillaire 2020): a transmittance LUT, a
// multiple-scattering LUT and a sky-view LUT rendered on the GPU. Everything else
// in env (sky dome, clouds, environment map, aerial perspective) samples them.
//
// Units: atmosphere geometry in km. Radiance is in scene units where
// 1.0 = 33,000 cd/m² (illuminance 1.0 = 33,000 lux), so the midday sun is ~3.

export const LUX_PER_UNIT = 33000;
export const SUN_E0 = 128000 / LUX_PER_UNIT;              // solar illuminance at the top of the atmosphere
export const SUN_TINT = new THREE.Color(1.0, 0.965, 0.925); // ~5900 K seen in linear sRGB
export const SUN_ANGULAR_RADIUS = 0.00465;                  // radians
export const CAMERA_ALT_KM = 0.35;

const RG = 6360.0, RT = 6460.0;
const RAYLEIGH = [5.802e-3, 13.558e-3, 33.1e-3];            // per km
const RAYLEIGH_H = 8.0;
const MIE_EXT = 4.44e-3;   // per km at unit density (x uMieScale)
// dust aerosol: extinction rises a little towards blue (Angstrom exponent ~0.6 over the
// sRGB primaries), so the load reddens the low sun and whitens the sky near the horizon;
// mineral dust and sea salt barely absorb in the visible (single-scattering albedo ~0.96,
// a touch lower in the blue), so the aerosol adds light to the sky instead of greying it.
// Most of it sits in the boundary layer (scale height ~0.9 km), and coarse dust scatters
// a little less forward than urban aerosol (g ~0.66): the band near the horizon goes milky
// and bright while the sky overhead stays blue
// (Angstrom exponent `ang`: extinction ∝ (λ / 550 nm)^−ang at the primaries' ~615, 550 and
// 465 nm; 0.6 gives about [0.93, 1.0, 1.11])
const mieSpectrum = (ang) => [Math.pow(615 / 550, -ang), 1.0, Math.pow(465 / 550, -ang)];
export const MIE_DEFAULT = { h: 0.9, alb: [0.975, 0.965, 0.95], g: 0.66, ang: 0.6 };
// ozone (Chappuis band) absorption per km at the layer peak. The sRGB red primary spans
// ~580-700 nm, across the band's peak and its long-wave flank: on average it loses about
// as much as the green, so the twilight sky goes blue and pink rather than khaki
const OZONE = [1.75e-3, 1.881e-3, 0.085e-3];

const f = (x) => x.toFixed(7);
const v3 = (a) => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

/** Shared GLSL: constants, medium, intersections, LUT parameterisations, phase functions. */
export const ATMO_GLSL = /* glsl */ `
#ifndef ATMO_COMMON
#define ATMO_COMMON
#define ATM_RG ${f(RG)}
#define ATM_RT ${f(RT)}
#define ATM_PI 3.14159265
const vec3 ATM_RAYLEIGH = ${v3(RAYLEIGH)};
const vec3 ATM_OZONE = ${v3(OZONE)};
uniform vec3 uMieExt;        // aerosol extinction per km at unit density (rgb)
uniform float uMieScale;     // aerosol load (x the clean reference atmosphere)
uniform float uMieH;         // aerosol scale height (km)
uniform vec3 uMieAlb;        // aerosol single-scattering albedo (rgb)

float atmRaySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd), c = dot(ro, ro) - R * R, d = b * b - c;
  if (d < 0.0) return -1.0;
  float s = sqrt(d);
  float t0 = -b - s, t1 = -b + s;
  return t0 > 0.0 ? t0 : t1;
}
void atmMedium(float h, out vec3 scaR, out vec3 scaM, out vec3 ext) {
  float dR = exp(-h / ${f(RAYLEIGH_H)});
  float dM = exp(-h / uMieH);
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  scaR = ATM_RAYLEIGH * dR;
  scaM = uMieExt * uMieAlb * (uMieScale * dM);
  ext = scaR + uMieExt * (uMieScale * dM) + ATM_OZONE * dO;
}
float atmPhaseR(float c) { return 3.0 / (16.0 * ATM_PI) * (1.0 + c * c); }
float atmPhaseHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * ATM_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
// Cornette-Shanks Mie phase (urban/continental aerosol: slightly less forward-peaked)
uniform float uMieG;          // aerosol phase asymmetry
float atmPhaseM(float c) {
  float g = uMieG; float g2 = g * g;
  return 3.0 / (8.0 * ATM_PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
const float ATM_H = sqrt(ATM_RT * ATM_RT - ATM_RG * ATM_RG);
vec2 atmTransUV(float r, float mu) {
  float rho = sqrt(max(0.0, r * r - ATM_RG * ATM_RG));
  float disc = r * r * (mu * mu - 1.0) + ATM_RT * ATM_RT;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = ATM_RT - r, dMax = rho + ATM_H;
  return vec2((d - dMin) / (dMax - dMin), rho / ATM_H);
}
// Sky-view LUT: u = sqrt(relative azimuth / pi), v = 0.5 + 0.5 sign(el) sqrt(|el| / (pi/2))
vec2 atmSkyUV(vec3 dir, vec3 sunDir) {
  float el = asin(clamp(dir.y, -1.0, 1.0));
  vec2 h = dir.xz, sh = sunDir.xz;
  float lh = length(h), ls = length(sh);
  float c = (lh > 1e-5 && ls > 1e-5) ? dot(h / lh, sh / ls) : 1.0;
  float az = acos(clamp(c, -1.0, 1.0));
  return vec2(sqrt(az / ATM_PI), 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * ATM_PI)));
}
#endif
`;

const FS_QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const TRANS_FS = /* glsl */ `
${ATMO_GLSL}
varying vec2 vUv;
void main() {
  float xmu = vUv.x, xr = vUv.y;
  float rho = ATM_H * xr, r = sqrt(rho * rho + ATM_RG * ATM_RG);
  float dMin = ATM_RT - r, dMax = rho + ATM_H, d = dMin + xmu * (dMax - dMin);
  float mu = d <= 0.0 ? 1.0 : clamp((ATM_H * ATM_H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  vec3 ro = vec3(0.0, r, 0.0), rd = vec3(sqrt(1.0 - mu * mu), mu, 0.0);
  float tMax = atmRaySphere(ro, rd, ATM_RT);
  vec3 od = vec3(0.0);
  const int N = 48;
  float dt = tMax / float(N);
  for (int i = 0; i < N; i++) {
    vec3 p = ro + rd * (float(i) + 0.5) * dt;
    vec3 sR, sM, ext;
    atmMedium(length(p) - ATM_RG, sR, sM, ext);
    od += ext * dt;
  }
  gl_FragColor = vec4(exp(-od), 1.0);
}
`;

const SUN_TRANS_GLSL = /* glsl */ `
uniform sampler2D uTransLUT;
vec3 atmTrans(float r, float mu) { return texture2D(uTransLUT, atmTransUV(r, mu)).rgb; }
// transmittance from a planet-centred point towards the sun, with a soft planet shadow
vec3 atmSunTrans(vec3 p, vec3 sunDir) {
  float r = length(p), mu = dot(p / r, sunDir);
  float sinH = ATM_RG / r, cosH = -sqrt(max(0.0, 1.0 - sinH * sinH));
  return atmTrans(r, mu) * smoothstep(cosH - 0.006, cosH + 0.006, mu);
}
`;

const MS_FS = /* glsl */ `
${ATMO_GLSL}
${SUN_TRANS_GLSL}
varying vec2 vUv;
uniform float uGroundAlbedo;
void main() {
  float muS = vUv.x * 2.0 - 1.0;
  float r = ATM_RG + clamp(vUv.y, 0.002, 0.998) * (ATM_RT - ATM_RG);
  vec3 ro = vec3(0.0, r, 0.0), sunDir = vec3(sqrt(1.0 - muS * muS), muS, 0.0);
  vec3 L2 = vec3(0.0), fms = vec3(0.0);
  const int SQ = 8;
  for (int a = 0; a < SQ; a++) for (int b = 0; b < SQ; b++) {
    float ct = 1.0 - 2.0 * (float(a) + 0.5) / float(SQ);
    float st = sqrt(1.0 - ct * ct), ph = 2.0 * ATM_PI * (float(b) + 0.5) / float(SQ);
    vec3 rd = vec3(st * cos(ph), ct, st * sin(ph));
    float tG = atmRaySphere(ro, rd, ATM_RG);
    float tT = atmRaySphere(ro, rd, ATM_RT);
    bool ground = tG > 0.0;
    float tMax = ground ? tG : tT;
    const int N = 20;
    float dt = tMax / float(N);
    vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
    for (int i = 0; i < N; i++) {
      vec3 p = ro + rd * (float(i) + 0.5) * dt;
      vec3 sR, sM, ext;
      atmMedium(length(p) - ATM_RG, sR, sM, ext);
      vec3 sca = sR + sM;
      vec3 sT = exp(-ext * dt);
      vec3 S = sca * atmSunTrans(p, sunDir) / (4.0 * ATM_PI);
      L += T * (S - S * sT) / max(ext, 1e-7);
      F += T * (sca - sca * sT) / max(ext, 1e-7);
      T *= sT;
    }
    if (ground) {
      vec3 p = ro + rd * tG, n = normalize(p);
      L += T * atmSunTrans(p, sunDir) * max(dot(n, sunDir), 0.0) * uGroundAlbedo / ATM_PI;
    }
    L2 += L; fms += F;
  }
  float inv = 1.0 / float(SQ * SQ);
  L2 *= inv; fms *= inv;
  gl_FragColor = vec4(L2 / max(vec3(1.0) - fms, vec3(1e-3)), 1.0);
}
`;

const SKY_FS = /* glsl */ `
${ATMO_GLSL}
${SUN_TRANS_GLSL}
varying vec2 vUv;
uniform sampler2D uMsLUT;
uniform vec3 uSunDirA;   // world-space direction to the sun (y up)
uniform vec3 uSunE;      // solar illuminance at top of the atmosphere (scene units, rgb)
uniform float uCamR;
vec3 msLookup(float r, float muS) {
  return texture2D(uMsLUT, vec2(muS * 0.5 + 0.5, (r - ATM_RG) / (ATM_RT - ATM_RG))).rgb;
}
void main() {
  float az = vUv.x * vUv.x * ATM_PI;
  float vv = vUv.y - 0.5;
  float el = sign(vv) * (2.0 * vv) * (2.0 * vv) * 0.5 * ATM_PI;
  // directions in a frame where the sun lies in the +x/y plane
  vec3 sun = normalize(vec3(length(uSunDirA.xz), uSunDirA.y, 0.0));
  vec3 rd = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 ro = vec3(0.0, uCamR, 0.0);
  float tG = atmRaySphere(ro, rd, ATM_RG);
  float tT = atmRaySphere(ro, rd, ATM_RT);
  float tMax = tG > 0.0 ? tG : tT;
  tMax = min(tMax, 900.0);
  float cosT = dot(rd, sun);
  float pR = atmPhaseR(cosT), pM = atmPhaseM(cosT);
  const int N = 40;
  vec3 T = vec3(1.0), L = vec3(0.0);
  float tPrev = 0.0;
  for (int i = 0; i < N; i++) {
    // quadratic step distribution: dense near the viewer
    float x1 = (float(i) + 1.0) / float(N);
    float t1 = tMax * x1 * x1;
    float dt = t1 - tPrev;
    vec3 p = ro + rd * (tPrev + 0.5 * dt);
    tPrev = t1;
    float r = length(p);
    vec3 sR, sM, ext;
    atmMedium(r - ATM_RG, sR, sM, ext);
    vec3 sT = exp(-ext * dt);
    float muS = dot(p / r, sun);
    vec3 S = (sR * pR + sM * pM) * atmSunTrans(p, sun) + (sR + sM) * msLookup(r, muS);
    L += T * (S - S * sT) / max(ext, 1e-7);
    T *= sT;
  }
  gl_FragColor = vec4(L * uSunE, 1.0);
}
`;

function fsQuad(fragmentShader, uniforms) {
  const mat = new THREE.ShaderMaterial({ vertexShader: FS_QUAD_VS, fragmentShader, uniforms, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  return mesh;
}

function lutTarget(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
  });
}

export class Atmosphere {
  constructor(renderer, { mieScale = 2.2, mieH = MIE_DEFAULT.h, mieAlb = MIE_DEFAULT.alb, mieG = MIE_DEFAULT.g, mieAng = MIE_DEFAULT.ang, camAlt = CAMERA_ALT_KM } = {}) {
    this.renderer = renderer;
    this.mieScale = mieScale;
    this.mieH = mieH;
    this.mieSpec = mieSpectrum(mieAng);
    this.camAlt = camAlt;
    this.trans = lutTarget(256, 64);
    this.ms = lutTarget(32, 32);
    this.sky = lutTarget(192, 128);
    this.sky.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // uniforms other shaders can share (same objects, so updates propagate)
    this.uniforms = {
      uMieScale: { value: mieScale },
      uMieExt: { value: new THREE.Vector3(...this.mieSpec.map((k) => k * MIE_EXT)) },
      uMieH: { value: mieH },
      uMieAlb: { value: new THREE.Vector3(...mieAlb) },
      uMieG: { value: mieG },
      uTransLUT: { value: this.trans.texture },
      uMsLUT: { value: this.ms.texture },
      uSkyLUT: { value: this.sky.texture },
      uSunDirA: { value: new THREE.Vector3(0, 1, 0) },
      uSunE: { value: new THREE.Vector3(1, 1, 1).multiplyScalar(SUN_E0) },
      uCamR: { value: RG + camAlt },
      uGroundAlbedo: { value: 0.35 },   // a bright limestone city and dry hills
    };
    this.uniforms.uSunE.value.set(SUN_TINT.r * SUN_E0, SUN_TINT.g * SUN_E0, SUN_TINT.b * SUN_E0);
    this._transQuad = fsQuad(TRANS_FS, this.uniforms);
    this._msQuad = fsQuad(MS_FS, this.uniforms);
    this._skyQuad = fsQuad(SKY_FS, this.uniforms);
  }

  /** The passes this class renders (for compiling them up front). */
  passes() { return [this._transQuad, this._msQuad, this._skyQuad]; }

  /** Render the fixed LUTs (transmittance, multiple scattering): once, before first use. */
  renderLUTs() {
    this._renderQuad(this._transQuad, this.trans);
    this._renderQuad(this._msQuad, this.ms);
  }

  _renderQuad(mesh, target) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(target);
    r.render(mesh, this.camera);
    r.setRenderTarget(prev);
  }

  /** Re-render the sky-view LUT for a new sun direction (cheap: 192x128 texels). */
  updateSky(sunDir) {
    this.uniforms.uSunDirA.value.copy(sunDir);
    this._renderQuad(this._skyQuad, this.sky);
  }

  // ---- CPU mirror of the medium, for the sun light colour

  _ext(h) {
    const dR = Math.exp(-h / RAYLEIGH_H), dM = Math.exp(-h / this.mieH), dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
    const m = MIE_EXT * this.mieScale * dM;
    return [0, 1, 2].map((i) => RAYLEIGH[i] * dR + m * this.mieSpec[i] + OZONE[i] * dO);
  }

  /** Transmittance from the camera altitude towards a direction (y up), with a soft planet shadow. */
  transmittance(dir, altKm = this.camAlt, out = new THREE.Vector3()) {
    const r = RG + altKm;
    const mu = THREE.MathUtils.clamp(dir.y, -1, 1);
    // ray from (0, r, 0) along (sqrt(1-mu²), mu)
    const st = Math.sqrt(1 - mu * mu);
    const b = r * mu, c = r * r - RT * RT;
    const tMax = -b + Math.sqrt(b * b - c);
    const N = 64;
    const od = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      // quadratic distribution: most of the optical depth is low down
      const x0 = i / N, x1 = (i + 1) / N;
      const t0 = tMax * x0 * x0, t1 = tMax * x1 * x1, tm = 0.5 * (t0 + t1), dt = t1 - t0;
      const px = st * tm, py = r + mu * tm;
      const h = Math.sqrt(px * px + py * py) - RG;
      const e = this._ext(Math.max(h, 0));
      od[0] += e[0] * dt; od[1] += e[1] * dt; od[2] += e[2] * dt;
    }
    const sinH = RG / r, cosH = -Math.sqrt(1 - sinH * sinH);
    const vis = THREE.MathUtils.smoothstep(mu, cosH - SUN_ANGULAR_RADIUS, cosH + SUN_ANGULAR_RADIUS);
    return out.set(Math.exp(-od[0]) * vis, Math.exp(-od[1]) * vis, Math.exp(-od[2]) * vis);
  }

  dispose() {
    this.trans.dispose(); this.ms.dispose(); this.sky.dispose();
    for (const q of [this._transQuad, this._msQuad, this._skyQuad]) { q.geometry.dispose(); q.material.dispose(); }
  }
}

export { SUN_TRANS_GLSL };
