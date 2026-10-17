// Shopfronts in the ground-floor openings: steel or timber frames with large display
// glass over a stall riser, a (sometimes recessed) glazed door, transom bar, fanlight or
// sign panel in the head, roller-shutter box and guides. Glass is interior-mapped
// (shop kind: shelves, goods, ceiling lights).
import { Tpl } from './geo.js';
import { outlinePts, halfWidthAt, springY, headSegments, isArched, headCentre, topAt } from './outline.js';
import { rectRing } from './kit.js';

const FW = 0.085;           // shopfront casing width
const ZF = 0.04, ZB = -0.07, CH = 0.01;

function rail(t, a, b, w, zf, zb, shade = 1) {
  t.piece(0.05).bar(a, b, [[-w / 2, zb], [-w / 2, zf - CH], [-w / 2 + CH, zf], [w / 2 - CH, zf], [w / 2, zf - CH], [w / 2, zb]], shade);
}

/**
 * Layout decisions for one shopfront (deterministic per opening). `back` is the depth
 * available behind the infill plane (the buildings' dark box): a recessed entrance and
 * its glazed returns must stay inside it.
 */
export function shopLayout(o, rng, back = 0.4) {
  const hwI = o.w / 2 - FW;
  const arched = isArched(o);
  const sp = springY(o);
  let yT;
  if (arched) yT = Math.min(Math.max(2.45, sp), 3.3);
  else yT = o.h > 3.3 ? Math.min(o.h - 0.55, rng.range(2.6, 3.0)) : o.h - FW;
  const doorW = Math.min(rng.range(0.92, 1.08), hwI * 2 - 0.2);
  const narrow = o.w < 1.9;
  const pos = narrow ? 0 : rng.weighted([[-1, 0.3], [1, 0.3], [0, 0.4]]);
  const dx = pos === 0 ? 0 : pos * (hwI - doorW / 2 - rng.range(0.0, 0.35));
  let setback = rng.chance(0.45) && !narrow ? rng.range(0.45, 0.9) : 0;
  setback = Math.min(setback, back - 0.07);
  if (setback < 0.18) setback = 0;
  // the head is glazed (sunburst bars under arches); a solid panel only carries a sign
  const head = arched ? 'fan' : yT < o.h - FW - 0.2 ? 'glass' : 'none';
  return {
    hwI, yT, arched, doorW, dx, setback,
    doorH: Math.min(yT - 0.06, rng.range(2.2, 2.4)),
    riser: rng.range(0.3, 0.55),
    head,
    box: rng.chance(0.75),                     // roller-shutter box + guides
    shutterDown: rng.chance(0.08) ? rng.range(0.25, 1.0) : 0, // fraction the roller shutter is down
    mullions: Math.max(0, Math.round((hwI * 2 - doorW) / 1.25) - 1),
    timber: rng.chance(0.3),
  };
}

/** Frame (paint) template for the shopfront. */
export function shopFrameTpl(o, L, q) {
  const t = new Tpl();
  const n = headSegments(o, q);
  const ring = (d, z) => outlinePts(o, d, n).map((p) => [p[0], p[1], z]);
  if (q < 0.5) t.loft([ring(0, ZF), ring(FW, ZF)], true, 1);
  else {
    t.loft([ring(0, ZF), ring(FW - CH, ZF)], true, 1);
    t.loft([ring(FW - CH, ZF), ring(FW, ZF - CH)], true, 0.95);
    t.loft([ring(FW, ZF - CH), ring(FW, ZB)], true, 0.78);
  }
  const { hwI, yT, doorW, dx, setback, doorH, riser } = L;
  const d0 = dx - doorW / 2, d1 = dx + doorW / 2;
  if (q < 0.5) {
    // far: casing, transom, risers and door posts as flat faces
    if (yT < o.h - FW - 0.05) t.box(-hwI, yT - 0.05, -0.04, hwI, yT + 0.05, ZF - 0.005, 1, 1, 1);
    t.box(-hwI, 0, -0.04, hwI, riser, 0.02, 1, 0.8, 0.9);
    t.box(d0 - 0.06, 0, -0.04, d0, yT, ZF - 0.01, 1, 1, 1);
    t.box(d1, 0, -0.04, d1 + 0.06, yT, ZF - 0.01, 1, 1, 1);
    return t.bake();
  }
  // transom bar
  if (yT < o.h - FW - 0.05) rail(t, [-hwI - 0.01, yT], [hwI + 0.01, yT], 0.1, ZF - 0.005, ZB);
  const yG = yT - 0.05; // top of the display glass
  // stall risers either side of the door
  const riserBox = (x0, x1) => {
    if (x1 - x0 < 0.08) return;
    t.box(x0, FW * 0.5, -0.03, x1, riser, 0.02, 1 | 32, 0.8, 0.95);
    if (q >= 0.5) t.box(x0 + 0.07, 0.12, 0.02, x1 - 0.07, riser - 0.07, 0.032, 1 | 4 | 8 | 16 | 32, 0.85, 0.95);
    rail(t, [x0, riser + 0.03], [x1, riser + 0.03], 0.06, 0.03, -0.03, 1);
  };
  riserBox(-hwI, d0 - 0.03);
  riserBox(d1 + 0.03, hwI);
  // door posts (full height of the display zone)
  rail(t, [d0 - 0.03, 0], [d0 - 0.03, yG + 0.03], 0.07, ZF - 0.01, ZB, 1);
  rail(t, [d1 + 0.03, 0], [d1 + 0.03, yG + 0.03], 0.07, ZF - 0.01, ZB, 1);
  // mullions in the display windows
  const segs = [[-hwI, d0 - 0.065], [d1 + 0.065, hwI]];
  for (const [a, b] of segs) {
    const w = b - a;
    if (w < 0.3) continue;
    const nm = Math.max(0, Math.round(w / 1.3) - 1);
    for (let i = 1; i <= nm; i++) {
      const x = a + (w * i) / (nm + 1);
      rail(t, [x, riser + 0.06], [x, yG + 0.03], 0.055, ZF - 0.015, ZB, 1);
    }
  }
  // the door: either flush in the front or set back with glazed returns
  const zD = -setback;
  const dz0 = zD - 0.02, dz1 = zD + 0.03;
  if (setback > 0) {
    // head over the recess (soffit) and the returns' top rail
    t.box(d0 - 0.06, doorH, zD, d1 + 0.06, doorH + 0.08, ZF - 0.02, 1 | 16, 0.6, 0.8);
    rail(t, [d0 - 0.03, doorH + 0.04], [d1 + 0.03, doorH + 0.04], 0.08, dz1 + 0.01, dz0 - 0.02, 0.9);
    // return frame posts at the back corners
    t.box(d0 - 0.06, 0, zD - 0.04, d0 - 0.0, doorH, zD + 0.04, 1 | 8, 0.8, 0.9);
    t.box(d1 + 0.0, 0, zD - 0.04, d1 + 0.06, doorH, zD + 0.04, 1 | 4, 0.8, 0.9);
    // low kick rail along the returns
    t.box(d0 - 0.05, 0, zD, d0 - 0.01, 0.25, ZF - 0.05, 8 | 32, 0.75, 0.85);
    t.box(d1 + 0.01, 0, zD, d1 + 0.05, 0.25, ZF - 0.05, 4 | 32, 0.75, 0.85);
  } else {
    rail(t, [d0 - 0.03, doorH + 0.04], [d1 + 0.03, doorH + 0.04], 0.08, ZF - 0.01, ZB, 1);
  }
  // door leaf: wide stiles, kick plate
  const dl = d0 + 0.012, dr = d1 - 0.012;
  const sw = L.timber ? 0.11 : 0.085, bw = L.timber ? 0.2 : 0.16;
  t.loft([rectRing(dl, 0.01, dr, doorH - 0.01, [0, 0, 0, 0], dz1), rectRing(dl, 0.01, dr, doorH - 0.01, [sw, bw, sw, sw], dz1)], true, 1);
  t.loft([rectRing(dl, 0.01, dr, doorH - 0.01, [sw, bw, sw, sw], dz1), rectRing(dl, 0.01, dr, doorH - 0.01, [sw, bw, sw, sw], dz0)], true, 0.75);
  if (L.timber && q >= 0.5) t.box(dl + sw, 0.02, dz0, dr - sw, 0.35, dz1 - 0.008, 1 | 32, 0.9, 1);
  // head: vertical bars in the fanlight, or a solid panel (sign ground)
  const yH = yT + 0.05;
  if (L.head === 'fan' && q >= 0.5) {
    const [cx, cy] = headCentre(o);
    const nb = o.w > 2.6 ? 7 : 5;
    for (let k = 1; k <= nb; k++) {
      const a = (Math.PI * k) / (nb + 1);
      const ex = cx + Math.cos(a) * 3, ey = cy + Math.sin(a) * 3;
      // clip the spoke to the inner casing
      let lo = 0, hi = 1;
      for (let i = 0; i < 16; i++) {
        const m = (lo + hi) / 2, x = cx + (ex - cx) * m, y = cy + (ey - cy) * m;
        const top = topAt(o, x, FW - 0.01);
        if (Number.isFinite(top) && y < top) lo = m; else hi = m;
      }
      const s0 = Math.max(0, (yH - cy) / Math.max(0.05, Math.sin(a)));
      const sx = cx + Math.cos(a) * s0, sy = cy + Math.sin(a) * s0;
      const x1 = cx + (ex - cx) * lo, y1 = cy + (ey - cy) * lo;
      if (y1 - sy > 0.05) rail(t, [sx, sy], [x1, y1], 0.035, ZF - 0.02, -0.04, 0.95);
    }
  } else if (L.head === 'glass' && q >= 0.5) {
    const nb = Math.max(1, Math.round(hwI * 2 / 1.2));
    for (let i = 1; i < nb; i++) {
      const x = -hwI + (2 * hwI * i) / nb;
      rail(t, [x, yH - 0.01], [x, topAt(o, x, FW - 0.01)], 0.045, ZF - 0.015, -0.04, 0.95);
    }
  } else if (L.head === 'panel' && !L.headSign) {
    const pts = outlinePts(o, FW - 0.005, n).filter((p) => p[1] > yH + 0.001);
    const hw = halfWidthAt(o, yH, FW - 0.005);
    const poly = [[-hw, yH], [hw, yH], ...pts];
    t.poly(poly, -0.02, 0.9);
  }
  // grime: darkest at the riser where pavement splash and kicks reach, a dirty band
  // under the transom bar
  t.shadeBy((x, y) => (0.74 + 0.26 * Math.min(1, y / 0.6)) * (y < yT && y > yT - 0.35 ? 0.94 + 0.06 * (yT - y) / 0.35 : 1));
  return t.bake();
}

/**
 * Interior-mapped glass of the shopfront: display windows, door, top lights, head glass.
 * Far range (q < 0.5): one plane 2.5 cm proud of the infill plane (door included), clear
 * of the buildings' far-range back plate.
 */
export function shopGlassTpl(o, L, q = 1) {
  const t = new Tpl();
  const { hwI, yT, doorW, dx, doorH, riser } = L;
  const far = q < 0.5;
  const setback = far ? 0 : L.setback;
  const d0 = dx - doorW / 2, d1 = dx + doorW / 2;
  const gz = far ? SHOP_GLASS_Z_FAR : -0.02, yG = yT - 0.05;
  const rect = (x0, y0, x1, y1, z) => { if (x1 - x0 > 0.05 && y1 - y0 > 0.05) t.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]); };
  rect(-hwI, riser, d0 - 0.03, yG, gz);
  rect(d1 + 0.03, riser, hwI, yG, gz);
  // over the door (top light) — in the front plane
  rect(d0 - 0.03, doorH + 0.08, d1 + 0.03, yG, gz);
  // door glass
  const zD = far ? gz : -setback - 0.005;
  if (far) rect(d0, 0.02, d1, doorH + 0.08, zD);
  else rect(d0 + 0.08, 0.3, d1 - 0.08, doorH - 0.1, zD);
  if (setback > 0) {
    // glazed returns either side of the recessed entrance (facing into the recess)
    t.quad([d0 - 0.03, 0.25, gz], [d0 - 0.03, 0.25, -setback], [d0 - 0.03, doorH, -setback], [d0 - 0.03, doorH, gz]);
    t.quad([d1 + 0.03, 0.25, -setback], [d1 + 0.03, 0.25, gz], [d1 + 0.03, doorH, gz], [d1 + 0.03, doorH, -setback]);
  }
  // head
  if (L.head !== 'panel' && yT < o.h - FW - 0.05) {
    const yH = yT + 0.05;
    const pts = outlinePts(o, FW - 0.01).filter((p) => p[1] > yH + 0.001);
    const hw = halfWidthAt(o, yH, FW - 0.01);
    t.poly([[-hw, yH], [hw, yH], ...pts], gz);
  }
  return t.bake();
}

/** Roller-shutter box, guides and (optionally) the lowered shutter curtain. Steel. */
export function shopShutterTpl(o, L, q) {
  const t = new Tpl();
  const { hwI, yT } = L;
  const top = L.arched ? yT : o.h - FW;
  const boxH = 0.22, z0 = ZF - 0.02, z1 = z0 + Math.min(0.16, o.recess - 0.08);
  const hw = halfWidthAt(o, top, FW) + 0.02;
  t.box(-hw, top - boxH, z0, hw, top, z1, 1 | 16 | 4 | 8, 0.85, 1);
  if (q >= 0.5) t.box(-hw, top - boxH - 0.012, z0, hw, top - boxH, z1 - 0.03, 1 | 16, 0.6, 0.7); // slot lip
  // guide channels down the jambs
  for (const s of [-1, 1]) {
    const x = s * (hwI + FW - 0.035);
    t.box(x - 0.03, 0, z0, x + 0.03, top - boxH, z0 + 0.06, 1 | 4 | 8, 0.75, 0.9);
  }
  if (L.shutterDown > 0) {
    const yb = (top - boxH) * (1 - L.shutterDown);
    const zc = z0 + 0.03;
    // corrugated curtain: alternating slat facets
    const pitch = q >= 0.5 ? 0.08 : 0.32;
    for (let y = top - boxH; y > yb + 1e-3; y -= pitch) {
      const y0 = Math.max(yb, y - pitch), ym = (y0 + y) / 2;
      t.quad([-hwI - 0.02, y0, zc], [hwI + 0.02, y0, zc], [hwI + 0.02, ym, zc + 0.012], [-hwI - 0.02, ym, zc + 0.012], 0.8, 1);
      t.quad([-hwI - 0.02, ym, zc + 0.012], [hwI + 0.02, ym, zc + 0.012], [hwI + 0.02, y, zc], [-hwI - 0.02, y, zc], 1, 0.85);
    }
    t.box(-hwI - 0.02, yb - 0.04, zc - 0.01, hwI + 0.02, yb, zc + 0.03, 1 | 16 | 32, 0.7, 0.8);
  }
  return t.bake();
}

export const SHOP_FW = FW;
/** Local z of far-range shop glass. */
export const SHOP_GLASS_Z_FAR = 0.025;

/**
 * Lining of a recessed entrance: a worn stone floor (threshold slab) and the reveal
 * returns' plinths between the street front and the set-back door. Stone batch.
 */
export function shopRecessTpl(o, L) {
  const t = new Tpl();
  if (!L.setback) return null;
  const d0 = L.dx - L.doorW / 2 - 0.06, d1 = L.dx + L.doorW / 2 + 0.06;
  // floor slab, slightly lower in the middle where it is worn
  t.box(d0, -0.03, -L.setback - 0.02, d1, 0.004, 0.0, 32 | 1, 0.78, 0.92);
  return t.bake();
}

// Shopfront templates shared by the same-size shops of one design (key: lot seed and
// design variant); the cache is bounded.
const cache = new Map();
/** {frame, glass, shutter, recess} templates for shopfront o with layout L. */
export function shopTpls(design, o, L, q) {
  const key = `${design}|${o.top}|${o.w.toFixed(3)}|${o.h.toFixed(3)}|${(o.rise ?? 0).toFixed(3)}|${o.recess.toFixed(2)}|${q}`;
  let v = cache.get(key);
  if (!v) {
    if (cache.size > 600) cache.clear();
    v = { frame: shopFrameTpl(o, L, q), glass: shopGlassTpl(o, L, q), shutter: L.box ? shopShutterTpl(o, L, q) : null, recess: q >= 0.5 ? shopRecessTpl(o, L) : null };
    cache.set(key, v);
  }
  return v;
}
