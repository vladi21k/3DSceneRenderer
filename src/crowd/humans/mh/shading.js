import * as THREE from 'three';
import { U } from '../../../core/uniforms.js';

// Shading of the crowd figures (the MakeHuman-based cast, assets/humans_mh), drawn by mh/batch.js as
// one multi-draw per pass: every sub-draw is one figure (or one of its accessories) and gl_DrawID
// picks its bone row through the batch's indirect texture.
//
// Vertex: 4-bone skinning from the bone texture (22 bones x 3 texels of a 3x4 matrix that already
// carries the figure's world placement, then 2 state texels); skirts are kept outside the thigh
// capsules (flag 8); hands tuck into the pockets in the hands-in-pockets stance.
// Fragment (MeshPhysicalMaterial patched):
//   albedo from the texture array layer x the wearer's region tint (detail layers: 2 x texel x tint),
//     garment patterns (stripes, checks, prints) in the garment's rest space, untextured accessories
//   skin: wrapped diffuse with a warm scatter term at the terminator, a skin-level specular (F0 ~0.028)
//   eyes: wet (smooth, full specular); hair, brows, beard: Kajiya-Kay strand highlights along the cards'
//     strand direction (from the UV gradient), alpha to coverage rounded to the MSAA sample count
//   cloth: sheen (fibre retro-reflection at grazing angles), normal maps of the garments, shoes and hats
//   baked ambient occlusion on the indirect light (and some of the direct); a lit phone screen

export const NB = 22;
export const BONE_DYN = NB * 3;          // first state texel of a bone row
export const BONE_W = BONE_DYN + 3;      // texels per bone row
export const LOOK_W = 34;                // texels per look row (see writeLook)
const REGION_ROUGH = [-1, 0.5, 0.8, 0.8, 0.06, -1, -1, -1, -1, 0.95, -1, 0.85, 0.32, 0.08, 0.55, 0.7];
// specular strength per region (x the dielectric F0 0.04)
const REGION_SPEC = [0.72, 0.05, 0.3, 0.3, 1.1, 0.55, 0.55, 0.55, 0.9, 0.5, 0.5, 0.3, 1.0, 1.2, 0.75, 0.6];
// (casts with skin decals: wetter eyes, matte brows and beards)
const REGION_ROUGH_V2 = [-1, 0.6, 0.85, 0.8, 0.035, -1, -1, -1, -1, 0.95, 0.8, 0.8, 0.32, 0.08, 0.5, 0.6];
// (eyes: a wet cornea, but the sky's sheen over the whole eye would wash the iris out to a grey stare)
const REGION_SPEC_V2 = [0.72, 0.05, 0.2, 0.3, 0.7, 0.55, 0.55, 0.55, 0.9, 0.5, 0.3, 0.2, 1.0, 1.2, 0.75, 0.6];

const COMMON = /* glsl */`
uniform highp sampler2D uBoneTex;
uniform highp sampler2D uLookTex;
vec4 hLook(int row, int i) { return texelFetch(uLookTex, ivec2(i, row), 0); }
`;

const VERT_PARS = /* glsl */`
${COMMON}
attribute vec4 aNrm;
attribute vec4 aBoneI;
attribute vec4 aBoneW;
attribute vec4 aTex;
varying vec2 vCastUv;
flat varying vec4 vCastTex;
flat varying float vRow;
varying float vCastAO;
varying vec3 vRest;
varying float vBeard;
varying float vDecal;
varying vec3 vStrand;
varying vec2 vHairQ;
flat varying vec4 vFill;     // the slot's indoor light: fill irradiance / pi (rgb), how much sky it loses (w)
uniform float uDecal;        // the cast carries skin decals (tex.y of skin: 128 none, > beard, < scalp)
uniform float uBeardBase;    // beards are shells grown here from their base (uv = length, density; flags >> 4 = shell)
mat4 hBone(int row, float b) {
  int x = int(b + 0.5) * 3;
  vec4 r0 = texelFetch(uBoneTex, ivec2(x, row), 0);
  vec4 r1 = texelFetch(uBoneTex, ivec2(x + 1, row), 0);
  vec4 r2 = texelFetch(uBoneTex, ivec2(x + 2, row), 0);
  return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
}
// pushes a posed point out of a tapered capsule
vec3 hPush(vec3 P, vec3 a, vec3 b, float ra, float rb) {
  vec3 ab = b - a;
  float t = clamp(dot(P - a, ab) / dot(ab, ab), 0.0, 1.0);
  vec3 c = a + ab * t;
  vec3 d = P - c;
  float l = length(d), r = mix(ra, rb, t);
  return l < r && l > 1e-5 ? c + d * (r / l) : P;
}
// The person's own face: smooth displacements of the rest pose round the character's landmarks (look
// texels 28-32: nose tip, head scale, mouth and chin heights; the person's coefficients -1..1). Every part
// near the face moves with the skin (eyes, lashes, brows, beard, hair), so nothing parts from it.
vec3 hFaceWarp(vec3 p, vec3 n, int row) {
  vec4 F0 = hLook(row, 28);
  if (F0.w <= 0.0) return p;
  float hk = F0.w;
  vec4 F1 = hLook(row, 29), K0 = hLook(row, 30), K1 = hLook(row, 31), K2 = hLook(row, 32);
  vec4 Eo = hLook(row, 25);
  float ey = Eo.y, ny = F0.y, nz = F0.z, my = F1.x, cy = F1.y;
  vec3 q = p - vec3(0.0, ny, nz);
  // (the face only: in front of the ears, from above the brows to below the chin)
  if (q.z > 0.14 * hk || p.y > ey + 0.08 * hk || p.y < cy - 0.06 * hk || abs(p.x) > 0.11 * hk) return p;
  float ax = abs(p.x), sx = p.x < 0.0 ? -1.0 : 1.0;
  float front = 1.0 - smoothstep(0.06 * hk, 0.13 * hk, q.z);
  float above = smoothstep(cy - 0.05 * hk, cy - 0.005 * hk, p.y);          // fades out under the chin
  vec3 d = vec3(0.0);
  // nose: wider or narrower round its middle; longer (the tip lower and further out) or shorter
  vec3 r = (p - vec3(0.0, mix(ey, ny, 0.65), nz + 0.012 * hk)) / (0.021 * hk);
  float gn = exp(-dot(r, r));
  r = q / (0.015 * hk);
  float gt = exp(-dot(r, r));
  d.x += K0.x * 0.2 * p.x * gn;
  d.y -= K0.y * 0.0032 * hk * (gn * 0.5 + gt);
  d.z -= K0.y * 0.0025 * hk * gt;
  // lower face: the jaw wider or narrower (most towards its angles), the chin longer or shorter, the whole
  // face below the nose longer or shorter
  float lower = (1.0 - smoothstep(my, ey - 0.02 * hk, p.y)) * above;
  float jawF = 1.0 - smoothstep(0.09 * hk, 0.14 * hk, q.z);
  d.x += K0.z * 0.075 * p.x * lower * jawF * (0.4 + 0.6 * smoothstep(0.015 * hk, 0.07 * hk, ax));
  float chin = (1.0 - smoothstep(cy, my, p.y)) * (1.0 - smoothstep(0.03 * hk, 0.08 * hk, q.z)) * above;
  d.y -= K0.w * 0.006 * hk * chin;
  d.z -= K0.w * 0.0025 * hk * chin;
  d.y += K1.y * 0.05 * min(0.0, p.y - ny) * front * above;
  // cheeks fuller or hollower (out along the skin's normal)
  r = vec3(ax - 0.042 * hk, p.y - (ey - 0.03 * hk), p.z - (nz + 0.04 * hk)) / (0.024 * hk);
  d += n * (K1.x * 0.0032 * hk * exp(-dot(r, r)));
  // brows higher or lower (and the brow ridge with them)
  r = vec3(ax - 0.03 * hk, p.y - (ey + 0.022 * hk), p.z - (nz + 0.03 * hk)) / (0.02 * hk);
  float gb = exp(-dot(r, r));
  d.y += K1.z * 0.0025 * hk * gb;
  d.z -= K1.z * 0.0012 * hk * gb;
  // lips fuller or thinner
  r = (p - vec3(0.0, my, nz + 0.017 * hk)) / (0.016 * hk);
  float gl = exp(-dot(r, r));
  d.z -= K1.w * 0.0018 * hk * gl;
  d.y += K1.w * 0.13 * (p.y - my) * gl;
  // the face wider or narrower across the cheekbones; the eyes set wider or closer
  d.x += K2.x * 0.045 * p.x * front * (1.0 - smoothstep(ey + 0.02 * hk, ey + 0.07 * hk, p.y)) * above;
  r = vec3(ax - Eo.x, p.y - ey, p.z - Eo.z) / (0.022 * hk);
  d.x += sx * K2.y * 0.0022 * hk * exp(-dot(r, r));
  return p + d;
}
void hSkin(out vec3 P, out vec3 N) {
  int brow = int(getIndirectIndex(gl_DrawID) + 0.5);
  vec4 D0 = texelFetch(uBoneTex, ivec2(${BONE_DYN}, brow), 0);   // gait phase, speed, seated blend, ground y
  vec4 D1 = texelFetch(uBoneTex, ivec2(${BONE_DYN + 1}, brow), 0); // look row, phone shown, hands in pockets, scale
  int row = int(D1.x + 0.5);
  vFill = texelFetch(uBoneTex, ivec2(${BONE_DYN + 2}, brow), 0);
  vec4 W = aBoneW / max(aBoneW.x + aBoneW.y + aBoneW.z + aBoneW.w, 1e-4);
  mat4 m = hBone(brow, aBoneI.x) * W.x + hBone(brow, aBoneI.y) * W.y + hBone(brow, aBoneI.z) * W.z + hBone(brow, aBoneI.w) * W.w;
  vec3 pos = hFaceWarp(position, aNrm.xyz, row);
  int flags = int(aTex.w + 0.5);
  // hands in the pockets: the hands fold into the trousers about the wrist
  if (D1.z > 0.01 && W.x > 0.5 && (aBoneI.x == 9.0 || aBoneI.x == 13.0) && aTex.z < 0.5) {
    vec3 wr = hLook(row, aBoneI.x == 9.0 ? 22 : 23).xyz;
    pos = mix(pos, wr + (pos - wr) * vec3(0.55, 0.35, 0.55), D1.z);
  }
  // legs under a skirt or dress: the thighs shrink towards their axis above the hem, so a striding
  // or shifting leg cannot poke through the cloth
  float hemY = hLook(row, 22).w;
  if (hemY > 0.0 && aTex.z < 0.5 && pos.y > hemY + 0.012 && (aBoneI.x == 14.0 || aBoneI.x == 18.0 || aBoneI.x == 1.0)) {
    int sd = pos.x < 0.0 ? 0 : 1;
    vec3 ha = hLook(row, 18 + sd * 2).xyz, kb = hLook(row, 19 + sd * 2).xyz;
    if (pos.y < ha.y + 0.03) {
      vec3 ab = kb - ha;
      vec3 c = ha + ab * clamp(dot(pos - ha, ab) / dot(ab, ab), 0.0, 1.0);
      pos = c + (pos - c) * (1.0 - 0.3 * smoothstep(hemY + 0.012, hemY + 0.06, pos.y));
    }
  }
#if HUMANS_V2
  // (long skirts: the calves under the cloth thin towards the shin's axis too)
  if (hemY > 0.0 && aTex.z < 0.5 && pos.y > hemY + 0.01 && (aBoneI.x == 15.0 || aBoneI.x == 19.0)) {
    int sd = pos.x < 0.0 ? 0 : 1;
    vec3 kb = hLook(row, 19 + sd * 2).xyz;
    vec3 c = vec3(kb.x, pos.y, kb.z + 0.01);
    pos = c + (pos - c) * (1.0 - 0.3 * smoothstep(hemY + 0.01, hemY + 0.05, pos.y));
  }
#endif
#if HUMANS_V2
  if ((flags & 8) != 0 && D0.y > 0.05) {
    // a walking skirt's hem trails a little and swings with the stride (more towards the hem)
    float top = hLook(row, 18).y;
    float u = clamp((top - pos.y) / max(0.05, top - max(hemY, 0.05)), 0.0, 1.0);
    float v = min(D0.y, 2.0);
    float ph = 6.2831853 * D0.x;
    pos.z += u * u * v * (0.018 + 0.006 * cos(2.0 * ph));
    pos.x += u * u * v * 0.008 * sin(ph + 0.6);
  }
#endif
  // beard shells: grown out along the skin normal by the beard's length there, the strands curving
  // down as they grow (the base position stays the strands' root for the fragment shader)
  float shellH = 0.0;
  if (uBeardBase > 0.5 && aTex.z == 11.0) {
    shellH = float((flags >> 4) & 15) / 15.0;
    float len = uv.x * 0.04;
    vec3 bn = normalize(aNrm.xyz);
    pos += bn * (0.0004 + len * shellH * 0.6) + vec3(0.0, -1.0, -0.15) * len * shellH * shellH * 0.35;
  }
  P = (m * vec4(pos, 1.0)).xyz;
  vec3 nrm = aNrm.xyz;
  // strand direction (rest space): hair runs from the crown out and down over the head, across each
  // card (never from the cards' UVs, whose layout is mirrored on one side of the head); beard hairs
  // run down the face, tilting out as they grow
  vStrand = vec3(0.0);
  bool hCardV = aTex.z == 1.0 && (flags & 64) != 0;
  if (hCardV) {
    // strand cards (cast feature strandCards): the strand runs along the card's v (the fragment shader
    // takes it from the uv derivatives); clump noise in card space (across: atlas u, along: v)
    vHairQ = vec2(uv.x * 0.16 + aTex.y * 0.0137, uv.y * 0.3);
  } else if (aTex.z == 1.0 || aTex.z == 11.0) {
    vec3 hc = hLook(row, 24).xyz;
    float hk = hLook(row, 17).y / 1.76;
    vec3 dir = aTex.z == 1.0 ? position - (hc + vec3(0.0, 0.06 * hk, 0.012 * hk)) : vec3(0.0, -1.0, 0.0) + normalize(nrm) * shellH * 0.5;
    vec3 nn = normalize(nrm);
    dir -= nn * dot(dir, nn);
    if (dot(dir, dir) < 1e-10) dir = vec3(0.0, -1.0, 0.0);
    vStrand = normalize(mat3(modelViewMatrix) * (mat3(m) * normalize(dir)));
    // (rest-space coordinates across / along the strands, metres: strand clumps for the shading)
    vec3 td = normalize(dir);
    vHairQ = vec2(dot(position, cross(nn, td)), dot(position, td));
  } else vHairQ = vec2(0.0);
  if (aTex.z == 1.0 && !hCardV) {
    // hair cards: each card is flat, so their normals facet the hair into planks; shade them mostly
    // with the head's round normal (from the head centre), on the card's own side
    vec3 rad = normalize(position - hLook(row, 24).xyz);
#if HUMANS_V2
    nrm = normalize(mix(nrm, rad * (dot(nrm, rad) < 0.0 ? -1.0 : 1.0), 0.5));
#else
    nrm = normalize(mix(nrm, rad * (dot(nrm, rad) < 0.0 ? -1.0 : 1.0), 0.7));
#endif
  }
  N = normalize(mat3(m) * nrm);
  if ((flags & 8) != 0 && D0.z > 0.01) {
    // a seated skirt: the cloth below the hips lies along the thighs (the front on top of them, held
    // to their surface, the back sat on), rolls over the knees on a rounded bend, and below them falls to
    // its hem a little back towards the shins, narrowing at the sides and breaking into soft folds
    // (in rest space the skirt hangs from the hips; per thigh, weighted by the vertex's thigh weights)
    float sc = D1.w;
    vec3 Ps = vec3(0.0), Ns = vec3(0.0);
    float wsum = 0.0, sdAvg = 0.0, wl = 0.0, wr = 0.0, lenAvg = 0.0;
    for (int s = 0; s < 2; s++) {
      float bt = s == 0 ? 14.0 : 18.0;
      float w = (aBoneI.x == bt ? W.x : 0.0) + (aBoneI.y == bt ? W.y : 0.0) + (aBoneI.z == bt ? W.z : 0.0) + (aBoneI.w == bt ? W.w : 0.0);
      if (w < 0.005) continue;
      vec4 h = hLook(row, 18 + s * 2), k = hLook(row, 19 + s * 2);
      mat4 tb = hBone(brow, bt);
      vec3 A = (tb * vec4(h.xyz, 1.0)).xyz, B = (tb * vec4(k.xyz, 1.0)).xyz;
      float Lr = length(k.xyz - h.xyz);
      float sd = h.y - pos.y;
      vec3 U = normalize(B - A);
      vec3 rw = mat3(tb) * vec3(pos.x - h.x, 0.0, pos.z - h.z);
      float rad = (mix(h.w, k.w, clamp(sd / Lr, 0.0, 1.0)) + 0.014) * sc;
      float up = rw.y;
      if (up > rad) rw.y = rad;
      vec3 N1 = normalize(mat3(tb) * nrm);
      // the bend over the knee: the centre line runs along the thigh, round an arc of radius Rk, then
      // down (Dn: a little back, under the knee); the cloth's offset turns with it
      vec3 Dn = normalize(vec3(0.0, -1.0, 0.0) - U * 0.16);
      vec3 ax = cross(U, Dn);
      float sa = length(ax);
      ax = sa > 1e-4 ? ax / sa : vec3(1.0, 0.0, 0.0);
      vec3 V = cross(ax, U);
      float beta = atan(sa, dot(U, Dn));
      float Rk = 0.042 * sc, s0 = max(0.0, Lr * sc - Rk * 0.6), arc = Rk * beta;
      float sdp = sd * sc;
      float phi = 0.0, drop = 0.0;
      vec3 C;
      if (sdp < s0) C = A + U * sdp;
      else if (sdp < s0 + arc) { phi = (sdp - s0) / Rk; C = A + U * s0 + (U * sin(phi) + V * (1.0 - cos(phi))) * Rk; }
      else { phi = beta; drop = sdp - s0 - arc; C = A + U * s0 + (U * sin(beta) + V * (1.0 - cos(beta))) * Rk + Dn * drop; }
      float cp = cos(phi), sp = sin(phi);
      vec3 rf = rw * cp + cross(ax, rw) * sp + ax * dot(ax, rw) * (1.0 - cp);
      N1 = N1 * cp + cross(ax, N1) * sp + ax * dot(ax, N1) * (1.0 - cp);
      // (cloth reaching out past the thigh's outer side is not held up by it: the excess hangs down from
      // the thigh's edge; ax points to the figure's left, the left thigh's outer side)
      vec3 outer = s == 0 ? ax : -ax;
      float ex = max(0.0, dot(rf, outer) - rad * 1.08);
      rf += (vec3(0.0, -0.85, 0.0) - outer) * ex;
      // (below the knee the sides draw in towards the shins; folds round the hem, growing as it falls)
      float fall = smoothstep(0.0, 0.22 * sc, drop);
      rf -= ax * dot(ax, rf) * 0.2 * fall;
      // (the curtain's corners round off backwards, round the outer shin, instead of a square edge)
      float lat = dot(rf, outer);
      rf += cross(ax, Dn) * (smoothstep(0.3, 1.0, lat / max(rad * 1.6, 1e-3)) * 0.035 * sc * fall);
      float th = atan(pos.x, h.z - pos.z);
      float fa = (0.004 + 0.011 * fall) * sc * smoothstep(-0.03 * sc, 0.04 * sc, sdp - s0);
      float fw = sin(th * 6.0 + h.x * 31.0) + 0.45 * sin(th * 11.0 + 1.7);
      vec3 rn = rf / max(length(rf), 1e-4);
      vec3 P1 = C + rf + rn * fa * fw;
      vec3 tg = normalize(cross(Dn, rn) + 1e-5);
      N1 = normalize(N1 - tg * (cos(th * 6.0 + h.x * 31.0) * 6.0 + 0.45 * 11.0 * cos(th * 11.0 + 1.7)) * fa / max(length(rf), 0.03));
      Ps += P1 * w; Ns += N1 * w; wsum += w; sdAvg += sd * w; lenAvg += Lr * w;
      if (s == 0) wl = w; else wr = w;
    }
    if (wsum > 0.0) {
      sdAvg /= wsum;
      float ws = D0.z * smoothstep(-0.02, 0.07, sdAvg);
      lenAvg /= wsum;
      // (the cloth between the knees sags into the lap instead of lying flat from knee to knee)
      float between = 4.0 * wl * wr / (wsum * wsum);
      vec3 Pt = Ps / wsum - vec3(0.0, 1.0, 0.0) * between * 0.045 * sc * smoothstep(0.0, 0.8 * lenAvg, sdAvg);
      P = mix(P, Pt, ws);
      N = normalize(mix(N, normalize(Ns), ws));
    }
  }
  if ((flags & 8) != 0) {
    // skirts: kept outside both thigh capsules (the striding or seated thigh pushes the cloth)
    float sc = D1.w;
    for (int s = 0; s < 2; s++) {
      vec4 h = hLook(row, 18 + s * 2), k = hLook(row, 19 + s * 2);
      mat4 tb = hBone(brow, s == 0 ? 14.0 : 18.0);
      vec3 a = (tb * vec4(h.xyz, 1.0)).xyz, b = (tb * vec4(k.xyz, 1.0)).xyz;
      P = hPush(P, a, b, (h.w + 0.016) * sc, (k.w + 0.016) * sc);
    }
  }
  vCastUv = uv;
  vCastTex = aTex;
  vCastAO = aNrm.w;
  vRow = float(row);
  vRest = position;
  vBeard = aTex.z == 11.0 ? aTex.y / 254.0 : 1.0;
  vDecal = uDecal > 0.5 && aTex.z == 0.0 ? (aTex.y - 128.0) / 127.0 : uDecal > 0.5 && aTex.z == 1.0 ? min(1.0, aTex.y / 254.0) : 0.0;
}
`;

const FRAG_PARS = /* glsl */`
${COMMON}
uniform highp sampler2DArray uAlbedo;
uniform highp sampler2DArray uNormalArr;
uniform float uLayerRough[64];
uniform float uRegionRough[16];
uniform float uRegionSpec[16];
uniform float uHasNormal;
uniform float uA2C;          // MSAA samples of the target (0: none -> alpha test)
uniform float uNight;
uniform float uEmissiveGain;
uniform float uDecal;
uniform float uBeardBase;
uniform float uBrows;        // eyebrows drawn on the skin (look texels 26, 27) instead of the brow cards
uniform float uTime;
varying vec2 vCastUv;
flat varying vec4 vCastTex;
flat varying float vRow;
varying float vCastAO;
varying vec3 vRest;
varying float vBeard;
varying float vDecal;
varying vec3 vStrand;
varying vec2 vHairQ;
flat varying vec4 vFill;
int hRegion = 0;
int hFlags = 0;
float hSkinM = 0.0;
float hHairM = 0.0;
float hFar = 0.0;
float hSpec = 1.0;
float hRough = 0.6;
float hAO = 1.0;
float hSheen = 0.0;
float hSilh = 1.0;
vec3 hHairC = vec3(0.0);
vec3 hHairT = vec3(0.0);
vec3 hEmit = vec3(0.0);
float hLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hH3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hBump = 0.0;
float hStrand = 1.0;
float hEyeLid = 1.0;
bool hCard = false;          // a strand card (hair region, flag 64)
bool hTail = false;          // a ponytail's or braid's tail drawn with the cards (hair region, flag 128): as matte
float hDirAO = 0.3;          // share of the baked occlusion on the direct light
float hBrimBelow = -1.0;
float hBrimOver = 0.0;
// the brim's shadow for a light direction (view space): the brim overhangs this point by hBrimOver
// and sits hBrimBelow above it; a sun higher than atan(below / over) is cut off
float hBrimShadow(vec3 L) {
  if (hBrimBelow <= -0.05 || hBrimOver <= 0.0) return 0.0;
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float ly = dot(L, upV);
  float lh = sqrt(max(1e-4, 1.0 - ly * ly));
  float reach = hBrimOver * max(ly, 0.0) / lh;          // shadow depth below the band
  return smoothstep(-0.012, 0.012, reach - max(hBrimBelow, 0.0)) * 0.85;
}
float hVNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hH3(i), hH3(i + vec3(1, 0, 0)), f.x), mix(hH3(i + vec3(0, 1, 0)), hH3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hH3(i + vec3(0, 0, 1)), hH3(i + vec3(1, 0, 1)), f.x), mix(hH3(i + vec3(0, 1, 1)), hH3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float hAA(float e) { float w = max(fwidth(e) * 0.8, 1e-5); return smoothstep(-w, w, e); }
float hBand(float x, float period, float duty) {
  float f = fract(x / period);
  float w = max(fwidth(x / period) * 0.8, 1e-4);
  float b = smoothstep(0.5 - duty * 0.5 - w, 0.5 - duty * 0.5 + w, f) - smoothstep(0.5 + duty * 0.5 - w, 0.5 + duty * 0.5 + w, f);
  // (averaged out where the stripes get near a pixel)
  return mix(b, duty, smoothstep(0.25, 0.6, w));
}
// garment patterns in rest space (m): 1 stripes, 2 check, 3 small print, 4 pinstripe
float hPattern(float code, vec3 r, float sc, float seed) {
  if (code < 0.5) return 0.0;
  if (code < 1.5) return hBand(r.y + 0.3, mix(0.018, 0.045, fract(seed * 7.3)) * sc, 0.42);
  if (code < 2.5) {
    float p = mix(0.028, 0.06, fract(seed * 3.1)) * sc;
    return 0.5 * hBand(r.x + 0.5, p, 0.36) + 0.5 * hBand(r.y, p, 0.36);
  }
  if (code < 3.5) {
    float cs = 0.026 * sc;
    vec3 cp = r / cs + seed * 7.0, ci = floor(cp);
    vec3 hj = vec3(hH3(ci), hH3(ci + 17.1), hH3(ci + 31.7));
    vec3 dv = cp - (ci + 0.3 + 0.4 * hj);
    float d = length(dv);
    float rad = mix(0.17, 0.29, hH3(ci + 5.3)) * (0.8 + 0.2 * cos(5.0 * atan(dv.y, dv.x + dv.z) + hj.x * 6.28));
    float motif = hAA((rad - d) * cs) * step(0.25, hH3(ci + 9.1));
    return mix(motif, 0.12, smoothstep(0.12, 0.45, length(fwidth(cp))));
  }
  return 0.75 * hBand(r.x + 0.5, 0.012 * sc, 0.16);
}
// Kajiya-Kay strand highlights: a faint primary lobe shifted towards the root and a tinted
// secondary lobe towards the tip, both broken up per strand clump (clumps ~0.7 mm across, 2 cm along
// the strands, in rest space); wider and dimmer far away
vec3 hHairSpec(vec3 L, vec3 V, vec3 N, vec3 T) {
  vec3 H = normalize(L + V);
  vec2 cq = vHairQ * vec2(1400.0, 50.0);
  float j = hH3(vec3(floor(cq), vCastTex.x));
  // (locks: value noise ~6 mm across, 10 cm along the strands, so the highlight breaks into streaks even
  // where single strands are far below a pixel)
  float clump = hVNoise(vec3(vHairQ * vec2(160.0, 9.0), vCastTex.x * 7.1)) * 0.65 + hVNoise(vec3(vHairQ * vec2(520.0, 22.0), 3.3)) * 0.35;
  // (averaged where the clumps get near a pixel)
  float fq = smoothstep(0.4, 1.2, length(fwidth(cq)));
  j = mix(j, 0.5, fq);
  clump = mix(clump, 0.5, hFar * 0.5);
  clump = smoothstep(0.25, 0.75, clump);
  float sh = (j - 0.5) * 0.16;
  // (strand cards: each card's highlight a little shifted, so the band breaks into locks at any distance)
  float cardA = hCard ? 0.5 + 0.5 * cos(vDecal * 23.7) : 1.0;
  if (hCard) sh += (vDecal - 0.5) * 0.22;
  vec3 t1 = normalize(T + N * (0.09 + sh)), t2 = normalize(T - N * (0.14 - sh));
  float th1 = dot(t1, H), th2 = dot(t2, H);
  float e1 = hCard ? mix(180.0, 50.0, hFar) : mix(110.0, 36.0, hFar), e2 = mix(18.0, 8.0, hFar);
  float s1 = pow(sqrt(max(0.0, 1.0 - th1 * th1)), e1);
  float s2 = pow(sqrt(max(0.0, 1.0 - th2 * th2)), e2);
  vec3 tint = mix(vec3(1.0), hHairC / max(hLum(hHairC), 1e-3), 0.35);
  float br = mix(0.4 + 0.8 * j, 0.8, hFar);
  float k1 = hCard ? 0.016 * (0.35 + 0.9 * cardA) : 0.026;
  // (the tinted lobe a little less saturated than the fibre colour: light leaving the strand is not only absorbed)
  vec3 c2 = hCard ? mix(vec3(hLum(hHairC)), hHairC, 0.7) * 0.75 : hHairC;
  return (k1 * tint * s1 * br * (0.15 + 1.5 * clump) + c2 * 0.3 * s2 * (0.35 + 0.9 * clump) * (0.7 + 0.5 * j)) * hAO * hStrand;
}
`;

const FRAG_SURFACE = /* glsl */`
{
  int row = int(vRow + 0.5);
  hRegion = int(vCastTex.z + 0.5);
  hFlags = int(vCastTex.w + 0.5);
  vec4 tl = hLook(row, hRegion);
  vec3 tint = tl.rgb;
  vec4 tx = (hFlags & 16) != 0 ? vec4(1.0) : texture(uAlbedo, vec3(vCastUv, vCastTex.x));
  vec3 col;
  if ((hFlags & 4) != 0) {
    // detail layers: albedo = 2 x texel x tint; the look row may soften the detail (clean chinos and
    // plain cloth: no denim fading), w = contrast
    vec3 d = 2.0 * tx.rgb;
    if (tl.w > 0.0) d = clamp(1.0 + (d - 1.0) * tl.w, 0.84, 1.16);
    col = d * tint;
  } else col = tx.rgb * (hRegion == 4 ? vec3(1.0) : tint);
  if ((hFlags & 32) != 0) col = vec3(0.82, 0.81, 0.78);
  bool hLens = false;
  if (hRegion == 12 && (hFlags & 128) != 0) {
    // glasses (mh/parts.js glasses): the lenses dark smooth glass, the frame black or tortoiseshell acetate
    hLens = vCastUv.x > 0.5;
    vec3 fc = mix(vec3(0.016, 0.014, 0.013), vec3(0.075, 0.04, 0.02), tl.w);
    col = hLens ? vec3(0.012, 0.012, 0.011) : fc;
  }
  float rr = uRegionRough[hRegion];
  hRough = rr >= 0.0 ? rr : uLayerRough[int(vCastTex.x + 0.5)];
  hSpec = uRegionSpec[hRegion];
  if (hRegion == 12 && (hFlags & 128) != 0) { hRough = hLens ? 0.05 : 0.3; hSpec = hLens ? 1.2 : 0.9; }
  // (clamped: under MSAA a varying is evaluated at the pixel centre even where that lies outside the
  // triangle, and the extrapolated occlusion of a small far triangle can go negative)
  hAO = clamp(vCastAO, 0.0, 1.0);
  // texel footprint (mip level) of the layer: strands and fine detail below a pixel
  vec2 tsz = vec2(textureSize(uAlbedo, 0).xy);
  vec2 dx = dFdx(vCastUv * tsz), dy = dFdy(vCastUv * tsz);
  float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
  if (hRegion == 5 || hRegion == 7) {
    vec4 pa = hLook(row, 16), pb = hLook(row, 17);
    if (pa.w > 0.5 && (hRegion == 5 || pb.z > 0.5)) col = mix(col, pa.rgb * (0.6 + 0.4 * tx.g / max(1e-3, hLum(tx.rgb))), hPattern(pa.w, vRest, pb.x * pb.y / 1.76, pb.w));
  }
  hCard = hRegion == 1 && (hFlags & 64) != 0;
  hTail = hRegion == 1 && (hFlags & 128) != 0;
  if (hCard) {
    // strand cards: darker at the roots (the volume's shade), the tips a touch lighter; every card its
    // own shade and warmth (tex.y: a random value per card)
    float tt = clamp((0.995 - vCastUv.y) / 0.99, 0.0, 1.0);
    float rnd = vDecal;
    col *= mix(0.76, 1.0, smoothstep(0.0, 0.3, tt)) * (1.0 + 0.1 * smoothstep(0.55, 1.0, tt));
    col *= (0.86 + 0.28 * rnd) * mix(vec3(1.0), vec3(1.05, 1.0, 0.93), fract(rnd * 7.31) * 0.7);
    hDirAO = 0.6;
  } else if (hRegion == 1) {
    // hair: strand clumps (rest space: ~1 mm across, 3 cm along the strands) vary a little in shade;
    // averaged out where they get near a pixel
    vec2 cp = vHairQ * vec2(900.0, 33.0);
    float cn = hH3(vec3(floor(cp), vCastTex.x + 1.0));
    cn = mix(cn, 0.5, smoothstep(0.3, 1.0, length(fwidth(cp))));
    // (and locks a shade lighter or darker, ~6 mm across)
    float lk = hVNoise(vec3(vHairQ * vec2(170.0, 8.0), vCastTex.x * 3.7 + 1.0));
    col *= (0.9 + 0.2 * cn) * (0.86 + 0.28 * lk);
  }
  // beard shells (cast feature beardBase): which shell, how far out (0 root .. 1 the beard's surface)
  float bShell = 0.0;
  bool bBase = uBeardBase > 0.5 && hRegion == 11;
  if (bBase) bShell = float((hFlags >> 4) & 15) / 15.0;
  float a = 1.0;
  if ((hFlags & 1) != 0) {
    // coverage of hair cards, brows, lashes, beards: kept from thinning out in the mips, sharpened
    // to about a pixel, then rounded to the target's sample count (alpha to coverage) or tested
    a = tx.a * (1.0 + max(lod, 0.0) * 0.22);
    // lashes: a soft dark line along the lid, not eyeliner (lighter still for men and children)
    if (hRegion == 3) a *= 0.5 * (1.0 - 0.6 * hLook(row, 3).w);
    if (hRegion == 1 && uDecal > 0.5 && vDecal < 0.999 && !hCard) {
      // trimmed strand ends: the fade breaks into strands of uneven length (columns across the strands)
      float sn = hH3(vec3(floor(vHairQ.x * 750.0), vCastTex.x, 3.0));
      sn = mix(sn, 0.5, smoothstep(0.5, 1.5, fwidth(vHairQ.x * 750.0)));
      a *= clamp((vDecal - 0.1 - 0.55 * sn) * 4.0, 0.0, 1.0);
    }
    if (hRegion == 2) a *= uDecal > 0.5 ? 0.85 : 0.8;      // brows: thinner strokes, skin shows between the hairs
    if (bBase) {
      // beard shells: strands rooted in a fine grid on the skin (cylindrical about the head's axis, so it
      // runs round the jaw and on under the chin; 0.45 mm cells, every other row offset), each with its
      // own length and lean; clumps (~4 mm) share a lean and a length, so the beard has a texture of
      // locks, and the strands thin to their tips. Below a pixel: their expected coverage.
      vec3 hcb = hLook(row, 24).xyz;
      vec2 rp = vRest.xz - hcb.xz;
      float rr = length(rp);
      vec2 g = vec2(atan(rp.x, -rp.y) * 0.075, vRest.y - rr);
      // clumps: a lean (the strands sweep down and a little sideways as they grow) and a length factor
      vec3 cg = vec3(g * 260.0, 0.0);
      float cl1 = hVNoise(cg), cl2 = hVNoise(cg + 17.3);
      // (the hairs lie at a low angle to the skin: a strand's root-to-tip sweep is most of its length)
      vec2 lean = vec2((cl1 - 0.5) * 0.7, -0.75 - 0.4 * cl2) * bShell * (0.0015 + vCastUv.x * 0.04 * 0.6);
      vec2 q = (g - lean) * 2200.0;
      q.x += 0.5 * mod(floor(q.y), 2.0);
      vec2 ci = floor(q), f = fract(q) - 0.5;
      float r1 = hH3(vec3(ci, 1.3)), r2 = hH3(vec3(ci, 2.7)), r3 = hH3(vec3(ci, 3.1)), r4 = hH3(vec3(ci, 4.9));
      float dens = vCastUv.y * smoothstep(0.0, 1.0, vBeard);
      float sl = mix(0.25, 1.0, sqrt(r1)) * mix(0.75, 1.15, cl2);      // strand length (x the local length)
      // follicles with a strand: none at the border, thinning in over its outer part (broken by the clumps)
      float pres = smoothstep(0.0, 0.75, dens + (cl1 - 0.5) * 0.3) * mix(0.8, 1.1, cl1);
      vec2 dd = f - (vec2(r3, r4) - 0.5) * 0.35;
      float rad = 0.4 * (1.0 - 0.65 * clamp(bShell / max(sl, 1e-3), 0.0, 1.0));
      float fwq = length(fwidth(q));
      float aw = max(fwq * 0.6, 0.03);
      float c1 = step(r2, pres) * step(bShell, sl) * (1.0 - smoothstep(rad - aw, rad + aw, length(dd)));
      float lfrac = clamp((mix(0.25, 1.15, cl2) - bShell) / 0.75, 0.0, 1.0);
      float cexp = clamp(pres, 0.0, 1.0) * lfrac * min(1.0, 3.14 * rad * rad * 1.2);
      a = mix(c1, cexp, smoothstep(0.7, 1.8, fwq));
      // dark roots, lighter tips; strand to strand and clump to clump shade
      col = tint * mix(0.5, 1.1, bShell) * mix(0.8 + 0.4 * r3, 1.0, smoothstep(0.7, 1.8, fwq)) * (0.85 + 0.3 * cl1);
      hAO *= mix(0.45, 1.0, bShell);
    } else if (hRegion == 11) {
      // beard shell: strands (fine streaks running down the face, in rest space) thin out towards
      // the shell's edges; far away only the soft edge remains
      vec3 sp = vRest * vec3(1400.0, 160.0, 1400.0);
      float sn = hH3(floor(sp)) * 0.7 + hH3(floor(sp * 0.37 + 11.3)) * 0.3;
      float fw = length(fwidth(sp));
      sn = mix(sn, 0.5, smoothstep(0.6, 2.5, fw));
      float edge = smoothstep(0.0, 1.0, vBeard);
      // (light beards: grey and white strands over darker ones, the skin showing through)
      float light = smoothstep(0.08, 0.35, hLum(tint));
      // shells: the base one dense and dark (the beard's depth), the outer two ever sparser strands
      int shell = (hFlags & 64) != 0 ? 1 : (hFlags & 128) != 0 ? 2 : 0;
      if (uDecal > 0.5) {
        // (the beard's base is the skin decal; this shell is its volume: clumps of strands (~3 x 9 mm,
        // running down the face) with gaps between them, dense in the middle, wisps at the border)
        vec3 cq = vRest * vec3(330.0, 110.0, 330.0);
        float cl = hVNoise(cq);
        cl = mix(cl, 0.5, smoothstep(0.5, 2.0, length(fwidth(cq))));
        // fine strands: thin streaks down the face, jittered per column so they never line up in a grid
        vec3 sq = vRest * vec3(1300.0, 1.0, 1300.0);
        float colId = floor(sq.x + 0.37 * sq.z);
        float st = hH3(vec3(colId, floor(vRest.y * 140.0 + hH3(vec3(colId, 1.0, 2.0)) * 3.0), 7.0));
        st = mix(st, 0.5, smoothstep(0.4, 1.5, fwidth(sq.x + 0.37 * sq.z)));
        float dens = edge * tx.a;
        // (solid inside; broken into wisps only over the outer part of the border)
        float nz = 0.6 * cl + 0.4 * st;
        a = smoothstep(nz - 0.12, nz + 0.12, dens * 1.5 - 0.15);
        col *= 0.88 + 0.3 * (cl - 0.5) + 0.22 * (st - 0.5);
      } else if (shell == 0) {
        a *= clamp((edge * (1.25 - 0.3 * light) - sn) * 2.5 + 0.35, 0.0, 1.0);
        col *= mix(0.5 + 0.5 * sn, 0.3 + 1.0 * sn * sn, light);
      } else {
        vec3 sp2 = vRest * vec3(1900.0, 210.0, 1900.0) + float(shell) * 7.31;
        float s2 = hH3(floor(sp2));
        s2 = mix(s2, 0.5, smoothstep(0.6, 2.5, length(fwidth(sp2))));
        float dens = (shell == 1 ? 0.62 : 0.34) * edge;
        a *= clamp((dens - s2) * 6.0 + 0.5, 0.0, 1.0);
        col *= 0.85 + 0.5 * s2 + 0.15 * float(shell);
      }
    }
    // (a beard's volume and lashes fade out softly: dithered coverage instead of a sharpened edge)
    bool soft = uDecal > 0.5 && (hRegion == 11 || hRegion == 3) || hCard;
    if (!soft) a = clamp((a - 0.5) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
    // (strand cards: crisp strands up close, their mip-averaged coverage further away, dithered over the
    // frames so the temporal resolve smooths it)
    if (hCard) a = mix(clamp((a - 0.5) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0), clamp(a, 0.0, 1.0), smoothstep(0.0, 2.0, lod));
    if (uA2C > 0.5) {
      float dth = soft ? fract(dot(floor(gl_FragCoord.xy), vec2(0.7548777, 0.5698403)) + (hCard ? floor(uTime * 60.0) * 0.618034 : 0.0)) : 0.5;
      a = floor(a * uA2C + dth) / uA2C;
      if (a <= 0.0) discard;
    } else {
      // no MSAA: an ordered dither instead
      vec2 q = floor(gl_FragCoord.xy);
      float d = fract(dot(q, vec2(0.7548777, 0.5698403)) + 0.25);
      if (a < d) discard;
      a = 1.0;
    }
  }
  diffuseColor = vec4(col, a);
  if (hRegion == 4) {
    // the upper lid shades the top of the eyeball; the eye's corners are darker too
    vec3 ec = hLook(row, 25).xyz;
    vec3 d = vRest - vec3(vRest.x < 0.0 ? -ec.x : ec.x, ec.y, ec.z);
    float lid = smoothstep(-0.003, 0.009, d.y);
    diffuseColor.rgb *= mix(1.0, 0.45, lid) * mix(1.0, 0.7, smoothstep(0.006, 0.012, abs(d.x)));
    hAO *= mix(1.0, 0.6, lid);
    hEyeLid = lid;
    float er = hLook(row, 25).w;
    if (er > 0.0) {
      // the iris drawn here in the person's own colour (look: eyes tint), over the texture's: the front
      // cap of the eyeball (the eyes look ahead, -z), fibres running out from the pupil, a darker rim;
      // the white of the eye a soft off-white, never paper white
      float rad = length(d.xy);
      // (an iris about two fifths of the eyeball's radius: white shows on both sides of it, as in life)
      float ir = er * 0.4, pr = er * (0.13 + 0.05 * uNight);
      float aw = max(length(fwidth(d.xy)), 1e-5);
      float front = 1.0 - smoothstep(-0.45 * er, -0.2 * er, d.z);
      float iris = front * (1.0 - smoothstep(ir - aw, ir + aw, rad));
      float ang = atan(d.y, d.x);
      float fib = hVNoise(vec3(ang * 9.0, rad / er * 14.0, 3.0)) * 0.6 + hVNoise(vec3(ang * 25.0, rad / er * 5.0, 7.0)) * 0.4;
      fib = mix(fib, 0.5, smoothstep(0.0005, 0.0015, aw));
      float u = rad / ir;
      vec3 ic = tint * (0.58 + 0.68 * fib) * mix(1.15, 0.4, smoothstep(0.76, 1.0, u)) * mix(0.75, 1.0, smoothstep(0.35, 0.6, u));
      ic = mix(ic, vec3(0.012), front * (1.0 - smoothstep(pr - aw, pr + aw, rad)));
      // (the texture's own iris may be larger than this one: the sclera is a flat off-white, a touch
      // warmer and darker towards the corners)
      vec3 sclera = vec3(0.66, 0.62, 0.58) * mix(1.0, 0.86, smoothstep(0.5, 1.0, length(d.xy) / er));
      // (warmer and a little pink towards the corners)
      sclera = mix(sclera, vec3(0.6, 0.47, 0.44), smoothstep(0.5, 1.0, abs(d.x) / er) * 0.55);
      diffuseColor.rgb = mix(sclera, ic, iris) * mix(1.0, 0.45, lid) * mix(1.0, 0.7, smoothstep(0.006, 0.012, abs(d.x)));
    } else if (uDecal > 0.5) {
      // (the iris a little darker and less saturated; the white of the eye never paper white)
      float l = hLum(diffuseColor.rgb);
      diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, 0.75) * 0.82;
    }
  }
#if HUMANS_V2
  if (hRegion <= 4 || hRegion == 11) {
    // under a hat's brim: how far below the band, how far the brim reaches past this point
    vec4 hcB = hLook(row, 24);
    if (hcB.w > 0.0) {
      hBrimBelow = hLook(row, 10).w - vRest.y;
      hBrimOver = hcB.w - length(vRest.xz - hcB.xz);
      // the brim hides part of the sky from the face (ambient occlusion under it)
      if (hBrimOver > 0.0 && hBrimBelow > -0.05) hAO *= 1.0 - 0.5 * hBrimOver / (hBrimOver + max(hBrimBelow, 0.0) + 0.02);
    }
  }
#endif
  if (hRegion == 0) {
    hSkinM = 1.0;
    float fwr = length(fwidth(vRest));
    if (uDecal > 0.5) {
      vec3 ec = hLook(row, 25).xyz;
      // face: an oilier T-zone (forehead, nose, chin) and drier cheeks; darker skin a little smoother,
      // so the planes of the face catch the light
      vec3 fd = vRest - vec3(0.0, ec.y, ec.z);
      float face = smoothstep(0.045, 0.0, fd.z) * smoothstep(-0.13, -0.09, fd.y) * (1.0 - smoothstep(0.08, 0.11, fd.y));
      float ax = abs(fd.x);
      float tz = max((1.0 - smoothstep(0.012, 0.03, ax)) * smoothstep(-0.075, -0.05, fd.y),     // nose, chin line
                     smoothstep(0.02, 0.04, fd.y) * (1.0 - smoothstep(0.045, 0.07, ax)));         // forehead
      float dark = 1.0 - smoothstep(0.03, 0.14, hLum(col));
      hRough = mix(0.56, mix(0.64, 0.46, tz), face) - 0.07 * dark;
      hSpec *= 1.0 + 0.25 * dark;
      float dcl = vDecal;
      if (dcl > 0.004) {
        // beard growth: stubble darkens and desaturates the skin towards the hair colour (follicle
        // speckle up close, an even shadow further away); a beard's base is denser
        vec4 bl = hLook(row, 11);
        float dens = bl.w;
        vec3 fp = vRest * 1500.0;
        float fol = hH3(floor(fp));
        fol = mix(fol, 0.5, smoothstep(0.4, 1.4, length(fwidth(fp))));
        // strand clumps (~3 x 8 mm, down the face): the growth is not an even paint
        vec3 cq = vRest * vec3(300.0, 120.0, 300.0);
        float cl = hVNoise(cq);
        cl = mix(cl, 0.5, smoothstep(0.6, 2.0, length(fwidth(cq))));
        float brk = hVNoise(vRest * 140.0);
        // a soft, broken border (the coverage eases in over ~1-2 cm, the noise breaks the line)
        float c = smoothstep(0.08, 0.9, dcl + (brk - 0.5) * 0.45 * (1.0 - dcl * 0.6));
        // (a few days' stubble greys the jaw by about half; a beard's base is near the hair colour)
        float amt = c * (0.18 + 0.56 * dens) * (0.55 + 0.6 * fol) * (0.8 + 0.45 * cl);
        vec3 bc = mix(bl.rgb, vec3(0.018, 0.02, 0.024), 0.3);
        diffuseColor.rgb = mix(diffuseColor.rgb, bc, clamp(amt, 0.0, 0.85));
        hRough = mix(hRough, 0.72, c * dens);
        hSpec *= 1.0 - 0.5 * c * dens;
      } else if (dcl < -0.004) {
        // under the hair: the scalp takes the hair's colour (gaps between the cards read as hair)
        vec4 hl = hLook(row, 1);
        float sc = clamp(-dcl * 1.3, 0.0, 1.0) * hl.w;
        vec3 sh = hl.rgb * 0.6;
        sh = mix(vec3(hLum(sh)), sh, 0.7);
        diffuseColor.rgb = mix(diffuseColor.rgb, sh, sc * 0.92);
        hRough = mix(hRough, 0.7, sc);
        hSpec *= 1.0 - 0.7 * sc;
        hSkinM = 1.0 - sc;
        // (the scalp's occlusion was baked under the proxy's solid shells; between strand cards light
        // reaches it, a parting or a crown never reads as a black hole)
        hAO = mix(hAO, max(hAO, 0.55), sc);
      }
    }
    // eyebrows (uBrows): drawn on the skin along the brow ridge the cast's brow cards trace (look
    // texels 26, 27: centre line y = a + b |x| + c x^2 from x0 to x1, half height t0 .. t1): a soft band
    // of fine hairs (the inner hairs rise steeply, the rest run out along the brow), denser in the
    // middle, feathered at its edges, in a darker shade of the hair (brows texel: colour, opacity)
    if (uBrows > 0.5) {
      vec4 b0 = hLook(row, 26), b1 = hLook(row, 27);
      float ax = abs(vRest.x);
      if (b0.y > 0.0 && ax > b0.x - 0.008 && ax < b0.y + 0.008 && vRest.z < b1.w + 0.015 && vRest.z > b1.w - 0.03) {
        float u = (ax - b0.x) / max(b0.y - b0.x, 1e-4);
        float yc = b0.z + b0.w * ax + b1.x * ax * ax;
        float th = mix(b1.y, b1.z, clamp(u, 0.0, 1.0));
        float dy = (vRest.y - yc) / max(th, 1e-4);
        // (thicker below the centre line: the brow sits on the orbital rim; the lower edge sharper)
        // (a soft, filled shape: densest a little below the centre line, feathered over its outer half)
        // hairs: fine strokes along the brow's growth (the inner hairs rise steeply, the rest run out
        // along the brow), each with its own length and offset, so the band's edges break up into hairs
        float hang = mix(1.2, 0.2, smoothstep(0.0, 0.32, u)) - 0.25 * smoothstep(0.7, 1.0, u);
        vec2 hd = vec2(cos(hang), sin(hang));
        vec2 p2 = vec2(ax, vRest.y);
        vec2 hq = vec2(dot(p2, vec2(-hd.y, hd.x)) * 1500.0, dot(p2, hd) * 90.0);
        float hcol = floor(hq.x);
        float hh = hH3(vec3(hcol, 7.0, 3.0));
        float fq = smoothstep(0.35, 1.2, length(fwidth(hq)));
        // (clumps ~4 mm along the brow: a little denser and sparser)
        float clm = hVNoise(vec3(u * 9.0, dy * 1.5, b0.x * 300.0));
        float ey = dy + 0.15 + (hh - 0.5) * 0.55 * (1.0 - fq);
        float band = exp(-ey * ey * (ey < 0.0 ? 1.5 : 2.1)) * (0.8 + 0.4 * clm)
          * smoothstep(-0.14, 0.12, u) * (1.0 - smoothstep(0.82, 1.06, u));
        if (band > 0.002) {
          float hn = hH3(vec3(hcol, floor(hq.y + hh * 4.0), 5.0));
          float line = 1.0 - smoothstep(0.18, 0.42, abs(fract(hq.x) - 0.5));
          float stroke = mix(step(0.3, hn) * line * 1.6, 0.62, fq);
          vec4 bt = hLook(row, 2);
          float dens = band * mix(0.45, 1.0, clamp(stroke, 0.0, 1.0)) * (bt.w > 0.0 ? bt.w : 0.7) * 1.1;
          // (the middle of the brow fuller than its tail)
          dens *= mix(1.0, 0.75, smoothstep(0.55, 1.0, u));
          diffuseColor.rgb = mix(diffuseColor.rgb, bt.rgb, clamp(dens, 0.0, 0.88));
          hRough = mix(hRough, 0.75, dens);
          hSpec *= 1.0 - 0.6 * dens;
        }
      }
    }
    // the person's skin (look texels 28-33): redness over the cheeks, nose and ears, freckles, a few moles,
    // and with age lines on the forehead, at the eyes' corners, the folds from the nose to the mouth and
    // shade under the eyes (rest space round the face's landmarks; fine marks fade out before they alias)
    vec4 F0 = hLook(row, 28);
    if (uDecal > 0.5 && F0.w > 0.0) {
      vec4 F1 = hLook(row, 29), K2 = hLook(row, 32), K3 = hLook(row, 33);
      float hk = F0.w;
      vec3 ec2 = hLook(row, 25).xyz;
      float ax = abs(vRest.x);
      vec3 rc = vec3(ax - 0.042 * hk, vRest.y - (ec2.y - 0.032 * hk), vRest.z - (F0.z + 0.04 * hk)) / (0.022 * hk);
      vec3 rn = (vRest - vec3(0.0, F0.y + 0.003 * hk, F0.z + 0.006 * hk)) / (0.013 * hk);
      vec3 re = vec3(ax - 0.075 * hk, vRest.y - ec2.y, vRest.z - (F0.z + 0.105 * hk)) / (0.022 * hk);
      float red = (exp(-dot(rc, rc)) * 0.85 + exp(-dot(rn, rn)) * 0.75 + exp(-dot(re, re)) * 0.6) * K2.z;
      diffuseColor.rgb *= mix(vec3(1.0), vec3(1.06, 0.94, 0.93), clamp(red, 0.0, 1.0) * 0.45);
      float near2 = 1.0 - smoothstep(0.0008, 0.003, fwr);
      if (K2.w > 0.0 && near2 > 0.0) {
        // freckles: small spots over the nose and cheeks (~3 mm apart)
        vec3 fc = vRest / (0.003 * hk);
        vec3 fi = floor(fc);
        vec3 fo = fc - fi - (0.3 + 0.4 * vec3(hH3(fi), hH3(fi + 3.1), hH3(fi + 7.7)));
        float fr = step(hH3(fi + 11.3), 0.55) * (1.0 - smoothstep(0.12, 0.3, length(fo)));
        float zone = exp(-dot(rc, rc) * 0.6) + exp(-dot(rn, rn) * 0.4);
        diffuseColor.rgb *= 1.0 - near2 * fr * clamp(zone, 0.0, 1.0) * K2.w * vec3(0.22, 0.3, 0.36);
      }
      if (near2 > 0.0) {
        // moles: one or two small dark spots somewhere on the face and neck
        vec3 mc = vRest / (0.035 * hk) + K3.x;
        vec3 mi = floor(mc);
        vec3 mo = mc - mi - (0.25 + 0.5 * vec3(hH3(mi), hH3(mi + 5.3), hH3(mi + 9.1)));
        float mr = step(0.93, hH3(mi + 2.2)) * (1.0 - smoothstep(0.025, 0.045, length(mo)));
        diffuseColor.rgb *= 1.0 - near2 * mr * vec3(0.45, 0.55, 0.6);
      }
      float age = F1.w * K3.y;
      float nearA = 1.0 - smoothstep(0.0012, 0.005, fwr);
      if (age > 0.03 && nearA > 0.0) {
        float lines = 0.0, folds = 0.0;
        // forehead: horizontal lines, gently waved
        float fy = (vRest.y - ec2.y) / hk;
        float fh = smoothstep(0.032, 0.045, fy) * (1.0 - smoothstep(0.07, 0.085, fy)) * (1.0 - smoothstep(0.035, 0.055, ax / hk))
          * (1.0 - smoothstep(0.03, 0.06, (vRest.z - F0.z) / hk));
        float wv = sin((fy + 0.0012 * sin(ax / hk * 90.0)) * 6.2832 / 0.0075);
        lines += fh * pow(0.5 + 0.5 * wv, 6.0);
        // the eyes' outer corners: crow's feet (lines fanning out)
        vec2 cc = vec2(ax - (ec2.x + 0.019 * hk), vRest.y - ec2.y) / hk;
        float cr = length(cc);
        float cz = smoothstep(0.003, 0.007, cr) * (1.0 - smoothstep(0.014, 0.022, cr)) * step(0.0, cc.x + 0.002);
        lines += cz * pow(0.5 + 0.5 * cos(atan(cc.y, cc.x) * 15.0), 5.0) * 0.8;
        // from the sides of the nose round the mouth: the nasolabial folds
        vec2 a0 = vec2(0.017, F0.y / hk + 0.002), a1 = vec2(0.029, F1.x / hk - 0.009);
        vec2 pq = vec2(ax, vRest.y) / hk - a0, ab = a1 - a0;
        float tq = clamp(dot(pq, ab) / dot(ab, ab), 0.0, 1.0);
        float dl = length(pq - ab * tq);
        float zf = 1.0 - smoothstep(0.04, 0.07, (vRest.z - F0.z) / hk);
        folds += exp(-dl * dl / (0.0024 * 0.0024)) * zf * smoothstep(0.0, 0.15, tq);
        // under the eyes: a soft shade
        vec2 ue = vec2(ax - ec2.x, vRest.y - (ec2.y - 0.014 * hk)) / (vec2(0.016, 0.006) * hk);
        float under = exp(-dot(ue, ue)) * step(vRest.z, ec2.z + 0.01 * hk);
        float A = clamp(age, 0.0, 1.0);
        diffuseColor.rgb *= 1.0 - nearA * (lines * 0.16 * A + folds * 0.18 * A + under * 0.12 * (0.3 + A)) * vec3(0.95, 1.0, 1.0);
        hBump -= nearA * (lines * 0.00022 + folds * 0.0005) * A;
      }
    }
    // close up: skin is not a flat colour: faint blotches, pores and an uneven sheen (rest space,
    // faded out well before it could alias)
    float near = 1.0 - smoothstep(0.0012, 0.005, fwr);
    if (near > 0.0) {
      float n1 = hVNoise(vRest * 160.0), n2 = hVNoise(vRest * 1100.0);
      // (blotches a few mm across, a little redder or browner; pores; an uneven sheen)
      float n3 = hVNoise(vRest * 420.0 + 5.1);
      diffuseColor.rgb *= 1.0 + near * ((n1 - 0.5) * 0.1 + (n3 - 0.5) * vec3(0.05, -0.01, -0.03));
      hRough = mix(hRough, hRough * (0.78 + 0.44 * n2), near);
      hBump += near * (n2 * 0.00012 + n1 * 0.00025);
    }
  }
  if (uDecal > 0.5 && (hRegion == 14 || hRegion == 15)) {
    // bags and straps: a leather / canvas grain and soft wear up close
    float fwb = length(fwidth(vRest));
    float nb = 1.0 - smoothstep(0.0015, 0.006, fwb);
    if (nb > 0.0) {
      float g1 = hVNoise(vRest * 900.0), g2 = hVNoise(vRest * 90.0);
      hBump = nb * (g1 * 0.00012 + g2 * 0.0003);
      diffuseColor.rgb *= 1.0 + nb * (g2 - 0.5) * 0.12;
    }
  }
  if ((hFlags & 2) != 0 && (hRegion >= 5 && hRegion <= 10 || hRegion == 14 || hRegion == 15)) {
    // the inside of a garment near its hem or cuff: its own cloth, in the shadow of the garment
    diffuseColor.rgb *= 0.3;
    hAO *= 0.5;
  }
  if (hRegion == 1 || hRegion == 11 || hRegion == 2) {
    // (light passes between the strands: the baked occlusion of hair cards is softened)
    if (hRegion == 1) hAO = 0.45 + 0.55 * hAO;
    hHairM = hRegion == 1 ? 1.0 : 0.6;
    hHairC = diffuseColor.rgb;
    // highlights only on the strands the texture draws (the gaps between them stay dull)
    hStrand = bBase ? 0.8 : hCard ? clamp(hLum(tx.rgb) * 2.0, 0.3, 1.4) : clamp(hLum(tx.rgb) * 1.8, 0.15, 1.0);
    hFar = bBase ? smoothstep(0.3, 2.0, length(fwidth(vRest)) * 1000.0) : smoothstep(0.5, 3.5, lod);
  }
  // cloth sheen: fibres catch light at grazing angles (dark cloth reads as cloth, not plastic); not
  // on the inside of a garment (a waistband's inside seen over the top must stay in its shade)
  if (hRegion >= 5 && hRegion <= 10 && hRegion != 8 || hRegion == 14 || hRegion == 15) hSheen = 1.0;
  if ((hFlags & 2) != 0 && hRegion >= 5 && hRegion <= 10) { hSheen = 0.0; hSpec *= 0.15; hAO *= 0.7; }
#if HUMANS_DBG == 1
  hEmit = vec3(hAO); diffuseColor.rgb = vec3(0.0);        // debug view: baked occlusion
#elif HUMANS_DBG == 2
  hEmit = vec3(col); diffuseColor.rgb = vec3(0.0);        // debug view: albedo
#elif HUMANS_DBG == 3
  hEmit = vec3(vBeard, hRegion == 11 ? 0.0 : 0.3, 0.0); diffuseColor.rgb = vec3(0.0);   // debug view: beard edge distance
#elif HUMANS_DBG == 4
  hEmit = vec3(max(vDecal, 0.0), max(-vDecal, 0.0), 0.0); diffuseColor.rgb = vec3(0.0); // debug view: skin decals
#elif HUMANS_DBG == 7
  // debug view: brim shadow at a 45 degree sun (red), below the brim (green: 0 .. 10 cm)
  hEmit = 0.05 * vec3(hBrimBelow > 0.0 && hBrimOver > 0.0 ? smoothstep(-0.012, 0.012, hBrimOver - hBrimBelow) : 0.0, clamp(hBrimBelow * 10.0, 0.0, 1.0), 0.0); diffuseColor.rgb = vec3(0.0);
#elif HUMANS_DBG == 6
  if (hRegion == 0) discard;                              // debug view: no skin
#elif HUMANS_DBG == 8
  // debug view: hair strand fade (cut ends) in red, strand direction in green / blue (view space)
  hEmit = hRegion == 1 ? vec3(1.0 - vDecal, 0.5 + 0.5 * vStrand.y, 0.5 + 0.5 * vStrand.x) : vec3(0.0); diffuseColor.rgb = vec3(0.0);
#elif HUMANS_DBG == 5
  // debug view: region (hue) and flags (back faces dark)
  hEmit = 0.5 + 0.5 * cos(6.2832 * (float(hRegion) / 16.0 + vec3(0.0, 0.33, 0.67)));
  if ((hFlags & 2) != 0) hEmit *= 0.3;
  diffuseColor.rgb = vec3(0.0);
#endif
  if (hRegion == 13) {
    // a lit phone screen: a pale UI with a few rows of content
    float rows = hBand(vCastUv.y * 14.0, 1.0, 0.55) * step(0.08, vCastUv.x) * step(vCastUv.x, 0.92);
    vec3 sc = mix(vec3(0.75, 0.8, 0.88), vec3(0.32, 0.38, 0.5), rows * 0.6);
    hEmit = sc * (0.35 + 1.4 * uNight) * uEmissiveGain;
    diffuseColor.rgb = vec3(0.02);
  }
}
`;

const FRAG_NORMAL = /* glsl */`
{
  vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
  vec2 st0 = dFdx(vCastUv), st1 = dFdy(vCastUv);
  vec3 q1perp = cross(q1, normal), q0perp = cross(normal, q0);
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 Bt = q1perp * st0.y + q0perp * st1.y;
  float det = max(dot(T, T), dot(Bt, Bt));
  float scl = det == 0.0 ? 0.0 : inversesqrt(det);
  if (uHasNormal > 0.5 && vCastTex.y < 254.5 && (hFlags & 16) == 0 && hRegion != 11 && !(uDecal > 0.5 && (hRegion == 0 || hRegion == 1))) {
    vec3 nm = texture(uNormalArr, vec3(vCastUv, vCastTex.y)).xyz * 2.0 - 1.0;
    normal = normalize(T * (nm.x * scl) + Bt * (nm.y * scl) + normal * nm.z);
  }
  if (hBump != 0.0) {
    // skin micro relief from a height in metres (screen-space derivatives)
    float dhx = dFdx(hBump), dhy = dFdy(hBump);
    vec3 r1 = cross(q1, normal), r2 = cross(normal, q0);
    float dt = dot(q0, r1);
    vec3 nb = abs(dt) * normal - sign(dt) * (dhx * r1 + dhy * r2);
    if (abs(dt) > 1e-14 && dot(nb, nb) > 1e-30) normal = normalize(nb);
  }
  // strand direction (view space, from the vertex shader: out from the crown over the head, down the
  // face for beards); brows along the texture's v
  if (hHairM > 0.0) {
    vec3 st = dot(vStrand, vStrand) > 0.25 ? vStrand : Bt;
    hHairT = normalize(st - normal * dot(st, normal) + 1e-6);
  }
  // silhouettes: interpolated normals can face away from the eye, where the specular term
  // blows up; bend them back towards the viewer and fade the grazing sheen there
  vec3 vdir = normalize(vViewPosition);
  float nv = dot(normal, vdir);
  hSilh = smoothstep(0.05, 0.25, nv);
  if (nv < 0.12) normal = normalize(normal + vdir * (0.12 - nv));
}
`;

function patchVertex(shader, depth) {
  let vs = shader.vertexShader;
  vs = vs.replace('#include <batching_pars_vertex>', '#include <batching_pars_vertex>\n' + VERT_PARS);
  if (depth) {
    vs = vs.replace('#include <batching_vertex>', 'mat4 batchingMatrix = mat4(1.0);\nvec3 hP, hN; hSkin(hP, hN);');
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = hP;');
  } else {
    vs = vs.replace('#include <batching_vertex>', 'mat4 batchingMatrix = mat4(1.0);\nvec3 hP, hN; hSkin(hP, hN);');
    vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = hN;');
    vs = vs.replace('#include <begin_vertex>', 'vec3 transformed = hP;');
  }
  shader.vertexShader = vs;
}

/**
 * Materials of the figure batch: { mat, depth, uniforms }. textures: { bones, look, albedo, normal };
 * layerRough: per albedo layer roughness.
 */
export function makeFigureMaterials(textures, layerRough, materials, debugView = 0, v2 = false, opts = {}) {
  const rough = new Array(64).fill(0.7);
  for (let i = 0; i < Math.min(64, layerRough.length); i++) rough[i] = layerRough[i];
  const uniforms = {
    uBoneTex: { value: textures.bones },
    uLookTex: { value: textures.look },
    uAlbedo: { value: textures.albedo },
    uNormalArr: { value: textures.normal || textures.albedo },
    uHasNormal: { value: textures.normal ? 1 : 0 },
    uLayerRough: { value: rough },
    uRegionRough: { value: (v2 ? REGION_ROUGH_V2 : REGION_ROUGH).slice() },
    uRegionSpec: { value: (v2 ? REGION_SPEC_V2 : REGION_SPEC).slice() },
    uA2C: { value: 4 },
    uDecal: { value: v2 ? 1 : 0 },
    uBeardBase: { value: opts.beardBase ? 1 : 0 },
    uBrows: { value: opts.brows ? 1 : 0 },
    uTime: U.uTime || { value: 0 },
    uNight: U.uNight || { value: 0 },
    uEmissiveGain: (materials && materials.uniforms && materials.uniforms.emissiveGain) || { value: 1 },
  };
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.6, metalness: 0, sheen: 1, sheenRoughness: 0.6, sheenColor: 0x000000,
    specularIntensity: 1, ior: 1.5,
  });
  // hair coverage: alpha to coverage on MSAA targets (uA2C = samples), a dither otherwise
  mat.alphaToCoverage = true;
  mat.name = 'humans.figures';
  mat.defines = { ...mat.defines, HUMANS_DBG: debugView | 0, HUMANS_V2: v2 ? 1 : 0 };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchVertex(shader, false);
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + FRAG_PARS);
    fs = fs.replace('#include <map_fragment>', FRAG_SURFACE);
    fs = fs.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = hRough;');
    fs = fs.replace('#include <normal_fragment_maps>', FRAG_NORMAL);
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += hEmit;');
    fs = fs.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      material.specularColor *= hSpec;
      material.specularColorBlended *= hSpec;
      // (fibres: no glassy Fresnel sheen at grazing angles; their highlight is the strand lobes)
      material.specularF90 = hCard || hTail ? 0.04 : hRegion == 1 ? 0.12 : hRegion == 10 ? 0.35 : mix(1.0, 0.6, hHairM);
      #ifdef USE_SHEEN
        material.sheenColor = hSheen * hSilh * mix(diffuseColor.rgb, vec3(1.0), 0.35) * 0.18;
        material.sheenRoughness = 0.65;
      #endif`);
    // skin: wrapped diffuse with a warm scatter at the terminator; hair: strand highlights
    const pars = THREE.ShaderChunk.lights_physical_pars_fragment;
    const key = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );\n\tvec3 irradiance = dotNL * directLight.color;';
    if (pars.includes(key)) {
      fs = fs.replace('#include <lights_physical_pars_fragment>', pars.replace(key,
        `float dotNLr = dot( geometryNormal, directLight.direction );
        float dotNL = saturate( dotNLr );
        float wrapNL = saturate( ( dotNLr + 0.5 ) / 1.5 );
#if HUMANS_V2
        vec3 irradiance = mix( vec3( dotNL ), vec3( dotNL ) * 0.8 + wrapNL * vec3( 0.27, 0.11, 0.075 ), hSkinM ) * directLight.color;
#else
        vec3 irradiance = mix( vec3( dotNL ), vec3( dotNL ) * 0.72 + wrapNL * vec3( 0.36, 0.15, 0.10 ), hSkinM ) * directLight.color;
#endif
#if HUMANS_V2
        irradiance *= 1.0 - hBrimShadow( directLight.direction );
#endif
        if ( hHairM > 0.0 ) reflectedLight.directSpecular += hHairM * hHairSpec( directLight.direction, geometryViewDir, geometryNormal, hHairT ) * saturate( dotNLr * 2.0 + 0.3 ) * directLight.color;`));
    }
    fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      reflectedLight.indirectDiffuse *= hAO;
      // (the eyes' wet surface mirrors the sky even in the lid's shade: the catch light)
      reflectedLight.indirectSpecular *= hRegion == 4 ? mix( 1.0, hAO, 0.25 ) * ( 1.0 - 0.6 * hEyeLid ) : hAO * mix( 1.0, 0.35, hHairM );
      reflectedLight.directDiffuse *= mix( 1.0, hAO, hDirAO );
      // indoors (a tram saloon): the slot's own fill light, and less of the sky
      reflectedLight.indirectDiffuse = reflectedLight.indirectDiffuse * ( 1.0 - vFill.w ) + vFill.rgb * diffuseColor.rgb * hAO;
      reflectedLight.indirectSpecular *= 1.0 - vFill.w;
      // (strand cards: the env map's broad sheen on hair reads as plastic; the strands' own sky highlight
      // below stands in for it)
      if ( hCard || hTail ) reflectedLight.indirectSpecular *= 0.2;
      #if HUMANS_V2 && defined( RE_IndirectSpecular )
      if ( hRegion == 4 ) {
        // a catch light: the bright sky above and behind the viewer mirrored in the cornea
        vec3 upV = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
        vec3 Rv = reflect( - geometryViewDir, geometryNormal );
        float cl = smoothstep( 0.975, 0.993, dot( Rv, normalize( geometryViewDir + upV * 0.5 ) ) ) * ( 1.0 - hEyeLid );
        reflectedLight.indirectSpecular += cl * iblIrradiance * 0.22;
      }
      #endif
      #if defined( RE_IndirectSpecular )
      if ( hHairM > 0.0 ) {
        // the sky's sheen along the strands: hair in the shade keeps a soft highlight band
        vec3 upS = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
        reflectedLight.indirectSpecular += hHairM * hHairSpec( upS, geometryViewDir, geometryNormal, hHairT ) * iblIrradiance * ( hCard || hTail ? 0.035 : 0.08 );
      }
      #endif`);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'humans-mh-v' + (v2 ? 2 : 1) + 'r5-' + (debugView | 0);

  const depth = new THREE.MeshDepthMaterial();
  depth.name = 'humans.figures.depth';
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchVertex(shader, true);
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', `#include <common>
      uniform highp sampler2DArray uAlbedo;
      uniform float uBeardBase;
      varying vec2 vCastUv;
      flat varying vec4 vCastTex;`);
    fs = fs.replace('#include <alphatest_fragment>', `
      // (beard shells: every fifth casts the volume's shadow)
      if (uBeardBase > 0.5 && int(vCastTex.z + 0.5) == 11 && ((int(vCastTex.w + 0.5) >> 4) % 5) != 0) discard;
      if ((int(vCastTex.w + 0.5) & 1) != 0) {
        vec2 tsz = vec2(textureSize(uAlbedo, 0).xy);
        vec2 dx = dFdx(vCastUv * tsz), dy = dFdy(vCastUv * tsz);
        float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
        if (texture(uAlbedo, vec3(vCastUv, vCastTex.x)).a * (1.0 + max(lod, 0.0) * 0.22) < 0.5) discard;
      }`);
    shader.fragmentShader = fs;
  };
  depth.defines = { HUMANS_V2: v2 ? 1 : 0 };
  depth.customProgramCacheKey = () => 'humans-mh-depth-v' + (v2 ? 2 : 1) + 'r3';
  return { mat, depth, uniforms };
}

// (humans_face=<k>: the face shapes scaled by k, 0 = every instance of a character the same; for testing)
export const FACE = { scale: 1 };
const FACE_AMP = 1.45;

/** Float RGBA data texture (nearest, no mips). */
export function floatTexture(w, h) {
  const t = new THREE.DataTexture(new Float32Array(w * h * 4), w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * Writes one person's look row: region tints (texels 0-15), pattern (16, 17) and the character's
 * landmarks for the vertex shader (18-23: thigh capsules L / R, wrists L / R (x hem height); 24: head centre; 25: right eye centre).
 */
export function writeLook(data, row, a) {
  const o = row * LOOK_W * 4;
  const T = a.tints;
  for (let i = 0; i < 16; i++) {
    data[o + i * 4] = T[i * 3]; data[o + i * 4 + 1] = T[i * 3 + 1]; data[o + i * 4 + 2] = T[i * 3 + 2]; data[o + i * 4 + 3] = 0;
  }
  // (lashes texel w: how much thinner the lashes are drawn: men's and children's lashes read as
  // eyeliner at full density)
  data[o + 15] = a.female && a.age !== 'child' && a.age !== 'toddler' ? 0 : 0.4;
  // hair texel w: the scalp under the hair takes its colour; beard texel w: beard growth density
  // (stubble .. full); garment texels w: detail contrast (0 = as textured)
  data[o + 4 + 3] = a.hairPart ? 1 : 0;
  data[o + 44 + 3] = a.beardDens || 0;
  // prop texel w: the tone of a glasses frame (0 black .. 1 tortoiseshell)
  data[o + 48 + 3] = a.frameTone || 0;
  data[o + 20 + 3] = a.detailTop || 0;
  data[o + 28 + 3] = a.detailBottom || 0;
  const pat = a.patColor || [T[12 * 3], T[12 * 3 + 1], T[12 * 3 + 2]];
  data[o + 64] = pat[0]; data[o + 65] = pat[1]; data[o + 66] = pat[2]; data[o + 67] = a.pattern || 0;
  data[o + 68] = a.patScale || 1; data[o + 69] = a.char.info.H; data[o + 70] = a.topKind === 'dress' ? 1 : 0; data[o + 71] = a.seedT || 0;
  const J = a.char.skeleton.joints, th = a.char.info.thigh || { L: [0.08, 0.05], R: [0.08, 0.05] };
  const put = (i, j, r) => { data[o + i * 4] = J[j][0]; data[o + i * 4 + 1] = J[j][1]; data[o + i * 4 + 2] = J[j][2]; data[o + i * 4 + 3] = r; };
  put(18, 14, th.L[0]); put(19, 15, th.L[1]); put(20, 18, th.R[0]); put(21, 19, th.R[1]);
  put(22, 9, a.char.hemY ?? -1); put(23, 13, 0);
  const hc = a.char.info.headC || J[5];
  data[o + 96] = hc[0]; data[o + 97] = hc[1]; data[o + 98] = hc[2]; data[o + 99] = 0;
  // a hat's brim (shadow on the face): hat texel w = band height (rest y), head texel w = brim radius
  const hat = a.char.hat;
  if (hat) { data[o + 40 + 3] = hat.band; data[o + 99] = hat.rb; }
  const ey = a.char.info.eyeR || [0.031, hc[1] + 0.02, hc[2] - 0.05];
  data[o + 100] = Math.abs(ey[0]); data[o + 101] = ey[1]; data[o + 102] = ey[2];
  // (eyeball radius, for the iris drawn over the texture's; 0: the texture's own iris)
  data[o + 103] = a.irisOn && a.char.eyeR ? a.char.eyeR : 0;
  // eyebrows on the skin: the brow cards' centre line and half height (see mh/brows in humans.js),
  // brows texel w = opacity
  const B = a.char.brow;
  if (B) {
    data[o + 104] = B.x0; data[o + 105] = B.x1; data[o + 106] = B.a; data[o + 107] = B.b;
    data[o + 108] = B.c; data[o + 109] = B.t0; data[o + 110] = B.t1; data[o + 111] = B.z;
    data[o + 8 + 3] = a.browOpacity ?? 0.7;
  } else {
    for (let k = 104; k < 112; k++) data[o + k] = 0;
  }
  // face shape (hFaceWarp) and skin variety (texels 28-33): the character's landmarks, then the person's own
  // nose, jaw, chin, cheeks, lower face, brows, lips, face width, eye spacing (-1..1), redness, freckles,
  // age lines, a seed for moles
  const F = a.char.face, K = a.faceK;
  for (let k = 112; k < 136; k++) data[o + k] = 0;
  if (F && K) {
    data[o + 112] = F.nose[0]; data[o + 113] = F.nose[1]; data[o + 114] = F.nose[2]; data[o + 115] = F.hk;
    data[o + 116] = F.mouthY; data[o + 117] = F.chinY; data[o + 118] = 0; data[o + 119] = a.ageF || 0;
    // (shape coefficients x FACE_AMP: the faces of one character's instances differ enough to read as
    // different people at a few metres, within a plausible range)
    for (let k = 0; k < 12; k++) data[o + 120 + k] = (K[k] || 0) * (k < 10 ? FACE.scale * FACE_AMP : 1);
    data[o + 132] = a.moleSeed || 0; data[o + 133] = a.lineK || 0;
  }
}
