import * as THREE from 'three';
import { HASH_GLSL, LAYOUT_GLSL } from './glsl/common.js';

// Runtime shading for library materials (patched MeshStandard / MeshPhysical).
//
// Only two defines change the code, so every textured library material shares one
// program per three.js variant (vertex colours, side, physical…):
//   SURF        baked albedo(+roughness) and surface(normal.xy, moment, ao) maps, UVs in metres
//   SURF_GLASS  thin glass: reflections are not attenuated by opacity (premultiplied blend)
// Everything else is switched by uniforms (coherent per draw, so the branches are free):
//   row layout     analytic rows/segments: random per-row u shift (no 2D repetition),
//                  per-cell / per-row colour + roughness variation (the cell tint is
//                  box-filtered over the pixel footprint, so it survives at distance),
//                  grazing-angle joint masking, random irregular spots (chewing gum)
//   detail map     high-frequency grain (fades out through its own mips); in dressing
//                  mode the detail is chosen and rotated per block (chisel dressing)
//   macro          large-scale tone / roughness variation and irregular stains
//   weathering     soiled ledges and soffits, vertical drip streaks (world orientation)
//   lanes          grime along the rails / worn track lanes (street ribbons, v = d)
//   metal mask     surface.b is a metal mask instead of the normal moment
//   swap           u/v swapped
//   translucency   diffuse transmission for thin fabric and leaves (all light types)
//   night          emissive scaled by U.uNight × emissive gain, optional rim falloff
// Normal variance stored in the mips becomes roughness (specular anti-aliasing), and the
// baked cavity AO also gives direct-light micro-shadowing.

const PARS = /* glsl */ `
${HASH_GLSL}
${LAYOUT_GLSL}
float sfMicroAO = 1.0;
uniform vec4 sfFlags;    // metal mask, swap uv, night emissive, translucency
uniform vec3 sfTrans;    // diffuse transmission colour (fraction of back-lit irradiance)
uniform float sfNight;   // = U.uNight
uniform float sfEmGain;  // global emissive gain
uniform vec4 sfEmis;     // rim falloff (0 = flat), rim exponent
uniform float sfAOScale; // global scale of the baked AO (lowered when screen-space AO runs)
#ifdef SURF
varying vec3 vSfWorld;
uniform vec4 sfTile;     // 1/W, 1/H, W, H (m)
uniform vec4 sfLay;      // rowH, rows (0 = no layout), segMin, segMax
uniform vec4 sfLay2;     // jitter, seed, shiftRows, rowJoints
uniform vec4 sfCell;     // value amp, hue amp, roughness amp, per-row share
uniform vec3 sfCellA;    // hue multipliers mixed per cell
uniform vec3 sfCellB;
uniform vec4 sfCellOut;  // outlier family 1 multiplier rgb, total probability
uniform vec3 sfCellOut2; // outlier families 2 and 3
uniform vec3 sfCellOut3;
uniform vec4 sfMacro;    // freq1, freq2 (1/m), albedo amp, roughness amp
uniform vec4 sfMacroAn;  // anisotropy of the two macro lookups
uniform vec4 sfDetail;   // freq (1/m, 0 = off), normal amp, albedo amp, roughness amp
uniform vec4 sfDetail2;  // texels per detail tile, dressing share (0 = off), margin (m), faded variance
uniform vec4 sfMisc;     // normal strength, ao strength, variance→roughness k, micro-shadow
uniform vec4 sfSpots;    // probability per cell, radius (m), albedo mult, roughness
uniform vec4 sfStain;    // amount, freq (1/m), threshold, unused
uniform vec4 sfJoint;    // grazing joint masking amount, joint half width (m)
uniform vec4 sfWeather;  // ledge soiling, streak amount, streak threshold, soffit soot
uniform vec4 sfLanes;    // track offset, rail offset (m), rail grime, worn lane
uniform sampler2D sfDetailTex;
uniform sampler2D sfToolTex;
uniform sampler2D sfMacroTex;
mat2 sfDR = mat2(1.0);   // detail map rotation (dressing mode)
vec3 sfTintOf(uint h, float amp, float outliers) {
  float h0 = sfHf(h), h1 = sfHf(sfH(h + 1u)), h2 = sfHf(sfH(h + 2u)), h3 = sfHf(sfH(h + 3u)), h4 = sfHf(sfH(h + 4u));
  float v = 1.0 + amp * sfCell.x * (h0 * 2.0 - 1.0);
  vec3 t = v * mix(vec3(1.0), mix(sfCellA, sfCellB, h1), amp * sfCell.y * h2);
  vec3 o = h4 < 0.3334 ? sfCellOut.rgb : (h4 < 0.6667 ? sfCellOut2 : sfCellOut3);
  return mix(t, t * o, outliers * step(1.0 - sfCellOut.a, h3));
}
#endif
`;

const VERT_PARS = /* glsl */ `
#ifdef SURF
varying vec3 vSfWorld;
#endif
`;

const VERT_WORLD = /* glsl */ `
#ifdef SURF
  {
    vec4 sfWp = vec4( transformed, 1.0 );
    #ifdef USE_BATCHING
      sfWp = batchingMatrix * sfWp;
    #endif
    #ifdef USE_INSTANCING
      sfWp = instanceMatrix * sfWp;
    #endif
    vSfWorld = ( modelMatrix * sfWp ).xyz;
  }
#endif
`;

const MAP = /* glsl */ `
#ifdef SURF
  vec2 sfUv = sfFlags.y > 0.5 ? vMapUv.yx : vMapUv;
  vec2 sfGx = dFdx(sfUv), sfGy = dFdy(sfUv);
  vec2 sfFoot = max(abs(sfGx), abs(sfGy));
  vec2 sfP = sfUv;
  vec3 sfTint = vec3(1.0);
  float sfRoughMul = 1.0;
  float sfSpot = 0.0;
  float sfHide = 0.0;
  vec2 sfOff = vec2(0.0);
  uint sfCh = 0u;            // block hash
  vec2 sfCl = vec2(0.0);     // position inside the block (m)
  vec2 sfCs = vec2(1.0);     // block size (m)
  if (sfLay.y > 0.5) {
    float rowH = sfLay.x;
    float rgF = floor(sfUv.y / rowH);
    int rg = int(rgF);
    if (sfLay2.z > 0.5) sfP.x += sfRowShift(rg, sfLay2) * sfTile.z;
    int r = sfMod(rg, int(sfLay.y));
    float tx = floor(sfP.x * sfTile.x);
    float lx = sfP.x - tx * sfTile.z;
    int k, n; float b0, b1;
    sfRowSeg(r, lx, sfTile.z, sfLay, sfLay2, k, b0, b1, n);
    int gi = int(tx) * n + k;
    uint cs = uint(sfLay2.y) + 501u;
    sfCh = sfH2(rg, gi, cs);
    uint rh = sfH2(rg, 7777, uint(sfLay2.y) + 503u);
    float fRow = 1.0 - smoothstep(0.25, 0.8, sfFoot.y / rowH);
    float fSeg = fRow * (1.0 - smoothstep(0.25, 0.8, sfFoot.x * float(n) * sfTile.x));
    // block tint, box-filtered along u over the pixel footprint: at distance blocks
    // blend into their neighbours instead of fading to the mean, so the patchwork of
    // block tones survives on oblique facades
    vec3 cellT = sfTintOf(sfCh, 1.0, 1.0);
    float hw = 0.75 * sfFoot.x;
    if (hw > 0.02 * (b1 - b0)) {
      float L = sfTile.z / float(n);
      float bl = sfSegB(r, k - 1, n, L, sfLay2), br = sfSegB(r, k + 2, n, L, sfLay2);
      float x0 = lx - hw, x1 = lx + hw;
      float wl = max(0.0, min(x1, b0) - max(x0, bl));
      float wc = max(0.0, min(x1, b1) - max(x0, b0));
      float wr = max(0.0, min(x1, br) - max(x0, b1));
      float wo = max(0.0, 2.0 * hw - wl - wc - wr);
      cellT = (cellT * wc + sfTintOf(sfH2(rg, gi - 1, cs), 1.0, 1.0) * wl
             + sfTintOf(sfH2(rg, gi + 1, cs), 1.0, 1.0) * wr + vec3(wo)) / (2.0 * hw);
    }
    sfTint = mix(vec3(1.0), sfTintOf(rh, sfCell.w, 0.0) * cellT, fRow);
    sfRoughMul = 1.0 + sfCell.z * (sfHf(sfH(sfCh + 5u)) * 2.0 - 1.0) * fSeg;
    vec2 cl = vec2(lx - b0, sfUv.y - rgF * rowH);
    sfCl = cl;
    sfCs = vec2(b1 - b0, rowH);
    // Grazing-angle joint masking: seen at a low angle across a recessed joint, the near
    // arris hides it and the eye lands on the far stone. The footprint anisotropy tells
    // which way we look (along u hides head joints, along v hides bed joints).
    if (sfJoint.x > 0.0) {
      float ax = sfFoot.x / max(sfFoot.y, 1e-7);
      float hU = smoothstep(1.6, 4.0, ax), hV = smoothstep(1.6, 4.0, 1.0 / ax);
      float dU = min(cl.x, b1 - b0 - cl.x), dV = min(cl.y, rowH - cl.y);
      float inU = (1.0 - smoothstep(sfJoint.y, sfJoint.y + sfFoot.x, dU)) * hU;
      float inV = (1.0 - smoothstep(sfJoint.y, sfJoint.y + sfFoot.y, dV)) * hV * sfLay2.w;
      if (inU >= inV) sfOff = vec2((cl.x < 0.5 * (b1 - b0) ? 1.0 : -1.0) * (sfJoint.y + sfFoot.x), 0.0);
      else sfOff = vec2(0.0, (cl.y < 0.5 * rowH ? 1.0 : -1.0) * (sfJoint.y + sfFoot.y));
      sfHide = sfJoint.x * max(inU, inV);
    }
    // small random spots (chewing gum, drips) inside some cells: flattened, ragged blobs
    if (sfSpots.x > 0.0 && sfHf(sfH(sfCh + 9u)) < sfSpots.x) {
      float rad = sfSpots.y * (0.6 + 0.8 * sfHf(sfH(sfCh + 12u)));
      vec2 sp = rad * 1.4 + vec2(sfHf(sfH(sfCh + 10u)), sfHf(sfH(sfCh + 11u))) * max(sfCs - 2.8 * rad, vec2(0.0));
      vec2 dv = cl - sp;
      float ang = sfHf(sfH(sfCh + 13u)) * 6.2832;
      dv = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * dv * vec2(1.0, 1.3 + 0.6 * sfHf(sfH(sfCh + 14u)));
      float th = atan(dv.y, dv.x);
      float ph = sfHf(sfH(sfCh + 15u)) * 6.2832;
      float rr = rad * (1.0 + 0.22 * sin(3.0 * th + ph) + 0.12 * sin(5.0 * th + 2.0 * ph) + 0.06 * sin(9.0 * th - ph));
      float aa = max(sfFoot.x, sfFoot.y);
      sfSpot = (1.0 - smoothstep(rr - aa, rr + aa, length(dv))) * (1.0 - smoothstep(0.4, 1.2, aa / rad));
    }
  }
  vec2 sfT = sfP * sfTile.xy;
  vec2 sfTx = sfGx * sfTile.xy, sfTy = sfGy * sfTile.xy;
  vec4 sfA = textureGrad(map, sfT, sfTx, sfTy);
  vec4 sfS = textureGrad(normalMap, sfT, sfTx, sfTy);
  if (sfHide > 0.002) {
    vec2 sfT2 = (sfP + sfOff) * sfTile.xy;
    sfA = mix(sfA, textureGrad(map, sfT2, sfTx, sfTy), sfHide);
    sfS = mix(sfS, textureGrad(normalMap, sfT2, sfTx, sfTy), sfHide);
  }
  vec3 sfAlb = sfA.rgb * sfTint;
  float sfRough = sfA.a * sfRoughMul;
  float sfAO = sfS.a;
  // detail grain: faded out (and not fetched) once a pixel covers many detail texels;
  // its average normal variance is then kept as roughness. Dressing mode (stone): each
  // block gets its own dressing (taltish comb strokes from the tool map, pecked or
  // rubbed from the detail map), rotated per block, finer on the drafted margin.
  vec4 sfD = vec4(0.5, 0.5, 0.0, 0.5);
  float sfDw = 0.0;
  if (sfDetail.x > 0.0) {
    vec2 dq = sfP * sfDetail.x, dgx = sfGx * sfDetail.x, dgy = sfGy * sfDetail.x;
    float dAmp = 1.0, dFar = 1.0;
    bool dTool = false;
    if (sfDetail2.y > 0.0 && sfLay.y > 0.5) {
      float hd = sfHf(sfH(sfCh + 21u)), ha = sfHf(sfH(sfCh + 22u));
      dTool = hd < sfDetail2.y;
      float ang = dTool ? (ha < 0.4 ? 1.5708 : (ha < 0.7 ? 0.85 : 2.29)) + (sfHf(sfH(sfCh + 23u)) - 0.5) * 0.35 : ha * 6.2832;
      float ca = cos(ang), sa = sin(ang);
      sfDR = mat2(ca, sa, -sa, ca);
      dq = sfDR * sfCl * sfDetail.x + vec2(sfHf(sfH(sfCh + 24u)), sfHf(sfH(sfCh + 25u)));
      dgx = sfDR * dgx; dgy = sfDR * dgy;
      bool rubbed = !dTool && hd > sfDetail2.y + (1.0 - sfDetail2.y) * 0.6;
      dAmp = rubbed ? 0.3 : 1.0;
      dFar = dTool ? 0.955 : (rubbed ? 1.0 : 0.97);   // mean self-shadowing of the tooling
      float e = min(min(sfCl.x, sfCs.x - sfCl.x), min(sfCl.y, sfCs.y - sfCl.y));
      float mg = sfDetail2.z * (0.7 + 0.6 * sfHf(sfH(sfCh + 26u)));
      float inner = smoothstep(mg, mg + 0.005, e);
      dAmp *= mix(0.3, 1.0, inner);
      dFar = mix(1.0, dFar, inner);
    }
    sfDw = 1.0 - smoothstep(3.0, 12.0, min(sfFoot.x, sfFoot.y) * sfDetail.x * sfDetail2.x);
    sfAlb *= mix(1.0, dFar, 1.0 - sfDw);
    if (sfDw > 0.0) {
      vec4 dt = dTool ? textureGrad(sfToolTex, dq, dgx, dgy) : textureGrad(sfDetailTex, dq, dgx, dgy);
      sfD = mix(sfD, dt, sfDw * dAmp);
      float sfDa = sfD.a * 2.0 - 1.0;
      sfAlb *= 1.0 + sfDetail.z * sfDa;
      sfRough *= 1.0 - sfDetail.w * sfDa;
    }
  }
  if (sfMacro.z + sfMacro.w + sfStain.x > 0.0) {
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
  }
  // street ribbons (v = lateral offset d): grime along the rails, lighter worn lanes
  if (sfLanes.z + sfLanes.w > 0.0) {
    float sfLn = texture(sfMacroTex, vMapUv * vec2(0.11, 0.9)).g - 0.5;
    float dT = abs(abs(vMapUv.y) - sfLanes.x);
    float dR = abs(dT - sfLanes.y) + 0.05 * sfLn;
    float grime = 1.0 - smoothstep(0.05, 0.24, dR);
    float lane = 1.0 - smoothstep(0.18, 0.42, dT + 0.08 * sfLn);
    sfAlb *= (1.0 - sfLanes.z * grime) * (1.0 + sfLanes.w * lane);
    sfRough = max(sfRough - 0.08 * lane * step(0.001, sfLanes.w), 0.05);
  }
  // weathering by world orientation: dust and soot on ledges, sheltered soffits dark,
  // rain-washed vertical drip streaks on the walls
  if (sfWeather.x + sfWeather.y + sfWeather.w > 0.0) {
    #ifdef FLAT_SHADED
      vec3 sfVN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    #else
      vec3 sfVN = normalize(vNormal);
      #ifdef DOUBLE_SIDED
        sfVN *= gl_FrontFacing ? 1.0 : -1.0;
      #endif
    #endif
    vec3 sfNW = inverseTransformDirection(sfVN, viewMatrix);
    float sfMb = texture(sfMacroTex, vSfWorld.xz * 0.23 + vSfWorld.y * 0.05).b;
    float sfMf = texture(sfMacroTex, vSfWorld.xz * 1.7 + vec2(0.41, 0.13)).g;
    float sfLedge = smoothstep(0.55, 0.9, sfNW.y);
    float sfSoffit = smoothstep(-0.55, -0.9, sfNW.y);
    // ledge tops collect grey dust and soot (darker and desaturated, patchy)
    float sfLd = sfWeather.x * sfLedge * (0.35 + sfMb) * (0.6 + 0.8 * sfMf);
    vec3 sfDust = vec3(dot(sfAlb, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.6, 0.6, 0.62);
    sfAlb = mix(sfAlb, sfDust, min(2.2 * sfLd, 0.85));
    sfAlb *= 1.0 - sfWeather.w * sfSoffit * (0.6 + 0.8 * sfMb);
    sfRough = min(sfRough * (1.0 + 0.08 * sfLedge), 1.0);
    vec3 sfTW = normalize(vec3(-sfNW.z, 0.0, sfNW.x) + 1e-5);
    float sfAl = dot(vSfWorld, sfTW);
    float sfS1 = texture(sfMacroTex, vec2(sfAl * 2.4, vSfWorld.y * 0.1) + vec2(0.71, 0.29)).g;
    float sfS2 = texture(sfMacroTex, vec2(sfAl * 7.0, vSfWorld.y * 0.27) + vec2(0.17, 0.83)).r;
    float sfStreak = smoothstep(sfWeather.z, sfWeather.z + 0.14, 0.65 * sfS1 + 0.35 * sfS2);
    float sfVert = 1.0 - smoothstep(0.2, 0.4, abs(sfNW.y));
    sfAlb *= 1.0 - sfWeather.y * sfStreak * sfVert * (0.6 + 0.8 * sfMb);
  }
  sfAlb = mix(sfAlb, sfAlb * sfSpots.z, sfSpot);
  sfRough = mix(sfRough, sfSpots.w, sfSpot);
  sfMicroAO = mix(1.0, sfAO, sfMisc.w * sfAOScale);
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
#ifdef SURF
  float metalnessFactor = metalness * mix(1.0, sfS.b, sfFlags.x);
#else
  #include <metalnessmap_fragment>
#endif
`;

const NORMAL = /* glsl */ `
#ifdef SURF
  vec2 sfN = sfS.rg * 2.0 - 1.0;
  float sfVar = max(sfS.b - dot(sfN, sfN) - 0.004, 0.0) * (1.0 - sfFlags.x);
  if (sfDetail.x > 0.0) {
    vec2 sfDn = (sfD.rg * 2.0 - 1.0) * sfDR;   // back from the rotated detail frame
    float sfDv = sfDw > 0.0 ? max(sfD.b - dot(sfDn, sfDn) - 0.004, 0.0) : 0.0;
    sfVar += (sfDv + (1.0 - sfDw) * sfDetail2.w) * sfDetail.y * sfDetail.y;
    sfN += sfDn * sfDetail.y;
  }
  if (sfFlags.y > 0.5) sfN = sfN.yx;
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
  float ambientOcclusion = mix(1.0, sfAO, sfMisc.y * sfAOScale);
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
void RE_Direct_Surf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  IncidentLight sfL = directLight;
  float sfNL = dot( geometryNormal, directLight.direction );
  sfL.color *= saturate( abs( sfNL ) + 2.0 * sfMicroAO * sfMicroAO - 1.0 );
  RE_Direct_Physical( sfL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  if ( sfFlags.w > 0.0 ) {
    reflectedLight.directDiffuse += saturate( - sfNL ) * directLight.color * BRDF_Lambert( material.diffuseContribution ) * sfTrans;
  }
}
#undef RE_Direct
#define RE_Direct RE_Direct_Surf
`;

// night emissive; lamp glass glows brighter where we look through the diffuser at the
// lamp and falls off towards the silhouette
const EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance *= mix( 1.0, sfEmGain * smoothstep( 0.02, 0.85, sfNight ), sfFlags.z );
if ( sfEmis.x > 0.0 ) {
  float sfRim = pow( saturate( dot( normal, normalize( vViewPosition ) ) ), sfEmis.y );
  totalEmissiveRadiance *= mix( 1.0 - sfEmis.x, 1.0, sfRim );
}
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

function patchVertex(src) {
  return src
    .replace('#include <common>', '#include <common>\n' + VERT_PARS)
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERT_WORLD);
}

const v4 = (a = [0, 0, 0, 0]) => new THREE.Vector4(...a);
const v3 = (a = [1, 1, 1]) => new THREE.Vector3(...a);

/** Outlier tint families: `out` is [r,g,b,p] (one family) or {p, fam: [[r,g,b] ×1..3]}. */
function outliers(out) {
  if (!out) return [[1, 1, 1], [1, 1, 1], [1, 1, 1], 0];
  if (Array.isArray(out)) return [out.slice(0, 3), out.slice(0, 3), out.slice(0, 3), out[3] ?? 0];
  const f = out.fam;
  return [f[0], f[1] || f[0], f[2] || f[1] || f[0], out.p ?? 0];
}

/**
 * Uniform set for one material.
 *   cfg     library `surf` settings, def = library definition (night / trans flags)
 *   t       baked texture entry {albedo, surface, recipe} or null
 *   shared  {textures, detail, macro, night, gain, aoScale}
 */
export function surfaceUniforms(cfg, def, t, shared) {
  const r = t?.recipe;
  const sc = cfg.scale ?? 1;
  const W = (r?.tile[0] ?? 1) * sc, H = (r?.tile[1] ?? 1) * sc;
  const L = r?.layout;
  const c = cfg.cell || {};
  const m = cfg.macro || {};
  const d = cfg.detail;
  const sp = cfg.spots || {};
  const st = cfg.stain || {};
  const w = cfg.weather || {};
  const ln = cfg.lanes || {};
  const em = cfg.emis || {};
  const dEntry = (d?.tex && shared.textures.get(d.tex)) || shared.textures.get('detail');
  const detailTex = dEntry?.surface || shared.detail;
  const dRes = dEntry?.recipe ? (Array.isArray(dEntry.recipe.size) ? dEntry.recipe.size[0] : dEntry.recipe.size) : 512;
  const toolTex = (d?.tool && shared.textures.get(d.tool)?.surface) || null;
  const [o1, o2, o3, op] = outliers(c.out);
  return {
    sfFlags: { value: v4([r?.metalMask ? 1 : 0, cfg.swap ? 1 : 0, def.night ? 1 : 0, cfg.trans ? 1 : 0]) },
    sfTrans: { value: new THREE.Vector3(...(cfg.trans || [0, 0, 0])) },
    sfNight: shared.night,
    sfEmGain: shared.gain,
    sfAOScale: shared.aoScale,
    sfEmis: { value: v4([em.rim ?? 0, em.exp ?? 1, 0, 0]) },
    sfTile: { value: v4([1 / W, 1 / H, W, H]) },
    sfLay: { value: v4([(L?.rowH ?? 1) * sc, L ? L.rows : 0, L?.seg?.[0] ?? 1, L?.seg?.[1] ?? 1]) },
    sfLay2: { value: v4([L?.jitter ?? 0, L?.seed ?? 1, L?.shift ? 1 : 0, L?.rowJoints === false ? 0 : 1]) },
    sfCell: { value: v4([c.value ?? 0, c.hue ?? 0, c.rough ?? 0, c.row ?? 0.35]) },
    sfCellA: { value: v3(c.a) },
    sfCellB: { value: v3(c.b) },
    sfCellOut: { value: v4([...o1, op]) },
    sfCellOut2: { value: v3(o2) },
    sfCellOut3: { value: v3(o3) },
    sfMacro: { value: v4([m.f1 ?? 1 / 7, m.f2 ?? 1 / 23, shared.macro ? m.albedo ?? 0 : 0, shared.macro ? m.rough ?? 0 : 0]) },
    sfMacroAn: { value: v4([...(m.an1 || [1, 1]), ...(m.an2 || [1, 1])]) },
    sfDetail: { value: v4([d && detailTex ? d.freq ?? 2 : 0, d?.normal ?? 0, d?.albedo ?? 0, d?.rough ?? 0]) },
    sfDetail2: { value: v4([dRes, L && toolTex ? d.share ?? 0.6 : 0, d?.margin ?? 0.025, d?.farVar ?? 0.006]) },
    sfMisc: { value: v4([cfg.normal ?? 1, cfg.ao ?? 1, cfg.variance ?? 2, cfg.microShadow ?? 1]) },
    sfSpots: { value: v4([L ? sp.prob ?? 0 : 0, sp.radius ?? 0.01, sp.albedo ?? 1, sp.rough ?? 0.5]) },
    sfStain: { value: v4([shared.macro ? st.amount ?? 0 : 0, st.freq ?? 0.3, st.threshold ?? 0.7, 0]) },
    sfJoint: { value: v4([cfg.jointHide ?? (r?.joint ? 0.7 : 0), (r?.joint ?? 0) * sc, 0, 0]) },
    sfWeather: { value: v4(shared.macro ? [w.ledge ?? 0, w.streak ?? 0, w.threshold ?? 0.62, w.soffit ?? 0] : [0, 0, 0, 0]) },
    sfLanes: { value: v4(shared.macro ? [ln.track ?? 1.6, ln.rail ?? 0.7455, ln.grime ?? 0, ln.wear ?? 0] : [0, 0, 0, 0]) },
    sfDetailTex: { value: detailTex || null },
    sfToolTex: { value: toolTex || detailTex || null },
    sfMacroTex: { value: shared.macro || null },
  };
}

// surface config per patched material (kept out of userData, which clone() JSON-copies)
export const surfaceOf = new WeakMap();

/**
 * Install the surface patch on a material (library materials, variants and clones).
 * The patch is self-contained: `onBeforeCompile` decides from the material it is called
 * on (`this`) whether the baked maps are attached, and injects SURF / SURF_GLASS itself.
 * So a module that copies our onBeforeCompile onto its own material (and chains its own
 * patch) gets the correct shading, and plain clone() keeps the patch too.
 */
export function applySurface(mat, sf) {
  surfaceOf.set(mat, sf);
  if (sf.textures) {
    mat.map = sf.textures.albedo;
    mat.normalMap = sf.textures.surface;
  }
  const isSurf = (m) => !!(sf.textures && m && m.map === sf.textures.albedo && m.normalMap === sf.textures.surface);
  mat.onBeforeCompile = function (shader) {
    const surf = isSurf(this || mat);
    Object.assign(shader.uniforms, sf.uniforms);
    const head = (surf ? '#define SURF\n' : '') + (surf && sf.glass ? '#define SURF_GLASS\n' : '');
    shader.fragmentShader = head + patchFragment(shader.fragmentShader);
    if (surf) shader.vertexShader = '#define SURF\n' + patchVertex(shader.vertexShader);
  };
  mat.customProgramCacheKey = function () {
    const surf = isSurf(this || mat);
    return 'sf6' + (surf ? 'S' : '') + (surf && sf.glass ? 'G' : '');
  };
  mat.clone = function () {
    const c = Object.getPrototypeOf(this).clone.call(this);
    applySurface(c, sf);
    return c;
  };
  mat.needsUpdate = true;
  return mat;
}
