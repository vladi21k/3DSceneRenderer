import * as THREE from 'three';
import { GeoWriter, sweepPath, sweepPathPos, insetPath, capPolygon, sweepBar, box, boxPos, lathe, shared, posTemplate, weldTemplate } from './geo.js';
import { centroidColor, NEGLECT_GLSL } from './mats.js';

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

/** Grime kinds recorded per vertex (attribute aGk) for the ironwork stone material
 *  (EDGE: slab edge under an iron railing, PLAIN_EDGE: under a stone balustrade). */
export const GRIME = { NONE: 0, EDGE: 1, SOFFIT: 2, CONSOLE: 3, PLAIN_EDGE: 4 };

/** Writes one balcony slab (sweep + top + soffit) into W (matrix = facade frame): T the
 *  slab's thickness at the wall, E its moulded edge (≥ T). Baked occlusion: dirty top
 *  arris, darker lower edge and drip groove. The soffit darkens smoothly toward the wall
 *  (occlusion times a soot film that thickens toward the wall, 0.08 at the front edge to
 *  0.2 at the wall): no patches, which read as camouflage on a surface this even. */
export function writeSlab(W, path, y, T, E, variant, lod, dirt = 1, depth = 1, iron = true) {
  const prof = slabProfile(T, E, variant, lod).map(([o, v, ao]) => [o, y + v, ao * dirt]);
  const [sm0, sm1] = slabSmooth(variant, lod);
  W.kind(iron ? GRIME.EDGE : GRIME.PLAIN_EDGE);
  sweepPath(W, path, prof, { shadeFn: (o, v, j) => prof[j][2], smoothFrom: sm0, smoothTo: sm1 });
  const topO = prof[0][0], botO = prof[prof.length - 1][0];
  W.kind(GRIME.NONE);
  capPolygon(W, insetPath(path, topO), y, 1, 0.92 * dirt);
  W.kind(GRIME.SOFFIT);
  capPolygon(W, insetPath(path, botO), y - T, -1, (u, w) => {
    const f = Math.min(1, Math.max(0, w / depth));
    return (0.46 + 0.32 * f) * (0.8 + 0.12 * f) * dirt;
  });
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

/** Shape silhouette sampled for one detail level: points [w, v] in order round the
 *  outline (closed, no repeated end) and per point whether it is smooth (inside a curve,
 *  or where two curves meet tangentially) or a crease (the fillets and arrises of the
 *  carving). Arcs get `perQuarter` segments per right angle (fewer on small radii). */
function corbelOutline(shape, perQuarter) {
  const pts = [], smooth = [];
  const push = (x, y, s) => {
    const n = pts.length;
    if (n && Math.abs(pts[n - 1][0] - x) + Math.abs(pts[n - 1][1] - y) < 1e-6) return;
    pts.push([x, y]); smooth.push(s);
  };
  for (const c of shape.curves) {
    if (c.isEllipseCurve) {
      // the swept angle as EllipseCurve.getPoint takes it
      let da = c.aEndAngle - c.aStartAngle;
      const same = Math.abs(da) < Number.EPSILON;
      while (da < 0) da += Math.PI * 2;
      while (da > Math.PI * 2) da -= Math.PI * 2;
      if (da < Number.EPSILON) da = same ? 0 : Math.PI * 2;
      if (c.aClockwise && !same) da = da === Math.PI * 2 ? -da : da - Math.PI * 2;
      const r = Math.max(c.xRadius, c.yRadius);
      const n = Math.max(2, Math.ceil((Math.abs(da) / (Math.PI / 2)) * perQuarter * Math.min(1, Math.sqrt(r / 0.165))));
      for (let i = 0; i < n; i++) { const p = c.getPoint(i / n); push(p.x, p.y, i > 0); }
    } else {
      const p = c.getPoint(0);
      push(p.x, p.y, false);
    }
  }
  const n = pts.length;
  if (Math.abs(pts[0][0] - pts[n - 1][0]) + Math.abs(pts[0][1] - pts[n - 1][1]) < 1e-6) { pts.pop(); smooth.pop(); }
  // a curve's first point is smooth where the outline runs on without turning (a line
  // into a tangent arc, the roll into the cove): chords there turn by half a segment
  const m = pts.length, cosC = Math.cos(0.35);
  for (let i = 0; i < m; i++) {
    if (smooth[i]) continue;
    const a = pts[(i - 1 + m) % m], p = pts[i], b = pts[(i + 1) % m];
    const ux = p[0] - a[0], uy = p[1] - a[1], vx = b[0] - p[0], vy = b[1] - p[1];
    smooth[i] = (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1) > cosC;
  }
  return { pts, smooth };
}

/** Edges and inset of a sampled outline: per edge its outward normal (en, 2 per edge),
 *  arris offset (eo: `bev`, none against the soffit, v = 0, or the wall, w = 0, where
 *  the block is bedded) and arc length at its start (sl); per point the smooth normal
 *  (vn) and the inset point (q): the offset edges' intersection at creases, the offset
 *  along the smooth normal inside the curves. */
function outlineInset(pts, smooth, bev) {
  const n = pts.length;
  // orientation: outward normals on the side away from the interior
  let area = 0;
  for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const sgn = area > 0 ? 1 : -1;
  const en = new Float32Array(n * 2), eo = new Float32Array(n), sl = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    en[i * 2] = (sgn * dy) / l; en[i * 2 + 1] = (-sgn * dx) / l;
    const bed = (Math.abs(a[0]) < 1e-4 && Math.abs(b[0]) < 1e-4) || (Math.abs(a[1]) < 1e-4 && Math.abs(b[1]) < 1e-4);
    eo[i] = bed ? 0 : bev;
    sl[i + 1] = sl[i] + l;
  }
  const q = new Float32Array(n * 2), vn = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = (i - 1 + n) % n, p = pts[i];
    const ax = en[j * 2], ay = en[j * 2 + 1], bx = en[i * 2], by = en[i * 2 + 1];
    let mx = ax + bx, my = ay + by;
    const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
    vn[i * 2] = mx; vn[i * 2 + 1] = my;
    const det = ax * by - ay * bx;
    if (smooth[i] || Math.abs(det) < 0.2) {
      const o = Math.max(eo[j], eo[i]);
      q[i * 2] = p[0] - mx * o; q[i * 2 + 1] = p[1] - my * o;
    } else {
      const o1 = eo[j], o2 = eo[i];
      q[i * 2] = p[0] + (-o1 * by + o2 * ay) / det;
      q[i * 2 + 1] = p[1] + (-o2 * ax + o1 * bx) / det;
    }
  }
  return { en, eo, sl, q, vn };
}

/** Writes the console body (shape extruded Wc wide, flanks at x = ±Wc/2) into W in the
 *  local frame (x along the wall, y = v, z = w). The outline is shaded smooth along its
 *  curves and hard at its creases; every carved arris gets a rounded `bev` margin
 *  (`arr` segments), except where the block meets the soffit and the wall. UVs in metres
 *  that follow the stone without a seam across the faces: on the moulded band u along
 *  the wall and v down the outline's arc length (the band is developable, so the grain
 *  keeps its scale through every curve), on the flanks w and v. */
function writeCorbelBody(W, shape, Wc, bev, arr, perQuarter) {
  const { pts, smooth } = corbelOutline(shape, perQuarter), n = pts.length;
  const { en, eo, sl, q, vn } = outlineInset(pts, smooth, bev);
  // arc length measured from the top front corner, so v follows the height down the front
  let i0 = 0, top = -Infinity;
  for (let i = 0; i < n; i++) if (Math.abs(pts[i][1]) < 1e-4 && pts[i][0] > top) { top = pts[i][0]; i0 = i; }
  const sv = (i) => -(((sl[i] - sl[i0]) % sl[n]) + sl[n]) % sl[n];
  const tri = (a, b, c) => {
    // wound so its face normal agrees with the vertex normals (the writer's buffers may
    // have grown since the vertices were written)
    const P = W.P, N = W.N;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (cx * nx + cy * ny + cz * nz >= 0) W.tri(a, b, c); else W.tri(a, c, b);
  };
  // rings round the outline: per point and side of a crease, the band's edge and the
  // arris down to the flank, both flanks; k = 0 .. arr on each side (k = 0: band edge)
  const K = bev > 0 ? arr : 0, half = Wc / 2;
  const ring = (i, nx, ny, o) => {
    const p = pts[i], dx = q[i * 2] - p[0], dy = q[i * 2 + 1] - p[1], v = sv(i), out = [];
    for (const side of [-1, 1]) {
      for (let k = 0; k <= K; k++) {
        const t = K ? (k / K) * (Math.PI / 2) : 0, c = 1 - Math.cos(t), s = Math.sin(t);
        const x = side * (half - bev + bev * s);
        // a bedded edge keeps its face's normal out to the flank
        const r = o > 0 ? s : 0, f = o > 0 ? Math.cos(t) : 1;
        const l = Math.hypot(r, f) || 1;
        out.push(W.v(x, p[1] + dy * c, p[0] + dx * c, (side * r) / l, (ny * f) / l, (nx * f) / l, x, v));
      }
    }
    return out;
  };
  // per edge, its own rings at both ends (shared where the point between is smooth; the
  // first point, the soffit-wall corner, is a crease, so the band closes on fresh rings)
  let prevEnd = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, o = eo[i];
    const a = smooth[i] && prevEnd ? prevEnd : ring(i, smooth[i] ? vn[i * 2] : en[i * 2], smooth[i] ? vn[i * 2 + 1] : en[i * 2 + 1], o);
    const b = ring(j, smooth[j] ? vn[j * 2] : en[i * 2], smooth[j] ? vn[j * 2 + 1] : en[i * 2 + 1], o);
    prevEnd = smooth[j] ? b : null;
    // band, then the arris strips of both sides
    const L = K + 1;
    tri(a[0], a[L], b[L]); tri(a[0], b[L], b[0]);
    for (let k = 0; k < K; k++) {
      tri(a[k], a[k + 1], b[k + 1]); tri(a[k], b[k + 1], b[k]);
      tri(a[L + k], a[L + k + 1], b[L + k + 1]); tri(a[L + k], b[L + k + 1], b[L + k]);
    }
  }
  // flanks: the inset outline triangulated
  const contour = [];
  for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(q[i * 2], q[i * 2 + 1]));
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const side of [-1, 1]) {
    const base = W.count;
    for (let i = 0; i < n; i++) W.v(side * half, q[i * 2 + 1], q[i * 2], side, 0, 0, q[i * 2] * side, q[i * 2 + 1]);
    for (const f of faces) tri(base + f[0], base + f[1], base + f[2]);
  }
}

/** Shared console geometry with baked occlusion in vertex colours. Local frame:
 *  x = along the wall (centred), y = down from the soffit (≤ 0), z = out of the wall. */
export function corbelGeometry(variant, lod) {
  const { D, W: Wc } = CORBEL, Hc = CORBEL.HV[variant];
  const { shape, roll } = corbelShape(variant, D, Hc);
  // full level: 24 segments per right angle on the big curves (shaded smooth, so the
  // roll and the cove read as one carved surface), a rounded 12 mm arris (8 mm on the
  // small block). The light level drops the arris and the carved volutes (sub-pixel
  // where it is used) and keeps the silhouette with 8 segments per right angle; the far
  // level (merged into far chunks, 200 m and more away) has 3, within ~6 mm
  const bev = lod ? 0 : variant === 2 ? 0.008 : 0.012;
  const W = new GeoWriter(lod ? 256 : 2048);
  writeCorbelBody(W, shape, Wc, bev, 2, lod > 1 ? 3 : lod ? 8 : 24);
  if (roll && !lod) {
    // volute spirals carved on both flanks of the roll (the block's nose: smaller, and
    // flattened with it), drawn in the silhouette's plane (x = w, y = v, z across from
    // the flank at z = -bev) and turned into the local frame
    const M = new THREE.Matrix4().set(0, 0, -1, Wc / 2 - bev, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
    const [cx, cy, R, ky] = roll, k = Math.max(0.6, R / 0.165);
    const pts = [];
    const turns = 1.55, n = 16;
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = -t * turns * Math.PI * 2;
      const r = R * 0.86 * Math.pow(0.17, t);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * ky]);
    }
    W.setMatrix(M);
    sweepBar(W, pts, 0.011 * k, 0.007 * k, { z0: -bev - 0.002 });
    sweepBar(W, pts, 0.011 * k, 0.007 * k, { z0: Wc - bev + 0.002 });
    // domed eye bosses at the spiral centres (lathe axis turned to -z / +z)
    const eye = [[0.03, 0], [0.028, 0.008], [0.014, 0.015], [0.0001, 0.017]].map(([x, y]) => [x * k, y * k]);
    for (const [z, rot] of [[-bev, -Math.PI / 2], [Wc - bev, Math.PI / 2]]) {
      W.setMatrix(M.clone().multiply(new THREE.Matrix4().makeRotationX(rot).setPosition(cx, cy, z)));
      lathe(W, eye, 8);
    }
    W.setMatrix(null);
  }
  const g = W.toGeometry({ colors: false, copy: true });
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
    const y = P[i * 3 + 1], t = Math.min(1, Math.max(0, (y + 0.6) / 0.35)), soot = 1 - 0.13 * (1 - t * t * (3 - 2 * t));
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

/** Console shadow caster {P, I, n} (local frame as corbelGeometry): the silhouette with
 *  8 segments per right angle, held INSET inside the carved faces (bedded on the
 *  soffit and the wall), so no chord across a cove (sagitta up to ~3 mm) stands proud of
 *  the smooth stone it shades. */
const INSET = 0.005;
function corbelCaster(variant) {
  const { shape } = corbelShape(variant, CORBEL.D, CORBEL.HV[variant]);
  const { pts, smooth } = corbelOutline(shape, 8), n = pts.length;
  const { en, q } = outlineInset(pts, smooth, INSET), h = CORBEL.W / 2;
  const P = new Float32Array(n * 2 * 3), I = [];
  for (let i = 0; i < n; i++) {
    P.set([-h, q[i * 2 + 1], q[i * 2]], i * 6);
    P.set([h, q[i * 2 + 1], q[i * 2]], i * 6 + 3);
  }
  // wound to face out: (b - a) x (c - a) along the expected normal
  const tri = (a, b, c, nx, ny, nz) => {
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const d = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    if (d >= 0) I.push(a, b, c); else I.push(a, c, b);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ny = en[i * 2 + 1], nz = en[i * 2];
    tri(i * 2, i * 2 + 1, j * 2 + 1, 0, ny, nz); tri(i * 2, j * 2 + 1, j * 2, 0, ny, nz);
  }
  const contour = [];
  for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(q[i * 2], q[i * 2 + 1]));
  for (const f of THREE.ShapeUtils.triangulateShape(contour, [])) {
    tri(f[0] * 2, f[1] * 2, f[2] * 2, -1, 0, 0);
    tri(f[0] * 2 + 1, f[1] * 2 + 1, f[2] * 2 + 1, 1, 0, 0);
  }
  return { P, I: new Uint32Array(I), n: n * 2 };
}

/** Shadow casters of the stone parts (welded positions): consoles [variant] (see
 *  corbelCaster) and the baluster, coarse. */
export function shadowTemplates() {
  const corbel = [0, 1, 2].map(corbelCaster);
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
//            drip edge; under iron railings rust tails from the bar feet leaded into
//            the slab and a rust-brown wash along its top, as far as the railing is
//            neglected (mats.js iwNeglect, sampled where the railing stands)
//   PLAIN_EDGE  the same without rust (under stone balustrades)
//   SOFFIT   nothing per pixel: its smooth soot gradient toward the wall is baked
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
    // (the baked occlusion steps sharply across the mouldings' narrow faces: see mats.js)
    centroidColor(sh);
    // (the railing's neglect too, and clamped: far slab edges are slivers, see mats.js)
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aGk;
varying float vGk;
varying vec2 vGuv;
varying vec3 vGl;
varying vec3 vGw;
varying vec3 vGnl;
centroid varying float vGn;
${NEGLECT_GLSL}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
#if defined( USE_INSTANCING ) && defined( USE_MAP )
	// every console cut from its own part of the stone (one shared mesh, one uv layout)
	vMapUv += mod( vec2( dot( instanceMatrix[ 3 ].xyz, vec3( 0.37, 0.11, 0.53 ) ), dot( instanceMatrix[ 3 ].xyz, vec3( 0.23, 0.71, 0.19 ) ) ), 16.0 );
#endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
	vGk = aGk;
	vGuv = uv;
	vGl = position;
	vGnl = normal;
	vGw = vec3( 0.0 );
	vGn = 0.0;
	#ifdef USE_INSTANCING
	{
		// consoles: facade metres (along the wall, height, out of the wall), so their
		// weathering hangs plumb and differs from console to console
		vec3 gp = ( modelMatrix * ( instanceMatrix * vec4( position, 1.0 ) ) ).xyz;
		vec3 ga = mat3( modelMatrix ) * instanceMatrix[ 0 ].xyz;
		vec2 gu = normalize( ga.xz + vec2( 1e-6, 0.0 ) );
		vGw = vec3( dot( gp.xz, gu ), gp.y, dot( gp.xz, vec2( -gu.y, gu.x ) ) );
	}
	#endif
	// (slab edges are merged in world space: the railing above stands about 0.5 m higher)
	if ( aGk > 0.5 && aGk < 1.5 ) vGn = iwNeglect( ( modelMatrix * vec4( position + vec3( 0.0, 0.5, 0.0 ), 1.0 ) ).xyz );`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vGk;
varying vec2 vGuv;
varying vec3 vGl;
varying vec3 vGw;
varying vec3 vGnl;
centroid varying float vGn;
${GRIME_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	if ( vGk > 0.5 ) {
		vec3 gTint = vec3( 1.0 );
		float gDark = 0.0;
		if ( vGk < 1.5 || vGk > 3.5 ) {
			// slab edge: u along the front, v = depth below the slab top
			float fx = fwidth( vGuv.x );
			float d = vGuv.y;
			gDark = gwStreaks( vGuv.x, d, fx ) * mix( 0.12, 0.3, smoothstep( 0.0, 0.18, d ) );
			gDark += 0.22 * smoothstep( 0.1, 0.22, d ) * ( 0.6 + 0.4 * gwN( vec2( vGuv.x * 3.0, 1.7 ) ) );
			if ( vGk < 1.5 ) {
				// rust tails from the bar feet: each 16 cm of the front may hold one, the
				// more the railing is neglected (now and then even under kept-up iron): soft,
				// 2-4 cm wide where they leave the bar, spreading and fading over 8-40 cm,
				// uneven along their length; where a pixel is wider than a tail they fade into
				// their mean tint. Over them a rust-brown wash along the top under neglected iron.
				float cx = vGuv.x / 0.16, cell = floor( cx );
				float h1 = gwH( vec2( cell, 3.7 ) ), h2 = gwH( vec2( cell, 9.1 ) ), h3 = gwH( vec2( cell, 5.3 ) );
				float gn = clamp( vGn, 0.0, 1.0 );
				float p = gn * 0.42 + 0.03;
				float len = mix( 0.08, 0.4, h3 * h3 ), f = clamp( d / len, 0.0, 1.0 );
				float w = ( 0.01 + 0.01 * h2 ) * ( 1.0 + 1.2 * f ) / 0.16;
				float dx = ( fract( cx ) - 0.2 - 0.6 * h2 ) / w;
				float tail = step( h1, p ) * exp( -dx * dx ) * ( 1.0 - f * f ) * ( 0.6 + 0.4 * fract( h1 * 7.31 ) )
					* ( 0.55 + 0.45 * gwN( vec2( vGuv.x * 37.0, d * 14.0 ) ) );
				float mean = p * 0.1 * ( 1.0 - smoothstep( 0.0, 0.35, d ) );
				float rs = mix( tail, mean, smoothstep( 0.01, 0.03, fx ) );
				rs = max( rs, gn * 0.35 * ( 1.0 - smoothstep( 0.0, 0.09, d ) ) * ( 0.4 + 0.6 * gwN( vec2( vGuv.x * 6.0, 2.9 ) ) ) );
				gTint = mix( vec3( 1.0 ), vec3( 0.56, 0.34, 0.2 ), rs * 0.85 );
			}
		} else if ( vGk < 2.5 ) {
			// soffit: its soot gradient is baked (writeSlab); the library's own soffit
			// weathering adds the rest evenly
		} else {
			// console: run-off streaks hanging plumb down the faces the rain wets (in facade
			// metres: across the wall on the front and the curves, out of it on the flanks,
			// so they never follow the scroll's sweep), none on the faces turned down; soot
			// low on the scroll where the rain never reaches, in patches (corbelTemplate
			// bakes its mean into the far consoles)
			vec3 gnl = normalize( vGnl );
			float across = abs( gnl.x ) > 0.7 ? vGw.z + vGw.x : vGw.x;
			float fx = fwidth( across );
			gDark = gwStreaks( across, -vGw.y, fx ) * 0.26 * smoothstep( -0.6, -0.15, gnl.y );
			gDark += 0.16 * ( 1.0 - smoothstep( -0.6, -0.25, vGl.y ) ) * ( 0.6 + 0.4 * gwN( vec2( vGw.x * 4.0, vGw.z * 4.0 + 3.1 ) ) );
		}
		diffuseColor.rgb *= gTint * ( 1.0 - gDark );
	}`);
  };
  m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|ironStone4'; };
  m.needsUpdate = true;
  app.materials.register(m.name, m);
  return m;
}
