// Shader compile cost of the shared light loop (core, start-up time).
//
// three unrolls the spot light loop of `lights_fragment_begin` (#pragma unroll_loop_start),
// and the GLSL compiler inlines the lighting model's RE_Direct into every copy: with env's
// pool of 12 lamp lights plus the headlight, each lit program carries 13 copies of the
// whole BRDF. Programs are compiled one after another in the browser's GPU process, so
// that is start-up time paid ~100 times over (a typical lit program compiled in 245 ms
// with the unrolled loop and in 141 ms with a plain loop, the same shader otherwise; see
// docs/ARCHITECTURE.md, Cold start).
//
// loopSpotLights() keeps the spot block a real loop (RE_Direct inlined once) whenever the
// program has no spot light shadows and no spot light maps, which is always the case here;
// with either, the original unrolled block is compiled as before. The light maths and the
// order in which lights add up are unchanged, so the image is identical.
//
// It rewrites THREE.ShaderChunk.lights_fragment_begin in place and must run after env has
// patched the loop (env.patchLightLoops: dark-light skip, headlight cut-off) and before
// any lit program compiles. Idempotent; it leaves the chunk alone (returns false) when the
// block does not have the expected shape, e.g. once env does this itself.

const BEGIN = '#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )';
const START = '#pragma unroll_loop_start';
const END = '#pragma unroll_loop_end';

/** @returns {boolean} true when the spot loop was rewritten. */
export function loopSpotLights(SC) {
  const src = SC.lights_fragment_begin;
  if (typeof src !== 'string') return false;
  const a = src.indexOf(BEGIN);
  if (a < 0) return false;
  const s0 = src.indexOf(START, a), s1 = src.indexOf(END, a);
  const next = src.indexOf('#if ( NUM_', a + BEGIN.length);   // the following light block
  if (s0 < 0 || s1 < s0 || (next >= 0 && s1 > next)) return false;
  if (src.slice(a, s0).includes('NUM_SPOT_LIGHT_SHADOWS == 0')) return false;   // done already
  const loop = src.slice(s0 + START.length, s1);
  if (!/^\s*for \( int i = 0; i < NUM_SPOT_LIGHTS; i \+\+ \) \{/.test(loop)) return false;
  // the per-index sections exist only for spot shadows and spot light maps
  const dyn = loop
    .replace(/[ \t]*#if \( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS_WITH_MAPS \)[\s\S]*?#undef SPOT_LIGHT_MAP_INDEX[ \t]*\n/, '')
    .replace(/[ \t]*#if defined\( USE_SHADOWMAP \) && \( UNROLLED_LOOP_INDEX < NUM_SPOT_LIGHT_SHADOWS \)[^\n]*\n[\s\S]*?#endif[ \t]*\n/, '');
  if (dyn.includes('UNROLLED_LOOP_INDEX') || dyn.includes('spotShadowMap') || dyn.includes('spotLightMap[')) return false;
  const out = src.slice(0, s0) +
    '#if ( NUM_SPOT_LIGHT_SHADOWS == 0 ) && ( NUM_SPOT_LIGHT_MAPS == 0 )\n' + dyn.replace(/^\s*\n/, '') + '\n\t#else\n\t' +
    src.slice(s0, s1 + END.length) + '\n\t#endif' + src.slice(s1 + END.length);
  SC.lights_fragment_begin = out;
  return true;
}
