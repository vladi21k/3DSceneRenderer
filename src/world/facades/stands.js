// Goods stands on the pavement in front of the shops that put their trade out: stepped
// crates of fruit and vegetables (a greengrocer, a juice bar's citrus), tiered buckets of
// flowers, a rail of clothes, a newspaper and magazine rack, bakery trays on a trestle,
// rolled-down sacks of nuts and spices, wire bins of sale goods, a shoe rack and a cart of
// books. Planned once at init (deterministic): most of the shops whose trade suits it put
// something out, against the facade (from 0.25 m to at most ~1.25 m out, so the walking
// band stays clear), in front of a display window and never across a doorway, outside café
// terraces, cross-street mouths and anything already standing on the pavement. Every
// footprint is registered with layout.addObstacles so the crowd walks round it (the
// furniture's A-boards keep off it too). Built with the lot's chunk from cached templates:
// in full in near chunks, as a couple of coloured blocks in far ones.
//
// Local frame of a stand: x along the facade (u), y up, z out of the wall (w), origin at
// the middle of its footprint on the paving; a shear makes it follow the paving's fall.
import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { Tpl, TplCache, VS, lin } from './geo.js';
import { cloth, hangerTpl } from './dressing.js';
import { printCell } from './signs.js';
import { shopDecision } from './shops.js';

const OUT0 = 0.25;                    // gap between the wall face and the stand
const _m = new THREE.Matrix4(), _s = new THREE.Matrix4(), _t = new THREE.Matrix4(), _r = new THREE.Matrix4();
const _p = new THREE.Vector3();
const cache = new TplCache(640);

// ------------------------------------------------------------------ catalogue
// produce: [colour, radius, x elongation, z elongation, height squash, second hue (a share
// of the pile riper or greener), stem (0 none, 1 green calyx, 2 brown stalk), dimple depth]
const PRODUCE = {
  oranges: [0xd8701a, 0.04, 1, 1, 0.95, 0xe8902a, 0, 0.12], lemons: [0xd8c22a, 0.032, 1.3, 1, 0.9, 0xc0c43a, 0, 0.05], tomatoes: [0xb8241a, 0.036, 1, 1, 0.82, 0xd8461a, 1, 0.18],
  apples: [0x9a1e1c, 0.038, 1, 1, 0.9, 0xb8502a, 2, 0.22], greenApples: [0x8aa83a, 0.038, 1, 1, 0.9, 0xb8b83a, 2, 0.22], cucumbers: [0x2f4a1e, 0.022, 4.2, 1, 1, 0x3e5a24, 0, 0],
  aubergines: [0x2a1228, 0.04, 2.2, 1, 0.9, 0x3a1a3a, 1, 0.05], peppers: [0xa81c16, 0.042, 1, 1, 1, 0xc8301a, 1, 0.2], yellowPeppers: [0xd8a81a, 0.042, 1, 1, 1, 0xe0b82a, 1, 0.2],
  potatoes: [0x9a7448, 0.034, 1.25, 1, 0.8, 0x8a6a40, 0, 0], onions: [0xb8843a, 0.035, 1, 1, 0.9, 0xa86a2a, 2, 0.1], pomegranates: [0x7a1a1e, 0.046, 1, 1, 0.92, 0x9a2a22, 2, 0.08],
  grapes: [0x3e1830, 0.014, 1, 1, 1, 0, 0, 0], carrots: [0xd0601a, 0.017, 4.5, 1, 1, 0xe07a2a, 1, 0], grapefruit: [0xe0943a, 0.052, 1, 1, 0.95, 0xe8a85a, 0, 0.08],
  greens: [0x3a6a24, 0.05, 1.4, 1, 0.45, 0, 0, 0], avocados: [0x2e3a1a, 0.038, 1.3, 1, 0.95, 0x3a4a22, 2, 0.05], bananas: [0xd8b830, 0.03, 3.2, 1.2, 0.6, 0xc8c040, 0, 0],
};
// (bunches and leaves stay a heap: too small or too many to lie one by one)
const HEAPED = new Set(['grapes', 'greens']);
const GROCER = ['oranges', 'lemons', 'tomatoes', 'apples', 'greenApples', 'cucumbers', 'aubergines', 'peppers', 'yellowPeppers', 'potatoes', 'onions', 'pomegranates', 'grapes', 'carrots', 'greens', 'avocados', 'bananas'];
const CITRUS = ['oranges', 'oranges', 'lemons', 'grapefruit', 'pomegranates', 'oranges'];
const NUTS = [[0x7a4a22, 0.011, 1.6], [0xb4a274, 0.012, 1.3], [0x2e2c28, 0.007, 1.8], [0xb08a52, 0.011, 1.5], [0x6a3418, 0.012, 1.1], [0xc8b48a, 0.009, 1.4]];
const SPICES = [0xa82a14, 0xc8901a, 0x7a5a30, 0x5a6a2e, 0x8a2a1a, 0xb87a2a];
const FLOWERS = [0xb81c2a, 0xe87aa0, 0xf2eee4, 0xe8c22a, 0xe0662a, 0x6a3a8a, 0xf0d8c8, 0xc83a5a, 0xd8a8d0, 0x3a5aa8];
const CLOTH = [0x1d2a44, 0xe8e4da, 0x8a8a86, 0x3a2a22, 0xa8231e, 0x2c6a3a, 0xc9b08a, 0x1c1c1e, 0x7fb2d8, 0xd8879a, 0xe2b630, 0x6b3a72, 0xd0672a, 0x2a5a8a,
  0xc8231c, 0x1f4fa0, 0xe86a8a, 0x2a9a8a, 0xf2d24a, 0xe0641a];
const CRATES = [[0x2a5a32, 0.3], [0x1d1d1f, 0.25], [0x1f4a7a, 0.15], [0x8a2a22, 0.08], [0xb8956a, 0.22]];   // plastic greens, blacks, blues, reds; pine
const BIN_GOODS = {
  toys: [0xc8231c, 0x1f5fa8, 0xe8b820, 0x2a7a3a, 0xe87aa0, 0xf2efe6, 0xe0662a],
  sweets: [0xe0662a, 0xc8231c, 0xe8c22a, 0xe87aa0, 0x6a3a8a, 0x2a7a3a, 0xf2efe6],
  shoes: [0x1c1a18, 0x3a2214, 0xe8e6e0, 0x5a3418, 0x8a8a86, 0x1d2a44, 0xa8231e],
  general: [0x1f5fa8, 0xe8e4da, 0x1c1c1e, 0xc8231c, 0x8a8a86, 0x2a7a3a, 0xe8b820],
};

/** What a shop of trade `type` (narrower trade `sub`) puts out on the pavement, or null. */
function standKind(type, sub, r) {
  switch (type) {
    case 'flowers': return r.chance(0.85) ? 'flowers' : null;
    case 'clothing': return r.chance(0.5) ? 'clothes' : null;
    case 'shoes': return r.chance(0.45) ? (r.chance(0.55) ? 'shoes' : 'bins') : null;
    case 'books': return r.chance(0.45) ? (r.chance(0.55) ? 'books' : 'news') : null;
    case 'cafe': return sub === 'bakery' ? (r.chance(0.75) ? 'bakery' : null) : sub === 'juice' ? (r.chance(0.65) ? 'citrus' : null) : null;
    case 'general':
      if (sub === 'grocery') return r.chance(0.92) ? 'produce' : null;
      if (sub === 'nuts') return r.chance(0.9) ? 'sacks' : null;
      if (sub === 'kiosk') return r.chance(0.75) ? 'news' : null;
      if (sub === 'sweets' || sub === 'toys') return r.chance(0.4) ? 'bins' : null;
      return r.chance(0.2) ? 'bins' : null;
    default: return null;
  }
}

/** Footprint [along the facade, out from it] of a stand of `kind`. */
function footprint(kind, r) {
  switch (kind) {
    case 'produce': { const n = r.chance(0.5) ? 3 : 2; return { W: n * 0.52 + 0.08, D: 0.86, n }; }
    case 'citrus': return { W: 2 * 0.52 + 0.08, D: 0.86, n: 2 };
    case 'flowers': { const n = r.int(3, 4); return { W: n * 0.34 + 0.06, D: 0.84, n }; }
    case 'clothes': return { W: r.range(1.1, 1.45), D: 0.56 };
    case 'shoes': return { W: r.range(0.8, 1.0), D: 0.42 };
    case 'books': return { W: r.range(0.95, 1.15), D: 0.58 };
    case 'news': return { W: r.range(0.72, 0.9), D: 0.46 };
    case 'bakery': return { W: r.range(1.1, 1.3), D: 0.62 };
    case 'sacks': { const n = r.int(4, 5); return { W: n * 0.4 + 0.04, D: 0.84, n }; }
    default: return { W: r.range(0.9, 1.15), D: 0.62 };
  }
}

// ------------------------------------------------------------------ planning
/**
 * Plan the stands of every main-street lot. info(lot) gives the facades' decisions for
 * the lot's street face ({types, subs, terrace, umbrellas, cafeAwning} as frontInfo);
 * plan(lot) its facade plan. Returns {byLot: Map(lot id → [stand]), obstacles}.
 */
export function planStands(app, info, planOf) {
  const { layout, route } = app;
  const byLot = new Map(), obstacles = [];
  const inv = new THREE.Matrix4();
  for (const lot of layout.lots) {
    if (lot.sideStreet || !lot.frame) continue;
    let plan, fi;
    try { plan = planOf(lot); fi = info(lot); } catch (e) { continue; }
    if (!plan || !fi) continue;
    const f = lot.frame;
    const ground = plan.openings.filter((x) => x.floor === 0).sort((a, b) => a.uc - b.uc);
    // the doorways of the front, which no stand may cross
    const doors = [];
    for (const o of ground) {
      if (o.kind === 'door') { doors.push([o.uc - o.w / 2 - 0.35, o.uc + o.w / 2 + 0.35]); continue; }
      const L = shopDecision(plan, o);
      const c = o.uc + L.dx;
      doors.push([c - L.doorW / 2 - 0.3, c + L.doorW / 2 + 0.3]);
    }
    inv.copy(f.matrix).invert();
    for (const o of ground) {
      if (o.kind !== 'shop') continue;
      const type = fi.types.get(o.id), sub = fi.subs.get(o.id) ?? null;
      if (!type || o === fi.terrace) continue;
      const r = RNG.from(o.id, 'stand');
      const kind = standKind(type, sub, r);
      if (!kind) continue;
      const L = shopDecision(plan, o);
      if (L.shutterDown > 0.7) continue;
      const fp = footprint(kind, r);
      // in front of the wider display window, sliding along the front until it clears
      // every doorway (it may run onto the pier, not past the next opening)
      const dc = o.uc + L.dx;
      const left = [o.uc - L.hwI, dc - L.doorW / 2], right = [dc + L.doorW / 2, o.uc + L.hwI];
      const pane = right[1] - right[0] >= left[1] - left[0] ? right : left;
      let uc = (pane[0] + pane[1]) / 2;
      const lo = Math.max(0.35, o.uc - o.w / 2 - 0.55) + fp.W / 2, hi = Math.min(f.width - 0.35, o.uc + o.w / 2 + 0.55) - fp.W / 2;
      if (hi < lo) continue;
      uc = Math.min(hi, Math.max(lo, uc));
      const clash = (c) => doors.some(([a, b]) => c - fp.W / 2 < b && c + fp.W / 2 > a);
      if (clash(uc)) {
        // push it away from the door it touches, towards the pane's outer end
        const dir = pane === right ? 1 : -1;
        let ok = false;
        for (let k = 1; k <= 12 && !ok; k++) { const c = uc + dir * k * 0.1; if (c >= lo && c <= hi && !clash(c)) { uc = c; ok = true; } }
        if (!ok) continue;
      }
      const wc = OUT0 + fp.D / 2;
      // its footprint on the street: corners → route (s, d)
      const corners = [];
      for (const [du, dw] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        _p.copy(f.origin).addScaledVector(f.uDir, uc + du * fp.W / 2).addScaledVector(f.nDir, wc + dw * fp.D / 2);
        const frac = Math.min(1, Math.max(0, (uc + du * fp.W / 2) / f.width));
        const sGuess = lot.side > 0 ? lot.s1 - frac * (lot.s1 - lot.s0) : lot.s0 + frac * (lot.s1 - lot.s0);
        const pr = route.project(_p.x, _p.z, sGuess, 3);
        corners.push({ s: pr.s, d: pr.d, u: uc + du * fp.W / 2, w: wc + dw * fp.D / 2 });
      }
      const sMid = route.wrap((corners[0].s + corners[3].s) / 2);
      if (layout.isInCrossStreet(sMid, lot.side, 2.5)) continue;
      let s0 = Infinity, s1 = -Infinity, d0 = Infinity, d1 = -Infinity;
      for (const c of corners) {
        const ds = route.delta(sMid, c.s);
        s0 = Math.min(s0, ds); s1 = Math.max(s1, ds); d0 = Math.min(d0, c.d); d1 = Math.max(d1, c.d);
      }
      const rect = { kind: 'rect', s0: route.wrap(sMid + s0 - 0.08), s1: route.wrap(sMid + s1 + 0.08), d0: d0 - 0.08, d1: d1 + 0.08, stand: kind, lot: lot.id };
      if (blocked(app, sMid, s0, s1, d0, d1, obstacles)) continue;
      // the paving under it: the building's ground line against the wall, the street's
      // surface further out (as a plane through the four corners, in the frame's v)
      const v = corners.map((c) => {
        const t = Math.min(1, Math.max(0, (c.w - 0.5) / 0.4));
        const yW = route.toWorld(c.s, c.d, 0, _p).y - f.floorRef;
        return plan.groundAt(c.u) * (1 - t) + yW * t;
      });
      const g = (v[0] + v[1] + v[2] + v[3]) / 4;
      const gU = ((v[1] + v[3]) - (v[0] + v[2])) / (2 * fp.W), gW = ((v[2] + v[3]) - (v[0] + v[1])) / (2 * fp.D);
      const st = { kind, type, sub, oId: o.id, uc, wc, W: fp.W, D: fp.D, n: fp.n || 0, g, gU, gW, seed: r.int(0, 1 << 30), rect };
      if (!byLot.has(lot.id)) byLot.set(lot.id, []);
      byLot.get(lot.id).push(st);
      obstacles.push(rect);
    }
  }
  return { byLot, obstacles };
}

/** Whether a footprint (s offsets s0..s1 about sMid, d0..d1) touches anything on the pavement. */
function blocked(app, sMid, s0, s1, d0, d1, own) {
  const { layout, route } = app;
  const M = 0.25;
  const hit = (o) => {
    if (o.kind === 'circle') {
      const ds = route.delta(sMid, o.s);
      const cs = Math.min(s1, Math.max(s0, ds)), cd = Math.min(d1, Math.max(d0, o.d));
      const ex = ds - cs, ed = o.d - cd, rr = o.r + M;
      return ex * ex + ed * ed < rr * rr;
    }
    const a = route.delta(sMid, o.s0), b = route.delta(sMid, o.s1);
    return a < s1 + M && b > s0 - M && o.d0 < d1 + M && o.d1 > d0 - M;
  };
  for (const o of layout.obstaclesNear(sMid, 6)) if (hit(o)) return true;
  for (const o of own) if (Math.abs(route.delta(sMid, o.s0)) < 8 && hit(o)) return true;
  return false;
}

// ------------------------------------------------------------------ geometry helpers
/**
 * Heap of round goods filling a W × D tray from y0 up: items jittered on a packed lattice
 * (radius r, elongated ex along x / ez along z, squashed sy), mounded in the middle.
 * A height field (cell ~0.4 r) whose shade carries each item's ripeness and the dark
 * gaps between items. One template, one colour.
 */
function heap(t, x0, z0, W, D, y0, r, ex, ez, sy, mound, seed, q, round = false, gap = 0.5) {
  const rng = new RNG(seed);
  const items = [];
  const sx = r * ex * 1.85, sz = r * ez * 1.75;
  const nx = Math.max(1, Math.round(W / sx)), nz = Math.max(1, Math.round(D / sz));
  for (let layer = 0; layer < 2; layer++) {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        if (layer && rng.chance(0.55)) continue;
        const x = x0 + (i + 0.5 + (j % 2) * 0.35 + (layer ? 0.5 : 0) + rng.range(-0.18, 0.18)) * (W / nx);
        const z = z0 + (j + 0.5 + (layer ? 0.5 : 0) + rng.range(-0.18, 0.18)) * (D / nz);
        if (x < x0 + r * 0.6 || x > x0 + W - r * 0.6 || z < z0 + r * 0.6 || z > z0 + D - r * 0.6) continue;
        const cx = (x - x0) / W - 0.5, cz = (z - z0) / D - 0.5;
        if (round && cx * cx + cz * cz > 0.2) continue;
        const m = mound * Math.max(0, 1 - 2.6 * (cx * cx + cz * cz));
        const a = rng.range(0, 3.14), rx = r * ex * rng.range(0.9, 1.1), rz = r * ez * rng.range(0.9, 1.1);
        items.push({ x, z, y: y0 + r * sy * (layer ? 1.05 : 0.15) + m + rng.range(-0.15, 0.15) * r, rx, rz, ry: r * sy, k: rng.range(0.78, 1.16), c: Math.cos(a), s: Math.sin(a), b: Math.max(rx, rz) });
      }
    }
  }
  const res = Math.max(0.012, r * (q >= 0.5 ? 0.6 : 1.2));
  const gx = Math.max(2, Math.ceil(W / res)), gz = Math.max(2, Math.ceil(D / res));
  const H = new Float32Array((gx + 1) * (gz + 1)), S = new Float32Array((gx + 1) * (gz + 1));
  const floor = y0 - r * 0.2;
  for (let j = 0; j <= gz; j++) {
    for (let i = 0; i <= gx; i++) {
      const x = x0 + (i / gx) * W, z = z0 + (j / gz) * D;
      let h = floor, s = 0.3;
      for (let n = 0; n < items.length; n++) {
        const it = items[n];
        // item axes turned by its angle in plan (a cheap reject first)
        const dx0 = x - it.x, dz0 = z - it.z;
        if (dx0 > it.b || dx0 < -it.b || dz0 > it.b || dz0 < -it.b) continue;
        const dx = (dx0 * it.c + dz0 * it.s) / it.rx, dz = (-dx0 * it.s + dz0 * it.c) / it.rz;
        const q2 = dx * dx + dz * dz;
        if (q2 >= 1) continue;
        const hh = it.y + it.ry * Math.sqrt(1 - q2);
        if (hh > h) { h = hh; s = it.k * (gap + (1 - gap) * Math.sqrt(Math.max(0, 1 - q2))); }
      }
      // the rim of the tray holds everything in; a round heap tapers to its base at the edge
      const e = Math.min(i, gx - i, j, gz - j);
      if (e === 0) { h = Math.min(h, y0 + r * 0.4); s *= 0.6; }
      if (round) {
        const cx = i / gx - 0.5, cz = j / gz - 0.5, rn = Math.sqrt(cx * cx + cz * cz);
        if (rn > 0.4) { h = Math.min(h, y0 + Math.max(0, (h - y0) * (0.5 - rn) / 0.1)); s *= 0.8; }
      }
      H[j * (gx + 1) + i] = h; S[j * (gx + 1) + i] = s;
    }
  }
  const base = t.count;
  for (let j = 0; j <= gz; j++) {
    for (let i = 0; i <= gx; i++) {
      const k = j * (gx + 1) + i;
      const hL = H[j * (gx + 1) + Math.max(0, i - 1)], hR = H[j * (gx + 1) + Math.min(gx, i + 1)];
      const hD = H[Math.max(0, j - 1) * (gx + 1) + i], hU = H[Math.min(gz, j + 1) * (gx + 1) + i];
      const ddx = (hR - hL) / ((Math.min(gx, i + 1) - Math.max(0, i - 1)) * W / gx), ddz = (hU - hD) / ((Math.min(gz, j + 1) - Math.max(0, j - 1)) * D / gz);
      const l = Math.sqrt(ddx * ddx + ddz * ddz + 1);
      const x = x0 + (i / gx) * W, z = z0 + (j / gz) * D;
      t.v(x, H[k], z, -ddx / l, 1 / l, -ddz / l, x, z, S[k]);
    }
  }
  // (round heaps: only the cells inside the inscribed ellipse)
  const out = (i, j) => { const cx = i / gx - 0.5, cz = j / gz - 0.5; return cx * cx + cz * cz > 0.25; };
  for (let j = 0; j < gz; j++) {
    for (let i = 0; i < gx; i++) {
      if (round && (out(i, j) || out(i + 1, j) || out(i, j + 1) || out(i + 1, j + 1))) continue;
      const a = base + j * (gx + 1) + i, b = a + 1, c = a + gx + 1, d = c + 1;
      t.ix6(a, c, b, b, c, d);
    }
  }
}

/** Open-topped crate W × D × H on y = 0 (walls 1.4 cm, a rib round the middle, a darker inside). */
function crate(t, W, D, H, cx = 0, cz = 0, y = 0) {
  const T = 0.014, x0 = cx - W / 2, x1 = cx + W / 2, z0 = cz - D / 2, z1 = cz + D / 2;
  t.piece(0.04);
  t.box(x0, y, z0, x1, y + 0.012, z1, 16, 0.6, 0.6);                                   // bottom
  t.box(x0, y, z1 - T, x1, y + H, z1, 1 | 4 | 8 | 32, 0.92, 1);                         // front
  t.box(x0, y, z0, x1, y + H, z0 + T, 2 | 4 | 8 | 32, 0.85, 0.95);                      // back
  t.box(x0, y, z0 + T, x0 + T, y + H, z1 - T, 4 | 32, 0.88, 0.98);                      // left
  t.box(x1 - T, y, z0 + T, x1, y + H, z1 - T, 8 | 32, 0.88, 0.98);                      // right
  // inside faces, in the crate's own shade
  t.q4(x0 + T, y + 0.012, z1 - T, x1 - T, y + 0.012, z1 - T, x1 - T, y + H, z1 - T, x0 + T, y + H, z1 - T, 0.35, 0.6);
  t.q4(x1 - T, y + 0.012, z0 + T, x0 + T, y + 0.012, z0 + T, x0 + T, y + H, z0 + T, x1 - T, y + H, z0 + T, 0.35, 0.6);
  // a moulded rib round the outside and the hand holes as dark slots
  t.box(x0 - 0.004, y + H * 0.45, z1, x1 + 0.004, y + H * 0.55, z1 + 0.005, 1 | 4 | 8 | 16 | 32, 0.8, 0.95);
  t.box(cx - W * 0.16, y + H - 0.06, z1 + 0.0005, cx + W * 0.16, y + H - 0.03, z1 + 0.001, 1, 0.15, 0.15);
}

/**
 * Smooth vertical frustum (n sides) of radius r0 at y0 to r1 at y1 (radial normals, so a
 * bucket or a sack reads round), bulging out by `bulge` at mid height over `rows` rows.
 */
function cyl(t, cx, cz, r0, r1, y0, y1, n, shade = 1, shadeTop = shade, bulge = 0, rows = 1) {
  const base = t.count;
  const slope = (r0 - r1) / Math.max(1e-3, y1 - y0);
  for (let j = 0; j <= rows; j++) {
    const f = j / rows, y = y0 + (y1 - y0) * f, rr = r0 + (r1 - r0) * f + bulge * Math.sin(Math.PI * f);
    const ny0 = slope - bulge * Math.PI * Math.cos(Math.PI * f) / Math.max(1e-3, y1 - y0);
    const nl = Math.sqrt(1 + ny0 * ny0);
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      t.v(cx + c * rr, y, cz + sn * rr, c / nl, ny0 / nl, sn / nl, a * rr, y, shade + (shadeTop - shade) * f);
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let k = 0; k < n; k++) {
      const a = base + j * (n + 1) + k, b = a + 1, c = a + n + 1, d = c + 1;
      t.ix6(a, c, b, b, c, d);
    }
  }
}
/** Thin square bar between two points (metal frames). */
function bar(t, a, b, s) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const L = Math.hypot(dx, dy, dz) || 1, d = [dx / L, dy / L, dz / L];
  const rr = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let sx = [d[1] * rr[2] - d[2] * rr[1], d[2] * rr[0] - d[0] * rr[2], d[0] * rr[1] - d[1] * rr[0]];
  const sl = Math.hypot(...sx); sx = sx.map((x) => x / sl);
  const px = [d[1] * sx[2] - d[2] * sx[1], d[2] * sx[0] - d[0] * sx[2], d[0] * sx[1] - d[1] * sx[0]];
  const h = s / 2, c = (p, u, v) => [p[0] + sx[0] * u + px[0] * v, p[1] + sx[1] * u + px[1] * v, p[2] + sx[2] * u + px[2] * v];
  const cs = [[-h, -h], [h, -h], [h, h], [-h, h]];
  for (let k = 0; k < 4; k++) {
    const [u0, v0] = cs[k], [u1, v1] = cs[(k + 1) % 4];
    t.quad(c(a, u0, v0), c(b, u0, v0), c(b, u1, v1), c(a, u1, v1), 0.9);
  }
}
/** A card (print cell) in the text batch, facing +z at z, centred at (x, y), tilted back by tilt. */
function card(t, cell, x, y, z, h, tilt = 0) {
  const w = h * cell.aspect, c = Math.cos(tilt), s = Math.sin(tilt), b = t.count;
  const P = (dx, dy) => [x + dx, y + dy * c, z - dy * s];
  const n = [0, s, c];
  for (const [dx, dy, u, v] of [[-w / 2, -h / 2, cell.u0, cell.v0], [w / 2, -h / 2, cell.u1, cell.v0], [w / 2, h / 2, cell.u1, cell.v1], [-w / 2, h / 2, cell.u0, cell.v1]]) {
    const p = P(dx, dy); t.v(p[0], p[1], p[2], n[0], n[1], n[2], u, v);
  }
  t.ix6(b, b + 1, b + 2, b, b + 2, b + 3);
}

/**
 * One fruit: an ellipsoid of radii (rx, ry, rz) at (cx, cy, cz) turned by ang about y (and
 * tipped by tip about x), nLon × nLat facets, its top pulled into a stem dimple of depth
 * `dimple` (× ry); shaded darker into the dimple and towards its underside, where it rests
 * on the others. UVs in metres.
 */
function fruit(t, cx, cy, cz, rx, ry, rz, ang, tip, nLon, nLat, shade, dimple) {
  const base = t.count, ca = Math.cos(ang), sa = Math.sin(ang), ct = Math.cos(tip), st = Math.sin(tip);
  for (let j = 0; j <= nLat; j++) {
    const th = (j / nLat) * Math.PI, s0 = Math.sin(th), c0 = Math.cos(th);
    // (the dimple: the cap's first ring pulled down, the pole further)
    const dip = dimple * (j === 0 ? 1 : j === 1 ? 0.3 : 0);
    for (let i = 0; i <= nLon; i++) {
      const ph = (i / nLon) * Math.PI * 2, x = Math.cos(ph) * s0, z = Math.sin(ph) * s0, y = c0;
      const px = x * rx, py = (y - dip) * ry, pz = z * rz;
      let nx = x / rx, ny = y / ry, nz = z / rz;
      if (j === 1 && dimple > 0.1) ny *= 0.6;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      // tip about x, then turn about y
      const py2 = py * ct - pz * st, pz2 = py * st + pz * ct, ny2 = ny * ct - nz * st, nz2 = ny * st + nz * ct;
      const wx = px * ca + pz2 * sa, wz = -px * sa + pz2 * ca, nwx = nx * ca + nz2 * sa, nwz = -nx * sa + nz2 * ca;
      const sh = shade * (j === 0 ? 0.55 : j === 1 && dimple > 0.1 ? 0.8 : 1) * (0.62 + 0.38 * (0.5 + 0.5 * c0));
      t.v(cx + wx, cy + py2, cz + wz, nwx, ny2, nwz, ph * rx, th * ry, sh);
    }
  }
  for (let j = 0; j < nLat; j++) {
    for (let i = 0; i < nLon; i++) {
      const a = base + j * (nLon + 1) + i, b = a + 1, c = a + nLon + 1, d = c + 1;
      t.ix6(a, b, c, b, d, c);
    }
  }
}

/**
 * A crate's worth of fruit heaped above its rim: items of produce `name` packed in layers
 * on a jittered lattice inside the W × D tray (the pile's bed at y = 0), mounded in the middle, each its own size, turn, tip and shade. Returns
 * {main, alt, stems}: the pile in its two hues (alt: about a fifth of the items) and the
 * stalks or calyces (or null), as baked templates.
 */
function fruitPile(name, W, D, seed, q) {
  const [, rad, ex, ez, sy, alt, stem, dimple] = PRODUCE[name];
  const r = new RNG(seed);
  const tm = new Tpl(), ta = new Tpl(), ts = stem && q >= 0.5 ? new Tpl() : null;
  const nLon = q >= 0.5 ? (ex > 2 ? 10 : 8) : 6, nLat = q >= 0.5 ? (ex > 2 ? 5 : 6) : 4;
  // (packed a little closer than their diameter: they nest into each other)
  const dx = 2 * rad * ex * 0.9, dz = 2 * rad * ez * 0.9;
  const nx = Math.max(1, Math.floor(W / dx)), nz = Math.max(1, Math.floor(D / dz));
  const ox = (W - nx * dx) / 2, oz = (D - nz * dz) / 2;
  // a dark bed under the pile, so nothing shows through its gaps
  tm.piece(0).box(-W / 2, -rad * 0.4, -D / 2, W / 2, -rad * 0.3, D / 2, 32, 0.25, 0.25);
  const layers = [[0, 0, 1], [0.5, 0.5, 1.0], [0, 0, 0.55], [0.5, 0.5, 0.22]];
  let n = 0;
  for (let L = 0; L < layers.length; L++) {
    const [fx, fz, keep] = layers[L];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const u = -W / 2 + ox + (i + 0.5 + fx) * dx, w = -D / 2 + oz + (j + 0.5 + fz) * dz;
        if (Math.abs(u) > W / 2 - rad * ex * 0.7 || Math.abs(w) > D / 2 - rad * ez * 0.7) continue;
        // the mound: upper layers only towards the middle
        const cu = u / (W / 2), cw = w / (D / 2);
        if (L > 0 && cu * cu + cw * cw > keep * 1.25) continue;
        if (L > 0 && r.chance(0.1)) continue;
        const k = r.range(0.86, 1.14), rx = rad * ex * k, rz = rad * ez * k, ry = rad * sy * k;
        const x = u + r.range(-0.18, 0.18) * rad, z = w + r.range(-0.18, 0.18) * rad;
        const y = L * ry * 1.25 + ry * 0.75 + r.range(-0.12, 0.12) * ry;
        const ang = ex > 1.5 ? r.range(-0.35, 0.35) : r.range(0, 6.28), tip = r.range(-0.35, 0.35) * (L > 0 ? 1 : 0.4);
        const isAlt = alt && r.chance(0.2);
        fruit(isAlt ? ta : tm, x, y, z, rx, ry, rz, ang, tip, nLon, nLat, r.range(0.84, 1.1), dimple);
        if (ts && r.chance(0.85)) {
          // a calyx (a short green star) or a stalk at the dimple, turned and tipped with it
          const top = y + ry * (1 - dimple) * Math.cos(tip), zt = z + ry * (1 - dimple) * Math.sin(tip) * 1;
          if (stem === 1) {
            for (let a = 0; a < 5; a++) {
              const aa = ang + a * 1.2566, c = Math.cos(aa), s2 = Math.sin(aa), L2 = rx * 0.55;
              ts.q4(x, top + 0.002, zt, x + c * L2 - s2 * 0.006, top - 0.004, zt + s2 * L2 + c * 0.006, x + c * L2 * 1.05, top - 0.006, zt + s2 * L2 * 1.05, x + c * L2 + s2 * 0.006, top - 0.004, zt + s2 * L2 - c * 0.006, 0.9, 0.8);
            }
            ts.box(x - 0.003, top, zt - 0.003, x + 0.003, top + 0.012, zt + 0.003, 1 | 2 | 4 | 8 | 32, 0.8, 0.9);
          } else ts.box(x - 0.002, top - 0.004, zt - 0.002, x + 0.002, top + 0.016, zt + 0.002, 1 | 2 | 4 | 8 | 32, 0.8, 0.9);
        }
        n++;
      }
    }
  }
  return { main: tm.bake(), alt: ta.count ? ta.bake() : (ta.free(), null), stems: ts ? (ts.count ? ts.bake() : (ts.free(), null)) : null, n };
}

/**
 * Wooden fruit crate W × D × H on y = 0: two or three slats a side with gaps between them,
 * corner posts, a slatted floor; the slats shaded one by one (wood batch).
 */
function woodCrate(t, W, D, H) {
  const T = 0.01, P = 0.022, x0 = -W / 2, x1 = W / 2, z0 = -D / 2, z1 = D / 2;
  t.uvLong = true;
  const ns = H > 0.17 ? 3 : 2, sh = (H - 0.01) / ns, gap = Math.min(0.02, sh * 0.25);
  for (let k = 0; k < ns; k++) {
    const y0 = 0.008 + k * sh, y1 = y0 + sh - gap;
    t.piece(0.12);
    t.box(x0 + P, y0, z1 - T, x1 - P, y1, z1, 1 | 16 | 32, 0.92, 1);                // front
    t.box(x0 + P, y0, z0, x1 - P, y1, z0 + T, 2 | 16 | 32, 0.85, 0.95);             // back
    t.box(x0, y0, z0 + P, x0 + T, y1, z1 - P, 4 | 16 | 32, 0.88, 0.98);            // ends
    t.box(x1 - T, y0, z0 + P, x1, y1, z1 - P, 8 | 16 | 32, 0.88, 0.98);
    // their inner faces in the crate's shade
    t.q4(x0 + P, y0, z1 - T, x0 + P, y1, z1 - T, x1 - P, y1, z1 - T, x1 - P, y0, z1 - T, 0.45, 0.6);
    t.q4(x1 - P, y0, z0 + T, x1 - P, y1, z0 + T, x0 + P, y1, z0 + T, x0 + P, y0, z0 + T, 0.45, 0.6);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { t.piece(0.08); t.box(sx * (W / 2 - P / 2) - P / 2, 0, sz * (D / 2 - P / 2) - P / 2, sx * (W / 2 - P / 2) + P / 2, H, sz * (D / 2 - P / 2) + P / 2, 1 | 2 | 4 | 8 | 32, 0.85, 1); }
  for (let k = 0; k < 4; k++) { const za = z0 + (k * D) / 4 + 0.006, zb = za + D / 4 - 0.012; t.piece(0.1); t.box(x0 + T, 0, za, x1 - T, 0.008, zb, 32 | 16, 0.6, 0.6); }
}
/** Cardboard produce box W × D × H: kraft walls 4 mm, hand holes, its rim's flaps cut off. */
function cardBox(t, W, D, H) {
  const T = 0.004, x0 = -W / 2, x1 = W / 2, z0 = -D / 2, z1 = D / 2;
  t.piece(0.05);
  t.box(x0, 0, z1 - T, x1, H, z1, 1 | 4 | 8 | 32, 0.9, 1);
  t.box(x0, 0, z0, x1, H, z0 + T, 2 | 4 | 8 | 32, 0.82, 0.92);
  t.box(x0, 0, z0 + T, x0 + T, H, z1 - T, 4 | 32, 0.86, 0.96);
  t.box(x1 - T, 0, z0 + T, x1, H, z1 - T, 8 | 32, 0.86, 0.96);
  // inner faces (facing into the box)
  t.q4(x0 + T, 0.005, z1 - T, x0 + T, H, z1 - T, x1 - T, H, z1 - T, x1 - T, 0.005, z1 - T, 0.4, 0.55);
  t.q4(x1 - T, 0.005, z0 + T, x1 - T, H, z0 + T, x0 + T, H, z0 + T, x0 + T, 0.005, z0 + T, 0.4, 0.55);
  t.box(-W * 0.12, H - 0.055, z1 + 0.0004, W * 0.12, H - 0.03, z1 + 0.0008, 1, 0.18, 0.18);
}

// ------------------------------------------------------------------ stand builders
// Each returns a list of parts: [key, baked template, colour (linear rgb), extra, local
// matrix or null]. Keys: paint (powder-coat / plastic / produce, casts shadows), metal,
// cloth (awning batch: garments, sway), text (prints and tags).
const PART = (key, tpl, col, extra = null, m = null) => ({ key, tpl, col, extra, m });

function tiltM(y, z, a, x = 0) { return new THREE.Matrix4().makeTranslation(x, y, z).multiply(_r.makeRotationX(a)); }

/**
 * Stepped crates (greengrocer, juice bar): a front and a back row on a covered step; pine
 * fruit crates, kraft produce boxes or plastic crates, each heaped above its rim with
 * 40-60 pieces of fruit or veg lying one by one (bunches of grapes and leaves as heaps).
 */
function produceStand(st, r, q) {
  const parts = [];
  const n = st.n, cw = 0.5, cd = 0.34;
  const list = st.kind === 'citrus' ? CITRUS : GROCER;
  const step = q2(r.range(0.26, 0.34), 0.02), stepB = step + 0.26;
  // the step: a box draped in green artificial-grass cloth (or a bare dark frame)
  const grass = r.chance(0.6);
  const sb = cache.get(`step|${n}|${step}`, () => {
    const t = new Tpl();
    const W = n * 0.52 + 0.04;
    t.box(-W / 2, 0, -0.42, W / 2, stepB - 0.02, -0.02, 1 | 4 | 8 | 32, 0.8, 0.95);
    t.box(-W / 2, 0, -0.02, W / 2, step - 0.02, 0.4, 1 | 4 | 8 | 32, 0.85, 1);
    return t.bake();
  });
  parts.push(PART('paint', sb, lin(grass ? 0x2e4a26 : 0x2a2b2c)));
  // one kind of crate for the stand, sometimes a plastic one among the wooden
  const ck = r.weighted([['wood', 0.5], ['card', 0.25], ['plastic', 0.25]]);
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < n; i++) {
      const x = -((n - 1) * 0.52) / 2 + i * 0.52;
      const y = row ? stepB : step, z = row ? -0.22 : 0.19;
      const tilt = row ? 0.1 : 0.13;
      const H = q2(r.range(0.16, 0.22), 0.02);
      const m = tiltM(y, z, tilt, x);
      const kind = ck === 'wood' && r.chance(0.12) ? 'plastic' : ck;
      if (kind === 'wood') {
        const ct = cache.get(`wcrate|${cw}|${cd}|${H}`, () => { const t = new Tpl(); woodCrate(t, cw, cd, H); return t.bake(); });
        parts.push(PART('wood', ct, lin(r.pick([0xc8a878, 0xb89868, 0xd8bc8c, 0xa88a60])), null, m));
      } else if (kind === 'card') {
        const ct = cache.get(`cbox|${cw}|${cd}|${H}`, () => { const t = new Tpl(); cardBox(t, cw, cd, H); return t.bake(); });
        parts.push(PART('paint', ct, lin(r.pick([0xa07850, 0x9a7048, 0xb08860, 0x8a6a48])), null, m));
      } else {
        const ct = cache.get(`crate|${cw}|${cd}|${H}`, () => { const t = new Tpl(); crate(t, cw, cd, H); return t.bake(); });
        parts.push(PART('paint', ct, lin(r.weighted(CRATES)), null, m));
      }
      const name = list[r.int(0, list.length - 1)];
      const [col, rad, ex, ez, sy, alt] = PRODUCE[name];
      const v = r.int(0, 2);
      if (HEAPED.has(name)) {
        const ht = cache.get(`heap|${name}|${cw}|${cd}|${v}|${q}`, () => {
          const t = new Tpl(); heap(t, -cw / 2 + 0.016, -cd / 2 + 0.016, cw - 0.032, cd - 0.032, 0, rad, ex, ez, sy, 0.035, 977 * v + name.length * 31, q); return t.bake();
        });
        parts.push(PART('produce', ht, lin(col), null, m.clone().multiply(_t.makeTranslation(0, H - rad * sy * 0.9, 0))));
      } else {
        // the pile's bed a fruit's height below the rim, so the heap stands proud of it
        const fp = cache.get(`pile|${name}|${cw}|${cd}|${v}|${q}`, () => fruitPile(name, cw - 0.03, cd - 0.03, 4111 * v + name.length * 37 + 5, q));
        const mp = m.clone().multiply(_t.makeTranslation(0, H - rad * sy * 1.3, 0));
        parts.push(PART('produce', fp.main, lin(col), null, mp));
        if (fp.alt) parts.push(PART('produce', fp.alt, lin(alt), null, mp));
        if (fp.stems) parts.push(PART('produce', fp.stems, lin(PRODUCE[name][6] === 2 ? 0x4a3420 : 0x3a5a22), null, mp));
      }
      // a cardboard price tag on a stick in some crates
      if (q >= 0.5 && r.chance(0.55)) {
        const cell = printCell('tags', r.int(0, 15));
        const tt = new Tpl(); card(tt, cell, r.range(-0.12, 0.12), H + 0.11, cd / 2 - 0.05, 0.1, 0.1);
        parts.push(PART('text', tt.bake(), [1, 1, 1], null, m));
      }
    }
  }
  return parts;
}

/** Tiered buckets of cut flowers. */
function flowerStand(st, r, q) {
  const parts = [];
  const n = st.n;
  const tiers = [[0.0, 0.26], [0.28, -0.08], [0.56, -0.34]];   // [height, z]
  const fr = cache.get(`ftier|${n}`, () => {
    const t = new Tpl();
    const W = n * 0.34 + 0.04;
    for (const [y, z] of tiers) if (y > 0) t.box(-W / 2, y - 0.03, z - 0.17, W / 2, y, z + 0.17, 1 | 4 | 8 | 16 | 32, 0.85, 1);
    for (const sx of [-1, 1]) {
      bar(t, [sx * W / 2, 0, 0.12], [sx * W / 2, 0.28, 0.12], 0.025);
      bar(t, [sx * W / 2, 0, -0.18], [sx * W / 2, 0.56, -0.18], 0.025);
      bar(t, [sx * W / 2, 0, -0.48], [sx * W / 2, 0.56, -0.48], 0.025);
    }
    return t.bake();
  });
  parts.push(PART('paint', fr, lin(r.pick([0x232425, 0x2d4033, 0x5d605c]))));
  const bucketCol = lin(r.pick([0x9a9c98, 0x9a9c98, 0x1d1d1f, 0x2d5a3a, 0xc8c2b0]));
  for (const [y, z] of tiers) {
    for (let i = 0; i < n; i++) {
      const x = -((n - 1) * 0.34) / 2 + i * 0.34 + r.range(-0.02, 0.02);
      const rb = q2(r.range(0.12, 0.145), 0.005), hb = q2(r.range(0.26, 0.36), 0.02);
      const bt = cache.get(`bucket|${rb}|${hb}|${q}`, () => {
        const t = new Tpl(); const ns = q >= 0.5 ? 14 : 8;
        cyl(t, 0, 0, rb * 0.82, rb, 0, hb, ns, 0.75, 1);
        cyl(t, 0, 0, rb, rb * 1.03, hb, hb + 0.012, ns, 1, 1);
        return t.bake();
      });
      const m = new THREE.Matrix4().makeTranslation(x, y, z);
      parts.push(PART('paint', bt, bucketCol, null, m));
      // bunch: the stems standing out of the water, a fringe of foliage round them and the
      // heads crowning it (roses, gerberas, tulips or carnations; one kind per bucket)
      const v = r.int(0, 3), hd = q2(r.range(0.12, 0.26), 0.02);
      const leaf = lin(r.pick([0x2e4a1e, 0x3a5a24, 0x26401a]));
      // (built for a 0.13 m bucket and a 0.2 m bunch at y = 0, scaled to this one)
      const RB = 0.13, HD = 0.2, ks = rb / RB, kh = hd / HD;
      const sm = cache.get(`stems|${q}`, () => { const t = new Tpl(); cyl(t, 0, 0, RB * 0.7, RB * 0.95, -0.02, HD * 0.55, q >= 0.5 ? 10 : 6, 0.55, 0.8); return t.bake(); });
      const mb = m.clone().multiply(_t.makeTranslation(0, hb, 0)).multiply(_s.makeScale(ks, kh, ks));
      parts.push(PART('paint', sm, leaf, null, mb));
      const lt = cache.get(`leaves|${v}|${q}`, () => { const t = new Tpl(); heap(t, -RB * 1.3, -RB * 1.3, RB * 2.6, RB * 2.6, HD * 0.3, 0.04, 1.6, 0.7, 0.7, 0.03, 431 * v + 7, q, true); return t.bake(); });
      parts.push(PART('paint', lt, leaf, null, mb));
      const hk = r.int(0, 3), [hr, hx, hs] = [[0.026, 1, 1], [0.04, 1, 0.45], [0.02, 1, 1.5], [0.024, 1, 0.9]][hk];
      const fl = cache.get(`heads|${hk}|${v}|${q}`, () => { const t = new Tpl(); heap(t, -RB * 1.12, -RB * 1.12, RB * 2.24, RB * 2.24, HD * 0.45, hr, hx, 1, hs, HD * 0.55, 211 * v + 3, q, true, 0.3); return t.bake(); });
      const c1 = r.pick(FLOWERS);
      parts.push(PART('paint', fl, lin(c1), null, mb));
      // half the buckets hold a mixed bunch: a second kind of head among the first
      if (r.chance(0.5)) {
        const f2 = cache.get(`heads2|${hk}|${v}|${q}`, () => { const t = new Tpl(); heap(t, -RB * 1.05, -RB * 1.05, RB * 2.1, RB * 2.1, HD * 0.42, hr * 0.9, hx, 1, hs, HD * 0.55, 389 * v + 11, q, true, 0.3); return t.bake(); });
        parts.push(PART('paint', f2, lin(r.pick(FLOWERS.filter((c) => c !== c1))), null, mb));
      }
    }
  }
  return parts;
}

/** A chrome rail of garments on hangers, side-on to the street. */
function clothesRail(st, r, q) {
  const parts = [];
  const W = st.W, top = q2(r.range(1.45, 1.6), 0.05);
  const rt = cache.get(`rail|${W.toFixed(2)}|${top}`, () => {
    const t = new Tpl();
    for (const sx of [-1, 1]) {
      bar(t, [sx * W / 2, 0.06, 0], [sx * W / 2, top, 0], 0.024);
      bar(t, [sx * W / 2, 0.06, -0.24], [sx * W / 2, 0.06, 0.24], 0.03);
      for (const z of [-0.24, 0.24]) t.box(sx * W / 2 - 0.02, 0, z - 0.02, sx * W / 2 + 0.02, 0.05, z + 0.02, 1 | 2 | 4 | 8 | 32, 0.4, 0.5);
    }
    bar(t, [-W / 2 - 0.02, top, 0], [W / 2 + 0.02, top, 0], 0.022);
    return t.bake();
  });
  parts.push(PART('metal', rt, [0.55, 0.55, 0.56]));
  const kinds = r.chance(0.5) ? ['tee', 'tee', 'dress'] : r.chance(0.5) ? ['dress', 'trousers'] : ['tee', 'trousers', 'scarf'];
  const kind = r.pick(kinds);
  const run = r.int(2, 4);
  const nG = Math.floor((W - 0.12) / 0.07);
  let c1 = lin(r.pick(CLOTH)), c2 = lin(r.pick(CLOTH));
  const hc = lin(r.pick([0x141414, 0x141414, 0x5a3a22, 0xd8d8d4]));
  for (let i = 0; i < nG; i++) {
    if (i % run === 0) { c1 = lin(r.pick(CLOTH)); c2 = lin(r.pick(CLOTH)); }
    const tp = cloth(i % 5 === 4 ? r.pick(kinds) : kind, 'rail');
    const len = tp.len;
    const x = -W / 2 + 0.07 + i * ((W - 0.14) / Math.max(1, nG - 1));
    // a hanger's hook over the rail; the garment faces along the rail, swaying a little
    const m = new THREE.Matrix4().makeTranslation(x, top - 0.035, 0).multiply(_r.makeRotationY((i % 2 ? 1 : -1) * Math.PI / 2 + r.range(-0.12, 0.12)));
    if (top - 0.035 - len < 0.12) m.multiply(_t.makeScale(1, (top - 0.17) / len, 1));
    const stripe = r.chance(0.2) ? r.range(0.03, 0.07) : 0;
    parts.push(PART('cloth', tp, c1, { aStripe: [c2[0], c2[1], c2[2], stripe], aFlex: (k, v, a, j) => { a[j] = Math.min(1, Math.max(0, -v[k * VS + 1] / len)) * 0.5; } }, m));
    // its hanger (black or clear plastic, or wood), the hook over the rail
    if (q >= 0.5) parts.push(PART('paint', hangerTpl(tp.kind), hc, null, m));
  }
  // a garment hung face out on a hook at each end of the rail, so the stock reads from
  // along the street
  for (const sx of [-1, 1]) {
    if (!r.chance(0.8)) continue;
    const tp = cloth(r.pick(kinds), 'rail'), len = tp.len, c = lin(r.pick(CLOTH)), c2 = lin(r.pick(CLOTH));
    const y = top - 0.06;
    const m = new THREE.Matrix4().makeTranslation(sx * (W / 2 + 0.035), y, 0).multiply(_r.makeRotationY(sx * Math.PI / 2 + r.range(-0.15, 0.15)));
    if (y - len < 0.1) m.multiply(_t.makeScale(1, (y - 0.12) / len, 1));
    parts.push(PART('cloth', tp, c, { aStripe: [c2[0], c2[1], c2[2], r.chance(0.25) ? 0.05 : 0], aFlex: (k, v, a, j) => { a[j] = Math.min(1, Math.max(0, -v[k * VS + 1] / len)) * 0.6; } }, m));
    if (q >= 0.5) parts.push(PART('paint', hangerTpl(tp.kind), hc, null, m));
  }
  return parts;
}

/** A wire rack of newspapers and magazines, three shelves leaning back. */
function newsRack(st, r, q) {
  const parts = [];
  const W = st.W;
  const ft = cache.get(`news|${W.toFixed(2)}`, () => {
    const t = new Tpl();
    for (const sx of [-1, 1]) {
      bar(t, [sx * W / 2, 0, 0.18], [sx * W / 2, 1.25, -0.1], 0.02);
      bar(t, [sx * W / 2, 0, -0.2], [sx * W / 2, 1.25, -0.12], 0.02);
    }
    for (let k = 0; k < 3; k++) {
      const y = 0.32 + k * 0.33, z = 0.15 - k * 0.09;
      bar(t, [-W / 2, y, z], [W / 2, y, z], 0.016);
      bar(t, [-W / 2, y, z - 0.06], [W / 2, y, z - 0.06], 0.012);
    }
    return t.bake();
  });
  parts.push(PART('metal', ft, [0.12, 0.12, 0.125]));
  const tt = new Tpl();
  for (let k = 0; k < 3; k++) {
    const y = 0.32 + k * 0.33, z = 0.17 - k * 0.09;
    let x = -W / 2 + 0.03;
    while (x < W / 2 - 0.12) {
      const i = r.int(0, 15), cell = printCell('papers', i);
      const h = i < 9 ? 0.34 : 0.3, w = h * cell.aspect;
      if (x + w > W / 2 - 0.02) break;
      card(tt, cell, x + w / 2, y + h / 2 + 0.01, z - 0.03 + r.range(-0.01, 0.01), h, 0.26 + r.range(-0.04, 0.04));
      x += w * r.range(0.72, 0.95);
    }
  }
  parts.push(PART('text', tt.bake(), [0.92, 0.92, 0.92]));
  // a bundle of the day's papers on the paving beside it
  const bt = cache.get('bundle', () => { const t = new Tpl(); t.piece(0.08); for (let k = 0; k < 4; k++) t.box(-0.17, k * 0.035, -0.12, 0.17, k * 0.035 + 0.034, 0.12, 1 | 4 | 8 | 32, 0.8, 1); return t.bake(); });
  parts.push(PART('paint', bt, lin(0xd8d4c8), null, new THREE.Matrix4().makeTranslation(W / 2 - 0.2, 0, 0.0).multiply(_r.makeRotationY(r.range(-0.3, 0.3)))));
  return parts;
}

/**
 * Ring bread (an oval torus: ring radius R, tube r) lying flat at (x, y, z), turned by ang
 * and tipped by tip; its sesame crust as speckled shade, toasted darker on top.
 */
function ringBread(t, x, y, z, R, rr, ang, tip, seed, q) {
  const nu = q >= 0.5 ? 18 : 8, nv = q >= 0.5 ? 8 : 4, base = t.count;
  const ca = Math.cos(ang), sa = Math.sin(ang), ct = Math.cos(tip), st = Math.sin(tip);
  for (let i = 0; i <= nu; i++) {
    const u = (i / nu) * Math.PI * 2, cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j <= nv; j++) {
      const v = (j / nv) * Math.PI * 2, cv = Math.cos(v), sv = Math.sin(v);
      // oval ring, tube a little flattened
      const px = (R + rr * cv) * cu * 1.18, pz = (R + rr * cv) * su, py = rr * sv * 0.8;
      let nx = cv * cu / 1.18, nz = cv * su, ny = sv / 0.8;
      const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
      const y2 = py * ct - pz * st, z2 = py * st + pz * ct, ny2 = ny * ct - nz * st, nz2 = ny * st + nz * ct;
      const wx = px * ca + z2 * sa, wz = -px * sa + z2 * ca, nwx = nx * ca + nz2 * sa, nwz = -nx * sa + nz2 * ca;
      const h = Math.sin(i * 12.9898 + j * 78.233 + seed) * 43758.5453, sp = h - Math.floor(h);
      const sh = (0.78 + 0.3 * Math.max(0, sv)) * (sp > 0.55 ? 1.22 : 0.95) * (cv < -0.3 ? 0.85 : 1);
      t.v(x + wx, y + y2, z + wz, nwx, ny2, nwz, u * R, v * rr, sh);
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = base + i * (nv + 1) + j, b = a + nv + 1;
    t.ix6(a, b, a + 1, a + 1, b, b + 1);
  }
}
/** Oval wicker basket on y = 0 (half sizes a, b, height h): woven sides (shade in a weave), a rim. */
function basket(t, a, b, h, q) {
  const n = q >= 0.5 ? 24 : 10, rows = q >= 0.5 ? 6 : 2, base = t.count;
  for (let j = 0; j <= rows; j++) {
    const f = j / rows, k = 0.82 + 0.18 * f, y = h * f;
    for (let i = 0; i <= n; i++) {
      const ang = (i / n) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
      const weave = q >= 0.5 ? ((i + j) % 2 ? 0.86 : 1.04) : 1;
      const nl = Math.hypot(c / a, 0.2, s / b);
      t.v(c * a * k, y, s * b * k, c / a / nl, -0.2 / nl, s / b / nl, ang * a, y, (0.7 + 0.3 * f) * weave);
    }
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < n; i++) {
    const p = base + j * (n + 1) + i, c = p + n + 1;
    t.ix6(p, c, p + 1, p + 1, c, c + 1);
  }
  // rim: a rolled edge, and the floor
  t.box(-a, h - 0.004, -b * 0.06, a, h + 0.012, b * 0.06, 32, 1, 1);
  t.piece(0).box(-a * 0.82, 0, -b * 0.82, a * 0.82, 0.006, b * 0.82, 32, 0.5, 0.5);
}

/**
 * Bakery stand: a wooden cart (two wheels, legs and push handles) or a table under a cloth, with
 * wicker baskets of sesame ring breads, rolls and flat loaves, and a stack of rings on a
 * dowel the way the street's bread sellers carry them.
 */
function bakeryTable(st, r, q) {
  const parts = [];
  const W = q2(st.W, 0.1), D = 0.55, H = 0.78;
  const cart = r.chance(0.5);
  const tb = cache.get(`bcart|${W.toFixed(2)}|${cart}|${q}`, () => {
    const t = new Tpl();
    t.uvLong = true;
    // the top: planks with a raised edge
    for (let k = 0; k < 5; k++) { t.piece(0.1); t.box(-W / 2, H - 0.035, -D / 2 + (k * D) / 5 + 0.003, W / 2, H, -D / 2 + ((k + 1) * D) / 5 - 0.003, 1 | 2 | 4 | 8 | 16 | 32, 0.85, 1); }
    if (cart) {
      for (const sz of [-1, 1]) t.box(-W / 2, H, sz * D / 2 - (sz > 0 ? 0.02 : 0), W / 2, H + 0.07, sz * D / 2 + (sz < 0 ? 0.02 : 0), 1 | 2 | 4 | 8 | 32, 0.8, 1);
      for (const sx of [-1, 1]) t.box(sx * W / 2 - (sx > 0 ? 0.02 : 0), H, -D / 2, sx * W / 2 + (sx < 0 ? 0.02 : 0), H + 0.07, D / 2, 1 | 2 | 4 | 8 | 32, 0.8, 1);
      // two wheels at one end (rims of short bars, spokes), legs at the other, push handles
      const wr = 0.3, nw = q >= 0.5 ? 16 : 8;
      for (const sz of [-1, 1]) {
        const zc = sz * (D / 2 + 0.04);
        for (let k = 0; k < nw; k++) {
          const a0 = (k / nw) * Math.PI * 2, a1 = ((k + 1) / nw) * Math.PI * 2;
          const x0 = -W / 2 + 0.25 + Math.cos(a0) * wr, y0 = wr + Math.sin(a0) * wr, x1 = -W / 2 + 0.25 + Math.cos(a1) * wr, y1 = wr + Math.sin(a1) * wr;
          bar(t, [x0, y0, zc], [x1, y1, zc], 0.035);
        }
        for (let k = 0; k < 6; k++) { const a0 = (k / 6) * Math.PI * 2; bar(t, [-W / 2 + 0.25, wr, zc], [-W / 2 + 0.25 + Math.cos(a0) * wr, wr + Math.sin(a0) * wr, zc], 0.018); }
        bar(t, [W / 2 - 0.06, 0, sz * (D / 2 - 0.05)], [W / 2 - 0.06, H - 0.035, sz * (D / 2 - 0.05)], 0.045);
        bar(t, [W / 2 - 0.04, H + 0.02, sz * (D / 2 - 0.04)], [W / 2 + 0.06, H + 0.2, sz * (D / 2 - 0.06)], 0.035);
      }
      bar(t, [-W / 2 + 0.25, wr, -D / 2 - 0.06], [-W / 2 + 0.25, wr, D / 2 + 0.06], 0.03);
    } else {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(t, [sx * (W / 2 - 0.05), 0, sz * (D / 2 - 0.05)], [sx * (W / 2 - 0.05), H - 0.035, sz * (D / 2 - 0.05)], 0.045);
    }
    return t.bake();
  });
  parts.push(PART('wood', tb, lin(r.pick([0x8a6a48, 0x9a7a52, 0x6a4a30, 0xa88a60]))));
  if (!cart) {
    // a cloth over the table, its sides hanging in folds (plain, striped or checked)
    const ct = cache.get(`bcloth|${W.toFixed(2)}|${q}`, () => {
      const t = new Tpl();
      t.box(-W / 2 - 0.01, H, -D / 2 - 0.01, W / 2 + 0.01, H + 0.003, D / 2 + 0.01, 32, 1, 1);
      const drop = 0.26, nx = q >= 0.5 ? Math.round(W / 0.04) : 4;
      for (let i = 0; i < nx; i++) {
        const xa = -W / 2 - 0.01 + ((W + 0.02) * i) / nx, xb = xa + (W + 0.02) / nx;
        const fa = 0.012 * Math.sin(xa * 40), fb = 0.012 * Math.sin(xb * 40);
        t.q4(xa, H - drop, D / 2 + 0.012 + fa, xb, H - drop, D / 2 + 0.012 + fb, xb, H + 0.003, D / 2 + 0.01, xa, H + 0.003, D / 2 + 0.01, 0.82 + 0.1 * Math.cos(xa * 40), 1);
      }
      for (const sx of [-1, 1]) t.q4(sx * (W / 2 + 0.012), H - drop, sx > 0 ? D / 2 + 0.01 : -D / 2 - 0.01, sx * (W / 2 + 0.012), H - drop, sx > 0 ? -D / 2 - 0.01 : D / 2 + 0.01, sx * (W / 2 + 0.01), H + 0.003, sx > 0 ? -D / 2 - 0.01 : D / 2 + 0.01, sx * (W / 2 + 0.01), H + 0.003, sx > 0 ? D / 2 + 0.01 : -D / 2 - 0.01, 0.8, 0.95);
      return t.bake();
    });
    const c1 = lin(r.pick([0xf2efe6, 0xe8e0c8, 0xb8261e, 0x1f4fa0, 0xf2efe6])), c2 = lin(r.pick([0xf2efe6, 0xb8261e, 0x2a6a3a, 0x1f4fa0]));
    parts.push(PART('cloth', ct, c1, { aStripe: [c2[0], c2[1], c2[2], r.chance(0.6) ? r.pick([0.05, 0.08, 0.12]) : 0], aFlex: (k, v, a, j) => { a[j] = v[k * VS + 1] < H - 0.01 ? 0.25 : 0; } }));
  }
  // baskets along the top: ring breads (most), rolls, flat loaves
  const top = H + (cart ? 0.0 : 0.003);
  const nb = W > 1.15 ? 3 : 2, bw = (W - 0.1) / nb;
  const wick = lin(r.pick([0xd0a868, 0xc09858, 0xdcb478]));
  for (let i = 0; i < nb; i++) {
    const x = -W / 2 + 0.05 + bw * (i + 0.5);
    const ba = Math.min(0.2, bw / 2 - 0.02), bb = 0.2, bh = 0.09;
    const bt = cache.get(`basket|${ba.toFixed(2)}|${q}`, () => { const t = new Tpl(); basket(t, ba, bb, bh, q); return t.bake(); });
    const mb = new THREE.Matrix4().makeTranslation(x, top, r.range(-0.03, 0.03)).multiply(_r.makeRotationY(r.range(-0.15, 0.15)));
    parts.push(PART('wood', bt, wick, null, mb));
    const what = i === 0 || r.chance(0.6) ? 'rings' : r.chance(0.5) ? 'rolls' : 'flat';
    const v = r.int(0, 2);
    const ft = cache.get(`bread|${what}|${ba.toFixed(2)}|${v}|${q}`, () => {
      const t = new Tpl(), rr = new RNG(77 + v * 13 + what.length);
      if (what === 'rings') {
        for (let k = 0; k < 9; k++) {
          const a = (k / 9) * Math.PI * 2 + rr.range(-0.3, 0.3), rad = k === 0 ? 0 : ba * 0.45;
          ringBread(t, Math.cos(a) * rad * 0.9, bh * 0.85 + (k === 0 ? 0.045 : 0) + rr.range(0, 0.025), Math.sin(a) * rad * 0.8, 0.07, 0.017, rr.range(0, 6.28), rr.range(-0.4, 0.4) + (k ? 0.25 : 0), k, q);
        }
      } else if (what === 'rolls') {
        for (let k = 0; k < 12; k++) fruit(t, rr.range(-ba * 0.6, ba * 0.6), bh * 0.8 + rr.range(0, 0.04), rr.range(-bb * 0.6, bb * 0.6), 0.045, 0.03, 0.04, rr.range(0, 6.28), rr.range(-0.3, 0.3), q >= 0.5 ? 10 : 6, q >= 0.5 ? 6 : 4, rr.range(0.85, 1.1), 0);
      } else {
        for (let k = 0; k < 5; k++) fruit(t, rr.range(-0.04, 0.04), bh * 0.7 + k * 0.022, rr.range(-0.04, 0.04), 0.1, 0.012, 0.1, rr.range(0, 6.28), rr.range(-0.1, 0.1), q >= 0.5 ? 14 : 6, 4, rr.range(0.9, 1.05), 0);
      }
      return t.bake();
    });
    parts.push(PART('paint', ft, lin(what === 'flat' ? 0xd8b484 : what === 'rolls' ? 0xc88a40 : 0xc08440), null, mb));
  }
  // a stack of rings threaded on a dowel stood at the end of the stand
  if (q >= 0.5 && r.chance(0.55)) {
    const pt = cache.get(`dowel|${q}`, () => {
      const t = new Tpl(), rr = new RNG(991);
      for (let k = 0; k < 11; k++) ringBread(t, rr.range(-0.006, 0.006), 0.08 + k * 0.034, rr.range(-0.006, 0.006), 0.07, 0.017, rr.range(0, 6.28), rr.range(-0.12, 0.12), k * 3, q);
      return t.bake();
    });
    const sx = r.chance(0.5) ? 1 : -1;
    const md = new THREE.Matrix4().makeTranslation(sx * (W / 2 - 0.12), top, r.range(-0.12, 0.12));
    parts.push(PART('paint', pt, lin(0xb87a3a), null, md));
    const dw = cache.get('dowelStick', () => { const t = new Tpl(); bar(t, [0, 0, 0], [0, 0.5, 0], 0.016); return t.bake(); });
    parts.push(PART('wood', dw, lin(0x8a6a48), null, md));
  }
  if (q >= 0.5) {
    const tt = new Tpl(); card(tt, printCell('tags', r.int(0, 15)), r.range(-0.2, 0.2), top + 0.16, 0.22, 0.11, 0.25);
    parts.push(PART('text', tt.bake(), [1, 1, 1]));
  }
  return parts;
}

/** Rolled-down sacks of nuts, seeds and spices in a row. */
function sackRow(st, r, q) {
  const parts = [];
  const n = st.n;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < n; i++) {
      if (row && r.chance(0.3)) continue;
      const x = -((n - 1) * 0.4) / 2 + i * 0.4 + (row ? 0.2 : 0) + r.range(-0.02, 0.02);
      if (row && i === n - 1) continue;
      const z = row ? -0.2 : 0.18, rb = q2(r.range(0.15, 0.18), 0.01), hb = q2(r.range(0.34, 0.46), 0.02) + (row ? 0.14 : 0);
      const sk = cache.get(`sack|${rb}|${hb}|${q}`, () => {
        const t = new Tpl(); const ns = q >= 0.5 ? 14 : 8;
        cyl(t, 0, 0, rb * 0.9, rb * 0.97, 0, hb - 0.06, ns, 0.6, 0.92, rb * 0.08, 4);
        // the rolled-down rim, a fat roll of cloth
        cyl(t, 0, 0, rb, rb * 1.12, hb - 0.06, hb - 0.03, ns, 0.95, 1.05);
        cyl(t, 0, 0, rb * 1.12, rb * 0.98, hb - 0.03, hb, ns, 1.05, 0.85);
        return t.bake();
      });
      const m = new THREE.Matrix4().makeTranslation(x, 0, z);
      parts.push(PART('paint', sk, lin(r.pick([0x7a6040, 0x6e5636, 0x8a7250, 0xc8c0a8])), null, m));
      const v = r.int(0, 3);
      // (contents built for a 0.16 m sack at y = 0 and scaled to this one)
      const ks = rb / 0.16, mc = m.clone().multiply(_t.makeTranslation(0, hb, 0)).multiply(_s.makeScale(ks, 1, ks));
      if (r.chance(0.4)) {
        // ground spice: one smooth cone
        const ct = cache.get(`spice|${v}`, () => { const t = new Tpl(); heap(t, -0.152, -0.152, 0.304, 0.304, -0.06, 0.144, 1, 1, 0.55, 0.0, 17 * v + 1, 0, true); return t.bake(); });
        parts.push(PART('paint', ct, lin(r.pick(SPICES)), null, mc));
      } else {
        const nk = r.int(0, NUTS.length - 1), [col, rad, ex] = NUTS[nk];
        const nt = cache.get(`nuts|${nk}|${v}|${q}`, () => { const t = new Tpl(); heap(t, -0.147, -0.147, 0.294, 0.294, -0.035, rad, ex, 1, 0.8, 0.04, 71 * v + 5, q, true); return t.bake(); });
        parts.push(PART('paint', nt, lin(col), null, mc));
      }
      if (q >= 0.5 && r.chance(0.5)) {
        const tt = new Tpl(); card(tt, printCell('tags', r.int(0, 15)), x, hb + 0.1, z + rb * 0.4, 0.09, 0.15);
        parts.push(PART('text', tt.bake(), [1, 1, 1]));
      }
    }
  }
  return parts;
}

/** Wire bins of sale goods (toys, sweets, shoes, phone cases...) with a big price card. */
function saleBins(st, r, q) {
  const parts = [];
  const W = q2(st.W, 0.1), D = 0.55, H = 0.62, bh = 0.2;
  const ft = cache.get(`bin|${W.toFixed(2)}`, () => {
    const t = new Tpl();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(t, [sx * W / 2, 0, sz * D / 2], [sx * W / 2, H + bh, sz * D / 2], 0.018);
    for (const y of [H, H + bh * 0.5, H + bh]) {
      bar(t, [-W / 2, y, D / 2], [W / 2, y, D / 2], 0.012); bar(t, [-W / 2, y, -D / 2], [W / 2, y, -D / 2], 0.012);
      bar(t, [-W / 2, y, -D / 2], [-W / 2, y, D / 2], 0.012); bar(t, [W / 2, y, -D / 2], [W / 2, y, D / 2], 0.012);
    }
    for (let k = 1; k < 8; k++) { const x = -W / 2 + (W * k) / 8; bar(t, [x, H, D / 2], [x, H + bh, D / 2], 0.008); }
    t.box(-W / 2, H - 0.01, -D / 2, W / 2, H + 0.005, D / 2, 32, 0.5, 0.5);
    return t.bake();
  });
  parts.push(PART('metal', ft, [0.6, 0.6, 0.62]));
  const pal = st.type === 'shoes' ? BIN_GOODS.shoes : BIN_GOODS[st.sub] || BIN_GOODS.general;
  // the goods in three or four heaps of their own colour, piled together
  const nh = r.int(3, 4), hw = (W - 0.04) / nh;
  for (let i = 0; i < nh; i++) {
    const x0 = -W / 2 + 0.02 + i * hw;
    const v = r.int(0, 3), shoe = st.type === 'shoes';
    const ht = cache.get(`bingoods|${hw.toFixed(2)}|${shoe}|${v}|${q}`, () => { const t = new Tpl(); heap(t, 0, -D / 2 + 0.02, hw, D - 0.04, H + 0.04, shoe ? 0.05 : 0.045, shoe ? 2.4 : 1.4, 1, shoe ? 0.8 : 0.6, 0.06, 13 * v + (shoe ? 7 : 3), q); return t.bake(); });
    parts.push(PART('paint', ht, lin(pal[r.int(0, pal.length - 1)]), null, new THREE.Matrix4().makeTranslation(x0, 0, 0)));
  }
  if (q >= 0.5) {
    const tt = new Tpl(); card(tt, printCell('tags', r.int(0, 15)), r.range(-0.15, 0.15), H + bh + 0.16, -D / 2 + 0.04, 0.2, 0.05);
    parts.push(PART('text', tt.bake(), [1, 1, 1]));
    const sk = cache.get('tagstick', () => { const t = new Tpl(); bar(t, [0, H, -0.02], [0, H + bh + 0.08, -0.02], 0.008); return t.bake(); });
    parts.push(PART('metal', sk, [0.3, 0.3, 0.3], null, new THREE.Matrix4().makeTranslation(0, 0, -D / 2 + 0.04)));
  }
  return parts;
}

/** A three-tier rack of shoes, pairs side by side. */
function shoeRack(st, r, q) {
  const parts = [];
  const W = st.W, D = 0.36;
  const ft = cache.get(`shoerack|${W.toFixed(2)}`, () => {
    const t = new Tpl();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(t, [sx * W / 2, 0, sz * D / 2], [sx * W / 2, 0.98, sz * D / 2 - (sz > 0 ? 0.12 : 0)], 0.018);
    for (let k = 0; k < 3; k++) { const y = 0.2 + k * 0.32, z = 0.04 - k * 0.04; t.box(-W / 2, y - 0.015, z - D / 2 + 0.02, W / 2, y, z + D / 2 - 0.04, 1 | 4 | 8 | 16 | 32, 0.7, 0.9); }
    return t.bake();
  });
  parts.push(PART('paint', ft, lin(r.pick([0x232425, 0xd5d1c4, 0x6c4529]))));
  const shoeT = cache.get(`shoe|${q}`, () => {
    // a shoe seen in profile along z (toe to the street): sole, low upper and a heel counter
    const t = new Tpl();
    t.box(-0.045, 0, -0.13, 0.045, 0.025, 0.13, 1 | 2 | 4 | 8 | 32, 0.5, 0.6);
    t.box(-0.042, 0.025, -0.12, 0.042, 0.1, -0.02, 2 | 4 | 8 | 32, 0.85, 1);
    t.q4(-0.042, 0.025, 0.12, 0.042, 0.025, 0.12, 0.042, 0.075, -0.02, -0.042, 0.075, -0.02, 0.95, 1.05);
    t.q4(-0.042, 0.025, -0.02, -0.042, 0.025, 0.12, -0.042, 0.075, -0.02, -0.042, 0.075, -0.02, 0.8, 0.8);
    t.q4(0.042, 0.025, 0.12, 0.042, 0.025, -0.02, 0.042, 0.075, -0.02, 0.042, 0.075, -0.02, 0.8, 0.8);
    return t.bake();
  });
  for (let k = 0; k < 3; k++) {
    const y = 0.2 + k * 0.32, z = 0.0 - k * 0.04;
    const np = Math.floor((W - 0.06) / 0.23);
    for (let i = 0; i < np; i++) {
      const x = -W / 2 + 0.03 + 0.115 + i * ((W - 0.06) / np);
      const c = lin(r.pick(BIN_GOODS.shoes));
      for (const sx of [-0.05, 0.05]) parts.push(PART('paint', shoeT, c, null, new THREE.Matrix4().makeTranslation(x + sx, y, z).multiply(_r.makeRotationY(r.range(-0.08, 0.08)))));
    }
  }
  return parts;
}

/** A wooden cart of second-hand books, spines up in two rows. */
function bookCart(st, r, q) {
  const parts = [];
  const W = st.W, D = 0.5, H = 0.72;
  const ct = cache.get(`cart|${W.toFixed(2)}`, () => {
    const t = new Tpl();
    t.box(-W / 2, H - 0.2, -D / 2, W / 2, H - 0.18, D / 2, 32 | 16, 0.6, 0.6);
    t.box(-W / 2, H - 0.2, D / 2 - 0.02, W / 2, H - 0.05, D / 2, 1 | 2 | 4 | 8 | 32, 0.9, 1);
    t.box(-W / 2, H - 0.2, -D / 2, W / 2, H + 0.02, -D / 2 + 0.02, 1 | 2 | 4 | 8 | 32, 0.85, 1);
    t.box(-W / 2, H - 0.2, -D / 2, -W / 2 + 0.02, H - 0.05, D / 2, 4 | 8 | 32, 0.85, 1);
    t.box(W / 2 - 0.02, H - 0.2, -D / 2, W / 2, H - 0.05, D / 2, 4 | 8 | 32, 0.85, 1);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) t.box(sx * (W / 2 - 0.04) - 0.02, 0.08, sz * (D / 2 - 0.04) - 0.02, sx * (W / 2 - 0.04) + 0.02, H - 0.2, sz * (D / 2 - 0.04) + 0.02, 1 | 2 | 4 | 8, 0.7, 0.9);
    return t.bake();
  });
  parts.push(PART('paint', ct, lin(r.pick([0x5a3a22, 0x6c4529, 0x2d4033]))));
  // books spines up in two rows (the back row a little higher), in four bindings
  const groups = [new Tpl(), new Tpl(), new Tpl(), new Tpl()];
  for (let row = 0; row < 2; row++) {
    let x = -W / 2 + 0.03;
    const z0 = row ? -0.21 : 0.01, z1 = row ? -0.03 : 0.19, y0 = H - 0.18 + (row ? 0.05 : 0);
    while (x < W / 2 - 0.05) {
      const th = r.range(0.018, 0.045), hh = r.range(0.17, 0.27);
      groups[r.int(0, 3)].piece(0.25).box(x, y0, z0 + r.range(0, 0.02), x + th, y0 + hh, z1 - r.range(0, 0.03), 1 | 2 | 4 | 8 | 32, 0.85, 1);
      x += th + 0.002;
    }
  }
  const BOOKS = [0x6a2a22, 0x2a3a5a, 0x5a4a2a, 0x2e4a32, 0xc8b89a, 0x1d1d1f, 0x8a6a3a, 0x7a2a4a];
  for (const gt of groups) if (gt.count) parts.push(PART('paint', gt.bake(), lin(r.pick(BOOKS)))); else gt.free();
  return parts;
}

const BUILDERS = { produce: produceStand, citrus: produceStand, flowers: flowerStand, clothes: clothesRail, news: newsRack, bakery: bakeryTable, sacks: sackRow, bins: saleBins, shoes: shoeRack, books: bookCart };
// far range: the stand as a block with a top of its goods' colour
const FAR_COL = { produce: [0x2a5a32, 0xd06a20], citrus: [0x2a5a32, 0xd8801c], flowers: [0x232425, 0xd86a8a], clothes: [0x9a9a9a, 0x6a5a6a], news: [0x1d1d1f, 0xd8d4c8],
  bakery: [0x6c4529, 0xb87a3a], sacks: [0x9a7a4a, 0x8a5a2a], bins: [0x8a8a8a, 0x8a5a5a], shoes: [0x232425, 0x3a2a22], books: [0x5a3a22, 0x4a3a3a] };
const FAR_H = { produce: 0.75, citrus: 0.75, flowers: 0.85, clothes: 1.45, news: 1.2, bakery: 0.85, sacks: 0.5, bins: 0.85, shoes: 1.0, books: 0.95 };

/**
 * Add stand st (planned on a front with frame `frame`) to the kit. Near (q >= 0.5): the
 * full stand; far: two blocks.
 */
export function buildStand(kit, st, frame, q) {
  // the stand's frame: on the paving at its footprint's middle, sheared to the paving's fall
  const M = _m.copy(frame.matrix).multiply(_t.makeTranslation(st.uc, st.g, st.wc));
  M.multiply(_s.set(1, 0, 0, 0, st.gU, 1, st.gW, 0, 0, 0, 1, 0, 0, 0, 0, 1));
  if (q < 0.5) {
    const [c0, c1] = FAR_COL[st.kind] || FAR_COL.bins, h = FAR_H[st.kind] || 0.8;
    const t = cache.get(`far|${st.W.toFixed(2)}|${st.D.toFixed(2)}|${h}`, () => {
      const b = new Tpl(); b.box(-st.W / 2, 0, -st.D / 2, st.W / 2, h * 0.75, st.D / 2, 1 | 4 | 8 | 32, 0.55, 0.75); return b.bake();
    });
    const tt = cache.get(`farTop|${st.W.toFixed(2)}|${st.D.toFixed(2)}|${h}`, () => {
      const b = new Tpl(); b.box(-st.W / 2 + 0.03, h * 0.75, -st.D / 2 + 0.03, st.W / 2 - 0.03, h, st.D / 2 - 0.03, 1 | 4 | 8 | 32, 0.8, 1); return b.bake();
    });
    const a = lin(c0), b = lin(c1);
    kit.get('standPaint').add(t, M, a[0], a[1], a[2]);
    kit.get('standPaint').add(tt, M, b[0], b[1], b[2]);
    return;
  }
  const r = new RNG(st.seed);
  const parts = BUILDERS[st.kind](st, r, q);
  const KEY = { paint: 'standPaint', metal: 'metal', cloth: 'awning', text: 'signText', produce: 'produce', wood: 'standWood' };
  for (const p of parts) {
    const m = p.m ? _r.copy(M).multiply(p.m) : M;
    const ex = p.key === 'text' ? { aGlow: [0] } : p.extra;
    kit.get(KEY[p.key]).add(p.tpl, m, p.col[0], p.col[1], p.col[2], ex);
  }
}

const q2 = (x, s) => Math.round(x / s) * s;
