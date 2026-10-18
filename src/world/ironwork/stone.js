import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { normalizeAttributes } from '../../core/geom.js';
import { GeoWriter, sweepPath, sweepPathPos, insetPath, capPolygon, sweepBar, box, boxPos, lathe, shared, posTemplate, weldTemplate } from './geo.js';

// Carved limestone parts of a balcony: the moulded slab, the scroll consoles (corbels)
// that carry it, and the turned-baluster stone balustrade alternative.
// Facade-local coordinates: u along the wall, v up, w out of the wall (see facadePlan).

/** Slab edge moulding [o, v, occlusion] relative to the outer edge (o ≤ 0) and the slab
 *  top (v = 0), ordered from the top edge down to the soffit at v = −T. The moulded edge
 *  is E tall (E ≥ T): its lip hangs E − T below the soffit, with a drip groove cut in
 *  its underside, and steps back up to the soffit in a chamfer.
 *    0 classical: eased arris, fascia, ovolo, fillet band, drip lip
 *    1 plainer (Mandate): fascia with a sunk shadow line, rounded lower arris, drip lip
 *  The light level (lod) keeps the silhouette: fascia, a chamfer for the mouldings, lip. */
export function slabProfile(T, E, variant, lod) {
  const lip = Math.max(0, E - T), k = E / 0.2;
  const p = [[-0.01, 0], [0, -0.01]];
  let back;
  if (lod) {
    p.push([0, -0.45 * E], [-0.05, -0.8 * E]);
    back = -0.07;
  } else if (variant === 1) {
    const r = 0.03;
    p.push([0, -0.06 * k], [-0.012, -0.072 * k], [-0.012, -E + r]);
    for (let i = 1; i <= 3; i++) { const a = -(i / 3) * Math.PI / 2; p.push([-0.012 - r + r * Math.cos(a), -E + r + r * Math.sin(a)]); }
    p.push([-0.064, -E], [-0.064, -E + 0.016], [-0.078, -E + 0.016], [-0.078, -E]);
    back = -0.09;
  } else {
    p.push([0, -0.075 * k], [-0.007, -0.082 * k]);
    const rx = 0.038, ry = 0.055 * k, cx = -0.007 - rx, cy = -0.082 * k;
    for (let i = 1; i <= 4; i++) { const a = -(i / 4) * Math.PI / 2; p.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    p.push([-0.052, cy - ry], [-0.052, -E + 0.006], [-0.058, -E]);
    p.push([-0.072, -E], [-0.072, -E + 0.016], [-0.086, -E + 0.016], [-0.086, -E]);
    back = -0.1;
  }
  // chamfer up to the soffit (a lip of a few millimetres stays flush)
  if (lip > 0.004) p.push([back, -E], [back - lip * 1.3, -T]);
  else p.push([back, -T]);
  // occlusion: dirty top arris, darker toward the underside, the groove and the chamfer
  // in the lip's shade
  return p.map(([o, v]) => {
    const t = Math.min(1, -v / E);
    let ao = (t < 0.08 ? 0.82 : 1) * (1 - 0.2 * t * t);
    if (-v > E - 0.02 && o < -0.06 && o > back) ao *= 0.72;   // inside the drip groove
    else if (o <= back) ao *= 0.8;                             // chamfer and soffit edge
    return [o, v, ao];
  });
}

/** Joints of the slab profile shaded smooth (the curved mouldings): [from, to]. */
function slabSmooth(variant, lod) {
  return lod ? [1e9, 0] : [4, 7];
}

/** Plan outline of a balcony slab: wall-left, front-left, front-right, wall-right, with an
 *  optional corner radius (`n` segments per corner). The ends run 0.25 m into the wall so
 *  door recesses get a floor. */
export function slabPath(u0, u1, depth, rc = 0, into = 0.25, n = 5) {
  if (rc <= 0.01) return [[u0, -into], [u0, depth], [u1, depth], [u1, -into]];
  const p = [[u0, -into], [u0, depth - rc]];
  for (let i = 1; i < n; i++) { const a = Math.PI - (i / n) * Math.PI / 2; p.push([u0 + rc + Math.cos(a) * rc, depth - rc + Math.sin(a) * rc]); }
  p.push([u0 + rc, depth], [u1 - rc, depth]);
  for (let i = 1; i < n; i++) { const a = Math.PI / 2 - (i / n) * Math.PI / 2; p.push([u1 - rc + Math.cos(a) * rc, depth - rc + Math.sin(a) * rc]); }
  p.push([u1, depth - rc], [u1, -into]);
  return p;
}

/** Grime kinds recorded per vertex (attribute aGk) for the ironwork stone material. */
export const GRIME = { NONE: 0, EDGE: 1, SOFFIT: 2, CONSOLE: 3 };

/** Writes one balcony slab (sweep + top + soffit) into W (matrix = facade frame): T the
 *  slab's thickness at the wall, E its moulded edge (≥ T). Baked occlusion: dirty top
 *  arris, darker lower edge and drip groove, soffit dark at the wall. */
export function writeSlab(W, path, y, T, E, variant, lod, dirt = 1, depth = 1) {
  const prof = slabProfile(T, E, variant, lod).map(([o, v, ao]) => [o, y + v, ao * dirt]);
  const [sm0, sm1] = slabSmooth(variant, lod);
  W.kind(GRIME.EDGE);
  sweepPath(W, path, prof, { shadeFn: (o, v, j) => prof[j][2], smoothFrom: sm0, smoothTo: sm1 });
  const topO = prof[0][0], botO = prof[prof.length - 1][0];
  W.kind(GRIME.NONE);
  capPolygon(W, insetPath(path, topO), y, 1, 0.92 * dirt);
  W.kind(GRIME.SOFFIT);
  capPolygon(W, insetPath(path, botO), y - T, -1, (u, w) => (0.46 + 0.32 * Math.min(1, Math.max(0, w / depth))) * dirt);
  W.kind(GRIME.NONE);
}

/** Shadow-caster outline of the slab edge: points of the drawn profile only (the ovolo
 *  and the rounded arris reduced to their chords, the drip groove bridged), so the caster
 *  never stands proud of the stone it shades by more than the groove's 16 mm. */
function slabShadowProfile(T, E, variant, lod) {
  const p = slabProfile(T, E, variant, lod).map(([o, v]) => [o, v]);
  if (lod) return p;
  const n = p.length, tail = p.slice(n - (E - T > 0.004 ? 2 : 1));
  if (variant === 1) return [p[0], p[1], p[2], p[3], p[4], p[7], ...tail];
  return [p[0], p[1], p[2], p[3], p[7], p[8], p[10], ...tail];
}

/** Position-only slab (shadow caster) into S (matrix = facade frame): the edge sweep with
 *  one ring per path point, top and soffit fans on its first and last profile points. */
export function writeSlabShadow(S, path, y, T, E, variant, lod) {
  const prof = slabShadowProfile(T, E, variant, lod).map(([o, v]) => [o, y + v]);
  const rings = sweepPathPos(S, path, prof), m = prof.length, n = path.length;
  for (let i = 1; i < n - 1; i++) S.tri(rings[0], rings[i], rings[i + 1]);
  for (let i = 1; i < n - 1; i++) S.tri(rings[0] + m - 1, rings[i + 1] + m - 1, rings[i] + m - 1);
}

// ---------------------------------------------------------------- consoles
// Three kinds (consoles.js CONSOLE): 0 scroll (ancon), 1 tiered, 2 block (a short
// modillion). D deep, W wide, HV[kind] tall as modelled (instances scale them to the
// slab's depth and the room under it); the scroll's pendant knob hangs FOOT below.
export const CORBEL = { D: 0.8, H: 0.62, W: 0.26, HV: [0.62, 0.62, 0.26], FOOT: 0.045 };

/** Console side silhouette in (w, v): v = 0 at the soffit, negative downward. */
function corbelShape(variant, D, Hc) {
  const s = new THREE.Shape();
  if (variant === 0) {
    // ancon: abacus block, big convex roll, long cove to the wall, small pendant knob
    const a = 0.085, R = 0.165, c = 0.025, wb = 0.11;
    const cx = D - c - R;
    s.moveTo(0, 0); s.lineTo(D, 0); s.lineTo(D, -a); s.lineTo(D - c, -a);
    s.absarc(cx, -a, R, 0, -Math.PI / 2, true);
    s.absellipse(cx, -Hc, cx - wb, Hc - a - R, Math.PI / 2, Math.PI, false);
    s.absarc(wb - 0.045, -Hc, 0.045, 0, -Math.PI / 2, true);
    s.lineTo(0, -Hc - 0.045);
    s.lineTo(0, 0);
    return { shape: s, roll: [cx, -a, R, 1] };
  }
  if (variant === 2) {
    // block: abacus plate, ovolo nose, then a long cove sweeping down to the wall foot
    const a = 0.04, c = 0.014, r = 0.07, ry = r * 0.85, fx = 0.05;
    const cx = D - c - r;
    s.moveTo(0, 0); s.lineTo(D, 0); s.lineTo(D, -a); s.lineTo(D - c, -a);
    s.absellipse(cx, -a, r, ry, 0, -Math.PI / 2, true);
    s.absellipse(cx, -Hc, cx - fx, Hc - a - ry, Math.PI / 2, Math.PI, false);
    s.lineTo(0, -Hc);
    s.lineTo(0, 0);
    return { shape: s, roll: [cx, -a, r, ry / r] };
  }
  // tiered: three stacked mouldings stepping back to the wall
  const t1 = 0.075;
  s.moveTo(0, 0); s.lineTo(D, 0); s.lineTo(D, -t1); s.lineTo(D - 0.03, -t1);
  s.absellipse(D - 0.03 - 0.1, -t1, 0.1, 0.12, 0, -Math.PI / 2, true);           // ovolo
  const d2 = D - 0.13, y2 = -t1 - 0.12;
  s.lineTo(d2 - 0.02, y2); s.lineTo(d2 - 0.02, y2 - 0.05);
  s.absellipse(d2 - 0.02, y2 - 0.05 - 0.16, 0.22, 0.16, Math.PI / 2, Math.PI, false); // cove
  const d3 = d2 - 0.24, y3 = y2 - 0.21;
  s.lineTo(d3 - 0.015, y3); s.lineTo(d3 - 0.015, y3 - 0.03);
  const rest = Math.max(0.08, Hc - (-(y3 - 0.03)));
  s.absellipse(0.05, y3 - 0.03, d3 - 0.065, rest, 0, -Math.PI / 2, true);           // final ovolo
  s.lineTo(0, y3 - 0.03 - rest);
  s.lineTo(0, 0);
  return { shape: s, roll: null };
}

/** Shared console geometry with baked occlusion in vertex colours. Local frame:
 *  x = along the wall (centred), y = down from the soffit (≤ 0), z = out of the wall. */
export function corbelGeometry(variant, lod) {
  const { D, W: Wc } = CORBEL, Hc = CORBEL.HV[variant];
  const { shape, roll } = corbelShape(variant, D, Hc);
  // the light level drops the 12 mm bevel (8 mm on the small block) and the carved
  // volutes (sub-pixel where it is used) but keeps the silhouette: 4 segments per curve
  // hold the big roll within ~5 mm; the far level (merged into far chunks, 200 m and
  // more away) has 2, within ~2.5 cm
  const bev = lod ? 0 : variant === 2 ? 0.008 : 0.012;
  const ext = new THREE.ExtrudeGeometry(shape, {
    depth: Wc - 2 * bev, bevelEnabled: !lod, bevelThickness: bev, bevelSize: bev, bevelSegments: 1,
    curveSegments: lod > 1 ? 2 : lod ? 4 : 6,
  });
  let parts = [ext];
  if (roll && !lod) {
    // volute spirals carved on both flanks of the roll (the block's nose: smaller, and
    // flattened with it)
    const [cx, cy, R, ky] = roll, k = Math.max(0.6, R / 0.165);
    const pts = [];
    const turns = 1.55, n = 16;
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = -t * turns * Math.PI * 2;
      const r = R * 0.86 * Math.pow(0.17, t);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * ky]);
    }
    const S = new GeoWriter();
    sweepBar(S, pts, 0.011 * k, 0.007 * k, { z0: -bev - 0.002 });
    sweepBar(S, pts, 0.011 * k, 0.007 * k, { z0: Wc - bev + 0.002 });
    // domed eye bosses at the spiral centres (lathe axis turned to -z / +z)
    const eye = [[0.03, 0], [0.028, 0.008], [0.014, 0.015], [0.0001, 0.017]].map(([x, y]) => [x * k, y * k]);
    for (const [z, rot] of [[-bev, -Math.PI / 2], [Wc - bev, Math.PI / 2]]) {
      S.setMatrix(new THREE.Matrix4().makeRotationX(rot).setPosition(cx, cy, z));
      lathe(S, eye, 8);
    }
    parts.push(S.toGeometry({ colors: false }));
  }
  parts = normalizeAttributes(parts);
  let g = parts.length > 1 ? mergeGeometries(parts, false) : parts[0];
  // shape space (x = w, y = v, z = extrusion) -> local (x = u centred, y = v, z = w)
  g.rotateY(-Math.PI / 2);
  g.translate(Wc / 2 - bev, 0, 0);
  // baked occlusion: the junction under the slab, against the wall, and on the
  // down-facing coves that only see the street below
  const pos = g.attributes.position, nrm = g.attributes.normal, n = pos.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i), z = pos.getZ(i), ny = nrm.getY(i);
    let ao = (1 - 0.4 * Math.exp(y / 0.04)) * (1 - 0.3 * Math.exp(-Math.max(0, z) / 0.08)) * (0.88 + 0.12 * Math.min(1, -y / Hc));
    if (ny < -0.3) ao *= 1 - 0.2 * Math.min(1, (-ny - 0.3) / 0.5);
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aGk', new THREE.BufferAttribute(new Float32Array(n).fill(GRIME.CONSOLE), 1));
  g.computeBoundingSphere();
  return shared(g);
}

/** The far console as a template for the merged stone mesh of far chunks (no draw call
 *  of its own): soot low on the scroll baked into its colour, as the near consoles get it
 *  from the grime shader (their streaks are sub-pixel at that range). Welded: the
 *  extrusion's facets along the scroll share smooth vertices (a third of the count). */
export function corbelTemplate(variant) {
  const g = corbelGeometry(variant, 2);
  const n = g.attributes.position.count, C = g.attributes.color.array.slice(), P = g.attributes.position.array;
  for (let i = 0; i < n; i++) {
    const y = P[i * 3 + 1], t = Math.min(1, Math.max(0, (y + 0.6) / 0.35)), soot = 1 - 0.1 * (1 - t * t * (3 - 2 * t));
    C[i * 3] *= soot; C[i * 3 + 1] *= soot; C[i * 3 + 2] *= soot;
  }
  const I = g.index ? g.index.array.slice() : Uint32Array.from({ length: n }, (_, i) => i);
  return weldTemplate({ P: P.slice(), N: g.attributes.normal.array.slice(), T: g.attributes.uv.array.slice(), C, I, n });
}

// ---------------------------------------------------------------- stone balustrade
export const BALUSTRADE = { H: 1.0, PLINTH: 0.12, COPING: 0.12, SPACING: 0.2 };

/** Turned vase baluster between plinth and coping; local origin at its foot. */
export function balusterGeometry(lod) {
  const h = BALUSTRADE.H - BALUSTRADE.PLINTH - BALUSTRADE.COPING;
  const k = h / 0.56;
  const prof = [[0.05, 0], [0.05, 0.035], [0.04, 0.05], [0.036, 0.065], [0.047, 0.1], [0.062, 0.16], [0.066, 0.2],
    [0.058, 0.26], [0.042, 0.33], [0.03, 0.4], [0.027, 0.44], [0.034, 0.47], [0.044, 0.49], [0.044, 0.515], [0.05, 0.525], [0.05, 0.56]]
    .map(([r, y]) => [r, y * k]);
  const W = new GeoWriter();
  // light: the vase silhouette on a coarse lathe (a square shaft reads as a plain post
  // while balusters are still several pixels wide)
  if (lod) lathe(W, [0, 3, 5, 6, 8, 10, 12, 15].map((i) => prof[i]), 6);
  else {
    lathe(W, prof, 10);
    box(W, 0, 0.012, 0, 0.11, 0.024, 0.11); box(W, 0, h - 0.012, 0, 0.11, 0.024, 0.11);
  }
  const g = W.toGeometry();
  // occlusion: darker at the neck and near the plinth
  const pos = g.attributes.position, col = g.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / h;
    const ao = (0.8 + 0.2 * Math.min(1, y * 5)) * (1 - 0.12 * Math.max(0, (y - 0.85) * 6.6));
    col.setXYZ(i, ao, ao, ao);
  }
  return shared(g);
}

/** Shadow casters of the stone parts (welded positions): consoles [variant] and the
 *  baluster, coarse. The console's outline keeps two segments per curve: chords lie
 *  inside the convex roll (lit), outside only the coves underneath, which face away
 *  from the sun and sit in the console's own shade anyway. */
export function shadowTemplates() {
  const corbel = [0, 1, 2].map((variant) => {
    const { shape } = corbelShape(variant, CORBEL.D, CORBEL.HV[variant]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: CORBEL.W, bevelEnabled: false, curveSegments: 2 });
    g.rotateY(-Math.PI / 2);
    g.translate(CORBEL.W / 2, 0, 0);
    return posTemplate(g);
  });
  // baluster: a coarse vase through the drawn profile's waists and bulges (chords inside)
  const h = BALUSTRADE.H - BALUSTRADE.PLINTH - BALUSTRADE.COPING, k = h / 0.56;
  const W = new GeoWriter();
  lathe(W, [[0.05, 0], [0.036, 0.065], [0.066, 0.2], [0.027, 0.44], [0.05, 0.56]].map(([r, y]) => [r, y * k]), 6);
  return { corbel, baluster: posTemplate(W) };
}

/** Position-only balustrade rails (plinth, light coping) and pedestals along `path`. */
export function writeBalustradeShadow(S, path, ped) {
  sweepPathPos(S, path, plinthProfile());
  sweepPathPos(S, path, copingProfile(1));
  const hP = BALUSTRADE.H - BALUSTRADE.PLINTH - BALUSTRADE.COPING;
  for (const P of ped) boxPos(S, P[0], BALUSTRADE.PLINTH + hP / 2, P[1], 0.2, hP, 0.2, 'ud');
}

/** Plinth and coping profiles [o, v] across the balustrade centre line. */
export function plinthProfile() {
  const P = BALUSTRADE.PLINTH;
  return [[-0.085, 0], [-0.085, P - 0.012], [-0.075, P], [0.075, P], [0.085, P - 0.012], [0.085, 0]];
}
export function copingProfile(lod) {
  const H = BALUSTRADE.H, C = BALUSTRADE.COPING;
  if (lod) return [[-0.09, H - C], [-0.1, H], [0.1, H], [0.09, H - C], [-0.09, H - C]];
  return [[-0.08, H - C], [-0.08, H - C + 0.04], [-0.1, H - C + 0.055], [-0.1, H - 0.012], [-0.09, H],
    [0.09, H], [0.1, H - 0.012], [0.1, H - C + 0.055], [0.08, H - C + 0.04], [0.08, H - C], [-0.08, H - C]];
}

// ---------------------------------------------------------------- weathered stone material
// stone.smooth (with vertex tint/AO) plus balcony weathering, by grime kind (aGk):
//   EDGE     slab front: water-borne dirt streaks down the face, a dark crust along the
//            drip edge, now and then a rust tail where a railing post is leaded in
//   SOFFIT   mottled soot, darker toward the wall (the gradient itself is baked)
//   CONSOLE  streaks down the scroll faces and soot in the lower coves
// High-frequency terms fade out as they approach pixel size, so nothing shimmers.
const GRIME_GLSL = /* glsl */ `
float gwH( vec2 p ) { vec3 q = fract( vec3( p.xyx ) * 0.1031 ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
float gwN( vec2 p ) {
	vec2 i = floor( p ), t = fract( p ); t = t * t * ( 3.0 - 2.0 * t );
	return mix( mix( gwH( i ), gwH( i + vec2( 1, 0 ) ), t.x ), mix( gwH( i + vec2( 0, 1 ) ), gwH( i + vec2( 1, 1 ) ), t.x ), t.y );
}
// vertical streak field: x across the streaks (m), y down the face (m), pixel footprint fx
float gwStreaks( float x, float y, float fx ) {
	float a = gwN( vec2( x * 7.0, y * 1.3 ) ), b = gwN( vec2( x * 19.0 + 7.1, y * 2.1 ) );
	float s = smoothstep( 0.5, 0.95, a ) * 0.65 + smoothstep( 0.55, 0.98, b ) * 0.45 * ( 1.0 - smoothstep( 0.02, 0.06, fx ) );
	return s * ( 1.0 - smoothstep( 0.05, 0.2, fx ) );
}`;

export function makeStoneMaterial(app) {
  const base = app.materials.get('stone.smooth', { vertexColors: true });
  const m = base.clone(); // keeps the library surface patch
  m.name = 'ironwork.stone';
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (sh, r) {
    if (prev) prev.call(this, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aGk;
varying float vGk;
varying vec2 vGuv;
varying vec3 vGl;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
	vGk = aGk;
	vGuv = uv;
	vGl = position;
	#ifdef USE_INSTANCING
		// per console: offset the pattern by the instance position
		vGl.x += dot( instanceMatrix[ 3 ].xyz, vec3( 0.37, 0.11, 0.53 ) );
	#endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vGk;
varying vec2 vGuv;
varying vec3 vGl;
${GRIME_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	if ( vGk > 0.5 ) {
		vec3 gTint = vec3( 1.0 );
		float gDark = 0.0;
		if ( vGk < 1.5 ) {
			// slab edge: u along the front, v = depth below the slab top
			float fx = fwidth( vGuv.x );
			float d = vGuv.y;
			gDark = gwStreaks( vGuv.x, d, fx ) * mix( 0.12, 0.3, smoothstep( 0.0, 0.18, d ) );
			gDark += 0.22 * smoothstep( 0.1, 0.22, d ) * ( 0.6 + 0.4 * gwN( vec2( vGuv.x * 3.0, 1.7 ) ) );
			float rust = smoothstep( 0.83, 0.95, gwN( vec2( vGuv.x * 4.3 + 11.0, 0.5 ) ) ) * ( 1.0 - smoothstep( 0.05, 0.2, fx ) );
			gTint = mix( vec3( 1.0 ), vec3( 0.72, 0.52, 0.38 ), rust * 0.75 );
		} else if ( vGk < 2.5 ) {
			// soffit: mottled soot
			float n = gwN( vGuv * 2.3 ) * 0.6 + gwN( vGuv * 7.1 + 3.3 ) * 0.4;
			gDark = 0.06 + 0.2 * smoothstep( 0.35, 0.85, n );
		} else {
			// console: streaks down the faces, soot low on the scroll
			float fx = fwidth( vGl.x );
			gDark = gwStreaks( vGl.x + vGl.z * 0.7, -vGl.y, fx ) * 0.22;
			gDark += 0.1 * ( 1.0 - smoothstep( -0.6, -0.25, vGl.y ) );
		}
		diffuseColor.rgb *= gTint * ( 1.0 - gDark );
	}`);
  };
  m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|ironStone'; };
  m.needsUpdate = true;
  app.materials.register(m.name, m);
  return m;
}
