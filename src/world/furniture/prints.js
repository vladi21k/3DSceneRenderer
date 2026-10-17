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
  column0: [0, 768, 2048, 512], column1: [2048, 768, 2048, 512],
  covers: [3072, 1280, 1024, 768],
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

/** Person silhouette (head and shoulders or full figure) with soft shading and rim light. */
function person(ctx, cx, base, scale, rng, { full = false, skin = null, cloth = null, rim = '#fff3dc' } = {}) {
  const sk = skin || hsl(rng.range(18, 32), rng.range(30, 55), rng.range(28, 68));
  const cl = cloth || hsl(rng.range(0, 360), rng.range(20, 70), rng.range(18, 55));
  const hair = hsl(rng.range(15, 35), rng.range(20, 50), rng.range(8, 35));
  const draw = (fillSkin, fillCloth, fillHair, dx = 0, dy = 0) => {
    const s = scale;
    const headY = base - (full ? 1.65 : 0.62) * s;
    // torso / body
    ctx.fillStyle = fillCloth;
    ctx.beginPath();
    if (full) {
      ctx.moveTo(cx - 0.2 * s + dx, headY + 0.2 * s + dy);
      ctx.quadraticCurveTo(cx - 0.3 * s + dx, headY + 0.35 * s + dy, cx - 0.25 * s + dx, headY + 0.85 * s + dy);
      ctx.lineTo(cx - 0.17 * s + dx, base + dy); ctx.lineTo(cx - 0.03 * s + dx, base + dy); ctx.lineTo(cx + dx, headY + 0.95 * s + dy);
      ctx.lineTo(cx + 0.03 * s + dx, base + dy); ctx.lineTo(cx + 0.17 * s + dx, base + dy);
      ctx.lineTo(cx + 0.25 * s + dx, headY + 0.85 * s + dy);
      ctx.quadraticCurveTo(cx + 0.3 * s + dx, headY + 0.35 * s + dy, cx + 0.2 * s + dx, headY + 0.2 * s + dy);
    } else {
      ctx.moveTo(cx - 0.55 * s + dx, base + dy);
      ctx.quadraticCurveTo(cx - 0.5 * s + dx, headY + 0.32 * s + dy, cx - 0.12 * s + dx, headY + 0.24 * s + dy);
      ctx.lineTo(cx + 0.12 * s + dx, headY + 0.24 * s + dy);
      ctx.quadraticCurveTo(cx + 0.5 * s + dx, headY + 0.32 * s + dy, cx + 0.55 * s + dx, base + dy);
    }
    ctx.closePath(); ctx.fill();
    // neck + head
    ctx.fillStyle = fillSkin;
    ctx.fillRect(cx - 0.05 * s + dx, headY + 0.08 * s + dy, 0.1 * s, 0.16 * s);
    ctx.beginPath(); ctx.ellipse(cx + dx, headY + dy, 0.105 * s, 0.135 * s, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = fillHair;
    ctx.beginPath(); ctx.ellipse(cx + dx, headY - 0.05 * s + dy, 0.115 * s, 0.1 * s, 0, Math.PI, Math.PI * 2); ctx.fill();
  };
  ctx.save();
  ctx.globalAlpha = 0.55;
  draw(rim, rim, rim, scale * 0.014, -scale * 0.007); // rim light
  ctx.globalAlpha = 0.85;
  draw(rim, rim, rim, scale * 0.007, -scale * 0.003);
  ctx.globalAlpha = 1;
  draw(sk, cl, hair);
  // key light shading across the figure
  const g = ctx.createLinearGradient(cx - scale * 0.5, 0, cx + scale * 0.5, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.35)'); g.addColorStop(0.55, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(255,240,220,0.12)');
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = g; ctx.fillRect(cx - scale, base - scale * 2, scale * 2, scale * 2.1);
  ctx.restore();
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

/** One photographic advertising poster. */
function photoPoster(ctx, x, y, w, h, seed) {
  const rng = RNG.from('poster', seed);
  const [c, p] = off(w, h);
  const theme = seed % 6;
  const hue = rng.range(0, 360);
  const bg = p.createLinearGradient(0, 0, w * 0.3, h);
  bg.addColorStop(0, hsl(hue, rng.range(20, 60), rng.range(55, 80))); bg.addColorStop(1, hsl(hue + rng.range(-40, 40), rng.range(25, 60), rng.range(15, 40)));
  p.fillStyle = bg; p.fillRect(0, 0, w, h);
  if (theme === 0 || theme === 3) { // portrait(s)
    bokeh(p, w, h, rng, 14, hue + 180);
    person(p, w * rng.range(0.4, 0.6), h * 0.86, h * 0.75, rng);
    if (theme === 3) person(p, w * 0.78, h * 0.9, h * 0.6, rng);
  } else if (theme === 1) { // fashion: full figure on a studio sweep
    const sw = p.createRadialGradient(w * 0.5, h * 0.45, 4, w * 0.5, h * 0.5, h * 0.7);
    sw.addColorStop(0, hsl(hue, 15, 88)); sw.addColorStop(1, hsl(hue, 20, 48));
    p.fillStyle = sw; p.fillRect(0, 0, w, h);
    person(p, w * 0.5, h * 0.84, h * 0.42, rng, { full: true });
    p.save(); p.translate(w * 0.5, h * 0.845); p.scale(1, 0.08); softDot(p, 0, 0, w * 0.2, 'rgba(0,0,0,A)', 0.35); p.restore();
  } else if (theme === 2) { // product on a gradient with a light streak
    bokeh(p, w, h, rng, 6, hue);
    product(p, w * 0.5, h * 0.7, h * 0.5, rng, hue + 180);
  } else if (theme === 4) { // landscape / travel
    landscape(p, w, h, rng);
  } else { // stage / concert: light beams over a crowd
    p.fillStyle = hsl(hue, 50, 8); p.fillRect(0, 0, w, h);
    p.save(); p.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const x0 = w * rng.next(), hh = hue + rng.range(-60, 60);
      const g = p.createLinearGradient(x0 - w * 0.3, 0, x0 + w * 0.3, 0);
      g.addColorStop(0, hsl(hh, 80, 50, 0)); g.addColorStop(0.5, hsl(hh, 80, 55, 0.3)); g.addColorStop(1, hsl(hh, 80, 50, 0));
      p.fillStyle = g;
      p.beginPath(); p.moveTo(x0 - w * 0.02, 0); p.lineTo(x0 - w * 0.3, h * 0.8); p.lineTo(x0 + w * 0.3, h * 0.8); p.lineTo(x0 + w * 0.02, 0); p.fill();
    }
    p.restore();
    p.fillStyle = '#06060a';
    for (let i = 0; i < 26; i++) { const cx = rng.next() * w, r = rng.range(0.025, 0.045) * w; p.beginPath(); p.arc(cx, h * 0.84 - rng.next() * h * 0.03, r, 0, Math.PI * 2); p.fill(); p.fillRect(cx - r * 1.4, h * 0.84, r * 2.8, h * 0.16); }
  }
  // typography: a headline of 1-3 pseudo-words, sub lines, fine print, logo, date strip
  const heb = rng.chance(0.45);
  const light = theme !== 1;
  const fg = light ? 'rgba(250,248,240,0.95)' : 'rgba(20,20,24,0.92)';
  const top = rng.chance(0.5);
  const hy = top ? h * 0.1 : h * 0.66;
  text(p, phrase(rng, rng.int(1, 2), heb), heb ? w * 0.92 : w * 0.08, hy, h * rng.range(0.05, 0.075), { maxW: w * 0.84, align: heb ? 'right' : 'left', rtl: heb, color: fg, font: rng.chance(0.4) ? SERIF : SANS });
  smallPrint(p, w * 0.08, hy + h * 0.05, w * 0.7, rng.int(1, 3), Math.max(8, h * 0.022), fg, rng, { heb });
  // brand band
  const band = rng.chance(0.6);
  if (band) { p.fillStyle = hsl(hue + 180, 40, light ? 18 : 92, 0.85); p.fillRect(0, h * 0.9, w, h * 0.1); }
  p.fillStyle = band ? 'rgba(240,238,230,0.9)' : fg;
  p.beginPath(); p.arc(w * 0.12, h * 0.95, h * 0.022, 0, Math.PI * 2); p.fill();
  text(p, pseudoWord(rng, true), w * 0.17, h * 0.962, h * 0.03, { color: band ? 'rgba(240,238,230,0.95)' : fg, maxW: w * 0.4 });
  smallPrint(p, w * 0.56, h * 0.94, w * 0.36, 2, Math.max(6, h * 0.012), band ? 'rgba(230,230,225,0.8)' : fg, rng);
  grainVignette(p, 0, 0, w, h, rng);
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
  else { pp.fillStyle = hsl(hue + 150, 30, 30); pp.fillRect(0, 0, pc.width, pc.height); bokeh(pp, pc.width, pc.height, rng, 8, hue); person(pp, pc.width * 0.5, pc.height, pc.height * 0.9, rng); }
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

/** Current poster sheets on a column band: [u0, v0, u1, v1] as fractions from the
 *  band's top-left. Deterministic and cheap (the geometry needs them without drawing). */
export function columnSheetRects(seed) {
  const rng = RNG.from('columnSheets', seed);
  const n = 6, sw = 1 / n, out = [];
  for (let i = 0; i < n; i++) {
    const shW = sw * rng.range(0.82, 0.94), shH = rng.range(0.82, 0.92);
    const x0 = i * sw + (sw - shW) / 2 + rng.range(-0.004, 0.004), y0 = 0.04 + rng.range(0, 0.06);
    out.push([x0, y0, x0 + shW, y0 + shH]);
  }
  return out;
}

/** Band of glued posters round an advertising column. Returns the top-layer sheet rects
 *  (fractions of the band) so the geometry can raise them. The band tiles horizontally. */
function columnBand(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('column', seed);
  const [c, p] = off(w, h);
  // old paper layers and remnants
  p.fillStyle = '#d9d2c0'; p.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    p.fillStyle = hsl(rng.range(20, 60), rng.range(5, 35), rng.range(55, 85), 0.6);
    tornRect(p, rng.next() * w, rng.next() * h, rng.range(60, 300), rng.range(60, 300), rng, 10); p.fill();
  }
  for (let i = 0; i < 8; i++) { // remnants of older posters
    const sx = rng.next() * w, sy = rng.next() * h * 0.5;
    p.save(); tornRect(p, sx, sy, rng.range(120, 260), rng.range(150, 300), rng, 14); p.clip();
    eventPoster(p, sx, sy, 260, 390, seed * 31 + i);
    p.fillStyle = 'rgba(235,230,215,0.45)'; p.fillRect(sx, sy, 300, 400);
    p.restore();
  }
  // current sheets (raised 2 mm by the column geometry): sun-faded, peeling corners
  const sheets = columnSheetRects(seed);
  for (let i = 0; i < sheets.length; i++) {
    const [f0, g0, f1, g1] = sheets[i];
    const sx = f0 * w, sy = g0 * h, shW = (f1 - f0) * w, shH = (g1 - g0) * h;
    p.save();
    p.translate(sx, sy);
    p.beginPath(); p.rect(0, 0, shW, shH); p.clip();
    p.scale(shW / 256, shH / 384);
    if (rng.chance(0.5)) photoPoster(p, 0, 0, 256, 384, seed * 17 + i + 40); else eventPoster(p, 0, 0, 256, 384, seed * 13 + i);
    p.restore();
    // sun fade, glue stains, peeling corner
    p.fillStyle = `rgba(240,236,225,${rng.range(0.05, 0.3)})`; p.fillRect(sx, sy, shW, shH);
    for (let k = 0; k < 3; k++) { p.fillStyle = 'rgba(90,80,60,0.08)'; p.fillRect(sx + rng.next() * shW, sy, rng.range(2, 6), shH * rng.range(0.2, 0.9)); }
    if (rng.chance(0.4)) {
      const cx = rng.chance(0.5) ? sx + shW : sx, cy = rng.chance(0.5) ? sy + shH : sy, s = rng.range(14, 40);
      const dx = cx > sx ? -1 : 1, dy = cy > sy ? -1 : 1;
      p.fillStyle = '#cfc6b0'; p.beginPath(); p.moveTo(cx, cy); p.lineTo(cx + dx * s, cy); p.lineTo(cx, cy + dy * s); p.fill();
      p.fillStyle = 'rgba(250,248,240,0.95)'; p.beginPath(); p.moveTo(cx + dx * s, cy); p.lineTo(cx, cy + dy * s); p.lineTo(cx + dx * s * 0.75, cy + dy * s * 0.75); p.fill();
    }
  }
  // grime towards the bottom, rain streaks
  const g = p.createLinearGradient(0, h * 0.7, 0, h);
  g.addColorStop(0, 'rgba(60,50,40,0)'); g.addColorStop(1, 'rgba(60,50,40,0.3)');
  p.fillStyle = g; p.fillRect(0, 0, w, h);
  grainVignette(p, 0, 0, w, h, rng, 5, 0);
  ctx.drawImage(c, x, y);
  return sheets;
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
    if (rng.chance(0.7)) person(p, W * rng.range(0.4, 0.6), H, H * 0.85, rng); else product(p, W * 0.5, H * 0.85, H * 0.6, rng, hue + 160);
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
  columnBand(ctx, REG.column0, 0); columnBand(ctx, REG.column1, 1);
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

function dotMatrix(ctx, [x, y, w, h], lines, color) {
  const cw = 128, ch = 32;
  const o = mkCanvas(cw, ch).getContext('2d');
  o.fillStyle = '#000'; o.fillRect(0, 0, cw, ch);
  o.fillStyle = '#fff'; o.font = 'bold 13px monospace'; o.textBaseline = 'top';
  lines.forEach((ln, i) => { o.textAlign = 'left'; o.fillText(ln[0], 2, 2 + i * 15); o.textAlign = 'right'; o.fillText(ln[1], cw - 2, 2 + i * 15); });
  const px = o.getImageData(0, 0, cw, ch).data;
  ctx.fillStyle = '#050505'; ctx.fillRect(x, y, w, h);
  const sx = w / cw, sy = h / ch;
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const on = px[(j * cw + i) * 4] > 110;
    ctx.fillStyle = on ? color : 'rgba(60,40,10,0.35)';
    ctx.beginPath(); ctx.arc(x + (i + 0.5) * sx, y + (j + 0.5) * sy, Math.min(sx, sy) * 0.36, 0, Math.PI * 2); ctx.fill();
  }
}

export function buildDisplayAtlas() {
  const c = mkCanvas(1024, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1024, 256);
  dotMatrix(ctx, DREG.stop, [['1 >>', '2 min'], ['1 >>', '9 min']], '#ffb23a');
  dotMatrix(ctx, DREG.shelter, [['1', '1 min'], ['1', '7 min']], '#ffb23a');
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
