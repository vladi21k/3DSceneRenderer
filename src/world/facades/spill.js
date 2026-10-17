import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { Tpl, VS, TplCache } from './geo.js';
import { outlinePts, headSegments } from './outline.js';
import { emissiveGain } from './extras.js';

// Light spilling out of lit rooms and shops onto the stone reveals around their windows.
// Seen along the street at a grazing angle the glass itself is hidden by the near jamb,
// but the far jamb, the sill and the soffit catch the warm interior light, which is what
// makes lit windows read down a street at dusk. Drawn as an additive film 3 mm off the
// reveal surfaces (the buildings module owns the masonry), brightest next to the glass.
//
// Per vertex: aSpill (lit threshold, kind 0 home / 1 shop / 2 stair, depth 0 at the glass
// .. 1 at the wall face).

export function createSpillMaterial(M) {
  const m = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  // additive: order-independent, so one pass for both faces
  m.forceSinglePass = true;
  m.name = 'facades.spill';
  const gain = emissiveGain(M);
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = U.uNight;
    shader.uniforms.uEmGain = gain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aSpill;\nvarying vec3 vSpill;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSpill = aSpill;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nuniform float uEmGain;\nvarying vec3 vSpill;')
      .replace('#include <opaque_fragment>', `
// same lit test as the rooms (interior.js), shops always lit at night
float litT = uNight * 0.58;
float litS = vSpill.y > 0.5 && vSpill.y < 1.5 ? 1.0 : 1.0 - smoothstep( litT - 0.03, litT + 0.03, vSpill.x );
float on = smoothstep( 0.2, 0.7, uNight ) * litS;
vec3 lampS = vSpill.y > 0.5 && vSpill.y < 1.5 ? vec3( 1.0, 0.70, 0.43 ) : vec3( 1.0, 0.60, 0.31 );
float k = vSpill.y > 0.5 && vSpill.y < 1.5 ? 0.00026 : vSpill.y > 1.5 ? 0.00008 : 0.00018;
// stone albedo ~0.5 lit by the room behind the glass, falling off towards the wall face
gl_FragColor = vec4( lampS * k * on * uEmGain * ( 1.0 - 0.7 * vSpill.z ) * ( 1.0 - 0.7 * vSpill.z ), 1.0 );`);
  };
  m.customProgramCacheKey = () => 'facades.spill.v2';
  return m;
}

const cache = new TplCache(1200);
/** Reveal film of opening o in opening-local coordinates (z = 0 glass plane, z = recess wall face). */
export function spillTpl(o) {
  const R = Math.round(o.recess / 0.02) * 0.02;
  const key = `${o.top}|${o.w.toFixed(3)}|${o.h.toFixed(3)}|${(o.rise ?? 0).toFixed(3)}|${R.toFixed(2)}`;
  return cache.get(key, () => {
    const t = new Tpl();
    const pts = outlinePts(o, 0.003, Math.max(4, headSegments(o, 0.6)));
    const ring = (z) => pts.map((p) => [p[0], p[1], z]);
    t.loft([ring(0.004), ring(R - 0.004)], true, 1);
    return { tpl: t.bake(), R };
  });
}

/** aSpill values for a template of recess R. */
export function spillAttrs(lit, kind, R) {
  return { aSpill: (k, v, a, i) => { a[i] = lit; a[i + 1] = kind; a[i + 2] = Math.min(1, Math.max(0, v[k * VS + 2] / R)); } };
}
