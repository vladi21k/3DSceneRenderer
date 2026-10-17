import * as THREE from 'three';

// Materials for the crowd figures: MeshPhysicalMaterial (so the shared lighting, shadows,
// fog and environment all apply) patched with
//  - GPU skinning from a per-instance bone texture (instance transform folded in on the CPU)
//  - heavy/slim build morph, garment "ease" (clothes stand off the body), part toggling
//  - an analytic skirt / coat shell generated from (angle, length) vertex coordinates
//  - per-fragment clothing layout (sleeves, hems, necklines, patterns, shoes), face
//    painting (eyes, brows, lips, stubble), hair strands, fabric sheen and folds
//  - wrapped diffuse with a warm scatter tint on skin (cheap subsurface approximation)
// All colours / styles come from the per-agent look texture (appearance.js writeRow).

const COMMON = /* glsl */`
uniform highp sampler2D uBoneTex;
uniform highp sampler2D uLookTex;
uniform float uMorphScale;
uniform vec4 uShoulder;   // shoulder joint x, y, z, arm length (shoulder -> wrist)
uniform vec4 uArm;        // sin(abduction), cos(abduction), skirt part id, base kind (0 m, 1 f, 2 child)
uniform vec4 uLeg;        // hip joint x, y, knee y, ankle y
uniform vec4 uLeg2;       // ankle x, ankle z, knee x, knee z
uniform vec4 uTorso;      // crotch y, waist y, neck y, stature
uniform vec4 uSkirt0;     // waist ring: y, rx, rz, cz
uniform vec4 uSkirt1;     // hip ring: y, rx, rz, cz
uniform vec4 uHead;       // head centre (eye level) xyz, head scale
uniform vec4 uEye;        // right eye centre xyz, eyeball radius
vec4 hLook(int row, int i) { return texelFetch(uLookTex, ivec2(i, row), 0); }
float hSeg(vec3 p, vec3 a, vec3 b) { vec3 pa = p - a, ba = b - a; float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * t); }
// distance from the rest-pose leg axis (hip - knee - ankle)
float hLegDist(vec3 r) {
  float s = sign(r.x);
  vec3 hip = vec3(s * uLeg.x, uLeg.y, 0.0), knee = vec3(s * uLeg2.z, uLeg.z, uLeg2.w), ank = vec3(s * uLeg2.x, uLeg.w, uLeg2.y);
  return min(hSeg(r, hip + vec3(0.0, 0.1, 0.0), knee), hSeg(r, knee, ank));
}
float hTopHemY(float hem) { return uLeg.y - 0.035 + hem * (uTorso.y - uLeg.y + 0.035); }
float hLegHemY(float hem) { return hem < 0.02 ? uLeg.w - 0.02 : mix(uLeg.w + 0.03, uTorso.x - 0.02, hem); }  // 0 = full length, breaking over the shoe
// garment layout at a rest-pose point: x = layer (0 skin, 1 top, 2 bottom, 3 shoe, 4 under-shirt), y = signed
// distance (m) to the layer boundary (> 0 inside), z = which garment ease applies (0 none, 1 top, 2 bottom)
vec3 hGarment(vec3 r, float region, vec4 L2, vec4 L4, vec4 L8) {
  float topType = L2.w, botType = L4.w;
  float y = r.y;
  float topY = hTopHemY(L8.y);
  float hemY = hLegHemY(L8.z);
  float waist = uTorso.y + 0.012;
  float neck = uTorso.z;
  bool skirtLike = botType > 2.5 && botType < 3.5 || botType > 4.5;
  if (region == 1.0 || region == 19.0 || region == 20.0) {
    float front = smoothstep(0.0, -0.06, r.z);
    float scoop = (topType == 4.0 || topType == 7.0) ? 0.07 : topType == 3.0 ? 0.05 : (topType == 2.0 || topType == 1.0 ? 0.035 : 0.012);
    // neckline: a collar ring around the base of the neck, dipping at the front for scoop / V necks
    float sc = uTorso.w / 1.76;
    float rn = length(vec2(r.x / 0.085, (r.z - 0.02 * sc) / 0.075)) / sc;
    float nl = neck - 0.010 - scoop * front * smoothstep(0.11, 0.0, abs(r.x)) + 0.09 * smoothstep(0.9, 1.6, rn);
    float e = min(y - topY, nl - y);
    if (topType == 3.0) { // tank: oval arm holes leave ~3 cm straps over the shoulders
      vec2 ah = (vec2(abs(r.x), y) - vec2(uShoulder.x + 0.005 * sc, uShoulder.y - 0.035 * sc)) / (vec2(0.088, 0.125) * sc);
      e = min(e, (length(ah) - 1.0) * 0.09 * sc);
    }
    if (e > 0.0) {
      if (topType == 5.0) { // jacket: lapels open a V down to the button, shirt shows inside
        float button = uTorso.y + 0.07 * sc;
        float open = 0.058 * sc * smoothstep(button, neck - 0.06 * sc, y) * smoothstep(neck + 0.01, neck - 0.04 * sc, y) + 0.006;
        float ef = abs(r.x) - open;
        if (ef < 0.0 && r.z < -0.02 && y > button) return vec3(4.0, -ef, 1.0);
      }
      return vec3(1.0, e, 1.0);
    }
    if (y < waist) return vec3(2.0, waist - y, 2.0);
    return vec3(0.0, -e, 0.0);
  }
  if (region == 2.0) {
    if (topType == 2.0 || topType == 5.0 || topType == 1.0) {
      float e = neck + (topType == 1.0 ? 0.035 : 0.045) - y - 0.02 * smoothstep(0.0, -0.05, r.z);
      if (e > 0.0) return vec3(topType == 5.0 ? 4.0 : 1.0, e, 1.0);
    }
    if (topType == 6.0 && y < neck + 0.01) return vec3(1.0, neck + 0.01 - y, 1.0);
    return vec3(0.0, 0.0, 0.0);
  }
  if (region == 4.0 || region == 5.0 || region == 6.0) {
    float s = sign(r.x);
    vec3 sh = vec3(s * uShoulder.x, uShoulder.y, uShoulder.z);
    vec3 du = vec3(s * uArm.x, -uArm.y, 0.0);
    float t = dot(r - sh, du) / uShoulder.w;
    float sl = L8.x * 1.02;
    if (topType == 3.0) sl = -0.05;
    float e = (sl - t) * uShoulder.w;
    if (region == 6.0) e = min(e, -0.001);
    if (e > 0.0) return vec3(1.0, e, 1.0);
    return vec3(0.0, e, 0.0);
  }
  if (region == 7.0 || region == 8.0) {
    float et = y - topY;
    if (et > 0.0) return vec3(1.0, et, 1.0);   // long / untucked tops hang over the hips
    if (skirtLike) return vec3(0.0, -1.0, 0.0);
    float e = y - hemY;
    if (e > 0.0) return vec3(2.0, e, 2.0);
    return vec3(0.0, e, 0.0);
  }
  if (region == 9.0) {
    // full-length trousers break over the top of the shoe
    if (L8.z < 0.02 && !skirtLike && botType != 2.0 && y > uLeg.w - 0.004) return vec3(2.0, y - uLeg.w + 0.004, 2.0);
    return vec3(3.0, 1.0, 0.0);
  }
  return vec3(0.0, 0.0, 0.0);
}
`;

const VERT_PARS = /* glsl */`
${COMMON}
attribute float iRow;
attribute vec4 aNrm;
attribute vec4 aBoneI;
attribute vec4 aBoneW;
attribute vec4 aMorph;
attribute vec4 aBody;
varying vec3 vRest;
flat varying vec3 vIds;
varying float vAO;
varying vec2 vAux;
varying vec3 vHairT;
// per-figure face shape: nose length / width, jaw width, chin length, fuller cheeks (rest space)
vec3 hFace(vec3 pos, vec3 rest, float region, float build, float seed) {
  if (region != 3.0 && region != 17.0 && region != 18.0 && region != 16.0 && region != 10.0) return pos;
  float hs = uHead.w;
  vec3 q = (rest - uHead.xyz) / hs;
  float f1 = fract(seed * 7.13) - 0.5, f2 = fract(seed * 13.7) - 0.5, f3 = fract(seed * 23.1) - 0.5, f4 = fract(seed * 31.9) - 0.5;
  float wn = smoothstep(0.035, 0.0, length(q - vec3(0.0, -0.022, -0.10)));
  vec3 d = vec3(0.0);
  d.z -= f1 * 0.012 * wn;
  d.x += q.x * f2 * 0.9 * wn;
  float wj = smoothstep(-0.015, -0.085, q.y) * smoothstep(0.08, 0.02, q.z + 0.02);
  d.x += q.x * (f2 * 0.16 + max(build, 0.0) * 0.06) * wj;
  float wc = smoothstep(-0.075, -0.11, q.y) * smoothstep(0.0, -0.05, q.z);
  d.y -= f3 * 0.016 * wc;
  float wk = smoothstep(0.035, 0.0, length(vec2(abs(q.x) - 0.048, q.y + 0.03))) * smoothstep(-0.02, -0.06, q.z);
  d += normalize(vec3(sign(q.x), 0.0, -0.6)) * (f4 * 0.006 + max(build, 0.0) * 0.004) * wk;
  return pos + d * hs;
}
mat4 hBone(int row, float b) {
  int x = int(b + 0.5) * 3;
  vec4 r0 = texelFetch(uBoneTex, ivec2(x, row), 0);
  vec4 r1 = texelFetch(uBoneTex, ivec2(x + 1, row), 0);
  vec4 r2 = texelFetch(uBoneTex, ivec2(x + 2, row), 0);
  return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
}
void hSkin(out vec3 P, out vec3 N) {
  int row = int(iRow + 0.5);
  float region = aBody.x, part = aBody.y;
  vec4 L11 = hLook(row, 11);
  float bagPart = mod(L11.w, 256.0), skirtPart = floor(L11.w / 256.0 + 0.001);
  bool on = part < 0.5 || part == L11.x || part == L11.y || part == L11.z || part == bagPart
    || (part == skirtPart && part == uArm.z);
  vRest = position;
  vIds = vec3(region, part, float(row));
  vAO = aNrm.w;
  vAux = aBody.zw / 255.0;
  if (!on) { P = vec3(0.0, -500.0, 0.0); N = vec3(0.0, 1.0, 0.0); return; }
  vec3 pos = position;
  vec3 nrm = aNrm.xyz;
  vec4 W = aBoneW;
  vec4 I = aBoneI;
  vec4 L0 = hLook(row, 0);
  if (part == uArm.z && part > 0.5) {
    // analytic skirt / coat: position.x = angle around the body, position.y = 0 (waist) .. 1 (ankle)
    vec4 L9 = hLook(row, 9);
    float th = position.x;
    float t = min(position.y, L9.y);
    float y = mix(uSkirt0.x, uLeg.w + 0.03, t);
    float uh = smoothstep(0.0, 1.0, clamp((uSkirt0.x - y) / (uSkirt0.x - uSkirt1.x), 0.0, 1.0));
    vec3 ring = mix(uSkirt0.yzw, uSkirt1.yzw, uh);
    float below = max(0.0, uSkirt1.x - y);
    float ease = 0.014 + 0.022 * max(L0.w, 0.0);
    float fl = below * (0.03 + 0.20 * L9.z);
    float s = sin(th), c = cos(th);
    float fold = below * (0.020 + 0.03 * L9.z) * (0.6 * sin(th * 7.0 + 1.3) + 0.4 * sin(th * 11.0 + 0.4));
    float rx = ring.x + ease + fl + fold, rz = ring.y + ease + fl * 0.85 + fold;
    pos = vec3(s * rx, y, ring.z + c * rz);
    nrm = normalize(vec3(s * rz, (0.03 + 0.20 * L9.z) * 0.5, c * rx));
    vRest = pos;
    vAux = vec2(t, th);
    // pelvis on top, each side follows its thigh lower down
    float wt = 0.75 * smoothstep(uSkirt1.x + 0.02, uSkirt1.x - 0.30, y);
    float wl = wt * smoothstep(0.45, -0.45, s), wr = wt * smoothstep(-0.45, 0.45, s);
    W = vec4(1.0 - wl - wr, wl, wr, 0.0);
    I = vec4(1.0, 14.0, 18.0, 0.0);
  } else if (part < 0.5) {
    pos += aMorph.xyz * uMorphScale * L0.w;
    pos = hFace(pos, position, region, L0.w, hLook(row, 9).w);
#ifndef HUMAN_DEPTH
    // clothes stand off the skin: ease grows with looseness, with a lip at hems
    vec4 L2 = hLook(row, 2), L4 = hLook(row, 4), L8 = hLook(row, 8), L9 = hLook(row, 9);
    vec3 g = hGarment(position, region, L2, L4, L8);
    float sc = uTorso.w / 1.76;
    float ease = 0.0;
    bool isArm = region == 4.0 || region == 5.0;
    bool isLeg = region == 7.0 || region == 8.0;
    if (g.z == 1.0) {
      ease = 0.003 + 0.008 * L8.w + (L2.w == 5.0 ? 0.008 : 0.0);
      if (isArm) {
        // sleeves hang as tubes: fill out to a sleeve radius, wider at the opening
        float s = sign(position.x);
        float d = length(cross(position - vec3(s * uShoulder.x, uShoulder.y, uShoulder.z), vec3(s * uArm.x, -uArm.y, 0.0)));
        float R = (0.050 + 0.016 * L8.w) * sc * (L8.x < 0.6 ? 1.12 : 0.92);
        ease = max(ease, R - d);
      } else if (region != 20.0) {
        // shirts hang straight from chest to hem instead of following the waist
        float wy = abs(position.y - uTorso.y - 0.02) / (0.16 * sc);
        ease += L8.w * 0.016 * sc * (1.0 - smoothstep(0.0, 1.0, wy)) * (0.3 + 0.7 * smoothstep(0.06, -0.06, position.z));
      } else ease *= 0.5;
    } else if (g.z == 2.0) {
      float bt = L4.w;
      ease = bt == 0.0 ? 0.0035 : bt == 4.0 ? 0.0008 : bt == 2.0 ? 0.008 + 0.012 * L9.x : 0.004 + 0.008 * L9.x;
      if (isLeg && bt != 4.0) {
        // trouser legs fall straight from the seat: fill out to a target radius down the leg
        float d = hLegDist(position);
        float yk = (position.y - uLeg.z) / (uLeg.y - uLeg.z);
        float yh = (position.y - uLeg.w) / (uLeg.z - uLeg.w);
        float Rk = (0.064 + 0.016 * L9.x) * sc;
        float Rh = (bt == 0.0 ? 0.052 + 0.010 * L9.x : 0.056 + 0.016 * L9.x) * sc;
        float R = position.y > uLeg.z ? mix(Rk, 0.098 * sc, clamp(yk, 0.0, 1.0)) : mix(Rh, Rk, clamp(yh, 0.0, 1.0));
        if (bt == 2.0) R = (uArm.w == 0.0 ? 0.082 + 0.020 * L9.x : 0.070 + 0.012 * L9.x) * sc;
        ease = max(ease, R - d);
      }
      if (region == 1.0 || region == 19.0) ease = min(ease, 0.006);
    }
    ease *= smoothstep(-0.004, 0.022, g.y);
    // hide the body under skirts and long coats
    if (skirtPart == uArm.z && (region == 1.0 || region == 19.0 || isLeg)) {
      float hemY = mix(uSkirt0.x, uLeg.w + 0.03, L9.y);
      if (position.y < uTorso.y - 0.02 && position.y > hemY + 0.03) ease = -0.022 * sc * smoothstep(hemY + 0.03, hemY + 0.10, position.y);
    }
    pos += nrm * ease;
#endif
  }
  if (region == 12.0) pos = hFace(pos, position, 3.0, L0.w, hLook(row, 9).w);
  mat4 M = hBone(row, I.x) * W.x;
  if (W.y > 0.0) M += hBone(row, I.y) * W.y;
  if (W.z > 0.0) M += hBone(row, I.z) * W.z;
  if (W.w > 0.0) M += hBone(row, I.w) * W.w;
  P = (M * vec4(pos, 1.0)).xyz;
  N = normalize(mat3(M) * nrm);
  vHairT = vec3(0.0);
#ifndef HUMAN_DEPTH
  if (region == 11.0 || region == 12.0) {
    // hair strands run away from the crown along the surface (view space for the shader)
    vec3 crown = uHead.xyz + vec3(0.0, 0.10, 0.03) * uHead.w;
    vec3 d = position - crown;
    vec3 t = d - nrm * dot(d, nrm);
    t = dot(t, t) > 1e-8 ? normalize(t) : vec3(0.0, -1.0, 0.0);
    vHairT = normalize(mat3(viewMatrix) * (mat3(M) * t));
  }
#endif
}
`;

const FRAG_PARS = /* glsl */`
${COMMON}
varying vec3 vRest;
flat varying vec3 vIds;
varying float vAO;
varying vec2 vAux;
varying vec3 vHairT;
float hSkinM = 0.0;
float hHairM = 0.0;
vec3 hHairC = vec3(0.0);
// Kajiya-Kay style strand highlights: a white primary lobe shifted towards the root and a
// coloured, broader secondary lobe shifted towards the tip
vec3 hHairSpec(vec3 L, vec3 V, vec3 N, vec3 T) {
  vec3 H = normalize(L + V);
  vec3 t1 = normalize(T + N * 0.12), t2 = normalize(T - N * 0.18);
  float th1 = dot(t1, H), th2 = dot(t2, H);
  float s1 = pow(max(0.0, sqrt(max(0.0, 1.0 - th1 * th1))), 110.0);
  float s2 = pow(max(0.0, sqrt(max(0.0, 1.0 - th2 * th2))), 28.0);
  return vec3(0.09) * s1 + hHairC * 0.5 * s2;
}
float hSpec = 1.0;
vec3 hSheenC = vec3(0.0);
float hSheenR = 0.6;
float hAO = 1.0;
float hBump = 0.0;
float hH3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hH3(i), hH3(i + vec3(1, 0, 0)), f.x), mix(hH3(i + vec3(0, 1, 0)), hH3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hH3(i + vec3(0, 0, 1)), hH3(i + vec3(1, 0, 1)), f.x), mix(hH3(i + vec3(0, 1, 1)), hH3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float hAA(float e) { float w = max(fwidth(e) * 0.8, 1e-5); return smoothstep(-w, w, e); }
float hBand(float x, float period, float duty) {
  float f = fract(x / period);
  float w = max(fwidth(x / period) * 0.8, 1e-4);
  return smoothstep(0.5 - duty * 0.5 - w, 0.5 - duty * 0.5 + w, f) - smoothstep(0.5 + duty * 0.5 - w, 0.5 + duty * 0.5 + w, f);
}
// fabric: base albedo, roughness and sheen for a fabric code
void hFabric(float code, inout vec3 col, inout float rough) {
  if (code < 0.5) { rough = 0.86; hSheenC = mix(col, vec3(1.0), 0.25) * 0.35; hSheenR = 0.55; }       // cotton
  else if (code < 1.5) { rough = 0.9; hSheenC = mix(col, vec3(0.8), 0.4) * 0.25; hSheenR = 0.5; }     // denim
  else if (code < 2.5) { rough = 0.7; hSheenC = mix(col, vec3(1.0), 0.5) * 0.55; hSheenR = 0.35; }     // wool suiting
  else if (code < 3.5) { rough = 0.5; hSheenC = mix(col, vec3(1.0), 0.3) * 0.25; hSheenR = 0.4; hSpec = 1.0; } // synthetic
  else if (code < 4.5) { rough = 0.9; hSheenC = mix(col, vec3(1.0), 0.3) * 0.3; hSheenR = 0.6; }      // linen
  else { rough = 0.84; hSheenC = mix(col, vec3(1.0), 0.25) * 0.4; hSheenR = 0.5; }                      // knit
}
vec3 hTopColor(vec3 r, vec4 L2, vec4 L3, float seed) {
  vec3 col = L2.rgb;
  float pat = L3.w;
  float sc = uTorso.w / 1.76;
  if (pat == 1.0) col = mix(col, L3.rgb, hBand(r.y + 0.3, mix(0.018, 0.05, fract(seed * 7.3)) * sc, 0.45));
  else if (pat == 2.0) col = mix(col, L3.rgb, 0.7 * hBand(r.x + 0.5, 0.012, 0.18));
  else if (pat == 3.0) {
    float p = mix(0.03, 0.07, fract(seed * 3.1));
    float a = hBand(r.x + 0.5, p, 0.4), b = hBand(r.y, p, 0.4);
    col = mix(col, L3.rgb, 0.45 * a + 0.45 * b);
  } else if (pat == 4.0) {
    float n = hNoise(r * 38.0 + seed * 10.0) * 0.7 + hNoise(r * 90.0) * 0.3;
    col = mix(col, L3.rgb, hAA(n - 0.62));
  } else if (pat == 5.0) {
    float y0 = uTorso.z - 0.30 * sc, y1 = uTorso.z - 0.09 * sc;
    float e = min(min(r.y - y0, y1 - r.y), 0.085 * sc - abs(r.x));
    float on = hAA(e) * step(r.z, -0.03);
    // a simple chest print: emblem (ring / disc / bar) over a couple of lines of lettering
    vec2 c = vec2(r.x, r.y - (y0 + y1) * 0.5 - 0.035 * sc);
    float kind = floor(fract(seed * 17.0) * 3.0);
    float em = kind < 1.0 ? hAA(0.006 - abs(length(c) - 0.032 * sc)) : kind < 2.0 ? hAA(0.03 * sc - length(c))
      : hAA(0.012 * sc - abs(c.y)) * hAA(0.06 * sc - abs(c.x));
    float ty = r.y - y0 - 0.035 * sc;
    float txt = hAA(0.0055 - abs(ty - 0.012)) * hBand(r.x + 1.0, 0.011, 0.62) * hAA(0.05 * sc - abs(r.x))
      + hAA(0.004 - abs(ty + 0.004)) * hBand(r.x + 1.0, 0.008, 0.6) * hAA(0.035 * sc - abs(r.x));
    col = mix(col, L3.rgb, on * clamp(em + txt, 0.0, 1.0));
  }
  return col;
}
`;

const FRAG_SURFACE = /* glsl */`
{
  int row = int(vIds.z + 0.5);
  float region = vIds.x, part = vIds.y;
  vec3 r = vRest;
  vec4 L0 = hLook(row, 0), L1 = hLook(row, 1), L2 = hLook(row, 2), L3 = hLook(row, 3), L4 = hLook(row, 4);
  vec4 L5 = hLook(row, 5), L6 = hLook(row, 6), L7 = hLook(row, 7), L8 = hLook(row, 8), L9 = hLook(row, 9);
  vec4 L10 = hLook(row, 10), L11 = hLook(row, 11);
  float seed = fract(L9.w * 13.7 + float(row) * 0.618);
  vec3 skin = L0.rgb;
  vec3 col = skin;
  float rough = 0.5;
  float topFab = mod(L10.w, 8.0), botFab = floor(L10.w / 8.0 + 0.001);
  float sc = uHead.w;
  vec3 q = (r - uHead.xyz) / sc;          // head-local coordinates
  float skinAmt = 0.0;
  // ---- skin with subtle mottling and warm extremities
  vec3 skinCol = skin * (0.94 + 0.12 * hNoise(r * 55.0));
  if (part < 0.5) {
    vec3 g = hGarment(r, region, L2, L4, L8);
    float cover = hAA(g.y);
    float layer = g.x;
    vec3 cloth = vec3(0.0);
    float crough = 0.86;
    if (layer == 1.0 || layer == 4.0) {
      cloth = layer == 4.0 ? L3.rgb : hTopColor(r, L2, L3, seed);
      hFabric(layer == 4.0 ? 4.0 : topFab, cloth, crough);
      // folds: vertical drape on the torso, rings bunching around elbows and cuffs
      bool arm = region == 4.0 || region == 5.0;
      float drape = hNoise(vec3(r.x * 26.0, r.y * 3.0, r.z * 26.0)) - 0.5;
      float bunch = 0.0;
      if (arm) {
        float s = sign(r.x);
        float t = dot(r - vec3(s * uShoulder.x, uShoulder.y, uShoulder.z), vec3(s * uArm.x, -uArm.y, 0.0)) / uShoulder.w;
        bunch = sin(t * 95.0 + hNoise(r * 30.0) * 5.0) * (smoothstep(0.30, 0.45, t) * smoothstep(0.70, 0.52, t) + smoothstep(L8.x - 0.12, L8.x, t) * step(0.8, L8.x));
      } else {
        // bunching just above the hem / belt, and diagonal tension folds fanning from the armpits
        float hemY = hTopHemY(L8.y);
        bunch = sin(r.y * 150.0 + hNoise(r * 22.0) * 7.0) * smoothstep(0.09, 0.0, r.y - hemY) * smoothstep(-0.01, 0.01, r.y - hemY) * (0.4 + 0.8 * L8.w);
        vec2 ap = vec2(abs(r.x) - uShoulder.x * 0.8, r.y - (uShoulder.y - 0.13 * sc));
        float rad = length(ap);
        float ang = atan(ap.y, ap.x);
        float fan = sin(ang * 9.0 + hNoise(r * 15.0) * 3.0) * smoothstep(0.20 * sc, 0.04, rad) * smoothstep(0.0, 0.05, rad);
        bunch += fan * 0.8;
      }
      hBump = 0.0010 * drape + 0.0011 * bunch;
    } else if (layer == 2.0) {
      cloth = L4.rgb;
      hFabric(botFab, cloth, crough);
      if (botFab == 1.0) {
        // denim: twill + fading on the front of the thighs and knees, darker creases
        float tw = hBand(r.y * 1.0 + r.x * 1.0, 0.0022, 0.5);
        float fade = smoothstep(0.0, -0.08, r.z) * (smoothstep(uLeg.z - 0.02, uLeg.z + 0.20, r.y) * 0.6 + 0.4)
          * smoothstep(uTorso.x + 0.05, uTorso.x - 0.05, r.y);
        cloth *= (0.92 + 0.12 * tw) * (1.0 + 0.45 * fade * (0.6 + 0.4 * hNoise(r * 25.0)));
      }
      // folds: knees, crotch and bunching above the shoes; long vertical drape
      float drape = hNoise(vec3(r.x * 28.0, r.y * 4.0, r.z * 28.0)) - 0.5;
      float knee = smoothstep(0.09, 0.0, abs(r.y - uLeg.z - 0.02));
      float ankle = smoothstep(uLeg.w + 0.16, uLeg.w + 0.05, r.y) * step(L8.z, 0.05);
      float rings = sin(r.y * 120.0 + hNoise(r * 18.0) * 5.0);
      float back = smoothstep(-0.02, 0.04, r.z - uLeg2.w);      // more creasing behind the knee
      // crotch "whiskers": short diagonal folds radiating from the fly on the upper thighs
      vec2 cp = vec2(abs(r.x), r.y - uTorso.x);
      float whisk = sin(atan(cp.y, cp.x) * 14.0 + hNoise(r * 25.0) * 2.0) * smoothstep(0.17, 0.08, length(cp))
        * smoothstep(0.045, 0.08, length(cp)) * smoothstep(0.0, -0.04, r.z) * step(r.y, uTorso.x + 0.04) * step(botFab, 1.5) * step(0.5, botFab);
      hBump = 0.0013 * drape + 0.0011 * rings * (knee * (0.4 + 0.8 * back) + ankle) + 0.0008 * whisk;
      // belt / waistband
      float wb = hAA(0.018 - abs(r.y - uTorso.y + 0.006)) * step(r.y, uTorso.y + 0.04);
      if (wb > 0.0 && (region == 1.0 || region == 19.0)) {
        vec3 beltC = (uArm.w == 0.0 && L4.w < 2.5) ? mix(vec3(0.018, 0.012, 0.009), vec3(0.06, 0.035, 0.02), step(0.5, fract(seed * 3.7))) : cloth * 0.8;
        cloth = mix(cloth, beltC, wb);
        crough = mix(crough, 0.45, wb * step(L4.w, 2.5) * (1.0 - uArm.w));
      }
    } else if (layer == 3.0) {
      // shoes: upper, sole band, laces line; sandals show skin between straps
      float soleH = 0.024 * uTorso.w / 1.76;
      float sole = 1.0 - hAA(r.y - soleH);
      vec3 upper = L5.rgb;
      crough = L5.w == 1.0 ? 0.38 : 0.62;
      if (L5.w == 2.0) {
        float strap = max(hBand(r.z + 0.5, 0.045, 0.35), 1.0 - hAA(r.y - soleH - 0.012));
        upper = mix(skinCol, L5.rgb * 0.6, strap);
        crough = mix(0.5, 0.6, strap);
        skinAmt = 1.0 - strap;
      }
      cloth = mix(upper, L10.rgb, sole);
      crough = mix(crough, 0.8, sole);
      hSheenC = vec3(0.0);
    }
    if (layer > 0.5) {
      // contact shadow / thickness line at hems
      float lip = smoothstep(0.012, 0.0, abs(g.y));
      cloth *= 1.0 - 0.18 * lip * step(0.0, g.y);
      skinCol *= 1.0 - 0.35 * lip * step(g.y, 0.0);
    }
    col = mix(skinCol, cloth, cover * step(0.5, layer));
    rough = mix(0.5, crough, cover * step(0.5, layer));
    skinAmt = max(skinAmt, (1.0 - cover) + cover * step(layer, 0.5));
    if (layer < 0.5 || cover < 0.999) hSheenC *= cover;
    if (layer == 3.0) skinAmt = L5.w == 2.0 ? skinAmt : 0.0;
    // ---- face
    if (region == 3.0 || region == 16.0 || region == 17.0 || region == 18.0 || region == 10.0 || region == 2.0) {
      float ax = abs(q.x);
      float front = smoothstep(-0.03, -0.07, q.z);
      // brows
      float ad = (ax - 0.030) / 0.02;
      float arch = 0.0035 * (1.0 - ad * ad);
      float by = q.y - 0.014 - arch;
      float brow = hAA(0.0042 - abs(by)) * hAA(0.047 - ax) * hAA(ax - 0.008) * front;
      brow *= 0.65 + 0.35 * hNoise(vec3(q.x * 700.0, q.y * 120.0, 0.0));
      col = mix(col, L1.rgb * 0.8, brow * (uArm.w == 1.0 ? 0.8 : 0.9));
      // lips
      float lip = region == 17.0 ? 1.0 : 0.0;
      col = mix(col, skin * vec3(0.86, 0.66, 0.64), lip * 0.6);
      float mouth = hAA(0.0011 - abs(q.y + 0.0598)) * hAA(0.019 - ax) * front;
      col *= 1.0 - 0.6 * mouth;
      // cheeks / nose / ears a little warmer
      float warm = smoothstep(0.03, 0.0, length(vec2(ax - 0.045, q.y + 0.025))) * 0.5 + (region == 18.0 ? 0.35 : 0.0) + (region == 16.0 ? 0.3 : 0.0);
      col *= mix(vec3(1.0), vec3(1.06, 0.93, 0.92), warm);
      // nostrils
      float nos = hAA(0.0045 - length(vec2(ax - 0.0085, q.y + 0.037))) * step(q.z, -0.085);
      col *= 1.0 - 0.55 * nos;
      // stubble / beard shadow
      if (uArm.w == 0.0) {
        float jaw = smoothstep(-0.040, -0.058, q.y) * smoothstep(-0.02, -0.06, q.z + 0.0) * (1.0 - lip)
          + smoothstep(-0.03, -0.042, q.y) * smoothstep(0.012, 0.0, abs(q.y + 0.046)) * hAA(0.024 - ax) * front;
        jaw = clamp(jaw, 0.0, 1.0) * L1.w;
        col = mix(col, col * mix(vec3(1.0), L1.rgb * 2.2 + 0.25, 0.6), jaw * 0.55);
      }
      // eyes: sclera, iris, pupil inside the lid opening; lash line
      vec3 ec = vec3(sign(q.x) * abs(uEye.x - uHead.x) / sc, (uEye.y - uHead.y) / sc, (uEye.z - uHead.z) / sc);
      vec3 e = q - ec;
      float er = uEye.w / sc;
      float dx = e.x * sign(q.x);
      float up = 0.0043 - 9.0 * dx * dx, lo = -0.0036 + 7.0 * dx * dx;
      float lid = hAA(min(up - e.y, e.y - lo)) * step(length(e), er * 1.25) * step(e.z, 0.0);
      if (lid > 0.0) {
        float d = length(e.xy) / er;
        vec3 irisC = mix(vec3(0.05, 0.028, 0.016), vec3(0.16, 0.12, 0.06), fract(seed * 5.7));
        if (fract(seed * 11.3) > 0.88) irisC = vec3(0.10, 0.15, 0.18);
        vec3 eye = mix(vec3(0.42, 0.38, 0.35), irisC, hAA(0.56 - d));
        eye = mix(eye, vec3(0.01), hAA(0.22 - d));
        eye *= mix(0.45, 1.0, smoothstep(up, lo, e.y));    // upper lid and lashes shade the eye
        col = mix(col, eye, lid);
        rough = mix(rough, 0.08, lid);
        skinAmt *= 1.0 - lid;
      }
      float lash = hAA(0.0011 - abs(e.y - up)) * hAA(0.016 - abs(e.x)) * step(e.z, 0.0) * step(length(e), er * 1.6);
      col = mix(col, L1.rgb * 0.4, lash * 0.85);
      // sunglasses
      if (L6.w > 0.5) {
        vec2 le = vec2((dx + 0.002) / 0.0215, (e.y + 0.0015) / 0.0165);
        float lens = hAA(1.0 - length(le) - 0.15 * le.y * le.y * step(0.0, le.y)) * step(q.z, -0.05);
        float rim = hAA(0.0018 - abs(length(le) - 1.0) * 0.02) * step(q.z, -0.05);
        lens = max(lens, rim);
        float bridge = hAA(0.0016 - abs(q.y - 0.007)) * hAA(0.011 - ax) * step(q.z, -0.07);
        float gl = max(lens, bridge);
        col = mix(col, vec3(0.012, 0.013, 0.015), gl);
        rough = mix(rough, 0.22, gl);
        hSpec = mix(hSpec, 0.9, gl);
        skinAmt *= 1.0 - gl;
      }
    }
    // soft hairline: sparse hairs just below the edge of the hair part
    if (region == 3.0 && L11.x > 0.5 && L11.x != __SCARF__ && L11.x != __BALDING__) {
      float th = atan(abs(q.x), -q.z);
      float hl = th < 0.55 ? mix(0.058, 0.036, th / 0.55) : th < 1.05 ? mix(0.036, 0.022, (th - 0.55) / 0.5)
        : th < 1.33 ? mix(0.022, -0.014, (th - 1.05) / 0.28) : th < 1.58 ? mix(-0.014, 0.028, (th - 1.33) / 0.25)
        : th < 1.95 ? mix(0.028, -0.030, (th - 1.58) / 0.37) : mix(-0.030, -0.064, (th - 1.95) / 1.19);
      float band = smoothstep(hl - 0.014, hl + 0.003, q.y) * (0.55 + 0.25 * hNoise(q * 400.0));
      col = mix(col, L1.rgb * 0.9, band * 0.85);
      skinAmt *= 1.0 - band * 0.6;
    }
    // kippah on the crown
    if (L7.w > 0.5 && (region == 3.0)) {
      float k = hAA(0.052 - length(q - vec3(0.0, 0.088, 0.035)));
      col = mix(col, L7.rgb, k); rough = mix(rough, 0.8, k); skinAmt *= 1.0 - k;
    }
    // bag straps across the torso (backpack: two shoulder straps; shoulder bag: one diagonal strap)
    float bagPart = mod(L11.w, 256.0);
    if (bagPart > 0.5 && (region == 1.0 || region == 20.0) && uArm.w < 2.0) {
      float st = 0.0;
      if (bagPart == __BACKPACK__) st = hAA(0.018 - abs(abs(r.x) - 0.085)) * step(uTorso.y + 0.08, r.y);
      else if (bagPart == __SHOULDERBAG__) {
        float dd = (r.x * 0.62 + (r.y - uShoulder.y) * 0.78);
        st = hAA(0.013 - abs(dd + 0.02));
      }
      col = mix(col, L6.rgb * 0.8, st); rough = mix(rough, 0.6, st); skinAmt *= 1.0 - st; hSheenC *= 1.0 - st;
    }
  } else {
    // ---- parts
    float pr = region;
    if (pr == 11.0 || pr == 12.0) {
      // hair / beard: strands radiate from the crown and fall; clumps, then fine strands that
      // fade out when they get smaller than a pixel
      vec3 dq = q - vec3(0.0, 0.10, 0.03);
      float az = atan(dq.x, dq.z);
      float rr = length(dq);
      float fw = length(fwidth(r));
      float clump = hNoise(vec3(az * 13.0, rr * 28.0, 0.0));
      float strand = hNoise(vec3(az * 60.0, rr * 110.0, 3.0));
      float fine = mix(hNoise(vec3(r.x * 900.0, r.y * 70.0, r.z * 900.0)), 0.5, smoothstep(0.0006, 0.002, fw));
      strand = mix(strand, 0.5, smoothstep(0.002, 0.006, fw));
      float n = clump * 0.45 + strand * 0.35 + fine * 0.2;
      col = L1.rgb * (0.62 + 0.75 * n);
      hHairM = part == __SCARF__ ? 0.0 : 1.0;
      hHairC = L1.rgb * (0.8 + 0.4 * n) + 0.01;
      rough = 0.42;
      hSpec = 1.3;
      hSheenC = L1.rgb * 0.8 + 0.06; hSheenR = 0.35;
      if (part == __SCARF__) { col = L1.rgb * (0.9 + 0.15 * hNoise(r * 40.0)); rough = 0.85; hSpec = 0.8; hSheenC = col * 0.4; hSheenR = 0.55; }
      if (L7.w > 0.5 && pr == 11.0) {
        float k = hAA(0.054 - length(q - vec3(0.0, 0.092, 0.035)));
        col = mix(col, L7.rgb, k); rough = mix(rough, 0.8, k);
      }
    } else if (pr == 13.0) {
      col = L7.rgb; rough = 0.72;
      hSheenC = col * 0.6 + 0.04; hSheenR = 0.4;
      if (part == __SUNHAT__) { col *= 0.85 + 0.25 * hBand(atan(q.x, q.z) * 0.6 + length(q.xz) * 3.0, 0.02, 0.5); rough = 0.85; hSheenC *= 0.4; }
      if (vAux.y > 0.5) { col *= 0.35; } // hat band
    } else if (pr == 14.0) {
      col = L6.rgb * (0.92 + 0.12 * hNoise(r * 60.0)); rough = 0.55;
      if (part == __SHOPPING__) { rough = 0.35; hSpec = 1.2; }
      hSheenC = col * 0.2;
    } else if (pr == 15.0) {
      bool dress = L4.w > 4.5;
      col = dress ? hTopColor(vec3(r.x, r.y - 0.25, r.z), L2, L3, seed) : L4.rgb;
      hFabric(dress ? topFab : 4.0, col, rough);
      if (L2.w == 5.0) { col = L2.rgb; hFabric(2.0, col, rough); }
      col *= 1.0 - 0.15 * smoothstep(0.01, 0.0, abs(vAux.x - L9.y)) * 0.0;
    }
  }
  // wear and grime near the ground
  col *= 1.0 - 0.10 * smoothstep(0.25, 0.0, r.y) * (0.5 + 0.5 * L9.w) * (1.0 - skinAmt);
  hSkinM = skinAmt;
  if (skinAmt > 0.0) { rough = mix(rough, 0.46 - 0.06 * step(2.5, region) * step(region, 3.5), skinAmt); hSpec = mix(hSpec, 0.7, skinAmt); hSheenC *= 1.0 - skinAmt; }
  diffuseColor.rgb = clamp(col, vec3(0.012), vec3(0.82));
  roughnessFactor = rough;
  metalnessFactor = 0.0;
  hAO = mix(1.0, vAO * vAO, 0.75);
}
`;

const FRAG_BUMP = /* glsl */`
{
  // silhouettes: interpolated normals can face away from the eye, where the specular
  // visibility term blows up (half-float fireflies); bend them back towards the viewer
  vec3 vdir = normalize(vViewPosition);
  float nv = dot(normal, vdir);
  if (nv < 0.12) normal = normalize(normal + vdir * (0.12 - nv));
}
if (hBump != 0.0) {
  // bump from a procedural height, faded out where it would alias
  vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
  float fade = 1.0 - smoothstep(0.004, 0.012, length(fwidth(vRest)));
  float dhx = dFdx(hBump) * fade, dhy = dFdy(hBump) * fade;
  vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  vec3 nb = abs(det) * normal - grad;
  if (abs(det) > 1e-14 && dot(nb, nb) > 1e-30) normal = normalize(nb);
}
`;

function patchVertex(shader, depthOnly) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + VERT_PARS);
  if (depthOnly) {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      'vec3 hP, hN; hSkin(hP, hN);\nvec3 transformed = hP;');
  } else {
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', 'vec3 hP, hN; hSkin(hP, hN);\nvec3 objectNormal = hN;')
      .replace('#include <begin_vertex>', 'vec3 transformed = hP;');
  }
}

export function makeHumanMaterials(base, partIds, bones, look, morphScale) {
  const info = base.info;
  const sx = info.shoulder, H = info.H;
  const abd = (info.abd * Math.PI) / 180;
  const armLen = info.Lu + info.Lf;
  const ty = info.torsoY;
  const waistY = info.waistY;
  const kind = info.kind === 'male' ? 0 : info.kind === 'female' ? 1 : 2;
  const s = info.sx ?? 1;
  const uniforms = {
    uBoneTex: { value: bones },
    uLookTex: { value: look },
    uMorphScale: { value: morphScale },
    uShoulder: { value: new THREE.Vector4(sx[0], sx[1], sx[2], armLen) },
    uArm: { value: new THREE.Vector4(Math.sin(abd), Math.cos(abd), partIds.skirt || -1, kind) },
    uLeg: { value: new THREE.Vector4(info.hip[0], info.hip[1], info.knee[1], info.ankle[1]) },
    uLeg2: { value: new THREE.Vector4(info.ankle[0], info.ankle[2], info.knee[0], info.knee[2]) },
    uTorso: { value: new THREE.Vector4(ty[0], waistY, info.neckY, H) },
    uSkirt0: { value: new THREE.Vector4(waistY + 0.03 * s, 0.150 * s * (kind === 1 ? 0.9 : 1), 0.104 * s, -0.004) },
    uSkirt1: { value: new THREE.Vector4(info.hip[1] - 0.03 * s, (kind === 1 ? 0.200 : 0.190) * s, 0.136 * s, 0.024 * s) },
    uHead: { value: new THREE.Vector4(...info.headC, info.headS) },
    uEye: { value: new THREE.Vector4(...info.eyeR, info.eyeRadius) },
  };
  const subst = (src) => src
    .replace(/__BACKPACK__/g, (partIds.backpack || -1).toFixed(1))
    .replace(/__SHOULDERBAG__/g, (partIds.shoulderbag || -1).toFixed(1))
    .replace(/__SCARF__/g, (partIds.scarf || -1).toFixed(1))
    .replace(/__BALDING__/g, (partIds.hair_balding || -1).toFixed(1))
    .replace(/__SUNHAT__/g, (partIds.sunhat || -1).toFixed(1))
    .replace(/__SHOPPING__/g, (partIds.shopping || -1).toFixed(1));
  const fragSurface = subst(FRAG_SURFACE);

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.6, metalness: 0, sheen: 1, sheenRoughness: 0.6, sheenColor: 0x000000,
    specularIntensity: 1, ior: 1.5,
  });
  mat.name = 'humans.' + info.kind;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchVertex(shader, false);
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + FRAG_PARS);
    fs = fs.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + fragSurface);
    fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_BUMP);
    fs = fs.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      material.specularColor *= hSpec;
      material.specularColorBlended *= hSpec;
      #ifdef USE_SHEEN
        material.sheenColor = hSheenC;
        material.sheenRoughness = hSheenR;
      #endif`);
    // wrapped diffuse + warm scatter on skin (shadowed light still wraps a little at the terminator)
    const pars = THREE.ShaderChunk.lights_physical_pars_fragment;
    const key = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );\n\tvec3 irradiance = dotNL * directLight.color;';
    if (pars.includes(key)) {
      fs = fs.replace('#include <lights_physical_pars_fragment>', pars.replace(key,
        `float dotNLr = dot( geometryNormal, directLight.direction );
        float dotNL = saturate( dotNLr );
        float wrapNL = saturate( ( dotNLr + 0.45 ) / 1.45 );
        vec3 irradiance = mix( vec3( dotNL ), vec3( dotNL ) * 0.7 + wrapNL * vec3( 0.38, 0.17, 0.11 ), hSkinM ) * directLight.color;
        if ( hHairM > 0.0 && dot( vHairT, vHairT ) > 0.5 ) reflectedLight.directSpecular += hHairM * hHairSpec( directLight.direction, geometryViewDir, geometryNormal, normalize( vHairT ) ) * saturate( dotNLr + 0.25 ) * directLight.color;`));
    }
    fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      reflectedLight.indirectDiffuse *= hAO;
      reflectedLight.indirectSpecular *= hAO;
      reflectedLight.directDiffuse *= mix(1.0, hAO, 0.35);`);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'humans-v1-' + info.kind;

  const depth = new THREE.MeshDepthMaterial();
  depth.name = 'humans.depth.' + info.kind;
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchVertex(shader, true);
    // shadows do not need the garment ease (sub-centimetre at shadow-map resolution)
    shader.vertexShader = '#define HUMAN_DEPTH\n' + shader.vertexShader;
  };
  depth.customProgramCacheKey = () => 'humans-depth-v1-' + info.kind;
  return { mat, depth, uniforms };
}
