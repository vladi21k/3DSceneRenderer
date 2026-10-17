// Placement of infill for one facade front (a lot's street face or a corner return):
// picks templates, colours and interior parameters for each opening and appends them to
// the chunk kit. Local coordinates per opening: x across, y up from the sill, z out of
// the infill plane (w = −recess); wall-mounted items use the wall face (w = 0).
import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { Tpl, lin } from './geo.js';
import { joineryStyle, joineryTpl, glassTpl, shutterTpl } from './windows.js';
import { shopLayout, shopFrameTpl, shopGlassTpl, shopShutterTpl, SHOP_FW } from './shops.js';
import { doorLayout, doorTpl, doorGlassTpl, doorMetalTpl } from './doors.js';
import { signDesign, fasciaTpls, bladeTpls, plaqueTpl, signColor } from './signs.js';
import { slopeAwning, domeAwning, awningColors } from './awnings.js';
import { crownY, isArched, halfWidthAt, outlinePts } from './outline.js';
import { paint } from './kit.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const _m = new THREE.Matrix4(), _t = new THREE.Matrix4(), _r = new THREE.Matrix4();

const SHOP_FRAMES = [0x1e1f20, 0x34373a, 0x2a3d30, 0x3b2f25, 0x585c5d, 0xcfcdc5, 0x23303d];
const DOOR_COLORS = { brown: 0x4a2e1c, varnish: 0x5e3b20, green: 0x283f30, blue: 0x2b5068, black: 0x1d1d1e, red: 0x561c19 };
const ROLLER = [0xb9b7b0, 0xd4d1c8, 0x8c8e8c, 0xc9bfa8];
const BRASS = lin(0xb08a45), BLACK_IRON = [0.035, 0.035, 0.037];

/** Matrix for an opening's local frame. */
function openingMatrix(frame, o, out = _m) {
  return out.copy(frame.matrix).multiply(_t.makeTranslation(o.uc, o.y, -o.recess));
}
/** Matrix for a point on the wall face (u, v). */
function wallMatrix(frame, u, v, out = _m) {
  return out.copy(frame.matrix).multiply(_t.makeTranslation(u, v, 0));
}

/** Interior glass attributes for an opening with glass at local depth zRef. */
export function glassAttrs(ctx, o, { W, H, D, roomY0, seed, drape, kind, zRef = -0.012, lit = o.lit }) {
  const winY0 = o.y - roomY0, winY1 = winY0 + o.h;
  const baseH = roomY0 - ctx.plan.groundAt(o.uc);
  const hw = o.w / 2;
  return {
    aRoomP: (k, sp, a, i) => { a[i] = W / 2 + sp[k * 3]; a[i + 1] = winY0 + sp[k * 3 + 1]; a[i + 2] = Math.max(0, zRef - sp[k * 3 + 2]); a[i + 3] = hw; },
    aRoomS: [W, H, D, baseH],
    aWin: [seed, lit, drape, kind],
    aFac: [ctx.angle, Math.floor(ctx.streetW) + Math.min(0.95, o.recess), winY0, winY1], // street width + recess packed
  };
}

// ------------------------------------------------------------------ windows
function buildWindow(kit, ctx, o) {
  const plan = ctx.plan;
  const m = openingMatrix(ctx.frame, o);
  const v = ctx.joinery;
  const r = RNG.from(o.id);
  const fc = ctx.frameRGB, k = 0.9 + r.next() * 0.16;
  kit.get('frame').add(joineryTpl(o, v, ctx.q), m, fc[0] * k, fc[1] * k, fc[2] * k);
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
  kit.get('glass').add(glassTpl(o, v), m, 1, 1, 1, glassAttrs(ctx, o, { W, H, D, roomY0, seed, drape, kind: 0 }));
  if (o.shutters) {
    const sc = ctx.shutterRGB, ks = 0.85 + r.next() * 0.2;
    // open leaves lie on the wall face, clear of a projecting stone surround
    const standoff = plan.style.surrounds ? 0.055 : 0.012;
    kit.get('shutter').add(shutterTpl(o, o.shutters, ctx.q, standoff), m, sc[0] * ks, sc[1] * ks, sc[2] * ks);
  }
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
    if (!o) { wall.push({ s, design, y: s.y, h: s.h }); continue; }
    if (o.kind !== 'shop') continue;
    const crown = o.y + crownY(o);
    if (o.awning) { byOpening.set(o.id, { mode: 'valance', design }); continue; }
    const archedHead = isArched(o) && o.top !== 'segment';
    if (archedHead && crown > s.y + 0.1) { byOpening.set(o.id, { mode: 'head', design }); continue; }
    const y = Math.max(s.y, crown + 0.1), h = Math.min(s.h, ceiling - y);
    if (h >= 0.32) wall.push({ s, design, y, h, o });
    else byOpening.set(o.id, { mode: 'head', design });
  }
  return { byOpening, wall };
}

function addSignText(kit, design, m, w, h, q, glow = design.glow) {
  const tp = fasciaTpls(design, w, h, q);
  const ink = signColor(design.ink);
  if (tp.board) {
    const bc = signColor(design.board);
    kit.get('signBoard').add(tp.board, m, bc[0], bc[1], bc[2], { aGlow: [glow] });
  }
  kit.get('signText').add(tp.text, m, ink[0], ink[1], ink[2], { aGlow: [glow] });
}

function buildWallSign(kit, ctx, ws) {
  const { s, design, y, h } = ws;
  const w = s.u1 - s.u0;
  const m = wallMatrix(ctx.frame, (s.u0 + s.u1) / 2, y + h / 2);
  addSignText(kit, design, m, w, h, ctx.q);
  // gooseneck lamps over painted boards
  if (design.type === 'board' && ctx.q >= 0.5) {
    const n = w > 2.4 ? 3 : 2;
    for (let i = 0; i < n; i++) {
      const u = s.u0 + (w * (i + 0.5)) / n;
      const ml = wallMatrix(ctx.frame, u, y + h + 0.06, new THREE.Matrix4());
      kit.get('metal').add(ctx.assets.signLamp.metal, ml, ...BLACK_IRON);
      kit.get('lamp').add(ctx.assets.signLamp.glass, ml);
    }
  }
}

function buildBlade(kit, ctx, s) {
  const plan = ctx.plan;
  let y = s.y;
  const f1 = plan.floors[1];
  const blocked = f1 && (plan.balconies || []).some((b) => b.floor === 1 && s.u > b.u0 - 0.9 && s.u < b.u1 + 0.9);
  if (blocked) y = f1.y - 0.7 - s.h;
  if (y - plan.groundAt(s.u) < 2.5) return;
  const tp = bladeTpls(s.seed, s.w, s.h, ctx.q);
  const m = wallMatrix(ctx.frame, s.u, y);
  const r = new RNG(s.seed);
  const edge = lin(r.pick([0x1d1d1f, 0x2a2a2c, 0xd8b25a, 0xe8e4da]));
  const glow = r.chance(0.5) ? 0.7 : 0;
  kit.get('signBoard').add(tp.board, m, edge[0], edge[1], edge[2], { aGlow: [0] });
  kit.get('signText').add(tp.text, m, 1, 1, 1, { aGlow: [glow] });
  kit.get('metal').add(tp.metal, m, ...BLACK_IRON);
}

// ------------------------------------------------------------------ shops
function buildShop(kit, ctx, o, signInfo) {
  const plan = ctx.plan;
  const r = RNG.from(o.id, 'shop');
  const L = shopLayout(o, r);
  if (signInfo && signInfo.mode === 'head') {
    if (L.yT > o.h - SHOP_FW - 0.25 && !isArched(o)) { L.yT = Math.max(2.5, o.h - SHOP_FW - 0.62); L.doorH = Math.min(L.doorH, L.yT - 0.06); }
    L.head = 'panel'; L.headSign = true;
  }
  const m = openingMatrix(ctx.frame, o, new THREE.Matrix4());
  const fc = L.timber ? paint(plan.style.frameColor) : lin(SHOP_FRAMES[r.int(0, SHOP_FRAMES.length - 1)]);
  kit.get('frame').add(shopFrameTpl(o, L, ctx.q), m, fc[0], fc[1], fc[2]);
  // interior
  const f0 = plan.floors[0];
  const roomY0 = o.y;
  const W = Math.max(4, o.w + 1.6);
  const H = Math.max(3, f0.y + f0.h - roomY0 - 0.3);
  const D = 6.5 + r.next() * 3;
  kit.get('glass').add(shopGlassTpl(o, L), m, 1, 1, 1,
    glassAttrs(ctx, o, { W, H, D, roomY0, seed: r.next(), drape: 0, kind: 1, zRef: -0.02, lit: o.lit }));
  // roller-shutter box and guides
  if (L.box) {
    const rc = lin(r.pick(ROLLER));
    kit.get('frame').add(shopShutterTpl(o, L, ctx.q), m, rc[0], rc[1], rc[2]);
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
    kit.get('signBoard').add(tb.bake(), m, bc[0], bc[1], bc[2], { aGlow: [glow] });
    const band = Math.min(0.5, (top - yH) * 0.62);
    const yc = yH + Math.min(band * 0.5 + 0.06, (top - yH) * 0.42);
    const wAvail = 2 * halfWidthAt(o, yc + band / 2, SHOP_FW) - 0.12;
    const lumB = bc[0] * 0.3 + bc[1] * 0.6 + bc[2] * 0.1;
    const dsg = { ...design, type: 'letters', board: null, ink: lumB > 0.3 ? 0x1d1d1f : (design.cell % 3 ? 0xe9dfc4 : 0xd8b25a) };
    const mt = new THREE.Matrix4().copy(m).multiply(_r.makeTranslation(0, yc, -0.015 - 0.035 + 0.006));
    addSignText(kit, dsg, mt, wAvail, band, ctx.q, glow);
  }
  // awning
  if (o.awning) buildAwning(kit, ctx, o, r, signInfo && signInfo.mode === 'valance' ? signInfo.design : null);
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
    addSignText(kit, dsg, mt, valFront.w * 0.7, valH * 0.72, ctx.q, 0);
  }
}

// ------------------------------------------------------------------ doors
function buildDoor(kit, ctx, o) {
  const plan = ctx.plan;
  const r = RNG.from(o.id, 'door');
  const L = doorLayout(o, r);
  const m = openingMatrix(ctx.frame, o, new THREE.Matrix4());
  const dc = lin(DOOR_COLORS[L.color]);
  const k = 0.9 + r.next() * 0.15;
  kit.get('door').add(doorTpl(o, L, ctx.q), m, dc[0] * k, dc[1] * k, dc[2] * k);
  kit.get('glass').add(doorGlassTpl(o, L), m, 1, 1, 1,
    glassAttrs(ctx, o, { W: 2.6, H: 3.4, D: 3.5, roomY0: o.y, seed: r.next(), drape: 0, kind: 2, zRef: -0.015, lit: Math.min(o.lit ?? 0.5, 0.35) }));
  const metal = doorMetalTpl(o, L, ctx.q);
  if (metal.grille) kit.get('metal').add(metal.grille, m, ...BLACK_IRON);
  const brass = L.color !== 'black' && r.chance(0.7);
  kit.get('hardware').add(metal.handles, m, ...(brass ? BRASS : BLACK_IRON));
  // threshold step (the door sill stands above the paving)
  const ground = plan.groundAt(o.uc) - o.y;
  if (ground < -0.03) {
    const st = new Tpl();
    st.box(-o.w / 2 - 0.12, ground - 0.05, -0.05, o.w / 2 + 0.12, 0.0, o.recess + 0.3, 1 | 4 | 8 | 32, 0.85, 1);
    const tint = plan.style.tint;
    kit.get('stone').add(st.bake(), m, tint[0] * 0.92, tint[1] * 0.92, tint[2] * 0.92);
  }
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
  }
}

// ------------------------------------------------------------------ front
/** Builds one front; a generator that yields after every opening (time slicing). */
export function* buildFront(kit, ctx) {
  const plan = ctx.plan;
  ctx.joinery = joineryStyle(plan, RNG.from(plan.seed, 'joinery'));
  ctx.frameRGB = paint(ctx.joinery.type === 'alu' && /green|teal/.test(plan.style.frameColor) ? 'white' : plan.style.frameColor);
  ctx.shutterRGB = paint(plan.style.shutterColor);
  const signs = planSigns(ctx);
  for (const o of plan.openings) {
    if (o.kind === 'window' || o.kind === 'balconyDoor') buildWindow(kit, ctx, o);
    else if (o.kind === 'shop') buildShop(kit, ctx, o, signs.byOpening.get(o.id));
    else if (o.kind === 'door') buildDoor(kit, ctx, o);
    yield;
  }
  for (const ws of signs.wall) buildWallSign(kit, ctx, ws);
  for (const s of plan.signs || []) if (s.kind === 'blade') buildBlade(kit, ctx, s);
}
