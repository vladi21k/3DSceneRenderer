import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { facadePlan } from '../facadePlan.js';
import { TREE_D } from '../layout.js';
import { lathe, tube, bar, rbox, xf, merge, quad, makeGeo } from './kit.js';
import { proto, placeMatrix } from './instancer.js';
import { uvRect, uvSub } from './prints.js';

// Everyday street clutter the master plan leaves out, planned once at init (deterministic)
// and registered as crowd obstacles (layout.addObstacles):
//   * utility cabinets (signals, power, telecom): powder-coated steel on a concrete plinth,
//     in the tree line about every 150 m, most with flyers stuck on the doors (and, from
//     the paint, stickers, tags, dust on the cap and run-off below the louvres);
//   * vendor push-carts, one every 300-400 m just off the tree line: a closed cart under a
//     white sheet held down by bungee cords, or a glass case of sesame bread rings;
//   * the occasional plywood hoarding box (a utility dig, a stall in storage), posters on it;
//   * stacked plastic crates or a sack truck beside the grocers' goods stands, against a
//     pier of the shopfront (never in front of a door or window);
//   * a shopkeeper's plastic chair by about one shop door in twelve.
// Tree beds (raised stone planters round some avenue trees) belong to vegetation.
// Authoring frame as everywhere in furniture: +Y up, +Z front, origin on the paving.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const srgb = (h) => new THREE.Color().setStyle(h, THREE.SRGBColorSpace);

// ------------------------------------------------------------------ utility cabinet
const CAB = { W: 0.86, D: 0.34, H0: 0.12, H: 1.18 };

/** Two-door steel cabinet on a concrete plinth: rain cap with a shallow ridge, door seams,
 *  lock barrels, louvres in both sides, an ID plate, and (flyers) a few sheets stuck on. */
function cabinet(detail, flyers) {
  const { W, D, H0, H } = CAB;
  const conc = [xf(rbox(W + 0.1, H0 + 0.02, D + 0.1, detail ? 0.004 : 0.012, 1), [0, (H0 - 0.02) / 2, 0])];
  const yb = H0 + H / 2, yc = H0 + H;
  if (detail >= 2) return { conc: merge(conc), paint: merge([xf(rbox(W, H + 0.04, D, 0), [0, yb + 0.02, 0])]), dark: null, metal: null, plate: null, decal: null };
  const paint = [xf(rbox(W, H, D, detail ? 0.004 : 0.01, detail ? 1 : 2), [0, yb, 0])];
  paint.push(xf(rbox(W + 0.04, 0.022, D + 0.05, 0.005, 1), [0, yc + 0.011, 0]));
  for (const sz of [-1, 1]) paint.push(xf(rbox(W + 0.03, 0.016, (D + 0.05) / 2, 0.004, 1), [0, yc + 0.026, sz * (D + 0.05) / 4], [sz * 0.1, 0, 0]));
  if (detail) return { conc: merge(conc), paint: merge(paint), dark: null, metal: null, plate: null, decal: null };
  const dark = [], metal = [], plate = [], decal = [];
  const zf = D / 2 + 0.0006;
  const y0 = H0 + 0.05, y1 = yc - 0.05, ym = (y0 + y1) / 2, hh = y1 - y0;
  const seam = (w, h, x, y) => dark.push(xf(rbox(w, h, 0.0016, 0), [x, y, zf]));
  seam(0.004, hh, 0, ym);
  for (const sx of [-1, 1]) seam(0.003, hh, sx * (W / 2 - 0.03), ym);
  seam(W - 0.06, 0.003, 0, y0); seam(W - 0.06, 0.003, 0, y1);
  // lock barrels and a triangular key boss on each door
  for (const sx of [-1, 1]) {
    metal.push(xf(lathe([[0.016, 0], [0.016, 0.006], [0.013, 0.01], [0, 0.011]], 14), [sx * 0.055, ym + 0.1, D / 2], [Math.PI / 2, 0, 0]));
    dark.push(xf(rbox(0.006, 0.006, 0.002, 0), [sx * 0.055, ym + 0.1, D / 2 + 0.0115]));
  }
  // louvres low and high in both sides: a dark opening behind tilted slats
  for (const sx of [-1, 1]) for (const yl of [H0 + 0.17, yc - 0.19]) {
    dark.push(xf(rbox(0.0016, 0.11, 0.2, 0), [sx * (W / 2 + 0.0006), yl, 0]));
    for (let k = 0; k < 5; k++) paint.push(xf(rbox(0.004, 0.018, 0.2, 0.001, 1), [sx * (W / 2 + 0.004), yl - 0.044 + k * 0.022, 0], [0, 0, sx * 0.55]));
  }
  // riveted ID plate (pale enamel) high on the left door
  plate.push(xf(rbox(0.13, 0.055, 0.002, 0.001, 1), [-0.24, y1 - 0.09, D / 2 + 0.001]));
  if (flyers) {
    decal.push(xf(quad(0.15, 0.21, uvRect('small3')), [-0.2, ym - 0.02, zf + 0.0015], [0, 0, 0.04]));
    decal.push(xf(quad(0.12, 0.17, uvRect('small6')), [0.23, ym - 0.2, zf + 0.0015], [0, 0, -0.07]));
    decal.push(xf(quad(0.1, 0.06, uvSub('small1', 0, 0, 1, 0.36)), [0.18, ym + 0.2, zf + 0.0015], [0, 0, 0.02]));
    decal.push(xf(quad(0.14, 0.2, uvRect('small0')), [W / 2 + 0.0035, ym + 0.05, 0.02], [0, Math.PI / 2, 0.03]));
  }
  return { conc: merge(conc), paint: merge(paint), dark: merge(dark), metal: merge(metal), plate: merge(plate), decal: decal.length ? merge(decal) : null };
}

// ------------------------------------------------------------------ vendor carts
const CART = { L: 1.16, W: 0.66, y0: 0.52, y1: 0.98, wx: 0.36, wr: 0.24 };

/** Spoked cart wheel (axis along local z) at (x, y, z): tyre, rim, hub and spokes. */
function cartWheel(x, y, z, detail) {
  const R = CART.wr, rubber = [], steel = [];
  const tyre = new THREE.TorusGeometry(R - 0.018, 0.019, detail ? 6 : 10, detail ? 20 : 40);
  rubber.push(xf(tyre, [x, y, z]));
  if (detail) return { rubber, steel };
  const rim = new THREE.TorusGeometry(R - 0.04, 0.008, 6, 36);
  steel.push(xf(rim, [x, y, z]));
  steel.push(xf(lathe([[0, -0.036], [0.03, -0.035], [0.03, 0.035], [0, 0.036]], 12), [x, y, z], [Math.PI / 2, 0, 0]));
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2, zz = (k % 2 ? 0.025 : -0.025);
    steel.push(tube([V(x + Math.cos(a) * 0.03, y + Math.sin(a) * 0.03, z + zz), V(x + Math.cos(a) * (R - 0.045), y + Math.sin(a) * (R - 0.045), z)], 0.0025, { radial: 4, bend: 0, caps: false }));
  }
  return { rubber, steel };
}

/** Undercarriage shared by both carts: steel frame and shelf, two wheels at +x, two legs at
 *  -x, push handles past -x. */
function cartChassis(detail) {
  const { L, W, y0, wx, wr } = CART;
  const steel = [], rubber = [];
  const r = detail ? 0.011 : 0.012;
  // bottom frame rails and shelf
  for (const sz of [-1, 1]) steel.push(tube([V(-L / 2, y0, sz * (W / 2 - 0.02)), V(L / 2, y0, sz * (W / 2 - 0.02))], r, { radial: detail ? 5 : 8, bend: 0 }));
  // low stretchers from the legs to the axle
  steel.push(tube([V(-L / 2 + 0.045, 0.2, -(W / 2 - 0.025)), V(-L / 2 + 0.045, 0.2, W / 2 - 0.025)], 0.009, { radial: detail ? 4 : 6, bend: 0 }));
  for (const sz of [-1, 1]) steel.push(tube([V(-L / 2 + 0.045, 0.2, sz * (W / 2 - 0.025)), V(wx, wr, sz * (W / 2 - 0.02))], 0.009, { radial: detail ? 4 : 6, bend: 0 }));
  // legs at -x (to the ground), struts to the shelf
  for (const sz of [-1, 1]) {
    steel.push(tube([V(-L / 2 + 0.06, y0, sz * (W / 2 - 0.04)), V(-L / 2 + 0.03, 0.02, sz * (W / 2 - 0.02))], r, { radial: detail ? 5 : 8, bend: 0 }));
    steel.push(tube([V(L / 2 - 0.08, y0, sz * (W / 2 - 0.04)), V(wx, wr, sz * (W / 2 - 0.02))], r, { radial: detail ? 5 : 8, bend: 0 }));
    if (!detail) rubber.push(xf(lathe([[0.02, 0], [0.02, 0.02], [0, 0.022]], 8), [-L / 2 + 0.03, 0, sz * (W / 2 - 0.02)]));
    // handles: up from the frame and out past the end, rubber grips
    steel.push(tube([V(-L / 2 + 0.02, y0 + 0.02, sz * (W / 2 - 0.06)), V(-L / 2 - 0.12, y0 + 0.36, sz * (W / 2 - 0.06)), V(-L / 2 - 0.34, y0 + 0.42, sz * (W / 2 - 0.06))], r, { radial: detail ? 5 : 8, bend: 0.08 }));
    if (!detail) rubber.push(tube([V(-L / 2 - 0.22, y0 + 0.405, sz * (W / 2 - 0.06)), V(-L / 2 - 0.36, y0 + 0.425, sz * (W / 2 - 0.06))], 0.017, { radial: 10, bend: 0 }));
  }
  steel.push(tube([V(-L / 2 - 0.3, y0 + 0.415, -(W / 2 - 0.06)), V(-L / 2 - 0.3, y0 + 0.415, W / 2 - 0.06)], r, { radial: detail ? 5 : 8, bend: 0 }));
  // axle and the wheels outside the body
  steel.push(tube([V(wx, wr, -(W / 2 + 0.06)), V(wx, wr, W / 2 + 0.06)], 0.012, { radial: 6, bend: 0 }));
  for (const sz of [-1, 1]) {
    const w = cartWheel(wx, wr, sz * (W / 2 + 0.06), detail);
    steel.push(...w.steel); rubber.push(...w.rubber);
  }
  return { steel, rubber };
}

/** Points evenly spaced (by arc length) round a rounded rectangle, counter-clockwise seen
 *  from above starting mid +x side: [x, z, outward nx, nz, perimeter metres]. */
function roundedRectLoop(a, b, rc, N) {
  const pts = [[a, 0]];
  const arc = (cx, cz, a0) => { for (let i = 0; i <= 8; i++) { const an = a0 + (i / 8) * Math.PI / 2; pts.push([cx + Math.cos(an) * rc, cz + Math.sin(an) * rc]); } };
  arc(a - rc, b - rc, 0); arc(-(a - rc), b - rc, Math.PI / 2); arc(-(a - rc), -(b - rc), Math.PI); arc(a - rc, -(b - rc), 1.5 * Math.PI);
  pts.push([a, 0]);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const per = cum[cum.length - 1], ring = [];
  let j = 0;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * per;
    while (j < pts.length - 2 && cum[j + 1] < t) j++;
    const dx = pts[j + 1][0] - pts[j][0], dz = pts[j + 1][1] - pts[j][1], l = Math.hypot(dx, dz) || 1;
    const f = (t - cum[j]) / l;
    ring.push([pts[j][0] + dx * f, pts[j][1] + dz * f, dz / l, -dx / l, t]);
  }
  return { ring, per };
}

/** Closed cart: body under a white sheet that falls in folds to a ragged hem, goods making
 *  the top lumpy, two black bungee cords across it. */
function cartCovered(detail) {
  const { L, W, y0, y1 } = CART;
  if (detail >= 2) return { body: null, sheet: merge([xf(rbox(L + 0.06, y1 - y0 + 0.12, W + 0.06, 0), [0, (y0 + y1) / 2 + 0.04, 0])]), steel: null, rubber: null, cord: null };
  const ch = cartChassis(detail);
  const body = [xf(rbox(L, 0.2, W, 0.004, 1), [0, y0 + 0.1, 0])];
  // sheet: rings over a rounded rectangle (half sizes a, b, corner radius rc), the cap over
  // the top (lumpy goods) and the skirt down the sides
  const a = L / 2 + 0.035, b = W / 2 + 0.035, rc = 0.07;
  const { ring, per } = roundedRectLoop(a, b, rc, detail ? 32 : 112);
  const lump = (x, z) => 0.035 * Math.sin(x * 6.1 + 0.7) * Math.sin(z * 8.3 + 0.2) + 0.022 * Math.sin(x * 13.7 + 1.9) * Math.cos(z * 11.3 + 0.4)
    + 0.018 * Math.cos(x * 4.3 - z * 5.1);
  const topY = (x, z, s) => y1 + 0.06 + lump(x, z) * Math.min(1, (1 - s) * 4) + 0.03 * (1 - s * s);
  const hemY = (p) => y0 + 0.04 + 0.035 * Math.sin(p * 3.1 + 0.4) + 0.02 * Math.sin(p * 7.7 + 1.3) + 0.012 * Math.sin(p * 17.0);
  const fold = (p) => 0.016 * Math.sin(p * 2 * Math.PI / 0.19 + 0.8 * Math.sin(p * 1.7)) + 0.008 * Math.sin(p * 2 * Math.PI / 0.071 + 2.0);
  const capS = detail ? [0, 0.5, 0.85, 1] : [0, 0.15, 0.3, 0.45, 0.6, 0.72, 0.82, 0.9, 0.96, 1];
  const sideV = detail ? [0, 0.4, 1] : [0, 0.05, 0.12, 0.22, 0.34, 0.48, 0.62, 0.76, 0.88, 0.95, 1];
  const rows = [];
  for (const s of capS) rows.push(ring.map(([x, z, , , p]) => {
    const sx = x * s, sz = z * s;
    return [sx, topY(sx, sz, s) - (s > 0.96 ? 0.012 : 0), sz, p, s * Math.hypot(a, b)];
  }));
  for (const v of sideV) {
    if (v === 0) continue;
    rows.push(ring.map(([x, z, nx, nz, p]) => {
      const yt = topY(x, z, 1) - 0.03, yh = hemY(p);
      const out = 0.008 + v * (0.012 + fold(p)) + (v > 0.9 ? 0.01 * (v - 0.9) * 10 * Math.sin(p * 5.3) : 0);
      return [x + nx * out, yt + (yh - yt) * v, z + nz * out, p, Math.hypot(a, b) + v * (yt - yh)];
    }));
  }
  const pos = [], uv = [], idx = [], col = [], flex = [];
  const n = ring.length;
  rows.forEach((row, ri) => {
    for (let i = 0; i <= n; i++) {
      const [x, y, z, p, v] = row[i % n];
      pos.push(x, y, z); uv.push(i === n ? per : p, v);
      const c = ri === rows.length - 1 ? 0.86 : 1;   // the hem a touch darker (soiled)
      col.push(c, c, c); flex.push(0);
    }
  });
  for (let r = 0; r < rows.length - 1; r++) for (let i = 0; i < n; i++) {
    const a0 = r * (n + 1) + i, b0 = a0 + 1, c0 = a0 + n + 1, d0 = c0 + 1;
    idx.push(a0, b0, c0, b0, d0, c0);
  }
  const sheet = makeGeo(pos, new Array(pos.length).fill(0), uv, idx, { color: { array: col, size: 3 }, aFlex: { array: flex, size: 1 } });
  sheet.computeVertexNormals();
  // bungee cords: over the top across the cart and down the sides to the frame
  const cord = [];
  if (!detail) {
    for (const x of [-0.3, 0.28]) {
      const yt = topY(x, b, 1) - 0.05;
      const pts = [V(x, y0 + 0.06, -(b + 0.07)), V(x, yt, -(b + 0.04))];
      for (let k = 0; k <= 8; k++) {
        const z = -b + (2 * b * k) / 8, s = Math.max(Math.abs(x) / a, Math.abs(z) / b);
        pts.push(V(x, topY(x, z, Math.min(1, s)) + 0.01, z * 1.01));
      }
      pts.push(V(x, yt, b + 0.04), V(x, y0 + 0.06, b + 0.07));
      cord.push(tube(pts, 0.006, { radial: 6, bend: 0.03 }));
    }
  }
  return { body: merge(body), sheet: merge([sheet]), steel: merge(ch.steel), rubber: merge(ch.rubber), cord: cord.length ? merge(cord) : null };
}

/** Open cart: painted cabinet, a glass case on top with sesame bread rings in it. */
function cartGlass(detail) {
  const { L, W, y0 } = CART;
  const yt = y0 + 0.34, gh = 0.4, gl = L - 0.08, gw = W - 0.1;
  if (detail >= 2) return { body: merge([xf(rbox(L, yt - y0 + gh, W, 0), [0, (y0 + yt + gh) / 2, 0])]), alu: null, glass: null, bread: null, steel: null, rubber: null };
  const ch = cartChassis(detail);
  const body = [xf(rbox(L, yt - y0, W, detail ? 0.004 : 0.01, detail ? 1 : 2), [0, (y0 + yt) / 2, 0])];
  body.push(xf(rbox(L + 0.03, 0.02, W + 0.03, 0.004, 1), [0, yt + 0.01, 0]));
  const alu = [], glass = [], bread = [];
  // glass case: aluminium corner posts, top and bottom rails, glass panes, a top lid
  const hx = gl / 2, hz = gw / 2, yb = yt + 0.02;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) alu.push(xf(rbox(0.022, gh, 0.022, 0.003, 1), [sx * hx, yb + gh / 2, sz * hz]));
  for (const y of [yb + 0.011, yb + gh - 0.011]) {
    for (const sz of [-1, 1]) alu.push(xf(rbox(gl, 0.022, 0.022, 0.003, 1), [0, y, sz * hz]));
    for (const sx of [-1, 1]) alu.push(xf(rbox(0.022, 0.022, gw, 0.003, 1), [sx * hx, y, 0]));
  }
  alu.push(xf(rbox(gl + 0.03, 0.012, gw + 0.03, 0.003, 1), [0, yb + gh + 0.006, 0]));
  if (!detail) {
    for (const sz of [-1, 1]) glass.push(xf(new THREE.PlaneGeometry(gl - 0.02, gh - 0.03), [0, yb + gh / 2, sz * hz], [0, sz > 0 ? 0 : Math.PI, 0]));
    for (const sx of [-1, 1]) glass.push(xf(new THREE.PlaneGeometry(gw - 0.02, gh - 0.03), [sx * hx, yb + gh / 2, 0], [0, sx * Math.PI / 2, 0]));
    // bread rings: elongated sesame rings in heaps, a few stood up against the glass
    const rng = RNG.from('cartBread');
    for (let k = 0; k < 22; k++) {
      const ring = new THREE.TorusGeometry(0.1, 0.022, 6, 18);
      const up = k > 16;
      const x = up ? -hx + 0.12 + (k - 17) * 0.17 : rng.range(-hx + 0.13, hx - 0.13), z = up ? -hz + 0.05 : rng.range(-hz + 0.1, hz - 0.1);
      const y = up ? yb + 0.11 : yb + 0.03 + (k % 4) * 0.035;
      bread.push(xf(ring, [x, y, z], up ? [0.25, rng.range(-0.2, 0.2), 0] : [Math.PI / 2 + rng.range(-0.25, 0.25), 0, rng.range(0, 3.1)], [1.35, 0.85, 1], up ? 'XYZ' : 'XZY'));
    }
  }
  return { body: merge(body), alu: merge(alu), glass: glass.length ? merge(glass) : null, bread: bread.length ? merge(bread) : null, steel: merge(ch.steel), rubber: merge(ch.rubber) };
}

// ------------------------------------------------------------------ hoarding box
const HOARD = { L: 2.4, D: 1.25, H: 2.05 };

/** Plywood hoarding box on a timber frame: corner posts and top rails, a padlocked door
 *  panel in the front, posters pasted on. */
function hoarding(detail) {
  const { L, D, H } = HOARD;
  if (detail >= 2) return { ply: merge([xf(rbox(L, H, D, 0), [0, H / 2, 0])]), frame: null, metal: null, paper: null };
  const ply = [], frame = [], metal = [], paper = [];
  const t = 0.018;
  // walls (sheets 1.22 m wide: a joint line every sheet) and the roof sheet
  for (const sz of [-1, 1]) ply.push(xf(rbox(L - 0.02, H - 0.04, t, 0.002, 1), [0, H / 2 + 0.01, sz * (D / 2 - t / 2)]));
  for (const sx of [-1, 1]) ply.push(xf(rbox(t, H - 0.04, D - 2 * t, 0.002, 1), [sx * (L / 2 - t / 2 - 0.01), H / 2 + 0.01, 0]));
  ply.push(xf(rbox(L + 0.06, t, D + 0.06, 0.002, 1), [0, H + 0.03, 0]));
  // 70 x 45 battens: corner posts, a top rail round the box, a mid rail
  const p = 0.07;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) frame.push(xf(rbox(p, H + 0.03, p, 0.004, 1), [sx * (L / 2 + p / 2 - 0.01), (H + 0.03) / 2, sz * (D / 2 + p / 2 - 0.01)]));
  for (const sz of [-1, 1]) for (const y of [H - 0.05, 0.08]) frame.push(xf(rbox(L, 0.07, 0.045, 0.004, 1), [0, y, sz * (D / 2 + 0.0225)]));
  if (!detail) {
    // door joints in the front sheet, hasp and padlock
    for (const x of [-0.05, 0.75]) frame.push(xf(rbox(0.006, H - 0.25, 0.004, 0), [x, H / 2, D / 2 + 0.001]));
    metal.push(xf(rbox(0.11, 0.035, 0.006, 0.002, 1), [0.73, 1.05, D / 2 + 0.004]));
    metal.push(xf(rbox(0.045, 0.05, 0.022, 0.006, 2), [0.79, 1.0, D / 2 + 0.014]));
    metal.push(xf(tube([V(0.775, 1.025, D / 2 + 0.014), V(0.775, 1.06, D / 2 + 0.014), V(0.805, 1.06, D / 2 + 0.014), V(0.805, 1.025, D / 2 + 0.014)], 0.004, { radial: 6, bend: 0.4 }), [0, 0, 0]));
    // posters pasted on the long sides and one end (atlas posters and small sheets)
    const sheet = (w, h, rect, x, y, z, ry, rz = 0) => paper.push(xf(quad(w, h, rect), [x, y, z], [0, ry, rz]));
    sheet(0.6, 0.9, uvRect('poster2'), -0.62, 1.15, D / 2 + 0.002, 0, 0.01);
    sheet(0.42, 0.62, uvRect('small5'), 0.12, 1.32, D / 2 + 0.002, 0, -0.02);
    sheet(0.6, 0.9, uvRect('poster5'), 0.55, 1.2, -D / 2 - 0.002, Math.PI, 0.0);
    sheet(0.6, 0.9, uvRect('poster5'), -0.1, 1.2, -D / 2 - 0.002, Math.PI, 0.015);
    sheet(0.42, 0.62, uvRect('small2'), -L / 2 + 0.008, 1.28, 0.1, -Math.PI / 2, 0.02);
  }
  return { ply: merge(ply), frame: merge(frame), metal: metal.length ? merge(metal) : null, paper: paper.length ? merge(paper) : null };
}

// ------------------------------------------------------------------ crates and sack truck
const CRATE = { L: 0.6, W: 0.4, H: 0.27 };

/** One open plastic crate at (x, y, z) turned by ry: floor, walls, rolled rim, outside ribs;
 *  its vent slots and hand holes as dark patches. */
function crate(detail, x, y, z, ry, out) {
  const { L, W, H } = CRATE;
  const at = (g, p, r = [0, 0, 0]) => xf(xf(g, p, r), [x, y, z], [0, ry, 0]);
  if (detail >= 1) { out.body.push(at(rbox(L, H, W, 0.008, 1), [0, H / 2, 0])); return; }
  const t = 0.012;
  out.body.push(at(rbox(L - 0.02, 0.012, W - 0.02, 0.003, 1), [0, 0.012, 0]));
  for (const sz of [-1, 1]) out.body.push(at(rbox(L - 0.01, H - 0.02, t, 0.003, 1), [0, H / 2 + 0.004, sz * (W / 2 - t / 2)]));
  for (const sx of [-1, 1]) out.body.push(at(rbox(t, H - 0.02, W - 2 * t + 0.002, 0.003, 1), [sx * (L / 2 - t / 2), H / 2 + 0.004, 0]));
  for (const sz of [-1, 1]) out.body.push(at(rbox(L + 0.01, 0.02, 0.022, 0.006, 1), [0, H - 0.01, sz * (W / 2 - 0.005)]));
  for (const sx of [-1, 1]) out.body.push(at(rbox(0.022, 0.02, W + 0.01, 0.006, 1), [sx * (L / 2 - 0.005), H - 0.01, 0]));
  for (const sz of [-1, 1]) for (const xr of [-0.19, 0, 0.19]) out.body.push(at(rbox(0.014, H - 0.05, 0.007, 0.002, 1), [xr, H / 2, sz * (W / 2 + 0.003)]));
  // vent slots on the long sides, hand holes in the ends
  for (const sz of [-1, 1]) for (let i = 0; i < 2; i++) for (let j = 0; j < 4; j++) {
    out.slots.push(at(rbox(0.07, 0.028, 0.0012, 0), [[-0.135, -0.055, 0.055, 0.135][j], 0.08 + i * 0.07, sz * (W / 2 + 0.0004)]));
  }
  for (const sx of [-1, 1]) out.slots.push(at(rbox(0.0012, 0.035, 0.12, 0), [sx * (L / 2 + 0.0004), H - 0.06, 0]));
}

/** Stack of n crates, nested a little, each knocked a centimetre or two out of line. Even
 *  and odd crates are separate parts so a stack can mix two colours. */
function crateStack(n, detail, seed) {
  const rng = RNG.from('crateStack', seed);
  const even = { body: [], slots: [] }, odd = { body: [], slots: [] };
  for (let k = 0; k < n; k++) {
    crate(detail, rng.range(-0.015, 0.015), k * (CRATE.H - 0.012), rng.range(-0.012, 0.012), rng.range(-0.035, 0.035), k % 2 ? odd : even);
  }
  const m = (l) => (l.length ? merge(l) : null);
  return { even: m(even.body), odd: m(odd.body), slots: m([...even.slots, ...odd.slots]) };
}

/** Sack truck standing on its toe plate and wheels: tubular frame, cross bars, a handle
 *  loop, two solid wheels behind. */
function sackTruck(detail) {
  const frame = [], rubber = [], galv = [];
  const r = 0.012, rad = detail ? 5 : 8;
  for (const sx of [-1, 1]) frame.push(tube([V(sx * 0.19, 0.03, 0.02), V(sx * 0.19, 1.02, -0.03), V(sx * 0.13, 1.2, -0.04)], r, { radial: rad, bend: 0.06 }));
  frame.push(tube([V(-0.13, 1.2, -0.04), V(0.13, 1.2, -0.04)], r, { radial: rad, bend: 0 }));
  for (const y of [0.32, 0.62, 0.9]) frame.push(tube([V(-0.19, y, 0.02 - y * 0.05), V(0.19, y, 0.02 - y * 0.05)], 0.008, { radial: rad, bend: 0 }));
  galv.push(xf(rbox(0.42, 0.006, 0.2, 0.002, 1), [0, 0.006, 0.11]));
  galv.push(tube([V(-0.27, 0.13, -0.1), V(0.27, 0.13, -0.1)], 0.01, { radial: 6, bend: 0 }));
  for (const sx of [-1, 1]) {
    frame.push(tube([V(sx * 0.19, 0.3, 0.005), V(sx * 0.21, 0.13, -0.1)], 0.01, { radial: rad, bend: 0 }));
    rubber.push(xf(new THREE.TorusGeometry(0.09, 0.04, detail ? 6 : 10, detail ? 14 : 28), [sx * 0.25, 0.13, -0.1], [0, Math.PI / 2, 0]));
    galv.push(xf(lathe([[0, -0.03], [0.06, -0.025], [0.06, 0.025], [0, 0.03]], 14), [sx * 0.25, 0.13, -0.1], [0, 0, -Math.PI / 2]));
  }
  if (!detail) for (const sx of [-1, 1]) rubber.push(tube([V(sx * 0.13, 1.2, -0.04), V(sx * 0.155, 1.15, -0.038)], 0.016, { radial: 10, bend: 0 }));
  return { frame: merge(frame), rubber: merge(rubber), galv: merge(galv) };
}

// ------------------------------------------------------------------ prototypes
export function buildClutterProtos(F) {
  const P = {};
  // a part's level geometries, or null when no level has one (the part is left out)
  const lv = (list, key) => { const g = list.map((x) => x[key]); return g.some(Boolean) ? g : null; };
  for (const fl of [false, true]) {
    const c = [cabinet(0, fl), cabinet(1, fl), cabinet(2, fl)];
    P[fl ? 'cabFlyers' : 'cabPlain'] = proto('utilityCabinet', [{ geo: c.map((x) => x.paint), mat: F.paint, tint: true }, { geo: c.map((x) => x.conc), mat: F.concrete },
      { geo: c.map((x) => x.dark), mat: F.interior, cast: false }, { geo: c.map((x) => x.metal), mat: F.galv, cast: false },
      { geo: c.map((x) => x.plate), mat: F.pages, cast: false }, { geo: lv(c, 'decal'), mat: F.paper, cast: false }], [30, 120]);
  }
  {
    const c = [cartCovered(0), cartCovered(1), cartCovered(2)];
    P.cartCovered = proto('cartCovered', [{ geo: c.map((x) => x.sheet), mat: F.canopy, tint: true }, { geo: c.map((x) => x.body), mat: F.paint, tint: true, tintKey: 'body' },
      { geo: c.map((x) => x.steel), mat: F.galv }, { geo: c.map((x) => x.rubber), mat: F.rubber }, { geo: c.map((x) => x.cord), mat: F.rubber, cast: false }], [35, 130]);
  }
  {
    const c = [cartGlass(0), cartGlass(1), cartGlass(2)];
    P.cartGlass = proto('cartGlass', [{ geo: c.map((x) => x.body), mat: F.paint, tint: true, tintKey: 'body' }, { geo: c.map((x) => x.alu), mat: F.aluminium },
      { geo: c.map((x) => x.glass), mat: F.shelterGlass, cast: false }, { geo: c.map((x) => x.bread), mat: F.tabletop, tint: true, tintKey: 'bread' },
      { geo: c.map((x) => x.steel), mat: F.galv }, { geo: c.map((x) => x.rubber), mat: F.rubber }], [35, 130]);
  }
  {
    const h = [hoarding(0), hoarding(1), hoarding(2)];
    P.hoarding = proto('hoarding', [{ geo: h.map((x) => x.ply), mat: F.timber, tint: true }, { geo: h.map((x) => x.frame), mat: F.timber, tint: true, tintKey: 'frame' },
      { geo: h.map((x) => x.metal), mat: F.galv, cast: false }, { geo: h.map((x) => x.paper), mat: F.paper, cast: false }], [50, 170]);
  }
  for (const n of [2, 3, 4, 5]) {
    const s = [crateStack(n, 0, n), crateStack(n, 1, n)];
    P[`crates${n}`] = proto('crateStack', [{ geo: s.map((x) => x.even), mat: F.plastic, tint: true, tintKey: 'a' }, { geo: s.map((x) => x.odd), mat: F.plastic, tint: true, tintKey: 'b' },
      { geo: [s[0].slots, null], mat: F.interior, cast: false }], [22]);
  }
  {
    const t = [sackTruck(0), sackTruck(1)];
    P.sackTruck = proto('sackTruck', [{ geo: t.map((x) => x.frame), mat: F.paint, tint: true }, { geo: t.map((x) => x.rubber), mat: F.rubber }, { geo: t.map((x) => x.galv), mat: F.galv }], [22]);
  }
  return P;
}

// ------------------------------------------------------------------ planning
const CAB_COL = ['#8d918f', '#9a998f', '#6f7771', '#7c8582', '#a7a59b', '#59605c'];
const CART_COL = ['#d9d6cd', '#2f5f8a', '#3d6b45', '#b9b7b0', '#8a2f2a'];
const SHEET_COL = ['#eceae3', '#e3e1d8', '#d9dcdf', '#ece6d6'];
const CRATE_COL = ['#2f7d3b', '#245fa8', '#b5322b', '#25272a', '#8d8f8e', '#d8b02a', '#2e8a86'];
const TRUCK_COL = ['#b5322b', '#25272a', '#245fa8', '#5b5f63'];
const CHAIR_COL = ['#e9e7e1', '#e9e7e1', '#9a9a96', '#2a2a2a', '#6b5440', '#3a5a7a'];
const GROCER = new Set(['produce', 'citrus', 'flowers', 'bakery', 'sacks']);

/** Plan every clutter item once (init) and register its obstacles. Returns a Map chunk
 *  index -> [{key, s, d, yaw, color?, colors?, chair?}]. */
export function planClutter(app) {
  const { layout, route } = app;
  const L = route.length;
  const byChunk = new Map();
  const counts = {};
  const add = (it, ob) => {
    const ci = layout.chunkIndex(it.s);
    if (!byChunk.has(ci)) byChunk.set(ci, []);
    byChunk.get(ci).push(it);
    counts[it.kind] = (counts[it.kind] || 0) + 1;
    if (layout.addObstacles) layout.addObstacles(ob); else layout.obstacles.push(...ob);
  };
  /** Is a disc (s, d, r) clear of every obstacle by m metres, and on the sidewalk (wall:
   *  it may stand against the facade line)? */
  const clear = (s, d, r, m, wall = false) => {
    const side = d > 0 ? 1 : -1;
    if (Math.abs(d) + r > layout.halfWidth(s, side) + (wall ? 0.05 : -0.1) || Math.abs(d) - r < 3.6) return false;
    for (const o of layout.obstaclesNear(s, 6)) {
      if (o.kind === 'circle') {
        const ds = route.delta(o.s, s), dd = d - o.d, rr = o.r + r + m;
        if (ds * ds + dd * dd < rr * rr) return false;
      } else if (route.delta(o.s0, s) > -(r + m) && route.delta(s, o.s1) > -(r + m) && d > o.d0 - r - m && d < o.d1 + r + m) return false;
    }
    return true;
  };
  const tint = (rng, list, lo = 0.94, hi = 1.04) => srgb(rng.pick(list)).multiplyScalar(rng.range(lo, hi));

  // utility cabinets in the tree line, about every 150 m, alternating sides now and then
  {
    const rng = RNG.from(layout.seed, 'clutterCab');
    let s = rng.range(20, 90);
    while (s < L) {
      const s0 = s, side = rng.chance(0.5) ? 1 : -1;
      s += rng.range(110, 190);
      if (layout.isInStation(s0, 10) || layout.isInCrossStreet(s0, side, 5)) continue;
      const flyers = rng.chance(0.8), along = rng.chance(0.3), turn = rng.chance(0.5) ? 0 : Math.PI, jit = rng.range(-0.04, 0.04);
      const color = tint(rng, CAB_COL);
      for (const ds of [0, 2.5, -2.5, 5, -5, 7.5, -7.5]) {
        const ss = s0 + ds, d = side * (TREE_D + 0.15);
        if (!clear(ss, d, 0.55, 0.45)) continue;
        // doors to the walkers (away from the tracks), or turned along the street
        const yaw = (along ? turn : side * Math.PI / 2) + jit;
        add({ kind: 'cabinet', key: flyers ? 'cabFlyers' : 'cabPlain', s: ss, d, yaw, color }, [{ kind: 'circle', s: ss, d, r: 0.6, clutter: 'cabinet' }]);
        break;
      }
    }
  }
  // vendor carts, one every 300-400 m, just off the tree line on the walking side
  {
    const rng = RNG.from(layout.seed, 'clutterCart');
    let s = rng.range(80, 220);
    while (s < L) {
      const s0 = s, side = rng.chance(0.5) ? 1 : -1;
      s += rng.range(300, 400);
      if (layout.isInStation(s0, 8) || layout.isInCrossStreet(s0, side, 5)) continue;
      const covered = rng.chance(0.6), out = rng.range(1.3, 1.8), yaw0 = (rng.chance(0.5) ? 0.5 : -0.5) * Math.PI + rng.range(-0.18, 0.18);
      const colors = { body: tint(rng, CART_COL), bread: srgb('#b98444').multiplyScalar(rng.range(0.9, 1.05)) };
      const color = covered ? tint(rng, SHEET_COL, 0.97, 1.02) : colors.body;
      for (const ds of [0, 3, -3, 6, -6, 9, -9, 12, -12]) {
        const ss = s0 + ds, d = side * Math.min(TREE_D + out, layout.halfWidth(ss, side) - 2.4);
        if (!clear(ss, d, 1.0, 0.35)) continue;
        add({ kind: 'cart', key: covered ? 'cartCovered' : 'cartGlass', s: ss, d, yaw: yaw0, color, colors },
          [{ kind: 'rect', s0: ss - 1.0, s1: ss + 1.0, d0: d - 0.55, d1: d + 0.55, clutter: 'cart' }]);
        break;
      }
    }
  }
  // plywood hoarding boxes: three on the loop, in the wide strip past the tree line
  {
    const rng = RNG.from(layout.seed, 'clutterHoard');
    for (let k = 0, tries = 0; k < 3 && tries < 60; tries++) {
      const s0 = rng.range(0, L), side = rng.chance(0.5) ? 1 : -1;
      const yaw = (rng.chance(0.5) ? 0.5 : -0.5) * Math.PI + rng.range(-0.03, 0.03);
      // pale plywood and yellower battens over the weathered timber texture
      const ply = new THREE.Color(2.3, 2.3, 2.1).multiplyScalar(rng.range(0.88, 1.04)), frame = new THREE.Color(2.0, 1.9, 1.55).multiplyScalar(rng.range(0.9, 1.05));
      if (layout.isInStation(s0, 15) || layout.isInCrossStreet(s0, side, 6)) continue;
      const d = side * Math.min(TREE_D + rng.range(1.6, 2.2), layout.halfWidth(s0, side) - 2.8);
      if (!clear(s0, d, 1.45, 0.5)) continue;
      add({ kind: 'hoarding', key: 'hoarding', s: s0, d, yaw, color: ply, colors: { frame } },
        [{ kind: 'rect', s0: s0 - 1.35, s1: s0 + 1.35, d0: d - 0.75, d1: d + 0.75, clutter: 'hoarding' }]);
      k++;
    }
  }
  // shopfront piers: lot -> frame and its ground-floor openings (u intervals)
  const lotById = new Map(layout.lots.map((l) => [l.id, l]));
  const openCache = new Map();
  const openings = (lot) => {
    if (openCache.has(lot)) return openCache.get(lot);
    let g = null;
    try { const plan = facadePlan(lot); g = plan ? plan.openings.filter((o) => o.floor === 0).sort((a, b) => a.uc - b.uc) : null; } catch (e) { g = null; }
    openCache.set(lot, g);
    return g;
  };
  /** Frame u (m) of route s in a main-street lot's front. */
  const uOf = (lot, s) => (lot.side > 0 ? route.delta(s, lot.s1) : route.delta(lot.s0, s)) / lot.len * lot.frame.width;
  /** Is the span u0..u1 on a pier (clear of every ground-floor opening by `gap`)? */
  const onPier = (lot, u0, u1, gap = 0.12) => {
    const g = openings(lot);
    if (!g || u0 < 0.25 || u1 > lot.frame.width - 0.25) return false;
    return g.every((o) => u1 < o.uc - o.w / 2 - gap || u0 > o.uc + o.w / 2 + gap);
  };
  // crates or a sack truck beside the grocers' goods stands, against a pier
  {
    const stands = layout.obstacles.filter((o) => o.kind === 'rect' && GROCER.has(o.stand));
    for (const o of stands) {
      const rng = RNG.from(layout.seed, 'clutterCrate', Math.round(o.s0 * 8), o.d0 > 0 ? 1 : 0);
      if (!rng.chance(0.4)) continue;
      const lot = lotById.get(o.lot);
      if (!lot || !lot.frame || lot.sideStreet) continue;
      const side = lot.side, truck = rng.chance(0.22), n = rng.int(2, 5);
      const ca = tint(rng, CRATE_COL, 0.9, 1.05), cb = rng.chance(0.65) ? ca : tint(rng, CRATE_COL, 0.9, 1.05);
      const tc = tint(rng, TRUCK_COL);
      const ends = rng.chance(0.5) ? [1, -1] : [-1, 1];
      for (const e of ends) {
        const half = truck ? 0.24 : 0.32;
        const s = e > 0 ? o.s1 + half + 0.1 : o.s0 - half - 0.1;
        const hw = layout.halfWidth(s, side);
        const back = truck ? 0.4 : 0.42;   // centre's distance from the facade line
        const d = side * (hw - back);
        const u = uOf(lot, s);
        if (!onPier(lot, u - half, u + half)) continue;
        if (!clear(s, d, truck ? 0.3 : 0.36, 0.04, true)) continue;
        // crates long side to the wall; the truck faces the street
        const yaw = truck ? -side * Math.PI / 2 + rng.range(-0.25, 0.25) : (rng.chance(0.5) ? 0.5 : -0.5) * Math.PI + rng.range(-0.06, 0.06);
        if (truck) add({ kind: 'truck', key: 'sackTruck', s, d, yaw, color: tc }, [{ kind: 'circle', s, d, r: 0.3, clutter: 'truck' }]);
        else add({ kind: 'crates', key: `crates${n}`, s, d, yaw, colors: { a: ca, b: cb } }, [{ kind: 'circle', s, d, r: 0.36, clutter: 'crates' }]);
        break;
      }
    }
  }
  // a shopkeeper's chair against a pier beside about one shop door in twelve
  {
    for (const lot of layout.lots) {
      if (lot.sideStreet || (lot.cafe !== undefined && lot.cafe !== null) || !lot.frame || !(lot.frame.width > 2)) continue;
      const g = openings(lot);
      if (!g) continue;
      const f = lot.frame;
      for (const o of g) {
        if (o.kind !== 'shop') continue;
        const rng = RNG.from(layout.seed, 'clutterChair', o.id ?? Math.round(o.uc * 100) + lot.id * 1000);
        if (!rng.chance(0.085)) continue;
        const left = rng.chance(0.5);
        const u = left ? o.uc - o.w / 2 - 0.42 : o.uc + o.w / 2 + 0.42;
        if (!onPier(lot, u - 0.27, u + 0.27, 0.08)) continue;
        const p = f.origin.clone().addScaledVector(f.uDir, u).addScaledVector(f.nDir, 0.62);
        const frac = u / f.width;
        const sGuess = lot.side > 0 ? lot.s1 - frac * lot.len : lot.s0 + frac * lot.len;
        const { s, d } = route.project(p.x, p.z, sGuess, 3);
        if (layout.isInCrossStreet(s, lot.side, 2) || !clear(s, d, 0.32, 0.08, true)) continue;
        // facing the street, turned towards the door or the passers-by
        const yaw = -lot.side * Math.PI / 2 + (left ? -1 : 1) * lot.side * rng.range(0.2, 0.7);
        add({ kind: 'chair', key: 'chair', chair: true, s, d, yaw, color: tint(rng, CHAIR_COL, 0.95, 1.02) }, [{ kind: 'circle', s, d, r: 0.36, clutter: 'chair' }]);
      }
    }
  }
  byChunk.counts = counts;
  return byChunk;
}

const _m = new THREE.Matrix4();
const FOOT = { cabinet: 0.5, cart: 0.6, hoarding: 1.2, crates: 0.3, truck: 0.22, chair: 0.28 };

/** Instances of the clutter planned in this chunk. chairP: the café's plastic chair. */
export function placeClutter(chunk, app, inst, P, chairP, plan) {
  const list = plan && plan.get(chunk.index);
  if (!list) return;
  for (const it of list) {
    const p = it.chair ? chairP : P[it.key];
    inst.add(p, placeMatrix(app.route, it.s, it.d, 0, it.yaw, _m, FOOT[it.kind] || 0.3), it.color || null, it.colors || null);
  }
}
