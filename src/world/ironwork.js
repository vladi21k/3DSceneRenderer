import * as THREE from 'three';
import { RNG, hash2 } from '../core/rng.js';
import { facadePlan, archPoint } from './facadePlan.js';
import { disposeObject } from './streaming.js';
import { DESIGNS, RAIL_H } from './ironwork/patterns.js';
import { bayGeometry, postGeometry, buildAtlas, atlasV, ATLAS, TOL } from './ironwork/railings.js';
import {
  slabPath, writeSlab, corbelGeometry, CORBEL, balusterGeometry, plinthProfile, copingProfile, BALUSTRADE, makeStoneMaterial,
} from './ironwork/stone.js';
import { GeoWriter, sweepPath, box } from './ironwork/geo.js';
import { LodInstancer } from './ironwork/instancer.js';
import { makeMaterials, PAINTS, PAINT_W, uIronPx, uIronA2C, uIronCardK, geoLimit } from './ironwork/mats.js';
import { buildAttachAssets, makeAttachMaterials, writeTemplate } from './ironwork/attach.js';

// Balconies and facade attachments: carved stone slabs on scroll consoles, wrought-iron
// railings (instanced geometry near, coverage cards far) or stone balustrades, planters,
// AC units, flags and dishes. Everything is placed from facadePlan(lot) in the lot's
// facade frame (u along the wall, v up, w out of the wall). Contract: docs/ARCHITECTURE.md.
//
// Level of detail is chosen per INSTANCE (each railing bay, post, console, baluster,
// plant) in update(), from projected sizes, so it follows the FOV:
//   rail   bay tessellation level whose chord error stays under 0.4 px (railings.js TOL),
//          then nothing once bars are thinner than ~0.8 px (the cards carry on)
//   post   finial post / plain post, same range
//   carve  carved consoles, turned balusters, full geraniums / plain stand-ins
// Railing cards are always present: they fade in under the geometry and take over from
// it without holes (see ironwork/mats.js). Far chunks (lod 1) have cards only.

const _l = new THREE.Matrix4(), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _sz = new THREE.Vector2();
const _q = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _c4 = new THREE.Matrix4(), _ap = {};

// Linear albedo palettes for balcony gardening (geranium reds and pinks dominate).
const FLOWERS = [[0.62, 0.012, 0.016], [0.75, 0.03, 0.02], [0.82, 0.16, 0.3], [0.5, 0.02, 0.17], [0.85, 0.2, 0.1], [0.8, 0.78, 0.74]];
const FLOWER_W = [0.3, 0.24, 0.2, 0.12, 0.08, 0.06];
const POTS = [[0.42, 0.16, 0.08], [0.32, 0.11, 0.05], [0.36, 0.14, 0.06], [0.2, 0.1, 0.055], [0.07, 0.11, 0.07], [0.42, 0.41, 0.38]];
const CHAIRS = [[0.75, 0.75, 0.72], [0.07, 0.2, 0.1], [0.5, 0.5, 0.48]];
const LEAFY = [0.09, 0.16, 0.05];
const TOWELS = [[0.8, 0.8, 0.78], [0.62, 0.55, 0.42], [0.12, 0.2, 0.42], [0.55, 0.12, 0.1], [0.3, 0.45, 0.35], [0.75, 0.65, 0.2]];
// All dishes in town aim at the same satellite: a fixed world direction (south-west, 40° up).
const DISH_DIR = new THREE.Vector3(-0.55, 0.64, 0.53).normalize();
// Stone tints are relative to the cream reference, exactly as the buildings tint theirs.
// WARM shifts the dressed-stone albedo toward the mean of the ashlar blocks around it
// (their per-block hue variation leans warm), measured on screen at equal lighting.
const CREAM = [0.86, 0.80, 0.68], WARM = [1.02, 1.0, 0.965];

const weighted = (r, w) => { let x = r.next() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) return i; } return w.length - 1; };

/** Sphere around facade anchors (x, y, z, r, ...) padded for attachments and flags. */
function boundsOf(a) {
  const bx = new THREE.Box3();
  for (let i = 0; i < a.length; i += 4) bx.expandByPoint(_p.set(a[i], a[i + 1], a[i + 2]));
  const sp = bx.getBoundingSphere(new THREE.Sphere());
  let r = 0;
  for (let i = 0; i < a.length; i += 4) r = Math.max(r, sp.center.distanceTo(_p.set(a[i], a[i + 1], a[i + 2])) + a[i + 3]);
  sp.radius = r + 6;
  return sp;
}

/** Per-building ironwork style (deterministic from the lot seed). */
function lotStyle(lot, plan) {
  const r = new RNG(hash2(lot.seed, 0x1f0e));
  const era = plan.style.era;
  const design = era === 'modern' ? r.weighted([[5, 0.6], [2, 0.25], [6, 0.15]])
    : era === 'mandate' ? r.weighted([[2, 0.24], [6, 0.22], [3, 0.18], [0, 0.14], [5, 0.08], [1, 0.14]])
      : r.weighted([[0, 0.26], [1, 0.22], [4, 0.22], [3, 0.16], [6, 0.14]]);
  const paint = r.chance(0.78) ? -1 : weighted(r, PAINT_W);
  const railH = r.range(0.96, 1.07);
  const corbel = era === 'modern' ? -1 : r.chance(0.6) ? 0 : 1;
  const slabVariant = era === 'modern' || (era === 'mandate' && r.chance(0.45)) ? 1 : 0;
  const roundStone = r.chance(0.45);
  const greenery = r.chance(0.1) ? 0 : r.range(0.25, 1);   // how much the residents garden
  const flowers = weighted(r, FLOWER_W);
  const pots = r.int(0, POTS.length - 1);
  const flag = r.int(0, 3);
  const k = r.range(0.95, 1.02);
  const tint = plan.style.tint.map((t, i) => Math.pow(t / CREAM[i], 1.1) * k * WARM[i]);
  return { design, paint, railH, corbel, slabVariant, roundStone, tint, greenery, flowers, pots, flag };
}

// ---------------------------------------------------------------- clearance of openings
// Dressing around an opening's head (surrounds, voussoir rings, keystones, hoods, door
// portals), as the buildings module may draw it, and open shutter leaves folded back
// against the piers either side (facades). Conservative reaches (metres).
function headProfile(o, ground) {
  const door = o.kind === 'door';
  const arched = o.rise > 0.01;
  const reach = ground ? (door ? 0.8 : arched ? 0.62 : 0.34) : 0.4;
  const d0 = o.uc - o.w / 2 - reach, d1 = o.uc + o.w / 2 + reach;
  // open leaves: one leaf width beyond each jamb, up to the crown at their outer edge
  const leaf = o.shutters === 'open' ? [o.uc - o.w - 0.09, o.uc + o.w + 0.09, o.y + o.h + 0.03] : null;
  const hp = {
    u0: leaf ? Math.min(d0, leaf[0]) : d0, u1: leaf ? Math.max(d1, leaf[1]) : d1, d0, d1, leaf,
    flat: o.y + o.h + (ground ? (door ? (arched ? 1.06 : 0.72) : 0.52) : 0.5),
    jamb: o.spring + 0.06, arc: null, door,
  };
  if (arched) {
    const T = ground ? 0.6 : 0.36, a = [];
    for (let i = 0; i <= 20; i++) {
      archPoint(o, i / 20, _ap, T);
      a.push(_ap.u, _ap.v + (Math.abs(_ap.u - o.uc) < 0.22 ? 0.1 : 0)); // keystone
    }
    hp.arc = a;
  }
  return hp;
}

/** Highest point of an opening's dressing at facade position u (−Infinity if clear). */
function headTopAt(hp, u) {
  if (u < hp.u0 || u > hp.u1) return -Infinity;
  const L = hp.leaf;
  const lt = L && u >= L[0] && u <= L[1] ? L[2] : -Infinity;
  if (u < hp.d0 || u > hp.d1) return lt;
  if (hp.door || !hp.arc) return Math.max(lt, hp.flat);
  const a = hp.arc, n = a.length;
  if (u <= a[0]) return Math.max(lt, hp.jamb, a[1]);
  if (u >= a[n - 2]) return Math.max(lt, hp.jamb, a[n - 1]);
  let v = Math.max(lt, hp.jamb);
  for (let i = 0; i < n - 2; i += 2) {
    const ua = a[i], ub = a[i + 2];
    if ((u - ua) * (u - ub) <= 0) v = Math.max(v, a[i + 1] + (a[i + 3] - a[i + 1]) * ((u - ua) / ((ub - ua) || 1)));
  }
  return v;
}

const planHeads = new WeakMap();
/** Head profiles of the openings on each floor of a plan (cached). */
function headsOf(plan) {
  let h = planHeads.get(plan);
  if (!h) {
    h = [];
    for (const o of plan.openings) (h[o.floor] ||= []).push(headProfile(o, o.floor === 0));
    planHeads.set(plan, h);
  }
  return h;
}

/** Console positions for a balcony: n evenly spread consoles, each moved to the nearest
 *  pier where it clears the dressing of the openings below; where no pier is wide
 *  enough it is shortened to stop above the head, or left out. → [{u, h}] */
function placeConsoles(plan, bal, n, Hc) {
  const soffit = bal.y - bal.slabT, len = bal.u1 - bal.u0;
  const W2 = CORBEL.W / 2;
  const lo = bal.u0 + W2 + 0.03, hi = bal.u1 - W2 - 0.03;
  if (hi <= lo) return [];
  const heads = (headsOf(plan)[bal.floor - 1] || []).filter((hp) => hp.u1 > bal.u0 - 0.5 && hp.u0 < bal.u1 + 0.5);
  const step = 0.03, N = Math.floor((hi - lo) / step) + 1;
  const top = new Float32Array(N).fill(-1e9);
  if (heads.length) {
    // dressing height on a grid widened by a console half-width (+2 cm) either side, then
    // the highest point under each console footprint (sliding maximum)
    const K = Math.ceil((W2 + 0.02) / step), M = N + 2 * K;
    const raw = new Float32Array(M);
    for (let j = 0; j < M; j++) {
      const u = lo + (j - K) * step;
      let t = -1e9;
      for (const hp of heads) { const h = headTopAt(hp, u); if (h > t) t = h; }
      raw[j] = t;
    }
    for (let i = 0; i < N; i++) {
      let t = -1e9;
      for (let j = i; j <= i + 2 * K; j++) if (raw[j] > t) t = raw[j];
      top[i] = t;
    }
  }
  const clear = soffit - Hc - 0.075; // knob below the console + 3 cm
  const inset = Math.min(0.32, len * 0.1) + W2;
  const spacing = n > 1 ? (len - 2 * inset) / (n - 1) : len;
  const maxShift = Math.min(0.9, Math.max(0.3, spacing * 0.45));
  const out = [];
  const taken = (u) => out.some((c) => Math.abs(c.u - u) < 0.42);
  for (let k = 0; k < n; k++) {
    const ud = n > 1 ? bal.u0 + inset + spacing * k : (bal.u0 + bal.u1) / 2;
    const id = Math.round((Math.min(hi, Math.max(lo, ud)) - lo) / step);
    let best = -1;
    for (let d = 0; d * step <= maxShift && best < 0; d++) {
      for (const i of d ? [id - d, id + d] : [id]) {
        if (i < 0 || i >= N || top[i] >= clear || taken(lo + i * step)) continue;
        best = i; break;
      }
    }
    if (best >= 0) { out.push({ u: lo + best * step, h: Hc }); continue; }
    // no clear pier nearby: the tallest console that still stops above the head
    let bi = -1;
    for (let d = 0; d * step <= 0.45; d++) {
      for (const i of [id - d, id + d]) {
        if (i < 0 || i >= N || taken(lo + i * step)) continue;
        if (bi < 0 || top[i] < top[bi]) bi = i;
      }
    }
    if (bi < 0) continue;
    const h = soffit - top[bi] - 0.075;
    if (h >= 0.2) out.push({ u: lo + bi * step, h: Math.min(Hc, h) });
  }
  return out;
}

/** Bracket position for a facade flag: the pier nearest the planned spot that is clear
 *  of the windows on that floor (null if none). */
function flagPier(plan, f) {
  const fl = plan.floors.find((x) => f.y >= x.y && f.y < x.y + x.h) || plan.floors[plan.floors.length - 1];
  const cands = [plan.pierL * 0.5, ...plan.bays.slice(1).map((b) => b.u0), plan.width - plan.pierR * 0.5];
  const ops = plan.openings.filter((o) => o.floor === fl.index);
  let best = null;
  for (const u of cands) {
    if (ops.some((o) => Math.abs(u - o.uc) < o.w / 2 + 0.42)) continue;
    if (best === null || Math.abs(u - f.u) < Math.abs(best - f.u)) best = u;
  }
  return best;
}

const ironwork = {
  name: 'ironwork',

  async init(app) {
    this.atlas = buildAtlas();
    this.mats = makeMaterials(app, this.atlas);
    this.stoneMat = makeStoneMaterial(app);
    this.geo = {
      bay: DESIGNS.map((d) => [0, 1, 2].map((lod) => bayGeometry(d, lod))),
      post: [postGeometry(0), postGeometry(1)],
      corbel: [[corbelGeometry(0, 0), corbelGeometry(0, 1)], [corbelGeometry(1, 0), corbelGeometry(1, 1)]],
      baluster: [balusterGeometry(0), balusterGeometry(1)],
    };
    this.att = buildAttachAssets();
    this.amats = makeAttachMaterials(app);
    this.live = new Set();
    this.uniforms = { uIronPx, uIronA2C, uIronCardK }; // for inspection / debugging
    this.lastCam = new THREE.Vector3(1e9, 0, 0);
    this.lastPx = 0;
  },

  build(chunk, app) {
    const { layout } = app;
    const lots = [...layout.inChunk('lots', chunk.index), ...layout.inChunk('sideLots', chunk.index)];
    if (!lots.length) return null;
    const ctx = {
      lod: chunk.lod,       // detail level of the lot being built (may drop below the chunk's)
      chunkLod: chunk.lod,
      inst: new LodInstancer(),
      stone: new GeoWriter(4096, { kind: true }),
      cards: new GeoWriter(),
      parts: new GeoWriter(),
      ac: new GeoWriter(),
      stains: new GeoWriter(256),
      flags: [],
      bounds: [],           // facade centres (x, y, z, r): culling sphere of the merged meshes
    };
    for (const lot of lots) {
      // side-street facades are seen down the side street: skipped in far chunks beyond
      // the corner, built with far-range detail deep in near ones. Beyond the corner lots
      // (35 m and more from any camera on the main street, at grazing angles) the floor
      // clutter behind the railings is left out: it is hidden by the bars and the slab.
      if (chunk.lod && lot.sideStreet && lot.x0 > 24) continue;
      ctx.lod = chunk.lod || (lot.sideStreet && lot.x0 > 60) ? 1 : 0;
      ctx.clutter = !lot.sideStreet || lot.x0 <= 24;
      const plan = facadePlan(lot);
      const st = lotStyle(lot, plan);
      _p.set(lot.frame.width / 2, plan.totalHeight / 2, 0).applyMatrix4(lot.frame.matrix);
      ctx.bounds.push(_p.x, _p.y, _p.z, Math.max(lot.frame.width, plan.totalHeight) / 2);
      plan.balconies.forEach((bal, i) => this.balcony(ctx, lot, plan, st, bal, i));
      this.facadeAttachments(ctx, lot, plan, st);
    }
    return this.finish(ctx);
  },

  /** One balcony: slab, consoles, railing, then what the residents put on it. */
  balcony(ctx, lot, plan, st, bal, index) {
    const { lod, inst } = ctx;
    const F = lot.frame.matrix;
    const r = new RNG(hash2(lot.seed, 977 + index));
    const { y, slabT: T, depth: D, u0, u1 } = bal;
    const isStone = bal.railing === 'stone';
    const tint = st.tint;
    const dirt = r.range(0.88, 1.0);

    const __P = globalThis.__iwP, __t0 = performance.now();
    // ---- slab
    const rc = isStone && st.roundStone ? Math.min(0.3, D * 0.35) : 0;
    ctx.stone.setMatrix(F).color(tint[0], tint[1], tint[2]);
    writeSlab(ctx.stone, slabPath(u0, u1, D, rc), y, T, st.slabVariant, lod, dirt, D);

    const __t1 = performance.now(); if (__P) __P.slab = (__P.slab || 0) + __t1 - __t0;
    // ---- consoles, on the piers between the openings below
    if (st.corbel >= 0) {
      const Hc = THREE.MathUtils.clamp(0.36 + 0.32 * D, 0.5, 0.74);
      const sz = (D - 0.07) / CORBEL.D;
      const c = [tint[0] * dirt, tint[1] * dirt, tint[2] * dirt];
      const __pc = placeConsoles(plan, bal, Math.max(2, bal.corbels | 0), Hc);
      if (__P) __P.place = (__P.place || 0) + performance.now() - __t1;
      for (const { u, h } of __pc) {
        // shortened consoles over a high head become the stepped (tiered) kind
        const variant = h < Hc * 0.8 ? 1 : st.corbel;
        _l.makeScale(1, h / CORBEL.H, sz).setPosition(u, y - T, 0);
        _m.multiplyMatrices(F, _l);
        if (lod) inst.add('corbelFar', [this.geo.corbel[0][1]], this.stoneMat, _m, c, { radius: 1 });
        else inst.add(`corbel${variant}`, this.geo.corbel[variant], this.stoneMat, _m, c, { cls: 'carve', radius: 1 });
      }
    }

    if (__P) __P.cons = (__P.cons || 0) + performance.now() - __t1;
    // ---- railing
    // (the balustrade draws from its own stream so far/near builds place contents alike)
    if (isStone) this.balustrade(ctx, F, bal, rc, tint, new RNG(hash2(lot.seed, 4111 + index)));
    else this.ironRailing(ctx, lot, bal, st);

    this.balconyContents(ctx, lot, plan, st, bal, index, r);
  },

  /** Flower boxes on the railing, pots, a chair, an AC unit, now and then a flag. */
  balconyContents(ctx, lot, plan, st, bal, index, r) {
    const { lod } = ctx;
    const F = lot.frame.matrix, A = this.att;
    const { y, depth: D, u0, u1 } = bal;
    const len = u1 - u0, hs = st.railH;
    const g = st.greenery;
    const potCol = POTS[(st.pots + (r.chance(0.2) ? 1 : 0)) % POTS.length];
    const flower = () => FLOWERS[r.chance(0.7) ? st.flowers : weighted(r, FLOWER_W)];
    const iron = bal.railing !== 'stone';
    const top = y + (iron ? RAIL_H * hs : BALUSTRADE.H);
    // flower boxes hung on the handrail (mostly outside), top 3 cm under the rail top
    if (g > 0 && r.chance(0.45 + 0.45 * g)) {
      const n = len > 3.2 ? r.int(2, 3) : len > 2 ? 2 : 1;
      const outside = !iron || r.chance(0.7);
      const w = iron ? D - 0.05 + (outside ? 0.13 : -0.13) : D - 0.13 + 0.2;
      for (let k = 0; k < n; k++) {
        const u = u0 + len * ((k + 0.5) / n) + r.range(-0.12, 0.12) * len / n;
        _l.makeScale(0.82, 1, 1).setPosition(THREE.MathUtils.clamp(u, u0 + 0.45, u1 - 0.45), top - 0.19, w);
        _m.multiplyMatrices(F, _l);
        this.planter(ctx, _m, potCol, flower());
        if (!lod && iron) writeTemplate(ctx.parts, A.hooks[outside ? 0 : 1], _m);
      }
    }
    if (lod || !ctx.clutter) return;
    // pots along the front, inside the railing
    if (g > 0 && r.chance(0.15 + 0.5 * g)) {
      const n = r.int(1, Math.min(4, Math.floor(len / 0.45)));
      for (let k = 0; k < n; k++) {
        const u = u0 + 0.3 + (len - 0.6) * ((k + r.range(0.3, 0.7)) / n);
        const w = D - r.range(0.25, 0.32);
        const s = r.range(0.8, 1.2);
        _l.makeRotationY(r.range(0, 6.28)).scale(_a.set(s, s, s)).setPosition(u, y, w);
        writeTemplate(ctx.parts, A.pot, _m.multiplyMatrices(F, _l), r.chance(0.7) ? potCol : POTS[r.int(0, POTS.length - 1)]);
        _l.makeRotationY(r.range(0, 6.28)).scale(_a.set(s, s, s)).setPosition(u, y + 0.2 * s, w);
        // not every pot is in bloom: a green tint turns the umbels into more foliage
        this.plant(ctx, 0, _m.multiplyMatrices(F, _l), r.chance(0.75) ? flower() : LEAFY);
      }
    }
    // a plastic chair
    if (r.chance(0.1) && D > 0.75) {
      _l.makeRotationY(r.range(-0.6, 0.6) + (r.chance(0.5) ? 0 : Math.PI)).setPosition(u0 + len * r.range(0.2, 0.8), y, D * 0.5);
      writeTemplate(ctx.parts, A.chair, _m.multiplyMatrices(F, _l), CHAIRS[r.int(0, CHAIRS.length - 1)]);
    }
    // an AC unit standing on the balcony floor beside the door
    const door = plan.openings.find((o) => o.balcony === index);
    if (door && (door.ac || r.chance(0.08)) && len > 1.6) {
      const side = r.chance(0.5) ? -1 : 1;
      const u = THREE.MathUtils.clamp(door.uc + side * (door.w / 2 + 0.5), u0 + 0.5, u1 - 0.5);
      _l.makeTranslation(u, y + 0.06, -0.06);
      this.acUnit(ctx, _m.multiplyMatrices(F, _l), false);
    }
    // a towel or rug airing over the front rail
    if (iron && r.chance(0.04)) {
      _l.makeScale(r.range(0.5, 0.9), 1, 1).setPosition(u0 + len * r.range(0.25, 0.75), top, D - 0.05);
      writeTemplate(ctx.parts, A.towel, _m.multiplyMatrices(F, _l), TOWELS[r.int(0, TOWELS.length - 1)]);
    }
    // a flag on the front corner post
    if (iron && r.chance(0.012)) this.flag(ctx, F, r.chance(0.5) ? u0 + 0.05 : u1 - 0.05, y + 0.85, D - 0.05, st, r, 0.6);
  },

  /** Window AC units, window flower boxes, flags and satellite dishes of one facade. */
  facadeAttachments(ctx, lot, plan, st) {
    const { lod } = ctx;
    const F = lot.frame.matrix, A = this.att;
    const r = new RNG(hash2(lot.seed, 0x5eed));
    for (const o of plan.openings) {
      if (o.kind !== 'window') continue;
      if (o.ac) {
        // under one side of the window, clear of the sill and its corbels; where the unit
        // or its brackets reach a string course it stands off the wall in front of it
        const u = o.uc + (r.chance(0.5) ? -1 : 1) * (o.w / 2 + 0.05) * r.range(0.45, 0.9);
        const top = o.y - 0.37, bot = top - 0.55 - 0.22;
        let w = -0.02;
        for (const c of plan.courses) if (c.y < top && c.y + c.h > bot) w = Math.max(w, c.proj - 0.07);
        _l.makeTranslation(u, top - 0.55, w);
        this.acUnit(ctx, _m.multiplyMatrices(F, _l), true);
      }
      if (o.flowerBox) {
        // standing on the sill, half inside the window reveal
        _l.makeScale(o.w + 0.06, 1, 1).setPosition(o.uc, o.y + 0.012, 0.03);
        this.planter(ctx, _m.multiplyMatrices(F, _l), POTS[st.pots], FLOWERS[st.flowers]);
      }
    }
    for (const f of plan.flags) {
      const u = flagPier(plan, f);
      if (u !== null) this.flag(ctx, F, u, f.y, 0, st, r, 1);
    }
    // satellite dish on the top floor, only where the facade can see the satellite
    if (!lod && r.chance(0.14) && plan.bays.length > 1) {
      _a.copy(lot.frame.nDir);
      if (_a.dot(_b.set(DISH_DIR.x, 0, DISH_DIR.z).normalize()) > 0.25) {
        const fl = plan.floors[plan.floors.length - 1];
        const k = r.int(1, plan.bays.length - 1);
        _p.set(plan.bays[k].u0, fl.y + r.range(1.1, 1.8), 0.42).applyMatrix4(F);
        _l.lookAt(_c.set(0, 0, 0), _q.copy(DISH_DIR).negate(), _b.set(0, 1, 0)).setPosition(_p);
        writeTemplate(ctx.parts, A.dish, _l, [1, 1, 1]);
      }
    }
  },

  /** Planter box (matrix: origin at the box foot, x scaled to its length) with geraniums. */
  planter(ctx, m, potCol, flowerCol) {
    const A = this.att;
    if (ctx.lod) {
      // far: box, foliage mound and flower clumps merged into the parts mesh
      writeTemplate(ctx.parts, A.bloomLow.box, m, potCol);
      writeTemplate(ctx.parts, A.bloomLow.green, m);
      writeTemplate(ctx.parts, A.bloomLow.flowers, m, flowerCol);
      return;
    }
    writeTemplate(ctx.parts, A.box, m, potCol);
    // the plant geometry is 0.8 m long, the box template 1 m: rescale to the box length
    _l.makeScale(1 / 0.8, 1, 1).setPosition(0, 0.16, 0);
    this.plant(ctx, 1, _c4.multiplyMatrices(m, _l), flowerCol);
  },

  /** Instanced geranium (kind 0 pot, 1 planter): full and light versions per instance. */
  plant(ctx, kind, m, tint) {
    const P = this.att.plants;
    ctx.inst.add(`plant${kind}`, [P[0][kind], P[1][kind]], this.amats.plant, m, tint, { cls: 'carve', castShadow: false });
  },

  /** Split AC unit (matrix: unit frame on the wall); textured body near, plain box far. */
  acUnit(ctx, m, wallMounted) {
    const A = this.att;
    if (ctx.lod) { writeTemplate(ctx.parts, A.acBody, m, [0.56, 0.54, 0.49]); return; }
    writeTemplate(ctx.ac, A.acBody, m, wallMounted ? [1, 1, 1] : [0.92, 0.92, 0.92]);
    writeTemplate(ctx.parts, A.acPipes, m);
    if (wallMounted) {
      writeTemplate(ctx.parts, A.acBrackets, m);
      writeTemplate(ctx.stains, A.acStain, m);
    }
  },

  /** Flag on an angled pole: bracket at facade (u, v, w), pole out of the wall and up. */
  flag(ctx, F, u, v, w, st, r, size) {
    const el = THREE.MathUtils.degToRad(r.range(30, 45));
    // pole direction p and fly direction q in facade space (u, v, w), then to world
    const p = _a.set(0, Math.sin(el), Math.cos(el)).transformDirection(F);
    const q = _b.set(0, -Math.cos(el), Math.sin(el)).transformDirection(F);
    const base = _p.set(u, v, w).applyMatrix4(F);
    // pole (template is along +y); a 3 cm pole is sub-pixel in far chunks
    _c.crossVectors(p, q);
    _l.makeBasis(q, p, _c).setPosition(base);
    if (!ctx.lod) writeTemplate(ctx.parts, this.att.pole, _l, [1, 1, 1]);
    // cloth: local x = fly (q), y = along the pole (p), hoist top at 1.85 m up the pole
    const s = size;
    _m.makeBasis(_q.copy(q).multiplyScalar(s), _a.copy(p).multiplyScalar(s), _c.clone().multiplyScalar(s)).setPosition(base.clone().addScaledVector(p, 1.85));
    const d = r.chance(0.45) ? 0 : (st.flag + (r.chance(0.15) ? 1 : 0)) % 4;
    ctx.flags.push({ m: _m.clone(), uv: [(d % 2) * 0.5, (1 - Math.floor(d / 2)) * 0.5], phase: r.range(0, 30) });
  },

  ironRailing(ctx, lot, bal, st) {
    const { lod, inst } = ctx;
    const F = lot.frame.matrix;
    const { y, depth: D, u0, u1 } = bal;
    const design = DESIGNS[st.design];
    const painted = st.paint >= 0;
    const mat = painted ? this.mats.paint : this.mats.iron;
    const color = painted ? PAINTS[st.paint] : null;
    const hs = st.railH;
    const i = 0.05; // railing centre line inset from the slab edge
    const rp = [[u0 + i, 0], [u0 + i, D - i], [u1 - i, D - i], [u1 - i, 0]];
    const cw = ctx.cards.setMatrix(F);
    const cc = painted ? color : this.mats.ironColor();
    cw.color(cc[0], cc[1], cc[2]);
    const vb = atlasV(st.design, 0), vt = atlasV(st.design, RAIL_H);
    const bayKey = `bay${st.design}${painted ? 'p' : ''}`;
    for (let k = 0; k < rp.length - 1; k++) {
      const A = rp[k], B = rp[k + 1];
      const du = B[0] - A[0], dw = B[1] - A[1], len = Math.sqrt(du * du + dw * dw);
      if (len < 0.08) continue;
      const tu = du / len, tw = dw / len;
      const nb = Math.max(1, Math.round(len / design.W)), sx = len / (nb * design.W);
      if (!lod) {
        for (let b = 0; b < nb; b++) {
          const o = b * design.W * sx;
          _l.set(tu * sx, 0, -tw, A[0] + tu * o, 0, hs, 0, y, tw * sx, 0, tu, A[1] + tw * o, 0, 0, 0, 1);
          inst.add(bayKey, this.geo.bay[st.design], mat, _m.multiplyMatrices(F, _l), color, { cls: 'rail', castShadow: false, radius: 0.8 });
        }
      }
      // card for this run (also casts the railing shadow at every distance)
      const nx = -tw, nz = tu, yt = y + RAIL_H * hs;
      const a = cw.v(A[0], y, A[1], nx, 0, nz, 0, vb), b = cw.v(B[0], y, B[1], nx, 0, nz, nb, vb);
      const c = cw.v(B[0], yt, B[1], nx, 0, nz, nb, vt), d = cw.v(A[0], yt, A[1], nx, 0, nz, 0, vt);
      cw.quad(a, b, c, d);
    }
    // corner and wall-end posts: two crossed sprite quads each on the cards, geometry near
    const pv0 = atlasV(ATLAS.POST_ROW, 0), pv1 = atlasV(ATLAS.POST_ROW, RAIL_H + 0.1), ph = ATLAS.POST_W / 2;
    for (const P of rp) {
      for (const [eu, ew] of [[1, 0], [0, 1]]) {
        const yt = y + (RAIL_H + 0.1) * hs;
        const a = cw.v(P[0] - eu * ph, y, P[1] - ew * ph, -ew, 0, eu, 0, pv0), b = cw.v(P[0] + eu * ph, y, P[1] + ew * ph, -ew, 0, eu, 1, pv0);
        const c = cw.v(P[0] + eu * ph, yt, P[1] + ew * ph, -ew, 0, eu, 1, pv1), d = cw.v(P[0] - eu * ph, yt, P[1] - ew * ph, -ew, 0, eu, 0, pv1);
        cw.quad(a, b, c, d);
      }
      if (!lod) {
        _l.makeScale(1, hs, 1).setPosition(P[0], y, P[1]);
        inst.add(`post${painted ? 'p' : ''}`, this.geo.post, mat, _m.multiplyMatrices(F, _l), color, { cls: 'post', castShadow: false, radius: 1.2 });
      }
    }
  },

  balustrade(ctx, F, bal, rc, tint, r) {
    const { lod, inst } = ctx;
    const { y, depth: D, u0, u1 } = bal;
    const i = 0.13;
    const path = slabPath(u0 + i, u1 - i, D - i, Math.max(0, rc - i * 0.5), 0.04);
    const S = ctx.stone;
    S.setMatrix(_m.multiplyMatrices(F, _l.makeTranslation(0, y, 0)));
    S.color(tint[0], tint[1], tint[2]);
    sweepPath(S, path, plinthProfile(), { shadeFn: (o, v) => (v < 0.02 ? 0.8 : 0.95) });
    sweepPath(S, path, copingProfile(lod), { shadeFn: (o, v) => (v < BALUSTRADE.H - BALUSTRADE.COPING + 0.01 ? 0.75 : 1) });
    // pedestals at the wall ends and the front corners
    const hP = BALUSTRADE.H - BALUSTRADE.PLINTH - BALUSTRADE.COPING;
    const ped = [path[0], path[path.length - 1]];
    if (rc <= 0.01) ped.push(path[1], path[2]);
    for (const P of ped) box(S, P[0], BALUSTRADE.PLINTH + hP / 2, P[1], 0.2, hP, 0.2, 0.85, 'ud');
    // far: one darkened panel per run stands in for the row of balusters (at 200 m and
    // beyond they read as a mid-tone band anyway)
    if (lod) {
      S.color(tint[0] * 0.72, tint[1] * 0.72, tint[2] * 0.72);
      const y0 = BALUSTRADE.PLINTH, y1 = BALUSTRADE.H - BALUSTRADE.COPING;
      for (let k = 0; k < path.length - 1; k++) {
        const A = path[k], B = path[k + 1];
        const du = B[0] - A[0], dw = B[1] - A[1], l = Math.sqrt(du * du + dw * dw) || 1;
        const nx = -dw / l, nz = du / l;
        for (const sg of [1, -1]) {
          const a = S.v(A[0], y0, A[1], nx * sg, 0, nz * sg, 0, y0), b = S.v(B[0], y0, B[1], nx * sg, 0, nz * sg, l, y0);
          const c = S.v(B[0], y1, B[1], nx * sg, 0, nz * sg, l, y1), d = S.v(A[0], y1, A[1], nx * sg, 0, nz * sg, 0, y1);
          if (sg > 0) S.quad(a, b, c, d); else S.quad(b, a, d, c);
        }
      }
      return;
    }
    // balusters along the path, kept clear of the pedestals
    const col = [tint[0], tint[1], tint[2]];
    for (let k = 0; k < path.length - 1; k++) {
      const A = path[k], B = path[k + 1];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const n = Math.floor(len / BALUSTRADE.SPACING);
      if (n < 1) continue;
      const step = len / n;
      for (let j = 0; j <= n; j++) {
        const t = (j * step) / len;
        const u = A[0] + (B[0] - A[0]) * t, w = A[1] + (B[1] - A[1]) * t;
        if (ped.some((P) => Math.hypot(P[0] - u, P[1] - w) < 0.17)) continue;
        if (j === n && k < path.length - 2) continue; // shared with the next segment
        _l.makeRotationY(r.range(0, Math.PI)).setPosition(u, y + BALUSTRADE.PLINTH, w);
        inst.add('baluster', this.geo.baluster, this.stoneMat, _m.multiplyMatrices(F, _l), col, { cls: 'carve' });
      }
    }
  },

  finish(ctx) {
    const group = new THREE.Group();
    group.name = 'ironwork';
    const add = (W, mat, name, shadow, colors = true) => {
      if (!W.count) return;
      const mesh = new THREE.Mesh(W.toGeometry({ bounds: false, colors }), mat);
      mesh.castShadow = shadow; mesh.receiveShadow = true;
      mesh.name = `ironwork:${name}`;
      group.add(mesh);
    };
    add(ctx.stone, this.stoneMat, 'stone', true);
    add(ctx.cards, this.mats.card, 'cards', true);
    add(ctx.parts, this.amats.parts, 'parts', !ctx.chunkLod);
    add(ctx.ac, this.amats.ac, 'ac', !ctx.chunkLod);
    add(ctx.stains, this.amats.stain, 'stains', false, false);
    // one conservative sphere for all merged meshes (cheaper than scanning their vertices)
    const sphere = boundsOf(ctx.bounds);
    for (const m of group.children) m.geometry.boundingSphere = sphere.clone();
    if (ctx.flags.length) {
      // per-chunk copy of the cloth grid carrying the per-flag design / phase attribute
      // (copied, not shared: disposing a chunk frees its geometry's GL buffers)
      const src = this.att.flag, geo = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv']) geo.setAttribute(k, src.attributes[k].clone());
      geo.setIndex(src.index.clone());
      const n = ctx.flags.length, fa = new Float32Array(n * 3);
      const mesh = new THREE.InstancedMesh(geo, this.amats.flag, n);
      const fb = new THREE.Box3();
      ctx.flags.forEach((f, i) => {
        mesh.setMatrixAt(i, f.m);
        fa[i * 3] = f.uv[0]; fa[i * 3 + 1] = f.uv[1]; fa[i * 3 + 2] = f.phase;
        fb.expandByPoint(_p.setFromMatrixPosition(f.m));
      });
      geo.setAttribute('aFlag', new THREE.InstancedBufferAttribute(fa, 3));
      // the cloth hangs and moves up to ~1.5 m from the hoist: pad the culling sphere
      mesh.boundingSphere = fb.getBoundingSphere(new THREE.Sphere());
      mesh.boundingSphere.radius += 1.8;
      mesh.customDepthMaterial = this.amats.flagDepth;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = 'ironwork:flags';
      group.add(mesh);
    }
    const sets = ctx.inst.build(group);
    if (!group.children.length) return null;
    Object.assign(group.userData, { sets, fresh: true, lod: ctx.chunkLod });
    this.live.add(group);
    return group;
  },

  dispose(obj) {
    this.live.delete(obj);
    disposeObject(obj);
  },

  /** Distance limits per detail class for the current projection (see header). */
  limits(px) {
    const geo = geoLimit() + 0.5;
    const d1 = (TOL[1] * px) / 0.4, d2 = (TOL[2] * px) / 0.4;
    const carve = (0.03 * px) / 3.0; // 3 cm carving still covers 3 px
    return { rail: [d1, d2, geo], post: [d2, geo], carve: [carve, Infinity] };
  },

  update(dt, app) {
    // projected pixels per metre at 1 m distance
    app.renderer.getDrawingBufferSize(_sz);
    const px = 0.5 * _sz.y * app.camera.projectionMatrix.elements[5];
    uIronPx.value = px;
    const post = app.post;
    uIronA2C.value = post && !post.disabled && post.sceneRT && post.sceneRT.samples > 0 ? 1 : 0;
    const cam = app.camera.position;
    const moved = cam.distanceToSquared(this.lastCam) > 0.04 || Math.abs(px - this.lastPx) > 0.01 * px;
    if (moved) { this.lastCam.copy(cam); this.lastPx = px; }
    const L = this.limits(px);
    for (const g of this.live) {
      const u = g.userData;
      if (!moved && !u.fresh) continue;
      u.fresh = false;
      for (const s of u.sets) if (s.cls) LodInstancer.partition(s, cam, L[s.cls]);
    }
  },
};

export default ironwork;
