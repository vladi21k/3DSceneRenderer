import { RNG } from '../core/rng.js';

// Facade plan: the architectural description of one building front, shared by the
// building shell generator (masonry) and the facade infill/attachment generators
// (windows, shopfronts, balconies, awnings…). Pure data, deterministic per lot.
//
// Facade-local coordinates (metres):
//   u  along the facade, 0 at the viewer-left end when looking at it from the street
//   v  up, 0 = plan.floorRef (the higher of the two ground heights at the ends)
//   w  out of the wall towards the street (+), into the building (−)
// lot.frame.matrix maps (u, v, w) → world.
//
// Late-Ottoman / Mandate-era limestone commercial street: 4–6 storeys, ashlar
// courses, arched shop openings, upper windows (flat / round / pointed tops),
// wrought-iron balconies on stone corbels, cornice + parapet, some tiled roofs.

const STONE_TINTS = [
  [0.86, 0.80, 0.68], // cream
  [0.84, 0.74, 0.58], // honey
  [0.88, 0.83, 0.74], // pale
  [0.82, 0.75, 0.66], // pinkish buff
  [0.80, 0.77, 0.70], // grey limestone
  [0.87, 0.78, 0.62], // golden
];

const cache = new Map();

export function facadePlan(lot) {
  if (cache.has(lot.id)) return cache.get(lot.id);
  const rng = new RNG(lot.seed);
  const width = lot.frame.width;
  const g0 = lot.frame.ground0 - lot.frame.floorRef; // ≤ 0
  const g1 = lot.frame.ground1 - lot.frame.floorRef;

  // ---- style
  const era = rng.weighted([['ottoman', 0.45], ['mandate', 0.4], ['modern', 0.15]]);
  const style = {
    era,
    tint: rng.pick(STONE_TINTS).map((c) => c * rng.range(0.96, 1.03)),
    courseH: rng.range(0.30, 0.42),          // ashlar course height
    blockL: rng.range(0.55, 0.95),           // average block length
    tooled: rng.chance(0.7),                 // chisel-dressed faces (Jerusalem "taltish")
    rusticGround: rng.chance(0.45),          // rusticated ground floor
    quoins: rng.chance(0.4),
    pilasters: era !== 'modern' && rng.chance(0.3),
    surrounds: rng.chance(0.65),             // smooth stone window surrounds
    windowTop: era === 'ottoman' ? rng.weighted([['round', 0.45], ['pointed', 0.2], ['segment', 0.2], ['flat', 0.15]])
      : era === 'mandate' ? rng.weighted([['flat', 0.6], ['round', 0.25], ['segment', 0.15]]) : 'flat',
    shopTop: rng.weighted([['round', 0.45], ['flat', 0.4], ['segment', 0.15]]),
    frameColor: rng.pick(['darkgreen', 'brown', 'white', 'grey', 'black', 'teal', 'brown']),
    shutterColor: rng.pick(['darkgreen', 'brown', 'grey', 'teal', 'white']),
  };

  // ---- floors
  const nFloors = rng.weighted([[4, 0.35], [5, 0.35], [6, 0.18], [3, 0.07], [7, 0.05]]);
  const groundH = rng.range(4.4, 5.4);
  const typH = era === 'modern' ? rng.range(3.0, 3.3) : rng.range(3.4, 3.9);
  const floors = [];
  let y = 0;
  for (let i = 0; i < nFloors; i++) {
    const h = i === 0 ? groundH : (i === nFloors - 1 && rng.chance(0.25) ? typH * 0.85 : typH);
    floors.push({ index: i, y, h, kind: i === 0 ? 'ground' : (i === nFloors - 1 ? 'top' : 'typical') });
    y += h;
  }
  const corniceH = rng.range(0.45, 0.8);
  const cornice = { y, h: corniceH, proj: rng.range(0.25, 0.6), dentils: era !== 'modern' && rng.chance(0.5) };
  y += corniceH;
  const parapet = { y, h: rng.range(0.6, 1.1), type: rng.weighted([['solid', 0.6], ['balustrade', 0.25], ['crenel', 0.15]]) };
  y += parapet.h;
  const roof = rng.chance(era === 'ottoman' ? 0.3 : 0.12)
    ? { type: 'tile', pitch: rng.range(22, 32), color: rng.pick(['terracotta', 'terracotta', 'darkred']) }
    : { type: 'flat' };
  const totalHeight = y;

  // ---- bays
  const pierL = rng.range(0.6, 1.1), pierR = rng.range(0.6, 1.1);
  const inner = Math.max(1, width - pierL - pierR);
  const bayTarget = era === 'modern' ? rng.range(3.0, 3.6) : rng.range(3.0, 4.0);
  const nBays = Math.max(1, Math.round(inner / bayTarget));
  const bayW = inner / nBays;
  const bays = [];
  for (let i = 0; i < nBays; i++) {
    const u0 = pierL + i * bayW;
    bays.push({ index: i, u0, u1: u0 + bayW, uc: u0 + bayW / 2, w: bayW });
  }

  // ---- openings
  const openings = [];
  const shopTop = style.shopTop;
  const doorBay = nBays > 2 ? rng.int(0, nBays - 1) : -1;
  for (const b of bays) {
    // ground floor: shopfront or entrance door
    const isDoor = b.index === doorBay;
    const w = isDoor ? Math.min(1.6, b.w - 0.9) : Math.max(1.2, b.w - rng.range(0.55, 0.9));
    const h = isDoor ? Math.min(groundH - 0.9, 3.2) : groundH - rng.range(0.7, 1.0);
    openings.push({
      id: `${lot.id}:g${b.index}`, floor: 0, bay: b.index, uc: b.uc, w, y: 0, h,
      top: isDoor ? (shopTop === 'round' ? 'round' : 'flat') : shopTop,
      kind: isDoor ? 'door' : 'shop', recess: rng.range(0.25, 0.45),
      awning: !isDoor && rng.chance(0.35) ? { type: rng.pick(['slope', 'slope', 'dutch']), color: null } : null,
      lit: rng.range(0.6, 1.0),
    });
  }
  // upper floors
  const paired = era === 'ottoman' && rng.chance(0.2);
  for (const f of floors) {
    if (f.index === 0) continue;
    const top = f.kind === 'top' && rng.chance(0.3) ? 'flat' : style.windowTop;
    const winW = Math.min(bayTarget * 0.42, rng.range(1.05, 1.4));
    const winH = Math.min(f.h - 1.15, rng.range(1.9, 2.4) + (top === 'round' || top === 'pointed' ? winW * 0.3 : 0));
    for (const b of bays) {
      const win = {
        id: `${lot.id}:f${f.index}b${b.index}`, floor: f.index, bay: b.index, uc: b.uc,
        w: paired ? winW * 1.5 : winW, y: f.y + rng.range(0.8, 0.95), h: winH, top, paired,
        kind: 'window', recess: rng.range(0.18, 0.3),
        shutters: rng.chance(0.25) ? (rng.chance(0.5) ? 'open' : 'closed') : null,
        lit: rng.next(), // threshold vs uNight to decide which windows are lit at dusk
        curtain: rng.chance(0.5),
        ac: rng.chance(0.08),   // split AC unit hanging under the window
        flowerBox: rng.chance(0.07),
      };
      openings.push(win);
    }
  }

  // ---- balconies
  const balconies = [];
  const balFloors = floors.filter((f) => f.index >= 1 && f.index < nFloors);
  const balStyle = rng.weighted([['bays', 0.5], ['continuous', 0.25], ['center', 0.15], ['none', 0.1]]);
  for (const f of balFloors) {
    if (balStyle === 'none') break;
    if (f.kind === 'top' && rng.chance(0.5)) continue;
    const slab = f.y + 0.02;
    if (balStyle === 'continuous' && (f.index === 1 || rng.chance(0.4))) {
      balconies.push({ floor: f.index, u0: bays[0].u0 + 0.1, u1: bays[nBays - 1].u1 - 0.1, depth: rng.range(0.8, 1.15), y: slab, railing: rng.chance(0.85) ? 'iron' : 'stone', corbels: Math.max(2, nBays + 1), slabT: 0.16 });
    } else if (balStyle === 'center' && nBays >= 3) {
      const c = Math.floor(nBays / 2);
      balconies.push({ floor: f.index, u0: bays[c].u0 + 0.15, u1: bays[c].u1 - 0.15, depth: rng.range(0.8, 1.1), y: slab, railing: 'iron', corbels: 2, slabT: 0.16 });
    } else {
      for (const b of bays) {
        if (!rng.chance(0.55)) continue;
        balconies.push({ floor: f.index, u0: b.uc - Math.min(b.w * 0.42, 1.25), u1: b.uc + Math.min(b.w * 0.42, 1.25), depth: rng.range(0.6, 1.0), y: slab, railing: rng.chance(0.9) ? 'iron' : 'stone', corbels: 2, slabT: 0.15 });
      }
    }
  }
  // windows with a balcony become French doors down to the slab
  for (const bal of balconies) {
    for (const o of openings) {
      if (o.floor === bal.floor && o.kind === 'window' && o.uc > bal.u0 && o.uc < bal.u1) {
        const f = floors[o.floor];
        o.kind = 'balconyDoor';
        o.h = o.y + o.h - (f.y + 0.05);
        o.y = f.y + 0.05;
        o.balcony = balconies.indexOf(bal);
      }
    }
  }

  // ---- string courses (sill bands) and signage
  const courses = floors.slice(1).map((f) => ({ y: f.y - 0.05, h: rng.range(0.18, 0.3), proj: rng.range(0.04, 0.12) }));
  const signs = [];
  if (rng.chance(0.7)) {
    const signY = groundH - 0.75;
    for (const b of bays) {
      if (b.index === doorBay) continue;
      if (rng.chance(0.65)) signs.push({ kind: 'fascia', u0: b.u0 + 0.2, u1: b.u1 - 0.2, y: signY, h: 0.55, seed: (rng.next() * 1e9) | 0 });
    }
  }
  if (rng.chance(0.35)) signs.push({ kind: 'blade', u: bays[rng.int(0, nBays - 1)].u0, y: groundH + 0.6, h: 0.9, w: 0.6, seed: (rng.next() * 1e9) | 0 });
  const flags = rng.chance(0.15) ? [{ u: width * rng.range(0.3, 0.7), y: floors[Math.min(2, nFloors - 1)].y + 1.6 }] : [];

  // ---- rooftop clutter (solar water heaters, tanks, AC units, antennas)
  const rooftop = [];
  if (roof.type === 'flat') {
    const n = rng.int(0, Math.max(1, Math.floor(width / 6)));
    for (let i = 0; i < n; i++) rooftop.push({ type: rng.weighted([['solarHeater', 0.45], ['tank', 0.2], ['ac', 0.2], ['antenna', 0.15]]), u: rng.range(1, width - 1), w: -rng.range(1.5, lot.depth - 2), yaw: rng.range(-0.2, 0.2) });
  }

  const plan = {
    lotId: lot.id, seed: lot.seed, width, depth: lot.depth, side: lot.side,
    groundAt: (u) => g0 + (g1 - g0) * (u / width), // paving height relative to v = 0
    ground0: g0, ground1: g1,
    floors, bays, pierL, pierR, openings, balconies, courses, cornice, parapet, roof, rooftop,
    signs, flags, style, totalHeight,
    cornerU0: !!lot.cornerU0, cornerU1: !!lot.cornerU1, sideStreet: !!lot.sideStreet,
  };
  // Extensions (own RNG streams so the values above never shift):
  followSlope(plan);                       // ground-floor sills step down with the street
  for (const o of openings) setArch(o);    // o.rise / o.spring for every opening head
  plan.returns = [];                       // street facades on the side-street returns of corner lots
  if (plan.cornerU0) plan.returns.push(returnPlan(lot, plan, 0));
  if (plan.cornerU1) plan.returns.push(returnPlan(lot, plan, 1));
  cache.set(lot.id, plan);
  return plan;
}

// ------------------------------------------------------------------ arches (shared geometry)
// An opening spans u ∈ [uc − w/2, uc + w/2], v ∈ [y, y + h]. Its head is an arch of
// `rise` above the spring line `spring = y + h − rise`:
//   flat     rise 0
//   segment  rise ≈ 0.17 w (arc of a large circle centred below the spring line)
//   round    rise = w / 2 (semicircle)
//   pointed  rise ≈ 0.62 w (two-centred arch, centres 0.134 w either side of the axis)

const POINTED_C = 0.1344, POINTED_RISE = 0.62, SEGMENT_RISE = 0.17;

export function archRise(top, w) {
  return top === 'round' ? w / 2 : top === 'pointed' ? w * POINTED_RISE : top === 'segment' ? w * SEGMENT_RISE : 0;
}

function setArch(o) {
  const full = archRise(o.top, o.w);
  o.rise = Math.min(full, Math.max(0, o.h - 0.3));
  // a head that does not fit becomes a round arch (pointed heads) or a segmental arch of
  // the available rise (the segment construction needs rise ≤ w/2)
  if (o.top !== 'flat' && o.rise < full - 1e-6) {
    if (o.rise >= o.w / 2) { o.top = 'round'; o.rise = o.w / 2; }
    else o.top = o.rise > 0.05 ? 'segment' : 'flat';
  }
  if (o.top === 'flat') o.rise = 0;
  o.spring = o.y + o.h - o.rise;
}

/**
 * Point on an opening's head at t ∈ [0, 1] (0 = left spring, 0.5 = apex, 1 = right spring).
 * Writes {u, v, ru, rv} where (ru, rv) is the outward radial direction (unit), used for
 * voussoir joints and soffit normals. `offset` moves the point outwards along the radial.
 */
export function archPoint(o, t, out = {}, offset = 0) {
  const w = o.w, uc = o.uc, ys = o.spring;
  let cu, cv, R, a;
  if (o.top === 'round') {
    R = w / 2; cu = uc; cv = ys; a = Math.PI * (1 - t);
  } else if (o.top === 'segment') {
    const r = o.rise || w * SEGMENT_RISE;
    R = (w * w / 4 + r * r) / (2 * r); cu = uc; cv = ys + r - R;
    const al = Math.asin(Math.min(1, (w / 2) / R));
    a = Math.PI / 2 + al * (1 - 2 * t);
  } else if (o.top === 'pointed') {
    const c = POINTED_C * w; R = w / 2 + c;
    const th = Math.acos(-c / R);
    if (t <= 0.5) { cu = uc + c; cv = ys; a = Math.PI + (th - Math.PI) * (t / 0.5); }
    else { cu = uc - c; cv = ys; a = (Math.PI - th) * (1 - (t - 0.5) / 0.5); }
  } else {
    out.u = uc - w / 2 + w * t; out.v = ys + offset; out.ru = 0; out.rv = 1;
    return out;
  }
  const ca = Math.cos(a), sa = Math.sin(a);
  out.u = cu + (R + offset) * ca; out.v = cv + (R + offset) * sa; out.ru = ca; out.rv = sa;
  return out;
}

/** Outline of an opening as a flat [u, v, ...] array, CCW seen from the street, `n` head segments. */
export function openingOutline(o, n = 12) {
  const u0 = o.uc - o.w / 2, u1 = o.uc + o.w / 2;
  const pts = [u0, o.y, u1, o.y];
  if (o.top === 'flat' || !o.rise) { pts.push(u1, o.y + o.h, u0, o.y + o.h); return pts; }
  const p = {};
  for (let i = n; i >= 0; i--) { archPoint(o, i / n, p); pts.push(p.u, p.v); }
  return pts;
}

// ------------------------------------------------------------------ slope
// The paving drops along sloping facades (groundAt(u) < 0 at the low end). Ground-floor
// openings keep their heads aligned but their sills step down to the local paving, as
// real shopfronts on a sloping street do.
function followSlope(plan) {
  for (const o of plan.openings) {
    if (o.floor !== 0) continue;
    const u0 = o.uc - o.w / 2, u1 = o.uc + o.w / 2;
    const gHigh = Math.max(plan.groundAt(u0), plan.groundAt(u1));
    const sill = gHigh + (o.kind === 'door' ? 0.14 : 0.03);   // threshold / shop sill above the paving
    if (sill < o.y - 0.005) {
      const top = o.y + o.h;
      o.y = sill;
      o.h = top - sill;
    }
  }
}

// ------------------------------------------------------------------ corner returns
// Corner lots turn the corner into the side street. The return is described as a
// plan-like object with its own facade frame (same conventions as lot.frame: u to the
// viewer's right, v up from the main floorRef, w out of the wall) so facade infill can
// be generated for it exactly like a front: {isReturn, end, frame, width, floors, bays,
// openings, balconies, courses, groundAt, ...}.
function returnPlan(lot, plan, end) {
  const f = lot.frame, depth = lot.depth;
  const rng = RNG.from(lot.seed, 'return', end);
  // Return frame axes in world space. End 0 (u = 0): the wall faces −uDir and its own
  // u runs along +nDir (back → street). End 1 (u = width): faces +uDir, u runs along −nDir.
  const uDir = end === 0 ? f.nDir.clone() : f.nDir.clone().negate();
  const nDir = end === 0 ? f.uDir.clone().negate() : f.uDir.clone();
  const origin = f.origin.clone()
    .addScaledVector(f.uDir, end === 0 ? 0 : f.width)
    .addScaledVector(f.nDir, end === 0 ? -depth : 0);
  const up = f.up.clone();
  const matrix = f.matrix.clone().makeBasis(uDir, up, nDir).setPosition(origin);
  const g = end === 0 ? plan.ground0 : plan.ground1;
  const frame = { origin, uDir, nDir, up, width: depth, ground0: g + f.floorRef, ground1: g + f.floorRef, floorRef: f.floorRef, matrix };
  const width = depth;
  // the street corner is at u = width for end 0 and u = 0 for end 1
  const cornerAtU1 = end === 0;
  const pierCorner = rng.range(1.1, 1.6), pierBack = rng.range(0.9, 1.4);
  const pierL = cornerAtU1 ? pierBack : pierCorner, pierR = cornerAtU1 ? pierCorner : pierBack;
  const inner = Math.max(1, width - pierL - pierR);
  const nBays = Math.max(1, Math.round(inner / rng.range(3.1, 3.9)));
  const bayW = inner / nBays;
  const bays = [];
  for (let i = 0; i < nBays; i++) { const u0 = pierL + i * bayW; bays.push({ index: i, u0, u1: u0 + bayW, uc: u0 + bayW / 2, w: bayW }); }
  const id = `${lot.id}:r${end}`;
  const openings = [];
  const ground = plan.floors[0];
  const doorBay = nBays > 2 ? rng.int(0, nBays - 1) : -1;
  for (const b of bays) {
    const isDoor = b.index === doorBay;
    const w = isDoor ? Math.min(1.5, b.w - 0.9) : Math.max(1.2, b.w - rng.range(0.7, 1.1));
    const top = isDoor ? 'flat' : plan.style.shopTop;
    const sill = g + (isDoor ? 0.14 : 0.03);
    const head = isDoor ? Math.min(ground.h - 0.9, 3.2) : ground.h - rng.range(0.8, 1.1);
    const o = { id: `${id}:g${b.index}`, floor: 0, bay: b.index, uc: b.uc, w, y: sill, h: head - sill, top, kind: isDoor ? 'door' : 'shop',
      recess: rng.range(0.25, 0.4), awning: null, lit: rng.range(0.6, 1.0) };
    setArch(o); openings.push(o);
  }
  const winTpl = plan.openings.filter((o) => o.kind === 'window' || o.kind === 'balconyDoor');
  for (const fl of plan.floors) {
    if (fl.index === 0) continue;
    const tpl = winTpl.find((o) => o.floor === fl.index && o.kind === 'window') || winTpl.find((o) => o.floor === fl.index);
    if (!tpl) continue;
    const y = tpl.kind === 'window' ? tpl.y : fl.y + rng.range(0.8, 0.95);
    const h = tpl.kind === 'window' ? tpl.h : Math.min(fl.h - 1.15, 2.1);
    for (const b of bays) {
      const o = { id: `${id}:f${fl.index}b${b.index}`, floor: fl.index, bay: b.index, uc: b.uc, w: Math.min(tpl.w, b.w - 0.8), y, h, top: tpl.top, paired: false,
        kind: 'window', recess: rng.range(0.18, 0.28), shutters: rng.chance(0.25) ? (rng.chance(0.5) ? 'open' : 'closed') : null,
        lit: rng.next(), curtain: rng.chance(0.5), ac: rng.chance(0.06), flowerBox: false };
      setArch(o); openings.push(o);
    }
  }
  return {
    isReturn: true, end, lotId: lot.id, id, seed: lot.seed ^ (end ? 0x5bd1e995 : 0x27d4eb2f), frame, width, depth: plan.width,
    groundAt: () => g, ground0: g, ground1: g, cornerAtU1,
    floors: plan.floors, bays, pierL, pierR, openings, balconies: [], courses: plan.courses, cornice: plan.cornice, parapet: plan.parapet,
    roof: plan.roof, rooftop: [], signs: [], flags: [], style: plan.style, totalHeight: plan.totalHeight,
  };
}
