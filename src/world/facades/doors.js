// Residential entrance doors: panelled timber (or glazed iron) double doors with a
// fanlight, lever handles and a stone threshold step.
import { Tpl } from './geo.js';
import { outlinePts, halfWidthAt, springY, headSegments, isArched, headCentre, topAt } from './outline.js';
import { rectRing } from './kit.js';

const FW = 0.1, ZF = 0.05, ZB = -0.08, CH = 0.012;

function rail(t, a, b, w, zf, zb, shade = 1) {
  t.bar(a, b, [[-w / 2, zb], [-w / 2, zf - CH], [-w / 2 + CH, zf], [w / 2 - CH, zf], [w / 2, zf - CH], [w / 2, zb]], shade);
}

export function doorLayout(o, rng) {
  const arched = isArched(o);
  const yT = arched ? Math.max(2.1, springY(o)) : o.h > 2.65 ? o.h - FW - rng.range(0.42, 0.6) : null;
  return {
    arched, yT,
    leaves: o.w > 1.15 ? 2 : 1,
    style: rng.weighted([['panel', 0.55], ['glazed', 0.3], ['plank', 0.15]]),
    sunburst: rng.chance(0.7),
    color: rng.weighted([['brown', 0.3], ['varnish', 0.2], ['green', 0.15], ['blue', 0.15], ['black', 0.1], ['red', 0.1]]),
  };
}

/** Raised and fielded panel between (x0, y0) and (x1, y1) on a leaf face at zf. */
function panel(t, x0, y0, x1, y1, zf, q) {
  const b = Math.min(0.045, (x1 - x0) * 0.2, (y1 - y0) * 0.2);
  const zr = zf - 0.022;                     // recessed ground
  t.box(x0, y0, zr - 0.01, x1, y1, zr, 1, 0.82, 0.9);
  if (q < 0.5) return;
  // bevelled field rising from the ground
  const outer = rectRing(x0 + 0.012, y0 + 0.012, x1 - 0.012, y1 - 0.012, [0, 0, 0, 0], zr);
  const inner = rectRing(x0 + 0.012, y0 + 0.012, x1 - 0.012, y1 - 0.012, [b, b, b, b], zf - 0.006);
  t.loft([outer, inner], true, 0.95);
  const ip = inner.map((p) => [p[0], p[1]]);
  t.poly(ip, zf - 0.006, 1);
}

/** Door joinery (frame, leaves, fanlight bars). Coloured with the door paint. */
export function doorTpl(o, L, q) {
  const t = new Tpl();
  const n = headSegments(o, q);
  const ring = (d, z) => outlinePts(o, d, n).map((p) => [p[0], p[1], z]);
  const hwI = o.w / 2 - FW;
  const top = L.yT ?? o.h - FW;
  if (q < 0.5) {
    // far: casing face, transom and flat leaves
    t.loft([ring(0, ZF), ring(FW, ZF)], true, 1);
    if (L.yT) t.box(-hwI, L.yT - 0.055, -0.02, hwI, L.yT + 0.055, ZF, 1, 1, 1);
    t.box(-hwI, 0, -0.03, hwI, L.yT ? L.yT - 0.055 : top, 0.0, 1, 0.8, 0.95);
    return t.bake();
  }
  t.loft([ring(0, ZF), ring(FW - CH, ZF)], true, 1);
  t.loft([ring(FW - CH, ZF), ring(FW, ZF - CH)], true, 0.95);
  t.loft([ring(FW, ZF - CH), ring(FW, ZB)], true, 0.75);
  if (L.yT) rail(t, [-hwI - 0.01, L.yT], [hwI + 0.01, L.yT], 0.11, ZF, ZB);
  const leafTop = L.yT ? L.yT - 0.055 : top;
  const zf = 0.02, zb = -0.035;
  const nL = L.leaves;
  const lw = (2 * hwI) / nL;
  for (let i = 0; i < nL; i++) {
    const x0 = -hwI + i * lw + 0.004, x1 = x0 + lw - 0.008, y0 = 0.01, y1 = leafTop;
    const sw = Math.min(0.13, lw * 0.18), bw = 0.22, tw = 0.13, lock = 1.0;
    // leaf frame with chamfered inner edge
    const c = 0.01, ins = [sw, bw, sw, tw], insC = ins.map((v) => v - c);
    t.loft([rectRing(x0, y0, x1, y1, [0, 0, 0, 0], zf), rectRing(x0, y0, x1, y1, insC, zf)], true, 1);
    t.loft([rectRing(x0, y0, x1, y1, insC, zf), rectRing(x0, y0, x1, y1, ins, zf - c)], true, 0.92);
    t.loft([rectRing(x0, y0, x1, y1, ins, zf - c), rectRing(x0, y0, x1, y1, ins, zb)], true, 0.7);
    t.box(x0, y0, zb, x1, y1, zf, 4 | 8 | 32, 0.85, 0.9);
    const xi0 = x0 + sw, xi1 = x1 - sw, yi0 = y0 + bw, yi1 = y1 - tw;
    if (L.style === 'plank') {
      // vertical boarding with grooves
      t.box(xi0, yi0, zf - 0.02, xi1, yi1, zf - 0.005, 1, 0.9, 1);
      if (q >= 0.5) for (let x = xi0 + 0.11; x < xi1 - 0.05; x += 0.11) t.box(x - 0.006, yi0, zf - 0.03, x + 0.006, yi1, zf - 0.012, 1, 0.55, 0.6);
    } else if (L.style === 'glazed') {
      // lower panel + lock rail; glass above (with an iron grille in front, see grilleTpl)
      panel(t, xi0, yi0, xi1, lock - 0.05, zf, q);
      t.box(xi0, lock - 0.05, zf - 0.03, xi1, lock + 0.06, zf, 1 | 16 | 32, 0.95, 1);
    } else {
      // two or three fielded panels
      const mid = lock + 0.06;
      panel(t, xi0, yi0, xi1, lock - 0.05, zf, q);
      t.box(xi0, lock - 0.05, zf - 0.03, xi1, mid, zf, 1 | 16 | 32, 0.95, 1);
      if (yi1 - mid > 1.1 && q >= 0.5) {
        const ym = mid + (yi1 - mid) * 0.62;
        panel(t, xi0, mid, xi1, ym - 0.05, zf, q);
        t.box(xi0, ym - 0.05, zf - 0.03, xi1, ym + 0.05, zf, 1 | 16 | 32, 0.95, 1);
        panel(t, xi0, ym + 0.05, xi1, yi1, zf, q);
      } else panel(t, xi0, mid, xi1, yi1, zf, q);
    }
  }
  // fanlight bars
  if (L.yT && q >= 0.5) {
    const yH = L.yT + 0.055;
    if (L.arched && L.sunburst && o.top !== 'segment') {
      const [cx, cy] = headCentre(o);
      const nb = 5;
      for (let k = 1; k <= nb; k++) {
        const a = (Math.PI * k) / (nb + 1);
        let lo = 0, hi = 2;
        for (let i = 0; i < 16; i++) {
          const m = (lo + hi) / 2, x = cx + Math.cos(a) * m, y = cy + Math.sin(a) * m;
          const tp = topAt(o, x, FW - 0.01);
          if (Number.isFinite(tp) && y < tp) lo = m; else hi = m;
        }
        const r0 = Math.max(0.12, (yH - cy) / Math.max(0.1, Math.sin(a)));
        rail(t, [cx + Math.cos(a) * r0, cy + Math.sin(a) * r0], [cx + Math.cos(a) * lo, cy + Math.sin(a) * lo], 0.025, 0.0, -0.03, 0.95);
      }
      // hub
      const arc = (r, z) => { const p = []; for (let k = 0; k <= 8; k++) { const a = (Math.PI * k) / 8; p.push([cx + Math.cos(a) * r, Math.max(yH, cy + Math.sin(a) * r), z]); } return p; };
      t.loft([arc(0.17, 0.0), arc(0.12, 0.0), arc(0.12, -0.03)], false, 0.95);
    } else {
      const nb = o.w > 1.2 ? 3 : 2;
      for (let i = 1; i < nb; i++) {
        const x = -hwI + (2 * hwI * i) / nb;
        rail(t, [x, yH - 0.01], [x, topAt(o, x, FW - 0.01)], 0.025, 0.0, -0.03, 0.95);
      }
    }
  }
  t.shadeBy((x, y) => 0.78 + 0.22 * Math.min(1, y / 0.6));
  return t.bake();
}

/** Glass of a door: fanlight and (glazed doors) the upper leaf panes. Far range: 1 cm proud. */
export function doorGlassTpl(o, L, q = 1) {
  const t = new Tpl();
  const hwI = o.w / 2 - FW;
  const zF = q < 0.5 ? 0.01 : -0.015, zG = q < 0.5 ? 0.01 : -0.02;
  if (L.yT) {
    const yH = L.yT + 0.05;
    const pts = outlinePts(o, FW - 0.01).filter((p) => p[1] > yH + 0.001);
    const hw = halfWidthAt(o, yH, FW - 0.01);
    t.poly([[-hw, yH], [hw, yH], ...pts], zF);
  }
  if (L.style === 'glazed') {
    const leafTop = L.yT ? L.yT - 0.055 : o.h - FW;
    const lw = (2 * hwI) / L.leaves;
    for (let i = 0; i < L.leaves; i++) {
      const x0 = -hwI + i * lw + 0.1, x1 = x0 + lw - 0.2;
      t.quad([x0, 1.06, zG], [x1, 1.06, zG], [x1, leafTop - 0.1, zG], [x0, leafTop - 0.1, zG]);
    }
  }
  return t.bake();
}

/** Iron grille in front of glazed door panes ({grille}) and lever handles ({handles}). */
export function doorMetalTpl(o, L, q) {
  const t = new Tpl(), hd = new Tpl();
  const hwI = o.w / 2 - FW;
  const leafTop = L.yT ? L.yT - 0.055 : o.h - FW;
  const lw = (2 * hwI) / L.leaves;
  if (L.style === 'glazed' && q >= 0.5) {
    for (let i = 0; i < L.leaves; i++) {
      const x0 = -hwI + i * lw + 0.13, x1 = x0 + lw - 0.26;
      const y0 = 1.06, y1 = leafTop - 0.13;
      for (let x = x0 + 0.1; x < x1 - 0.05; x += 0.11) t.box(x - 0.007, y0, 0.0, x + 0.007, y1, 0.014, 1 | 4 | 8, 0.9, 1);
      for (const y of [y0 + 0.25, (y0 + y1) / 2, y1 - 0.25]) t.box(x0, y - 0.01, 0.014, x1, y + 0.01, 0.026, 1 | 16 | 32, 0.9, 1);
    }
  }
  if (q < 0.5) return { grille: null, handles: null };
  // lever handles at the meeting stiles
  const hx = L.leaves === 2 ? [-0.07, 0.07] : [hwI - 0.1];
  for (const x of hx) {
    const s = L.leaves === 2 ? -Math.sign(x) : 1; // levers point towards the hinges
    hd.box(x - 0.018, 0.92, 0.02, x + 0.018, 1.17, 0.03, 1 | 4 | 8 | 16 | 32, 0.9, 1);       // back plate
    hd.box(x - 0.01, 1.04, 0.03, x + 0.01, 1.06, 0.075, 1 | 4 | 8 | 16 | 32, 0.9, 1);        // neck
    hd.box(Math.min(x, x - s * 0.12), 1.04, 0.06, Math.max(x, x - s * 0.12), 1.065, 0.08, 1 | 4 | 8 | 16 | 32, 0.9, 1); // lever
    if (q >= 0.5) hd.box(x - 0.012, 0.86, 0.02, x + 0.012, 0.9, 0.028, 1 | 16 | 32, 0.5, 0.6);          // key escutcheon
  }
  return { grille: t.count ? t.bake() : null, handles: hd.bake() };
}

export const DOOR_FW = FW;

// Door templates shared by the same-size doors of one building.
const cache = new Map();
/** {door, glass, metal} templates for door o with layout L. */
export function doorTpls(design, o, L, q) {
  const key = `${design}|${o.top}|${o.w.toFixed(3)}|${o.h.toFixed(3)}|${(o.rise ?? 0).toFixed(3)}|${q}`;
  let v = cache.get(key);
  if (!v) {
    if (cache.size > 400) cache.clear();
    v = { door: doorTpl(o, L, q), glass: doorGlassTpl(o, L, q), metal: doorMetalTpl(o, L, q) };
    cache.set(key, v);
  }
  return v;
}
