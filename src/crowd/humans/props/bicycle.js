import * as THREE from 'three';
import { Builder, PIECE, CH, V, roundRect, M4, alongY, lin, smooth, curveOf, segsFor } from './geo.js';
import { spokeUv } from './shading.js';

// Bicycles at true scale, built procedurally from a geometry spec (frame angles, tube
// diameters, wheel / tyre sizes, drivetrain) into one merged geometry per variant and LOD.
//
// Prop-local frame: metres, origin on the ground directly below the bottom bracket, +Y up,
// -Z forward (the travel direction, like a figure with heading 0), +X to the rider's right
// (drive side). Animated pieces (see geo.js PIECE): front wheel (spins + steers), fork / bars /
// basket / front lamp (steer about the head-tube axis), rear wheel, crankset (about the
// bottom bracket), pedals (orbit with the cranks, stay level), saddle + seat post (slide
// along the seat tube), kickstand (down when parked).
//
// Crank angle 0 = right crank pointing straight up; it increases with forward pedalling.
// Steer > 0 turns the front wheel to the left. Wheel angle increases rolling forward
// (angle = distance / wheel radius).

const D2R = Math.PI / 180;

// ------------------------------------------------------------------ materials (linear albedo)
const M = {
  paintA: { col: [1, 1, 1], rough: 0.26, metal: 0, ch: CH.PAINT_A, w: 1 },
  paintB: { col: [1, 1, 1], rough: 0.3, metal: 0, ch: CH.PAINT_B, w: 1 },
  chrome: { col: [0.9, 0.9, 0.91], rough: 0.08, metal: 1, ch: CH.PLAIN, w: 0 },
  alloy: { col: [0.82, 0.83, 0.84], rough: 0.3, metal: 1, ch: CH.PLAIN, w: 0 },
  alloyPolish: { col: [0.88, 0.88, 0.88], rough: 0.16, metal: 1, ch: CH.PLAIN, w: 0 },
  steel: { col: [0.58, 0.58, 0.6], rough: 0.34, metal: 1, ch: CH.PLAIN, w: 0 },
  spoke: { col: [0.72, 0.72, 0.74], rough: 0.26, metal: 1, ch: CH.PLAIN, w: 0 },
  anodBlack: { col: [0.03, 0.03, 0.032], rough: 0.36, metal: 0, ch: CH.PLAIN, w: 0 },
  plastic: { col: [0.022, 0.022, 0.024], rough: 0.5, metal: 0, ch: CH.PLAIN, w: 0 },
  plasticGloss: { col: [0.02, 0.02, 0.022], rough: 0.22, metal: 0, ch: CH.PLAIN, w: 0 },
  rubber: { col: [0.026, 0.026, 0.026], rough: 0.8, metal: 0, ch: CH.PLAIN, w: 0 },
  tyreWall: { col: [0.028, 0.028, 0.028], rough: 0.72, metal: 0, ch: CH.PLAIN, w: 0 },
  tanWall: { col: lin('#b58a5b'), rough: 0.7, metal: 0, ch: CH.PLAIN, w: 0 },
  stripe: { col: [0.26, 0.26, 0.26], rough: 0.45, metal: 0, ch: CH.PLAIN, w: 0 },
  chain: { col: [0.3, 0.29, 0.28], rough: 0.45, metal: 0.85, ch: CH.PLAIN, w: 0 },
  spokeCone: { col: [0.62, 0.62, 0.64], rough: 0.32, metal: 0.85, ch: CH.SPOKES, w: 0 },
  spokeConeBlack: { col: [0.05, 0.05, 0.05], rough: 0.35, metal: 0.4, ch: CH.SPOKES, w: 0 },
  leatherBrown: { col: lin('#5a3720'), rough: 0.5, metal: 0, ch: CH.LEATHER, w: 0 },
  leatherBlack: { col: [0.024, 0.022, 0.021], rough: 0.46, metal: 0, ch: CH.LEATHER, w: 0 },
  gripBlack: { col: [0.028, 0.028, 0.028], rough: 0.7, metal: 0, ch: CH.LEATHER, w: 0 },
  tape: { col: [0.03, 0.03, 0.03], rough: 0.6, metal: 0, ch: CH.LEATHER, w: 0 },
  reflRed: { col: [0.45, 0.012, 0.01], rough: 0.2, metal: 0, ch: CH.REFLECT, w: 0 },
  reflAmber: { col: [0.6, 0.25, 0.01], rough: 0.2, metal: 0, ch: CH.REFLECT, w: 0 },
  lens: { col: [0.7, 0.7, 0.68], rough: 0.04, metal: 0.6, ch: CH.PLAIN, w: 0 },
  wire: { col: [0.04, 0.04, 0.042], rough: 0.4, metal: 0, ch: CH.PLAIN, w: 0 },
  mesh: { col: [0.04, 0.04, 0.042], rough: 0.4, metal: 0, ch: CH.MESH, w: 0.11 },
  meshSilver: { col: [0.6, 0.6, 0.62], rough: 0.3, metal: 1, ch: CH.MESH, w: 0.1 },
  battery: { col: [0.035, 0.036, 0.038], rough: 0.32, metal: 0, ch: CH.PLAIN, w: 0 },
  brass: { col: lin('#b89b5e'), rough: 0.3, metal: 1, ch: CH.PLAIN, w: 0 },
};

// ------------------------------------------------------------------ variant specs
const CITY_PAINT = ['#1f2d24', '#141618', '#24324c', '#e6dfcc', '#5a1f25', '#9cc6b9', '#7fa3c0', '#c7c0b0', '#3b4043', '#9c3b2d', '#ecebe6', '#cfa94f', '#2f4f4a'];
const DUTCH_PAINT = ['#101112', '#131415', '#17191b', '#262b36', '#3a2720', '#14211a', '#2b2b2b'];
const ROAD_PAINT = ['#f1f1ee', '#121315', '#b51d22', '#1c4d96', '#9ca2a7', '#dcae1f', '#23272b', '#2a6b58', '#d2d6d9'];
const HYBRID_PAINT = ['#2c3135', '#526870', '#1c1e21', '#87969f', '#384a3d', '#682b2b', '#d9d9d3', '#33415a'];
const KIDS_PAINT = ['#e0457a', '#7848c0', '#d4252e', '#2870c6', '#74bd40', '#1fb0ad', '#ef951c', '#1b1b1b', '#f2f2f2'];
const EBIKE_PAINT = ['#d7d9d9', '#2e3336', '#141719', '#2b3d56', '#8a988c', '#686d71', '#b6afa2', '#3b3f3a'];

export const BIKE_SPECS = [
  {
    id: 'city', label: 'city step-through', rider: [1.5, 1.95], adult: true,
    wheel: { bead: 0.311, tyreW: 0.042, tyreH: 0.038, tread: 1, wall: 'stripe', rimW: 0.022, rimDepth: 0.017, rim: 'alloy',
      cell: 0, perSide: 18, cross: 3, hubF: 'dynamo', hubR: 'igh', flangeR: [0.023, 0.046], flangeX: [0.034, 0.03], old: [0.1, 0.135] },
    frame: { type: 'step', bbDrop: 0.07, cs: 0.465, wb: 1.13, ha: 68.5, sa: 70, offset: 0.05, forkLen: 0.395, htLen: 0.2, stLen: 0.5,
      forkType: 'curved', r: { ht: 0.0185, dt: 0.019, tt: 0.0143, st: 0.0159, cs: 0.0095, ss: 0.0085, blade: [0.0125, 0.0085] } },
    saddleH: 0.965, saddle: 'sprung', saddleMat: 'leatherBrown',
    bar: { type: 'swept', h: 1.075, width: 0.58, sweep: 0.19 }, grips: 'leatherBrown', levers: 'city',
    crank: 0.17, ring: 38, cog: 18, chainline: 0.047,
    extras: { fenders: true, guard: 'half', rack: true, basket: 'wire', stand: true, lightF: 'crown', lightR: 'fender', bell: true, brakes: 'roller' },
    paints: CITY_PAINT, finishes: [0, 0, 3, 1], accent: ['same', 'same', 'black', 'cream', 'silver'], gear: 38 / 18,
  },
  {
    id: 'dutch', label: 'classic twin-tube roadster', rider: [1.55, 1.95], adult: true,
    wheel: { bead: 0.311, tyreW: 0.044, tyreH: 0.04, tread: 1, wall: 'black', rimW: 0.022, rimDepth: 0.018, rim: 'black',
      cell: 0, perSide: 18, cross: 3, hubF: 'std', hubR: 'igh', flangeR: [0.022, 0.046], flangeX: [0.035, 0.03], old: [0.1, 0.135] },
    frame: { type: 'twin', bbDrop: 0.07, cs: 0.47, wb: 1.16, ha: 67, sa: 68.5, offset: 0.055, forkLen: 0.4, htLen: 0.23, stLen: 0.5,
      forkType: 'curved', r: { ht: 0.0185, dt: 0.0159, tt: 0.0127, st: 0.0159, cs: 0.0095, ss: 0.0085, blade: [0.0125, 0.0085] } },
    saddleH: 0.975, saddle: 'sprung', saddleMat: 'leatherBlack',
    bar: { type: 'swept', h: 1.1, width: 0.6, sweep: 0.22 }, grips: 'leatherBlack', levers: 'city',
    crank: 0.17, ring: 38, cog: 20, chainline: 0.047,
    extras: { fenders: true, guard: 'full', rack: true, basket: null, stand: true, lightF: 'crown', lightR: 'fender', bell: true, brakes: 'roller' },
    paints: DUTCH_PAINT, finishes: [0, 0, 2, 3], accent: ['same', 'same', 'same', 'black'], gear: 38 / 20,
  },
  {
    id: 'road', label: 'road bike', rider: [1.6, 1.95], adult: true,
    wheel: { bead: 0.311, tyreW: 0.027, tyreH: 0.025, tread: 0, wall: 'black', rimW: 0.02, rimDepth: 0.03, rim: 'black',
      cell: 2, perSide: 12, cross: 2, hubF: 'std', hubR: 'cassette', flangeR: [0.019, 0.024], flangeX: [0.034, 0.027], old: [0.1, 0.13] },
    frame: { type: 'diamond', slope: 0.07, bbDrop: 0.072, cs: 0.41, wb: 0.99, ha: 72.5, sa: 73.5, offset: 0.045, forkLen: 0.37, htLen: 0.155, stLen: 0.52,
      forkType: 'straight', r: { ht: 0.021, dt: 0.0225, tt: 0.0175, st: 0.0165, cs: 0.011, ss: 0.0085, blade: [0.016, 0.0075] } },
    saddleH: 1.0, saddle: 'road', saddleMat: 'leatherBlack',
    bar: { type: 'drop', h: 0.95, width: 0.42 }, grips: 'tape', levers: 'road',
    crank: 0.1725, ring: 50, cog: 17, chainline: 0.0435,
    extras: { fenders: false, guard: null, rack: false, basket: null, stand: false, lightF: null, lightR: 'post', bell: false, brakes: 'caliper', bottle: true, derailleur: true },
    paints: ROAD_PAINT, finishes: [0, 1, 2, 1], accent: ['same', 'black'], gear: 50 / 21,
  },
  {
    id: 'hybrid', label: 'hybrid / trekking bike', rider: [1.55, 1.95], adult: true,
    wheel: { bead: 0.311, tyreW: 0.036, tyreH: 0.034, tread: 2, wall: 'black', rimW: 0.021, rimDepth: 0.02, rim: 'black',
      cell: 1, perSide: 16, cross: 3, hubF: 'std', hubR: 'cassette', flangeR: [0.02, 0.026], flangeX: [0.035, 0.03], old: [0.1, 0.135] },
    frame: { type: 'diamond', slope: 0.11, bbDrop: 0.065, cs: 0.445, wb: 1.07, ha: 70, sa: 72, offset: 0.047, forkLen: 0.39, htLen: 0.17, stLen: 0.5,
      forkType: 'straight', r: { ht: 0.021, dt: 0.0205, tt: 0.0175, st: 0.0159, cs: 0.0105, ss: 0.0085, blade: [0.014, 0.0085] } },
    saddleH: 0.99, saddle: 'comfort', saddleMat: 'leatherBlack',
    bar: { type: 'flat', h: 1.02, width: 0.62 }, grips: 'gripBlack', levers: 'flat',
    crank: 0.17, ring: 42, cog: 18, chainline: 0.047,
    extras: { fenders: true, fenderMat: 'plastic', guard: null, rack: false, basket: null, stand: true, lightF: null, lightR: 'post', bell: true, brakes: 'v', derailleur: true, bottle: true },
    paints: HYBRID_PAINT, finishes: [2, 3, 0, 1], accent: ['black'], gear: 42 / 20,
  },
  {
    id: 'kids', label: 'kids bike (20 in)', rider: [1.05, 1.5], adult: false,
    wheel: { bead: 0.2015, tyreW: 0.046, tyreH: 0.043, tread: 2, wall: 'black', rimW: 0.022, rimDepth: 0.015, rim: 'alloy',
      cell: 1, perSide: 14, cross: 2, hubF: 'std', hubR: 'coaster', flangeR: [0.019, 0.026], flangeX: [0.03, 0.03], old: [0.1, 0.11] },
    frame: { type: 'kids', bbDrop: 0.03, cs: 0.36, wb: 0.83, ha: 68, sa: 70, offset: 0.035, forkLen: 0.29, htLen: 0.12, stLen: 0.3,
      forkType: 'straight', r: { ht: 0.0175, dt: 0.0165, tt: 0.0143, st: 0.0143, cs: 0.0085, ss: 0.0075, blade: [0.0105, 0.0078] } },
    saddleH: 0.67, saddle: 'kids', saddleMat: 'leatherBlack',
    bar: { type: 'riser', h: 0.8, width: 0.5, rise: 0.06 }, grips: 'gripBlack', levers: 'flat',
    crank: 0.127, ring: 32, cog: 16, chainline: 0.045,
    extras: { fenders: true, fenderMat: 'paintB', guard: 'kids', rack: false, basket: null, stand: true, lightF: null, lightR: 'post', bell: true, brakes: 'v' },
    paints: KIDS_PAINT, finishes: [0, 0, 1], accent: ['white', 'black', 'same'], gear: 32 / 16,
  },
  {
    id: 'ebike', label: 'electric city bike', rider: [1.55, 1.95], adult: true,
    wheel: { bead: 0.311, tyreW: 0.047, tyreH: 0.043, tread: 1, wall: 'stripe', rimW: 0.025, rimDepth: 0.02, rim: 'black',
      cell: 0, perSide: 18, cross: 2, hubF: 'std', hubR: 'igh', flangeR: [0.022, 0.044], flangeX: [0.035, 0.03], old: [0.1, 0.135] },
    frame: { type: 'low', bbDrop: 0.065, cs: 0.47, wb: 1.15, ha: 69, sa: 70, offset: 0.05, forkLen: 0.43, htLen: 0.18, stLen: 0.47,
      forkType: 'susp', r: { ht: 0.024, dt: 0.031, tt: 0.016, st: 0.0175, cs: 0.011, ss: 0.0095, blade: [0.016, 0.016] } },
    saddleH: 0.975, saddle: 'comfort', saddleMat: 'leatherBlack',
    bar: { type: 'riser', h: 1.09, width: 0.62, rise: 0.04, sweep: 0.06 }, grips: 'gripBlack', levers: 'flat',
    crank: 0.17, ring: 38, cog: 20, chainline: 0.05,
    extras: { fenders: true, fenderMat: 'plastic', guard: 'half', rack: true, basket: null, stand: true, lightF: 'bar', lightR: 'rack', bell: true, brakes: 'disc', motor: 'mid', battery: 'down', display: true },
    paints: EBIKE_PAINT, finishes: [2, 3, 0, 2], accent: ['black'], gear: 38 / 20,
  },
];

// ------------------------------------------------------------------ geometry layout from a spec

/** Key points of a bike spec (prop-local metres). */
export function bikeLayout(spec) {
  const W = spec.wheel, F = spec.frame;
  const R = W.bead + W.tyreH;
  const bb = V(0, R - F.bbDrop, 0);
  const zr = Math.sqrt(F.cs * F.cs - F.bbDrop * F.bbDrop);
  const hubR = V(0, R, zr), hubF = V(0, R, zr - F.wb);
  const ha = F.ha * D2R, sa = F.sa * D2R;
  const axis = V(0, Math.sin(ha), Math.cos(ha));           // steering axis, pointing up and back
  const fwd = V(0, Math.cos(ha), -Math.sin(ha));           // perpendicular, forward
  const p0 = hubF.clone().addScaledVector(fwd, -F.offset);  // axis point level with the hub (closest)
  const crown = p0.clone().addScaledVector(axis, F.forkLen);
  const htBot = crown.clone().addScaledVector(axis, 0.014);
  const htTop = htBot.clone().addScaledVector(axis, F.htLen);
  const seatDir = V(0, Math.sin(sa), Math.cos(sa));
  const stTop = bb.clone().addScaledVector(seatDir, F.stLen);
  // saddle: rails clamp where the saddle top reaches saddleH
  const saddleT = spec.saddle === 'sprung' ? 0.085 : spec.saddle === 'kids' ? 0.06 : 0.055;
  const clamp = bb.clone().addScaledVector(seatDir, (spec.saddleH - saddleT - bb.y) / seatDir.y);
  // axis point (y, z) used by the steering pieces: the axis passes through p0
  const steerAux = [p0.y, p0.z, ha, 0];
  return { R, bb, zr, hubR, hubF, ha, sa, axis, fwd, p0, crown, htBot, htTop, seatDir, stTop, clamp, saddleT, steerAux };
}

/** Point on the steering axis at height y. */
function axisAtY(L, y) { return L.p0.clone().addScaledVector(L.axis, (y - L.p0.y) / L.axis.y); }

// ------------------------------------------------------------------ LOD settings
const LODS = [
  { tube: (r) => Math.max(8, Math.min(16, Math.round(r * 900))), small: 6, wheelSeg: 72, tyreProf: 9, spokes: 'geo', chain: 'links', step: 0.12, saddle: [16, 14], detail: 2 },
  { tube: (r) => Math.max(6, Math.min(9, Math.round(r * 520))), small: 4, wheelSeg: 40, tyreProf: 6, spokes: 'cone', chain: 'smooth', step: 0.22, saddle: [10, 9], detail: 1 },
  { tube: (r) => (r > 0.012 ? 5 : 4), small: 3, wheelSeg: 18, tyreProf: 4, spokes: 'cone', chain: 'strip', step: 0.5, saddle: [6, 6], detail: 0 },
];

// ------------------------------------------------------------------ builders

/** Build one bicycle variant at one LOD. Returns {geometry, layout}. */
export function buildBicycle(spec, lod = 0) {
  const L = bikeLayout(spec);
  const Q = LODS[lod];
  const b = new Builder();
  const ctx = { b, spec, L, Q, lod };
  frame(ctx);
  fork(ctx);
  cockpit(ctx);
  wheels(ctx);
  drivetrain(ctx);
  seat(ctx);
  extras(ctx);
  const geometry = b.build();
  geometry.name = `bike.${spec.id}.lod${lod}`;
  return { geometry, layout: L };
}

function tubeSeg(ctx, r) { return ctx.Q.tube(r); }

/** Frame tube between points (curve through pts) with flared welded ends (fillets at the joints). */
function ftube(ctx, pts, r, { flare = [0.12, 0.12], caps = null, mat = M.paintA, r1 = null } = {}) {
  const { b, lod } = ctx;
  const curve = curveOf(pts);
  const len = curve.getLength();
  const fl = Math.min(0.3, 0.024 / Math.max(len, 0.05));
  const f0 = lod < 2 ? flare[0] : 0, f1 = lod < 2 ? flare[1] : 0;
  const rf = (t) => {
    const base = r1 === null ? r : r + (r1 - r) * t;
    return base * (1 + f0 * (1 - smooth(0, fl, t)) + f1 * smooth(1 - fl, 1, t));
  };
  const nBody = pts.length > 2 ? segsFor(curve, [0.1, 0.22, 0.45][lod], [0.12, 0.3, 1][lod]) : Math.max(1, Math.ceil(len / [0.15, 0.4, 2][lod]));
  const set = new Set();
  for (let i = 0; i <= nBody; i++) set.add(i / nBody);
  if (f0) for (const k of [0.3, 0.6, 1]) set.add(fl * k);
  if (f1) for (const k of [0.3, 0.6, 1]) set.add(1 - fl * k);
  const ts = [...set].sort((x, y) => x - y);
  b.with(mat, () => b.tube(pts, rf, tubeSeg(ctx, r), { ts, caps, N0: V(1, 0, 0) }));
}

function frame(ctx) {
  const { b, spec, L } = ctx;
  const F = spec.frame, r = F.r;
  const { bb, hubR, htBot, htTop, seatDir, stTop, axis } = L;
  const oldR = spec.wheel.old[1] / 2;
  // head tube with headset cups
  b.with(M.paintA, () => b.tube([htBot, htTop], r.ht, tubeSeg(ctx, r.ht), { n: 3 }));
  b.with(M.anodBlack, () => {
    b.tube([htTop, htTop.clone().addScaledVector(axis, 0.016)], r.ht * 1.08, tubeSeg(ctx, r.ht), { n: 1, caps: [null, 'flat'] });
    b.tube([htBot.clone().addScaledVector(axis, -0.012), htBot], r.ht * 1.1, tubeSeg(ctx, r.ht), { n: 1, caps: ['flat', null] });
  });
  // bottom bracket shell
  b.with(M.paintA, () => b.tube([V(-0.034, bb.y, 0), V(0.034, bb.y, 0)], 0.021, tubeSeg(ctx, 0.021), { n: 1, caps: 'flat' }));
  // seat tube (+ clamp collar)
  const stBot = bb.clone().addScaledVector(seatDir, -0.005);
  ftube(ctx, [stBot, stTop], r.st, { flare: [0.18, 0] });
  b.with(M.alloy, () => b.tube([stTop.clone().addScaledVector(seatDir, -0.03), stTop.clone().addScaledVector(seatDir, 0.004)], r.st * 1.18, tubeSeg(ctx, r.st), { n: 1, caps: [null, 'flat'] }));
  const htAt = (t) => htBot.clone().addScaledVector(axis, t * spec.frame.htLen);
  if (F.type === 'diamond' || F.type === 'kids') {
    const ttFront = htAt(F.type === 'kids' ? 0.62 : 0.86);
    const ttRear = stTop.clone().addScaledVector(seatDir, F.type === 'kids' ? -0.11 : -0.035);
    if (F.type === 'kids') {
      // low, slightly curved top tube
      const mid = ttFront.clone().lerp(ttRear, 0.5).add(V(0, -0.03, 0));
      ftube(ctx, [ttFront, mid, ttRear], r.tt);
    } else ftube(ctx, [ttFront, ttRear], r.tt);
    const dtFront = htAt(0.18);
    ftube(ctx, [dtFront, bb.clone().add(V(0, 0.012, -0.012))], r.dt, { flare: [0.1, 0.15] });
  } else if (F.type === 'step' || F.type === 'twin') {
    // one long curved down tube sweeping low into the seat tube just above the bottom bracket
    const a = htAt(0.32);
    const lowY = bb.y + 0.2;
    const p1 = V(0, a.y - 0.2, a.z + 0.13);
    const p2 = V(0, lowY + 0.02, bb.z - 0.2);
    const end = bb.clone().addScaledVector(seatDir, 0.09);
    ftube(ctx, [a, p1, p2, end], r.dt, { flare: [0.1, 0.2] });
    if (F.type === 'twin') {
      // classic roadster: a second, thinner parallel tube from the top of the head tube to the seat tube
      const a2 = htAt(0.85);
      const q1 = V(0, a2.y - 0.17, a2.z + 0.15);
      const q2 = V(0, bb.y + 0.39, bb.z - 0.13);
      const end2 = bb.clone().addScaledVector(seatDir, 0.33);
      ftube(ctx, [a2, q1, q2, end2], r.tt, { flare: [0.12, 0.2] });
    } else {
      // short gusset tube reinforcing the low junction
      ftube(ctx, [V(0, bb.y + 0.03, bb.z - 0.13), bb.clone().add(V(0, 0.01, -0.015))], r.dt * 0.85, { flare: [0, 0.2] });
    }
  } else if (F.type === 'low') {
    // e-bike low step: one fat hydroformed tube from the head tube into the motor
    const a = htAt(0.3);
    const p1 = V(0, a.y - 0.24, a.z + 0.13);
    const p2 = V(0, bb.y + 0.12, bb.z - 0.19);
    const end = bb.clone().add(V(0, 0.02, -0.02));
    ftube(ctx, [a, p1, p2, end], r.dt, { flare: [0.1, 0.1] });
    ctx.downPath = [a, p1, p2, end];
  }
  if (F.type === 'step' || F.type === 'twin') ctx.downPath = null;
  // chainstays (both sides) and seat stays
  for (const sx of [-1, 1]) {
    const drop = V(sx * (oldR - 0.006), hubR.y, hubR.z);
    const cs0 = V(sx * 0.028, bb.y + 0.004, bb.z + 0.028);
    const csMid = V(sx * (oldR - 0.012), (bb.y + hubR.y) / 2 + 0.004, (bb.z + hubR.z) / 2 + 0.06);
    ftube(ctx, [cs0, csMid, drop.clone().add(V(0, -0.004, -0.01))], r.cs, { flare: [0.15, 0], r1: r.cs * 0.75 });
    const ss0 = stTop.clone().addScaledVector(seatDir, -0.045).add(V(sx * 0.016, 0, 0.012));
    ftube(ctx, [ss0, drop.clone().add(V(0, 0.008, -0.002))], r.ss, { flare: [0.15, 0], r1: r.ss * 0.82 });
    // dropout plate
    b.with(M.paintA, () => b.rbox(0.003, 0.022, 0.026, 0.0028, M4([drop.x, drop.y - 0.002, drop.z - 0.004], [-0.5, 0, 0]), ctx.lod ? 1 : 2));
  }
  // brake bridge between the seat stays, chainstay bridge
  const brY = stTop.y - 0.16;
  const ssAt = (sx, y) => {
    const a = stTop.clone().addScaledVector(seatDir, -0.045).add(V(sx * 0.016, 0, 0.012));
    const d = V(sx * (oldR - 0.006), hubR.y + 0.008, hubR.z - 0.002);
    const t = (a.y - y) / (a.y - d.y);
    return a.lerp(d, t);
  };
  if (ctx.lod < 2) {
    ftube(ctx, [ssAt(-1, brY), ssAt(1, brY)], 0.006, { flare: [0, 0] });
    ftube(ctx, [V(-0.034, bb.y + 0.03, bb.z + 0.16), V(0.034, bb.y + 0.03, bb.z + 0.16)], 0.0065, { flare: [0, 0] });
  }
  ctx.ssAt = ssAt;
}

function fork(ctx) {
  const { b, spec, L, lod } = ctx;
  const r = spec.frame.r;
  const { hubF, crown, axis, htTop, steerAux } = L;
  const halfF = spec.wheel.old[0] / 2;
  b.with({ piece: PIECE.STEER, aux: steerAux }, () => {
    // crown
    const cm = alongY(crown.clone().addScaledVector(axis, -0.012), crown.clone().addScaledVector(axis, 0.02));
    const crownMat = spec.frame.forkType === 'susp' ? M.anodBlack : M.paintA;
    b.with(crownMat, () => b.rbox(halfF + 0.006, 0.016, 0.019, 0.008, cm, lod ? 1 : 3));
    // steerer stub above the head tube (stem sits on it)
    b.with(M.anodBlack, () => b.tube([htTop.clone().addScaledVector(axis, 0.014), htTop.clone().addScaledVector(axis, 0.03)], 0.0165, tubeSeg(ctx, 0.016), { n: 1 }));
    const ft = spec.frame.forkType;
    for (const sx of [-1, 1]) {
      const top = crown.clone().addScaledVector(axis, -0.01).add(V(sx * (halfF - 0.008), 0, 0));
      const tip = hubF.clone().add(V(sx * (halfF - 0.004), 0, 0));
      if (ft === 'curved') {
        const mid = axisAtY(L, hubF.y + 0.13).add(V(sx * (halfF - 0.005), 0, 0));
        const knee = axisAtY(L, hubF.y + 0.05).add(V(sx * (halfF - 0.004), 0, -0.012));
        ftube(ctx, [top, mid, knee, tip.clone().add(V(0, 0.006, 0))], r.blade[0], { flare: [0.1, 0], r1: r.blade[1] });
      } else if (ft === 'susp') {
        // suspension fork: silver stanchions into fat black lowers
        const lowTop = top.clone().lerp(tip, 0.45);
        b.with(M.alloyPolish, () => b.tube([top, lowTop.clone().addScaledVector(axis, -0.02)], 0.0155, tubeSeg(ctx, 0.016), { n: 1 }));
        b.with(M.anodBlack, () => b.tube([lowTop, tip.clone().add(V(0, 0.01, 0))], 0.0205, tubeSeg(ctx, 0.02), { n: 2, caps: ['round', 'round'] }));
        if (sx > 0) {
          // brace arch between the lowers
          const a0 = lowTop.clone().add(V(-0.0, 0.01, -0.024)), a1 = a0.clone().setX(-a0.x);
          b.with(M.anodBlack, () => b.tube([a0, V(0, a0.y + 0.03, a0.z - 0.012), a1], 0.008, tubeSeg(ctx, 0.008), { n: 6 }));
        }
      } else {
        ftube(ctx, [top, tip.clone().add(V(0, 0.008, 0))], r.blade[0], { flare: [0.08, 0], r1: r.blade[1] });
      }
      b.with(M.paintA, () => b.rbox(0.0028, 0.018, 0.02, 0.0025, M4([tip.x, tip.y + 0.002, tip.z], [0.3, 0, 0]), lod ? 1 : 2));
    }
  });
}

/** Handlebar centre-line (one half, sx = +1 right) in bar space: origin at the stem clamp, -Z forward. */
function barPath(spec, sx) {
  const B = spec.bar, w = B.width / 2;
  if (B.type === 'swept') {
    const s = B.sweep;
    return [V(0, 0, 0), V(sx * 0.07, 0.004, -0.004), V(sx * 0.15, 0.022, 0.012), V(sx * (w - 0.045), 0.04, s * 0.55), V(sx * w, 0.045, s)];
  }
  if (B.type === 'drop') {
    return [V(0, 0, 0), V(sx * 0.15, 0, 0), V(sx * w, 0.0, -0.03), V(sx * w, -0.018, -0.08), V(sx * w, -0.065, -0.095), V(sx * w, -0.115, -0.06), V(sx * w, -0.13, 0.0), V(sx * w, -0.13, 0.06)];
  }
  if (B.type === 'riser') {
    const rise = B.rise || 0.04, s = B.sweep ?? 0.05;
    return [V(0, 0, 0), V(sx * 0.05, 0, 0), V(sx * 0.11, rise * 0.85, s * 0.2), V(sx * (w - 0.1), rise, s * 0.6), V(sx * w, rise, s)];
  }
  return [V(0, 0, 0), V(sx * w * 0.5, 0, 0.005), V(sx * w, 0, 0.035)];   // flat, 9 degree backsweep
}

function cockpit(ctx) {
  const { b, spec, L, lod } = ctx;
  const { axis, htTop, steerAux } = L;
  const B = spec.bar;
  // stem: quill (swept bars) rises along the axis; ahead stems reach forward
  const base = htTop.clone().addScaledVector(axis, 0.02);
  let clamp;
  b.with({ piece: PIECE.STEER, aux: steerAux }, () => {
    if (B.type === 'swept') {
      const top = base.clone().addScaledVector(axis, Math.max(0.03, (B.h - 0.045 - base.y) / axis.y - 0.02));
      clamp = top.clone().add(V(0, 0.018, -0.045));
      b.with(M.chrome, () => {
        b.tube([base.clone().addScaledVector(axis, -0.01), top], 0.0112, tubeSeg(ctx, 0.011), { n: 2 });
        b.tube([top.clone().addScaledVector(axis, -0.01), top.clone().add(V(0, 0.012, -0.02)), clamp], 0.011, tubeSeg(ctx, 0.011), { n: 5 });
        b.tube([clamp.clone().add(V(-0.022, 0, 0)), clamp.clone().add(V(0.022, 0, 0))], 0.0155, tubeSeg(ctx, 0.015), { n: 1, caps: 'flat' });
      });
    } else {
      const stack = B.type === 'drop' ? 0.02 : 0.03;
      const top = base.clone().addScaledVector(axis, stack);
      const len = B.type === 'drop' ? 0.1 : spec.id === 'kids' ? 0.045 : 0.08;
      const rise = Math.max(-0.02, Math.min(0.09, B.h - (B.type === 'riser' ? (B.rise || 0.04) : 0) - top.y - 0.01));
      clamp = top.clone().add(V(0, rise + 0.012, -len));
      const sm = B.type === 'drop' ? M.anodBlack : (spec.id === 'kids' ? M.alloy : M.anodBlack);
      b.with(sm, () => {
        b.tube([base.clone().addScaledVector(axis, -0.004), top.clone().addScaledVector(axis, 0.004)], 0.0158, tubeSeg(ctx, 0.016), { n: 1, caps: [null, 'flat'] });
        b.tube([top.clone().addScaledVector(axis, -0.012), clamp], 0.0135, tubeSeg(ctx, 0.0135), { n: 2 });
        b.tube([clamp.clone().add(V(-0.021, 0, 0)), clamp.clone().add(V(0.021, 0, 0))], 0.0175, tubeSeg(ctx, 0.017), { n: 1, caps: 'flat' });
      });
    }
    ctx.barClamp = clamp;
    // bar (both halves), grips, levers
    const barMat = B.type === 'swept' ? M.chrome : (spec.id === 'kids' ? M.alloy : M.anodBlack);
    const grips = {};
    for (const sx of [-1, 1]) {
      const pts = barPath(spec, sx).map((p) => p.add(clamp));
      const rr = B.type === 'drop' ? 0.0119 : 0.011;
      b.with(barMat, () => b.tube(pts, (t) => rr * (1 + 0.15 * (1 - smooth(0, 0.18, t))), tubeSeg(ctx, rr), { n: lod === 2 ? 4 : 16, caps: [null, B.type === 'drop' ? 'flat' : null] }));
      // grip section: the last stretch of the bar
      const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      if (B.type === 'drop') {
        const tapeMat = M.tape;
        b.with(tapeMat, () => b.tube(pts.slice(1), 0.0135, tubeSeg(ctx, 0.013), { n: lod === 2 ? 4 : 16 }));
        // brake / shift hoods on top of the forward bend, lever blades following the drop
        const w = spec.bar.width / 2;
        const hood0 = clamp.clone().add(V(sx * w, 0.012, -0.028));
        const hoodM = clamp.clone().add(V(sx * w, 0.024, -0.062));
        const hood1 = clamp.clone().add(V(sx * w, 0.03, -0.092));
        b.with(M.rubber, () => b.tube([hood0, hoodM, hood1], (t) => 0.0145 - 0.004 * t, tubeSeg(ctx, 0.014), { n: 5, caps: [null, 'round'] }));
        if (lod < 2) {
          const l0 = hood1.clone().add(V(0, -0.012, 0.004)), l1 = clamp.clone().add(V(sx * w, -0.05, -0.108)), l2 = clamp.clone().add(V(sx * w, -0.105, -0.085));
          b.with(M.anodBlack, () => b.sweep([l0, l1, l2], roundRect(0.005, 0.0045, 0.002, 1), { n: 6, N0: V(1, 0, 0) }));
        }
        grips[sx] = { p: hood0.clone().lerp(hood1, 0.5).add(V(0, 0.016, 0)), dir: V(0, 0.2, -1).normalize() };
      } else {
        const g0 = curve.getPointAt(B.type === 'swept' ? 0.72 : 0.76);
        const g1 = pts[pts.length - 1];
        const gd = g1.clone().sub(g0).normalize();
        const gEnd = g1.clone().addScaledVector(gd, 0.004);
        const gStart = gEnd.clone().addScaledVector(gd, -0.125);
        const gm = M[spec.grips] || M.gripBlack;
        const gr = spec.grips.startsWith('leather') ? 0.0165 : 0.0172;
        b.with(gm, () => b.tube([gStart, gEnd], (t) => gr * (1 + 0.06 * Math.sin(Math.PI * t)), tubeSeg(ctx, gr), { n: 4, caps: ['flat', 'round'] }));
        grips[sx] = { p: gStart.clone().lerp(gEnd, 0.52), dir: gd.clone() };
        // brake lever: perch at the inner end of the grip, blade in front of the grip
        if (lod < 2) {
          const perch = gStart.clone().addScaledVector(gd, -0.012);
          b.with(M.alloy, () => b.tube([perch.clone().addScaledVector(gd, -0.008), perch.clone().addScaledVector(gd, 0.012)], 0.0145, tubeSeg(ctx, 0.014), { n: 1, caps: 'flat' }));
          const fwd = V(0, -0.15, -1).normalize();
          const out = gd.clone();
          const a0 = perch.clone().addScaledVector(fwd, 0.02);
          const a1 = a0.clone().addScaledVector(fwd, 0.018).addScaledVector(out, 0.03);
          const a2 = a1.clone().addScaledVector(out, spec.levers === 'city' ? 0.075 : 0.065).addScaledVector(fwd, 0.004);
          b.with(spec.levers === 'city' ? M.alloyPolish : M.anodBlack, () => b.sweep([a0, a1, a2], roundRect(0.0045, 0.008, 0.003, 1), { n: 6, N0: V(0, 1, 0), caps: [null, 'round'] }));
          // cable housing loops from the perch to the head tube
          const c0 = perch.clone().addScaledVector(fwd, 0.015).add(V(0, 0.005, 0));
          const c1 = c0.clone().add(V(-sx * 0.04, 0.03, -0.12));
          const c2 = L.htTop.clone().add(V(sx * 0.03, -0.02, -0.06));
          const c3 = L.htTop.clone().lerp(L.htBot, 0.5).add(V(sx * 0.024, 0, -0.006));
          b.with(M.plasticGloss, () => b.tube([c0, c1, c2, c3], 0.0025, Math.max(3, ctx.Q.small - 1), { n: 14 }));
        }
      }
    }
    ctx.grips = grips;
    // bell (left bar) and display
    if (spec.extras.bell && lod < 2) {
      const gp = grips[-1].p, gd = grips[-1].dir;
      const at = gp.clone().addScaledVector(gd, -0.1).add(V(0, 0.022, 0));
      b.with(M.chrome, () => b.revolveY(at, [[0.0001, 0.018], [0.012, 0.016], [0.022, 0.009], [0.027, 0.0], [0.026, -0.004], [0.006, -0.005]], ctx.Q.wheelSeg > 40 ? 20 : 10));
      b.with(M.anodBlack, () => b.tube([at.clone().add(V(0, -0.006, 0)), at.clone().add(V(0, -0.022, 0))], 0.004, 4, { n: 1 }));
    }
    if (spec.extras.display && lod < 2) {
      b.with(M.plasticGloss, () => b.rbox(0.035, 0.008, 0.022, 0.004, M4([clamp.x, clamp.y + 0.03, clamp.z - 0.01], [0.5, 0, 0]), 1));
    }
  });
}

// ------------------------------------------------------------------ wheels

function wheel(ctx, hub, front) {
  const { b, spec, lod, Q, L } = ctx;
  const W = spec.wheel;
  const piece = front ? PIECE.FWHEEL : PIECE.RWHEEL;
  const R = L.R;
  const segA = Q.wheelSeg;
  const st = { piece, piv: [hub.x, hub.y, hub.z], aux: front ? L.steerAux : [0, 0, 0, 0] };
  b.with(st, () => {
    // ---- tyre: ellipse profile; tread band across the crown, plain sidewalls
    const w2 = W.tyreW / 2, h = W.tyreH, c = W.bead + h * 0.52, xb = W.rimW / 2 - 0.0012;
    const ry = h * 0.5;
    const ell = (t) => [w2 * Math.cos(t), c + ry * Math.sin(t)];   // t: 0 = right side, pi/2 = crown
    const tb = Math.asin(Math.max(-1, Math.min(1, -(c - W.bead - 0.002) / ry)));   // bead angle (below centre)
    const tBead = Math.max(tb, -Math.acos(Math.min(1, xb / w2)));
    const tTr = 0.55;   // tread half-angle from the crown (rad)
    const sec = (t0, t1, n) => { const out = []; for (let i = 0; i <= n; i++) out.push(ell(t0 + ((t1 - t0) * i) / n)); return out; };
    const nP = Q.tyreProf;
    const C = 2 * Math.PI * R;
    // right sidewall: bead -> tread edge
    const wallMat = W.wall === 'tan' ? M.tanWall : M.tyreWall;
    const rightWall = sec(tBead, Math.PI / 2 - tTr, Math.max(2, nP - 2));
    const leftWall = sec(Math.PI / 2 + tTr, Math.PI - tBead, Math.max(2, nP - 2));
    b.with(wallMat, () => {
      b.revolveX(hub, rightWall.map(([x, r]) => [x, r]), segA);
      b.revolveX(hub, leftWall.map(([x, r]) => [x, r]), segA);
    });
    if (W.wall === 'stripe' && lod < 2) {
      // reflective band on both sidewalls
      for (const sgn of [1, -1]) {
        const tm = sgn > 0 ? (tBead + Math.PI / 2 - tTr) / 2 + 0.1 : Math.PI - ((tBead + Math.PI / 2 - tTr) / 2 + 0.1);
        const p = ell(tm);
        const d = 0.0022;
        const pr = sgn > 0 ? [[p[0] + 0.0004, p[1] - d], [p[0] + 0.0004, p[1] + d]] : [[p[0] - 0.0004, p[1] + d], [p[0] - 0.0004, p[1] - d]];
        b.with(M.stripe, () => b.revolveX(hub, pr, segA));
      }
    }
    // tread band: uv.x around the tyre (m), uv.y across the crown (m, 0 at the centre)
    const tread = sec(Math.PI / 2 - tTr, Math.PI / 2 + tTr, Math.max(2, nP));
    const arc = [0];
    for (let j = 1; j < tread.length; j++) arc.push(arc[j - 1] + Math.hypot(tread[j][0] - tread[j - 1][0], tread[j][1] - tread[j - 1][1]));
    const half = arc[arc.length - 1] / 2;
    b.with({ ...M.rubber, ch: CH.TREAD, w: W.tread, col: [0.03, 0.03, 0.03], rough: 0.76 }, () => {
      b.revolveX(hub, tread, segA, { uv: (I, J) => [(I / segA) * C, arc[Math.min(J, arc.length - 1)] - half] });
    });
    // ---- rim: two braking flanks + inner bed (hard edges between)
    const rm = W.rim === 'black' ? M.anodBlack : M.alloy;
    const bead = W.bead, rw = W.rimW / 2, rd = W.rimDepth;
    const inner = bead - rd;
    b.with(rm, () => {
      if (lod < 2) {
        b.revolveX(hub, [[rw, bead - 0.002], [rw, bead + 0.0035], [rw - 0.0016, bead + 0.0045]], segA);
        b.revolveX(hub, [[-rw + 0.0016, bead + 0.0045], [-rw, bead + 0.0035], [-rw, bead - 0.002]], segA);
        b.revolveX(hub, [[rw * 0.995, bead - 0.002], [rw * 0.93, inner + rd * 0.35], [rw * 0.55, inner], [0, inner - 0.0008], [-rw * 0.55, inner], [-rw * 0.93, inner + rd * 0.35], [-rw * 0.995, bead - 0.002]].reverse(), segA);
      } else {
        b.revolveX(hub, [[rw, bead + 0.004], [rw * 0.8, inner], [-rw * 0.8, inner], [-rw, bead + 0.004]].reverse(), segA);
      }
    });
    if (W.rim === 'alloy' && lod < 2) {
      // machined brake tracks catch the light
      for (const sx of [1, -1]) {
        const x = sx * (rw + 0.0003);
        const pr = sx > 0 ? [[x, bead - 0.011], [x, bead - 0.001]] : [[x, bead - 0.001], [x, bead - 0.011]];
        b.with({ ...M.alloyPolish, rough: 0.2 }, () => b.revolveX(hub, pr, segA));
      }
    }
    // ---- hub
    const fi = front ? 0 : 1;
    const fR = W.flangeR[fi], fX = W.flangeX[fi];
    const old2 = W.old[fi] / 2;
    const kind = front ? W.hubF : W.hubR;
    const hs = lod === 0 ? 24 : lod === 1 ? 12 : 8;
    let prof;
    if (kind === 'dynamo') {
      prof = [[old2, 0.005], [old2, 0.009], [old2 - 0.006, 0.0095], [fX + 0.004, 0.012], [fX + 0.002, fR], [fX - 0.002, fR], [fX - 0.004, 0.026], [0.018, 0.034], [0, 0.036], [-0.018, 0.034], [-fX + 0.004, 0.026], [-fX + 0.002, fR], [-fX - 0.002, fR], [-fX - 0.004, 0.012], [-old2 + 0.006, 0.0095], [-old2, 0.009], [-old2, 0.005]];
    } else if (kind === 'igh' || kind === 'coaster') {
      const big = kind === 'igh';
      prof = [[old2, 0.005], [old2, 0.01], [old2 - 0.007, 0.012], [fX + 0.004, big ? 0.03 : 0.016], [fX + 0.0015, fR], [fX - 0.0015, fR], [fX - 0.003, big ? 0.034 : 0.016], [0, big ? 0.036 : 0.018], [-fX + 0.003, big ? 0.034 : 0.016], [-fX + 0.0015, fR], [-fX - 0.0015, fR], [-fX - 0.004, big ? 0.03 : 0.016], [-old2 + 0.007, 0.012], [-old2, 0.01], [-old2, 0.005]];
    } else {
      prof = [[old2, 0.005], [old2, 0.009], [old2 - 0.006, 0.0095], [fX + 0.003, 0.011], [fX + 0.0015, fR], [fX - 0.0015, fR], [fX - 0.003, 0.0135], [0, 0.0145], [-fX + 0.003, 0.0135], [-fX + 0.0015, fR], [-fX - 0.0015, fR], [-fX - 0.003, 0.011], [-old2 + 0.006, 0.0095], [-old2, 0.009], [-old2, 0.005]];
    }
    const hubMat = kind === 'igh' || kind === 'dynamo' ? (W.rim === 'black' ? M.anodBlack : M.alloy) : M.alloy;
    b.with({ ...hubMat, aoFn: null }, () => b.revolveX(hub, prof, hs));
    // axle nuts
    if (lod < 2) for (const sx of [-1, 1]) b.with(M.steel, () => b.tube([V(hub.x + sx * (old2 - 0.002), hub.y, hub.z), V(hub.x + sx * (old2 + 0.008), hub.y, hub.z)], 0.0075, 6, { n: 1, caps: [null, 'flat'] }));
    // ---- spokes
    const rimHoleR = inner + 0.002;
    const nS = W.perSide;
    const cross = W.cross;
    const delta = (cross * Math.PI * 2) / nS;
    const spokeMat = W.rim === 'black' && spec.id !== 'kids' ? { ...M.spoke, col: [0.05, 0.05, 0.05], metal: 0.5, rough: 0.35 } : M.spoke;
    if (Q.spokes === 'geo') {
      for (const sx of [1, -1]) {
        for (let k = 0; k < nS; k++) {
          const a = (k / nS) * Math.PI * 2 + (sx > 0 ? Math.PI / nS : 0);
          const lead = k % 2 ? 1 : -1;
          const ar = a + lead * delta * (sx > 0 ? 1 : -1);
          const h0 = V(hub.x + sx * fX, hub.y + Math.cos(a) * fR * 0.88, hub.z - Math.sin(a) * fR * 0.88);
          const r0 = V(hub.x + sx * 0.0022, hub.y + Math.cos(ar) * rimHoleR, hub.z - Math.sin(ar) * rimHoleR);
          b.with(spokeMat, () => b.tube([h0, r0], 0.00098, 4, { n: 1 }));
          const nip0 = r0.clone().lerp(h0, 0.045);
          b.with(M.chrome, () => b.tube([nip0, r0.clone().lerp(h0, -0.004)], 0.0019, 4, { n: 1 }));
        }
      }
      // valve
      b.with(M.chrome, () => b.tube([V(hub.x, hub.y + inner + 0.004, hub.z), V(hub.x, hub.y + inner - 0.022, hub.z)], 0.0028, 6, { n: 1, caps: [null, 'flat'] }));
    } else {
      // spokes as two alpha-to-coverage cones (one per flange), mapped to the spoke atlas
      const cell = W.cell;
      const conM = spokeMat.col[0] < 0.1 ? M.spokeConeBlack : M.spokeCone;
      const n = lod === 1 ? 40 : 20;
      for (const sx of [1, -1]) {
        const rot = sx > 0 ? Math.PI / nS : 0;
        const prof = [[sx * fX, fR * 0.9], [sx * 0.002, rimHoleR]];
        const uvA = [0, 0];
        b.with(conM, () => b.revolveX(hub, sx > 0 ? prof : prof.slice().reverse(), n, {
          twoSided: true,
          uv: (I, J) => {
            const a = (I / n) * Math.PI * 2;
            const jj = sx > 0 ? J : 1 - J;
            const rf = jj === 0 ? 0.19 : 1.0;
            spokeUv(cell, rf, a * sx + rot, uvA);
            return [uvA[0], uvA[1]];
          },
        }));
      }
    }
  });
}

function wheels(ctx) {
  const { L } = ctx;
  wheel(ctx, L.hubF, true);
  wheel(ctx, L.hubR, false);
}

// ------------------------------------------------------------------ drivetrain

/** Closed chain loop (YZ) around chainring and rear cog (plus derailleur pulleys). */
function chainLoop(bb, rf, hub, rr, pulleys = null, n = 160) {
  // belt path around circles in order; positive radius = wrap clockwise looking from +X
  const circles = [{ c: [bb.y, bb.z], r: rf }, { c: [hub.y, hub.z], r: rr }];
  if (pulleys) circles.push(...pulleys);
  // tangent from circle A to circle B (both wrapped the same way): external tangent
  const tang = (A, B) => {
    const dx = B.c[1] - A.c[1], dy = B.c[0] - A.c[0];
    const D = Math.hypot(dx, dy);
    const base = Math.atan2(dy, dx);
    const off = Math.acos(Math.max(-1, Math.min(1, (A.r - B.r) / D)));
    const ang = base + off;          // normal direction of the tangent points (left side of travel)
    return { a: ang, pa: [A.c[0] + Math.sin(ang) * A.r, A.c[1] + Math.cos(ang) * A.r], pb: [B.c[0] + Math.sin(ang) * B.r, B.c[1] + Math.cos(ang) * B.r] };
  };
  // order: chainring -> (top run) -> cog -> (bottom run) -> pulleys -> chainring
  const seq = pulleys ? [circles[0], circles[1], ...pulleys] : [circles[0], circles[1]];
  const ts = [];
  for (let i = 0; i < seq.length; i++) ts.push(tang(seq[i], seq[(i + 1) % seq.length]));
  // walk: for each circle, arc from the previous tangent's end angle to this tangent's start angle
  const pts = [];
  const total = [];
  for (let i = 0; i < seq.length; i++) {
    const C = seq[i];
    // the chain wraps each sprocket going backwards in angle (angle 0 = rear, pi/2 = top)
    const inA = ts[(i - 1 + seq.length) % seq.length].a, outA = ts[i].a;
    let d = inA - outA;
    while (d <= 0) d += Math.PI * 2;
    while (d > Math.PI * 2) d -= Math.PI * 2;
    const k = Math.max(2, Math.ceil((d * C.r) / 0.006));
    for (let j = 0; j <= k; j++) {
      const a = inA - (d * j) / k;
      total.push([C.c[0] + Math.sin(a) * C.r, C.c[1] + Math.cos(a) * C.r]);
    }
  }
  for (const [y, z] of total) pts.push(V(0, y, z));
  void n;
  // drop near-duplicates
  const out = [pts[0]];
  for (const p of pts) if (p.distanceTo(out[out.length - 1]) > 0.004) out.push(p);
  return out;
}

function drivetrain(ctx) {
  const { b, spec, L, lod, Q } = ctx;
  const { bb, hubR } = L;
  const xc = spec.chainline;
  const pitch = 0.0127;
  const rf = pitch / (2 * Math.sin(Math.PI / spec.ring));
  const rr = pitch / (2 * Math.sin(Math.PI / spec.cog));
  const crankX = 0.072;
  const deraill = spec.extras.derailleur;
  // ---- chain (static loop; links rendered on it)
  const pulleys = deraill ? [{ c: [hubR.y - 0.075, hubR.z + 0.018], r: 0.016 }, { c: [hubR.y - 0.13, hubR.z - 0.005], r: 0.016 }] : null;
  const loop = chainLoop(bb, rf + 0.002, hubR, rr + 0.002, pulleys);
  if (lod < 2 || spec.extras.guard !== 'full') {
    const pts = loop.map((p) => p.clone().setX(xc));
    const prof = roundRect(0.0037, 0.0043, 0.0016, lod === 0 ? 2 : lod === 1 ? 1 : 0);
    // links are drawn by the shader, scrolling with the crank (aMat.w = chainring pitch radius)
    b.with({ ...M.chain, ch: lod < 2 ? CH.CHAIN : CH.PLAIN, w: rf }, () => b.sweep(pts, prof, { closedPath: true, N0: V(1, 0, 0) }));
  }
  // ---- rear cog / cassette (rolls with the wheel)
  b.with({ piece: PIECE.RWHEEL, piv: [hubR.x, hubR.y, hubR.z] }, () => {
    if (spec.wheel.hubR === 'cassette') {
      for (let k = 0; k < (lod === 2 ? 3 : 8); k++) {
        const x = xc - 0.012 + k * (lod === 2 ? 0.012 : 0.0043);
        const r = rr + (k - 3) * 0.0042 + 0.004;
        b.with(M.steel, () => b.revolveX(V(x, hubR.y, hubR.z), [[0.0009, 0.012], [0.0009, r], [-0.0009, r], [-0.0009, 0.012]], lod === 2 ? 10 : 24));
      }
    } else {
      b.with(M.steel, () => b.revolveX(V(xc, hubR.y, hubR.z), [[0.0012, 0.01], [0.0012, rr + 0.004], [-0.0012, rr + 0.004], [-0.0012, 0.01]], lod === 2 ? 10 : 24));
    }
  });
  // ---- crankset (rotates about the bottom bracket)
  b.with({ piece: PIECE.CRANK, piv: [0, bb.y, bb.z] }, () => {
    // chainring: toothed outline at LOD 0, plain ring otherwise
    const ringMat = spec.id === 'road' ? M.anodBlack : M.alloy;
    const tooth = lod === 0;
    const outline = [];
    const nT = spec.ring;
    if (tooth) {
      for (let i = 0; i < nT; i++) {
        const a = (i / nT) * Math.PI * 2;
        const da = (Math.PI * 2) / nT;
        outline.push([Math.cos(a - da * 0.32) * (rf - 0.001), Math.sin(a - da * 0.32) * (rf - 0.001)]);
        outline.push([Math.cos(a - da * 0.12) * (rf + 0.0042), Math.sin(a - da * 0.12) * (rf + 0.0042)]);
        outline.push([Math.cos(a + da * 0.12) * (rf + 0.0042), Math.sin(a + da * 0.12) * (rf + 0.0042)]);
        outline.push([Math.cos(a + da * 0.32) * (rf - 0.001), Math.sin(a + da * 0.32) * (rf - 0.001)]);
      }
    }
    const ringW = 0.0013;
    // ring as a flat annulus: outer edge (teeth) + faces; inner radius carries the spider
    const ri = rf - 0.012;
    const ringSeg = lod === 2 ? 14 : lod === 1 ? 32 : 0;
    const ringAt = (x) => {
      if (tooth) {
        // faces: triangle fan between inner circle and tooth outline (per tooth point)
        for (const sgn of [1, -1]) {
          const base = b.count;
          const n = V(sgn, 0, 0);
          for (const [cy, cz] of outline) {
            const a = Math.atan2(cz, cy);
            b.vert(V(x + sgn * ringW, bb.y + cy, bb.z - cz), n, 0, 0);
            b.vert(V(x + sgn * ringW, bb.y + Math.cos(a) * ri, bb.z - Math.sin(a) * ri), n, 0, 0);
          }
          const m = outline.length;
          for (let i = 0; i < m; i++) {
            const o0 = base + i * 2, i0 = o0 + 1, o1 = base + ((i + 1) % m) * 2, i1 = o1 + 1;
            if (sgn < 0) { b.tri(o0, o1, i1); b.tri(o0, i1, i0); } else { b.tri(o0, i1, o1); b.tri(o0, i0, i1); }
          }
        }
        // tooth edge band
        const rows = outline.map(([cy, cz]) => [V(x + ringW, bb.y + cy, bb.z - cz), V(x - ringW, bb.y + cy, bb.z - cz)]);
        b.surface(rows, { wrapI: true, out: (p) => V(0, p.y - bb.y, p.z - bb.z) });
      } else {
        b.revolveX(V(x, bb.y, bb.z), [[ringW, ri], [ringW, rf + 0.003], [-ringW, rf + 0.003], [-ringW, ri]], ringSeg);
      }
    };
    b.with(ringMat, () => ringAt(xc));
    // spider + right crank arm (pointing up at crank angle 0), left arm pointing down
    b.with(spec.id === 'road' || spec.id === 'ebike' || spec.id === 'hybrid' ? M.anodBlack : M.alloyPolish, () => {
      if (lod < 2) {
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2 + 0.3;
          const p0 = V(xc + 0.006, bb.y + Math.cos(a) * 0.012, bb.z - Math.sin(a) * 0.012);
          const p1 = V(xc + 0.002, bb.y + Math.cos(a) * (ri + 0.004), bb.z - Math.sin(a) * (ri + 0.004));
          b.sweep([p0, p1], roundRect(0.003, 0.006, 0.002, 1), { n: 1, N0: V(1, 0, 0) });
        }
      }
      for (const sx of [1, -1]) {
        const x0 = sx * (sx > 0 ? xc + 0.012 : crankX - 0.012), x1 = sx * crankX;
        const p0 = V(x0, bb.y, bb.z), p1 = V(x1, bb.y + sx * spec.crank, bb.z);
        b.sweep([p0, p0.clone().lerp(p1, 0.15).setX(x1), p1], roundRect(0.0065, 0.013, 0.004, lod ? 1 : 2), {
          n: lod === 2 ? 2 : 6, N0: V(1, 0, 0), scale: (t) => [1, 1.25 - 0.45 * t], caps: ['round', 'round'] });
        // spindle boss
        if (lod < 2) b.tube([V(x1 * 0.98, bb.y, bb.z), V(x1 + sx * 0.006, bb.y, bb.z)], 0.012, 8, { n: 1, caps: [null, 'flat'] });
      }
    });
    // bottom bracket axle visible between
    if (lod < 2) b.with(M.steel, () => b.tube([V(-crankX + 0.01, bb.y, bb.z), V(xc, bb.y, bb.z)], 0.011, 8, { n: 1 }));
  });
  // ---- pedals (orbit, stay level)
  for (const sx of [1, -1]) {
    const sp = V(sx * (crankX + 0.006), bb.y + sx * spec.crank, bb.z);
    b.with({ piece: PIECE.PEDAL, piv: [sp.x, sp.y, sp.z], aux: [bb.y, bb.z, 0, 0] }, () => {
      const pc = sp.clone().add(V(sx * 0.058, 0, 0));
      const road = spec.id === 'road';
      const pw = road ? 0.075 : 0.1, pd = road ? 0.062 : 0.068, ph = road ? 0.018 : 0.022;
      b.with(M.steel, () => b.tube([sp, sp.clone().add(V(sx * 0.016, 0, 0))], 0.0065, 6, { n: 1 }));
      b.with(M.plastic, () => b.rbox(pw / 2, ph / 2, pd / 2, 0.006, M4([pc.x, pc.y, pc.z]), lod ? 1 : 2));
      if (lod < 2 && !road) {
        for (const sz of [-1, 1]) b.with(M.reflAmber, () => b.rbox(pw / 2 - 0.012, 0.006, 0.0015, 0.001, M4([pc.x, pc.y, pc.z + sz * (pd / 2 + 0.0008)]), 1));
      }
    });
  }
  // ---- derailleurs
  if (deraill && lod < 2) {
    b.with(M.anodBlack, () => {
      const top = V(xc + 0.012, hubR.y - 0.02, hubR.z + 0.012);
      b.rbox(0.008, 0.03, 0.012, 0.004, alongY(top.clone().add(V(0, -0.04, 0.008)), top), 1);
      for (const pl of pulleys) {
        b.revolveX(V(xc, pl.c[0], pl.c[1]), [[0.003, 0.004], [0.003, pl.r + 0.002], [-0.003, pl.r + 0.002], [-0.003, 0.004]], 12);
        b.rbox(0.0012, 0.035, 0.01, 0.001, M4([xc + 0.009, (pulleys[0].c[0] + pulleys[1].c[0]) / 2, (pulleys[0].c[1] + pulleys[1].c[1]) / 2]), 1);
      }
      // front derailleur cage above the chainring
      const fd = bb.clone().addScaledVector(L.seatDir, rf + 0.03).add(V(xc - 0.004, 0, 0.0));
      b.rbox(0.009, 0.012, 0.028, 0.003, M4([fd.x, fd.y, fd.z - 0.012]), 1);
    });
  }
  ctx.rf = rf;
  ctx.rr = rr;
  ctx.xc = xc;
  ctx.crankX = crankX;
}

// ------------------------------------------------------------------ saddle + seat post

function saddleRings(spec, nL, nR) {
  // loft rings from nose (t=0, -Z) to back (t=1, +Z), centred at origin (rail clamp below)
  const k = spec.saddle;
  const D = {
    sprung: { len: 0.27, wb: 0.215, wn: 0.06, th: 0.045, dip: 0.006 },
    comfort: { len: 0.265, wb: 0.18, wn: 0.055, th: 0.05, dip: 0.008 },
    road: { len: 0.275, wb: 0.14, wn: 0.035, th: 0.038, dip: 0.004 },
    kids: { len: 0.22, wb: 0.15, wn: 0.05, th: 0.045, dip: 0.006 },
  }[k];
  const rings = [];
  for (let i = 0; i <= nL; i++) {
    const t = i / nL;
    const z = -D.len / 2 + D.len * t + 0.02;
    // width: narrow nose flaring into the wide rear, rounded back end
    let w = D.wn + (D.wb - D.wn) * smooth(0.25, 0.85, t);
    w *= Math.sqrt(Math.max(0.0, 1 - Math.pow(Math.max(0, (t - 0.84) / 0.16), 2)));
    w *= Math.sqrt(Math.max(0.0, 1 - Math.pow(Math.max(0, (0.06 - t) / 0.06), 2)));
    w = Math.max(w, 0.004);
    const top = D.th + D.dip * Math.sin(Math.PI * t) * -1 + (t < 0.2 ? 0.006 * (1 - t / 0.2) : 0);
    const th = D.th * (0.55 + 0.45 * smooth(0.0, 0.5, t)) * Math.max(0.15, Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, (t - 0.9) / 0.1), 2))));
    const ring = [];
    for (let j = 0; j < nR; j++) {
      const a = (j / nR) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      // superellipse: rounded top, flat underside
      const px = Math.sign(c) * Math.pow(Math.abs(c), 0.62) * w / 2;
      const py = s > 0 ? Math.pow(s, 0.55) * th * 0.45 : -Math.pow(-s, 1.6) * th * 0.55;
      ring.push(V(px, top - th * 0.45 + py, z));
    }
    rings.push(ring);
  }
  return { rings, D };
}

function seat(ctx) {
  const { b, spec, L, lod, Q } = ctx;
  const { clamp, seatDir, stTop, saddleT } = L;
  const sd = [0, seatDir.y, seatDir.z, 0];
  b.with({ piece: PIECE.SADDLE, piv: [0, 0, 0], aux: sd }, () => {
    // seat post (extends 0.12 down into the tube so raising it never shows the end)
    const postMat = spec.id === 'road' || spec.id === 'ebike' ? M.anodBlack : M.alloy;
    b.with(postMat, () => b.tube([stTop.clone().addScaledVector(seatDir, -0.12), clamp.clone().addScaledVector(seatDir, 0.005)], 0.0136, ctx.Q.tube(0.0136), { n: 1 }));
    b.with(postMat, () => b.rbox(0.014, 0.008, 0.03, 0.004, M4([clamp.x, clamp.y + 0.006, clamp.z]), lod ? 1 : 2));
    // saddle shell
    const [nl, nr] = Q.saddle;
    const { rings, D } = saddleRings(spec, nl, nr);
    const o = V(clamp.x, clamp.y + saddleT - D.th, clamp.z);
    const sm = M[spec.saddleMat] || M.leatherBlack;
    const rr = rings.map((r) => r.map((p) => p.clone().add(o)));
    const cen = (r) => r.reduce((acc, p) => acc.add(p), V(0, 0, 0)).multiplyScalar(1 / r.length);
    b.with({ ...sm, aoFn: (x, y, z, nx, ny) => (ny < -0.4 ? 0.55 : 1) }, () => b.loft(rr, { capStart: cen(rr[0]), capEnd: cen(rr[rr.length - 1]) }));
    // rails / springs underneath
    if (lod < 2) {
      for (const sx of [-1, 1]) {
        const r0 = V(sx * 0.02, clamp.y + 0.004, clamp.z - 0.1), r1 = V(sx * 0.022, clamp.y + 0.002, clamp.z), r2 = V(sx * 0.035, clamp.y + 0.01, clamp.z + 0.075);
        b.with(M.steel, () => b.tube([r0.clone().add(V(0, 0.022, -0.02)), r0, r1, r2], 0.0035, 5, { n: 8 }));
        if (spec.saddle === 'sprung') {
          // coil springs under the back of a sprung saddle
          const base = V(sx * 0.05, clamp.y - 0.004, clamp.z + 0.085);
          const top = base.clone().add(V(0, saddleT - 0.012, 0));
          const coil = [];
          const turns = 6;
          const nC = lod === 0 ? turns * 10 : turns * 5;
          for (let i = 0; i <= nC; i++) {
            const t = i / nC, a = t * turns * Math.PI * 2;
            const rr = 0.013 - 0.004 * t;
            coil.push(base.clone().lerp(top, t).add(V(Math.cos(a) * rr, 0, Math.sin(a) * rr)));
          }
          b.with(M.chrome, () => b.tube(coil, 0.0022, 4));
          b.with(M.steel, () => b.tube([base, V(sx * 0.024, clamp.y + 0.002, clamp.z + 0.04)], 0.003, 4, { n: 1 }));
        }
      }
    }
    ctx.saddleTop = V(clamp.x, clamp.y + saddleT, clamp.z + 0.045);
    ctx.saddleNose = V(clamp.x, clamp.y + saddleT - 0.005, clamp.z - D.len / 2 + 0.02);
  });
}

// ------------------------------------------------------------------ extras

function fenderArc(ctx, hub, a0, a1, rad, width, matB, front) {
  const { b, lod, L } = ctx;
  const n = lod === 0 ? 40 : lod === 1 ? 22 : 10;
  const prof = [];
  const w2 = width / 2, dep = 0.012, th = 0.0016;
  // C-section: outer skin over the tyre, rolled edges, inner skin (thin closed profile)
  const m = lod === 0 ? 7 : 4;
  for (let i = 0; i <= m; i++) { const t = i / m; prof.push([w2 * (1 - 2 * t), rad + dep * Math.sin(Math.PI * t) * 0.6 - dep * 0.4 * (1 - Math.sin(Math.PI * t))]); }
  for (let i = m; i >= 0; i--) { const t = i / m; prof.push([w2 * (1 - 2 * t) * 0.97, rad - th + dep * Math.sin(Math.PI * t) * 0.6 - dep * 0.4 * (1 - Math.sin(Math.PI * t))]); }
  const rows = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    rows.push(prof.map(([x, r]) => V(hub.x + x, hub.y + Math.cos(a) * r, hub.z - Math.sin(a) * r)));
  }
  const piece = front ? { piece: PIECE.STEER, aux: L.steerAux } : {};
  b.with({ ...matB, ...piece, aoFn: (x, y, z, nx, ny, nz) => ((nx * 0 + ny * (hub.y - y) + nz * (hub.z - z)) > 0 ? 0.45 : 1) }, () => {
    b.surface(rows, { wrapJ: true, flip: a1 > a0 });
  });
}

function extras(ctx) {
  const { b, spec, L, lod } = ctx;
  const X = spec.extras;
  const { R, hubF, hubR, bb, steerAux, seatDir, stTop } = L;
  const W = spec.wheel;
  const accentMat = X.fenderMat === 'plastic' ? { ...M.plasticGloss, rough: 0.3 } : X.fenderMat === 'paintA' ? M.paintA : M.paintB;
  // ---- fenders (angle 0 = top of the wheel, + forward)
  if (X.fenders) {
    const fr = R + 0.02;
    const fw = W.tyreW + 0.018;
    const fs = spec.id === 'kids' ? 0.8 : 1;
    fenderArc(ctx, hubF, 1.0 * fs, -2.05 * fs, fr, fw, accentMat, true);
    fenderArc(ctx, hubR, 1.55, -2.1 * fs, fr, fw, accentMat, false);
    if (lod < 2) {
      // stays: from the fender's rear part to the dropouts (both wheels)
      for (const [hub, aS, front] of [[hubF, -1.35 * fs, true], [hubR, -1.55 * fs, false]]) {
        const piece = front ? { piece: PIECE.STEER, aux: steerAux } : {};
        for (const sx of [-1, 1]) {
          const p = V(sx * (fw / 2 - 0.004), hub.y + Math.cos(aS) * (fr + 0.004), hub.z - Math.sin(aS) * (fr + 0.004));
          b.with({ ...M.steel, ...piece }, () => b.tube([p, V(sx * (front ? W.old[0] / 2 : W.old[1] / 2) + sx * 0.002, hub.y + 0.01, hub.z + 0.012)], 0.0022, 4, { n: 1 }));
        }
      }
      // mudflap on the front fender
      const a = -2.05 * fs;
      const p = V(0, hubF.y + Math.cos(a) * (fr + 0.002), hubF.z - Math.sin(a) * (fr + 0.002));
      b.with({ ...M.rubber, piece: PIECE.STEER, aux: steerAux }, () => b.rbox(fw / 2 - 0.004, 0.045, 0.0018, 0.0015, M4([p.x, p.y - 0.035, p.z + 0.012], [a + Math.PI / 2 - 1.57 + 0.25, 0, 0]), 1));
      if (X.lightR === 'fender') {
        const ar = -1.75;
        const q = V(0, hubR.y + Math.cos(ar) * (fr + 0.008), hubR.z - Math.sin(ar) * (fr + 0.008));
        b.with(M.reflRed, () => b.rbox(0.022, 0.02, 0.006, 0.004, M4([q.x, q.y, q.z], [ar + 0.0, 0, 0]), 1));
      }
    }
  }
  // ---- chain guard
  if (X.guard && lod < 2 || X.guard === 'full') {
    const xc = ctx.xc;
    const rf = ctx.rf, rr = ctx.rr;
    if (X.guard === 'full' || X.guard === 'kids') {
      // enclosed chain case: stadium outline around ring and cog, rounded edges
      const kids = X.guard === 'kids';
      const rF = rf + 0.022, rR = (kids ? rr + 0.026 : rr + 0.026);
      const n = lod === 0 ? 48 : lod === 1 ? 28 : 14;
      const outline = stadium([bb.y, bb.z], rF, [hubR.y, hubR.z], rR, n);
      const depthX = kids ? 0.03 : 0.036;
      const rings = [];
      const K = lod === 2 ? 2 : 4;
      for (let k = 0; k <= K; k++) {
        const t = k / K;
        const x = xc + 0.002 - depthX / 2 + depthX * t;
        const inset = 0.006 * (1 - Math.sin(Math.PI * t));
        rings.push(outline.map(([y, z, ny, nz]) => V(x, y - ny * inset, z - nz * inset)));
      }
      const cen = V(xc, (bb.y + hubR.y) / 2, (bb.z + hubR.z) / 2);
      b.with(kids ? M.plasticGloss : M.paintB, () => b.loft(rings, { capStart: V(xc - depthX / 2 + 0.002, cen.y, cen.z), capEnd: V(xc + depthX / 2 + 0.002, cen.y, cen.z) }));
    } else {
      // half guard over the top run and the front of the ring (L section)
      const pts = [];
      const rg = rf + 0.022;
      for (let i = 0; i <= 10; i++) {
        const a = -0.35 + (i / 10) * 1.9;          // around the ring top, from rear-top to front
        pts.push(V(xc, bb.y + Math.cos(a) * rg, bb.z - Math.sin(a) * rg));
      }
      pts.reverse();
      const topRear = V(xc, hubR.y + rr + 0.02, hubR.z - 0.05);
      const path = [topRear, ...pts.slice().reverse()].reverse();
      const prof = [[0.026, 0.0], [0.026, -0.03], [0.0245, -0.03], [0.0245, -0.0015], [-0.012, -0.0015], [-0.012, 0.0]];
      b.with(M.paintB, () => b.sweep(path.reverse(), prof.map(([x, y]) => [y, x]), { n: lod === 0 ? 30 : 14, N0: V(1, 0, 0) }));
    }
  }
  // ---- rear rack
  if (X.rack) {
    const y = 2 * R + 0.075, z0 = hubR.z - 0.13, z1 = hubR.z + 0.25, hw = 0.07;
    const rm = spec.id === 'ebike' ? M.anodBlack : (spec.id === 'dutch' ? M.paintA : M.alloy);
    const rt = 0.0052, seg = lod === 2 ? 4 : 6;
    b.with(rm, () => {
      for (const sx of [-1, 1]) {
        b.tube([V(sx * hw, y, z0), V(sx * hw, y, z1 - 0.02), V(sx * hw * 0.7, y, z1)], rt, seg, { n: 4 });
        // legs down to the dropout eyelets
        const eye = V(sx * (W.old[1] / 2 + 0.006), hubR.y + 0.012, hubR.z + 0.01);
        b.tube([V(sx * hw, y, z1 - 0.03), eye], rt, seg, { n: 1 });
        b.tube([V(sx * hw, y, hubR.z + 0.06), eye.clone().add(V(0, 0.01, -0.005))], rt, seg, { n: 1 });
        // front stays to the seat stays
        const ss = ctx.ssAt(sx, y - 0.075);
        b.tube([V(sx * hw, y, z0 + 0.01), ss], 0.0035, 4, { n: 1 });
      }
      b.tube([V(-hw * 0.7, y, z1), V(hw * 0.7, y, z1)], rt, seg, { n: 1 });
      for (const z of lod === 2 ? [z0] : [z0, z0 + 0.12, z0 + 0.24]) b.tube([V(-hw, y, z), V(hw, y, z)], 0.0042, seg, { n: 1 });
      if (lod < 2) b.tube([V(0, y, z0), V(0, y, z1)], 0.0042, seg, { n: 1 });
    });
    if (X.battery === 'rack') b.with(M.battery, () => b.rbox(0.045, 0.028, 0.16, 0.012, M4([0, y + 0.03, (z0 + z1) / 2]), 2));
    if (X.lightR === 'rack' && lod < 2) b.with(M.reflRed, () => b.rbox(0.04, 0.012, 0.006, 0.004, M4([0, y - 0.004, z1 + 0.008]), 1));
  }
  if (X.lightR === 'post' && lod < 2) {
    const p = stTop.clone().addScaledVector(seatDir, 0.06).add(V(0, 0, 0.022));
    b.with({ ...M.reflRed, piece: PIECE.SADDLE, aux: [0, seatDir.y, seatDir.z, 0] }, () => b.rbox(0.013, 0.025, 0.01, 0.005, M4([p.x, p.y, p.z]), 1));
  }
  // ---- front basket (bar-mounted, steers)
  if (X.basket && ctx.barClamp) {
    const c = ctx.barClamp;
    const bw = 0.34, bd = 0.25, bh = 0.22;
    const zc = c.z - 0.06 - bd / 2, yTop = c.y - 0.03, yBot = yTop - bh;
    const st = { piece: PIECE.STEER, aux: steerAux };
    b.with(st, () => {
      basket(ctx, V(0, (yTop + yBot) / 2, zc), bw, bh, bd);
      // brackets to the bar and struts to the fork ends
      b.with(M.wire, () => {
        for (const sx of [-1, 1]) {
          b.tube([V(sx * 0.06, yTop, zc + bd / 2), V(sx * 0.06, c.y, c.z - 0.01)], 0.003, 4, { n: 1 });
          if (lod < 2) b.tube([V(sx * 0.1, yBot, zc - 0.02), V(sx * (W.old[0] / 2 + 0.004), hubF.y + 0.01, hubF.z - 0.005)], 0.0028, 4, { n: 1 });
        }
      });
    });
  }
  // ---- lamps
  if (X.lightF && lod < 2) {
    let p;
    if (X.lightF === 'crown') p = L.crown.clone().add(V(0, 0.01, -0.045));
    else p = ctx.barClamp.clone().add(V(0, -0.025, -0.04));
    // lamp body built around Y, turned to face forward
    const m = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(p);
    b.with({ piece: PIECE.STEER, aux: steerAux }, () => {
      b.xform(m, () => {
        b.with(spec.id === 'dutch' ? M.chrome : M.plasticGloss, () => b.revolveY(V(0, 0, 0), [[0.0001, -0.04], [0.016, -0.036], [0.02, -0.01], [0.021, 0.018]], 14));
        b.with(M.lens, () => b.revolveY(V(0, 0, 0), [[0.0205, 0.018], [0.014, 0.022], [0.0001, 0.023]], 14));
      });
      b.with(M.steel, () => b.tube([p.clone().add(V(0, -0.012, 0.012)), p.clone().add(V(0, -0.02, 0.04))], 0.003, 4, { n: 1 }));
    });
  }
  // ---- kickstand (left, behind the bottom bracket)
  if (X.stand) {
    const piv = V(-0.045, bb.y + 0.012, bb.z + 0.075);
    const down = V(-0.19, 0.03, bb.z + 0.2);
    const up = V(-0.058, bb.y + 0.035, bb.z + 0.29);
    const sm = { ...M.alloy, col: [0.5, 0.5, 0.52], rough: 0.42 };
    b.with({ ...sm, piece: PIECE.STAND_DOWN, piv: [piv.x, piv.y, piv.z] }, () => {
      b.tube([piv, down], (t) => 0.0085 - 0.003 * t, 6, { n: 1, caps: [null, 'round'] });
      b.rbox(0.016, 0.004, 0.022, 0.003, M4([down.x - 0.004, 0.006, down.z]), 1);
    });
    b.with({ ...sm, piece: PIECE.STAND_UP, piv: [piv.x, piv.y, piv.z] }, () => b.tube([piv, up], (t) => 0.0085 - 0.003 * t, 6, { n: 1, caps: [null, 'round'] }));
    b.with(sm, () => b.rbox(0.012, 0.012, 0.02, 0.004, M4([piv.x + 0.008, piv.y, piv.z]), 1));
  }
  // ---- e-bike: motor and down-tube battery
  if (X.motor === 'mid') {
    b.with(M.battery, () => {
      b.revolveX(V(0, bb.y + 0.01, bb.z - 0.02), [[0.046, 0.02], [0.046, 0.068], [0.04, 0.078], [-0.04, 0.078], [-0.046, 0.068], [-0.046, 0.02]], lod === 2 ? 10 : 24);
      for (const sx of [-1, 1]) b.revolveX(V(sx * 0.046, bb.y + 0.01, bb.z - 0.02), sx > 0 ? [[0, 0.0001], [0, 0.068]] : [[0, 0.068], [0, 0.0001]], lod === 2 ? 10 : 24);
    });
  }
  if (X.battery === 'down' && ctx.downPath) {
    const curve = new THREE.CatmullRomCurve3(ctx.downPath, false, 'centripetal');
    const t0 = 0.08, t1 = 0.52;
    const pts = [];
    for (let i = 0; i <= 8; i++) pts.push(curve.getPointAt(t0 + ((t1 - t0) * i) / 8));
    const off = spec.frame.r.dt + 0.034;
    const shifted = pts.map((p, i) => {
      const t = curve.getTangentAt(t0 + ((t1 - t0) * i) / 8);
      const up = V(0, 1, 0).addScaledVector(t, -t.y).normalize();
      return p.clone().addScaledVector(up, off);
    });
    b.with({ ...M.paintA, rough: 0.35, w: 0.5 }, () => b.sweep(shifted, roundRect(0.036, 0.041, 0.018, lod ? 2 : 4), { n: lod === 2 ? 4 : 10, N0: V(1, 0, 0), caps: ['round', 'round'] }));
  }
  // ---- bottle cage + bottle (on the down tube)
  if (X.bottle && lod < 2) {
    const dtF = L.htBot.clone().addScaledVector(L.axis, 0.03);
    const a = dtF.clone().lerp(bb, 0.38), c2 = dtF.clone().lerp(bb, 0.7);
    const dir = c2.clone().sub(a).normalize();
    const up = V(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
    const base = a.clone().addScaledVector(up, spec.frame.r.dt + 0.04);
    const top = c2.clone().addScaledVector(up, spec.frame.r.dt + 0.04);
    b.with(M.plasticGloss, () => b.tube([top, base], (t) => (t < 0.85 ? 0.036 : 0.036 - (t - 0.85) * 0.13), 12, { n: 4, caps: ['flat', 'round'] }));
  }
  // ---- rim / disc brakes (visual)
  if (lod < 2) brakes(ctx);
}

function stadium(cA, rA, cB, rB, n) {
  // closed outline around two circles in (y, z) with outward normals: [y, z, ny, nz]
  const dy = cB[0] - cA[0], dz = cB[1] - cA[1];
  const D = Math.hypot(dy, dz);
  const base = Math.atan2(dz, dy);
  const off = Math.acos(Math.max(-1, Math.min(1, (rA - rB) / D)));
  const out = [];
  // around circle A (the far side from B), then circle B
  const arc = (c, r, a0, a1, k) => { for (let i = 0; i < k; i++) { const a = a0 + ((a1 - a0) * i) / k; out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, Math.cos(a), Math.sin(a)]); } };
  const kA = Math.ceil(n * 0.6), kB = n - kA;
  arc(cA, rA, base + off, base + Math.PI * 2 - off, kA);
  arc(cB, rB, base - off, base + off, kB);
  return out;
}

function basket(ctx, c, w, h, d) {
  const { b, lod } = ctx;
  const x0 = c.x - w / 2, x1 = c.x + w / 2, y0 = c.y - h / 2, y1 = c.y + h / 2, z0 = c.z - d / 2, z1 = c.z + d / 2;
  const cell = 0.026;
  // mesh panels (two-sided grids, alpha to coverage)
  const panel = (A, B, C, Dd) => {
    // A-B along u, A-D along v
    const lu = A.distanceTo(B), lv = A.distanceTo(Dd);
    const rows = [[A, Dd], [B, C]];
    b.with(M.mesh, () => b.surface(rows, { twoSided: true, uv: (I, J) => [(I * lu) / cell, (J * lv) / cell] }));
  };
  const p = (x, y, z) => V(x, y, z);
  panel(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0));   // front
  panel(p(x1, y0, z1), p(x0, y0, z1), p(x0, y1, z1), p(x1, y1, z1));   // back
  panel(p(x0, y0, z1), p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1));   // left
  panel(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0));   // right
  panel(p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0), p(x0, y0, z0));   // bottom
  // rim wires
  const seg = lod === 2 ? 3 : 5;
  b.with(M.wire, () => {
    for (const y of [y0, y1]) b.tube([p(x0, y, z0), p(x1, y, z0), p(x1, y, z1), p(x0, y, z1), p(x0, y, z0)], y === y1 ? 0.0032 : 0.0025, seg, { n: 4 });
    if (lod < 2) for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) b.tube([p(x, y0, z), p(x, y1, z)], 0.0025, seg, { n: 1 });
  });
}

function brakes(ctx) {
  const { b, spec, L } = ctx;
  const kind = spec.extras.brakes;
  const W = spec.wheel;
  const { hubF, hubR, R, steerAux } = L;
  if (kind === 'caliper') {
    // dual pivot calipers hanging from the fork crown and the seat stay bridge
    for (const [hub, piece, top] of [[hubF, { piece: PIECE.STEER, aux: steerAux }, L.crown.clone().add(V(0, -0.01, 0.0))], [hubR, {}, V(0, hubR.y + R + 0.03, hubR.z - 0.04)]]) {
      b.with({ ...M.alloyPolish, ...piece }, () => {
        for (const sx of [-1, 1]) {
          const pad = V(sx * (W.rimW / 2 + 0.006), hub.y + W.bead - 0.006, hub.z - 0.012);
          b.tube([top.clone().add(V(sx * 0.012, 0.0, 0)), top.clone().add(V(sx * 0.03, -0.01, -0.01)), pad], 0.004, 5, { n: 6 });
          b.with(M.rubber, () => b.rbox(0.003, 0.006, 0.018, 0.002, M4([pad.x, pad.y, pad.z]), 1));
        }
      });
    }
  } else if (kind === 'v') {
    for (const [hub, piece, front] of [[hubF, { piece: PIECE.STEER, aux: steerAux }, true], [hubR, {}, false]]) {
      b.with({ ...M.alloy, ...piece }, () => {
        const ang = front ? 0.25 : -0.25;
        for (const sx of [-1, 1]) {
          const boss = V(sx * (W.rimW / 2 + 0.014), hub.y + Math.cos(ang) * (W.bead - 0.02), hub.z - Math.sin(ang) * (W.bead - 0.02));
          const topP = boss.clone().add(V(sx * 0.01, 0.1, front ? -0.012 : 0.012));
          b.tube([boss, topP], 0.0045, 5, { n: 1, caps: ['round', 'round'] });
          b.with(M.rubber, () => b.rbox(0.003, 0.006, 0.018, 0.002, M4([sx * (W.rimW / 2 + 0.004), boss.y + 0.012, boss.z]), 1));
        }
        const yT = hub.y + W.bead + 0.06;
        b.with(M.plasticGloss, () => b.tube([V(-0.04, yT, hub.z - (front ? 0.04 : -0.04)), V(0, yT + 0.012, hub.z - (front ? 0.045 : -0.045)), V(0.04, yT, hub.z - (front ? 0.04 : -0.04))], 0.002, 4, { n: 6 }));
      });
    }
  } else if (kind === 'disc') {
    for (const [hub, front] of [[hubF, true], [hubR, false]]) {
      const piece = front ? PIECE.FWHEEL : PIECE.RWHEEL;
      const x = -(front ? W.old[0] : W.old[1]) / 2 + 0.015;
      b.with({ ...M.steel, rough: 0.25, piece, piv: [hub.x, hub.y, hub.z], aux: front ? steerAux : [0, 0, 0, 0] }, () => b.revolveX(V(x, hub.y, hub.z), [[0.001, 0.025], [0.001, 0.08], [-0.001, 0.08], [-0.001, 0.025]], 24));
      b.with({ ...M.anodBlack, ...(front ? { piece: PIECE.STEER, aux: steerAux } : {}) }, () => b.rbox(0.012, 0.022, 0.03, 0.006, M4([x - 0.006, hub.y + 0.06, hub.z + (front ? 0.045 : 0.05)], [0.6, 0, 0]), 1));
    }
  }
}

// ------------------------------------------------------------------ rider attachment

const _R = new THREE.Matrix3(), _v = new THREE.Vector3();

function rotX(a, v) { const c = Math.cos(a), s = Math.sin(a); return v.set(v.x, c * v.y - s * v.z, s * v.y + c * v.z); }
function rotAxis(k, a, v) {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  _R.set(t * k.x * k.x + c, t * k.x * k.y - s * k.z, t * k.x * k.z + s * k.y,
    t * k.x * k.y + s * k.z, t * k.y * k.y + c, t * k.y * k.z - s * k.x,
    t * k.x * k.z - s * k.y, t * k.y * k.z + s * k.x, t * k.z * k.z + c);
  return v.applyMatrix3(_R);
}

/** Rider contact points for a bicycle layout record (see kit): local space, at crank / steer / saddle offset. */
export function bikeAttachments(rec, crank = 0, steer = 0, saddle = 0, out = {}) {
  const L = rec.layout, A = rec.attach;
  const steerP = (p, o) => {
    o.copy(p).sub(_v.set(0, L.p0.y, L.p0.z));
    rotAxis(L.axis, steer, o);
    return o.add(_v.set(0, L.p0.y, L.p0.z));
  };
  out.gripL = steerP(A.gripL, out.gripL || new THREE.Vector3());
  out.gripR = steerP(A.gripR, out.gripR || new THREE.Vector3());
  out.gripDirL = rotAxis(L.axis, steer, (out.gripDirL || new THREE.Vector3()).copy(A.gripDirL));
  out.gripDirR = rotAxis(L.axis, steer, (out.gripDirR || new THREE.Vector3()).copy(A.gripDirR));
  out.saddle = (out.saddle || new THREE.Vector3()).copy(A.saddle).addScaledVector(L.seatDir, saddle);
  out.saddleNose = (out.saddleNose || new THREE.Vector3()).copy(A.saddleNose).addScaledVector(L.seatDir, saddle);
  const bb = L.bb;
  for (const [k, sx] of [['pedalR', 1], ['pedalL', -1]]) {
    const p = (out[k] || (out[k] = new THREE.Vector3())).set(sx * A.pedalX, sx * rec.spec.crank, 0);
    rotX(-crank, p);
    p.y += bb.y; p.z += bb.z;
  }
  out.bb = (out.bb || new THREE.Vector3()).copy(bb);
  out.hubF = (out.hubF || new THREE.Vector3()).copy(L.hubF);
  out.hubR = (out.hubR || new THREE.Vector3()).copy(L.hubR);
  out.groundF = (out.groundF || new THREE.Vector3()).set(0, 0, L.hubF.z);
  out.groundR = (out.groundR || new THREE.Vector3()).set(0, 0, L.hubR.z);
  return out;
}

/** Build a variant record (all LOD geometries + rider data). */
export function makeBikeVariant(spec) {
  const lods = [];
  let attach = null;
  let layout = null;
  for (let lod = 0; lod < 3; lod++) {
    const L = bikeLayout(spec);
    const b = new Builder();
    const ctx = { b, spec, L, Q: LODS[lod], lod };
    frame(ctx); fork(ctx); cockpit(ctx); wheels(ctx); drivetrain(ctx); seat(ctx); extras(ctx);
    const g = b.build();
    g.name = `bike.${spec.id}.lod${lod}`;
    lods.push(g);
    if (lod === 1) {
      layout = L;
      attach = {
        gripL: ctx.grips[-1].p.clone(), gripR: ctx.grips[1].p.clone(),
        gripDirL: ctx.grips[-1].dir.clone(), gripDirR: ctx.grips[1].dir.clone(),
        saddle: ctx.saddleTop.clone(), saddleNose: ctx.saddleNose.clone(),
        pedalX: ctx.crankX + 0.006 + 0.058,
      };
    }
  }
  const L = layout;
  const circumference = 2 * Math.PI * L.R;
  const lenF = L.hubF.z - L.R - (spec.extras.fenders ? 0.01 : 0) - (spec.extras.basket ? 0.02 : 0);
  const lenR = L.hubR.z + L.R + (spec.extras.rack ? 0.04 : 0);
  return {
    spec, id: spec.id, label: spec.label, lods, layout: L, attach,
    dims: {
      wheelRadius: L.R, wheelbase: spec.frame.wb, length: lenR - lenF, front: lenF, rear: lenR,
      width: Math.max(spec.bar.width + 0.06, 0.4), height: Math.max(spec.saddleH, spec.bar.h) + 0.03,
      bbHeight: L.bb.y, saddleHeight: spec.saddleH, barHeight: spec.bar.h, crankLength: spec.crank,
      metersPerCrankRev: circumference * spec.gear, saddleRange: [-0.07, 0.09], riderHeight: spec.rider,
    },
    size: Math.max(spec.saddleH, spec.bar.h) + 0.05,   // for screen-size LOD
  };
}
