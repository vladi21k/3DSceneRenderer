import { RNG } from '../../core/rng.js';

// Printed graphics for street furniture, drawn once into canvas atlases: photographic
// advertising posters, layered paper posters for the advertising columns, magazine
// covers, city map boards, chalk menu boards, the tram-stop pictogram sign, timetables,
// ticket machine panels, kiosk signs, LED passenger displays and touch screens, plus the
// shelter glazing decal (safety dots, dust, water spots). Text is generated pseudo-text in
// mixed sizes and scripts; nothing names a real place, brand or person.

export const ATLAS_W = 4096, ATLAS_H = 2048;
// [x, y, w, h] in atlas pixels (canvas y down)
const REG = {
  map0: [0, 1280, 512, 640], map1: [512, 1280, 512, 640],
  mapHead: [0, 1920, 512, 64], kioskBand: [512, 1920, 512, 96],
  chalk0: [1024, 1280, 256, 384], chalk1: [1280, 1280, 256, 384],
  timetable: [1536, 1280, 256, 384], tramSign: [1792, 1280, 256, 256],
  shelterInfo: [1024, 1664, 256, 320], ticketFront: [1280, 1664, 256, 384],
  magazines: [1536, 1664, 512, 256], kioskMenu: [1536, 1920, 512, 128],
  column: [0, 768, 4096, 512],     // advertising column paper: upper tier left half, lower tier right half
  covers: [3072, 1280, 1024, 768],
  binDecal: [1792, 1536, 128, 128], cooler: [1920, 1536, 128, 128],
};
for (let i = 0; i < 8; i++) REG[`poster${i}`] = [i * 512, 0, 512, 768];                         // large (light boxes, kiosk)
for (let i = 0; i < 8; i++) REG[`small${i}`] = [2048 + (i % 4) * 256, 1280 + (i >> 2) * 384, 256, 384]; // small sheets
export const LIT_ROWS = 768; // light-box posters occupy the top rows (copied into the lit atlas)

/** UV rect [u0, v0, u1, v1] of a named region (flipY texture: v = 1 - y). */
export function uvRect(name, inset = 1) {
  const [x, y, w, h] = REG[name];
  return [(x + inset) / ATLAS_W, 1 - (y + h - inset) / ATLAS_H, (x + w - inset) / ATLAS_W, 1 - (y + inset) / ATLAS_H];
}
/** UV of a sub-rectangle (fractions fx0..fx1, fy0..fy1 from the top-left) of a region. */
export function uvSub(name, fx0, fy0, fx1, fy1) {
  const [x, y, w, h] = REG[name];
  return [(x + fx0 * w) / ATLAS_W, 1 - (y + fy1 * h) / ATLAS_H, (x + fx1 * w) / ATLAS_W, 1 - (y + fy0 * h) / ATLAS_H];
}

// ------------------------------------------------------------------ pseudo text
const SYL = ['ka', 'lo', 'ver', 'mi', 'sta', 'ne', 'ri', 'tal', 'zo', 'an', 'el', 'mar', 'qu', 'ten', 'si', 'bo', 'ra', 'lin', 'do', 'ves', 'sha', 'or', 'ni', 'pel', 'gu', 'ma', 'tor', 'il'];
const HEB = 'אבגדהוזחטיכלמנסעפצקרשת';
function pseudoWord(rng, cap = false) {
  let w = '';
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) w += rng.pick(SYL);
  return cap ? w[0].toUpperCase() + w.slice(1) : w;
}
function hebWord(rng) {
  let w = '';
  for (let i = rng.int(2, 6); i > 0; i--) w += HEB[rng.int(0, HEB.length - 1)];
  return w;
}
const phrase = (rng, n, heb = false) => Array.from({ length: n }, (_, i) => (heb ? hebWord(rng) : pseudoWord(rng, i === 0))).join(' ');

const SANS = 'Helvetica, Arial, sans-serif', SERIF = 'Georgia, "Times New Roman", serif';
function text(ctx, str, x, y, size, { weight = 'bold', align = 'left', font = SANS, maxW = 1e4, color = null, rtl = false } = {}) {
  if (color) ctx.fillStyle = color;
  let s = size;
  do { ctx.font = `${weight} ${s}px ${font}`; s -= 1; } while (ctx.measureText(str).width > maxW && s > 5);
  ctx.textAlign = align;
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.fillText(str, x, y);
  ctx.direction = 'ltr';
}
/** Paragraph of small pseudo-text lines. */
function smallPrint(ctx, x, y, w, lines, size, color, rng, { heb = false, lh = 1.35 } = {}) {
  ctx.fillStyle = color;
  ctx.font = `${size > 9 ? '500' : 'normal'} ${size}px ${SANS}`;
  ctx.textAlign = heb ? 'right' : 'left';
  for (let i = 0; i < lines; i++) {
    let line = '';
    const target = (i === lines - 1 ? rng.range(0.3, 0.8) : rng.range(0.85, 1)) * w;
    while (ctx.measureText(line).width < target) line += (heb ? hebWord(rng) : pseudoWord(rng)) + ' ';
    ctx.fillText(line.trim(), heb ? x + w : x, y + i * size * lh, w);
  }
}

// ------------------------------------------------------------------ photographic imagery
/** Canvas that works on the main thread and in a worker. */
export function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function off(w, h) { const c = mkCanvas(w, h); return [c, c.getContext('2d')]; }
const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

/** Film grain (a shared noise tile in overlay mode) and a vignette over a canvas region. */
let GRAIN = null;
function grainTile() {
  if (GRAIN) return GRAIN;
  const [c, p] = off(256, 256), rng = RNG.from('grain');
  const img = p.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (rng.next() + rng.next() - 1) * 90;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  p.putImageData(img, 0, 0);
  return (GRAIN = c);
}
function grainVignette(ctx, x, y, w, h, rng, amount = 7, vig = 0.22) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = Math.min(1, amount / 14);
  ctx.translate(x - rng.next() * 256, y - rng.next() * 256);
  ctx.fillStyle = ctx.createPattern(grainTile(), 'repeat');
  ctx.fillRect(0, 0, w + 256, h + 256);
  ctx.restore();
  if (vig > 0) {
    ctx.save();
    const cx = x + w / 2, cy = y + h / 2, r = Math.hypot(w, h) / 2;
    const g = ctx.createRadialGradient(cx, cy, r * 0.35, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${vig})`);
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
}

/** Soft bokeh / light blobs (radial gradients: no canvas filters, which are slow). */
function softDot(ctx, x, y, r, col, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, col.replace('A', a)); g.addColorStop(0.55, col.replace('A', a * 0.7)); g.addColorStop(1, col.replace('A', 0));
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}
function bokeh(ctx, w, h, rng, n, hue) {
  for (let i = 0; i < n; i++) {
    softDot(ctx, rng.next() * w, rng.next() * h, rng.range(0.03, 0.12) * w, hsl(hue + rng.range(-30, 30), rng.range(30, 80), rng.range(55, 85), 'A'), rng.range(0.15, 0.45));
  }
}

function product(ctx, cx, base, s, rng, hue) {
  const kind = rng.int(0, 3);
  ctx.save();
  const body = ctx.createLinearGradient(cx - s * 0.2, 0, cx + s * 0.2, 0);
  body.addColorStop(0, hsl(hue, 50, 18)); body.addColorStop(0.35, hsl(hue, 60, 45)); body.addColorStop(0.5, hsl(hue, 40, 80)); body.addColorStop(0.65, hsl(hue, 60, 40)); body.addColorStop(1, hsl(hue, 50, 12));
  ctx.fillStyle = body;
  ctx.beginPath();
  if (kind === 0) { // bottle
    ctx.moveTo(cx - s * 0.16, base); ctx.lineTo(cx - s * 0.16, base - s * 0.62); ctx.quadraticCurveTo(cx - s * 0.16, base - s * 0.8, cx - s * 0.05, base - s * 0.86);
    ctx.lineTo(cx - s * 0.05, base - s * 1.08); ctx.lineTo(cx + s * 0.05, base - s * 1.08); ctx.lineTo(cx + s * 0.05, base - s * 0.86);
    ctx.quadraticCurveTo(cx + s * 0.16, base - s * 0.8, cx + s * 0.16, base - s * 0.62); ctx.lineTo(cx + s * 0.16, base);
  } else if (kind === 1) { // phone
    ctx.roundRect(cx - s * 0.24, base - s * 0.98, s * 0.48, s * 0.98, s * 0.06);
  } else if (kind === 2) { // perfume
    ctx.roundRect(cx - s * 0.22, base - s * 0.5, s * 0.44, s * 0.5, s * 0.04);
    ctx.rect(cx - s * 0.07, base - s * 0.64, s * 0.14, s * 0.14);
  } else { // can
    ctx.roundRect(cx - s * 0.15, base - s * 0.6, s * 0.3, s * 0.6, s * 0.03);
  }
  ctx.fill();
  if (kind === 1) { ctx.fillStyle = 'rgba(10,14,22,0.92)'; ctx.beginPath(); ctx.roundRect(cx - s * 0.21, base - s * 0.94, s * 0.42, s * 0.9, s * 0.04); ctx.fill(); ctx.fillStyle = hsl(hue + 40, 60, 55, 0.7); ctx.fillRect(cx - s * 0.19, base - s * 0.6, s * 0.38, s * 0.3); }
  else { ctx.fillStyle = 'rgba(245,240,230,0.85)'; ctx.fillRect(cx - s * 0.14, base - s * 0.42, s * 0.28, s * 0.14); }
  // reflection on the floor
  ctx.globalAlpha = 0.18; ctx.scale(1, -0.35); ctx.fillStyle = body; ctx.fillRect(cx - s * 0.16, -base * (1 / 0.35) - s * 0.5, s * 0.32, s * 0.5);
  ctx.restore();
}

function landscape(ctx, w, h, rng) {
  const hue = rng.pick([200, 210, 25, 35, 190]);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, hsl(hue, 55, 38)); g.addColorStop(0.45, hsl(hue + 15, 50, 72)); g.addColorStop(0.62, hsl(35, 70, 78)); g.addColorStop(1, hsl(hue, 30, 22));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  softDot(ctx, w * rng.range(0.3, 0.7), h * 0.5, w * 0.16, 'rgba(255,240,200,A)', 0.9);
  // mountain / hill layers with atmospheric perspective
  for (let L = 0; L < 3; L++) {
    ctx.fillStyle = hsl(hue + 10, 25, 50 - L * 13);
    ctx.beginPath(); ctx.moveTo(0, h);
    let y = h * (0.52 + L * 0.06);
    for (let x = 0; x <= w; x += w / 16) { y += rng.range(-1, 1) * h * 0.03; ctx.lineTo(x, Math.min(h * 0.8, Math.max(h * 0.4, y))); }
    ctx.lineTo(w, h); ctx.fill();
  }
}

/** City at dusk: skyline with lit windows under a graded sky, out-of-focus lights in front. */
function cityDusk(ctx, w, h, rng) {
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.75);
  sky.addColorStop(0, hsl(rng.range(215, 235), 45, 18)); sky.addColorStop(0.65, hsl(rng.range(260, 290), 30, 38)); sky.addColorStop(1, hsl(rng.range(20, 35), 75, 62));
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  for (let L = 0; L < 2; L++) {
    let x = -10;
    while (x < w) {
      const bw = rng.range(0.06, 0.16) * w, bh = rng.range(0.15, 0.5) * h * (L ? 0.8 : 1), top = h * 0.78 - bh;
      ctx.fillStyle = hsl(225, 20, L ? 14 : 9);
      ctx.fillRect(x, top, bw, h - top);
      for (let wy = top + 6; wy < h * 0.76; wy += rng.range(7, 10)) for (let wx = x + 4; wx < x + bw - 5; wx += rng.range(6, 9)) {
        if (rng.chance(0.35)) { ctx.fillStyle = hsl(rng.range(35, 50), 80, rng.range(55, 75), rng.range(0.5, 0.9)); ctx.fillRect(wx, wy, 3, 4); }
      }
      x += bw + rng.range(0, 8);
    }
  }
  ctx.fillStyle = hsl(225, 25, 7); ctx.fillRect(0, h * 0.78, w, h * 0.22);
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 18; i++) softDot(ctx, rng.next() * w, h * rng.range(0.7, 1), w * rng.range(0.03, 0.09), hsl(rng.pick([30, 40, 0, 200]), 80, 60, 'A'), rng.range(0.2, 0.5));
  ctx.restore();
}

/** Coffee cup on a table, seen from above at an angle: saucer, cup, crema with a pour
 *  pattern, steam, soft shadow, wood grain behind. */
function coffeeShot(ctx, w, h, rng) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, hsl(28, 35, 22)); g.addColorStop(1, hsl(24, 40, 12));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,220,170,0.05)'; ctx.lineWidth = 3;
  for (let y = 0; y < h; y += rng.range(6, 14)) { ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(w * 0.3, y + rng.range(-8, 8), w * 0.6, y + rng.range(-8, 8), w, y + rng.range(-6, 6)); ctx.stroke(); }
  const cx = w * rng.range(0.42, 0.58), cy = h * rng.range(0.52, 0.6), r = w * 0.3;
  softDot(ctx, cx + r * 0.25, cy + r * 0.35, r * 1.2, 'rgba(0,0,0,A)', 0.5);
  const el = (x, y, rx, ry, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); };
  const sg = ctx.createLinearGradient(cx - r, 0, cx + r, 0); sg.addColorStop(0, '#d9d4cb'); sg.addColorStop(0.4, '#f6f3ee'); sg.addColorStop(1, '#a9a49b');
  el(cx, cy + r * 0.08, r * 1.15, r * 0.62, sg);
  el(cx, cy + r * 0.12, r * 0.95, r * 0.5, 'rgba(0,0,0,0.08)');
  const cg = ctx.createLinearGradient(cx - r * 0.7, 0, cx + r * 0.7, 0); cg.addColorStop(0, '#cfcac0'); cg.addColorStop(0.35, '#fbf9f5'); cg.addColorStop(1, '#8e8a83');
  el(cx, cy, r * 0.72, r * 0.42, cg);
  const crema = ctx.createRadialGradient(cx - r * 0.1, cy - r * 0.05, 0, cx, cy, r * 0.62);
  crema.addColorStop(0, '#d9a56b'); crema.addColorStop(0.6, '#a0632f'); crema.addColorStop(1, '#4a2a14');
  el(cx, cy, r * 0.6, r * 0.34, crema);
  ctx.fillStyle = 'rgba(250,240,225,0.85)';
  ctx.beginPath(); ctx.moveTo(cx, cy + r * 0.2); ctx.bezierCurveTo(cx - r * 0.35, cy - r * 0.05, cx - r * 0.12, cy - r * 0.25, cx, cy - r * 0.08);
  ctx.bezierCurveTo(cx + r * 0.12, cy - r * 0.25, cx + r * 0.35, cy - r * 0.05, cx, cy + r * 0.2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 10; ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const x0 = cx + rng.range(-0.3, 0.3) * r;
    ctx.beginPath(); ctx.moveTo(x0, cy - r * 0.4); ctx.bezierCurveTo(x0 - r * 0.3, cy - r * 0.8, x0 + r * 0.3, cy - r * 1.0, x0, cy - r * 1.4); ctx.stroke();
  }
}

/** Draped silk backdrop (soft diagonal folds) for product shots. */
function silk(ctx, w, h, rng, hue) {
  ctx.fillStyle = hsl(hue, 35, 30); ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 9; i++) {
    const x0 = rng.range(-0.3, 1.1) * w, k = rng.range(0.15, 0.4);
    const g = ctx.createLinearGradient(x0, 0, x0 + w * k, h * k * 0.6);
    const lit = rng.chance(0.6);
    g.addColorStop(0, hsl(hue, 35, 30, 0)); g.addColorStop(0.5, hsl(hue + rng.range(-10, 10), 40, lit ? rng.range(50, 75) : rng.range(8, 16), lit ? 0.8 : 0.6)); g.addColorStop(1, hsl(hue, 35, 25, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
}

/** One photographic advertising poster. */
function photoPoster(ctx, x, y, w, h, seed) {
  const rng = RNG.from('poster', seed);
  const [c, p] = off(w, h);
  const [ic, q] = off(Math.ceil(w / 2), Math.ceil(h / 2)); // imagery layer at half resolution
  q.scale(0.5, 0.5);
  const theme = seed % 6;
  const hue = rng.range(0, 360);
  const bg = q.createLinearGradient(0, 0, w * 0.3, h);
  bg.addColorStop(0, hsl(hue, rng.range(20, 60), rng.range(55, 80))); bg.addColorStop(1, hsl(hue + rng.range(-40, 40), rng.range(25, 60), rng.range(15, 40)));
  q.fillStyle = bg; q.fillRect(0, 0, w, h);
  if (theme === 0) coffeeShot(q, w, h, rng);
  else if (theme === 3) cityDusk(q, w, h, rng);
  else if (theme === 1) { // product on draped silk
    silk(q, w, h, rng, hue);
    product(q, w * 0.5, h * 0.74, h * 0.58, rng, hue + 160);
  } else if (theme === 2) { // product on a gradient with a light streak
    bokeh(q, w, h, rng, 6, hue);
    product(q, w * 0.5, h * 0.7, h * 0.5, rng, hue + 180);
  } else if (theme === 4) { // landscape / travel
    landscape(q, w, h, rng);
  } else { // stage / concert: light beams over a crowd
    q.fillStyle = hsl(hue, 50, 8); q.fillRect(0, 0, w, h);
    q.save(); q.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const x0 = w * rng.next(), hh = hue + rng.range(-60, 60);
      const g = q.createLinearGradient(x0 - w * 0.3, 0, x0 + w * 0.3, 0);
      g.addColorStop(0, hsl(hh, 80, 50, 0)); g.addColorStop(0.5, hsl(hh, 80, 55, 0.3)); g.addColorStop(1, hsl(hh, 80, 50, 0));
      q.fillStyle = g;
      q.beginPath(); q.moveTo(x0 - w * 0.02, 0); q.lineTo(x0 - w * 0.3, h * 0.8); q.lineTo(x0 + w * 0.3, h * 0.8); q.lineTo(x0 + w * 0.02, 0); q.fill();
    }
    q.restore();
    q.fillStyle = '#06060a';
    for (let i = 0; i < 26; i++) { const cx = rng.next() * w, r = rng.range(0.025, 0.045) * w; q.beginPath(); q.arc(cx, h * 0.84 - rng.next() * h * 0.03, r, 0, Math.PI * 2); q.fill(); q.fillRect(cx - r * 1.4, h * 0.84, r * 2.8, h * 0.16); }
  }
  // photographic finish of the image: soft key light, warm light leak, upscaled (soft focus)
  {
    const kl = q.createRadialGradient(w * 0.25, h * 0.2, 0, w * 0.25, h * 0.2, h * 0.9);
    kl.addColorStop(0, 'rgba(255,245,225,0.14)'); kl.addColorStop(1, 'rgba(0,0,0,0.12)');
    q.fillStyle = kl; q.fillRect(0, 0, w, h);
    if (rng.chance(0.4)) { q.globalCompositeOperation = 'screen'; softDot(q, w * rng.range(0.6, 1), h * rng.range(0, 0.3), w * 0.5, 'rgba(255,170,90,A)', 0.25); q.globalCompositeOperation = 'source-over'; }
  }
  p.imageSmoothingEnabled = true; p.imageSmoothingQuality = 'high';
  p.drawImage(ic, 0, 0, w, h);
  // typography: a headline of 1-3 pseudo-words, sub lines, fine print, logo, date strip
  const heb = rng.chance(0.45);
  const fg = 'rgba(250,248,240,0.95)';
  const top = rng.chance(0.5);
  const hy = top ? h * 0.1 : h * 0.66;
  text(p, phrase(rng, rng.int(1, 2), heb), heb ? w * 0.92 : w * 0.08, hy, h * rng.range(0.05, 0.075), { maxW: w * 0.84, align: heb ? 'right' : 'left', rtl: heb, color: fg, font: rng.chance(0.4) ? SERIF : SANS });
  smallPrint(p, w * 0.08, hy + h * 0.05, w * 0.7, rng.int(1, 3), Math.max(8, h * 0.022), fg, rng, { heb });
  // brand band
  const band = rng.chance(0.6);
  if (band) { p.fillStyle = hsl(hue + 180, 40, 18, 0.85); p.fillRect(0, h * 0.9, w, h * 0.1); }
  p.fillStyle = band ? 'rgba(240,238,230,0.9)' : fg;
  p.beginPath(); p.arc(w * 0.12, h * 0.95, h * 0.022, 0, Math.PI * 2); p.fill();
  text(p, pseudoWord(rng, true), w * 0.17, h * 0.962, h * 0.03, { color: band ? 'rgba(240,238,230,0.95)' : fg, maxW: w * 0.4 });
  smallPrint(p, w * 0.56, h * 0.94, w * 0.36, 2, Math.max(6, h * 0.012), band ? 'rgba(230,230,225,0.8)' : fg, rng);
  grainVignette(p, 0, 0, w, h, rng, 4);
  ctx.drawImage(c, x, y);
}

/** Typographic event poster (column sheets): colour field, dates, line-up, photo block. */
function eventPoster(ctx, x, y, w, h, seed) {
  const rng = RNG.from('event', seed);
  const [c, p] = off(w, h);
  const hue = rng.range(0, 360);
  p.fillStyle = hsl(hue, rng.range(40, 75), rng.range(30, 60)); p.fillRect(0, 0, w, h);
  // photo block
  const pb = [w * 0.06, h * rng.range(0.08, 0.3), w * 0.88, h * 0.38];
  const [pc, pp] = off(Math.round(pb[2]), Math.round(pb[3]));
  if (rng.chance(0.5)) landscape(pp, pc.width, pc.height, rng);
  else cityDusk(pp, pc.width, pc.height, rng);
  p.drawImage(pc, pb[0], pb[1]);
  const fg = rng.chance(0.5) ? '#f6f2e8' : '#141414';
  const heb = rng.chance(0.5);
  text(p, `${rng.int(1, 28)}.${rng.int(1, 12)}`, w * 0.08, pb[1] - h * 0.02 > h * 0.08 ? pb[1] - h * 0.02 : h * 0.75, h * 0.07, { color: fg });
  text(p, phrase(rng, 2, heb), heb ? w * 0.92 : w * 0.08, pb[1] + pb[3] + h * 0.08, h * 0.055, { maxW: w * 0.84, color: fg, align: heb ? 'right' : 'left', rtl: heb });
  smallPrint(p, w * 0.08, pb[1] + pb[3] + h * 0.13, w * 0.84, rng.int(4, 7), Math.max(7, h * 0.024), fg, rng, { heb });
  grainVignette(p, 0, 0, w, h, rng, 5, 0.1);
  ctx.drawImage(c, x, y);
}

// ------------------------------------------------------------------ column bands (layered paper)
function tornRect(ctx, x, y, w, h, rng, amp) {
  ctx.beginPath();
  const step = 6;
  ctx.moveTo(x, y);
  for (let t = 0; t <= w; t += step) ctx.lineTo(x + t, y + rng.range(0, amp));
  for (let t = 0; t <= h; t += step) ctx.lineTo(x + w - rng.range(0, amp), y + t);
  for (let t = w; t >= 0; t -= step) ctx.lineTo(x + t, y + h - rng.range(0, amp));
  for (let t = h; t >= 0; t -= step) ctx.lineTo(x + rng.range(0, amp), y + t);
  ctx.closePath();
}

/** Advertising column poster tiers [y0, y1] (metres above the paving); each tier is the
 *  full circumference of the column (r 0.562 m) and has its own half of the 'column' region. */
export const COLUMN_TIERS = [[1.45, 2.54], [0.36, 1.45]];
const COL_CIRC = 2 * Math.PI * 0.562;

/** Current poster sheets of a column tier: [u0, v0, u1, v1] as fractions of the tier
 *  (u round the column, v from the top). Six slots, now and then one double-wide sheet.
 *  Deterministic and cheap (the geometry needs them without drawing). */
export function columnSheetRects(tier) {
  const rng = RNG.from('columnSheets', tier);
  const out = [];
  for (let slot = 0; slot < 6;) {
    const n = slot < 5 && rng.chance(0.22) ? 2 : 1;
    const sw = n / 6, w = sw * rng.range(0.86, 0.94);
    const x0 = slot / 6 + (sw - w) / 2 + rng.range(-0.004, 0.004);
    const h = n > 1 ? rng.range(0.64, 0.74) : rng.range(0.76, 0.9);
    const y0 = rng.range(0.03, 0.97 - h);
    out.push([x0, y0, x0 + w, y0 + h]);
    slot += n;
  }
  return out;
}

/** Glued paper round an advertising column, two tiers: older torn layers and remnants,
 *  then the current sheets (raised 2 mm by the geometry), sun-faded, glue-stained and
 *  peeling. Posters keep their true proportions (the region is not square in metres).
 *  Background layers wrap round (the tier is a closed ring). */
function columnBand(ctx, [x, y, w, h]) {
  const tw = w / 2;
  COLUMN_TIERS.forEach(([ty0, ty1], tier) => {
    const rng = RNG.from('column', tier);
    const [c, p] = off(tw, h);
    const pxm = tw / COL_CIRC, pym = h / (ty1 - ty0);       // pixels per metre
    const wrap = (bx, bw, fn) => { fn(0); if (bx + bw > tw) fn(-tw); if (bx < 0) fn(tw); };
    p.fillStyle = '#d9d2c0'; p.fillRect(0, 0, tw, h);
    for (let i = 0; i < 46; i++) {
      const bx = rng.next() * tw, by = rng.next() * h - 40, bw = rng.range(60, 300), bh = rng.range(60, 300);
      p.fillStyle = hsl(rng.range(20, 60), rng.range(5, 35), rng.range(55, 85), 0.6);
      wrap(bx, bw, (dx) => { tornRect(p, bx + dx, by, bw, bh, RNG.from('torn', tier, i), 10); p.fill(); });
    }
    for (let i = 0; i < 10; i++) { // remnants of older posters
      const sx = rng.next() * tw, sy = rng.range(-0.2, 0.6) * h, sw = rng.range(120, 300), sh = rng.range(150, 320);
      wrap(sx, sw, (dx) => {
        p.save(); tornRect(p, sx + dx, sy, sw, sh, RNG.from('rem', tier, i), 14); p.clip();
        eventPoster(p, sx + dx, sy, 300, 420, tier * 31 + i);
        p.fillStyle = 'rgba(235,230,215,0.45)'; p.fillRect(sx + dx, sy, 300, 420);
        p.restore();
      });
    }
    // current sheets: drawn at their true aspect, then fitted into the region
    columnSheetRects(tier).forEach(([f0, g0, f1, g1], i) => {
      const sx = f0 * tw, sy = g0 * h, sw = (f1 - f0) * tw, sh = (g1 - g0) * h;
      const vw = 256, vh = Math.round(vw * (sh / pym) / (sw / pxm));
      p.save();
      p.translate(sx, sy);
      p.beginPath(); p.rect(0, 0, sw, sh); p.clip();
      p.scale(sw / vw, sh / vh);
      if (rng.chance(0.55)) photoPoster(p, 0, 0, vw, vh, tier * 17 + i + 40); else eventPoster(p, 0, 0, vw, vh, tier * 13 + i);
      p.restore();
      p.fillStyle = `rgba(240,236,225,${rng.range(0.04, 0.28)})`; p.fillRect(sx, sy, sw, sh);          // sun fade
      for (let k = 0; k < 3; k++) { p.fillStyle = 'rgba(90,80,60,0.08)'; p.fillRect(sx + rng.next() * sw, sy, rng.range(2, 6), sh * rng.range(0.2, 0.9)); } // glue runs
      if (rng.chance(0.4)) { // peeling corner showing the paper behind
        const cx = rng.chance(0.5) ? sx + sw : sx, cy = rng.chance(0.5) ? sy + sh : sy, q = rng.range(14, 40);
        const dx = cx > sx ? -1 : 1, dy = cy > sy ? -1 : 1;
        p.fillStyle = '#cfc6b0'; p.beginPath(); p.moveTo(cx, cy); p.lineTo(cx + dx * q, cy); p.lineTo(cx, cy + dy * q); p.fill();
        p.fillStyle = 'rgba(250,248,240,0.95)'; p.beginPath(); p.moveTo(cx + dx * q, cy); p.lineTo(cx, cy + dy * q); p.lineTo(cx + dx * q * 0.75, cy + dy * q * 0.75); p.fill();
      }
    });
    if (tier === 1) { // splash grime towards the plinth
      const g = p.createLinearGradient(0, h * 0.6, 0, h);
      g.addColorStop(0, 'rgba(60,50,40,0)'); g.addColorStop(1, 'rgba(60,50,40,0.32)');
      p.fillStyle = g; p.fillRect(0, 0, tw, h);
    }
    ctx.drawImage(c, x + tier * tw, y);
  });
}

/** Small round recycling / city decal for litter bins. */
function binDecal(ctx, [x, y, w, h]) {
  ctx.save();
  ctx.fillStyle = '#e9e6dc'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#2f6b45'; ctx.beginPath(); ctx.arc(x + w / 2, y + h * 0.42, w * 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#e9e6dc'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  for (let k = 0; k < 3; k++) { // three chasing arrows
    const a0 = k * 2.094 - 0.5, a1 = a0 + 1.5, r = w * 0.18, cx = x + w / 2, cy = y + h * 0.42;
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r); ctx.lineTo(cx + Math.cos(a1 - 0.35) * r * 1.35, cy + Math.sin(a1 - 0.35) * r * 1.35); ctx.stroke();
  }
  smallPrint(ctx, x + 10, y + h * 0.86, w - 20, 1, 9, '#3b3b38', RNG.from('bindecal'), { heb: true });
  ctx.restore();
}

/** Glass door of a drinks cooler: lit shelves of bottles and cans. */
function coolerFront(ctx, [x, y, w, h]) {
  const rng = RNG.from('cooler');
  ctx.save();
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#e8f2f6'); g.addColorStop(1, '#9fb4bf');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  for (let r = 0; r < 4; r++) {
    const by = y + 8 + r * 30;
    ctx.fillStyle = 'rgba(70,80,86,0.6)'; ctx.fillRect(x + 4, by + 26, w - 8, 3);
    for (let bx = x + 8; bx < x + w - 12; bx += rng.range(9, 13)) {
      const hh = rng.range(16, 25), hue = rng.pick([0, 30, 120, 210, 45, 340]);
      ctx.fillStyle = hsl(hue, rng.range(40, 80), rng.range(30, 60));
      ctx.fillRect(bx, by + 26 - hh, 7, hh);
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(bx + 1, by + 26 - hh, 1.5, hh);
    }
  }
  ctx.strokeStyle = '#2a2d2f'; ctx.lineWidth = 6; ctx.strokeRect(x + 3, y + 3, w - 6, h - 6);
  ctx.restore();
}

// ------------------------------------------------------------------ magazines
function magazineCovers(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('covers', seed);
  const cw = w / 5, ch = h / 3;
  for (let j = 0; j < 3; j++) for (let i = 0; i < 5; i++) {
    const [c, p] = off(Math.round(cw), Math.round(ch));
    const W = c.width, H = c.height, hue = rng.range(0, 360);
    const g = p.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, hsl(hue, 30, rng.range(60, 85))); g.addColorStop(1, hsl(hue + 30, 35, rng.range(25, 55)));
    p.fillStyle = g; p.fillRect(0, 0, W, H);
    const kind = rng.int(0, 4);
    if (kind === 0) coffeeShot(p, W, H, rng);
    else if (kind === 1) cityDusk(p, W, H, rng);
    else if (kind === 2) landscape(p, W, H, rng);
    else if (kind === 3) { silk(p, W, H, rng, hue); product(p, W * 0.5, H * 0.85, H * 0.6, rng, hue + 160); }
    else product(p, W * 0.5, H * 0.85, H * 0.6, rng, hue + 160);
    text(p, pseudoWord(rng, true).toUpperCase(), W * 0.5, H * 0.15, H * 0.13, { align: 'center', maxW: W * 0.92, color: rng.chance(0.5) ? '#c0141e' : '#f8f6f0', font: rng.chance(0.5) ? SERIF : SANS });
    smallPrint(p, W * 0.06, H * 0.55, W * 0.4, 4, Math.max(5, H * 0.035), '#fbfbf6', rng);
    grainVignette(p, 0, 0, W, H, rng, 4, 0.08);
    ctx.drawImage(c, x + i * cw, y + j * ch);
  }
}

function magazines(ctx, [x, y, w, h], seed) {
  // flat fallback strip (kiosk interior far wall): rows of covers in shadow
  const rng = RNG.from('mag', seed);
  ctx.fillStyle = '#26292a'; ctx.fillRect(x, y, w, h);
  const [cx, cy, cw, ch] = REG.covers;
  for (let r = 0; r < 3; r++) {
    let px = x + 4;
    while (px < x + w - 30) {
      const mw = rng.range(40, 52), mh = h / 3 - 10;
      const k = rng.int(0, 14);
      ctx.drawImage(ctx.canvas, cx + (k % 5) * (cw / 5), cy + Math.floor(k / 5) * (ch / 3), cw / 5, ch / 3, px, y + 5 + r * (h / 3) + rng.range(0, 4), mw, mh);
      px += mw + rng.range(1, 4);
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x, y, w, h);
}

// ------------------------------------------------------------------ maps, boards, signs
function mapBoard(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('map', seed);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#f1ece0'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#23415f'; ctx.fillRect(x, y, w, 58);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(x + 32, y + 29, 18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#23415f'; ctx.font = `bold 28px ${SERIF}`; ctx.textAlign = 'center'; ctx.fillText('i', x + 32, y + 39);
  text(ctx, hebWord(rng) + ' ' + hebWord(rng), x + w - 16, y + 38, 26, { align: 'right', rtl: true, color: '#ffffff', maxW: 220 });
  text(ctx, phrase(rng, 2), x + 64, y + 38, 20, { color: '#dfe7ef', maxW: 200, weight: '600' });
  const mx = x + 16, my = y + 74, mw = w - 32, mh = h - 190;
  ctx.fillStyle = '#d9d2c1'; ctx.fillRect(mx, my, mw, mh);
  const cols = [], rows = [];
  for (let cx = 0; cx < mw;) { cols.push(cx); cx += rng.range(38, 70); }
  for (let cy = 0; cy < mh;) { rows.push(cy); cy += rng.range(34, 62); }
  for (let i = 0; i < cols.length; i++) for (let j = 0; j < rows.length; j++) {
    const bx = mx + cols[i] + 5, by = my + rows[j] + 5;
    const bw = (cols[i + 1] ?? mw) - cols[i] - 10, bh = (rows[j + 1] ?? mh) - rows[j] - 10;
    if (bw < 4 || bh < 4) continue;
    ctx.fillStyle = rng.chance(0.1) ? '#b7cf9a' : rng.chance(0.08) ? '#e6c9a8' : '#ebe4d4';
    ctx.fillRect(bx, by, Math.min(bw, mx + mw - bx), Math.min(bh, my + mh - by));
    if (rng.chance(0.3)) { ctx.fillStyle = '#8a8478'; ctx.font = `7px ${SANS}`; ctx.textAlign = 'left'; ctx.fillText(pseudoWord(rng), bx + 2, by + 9, bw - 4); }
  }
  ctx.strokeStyle = '#9cc3dc'; ctx.lineWidth = 14;
  ctx.beginPath(); ctx.moveTo(mx, my + mh * 0.85); ctx.bezierCurveTo(mx + mw * 0.3, my + mh * 0.7, mx + mw * 0.6, my + mh, mx + mw, my + mh * 0.8); ctx.stroke();
  ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(mx + mw * 0.08, my + mh * 0.1);
  ctx.lineTo(mx + mw * 0.45, my + mh * 0.38); ctx.lineTo(mx + mw * 0.55, my + mh * 0.62); ctx.lineTo(mx + mw * 0.95, my + mh * 0.7); ctx.stroke();
  for (const t of [[0.08, 0.1], [0.27, 0.24], [0.45, 0.38], [0.5, 0.5], [0.55, 0.62], [0.75, 0.66], [0.95, 0.7]]) {
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(mx + mw * t[0], my + mh * t[1], 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    text(ctx, pseudoWord(rng, true), mx + mw * t[0] + 10, my + mh * t[1] - 8, 10, { color: '#333', weight: '600' });
  }
  ctx.fillStyle = '#e74c3c'; ctx.beginPath(); ctx.arc(mx + mw * 0.5, my + mh * 0.5, 11, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x + 16, y + h - 104, w - 32, 88);
  for (let i = 0; i < 6; i++) {
    const lx = x + 28 + (i % 3) * ((w - 56) / 3), ly = y + h - 92 + Math.floor(i / 3) * 40;
    ctx.fillStyle = ['#c0392b', '#9cc3dc', '#b7cf9a', '#e6c9a8', '#23415f', '#e74c3c'][i];
    ctx.fillRect(lx, ly, 22, 22);
    smallPrint(ctx, lx + 30, ly + 10, (w - 56) / 3 - 44, 2, 8, '#555555', rng);
  }
  ctx.restore();
}

function scribble(ctx, x, y, w, rng, size) {
  ctx.beginPath();
  let cx = x;
  ctx.moveTo(cx, y);
  while (cx < x + w) {
    const n = rng.int(2, 6);
    for (let i = 0; i < n; i++) {
      const hh = size * (rng.chance(0.18) ? 1.6 : rng.range(0.6, 1));
      ctx.bezierCurveTo(cx + size * 0.2, y - hh, cx + size * 0.6, y - hh, cx + size * 0.5, y);
      ctx.bezierCurveTo(cx + size * 0.45, y + size * 0.15, cx + size * 0.7, y + size * 0.1, cx + size * 0.8, y);
      cx += size * 0.8;
    }
    cx += size * 0.9;
    ctx.moveTo(cx, y);
  }
  ctx.stroke();
}

function chalkBoard(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('chalk', seed);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#272b29'; ctx.fillRect(x, y, w, h);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(200,205,200,${rng.range(0.01, 0.04)})`;
    ctx.beginPath(); ctx.ellipse(x + rng.next() * w, y + rng.next() * h, rng.range(20, 70), rng.range(6, 20), rng.range(0, 3), 0, Math.PI * 2); ctx.fill();
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(245,242,230,0.9)'; ctx.lineWidth = 3;
  scribble(ctx, x + 30, y + 52, w - 60, rng, 22);
  ctx.strokeStyle = 'rgba(240,200,120,0.85)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + 40, y + 70); ctx.quadraticCurveTo(x + w / 2, y + 78, x + w - 40, y + 68); ctx.stroke();
  ctx.font = `bold 18px ${SANS}`; ctx.textAlign = 'right';
  for (let i = 0; i < 8; i++) {
    const ly = y + 110 + i * 30;
    ctx.strokeStyle = i % 3 === 0 ? 'rgba(170,220,235,0.85)' : 'rgba(245,242,230,0.85)'; ctx.lineWidth = 2;
    scribble(ctx, x + 18, ly, w * rng.range(0.35, 0.6), rng, 11);
    ctx.fillStyle = 'rgba(245,242,230,0.85)';
    ctx.fillText(`${rng.int(8, 46)}`, x + w - 18, ly + 4);
  }
  ctx.strokeStyle = 'rgba(245,242,230,0.8)'; ctx.lineWidth = 2.5;
  const cx = x + w * 0.5, cy = y + h - 40;
  ctx.beginPath(); ctx.moveTo(cx - 22, cy - 22); ctx.lineTo(cx - 18, cy); ctx.lineTo(cx + 18, cy); ctx.lineTo(cx + 22, cy - 22); ctx.closePath(); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx + 26, cy - 13, 7, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  for (const dx of [-8, 4]) { ctx.beginPath(); ctx.moveTo(cx + dx, cy - 28); ctx.bezierCurveTo(cx + dx - 6, cy - 36, cx + dx + 6, cy - 42, cx + dx, cy - 50); ctx.stroke(); }
  ctx.restore();
}

/** Generic tram pictogram (side view) in white on a blue panel. */
function tramSign(ctx, [x, y, w, h]) {
  ctx.save();
  ctx.fillStyle = '#1f5ea8'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 8;
  ctx.beginPath(); ctx.roundRect(x + 12, y + 12, w - 24, h - 24, 14); ctx.stroke();
  const cx = x + w / 2, cy = y + h / 2 + 10;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(cx - 82, cy - 34, 164, 62, [16, 26, 6, 6]); ctx.fill();
  ctx.fillStyle = '#1f5ea8';
  for (let i = 0; i < 4; i++) ctx.fillRect(cx - 66 + i * 32, cy - 24, 24, 22);
  ctx.beginPath(); ctx.roundRect(cx + 62, cy - 24, 14, 22, [2, 8, 2, 2]); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(cx - 50, cy + 34, 10, 0, Math.PI * 2); ctx.arc(cx + 50, cy + 34, 10, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 5; ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(cx - 20, cy - 34); ctx.lineTo(cx, cy - 58); ctx.lineTo(cx + 20, cy - 34); ctx.moveTo(cx - 26, cy - 60); ctx.lineTo(cx + 26, cy - 60); ctx.stroke();
  ctx.restore();
}

function timetable(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('tt', seed);
  ctx.save();
  ctx.fillStyle = '#fbfaf6'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1f5ea8'; ctx.fillRect(x, y, w, 46);
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(x + 10, y + 8, 30, 30, 4); ctx.fill();
  ctx.fillStyle = '#1f5ea8'; ctx.font = `bold 24px ${SANS}`; ctx.textAlign = 'center'; ctx.fillText('1', x + 25, y + 32);
  text(ctx, hebWord(rng) + ' ' + hebWord(rng), x + w - 10, y + 30, 18, { align: 'right', rtl: true, color: '#ffffff', maxW: w - 70 });
  ctx.fillStyle = '#e4e2dc';
  for (let r = 0; r < 18; r += 2) ctx.fillRect(x + 6, y + 56 + r * 17, w - 12, 17);
  ctx.fillStyle = '#333333'; ctx.font = `11px ${SANS}`; ctx.textAlign = 'left';
  for (let r = 0; r < 18; r++) {
    ctx.fillText(String(5 + r).padStart(2, '0'), x + 10, y + 69 + r * 17);
    let line = '';
    for (let k = 0; k < 6; k++) line += String((k * 10 + rng.int(0, 9)) % 60).padStart(2, '0') + '  ';
    ctx.fillText(line, x + 40, y + 69 + r * 17);
  }
  ctx.restore();
}

function ticketFront(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('ticket', seed);
  ctx.save();
  ctx.fillStyle = '#3d4246'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1f5ea8'; ctx.fillRect(x, y, w, 50);
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(x + 14, y + 12, 50, 24, [6, 10, 3, 3]); ctx.fill();
  ctx.fillStyle = '#1f5ea8'; for (let i = 0; i < 3; i++) ctx.fillRect(x + 19 + i * 14, y + 17, 9, 8);
  text(ctx, hebWord(rng) + ' ' + hebWord(rng), x + w - 12, y + 32, 18, { align: 'right', rtl: true, color: '#ffffff', maxW: w - 90 });
  ctx.fillStyle = '#16191b'; ctx.fillRect(x + 22, y + 66, w - 44, 120);  // screen bezel (screen is a separate lit part)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
    ctx.fillStyle = '#9aa2a8'; ctx.beginPath(); ctx.roundRect(x + 30 + c * 28, y + 206 + r * 24, 22, 18, 3); ctx.fill();
  }
  ctx.fillStyle = '#2e8b57'; ctx.beginPath(); ctx.roundRect(x + 128, y + 206, 96, 28, 4); ctx.fill();
  ctx.fillStyle = '#c0392b'; ctx.beginPath(); ctx.roundRect(x + 128, y + 242, 96, 28, 4); ctx.fill();
  ctx.fillStyle = '#1b1e20'; ctx.fillRect(x + 128, y + 282, 96, 36);
  ctx.fillStyle = '#e6e6e6'; ctx.fillRect(x + 138, y + 292, 76, 4);
  smallPrint(ctx, x + 22, y + 318, w - 44, 2, 8, '#c8ccce', rng, { heb: true });
  ctx.fillStyle = '#121416'; ctx.fillRect(x + 40, y + 338, w - 80, 36);
  ctx.fillStyle = '#f2c230'; ctx.fillRect(x + 40, y + 332, w - 80, 4);
  ctx.restore();
}

function kioskBand(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('kband', seed);
  ctx.save();
  ctx.fillStyle = '#21463a'; ctx.fillRect(x, y, w, h);
  text(ctx, hebWord(rng) + ' ' + hebWord(rng), x + w - 70, y + h * 0.62, 38, { align: 'right', rtl: true, color: '#efe6cf', font: SERIF, maxW: w * 0.5 });
  text(ctx, pseudoWord(rng, true) + ' · ' + pseudoWord(rng), x + 70, y + h * 0.6, 22, { color: '#d9cfb4', maxW: w * 0.36, weight: '600' });
  for (const cx of [x + 34, x + w - 34]) {
    ctx.strokeStyle = '#efe6cf'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(cx - 14, y + 30); ctx.lineTo(cx - 11, y + 62); ctx.lineTo(cx + 11, y + 62); ctx.lineTo(cx + 14, y + 30); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + 17, y + 44, 7, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  }
  ctx.restore();
}

function kioskMenu(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('kmenu', seed);
  ctx.save();
  ctx.fillStyle = '#f4efe2'; ctx.fillRect(x, y, w, h);
  const cw = (w - 20) / 4;
  for (let i = 0; i < 4; i++) {
    const px = x + 10 + i * cw;
    const [c, p] = off(Math.round(cw - 8), 70);
    const g = p.createLinearGradient(0, 0, 0, 70); g.addColorStop(0, hsl(rng.range(20, 40), 40, 70)); g.addColorStop(1, hsl(rng.range(20, 40), 30, 35));
    p.fillStyle = g; p.fillRect(0, 0, c.width, 70);
    // drink in a glass / cup, top lit
    p.fillStyle = hsl(rng.range(15, 35), 60, rng.range(20, 45)); p.beginPath(); p.roundRect(c.width * 0.35, 18, c.width * 0.3, 46, 4); p.fill();
    p.fillStyle = 'rgba(255,250,240,0.8)'; p.beginPath(); p.ellipse(c.width * 0.5, 19, c.width * 0.15, 4, 0, 0, Math.PI * 2); p.fill();
    grainVignette(p, 0, 0, c.width, 70, rng, 5, 0.2);
    ctx.drawImage(c, px + 4, y + 8);
    text(ctx, hebWord(rng), px + cw - 8, y + 94, 13, { align: 'right', rtl: true, color: '#2a2a2a', maxW: cw - 50 });
    text(ctx, `${rng.int(8, 26)}`, px + 6, y + 94, 14, { color: '#8a2a1e' });
    smallPrint(ctx, px + 6, y + 108, cw - 14, 2, 8, '#555', rng, { heb: true });
  }
  ctx.restore();
}

function mapHead(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('mhead', seed);
  ctx.fillStyle = '#23415f'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(x + 32, y + h / 2, 20, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#23415f'; ctx.font = `bold 32px ${SERIF}`; ctx.textAlign = 'center'; ctx.fillText('i', x + 32, y + h / 2 + 11);
  text(ctx, hebWord(rng) + ' ' + hebWord(rng), x + w - 16, y + h * 0.66, 28, { align: 'right', rtl: true, color: '#ffffff', maxW: w * 0.5 });
  text(ctx, phrase(rng, 2), x + 64, y + h * 0.64, 18, { color: '#cfd9e4', maxW: w * 0.38, weight: '600' });
}

function shelterInfo(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('sinfo', seed);
  ctx.fillStyle = '#f7f6f2'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1f5ea8'; ctx.fillRect(x, y, w, 40);
  text(ctx, hebWord(rng) + ' ' + hebWord(rng), x + w - 10, y + 27, 18, { align: 'right', rtl: true, color: '#ffffff', maxW: w - 20 });
  ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(x + 20, y + 70); for (let i = 1; i < 7; i++) ctx.lineTo(x + 20 + i * 36, y + 70 + (i % 2) * 18); ctx.stroke();
  for (let i = 0; i < 7; i++) { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x + 20 + i * 36, y + 70 + (i % 2) * 18, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  smallPrint(ctx, x + 12, y + 112, w - 24, 13, 9, '#444444', rng, { heb: true, lh: 1.6 });
}

export function buildPrintAtlas() {
  const c = mkCanvas(ATLAS_W, ATLAS_H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
  for (let i = 0; i < 8; i++) photoPoster(ctx, ...REG[`poster${i}`], i);
  for (let i = 0; i < 8; i++) (i % 2 ? eventPoster : photoPoster)(ctx, ...REG[`small${i}`], 100 + i);
  magazineCovers(ctx, REG.covers, 0);
  columnBand(ctx, REG.column);
  binDecal(ctx, REG.binDecal);
  coolerFront(ctx, REG.cooler);
  mapBoard(ctx, REG.map0, 0); mapBoard(ctx, REG.map1, 1);
  chalkBoard(ctx, REG.chalk0, 0); chalkBoard(ctx, REG.chalk1, 1);
  tramSign(ctx, REG.tramSign);
  timetable(ctx, REG.timetable, 0);
  ticketFront(ctx, REG.ticketFront, 0);
  magazines(ctx, REG.magazines, 0);
  kioskBand(ctx, REG.kioskBand, 0);
  kioskMenu(ctx, REG.kioskMenu, 0);
  mapHead(ctx, REG.mapHead, 0);
  shelterInfo(ctx, REG.shelterInfo, 0);
  return { canvas: c, uv: uvRect };
}

/** Emission of the light-box posters (top rows of the print atlas at half resolution):
 *  emitted colour follows the print (pow 1.6), the box is brightest in the middle and
 *  ~15% darker in the corners, with faint LED hot spots along the long edges. */
export function buildLitAtlas(atlas) {
  const W = ATLAS_W / 2, H = LIT_ROWS / 2, pw = W / 8;
  const c = mkCanvas(W, H);
  const ctx = c.getContext('2d');
  // canvas compositing only (no pixel read-back): colour squared ~ pow(c, 1.6)
  ctx.drawImage(atlas, 0, 0, ATLAS_W, LIT_ROWS, 0, 0, W, H);
  ctx.globalCompositeOperation = 'multiply';
  ctx.drawImage(atlas, 0, 0, ATLAS_W, LIT_ROWS, 0, 0, W, H);
  // light-box falloff per poster: centre 1.0, corners ~0.85
  for (let i = 0; i < 8; i++) {
    const cx = i * pw + pw / 2, g = ctx.createRadialGradient(cx, H / 2, 0, cx, H / 2, Math.hypot(pw, H) / 2);
    g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#d8d8d8');
    ctx.fillStyle = g; ctx.fillRect(i * pw, 0, pw, H);
  }
  // LED hot spots along the long edges
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 8; i++) for (const ex of [i * pw, (i + 1) * pw]) {
    for (let y = 4; y < H; y += 9) {
      const g = ctx.createRadialGradient(ex, y, 0, ex, y, 7);
      g.addColorStop(0, 'rgba(40,40,40,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(ex - 7, y - 7, 14, 14);
    }
  }
  return c;
}

// ------------------------------------------------------------------ shelter glazing decal
/** RGBA decal (colour + coverage) for shelter glass, u: 1 m (repeats), v: 4 m.
 *  v 0..2.5 m: vertical panes (dust at the foot, water spots, dotted safety bands at
 *  0.9-1.0 m and 1.5-1.6 m); v 2.5..4 m: roof glass (dust, drip line at the low edge, leaves). */
export function buildGlassDecal() {
  const W = 256, H = 1024, pxm = 256; // 3.9 mm per pixel
  const c = mkCanvas(W, H);
  const ctx = c.getContext('2d');
  const rng = RNG.from('glassDecal');
  const Y = (v) => H - v * pxm; // canvas row of height v (m)
  // dust at the foot of the panes
  const g = ctx.createLinearGradient(0, Y(0), 0, Y(0.35));
  g.addColorStop(0, 'rgba(150,138,118,0.42)'); g.addColorStop(0.5, 'rgba(150,138,118,0.12)'); g.addColorStop(1, 'rgba(150,138,118,0)');
  ctx.fillStyle = g; ctx.fillRect(0, Y(0.35), W, 0.35 * pxm);
  for (let i = 0; i < 260; i++) { // dried water spots and smears
    const v = rng.range(0, 2.5) ** 1.4 / 2.5 ** 0.4, x = rng.next() * W;
    ctx.fillStyle = `rgba(215,212,200,${rng.range(0.03, 0.1)})`;
    ctx.beginPath(); ctx.ellipse(x, Y(v), rng.range(1, 4), rng.range(1, 5), 0, 0, Math.PI * 2); ctx.fill();
  }
  for (let i = 0; i < 18; i++) { // rain runs
    const x = rng.next() * W, v0 = rng.range(0.2, 2.4);
    ctx.fillStyle = 'rgba(190,185,170,0.06)'; ctx.fillRect(x, Y(v0), rng.range(1, 3), rng.range(0.1, 0.5) * pxm);
  }
  // safety dots: three rows per band, 20 mm dots on a 40 mm pitch
  for (const [v0, v1] of [[0.9, 1.0], [1.5, 1.6]]) {
    ctx.fillStyle = 'rgba(232,232,226,0.88)';
    for (let r = 0; r < 3; r++) {
      const v = v0 + (r + 0.5) * (v1 - v0) / 3;
      for (let x = (r % 2) * 5 + 2.5; x < W; x += 10.24) { ctx.beginPath(); ctx.arc(x, Y(v), 2.6, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  // roof glass (v 2.5..4): settled dust, a drip line at the low (back) edge, leaves
  const rg = ctx.createLinearGradient(0, Y(2.5), 0, Y(4));
  rg.addColorStop(0, 'rgba(120,110,90,0.5)'); rg.addColorStop(0.12, 'rgba(130,120,100,0.22)'); rg.addColorStop(1, 'rgba(140,130,110,0.12)');
  ctx.fillStyle = rg; ctx.fillRect(0, Y(4), W, 1.5 * pxm);
  for (let x = 0; x < W; x += rng.range(3, 8)) { ctx.fillStyle = 'rgba(90,80,62,0.35)'; ctx.fillRect(x, Y(2.56), 2, rng.range(4, 18)); }
  for (let i = 0; i < 7; i++) {
    const x = rng.next() * W, v = rng.range(2.55, 3.6), a = rng.range(0, Math.PI);
    ctx.save(); ctx.translate(x, Y(v)); ctx.rotate(a);
    ctx.fillStyle = rng.chance(0.5) ? 'rgba(110,84,40,0.9)' : 'rgba(84,96,44,0.9)';
    ctx.beginPath(); ctx.ellipse(0, 0, rng.range(6, 10), rng.range(2.5, 4), 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  return c;
}

// ------------------------------------------------------------------ LED displays + screens
const DREG = { stop: [0, 0, 512, 128], shelter: [0, 128, 512, 128], screen: [512, 0, 256, 192] };
export function displayUV(name) {
  const [x, y, w, h] = DREG[name], W = 1024, H = 256;
  return [(x + 1) / W, 1 - (y + h - 1) / H, (x + w - 1) / W, 1 - (y + 1) / H];
}

/** LED dot-matrix text: glyphs rasterised at the panel's dot resolution, then each dot
 *  drawn as an anti-aliased disc straight into pixels (lit amber, unlit faintly visible). */
function dotMatrix(ctx, [x, y, w, h], lines, rgb) {
  const cw = 128, ch = 32;
  const o = mkCanvas(cw, ch).getContext('2d');
  o.fillStyle = '#000'; o.fillRect(0, 0, cw, ch);
  o.fillStyle = '#fff'; o.font = 'bold 13px monospace'; o.textBaseline = 'top';
  lines.forEach((ln, i) => { o.textAlign = 'left'; o.fillText(ln[0], 2, 2 + i * 15); o.textAlign = 'right'; o.fillText(ln[1], cw - 2, 2 + i * 15); });
  const px = o.getImageData(0, 0, cw, ch).data;
  const img = ctx.createImageData(w, h), d = img.data;
  const sx = w / cw, sy = h / ch, r = Math.min(sx, sy) * 0.36;
  const bg = [5, 5, 5], off = [24, 17, 7];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const ci = (i / sx) | 0, cj = (j / sy) | 0;
    const dist = Math.hypot(i + 0.5 - (ci + 0.5) * sx, j + 0.5 - (cj + 0.5) * sy);
    const cov = Math.min(1, Math.max(0, r + 0.5 - dist));
    const c = px[(cj * cw + ci) * 4] > 110 ? rgb : off, k = (j * w + i) * 4;
    for (let q = 0; q < 3; q++) d[k + q] = bg[q] + (c[q] - bg[q]) * cov;
    d[k + 3] = 255;
  }
  ctx.putImageData(img, x, y);
}

export function buildDisplayAtlas() {
  const c = mkCanvas(1024, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1024, 256);
  dotMatrix(ctx, DREG.stop, [['1 >>', '2 min'], ['1 >>', '9 min']], [255, 178, 58]);
  dotMatrix(ctx, DREG.shelter, [['1', '1 min'], ['1', '7 min']], [255, 178, 58]);
  // ticket machine touch screen: dark navy UI with light text rows and buttons
  const rng = RNG.from('screen');
  const [x, y, w, h] = DREG.screen;
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#0f2440'); g.addColorStop(1, '#081628');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1d3b63'; ctx.fillRect(x, y, w, 24);
  smallPrint(ctx, x + 8, y + 16, w * 0.5, 1, 11, 'rgba(225,232,240,0.9)', rng, { heb: true });
  smallPrint(ctx, x + 10, y + 42, w - 20, 2, 9, 'rgba(200,210,222,0.75)', rng, { heb: true });
  for (let r = 0; r < 3; r++) for (let k = 0; k < 2; k++) {
    const bx = x + 12 + k * (w / 2 - 6), by = y + 70 + r * 38;
    ctx.fillStyle = ['#2a6fb5', '#2f4f73', '#2f4f73'][r]; ctx.beginPath(); ctx.roundRect(bx, by, w / 2 - 24, 30, 5); ctx.fill();
    smallPrint(ctx, bx + 8, by + 19, w / 2 - 44, 1, 10, 'rgba(235,240,245,0.92)', rng, { heb: true });
  }
  return { canvas: c, uv: displayUV };
}
