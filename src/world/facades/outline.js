// Opening outlines in opening-local coordinates (metres):
//   x across the opening (0 = centre, ±w/2 at the jambs), y up from the sill (0) to the
//   crown, z out of the infill plane towards the street.
// The head geometry follows facadePlan.archPoint exactly (the masonry holes are cut from
// the same definition): o.rise above the spring line o.spring.
//   round    semicircle of radius w/2 centred on the spring line
//   segment  arc of radius (w²/4 + r²) / 2r centred below the spring line
//   pointed  two-centred arch, centres 0.1344 w either side of the axis, radius w/2 + c
// Every function takes an inset d (concentric offset inwards) so casings, sashes and glass
// can be built as offsets of one outline.
import { archRise } from '../facadePlan.js';

const POINTED_C = 0.1344;

function head(o) {
  const w = o.w, hw = w / 2;
  const rise = o.rise ?? Math.min(archRise(o.top, w), Math.max(0, o.h - 0.3));
  const s = (o.spring ?? o.y + o.h - rise) - o.y; // local spring height
  if (o.top === 'round' && rise > 0) return { type: 'round', s, R: hw, cy: s };
  if (o.top === 'segment' && rise > 0) {
    const R = (hw * hw + rise * rise) / (2 * rise);
    return { type: 'segment', s, R, cy: s + rise - R };
  }
  if (o.top === 'pointed' && rise > 0) {
    const c = POINTED_C * w;
    return { type: 'pointed', s, R: hw + c, xc: c };
  }
  return { type: 'flat', s: o.h };
}

/** Local spring height (top of the jambs). */
export function springY(o) { return head(o).s; }

/** Local crown height at inset d. */
export function crownY(o, d = 0) { return topAt(o, 0, d); }

/** Height of the outline top at x for inset d (NaN outside the inset width). */
export function topAt(o, x, d = 0) {
  const a = head(o), hw = o.w / 2 - d;
  if (Math.abs(x) > hw + 1e-6) return NaN;
  switch (a.type) {
    case 'round':
    case 'segment': {
      const R = a.R - d;
      return a.cy + Math.sqrt(Math.max(0, R * R - x * x));
    }
    case 'pointed': {
      const R = a.R - d, cx = x <= 0 ? a.xc : -a.xc;
      return a.s + Math.sqrt(Math.max(0, R * R - (x - cx) * (x - cx)));
    }
    default: return o.h - d;
  }
}

/** Half width of the inset outline at height y (0 above the crown). */
export function halfWidthAt(o, y, d = 0) {
  const a = head(o), hw = o.w / 2 - d;
  if (y <= a.s) return hw;
  switch (a.type) {
    case 'round':
    case 'segment': {
      const R = a.R - d, yy = y - a.cy;
      return yy >= R ? 0 : Math.min(hw, Math.sqrt(R * R - yy * yy));
    }
    case 'pointed': {
      const R = a.R - d, yy = y - a.s;
      if (yy >= R) return 0;
      return Math.max(0, Math.min(hw, -a.xc + Math.sqrt(R * R - yy * yy)));
    }
    default: return y > o.h - d ? 0 : hw;
  }
}

/** Number of samples along the head. */
export function headSegments(o, q = 1) {
  const a = head(o);
  if (a.type === 'flat') return 1;
  const base = a.type === 'segment' ? 6 : a.type === 'pointed' ? 10 : 12;
  return Math.max(2, Math.round(base * q * Math.min(1.6, Math.max(0.7, o.w / 1.2))));
}

export function isArched(o) { return head(o).type !== 'flat'; }

/**
 * Closed CCW outline at inset d: bottom-left, bottom-right, up the right jamb, along the
 * head (right to left), down the left jamb. The point count and parameterisation depend
 * only on (o, n), so outlines at different insets correspond index by index.
 */
export function outlinePts(o, d = 0, n = headSegments(o)) {
  const a = head(o), hw = o.w / 2 - d;
  const pts = [[-hw, d], [hw, d]];
  if (a.type === 'flat') {
    pts.push([hw, o.h - d], [-hw, o.h - d]);
    return pts;
  }
  if (a.type === 'round' || a.type === 'segment') {
    const R = a.R - d;
    // the arc starts where it meets the (inset) jamb: the spring line for round heads
    const t0 = Math.acos(Math.min(1, hw / R));
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((Math.PI - 2 * t0) * i) / n;
      pts.push([R * Math.cos(t), a.cy + R * Math.sin(t)]);
    }
    return pts;
  }
  // pointed: right arc (centre −xc) from angle 0 to the apex, then the left arc
  const R = a.R - d;
  const half = Math.max(1, Math.round(n / 2));
  const t1 = Math.acos(Math.min(1, a.xc / R));
  for (let i = 0; i <= half; i++) {
    const t = (t1 * i) / half;
    pts.push([-a.xc + R * Math.cos(t), a.s + R * Math.sin(t)]);
  }
  for (let i = half - 1; i >= 0; i--) {
    const t = (t1 * i) / half;
    pts.push([a.xc - R * Math.cos(t), a.s + R * Math.sin(t)]);
  }
  return pts;
}

/** Centre of the head arcs (fanlight hub). */
export function headCentre(o) {
  const a = head(o);
  return [0, a.type === 'flat' ? a.s : a.type === 'segment' ? Math.max(a.cy, a.s - 0.5) : a.s];
}

// ------------------------------------------------------------------ wall relief
/**
 * Depth of the rock-faced bosses of a rusticated ground floor in front of the wall plane
 * (stone.rough draws them with parallax relief up to ~9.5 cm proud of its polygon,
 * materials meta relief[1]): fittings fixed to that stone stand on the boss faces, and
 * signs stand off ~0.1 m, or they look sunk into the stone.
 */
export const RUSTIC_RELIEF = 0.095;
/** Whether height v of a front (plan, or a corner return's plan) lies in its rusticated zone. */
export function inRustic(plan, v) {
  const r = plan && plan.relief && plan.relief.rustic;
  return !!r && v < r.v1;
}
/** Extra stand-off of a wall fitting at height v: the bosses' depth in the rusticated zone. */
export const rusticOff = (plan, v) => (inRustic(plan, v) ? RUSTIC_RELIEF : 0);
