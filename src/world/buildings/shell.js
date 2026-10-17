import { RNG } from '../../core/rng.js';
import { facadePlan } from '../facadePlan.js';
import { FaceShade, stoneTint, trimColor, noise2 } from './shade.js';
import { wallField } from './wall.js';
import { openingMasonry } from './openings.js';
import { courseProfile, plinthProfile, corniceProfile, dentils, modillions, quoins, pilaster } from './mouldings.js';
import { parapetProfile, balustrade, merlons, hipRoof, solarHeater, sunYaw, waterTank, acUnit, antenna, headHouse } from './roof.js';

// Masonry shell of one building lot, generated from its facade plan:
// wall fields with real openings, reveals and dark closed interiors, arches with
// voussoirs and keystones, surrounds, sills, string courses, cornice (dentils,
// modillions), parapet or tiled hip roof, plinth following the slope, steps,
// rustication, quoins, pilasters, corner returns, party walls where neighbours step,
// rooftop equipment. Output: one compact vertex/index set per material key.

/** Detail levels: 0 near (< 200 m), 1 far. */
export const DETAIL = {
  0: { lod: 0, archSeg: 14, voussoirs: true, bevel: true, interior: true, dentils: true, modillions: true, balusters: true, rustic: true, steps: true, gridU: 1.1, gridV: 0.9, rooftop: true },
  1: { lod: 1, archSeg: 6, voussoirs: false, bevel: false, interior: false, dentils: false, modillions: false, balusters: false, rustic: false, steps: false, gridU: 4, gridV: 3.5, rooftop: true },
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
  const typ = plan.floors[1] ? plan.floors[1].h : 3.5;
  const n = Math.max(1, Math.round(typ / plan.style.courseH));
  const ch = typ / n;                                  // course height so a storey holds whole courses
  const mCH = meta && (meta.courseH ?? meta.rowH ?? meta.layout?.rowH);
  const mBL = meta && (meta.blockL ?? meta.blockLength);
  const sv = mCH ? mCH / ch : 1;
  const su = mBL ? mBL / plan.style.blockL : sv;
  const g = plan.floors[1] ? plan.floors[1].y : 0;
  // joints on the first-floor line, plus a random whole number of texture courses so
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
  const tint = stoneTint(plan, rng);
  const uvA = ashlarUV(plan, metas.ashlar, rng);
  const rustH = metas.rough && (metas.rough.courseH ?? metas.rough.rowH ?? metas.rough.layout?.rowH);
  B.begin();
  const sinks = {
    ashlar: B.sink('ashlar'), smooth: B.sink('smooth'), rough: B.sink('rough'), dark: B.sink('plaster'), paint: B.sink('plaster'),
    tile: B.sink('tile'), metal: B.sink(q.lod ? 'plaster' : 'metal'), // far: rooftop metal joins the plaster batch
  };
  const cor = plan.cornice, par = plan.parapet;
  const vTop = cor.y + 0.06;
  const gMin = Math.min(plan.ground0, plan.ground1);
  const flatRoof = plan.roof.type !== 'tile';
  const bev = q.bevel ? 0.012 : 0;

  // ------------------------------------------------------------- end exposure
  const E = ends.map((e) => {
    const front = e.nb ? Math.max(0, -e.dw) : 0;
    return { ...e, front, nbBack: e.nb ? e.dw - e.nbDepth : 0 };
  });
  /** Return length of a moulding whose top is at vTopM around end e (0 = none). */
  const retLen = (e, vTopM, proj) => {
    const x = E[e];
    if (x.corner) return D;
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
    if (r0 > 0.01) path.push([0, -r0]);
    path.push([0, 0], [W, 0]);
    if (r1 > 0.01) path.push([W, -r1]);
    return path;
  };

  // ------------------------------------------------------------- faces (front + corner returns)
  const faces = [{ face: plan, frame: f, main: true }];
  for (const r of plan.returns || []) faces.push({ face: r, frame: r.frame, main: false });
  let mainShade = null;
  for (const F of faces) {
    const face = F.face;
    B.frameFromLot(F.frame);
    const fs = new FaceShade(face, tint, lot.seed + (F.main ? 0 : 977), { dirt: orn.dirt });
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
    const ctx = { B, sinks, q, fs, orn, vBottom: fg - 0.35, vTop, rustic };
    // texture: ashlar courses aligned with the storeys; rustication rows aligned with the V joints
    B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
    if (rustic) {
      const sv = rustH ? rustH / orn.rustH : 1;
      sinks.rough.uvx = [sv, uvA[1], sv, -rustic.v1 * sv];
    }
    wallField(ctx, face, ops);
    sinks.rough.uvx = null;
    B.setUV();
    B.mark('wall');
    yield;
    B.frameFromLot(F.frame);
    for (let i = 0; i < ops.length; i++) {
      openingMasonry(ctx, face, ops[i]);
      if (i % 8 === 7) { B.mark('openings'); yield; B.frameFromLot(F.frame); }
    }
    B.mark('openings');

    // pilasters between bays (giant order over the upper floors)
    B.shade = (u, v, w, nu, nv, nw, out) => trimColor(fs, u, v, nv, out, 1.04);
    if (plan.style.pilasters && plan.floors.length > 2) {
      const v0 = plan.courses[0].y + plan.courses[0].h;
      for (const b of face.bays) if (b.index > 0) pilaster(B, sinks.smooth, b.u0, orn.pilW, orn.pilP, v0, cor.y, bev, q.lod === 0);
    }
    // plinth segments between ground-floor openings
    B.mark('pilasters');
    plinth(B, sinks, F, face, ops, orn, E, fg, fs);
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
  const ck = corniceProfile(cor.h, cor.proj, q.lod > 0);
  const cPath = mPath(cor.y + cor.h, cor.proj);
  B.sweep(sinks.smooth, ck.profile, cPath, cor.y, [true, true]);
  if (cor.dentils) dentils(B, sinks.smooth, 0.05, W - 0.05, cor.y, ck.dentil, q.dentils);
  if (orn.modillions) modillions(B, sinks.smooth, 0.25, W - 0.25, cor.y, cor.h, cor.proj, orn.modSpacing, q.modillions);
  B.mark('mouldings');

  // quoins at the street corners
  if (plan.style.quoins) {
    const v0 = plan.style.rusticGround && plan.courses.length ? plan.courses[0].y + plan.courses[0].h : Math.max(plan.ground0, plan.ground1) + orn.plinthH;
    const qh = Math.max(0.5, plan.style.courseH * 2);
    for (const e of [0, 1]) {
      const x = E[e];
      const wrap = q.lod === 0 && (x.corner || !x.nb || x.front > 0.03);
      quoins(B, sinks.smooth, W, e, v0, cor.y, qh, orn.quoin, wrap, bev);
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
    const cell = q.lod ? 6 : 1.6;
    if (!x.nb) { B.gridU(sinks.ashlar, u, vb, sideTop, -D, 0, dir, cell); continue; }
    if (x.front > 0.01) B.gridU(sinks.ashlar, u, vb, sideTop, -x.front, 0, dir, cell);
    if (x.nbBack > -D + 0.01) B.gridU(sinks.ashlar, u, vb, Math.min(sideTop, x.nbTop), -D, x.nbBack, dir, cell);
    if (x.nbTop < sideTop) B.gridU(sinks.ashlar, u, Math.max(vb, x.nbTop), sideTop, Math.max(-D, x.nbBack), Math.min(0, -x.front), dir, cell);
  }
  // back wall
  B.rectW(sinks.ashlar, 0, W, gMin - 0.35, sideTop, -D, -1);
  B.setUV();

  // ------------------------------------------------------------- parapet / roof
  B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainShade, u, v, nv, out, 1.03);
  if (flatRoof) {
    const pv = par.y, ph = par.h;
    const sideRet = (e) => (E[e].corner || !E[e].nb || E[e].nbTop < pv + ph - 0.2 || E[e].front > 0.3 ? D : 0);
    const r0 = sideRet(0), r1 = sideRet(1);
    if (par.type === 'balustrade') {
      balustrade(B, sinks.smooth, [[0, 0], [W, 0]], pv, ph, q);
      if (r0) B.sweep(sinks.smooth, parapetProfile(0.9), [[0, -D], [0, -0.3]], pv, [true, true]);
      if (r1) B.sweep(sinks.smooth, parapetProfile(0.9), [[W, -0.3], [W, -D]], pv, [true, true]);
    } else {
      const path = [];
      if (r0) path.push([0, -D]);
      path.push([0, 0], [W, 0]);
      if (r1) path.push([W, -D]);
      B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
      B.sweep(sinks.ashlar, parapetProfile(ph), path, pv, [true, true]);
      B.setUV();
      if (par.type === 'crenel') merlons(B, sinks.smooth, 0.3, W - 0.3, pv + ph, rng.range(0.9, 1.3), rng.range(0.45, 0.6), rng.range(0.35, 0.5));
    }
    // back parapet (plain)
    B.sweep(sinks.ashlar, parapetProfile(0.85), [[W, -D], [0, -D]], pv, [true, true]);
    // roof deck (grey bituminous screed), in the plaster batch
    B.shade = null; B.flat = [0.42, 0.41, 0.4];
    B.rectV(sinks.paint, 0.02, W - 0.02, -D + 0.32, -0.3, pv + 0.06, 1);
    B.flat = [1, 1, 1];
    B.mark('parapet');
    yield;
    B.frameFromLot(f);
    if (q.rooftop) rooftop(B, sinks, lot, plan, orn, pv + 0.06, q, tint);
    B.mark('rooftop');
  } else {
    B.shade = null;
    const pitch = plan.roof.pitch;
    const ov = Math.min(cor.proj * 0.55, 0.3);
    const x0 = E[0].nb && !E[0].corner ? 0 : -0.25, x1 = E[1].nb && !E[1].corner ? W : W + 0.25;
    B.flat = plan.roof.color === 'darkred' ? [0.78, 0.66, 0.64] : [1, 1, 1];
    hipRoof(B, sinks.tile, x0, x1, -D - 0.2, ov, cor.y + cor.h, pitch, q);
    B.flat = [1, 1, 1];
    B.mark('roof');
  }
  B.shade = null;
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
function plinth(B, sinks, F, face, ops, orn, E, fg, fs) {
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
      if (s0 < 0.01) { const r = ret(E[0]); if (r) path.unshift([0, -r]); }
      if (s1 > W - 0.01) { const r = ret(E[1]); if (r) path.push([W, -r]); }
    }
    B.sweep(sinks.smooth, prof, path, 0, [true, true]);
  }
}

/** Rooftop equipment from plan.rooftop, kept apart from each other, plus an optional stair head-house. */
function rooftop(B, sinks, lot, plan, orn, v0, q, tint) {
  const W = plan.width, D = plan.depth;
  const placed = [];
  const free = (u, w, r) => placed.every((p) => Math.hypot(p[0] - u, p[1] - w) > p[2] + r) && u > r + 0.4 && u < W - r - 0.4 && w < -r - 0.6 && w > -D + r + 0.6;
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
