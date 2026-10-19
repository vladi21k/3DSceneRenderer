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
import { cloth } from './dressing.js';
import { printCell } from './signs.js';
import { shopDecision } from './shops.js';

const OUT0 = 0.25;                    // gap between the wall face and the stand
const _m = new THREE.Matrix4(), _s = new THREE.Matrix4(), _t = new THREE.Matrix4(), _r = new THREE.Matrix4();
const _p = new THREE.Vector3();
const cache = new TplCache(240);

// ------------------------------------------------------------------ catalogue
// produce: [colour, radius, x elongation, z elongation, height squash]
const PRODUCE = {
  oranges: [0xd8701a, 0.04, 1, 1, 0.95], lemons: [0xd8c22a, 0.032, 1.3, 1, 0.9], tomatoes: [0xb8241a, 0.036, 1, 1, 0.82],
  apples: [0x9a1e1c, 0.038, 1, 1, 0.9], greenApples: [0x8aa83a, 0.038, 1, 1, 0.9], cucumbers: [0x2f4a1e, 0.022, 4.2, 1, 1],
  aubergines: [0x2a1228, 0.04, 2.2, 1, 0.9], peppers: [0xa81c16, 0.042, 1, 1, 1], yellowPeppers: [0xd8a81a, 0.042, 1, 1, 1],
  potatoes: [0x9a7448, 0.034, 1.25, 1, 0.8], onions: [0xb8843a, 0.035, 1, 1, 0.9], pomegranates: [0x7a1a1e, 0.046, 1, 1, 0.92],
  grapes: [0x3e1830, 0.014, 1, 1, 1], carrots: [0xd0601a, 0.017, 4.5, 1, 1], grapefruit: [0xe0943a, 0.052, 1, 1, 0.95],
  greens: [0x3a6a24, 0.05, 1.4, 1, 0.45], avocados: [0x2e3a1a, 0.038, 1.3, 1, 0.95], bananas: [0xd8b830, 0.03, 3.2, 1.2, 0.6],
};
const GROCER = ['oranges', 'lemons', 'tomatoes', 'apples', 'greenApples', 'cucumbers', 'aubergines', 'peppers', 'yellowPeppers', 'potatoes', 'onions', 'pomegranates', 'grapes', 'carrots', 'greens', 'avocados', 'bananas'];
const CITRUS = ['oranges', 'oranges', 'lemons', 'grapefruit', 'pomegranates', 'oranges'];
const NUTS = [[0x7a4a22, 0.011, 1.6], [0xb4a274, 0.012, 1.3], [0x2e2c28, 0.007, 1.8], [0xb08a52, 0.011, 1.5], [0x6a3418, 0.012, 1.1], [0xc8b48a, 0.009, 1.4]];
const SPICES = [0xa82a14, 0xc8901a, 0x7a5a30, 0x5a6a2e, 0x8a2a1a, 0xb87a2a];
const FLOWERS = [0xb81c2a, 0xe87aa0, 0xf2eee4, 0xe8c22a, 0xe0662a, 0x6a3a8a, 0xf0d8c8, 0xc83a5a, 0xd8a8d0, 0x3a5aa8];
const CLOTH = [0x1d2a44, 0xe8e4da, 0x8a8a86, 0x3a2a22, 0xa8231e, 0x2c6a3a, 0xc9b08a, 0x1c1c1e, 0x7fb2d8, 0xd8879a, 0xe2b630, 0x6b3a72, 0xd0672a, 0x2a5a8a];
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
function heap(t, x0, z0, W, D, y0, r, ex, ez, sy, mound, seed, q, round = false) {
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
        items.push({ x, z, y: y0 + r * sy * (layer ? 1.05 : 0.15) + m + rng.range(-0.15, 0.15) * r, rx: r * ex * rng.range(0.9, 1.1), rz: r * ez * rng.range(0.9, 1.1), ry: r * sy, k: rng.range(0.82, 1.14), a: rng.range(0, 3.14) });
      }
    }
  }
  const res = Math.max(0.0085, r * (q >= 0.5 ? 0.42 : 1.2));
  const gx = Math.max(2, Math.ceil(W / res)), gz = Math.max(2, Math.ceil(D / res));
  const H = new Float32Array((gx + 1) * (gz + 1)), S = new Float32Array((gx + 1) * (gz + 1));
  const floor = y0 - r * 0.2;
  for (let j = 0; j <= gz; j++) {
    for (let i = 0; i <= gx; i++) {
      const x = x0 + (i / gx) * W, z = z0 + (j / gz) * D;
      let h = floor, s = 0.3;
      for (const it of items) {
        // item axes turned by its angle in plan
        const dx0 = x - it.x, dz0 = z - it.z, c = Math.cos(it.a), sn = Math.sin(it.a);
        const dx = (dx0 * c + dz0 * sn) / it.rx, dz = (-dx0 * sn + dz0 * c) / it.rz;
        const q2 = dx * dx + dz * dz;
        if (q2 >= 1) continue;
        const hh = it.y + it.ry * Math.sqrt(1 - q2);
        if (hh > h) { h = hh; s = it.k * (0.5 + 0.5 * Math.sqrt(Math.max(0, 1 - q2))); }
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

/** Vertical cylinder (n sides) of radius r0 at y0 to r1 at y1, with or without a bottom. */
function cyl(t, cx, cz, r0, r1, y0, y1, n, shade = 1, shadeTop = shade) {
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
    t.q4(cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0, cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0,
      cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1, cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1, shade, shadeTop);
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

// ------------------------------------------------------------------ stand builders
// Each returns a list of parts: [key, baked template, colour (linear rgb), extra, local
// matrix or null]. Keys: paint (powder-coat / plastic / produce, casts shadows), metal,
// cloth (awning batch: garments, sway), text (prints and tags).
const PART = (key, tpl, col, extra = null, m = null) => ({ key, tpl, col, extra, m });

function tiltM(y, z, a, x = 0) { return new THREE.Matrix4().makeTranslation(x, y, z).multiply(_r.makeRotationX(a)); }

/** Stepped crates (greengrocer, juice bar): a front and a back row on a covered step. */
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
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < n; i++) {
      const x = -((n - 1) * 0.52) / 2 + i * 0.52;
      const y = row ? stepB : step, z = row ? -0.22 : 0.19;
      const tilt = row ? 0.1 : 0.13;
      const cc = lin(r.weighted(CRATES));
      const H = q2(r.range(0.16, 0.22), 0.02);
      const ct = cache.get(`crate|${cw}|${cd}|${H}`, () => { const t = new Tpl(); crate(t, cw, cd, H); return t.bake(); });
      const m = tiltM(y, z, tilt, x);
      parts.push(PART('paint', ct, cc, null, m));
      const name = list[r.int(0, list.length - 1)];
      const [col, rad, ex, ez, sy] = PRODUCE[name];
      const v = r.int(0, 3);
      const ht = cache.get(`heap|${name}|${cw}|${cd}|${H}|${v}|${q}`, () => {
        const t = new Tpl(); heap(t, -cw / 2 + 0.016, -cd / 2 + 0.016, cw - 0.032, cd - 0.032, H - rad * sy * 0.9, rad, ex, ez, sy, 0.035, 977 * v + name.length * 31, q); return t.bake();
      });
      parts.push(PART('paint', ht, lin(col), null, m));
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
      const sm = cache.get(`stems|${rb}|${hb}|${hd}|${q}`, () => { const t = new Tpl(); cyl(t, 0, 0, rb * 0.7, rb * 0.95, hb - 0.02, hb + hd * 0.55, q >= 0.5 ? 10 : 6, 0.55, 0.8); return t.bake(); });
      parts.push(PART('paint', sm, leaf, null, m));
      const lt = cache.get(`leaves|${rb}|${hb}|${hd}|${v}|${q}`, () => { const t = new Tpl(); heap(t, -rb * 1.3, -rb * 1.3, rb * 2.6, rb * 2.6, hb + hd * 0.3, 0.04, 1.6, 0.7, 0.7, 0.03, 431 * v + 7, q, true); return t.bake(); });
      parts.push(PART('paint', lt, leaf, null, m));
      const [hr, hx, hs] = r.pick([[0.03, 1, 1], [0.045, 1, 0.4], [0.022, 1, 1.5], [0.028, 1, 0.9]]);
      const fl = cache.get(`heads|${rb}|${hb}|${hd}|${hr}|${v}|${q}`, () => { const t = new Tpl(); heap(t, -rb * 1.12, -rb * 1.12, rb * 2.24, rb * 2.24, hb + hd * 0.45, hr, hx, 1, hs, hd * 0.55, 211 * v + 3, q, true); return t.bake(); });
      parts.push(PART('paint', fl, lin(r.pick(FLOWERS)), null, m));
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
  for (let i = 0; i < nG; i++) {
    if (i % run === 0) { c1 = lin(r.pick(CLOTH)); c2 = lin(r.pick(CLOTH)); }
    const tp = cloth(i % 5 === 4 ? r.pick(kinds) : kind);
    const len = tp.len;
    const x = -W / 2 + 0.07 + i * ((W - 0.14) / Math.max(1, nG - 1));
    // a hanger's hook over the rail; the garment faces along the rail, swaying a little
    const m = new THREE.Matrix4().makeTranslation(x, top - 0.035, 0).multiply(_r.makeRotationY((i % 2 ? 1 : -1) * Math.PI / 2 + r.range(-0.12, 0.12)));
    if (top - 0.035 - len < 0.12) m.multiply(_t.makeScale(1, (top - 0.17) / len, 1));
    const stripe = r.chance(0.2) ? r.range(0.03, 0.07) : 0;
    parts.push(PART('cloth', tp, c1, { aStripe: [c2[0], c2[1], c2[2], stripe], aFlex: (k, v, a, j) => { a[j] = Math.min(1, Math.max(0, -v[k * VS + 1] / len)) * 0.5; } }, m));
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

/** Trestle with bakery trays of loaves, rolls or pastries. */
function bakeryTable(st, r, q) {
  const parts = [];
  const W = st.W, D = 0.55, H = 0.78;
  const tb = cache.get(`btable|${W.toFixed(2)}`, () => {
    const t = new Tpl();
    t.box(-W / 2, H - 0.03, -D / 2, W / 2, H, D / 2, 1 | 2 | 4 | 8 | 16 | 32, 0.9, 1);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) bar(t, [sx * (W / 2 - 0.05), 0, sz * (D / 2 - 0.05)], [sx * (W / 2 - 0.05), H - 0.03, sz * (D / 2 - 0.05)], 0.03);
    return t.bake();
  });
  parts.push(PART('paint', tb, lin(r.pick([0xc8b89a, 0x6c4529, 0xe2dfd4]))));
  const n = 3, tw = (W - 0.08) / n;
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + 0.04 + tw * (i + 0.5);
    const tr = cache.get(`tray|${tw.toFixed(2)}`, () => { const t = new Tpl(); crate(t, tw - 0.02, D - 0.06, 0.04); return t.bake(); });
    const m = tiltM(H, 0, 0.08, x);
    parts.push(PART('paint', tr, [0.5, 0.5, 0.5], null, m));
    const kind = r.pick([[0xb06a28, 0.05, 2.2, 1, 0.7], [0xc89048, 0.035, 1, 1, 0.75], [0x8a4a1e, 0.045, 1.6, 1, 0.75], [0xd8a868, 0.06, 1, 1, 0.3], [0xa8602a, 0.03, 1.3, 1, 0.8]]);
    const v = r.int(0, 3);
    const ht = cache.get(`bread|${tw.toFixed(2)}|${kind[0]}|${v}|${q}`, () => { const t = new Tpl(); heap(t, -(tw - 0.06) / 2, -(D - 0.1) / 2, tw - 0.06, D - 0.1, 0.03, kind[1], kind[2], kind[3], kind[4], 0.01, 53 * v + kind[0] % 97, q); return t.bake(); });
    parts.push(PART('paint', ht, lin(kind[0]), null, m));
  }
  if (q >= 0.5) {
    const tt = new Tpl(); card(tt, printCell('tags', r.int(0, 15)), r.range(-0.2, 0.2), H + 0.12, 0.2, 0.11, 0.25);
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
        cyl(t, 0, 0, rb * 0.92, rb, 0, hb - 0.06, ns, 0.7, 0.95);
        // the rolled-down rim, a fat roll of cloth
        cyl(t, 0, 0, rb, rb * 1.12, hb - 0.06, hb - 0.03, ns, 0.95, 1.05);
        cyl(t, 0, 0, rb * 1.12, rb * 0.98, hb - 0.03, hb, ns, 1.05, 0.85);
        return t.bake();
      });
      const m = new THREE.Matrix4().makeTranslation(x, 0, z);
      parts.push(PART('paint', sk, lin(r.pick([0x9a7a4a, 0x8a6a3e, 0xb09060, 0xd8d0b8])), null, m));
      const v = r.int(0, 3);
      if (r.chance(0.4)) {
        // ground spice: one smooth cone
        const ct = cache.get(`spice|${rb}|${hb}|${v}`, () => { const t = new Tpl(); heap(t, -rb * 0.95, -rb * 0.95, rb * 1.9, rb * 1.9, hb - 0.06, rb * 0.9, 1, 1, 0.55, 0.0, 17 * v + 1, 0, true); return t.bake(); });
        parts.push(PART('paint', ct, lin(r.pick(SPICES)), null, m));
      } else {
        const [col, rad, ex] = r.pick(NUTS);
        const nt = cache.get(`nuts|${rad}|${ex}|${rb}|${hb}|${v}|${q}`, () => { const t = new Tpl(); heap(t, -rb * 0.92, -rb * 0.92, rb * 1.84, rb * 1.84, hb - 0.035, rad, ex, 1, 0.8, rb * 0.25, 71 * v + 5, q, true); return t.bake(); });
        parts.push(PART('paint', nt, lin(col), null, m));
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
  const W = st.W, D = 0.55, H = 0.62, bh = 0.2;
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
    t.box(-W / 2, H - 0.2, D / 2 - 0.02, W / 2, H + 0.06, D / 2, 1 | 2 | 4 | 8 | 32, 0.9, 1);
    t.box(-W / 2, H - 0.2, -D / 2, W / 2, H + 0.06, -D / 2 + 0.02, 1 | 2 | 4 | 8 | 32, 0.85, 1);
    t.box(-W / 2, H - 0.2, -D / 2, -W / 2 + 0.02, H + 0.06, D / 2, 4 | 8 | 32, 0.85, 1);
    t.box(W / 2 - 0.02, H - 0.2, -D / 2, W / 2, H + 0.06, D / 2, 4 | 8 | 32, 0.85, 1);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) t.box(sx * (W / 2 - 0.04) - 0.02, 0.08, sz * (D / 2 - 0.04) - 0.02, sx * (W / 2 - 0.04) + 0.02, H - 0.2, sz * (D / 2 - 0.04) + 0.02, 1 | 2 | 4 | 8, 0.7, 0.9);
    return t.bake();
  });
  parts.push(PART('paint', ct, lin(r.pick([0x5a3a22, 0x6c4529, 0x2d4033]))));
  const bt = new Tpl();
  const cols = [];
  for (let row = 0; row < 2; row++) {
    let x = -W / 2 + 0.03;
    const z0 = row ? -0.2 : 0.02, z1 = row ? -0.02 : 0.2;
    while (x < W / 2 - 0.05) {
      const th = r.range(0.018, 0.045), hh = r.range(0.16, 0.24);
      bt.piece(0.22).box(x, H - 0.18, z0 + r.range(0, 0.02), x + th, H - 0.18 + hh, z1 - r.range(0, 0.03), 1 | 2 | 4 | 8 | 32, 0.85, 1);
      x += th + 0.002;
    }
  }
  // books in the shade bands of the piece() jitter; one dusty colour each row is enough
  parts.push(PART('paint', bt.bake(), lin(r.pick([0x6a3a2a, 0x2a3a4a, 0x5a4a2a, 0x3a4a3a]))));
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
  const KEY = { paint: 'standPaint', metal: 'metal', cloth: 'awning', text: 'signText' };
  for (const p of parts) {
    const m = p.m ? _r.copy(M).multiply(p.m) : M;
    const ex = p.key === 'text' ? { aGlow: [0] } : p.extra;
    kit.get(KEY[p.key]).add(p.tpl, m, p.col[0], p.col[1], p.col[2], ex);
  }
}

const q2 = (x, s) => Math.round(x / s) * s;
