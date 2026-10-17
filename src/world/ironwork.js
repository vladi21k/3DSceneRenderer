import * as THREE from 'three';
import { RNG, hash2 } from '../core/rng.js';
import { facadePlan } from './facadePlan.js';
import { disposeObject } from './streaming.js';
import { DESIGNS, RAIL_H } from './ironwork/patterns.js';
import { bayGeometry, postGeometry, buildAtlas, atlasV } from './ironwork/railings.js';
import { slabPath, writeSlab, corbelGeometry, CORBEL, balusterGeometry, plinthProfile, copingProfile, BALUSTRADE } from './ironwork/stone.js';
import { GeoWriter, sweepPath, box } from './ironwork/geo.js';
import { Instancer } from './ironwork/instancer.js';
import { makeMaterials, PAINTS, uIronPx, nearLimit } from './ironwork/mats.js';

// Balconies and facade attachments: carved stone slabs on scroll consoles, wrought-iron
// railings (instanced geometry near, alpha-tested cards far) or stone balustrades.
// Everything is placed from facadePlan(lot) in the lot's facade frame (u along the wall,
// v up, w out of the wall). Contract: docs/ARCHITECTURE.md.

const _l = new THREE.Matrix4(), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _sz = new THREE.Vector2();

/** Per-building ironwork style (deterministic from the lot seed). */
function lotStyle(lot, plan) {
  const r = new RNG(hash2(lot.seed, 0x1f0e));
  const era = plan.style.era;
  const design = era === 'modern' ? r.weighted([[5, 0.65], [2, 0.35]])
    : era === 'mandate' ? r.weighted([[2, 0.32], [3, 0.24], [0, 0.18], [5, 0.12], [1, 0.14]])
      : r.weighted([[0, 0.28], [1, 0.24], [4, 0.26], [3, 0.22]]);
  return {
    design,
    paint: r.chance(0.8) ? -1 : r.int(0, PAINTS.length - 1),
    railH: r.range(0.96, 1.07),
    corbel: era === 'modern' ? -1 : r.chance(0.6) ? 0 : 1,
    slabVariant: era === 'modern' || (era === 'mandate' && r.chance(0.45)) ? 1 : 0,
    roundStone: r.chance(0.45),
    tint: plan.style.tint,
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
      baluster: [balusterGeometry(0), balusterGeometry(1)],
    };
    this.live = new Set();
    this.syncT = 0;
  },

  build(chunk, app) {
    const { layout } = app;
    const lots = [...layout.inChunk('lots', chunk.index), ...layout.inChunk('sideLots', chunk.index)];
    if (!lots.length) return null;
    const ctx = {
      lod: chunk.lod,
      inst: new Instancer(),
      stone: new GeoWriter(),
      cards: [new GeoWriter(), new GeoWriter()], // black iron, painted iron
      anchors: [],
    };
    for (const lot of lots) {
      const plan = facadePlan(lot);
      if (!plan.balconies.length) continue;
      const st = lotStyle(lot, plan);
      plan.balconies.forEach((bal, i) => this.balcony(ctx, lot, plan, st, bal, i));
    }
    return this.finish(ctx);
  },

  /** One balcony: slab, consoles, railing. */
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

    // ---- consoles
    if (st.corbel >= 0) {
      const n = Math.max(2, bal.corbels | 0), len = u1 - u0;
      const inset = Math.min(0.32, len * 0.1) + CORBEL.W / 2;
      const Hc = THREE.MathUtils.clamp(0.36 + 0.32 * D, 0.5, 0.74);
      const sy = Hc / CORBEL.H, sz = (D - 0.07) / CORBEL.D;
      const c = [tint[0] * dirt, tint[1] * dirt, tint[2] * dirt];
      for (let i = 0; i < n; i++) {
        const u = u0 + inset + ((len - 2 * inset) * i) / (n - 1);
        _l.makeScale(1, sy, sz).setPosition(u, y - T, 0);
        _m.multiplyMatrices(F, _l);
        // lod 0 chunks carry the carved console and its plain stand-in, switched by distance
        if (!lod) inst.add(`corbelD${st.corbel}`, this.geo.corbel[0][st.corbel], this.mats.stone, _m, c, { tag: 'corbelNear' });
        inst.add(`corbelS${st.corbel}`, this.geo.corbel[1][st.corbel], this.mats.stone, _m, c, { tag: lod ? 'all' : 'corbelFar' });
      }
    }

    // ---- railing
    if (isStone) this.balustrade(ctx, F, bal, rc, tint, r);
    else this.ironRailing(ctx, lot, bal, st);

    _p.set((u0 + u1) / 2, y + 0.5, D / 2).applyMatrix4(F);
    ctx.anchors.push(_p.x, _p.y, _p.z, (u1 - u0) / 2 + 1);
  },

  ironRailing(ctx, lot, bal, st) {
    const { lod, inst } = ctx;
    const F = lot.frame.matrix;
    const { y, depth: D, u0, u1 } = bal;
    const design = DESIGNS[st.design];
    const geo = this.geo.bay[lod ? 1 : 0][st.design];
    const painted = st.paint >= 0;
    const mat = painted ? this.mats.paint : this.mats.iron;
    const color = painted ? PAINTS[st.paint] : null;
    const key = `${st.design}${painted ? 'p' : ''}:${lot.id}`; // near meshes are per lot (fine visibility)
    const hs = st.railH;
    const i = 0.05; // railing centre line inset from the slab edge
    const rp = [[u0 + i, 0], [u0 + i, D - i], [u1 - i, D - i], [u1 - i, 0]];
    const cw = ctx.cards[painted ? 1 : 0];
    cw.setMatrix(F);
    const cc = painted ? color : this.mats.ironColor();
    cw.color(cc[0], cc[1], cc[2]);
    const vb = atlasV(st.design, 0), vt = atlasV(st.design, RAIL_H);
    for (let k = 0; k < rp.length - 1; k++) {
      const A = rp[k], B = rp[k + 1];
      const du = B[0] - A[0], dw = B[1] - A[1], len = Math.hypot(du, dw);
      if (len < 0.08) continue;
      const tu = du / len, tw = dw / len;
      const nb = Math.max(1, Math.round(len / design.W)), sx = len / (nb * design.W);
      if (!lod) {
        for (let b = 0; b < nb; b++) {
          const o = b * design.W * sx;
          _l.set(tu * sx, 0, -tw, A[0] + tu * o, 0, hs, 0, y, tw * sx, 0, tu, A[1] + tw * o, 0, 0, 0, 1);
          inst.add(`bay${key}`, geo, mat, _m.multiplyMatrices(F, _l), color, { tag: 'near', castShadow: false });
        }
      }
      // far card for this run
      const nx = -tw, nz = tu, yt = y + RAIL_H * hs;
      const a = cw.v(A[0], y, A[1], nx, 0, nz, 0, vb), b = cw.v(B[0], y, B[1], nx, 0, nz, nb, vb);
      const c = cw.v(B[0], yt, B[1], nx, 0, nz, nb, vt), d = cw.v(A[0], yt, A[1], nx, 0, nz, 0, vt);
      cw.quad(a, b, c, d);
    }
    if (!lod) {
      for (const P of rp) {
        _l.makeScale(1, hs, 1).setPosition(P[0], y, P[1]);
        inst.add(`post${key}`, this.geo.post, mat, _m.multiplyMatrices(F, _l), color, { tag: 'near', castShadow: false });
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
    const geo = this.geo.baluster[lod ? 1 : 0];
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
        inst.add('baluster', geo, this.mats.stone, _m.multiplyMatrices(F, _l), col);
      }
    }
  },

  finish(ctx) {
    const group = new THREE.Group();
    group.name = 'ironwork';
    const near = [], corbelNear = [], corbelFar = [], cards = [];
    if (ctx.stone.count) {
      const g = ctx.stone.toGeometry();
      const mesh = new THREE.Mesh(g, this.mats.stone);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = 'ironwork:stone';
      group.add(mesh);
    }
    ctx.cards.forEach((w, i) => {
      if (!w.count) return;
      const mesh = new THREE.Mesh(w.toGeometry(), i ? this.mats.paintCard : this.mats.ironCard);
      // cards cast the railing shadows at every distance (alpha-tested depth); the
      // instanced near geometry does not, which halves its cost
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = 'ironwork:cards';
      group.add(mesh);
      cards.push(mesh);
    });
    for (const m of ctx.inst.build(group)) {
      const tag = m.userData.tag;
      if (tag === 'near') near.push(m);
      else if (tag === 'corbelNear') corbelNear.push(m);
      else if (tag === 'corbelFar') corbelFar.push(m);
    }
    if (!group.children.length) return null;
    group.userData.anchors = new Float32Array(ctx.anchors);
    group.userData.near = near;
    group.userData.corbelNear = corbelNear;
    group.userData.corbelFar = corbelFar;
    group.userData.cards = cards;
    group.userData.lod = ctx.lod;
    this.live.add(group);
    return group;
  },

  dispose(obj) {
    this.live.delete(obj);
    disposeObject(obj);
  },

  update(dt, app) {
    // projected pixels per metre at 1 m: drives the geometry <-> card cross-fade
    app.renderer.getDrawingBufferSize(_sz);
    uIronPx.value = 0.5 * _sz.y * app.camera.projectionMatrix.elements[5];
    // railing geometry only where bars are wider than the card threshold (per lot mesh);
    // carved consoles while a 3 cm detail still covers ~1.5 px (per chunk)
    const limRail = nearLimit() + 1;
    const limCorbel = (0.03 * uIronPx.value) / 1.5;
    const cam = app.camera.position;
    for (const g of this.live) {
      for (const m of g.userData.near) {
        const bs = m.boundingSphere;
        m.visible = bs.center.distanceTo(cam) - bs.radius < limRail;
      }
      if (!g.userData.corbelNear.length) continue;
      const a = g.userData.anchors;
      let near = false;
      for (let i = 0; i < a.length && !near; i += 4) {
        const dx = a[i] - cam.x, dy = a[i + 1] - cam.y, dz = a[i + 2] - cam.z;
        near = Math.sqrt(dx * dx + dy * dy + dz * dz) - a[i + 3] < limCorbel;
      }
      for (const m of g.userData.corbelNear) m.visible = near;
      for (const m of g.userData.corbelFar) m.visible = !near;
    }
    this.syncT -= app.realDt || 0;
    if (this.syncT <= 0) { this.syncT = 2; this.mats.sync(); }
  },
};

export default ironwork;
