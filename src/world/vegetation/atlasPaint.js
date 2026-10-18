import { RNG } from '../../core/rng.js';
import { ATLAS_GRID, CELL } from './species.js';

// Procedural foliage atlas painter (no three.js: it also runs in workers, see leafAtlas.js).
//
// Every near cell is one shoot tip seen from above: a short twig enters from the top edge
// and carries a clump of leaves radiating from it (compound leaves for pagoda and ash,
// simple leaves for the dense trees). Leaves are tilted at random, so their leaflets are
// foreshortened and the cell reads as a rounded clump rather than a flat frond. Leaflets
// are shaded lighter at the base and darker at the tip, with a darker rim, midrib and
// secondary veins. The planter shrubs' far-LOD cell is a clump composed from shrub cells.
//
// Two passes paint the same shapes (same code, same random sequence): 'color' (sRGB
// colour + coverage) and 'normal' (tangent-space normal x, y in R, G with z rebuilt in the
// shader, and a per-leaf gloss / thickness value in B: older leaves are thicker and
// glossier; alpha = coverage, used to weight the mips).
//
// Mips are built on the CPU (uploaded explicitly by leafAtlas.js):
//   * values are alpha-weighted when filtering and stored straight (not premultiplied);
//     empty texels take the colour of the coarser level (pull-push), so leaf edges never
//     pick up dark or foreign fringes at a distance;
//   * colour pass: alpha is rescaled per cell and per level so the fraction of texels
//     above 0.5 stays what it is at full resolution (coverage-preserving alpha mips).
//     Alpha-tested or sharpened cards keep their density and their holes at every
//     distance, in the camera view and in the shadow map alike.
//
// Cell convention: the shoot is attached at the TOP edge of the cell (canvas y small).
// Textures use flipY = false, so canvas rows map to increasing v and the attachment sits
// at v ~ 0 of the cell. Canvas +x is tangent +u and canvas +y is tangent +v.

export const SIZE = 2048;
const CS = SIZE / ATLAS_GRID; // cell size in pixels (fractional; cells keep a margin)

// ------------------------------------------------------------------ colour helpers
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
function rgb(c, a = 1) { return a < 1 ? `rgba(${clamp255(c[0])},${clamp255(c[1])},${clamp255(c[2])},${a})` : `rgb(${clamp255(c[0])},${clamp255(c[1])},${clamp255(c[2])})`; }
/** Vary an sRGB colour: value multiplier v, hue push h (+ yellower, - bluer). */
function vary(c, v, h = 0) {
  return [c[0] * v * (1 + h * 0.3), c[1] * v * (1 + h * 0.05), c[2] * v * (1 - h * 0.4)];
}
/** Encode a tangent-space normal (x, y; z is rebuilt in the shader) and a gloss value. */
function ncol(nx, ny, nz, gloss = 0.5) {
  const l = Math.hypot(nx, ny, nz) || 1;
  return `rgb(${clamp255((nx / l * 0.5 + 0.5) * 255)},${clamp255((ny / l * 0.5 + 0.5) * 255)},${clamp255(gloss * 255)})`;
}

// Leaf palettes (sRGB). Real leaf albedo is low (luminance ~0.08-0.15 linear): fresh mid
// greens with a little warmth for the young pagoda and ash trees (sunlit, they read light
// yellow-green), a dark glossy olive for the dense (ficus-like) ones. The crown's own
// occlusion (treeGen.js) darkens the inner leaves on top of this.
const PAL = {
  pagoda: { leaf: [94, 126, 38], dark: [70, 98, 32], young: [118, 148, 46], rib: [144, 162, 92], twig: [90, 100, 60] },
  ash: { leaf: [84, 116, 40], dark: [62, 90, 34], young: [106, 136, 48], rib: [132, 150, 90], twig: [100, 96, 76] },
  dense: { leaf: [60, 86, 36], dark: [44, 66, 30], young: [78, 104, 42], rib: [108, 124, 76], twig: [92, 84, 66] },
  shrub: { leaf: [54, 88, 40], dark: [40, 66, 30], young: [80, 114, 48], rib: [108, 130, 80], twig: [84, 76, 58] },
};

// ------------------------------------------------------------------ painter
/**
 * Draws into one target: the colour canvas (P.c) or the normal+gloss canvas (P.n); the
 * other one is null. Both passes run the same code with the same random sequence, so
 * their shapes match exactly.
 */
class Painter {
  constructor(ctx, kind) { this.ctx = ctx; this.c = kind === 'color' ? ctx : null; this.n = kind === 'normal' ? ctx : null; }
  save() { this.ctx.save(); }
  restore() { this.ctx.restore(); }
  translate(x, y) { this.ctx.translate(x, y); }
  clipCell() { this.ctx.beginPath(); this.ctx.rect(0, 0, CS, CS); this.ctx.clip(); }

  /** Stroke a polyline (twig / rachis) of width w. */
  stroke(pts, w, color, gloss = 0.4) {
    const ctx = this.ctx, style = this.c ? rgb(color) : ncol(0, 0, 1, gloss);
    {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = style; ctx.stroke();
    }
  }

  /**
   * Leaf blade with its base at (x, y) pointing along angle a (radians, canvas space),
   * length len, half-width wid. shape: 0 ovate, 1 lanceolate, 2 obovate, 3 acuminate.
   * fold: tilt of each half (radians); curl: sideways bend of the tip; tilt: [tx, ty]
   * normal tilt of the whole leaf (foreshortened leaves face away); gloss 0..1.
   */
  blade(x, y, a, len, wid, color, { shape = 0, fold = 0.35, rib = null, serrate = 0, curl = 0, tilt = [0, 0], gloss = 0.6, veins = true } = {}) {
    const fx = Math.cos(a), fy = Math.sin(a);
    const rx = -fy, ry = fx;
    const prof = [[0.55, 1.05, 0.72, 0.22], [0.4, 0.95, 0.72, 0.22], [0.3, 0.8, 1.05, 0.6], [0.7, 1.0, 0.5, 0.08]][shape];
    const P = (t, s) => {
      const c = curl * t * t * len;
      return [x + fx * t * len + rx * (s * wid + c), y + fy * t * len + ry * (s * wid + c)];
    };
    const widthAt = (t, i) => {
      const k = t * 3, j = Math.min(2, Math.floor(k)), f = k - j;
      let w = prof[j] + (prof[j + 1] - prof[j]) * (f * f * (3 - 2 * f));
      w *= Math.sin(Math.min(1, t * 3.2) * Math.PI / 2);
      if (serrate > 0 && i % 2 === 0) w *= 1 - serrate;
      return w;
    };
    const n = serrate > 0 ? 12 : Math.max(5, Math.min(9, Math.round(len / 5)));
    const big = len > 14;
    const half = (side) => {
      const pts = [P(0, 0)];
      for (let i = 1; i <= n; i++) { const t = i / (n + 1); pts.push(P(t, side * widthAt(t, i))); }
      pts.push(P(1, 0));
      return pts;
    };
    // smooth outline through the points (quadratic midpoints), appended to the current path
    const trace = (ctx, pts, first) => {
      if (first) ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i], q = pts[i - 1];
        ctx.quadraticCurveTo(q[0], q[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    };
    const R = half(1), L = half(-1);
    const c = this.c;
    if (c) {
      // colour: one outline; lighter at the base, darker towards the tip, thin darker rim
      // (the two halves shade differently through the normal map's fold)
      c.beginPath();
      trace(c, R, true);
      trace(c, L.slice().reverse(), false);
      c.closePath();
      if (big) {
        const g = c.createLinearGradient(x, y, x + fx * len, y + fy * len);
        g.addColorStop(0, rgb(vary(color, 1.07)));
        g.addColorStop(0.55, rgb(color));
        g.addColorStop(1, rgb(vary(color, 0.9, -0.1)));
        c.fillStyle = g;
      } else c.fillStyle = rgb(color);
      c.fill();
      if (big) { c.lineWidth = 0.9; c.strokeStyle = rgb(vary(color, 0.8), 0.55); c.stroke(); }
    } else {
      // normal: each half folded along the midrib, plus the tilt of the whole leaf
      for (const [side, pts] of [[1, R], [-1, L]]) {
        const nx = -rx * side * Math.sin(fold) + tilt[0], ny = -ry * side * Math.sin(fold) + tilt[1], nz = Math.cos(fold);
        this.n.beginPath(); trace(this.n, pts, true); this.n.closePath();
        this.n.fillStyle = ncol(nx + fx * 0.08, ny + fy * 0.08, nz, gloss); this.n.fill();
      }
    }
    if (rib && len > 16 && this.c) {
      const c = this.c, e = P(0.88, 0);
      c.beginPath(); c.moveTo(x, y); c.lineTo(e[0], e[1]);
      c.lineWidth = Math.max(0.7, len / 70);
      c.strokeStyle = rgb(rib, 0.55);
      c.stroke();
      // secondary veins at ~40 degrees towards the margin
      if (veins && len > 24) {
        const nv = Math.min(7, Math.max(4, Math.round(len / 9)));
        c.lineWidth = Math.max(0.5, len / 140);
        c.strokeStyle = rgb(rib, 0.25);
        c.beginPath();
        for (let i = 1; i <= nv; i++) {
          const t = 0.12 + (i / (nv + 1)) * 0.78;
          const o = P(t, 0);
          for (const side of [1, -1]) {
            const w = widthAt(t + 0.08, 1) * 0.85;
            const e2 = P(Math.min(0.97, t + 0.1 + w * wid / len * 0.8), side * w);
            c.moveTo(o[0], o[1]); c.lineTo(e2[0], e2[1]);
          }
        }
        c.stroke();
      }
    }
  }
}

// ------------------------------------------------------------------ shape helpers
/** Curved polyline from (x, y) along angle a, bending by `bend` radians over its length. */
function curve(x, y, a, len, bend, n = 8) {
  const pts = [[x, y]];
  let px = x, py = y, ang = a;
  for (let i = 0; i < n; i++) {
    ang += bend / n;
    px += Math.cos(ang) * len / n; py += Math.sin(ang) * len / n;
    pts.push([px, py]);
  }
  return pts;
}
/** Point + direction at fraction t of a polyline. */
function along(pts, t) {
  const n = pts.length - 1, f = Math.min(n - 1e-6, Math.max(0, t) * n), i = Math.floor(f), u = f - i;
  const a = pts[i], b = pts[i + 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, Math.atan2(b[1] - a[1], b[0] - a[0])];
}

/** Shrink `len` until a leaf from (x, y) along a stays inside the cell (with margin m). */
function fitLen(x, y, a, len, m = 12, reach = 1.12) {
  for (let k = 0; k < 10; k++) {
    const tx = x + Math.cos(a) * len * reach, ty = y + Math.sin(a) * len * reach;
    if (tx > m && tx < CS - m && ty > m && ty < CS - m) return len;
    len *= 0.88;
  }
  return len;
}

// ------------------------------------------------------------------ leaf builders
/**
 * Pinnate compound leaf: rachis with leaflet pairs and a terminal leaflet. The whole leaf
 * is seen at a random tilt: leaflet widths shrink by |cos(tilt)| and the normals lean away.
 */
function pinnateLeaf(P, rng, x, y, a, len, pal, o, layer) {
  const tiltA = rng.range(0, 1.2), fs = Math.abs(Math.cos(tiltA));
  const rachis = curve(x, y, a, len, o.droop * rng.range(-1, 1), 8);
  const ra = a + Math.PI / 2, ts = Math.sin(tiltA) * (rng.chance(0.5) ? 1 : -1) * 0.8;
  const tilt = [Math.cos(ra) * ts, Math.sin(ra) * ts];
  P.stroke(rachis, Math.max(1.0, len / 160), vary(pal.twig, rng.range(1.0, 1.2)), 0.35);
  const tone = rng.range(0.9, 1.07) * layer, hue = rng.range(-0.2, 0.25);
  const base = rng.chance(0.14) ? pal.young : rng.chance(0.22) ? pal.dark : pal.leaf;
  const gloss = clamp01(rng.range(0.35, 0.9) + (base === pal.dark ? 0.15 : base === pal.young ? -0.2 : 0));
  const items = [];
  for (let i = 0; i < o.pairs; i++) {
    const t = 0.16 + (i / Math.max(1, o.pairs - 0.4)) * 0.76;
    const [px, py, dir] = along(rachis, Math.min(0.94, t));
    const sz = 0.78 + 0.28 * Math.sin(Math.PI * Math.min(1, t * 1.05));
    const alt = o.alternate ? (rng.next() - 0.5) * 0.06 : 0;
    for (const side of [1, -1]) {
      if (rng.chance(0.04)) continue; // the odd missing leaflet
      const [qx, qy] = alt ? along(rachis, Math.min(0.95, t + side * alt)) : [px, py];
      items.push([qx, qy, dir + side * (o.angle + rng.range(-0.18, 0.18)), o.lfLen * sz * rng.range(0.88, 1.1), o.lfWid * sz * rng.range(0.88, 1.1) * (0.25 + 0.75 * fs)]);
    }
  }
  const e = rachis[rachis.length - 1], e0 = rachis[rachis.length - 2];
  items.push([e[0], e[1], Math.atan2(e[1] - e0[1], e[0] - e0[0]) + rng.range(-0.12, 0.12), o.lfLen * 1.05, o.lfWid * (0.25 + 0.75 * fs)]);
  for (const [px, py, ang, l, w] of items) {
    let col = rng.chance(0.008) ? [140, 132, 66] : base; // the odd yellowing leaflet
    col = vary(col, tone * rng.range(0.93, 1.07), hue + rng.range(-0.1, 0.1));
    P.blade(px, py, ang, l, w, col, { shape: o.shape, fold: rng.range(0.25, 0.5), rib: pal.rib, serrate: o.serrate,
      curl: rng.range(-0.12, 0.12), tilt, gloss: clamp01(gloss + rng.range(-0.08, 0.08)) });
  }
}

/**
 * Shoot tip with a clump of compound leaves (pagoda tree: many small ovate leaflets,
 * ash: fewer, long lanceolate ones). The twig enters from the top edge and the leaves
 * fan out all around its end, the lower layer a little darker (shaded by the upper one).
 */
function pinnateClump(P, rng, kind) {
  const pal = PAL[kind];
  const ash = kind === 'ash';
  const cx = CS * 0.5 + rng.range(-0.05, 0.05) * CS, cy = CS * rng.range(0.42, 0.5);
  const twig = curve(CS / 2 + rng.range(-6, 6), 3, Math.atan2(cy - 3, cx - CS / 2) + rng.range(-0.15, 0.15), Math.hypot(cx - CS / 2, cy - 3), rng.range(-0.3, 0.3), 6);
  P.stroke(twig, 2.6, vary(pal.twig, 0.85), 0.3);
  const n = ash ? rng.int(9, 11) : rng.int(10, 13);
  const tdir = along(twig, 0.99)[2];
  const leaves = [];
  for (let i = 0; i < n; i++) {
    // fan around the shoot end, avoiding the direction back up the twig
    const f = (i + rng.range(0.15, 0.85)) / n;
    const ang = tdir + (f - 0.5) * 2 * 2.45;
    const [px, py] = along(twig, rng.range(0.55, 1.0));
    const pitch = rng.range(0, 0.75);
    leaves.push([px, py, ang, CS * rng.range(0.34, 0.47) * (0.55 + 0.45 * Math.cos(pitch))]);
  }
  // draw order: random, first half is the lower (shaded) layer
  for (let i = leaves.length - 1; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); [leaves[i], leaves[j]] = [leaves[j], leaves[i]]; }
  leaves.forEach(([px, py, a, l], i) => {
    const len = fitLen(px, py, a, l);
    const o = ash
      ? { pairs: rng.int(3, 5), lfLen: len * 0.31, lfWid: len * 0.062, shape: 1, droop: 0.3, serrate: 0.08, angle: 0.85, alternate: false }
      : { pairs: rng.int(5, 7), lfLen: len * 0.2, lfWid: len * 0.078, shape: 0, droop: 0.4, serrate: 0, angle: 1.0, alternate: true };
    pinnateLeaf(P, rng, px, py, a, len, pal, o, i < leaves.length * 0.45 ? 0.86 : 1.0);
  });
}

/** Shoot tips of simple, alternate, serrate leaves (dense older trees, hackberry-like). */
function simpleClump(P, rng, kind) {
  const pal = PAL[kind];
  const cx = CS * 0.5 + rng.range(-12, 12), cy = CS * rng.range(0.4, 0.5);
  const main = curve(CS / 2, 3, Math.atan2(cy - 3, cx - CS / 2), Math.hypot(cx - CS / 2, cy - 3) * 1.6, rng.range(-0.3, 0.3), 10);
  const shoots = [main];
  const ns = rng.int(6, 7);
  for (let i = 0; i < ns; i++) {
    const [px, py, dir] = along(main, 0.3 + i * 0.12 + rng.range(0, 0.05));
    const side = i % 2 ? 1 : -1;
    shoots.push(curve(px, py, dir + side * rng.range(0.6, 1.3), CS * rng.range(0.24, 0.36), side * rng.range(-0.1, 0.5), 6));
  }
  for (const s of shoots) P.stroke(s, 2.0, vary(pal.twig, 0.9), 0.3);
  const tone = rng.range(0.94, 1.05);
  shoots.forEach((s, si) => {
    const n = s === main ? 9 : 6;
    const layer = si % 2 ? 0.88 : 1.0;
    for (let i = 1; i <= n; i++) {
      const t = 0.25 + (i / (n + 0.4)) * 0.75;
      const [px, py, dir] = along(s, t);
      const side = i % 2 ? 1 : -1;
      const a = dir + side * rng.range(0.55, 1.0);
      const len = fitLen(px, py, a, CS * rng.range(0.13, 0.17) * (0.8 + 0.3 * Math.sin(Math.PI * t)), 8, 1.1);
      let col = rng.chance(0.12) ? pal.young : rng.chance(0.3) ? pal.dark : pal.leaf;
      col = vary(col, tone * layer * rng.range(0.9, 1.08), rng.range(-0.2, 0.2));
      const pet = len * 0.1, ta = rng.range(0, 1.0), ts = Math.sin(ta) * 0.7;
      P.blade(px + Math.cos(a) * pet, py + Math.sin(a) * pet, a, len, len * 0.3 * (0.35 + 0.65 * Math.abs(Math.cos(ta))), col,
        { shape: 3, fold: rng.range(0.3, 0.55), rib: pal.rib, serrate: 0.06, curl: rng.range(-0.15, 0.15),
          tilt: [-Math.sin(a) * ts, Math.cos(a) * ts], gloss: rng.range(0.5, 0.95) });
    }
  });
}

/** Small-leaved shrub shoots ending in leaf rosettes (box / myrtle-like). */
function shrubSpray(P, rng) {
  const pal = PAL.shrub;
  for (let s = 0; s < 16; s++) {
    const shoot = curve(CS * rng.range(0.2, 0.8), 6, Math.PI / 2 + rng.range(-0.8, 0.8), CS * rng.range(0.45, 0.85), rng.range(-0.5, 0.5), 6);
    P.stroke(shoot, 1.6, pal.twig, 0.3);
    const nodes = 6;
    for (let i = 1; i <= nodes; i++) {
      const [px, py, dir] = along(shoot, (i / nodes) * 0.98);
      const tip = i === nodes;
      const nl = tip ? 6 : 2;
      for (let k = 0; k < nl; k++) {
        const a = tip ? dir + (k / nl - 0.5) * 2.6 + rng.range(-0.2, 0.2) : dir + (k ? 1 : -1) * rng.range(0.5, 1.0);
        const l = fitLen(px, py, a, CS * rng.range(0.07, 0.1), 6, 1.05);
        let col = rng.chance(0.2) ? pal.young : rng.chance(0.3) ? pal.dark : pal.leaf;
        col = vary(col, rng.range(0.88, 1.1), rng.range(-0.2, 0.2));
        P.blade(px, py, a, l, l * 0.32, col, { shape: 2, fold: 0.45, rib: pal.rib, gloss: rng.range(0.55, 0.95), veins: false });
      }
    }
  }
}

/** Pelargonium foliage: rounded scalloped leaves with a darker zone ring. */
function pelargoniumLeaves(P, rng) {
  const leafCol = [70, 106, 46];
  for (let i = 0; i < 30; i++) {
    const x = CS * rng.range(0.14, 0.86), y = CS * rng.range(0.16, 0.86);
    const r = CS * rng.range(0.06, 0.09);
    const col = vary(leafCol, rng.range(0.85, 1.1), rng.range(-0.2, 0.2));
    const tilt = [rng.range(-0.4, 0.4), rng.range(-0.4, 0.4)];
    const shape = (ctx) => {
      ctx.beginPath();
      for (let k = 0; k <= 30; k++) {
        const a = (k / 30) * Math.PI * 2;
        const rr = r * (1 + 0.07 * Math.sin(a * 8)) * (a > 1.35 && a < 1.8 ? 0.6 : 1); // scallops + sinus
        if (k === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
    };
    if (P.n) { shape(P.n); P.n.fillStyle = ncol(tilt[0], tilt[1], 1, 0.3); P.n.fill(); continue; }
    shape(P.c); P.c.fillStyle = rgb(col); P.c.fill();
    P.c.beginPath(); P.c.arc(x, y, r * 0.55, 0, Math.PI * 2);
    P.c.lineWidth = r * 0.16; P.c.strokeStyle = 'rgba(64,52,30,0.28)'; P.c.stroke();
  }
}

/** Flower umbel seen from the side: a stalk from the bottom carrying a dome of florets. */
function umbel(P, rng) {
  const cx = CS / 2, top = CS * 0.12, R = CS * 0.2;
  const cy = top + R;
  P.stroke(curve(cx, CS - 4, -Math.PI / 2 + rng.range(-0.05, 0.05), CS - 4 - cy, rng.range(-0.1, 0.1), 6), 5, [72, 100, 46], 0.3);
  const base = [206, 36, 44];
  for (let k = 0; k < 46; k++) {
    // florets on the upper half of a slightly flattened sphere, painted back to front
    const th = rng.range(0, Math.PI * 2), ph = Math.acos(rng.range(0.05, 1));
    const sx = Math.sin(ph) * Math.cos(th), sz = Math.sin(ph) * Math.sin(th), sy = Math.cos(ph);
    if (sz < -0.3) continue;
    const fx = cx + sx * R, fy = cy - sy * R * 0.8 + R * 0.25;
    const pr = CS * rng.range(0.035, 0.045);
    const col = vary(base, rng.range(0.82, 1.08) * (0.85 + 0.15 * sz));
    for (let p = 0; p < 5; p++) {
      const pa = (p / 5) * Math.PI * 2 + rng.range(0, 0.4);
      const ex = fx + Math.cos(pa) * pr * 0.75, ey = fy + Math.sin(pa) * pr * 0.75;
      const ctx = P.ctx;
      ctx.beginPath(); ctx.ellipse(ex, ey, pr, pr * 0.72, pa, 0, Math.PI * 2);
      ctx.fillStyle = P.c ? rgb(col) : ncol(sx * 0.6 + Math.cos(pa) * 0.3, -sy * 0.5 + Math.sin(pa) * 0.3, 1, 0.2); ctx.fill();
    }
    if (P.c) { P.c.beginPath(); P.c.arc(fx, fy, pr * 0.25, 0, Math.PI * 2); P.c.fillStyle = 'rgba(236,214,160,0.8)'; P.c.fill(); }
  }
}

/**
 * Far-LOD clump: sprays from `srcCells` scattered over a lobed disc in cell (col, row),
 * then cut by a soft lobed mask so the outline stays ragged.
 */
function clump(P, rng, col, row, srcCells, count) {
  const cctx = P.ctx;
  const ox = col * CS, oy = row * CS;
  cctx.save();
  cctx.beginPath(); cctx.rect(ox, oy, CS, CS); cctx.clip();
  for (let i = 0; i < count; i++) {
    const src = rng.pick(srcCells);
    const sx = (src % ATLAS_GRID) * CS, sy = Math.floor(src / ATLAS_GRID) * CS;
    const ang = rng.range(0, Math.PI * 2);
    const rad = CS * Math.sqrt(rng.next()) * 0.3;
    const s = CS * rng.range(0.5, 0.62);
    cctx.save();
    cctx.translate(ox + CS / 2 + Math.cos(ang) * rad, oy + CS / 2 + Math.sin(ang) * rad);
    cctx.rotate(rng.range(0, Math.PI * 2));
    cctx.drawImage(cctx.canvas, sx, sy, CS, CS, -s / 2, -s / 2, s, s);
    cctx.restore();
  }
  // lobed soft mask
  const lobes = [[3, rng.range(0, 6.3), 0.14], [5, rng.range(0, 6.3), 0.1], [7, rng.range(0, 6.3), 0.06]];
  const mask = makeCanvas(Math.ceil(CS), Math.ceil(CS)), mctx = mask.getContext('2d');
  mctx.filter = `blur(${(CS * 0.02).toFixed(1)}px)`;
  mctx.beginPath();
  for (let k = 0; k <= 64; k++) {
    const a = (k / 64) * Math.PI * 2;
    let r = 0.4;
    for (const [m, ph, amp] of lobes) r += amp * 0.4 * Math.sin(m * a + ph);
    const x = CS / 2 + Math.cos(a) * r * CS, y = CS / 2 + Math.sin(a) * r * CS;
    if (k === 0) mctx.moveTo(x, y); else mctx.lineTo(x, y);
  }
  mctx.fillStyle = '#fff'; mctx.fill();
  cctx.globalCompositeOperation = 'destination-in';
  cctx.drawImage(mask, ox, oy);
  if (P.n) { // normals: a dome over the clump (keeps the clump's alpha)
    cctx.globalCompositeOperation = 'source-atop';
    cctx.drawImage(domeImage(), ox, oy, CS, CS);
  }
  cctx.restore();
}

/** Dome-shaped tangent normals for the clump cells (far crowns still shade as volumes). */
let dome = null;
function domeImage() {
  if (dome) return dome;
  const n = Math.ceil(CS);
  const c = makeCanvas(n, n), ctx = c.getContext('2d');
  const img = ctx.createImageData(n, n), d = img.data;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const nx = ((x + 0.5) / CS * 2 - 1) * 0.6, ny = ((y + 0.5) / CS * 2 - 1) * 0.6;
      const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
      const k = (y * n + x) * 4;
      d[k] = clamp255((nx * 0.5 + 0.5) * 255); d[k + 1] = clamp255((ny * 0.5 + 0.5) * 255); d[k + 2] = 128; d[k + 3] = 255; // gloss 0.5
    }
  }
  ctx.putImageData(img, 0, 0);
  dome = c;
  return c;
}

// ------------------------------------------------------------------ mips
/**
 * Mip chain of one painted RGBA image (straight colour, alpha = coverage), in place on
 * level 0. castano: rescale alpha per cell to preserve coverage (colour pass).
 * Returns { levels: [{ data: Uint8Array, width, height }], coverage (per cell, level 0) }.
 */
function buildMips(img, castano) {
  const G = ATLAS_GRID, cells = G * G;
  const levels = [{ W: SIZE, C: img }];
  // alpha-weighted 2x2 box filter down to 1x1 (alpha is still the true coverage here)
  for (let W = SIZE; W > 1; W >>= 1) {
    const C = levels[levels.length - 1].C;
    const w = W >> 1;
    const C2 = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) {
      let i0 = (2 * y * W) * 4, o = y * w * 4;
      for (let x = 0; x < w; x++, i0 += 8, o += 4) {
        const i1 = i0 + 4, i2 = i0 + W * 4, i3 = i2 + 4;
        const a0 = C[i0 + 3], a1 = C[i1 + 3], a2 = C[i2 + 3], a3 = C[i3 + 3];
        const sa = a0 + a1 + a2 + a3;
        if (sa === 0) continue;
        const k = 1 / sa;
        C2[o] = (C[i0] * a0 + C[i1] * a1 + C[i2] * a2 + C[i3] * a3) * k;
        C2[o + 1] = (C[i0 + 1] * a0 + C[i1 + 1] * a1 + C[i2 + 1] * a2 + C[i3 + 1] * a3) * k;
        C2[o + 2] = (C[i0 + 2] * a0 + C[i1 + 2] * a1 + C[i2 + 2] * a2 + C[i3 + 2] * a3) * k;
        C2[o + 3] = (sa + 2) >> 2;
      }
    }
    levels.push({ W: w, C: C2 });
  }
  // coverage-preserving alpha: per cell and level, scale alpha so the fraction of texels
  // above 0.5 matches level 0 (the threshold t is read off a 256-bin histogram)
  const coverage = new Float32Array(cells), scale = new Float32Array(cells).fill(1);
  const hist = new Uint32Array(256);
  for (let k = 0; k < (castano ? levels.length : 1); k++) {
    const { W: w, C } = levels[k], cw = (CS * w) / SIZE;
    for (let cell = 0; cell < cells; cell++) {
      const cx = cell % G, cy = Math.floor(cell / G);
      const x0 = Math.floor(cx * cw), x1 = Math.floor((cx + 1) * cw), y0 = Math.floor(cy * cw), y1 = Math.floor((cy + 1) * cw);
      const count = (x1 - x0) * (y1 - y0);
      if (count <= 0) continue;
      if (k === 0) {
        let n = 0;
        for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4 + 3, e = (y * w + x1) * 4; i < e; i += 4) if (C[i] > 127) n++;
        coverage[cell] = n / count;
        continue;
      }
      if (cw >= 3 && coverage[cell] > 0) {
        hist.fill(0);
        for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4 + 3, e = (y * w + x1) * 4; i < e; i += 4) hist[C[i]]++;
        const want = coverage[cell] * count;
        let acc = 0, t = 255;
        while (t > 1 && acc + hist[t] < want) { acc += hist[t]; t--; }
        scale[cell] = Math.min(6, Math.max(1, 127.5 / t));
      }
      const s = scale[cell];
      if (s === 1) continue;
      for (let y = y0; y < y1; y++) for (let i = (y * w + x0) * 4 + 3, e = (y * w + x1) * 4; i < e; i += 4) C[i] = C[i] * s; // clamped array
    }
  }
  // pull-push: empty texels take the colour of their parent texel (already filled)
  for (let k = levels.length - 2; k >= 0; k--) {
    const L = levels[k], P = levels[k + 1], w = L.W;
    for (let y = 0; y < w; y++) {
      const prow = (y >> 1) * P.W;
      for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
        if (L.C[i + 3]) continue;
        const p = (prow + (x >> 1)) * 4;
        L.C[i] = P.C[p]; L.C[i + 1] = P.C[p + 1]; L.C[i + 2] = P.C[p + 2];
      }
    }
  }
  return { levels: levels.map((L) => ({ data: new Uint8Array(L.C.buffer), width: L.W, height: L.W })), coverage };
}

// ------------------------------------------------------------------ atlas
function makeCanvas(w, h) { return new OffscreenCanvas(w, h); }

/**
 * Paint one pass of the atlas ('color' or 'normal') and build its mips.
 * Returns { levels, coverage, ms: [paint, readback, mips] }.
 */
export function paintAtlas(seed, kind) {
  const T0 = performance.now();
  const canvas = makeCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: !!globalThis.__vegCpuCanvas });
  const P = new Painter(ctx, kind);
  const cell = (i, fn) => {
    const x = (i % ATLAS_GRID) * CS, y = Math.floor(i / ATLAS_GRID) * CS;
    P.save(); P.translate(x, y); P.clipCell();
    fn(RNG.from(seed, 'leafcell', i));
    P.restore();
  };
  for (const i of CELL.pagoda) cell(i, (rng) => pinnateClump(P, rng, 'pagoda'));
  for (const i of CELL.ash) cell(i, (rng) => pinnateClump(P, rng, 'ash'));
  for (const i of CELL.dense) cell(i, (rng) => simpleClump(P, rng, 'dense'));
  for (const i of CELL.shrub) cell(i, (rng) => shrubSpray(P, rng));
  cell(CELL.pelargonium[0], (rng) => pelargoniumLeaves(P, rng));
  cell(CELL.umbel[0], (rng) => umbel(P, rng));
  // planter far-LOD clump composed from the shrub cells above
  const crng = RNG.from(seed, 'clumps');
  for (const i of CELL.clumpShrub) clump(P, crng, i % ATLAS_GRID, Math.floor(i / ATLAS_GRID), [...CELL.shrub, ...CELL.shrub, CELL.pelargonium[0]], 11);
  const T1 = performance.now();
  const img = new Uint8ClampedArray(ctx.getImageData(0, 0, SIZE, SIZE).data.buffer);
  const T2 = performance.now();
  const out = buildMips(img, kind === 'color');
  out.ms = [T1 - T0, T2 - T1, performance.now() - T2].map((x) => +x.toFixed(1));
  return out;
}
