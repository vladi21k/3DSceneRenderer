import * as THREE from 'three';
import { GeoWriter, sweepBar, box, lathe, shared } from './geo.js';
import { DESIGNS, RAIL_H } from './patterns.js';

// Wrought-iron railing assets built once at init:
//  - instanced "bay" geometry per design and detail level (handrail, rails, bars,
//    scrolls, collars, rosettes). Levels are defined by a chord TOLERANCE: every curve
//    is tessellated so it never deviates more than TOL[level] from the smith's curve,
//    and the module picks, per bay, the cheapest level whose error stays sub-pixel.
//  - corner / end posts with finials
//  - a railing-card atlas for the far range: alpha is the true coverage of the iron in
//    each texel at every mip (plain box filter), rendered with alpha-to-coverage.

/** Max geometric deviation (m) of the tessellated curves, per detail level. */
export const TOL = [0.0004, 0.0015, 0.004];

/** Smooth-ish closed section extruded along x from x0 to x1 (handrail).
 *  section: [[z, y], ...] counter-clockwise in the (z right, y up) plane. */
function extrudeX(W, section, x0, x1) {
  const n = section.length;
  const nrm = section.map((p, i) => {
    const a = section[(i - 1 + n) % n], b = section[(i + 1) % n];
    let dz = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dz, dy) || 1; dz /= l; dy /= l;
    return [dy, -dz]; // outward for a CCW loop in (z, y)
  });
  const base = W.count;
  for (const x of [x0, x1]) {
    for (let i = 0; i < n; i++) W.v(x, section[i][1], section[i][0], 0, nrm[i][1], nrm[i][0], x, i * 0.01);
  }
  for (let i = 0; i < n; i++) {
    const a = base + i, b = base + (i + 1) % n, c = base + n + (i + 1) % n, d = base + n + i;
    W.quad(a, d, c, b);
  }
}

/** Moulded handrail section: flat underside, rounded top (z = depth, y = height). */
function handSection(y0, y1, d) {
  const hz = d / 2, h = y1 - y0, pts = [];
  pts.push([-hz, y0], [hz, y0], [hz, y0 + h * 0.35]);
  for (let i = 1; i < 6; i++) {
    const a = (i / 6) * Math.PI;
    pts.push([Math.cos(a) * hz, y0 + h * 0.35 + Math.sin(a) * h * 0.65]);
  }
  pts.push([-hz, y0 + h * 0.35]);
  return pts; // counter-clockwise in the (z right, y up) plane
}

/** Square bar along y with an optional twisted section. */
function twistedBar(W, x, y0, y1, s, [t0, t1, turns]) {
  const hs = s / 2;
  const ys = [y0, t0];
  const steps = Math.max(6, Math.round(turns * 6));
  for (let i = 1; i < steps; i++) ys.push(t0 + ((t1 - t0) * i) / steps);
  ys.push(t1, y1);
  const ang = (y) => (y <= t0 ? 0 : y >= t1 ? turns * Math.PI * 2 : ((y - t0) / (t1 - t0)) * turns * Math.PI * 2);
  const rings = ys.map((y) => {
    const a = ang(y), idx = [];
    for (let f = 0; f < 4; f++) {
      const a0 = a + Math.PI / 4 + (f * Math.PI) / 2, a1 = a0 + Math.PI / 2;
      const na = a0 + Math.PI / 4;
      const r = hs * Math.SQRT2;
      idx.push(W.v(x + Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(na), 0, Math.sin(na), f * s, y));
      idx.push(W.v(x + Math.cos(a1) * r, y, Math.sin(a1) * r, Math.cos(na), 0, Math.sin(na), (f + 1) * s, y));
    }
    return idx;
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let f = 0; f < 4; f++) {
      const a = rings[i][f * 2], b = rings[i][f * 2 + 1], c = rings[i + 1][f * 2 + 1], d = rings[i + 1][f * 2];
      W.quad(a, d, c, b);
    }
  }
}

/** Small cast rosette facing +z (`side` -1: the matching one facing -z, on the back of
 *  the bay): petalled dome (seg >= 8) or a flat faceted disc. */
function rosette(W, x, y, r, z0, seg, side = 1) {
  const base = W.count;
  const flat = seg < 8, k = side;
  W.v(x, y, k * (z0 + r * (flat ? 0.3 : 0.55)), 0, 0, k, 0, 0);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const pr = r * (flat ? 0.85 : 0.72 + 0.28 * Math.abs(Math.cos(a * 4)));
    W.v(x + c * pr * 0.45, y + s * pr * 0.45, k * (z0 + r * (flat ? 0.25 : 0.42)), c * 0.35, s * 0.35, 0.94 * k, 0, 0);
    W.v(x + c * pr, y + s * pr, k * z0, c * 0.7, s * 0.7, 0.7 * k, 0, 0);
  }
  for (let i = 0; i < seg; i++) {
    const m0 = base + 1 + i * 2, o0 = m0 + 1, m1 = m0 + 2, o1 = m0 + 3;
    if (k > 0) { W.tri(base, m0, m1); W.quad(m0, o0, o1, m1); } else { W.tri(base, m1, m0); W.quad(m0, m1, o1, o0); }
  }
}

/** Douglas-Peucker: the fewest points of a dense polyline that keep every original
 *  point within `tol` of the simplified one. */
export function simplifyTol(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], ay = pts[a][1], dx = pts[b][0] - ax, dy = pts[b][1] - ay;
    const l2 = dx * dx + dy * dy || 1e-12;
    let worst = -1, wi = -1;
    for (let i = a + 1; i < b; i++) {
      let t = ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = pts[i][0] - ax - t * dx, ey = pts[i][1] - ay - t * dy;
      const e = ex * ex + ey * ey;
      if (e > worst) { worst = e; wi = i; }
    }
    if (worst > t2) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Circle with the fewest segments whose sagitta stays under `tol`. */
function circlePts(cx, cy, r, tol) {
  let n = Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - tol / r)));
  n = Math.max(10, n + (n & 1));
  const pts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return pts;
}

/** Instanced bay geometry for one design at detail level `lod` (0..2, see TOL). Collars
 *  stay at every level (they read as bumps on the bars well into the card range). */
export function bayGeometry(design, lod = 0) {
  const W = new GeoWriter();
  const tol = TOL[lod];
  for (const st of design.strokes) {
    switch (st.k) {
      case 'rail':
        if (st.hand) extrudeX(W, handSection(st.y0, st.y1, st.d), st.x0, st.x1);
        else box(W, (st.x0 + st.x1) / 2, (st.y0 + st.y1) / 2, 0, st.x1 - st.x0, st.y1 - st.y0, st.d, 1, 'lr'); // ends hidden by the next bay
        break;
      case 'bar':
        if (st.twist && !lod) twistedBar(W, st.x, st.y0, st.y1, st.s, st.twist);
        // a twisted square bar's mean silhouette is ~12 % wider than the bar
        else { const s = st.twist ? st.s * 1.12 : st.s; box(W, st.x, (st.y0 + st.y1) / 2, 0, s, st.y1 - st.y0, s, 1, 'ud'); }
        break;
      case 'curve': {
        // all four faces: the inner face of a return panel (and of the far end's, seen
        // through the front) faces the street, and without it the scrolls seen from the
        // side read as loose ribbons
        const p = st.ring ? circlePts(st.ring[0], st.ring[1], st.ring[2], tol) : simplifyTol(st.pts, tol);
        sweepBar(W, p, st.w / 2, st.d / 2, { closed: st.closed, caps: false });
        break;
      }
      case 'collar':
        box(W, st.x, st.y, 0, st.w, st.h, st.d);
        break;
      case 'rosette':
        // cast in pairs, one on each face of the bar it is riveted through
        for (const side of [1, -1]) rosette(W, st.x, st.y, st.r, 0.008, [16, 8, 6][lod], side);
        break;
    }
  }
  const g = W.toGeometry({ colors: false });
  g.userData.design = design.id;
  return shared(g);
}

/** Corner / end post: square bar, collar, ball finial, small foot. Local origin at the foot.
 *  lod 1 has a faceted finial. */
export function postGeometry(lod = 0) {
  const W = new GeoWriter();
  const s = 0.026;
  box(W, 0, RAIL_H / 2 + 0.01, 0, s, RAIL_H + 0.02, s);
  box(W, 0, RAIL_H + 0.026, 0, 0.038, 0.012, 0.038);         // collar
  box(W, 0, 0.006, 0, 0.06, 0.012, 0.06, 1, 'd');            // foot plate
  const seg = lod ? 6 : 10;
  const prof = [];
  const R = 0.027, cy = RAIL_H + 0.068;
  prof.push([0.008, RAIL_H + 0.03]);
  prof.push([0.011, RAIL_H + 0.042]);
  const nb = lod ? 3 : 6, a0 = -Math.PI / 2 + 0.42;
  for (let i = 0; i <= nb; i++) {
    const a = a0 + (i / nb) * (Math.PI / 2 - a0);
    prof.push([Math.max(0.0001, Math.cos(a) * R), cy + Math.sin(a) * R]);
  }
  lathe(W, prof, seg);
  return shared(W.toGeometry({ colors: false }));
}

// ---------------------------------------------------------------- card atlas
// One row per design (u = one bay, wrapping), plus the post sprite in the last row.
// Channels hold the coverage of the iron by stroke orientation, so the card shader can
// widen each kind by the depth of the real members seen at an angle (a railing seen
// along the facade closes into a dark band):
//   R vertical members (bars, posts)   G horizontal members (rails)
//   B curved and small parts (scrolls, rings, collars, rosettes)   A all iron (union)
export const ATLAS = { TW: 128, ROW: 256, PAD: 24, ROWS: 8, POST_ROW: 7, POST_W: 0.1 };
const ATLAS_H = ATLAS.ROW * ATLAS.ROWS;

/** Widening constants per atlas row (patterns.js `widen`); the post sprite is an
 *  isolated square bar with a collar and a ball. */
export const WIDEN = Array.from({ length: ATLAS.ROWS }, (_, i) => (
  i === ATLAS.POST_ROW ? [1, 0, 1, 1] : DESIGNS[i] ? DESIGNS[i].widen : [1, 0.3, 0.7, 2]));

/** Texture v for design row `row` at railing height y (0..RAIL_H + PAD). */
export function atlasV(row, y) {
  const S = (ATLAS.ROW - 2 * ATLAS.PAD) / RAIL_H;
  return (row * ATLAS.ROW + ATLAS.ROW - ATLAS.PAD - y * S) / ATLAS_H;
}

/** Orientation class of a stroke: 'v', 'h' or 'c' (see the channel table above). */
const strokeClass = (st) => (st.k === 'bar' ? 'v' : st.k === 'rail' ? 'h' : 'c');

/** Draw one bay of a design in metres with the current canvas transform (y up); only
 *  the strokes of class `cls` when given. */
export function drawStrokes(ctx, d, cls = null) {
  for (const st of d.strokes) {
    if (cls && strokeClass(st) !== cls) continue;
    switch (st.k) {
      case 'rail': ctx.fillRect(st.x0, st.y0, st.x1 - st.x0, st.y1 - st.y0); break;
      case 'bar': {
        const w = st.twist ? st.s * 1.12 : st.s;
        ctx.fillRect(st.x - w / 2, st.y0, w, st.y1 - st.y0);
        break;
      }
      case 'collar': ctx.fillRect(st.x - st.w / 2, st.y - st.h / 2, st.w, st.h); break;
      case 'rosette': ctx.beginPath(); ctx.arc(st.x, st.y, st.r * 0.9, 0, Math.PI * 2); ctx.fill(); break;
      case 'curve': {
        ctx.lineWidth = st.w;
        ctx.beginPath();
        st.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (st.closed) ctx.closePath();
        ctx.stroke();
        break;
      }
    }
  }
}

function drawDesign(ctx, d, row, cls) {
  const S = (ATLAS.ROW - 2 * ATLAS.PAD) / RAIL_H;
  for (const shift of [-d.W, 0, d.W]) {
    ctx.setTransform(ATLAS.TW / d.W, 0, 0, -S, (shift * ATLAS.TW) / d.W, row * ATLAS.ROW + ATLAS.ROW - ATLAS.PAD);
    drawStrokes(ctx, d, cls);
  }
}

/** Post sprite (matches postGeometry): bar, collar and ball finial, centred in a
 *  POST_W wide tile. */
function drawPost(ctx, cls) {
  const S = (ATLAS.ROW - 2 * ATLAS.PAD) / RAIL_H, W = ATLAS.POST_W;
  ctx.setTransform(ATLAS.TW / W, 0, 0, -S, 0, ATLAS.POST_ROW * ATLAS.ROW + ATLAS.ROW - ATLAS.PAD);
  const c = W / 2;
  if (!cls || cls === 'v') ctx.fillRect(c - 0.013, 0, 0.026, RAIL_H + 0.02);
  if (cls && cls !== 'c') return;
  ctx.fillRect(c - 0.019, RAIL_H + 0.02, 0.038, 0.012);
  ctx.fillRect(c - 0.009, RAIL_H + 0.03, 0.018, 0.015);
  ctx.beginPath(); ctx.ellipse(c, RAIL_H + 0.068, 0.027, 0.027, 0, 0, Math.PI * 2); ctx.fill();
}

/** Box-filtered mip chain of a coverage plane: each texel holds the exact fraction of
 *  iron it covers, so the card's coverage (through alpha-to-coverage) matches the
 *  geometry at every distance. Row boundaries are multiples of every block size, so
 *  rows never mix. */
function boxMips(alpha0, w0, h0, levels) {
  const out = [alpha0];
  let cur = alpha0, w = w0, h = h0;
  for (let L = 1; L < levels; L++) {
    const nw = w >> 1, nh = h >> 1, nxt = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = 2 * y * w + 2 * x;
      nxt[y * nw + x] = (cur[i] + cur[i + 1] + cur[i + w] + cur[i + w + 1]) * 0.25;
    }
    out.push(nxt);
    cur = nxt; w = nw; h = nh;
  }
  return out;
}

/** Builds the railing atlas DataTexture (RGBA coverage planes, see above) with mips. */
export function buildAtlas() {
  const cv = document.createElement('canvas');
  cv.width = ATLAS.TW; cv.height = ATLAS_H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const LEVELS = 6;
  // one coverage plane per class, then the union
  const planes = ['v', 'h', 'c', null].map((cls) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ATLAS.TW, ATLAS_H);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    DESIGNS.forEach((d, i) => drawDesign(ctx, d, i, cls));
    drawPost(ctx, cls);
    const img = ctx.getImageData(0, 0, ATLAS.TW, ATLAS_H).data;
    const a0 = new Float32Array(ATLAS.TW * ATLAS_H);
    for (let i = 0; i < a0.length; i++) a0[i] = img[i * 4 + 3] / 255;
    return boxMips(a0, ATLAS.TW, ATLAS_H, LEVELS);
  });
  const mipmaps = [];
  for (let L = 0, w = ATLAS.TW, h = ATLAS_H; L < LEVELS; L++, w >>= 1, h >>= 1) {
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(planes[c][L][i] * 255);
    mipmaps.push({ data, width: w, height: h });
  }
  const tex = new THREE.DataTexture(mipmaps[0].data, ATLAS.TW, ATLAS_H, THREE.RGBAFormat);
  tex.mipmaps = mipmaps;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
