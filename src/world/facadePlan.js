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
let layoutRef = null;

/**
 * Give the plan generator access to the layout (cross streets and side lots), so corner
 * returns follow the real side-street building line. Plans made before binding are
 * dropped from the cache. Without a layout, returns are perpendicular to the front.
 */
export function bindLayout(layout) {
  if (layoutRef === layout) return;
  layoutRef = layout;
  cache.clear();
}

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
  massing(plan, lot);                      // low buildings, set-back penthouses and additions
  coursing(plan);                          // sills aligned per floor, heads on whole ashlar courses
  followSlope(plan);                       // ground-floor sills step down with the street
  for (const o of plan.openings) setArch(o); // o.rise / o.spring for every opening head
  if (plan.upper) for (const o of plan.upper.openings) setArch(o);
  plan.relief = reliefOf(plan, ornament(plan, RNG.from(lot.seed, 'shell')));
  plan.returns = [];                       // street facades on the side-street returns of corner lots
  if (plan.cornerU0) plan.returns.push(returnPlan(lot, plan, 0));
  if (plan.cornerU1) plan.returns.push(returnPlan(lot, plan, 1));
  cornerCut(plan, lot);                    // some street corners are chamfered (an extra face)
  for (const f of [plan, ...plan.returns, ...(plan.upper ? [plan.upper] : [])]) for (const o of f.openings) o.backDepth = backDepthOf(o);
  cache.set(lot.id, plan);
  return plan;
}

// ------------------------------------------------------------------ masonry relief
// The building shell closes every opening with a dark box behind the infill plane,
// `o.backDepth` metres deep (from w = −recess): room for recessed entrances and casements
// swung open into the room.
const backDepthOf = (o) => (o.kind === 'shop' || o.kind === 'door' ? 1.2 : 0.9);

/**
 * Building-only style choices of the masonry (surrounds, sills, arch rings, plinth,
 * rustication, quoins, pilasters, rooftop...). Drawn from the stream
 * RNG.from(lot.seed, 'shell'), which the shell generator continues after these draws.
 */
export function ornament(plan, rng) {
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

/**
 * plan.relief: what the masonry puts on the wall face (metres; p = projection in front of
 * the wall plane w = 0), so infill, signs and shutters can clear it:
 *   surround {w, p}       smooth window surround (w 0: plain reveals); jambs u0 − w..u0, u1..u1 + w
 *   doorSurround {w, p}   entrance door surround (w 0: none)
 *   sill {h, p, ext}      window sill below o.y (h tall), overhanging the jambs by ext
 *   ring {w, p, shopW, shopP}  arch ring stones above arched heads (keystones 3 cm prouder)
 *   head {h, p}           flat heads (lintel or flat arch) above o.y + o.h; hoods add 0.15
 *   rustic {h, joint, p}  rusticated ground floor: course height, V-joint depth, flush (p 0)
 *   pier {w, p}           pilasters centred on the bay boundaries above the first string course
 *   quoin {long, short, p}  corner blocks
 *   plinth {h, p}         base course above the paving
 *   groundP               the deepest relief on the ground floor (door hoods excepted)
 *   doorHood              entrance hood on consoles (0.36 m proud, 0.7 m tall consoles)
 * Missing features are null.
 */
function reliefOf(plan, orn) {
  const st = plan.style;
  const sw = st.surrounds ? orn.sw : 0, sp = st.surrounds ? orn.sp : 0;
  const door = orn.doorSurround ? { w: orn.sw * 1.3, p: orn.sp } : { w: 0, p: 0 };
  const quoin = st.quoins ? { long: orn.quoin.long, short: orn.quoin.short, p: orn.quoin.proj } : null;
  const plinth = { h: orn.plinthH, p: orn.plinthP };
  const keyP = orn.keystone ? 0.03 : 0;
  return {
    surround: { w: sw, p: sp },
    doorSurround: door,
    sill: { h: orn.sillH, p: sp + orn.sillP, ext: (sw || 0.06) + 0.07 },
    ring: { w: sw ? sw * 1.3 : orn.ring, p: sw ? sp : 0.012, shopW: orn.shopRing, shopP: orn.shopRingP },
    head: { h: plan.coursing ? Math.min(0.45, Math.max(0.26, plan.coursing.ch)) : 0.3, p: (sw ? sp : 0.012) + 0.004 },
    rustic: st.rusticGround ? { h: orn.rustH, joint: orn.rustC, p: 0 } : null,
    pier: st.pilasters && plan.floors.length > 2 ? { w: orn.pilW, p: orn.pilP } : null,
    quoin,
    plinth,
    groundP: Math.max(plinth.p, quoin ? quoin.p : 0, orn.shopRingP + 0.03, 0.02 + keyP, door.p + keyP),
    doorHood: !!orn.doorHood,
  };
}

// ------------------------------------------------------------------ arches (shared geometry)
// An opening spans u ∈ [uc − w/2, uc + w/2], v ∈ [y, y + h]. Its head is an arch of
// `rise` above the spring line `spring = y + h − rise`:
//   flat     rise 0
//   segment  rise ≈ 0.17 w (arc of a large circle centred below the spring line)
//   round    rise = w / 2 (semicircle)
//   pointed  rise ≈ 0.62 w (two-centred arch, centres 0.134 w either side of the axis)

const SIDE_START = 16; // = layout SIDE_LOT_START (side-street facades start this far from the front)
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

// ------------------------------------------------------------------ massing
// The street is not one even cornice line: a few old two- or three-storey buildings
// stand between the taller ones, and many flat roofs carry a later set-back storey (a
// penthouse behind a terrace) or a whole set-back addition of several storeys.
//   plan.upper = {setback, u0, u1, width, depth, v0, floorH, floors, material, color,
//                 openings, frame, selfDressed: true}
// The upper volume has its own facade frame (same conventions as lot.frame, front at
// w = −setback, u from its left end) and plan-like openings; the buildings module
// glazes them itself (selfDressed), so other modules may ignore plan.upper.
function massing(plan, lot) {
  const rng = RNG.from(lot.seed, 'massing');
  const nF = plan.floors.length;
  if (!lot.backdrop && nF >= 4 && rng.chance(0.13)) lowerTo(plan, rng.chance(0.45) ? 2 : 3);
  const roll = rng.next();
  if (plan.roof.type !== 'flat' || plan.depth < 9 || plan.width < 6) return;
  const addition = roll < 0.1, pent = !addition && roll < 0.42;
  if (!addition && !pent) return;
  const floors = addition ? rng.int(2, plan.floors.length >= 5 ? 3 : 4) : 1;
  const setback = addition ? rng.range(2.6, 4.5) : rng.range(1.6, 2.8);
  const in0 = rng.chance(0.55) ? 0 : rng.range(0.6, 2.2), in1 = rng.chance(0.55) ? 0 : rng.range(0.6, 2.2);
  const width = plan.width - in0 - in1;
  const depth = Math.min(plan.depth - setback - 1.2, rng.range(6, 12));
  if (width < 4 || depth < 4) return;
  const floorH = rng.range(2.85, 3.15);
  const material = rng.chance(addition ? 0.45 : 0.65) ? 'plaster' : 'stone';
  const color = rng.pick([[0.93, 0.9, 0.84], [0.9, 0.86, 0.78], [0.86, 0.85, 0.82], [0.95, 0.93, 0.89]]);
  const v0 = plan.parapet.y;
  const f = lot.frame;
  const origin = f.origin.clone().addScaledVector(f.uDir, in0).addScaledVector(f.nDir, -setback);
  const matrix = f.matrix.clone().makeBasis(f.uDir, f.up, f.nDir).setPosition(origin);
  const frame = { origin, uDir: f.uDir.clone(), nDir: f.nDir.clone(), up: f.up.clone(), width, ground0: f.floorRef + v0, ground1: f.floorRef + v0, floorRef: f.floorRef, matrix };
  const nb = Math.max(1, Math.round((width - 1.2) / rng.range(2.5, 3.3)));
  const bw = (width - 1.2) / nb;
  const openings = [];
  for (let k = 0; k < floors; k++) {
    const fy = v0 + k * floorH;
    for (let b = 0; b < nb; b++) {
      const uc = 0.6 + bw * (b + 0.5);
      // the penthouse opens onto its terrace through glazed doors; additions have windows
      const door = !addition && rng.chance(0.55);
      const w = door ? Math.min(bw - 0.6, rng.range(1.4, 2.2)) : Math.min(bw - 0.7, rng.range(1.1, 1.6));
      const y = door ? fy + 0.05 : fy + rng.range(0.85, 0.95);
      const h = door ? 2.2 : Math.min(floorH - 1.3, rng.range(1.3, 1.5));
      openings.push({
        id: `${lot.id}:u${k}b${b}`, floor: nF + k, bay: b, uc, w, y, h, top: 'flat', kind: door ? 'balconyDoor' : 'window',
        recess: rng.range(0.1, 0.16), shutters: rng.chance(0.2) ? 'closed' : null, lit: rng.next(), curtain: rng.chance(0.5),
      });
    }
  }
  plan.upper = { setback, u0: in0, u1: plan.width - in1, width, depth, v0, floorH, floors, material, color, openings, frame, selfDressed: true, addition };
}

/** Cut a plan down to its first n floors (cornice, parapet and everything above follow). */
function lowerTo(plan, n) {
  if (plan.floors.length <= n) return;
  plan.floors = plan.floors.slice(0, n);
  const last = plan.floors[n - 1];
  last.kind = 'top';
  const y = last.y + last.h;
  plan.cornice.y = y;
  plan.parapet.y = y + plan.cornice.h;
  plan.totalHeight = plan.parapet.y + plan.parapet.h;
  plan.openings = plan.openings.filter((o) => o.floor < n);
  // balconies are listed floor by floor, so this drops a tail and keeps o.balcony indices
  plan.balconies = plan.balconies.filter((b) => b.floor < n);
  plan.courses = plan.courses.filter((c) => c.y < y - 0.5);
  for (const fl of plan.flags) fl.y = plan.floors[Math.min(2, n - 1)].y + 1.6;
}

// ------------------------------------------------------------------ coursing
// Ashlar is laid to the openings: every typical storey holds a whole number of courses
// (height plan.coursing.ch), window sills on one floor share a line and sit on a bed
// joint (plan.coursing.v0 is the first-floor sill line), and the rectangular part of
// each window (sill to spring line) is a whole number of courses, so the masonry
// generator can put bed joints exactly at sills, spring lines and heads.
function coursing(plan) {
  const fl = plan.floors;
  const typ = fl[1] ? fl[1].h : 3.5;
  const ch = typ / Math.max(1, Math.round(typ / plan.style.courseH));
  let v0 = null;
  for (const f of fl) {
    if (f.index === 0) continue;
    const ops = plan.openings.filter((o) => o.floor === f.index && (o.kind === 'window' || o.kind === 'balconyDoor'));
    if (!ops.length) continue;
    const win = ops.find((o) => o.kind === 'window') || ops[0];
    // the floor's head line from its first window; sills follow from the window height
    const top0 = win.y + win.h;
    let sill = win.kind === 'window' ? win.y : top0 - Math.min(f.h - 1.15, 2.2);
    if (v0 === null) v0 = sill;
    // whole courses between the first-floor sill line and this floor's sills
    sill = v0 + Math.round((sill - v0) / ch) * ch;
    const rise = win.top === 'flat' ? 0 : Math.min(archRise(win.top, win.w), Math.max(0, top0 - sill - 0.3));
    let rect = Math.max(3 * ch, Math.round((top0 - sill - rise) / ch) * ch);
    // keep the head (plus arch) clear of the next floor's string course
    const maxTop = f.y + f.h - 0.2;
    while (rect > 3 * ch && sill + rect + rise > maxTop + 1e-6) rect -= ch;
    const top = sill + rect + rise;
    for (const o of ops) {
      if (o.kind === 'window') { o.y = sill; o.h = top - sill; } else o.h = top - o.y;
    }
  }
  plan.coursing = { ch, v0: v0 ?? (fl[1] ? fl[1].y : 0) };
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
function returnPlan(lot, plan, end, cut = 0) {
  const f = lot.frame;
  const rng = RNG.from(lot.seed, 'return', end);
  // The return runs from the street corner of the front to the near end of the first
  // side-street lot, i.e. along the real (angled) side-street building line. Its frame:
  // end 0 (u = 0) faces away from the front's u axis and its own u runs back → street;
  // end 1 (u = width) faces along it and its u runs street → back. Without a layout (or a
  // side lot) the return is perpendicular to the front and lot.depth long.
  const corner = f.origin.clone().addScaledVector(f.uDir, end === 0 ? 0 : f.width);
  const far = sideLotStart(lot, end, corner);
  let dir, depth;
  if (far) {
    dir = new f.uDir.constructor(far.x - corner.x, 0, far.z - corner.z);
    depth = dir.length();
    dir.multiplyScalar(1 / depth);
  } else {
    dir = f.nDir.clone().negate();
    depth = lot.depth;
  }
  const uDir = end === 0 ? dir.clone().negate() : dir.clone();
  const nDir = new f.uDir.constructor().crossVectors(uDir, f.up).normalize();
  // a chamfered corner (cornerCut) takes the first `cut` metres of the return
  const origin = end === 0 ? corner.clone().addScaledVector(dir, depth) : corner.clone().addScaledVector(dir, cut);
  // far end of the return and its direction in the front's (u, w) frame (for the shell)
  const du = dir.x * f.uDir.x + dir.z * f.uDir.z, dw = dir.x * f.nDir.x + dir.z * f.nDir.z;
  const back = [(end === 0 ? 0 : f.width) + du * depth, dw * depth];
  const up = f.up.clone();
  const matrix = f.matrix.clone().makeBasis(uDir, up, nDir).setPosition(origin);
  // the paving along the return: the main street's at the corner, blending into the
  // (level) side street (sideGround)
  const gx = sideGround(lot, plan, end, far);
  const groundAt = end === 0 ? (u) => gx(depth - u) : (u) => gx(cut + u);
  const width = depth - cut;
  const ga = groundAt(0), gb = groundAt(width);
  const frame = { origin, uDir, nDir, up, width, ground0: ga + f.floorRef, ground1: gb + f.floorRef, floorRef: f.floorRef, matrix };
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
    const sill = Math.max(groundAt(b.uc - w / 2), groundAt(b.uc + w / 2)) + (isDoor ? 0.14 : 0.03);
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
    groundAt, ground0: ga, ground1: gb, groundX: gx, cornerAtU1,
    back, dir: [du, dw], cut, // far end and direction (from the corner) in the front's (u, w) frame; chamfer leg
    floors: plan.floors, bays, pierL, pierR, openings, balconies: [], courses: plan.courses, cornice: plan.cornice, parapet: plan.parapet,
    roof: plan.roof, rooftop: [], signs: [], flags: [], style: plan.style, relief: plan.relief, totalHeight: plan.totalHeight,
  };
}

/**
 * Paving height (relative to the front's floorRef) along a corner return at distance x
 * from the street corner: the main street's level at the corner, easing into the level
 * side street over its first 12 m as the street mesh does (crossStreets: smooth(x / 12)).
 * far: the first side lot's near end (sideLotStart), whose floorRef is the side street's.
 */
const SIDE_BLEND = 12;
function sideGround(lot, plan, end, far) {
  const g = end === 0 ? plan.ground0 : plan.ground1;
  if (!far || !far.lot) return () => g;
  const gs = far.lot.frame.floorRef - lot.frame.floorRef;
  return (x) => {
    const t = Math.min(1, Math.max(0, x / SIDE_BLEND));
    return g + (gs - g) * t * t * (3 - 2 * t);
  };
}

// ------------------------------------------------------------------ chamfered corners
// About a third of the corner buildings have their street corner cut off by a narrow
// diagonal face, with the corner shop's entrance on it and a window per floor above.
// The cut face is appended to plan.returns as a return-shaped facade (isCut: true,
// own frame) so infill and attachments dress it like any other front; the main front
// and the side-street return lose their openings, balconies and signs in the cut zone.
//   plan.cuts = [{end, c (leg along the front), cr (leg along the return), face}]
function cornerCut(plan, lot) {
  plan.cuts = [];
  if (plan.roof.type !== 'flat' || plan.parapet.type === 'balustrade') return;
  const f = lot.frame, W = plan.width;
  for (const r of plan.returns.slice()) {
    const rng = RNG.from(lot.seed, 'cut', r.end);
    if (!rng.chance(0.35)) continue;
    const e = r.end, c = rng.range(1.5, 2.3), cr = c;
    if (W < c + 4.5 || r.width < cr + 4.5) continue;
    // a set-back storey must stay behind the cut
    if (plan.upper && (e ? W - plan.upper.u1 : plan.upper.u0) + plan.upper.setback < c + 0.4) continue;
    // the return now starts at the cut
    const ri = plan.returns.indexOf(r);
    plan.returns[ri] = returnPlan(lot, plan, e, cr);
    // the cut segment S → T in the front's (u, w) frame, in path order (end 0: from the return)
    const P = [e ? W : 0, 0], [du, dw] = r.dir;
    const A = [e ? W - c : c, 0], Bp = [P[0] + du * cr, dw * cr];
    const S = e ? A : Bp, T = e ? Bp : A;
    const L = Math.hypot(T[0] - S[0], T[1] - S[1]);
    const tu = (T[0] - S[0]) / L, tw = (T[1] - S[1]) / L;
    const uDir = f.uDir.clone().multiplyScalar(tu).addScaledVector(f.nDir, tw).normalize();
    const nDir = new f.uDir.constructor().crossVectors(uDir, f.up).normalize();
    const origin = f.origin.clone().addScaledVector(f.uDir, S[0]).addScaledVector(f.nDir, S[1]);
    const matrix = f.matrix.clone().makeBasis(uDir, f.up, nDir).setPosition(origin);
    // paving: the front's at the corner end of the face, the return's at its far end
    const gF = plan.groundAt(A[0]), gR = plan.returns[ri].groundX(cr);
    const g0 = e ? gF : gR, g1 = e ? gR : gF;
    const groundAt = (u) => g0 + (g1 - g0) * (u / L);
    const frame = { origin, uDir, nDir, up: f.up.clone(), width: L, ground0: g0 + f.floorRef, ground1: g1 + f.floorRef, floorRef: f.floorRef, matrix };
    const id = `${lot.id}:c${e}`;
    const openings = [];
    const gf = plan.floors[0];
    const sw = Math.min(L - 0.9, 2.1), sy = Math.max(groundAt(L / 2 - sw / 2), groundAt(L / 2 + sw / 2)) + 0.03;
    const so = { id: `${id}:g0`, floor: 0, bay: 0, uc: L / 2, w: sw, y: sy, h: gf.h - rng.range(0.8, 1.0) - sy,
      top: plan.style.shopTop, kind: 'shop', recess: rng.range(0.25, 0.35), awning: null, lit: rng.range(0.6, 1.0) };
    setArch(so); openings.push(so);
    for (const fl of plan.floors) {
      if (fl.index === 0) continue;
      const tpl = plan.openings.find((o) => o.floor === fl.index && o.kind === 'window');
      if (!tpl) continue;
      const o = { id: `${id}:f${fl.index}`, floor: fl.index, bay: 0, uc: L / 2, w: Math.min(tpl.w, L - 1.1), y: tpl.y, h: tpl.h, top: tpl.top, paired: false,
        kind: 'window', recess: tpl.recess, shutters: rng.chance(0.25) ? 'closed' : null, lit: rng.next(), curtain: rng.chance(0.5), ac: false, flowerBox: rng.chance(0.1) };
      setArch(o); openings.push(o);
    }
    const face = {
      isReturn: true, isCut: true, end: e, lotId: lot.id, id, seed: lot.seed ^ (e ? 0x3c6ef372 : 0x1b873593), frame, width: L, depth: plan.width,
      groundAt, ground0: g0, ground1: g1, cornerAtU1: false, back: null, dir: null,
      floors: plan.floors, bays: [{ index: 0, u0: 0.25, u1: L - 0.25, uc: L / 2, w: L - 0.5 }], pierL: 0.25, pierR: 0.25,
      openings, balconies: [], courses: plan.courses, cornice: plan.cornice, parapet: plan.parapet,
      roof: plan.roof, rooftop: [], signs: [], flags: [], style: plan.style, relief: plan.relief, totalHeight: plan.totalHeight,
    };
    plan.returns.push(face);
    plan.cuts.push({ end: e, c, cr, S, T, face });
    // clear the cut zone of the front: openings, balconies (clipped), signs and flags
    const lim = e ? W - c - 0.3 : c + 0.3;
    const out = (a, b) => (e ? b > lim : a < lim);
    plan.openings = plan.openings.filter((o) => !out(o.uc - o.w / 2 - 0.15, o.uc + o.w / 2 + 0.15));
    const keep = [], remap = new Map();
    plan.balconies.forEach((b, i) => {
      if (out(b.u0, b.u1)) { if (e) b.u1 = Math.min(b.u1, lim); else b.u0 = Math.max(b.u0, lim); }
      if (b.u1 - b.u0 < 1.2) return;
      remap.set(i, keep.length); keep.push(b);
    });
    plan.balconies = keep;
    for (const o of plan.openings) {
      if (o.balcony === undefined) continue;
      if (remap.has(o.balcony)) { o.balcony = remap.get(o.balcony); continue; }
      // its balcony is gone: back to a window with a sill
      const fl = plan.floors[o.floor], top = o.y + o.h;
      delete o.balcony;
      o.kind = 'window'; o.y = fl.y + 0.9; o.h = top - o.y;
    }
    plan.signs = plan.signs.filter((sg) => !(sg.kind === 'blade' ? out(sg.u - 0.4, sg.u + 0.4) : out(sg.u0, sg.u1)));
    plan.flags = plan.flags.filter((fl) => !out(fl.u - 0.5, fl.u + 0.5));
  }
}

/** Near end of the first side-street lot at end e: {x, z (world), lot}, or null. */
function sideLotStart(lot, end, corner) {
  if (!layoutRef || !layoutRef.sideLots) return null;
  // u = 0 is the viewer-left end: s1 for right-hand lots, s0 for left-hand lots
  const atS0 = lot.side > 0 ? end === 1 : end === 0;
  const edge = atS0 ? 1 : -1;
  let best = null, bd = 12;
  for (const sl of layoutRef.sideLots) {
    if (sl.side !== lot.side || sl.edge !== edge || sl.x0 > SIDE_START + 0.01 || !sl.frame) continue;
    const sf = sl.frame;
    for (const t of [0, sf.width]) {
      const x = sf.origin.x + sf.uDir.x * t, z = sf.origin.z + sf.uDir.z * t;
      const d = Math.hypot(x - corner.x, z - corner.z);
      // the near end lies roughly SIDE_START from the corner, the far end much further
      if (Math.abs(d - SIDE_START) < bd) { bd = Math.abs(d - SIDE_START); best = { x, z, lot: sl }; }
    }
  }
  return best;
}
