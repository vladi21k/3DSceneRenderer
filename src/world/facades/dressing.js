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
import { dressCell, cardTpl, sheetTpl, POSTER_INFO, N_PRICES, N_BANNERS } from './signs.js';
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
export function dressWindow(kit, o, L, m, type, far = false, al = null) {
  if (!al) return;
  const r = RNG.from(o.id, 'dress');
  const t = new Tpl();
  const yG = L.yT - 0.05, y0 = L.riser + 0.1;
  const zG = far ? 0.05 : -0.016;
  const ps = panes(L);
  const used = [];
  const free = (x0, x1, a, b) => !used.some((u) => x0 < u[1] && x1 > u[0] && a < u[3] && b > u[2]);
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

// ------------------------------------------------------------------ goods hung outside
// Cloth cards in the awning batch: hook at the local origin, hanging down -y, facing +z.
const CLOTH = [0x1d2a44, 0xe8e4da, 0x8a8a86, 0x3a2a22, 0xa8231e, 0x2c6a3a, 0xc9b08a, 0x1c1c1e, 0x7fb2d8, 0xd8879a, 0xe2b630, 0x6b3a72, 0xd0672a];
const tplCache = new TplCache(64);

/**
 * Cloth surface over the bilinear patch (a, b, c, d: CCW corners in xy), nx × ny cells:
 * filled out by the body it was cut for (z bulge, most at x = 0) and hanging in soft
 * vertical folds; normals from the analytic surface.
 */
function patch(t, a, b, c, d, nx, ny, bulge, hw, shade = 1) {
  const z = (x, y) => Math.max(0, bulge * (1 - (x * x) / (hw * hw))) + 0.006 * Math.sin(x * 37 + 1.3) * Math.min(1, -y * 2.5);
  const base = t.count;
  for (let j = 0; j <= ny; j++) {
    const v = j / ny;
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      const x = (a[0] * (1 - u) + b[0] * u) * (1 - v) + (d[0] * (1 - u) + c[0] * u) * v;
      const y = (a[1] * (1 - u) + b[1] * u) * (1 - v) + (d[1] * (1 - u) + c[1] * u) * v;
      const e = 0.004, zz = z(x, y);
      const gx = (z(x + e, y) - z(x - e, y)) / (2 * e), gy = (z(x, y + e) - z(x, y - e)) / (2 * e);
      const l = Math.hypot(gx, gy, 1);
      // folds and the sides falling away read darker
      const sh = shade * (0.8 + 0.2 / l) * (0.93 + 0.07 * Math.cos(x * 37 + 1.3));
      t.v(x, y, zz, -gx / l, -gy / l, 1 / l, x, y, sh);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = base + j * (nx + 1) + i;
      t.ix6(k, k + 1, k + nx + 2, k, k + nx + 2, k + nx + 1);
    }
  }
}

function cloth(kind) {
  return tplCache.get(kind, () => {
    const t = new Tpl();
    let len = 0.7;
    if (kind === 'tee') {
      patch(t, [-0.2, -0.68], [0.2, -0.68], [0.2, -0.06], [-0.2, -0.06], 6, 3, 0.05, 0.22);
      patch(t, [-0.36, -0.22], [-0.2, -0.3], [-0.2, -0.06], [-0.29, -0.07], 1, 1, 0, 1, 0.9);
      patch(t, [0.2, -0.3], [0.36, -0.22], [0.29, -0.07], [0.2, -0.06], 1, 1, 0, 1, 0.9);
      len = 0.68;
    } else if (kind === 'dress') {
      patch(t, [-0.14, -0.4], [0.14, -0.4], [0.16, -0.05], [-0.16, -0.05], 4, 2, 0.045, 0.17);
      patch(t, [-0.32, -1.02], [0.32, -1.02], [0.14, -0.4], [-0.14, -0.4], 8, 3, 0.05, 0.33);
      len = 1.02;
    } else if (kind === 'trousers') {
      patch(t, [-0.2, -0.14], [0.2, -0.14], [0.2, -0.04], [-0.2, -0.04], 4, 1, 0.03, 0.21, 0.85);
      patch(t, [-0.21, -0.98], [-0.03, -0.98], [0.0, -0.14], [-0.2, -0.14], 3, 3, 0.0, 1);
      patch(t, [0.03, -0.98], [0.21, -0.98], [0.2, -0.14], [0.0, -0.14], 3, 3, 0.0, 1);
      len = 0.98;
    } else if (kind === 'scarf') {
      patch(t, [-0.12, -1.1], [0.12, -1.1], [0.12, -0.04], [-0.12, -0.04], 3, 4, 0.0, 1);
      len = 1.1;
    } else {
      // bag with its handle loop over the hook
      patch(t, [-0.19, -0.48], [0.19, -0.48], [0.17, -0.16], [-0.17, -0.16], 4, 2, 0.06, 0.2);
      patch(t, [-0.12, -0.16], [-0.09, -0.16], [-0.01, -0.02], [-0.04, -0.02], 1, 1, 0, 1, 0.7);
      patch(t, [0.09, -0.16], [0.12, -0.16], [0.04, -0.02], [0.01, -0.02], 1, 1, 0, 1, 0.7);
      len = 0.48;
    }
    // darker towards the hem's shadow side
    t.shadeBy((x, y) => 1 - 0.06 * Math.min(1, -y / len));
    const b = t.bake();
    b.len = len;
    return b;
  });
}
const HOOK = (() => {
  const t = new Tpl();
  t.box(-0.006, -0.01, -0.07, 0.006, 0.008, 0.0, 1 | 4 | 8 | 16 | 32, 0.9, 1);
  t.box(-0.006, -0.01, -0.012, 0.006, 0.05, 0.0, 1 | 4 | 8 | 32, 0.9, 1);
  return t.bake();
})();

const KINDS = {
  clothing: [['tee', 0.35], ['dress', 0.25], ['trousers', 0.2], ['scarf', 0.2]],
  shoes: [['bag', 0.8], ['scarf', 0.2]],
  general: [['bag', 0.35], ['scarf', 0.35], ['tee', 0.3]],
};

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
export function hangGoods(kit, ctx, o, type, al = null) {
  const kinds = KINDS[type];
  const r = RNG.from(o.id, 'hang');
  const plan = ctx.plan, frame = ctx.frame;
  let n = 0;
  if (kinds && r.chance((KEEN[type] || KEEN.general)[2])) {
    const sides = r.chance(0.5) ? [1, -1] : [-1, 1];
    const both = r.chance(0.35);
    for (const side of sides) {
      const gy = plan.groundAt(o.uc + side * (o.w / 2 + 0.4));
      const span = pier(plan, o, side, gy);
      if (!span) continue;
      const [u0, u1] = span;
      // one or two columns of hooks from the jamb outwards
      const cols = u1 - u0 > 1.05 && r.chance(0.6) ? 2 : 1;
      for (let c = 0; c < cols; c++) {
        const uc = side > 0 ? u0 + 0.27 + c * 0.52 : u1 - 0.27 - c * 0.52;
        let top = gy + r.range(2.35, 2.55);
        for (let row = 0; row < 2; row++) {
          const kind = r.weighted(kinds);
          const tp = cloth(kind);
          if (top - tp.len < gy + 0.55) break;
          const len = tp.len;
          // a bundle on the hook: the same piece in two or three colours, fanned out
          const nb = kind === 'bag' ? 1 : r.int(1, 3);
          // (rusticated stone: hooks on the bosses' faces)
          const z = 0.1 + (inRustic(plan, top) ? 0.03 : 0);
          for (let q = nb - 1; q >= 0; q--) {
            const c1 = lin(r.pick(CLOTH)), c2 = lin(r.pick(CLOTH));
            const stripe = (kind === 'tee' || kind === 'scarf') && r.chance(0.3) ? r.range(0.03, 0.07) : 0;
            const mw = new THREE.Matrix4().copy(frame.matrix).multiply(_t.makeTranslation(uc + (q - (nb - 1) / 2) * 0.05 + r.range(-0.02, 0.02), top - q * 0.03, z + q * 0.035));
            // a slight swing off the wall at the hem, a little twist
            mw.multiply(_t.makeRotationX(-r.range(0.03, 0.09))).multiply(_t.makeRotationZ(r.range(-0.06, 0.06)));
            kit.get('awning').add(tp, mw, c1[0], c1[1], c1[2], {
              aStripe: [c2[0], c2[1], c2[2], stripe],
              aFlex: (k, v, a, j) => { a[j] = Math.min(1, Math.max(0, -v[k * VS + 1] / len)) * 0.9; },
            });
          }
          kit.get('metal').add(HOOK, new THREE.Matrix4().copy(frame.matrix).multiply(_t.makeTranslation(uc, top + 0.01, z)), 0.06, 0.06, 0.062);
          n++;
          top -= len + 0.12;
          if (kind === 'dress' || kind === 'trousers' || kind === 'scarf') break;
        }
      }
      if (n && !both) break;
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
