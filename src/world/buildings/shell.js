import { RNG } from '../../core/rng.js';
import { facadePlan } from '../facadePlan.js';
import { FACES } from './mesh.js';
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
  return [su, rng.range(0, 40), sv, -g * sv];
}

const _c = [0, 0, 0];

/**
 * Generate the shell of `lot` into Builder B. ends[e] (e = 0 → u = 0 end, 1 → u = W end):
 * {corner, nb, dw, nbTop, nbDepth} in this lot's facade frame.
 */
export function generateLot(B, lot, ends, q, metas) {
  const plan = facadePlan(lot);
  const f = lot.frame, W = plan.width, D = plan.depth;
  const rng = RNG.from(lot.seed, 'shell');
  const orn = ornament(plan, rng);
  const tint = stoneTint(plan, rng);
  const uvA = ashlarUV(plan, metas.ashlar, rng);
  const rustH = metas.rough && (metas.rough.courseH ?? metas.rough.rowH ?? metas.rough.layout?.rowH);
  B.reset();
  const sinks = {
    ashlar: B.sink('ashlar'), smooth: B.sink('smooth'), rough: B.sink('rough'), dark: B.sink('plaster'), paint: B.sink('plaster'),
    tile: B.sink('tile'), membrane: B.sink('membrane'), metal: B.sink('metal'), glass: B.sink('glass'),
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
    if (x.front > 0.03) return x.front;
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
    if (plan.style.rusticGround && q.rustic && plan.courses.length) {
      const v1 = plan.courses[0].y, joints = [];
      for (let j = v1 - orn.rustH; j > fg + orn.plinthH + 0.15; j -= orn.rustH) joints.push(j);
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
    for (const o of ops) openingMasonry(ctx, face, o);

    // pilasters between bays (giant order over the upper floors)
    B.shade = (u, v, w, nu, nv, nw, out) => trimColor(fs, u, v, nv, out, 1.04);
    if (plan.style.pilasters && plan.floors.length > 2) {
      const v0 = plan.courses[0].y + plan.courses[0].h;
      for (const b of face.bays) if (b.index > 0) pilaster(B, sinks.smooth, b.u0, orn.pilW, orn.pilP, v0, cor.y, bev, q.lod === 0);
    }
    // plinth segments between ground-floor openings
    plinth(B, sinks, F, face, ops, orn, E, fg, fs);
    // dark backstop just behind the wall (hides any sub-pixel crack in the wall mesh)
    B.shade = null; B.flat = [0.03, 0.03, 0.03];
    B.rectW(sinks.dark, 0, face.width, fg - 0.35, vTop, -0.92, 1);
    B.flat = [1, 1, 1];
  }

  // ------------------------------------------------------------- mouldings around the building (main frame)
  B.frameFromLot(f);
  B.shade = (u, v, w, nu, nv, nw, out) => trimColor(mainShade, u, v, nv, out, 1.05);
  for (const c of plan.courses) {
    B.sweep(sinks.smooth, courseProfile(c.h, c.proj), mPath(c.y + c.h, c.proj), c.y, [true, true]);
  }
  const ck = corniceProfile(cor.h, cor.proj, q.lod > 0);
  const cPath = mPath(cor.y + cor.h, cor.proj);
  B.sweep(sinks.smooth, ck.profile, cPath, cor.y, [true, true]);
  if (q.dentils && cor.dentils) dentils(B, sinks.smooth, 0.05, W - 0.05, cor.y, ck.dentil);
  if (q.modillions && orn.modillions) modillions(B, sinks.smooth, 0.25, W - 0.25, cor.y, cor.h, cor.proj, orn.modSpacing);

  // quoins at the street corners
  if (plan.style.quoins) {
    const v0 = plan.style.rusticGround && plan.courses.length ? plan.courses[0].y + plan.courses[0].h : Math.max(plan.ground0, plan.ground1) + orn.plinthH;
    const qh = Math.max(0.5, plan.style.courseH * 2);
    for (const e of [0, 1]) {
      const x = E[e];
      const wrap = x.corner || !x.nb || x.front > 0.03;
      quoins(B, sinks.smooth, W, e, v0, cor.y, qh, orn.quoin, wrap, bev);
    }
  }

  // ------------------------------------------------------------- party walls (exposed sides)
  const sideTop = par.y; // top of the cornice; parapets/roofs continue above
  B.setUV(uvA[0], uvA[1], uvA[2], uvA[3]);
  B.shade = (u, v, w, nu, nv, nw, out) => plainStone(mainShade, tint, -w, v, out, 0.92);
  for (const e of [0, 1]) {
    const x = E[e];
    if (x.corner) continue;
    const u = e ? W : 0, dir = e ? 1 : -1;
    const vb = gMin - 0.35;
    if (!x.nb) { B.rectU(sinks.ashlar, u, vb, sideTop, -D, 0, dir); continue; }
    if (x.front > 0.01) B.rectU(sinks.ashlar, u, vb, sideTop, -x.front, 0, dir);
    if (x.nbBack > -D + 0.01) B.rectU(sinks.ashlar, u, vb, Math.min(sideTop, x.nbTop), -D, x.nbBack, dir);
    if (x.nbTop < sideTop) B.rectU(sinks.ashlar, u, Math.max(vb, x.nbTop), sideTop, Math.max(-D, x.nbBack), Math.min(0, -x.front), dir);
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
    // roof deck
    B.shade = null; B.flat = [0.9, 0.9, 0.9];
    B.rectV(sinks.membrane, 0.02, W - 0.02, -D + 0.32, -0.3, pv + 0.06, 1);
    B.flat = [1, 1, 1];
    if (q.rooftop) rooftop(B, sinks, lot, plan, orn, pv + 0.06, q, tint);
  } else {
    B.shade = null;
    const pitch = plan.roof.pitch;
    const ov = Math.min(cor.proj * 0.55, 0.3);
    const x0 = E[0].nb && !E[0].corner ? 0 : -0.25, x1 = E[1].nb && !E[1].corner ? W : W + 0.25;
    B.flat = plan.roof.color === 'darkred' ? [0.78, 0.66, 0.64] : [1, 1, 1];
    hipRoof(B, sinks.tile, x0, x1, -D - 0.2, ov, cor.y + cor.h, pitch, q);
    B.flat = [1, 1, 1];
  }
  B.shade = null;
  return B.finish();
}

/** Plain stone (party and back walls): tint, soft patches, darker base. */
function plainStone(fs, tint, u, v, out, k) {
  const p = noise2(u * 0.3, v * 0.25, fs.seed + 5) - 0.5;
  const hg = v - Math.min(fs.groundAt(0), fs.groundAt(fs.width));
  const a = k * (1 + 0.1 * p) * (1 - 0.2 * Math.exp(-Math.max(0, hg) / 0.4));
  out[0] = tint[0] * a; out[1] = tint[1] * a; out[2] = tint[2] * a * 0.98;
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
  B.shade = (u, v, w, nu, nv, nw, out) => { trimColor(fs, u, v, nv, out, 0.94); out[2] *= 1.03; };
  for (const [s0, s1] of segs) {
    const top = Math.max(face.groundAt(s0), face.groundAt(s1)) + orn.plinthH;
    const prof = plinthProfile(top, p, fg - 0.35);
    const path = [[s0, 0], [s1, 0]];
    if (F.main) {
      // wrap around exposed ends of the main front
      if (s0 < 0.01) { const x = E[0]; const r = x.corner ? 0 : (!x.nb ? p + 0.1 : x.front > 0.03 ? x.front : 0); if (r) path.unshift([0, -r]); }
      if (s1 > W - 0.01) { const x = E[1]; const r = x.corner ? 0 : (!x.nb ? p + 0.1 : x.front > 0.03 ? x.front : 0); if (r) path.push([W, -r]); }
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
  B.flat = [1, 1, 1];
}
