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

// Neglect of the iron, 0 (kept up) .. 1 (left to rust): a smooth value noise in world
// space on a lattice of about a balcony along the street and a storey up, so one
// household's railing reads alike and the next may not. The lattice values come from an
// integer hash that the shaders (iwNeglect) and ironNeglect() below compute exactly
// alike, so the CPU can publish what the shaders draw (bal.rust, see consolesOf). About
// two railings in three are kept up (under 0.2), one in nine is rusting (over 0.8).
export const NEGLECT = { CELL: [4.0, 3.4, 4.0], LO: 0.45, HI: 0.85 };
export const NEGLECT_GLSL = /* glsl */ `
float iwH3( ivec3 i ) {
	uvec3 u = uvec3( i );
	uint h = ( u.x * 0x8da6b343u ) ^ ( u.y * 0xd8163841u ) ^ ( u.z * 0xcb1ab31fu );
	h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
	return float( h ) * ( 1.0 / 4294967296.0 );
}
float iwNeglect( vec3 p ) {
	vec3 x = p / vec3( ${NEGLECT.CELL.map((c) => c.toFixed(2)).join(', ')} ), fl = floor( x ), t = x - fl;
	ivec3 i = ivec3( fl );
	t = t * t * ( 3.0 - 2.0 * t );
	float n = mix(
		mix( mix( iwH3( i ), iwH3( i + ivec3( 1, 0, 0 ) ), t.x ), mix( iwH3( i + ivec3( 0, 1, 0 ) ), iwH3( i + ivec3( 1, 1, 0 ) ), t.x ), t.y ),
		mix( mix( iwH3( i + ivec3( 0, 0, 1 ) ), iwH3( i + ivec3( 1, 0, 1 ) ), t.x ), mix( iwH3( i + ivec3( 0, 1, 1 ) ), iwH3( i + ivec3( 1, 1, 1 ) ), t.x ), t.y ),
		t.z );
	return smoothstep( ${NEGLECT.LO.toFixed(2)}, ${NEGLECT.HI.toFixed(2)}, n );
}`;
const h3 = (ix, iy, iz) => {
  let h = (Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0; h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (t) => t * t * (3 - 2 * t);
/** Neglect of the iron at world position (x, y, z), as the shaders draw it (0 .. 1). */
export function ironNeglect(x, y, z) {
  const C = NEGLECT.CELL, px = x / C[0], py = y / C[1], pz = z / C[2];
  const fx = Math.floor(px), fy = Math.floor(py), fz = Math.floor(pz);
  const tx = smooth(px - fx), ty = smooth(py - fy), tz = smooth(pz - fz);
  const L = (a, b, t) => a + (b - a) * t;
  const n = L(
    L(L(h3(fx, fy, fz), h3(fx + 1, fy, fz), tx), L(h3(fx, fy + 1, fz), h3(fx + 1, fy + 1, fz), tx), ty),
    L(L(h3(fx, fy, fz + 1), h3(fx + 1, fy, fz + 1), tx), L(h3(fx, fy + 1, fz + 1), h3(fx + 1, fy + 1, fz + 1), tx), ty), tz);
  const t = Math.min(1, Math.max(0, (n - NEGLECT.LO) / (NEGLECT.HI - NEGLECT.LO)));
  return smooth(t);
}

/** Vertex colours interpolated at the sample centroid (shader patch, call in
 *  onBeforeCompile). The baked occlusion of small parts changes fast across narrow faces
 *  (drip grooves, fillets, coves): with MSAA a pixel only partly covered by such a face
 *  is shaded at its centre, outside the triangle, where the colour is extrapolated and
 *  can go negative (a broken HDR value) or far above 1 (a sparkle). */
export function centroidColor(sh) {
  sh.vertexShader = sh.vertexShader.replace('#include <color_pars_vertex>',
    '#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR ) || defined( USE_BATCHING_COLOR )\n\tcentroid varying vec4 vColor;\n#endif');
  sh.fragmentShader = sh.fragmentShader.replace('#include <color_pars_fragment>',
    '#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\n\tcentroid varying vec4 vColor;\n#endif');
}

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
 *  for bays, whose instance z axis is the railing normal: angle 1; posts 0); rust at
 *  the feet, in patches and in runs down the bars, by the iron's neglect (iwNeglect:
 *  hardly any on a kept-up railing, broken paint over half of a neglected one, whose
 *  remaining paint has chalked to a dusty charcoal; a fresh coat is glossier). `rust`
 *  scales it (black iron less than the thinner coloured paints). Both are uniforms, so
 *  black and painted bays and posts all share one program. */
function nearPatch(mat, rust, angle) {
  const uIwRust = { value: rust }, uIwAngle = { value: angle ? 1 : 0 };
  return chain(mat, '|ironNear', (sh) => {
    sh.uniforms.uIwRust = uIwRust;
    sh.uniforms.uIwAngle = uIwAngle;
    VERT_DIST(sh, '\nvarying vec3 vIwW;\nvarying float vIwY;\nvarying float vIwK;\ncentroid varying float vIwNeg;\nuniform float uIwAngle;' + NEGLECT_GLSL);
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
	#ifdef USE_INSTANCING
		vIwW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
		vec3 iwN = normalize( mat3( modelMatrix ) * mat3( instanceMatrix ) * vec3( 0.0, 0.0, 1.0 ) );
	#else
		vIwW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
		vec3 iwN = normalize( mat3( modelMatrix ) * vec3( 0.0, 0.0, 1.0 ) );
	#endif
	vIwK = mix( 1.0, ${ANGLE_GLSL('abs( dot( iwN, normalize( cameraPosition - vIwW ) ) )')}, uIwAngle );
	vIwY = transformed.y;
	vIwNeg = iwNeglect( vIwW );`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${FRAG_HEAD}
varying vec3 vIwW;
varying float vIwY;
varying float vIwK;
centroid varying float vIwNeg;
uniform float uIwRust;
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
		// rust: broken paint where water sits (bottom rail, feet, collars), in patches and
		// in runs down the bars (stretched upright), as far as the railing is neglected
		vec3 q = mod( vIwW, 512.0 );
		float neg = clamp( vIwNeg, 0.0, 1.0 );
		iwRn = iwNoise( q * 13.0 ) * 0.6 + iwNoise( q * 41.0 ) * 0.4;
		float foot = 1.0 - smoothstep( 0.0, 0.2, vIwY );
		float run = iwNoise( vec3( q.x * 31.0, q.y * 3.3, q.z * 31.0 ) );
		float m = iwRn + 0.2 * foot + 0.14 * run * neg - mix( 0.8, 0.55, neg );
		iwRust = uIwRust * mix( 0.75, 1.0, neg ) * smoothstep( 0.0, 0.12, m );
		vec3 rc = mix( vec3( 0.075, 0.032, 0.016 ), vec3( 0.2, 0.085, 0.035 ), iwNoise( q * 97.0 ) );
		// chalked paint on neglected iron: lighter, greyer, duller
		diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 1.45 + vec3( 0.011, 0.0105, 0.0098 ), neg );
		diffuseColor.rgb = mix( diffuseColor.rgb, rc, iwRust );
	}`)
      .replace('#include <lights_physical_fragment>', `roughnessFactor = mix( min( roughnessFactor * mix( 0.85, 1.3, clamp( vIwNeg, 0.0, 1.0 ) ), 1.0 ), 0.93, iwRust );
	#include <lights_physical_fragment>`);
  });
}

/** Far railing cards: coverage alpha faded in by projected bar width. Seen at an angle
 *  the real members show their depth as well as their face: each orientation plane of
 *  the atlas (railings.js) adds cover in proportion to the sideways shift of the view
 *  per unit depth, and the added cover fills the open part of the bay as the design's
 *  fitted constants say (patterns.js `widen`). Toward grazing angles the railing closes
 *  into a dark band, as real ones do. Dull, a little darker at grazing (no Fresnel).
 *  The neglect varying (here and on the near geometry) is interpolated at the sample
 *  centroid and clamped: a far card seen edge-on is a sliver narrower than a pixel, and
 *  the value extrapolated to the pixel centre drove the chalk and rust mixes past their
 *  ends into a negative albedo (a broken HDR pixel wherever MSAA kept that sample). */
export const uIwWiden = { value: WIDEN.map((w) => new THREE.Vector4(...w)) };

function cardPatch(mat) {
  return chain(mat, '|ironCard', (sh) => {
    VERT_DIST(sh, '\ncentroid varying float vIwNeg;' + NEGLECT_GLSL);
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
	#ifdef USE_INSTANCING
		vIwNeg = iwNeglect( ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz );
	#else
		vIwNeg = iwNeglect( ( modelMatrix * vec4( transformed, 1.0 ) ).xyz );
	#endif`);
    sh.uniforms.uIwWiden = uIwWiden;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${FRAG_HEAD}
uniform vec4 uIwWiden[ ${ATLAS.ROWS} ];
centroid varying float vIwNeg;
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
		// neglected iron: the near geometry's chalked paint and rust (mats.js nearPatch)
		// as their mean over bars too fine to resolve
		float ng = clamp( vIwNeg, 0.0, 1.0 );
		diffuseColor.rgb = mix( diffuseColor.rgb * 1.45 + vec3( 0.011, 0.0105, 0.0098 ), diffuseColor.rgb, 1.0 - ng );
		diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.13, 0.056, 0.026 ), 0.02 + 0.3 * ng * ng );
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

/** Shadow-pass material of the railing cards. The atlas mips hold the true coverage of
 *  the iron in each texel, so where a shadow texel is wider than the bars (coarse
 *  cascades, far railings) a fixed 0.5 cut would drop the bars altogether (coverage
 *  0.15-0.4) and keep only the handrail. Instead each shadow texel is solid where the
 *  coverage beats a 4x4 ordered-dither threshold: the sun filter, two texels wide or
 *  more, then darkens by the true share of iron, and once texels are finer than the bars
 *  the mips are sharp and the bars cast crisp. The cascades are snapped to their texel
 *  grid, so the pattern holds still while the camera moves. */
function cardDepthMaterial(atlas) {
  const m = new THREE.MeshDepthMaterial({
    name: 'ironwork.cardDepth', depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.5, side: THREE.DoubleSide,
  });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
float iwDither( vec2 p ) {
	ivec2 q = ivec2( mod( p, 4.0 ) );
	int i = q.x + q.y * 4;
	// 4x4 Bayer matrix, row by row
	const float B[ 16 ] = float[ 16 ]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
	return ( B[ i ] + 0.5 ) / 16.0;
}`)
      .replace('#include <alphatest_fragment>', 'if ( diffuseColor.a < iwDither( gl_FragCoord.xy ) ) discard;');
  };
  m.customProgramCacheKey = () => 'ironwork.cardDepth';
  return m;
}

// Paint colours seen on the references besides black (linear albedo): dark blue-grey,
// bottle green, grey-green, weathered teal, a stronger blue, off-white and an oxide
// brown (red-lead primer gone dull).
export const PAINTS = [
  [0.035, 0.05, 0.065], [0.015, 0.03, 0.022], [0.06, 0.07, 0.06], [0.03, 0.055, 0.06], [0.03, 0.06, 0.13], [0.42, 0.42, 0.39],
  [0.07, 0.03, 0.018],
];
/** Weights of PAINTS. With black iron on 60 % of the buildings (lotStyle) this makes
 *  about 15 % greens, 15 % blue-greys and blues, 8 % oxide brown, 2 % off-white. */
export const PAINT_W = [0.28, 0.2, 0.1, 0.07, 0.1, 0.04, 0.21];

export function makeMaterials(app, atlas) {
  const M = app.materials;
  const lib = M.get('metal.iron');

  // clones keep the library surface patch (baked paint maps, macro wear, specular AA);
  // bays and posts differ only in the view-angle factor (see header). All four share a
  // program: their instances always carry a colour (white on black iron).
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
    iron, paint, ironPost, paintPost, card, cardDepth: cardDepthMaterial(atlas),
    ironColor: () => [lib.color.r, lib.color.g, lib.color.b],
  };
}
