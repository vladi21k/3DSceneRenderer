import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { Tpl, TplCache, lin } from './geo.js';

// Canvas awnings: sloped (retractable, on folding arms) or dutch / dome (ribbed hoods,
// domes over arched openings). Scalloped valance, solid or striped canvas (stripes are
// shaded analytically with derivative anti-aliasing), wind ripple in the vertex shader
// and light shining through the canvas from behind.
//
// Extra vertex attributes: aStripe (r, g, b, period: 0 = solid), aFlex (0 fixed .. 1 free).

// canvas colours as on the street: cream and white, the classic bottle green, burgundy and
// navy, and about half in strong colours (signal red, orange, royal blue, mustard)
export const AWNING_COLORS = {
  cream: 0xd9cfb3, green: 0x1e5a32, burgundy: 0x5c1c22, navy: 0x1f2b48, terracotta: 0xa04a2c, ochre: 0xc49a42, grey: 0x8a8a84,
  white: 0xeae7de, red: 0xb81e1a, orange: 0xd8601a, royal: 0x1f4a9a, mustard: 0xd4a020, forest: 0x24452f,
};
export const STRIPES = [
  ['cream', 'green'], ['cream', 'burgundy'], ['cream', 'navy'], ['cream', 'terracotta'], ['ochre', 'cream'], ['grey', 'cream'],
  ['white', 'red'], ['white', 'orange'], ['white', 'royal'], ['white', 'green'], ['mustard', 'white'], ['red', 'white'],
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
  // sun-bleached where the cloth faces the sky (lighter, greyer), uneven grime
  vec3 nAw = inverseTransformDirection( vNormal, viewMatrix ) * ( gl_FrontFacing ? 1.0 : -1.0 );
  float lumA = dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
  float sunAw = smoothstep( 0.1, 0.8, nAw.y ) * ( 0.8 + 0.4 * fract( sin( dot( floor( vAwUv * vec2( 0.7, 1.0 ) ), vec2( 12.9898, 78.233 ) ) ) * 43758.5 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, mix( vec3( lumA ), diffuseColor.rgb, 0.55 ) * 1.25 + 0.02, 0.34 * sunAw );
  // rain run-off: faint darker streaks down the hanging parts, a dirtier band at the hem
  float vertAw = 1.0 - smoothstep( 0.3, 0.7, abs( nAw.y ) );
  float strk = fract( sin( floor( vAwUv.x * 14.0 ) * 91.7 ) * 4375.85 );
  float fStrk = 1.0 - smoothstep( 0.1, 0.4, fwidth( vAwUv.x * 14.0 ) );
  // (streaks of soot and dust washed down the folds, darker where the cloth hangs)
  diffuseColor.rgb *= 1.0 - vertAw * ( 0.1 * step( 0.55, strk ) * fStrk * ( 0.6 + 0.4 * sin( vAwUv.y * 9.0 + strk * 6.0 ) ) + 0.06 );
  vec2 gq = vAwW.xz * 2.3 + vAwW.y * 4.1;
  vec2 gi = floor( gq ), gf = fract( gq ); gf = gf * gf * ( 3.0 - 2.0 * gf );
  float gn = mix( mix( fract( sin( dot( gi, vec2( 12.9898, 78.233 ) ) ) * 43758.5 ), fract( sin( dot( gi + vec2( 1, 0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5 ), gf.x ),
                  mix( fract( sin( dot( gi + vec2( 0, 1 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5 ), fract( sin( dot( gi + vec2( 1, 1 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5 ), gf.x ), gf.y );
  diffuseColor.rgb *= 0.89 + 0.11 * gn;
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // canvas relief as a bump: slack ripples running down the cloth, finer creases and the
  // raised seams; faded out before it would alias (fine folds are in the baked weave)
  vec2 q = vAwUv;
  float sp = vStripe.w > 0.0 ? vStripe.w * max( 1.0, floor( 1.0 / vStripe.w ) ) : 0.9;
  float hb = 0.0028 * sin( q.x * 10.5 + 1.8 * sin( q.y * 4.3 + q.x * 0.9 ) )
           + 0.0009 * sin( q.x * 31.0 + q.y * 17.0 + 2.0 * sin( q.x * 5.0 ) )
           + 0.0012 * ( 1.0 - smoothstep( 0.0, 0.012, abs( fract( q.x / sp + 0.5 ) - 0.5 ) * sp ) );
  float keepB = 1.0 - smoothstep( 0.015, 0.05, length( fwidth( q ) ) );
  vec3 dpx = dFdx( -vViewPosition ), dpy = dFdy( -vViewPosition );
  float dhx = dFdx( hb ) * keepB, dhy = dFdy( hb ) * keepB;
  vec3 r1 = cross( dpy, normal ), r2 = cross( normal, dpx );
  float det = dot( dpx, r1 );
  vec3 nb = abs( det ) * normal - sign( det ) * ( dhx * r1 + dhy * r2 );
  // (edge-on triangles have parallel derivatives, det = 0: keep the normal, never NaN)
  if ( dot( nb, nb ) > 1e-30 ) normal = normalize( nb );
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  // canvas lets some sun through: the shaded underside glows in the canvas colour
  vec3 nW = inverseTransformDirection( normal, viewMatrix );
  float back = max( dot( -nW, uSunDir ), 0.0 ) * step( 0.0, uSunDir.y );
  totalEmissiveRadiance += diffuseColor.rgb * uSunColor * back * 0.045;
}`);
    // a UV varying that does not depend on texture maps being present
    shader.vertexShader = shader.vertexShader
      .replace('varying vec4 vStripe;', 'varying vec4 vStripe;\nvarying vec2 vAwUv;')
      .replace('vStripe = aStripe;', 'vStripe = aStripe;\nvAwUv = uv;');
    shader.fragmentShader = shader.fragmentShader.replace('varying vec4 vStripe;', 'varying vec4 vStripe;\nvarying vec2 vAwUv;');
  };
  m.customProgramCacheKey = () => prevKey + '|facades.awning.v5';
  return m;
}

// ------------------------------------------------------------------ geometry
// Awning templates carry an extra per-vertex flex value in a parallel array.
class ATpl extends Tpl {
  constructor() { super(); this.f = []; }
  v(x, y, z, nx, ny, nz, u, w, shade = 1, flex = 0) { this.f.push(flex); return super.v(x, y, z, nx, ny, nz, u, w, shade); }
  bake() { const b = super.bake(); b.f = new Float32Array(this.f); return b; }
}

/** Fill the scratch grid point (surface copies it out at once). */
function pt(x, y, z, u, f, sh) { _pt[0] = x; _pt[1] = y; _pt[2] = z; _pt[3] = u; _pt[4] = f; _pt[5] = sh; return _pt; }

/**
 * Grid surface from a point function P(i/nu, j/nv) → [x, y, z, u, flex]; normals by finite
 * differences. Where a row or column collapses to a point (the pole of a dome, a pinched
 * edge) the difference across it vanishes: the tangent is then taken from the nearest row
 * (column) that still spans, so no vertex ever gets a zero normal (which the vertex shader
 * would normalise into NaN: black triangles).
 */
// (grid points of the surface being built: one reused buffer of [x, y, z, u, flex, shade]
// rows, subarray views into it, so a template allocates little but its baked arrays)
let gridBuf = new Float64Array(6 * 1024);
const _pt = [0, 0, 0, 0, 0, 1];
function surface(t, nu, nv, P, shade = 1, flip = false) {
  const base = t.count;
  const n = (nu + 1) * (nv + 1);
  if (gridBuf.length < n * 6) gridBuf = new Float64Array(n * 6 * 2);
  const G = gridBuf, pts = new Array(n);
  for (let j = 0, k = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++, k++) {
      _pt[5] = 1;
      const p = P(i / nu, j / nv, _pt), o = k * 6;
      G[o] = p[0]; G[o + 1] = p[1]; G[o + 2] = p[2]; G[o + 3] = p[3]; G[o + 4] = p[4]; G[o + 5] = p[5] ?? 1;
      pts[k] = G.subarray(o, o + 6);
    }
  }
  const at = (i, j) => pts[Math.min(nv, Math.max(0, j)) * (nu + 1) + Math.min(nu, Math.max(0, i))];
  const EPS = 1e-12, U = [0, 0, 0], V = [0, 0, 0];
  // difference of two grid points into out; false if they coincide
  const diff = (out, a, b) => { out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; return out[0] * out[0] + out[1] * out[1] + out[2] * out[2] > EPS; };
  // tangent along u at (i, j), from row j or, where that row is collapsed, the nearest row that spans
  const tu = (i, j) => {
    for (let k = 0; k <= nv; k++) {
      if (j + k <= nv && diff(U, at(i + 1, j + k), at(i - 1, j + k))) return;
      if (k && j - k >= 0 && diff(U, at(i + 1, j - k), at(i - 1, j - k))) return;
    }
    U[0] = 1; U[1] = 0; U[2] = 0;
  };
  const tv = (i, j) => {
    for (let k = 0; k <= nu; k++) {
      if (i + k <= nu && diff(V, at(i + k, j + 1), at(i + k, j - 1))) return;
      if (k && i - k >= 0 && diff(V, at(i - k, j + 1), at(i - k, j - 1))) return;
    }
    V[0] = 0; V[1] = -1; V[2] = 0;
  };
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) {
      tu(i, j); tv(i, j);
      const ux = U[0], uy = U[1], uz = U[2], vx = V[0], vy = V[1], vz = V[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      let l = Math.hypot(nx, ny, nz);
      if (!(l > 1e-9)) { nx = 0; ny = 1; nz = 0; l = 1; }   // tangents parallel: face up
      nx /= l; ny /= l; nz /= l;
      if (flip) { nx = -nx; ny = -ny; nz = -nz; }
      const p = at(i, j);
      t.v(p[0], p[1], p[2], nx, ny, nz, p[3], p[1], shade * (p[5] ?? 1), p[4]);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    if (flip) t.ix6(a, b, c, b, d, c); else t.ix6(a, c, b, b, c, d);
  }
}

/**
 * Scalloped valance hanging from a top edge: nS semicircular lobes (radius R) of equal
 * width with a 2 cm binding tape along the edge. Vertices land exactly on the cusps
 * (6 per lobe near, 4 far). edge(s) → [x, y, z] of the top edge at arc length s;
 * out(s) the outward normal in xz.
 */
function valance(t, total, valH, q, at) {
  const nS = Math.max(1, Math.round(total / 0.25)), per = total / nS;
  const R = Math.min(0.06, per * 0.36);
  const NL = q >= 0.5 ? 12 : 4, nvu = nS * NL;
  // lobes are cut and hang a little unevenly (±7 mm, deterministic per lobe)
  const lobeK = (k) => { const h = Math.sin(k * 78.233 + total * 12.9898) * 43758.5453; return (h - Math.floor(h) - 0.5) * 0.014; };
  // each lobe a half ellipse; where two meet the cut is rounded (a smooth maximum of the
  // two lobes, ~1.2 cm fillet) instead of a sharp notch
  const lobeD = (s, k) => { const x = (s - (k + 0.5) * per) / (per / 2); return valH - R + R * Math.sqrt(Math.max(0, 1 - x * x)) + lobeK(k); };
  const RHO = 0.012;
  const depth = (s) => {
    if (q < 0.5) return valH;
    const k = Math.min(nS - 1, Math.floor(s / per)), f = s / per - k;
    const a = lobeD(s, k), b = lobeD(s, f < 0.5 ? k - 1 : k + 1);
    return (a + b + Math.sqrt((a - b) * (a - b) + RHO * RHO)) / 2 - RHO * 0.3;
  };
  // vertices crowd towards the cuts, where the hem turns fastest
  const warp = (a) => {
    if (q < 0.5) return a * total;
    const x = a * nS, k = Math.min(nS - 1, Math.floor(x)), f = x - k;
    return (k + (1 - Math.cos(Math.PI * f)) / 2) * per;
  };
  // rows: top edge, top of the binding, binding, bottom edge
  const rows = q >= 0.5 ? [[0, 1], [-0.022, 0.97], [-0.02, 0.72], [0, 0.72]] : [[0, 1], [0, 0.9]];
  surface(t, nvu, rows.length - 1, (a, b) => {
    const s = warp(a), j = Math.round(b * (rows.length - 1));
    const h = depth(s);
    const [dy, shade] = rows[j];
    const y = j === 0 ? 0 : -h - dy;
    const e = at(s);
    // the hem flutters in the wind (flex), the top edge is held by the bar
    return pt(e[0], e[1] + y, e[2], s, j === 0 ? 0 : 0.7, shade * (1 - 0.12 * Math.min(1, -y / valH)));
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
    // the cloth sags between the roller and the front bar (more between the arms, ~1–2 cm
    // dips between the roller's supports every metre), and creases near the cassette
    const bays = Math.max(1, Math.round(W / 1.0));
    const sag = Math.sin(Math.PI * b) * (0.03 * (0.6 + 0.4 * Math.sin(Math.PI * a)) + 0.012 * Math.abs(Math.sin(Math.PI * a * bays)));
    const crease = q >= 0.5 ? 0.006 * Math.max(0, 1 - b / 0.25) * Math.sin(x * 21 + Math.sin(x * 7) * 2) : 0;
    const y = -D * b - sag + crease, z = P * b;
    return pt(x, y, z, x + W / 2, Math.sin(Math.PI * b) * (0.4 + 0.6 * Math.sin(Math.PI * a)), 1 - 0.1 * Math.max(0, 1 - b / 0.15));
  });
  // hem tube wrapped round the front bar
  if (q >= 0.5) {
    const ring = [];
    for (let k = 0; k <= 4; k++) { const a = (k / 4) * Math.PI * 1.5 - Math.PI * 0.25; ring.push([Math.cos(a) * 0.022, Math.sin(a) * 0.022]); }
    surface(t, Math.max(2, Math.round(W / 0.3)), ring.length - 1, (a, b) => {
      const x = -W / 2 + W * a, [dz, dy] = ring[Math.round(b * (ring.length - 1))];
      return pt(x, -D + 0.004 + dy, P - 0.012 + dz, x + W / 2, 0, 0.9);
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
      // folding arm from the wall (lower) to the front bar: two round tubes and the elbow
      // joint between them, on a wall bracket
      const ex = x - s * 0.06, ey = (-0.45 - D) / 2 + 0.06, ez = P * 0.55;
      tube(m, [x, -0.45, 0.04], [ex, ey, ez], 0.016, 16);
      tube(m, [ex, ey, ez], [x, -D - 0.01, P - 0.03], 0.014, 16);
      tube(m, [ex - 0.03, ey, ez], [ex + 0.03, ey, ez], 0.026, 16);
      m.box(x - 0.04, -0.52, 0, x + 0.04, -0.38, 0.05, 1 | 4 | 8 | 16 | 32, 0.85, 1);
    }
  }
  return { canvas: t.bake(), metal: m.bake() };
}

/** Round tube of radius rr between two 3D points, n facets, both ends capped. */
function tube(m, a, b, rr, n = 16) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L = Math.hypot(dx, dy, dz) || 1, d = [dx / L, dy / L, dz / L];
  const r0 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const rd = r0[0] * d[0] + r0[1] * d[1] + r0[2] * d[2];
  const u = [r0[0] - d[0] * rd, r0[1] - d[1] * rd, r0[2] - d[2] * rd], ul = Math.hypot(...u);
  u[0] /= ul; u[1] /= ul; u[2] /= ul;
  const w = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const base = m.count;
  for (let k = 0; k <= n; k++) {
    const ang = (k / n) * Math.PI * 2, c = Math.cos(ang), sn = Math.sin(ang);
    const nx = u[0] * c + w[0] * sn, ny = u[1] * c + w[1] * sn, nz = u[2] * c + w[2] * sn;
    m.v(a[0] + nx * rr, a[1] + ny * rr, a[2] + nz * rr, nx, ny, nz, ang * rr, 0, 0.9);
    m.v(b[0] + nx * rr, b[1] + ny * rr, b[2] + nz * rr, nx, ny, nz, ang * rr, L, 1);
  }
  for (let k = 0; k < n; k++) { const i = base + k * 2; m.ix6(i, i + 2, i + 1, i + 1, i + 2, i + 3); }
  for (const [p, sg] of [[a, -1], [b, 1]]) {
    const c0 = m.v(p[0], p[1], p[2], d[0] * sg, d[1] * sg, d[2] * sg, 0, 0, 0.95);
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      const q0 = m.v(p[0] + (u[0] * Math.cos(a0) + w[0] * Math.sin(a0)) * rr, p[1] + (u[1] * Math.cos(a0) + w[1] * Math.sin(a0)) * rr, p[2] + (u[2] * Math.cos(a0) + w[2] * Math.sin(a0)) * rr, d[0] * sg, d[1] * sg, d[2] * sg, 0, 0, 0.95);
      const q1 = m.v(p[0] + (u[0] * Math.cos(a1) + w[0] * Math.sin(a1)) * rr, p[1] + (u[1] * Math.cos(a1) + w[1] * Math.sin(a1)) * rr, p[2] + (u[2] * Math.cos(a1) + w[2] * Math.sin(a1)) * rr, d[0] * sg, d[1] * sg, d[2] * sg, 0, 0, 0.95);
      if (sg > 0) m.tri(c0, q0, q1); else m.tri(c0, q1, q0);
    }
  }
}

/** Square-section bar between two 3D points. */
function armBox(m, a, b, s) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L = Math.hypot(dx, dy, dz) || 1;
  const d = [dx / L, dy / L, dz / L];
  // side vector (x, or up for bars running along x: the rim of a dutch hood's front) made
  // square to the bar, and the perpendicular d × side
  const r = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const rd = r[0] * d[0] + r[1] * d[1] + r[2] * d[2];
  const sx = [r[0] - d[0] * rd, r[1] - d[1] * rd, r[2] - d[2] * rd];
  const sl = Math.hypot(...sx) || 1; sx[0] /= sl; sx[1] /= sl; sx[2] /= sl;
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
const TH0 = 0.02;
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
  const nu = q >= 0.5 ? ribs * 4 : ribs;
  const nv = q >= 0.5 ? 8 : 3;
  // each gore of canvas between two ribs has faded and gathered dirt a little differently
  const gore = (k) => { const h = Math.sin(k * 91.7 + total * 17.3) * 43758.5453; return 0.93 + 0.12 * (h - Math.floor(h)); };
  surface(t, nu, nv, (a, b) => {
    const s = a * total, [xa, dx, dz] = plan(s);
    // 0.02 rad at the wall (top: the caps' poles keep a few mm of edge), π/2 at the bottom edge
    const th = TH0 + b * (Math.PI / 2 - TH0);
    // the canvas sags in between the ribs (most at the panel's middle and towards the
    // hem, where it is held only at the ribs), and creases run down beside each rib
    const rib = (a * ribs) % 1, gi = Math.min(ribs - 1, Math.floor(a * ribs));
    const sg = Math.sin(Math.PI * rib);
    const pleat = q >= 0.5 ? (0.042 * sg + 0.006 * Math.sin(Math.PI * 4 * rib)) * Math.sin(th) * (0.7 + 0.3 * b) : 0;
    const r = R - pleat;
    // shading baked per vertex: dark where the canvas meets the wall (no sky under the
    // cornice), the sagging middle of each gore a little darker, dirt along the hem
    const top = 0.62 + 0.38 * Math.min(1, b / 0.35);
    const hem = 1 - 0.1 * Math.max(0, (b - 0.75) / 0.25);
    return pt(xa + dx * r * Math.sin(th), R * Math.cos(th) - pleat * Math.cos(th) * 0.3, dz * r * Math.sin(th), s, 0.25 * Math.sin(th) * sg, (1 - 0.2 * sg) * top * hem * gore(gi));
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
const cache = new TplCache(400);
const q2 = (x, step) => Math.round(x / step) * step;
/** Cached slopeAwning with dimensions quantised to 1–5 cm. */
export function slopeAwningT(W, P, D, valH, q) {
  W = q2(W, 0.02); P = q2(P, 0.05); D = q2(D, 0.05); valH = q2(valH, 0.02);
  const k = `S|${W.toFixed(2)}|${P.toFixed(2)}|${D.toFixed(2)}|${valH.toFixed(2)}|${q}`;
  return cache.get(k, () => slopeAwning(W, P, D, valH, q));
}
/** Cached domeAwning with dimensions quantised to 1–2 cm. */
export function domeAwningT(W, R, valH, q) {
  W = q2(W, 0.02); R = q2(R, 0.01); valH = q2(valH, 0.02);
  const k = `D|${W.toFixed(2)}|${R.toFixed(2)}|${valH.toFixed(2)}|${q}`;
  return cache.get(k, () => domeAwning(W, R, valH, q));
}

export function awningColors(rng) {
  if (rng.chance(0.38)) {
    const [a, b] = rng.pick(STRIPES);
    return { c1: lin(AWNING_COLORS[a]), c2: lin(AWNING_COLORS[b]), period: rng.pick([0.2, 0.25, 0.3, 0.12]) };
  }
  const c = lin(AWNING_COLORS[rng.weighted([['cream', 0.14], ['white', 0.06], ['green', 0.1], ['burgundy', 0.08], ['navy', 0.07], ['terracotta', 0.08],
    ['ochre', 0.04], ['red', 0.14], ['orange', 0.1], ['royal', 0.08], ['mustard', 0.08], ['forest', 0.03]])]);
  return { c1: c, c2: c, period: 0 };
}
