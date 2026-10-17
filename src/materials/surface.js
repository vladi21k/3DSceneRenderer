import * as THREE from 'three';
import { HASH_GLSL, LAYOUT_GLSL } from './glsl/common.js';

// Runtime shading for library materials (patched MeshStandard/MeshPhysical).
//
// Features (material.defines):
//   SURF            baked albedo(+roughness) and surface(normal, moment, ao) maps, UVs in metres
//   SURF_ROWS       analytic row/segment layout: random per-row u shift (no 2D repetition)
//                   and per-cell / per-row colour + roughness variation, faded with distance
//   SURF_DETAIL     high-frequency detail map (fades out naturally through its mips)
//   SURF_MACRO      large-scale multi-octave tone/roughness variation + irregular stains
//   SURF_SPOTS      small random spots per cell (chewing gum on pavers)
//   SURF_METALMASK  surface.b is a metal mask (no normal-variance term)
//   SURF_SWAP       swap u/v (grain along u)
//   SURF_TRANS      diffuse translucency (thin fabric, leaves)
//   SURF_NIGHT      emissive driven by U.uNight
//   SURF_GLASS      thin glass: reflections are not attenuated by opacity (premultiplied)
// All code is fixed; only defines vary, so programs are shared between materials.

const PARS = /* glsl */ `
${HASH_GLSL}
${LAYOUT_GLSL}
float sfMicroAO = 1.0;
#ifdef SURF
uniform vec4 sfTile;     // 1/W, 1/H, W, H (m)
uniform vec4 sfLay;      // rowH, rows, segMin, segMax
uniform vec4 sfLay2;     // jitter, seed, shiftRows, rowJoints
uniform vec4 sfCell;     // value amp, hue amp, roughness amp, per-row share
uniform vec3 sfCellA;    // hue multipliers mixed per cell
uniform vec3 sfCellB;
uniform vec4 sfCellOut;  // outlier cell multiplier rgb, probability
uniform vec4 sfMacro;    // freq1, freq2 (1/m), albedo amp, roughness amp
uniform vec4 sfMacroAn;  // anisotropy of the two macro lookups
uniform vec4 sfDetail;   // freq (1/m), normal amp, albedo amp, roughness amp
uniform vec4 sfMisc;     // normal strength, ao strength, variance→roughness k, micro-shadow
uniform vec4 sfSpots;    // probability per cell, radius (m), albedo mult, roughness
uniform vec4 sfStain;    // amount, freq (1/m), threshold, unused
uniform sampler2D sfDetailTex;
uniform sampler2D sfMacroTex;
vec3 sfTintOf(uint h, float amp, float outliers) {
  float h0 = sfHf(h), h1 = sfHf(sfH(h + 1u)), h2 = sfHf(sfH(h + 2u)), h3 = sfHf(sfH(h + 3u));
  float v = 1.0 + amp * sfCell.x * (h0 * 2.0 - 1.0);
  vec3 t = v * mix(vec3(1.0), mix(sfCellA, sfCellB, h1), amp * sfCell.y * h2);
  return mix(t, t * sfCellOut.rgb, outliers * step(1.0 - sfCellOut.a, h3));
}
#endif
#ifdef SURF_TRANS
uniform vec3 sfTrans;    // diffuse transmission colour (fraction of back-lit irradiance)
#endif
#ifdef SURF_NIGHT
uniform float sfNight;   // = U.uNight
uniform float sfEmGain;
#endif
`;

const MAP = /* glsl */ `
#ifdef SURF
  vec2 sfUv = vMapUv;
  #ifdef SURF_SWAP
    sfUv = sfUv.yx;
  #endif
  vec2 sfGx = dFdx(sfUv), sfGy = dFdy(sfUv);
  vec2 sfFoot = max(abs(sfGx), abs(sfGy));
  vec2 sfP = sfUv;
  vec3 sfTint = vec3(1.0);
  float sfRoughMul = 1.0;
  float sfSpot = 0.0;
  #ifdef SURF_ROWS
  {
    float rowH = sfLay.x;
    float rgF = floor(sfUv.y / rowH);
    int rg = int(rgF);
    if (sfLay2.z > 0.5) sfP.x += sfRowShift(rg, sfLay2) * sfTile.z;
    int r = sfMod(rg, int(sfLay.y));
    float tx = floor(sfP.x * sfTile.x);
    float lx = sfP.x - tx * sfTile.z;
    int k, n; float b0, b1;
    sfRowSeg(r, lx, sfTile.z, sfLay, sfLay2, k, b0, b1, n);
    uint ch = sfH2(rg, int(tx) * n + k, uint(sfLay2.y) + 501u);
    uint rh = sfH2(rg, 7777, uint(sfLay2.y) + 503u);
    // per-segment variation aliases first (along u), per-row variation later (along v)
    float fRow = 1.0 - smoothstep(0.25, 0.8, sfFoot.y / rowH);
    float fSeg = fRow * (1.0 - smoothstep(0.25, 0.8, sfFoot.x * float(n) * sfTile.x));
    sfTint = mix(vec3(1.0), sfTintOf(rh, sfCell.w, 0.0), fRow) * mix(vec3(1.0), sfTintOf(ch, 1.0, 1.0), fSeg);
    sfRoughMul = 1.0 + sfCell.z * (sfHf(sfH(ch + 5u)) * 2.0 - 1.0) * fSeg;
    #ifdef SURF_SPOTS
    if (sfHf(sfH(ch + 9u)) < sfSpots.x) {
      vec2 cs = vec2(b1 - b0, rowH);
      vec2 cl = vec2(lx - b0, sfUv.y - rgF * rowH);
      float rad = sfSpots.y * (0.6 + 0.8 * sfHf(sfH(ch + 12u)));
      vec2 sp = rad + vec2(sfHf(sfH(ch + 10u)), sfHf(sfH(ch + 11u))) * max(cs - 2.0 * rad, vec2(0.0));
      vec2 q = (cl - sp) / max(sfFoot, vec2(1e-5));
      float aa = max(sfFoot.x, sfFoot.y);
      float d = length(cl - sp);
      sfSpot = (1.0 - smoothstep(rad - aa, rad + aa, d)) * (1.0 - smoothstep(0.4, 1.2, aa / rad));
    }
    #endif
  }
  #endif
  vec2 sfT = sfP * sfTile.xy;
  vec4 sfA = textureGrad(map, sfT, sfGx * sfTile.xy, sfGy * sfTile.xy);
  vec4 sfS = textureGrad(normalMap, sfT, sfGx * sfTile.xy, sfGy * sfTile.xy);
  vec3 sfAlb = sfA.rgb * sfTint;
  float sfRough = sfA.a * sfRoughMul;
  float sfAO = sfS.a;
  #ifdef SURF_DETAIL
    vec4 sfD = textureGrad(sfDetailTex, sfP * sfDetail.x, sfGx * sfDetail.x, sfGy * sfDetail.x);
    float sfDa = sfD.a * 2.0 - 1.0;
    sfAlb *= 1.0 + sfDetail.z * sfDa;
    sfRough *= 1.0 - sfDetail.w * sfDa;
  #endif
  #ifdef SURF_MACRO
    vec4 sfM1 = texture(sfMacroTex, sfUv * sfMacroAn.xy * sfMacro.x);
    vec4 sfM2 = texture(sfMacroTex, sfUv * sfMacroAn.zw * sfMacro.y + vec2(0.31, 0.67));
    sfAlb *= 1.0 + sfMacro.z * ((sfM1.r - 0.5) * 1.3 + (sfM2.g - 0.5) * 0.9);
    sfRough *= 1.0 + sfMacro.w * ((sfM1.a - 0.5) * 2.0);
    if (sfStain.x > 0.0) {
      float sfSt = smoothstep(sfStain.z, sfStain.z + 0.08, texture(sfMacroTex, sfUv * sfStain.y + vec2(0.13, 0.57)).b);
      sfSt *= smoothstep(0.4, 0.62, sfM1.g);
      sfAlb *= 1.0 - sfStain.x * sfSt;
      sfRough = mix(sfRough, sfRough * 0.85, sfSt);
    }
  #endif
  sfAlb = mix(sfAlb, sfAlb * sfSpots.z, sfSpot);
  sfRough = mix(sfRough, sfSpots.w, sfSpot);
  sfMicroAO = mix(1.0, sfAO, sfMisc.w);
  diffuseColor.rgb *= sfAlb;
#else
  #include <map_fragment>
#endif
`;

const ROUGH = /* glsl */ `
#ifdef SURF
  float roughnessFactor = clamp(roughness * sfRough, 0.0, 1.0);
#else
  #include <roughnessmap_fragment>
#endif
`;

const METAL = /* glsl */ `
#if defined( SURF ) && defined( SURF_METALMASK )
  float metalnessFactor = metalness * sfS.b;
#else
  #include <metalnessmap_fragment>
#endif
`;

const NORMAL = /* glsl */ `
#ifdef SURF
  vec2 sfN = sfS.rg * 2.0 - 1.0;
  #ifdef SURF_METALMASK
    float sfVar = 0.0;
  #else
    float sfVar = max(sfS.b - dot(sfN, sfN) - 0.004, 0.0);
  #endif
  #ifdef SURF_DETAIL
    vec2 sfDn = sfD.rg * 2.0 - 1.0;
    sfVar += max(sfD.b - dot(sfDn, sfDn) - 0.004, 0.0) * sfDetail.y * sfDetail.y;
    sfN += sfDn * sfDetail.y;
  #endif
  #ifdef SURF_SWAP
    sfN = sfN.yx;
  #endif
  sfN *= normalScale * sfMisc.x;
  sfVar *= sfMisc.x * sfMisc.x * normalScale.x * normalScale.x;
  normal = normalize(tbn * vec3(sfN, sqrt(max(1.0 - dot(sfN, sfN), 0.0))));
  // normal variance hidden in the mips becomes roughness (specular anti-aliasing)
  float sfA2 = roughnessFactor * roughnessFactor;
  roughnessFactor = min(sqrt(sqrt(sfA2 * sfA2 + sfMisc.z * sfVar)), 1.0);
#else
  #include <normal_fragment_maps>
#endif
`;

const AO = /* glsl */ `
#ifdef SURF
  float ambientOcclusion = mix(1.0, sfAO, sfMisc.y);
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float sfDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( sfDotNV, ambientOcclusion, material.roughness );
  #endif
#else
  #include <aomap_fragment>
#endif
`;

// direct light: micro-shadowing from the baked cavity AO, plus thin-surface translucency
const LIGHT_PARS = /* glsl */ `
#if defined( SURF ) || defined( SURF_TRANS )
void RE_Direct_Surf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  IncidentLight sfL = directLight;
  float sfNL = dot( geometryNormal, directLight.direction );
  sfL.color *= saturate( abs( sfNL ) + 2.0 * sfMicroAO * sfMicroAO - 1.0 );
  RE_Direct_Physical( sfL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  #ifdef SURF_TRANS
    reflectedLight.directDiffuse += saturate( - sfNL ) * directLight.color * BRDF_Lambert( material.diffuseContribution ) * sfTrans;
  #endif
}
#undef RE_Direct
#define RE_Direct RE_Direct_Surf
#endif
`;

const EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
#ifdef SURF_NIGHT
  totalEmissiveRadiance *= sfEmGain * smoothstep( 0.02, 0.85, sfNight );
#endif
`;

const OPAQUE = /* glsl */ `
#ifdef SURF_GLASS
  float sfNV = saturate( dot( normal, normalize( vViewPosition ) ) );
  float sfFr = 0.04 + 0.96 * pow( 1.0 - sfNV, 5.0 );
  gl_FragColor = vec4( totalSpecular + totalDiffuse * diffuseColor.a + totalEmissiveRadiance, clamp( diffuseColor.a + ( 1.0 - diffuseColor.a ) * sfFr, 0.0, 1.0 ) );
#else
  #include <opaque_fragment>
#endif
`;

const PREMUL = /* glsl */ `
#ifndef SURF_GLASS
  #include <premultiplied_alpha_fragment>
#endif
`;

function patchFragment(src) {
  return src
    .replace('#include <common>', '#include <common>\n' + PARS)
    .replace('#include <map_fragment>', MAP)
    .replace('#include <roughnessmap_fragment>', ROUGH)
    .replace('#include <metalnessmap_fragment>', METAL)
    .replace('#include <normal_fragment_maps>', NORMAL)
    .replace('#include <aomap_fragment>', AO)
    .replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + LIGHT_PARS)
    .replace('#include <emissivemap_fragment>', EMISSIVE)
    .replace('#include <opaque_fragment>', OPAQUE)
    .replace('#include <premultiplied_alpha_fragment>', PREMUL);
}

const v4 = (a = [0, 0, 0, 0]) => new THREE.Vector4(...a);

/** Uniform set for one material. `t` = baked textures {albedo, surface, recipe}, shared = {detail, macro, night, gain}. */
export function surfaceUniforms(cfg, t, shared) {
  const r = t?.recipe;
  const sc = cfg.scale ?? 1;
  const W = (r?.tile[0] ?? 1) * sc, H = (r?.tile[1] ?? 1) * sc;
  const L = r?.layout || {};
  const c = cfg.cell || {};
  const m = cfg.macro || {};
  const d = cfg.detail || {};
  const sp = cfg.spots || {};
  const st = cfg.stain || {};
  const u = {
    sfTile: { value: v4([1 / W, 1 / H, W, H]) },
    sfLay: { value: v4([(L.rowH ?? 1) * sc, L.rows ?? 1, L.seg?.[0] ?? 1, L.seg?.[1] ?? 1]) },
    sfLay2: { value: v4([L.jitter ?? 0, L.seed ?? 1, L.shift ? 1 : 0, L.rowJoints === false ? 0 : 1]) },
    sfCell: { value: v4([c.value ?? 0, c.hue ?? 0, c.rough ?? 0, c.row ?? 0.35]) },
    sfCellA: { value: new THREE.Vector3(...(c.a || [1, 1, 1])) },
    sfCellB: { value: new THREE.Vector3(...(c.b || [1, 1, 1])) },
    sfCellOut: { value: v4([...(c.out || [1, 1, 1, 0])]) },
    sfMacro: { value: v4([m.f1 ?? 1 / 7, m.f2 ?? 1 / 23, m.albedo ?? 0, m.rough ?? 0]) },
    sfMacroAn: { value: v4([...(m.an1 || [1, 1]), ...(m.an2 || [1, 1])]) },
    sfDetail: { value: v4([d.freq ?? 2, d.normal ?? 0, d.albedo ?? 0, d.rough ?? 0]) },
    sfMisc: { value: v4([cfg.normal ?? 1, cfg.ao ?? 1, cfg.variance ?? 2, cfg.microShadow ?? 1]) },
    sfSpots: { value: v4([sp.prob ?? 0, sp.radius ?? 0.01, sp.albedo ?? 1, sp.rough ?? 0.5]) },
    sfStain: { value: v4([st.amount ?? 0, st.freq ?? 0.3, st.threshold ?? 0.7, 0]) },
    sfDetailTex: { value: (d.tex && shared.textures.get(d.tex)?.surface) || shared.detail },
    sfMacroTex: { value: shared.macro },
    sfTrans: { value: new THREE.Vector3(...(cfg.trans || [0, 0, 0])) },
    sfNight: shared.night,
    sfEmGain: shared.gain,
  };
  return u;
}

/** Install (or re-install after clone) the surface patch on a material. */
export function applySurface(mat, sf) {
  mat.userData.sf = sf;
  mat.defines = Object.assign(mat.defines || {}, sf.defines);
  if (sf.textures) {
    mat.map = sf.textures.albedo;
    mat.normalMap = sf.textures.surface;
  }
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sf.uniforms);
    shader.fragmentShader = patchFragment(shader.fragmentShader);
  };
  mat.customProgramCacheKey = () => 'sf3';
  mat.needsUpdate = true;
  return mat;
}
