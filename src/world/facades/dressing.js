// Shop dressing: what makes a ground floor look traded in rather than built. On the
// display glass posters (sales, photographs, menus, events, notices), banners and price
// cards, spread so no design repeats within ~80 m of a street side; on the door an
// "open" sticker, the opening hours or card decals; on the piers beside clothing, shoe
// and general stores merchandise hung from wall hooks (shirts, dresses, trousers,
// scarves, bags: canvas cards in the awning batch, so they take its cloth shading,
// translucency and sway in the wind) and price boards. Everything is deterministic per
// opening and built for the near range only.
import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { Tpl, TplCache, VS, lin } from './geo.js';
import { dressCell, cardTpl, sheetTpl, POSTER_INFO, N_PRICES, N_BANNERS, letteringTpls, cellTpl, iconCell, ICON_SOLID, subWordsOf } from './signs.js';
import { inRustic } from './outline.js';

const _t = new THREE.Matrix4();

// how keen each kind of shop is on posters / price cards / goods hung outside
const KEEN = {
  clothing: [0.65, 0.35, 0.7], general: [0.55, 0.45, 0.5], cafe: [0.4, 0.3, 0], jewellery: [0.35, 0.15, 0],
  pharmacy: [0.5, 0.4, 0], shoes: [0.6, 0.4, 0.5], books: [0.3, 0.15, 0], flowers: [0.2, 0.3, 0],
};
// poster categories a kind of shop puts up, by preference (signs.js POSTER_INFO)
const CATS = {
  clothing: ['sale', 'fashion', 'notice'], shoes: ['sale', 'fashion', 'notice'], general: ['sale', 'notice', 'culture'],
  pharmacy: ['sale', 'notice'], jewellery: ['fashion', 'notice', 'sale'], cafe: ['food', 'notice', 'culture'],
  books: ['culture', 'notice'], flowers: ['culture', 'notice'],
};
const BANNER_TYPES = new Set(['clothing', 'shoes', 'general']);

const GLOW = { aGlow: [0.25] };

/**
 * What a shopfront asks for, deterministic per opening: posters (each a list of
 * categories by preference), a sale banner, a run of price cards. About half the shops
 * put up no promotion at all.
 */
export function dressRequest(o, type) {
  const r = RNG.from(o.id, 'dressReq');
  const keen = KEEN[type] || KEEN.general;
  const cats = CATS[type] || CATS.general;
  const posters = [];
  if (r.chance(keen[0])) {
    const n = r.chance(0.6) ? 1 : r.chance(0.75) ? 2 : 3;
    // the second and third of a set usually change category (a photograph beside a sale card)
    for (let k = 0; k < n; k++) posters.push(k === 0 || r.chance(0.5) ? cats : [...cats.slice(1), cats[0]]);
  }
  if (r.chance(0.2)) posters.push(['notice']);
  const banner = posters.length > 0 && BANNER_TYPES.has(type) && r.chance(0.3);
  const prices = r.chance(keen[1]) ? r.int(1, 3) : 0;
  // a price board on the pier beside the shopfront, now and then
  const pier = r.chance(type === 'cafe' ? 0.15 : 0.22);
  return { posters, banner, prices, pier };
}

// design pools split into three phases (index mod 3 within each pool); every 40 m block of
// a street side takes the phase of its index mod 3, so blocks sharing a phase lie >= 80 m
// apart, and within a block no design is given twice
let POOLS = null;
function pools() {
  if (POOLS) return POOLS;
  const P = { posters: {}, prices: [[], [], []], banners: [[], [], []] };
  const seen = {};
  POSTER_INFO.forEach((d, i) => {
    const k = (seen[d.cat] = (seen[d.cat] ?? -1) + 1);
    (P.posters[d.cat] || (P.posters[d.cat] = [[], [], []]))[k % 3].push(i);
  });
  for (let i = 0; i < N_PRICES; i++) P.prices[i % 3].push(i);
  for (let i = 0; i < N_BANNERS; i++) P.banners[i % 3].push(i);
  return (POOLS = P);
}

/**
 * Designs for the shops of one block (canonical order): [{id, req}] → Map(id → {posters:
 * [design], banner: design | -1, prices: [design], pier: design | -1}). A request that
 * finds its pools used up in the block goes without (never a repeat).
 */
export function allocateBlock(shops, phase, seed) {
  const P = pools();
  const used = new Set();
  const r = new RNG(seed);
  // the order each pool is walked in this block
  const order = (list) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r.next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const walk = {};
  const next = (key, list) => {
    const w = walk[key] || (walk[key] = order(list));
    for (const d of w) { const id = `${key[0]}${d}`; if (!used.has(id)) { used.add(id); return d; } }
    return -1;
  };
  const out = new Map();
  for (const { id, req } of shops) {
    const a = { posters: [], banner: -1, prices: [], pier: -1 };
    for (const cats of req.posters) {
      for (const c of cats) {
        const set = P.posters[c];
        if (!set) continue;
        const d = next(`p${c}`, set[phase]);
        if (d >= 0) { a.posters.push(d); break; }
      }
    }
    if (req.banner) a.banner = next('b', P.banners[phase]);
    for (let k = 0; k < req.prices; k++) { const d = next('r', P.prices[phase]); if (d >= 0) a.prices.push(d); }
    if (req.pier) a.pier = next('r', P.prices[phase]);
    out.set(id, a);
  }
  return out;
}

/** Display-glass panes of shopfront layout L between the mullions: [x0, x1] spans. */
function panes(L) {
  const { hwI, doorW, dx } = L;
  const d0 = dx - doorW / 2, d1 = dx + doorW / 2;
  const out = [];
  for (const [a, b] of [[-hwI, d0 - 0.065], [d1 + 0.065, hwI]]) {
    const w = b - a;
    if (w < 0.3) continue;
    const nm = Math.max(0, Math.round(w / 1.3) - 1);
    for (let i = 0; i <= nm; i++) {
      const x0 = a + (w * i) / (nm + 1) + (i > 0 ? 0.03 : 0.01), x1 = a + (w * (i + 1)) / (nm + 1) - (i < nm ? 0.03 : 0.01);
      if (x1 - x0 > 0.25) out.push([x0, x1]);
    }
  }
  return out;
}

// paper heights (m): the long side of a portrait sheet, the short side of a landscape one
const PAPER = { A4: [0.297, 0.21], A3: [0.42, 0.297], A2: [0.594, 0.42], A1: [0.841, 0.594] };

/**
 * Posters, banners, price cards and door stickers on shopfront L of opening o (matrix m:
 * the opening's local frame), with the designs `al` given to it (allocateBlock). Text
 * batch, full colour. Posters vary in paper size, height and placement (eye level, along
 * the head of the pane, standing on the display, taped in a corner), a few are hung a
 * little crooked, and their paper cockles. far: the far range keeps the same posters and
 * banners (they still read at 200 m, so the shopfront does not change at the detail
 * switch) as flat sheets in front of the far glass plane; the small cards are left out.
 */
export function dressWindow(kit, o, L, m, type, far = false, al = null, brand = null) {
  if (!al) return;
  const r = RNG.from(o.id, 'dress');
  const t = new Tpl();
  const yG = L.yT - 0.05, y0 = L.riser + 0.1;
  const zG = far ? 0.05 : -0.016;
  const ps = panes(L);
  const used = [];
  const free = (x0, x1, a, b) => !used.some((u) => x0 < u[1] && x1 > u[0] && a < u[3] && b > u[2]);
  if (brand && ps.length) vinyl(kit, o, L, m, type, brand, ps, used, yG, y0, zG, far);
  if (ps.length) {
    for (const d of al.posters) {
      const info = POSTER_INFO[d], cell = dressCell('posters', d);
      const [x0, x1] = ps[r.int(0, ps.length - 1)];
      const mode = r.weighted([['eye', 0.5], ['high', 0.2], ['low', 0.2], ['corner', 0.1]]);
      const pap = PAPER[info.size] || PAPER.A3;
      let h = (cell.aspect > 1.05 ? pap[1] : cell.aspect < 0.95 ? pap[0] : (pap[0] + pap[1]) / 2) * r.range(0.95, 1.05);
      h = Math.min(h, yG - y0 - 0.06, (x1 - x0 - 0.06) / cell.aspect);
      const tilt = info.cat === 'notice' ? r.range(-0.04, 0.04) : r.chance(0.5) ? 0 : r.range(-0.015, 0.015);
      const wr = info.size === 'A4' ? r.range(1.0, 1.5) : r.range(0.5, 1.0);
      const fx = r.next(), fy = r.next();
      if (h < 0.18) continue;
      const w = h * cell.aspect;
      const xl = x0 + w / 2 + 0.03, xr = Math.max(xl, x1 - w / 2 - 0.03);
      let x = mode === 'corner' ? (fx < 0.5 ? xl : xr) : xl + (xr - xl) * fx;
      let y;
      if (mode === 'high' || mode === 'corner') y = yG - h / 2 - 0.03 - 0.08 * fy;
      else if (mode === 'low') y = y0 + h / 2 + 0.02 + 0.08 * fy;
      else y = Math.min(yG - h / 2 - 0.05, Math.max(y0 + h / 2 + 0.02, 1.35 + 0.3 * fy));
      if (!free(x - w / 2, x + w / 2, y - h / 2, y + h / 2)) {
        // try the other end of the pane
        x = xl + xr - x;
        if (!free(x - w / 2, x + w / 2, y - h / 2, y + h / 2)) continue;
      }
      used.push([x - w / 2, x + w / 2, y - h / 2, y + h / 2]);
      sheetTpl(t, cell, x, y, h, zG, tilt, r.int(1, 1 << 30), far ? 0 : wr);
    }
  }
  if (ps.length && al.banner >= 0) {
    // a sale banner along the top of a display pane
    const [x0, x1] = ps[r.int(0, ps.length - 1)];
    const cell = dressCell('banners', al.banner);
    const h = Math.min(0.24, Math.max(0.12, (x1 - x0 - 0.06) / cell.aspect));
    const w = Math.min(h * cell.aspect, x1 - x0 - 0.06);
    const y = yG - h / 2 - 0.05;
    if (w > 0.4 && y - h / 2 > y0 + 0.6 && free(x0, x1, y - h / 2, y + h / 2)) {
      used.push([(x0 + x1 - w) / 2, (x0 + x1 + w) / 2, y - h / 2, y + h / 2]);
      cardTpl(t, cell, (x0 + x1) / 2, y, w / cell.aspect, zG);
    }
  }
  if (ps.length && al.prices.length) {
    // price cards standing low in the window, a run of one to three
    const [x0, x1] = ps[r.int(0, ps.length - 1)];
    let x = x0 + 0.06 + r.range(0, 0.25);
    for (const d of al.prices) {
      const cell = dressCell('prices', d);
      const h = r.range(0.15, 0.24), w = h * cell.aspect;
      const y = y0 + h / 2 + r.range(0.0, 0.25);
      if (x + w > x1 - 0.06) break;
      if (free(x, x + w, y - h / 2, y + h / 2)) { used.push([x, x + w, y - h / 2, y + h / 2]); if (!far) cardTpl(t, cell, x + w / 2, y, h, zG); }
      x += w + r.range(0.08, 0.3);
    }
  }
  if (!far && r.chance(0.5)) {
    // the door: "open" / entrance / push sticker, the opening hours, card and camera decals
    const cell = dressCell('stickers', r.pick([0, 1, 2, 7, 8, 9, 12, 14, 3, 4]));
    const h = cell.aspect > 1.5 ? 0.11 : 0.2;
    const dzG = -L.setback - 0.001;
    cardTpl(t, cell, L.dx, Math.min(1.55, L.doorH - 0.25), h, dzG);
    if (r.chance(0.45)) cardTpl(t, dressCell('stickers', r.pick([3, 4, 6, 10, 11, 13])), L.dx + (r.chance(0.5) ? -1 : 1) * 0.18, r.range(1.1, 1.3), 0.09, dzG);
  }
  if (!t.count) { t.free(); return; }
  // (behind the pane in reality: what the glass transmits)
  kit.get('signText').add(t.bake(), m, 0.86, 0.86, 0.86, GLOW);
}

// ------------------------------------------------------------------ vinyl on the glass
// Vinyl a shop has cut for its windows, on the outer face of the glass: its name (and
// often its phone number) in white, gold or its accent colour along the top of a display
// pane; and on fashion, shoe, general and chemist's windows now and then a band or panel
// of coloured film carrying its trade or its name, the colour that reads from down the
// street.
const VIVID = [0xc8231c, 0xe0641a, 0xe0a81c, 0x1f4fa0, 0x1e7a3a, 0xc2185b, 0x7a3aa8, 0x1e8a8a, 0xd01e1a];
const PANEL_TYPES = { clothing: 0.32, shoes: 0.28, general: 0.24, pharmacy: 0.22, books: 0.1, jewellery: 0.08, cafe: 0.1, flowers: 0.08 };
function vinyl(kit, o, L, m, type, brand, ps, used, yG, y0, zG, far) {
  const r = RNG.from(o.id, 'vinylGlass');
  const design = { type: 'letters', cell: 0, board: null, ...brand, subAccent: false };
  // the widest pane takes the lettering
  let pi = 0;
  for (let i = 1; i < ps.length; i++) if (ps[i][1] - ps[i][0] > ps[pi][1] - ps[pi][0]) pi = i;
  const z = zG + (far ? 0 : 0.002);
  const G = { aGlow: [0.2] };
  if (r.chance(far ? 0.45 : 0.45)) {
    const [x0, x1] = ps[pi];
    const w = Math.min(x1 - x0 - 0.12, r.range(0.7, 1.5)), h = Math.min(0.34, w * r.range(0.2, 0.32));
    const y = yG - 0.08 - h / 2 - r.range(0, 0.25);
    if (w > 0.4 && y - h / 2 > y0 + 0.9) {
      const x = r.chance(0.6) ? (x0 + x1) / 2 : r.chance(0.5) ? x0 + 0.06 + w / 2 : x1 - 0.06 - w / 2;
      const tp = letteringTpls(design, w, h, z, far);
      const c = lin(r.weighted([[0xf4f1e8, 0.62], [0xd8b25a, 0.18], [brand.accent ?? 0xf4f1e8, 0.2]]));
      const mm = new THREE.Matrix4().copy(m).multiply(_t.makeTranslation(x, y, 0));
      kit.get('signText').add(tp.text, mm, c[0], c[1], c[2], G);
      if (tp.accent) { const a = lin(brand.accent ?? 0xc8231c); kit.get('signText').add(tp.accent, mm, a[0], a[1], a[2], G); }
      used.push([x - w / 2, x + w / 2, y - h / 2, y + h / 2]);
    }
  }
  if (!r.chance(PANEL_TYPES[type] ?? 0.1)) return;
  // a coloured film panel: a band along the foot of a pane, or a tall panel at one side
  const [x0, x1] = ps[r.int(0, ps.length - 1)];
  const col = lin(r.pick(VIVID));
  const tall = r.chance(0.45) && x1 - x0 > 1.1;
  const w = tall ? Math.min(x1 - x0 - 0.1, r.range(0.55, 0.9)) : x1 - x0 - 0.04;
  const h = tall ? Math.min(yG - y0 - 0.2, r.range(1.1, 1.6)) : Math.min(yG - y0 - 0.4, r.range(0.32, 0.62));
  if (w < 0.4 || h < 0.25) return;
  const x = tall ? (r.chance(0.5) ? x0 + 0.05 + w / 2 : x1 - 0.05 - w / 2) : (x0 + x1) / 2;
  const y = tall ? y0 - 0.05 + h / 2 + r.range(0, 0.2) : y0 - 0.1 + h / 2;
  const pt = new Tpl();
  cellTpl(pt, iconCell(ICON_SOLID), 0, 0, w, h, z, 0.9);
  const mm = new THREE.Matrix4().copy(m).multiply(_t.makeTranslation(x, y, 0));
  kit.get('signText').add(pt.bake(), mm, col[0], col[1], col[2], G);
  // its lettering in white: the trade (a word in the panel's language), the name, or both
  const words = subWordsOf(type);
  const d2 = r.chance(0.5) && words.length ? { type: 'letters', cell: words[r.int(0, words.length - 1)], board: null } : { ...design, sub: tall ? design.sub : null, logo: tall ? brand.logo : -1 };
  const tp = letteringTpls(d2, w * 0.82, tall ? Math.min(h * 0.4, w * 0.5) : h * 0.62, z + 0.001, !tall);
  const ty = tall ? h * 0.18 : 0;
  const mt = new THREE.Matrix4().copy(mm).multiply(_t.makeTranslation(0, ty, 0));
  kit.get('signText').add(tp.text, mt, 0.95, 0.94, 0.9, G);
  if (tp.accent) kit.get('signText').add(tp.accent, mt, 0.95, 0.94, 0.9, G);
  used.push([x - w / 2, x + w / 2, y - h / 2, y + h / 2]);
}

// ------------------------------------------------------------------ goods hung outside
// Garments and bags in the awning batch (canvas shading, translucency, sway): hook at the
// local origin, hanging down -y, facing +z.
const CLOTH = [0x1d2a44, 0xe8e4da, 0x8a8a86, 0x3a2a22, 0xa8231e, 0x2c6a3a, 0xc9b08a, 0x1c1c1e, 0x7fb2d8, 0xd8879a, 0xe2b630, 0x6b3a72, 0xd0672a,
  0xc8231c, 0x1f4fa0, 0xe86a8a, 0x2a9a8a, 0xf2d24a];
const tplCache = new TplCache(64);

// Silhouettes (CCW, metres; the hook at the origin) and how each piece is made up:
// [outline, half thickness at its middle (m), rim over which it thins (m), folds, len]
const GARMENTS = {
  // a tee on a hanger: neck, sloping shoulders, short sleeves, the body to the hem
  tee: [[[0, -0.045], [0.07, -0.055], [0.19, -0.09], [0.33, -0.2], [0.27, -0.3], [0.2, -0.255], [0.215, -0.69], [-0.215, -0.69], [-0.2, -0.255], [-0.27, -0.3], [-0.33, -0.2], [-0.19, -0.09], [-0.07, -0.055]], 0.011, 0.04, 1, 0.69],
  // a summer dress: straps over the hanger, bodice, a skirt flaring to the hem
  dress: [[[0.05, -0.045], [0.13, -0.06], [0.16, -0.24], [0.13, -0.42], [0.34, -1.0], [-0.34, -1.0], [-0.13, -0.42], [-0.16, -0.24], [-0.13, -0.06], [-0.05, -0.045]], 0.01, 0.04, 1.2, 1.0],
  // trousers folded at the waist over a clip bar: the legs apart below the fork
  trousers: [[[0.2, -0.05], [0.215, -0.32], [0.2, -0.97], [0.035, -0.97], [0.0, -0.31], [-0.035, -0.97], [-0.2, -0.97], [-0.215, -0.32], [-0.2, -0.05]], 0.012, 0.03, 0.8, 0.97],
  // a scarf folded over the bar, its ends hanging (fringed)
  scarf: [[[0.11, -0.025], [0.125, -1.02], [0.08, -1.08], [0.02, -1.04], [-0.04, -1.09], [-0.125, -1.03], [-0.11, -0.025]], 0.008, 0.02, 1.4, 1.08],
  // a tote: its body (handles apart), with volume
  bag: [[[0.18, -0.15], [0.2, -0.5], [-0.2, -0.5], [-0.18, -0.15]], 0.02, 0.035, 0.3, 0.5],
  // a backpack hung by its grab loop: rounded body
  pack: [[[0.1, -0.05], [0.15, -0.09], [0.165, -0.42], [0.13, -0.47], [-0.13, -0.47], [-0.165, -0.42], [-0.15, -0.09], [-0.1, -0.05]], 0.075, 0.09, 0.15, 0.47],
};

/** Distance from (x, y) to polygon P's outline, signed (+ inside), and the nearest outline point. */
function polyDist(P, x, y, out) {
  let best = Infinity, inside = false, nx = x, ny = y;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [ax, ay] = P[j], [bx, by] = P[i];
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
    const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / l2));
    const px = ax + ex * t, py = ay + ey * t, d = (x - px) ** 2 + (y - py) ** 2;
    if (d < best) { best = d; nx = px; ny = py; }
  }
  out[0] = nx; out[1] = ny;
  return inside ? Math.sqrt(best) : -Math.sqrt(best);
}

/**
 * A garment as a closed soft shell over silhouette P: front and back surfaces that meet at
 * the outline (the cloth's edge), thickness T at the middle thinning over the rim R, soft
 * vertical folds deepening towards the hem, a little fuller where the hanger shapes it.
 * Grid cells of `cell` metres; outline vertices are snapped onto the outline. Normals from
 * the faces; the shade darkens the folds' hollows and the sides turning away.
 */
function shell(t, P, T, R, folds, len, cell, seed, sides = 2) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const nx = Math.max(3, Math.ceil((x1 - x0) / cell)), ny = Math.max(3, Math.ceil((y1 - y0) / cell));
  const ph = seed * 1.7;
  const fold = (x, y) => folds * (0.003 + 0.013 * Math.min(1, -y / len)) * (0.62 * Math.sin(x * 27 + 1.3 + ph) + 0.38 * Math.sin(x * 61 + 0.4 + y * 3 + ph));
  const np = (nx + 1) * (ny + 1);
  const X = new Float32Array(np), Y = new Float32Array(np), D = new Float32Array(np);
  const q = [0, 0];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = j * (nx + 1) + i;
      let x = x0 + ((x1 - x0) * i) / nx, y = y0 + ((y1 - y0) * j) / ny;
      const d = polyDist(P, x, y, q);
      if (d < 0) { x = q[0]; y = q[1]; }
      X[k] = x; Y[k] = y; D[k] = Math.max(0, d);
    }
  }
  const inCell = (i, j) => { const k = j * (nx + 1) + i; return D[k] > 0 || D[k + 1] > 0 || D[k + nx + 1] > 0 || D[k + nx + 2] > 0; };
  // vertices: front then back (one side only: the front, its edge thinning to the outline)
  const base = t.count, pos = [];
  for (let side = 0; side < sides; side++) {
    for (let k = 0; k < np; k++) {
      const x = X[k], y = Y[k], e = Math.min(1, D[k] / R), prof = T * (1 - (1 - e) * (1 - e));
      const f = fold(x, y) * e;
      const z = side ? -prof * 0.85 + f * 0.6 : prof + f;
      pos.push(x, y, z);
    }
  }
  const nrm = new Float32Array(pos.length), tris = [];
  for (let side = 0; side < sides; side++) {
    const o = side * np;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!inCell(i, j)) continue;
        const a = o + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        if (side) tris.push(a, b, c, b, d, c); else tris.push(a, c, b, b, c, d);
      }
    }
  }
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k] * 3, b = tris[k + 1] * 3, c = tris[k + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { nrm[v] += fx; nrm[v + 1] += fy; nrm[v + 2] += fz; }
  }
  for (let k = 0; k < sides * np; k++) {
    const o = k * 3;
    let ax = nrm[o], ay = nrm[o + 1], az = nrm[o + 2];
    const l = Math.hypot(ax, ay, az);
    if (l > 1e-12) { ax /= l; ay /= l; az /= l; } else { ax = 0; ay = 0; az = k < np ? 1 : -1; }
    const x = pos[o], y = pos[o + 1], hollow = fold(x, y) / 0.016;
    const sh = (0.78 + 0.22 * Math.abs(az)) * (0.93 + 0.07 * hollow) * (k < np ? 1 : 0.9);
    t.v(x, y, pos[o + 2], ax, ay, az, x, y, sh);
  }
  for (let k = 0; k < tris.length; k += 6) t.ix6(base + tris[k], base + tris[k + 1], base + tris[k + 2], base + tris[k + 3], base + tris[k + 4], base + tris[k + 5]);
}

/** A strap or handle loop: a flat band of width bw along the polyline pts (x, y, z), both faces. */
function strap(t, pts, bw, th = 0.004) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay, az] = pts[i], [bx, by, bz] = pts[i + 1];
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1, sx = (-dy / l) * bw / 2, sy = (dx / l) * bw / 2;
    t.q4(ax - sx, ay - sy, az + th, ax + sx, ay + sy, az + th, bx + sx, by + sy, bz + th, bx - sx, by - sy, bz + th, 0.9, 0.9);
    t.q4(ax + sx, ay + sy, az - th, ax - sx, ay - sy, az - th, bx - sx, by - sy, bz - th, bx + sx, by + sy, bz - th, 0.8, 0.8);
  }
}

/**
 * Garment template of `kind` (tee, dress, trousers, scarf, bag, pack): a soft shell with
 * folds (bags with their handles, a backpack with its pocket and straps). Cached; .len is
 * its hanging length. `use`: 'wall' (hung against a wall or the glass: the front only, the
 * back never seen), 'rail' (on a stand's rail, seen from both sides but small: a closed
 * shell on a coarser grid), else a closed shell.
 */
export function cloth(kind, use = 'wall') {
  return tplCache.get(`${kind}|${use}`, () => {
    const t = new Tpl();
    const [P, T, R, folds, len] = GARMENTS[kind] || GARMENTS.bag;
    const vol = kind === 'bag' || kind === 'pack';
    shell(t, P, T, R, folds, len, vol ? 0.035 : use === 'rail' ? 0.06 : 0.05, kind.length, use === 'wall' && !vol ? 1 : 2);
    if (kind === 'bag') {
      for (const s of [-1, 1]) strap(t, [[s * 0.1, -0.15, 0.02 * s], [s * 0.07, -0.07, 0.012 * s], [s * 0.025, -0.015, 0.004 * s], [0, -0.005, 0]], 0.025);
    } else if (kind === 'pack') {
      // front pocket, the grab loop over the hook and the shoulder straps behind
      const pk = new Tpl();
      shell(pk, [[0.12, -0.24], [0.125, -0.41], [0.1, -0.44], [-0.1, -0.44], [-0.125, -0.41], [-0.12, -0.24]], 0.03, 0.04, 0.1, 0.47, 0.03, 3);
      t.appendRotY(pk, 0, 0, 0);
      const V = t.V, n0 = t.count - pk.count;
      for (let k = n0; k < t.count; k++) V[k * VS + 2] += 0.07;
      pk.free();
      strap(t, [[-0.03, -0.055, 0], [0, -0.005, 0], [0.03, -0.055, 0]], 0.02);
      for (const s of [-1, 1]) strap(t, [[s * 0.08, -0.09, -0.07], [s * 0.11, -0.25, -0.085], [s * 0.12, -0.42, -0.07]], 0.05);
    }
    // darker towards the hem's shadow side
    t.shadeBy((x, y) => 1 - 0.06 * Math.min(1, -y / len));
    const b = t.bake();
    b.len = len; b.kind = kind;
    return b;
  });
}
/** Hanger of a garment (standPaint batch): hook and shoulder bar, or a clip bar for trousers and scarves. */
export function hangerTpl(kind) {
  return tplCache.get(`hanger|${kind}`, () => {
    const t = new Tpl();
    // the hook: up from the bar and over (a few straight pieces)
    t.box(-0.003, -0.05, -0.003, 0.003, 0.0, 0.003, 1 | 2 | 4 | 8, 0.9, 1);
    t.box(-0.003, 0.0, -0.025, 0.003, 0.006, 0.003, 1 | 2 | 4 | 8 | 16 | 32, 0.9, 1);
    t.box(-0.003, -0.02, -0.031, 0.003, 0.006, -0.025, 1 | 2 | 4 | 8 | 16, 0.9, 1);
    if (kind === 'tee' || kind === 'dress') {
      // the shoulder bar following the shoulders' slope
      const hw = kind === 'tee' ? 0.2 : 0.15, dy = kind === 'tee' ? 0.045 : 0.02;
      for (const s of [-1, 1]) {
        t.q4(0, -0.04, 0.012, s * hw, -0.04 - dy, 0.012, s * hw, -0.055 - dy, 0.012, 0, -0.055, 0.012, 0.9, 1);
        t.q4(s * hw, -0.04 - dy, -0.012, 0, -0.04, -0.012, 0, -0.055, -0.012, s * hw, -0.055 - dy, -0.012, 0.85, 0.95);
        t.q4(0, -0.04, -0.012, s * hw, -0.04 - dy, -0.012, s * hw, -0.04 - dy, 0.012, 0, -0.04, 0.012, 1, 1);
      }
    } else if (kind === 'trousers' || kind === 'scarf') {
      t.box(-0.21, -0.06, -0.012, 0.21, -0.042, 0.016, 1 | 2 | 4 | 8 | 16 | 32, 0.85, 1);
    }
    return t.bake();
  });
}
const HOOK = (() => {
  const t = new Tpl();
  t.box(-0.006, -0.01, -0.07, 0.006, 0.008, 0.0, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  t.box(-0.006, -0.01, -0.012, 0.006, 0.05, 0.0, 1 | 4 | 8 | 32, 0.9, 1);
  return t.bake();
})();
const HANGER_COL = [[0.03, 0.03, 0.032], [0.36, 0.2, 0.1], [0.75, 0.74, 0.72], [0.03, 0.03, 0.032]];

const KINDS = {
  clothing: [['tee', 0.32], ['dress', 0.24], ['trousers', 0.16], ['scarf', 0.16], ['bag', 0.12]],
  shoes: [['bag', 0.6], ['pack', 0.2], ['scarf', 0.2]],
  general: [['bag', 0.3], ['pack', 0.25], ['scarf', 0.25], ['tee', 0.2]],
};
// fronts that crowd their door with stock (piers covered, a rail of it across the window)
const DENSE = { clothing: 0.32, general: 0.3, shoes: 0.2 };

/** Hang garment `kind` with its hook at world matrix mw (on a wall hook or a rail). */
function hangItem(kit, kind, mw, r, sway = 0.9) {
  const tp = cloth(kind), len = tp.len;
  const c1 = lin(r.pick(CLOTH)), c2 = lin(r.pick(CLOTH));
  const stripe = (kind === 'tee' || kind === 'scarf' || kind === 'dress') && r.chance(0.3) ? r.range(0.03, 0.07) : 0;
  kit.get('awning').add(tp, mw, c1[0], c1[1], c1[2], {
    aStripe: [c2[0], c2[1], c2[2], stripe],
    aFlex: (k, v, a, j) => { a[j] = Math.min(1, Math.max(0, -v[k * VS + 1] / len)) * sway; },
  });
  if (kind !== 'bag' && kind !== 'pack') {
    const hc = r.pick(HANGER_COL);
    kit.get('standPaint').add(hangerTpl(kind), mw, hc[0], hc[1], hc[2]);
  }
  return len;
}

/**
 * Clear stretch of wall beside opening o on `side` (−1 left, +1 right) at heights
 * [gy + 0.5, gy + 2.6]: [u0, u1] in facade u, or null. Other openings keep 0.5 m (door
 * plaques, lanterns), walls ends 0.3 m, balconies and their consoles their footprint.
 */
function pier(plan, o, side, gy) {
  const e = o.uc + side * (o.w / 2 + 0.07);
  let lim = side > 0 ? plan.width - 0.3 : 0.3;
  const yA = gy + 0.5, yB = gy + 2.6;
  for (const n of plan.openings) {
    if (n === o || n.y > yB || n.y + n.h < yA) continue;
    const a = n.uc - n.w / 2 - 0.5, b = n.uc + n.w / 2 + 0.5;
    if (side > 0 && a > e) lim = Math.min(lim, a);
    if (side < 0 && b < e) lim = Math.max(lim, b);
  }
  for (const b of plan.balconies || []) {
    const soffit = b.y - (b.slabT || 0.16) - 1.0;
    if (soffit > yB) continue;
    if (side > 0 && b.u0 > e) lim = Math.min(lim, b.u0 - 0.1);
    if (side < 0 && b.u1 < e) lim = Math.max(lim, b.u1 + 0.1);
  }
  // projecting blade signs keep their pier to themselves
  for (const s of plan.signs || []) {
    if (s.kind !== 'blade') continue;
    if (side > 0 && s.u + 0.35 > e) lim = Math.min(lim, s.u - 0.35);
    if (side < 0 && s.u - 0.35 < e) lim = Math.max(lim, s.u + 0.35);
  }
  const u0 = side > 0 ? e : lim, u1 = side > 0 ? lim : e;
  return u1 - u0 >= 0.42 ? [u0, u1] : null;
}

/**
 * Merchandise hung on the piers beside shop o (clothing, shoes, general stores) and a
 * price board: built in the wall frame (u, v, w out of the wall face).
 * Returns the number of items hung.
 */
export function hangGoods(kit, ctx, o, type, al = null, L = null, mOpen = null) {
  const kinds = KINDS[type];
  const r = RNG.from(o.id, 'hang');
  const plan = ctx.plan, frame = ctx.frame;
  let n = 0;
  const dense = !!kinds && r.chance(DENSE[type] ?? 0);
  if (kinds && (dense || r.chance((KEEN[type] || KEEN.general)[2]))) {
    const sides = r.chance(0.5) ? [1, -1] : [-1, 1];
    const both = dense || r.chance(0.35);
    for (const side of sides) {
      const gy = plan.groundAt(o.uc + side * (o.w / 2 + 0.4));
      const span = pier(plan, o, side, gy);
      if (!span) continue;
      const [u0, u1] = span;
      // columns of hooks from the jamb outwards (a dense front fills the pier)
      const pitch = dense ? 0.4 : 0.52;
      const cols = dense ? Math.max(1, Math.min(3, Math.floor((u1 - u0 - 0.06) / pitch))) : u1 - u0 > 1.05 && r.chance(0.6) ? 2 : 1;
      for (let c = 0; c < cols; c++) {
        const uc = side > 0 ? u0 + 0.22 + c * pitch : u1 - 0.22 - c * pitch;
        let top = gy + r.range(2.35, 2.6);
        for (let row = 0; row < (dense ? 3 : 2); row++) {
          const kind = r.weighted(kinds);
          const len = cloth(kind).len;
          if (top - len < gy + 0.5) break;
          // a bundle on the hook: the same piece in two to four colours, fanned out
          const nb = kind === 'pack' ? 1 : kind === 'bag' ? r.int(1, 2) : r.int(1, dense ? 2 : 3);
          // (rusticated stone: hooks on the bosses' faces)
          const z = 0.1 + (inRustic(plan, top) ? 0.03 : 0) + (kind === 'pack' ? 0.06 : kind === 'bag' ? 0.03 : 0);
          for (let q = nb - 1; q >= 0; q--) {
            const mw = new THREE.Matrix4().copy(frame.matrix).multiply(_t.makeTranslation(uc + (q - (nb - 1) / 2) * 0.05 + r.range(-0.02, 0.02), top - q * 0.03, z + q * 0.03));
            // a slight swing off the wall at the hem, a little twist
            mw.multiply(_t.makeRotationX(-r.range(0.03, 0.09))).multiply(_t.makeRotationZ(r.range(-0.06, 0.06)));
            hangItem(kit, kind, mw, r);
          }
          kit.get('metal').add(HOOK, new THREE.Matrix4().copy(frame.matrix).multiply(_t.makeTranslation(uc, top + 0.01, z)), 0.06, 0.06, 0.062);
          n++;
          top -= len + 0.1;
          if (kind === 'dress' || kind === 'trousers' || kind === 'scarf') break;
        }
      }
      if (n && !both) break;
    }
  }
  // a dense front also hangs stock from a rail across the top of its display window, in
  // the reveal in front of the glass (never across the door)
  if (dense && L && mOpen && ctx.q >= 0.5) {
    const yR = L.yT - 0.04, zR = -(L.inset || 0) + 0.14;
    const d0 = L.dx - L.doorW / 2 - 0.12, d1 = L.dx + L.doorW / 2 + 0.12;
    for (const [a, b] of [[-L.hwI + 0.05, d0], [d1, L.hwI - 0.05]]) {
      if (b - a < 0.5) continue;
      const rail = new Tpl();
      rail.box(a, yR - 0.012, zR - 0.012, b, yR + 0.012, zR + 0.012, 1 | 2 | 16 | 32, 0.9, 1);
      kit.get('metal').add(rail.bake(), mOpen, 0.5, 0.5, 0.52);
      const k2 = KINDS[type].filter(([k]) => k !== 'trousers' && k !== 'dress');
      for (let x = a + 0.17; x < b - 0.15; x += r.range(0.26, 0.36)) {
        const kind = r.weighted(k2);
        if (cloth(kind).len > yR - L.riser - 0.6) continue;
        const mw = new THREE.Matrix4().copy(mOpen).multiply(_t.makeTranslation(x, yR, zR + (kind === 'pack' ? 0.08 : 0.03)));
        mw.multiply(_t.makeRotationY(r.range(-0.25, 0.25))).multiply(_t.makeRotationZ(r.range(-0.05, 0.05)));
        hangItem(kit, kind, mw, r, 0.6);
        n++;
      }
    }
  }
  // a price board on the pier (fluorescent card on a dark board), now and then (its card
  // given out with the window's, so it does not repeat along the street either)
  if (al && al.pier >= 0) {
    const side = r.chance(0.5) ? 1 : -1;
    const gy = plan.groundAt(o.uc + side * (o.w / 2 + 0.4));
    let span = pier(plan, o, side, gy);
    if (span && n) {
      // beside the hung goods: only on a wide pier, at its far end
      span = span[1] - span[0] > 1.5 ? span : null;
    }
    if (span) {
      const cell = dressCell('prices', al.pier);
      const h = r.range(0.32, 0.45), w = h * cell.aspect;
      if (w + 0.2 < span[1] - span[0]) {
        const uc = side > 0 ? span[1] - w / 2 - 0.12 : span[0] + w / 2 + 0.12;
        const yc = gy + r.range(1.55, 1.85);
        const mb = new THREE.Matrix4().copy(frame.matrix).multiply(_t.makeTranslation(uc, yc, inRustic(plan, yc) ? 0.1 : 0.06));
        const tb = new Tpl();
        tb.box(-w / 2 - 0.02, -h / 2 - 0.02, 0, w / 2 + 0.02, h / 2 + 0.02, 0.018, 1 | 4 | 8 | 16 | 32, 0.85, 0.95);
        const bc = lin(r.pick([0x1d1d1f, 0xe8e4da, 0x6b4a2a]));
        kit.get('board').add(tb.bake(), mb, bc[0], bc[1], bc[2]);
        const tt = new Tpl();
        cardTpl(tt, cell, 0, 0, h, 0.0195);
        kit.get('signText').add(tt.bake(), mb, 1, 1, 1, GLOW);
        n++;
      }
    }
  }
  return n;
}
