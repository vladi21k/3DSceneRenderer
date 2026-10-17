import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { normalizeAttributes } from '../../core/geom.js';
import { GeoWriter, sweepPath, insetPath, capPolygon, sweepBar, box, lathe, shared } from './geo.js';

// Carved limestone parts of a balcony: the moulded slab, the scroll consoles (corbels)
// that carry it, and the turned-baluster stone balustrade alternative.
// Facade-local coordinates: u along the wall, v up, w out of the wall (see facadePlan).

/** Slab edge moulding [o, v] relative to the outer edge (o ≤ 0) and the slab top (v = 0),
 *  ordered from the top edge down to the soffit. */
export function slabProfile(T, variant, lod) {
  if (lod) return [[-0.012, 0], [0, -0.012], [0, -0.06], [-0.06, -T + 0.01], [-0.07, -T]];
  if (variant === 1) {
    // plain thick slab with a drip chamfer (later Mandate buildings)
    return [[-0.01, 0], [0, -0.01], [0, -T + 0.03], [-0.015, -T + 0.012], [-0.03, -T]];
  }
  // classical: chamfered top arris, fascia, ovolo, fillet, soffit
  const p = [[-0.012, 0], [0, -0.012], [0, -0.055], [-0.012, -0.063]];
  const rx = 0.048, ry = Math.max(0.03, T - 0.078);
  for (let i = 1; i <= 4; i++) {
    const a = -(i / 4) * Math.PI / 2;
    p.push([-0.06 + rx * Math.cos(a), -0.063 + ry * Math.sin(a)]);
  }
  p.push([-0.072, -T + 0.015], [-0.072, -T]);
  return p;
}

/** Plan outline of a balcony slab: wall-left, front-left, front-right, wall-right, with an
 *  optional corner radius. The ends run 0.25 m into the wall so door recesses get a floor. */
export function slabPath(u0, u1, depth, rc = 0, into = 0.25) {
  if (rc <= 0.01) return [[u0, -into], [u0, depth], [u1, depth], [u1, -into]];
  const p = [[u0, -into], [u0, depth - rc]];
  const n = 5;
  for (let i = 1; i < n; i++) { const a = Math.PI - (i / n) * Math.PI / 2; p.push([u0 + rc + Math.cos(a) * rc, depth - rc + Math.sin(a) * rc]); }
  p.push([u0 + rc, depth], [u1 - rc, depth]);
  for (let i = 1; i < n; i++) { const a = Math.PI / 2 - (i / n) * Math.PI / 2; p.push([u1 - rc + Math.cos(a) * rc, depth - rc + Math.sin(a) * rc]); }
  p.push([u1, depth - rc], [u1, -into]);
  return p;
}

/** Writes one balcony slab (sweep + top + soffit) into W (matrix = facade frame). */
export function writeSlab(W, path, y, T, variant, lod, dirt = 1) {
  const prof = slabProfile(T, variant, lod).map(([o, v]) => [o, y + v]);
  const shadeFn = (o, v) => {
    const t = (y - v) / T; // 0 top .. 1 soffit
    return (1 - 0.18 * t * t) * (t > 0.95 ? 0.85 : 1) * dirt;
  };
  sweepPath(W, path, prof, { shadeFn, smoothFrom: variant === 0 && !lod ? 4 : 1e9 });
  const topO = prof[0][0], botO = prof[prof.length - 1][0];
  capPolygon(W, insetPath(path, topO), y, 1, 0.93 * dirt);
  capPolygon(W, insetPath(path, botO), y - T, -1, 0.7 * dirt);
}

// ---------------------------------------------------------------- consoles
export const CORBEL = { D: 0.8, H: 0.62, W: 0.26 };

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
    return { shape: s, roll: [cx, -a, R] };
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
  const { D, H: Hc, W: Wc } = CORBEL;
  const { shape, roll } = corbelShape(variant, D, Hc);
  const bev = lod ? 0 : 0.012;
  const ext = new THREE.ExtrudeGeometry(shape, {
    depth: Wc - 2 * bev, bevelEnabled: !lod, bevelThickness: bev, bevelSize: bev, bevelSegments: 1,
    curveSegments: lod ? 1 : 5,
  });
  let parts = [ext];
  if (roll && !lod) {
    // volute spirals carved on both flanks of the roll
    const [cx, cy, R] = roll;
    const pts = [];
    const turns = 1.55, n = 16;
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = -t * turns * Math.PI * 2;
      const r = R * 0.86 * Math.pow(0.17, t);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    const S = new GeoWriter();
    sweepBar(S, pts, 0.011, 0.007, { z0: -bev - 0.002 });
    sweepBar(S, pts, 0.011, 0.007, { z0: Wc - bev + 0.002 });
    // domed eye bosses at the spiral centres (lathe axis turned to -z / +z)
    const eye = [[0.03, 0], [0.028, 0.008], [0.014, 0.015], [0.0001, 0.017]];
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
  // baked occlusion: under the slab and against the wall
  const pos = g.attributes.position, n = pos.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i), z = pos.getZ(i);
    const ao = (1 - 0.3 * Math.exp(y / 0.05)) * (1 - 0.25 * Math.exp(-Math.max(0, z) / 0.07)) * (0.9 + 0.1 * Math.min(1, -y / Hc));
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = ao;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return shared(g);
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
  // far: a square shaft is all that survives at a couple of pixels
  if (lod) box(W, 0, h / 2, 0, 0.085, h, 0.085, 1, 'ud');
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
