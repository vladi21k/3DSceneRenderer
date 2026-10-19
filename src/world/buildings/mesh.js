import { ShapeUtils, Vector2 } from 'three';
import { runAttr } from './shade.js';
import { archSegments } from '../facadePlan.js';

// Low-level mesh emitter for the building shells.
//
// Geometry is written straight into growable typed arrays, one Sink per material,
// with positions already in world space: the Builder keeps a "frame" (a facade
// frame, or a rotated sub-frame for rooftop equipment) and every primitive takes
// facade-local (u, v, w) coordinates in metres:
//   u along the wall (to the viewer's right), v up, w out of the wall.
// Frames only ever rotate about the vertical axis, so v maps straight to world Y.
//
// Each vertex gets a colour from the Builder's current shade callback (stone tint,
// baked ambient occlusion, weathering), a UV in metres, optionally remapped by the
// current UV transform (used to line ashlar courses up with the floors), and the
// run-off occluder above it (Builder.run, see shade.runAttr).
//
// Vertex format (36 bytes; the GPU upload of a chunk is what costs, see buildings.js):
//   p  position   float32 × 3, world space
//   n  normal     snorm8 × 4; w: height above the paving in front (HG_MAX = none or out
//                 of reach, out[5] of the shade callback), affine over a face, so it
//                 interpolates exactly; the stone materials read it as aNrmW.w (grime.js)
//   t  uv         float32 × 2, metres
//   c  colour     unorm8 × 4: rgb = sqrt(colour / COLOR_SCALE) (dark paints keep their
//                 precision), a = grime (or lit share) / COLOR_SCALE; decoded per vertex by
//                 the buildings materials (grime.js)
//   r  run-off    int16 × 4 (see shade.runAttr)
//   i  index      uint16 when the batch has fewer than 65536 vertices, else uint32

const F_FRONT = 1, F_BACK = 2, F_LEFT = 4, F_RIGHT = 8, F_TOP = 16, F_BOTTOM = 32;
export const FACES = { FRONT: F_FRONT, BACK: F_BACK, LEFT: F_LEFT, RIGHT: F_RIGHT, TOP: F_TOP, BOTTOM: F_BOTTOM, ALL: 63, SIDES: F_LEFT | F_RIGHT | F_TOP | F_BOTTOM };

// Recent batch sizes per sink key, so fresh buffers rarely need to grow (each batch's
// arrays are handed over to the GPU geometry as they are, see Sink.detach).
const HINT = new Map();
let _pj = new Float64Array(256);   // smoothed profile joint normals of a sweep (reused; NaN: sharp)

/** Height above the paving (normal.w, snorm8): metres up to HG_MAX, in steps of HG_MAX / 127. */
export const HG_MAX = 3;
const HG_Q = 127 / HG_MAX;
/** Colours and grime are stored relative to COLOR_SCALE in unorm8 (0..2 representable). */
export const COLOR_SCALE = 2;
/**
 * Glass batches (buildings' own glazing): the vertex colour is the albedo of what shows
 * behind the pane (curtain, blind, dark room) divided by GLASS_K (see grime.litGlass).
 */
export const GLASS_K = 0.32;
/** Vertex colour for the glass sink showing `albedo` behind the pane. */
export const glassTone = (albedo) => albedo.map((c) => Math.min(COLOR_SCALE, c / GLASS_K));
const C8 = 255 / COLOR_SCALE, CS = 1 / COLOR_SCALE;

function alloc(v, i) {
  return {
    p: new Float32Array(v * 3), n: new Int8Array(v * 4), t: new Float32Array(v * 2),
    c: new Uint8ClampedArray(v * 4), r: new Int16Array(v * 4), i: new Uint32Array(i),
  };
}

export class Sink {
  constructor(key) {
    this.key = key;
    this.vc = 0; this.ic = 0;
    this.p = null;
    this.uvx = null; // optional per-sink UV transform overriding the builder's
    this.rewind();
  }
  reserve(nv, ni) {
    if ((this.vc + nv) * 3 > this.p.length) {
      const cap = Math.max((this.vc + nv) * 2, 4096), vc = this.vc;
      const b = alloc(cap, 0);
      b.p.set(this.p.subarray(0, vc * 3)); b.n.set(this.n.subarray(0, vc * 4)); b.t.set(this.t.subarray(0, vc * 2));
      b.c.set(this.c.subarray(0, vc * 4)); b.r.set(this.r.subarray(0, vc * 4));
      this.p = b.p; this.n = b.n; this.t = b.t; this.c = b.c; this.r = b.r;
    }
    if (this.ic + ni > this.i.length) {
      const b = new Uint32Array(Math.max((this.ic + ni) * 2, 8192));
      b.set(this.i.subarray(0, this.ic));
      this.i = b;
    }
  }
  /**
   * The used part as views (no copy, except the index, narrowed to uint16 when it fits).
   * The sink then lets go of its buffers, so the next batch writes into fresh arrays
   * sized from this one, and the views stay valid.
   */
  detach() {
    const vc = this.vc, ic = this.ic;
    const idx = this.i.subarray(0, ic);
    const out = {
      key: this.key, vc, ic,
      p: this.p.subarray(0, vc * 3), n: this.n.subarray(0, vc * 4), t: this.t.subarray(0, vc * 2), c: this.c.subarray(0, vc * 4),
      r: this.r.subarray(0, vc * 4), i: vc <= 65536 ? new Uint16Array(idx) : idx,
    };
    const h = HINT.get(this.key) || [0, 0];
    HINT.set(this.key, [Math.max(vc, h[0] * 0.9), Math.max(ic, h[1] * 0.9)]);
    this.p = this.n = this.t = this.c = this.r = this.i = null;
    this.vc = 0; this.ic = 0;
    return out;
  }
  /** Rewind for a new batch; allocates fresh buffers when the previous ones were detached. */
  rewind() {
    this.vc = 0; this.ic = 0;
    if (this.p) return;
    const h = HINT.get(this.key) || [0, 0];
    const b = alloc(Math.max(1024, Math.ceil(h[0] * 1.15)), Math.max(3072, Math.ceil(h[1] * 1.15)));
    this.p = b.p; this.n = b.n; this.t = b.t; this.c = b.c; this.r = b.r; this.i = b.i;
  }
  /** Axis-aligned bounds of the used vertices, merged into box {min, max} (Vector3-like). */
  bounds(box) {
    const a = this.p, n = this.vc * 3;
    let x0 = box.min.x, y0 = box.min.y, z0 = box.min.z, x1 = box.max.x, y1 = box.max.y, z1 = box.max.z;
    for (let i = 0; i < n; i += 3) {
      const x = a[i], y = a[i + 1], z = a[i + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    box.min.set(x0, y0, z0); box.max.set(x1, y1, z1);
    return box;
  }
}

const capCache = new WeakMap();

export class Builder {
  constructor() {
    this.sinks = new Map();
    this.frames = [];
    this.setFrame(0, 0, 0, 1, 0, 0, 1);
    this.uv = [1, 0, 1, 0];          // tu = u*su + ou, tv = v*sv + ov
    this.shade = null;               // (u, v, w, nu, nv, nw, out[6]) -> void (out[5]: height above the paving)
    this.run = null;                 // run-off occluder above what is emitted (FaceShade.occ item)
    this.col = [1, 1, 1, 0, 1, HG_MAX];
    this.flat = [1, 1, 1];           // colour used when shade is null
    this.grime = 0;                  // per-vertex grime mask (shade callbacks may write out[3])
  }

  /** Start a new batch: sinks are pooled and only rewound, so their buffers are reused. */
  reset() {
    for (const s of this.sinks.values()) s.rewind();
    this.begin();
  }
  /** Start a new object inside the current batch (keeps what the sinks already hold). */
  begin() {
    for (const s of this.sinks.values()) s.uvx = null;
    let t = 0;
    for (const s of this.sinks.values()) t += s.ic;
    this._lastMark = t;
    this._lastT = this.profile ? performance.now() : 0;
    this.frames.length = 0; this.uv = [1, 0, 1, 0]; this.shade = null; this.run = null; this.flat = [1, 1, 1]; this.grime = 0;
  }

  sink(key) {
    let s = this.sinks.get(key);
    if (!s) { s = new Sink(key); this.sinks.set(key, s); }
    else if (!s.p) s.rewind();
    return s;
  }

  /** Frame: origin (ox, oy, oz), horizontal u axis (ux, uz), w axis (nx, nz). */
  setFrame(ox, oy, oz, ux, uz, nx, nz) {
    this.ox = ox; this.oy = oy; this.oz = oz; this.ux = ux; this.uz = uz; this.nx = nx; this.nz = nz;
  }
  frameFromLot(f) {
    this.setFrame(f.origin.x, f.origin.y, f.origin.z, f.uDir.x, f.uDir.z, f.nDir.x, f.nDir.z);
  }
  pushFrame() { this.frames.push([this.ox, this.oy, this.oz, this.ux, this.uz, this.nx, this.nz]); }
  popFrame() { const f = this.frames.pop(); this.setFrame(...f); }
  /** Sub-frame at local (u, v, w) rotated by yaw (radians, about +v, from +u towards -w). */
  enter(u, v, w, yaw = 0) {
    this.pushFrame();
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ox = this.ox + this.ux * u + this.nx * w, oz = this.oz + this.uz * u + this.nz * w;
    // rotate the basis: u' = c*u - s*w, w' = s*u + c*w (keeps right-handedness)
    const ux = c * this.ux - s * this.nx, uz = c * this.uz - s * this.nz;
    const nx = s * this.ux + c * this.nx, nz = s * this.uz + c * this.nz;
    this.setFrame(ox, this.oy + v, oz, ux, uz, nx, nz);
  }

  /** World position of a local point (for neighbour tests etc). */
  toWorld(u, v, w, out) {
    out.x = this.ox + this.ux * u + this.nx * w; out.y = this.oy + v; out.z = this.oz + this.uz * u + this.nz * w;
    return out;
  }

  setUV(su = 1, ou = 0, sv = 1, ov = 0) { this.uv[0] = su; this.uv[1] = ou; this.uv[2] = sv; this.uv[3] = ov; }

  // ------------------------------------------------------------------ vertices
  /** Emit one vertex; returns its index. tu/tv in metres before the UV transform. */
  v(s, u, v, w, nu, nv, nw, tu, tv) {
    const k = s.vc++;
    const p = s.p, n = s.n, t = s.t, c = s.c, i3 = k * 3, i4 = k * 4;
    p[i3] = this.ox + this.ux * u + this.nx * w;
    p[i3 + 1] = this.oy + v;
    p[i3 + 2] = this.oz + this.uz * u + this.nz * w;
    const nx = this.ux * nu + this.nx * nw, nz = this.uz * nu + this.nz * nw;
    const l2 = nx * nx + nv * nv + nz * nz;
    const q = l2 > 0.9998 && l2 < 1.0002 ? 127 : 127 / Math.sqrt(l2 || 1);
    n[i4] = Math.round(nx * q); n[i4 + 1] = Math.round(nv * q); n[i4 + 2] = Math.round(nz * q);
    const uv = s.uvx || this.uv;
    t[k * 2] = tu * uv[0] + uv[1];
    t[k * 2 + 1] = tv * uv[2] + uv[3];
    let col = this.flat, gr = this.grime, hg = HG_MAX;
    if (this.shade) { col = this.col; col[3] = gr; col[4] = 1; col[5] = HG_MAX; this.shade(u, v, w, nu, nv, nw, col); gr = col[3]; hg = col[5]; }
    c[i4] = 255 * Math.sqrt(col[0] * CS); c[i4 + 1] = 255 * Math.sqrt(col[1] * CS); c[i4 + 2] = 255 * Math.sqrt(col[2] * CS);
    c[i4 + 3] = gr * C8;
    n[i4 + 3] = Math.round((hg < -0.4 ? -0.4 : hg > HG_MAX ? HG_MAX : hg) * HG_Q);
    runAttr(this.run, u, v, this.shade ? col[4] : 1, s.r, i4);
    return k;
  }
  tri(s, a, b, c) { const i = s.i, k = s.ic; i[k] = a; i[k + 1] = b; i[k + 2] = c; s.ic += 3; }
  quadIdx(s, a, b, c, d) { const i = s.i, k = s.ic; i[k] = a; i[k + 1] = b; i[k + 2] = c; i[k + 3] = a; i[k + 4] = c; i[k + 5] = d; s.ic += 6; }

  // ------------------------------------------------------------------ axis-aligned rectangles
  /** Face perpendicular to w (dir +1 faces out of the wall, -1 faces in). UV = (u, v). */
  rectW(s, u0, u1, v0, v1, w, dir = 1) {
    if (u1 < u0) { const x = u0; u0 = u1; u1 = x; }
    if (v1 < v0) { const x = v0; v0 = v1; v1 = x; }
    s.reserve(4, 6);
    const a = this.v(s, u0, v0, w, 0, 0, dir, dir > 0 ? u0 : -u0, v0);
    const b = this.v(s, u1, v0, w, 0, 0, dir, dir > 0 ? u1 : -u1, v0);
    const c = this.v(s, u1, v1, w, 0, 0, dir, dir > 0 ? u1 : -u1, v1);
    const d = this.v(s, u0, v1, w, 0, 0, dir, dir > 0 ? u0 : -u0, v1);
    if (dir > 0) this.quadIdx(s, a, b, c, d); else this.quadIdx(s, a, d, c, b);
  }
  /** Face perpendicular to u at u (dir +1 faces +u). UV = (∓w, v). */
  rectU(s, u, v0, v1, w0, w1, dir = 1) {
    if (w1 < w0) { const x = w0; w0 = w1; w1 = x; }
    if (v1 < v0) { const x = v0; v0 = v1; v1 = x; }
    s.reserve(4, 6);
    const a = this.v(s, u, v0, w0, dir, 0, 0, -dir * w0, v0);
    const b = this.v(s, u, v1, w0, dir, 0, 0, -dir * w0, v1);
    const c = this.v(s, u, v1, w1, dir, 0, 0, -dir * w1, v1);
    const d = this.v(s, u, v0, w1, dir, 0, 0, -dir * w1, v0);
    if (dir > 0) this.quadIdx(s, a, b, c, d); else this.quadIdx(s, a, d, c, b);
  }
  /** Face perpendicular to v at v (dir +1 faces up). UV = (u, w). */
  rectV(s, u0, u1, w0, w1, v, dir = 1) {
    if (u1 < u0) { const x = u0; u0 = u1; u1 = x; }
    if (w1 < w0) { const x = w0; w0 = w1; w1 = x; }
    s.reserve(4, 6);
    const a = this.v(s, u0, v, w0, 0, dir, 0, u0, w0);
    const b = this.v(s, u0, v, w1, 0, dir, 0, u0, w1);
    const c = this.v(s, u1, v, w1, 0, dir, 0, u1, w1);
    const d = this.v(s, u1, v, w0, 0, dir, 0, u1, w0);
    if (dir > 0) this.quadIdx(s, a, b, c, d); else this.quadIdx(s, a, d, c, b);
  }

  /**
   * Vertical wall quad from (u0, w0) to (u1, w1), v0..v1, facing the right of the direction
   * of travel seen from above (as sweep paths: travelling +u faces +w). UV = (along, v).
   */
  vwall(s, u0, w0, u1, w1, v0, v1) {
    const du = u1 - u0, dw = w1 - w0, l = Math.hypot(du, dw);
    if (l < 1e-4) return;
    const nu = -dw / l, nw = du / l;
    s.reserve(4, 6);
    const a = this.v(s, u0, v0, w0, nu, 0, nw, 0, v0), b = this.v(s, u1, v0, w1, nu, 0, nw, l, v0);
    const c = this.v(s, u1, v1, w1, nu, 0, nw, l, v1), d = this.v(s, u0, v1, w0, nu, 0, nw, 0, v1);
    this.quadIdx(s, a, b, c, d);
  }
  /** Convex horizontal polygon at height v, flat [u, w, ...] clockwise in (u, w): faces up. UV = (u, w). */
  polyV(s, pts, v) {
    const m = pts.length >> 1;
    s.reserve(m, (m - 2) * 3);
    const base = s.vc;
    for (let k = 0; k < m; k++) this.v(s, pts[k * 2], v, pts[k * 2 + 1], 0, 1, 0, pts[k * 2], pts[k * 2 + 1]);
    for (let k = 1; k < m - 1; k++) this.tri(s, base, base + k, base + k + 1);
  }

  /** rectU subdivided into a grid of about `cell` metres (for vertex-colour detail). */
  gridU(s, u, v0, v1, w0, w1, dir, cell) {
    if (w1 < w0) { const x = w0; w0 = w1; w1 = x; }
    const nw = Math.max(1, Math.ceil((w1 - w0) / cell)), nv = Math.max(1, Math.ceil((v1 - v0) / cell));
    s.reserve((nw + 1) * (nv + 1), nw * nv * 6);
    const base = s.vc;
    for (let j = 0; j <= nv; j++) {
      const v = v0 + ((v1 - v0) * j) / nv;
      for (let i = 0; i <= nw; i++) { const w = w0 + ((w1 - w0) * i) / nw; this.v(s, u, v, w, dir, 0, 0, -dir * w, v); }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nw; i++) {
      const a = base + j * (nw + 1) + i, b = a + 1, c = a + nw + 2, d = a + nw + 1;
      // (a → d) is +v, (a → b) is +w: +v × +w = +u
      if (dir > 0) this.quadIdx(s, a, d, c, b); else this.quadIdx(s, a, b, c, d);
    }
  }

  /** Axis-aligned box; `faces` is a FACES bit mask. */
  box(s, u0, u1, v0, v1, w0, w1, faces = 63) {
    if (faces & F_FRONT) this.rectW(s, u0, u1, v0, v1, w1, 1);
    if (faces & F_BACK) this.rectW(s, u0, u1, v0, v1, w0, -1);
    if (faces & F_LEFT) this.rectU(s, u0, v0, v1, w0, w1, -1);
    if (faces & F_RIGHT) this.rectU(s, u1, v0, v1, w0, w1, 1);
    if (faces & F_TOP) this.rectV(s, u0, u1, w0, w1, v1, 1);
    if (faces & F_BOTTOM) this.rectV(s, u0, u1, w0, w1, v0, -1);
  }

  /**
   * Box whose front edges are chamfered by `b` (a dressed stone block). Back face omitted.
   * `hidden`: sides covered by neighbouring work, left out (their chamfers stay).
   */
  bevelBox(s, u0, u1, v0, v1, w0, w1, b, faces = 63, hidden = 0) {
    if (b <= 0.001 || u1 - u0 < 3 * b || v1 - v0 < 3 * b) { this.box(s, u0, u1, v0, v1, w0, w1, faces & ~F_BACK & ~hidden); return; }
    const wf = w1 - b;
    this.rectW(s, u0 + b, u1 - b, v0 + b, v1 - b, w1, 1);
    // chamfers (45°)
    const k = Math.SQRT1_2;
    s.reserve(16, 24);
    if (faces & F_TOP) this._quad4(s, u0 + b, v1 - b, w1, u1 - b, v1 - b, w1, u1, v1, wf, u0, v1, wf, 0, k, k);
    if (faces & F_BOTTOM) this._quad4(s, u0, v0, wf, u1, v0, wf, u1 - b, v0 + b, w1, u0 + b, v0 + b, w1, 0, -k, k);
    if (faces & F_LEFT) this._quad4(s, u0, v0, wf, u0 + b, v0 + b, w1, u0 + b, v1 - b, w1, u0, v1, wf, -k, 0, k);
    if (faces & F_RIGHT) this._quad4(s, u1 - b, v0 + b, w1, u1, v0, wf, u1, v1, wf, u1 - b, v1 - b, w1, k, 0, k);
    // corner triangles where two chamfers meet are tiny; the four chamfer quads overlap at the corners instead
    const sides = faces & ~hidden;
    if (sides & F_LEFT) this.rectU(s, u0, v0, v1, w0, wf, -1);
    if (sides & F_RIGHT) this.rectU(s, u1, v0, v1, w0, wf, 1);
    if (sides & F_TOP) this.rectV(s, u0, u1, w0, wf, v1, 1);
    if (sides & F_BOTTOM) this.rectV(s, u0, u1, w0, wf, v0, -1);
  }

  /** Quad from four local points (CCW seen from the normal side) with a flat normal. UV planar on the dominant axis. */
  _quad4(s, u0, v0, w0, u1, v1, w1, u2, v2, w2, u3, v3, w3, nu, nv, nw) {
    s.reserve(4, 6);
    const au = Math.abs(nu), av = Math.abs(nv), aw = Math.abs(nw);
    let a, b, c, d;
    if (aw >= au && aw >= av) {
      a = this.v(s, u0, v0, w0, nu, nv, nw, u0, v0); b = this.v(s, u1, v1, w1, nu, nv, nw, u1, v1);
      c = this.v(s, u2, v2, w2, nu, nv, nw, u2, v2); d = this.v(s, u3, v3, w3, nu, nv, nw, u3, v3);
    } else if (au >= av) {
      a = this.v(s, u0, v0, w0, nu, nv, nw, -w0, v0); b = this.v(s, u1, v1, w1, nu, nv, nw, -w1, v1);
      c = this.v(s, u2, v2, w2, nu, nv, nw, -w2, v2); d = this.v(s, u3, v3, w3, nu, nv, nw, -w3, v3);
    } else {
      a = this.v(s, u0, v0, w0, nu, nv, nw, u0, w0); b = this.v(s, u1, v1, w1, nu, nv, nw, u1, w1);
      c = this.v(s, u2, v2, w2, nu, nv, nw, u2, w2); d = this.v(s, u3, v3, w3, nu, nv, nw, u3, w3);
    }
    this.quadIdx(s, a, b, c, d);
  }

  /** quadAuto with the winding chosen so the face looks along the hint (nu, nv, nw). */
  quadOut(s, P0, P1, P2, P3, nu, nv, nw) {
    const ax = P1[0] - P0[0], ay = P1[1] - P0[1], az = P1[2] - P0[2];
    const bx = P3[0] - P0[0], by = P3[1] - P0[1], bz = P3[2] - P0[2];
    const cu = ay * bz - az * by, cv = az * bx - ax * bz, cw = ax * by - ay * bx;
    if (cu * nu + cv * nv + cw * nw < 0) this.quadAuto(s, P0, P3, P2, P1); else this.quadAuto(s, P0, P1, P2, P3);
  }

  /** Quad from four points with the normal computed from the geometry. */
  quadAuto(s, P0, P1, P2, P3) {
    const ax = P1[0] - P0[0], ay = P1[1] - P0[1], az = P1[2] - P0[2];
    const bx = P3[0] - P0[0], by = P3[1] - P0[1], bz = P3[2] - P0[2];
    // (P1-P0) × (P3-P0) in the right-handed (u, v, w) basis
    let nu = ay * bz - az * by, nv = az * bx - ax * bz, nw = ax * by - ay * bx;
    const l = Math.sqrt(nu * nu + nv * nv + nw * nw) || 1; nu /= l; nv /= l; nw /= l;
    this._quad4(s, P0[0], P0[1], P0[2], P1[0], P1[1], P1[2], P2[0], P2[1], P2[2], P3[0], P3[1], P3[2], nu, nv, nw);
  }

  // ------------------------------------------------------------------ prisms from 2D outlines
  /**
   * Prism from a convex (or star-shaped about pts[0]) outline in the (u, v) plane,
   * front face at w1, sides back to w0. pts: flat array [u0,v0,u1,v1,...] CCW seen from +w.
   * bevel > 0 insets the front face and adds chamfer strips.
   */
  prism(s, pts, w0, w1, bevel = 0, sides = true) {
    const m = pts.length >> 1;
    let fp = pts, wf = w1;
    if (bevel > 0) { fp = insetPolygon(pts, bevel); wf = w1 - bevel; }
    s.reserve(m * 13, m * 15);
    // front (fan)
    const base = s.vc;
    for (let k = 0; k < m; k++) this.v(s, fp[k * 2], fp[k * 2 + 1], w1, 0, 0, 1, fp[k * 2], fp[k * 2 + 1]);
    for (let k = 1; k < m - 1; k++) this.tri(s, base, base + k, base + k + 1);
    for (let k = 0; k < m; k++) {
      const j = (k + 1) % m;
      const ax = pts[k * 2], ay = pts[k * 2 + 1], bx = pts[j * 2], by = pts[j * 2 + 1];
      let eu = by - ay, ev = -(bx - ax); // outward edge normal (CCW outline)
      const l = Math.hypot(eu, ev) || 1; eu /= l; ev /= l;
      if (bevel > 0) {
        const cu = eu * Math.SQRT1_2, cv = ev * Math.SQRT1_2;
        this._quad4(s, ax, ay, wf, bx, by, wf, fp[j * 2], fp[j * 2 + 1], w1, fp[k * 2], fp[k * 2 + 1], w1, cu, cv, Math.SQRT1_2);
      }
      if (sides) this._quad4(s, ax, ay, w0, bx, by, w0, bx, by, wf, ax, ay, wf, eu, ev, 0);
    }
  }

  // ------------------------------------------------------------------ profile sweeps
  /**
   * Sweep a moulding profile along a polyline path lying in the horizontal (u, w) plane
   * at height v0. profile: [[out, up], ...] ordered bottom to top (out = distance in
   * front of the path, i.e. along the path's outward normal). path: [[u, w], ...]; the
   * outward side is to the right of the direction of travel seen from above, which for
   * a path running +u along the facade is +w. Mitred corners, flat shading per edge,
   * or with `crease` (degrees) smooth shading across the profile's joints that turn by
   * less than that (a carved curve), sharp at the rest (fillets, steps, drips).
   * caps: [startCap, endCap] booleans close the ends with the profile polygon.
   */
  sweep(s, profile, path, v0, caps = [false, false], uStart = 0, crease = 0) {
    const np = path.length, m = profile.length;
    // outward normals per path segment
    const segN = [];
    for (let k = 0; k < np - 1; k++) {
      const du = path[k + 1][0] - path[k][0], dw = path[k + 1][1] - path[k][1];
      const l = Math.hypot(du, dw) || 1;
      segN.push([-dw / l, du / l]);
    }
    // mitre vectors per path vertex
    const mit = [];
    for (let k = 0; k < np; k++) {
      const a = segN[Math.max(0, k - 1)], b = segN[Math.min(np - 2, k)];
      const sx = a[0] + b[0], sz = a[1] + b[1];
      const dot = a[0] * b[0] + a[1] * b[1];
      const f = 1 / (1 + dot);
      mit.push([sx * f, sz * f]);
    }
    // profile edge normals in (out, up)
    const pe = [];
    let acc = 0;
    const pv = [0];
    for (let j = 0; j < m - 1; j++) {
      const dout = profile[j + 1][0] - profile[j][0], dup = profile[j + 1][1] - profile[j][1];
      const l = Math.hypot(dout, dup) || 1;
      pe.push([dup / l, -dout / l]); // rotate so the normal points outwards for bottom->top order
      acc += l; pv.push(acc);
    }
    // smooth joints: the profile vertex's normal is the mean of its two edges' normals
    // (pj[2j], pj[2j + 1]: at profile vertex j, NaN where the joint stays sharp)
    if (_pj.length < m * 2) _pj = new Float64Array(m * 4);
    const pj = _pj;
    pj.fill(NaN, 0, m * 2);
    if (crease > 0) {
      const cc = Math.cos((crease * Math.PI) / 180);
      for (let j = 1; j < m - 1; j++) {
        const a = pe[j - 1], b = pe[j];
        if (a[0] * b[0] + a[1] * b[1] < cc) continue;
        const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
        pj[j * 2] = x / l; pj[j * 2 + 1] = y / l;
      }
    }
    s.reserve((np - 1) * (m - 1) * 4 + m * 2 + 8, (np - 1) * (m - 1) * 6 + m * 6);
    let tuAcc = uStart;
    for (let k = 0; k < np - 1; k++) {
      const n = segN[k], A = path[k], B = path[k + 1], ma = mit[k], mb = mit[k + 1];
      const segLen = Math.hypot(B[0] - A[0], B[1] - A[1]);
      for (let j = 0; j < m - 1; j++) {
        const p0 = profile[j], p1 = profile[j + 1];
        // normals at the bottom and the top of the edge (its own, or the smoothed joint's)
        const s0 = pj[j * 2] === pj[j * 2], s1 = pj[j * 2 + 2] === pj[j * 2 + 2];
        const ex = s0 ? pj[j * 2] : pe[j][0], ey = s0 ? pj[j * 2 + 1] : pe[j][1];
        const fx = s1 ? pj[j * 2 + 2] : pe[j][0], fy = s1 ? pj[j * 2 + 3] : pe[j][1];
        const nu = n[0] * ex, nw = n[1] * ex, nv = ey;
        const mu = n[0] * fx, mw = n[1] * fx, mv = fy;
        const a = this.v(s, A[0] + ma[0] * p0[0], v0 + p0[1], A[1] + ma[1] * p0[0], nu, nv, nw, tuAcc, pv[j]);
        const b = this.v(s, B[0] + mb[0] * p0[0], v0 + p0[1], B[1] + mb[1] * p0[0], nu, nv, nw, tuAcc + segLen, pv[j]);
        const c = this.v(s, B[0] + mb[0] * p1[0], v0 + p1[1], B[1] + mb[1] * p1[0], mu, mv, mw, tuAcc + segLen, pv[j + 1]);
        const d = this.v(s, A[0] + ma[0] * p1[0], v0 + p1[1], A[1] + ma[1] * p1[0], mu, mv, mw, tuAcc, pv[j + 1]);
        this.quadIdx(s, a, b, c, d);
      }
      tuAcc += segLen;
    }
    if (caps[0]) this._cap(s, profile, path[0], mit[0], segN[0], v0, -1);
    if (caps[1]) this._cap(s, profile, path[np - 1], mit[np - 1], segN[np - 2], v0, 1);
  }

  /** End cap of a sweep: the profile polygon closed against the wall (out = 0). */
  _cap(s, profile, P, mi, n, v0, dirSign) {
    const tris = capTriangles(profile);
    if (!tris.length) return;
    // cap normal = path direction (end) or its opposite (start)
    const tu = n[1], tw = -n[0]; // path direction from the outward normal
    const nu = tu * dirSign, nw = tw * dirSign;
    const base = s.vc;
    const pts = capPoints(profile);
    s.reserve(pts.length, tris.length);
    for (let k = 0; k < pts.length; k++) {
      const o = pts[k][0], up = pts[k][1];
      this.v(s, P[0] + mi[0] * o, v0 + up, P[1] + mi[1] * o, nu, 0, nw, o * dirSign, up);
    }
    for (let k = 0; k < tris.length; k += 3) {
      // profile-plane CCW faces backwards along the path, so the end cap is flipped
      if (dirSign > 0) this.tri(s, base + tris[k], base + tris[k + 2], base + tris[k + 1]);
      else this.tri(s, base + tris[k], base + tris[k + 1], base + tris[k + 2]);
    }
  }

  /** Straight extrusion of a profile along u from u0 to u1 at w = 0 (wall face); crease: see sweep. */
  extrudeU(s, profile, u0, u1, v0, caps = [true, true], crease = 0) {
    this.sweep(s, profile, [[u0, 0], [u1, 0]], v0, caps, u0, crease);
  }

  // ------------------------------------------------------------------ solids of revolution
  /** Lathe around a vertical axis at (cu, cw): profile [[r, v], ...] bottom to top. */
  lathe(s, profile, cu, cw, v0, seg = 8) {
    const m = profile.length;
    s.reserve(m * (seg + 1) * 2, (m - 1) * seg * 6);
    for (let j = 0; j < m - 1; j++) {
      const [r0, y0] = profile[j], [r1, y1] = profile[j + 1];
      const dr = r1 - r0, dy = y1 - y0, l = Math.hypot(dr, dy) || 1;
      const nr = dy / l, ny = -dr / l;
      const base = s.vc;
      for (let k = 0; k <= seg; k++) {
        const a = (k / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        this.v(s, cu + ca * r0, v0 + y0, cw + sa * r0, ca * nr, ny, sa * nr, (k / seg) * 6.283 * Math.max(r0, 0.05), y0);
        this.v(s, cu + ca * r1, v0 + y1, cw + sa * r1, ca * nr, ny, sa * nr, (k / seg) * 6.283 * Math.max(r1, 0.05), y1);
      }
      for (let k = 0; k < seg; k++) { const a = base + k * 2; this.quadIdx(s, a, a + 1, a + 3, a + 2); }
    }
  }

  /** Cylinder along the local u axis from u0 to u1, centre (v, w), radius r, with end discs. */
  cylinderU(s, u0, u1, cv, cw, r, seg = 12, caps = true) {
    s.reserve((seg + 1) * 2 + (caps ? seg * 2 + 2 : 0), seg * 6 + (caps ? seg * 6 : 0));
    const base = s.vc;
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      this.v(s, u0, cv + ca * r, cw + sa * r, 0, ca, sa, u0, (k / seg) * 6.283 * r);
      this.v(s, u1, cv + ca * r, cw + sa * r, 0, ca, sa, u1, (k / seg) * 6.283 * r);
    }
    for (let k = 0; k < seg; k++) { const a = base + k * 2; this.quadIdx(s, a, a + 2, a + 3, a + 1); }
    if (!caps) return;
    for (const [u, dir] of [[u0, -1], [u1, 1]]) {
      const c0 = this.v(s, u, cv, cw, dir, 0, 0, 0, 0);
      const b0 = s.vc;
      for (let k = 0; k < seg; k++) {
        const a = (k / seg) * Math.PI * 2;
        this.v(s, u, cv + Math.cos(a) * r, cw + Math.sin(a) * r, dir, 0, 0, Math.cos(a) * r, Math.sin(a) * r);
      }
      for (let k = 0; k < seg; k++) {
        const a = b0 + k, b = b0 + ((k + 1) % seg);
        if (dir > 0) this.tri(s, c0, a, b); else this.tri(s, c0, b, a);
      }
    }
  }

  /** Vertical cylinder (axis along v) with a top disc. */
  cylinderV(s, cu, cw, v0, v1, r, seg = 12, top = true) {
    this.lathe(s, [[r, 0], [r, v1 - v0]], cu, cw, v0, seg);
    if (!top) return;
    s.reserve(seg + 1, seg * 3);
    const c0 = this.v(s, cu, v1, cw, 0, 1, 0, cu, cw);
    const b0 = s.vc;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      this.v(s, cu + Math.cos(a) * r, v1, cw + Math.sin(a) * r, 0, 1, 0, cu + Math.cos(a) * r, cw + Math.sin(a) * r);
    }
    for (let k = 0; k < seg; k++) this.tri(s, c0, b0 + ((k + 1) % seg), b0 + k);
  }

  /** Optional profiling: attribute triangles emitted since the last mark to `label`. */
  mark(label) {
    if (!this.profile) return;
    let t = 0;
    for (const s of this.sinks.values()) t += s.ic;
    this.profile[label] = (this.profile[label] || 0) + (t - (this._lastMark || 0)) / 3;
    this._lastMark = t;
    const now = performance.now();
    if (this._lastT) this.profile[label + 'Ms'] = (this.profile[label + 'Ms'] || 0) + now - this._lastT;
    this._lastT = now;
  }

  /** Collect the sinks' contents: Map key -> {p, n, t, c, r, i} views (see Sink.detach). */
  finish() {
    const out = new Map();
    for (const [k, s] of this.sinks) { if (s.vc && s.p) out.set(k, s.detach()); else if (s.p) { s.vc = 0; s.ic = 0; } }
    return out;
  }
}

/**
 * Head segments for an opening's arch: finer for wide openings at full detail; far, the
 * infill's own count (archSegments), so the hole and the glazing share their outline.
 */
export function arcSeg(q, o) { return q.lod ? archSegments(o, 0.4) : o.w > 2 ? 18 : q.archSeg; }

/** Polygon inset by d (convex polygons; flat array CCW). */
export function insetPolygon(pts, d) {
  const m = pts.length >> 1, out = new Array(pts.length);
  for (let k = 0; k < m; k++) {
    const p = (k + m - 1) % m, n = (k + 1) % m;
    const ax = pts[k * 2] - pts[p * 2], ay = pts[k * 2 + 1] - pts[p * 2 + 1];
    const bx = pts[n * 2] - pts[k * 2], by = pts[n * 2 + 1] - pts[k * 2 + 1];
    const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
    // inward normals (left of each edge for CCW)
    const n1x = -ay / la, n1y = ax / la, n2x = -by / lb, n2y = bx / lb;
    let mx = n1x + n2x, my = n1y + n2y;
    const dot = n1x * n2x + n1y * n2y;
    const f = d / Math.max(0.25, 1 + dot);
    mx *= f; my *= f;
    out[k * 2] = pts[k * 2] + mx; out[k * 2 + 1] = pts[k * 2 + 1] + my;
  }
  return out;
}

/** Points of a profile cap: the profile plus its foot on the wall (out = 0); cached. */
const capPtsCache = new WeakMap();
function capPoints(profile) {
  let pts = capPtsCache.get(profile);
  if (pts) return pts;
  const first = profile[0], last = profile[profile.length - 1];
  pts = profile.slice();
  if (last[0] > 1e-4) pts.push([0, last[1]]);
  if (first[0] > 1e-4) pts.push([0, first[1]]);
  capPtsCache.set(profile, pts);
  return pts;
}

function capTriangles(profile) {
  let tris = capCache.get(profile);
  if (tris) return tris;
  const pts = capPoints(profile).map(([o, up]) => new Vector2(o, up));
  // ShapeUtils wants a clockwise or counter-clockwise contour; it handles either
  const faces = ShapeUtils.triangulateShape(pts, []);
  tris = [];
  // orient every triangle so it faces +u in (out, up) → we want consistent winding:
  for (const f of faces) {
    const [a, b, c] = f;
    const cross = (pts[b].x - pts[a].x) * (pts[c].y - pts[a].y) - (pts[b].y - pts[a].y) * (pts[c].x - pts[a].x);
    if (cross > 0) tris.push(a, b, c); else tris.push(a, c, b);
  }
  capCache.set(profile, tris);
  return tris;
}
