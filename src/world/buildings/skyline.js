import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { FACES } from './mesh.js';
import { FaceShade, hash3 } from './shade.js';
import { wallField } from './wall.js';
import { openingMasonry } from './openings.js';
import { openingInfill } from './infill.js';
import { plainOrnament } from './upper.js';
import { pitchedRoof, solarHeater, heaterRadius, sunYaw, waterTank, antenna, acUnit } from './roof.js';
import { MURALS } from './mural.js';
import { slabBalconies } from './balcony.js';

// Taller post-war blocks standing behind the street frontage (7–14 storeys), so the
// skyline down the street is not one even cornice line: where the street bends or a
// frontage building is low, their upper floors show above the roofs, and some close the
// vista of the street or of a side street, as in the photographs. Built like the
// frontage, with the same wall, opening and infill generators: real openings with
// reveals, sills, lintels, painted frames and glazing on all four sides, roller or
// louvred shutters on many of them, split AC units, cantilevered balconies (stacked
// bays or continuous bands with solid parapets or steel railings) with the run-off
// streaks under their slabs, a shop floor with a concrete canopy, and a flat roof with
// a parapet, a lift room, solar water heaters and tanks, or a hipped tile roof.
//
// Finishes (one per block): limestone cladding (most), ochre / yellow or orange render,
// or the white render of the 1960s blocks; weathered like the frontage (soot under the
// parapet, splash zone, streaks). A few blocks closing the view carry a large painted
// mural on their street-facing gable.

const CREAM = [0.86, 0.80, 0.68];
const STONE = [[0.86, 0.80, 0.68], [0.84, 0.74, 0.58], [0.88, 0.83, 0.74], [0.80, 0.77, 0.70], [0.87, 0.78, 0.62]];
// render colours as multipliers on the plaster albedo (≈ 0.66, 0.62, 0.54)
const RENDER = {
  ochre: [[1.3, 1.0, 0.52], [1.32, 1.08, 0.62], [1.26, 0.95, 0.5]],
  orange: [[1.36, 0.78, 0.42], [1.3, 0.72, 0.4]],
  white: [[1.13, 1.15, 1.19], [1.1, 1.11, 1.13], [1.12, 1.11, 1.08]],
};
const ROLLER = [[0.62, 0.6, 0.55], [0.5, 0.5, 0.48], [0.7, 0.7, 0.68], [0.4, 0.33, 0.27]];

/**
 * Block description in its own facade frame (same conventions as a lot frame: u along
 * the front, v up from the base, w out of the front). floorsRange: [min, max] storeys
 * above the shop floor. opts: {finish ('stone' | 'ochre' | 'orange' | 'white'), D, mural,
 * muralFace (0 front, 1 right, 2 back, 3 left)}.
 */
export function makeSlab(id, frame, rng, floorsRange = [8, 14], opts = {}) {
  const floors = rng.int(floorsRange[0], floorsRange[1]);
  const finish = opts.finish || rng.weighted([['stone', 0.6], ['ochre', 0.14], ['orange', 0.06], ['white', 0.2]]);
  const stone = finish === 'stone';
  const t = stone ? rng.pick(STONE) : rng.pick(RENDER[finish]);
  const k = rng.range(0.94, 1.04);
  const color = stone ? t.map((c, i) => Math.pow(c / CREAM[i], 1.2) * k) : t.map((c) => c * k);
  const bayW = rng.range(2.6, 3.2);
  return {
    id, frame, slab: true, finish, color,
    W: frame.width, D: opts.D ?? rng.range(12, 17), floors, floorH: rng.range(3.0, 3.25), groundH: rng.range(3.9, 4.6),
    bayW, winW: Math.min(bayW - 1.0, rng.range(1.25, 1.7)), winH: rng.range(1.35, 1.6),
    // balconies: none, stacked in some bay columns, or continuous bands across the front
    balcony: rng.weighted([['none', 0.3], ['stack', 0.45], ['bands', 0.25]]),
    solid: rng.chance(0.55),                    // solid parapets (else steel railings)
    shutters: stone || finish === 'white' ? (rng.chance(0.75) ? 'roller' : 'louvre') : (rng.chance(0.7) ? 'louvre' : 'roller'),
    roller: rng.pick(ROLLER),
    // (painted or aluminium joinery: mostly light, so the frames read from afar)
    frameColor: rng.pick(stone || finish === 'white' ? ['white', 'white', 'lightgrey', 'grey', 'brown', 'cream'] : ['darkgreen', 'brown', 'white', 'teal', 'cream']),
    shutterColor: rng.pick(['darkgreen', 'brown', 'teal', 'grey', 'white']),
    canopy: rng.chance(0.6),
    roof: floors <= 8 && rng.chance(0.3) ? 'tile' : 'flat',
    dirt: rng.range(0.7, 1.3), uncleaned: stone ? (rng.chance(0.2) ? rng.range(0.3, 0.7) : 0) : rng.range(0.15, 0.5),
    mural: opts.mural ? { face: opts.muralFace ?? 0, k: rng.int(0, MURALS - 1), u0: rng.range(0.06, 0.16), u1: rng.range(0.84, 0.94), v0: rng.range(0.22, 0.32), v1: rng.range(0.86, 0.95) } : null,
    seed: (rng.next() * 1e9) | 0,
  };
}

// opening dressing for these blocks: plain lintels and thin sills, no surrounds
const ORN = plainOrnament({
  sw: 0.16, sp: 0, ring: 0.26, shopRing: 0.45, shopRingP: 0.02, keystone: false, winHead: 'plain', shopHead: 'lintel',
  sillH: 0.06, sillP: 0.05, sillCorbels: false, ears: false, apron: false, doorSurround: false, doorHood: false,
  plinthH: 0.4, plinthP: 0.03, dirt: 1,
});

/** The four outer faces as facade frames (u to the right seen from outside, w out). */
function faceFrames(f, W, D) {
  const up = new THREE.Vector3(0, 1, 0);
  const o = f.origin, u = f.uDir, n = f.nDir;
  const mk = (origin, nDir, width) => ({ origin, uDir: new THREE.Vector3().crossVectors(up, nDir).normalize(), nDir, width });
  return [
    mk(o.clone(), n.clone(), W),
    mk(o.clone().addScaledVector(u, W), u.clone(), D),
    mk(o.clone().addScaledVector(u, W).addScaledVector(n, -D), n.clone().negate(), W),
    mk(o.clone().addScaledVector(n, -D), u.clone().negate(), D),
  ];
}

/**
 * Plan of one face k (0 front, 1 right, 2 back, 3 left): floors, bays, openings,
 * balconies, and the mural panel (front only).
 */
function facePlan(sl, k, width) {
  const r = RNG.from(sl.seed, 'face', k);
  const H = sl.groundH + sl.floors * sl.floorH;
  const floors = [{ index: 0, y: 0, h: sl.groundH }];
  for (let i = 0; i < sl.floors; i++) floors.push({ index: i + 1, y: sl.groundH + i * sl.floorH, h: sl.floorH });
  const edge = 0.7;
  const nb = Math.max(1, Math.floor((width - 2 * edge) / sl.bayW));
  const bw = (width - 2 * edge) / nb;
  const bays = [];
  for (let b = 0; b < nb; b++) bays.push({ index: b, u0: edge + b * bw, u1: edge + (b + 1) * bw, uc: edge + (b + 0.5) * bw, w: bw });
  const mural = sl.mural && k === sl.mural.face ? { u0: sl.mural.u0 * width, u1: sl.mural.u1 * width, v0: sl.groundH + sl.mural.v0 * (H - sl.groundH), v1: sl.groundH + sl.mural.v1 * (H - sl.groundH) } : null;
  const inMural = (u0, u1, v0, v1) => mural && u1 > mural.u0 - 0.3 && u0 < mural.u1 + 0.3 && v1 > mural.v0 - 0.3 && v0 < mural.v1 + 0.3;
  // balcony bays: stacked columns on the long faces, or bands across the front
  const longFace = k === 0 || k === 2;
  const bandFront = sl.balcony === 'bands' && k === 0 && !mural;
  const stackCols = new Set();
  if (sl.balcony === 'stack' && (longFace || r.chance(0.3))) for (const b of bays) if (r.chance(0.4)) stackCols.add(b.index);
  const balconies = [];
  const openings = [];
  const id = `${sl.id}:${k}`;
  // shop floor (front), or small windows / blank wall (sides and back)
  if (k === 0) {
    const door = nb > 2 ? r.int(0, nb - 1) : -1;
    for (const b of bays) {
      if (inMural(b.u0, b.u1, 0, sl.groundH)) continue;
      const isDoor = b.index === door;
      const w = isDoor ? Math.min(1.5, bw - 0.7) : bw - r.range(0.45, 0.7);
      const h = isDoor ? Math.min(2.6, sl.groundH - 1.0) : sl.groundH - r.range(0.85, 1.1);
      openings.push({ id: `${id}:g${b.index}`, floor: 0, bay: b.index, uc: b.uc, w, y: 0.03, h, top: 'flat', rise: 0, spring: 0.03 + h, kind: isDoor ? 'door' : 'shop', recess: r.range(0.2, 0.35), lit: r.range(0.6, 1) });
    }
  } else if (r.chance(0.5)) {
    for (const b of bays) {
      if (!r.chance(0.6)) continue;
      const w = Math.min(sl.winW, bw - 1), y = 1.2, h = 1.2;
      openings.push({ id: `${id}:g${b.index}`, floor: 0, bay: b.index, uc: b.uc, w, y, h, top: 'flat', rise: 0, spring: y + h, kind: 'window', recess: 0.14, shutters: 'none', lit: r.next() });
    }
  }
  // upper floors: one window per bay, stacked; balcony bays get French windows
  for (const f of floors) {
    if (f.index === 0) continue;
    const bandHere = bandFront && (f.index > 1 || r.chance(0.6));
    if (bandHere) balconies.push({ floor: f.index, u0: 0.35, u1: width - 0.35, y: f.y + 0.02, depth: r.range(1.1, 1.5), slabT: 0.16, solid: sl.solid });
    for (const b of bays) {
      const bal = bandHere || stackCols.has(b.index);
      const y = bal ? f.y + 0.05 : f.y + r.range(0.85, 0.95);
      const h = bal ? Math.min(f.h - 0.75, 2.2) : sl.winH;
      const w = bal ? Math.min(bw - 0.7, sl.winW + 0.25) : sl.winW;
      if (inMural(b.uc - w / 2, b.uc + w / 2, y, y + h)) continue;
      if (bal && !bandHere) balconies.push({ floor: f.index, u0: b.uc - Math.min(bw * 0.45, 1.35), u1: b.uc + Math.min(bw * 0.45, 1.35), y: f.y + 0.02, depth: r.range(1.0, 1.4), slabT: 0.15, solid: sl.solid });
      const hs = hash3(f.index * 31 + b.index, k + 7, sl.seed);
      // shutters on about 40 % of the windows: roller shutters part or all the way down,
      // or louvred leaves (closed, or folded back against the wall)
      let shutters = 'none', roller = 0;
      if (hs < 0.42) {
        if (sl.shutters === 'roller') { shutters = 'roller'; roller = hs < 0.12 ? 1 : 0.25 + 0.65 * hash3(b.index, f.index, sl.seed + 3); }
        else shutters = hs < 0.2 ? 'closed' : 'open';
      }
      openings.push({
        id: `${id}:f${f.index}b${b.index}`, floor: f.index, bay: b.index, uc: b.uc, w, y, h, top: 'flat', rise: 0, spring: y + h,
        kind: bal ? 'balconyDoor' : 'window', recess: r.range(0.14, 0.22), shutters, roller, lit: r.next(), curtain: r.chance(0.5),
        ac: !bal && hash3(b.index * 7 + f.index, k + 19, sl.seed) < 0.13,
      });
    }
  }
  return {
    width, floors, bays, openings, balconies, mural, courses: [], cornice: { y: H }, groundAt: () => 0,
    style: { surrounds: false, frameColor: sl.frameColor, shutterColor: sl.shutterColor },
  };
}

/** Generate one block into B (generator: yields between pieces). */
export function* slabSteps(B, sl, q0) {
  // seen from 40 m and more: no dark boxes behind the glass, no bevels or steps
  const q = { ...q0, interior: false, bevel: false, steps: false, fit: false, rustic: false, gridV: Math.max(q0.gridV, 1.6), gridU: 4 };
  B.begin();
  const stone = sl.finish === 'stone';
  const wall = stone ? B.sink('ashlar') : B.sink('plaster');
  const sinks = {
    ashlar: wall, rough: null,
    smooth: stone ? B.sink('smooth') : wall,           // reveals
    detail: stone ? B.sink('smoothD') : wall,          // sills and lintels
    dark: B.sink('plaster'), paint: B.sink('plaster'), frame: B.sink('plaster'),
    metal: B.sink('dark'), glass: B.sink('glass'), tile: B.sink('tile'),
  };
  const W = sl.W, D = sl.D, H = sl.groundH + sl.floors * sl.floorH;
  const col = sl.color;
  const frames = faceFrames(sl.frame, W, D);
  const uvOff = (sl.seed % 97) * 0.37;
  let frontShade = null;
  for (let k = 0; k < 4; k++) {
    const fr = frames[k];
    const face = facePlan(sl, k, fr.width);
    const fs = new FaceShade(face, col, sl.seed + 977 * k, { dirt: sl.dirt, uncleaned: sl.uncleaned, sillExt: 0.11, sillH: 0.06 });
    if (!k) frontShade = fs;
    const ctx = { B, sinks, q, fs, orn: ORN, vBottom: -2, vTop: H, rustic: null, sillExt: 0.11, ch: 0, fit: null, filled: false, rollerCol: sl.roller };
    B.frameFromLot(fr);
    B.setUV(1, uvOff + k * 3.1, 1, 0);
    // the mural panel is left out of the wall (it is its own surface)
    const holes = face.mural
      ? [...face.openings, { uc: (face.mural.u0 + face.mural.u1) / 2, w: face.mural.u1 - face.mural.u0, y: face.mural.v0, h: face.mural.v1 - face.mural.v0, top: 'flat', rise: 0, spring: face.mural.v1 }]
      : face.openings;
    yield* wallField(ctx, face, holes);
    B.setUV();
    B.frameFromLot(fr);
    const irng = RNG.from(sl.seed, 'infill', k);
    for (let i = 0; i < face.openings.length; i++) {
      const o = face.openings[i];
      openingMasonry(ctx, face, o);
      openingInfill(ctx, face, o, irng);
      if (o.ac) {
        B.enter(o.uc + (hash3(i, k, sl.seed) < 0.5 ? -0.25 : 0.25), o.y - 0.95, 0.17, 0);
        acUnit(B, { paint: sinks.paint, metal: sinks.metal }, q, RNG.from(sl.seed, 'ac', k, i));
        B.popFrame();
      }
      if (i % 4 === 3) { yield; B.frameFromLot(fr); }
    }
    B.shade = null;
    yield;
    B.frameFromLot(fr);
    yield* slabBalconies(B, sinks, face.balconies, fs, sl.seed, q, fr);
    if (face.mural) muralPanel(B, face.mural, sl.mural.k);
    if (!k && sl.canopy && q.lod === 0) {
      // concrete canopy over the shop floor (its shadow line marks the base of the block)
      B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); const s = nv < -0.5 ? 0.7 : 1.02; out[0] *= s; out[1] *= s; out[2] *= s; };
      const cu0 = 0.3, cu1 = fr.width - 0.3;
      B.box(sinks.detail, cu0, cu1, sl.groundH - 0.5, sl.groundH - 0.32, 0, 1.3, FACES.FRONT | FACES.TOP | FACES.BOTTOM | FACES.LEFT | FACES.RIGHT);
      B.shade = null;
    }
    B.flat = [1, 1, 1];
    yield;
  }
  // roof
  B.frameFromLot(sl.frame);
  if (sl.roof === 'tile') {
    B.shade = (u, v, w, nu, nv, nw, out) => frontShade.wall(u, v, out);
    // eaves band
    B.box(sinks.detail, -0.1, W + 0.1, H - 0.3, H, -D - 0.1, 0.1, FACES.FRONT | FACES.BACK | FACES.LEFT | FACES.RIGHT | FACES.BOTTOM);
    B.shade = null;
    B.flat = [1, 1, 1];
    pitchedRoof(B, sinks, {
      W, v0: H, pitch: 22 + (sl.seed % 9), front: 0.55, back: -D - 0.55,
      ends: [{ dir: [0, -1], hip: true, over: 0.55 }, { dir: [0, -1], hip: true, over: 0.55 }], wallBack: [[0, -D], [W, -D]],
    }, q);
    B.flat = [1, 1, 1];
    return;
  }
  yield* flatRoof(B, sinks, sl, q, frontShade, H);
}

/** The painted panel (uv 0..1 over it), flush with the wall it replaces. */
function muralPanel(B, m, k) {
  const s = B.sink(`mural${k}`);
  B.shade = null;
  B.flat = [1, 1, 1];
  s.reserve(4, 6);
  const a = B.v(s, m.u0, m.v0, 0, 0, 0, 1, 0, 0), b = B.v(s, m.u1, m.v0, 0, 0, 0, 1, 1, 0);
  const c = B.v(s, m.u1, m.v1, 0, 0, 0, 1, 1, 1), d = B.v(s, m.u0, m.v1, 0, 0, 0, 1, 0, 1);
  B.quadIdx(s, a, b, c, d);
}

/** Flat roof: parapet with a coping, membrane deck, lift room, heaters, tanks, a mast. */
function* flatRoof(B, sinks, sl, q, fs, H) {
  const W = sl.W, D = sl.D, ph = 1.0, t = 0.22;
  B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u, v, out); if (nv > 0.5) { out[0] *= 1.04; out[1] *= 1.04; out[2] *= 1.04; } };
  const sW = sinks.ashlar;
  B.box(sW, 0, W, H, H + ph, -t, 0, FACES.FRONT | FACES.BACK | FACES.TOP);
  B.box(sW, 0, W, H, H + ph, -D, -D + t, FACES.FRONT | FACES.BACK | FACES.TOP);
  B.box(sW, 0, t, H, H + ph, -D + t, -t, FACES.LEFT | FACES.RIGHT | FACES.TOP);
  B.box(sW, W - t, W, H, H + ph, -D + t, -t, FACES.LEFT | FACES.RIGHT | FACES.TOP);
  // coping, a little proud of the wall
  B.box(sinks.detail, -0.04, W + 0.04, H + ph, H + ph + 0.06, -D - 0.04, 0.04, FACES.FRONT | FACES.BACK | FACES.LEFT | FACES.RIGHT | FACES.BOTTOM);
  B.shade = null;
  B.flat = [0.36, 0.35, 0.34];
  B.rectV(sinks.dark, 0, W, -D, 0, H + 0.02, 1);
  yield;
  B.frameFromLot(sl.frame);
  const r = RNG.from(sl.seed, 'roof');
  // lift and stair room
  const lu = r.range(0.3, 0.6) * W, lw = -r.range(0.4, 0.6) * D, lh = r.range(2.8, 3.4);
  B.shade = (u, v, w, nu, nv, nw, out) => { fs.wall(u * 0.7, v, out); out[0] *= 0.97; out[1] *= 0.97; out[2] *= 0.97; };
  B.box(sW, lu - 1.7, lu + 1.7, H, H + lh, lw - 2.3, lw + 2.3, FACES.ALL & ~FACES.BOTTOM);
  B.shade = null;
  B.flat = sl.color.map((c) => c * 0.9);
  B.box(sinks.paint, lu - 1.8, lu + 1.8, H + lh, H + lh + 0.12, lw - 2.4, lw + 2.4, FACES.ALL);
  const placed = [[lu, lw, 2.9]];
  const free = (u, w, rr) => u - rr > 0.5 && u + rr < W - 0.5 && w + rr < -0.5 && w - rr > -D + 0.5 && placed.every((p) => Math.hypot(p[0] - u, p[1] - w) > p[2] + rr);
  // solar water heaters in rows (one per flat; the city's characteristic roofline)
  const yawSun = sunYaw(sl.frame), R2 = heaterRadius(2);
  const nMax = q.lod ? 5 : 14;
  let n = 0;
  const sinksH = { ...sinks, paint: sinks.metal, frame: sinks.metal, glass: q.lod ? null : sinks.glass };
  for (let w = -0.9 - R2; w > -D + R2 + 0.6 && n < nMax; w -= r.range(2.8, 3.3)) {
    for (let u = R2 + 0.7 + r.range(0, 0.6); u < W - R2 - 0.7 && n < nMax; u += r.range(2.3, 2.8)) {
      if (!free(u, w, R2) || r.chance(0.2)) continue;
      placed.push([u, w, R2]);
      const hr = RNG.from(sl.seed, 'heater', n++);
      B.enter(u, H + 0.02, w, yawSun + hr.range(-0.1, 0.1));
      solarHeater(B, sinksH, 0, q, hr, hr.chance(0.5) ? hr.range(0.4, 1.1) : 0, 2);
      B.popFrame();
      if (n % 3 === 0) { yield; B.frameFromLot(sl.frame); }
    }
  }
  B.frameFromLot(sl.frame);
  for (let i = 0; i < 3; i++) {
    const tr = RNG.from(sl.seed, 'tank', i);
    const u = tr.range(1.5, W - 1.5), w = -tr.range(1.5, D - 1.5);
    if (!free(u, w, 0.8)) continue;
    placed.push([u, w, 0.8]);
    B.enter(u, H + 0.02, w, tr.range(0, 3));
    if (i < 2) waterTank(B, sinks, q, tr); else antenna(B, sinks, q, tr);
    B.popFrame();
  }
  B.flat = [1, 1, 1];
}
