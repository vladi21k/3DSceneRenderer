import * as THREE from 'three';
import { U } from '../../core/uniforms.js';

// Materials of the line's trams (trams/model.js parts), tracked by the material library so
// lighting configures them like everything else.
//
//  - body: metallic silver paint under a clear coat. The vertex colour is the paint colour;
//    dark vertex colours (skirt, bellows, seals, door seams, carbon strips) are plain
//    dielectric trim, so only the silver panels turn metallic.
//  - glass / ws: flush side glazing, a smooth dielectric with a little more reflectance
//    than one surface (laminated / double panes) over the interior seen through the tint
//    (the material colour). Vertex colour black = black frit over the pillars and frames;
//    the upper panes glow with the saloon lighting at dusk (glass only).
//  - front / frontTrail: the cab front glass, uv = (u share of the half width, height in m).
//    Drawn per pixel: the windscreen in a rounded U (coated laminated glass, F0 ≈ 0.25, so
//    the street canyon and the sky mirror in it over the cab, which is ray traced behind
//    the glass in the body frame: console and binnacle, the driver in the leading cab,
//    overhead console, walls, side windows onto the street, the saloon door), a thin
//    silver trim round it, the dark tinted mask (cheeks and the foot where the lamps sit)
//    outside it.
//  - metal: the pantograph frame (dark grey paint).

const C = (r, g, b) => new THREE.Color(r, g, b);

/** Windscreen outline in the front glass's uv space (GLSL): signed distance in metres,
 *  negative inside. The U narrows from ~1.85 m wide under the display band to a rounded
 *  bottom 1.1 m above the rail. */
const WS_GLSL = /* glsl */ `
float tramWsDist( vec2 p ) {
  vec2 q = vec2( abs( p.x ) * 1.28, p.y );
  // side edge through (0.6, 1.1) and (0.93, 2.6), outward normal towards +x / -y
  vec2 n = normalize( vec2( 1.5, -0.33 ) );
  float dA = dot( q - vec2( 0.6, 1.1 ), n );
  float dB = 1.1 - q.y;
  float r = 0.3;
  vec2 k = vec2( dA, dB ) + r;
  return length( max( k, 0.0 ) ) + min( max( k.x, k.y ), 0.0 ) - r;
}
`;

/** Metallic silver paint with a clear coat; dark vertex colours stay dielectric trim. */
export function makeBodyMaterial() {
  const m = new THREE.MeshPhysicalMaterial({
    name: 'trams.body', color: C(1, 1, 1), vertexColors: true,
    metalness: 0.7, roughness: 0.3, clearcoat: 0.55, clearcoatRoughness: 0.07,
  });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
	// silver paint (bright vertex colours) vs dark trim
	float tramPaint = smoothstep( 0.08, 0.3, max( vColor.r, max( vColor.g, vColor.b ) ) );
	roughnessFactor = mix( 0.5, roughnessFactor, tramPaint );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
	metalnessFactor *= tramPaint;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	material.clearcoat *= tramPaint;`);
  };
  m.customProgramCacheKey = () => 'trams.body.v2';
  return m;
}

/** Side glazing over the interior colour; `glow` panes light up at dusk (emissive gated
 *  by the vertex colour so the black frit stays dark). */
export function makeGlassMaterial(name, interior, glow = false) {
  const m = new THREE.MeshPhysicalMaterial({
    name, color: interior, vertexColors: true, metalness: 0, roughness: 0.045, ior: 1.65,
    emissive: glow ? C(1.0, 0.96, 0.9) : C(0, 0, 0), emissiveIntensity: 0,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTramUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvTramUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTramUv;')
      // saloon lighting (uv: x = m along the car, y = m up the side profile from the body's
      // lower edge, about the height above the rail less 0.13 m): the lit
      // ceiling shows brightest at the top of the panes, standing passengers and seat rows
      // break the light up along the car; the frit stays dark
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
	{
		float gy = vTramUv.y, gx = vTramUv.x / 0.55;
		float h0 = fract( sin( floor( gx ) * 12.9898 + 4.1 ) * 43758.5453 );
		float h1 = fract( sin( ( floor( gx ) + 1.0 ) * 12.9898 + 4.1 ) * 43758.5453 );
		float crowd = mix( h0, h1, smoothstep( 0.0, 1.0, fract( gx ) ) );
		float body = smoothstep( 0.85, 1.1, gy ) * ( 1.0 - smoothstep( 1.75, 1.95, gy ) );
		float lit = ( 0.42 + 0.58 * smoothstep( 1.55, 2.15, gy ) ) * mix( 1.0, 0.4 + 0.45 * crowd, body );
		totalEmissiveRadiance *= vColor.g * lit;
	}`)
      // the environment cube's street is bare stone: no trees, poles, people, shade or
      // traffic. What a side pane mirrors at and below the horizon (the street, the shop
      // fronts opposite) is darker and less saturated than those bare sunlit facades
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
	{
		vec3 tramR = transformDirectionByInverseViewMatrix( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
		float tramSky = smoothstep( 0.05, 0.45, tramR.y );
		vec3 tramStreet = mix( radiance, vec3( dot( radiance, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.35 ) * 0.5;
		radiance = mix( tramStreet, radiance, tramSky );
	}`);
  };
  m.customProgramCacheKey = () => 'trams.glass.v5';
  return m;
}

/** The cab seen through the windscreen, traced per pixel in the body frame (x right, y up
 *  from the rail, −z forward; the glass lies at z ≈ 0–0.5): a dark console across the cab
 *  with the driver's binnacle in the middle, the driver (leading cab only) on a dark seat,
 *  grey walls and a dim ceiling, the cab's side windows showing the street (environment)
 *  and the door to the saloon in the back wall. Every edge is softened over the pixel
 *  footprint `w` (m), so nothing shimmers far away. E = the cab's irradiance / π. */
const CAB_GLSL = /* glsl */ `
uniform float uTramDriver;
uniform float uTramNight;
uniform float uTramGain;
float tramRect( vec2 p, vec2 lo, vec2 hi, float w ) {
  vec2 d = min( p - lo, hi - p );
  return smoothstep( - w, w, min( d.x, d.y ) );
}
// ray vs ellipsoid (centre c, radii r): soft coverage and the normal where it is hit
float tramEll( vec3 ro, vec3 rd, vec3 c, vec3 r, float w, out vec3 n ) {
  vec3 o = ( ro - c ) / r, d = rd / r;
  float a = dot( d, d ), tc = - dot( o, d ) / a;
  float m = length( o + d * tc );
  float t = tc - sqrt( max( 1.0 - m * m, 0.0 ) / a );
  n = normalize( ( o + d * t ) / r );
  return smoothstep( - w, w, ( 1.0 - m ) * min( r.x, r.y ) ) * step( 0.0, t );
}
vec3 tramEnv( vec3 dirW ) {
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  return textureCubeUV( envMap, envMapRotation * dirW, 0.1 ).rgb * envMapIntensity;
#else
  return vec3( 0.0 );
#endif
}
// light falls in through the windscreen (ahead and above) and the side windows
float tramShade( vec3 n ) { return 0.3 + 0.7 * max( dot( n, vec3( 0.0, 0.48, - 0.88 ) ), 0.0 ) + 0.2 * abs( n.x ); }
vec3 tramCab( vec3 ro, vec3 rd, vec3 rdW, float w, vec3 E ) {
  rd.z = max( rd.z, 1e-3 );
  vec3 ard = max( abs( rd ), vec3( 1e-4 ) );
  float tx = ( 1.22 - sign( rd.x ) * ro.x ) / ard.x;
  float ty = ( rd.y < 0.0 ? ro.y - 0.6 : 2.5 - ro.y ) / ard.y;
  float tz = ( 2.65 - ro.z ) / rd.z;
  vec3 L;
  if ( tz <= tx && tz <= ty ) {
    // back wall: grey panels and the door to the saloon, whose window shows the saloon
    // (daylight from its many windows; its lights at night); darker into the corners
    vec3 p = ro + rd * tz;
    float door = tramRect( p.xy, vec2( 0.3, 0.6 ), vec2( 1.0, 2.2 ), w );
    float win = tramRect( p.xy, vec2( 0.42, 1.45 ), vec2( 0.88, 2.04 ), w );
    float ao = ( 0.55 + 0.45 * smoothstep( 0.0, 0.4, 1.22 - abs( p.x ) ) ) * ( 0.6 + 0.4 * smoothstep( 0.0, 0.35, 2.5 - p.y ) );
    vec3 wall = mix( vec3( 0.42, 0.42, 0.4 ), vec3( 0.3, 0.3, 0.3 ), door ) * E * 0.85 * ao;
    vec3 saloon = vec3( 0.3, 0.29, 0.28 ) * E * 0.75 + vec3( 1.0, 0.94, 0.85 ) * ( uTramNight * uTramGain * 0.00005 );
    L = mix( wall, saloon, win );
  } else if ( tx < ty ) {
    // side wall: the cab's side window shows the street, the pillar ahead of it is dark
    vec3 p = ro + rd * tx;
    float win = tramRect( p.zy, vec2( 1.28, 0.98 ), vec2( 2.52, 2.42 ), w );
    float ao = ( 0.6 + 0.4 * smoothstep( 0.0, 0.35, 2.5 - p.y ) ) * ( 0.6 + 0.4 * smoothstep( 0.0, 0.4, 2.65 - p.z ) );
    vec3 wall = vec3( 0.36, 0.36, 0.35 ) * E * mix( 0.9, 0.5, saturate( p.z / 2.65 ) ) * ao;
    L = mix( wall, tramEnv( rdW ) * vec3( 0.5, 0.57, 0.58 ), win );
  } else if ( rd.y > 0.0 ) {
    // ceiling: lit only from below, darker into the corners
    vec3 p = ro + rd * ty;
    float ao = ( 0.55 + 0.45 * smoothstep( 0.0, 0.4, 1.22 - abs( p.x ) ) ) * ( 0.6 + 0.4 * smoothstep( 0.0, 0.4, 2.65 - p.z ) );
    L = vec3( 0.55, 0.55, 0.54 ) * E * 0.4 * ao;
  } else {
    L = vec3( 0.05 ) * E * 0.5;                    // floor
  }
  if ( uTramDriver > 0.5 ) {
    // seat back and headrest (mostly hidden by the driver)
    vec3 n;
    float c = tramEll( ro, rd, vec3( 0.0, 1.38, 1.66 ), vec3( 0.22, 0.32, 0.06 ), w, n );
    L = mix( L, vec3( 0.03 ) * E * tramShade( n ) * 0.7, c );
    c = tramEll( ro, rd, vec3( 0.0, 1.86, 1.62 ), vec3( 0.11, 0.09, 0.05 ), w, n );
    L = mix( L, vec3( 0.03 ) * E * tramShade( n ) * 0.7, c );
    // the driver: uniform shirt (arms, torso, broad shoulders), neck, head with the hair
    // on top and at the back
    vec3 shirt = vec3( 0.2, 0.26, 0.34 ), skin = vec3( 0.33, 0.22, 0.165 );
    c = tramEll( ro, rd, vec3( - 0.215, 1.46, 1.4 ), vec3( 0.055, 0.16, 0.065 ), w, n );
    L = mix( L, shirt * E * tramShade( n ) * 0.85, c );
    c = tramEll( ro, rd, vec3( 0.215, 1.46, 1.4 ), vec3( 0.055, 0.16, 0.065 ), w, n );
    L = mix( L, shirt * E * tramShade( n ) * 0.85, c );
    c = tramEll( ro, rd, vec3( 0.0, 1.38, 1.44 ), vec3( 0.185, 0.3, 0.12 ), w, n );
    L = mix( L, shirt * E * tramShade( n ), c );
    c = tramEll( ro, rd, vec3( 0.0, 1.6, 1.44 ), vec3( 0.235, 0.095, 0.115 ), w, n );
    L = mix( L, shirt * E * tramShade( n ), c );
    c = tramEll( ro, rd, vec3( 0.0, 1.74, 1.43 ), vec3( 0.05, 0.07, 0.05 ), w, n );
    L = mix( L, skin * E * tramShade( n ) * 0.7, c );
    c = tramEll( ro, rd, vec3( 0.0, 1.9, 1.4 ), vec3( 0.08, 0.108, 0.095 ), w, n );
    float hair = smoothstep( 0.3, 0.55, n.y + 0.8 * max( n.z, 0.0 ) + 0.35 * abs( n.x ) );
    L = mix( L, mix( skin, vec3( 0.03, 0.025, 0.022 ), hair ) * E * tramShade( n ), c );
  }
  // overhead console under the destination display: light grey plastic right behind the
  // screen, lit by the whole street through it
  vec2 po = ( ro + rd * ( ( 0.72 - ro.z ) / rd.z ) ).xy;
  float oc = tramRect( po, vec2( - 0.8, 2.12 ), vec2( 0.8, 2.7 ), w ) * step( ro.z, 0.72 );
  L = mix( L, vec3( 0.55, 0.55, 0.53 ) * E * mix( 1.0, 1.6, smoothstep( 2.12, 2.5, po.y ) ), oc );
  // console across the cab, the driver's binnacle in the middle
  vec2 pb = ( ro + rd * ( ( 0.6 - ro.z ) / rd.z ) ).xy;
  L = mix( L, vec3( 0.035 ) * E * 0.8, tramRect( pb, vec2( - 0.5, 0.0 ), vec2( 0.5, 1.5 ), w ) * step( ro.z, 0.6 ) );
  float yDeck = ro.y + rd.y * ( 0.85 - ro.z ) / rd.z;
  L = mix( L, vec3( 0.03 ) * E * 0.7, smoothstep( w, - w, yDeck - 1.34 ) );
  return L;
}
`;

/** Cab front glass: windscreen, trim and mask from uv (see WS_GLSL); the cab is traced
 *  behind the windscreen (CAB_GLSL). `driver`: the leading cab has its driver at the
 *  controls; `gain`: the library's night emissive gain. */
export function makeFrontMaterial({ driver = true, gain = { value: 1 } } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    name: driver ? 'trams.front' : 'trams.frontTrail', color: C(1, 1, 1), metalness: 0, roughness: 0.03, ior: 1.52,
  });
  const drv = { value: driver ? 1 : 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTramDriver = drv;
    sh.uniforms.uTramNight = U.uNight;
    sh.uniforms.uTramGain = gain;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vTramUv;\nvarying vec3 vTramP;\nvarying vec3 vTramE;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\n\tvTramUv = uv;')
      // body-frame position and the vector to the camera (the body's matrix is a rotation
      // and a translation)
      .replace('#include <project_vertex>', `#include <project_vertex>
	vTramP = transformed;
	vTramE = ( cameraPosition - modelMatrix[ 3 ].xyz ) * mat3( modelMatrix ) - transformed;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vTramUv;\nvarying vec3 vTramP;\nvarying vec3 vTramE;\n${WS_GLSL}`)
      .replace('#include <envmap_physical_pars_fragment>', `#include <envmap_physical_pars_fragment>\n${CAB_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	float tramD = tramWsDist( vTramUv );
	float tramAA = max( fwidth( tramD ), 1e-4 );
	float tramWs = 1.0 - smoothstep( -tramAA, tramAA, tramD );                  // clear windscreen
	float tramTrim = ( 1.0 - tramWs ) * ( 1.0 - smoothstep( 0.04 - tramAA, 0.04 + tramAA, tramD ) );
	float tramFoot = max( length( fwidth( vTramP ) ), 0.003 );                  // m per pixel on the glass
	// the windscreen itself is clear (a trace of road film): the cab behind it is traced
	// after the lighting; the mask: dark tinted glass over a black backing
	diffuseColor.rgb = mix( vec3( 0.006, 0.009, 0.02 ), vec3( 0.004 ), tramWs );
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.38, 0.395, 0.42 ), tramTrim );`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
	roughnessFactor = mix( roughnessFactor, 0.3, tramTrim );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
	metalnessFactor = mix( metalnessFactor, 0.7, tramTrim );`)
      // reflection: the windscreen is coated laminated glass whose faces and solar-control
      // film reflect about a fifth of the light (a little blue), the mask only with its outer
      // face (the black backing behind it); the Fresnel rise to grazing stays physical
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	material.specularColor = mix( material.specularColor * mix( 1.2, 1.0, tramTrim ), vec3( 0.24, 0.275, 0.31 ), tramWs );
	material.specularColorBlended = mix( material.specularColor, diffuseColor.rgb, metalnessFactor );`)
      // the environment cube's street is bare stone: what reflects below the horizon is
      // darkened as on the side glazing
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
	{
		vec3 tramR = transformDirectionByInverseViewMatrix( reflect( - geometryViewDir, geometryNormal ), viewMatrix );
		float tramSky = smoothstep( 0.0, 0.35, tramR.y );
		vec3 tramStreet = mix( radiance, vec3( dot( radiance, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.35 ) * 0.5;
		radiance = mix( tramStreet, radiance, tramSky );
	}`)
      // the cab through the glass: lit by the daylight on the screen (or the saloon and the
      // instruments at night), tinted, with a shade band along the top of the screen
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
	{
		vec3 tramRdW = inverseTransformDirection( - geometryViewDir, viewMatrix );
		// direct light on the screen (sun, lamps; shadowed), recovered from its faint road film
		vec3 tramEdir = reflectedLight.directDiffuse * PI / max( material.diffuseContribution, vec3( 1e-4 ) );
		vec3 tramE = ( irradiance + iblIrradiance + 0.25 * tramEdir ) * ( 0.6 * RECIPROCAL_PI ) + vec3( 0.75, 0.85, 1.0 ) * ( uTramNight * uTramGain * 0.00003 );
		vec3 tramL = tramCab( vTramP, normalize( - vTramE ), tramRdW, tramFoot, tramE );
		float tramNV = saturate( dot( geometryNormal, geometryViewDir ) );
		float tramF = 0.27 + 0.73 * pow( 1.0 - tramNV, 5.0 );
		vec3 tramT = vec3( 0.52, 0.69, 0.82 ) * mix( 1.0, 0.85, smoothstep( 2.2, 2.6, vTramUv.y ) );
		totalEmissiveRadiance += tramWs * tramL * tramT * ( 1.0 - tramF );
	}`);
  };
  m.customProgramCacheKey = () => 'trams.front.v4';
  return m;
}

/** Pantograph frame: dark grey paint (vertex colour). */
export function makeMetalMaterial() {
  return new THREE.MeshStandardMaterial({ name: 'trams.metal', color: C(1, 1, 1), vertexColors: true, metalness: 0.3, roughness: 0.45 });
}
