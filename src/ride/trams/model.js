import * as THREE from 'three';
import { CONTACT_WIRE_HEIGHT, RAIL_CENTER } from '../../core/config.js';
import { FONT } from './display.js';

// Procedural model of the line's light-rail vehicles (the oncoming units): a 32 m,
// 2.65 m wide, bidirectional low-floor tram in silver paint. Three bodies (two cab ends and
// a centre body on its own bogie) joined by bellows; a raked windscreen running down into a
// dark glass shield with LED lamps and the fleet number at its foot (headlights leading,
// red tail lamps trailing) and the lit destination display behind its top band; four
// double plug doors a side; roof fairings and a single-arm pantograph on the centre body
// that reaches the contact wire.
//
// Each body is built in its own frame: x to the right, y up from the rail top, local −z
// forward with z = 0 at the body's leading end (the nose tip, or the articulation point).
// The trailing cab reuses the leading cab's geometry turned round, so only its lamp mesh
// differs. Three levels of detail share the generators: LOD 0 (door seams, window frames,
// wheels, corrugated bellows, wiper), LOD 1 (plain glazing) and LOD 2 (coarse, for the
// far end of the street). One part per material (trams/materials.js): body (silver
// paint and dark trim, vertex colour = paint colour), glass (upper side glazing, lit from
// inside at night) and ws (lower panes, door glass), both with black frit over the
// pillars so the glazing reads as one flush band, front (windscreen, trim and dark mask,
// drawn per pixel), metal (pantograph) and lamps (unlit, from the display / lens atlas:
// display, head / tail lamps, door indicators).

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
const LAMP = { head: [45, 45, 44], tail: [14, 0.5, 0.17], door: [5, 0.55, 0.12], button: [0.25, 1.5, 0.45] };
const FLEET_NO = '07';

// cross-section: band edges and the rows the cab front needs
const Y = {
  bottom: 0.18, skirt: 0.3, floor: 0.33, belt: 0.95, winTop: 2.45, frame: 0.03,
  doorGlass0: 0.8, doorGlass1: 2.1, doorTop: 2.3, doorSeam: 2.33,
  ws0: 1.18, dispBand: 2.62, shoulder: 2.86, noseSkirt: 0.3,
  seatBack: 1.35,              // saloon glazing below this shows seat backs: it does not glow at night
};
const SHOULDER_R = 0.33;
const ROOF_CROWN = 0.03;
const DISP_U = 0.56;           // destination display half width (share)
const CAP_P = 2.6;             // plan shape of the front (superellipse exponent)
// centre-line depth of the front cap ahead of the cap base, by height (side view)
const NOSE = [[0.18, 0.92], [0.42, 1.08], [0.8, 1.15], [1.18, 1.12], [1.8, 0.99], [2.4, 0.8],
  [2.8, 0.58], [3.0, 0.42], [3.12, 0.26], [3.19, 0.1], [3.22, 0]];

const LOD_ROWS = [
  { side: [0.2, 0.26, 0.33, 0.42, 0.55, 0.62, 0.68, 0.74, 0.8, 0.95, 0.98, 1.06, 1.18, 1.35, 1.75, 2.1, 2.3, 2.33, 2.42, 2.45, 2.62, 2.75, 2.86],
    arc: [12, 25, 40, 55, 70, 82, 90], roof: [0.6, 0.3, 0] },
  { side: [0.2, 0.33, 0.42, 0.62, 0.72, 0.95, 1.18, 1.35, 1.75, 2.1, 2.45, 2.62, 2.86], arc: [12, 25, 55, 90], roof: [0.45, 0] },
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
  constructor() { this.body = new Part(); this.glass = new Part(); this.ws = new Part(); this.front = new Part(); this.metal = new Part(); }
  geometries() {
    const o = {};
    for (const k of ['body', 'glass', 'ws', 'front', 'metal']) o[k] = this[k].geometry();
    return o;
  }
}

// ------------------------------------------------------------------ side walls
/**
 * Window / door layout of the side wall between z0 and z1 (local), as cells
 * [{z0, z1, kind}] with kind: wall | win (glass) | wframe (black frame strip) |
 * dseam (door seam) | dleaf (door leaf frame) | dglass (door leaf glazing).
 */
function sideLayout(z0, z1, doors, lod, firstWin = null) {
  const cells = [];
  const PILLAR = 0.14, FR = lod === 0 ? Y.frame : 0;
  const wall = (a, b) => { if (b > a + 1e-4) cells.push({ z0: a, z1: b, kind: 'wall' }); };
  // between panes the glazing band carries on as black frit (flush glazing)
  const pillar = (a, b) => { if (b > a + 1e-4) cells.push({ z0: a, z1: b, kind: 'pillar' }); };
  const window = (a, b) => {
    if (FR) { cells.push({ z0: a, z1: a + FR, kind: 'wframe' }, { z0: a + FR, z1: b - FR, kind: 'win' }, { z0: b - FR, z1: b, kind: 'wframe' }); }
    else cells.push({ z0: a, z1: b, kind: 'win' });
  };
  const windows = (a, b) => {
    if (b - a < 0.5) { wall(a, b); return; }
    const n = Math.max(1, Math.round((b - a + PILLAR) / (1.45 + PILLAR)));
    const w = (b - a - (n - 1) * PILLAR) / n;
    for (let k = 0; k < n; k++) {
      const s = a + k * (w + PILLAR);
      window(s, s + w);
      if (k < n - 1) pillar(s + w, s + w + PILLAR);
    }
  };
  const door = (c) => {
    const h = CAR.doorW / 2;
    if (lod > 0) { cells.push({ z0: c - h, z1: c - 0.01, kind: 'dglass' }, { z0: c - 0.01, z1: c + 0.01, kind: lod === 1 ? 'dseam' : 'dglass' }, { z0: c + 0.01, z1: c + h, kind: 'dglass' }); return; }
    const S = 0.02, F = 0.09;
    for (const [a, b, k] of [[c - h, c - h + S, 'dseam'], [c - h + S, c - h + S + F, 'dleaf'], [c - h + S + F, c - 0.01 - F, 'dglass'],
      [c - 0.01 - F, c - 0.01, 'dleaf'], [c - 0.01, c + 0.01, 'dseam'], [c + 0.01, c + 0.01 + F, 'dleaf'],
      [c + 0.01 + F, c + h - S - F, 'dglass'], [c + h - S - F, c + h - S, 'dleaf'], [c + h - S, c + h, 'dseam']]) cells.push({ z0: a, z1: b, kind: k });
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
    if (ym < Y.floor) return body(COL.skirt);
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
 *  length); the glass shader tells the centre body (uOff 100) from the cab ends by it. */
function sideWalls(P, prof, cells, uOff = 0) {
  for (const cell of cells) {
    const u0 = cell.z0 + uOff, u1 = cell.z1 + uOff;
    for (let i = 0; i < prof.length - 1; i++) {
      const a = prof[i], b = prof[i + 1];
      // door and window rows only matter on the side; the roof takes the paint
      const [part, col] = cellMaterial(cell.kind, a.y, b.y);
      const B = P[part];
      for (const sx of [1, -1]) {
        const v0 = B.vert(sx * a.x, a.y, cell.z0, sx * a.nx, a.ny, 0, grimed(col, a.y), u0, a.a);
        const v1 = B.vert(sx * a.x, a.y, cell.z1, sx * a.nx, a.ny, 0, grimed(col, a.y), u1, a.a);
        const v2 = B.vert(sx * b.x, b.y, cell.z1, sx * b.nx, b.ny, 0, grimed(col, b.y), u1, b.a);
        const v3 = B.vert(sx * b.x, b.y, cell.z0, sx * b.nx, b.ny, 0, grimed(col, b.y), u0, b.a);
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

/** Rounded roof fairing (equipment cover) from z0 to z1 with closed ends. */
function fairing(B, z0, z1) {
  const half = [[0.8, CAR.roof - 0.04], [0.8, 3.4], [0.765, 3.465], [0.69, 3.495], [0, 3.505]];
  const pts = half.map(([x, y], i) => {
    const q = half[Math.max(0, i - 1)], r = half[Math.min(half.length - 1, i + 1)];
    const tx = r[0] - q[0], ty = r[1] - q[1], l = Math.hypot(tx, ty);
    return { x, y, nx: ty / l, ny: -tx / l, a: y };
  });
  pts[pts.length - 1].nx = 0; pts[pts.length - 1].ny = 1;
  sideWalls(B, pts, [{ z0, z1, kind: 'fairing' }]);
  endWall(B.body, pts, z0, -1, COL.fairing);
  endWall(B.body, pts, z1, 1, COL.fairing);
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

/** The front cap (nose, mask, windscreen) of a cab body; the display cells are left to capLamps. */
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
        if (ym > Y.dispBand && h <= hD) continue;                     // display: lamp mesh
        part = 'front'; col = COL.white;
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
  if (lod > 0) return;
  const B = P.body, dot = 0.0125, gw = 6 * dot, digits = FLEET_NO;
  const x0 = (digits.length * gw - dot) / 2;
  for (let k = 0; k < digits.length; k++) {
    const g = FONT[digits[k]];
    for (let r = 0; r < 7; r++) {
      for (let b = 0; b < 5; b++) {
        if (!(g[r] & (16 >> b))) continue;
        // viewer's left is +x: columns run towards −x
        const xa = x0 - k * gw - b * dot, ya = ym + 3.5 * dot - r * dot;
        const q = [[xa, ya], [xa - dot, ya], [xa - dot, ya - dot], [xa, ya - dot]].map(([x, y]) => {
          const u = x / sideX(y);
          capPoint(u, y, _cp); capNormal(u, y, _cn);
          return B.vert(_cp.x + _cn.x * 0.0065, _cp.y + _cn.y * 0.0065, _cp.z + _cn.z * 0.0065, _cn.x, _cn.y, _cn.z, COL.black);
        });
        B.quad(q[0], q[1], q[2], q[3]);
      }
    }
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

/** Lit parts of a cab end: destination display (both ends), headlights (leading) or tail lamps (trailing). */
function capLamps(B, cap, prof, lead, atlas) {
  const { pos, nrm, uu, nr, nc, c0, hD } = cap;
  const D = atlas.display;
  for (let i = 0; i < nr - 1; i++) {
    const ym = (prof[i].y + prof[i + 1].y) / 2;
    if (!(ym > Y.dispBand && ym < cap.wsTop)) continue;
    for (let j = 0; j < nc - 1; j++) {
      if (Math.max(Math.abs(j - c0), Math.abs(j + 1 - c0)) > hD) continue;
      const corner = [i * nc + j, i * nc + j + 1, (i + 1) * nc + j + 1, (i + 1) * nc + j];
      const v = corner.map((q) => {
        // text reads left to right seen from the front (the viewer's left is +x)
        const y = pos[q * 3 + 1], d = dispW(y);
        const su = clamp((d - uu[q]) / (2 * d), 0, 1);
        const sv = clamp((y - Y.dispBand) / (cap.wsTop - Y.dispBand), 0, 1);
        return B.vert(pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2], nrm[q * 3], nrm[q * 3 + 1], nrm[q * 3 + 2], COL.white,
          D[0] + (D[2] - D[0]) * su, D[1] + (D[3] - D[1]) * sv);
      });
      B.quad(v[0], v[1], v[2], v[3]);
    }
  }
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
 *  edge, head height), and the passengers' push button on a door leaf (a lit green ring,
 *  LOD 0), lit from the lens atlas. `zs` are door centres (body frame). */
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
      if (lod === 0) disc(sx, 1.12, c + sx * 0.055, 0.028, LAMP.button);
    }
  }
}

/** The fleet number painted on both sides under the cab's side window (LOD 0): black
 *  strokes from the 5 x 7 font, reading towards the viewer's right on either side. */
function sideNumber(B, lod) {
  if (lod > 0) return;
  const dot = 0.02, gw = 6 * dot, yc = 0.64, zc = 1.9, digits = FLEET_NO;
  const w = digits.length * gw - dot;
  for (const sx of [1, -1]) {
    for (let k = 0; k < digits.length; k++) {
      const g = FONT[digits[k]];
      for (let r = 0; r < 7; r++) {
        for (let b = 0; b < 5; b++) {
          if (!(g[r] & (16 >> b))) continue;
          // seen from the side the viewer's right is -z on the +x side, +z on the -x side
          const a = -w / 2 + k * gw + b * dot;
          const za = zc - sx * a, zb = zc - sx * (a + dot);
          const ya = yc + 3.5 * dot - r * dot, yb = ya - dot;
          const q = [[za, ya], [zb, ya], [zb, yb], [za, yb]].map(([z, y]) => B.vert(sx * (sideX(y) + 0.002), y, z, sx, 0, 0, COL.black));
          B.quad(q[0], q[1], q[2], q[3]);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ running gear, pantograph
function runningGear(B, z0, z1, bogieZ) {
  // dark underfloor (closes the shell above the bogies)
  const y = 0.3, x = sideX(Y.bottom) - 0.06;
  const v = [B.vert(-x, y, z0, 0, -1, 0, COL.under), B.vert(x, y, z0, 0, -1, 0, COL.under), B.vert(x, y, z1, 0, -1, 0, COL.under), B.vert(-x, y, z1, 0, -1, 0, COL.under)];
  B.quad(v[0], v[1], v[2], v[3]);
  if (bogieZ == null) return;
  for (const dz of [-CAR.axleHalf, CAR.axleHalf]) {
    for (const s of [1, -1]) {
      const xc = s * RAIL_CENTER;
      tube(B, [xc - 0.055, CAR.wheelR, bogieZ + dz], [xc + 0.055, CAR.wheelR, bogieZ + dz], CAR.wheelR, 16, COL.wheel, true);
    }
  }
  for (const s of [1, -1]) box(B, s * 0.95 - 0.12, s * 0.95 + 0.12, 0.22, 0.5, bogieZ - 1.15, bogieZ + 1.15, COL.under);
}

/**
 * Single-arm pantograph standing on the centre body's roof at z, raised to the
 * contact wire. Insulators go to the body part (paint), the frame to metal.
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
    tube(M, [sx * 0.36, y0 + 0.22, z - 0.68], [sx * 0.36, y0 + 0.22, z + 0.68], 0.035, sides, col, true);
  }
  for (const dz of [-0.55, 0.55]) tube(M, [-0.4, y0 + 0.22, z + dz], [0.4, y0 + 0.22, z + dz], 0.03, sides, col, true);
  // arms: lower arm from the base hinge, knee forward (−z), upper frame back up to the head
  const top = CONTACT_WIRE_HEIGHT - 0.012;
  const H = [0, y0 + 0.3, z + 0.62], Ll = 1.75, Lu = 1.98;
  const headY = top - 0.12;
  // knee: solve for the head standing above the base centre
  const kz = z - 0.95, ky = H[1] + Math.sqrt(Math.max(0.01, Ll * Ll - (H[2] - kz) ** 2));
  const hz = kz + Math.sqrt(Math.max(0.01, Lu * Lu - (headY - ky) ** 2));
  const K = [0, ky, kz], Hd = [0, headY, hz];
  tube(M, H, K, 0.05 * thick, sides, col, true, 0.035 * thick);                    // lower arm
  tube(M, [0, H[1] - 0.12, H[2] + 0.14], [0, K[1] - 0.1, K[2] + 0.05], 0.014 * thick, sides, col, true); // push rod
  for (const sx of [1, -1]) tube(M, K, [sx * 0.24, Hd[1], Hd[2]], 0.022 * thick, sides, col, true, 0.018 * thick); // upper frame
  if (lod < 2) tube(M, [-0.06, H[1], H[2]], [0.06, H[1], H[2]], 0.09, sides, col, true);   // hinge / drive
  // head: two carbon strips on a cross frame, horns at the ends
  tube(M, [-0.3, Hd[1], Hd[2]], [0.3, Hd[1], Hd[2]], 0.02 * thick, sides, col, true);
  for (const dz of [-0.16, 0.16]) {
    tube(M, [0, Hd[1], Hd[2]], [0, Hd[1] + 0.06, Hd[2] + dz], 0.016 * thick, sides, col);
    box(B, -0.55, 0.55, top - 0.045, top, Hd[2] + dz - 0.025, Hd[2] + dz + 0.025, COL.black);   // carbon strip
    for (const sx of [1, -1]) {
      const pts = [[sx * 0.55, top - 0.03], [sx * 0.72, top - 0.05], [sx * 0.84, top - 0.12], [sx * 0.88, top - 0.2]];
      const n = lod === 0 ? 3 : 1;
      for (let k = 0; k < n; k++) {
        const a = pts[lod === 0 ? k : 0], b = pts[lod === 0 ? k + 1 : 3];
        tube(M, [a[0], a[1], Hd[2] + dz], [b[0], b[1], Hd[2] + dz], 0.016 * thick, sides, col, true);
      }
    }
  }
}

// ------------------------------------------------------------------ bodies
/**
 * Geometry of every body type at every LOD:
 *   {cab: [{body, glass, ws, lampLead, lampTrail}, ...lods], mid: [{body, glass, metal}, ...],
 *    hull: {cab, mid}} plus the length / joint table.
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
      fairing(P, 2.4, z1 - 0.45);
      if (lod === 0) runningGear(P.body, CAR.capBase, z1, CAR.bogies[0]);
      else if (lod === 1) runningGear(P.body, CAR.capBase, z1, null);
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
      if (lod === 0) runningGear(P.body, z0, z1, pz);
      else if (lod === 1) runningGear(P.body, z0, z1, null);
      const lampMid = new Part();
      doorLamps(lampMid, doors, atlas, lod);
      out.mid.push({ ...P.geometries(), lampMid: lampMid.geometry() });
    }
  }
  out.hull = { cab: hull(cabLen - gapH, true), mid: hull(midLen - gapH, false) };
  return out;
}

/** Coarse closed shell for the sun's depth pass. */
function hull(z1, cab) {
  const P = new Part();
  const half = [[1.15, 0.2], [1.32, 0.9], [1.22, 2.86], [0.88, 3.19], [0, 3.22]];
  const prof = half.map(([x, y], i) => {
    const q = half[Math.max(0, i - 1)], r = half[Math.min(half.length - 1, i + 1)];
    const tx = r[0] - q[0], ty = r[1] - q[1], l = Math.hypot(tx, ty);
    return { x, y, nx: ty / l, ny: -tx / l, a: y };
  });
  const z0 = cab ? 0.45 : CAR.gap / 2;
  const fake = { body: P, glass: P, ws: P, metal: P };
  sideWalls(fake, prof, [{ z0, z1, kind: 'wall' }]);
  endWall(P, prof, z0, -1, COL.silver);
  endWall(P, prof, z1, 1, COL.silver);
  return P.geometry();
}
