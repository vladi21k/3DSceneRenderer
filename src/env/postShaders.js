// GLSL for the post-processing chain (see post.js for the pass order).

export const QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// camera helpers shared by depth-aware passes
const CAMERA_GLSL = /* glsl */ `
uniform float uNear, uFar;
uniform vec2 uProjXY;          // projectionMatrix[0][0], [1][1]
float linearZ(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
vec3 viewPosFrom(vec2 uv, float z) {
  vec2 ndc = uv * 2.0 - 1.0;
  return vec3(ndc.x * z / uProjXY.x, ndc.y * z / uProjXY.y, -z);
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

// ---------------------------------------------------------------- depth → half-res linear Z
export const DEPTH_DOWN_FS = /* glsl */ `
${CAMERA_GLSL}
uniform sampler2D tDepth;
varying vec2 vUv;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  // nearest of the 2x2 footprint keeps thin poles and wires represented
  float d = min(min(texelFetch(tDepth, p, 0).r, texelFetch(tDepth, p + ivec2(1, 0), 0).r),
                min(texelFetch(tDepth, p + ivec2(0, 1), 0).r, texelFetch(tDepth, p + ivec2(1, 1), 0).r));
  gl_FragColor = vec4(d >= 1.0 ? 1e6 : linearZ(d), 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- SSAO (depth only, half res)
export const AO_FS = /* glsl */ `
${CAMERA_GLSL}
uniform sampler2D tZ;
uniform vec2 uTexel;       // 1 / half-res size
uniform float uRadius;     // world radius (m)
uniform float uIntensity;
uniform float uFocalPx;    // focal length in half-res pixels
varying vec2 vUv;
vec3 posAt(vec2 uv) { return viewPosFrom(uv, texture2D(tZ, uv).r); }
void main() {
  float z = texture2D(tZ, vUv).r;
  if (z > 1e5) { gl_FragColor = vec4(1.0, z, 0.0, 1.0); return; }
  vec3 P = viewPosFrom(vUv, z);
  // normal from the neighbours with the smaller depth step (avoids silhouette smearing)
  vec3 pl = posAt(vUv - vec2(uTexel.x, 0.0)), pr = posAt(vUv + vec2(uTexel.x, 0.0));
  vec3 pd = posAt(vUv - vec2(0.0, uTexel.y)), pu = posAt(vUv + vec2(0.0, uTexel.y));
  vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
  vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
  vec3 N = cross(dx, dy);
  N *= inversesqrt(max(dot(N, N), 1e-24));
  // the sampling disc is limited to 48 px: near the camera it covers a smaller world
  // radius, and the range check and normalisation follow that radius (else nearby
  // creases, like a figure's armpits, read the full radius as occluders and go black)
  float rPx = clamp(uRadius * uFocalPx / z, 1.5, 48.0);
  float R = rPx * z / uFocalPx;
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  float ao = 0.0;
  const float GA = 2.39996323;
  for (int i = 0; i < AO_SAMPLES; i++) {
    float fi = float(i) + 0.5;
    float rr = sqrt(fi / float(AO_SAMPLES)) * rPx;
    float a = fi * GA + rot;
    vec2 suv = vUv + vec2(cos(a), sin(a)) * rr * uTexel;
    vec3 S = posAt(suv);
    vec3 v = S - P;
    float vv = dot(v, v);
    // Alchemy AO term with a range check
    float o = max(dot(v, N) - 0.002 * z, 0.0) / (vv + 0.01 * R * R);
    o *= smoothstep(4.0 * R * R, 0.5 * R * R, vv);
    ao += o;
  }
  // lighter close up, where small geometry (figures, furniture) fills the disc
  float k = uIntensity * mix(0.55, 1.0, smoothstep(4.0, 16.0, z));
  ao = max(0.0, 1.0 - 2.0 * k * R * ao / float(AO_SAMPLES));
  ao = pow(ao, 1.4);
  // fade with distance (sub-pixel detail far away)
  ao = mix(ao, 1.0, smoothstep(140.0, 320.0, z));
  gl_FragColor = vec4(ao, z, 0.0, 1.0);
}
`;

export const AO_BLUR_FS = /* glsl */ `
uniform sampler2D tAO;
uniform vec2 uDir;         // texel step
varying vec2 vUv;
void main() {
  vec2 c = texture2D(tAO, vUv).rg;
  float z = c.y;
  float sum = c.x, w = 1.0;
  for (int i = -3; i <= 3; i++) {
    if (i == 0) continue;
    vec2 s = texture2D(tAO, vUv + uDir * float(i)).rg;
    float wd = exp(-abs(s.y - z) / (0.02 * z + 0.05)) * exp(-float(i * i) / 8.0);
    sum += s.x * wd; w += wd;
  }
  gl_FragColor = vec4(sum / w, z, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- scene prepass (full res)
// AO, aerial perspective, heat shimmer, lamp / headlight airlight; alpha = CoC (px)
export const PREPASS_FS = /* glsl */ `
${CAMERA_GLSL}
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform vec3 uSunDirA;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uAOStrength;
uniform vec2 uAOSize;
uniform vec3 uHazeExt;       // extinction per metre (rgb)
uniform float uHazeInscatter;
uniform sampler2D uSkyIrr;
uniform vec3 uSunGround;
uniform vec3 uHazeAmb;       // ambient in-scatter source (mean radiance seen by the street air)
uniform vec4 uHazePlane;     // air is sunlit where dot(p, xyz) + w > 0 (canyon shadow plane)
uniform float uHazeGap;      // sunlit share of distant air (cross streets, lower roofs)
uniform float uHazeSun;      // strength of the forward-scattered sun term
uniform float uShimmer;
uniform vec2 uResolution;
uniform float uDofK, uFocus, uCocMax, uCocTol;
uniform float uNightAir;
uniform float uClampHDR;     // highest value passed on (scene units; ~64 after exposure)
uniform vec3 uLampPos[NUM_LAMPS];
uniform float uLampI[NUM_LAMPS];
uniform vec3 uHeadPos, uHeadDir;
uniform float uHeadI;
uniform vec2 uHeadCos;
uniform float uMist;         // scattering coefficient for the airlight (1/m)
uniform sampler2D tClouds;
uniform int uUseClouds;
uniform vec4 uFarLamp[NUM_FAR];
uniform float uFarI;
uniform float uFarMin;       // the real lights cover everything nearer than this (m)
uniform vec2 uLampCos;
uniform float uWash;         // lanterns' sideways glow, as a share of their downward intensity
uniform sampler2D tSunVis;
uniform vec3 uGlareE;        // sun illuminance (rgb); 0 disables the glare
uniform vec4 uGlare;         // veiling glare: k1 / (theta^2 + theta0^2) + k2 exp(-theta / theta1)
varying vec2 vUv;

#define ATM_PI 3.14159265
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(i + vec2(1, 0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(i + vec2(0, 1), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(i + vec2(1, 1), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
}
// integral of clamp(x, 0, 1)
float rampInt(float x) { return x <= 0.0 ? 0.0 : (x < 1.0 ? 0.5 * x * x : x - 0.5); }
// finite and not negative (tested by bit pattern: compilers may fold isnan away)
bool finite3(vec3 c) {
  uvec3 b = floatBitsToUint(c) & 0x7f800000u;
  return !any(equal(b, uvec3(0x7f800000u))) && all(greaterThan(c, vec3(-1e-6)));
}
// in-scatter phase of the dry street air: a small isotropic share (molecules) and a
// forward lobe (dust), so a lamp's glow stays close to the line of sight to it
float airPhase(float c) {
  const float g = 0.72, g2 = g * g;
  return 0.25 / (4.0 * ATM_PI) + 0.75 * (1.0 - g2) / (4.0 * ATM_PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
// point light in-scatter along [0, T] of a ray: substituting t - tc = h tan(phi) turns
// the integral into (1/h) * integral of phase(-sin phi) dphi (6-point Gauss-Legendre).
// The lantern is a frosted globe, not a point: rays passing within its radius see the
// glow of a finite source (h is held at the globe's size), so no hot core forms
float pointAirlight(vec3 ro, vec3 rd, float T, vec3 lp) {
  vec3 w = lp - ro;
  float tc = dot(w, rd);
  float h = sqrt(dot(w - rd * tc, w - rd * tc) + 0.09);
  float a0 = atan(-tc / h), a1 = atan((T - tc) / h);
  float m = 0.5 * (a0 + a1), r = 0.5 * (a1 - a0);
  const vec3 X = vec3(0.2386191861, 0.6612093865, 0.9324695142);
  const vec3 W = vec3(0.4679139346, 0.3607615730, 0.1713244924);
  float s = 0.0;
  for (int i = 0; i < 3; i++) {
    s += W[i] * (airPhase(-sin(m + X[i] * r)) + airPhase(-sin(m - X[i] * r)));
  }
  return s * r / h;
}

void main() {
  vec2 uv = vUv;
  float d = texture2D(tDepth, uv).r;
  bool sky = d >= 1.0;
  float z = sky ? uFar : linearZ(d);
  vec3 vp = viewPosFrom(uv, z);
  float dist = length(vp);
  vec3 rd = normalize((uCamWorld * vec4(vp / dist, 0.0)).xyz);

  // heat shimmer: rays grazing the hot paving far away
  if (uShimmer > 0.0 && !sky) {
    vec3 wp = uCamPos + rd * dist;
    float m = smoothstep(70.0, 260.0, dist) * (1.0 - smoothstep(1.0, 7.0, wp.y - (uCamPos.y - 2.75)));
    if (m > 0.0) {
      vec2 q = uv * vec2(70.0, 210.0) * (uResolution.y / 1080.0);
      float t = uTime;
      vec2 o = vec2(vnoise(q + vec2(0.0, t * 2.3)) + 0.5 * vnoise(q * 2.1 + vec2(t * 0.7, t * 3.9)),
                    vnoise(q.yx * 0.7 + vec2(t * 1.9, 0.0)));
      uv += o * m * uShimmer / uResolution;
    }
  }
  vec3 col = texture2D(tScene, uv).rgb;
  // a non-finite or negative pixel (a broken normal or division somewhere upstream) is
  // filled from its finite neighbours instead of punching a black hole into the frame
  if (!finite3(col)) {
    vec2 px = 1.0 / uResolution;
    vec3 acc = vec3(0.0); float n = 0.0;
    for (int k = 0; k < 4; k++) {
      vec2 o = k == 0 ? vec2(px.x, 0.0) : k == 1 ? vec2(-px.x, 0.0) : k == 2 ? vec2(0.0, px.y) : vec2(0.0, -px.y);
      vec3 s = texture2D(tScene, vUv + o).rgb;
      if (finite3(s)) { acc += s; n += 1.0; }
    }
    col = n > 0.0 ? acc / n : vec3(0.0);
  }
  // volumetric cumulus over the sky (rgb = in-scattered light, a = transmittance)
  if (sky && uUseClouds > 0) {
    vec4 cl = texture2D(tClouds, vUv);
    col = col * min(cl.a, 1.0) + cl.rgb;
  }

#ifdef USE_AO
  if (!sky) {
    // depth-aware bilinear upsample of the half-res AO
    vec2 hp = vUv * uAOSize - 0.5;
    ivec2 i0 = ivec2(floor(hp));
    vec2 fr = fract(hp);
    ivec2 mx = ivec2(uAOSize) - 1;
    vec2 a00 = texelFetch(tAO, clamp(i0, ivec2(0), mx), 0).rg;
    vec2 a10 = texelFetch(tAO, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0).rg;
    vec2 a01 = texelFetch(tAO, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0).rg;
    vec2 a11 = texelFetch(tAO, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0).rg;
    vec4 bw = vec4((1.0 - fr.x) * (1.0 - fr.y), fr.x * (1.0 - fr.y), (1.0 - fr.x) * fr.y, fr.x * fr.y);
    vec4 dz = abs(vec4(a00.y, a10.y, a01.y, a11.y) - z);
    vec4 w = bw / (dz + 0.01 * z + 1e-3);
    float ao = dot(vec4(a00.x, a10.x, a01.x, a11.x), w) / max(dot(w, vec4(1.0)), 1e-6);
    col *= mix(1.0, ao, uAOStrength);
  }
#endif

  // night relighting in screen space, with an albedo estimated from the surface's
  // ambient-lit colour and a depth-reconstructed normal: distant lamp pools (beyond the
  // real lights), and the lanterns' sideways and upward glow on the nearer facades (the
  // real spot lights only light below the lanterns)
  bool farPools = uFarI > 0.0 && dist > uFarMin;
  bool wash = uWash > 0.0 && dist < 140.0;
  if (!sky && (farPools || wash)) {
    vec2 px = 1.0 / uResolution;
    float zl = linearZ(texture2D(tDepth, vUv - vec2(px.x, 0.0)).r), zr = linearZ(texture2D(tDepth, vUv + vec2(px.x, 0.0)).r);
    float zd = linearZ(texture2D(tDepth, vUv - vec2(0.0, px.y)).r), zu = linearZ(texture2D(tDepth, vUv + vec2(0.0, px.y)).r);
    vec3 pl = viewPosFrom(vUv - vec2(px.x, 0.0), zl), pr = viewPosFrom(vUv + vec2(px.x, 0.0), zr);
    vec3 pd = viewPosFrom(vUv - vec2(0.0, px.y), zd), pu = viewPosFrom(vUv + vec2(0.0, px.y), zu);
    vec3 dx = abs(zr - z) < abs(z - zl) ? pr - vp : vp - pl;
    vec3 dy = abs(zu - z) < abs(z - zd) ? pu - vp : vp - pd;
    vec3 nv = normalize(cross(dx, dy));
    vec3 nw = normalize((uCamWorld * vec4(nv, 0.0)).xyz);
    vec3 wp = uCamPos + rd * dist;
    // ambient the surface sees: the open sky on the paving, the canyon's sky slot on walls
    vec3 Eamb = mix(texture2D(uSkyIrr, vec2(3.5 / 8.0, 0.5)).rgb, texture2D(uSkyIrr, vec2(0.5 / 8.0, 0.5)).rgb * 0.7, clamp(nw.y, 0.0, 1.0)) + 1e-7;
    vec3 alb = clamp(col * ATM_PI / Eamb, vec3(0.03), vec3(0.6));
    float E = 0.0;
    if (farPools) {
      for (int i = 0; i < NUM_FAR; i++) {
        vec4 L = uFarLamp[i];
        if (L.w <= 0.0) continue;
        vec3 lv = L.xyz - wp;
        float r2 = dot(lv, lv);
        vec3 ld = lv * inversesqrt(max(r2, 1e-6));
        float cone = smoothstep(uLampCos.x, uLampCos.y, ld.y);   // surface below the lantern
        float win = clamp(1.0 - r2 * r2 / (32.0 * 32.0 * 32.0 * 32.0), 0.0, 1.0);
        // (finite source; the standard's own ironwork right around it is left dark)
        E += L.w * cone * max(dot(nw, ld), 0.0) * win * win * smoothstep(1.0, 4.0, r2) / (r2 + 0.09);
      }
      E *= uFarI;
    }
    if (wash) {
      float Ew = 0.0;
      for (int i = 0; i < NUM_LAMPS; i++) {
        if (uLampI[i] <= 0.0) continue;
        vec3 lv = uLampPos[i] - wp;
        float r2 = dot(lv, lv);
        vec3 ld = lv * inversesqrt(max(r2, 1e-6));
        // level with or above the lantern: outside the spot light's cone
        float side = 1.0 - smoothstep(0.1, 0.4, ld.y);
        float win = clamp(1.0 - r2 * r2 / (16.0 * 16.0 * 16.0 * 16.0), 0.0, 1.0);
        // a finite source, and none on the lantern's own cap, arm and the span wires
        // right next to it (their screen-space normals are meaningless anyway)
        Ew += uLampI[i] * side * max(dot(nw, ld), 0.0) * win * win * smoothstep(0.64, 2.25, r2) / (r2 + 0.09);
      }
      E += Ew * uWash;
    }
    col += alb * E * vec3(1.0, 0.64, 0.34) / ATM_PI;
  }

  // aerial perspective: extinction plus in-scatter. The ambient source is the mean
  // radiance the street air sees (sky slot, facades, paving; computed by env). The
  // forward-scattered sun only lights the part of the ray above the canyon's shadow
  // plane (analytic for a straight ray); far away, cross streets and lower roofs let
  // some sun through.
  if (!sky) {
    float cosT = dot(rd, uSunDirA);
    float g = 0.72, g2 = g * g;
    float ph = (1.0 - g2) / (4.0 * ATM_PI * pow(max(1.0 + g2 - 2.0 * g * cosT, 1e-4), 1.5));
    // soft plane: building heights vary, so the lit share ramps over ~6 m of height
    float a = (dot(uCamPos, uHazePlane.xyz) + uHazePlane.w) / 6.0 + 0.5;
    float b = dot(rd, uHazePlane.xyz) * dist / 6.0;
    float lit = abs(b) < 1e-3 ? clamp(a + 0.5 * b, 0.0, 1.0) : (rampInt(a + b) - rampInt(a)) / b;
    lit = max(lit, uHazeGap * smoothstep(80.0, 400.0, dist));
    vec3 inscat = uHazeAmb * uHazeInscatter + uSunGround * ph * lit * uHazeSun;
    vec3 T = exp(-uHazeExt * dist);
    col = col * T + inscat * (1.0 - T);
  }

  // lens veiling glare around a visible sun (scattering in the glass and barrel),
  // independent of the clamped bloom so the sun blows out as it does in any camera
  if (uGlareE.x + uGlareE.y + uGlareE.z > 0.0) {
    float vis = texture2D(tSunVis, vec2(0.5)).r;
    if (vis > 0.0) {
      float th = 2.0 * asin(clamp(length(rd - uSunDirA) * 0.5, 0.0, 1.0));
      col += uGlareE * vis * (uGlare.x / (th * th + uGlare.y) + uGlare.z * exp(-th / uGlare.w));
    }
  }

  // dusk airlight: haze around the lamps and the headlight beam
  if (uNightAir > 0.0) {
    float Tm = min(dist, 160.0);
    vec3 air = vec3(0.0);
    for (int i = 0; i < NUM_LAMPS; i++) {
      if (uLampI[i] <= 0.0) continue;
      air += vec3(1.0, 0.64, 0.34) * uLampI[i] * pointAirlight(uCamPos, rd, Tm, uLampPos[i]);
    }
    float hb = 0.0;
    float Th = min(dist, 70.0);
    float j = ign(gl_FragCoord.xy);
    for (int k = 0; k < 12; k++) {
      float t = (float(k) + j) / 12.0 * Th;
      vec3 v = uCamPos + rd * t - uHeadPos;
      float r2 = max(dot(v, v), 0.25);
      float cs = dot(v * inversesqrt(r2), uHeadDir);
      hb += smoothstep(uHeadCos.x, uHeadCos.y, cs) / r2;
    }
    air += vec3(1.0, 0.84, 0.68) * uHeadI * hb * Th / 12.0 / (4.0 * ATM_PI);
    col += air * uMist * uNightAir;
  }

  // scrub anything the passes above produced from a bad input, and clamp the range, so a
  // broken pixel or a specular spark cannot spread through the TAA, DOF, motion blur and
  // bloom chains
  if (!finite3(col)) col = vec3(0.0);
  col = clamp(col, vec3(0.0), vec3(uClampHDR));
  float coc = max(uDofK * abs(1.0 - uFocus / max(dist, 0.1)) - uCocTol, 0.0);
  gl_FragColor = vec4(col, min(coc, uCocMax));
}
`;


// ---------------------------------------------------------------- sun visibility (1x1)
// share of the sun disc seen through geometry and clouds, for the lens glare
export const SUNVIS_FS = /* glsl */ `
uniform sampler2D tDepth;
uniform sampler2D tClouds;
uniform int uUseClouds;
uniform vec2 uSunUV;         // sun centre in screen uv (may lie a little off screen)
uniform vec2 uSunR;          // sun angular radius in uv units
uniform float uFade;         // falloff for a sun just outside the frame
varying vec2 vUv;
void main() {
  float v = 0.0;
  const float GA = 2.39996323;
  for (int i = 0; i < 16; i++) {
    float fi = float(i) + 0.5;
    vec2 uv = uSunUV + vec2(cos(fi * GA), sin(fi * GA)) * sqrt(fi / 16.0) * uSunR;
    uv = clamp(uv, vec2(0.001), vec2(0.999));
    float t = step(1.0, texture2D(tDepth, uv).r);
    if (uUseClouds > 0) { float a = texture2D(tClouds, uv).a; t *= a > 1.5 ? 0.0 : clamp(a, 0.0, 1.0); }
    v += t;
  }
  gl_FragColor = vec4(v / 16.0 * uFade, 0.0, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------- depth of field (full res gather)
export const DOF_FS = /* glsl */ `
uniform sampler2D tSrc;      // rgb + CoC (px) in alpha
uniform vec2 uTexel;
varying vec2 vUv;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec4 c = texture2D(tSrc, vUv);
  float coc = c.a;
  if (coc < 0.55) { gl_FragColor = c; return; }
  float R = coc * 0.5;
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  vec3 acc = c.rgb;
  float wsum = 1.0;
  const float GA = 2.39996323;
  for (int i = 0; i < 16; i++) {
    float fi = float(i) + 0.5;
    float r = sqrt(fi / 16.0) * R;
    float a = fi * GA + rot;
    vec2 o = vec2(cos(a), sin(a)) * r;
    vec4 s = texture2D(tSrc, vUv + o * uTexel);
    // a sample only spreads as far as its own circle of confusion reaches
    float w = clamp(s.a * 0.5 - r + 0.75, 0.0, 1.0);
    acc += s.rgb * w; wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, coc);
}
`;

// ---------------------------------------------------------------- camera motion blur (full res)
// Each pixel's world position (from depth) is reprojected with last frame's camera; the
// screen motion, scaled to the shutter time, is averaged over 10 taps centred on the
// pixel. The sky is left alone (it is effectively at infinity).
export const MBLUR_FS = /* glsl */ `
${CAMERA_GLSL}
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform mat4 uPrevViewProj;
uniform vec2 uResolution;
uniform float uShutter;      // shutter time / frame time
uniform float uMaxPx;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tSrc, vUv);
  float d = texelFetch(tDepth, ivec2(gl_FragCoord.xy), 0).r;
  if (d >= 1.0) { gl_FragColor = c; return; }
  vec3 vp = viewPosFrom(vUv, linearZ(d));
  // camera-relative world offset keeps the precision of a nearby point
  vec3 rel = mat3(uCamWorld) * vp;
  vec4 pc = uPrevViewProj * vec4(uCamPos + rel, 1.0);
  if (pc.w <= 1e-4) { gl_FragColor = c; return; }
  vec2 prevUv = pc.xy / pc.w * 0.5 + 0.5;
  vec2 v = (vUv - prevUv) * uResolution * uShutter;
  float len = length(v);
  if (len < 0.5) { gl_FragColor = c; return; }
  v *= min(len, uMaxPx) / len;
  vec2 step = v / uResolution / 10.0;
  float j = ign(gl_FragCoord.xy) - 0.5;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float t = float(i) - 4.5 + j;
    acc += texture2D(tSrc, vUv + step * t).rgb;
  }
  gl_FragColor = vec4(acc * 0.1, c.a);
}
`;

// ---------------------------------------------------------------- bloom pyramid
// 13-tap dual-filter downsample (optionally Karis-weighted against fireflies)
export const DOWN_FS = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;     // source texel size
uniform float uKaris;
uniform float uClamp;
varying vec2 vUv;
vec3 tap(vec2 o) { return min(texture2D(tSrc, vUv + o * uTexel).rgb, vec3(uClamp)); }
float kw(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)) * uKaris); }
void main() {
  vec3 a = tap(vec2(-2, 2)), b = tap(vec2(0, 2)), c = tap(vec2(2, 2));
  vec3 d = tap(vec2(-2, 0)), e = tap(vec2(0, 0)), f = tap(vec2(2, 0));
  vec3 g = tap(vec2(-2, -2)), h = tap(vec2(0, -2)), i = tap(vec2(2, -2));
  vec3 j = tap(vec2(-1, 1)), k = tap(vec2(1, 1)), l = tap(vec2(-1, -1)), m = tap(vec2(1, -1));
  vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;
  float w0 = kw(g0) * 0.125, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.5;
  vec3 o = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  gl_FragColor = vec4(o, 1.0);
}
`;

// 9-tap tent upsample of the coarser level, blended with the finer level
export const UP_FS = /* glsl */ `
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 uTexel;     // low-res texel size
uniform float uScatter;
varying vec2 vUv;
void main() {
  vec4 d = vec4(1.0, 1.0, -1.0, 0.0) * uTexel.xyxy;
  vec3 s = texture2D(tLow, vUv - d.xy).rgb + texture2D(tLow, vUv - d.wy).rgb * 2.0 + texture2D(tLow, vUv - d.zy).rgb
         + texture2D(tLow, vUv + d.zw).rgb * 2.0 + texture2D(tLow, vUv).rgb * 4.0 + texture2D(tLow, vUv + d.xw).rgb * 2.0
         + texture2D(tLow, vUv + d.zy).rgb + texture2D(tLow, vUv + d.wy).rgb * 2.0 + texture2D(tLow, vUv + d.xy).rgb;
  s *= 1.0 / 16.0;
  gl_FragColor = vec4(mix(texture2D(tHigh, vUv).rgb, s, uScatter), 1.0);
}
`;

// ---------------------------------------------------------------- auto exposure (1x1)
export const LUM_FS = /* glsl */ `
uniform sampler2D tSmall;
uniform sampler2D tPrev;
uniform vec2 uSize;        // small mip size in texels
uniform float uRate;       // 0..1 blend towards the new value
varying vec2 vUv;
// r: weighted log-average luminance (metering); gba: plain mean colour of the frame (the
// light the lens scatters into a uniform veil)
void main() {
  float acc = 0.0, wsum = 0.0;
  vec3 mean = vec3(0.0);
  int W = int(uSize.x), H = int(uSize.y);
  for (int y = 0; y < 64; y++) {
    if (y >= H) break;
    for (int x = 0; x < 64; x++) {
      if (x >= W) break;
      vec2 uv = (vec2(x, y) + 0.5) / uSize;
      vec3 c = texelFetch(tSmall, ivec2(x, y), 0).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      vec2 q = uv - 0.5;
      float w = 1.0 - 1.6 * dot(q, q) + (uv.y < 0.5 ? 0.25 : 0.0);  // centre and lower half weigh more
      acc += log2(l + 1e-6) * w; wsum += w;
      mean += c;
    }
  }
  vec4 v = vec4(acc / max(wsum, 1e-4), mean / max(float(W * H), 1.0));
  vec4 prev = texture2D(tPrev, vec2(0.5));
  gl_FragColor = mix(prev, v, uRate);
}
`;

// ---------------------------------------------------------------- final: lens, tone map, grade
// Tone: a camera's JPEG response sets the luminance (mid grey 0.18 → ~0.47, white about
// 3.5 stops above it, a long toe: −3 stops still reads as dark grey), AgX sets hue and chroma (its log-domain
// curve keeps bright saturated colours from skewing), blended towards the scene's own
// ratios so warm low sun on stone keeps its colour. Luma-only sharpening stands in for
// in-camera sharpening.
export const FINAL_FS = /* glsl */ `
uniform sampler2D tHDR;
uniform sampler2D tBloom;
uniform sampler2D tLum;
uniform float uExposure;      // base exposure for the time of day
uniform float uExposureMax;   // ceiling of the metered exposure (low-sun highlight protection)
uniform float uAutoExp;       // strength of the auto-exposure correction
uniform float uMeterTarget;   // metered (log-average) luminance the correction aims for
uniform vec2 uMeterClamp;     // range of the auto-exposure correction
uniform float uBloom;
uniform float uVignette;
uniform float uCA;
uniform float uGrain;
uniform float uSharpen;       // unsharp mask amount (luma, ~1 px radius)
uniform float uTime;
uniform vec3 uWB;             // white balance gains (linear)
uniform float uSat;
uniform float uContrast;
uniform vec3 uShadowTint, uHighTint;
uniform vec4 uCurve;          // camera tone curve: A, s, e0, q (see below)
uniform float uChroma;        // 0 AgX's chroma .. 1 the scene's colour ratios
uniform vec2 uResolution;
uniform float uVeil;          // veiling glare: share of the frame's mean light spread evenly over it
uniform vec3 uVeilSun;        // plus light from a sun just outside the frame, scattered by the front glass
uniform vec2 uHiComp;         // highlight recovery: knee (stops over mid grey), log slope above it
uniform vec2 uCurveSlope;     // contrast in stops around a pivot (stops over mid grey): slope, pivot
varying vec2 vUv;

const mat3 PP_REC2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 PP_SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
// AgX with a slightly punchier look (more saturation and slope than the base curve)
vec3 agx(vec3 color) {
  const mat3 inset = mat3(
    vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
    vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(
    vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
    vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393, maxEv = 4.026069;
  color = PP_SRGB_TO_REC2020 * color;
  color = inset * color;
  color = max(color, 1e-10);
  color = clamp((log2(color) - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = agxContrast(color);
  // look: slope / power / saturation in the AgX log domain
  float l = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = pow(max(color, 0.0), vec3(uContrast));
  color = l + uSat * (color - l);
  color = outset * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  color = PP_REC2020_TO_SRGB * color;
  return clamp(color, 0.0, 1.0);
}
// display value (sRGB-encoded) of a scene luminance: a generalised logistic in stops
// from mid grey, y = min(1, A / (1 + exp(-s (e - e0)))^q)
float cameraCurve(float Y) {
  float e = log2(max(Y, 1e-8) / 0.18);
  e = uCurveSlope.y + (e - uCurveSlope.y) * uCurveSlope.x;
  return min(1.0, uCurve.x / pow(1.0 + exp(-uCurve.y * (e - uCurve.z)), uCurve.w));
}
float srgbToLinear(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
vec3 srgbOETF(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  vec2 uv = vUv;
  vec2 q = uv - 0.5;
  float r2 = dot(q * vec2(uResolution.x / uResolution.y, 1.0), q * vec2(uResolution.x / uResolution.y, 1.0));
  // lateral chromatic aberration, growing towards the corners; held back where the
  // pixel is a thin dark line across the radial direction (iron bars, wires), which a
  // channel shift would otherwise tear into colour fringes
  vec2 ca = q * r2 * uCA;
  vec4 c0 = texture2D(tHDR, uv);
  vec3 cr = texture2D(tHDR, uv + ca).rgb, cb = texture2D(tHDR, uv - ca).rgb;
  vec2 rd = normalize(q + 1e-6) * 1.5 / uResolution;
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  float l0 = dot(c0.rgb, LW), la = dot(texture2D(tHDR, uv + rd).rgb, LW), lb = dot(texture2D(tHDR, uv - rd).rgb, LW);
  float edge = max(max(la, lb), max(dot(cr, LW), dot(cb, LW)));
  float thin = smoothstep(0.85, 0.4, (l0 + 1e-5) / (max(min(la, lb), l0) + 1e-5)) + smoothstep(0.7, 0.3, (l0 + 1e-5) / (edge + 1e-5));
  float kca = 1.0 - clamp(thin, 0.0, 1.0);
  vec3 col = vec3(mix(c0.r, cr.r, kca), c0.g, mix(c0.b, cb.b, kca));
  // in-camera sharpening: luma unsharp mask in log space (exposure independent), the
  // boost limited to a third of a stop and faded out across strong edges (no halos)
  if (uSharpen > 0.0) {
    ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uResolution) - 1;
    float n = dot(texelFetch(tHDR, clamp(p + ivec2(1, 0), ivec2(0), mx), 0).rgb, LW)
            + dot(texelFetch(tHDR, clamp(p - ivec2(1, 0), ivec2(0), mx), 0).rgb, LW)
            + dot(texelFetch(tHDR, clamp(p + ivec2(0, 1), ivec2(0), mx), 0).rgb, LW)
            + dot(texelFetch(tHDR, clamp(p - ivec2(0, 1), ivec2(0), mx), 0).rgb, LW);
    float d = log2((l0 + 1e-4) / (0.25 * n + 1e-4));
    float k = uSharpen * (1.0 - smoothstep(0.8, 2.5, abs(d)));
    col *= exp2(clamp(k * d, -0.33, 0.33));
  }
  col = mix(col, texture2D(tBloom, uv).rgb, uBloom);

  // veiling glare: every lens (and the cab's glass in front of it) scatters a little of
  // the light it receives evenly over the frame, which lifts the deepest shadows off black
  vec4 lumv = texture2D(tLum, vec2(0.5));
  col += uVeil * lumv.gba + uVeilSun;

  // exposure: time-of-day base, nudged by the metered scene luminance
  float avgLog = lumv.r;
  float metered = exp2(avgLog) * uExposure;
  float corr = clamp(pow(uMeterTarget / max(metered, 1e-6), uAutoExp), uMeterClamp.x, uMeterClamp.y);
  col *= min(uExposure * corr, uExposureMax);
  // natural vignetting (cos^4-like falloff)
  col *= mix(1.0, pow(max(1.0 - r2 * 0.55, 0.0), 2.0), uVignette);
  // white balance and split toning in scene-linear
  col *= uWB;
  float lum = dot(col, LW);
  col *= mix(uShadowTint, uHighTint, smoothstep(0.05, 0.6, lum));
  lum = dot(col, LW);
  // highlight recovery (as a raw developer or a phone's tone mapping does): luminance
  // above the knee is compressed in log terms with a soft knee, so a bright evening sky
  // keeps its colour while the street stays exposed
  if (uHiComp.y < 1.0) {
    float e = 3.0 * (log2(max(lum, 1e-8) / 0.18) - uHiComp.x);
    float sp = (e > 20.0 ? e : log2(1.0 + exp2(e))) / 3.0;
    float k = exp2(-(1.0 - uHiComp.y) * sp);
    col *= k; lum *= k;
  }
  vec3 sc = max(col, 0.0);

  col = agx(col);
  // camera tone response on luminance, then a soft gamut knee: from 0.85 up, the spread of
  // the channels around the luminance is compressed so the brightest one approaches 0.98
  // (hue and luminance kept), instead of a channel clipping flat (a sunset sky's red)
  {
    float lt = srgbToLinear(cameraCurve(lum));
    float la = dot(col, LW);
    col = mix(col * (lt / max(la, 1e-7)), sc * (lt / max(lum, 1e-8)), uChroma);
    float m = max(col.r, max(col.g, col.b));
    if (m > 0.85) {
      float mt = 0.85 + 0.13 * (1.0 - exp(-(m - 0.85) / 0.13));
      col = lt + (col - lt) * clamp((mt - lt) / max(m - lt, 1e-5), 0.0, 1.0);
    }
  }
  col = srgbOETF(clamp(col, 0.0, 1.0));
  // fine film grain, strongest in the mid tones, plus dither
  float g = (hash(gl_FragCoord.xy + fract(uTime * 7.31) * 113.0) + hash(gl_FragCoord.xy * 1.37 + fract(uTime * 3.17) * 71.0) - 1.0);
  float lm = dot(col, vec3(0.333));
  col += g * uGrain * (0.35 + lm * (1.0 - lm) * 2.6);
  col += (hash(gl_FragCoord.xy + 0.5) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------- temporal anti-aliasing
// The scene is rendered with a sub-pixel jitter (Halton 2,3) and resolved against the
// history reprojected through depth and last frame's camera. The history is clipped to
// the current 3x3 neighbourhood (variance box in YCoCg, tone-mapped so a bright spark
// cannot dominate), sampled with a Catmull-Rom filter (no softening over time), and
// blended with ~10% of the new frame (more where the image moves fast). Alpha carries
// the circle of confusion through to the depth of field.
export const TAA_FS = /* glsl */ `
${CAMERA_GLSL}
uniform sampler2D tCur;
uniform sampler2D tHist;
uniform sampler2D tDepth;
uniform mat4 uCamWorld;
uniform mat4 uPrevVP;        // last frame's view-projection, relative to this frame's camera position
uniform vec2 uResolution;
uniform vec2 uJitter;        // this frame's jitter (NDC shift of the image)
uniform float uAlpha;        // weight of the new frame (1 = no history)
uniform float uGamma;        // variance clip width (standard deviations)
uniform float uExpo;         // exposure estimate, for the tone-mapped blend
varying vec2 vUv;

const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
vec3 toYCoCg(vec3 c) { return vec3(dot(c, vec3(0.25, 0.5, 0.25)), dot(c, vec3(0.5, 0.0, -0.5)), dot(c, vec3(-0.25, 0.5, -0.25))); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
vec3 tm(vec3 c) { return c * uExpo / (1.0 + dot(c, LW) * uExpo); }
vec3 itm(vec3 t) { return max(t, 0.0) / (uExpo * max(1.0 - dot(t, LW), 1e-3)); }
// 5-tap Catmull-Rom (bilinear taps at the combined weights)
vec3 histCR(vec2 uv) {
  vec2 sp = uv * uResolution;
  vec2 tp = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t12 = (tp + w2 / w12) / uResolution;
  vec2 t0 = (tp - 1.0) / uResolution, t3 = (tp + 2.0) / uResolution;
  float a = w12.x * w0.y, b = w0.x * w12.y, c = w12.x * w12.y, d = w3.x * w12.y, e = w12.x * w3.y;
  vec3 r = texture2D(tHist, vec2(t12.x, t0.y)).rgb * a + texture2D(tHist, vec2(t0.x, t12.y)).rgb * b
         + texture2D(tHist, t12).rgb * c + texture2D(tHist, vec2(t3.x, t12.y)).rgb * d
         + texture2D(tHist, vec2(t12.x, t3.y)).rgb * e;
  return max(r / (a + b + c + d + e), 0.0);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uResolution) - 1;
  vec4 c0 = texelFetch(tCur, p, 0);
  vec3 cur = toYCoCg(tm(c0.rgb));
  if (uAlpha >= 1.0) { gl_FragColor = c0; return; }
  // neighbourhood moments, and the nearest depth (edges move with the foreground)
  vec3 m1 = cur, m2 = cur * cur, lo = cur, hi = cur;
  float dMin = texelFetch(tDepth, p, 0).r;
  ivec2 pMin = p;
  for (int k = 0; k < 8; k++) {
    ivec2 o = k < 3 ? ivec2(k - 1, -1) : k < 5 ? ivec2(k == 3 ? -1 : 1, 0) : ivec2(k - 6, 1);
    ivec2 q = clamp(p + o, ivec2(0), mx);
    vec3 s = toYCoCg(tm(texelFetch(tCur, q, 0).rgb));
    m1 += s; m2 += s * s; lo = min(lo, s); hi = max(hi, s);
    float d = texelFetch(tDepth, q, 0).r;
    if (d < dMin) { dMin = d; pMin = q; }
  }
  // reproject (camera motion; the sky by rotation only)
  vec2 uvq = (vec2(pMin) + 0.5) / uResolution - 0.5 * uJitter;
  vec4 pc;
  if (dMin >= 1.0) pc = uPrevVP * vec4(mat3(uCamWorld) * normalize(viewPosFrom(uvq, 1.0)), 0.0);
  else pc = uPrevVP * vec4(mat3(uCamWorld) * viewPosFrom(uvq, linearZ(dMin)), 1.0);
  vec2 vel = pc.w > 1e-6 ? uvq - (pc.xy / pc.w * 0.5 + 0.5) : vec2(1e3);
  vec2 huv = vUv - vel;
  if (any(lessThan(huv, vec2(0.0))) || any(greaterThan(huv, vec2(1.0)))) { gl_FragColor = c0; return; }
  vec3 h = toYCoCg(tm(histCR(huv)));
  // clip the history towards the centre of the variance box (within the min/max box)
  vec3 mean = m1 / 9.0, sd = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
  vec3 bl = max(lo, mean - uGamma * sd), bh = min(hi, mean + uGamma * sd);
  vec3 cc = 0.5 * (bh + bl), ext = 0.5 * (bh - bl) + 1e-5;
  vec3 v = h - cc, a = abs(v / ext);
  float am = max(a.x, max(a.y, a.z));
  if (am > 1.0) h = cc + v / am;
  // more of the new frame where the image moves fast (less resampling blur)
  float velPx = length(vel * uResolution);
  float w = clamp(uAlpha + velPx * 0.006, uAlpha, 0.3);
  gl_FragColor = vec4(itm(fromYCoCg(mix(h, cur, w))), c0.a);
}
`;

// ---------------------------------------------------------------- debug: broken pixels
// (debug=1) count of non-finite or negative scene pixels per 8x8 block
export const BADPIX_FS = /* glsl */ `
uniform sampler2D tScene;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  ivec2 b = ivec2(gl_FragCoord.xy) * 8, mx = ivec2(uSize) - 1;
  float n = 0.0;
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
    vec3 c = texelFetch(tScene, min(b + ivec2(x, y), mx), 0).rgb;
    uvec3 e = floatBitsToUint(c) & 0x7f800000u;
    if (any(equal(e, uvec3(0x7f800000u))) || any(lessThan(c, vec3(-1e-6)))) n += 1.0;
  }
  gl_FragColor = vec4(n, 0.0, 0.0, 1.0);
}
`;
