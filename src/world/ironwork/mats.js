import * as THREE from 'three';

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
// Fades are written into alpha and resolved by alpha-to-coverage on the MSAA scene
// target. Without MSAA (no post pass, low quality) alpha falls back to a 0.5 cut.

export const FADE = { BAR: 0.016, GEO_LO: 0.8, GEO_HI: 1.3, CARD_LO: 1.3, CARD_HI: 2.2 };
/** Pixels per metre at 1 m distance: 0.5 * drawing-buffer height * projection[1][1]. */
export const uIronPx = { value: 1800 };
/** 1 when the scene renders into a multisampled target (alpha-to-coverage works). */
export const uIronA2C = { value: 0 };
/** Debug: scales the cards' bar width (0.01 forces cards on everywhere). */
export const uIronCardK = { value: 1 };

/** Distance beyond which the railing geometry has faded out completely. */
export function geoLimit() { return (FADE.BAR * uIronPx.value) / FADE.GEO_LO; }

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
const FRAG_HEAD = '\nvarying float vIronDist;\nuniform float uIronPx;\nuniform float uIronA2C;\nuniform float uIronCardK;';

/** Near railing geometry: fades out by projected bar width; rust at the feet and in
 *  patches (amount: 0 none .. 1 neglected paint). */
function nearPatch(mat, rust) {
  return chain(mat, `|ironNear${rust}`, (sh) => {
    VERT_DIST(sh, '\nvarying vec3 vIwW;\nvarying float vIwY;');
    sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
	#ifdef USE_INSTANCING
		vIwW = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
	#else
		vIwW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	#endif
	vIwY = transformed.y;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>${FRAG_HEAD}
varying vec3 vIwW;
varying float vIwY;
float iwRust = 0.0;
float iwRn = 0.0;
${NOISE}`)
      .replace('#include <alphatest_fragment>', `{
		float ironPx = ${f(FADE.BAR)} * uIronPx / max( vIronDist, 0.01 );
		float a = smoothstep( ${f(FADE.GEO_LO)}, ${f(FADE.GEO_HI)}, ironPx );
		if ( uIronA2C < 0.5 ) a = step( 0.5, a );
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

/** Far railing cards: coverage alpha (boosted at grazing angles, where real bars overlap)
 *  faded in by projected bar width; dull, darker at grazing (no Fresnel sheen). */
function cardPatch(mat) {
  return chain(mat, '|ironCard', (sh) => {
    VERT_DIST(sh);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>' + FRAG_HEAD)
      .replace('#include <alphatest_fragment>', `{
		float ironPx = ${f(FADE.BAR)} * uIronPx * uIronCardK / max( vIronDist, 0.01 );
		float nv = abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
		float a = diffuseColor.a * ( 1.0 - smoothstep( ${f(FADE.CARD_LO)}, ${f(FADE.CARD_HI)}, ironPx ) );
		a = min( a * clamp( 1.0 / max( nv, 0.2 ), 1.0, 3.5 ), 1.0 );
		if ( uIronA2C < 0.5 ) a = step( 0.5, a );
		if ( a < 0.004 ) discard;
		diffuseColor.a = a;
		diffuseColor.rgb *= mix( 1.0, 0.7, 1.0 - nv );
	}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	material.specularF90 = 0.3;
	material.specularColor *= 0.6;
	material.specularColorBlended *= 0.6;`);
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

  // clones keep the library surface patch (baked paint maps, macro wear, specular AA)
  const iron = nearPatch(lib.clone(), 0.55);
  iron.name = 'ironwork.iron';
  iron.alphaToCoverage = true;
  // painted iron: same maps, colour per instance, a flatter older paint
  const paint = nearPatch(lib.clone(), 0.85);
  paint.name = 'ironwork.paint';
  paint.color.setRGB(1, 1, 1);
  paint.roughness = 1.75;
  paint.alphaToCoverage = true;

  // one card material for black and painted iron (colour per vertex)
  const card = cardPatch(new THREE.MeshStandardMaterial({
    name: 'ironwork.card', map: atlas, alphaToCoverage: true, side: THREE.DoubleSide,
    vertexColors: true, roughness: 0.85, metalness: 0,
  }));

  for (const m of [iron, paint, card]) M.register(m.name, m);

  return {
    iron, paint, card,
    ironColor: () => [lib.color.r, lib.color.g, lib.color.b],
  };
}
