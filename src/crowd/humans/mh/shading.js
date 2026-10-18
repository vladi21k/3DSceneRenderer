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
export const BONE_W = BONE_DYN + 2;      // texels per bone row
export const LOOK_W = 24;                // texels per look row (see writeLook)
const REGION_ROUGH = [-1, 0.5, 0.8, 0.8, 0.06, -1, -1, -1, -1, 0.95, -1, 0.85, 0.32, 0.08, 0.55, 0.7];
// specular strength per region (x the dielectric F0 0.04)
const REGION_SPEC = [0.72, 0.35, 0.3, 0.3, 1.1, 0.55, 0.55, 0.55, 0.9, 0.5, 0.5, 0.3, 1.0, 1.2, 0.75, 0.6];

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
void hSkin(out vec3 P, out vec3 N) {
  int brow = int(getIndirectIndex(gl_DrawID) + 0.5);
  vec4 D0 = texelFetch(uBoneTex, ivec2(${BONE_DYN}, brow), 0);   // gait phase, speed, seated blend, ground y
  vec4 D1 = texelFetch(uBoneTex, ivec2(${BONE_DYN + 1}, brow), 0); // look row, phone shown, hands in pockets, scale
  int row = int(D1.x + 0.5);
  vec4 W = aBoneW / max(aBoneW.x + aBoneW.y + aBoneW.z + aBoneW.w, 1e-4);
  mat4 m = hBone(brow, aBoneI.x) * W.x + hBone(brow, aBoneI.y) * W.y + hBone(brow, aBoneI.z) * W.z + hBone(brow, aBoneI.w) * W.w;
  vec3 pos = position;
  int flags = int(aTex.w + 0.5);
  // hands in the pockets: the hands fold into the trousers about the wrist
  if (D1.z > 0.01 && W.x > 0.5 && (aBoneI.x == 9.0 || aBoneI.x == 13.0) && aTex.z < 0.5) {
    vec3 wr = hLook(row, aBoneI.x == 9.0 ? 22 : 23).xyz;
    pos = mix(pos, wr + (pos - wr) * vec3(0.55, 0.35, 0.55), D1.z);
  }
  P = (m * vec4(pos, 1.0)).xyz;
  N = normalize(mat3(m) * aNrm.xyz);
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
varying vec2 vCastUv;
flat varying vec4 vCastTex;
flat varying float vRow;
varying float vCastAO;
varying vec3 vRest;
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
// secondary lobe towards the tip, both broken up per strand clump; wider and dimmer far away
vec3 hHairSpec(vec3 L, vec3 V, vec3 N, vec3 T) {
  vec3 H = normalize(L + V);
  float j = hH3(floor(vec3(vCastUv * 180.0, vCastTex.x)));
  float sh = (j - 0.5) * 0.2;
  vec3 t1 = normalize(T + N * (0.10 + sh)), t2 = normalize(T - N * (0.16 - sh));
  float th1 = dot(t1, H), th2 = dot(t2, H);
  float e1 = mix(120.0, 30.0, hFar), e2 = mix(26.0, 10.0, hFar);
  float s1 = pow(sqrt(max(0.0, 1.0 - th1 * th1)), e1);
  float s2 = pow(sqrt(max(0.0, 1.0 - th2 * th2)), e2);
  vec3 tint = mix(vec3(1.0), hHairC / max(hLum(hHairC), 1e-3), 0.45);
  float br = mix(0.35 + 0.9 * j, 0.8, hFar);
  return (0.06 * tint * s1 * br + hHairC * 0.5 * s2 * (0.5 + 0.6 * j)) * hAO;
}
`;

const FRAG_SURFACE = /* glsl */`
{
  int row = int(vRow + 0.5);
  hRegion = int(vCastTex.z + 0.5);
  hFlags = int(vCastTex.w + 0.5);
  vec3 tint = hLook(row, hRegion).rgb;
  vec4 tx = (hFlags & 16) != 0 ? vec4(1.0) : texture(uAlbedo, vec3(vCastUv, vCastTex.x));
  vec3 col = (hFlags & 4) != 0 ? 2.0 * tx.rgb * tint : tx.rgb * tint;
  if ((hFlags & 32) != 0) col = vec3(0.82, 0.81, 0.78);
  float rr = uRegionRough[hRegion];
  hRough = rr >= 0.0 ? rr : uLayerRough[int(vCastTex.x + 0.5)];
  hSpec = uRegionSpec[hRegion];
  hAO = vCastAO;
  // texel footprint (mip level) of the layer: strands and fine detail below a pixel
  vec2 tsz = vec2(textureSize(uAlbedo, 0).xy);
  vec2 dx = dFdx(vCastUv * tsz), dy = dFdy(vCastUv * tsz);
  float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
  if (hRegion == 5 || hRegion == 7) {
    vec4 pa = hLook(row, 16), pb = hLook(row, 17);
    if (pa.w > 0.5 && (hRegion == 5 || pb.z > 0.5)) col = mix(col, pa.rgb * (0.6 + 0.4 * tx.g / max(1e-3, hLum(tx.rgb))), hPattern(pa.w, vRest, pb.x * pb.y / 1.76, pb.w));
  }
  float a = 1.0;
  if ((hFlags & 1) != 0) {
    // coverage of hair cards, brows, lashes, beards: kept from thinning out in the mips, sharpened
    // to about a pixel, then rounded to the target's sample count (alpha to coverage) or tested
    a = tx.a * (1.0 + max(lod, 0.0) * 0.22);
    a = clamp((a - 0.5) / max(fwidth(a), 1e-4) + 0.5, 0.0, 1.0);
    if (uA2C > 0.5) {
      a = floor(a * uA2C + 0.5) / uA2C;
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
  if (hRegion == 0) hSkinM = 1.0;
  if (hRegion == 1 || hRegion == 11 || hRegion == 2) {
    hHairM = hRegion == 1 ? 1.0 : 0.6;
    hHairC = col;
    hFar = smoothstep(0.5, 3.5, lod);
  }
  // cloth sheen: fibres catch light at grazing angles (dark cloth reads as cloth, not plastic)
  if (hRegion >= 5 && hRegion <= 10 && hRegion != 8 || hRegion == 14 || hRegion == 15) hSheen = 1.0;
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
  if (uHasNormal > 0.5 && vCastTex.y < 254.5 && (hFlags & 16) == 0) {
    vec3 nm = texture(uNormalArr, vec3(vCastUv, vCastTex.y)).xyz * 2.0 - 1.0;
    normal = normalize(T * (nm.x * scl) + Bt * (nm.y * scl) + normal * nm.z);
  }
  // strand direction of hair cards: along the texture's v axis
  if (hHairM > 0.0) hHairT = normalize(Bt - normal * dot(Bt, normal) + 1e-6);
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
export function makeFigureMaterials(textures, layerRough, materials) {
  const rough = new Array(64).fill(0.7);
  for (let i = 0; i < Math.min(64, layerRough.length); i++) rough[i] = layerRough[i];
  const uniforms = {
    uBoneTex: { value: textures.bones },
    uLookTex: { value: textures.look },
    uAlbedo: { value: textures.albedo },
    uNormalArr: { value: textures.normal || textures.albedo },
    uHasNormal: { value: textures.normal ? 1 : 0 },
    uLayerRough: { value: rough },
    uRegionRough: { value: REGION_ROUGH.slice() },
    uRegionSpec: { value: REGION_SPEC.slice() },
    uA2C: { value: 4 },
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
      material.specularF90 = mix(1.0, 0.6, hHairM);
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
        vec3 irradiance = mix( vec3( dotNL ), vec3( dotNL ) * 0.72 + wrapNL * vec3( 0.36, 0.15, 0.10 ), hSkinM ) * directLight.color;
        if ( hHairM > 0.0 ) reflectedLight.directSpecular += hHairM * hHairSpec( directLight.direction, geometryViewDir, geometryNormal, hHairT ) * saturate( dotNLr * 2.0 + 0.3 ) * directLight.color;`));
    }
    fs = fs.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      reflectedLight.indirectDiffuse *= hAO;
      reflectedLight.indirectSpecular *= hAO * mix( 1.0, 0.35, hHairM );
      reflectedLight.directDiffuse *= mix( 1.0, hAO, 0.3 );`);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'humans-mh-v1';

  const depth = new THREE.MeshDepthMaterial();
  depth.name = 'humans.figures.depth';
  depth.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    patchVertex(shader, true);
    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', `#include <common>
      uniform highp sampler2DArray uAlbedo;
      varying vec2 vCastUv;
      flat varying vec4 vCastTex;`);
    fs = fs.replace('#include <alphatest_fragment>', `
      if ((int(vCastTex.w + 0.5) & 1) != 0) {
        vec2 tsz = vec2(textureSize(uAlbedo, 0).xy);
        vec2 dx = dFdx(vCastUv * tsz), dy = dFdy(vCastUv * tsz);
        float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
        if (texture(uAlbedo, vec3(vCastUv, vCastTex.x)).a * (1.0 + max(lod, 0.0) * 0.22) < 0.5) discard;
      }`);
    shader.fragmentShader = fs;
  };
  depth.customProgramCacheKey = () => 'humans-mh-depth-v1';
  return { mat, depth, uniforms };
}

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
 * landmarks for the vertex shader (18-23: thigh capsules L / R, wrists L / R).
 */
export function writeLook(data, row, a) {
  const o = row * LOOK_W * 4;
  const T = a.tints;
  for (let i = 0; i < 16; i++) {
    data[o + i * 4] = T[i * 3]; data[o + i * 4 + 1] = T[i * 3 + 1]; data[o + i * 4 + 2] = T[i * 3 + 2]; data[o + i * 4 + 3] = 0;
  }
  const pat = a.patColor || [T[12 * 3], T[12 * 3 + 1], T[12 * 3 + 2]];
  data[o + 64] = pat[0]; data[o + 65] = pat[1]; data[o + 66] = pat[2]; data[o + 67] = a.pattern || 0;
  data[o + 68] = a.patScale || 1; data[o + 69] = a.char.info.H; data[o + 70] = a.topKind === 'dress' ? 1 : 0; data[o + 71] = a.seedT || 0;
  const J = a.char.skeleton.joints, th = a.char.info.thigh || { L: [0.08, 0.05], R: [0.08, 0.05] };
  const put = (i, j, r) => { data[o + i * 4] = J[j][0]; data[o + i * 4 + 1] = J[j][1]; data[o + i * 4 + 2] = J[j][2]; data[o + i * 4 + 3] = r; };
  put(18, 14, th.L[0]); put(19, 15, th.L[1]); put(20, 18, th.R[0]); put(21, 19, th.R[1]);
  put(22, 9, 0); put(23, 13, 0);
}
