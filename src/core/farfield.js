import * as THREE from 'three';
import { facadePlan } from '../world/facadePlan.js';
import { U } from './uniforms.js';
import { TRACK_ZONE_HALF, EDGE_BAND_W, CHUNK_LEN, VIEW_FAR } from './config.js';

// Far field: the city beyond the streamed range, from VIEW_AHEAD to VIEW_FAR ahead of the
// camera (lod 2 chunks, which only builders listing 2 in `lods` are asked to build). On a
// long straight the street, the frontages and the tree lines run on to the vanishing point
// instead of ending in sky. Everything comes from the master plan, so the far field is the
// same city the modules build when it comes within VIEW_AHEAD: each lot is a block of its
// plan's height with its stone tint, its cornice, balconies and openings (dark glass, lit
// at dusk), tile roofs and penthouses; the paving runs between the facade lines, with the
// light corridor edge bands and the side-street mouths; trees are irregular crowns on
// trunks. One merged mesh and one material per chunk; build ≈ 0.2–0.4 ms.

const STONE = [0.59, 0.535, 0.43];        // mean albedo of the ashlar texture (linear)
const CREAM = [0.86, 0.80, 0.68];         // facadePlan tint the stone texture corresponds to
const GLASS = [0.03, 0.034, 0.038];
const DOOR = [0.07, 0.045, 0.03];
const SHUTTER = { darkgreen: [0.03, 0.07, 0.04], brown: [0.12, 0.06, 0.03], grey: [0.2, 0.2, 0.19], teal: [0.03, 0.09, 0.09], white: [0.55, 0.55, 0.52] };
const ROOF_FLAT = [0.3, 0.29, 0.27];
const ROOF_TILE = [0.36, 0.12, 0.055];
const PAVE = [0.17, 0.176, 0.19];         // paving (corridor and sidewalks)
const BAND = [0.25, 0.245, 0.235];        // light stone edge bands of the track corridor
const BARK = [0.09, 0.08, 0.065];
const LEAF = [0.06, 0.1, 0.028];        // crown albedo (leaves, gaps and inner shade averaged)
const POLE = [0.1, 0.115, 0.105];
const POLE_TOP = 8.45, POLE_W = 0.17;
const LAMP_Y = 5.7, LAMP_GLOW = 6, LANTERN = [0.5, 0.48, 0.42];
const SIDE_FULL = 30;                     // side-street lots nearer than this (m) get openings

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _n = new THREE.Vector3(), _a2 = new THREE.Vector3();

/** Indexed triangle soup with position, normal, colour and a night-glow weight. */
class Geo {
  constructor() { this.p = []; this.n = []; this.c = []; this.g = []; this.i = []; }
  vert(v, n, c, g) {
    this.p.push(v.x, v.y, v.z); this.n.push(n.x, n.y, n.z); this.c.push(c[0], c[1], c[2]); this.g.push(g);
    return this.p.length / 3 - 1;
  }
  /** Quad a-b-c-d counter-clockwise seen from the side the normal points to. */
  quad(a, b, c, d, n, col, glow = 0) {
    const i = this.vert(a, n, col, glow); this.vert(b, n, col, glow); this.vert(c, n, col, glow); this.vert(d, n, col, glow);
    this.i.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  /** Triangle with per-vertex normals (na, nb, nc). */
  tri(a, b, c, na, nb, nc, col, glow = 0) {
    const i = this.vert(a, na, col, glow); this.vert(b, nb, col, glow); this.vert(c, nc, col, glow);
    this.i.push(i, i + 1, i + 2);
  }
  geometry() {
    if (!this.i.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.g, 1));
    g.setIndex(this.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Facade frame helper: P(u, v, w) → world (frame.matrix basis, v from floorRef). */
function framePoint(f, u, v, w, out) {
  return out.copy(f.origin).addScaledVector(f.uDir, u).addScaledVector(f.up, v).addScaledVector(f.nDir, w);
}

const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/** Absolute stone albedo of a plan (its tint relative to the cream the texture carries). */
function stoneOf(plan) {
  const t = plan.style.tint;
  return [0, 1, 2].map((i) => STONE[i] * Math.pow(t[i] / CREAM[i], 1.25));
}

/**
 * Facade face from u0..u1 between v = vBot(u) (ground, linear in u) and vTop, with its
 * openings let in as separate quads (no coplanar overlap: the wall is cut around them, so
 * nothing z-fights at a kilometre). Openings are grouped per floor into horizontal bands.
 */
function facadeFace(G, f, width, vBot0, vBot1, vTop, openings, wall, skipBand = null, shutterCol = SHUTTER.darkgreen) {
  const n = _n.copy(f.nDir);
  const bot = (u) => vBot0 + (vBot1 - vBot0) * (u / width);
  const Q = (u0, v0, u1, v1, col, glow = 0) => {
    if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return;
    G.quad(framePoint(f, u0, v0, 0, _a), framePoint(f, u1, v0, 0, _b), framePoint(f, u1, v1, 0, _c), framePoint(f, u0, v1, 0, _d), n, col, glow);
  };
  // bands of openings, one per floor (sorted bottom-up)
  const floors = new Map();
  for (const o of openings) {
    if (o.y + o.h <= 0.05 || o.y >= vTop) continue;
    let b = floors.get(o.floor);
    if (!b) floors.set(o.floor, (b = { lo: Infinity, hi: -Infinity, list: [] }));
    b.lo = Math.min(b.lo, Math.max(0, o.y)); b.hi = Math.max(b.hi, Math.min(vTop, o.y + o.h)); b.list.push(o);
  }
  const bands = [...floors.values()].sort((a, b) => a.lo - b.lo);
  // merge overlapping bands (balcony doors reach down to the slab)
  const merged = [];
  for (const b of bands) {
    const m = merged[merged.length - 1];
    if (m && b.lo < m.hi) { m.hi = Math.max(m.hi, b.hi); m.list.push(...b.list); } else merged.push(b);
  }
  // wall from the ground (sloped bottom edge) to the first band: trapezoid strips
  let v = merged.length ? merged[0].lo : vTop;
  {
    const N = 2;
    for (let k = 0; k < N; k++) {
      const u0 = (width * k) / N, u1 = (width * (k + 1)) / N;
      const b0 = Math.min(bot(u0), v), b1 = Math.min(bot(u1), v);
      if (v - Math.max(b0, b1) > 1e-3 || v - Math.min(b0, b1) > 1e-3) {
        G.quad(framePoint(f, u0, b0, 0, _a), framePoint(f, u1, b1, 0, _b), framePoint(f, u1, v, 0, _c), framePoint(f, u0, v, 0, _d), n, wall);
      }
    }
  }
  for (let bi = 0; bi < merged.length; bi++) {
    const b = merged[bi];
    const list = b.list.sort((x, y) => x.uc - y.uc);
    let u = 0;
    for (const o of list) {
      const ou0 = Math.max(u, o.uc - o.w / 2), ou1 = Math.min(width, o.uc + o.w / 2);
      if (ou1 <= ou0) continue;
      const oy0 = Math.max(b.lo, o.y), oy1 = Math.min(b.hi, o.y + o.h - (o.rise || 0) * 0.35);
      Q(u, b.lo, ou0, b.hi, wall);
      Q(ou0, b.lo, ou1, oy0, wall);
      Q(ou0, oy1, ou1, b.hi, wall);
      Q(ou0, oy0, ou1, oy1, ...openingLook(o, shutterCol, wall));
      u = ou1;
    }
    Q(u, b.lo, width, b.hi, wall);
    const next = bi + 1 < merged.length ? merged[bi + 1].lo : vTop;
    if (skipBand && b.hi < skipBand[1] && next > skipBand[0]) {
      Q(0, b.hi, width, Math.min(next, skipBand[0]), wall);
      Q(0, Math.max(b.hi, skipBand[1]), width, next, wall);
    } else Q(0, b.hi, width, next, wall);
    v = next;
  }
}

/** Colour and night glow of an opening. */
function openingLook(o, shutterCol, wall) {
  if (o.kind === 'shop') return [mul(wall, 0.2), 0.3 + 0.3 * (o.lit ?? 0.5)];
  if (o.kind === 'door') return [DOOR, 0];
  if (o.shutters === 'closed') return [shutterCol, 0];
  const lit = (o.lit ?? 0) > 0.8 ? 0.35 + 0.4 * o.lit : 0;   // about one window in five
  return [GLASS, lit];
}

/** Box sides (end walls) and top of a block behind a facade, depth `depth` into the lot. */
function blockShell(G, f, width, depth, vBot0, vBot1, vTop, wall, roofCol) {
  // end walls: at u = 0 facing −uDir, at u = width facing +uDir
  const nl = _n.copy(f.uDir).negate();
  G.quad(framePoint(f, 0, vBot0, -depth, _a), framePoint(f, 0, vBot0, 0, _b), framePoint(f, 0, vTop, 0, _c), framePoint(f, 0, vTop, -depth, _d), nl, mul(wall, 0.93));
  const nr = _n.copy(f.uDir);
  G.quad(framePoint(f, width, vBot1, 0, _a), framePoint(f, width, vBot1, -depth, _b), framePoint(f, width, vTop, -depth, _c), framePoint(f, width, vTop, 0, _d), nr, mul(wall, 0.93));
  // roof
  G.quad(framePoint(f, 0, vTop, 0, _a), framePoint(f, width, vTop, 0, _b), framePoint(f, width, vTop, -depth, _c), framePoint(f, 0, vTop, -depth, _d), f.up, roofCol);
}

/** Pitched tile roof over the block (ridge along u, at mid depth). */
function tileRoof(G, f, width, depth, v0, pitchDeg) {
  const rise = Math.min(6, (depth / 2) * Math.tan((pitchDeg * Math.PI) / 180));
  const half = depth / 2;
  const nF = _n.copy(f.nDir).multiplyScalar(rise).addScaledVector(f.up, half).normalize();
  G.quad(framePoint(f, 0, v0, 0.3, _a), framePoint(f, width, v0, 0.3, _b), framePoint(f, width, v0 + rise, -half, _c), framePoint(f, 0, v0 + rise, -half, _d), nF.clone(), ROOF_TILE);
  const nB = _n.copy(f.nDir).multiplyScalar(-rise).addScaledVector(f.up, half).normalize();
  G.quad(framePoint(f, width, v0, -depth, _a), framePoint(f, 0, v0, -depth, _b), framePoint(f, 0, v0 + rise, -half, _c), framePoint(f, width, v0 + rise, -half, _d), nB.clone(), ROOF_TILE);
  // gables
  const gl = _n.copy(f.uDir).negate(), gr = f.uDir;
  const gcol = [ROOF_TILE[0] * 0.8, ROOF_TILE[1] * 0.8, ROOF_TILE[2] * 0.8];
  G.tri(framePoint(f, 0, v0, -depth, _a), framePoint(f, 0, v0, 0, _b), framePoint(f, 0, v0 + rise, -half, _c), gl, gl, gl, gcol);
  G.tri(framePoint(f, width, v0, 0, _a), framePoint(f, width, v0, -depth, _b), framePoint(f, width, v0 + rise, -half, _c), gr, gr, gr, gcol);
}

/** Cornice: a projecting band (soffit, face, top) along the whole front. */
function cornice(G, f, width, c, wall) {
  const y0 = c.y, y1 = c.y + c.h, p = c.proj;
  G.quad(framePoint(f, 0, y0, p, _a), framePoint(f, width, y0, p, _b), framePoint(f, width, y1, p, _c), framePoint(f, 0, y1, p, _d), f.nDir, mul(wall, 1.03));
  const down = _n.copy(f.up).negate();
  G.quad(framePoint(f, 0, y0, 0, _a), framePoint(f, width, y0, 0, _b), framePoint(f, width, y0, p, _c), framePoint(f, 0, y0, p, _d), down, mul(wall, 0.55));
  G.quad(framePoint(f, 0, y1, p, _a), framePoint(f, width, y1, p, _b), framePoint(f, width, y1, 0, _c), framePoint(f, 0, y1, 0, _d), f.up, mul(wall, 0.9));
}

/** Balcony: slab front and the railing seen as a darker band in front of the wall. */
function balcony(G, f, b, wall) {
  const w = b.depth, y = b.y;
  const rail = b.railing === 'stone' ? mul(wall, 0.85) : mul(wall, 0.42);
  G.quad(framePoint(f, b.u0, y - b.slabT, w, _a), framePoint(f, b.u1, y - b.slabT, w, _b), framePoint(f, b.u1, y, w, _c), framePoint(f, b.u0, y, w, _d), f.nDir, mul(wall, 0.95));
  G.quad(framePoint(f, b.u0, y, w, _a), framePoint(f, b.u1, y, w, _b), framePoint(f, b.u1, y + 1.0, w, _c), framePoint(f, b.u0, y + 1.0, w, _d), f.nDir, rail);
  const down = _n.copy(f.up).negate();
  G.quad(framePoint(f, b.u0, y - b.slabT, 0, _a), framePoint(f, b.u1, y - b.slabT, 0, _b), framePoint(f, b.u1, y - b.slabT, w, _c), framePoint(f, b.u0, y - b.slabT, w, _d), down, mul(wall, 0.5));
}

function lotBlock(G, lot, full) {
  const plan = facadePlan(lot);
  const f = lot.frame, W = plan.width, depth = Math.max(8, plan.depth || lot.depth || 14);
  const wall = stoneOf(plan);
  const g0 = plan.groundAt(0) - 0.6, g1 = plan.groundAt(W) - 0.6;
  const top = plan.totalHeight;
  const c = plan.cornice;
  if (full) {
    facadeFace(G, f, W, g0, g1, top, plan.openings, wall, [c.y, c.y + c.h], SHUTTER[plan.style.shutterColor] || SHUTTER.darkgreen);
    cornice(G, f, W, c, wall);
    for (const b of plan.balconies) balcony(G, f, b, wall);
  } else {
    facadeFace(G, f, W, g0, g1, top, [], wall);
  }
  blockShell(G, f, W, depth, g0, g1, top, wall, ROOF_FLAT);
  if (plan.roof && plan.roof.type === 'tile') tileRoof(G, f, W, depth, top, plan.roof.pitch || 26);
  const up = plan.upper;
  if (up && full) {
    const uf = up.frame, h = up.v0 + up.floors * up.floorH + 0.5;
    const ucol = up.material === 'plaster' ? up.color.map((x) => x * 0.68) : wall;
    facadeFace(G, uf, up.width, up.v0, up.v0, h, up.openings, ucol);
    blockShell(G, uf, up.width, up.depth, up.v0, up.v0, h, ucol, ROOF_FLAT);
  }
}

// Crown templates: irregular blobs (an icosphere, subdivided once, with a low-frequency
// bulge), positions in a unit box, soft normals leaned towards the sky (foliage, not a
// ball) and a shade factor that darkens the underside. Built once; trees pick one, turn
// it by a quarter turn and scale it, so a far chunk's trees cost a few microseconds each.
const CROWN_VARIANTS = 6;
let CROWNS = null;
function crownTemplates() {
  if (CROWNS) return CROWNS;
  const ico = new THREE.IcosahedronGeometry(1, 1);
  const pos = ico.getAttribute('position');   // non-indexed: consecutive triples, CCW outwards
  // shared vertices (42) and the triangle list
  const key = new Map(), V = [], I = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let j = key.get(k);
    if (j === undefined) { j = V.length; key.set(k, j); V.push([x, y, z]); }
    I.push(j);
  }
  ico.dispose();
  CROWNS = [];
  for (let k = 0; k < CROWN_VARIANTS; k++) {
    const seed = 1.7 + k * 2.39;
    const P = new Float32Array(V.length * 3), N = new Float32Array(V.length * 3), S = new Float32Array(V.length);
    V.forEach(([x, y, z], i) => {
      const b = 1 + 0.2 * Math.sin(x * 3.1 + seed) * Math.cos(z * 2.7 + seed * 0.37) + 0.12 * Math.sin(y * 4.3 + seed * 1.3);
      P[i * 3] = x * b; P[i * 3 + 1] = y * b; P[i * 3 + 2] = z * b;
      const nx = x, ny = y + 0.7, nz = z, l = Math.hypot(nx, ny, nz);
      N[i * 3] = nx / l; N[i * 3 + 1] = ny / l; N[i * 3 + 2] = nz / l;
      S[i] = 0.55 + 0.45 * (y * 0.5 + 0.5);
    });
    CROWNS.push({ P, N, S, n: V.length, index: I });
  }
  return CROWNS;
}

// quarter turns about the vertical (keep the frame right-handed, so windings stay outwards)
const TURNS = [[1, 0, 0, 1], [0, 1, -1, 0], [-1, 0, 0, -1], [0, -1, 1, 0]];

function tree(G, route, t) {
  const h = (t.seed || 1) >>> 0;
  const base = route.toWorld(t.s, t.d, 0, _a);
  const bx = base.x, by = base.y, bz = base.z;
  const H = t.height || 6, R = (t.crown || 3.2) * 0.42;
  const ch = Math.min(H * 0.62, R * 1.9);             // crown height
  const cy = H - ch * 0.5;
  const val = 0.8 + 0.35 * ((h >>> 8) & 255) / 255, hue = 0.16 * (((h >>> 16) & 255) / 255 - 0.5);
  // trunk: a thin square post up into the crown
  const tw = 0.13 + (0.03 * H) / 6;
  const C = [[-tw, -tw], [tw, -tw], [tw, tw], [-tw, tw]];
  for (let k = 0; k < 4; k++) {
    const [x0, z0] = C[k], [x1, z1] = C[(k + 1) % 4];
    _n.set((x0 + x1) / 2, 0, (z0 + z1) / 2).normalize();
    // corners run clockwise seen from above in (x, z): reverse for outward faces
    G.quad(_b.set(bx + x1, by, bz + z1), _c.set(bx + x0, by, bz + z0), _d.set(bx + x0, by + cy, bz + z0), _a2.set(bx + x1, by + cy, bz + z1), _n, BARK);
  }
  // crown: a cluster of small irregular clumps (three, four for the mature trees), so the
  // silhouette breaks up like foliage instead of reading as one ball
  const T = crownTemplates();
  const lobes = t.mature ? 4 : 3;
  for (let l = 0; l < lobes; l++) {
    const hl = Math.imul(h ^ (l * 0x9e3779b1), 0x85ebca6b) >>> 0;
    const tpl = T[hl % CROWN_VARIANTS], [a, b, c, d] = TURNS[(hl >>> 5) & 3];
    const ang = (l / lobes) * 6.283 + ((hl >>> 8) & 255) / 255 * 1.5;
    const rad = R * (0.32 + 0.18 * (((hl >>> 16) & 255) / 255));
    const rr = R * (0.58 + 0.12 * (((hl >>> 24) & 255) / 255)), hh = ch * 0.36;
    const ox = bx + Math.cos(ang) * rad, oz = bz + Math.sin(ang) * rad;
    const oy = by + cy + ((l % 2 ? 0.16 : -0.1) + 0.06 * Math.sin(ang * 3)) * ch;
    const i0 = G.p.length / 3;
    for (let i = 0; i < tpl.n; i++) {
      const x = tpl.P[i * 3], y = tpl.P[i * 3 + 1], z = tpl.P[i * 3 + 2];
      const nx = tpl.N[i * 3], ny = tpl.N[i * 3 + 1], nz = tpl.N[i * 3 + 2];
      G.p.push(ox + (a * x + b * z) * rr, oy + y * hh, oz + (c * x + d * z) * rr);
      G.n.push(a * nx + b * nz, ny, c * nx + d * nz);
      const sh = val * tpl.S[i];
      G.c.push(LEAF[0] * sh * (1 + hue), LEAF[1] * sh, LEAF[2] * sh * (1 - hue));
      G.g.push(-1);   // foliage (mottled in the shader)
    }
    for (const j of tpl.index) G.i.push(i0 + j);
  }
}

/** Lamp / catenary standard: a thin square post (sub-pixel beyond ~700 m at the default
 *  lens, so MSAA draws it as the faint line the real row of poles makes). */
function pole(G, route, p) {
  const base = route.toWorld(p.s, p.d, 0, _a);
  const bx = base.x, by = base.y - 0.1, bz = base.z, w = POLE_W / 2;
  const C = [[-w, -w], [w, -w], [w, w], [-w, w]];
  for (let k = 0; k < 4; k++) {
    const [x0, z0] = C[k], [x1, z1] = C[(k + 1) % 4];
    _n.set((x0 + x1) / 2, 0, (z0 + z1) / 2).normalize();
    G.quad(_b.set(bx + x1, by, bz + z1), _c.set(bx + x0, by, bz + z0), _d.set(bx + x0, by + POLE_TOP, bz + z0), _a2.set(bx + x1, by + POLE_TOP, bz + z1), _n, POLE);
  }
  if (!p.lamp) return;
  // lantern: a small glowing octahedron at the lamp height (the row of lights at dusk)
  const ly = by + LAMP_Y, r = 0.28;
  const V = [[r, 0, 0], [0, 0, r], [-r, 0, 0], [0, 0, -r]];
  for (let k = 0; k < 4; k++) {
    const [x0, , z0] = V[k], [x1, , z1] = V[(k + 1) % 4];
    for (const sy of [1, -1]) {
      const a = _b.set(bx + x0, ly, bz + z0), b = _c.set(bx + x1, ly, bz + z1), t = _d.set(bx, ly + sy * r * 1.2, bz);
      _n.set(x0 + x1, sy * r, z0 + z1).normalize();
      if (sy > 0) G.tri(b, a, t, _n, _n, _n, LANTERN, LAMP_GLOW); else G.tri(a, b, t, _n, _n, _n, LANTERN, LAMP_GLOW);
    }
  }
}

/** Paving from facade line to facade line, the corridor edge bands lighter. */
function paving(G, app, chunk) {
  const { s0, s1 } = chunk;
  const { route, layout } = app;
  const step = 5;
  const n = Math.max(1, Math.round((s1 - s0) / step));
  const up = new THREE.Vector3(0, 1, 0);
  const prof = (s) => {
    const hl = layout.halfWidth(s, -1) + 0.8, hr = layout.halfWidth(s, +1) + 0.8;
    const e = TRACK_ZONE_HALF, b = EDGE_BAND_W;
    return [[-hl, PAVE], [-e - b * 0.5, BAND], [-e + b * 0.5, PAVE], [e - b * 0.5, BAND], [e + b * 0.5, PAVE], [hr, null]];
  };
  for (let i = 0; i < n; i++) {
    const sa = s0 + ((s1 - s0) * i) / n, sb = s0 + ((s1 - s0) * (i + 1)) / n;
    const pa = prof(sa), pb = prof(sb);
    for (let k = 0; k < pa.length - 1; k++) {
      // strips run left (−d) to right (+d); counter-clockwise from above
      G.quad(route.toWorld(sa, pa[k][0], 0, _a), route.toWorld(sa, pa[k + 1][0], 0, _b), route.toWorld(sb, pb[k + 1][0], 0, _c), route.toWorld(sb, pb[k][0], 0, _d), up, pa[k][1]);
    }
  }
  // side-street mouths: level paving reaching into the cross street
  for (const c of layout.inChunk('crossStreets', chunk.index)) {
    const sides = c.side === 0 ? [-1, +1] : [c.side];
    for (const side of sides) {
      const hw = layout.halfWidth(c.s, side);
      const y = route.groundY(c.s, side * hw);
      const sm = c.s - c.width / 2 - 1, sp = c.s + c.width / 2 + 1;
      const a = route.toWorld(sm, side * (hw - 0.5), 0, _a), b = route.toWorld(sp, side * (hw - 0.5), 0, _b);
      const smp = route.sample(c.s);
      const out = smp.right.clone().multiplyScalar(side).applyAxisAngle(up, c.angle || 0).multiplyScalar(c.depth + 20);
      const cc = _c.copy(b).add(out), dd = _d.copy(a).add(out);
      a.y = b.y = cc.y = dd.y = y - 0.02;
      if (side > 0) G.quad(a, dd, cc, b, up, PAVE); else G.quad(a, b, cc, dd, up, PAVE);
    }
  }
}

// crowns (aGlow < 0): leaf clumps and gaps as a two-octave value noise on the albedo
const FRAG_NOISE = /* glsl */ `
float ffHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float ffNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(ffHash(i), ffHash(i + vec3(1, 0, 0)), f.x), mix(ffHash(i + vec3(0, 1, 0)), ffHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(ffHash(i + vec3(0, 0, 1)), ffHash(i + vec3(1, 0, 1)), f.x), mix(ffHash(i + vec3(0, 1, 1)), ffHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;
const FRAG_FOLIAGE = /* glsl */ `
if (vGlow < -0.5) {
  vec3 q = vFfPos * 1.6;
  float nz = ffNoise(q) * 0.62 + ffNoise(q * 2.7 + 7.1) * 0.38;
  diffuseColor.rgb *= 0.25 + 1.5 * nz * nz;
}
`;

const farfield = {
  name: 'farfield',
  lods: [2],

  init(app) {
    this.app = app;
    const gain = (app.materials.uniforms && app.materials.uniforms.emissiveGain) || { value: 1 };
    const m = new THREE.MeshStandardMaterial({ name: 'farfield', vertexColors: true, roughness: 0.92, metalness: 0 });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.ffNight = U.uNight;
      shader.uniforms.ffGain = gain;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;\nvarying vec3 vFfPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvFfPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float ffNight;\nuniform float ffGain;\nvarying float vGlow;\nvarying vec3 vFfPos;\n' + FRAG_NOISE)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_FOLIAGE)
        .replace('#include <lights_physical_fragment>', 'totalEmissiveRadiance += vec3(1.0, 0.66, 0.38) * 0.005 * ffGain * max(vGlow, 0.0) * smoothstep(0.25, 0.75, ffNight);\n#include <lights_physical_fragment>');
    };
    m.customProgramCacheKey = () => 'farfield2';
    this.material = app.materials.track ? app.materials.track(m) : m;
    this.stats = { builds: 0, ms: 0, maxMs: 0, tris: 0 };
  },

  build(chunk, app) {
    const t0 = performance.now();
    const { layout, route } = app;
    const G = new Geo();
    paving(G, app, chunk);
    for (const lot of layout.inChunk('lots', chunk.index)) lotBlock(G, lot, true);
    for (const lot of layout.inChunk('sideLots', chunk.index)) lotBlock(G, lot, lot.x0 < SIDE_FULL);
    for (const t of layout.inChunk('trees', chunk.index)) tree(G, route, t);
    for (const p of layout.inChunk('poles', chunk.index)) pole(G, route, p);
    const geo = G.geometry();
    const dt = performance.now() - t0;
    this.stats.builds++; this.stats.ms = dt; this.stats.maxMs = Math.max(this.stats.maxMs, dt);
    if (!geo) return null;
    this.stats.tris = geo.index.count / 3;
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = 'farfield';
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    return mesh;
  },

  dispose(obj) { if (obj.geometry) obj.geometry.dispose(); },

  /** Plans the facades of the next far chunks ahead of need, a lot or two per frame, so a
   *  ride-time build only assembles geometry (the plans are shared with the modules). */
  update(dt, app) {
    const s = app.cameraS;
    if (s == null || !app.layout) return;
    const L = app.layout, n = L.nChunks;
    const iA = Math.floor((s + VIEW_FAR) / CHUNK_LEN) + 1, iB = iA + 3;
    if (this._cur === undefined || this._cur < iA - 2 || this._cur > iB) { this._cur = iA; this._lot = 0; }
    const t0 = performance.now();
    while (this._cur <= iB && performance.now() - t0 < 0.35) {
      const idx = ((this._cur % n) + n) % n;
      const lots = L.inChunk('lots', idx), side = L.inChunk('sideLots', idx);
      const k = this._lot++;
      if (k < lots.length) facadePlan(lots[k]);
      else if (k < lots.length + side.length) facadePlan(side[k - lots.length]);
      else { this._cur++; this._lot = 0; }
    }
  },
};

export default farfield;
