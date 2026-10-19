import { RNG } from '../../core/rng.js';
import { facadePlan, ornament } from '../facadePlan.js';
import { FaceShade, stoneStyle, trimColor, noise2, hash3 } from './shade.js';
import { insetPolygon, FACES } from './mesh.js';
import { wallField } from './wall.js';
import { openingMasonry, surroundOf, flatHead, coverOf } from './openings.js';
import { JointFitter } from './coursing.js';
import { courseProfile, plinthProfile, corniceProfile, dentils, modillions, quoins, pilaster } from './mouldings.js';
import { parapetProfile, balustrade, merlons, pitchedRoof, solarHeater, heaterRadius, sunYaw, waterTank, acUnit, antenna, headHouse, satelliteDish } from './roof.js';
import { upperVolume, upperFootprint } from './upper.js';
import { partyWalls } from './party.js';
import { rusticBlocks } from './rustic.js';

// Masonry shell of one building lot, generated from its facade plan:
// wall fields with real openings, reveals and dark closed interiors, arches with
// voussoirs and keystones, surrounds, sills, string courses, cornice (dentils,
// modillions), parapet or tiled hip roof, plinth following the slope, steps,
// rustication (with proud rock-faced blocks at its arrises, rustic.js), quoins,
// pilasters, corner returns, party walls where neighbours step,
// rooftop equipment. Reveals of walled jambs continue the facade's coursing round the
// arris; a rendered block (plan.style.finish) has its walls above the shop floor in a
// colour wash with the dressing in stone. Output: one compact vertex/index set per
// material key.

/**
 * Detail levels: 0 near (< 200 m), 1 far (200–680 m). The default view is a 17° telephoto,
 * where 200 m is ~5.5 cm per pixel, so the far level keeps every moulding profile, hood,
 * keystone and the baked occlusion rows (no popping at the switch) and only drops what
 * is sub-pixel there: bevels, voussoir joints, dentil and baluster geometry (replaced by
 * shaded bands), V joints, steps, reveal interiors, the fitting of the ashlar head
 * joints to the openings (6 mm joints are far below a pixel there), and the sides of
 * the dressing (flat: surrounds, rings, sills and quoins are their front faces). Arched
 * heads take the facade infill's own segment count there (archSegments). The stone's
 * soft patches and the run-off below sills and balconies are shaded per pixel at both
 * levels.
 */
export const DETAIL = {
  0: { lod: 0, archSeg: 14, voussoirs: true, bevel: true, interior: true, dentils: true, modillions: true, balusters: true, rustic: true, steps: true, fit: true, flat: false, gridU: 1.6, gridV: 0.9, rooftop: true },
  1: { lod: 1, archSeg: 10, voussoirs: false, bevel: false, interior: false, dentils: false, modillions: false, balusters: false, rustic: false, steps: false, fit: false, flat: true, gridU: 2.0, gridV: 2.4, rooftop: true },
};

function ashlarUV(plan, meta, rng) {
  const ch = plan.coursing.ch;                         // a storey holds whole courses (facadePlan)
  const mCH = meta && (meta.courseH ?? meta.rowH ?? meta.layout?.rowH);
  const mBL = meta && (meta.blockL ?? meta.blockLength);
  const sv = mCH ? mCH / ch : 1;
  const su = mBL ? mBL / plan.style.blockL : sv;
  const g = plan.coursing.v0;
  // bed joints on the window sill lines, plus a random whole number of texture courses so
  // neighbouring buildings do not show the same blocks
  const shift = mCH ? mCH * rng.int(0, (meta.courses || 12) - 1) : 0;
  return [su, rng.range(0, 40), sv, -g * sv + shift];
}

/** Generate the whole shell of `lot` into Builder B in one go (see lotSteps). */
export function generateLot(B, lot, ends, q, metas) {
  const it = lotSteps(B, lot, ends, q, metas);
  while (!it.next().done);
}

/**
 * Generate the shell of `lot` into Builder B, yielding between pieces of roughly
 * 0.2–0.5 ms so the caller can spread one lot over several frames. ends[e]
 * (e = 0 → u = 0 end, 1 → u = W end): {corner, nb, dw, nbTop, nbDepth} in this
 * lot's facade frame. Builder state (frame, shading, UV transform) is re-established
 * after every yield, so other work may not touch B in between.
 */
export function* lotSteps(B, lot, ends, q, metas) {
  const plan = facadePlan(lot);
  const f = lot.frame, W = plan.width, D = plan.depth;
  const rng = RNG.from(lot.seed, 'shell');
  const orn = ornament(plan, rng);           // the same draws as plan.relief; the stream continues
  // a rendered block (plan.style.finish, see facadePlan finish()): stone dressing and shop
  // floor in the plan's stone tint, the wall above in its colour wash
  const rend = plan.style.finish === 'render' ? plan.style.render : null;
  const { tint, uncleaned } = stoneStyle(rend ? { style: { tint: plan.style.stone } } : plan, rng);
  const rcol = rend ? rend.color : null;
  const sillExt = (plan.style.surrounds ? orn.sw : 0.06) + 0.07;   // sill overhang beyond the jambs
  const uvA = ashlarUV(plan, metas.ashlar, rng);
  const rustH = metas.rough && (metas.rough.courseH ?? metas.rough.rowH ?? metas.rough.layout?.rowH);
  B.begin();
  const sinks = {
    // smooth: trim that casts shadows in every cascade (reveals, mouldings, parapets);
    // detail: the dressing, a thin shadow caster (its relief is a few centimetres)
    ashlar: B.sink('ashlar'), smooth: B.sink('smooth'), detail: B.sink('smoothD'), rough: B.sink('rough'),
    // dark: the boxes behind the openings and the backstops. They cast: the shell is
    // hollow and its walls only cast from their sides facing away from the sun, so these
    // are what keep low sun from shining through the openings
    dark: B.sink('plaster'), paint: B.sink('plaster'), tile: B.sink('tile'),
    // rooftop metalwork (small and far above the street: painted) in the plaster
    // material without shadows, which would only fall on the roofs
    metal: B.sink('dark'),
  };
  const cor = plan.cornice, par = plan.parapet;
  const vTop = cor.y + 0.06;
  // lowest paving around the building (corner returns follow the side street)
  const gMin = Math.min(plan.ground0, plan.ground1, ...(plan.returns || []).map((r) => Math.min(r.ground0, r.ground1)));
  const flatRoof = plan.roof.type !== 'tile';
  const bev = q.bevel ? 0.012 : 0;

  // ------------------------------------------------------------- end exposure
  // Each end of the front turns back along `dir` (u, w): straight back (−w) for party
  // walls, along the real side-street line for corner returns (plan.returns[].dir),
  // `len` metres to the back corner. The footprint is the quad front + the two back corners.
  const E = ends.map((e, k) => {
    const front = e.nb ? Math.max(0, -e.dw) : 0;
    const ret = e.corner ? (plan.returns || []).find((r) => r.end === k && !r.isCut) : null;
    const cut = e.corner ? (plan.cuts || []).find((c) => c.end === k) || null : null;
    const P = [k ? W : 0, 0];
    const dir = ret ? ret.dir : [0, -1], len = ret ? (ret.cut || 0) + ret.width : D;
    return { ...e, front, nbBack: e.nb ? e.dw - e.nbDepth : 0, ret, cut, P, dir, len, back: [P[0] + dir[0] * len, dir[1] * len] };
  });
  /** Point `r` metres back from the front corner at end e (along that end's wall). */
  const pt = (e, r) => [E[e].P[0] + E[e].dir[0] * r, E[e].dir[1] * r];
  /** u of end x's wall at depth w (< 0). */
  const endU = (x, w) => x.P[0] + x.dir[0] * (w / Math.min(-0.2, x.dir[1]));
  /** The street corner at end e as path points (two where the corner is chamfered). */
  const cornerPts = (e) => (E[e].cut ? [E[e].cut.S, E[e].cut.T] : [[e ? W : 0, 0]]);
  const foot = [...cornerPts(0), ...cornerPts(1), E[1].back, E[0].back];   // clockwise in (u, w): faces up
  // the main front's extent between chamfers
  const uMin = E[0].cut ? E[0].cut.c : 0, uMax = E[1].cut ? W - E[1].cut.c : W;
  const minRet = (e) => (E[e].cut ? E[e].cut.cr + 0.01 : 0.01);
  // The cornice of a block standing well clear of its neighbour (or of none) often runs
  // on along the exposed side to the back corner: the side was built to be seen, and the
  // long lens sees it end-on down the street (vBot: the cornice's foot).
  const wrapRng = RNG.from(lot.seed, 'cornWrap');
  const wrapOK = [0, 1].map(() => wrapRng.chance(0.65));
  const wrapsSide = (e, vBot) => {
    const x = E[e];
    if (x.corner || x.cut || !wrapOK[e]) return false;
    return !x.nb || (x.nbClear != null && vBot > x.nbClear && x.front < 0.5);
  };
  /** Return length of a moulding whose top is at vTopM around end e (0 = none); wrap: may run on to the back corner. */
  const retLen = (e, vTopM, proj, wrap = null) => {
    const x = E[e];
    if (x.corner) return x.len;
    if (wrap !== null && wrapsSide(e, wrap)) return D;
    if (!x.nb) return proj + 0.12;
    // a return shorter than the projection would fold the mitre over; the excess
    // disappears inside the set-back neighbour
    if (x.front > 0.03) return Math.max(x.front, proj + 0.08);
    if (vTopM > x.nbTop) return Math.min(D, proj + 0.12);
    return 0;
  };
  const mPath = (vTopM, proj, wrap = null) => {
    const r0 = retLen(0, vTopM, proj, wrap), r1 = retLen(1, vTopM, proj, wrap);
    const path = [];
    if (r0 > minRet(0)) path.push(pt(0, r0));
    path.push(...cornerPts(0), ...cornerPts(1));
    if (r1 > minRet(1)) path.push(pt(1, r1));
    return path;
  };

  // exposed street corners of the main front (rusticated ground floors dress them with
  // proud blocks that wrap the corner, see rustic.js): {dir, len} of the side, or null
  const rEnds = [0, 1].map((e) => {
    const x = E[e];
    if (x.cut) return null;
    if (x.corner) return { dir: x.dir, len: x.len };
    if (!x.nb) return { dir: [0, -1], len: D };
    return x.front > 0.08 ? { dir: [0, -1], len: x.front } : null;
  });

  // ------------------------------------------------------------- faces (front + corner returns)
  const faces = [{ face: plan, frame: f, main: true }];
  for (const r of plan.returns || []) faces.push({ face: r, frame: r.frame, main: false });
  let mainShade = null, mainRend = null;
  for (const F of faces) {
    const face = F.face;
    B.frameFromLot(F.frame);
    const fs = new FaceShade(face, tint, lot.seed + (F.main ? 0 : 977), { dirt: orn.dirt, uncleaned, sillExt, sillH: orn.sillH });
    if (F.main) mainShade = fs;
    const fg = Math.min(face.groundAt(0), face.groundAt(face.width));
    const ops = face.openings.filter((o) => o.uc - o.w / 2 > 0.05 && o.uc + o.w / 2 < face.width - 0.05 && o.y + o.h < vTop - 0.05);
    let rustic = null;
    if (plan.style.rusticGround && plan.courses.length) {
      // far detail keeps the rock-faced material but drops the V-joint geometry
      const v1 = plan.courses[0].y, joints = [];
      if (q.rustic) for (let j = v1 - orn.rustH; j > fg + orn.plinthH + 0.15; j -= orn.rustH) joints.push(j);
      rustic = { v0: fg - 0.4, v1, joints, c: orn.rustC };
    }
    // (the facades module glazes every opening of the plan's fronts: filled)
    // (uvA, uvR: the walling's texture transforms, which the reveals of walled jambs follow)
    const ctx = { B, sinks, q, fs, orn, vBottom: fg - 0.35, vTop, rustic, sillExt, ch: plan.coursing.ch, fit: null, filled: true, uMin: F.main ? uMin : 0, uMax: F.main ? uMax : face.width, uvA, uvR: null, render: null };
    if (rend) {
      // render weathers faster than stone (streaks under the sills, soot under the cornice)
      const rfs = new FaceShade(face, rcol, lot.seed + 61 + (F.main ? 0 : 977), { dirt: orn.dirt * 1.1, uncleaned: Math.max(uncleaned * 0.6, 0.22), sillExt, sillH: orn.sillH });
      ctx.render = { v0: rend.from, sink: sinks.paint, fs: rfs };
      if (F.main) mainRend = rfs;
    }
    ctx.cover = q.flat ? null : (o) => coverOf(ctx, face, o);
    // texture: ashlar courses aligned with the storeys; rustication rows aligned with the V
    // joints; head joints fitted to the jambs, surrounds, pilasters and quoins per course
    B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
    if (rustic) {
      const sv = rustH ? rustH / orn.rustH : 1;
      sinks.rough.uvx = [sv, uvA[1], sv, -rustic.v1 * sv];
      ctx.uvR = sinks.rough.uvx.slice();
    }
    if (q.fit && (metas.ashlarLay || metas.roughLay)) {
      const rects = fitRects(plan, face, ops, orn, F.main, rustic && F.main ? rEnds : null, rustic);
      ctx.fit = {
        ashlar: metas.ashlarLay ? new JointFitter(metas.ashlarLay, uvA, face.width, rects) : null,
        rough: rustic && metas.roughLay ? new JointFitter(metas.roughLay, sinks.rough.uvx, face.width, rects) : null,
      };
    }
    yield;
    B.frameFromLot(F.frame);
    B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
    yield* wallField(ctx, face, ops);
    sinks.rough.uvx = null;
    B.setUV();
    B.mark('wall');
    yield;
    B.frameFromLot(F.frame);
    // (a step ends once it has taken SLICE ms: wide arched shopfronts cost several times
    // a plain window)
    let ts = performance.now();
    for (let i = 0; i < ops.length; i++) {
      openingMasonry(ctx, face, ops[i]);
      if (i < ops.length - 1 && performance.now() - ts > SLICE) { B.mark('openings'); yield; B.frameFromLot(F.frame); ts = performance.now(); }
    }
    B.mark('openings');
    // proud rock-faced blocks at the arrises of the rusticated ground floor
    if (rustic && q.rustic) {
      yield;
      B.frameFromLot(F.frame);
      yield* rusticBlocks(ctx, face, ops, F.main ? rEnds : null, F.frame);
      B.mark('rustic');
    }

    // pilasters between bays (giant order over the upper floors)
    B.shade = (u, v, w, nu, nv, nw, out) => trimColor(fs, u, v, nv, out, 1.04);
    if (plan.style.pilasters && plan.floors.length > 2) {
      const v0 = plan.courses[0].y + plan.courses[0].h;
      for (const b of face.bays) if (b.index > 0 && b.u0 > ctx.uMin + 0.6 && b.u0 < ctx.uMax - 0.6) pilaster(B, sinks.detail, b.u0, orn.pilW, orn.pilP, v0, cor.y, bev, q.lod === 0);
    }
    // quoins on a corner return (the front's column wraps the arris; these interlock with it)
    if (!F.main && !face.isCut && plan.style.quoins) {
      quoins(B, sinks.detail, face.width, face.cornerAtU1 ? 1 : 0, quoinV0(plan, orn), cor.y, quoinH(plan), orn.quoin, false, bev, { parity: 1, seed: lot.seed + 31, flat: q.flat });
    }
    // plinth segments between ground-floor openings
    B.mark('pilasters');
    if (!face.isCut) plinth(B, sinks, F, face, ops, orn, E, fg, fs, pt, ctx);
    B.mark('plinth');
    yield;
    B.frameFromLot(F.frame);
    // backstop behind the wall and the openings' dark boxes, in a mid stone tone: any
    // sub-pixel crack in the wall mesh shows this instead of the sky (kept inside the
    // footprint where the ends turn back at an angle)
    const wb = -BACKSTOP;
    // (returns: clear of the street corner, which an angled side street may bring forward)
    const [ba, bb] = F.main ? [Math.max(ctx.uMin, endU(E[0], wb)), Math.min(ctx.uMax, endU(E[1], wb))]
      : [face.cornerAtU1 && !face.isCut ? 0.1 : 0.45, face.width - (face.cornerAtU1 || face.isCut ? 0.45 : 0.1)];
    B.shade = null; B.flat = [tint[0] * 0.45, tint[1] * 0.42, tint[2] * 0.38];
    if (bb - ba > 0.1) B.rectW(sinks.dark, ba, bb, fg - 0.35, vTop, wb, 1);
    B.flat = [1, 1, 1];
  }

  // ------------------------------------------------------------- mouldings around the building (main frame)
  B.frameFromLot(f);
  B.setUV();
  B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainShade, u, v, nv, out, 1.05);
  for (const c of plan.courses) {
    B.sweep(sinks.smooth, courseProfile(c.h, c.proj), mPath(c.y + c.h, c.proj), c.y, [true, true]);
  }
  const ck = corniceProfile(cor.h, cor.proj);
  const cPath = mPath(cor.y + cor.h, cor.proj, cor.y);
  if (cor.dentils && !q.dentils) {
    // far: the dentil band reads as a darker stripe (lit blocks and shadowed gaps averaged)
    const d = ck.dentil, va = cor.y + d.v0 - 0.002, vb = cor.y + d.v1 + 0.002, wmax = d.w0 + 0.03;
    B.shade = (u, v, w, nu, nv, nw, out) => {
      trimColor(mainShade, u, v, nv, out, 1.05);
      if (v > va && v < vb && w < wmax && nw > 0.8) { out[0] *= 0.68; out[1] *= 0.67; out[2] *= 0.66; }
    };
  }
  B.sweep(sinks.smooth, ck.profile, cPath, cor.y, [true, true]);
  B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainShade, u, v, nv, out, 1.05);
  B.mark('mouldings');
  yield;
  B.frameFromLot(f);
  B.setUV();
  B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainShade, u, v, nv, out, 1.05);
  if (cor.dentils && q.dentils) dentils(B, sinks.detail, uMin + 0.05, uMax - 0.05, cor.y, ck.dentil, true);
  if (orn.modillions) modillions(B, sinks.detail, uMin + 0.25, uMax - 0.25, cor.y, cor.h, cor.proj, orn.modSpacing, q.modillions);
  B.mark('mouldings');

  // quoins at the street corners
  if (plan.style.quoins) {
    for (const e of [0, 1]) {
      const x = E[e];
      if (x.cut) continue;
      const wrap = q.lod === 0 && (x.corner || !x.nb || x.front > 0.03);
      // at a street corner the return face carries its own interlocking column
      quoins(B, sinks.detail, W, e, quoinV0(plan, orn), cor.y, quoinH(plan), orn.quoin, wrap, bev, { retFace: !x.corner, seed: lot.seed, flat: q.flat });
    }
  }

  B.mark('quoins');
  yield;
  B.frameFromLot(f);
  // ------------------------------------------------------------- party walls (exposed sides)
  const sideTop = par.y; // top of the cornice; parapets/roofs continue above
  const rects = [[], []];   // exposed side-wall strips [w0, w1, v0, v1] per end
  for (const e of [0, 1]) {
    const x = E[e];
    if (x.corner) continue;
    const vb = gMin - 0.35;
    if (!x.nb) { rects[e].push([-D, 0, vb, sideTop]); continue; }
    if (x.front > 0.01) rects[e].push([-x.front, 0, vb, sideTop]);
    // behind a shallower neighbour the whole height shows; above it, everything over its
    // roof deck (its parapet stands clear of this wall)
    if (x.nbBack > -D + 0.01) rects[e].push([-D, x.nbBack, vb, sideTop]);
    const deck = Math.min(x.nbTop, x.nbDeck ?? x.nbTop);
    if (deck < sideTop - 0.05) rects[e].push([Math.max(-D, x.nbBack), Math.min(0, -x.front), Math.max(vb, deck), sideTop]);
  }
  yield* partyWalls(B, sinks, lot, plan, orn, tint, q, rects, gMin, uvA, rcol);
  B.frameFromLot(f);
  B.mark('party');
  yield;
  B.frameFromLot(f);
  B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
  B.shade = (u, v, w, nu, nv, nw, out) => plainStone(mainShade, rcol || tint, -w + u * 0.37, v, out, 0.92, sideTop);
  // back wall (between the two back corners; slanted where a return follows a side street)
  B.vwall(rend ? sinks.paint : sinks.ashlar, E[1].back[0], E[1].back[1], E[0].back[0], E[0].back[1], gMin - 0.35, sideTop);
  B.setUV();

  // ------------------------------------------------------------- parapet / roof
  B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainShade, u, v, nv, out, 1.03);
  if (flatRoof) {
    const pv = par.y, ph = par.h;
    const sideRet = (e) => (E[e].corner || !E[e].nb || E[e].nbTop < pv + ph - 0.2 || E[e].front > 0.3 ? E[e].len : 0);
    const r0 = sideRet(0), r1 = sideRet(1);
    if (par.type === 'balustrade') {
      balustrade(B, sinks.smooth, [[0, 0], [W, 0]], pv, ph, q);
      yield;
      B.frameFromLot(f);
      B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainShade, u, v, nv, out, 1.03);
      if (r0) B.sweep(sinks.smooth, parapetProfile(0.9), [pt(0, r0), pt(0, 0.3)], pv, [true, true]);
      if (r1) B.sweep(sinks.smooth, parapetProfile(0.9), [pt(1, 0.3), pt(1, r1)], pv, [true, true]);
    } else {
      const path = [];
      if (r0 > minRet(0)) path.push(pt(0, r0));
      path.push(...cornerPts(0), ...cornerPts(1));
      if (r1 > minRet(1)) path.push(pt(1, r1));
      B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
      if (rend) B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainRend, u, v, nv, out, 1.0);
      B.sweep(rend ? sinks.paint : sinks.ashlar, parapetProfile(ph), path, pv, [true, true]);
      B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainShade, u, v, nv, out, 1.03);
      B.setUV();
      if (par.type === 'crenel') merlons(B, sinks.smooth, uMin + 0.3, uMax - 0.3, pv + ph, rng.range(0.9, 1.3), rng.range(0.45, 0.6), rng.range(0.35, 0.5));
    }
    // back parapet (plain)
    if (rend) B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainRend, u, v, nv, out, 0.97);
    B.sweep(rend ? sinks.paint : sinks.ashlar, parapetProfile(0.85), [E[1].back, E[0].back], pv, [true, true]);
    // roof deck (bituminous membrane), clockwise: negative insets
    B.shade = null;
    roofDeck(B, sinks.paint, insetPolygon(foot.flat(), -0.3), pv + 0.06, q, lot.seed);
    B.mark('parapet');
    yield;
    if (plan.upper) { yield* upperVolume(B, sinks, lot, plan, orn, tint, q, orn.dirt); B.mark('upper'); }
    B.frameFromLot(f);
    // rooftop equipment (heaters, tanks, head-houses...) throws its shadows on the roofs only
    if (q.rooftop) yield* rooftop(B, { ...sinks, paint: sinks.metal, frame: sinks.metal }, lot, plan, orn, pv + 0.06, q, tint, foot, { v: pv, h: ph, solid: par.type !== 'balustrade' });
    B.mark('rooftop');
  } else {
    B.shade = null;
    // eaves overhang the cornice; exposed ends are hipped, ends against a neighbour gabled
    // an end against a neighbour lower than the ridge is hipped too (a gable would stand
    // above it as a bare stone triangle); its eaves overhang only a neighbour below them
    const v0r = cor.y + cor.h, wbr = Math.min(E[0].back[1], E[1].back[1]) - 0.25, wfr = cor.proj + 0.4;
    const ridge = v0r + ((wfr - wbr) / 2) * Math.tan((plan.roof.pitch * Math.PI) / 180);
    const ends = E.map((x) => {
      const open = x.corner || !x.nb;
      const hip = open || x.nbTop < ridge - 0.4;
      return { dir: x.dir, hip, over: open || x.nbTop < v0r - 0.3 ? cor.proj + 0.3 : 0 };
    });
    B.flat = plan.roof.color === 'darkred' ? [0.78, 0.66, 0.64] : [1, 1, 1];
    B.setUV();
    pitchedRoof(B, sinks, {
      W, v0: cor.y + cor.h, pitch: plan.roof.pitch, front: cor.proj + 0.4,
      back: Math.min(E[0].back[1], E[1].back[1]) - 0.25, ends, wallBack: [E[0].back, E[1].back],
    }, q);
    B.flat = [1, 1, 1];
    B.mark('roof');
  }
  B.shade = null;
}

// the openings' dark boxes reach recess + backDepth (≤ 0.45 + 1.2) behind the wall face
const BACKSTOP = 1.7;
// time slice of the openings steps (ms)
const SLICE = 0.3;

/**
 * Quoin column start (the first bed joint above the plinth or the rusticated ground
 * floor) and block height (two courses), so quoin blocks course in with the walling.
 */
function quoinV0(plan, orn) {
  const v = plan.style.rusticGround && plan.courses.length ? plan.courses[0].y + plan.courses[0].h : Math.max(plan.ground0, plan.ground1) + orn.plinthH;
  const { ch, v0 } = plan.coursing;
  return v0 + Math.ceil((v - v0) / ch - 1e-3) * ch;
}
const quoinH = (plan) => 2 * plan.coursing.ch;

/**
 * Areas of a face the walling stops against, for fitting the ashlar head joints:
 * openings widened by their surrounds (up to the spring line; above it the stones are
 * cut to the arch), flat heads, aprons, pilaster shafts and quoin blocks.
 */
function fitRects(plan, face, ops, orn, main, rEnds = null, rustic = null) {
  const R = [];
  // exposed corners of the rusticated zone: a head joint on the arris (see rustic.js)
  if (rEnds && rustic) {
    if (rEnds[0]) R.push({ a: -1, b: 1e-3, v0: rustic.v0, v1: rustic.v1 });
    if (rEnds[1]) R.push({ a: face.width - 1e-3, b: face.width + 1, v0: rustic.v0, v1: rustic.v1 });
  }
  for (const o of ops) {
    const u0 = o.uc - o.w / 2, u1 = o.uc + o.w / 2, yt = o.y + o.h;
    const sw = surroundOf(o, face, orn);
    R.push({ a: u0 - sw, b: u1 + sw, v0: o.y, v1: o.spring });
    if (o.top === 'flat' || !o.rise) {
      const h = flatHead(o, orn, sw, plan.coursing.ch);
      const fan = h.kind === 'flatArch' ? 0.04 : 0;
      R.push({ a: u0 - h.ext - fan, b: u1 + h.ext + fan, v0: yt, v1: yt + h.H });
    }
    if (o.kind === 'window' && orn.apron && o.floor > 0) {
      const top = o.y - orn.sillH, ah = Math.min(0.7, top - (face.floors[o.floor].y + 0.25));
      if (ah > 0.25) R.push({ a: u0, b: u1, v0: top - ah, v1: top - 0.02 });
    }
  }
  const cor = plan.cornice;
  if (plan.style.pilasters && plan.floors.length > 2) {
    const v0 = plan.courses[0].y + plan.courses[0].h;
    for (const b of face.bays) if (b.index > 0) R.push({ a: b.u0 - orn.pilW / 2, b: b.u0 + orn.pilW / 2, v0, v1: cor.y });
  }
  if (plan.style.quoins) {
    const W = face.width, qh = quoinH(plan), q = orn.quoin;
    const sides = main ? [0, 1] : [face.cornerAtU1 ? 1 : 0];
    for (const side of sides) {
      let i = main ? 0 : 1;
      for (let v = quoinV0(plan, orn); v + qh * 0.6 < cor.y; v += qh, i++) {
        const fw = i % 2 === 0 ? q.long : q.short;
        R.push(side ? { a: W - fw, b: W + 1, v0: v, v1: v + qh } : { a: -1, b: fw, v0: v, v1: v + qh });
      }
    }
  }
  return R;
}

/** True when (u, w) lies inside the clockwise footprint quad with `margin` to every edge. */
function insideFoot(foot, u, w, margin) {
  for (let k = 0; k < foot.length; k++) {
    const a = foot[k], b = foot[(k + 1) % foot.length];
    const eu = b[0] - a[0], ew = b[1] - a[1], l = Math.hypot(eu, ew) || 1;
    // clockwise in (u, w): the interior lies to the right of each edge
    if (((u - a[0]) * ew - (w - a[1]) * eu) / l < margin) return false;
  }
  return true;
}

/**
 * Plain stone (party and back walls): tint, soft patches, darker greyer base, and rain
 * wash: vertical streaks running down from the coping, strongest near the top.
 */
function plainStone(fs, tint, u, v, out, k, top) {
  const p = noise2(u * 0.3, v * 0.25, fs.seed + 5) - 0.5;
  const hg = v - Math.min(fs.groundAt(0), fs.groundAt(fs.width));
  const dt = Math.max(0, top - v);
  const streak = (noise2(u * 1.1, v * 0.05, fs.seed + 9) - 0.35) * Math.exp(-dt / 6) * 0.22;
  const a = k * (1 + 0.1 * p) * (1 - 0.2 * Math.exp(-Math.max(0, hg) / 0.4)) * (1 - Math.max(0, streak)) * (1 - 0.1 * Math.exp(-dt / 0.6));
  const grey = Math.min(0.5, Math.max(0, streak) * 1.6 + 0.3 * Math.exp(-Math.max(0, hg) / 0.8));
  const r = tint[0] * a, g = tint[1] * a, b = tint[2] * a * 0.98, l = (r + g + b) / 3;
  out[0] = r + (l - r) * grey; out[1] = g + (l - g) * grey; out[2] = b + (l - b) * grey;
}

/** Plinth (base course) along each face between ground-floor openings, wrapping exposed corners. */
function plinth(B, sinks, F, face, ops, orn, E, fg, fs, pt, ctx) {
  const W = face.width, uMin = ctx.uMin, uMax = ctx.uMax;
  const gr = ops.filter((o) => o.floor === 0).map((o) => [o.uc - o.w / 2, o.uc + o.w / 2]).sort((a, b) => a[0] - b[0]);
  const segs = [];
  let a = uMin;
  for (const [o0, o1] of gr) { if (o0 - a > 0.08) segs.push([a, o0]); a = Math.max(a, o1); }
  if (uMax - a > 0.08) segs.push([a, uMax]);
  const p = orn.plinthP;
  // base course: a darker, greyer, harder stone; the splash zone darkens it from 0.78 at
  // the paving to clean stone 0.8 m up, with a dirt line along its foot and grime
  B.shade = (u, v, w, nu, nv, nw, out) => {
    const g = face.groundAt(u), hg = v - g;
    trimColor(fs, u, Math.max(v, g + 0.6), nv, out, 0.84);
    out[5] = hg;
    const t = Math.min(1, Math.max(0, hg / 0.8)), k = (0.68 + 0.32 * t * t * (3 - 2 * t)) * (hg < 0.06 ? 0.8 : 1);
    const l = (out[0] + out[1] + out[2]) / 3, gr = 0.45 + 0.3 * (1 - t);
    out[0] = (out[0] + (l - out[0]) * gr) * k; out[1] = (out[1] + (l - out[1]) * gr) * k; out[2] = (out[2] + (l * 1.02 - out[2]) * gr) * k;
    out[3] = Math.min(1.4, out[3] + 0.7 * Math.exp(-Math.max(0, hg) / 0.35));
  };
  // a chamfered corner: the plinth runs along the cut face to its door, and from the
  // door's far side round the corner into the return (points in the main frame)
  const cutDoor = (x) => {
    const c = x.cut, o = c.face.openings.find((q) => q.floor === 0), L = c.face.width;
    const at = (d) => [c.S[0] + (c.T[0] - c.S[0]) * (d / L), c.S[1] + (c.T[1] - c.S[1]) * (d / L)];
    return o ? [at(o.uc - o.w / 2), at(o.uc + o.w / 2)] : [at(L / 2), at(L / 2)];
  };
  if (F.main) {
    for (const e of [0, 1]) {
      const x = E[e];
      if (!x.cut) continue;
      const [d0, d1] = cutDoor(x), g = face.groundAt(e ? W : 0);
      const path = e ? [d1, x.cut.T, pt(1, x.cut.cr + p)] : [pt(0, x.cut.cr + p), x.cut.S, d0];
      B.sweep(sinks.detail, plinthProfile(g + orn.plinthH, p, fg - 0.35, g), path, 0, [true, true]);
    }
  }
  for (let [s0, s1] of segs) {
    const gs = Math.min(face.groundAt(s0), face.groundAt(s1)), top = Math.max(face.groundAt(s0), face.groundAt(s1)) + orn.plinthH;
    const prof = plinthProfile(top, p, fg - 0.35, gs);
    if (!F.main) {
      // a corner return leaves the street corner to the front's plinth, which wraps it
      if (face.cornerAtU1 && s1 > W - 0.01) s1 = W - p;
      if (!face.cornerAtU1 && s0 < 0.01) s0 = p;
      if (s1 - s0 < 0.05) continue;
    }
    const path = [[s0, 0], [s1, 0]];
    if (F.main) {
      // wrap around exposed ends and street corners of the main front (along a chamfer
      // as far as its door)
      const ret = (x) => (x.corner ? p : !x.nb ? p + 0.1 : x.front > 0.03 ? Math.max(x.front, p + 0.08) : 0);
      if (s0 < uMin + 0.01) {
        if (E[0].cut) path.unshift(cutDoor(E[0])[1]);
        else { const r = ret(E[0]); if (r) path.unshift(pt(0, r)); }
      }
      if (s1 > uMax - 0.01) {
        if (E[1].cut) path.push(cutDoor(E[1])[0]);
        else { const r = ret(E[1]); if (r) path.push(pt(1, r)); }
      }
    }
    B.sweep(sinks.detail, prof, path, 0, [true, true]);
  }
}

/**
 * Rooftop equipment: plan.rooftop items, an optional stair head-house, solar water
 * heaters in rows towards the back, and a front row that breaks the skyline seen from
 * the street (heaters raised on stands, masts, tanks, dishes on the parapet coping).
 * Everything keeps clear of the parapets and of the set-back upper volume, and yields
 * between items. v0: deck height; par: {v, h, solid} of the front parapet.
 */
function* rooftop(B, sinks, lot, plan, orn, v0, q, tint, foot, par) {
  const W = plan.width, D = plan.depth;
  const placed = [];
  const up = upperFootprint(plan);
  const clearOfUpper = (u, w, r) => !up || u + r < up[0] || u - r > up[1] || w + r < up[2] || w - r > up[3];
  const free = (u, w, r) => clearOfUpper(u, w, r) && placed.every((p) => Math.hypot(p[0] - u, p[1] - w) > p[2] + r) && insideFoot(foot, u, w, r + 0.4);
  if (!sinks.glass && !q.lod) sinks.glass = B.sink('glass');   // far: glazing joins the metal batch
  const yawSun = sunYaw(lot.frame);
  const heater = (u, w, vBase, r, stand, n) => {
    B.enter(u, vBase, w, yawSun + r.range(-0.1, 0.1));
    solarHeater(B, sinks, 0, q, r, stand, n);
    B.popFrame();
  };
  if (orn.headHouse && W > 6 && D > 7) {
    const u = W * orn.headU, w = -D * orn.headW;
    if (free(u, w, 1.8)) {
      placed.push([u, w, 1.8]);
      const r = RNG.from(lot.seed, 'head');
      B.enter(u, v0, w, r.range(-0.05, 0.05));
      headHouse(B, sinks, q, r, tint);
      B.popFrame();
    }
  }
  B.mark('roof.head');
  // front row: what shows above the parapet from the street
  const fr = RNG.from(lot.seed, 'front');
  const nFront = fr.weighted([[0, 0.2], [1, 0.4], [2, 0.3], [3, 0.1]]);
  for (let i = 0; i < nFront; i++) {
    const r = RNG.from(lot.seed, 'front', i);
    const kind = r.weighted([['heater', 0.55], ['mast', 0.25], ['tank', 0.2]]);
    const n = r.chance(0.6) ? 2 : 1, rad = kind === 'heater' ? heaterRadius(n) : kind === 'tank' ? 0.75 : 0.35;
    const u = r.range(rad + 0.4, W - rad - 0.4), w = -(0.35 + rad + r.range(0.05, 0.6));
    if (!free(u, w, rad)) continue;
    placed.push([u, w, rad]);
    if (kind === 'heater') heater(u, w, v0, r, r.range(0.9, 1.5), n);
    else {
      B.enter(u, v0, w, r.range(0, Math.PI));
      if (kind === 'tank') waterTank(B, sinks, q, r); else antenna(B, sinks, q, r);
      B.popFrame();
    }
    yield;
    B.frameFromLot(lot.frame);
  }
  B.mark('roof.front');
  // satellite dishes on the front parapet coping, turned to the southern sky
  if (par.solid && fr.chance(0.4)) {
    const nd = fr.chance(0.7) ? 1 : 2;
    for (let i = 0; i < nd; i++) {
      const u = fr.range(0.8, W - 0.8);
      B.enter(u, par.v + par.h, -0.15, yawSun + fr.range(-0.4, 0.4));
      satelliteDish(B, sinks.metal, q, fr);
      B.popFrame();
    }
  }
  B.mark('roof.dish');
  plan.rooftop.forEach((it, i) => {
    const r = RNG.from(lot.seed, 'roof', i);
    const n = r.chance(0.7) ? 2 : 1;
    const rad = it.type === 'solarHeater' ? heaterRadius(n) : it.type === 'tank' ? 0.8 : 0.6;
    let u = it.u, w = it.w;
    for (let k = 0; k < 6 && !free(u, w, rad); k++) { u = r.range(rad + 0.5, W - rad - 0.5); w = -r.range(rad + 0.7, D - rad - 0.7); }
    if (!free(u, w, rad)) return;
    placed.push([u, w, rad]);
    if (it.type === 'solarHeater') heater(u, w, v0, r, r.chance(0.4) ? r.range(0.6, 1.2) : 0, n);
    else {
      B.enter(u, v0, w, it.yaw);
      if (it.type === 'tank') waterTank(B, sinks, q, r);
      else if (it.type === 'ac') acUnit(B, sinks, q, r);
      else antenna(B, sinks, q, r);
      B.popFrame();
    }
  });
  B.mark('roof.plan');
  yield;
  B.frameFromLot(lot.frame);
  // one solar water heater per flat, in rows towards the back of the roof (the
  // characteristic skyline of the city), about half of them on raised stands
  const rr = RNG.from(lot.seed, 'heaters');
  const flats = Math.round((plan.floors.length - 1) * rr.range(0.8, 2.2));
  const nMax = Math.min(q.lod ? 4 : 12, flats);
  const R2 = heaterRadius(2);
  let n = 0;
  for (let w = -D + R2 + 0.45; w < -R2 - 0.6 && n < nMax; w += rr.range(2.9, 3.4)) {
    for (let u = R2 + 0.45 + rr.range(0, 0.5); u < W - R2 - 0.45 && n < nMax; u += rr.range(2.3, 2.7)) {
      if (!free(u, w, R2) || rr.chance(0.15)) continue;
      placed.push([u, w, R2]);
      const r = RNG.from(lot.seed, 'heater', n++);
      heater(u, w, v0, r, r.chance(0.5) ? r.range(0.5, 1.3) : 0, 2);
      yield;
      B.frameFromLot(lot.frame);
    }
  }
  B.mark('roof.rows');
  for (let i = 0; i < (q.lod ? 1 : 3); i++) {
    const r = RNG.from(lot.seed, 'extra', i);
    if (!r.chance(0.5)) continue;
    const u = r.range(1, W - 1), w = -r.range(1.2, D - 1.2);
    const tank = r.chance(0.5);
    if (!free(u, w, tank ? 0.75 : 0.4)) continue;
    placed.push([u, w, tank ? 0.75 : 0.4]);
    B.enter(u, v0, w, r.range(0, Math.PI));
    if (tank) waterTank(B, sinks, q, r); else antenna(B, sinks, q, r);
    B.popFrame();
  }
  // the upper volume's own roof: a heater or two right against the sky
  if (plan.upper) {
    const U = plan.upper, top = U.v0 + U.floors * U.floorH + 0.2;
    const r = RNG.from(lot.seed, 'upperRoof');
    const k = Math.min(2, Math.floor(U.width / 3.2));
    for (let i = 0; i < k; i++) {
      const u = U.u0 + (U.width * (i + 0.5)) / k, w = -U.setback - U.depth * r.range(0.35, 0.65);
      if (U.depth < 2 * R2 + 0.4) break;
      heater(u, w, top, r, r.chance(0.5) ? r.range(0.4, 1.0) : 0, 2);
    }
  }
  B.flat = [1, 1, 1];
}

/**
 * Roof deck: bituminous membrane laid in strips (per-strip tone), with drain outlets, in
 * the plaster batch (darkened to the membrane's tone).
 */
const DECK = 0.68;
function roofDeck(B, s, poly, v, q, seed) {
  if (poly.length !== 8) {
    B.flat = [0.62, 0.61, 0.6].map((c) => c * DECK);
    B.polyV(s, poly, v);
    B.flat = [1, 1, 1];
    return;
  }
  const [P0, P1, P2, P3] = [0, 1, 2, 3].map((k) => [poly[k * 2], poly[k * 2 + 1]]);
  const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]), Dd = Math.hypot(P3[0] - P0[0], P3[1] - P0[1]);
  const nu = q.lod ? 1 : Math.max(1, Math.round(L / 2.6)), nw = q.lod ? 1 : Math.max(1, Math.round(Dd / 3));
  const at = (a, b) => {
    const x0 = P0[0] + (P1[0] - P0[0]) * a, y0 = P0[1] + (P1[1] - P0[1]) * a;
    const x1 = P3[0] + (P2[0] - P3[0]) * a, y1 = P3[1] + (P2[1] - P3[1]) * a;
    return [x0 + (x1 - x0) * b, y0 + (y1 - y0) * b];
  };
  for (let i = 0; i < nu; i++) for (let j = 0; j < nw; j++) {
    const k = (0.94 + 0.12 * hash3(i, j, seed)) * DECK;
    B.flat = [0.62 * k, 0.61 * k, 0.6 * k];
    const a = at(i / nu, j / nw), b = at((i + 1) / nu, j / nw), c = at((i + 1) / nu, (j + 1) / nw), d = at(i / nu, (j + 1) / nw);
    B.polyV(s, [a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]], v);
  }
  if (!q.lod) {
    // drain outlets near the back corners: dark stained patches
    B.flat = [0.15, 0.15, 0.15];
    for (const t of [0.12, 0.88]) {
      const c = at(t, 0.93);
      B.polyV(s, [c[0] - 0.25, c[1] + 0.25, c[0] + 0.25, c[1] + 0.25, c[0] + 0.25, c[1] - 0.25, c[0] - 0.25, c[1] - 0.25], v + 0.004);
    }
  }
  B.flat = [1, 1, 1];
}

/**
 * Emergency stand-in for a far lot whose real shell is not generated yet (well under a
 * millisecond): front slab with dark openings, cornice band, sides, back and roof. Shown
 * at the far edge of the view for the few frames until the real shell is swapped in.
 */
export function coarseLot(B, lot) {
  const plan = facadePlan(lot);
  const W = plan.width, D = plan.depth, cor = plan.cornice;
  const tint = plan.style.tint.map((c, i) => c / [0.86, 0.80, 0.68][i]);
  const g = Math.min(plan.ground0, plan.ground1) - 0.3, top = plan.parapet.y + (plan.roof.type === 'tile' ? 0 : plan.parapet.h);
  const s = B.sink('ashlar'), sm = B.sink('smooth'), dk = B.sink('plaster');
  B.begin();
  B.frameFromLot(lot.frame);
  B.flat = tint;
  B.rectW(s, 0, W, g, top, 0, 1);
  B.rectU(s, 0, g, top, -D, 0, -1);
  B.rectU(s, W, g, top, -D, 0, 1);
  B.rectW(s, 0, W, g, top, -D, -1);
  B.rectV(s, 0, W, -D, 0, top, 1);
  B.flat = tint.map((c) => c * 1.03);
  B.box(sm, -0.05, W + 0.05, cor.y, cor.y + cor.h, 0, cor.proj, FACES.FRONT | FACES.BOTTOM | FACES.TOP);
  B.flat = [0.05, 0.048, 0.046];
  for (const o of plan.openings) {
    if (o.y + o.h > cor.y) continue;
    B.rectW(dk, o.uc - o.w / 2, o.uc + o.w / 2, o.y, o.y + o.h - o.rise * 0.4, 0.01, 1);
  }
  const up = plan.upper;
  if (up) {
    // the set-back volume (a tower closing the view is what the far edge shows first)
    const ut = up.v0 + up.floors * up.floorH + 0.2, w1 = -up.setback, w0 = w1 - up.depth;
    B.flat = up.material === 'plaster' ? up.color.map((c) => c / 0.9) : tint;
    B.box(up.material === 'plaster' ? dk : s, up.u0, up.u1, up.v0 - 0.1, ut, w0, w1, FACES.ALL & ~FACES.BOTTOM);
    B.flat = [0.05, 0.048, 0.046];
    for (const o of up.openings) B.rectW(dk, up.u0 + o.uc - o.w / 2, up.u0 + o.uc + o.w / 2, o.y, o.y + o.h, w1 + 0.01, 1);
  }
  B.flat = [1, 1, 1];
}
