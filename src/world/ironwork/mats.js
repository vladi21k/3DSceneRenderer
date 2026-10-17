import * as THREE from 'three';

// Materials owned by the ironwork module. Railings are drawn twice: real instanced
// geometry near the camera and alpha-tested cards further away. Both materials share a
// screen-space cross-fade keyed on the projected bar width in pixels, with complementary
// dither masks, so exactly one representation covers each pixel and thin iron never
// shimmers: geometry while bars are wider than ~2.4 px, cards once they drop below ~1.6 px.

export const FADE = { BAR: 0.016, LO: 1.6, HI: 2.4 };
/** Pixels per metre at 1 m distance: 0.5 * drawing-buffer height * projection[1][1]. */
export const uIronPx = { value: 1800 };

/** Distance at which bars fall below the low threshold (nothing near is drawn beyond). */
export function nearLimit() { return (FADE.BAR * uIronPx.value) / FADE.LO; }

function addFade(mat, near) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.uniforms.uIronPx = uIronPx;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vIronDist;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvIronDist = length( mvPosition.xyz );');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vIronDist;\nuniform float uIronPx;')
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
	{
		float ironPx = ${FADE.BAR.toFixed(4)} * uIronPx / max( vIronDist, 0.01 );
		float ironT = smoothstep( ${FADE.LO.toFixed(3)}, ${FADE.HI.toFixed(3)}, ironPx );
		float ironN = fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) );
		if ( ${near ? 'ironN >= ironT' : 'ironN < ironT'} ) discard;
	}`);
  };
  const tag = near ? '|ironNear' : '|ironFar';
  mat.customProgramCacheKey = () => (prev ? String(prev) : '') + tag;
  return mat;
}

/** Copy the visible properties of a library material onto our derived copy. */
function syncFrom(dst, src, { maps = true } = {}) {
  let changed = false;
  if (maps) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap']) {
      if (dst[k] !== src[k]) { dst[k] = src[k]; changed = true; }
    }
    dst.color.copy(src.color);
  }
  dst.roughness = src.roughness; dst.metalness = src.metalness;
  if (src.normalScale) dst.normalScale.copy(src.normalScale);
  dst.envMapIntensity = src.envMapIntensity;
  if (changed) dst.needsUpdate = true;
}

// Paint colours seen on the references besides black: blue-grey, deep blue, bottle green,
// teal, off-white. Linear albedo.
export const PAINTS = [
  [0.105, 0.19, 0.27], [0.03, 0.075, 0.22], [0.014, 0.04, 0.026], [0.024, 0.1, 0.115], [0.5, 0.5, 0.46],
];

export function makeMaterials(app, atlas) {
  const M = app.materials;
  const lib = M.get('metal.iron');

  const iron = new THREE.MeshStandardMaterial({ name: 'ironwork.iron' });
  // keep any shader patch the library iron carries (weathering etc.), then add the fade
  if (Object.prototype.hasOwnProperty.call(lib, 'onBeforeCompile')) iron.onBeforeCompile = lib.onBeforeCompile;
  addFade(iron, true);
  syncFrom(iron, lib);
  const paint = addFade(new THREE.MeshStandardMaterial({ name: 'ironwork.paint', color: 0xffffff, roughness: 0.42, metalness: 0 }), true);

  // one card material for black and painted iron (paint colour per vertex); at card
  // distances the metal/paint difference is invisible, so it is a dark dielectric
  const card = addFade(new THREE.MeshStandardMaterial({
    name: 'ironwork.card', map: atlas, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide,
    vertexColors: true, roughness: 0.45, metalness: 0,
  }), false);

  for (const m of [iron, paint, card]) M.register(m.name, m);

  return {
    iron, paint, card,
    stone: M.get('stone.smooth', { vertexColors: true }),
    /** Keep the derived iron in step with the library iron (textures may land later). */
    sync() { syncFrom(iron, lib); },
    ironColor: () => [lib.color.r, lib.color.g, lib.color.b],
  };
}
