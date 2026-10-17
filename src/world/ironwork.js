import * as THREE from 'three';
import { RNG, hash2 } from '../core/rng.js';
import { facadePlan } from './facadePlan.js';
import { disposeObject } from './streaming.js';
import { DESIGNS, RAIL_H } from './ironwork/patterns.js';
import { bayGeometry, postGeometry, buildAtlas, atlasV } from './ironwork/railings.js';
import {
  slabPath, writeSlab, corbelGeometry, corbelPrism, CORBEL, balusterGeometry, plinthProfile, copingProfile, BALUSTRADE,
} from './ironwork/stone.js';
import { GeoWriter, sweepPath, box } from './ironwork/geo.js';
import { Instancer } from './ironwork/instancer.js';
import { makeMaterials, PAINTS, FADE, uIronPx, nearLimit } from './ironwork/mats.js';
import { buildAttachAssets, makeAttachMaterials, writeTemplate } from './ironwork/attach.js';

// Balconies and facade attachments: carved stone slabs on scroll consoles, wrought-iron
// railings (instanced geometry near, alpha-tested cards far) or stone balustrades.
// Everything is placed from facadePlan(lot) in the lot's facade frame (u along the wall,
// v up, w out of the wall). Contract: docs/ARCHITECTURE.md.
//
// Distance handling inside a lod-0 chunk (all switches are per frame in update()):
//   rail0 / rail1  full / lighter railing bays, per lot mesh, by projected bar width
//   rail           posts, per lot mesh, while any railing geometry shows
//   carve0/carve1  carved consoles + turned balusters / plain stand-ins, per chunk
// Railing cards are always drawn; their shader dithers them in exactly where the
// geometry dithers out (see ironwork/mats.js).

const _l = new THREE.Matrix4(), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _sz = new THREE.Vector2();
const _q = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _c4 = new THREE.Matrix4();

// Linear albedo palettes for balcony gardening.
const FLOWERS = [[0.62, 0.012, 0.016], [0.75, 0.03, 0.02], [0.82, 0.16, 0.3], [0.5, 0.02, 0.17], [0.85, 0.2, 0.1], [0.8, 0.78, 0.74]];
const POTS = [[0.42, 0.16, 0.08], [0.32, 0.11, 0.05], [0.36, 0.14, 0.06], [0.18, 0.09, 0.05], [0.06, 0.12, 0.06], [0.55, 0.55, 0.52]];
const CHAIRS = [[0.75, 0.75, 0.72], [0.07, 0.2, 0.1], [0.5, 0.5, 0.48]];
const LEAFY = [0.09, 0.16, 0.05];
// All dishes in town aim at the same satellite: a fixed world direction (south-west, 40° up).
const DISH_DIR = new THREE.Vector3(-0.55, 0.64, 0.53).normalize();

/** Per-building ironwork style (deterministic from the lot seed). */
function lotStyle(lot, plan) {
  const r = new RNG(hash2(lot.seed, 0x1f0e));
  const era = plan.style.era;
  const design = era === 'modern' ? r.weighted([[5, 0.6], [2, 0.25], [6, 0.15]])
    : era === 'mandate' ? r.weighted([[2, 0.24], [6, 0.22], [3, 0.18], [0, 0.14], [5, 0.08], [1, 0.14]])
      : r.weighted([[0, 0.26], [1, 0.22], [4, 0.22], [3, 0.16], [6, 0.14]]);
  return {
    design,
    paint: r.chance(0.8) ? -1 : r.int(0, PAINTS.length - 1),
    railH: r.range(0.96, 1.07),
    corbel: era === 'modern' ? -1 : r.chance(0.6) ? 0 : 1,
    slabVariant: era === 'modern' || (era === 'mandate' && r.chance(0.45)) ? 1 : 0,
    roundStone: r.chance(0.45),
    tint: plan.style.tint,
    greenery: r.chance(0.25) ? 0 : r.range(0.2, 1),   // how much the residents garden
    flowers: r.int(0, FLOWERS.length - 1),
    pots: r.int(0, POTS.length - 1),
    flag: r.int(0, 3),
  };
}

const ironwork = {
  name: 'ironwork',

  async init(app) {
    this.atlas = buildAtlas();
    this.mats = makeMaterials(app, this.atlas);
    this.geo = {
      bay: [DESIGNS.map((d) => bayGeometry(d, 0)), DESIGNS.map((d) => bayGeometry(d, 1))],
      post: postGeometry(0),
      corbel: [[corbelGeometry(0, 0), corbelGeometry(1, 0)], [corbelGeometry(0, 1), corbelGeometry(1, 1)]],
      corbelPrism: [corbelPrism(0), corbelPrism(1)],
      baluster: [balusterGeometry(0), balusterGeometry(1)],
    };
    this.att = buildAttachAssets();
    this.amats = makeAttachMaterials(app);
    this.live = new Set();
    this.syncT = 0;
  },

  build(chunk, app) {
    const t0 = performance.now();
    const out = this.buildChunk(chunk, app);
    (this.buildTimes ||= []).push([chunk.lod, +(performance.now() - t0).toFixed(2)]);
    return out;
  },

  buildChunk(chunk, app) {
    const { layout } = app;
    const lots = [...layout.inChunk('lots', chunk.index), ...layout.inChunk('sideLots', chunk.index)];
    if (!lots.length) return null;
    const ctx = {
      lod: chunk.lod,
      inst: new Instancer(),
      stone: new GeoWriter(),
      cards: new GeoWriter(),
      parts: new GeoWriter(),
      ac: new GeoWriter(),
      flags: [],
      anchors: [],
    };
    for (const lot of lots) {
      // deep side-street facades are invisible from the main street at far range
      if (chunk.lod && lot.sideStreet && lot.x0 > 30) continue;
      const plan = facadePlan(lot);
      const st = lotStyle(lot, plan);
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
    const dirt = r.range(0.86, 1.0);

    // ---- slab
    const rc = isStone && st.roundStone ? Math.min(0.3, D * 0.35) : 0;
    ctx.stone.setMatrix(F).color(tint[0], tint[1], tint[2]);
    writeSlab(ctx.stone, slabPath(u0, u1, D, rc), y, T, st.slabVariant, lod, dirt);

    // ---- consoles (far side-street facades are only ever seen edge-on: skipped)
    if (st.corbel >= 0 && !(lod && lot.sideStreet)) {
      const n = Math.max(2, bal.corbels | 0), len = u1 - u0;
      const inset = Math.min(0.32, len * 0.1) + CORBEL.W / 2;
      const Hc = THREE.MathUtils.clamp(0.36 + 0.32 * D, 0.5, 0.74);
      const sy = Hc / CORBEL.H, sz = (D - 0.07) / CORBEL.D;
      const c = [tint[0] * dirt, tint[1] * dirt, tint[2] * dirt];
      for (let i = 0; i < n; i++) {
        const u = u0 + inset + ((len - 2 * inset) * i) / (n - 1);
        _l.makeScale(1, sy, sz).setPosition(u, y - T, 0);
        _m.multiplyMatrices(F, _l);
        if (lod) {
          // far chunks: a plain prism written into the merged stone mesh (no extra draw)
          ctx.stone.setMatrix(_m).color(c[0], c[1], c[2]);
          this.geo.corbelPrism[st.corbel](ctx.stone);
        } else {
          inst.add(`corbel${st.corbel}`, this.geo.corbel[0][st.corbel], this.mats.stone, _m, c,
            { tag: 'carve0', alt: { geometry: this.geo.corbel[1][st.corbel], tag: 'carve1' } });
        }
      }
    }

    // ---- railing
    if (isStone) this.balustrade(ctx, F, bal, rc, tint, r);
    else this.ironRailing(ctx, lot, bal, st);

    this.balconyContents(ctx, lot, plan, st, bal, index, r);

    _p.set((u0 + u1) / 2, y + 0.5, D / 2).applyMatrix4(F);
    ctx.anchors.push(_p.x, _p.y, _p.z, (u1 - u0) / 2 + 1);
  },

  /** Flower boxes on the railing, pots, a chair, an AC unit, now and then a flag. */
  balconyContents(ctx, lot, plan, st, bal, index, r) {
    const { lod, inst } = ctx;
    const F = lot.frame.matrix, A = this.att;
    const { y, depth: D, u0, u1 } = bal;
    const len = u1 - u0, hs = st.railH;
    const g = st.greenery;
    const potCol = POTS[(st.pots + (r.chance(0.2) ? 1 : 0)) % POTS.length];
    const flower = () => FLOWERS[r.chance(0.75) ? st.flowers : r.int(0, FLOWERS.length - 1)];
    const iron = bal.railing !== 'stone';
    const top = y + (iron ? RAIL_H * hs : BALUSTRADE.H);
    // flower boxes hung on the front rail (mostly outside), visible from afar
    if (g > 0 && r.chance(0.2 + 0.55 * g)) {
      const n = len > 2.2 && r.chance(0.5) ? 2 : 1;
      const outside = iron && r.chance(0.65);
      const w = D - (iron ? 0.05 : 0.13) + (outside ? 0.13 : -0.13);
      for (let k = 0; k < n; k++) {
        const u = n === 1 ? u0 + len * r.range(0.35, 0.65) : u0 + len * (k ? 0.72 : 0.28);
        _l.makeScale(0.82, 1, 1).setPosition(u, top - 0.17, w);
        this.planter(ctx, _m.multiplyMatrices(F, _l), potCol, flower());
      }
    }
    if (lod) return;
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
        this.plant(ctx, 0, _m.multiplyMatrices(F, _l), r.chance(0.72) ? flower() : LEAFY);
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
    // a flag on the front corner post
    if (iron && r.chance(0.012)) this.flag(ctx, F, r.chance(0.5) ? u0 + 0.05 : u1 - 0.05, y + 0.85, D - 0.05, st, r, 0.6);
  },

  /** Window AC units, window flower boxes, flags and satellite dishes of one facade. */
  facadeAttachments(ctx, lot, plan, st) {
    const { lod, inst } = ctx;
    const F = lot.frame.matrix, A = this.att;
    const r = new RNG(hash2(lot.seed, 0x5eed));
    for (const o of plan.openings) {
      if (o.kind !== 'window') continue;
      if (o.ac) {
        // under one side of the window, clear of the sill and its brackets
        const u = o.uc + (r.chance(0.5) ? -1 : 1) * (o.w / 2 + 0.05) * r.range(0.45, 0.9);
        _l.makeTranslation(u, o.y - 0.32 - 0.55, -0.02);
        this.acUnit(ctx, _m.multiplyMatrices(F, _l), true);
      }
      if (o.flowerBox) {
        // standing on the sill, half inside the window reveal
        _l.makeScale(o.w + 0.06, 1, 1).setPosition(o.uc, o.y + 0.012, 0.03);
        this.planter(ctx, _m.multiplyMatrices(F, _l), POTS[st.pots], FLOWERS[st.flowers]);
      }
    }
    for (const f of plan.flags) this.flag(ctx, F, f.u, f.y, 0, st, r, 1);
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
      // far: box, green mound and flower patches merged into the parts mesh
      writeTemplate(ctx.parts, A.box, m, potCol);
      writeTemplate(ctx.parts, A.bloomLow.green, m);
      writeTemplate(ctx.parts, A.bloomLow.flowers, m, flowerCol);
      return;
    }
    writeTemplate(ctx.parts, A.box, m, potCol);
    // the plant geometry is 0.8 m long, the box template 1 m: rescale to the box length
    _l.makeScale(1 / 0.8, 1, 1).setPosition(0, 0.16, 0);
    this.plant(ctx, 1, _c4.multiplyMatrices(m, _l), flowerCol);
  },

  /** Instanced geranium (kind 0 pot, 1 planter): full and light versions share instances. */
  plant(ctx, kind, m, tint) {
    const P = this.att.plants;
    ctx.inst.add(`plant${kind}`, P[0][kind], this.amats.plant, m, tint,
      { castShadow: false, tag: 'carve0', alt: { geometry: P[1][kind], tag: 'carve1' } });
  },

  /** Split AC unit (matrix: unit frame on the wall); textured body near, plain box far. */
  acUnit(ctx, m, wallMounted) {
    const A = this.att;
    if (ctx.lod) { writeTemplate(ctx.parts, A.acBody, m, [0.62, 0.61, 0.58]); return; }
    writeTemplate(ctx.ac, A.acBody, m);
    writeTemplate(ctx.parts, A.acPipes, m);
    if (wallMounted) writeTemplate(ctx.parts, A.acBrackets, m);
  },

  /** Flag on an angled pole: bracket at facade (u, v, w), pole out of the wall and up. */
  flag(ctx, F, u, v, w, st, r, size) {
    const el = THREE.MathUtils.degToRad(r.range(30, 45));
    // pole direction p and fly direction q in facade space (u, v, w), then to world
    const p = _a.set(0, Math.sin(el), Math.cos(el)).transformDirection(F);
    const q = _b.set(0, -Math.cos(el), Math.sin(el)).transformDirection(F);
    const base = _p.set(u, v, w).applyMatrix4(F);
    // pole (template is along +y)
    _c.crossVectors(p, q);
    _l.makeBasis(q, p, _c).setPosition(base);
    writeTemplate(ctx.parts, this.att.pole, _l, [1, 1, 1]);
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
    const key = `${st.design}${painted ? 'p' : ''}:${lot.id}`; // near meshes are per lot
    const hs = st.railH;
    const i = 0.05; // railing centre line inset from the slab edge
    const rp = [[u0 + i, 0], [u0 + i, D - i], [u1 - i, D - i], [u1 - i, 0]];
    const cw = ctx.cards.setMatrix(F);
    const cc = painted ? color : this.mats.ironColor();
    cw.color(cc[0], cc[1], cc[2]);
    const vb = atlasV(st.design, 0), vt = atlasV(st.design, RAIL_H);
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
          _m.multiplyMatrices(F, _l);
          inst.add(`bay:${key}`, this.geo.bay[0][st.design], mat, _m, color,
            { tag: 'rail0', castShadow: false, alt: { geometry: this.geo.bay[1][st.design], tag: 'rail1' } });
        }
      }
      // card for this run (also casts the railing shadow at every distance)
      const nx = -tw, nz = tu, yt = y + RAIL_H * hs;
      const a = cw.v(A[0], y, A[1], nx, 0, nz, 0, vb), b = cw.v(B[0], y, B[1], nx, 0, nz, nb, vb);
      const c = cw.v(B[0], yt, B[1], nx, 0, nz, nb, vt), d = cw.v(A[0], yt, A[1], nx, 0, nz, 0, vt);
      cw.quad(a, b, c, d);
    }
    if (!lod) {
      for (const P of rp) {
        _l.makeScale(1, hs, 1).setPosition(P[0], y, P[1]);
        inst.add(`post:${key}`, this.geo.post, mat, _m.multiplyMatrices(F, _l), color, { tag: 'rail', castShadow: false });
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
    for (const P of ped) box(S, P[0], BALUSTRADE.PLINTH + hP / 2, P[1], 0.2, hP, 0.2, 0.85);
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
        _m.multiplyMatrices(F, _l);
        if (lod) inst.add('baluster', this.geo.baluster[1], this.mats.stone, _m, col);
        else inst.add('baluster', this.geo.baluster[0], this.mats.stone, _m, col, { tag: 'carve0', alt: { geometry: this.geo.baluster[1], tag: 'carve1' } });
      }
    }
  },

  finish(ctx) {
    const group = new THREE.Group();
    group.name = 'ironwork';
    const tags = { rail0: [], rail1: [], rail: [], carve0: [], carve1: [] };
    if (ctx.stone.count) {
      const mesh = new THREE.Mesh(ctx.stone.toGeometry(), this.mats.stone);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = 'ironwork:stone';
      group.add(mesh);
    }
    if (ctx.cards.count) {
      const mesh = new THREE.Mesh(ctx.cards.toGeometry(), this.mats.card);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = 'ironwork:cards';
      group.add(mesh);
    }
    for (const [w, mat, name] of [[ctx.parts, this.amats.parts, 'parts'], [ctx.ac, this.amats.ac, 'ac']]) {
      if (!w.count) continue;
      const mesh = new THREE.Mesh(w.toGeometry(), mat);
      mesh.castShadow = !ctx.lod; mesh.receiveShadow = true;
      mesh.name = `ironwork:${name}`;
      group.add(mesh);
    }
    if (ctx.flags.length) {
      // per-chunk copy of the cloth grid carrying the per-flag design / phase attribute
      const src = this.att.flag, geo = new THREE.BufferGeometry();
      for (const k of ['position', 'normal', 'uv']) geo.setAttribute(k, src.attributes[k].clone());
      geo.setIndex(src.index.clone());
      const n = ctx.flags.length, fa = new Float32Array(n * 3);
      const mesh = new THREE.InstancedMesh(geo, this.amats.flag, n);
      ctx.flags.forEach((f, i) => { mesh.setMatrixAt(i, f.m); fa[i * 3] = f.uv[0]; fa[i * 3 + 1] = f.uv[1]; fa[i * 3 + 2] = f.phase; });
      geo.setAttribute('aFlag', new THREE.InstancedBufferAttribute(fa, 3));
      mesh.customDepthMaterial = this.amats.flagDepth;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false; // cloth moves outside the static bounds
      mesh.name = 'ironwork:flags';
      group.add(mesh);
    }
    for (const m of ctx.inst.build(group)) tags[m.userData.tag]?.push(m);
    if (!group.children.length) return null;
    Object.assign(group.userData, tags, { anchors: new Float32Array(ctx.anchors), lod: ctx.lod });
    this.live.add(group);
    return group;
  },

  dispose(obj) {
    this.live.delete(obj);
    disposeObject(obj);
  },

  update(dt, app) {
    // projected pixels per metre at 1 m distance
    app.renderer.getDrawingBufferSize(_sz);
    const px = 0.5 * _sz.y * app.camera.projectionMatrix.elements[5];
    uIronPx.value = px;
    const limRail = nearLimit() + 1;            // bars still above the card threshold
    const limFull = (FADE.BAR * px) / 5.0;      // bars wider than 5 px: full scroll detail
    const limCarve = (0.03 * px) / 3.0;         // 3 cm carving still covers 3 px
    const cam = app.camera.position;
    for (const g of this.live) {
      const u = g.userData;
      for (const m of u.rail) m.visible = m.boundingSphere.center.distanceTo(cam) - m.boundingSphere.radius < limRail;
      for (const m of u.rail0) m.visible = m.boundingSphere.center.distanceTo(cam) - m.boundingSphere.radius < limFull;
      for (const m of u.rail1) {
        const d = m.boundingSphere.center.distanceTo(cam) - m.boundingSphere.radius;
        m.visible = d >= limFull && d < limRail;
      }
      if (!u.carve0.length) continue;
      const a = u.anchors;
      let near = false;
      for (let i = 0; i < a.length && !near; i += 4) {
        const dx = a[i] - cam.x, dy = a[i + 1] - cam.y, dz = a[i + 2] - cam.z;
        near = Math.sqrt(dx * dx + dy * dy + dz * dz) - a[i + 3] < limCarve;
      }
      for (const m of u.carve0) m.visible = near;
      for (const m of u.carve1) m.visible = !near;
    }
    this.syncT -= app.realDt || 0;
    if (this.syncT <= 0) { this.syncT = 2; this.mats.sync(); }
  },
};

export default ironwork;
