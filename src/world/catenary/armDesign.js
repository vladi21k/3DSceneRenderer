import { turtle, scroll, lowestAfter, offsetPath, pointAt } from './paths.js';

// The ornamental lamp bracket (a forged "lyre"), drawn in its own plane: x = outward from
// the pole axis, y = up from the lower bracket collar. Pure data so it can be plotted
// offline and swept into geometry at runtime.
//
// Two flat-bar rails rise from small curls below the lower collar and are held to the pole
// by two straight horizontal stays. They part into a narrow lens, nearly touch where the
// arm bends, run up side by side to the arch and merge there; the outer rail rolls over
// into the volute that carries the lantern. Forged C- and S-scrolls fill the gaps.
//
// Elements: {pts, prof: 'tube', r} for round bar, {pts, prof: 'bar', w, t} for forged
// flat bar (w = in-plane thickness, t = depth across the plane).

const RAIL = { w: 0.022, t: 0.016 };
const SCROLL = { w: 0.013, t: 0.016 };

export const UPPER_COLLAR = 0.4;

export function armDesign(reach = 1.0, { ornate = true } = {}) {
  const els = [];

  // outer rail spine: steep lower leg, bend, long diagonal (curvature in 1/m, - = clockwise)
  const x0 = 0.112, y0 = -0.3;
  const spine = turtle(x0, y0, 1.33, [
    [0.66, -0.12, -0.12],
    [0.2, -0.4, -3.0],
    [0.12, -3.0, -0.5],
    [0.6, -0.25, -0.15],
  ]);
  // arch over the top and down into a clockwise volute
  const e = spine[spine.length - 1];
  const arch = turtle(e[0], e[1], spine.heading, [
    [0.22, -0.4, -2.6],
    [0.22, -2.6, -7.5],
    [0.17, -7.5, -13],
    [0.21, -13, -44],
  ]);
  const outer = spine.concat(arch.slice(1));
  // bottom curl, curling back towards the pole
  const curlA = turtle(x0, y0, 1.33 + Math.PI, [[0.16, -8, -46]]);
  els.push({ pts: curlA.slice(1).reverse().concat(outer), prof: 'bar', ...RAIL, name: 'outer' });

  // inner rail: the spine offset inwards (towards the centre of the arch) by a gap that
  // opens into a lens on the lower leg, closes at the bend and fades into the arch
  const L = pathLength(spine), La = pathLength(arch.slice(0, Math.floor(arch.length * 0.22)));
  const gap = smoothTable([[0, 0.075], [0.26, 0.13], [0.52, 0.08], [0.73, 0.034], [0.86, 0.05], [1.1, 0.07], [L - 0.12, 0.062], [L + La, 0.0]]);
  const innerFull = offsetPath(outer.slice(0, spine.length + Math.floor(arch.length * 0.22)), (s) => -gap(s));
  const inner = innerFull.slice(0, innerFull.length - 2);
  const i0 = inner[0];
  const h0 = Math.atan2(inner[3][1] - i0[1], inner[3][0] - i0[0]);
  const curlB = turtle(i0[0], i0[1], h0 + Math.PI, [[0.13, 9, 52]]);
  els.push({ pts: curlB.slice(1).reverse().concat(inner), prof: 'bar', ...RAIL, name: 'inner' });

  // straight stays from the two collars to the inner rail (crossing the outer one)
  const xi0 = xAt(inner, 0), xi1 = xAt(inner, UPPER_COLLAR);
  els.push({ pts: [[0.06, 0.0], [xi0 + 0.006, 0.0]], prof: 'bar', w: 0.02, t: 0.014, name: 'stayLo' });
  els.push({ pts: [[0.06, UPPER_COLLAR], [xi1 + 0.006, UPPER_COLLAR]], prof: 'bar', w: 0.02, t: 0.014, name: 'stayHi' });

  if (ornate) {
    const oi = curlA.length - 1, ii = curlB.length - 1;
    // C-scroll in the lens: its back rests on the outer rail, its curls on the inner one
    els.push({ pts: cScroll(outer, oi, 0.3, 0.047), prof: 'bar', ...SCROLL, name: 'lens' });
    // two forged ears lying on top of the bend, curling back towards the pole
    for (const [s0, size] of [[0.7, 1], [0.93, 0.8]]) {
      const c = pointAt(outer, oi, s0), c2 = pointAt(outer, oi, s0 + 0.03);
      const h = Math.atan2(c2[1] - c[1], c2[0] - c[0]);
      const n = [-Math.sin(h), Math.cos(h)];
      const p1 = [c[0] + n[0] * 0.025 * size - Math.cos(h) * 0.02, c[1] + n[1] * 0.025 * size - Math.sin(h) * 0.02];
      const p2 = [c[0] + n[0] * 0.045 * size - Math.cos(h) * 0.06 * size, c[1] + n[1] * 0.045 * size - Math.sin(h) * 0.06 * size];
      els.push({ pts: scroll({ ctrl: [c, p1, p2], endCurl: { len: 0.12 * size, k0: 18 / size, k1: 80 / size } }), prof: 'bar', ...SCROLL, name: 'ear' });
    }
    // one S-scroll tying the parallel rails on the diagonal
    const p = pointAt(outer, oi, 1.3), q = pointAt(inner, ii, 1.34);
    els.push({ pts: scroll({ ctrl: [p, mid(p, q, 0, 0), q], startCurl: { len: 0.05, k0: 20, k1: 90 }, endCurl: { len: 0.05, k0: 20, k1: 90 } }), prof: 'bar', w: 0.011, t: 0.014, name: 'tieS' });
  }

  // the lantern hangs from the lowest point of the volute
  const vStart = curlA.length - 1 + spine.length + Math.floor(arch.length * 0.55);
  const all = els[0].pts;
  const hang = lowestAfter(all, vStart);

  const S = reach;
  return {
    elements: els.map((el) => ({ ...el, pts: el.pts.map(([x, y]) => [x * S, y * S]) })),
    hang: [hang[0] * S, hang[1] * S],
    collars: [0, UPPER_COLLAR * S],
    top: Math.max(...all.map((p) => p[1])) * S,
    bottom: Math.min(...all.map((p) => p[1]), ...inner.map((p) => p[1])) * S,
  };
}

function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

function xAt(pts, y) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) return a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
  }
  return pts[0][0];
}

/** C-scroll of radius R whose back touches the rail `pts` at arc length s (from index i0)
 *  and whose opening faces the rail's right-hand side; both ends curl inwards. */
function cScroll(pts, i0, s, R) {
  const o = pointAt(pts, i0, s), o2 = pointAt(pts, i0, s + 0.02);
  const h = Math.atan2(o2[1] - o[1], o2[0] - o[0]);
  const n = [Math.sin(h), -Math.cos(h)]; // right-hand normal
  const c = [o[0] + n[0] * (R + 0.016), o[1] + n[1] * (R + 0.016)];
  const a0 = Math.atan2(n[1], n[0]);
  const ctrl = [];
  for (let i = 0; i <= 10; i++) {
    const a = a0 + 0.95 + (i / 10) * (2 * Math.PI - 1.9);
    ctrl.push([c[0] + Math.cos(a) * R, c[1] + Math.sin(a) * R]);
  }
  return scroll({ ctrl, startCurl: { len: 0.07, k0: -1 / R, k1: -4.2 / R }, endCurl: { len: 0.07, k0: 1 / R, k1: 4.2 / R } });
}

function mid(a, b, ox, oy) { return [(a[0] + b[0]) / 2 + ox, (a[1] + b[1]) / 2 + oy]; }

/** Smoothstep interpolation through [x, y] knots. */
function smoothTable(knots) {
  return (x) => {
    if (x <= knots[0][0]) return knots[0][1];
    for (let i = 1; i < knots.length; i++) {
      const [xa, ya] = knots[i - 1], [xb, yb] = knots[i];
      if (x <= xb) { const t = (x - xa) / (xb - xa); return ya + (yb - ya) * t * t * (3 - 2 * t); }
    }
    return knots[knots.length - 1][1];
  };
}
