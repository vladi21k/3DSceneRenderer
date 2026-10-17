import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { Tpl, lin } from './geo.js';

// Canvas awnings: sloped (retractable, on folding arms) or dutch / dome (ribbed hoods,
// domes over arched openings). Scalloped valance, solid or striped canvas (stripes are
// shaded analytically with derivative anti-aliasing), wind ripple in the vertex shader
// and light shining through the canvas from behind.
//
// Extra vertex attributes: aStripe (r, g, b, period: 0 = solid), aFlex (0 fixed .. 1 free).

export const AWNING_COLORS = {
  cream: 0xd9cfb3, green: 0x24452f, burgundy: 0x5c1c22, navy: 0x1f2b48, terracotta: 0xa04a2c, ochre: 0xc49a42, grey: 0x8a8a84,
};
export const STRIPES = [
  ['cream', 'green'], ['cream', 'burgundy'], ['cream', 'navy'], ['cream', 'terracotta'], ['ochre', 'cream'], ['grey', 'cream'],
];

export function createAwningMaterial(M) {
  // private variant of the library canvas (keeps its baked weave), patched below
  const m = M.get('fabric.awning', { vertexColors: true, color: new THREE.Color(1, 1, 1), side: THREE.DoubleSide, userData: { owner: 'facades.awning' } });
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey ? m.customProgramCacheKey() : '';
  m.onBeforeCompile = (shader, r) => {
    if (prev) prev.call(m, shader, r);
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uWind = U.uWind;
    shader.uniforms.uWindStrength = U.uWindStrength;
    shader.uniforms.uSunDir = U.uSunDir;
    shader.uniforms.uSunColor = U.uSunColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aStripe;
attribute float aFlex;
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
varying vec4 vStripe;
varying vec3 vAwW;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vStripe = aStripe;
{
  vec3 wp = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  float ph = dot( wp.xz, vec2( 0.9, 0.7 ) );
  float gust = 0.55 + 0.45 * sin( uTime * 0.37 + ph * 0.05 );
  float w = sin( uTime * 2.3 + ph * 1.7 ) * 0.6 + sin( uTime * 3.7 + ph * 2.9 ) * 0.4;
  transformed += objectNormal * aFlex * w * gust * ( 0.012 + 0.03 * uWindStrength );
}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vAwW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec4 vStripe;
varying vec3 vAwW;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
if ( vStripe.w > 0.0 ) {
  // second half of every period takes the stripe colour; edges anti-aliased by fwidth
  float sx = vAwUv.x / vStripe.w;
  float fw = min( fwidth( sx ) * 1.2, 0.25 );
  float f = fract( sx );
  float s = smoothstep( 0.5 - fw, 0.5 + fw, f ) * ( 1.0 - smoothstep( 1.0 - fw, 1.0 + fw, f ) );
  s = mix( s, 0.5, smoothstep( 0.15, 0.25, fw ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vStripe.rgb, s );
}
{
  // seams where canvas widths are sewn together (on a stripe boundary for striped cloth)
  float sp = vStripe.w > 0.0 ? vStripe.w * max( 1.0, floor( 1.0 / vStripe.w ) ) : 0.9;
  float su = vAwUv.x / sp;
  float fws = fwidth( su );
  float seam = 1.0 - smoothstep( 0.0, 0.005 / sp + fws, abs( fract( su + 0.5 ) - 0.5 ) );
  seam *= 1.0 - smoothstep( 0.15, 0.3, fws );
  diffuseColor.rgb *= 1.0 - 0.14 * seam;
  // sun-faded where the cloth faces the sky, uneven grime
  vec3 nAw = inverseTransformDirection( vNormal, viewMatrix ) * ( gl_FrontFacing ? 1.0 : -1.0 );
  float lumA = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( lumA ) * 1.08, 0.12 * smoothstep( 0.1, 0.8, nAw.y ) );
  vec2 gq = vAwW.xz * 2.3 + vAwW.y * 4.1;
  vec2 gi = floor( gq ), gf = fract( gq ); gf = gf * gf * ( 3.0 - 2.0 * gf );
  float gn = mix( mix( fract( sin( dot( gi, vec2( 12.9898, 78.233 ) ) ) * 43758.5 ), fract( sin( dot( gi + vec2( 1, 0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5 ), gf.x ),
                  mix( fract( sin( dot( gi + vec2( 0, 1 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5 ), fract( sin( dot( gi + vec2( 1, 1 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5 ), gf.x ), gf.y );
  diffuseColor.rgb *= 0.93 + 0.07 * gn;
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  // canvas lets some sun through: the shaded underside glows in the canvas colour
  vec3 nW = inverseTransformDirection( normal, viewMatrix );
  float back = max( dot( -nW, uSunDir ), 0.0 ) * step( 0.0, uSunDir.y );
  totalEmissiveRadiance += diffuseColor.rgb * uSunColor * back * 0.06;
}`);
    // a UV varying that does not depend on texture maps being present
    shader.vertexShader = shader.vertexShader
      .replace('varying vec4 vStripe;', 'varying vec4 vStripe;\nvarying vec2 vAwUv;')
      .replace('vStripe = aStripe;', 'vStripe = aStripe;\nvAwUv = uv;');
    shader.fragmentShader = shader.fragmentShader.replace('varying vec4 vStripe;', 'varying vec4 vStripe;\nvarying vec2 vAwUv;');
  };
  m.customProgramCacheKey = () => prevKey + '|facades.awning.v2';
  return m;
}

// ------------------------------------------------------------------ geometry
// Awning templates carry an extra per-vertex flex value in a parallel array.
class ATpl extends Tpl {
  constructor() { super(); this.f = []; }
  v(x, y, z, nx, ny, nz, u, w, shade = 1, flex = 0) { this.f.push(flex); return super.v(x, y, z, nx, ny, nz, u, w, shade); }
  bake() { const b = super.bake(); b.f = new Float32Array(this.f); return b; }
}

/** Grid surface from a point function P(i/nu, j/nv) → [x, y, z, u, flex]; normals by finite differences. */
function surface(t, nu, nv, P, shade = 1, flip = false) {
  const base = t.count;
  const pts = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) pts.push(P(i / nu, j / nv));
  const at = (i, j) => pts[Math.min(nv, Math.max(0, j)) * (nu + 1) + Math.min(nu, Math.max(0, i))];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      const a = at(i + 1, j), b = at(i - 1, j), c = at(i, j + 1), d = at(i, j - 1);
      const ux = a[0] - b[0], uy = a[1] - b[1], uz = a[2] - b[2];
      const vx = c[0] - d[0], vy = c[1] - d[1], vz = c[2] - d[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      const p = at(i, j);
      t.v(p[0], p[1], p[2], nx, ny, nz, p[3], p[1], shade * (p[5] ?? 1), p[4]);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    if (flip) t.ix(a, b, c, b, d, c); else t.ix(a, c, b, b, c, d);
  }
}

/**
 * Scalloped valance hanging from a top edge: nS semicircular lobes (radius R) of equal
 * width with a 2 cm binding tape along the edge. Vertices land exactly on the cusps
 * (8 per lobe near, 4 far). edge(s) → [x, y, z] of the top edge at arc length s;
 * out(s) the outward normal in xz.
 */
function valance(t, total, valH, q, at) {
  const nS = Math.max(1, Math.round(total / 0.25)), per = total / nS;
  const R = Math.min(0.065, per * 0.42);
  const nvu = nS * (q >= 0.5 ? 8 : 4);
  const depth = (s) => {
    if (q < 0.5) return valH;
    const f = (s / per) % 1, c = 2 * f - 1;
    return valH - R + R * Math.sqrt(Math.max(0, 1 - c * c));
  };
  // rows: top edge, top of the binding, binding, bottom edge
  const rows = q >= 0.5 ? [[0, 1], [-0.022, 0.97], [-0.02, 0.72], [0, 0.72]] : [[0, 1], [0, 0.9]];
  surface(t, nvu, rows.length - 1, (a, b) => {
    const s = a * total, j = Math.round(b * (rows.length - 1));
    const h = depth(s);
    const [dy, shade] = rows[j];
    const y = j === 0 ? 0 : -h - dy;
    const [x, y0, z] = at(s);
    return [x, y0 + y, z, s, 0, shade * (1 - 0.12 * Math.min(1, -y / valH))];
  }, 0.95, true);
}

/**
 * Sloped awning, width W, mounted with its top edge at height y0 on the wall face (z = 0),
 * projection P, drop D. Returns {canvas (awning batch, ATpl), metal (Tpl)}.
 */
export function slopeAwning(W, P, D, valH, q) {
  const t = new ATpl(), m = new Tpl();
  const nu = Math.max(2, Math.round(W / (q >= 0.5 ? 0.2 : 0.8)));
  const nv = q >= 0.5 ? 5 : 1;
  surface(t, nu, nv, (a, b) => {
    const x = -W / 2 + W * a;
    // the cloth sags between the roller and the front bar, and creases near the cassette
    const sag = Math.sin(Math.PI * b) * 0.035 * (0.6 + 0.4 * Math.sin(Math.PI * a));
    const crease = q >= 0.5 ? 0.006 * Math.max(0, 1 - b / 0.25) * Math.sin(x * 21 + Math.sin(x * 7) * 2) : 0;
    const y = -D * b - sag + crease, z = P * b;
    return [x, y, z, x + W / 2, Math.sin(Math.PI * b) * (0.4 + 0.6 * Math.sin(Math.PI * a)), 1 - 0.1 * Math.max(0, 1 - b / 0.15)];
  });
  // hem tube wrapped round the front bar
  if (q >= 0.5) {
    const ring = [];
    for (let k = 0; k <= 4; k++) { const a = (k / 4) * Math.PI * 1.5 - Math.PI * 0.25; ring.push([Math.cos(a) * 0.022, Math.sin(a) * 0.022]); }
    surface(t, Math.max(2, Math.round(W / 0.3)), ring.length - 1, (a, b) => {
      const x = -W / 2 + W * a, [dz, dy] = ring[Math.round(b * (ring.length - 1))];
      return [x, -D + 0.004 + dy, P - 0.012 + dz, x + W / 2, 0, 0.9];
    });
  }
  // valance hanging from the front bar
  valance(t, W, valH, q, (s) => [-W / 2 + s, -D, P + 0.006]);
  // front bar, wall cassette and folding arms
  m.box(-W / 2 - 0.02, -D - 0.035, P - 0.03, W / 2 + 0.02, -D + 0.02, P + 0.004, 1 | 2 | 4 | 8 | 16 | 32, 0.85, 1);
  m.box(-W / 2 - 0.04, -0.02, 0, W / 2 + 0.04, 0.13, 0.14, 1 | 4 | 8 | 16 | 32, 0.8, 1);
  if (q >= 0.5) {
    for (const s of [-1, 1]) {
      const x = s * (W / 2 - 0.25);
      // arm from the wall (lower) to the front bar
      armBox(m, [x, -0.45, 0.02], [x, -D - 0.01, P - 0.02], 0.022);
      m.box(x - 0.04, -0.52, 0, x + 0.04, -0.38, 0.05, 1 | 4 | 8 | 16 | 32, 0.85, 1);
    }
  }
  return { canvas: t.bake(), metal: m.bake() };
}

/** Square-section bar between two 3D points. */
function armBox(m, a, b, s) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L = Math.hypot(dx, dy, dz) || 1;
  const d = [dx / L, dy / L, dz / L];
  // side vector (x) and a perpendicular
  const sx = [1, 0, 0];
  const px = [d[1] * sx[2] - d[2] * sx[1], d[2] * sx[0] - d[0] * sx[2], d[0] * sx[1] - d[1] * sx[0]];
  const pl = Math.hypot(...px) || 1; px[0] /= pl; px[1] /= pl; px[2] /= pl;
  const h = s / 2;
  const c = (p, u, v) => [p[0] + sx[0] * u + px[0] * v, p[1] + sx[1] * u + px[1] * v, p[2] + sx[2] * u + px[2] * v];
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]];
  for (let k = 0; k < 4; k++) {
    const [u0, v0] = corners[k], [u1, v1] = corners[(k + 1) % 4];
    m.quad(c(a, u0, v0), c(b, u0, v0), c(b, u1, v1), c(a, u1, v1), 0.9);
  }
}

/**
 * Dutch / dome awning: hood whose plan outline is a stadium (straight front with
 * quarter-sphere ends; a full dome when straight = 0). Top meets the wall at height R
 * above the origin; the bottom edge is at y = 0.
 */
export function domeAwning(W, R, valH, q) {
  const t = new ATpl(), m = new Tpl();
  const straight = Math.max(0, W - 2 * R);
  const capLen = (Math.PI / 2) * R;
  const total = straight + 2 * capLen;
  // plan curve parameter s ∈ [0, total]: left cap (from the wall), straight front, right cap
  const plan = (s) => {
    if (s < capLen) { const a = Math.PI - (s / capLen) * (Math.PI / 2); return [-straight / 2, Math.cos(a), Math.sin(a)]; }
    if (s < capLen + straight) return [-straight / 2 + (s - capLen), 0, 1];
    const a = Math.PI / 2 - ((s - capLen - straight) / capLen) * (Math.PI / 2);
    return [straight / 2, Math.cos(a), Math.sin(a)];
  };
  const ribs = Math.max(4, Math.round(total / 0.42));
  const nu = q >= 0.5 ? ribs * 3 : ribs;
  const nv = q >= 0.5 ? 6 : 3;
  surface(t, nu, nv, (a, b) => {
    const s = a * total, [xa, dx, dz] = plan(s);
    const th = (b * Math.PI) / 2;           // 0 at the wall (top), π/2 at the bottom edge
    // pleats between the ribs
    const rib = (a * ribs) % 1;
    const pleat = q >= 0.5 ? 0.025 * Math.sin(Math.PI * rib) * Math.sin(th) : 0;
    const r = R - pleat;
    return [xa + dx * r * Math.sin(th), R * Math.cos(th) - pleat * Math.cos(th) * 0.3, dz * r * Math.sin(th), s, 0.25 * Math.sin(th) * Math.sin(Math.PI * rib), 1 - 0.15 * Math.sin(Math.PI * rib)];
  });
  // valance along the bottom edge
  valance(t, total, valH, q, (s) => { const [xa, dx, dz] = plan(s); return [xa + dx * (R + 0.004), 0, dz * (R + 0.004)]; });
  // rim bar along the bottom edge (metal) – a few short segments
  if (q >= 0.5) {
    const n = 16;
    for (let k = 0; k < n; k++) {
      const p0 = plan((k / n) * total), p1 = plan(((k + 1) / n) * total);
      armBox(m, [p0[0] + p0[1] * R, 0.0, p0[2] * R], [p1[0] + p1[1] * R, 0.0, p1[2] * R], 0.018);
    }
  }
  return { canvas: t.bake(), metal: m.bake() };
}

// Templates are shared between awnings of the same (quantised) size.
const cache = new Map();
const q2 = (x, step) => Math.round(x / step) * step;
/** Cached slopeAwning with dimensions quantised to 1–5 cm. */
export function slopeAwningT(W, P, D, valH, q) {
  W = q2(W, 0.02); P = q2(P, 0.05); D = q2(D, 0.05); valH = q2(valH, 0.02);
  const k = `S|${W.toFixed(2)}|${P.toFixed(2)}|${D.toFixed(2)}|${valH.toFixed(2)}|${q}`;
  let v = cache.get(k);
  if (!v) { if (cache.size > 400) cache.clear(); v = slopeAwning(W, P, D, valH, q); cache.set(k, v); }
  return v;
}
/** Cached domeAwning with dimensions quantised to 1–2 cm. */
export function domeAwningT(W, R, valH, q) {
  W = q2(W, 0.02); R = q2(R, 0.01); valH = q2(valH, 0.02);
  const k = `D|${W.toFixed(2)}|${R.toFixed(2)}|${valH.toFixed(2)}|${q}`;
  let v = cache.get(k);
  if (!v) { if (cache.size > 400) cache.clear(); v = domeAwning(W, R, valH, q); cache.set(k, v); }
  return v;
}

export function awningColors(rng) {
  if (rng.chance(0.42)) {
    const [a, b] = rng.pick(STRIPES);
    return { c1: lin(AWNING_COLORS[a]), c2: lin(AWNING_COLORS[b]), period: rng.pick([0.2, 0.25, 0.3, 0.12]) };
  }
  const c = lin(AWNING_COLORS[rng.weighted([['cream', 0.25], ['green', 0.2], ['burgundy', 0.18], ['navy', 0.14], ['terracotta', 0.15], ['ochre', 0.08]])]);
  return { c1: c, c2: c, period: 0 };
}
