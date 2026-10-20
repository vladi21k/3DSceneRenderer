import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { lathe, tube, bar, rbox, xf, merge, quad, boxUV } from './kit.js';
import { proto, placeMatrix, groundSink } from './instancer.js';
import { uvRect, BRANDS } from './prints.js';
import { buildChairGeometry } from './chairs.js';
import { canopyGeo, umbrellaFrame, umbrellaBase, furledGeo, furledPoleGeo, ledGeo, poolGeo, UMB_EDGE_H } from './umbrella.js';
import { planCafe, auditPlans } from './cafePlan.js';

// Café terraces: chairs (chairs.js), bistro tables, market umbrellas (umbrella.js), glazed
// wind screens round 'awning' terraces, tableware and A-frame menu boards. Placements come
// from the collision-free café plan (cafePlan.js). Geometry is authored once (front = +Z,
// y up, origin on the ground) and instanced per chunk.
// Umbrellas differ from café to café: model and size, hem height, the poles' lean, colour
// (one or two per café) or a drink or café brand printed on the valance (prints.js
// BRANDS), LED strips under the ribs (lit after dusk, with a warm pool on the paving), a
// furled one or a gap in the row. Where a run of umbrella terraces already faces this one
// across the street (within 40 m), most terraces stand open to the sky, so the umbrellas
// come in runs on one side at a time, as on the real street.

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ tables
function tableTop(shape, lod) {
  if (shape === 'round') {
    const r = 0.3;
    // planar UVs: grain and speckle run straight across the top, not round it
    return merge([boxUV(lathe([[0, 0.722], [r - 0.006, 0.722], [r, 0.727], [r, 0.745], [r - 0.004, 0.75], [0, 0.75]], lod ? 12 : 56))]);
  }
  return merge([xf(rbox(0.62, 0.028, 0.62, lod ? 0 : 0.006, 1), [0, 0.736, 0])]);
}

function tableBase(type, lod) {
  const seg = lod ? 7 : 14;
  if (type === 'iron') { // cast-iron pedestal with a domed round foot
    return merge([lathe([[0.215, 0], [0.215, 0.012], [0.19, 0.024], [0.11, 0.042], [0.05, 0.075], [0.034, 0.12], [0.046, 0.13], [0.046, 0.15], [0.03, 0.165],
      [0.026, 0.6], [0.04, 0.615], [0.04, 0.645], [0.03, 0.66], [0.032, 0.7], [0.11, 0.705], [0.11, 0.72], [0, 0.722]], seg)]);
  }
  const parts = [lathe([[0.03, 0.02], [0.03, 0.7], [0.1, 0.705], [0.1, 0.72], [0, 0.722]], seg)];
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4;
    const c = Math.cos(a), s = Math.sin(a);
    parts.push(bar([V(c * 0.02, 0.05, s * 0.02), V(c * 0.29, 0.022, s * 0.29)], 0.012, 0.045, { r: 0.004, up: [0, 1, 0], bend: 0 }));
    if (!lod) parts.push(xf(lathe([[0.018, 0], [0.018, 0.012], [0, 0.014]], 8), [c * 0.28, 0, s * 0.28]));
  }
  return merge(parts);
}

// ------------------------------------------------------------------ tableware & menu boards
function cupSet(detail) {
  const seg = detail ? 6 : 12;
  const cer = merge([
    lathe([[0, 0], [0.05, 0], [0.068, 0.01], [0.066, 0.013], [0.048, 0.005], [0, 0.005]], seg),
    lathe(detail ? [[0, 0.006], [0.036, 0.008], [0.04, 0.06], [0, 0.06]] : [[0, 0.006], [0.025, 0.006], [0.036, 0.02], [0.04, 0.06], [0.037, 0.062], [0.034, 0.025], [0, 0.02]], seg),
    detail ? null : tube([V(0.038, 0.05, 0), V(0.058, 0.048, 0), V(0.058, 0.025, 0), V(0.037, 0.022, 0)], 0.004, { radial: 5, bend: 0.01 }),
  ]);
  const cof = merge([xf(new THREE.CircleGeometry(0.034, seg), [0, detail ? 0.0605 : 0.054, 0], [-Math.PI / 2, 0, 0])]);
  return { cer, cof };
}
function waterGlass(detail) {
  return merge([lathe([[0, 0], [0.03, 0], [0.036, 0.105], [0.0335, 0.105], [0.028, 0.004], [0, 0.004]], detail ? 6 : 12)]);
}
/** Tall glass (iced coffee, cola, beer) and the drink in it. */
function tallGlass(detail) {
  const seg = detail ? 6 : 12;
  return {
    glass: merge([lathe([[0, 0], [0.032, 0], [0.038, 0.15], [0.0355, 0.15], [0.03, 0.006], [0, 0.006]], seg)]),
    drink: merge([lathe([[0, 0.007], [0.0298, 0.007], [0.0345, 0.11], [0, 0.11]], seg)]),
  };
}
function plate(detail) {
  return merge([lathe([[0, 0], [0.075, 0], [0.09, 0.006], [0.118, 0.014], [0.121, 0.017], [0.115, 0.016], [0.088, 0.009], [0, 0.009]], detail ? 8 : 20)]);
}
function ashtray(detail) {
  return merge([lathe([[0, 0], [0.045, 0], [0.05, 0.024], [0.043, 0.026], [0.036, 0.008], [0, 0.008]], detail ? 6 : 14)]);
}
function napkinHolder() {
  return {
    steel: merge([xf(rbox(0.1, 0.012, 0.06, 0), [0, 0.006, 0]), xf(rbox(0.004, 0.08, 0.05, 0), [-0.025, 0.05, 0]), xf(rbox(0.004, 0.08, 0.05, 0), [0.025, 0.05, 0])]),
    paper: merge([xf(rbox(0.044, 0.09, 0.07, 0), [0, 0.057, 0])]),
  };
}

function menuBoard(variant, detail) {
  // A-frame: two 0.6 x 0.88 panels hinged at the top, splayed ~22°
  const W = 0.6, H = 0.88, spl = 0.2;
  if (detail >= 1) { // far: two slabs
    const slab = [1, -1].map((side) => xf(rbox(W, H, 0.02, 0), [0, H / 2, side * 0.085], [-side * spl, 0, 0]));
    return { wood: merge(slab), face: null };
  }
  const wood = [], face = [];
  for (const side of [1, -1]) {
    const leg = (x) => bar([V(x, 0, side * 0.17), V(x, H, side * 0.012)], 0.03, 0.022, { r: 0.004, up: [0, 0, 1], bend: 0 });
    wood.push(leg(-W / 2 + 0.015), leg(W / 2 - 0.015));
    wood.push(bar([V(-W / 2, H - 0.02, side * 0.016), V(W / 2, H - 0.02, side * 0.016)], 0.04, 0.022, { r: 0.004, up: [0, 0, 1], bend: 0 }));
    wood.push(bar([V(-W / 2, 0.12, side * 0.148), V(W / 2, 0.12, side * 0.148)], 0.04, 0.022, { r: 0.004, up: [0, 0, 1], bend: 0 }));
    // board in a recess of the frame: back panel plus the chalk face 4 mm in front of it
    const n = new THREE.Vector3(0, Math.sin(spl), Math.cos(spl)).multiplyScalar(side);
    const c = [0, 0.12 + (H - 0.14) / 2, side * 0.08];
    wood.push(xf(rbox(W - 0.05, H - 0.19, 0.008, 0), c, [-side * spl, 0, 0]));
    const q = quad(W - 0.07, H - 0.21, uvRect(`chalk${variant}`));
    xf(q, [c[0] + n.x * 0.0075, c[1] + n.y * 0.0075, c[2] + n.z * 0.0075], [-side * spl, side > 0 ? 0 : Math.PI, 0]);
    face.push(q);
  }
  return { wood: merge(wood), face: merge(face) };
}

// ------------------------------------------------------------------ wind screen
/** Café wind screen panel (1.4 m): aluminium posts and rails, glass upper part, canvas
 *  lower panel, flat steel feet. Local x along the screen, +z towards the street. */
const SCREEN_W = 1.4;
function windScreen(detail) {
  const W = SCREEN_W, H = 1.32, frame = [], glass = [], canvas = [], feet = [];
  const r = detail ? 0 : 0.004;
  for (const x of [-W / 2 + 0.02, W / 2 - 0.02]) {
    frame.push(xf(rbox(0.04, H, 0.04, r, 1), [x, H / 2 + 0.01, 0]));
    feet.push(xf(rbox(0.06, 0.012, 0.42, r, 1), [x, 0.006, 0]));
  }
  frame.push(xf(rbox(W, 0.04, 0.045, r, 1), [0, H + 0.01, 0]), xf(rbox(W - 0.08, 0.03, 0.03, r, 1), [0, 0.43, 0]));
  frame.push(xf(rbox(W - 0.08, 0.025, 0.03, r, 1), [0, 0.06, 0]));
  canvas.push(xf(rbox(W - 0.08, 0.36, 0.006, 0, 1), [0, 0.245, 0]));
  // glass UVs: v = height above the paving (the glazing decal puts its bands at true heights)
  const gy = 0.445 + (H - 0.47) / 2, gl = rbox(W - 0.08, H - 0.47, 0.008, 0, 1), guv = gl.attributes.uv;
  for (let i = 0; i < guv.count; i++) guv.setY(i, guv.getY(i) + gy);
  glass.push(xf(gl, [0, gy, 0]));
  return { frame: merge(frame), glass: merge(glass), canvas: merge(canvas), feet: merge(feet) };
}

// ------------------------------------------------------------------ prototypes
// moulded chair colours: the street's terraces run from signal red and orange-red through
// orange and mustard to light blue, taupe, white, anthracite, olive and green
const PLASTIC = ['#86b5d3', '#cdbb9f', '#e6e3dc', '#d2492f', '#43474b', '#8a9a5b', '#9fc3d8', '#bf2c26', '#e0732c', '#dca833', '#4d8753'];
// [chair colours of a terrace (one or two, mixed at random), weight]: a third of the
// moulded-chair terraces are red
const PLASTIC_PAIRS = [[[7, 7], 3], [[3, 3], 2], [[7, 8], 1], [[8, 9], 1], [[9, 9], 1], [[0, 1], 2], [[0, 0], 1], [[6, 6], 1],
  [[2, 2], 1], [[4, 4], 1], [[5, 1], 1], [[1, 1], 1], [[6, 1], 1], [[10, 10], 1]];
// painted metal chairs: half of the metal terraces, white, anthracite, sage, red or green
const METAL_PAINT = ['#e9e7e1', '#3b3e41', '#6f7a72', '#a3302a', '#2f4b3b'];
const UMB_COL = { cream: '#e6dcc4', white: '#efede6', navy: '#28324a', burgundy: '#6c2531', sand: '#cdb894', ecru: '#d9d0bb',
  black: '#232426', taupe: '#8f8576', green: '#2f5140', red: '#a3282b', grey: '#b9b8b2' };
// plain canopies (no print): mostly cream and white, then navy, sand and darker colours;
// [main colour, weight, alternate colour of a two-colour terrace or null]
const UMB_PLAIN = [[['cream', 'navy'], 0.22], [['white', 'navy'], 0.16], [['ecru', null], 0.12], [['sand', 'cream'], 0.07], [['navy', 'white'], 0.12],
  [['black', 'white'], 0.06], [['taupe', null], 0.06], [['grey', null], 0.05], [['burgundy', 'cream'], 0.05], [['green', 'cream'], 0.05], [['red', 'white'], 0.04]];
const CUSHION = ['#c7bba3', '#6f2b2b', '#2f4a3c', '#d9d2c2', '#33393f', '#b08a5a'];
const SCREEN_COL = ['#2c3a33', '#5a2b2b', '#d8d0bd', '#23324a', '#3a3a38'];
const srgb = (h) => new THREE.Color().setStyle(h, THREE.SRGBColorSpace);

// switch distances (m) between detail levels; chairs stay crisp to ~35 m at the 17° default lens
const LOD_CHAIR = [35, 130], LOD_PLASTIC = [9, 35, 130], LOD_TABLE = [45], LOD_UMB = [55, 170];

/** Copy of a swept / lathed frame with its UVs swapped, so the timber grain (texture u)
 *  runs along the poles and ribs instead of round them. */
function grainAlong(g) {
  if (!g) return g;
  const c = g.clone(), uv = c.attributes.uv;
  for (let i = 0; i < uv.count; i++) { const u = uv.getX(i); uv.setXY(i, uv.getY(i), u); }
  c.userData.shared = true;
  return c;
}

export function buildCafeProtos(M, F, umbKeys = ['30x30']) {
  const P = { chair: {}, top: {}, base: {}, umb: {}, misc: {} };
  const C = buildChairGeometry();
  const col = (lv, key) => lv.map((g) => g[key] || null);
  P.chair.bistro = F.weave.map((w, i) => proto(`chairBistro${i}`, [{ geo: col(C.bistro, 'frame'), mat: F.rattan }, { geo: col(C.bistro, 'weave'), mat: w }], LOD_CHAIR));
  P.chair.plastic = proto('chairPlastic', [{ geo: col(C.plastic, 'shell'), mat: F.plastic, tint: true }, { geo: col(C.plastic, 'glides'), mat: F.rubber, cast: false }], LOD_PLASTIC);
  P.chair.metal = proto('chairMetal', [{ geo: col(C.metal, 'frame'), mat: F.aluminium }], LOD_CHAIR);
  P.chair.metalPaint = proto('chairMetalPaint', [{ geo: col(C.metal, 'frame'), mat: F.paintFine, tint: true }], LOD_CHAIR);
  P.chair.wicker = proto('chairWicker', [{ geo: col(C.wicker, 'body'), mat: F.wicker, tint: true }, { geo: col(C.wicker, 'legs'), mat: F.rattan },
    { geo: col(C.wicker, 'cushion'), mat: F.cushion, tint: true, tintKey: 'cushion' }], LOD_CHAIR);
  for (const shape of ['round', 'square']) {
    const g = [tableTop(shape, 0), tableTop(shape, 1)];
    P.top[`${shape}stone`] = proto('tableTopStone', [{ geo: g, mat: F.tabletop, tint: true }], LOD_TABLE);
    P.top[`${shape}alu`] = proto('tableTopAlu', [{ geo: g, mat: F.aluminium }], LOD_TABLE);
    P.top[`${shape}wood`] = proto('tableTopWood', [{ geo: g, mat: F.timber }], LOD_TABLE);
  }
  const iron = [tableBase('iron', 0), tableBase('iron', 1)], cross = [tableBase('cross', 0), tableBase('cross', 1)];
  P.base.iron = proto('tableBaseIron', [{ geo: iron, mat: F.iron }], LOD_TABLE);
  P.base.cross = proto('tableBaseCross', [{ geo: cross, mat: F.aluminium }], LOD_TABLE);
  P.base.crossDark = proto('tableBaseCrossDark', [{ geo: cross, mat: F.iron }], LOD_TABLE);
  // umbrellas: canopy geometry per canopy size the café plans use ('<across>x<along>' in
  // decimetres), three detail levels each
  for (const key of umbKeys) {
    const [su, sv] = key.split('x').map((v) => +v / 10);
    const cg = [0, 1, 2].map((d) => canopyGeo(su, sv, d));
    const fr = [0, 1, 2].map((d) => umbrellaFrame(su, sv, d));
    P.umb[key] = {
      canopy: proto('umbrellaCanopy', [{ geo: cg, mat: F.canopy, tint: true }], LOD_UMB),
      alu: proto('umbrellaFrameAlu', [{ geo: fr, mat: F.umbFrame }], LOD_UMB),
      wood: proto('umbrellaFrameWood', [{ geo: fr.map(grainAlong), mat: F.timber }], LOD_UMB),
      led: proto('umbrellaLed', [{ geo: [0, 1, 2].map((d) => ledGeo(su, sv, d)), mat: F.umbLed, cast: false }], LOD_UMB),
    };
  }
  P.umb.pool = proto('umbrellaPool', [{ geo: poolGeo(), mat: F.umbPool, cast: false }]);
  const slab = [umbrellaBase('slab', 0), umbrellaBase('slab', 1)];
  P.umb.slab = proto('umbrellaBase', [{ geo: slab.map((b) => b.conc), mat: F.concrete }, { geo: slab.map((b) => b.steel), mat: F.galv }], LOD_TABLE);
  P.umb.disc = proto('umbrellaDisc', [{ geo: [umbrellaBase('disc', 0).iron, umbrellaBase('disc', 1).iron], mat: F.iron }], LOD_TABLE);
  P.umb.furled = proto('umbrellaFurled', [{ geo: [furledGeo(0), furledGeo(1)], mat: F.canopy, tint: true }], LOD_TABLE);
  P.umb.furledPole = proto('umbrellaFurledPole', [{ geo: [furledPoleGeo(0), furledPoleGeo(1)], mat: F.umbFrame }], LOD_TABLE);
  // tableware: hidden beyond 30 m (per instance)
  const cs = [cupSet(0), cupSet(1)];
  P.misc.cup = proto('cup', [{ geo: [cs[0].cer, cs[1].cer, null], mat: F.ceramic, cast: false }, { geo: [cs[0].cof, cs[1].cof, null], mat: F.coffee, cast: false }], [14, 30]);
  P.misc.glass = proto('glass', [{ geo: [waterGlass(0), waterGlass(1), null], mat: F.drinkGlass, cast: false }], [14, 30]);
  const nh = napkinHolder();
  P.misc.napkin = proto('napkin', [{ geo: [nh.steel, null], mat: F.steel, cast: true }, { geo: [nh.paper, null], mat: F.ceramic, cast: false }], [30]);
  const tg = [tallGlass(0), tallGlass(1)];
  P.misc.tall = proto('tallGlass', [{ geo: [tg[0].glass, tg[1].glass, null], mat: F.drinkGlass, cast: false }, { geo: [tg[0].drink, tg[1].drink, null], mat: F.coffee, cast: false }], [14, 30]);
  P.misc.plate = proto('plate', [{ geo: [plate(0), plate(1), null], mat: F.ceramic, cast: false }], [14, 30]);
  P.misc.ashtray = proto('ashtray', [{ geo: [ashtray(0), ashtray(1), null], mat: F.steel, cast: false }], [14, 30]);
  P.misc.phone = proto('phone', [{ geo: [merge([xf(rbox(0.072, 0.008, 0.152, 0.003, 1), [0, 0.004, 0])]), null], mat: F.interior, cast: false }], [20]);
  // menu folder lying on the table: leatherette cover in the café's colour
  P.misc.folder = proto('menuFolder', [{ geo: [merge([xf(rbox(0.235, 0.008, 0.325, 0.003, 1), [0, 0.004, 0])]), null], mat: F.paintFine, tint: true, cast: false }], [25]);
  for (const v of [0, 1]) {
    const mb = [menuBoard(v, 0), menuBoard(v, 1)];
    P.misc[`menu${v}`] = proto('menuBoard', [{ geo: mb.map((m) => m.wood), mat: F.timber, cast: true }, { geo: mb.map((m) => m.face), mat: F.print, cast: false }], [40]);
  }
  const ws = [windScreen(0), windScreen(1)];
  P.misc.screen = proto('windScreen', [{ geo: ws.map((w) => w.frame), mat: F.aluminium }, { geo: ws.map((w) => w.glass), mat: F.shelterGlass, cast: false },
    { geo: ws.map((w) => w.canvas), mat: F.canvasPanel, tint: true }, { geo: ws.map((w) => w.feet), mat: F.galv }], [60]);
  return P;
}

// ------------------------------------------------------------------ per-café plan + style (cached)
const styleCache = new Map();
/** Café style and collision-free placements; adjusted chair poses are written back to the
 *  layout chairs so seated patrons (crowd) use the same spots. */
export function cafeStyle(cafe, app) {
  let st = styleCache.get(cafe);
  if (st) return st;
  const seed = app.layout.seed;
  const rng = RNG.from(seed, 'cafeStyle', cafe.id);
  st = {};
  switch (cafe.chairStyle) {
    case 'bistro': st.weave = rng.int(0, 3); st.top = rng.pick(['stone', 'stone', 'wood']); st.base = 'iron'; st.topTint = srgb(rng.pick(['#ece9e2', '#d9d5cc', '#2b2b2a'])); break;
    case 'plastic': {
      const pr = rng.weighted(PLASTIC_PAIRS);
      st.plastic = pr.map((i) => srgb(PLASTIC[i]));
      st.top = rng.pick(['stone', 'alu']); st.base = rng.pick(['cross', 'crossDark']); st.topTint = srgb(rng.pick(['#e4e1da', '#3a3b3c']));
      break;
    }
    case 'metal': st.paint = rng.chance(0.5) ? srgb(rng.pick(METAL_PAINT)) : null; st.top = rng.pick(['alu', 'stone']); st.base = 'cross'; st.topTint = srgb('#d6d3cc'); break;
    default:
      st.wicker = srgb(rng.pick(['#ffffff', '#ece6dc', '#d3cdc4', '#bdb5aa']));
      st.cushion = srgb(rng.pick(CUSHION));
      st.top = rng.pick(['stone', 'wood']); st.base = rng.pick(['iron', 'crossDark']); st.topTint = srgb(rng.pick(['#2f2f2e', '#e9e6df']));
      break;
  }
  st.frameWood = rng.chance(0.4);
  st.screen = srgb(rng.pick(SCREEN_COL));
  st.folder = srgb(rng.pick(['#2a2422', '#4a1f1c', '#22302a', '#1f2533', '#5a4632']));
  const veg = app.systems.vegetation;
  st.plan = planCafe(cafe, app.route, seed, st.base, app.layout, veg && veg.crownAt ? (t) => veg.crownAt(t) : null, umbrellaSuppressed(app).has(cafe));
  for (const c of st.plan.chairs) {
    const ch = cafe.tables[c.ti].chairs[c.ci];
    ch.s = c.s; ch.d = c.d; ch.yaw = c.yaw;
  }
  // the umbrellas' look: a brand on half the terraces (neighbours never share one), else
  // a plain colour, now and then two alternating; LED strips on about 60 %
  const look = RNG.from(seed, 'cafeUmbLook', cafe.id);
  const brand = look.chance(0.5) ? 1 + ((cafe.id * 5 + 3) % BRANDS.length) : 0;
  const [c0, c1] = brand ? [null, null] : look.weighted(UMB_PLAIN);
  const two = !brand && c1 && look.chance(0.22);
  st.led = look.chance(0.6);
  st.brand = brand;
  st.umbrellas = st.plan.umbrellas.map((u) => {
    const hex = brand ? BRANDS[brand - 1].canopy : UMB_COL[two && u.alt ? c1 : c0];
    const color = srgb(hex).multiplyScalar(u.tint);
    // brand and LED flags ride on the instance colour (decoded by the canopy shader)
    const enc = color.clone();
    enc.r += 4 * brand; enc.g += 4 * (st.led ? 1 : 0);
    return { ...u, color, enc, colorName: brand ? `brand${brand}` : (two && u.alt ? c1 : c0) };
  });
  // the umbrellas as placed go back into the layout (the crowd's waiters walk round the poles)
  cafe.umbrellas = st.umbrellas.map((u) => ({ s: u.s, d: u.d, size: u.size, su: u.su, sv: u.sv, color: u.colorName, furled: u.furled, base: u.base, hem: u.hem }));
  st.throughTable = new Set(st.plan.umbrellas.filter((u) => u.base === 'table').map((u) => u.table));
  st.menu = st.plan.menu;
  // table dressing, planned once on the relaxed chairs: the layout table learns its state
  // (`dressed`) and the chairs whose place is set (`places`, chair indices), so seated
  // patrons sit exactly at the cups and plates
  st.ware = cafe.tables.map((t, ti) => {
    const w = planTableware(t, wareRng(seed, cafe, ti), st.throughTable.has(ti));
    t.dressed = w.state;
    t.places = w.places;
    return w.items;
  });
  styleCache.set(cafe, st);
  return st;
}

/**
 * Umbrella terraces facing a run on the other side of the street (within 40 m of each
 * other's ends) mostly stand open instead: one side at a time carries the umbrellas, as
 * on the real street. Kept first: the opening run ahead of the default start, then the
 * avenue's right-hand (café) side, then by a per-café draw. Computed once per layout.
 */
const _suppressed = new WeakMap();
function umbrellaSuppressed(app) {
  const L = app.layout, r = app.route;
  let set = _suppressed.get(L);
  if (set) return set;
  set = new Set();
  const mid = (c) => (c.s0 + c.s1) / 2;
  const pri = (c) => {
    const ahead = r.delta(L.defaultStartS, mid(c));
    return RNG.from(L.seed, 'umbPri', c.id).next() + (c.side > 0 && r.wrap(mid(c)) < 1500 ? 0.6 : 0) + (c.side > 0 && ahead > 0 && ahead < 170 ? 2 : 0);
  };
  const list = L.cafes.filter((c) => c.style === 'umbrella' && c.umbrellas && c.umbrellas.length).map((c) => [c, pri(c)]).sort((a, b) => b[1] - a[1]);
  const kept = [];
  for (const [c] of list) {
    const half = (c.s1 - c.s0) / 2;
    const facing = kept.some((k) => k.side !== c.side && Math.abs(r.delta(mid(k), mid(c))) < 40 + half + (k.s1 - k.s0) / 2);
    if (facing && RNG.from(L.seed, 'umbSup', c.id).chance(0.75)) set.add(c); else kept.push(c);
  }
  _suppressed.set(L, set);
  return set;
}

/** Canopy size keys ('<across>x<along>', decimetres) of every open umbrella planned. */
export function umbrellaKeys(app) {
  const keys = new Set(['30x30']);
  for (const c of app.layout.cafes) for (const u of cafeStyle(c, app).umbrellas) if (!u.furled || u.base === 'table') keys.add(u.key);
  return [...keys].sort();
}

/** Plan every café once (init) and report placement problems. */
export function planAllCafes(app) {
  const plans = app.layout.cafes.map((cafe) => ({ cafe, plan: cafeStyle(cafe, app).plan }));
  const audit = auditPlans(plans, app.route);
  if (audit.canopyOverlaps || audit.baseClashes) console.warn('[furniture] café placement problems', JSON.stringify(audit));
  return audit;
}

/** Café data for other modules: adjusted chair pose {s, d, yaw} (yaw: route-relative heading). */
export function chairPose(app, cafeId, ti, ci) {
  const cafe = app.layout.cafes[cafeId];
  if (!cafe) return null;
  cafeStyle(cafe, app);
  const ch = cafe.tables[ti]?.chairs[ci];
  return ch ? { s: ch.s, d: ch.d, yaw: ch.yaw } : null;
}

const _m = new THREE.Matrix4(), _c = new THREE.Color(), _mb = new THREE.Matrix4(), _mu = new THREE.Matrix4(), _mp = new THREE.Matrix4(), _tilt = new THREE.Matrix4();
const _eu = new THREE.Euler(), _sv = new THREE.Vector3();
// base radius (m) of each item for the sink into sloping paving (see groundSink)
const FOOT = { chair: 0.28, table: 0.25, slab: 0.38, disc: 0.23, menu: 0.3 };
const TABLE_H = 0.75;

/** Add all cafés anchored in this chunk to the instancer. */
export function placeCafes(chunk, app, inst, P, debug = null) {
  const { route, layout } = app;
  const lod = chunk.lod;
  for (const cafe of layout.inChunk('cafes', chunk.index)) {
    const st = cafeStyle(cafe, app);
    const rng = RNG.from(layout.seed, 'cafeItems', cafe.id);
    cafe.tables.forEach((t, ti) => {
      for (const ch of t.chairs) {
        placeMatrix(route, ch.s, ch.d, 0, ch.yaw, _m, FOOT.chair);
        switch (cafe.chairStyle) {
          case 'bistro': inst.add(P.chair.bistro[st.weave], _m); break;
          case 'plastic': inst.add(P.chair.plastic, _m, _c.copy(st.plastic[rng.chance(0.5) ? 0 : 1]).multiplyScalar(rng.range(0.95, 1.03))); break;
          case 'metal': if (st.paint) inst.add(P.chair.metalPaint, _m, st.paint); else inst.add(P.chair.metal, _m); break;
          default: inst.add(P.chair.wicker, _m, _c.copy(st.wicker).multiplyScalar(rng.range(0.92, 1.04)), { cushion: st.cushion });
        }
      }
      const tyaw = t.shape === 'square' ? rng.range(-0.08, 0.08) : rng.range(0, 6.28);
      placeMatrix(route, t.s, t.d, 0, tyaw, _m, FOOT.table);
      inst.add(P.top[`${t.shape}${st.top}`], _m, _c.copy(st.topTint).multiplyScalar(rng.range(0.95, 1.04)));
      inst.add(P.base[st.base], _m);
      if (lod === 0) placeTableware(route, t, st.ware[ti], inst, P, st.folder);
    });
    for (const u of st.umbrellas) {
      const uf = FOOT[u.base] ?? FOOT.table;
      placeMatrix(route, u.s, u.d, 0, u.yaw, _m, uf);
      if (u.base === 'slab') inst.add(P.umb.slab, u.baseYaw ? placeMatrix(route, u.s, u.d, 0, u.yaw + u.baseYaw, _mb, uf) : _m);
      else if (u.base === 'disc') inst.add(P.umb.disc, _m);
      // the pole leans in its base (about the foot), and the canopy, built with its hem at
      // UMB_EDGE_H, sinks to the café's hem height (the pole runs on below the paving)
      _mu.copy(_m).multiply(_tilt.makeRotationFromEuler(_eu.set(u.tiltX || 0, 0, u.tiltZ || 0)));
      if (u.furled && u.base !== 'table') {
        inst.add(P.umb.furledPole, _mu);
        inst.add(P.umb.furled, _mu, u.color);
        continue;
      }
      _mu.multiply(_tilt.makeTranslation(0, u.hem - UMB_EDGE_H, 0));
      const U = P.umb[u.key] || P.umb['30x30'];
      inst.add(U.canopy, _mu, u.enc);
      inst.add(st.frameWood ? U.wood : U.alu, _mu);
      if (st.led) {
        inst.add(U.led, _mu);
        // the warm pool the strips throw on the paving (drawn after dusk only)
        inst.add(P.umb.pool, _mp.copy(_m).scale(_sv.set(u.su * 1.35, 1, u.sv * 1.35)));
      }
    }
    if (st.menu) {
      placeMatrix(route, st.menu.s, st.menu.d, 0, (cafe.side > 0 ? -Math.PI / 2 : Math.PI / 2) + st.menu.yaw, _m, FOOT.menu);
      inst.add(P.misc[`menu${st.menu.v}`], _m);
    }
    if (cafe.style === 'awning') placeScreens(cafe, st, app, inst, P);
    if (debug) debug(cafe, st);
  }
}

/** Table dressing: a table is bare, laid (napkins, a menu folder, an ashtray) or in use,
 *  each place with its own order (espresso, water, a tall glass, a plate) and the odd phone
 *  or folder beside it. The state is the first draw of the table's own generator. Planned
 *  once per table (cafeStyle, at init): {state (0 bare, 1 laid, 2 in use), places (chair
 *  indices with a setting), items [{k (misc proto), s, d, yaw, f (folder colour)}]}. */
const SETTINGS = [['cup', 0.34], ['glass', 0.2], ['tall', 0.16], ['plate', 0.18], ['cupGlass', 0.12]];
const wareRng = (seed, cafe, ti) => RNG.from(seed, 'cafeWare', cafe.id, ti);
// about half the tables in use, so the terraces near the camera are 50-70 % occupied
const wareState = (rng) => rng.weighted([[0, 0.25], [1, 0.2], [2, 0.55]]);
function planTableware(t, rng, pole) {
  const state = wareState(rng), items = [], places = [];
  const out = { state, places, items };
  if (!state) return out;
  const reachR = t.shape === 'square' ? 0.26 : 0.23;
  const put = (k, s, d, yaw, f = false) => { items.push({ k, s, d, yaw, f }); };
  // towards place ch: r from the centre, `side` across (m)
  const at = (ch, r, side) => {
    const dx = ch.s - t.s, dd = ch.d - t.d, l = Math.hypot(dx, dd) || 1;
    r = Math.min(r, reachR);
    return [t.s + (dx / l) * r - (dd / l) * side, t.d + (dd / l) * r + (dx / l) * side, Math.atan2(dd, dx)];
  };
  if (!pole && rng.chance(0.6)) put('napkin', t.s + rng.range(-0.04, 0.04), t.d + rng.range(-0.04, 0.04), rng.range(0, 3.14));
  if (rng.chance(state === 1 ? 0.35 : 0.25) && !pole) put('ashtray', t.s + rng.range(-0.1, 0.1), t.d + rng.range(-0.1, 0.1), 0);
  if (state === 1) {
    if (rng.chance(0.6) && t.chairs.length) {
      const [s, d, a] = at(rng.pick(t.chairs), rng.range(0.18, 0.2), rng.range(-0.05, 0.05));
      put('folder', s, d, a + Math.PI / 2 + rng.range(-0.4, 0.4), true);
    }
    return out;
  }
  let used = 0;
  t.chairs.forEach((ch, ci) => {
    if (!rng.chance(0.62) && (used || ch !== t.chairs[t.chairs.length - 1])) return;
    used++;
    places.push(ci);
    const kind = rng.weighted(SETTINGS);
    const [s, d, a] = at(ch, rng.range(0.15, 0.2), rng.range(-0.07, 0.07));
    if (kind === 'plate') {
      const [ps, pd] = at(ch, rng.range(0.17, 0.18), rng.range(-0.03, 0.03)); // clear of the napkins / pole
      put('plate', ps, pd, rng.range(0, 6.28));
    } else if (kind === 'cupGlass') {
      const [gs, gd] = at(ch, rng.range(0.14, 0.18), 0.09);
      put('cup', s, d, rng.range(0, 6.28));
      put('glass', gs, gd, 0);
    } else put(kind, s, d, rng.range(0, 6.28));
    if (rng.chance(0.18)) { // a phone beside the place, or the menu still open
      const [qs, qd] = at(ch, rng.range(0.12, 0.17), rng.chance(0.5) ? 0.13 : -0.13);
      if (rng.chance(0.75)) put('phone', qs, qd, a + rng.range(-0.5, 0.5));
      else put('folder', qs, qd, a + Math.PI / 2 + rng.range(-0.3, 0.3), true);
    }
  });
  return out;
}

/** Instances of a table's planned dressing, on the (level) table top whatever the paving
 *  does under each item. */
function placeTableware(route, t, items, inst, P, folderCol) {
  if (!items.length) return;
  const topY = route.groundY(t.s, t.d) - groundSink(route, t.s, t.d, FOOT.table) + TABLE_H;
  for (const it of items) {
    placeMatrix(route, it.s, it.d, topY - route.groundY(it.s, it.d), it.yaw, _m);
    inst.add(P.misc[it.k], _m, it.f ? folderCol : null);
  }
}

/** Wind screens round an 'awning' terrace (its cover is the facade awning): a run along the
 *  walkway edge with an entrance gap, and short returns at both ends. */
function placeScreens(cafe, st, app, inst, P) {
  const { route } = app;
  const side = cafe.side, sMid = (cafe.s0 + cafe.s1) / 2, k = route.offsetScale(sMid, cafe.dIn);
  const dEdge = cafe.dIn - side * 0.05;
  // enclose every chair: ends 0.4 m beyond the outermost chair footprints
  let lo = 1e9, hi = -1e9;
  for (const t of cafe.tables) for (const ch of t.chairs) { const x = route.delta(sMid, ch.s) * k; lo = Math.min(lo, x); hi = Math.max(hi, x); }
  lo -= 0.7; hi += 0.7;
  const pitch = SCREEN_W + 0.04, door = 1.6;
  const n = Math.max(2, Math.ceil((hi - lo - door) / pitch));
  const run = n * pitch + door, x0 = (lo + hi) / 2 - run / 2;
  const gapAt = Math.floor(n / 2);
  for (let i = 0, x = x0; i < n; i++) {
    if (i === gapAt) x += door;
    inst.add(P.misc.screen, placeMatrix(route, sMid + (x + pitch / 2) / k, dEdge, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2, _m, SCREEN_W / 2), st.screen);
    x += pitch;
  }
  // end returns towards the facade (1 m left free along the wall)
  const nr = Math.floor((Math.abs(cafe.dOut - cafe.dIn) - 1.0) / pitch);
  for (const xe of [x0 - 0.03, x0 + run + 0.03]) {
    for (let i = 0; i < nr; i++) {
      const d = dEdge + side * (0.06 + pitch / 2 + i * pitch);
      inst.add(P.misc.screen, placeMatrix(route, sMid + xe / k, d, 0, 0, _m, SCREEN_W / 2), st.screen);
    }
  }
}

