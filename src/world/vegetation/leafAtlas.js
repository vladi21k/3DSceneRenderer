import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { ATLAS_GRID } from './species.js';

// Procedural foliage atlas, painted once at start-up with the 2D canvas API.
// Every cell is a "spray" (a shoot carrying several leaves) seen from above, drawn twice
// with identical geometry: into a colour+alpha canvas and into a tangent-space normal
// canvas (each leaflet half is tilted, so leaflets read as folded along the midrib).
//
// Upload: the colour canvas is uploaded premultiplied and linear (no sRGB decode in the
// sampler). Mip levels of premultiplied data are correctly alpha-weighted, so leaf edges
// never pick up dark fringes at distance; the leaf shader divides by alpha and decodes
// sRGB itself (see vegMaterials.js). No CPU read-back is needed, so painting is cheap.
//
// Cell convention: the shoot is attached at the TOP centre of the cell (canvas y small)
// and grows downwards. Textures use flipY = false, so canvas rows map to increasing v and
// the attachment point sits at v ~ 0 of the cell. Canvas +x is tangent +u and canvas +y is
// tangent +v, so normals are encoded without flips.

const SIZE = 2048;
const CS = SIZE / ATLAS_GRID; // cell size in pixels

// ------------------------------------------------------------------ colour helpers
function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
function rgb(c) { return `rgb(${clamp255(c[0])},${clamp255(c[1])},${clamp255(c[2])})`; }
/** Vary an sRGB colour: value multiplier v, hue push h (+ yellower, - bluer). */
function vary(c, v, h = 0) {
  return [c[0] * v * (1 + h * 0.3), c[1] * v * (1 + h * 0.05), c[2] * v * (1 - h * 0.4)];
}
/** Encode a tangent-space normal as a CSS colour. */
function ncol(nx, ny, nz) {
  const l = Math.hypot(nx, ny, nz) || 1;
  return `rgb(${clamp255((nx / l * 0.5 + 0.5) * 255)},${clamp255((ny / l * 0.5 + 0.5) * 255)},${clamp255((nz / l * 0.5 + 0.5) * 255)})`;
}
const FLAT_N = ncol(0, 0, 1);

// Leaf palettes (sRGB). Real leaf albedo is low: green channel ~0.12-0.18 linear.
const PAL = {
  pagoda: { leaf: [86, 130, 36], dark: [62, 102, 30], young: [112, 150, 44], rib: [150, 172, 96], twig: [88, 94, 58] },
  ash: { leaf: [74, 116, 42], dark: [56, 94, 34], young: [98, 136, 48], rib: [138, 160, 96], twig: [100, 94, 74] },
  dense: { leaf: [60, 96, 34], dark: [44, 74, 26], young: [84, 120, 40], rib: [116, 138, 78], twig: [92, 84, 66] },
  shrub: { leaf: [52, 84, 38], dark: [38, 64, 28], young: [78, 110, 46], rib: [106, 128, 78], twig: [80, 72, 56] },
};

// ------------------------------------------------------------------ painter
/** Draws the same shapes into the colour and normal canvases. */
class Painter {
  constructor(cctx, nctx) { this.c = cctx; this.n = nctx; }
  save() { this.c.save(); this.n.save(); }
  restore() { this.c.restore(); this.n.restore(); }
  translate(x, y) { this.c.translate(x, y); this.n.translate(x, y); }

  /** Stroke a polyline (twig / rachis) of width w. */
  stroke(pts, w, color) {
    for (const [ctx, style] of [[this.c, rgb(color)], [this.n, FLAT_N]]) {
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
   * fold: tilt of each half (radians), curl: sideways bend of the tip.
   */
  blade(x, y, a, len, wid, color, { shape = 0, fold = 0.35, rib = null, serrate = 0, curl = 0 } = {}) {
    const fx = Math.cos(a), fy = Math.sin(a);
    const rx = -fy, ry = fx;
    const prof = [[0.55, 1.05, 0.72, 0.22], [0.4, 0.95, 0.72, 0.22], [0.3, 0.8, 1.05, 0.6], [0.7, 1.0, 0.5, 0.08]][shape];
    const P = (t, s) => {
      const c = curl * t * t * len;
      return [x + fx * t * len + rx * (s * wid + c), y + fy * t * len + ry * (s * wid + c)];
    };
    const n = serrate > 0 ? 12 : 6;
    for (const side of [1, -1]) {
      const pts = [P(0, 0)];
      for (let i = 1; i <= n; i++) {
        const t = i / (n + 1);
        const k = t * 3, j = Math.min(2, Math.floor(k)), f = k - j;
        let w = prof[j] + (prof[j + 1] - prof[j]) * (f * f * (3 - 2 * f));
        w *= Math.sin(Math.min(1, t * 3.2) * Math.PI / 2);
        if (serrate > 0 && i % 2 === 0) w *= 1 - serrate;
        pts.push(P(t, side * w));
      }
      pts.push(P(1, 0));
      const shade = side > 0 ? 1.0 : 0.93;
      const nx = -rx * side * Math.sin(fold), ny = -ry * side * Math.sin(fold), nz = Math.cos(fold);
      for (const [ctx, style] of [[this.c, rgb(vary(color, shade))], [this.n, ncol(nx + fx * 0.1, ny + fy * 0.1, nz)]]) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i], q = pts[i - 1];
          ctx.quadraticCurveTo(q[0], q[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
        }
        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
        ctx.closePath();
        ctx.fillStyle = style;
        ctx.fill();
      }
    }
    if (rib && len > 18) {
      const c = this.c, e = P(0.85, 0);
      c.beginPath(); c.moveTo(x, y); c.lineTo(e[0], e[1]);
      c.lineWidth = Math.max(0.7, len / 75);
      c.strokeStyle = `rgba(${rib[0]},${rib[1]},${rib[2]},0.5)`;
      c.stroke();
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
/** Bend direction that makes a leaf at angle `a` droop towards canvas +y (outwards along the shoot). */
function droopSign(a) { return Math.cos(a) >= 0 ? 1 : -1; }

/** Shrink `len` until a leaf from (x, y) along a stays inside the cell (with margin m). */
function fitLen(x, y, a, len, m = 16, reach = 1.15) {
  for (let k = 0; k < 8; k++) {
    const tx = x + Math.cos(a) * len * reach, ty = y + Math.sin(a) * len * reach;
    if (tx > m && tx < CS - m && ty > m && ty < CS - m) return len;
    len *= 0.88;
  }
  return len;
}

// ------------------------------------------------------------------ leaf builders
/** Pinnate compound leaf: rachis with opposite leaflet pairs and a terminal leaflet. */
function pinnateLeaf(P, rng, x, y, a, len, pal, o) {
  const rachis = curve(x, y, a, len, o.droop * rng.range(0.5, 1.2) * droopSign(a), 10);
  P.stroke(rachis, Math.max(1.1, len / 150), vary(pal.twig, rng.range(1.0, 1.2)));
  const tone = rng.range(0.9, 1.08), hue = rng.range(-0.2, 0.25);
  const base = rng.chance(0.12) ? pal.young : rng.chance(0.2) ? pal.dark : pal.leaf;
  const items = [];
  for (let i = 0; i < o.pairs; i++) {
    const t = 0.14 + (i / Math.max(1, o.pairs - 0.3)) * 0.8;
    const [px, py, dir] = along(rachis, Math.min(0.95, t));
    const sz = 0.75 + 0.3 * Math.sin(Math.PI * Math.min(1, t * 1.05));
    for (const side of [1, -1]) {
      if (rng.chance(0.03)) continue;
      items.push([px, py, dir + side * (o.angle + rng.range(-0.15, 0.15)), o.lfLen * sz * rng.range(0.88, 1.1), o.lfWid * sz * rng.range(0.88, 1.1)]);
    }
  }
  const e = rachis[rachis.length - 1], e0 = rachis[rachis.length - 2];
  items.push([e[0], e[1], Math.atan2(e[1] - e0[1], e[0] - e0[0]) + rng.range(-0.12, 0.12), o.lfLen * 1.05, o.lfWid]);
  for (const [px, py, ang, l, w] of items) {
    let col = rng.chance(0.006) ? [132, 126, 64] : base; // the odd yellowing leaflet
    col = vary(col, tone * rng.range(0.92, 1.08), hue + rng.range(-0.12, 0.12));
    P.blade(px, py, ang, l, w, col, { shape: o.shape, fold: rng.range(0.25, 0.5), rib: pal.rib, serrate: o.serrate, curl: rng.range(-0.1, 0.1) });
  }
}

/** A shoot of pinnate leaves (pagoda tree: alternate, ash: opposite pairs). */
function pinnateSpray(P, rng, kind) {
  const pal = PAL[kind];
  const ash = kind === 'ash';
  const cx = CS / 2 + rng.range(-10, 10), cy = 8;
  const twig = curve(cx, cy, Math.PI / 2 + rng.range(-0.12, 0.12), CS * rng.range(0.5, 0.62), rng.range(-0.25, 0.25), 8);
  P.stroke(twig, 3.4, vary(pal.twig, 0.85));
  const leaves = [];
  if (ash) {
    const pairs = rng.int(3, 4);
    for (let i = 0; i < pairs; i++) {
      const t = 0.22 + (i / pairs) * 0.72;
      const [px, py, dir] = along(twig, t);
      for (const side of [1, -1]) leaves.push([px, py, dir + side * rng.range(0.55, 1.0), CS * rng.range(0.36, 0.46)]);
    }
  } else {
    const n = rng.int(9, 11);
    for (let i = 0; i < n; i++) {
      const t = 0.06 + (i / n) * 0.92;
      const [px, py, dir] = along(twig, t);
      const side = i % 2 ? 1 : -1;
      leaves.push([px, py, dir + side * rng.range(0.55, 1.35) * (1 - t * 0.35), CS * rng.range(0.3, 0.42) * (1 - t * 0.2)]);
    }
  }
  const e = twig[twig.length - 1], e0 = twig[twig.length - 2];
  leaves.push([e[0], e[1], Math.atan2(e[1] - e0[1], e[0] - e0[0]) + rng.range(-0.2, 0.2), CS * rng.range(0.3, 0.36)]);
  for (const [px, py, a, l] of leaves) {
    const len = fitLen(px, py, a, l);
    const o = ash
      ? { pairs: rng.int(3, 5), lfLen: len * 0.3, lfWid: len * 0.055, shape: 1, droop: 0.35, serrate: 0.1, angle: 0.95 }
      : { pairs: rng.int(6, 8), lfLen: len * 0.15, lfWid: len * 0.062, shape: 0, droop: 0.45, serrate: 0, angle: 1.1 };
    pinnateLeaf(P, rng, px, py, a, len, pal, o);
  }
}

/** Shoots of simple, alternate, serrate leaves (dense older trees, hackberry-like). */
function simpleSpray(P, rng, kind) {
  const pal = PAL[kind];
  const cx = CS / 2 + rng.range(-12, 12), cy = 8;
  const main = curve(cx, cy, Math.PI / 2 + rng.range(-0.15, 0.15), CS * 0.78, rng.range(-0.3, 0.3), 10);
  const shoots = [main];
  for (let i = 0; i < 5; i++) {
    const [px, py, dir] = along(main, 0.12 + i * 0.13 + rng.range(0, 0.05));
    const side = i % 2 ? 1 : -1;
    shoots.push(curve(px, py, dir + side * rng.range(0.55, 0.95), CS * rng.range(0.26, 0.4), side * rng.range(-0.1, 0.5), 6));
  }
  for (const s of shoots) P.stroke(s, 2.2, vary(pal.twig, 0.9));
  const tone = rng.range(0.94, 1.05);
  for (const s of shoots) {
    const n = s === main ? 12 : 7;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 0.4);
      const [px, py, dir] = along(s, t);
      const side = i % 2 ? 1 : -1;
      const a = dir + side * rng.range(0.55, 1.0);
      const len = fitLen(px, py, a, CS * rng.range(0.1, 0.14) * (0.8 + 0.3 * Math.sin(Math.PI * t)), 8, 1.1);
      let col = rng.chance(0.12) ? pal.young : rng.chance(0.3) ? pal.dark : pal.leaf;
      col = vary(col, tone * rng.range(0.9, 1.08), rng.range(-0.2, 0.2));
      const pet = len * 0.1;
      P.blade(px + Math.cos(a) * pet, py + Math.sin(a) * pet, a, len, len * 0.24, col, { shape: 3, fold: rng.range(0.3, 0.55), rib: pal.rib, serrate: 0.06, curl: rng.range(-0.15, 0.15) });
    }
  }
}

/** Small-leaved shrub shoots ending in leaf rosettes (box / myrtle-like). */
function shrubSpray(P, rng) {
  const pal = PAL.shrub;
  for (let s = 0; s < 9; s++) {
    const shoot = curve(CS * rng.range(0.3, 0.7), 8, Math.PI / 2 + rng.range(-0.7, 0.7), CS * rng.range(0.45, 0.85), rng.range(-0.5, 0.5), 6);
    P.stroke(shoot, 1.8, pal.twig);
    const nodes = 6;
    for (let i = 1; i <= nodes; i++) {
      const [px, py, dir] = along(shoot, (i / nodes) * 0.98);
      const tip = i === nodes;
      const nl = tip ? 6 : 2;
      for (let k = 0; k < nl; k++) {
        const a = tip ? dir + (k / nl - 0.5) * 2.6 + rng.range(-0.2, 0.2) : dir + (k ? 1 : -1) * rng.range(0.5, 1.0);
        const l = fitLen(px, py, a, CS * rng.range(0.06, 0.085), 6, 1.05);
        let col = rng.chance(0.2) ? pal.young : rng.chance(0.3) ? pal.dark : pal.leaf;
        col = vary(col, rng.range(0.9, 1.1), rng.range(-0.2, 0.2));
        P.blade(px, py, a, l, l * 0.32, col, { shape: 2, fold: 0.45, rib: pal.rib });
      }
    }
  }
}

/** Pelargonium: rounded scalloped leaves with umbels of red / pink flowers above. */
function flowerSpray(P, rng) {
  const leafCol = [66, 100, 44];
  for (let i = 0; i < 16; i++) {
    const x = CS * rng.range(0.14, 0.86), y = CS * rng.range(0.18, 0.88);
    const r = CS * rng.range(0.06, 0.085);
    const col = vary(leafCol, rng.range(0.85, 1.1), rng.range(-0.2, 0.2));
    const tilt = [rng.range(-0.35, 0.35), rng.range(-0.35, 0.35)];
    for (const [ctx, style] of [[P.c, rgb(col)], [P.n, ncol(tilt[0], tilt[1], 1)]]) {
      ctx.beginPath();
      for (let k = 0; k <= 30; k++) {
        const a = (k / 30) * Math.PI * 2;
        const rr = r * (1 + 0.07 * Math.sin(a * 8)) * (a > 1.35 && a < 1.8 ? 0.6 : 1); // scallops + sinus
        if (k === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.fillStyle = style; ctx.fill();
    }
    P.c.beginPath(); P.c.arc(x, y, r * 0.55, 0, Math.PI * 2);
    P.c.lineWidth = r * 0.16; P.c.strokeStyle = 'rgba(64,52,30,0.28)'; P.c.stroke();
  }
  const palette = [[196, 30, 36], [210, 46, 56], [222, 92, 128], [190, 34, 80], [236, 232, 226]];
  for (let u = 0; u < 5; u++) {
    const x = CS * rng.range(0.2, 0.8), y = CS * rng.range(0.25, 0.75);
    const base = rng.pick(palette);
    const n = rng.int(12, 18);
    for (let k = 0; k < n; k++) {
      const a = rng.range(0, Math.PI * 2), d = Math.sqrt(rng.next()) * CS * 0.065;
      const fx = x + Math.cos(a) * d, fy = y + Math.sin(a) * d;
      const pr = CS * rng.range(0.014, 0.019);
      const col = vary(base, rng.range(0.85, 1.1));
      for (let p = 0; p < 5; p++) {
        const pa = (p / 5) * Math.PI * 2 + rng.range(0, 0.4);
        for (const [ctx, style] of [[P.c, rgb(col)], [P.n, ncol(Math.cos(pa) * 0.4, Math.sin(pa) * 0.4, 1)]]) {
          ctx.beginPath();
          ctx.ellipse(fx + Math.cos(pa) * pr * 0.8, fy + Math.sin(pa) * pr * 0.8, pr, pr * 0.72, pa, 0, Math.PI * 2);
          ctx.fillStyle = style; ctx.fill();
        }
      }
      P.c.beginPath(); P.c.arc(fx, fy, pr * 0.28, 0, Math.PI * 2); P.c.fillStyle = 'rgba(236,214,160,0.8)'; P.c.fill();
    }
  }
}

/** Far-LOD clump: many sprays from `srcCells` scattered over a disc in cell (col, row). */
function clump(cctx, rng, col, row, srcCells, count, scale) {
  const ox = col * CS, oy = row * CS;
  cctx.save();
  cctx.beginPath(); cctx.rect(ox, oy, CS, CS); cctx.clip();
  for (let i = 0; i < count; i++) {
    const src = rng.pick(srcCells);
    const sx = (src % ATLAS_GRID) * CS, sy = Math.floor(src / ATLAS_GRID) * CS;
    const ang = rng.range(0, Math.PI * 2);
    const rad = CS * Math.sqrt(rng.next()) * 0.26;
    const s = CS * scale * rng.range(0.85, 1.1);
    cctx.save();
    cctx.translate(ox + CS / 2 + Math.cos(ang) * rad, oy + CS / 2 + Math.sin(ang) * rad);
    cctx.rotate(rng.range(0, Math.PI * 2));
    cctx.drawImage(cctx.canvas, sx, sy, CS, CS, -s / 2, -s / 2, s, s);
    cctx.restore();
  }
  cctx.restore();
}

/** Dome-shaped tangent normals for the clump cells (far crowns still shade as volumes). */
function domeImage() {
  const c = makeCanvas(CS, CS), ctx = c.getContext('2d');
  const img = ctx.createImageData(CS, CS), d = img.data;
  for (let y = 0; y < CS; y++) {
    for (let x = 0; x < CS; x++) {
      const nx = ((x + 0.5) / CS * 2 - 1) * 0.55, ny = ((y + 0.5) / CS * 2 - 1) * 0.55;
      const nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
      const k = (y * CS + x) * 4;
      d[k] = clamp255((nx * 0.5 + 0.5) * 255); d[k + 1] = clamp255((ny * 0.5 + 0.5) * 255); d[k + 2] = clamp255((nz * 0.5 + 0.5) * 255); d[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ------------------------------------------------------------------ atlas
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Paint the atlas. Returns { map (premultiplied, linear-stored sRGB), normalMap, size, canvas }. */
export function buildLeafAtlas(renderer, seed = 1) {
  const cc = makeCanvas(SIZE, SIZE), nc = makeCanvas(SIZE, SIZE);
  const cctx = cc.getContext('2d');
  const nctx = nc.getContext('2d');
  nctx.fillStyle = FLAT_N;
  nctx.fillRect(0, 0, SIZE, SIZE);
  const P = new Painter(cctx, nctx);
  const cell = (i, fn) => {
    const x = (i % ATLAS_GRID) * CS, y = Math.floor(i / ATLAS_GRID) * CS;
    P.save(); P.translate(x, y);
    for (const ctx of [cctx, nctx]) { ctx.beginPath(); ctx.rect(0, 0, CS, CS); ctx.clip(); }
    fn(RNG.from(seed, 'leafcell', i));
    P.restore();
  };
  for (let i = 0; i < 4; i++) cell(i, (rng) => pinnateSpray(P, rng, 'pagoda'));
  for (let i = 4; i < 8; i++) cell(i, (rng) => pinnateSpray(P, rng, 'ash'));
  cell(8, (rng) => simpleSpray(P, rng, 'dense'));
  cell(9, (rng) => simpleSpray(P, rng, 'dense'));
  cell(10, (rng) => shrubSpray(P, rng));
  cell(11, (rng) => flowerSpray(P, rng));
  // far-LOD clumps composed from the sprays above
  const crng = RNG.from(seed, 'clumps');
  clump(cctx, crng, 0, 3, [0, 1, 2, 3], 13, 0.42);
  clump(cctx, crng, 1, 3, [4, 5, 6, 7], 13, 0.42);
  clump(cctx, crng, 2, 3, [8, 9], 15, 0.42);
  clump(cctx, crng, 3, 3, [10, 10, 11], 22, 0.42);
  const dome = domeImage();
  for (let i = 0; i < ATLAS_GRID; i++) nctx.drawImage(dome, i * CS, (ATLAS_GRID - 1) * CS);

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const mk = (canvas, premultiply) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace; // colour is decoded from sRGB in the shader (after un-premultiplying)
    t.premultiplyAlpha = premultiply;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = aniso;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  return { map: mk(cc, true), normalMap: mk(nc, false), size: SIZE, canvas: cc, normalCanvas: nc };
}

/** UV rectangle of atlas cell i: [u0, v0, u1, v1] (v0 = attachment edge). */
export function cellRect(i) {
  const x = i % ATLAS_GRID, y = Math.floor(i / ATLAS_GRID);
  return [x / ATLAS_GRID, y / ATLAS_GRID, (x + 1) / ATLAS_GRID, (y + 1) / ATLAS_GRID];
}
