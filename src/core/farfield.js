import * as THREE from 'three';
import { facadePlan } from '../world/facadePlan.js';
import { U } from './uniforms.js';
import { TRACK_ZONE_HALF, EDGE_BAND_W, CHUNK_LEN, VIEW_FAR } from './config.js';

// Far field: the city beyond the streamed range, from VIEW_AHEAD to VIEW_FAR ahead of the
// camera (lod 2 chunks, which only builders listing 2 in `lods` are asked to build). On a
// long straight the street, the frontages and the tree lines run on to the vanishing point
// instead of ending in sky. Everything comes from the master plan, so the far field is the
// same city the modules build when it comes within VIEW_AHEAD: each lot is a block of its
// plan's height with its stone tint (or its colour wash over a stone shop floor, for a
// rendered block: plan.style.finish), its cornice, balconies and openings (dark glass, lit
// at dusk), tile roofs, penthouses and set-back additions (their balconies; a tower's side
// windows and its painted mural as a flat muted panel); the paving runs between the facade
// lines, with the light corridor edge bands and the side-street mouths; trees are
// irregular crowns on trunks. Beyond the sun's shadow maps (700 m) it shades itself as a
// street canyon (FRAG_CANYON). One merged mesh and one material per chunk; build ≈ 1 ms.
// Party-wall adverts and murals are left out (buildings decides them from what each wall
// exposes, and beyond VIEW_AHEAD they are a few hazy pixels).

// mean linear albedo of the baked limestone; init() reads it from the materials library
// (materials.meta['stone.ashlar'].albedo) so the far facades stay the colour of the near ones
let STONE = [0.6, 0.47, 0.27];
const CREAM = [0.86, 0.80, 0.68];         // facadePlan tint the stone texture corresponds to (tint 1)
const PLASTER = [0.66, 0.62, 0.54];       // mean albedo of the plaster texture (render washes multiply it)
const MURAL = [0.55, 0.5, 0.42];          // a painted mural's average colour, muted
const GLASS = [0.03, 0.034, 0.038];
const DOOR = [0.07, 0.045, 0.03];
const SHUTTER = { darkgreen: [0.03, 0.07, 0.04], brown: [0.12, 0.06, 0.03], grey: [0.2, 0.2, 0.19], teal: [0.03, 0.09, 0.09], white: [0.55, 0.55, 0.52] };
const ROOF_FLAT = [0.3, 0.29, 0.27];
const ROLLER = [0.42, 0.41, 0.38];       // a roller shutter let down most of the way
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

// Build buffers, shared by every build (builds run one at a time) and grown as needed, so a
// far chunk only allocates its final, exactly sized attribute arrays.
let BP = new Float32Array(3 << 14), BN = new Float32Array(3 << 14), BC = new Float32Array(3 << 14), BG = new Float32Array(1 << 14);
let BI = new Uint32Array(6 << 14);

/** Indexed triangle soup with position, normal, colour and a night-glow weight. */
class Geo {
  constructor() { this.nv = 0; this.ni = 0; }
  _room(v, i) {
    if ((this.nv + v) * 3 > BP.length) {
      const grow = (a, k) => { const b = new Float32Array(Math.max(a.length * 2, (this.nv + v) * k * 2)); b.set(a.subarray(0, this.nv * k)); return b; };
      BP = grow(BP, 3); BN = grow(BN, 3); BC = grow(BC, 3); BG = grow(BG, 1);
    }
    if (this.ni + i > BI.length) { const b = new Uint32Array(Math.max(BI.length * 2, (this.ni + i) * 2)); b.set(BI.subarray(0, this.ni)); BI = b; }
  }
  /** Raw vertex (numbers); returns its index. */
  v(x, y, z, nx, ny, nz, r, g, b, glow) {
    if (this.nv * 3 + 3 > BP.length) this._room(1, 0);
    const k = this.nv * 3;
    BP[k] = x; BP[k + 1] = y; BP[k + 2] = z;
    BN[k] = nx; BN[k + 1] = ny; BN[k + 2] = nz;
    BC[k] = r; BC[k + 1] = g; BC[k + 2] = b;
    BG[this.nv] = glow;
    return this.nv++;
  }
  vert(v, n, c, g) { return this.v(v.x, v.y, v.z, n.x, n.y, n.z, c[0], c[1], c[2], g); }
  idx(a) { if (this.ni + 1 > BI.length) this._room(0, 1); BI[this.ni++] = a; }
  /** Quad a-b-c-d counter-clockwise seen from the side the normal points to. */
  quad(a, b, c, d, n, col, glow = 0) {
    this._room(4, 6);
    const i = this.vert(a, n, col, glow); this.vert(b, n, col, glow); this.vert(c, n, col, glow); this.vert(d, n, col, glow);
    BI[this.ni++] = i; BI[this.ni++] = i + 1; BI[this.ni++] = i + 2; BI[this.ni++] = i; BI[this.ni++] = i + 2; BI[this.ni++] = i + 3;
  }
  /** Triangle with per-vertex normals (na, nb, nc). */
  tri(a, b, c, na, nb, nc, col, glow = 0) {
    this._room(3, 3);
    const i = this.vert(a, na, col, glow); this.vert(b, nb, col, glow); this.vert(c, nc, col, glow);
    BI[this.ni++] = i; BI[this.ni++] = i + 1; BI[this.ni++] = i + 2;
  }
  geometry() {
    if (!this.ni) return null;
    const n = this.nv;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(BP.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(BN.slice(0, n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(BC.slice(0, n * 3), 3));
    g.setAttribute('aGlow', new THREE.BufferAttribute(BG.slice(0, n), 1));
    const ia = n > 65535 ? new Uint32Array(this.ni) : new Uint16Array(this.ni);
    ia.set(BI.subarray(0, this.ni));
    g.setIndex(new THREE.BufferAttribute(ia, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Facade frame helper: P(u, v, w) → world (frame.matrix basis, v from floorRef). */
function framePoint(f, u, v, w, out) {
  return out.copy(f.origin).addScaledVector(f.uDir, u).addScaledVector(f.up, v).addScaledVector(f.nDir, w);
}

const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/** Absolute stone albedo of a stone tint (relative to the cream the texture carries, as
 *  buildings' stoneStyle takes it). */
function stoneOf(t) {
  return [0, 1, 2].map((i) => STONE[i] * Math.pow(t[i] / CREAM[i], 1.25));
}

/** Wall colours of a plan: {wall, lo, split}: `lo` below v = split (a rendered block's
 *  stone shop floor), `wall` above it (its colour wash; else the stone, split = −∞). */
function wallsOf(plan) {
  const st = plan.style;
  if (st.finish === 'render' && st.render) {
    const c = st.render.color;
    return { wall: [PLASTER[0] * c[0], PLASTER[1] * c[1], PLASTER[2] * c[2]], lo: stoneOf(st.stone || st.tint), split: st.render.from };
  }
  const w = stoneOf(st.tint);
  return { wall: w, lo: w, split: -Infinity };
}

/**
 * Facade face from u0..u1 between v = vBot(u) (ground, linear in u) and vTop, with its
 * openings let in as separate quads (no coplanar overlap: the wall is cut around them, so
 * nothing z-fights at a kilometre). Openings are grouped per floor into horizontal bands.
 */
function facadeFace(G, f, width, vBot0, vBot1, vTop, openings, wall, skipBand = null, shutterCol = SHUTTER.darkgreen, lo = null, split = -Infinity) {
  const n = _n.copy(f.nDir);
  const bot = (u) => vBot0 + (vBot1 - vBot0) * (u / width);
  const quad = (u0, v0, u1, v1, col, glow) => {
    G.quad(framePoint(f, u0, v0, 0, _a), framePoint(f, u1, v0, 0, _b), framePoint(f, u1, v1, 0, _c), framePoint(f, u0, v1, 0, _d), n, col, glow);
  };
  // wall pieces take the lower colour below `split` (a rendered block's stone shop floor)
  const Q = (u0, v0, u1, v1, col, glow = 0) => {
    if (u1 - u0 < 1e-3 || v1 - v0 < 1e-3) return;
    if (col === wall && lo && v0 < split) {
      if (v1 <= split) { quad(u0, v0, u1, v1, lo, glow); return; }
      quad(u0, v0, u1, split, lo, glow);
      v0 = split;
    }
    quad(u0, v0, u1, v1, col, glow);
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
        G.quad(framePoint(f, u0, b0, 0, _a), framePoint(f, u1, b1, 0, _b), framePoint(f, u1, v, 0, _c), framePoint(f, u0, v, 0, _d), n, lo && v <= split ? lo : wall);
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
      Q(ou0, oy0, ou1, oy1, ...openingLook(o, shutterCol, lo && o.y < split ? lo : wall));
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
  if (o.kind === 'mural') return [MURAL, 0];
  if (o.kind === 'shop') return [mul(wall, 0.2), 0.15 + 0.15 * (o.lit ?? 0.5)];
  if (o.shutters === 'roller' && (o.roller ?? 0) > 0.6) return [mul(ROLLER, 1), 0];
  if (o.kind === 'door') return [DOOR, 0];
  if (o.shutters === 'closed') return [shutterCol, 0];
  const lit = (o.lit ?? 0) > 0.86 ? 0.3 + 0.3 * o.lit : 0;   // about one window in seven
  return [GLASS, lit];
}

/** Box sides (end walls) and top of a block behind a facade, depth `depth` into the lot
 *  (ends = false: the roof alone, the sides are drawn as faces of their own). */
function blockShell(G, f, width, depth, vBot0, vBot1, vTop, wall, roofCol, ends = true) {
  if (!ends) {
    G.quad(framePoint(f, 0, vTop, 0, _a), framePoint(f, width, vTop, 0, _b), framePoint(f, width, vTop, -depth, _c), framePoint(f, 0, vTop, -depth, _d), f.up, roofCol);
    return;
  }
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
  const rail = b.railing === 'stone' || b.solid ? mul(wall, 0.85) : mul(wall, 0.42);
  G.quad(framePoint(f, b.u0, y - b.slabT, w, _a), framePoint(f, b.u1, y - b.slabT, w, _b), framePoint(f, b.u1, y, w, _c), framePoint(f, b.u0, y, w, _d), f.nDir, mul(wall, 0.95));
  G.quad(framePoint(f, b.u0, y, w, _a), framePoint(f, b.u1, y, w, _b), framePoint(f, b.u1, y + 1.0, w, _c), framePoint(f, b.u0, y + 1.0, w, _d), f.nDir, rail);
  const down = _n.copy(f.up).negate();
  G.quad(framePoint(f, b.u0, y - b.slabT, 0, _a), framePoint(f, b.u1, y - b.slabT, 0, _b), framePoint(f, b.u1, y - b.slabT, w, _c), framePoint(f, b.u0, y - b.slabT, w, _d), down, mul(wall, 0.5));
}

function lotBlock(G, lot, full) {
  const plan = facadePlan(lot);
  const f = lot.frame, W = plan.width, depth = Math.max(8, plan.depth || lot.depth || 14);
  const { wall, lo, split } = wallsOf(plan);
  const g0 = plan.groundAt(0) - 0.6, g1 = plan.groundAt(W) - 0.6;
  const top = plan.totalHeight;
  const c = plan.cornice;
  const shutterCol = SHUTTER[plan.style.shutterColor] || SHUTTER.darkgreen;
  if (full) {
    facadeFace(G, f, W, g0, g1, top, plan.openings, wall, [c.y, c.y + c.h], shutterCol, lo, split);
    cornice(G, f, W, c, lo);   // (the cornice stays stone on a rendered block)
    for (const b of plan.balconies) balcony(G, f, b, lo);
  } else {
    facadeFace(G, f, W, g0, g1, top, [], wall, null, shutterCol, lo, split);
  }
  blockShell(G, f, W, depth, g0, g1, top, wall, ROOF_FLAT);
  if (plan.roof && plan.roof.type === 'tile') tileRoof(G, f, W, depth, top, plan.roof.pitch || 26);
  const up = plan.upper;
  if (up && full) upperBlock(G, up, up.material === 'plaster' ? [PLASTER[0] * up.color[0] / 0.9, PLASTER[1] * up.color[1] / 0.9, PLASTER[2] * up.color[2] / 0.9] : lo, shutterCol);
}

const _sf = { origin: new THREE.Vector3(), uDir: new THREE.Vector3(), nDir: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };

/** The set-back volume (plan.upper): front with its openings and balconies, roof, and the
 *  sides: plain, or (an addition or a tower: up.sides) with their windows, and on a
 *  tower the painted mural (up.mural) as a flat panel of its average colour. */
function upperBlock(G, up, col, shutterCol) {
  const uf = up.frame, W = up.width, D = up.depth, h = up.v0 + up.floors * up.floorH + 0.5;
  facadeFace(G, uf, W, up.v0, up.v0, h, up.openings, col, null, shutterCol);
  for (const b of up.balconies || []) balcony(G, uf, b, col);
  if (!up.sides) { blockShell(G, uf, W, D, up.v0, up.v0, h, col, ROOF_FLAT); return; }
  blockShell(G, uf, W, D, up.v0, up.v0, h, col, ROOF_FLAT, false);
  const sideCol = mul(col, 0.97);
  for (let e = 0; e < 2; e++) {
    // the side's own frame (as buildings' sideFrame): u from the back to the front on the
    // u = 0 side, from the front to the back on the u = width side; normal outwards
    if (e === 0) {
      _sf.origin.copy(uf.origin).addScaledVector(uf.nDir, -D);
      _sf.uDir.copy(uf.nDir); _sf.nDir.copy(uf.uDir).negate();
    } else {
      _sf.origin.copy(uf.origin).addScaledVector(uf.uDir, W);
      _sf.uDir.copy(uf.nDir).negate(); _sf.nDir.copy(uf.uDir);
    }
    const ops = up.sides[e] || [], m = up.mural && up.mural.e === e ? up.mural : null;
    const list = m ? [...ops, { kind: 'mural', floor: -1, uc: (m.u0 + m.u1) / 2, w: m.u1 - m.u0, y: m.v0, h: m.v1 - m.v0 }] : ops;
    facadeFace(G, _sf, D, up.v0, up.v0, h, list, sideCol, null, shutterCol);
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
    G._room(tpl.n, tpl.index.length);
    const i0 = G.nv;
    for (let i = 0; i < tpl.n; i++) {
      const x = tpl.P[i * 3], y = tpl.P[i * 3 + 1], z = tpl.P[i * 3 + 2];
      const nx = tpl.N[i * 3], ny = tpl.N[i * 3 + 1], nz = tpl.N[i * 3 + 2];
      const sh = val * tpl.S[i];
      // (glow −1: foliage, mottled in the shader)
      G.v(ox + (a * x + b * z) * rr, oy + y * hh, oz + (c * x + d * z) * rr, a * nx + b * nz, ny, c * nx + d * nz,
        LEAF[0] * sh * (1 + hue), LEAF[1] * sh, LEAF[2] * sh * (1 - hue), -1);
    }
    for (let j = 0; j < tpl.index.length; j++) G.idx(i0 + tpl.index[j]);
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

// ---- canyon cross-section per vertex (see FRAG_CANYON)
const CY_MARGIN = 30;                 // m of table beyond the chunk ends (lots reach past them)
const _cc = new THREE.Vector3();

/** Facade line and block height on both sides at 1 m steps over the chunk (± CY_MARGIN):
 *  from the lots of this chunk and its neighbours; the layout's facade line and no block
 *  where there is no lot (a side-street mouth lets the sun through). */
function canyonTable(app, chunk) {
  const { route, layout } = app;
  const sA = chunk.s0 - CY_MARGIN, n = Math.ceil(chunk.s1 - chunk.s0 + 2 * CY_MARGIN) + 1;
  const T = { sA, n, hw: [new Float32Array(n), new Float32Array(n)], H: [new Float32Array(n), new Float32Array(n)],
    x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), tx: new Float64Array(n), tz: new Float64Array(n) };
  for (let k = 0; k < n; k++) {
    route.toWorld(sA + k, 0, 0, _cc);
    const th = route.heading(sA + k);
    T.x[k] = _cc.x; T.y[k] = _cc.y; T.z[k] = _cc.z; T.tx[k] = Math.cos(th); T.tz[k] = -Math.sin(th);
  }
  for (let e = 0; e < 2; e++) for (let k = 0; k < n; k++) T.hw[e][k] = layout.halfWidth(sA + k, e ? 1 : -1);
  for (let j = -1; j <= 1; j++) {
    for (const lot of layout.inChunk('lots', chunk.index + j)) {
      const e = lot.side > 0 ? 1 : 0, top = lot.frame.floorRef + facadePlan(lot).totalHeight;
      const k0 = Math.max(0, Math.ceil(route.delta(sA, lot.s0))), k1 = Math.min(n - 1, Math.floor(route.delta(sA, lot.s0) + lot.len));
      for (let k = k0; k <= k1; k++) { T.hw[e][k] = lot.d; T.H[e][k] = top - T.y[k]; }
    }
  }
  return T;
}

/** aCy = (d, h, right.x, right.z) and aCw = (facade |d| left, right, block height left,
 *  right) per vertex: each vertex is put on the route by two Newton steps along the
 *  tangent from the chunk's middle, on the table's centre line (1 m samples). */
function canyonAttributes(geo, app, chunk) {
  const pos = geo.getAttribute('position').array, nv = pos.length / 3;
  const cy = new Float32Array(nv * 4), cw = new Float32Array(nv * 4);
  const T = canyonTable(app, chunk), n = T.n;
  const uMid = (chunk.s0 + chunk.s1) / 2 - T.sA;
  for (let i = 0; i < nv; i++) {
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    let u = uMid, cx = 0, cyy = 0, cz = 0, tx = 1, tz = 0;
    for (let it = 0; it < 3; it++) {
      const k0 = Math.max(0, Math.min(n - 2, Math.floor(u))), f = Math.max(0, Math.min(1, u - k0)), g = 1 - f;
      cx = T.x[k0] * g + T.x[k0 + 1] * f; cyy = T.y[k0] * g + T.y[k0 + 1] * f; cz = T.z[k0] * g + T.z[k0 + 1] * f;
      tx = T.tx[k0] * g + T.tx[k0 + 1] * f; tz = T.tz[k0] * g + T.tz[k0 + 1] * f;
      const l = Math.sqrt(tx * tx + tz * tz); tx /= l; tz /= l;
      if (it < 2) u += (px - cx) * tx + (pz - cz) * tz;
    }
    const rx = -tz, rz = tx;   // right = (−Tz, 0, Tx)
    const k = Math.max(0, Math.min(n - 1, Math.round(u)));
    cy[i * 4] = (px - cx) * rx + (pz - cz) * rz; cy[i * 4 + 1] = py - cyy; cy[i * 4 + 2] = rx; cy[i * 4 + 3] = rz;
    cw[i * 4] = T.hw[0][k]; cw[i * 4 + 1] = T.hw[1][k]; cw[i * 4 + 2] = T.H[0][k]; cw[i * 4 + 3] = T.H[1][k];
  }
  geo.setAttribute('aCy', new THREE.BufferAttribute(cy, 4));
  geo.setAttribute('aCw', new THREE.BufferAttribute(cw, 4));
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

// Canyon shade: the sun's shadow maps end at 700 m, so beyond them the street is shaded as a
// street canyon in cross-section. vCy = (d: lateral offset from the centre line, h: height
// over the centre-line paving, right.x, right.z), vCw = (facade line |d| left and right,
// block height left and right over the paving at the fragment's s; 0 in a side-street
// mouth). The ray towards the sun reaches the facade line on the sun's side and is shaded
// when it passes below that block's top. On or behind that facade line: no canyon shade.
const FRAG_CANYON = /* glsl */ `
float ffCanyon() {
  vec3 L = ffSun;
  if (L.y <= 0.0) return 1.0;
  float a = dot(L.xz, vCy.zw);
  bool right = a > 0.0;
  float dist = right ? vCw.y - vCy.x : vCw.x + vCy.x;
  float H = right ? vCw.w : vCw.z;
  if (dist < 0.3 || H <= 0.0) return 1.0;
  float hit = vCy.y + dist * L.y / max(abs(a), 1e-4);
  return smoothstep(H - 1.2, H + 1.2, hit);
}
`;

const farfield = {
  name: 'farfield',
  lods: [2],

  init(app) {
    this.app = app;
    const meta = app.materials && app.materials.meta && app.materials.meta['stone.ashlar'];
    if (meta && Array.isArray(meta.albedo) && meta.albedo.length === 3) STONE = meta.albedo.slice();
    const gain = (app.materials.uniforms && app.materials.uniforms.emissiveGain) || { value: 1 };
    const m = new THREE.MeshStandardMaterial({ name: 'farfield', vertexColors: true, roughness: 0.92, metalness: 0 });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.ffNight = U.uNight;
      shader.uniforms.ffGain = gain;
      shader.uniforms.ffSun = U.uSunDir;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute vec4 aCy;\nattribute vec4 aCw;\nvarying float vGlow;\nvarying vec3 vFfPos;\nvarying vec4 vCy;\nvarying vec4 vCw;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvCy = aCy;\nvCw = aCw;\nvFfPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      // the sun light alone takes the canyon shade (the shared light loop, as env patched
      // it, with one line added after the sun's light info)
      const sunInfo = 'getSunLightInfo( sunLight, directLight );';
      const loop = THREE.ShaderChunk.lights_fragment_begin;
      const lights = loop.split(sunInfo).length === 2 ? loop.replace(sunInfo, `${sunInfo}\n\t\tdirectLight.color *= ffCanyon();`) : null;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float ffNight;\nuniform float ffGain;\nuniform vec3 ffSun;\nvarying float vGlow;\nvarying vec3 vFfPos;\nvarying vec4 vCy;\nvarying vec4 vCw;\n' + FRAG_NOISE + FRAG_CANYON)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_FOLIAGE)
        .replace('#include <lights_physical_fragment>', 'totalEmissiveRadiance += vec3(1.0, 0.66, 0.38) * 0.005 * ffGain * max(vGlow, 0.0) * smoothstep(0.25, 0.75, ffNight);\n#include <lights_physical_fragment>');
      if (lights) shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', lights);
    };
    m.customProgramCacheKey = () => 'farfield3';
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
    if (geo) canyonAttributes(geo, app, chunk);
    const dt = performance.now() - t0;
    this.stats.builds++; this.stats.ms = dt; this.stats.maxMs = Math.max(this.stats.maxMs, dt);
    if (!geo) return null;
    this.stats.tris = geo.index.count / 3;
    this.stats.bytes = (G.nv * 18 * 4) + geo.index.array.byteLength;
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
    // (once the window is planned, wait for it to move on rather than walking it again)
    if (this._cur === undefined || this._cur < iA - 2 || this._cur > iB + 1) { this._cur = iA; this._lot = 0; }
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
