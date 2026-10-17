import * as THREE from 'three';
import { MORTAR_ALBEDO } from './constants.js';

// Street-owned shading pieces:
//  - the mortar bed along the rails (hand-trowelled cement / bitumen mix): a smooth dark
//    band with lighter cement patches and trowel streaks along the rail, no aggregate;
//  - street-canyon specular occlusion for the rail steel. The sky environment map knows
//    nothing about the buildings, so a polished rail would reflect open sky in every
//    direction and glow even in shade or at dusk. The canyon is modelled analytically:
//    a reflected ray sees sky only if it clears the facade tops, i.e. if
//    tan(elevation) > H / W · |sin(azimuth from the street axis)|; otherwise it sees
//    facades and paving, which are much darker than the sky they replace.

/** Shared canyon uniform: x = distance to the facades (m), y = facade height (m),
 *  z = radiance of the occluded directions relative to the sky they hide. */
export const CANYON = { uStCanyon: { value: new THREE.Vector3(10, 17, 0.38) } };

const NOISE = /* glsl */`
float stHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float stNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( stHash( i ), stHash( i + vec2( 1, 0 ) ), u.x ), mix( stHash( i + vec2( 0, 1 ) ), stHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}
`;

// view-space canyon visibility of the reflected direction; stLat = lateral street axis
const CANYON_FN = /* glsl */`
uniform vec3 uStCanyon;
float stCanyonVis( vec3 n, vec3 v, vec3 stLat, float rough ) {
  vec3 up = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  vec3 r = reflect( -v, n );
  float t = dot( r, up ) - uStCanyon.y / uStCanyon.x * abs( dot( r, stLat ) );
  float w = 0.035 + 0.5 * rough * rough;
  return smoothstep( -w, w, t );
}
`;

const CANYON_APPLY = (lat) => /* glsl */`
#include <lights_fragment_maps>
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
{
  ${lat}
  float stVis = stCanyonVis( geometryNormal, geometryViewDir, stLatV, material.roughness );
  // occluded directions see sunlit / shaded limestone and paving instead of sky
  radiance *= mix( uStCanyon.z * vec3( 1.06, 1.0, 0.9 ), vec3( 1.0 ), stVis );
}
#endif
`;

/**
 * Add canyon occlusion to a material.
 * mode 'uv':   the street axis is the direction of increasing uv.x (route s / along the
 *              rail), found from screen-space derivatives (swept rails, inlays);
 * mode 'line': the line ribbon shader provides the world lateral vector vLineRightW.
 */
export function patchCanyon(m, mode = 'uv') {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    sh.uniforms.uStCanyon = CANYON.uStCanyon;
    let lat;
    if (mode === 'uv') {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vStUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvStUv = uv;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vStUv;');
      lat = /* glsl */`
  vec3 stQ0 = dFdx( -vViewPosition ), stQ1 = dFdy( -vViewPosition );
  float stU0 = dFdx( vStUv.x ), stU1 = dFdy( vStUv.x );
  vec3 stN = normalize( vNormal );
  vec3 stAlong = cross( stQ1, stN ) * stU0 + cross( stN, stQ0 ) * stU1;
  vec3 stUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  vec3 stLatV = normalize( cross( stAlong, stUp ) + 1e-7 );`;
    } else {
      lat = 'vec3 stLatV = normalize( ( viewMatrix * vec4( vLineRightW, 0.0 ) ).xyz );';
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${CANYON_FN}`)
      .replace('#include <lights_fragment_maps>', CANYON_APPLY(lat));
  };
  m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + `|stCanyon-${mode}`; };
  m.needsUpdate = true;
  return m;
}

/** Mortar bed along the rails (and bitumen seals at SEAL_TONE via vertex colour).
 *  UVs: u along the rail (m), v across (m). */
export function createMortarMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.color.setRGB(MORTAR_ALBEDO[0], MORTAR_ALBEDO[1], MORTAR_ALBEDO[2], THREE.LinearSRGBColorSpace);
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
  // trowel streaks along the strip and fine pores, faded once unresolved
  float kTr = 1.0 - smoothstep( 0.004, 0.014, fw );
  float kFi = 1.0 - smoothstep( 0.0015, 0.005, fw );
  float tr = ( stNoise( vec2( p.x * 7.0, p.y * 120.0 ) ) - 0.5 ) * kTr;
  float fi = ( stNoise( p * 260.0 ) - 0.5 ) * kFi;
  float tone = stNoise( vec2( p.x * 0.35, p.y * 2.0 ) + 5.0 ) - 0.5;
  diffuseColor.rgb *= ( 1.0 + 0.32 * lighter ) * ( 1.0 + 0.16 * tone ) * ( 1.0 + 0.12 * tr ) * ( 1.0 + 0.2 * fi );
  stMR = 1.0 - 0.07 * lighter + 0.06 * fi;
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= stMR;');
  };
  m.customProgramCacheKey = () => 'street-mortar-1';
  return m;
}
