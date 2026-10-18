import * as THREE from 'three';
import { HASH_GLSL, LAYOUT_GLSL } from './glsl/common.js';

// Runtime shading for library materials (patched MeshStandard / MeshPhysical).
//
// The patch is assembled per feature set, so a program only carries the code its
// materials can use. Program cache key 'sf7' + one letter per feature:
//   S  surface maps: baked albedo(+roughness) and surface(normal.xy, moment or mask, ao),
//      UVs in metres, macro variation and stains, specular anti-aliasing, baked AO and
//      micro-shadowing. Alone ('lite': metals, paint, wood, fabric, glass…) the maps are
//      plain tiling lookups.
//   L  row layout: analytic rows/segments with a random per-row u shift (no 2D
//      repetition), per-cell / per-row colour + roughness variation (the cell tint is
//      box-filtered over the pixel footprint, so it survives at distance; part of it can
//      follow a 1-3 m noise sampled at the cell centre, so tones drift in runs), and
//      per-block mirrored map lookups (u, v or both: four relief variants of every block)
//   J  grazing-angle joint masking (with L), only below ~10° elevation
//   P  random irregular spots inside some cells, e.g. chewing gum (with L): lognormal sizes,
//      ragged soft outlines, occasional smears, clustered by a 3-8 m noise mask and kept
//      off the track (with K: lane offset |d| below a threshold)
//   D  detail map: high-frequency grain that fades out through its own mips
//   R  dressing (with L and D): the detail is chosen, rotated, offset and scaled per block
//      (chisel dressing)
//   W  weathering: soiled ledges and soffits, vertical drip streaks (world orientation)
//   K  lanes: grime bands along the rails / kerbs and worn lanes (street ribbons: v = d,
//      sidewalks: v = metres from the gutter)
//   A  (with K) lane offset d from the aLaneD vertex attribute instead of uv.y: set
//      `laneAttr: true` on the material (materials.get(name, {laneAttr: true}))
//   T  translucency: diffuse transmission for thin fabric and leaves (all light types)
//   N  night emissive: scaled by U.uNight × emissive gain, optional rim falloff
//   G  thin glass: reflections are not attenuated by opacity (premultiplied blend)
//   H  height relief (with L): parallax-occlusion mapping of the height stored in the albedo
//      alpha (recipe heightA), marched through the row layout (shifted rows, mirrored blocks),
//      with a self-shadow march towards the sun; faded out with distance. Roughness then
//      comes from the height (joints rougher).
// Features come in families (FAMILY below) so that materials drawn with the same three.js
// variant share programs: 'full' (stone, paving, concrete, plaster, roof tiles), 'lite' and
// 'relief' (rock-faced stone only: the parallax march stays out of the common programs).
// Two families beat finer ones: a street or facade batch mixes paving and stone, and one
// extra program costs more to compile than the unused feature code it would save. Inside
// a program everything is switched by uniforms (coherent per draw, so the branches are
// free). surface.b is the normal moment (its mip-mapped excess becomes
// roughness), a metal mask or a paint coverage mask (chips show the baked undercoat /
// bare wood instead of the paint colour).

const SURF_PARS = /* glsl */ `
uniform vec4 sfFlags;    // metal mask, swap uv, paint mask, unused
uniform vec4 sfTile;     // 1/W, 1/H, W, H (m)
uniform vec4 sfMacro;    // freq1, freq2 (1/m), albedo amp, roughness amp
uniform vec4 sfMacroAn;  // anisotropy of the two macro lookups
uniform vec4 sfStain;    // amount, freq (1/m), threshold, vertical stretch (along v: run-off on walls)
uniform vec4 sfMisc;     // normal strength, ao strength, variance→roughness k, micro-shadow
uniform float sfAOScale; // global scale of the baked AO (lowered when screen-space AO runs)
uniform float sfEnvI;    // the material's envMapIntensity (three replaces it by the scene's when the
                         // environment comes from scene.environment)
uniform sampler2D sfMacroTex;
`;

const LAYOUT_PARS = /* glsl */ `
${HASH_GLSL}
${LAYOUT_GLSL}
uniform int sfOne;       // = 1: keeps the neighbour loop rolled (one copy of the tint code)
uniform vec4 sfLay;      // rowH, rows (0 = no layout), segMin, segMax
uniform vec4 sfLay2;     // jitter, seed, shiftRows, rowJoints
uniform vec4 sfCell;     // value amp, hue amp, roughness amp, per-row share
uniform vec3 sfCellA;    // hue multipliers mixed per cell
uniform vec3 sfCellB;
uniform vec4 sfCellOut;  // outlier family 1 multiplier rgb, total probability
uniform vec3 sfCellOut2; // outlier families 2 and 3
uniform vec3 sfCellOut3;
uniform vec4 sfJoint;    // grazing joint masking amount, joint half width (m)
uniform float sfMirror;  // share of blocks whose map lookup is mirrored (u, v or both)
uniform vec4 sfSpots;    // peak probability per cell, median radius (m), albedo mult, roughness
uniform vec4 sfSpots2;   // clusters: noise freq (1/m, 0 = none), mask low, mask high; lane: clear below |d| (0 = off)
uniform vec4 sfCell2;    // correlated tone: value amp, hue share, noise freq (1/m, 0 = off), unused
// per-cell tint; nz = correlated tone noise at the cell centre (0.5 = neutral)
vec3 sfTintOf(uint h, float amp, float outliers, vec2 nz) {
  float h0 = sfHf(h), h1 = sfHf(sfH(h + 1u)), h2 = sfHf(sfH(h + 2u)), h3 = sfHf(sfH(h + 3u)), h4 = sfHf(sfH(h + 4u));
  float v = 1.0 + amp * (sfCell.x * (h0 * 2.0 - 1.0) + sfCell2.x * (nz.x * 2.0 - 1.0));
  float hm = mix(h1, clamp(0.5 + (nz.y - 0.5) * 3.0, 0.0, 1.0), sfCell2.y);
  vec3 t = v * mix(vec3(1.0), mix(sfCellA, sfCellB, hm), amp * sfCell.y * h2);
  vec3 o = h4 < 0.3334 ? sfCellOut.rgb : (h4 < 0.6667 ? sfCellOut2 : sfCellOut3);
  return mix(t, t * o, outliers * step(1.0 - sfCellOut.a, h3));
}
// correlated tone noise (quarry batches, dirt) sampled at a cell centre (uv metres)
vec2 sfCellNoise(vec2 c) {
  return sfCell2.z > 0.0 ? textureLod(sfMacroTex, c * sfCell2.z + vec2(0.37, 0.71), 0.0).rg : vec2(0.5);
}
`;

// parallax relief: texture coordinate (tile units) of a wall point (uv metres) through the
// row layout, so the march crosses joints into the neighbouring (shifted, mirrored) blocks
const POM_PARS = /* glsl */ `
uniform vec4 sfPom;      // height at alpha 0 (m), height range (m), parallax full within / gone by (m)
uniform vec4 sfPom2;     // steps head-on, steps grazing, shadow steps, shadow strength
uniform vec3 sfSunDir;   // towards the sun (world)
vec3 sfSunV = vec3(0.0); // towards the sun (view), set by the relief march
float sfPomSh = 1.0;     // relief self-shadow towards the sun
vec2 sfLayT(vec2 uv) {
  float rowH = sfLay.x;
  float rgF = floor(uv.y / rowH);
  int rg = int(rgF);
  vec2 P = uv;
  if (sfLay2.z > 0.5) P.x += sfRowShift(rg, sfLay2) * sfTile.z;
  int r = sfMod(rg, int(sfLay.y));
  float tx = floor(P.x * sfTile.x);
  float lx = P.x - tx * sfTile.z;
  int k, n; float b0, b1;
  sfRowSeg(r, lx, sfTile.z, sfLay, sfLay2, k, b0, b1, n);
  uint mh = sfH(sfH2(rg, int(tx) * n + k, uint(sfLay2.y) + 501u) + 41u);
  vec2 fo = vec2(0.0);
  if (sfHf(mh) < sfMirror) {
    uint mk = sfH(mh) % 3u;
    if (mk != 1u) fo.x = b0 + b1 - 2.0 * lx;
    if (mk != 0u) fo.y = rowH - 2.0 * (uv.y - rgF * rowH);
  }
  return (P + fo) * sfTile.xy;
}
`;

const DETAIL_PARS = /* glsl */ `
uniform vec4 sfDetail;   // freq (1/m, 0 = off), normal amp, albedo amp, roughness amp
uniform vec4 sfDetail2;  // texels per detail tile, dressing share (0 = off), margin (m), faded variance
uniform sampler2D sfDetailTex;
uniform sampler2D sfToolTex;
mat2 sfDR = mat2(1.0);   // detail map rotation (dressing mode)
`;

const WEATHER_PARS = /* glsl */ `
varying vec3 vSfWorld;
uniform vec4 sfWeather;  // ledge soiling, streak amount, streak threshold, soffit soot
`;

const LANES_PARS = /* glsl */ `
uniform vec4 sfLanes;    // lane centre offset, grime line offset from it (m), grime, lane wear (< 0: trodden darker)
uniform vec4 sfLanes2;   // grime band: full / clear at (m from its line); lane: full / clear at (m from its centre)
`;

// plain tiling lookup (hardware derivatives)
const MAP_PLAIN = /* glsl */ `
  vec2 sfUv = sfFlags.y > 0.5 ? vMapUv.yx : vMapUv;
  vec4 sfA = texture(map, sfUv * sfTile.xy);
  vec4 sfS = texture(normalMap, sfUv * sfTile.xy);
  vec3 sfAlb = sfA.rgb;
  float sfRough = sfA.a;
`;

// Grazing-angle joint masking: seen at a low angle across a recessed joint, the near
// arris hides it and the eye lands on the far stone. The footprint anisotropy tells
// which way we look (along u hides head joints, along v hides bed joints). Only truly
// grazing views (anisotropy 5-10, i.e. below ~10° elevation): above that both joint
// directions stay visible, as in the photographs.
const MAP_JOINT = /* glsl */ `
    if (sfJoint.x > 0.0) {
      float ax = sfFoot.x / max(sfFoot.y, 1e-7);
      float hU = smoothstep(5.0, 10.0, ax), hV = smoothstep(5.0, 10.0, 1.0 / ax);
      float dU = min(cl.x, b1 - b0 - cl.x), dV = min(cl.y, rowH - cl.y);
      float inU = (1.0 - smoothstep(sfJoint.y, sfJoint.y + sfFoot.x, dU)) * hU;
      float inV = (1.0 - smoothstep(sfJoint.y, sfJoint.y + sfFoot.y, dV)) * hV * sfLay2.w;
      if (inU >= inV) sfOff = vec2((cl.x < 0.5 * (b1 - b0) ? 1.0 : -1.0) * (sfJoint.y + sfFoot.x) * sfFl.x, 0.0);
      else sfOff = vec2(0.0, (cl.y < 0.5 * rowH ? 1.0 : -1.0) * (sfJoint.y + sfFoot.y) * sfFl.y);
      sfHide = sfJoint.x * max(inU, inV);
    }
`;

// Parallax-occlusion relief: march the view ray through the height field (linear search,
// one secant refinement) and move the lookup to the hit; then march from the hit towards
// the sun for the relief's own cast shadows. The reference plane (h = 0) is the polygon:
// proud parts are entered from above it. The tangent frame comes from screen derivatives
// (gradients of u and v in view space), the step count from the view angle and distance.
const MAP_POM = /* glsl */ `
  if (sfPom.y > 0.0 && sfLay.y > 0.5) {
    float sfVd = length(vViewPosition);
    float sfPf = 1.0 - smoothstep(sfPom.z, sfPom.w, sfVd);
    if (sfPf > 0.0) {
      vec3 sfQ1 = dFdx(-vViewPosition), sfQ2 = dFdy(-vViewPosition);
      #ifdef FLAT_SHADED
        vec3 sfNv = normalize(cross(sfQ1, sfQ2));
      #else
        vec3 sfNv = normalize(vNormal);
        #ifdef DOUBLE_SIDED
          sfNv *= gl_FrontFacing ? 1.0 : -1.0;
        #endif
      #endif
      vec3 sfQ2p = cross(sfQ2, sfNv), sfQ1p = cross(sfNv, sfQ1);
      float sfDet = dot(sfQ1, sfQ2p);
      if (abs(sfDet) > 1e-16) {
        vec3 sfGu = (sfQ2p * sfGx.x + sfQ1p * sfGy.x) / sfDet;
        vec3 sfGv = (sfQ2p * sfGx.y + sfQ1p * sfGy.y) / sfDet;
        vec3 sfVv = normalize(vViewPosition);
        float sfC = dot(sfVv, sfNv);
        vec2 sfO = vec2(dot(sfVv, sfGu), dot(sfVv, sfGv)) / max(sfC, 0.12);
        float sfOl = length(sfO);
        if (sfOl > 7.0) sfO *= 7.0 / sfOl;
        float hLo = sfPom.x * sfPf, hR = sfPom.y * sfPf, hTop = hLo + hR;
        vec2 tgx = sfGx * sfTile.xy, tgy = sfGy * sfTile.xy;
        int nS = int(clamp(mix(sfPom2.y, sfPom2.x, saturate(sfC)) * mix(1.0, 0.6, smoothstep(6.0, sfPom.z, sfVd)), 6.0, 40.0));
        float dh = hR / float(nS);
        float rayH = hTop;
        float prevD = rayH - (hLo + hR * textureGrad(map, sfLayT(sfUv + sfO * rayH), tgx, tgy).a);
        float hitH = rayH;
        if (prevD > 0.0) {
          for (int i = 1; i <= 40 * sfOne; i++) {
            rayH -= dh;
            float dD = rayH - (hLo + hR * textureGrad(map, sfLayT(sfUv + sfO * rayH), tgx, tgy).a);
            if (dD <= 0.0 || i >= nS) {
              float hA = rayH + dh;
              float hm = dD < 0.0 ? hA - dh * prevD / (prevD - dD) : rayH;
              float dm = hm - (hLo + hR * textureGrad(map, sfLayT(sfUv + sfO * hm), tgx, tgy).a);
              if (dm > 0.0 && dD < 0.0) hitH = hm - (hm - rayH) * dm / (dm - dD);
              else if (dm < 0.0) hitH = hA - (hA - hm) * prevD / (prevD - dm);
              else hitH = hm;
              break;
            }
            prevD = dD;
          }
        }
        sfUv += sfO * hitH;
        // self-shadow: march from the hit towards the sun
        sfSunV = normalize((viewMatrix * vec4(sfSunDir, 0.0)).xyz);
        float sfCl = dot(sfSunV, sfNv);
        if (sfPom2.w > 0.0 && sfCl > 0.0 && sfSunDir.y > 0.0) {
          vec2 sfOL = vec2(dot(sfSunV, sfGu), dot(sfSunV, sfGv)) / max(sfCl, 0.06);
          float sfLl = length(sfOL);
          if (sfLl > 12.0) sfOL *= 12.0 / sfLl;
          int nL = int(sfPom2.z);
          float occ = 0.0;
          // a fixed per-pixel dither of the sample positions turns the march's banding into
          // fine grain along the shadow edges
          float sfJ = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          for (int i = 1; i <= 24 * sfOne; i++) {
            if (i > nL) break;
            // denser near the hit, where the short shadows are
            float fi = (float(i) - sfJ) / float(nL);
            float rh = hitH + (hTop - hitH) * fi * fi;
            float Hs = hLo + hR * textureGrad(map, sfLayT(sfUv + sfOL * (rh - hitH)), tgx, tgy).a;
            occ = max(occ, Hs - rh);
          }
          sfPomSh = 1.0 - sfPom2.w * smoothstep(0.0006, 0.004 + 0.002 * (1.0 - sfPf), occ);
        }
      }
    }
  }
`;

// small random spots inside some cells (chewing gum, drips). Aged gum is a flattened grey
// to grey-black blotch: sizes lognormal (0.6-3 cm across), outlines ragged (radius warped
// ±40 % by two octaves of noise round the spot) with a soft 2-3 mm edge, about one in eight
// drawn out into a smear. Density follows a 3-8 m noise mask (clusters where people stand
// and wait, a sparse eighth of the peak elsewhere) and, on lanes (street: v = d), drops to
// a fifth between and over the rails.
const mapSpots = (f) => /* glsl */ `
    if (sfSpots.x > 0.0) {
      float sfDen = sfSpots.x;
      if (sfSpots2.x > 0.0) {
        vec2 sfCc = vec2(sfUv.x - lx + 0.5 * (b0 + b1), (rgF + 0.5) * rowH);
        sfDen *= 0.12 + 0.88 * smoothstep(sfSpots2.y, sfSpots2.z, textureLod(sfMacroTex, sfCc * sfSpots2.x + vec2(0.61, 0.23), 0.0).b);
      }
${f.lanes ? `      if (sfSpots2.w > 0.0) sfDen *= mix(0.2, 1.0, smoothstep(sfSpots2.w - 0.9, sfSpots2.w, abs(${f.laneAttr ? 'vSfLaneD' : 'vMapUv.y'})));
` : ''}      if (sfHf(sfH(sfCh + 9u)) < sfDen) {
        float g3 = (sfHf(sfH(sfCh + 12u)) + sfHf(sfH(sfCh + 16u)) + sfHf(sfH(sfCh + 17u)) - 1.5) * 2.0;
        float rad = clamp(sfSpots.y * exp(0.42 * g3), 0.003, 0.015);
        float hE = sfHf(sfH(sfCh + 14u));
        float el = hE < 0.12 ? 1.8 + 12.0 * hE : 1.0 + 0.4 * hE;
        float ext = rad * el;
        vec2 sp = ext * 1.2 + vec2(sfHf(sfH(sfCh + 10u)), sfHf(sfH(sfCh + 11u))) * max(sfCs - 2.4 * ext, vec2(0.0));
        float ang = sfHf(sfH(sfCh + 13u)) * 6.2832;
        vec2 dv = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * (cl - sp);
        dv.x /= el;
        float dl = length(dv);
        vec2 dir = dv / max(dl, 1e-6);
        vec2 ro = vec2(sfHf(sfH(sfCh + 15u)), ang * 0.159);
        float wn = (textureLod(sfMacroTex, dir * 0.05 + ro, 0.0).r - 0.5) * 3.0 + (textureLod(sfMacroTex, dir * 0.16 + ro.yx, 0.0).g - 0.5) * 1.6;
        float rr = rad * (1.0 + 0.4 * clamp(wn, -1.0, 1.0));
        float aa = max(sfFoot.x, sfFoot.y);
        sfSpot = (1.0 - smoothstep(rr - 0.0025 - aa, rr + 0.0005 + aa, dl)) * (1.0 - smoothstep(0.5, 1.5, aa / rad));
        sfSpotA = sfSpots.z + 0.25 * (sfHf(sfH(sfCh + 18u)) - 0.5);
      }
    }
`;

// row layout lookup: shifted rows need explicit gradients
const mapLayout = (f) => /* glsl */ `
  vec2 sfUv = sfFlags.y > 0.5 ? vMapUv.yx : vMapUv;
  vec2 sfGx = dFdx(sfUv), sfGy = dFdy(sfUv);
  vec2 sfFoot = max(abs(sfGx), abs(sfGy));
${f.pom ? MAP_POM : ''}  vec2 sfP = sfUv;
  vec3 sfTint = vec3(1.0);
  float sfRoughMul = 1.0;
  float sfSpot = 0.0;
  float sfSpotA = 1.0;
  float sfHide = 0.0;
  vec2 sfOff = vec2(0.0);
  uint sfCh = 0u;            // block hash
  vec2 sfCl = vec2(0.0);     // position inside the block (m)
  vec2 sfCs = vec2(1.0);     // block size (m)
  vec2 sfFl = vec2(1.0);     // mirrored lookup (-1) along u / v
  vec2 sfFo = vec2(0.0);     // lookup offset of the mirror (m)
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
    float hw = 0.75 * sfFoot.x;
    int jn = hw > 0.02 * (b1 - b0) ? sfOne : 0;   // near: the block itself, far: and its neighbours
    float L = sfTile.z / float(n);
    float x0 = lx - hw, x1 = lx + hw, ws = 0.0;
    vec3 cellT = vec3(0.0);
    for (int j = -jn; j <= jn; j++) {
      float lo = j == 0 ? b0 : (j < 0 ? sfSegB(r, k - 1, n, L, sfLay2) : b1);
      float hi = j == 0 ? b1 : (j < 0 ? b0 : sfSegB(r, k + 2, n, L, sfLay2));
      float wj = jn == 0 ? 1.0 : max(0.0, min(x1, hi) - max(x0, lo));
      vec2 nz = sfCellNoise(vec2(sfUv.x - lx + 0.5 * (lo + hi), (rgF + 0.5) * rowH));
      cellT += sfTintOf(j == 0 ? sfCh : sfH2(rg, gi + j, cs), 1.0, 1.0, nz) * wj;
      ws += wj;
    }
    if (jn > 0) cellT = (cellT + vec3(max(0.0, 2.0 * hw - ws))) / (2.0 * hw);
    sfTint = mix(vec3(1.0), sfTintOf(rh, sfCell.w, 0.0, vec2(0.5)) * cellT, fRow);
    sfRoughMul = 1.0 + sfCell.z * (sfHf(sfH(sfCh + 5u)) * 2.0 - 1.0) * fSeg;
    vec2 cl = vec2(lx - b0, sfUv.y - rgF * rowH);
    sfCl = cl;
    sfCs = vec2(b1 - b0, rowH);
    // mirror the block's lookup in u, v or both: joints and margins map onto themselves,
    // the relief and mottling inside the block read as another block
    uint mh = sfH(sfCh + 41u);
    if (sfHf(mh) < sfMirror) {
      uint mk = sfH(mh) % 3u;
      sfFl = vec2(mk == 1u ? 1.0 : -1.0, mk == 0u ? 1.0 : -1.0);
      sfFo = vec2(sfFl.x < 0.0 ? b0 + b1 - 2.0 * lx : 0.0, sfFl.y < 0.0 ? rowH - 2.0 * cl.y : 0.0);
    }
${f.joint ? MAP_JOINT : ''}${f.spots ? mapSpots(f) : ''}  }
  vec2 sfT = (sfP + sfFo) * sfTile.xy;
  vec2 sfTx = sfGx * sfFl * sfTile.xy, sfTy = sfGy * sfFl * sfTile.xy;
  vec4 sfA = textureGrad(map, sfT, sfTx, sfTy);
  vec4 sfS = textureGrad(normalMap, sfT, sfTx, sfTy);
  if (sfHide > 0.002) {
    vec2 sfT2 = (sfP + sfFo + sfOff) * sfTile.xy;
    sfA = mix(sfA, textureGrad(map, sfT2, sfTx, sfTy), sfHide);
    sfS = mix(sfS, textureGrad(normalMap, sfT2, sfTx, sfTy), sfHide);
  }
  vec3 sfAlb = sfA.rgb * sfTint;
  float sfRough = ${f.pom ? '(sfPom.y > 0.0 ? mix(0.97, 0.87, smoothstep(-0.012, -0.005, sfPom.x + sfPom.y * sfA.a)) : sfA.a)' : 'sfA.a'} * sfRoughMul;
`;

// dressing: each block gets its own dressing (taltish striation from the tool map, pecked or
// rubbed from the detail map), rotated, offset and scaled (±12 %) per block, finer on the
// drafted margin
const MAP_DRESS = /* glsl */ `
    if (sfDetail2.y > 0.0 && sfLay.y > 0.5) {
      float hd = sfHf(sfH(sfCh + 21u)), ha = sfHf(sfH(sfCh + 22u));
      dTool = hd < sfDetail2.y;
      // taltish: one working direction per block, 60-75° from horizontal either way (±7°)
      float ang = dTool ? (ha < 0.5 ? 1.0 : -1.0) * (1.047 + 0.262 * fract(ha * 7.31)) + (sfHf(sfH(sfCh + 23u)) - 0.5) * 0.24 : ha * 6.2832;
      float ca = cos(ang), sa = sin(ang);
      sfDR = mat2(ca, sa, -sa, ca);
      float dsc = 0.88 + 0.24 * sfHf(sfH(sfCh + 27u));
      dq = sfDR * sfCl * (sfDetail.x * dsc) + vec2(sfHf(sfH(sfCh + 24u)), sfHf(sfH(sfCh + 25u)));
      dgx = sfDR * dgx * dsc; dgy = sfDR * dgy * dsc;
      bool rubbed = !dTool && hd > sfDetail2.y + (1.0 - sfDetail2.y) * 0.6;
      dAmp = rubbed ? 0.3 : 1.0;
      dFar = dTool ? 0.985 : (rubbed ? 1.0 : 0.97);   // mean self-shadowing of the tooling
      float e = min(min(sfCl.x, sfCs.x - sfCl.x), min(sfCl.y, sfCs.y - sfCl.y));
      float mg = sfDetail2.z * (0.7 + 0.6 * sfHf(sfH(sfCh + 26u)));
      float inner = smoothstep(mg, mg + 0.005, e);
      dAmp *= mix(0.3, 1.0, inner);
      dFar = mix(1.0, dFar, inner);
    }
`;

// detail grain: faded out (and not fetched) once a pixel covers many detail texels; its
// average normal variance is then kept as roughness
const mapDetail = (f) => /* glsl */ `
  vec4 sfD = vec4(0.5, 0.5, 0.0, 0.5);
  float sfDw = 0.0;
  if (sfDetail.x > 0.0) {
    vec2 dq = sfP * sfDetail.x, dgx = sfGx * sfDetail.x, dgy = sfGy * sfDetail.x;
    float dAmp = 1.0, dFar = 1.0;
    bool dTool = false;
${f.dress ? MAP_DRESS : ''}    sfDw = 1.0 - smoothstep(3.0, 12.0, min(sfFoot.x, sfFoot.y) * sfDetail.x * sfDetail2.x);
    sfAlb *= mix(1.0, dFar, 1.0 - sfDw);
    if (sfDw > 0.0) {
      vec4 dt = ${f.dress ? 'dTool ? textureGrad(sfToolTex, dq, dgx, dgy) : ' : ''}textureGrad(sfDetailTex, dq, dgx, dgy);
      sfD = mix(sfD, dt, sfDw * dAmp);
      float sfDa = sfD.a * 2.0 - 1.0;
      sfAlb *= 1.0 + sfDetail.z * sfDa;
      sfRough *= 1.0 - sfDetail.w * sfDa;
    }
  }
`;

// layout-free lookup with explicit footprint (detail without layout: smooth stone, render)
const MAP_FOOT = /* glsl */ `
  vec2 sfUv = sfFlags.y > 0.5 ? vMapUv.yx : vMapUv;
  vec2 sfGx = dFdx(sfUv), sfGy = dFdy(sfUv);
  vec2 sfFoot = max(abs(sfGx), abs(sfGy));
  vec2 sfP = sfUv;
  vec4 sfA = texture(map, sfUv * sfTile.xy);
  vec4 sfS = texture(normalMap, sfUv * sfTile.xy);
  vec3 sfAlb = sfA.rgb;
  float sfRough = sfA.a;
`;

// large-scale tone / roughness variation and irregular stains (every surface material)
const MAP_MACRO = /* glsl */ `
  if (sfMacro.z + sfMacro.w + sfStain.x > 0.0) {
    vec4 sfM1 = texture(sfMacroTex, sfUv * sfMacroAn.xy * sfMacro.x);
    vec4 sfM2 = texture(sfMacroTex, sfUv * sfMacroAn.zw * sfMacro.y + vec2(0.31, 0.67));
    sfAlb *= 1.0 + sfMacro.z * ((sfM1.r - 0.5) * 1.3 + (sfM2.g - 0.5) * 0.9);
    sfRough *= 1.0 + sfMacro.w * ((sfM1.a - 0.5) * 2.0);
    if (sfStain.x > 0.0) {
      vec2 sfStUv = sfUv * vec2(1.0, 1.0 / max(sfStain.w, 1.0));
      float sfSt = smoothstep(sfStain.z, sfStain.z + 0.08, texture(sfMacroTex, sfStUv * sfStain.y + vec2(0.13, 0.57)).b);
      sfSt *= smoothstep(0.4, 0.62, sfM1.g);
      sfAlb *= 1.0 - sfStain.x * sfSt;
      sfRough = mix(sfRough, sfRough * 0.85, sfSt);
    }
  }
`;

// lanes across ribbons (v = lateral offset): soft grime bands either side of a lane
// centre (the rails of a track, a sidewalk's kerb and building line), patchy along them,
// and a worn lane round the centre (paler and polished, or trodden darker if wear < 0)
const mapLanes = (attr) => /* glsl */ `
  if (sfLanes.z + abs(sfLanes.w) > 0.0) {
    float sfLd = ${attr ? 'vSfLaneD' : 'vMapUv.y'};
    vec4 sfLm = texture(sfMacroTex, vec2(vMapUv.x, sfLd) * vec2(0.11, 0.9));
    float sfLn = sfLm.g - 0.5;
    float dT = abs(abs(sfLd) - sfLanes.x);
    float dR = abs(dT - sfLanes.y) + 0.26 * (sfLanes2.y - sfLanes2.x) * sfLn;
    float grime = (1.0 - smoothstep(sfLanes2.x, sfLanes2.y, dR)) * (0.4 + 1.2 * sfLm.r);
    float lane = 1.0 - smoothstep(sfLanes2.z, sfLanes2.w, dT + 0.35 * (sfLanes2.w - sfLanes2.z) * sfLn);
    sfAlb *= (1.0 - sfLanes.z * grime) * (1.0 + sfLanes.w * lane);
    sfRough = max(sfRough - 0.08 * lane * step(0.001, abs(sfLanes.w)), 0.05);
  }
`;

// weathering by world orientation: dust and soot on ledges (patchy), sheltered soffits
// evenly dark (no blotches: the soffit's own geometry and AO shade it), rain-washed vertical
// drip streaks on the walls, their strength drifting in tall run-off bands, never in
// isotropic blobs
const MAP_WEATHER = /* glsl */ `
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
    sfAlb *= 1.0 - sfWeather.w * sfSoffit;
    sfRough = min(sfRough * (1.0 + 0.08 * sfLedge), 1.0);
    vec3 sfTW = normalize(vec3(-sfNW.z, 0.0, sfNW.x) + 1e-5);
    float sfAl = dot(vSfWorld, sfTW);
    float sfS1 = texture(sfMacroTex, vec2(sfAl * 2.4, vSfWorld.y * 0.1) + vec2(0.71, 0.29)).g;
    float sfS2 = texture(sfMacroTex, vec2(sfAl * 7.0, vSfWorld.y * 0.27) + vec2(0.17, 0.83)).r;
    float sfStreak = smoothstep(sfWeather.z, sfWeather.z + 0.14, 0.65 * sfS1 + 0.35 * sfS2);
    float sfVert = 1.0 - smoothstep(0.2, 0.4, abs(sfNW.y));
    float sfMv = texture(sfMacroTex, vec2(sfAl * 0.3, vSfWorld.y * 0.05) + vec2(0.53, 0.19)).b;
    sfAlb *= 1.0 - sfWeather.y * sfStreak * sfVert * (0.6 + 0.8 * sfMv);
  }
`;

const SPOTS_APPLY = /* glsl */ `
  sfAlb = mix(sfAlb, sfAlb * sfSpotA, sfSpot);
  sfRough = mix(sfRough, sfSpots.w, sfSpot);
`;

const MAP_END = /* glsl */ `
  sfMicroAO = mix(1.0, sfS.a, sfMisc.w * sfAOScale);
  diffuseColor.rgb *= sfAlb;
`;

function mapChunk(f) {
  let s = f.layout ? mapLayout(f) : f.detail ? MAP_FOOT : MAP_PLAIN;
  if (f.detail) s += mapDetail(f);
  s += MAP_MACRO;
  if (f.lanes) s += mapLanes(f.laneAttr);
  if (f.weather) s += MAP_WEATHER;
  if (f.spots) s += SPOTS_APPLY;
  return s + MAP_END;
}

// paint coverage mask: chips show the baked undercoat / bare wood, not the paint colour
// (runs after the vertex colours are applied)
const PAINT = /* glsl */ `
  if (sfFlags.z > 0.5) diffuseColor.rgb = mix(sfAlb, diffuseColor.rgb, sfS.b);
`;

const ROUGH = /* glsl */ `
  float roughnessFactor = clamp(roughness * sfRough, 0.0, 1.0);
`;

const METAL = /* glsl */ `
  float metalnessFactor = metalness * mix(1.0, sfS.b, sfFlags.x);
`;

const NORMAL_DETAIL = /* glsl */ `
  if (sfDetail.x > 0.0) {
    vec2 sfDn = (sfD.rg * 2.0 - 1.0) * sfDR;   // back from the rotated detail frame
    float sfDv = sfDw > 0.0 ? max(sfD.b - dot(sfDn, sfDn) - 0.004, 0.0) : 0.0;
    sfVar += (sfDv + (1.0 - sfDw) * sfDetail2.w) * sfDetail.y * sfDetail.y;
    sfN += sfDn * sfDetail.y;
  }
`;

const normalChunk = (f) => /* glsl */ `
  vec2 sfN = (sfS.rg * 2.0 - 1.0)${f.layout ? ' * sfFl' : ''};
  float sfVar = max(sfS.b - dot(sfN, sfN) - 0.004, 0.0) * (1.0 - max(sfFlags.x, sfFlags.z));
${f.detail ? NORMAL_DETAIL : ''}  if (sfFlags.y > 0.5) sfN = sfN.yx;
  sfN *= normalScale * sfMisc.x;
  sfVar *= sfMisc.x * sfMisc.x * normalScale.x * normalScale.x;
  normal = normalize(tbn * vec3(sfN, sqrt(max(1.0 - dot(sfN, sfN), 0.0))));
  // specular anti-aliasing: normal variance hidden in the mips, plus the screen-space
  // variance of the interpolated normal (curvature under a pixel: rail heads, poles,
  // rounded arrises), widen the lobe (alpha² += variance, Kaplanyan-style), so no curved
  // surface can leave a sharp mirror line
  #ifdef FLAT_SHADED
    float sfGv = 0.0;
  #else
    vec3 sfGn = normalize(vNormal);
    vec3 sfGnx = dFdx(sfGn), sfGny = dFdy(sfGn);
    float sfGv = min(0.5 * (dot(sfGnx, sfGnx) + dot(sfGny, sfGny)), 0.18);
  #endif
  float sfA2 = roughnessFactor * roughnessFactor;
  roughnessFactor = min(sqrt(sqrt(sfA2 * sfA2 + sfMisc.z * sfVar + sfGv)), 1.0);
`;

const AO = /* glsl */ `
  float ambientOcclusion = mix(1.0, sfS.a, sfMisc.y * sfAOScale);
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float sfDotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( sfDotNV, ambientOcclusion, material.roughness ) * sfEnvI;
  #endif
`;

// direct light: micro-shadowing from the baked cavity AO, plus thin-surface translucency
const lightPars = (f) => /* glsl */ `
void RE_Direct_Surf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  IncidentLight sfL = directLight;
  float sfNL = dot( geometryNormal, directLight.direction );
  ${f.surf ? 'sfL.color *= saturate( abs( sfNL ) + 2.0 * sfMicroAO * sfMicroAO - 1.0 );' : ''}
  ${f.pom ? 'if ( dot( directLight.direction, sfSunV ) > 0.995 ) sfL.color *= sfPomSh;' : ''}
  RE_Direct_Physical( sfL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  ${f.trans ? 'reflectedLight.directDiffuse += saturate( - sfNL ) * directLight.color * BRDF_Lambert( material.diffuseContribution ) * sfTrans;' : ''}
}
#undef RE_Direct
#define RE_Direct RE_Direct_Surf
`;

// night emissive; lamp glass glows brighter where we look through the diffuser at the
// lamp and falls off towards the silhouette
const EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance *= sfEmGain * smoothstep( 0.02, 0.85, sfNight );
if ( sfEmis.x > 0.0 ) {
  float sfRim = pow( saturate( dot( normal, normalize( vViewPosition ) ) ), sfEmis.y );
  totalEmissiveRadiance *= mix( 1.0 - sfEmis.x, 1.0, sfRim );
}
`;

const OPAQUE_GLASS = /* glsl */ `
  float sfNV = saturate( dot( normal, normalize( vViewPosition ) ) );
  float sfFr = 0.04 + 0.96 * pow( 1.0 - sfNV, 5.0 );
  gl_FragColor = vec4( totalSpecular + totalDiffuse * diffuseColor.a + totalEmissiveRadiance, clamp( diffuseColor.a + ( 1.0 - diffuseColor.a ) * sfFr, 0.0, 1.0 ) );
`;

function fragPars(f) {
  let s = '\nfloat sfMicroAO = 1.0;\n';
  if (f.trans) s += 'uniform vec3 sfTrans;    // diffuse transmission colour (fraction of back-lit irradiance)\n';
  if (f.night) s += 'uniform float sfNight;   // = U.uNight\nuniform float sfEmGain;  // global emissive gain\nuniform vec4 sfEmis;     // rim falloff (0 = flat), rim exponent\n';
  if (f.surf) s += SURF_PARS;
  if (f.layout) s += LAYOUT_PARS;
  if (f.pom) s += POM_PARS;
  if (f.detail) s += DETAIL_PARS;
  if (f.weather) s += WEATHER_PARS;
  if (f.lanes) s += LANES_PARS + (f.laneAttr ? 'varying float vSfLaneD;\n' : '');
  return s;
}

function patchFragment(src, f) {
  let s = src.replace('#include <common>', '#include <common>\n' + fragPars(f));
  if (f.surf) {
    s = s
      .replace('#include <map_fragment>', mapChunk(f))
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + PAINT)
      .replace('#include <roughnessmap_fragment>', ROUGH)
      .replace('#include <metalnessmap_fragment>', METAL)
      .replace('#include <normal_fragment_maps>', normalChunk(f))
      .replace('#include <aomap_fragment>', AO);
  }
  if (f.surf || f.trans) s = s.replace('#include <lights_physical_pars_fragment>', '#include <lights_physical_pars_fragment>\n' + lightPars(f));
  if (f.night) s = s.replace('#include <emissivemap_fragment>', EMISSIVE);
  if (f.glass) s = s.replace('#include <opaque_fragment>', OPAQUE_GLASS).replace('#include <premultiplied_alpha_fragment>', '');
  return s;
}

function patchVertex(src, f) {
  if (!f.weather && !f.laneAttr) return src;
  const pars = (f.weather ? 'varying vec3 vSfWorld;\n' : '') + (f.laneAttr ? 'attribute float aLaneD;\nvarying float vSfLaneD;\n' : '');
  const world = /* glsl */ `
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
`;
  return src
    .replace('#include <common>', '#include <common>\n' + pars)
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + (f.weather ? world : '') + (f.laneAttr ? '  vSfLaneD = aLaneD;\n' : ''));
}

// feature families: materials drawn with the same three.js variant share a program
// when they share a family, so families are few and broad
export const FAMILY = {
  lite: '',
  full: 'LJPDRWK',
  relief: 'LDRWH',
};

/** Feature family of a library definition: explicit `fx`, else from what it uses. */
export function familyOf(def, recipe) {
  if (def.fx) return def.fx;
  const s = def.surf || {};
  return recipe?.layout || s.detail || s.weather || s.lanes ? 'full' : 'lite';
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
 *   cfg     library `surf` settings, def = library definition
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
    sfFlags: { value: v4([r?.mask === 'metal' ? 1 : 0, cfg.swap ? 1 : 0, r?.mask === 'paint' ? 1 : 0, 0]) },
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
    sfSpots2: { value: v4([shared.macro ? sp.cluster?.freq ?? 0 : 0, sp.cluster?.lo ?? 0.5, sp.cluster?.hi ?? 0.62, sp.laneClear ?? 0]) },
    sfCell2: { value: v4([shared.macro ? c.corr ?? 0 : 0, c.corrHue ?? 0, shared.macro ? c.corrFreq ?? 0 : 0, 0]) },
    sfStain: { value: v4([shared.macro ? st.amount ?? 0 : 0, st.freq ?? 0.3, st.threshold ?? 0.7, st.stretch ?? 1]) },
    sfJoint: { value: v4([cfg.jointHide ?? (r?.joint ? 0.4 : 0), (r?.joint ?? 0) * sc, 0, 0]) },
    sfMirror: { value: L ? cfg.mirror ?? 0 : 0 },
    sfWeather: { value: v4(shared.macro ? [w.ledge ?? 0, w.streak ?? 0, w.threshold ?? 0.62, w.soffit ?? 0] : [0, 0, 0, 0]) },
    sfLanes: { value: v4(shared.macro ? [ln.track ?? 1.6, ln.rail ?? 0.7455, ln.grime ?? 0, ln.wear ?? 0] : [0, 0, 0, 0]) },
    sfLanes2: { value: v4([...(ln.grimeBand || [0.05, 0.24]), ...(ln.laneBand || [0.18, 0.42])]) },
    sfDetailTex: { value: detailTex || null },
    sfToolTex: { value: toolTex || detailTex || null },
    sfMacroTex: { value: shared.macro || null },
    sfOne: { value: 1 },
    sfPom: { value: v4(r?.heightA && cfg.relief ? [r.heightA[0], r.heightA[1] - r.heightA[0], cfg.relief.near ?? 20, cfg.relief.far ?? 35] : [0, 0, 1, 2]) },
    sfPom2: { value: v4([cfg.relief?.steps?.[0] ?? 12, cfg.relief?.steps?.[1] ?? 24, cfg.relief?.shadowSteps ?? 10, cfg.relief?.shadow ?? 1]) },
    sfSunDir: shared.sunDir || { value: new THREE.Vector3(0, 1, 0) },
  };
}

// surface config per patched material (kept out of userData, which clone() JSON-copies)
export const surfaceOf = new WeakMap();

/**
 * Install the surface patch on a material (library materials, variants and clones).
 *   sf = {textures, uniforms, family (FAMILY key), trans, night, glass}
 * The patch is self-contained: `onBeforeCompile` decides from the material it is called
 * on (`this`) whether the baked maps are attached and which features apply, so a module
 * that copies our onBeforeCompile onto its own material (and chains its own patch) gets
 * the correct shading, and plain clone() keeps the patch too.
 */
export function applySurface(mat, sf) {
  surfaceOf.set(mat, sf);
  if (sf.textures) {
    mat.map = sf.textures.albedo;
    mat.normalMap = sf.textures.surface;
  }
  const fam = FAMILY[sf.family] || '';
  const features = (m) => {
    const surf = !!(sf.textures && m && m.map === sf.textures.albedo && m.normalMap === sf.textures.surface);
    const has = (c) => surf && fam.includes(c);
    const layout = has('L'), detail = has('D'), lanes = has('K');
    const f = {
      surf, layout, detail, lanes, joint: layout && has('J'), spots: layout && has('P'), dress: layout && detail && has('R'), weather: has('W'),
      pom: layout && has('H'),
      laneAttr: lanes && !!m.laneAttr, trans: !!sf.trans, night: !!sf.night, glass: surf && !!sf.glass,
    };
    f.key = 'sf7' + (surf ? 'S' + fam : '') + (f.laneAttr ? 'A' : '') + (f.trans ? 'T' : '') + (f.night ? 'N' : '') + (f.glass ? 'G' : '');
    return f;
  };
  mat.onBeforeCompile = function (shader) {
    const self = this || mat;
    const f = features(self);
    Object.assign(shader.uniforms, sf.uniforms);
    // per material (variants and clones keep their own envMapIntensity)
    shader.uniforms.sfEnvI = { get value() { return self.envMapIntensity; } };
    shader.fragmentShader = patchFragment(shader.fragmentShader, f);
    shader.vertexShader = patchVertex(shader.vertexShader, f);
  };
  mat.customProgramCacheKey = function () { return features(this || mat).key; };
  mat.clone = function () {
    const c = Object.getPrototypeOf(this).clone.call(this);
    applySurface(c, sf);
    return c;
  };
  mat.needsUpdate = true;
  return mat;
}
