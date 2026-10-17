// Placement of infill for one facade front (a lot's street face or a corner return):
// picks templates, colours and interior parameters for each opening and appends them to
// the chunk kit. Local coordinates per opening: x across, y up from the sill, z out of
// the infill plane (w = −recess); wall-mounted items use the wall face (w = 0).
import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { Tpl, VS, lin } from './geo.js';
import { joineryStyle, joineryTpl, glassTpl, shutterTpl, rollerTpl, canOpen, openLimit } from './windows.js';
import { shopLayout, shopTpls, SHOP_FW } from './shops.js';
import { doorLayout, doorTpls } from './doors.js';
import { signDesign, fasciaTpls, bladeTpls, bladeFace, plaqueTpl, signColor, wordType } from './signs.js';
import { winCode, shopTypeIndex } from './interior.js';
import { spillTpl, spillAttrs, groundGlow } from './spill.js';
import { slopeAwningT as slopeAwning, domeAwningT as domeAwning, awningColors } from './awnings.js';
import { crownY, springY, isArched, halfWidthAt, outlinePts } from './outline.js';
import { paint } from './kit.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const _m = new THREE.Matrix4(), _t = new THREE.Matrix4(), _r = new THREE.Matrix4(), _ms = new THREE.Matrix4();
const IDENT = new THREE.Matrix4();

const SHOP_FRAMES = [0x1e1f20, 0x34373a, 0x2a3d30, 0x3b2f25, 0x585c5d, 0xcfcdc5, 0x23303d];
const DOOR_COLORS = { brown: 0x4a2e1c, varnish: 0x5e3b20, green: 0x283f30, blue: 0x2b5068, black: 0x1d1d1e, red: 0x561c19 };
const ROLLER = [0xb9b7b0, 0xd4d1c8, 0x8c8e8c, 0xc9bfa8];
const BRASS = lin(0xb08a45), BLACK_IRON = [0.035, 0.035, 0.037];
/** Shops without a sign: what they sell. */
const SHOP_MIX = [['clothing', 0.2], ['general', 0.18], ['cafe', 0.14], ['jewellery', 0.1], ['pharmacy', 0.05], ['shoes', 0.11], ['books', 0.11], ['flowers', 0.11]];

/**
 * Depth available behind the infill plane before the back of the dark box with which
 * the buildings close every opening (facadePlan publishes it per opening).
 */
export const backDepth = (o) => o.backDepth ?? 0.4;

/** Matrix for an opening's local frame. */
function openingMatrix(frame, o, out = _m) {
  return out.copy(frame.matrix).multiply(_t.makeTranslation(o.uc, o.y, -o.recess));
}
/** Matrix for a point on the wall face (u, v). */
function wallMatrix(frame, u, v, out = _m) {
  return out.copy(frame.matrix).multiply(_t.makeTranslation(u, v, 0));
}

/** Warm light from the room onto the reveal of opening o (night only, near range, see spill.js). */
function addSpill(kit, ctx, o, m, lit, kind, dim = 0) {
  if (ctx.q < 0.5) return;
  const sp = spillTpl(o);
  kit.get('spill').add(sp.tpl, m, 1, 1, 1, spillAttrs(lit, kind, dim, sp));
}

/** Interior glass attributes for an opening with glass at local depth zRef. */
export function glassAttrs(ctx, o, { W, H, D, roomY0, seed, drape, kind, type = 0, zRef = -0.012, lit = o.lit }) {
  const winY0 = o.y - roomY0, winY1 = winY0 + o.h;
  const baseH = roomY0 - ctx.plan.groundAt(o.uc);
  const hw = o.w / 2;
  return {
    aRoomP: (k, v, a, i) => { const o = k * VS; a[i] = W / 2 + v[o]; a[i + 1] = winY0 + v[o + 1]; a[i + 2] = Math.max(0, zRef - v[o + 2]); a[i + 3] = hw; },
    aRoomS: [W, H, D, baseH],
    aWin: [seed, lit, drape, winCode(kind, false, type)],
    aFac: [ctx.angle, Math.floor(ctx.streetW) + Math.min(0.95, o.recess), winY0, winY1], // street width + recess packed
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
  const fc = ctx.frameRGB, k = 0.9 + r.next() * 0.16;
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
  if (jt) kit.get('frame').add(jt, m, fc[0] * k, fc[1] * k, fc[2] * k);
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
  if (!jt) ga.aFrame = [fc[0] * k, fc[1] * k, fc[2] * k, 1]; // far range: procedural casing
  const gt = glassTpl(o, v, ctx.q, open);
  kit.get('glass').add(gt.glass, m, 1, 1, 1, ga);
  if (gt.hole) kit.get('glass').add(gt.hole, m, 1, 1, 1, { ...ga, aWin: [seed, o.lit, drape, winCode(0, true)] }); // no glass: open aperture
  if (o.shutters !== 'closed') addSpill(kit, ctx, o, m, o.lit, 0, drapeDim(drape));
  // external roller shutters on flat heads (modern and some Mandate facades)
  const rollerP = v.type === 'alu' ? 0.75 : plan.style.era === 'mandate' ? 0.18 : 0.04;
  if (!o.shutters && o.top === 'flat' && o.recess > 0.15 && r.next() < rollerP) {
    const rr = r.next();
    const down = rr < 0.35 ? 0 : rr < 0.8 ? 0.15 + r.next() * 0.5 : 1;
    const rc = lin([0xd9d6cc, 0xc9c2b2, 0x9a9a96, 0xe6e3da][Math.floor(r.next() * 4)]);
    kit.get('frame').add(rollerTpl(o, down, ctx.q), m, rc[0], rc[1], rc[2]);
  }
  if (o.shutters) {
    const sc = ctx.shutterRGB, ks = 0.85 + r.next() * 0.2;
    // open leaves lie on the wall face, clear of a projecting stone surround
    const standoff = plan.style.surrounds ? 0.055 : 0.012;
    const state = o.shutters === 'open' ? fitOpenShutters(ctx, o, standoff) : o.shutters;
    // open leaves are built relative to the wall face (shared by windows of any recess)
    const ms = state === 'open' || state === 'openSpring' ? _ms.copy(m).multiply(_r.makeTranslation(0, 0, o.recess)) : m;
    kit.get('shutter').add(shutterTpl(o, state, ctx.q, standoff), ms, sc[0] * ks, sc[1] * ks, sc[2] * ks);
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

function addSignText(kit, design, m, w, h, q, glow = design.glow, z0 = 0.055) {
  const tp = fasciaTpls(design, w, h, q, z0);
  const ink = signColor(design.ink);
  if (tp.board) {
    const bc = signColor(design.board);
    kit.get(glow > 0 ? 'signBoard' : 'board').add(tp.board, m, bc[0], bc[1], bc[2], { aGlow: [glow] });
  }
  kit.get('signText').add(tp.text, m, ink[0], ink[1], ink[2], { aGlow: [glow] });
}

function buildWallSign(kit, ctx, ws) {
  const { s, design, y, h } = ws;
  const w = s.u1 - s.u0;
  const m = wallMatrix(ctx.frame, (s.u0 + s.u1) / 2, y + h / 2);
  addSignText(kit, design, m, w, h, ctx.q);
  // gooseneck lamps over painted boards
  if (design.type === 'board' && ws.lamps && ctx.q >= 0.5) {
    const n = w > 2.4 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const u = s.u0 + (w * (i + 0.5)) / n;
      const ml = wallMatrix(ctx.frame, u, y + h + 0.06, new THREE.Matrix4());
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
  const tp = bladeTpls(bladeFace(s.seed, near ? shopTypes.get(near.id) : null), s.w, s.h, ctx.q);
  const m = wallMatrix(ctx.frame, s.u, y);
  const r = new RNG(s.seed);
  const edge = lin(r.pick([0x1d1d1f, 0x2a2a2c, 0xd8b25a, 0xe8e4da]));
  const glow = r.chance(0.5) ? 0.7 : 0;
  kit.get('board').add(tp.board, m, edge[0], edge[1], edge[2]);
  kit.get('signText').add(tp.text, m, 1, 1, 1, { aGlow: [glow] });
  kit.get('metal').add(tp.metal, m, ...BLACK_IRON);
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
  const L = shopLayout(o, RNG.from(plan.seed, 'shopfront', variant), backDepth(o));
  if (headSign) {
    // flat heads: a sign band ~0.55 m tall under the lintel, display glass below it
    if (!isArched(o)) { L.yT = Math.max(2.5, o.h - SHOP_FW - 0.62); L.doorH = Math.min(L.doorH, L.yT - 0.06); }
    L.head = 'panel'; L.headSign = true;
  }
  const T = shopTpls(`${plan.seed}|${variant}|${headSign}`, o, L, ctx.q);
  const m = openingMatrix(ctx.frame, o, new THREE.Matrix4());
  const fc = L.timber ? paint(plan.style.frameColor) : lin(SHOP_FRAMES[r.int(0, SHOP_FRAMES.length - 1)]);
  kit.get('frame').add(T.frame, m, fc[0], fc[1], fc[2]);
  // interior
  const f0 = plan.floors[0];
  const roomY0 = o.y;
  const W = Math.max(4, o.w + 1.6);
  const H = Math.max(3, f0.y + f0.h - roomY0 - 0.3);
  const D = 6.5 + r.next() * 3;
  kit.get('glass').add(T.glass, m, 1, 1, 1,
    glassAttrs(ctx, o, { W, H, D, roomY0, seed: r.next(), drape: 0, kind: 1, type: shopTypeIndex(type), zRef: -0.02, lit: o.lit }));
  addSpill(kit, ctx, o, m, o.lit, 1);
  // its light on the pavement in front (main-street fronts)
  if (ctx.q >= 0.5 && !ctx.lot.sideStreet && !ctx.plan.isReturn && !ctx.lot.backdrop) {
    const gg = groundGlow(ctx, o);
    if (gg) kit.get('spill').add(gg.tpl, IDENT, 1, 1, 1, gg.attrs);
  }
  // floor of a recessed entrance (the buildings' dark box behind it is unlit)
  if (T.recess) { const tint = plan.style.tint; kit.get('stone').add(T.recess, m, tint[0] * 0.8, tint[1] * 0.78, tint[2] * 0.74); }
  yield;
  // roller-shutter box and guides
  if (L.box) {
    const rc = lin(r.pick(ROLLER));
    kit.get('frame').add(T.shutter, m, rc[0], rc[1], rc[2]);
  }
  // door push bar / handle
  if (ctx.q >= 0.5) {
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
    const dsg = { ...design, type: 'letters', board: null, ink: lumB > 0.3 ? 0x1d1d1f : (design.cell % 3 ? 0xe9dfc4 : 0xd8b25a) };
    const mt = new THREE.Matrix4().copy(m).multiply(_r.makeTranslation(0, yc, -0.015 - 0.035 + 0.006));
    if (!signInfo.noText) addSignText(kit, dsg, mt, wAvail, band, ctx.q, glow, 0.015);
  }
  // awning
  if (hasAwning(ctx, o)) {
    yield;
    buildAwning(kit, ctx, o, r, signInfo && signInfo.mode === 'valance' ? signInfo.design : null);
  }
}

// ------------------------------------------------------------------ awnings
function buildAwning(kit, ctx, o, r, design) {
  const plan = ctx.plan;
  const col = o.awning.color ? { c1: lin(o.awning.color), c2: lin(o.awning.color), period: 0 } : awningColors(r);
  const crown = crownY(o);
  const arched = isArched(o) && o.top !== 'segment';
  const ground = plan.groundAt(o.uc) - o.y; // paving relative to the sill (≤ 0)
  let tpl, mLocal, valFront = null;
  const valH = r.range(0.2, 0.28);
  if (o.awning.type === 'dutch') {
    if (arched) {
      const R = o.w / 2 + 0.12;
      tpl = domeAwning(0, R, valH, ctx.q);
      mLocal = [0, crown + 0.12 - R, o.recess]; // on the spring line for round heads
    } else {
      const R = Math.min(0.85, Math.max(0.6, (crown - ground - 2.4) * 0.6));
      const W = o.w + 0.3;
      tpl = domeAwning(W, R, valH, ctx.q);
      mLocal = [0, crown + 0.15 - R, o.recess];
      if (W - 2 * R > 1.0) valFront = { w: W - 2 * R, y: mLocal[1] - valH / 2, z: o.recess + R + 0.012 };
    }
  } else {
    const W = o.w + 0.3;
    const top = crown + 0.14;
    const P = r.range(1.0, 1.5);
    const D = Math.max(0.35, Math.min(r.range(0.55, 0.8), top - ground - 2.35 - valH));
    tpl = slopeAwning(W, P, D, valH, ctx.q);
    mLocal = [0, top, o.recess];
    valFront = { w: W, y: top - D - valH / 2, z: o.recess + P + 0.012 };
  }
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
    addSignText(kit, dsg, mt, valFront.w * 0.7, valH * 0.72, ctx.q, 0, 0.015);
  }
}

/** Whether shop opening o carries its own awning (none under a café's continuous one). */
function hasAwning(ctx, o) {
  return !!o.awning && !(ctx.cafeAwning && ctx.cafeAwning.covers(o.uc - o.w / 2, o.uc + o.w / 2));
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
  return { units, covers, valH, top, colors: awningColors(r), design: signDesign(lot.seed ^ 0x5ca1ab1e, 'letters', 'cafe') };
}

/** Builds the café awning planned by planCafeAwning, unit by unit. */
function buildCafeAwning(kit, ctx, aw) {
  const { plan, frame, q } = ctx;
  const { valH, top, colors: col } = aw;
  for (const { uc, w, P } of aw.units) {
    // front bar level with the paving under this unit: hem ~2.7 m above its high side
    const g = Math.max(plan.groundAt(uc - w / 2), plan.groundAt(uc + w / 2));
    const D = Math.min(P * 0.68, Math.max(P * 0.1, top - (g + CAFE_HEM + valH)));
    const tpl = slopeAwning(w - 0.03, P, D, valH, q);
    const m = wallMatrix(frame, uc, top, new THREE.Matrix4());
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
      const mt = wallMatrix(frame, uc, top - D - valH / 2 - 0.006, new THREE.Matrix4()).multiply(_r.makeTranslation(0, 0, P + 0.012 - 0.035));
      addSignText(kit, dsg, mt, Math.min(3, w * 0.6), valH * 0.72, q, 0, 0.015);
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
  kit.get('signText').add(plaqueTpl(r.int(0, 31)), wallMatrix(ctx.frame, uP, o.y + 1.95, new THREE.Matrix4()), 1, 1, 1, { aGlow: [0] });
  kit.get('hardware').add(ctx.assets.intercom, wallMatrix(ctx.frame, o.uc - side * (o.w / 2 + 0.3), o.y + 1.4, new THREE.Matrix4()), 0.62, 0.62, 0.6);
  if (r.chance(0.55)) {
    const ml = wallMatrix(ctx.frame, uP, o.y + 2.5, new THREE.Matrix4());
    kit.get('metal').add(ctx.assets.lantern.metal, ml, ...BLACK_IRON);
    kit.get('lamp').add(ctx.assets.lantern.glass, ml);
    kit.get('bulb').add(ctx.assets.lantern.bulb, ml);
  }
}

// ------------------------------------------------------------------ front
/** Builds one front; a generator that yields after every opening (time slicing). */
export function* buildFront(kit, ctx) {
  const plan = ctx.plan;
  ctx.cafeAwning = ctx.cafe ? planCafeAwning(ctx) : null;
  ctx.joinery = joineryStyle(plan, RNG.from(plan.seed, 'joinery'));
  ctx.frameRGB = paint(ctx.joinery.type === 'alu' && /green|teal/.test(plan.style.frameColor) ? 'white' : plan.style.frameColor);
  ctx.shutterRGB = paint(plan.style.shutterColor);
  const signs = planSigns(ctx);
  // what each shop sells: the word on its sign, else a draw (the blade signs follow it)
  const shopTypes = new Map();
  for (const o of plan.openings) {
    if (o.kind !== 'shop') continue;
    const si = signs.byOpening.get(o.id) || signs.wall.find((w) => w.o === o);
    // the shopfronts under a café's awning are the café
    const cafe = ctx.cafeAwning && ctx.cafeAwning.covers(o.uc - o.w / 2, o.uc + o.w / 2);
    shopTypes.set(o.id, cafe ? 'cafe' : si ? wordType(si.design.cell) : RNG.from(o.id, 'type').weighted(SHOP_MIX));
  }
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
  if (ctx.cafeAwning) buildCafeAwning(kit, ctx, ctx.cafeAwning);
}
