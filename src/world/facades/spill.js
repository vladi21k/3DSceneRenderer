import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { Tpl, VS, TplCache } from './geo.js';
import { outlinePts, headSegments, crownY } from './outline.js';
import { emissiveGain } from './extras.js';
import { ROOM_LIGHT_GLSL } from './interior.js';

// Light spilling out of lit rooms and shops at dusk.
//  - Reveals: seen along the street at a grazing angle the glass itself is hidden by the
//    near jamb, but the far jamb, the sill and the soffit catch the interior light, which
//    is what makes lit windows read down a street. An additive film 3 mm off the reveal
//    surfaces (the buildings module owns the masonry): bright next to the glass, falling
//    off exponentially (~0.15 m) towards the wall plane, and up the tall jambs of shops
//    (their downlights light the floor and the goods, not the head).
//  - Pavement: a soft pool on the paving in front of each lit shop window, from the form
//    factor of the opening seen from the ground (precomputed per vertex).
// Room character (lamp colour, level, television) follows the lit threshold, exactly as
// in the rooms (interior.js), so the reveal glow matches the room behind it.
//
// Per vertex: aSpill (lit threshold, kind + dim, z, y). kind 0 home / 1 shop / 2 stair /
// 3 pavement pool; dim = share of the light held back by curtains or blinds. Reveals:
// z metres from the glass, y height up the opening (0 sill .. 1 crown). Pool: z = relative
// irradiance (0..1).

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
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uEmGain = gain;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aSpill;\nvarying vec4 vSpill;\nvarying vec2 vSpUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSpill = aSpill;\nvSpUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight;
uniform float uTime;
uniform float uEmGain;
varying vec4 vSpill;
varying vec2 vSpUv;
${ROOM_LIGHT_GLSL}
float spN( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
  vec4 h = fract( sin( vec4( dot( i, vec2( 127.1, 311.7 ) ), dot( i + vec2( 1, 0 ), vec2( 127.1, 311.7 ) ),
    dot( i + vec2( 0, 1 ), vec2( 127.1, 311.7 ) ), dot( i + vec2( 1, 1 ), vec2( 127.1, 311.7 ) ) ) ) * 43758.5453 );
  return mix( mix( h.x, h.y, f.x ), mix( h.z, h.w, f.x ), f.y );
}`)
      .replace('#include <opaque_fragment>', `
float kind = floor( vSpill.y + 1e-3 ), dim = vSpill.y - kind;
bool shop = kind > 0.5 && kind < 1.5 || kind > 2.5;
// same lit test as the rooms, shops always lit at night
float litT = uNight * LIT_SHARE;
float litS = shop ? 1.0 : 1.0 - smoothstep( litT - 0.03, litT + 0.03, vSpill.x );
float on = smoothstep( 0.2, 0.7, uNight ) * litS * ( 1.0 - dim );
vec3 lampS = shop ? vec3( 1.0, 0.70, 0.43 ) : fRoomLampC( vSpill.x ) * fRoomLevel( vSpill.x );
if ( !shop && fRoomTV( vSpill.x ) > 0.5 ) lampS = fTVLight( vSpill.x, uTime ) * 0.6;
float k;
if ( kind > 2.5 ) {
  // pavement pool: paving albedo ~0.3 under the shop's light (the shops' interiors sit far
  // above the street lamps' level in the exposure, so their pools hold their own)
  k = 0.0007 * vSpill.z;
} else {
  // stone albedo ~0.5 lit by the room behind the glass: strongest at the glass, falling off
  // exponentially towards the wall face; the tall jambs of shops fade upwards (their
  // downlights light the floor and the goods), and the stone is uneven
  k = shop ? 0.00016 : kind > 1.5 ? 0.00008 : 0.0002;
  k *= exp( -vSpill.z / ( shop ? 0.1 : 0.15 ) ) * ( 0.25 + 0.75 * smoothstep( 0.0, 0.012, vSpill.z ) );
  k *= shop ? 1.0 - 0.75 * smoothstep( 0.25, 0.85, vSpill.w ) : 1.0 - 0.3 * smoothstep( 0.6, 1.0, vSpill.w );
  k *= 0.7 + 0.6 * spN( vSpUv * vec2( 3.1, 9.0 ) ) * ( 0.6 + 0.4 * spN( vSpUv * 23.0 ) );
}
gl_FragColor = vec4( lampS * k * on * uEmGain, 1.0 );`);
  };
  m.customProgramCacheKey = () => 'facades.spill.v3';
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
    // extra rings near the glass so the exponential falloff is sampled where it is steep
    const zs = [0.004, Math.min(0.06, R * 0.3), Math.min(0.16, R * 0.6), R - 0.004];
    t.loft(zs.map((z) => pts.map((p) => [p[0], p[1], z])), true, 1);
    return { tpl: t.bake(), R, H: crownY(o) };
  });
}

/** aSpill values for a reveal template: lit threshold, kind, dim (0..0.95). */
export function spillAttrs(lit, kind, dim, sp) {
  const H = Math.max(0.5, sp.H), kd = kind + Math.min(0.95, Math.max(0, dim));
  return { aSpill: (k, v, a, i) => { const o = k * VS; a[i] = lit; a[i + 1] = kd; a[i + 2] = Math.max(0, v[o + 2]); a[i + 3] = v[o + 1] / H; } };
}

// ------------------------------------------------------------------ pavement pool
const GU = [-1.25, -0.6, -0.2, 0.2, 0.6, 1.25];   // across: outside the jambs (m) / share of the half width
const GW = [0.04, 0.35, 0.9, 1.7, 2.7, 3.8];       // out from the wall face (m)
const _p = new THREE.Vector3(), _q = new THREE.Vector3();

/**
 * Light pool on the paving in front of the shop opening o (main-street fronts only):
 * a grid lying on the route's ground surface, intensity = form factor of the opening's
 * aperture (above the stall riser) seen from each vertex. Returns a template in world
 * coordinates (add with an identity matrix) and its aSpill attributes, or null.
 */
export function groundGlow(ctx, o) {
  const { frame, plan, app, lot } = ctx;
  const route = app.route;
  const hw = o.w / 2, y0 = 0.45, y1 = Math.min(crownY(o), 3.4);
  if (y1 - y0 < 0.8) return null;
  const g = plan.groundAt(o.uc);
  // route coordinates of the opening's foot, and the route frame there
  _p.set(o.uc, g, 0).applyMatrix4(frame.matrix);
  const sHint = (lot.s0 + lot.s1) / 2;
  const pr = route.project(_p.x, _p.z, sHint, Math.max(20, lot.len || 20));
  const smp = route.sample(pr.s);
  const tx = smp.tan.x, tz = smp.tan.z, rx = smp.right.x, rz = smp.right.z;
  const scale = route.offsetScale(pr.s, pr.d) || 1;
  const t = new Tpl();
  const val = [];
  const ux = frame.uDir.x, uz = frame.uDir.z, nx = frame.nDir.x, nz = frame.nDir.z;
  const nU = GU.length, nW = GW.length;
  for (let j = 0; j < nW; j++) {
    const w = GW[j];
    for (let i = 0; i < nU; i++) {
      const a = GU[i];
      const du = Math.abs(a) > 1 ? Math.sign(a) * (hw + (Math.abs(a) - 1) * 4 * (0.4 + w * 0.35)) : a * hw;
      // world offset from the opening foot, then route coordinates by linearisation
      const ox = ux * du + nx * w, oz = uz * du + nz * w;
      const s = pr.s + (ox * tx + oz * tz) / scale, d = pr.d + ox * rx + oz * rz;
      route.toWorld(s, d, 0.015, _q);
      t.v(_q.x, _q.y, _q.z, 0, 1, 0, 0, 0, 1);
      // the grid's rim fades to nothing (no visible edge where the pool ends)
      const rim = i === 0 || i === nU - 1 || j === nW - 1;
      val.push(rim ? 0 : poolFF(du, w, hw, y0, y1));
    }
  }
  for (let j = 0; j + 1 < nW; j++) {
    for (let i = 0; i + 1 < nU; i++) {
      const a = j * nU + i, b = a + 1, c = a + nU, d = c + 1;
      t.ix6(a, c, b, b, c, d);
    }
  }
  const lit = o.lit ?? 1;
  return { tpl: t.bake(), attrs: { aSpill: (k, v, arr, i) => { arr[i] = lit; arr[i + 1] = 3; arr[i + 2] = val[k]; arr[i + 3] = 0; } } };
}

/**
 * Form factor (×2, so ~1 at the foot of a wide opening) from an upward-facing ground
 * point at (x across, w out) to the vertical aperture [−hw, hw] × [y0, y1] in the wall
 * plane (the opening's sill level is the ground).
 */
function poolFF(x, w, hw, y0, y1) {
  const NX = 6, NY = 5;
  const dA = ((2 * hw) / NX) * ((y1 - y0) / NY);
  let s = 0;
  for (let iy = 0; iy < NY; iy++) {
    const y = y0 + ((iy + 0.5) * (y1 - y0)) / NY;
    for (let ix = 0; ix < NX; ix++) {
      const ax = -hw + ((ix + 0.5) * 2 * hw) / NX;
      const dx = ax - x, dw = w + 0.02, r2 = dx * dx + dw * dw + y * y;
      // cos at the ground (y / r) × cos at the aperture (w / r)
      s += (y * dw) / (r2 * r2);
    }
  }
  return Math.min(1, (2 * s * dA) / Math.PI);
}
