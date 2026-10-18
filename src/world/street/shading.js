import * as THREE from 'three';
import { MORTAR_ALBEDO } from './constants.js';

// Street-owned shading pieces:
//  - the mortar bed along the rails (hand-trowelled cement): a narrow dirty grey strip
//    with fbm dirt mottling, lighter cement patches and trowel streaks along the rail;
//  - grit in the rail grooves: the flangeway floor is filled with grey-brown grit, sand
//    and leaf debris (patchy, damp in places) instead of a uniform black slot;
//  - the sheen of the rail steel: wheels polish the running band lengthwise, so its
//    reflection lobe is a cone around the rail axis (see patchRailSheen).

/** Shared rail-sheen uniform: x = how far the lengthwise polish bends the reflection
 *  lookup towards the top of its cone (0..1), y = environment reflection strength of
 *  the steel in the far-field line overlay (lines.js). Both are matched to the
 *  photographs: in shade the running band reads 1.1-1.3x the setts beside it, the
 *  flangeway a dark slot. */
export const SHEEN = { uStSheen: { value: new THREE.Vector2(0.7, 1.45) } };
/** envMapIntensity of the 3D rail.head variants (the resolved head; its texture band is
 *  wider and its normals crowned, so it needs less than the overlay's pre-filtered
 *  bands to read the same). */
export const RAIL_HEAD_ENV = 0.55;

const NOISE = /* glsl */`
float stHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float stNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( stHash( i ), stHash( i + vec2( 1, 0 ) ), u.x ), mix( stHash( i + vec2( 0, 1 ) ), stHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}
`;

// Lengthwise polish. The wheels leave the running band streaked along the rail: its
// micro-facets tilt about the rail axis t, and a facet rotated by phi about t turns the
// mirror direction by 2 phi about t, so the reflection lobe is spread round a cone of
// constant angle to the rail (the view's angle to it) instead of round the mirror
// direction. From a street view that cone is shallow and always passes through its top,
// the direction straight down the rail a few degrees above the horizon: the open sky
// slot at the end of the street, even for a rail seen well off to the side whose mirror
// direction runs into the facades (which is why every head in the photographs carries a
// light sheen in shade, while the paving beside it does not). The lookup is bent
// towards that top in proportion to the polish and to how level the face is (the head
// and lip tops; not the gauge or field faces), with the narrower spread of the lobe
// along the rail. The environment map already holds the street canyon (facades and
// paving round the sky slot), so nothing is occluded here.
const SHEEN_APPLY = (along) => /* glsl */`
#include <lights_fragment_maps>
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular ) && defined( ENVMAP_TYPE_CUBE_UV )
{
  vec3 stUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  ${along}
  vec3 stR = reflect( -geometryViewDir, geometryNormal );
  float stRt = dot( stR, stT );
  vec3 stUpT = normalize( stUp - stT * dot( stUp, stT ) );
  vec3 stTop = stT * stRt + stUpT * sqrt( max( 1.0 - stRt * stRt, 0.0 ) );
  float stK = uStSheen.x * stOk * smoothstep( 0.6, 0.9, dot( geometryNormal, stUp ) );
  vec3 stRb = normalize( mix( stR, stTop, stK ) );
  // the polish is smooth along the rail, rough across it: the lobe's spread round the
  // cone is the bend above; along the rail it is narrower than the mean roughness
  radiance = getIBLRadiance( geometryViewDir, normalize( geometryViewDir + stRb ), material.roughness * ( 1.0 - 0.5 * stK ) );
}
#endif
`;

/**
 * Lengthwise-polish sheen for rail steel.
 * mode 'uv':   the rail axis is the direction of increasing uv.x (along the rail),
 *              found from screen-space derivatives (swept rails);
 * mode 'line': the line ribbon shader provides the world lateral vector vLineRightW.
 */
export function patchRailSheen(m, mode = 'uv') {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    sh.uniforms.uStSheen = SHEEN.uStSheen;
    let along;
    if (mode === 'uv') {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vStUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStUv = uv;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vStUv;');
      along = /* glsl */`
  vec3 stQ0 = dFdx( -vViewPosition ), stQ1 = dFdy( -vViewPosition );
  float stU0 = dFdx( vStUv.x ), stU1 = dFdy( vStUv.x );
  vec3 stN = normalize( vNormal );
  vec3 stAlong = cross( stQ1, stN ) * stU0 + cross( stN, stQ0 ) * stU1;
  float stL = length( stAlong );
  float stOk = stL > 1e-30 ? 1.0 : 0.0;
  vec3 stT = stOk > 0.5 ? stAlong / stL : vec3( 0.0, 0.0, 1.0 );`;
    } else {
      along = /* glsl */`
  vec3 stT = normalize( cross( stUp, ( viewMatrix * vec4( vLineRightW, 0.0 ) ).xyz ) );
  float stOk = 1.0;`;
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uStSheen;')
      .replace('#include <lights_fragment_maps>', SHEEN_APPLY(along));
  };
  m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + `|stSheen-${mode}`; };
  m.needsUpdate = true;
  return m;
}

/**
 * Crossover cuts. Where rails cross or split (frogs, switch boxes) each surface carries a
 * per-vertex attribute aStCut and discards the fragments that lie inside another rail's
 * opening, so flangeways run through heads and tongues lie in grooves with true depth:
 *   mode 'rail': (x, lo, hi, f): x = lateral coordinate in the other rail's frame, cut
 *                when lo < x < hi; f = 1 inside an interaction range (0 disables, so
 *                quads leaving a range never interpolate a stray cut);
 *   mode 'pave': (x1, lo, hi, x2): paving cut by either diverging rail's span.
 * The variant gets userData.stCut so BufSet allocates the attribute. With
 * attribute = false the material gets the same program but no attribute: the default
 * value (all zero) never cuts, so plain meshes share the program of the cut variant.
 */
export function patchCut(m, mode, attribute = true) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  if (attribute) m.userData.stCut = mode;
  else m.defaultAttributeValues = { ...(m.defaultAttributeValues || {}), aStCut: [0, 0, 0, 0] };
  const test = mode === 'pave'
    ? 'if ( ( vStCut.x > vStCut.y && vStCut.x < vStCut.z ) || ( vStCut.w > vStCut.y && vStCut.w < vStCut.z ) ) discard;'
    : 'if ( vStCut.w > 0.999 && vStCut.x > vStCut.y && vStCut.x < vStCut.z ) discard;';
  m.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aStCut;\nvarying vec4 vStCut;')
      .replace(/void\s+main\s*\(\s*\)\s*\{/, (s) => `${s}\n  vStCut = aStCut;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vStCut;')
      .replace(/void\s+main\s*\(\s*\)\s*\{/, (s) => `${s}\n  ${test}`);
  };
  m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + `|stCut-${mode}`; };
  m.needsUpdate = true;
  return m;
}

/** Mortar bed along the rails (and bitumen seals at SEAL_TONE via vertex colour).
 *  UVs: u along the rail (m), v across (m). albedo: linear (constants.js pavingTones). */
export function createMortarMaterial(albedo = MORTAR_ALBEDO) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.color.setRGB(albedo[0], albedo[1], albedo[2], THREE.LinearSRGBColorSpace);
  m.name = 'street.mortar';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vStUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vStUv;\n${NOISE}`)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
float stMR = 1.0;
{
  vec2 p = vStUv;
  float fw = max( length( fwidth( p ) ), 1e-5 );
  // lighter cement patches 0.3-1 m long, stretched along the rail
  float pa = stNoise( vec2( p.x * 1.4, p.y * 6.0 ) + 11.0 ) * 0.65 + stNoise( vec2( p.x * 3.7, p.y * 13.0 ) + 3.0 ) * 0.35;
  float lighter = smoothstep( 0.6, 0.76, pa );
  // dirt worked into it: fbm mottling, darker stretches where grit and water collect
  float df = stNoise( vec2( p.x * 0.8, p.y * 4.0 ) + 21.0 ) * 0.5 + stNoise( vec2( p.x * 2.9, p.y * 14.0 ) + 2.0 ) * 0.3
           + stNoise( vec2( p.x * 9.0, p.y * 40.0 ) + 8.0 ) * 0.2;
  float dirt = smoothstep( 0.38, 0.78, df );
  // trowel streaks along the strip and fine pores, faded once unresolved
  float kTr = 1.0 - smoothstep( 0.004, 0.014, fw );
  float kFi = 1.0 - smoothstep( 0.0015, 0.005, fw );
  vec2 pw = vec2( mod( p.x, 64.0 ), p.y );    // fine octaves: keep the float precision
  float tr = ( stNoise( vec2( pw.x * 7.0, pw.y * 120.0 ) ) - 0.5 ) * kTr;
  float fi = ( stNoise( pw * 260.0 ) - 0.5 ) * kFi;
  float tone = stNoise( vec2( p.x * 0.35, p.y * 2.0 ) + 5.0 ) - 0.5;
  diffuseColor.rgb *= ( 1.0 + 0.16 * lighter ) * ( 1.0 + 0.14 * tone ) * ( 1.0 + 0.12 * tr ) * ( 1.0 + 0.2 * fi );
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.66, 0.62, 0.57 ), dirt );
  stMR = 1.0 - 0.07 * lighter + 0.06 * fi;
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= stMR;');
  };
  m.customProgramCacheKey = () => 'street-mortar-2';
  return m;
}

// Grit fill of the flangeway: where the groove surface faces up (its floor and the foot
// of its walls) the grime of rail.groove gives way to grey-brown grit and sand with leaf
// fragments, patchy along the rail (packed and damp, loose and pale, swept out by the
// flanges in places). Albedo ~0.02-0.045, mean ~0.03, and the floor's cavity AO (0.25:
// it sees a sliver of sky and, mostly, no sun) folds in to an effective ~0.015-0.02, so
// the flangeway reads as the dark slot of the photographs, ~0.1x the setts.
// Cavity specular occlusion: the slot's walls hide the sky its floor and walls would
// reflect at grazing angles (a plain dielectric goes mirror-like there and the groove
// turned into a pale band of reflected sky), so F0 and F90 scale with the cavity AO.
// UVs: u along the rail (m), v across the profile (m).
const GRIT = /* glsl */`
{
  vec3 stNw = normalize( ( vec4( vNormal, 0.0 ) * viewMatrix ).xyz );
  stGrit = smoothstep( 0.45, 0.85, stNw.y );
  vec2 p = vStGritUv;
  float fw = max( length( fwidth( p ) ), 1e-5 );
  float kFi = 1.0 - smoothstep( 0.002, 0.007, fw );
  float pa = stNoise( vec2( p.x * 2.1, p.y * 18.0 ) + 7.0 ) * 0.6 + stNoise( vec2( p.x * 6.3, p.y * 40.0 ) + 1.0 ) * 0.4;
  // sand grains and small stones: two rotated octaves, so no lattice shows
  vec2 pw = vec2( mod( p.x, 64.0 ), p.y );    // fine octaves: keep the float precision
  vec2 q1 = mat2( 0.8, 0.6, -0.6, 0.8 ) * pw * 310.0, q2 = mat2( 0.47, -0.88, 0.88, 0.47 ) * pw * 170.0 + 3.1;
  float grain = mix( 0.5, stNoise( q1 ) * 0.55 + stNoise( q2 ) * 0.45, kFi );
  float stone = kFi * smoothstep( 0.68, 0.8, stNoise( q2 * 0.55 + 9.0 ) );
  vec3 g = vec3( 0.04, 0.0365, 0.0305 ) * ( 0.6 + 0.8 * pa ) * ( 0.7 + 0.6 * grain ) * ( 1.0 + 0.35 * stone );
  // pale dry sand drifts and dark damp stretches
  float sand = smoothstep( 0.62, 0.82, stNoise( vec2( p.x * 0.9, 2.3 ) + 4.0 ) );
  float damp = smoothstep( 0.6, 0.85, stNoise( vec2( p.x * 0.45, 5.1 ) + 13.0 ) );
  g = mix( g, vec3( 0.056, 0.052, 0.043 ) * ( 0.85 + 0.3 * grain ), 0.6 * sand ) * ( 1.0 - 0.38 * damp );
  // leaf fragments caught in the slot: a few centimetres each, in loose clusters
  float lc = smoothstep( 0.55, 0.8, stNoise( vec2( p.x * 1.7, 0.5 ) + 41.0 ) );
  float leaf = lc * smoothstep( 0.7, 0.82, stNoise( vec2( pw.x * 24.0, pw.y * 70.0 ) + 31.0 ) );
  g = mix( g, vec3( 0.06, 0.041, 0.024 ) * ( 0.8 + 0.4 * grain ), 0.8 * leaf );
  #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
    g *= mix( 0.65, 1.0, smoothstep( 0.2, 0.6, vColor.g ) );
  #endif
  diffuseColor.rgb = mix( diffuseColor.rgb, g, stGrit );
  stGritR = mix( 0.97, 0.7, damp ) - 0.08 * leaf;
}
`;

// value noise on an integer hash (no sin(): stays random at large coordinates)
const GNOISE = /* glsl */`
float stGHash( vec2 p ) {
  uvec2 q = uvec2( ivec2( p ) ) * uvec2( 1597334673u, 3812015801u );
  uint n = ( q.x ^ q.y ) * 1597334673u;
  return float( n >> 8 ) * ( 1.0 / 16777216.0 );
}
float stGNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( stGHash( i ), stGHash( i + vec2( 1, 0 ) ), u.x ), mix( stGHash( i + vec2( 0, 1 ) ), stGHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}
`;

/** Patch a rail.groove variant with the grit fill (chains any existing hook). k scales
 *  the grit's tone with the setts' (constants.js pavingTones). */
export function patchGrit(m, k = 1) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vStGritUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStGritUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vStGritUv;\n${GNOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\nfloat stGrit = 0.0, stGritR = 1.0;\n${GRIT.replace(/stNoise/g, 'stGNoise').replace('diffuseColor.rgb = mix( diffuseColor.rgb, g, stGrit );', `diffuseColor.rgb = mix( diffuseColor.rgb, g * ${k.toFixed(4)}, stGrit );`)}`)
      .replace('#include <normal_fragment_begin>', 'roughnessFactor = mix( roughnessFactor, stGritR, stGrit );\nmetalnessFactor *= 1.0 - stGrit;\n#include <normal_fragment_begin>')
      .replace('#include <lights_physical_fragment>', /* glsl */`#include <lights_physical_fragment>
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
{
  // cavity specular occlusion (vertex colour = cavity AO: lip / gauge edge 0.6-0.9, walls
  // 0.3-0.6, floor 0.25)
  float stSO = smoothstep( 0.15, 1.0, vColor.g );
  material.specularColorBlended *= stSO;
  material.specularF90 *= stSO;
}
#endif`);
  };
  m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + `|stGrit2-${k.toFixed(4)}`; };
  m.needsUpdate = true;
  return m;
}
