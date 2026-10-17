import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

// Materials for the crowd figures: MeshPhysicalMaterial (so the shared lighting, shadows,
// fog and environment all apply) patched with
//  - GPU skinning from a per-figure bone texture row (instance transform folded in on the CPU)
//  - heavy/slim build, belly and face shape morphs, per-figure head size, part toggling
//  - garment "ease": clothes stand off the body, hang straight from the chest, sleeves are tubes
//  - an analytic skirt / coat shell generated from (angle, length) vertex coordinates that
//    keeps clear of the legs, swings with the gait and drapes over the knees when seated
//  - per-fragment clothing layout (sleeves, hems, collars, patterns, shoes), face painting
//    (eyes, brows, lips, stubble), hair strands, fabric sheen and folds
//  - wrapped diffuse with a warm scatter tint on skin (cheap subsurface approximation)
// All colours / styles come from the per-figure look texture (appearance.js writeRow); the
// per-frame state (gait phase, speed, seated blend, phone) sits after the bones in the bone row.

export const BONE_DYN = 66;
const HAIR_PART = { LONG: 'hair_long', PONY: 'hair_ponytail', BUN: 'hair_bun', BOB: 'hair_bob', PIXIE: 'hair_pixie',
  RECEDING: 'hair_receding', SHORT: 'hair_short', BUZZ: 'hair_buzz' };   // texel index of the per-frame state in a bone row (after 22 x 3 bone texels)

const COMMON = /* glsl */`
uniform highp sampler2D uBoneTex;
uniform highp sampler2D uLookTex;
uniform float uMorphScale;
uniform vec4 uShapeScale;  // face A, face B, face old, belly morph scales (m)
uniform vec4 uShoulder;   // shoulder joint x, y, z, arm length (shoulder -> wrist)
uniform vec4 uArm;        // sin(abduction), cos(abduction), skirt part id, base kind (0 m, 1 f, 2 child)
uniform vec4 uLeg;        // hip joint x, y, knee y, ankle y
uniform vec4 uLeg2;       // ankle x, ankle z, knee x, knee z
uniform vec4 uTorso;      // crotch y, waist y, neck y, stature
uniform vec4 uSkirt0;     // waist ring: y, rx, rz, cz
uniform vec4 uSkirt1;     // hip ring: y, rx, rz, cz
uniform vec4 uHead;       // head centre (eye level) xyz, head scale
uniform vec4 uEye;        // right eye centre xyz, eyeball radius
uniform vec4 uHang0;      // straight-hang envelope rings from the chest down: y, rx, z front, z back
uniform vec4 uHang1;
uniform vec4 uHang2;
uniform vec4 uHang3;
uniform vec4 uHeadJ;      // rest head joint xyz, phone part id
const vec3 CR_C = vec3(0.0, 0.014, 0.006);      // cranium ellipsoid of the head sculpt (head-local)
const vec3 CR_R = vec3(0.0745, 0.096, 0.098);
vec4 hLook(int row, int i) { return texelFetch(uLookTex, ivec2(i, row), 0); }
float hSeg(vec3 p, vec3 a, vec3 b) { vec3 pa = p - a, ba = b - a; float t = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * t); }
// distance from the rest-pose leg axis (hip - knee - ankle)
float hLegDist(vec3 r) {
  float s = sign(r.x);
  vec3 hip = vec3(s * uLeg.x, uLeg.y, 0.0), knee = vec3(s * uLeg2.z, uLeg.z, uLeg2.w), ank = vec3(s * uLeg2.x, uLeg.w, uLeg2.y);
  return min(hSeg(r, hip + vec3(0.0, 0.1, 0.0), knee), hSeg(r, knee, ank));
}
// top hem height: 0 = just below the seat, 1 = at the waist (tucked), < 0 = below the seat (jackets)
float hTopHemY(float hem) { return uLeg.y - 0.035 + hem * (uTorso.y - uLeg.y + 0.035); }
float hLegHemY(float hem) { return hem < 0.02 ? uLeg.w - 0.02 : mix(uLeg.w + 0.03, uTorso.x - 0.02, hem); }  // 0 = full length, breaking over the shoe
// neckline height of a top at a rest point: a collar ring around the base of the neck that rises
// over the shoulders and dips at the front for scoop / V necks (men's and children's tees: crew neck)
// distance from the neck axis in neck radii (1 at the base of the neck, ~1.6 out on the shoulders)
float hNeckRn(vec3 r, vec2 nr) { float sc = uTorso.w / 1.76; return length(vec2(r.x / nr.x, (r.z - 0.02 * sc) / nr.y)) / sc; }
float hNeckline(vec3 r, float topType) {
  float sc = uTorso.w / 1.76;
  float front = smoothstep(0.0, -0.06, r.z);
  bool crew = uArm.w != 1.0 && (topType == 0.0 || topType == 6.0);
  float scoop = (topType == 4.0 || topType == 7.0) ? 0.07 : topType == 3.0 ? 0.05
    : (topType == 2.0 || topType == 1.0 || topType == 5.0) ? 0.035 : crew ? 0.004 : 0.016;
  vec2 nr = crew ? vec2(0.076, 0.066) : vec2(0.085, 0.075);
  float rn = hNeckRn(r, nr);
  return uTorso.z - (crew ? 0.002 : 0.010) - scoop * front * smoothstep(0.11, 0.0, abs(r.x)) + 0.09 * smoothstep(0.9, 1.6, rn);
}
// jacket lapels: half width of the V opening at height y (shirt shows inside)
float hLapel(float y) {
  float sc = uTorso.w / 1.76, neck = uTorso.z, button = uTorso.y + 0.07 * sc;
  return 0.058 * sc * smoothstep(button, neck - 0.06 * sc, y) * smoothstep(neck + 0.01, neck - 0.04 * sc, y) + 0.006;
}
// collared tops (polo, shirt, jacket's shirt): top edge of the collar band around the neck
float hCollarTop(vec3 r, float topType) {
  float sc = uTorso.w / 1.76;
  return uTorso.z + (topType == 1.0 ? 0.032 : 0.042) * sc - 0.02 * sc * smoothstep(-0.01, -0.05, r.z);
}
// coverage of the top on the torso and neck: one continuous rule, so region boundaries of the
// mesh never show. Returns (layer, signed distance to the edge, ease kind)
vec3 hTopUpper(vec3 r, float topType, float topY) {
  float y = r.y, neck = uTorso.z, sc = uTorso.w / 1.76;
  float front = smoothstep(-0.01, -0.05, r.z);
  float e = y - topY;
  bool collar = topType == 1.0 || topType == 2.0 || topType == 5.0;
  if (collar) {
    // collar band up the neck; the neck is open in a V down the placket (narrowing downwards)
    float ct = hCollarTop(r, topType);
    // (polo: two buttons open, shirt: the top button open; a narrow V, not a keyhole)
    float vd = (topType == 1.0 ? 0.065 : topType == 2.0 ? 0.085 : 0.035) * sc;
    float vw = (topType == 5.0 ? 0.013 : 0.021) * sc * clamp((y - neck + vd) / (vd + 0.015 * sc), 0.0, 1.0);
    e = min(e, ct - y);
    if (r.z < 0.0) e = min(e, mix(1.0, max(abs(r.x) - vw, neck - vd - y), front));
  } else e = min(e, hNeckline(r, topType) - y);
  if (topType == 3.0) { // tank: oval arm holes leave ~3 cm straps over the shoulders
    vec2 ah = (vec2(abs(r.x), y) - vec2(uShoulder.x + 0.005 * sc, uShoulder.y - 0.035 * sc)) / (vec2(0.088, 0.125) * sc);
    e = min(e, (length(ah) - 1.0) * 0.09 * sc);
  }
  if (e <= 0.0) return vec3(0.0, e, 0.0);
  if (topType == 5.0) {
    // jacket: lapels open a V down to the button (shirt inside); the shirt collar shows above
    // the jacket collar
    float ef = abs(r.x) - hLapel(y);
    if (ef < 0.0 && r.z < -0.02 && y > uTorso.y + 0.07 * sc) return vec3(4.0, min(e, -ef), 1.0);
    // (the neck surface lies at about rn 0.7-0.8: the jacket collar closes right behind the shirt collar)
    float jt = neck + 0.026 * sc - 0.05 * sc * front + 0.09 * smoothstep(0.8, 1.02, hNeckRn(r, vec2(0.085, 0.075)));
    if (y > jt) return vec3(4.0, e, 1.0);
  }
  return vec3(1.0, e, 1.0);
}
// garment layout at a rest-pose point: x = layer (0 skin, 1 top, 2 bottom, 3 shoe, 4 under-shirt), y = signed
// distance (m) to the layer boundary (> 0 inside), z = which garment ease applies (0 none, 1 top, 2 bottom)
vec3 hGarment(vec3 r, float region, vec4 L2, vec4 L4, vec4 L8) {
  float topType = L2.w, botType = L4.w;
  float y = r.y;
  float topY = hTopHemY(L8.y);
  float hemY = hLegHemY(L8.z);
  float waist = uTorso.y + 0.012;
  bool skirtLike = botType > 2.5 && botType < 3.5 || botType > 4.5;
  if (region == 1.0 || region == 19.0 || region == 20.0 || region == 2.0) {
    vec3 t = hTopUpper(r, topType, topY);
    if (t.x > 0.5) return t;
    if (region != 2.0 && y < waist) return vec3(2.0, waist - y, 2.0);
    return t;
  }
  if (region == 4.0 || region == 5.0 || region == 6.0) {
    float s = sign(r.x);
    vec3 sh = vec3(s * uShoulder.x, uShoulder.y, uShoulder.z);
    vec3 du = vec3(s * uArm.x, -uArm.y, 0.0);
    float t = dot(r - sh, du) / uShoulder.w;
    float e = (L8.x * 1.02 - t) * uShoulder.w;
    // tanks: the torso's arm hole rule decides near the shoulder
    if (topType == 3.0) e = min(hTopUpper(r, topType, hTopHemY(L8.y)).y, (0.10 - t) * uShoulder.w);
    if (region == 6.0) e = min(e, -0.001);
    if (e > 0.0) return vec3(1.0, e, 1.0);
    return vec3(0.0, e, 0.0);
  }
  if (region == 7.0 || region == 8.0) {
    float et = y - topY;
    if (et > 0.0) return vec3(1.0, et, 1.0);   // long tops and jackets hang over the hips
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
attribute vec4 aShape;
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
// rest-space shell of a skirt / dress / coat at (angle th, height y); n = outward normal
vec3 hSkirtRing(float th, float y, vec4 L0, vec4 L9, float folds, float seatW, out vec3 n) {
  float uh = smoothstep(0.0, 1.0, clamp((uSkirt0.x - y) / (uSkirt0.x - uSkirt1.x), 0.0, 1.0));
  vec3 ring = mix(uSkirt0.yzw, uSkirt1.yzw, uh);
  float below = max(0.0, uSkirt1.x - y);
  float sc = uTorso.w / 1.76;
  // seated: the shell wraps the thighs closely instead of standing off as a bell
  ring.y = mix(ring.y, min(ring.y, (0.088 + 0.012 * max(L0.w, 0.0)) * sc), seatW * smoothstep(0.0, 0.06, below));
  ring.z = mix(ring.z, 0.0, seatW * smoothstep(0.0, 0.06, below));
  float ease = 0.014 + 0.022 * max(L0.w, 0.0);
  float flare = (0.03 + 0.17 * L9.z) * (1.0 - 0.7 * seatW);
  // the lower half of a long skirt hangs nearly straight (its own weight): no lampshade cone
  float fl = flare * (below - 0.55 * max(below - 0.30, 0.0));
  float s = sin(th), c = cos(th);
  float f2 = floor(folds * 1.6 + 0.5);
  float fold = below * (0.020 + 0.03 * L9.z) * (1.0 - 0.5 * seatW) * (0.6 * sin(th * folds + 1.3) + 0.4 * sin(th * f2 + 0.4));
  float rx = ring.x + ease + fl + fold, rz = ring.y + ease + fl * 0.85 + fold;
  n = normalize(vec3(s * rz, flare * 0.5, c * rx));
  return vec3(s * rx, y, ring.z + c * rz);
}
// pushes a posed point out of a tapered leg capsule
vec3 hPushLeg(vec3 P, vec3 a, vec3 b, float ra, float rb) {
  vec3 ba = b - a;
  float h = clamp(dot(P - a, ba) / dot(ba, ba), 0.0, 1.0);
  vec3 c = a + ba * h;
  vec3 d = P - c;
  float l = length(d), r = mix(ra, rb, h);
  return l < r && l > 1e-5 ? c + d * (r / l) : P;
}
void hSkin(out vec3 P, out vec3 N) {
  int brow = int(iRow + 0.5);
  vec4 D0 = texelFetch(uBoneTex, ivec2(${BONE_DYN}, brow), 0);       // gait phase, speed, seated blend, ground y
  vec4 D1 = texelFetch(uBoneTex, ivec2(${BONE_DYN + 1}, brow), 0);   // look row, phone shown, hands in pockets
  int row = int(D1.x + 0.5);
  float region = aBody.x, part = aBody.y;
  vec4 L11 = hLook(row, 11);
  float bagPart = mod(L11.w, 256.0), skirtPart = floor(L11.w / 256.0 + 0.001);
  bool on = part < 0.5 || part == L11.x || part == L11.y || part == L11.z || part == bagPart
    || (part == skirtPart && part == uArm.z) || (part == uHeadJ.w && D1.y > 0.5)
    || (part == __GLASSES__ && hLook(row, 6).w > 0.5);
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
  vec4 L13 = hLook(row, 13);
  float seatW = D0.z;
  bool skirt = part == uArm.z && part > 0.5;
  // seated skirt: the knee ring and the vertical fall below it (world space, set after skinning)
  float drop = 0.0;
  vec3 kneePos = vec3(0.0), kneeN = vec3(0.0);
  float skirtT = 0.0;
  if (skirt) {
    // analytic skirt / coat: position.x = angle around the body, position.y = 0 (waist) .. 1 (ankle)
    vec4 L9 = hLook(row, 9);
    float th = position.x;
    float t = min(position.y, L9.y);
    float Lr = uSkirt0.x - uLeg.w - 0.03;
    // uneven hem: soft waves that grow towards the hem
    float y = uSkirt0.x - t * Lr + 0.012 * t * sin(th * 5.0 + L9.w * 6.28) * (1.0 - seatW);
    vec3 n;
    pos = hSkirtRing(th, y, L0, L9, L13.y, seatW, n);
    nrm = n;
    vRest = pos;
    vAux = vec2(t, th);
    skirtT = t;
    // swing with the gait: the hem trails the stride a little
    float sp = min(D0.y, 1.6) * (1.0 - seatW);
    float A = 0.04 * L9.y * (0.5 + L9.z) * sp;
    pos.z -= A * sin(6.2832 * D0.x - 0.6) * t * t;
    pos.x += 0.4 * A * sin(12.566 * D0.x) * t * t;
    // pelvis on top, each side follows its thigh lower down (all the way when seated)
    float wt = mix(0.75 * smoothstep(uSkirt1.x + 0.02, uSkirt1.x - 0.30, y), smoothstep(uSkirt1.x + 0.01, uSkirt1.x - 0.06, y), seatW);
    float s = sin(th);
    float wl = wt * smoothstep(0.45, -0.45, s), wr = wt * smoothstep(-0.45, 0.45, s);
    W = vec4(1.0 - wl - wr, wl, wr, 0.0);
    I = vec4(1.0, 14.0, 18.0, 0.0);
    if (seatW > 0.0 && y < uLeg.z) {
      // below the knee the cloth falls straight down from the knee ring
      vec3 kn;
      kneePos = hSkirtRing(th, uLeg.z, L0, L9, L13.y, seatW, kn);
      kneeN = kn;
      drop = uLeg.z - y;
    }
  } else if (part < 0.5) {
    vec4 L12 = hLook(row, 12);
    float headK = (region == 3.0 || region == 10.0 || region == 16.0 || region == 17.0 || region == 18.0) ? 0.45 : region == 2.0 ? 0.7 : 1.0;
    pos += aMorph.xyz * uMorphScale * (L0.w > 0.0 ? L0.w * 1.4 : L0.w) * headK;
    pos += nrm * dot(aShape, L12 * uShapeScale);
    pos = hFace(pos, position, region, L0.w, hLook(row, 9).w);
#ifndef HUMAN_DEPTH
    // clothes stand off the skin: ease grows with looseness, with a lip at hems
    vec4 L2 = hLook(row, 2), L4 = hLook(row, 4), L8 = hLook(row, 8), L9 = hLook(row, 9);
    vec3 g = hGarment(position, region, L2, L4, L8);
    float sc = uTorso.w / 1.76;
    float ease = 0.0;
    bool isArm = region == 4.0 || region == 5.0;
    bool isLeg = region == 7.0 || region == 8.0;
    bool jacket = L2.w == 5.0;
    if (g.z == 1.0) {
      ease = 0.003 + 0.008 * L8.w + (jacket ? 0.008 : 0.0);
      if (isArm) {
        // sleeves hang as tubes, filling out from the shoulder cap down (no square shoulder corner)
        float s = sign(position.x);
        vec3 sh = vec3(s * uShoulder.x, uShoulder.y, uShoulder.z), du = vec3(s * uArm.x, -uArm.y, 0.0);
        float t = dot(position - sh, du) / uShoulder.w;
        float d = length(cross(position - sh, du));
        float R = jacket ? (0.062 + 0.010 * L8.w) * sc * (1.0 - 0.25 * clamp(t, 0.0, 1.0))
          : (0.050 + 0.016 * L8.w) * sc * (L8.x < 0.6 ? 1.12 : 0.92);
        ease = max(ease, (R - d) * smoothstep(0.02, 0.18, t));
      } else if (region == 1.0 || region == 19.0 || region == 20.0) {
        // tops hang straight down from the chest instead of following the waist
        float y = position.y;
        vec4 h0 = uHang0, h1 = y > uHang1.x ? uHang0 : y > uHang2.x ? uHang1 : uHang2, h2 = y > uHang1.x ? uHang1 : y > uHang2.x ? uHang2 : uHang3;
        vec4 hr = mix(h1, h2, clamp((h1.x - y) / max(h1.x - h2.x, 1e-3), 0.0, 1.0));
        float cz = 0.5 * (hr.z + hr.w), rz = 0.5 * (hr.w - hr.z);
        vec2 v = vec2(position.x, position.z - cz);
        float lv = max(length(v), 1e-4);
        float R = hr.y * rz / length(vec2(rz * v.x, hr.y * v.y) / lv);
        float hang = jacket ? R - lv + 0.015 + 0.01 * L8.w : (R * (0.97 + 0.03 * L8.w) - lv) * clamp(0.25 + 0.95 * L8.w, 0.0, 1.0);
        // fades in below the chest ring, and out towards the arm pits, where the sleeves join (a
        // bulge there against the snug sleeve cap reads as a raglan crease)
        hang *= smoothstep(h0.x + 0.05 * sc, h0.x - 0.03 * sc, y)
          * (1.0 - smoothstep(0.62, 0.9, abs(position.x) / uShoulder.x) * smoothstep(h0.x - 0.16 * sc, h0.x - 0.04 * sc, y));
        // tucked tops (and anything under a skirt waistband) blouse a little above the waist only
        if (L13.z > 0.5) hang *= smoothstep(uTorso.y, uTorso.y + 0.09 * sc, y);
        if (skirtPart == uArm.z && skirtPart > 0.5) hang *= smoothstep(uSkirt0.x, uSkirt0.x + 0.08 * sc, y);
        ease = max(ease, hang);
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
        if (bt == 2.0) {
          // shorts: a straight leg tapering slightly to the hem
          float hy = hLegHemY(L8.z);
          float u = clamp((uTorso.x - position.y) / max(uTorso.x - hy, 0.05), 0.0, 1.0);
          R = (uArm.w == 0.0 ? 0.066 + 0.012 * L9.x : 0.060 + 0.010 * L9.x) * sc * (1.0 - 0.09 * u);
        }
        ease = max(ease, R - d);
      }
      if (region == 1.0 || region == 19.0) ease = min(ease, 0.006);
    }
    // hems: the ease holds right to the edge (a sewn cuff), only the last millimetres roll in;
    // necklines hug the neck (a wide roll, so the surface never folds over itself)
    bool nearNeck = position.y > uTorso.z - 0.07 * sc;
    // the collar hugs the neck: a function of height (not of the mesh region), so no ledge where
    // the neck region's triangles meet the torso's
    ease = mix(ease, min(ease, 0.005), smoothstep(uTorso.z - 0.07 * sc, uTorso.z - 0.015 * sc, position.y));
    // the neck / chest crease is concave: offsetting it would fold the surface over itself
    if (g.z == 1.0 && !isArm) ease = min(ease, mix(0.03, 0.004, smoothstep(uTorso.z - 0.10 * sc, uTorso.z - 0.035 * sc, position.y)));
    ease *= smoothstep(-0.002, nearNeck ? 0.02 : g.z == 2.0 ? 0.002 : 0.006, g.y);
    // hide the body under skirts and long coats
    if (skirtPart == uArm.z && skirtPart > 0.5 && (region == 1.0 || region == 19.0 || region == 20.0 || isLeg)) {
      float hemY = mix(uSkirt0.x, uLeg.w + 0.03, L9.y);
      float y = position.y;
      if (y < uSkirt0.x - 0.012 && y > hemY + 0.03)
        ease = -0.022 * sc * smoothstep(hemY + 0.03, hemY + 0.10, y) * smoothstep(uSkirt0.x - 0.012, uSkirt0.x - 0.03, y)
          * (1.0 + 1.6 * D0.z * smoothstep(uSkirt1.x + 0.06, uSkirt1.x - 0.02, y));   // seated: hips and thighs under the drape
    }
    pos += nrm * ease;
    if (g.z == 1.0 && (region == 1.0 || region == 20.0) && g.y > 0.0) {
      // cloth bridges the hollows round the shoulder (the body's deltopectoral groove and arm
      // pit): shade it with a smoother, more radial normal than the skin below it
      vec3 rd = normalize(vec3(position.x, 0.0, position.z - 0.01));
      float w = 0.5 * smoothstep(uShoulder.y + 0.01 * sc, uShoulder.y - 0.09 * sc, position.y) * smoothstep(0.35, 0.65, abs(position.x) / uShoulder.x);
      nrm = normalize(mix(nrm, rd, w));
    }
#if HUMANS_DBG == 3
    vAux = vec2(ease * 40.0);
#endif
#endif
  } else if (part == uHeadJ.w) {
    // phone: nothing to shape
  } else {
    vec4 L12 = hLook(row, 12);
    pos += nrm * dot(aShape, L12 * uShapeScale);
    if (part == __SHOULDERBAG__) {
      // the bag swings on its strap from the shoulder with the gait (and bounces a little sideways)
      float sp = min(D0.y / 1.3, 1.2);
      float a1 = 0.10 * sp * sin(6.2832 * D0.x - 0.8), a2 = 0.035 * sp * sin(12.566 * D0.x + 0.3);
      vec3 piv = vec3(0.10 * uTorso.w / 1.76, uShoulder.y, 0.0);
      vec3 d = pos - piv;
      float c1 = cos(a1), s1 = sin(a1), c2 = cos(a2), s2 = sin(a2);
      d = vec3(d.x, c1 * d.y - s1 * d.z, s1 * d.y + c1 * d.z);
      d = vec3(c2 * d.x - s2 * d.y, s2 * d.x + c2 * d.y, d.z);
      pos = piv + d;
      nrm = vec3(nrm.x, c1 * nrm.y - s1 * nrm.z, s1 * nrm.y + c1 * nrm.z);
      nrm = vec3(c2 * nrm.x - s2 * nrm.y, s2 * nrm.x + c2 * nrm.y, nrm.z);
    }
    if (region == 11.0 && L11.z > 0.5) {
      // hair under a hat: hidden inside the crown, pressed flat just below the band
      vec3 q = (pos - uHead.xyz) / uHead.w;
      vec3 cr = q - CR_C;
      float k = length(cr / CR_R);
      float lc = length(cr);
      float off = lc * (1.0 - 1.0 / max(k, 1e-3));            // height above the cranium along the centre ray
      float hat = L11.z;
      // (a cap's edge slopes down to the occiput at the back: humans_parts.hat_band)
      float band = hat == __CAP__ ? 0.042 - 0.034 * smoothstep(-0.02, 0.09, q.z) : hat == __SUNHAT__ ? 0.040 : 0.036;
      float hOff = hat == __CAP__ ? __CAP_OFF__ : hat == __SUNHAT__ ? __SUNHAT_OFF__ : 0.004;
      float back = smoothstep(0.0, 0.06, cr.z);
      float maxOff = q.y > band ? -0.003 : hOff - 0.004 + (band - q.y) * mix(0.8, 0.45, back);
      if (off > maxOff) {
        q = CR_C + cr * ((lc / max(k, 1e-3) + maxOff) / lc);
        pos = uHead.xyz + q * uHead.w;
      }
    }
  }
  if (region == 12.0) pos = hFace(pos, position, 3.0, L0.w, hLook(row, 9).w);
  // bigger heads on smaller children (and slight variety for everyone): scale about the head joint
  if (!skirt) {
    float wh = dot(W, vec4(equal(I, vec4(5.0))));
    pos += (pos - uHeadJ.xyz) * (L13.x - 1.0) * wh;
  }
  mat4 M = hBone(brow, I.x) * W.x;
  if (W.y > 0.0) M += hBone(brow, I.y) * W.y;
  if (W.z > 0.0) M += hBone(brow, I.z) * W.z;
  if (W.w > 0.0) M += hBone(brow, I.w) * W.w;
  P = (M * vec4(pos, 1.0)).xyz;
  N = normalize(mat3(M) * nrm);
  if (D1.z > 0.01 && region == 6.0 && part < 0.5) {
    float sd = sign(position.x), wsc = length(M[0].xyz);
    mat4 Tb = hBone(brow, sd > 0.0 ? 18.0 : 14.0);
    vec3 hp = (Tb * vec4(sd * uLeg.x, uLeg.y + 0.06, 0.0, 1.0)).xyz, kn = (Tb * vec4(sd * uLeg2.z, uLeg.z, uLeg2.w, 1.0)).xyz;
    vec3 ba = kn - hp;
    float h = clamp(dot(P - hp, ba) / dot(ba, ba), 0.0, 1.0);
    vec3 c = hp + ba * h, d = P - c;
    float l = max(length(d), 1e-4), R = mix(0.088, 0.062, h) * wsc;
    float w = D1.z * smoothstep(R + 0.12 * wsc, R + 0.05 * wsc, l);
    P = mix(P, c + d * (min(l, R * 0.8) / l), w);
  }
  if (skirt) {
    float wsc = length(M[0].xyz);                    // figure scale (bones carry it)
    if (drop > 0.0) {
      // seated: from the knee ring the cloth drapes over the knees into a tube that hangs
      // around the shins down to the hem
      mat4 TL = hBone(brow, 14.0), SL = hBone(brow, 15.0), TR = hBone(brow, 18.0), SR = hBone(brow, 19.0);
      vec3 kL = (TL * vec4(-uLeg2.z, uLeg.z, uLeg2.w, 1.0)).xyz, kR = (TR * vec4(uLeg2.z, uLeg.z, uLeg2.w, 1.0)).xyz;
      vec3 aL = (SL * vec4(-uLeg2.x, uLeg.w, uLeg2.y, 1.0)).xyz, aR = (SR * vec4(uLeg2.x, uLeg.w, uLeg2.y, 1.0)).xyz;
      vec3 Kc = 0.5 * (kL + kR), Ac = 0.5 * (aL + aR);
      mat4 Mr = hBone(brow, 0.0);
      vec3 Xw = normalize(Mr[0].xyz), Zw = normalize(Mr[2].xyz);
      vec3 PK = (M * vec4(kneePos, 1.0)).xyz;
      float dw = drop * wsc;
      float k = clamp(dw / max(Kc.y - Ac.y, 0.1), 0.0, 1.0);
      vec3 C = mix(Kc, Ac, k);
      float th = position.x, sx = sin(th), cx = cos(th);
      float rxk = 0.5 * length(kR - kL) + (0.075 + 0.03 * drop) * wsc, rzk = (0.08 + 0.02 * drop) * wsc;
      float bl = smoothstep(0.0, 0.10, drop);
      vec3 Pd = C + Xw * (sx * rxk) + Zw * (cx * rzk);
      Pd = mix(PK + vec3(0.0, -dw, 0.0), Pd, bl);
      Pd.y = max(Kc.y - dw + (PK.y - Kc.y) * (1.0 - bl), D0.w + 0.01);
      vec3 nk = normalize(Xw * (sx * rzk) + Zw * (cx * rxk));
      P = mix(P, Pd, seatW);
      N = normalize(mix(N, nk, seatW * bl));
    }
    if (seatW < 0.99 && skirtT > 0.08) {
      // keep the shell clear of the stepping legs (posed thigh and shin capsules)
      float bw = 1.0 + 0.25 * max(L0.w, 0.0);
      float cl = 0.015;
      mat4 TL = hBone(brow, 14.0), SL = hBone(brow, 15.0), TR = hBone(brow, 18.0), SR = hBone(brow, 19.0);
      vec3 hipL = (TL * vec4(-uLeg.x, uLeg.y, 0.0, 1.0)).xyz, kneL = (TL * vec4(-uLeg2.z, uLeg.z, uLeg2.w, 1.0)).xyz;
      vec3 ankL = (SL * vec4(-uLeg2.x, uLeg.w, uLeg2.y, 1.0)).xyz;
      vec3 hipR = (TR * vec4(uLeg.x, uLeg.y, 0.0, 1.0)).xyz, kneR = (TR * vec4(uLeg2.z, uLeg.z, uLeg2.w, 1.0)).xyz;
      vec3 ankR = (SR * vec4(uLeg2.x, uLeg.w, uLeg2.y, 1.0)).xyz;
      float rh = (0.080 * bw + cl) * wsc, rk = (0.054 * bw + cl) * wsc, rc = (0.052 * bw + cl) * wsc, ra = (0.034 + cl) * wsc;
      vec3 Q = P;
      Q = hPushLeg(Q, hipL, kneL, rh, rk); Q = hPushLeg(Q, kneL, ankL, rc, ra);
      Q = hPushLeg(Q, hipR, kneR, rh, rk); Q = hPushLeg(Q, kneR, ankR, rc, ra);
      P = mix(P, Q, smoothstep(0.08, 0.2, skirtT) * (1.0 - seatW));
    }
  }
  vHairT = vec3(0.0);
#ifndef HUMAN_DEPTH
  if (region == 11.0 || region == 12.0) {
    // hair strands run away from the crown along the surface (beards: downwards)
    vec3 crown = uHead.xyz + vec3(0.0, 0.10, 0.03) * uHead.w;
    vec3 d = region == 12.0 ? vec3(0.0, -1.0, 0.0) : position - crown;
    vec3 t = d - nrm * dot(d, nrm);
    t = dot(t, t) > 1e-8 ? normalize(t) : vec3(0.0, -1.0, 0.0);
    vHairT = normalize(mat3(viewMatrix) * (mat3(M) * t));
  }
#endif
}
`;

const FRAG_PARS = /* glsl */`
${COMMON}
uniform float uNight;
varying vec3 vRest;
flat varying vec3 vIds;
varying float vAO;
varying vec2 vAux;
varying vec3 vHairT;
float hSkinM = 0.0;
float hHairM = 0.0;
float hStrand = 0.5;
float hSilh = 1.0;
float hF90 = 1.0;     // grazing reflectance: 1 skin / glass, lower for hair and cloth (fibres mask each other)
vec3 hHairC = vec3(0.0);
vec3 hEmit = vec3(0.0);
float hLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
bool hLongHair(float hp) { return hp == __HAIR_LONG__ || hp == __HAIR_PONY__ || hp == __HAIR_BUN__ || hp == __HAIR_BOB__; }
// hairline height (head-local y) of hair style hp at azimuth th (0 front, pi back), as built by
// tools/blender/humans_parts.py (hairline / cap_hair)
float hHairline(float th, float hp) {
  vec2 hft = hp == __HAIR_RECEDING__ ? vec2(0.074, 0.066) : hp == __BALDING__ ? vec2(0.15, 0.13)
    : hLongHair(hp) || hp == __HAIR_PIXIE__ ? vec2(hp == __HAIR_PIXIE__ ? 0.052 : 0.054, 0.040)
    : hp == __HAIR_SHORT__ || hp == __HAIR_BUZZ__ ? vec2(__MALE_FRONT__, __MALE_TEMPLE__) : vec2(__MALE_FRONT__ - 0.003, __MALE_TEMPLE__ - 0.002);
  return th < 0.55 ? mix(hft.x, hft.y, th / 0.55) : th < 1.05 ? mix(hft.y, 0.022, (th - 0.55) / 0.5)
    : th < 1.33 ? mix(0.022, -0.014, (th - 1.05) / 0.28) : th < 1.58 ? mix(-0.014, 0.028, (th - 1.33) / 0.25)
    : th < 1.95 ? mix(0.028, -0.030, (th - 1.58) / 0.37) : mix(-0.030, -0.064, (th - 1.95) / 1.19);
}
// Kajiya-Kay style strand highlights: a faint, slightly tinted primary lobe shifted towards the
// root and a coloured secondary lobe towards the tip; both shifted per strand so the highlight
// breaks up instead of forming a ring
vec3 hHairSpec(vec3 L, vec3 V, vec3 N, vec3 T) {
  vec3 H = normalize(L + V);
  float sh = (hStrand - 0.5) * 0.25;
  vec3 t1 = normalize(T + N * (0.10 + sh)), t2 = normalize(T - N * (0.15 - sh));
  float th1 = dot(t1, H), th2 = dot(t2, H);
  float s1 = pow(sqrt(max(0.0, 1.0 - th1 * th1)), 120.0);
  float s2 = pow(sqrt(max(0.0, 1.0 - th2 * th2)), 24.0);
  vec3 tint = mix(vec3(1.0), hHairC / max(hLum(hHairC), 1e-3), 0.5);
  // a narrow, faint sheen: dark hair stays dark (a few times its diffuse at most), never silvery
  return (0.012 * tint * s1 + hHairC * 0.06 * s2) * vAO;
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
// fabric: base albedo, roughness and sheen for a fabric code (matte cottons, dull wool)
void hFabric(float code, inout vec3 col, inout float rough) {
  if (code < 0.5) { rough = 0.88; hSpec = 0.7; hSheenC = mix(col, vec3(1.0), 0.25) * 0.055; hSheenR = 0.8; }       // cotton
  else if (code < 1.5) { rough = 0.9; hSpec = 0.7; hSheenC = mix(col, vec3(0.8), 0.4) * 0.025; hSheenR = 0.8; }     // denim
  else if (code < 2.5) { rough = 0.78; hSpec = 0.6; hSheenC = col * 0.1 + 0.02; hSheenR = 0.7; }                     // wool suiting
  else if (code < 3.5) { rough = 0.55; hSpec = 0.9; hSheenC = mix(col, vec3(1.0), 0.3) * 0.12; hSheenR = 0.5; }     // synthetic
  else if (code < 4.5) { rough = 0.9; hSpec = 0.7; hSheenC = mix(col, vec3(1.0), 0.3) * 0.045; hSheenR = 0.8; }      // linen
  else { rough = 0.86; hSpec = 0.7; hSheenC = mix(col, vec3(1.0), 0.25) * 0.06; hSheenR = 0.8; }                    // knit
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
    // small all-over floral print: scattered five-petal motifs ~1.5 cm across, one per 2.8 cm cell
    // (jittered inside its cell), averaging to a tint once the cells get near pixel size
    float cs = 0.028 * sc;
    vec3 cp = r / cs + seed * 7.0, ci = floor(cp);
    vec3 hj = vec3(hH3(ci), hH3(ci + 17.1), hH3(ci + 31.7));
    vec3 dv = cp - (ci + 0.3 + 0.4 * hj);
    float d = length(dv);
    float rad = mix(0.17, 0.29, hH3(ci + 5.3)) * (0.78 + 0.22 * cos(5.0 * atan(dv.y, dv.x + dv.z) + hj.x * 6.28));
    float motif = hAA((rad - d) * cs) * step(0.25, hH3(ci + 9.1)) * (1.0 - 0.75 * hAA((0.06 - d) * cs));
    motif = mix(motif, 0.11, smoothstep(0.12, 0.45, length(fwidth(cp))));
    col = mix(col, L3.rgb, 0.9 * motif);
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
  float aoV = vAO;
  // ---- skin with subtle mottling and warm extremities (knuckles, elbows, knees)
  vec3 skinCol = skin * (0.94 + 0.12 * hNoise(r * 55.0));
  float skinRough = 0.48;
  if (part < 0.5) {
    float warmX = 0.0;
    if (region == 6.0) warmX = 0.35;
    if (region == 4.0 || region == 5.0) {
      float sgn = sign(r.x);
      vec3 el = vec3(sgn * uShoulder.x, uShoulder.y, uShoulder.z) + vec3(sgn * uArm.x, -uArm.y, 0.0) * uShoulder.w * 0.56;
      warmX = 0.5 * smoothstep(0.05, 0.0, length(r - el - vec3(0.0, 0.0, 0.03)));
    }
    if (region == 7.0 || region == 8.0) warmX = 0.4 * smoothstep(0.06, 0.0, length(vec2(r.y - uLeg.z - 0.01, r.z - uLeg2.w + 0.045)));
    skinCol *= mix(vec3(1.0), vec3(1.02, 0.86, 0.84), warmX);
    // oilier T-zone on the face
    if (region == 3.0 || region == 18.0) {
      vec3 qq = (r - uHead.xyz) / uHead.w;
      float tz = smoothstep(0.03, 0.0, abs(qq.x)) * smoothstep(-0.05, -0.02, qq.y) + smoothstep(0.04, 0.06, qq.y) * smoothstep(0.09, 0.07, qq.y) * smoothstep(-0.06, -0.08, qq.z);
      skinRough = mix(0.5, 0.36, clamp(tz, 0.0, 1.0));
    }
  }
  if (part < 0.5) {
    vec3 g = hGarment(r, region, L2, L4, L8);
    float cover = hAA(g.y);
    float layer = g.x;
    vec3 cloth = vec3(0.0);
    float crough = 0.86;
    bool jacket = L2.w == 5.0;
    if (layer == 1.0 || layer == 4.0) {
      cloth = layer == 4.0 ? L3.rgb : hTopColor(r, L2, L3, seed);
      hFabric(layer == 4.0 ? 4.0 : topFab, cloth, crough);
      // folds: vertical drape on the torso, rings bunching around elbows and cuffs
      bool arm = region == 4.0 || region == 5.0;
      float drape = hNoise(vec3(r.x * 26.0, r.y * 3.0, r.z * 26.0)) - 0.5;
      float bunch = 0.0;
      float hemY = hTopHemY(L8.y);
      if (arm) {
        float s = sign(r.x);
        float t = dot(r - vec3(s * uShoulder.x, uShoulder.y, uShoulder.z), vec3(s * uArm.x, -uArm.y, 0.0)) / uShoulder.w;
        bunch = sin(t * 95.0 + hNoise(r * 30.0) * 5.0) * (smoothstep(0.30, 0.45, t) * smoothstep(0.70, 0.52, t) + smoothstep(L8.x - 0.12, L8.x, t) * step(0.8, L8.x));
      } else {
        // bunching just above the hem / belt, and soft folds hanging from the chest
        bunch = sin(r.y * 150.0 + hNoise(r * 22.0) * 7.0) * smoothstep(0.09, 0.0, r.y - hemY) * smoothstep(-0.01, 0.01, r.y - hemY) * (0.4 + 0.8 * L8.w);
        bunch += (hNoise(vec3(r.x * 60.0, r.y * 6.0, r.z * 60.0)) - 0.5) * smoothstep(uTorso.y + 0.25, uTorso.y, r.y) * (0.5 + L8.w);
      }
      hBump = 0.0010 * drape + 0.0011 * bunch;
      if (L2.w == 1.0 || L2.w == 2.0 || L2.w == 5.0) {
        // turned-down collar: a raised band with a shadow line along its lower edge
        // (the collar lies round the base of the neck: its outer edge is a ring about the neck axis,
        // so it curves down the front and over the shoulders instead of cutting straight across)
        float ce = (1.1 - hNeckRn(r, vec2(0.085, 0.075))) * 0.07;
        float ctop = hCollarTop(r, L2.w), scC = uTorso.w / 1.76;
        float near = smoothstep(ctop - 0.085 * scC, ctop - 0.05 * scC, r.y);     // a band ~4 cm deep
        cloth *= 1.0 - 0.3 * hAA(0.0016 - abs(ce)) * near;
        hBump += 0.0014 * smoothstep(-0.001, 0.004, ce) * near;
      }
      if (jacket && layer == 1.0) {
        float scT = uTorso.w / 1.76;
        // lapel roll along the V edge (a soft ridge with a shadow line), centre-back vent and seam
        float dl = abs(r.x) - hLapel(r.y);
        float frontJ = step(r.z, -0.02) * step(uTorso.y + 0.07 * scT, r.y) * step(r.y, uTorso.z + 0.01);
        float roll = smoothstep(0.0, 0.004, dl) * smoothstep(0.022 * scT, 0.008 * scT, dl) * frontJ;
        hBump += 0.0016 * roll;
        cloth *= 1.0 - 0.35 * hAA(0.0016 - abs(dl - 0.0008)) * frontJ;
        float vent = hAA(0.0012 - abs(r.x)) * step(0.02, r.z) * step(r.y, hemY + 0.21 * scT);
        float seam = hAA(0.0007 - abs(r.x)) * step(0.02, r.z);
        cloth *= 1.0 - 0.55 * vent - 0.2 * seam * (1.0 - vent);
        // buttons: two on the closed front below the lapels
        vec2 bp = vec2(r.x + 0.004, r.y - uTorso.y - 0.07 * scT);
        float btn = hAA(0.0075 - min(length(bp), length(bp + vec2(0.0, 0.10 * scT)))) * step(r.z, -0.03);
        cloth = mix(cloth, cloth * 0.35, btn);
      }
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
      if (L4.w == 1.0 && botFab != 1.0 && (region == 7.0 || region == 8.0)) {
        // pressed trousers: a faint crease down the front of each leg
        float u = clamp((uLeg.y - r.y) / (uLeg.y - uLeg.w), 0.0, 1.0);
        float lx = mix(uLeg.x, uLeg2.x, u), lz = mix(0.0, uLeg2.y, u) - mix(0.07, 0.05, u) * uTorso.w / 1.76;
        hBump += 0.0007 * smoothstep(0.006, 0.0, abs(abs(r.x) - lx)) * smoothstep(0.03, -0.01, r.z - lz);
      }
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
      // (not inside necklines and plackets: the skin there would read as a dark hole)
      skinCol *= 1.0 - (r.y > uTorso.z - 0.13 ? 0.08 : 0.35) * lip * step(g.y, 0.0);
    }
    float clothCov = cover * step(0.5, layer) * (1.0 - step(2.5, layer) * step(layer, 3.5));
    // the body's baked occlusion (armpits, neck) mostly belongs to skin: cloth bridges those creases
    aoV = mix(vAO, 1.0, (jacket ? 0.5 : 0.85) * clothCov);
    col = mix(skinCol, cloth, cover * step(0.5, layer));
    hF90 = mix(1.0, layer == 3.0 ? 0.8 : 0.45, cover * step(0.5, layer));
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
      float by = q.y - 0.0145 - arch + 0.0012 * smoothstep(0.012, 0.03, ax);
      float bth = mix(0.0036, 0.0013, smoothstep(0.012, 0.048, ax)) * (uArm.w == 1.0 ? 0.8 : 1.0);
      float brow = smoothstep(bth, bth * 0.35, abs(by)) * smoothstep(0.049, 0.043, ax) * smoothstep(0.008, 0.012, ax) * front;
      brow *= 0.55 + 0.45 * hNoise(vec3(q.x * 900.0, q.y * 160.0, 0.0));
      vec3 browC = L1.rgb * 0.75;
      browC *= min(1.0, 0.07 / max(hLum(browC), 1e-3));
      col = mix(col, browC, brow * (uArm.w == 1.0 ? 0.6 : 0.7));
      // lips
      float lip = region == 17.0 ? 1.0 : 0.0;
      col = mix(col, skin * vec3(0.86, 0.66, 0.64), lip * 0.6);
      float mouth = hAA(0.0011 - abs(q.y + 0.0598)) * hAA(0.019 - ax) * front;
      col *= 1.0 - 0.4 * mouth;
      // cheeks / nose / ears a little warmer
      float warm = smoothstep(0.03, 0.0, length(vec2(ax - 0.045, q.y + 0.025))) * 0.5 + (region == 18.0 ? 0.35 : 0.0) + (region == 16.0 ? 0.3 : 0.0);
      col *= mix(vec3(1.0), vec3(1.06, 0.93, 0.92), warm);
      // nostrils
      float nos = smoothstep(0.0042, 0.0018, length(vec2((ax - 0.0085) * 0.8, q.y + 0.0372))) * step(q.z, -0.085);
      col *= 1.0 - 0.35 * nos;
      // stubble / beard shadow
      if (uArm.w == 0.0) {
        float jaw = smoothstep(-0.040, -0.058, q.y) * smoothstep(-0.02, -0.06, q.z + 0.0) * (1.0 - lip)
          + smoothstep(-0.03, -0.042, q.y) * smoothstep(0.012, 0.0, abs(q.y + 0.046)) * hAA(0.024 - ax) * front;
        jaw = clamp(jaw, 0.0, 1.0) * L1.w;
        float dots = mix(hNoise(q * 1400.0), 0.5, smoothstep(0.0004, 0.0015, length(fwidth(q))));
        vec3 stub = mix(vec3(0.84, 0.85, 0.87), L1.rgb * 2.0 + 0.4, 0.4);
        col = mix(col, col * stub, jaw * (0.15 + 0.25 * dots));
      }
      // eyes: sclera, iris, pupil inside the lid opening; lash line
      vec3 ec = vec3(sign(q.x) * abs(uEye.x - uHead.x) / sc, (uEye.y - uHead.y) / sc, (uEye.z - uHead.z) / sc);
      vec3 e = q - ec;
      float er = uEye.w / sc;
      // the sockets' baked occlusion reads as bruised rings at distance: keep it light round the eye
      aoV = mix(aoV, max(aoV, 0.78), smoothstep(er * 2.6, er * 1.2, length(e.xy)) * front);
      float dx = e.x * sign(q.x);
      float up = 0.0043 - 9.0 * dx * dx, lo = -0.0036 + 7.0 * dx * dx;
      float lid = hAA(min(up - e.y, e.y - lo)) * step(length(e), er * 1.25) * step(e.z, 0.0);
      if (lid > 0.0) {
        float d = length(e.xy) / er;
        vec3 irisC = mix(vec3(0.05, 0.028, 0.016), vec3(0.16, 0.12, 0.06), fract(seed * 5.7));
        if (fract(seed * 11.3) > 0.88) irisC = vec3(0.10, 0.15, 0.18);
        vec3 eye = mix(vec3(0.50, 0.46, 0.43), irisC, hAA(0.56 - d));
        eye = mix(eye, vec3(0.01), hAA(0.22 - d));
        eye *= mix(0.55, 1.0, smoothstep(up, lo, e.y));    // upper lid and lashes shade the eye
        col = mix(col, eye, lid);
        rough = mix(rough, 0.08, lid);
        skinAmt *= 1.0 - lid;
        aoV = mix(aoV, max(aoV, 0.8), lid);
      }
      float lash = hAA(0.0011 - abs(e.y - up)) * hAA(0.016 - abs(e.x)) * step(e.z, 0.0) * step(length(e), er * 1.6);
      col = mix(col, L1.rgb * 0.4, lash * 0.85);
      // sunglasses (painted only when the build has no glasses part)
      if (L6.w > 0.5 && __GLASSES__ < 0.0) {
        vec2 le = vec2((dx + 0.002) / 0.0215, (e.y + 0.0015) / 0.0165);
        float lens = hAA(1.0 - length(le) - 0.15 * le.y * le.y * step(0.0, le.y)) * step(q.z, -0.05);
        float rim = hAA(0.0018 - abs(length(le) - 1.0) * 0.02) * step(q.z, -0.05);
        lens = max(lens, rim);
        float bridge = hAA(0.0016 - abs(q.y - 0.007)) * hAA(0.011 - ax) * step(q.z, -0.07);
        float gl = max(lens, bridge);
        col = mix(col, vec3(0.010, 0.011, 0.013), gl);
        rough = mix(rough, 0.35, gl);
        hSpec = mix(hSpec, 0.3, gl);
        skinAmt *= 1.0 - gl;
      }
    }
    // soft hairline: sparse hairs just below the edge of the hair part
    if (region == 3.0 && L11.x > 0.5 && L11.x != __SCARF__ && L11.x != __BALDING__) {
      float hl = hHairline(atan(abs(q.x), -q.z), L11.x);
      float band = smoothstep(hl - 0.010, hl + 0.003, q.y) * (0.45 + 0.25 * hNoise(q * 400.0));
      col = mix(col, L1.rgb * 0.9, band * 0.8);
      skinAmt *= 1.0 - band * 0.6;
    }
    // kippah on the crown
    if (L7.w > 0.5 && (region == 3.0)) {
      float k = hAA(0.052 - length(q - vec3(0.0, 0.088, 0.035)));
      col = mix(col, L7.rgb, k); rough = mix(rough, 0.8, k); skinAmt *= 1.0 - k;
    }
    // bag straps (backpack: two shoulder straps; shoulder bag: one strap from the right shoulder
    // over the trapezius, across the chest and back to the bag on the left hip)
    float bagPart = mod(L11.w, 256.0);
    if (bagPart > 0.5 && (region == 1.0 || region == 20.0 || region == 19.0) && uArm.w < 2.0) {
      float st = 0.0;
      float scT = uTorso.w / 1.76;
      if (bagPart == __BACKPACK__) {
        // shoulder straps: over the shoulders, down the chest and out under the arms
        float sy = uShoulder.y, xs = (0.088 + 0.07 * smoothstep(sy - 0.12 * scT, sy - 0.24 * scT, r.y)) * scT;
        st = hAA(0.018 * scT - abs(abs(r.x) - xs)) * step(sy - 0.27 * scT, r.y);
      }
      else if (bagPart == __SHOULDERBAG__) {
        vec2 a0 = vec2(0.10 * scT, uShoulder.y), a1 = vec2(-0.17 * scT, uLeg.y + 0.12 * scT);
        vec2 nn = normalize(vec2(a1.y - a0.y, a0.x - a1.x));
        float dd = dot(r.xy - a0, nn);
        st = hAA(0.0125 - abs(dd)) * step(r.y, uTorso.z + 0.03);
      }
      col = mix(col, L6.rgb * 0.8, st); rough = mix(rough, 0.6, st); skinAmt *= 1.0 - st; hSheenC *= 1.0 - st;
      hBump += 0.0015 * st;
    }
  } else {
    // ---- parts
    float pr = region;
    if (pr == 11.0 || pr == 12.0) {
      // hair / beard: clumps and strands are streaks along the fall direction (fast across the
      // strands, slow along them), fine strands fade out below a pixel
      vec3 dq = q - vec3(0.0, 0.10, 0.03);
      float az = atan(dq.x, dq.z);
      float rr = length(dq);
      float fw = length(fwidth(r));
      float clump, strand;
      if (pr == 11.0) {
        clump = hNoise(vec3(az * 22.0, rr * 7.0, 0.0));
        strand = hNoise(vec3(az * 115.0, rr * 15.0, 3.0));
      } else {
        clump = hNoise(vec3(q.x * 160.0, q.y * 30.0, q.z * 160.0));
        strand = hNoise(vec3(q.x * 700.0, q.y * 90.0, q.z * 700.0));
      }
      strand = mix(strand, 0.5, smoothstep(0.0015, 0.005, fw));
      float n = clump * 0.6 + strand * 0.4;
      hStrand = strand;
      col = L1.rgb * (0.85 + 0.3 * n);
      hHairM = part == __SCARF__ ? 0.0 : 1.0;
      hHairC = L1.rgb;
      rough = 0.62;
      hSpec = 0.15;      // the strand lobes (hHairSpec) carry the highlight
      hF90 = 0.22;
      hSheenC = vec3(0.0);
      if (pr == 12.0) {
        // the beard thins out towards the cheek line and the sideburns (same line as the build's
        // beard region, humans_parts.beard_part): sparse hairs over skin, no hard ledge
        float thb = atan(abs(q.x), -q.z);
        float top = thb < 0.30 ? mix(-0.041, -0.044, thb / 0.30) : thb < 0.55 ? mix(-0.044, -0.040, (thb - 0.30) / 0.25)
          : thb < 0.95 ? mix(-0.040, -0.024, (thb - 0.55) / 0.40) : thb < 1.30 ? mix(-0.024, -0.008, (thb - 0.95) / 0.35)
          : mix(-0.008, 0.012, clamp((thb - 1.30) / 0.25, 0.0, 1.0));
        float dIn = top - q.y + 0.03 * smoothstep(1.2, 1.5, thb);     // (the sideburns run on into the hair)
        float band = mix(0.005, 0.016, smoothstep(0.4, 0.9, thb));
        float edge = min(smoothstep(0.0, band, dIn + 0.006 * (strand - 0.5) + 0.003 * (clump - 0.5)),
                         clamp(vAux.x * 2.0 + 0.2, 0.0, 1.0));
        col = mix(mix(L0.rgb * 0.82, col, 0.3), col, edge * edge * (3.0 - 2.0 * edge));
        hHairM *= edge;
      }
      if (pr == 11.0 && part != __SCARF__) {
        // hair thins out over the last centimetre or so at its hairline: sparse hairs over skin
        // (the clipper-faded nape of short cuts, the soft front edge), not a helmet rim
        float thh = atan(abs(q.x), -q.z);
        float he = smoothstep(-0.002, 0.016, q.y - hHairline(thh, part) + 0.006 * (strand - 0.5) + 0.004 * (clump - 0.5));
        if (hLongHair(part) && thh > 1.15) he = 1.0;
        col = mix(mix(L0.rgb * 0.8, col, 0.35), col, he);
        hHairM *= he;
      }
      if (part == __SCARF__) { col = L1.rgb * (0.9 + 0.15 * hNoise(r * 40.0)); rough = 0.85; hSpec = 0.6; hF90 = 0.5; hSheenC = col * 0.08; hSheenR = 0.8; }
      if (L7.w > 0.5 && pr == 11.0) {
        float k = hAA(0.054 - length(q - vec3(0.0, 0.092, 0.035)));
        col = mix(col, L7.rgb, k); rough = mix(rough, 0.8, k); hHairM *= 1.0 - k;
      }
    } else if (pr == 13.0) {
      col = L7.rgb; rough = 0.84; hSpec = 0.55; hF90 = 0.5;
      hSheenC = col * 0.15 + 0.01; hSheenR = 0.7;
      if (part == __SUNHAT__) { col *= 0.85 + 0.25 * hBand(atan(q.x, q.z) * 0.6 + length(q.xz) * 3.0, 0.02, 0.5); rough = 0.85; hSheenC *= 0.4; }
      if (vAux.y > 0.5) { col *= 0.35; } // hat band
    } else if (pr == 14.0) {
      col = L6.rgb * (0.92 + 0.12 * hNoise(r * 60.0)); rough = 0.62; hSpec = 0.8; hF90 = 0.7;
      if (part == __SHOPPING__) { rough = 0.6; hSpec = 0.6; col = min(col, vec3(0.7)); }
      float scB = uTorso.w / 1.76;
      if (part == __BACKPACK__) {
        // backpack: zip around the main compartment and the front pocket, seams, a worn base
        float back = step(0.11 * scB, r.z);
        float zip = hAA(0.0022 - abs(abs(r.x) - 0.105 * scB)) * step(uShoulder.y - 0.33 * scB, r.y) * back;
        float topZip = hAA(0.0022 - abs(r.y - uShoulder.y + 0.045 * scB)) * step(abs(r.x), 0.10 * scB) * back;
        float pocket = hAA(0.002 - abs(r.y - uShoulder.y + 0.235 * scB)) * step(abs(r.x), 0.085 * scB) * step(0.2 * scB, r.z);
        float z = max(max(zip, topZip), pocket);
        col = mix(col, col * 0.35, z);
        hBump += 0.0012 * z;
        col *= 1.0 - 0.15 * smoothstep(uShoulder.y - 0.30 * scB, uShoulder.y - 0.38 * scB, r.y);
      } else if (part == __SHOULDERBAG__) {
        // flap edge and a stitched seam around the bag
        float flap = hAA(0.0018 - abs(r.y - uLeg.y - 0.035 * scB)) * step(r.x, -0.15 * scB);
        col = mix(col, col * 0.4, flap);
        hBump += 0.001 * flap;
      }
      hSheenC = col * 0.06;
    } else if (pr == 15.0) {
      bool dress = L4.w > 4.5;
      col = dress ? hTopColor(vec3(r.x, r.y - 0.25, r.z), L2, L3, seed) : L4.rgb;
      hFabric(dress ? topFab : 4.0, col, rough);
      if (L2.w == 5.0) { col = L2.rgb; hFabric(2.0, col, rough); }
      hF90 = 0.45;
      // the hem: a turned edge, a little darker
      col *= 1.0 - 0.12 * smoothstep(0.03, 0.0, abs(vAux.x - L9.y));
    } else if (pr == 22.0) {
      // sunglasses: dark tinted lenses (smooth glass) in a thin dark frame
      bool lens = vAux.x > 0.5;
      col = lens ? vec3(0.008, 0.009, 0.011) : vec3(0.025, 0.022, 0.02);
      rough = lens ? 0.05 : 0.32;
      hSpec = lens ? 1.0 : 0.9;
      hSheenC = vec3(0.0);
    } else if (pr == 21.0) {
      // phone: dark aluminium back and edges, black glass face with the screen on
      bool face = vAux.x > 0.5;
      col = face ? vec3(0.012) : vec3(0.05, 0.05, 0.055);
      rough = face ? 0.06 : 0.35;
      hSpec = face ? 1.0 : 1.4;
      hSheenC = vec3(0.0);
      if (face) hEmit = vec3(0.55, 0.62, 0.75) * (0.04 + 0.6 * uNight) * smoothstep(1.0, 0.9, vAux.y);
    }
  }
  // wear and grime near the ground
  col *= 1.0 - 0.10 * smoothstep(0.25, 0.0, r.y) * (0.5 + 0.5 * L9.w) * (1.0 - skinAmt);
  hSkinM = skinAmt;
  if (skinAmt > 0.0) { rough = mix(rough, skinRough, skinAmt); hSpec = mix(hSpec, 0.7, skinAmt); hSheenC *= 1.0 - skinAmt; }
  diffuseColor.rgb = clamp(col, vec3(0.012), vec3(0.82));
  roughnessFactor = rough;
  metalnessFactor = 0.0;
  hAO = mix(1.0, aoV * aoV, 0.75);
#if HUMANS_DBG == 1
  hEmit = vec3(aoV); diffuseColor.rgb = vec3(0.0);       // debug view: baked occlusion
#elif HUMANS_DBG == 2 || HUMANS_DBG == 3
  hEmit = vec3(vAux, 0.0); diffuseColor.rgb = vec3(0.0); // debug view: aux attributes (3: garment ease, 1 = 2.5 cm)
#endif
}
`;

const FRAG_BUMP = /* glsl */`
{
  // silhouettes: interpolated normals can face away from the eye, where the specular
  // visibility term blows up (half-float fireflies); bend them back towards the viewer.
  // The grazing sheen lobe is faded there so dark cloth gets no glowing rim.
  vec3 vdir = normalize(vViewPosition);
  float nv = dot(normal, vdir);
  hSilh = smoothstep(0.05, 0.2, nv);
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

/**
 * Straight-hang envelope of the torso: four rings (chest, waist, hips, seat) with the running
 * maximum of the body's half width and front / back extent from the chest down, measured on
 * the detailed mesh. Tops hang from it instead of following the waist.
 */
export function hangProfile(geo, info) {
  const P = geo.attributes.position.array, body = geo.attributes.aBody.array;
  const sc = info.H / 1.76;
  const xMax = info.shoulder[0] * 0.92;
  const ys = [info.shoulder[1] - 0.125 * sc, info.waistY, info.hip[1], info.torsoY[0] + 0.03 * sc];
  const rings = ys.map((y) => [y, 0, 0, 0]);
  for (let v = 0; v < P.length / 3; v++) {
    const reg = body[v * 4], part = body[v * 4 + 1];
    if (part !== 0 || (reg !== 1 && reg !== 19 && reg !== 20)) continue;
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (Math.abs(x) > xMax) continue;
    for (const R of rings) {
      if (Math.abs(y - R[0]) > 0.012 * sc) continue;
      R[1] = Math.max(R[1], Math.abs(x));
      R[2] = Math.min(R[2], z);
      R[3] = Math.max(R[3], z);
    }
  }
  for (let i = 1; i < rings.length; i++) {
    rings[i][1] = Math.max(rings[i][1], rings[i - 1][1]);
    rings[i][2] = Math.min(rings[i][2], rings[i - 1][2]);
    rings[i][3] = Math.max(rings[i][3], rings[i - 1][3]);
  }
  return rings.map((R) => new THREE.Vector4(...R));
}

export function makeHumanMaterials(base, partIds, bones, look, morphScale, shapeScale, hang, debugView = 0) {
  const info = base.info;
  const sx = info.shoulder, H = info.H;
  const abd = (info.abd * Math.PI) / 180;
  const armLen = info.Lu + info.Lf;
  const ty = info.torsoY;
  const waistY = info.waistY;
  const kind = info.kind === 'male' ? 0 : info.kind === 'female' ? 1 : 2;
  const s = info.sx ?? 1;
  const headJ = base.rig.rest[5];
  const uniforms = {
    uBoneTex: { value: bones },
    uLookTex: { value: look },
    uMorphScale: { value: morphScale },
    uShapeScale: { value: new THREE.Vector4(...(shapeScale || [0, 0, 0, 0])) },
    uShoulder: { value: new THREE.Vector4(sx[0], sx[1], sx[2], armLen) },
    uArm: { value: new THREE.Vector4(Math.sin(abd), Math.cos(abd), partIds.skirt || -1, kind) },
    uLeg: { value: new THREE.Vector4(info.hip[0], info.hip[1], info.knee[1], info.ankle[1]) },
    uLeg2: { value: new THREE.Vector4(info.ankle[0], info.ankle[2], info.knee[0], info.knee[2]) },
    uTorso: { value: new THREE.Vector4(ty[0], waistY, info.neckY, H) },
    uSkirt0: { value: new THREE.Vector4(waistY + 0.03 * s, 0.150 * s * (kind === 1 ? 0.9 : 1), 0.104 * s, -0.004) },
    uSkirt1: { value: new THREE.Vector4(info.hip[1] - 0.03 * s, (kind === 1 ? 0.200 : 0.190) * s, 0.136 * s, 0.024 * s) },
    uHead: { value: new THREE.Vector4(...info.headC, info.headS) },
    uEye: { value: new THREE.Vector4(...info.eyeR, info.eyeRadius) },
    uHang0: { value: hang[0] }, uHang1: { value: hang[1] }, uHang2: { value: hang[2] }, uHang3: { value: hang[3] },
    uHeadJ: { value: new THREE.Vector4(headJ.x, headJ.y, headJ.z, partIds.phone || -1) },
    uNight: U.uNight,
  };
  const hatOff = info.hatOffsets || {};
  const hairline = info.hairline || {};
  const subst = (src) => src
    .replace(/__BACKPACK__/g, (partIds.backpack || -1).toFixed(1))
    .replace(/__SHOULDERBAG__/g, (partIds.shoulderbag || -1).toFixed(1))
    .replace(/__SCARF__/g, (partIds.scarf || -1).toFixed(1))
    .replace(/__BALDING__/g, (partIds.hair_balding || -1).toFixed(1))
    .replace(/__SUNHAT__/g, (partIds.sunhat || -1).toFixed(1))
    .replace(/__CAP__/g, (partIds.cap || -1).toFixed(1))
    .replace(/__CAP_OFF__/g, (hatOff.cap ?? 0.010).toFixed(4))
    .replace(/__SUNHAT_OFF__/g, (hatOff.sunhat ?? 0.016).toFixed(4))
    .replace(/__GLASSES__/g, (partIds.glasses || -1).toFixed(1))
    .replace(/__SHOPPING__/g, (partIds.shopping || -1).toFixed(1))
    .replace(/__HAIR_(LONG|PONY|BUN|BOB|PIXIE|RECEDING|SHORT|BUZZ)__/g, (m, k) => (partIds[HAIR_PART[k]] || -1).toFixed(1))
    .replace(/__MALE_FRONT__/g, (hairline.front ?? 0.058).toFixed(4))
    .replace(/__MALE_TEMPLE__/g, (hairline.temple ?? 0.036).toFixed(4));
  const fragSurface = subst(FRAG_SURFACE);
  const vertPars = subst(VERT_PARS);

  const patchV = (shader, depthOnly) => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + vertPars);
    if (depthOnly) {
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
        'vec3 hP, hN; hSkin(hP, hN);\nvec3 transformed = hP;');
    } else {
      shader.vertexShader = shader.vertexShader
        .replace('#include <beginnormal_vertex>', 'vec3 hP, hN; hSkin(hP, hN);\nvec3 objectNormal = hN;')
        .replace('#include <begin_vertex>', 'vec3 transformed = hP;');
    }
  };

  // double sided: the garment shells are the body surface pushed out, so the underside of a hem
  // is a real (back-facing) surface that must not show through to the background
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.6, metalness: 0, sheen: 1, sheenRoughness: 0.6, sheenColor: 0x000000,
    specularIntensity: 1, ior: 1.5, side: THREE.DoubleSide,
  });
  mat.name = 'humans.' + info.kind;
  mat.defines = { ...mat.defines, HUMANS_DBG: debugView | 0 };   // (keeps STANDARD / PHYSICAL)
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchV(shader, false);
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', '#include <common>\n' + subst(FRAG_PARS));
    fs = fs.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + fragSurface);
    fs = fs.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FRAG_BUMP);
    fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += hEmit;');
    fs = fs.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
      material.specularColor *= hSpec;
      material.specularColorBlended *= hSpec;
      material.specularF90 *= hF90;
      #ifdef USE_SHEEN
        material.sheenColor = hSheenC * hSilh;
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
        if ( hHairM > 0.0 && dot( vHairT, vHairT ) > 0.5 ) reflectedLight.directSpecular += hHairM * hHairSpec( directLight.direction, geometryViewDir, geometryNormal, normalize( vHairT ) ) * saturate( dotNLr * 2.0 ) * directLight.color;`));
    }
    fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      reflectedLight.indirectDiffuse *= hAO;
      reflectedLight.indirectSpecular *= hAO * mix( 1.0, 0.3, hHairM );
      reflectedLight.directDiffuse *= mix(1.0, hAO, 0.35);`);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'humans-v2-' + info.kind;

  const depth = new THREE.MeshDepthMaterial();
  depth.name = 'humans.depth.' + info.kind;
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchV(shader, true);
    // shadows do not need the garment ease (sub-centimetre at shadow-map resolution)
    shader.vertexShader = '#define HUMAN_DEPTH\n' + shader.vertexShader;
  };
  depth.customProgramCacheKey = () => 'humans-depth-v2-' + info.kind;
  return { mat, depth, uniforms };
}
