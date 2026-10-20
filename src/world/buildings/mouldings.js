import { FACES } from './mesh.js';
import { setBlock, hash3 } from './shade.js';

// Moulding profiles (pairs [out, up] ordered bottom → top, out measured in front of
// the wall face) and the small repeated stone details that go with them.

const profileCache = new Map();
/** Carved curves (cymas, scrolls) shade smooth across joints turning by less than this (degrees, see mesh.sweep). */
export const CREASE = 40;
const keyOf = (...a) => a.map((x) => (typeof x === 'number' ? x.toFixed(3) : x)).join('|');

/** String course: soffit with a small drip, flat face, weathered (sloped) top. */
export function courseProfile(h, p) {
  const k = keyOf('c', h, p);
  let pr = profileCache.get(k);
  if (!pr) {
    pr = [[0, 0], [p - 0.025, 0], [p - 0.025, 0.012], [p, 0.03], [p, h - 0.05], [p - 0.035, h - 0.012], [0.02, h], [0, h + 0.004]];
    profileCache.set(k, pr);
  }
  return pr;
}

/**
 * Plinth / base course: plain projecting block with a chamfered wash on top. `ground`
 * (the paving height, optional) adds rows to the front face just above it, so the
 * splash-zone shading and the dirt line at its foot (per vertex) stay sharp.
 */
export function plinthProfile(top, p, bottom, ground = null) {
  const k = keyOf('p', top, p, bottom, ground ?? 'n');
  let pr = profileCache.get(k);
  if (!pr) {
    pr = [[p, bottom]];
    if (ground !== null) for (const d of [0.05, 0.18, 0.4]) if (ground + d > bottom + 0.01 && ground + d < top - 0.07) pr.push([p, ground + d]);
    pr.push([p, top - 0.045], [p - 0.028, top - 0.012], [0.01, top], [0, top + 0.005]);
    profileCache.set(k, pr);
  }
  return pr;
}

/**
 * Classical cornice: frieze, bed moulding (cyma reversa), dentil band, corona with a
 * drip and soffit, cyma recta, top fillet. H = height, P = projection.
 * Returns {profile, dentil: {v0, v1, w0, w1}, soffit: {v, w0, w1}} for the add-ons.
 */
export function corniceProfile(H, P) {
  const k = keyOf('k', H, P);
  let r = profileCache.get(k);
  if (r) return r;
  const pr = [];
  const add = (o, u) => pr.push([o, u * H]);
  {
    add(0, 0); add(0.035, 0); add(0.035, 0.28);              // frieze
    add(0.05, 0.3); add(0.05, 0.33);                          // fillet
    // cyma reversa bed moulding
    const b0 = 0.05, b1 = 0.24 * P + 0.05;
    for (let i = 1; i <= 8; i++) { const t = i / 8; const s = t - Math.sin(t * Math.PI * 2) / (Math.PI * 2) * 0.6; add(b0 + (b1 - b0) * s, 0.33 + 0.13 * t); }
    add(b1, 0.5);                                              // dentil band face
    add(b1 + 0.01, 0.6);
    add(0.86 * P, 0.6);                                        // corona soffit
    add(0.86 * P, 0.585); add(0.89 * P, 0.585);                // drip groove lip
    add(0.89 * P, 0.6); add(0.9 * P, 0.61);
    add(0.9 * P, 0.78);                                        // corona face
    add(0.92 * P, 0.8);
    // cyma recta
    const c0 = 0.92 * P, c1 = P;
    for (let i = 1; i <= 8; i++) { const t = i / 8; const s = t + Math.sin(t * Math.PI * 2) / (Math.PI * 2) * 0.7; add(c0 + (c1 - c0) * s, 0.8 + 0.15 * t); }
    add(P, 0.985); add(P - 0.01, 1);
    add(0, 1.0);
  }
  r = {
    profile: pr,
    dentil: { v0: 0.5 * H, v1: 0.6 * H, w0: 0.24 * P + 0.05, w1: 0.24 * P + 0.05 + Math.min(0.11, 0.18 * P) },
    soffit: { v: 0.6 * H, w0: 0.24 * P + 0.06, w1: 0.86 * P },
  };
  profileCache.set(k, r);
  return r;
}

/** Row of dentils under the corona along u ∈ [u0, u1] (front face only; `full` adds the sides). */
export function dentils(B, s, u0, u1, y, d, full = true) {
  const step = 0.17, w = 0.095;
  const n = Math.floor((u1 - u0 - 0.1) / step);
  const off = u0 + (u1 - u0 - n * step) / 2;
  s.reserve(n * 16, n * 24);
  for (let i = 0; i <= n; i++) {
    const a = off + i * step - w / 2;
    B.box(s, a, a + w, y + d.v0, y + d.v1, d.w0 - 0.01, d.w1, full ? FACES.FRONT | FACES.LEFT | FACES.RIGHT | FACES.BOTTOM : FACES.FRONT | FACES.BOTTOM);
  }
}

/** Scroll consoles (modillions) under the corona soffit. */
export function modillions(B, s, u0, u1, y, H, P, spacing, full = true) {
  const prof = full ? modillionProfile(H, P) : modillionSimple(H, P);
  const n = Math.max(1, Math.round((u1 - u0) / spacing));
  const st = (u1 - u0) / n, w = Math.min(0.16, st * 0.35);
  for (let i = 0; i <= n; i++) {
    const c = u0 + i * st;
    if (c - w / 2 < u0 - 0.01 || c + w / 2 > u1 + 0.01) continue;
    B.sweep(s, prof, [[c - w / 2, 0], [c + w / 2, 0]], y, [true, true], 0, full ? CREASE : 0, true);
  }
}
function modillionSimple(H, P) {
  const k = keyOf('ms', H, P);
  let pr = profileCache.get(k);
  if (pr) return pr;
  const b = 0.24 * P + 0.05, e = 0.84 * P;
  pr = [[b, 0.36 * H], [b + (e - b) * 0.6, 0.45 * H], [e, 0.55 * H], [b, 0.6 * H]];
  profileCache.set(k, pr);
  return pr;
}
function modillionProfile(H, P) {
  const k = keyOf('m', H, P);
  let pr = profileCache.get(k);
  if (pr) return pr;
  const b = 0.24 * P + 0.05, e = 0.84 * P;
  pr = [[b, 0.36 * H], [b + 0.06, 0.37 * H], [b + (e - b) * 0.45, 0.43 * H], [b + (e - b) * 0.75, 0.47 * H], [e - 0.03, 0.5 * H], [e, 0.55 * H], [e - 0.01, 0.6 * H], [b, 0.6 * H]];
  profileCache.set(k, pr);
  return pr;
}

/**
 * Quoins up one vertical corner of the facade: alternating long and short dressed
 * blocks with chamfered joints. side: 0 → corner at u = 0, 1 → corner at u = W.
 * wrap: the blocks turn the corner (the front block reaches round the arris by its
 * projection); opts.retFace also dresses the return face (a square corner seen from the
 * side), opts.parity starts the long/short alternation on the other foot (the column on
 * an angled corner return interlocks with the front's), opts.flat: front faces only (far).
 */
export function quoins(B, s, W, side, v0, v1, qh, q, wrap, bev, opts = {}) {
  const joint = 0.012, seed = opts.seed | 0;
  const mb = bev > 0 ? Math.max(bev, 0.022) : 0;   // drafted margin
  const retFace = wrap && opts.retFace !== false;
  let v = v0, i = opts.parity || 0;
  while (v + qh * 0.6 < v1) {
    const top = Math.min(v1, v + qh) - joint;
    const long = i % 2 === 0;
    const fw = long ? q.long : q.short;      // width on the front face
    const sw = long ? q.short : q.long;      // depth on the return face
    // each block its own tone, tooling and (by a few millimetres) face plane
    const h = hash3(seed, i, side);
    setBlock(h);
    B.setUV(1, h * 7.3, 1, h * 5.1);
    const p = q.proj + (h - 0.5) * 0.006;
    bev = mb;
    if (opts.flat) B.rectW(s, side ? W - fw : 0, side ? W : fw, v, top, p, 1);
    else if (side === 0) {
      B.bevelBox(s, -(wrap ? p : 0), fw, v, top, 0, p, bev, FACES.ALL & ~FACES.BACK);
      if (retFace) B.box(s, -p, 0, v, top, -sw, 0, FACES.LEFT | FACES.TOP | FACES.BOTTOM | FACES.BACK);
    } else {
      B.bevelBox(s, W - fw, W + (wrap ? p : 0), v, top, 0, p, bev, FACES.ALL & ~FACES.BACK);
      if (retFace) B.box(s, W, W + p, v, top, -sw, 0, FACES.RIGHT | FACES.TOP | FACES.BOTTOM | FACES.BACK);
    }
    v += qh; i++;
  }
  setBlock(-1);
  B.setUV();
}

/** Pilaster: shaft with base and a small moulded capital. */
export function pilaster(B, s, uc, w, p, v0, v1, bev, detail) {
  const u0 = uc - w / 2, u1 = uc + w / 2;
  const baseH = 0.28, capH = 0.32;
  B.bevelBox(s, u0 - 0.04, u1 + 0.04, v0, v0 + baseH, 0, p + 0.04, bev, FACES.ALL & ~FACES.BOTTOM);
  B.bevelBox(s, u0, u1, v0 + baseH, v1 - capH, 0, p, bev, FACES.FRONT | FACES.LEFT | FACES.RIGHT);
  if (detail) B.extrudeU(s, capitalProfile(capH, p), u0 - 0.03, u1 + 0.03, v1 - capH, [true, true]);
  else B.box(s, u0 - 0.05, u1 + 0.05, v1 - capH, v1, 0, p + 0.06, FACES.ALL & ~FACES.BACK);
}
function capitalProfile(h, p) {
  const k = keyOf('cap', h, p);
  let pr = profileCache.get(k);
  if (!pr) {
    pr = [[p, 0], [p + 0.015, 0.04], [p + 0.015, 0.07], [p + 0.03, 0.1], [p + 0.06, 0.18], [p + 0.07, 0.2], [p + 0.07, h], [0, h]];
    profileCache.set(k, pr);
  }
  return pr;
}
