import * as THREE from 'three';
import { CONTACT_WIRE_HEIGHT, RAIL_CENTER } from '../../core/config.js';

// Procedural model of the line's light-rail vehicles (the oncoming units): a 32 m,
// 2.65 m wide, bidirectional low-floor tram in silver paint. Three bodies (two cab ends and
// a centre body on its own bogie) joined by bellows; a raked windscreen running down into a
// dark glass shield with LED lamps and the fleet number at its foot (headlights leading,
// red tail lamps trailing) and the lit destination display behind its top band; four
// double plug doors a side (push buttons on the leaves); the fleet number painted under
// each cab's side windows; lower side panels jointed under the window pillars; roof
// equipment covers (the cab's air conditioning unit and traction converter, the centre
// body's resistors either side of the pantograph) ramping down at their ends, with panel
// joints and louvred intakes, and a single-arm pantograph on the centre body that reaches the
// contact wire; the city's crest beside the fleet number on the nose and the coupler hatch in
// its apron. Inside: the saloon (seats, poles, rails, ceiling lights) seen through the side
// glazing by day, with the spots where passengers sit and stand.
//
// Each body is built in its own frame: x to the right, y up from the rail top, local −z
// forward with z = 0 at the body's leading end (the nose tip, or the articulation point).
// The trailing cab reuses the leading cab's geometry turned round, so only its lamp mesh
// differs. Three levels of detail share the generators: LOD 0 (door seams, window frames,
// wheels, corrugated bellows, wiper), LOD 1 (plain glazing) and LOD 2 (coarse, for the
// far end of the street). One part per material (trams/materials.js): body (silver
// paint and dark trim, vertex colour = paint colour), glassR / glassL (each side's glazing,
// windows and door glass, with black frit over the pillars so the glazing reads as one flush
// band), front (windscreen, trim, dark mask and the destination display behind it, drawn per
// pixel), metal (pantograph), inner (the saloon, LOD 0 / 1) and lamps (unlit, from the lens
// atlas: head / tail lamps, door indicators and buttons). Far away and after dark the
// glazing's saloon is traced in its shader (trams/materials.js); the centre body's glass uv
// runs from 100 so the shader knows its door layout.

export const CAR = {
  length: 32,
  joints: [0, 11.15, 20.85, 32],   // m behind the leading nose: articulations on the track
  gap: 0.3,                        // between neighbouring bodies
  bogies: [3.1, 16.0, 28.9],
  axleHalf: 0.925,                 // axle offset from the bogie centre
  wheelR: 0.3,
  doors: [6.4, 13.4, 18.6, 25.6],  // double plug doors (centres), both sides
  doorW: 1.3,
  halfWidth: 1.325,
  capBase: 1.15,                   // the front cap meets the side walls this far behind the nose
  roof: 3.22,
};

// linear paint colours (the body material's vertex colour is the paint colour; the body
// shader makes the bright ones metallic silver paint and the dark ones plain dielectric
// trim, see trams/materials.js). Glass parts: white = glazing, black = black frit.
const COL = {
  silver: [0.38, 0.395, 0.42],
  roof: [0.34, 0.35, 0.37],
  skirt: [0.017, 0.018, 0.019],
  black: [0.006, 0.006, 0.0065],
  bellows: [0.013, 0.013, 0.014],
  fairing: [0.36, 0.37, 0.39],
  under: [0.02, 0.019, 0.018],
  insulator: [0.1, 0.055, 0.035],
  wheel: [0.035, 0.032, 0.03],
  panto: [0.05, 0.052, 0.055],     // dark grey painted pantograph frame
  white: [1, 1, 1],
};

// lamp brightness relative to the destination display (lamp mesh vertex colours, linear)
const LAMP = { head: [45, 45, 44], tail: [14, 0.5, 0.17], door: [5, 0.55, 0.12], button: [1.8, 0.16, 0.1] };
const FLEET_NO = '07';

// cross-section: band edges and the rows the cab front needs
// (the silver skirt comes down to 0.11 m over the rail top, a black rubber edge at its foot)
const Y = {
  bottom: 0.11, skirt: 0.13, floor: 0.33, belt: 0.95, winTop: 2.45, frame: 0.03,
  doorGlass0: 0.8, doorGlass1: 2.1, doorTop: 2.3, doorSeam: 2.33,
  ws0: 1.18, dispBand: 2.62, shoulder: 2.86, noseSkirt: 0.13,
  seatBack: 1.35,              // saloon glazing below this shows seat backs: it does not glow at night
};
const SHOULDER_R = 0.33;
const WIN_W = 0.86;            // side window pane width the layout aims at (m)
const ROOF_CROWN = 0.03;
const DISP_U = 0.56;           // destination display half width (share)
const CAP_P = 2.6;             // plan shape of the front (superellipse exponent)
// centre-line depth of the front cap ahead of the cap base, by height (side view)
const NOSE = [[0.11, 0.87], [0.18, 0.92], [0.42, 1.08], [0.8, 1.15], [1.18, 1.12], [1.8, 0.99], [2.4, 0.8],
  [2.8, 0.58], [3.0, 0.42], [3.12, 0.26], [3.19, 0.1], [3.22, 0]];

const LOD_ROWS = [
  { side: [0.13, 0.2, 0.26, 0.33, 0.42, 0.55, 0.62, 0.68, 0.74, 0.8, 0.95, 0.98, 1.06, 1.18, 1.35, 1.75, 2.1, 2.3, 2.33, 2.42, 2.45, 2.62, 2.75, 2.86],
    arc: [12, 25, 40, 55, 70, 82, 90], roof: [0.6, 0.3, 0] },
  { side: [0.13, 0.2, 0.33, 0.42, 0.62, 0.72, 0.95, 1.18, 1.35, 1.75, 2.1, 2.45, 2.62, 2.86], arc: [12, 25, 55, 90], roof: [0.45, 0] },
  { side: [0.2, 0.42, 0.62, 0.95, 1.18, 2.45, 2.62, 2.86], arc: [12, 25, 60, 90], roof: [0] },
];

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const _gc = [0, 0, 0];
/** Road grime on the paint: the lower body is a little duller than the upper. */
function grimed(col, y) {
  if (col !== COL.silver) return col;
  const t = clamp((y - Y.skirt) / 0.9, 0, 1), k = 0.8 + 0.2 * t * t * (3 - 2 * t);
  _gc[0] = col[0] * k; _gc[1] = col[1] * k * 0.995; _gc[2] = col[2] * k * 0.985;
  return _gc;
}

/** Half width of the body side at height y (below the shoulder arc). */
function sideX(y) {
  if (y >= Y.belt) { const t = (y - Y.belt) / (Y.shoulder - Y.belt); return CAR.halfWidth - 0.11 * t * t; }
  const t = clamp((Y.belt - y) / 0.75, 0, 1);
  return CAR.halfWidth - 0.12 * Math.pow(t, 2.5);
}
const ARC_CX = sideX(Y.shoulder) - SHOULDER_R;

/** Cross-section, right half, bottom to roof crown: [{x, y, nx, ny, a}] (a = arc length). */
function profile(lod) {
  const R = LOD_ROWS[lod];
  const pts = [{ x: sideX(Y.bottom) - 0.05, y: Y.bottom }];
  for (const y of R.side) pts.push({ x: sideX(y), y });
  for (const deg of R.arc) {
    const t = (deg * Math.PI) / 180;
    pts.push({ x: ARC_CX + SHOULDER_R * Math.cos(t), y: Y.shoulder + SHOULDER_R * Math.sin(t) });
  }
  const yr = Y.shoulder + SHOULDER_R;
  for (const x of R.roof) pts.push({ x, y: yr + ROOF_CROWN * (1 - (x / ARC_CX) ** 2) });
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[Math.max(0, i - 1)], r = pts[Math.min(pts.length - 1, i + 1)];
    if (i > 0) a += Math.hypot(p.x - q.x, p.y - q.y);
    const tx = r.x - q.x, ty = r.y - q.y, l = Math.hypot(tx, ty) || 1;
    p.nx = ty / l; p.ny = -tx / l; p.a = a;
  }
  // the crown is level
  const last = pts[pts.length - 1]; last.nx = 0; last.ny = 1;
  return pts;
}

/** Monotone-ish smooth interpolation of the nose depth table. */
function noseDepth(y) {
  const T = NOSE;
  if (y <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) {
    if (y <= T[i][0]) {
      const [y0, d0] = T[i - 1], [y1, d1] = T[i];
      const m0 = i > 1 ? (d1 - T[i - 2][1]) / (y1 - T[i - 2][0]) : (d1 - d0) / (y1 - y0);
      const m1 = i < T.length - 1 ? (T[i + 1][1] - d0) / (T[i + 1][0] - y0) : (d1 - d0) / (y1 - y0);
      const h = y1 - y0, t = (y - y0) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * d0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * d1 + (t3 - t2) * h * m1;
    }
  }
  return 0;
}
const plan = (u) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u), CAP_P)), 1 / CAP_P);

/** Point on the front cap at (u = share of the half width, y), local frame. */
function capPoint(u, y, out) {
  const hw = sideX(y);
  return out.set(u * hw, y, CAR.capBase - noseDepth(y) * plan(u));
}
const _ca = new THREE.Vector3(), _cb = new THREE.Vector3(), _cc = new THREE.Vector3(), _cd = new THREE.Vector3();
/** Outward normal of the front cap at (u, y) (lower nose, where the side is analytic). */
function capNormal(u, y, out) {
  const e = 0.004;
  capPoint(u + e, y, _ca); capPoint(u - e, y, _cb);
  capPoint(u, y + e, _cc); capPoint(u, y - e, _cd);
  _ca.sub(_cb); _cc.sub(_cd);
  out.crossVectors(_cc, _ca).normalize();        // (up × along u) faces forward (−z)
  if (out.z > 0) out.negate();
  return out;
}

// ------------------------------------------------------------------ mesh builder
class Part {
  constructor() { this.p = []; this.n = []; this.c = []; this.t = []; this.i = []; }
  get count() { return this.p.length / 3; }
  vert(x, y, z, nx, ny, nz, col, u = 0, v = 0) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(col[0], col[1], col[2]); this.t.push(u, v);
    return this.count - 1;
  }
  /** Triangle, wound so its face normal agrees with the vertex normals. */
  tri(a, b, c) {
    const P = this.p, N = this.n;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx = N[a * 3] + N[b * 3] + N[c * 3], ny = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], nz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    if (fx * nx + fy * ny + fz * nz < 0) this.i.push(a, c, b); else this.i.push(a, b, c);
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  geometry() {
    if (!this.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.t, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    g.userData.shared = true;
    return g;
  }
}

/** Per-material parts of one body at one level of detail: body paint / trim, side glazing
 *  (upper: lit saloon at night; ws: the lower panes and door glass), the cab front glass
 *  (windscreen and dark mask, drawn analytically from uv = (u share, height)) and metal. */
class Parts {
  constructor() {
    this.body = new Part(); this.glassR = new Part(); this.glassL = new Part(); this.front = new Part(); this.metal = new Part();
    this.inner = new Part();
  }
  /** (each side's glazing is a geometry of its own: three sorts transparent draws by the
   *  centre of their bounding spheres, so the far side's is drawn before the near side's) */
  geometries() {
    const o = {};
    for (const k of ['body', 'glassR', 'glassL', 'front', 'metal', 'inner']) o[k] = this[k].geometry();
    return o;
  }
}

// ------------------------------------------------------------------ side walls
/**
 * Window / door layout of the side wall between z0 and z1 (local), as cells
 * [{z0, z1, kind, pane}] with kind: wall | win (glass) | wframe (black frame strip) |
 * dseam (door seam) | dleaf (door leaf frame) | dglass (door leaf glazing). `pane` numbers
 * the sheet of glass a glazed cell belongs to (a window with its frit frame, a pillar, a
 * door leaf), the same at every level of detail.
 */
function sideLayout(z0, z1, doors, lod, firstWin = null) {
  const cells = [];
  const PILLAR = 0.12, FR = lod === 0 ? Y.frame : 0;
  const id = (z) => Math.round(z * 20) + 1000;
  const wall = (a, b) => { if (b > a + 1e-4) cells.push({ z0: a, z1: b, kind: 'wall' }); };
  // between panes the glazing band carries on as black frit (flush glazing)
  const pillar = (a, b) => { if (b > a + 1e-4) cells.push({ z0: a, z1: b, kind: 'pillar', pane: id(a) }); };
  const window = (a, b) => {
    const pane = id(a);
    if (FR) { cells.push({ z0: a, z1: a + FR, kind: 'wframe', pane }, { z0: a + FR, z1: b - FR, kind: 'win', pane }, { z0: b - FR, z1: b, kind: 'wframe', pane }); }
    else cells.push({ z0: a, z1: b, kind: 'win', pane });
  };
  const windows = (a, b) => {
    if (b - a < 0.5) { wall(a, b); return; }
    // narrow panes, a pillar about every metre (as the line's cars have)
    const n = Math.max(1, Math.round((b - a + PILLAR) / (WIN_W + PILLAR)));
    const w = (b - a - (n - 1) * PILLAR) / n;
    for (let k = 0; k < n; k++) {
      const s = a + k * (w + PILLAR);
      window(s, s + w);
      if (k < n - 1) pillar(s + w, s + w + PILLAR);
    }
  };
  const door = (c) => {
    const h = CAR.doorW / 2, pL = id(c - h), pR = id(c);
    if (lod > 0) { cells.push({ z0: c - h, z1: c - 0.01, kind: 'dglass', pane: pL }, { z0: c - 0.01, z1: c + 0.01, kind: lod === 1 ? 'dseam' : 'dglass', pane: pL }, { z0: c + 0.01, z1: c + h, kind: 'dglass', pane: pR }); return; }
    const S = 0.02, F = 0.09;
    for (const [a, b, k] of [[c - h, c - h + S, 'dseam'], [c - h + S, c - h + S + F, 'dleaf'], [c - h + S + F, c - 0.01 - F, 'dglass'],
      [c - 0.01 - F, c - 0.01, 'dleaf'], [c - 0.01, c + 0.01, 'dseam'], [c + 0.01, c + 0.01 + F, 'dleaf'],
      [c + 0.01 + F, c + h - S - F, 'dglass'], [c + h - S - F, c + h - S, 'dleaf'], [c + h - S, c + h, 'dseam']]) cells.push({ z0: a, z1: b, kind: k, pane: a < c ? pL : pR });
  };
  let z = z0;
  if (firstWin) { wall(z, firstWin[0]); window(firstWin[0], firstWin[1]); z = firstWin[1]; pillar(z, z + PILLAR); z += PILLAR; }
  for (const c of doors) {
    if (c - CAR.doorW / 2 < z0 || c + CAR.doorW / 2 > z1) continue;
    windows(z, c - CAR.doorW / 2 - 0.05);
    pillar(c - CAR.doorW / 2 - 0.05, c - CAR.doorW / 2);
    door(c);
    pillar(c + CAR.doorW / 2, c + CAR.doorW / 2 + 0.05);
    z = c + CAR.doorW / 2 + 0.05;
  }
  windows(z, z1 - 0.15);
  wall(z1 - 0.15, z1);
  return cells;
}

/** What a side-wall cell shows between two profile rows: [part, colour] or null. The
 *  glazing band (belt to window head) is continuous: panes, black frit over the pillars
 *  and frames (glass parts, vertex colour black), door leaves glazed in black surrounds. */
function cellMaterial(kind, y0, y1) {
  const ym = (y0 + y1) / 2;
  const paint = ym > Y.shoulder + 0.02 ? COL.roof : COL.silver;
  const body = (c) => ['body', c];
  const pane = () => [ym < Y.seatBack ? 'ws' : 'glass', COL.white];
  const frit = () => [ym < Y.seatBack ? 'ws' : 'glass', COL.black];
  if (kind === 'fairing') return body(COL.fairing);
  if (kind === 'dseam' || kind === 'dleaf' || kind === 'dglass') {
    if (ym < Y.floor) return body(ym < Y.skirt ? COL.skirt : COL.silver);
    if (ym > Y.doorSeam) return body(paint);
    if (kind === 'dseam' || ym > Y.doorTop) return body(COL.black);
    if (ym > Y.doorGlass0) {
      if (kind === 'dglass' && ym < Y.doorGlass1) return [ym < Y.belt ? 'ws' : 'glass', COL.white];
      return frit();
    }
    return body(COL.silver);
  }
  if (ym < Y.skirt) return body(COL.skirt);
  if (ym > Y.belt && ym < Y.winTop) {
    if (kind === 'wframe' || kind === 'pillar') return frit();
    if (kind === 'win') {
      if (ym < Y.belt + Y.frame || ym > Y.winTop - Y.frame) return frit();
      return pane();
    }
  }
  return body(paint);
}

/** Both side walls (and the roof) of a body from its cell layout. uv = (z + uOff, arc
 *  length) on the roof; on the sides the panels are slightly convex (the body and glass shaders
 *  tilt the normal along the car across each), so uv.x carries the place across the panel,
 *  t = −1..1: the paint 500 + t (lower panels from one joint under a pillar to the next, a door
 *  leaf, the band over the windows; the pillars there flat), the glazing 10 + uOff + t across its
 *  pane (the glass shader tells the centre body, uOff 100, by it). The glazing's uv.y is its
 *  cell's pane number (each pane sits a little differently). */
function sideWalls(P, prof, cells, uOff = 0) {
  // panes (a window with its frit frame, a pillar, a door leaf) and the panel joints: the
  // pillar centres and door seams, and the layout's ends
  const span = new Map(), cuts = [cells[0].z0, cells[cells.length - 1].z1];
  for (const c of cells) {
    if (c.pane) { const q = span.get(c.pane); if (q) { q[0] = Math.min(q[0], c.z0); q[1] = Math.max(q[1], c.z1); } else span.set(c.pane, [c.z0, c.z1]); }
    if (c.kind === 'pillar' || c.kind === 'dseam') cuts.push((c.z0 + c.z1) / 2);
  }
  cuts.sort((x, y) => x - y);
  const across = (z, a, b) => clamp((2 * (z - a)) / Math.max(b - a, 1e-3) - 1, -1, 1);
  for (const cell of cells) {
    const zm = (cell.z0 + cell.z1) / 2;
    let ca = cuts[0], cb = cuts[cuts.length - 1];
    for (let k = 0; k < cuts.length - 1; k++) if (zm >= cuts[k] && zm <= cuts[k + 1]) { ca = cuts[k]; cb = cuts[k + 1]; break; }
    const straddle = cell.kind === 'pillar' || cell.kind === 'dseam';
    const ps = cell.pane ? span.get(cell.pane) : null;
    for (let i = 0; i < prof.length - 1; i++) {
      const a = prof[i], b = prof[i + 1];
      // door and window rows only matter on the side; the roof takes the paint
      const [part, col] = cellMaterial(cell.kind, a.y, b.y);
      const glass = part !== 'body';
      const side = b.y <= Y.shoulder + 0.01;
      // the lower side panels meet under each window pillar: the body shader draws the
      // joint at the cell's centre (uv = (centre + uOff, 50 + arc length) marks it)
      const seam = !glass && cell.kind === 'pillar' && b.y <= Y.belt + 1e-3 && a.y >= Y.skirt - 1e-3;
      let u0, u1;
      if (seam) u0 = u1 = zm + uOff;
      else if (glass) { const [pa, pb] = ps || [cell.z0, cell.z1]; u0 = 10 + uOff + across(cell.z0, pa, pb); u1 = 10 + uOff + across(cell.z1, pa, pb); }
      else if (side) { u0 = straddle ? 500 : 500 + across(cell.z0, ca, cb); u1 = straddle ? 500 : 500 + across(cell.z1, ca, cb); }
      else { u0 = cell.z0 + uOff; u1 = cell.z1 + uOff; }
      const va = glass ? cell.pane || 0 : seam ? 50 + a.a : a.a, vb = glass ? cell.pane || 0 : seam ? 50 + b.a : b.a;
      for (const sx of [1, -1]) {
        // (the glazing of each side is a part of its own, see Parts)
        const B = glass ? (sx > 0 ? P.glassR : P.glassL) : P.body;
        const v0 = B.vert(sx * a.x, a.y, cell.z0, sx * a.nx, a.ny, 0, grimed(col, a.y), u0, va);
        const v1 = B.vert(sx * a.x, a.y, cell.z1, sx * a.nx, a.ny, 0, grimed(col, a.y), u1, va);
        const v2 = B.vert(sx * b.x, b.y, cell.z1, sx * b.nx, b.ny, 0, grimed(col, b.y), u1, vb);
        const v3 = B.vert(sx * b.x, b.y, cell.z0, sx * b.nx, b.ny, 0, grimed(col, b.y), u0, vb);
        B.quad(v0, v1, v2, v3);
      }
    }
  }
}

/** Closed outline (both halves) of a cross-section, scaled in by `inset`. */
function outline(prof, inset = 0) {
  const right = prof.map((p) => ({ x: p.x - p.nx * inset, y: p.y - p.ny * inset }));
  const left = right.slice(0, -1).reverse().map((p) => ({ x: -p.x, y: p.y }));
  return right.concat(left);
}

/** Flat end wall at z facing dir (±1 along z). */
function endWall(B, prof, z, dir, col, inset = 0) {
  const ring = outline(prof, inset);
  const c = B.vert(0, 1.7, z, 0, 0, dir, col, 0, 1.7);
  const idx = ring.map((p) => B.vert(p.x, p.y, z, 0, 0, dir, col, p.x, p.y));
  for (let k = 0; k < idx.length; k++) B.tri(c, idx[k], idx[(k + 1) % idx.length]);
}

/** Bellows between two bodies: a dark, corrugated (LOD 0) ring around the joint at z. */
function bellows(B, prof, z, lod) {
  const rows = prof.filter((p) => p.y > Y.floor);
  const half = 0.36, n = lod === 0 ? 14 : 1;
  for (let k = 0; k < n; k++) {
    const za = z - half + (2 * half * k) / n, zb = z - half + (2 * half * (k + 1)) / n;
    const ia = lod === 0 ? (k % 2 ? 0.085 : 0.05) : 0.06, ib = lod === 0 ? (k % 2 ? 0.05 : 0.085) : 0.06;
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i], b = rows[i + 1];
      for (const sx of [1, -1]) {
        const v0 = B.vert(sx * (a.x - a.nx * ia), a.y - a.ny * ia, za, sx * a.nx, a.ny, 0, COL.bellows);
        const v1 = B.vert(sx * (a.x - a.nx * ib), a.y - a.ny * ib, zb, sx * a.nx, a.ny, 0, COL.bellows);
        const v2 = B.vert(sx * (b.x - b.nx * ib), b.y - b.ny * ib, zb, sx * b.nx, b.ny, 0, COL.bellows);
        const v3 = B.vert(sx * (b.x - b.nx * ia), b.y - b.ny * ia, za, sx * b.nx, b.ny, 0, COL.bellows);
        B.quad(v0, v1, v2, v3);
      }
    }
  }
}

/** Box (axis aligned, local frame), outward normals. */
function box(B, x0, x1, y0, y1, z0, z1, col) {
  const F = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]]],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]]],
    [[0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]],
    [[0, -1, 0], [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]]],
    [[0, 0, 1], [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]]],
    [[0, 0, -1], [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]]],
  ];
  for (const [n, q] of F) {
    const v = q.map((p) => B.vert(p[0], p[1], p[2], n[0], n[1], n[2], col, p[0] + p[2], p[1]));
    B.quad(v[0], v[1], v[2], v[3]);
  }
}

const _t0 = new THREE.Vector3(), _t1 = new THREE.Vector3(), _ax = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
/** Tube (radius r, `sides` facets) from a to b ([x, y, z]); caps optional. */
function tube(B, a, b, r, sides, col, caps = false, r1 = r) {
  _t0.fromArray(a); _t1.fromArray(b);
  _ax.subVectors(_t1, _t0).normalize();
  _e1.set(Math.abs(_ax.y) < 0.9 ? 0 : 1, Math.abs(_ax.y) < 0.9 ? 1 : 0, 0).cross(_ax).normalize();
  _e2.crossVectors(_ax, _e1);
  const ring = [];
  for (let k = 0; k <= sides; k++) {
    const t = (k / sides) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    const nx = _e1.x * c + _e2.x * s, ny = _e1.y * c + _e2.y * s, nz = _e1.z * c + _e2.z * s;
    ring.push([B.vert(_t0.x + nx * r, _t0.y + ny * r, _t0.z + nz * r, nx, ny, nz, col, k / sides, 0),
      B.vert(_t1.x + nx * r1, _t1.y + ny * r1, _t1.z + nz * r1, nx, ny, nz, col, k / sides, 1)]);
  }
  for (let k = 0; k < sides; k++) B.quad(ring[k][0], ring[k + 1][0], ring[k + 1][1], ring[k][1]);
  if (caps) {
    for (const [end, rr, sgn] of [[_t0, r, -1], [_t1, r1, 1]]) {
      const c = B.vert(end.x, end.y, end.z, _ax.x * sgn, _ax.y * sgn, _ax.z * sgn, col);
      const rim = [];
      for (let k = 0; k < sides; k++) {
        const t = (k / sides) * Math.PI * 2, cs = Math.cos(t), sn = Math.sin(t);
        rim.push(B.vert(end.x + (_e1.x * cs + _e2.x * sn) * rr, end.y + (_e1.y * cs + _e2.y * sn) * rr, end.z + (_e1.z * cs + _e2.z * sn) * rr, _ax.x * sgn, _ax.y * sgn, _ax.z * sgn, col));
      }
      for (let k = 0; k < sides; k++) B.tri(c, rim[k], rim[(k + 1) % sides]);
    }
  }
}

/** Rounded roof fairing (equipment cover) from z0 to z1: its ends ramp down to the roof in
 *  a quarter round (a loft of the cross-section scaled in height), smooth normals. uv = (m from
 *  its front end, 300 + its length): the body shader draws the panel joints across it, the
 *  louvred intakes in its end faces and the louvre panels low on its sides from it. */
function fairing(B, z0, z1) {
  const half = [[0.8, CAR.roof - 0.04], [0.8, 3.4], [0.765, 3.465], [0.69, 3.495], [0.35, 3.503], [0, 3.505]];
  const base = CAR.roof - 0.04;
  // left side bottom to top, over the crown, down the right side
  const sec = [...half.map(([x, y]) => [-x, y]), ...half.slice(0, -1).reverse()];
  const ramp = Math.min(0.42, (z1 - z0) / 4);
  const us = [0, 0.08, 0.22, 0.42, 0.68, 1];
  const st = [];
  for (const u of us) st.push([z0 + ramp * u, Math.sqrt(1 - (1 - u) * (1 - u))]);
  for (const u of us.slice().reverse()) st.push([z1 - ramp * u, Math.sqrt(1 - (1 - u) * (1 - u))]);
  const P = st.map(([z, k]) => sec.map(([x, y]) => new THREE.Vector3(x * (0.92 + 0.08 * k), base + (y - base) * Math.max(k, 0.02), z)));
  const zc = (z0 + z1) / 2, nr = P.length, nc = sec.length;
  const idx = P.map((row, j) => row.map((p, i) => {
    const a = P[Math.min(nr - 1, j + 1)][i].clone().sub(P[Math.max(0, j - 1)][i]);
    const b = row[Math.min(nc - 1, i + 1)].clone().sub(row[Math.max(0, i - 1)]);
    const n = new THREE.Vector3().crossVectors(a, b).normalize();
    if (n.dot(new THREE.Vector3(p.x, p.y - base + 0.2, p.z - zc)) < 0) n.negate();
    return B.body.vert(p.x, p.y, p.z, n.x, n.y, n.z, COL.fairing, p.z - z0, 300 + (z1 - z0));
  }));
  for (let j = 0; j < nr - 1; j++) {
    for (let i = 0; i < nc - 1; i++) B.body.quad(idx[j][i], idx[j + 1][i], idx[j + 1][i + 1], idx[j][i + 1]);
  }
}

// ------------------------------------------------------------------ cab front
// The front is a dark glossy shield: the windscreen runs down into a dark glass mask that
// narrows towards the lamps at its rounded foot; silver pillars sweep round it from the
// roof to the nose. The destination display sits behind the top band of the glass.
const MASK = { bottom: 0.62, round: 0.12, w0: 0.68, w1: 0.92, full: 1.9 };

/** Half width of the dark mask (share of the body half width) at height y. */
function maskW(y) {
  const yy = clamp(y, MASK.bottom, 3.2);
  const t = clamp((yy - MASK.bottom) / (MASK.full - MASK.bottom), 0, 1);
  let w = MASK.w1 - (MASK.w1 - MASK.w0) * (1 - t) * (1 - t);
  const r = (MASK.bottom + MASK.round - yy) / MASK.round;
  if (r > 0) w *= 0.6 + 0.4 * Math.sqrt(Math.max(0, 1 - r * r));     // rounded foot
  return w;
}
const dispW = (y) => Math.min(DISP_U, 0.62 * maskW(y));

/** Columns across the cap per LOD: shares of the display, display-to-mask and mask-to-side spans. */
const LOD_CAP = [
  { disp: [0, 0.25, 0.5, 0.75, 1], mid: [0.34, 0.67, 1], out: [0.15, 0.32, 0.48, 0.63, 0.76, 0.86, 0.93, 0.97, 1] },
  { disp: [0, 0.5, 1], mid: [0.5, 1], out: [0.3, 0.58, 0.8, 0.93, 1] },
  { disp: [0, 1], mid: [1], out: [0.45, 0.8, 1] },
];

/** The front cap (nose, mask, windscreen with the display behind its top band) of a cab body. */
function capFront(P, prof, lod) {
  const C = LOD_CAP[lod];
  // half columns: [segment, share]; the display edge and the mask edge are grid lines
  const half = [...C.disp.map((t) => [0, t]), ...C.mid.map((t) => [1, t]), ...C.out.map((t) => [2, t])];
  const hD = C.disp.length - 1, hM = hD + C.mid.length;
  const cols = [...half.slice(1).reverse().map(([g, t]) => [g, t, -1]), ...half.map(([g, t]) => [g, t, 1])];
  const nr = prof.length, nc = cols.length, c0 = half.length - 1;   // c0: centre column
  const uOf = (i, j) => {
    const [g, t, sg] = cols[j], y = prof[i].y, w = maskW(y), d = dispW(y);
    return sg * (g === 0 ? t * d : g === 1 ? d + t * (w - d) : w + t * (1 - w));
  };
  // one indexed grid gives smooth normals across material borders
  const pos = new Float32Array(nr * nc * 3), uu = new Float32Array(nr * nc);
  for (let i = 0; i < nr; i++) {
    const p = prof[i], D = noseDepth(p.y);
    for (let j = 0; j < nc; j++) {
      const k = i * nc + j, u = uOf(i, j);
      uu[k] = u;
      pos[k * 3] = u * p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = CAR.capBase - D * plan(u);
    }
  }
  const idx = [];
  for (let i = 0; i < nr - 1; i++) {
    for (let j = 0; j < nc - 1; j++) {
      const a = i * nc + j, b = a + 1, c = a + nc + 1, d = a + nc;
      idx.push(a, d, c, a, c, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();                                          // (the winding faces forward)
  const nrm = g.getAttribute('normal').array;
  // the outermost columns meet the side walls: take the profile normals there
  for (let i = 0; i < nr; i++) {
    for (const [j, sx] of [[0, -1], [nc - 1, 1]]) {
      const k = (i * nc + j) * 3;
      nrm[k] = sx * prof[i].nx; nrm[k + 1] = prof[i].ny; nrm[k + 2] = 0;
    }
  }
  const wsTop = Y.shoulder + SHOULDER_R * Math.sin((25 * Math.PI) / 180);
  for (let i = 0; i < nr - 1; i++) {
    const ym = (prof[i].y + prof[i + 1].y) / 2;
    for (let j = 0; j < nc - 1; j++) {
      const h = Math.max(Math.abs(j - c0), Math.abs(j + 1 - c0));    // outer column of the cell (from the centre)
      let part = 'body', col = COL.silver;
      if (ym < Y.noseSkirt) col = COL.skirt;              // the nose is silver nearly to the rails
      else if (ym > MASK.bottom && ym < wsTop && h <= hM) {
        part = 'front'; col = COL.white;                              // (the display shows behind its top band)
      }
      const B = P[part], front = part === 'front';
      const corner = [i * nc + j, i * nc + j + 1, (i + 1) * nc + j + 1, (i + 1) * nc + j];
      // front glass: uv = (u share of the half width, height): the windscreen outline, its
      // trim and the dark mask are drawn per pixel (trams/materials.js)
      const v = corner.map((q) => B.vert(pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2], nrm[q * 3], nrm[q * 3 + 1], nrm[q * 3 + 2], grimed(col, pos[q * 3 + 1]),
        front ? uu[q] : pos[q * 3], pos[q * 3 + 1]));
      B.quad(v[0], v[1], v[2], v[3]);
    }
  }
  return { pos, nrm, uu, nr, nc, c0, hD, wsTop };
}

const _cp = new THREE.Vector3(), _cn = new THREE.Vector3();
/** Flat-ish patch on the nose: superellipse (u0, y0, ru (share), ry (m)) lifted `lift` m off the cap. */
function noseEllipse(B, u0, y0, ru, ry, lift, col, uvRect = null, seg = 16, e = 0.6) {
  capPoint(u0, y0, _cp); capNormal(u0, y0, _cn);
  const c = B.vert(_cp.x + _cn.x * lift, _cp.y + _cn.y * lift, _cp.z + _cn.z * lift, _cn.x, _cn.y, _cn.z, col,
    uvRect ? (uvRect[0] + uvRect[2]) / 2 : 0, uvRect ? (uvRect[1] + uvRect[3]) / 2 : 0);
  const rim = [];
  for (let k = 0; k < seg; k++) {
    const t = (k / seg) * Math.PI * 2, cs = Math.cos(t), sn = Math.sin(t);
    const ex = Math.sign(cs) * Math.pow(Math.abs(cs), e), ey = Math.sign(sn) * Math.pow(Math.abs(sn), e);
    const u = u0 + ru * ex, y = y0 + ry * ey;
    capPoint(u, y, _cp); capNormal(u, y, _cn);
    // seen from the front the viewer's left is +x: mirror the texture across u
    rim.push(B.vert(_cp.x + _cn.x * lift, _cp.y + _cn.y * lift, _cp.z + _cn.z * lift, _cn.x, _cn.y, _cn.z, col,
      uvRect ? uvRect[0] + (uvRect[2] - uvRect[0]) * (0.5 - 0.5 * ex) : 0, uvRect ? uvRect[1] + (uvRect[3] - uvRect[1]) * (0.5 + 0.5 * ey) : 0));
  }
  for (let k = 0; k < seg; k++) B.tri(c, rim[k], rim[(k + 1) % seg]);
}

// Painted numerals (the fleet number): strokes in a 0.6 x 1 cell (x right, y up), drawn as
// quads of a constant pen width so the figures read as signwriting, not a dot matrix.
const ARC = (cx, cy, rx, ry, a0, a1, n = 10) => Array.from({ length: n + 1 }, (_, i) => {
  const t = a0 + ((a1 - a0) * i) / n;
  return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
});
const PI = Math.PI;
const NUMERALS = {
  0: [ARC(0.3, 0.5, 0.26, 0.47, 0, 2 * PI, 20)],
  1: [[[0.12, 0.8], [0.34, 0.98], [0.34, 0.02]]],
  2: [[...ARC(0.3, 0.72, 0.25, 0.25, PI * 0.95, -PI * 0.2, 8), [0.04, 0.02], [0.58, 0.02]]],
  3: [ARC(0.29, 0.74, 0.23, 0.24, PI * 0.9, -PI * 0.5, 9), ARC(0.29, 0.27, 0.26, 0.26, PI * 0.5, -PI * 0.88, 10)],
  4: [[[0.46, 0.02], [0.46, 0.98], [0.03, 0.3], [0.6, 0.3]]],
  5: [[[0.55, 0.98], [0.12, 0.98], [0.08, 0.55], ...ARC(0.3, 0.32, 0.26, 0.3, PI * 0.75, -PI * 0.85, 10)]],
  6: [[...ARC(0.32, 0.6, 0.26, 0.4, PI * 0.35, PI, 6), ...ARC(0.3, 0.3, 0.26, 0.29, PI, 3 * PI, 16)]],
  7: [[[0.03, 0.98], [0.58, 0.98], [0.2, 0.02]]],
  8: [ARC(0.3, 0.75, 0.21, 0.23, 0, 2 * PI, 16), ARC(0.3, 0.27, 0.26, 0.27, 0, 2 * PI, 16)],
  9: [[...ARC(0.3, 0.7, 0.26, 0.29, 0, 2 * PI, 16), ...ARC(0.28, 0.4, 0.26, 0.4, 0, -PI * 0.65, 6)]],
};
/** Quads ([[u, v] x 4], text frame: u along the line, v up, centred) of `text` at cap height h. */
function numeralQuads(text, h) {
  const pen = 0.12 * h, adv = 0.78 * h, out = [];
  const x0 = -((text.length - 1) * adv + 0.6 * h) / 2;
  for (let k = 0; k < text.length; k++) {
    for (const line of NUMERALS[text[k]] || []) {
      for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = line[i], [bx, by] = line[i + 1];
        const pa = [x0 + k * adv + ax * h, (ay - 0.5) * h], pb = [x0 + k * adv + bx * h, (by - 0.5) * h];
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1], l = Math.hypot(dx, dy) || 1;
        // a little longer than the segment so the joints close
        const ex = (dx / l) * pen * 0.35, ey = (dy / l) * pen * 0.35, nx = (-dy / l) * pen / 2, ny = (dx / l) * pen / 2;
        out.push([[pa[0] - ex + nx, pa[1] - ey + ny], [pb[0] + ex + nx, pb[1] + ey + ny], [pb[0] + ex - nx, pb[1] + ey - ny], [pa[0] - ex - nx, pa[1] - ey - ny]]);
      }
    }
  }
  return out;
}

// lamps at the foot of the mask (share of the half width, height, radius m) and the number box
const LAMPS = { y: 0.745, inner: 0.47, outer: 0.6, r: 0.048 };
const PLATE = { u: 0.095, y0: 0.66, y1: 0.775 };

/** Lamp reflectors (both ends), the fleet number box and the windscreen wiper (LOD 0). */
function noseFittings(P, lod) {
  const seg = lod === 0 ? 16 : lod === 1 ? 10 : 6;
  const refl = [0.09, 0.09, 0.095];
  for (const s of [1, -1]) {
    for (const u of [LAMPS.inner, LAMPS.outer]) {
      const ru = (LAMPS.r * 1.25) / sideX(LAMPS.y);
      noseEllipse(P.body, s * u, LAMPS.y, ru, LAMPS.r * 1.25, 0.004, refl, null, seg, 1);
    }
  }
  // number box: a white plate with the fleet number in black (LOD 0)
  const ym = (PLATE.y0 + PLATE.y1) / 2, hy = (PLATE.y1 - PLATE.y0) / 2;
  noseEllipse(P.body, 0, ym, PLATE.u, hy, 0.005, [0.62, 0.62, 0.6], null, lod === 0 ? 16 : 8, 0.25);
  // the city's crest on an enamel shield beside it (the viewer's right), and the coupler hatch in
  // the nose apron: a cover panel in a dark seam
  if (lod < 2) {
    const cu = -0.215, cw = 0.042 / sideX(ym);
    noseEllipse(P.body, cu, ym + 0.004, cw, 0.055, 0.005, [0.6, 0.6, 0.58], null, lod === 0 ? 16 : 8, 0.55);
    noseEllipse(P.body, cu, ym + 0.008, cw * 0.45, 0.026, 0.0062, [0.1, 0.17, 0.4], null, lod === 0 ? 12 : 6, 0.8);
    const hw = 0.3 / sideX(0.42);
    noseEllipse(P.body, 0, 0.42, hw, 0.105, 0.0025, [0.05, 0.05, 0.052], null, lod === 0 ? 20 : 10, 0.3);
    noseEllipse(P.body, 0, 0.42, hw - 0.009 / sideX(0.42), 0.096, 0.0035, grimed(COL.silver, 0.42).slice(), null, lod === 0 ? 20 : 10, 0.3);
  }
  if (lod > 0) return;
  const B = P.body;
  for (const quad of numeralQuads(FLEET_NO, 0.075)) {
    // viewer's left is +x: the text runs towards −x
    const q = quad.map(([tu, tv]) => {
      const x = -tu, y = ym + tv, u = x / sideX(y);
      capPoint(u, y, _cp); capNormal(u, y, _cn);
      return B.vert(_cp.x + _cn.x * 0.0065, _cp.y + _cn.y * 0.0065, _cp.z + _cn.z * 0.0065, _cn.x, _cn.y, _cn.z, COL.black);
    });
    B.quad(q[0], q[1], q[2], q[3]);
  }
  // a single long wiper parked diagonally up the screen's left side (seen from the front;
  // the viewer's left is +x), from its pivot near the bottom of the U
  const n = 10, w = 0.014, u0 = 0.17, y0 = Y.ws0 + 0.05, u1 = 0.5, y1 = 1.9;
  const dx = (u1 - u0) * sideX((y0 + y1) / 2), dy = y1 - y0, dl = Math.hypot(dx, dy);
  const ox = (-dy / dl) * w, oy = (dx / dl) * w;              // across the blade, in the screen
  let prev = null;
  for (let k = 0; k <= n; k++) {
    const t = k / n, u = u0 + (u1 - u0) * t, y = y0 + (y1 - y0) * t;
    const lift = 0.012 + 0.01 * (1 - t);
    const side = [-1, 1].map((sg) => {
      const yy = y + sg * oy, uu = u + (sg * ox) / sideX(yy);
      capPoint(uu, yy, _cp); capNormal(uu, yy, _cn);
      return B.vert(_cp.x + _cn.x * lift, _cp.y + _cn.y * lift, _cp.z + _cn.z * lift, _cn.x, _cn.y, _cn.z, COL.black);
    });
    if (prev) B.quad(prev[0], side[0], side[1], prev[1]);
    prev = side;
  }
}

/** Lit parts of a cab end: headlights (leading) or tail lamps (trailing). (The destination
 *  display is drawn by the front glass, behind its top band: trams/materials.js.) */
function capLamps(B, cap, prof, lead, atlas) {
  const L = atlas.lens, ru = LAMPS.r / sideX(LAMPS.y);
  for (const s of [1, -1]) {
    if (lead) {
      noseEllipse(B, s * LAMPS.inner, LAMPS.y, ru, LAMPS.r, 0.008, LAMP.head, L, 14, 1);
      noseEllipse(B, s * LAMPS.outer, LAMPS.y, ru, LAMPS.r, 0.008, LAMP.head, L, 14, 1);
    } else {
      noseEllipse(B, s * LAMPS.outer, LAMPS.y, ru, LAMPS.r, 0.008, LAMP.tail, L, 14, 1);
    }
  }
}

/** Door indicator lamps: a small red-orange lens on both sides beside each door (leading
 *  edge, head height), and the passengers' push button on a door leaf (a lit red ring), lit
 *  from the lens atlas. `zs` are door centres (body frame). */
function doorLamps(B, zs, atlas, lod) {
  if (lod > 1) return;
  const L = atlas.lens, seg = 10;
  const uc = (L[0] + L[2]) / 2, vc = (L[1] + L[3]) / 2, hu = (L[2] - L[0]) / 2, hv = (L[3] - L[1]) / 2;
  const disc = (sx, y, z, r, col) => {
    const x = sideX(y) + 0.004;
    const ctr = B.vert(sx * x, y, z, sx, 0, 0, col, uc, vc);
    const rim = [];
    for (let k = 0; k < seg; k++) {
      const t = (k / seg) * Math.PI * 2, cs = Math.cos(t), sn = Math.sin(t);
      rim.push(B.vert(sx * x, y + r * sn, z + r * cs, sx, 0, 0, col, uc + hu * cs, vc + hv * sn));
    }
    for (let k = 0; k < seg; k++) B.tri(ctr, rim[k], rim[(k + 1) % seg]);
  };
  for (const c of zs) {
    for (const sx of [1, -1]) {
      disc(sx, 1.95, c - CAR.doorW / 2 - 0.075, 0.03, LAMP.door);
      disc(sx, 1.12, c + sx * 0.06, 0.036, LAMP.button);
    }
  }
}

/** The fleet number painted on both sides under the cab's side window (LOD 0), reading
 *  towards the viewer's right on either side. */
function sideNumber(B, lod) {
  if (lod > 0) return;
  const yc = 0.64, zc = 1.9;
  for (const sx of [1, -1]) {
    for (const quad of numeralQuads(FLEET_NO, 0.15)) {
      // seen from the side the viewer's right is -z on the +x side, +z on the -x side
      const q = quad.map(([tu, tv]) => {
        const y = yc + tv;
        return B.vert(sx * (sideX(y) + 0.002), y, zc - sx * tu, sx, 0, 0, COL.black);
      });
      B.quad(q[0], q[1], q[2], q[3]);
    }
  }
}

// ------------------------------------------------------------------ running gear, pantograph
/** Outline of the front cap at height y, from the left side round the nose to the right
 *  (body frame [x, z]), drawn `inset` m inside the shell. */
function capOutline(y, n, inset = 0) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const u = -1 + (2 * k) / n;
    capPoint(u, y, _cp);
    capNormal(clamp(u, -0.995, 0.995), y, _cn);
    out.push([_cp.x - _cn.x * inset, _cp.z - _cn.z * inset]);
  }
  return out;
}

/** Horizontal floor (normal down) at height y: the cap outline round the front (cab) or a
 *  straight edge at z0, back to z1. */
function floorPan(B, y, z0, z1, col, cab, inset) {
  const hw = sideX(Y.bottom) - inset;
  const ring = cab ? capOutline(Math.max(y, Y.bottom), 12, inset) : [[-hw, z0], [hw, z0]];
  ring.push([hw, z1], [-hw, z1]);
  const zc = (Math.min(...ring.map((p) => p[1])) + z1) / 2;
  const c = B.vert(0, y, zc, 0, -1, 0, col);
  const idx = ring.map(([x, z]) => B.vert(x, y, z, 0, -1, 0, col));
  for (let k = 0; k < idx.length; k++) B.tri(c, idx[k], idx[(k + 1) % idx.length]);
}

/**
 * Under the body, behind the skirt (near-black, road dust): the floor pan under the low
 * floor, a keel of cable ducts and equipment cases along the middle (so no line of sight
 * passes under the car to the street beyond), and at a bogie its side frames, bolster,
 * wheel discs and the magnetic track brakes hanging over the rails. `cab`: the pan follows
 * the nose. LOD 2 keeps the pan and the keel.
 */
function runningGear(B, z0, z1, bogieZ, lod, cab = false) {
  const yp = 0.28;
  floorPan(B, yp, cab ? 0.4 : z0, z1, COL.under, cab, 0.06);
  const keel = (a, b) => { if (b - a > 0.2) box(B, -0.5, 0.5, 0.07, yp, a, b, COL.under); };
  const k0 = cab ? 0.9 : z0 + 0.15, k1 = z1 - 0.15;
  if (bogieZ == null) { keel(k0, k1); return; }
  const bz0 = bogieZ - 1.35, bz1 = bogieZ + 1.35;
  keel(k0, bz0); keel(bz1, k1);
  box(B, -0.85, 0.85, 0.15, yp, bogieZ - 0.28, bogieZ + 0.28, COL.under);                  // bolster
  for (const s of [1, -1]) {
    box(B, s * 0.97 - 0.09, s * 0.97 + 0.09, 0.15, yp, bz0 + 0.2, bz1 - 0.2, COL.under);     // side frame
    // magnetic track brake shoe over the rail, between the wheels
    box(B, s * RAIL_CENTER - 0.05, s * RAIL_CENTER + 0.05, 0.035, 0.13, bogieZ - CAR.axleHalf + CAR.wheelR + 0.04, bogieZ + CAR.axleHalf - CAR.wheelR - 0.04, COL.under);
  }
  if (lod > 1) return;
  const sides = lod === 0 ? 16 : 10;
  for (const dz of [-CAR.axleHalf, CAR.axleHalf]) {
    for (const s of [1, -1]) {
      const xc = s * RAIL_CENTER;
      tube(B, [xc - 0.055, CAR.wheelR, bogieZ + dz], [xc + 0.055, CAR.wheelR, bogieZ + dz], CAR.wheelR, sides, COL.wheel, true);
      if (lod === 0) tube(B, [s * 0.86, CAR.wheelR, bogieZ + dz], [s * 1.0, CAR.wheelR, bogieZ + dz], 0.11, 8, COL.under, true);   // axle box
    }
  }
}

/**
 * Single-arm pantograph standing on the centre body's roof at z, raised to the contact
 * wire: a base frame on four insulators with the drive's spring box, the lower arm rising
 * forward from its hinge shaft to the knee joint (a push rod beside it), the upper arm (a
 * narrow braced A-frame) back up to the head, a guide rod keeping the head level, and the
 * head: a cross tube, the pan's spring boxes, two carbon strips on their holders and the
 * horns curving down at the ends. Insulators and strips go to the body part, the frame to metal.
 */
function pantograph(P, z, lod) {
  const M = P.metal, B = P.body, y0 = CAR.roof;
  const sides = lod === 0 ? 8 : 5;
  const thick = lod === 0 ? 1 : lod === 1 ? 1.4 : 2.2;        // members stay ≥ ~1 px far away
  const col = COL.panto;
  // insulators and base frame
  for (const sx of [1, -1]) {
    for (const dz of [-0.55, 0.55]) {
      tube(B, [sx * 0.36, y0, z + dz], [sx * 0.36, y0 + 0.2, z + dz], 0.045, sides, COL.insulator, true);
      if (lod === 0) for (const h of [0.06, 0.13]) tube(B, [sx * 0.36, y0 + h, z + dz], [sx * 0.36, y0 + h + 0.02, z + dz], 0.075, sides, COL.insulator, true);
    }
    tube(M, [sx * 0.36, y0 + 0.22, z - 0.68], [sx * 0.36, y0 + 0.22, z + 0.68], 0.04, sides, col, true);
  }
  for (const dz of [-0.55, 0.55]) tube(M, [-0.4, y0 + 0.22, z + dz], [0.4, y0 + 0.22, z + dz], 0.035, sides, col, true);
  // arms: lower arm from the base hinge, knee forward (−z), upper frame back up to the head
  const top = CONTACT_WIRE_HEIGHT - 0.012;
  const H = [0, y0 + 0.32, z + 0.62], Ll = 1.75, Lu = 1.98;
  const headY = top - 0.16;
  // knee: solve for the head standing above the base centre
  const kz = z - 0.95, ky = H[1] + Math.sqrt(Math.max(0.01, Ll * Ll - (H[2] - kz) ** 2));
  const hz = kz + Math.sqrt(Math.max(0.01, Lu * Lu - (headY - ky) ** 2));
  const K = [0, ky, kz], Hd = [0, headY, hz];
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  tube(M, [-0.34, H[1], H[2]], [0.34, H[1], H[2]], 0.04 * Math.min(thick, 1.4), sides, col, true);   // hinge shaft
  tube(M, H, K, 0.065 * thick, sides, col, true, 0.042 * thick);                    // lower arm
  tube(M, [0.09, H[1] - 0.1, H[2] + 0.16], [0.09, K[1] - 0.08, K[2] + 0.07], 0.018 * thick, sides, col, true); // push rod
  if (lod < 2) {
    tube(M, [-0.08, H[1], H[2]], [0.08, H[1], H[2]], 0.1, sides, col, true);      // hinge drum
    tube(M, [0, H[1] - 0.04, H[2] - 0.05], [0, y0 + 0.27, z + 0.05], 0.075, sides, col, true);   // drive spring box
    tube(M, [-0.09, K[1], K[2]], [0.09, K[1], K[2]], 0.05, sides, col, true);     // knee joint
  }
  // upper arm: a narrow A-frame from the knee to the head, braced across
  const UA = [-1, 1].map((sx) => [[sx * 0.05, K[1], K[2]], [sx * 0.26, Hd[1], Hd[2]]]);
  for (const [a, b] of UA) tube(M, a, b, 0.026 * thick, sides, col, true, 0.019 * thick);
  if (lod < 2) {
    for (const t of [0.42, 0.78]) tube(M, lerp(UA[0][0], UA[0][1], t), lerp(UA[1][0], UA[1][1], t), 0.014 * thick, sides, col, true);
    tube(M, lerp(UA[0][0], UA[0][1], 0.42), lerp(UA[1][0], UA[1][1], 0.78), 0.011 * thick, sides, col, true);
    // guide rod (keeps the head level): from a lever at the knee to under the head
    tube(M, [0.12, K[1] - 0.06, K[2] + 0.1], [0.12, Hd[1] - 0.06, Hd[2] - 0.08], 0.011 * thick, sides, col, true);
  }
  // head: cross tube, the pan's spring boxes, two strips on holders, horns
  tube(M, [-0.36, Hd[1], Hd[2]], [0.36, Hd[1], Hd[2]], 0.024 * thick, sides, col, true);
  for (const sx of [1, -1]) {
    box(M, sx * 0.3 - 0.035, sx * 0.3 + 0.035, Hd[1] - 0.02, top - 0.075, Hd[2] - 0.2, Hd[2] + 0.2, col);   // spring box
  }
  for (const dz of [-0.16, 0.16]) {
    box(M, -0.62, 0.62, top - 0.075, top - 0.045, Hd[2] + dz - 0.03, Hd[2] + dz + 0.03, col);   // strip holder
    box(B, -0.58, 0.58, top - 0.045, top, Hd[2] + dz - 0.025, Hd[2] + dz + 0.025, COL.black);   // carbon strip
    for (const sx of [1, -1]) {
      const pts = [[sx * 0.6, top - 0.05], [sx * 0.74, top - 0.07], [sx * 0.86, top - 0.13], [sx * 0.91, top - 0.22]];
      const n = lod === 0 ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const a = pts[lod === 0 ? k : 0], b = pts[lod === 0 ? k + 1 : 3];
        tube(M, [a[0], a[1], Hd[2] + dz], [b[0], b[1], Hd[2] + dz], 0.02 * thick, sides, col, true);
      }
    }
  }
}

// ------------------------------------------------------------------ saloon
// The saloon seen through the side glazing by day (LOD 0 / 1; trams.js seats and stands the
// passengers in it, figures of the humans module): vinyl floor, the lining under the windows
// (door leaves at the doors), the ceiling with its two light strips and coves, the end walls
// (the cab partition with its door, the gangways), transverse seat pairs in facing bays, grab
// poles and the overhead rails (LOD 0). The layout is the traced saloon's (trams/materials.js),
// which the glazing draws instead after dark and far away. Normals face into the room, so from
// outside only its far side, floor and ceiling are drawn. Vertex colour = albedo; uv.x marks the
// seat fabric (20: the unit's colour) and the light strips (10: lit), see makeInteriorMaterial
// (everything else keeps uv.x within 0..1).
export const SALOON = { xw: 1.2, yf: 0.36, yc: 2.47, sill: 0.98, pitch: 0.8, part: 2.65, seatY: 0.84 };
const INC = {
  floor: [0.05, 0.047, 0.043], wall: [0.4, 0.4, 0.385], kick: [0.06, 0.06, 0.058], ceil: [0.55, 0.55, 0.53],
  shell: [0.21, 0.21, 0.2], steel: [0.42, 0.42, 0.41], leg: [0.025, 0.025, 0.025], door: [0.3, 0.3, 0.29],
  gang: [0.02, 0.02, 0.02], part: [0.36, 0.36, 0.35], win: [0.012, 0.012, 0.014],
};

/** Seat bays and doors of the saloon (shared with the traced saloon's tramSeatCell / tramDoorZ). */
const seatCell = (zm, cab) => (cab ? zm > 3.15 && zm < 10.5 && Math.abs(zm - 6.4) > 1.05
  : zm > 0.6 && zm < 9.1 && Math.abs(zm - 2.25) > 1.05 && Math.abs(zm - 7.45) > 1.05);
const saloonDoors = (cab) => (cab ? [6.4] : [2.25, 7.45]);

/** Quad with one normal (CCW as seen from the side the normal points to is not required:
 *  Part.tri winds by the normal). */
function quadN(B, a, b, c, d, n, col, uvx = 0) {
  const v = [a, b, c, d].map((p) => B.vert(p[0], p[1], p[2], n[0], n[1], n[2], col, uvx, p[1]));
  B.quad(v[0], v[1], v[2], v[3]);
}

/** Box with a colour (and uv mark) per face: face(n) -> [col, uvx]. */
function boxF(B, x0, x1, y0, y1, z0, z1, face) {
  const F = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]]],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]]],
    [[0, 1, 0], [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]],
    [[0, -1, 0], [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]]],
    [[0, 0, 1], [[x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [x1, y0, z1]]],
    [[0, 0, -1], [[x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z0]]],
  ];
  for (const [n, q] of F) {
    const [col, ux] = face(n);
    if (!col) continue;
    quadN(B, q[0], q[1], q[2], q[3], n, col, ux);
  }
}

/** Spots of the passengers in a body's frame: seats {x, z, f (facing ±z)} and standing spots
 *  {x, z, f} (at the doors and in the aisle between the bays). */
function saloonSpots(cab, z0, z1) {
  const S = SALOON, seats = [], stand = [];
  for (let k = Math.ceil(z0 / S.pitch); (k + 1) * S.pitch <= z1 + 1e-6; k++) {
    const zc = k * S.pitch, zm = zc + S.pitch / 2;
    if (cab && zm < S.part) continue;
    if (seatCell(zm, cab)) {
      const f = k % 2 === 0 ? 1 : -1, zb = f > 0 ? zc + 0.04 : zc + S.pitch - 0.04;
      for (const sx of [1, -1]) for (const x of [0.55, 0.95]) seats.push({ x: sx * x, z: zb + f * 0.17, f, bay: k >> 1, side: sx });
      stand.push({ x: 0, z: zm, f: k % 2 === 0 ? 1 : -1, aisle: true });
    }
  }
  for (const dz of saloonDoors(cab)) {
    for (const sx of [1, -1]) for (const o of [-0.55, 0.55]) stand.push({ x: sx * 0.62, z: dz + o, f: o > 0 ? -1 : 1, door: true });
    stand.push({ x: 0.05, z: dz - 0.3, f: 1, door: true }, { x: -0.05, z: dz + 0.3, f: -1, door: true });
  }
  return { seats, stand };
}

/** The saloon of a body between z0 and z1 (body frame; cab: behind the partition). */
function saloon(B, cab, z0, z1, lod) {
  const S = SALOON, X = S.xw, yf = S.yf, yc = S.yc;
  const za = cab ? S.part : z0 + 0.02, zb = z1 - 0.02;
  const doors = saloonDoors(cab);
  // floor (a little lighter in the aisle where it is worn), ceiling, light strips
  quadN(B, [-X, yf, za], [X, yf, za], [X, yf, zb], [-X, yf, zb], [0, 1, 0], INC.floor);
  quadN(B, [-0.95, yc, za], [0.95, yc, za], [0.95, yc, zb], [-0.95, yc, zb], [0, -1, 0], INC.ceil);
  for (const sx of [1, -1]) {
    quadN(B, [sx * 0.5, yc - 0.006, za + 0.2], [sx * 0.64, yc - 0.006, za + 0.2], [sx * 0.64, yc - 0.006, zb - 0.2], [sx * 0.5, yc - 0.006, zb - 0.2], [0, -1, 0], [1, 1, 1], 10);
    // coves from the window heads up to the ceiling
    const n = [-sx * 0.27, -0.96, 0];
    quadN(B, [sx * X, 2.4, za], [sx * 0.95, yc, za], [sx * 0.95, yc, zb], [sx * X, 2.4, zb], n, INC.ceil);
    // lining under the windows (kick strip, panel), door leaves up to their glazing
    let z = za;
    const runs = [];
    for (const dz of doors) { const a = dz - 0.66, b = dz + 0.66; if (a > z) runs.push([z, a, false]); runs.push([a, b, true]); z = b; }
    if (zb > z) runs.push([z, zb, false]);
    for (const [a, b, door] of runs) {
      const top = door ? 0.8 : S.sill, nIn = [-sx, 0, 0];
      quadN(B, [sx * X, yf, a], [sx * X, yf, b], [sx * X, 0.5, b], [sx * X, 0.5, a], nIn, door ? INC.door : INC.kick);
      quadN(B, [sx * X, 0.5, a], [sx * X, 0.5, b], [sx * X, top, b], [sx * X, top, a], nIn, door ? INC.door : INC.wall);
    }
  }
  // end walls: the cab partition (its door, the door's window onto the cab), the gangways
  const end = (z, dir) => {
    const n = [0, 0, dir];
    quadN(B, [-X, yf, z], [X, yf, z], [X, yc, z], [-X, yc, z], n, cab && z === za ? INC.part : INC.wall);
    const zz = z + dir * 0.005;
    if (cab && z === za) {
      quadN(B, [0.25, yf, zz], [0.85, yf, zz], [0.85, 2.15, zz], [0.25, 2.15, zz], n, INC.door);
      quadN(B, [0.33, 1.4, zz + dir * 0.003], [0.77, 1.4, zz + dir * 0.003], [0.77, 2.05, zz + dir * 0.003], [0.33, 2.05, zz + dir * 0.003], n, INC.win);
    } else {
      quadN(B, [-0.62, yf, zz], [0.62, yf, zz], [0.62, 2.12, zz], [-0.62, 2.12, zz], n, INC.gang);
    }
  };
  end(za, 1);
  end(zb, -1);
  // seat pairs: cushion on a pedestal, back with a rounded grab top; fabric towards the sitter
  const fabric = [[1, 1, 1], 20];
  for (let k = Math.ceil(za / S.pitch); (k + 1) * S.pitch <= zb + 1e-6; k++) {
    const zc = k * S.pitch, zm = zc + S.pitch / 2;
    if (!seatCell(zm, cab)) continue;
    const f = k % 2 === 0 ? 1 : -1, zbk = f > 0 ? zc + 0.04 : zc + S.pitch - 0.04;
    for (const sx of [1, -1]) {
      const x0 = sx > 0 ? 0.34 : -1.16, x1 = sx > 0 ? 1.16 : -0.34;
      const c0 = Math.min(zbk, zbk + f * 0.48), c1 = Math.max(zbk, zbk + f * 0.48);
      boxF(B, x0, x1, 0.74, S.seatY, c0, c1, (n) => (n[1] > 0.5 ? fabric : n[1] < -0.5 ? [null] : [INC.shell, 0]));
      boxF(B, x0, x1, 0.74, 1.33, zbk - 0.035, zbk + 0.035, (n) => (n[2] * f > 0.5 ? fabric : [INC.shell, 0]));
      boxF(B, x0 + 0.01, x1 - 0.01, 1.33, 1.39, zbk - 0.03, zbk + 0.03, () => [INC.shell, 0]);
      const xm = (x0 + x1) / 2;
      boxF(B, xm - 0.09, xm + 0.09, yf, 0.74, (c0 + c1) / 2 - 0.12, (c0 + c1) / 2 + 0.12, (n) => (n[1] !== 0 ? [null] : [INC.leg, 0]));
    }
    if (lod === 0) {
      // grab poles between back-to-back seats (every other bay, alternate sides)
      const pk = ((k % 8) + 8) % 8;
      if (pk === 0) tube(B, [-0.36, yf, zc], [-0.36, yc, zc], 0.018, 6, INC.steel);
      if (pk === 4) tube(B, [0.36, yf, zc], [0.36, yc, zc], 0.018, 6, INC.steel);
    }
  }
  if (lod === 0) {
    for (const dz of doors) tube(B, [0, yf, dz], [0, yc, dz], 0.019, 6, INC.steel);
    for (const sx of [1, -1]) tube(B, [sx * 0.42, 2.22, za + 0.1], [sx * 0.42, 2.22, zb - 0.1], 0.016, 6, INC.steel);
  }
}

// ------------------------------------------------------------------ bodies
/**
 * Geometry of every body type at every LOD:
 *   {cab: [{body, glassR, glassL, front, metal, inner, lampLead, lampTrail}, ...lods],
 *    mid: [{body, glassR, glassL, metal, inner, lampMid}, ...], hull: {cab, mid}, contact: {cab, mid},
 *    spots: {cab, mid} (the passengers' seats and standing spots, body frame)}.
 */
export function buildModels(atlas) {
  const J = CAR.joints, gapH = CAR.gap / 2;
  const cabLen = J[1] - J[0], midLen = J[2] - J[1];
  const out = { cab: [], mid: [] };
  for (let lod = 0; lod < 3; lod++) {
    const prof = profile(lod);
    // ---- cab body: nose at z = 0, articulation at z = cabLen
    {
      const P = new Parts();
      const z1 = cabLen - gapH;
      const doors = CAR.doors.filter((c) => c < J[1]);
      sideWalls(P, prof, sideLayout(CAR.capBase, z1, doors, lod, [CAR.capBase + 0.1, CAR.capBase + 1.4]));
      endWall(P.body, prof, z1, 1, COL.bellows, 0.02);
      const cap = capFront(P, prof, lod);
      noseFittings(P, lod);
      sideNumber(P.body, lod);
      // the air conditioning unit over the front of the saloon, the traction converter behind it
      fairing(P, 2.4, 5.2);
      fairing(P, 5.5, z1 - 0.45);
      if (lod < 2) saloon(P.inner, true, 0, z1, lod);
      runningGear(P.body, CAR.capBase, z1, lod < 2 ? CAR.bogies[0] : null, lod, true);
      const lampLead = new Part(), lampTrail = new Part();
      capLamps(lampLead, cap, prof, true, atlas);
      capLamps(lampTrail, cap, prof, false, atlas);
      for (const B of [lampLead, lampTrail]) doorLamps(B, doors, atlas, lod);
      out.cab.push({ ...P.geometries(), lampLead: lampLead.geometry(), lampTrail: lampTrail.geometry() });
    }
    // ---- centre body: articulation at z = 0 and z = midLen, bellows on both
    {
      const P = new Parts();
      const z0 = gapH, z1 = midLen - gapH;
      const doors = CAR.doors.filter((c) => c > J[1] && c < J[2]).map((c) => c - J[1]);
      sideWalls(P, prof, sideLayout(z0, z1, doors, lod), 100);
      endWall(P.body, prof, z0, -1, COL.bellows, 0.02);
      endWall(P.body, prof, z1, 1, COL.bellows, 0.02);
      bellows(P.body, prof, 0, lod);
      bellows(P.body, prof, midLen, lod);
      const pz = CAR.bogies[1] - J[1];
      fairing(P, z0 + 0.25, pz - 1.35);
      fairing(P, pz + 1.35, z1 - 0.25);
      pantograph(P, pz, lod);
      if (lod < 2) saloon(P.inner, false, z0, z1, lod);
      runningGear(P.body, z0, z1, lod < 2 ? pz : null, lod);
      const lampMid = new Part();
      doorLamps(lampMid, doors, atlas, lod);
      out.mid.push({ ...P.geometries(), lampMid: lampMid.geometry() });
    }
  }
  // (the shells meet at the articulations, over the bellows)
  out.hull = { cab: hull(0, cabLen, true), mid: hull(0, midLen, false) };
  out.contact = { cab: contact(0, cabLen, true), mid: contact(0, midLen, false) };
  out.spots = { cab: saloonSpots(true, 0, cabLen - gapH - 0.02), mid: saloonSpots(false, gapH + 0.02, midLen - gapH - 0.02) };
  return out;
}

/**
 * Coarse shell for the sun's depth pass (drawn with its back faces, as the depth pass draws
 * a front-sided material): the far-level body section along the car, the front cap on a cab,
 * flat ends reaching over the bellows to the articulation, and a floor at 0.3 m facing down.
 * Every ray from the sun through the car leaves it through a face above the street, so the
 * paving under the car and beside its shaded side lies in its shadow (an open bottom let the
 * sun through onto the street under the car), while the shell's own sunlit side never shades
 * the body. z0 / z1: the shell's ends (body frame).
 */
function hull(z0, z1, cab) {
  const P = new Part();
  const prof = profile(2);
  const fake = { body: P, glassR: P, glassL: P, front: P, metal: P, inner: P };
  sideWalls(fake, prof, [{ z0: cab ? CAR.capBase : z0, z1, kind: 'wall' }]);
  if (cab) capFront(fake, prof, 2);
  else endWall(P, prof, z0, -1, COL.silver);
  endWall(P, prof, z1, 1, COL.silver);
  floorPan(P, 0.3, z0, z1, COL.silver, cab, 0.02);
  return P.geometry();
}

/**
 * The contact shade under a body (drawn on the paving, multiplying it: trams/materials.js
 * makeContactMaterial): a flat quad 12 mm over the rail top covering the body's footprint
 * and a margin round its free sides, its ends cut square at the articulations so the
 * neighbouring bodies' quads meet. uv = body-frame (x, z), the centre body's z from 100.
 */
function contact(z0, z1, cab) {
  const P = new Part();
  const y = 0.012, hw = CAR.halfWidth + 0.35, za = cab ? CAR.capBase - noseDepth(Y.bottom) - 0.35 : z0;
  const off = cab ? 0 : 100, col = COL.white;
  const v = [[-hw, za], [hw, za], [hw, z1], [-hw, z1]].map(([x, z]) => P.vert(x, y, z, 0, 1, 0, col, x, z + off));
  P.quad(v[0], v[1], v[2], v[3]);
  return P.geometry();
}
