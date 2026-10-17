import { RNG } from '../../core/rng.js';

// Cast-iron detail atlas generator (no three.js dependency so it also runs in a
// worker): height and mask maps drawn with Canvas 2D, then turned into albedo (sRGB),
// tangent-space normals (Sobel) and an ORM map (roughness in G, metalness in B):
// worn raised metal, dusty / rusty recesses, black voids, soil and mulch.
// One corner holds four fallen-leaf cut-outs (alpha; near-white albedo tinted by vertex
// colour), so the leaves on the paving draw with the iron in one call.

export const ATLAS = 1024;

/** Atlas regions in pixels and their real size in metres. */
export const IRON_REGIONS = {
  manhole: { x: 0, y: 0, w: 512, h: 512, mw: 0.8, mh: 0.8 },
  treeGrate: { x: 512, y: 0, w: 512, h: 512, mw: 1.24, mh: 1.24 },
  gully: { x: 0, y: 512, w: 512, h: 256, mw: 0.62, mh: 0.31 },
  drain: { x: 0, y: 768, w: 512, h: 256, mw: 1.0, mh: 0.5 },
  plate: { x: 512, y: 512, w: 256, h: 256, mw: 0.6, mh: 0.6 },
  valve: { x: 768, y: 512, w: 128, h: 128, mw: 0.32, mh: 0.32 },
  leaves: { x: 896, y: 512, w: 128, h: 128 },     // 2 x 2 leaf cells
  plate2: { x: 512, y: 768, w: 512, h: 256, mw: 1.0, mh: 0.5 },
};

export function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Small tileable value-noise lookup for per-pixel variation. */
export function makeNoise(seed, n = 64) {
  const rng = RNG.from('street-tex', seed);
  const g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    const x0 = ((ix % n) + n) % n, y0 = ((iy % n) + n) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = g[y0 * n + x0] + (g[y0 * n + x1] - g[y0 * n + x0]) * sx;
    const b = g[y1 * n + x0] + (g[y1 * n + x1] - g[y1 * n + x0]) * sx;
    return a + (b - a) * sy;
  };
}

// ------------------------------------------------------------------ drawing
function drawIron(hc, mc) {
  const H = hc.getContext('2d'), M = mc.getContext('2d');
  H.fillStyle = 'rgb(128,128,128)'; H.fillRect(0, 0, ATLAS, ATLAS);
  M.fillStyle = 'rgb(0,0,0)'; M.fillRect(0, 0, ATLAS, ATLAS);
  const gray = (v) => `rgb(${v},${v},${v})`;
  const rng = RNG.from('street-iron');

  // --- round manhole (0.8 m frame, 0.67 m cover, concentric rings)
  {
    const R = IRON_REGIONS.manhole, cx = R.x + R.w / 2, cy = R.y + R.h / 2, px = R.w / R.mw;
    const circ = (r, v) => { H.fillStyle = gray(v); H.beginPath(); H.arc(cx, cy, r * px, 0, Math.PI * 2); H.fill(); };
    circ(0.4, 200);          // frame
    circ(0.343, 20);         // gap
    circ(0.336, 120);        // cover base
    for (let r = 0.315; r > 0.09; r -= 0.028) {
      H.strokeStyle = gray(215); H.lineWidth = 0.011 * px;
      H.beginPath(); H.arc(cx, cy, r * px, 0, Math.PI * 2); H.stroke();
    }
    circ(0.075, 190);
    // emblem: cross bars in the centre plate
    H.fillStyle = gray(235);
    H.fillRect(cx - 0.05 * px, cy - 0.008 * px, 0.1 * px, 0.016 * px);
    H.fillRect(cx - 0.008 * px, cy - 0.05 * px, 0.016 * px, 0.1 * px);
    // pick holes
    M.fillStyle = 'rgb(255,0,0)';
    for (const a of [0.3, 0.3 + Math.PI]) {
      const x = cx + Math.cos(a) * 0.29 * px, y = cy + Math.sin(a) * 0.29 * px;
      M.save(); M.translate(x, y); M.rotate(a + Math.PI / 2); M.fillRect(-0.02 * px, -0.006 * px, 0.04 * px, 0.012 * px); M.restore();
      H.save(); H.translate(x, y); H.rotate(a + Math.PI / 2); H.fillStyle = gray(10); H.fillRect(-0.02 * px, -0.006 * px, 0.04 * px, 0.012 * px); H.restore();
    }
  }

  // --- tree grate (1.24 m square, 0.46 m trunk opening, radial slots)
  {
    const R = IRON_REGIONS.treeGrate, cx = R.x + R.w / 2, cy = R.y + R.h / 2, px = R.w / R.mw;
    H.fillStyle = gray(205); H.fillRect(R.x, R.y, R.w, R.h);                        // frame
    H.fillStyle = gray(150); H.fillRect(R.x + 0.035 * px, R.y + 0.035 * px, R.w - 0.07 * px, R.h - 0.07 * px);
    H.strokeStyle = gray(30); H.lineWidth = 0.006 * px;                               // joint between halves
    H.beginPath(); H.moveTo(cx, R.y + 0.035 * px); H.lineTo(cx, R.y + R.h - 0.035 * px); H.stroke();
    // radial slots in rings
    M.fillStyle = 'rgb(255,255,0)';
    const slot = (a, r0, r1, w) => {
      for (const C of [H, M]) {
        C.save(); C.translate(cx, cy); C.rotate(a);
        if (C === H) C.fillStyle = gray(12);
        C.fillRect(r0 * px, -w * px / 2, (r1 - r0) * px, w * px);
        C.restore();
      }
    };
    const rings = [[0.27, 0.34, 40], [0.37, 0.45, 52], [0.48, 0.56, 64], [0.59, 0.66, 76], [0.69, 0.78, 88]];
    for (const [r0, r1, n] of rings) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (r0 * 7) % 1;
        // keep slots inside the square frame
        const ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a));
        const lim = 0.58 / Math.max(ca, sa);
        if (r0 > lim - 0.02) continue;
        slot(a, r0, Math.min(r1, lim - 0.01), 0.013);
      }
    }
    // ring bars between slot rings
    H.strokeStyle = gray(185); H.lineWidth = 0.014 * px;
    for (const r of [0.355, 0.465, 0.575]) { H.beginPath(); H.arc(cx, cy, r * px, 0, Math.PI * 2); H.stroke(); }
    // trunk opening with soil / mulch
    H.fillStyle = gray(200); H.beginPath(); H.arc(cx, cy, 0.25 * px, 0, Math.PI * 2); H.fill();
    H.fillStyle = gray(25); H.beginPath(); H.arc(cx, cy, 0.23 * px, 0, Math.PI * 2); H.fill();
    M.fillStyle = 'rgb(0,255,0)'; M.beginPath(); M.arc(cx, cy, 0.23 * px, 0, Math.PI * 2); M.fill();
    // lumps of mulch
    for (let i = 0; i < 260; i++) {
      const a = rng.range(0, Math.PI * 2), r = Math.sqrt(rng.next()) * 0.225;
      H.fillStyle = gray(25 + rng.int(0, 60));
      H.beginPath(); H.ellipse(cx + Math.cos(a) * r * px, cy + Math.sin(a) * r * px, rng.range(0.006, 0.016) * px, rng.range(0.004, 0.01) * px, rng.range(0, 3), 0, Math.PI * 2); H.fill();
    }
  }

  // --- gully grate (slots across the short side, cycle-safe)
  {
    const R = IRON_REGIONS.gully, px = R.w / R.mw;
    H.fillStyle = gray(205); H.fillRect(R.x, R.y, R.w, R.h);
    H.fillStyle = gray(165); H.fillRect(R.x + 0.03 * px, R.y + 0.03 * px, R.w - 0.06 * px, R.h - 0.06 * px);
    const n = 12;
    const span = R.mw - 0.1, step = span / n;
    for (let i = 0; i < n; i++) {
      const x = R.x + (0.05 + step * (i + 0.5)) * px - 0.0105 * px;
      for (const C of [H, M]) {
        C.fillStyle = C === H ? gray(8) : 'rgb(255,0,0)';
        C.fillRect(x, R.y + 0.05 * px, 0.021 * px, R.h - 0.1 * px);
      }
    }
  }

  // --- slotted track drain cover (between the rails)
  {
    const R = IRON_REGIONS.drain, px = R.w / R.mw;
    H.fillStyle = gray(210); H.fillRect(R.x, R.y, R.w, R.h);
    H.fillStyle = gray(160); H.fillRect(R.x + 0.035 * px, R.y + 0.035 * px, R.w - 0.07 * px, R.h - 0.07 * px);
    const n = 22;
    for (let i = 0; i < n; i++) {
      const x = R.x + (0.06 + ((R.mw - 0.12) * (i + 0.5)) / n) * px - 0.008 * px;
      for (const C of [H, M]) {
        C.fillStyle = C === H ? gray(8) : 'rgb(255,0,0)';
        C.fillRect(x, R.y + 0.07 * px, 0.016 * px, (R.mh - 0.14) * px);
      }
    }
  }

  // --- chequer plate covers (square and rectangular double)
  const chequer = (R, split) => {
    const px = R.w / R.mw;
    H.fillStyle = gray(205); H.fillRect(R.x, R.y, R.w, R.h);
    H.fillStyle = gray(30); H.fillRect(R.x + 0.025 * px, R.y + 0.025 * px, R.w - 0.05 * px, R.h - 0.05 * px);
    H.fillStyle = gray(120); H.fillRect(R.x + 0.03 * px, R.y + 0.03 * px, R.w - 0.06 * px, R.h - 0.06 * px);
    if (split) { H.fillStyle = gray(30); H.fillRect(R.x + R.w / 2 - 0.003 * px, R.y + 0.03 * px, 0.006 * px, R.h - 0.06 * px); }
    const pitch = 0.03 * px;
    let row = 0;
    for (let y = R.y + 0.045 * px; y < R.y + R.h - 0.045 * px; y += pitch * 0.5, row++) {
      for (let x = R.x + 0.045 * px + (row % 2) * pitch * 0.5; x < R.x + R.w - 0.045 * px; x += pitch) {
        H.save(); H.translate(x, y); H.rotate(row % 2 ? 0.8 : -0.8);
        H.fillStyle = gray(200); H.beginPath(); H.ellipse(0, 0, 0.011 * px, 0.003 * px, 0, 0, Math.PI * 2); H.fill();
        H.restore();
      }
    }
    // lifting keyholes
    for (const fx of split ? [0.25, 0.75] : [0.5]) {
      const x = R.x + R.w * fx, y = R.y + R.h * 0.18;
      H.fillStyle = gray(10); H.fillRect(x - 0.018 * px, y - 0.006 * px, 0.036 * px, 0.012 * px);
      M.fillStyle = 'rgb(255,0,0)'; M.fillRect(x - 0.018 * px, y - 0.006 * px, 0.036 * px, 0.012 * px);
    }
  };
  chequer(IRON_REGIONS.plate, false);
  chequer(IRON_REGIONS.plate2, true);

  // --- small round valve cover
  {
    const R = IRON_REGIONS.valve, cx = R.x + R.w / 2, cy = R.y + R.h / 2, px = R.w / R.mw;
    const circ = (r, v) => { H.fillStyle = gray(v); H.beginPath(); H.arc(cx, cy, r * px, 0, Math.PI * 2); H.fill(); };
    circ(0.16, 205); circ(0.128, 25); circ(0.122, 135);
    H.fillStyle = gray(210);
    for (let i = -2; i <= 2; i++) H.fillRect(cx - 0.07 * px, cy + i * 0.03 * px - 0.006 * px, 0.14 * px, 0.012 * px);
  }
}

// linear [0,1] -> sRGB byte
const SRGB_LUT = (() => {
  const t = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) t[i] = Math.round(Math.pow(i / 4095, 1 / 2.2) * 255);
  return t;
})();

/** Random 64x64 lattice for inlined value noise (wraps with & 63). */
function lattice(seed) {
  const rng = RNG.from('street-tex', seed);
  const g = new Float32Array(64 * 64);
  for (let i = 0; i < g.length; i++) g[i] = rng.next();
  return g;
}

function ironMaps(hc, mc) {
  const W = ATLAS, Hh = ATLAS;
  const hd = hc.getContext('2d').getImageData(0, 0, W, Hh).data;
  const md = mc.getContext('2d').getImageData(0, 0, W, Hh).data;
  const h = new Float32Array(W * Hh);
  for (let i = 0; i < h.length; i++) h[i] = hd[i * 4] * (1 / 255);
  const alb = new Uint8Array(W * Hh * 4), nor = new Uint8Array(W * Hh * 4), orm = new Uint8Array(W * Hh * 4);
  const L1 = lattice(1), L2 = lattice(2), L3 = lattice(3);
  // value noise at scale 1/sc, inlined
  const vn = (L, x, y) => {
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy;
    const x0 = ix & 63, y0 = (iy & 63) << 6, x1 = (ix + 1) & 63, y1 = ((iy + 1) & 63) << 6;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = L[y0 + x0] + (L[y0 + x1] - L[y0 + x0]) * sx;
    const b = L[y1 + x0] + (L[y1 + x1] - L[y1 + x0]) * sx;
    return a + (b - a) * sy;
  };
  const k = 2.2; // normal strength
  const enc = (v) => SRGB_LUT[v <= 0 ? 0 : v >= 1 ? 4095 : (v * 4095) | 0];
  for (let y = 0; y < Hh; y++) {
    const ym = (y > 0 ? y - 1 : 0) * W, yp = (y < Hh - 1 ? y + 1 : y) * W, y0 = y * W;
    for (let x = 0; x < W; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < W - 1 ? x + 1 : x;
      const dx = (h[y0 + xp] - h[y0 + xm]) * 2 + (h[ym + xp] - h[ym + xm]) + (h[yp + xp] - h[yp + xm]);
      const dy = (h[yp + x] - h[ym + x]) * 2 + (h[yp + xm] - h[ym + xm]) + (h[yp + xp] - h[ym + xp]);
      let nx = -dx * k, ny = -dy * k;
      const il = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= il; ny *= il;
      const i = y0 + x, o = i * 4;
      nor[o] = (nx * 0.5 + 0.5) * 255; nor[o + 1] = (ny * 0.5 + 0.5) * 255; nor[o + 2] = (il * 0.5 + 0.5) * 255; nor[o + 3] = 255;

      const hv = h[i], hole = md[o] > 127, soil = md[o + 1] > 127;
      let r, g, b, rough, metal;
      if (soil) {
        const sv = 0.6 + 0.8 * vn(L3, x / 3, y / 3) * vn(L1, x / 9, y / 9);
        const kk = hole ? 0.35 : 1;
        r = 0.05 * sv * kk; g = 0.036 * sv * kk; b = 0.024 * sv * kk;
        rough = 0.95; metal = 0;
      } else if (hole) {
        r = 0.01; g = 0.009; b = 0.008; rough = 1; metal = 0;
      } else {
        const v1 = vn(L1, x / 9, y / 9), v2 = vn(L2, x / 37, y / 37), v3 = vn(L3, x / 3, y / 3);
        // raised = worn (lighter, metallic, smoother); low = dust and rust in the recesses
        const t = (hv - 0.62) * 3.5, wear = (t < 0 ? 0 : t > 1 ? 1 : t) * (0.6 + 0.4 * v2);
        const lt = (0.55 - hv) * 2.2, low = lt < 0 ? 0 : lt > 1 ? 1 : lt;
        const rust = low * (0.3 + 0.7 * v1) * 0.6, dust = low * (0.4 + 0.6 * v2);
        const vv = 0.85 + 0.3 * v3 * (1 - wear);
        r = (0.075 + 0.07 * wear + 0.05 * dust + 0.045 * rust) * vv;
        g = (0.071 + 0.067 * wear + 0.045 * dust + 0.018 * rust) * vv;
        b = (0.067 + 0.062 * wear + 0.036 * dust + 0.004 * rust) * vv;
        rough = 0.8 - 0.35 * wear + 0.12 * dust; metal = 0.2 + 0.6 * wear;
      }
      alb[o] = enc(r); alb[o + 1] = enc(g); alb[o + 2] = enc(b); alb[o + 3] = 255;
      orm[o] = 255; orm[o + 1] = rough * 255; orm[o + 2] = metal * 255; orm[o + 3] = 255;
    }
  }
  return { alb, nor, orm };
}

/** Four leaf cut-outs (RGBA, white blade with darker edge and veins) on a canvas of
 *  the leaves region's size. */
function drawLeaves() {
  const R = IRON_REGIONS.leaves, c = canvas(R.w, R.h), C = c.getContext('2d');
  C.clearRect(0, 0, R.w, R.h);
  const rng = RNG.from('street-leaves');
  const k = R.w / 256;
  for (let i = 0; i < 4; i++) {
    const cx = ((i % 2) * 128 + 64) * k, cy = (Math.floor(i / 2) * 128 + 64) * k;
    C.save(); C.translate(cx, cy); C.scale(k, k); C.rotate(rng.range(-0.3, 0.3));
    const L = 50 + rng.range(-6, 6), W = i === 3 ? 30 : 18 + rng.range(-3, 5);
    C.fillStyle = 'rgb(235,235,235)';
    C.beginPath(); C.moveTo(-L, 0);
    C.bezierCurveTo(-L * 0.4, -W, L * 0.4, -W * 0.9, L, 0);
    C.bezierCurveTo(L * 0.4, W * (i === 1 ? 0.6 : 0.9), -L * 0.4, W, -L, 0);
    C.fill();
    // darker edge curl, midrib and veins
    C.strokeStyle = 'rgb(170,170,170)'; C.lineWidth = 2.5; C.stroke();
    C.strokeStyle = 'rgb(200,200,200)'; C.lineWidth = 2; C.beginPath(); C.moveTo(-L - 8, 0); C.lineTo(L * 0.9, 0); C.stroke();
    C.lineWidth = 1;
    for (let j = -3; j <= 3; j++) { C.beginPath(); C.moveTo(j * 12, 0); C.lineTo(j * 12 + 10, -W * 0.6); C.moveTo(j * 12, 0); C.lineTo(j * 12 + 10, W * 0.6); C.stroke(); }
    C.restore();
  }
  return C.getImageData(0, 0, R.w, R.h).data;
}

/** Writes the leaf cut-outs into the maps: albedo with alpha, flat normal, dull leaf
 *  roughness, no metal. Without leaf data (initial maps) the region is just cleared. */
export function writeLeaves(maps, px = null) {
  const R = IRON_REGIONS.leaves;
  for (let y = 0; y < R.h; y++) {
    for (let x = 0; x < R.w; x++) {
      const o = ((R.y + y) * ATLAS + R.x + x) * 4, q = (y * R.w + x) * 4;
      const a = px ? px[q + 3] : 0, v = px ? px[q] : 235;
      maps.alb[o] = maps.alb[o + 1] = maps.alb[o + 2] = v; maps.alb[o + 3] = a;
      maps.nor[o] = 128; maps.nor[o + 1] = 128; maps.nor[o + 2] = 255; maps.nor[o + 3] = 255;
      maps.orm[o] = 255; maps.orm[o + 1] = 190; maps.orm[o + 2] = 0; maps.orm[o + 3] = 255;
    }
  }
}

/** Full atlas: { alb, nor, orm } RGBA8 arrays of ATLAS x ATLAS (canvas row 0 = v 0). */
export function generateIronAtlas() {
  const hc = canvas(ATLAS, ATLAS), mc = canvas(ATLAS, ATLAS);
  drawIron(hc, mc);
  const maps = ironMaps(hc, mc);
  writeLeaves(maps, drawLeaves());
  return maps;
}
