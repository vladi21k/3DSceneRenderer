// Upper-floor windows and balcony (French) doors: painted timber casements, slim steel
// windows (Mandate era) or aluminium sliders (modern), with transoms, glazing bars and
// sunburst fanlights in arched heads; interior-mapped glass; louvred shutters.
import { Tpl, TplCache } from './geo.js';
import { outlinePts, halfWidthAt, springY, headSegments, isArched, headCentre, crownY, topAt } from './outline.js';
import { FR, rectRing, insetPoly, spanAtY } from './kit.js';

// ------------------------------------------------------------------ variants
/** Lot-wide window joinery style (deterministic per facade). */
export function joineryStyle(plan, rng) {
  const era = plan.style.era;
  const type = era === 'modern' ? 'alu' : era === 'mandate' ? (rng.chance(0.45) ? 'steel' : 'timber') : 'timber';
  return {
    type,
    rows: type === 'steel' ? rng.int(3, 4) : rng.int(2, 3),
    cols: type === 'steel' ? 2 : 1,
    transom: type !== 'alu' && rng.chance(0.55),
    sunburst: rng.chance(0.75),
  };
}

const PROFILE = {
  timber: { fw: 0.075, sw: 0.052, swB: 0.075, g: 0.024, zs: 0.012, zgb: -0.03 },
  steel: { fw: 0.05, sw: 0.034, swB: 0.04, g: 0.016, zs: 0.016, zgb: -0.02 },
  alu: { fw: 0.055, sw: 0.045, swB: 0.05, g: 0, zs: 0.014, zgb: -0.03 },
};

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ joinery template
function glazingProfile(g, zs) {
  return [[-g / 2, -0.02], [-g / 2, zs - 0.008], [g / 2, zs - 0.008], [g / 2, -0.02]];
}
function railProfile(tw, zf, zb, ch) {
  return [[-tw / 2, zb], [-tw / 2, zf - ch], [-tw / 2 + ch, zf], [tw / 2 - ch, zf], [tw / 2, zf - ch], [tw / 2, zb]];
}

/** Sash (casement leaf) frame lofted round a rectangle, with optional glazing bars. */
function sash(t, x0, y0, x1, y1, P, zOff, rows, cols, panelTop) {
  const { sw, swB, zs, zgb, g } = P;
  t.piece();
  const c2 = 0.008;
  const zf = zs + zOff, zb = zgb + zOff;
  const ins = (k) => [sw * k, swB * k, sw * k, sw * k];
  t.loft([rectRing(x0, y0, x1, y1, [0, 0, 0, 0], zf), rectRing(x0, y0, x1, y1, ins((sw - c2) / sw), zf), rectRing(x0, y0, x1, y1, ins(1), zf - c2)], true, 1);
  t.loft([rectRing(x0, y0, x1, y1, ins(1), zf - c2), rectRing(x0, y0, x1, y1, ins(1), zb)], true, 0.8);
  const xi0 = x0 + sw, xi1 = x1 - sw, yi1 = y1 - sw;
  let yi0 = y0 + swB;
  if (panelTop) {
    // solid lower panel with a raised field and a mid rail (French doors)
    const yp = Math.min(panelTop, yi1 - 0.4);
    t.box(xi0 - 0.005, yi0 - 0.005, zb, xi1 + 0.005, yp, zf - 0.016, 1, 0.82, 0.95);
    t.box(xi0 + 0.05, yi0 + 0.05, zf - 0.016, xi1 - 0.05, yp - 0.05, zf - 0.006, 1 | 4 | 8 | 16 | 32, 0.92, 1);
    t.bar([xi0 - 0.01, yp + 0.035], [xi1 + 0.01, yp + 0.035], railProfile(0.07, zf, zb, c2), 1);
    yi0 = yp + 0.07;
  }
  if (!g) return;
  const gp = glazingProfile(g, zf);
  for (let r = 1; r < rows; r++) {
    const y = yi0 + ((yi1 - yi0) * r) / rows;
    t.bar([xi0 - 0.004, y], [xi1 + 0.004, y], gp, 0.95);
  }
  for (let c = 1; c < cols; c++) {
    const x = xi0 + ((xi1 - xi0) * c) / cols;
    t.bar([x, yi0 - 0.004], [x, yi1 + 0.004], gp, 0.95);
  }
}

/** Point where a ray from (cx, cy) at angle a leaves the outline inset by d. */
function rayToOutline(o, cx, cy, a, d) {
  let lo = 0, hi = Math.max(o.w, o.h);
  const dx = Math.cos(a), dy = Math.sin(a);
  for (let i = 0; i < 18; i++) {
    const r = (lo + hi) / 2, x = cx + dx * r, y = cy + dy * r;
    const top = topAt(o, x, d);
    if (Number.isFinite(top) && y < top && y > d) lo = r; else hi = r;
  }
  return [cx + dx * lo, cy + dy * lo];
}

/** Shared layout of a window's sashes (used by the joinery and the glass split). */
function sashLayout(o, v) {
  const P = PROFILE[v.type];
  const fw = P.fw;
  const hwI = o.w / 2 - fw;
  const tw = v.type === 'steel' ? 0.05 : 0.07;
  let yT = null;
  if (isArched(o)) yT = Math.max(fw + 0.6, springY(o) - (o.top === 'segment' ? 0.04 : 0));
  else if (v.transom && o.h > 1.9) yT = o.h - fw - (o.kind === 'balconyDoor' ? 0.5 : 0.42);
  const sashTop = yT !== null ? yT - tw / 2 : o.h - fw;
  const nL = v.type === 'alu' ? 2 : o.w > 1.75 ? 4 : o.w > 0.75 ? 2 : 1;
  return { P, fw, hwI, tw, yT, sashTop, nL, lw: (2 * hwI) / nL };
}

/** Index of the opened leaf for `open` = {side, angle} (side −1 left, +1 right). */
function openLeafIndex(nL, open) { return !open ? -1 : open.side < 0 ? 0 : nL - 1; }

function buildJoinery(o, v, q, open) {
  if (q < 0.5) return null; // far range: the glass shader draws the casing and mullion
  const P = PROFILE[v.type];
  const t = new Tpl();
  const fw = P.fw, { zf, zb, ch } = FR;
  const n = headSegments(o, q);
  const ring = (d, z) => outlinePts(o, d, n).map((p) => [p[0], p[1], z]);
  // casing round the whole opening
  t.piece(0.04);
  const r0 = ring(0, zf), r1 = ring(fw - ch, zf), r2 = ring(fw, zf - ch), r3 = ring(fw, zb);
  t.loft([r0, r1], true, 1);
  t.loft([r1, r2], true, 0.95);
  t.loft([r2, r3], true, 0.78);

  const arched = isArched(o);
  const { hwI, tw, yT, sashTop, nL, lw } = sashLayout(o, v);
  if (yT !== null) {
    const hw = halfWidthAt(o, yT + tw / 2, fw) + 0.01;
    t.piece().bar([-hw, yT], [hw, yT], railProfile(tw, zf - 0.005, zb, ch), 1);
  }
  // sashes
  const panelTop = o.kind === 'balconyDoor' ? 0.85 : 0;
  const openIdx = openLeafIndex(nL, open);
  for (let i = 0; i < nL; i++) {
    let x0 = -hwI + i * lw, x1 = x0 + lw, zOff = 0;
    if (v.type === 'alu') { // sliding panes overlap and sit on two tracks
      if (i === 0) x1 += 0.03; else { x0 -= 0.03; zOff = -0.035; }
    }
    if (i === openIdx) {
      // casement swung into the room about its hinge on the jamb side
      const leaf = new Tpl();
      sash(leaf, x0, fw, x1, sashTop, P, zOff, v.rows, v.cols, panelTop);
      const hx = open.side < 0 ? x0 : x1;
      t.appendRotY(leaf, hx, P.zgb, open.side < 0 ? open.angle : -open.angle);
      leaf.free();
    } else sash(t, x0, fw, x1, sashTop, P, zOff, v.rows, v.cols, panelTop);
  }

  // fanlight / top light
  if (yT !== null) {
    const gp = glazingProfile(P.g || 0.022, P.zs);
    const y0 = yT + tw / 2;
    if (arched && o.top !== 'segment' && v.sunburst && v.type !== 'alu') {
      const [cx, cy] = headCentre(o);
      const rh = Math.min(0.13, (crownY(o, fw) - cy) * 0.28);
      const nb = o.w > 1.5 ? 7 : o.w > 1.05 ? 5 : 3;
      for (let k = 1; k <= nb; k++) {
        const a = (Math.PI * k) / (nb + 1);
        const e = rayToOutline(o, cx, cy, a, fw - 0.01);
        t.bar([cx + Math.cos(a) * rh, cy + Math.sin(a) * rh], e, gp, 0.95);
      }
      // hub: a small half ring
      const arc = (r, z) => { const pts = []; for (let k = 0; k <= 8; k++) { const a = (Math.PI * k) / 8; pts.push([cx + Math.cos(a) * r, Math.max(y0 - 0.005, cy + Math.sin(a) * r), z]); } return pts; };
      t.loft([arc(rh + 0.03, P.zs - 0.004), arc(rh, P.zs - 0.004), arc(rh, -0.02)], false, 0.95);
    } else {
      // vertical bars continuing the leaf joints
      const nV = o.w > 1.75 ? 4 : o.w > 0.75 ? 2 : 1;
      for (let i = 1; i < nV; i++) {
        const x = -hwI + (2 * hwI * i) / nV;
        const yt = topAt(o, x, fw - 0.01);
        if (yt > y0 + 0.05) t.bar([x, y0 - 0.005], [x, yt], gp, 0.95);
      }
    }
  }
  // dirt collects on the lower rails, under the transom and in the casing's inner corners
  const hwC = o.w / 2 - fw;
  t.shadeBy((x, y) => {
    let k = 0.82 + 0.18 * smooth(0, 0.35, y);
    if (yT !== null && y < yT) k *= 0.92 + 0.08 * smooth(0, 0.3, yT - y);
    const dx = hwC - Math.abs(x);
    if (dx > -0.01 && dx < 0.08) k *= 0.9 + 0.1 * smooth(-0.01, 0.08, dx);
    return k;
  });
  return t.bake();
}

function buildGlass(o, v, q, open) {
  const P = PROFILE[v.type];
  const t = new Tpl();
  // far: the frame is procedural (glass shader) and the pane sits 3 cm proud of the
  // infill plane, well clear of the buildings' far-range back plate
  if (q < 0.5) { t.poly(outlinePts(o, 0.004, headSegments(o, 0.4)), GLASS_Z_FAR); return { glass: t.bake(), hole: null }; }
  if (!open) { t.poly(outlinePts(o, P.fw - 0.012, headSegments(o)), -0.012); return { glass: t.bake(), hole: null }; }
  // split: fixed parts, the open leaf's aperture (no glass) and its rotated pane
  const L = sashLayout(o, v);
  const hole = new Tpl();
  const openIdx = openLeafIndex(L.nL, open);
  const gz = -0.012, y0 = L.fw - 0.01, y1 = L.sashTop + 0.01;
  for (let i = 0; i < L.nL; i++) {
    const x0 = -L.hwI + i * L.lw - 0.005, x1 = x0 + L.lw + 0.01;
    if (i !== openIdx) { t.quad([x0, y0, gz], [x1, y0, gz], [x1, y1, gz], [x0, y1, gz]); continue; }
    hole.quad([x0, y0, gz], [x1, y0, gz], [x1, y1, gz], [x0, y1, gz]);
    const pane = new Tpl();
    pane.quad([x0 + 0.04, y0 + 0.06, P.zs - 0.03], [x1 - 0.04, y0 + 0.06, P.zs - 0.03], [x1 - 0.04, y1 - 0.04, P.zs - 0.03], [x0 + 0.04, y1 - 0.04, P.zs - 0.03]);
    const hx = open.side < 0 ? x0 + 0.005 : x1 - 0.005;
    t.appendRotY(pane, hx, P.zgb, open.side < 0 ? open.angle : -open.angle);
    pane.free();
  }
  if (L.yT !== null) {
    const yH = L.yT;
    const pts = outlinePts(o, P.fw - 0.012).filter((p) => p[1] > yH + 0.001);
    const hw = halfWidthAt(o, yH, P.fw - 0.012);
    t.poly([[-hw, yH], [hw, yH], ...pts], gz);
  }
  return { glass: t.bake(), hole: hole.bake() };
}

// ------------------------------------------------------------------ louvred shutters
/** CCW polygon of the left shutter leaf at inset d. */
function leafPoly(o, d) {
  const pts = outlinePts(o, d, headSegments(o, 0.7));
  const left = pts.filter((p) => p[0] < -1e-5);
  const crown = crownY(o, d);
  // left = [bottom-left, ...head points from apex side down to the left spring]
  const head = left.slice(1);
  return [[-0.004, d], [-0.004, crown], ...head, left[0]];
}

function leafGeometry(t, poly, z0, z1, q) {
  if (q < 0.5) { t.poly(poly, z1, 0.75); return; } // far: a flat leaf
  const fwS = 0.06, ch = 0.008;
  const inner = insetPoly(poly, fwS);
  const ring = (pp, z) => pp.map((p) => [p[0], p[1], z]);
  const pc = insetPoly(poly, ch);
  t.loft([ring(poly, z0), ring(poly, z1 - ch)], true, 0.8);       // outer edge
  t.loft([ring(poly, z1 - ch), ring(pc, z1)], true, 0.9);         // chamfer
  t.loft([ring(pc, z1), ring(inner, z1)], true, 1);               // stiles and rails
  t.loft([ring(inner, z1), ring(inner, z0 + 0.005)], true, 0.7);  // inner edge round the louvres
  let yMin = Infinity, yMax = -Infinity;
  for (const p of inner) { yMin = Math.min(yMin, p[1]); yMax = Math.max(yMax, p[1]); }
  const mid = yMin + (yMax - yMin) * 0.42;
  const pitch = 0.052, zF = z1 - 0.012, zB = z0 + 0.008;
  for (let y = yMin + 0.012; y < yMax - 0.03; y += pitch) {
    if (Math.abs(y - mid) < 0.05) continue;
    const s0 = spanAtY(inner, y), s1 = spanAtY(inner, y + 0.042);
    if (!s0 || !s1) continue;
    const x0 = Math.max(s0[0], s1[0]) - 0.003, x1 = Math.min(s0[1], s1[1]) + 0.003;
    if (x1 - x0 < 0.05) continue;
    // slat sheds water towards the street: outer edge low and forward
    // only the upper face can be seen from the street; the underside faces the room
    t.quad([x0, y, zF], [x1, y, zF], [x1, y + 0.042, zB], [x0, y + 0.042, zB], 0.8, 1);
  }
  // mid rail
  const sm = spanAtY(inner, mid);
  if (sm) t.box(sm[0] - 0.01, mid - 0.045, z0 + 0.003, sm[1] + 0.01, mid + 0.045, z1 - 0.004, 1 | 16 | 32, 0.95, 1);
}

/** Rectangular left leaf below the spring line (arched heads whose fanlight stays glazed). */
function springLeafPoly(o, d) {
  const sp = springY(o) - 0.01, hw = o.w / 2;
  return [[-0.004, d], [-0.004, sp], [-hw + d, sp], [-hw + d, d]];
}

/**
 * Louvred shutters. state:
 *   closed      both leaves shut in front of the casement
 *   open        folded back flat against the wall either side (hinged at the reveal edge)
 *   openSpring  as open, leaves only up to the spring line (the fanlight has none)
 *   reveal      folded accordion-wise into the reveal (no room on the wall beside it)
 */
function buildShutters(o, state, q, standoff) {
  const t = new Tpl();
  const hw = o.w / 2;
  const mirror = (poly, f) => poly.map(f).reverse();
  if (state === 'reveal') {
    revealPanels(t, o, q);
  } else if (state === 'closed') {
    const left = leafPoly(o, 0.012);
    const z0 = FR.zf + 0.02, z1 = z0 + 0.034;
    leafGeometry(t, left, z0, z1, q);
    leafGeometry(t, mirror(left, (p) => [-p[0], p[1]]), z0, z1, q);
  } else {
    // folded back against the wall either side of the opening (hinged at the reveal edge)
    const left = state === 'openSpring' ? springLeafPoly(o, 0.012) : leafPoly(o, 0.012);
    const gap = standoff > 0.03 ? 0.0 : 0.05;
    const z0 = standoff, z1 = z0 + 0.034;   // relative to the wall face (the caller adds the recess)
    leafGeometry(t, mirror(left, (p) => [-2 * hw - gap - p[0], p[1]]), z0, z1, q);
    leafGeometry(t, left.map((p) => [2 * hw + gap + p[0], p[1]]), z0, z1, q); // two mirrors keep the winding
  }
  t.shadeBy((x, y) => 0.8 + 0.2 * smooth(0, 0.5, y));
  return t.bake();
}

/** Leaves folded into the reveal: per side a stack of narrow louvred panels standing
 *  square to the wall against the jamb, each no deeper than the reveal. */
function revealPanels(t, o, q) {
  const hw = o.w / 2, th = 0.03;
  const room = Math.max(0.12, o.recess - 0.06);
  const k = Math.max(2, Math.ceil((hw - 0.02) / room));
  const wp = (hw - 0.02) / k;
  const zA = 0.035;
  for (const sx of [-1, 1]) {
    for (let i = 0; i < k; i++) {
      const xo = hw - 0.012 - i * (th + 0.003);          // outer face (towards the jamb)
      const xi = xo - th;
      const top = Math.min(topAt(o, xo, 0.012), topAt(o, xi, 0.012)) - 0.012;
      if (!(top > 0.3)) continue;
      const x0 = sx < 0 ? -xo : xi, x1 = sx < 0 ? -xi : xo;
      const z1 = zA + wp - i * 0.01;
      t.box(x0, 0.012, zA, x1, top, z1, 1 | 4 | 8 | 32, 0.85, 0.95);
      // the other panels of the stack face their neighbour 3 mm away: louvres hidden
      if (q < 0.5 || i < k - 1) continue;
      // louvres on the face turned towards the opening
      const xf = sx < 0 ? x1 : x0, nx = sx < 0 ? 1 : -1;
      for (let y = 0.07; y < top - 0.06; y += 0.052) {
        const a = [xf + nx * 0.004, y, zA + 0.03], b = [xf + nx * 0.004, y, z1 - 0.03];
        const c = [xf, y + 0.04, z1 - 0.03], d = [xf, y + 0.04, zA + 0.03];
        if (nx > 0) t.quad(a, d, c, b, 0.75, 1); else t.quad(a, b, c, d, 0.75, 1);
      }
    }
  }
}

// ------------------------------------------------------------------ roller shutters
/**
 * External roller shutter of a flat-headed window (common on Mandate and modern
 * buildings): box under the head inside the reveal, guide channels down the jambs and
 * the slatted curtain lowered by `down` (0..1).
 */
function buildRoller(o, down, q) {
  const t = new Tpl();
  const hw = o.w / 2, top = o.h;
  const z0 = FR.zf + 0.01, z1 = Math.min(o.recess - 0.01, z0 + 0.17);
  const boxH = 0.2;
  t.box(-hw, top - boxH, z0, hw, top, z1, 1 | 16, 0.85, 1);
  for (const s of [-1, 1]) {
    const x = s * (hw - 0.02);
    t.box(x - 0.02, 0.0, z0 + 0.02, x + 0.02, top - boxH, z0 + 0.06, 1 | 4 | 8, 0.7, 0.85);
  }
  if (down > 0.02) {
    const y0 = top - boxH - (top - boxH) * down, y1 = top - boxH;
    const zc = z0 + 0.04;
    if (q < 0.5) t.box(-hw + 0.02, y0, zc - 0.005, hw - 0.02, y1, zc, 1, 0.85, 0.95);
    else {
      const pitch = 0.05;
      for (let y = y1; y > y0 + 1e-3; y -= pitch) {
        const ya = Math.max(y0, y - pitch), ym = ya + (y - ya) * 0.75;
        t.quad([-hw + 0.02, ya, zc], [hw - 0.02, ya, zc], [hw - 0.02, ym, zc + 0.008], [-hw + 0.02, ym, zc + 0.008], 0.78, 1);
        t.quad([-hw + 0.02, ym, zc + 0.008], [hw - 0.02, ym, zc + 0.008], [hw - 0.02, y, zc], [-hw + 0.02, y, zc], 1, 0.9);
      }
      t.box(-hw + 0.02, y0 - 0.03, zc - 0.01, hw - 0.02, y0, zc + 0.02, 1 | 16 | 32, 0.7, 0.8); // bottom rail
    }
  }
  return t.bake();
}

// ------------------------------------------------------------------ cache
const cache = new TplCache(2000);
const cached = (key, fn) => cache.get(key, fn);
const okey = (o) => `${o.kind}|${o.top}|${o.w.toFixed(3)}|${o.h.toFixed(3)}|${(o.rise ?? 0).toFixed(3)}`;

const openKey = (open) => (open ? `${open.side}:${open.angle.toFixed(2)}` : '-');
export function joineryTpl(o, v, q, open = null) {
  return cached(`J|${okey(o)}|${v.type}|${v.rows}|${v.cols}|${v.transom}|${v.sunburst}|${q}|${openKey(open)}`, () => buildJoinery(o, v, q, open));
}
/** {glass, hole}: glazing (with the swung pane) and, for an open leaf, its glassless aperture. */
export function glassTpl(o, v, q = 1, open = null) {
  return cached(`G|${okey(o)}|${v.type}|${q}|${openKey(open)}`, () => buildGlass(o, v, q, open));
}
/** Whether a window of this joinery can have a casement swung open. */
export function canOpen(o, v) { return v.type !== 'alu' && sashLayout(o, v).nL === 2; }
/**
 * Largest swing (radians) that keeps an opened leaf within `depth` metres behind the
 * infill plane (the buildings close each opening with a dark box that deep).
 */
export function openLimit(o, v, depth) {
  const L = sashLayout(o, v);
  const room = depth + L.P.zgb - 0.05;   // hinge sits at zgb; keep the leaf edge 5 cm clear
  return room <= 0 ? 0 : Math.asin(Math.min(1, room / L.lw));
}
/** Local z of far-range (lod 1) window glass. */
export const GLASS_Z_FAR = 0.03;
/** Shutters; open states are relative to the wall face (add with the opening matrix moved out by o.recess). */
export function shutterTpl(o, state, q, standoff = 0.012) {
  if (state === 'reveal') {
    // panels fit the reveal depth: quantise it so windows of a facade share them
    const rq = Math.round(o.recess / 0.03) * 0.03;
    return cached(`S|${okey(o)}|reveal|${rq.toFixed(2)}|${q}`, () => buildShutters({ ...o, recess: rq }, state, q, standoff));
  }
  return cached(`S|${okey(o)}|${state}|${standoff}|${q}`, () => buildShutters(o, state, q, standoff));
}
export function rollerTpl(o, down, q) {
  const d = Math.round(down * 20) / 20, rq = Math.round(o.recess / 0.03) * 0.03;
  return cached(`R|${okey(o)}|${rq.toFixed(2)}|${d}|${q}`, () => buildRoller({ ...o, recess: rq }, d, q));
}
