import * as THREE from 'three';
import { WIDEN, ATLAS } from './railings.js';

// Materials owned by the ironwork module.
//
// Railings are drawn twice: real instanced geometry near the camera and textured cards
// further away. Both representations depict the same strokes in the same plane, so
// their union covers the same pixels as either one alone. The hand-over therefore
// overlaps instead of swapping pixels between them (no dither, nothing fixed to the
// screen):
//   bar wider than CARD_HI px   geometry only
//   CARD_HI .. CARD_LO px       geometry + card fading in (union)
//   CARD_LO .. GEO_LO px        card + geometry fading out
//   below GEO_LO px             card only
// A bay seen at a grazing angle is foreshortened until its bars and scrolls merge into a
// band no geometry can resolve: its bar width counts as smaller by the view-angle factor
// angleK(n.v) (bays and their cards alike; posts keep their full width), so the cards
// take over early along the street and the geometry is spent on what can be seen.
// Fades are written into alpha and resolved by alpha-to-coverage on the MSAA scene
// target. Alpha is rounded to whole samples first: some drivers dither fractional
// coverage over a 2x2 pixel pattern, which would print a screen-fixed checkerboard on
// the iron; a whole number of samples covers every pixel alike, exactly like geometry
// edges under MSAA. Without MSAA (no post pass, low quality) alpha is a 0.5 cut.

export const FADE = { BAR: 0.016, GEO_LO: 0.8, GEO_HI: 1.3, CARD_LO: 1.3, CARD_HI: 2.2, NV: 0.35, KMIN: 0.3 };
/** View-angle factor on the bar width (|n.v| of the railing plane, see header). */
export const angleK = (nv) => Math.min(1, Math.max(FADE.KMIN, nv / FADE.NV));
const ANGLE_GLSL = (nv) => `clamp( ${nv} / ${FADE.NV.toFixed(3)}, ${FADE.KMIN.toFixed(3)}, 1.0 )`;
/** Pixels per metre at 1 m distance: 0.5 * drawing-buffer height * projection[1][1]. */
export const uIronPx = { value: 1800 };
/** MSAA sample count of the scene target (alpha-to-coverage works when > 0). */
export const uIronA2C = { value: 0 };
/** Debug: scales the cards' bar width (0.01 forces cards on everywhere). */
export const uIronCardK = { value: 1 };
/** Debug: scales the geometry's bar width (100 keeps solid geometry at every distance). */
export const uIronGeoK = { value: 1 };

/** Distance beyond which the railing geometry has faded out completely. */
export function geoLimit() { return (FADE.BAR * uIronPx.value * uIronGeoK.value) / FADE.GEO_LO; }

const f = (x) => x.toFixed(4);

// Hash-based value noise in world space (wrapped to keep float precision), for rust.
const NOISE = /* glsl */ `
float iwHash( vec3 p ) {
	p = fract( p * 0.1031 );
	p += dot( p, p.zyx + 31.32 );
	return fract( ( p.x + p.y ) * p.z );
}
float iwNoise( vec3 p ) {
	vec3 i = floor( p ), t = fract( p );
	t = t * t * ( 3.0 - 2.0 * t );
	float a = iwHash( i ), b = iwHash( i + vec3( 1, 0, 0 ) ), c = iwHash( i + vec3( 0, 1, 0 ) ), d = iwHash( i + vec3( 1, 1, 0 ) );
	float e = iwHash( i + vec3( 0, 0, 1 ) ), g = iwHash( i + vec3( 1, 0, 1 ) ), h = iwHash( i + vec3( 0, 1, 1 ) ), k = iwHash( i + vec3( 1, 1, 1 ) );
	return mix( mix( mix( a, b, t.x ), mix( c, d, t.x ), t.y ), mix( mix( e, g, t.x ), mix( h, k, t.x ), t.y ), t.z );
}`;

/** Chain a patch after any existing onBeforeCompile / program key. */
function chain(mat, tag, patch) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    sh.uniforms.uIronPx = uIronPx;
    sh.uniforms.uIronA2C = uIronA2C;
    sh.uniforms.uIronCardK = uIronCardK;
    sh.uniforms.uIronGeoK = uIronGeoK;
    patch(sh);
  };
  mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + tag; };
  return mat;
}

const VERT_DIST = (sh, extra = '') => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vIronDist;' + extra)
    .replace('#include <project_vertex>', '#include <project_vertex>\n\tvIronDist = length( mvPosition.xyz );');
};
const FRAG_HEAD = `
varying float vIronDist;
uniform float uIronPx;
uniform float uIronA2C;
uniform float uIronCardK;
uniform float uIronGeoK;
// coverage alpha for alpha-to-coverage: whole samples (see header), or a 0.5 cut
float iwCoverage( float a ) {
	return uIronA2C < 0.5 ? step( 0.5, a ) : floor( a * uIronA2C + 0.5 ) / uIronA2C;
}`;

/** Near railing geometry: fades out by projected bar width (with the view-angle factor
 *  for bays, whose instance z axis is the railing normal); rust at the feet and in
 *  patches (amount: 0 none .. 1 neglected paint). */
function nearPatch(mat, rust, angle) {
  return chain(mat, `|ironNear${rust}${angle ? 'a' : ''}`, (sh) => {
    VERT_DIST(sh, '\nvarying vec3 vIwW;\nvarying float vIwY;\nvarying float vIwK;');
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
	#ifdef USE_INSTANCING
		vIwW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
		vec3 iwN = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * vec3( 0.0, 0.0, 1.0 ) );
	#else
		vIwW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
		vec3 iwN = normalize( mat3( modelMatrix ) * vec3( 0.0, 0.0, 1.0 ) );
	#endif
	vIwK = ${angle ? ANGLE_GLSL('abs( dot( iwN, normalize( cameraPosition - vIwW ) ) )') : '1.0'};
	vIwY = transformed.y;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${FRAG_HEAD}
varying vec3 vIwW;
varying float vIwY;
varying float vIwK;
float iwRust = 0.0;
float iwRn = 0.0;
${NOISE}`)
      .replace('#include <alphatest_fragment>', `{
		float ironPx = ${f(FADE.BAR)} * uIronPx * uIronGeoK * vIwK / max( vIronDist, 0.01 );
		float a = iwCoverage( smoothstep( ${f(FADE.GEO_LO)}, ${f(FADE.GEO_HI)}, ironPx ) );
		if ( a <= 0.0 ) discard;
		diffuseColor.a = a;
	}
	#include <alphatest_fragment>`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	{
		// rust: broken paint where water sits (bottom rail, feet, collars) and in patches
		vec3 q = mod( vIwW, 512.0 );
		iwRn = iwNoise( q * 13.0 ) * 0.6 + iwNoise( q * 41.0 ) * 0.4;
		float foot = 1.0 - smoothstep( 0.0, 0.2, vIwY );
		float m = iwRn + 0.2 * foot - 0.66;
		iwRust = ${f(rust)} * smoothstep( 0.0, 0.12, m );
		vec3 rc = mix( vec3( 0.075, 0.032, 0.016 ), vec3( 0.2, 0.085, 0.035 ), iwNoise( q * 97.0 ) );
		diffuseColor.rgb = mix( diffuseColor.rgb, rc, iwRust );
	}`)
      .replace('#include <lights_physical_fragment>', `roughnessFactor = mix( roughnessFactor, 0.93, iwRust );
	#include <lights_physical_fragment>`);
  });
}

/** Far railing cards: coverage alpha faded in by projected bar width. Seen at an angle
 *  the real members show their depth as well as their face: each orientation plane of
 *  the atlas (railings.js) adds cover in proportion to the sideways shift of the view
 *  per unit depth, and the added cover fills the open part of the bay as the design's
 *  fitted constants say (patterns.js `widen`). Toward grazing angles the railing closes
 *  into a dark band, as real ones do. Dull, a little darker at grazing (no Fresnel). */
export const uIwWiden = { value: WIDEN.map((w) => new THREE.Vector4(...w)) };

function cardPatch(mat) {
  return chain(mat, '|ironCard', (sh) => {
    VERT_DIST(sh);
    sh.uniforms.uIwWiden = uIwWiden;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${FRAG_HEAD}
uniform vec4 uIwWiden[ ${ATLAS.ROWS} ];
vec3 iwN;`)
      // the atlas holds coverage planes, not colour (colour is per vertex)
      .replace('#include <map_fragment>', 'vec4 iwCov = texture2D( map, vMapUv );')
      .replace('#include <alphatest_fragment>', `{
		vec3 V = normalize( vViewPosition ), N = normalize( vNormal );
		vec3 Up = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
		vec3 Tu = normalize( cross( Up, N ) );
		float nv = abs( dot( V, N ) ), vn = max( nv, 0.02 );
		// view shift across the card per unit depth, along the run (u) and up (v)
		float su = abs( dot( V, Tu ) ) / vn, sv = abs( dot( V, Up ) ) / vn;
		vec4 k = uIwWiden[ int( clamp( floor( vMapUv.y * ${ATLAS.ROWS}.0 ), 0.0, ${ATLAS.ROWS - 1}.0 ) ) ];
		float added = dot( iwCov.rgb, vec3( k.x * su, k.y * sv, k.z * length( vec2( su, sv ) ) ) );
		float open = 1.0 - iwCov.a;
		float fill = 1.0 - pow( max( 1.0 - added / ( max( open, 0.001 ) * k.w ), 0.0 ), k.w );
		float cov = iwCov.a + open * fill;
		// (3 % ahead of the geometry's own angle factor: the hand-over band always overlaps)
		float ironPx = ${f(FADE.BAR)} * uIronPx * uIronCardK * 0.97 * ${ANGLE_GLSL('nv')} / max( vIronDist, 0.01 );
		float a = iwCoverage( cov * ( 1.0 - smoothstep( ${f(FADE.CARD_LO)}, ${f(FADE.CARD_HI)}, ironPx ) ) );
		if ( a <= 0.0 ) discard;
		diffuseColor.a = a;
		diffuseColor.rgb *= mix( 1.0, 0.7, 1.0 - nv );
		// shading normal of the lattice: the bar faces we see turn toward us as the view
		// grazes the card (round and square bars alike), not the card's own plane
		iwN = normalize( V + 0.5 * ( dot( N, V ) < 0.0 ? -N : N ) );
	}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
	normal = iwN;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	// a lattice of bars facing every way has no Fresnel rise toward the card's grazing
	// angles: reflectance stays at the paint's normal-incidence value
	material.specularF90 = 0.04;`);
  });
}

// Paint colours seen on the references besides black (linear albedo): dark blue-grey,
// bottle green, grey-green, weathered teal, and rarely a stronger blue or off-white.
export const PAINTS = [
  [0.035, 0.05, 0.065], [0.015, 0.03, 0.022], [0.06, 0.07, 0.06], [0.03, 0.055, 0.06], [0.03, 0.06, 0.13], [0.42, 0.42, 0.39],
];
/** Weights of PAINTS (the saturated blue and off-white are rare). */
export const PAINT_W = [0.32, 0.28, 0.18, 0.12, 0.04, 0.06];

export function makeMaterials(app, atlas) {
  const M = app.materials;
  const lib = M.get('metal.iron');

  // clones keep the library surface patch (baked paint maps, macro wear, specular AA);
  // bays and posts differ only in the view-angle factor (see header)
  const near = (name, rust, angle, painted) => {
    const m = nearPatch(lib.clone(), rust, angle);
    m.name = name;
    m.alphaToCoverage = true;
    // painted iron: same maps, colour per instance, a flatter older paint
    if (painted) { m.color.setRGB(1, 1, 1); m.roughness = 1.75; }
    return m;
  };
  const iron = near('ironwork.iron', 0.55, true, false), paint = near('ironwork.paint', 0.85, true, true);
  const ironPost = near('ironwork.ironPost', 0.55, false, false), paintPost = near('ironwork.paintPost', 0.85, false, true);

  // one card material for black and painted iron (colour per vertex)
  const card = cardPatch(new THREE.MeshStandardMaterial({
    name: 'ironwork.card', map: atlas, alphaToCoverage: true, side: THREE.DoubleSide,
    vertexColors: true, roughness: 0.85, metalness: 0,
  }));

  for (const m of [iron, paint, ironPost, paintPost, card]) M.register(m.name, m);

  return {
    iron, paint, ironPost, paintPost, card,
    ironColor: () => [lib.color.r, lib.color.g, lib.color.b],
  };
}
