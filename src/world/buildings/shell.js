import { RNG } from '../../core/rng.js';
import { facadePlan } from '../facadePlan.js';
import { FaceShade, stoneStyle, trimColor, noise2, setBlock, hash3 } from './shade.js';
import { insetPolygon, FACES } from './mesh.js';
import { wallField } from './wall.js';
import { openingMasonry, surroundOf, flatHead } from './openings.js';
import { JointFitter } from './coursing.js';
import { courseProfile, plinthProfile, corniceProfile, dentils, modillions, quoins, pilaster } from './mouldings.js';
import { parapetProfile, balustrade, merlons, pitchedRoof, solarHeater, sunYaw, waterTank, acUnit, antenna, headHouse } from './roof.js';
import { openingInfill } from './infill.js';

// Masonry shell of one building lot, generated from its facade plan:
// wall fields with real openings, reveals and dark closed interiors, arches with
// voussoirs and keystones, surrounds, sills, string courses, cornice (dentils,
// modillions), parapet or tiled hip roof, plinth following the slope, steps,
// rustication, quoins, pilasters, corner returns, party walls where neighbours step,
// rooftop equipment. Output: one compact vertex/index set per material key.

/**
 * Detail levels: 0 near (< 200 m), 1 far (200–680 m). The default view is a 17° telephoto,
 * where 200 m is ~5.5 cm per pixel, so the far level keeps every moulding profile, hood,
 * keystone and the baked occlusion rows (no popping at the switch) and only drops what
 * is sub-pixel there: bevels, voussoir joints, dentil and baluster geometry (replaced by
 * shaded bands), V joints, steps, reveal interiors.
 */
export const DETAIL = {
  0: { lod: 0, archSeg: 14, voussoirs: true, bevel: true, interior: true, dentils: true, modillions: true, balusters: true, rustic: true, steps: true, gridU: 1.1, gridV: 0.9, rooftop: true },
  1: { lod: 1, archSeg: 10, voussoirs: false, bevel: false, interior: false, dentils: false, modillions: false, balusters: false, rustic: false, steps: false, gridU: 2.0, gridV: 2.4, rooftop: true },
};

/** Building-only style choices (own RNG stream, never shifts the shared plan). */
function ornament(plan, rng) {
  const era = plan.style.era;
  return {
    sw: rng.range(0.15, 0.22),                        // window surround width
    sp: rng.range(0.03, 0.05),                        // surround projection
    ring: rng.range(0.24, 0.32),                      // plain arch ring depth (no surround)
    shopRing: rng.range(0.42, 0.56),                  // ground-floor arch voussoirs
    shopRingP: rng.range(0.015, 0.035),
    keystone: era !== 'modern' && rng.chance(0.75),
    winHead: era === 'modern' ? 'plain' : rng.weighted([['lintel', 0.35], ['flatArch', 0.3], ['hood', 0.25], ['plain', 0.1]]),
    shopHead: rng.weighted([['flatArch', 0.45], ['lintel', 0.55]]),
    sillH: rng.range(0.1, 0.15), sillP: rng.range(0.06, 0.1),
    sillCorbels: rng.chance(0.35),
    ears: era !== 'modern' && rng.chance(0.35),        // crossettes: surround corners stepping out at the head
    apron: rng.chance(0.3),                            // raised panel under each sill
    doorSurround: rng.chance(0.7), doorHood: era !== 'modern' && rng.chance(0.55),
    plinthH: rng.range(0.35, 0.8), plinthP: rng.range(0.04, 0.08),
    rustH: rng.range(0.45, 0.6), rustC: rng.range(0.025, 0.04),
    quoin: { long: rng.range(0.75, 0.95), short: rng.range(0.42, 0.55), proj: rng.range(0.02, 0.035) },
    pilW: rng.range(0.42, 0.56), pilP: rng.range(0.06, 0.1),
    modillions: era !== 'modern' && rng.chance(0.45), modSpacing: rng.range(0.55, 0.8),
    headHouse: rng.chance(0.35), headU: rng.range(0.25, 0.75), headW: rng.range(0.35, 0.65),
    dirt: rng.range(0.6, 1.3),
  };
}

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
  const orn = ornament(plan, rng);
  const { tint, uncleaned } = stoneStyle(plan, rng);
  const sillExt = (plan.style.surrounds ? orn.sw : 0.06) + 0.07;   // sill overhang beyond the jambs
  const uvA = ashlarUV(plan, metas.ashlar, rng);
  const rustH = metas.rough && (metas.rough.courseH ?? metas.rough.rowH ?? metas.rough.layout?.rowH);
  B.begin();
  const sinks = {
    ashlar: B.sink('ashlar'), smooth: B.sink('smooth'), rough: B.sink('rough'), dark: B.sink('plaster'), paint: B.sink('plaster'),
    tile: B.sink('tile'), metal: B.sink(q.lod ? 'plaster' : 'metal'), // far: rooftop metal joins the plaster batch
  };
  // buildings-only lots (side-street backdrops) carry their own glazing and joinery
  const dress = !!lot.selfDressed;
  if (dress) { sinks.glass = B.sink('glass'); sinks.frame = B.sink('frame'); }
  const irng = RNG.from(lot.seed, 'infill');
  const cor = plan.cornice, par = plan.parapet;
  const vTop = cor.y + 0.06;
  const gMin = Math.min(plan.ground0, plan.ground1);
  const flatRoof = plan.roof.type !== 'tile';
  const bev = q.bevel ? 0.012 : 0;

  // ------------------------------------------------------------- end exposure
  // Each end of the front turns back along `dir` (u, w): straight back (−w) for party
  // walls, along the real side-street line for corner returns (plan.returns[].dir),
  // `len` metres to the back corner. The footprint is the quad front + the two back corners.
  const E = ends.map((e, k) => {
    const front = e.nb ? Math.max(0, -e.dw) : 0;
    const ret = e.corner ? (plan.returns || []).find((r) => r.end === k) : null;
    const P = [k ? W : 0, 0];
    const dir = ret ? ret.dir : [0, -1], len = ret ? ret.width : D;
    return { ...e, front, nbBack: e.nb ? e.dw - e.nbDepth : 0, ret, P, dir, len, back: [P[0] + dir[0] * len, dir[1] * len] };
  });
  /** Point `r` metres back from the front corner at end e (along that end's wall). */
  const pt = (e, r) => [E[e].P[0] + E[e].dir[0] * r, E[e].dir[1] * r];
  const foot = [[0, 0], [W, 0], E[1].back, E[0].back];   // clockwise in (u, w): faces up
  /** Return length of a moulding whose top is at vTopM around end e (0 = none). */
  const retLen = (e, vTopM, proj) => {
    const x = E[e];
    if (x.corner) return x.len;
    if (!x.nb) return proj + 0.12;
    // a return shorter than the projection would fold the mitre over; the excess
    // disappears inside the set-back neighbour
    if (x.front > 0.03) return Math.max(x.front, proj + 0.08);
    if (vTopM > x.nbTop) return Math.min(D, proj + 0.12);
    return 0;
  };
  const mPath = (vTopM, proj) => {
    const r0 = retLen(0, vTopM, proj), r1 = retLen(1, vTopM, proj);
    const path = [];
    if (r0 > 0.01) path.push(pt(0, r0));
    path.push([0, 0], [W, 0]);
    if (r1 > 0.01) path.push(pt(1, r1));
    return path;
  };

  // ------------------------------------------------------------- faces (front + corner returns)
  const faces = [{ face: plan, frame: f, main: true }];
  for (const r of plan.returns || []) faces.push({ face: r, frame: r.frame, main: false });
  let mainShade = null;
  for (const F of faces) {
    const face = F.face;
    B.frameFromLot(F.frame);
    const fs = new FaceShade(face, tint, lot.seed + (F.main ? 0 : 977), { dirt: orn.dirt, uncleaned, sillExt });
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
    const ctx = { B, sinks, q, fs, orn, vBottom: fg - 0.35, vTop, rustic, sillExt, ch: plan.coursing.ch, fit: null };
    // texture: ashlar courses aligned with the storeys; rustication rows aligned with the V
    // joints; head joints fitted to the jambs, surrounds, pilasters and quoins per course
    B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
    if (rustic) {
      const sv = rustH ? rustH / orn.rustH : 1;
      sinks.rough.uvx = [sv, uvA[1], sv, -rustic.v1 * sv];
    }
    if (metas.ashlarLay || metas.roughLay) {
      const rects = fitRects(plan, face, ops, orn, F.main);
      ctx.fit = {
        ashlar: metas.ashlarLay ? new JointFitter(metas.ashlarLay, uvA, face.width, rects) : null,
        rough: rustic && metas.roughLay ? new JointFitter(metas.roughLay, sinks.rough.uvx, face.width, rects) : null,
      };
    }
    yield* wallField(ctx, face, ops);
    sinks.rough.uvx = null;
    B.setUV();
    B.mark('wall');
    yield;
    B.frameFromLot(F.frame);
    for (let i = 0; i < ops.length; i++) {
      openingMasonry(ctx, face, ops[i]);
      if (dress) openingInfill(ctx, face, ops[i], irng);
      if (i % 3 === 2) { B.mark('openings'); yield; B.frameFromLot(F.frame); }
    }
    B.mark('openings');

    // pilasters between bays (giant order over the upper floors)
    B.shade = (u, v, w, nu, nv, nw, out) => trimColor(fs, u, v, nv, out, 1.04);
    if (plan.style.pilasters && plan.floors.length > 2) {
      const v0 = plan.courses[0].y + plan.courses[0].h;
      for (const b of face.bays) if (b.index > 0) pilaster(B, sinks.smooth, b.u0, orn.pilW, orn.pilP, v0, cor.y, bev, q.lod === 0);
    }
    // quoins on a corner return (the front's column wraps the arris; these interlock with it)
    if (!F.main && plan.style.quoins) {
      quoins(B, sinks.smooth, face.width, face.cornerAtU1 ? 1 : 0, quoinV0(plan, orn), cor.y, quoinH(plan), orn.quoin, false, bev, { parity: 1 });
    }
    // plinth segments between ground-floor openings
    B.mark('pilasters');
    plinth(B, sinks, F, face, ops, orn, E, fg, fs, pt);
    B.mark('plinth');
    yield;
    B.frameFromLot(F.frame);
    // backstop just behind the wall, in a mid stone tone: any sub-pixel crack in the
    // wall mesh shows this instead of the sky
    B.shade = null; B.flat = [tint[0] * 0.45, tint[1] * 0.42, tint[2] * 0.38];
    B.rectW(sinks.dark, 0, face.width, fg - 0.35, vTop, -0.92, 1);
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
  const cPath = mPath(cor.y + cor.h, cor.proj);
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
  if (cor.dentils && q.dentils) dentils(B, sinks.smooth, 0.05, W - 0.05, cor.y, ck.dentil, true);
  if (orn.modillions) modillions(B, sinks.smooth, 0.25, W - 0.25, cor.y, cor.h, cor.proj, orn.modSpacing, q.modillions);
  B.mark('mouldings');

  // quoins at the street corners
  if (plan.style.quoins) {
    for (const e of [0, 1]) {
      const x = E[e];
      const wrap = q.lod === 0 && (x.corner || !x.nb || x.front > 0.03);
      // at a street corner the return face carries its own interlocking column
      quoins(B, sinks.smooth, W, e, quoinV0(plan, orn), cor.y, quoinH(plan), orn.quoin, wrap, bev, { retFace: !x.corner });
    }
  }

  B.mark('quoins');
  yield;
  B.frameFromLot(f);
  // ------------------------------------------------------------- party walls (exposed sides)
  const sideTop = par.y; // top of the cornice; parapets/roofs continue above
  B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
  B.shade = (u, v, w, nu, nv, nw, out) => plainStone(mainShade, tint, -w + u * 0.37, v, out, 0.92, sideTop);
  for (const e of [0, 1]) {
    const x = E[e];
    if (x.corner) continue;
    const u = e ? W : 0, dir = e ? 1 : -1;
    const vb = gMin - 0.35;
    const cell = q.lod ? 3 : 1.6;
    if (!x.nb) { B.gridU(sinks.ashlar, u, vb, sideTop, -D, 0, dir, cell); continue; }
    if (x.front > 0.01) B.gridU(sinks.ashlar, u, vb, sideTop, -x.front, 0, dir, cell);
    if (x.nbBack > -D + 0.01) B.gridU(sinks.ashlar, u, vb, Math.min(sideTop, x.nbTop), -D, x.nbBack, dir, cell);
    if (x.nbTop < sideTop) B.gridU(sinks.ashlar, u, Math.max(vb, x.nbTop), sideTop, Math.max(-D, x.nbBack), Math.min(0, -x.front), dir, cell);
  }
  // back wall (between the two back corners; slanted where a return follows a side street)
  B.vwall(sinks.ashlar, E[1].back[0], E[1].back[1], E[0].back[0], E[0].back[1], gMin - 0.35, sideTop);
  B.setUV();

  // ------------------------------------------------------------- parapet / roof
  B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainShade, u, v, nv, out, 1.03);
  if (flatRoof) {
    const pv = par.y, ph = par.h;
    const sideRet = (e) => (E[e].corner || !E[e].nb || E[e].nbTop < pv + ph - 0.2 || E[e].front > 0.3 ? E[e].len : 0);
    const r0 = sideRet(0), r1 = sideRet(1);
    if (par.type === 'balustrade') {
      balustrade(B, sinks.smooth, [[0, 0], [W, 0]], pv, ph, q);
      if (r0) B.sweep(sinks.smooth, parapetProfile(0.9), [pt(0, r0), pt(0, 0.3)], pv, [true, true]);
      if (r1) B.sweep(sinks.smooth, parapetProfile(0.9), [pt(1, 0.3), pt(1, r1)], pv, [true, true]);
    } else {
      const path = [];
      if (r0) path.push(pt(0, r0));
      path.push([0, 0], [W, 0]);
      if (r1) path.push(pt(1, r1));
      B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
      B.sweep(sinks.ashlar, parapetProfile(ph), path, pv, [true, true]);
      B.setUV();
      if (par.type === 'crenel') merlons(B, sinks.smooth, 0.3, W - 0.3, pv + ph, rng.range(0.9, 1.3), rng.range(0.45, 0.6), rng.range(0.35, 0.5));
    }
    // back parapet (plain)
    B.sweep(sinks.ashlar, parapetProfile(0.85), [E[1].back, E[0].back], pv, [true, true]);
    // roof deck (grey bituminous screed), in the plaster batch
    B.shade = null; B.flat = [0.42, 0.41, 0.4];
    B.polyV(sinks.paint, insetPolygon(foot.flat(), -0.3), pv + 0.06); // clockwise: negative insets
    B.flat = [1, 1, 1];
    B.mark('parapet');
    yield;
    B.frameFromLot(f);
    if (q.rooftop) yield* rooftop(B, sinks, lot, plan, orn, pv + 0.06, q, tint, foot);
    B.mark('rooftop');
  } else {
    B.shade = null;
    // eaves overhang the cornice; exposed ends are hipped, ends against a neighbour gabled
    const ends = E.map((x) => {
      const hip = x.corner || !x.nb;
      return { dir: x.dir, hip, over: hip ? cor.proj + 0.3 : 0 };
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
function fitRects(plan, face, ops, orn, main) {
  const R = [];
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
function plinth(B, sinks, F, face, ops, orn, E, fg, fs, pt) {
  const W = face.width;
  const gr = ops.filter((o) => o.floor === 0).map((o) => [o.uc - o.w / 2, o.uc + o.w / 2]).sort((a, b) => a[0] - b[0]);
  const segs = [];
  let a = 0;
  for (const [o0, o1] of gr) { if (o0 - a > 0.08) segs.push([a, o0]); a = Math.max(a, o1); }
  if (W - a > 0.08) segs.push([a, W]);
  const p = orn.plinthP;
  // base course: a slightly greyer, harder stone
  B.shade = (u, v, w, nu, nv, nw, out) => {
    trimColor(fs, u, v, nv, out, 0.9);
    const l = (out[0] + out[1] + out[2]) / 3;
    out[0] += (l - out[0]) * 0.35; out[1] += (l - out[1]) * 0.35; out[2] += (l * 1.02 - out[2]) * 0.35;
  };
  for (let [s0, s1] of segs) {
    const top = Math.max(face.groundAt(s0), face.groundAt(s1)) + orn.plinthH;
    const prof = plinthProfile(top, p, fg - 0.35);
    if (!F.main) {
      // a corner return leaves the street corner to the front's plinth, which wraps it
      if (face.cornerAtU1 && s1 > W - 0.01) s1 = W - p;
      if (!face.cornerAtU1 && s0 < 0.01) s0 = p;
      if (s1 - s0 < 0.05) continue;
    }
    const path = [[s0, 0], [s1, 0]];
    if (F.main) {
      // wrap around exposed ends and street corners of the main front
      const ret = (x) => (x.corner ? p : !x.nb ? p + 0.1 : x.front > 0.03 ? Math.max(x.front, p + 0.08) : 0);
      if (s0 < 0.01) { const r = ret(E[0]); if (r) path.unshift(pt(0, r)); }
      if (s1 > W - 0.01) { const r = ret(E[1]); if (r) path.push(pt(1, r)); }
    }
    B.sweep(sinks.smooth, prof, path, 0, [true, true]);
  }
}

/** Rooftop equipment from plan.rooftop, kept apart from each other, plus an optional stair head-house. */
function* rooftop(B, sinks, lot, plan, orn, v0, q, tint, foot) {
  const W = plan.width, D = plan.depth;
  const placed = [];
  const free = (u, w, r) => placed.every((p) => Math.hypot(p[0] - u, p[1] - w) > p[2] + r) && insideFoot(foot, u, w, r + 0.5);
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
  const yawSun = sunYaw(lot.frame);
  plan.rooftop.forEach((it, i) => {
    const r = RNG.from(lot.seed, 'roof', i);
    const rad = it.type === 'solarHeater' ? 1.5 : it.type === 'tank' ? 0.8 : it.type === 'ac' ? 0.6 : 0.6;
    let u = it.u, w = it.w;
    for (let k = 0; k < 6 && !free(u, w, rad); k++) { u = r.range(rad + 0.5, W - rad - 0.5); w = -r.range(rad + 0.7, D - rad - 0.7); }
    if (!free(u, w, rad)) return;
    placed.push([u, w, rad]);
    if (it.type === 'solarHeater') {
      B.enter(u, v0, w, yawSun + r.range(-0.12, 0.12));
      solarHeater(B, sinks, 0, q, r);
    } else {
      B.enter(u, v0, w, it.yaw);
      if (it.type === 'tank') waterTank(B, sinks, q, r);
      else if (it.type === 'ac') acUnit(B, sinks, q, r);
      else antenna(B, sinks, q, r);
    }
    B.popFrame();
  });
  // one solar water heater per flat, in rows towards the back of the roof (the
  // characteristic skyline of the city), with the odd extra tank or mast
  const rr = RNG.from(lot.seed, 'heaters');
  const flats = Math.round((plan.floors.length - 1) * rr.range(0.8, 2.2));
  const nMax = Math.min(q.lod ? 4 : 12, flats);
  let n = 0;
  for (let w = -D + 1.9; w < -3.2 && n < nMax; w += rr.range(2.5, 3.0)) {
    for (let u = 1.6 + rr.range(0, 0.6); u < W - 1.6 && n < nMax; u += rr.range(2.2, 2.6)) {
      if (!free(u, w, 1.05) || rr.chance(0.15)) continue;
      placed.push([u, w, 1.05]);
      const r = RNG.from(lot.seed, 'heater', n++);
      B.enter(u, v0, w, yawSun + r.range(-0.08, 0.08));
      solarHeater(B, sinks, 0, q, r);
      B.popFrame();
    }
  }
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
  B.flat = [1, 1, 1];
}
