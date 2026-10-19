// Placement of infill for one facade front (a lot's street face or a corner return):
// picks templates, colours and interior parameters for each opening and appends them to
// the chunk kit. Local coordinates per opening: x across, y up from the sill, z out of
// the infill plane (w = −recess); wall-mounted items use the wall face (w = 0).
import * as THREE from 'three';
import { RNG, hashStr } from '../../core/rng.js';
import { Tpl, TplCache, VS, lin } from './geo.js';
import { joineryStyle, joineryTpl, glassTpl, shutterTpl, rollerTpl, canOpen, openLimit } from './windows.js';
import { shopDecision, shopTpls, SHOP_FW } from './shops.js';
import { doorLayout, doorTpls } from './doors.js';
import { signDesign, fasciaTpls, bladeTpls, bladeFace, plaqueTpl, signColor, wordType, wordSub, flagTpls, discTpls, bladeNameTpls, letteringTpls, tradeIcon, subWordsOf, wordHebrew, N_NAMES, LINE_KIND, inkOn, lineCell, cellTpl } from './signs.js';
import { winCode, shopTypeIndex } from './interior.js';
import { spillTpl, spillAttrs, groundGlow, shopSpill } from './spill.js';
import { dressWindow, hangGoods, dressRequest, allocateBlock } from './dressing.js';
import { facadePlan } from '../facadePlan.js';
import { slopeAwningT as slopeAwning, domeAwningT as domeAwning, awningColors } from './awnings.js';
import { crownY, springY, isArched, halfWidthAt, outlinePts, inRustic, rusticOff, RUSTIC_RELIEF } from './outline.js';
import { swatch, weather } from './kit.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const _m = new THREE.Matrix4(), _t = new THREE.Matrix4(), _r = new THREE.Matrix4(), _ms = new THREE.Matrix4();
const IDENT = new THREE.Matrix4();

const DOOR_COLORS = { brown: 0x4a2e1c, varnish: 0x5e3b20, green: 0x283f30, blue: 0x2b5068, black: 0x1d1d1e, red: 0x561c19 };
const ROLLER = [0xb9b7b0, 0xd4d1c8, 0x8c8e8c, 0xc9bfa8, 0x9aa09a, 0x6e7a72];
// local z of a lowered roller curtain's front (shops.js: casing front − 2 cm + 3 cm + corrugation)
const ZF_SHUT = 0.04 - 0.02 + 0.03 + 0.014;
const BRASS = lin(0xb08a45), BLACK_IRON = [0.035, 0.035, 0.037];
/** Shops without a sign: what they sell. */
const SHOP_MIX = [['clothing', 0.22], ['general', 0.24], ['cafe', 0.14], ['jewellery', 0.09], ['pharmacy', 0.05], ['shoes', 0.11], ['books', 0.07], ['flowers', 0.08]];
/** Trades that cluster (a run of fashion shops, cafés side by side); any other trade does not repeat within two shops. */
const CLUSTER = new Set(['clothing', 'cafe']);
/**
 * Trades a street side has only so many of: on the main street a shop may follow one of
 * them only inside that trade's slot of its block (14 m in every `block` metres of a side,
 * placed by a hash), so three pharmacies never line one stretch.
 */
const RARE = { pharmacy: 75, jewellery: 45, books: 60, flowers: 55, shoes: 40 };
function tradeAllowed(app, lot, frame, plan, o, type) {
  const B = RARE[type];
  if (!B || lot.sideStreet || lot.backdrop) return true;
  const s = openingS(app, lot, frame, plan, o);
  const b = Math.floor(s / B);
  const h = RNG.from('trade', type, b, lot.side).next();
  const s0 = b * B + h * (B - 14);
  return s >= s0 && s < s0 + 14;
}

/** Share of the shops the plan gives no sign that put up their own (fascia, head panel or valance). */
const EXTRA_SIGN = 0.8;
/** Share of the shops of each trade with a projecting sign on a pier beside them. */
const PROJ = { clothing: 0.62, general: 0.66, cafe: 0.55, jewellery: 0.66, pharmacy: 0.9, shoes: 0.62, books: 0.55, flowers: 0.55 };
/** The narrower trade of a general store or café whose sign does not say. */
const SUBDRAW = { general: [['grocery', 0.36], ['kiosk', 0.16], ['toys', 0.14], ['nuts', 0.14], ['sweets', 0.06], [null, 0.14]], cafe: [['bakery', 0.14], ['juice', 0.12], [null, 0.74]] };

// ------------------------------------------------------------------ shop names
// Every shop trades under a name of its own (signs.js NAMES). On the main street the
// names are given out along the loop, both sides together in order of s, each shop taking
// the name used longest ago, so a name comes back only after every other one has been
// used (~50 shops, a few hundred metres); side streets draw theirs from the shop's id.
let NAME_TAB = null;
function nameTable(app) {
  if (NAME_TAB) return NAME_TAB;
  const list = [];
  for (const lot of app.layout.lots) {
    if (lot.sideStreet || !lot.frame) continue;
    let plan;
    try { plan = facadePlan(lot); } catch (e) { continue; }
    for (const fr of frontsOf(app, lot, plan)) {
      for (const o of fr.plan.openings) if (o.kind === 'shop') list.push({ id: o.id, s: openingS(app, lot, fr.frame, fr.plan, o) });
    }
  }
  list.sort((a, b) => a.s - b.s || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // ties (names never used yet) in a fixed shuffled order
  const r = new RNG(0x5a1e5);
  const order = Array.from({ length: N_NAMES }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = r.int(0, i); [order[i], order[j]] = [order[j], order[i]]; }
  const last = new Float64Array(N_NAMES).fill(-1e9), L = app.route.length;
  const tab = new Map();
  // (two passes: the second continues past the loop's wrap with the first's history)
  for (let pass = 0; pass < 2; pass++) {
    for (const it of list) {
      let best = order[0], bs = Infinity;
      for (let k = 0; k < N_NAMES; k++) { const n = order[k]; if (last[n] < bs) { bs = last[n]; best = n; } }
      last[best] = it.s + pass * L;
      if (pass) tab.set(it.id, best);
    }
  }
  return (NAME_TAB = tab);
}
/** The name (index into signs.js NAMES) shop opening o trades under. */
function nameOf(app, o) {
  const n = nameTable(app).get(o.id);
  return n ?? (hashStr(String(o.id)) % N_NAMES);
}
// accents for logo marks and second lines
const ACCENTS = [0xc8231c, 0xe0a81c, 0xf4f1e8, 0x1f4fa0, 0xd8b25a, 0x2a7a3a];
/**
 * A shop's identity, the same on every sign it puts up: its name (both lines, the Hebrew
 * or the English alone), a second line (its trade in the other language, a phone number,
 * the year it opened, a tagline) on about three shops in five, a logo mark on a third,
 * and its colours (the board's and the lettering's; design: its fascia design if it has
 * one).
 */
function makeBrand(app, o, type, sub, design) {
  const r = RNG.from(o.id, 'brand');
  const nv = r.weighted([[0, 0.55], [1, 0.28], [2, 0.17]]);
  let sb = null;
  const ks = r.next();
  if (ks < 0.42) {
    const words = subWordsOf(type);
    const want = nv === 1 ? false : nv === 2 ? true : r.chance(0.5);
    const pref = words.filter((w) => wordHebrew(w) === want);
    const pool = pref.length ? pref : words;
    if (pool.length) sb = { w: pool[r.int(0, pool.length - 1)] };
  } else if (ks < 0.64) {
    const kind = type === 'cafe' && r.chance(0.5) ? r.pick([18, 18, 19]) : null;
    const [a, b] = r.chance(0.62) ? LINE_KIND.phone : r.chance(0.6) ? LINE_KIND.year : LINE_KIND.tagline;
    sb = { l: kind ?? r.int(a, b) };
  }
  const d = design || signDesign(r.int(0, 1 << 30), 'board', type);
  const board = d.board ?? r.pick([0x1d1d1f, 0x1f3a2c, 0x5a1a1c, 0x1b2b45, 0xb8261e, 0x1f4fa0]);
  const ink = d.board != null ? d.ink : inkOn(board, r);
  const acc = ACCENTS.filter((c) => c !== board && c !== ink);
  return {
    name: nameOf(app, o), nv, sub: sb,
    logo: r.chance(0.34) ? tradeIcon(type, sub, r) : -1, logoRight: r.chance(0.4),
    accent: r.chance(0.5) ? ink : r.pick(acc), subAccent: r.chance(0.25),
    board, ink,
  };
}
/** The text fields of a brand, to merge into a sign design. */
const brandText = (b) => ({ name: b.name, nv: b.nv, sub: b.sub, logo: b.logo, logoRight: b.logoRight, accent: b.accent, subAccent: b.subAccent });
/** Cache key of a design's lettering. */
const dkey = (d) => `${d.cell}|${d.name ?? ''}|${d.nv ?? ''}|${d.sub ? (d.sub.w ?? 'l' + d.sub.l) : ''}|${d.logo ?? ''}|${d.logoRight ? 1 : 0}|${d.subAccent ? 1 : 0}`;

/**
 * Depth available behind the infill plane before the back of the dark box with which
 * the buildings close every opening (facadePlan publishes it per opening).
 */
export const backDepth = (o) => o.backDepth ?? 0.4;

/** Matrix for an opening's local frame. */
function openingMatrix(frame, o, out = _m) {
  return out.copy(frame.matrix).multiply(_t.makeTranslation(o.uc, o.y, -o.recess));
}
/** Matrix for a point on the wall face (u, v), z in front of it. */
function wallMatrix(frame, u, v, out = _m, z = 0) {
  return out.copy(frame.matrix).multiply(_t.makeTranslation(u, v, z));
}

/** Light from the room onto the reveal of opening o (drawn at night only, see spill.js). */
function addSpill(kit, ctx, o, m, lit, kind, dim = 0) {
  const sp = spillTpl(o, ctx.q);
  kit.get('spill').add(sp.tpl, m, 1, 1, 1, spillAttrs(lit, kind, dim, sp));
}

/** Interior glass attributes for an opening with glass at local depth zRef. */
export function glassAttrs(ctx, o, { W, H, D, roomY0, seed, drape, kind, type = 0, zRef = -0.012, lit = o.lit, recess = o.recess, door = null }) {
  const winY0 = o.y - roomY0, winY1 = winY0 + o.h;
  const baseH = roomY0 - ctx.plan.groundAt(o.uc);
  // (a shop also packs the x of its door, so its window displays keep out of the doorway)
  const hw = door == null ? o.w / 2 : o.w / 2 + 10 * Math.round((Math.max(-3.9, Math.min(3.9, door)) + 4) * 100);
  return {
    aRoomP: (k, v, a, i) => { const o = k * VS; a[i] = W / 2 + v[o]; a[i + 1] = winY0 + v[o + 1]; a[i + 2] = Math.max(0, zRef - v[o + 2]); a[i + 3] = hw; },
    aRoomS: [W, H, D, baseH],
    aWin: [seed, lit, drape, winCode(kind, false, type)],
    aFac: [ctx.angle, Math.floor(ctx.streetW) + Math.min(0.95, recess), winY0, winY1], // street width + recess packed
    aFrame: [0, 0, 0, 0],
  };
}

/**
 * Share of a lit room's light held back from its reveals by the drapes (type + amount,
 * see interior.js): curtains and blinds pass ~40–60% of the light through the fabric.
 */
function drapeDim(drape) {
  const type = Math.floor(drape), amt = drape - type;
  if (type === 1 || type === 3) return amt * 0.6;     // curtains closed by amt / blind down by amt
  if (type === 2) return 0.4 + 0.15 * amt;            // sheers over the whole window
  if (type === 4) return amt * 0.5;                   // venetian blind
  return 0;
}

// ------------------------------------------------------------------ windows
function buildWindow(kit, ctx, o) {
  const plan = ctx.plan;
  const m = openingMatrix(ctx.frame, o);
  const v = ctx.joinery;
  const r = RNG.from(o.id);
  const fc = weather(ctx.frameRGB, r);
  // per-opening offset into the joinery detail bakes (tile 1 m; v kept clear of the putty line)
  const du = r.next(), dv = 0.3 + 0.4 * r.next();
  // summer: some casements stand open, swung into the room
  const ro = r.next();
  let open = ctx.q >= 0.5 && o.shutters !== 'closed' && canOpen(o, v) && ro < (o.kind === 'balconyDoor' ? 0.12 : 0.08)
    ? { side: ro < 0.04 ? -1 : 1, angle: Math.round((0.9 + r.next() * 0.7) * 10) / 10 } : null;
  if (open) {
    // the leaf swings into the dark box behind the opening: keep it inside
    const lim = Math.floor(openLimit(o, v, backDepth(o)) * 10) / 10;
    if (lim < 0.35) open = null; else open.angle = Math.min(open.angle, lim);
  }
  const jt = joineryTpl(o, v, ctx.q, open);
  if (jt) kit.get('frame').add(jt, m, fc[0], fc[1], fc[2], null, du, dv);
  const floor = plan.floors[o.floor];
  const bay = plan.bays[o.bay];
  const roomY0 = floor.y + 0.02;
  const W = clamp(bay ? bay.w : 3.6, Math.max(2.4, o.w + 0.5), 4.8);
  const H = Math.max(2.4, floor.h - 0.3);
  const D = 3.4 + r.next() * 1.8;
  const seed = r.next();
  let drape = 0;
  const dr = r.next();
  if (o.curtain) drape = (dr < 0.33 ? 1 : dr < 0.62 ? 2 : dr < 0.84 ? 3 : 4) + 0.1 + r.next() * 0.8;
  else if (dr < 0.2) drape = 3 + 0.05 + r.next() * 0.35;
  const ga = glassAttrs(ctx, o, { W, H, D, roomY0, seed, drape, kind: 0 });
  if (!jt) ga.aFrame = [fc[0] * 0.88, fc[1] * 0.88, fc[2] * 0.88, 1]; // far range: procedural casing (× the paint bake's albedo)
  const gt = glassTpl(o, v, ctx.q, open);
  kit.get('glass').add(gt.glass, m, 1, 1, 1, ga);
  if (gt.hole) kit.get('glass').add(gt.hole, m, 1, 1, 1, { ...ga, aWin: [seed, o.lit, drape, winCode(0, true)] }); // no glass: open aperture
  if (o.shutters !== 'closed') addSpill(kit, ctx, o, m, o.lit, 0, drapeDim(drape));
  // external roller shutters on flat heads (modern and some Mandate facades; nearly every
  // window of a rendered block, whose aluminium joinery comes with them)
  const rollerP = v.type === 'alu' ? (plan.style.finish === 'render' ? 0.9 : 0.75) : plan.style.era === 'mandate' ? 0.18 : 0.04;
  const shut = o.shutters === 'none' ? null : o.shutters;
  if ((shut === 'roller' || (!shut && o.top === 'flat' && o.recess > 0.15 && r.next() < rollerP))) {
    const rr = r.next();
    // (a plan's own roller gives the share let down)
    const down = shut === 'roller' ? Math.min(1, Math.max(0, o.roller ?? 1)) : rr < 0.35 ? 0 : rr < 0.8 ? 0.15 + r.next() * 0.5 : 1;
    const rc = lin([0xd9d6cc, 0xc9c2b2, 0x9a9a96, 0xe6e3da][Math.floor(r.next() * 4)]);
    kit.get('joinery').add(rollerTpl(o, down, ctx.q), m, rc[0], rc[1], rc[2]);
  }
  if (shut && shut !== 'roller') {
    const sc = weather(ctx.shutterRGB, r, 1.3);
    // open leaves lie on the wall face, clear of a projecting stone surround (and of the
    // bosses of a rusticated ground floor)
    const standoff = Math.max(plan.style.surrounds ? 0.055 : 0.012, inRustic(plan, o.y + o.h / 2) ? RUSTIC_RELIEF + 0.01 : 0);
    const state = o.shutters === 'open' ? fitOpenShutters(ctx, o, standoff) : o.shutters;
    // open leaves are built relative to the wall face (shared by windows of any recess)
    const ms = state === 'open' || state === 'openSpring' ? _ms.copy(m).multiply(_r.makeTranslation(0, 0, o.recess)) : m;
    kit.get('shutter').add(shutterTpl(o, state, ctx.q, standoff), ms, sc[0], sc[1], sc[2], null, du, dv);
  }
}

// ------------------------------------------------------------------ shutter fit
/**
 * Wall relief that open shutter leaves must not cross, as (u0, u1, y0, y1) rectangles on
 * the front: balcony slabs and the consoles under them (exact when the plan lists them,
 * else the whole band where consoles may hang), pilasters, neighbouring openings with
 * their dressing, and the ends of the front.
 */
function wallObstacles(plan) {
  const out = [];
  for (const b of plan.balconies || []) {
    const T = b.slabT || 0.16, soffit = b.y - T;
    out.push([b.u0 - 0.05, b.u1 + 0.05, soffit, b.y - 0.02]);
    if (b.consoles) for (const c of b.consoles) out.push([c.u - 0.17, c.u + 0.17, soffit - c.h - 0.08, soffit]);
    else out.push([b.u0, b.u1, soffit - 0.85, soffit]);
  }
  if (plan.style.pilasters && plan.floors.length > 2 && plan.courses?.length) {
    const v0 = plan.courses[0].y + plan.courses[0].h;
    for (const b of plan.bays) if (b.index > 0) out.push([b.u0 - 0.3, b.u0 + 0.3, v0, plan.totalHeight]);
  }
  for (const n of plan.openings) out.push([n.uc - n.w / 2 - 0.24, n.uc + n.w / 2 + 0.24, n.y - 0.1, n.y + n.h + 0.3, n]);
  out.push([-1e3, 0.08, -1e3, 1e3], [plan.width - 0.08, 1e3, -1e3, 1e3]);
  return out;
}

/** 'open', 'openSpring' (arched head, leaves to the spring line) or 'reveal' (folded in). */
function fitOpenShutters(ctx, o, standoff) {
  const obs = ctx.obstacles || (ctx.obstacles = wallObstacles(ctx.plan));
  const hw = o.w / 2, gap = standoff > 0.03 ? 0 : 0.05;
  const clash = (top) => {
    const y0 = o.y + 0.01, y1 = o.y + top;
    for (const [a, b] of [[o.uc - 2 * hw - gap - 0.03, o.uc - hw - gap], [o.uc + hw + gap, o.uc + 2 * hw + gap + 0.03]]) {
      for (const r of obs) {
        if (r[4] === o) continue;
        if (a < r[1] && b > r[0] && y0 < r[3] && y1 > r[2]) return true;
      }
    }
    return false;
  };
  return !clash(crownY(o)) ? 'open' : isArched(o) && !clash(springY(o)) ? 'openSpring' : 'reveal';
}

// ------------------------------------------------------------------ signs
/** Decide where each fascia sign goes relative to the opening beneath it. */
function planSigns(ctx) {
  const plan = ctx.plan;
  const byOpening = new Map(), wall = [];
  const ceiling = (plan.floors[1] ? plan.floors[1].y : plan.totalHeight) - 0.12;
  for (const s of plan.signs || []) {
    if (s.kind !== 'fascia') continue;
    const o = plan.openings.find((x) => x.floor === 0 && x.uc > s.u0 && x.uc < s.u1);
    const design = signDesign(s.seed);
    if (!o) { wall.push({ s, design, y: s.y, h: s.h, lamps: false }); continue; }
    if (o.kind !== 'shop') continue;
    const crown = o.y + crownY(o);
    if (hasAwning(ctx, o)) { byOpening.set(o.id, { mode: 'valance', design }); continue; }
    // clear the voussoir ring of an arched head (or the lintel of a flat one) ...
    const clear = crown + (isArched(o) ? 0.6 : 0.1);
    // ... and first-floor balcony slabs with their corbels
    let top = ceiling;
    for (const b of plan.balconies || []) {
      if (b.floor === 1 && b.u1 > s.u0 - 0.2 && b.u0 < s.u1 + 0.2) top = Math.min(top, b.y - (b.slabT || 0.16) - 0.62);
    }
    const y = Math.max(s.y, clear), h = Math.min(s.h, top - y);
    if (h >= 0.32) wall.push({ s, design, y, h, o, lamps: top - (y + h) > 0.3 });
    else byOpening.set(o.id, { mode: 'head', design });
  }
  // under a café awning the cassette takes the fascia band: wall signs there go (the
  // café's name is on the valance). The sign panels in the arch heads become the café's:
  // one colour, its name on the first only
  const aw = ctx.cafeAwning;
  if (aw) {
    for (let i = wall.length - 1; i >= 0; i--) if (aw.covers(wall[i].s.u0, wall[i].s.u1)) wall.splice(i, 1);
    let head = null;
    for (const [id, si] of byOpening) {
      if (si.mode === 'valance') { byOpening.delete(id); continue; }
      si.noText = !!head;
      head = head || { ...si.design, cell: aw.design.cell };
      si.design = head;
    }
  }
  return { byOpening, wall };
}

/**
 * A sign's board and lettering at matrix m: the board's paint faded by the sun (wear:
 * 0 new .. 1 old), the lettering a little less; the logo mark in the accent colour.
 * compact: the name alone on one line.
 */
function addSignText(kit, design, m, w, h, q, glow = design.glow, z0 = 0.055, compact = false, wear = 0) {
  const tp = fasciaTpls(design, w, h, q, z0, compact);
  const wr = RNG.from(dkey(design), Math.round(w * 100), 'wear');
  const ink = wear > 0 ? weather(signColor(design.ink), wr, wear * 0.8) : signColor(design.ink);
  if (tp.board) {
    const bc = wear > 0 ? weather(signColor(design.board), wr, wear * 1.6) : signColor(design.board);
    kit.get(glow > 0 ? 'signBoard' : 'board').add(tp.board, m, bc[0], bc[1], bc[2], { aGlow: [glow] });
  }
  kit.get('signText').add(tp.text, m, ink[0], ink[1], ink[2], { aGlow: [glow] });
  if (tp.accent) {
    const ac = signColor(design.accent ?? design.ink);
    kit.get('signText').add(tp.accent, m, ac[0], ac[1], ac[2], { aGlow: [glow] });
  }
}
/** m turned about its local z (the wall's normal) by a few tenths of a degree: hung out of true. */
function crooked(m, r, amp = 0.012) { return m.multiply(_r.makeRotationZ(r.range(-amp, amp))); }

function buildWallSign(kit, ctx, ws) {
  const { s, design, y, h } = ws;
  const w = s.u1 - s.u0;
  const m = crooked(wallMatrix(ctx.frame, (s.u0 + s.u1) / 2, y + h / 2), RNG.from(ctx.plan.seed, s.u0, 'crooked'), 0.01);
  // over rustication the board stands ~0.1 m off the wall plane, clear of the bosses
  addSignText(kit, design, m, w, h, ctx.q, design.glow, inRustic(ctx.plan, y) ? 0.1 : 0.055, false, RNG.from(ctx.plan.seed, s.u0, 'age').range(0.2, 1));
  // gooseneck lamps over painted boards
  if (design.type === 'board' && ws.lamps && ctx.q >= 0.5) {
    const n = w > 2.4 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const u = s.u0 + (w * (i + 0.5)) / n;
      const ml = wallMatrix(ctx.frame, u, y + h + 0.06, new THREE.Matrix4(), rusticOff(ctx.plan, y + h + 0.06));
      kit.get('metal').add(ctx.assets.signLamp.metal, ml, ...BLACK_IRON);
      kit.get('bulb').add(ctx.assets.signLamp.glass, ml);
    }
  }
}

/**
 * Projecting blade sign on the pier at s.u, hung clear of first-floor balconies (slab
 * and corbels) and of the awnings either side; its face advertises the nearest shop.
 */
function buildBlade(kit, ctx, s, shopTypes) {
  const plan = ctx.plan;
  const f1 = plan.floors[1];
  let top = f1 ? f1.y + 0.8 : plan.totalHeight - 0.5;   // top of sign + bracket
  for (const b of plan.balconies || []) {
    if (b.floor === 1 && s.u > b.u0 - 0.9 && s.u < b.u1 + 0.9) top = Math.min(top, b.y - (b.slabT || 0.16) - 0.55);
  }
  let y = Math.min(s.y, top - s.h - 0.15);
  let near = null, nd = 4;
  for (const o of plan.openings) {
    if (o.floor !== 0) continue;
    if (o.kind === 'shop' && Math.abs(o.uc - s.u) < nd) { nd = Math.abs(o.uc - s.u); near = o; }
    if (!hasAwning(ctx, o) || Math.abs(s.u - o.uc) > o.w / 2 + 0.45) continue;
    // an awning beside the pier: hang the sign above its cassette
    const awTop = o.y + crownY(o) + 0.35, awBot = o.y + crownY(o) - 1.2;
    if (y < awTop && y + s.h + 0.15 > awBot) y = awTop;
  }
  const aw = ctx.cafeAwning;
  if (aw && aw.covers(s.u - 0.6, s.u + 0.6)) y = Math.max(y, aw.top + 0.3);
  if (y + s.h + 0.15 > top + 1e-3 || y - plan.groundAt(s.u) < 2.5) return;
  const r = new RNG(s.seed);
  const m = wallMatrix(ctx.frame, s.u, y, _m, rusticOff(plan, y));
  const type = near ? shopTypes.get(near.id) : null;
  addProjecting(kit, ctx, m, 'blade', near ? ctx.brands.get(near.id) : null, type, [q2(s.w, 0.02), q2(s.h, 0.02)], s.seed, r);
}

/**
 * A projecting sign of `kind` at matrix m (on the wall face, the sign's bottom at the
 * origin): a light box or painted box with the shop's name ('flag'), a disc or a square
 * blade carrying its logo mark and name in its colours; about one disc or blade in seven
 * (and those of no shop) shows one of the stock pictogram faces instead. Faded by its
 * age, hung a little out of true. dims: flag [L, h, th], disc [D], blade [w, h].
 */
function addProjecting(kit, ctx, m, kind, brand, type, dims, seed, r) {
  const q = ctx.q >= 0.5 ? 1 : 0.4;
  const wear = r.range(0.15, 1);
  m.multiply(_r.makeRotationX(r.range(-0.02, 0.02)));
  const stock = !brand || (kind !== 'flag' && r.chance(0.15));
  const fade = (hex, k) => weather(lin(hex), r, wear * k);
  let tp, board, ink, glow, kBoard;
  if (kind === 'flag') {
    const lightbox = r.chance(0.7);
    const base = signDesign(seed, lightbox ? 'lightbox' : 'board', type);
    const own = brand && (!lightbox || r.chance(0.55));
    const design = brand ? { ...base, ...brandText(brand), board: own ? brand.board : base.board, ink: own ? brand.ink : base.ink } : base;
    tp = projCache.get(`F|${dkey(design)}|${dims.join('|')}|${q}`, () => flagTpls(design, dims[0], dims[1], dims[2], q));
    board = fade(design.board, lightbox ? 0.6 : 1.4); ink = fade(design.ink, 0.6); glow = lightbox ? 1 : 0;
    kBoard = glow ? 'signBoard' : 'board';
    if (tp.accent) { const ac = fade(design.accent ?? design.ink, 0.6); kit.get('signText').add(tp.accent, m, ac[0], ac[1], ac[2], { aGlow: [glow] }); }
  } else if (stock) {
    const face = bladeFace(seed, type, kind === 'disc');
    tp = kind === 'disc' ? projCache.get(`D|${face}|${dims[0]}|${q}`, () => discTpls(face, dims[0], q))
      : projCache.get(`B|${face}|${dims.join('|')}|${q}`, () => bladeTpls(face, dims[0], dims[1], q));
    board = fade(r.pick([0xe8e4da, 0x1d1d1f, 0xd8b25a, 0xb8b8b4]), 1); ink = fade(0xffffff, 0.5);
    glow = r.chance(kind === 'disc' ? 0.5 : 0.35) ? 0.75 : 0;
    kBoard = glow && kind === 'disc' ? 'signBoard' : 'board';
  } else {
    const design = { type: 'board', cell: 0, board: brand.board, ink: brand.ink, glow: 0, ...brandText(brand) };
    tp = kind === 'disc' ? projCache.get(`DN|${dkey(design)}|${dims[0]}|${q}`, () => discTpls(-1, dims[0], q, design))
      : projCache.get(`BN|${dkey(design)}|${dims.join('|')}|${q}`, () => bladeNameTpls(design, dims[0], dims[1], q));
    board = fade(brand.board, 1.5); ink = fade(brand.ink, 0.7);
    glow = r.chance(kind === 'disc' ? 0.35 : 0.2) ? 0.75 : 0;
    kBoard = glow ? 'signBoard' : 'board';
    if (tp.accent) { const ac = fade(brand.accent, 0.7); kit.get('signText').add(tp.accent, m, ac[0], ac[1], ac[2], { aGlow: [glow] }); }
  }
  kit.get(kBoard).add(tp.board, m, board[0], board[1], board[2], { aGlow: [glow] });
  kit.get('signText').add(tp.text, m, ink[0], ink[1], ink[2], { aGlow: [glow] });
  kit.get('metal').add(tp.metal, m, ...BLACK_IRON);
}

// ------------------------------------------------------------------ projecting signs
const projCache = new TplCache(160);
const q2 = (x, st) => Math.round(x / st) * st;

/**
 * Projecting signs on the piers beside the shops (PROJ of each trade): a light box with
 * the shop's name on both faces, a disc or a square blade with its logo mark and name
 * (addProjecting). They face along the street, so they are what a passer-by (and the
 * tram) reads first. Hung on the pier towards a neighbouring shop (never beside an
 * entrance door), clear of the plan's own blades, their bottoms 2.6-3.5 m above the
 * paving (higher over awnings, café umbrellas and awning cassettes beside them) and below
 * the first-floor balcony consoles or string course.
 */
function buildProjecting(kit, ctx, signs) {
  const plan = ctx.plan, lot = ctx.lot;
  if (lot.backdrop || plan.isReturn || (lot.sideStreet && ctx.q < 0.5)) return;
  const ground = plan.openings.filter((x) => x.floor === 0).sort((a, b) => a.uc - b.uc);
  const used = (plan.signs || []).filter((x) => x.kind === 'blade').map((x) => x.u);
  const f1 = plan.floors[1];
  for (let i = 0; i < ground.length; i++) {
    const o = ground[i];
    if (o.kind !== 'shop') continue;
    const type = ctx.shopTypes.get(o.id);
    const r = RNG.from(o.id, 'projSign');
    if (!r.chance(PROJ[type] ?? 0.4)) continue;
    const kind = r.weighted([['flag', 0.45], ['disc', 0.25], ['blade', 0.3]]);
    const seed = r.int(0, 1 << 30);
    // size: light box (out from the wall L, height h, thickness th), disc diameter, blade
    const dims = kind === 'flag' ? [q2(r.range(0.72, 1.05), 0.05), q2(r.range(0.3, 0.44), 0.02), q2(r.range(0.12, 0.16), 0.02)]
      : kind === 'disc' ? [q2(r.range(0.52, 0.7), 0.04)] : [q2(r.range(0.5, 0.64), 0.02), q2(r.range(0.6, 0.82), 0.02)];
    const hS = kind === 'flag' ? dims[1] : kind === 'disc' ? dims[0] : dims[1];
    const out = kind === 'flag' ? 0.16 + dims[0] : kind === 'disc' ? 0.2 + dims[0] : 0.18 + dims[0];
    const sides = r.chance(0.5) ? [1, -1] : [-1, 1];
    for (const side of sides) {
      const nb = ground[i + side];
      if (nb && nb.kind !== 'shop') continue;
      const jamb = o.uc + side * o.w / 2;
      const end = nb ? nb.uc - side * nb.w / 2 : (side > 0 ? plan.width - 0.45 : 0.45);
      const gap = (end - jamb) * side;
      if (gap < 0.32) continue;
      const u = jamb + side * Math.min(gap / 2, 0.55);
      if (used.some((x) => Math.abs(x - u) < 0.9)) continue;
      const g = plan.groundAt(u);
      // highest the sign may reach: under the first-floor string course, and under the
      // consoles of a first-floor balcony it would stand beneath
      let top = f1 ? f1.y - 0.15 : plan.totalHeight - 0.6;
      for (const b of plan.balconies || []) {
        if (b.floor === 1 && u > b.u0 - 0.35 && u < b.u1 + 0.35) top = Math.min(top, b.y - (b.slabT || 0.16) - 0.62);
      }
      // lowest: 2.6 m over the pavement, above the café umbrellas' canopies and any
      // awning beside the pier
      const um = ctx.umbrellas;
      let yMin = g + (um && u > um[0] - 0.8 && u < um[1] + 0.8 ? 2.95 : 2.62);
      for (const n of [o, nb]) {
        if (!n || !hasAwning(ctx, n) || Math.abs(u - n.uc) > n.w / 2 + 0.42) continue;
        yMin = Math.max(yMin, n.y + crownY(n) + 0.42);
      }
      const aw = ctx.cafeAwning;
      if (aw && aw.covers(u - 0.5, u + 0.5)) yMin = Math.max(yMin, aw.top + 0.3);
      // a height in that band clear of any fascia board across the pier (preferring a
      // little above the lowest)
      const clash = (y) => signs.wall.some((ws) => u > ws.s.u0 - 0.12 && u < ws.s.u1 + 0.12 && y < ws.y + ws.h + 0.06 && y + hS > ws.y - 0.06);
      let y = Math.min(yMin + r.range(0, 0.85), top - hS);
      if (y < yMin || clash(y)) {
        y = NaN;
        for (const ws of signs.wall) {
          const c = ws.y + ws.h + 0.08;
          if (c >= yMin && c + hS <= top && !clash(c)) { y = c; break; }
        }
        if (Number.isNaN(y) && !clash(top - hS) && top - hS >= yMin) y = top - hS;
      }
      if (Number.isNaN(y) || y - g < 2.6) continue;
      used.push(u);
      const m = wallMatrix(ctx.frame, u, y, _m, rusticOff(plan, y));
      addProjecting(kit, ctx, m, kind, ctx.brands.get(o.id), type, dims, seed, r);
      // (out: how far it reaches over the pavement; kept for the checks)
      if (ctx.projOut) ctx.projOut.push({ u, y, h: hS, out });
      break;
    }
  }
}

/**
 * A sign of its own for shop o, which the plan left without one: on the valance of its
 * awning, else a fascia board over the opening where the wall has room below the
 * first-floor balconies, else a panel in the shopfront's head.
 */
function addShopSign(ctx, signs, o, type) {
  const plan = ctx.plan;
  const r = RNG.from(o.id, 'shopSign');
  const design = signDesign(r.int(0, 1 << 30), null, type);
  if (hasAwning(ctx, o)) { signs.byOpening.set(o.id, { mode: 'valance', design }); return; }
  const ceiling = (plan.floors[1] ? plan.floors[1].y : plan.totalHeight) - 0.12;
  const y = o.y + crownY(o) + (isArched(o) ? 0.6 : 0.1);
  const u0 = Math.max(0.25, o.uc - o.w / 2 - 0.12), u1 = Math.min(plan.width - 0.25, o.uc + o.w / 2 + 0.12);
  let top = ceiling;
  for (const b of plan.balconies || []) if (b.floor === 1 && b.u1 > u0 - 0.2 && b.u0 < u1 + 0.2) top = Math.min(top, b.y - (b.slabT || 0.16) - 0.62);
  const h = Math.min(r.range(0.45, 0.62), top - y);
  const clash = signs.wall.some((w) => w.s.u0 < u1 + 0.1 && w.s.u1 > u0 - 0.1);
  if (h >= 0.32 && !clash) signs.wall.push({ s: { kind: 'fascia', u0, u1, y, h }, design, y, h, o, lamps: top - (y + h) > 0.3 });
  else signs.byOpening.set(o.id, { mode: 'head', design });
}

// ------------------------------------------------------------------ shops
/** Generator: yields between its stages so a chunk build can be time-sliced finely. */
function* buildShop(kit, ctx, o, signInfo, type) {
  const plan = ctx.plan;
  const r = RNG.from(o.id, 'shop');
  // a building's shopfronts follow one of two joinery designs (shared templates); the
  // fit-outs still differ in colour, goods and lighting
  const variant = r.int(0, 1);
  const headSign = !!(signInfo && signInfo.mode === 'head');
  // (the roller shutter's state is the opening's own, not the design's)
  const L = shopDecision(plan, o);
  if (headSign) {
    // flat heads: a sign band ~0.55 m tall under the lintel, display glass below it
    if (!isArched(o)) { L.yT = Math.max(2.5, o.h - SHOP_FW - 0.62); L.doorH = Math.min(L.doorH, L.yT - 0.06); }
    L.head = 'panel'; L.headSign = true;
  }
  const T = shopTpls(`${plan.seed}|${variant}|${headSign}`, o, L, ctx.q);
  // the shopfront stands L.inset behind the infill plane, lined back to it (m0: the
  // opening's own frame, which the reveal film and the awning keep)
  const m0 = openingMatrix(ctx.frame, o, new THREE.Matrix4());
  const m = new THREE.Matrix4().copy(m0).multiply(_r.makeTranslation(0, 0, -(L.inset || 0)));
  // timber shopfronts are painted like the building's joinery, the others steel or
  // aluminium from the shopfitters' range
  const fc = weather(L.timber ? ctx.frameRGB : swatch('shop', RNG.from(o.id, 'shopColour')), r, 0.7);
  kit.get('joinery').add(T.frame, m, fc[0], fc[1], fc[2], null, r.next(), 0.3 + 0.4 * r.next());
  if (T.lining) kit.get('joinery').add(T.lining, m, fc[0], fc[1], fc[2]);
  // interior
  const f0 = plan.floors[0];
  const roomY0 = o.y;
  const W = Math.max(4, o.w + 1.6);
  const H = Math.max(3, f0.y + f0.h - roomY0 - 0.3);
  const D = 6.5 + r.next() * 3;
  const gseed = r.next();
  const ga = glassAttrs(ctx, o, { W, H, D, roomY0, seed: gseed, drape: 0, kind: 1, type: shopTypeIndex(type), zRef: -0.02, lit: o.lit, recess: o.recess + (L.inset || 0), door: L.dx });
  shadeGlass(ga, awningShade(ctx, o));
  kit.get('glass').add(T.glass, m, 1, 1, 1, ga);
  // (the reveal glow and the pavement pool in the colour of its lamps)
  const lampX = shopSpill(shopTypeIndex(type), gseed);
  addSpill(kit, ctx, o, m0, lampX, 1);
  // its light on the pavement in front (main-street fronts)
  if (ctx.q >= 0.5 && !ctx.lot.sideStreet && !ctx.plan.isReturn && !ctx.lot.backdrop) {
    const gg = groundGlow(ctx, o, lampX);
    if (gg) kit.get('spill').add(gg.tpl, IDENT, 1, 1, 1, gg.attrs);
  }
  // the shop's dressing: posters and price cards on the glass, stickers on the door, the
  // name in vinyl letters on the head glass, goods hung on the piers (near range)
  // far range (main street): the same posters, so nothing changes at the detail switch
  if (ctx.q < 0.5 && ctx.lod > 0 && !ctx.lot.backdrop && !ctx.lot.sideStreet && !(L.shutterDown > 0.7)) dressWindow(kit, o, L, m, type, true, shopAlloc(ctx, o), ctx.brands.get(o.id));
  if (ctx.q >= 0.5 && !ctx.lot.backdrop) {
    if (!(L.shutterDown > 0.7)) dressWindow(kit, o, L, m, type, false, shopAlloc(ctx, o), ctx.brands.get(o.id));
    const rv = RNG.from(o.id, 'vinyl');
    // (not behind an awning, whose valance carries the name)
    if (L.head === 'glass' && !headSign && !hasAwning(ctx, o) && rv.chance(0.35)) {
      const yH = L.yT + 0.05, top = crownY(o, SHOP_FW);
      const band = Math.min(0.24, (top - yH) * 0.5);
      if (band > 0.1) {
        const dsg = { ...signDesign(rv.int(0, 1 << 30), 'letters', type), ...brandText(ctx.brands.get(o.id)), board: null, ink: rv.pick([0xf2efe6, 0xf2efe6, 0xd8b25a, 0xe9dfc4]), glow: 0 };
        const mt = new THREE.Matrix4().copy(m).multiply(_r.makeTranslation(0, (yH + top) / 2, 0));
        addSignText(kit, dsg, mt, L.hwI * 1.4, band, ctx.q, 0, -0.036, true);
      }
    }
    if (!ctx.plan.isReturn && !(ctx.cafeAwning && ctx.cafeAwning.covers(o.uc - o.w / 2 - 1.2, o.uc + o.w / 2 + 1.2))) hangGoods(kit, ctx, o, type, shopAlloc(ctx, o), L, m0);
  }
  // floor of a recessed entrance (the buildings' dark box behind it is unlit)
  // (a rendered block keeps a stone-clad shop floor: its stone tint, not the wash's)
  if (T.recess) { const tint = (plan.style.finish === 'render' && plan.style.stone) || plan.style.tint; kit.get('stone').add(T.recess, m, tint[0] * 0.8, tint[1] * 0.78, tint[2] * 0.74); }
  yield;
  // roller-shutter box and guides
  if (L.box) {
    // (galvanised or painted, faded by the sun)
    const rc = weather(lin(r.pick(ROLLER)), RNG.from(o.id, 'rollerFade'), 1.4);
    kit.get('joinery').add(T.shutter, m, rc[0], rc[1], rc[2]);
    // a lowered curtain collects a tag or two on about a third of the shops
    const rt = RNG.from(o.id, 'tags');
    if (L.shutterDown > 0 && ctx.q >= 0.5 && rt.chance(0.36)) {
      const top = (L.arched ? L.yT : o.h - SHOP_FW) - 0.22, yb = top * (1 - L.shutterDown);
      const tt = new Tpl();
      for (let k = rt.chance(0.4) ? 2 : 1; k > 0; k--) {
        const cell = lineCell(rt.int(LINE_KIND.tag[0], LINE_KIND.tag[1]));
        const w = Math.min(L.hwI * 1.6, rt.range(0.6, 1.3)), h = w / cell.aspect;
        const y = rt.range(yb + 0.15 + h / 2, Math.min(top - 0.1, 1.9) - h / 2);
        if (!(y > yb + h / 2)) continue;
        cellTpl(tt, cell, rt.range(-L.hwI + w / 2, L.hwI - w / 2), y, w, h, ZF_SHUT, rt.range(0.75, 0.95));
      }
      if (tt.count) kit.get('signText').add(tt.bake(), m, 0.92, 0.92, 0.92, { aGlow: [0] }); else tt.free();
    }
  }
  // door push bar / handle (behind a lowered shutter curtain: none)
  const shutterFoot = L.shutterDown > 0 ? ((L.arched ? L.yT : o.h - SHOP_FW) - 0.22) * (1 - L.shutterDown) : 0;
  if (ctx.q >= 0.5 && (!(L.shutterDown > 0) || shutterFoot > 1.4)) {
    const hd = new Tpl();
    const dx = L.dx + (L.dx >= 0 ? -1 : 1) * (L.doorW / 2 - 0.12), z = -L.setback + 0.04;
    hd.box(dx - 0.015, 0.85, z, dx + 0.015, 1.35, z + 0.04, 1 | 4 | 8 | 16 | 32, 0.9, 1);
    kit.get('hardware').add(hd.bake(), m, 0.55, 0.55, 0.56);
  }
  // sign in the head panel
  if (signInfo && signInfo.mode === 'head') {
    const yH = L.yT + 0.05;
    const top = crownY(o, SHOP_FW);
    const pts = outlinePts(o, SHOP_FW - 0.005).filter((p) => p[1] > yH + 0.001);
    const hw = halfWidthAt(o, yH, SHOP_FW - 0.005);
    const tb = new Tpl();
    tb.poly([[-hw, yH], [hw, yH], ...pts], -0.015);
    const design = signInfo.design;
    const bc = signColor(design.board ?? [0x1f3a2c, 0x1b2b45, 0x5a1a1c, 0x1d1d1f][design.cell % 4]);
    const glow = design.type === 'lightbox' ? 1 : 0;
    kit.get(glow > 0 ? 'signBoard' : 'board').add(tb.bake(), m, bc[0], bc[1], bc[2], { aGlow: [glow] });
    const band = Math.min(0.5, (top - yH) * 0.62);
    const yc = yH + Math.min(band * 0.5 + 0.06, (top - yH) * 0.42);
    const wAvail = 2 * halfWidthAt(o, yc + band / 2, SHOP_FW) - 0.12;
    const lumB = bc[0] * 0.3 + bc[1] * 0.6 + bc[2] * 0.1;
    const dsg = { ...design, type: 'letters', board: null, ink: design.board != null ? design.ink : lumB > 0.3 ? 0x1d1d1f : (design.cell % 3 ? 0xe9dfc4 : 0xd8b25a) };
    const mt = new THREE.Matrix4().copy(m).multiply(_r.makeTranslation(0, yc, -0.015 - 0.035 + 0.006));
    if (!signInfo.noText) addSignText(kit, dsg, mt, wAvail, band, ctx.q, glow, 0.015, band < 0.3);
  }
  // awning
  if (hasAwning(ctx, o)) {
    yield;
    buildAwning(kit, ctx, o, r, signInfo && signInfo.mode === 'valance' ? signInfo.design : null);
  }
}

// ------------------------------------------------------------------ awnings
/**
 * Shape and colour of the awning over shop opening o (its own, from the plan or added
 * here; see awningOf), in the opening's local frame: template, placement, the valance
 * front, and what the shop glass needs to mirror its underside (projection from the wall
 * face P, valance hem height above the sill, half width). Deterministic per opening.
 */
function awningPlan(ctx, o) {
  const spec = awningOf(ctx, o);
  if (!spec) return null;
  const r = RNG.from(o.id, 'awningPlan');
  const col = spec.color ? { c1: lin(spec.color), c2: lin(spec.color), period: 0 } : awningColors(r);
  const crown = crownY(o);
  const arched = isArched(o) && o.top !== 'segment';
  const ground = ctx.plan.groundAt(o.uc) - o.y; // paving relative to the sill (≤ 0)
  const valH = r.range(0.2, 0.28);
  // (fixed to rusticated stone: on the boss faces)
  const off = rusticOff(ctx.plan, o.y + crown);
  if (spec.type === 'dutch') {
    if (arched) {
      const R = o.w / 2 + 0.12;
      const y0 = crown + 0.12 - R;               // on the spring line for round heads
      return { col, valH, dome: [0, R], mLocal: [0, y0, o.recess + off], valFront: null, P: R + off, hem: y0 - valH, hw: R };
    }
    const R = Math.min(0.85, Math.max(0.45, Math.min((crown - ground - 2.4) * 0.6 + 0.3, crown + 0.15 - valH - ground - 2.3)));
    const W = o.w + 0.3, y0 = crown + 0.15 - R;
    return {
      col, valH, dome: [W, R], mLocal: [0, y0, o.recess + off], P: R + off, hem: y0 - valH, hw: W / 2,
      valFront: W - 2 * R > 1.0 ? { w: W - 2 * R, y: y0 - valH / 2, z: o.recess + off + R + 0.012 } : null,
    };
  }
  const W = o.w + 0.3;
  const top = crown + 0.14;
  const P = r.range(1.0, 1.5);
  const D = Math.max(0.35, Math.min(r.range(0.55, 0.8), top - ground - 2.35 - valH));
  return { col, valH, slope: [W, P, D], mLocal: [0, top, o.recess + off], valFront: { w: W, y: top - D - valH / 2, z: o.recess + off + P + 0.012 }, P: P + off, hem: top - D - valH, hw: W / 2 };
}

/**
 * What shades shop opening o's glass from above: its own awning or the café's continuous
 * one. {P (from the wall face), hem (above the sill), hw (half width about the opening
 * centre), col (canvas, linear)} or null.
 */
function awningShade(ctx, o) {
  const aw = ctx.cafeAwning;
  if (aw && aw.covers(o.uc - o.w / 2, o.uc + o.w / 2)) {
    let best = null;
    for (const un of aw.units) if (!best || Math.abs(un.uc - o.uc) < Math.abs(best.uc - o.uc)) best = un;
    if (!best || best.D == null) return null;
    const c = aw.colors;
    return { P: best.P + (aw.off || 0), hem: aw.top - best.D - aw.valH - o.y, hw: 9.5, col: c.c1.map((x, i) => (x + c.c2[i]) / 2) };
  }
  const ap = awningPlan(ctx, o);
  if (!ap) return null;
  const c = ap.col;
  return { P: ap.P, hem: ap.hem, hw: ap.hw, col: c.c1.map((x, i) => (x + c.c2[i]) / 2) };
}

/** Write the awning over a shop window into its glass attributes (see interior.js). */
function shadeGlass(ga, sh) {
  if (!sh || !(sh.P > 0.1) || !(sh.hem > 0.3)) return;
  ga.aWin = [ga.aWin[0], ga.aWin[1], Math.round(Math.min(sh.P, 9) * 20) + Math.min(0.999, sh.hem / 10), ga.aWin[3]];
  ga.aFrame = [sh.col[0], sh.col[1], sh.col[2], Math.min(0.49, sh.hw / 20)];
}

function buildAwning(kit, ctx, o, r, design) {
  const ap = awningPlan(ctx, o);
  if (!ap) return;
  const { col, valH, mLocal, valFront } = ap;
  const tpl = ap.dome ? domeAwning(ap.dome[0], ap.dome[1], valH, ctx.q) : slopeAwning(ap.slope[0], ap.slope[1], ap.slope[2], valH, ctx.q);
  const m = new THREE.Matrix4().copy(openingMatrix(ctx.frame, o, new THREE.Matrix4())).multiply(_r.makeTranslation(mLocal[0], mLocal[1], mLocal[2]));
  const canvas = tpl.canvas;
  kit.get('awning').add(canvas, m, col.c1[0], col.c1[1], col.c1[2], {
    aStripe: [col.c2[0], col.c2[1], col.c2[2], col.period],
    aFlex: (k, sp, a, i) => { a[i] = canvas.f[k]; },
  });
  kit.get('metal').add(tpl.metal, m, 0.06, 0.06, 0.062);
  // shop name on the valance
  if (design && valFront && ctx.q >= 0.5) {
    const lum = col.c1[0] * 0.3 + col.c1[1] * 0.6 + col.c1[2] * 0.1;
    const dsg = { ...design, type: 'letters', board: null, ink: lum > 0.25 ? 0x2a2a2c : 0xf2efe6, glow: 0 };
    const mt = new THREE.Matrix4().copy(openingMatrix(ctx.frame, o, new THREE.Matrix4()))
      .multiply(_r.makeTranslation(0, valFront.y, valFront.z - 0.035));
    addSignText(kit, dsg, mt, valFront.w * 0.7, valH * 0.72, ctx.q, 0, 0.015, true);
  }
}

/** Whether shop opening o carries its own awning (none under a café's continuous one). */
function hasAwning(ctx, o) { return !!awningOf(ctx, o); }

/** Share of the shops without one in the plan that put up an awning (about 60% in all). */
const EXTRA_AWNING = 0.4;

/**
 * The awning spec ({type, color}) of shop opening o, or null: the plan's, plus one on
 * ~40% of the other main-street shops (most shopfronts on the street shade their
 * windows by day); none under a café's continuous awning, and none over a terrace of
 * market umbrellas, whose canopies come to within 0.3 m of the wall.
 */
function awningOf(ctx, o) {
  if (o.kind !== 'shop') return null;
  const memo = ctx.awnings || (ctx.awnings = new Map());
  if (memo.has(o)) return memo.get(o);
  let a = null;
  const a0 = o.uc - o.w / 2, a1 = o.uc + o.w / 2;
  if (ctx.cafeAwning && ctx.cafeAwning.covers(a0, a1)) a = null;
  else if (ctx.umbrellas && ctx.umbrellas[0] < a1 + 0.8 && ctx.umbrellas[1] > a0 - 0.8) a = null;
  else if (o.awning) a = o.awning;
  else if (!ctx.lot.backdrop && !ctx.lot.sideStreet) {
    const r = RNG.from(o.id, 'awningExtra');
    // (round-headed openings mostly take a dome that follows the arch)
    const arched = isArched(o) && o.top !== 'segment';
    if (r.chance(EXTRA_AWNING)) a = { type: r.chance(arched ? 0.4 : 0.8) ? 'slope' : 'dutch', color: null };
  }
  // a dutch hood over a flat or segmental head (the shop heads come down under the
  // first-floor balconies) needs ~0.45 m of hood above a 2.3 m clear hem: on a lower head
  // the shop puts up a sloped awning instead
  if (a && a.type === 'dutch' && !(isArched(o) && o.top !== 'segment')) {
    const clear = o.y + crownY(o) - ctx.plan.groundAt(o.uc);
    if (clear < 2.3 + 0.28 + 0.45 - 0.15) a = { ...a, type: 'slope' };
  }
  memo.set(o, a);
  return a;
}

/**
 * Facade u range [u0, u1] of the lot's umbrella terrace, or null: the terrace and its
 * canopies (layout lets them overhang its ends by 0.35 m; furniture's relaxation may
 * shift them a little more, and runs after facades' first builds, so the margin covers
 * it rather than reading their final places, keeping every build of a front identical).
 */
function umbrellaSpan(ctx) {
  const { lot, frame, app } = ctx;
  if (lot.sideStreet || lot.cafe == null || ctx.plan.isReturn) return null;
  const cafe = app.layout.cafes[lot.cafe];
  if (!cafe || cafe.style !== 'umbrella') return null;
  _inv.copy(frame.matrix).invert();
  const uAt = (s) => app.route.toWorld(s, lot.side * lot.d, 0, _p).applyMatrix4(_inv).x;
  const a = uAt(cafe.s0 - 0.9), b = uAt(cafe.s1 + 0.9);
  return [Math.min(a, b), Math.max(a, b)];
}

/**
 * The shop a café terrace without its own continuous awning (umbrella or open style) is
 * centred on (layout._addCafe puts the terrace middle in front of it): it becomes the
 * café, sign and all. Null on other fronts.
 */
function terraceCafeOpening(ctx) {
  const { lot, plan, app } = ctx;
  if (lot.sideStreet || lot.backdrop || plan.isReturn || lot.cafe == null) return null;
  const cafe = app.layout.cafes[lot.cafe];
  if (!cafe || cafe.style === 'awning') return null;
  // the layout's own mapping of u to s along the lot (u from the viewer-left end)
  const len = Math.abs(app.route.delta(lot.s0, lot.s1)) || 1, mid = (cafe.s0 + cafe.s1) / 2;
  const t = lot.side > 0 ? app.route.delta(mid, lot.s1) / len : app.route.delta(lot.s0, mid) / len;
  const u = t * (lot.frame.width || plan.width);
  let best = null, bd = Infinity;
  for (const o of plan.openings) {
    if (o.floor !== 0 || o.kind !== 'shop') continue;
    const d = Math.max(0, Math.abs(o.uc - u) - o.w / 2);
    if (d < bd) { bd = d; best = o; }
  }
  return best && bd < 2.5 ? best : null;
}

const _inv = new THREE.Matrix4(), _p = new THREE.Vector3();
const CAFE_HEM = 2.7;          // valance hem above the paving
const CAFE_UNIT = 5.5;         // widest awning unit (one pair of folding arms)

/**
 * Plan of the continuous retractable awning over a café terrace of the 'awning' style
 * (layout.cafes): along the front over the café's span s0..s1 (broken only around an
 * entrance with a hood), in units of at most 5.5 m (one pair of folding arms each).
 * Every unit projects |dOut − dIn| over the tables, at most 4.2 m and less where a
 * street tree's crown is in the way. The cassette runs level just above the shop heads
 * and below the first-floor balcony consoles; each unit's front bar sits so that its
 * scalloped valance hangs to ~2.7 m above the paving under it. Null when there is no room.
 */
function planCafeAwning(ctx) {
  const { cafe, plan, frame, lot, app } = ctx;
  const { route, layout } = app;
  _inv.copy(frame.matrix).invert();
  const uAt = (s) => route.toWorld(s, lot.side * lot.d, 0, _p).applyMatrix4(_inv).x;
  const uS0 = uAt(cafe.s0), uS1 = uAt(cafe.s1);
  const sAt = (u) => cafe.s0 + ((u - uS0) / (uS1 - uS0 || 1)) * (cafe.s1 - cafe.s0);
  const u0 = Math.max(0.35, Math.min(uS0, uS1)), u1 = Math.min(plan.width - 0.35, Math.max(uS0, uS1));
  if (u1 - u0 < 2.5) return null;
  // runs between the entrance doors that wear a hood on consoles (buildings' masonry)
  let runs = [[u0, u1]];
  for (const o of plan.openings) {
    if (o.floor !== 0 || o.kind !== 'door' || !(plan.relief && plan.relief.doorHood)) continue;
    const a = o.uc - o.w / 2 - 0.45, b = o.uc + o.w / 2 + 0.45;
    runs = runs.flatMap(([x0, x1]) => (b <= x0 || a >= x1 ? [[x0, x1]] : [[x0, a], [b, x1]]));
  }
  runs = runs.filter(([x0, x1]) => x1 - x0 >= 2.2);
  if (!runs.length) return null;
  const covers = (a, b) => runs.some(([x0, x1]) => a < x1 && b > x0);
  // crowns of the street trees in front (radius as vegetation scales its templates)
  const sMid = (cafe.s0 + cafe.s1) / 2, half = (cafe.s1 - cafe.s0) / 2;
  const trees = layout.trees.filter((t) => t.side === lot.side && Math.abs(route.delta(sMid, t.s)) < half + 5)
    .map((t) => ({ s: t.s, d: Math.abs(t.d), r: t.crown * 0.6 + 0.25 }));
  const Pmax = Math.min(4.2, Math.abs(cafe.dOut - cafe.dIn));
  const units = [];
  for (const [x0, x1] of runs) {
    const n = Math.max(1, Math.ceil((x1 - x0) / CAFE_UNIT)), w = (x1 - x0) / n;
    for (let i = 0; i < n; i++) {
      const uc = x0 + w * (i + 0.5);
      const sa = Math.min(sAt(uc - w / 2), sAt(uc + w / 2)), sb = Math.max(sAt(uc - w / 2), sAt(uc + w / 2));
      // the front edge keeps clear of every crown: distance from the crown's axis to the
      // canopy's footprint at least the crown radius
      let P = Pmax;
      for (const t of trees) {
        const ds = Math.abs(route.delta(Math.min(sb, Math.max(sa, t.s)), t.s));
        if (ds < t.r) P = Math.min(P, lot.d - t.d - Math.sqrt(t.r * t.r - ds * ds));
      }
      units.push({ uc, w, P: Math.max(2.0, P) });
    }
  }
  const r = RNG.from(lot.seed, 'cafeAwning');
  const valH = r.range(0.22, 0.28);
  // cassette line: above the heads it covers, below the first-floor consoles
  let gMax = -Infinity, crown = -Infinity, pMax = 0;
  for (const [x0, x1] of runs) gMax = Math.max(gMax, plan.groundAt(x0), plan.groundAt(x1));
  for (const un of units) pMax = Math.max(pMax, un.P);
  for (const o of plan.openings) if (o.floor === 0 && covers(o.uc - o.w / 2, o.uc + o.w / 2)) crown = Math.max(crown, o.y + crownY(o));
  const f1 = plan.floors[1];
  let ceil = (f1 ? f1.y : plan.totalHeight) - 0.3;
  for (const b of plan.balconies || []) {
    if (b.floor === 1 && covers(b.u0 - 0.3, b.u1 + 0.3)) ceil = Math.min(ceil, b.y - (b.slabT || 0.16) - 0.82);
  }
  const topMin = gMax + CAFE_HEM + valH + pMax * 0.16;
  const top = Math.max(topMin, Math.min(ceil, Math.max(crown + 0.14, topMin + 0.25)));
  // each unit's drop: front bar level with the paving under it, hem ~2.7 m above its high side
  for (const un of units) {
    const g = Math.max(plan.groundAt(un.uc - un.w / 2), plan.groundAt(un.uc + un.w / 2));
    un.D = Math.min(un.P * 0.68, Math.max(un.P * 0.1, top - (g + CAFE_HEM + valH)));
  }
  return { units, covers, valH, top, off: rusticOff(plan, top), colors: awningColors(r), design: signDesign(lot.seed ^ 0x5ca1ab1e, 'letters', 'cafe') };
}

/** Builds the café awning planned by planCafeAwning, unit by unit. */
function buildCafeAwning(kit, ctx, aw) {
  const { plan, frame, q } = ctx;
  const { valH, top, colors: col } = aw, off = aw.off || 0;
  for (const { uc, w, P, D } of aw.units) {
    const tpl = slopeAwning(w - 0.03, P, D, valH, q);
    const m = wallMatrix(frame, uc, top, new THREE.Matrix4(), off);
    const canvas = tpl.canvas;
    kit.get('awning').add(canvas, m, col.c1[0], col.c1[1], col.c1[2], {
      aStripe: [col.c2[0], col.c2[1], col.c2[2], col.period],
      aFlex: (k, v, a, j) => { a[j] = canvas.f[k]; },
    });
    kit.get('metal').add(tpl.metal, m, 0.06, 0.06, 0.062);
    // the café's name on the valance of every unit wide enough to carry it
    if (q >= 0.5 && w >= 2.4) {
      const lum = col.c1[0] * 0.3 + col.c1[1] * 0.6 + col.c1[2] * 0.1;
      const dsg = { ...aw.design, ink: lum > 0.25 ? 0x2a2a2c : 0xf2efe6, glow: 0 };
      const mt = wallMatrix(frame, uc, top - D - valH / 2 - 0.006, new THREE.Matrix4(), off).multiply(_r.makeTranslation(0, 0, P + 0.012 - 0.035));
      addSignText(kit, dsg, mt, Math.min(3, w * 0.6), valH * 0.72, q, 0, 0.015, true);
    }
  }
}

/**
 * Hotel-style hoods over upper-floor windows (domes over arched heads, dutch hoods over
 * flat ones), one colour scheme per facade.
 */
function buildUpperAwning(kit, ctx, o) {
  const r = RNG.from(o.id, 'hood');
  const col = ctx.hotelColors;
  const crown = crownY(o);
  const arched = isArched(o) && o.top !== 'segment';
  let tpl, y;
  if (arched) {
    const R = o.w / 2 + 0.1;
    tpl = domeAwning(0, R, 0.17, ctx.q);
    y = crown + 0.1 - R;
  } else {
    const R = 0.55;
    tpl = domeAwning(o.w + 0.2, R, 0.17, ctx.q);
    y = crown + 0.12 - R;
  }
  const m = new THREE.Matrix4().copy(openingMatrix(ctx.frame, o, new THREE.Matrix4())).multiply(_r.makeTranslation(0, y, o.recess + 0.02));
  const k = 0.94 + r.next() * 0.1; // uneven fading
  kit.get('awning').add(tpl.canvas, m, col.c1[0] * k, col.c1[1] * k, col.c1[2] * k, {
    aStripe: [col.c2[0] * k, col.c2[1] * k, col.c2[2] * k, col.period],
    aFlex: (i, sp, a, j) => { a[j] = tpl.canvas.f[i] * 0.6; },
  });
  kit.get('metal').add(tpl.metal, m, 0.06, 0.06, 0.062);
}

// ------------------------------------------------------------------ doors
function buildDoor(kit, ctx, o) {
  const plan = ctx.plan;
  const r = RNG.from(o.id, 'door');
  // the entrances of one building share their joinery (one design per building)
  const L = doorLayout(o, RNG.from(plan.seed, 'doorDesign'));
  const T = doorTpls(`${plan.seed}`, o, L, ctx.q);
  const m = openingMatrix(ctx.frame, o, new THREE.Matrix4());
  const dc = lin(DOOR_COLORS[L.color]);
  const k = 0.9 + r.next() * 0.15;
  kit.get('door').add(T.door, m, dc[0] * k, dc[1] * k, dc[2] * k);
  kit.get('glass').add(T.glass, m, 1, 1, 1,
    glassAttrs(ctx, o, { W: 2.6, H: 3.4, D: 3.5, roomY0: o.y, seed: r.next(), drape: 0, kind: 2, zRef: -0.015, lit: Math.min(o.lit ?? 0.5, 0.35) }));
  addSpill(kit, ctx, o, m, Math.min(o.lit ?? 0.5, 0.35), 2);
  const metal = T.metal;
  if (metal.grille) kit.get('metal').add(metal.grille, m, ...BLACK_IRON);
  const brass = L.color !== 'black' && r.chance(0.7);
  if (metal.handles) kit.get('hardware').add(metal.handles, m, ...(brass ? BRASS : BLACK_IRON));
  // (the threshold stone and any steps down to the paving are the buildings' masonry)
  if (ctx.q < 0.5) return;
  // number plaque, intercom and a wall lantern
  const side = r.chance(0.5) ? 1 : -1;
  const uP = o.uc + side * (o.w / 2 + 0.38);
  kit.get('signText').add(plaqueTpl(r.int(0, 31)), wallMatrix(ctx.frame, uP, o.y + 1.95, new THREE.Matrix4(), rusticOff(plan, o.y + 1.95)), 1, 1, 1, { aGlow: [0] });
  kit.get('hardware').add(ctx.assets.intercom, wallMatrix(ctx.frame, o.uc - side * (o.w / 2 + 0.3), o.y + 1.4, new THREE.Matrix4(), rusticOff(plan, o.y + 1.4)), 0.62, 0.62, 0.6);
  if (r.chance(0.55)) {
    const ml = wallMatrix(ctx.frame, uP, o.y + 2.5, new THREE.Matrix4(), rusticOff(plan, o.y + 2.5));
    kit.get('metal').add(ctx.assets.lantern.metal, ml, ...BLACK_IRON);
    kit.get('lamp').add(ctx.assets.lantern.glass, ml);
    kit.get('bulb').add(ctx.assets.lantern.bulb, ml);
  }
}

// ------------------------------------------------------------------ front
/** Builds one front; a generator that yields after every opening (time slicing). */
/**
 * The fronts of a lot as the facades build them: its street face and the corner returns
 * (each {plan, frame, streetW, cafe: the café terrace with a continuous awning}).
 */
export function frontsOf(app, lot, plan = facadePlan(lot)) {
  const streetW = lot.sideStreet ? lot.cross.width : 2 * Math.abs(lot.d);
  const cafe = !lot.sideStreet && lot.cafe != null ? app.layout.cafes[lot.cafe] : null;
  const fronts = [{ plan, frame: lot.frame, streetW, cafe: cafe && cafe.style === 'awning' ? cafe : null }];
  // corner returns face the side street
  for (const r of plan.returns || []) fronts.push({ plan: r, frame: r.frame, streetW: 10, cafe: null });
  return fronts;
}

const frontCache = new WeakMap();      // front plan → its decisions (computed once)
/**
 * Front decisions shared by the build and the poster allocation: the café awning, the
 * umbrella terrace, the signs, and what each shop sells (the word on its sign, else a
 * draw; the shopfronts under a café's awning are the café). Sets them on ctx.
 */
function prepareFront(ctx) {
  const plan = ctx.plan;
  let f = frontCache.get(plan);
  if (!f) {
    ctx.awnings = new Map();
    ctx.cafeAwning = ctx.cafe ? planCafeAwning(ctx) : null;
    ctx.umbrellas = umbrellaSpan(ctx);
    const signs = planSigns(ctx);
    // the shop behind an umbrella or open terrace is its café: its sign (or, where it had
    // none, a panel in its head) carries a café's word
    const terrace = terraceCafeOpening(ctx);
    if (terrace) {
      const seed = RNG.from(terrace.id, 'cafeSign').int(0, 1 << 30);
      const si = signs.byOpening.get(terrace.id), ws = signs.wall.find((w) => w.o === terrace);
      const recast = (d) => ({ ...d, cell: signDesign(seed, d.type, 'cafe').cell });
      if (si) si.design = recast(si.design);
      if (ws) ws.design = recast(ws.design);
      if (!si && !ws) signs.byOpening.set(terrace.id, hasAwning(ctx, terrace) ? { mode: 'valance', design: signDesign(seed, 'letters', 'cafe') } : { mode: 'head', design: signDesign(seed, 'board', 'cafe') });
    }
    // what each shop sells: the café's, the word on its sign, else a draw; a trade that
    // does not cluster never repeats within two shops of a front (a sign whose word would
    // repeat is repainted with another trade), and most unsigned shops put up a sign
    const shopTypes = new Map(), subs = new Map();
    const recent = [];
    const shops = plan.openings.filter((o) => o.kind === 'shop').sort((a, b) => a.uc - b.uc);
    for (const o of shops) {
      const si = signs.byOpening.get(o.id) || signs.wall.find((w) => w.o === o);
      const cafe = o === terrace || (ctx.cafeAwning && ctx.cafeAwning.covers(o.uc - o.w / 2, o.uc + o.w / 2));
      let type = 'cafe';
      if (!cafe) {
        const r = RNG.from(o.id, 'type');
        type = si ? wordType(si.design.cell) : r.weighted(SHOP_MIX);
        const ok = (t) => (CLUSTER.has(t) || !recent.includes(t)) && tradeAllowed(ctx.app, ctx.lot, ctx.frame, plan, o, t);
        for (let k = 0; k < 8 && !ok(type); k++) type = r.weighted(SHOP_MIX);
        if (!ok(type)) type = recent.includes('clothing') ? 'general' : 'clothing';
        if (si && type !== wordType(si.design.cell)) si.design = { ...si.design, cell: signDesign(r.int(0, 1 << 30), si.design.type, type).cell };
        if (!si && !ctx.lot.backdrop && RNG.from(o.id, 'ownSign').chance(EXTRA_SIGN)) addShopSign(ctx, signs, o, type);
      }
      // the narrower trade (what a general store or a café puts out): its sign's, else a draw
      const sg = signs.byOpening.get(o.id) || signs.wall.find((w) => w.o === o);
      const sub = sg ? wordSub(sg.design.cell) : null;
      subs.set(o.id, sub ?? (SUBDRAW[type] && !(cafe && ctx.cafeAwning) ? RNG.from(o.id, 'trade').weighted(SUBDRAW[type]) : null));
      shopTypes.set(o.id, type);
      recent.push(type);
      if (recent.length > 2) recent.shift();
    }
    // each shop's identity (name, second line, logo, colours), lettered on all its signs
    // (the shops under a café's continuous awning are the café: the name of the first)
    const brands = new Map();
    const under = (x) => ctx.cafeAwning && ctx.cafeAwning.covers(x.uc - x.w / 2, x.uc + x.w / 2);
    const cafeO = shops.find(under);
    for (const o of shops) {
      const sg = signs.byOpening.get(o.id) || signs.wall.find((w) => w.o === o);
      const b = under(o) && o !== cafeO ? brands.get(cafeO.id) : makeBrand(ctx.app, o, shopTypes.get(o.id), subs.get(o.id), sg ? sg.design : null);
      brands.set(o.id, b);
      if (sg) sg.design = { ...sg.design, ...brandText(b) };
    }
    if (cafeO) ctx.cafeAwning.design = { ...ctx.cafeAwning.design, ...brandText(brands.get(cafeO.id)), sub: null, logo: -1 };
    // the plan's wall signs with no shop below (a building's or a hotel's name board)
    for (const ws of signs.wall) if (!ws.o && ws.design.name == null) ws.design = { ...ws.design, name: hashStr(`${plan.seed}|${ws.s.u0.toFixed(2)}`) % N_NAMES, nv: 0, sub: null, logo: -1 };
    f = { cafeAwning: ctx.cafeAwning, umbrellas: ctx.umbrellas, awnings: ctx.awnings, signs, shopTypes, subs, terrace, brands };
    frontCache.set(plan, f);
  }
  ctx.cafeAwning = f.cafeAwning; ctx.umbrellas = f.umbrellas; ctx.awnings = f.awnings; ctx.shopTypes = f.shopTypes; ctx.subs = f.subs; ctx.brands = f.brands;
  return f.signs;
}

// ------------------------------------------------------------------ poster allocation
// Window posters, banners and price cards are given out per 40 m block of a street side
// (dressing.js allocateBlock), so the same design never shows twice within ~80 m: the
// main street's sides are cut into a multiple of three blocks round the loop, a side
// street's sides into 40 m blocks from the corner.
const blockCache = new Map();         // block key → Map(opening id → designs)
const SIDE_BLOCK = 40;

/** What each shop of a lot sells, per front (as built). */
export function lotTypes(app, lot) {
  return frontsOf(app, lot).map((fr) => {
    const c = { plan: fr.plan, frame: fr.frame, lot, app, streetW: fr.streetW, cafe: fr.cafe, q: 1, lod: 0 };
    prepareFront(c);
    return c.shopTypes;
  });
}

/**
 * What the facades decided for a lot's fronts, for tools and checks: per front the shop
 * types, the café terrace's shop, the umbrella span and the u span of every shop awning.
 */
export function frontInfo(app, lot) {
  return frontsOf(app, lot).map((fr) => {
    const c = { plan: fr.plan, frame: fr.frame, lot, app, streetW: fr.streetW, cafe: fr.cafe, q: 1, lod: 0 };
    prepareFront(c);
    const awnings = [];
    for (const o of fr.plan.openings) {
      const a = awningOf(c, o);
      if (a) awnings.push({ id: o.id, u0: o.uc - o.w / 2 - 0.15, u1: o.uc + o.w / 2 + 0.15, type: a.type });
    }
    return { types: c.shopTypes, subs: c.subs, terrace: terraceCafeOpening(c), umbrellas: c.umbrellas, awnings, cafeAwning: !!c.cafeAwning };
  });
}

const _w = new THREE.Vector3();
const returnS = new WeakMap();        // corner-return plan → route position of its face
/**
 * Route position of opening o on a main-street front: along the lot for its street face
 * (u runs against s on the right-hand side), the corner's position for a return.
 */
function openingS(app, lot, frame, plan, o) {
  if (!plan.isReturn) {
    const t = Math.min(1, Math.max(0, o.uc / (plan.width || 1)));
    return app.route.wrap(lot.side > 0 ? lot.s1 - t * (lot.s1 - lot.s0) : lot.s0 + t * (lot.s1 - lot.s0));
  }
  let s = returnS.get(plan);
  if (s === undefined) {
    _w.set((plan.width || 0) / 2, 0, 0).applyMatrix4(frame.matrix);
    s = app.route.wrap(app.route.project(_w.x, _w.z, (lot.s0 + lot.s1) / 2, Math.abs(lot.s1 - lot.s0) / 2 + 12).s);
    returnS.set(plan, s);
  }
  return s;
}

/** Block of shop o on a front (plan, frame) of lot: {key, phase, b}. */
function blockOf(app, lot, frame, plan, o) {
  if (lot.sideStreet) {
    const b = Math.floor((lot.x0 + lot.x1) / 2 / SIDE_BLOCK);
    return { key: `X${Math.round(lot.cross.s)}|${lot.side}|${lot.edge}|${b}`, phase: b % 3, b, side: true };
  }
  const L = app.route.length, n = 3 * Math.max(1, Math.round(L / 120)), len = L / n;
  const b = Math.min(n - 1, Math.floor(openingS(app, lot, frame, plan, o) / len));
  return { key: `M${lot.side}|${b}`, phase: b % 3, b, n, len };
}

function computeBlock(app, lot, blk) {
  const shops = [];
  const take = (l) => {
    const types = lotTypes(app, l);
    frontsOf(app, l).forEach((fr, fi) => {
      for (const o of fr.plan.openings) {
        if (o.kind !== 'shop') continue;
        const ob = blockOf(app, l, fr.frame, fr.plan, o);
        if (ob.key !== blk.key) continue;
        const s = blk.side ? (l.x0 + l.x1) / 2 + o.uc * 1e-3 : openingS(app, l, fr.frame, fr.plan, o);
        shops.push({ id: o.id, s, req: dressRequest(o, types[fi].get(o.id)) });
      }
    });
  };
  if (blk.side) {
    for (const l of app.layout.sideLots) if (l.side === lot.side && l.edge === lot.edge && l.cross === lot.cross) take(l);
  } else {
    const route = app.route, a = blk.b * blk.len, c = a + blk.len / 2;
    for (const l of app.layout.lots) {
      if (l.side !== lot.side) continue;
      const m = (l.s0 + l.s1) / 2;
      if (Math.abs(route.delta(c, m)) < blk.len / 2 + Math.abs(l.s1 - l.s0) / 2 + 25) take(l);
    }
  }
  shops.sort((p, q) => p.s - q.s || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  return allocateBlock(shops, blk.phase, hashStr(blk.key));
}

/** The window designs given to shop o of the front in ctx ({app, lot, frame, plan}). */
export function shopAlloc(ctx, o) {
  const blk = blockOf(ctx.app, ctx.lot, ctx.frame, ctx.plan, o);
  let m = blockCache.get(blk.key);
  if (!m) {
    m = computeBlock(ctx.app, ctx.lot, blk);
    blockCache.set(blk.key, m);
    // bounded: a block is cheap to recompute, and the ride passes ~125 per lap
    if (blockCache.size > 400) blockCache.delete(blockCache.keys().next().value);
  }
  return m.get(o.id) || null;
}

export function* buildFront(kit, ctx) {
  const plan = ctx.plan;
  const signs = prepareFront(ctx);
  const shopTypes = ctx.shopTypes;
  ctx.joinery = joineryStyle(plan, RNG.from(plan.seed, 'joinery'));
  // one joinery colour per building (its type's palette), one for its shutters
  const jr = RNG.from(plan.seed, 'joineryColour');
  ctx.frameRGB = swatch(ctx.joinery.type, jr);
  ctx.shutterRGB = swatch('shutter', jr);
  // a few facades (hotels, pensions) carry canvas hoods over the lower upper-floor windows
  const hr = RNG.from(plan.seed, 'hotel');
  const hotel = plan.style.era !== 'modern' && !plan.isReturn && hr.chance(0.08);
  if (hotel) ctx.hotelColors = awningColors(hr);
  for (const o of plan.openings) {
    if (o.kind === 'window' || o.kind === 'balconyDoor') {
      buildWindow(kit, ctx, o);
      if (hotel && o.kind === 'window' && !o.shutters && !o.ac && o.floor >= 1 && o.floor <= 2) buildUpperAwning(kit, ctx, o);
    }
    else if (o.kind === 'shop') yield* buildShop(kit, ctx, o, signs.byOpening.get(o.id), shopTypes.get(o.id));
    else if (o.kind === 'door') buildDoor(kit, ctx, o);
    yield;
  }
  for (const ws of signs.wall) buildWallSign(kit, ctx, ws);
  for (const s of plan.signs || []) if (s.kind === 'blade') buildBlade(kit, ctx, s, shopTypes);
  buildProjecting(kit, ctx, signs);
  if (ctx.cafeAwning) buildCafeAwning(kit, ctx, ctx.cafeAwning);
}
