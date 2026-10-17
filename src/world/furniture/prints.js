import { RNG } from '../../core/rng.js';

// Printed graphics for street furniture, drawn once into canvas atlases: generic
// posters, city map boards, chalk menu boards, the tram-stop pictogram sign, timetables,
// ticket machine panels, kiosk magazines and LED passenger displays. No real names.

export const ATLAS = 2048;
// [x, y, w, h] in atlas pixels (canvas y down)
const REG = {
  map0: [0, 384, 512, 640], map1: [512, 384, 512, 640],
  chalk0: [1024, 384, 256, 384], chalk1: [1280, 384, 256, 384],
  tramSign: [1536, 384, 256, 256], timetable: [1792, 384, 256, 384],
  ticketFront: [1536, 640, 256, 512], magazines: [0, 1024, 512, 256],
  kioskBand: [512, 1024, 512, 96], kioskMenu: [512, 1120, 512, 160],
  column0: [0, 1280, 1024, 512], column1: [1024, 1280, 1024, 512],
  mapHead: [1024, 768, 512, 64], shelterInfo: [1024, 832, 256, 320],
};
for (let i = 0; i < 8; i++) REG[`poster${i}`] = [i * 256, 0, 256, 384];

/** UV rect [u0, v0, u1, v1] of a named region (flipY texture: v = 1 - y). */
export function uvRect(name, inset = 1) {
  const [x, y, w, h] = REG[name];
  return [(x + inset) / ATLAS, 1 - (y + h - inset) / ATLAS, (x + w - inset) / ATLAS, 1 - (y + inset) / ATLAS];
}

const WORDS = ['JAZZ', 'SUMMER', 'FESTIVAL', 'CONCERT', 'GALLERY', 'THEATRE', 'CINEMA', 'MUSEUM', 'DANCE', 'LIVE', 'MARKET', 'OPEN AIR', 'NIGHTS', 'EXPO', 'BOOK FAIR', 'SALE', 'FILM', 'ART', 'MUSIC', 'OPERA'];
const PALETTES = [
  ['#f2c230', '#1d1d1b', '#e94e1b', '#ffffff'], ['#1b3c6e', '#f4efe2', '#e85d3f', '#f2c230'],
  ['#e8e1d3', '#2a2a28', '#c0392b', '#3a7ca5'], ['#0f6e5f', '#f4e9cf', '#f29e4c', '#ffffff'],
  ['#7a1f3d', '#f7d6b5', '#f2c230', '#ffffff'], ['#f4f1ea', '#1d3557', '#e63946', '#a8dadc'],
  ['#222831', '#ffd369', '#eeeeee', '#ff6b6b'], ['#5b8e7d', '#f4f1de', '#e07a5f', '#3d405b'],
];

function textFit(ctx, str, x, y, maxW, size, weight = 'bold', align = 'left', font = 'Helvetica, Arial, sans-serif') {
  let s = size;
  do { ctx.font = `${weight} ${s}px ${font}`; s -= 1; } while (ctx.measureText(str).width > maxW && s > 6);
  ctx.textAlign = align;
  ctx.fillText(str, x, y);
}

function textLines(ctx, x, y, w, n, lh, color, rng, thick = 2) {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i++) {
    let cx = x;
    const lw = i === n - 1 ? w * rng.range(0.3, 0.7) : w;
    while (cx < x + lw - 6) {
      const ww = Math.min(rng.range(6, 26), x + lw - cx);
      ctx.fillRect(cx, y + i * lh, ww, thick);
      cx += ww + rng.range(3, 6);
    }
  }
}

function poster(ctx, x, y, w, h, seed) {
  const rng = RNG.from('poster', seed);
  const [bg, fg, ac, ac2] = PALETTES[seed % PALETTES.length];
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = bg; ctx.fillRect(x, y, w, h);
  const style = seed % 5;
  if (style === 0) { // big sun disc + horizon
    const g = ctx.createRadialGradient(x + w * 0.5, y + h * 0.42, 4, x + w * 0.5, y + h * 0.42, w * 0.45);
    g.addColorStop(0, ac2); g.addColorStop(1, ac);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x + w * 0.5, y + h * 0.42, w * 0.36, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = fg; ctx.fillRect(x, y + h * 0.58, w, h * 0.42);
  } else if (style === 1) { // geometric composition
    for (let i = 0; i < 7; i++) {
      ctx.fillStyle = [fg, ac, ac2][i % 3];
      ctx.globalAlpha = 0.85;
      if (rng.chance(0.5)) { ctx.beginPath(); ctx.arc(x + rng.next() * w, y + rng.range(0.1, 0.6) * h, rng.range(15, 60), 0, Math.PI * 2); ctx.fill(); }
      else { ctx.save(); ctx.translate(x + rng.next() * w, y + rng.range(0.1, 0.6) * h); ctx.rotate(rng.range(-0.8, 0.8)); ctx.fillRect(-40, -12, rng.range(60, 140), rng.range(14, 40)); ctx.restore(); }
    }
    ctx.globalAlpha = 1;
  } else if (style === 2) { // photo-like gradient with a figure silhouette
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, ac2); g.addColorStop(0.6, ac); g.addColorStop(1, fg);
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(20,20,24,0.85)';
    const cx = x + w * rng.range(0.35, 0.65), base = y + h * 0.78;
    ctx.beginPath(); ctx.arc(cx, base - h * 0.42, w * 0.08, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx - w * 0.16, base); ctx.quadraticCurveTo(cx - w * 0.15, base - h * 0.33, cx, base - h * 0.34);
    ctx.quadraticCurveTo(cx + w * 0.15, base - h * 0.33, cx + w * 0.16, base); ctx.fill();
  } else if (style === 3) { // stripes
    for (let i = 0; i < 9; i++) { ctx.fillStyle = i % 2 ? ac : ac2; ctx.fillRect(x, y + h * (0.08 + i * 0.055), w, h * 0.028); }
  } else { // product: bottle shape on colour field
    ctx.fillStyle = ac; ctx.fillRect(x, y + h * 0.15, w, h * 0.5);
    ctx.fillStyle = fg;
    const cx = x + w * 0.5, by = y + h * 0.62;
    ctx.beginPath(); ctx.moveTo(cx - 22, by); ctx.lineTo(cx - 22, by - 90); ctx.quadraticCurveTo(cx - 22, by - 120, cx - 8, by - 132);
    ctx.lineTo(cx - 8, by - 170); ctx.lineTo(cx + 8, by - 170); ctx.lineTo(cx + 8, by - 132); ctx.quadraticCurveTo(cx + 22, by - 120, cx + 22, by - 90); ctx.lineTo(cx + 22, by); ctx.fill();
    ctx.fillStyle = ac2; ctx.fillRect(cx - 22, by - 70, 44, 30);
  }
  ctx.fillStyle = style === 0 ? bg : fg;
  if (style === 2) ctx.fillStyle = '#ffffff';
  const word = WORDS[(seed * 7 + 3) % WORDS.length], word2 = WORDS[(seed * 11 + 5) % WORDS.length];
  textFit(ctx, word, x + w * 0.08, y + h * (style === 0 ? 0.74 : 0.8), w * 0.84, 54);
  ctx.globalAlpha = 0.9;
  textFit(ctx, word2, x + w * 0.08, y + h * (style === 0 ? 0.83 : 0.88), w * 0.6, 22, '600');
  ctx.globalAlpha = 1;
  textFit(ctx, `${(seed * 3) % 28 + 1}.${(seed % 9) + 1}`, x + w * 0.92, y + h * 0.1, w * 0.4, 26, 'bold', 'right');
  textLines(ctx, x + w * 0.08, y + h * 0.92, w * 0.84, 2, 7, style === 0 ? bg : fg, rng, 2);
  ctx.restore();
}

function mapBoard(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('map', seed);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#f1ece0'; ctx.fillRect(x, y, w, h);
  // header
  ctx.fillStyle = '#23415f'; ctx.fillRect(x, y, w, 58);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(x + 32, y + 29, 18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#23415f'; ctx.font = 'bold 28px Georgia, serif'; ctx.textAlign = 'center'; ctx.fillText('i', x + 32, y + 39);
  ctx.fillStyle = '#ffffff'; textFit(ctx, 'CITY MAP', x + 64, y + 40, 260, 30);
  // blocks between a slightly irregular street grid
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
  }
  // river / park band and the tram line
  ctx.strokeStyle = '#9cc3dc'; ctx.lineWidth = 14;
  ctx.beginPath(); ctx.moveTo(mx, my + mh * 0.85); ctx.bezierCurveTo(mx + mw * 0.3, my + mh * 0.7, mx + mw * 0.6, my + mh, mx + mw, my + mh * 0.8); ctx.stroke();
  ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(mx + mw * 0.08, my + mh * 0.1);
  ctx.lineTo(mx + mw * 0.45, my + mh * 0.38); ctx.lineTo(mx + mw * 0.55, my + mh * 0.62); ctx.lineTo(mx + mw * 0.95, my + mh * 0.7); ctx.stroke();
  for (const t of [[0.08, 0.1], [0.27, 0.24], [0.45, 0.38], [0.5, 0.5], [0.55, 0.62], [0.75, 0.66], [0.95, 0.7]]) {
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(mx + mw * t[0], my + mh * t[1], 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // you are here
  ctx.fillStyle = '#e74c3c'; ctx.beginPath(); ctx.arc(mx + mw * 0.5, my + mh * 0.5, 11, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke();
  // legend
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x + 16, y + h - 104, w - 32, 88);
  for (let i = 0; i < 6; i++) {
    const lx = x + 28 + (i % 3) * ((w - 56) / 3), ly = y + h - 92 + Math.floor(i / 3) * 40;
    ctx.fillStyle = ['#c0392b', '#9cc3dc', '#b7cf9a', '#e6c9a8', '#23415f', '#e74c3c'][i];
    ctx.fillRect(lx, ly, 22, 22);
    textLines(ctx, lx + 30, ly + 8, (w - 56) / 3 - 44, 1, 8, '#555555', rng, 3);
  }
  ctx.restore();
}

function scribble(ctx, x, y, w, rng, size) {
  // pseudo-handwriting: a run of connected loops
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
  for (let i = 0; i < 40; i++) { // erased chalk haze
    ctx.fillStyle = `rgba(200,205,200,${rng.range(0.01, 0.04)})`;
    ctx.beginPath(); ctx.ellipse(x + rng.next() * w, y + rng.next() * h, rng.range(20, 70), rng.range(6, 20), rng.range(0, 3), 0, Math.PI * 2); ctx.fill();
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(245,242,230,0.9)'; ctx.lineWidth = 3;
  scribble(ctx, x + 30, y + 52, w - 60, rng, 22);
  ctx.strokeStyle = 'rgba(240,200,120,0.85)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x + 40, y + 70); ctx.quadraticCurveTo(x + w / 2, y + 78, x + w - 40, y + 68); ctx.stroke();
  ctx.font = 'bold 18px Helvetica, Arial, sans-serif'; ctx.textAlign = 'right';
  for (let i = 0; i < 8; i++) {
    const ly = y + 110 + i * 30;
    ctx.strokeStyle = i % 3 === 0 ? 'rgba(170,220,235,0.85)' : 'rgba(245,242,230,0.85)'; ctx.lineWidth = 2;
    scribble(ctx, x + 18, ly, w * rng.range(0.35, 0.6), rng, 11);
    ctx.fillStyle = 'rgba(245,242,230,0.85)';
    ctx.fillText(`${rng.int(8, 46)}`, x + w - 18, ly + 4);
  }
  // doodle: a steaming cup
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
  ctx.fillStyle = '#1f5ea8'; ctx.font = 'bold 24px Helvetica, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('1', x + 25, y + 32);
  textLines(ctx, x + 52, y + 20, w - 70, 1, 10, '#ffffff', rng, 5);
  ctx.fillStyle = '#e4e2dc';
  for (let r = 0; r < 18; r += 2) ctx.fillRect(x + 6, y + 56 + r * 17, w - 12, 17);
  ctx.fillStyle = '#333333'; ctx.font = '11px Helvetica, Arial, sans-serif'; ctx.textAlign = 'left';
  for (let r = 0; r < 18; r++) {
    ctx.fillText(String(5 + r).padStart(2, '0'), x + 10, y + 69 + r * 17);
    let line = '';
    for (let k = 0; k < 6; k++) line += String((k * 10 + rng.int(0, 9)) % 60).padStart(2, '0') + '  ';
    ctx.fillText(line, x + 40, y + 69 + r * 17);
  }
  ctx.restore();
}

function ticketFront(ctx, [x, y, w, h]) {
  ctx.save();
  ctx.fillStyle = '#3d4246'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1f5ea8'; ctx.fillRect(x, y, w, 60);
  // pictogram in the header
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(x + 18, y + 16, 54, 26, [6, 10, 3, 3]); ctx.fill();
  ctx.fillStyle = '#1f5ea8'; for (let i = 0; i < 3; i++) ctx.fillRect(x + 23 + i * 15, y + 21, 10, 9);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 22px Helvetica, Arial, sans-serif'; ctx.textAlign = 'left'; ctx.fillText('TICKETS', x + 84, y + 39);
  // screen bezel (screen itself is a separate emissive part)
  ctx.fillStyle = '#16191b'; ctx.fillRect(x + 22, y + 84, w - 44, 150);
  // keypad and buttons
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
    ctx.fillStyle = '#9aa2a8'; ctx.beginPath(); ctx.roundRect(x + 34 + c * 30, y + 262 + r * 26, 24, 20, 3); ctx.fill();
  }
  ctx.fillStyle = '#2e8b57'; ctx.beginPath(); ctx.roundRect(x + 140, y + 262, 80, 30, 4); ctx.fill();
  ctx.fillStyle = '#c0392b'; ctx.beginPath(); ctx.roundRect(x + 140, y + 300, 80, 30, 4); ctx.fill();
  // card reader + coin slot + pictos
  ctx.fillStyle = '#1b1e20'; ctx.fillRect(x + 140, y + 346, 80, 40);
  ctx.fillStyle = '#e6e6e6'; ctx.fillRect(x + 150, y + 356, 60, 4);
  ctx.fillStyle = '#d4af37'; ctx.beginPath(); ctx.arc(x + 60, y + 380, 14, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#111'; ctx.fillRect(x + 54, y + 372, 12, 3);
  // ticket tray
  ctx.fillStyle = '#121416'; ctx.fillRect(x + 40, y + 420, w - 80, 56);
  ctx.fillStyle = '#f2c230'; ctx.fillRect(x + 40, y + 412, w - 80, 4);
  ctx.restore();
}

function magazines(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('mag', seed);
  ctx.save();
  ctx.fillStyle = '#2c2f30'; ctx.fillRect(x, y, w, h);
  for (let r = 0; r < 3; r++) {
    let cx = x + 4;
    while (cx < x + w - 30) {
      const mw = rng.range(36, 54), pal = PALETTES[rng.int(0, PALETTES.length - 1)];
      const ty = y + 6 + r * (h / 3), mh = h / 3 - 12;
      ctx.fillStyle = pal[0]; ctx.fillRect(cx, ty + rng.range(0, 6), mw, mh);
      ctx.fillStyle = pal[1]; ctx.fillRect(cx + 3, ty + 6, mw - 6, 10);
      ctx.fillStyle = pal[2]; ctx.fillRect(cx + 5, ty + 22, mw * rng.range(0.3, 0.8), mh * rng.range(0.25, 0.5));
      cx += mw + rng.range(2, 6);
    }
  }
  ctx.restore();
}

function kioskBand(ctx, [x, y, w, h]) {
  ctx.save();
  ctx.fillStyle = '#21463a'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#efe6cf'; ctx.font = 'bold 54px Georgia, serif'; ctx.textAlign = 'center';
  ctx.fillText('KIOSK', x + w / 2, y + h * 0.7);
  // cup pictograms
  for (const cx of [x + 60, x + w - 60]) {
    ctx.strokeStyle = '#efe6cf'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(cx - 20, y + 26); ctx.lineTo(cx - 16, y + 66); ctx.lineTo(cx + 16, y + 66); ctx.lineTo(cx + 20, y + 26); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx + 24, y + 44, 9, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  }
  ctx.restore();
}

function kioskMenu(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('kmenu', seed);
  ctx.save();
  ctx.fillStyle = '#f4efe2'; ctx.fillRect(x, y, w, h);
  for (let i = 0; i < 4; i++) {
    const px = x + 10 + i * (w - 20) / 4;
    const pal = PALETTES[(i * 3 + 1) % PALETTES.length];
    ctx.fillStyle = pal[0]; ctx.fillRect(px + 4, y + 10, (w - 20) / 4 - 8, 80);
    ctx.fillStyle = pal[2]; ctx.beginPath(); ctx.arc(px + (w - 20) / 8, y + 50, 24, 0, Math.PI * 2); ctx.fill();
    textLines(ctx, px + 8, y + 104, (w - 20) / 4 - 16, 3, 14, '#3a3a3a', rng, 4);
  }
  ctx.restore();
}

function columnBand(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('column', seed);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#d8d2c2'; ctx.fillRect(x, y, w, h); // old paper layers
  for (let i = 0; i < 30; i++) { ctx.fillStyle = `rgba(${rng.int(150, 230)},${rng.int(140, 220)},${rng.int(120, 200)},0.5)`; ctx.fillRect(x + rng.next() * w, y + rng.next() * h, rng.range(20, 120), rng.range(20, 160)); }
  const n = 3, pw = w / n - 10;
  for (let i = 0; i < n; i++) {
    const px = x + 5 + i * (w / n);
    // posters are drawn at 256 x 384 and scaled to the band
    ctx.save(); ctx.translate(px, y + 4); ctx.scale(pw / 256, (h - 8) / 384);
    poster(ctx, 0, 0, 256, 384, seed * 5 + i + 11);
    ctx.restore();
    // torn corner / weathering
    ctx.fillStyle = 'rgba(230,224,210,0.9)';
    if (rng.chance(0.5)) { ctx.beginPath(); ctx.moveTo(px + pw, y + h - 4); ctx.lineTo(px + pw - rng.range(20, 50), y + h - 4); ctx.lineTo(px + pw, y + h - rng.range(20, 60)); ctx.fill(); }
  }
  const g = ctx.createLinearGradient(x, y + h * 0.8, x, y + h);
  g.addColorStop(0, 'rgba(60,50,40,0)'); g.addColorStop(1, 'rgba(60,50,40,0.25)');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function mapHead(ctx, [x, y, w, h]) {
  ctx.fillStyle = '#23415f'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(x + 32, y + h / 2, 20, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#23415f'; ctx.font = 'bold 32px Georgia, serif'; ctx.textAlign = 'center'; ctx.fillText('i', x + 32, y + h / 2 + 11);
}

function shelterInfo(ctx, [x, y, w, h], seed) {
  const rng = RNG.from('sinfo', seed);
  ctx.fillStyle = '#f7f6f2'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1f5ea8'; ctx.fillRect(x, y, w, 40);
  textLines(ctx, x + 12, y + 18, w - 24, 1, 10, '#ffffff', rng, 6);
  // network diagram
  ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(x + 20, y + 70); for (let i = 1; i < 7; i++) ctx.lineTo(x + 20 + i * 36, y + 70 + (i % 2) * 18); ctx.stroke();
  textLines(ctx, x + 12, y + 110, w - 24, 12, 15, '#444444', rng, 3);
}

export function buildPrintAtlas() {
  const c = document.createElement('canvas');
  c.width = c.height = ATLAS;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, ATLAS, ATLAS);
  for (let i = 0; i < 8; i++) poster(ctx, i * 256, 0, 256, 384, i);
  mapBoard(ctx, REG.map0, 0); mapBoard(ctx, REG.map1, 1);
  chalkBoard(ctx, REG.chalk0, 0); chalkBoard(ctx, REG.chalk1, 1);
  tramSign(ctx, REG.tramSign);
  timetable(ctx, REG.timetable, 0);
  ticketFront(ctx, REG.ticketFront);
  magazines(ctx, REG.magazines, 0);
  kioskBand(ctx, REG.kioskBand);
  kioskMenu(ctx, REG.kioskMenu, 0);
  columnBand(ctx, REG.column0, 0); columnBand(ctx, REG.column1, 1);
  mapHead(ctx, REG.mapHead);
  shelterInfo(ctx, REG.shelterInfo, 0);
  return { canvas: c, uv: uvRect };
}

// ------------------------------------------------------------------ LED displays
const DREG = { stop: [0, 0, 512, 128], shelter: [0, 128, 512, 128], screen: [512, 0, 256, 192] };
export function displayUV(name) {
  const [x, y, w, h] = DREG[name], W = 1024, H = 256;
  return [(x + 1) / W, 1 - (y + h - 1) / H, (x + w - 1) / W, 1 - (y + 1) / H];
}

function dotMatrix(ctx, [x, y, w, h], lines, color) {
  // render text at cell resolution, then draw each lit cell as a round LED
  const cw = 128, ch = 32;
  const off = document.createElement('canvas'); off.width = cw; off.height = ch;
  const o = off.getContext('2d');
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
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 1024, 256);
  dotMatrix(ctx, DREG.stop, [['1 >>', '2 min'], ['1 >>', '9 min']], '#ffb23a');
  dotMatrix(ctx, DREG.shelter, [['1', 'NOW'], ['1', '7 min']], '#ffb23a');
  // ticket machine touch screen
  const [x, y, w, h] = DREG.screen;
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#1d4f8f'); g.addColorStop(1, '#0f2f5a');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x + 10, y + 10, w - 20, 22);
  for (let r = 0; r < 3; r++) for (let k = 0; k < 2; k++) {
    ctx.fillStyle = ['#f2c230', '#e9e9e9', '#7fc4ef'][r];
    ctx.beginPath(); ctx.roundRect(x + 14 + k * (w / 2 - 6), y + 44 + r * 46, w / 2 - 22, 36, 6); ctx.fill();
  }
  return { canvas: c, uv: displayUV };
}
