import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { lathe, tube, bar, rbox, xf, merge, makeGeo, quad } from './kit.js';
import { proto, placeMatrix } from './instancer.js';
import { uvRect, uvSub, columnSheetRects, COLUMN_TIERS } from './prints.js';

// Street furniture from layout.furniture: cast-iron benches with timber slats, litter
// bins, bollards, newspaper / coffee kiosks, advertising columns, bike racks and city
// map boards. Authoring frame: +Y up, +Z front, origin on the paving. Every item has a
// far level (a few dozen triangles) so it stays in the far chunks instead of popping in.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const srgb = (h) => new THREE.Color().setStyle(h, THREE.SRGBColorSpace);
const B0 = (w, h, d, x, y, z, rx = 0) => xf(rbox(w, h, d, 0), [x, y, z], [rx, 0, 0]);

/** Curved strip on a cylinder of radius r (phi measured from +Z towards +X), UVs mapped
 *  onto an atlas rect (u along phi, v up). */
function cylPatch(r, ph0, ph1, y0, y1, rect, segs = 8) {
  const pos = [], nor = [], uv = [], idx = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, ph = ph0 + (ph1 - ph0) * t, s = Math.sin(ph), c = Math.cos(ph);
    for (const [y, v] of [[y0, rect[1]], [y1, rect[3]]]) {
      pos.push(s * r, y, c * r); nor.push(s, 0, c); uv.push(rect[0] + (rect[2] - rect[0]) * t, v);
    }
  }
  for (let i = 0; i < segs; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
  return makeGeo(pos, nor, uv, idx);
}

// ------------------------------------------------------------------ bench
function benchEnd(x, mid = false) {
  // cast-iron end frame: swept bars in the YZ plane, 35 mm thick
  const b = (pts, w = 0.034, h = 0.042) => bar(pts.map(([z, y]) => V(x, y, z)), w, h, { up: [1, 0, 0], r: mid ? 0 : 0.008, bend: mid ? 0 : 0.06, bendSegs: 2 });
  const parts = [
    b([[0.21, 0], [0.2, 0.2], [0.185, 0.42]]),                        // front leg
    b([[-0.26, 0], [-0.22, 0.2], [-0.19, 0.4]]),                      // rear leg
    b([[0.235, 0.43], [0.05, 0.415], [-0.19, 0.4], [-0.22, 0.55], [-0.265, 0.84]], 0.034, 0.05), // seat rail into back support
    b([[-0.215, 0.63], [0.0, 0.64], [0.19, 0.625]], 0.034, 0.05),     // armrest
    b([[0.185, 0.42], [0.2, 0.52], [0.19, 0.6]], 0.03, 0.036),         // arm post
  ];
  // scroll curl at the armrest end
  const curl = [], nc = mid ? 6 : 14;
  for (let i = 0; i <= nc; i++) {
    const a = (i / nc) * Math.PI * 1.7, r = 0.055 * (1 - i / (nc * 1.6));
    curl.push(V(x, 0.575 + Math.cos(a) * r, 0.19 + Math.sin(a) * r));
  }
  parts.push(tube(curl, 0.016, { radial: mid ? 4 : 6, bend: 0 }));
  // feet pads
  parts.push(xf(rbox(0.06, 0.02, 0.07, 0.004), [x, 0.01, 0.21]), xf(rbox(0.06, 0.02, 0.07, 0.004), [x, 0.01, -0.26]));
  return parts;
}

function bench(detail) {
  const L = 1.8, mid = detail === 1;
  if (detail >= 2) {
    return {
      iron: merge([B0(0.04, 0.62, 0.45, -0.82, 0.31, 0), B0(0.04, 0.62, 0.45, 0.82, 0.31, 0)]),
      wood: merge([B0(L, 0.035, 0.42, 0, 0.43, 0), B0(L, 0.3, 0.035, 0, 0.65, -0.235, -0.25)]),
    };
  }
  const iron = [...benchEnd(-L / 2 + 0.08, mid), ...benchEnd(L / 2 - 0.08, mid)];
  const wood = [], r = mid ? 0 : 0.007;
  const seat = [[0.215, 0.425], [0.135, 0.437], [0.055, 0.44], [-0.025, 0.437], [-0.105, 0.43], [-0.18, 0.42]];
  // slats are cut from different boards: each gets its own stretch of the grain texture
  seat.forEach(([z, y], i) => {
    const g = rbox(L, 0.032, 0.068, r, 1), uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) + i * 0.37, uv.getY(k) + i * 0.29);
    wood.push(xf(g, [0, y + 0.016, z]));
  });
  for (let i = 0; i < 3; i++) {
    const t = 0.32 + i * 0.27;
    const z = -0.2 - 0.06 * t, y = 0.45 + 0.38 * t;
    const g = rbox(L, 0.075, 0.03, r, 1), uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) + 0.6 + i * 0.41, uv.getY(k) + i * 0.17);
    wood.push(xf(g, [0, y, z + 0.022], [-0.25, 0, 0]));
  }
  if (!mid) for (const x of [-L / 2 + 0.08, L / 2 - 0.08]) for (const z of [0.215, 0.055, -0.105]) { // coach bolts
    iron.push(xf(lathe([[0.008, 0], [0.008, 0.003], [0.005, 0.005], [0, 0.006]], 6), [x + Math.sign(x) * -0.06, 0.457, z]));
  }
  return { iron: merge(iron), wood: merge(wood) };
}

// ------------------------------------------------------------------ bins
const DOOR = [-0.55, 0.55, 0.17, 0.66]; // hooded bin door: phi range and height range (front, +Z)

/** Hooded municipal litter bin: fluted steel body with a smooth access door (seam, hinge,
 *  lock and a small decal), a 12 cm throw-in gap under the hood where the black bag lip
 *  and the dark inside show, and a domed hood on three posts. */
function binHooded(detail) {
  if (detail >= 2) {
    return {
      body: merge([lathe([[0.27, 0], [0.235, 0.1], [0.228, 0.8], [0.0, 0.8]], 8), lathe([[0, 0.925], [0.25, 0.925], [0.25, 0.97], [0.12, 1.05], [0, 1.1]], 8)]),
      liner: null, trim: null, decal: null,
    };
  }
  const mid = detail === 1, seg = mid ? 24 : 96;
  const inDoor = (ph, y) => Math.abs(ph > Math.PI ? ph - 2 * Math.PI : ph) < DOOR[1] + 0.02 && y > DOOR[2] - 0.01 && y < DOOR[3] + 0.01;
  // 24 rounded flutes, 6 mm deep, except on the door panel
  const flutes = mid ? null : (ph, y) => (y > 0.15 && y < 0.69 && !inDoor(ph, y) ? 1 - 0.027 * Math.pow(Math.max(0, Math.cos(ph * 24)), 2) : 1);
  const body = lathe([[0.27, 0], [0.27, 0.035], [0.255, 0.05], [0.236, 0.09], [0.234, 0.13], [0.226, 0.14], [0.226, 0.7], [0.234, 0.71], [0.234, 0.77],
    [0.242, 0.78], [0.242, 0.8], [0.232, 0.808], [0.221, 0.8], [0.221, 0.45]], seg, { rmod: flutes, crease: 1.0 });
  const hood = lathe([[0, 0.925], [0.236, 0.925], [0.25, 0.932], [0.256, 0.955], [0.248, 0.985], [0.19, 1.035], [0.09, 1.07], [0.045, 1.077], [0.048, 1.093], [0.032, 1.107], [0, 1.112]], mid ? 24 : 36);
  const posts = [Math.PI, Math.PI / 3, -Math.PI / 3].map((a) => xf(rbox(0.03, 0.13, 0.016, mid ? 0 : 0.004), [Math.sin(a) * 0.228, 0.866, Math.cos(a) * 0.228], [0, a, 0]));
  const parts = [body, hood, ...posts];
  // door: hinge knuckles on the left, a lock barrel on the right
  const trim = [];
  if (!mid) {
    for (const y of [0.25, 0.58]) {
      const a = DOOR[0] - 0.05;
      parts.push(xf(lathe([[0.009, 0], [0.009, 0.05], [0, 0.052]], 8), [Math.sin(a) * 0.232, y, Math.cos(a) * 0.232]));
    }
    const a = DOOR[1] - 0.12;
    parts.push(xf(lathe([[0.014, -0.004], [0.014, 0.006], [0.01, 0.009], [0, 0.009]], 10), [Math.sin(a) * 0.226, 0.57, Math.cos(a) * 0.226], [Math.PI / 2, a, 0], 1, 'YXZ'));
    // door seam: a dark 2 mm gap round the panel
    const r = 0.2272;
    trim.push(cylPatch(r, DOOR[0], DOOR[1], DOOR[3], DOOR[3] + 0.003, [0, 0, 1, 1], 10), cylPatch(r, DOOR[0], DOOR[1], DOOR[2] - 0.003, DOOR[2], [0, 0, 1, 1], 10));
    for (const a2 of [DOOR[0], DOOR[1]]) trim.push(cylPatch(r, a2 - 0.0075, a2 + 0.0075, DOOR[2] - 0.003, DOOR[3] + 0.003, [0, 0, 1, 1], 1));
  }
  // black bag folded over the rim and the dark inside seen through the throw-in gap
  const liner = [lathe([[0.2, 0.62], [0.214, 0.78], [0.222, 0.81], [0.236, 0.814], [0.247, 0.8], [0.249, 0.775]].reverse(), mid ? 16 : 36,
    { rmod: (ph, y) => 1 + (y > 0.79 ? 0 : 0.012 * Math.sin(ph * 7 + y * 40)) })];
  liner.push(xf(new THREE.CircleGeometry(0.2, mid ? 8 : 16), [0, 0.62, 0], [-Math.PI / 2, 0, 0]));
  const decal = mid ? null : merge([cylPatch(0.2275, -0.1, 0.1, 0.4, 0.5, uvRect('binDecal'), 4)]);
  return { body: merge(parts), liner: merge(liner), trim: trim.length ? merge(trim) : null, decal };
}

/** Open-top steel litter bin hung on a post, black bag folded over the rim. */
function binPost(detail) {
  if (detail >= 2) {
    return { body: merge([xf(lathe([[0.0, 0.3], [0.2, 0.3], [0.21, 0.93], [0, 0.93]], 8), [0, 0, 0.04]), xf(rbox(0.07, 1.05, 0.07, 0), [0, 0.525, -0.2])]), liner: null };
  }
  const mid = detail === 1;
  const slots = mid ? null : (ph, y) => (y > 0.4 && y < 0.86 ? 1 + 0.018 * Math.max(0, Math.cos(ph * 14)) : 1);
  const body = lathe([[0.0, 0.3], [0.17, 0.3], [0.195, 0.32], [0.2, 0.36], [0.2, 0.88], [0.212, 0.9], [0.212, 0.93], [0.2, 0.935], [0.192, 0.93], [0.192, 0.9]], mid ? 16 : 28, { rmod: slots, crease: 1.0 });
  xf(body, [0, 0, 0.04]);
  const post = lathe([[0.045, 0], [0.045, 0.02], [0.035, 0.03], [0.035, 1.02], [0.04, 1.03], [0, 1.05]], mid ? 8 : 12);
  xf(post, [0, 0, -0.2]);
  const brackets = [0.45, 0.82].map((y) => xf(rbox(0.05, 0.05, 0.08, mid ? 0 : 0.008), [0, y, -0.155]));
  const bag = lathe([[0.216, 0.905], [0.214, 0.938], [0.196, 0.94], [0.19, 0.9], [0.188, 0.6], [0.17, 0.45]], mid ? 10 : 20, { rmod: (ph, y) => 1 + 0.02 * Math.sin(ph * 5 + y * 30) });
  xf(bag, [0, 0, 0.04]);
  const inner = xf(new THREE.CircleGeometry(0.17, 12), [0, 0.6, 0.04], [-Math.PI / 2, 0, 0]);
  return { body: merge([body, post, ...brackets]), liner: merge([bag, inner]) };
}

// ------------------------------------------------------------------ bollards
function bollardIron(seg = 16) {
  if (seg <= 6) return merge([lathe([[0.12, 0], [0.086, 0.08], [0.078, 0.74], [0.06, 0.85], [0.035, 0.97], [0, 0.985]], seg)]);
  return merge([lathe([[0.12, 0], [0.12, 0.02], [0.1, 0.04], [0.086, 0.09], [0.076, 0.68], [0.086, 0.7], [0.088, 0.74], [0.072, 0.755], [0.064, 0.8], [0.072, 0.845],
    [0.062, 0.89], [0.042, 0.925], [0.047, 0.945], [0.033, 0.975], [0, 0.985]], seg)]);
}
function bollardStone(detail) {
  if (detail) return merge([B0(0.26, 0.52, 0.26, 0, 0.26, 0), lathe([[0.19, 0.52], [0, 0.61]], 4, { phi0: Math.PI / 4 })]);
  const post = xf(rbox(0.26, 0.52, 0.26, 0.028, 2), [0, 0.26, 0]);
  const cap = lathe([[0.19, 0.52], [0.19, 0.545], [0.12, 0.6], [0, 0.62]], 4, { phi0: Math.PI / 4 });
  return merge([post, cap]);
}

// ------------------------------------------------------------------ kiosk
/** Rectangular hip roof sitting on a w x d slab top at y0: a vertical lip, four sloped
 *  faces (flat shaded) up to a ridge along x at y0 + lip + rise. UVs in metres. */
function hipRoof(w, d, y0, lip, rise) {
  const pos = [], nor = [], uv = [], idx = [];
  const hw = w / 2, hd = d / 2, r = Math.max(0, hw - hd), yL = y0 + lip, yR = yL + rise;
  const face = (pts) => {
    // planar polygon, outward normal (away from the roof centre)
    const [a, b, c] = pts;
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const cen = pts.reduce((m, q) => m.add(q), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    if (n.dot(cen.clone().sub(V(0, y0, 0))) < 0) { n.negate(); pts = pts.slice().reverse(); }
    // uv: metres in the face plane (u horizontal, v up the slope)
    const ux = new THREE.Vector3(-n.z, 0, n.x).normalize(), vx = new THREE.Vector3().crossVectors(n, ux);
    const base = pos.length / 3;
    for (const q of pts) { pos.push(q.x, q.y, q.z); nor.push(n.x, n.y, n.z); uv.push(q.dot(ux), q.dot(vx)); }
    for (let i = 1; i < pts.length - 1; i++) idx.push(base, base + i, base + i + 1);
  };
  const C = [V(hw, 0, hd), V(-hw, 0, hd), V(-hw, 0, -hd), V(hw, 0, -hd)];
  for (let i = 0; i < 4; i++) { // lip
    const a = C[i], b = C[(i + 1) % 4];
    face([V(a.x, y0, a.z), V(b.x, y0, b.z), V(b.x, yL, b.z), V(a.x, yL, a.z)]);
  }
  const R0 = V(-r, yR, 0), R1 = V(r, yR, 0), at = (q) => V(q.x, yL, q.z);
  face([at(C[0]), at(C[1]), R0, R1]);     // front slope (+z)
  face([at(C[2]), at(C[3]), R1, R0]);     // back slope (-z)
  face([at(C[3]), at(C[0]), R1]);         // right hip (+x)
  face([at(C[1]), at(C[2]), R0]);         // left hip (-x)
  return makeGeo(pos, nor, uv, idx);
}

/** Magazines standing in a rack row: thin boxes (pages) with photographic covers, each
 *  slightly offset and turned, leaning back by `lean` about their bottom edge.
 *  Local frame: x along the row, y up, +z out of the rack; row base at the origin. */
function magazineRow(n, x0, x1, rng, pages, covers, lean = 0, { w = 0.21, h = 0.28 } = {}) {
  const step = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const x = x0 + step * (i + 0.5) + rng.range(-0.01, 0.01), yy = rng.range(0, 0.012), rot = rng.range(-0.04, 0.04);
    const t = rng.range(0.004, 0.012), k = rng.int(0, 14);
    const ww = w * rng.range(0.9, 1.05), hh = h * rng.range(0.88, 1.05);
    pages.push(xf(xf(rbox(ww, hh, t, 0), [0, hh / 2, -t / 2]), [x, yy, 0], [lean, 0, rot], 1, 'YXZ'));
    const c = quad(ww - 0.002, hh - 0.002, uvSub('covers', (k % 5) / 5 + 0.004, Math.floor(k / 5) / 3 + 0.004, (k % 5 + 1) / 5 - 0.004, (Math.floor(k / 5) + 1) / 3 - 0.004));
    covers.push(xf(xf(c, [0, hh / 2, 0.0015]), [x, yy, 0], [lean, 0, rot], 1, 'YXZ'));
  }
}

/** Kiosk (2.6 x 1.8 m): panelled steel body on a plinth, corner posts, a framed service
 *  hatch under its roll-up shutter box, a flip-up counter on brackets, a stocked interior
 *  (magazine shelves, bottles, a drinks cooler), a half-glazed side door, framed posters
 *  on the back, an outside magazine rack, gutters and a downpipe under a zinc hip roof,
 *  and a striped awning. Front = +Z (service hatch). */
function kiosk(detail) {
  const W = 2.6, D = 1.8, Y0 = 0.12, TOP = 2.46;
  if (detail >= 2) {
    return {
      paint: merge([B0(W, TOP - Y0, D, 0, (TOP + Y0) / 2, 0), B0(W + 0.4, 0.1, D + 0.4, 0, 2.52, 0)]),
      zinc: merge([hipRoof(W + 0.39, D + 0.39, 2.57, 0.03, 0.2)]),
      stone: merge([B0(W + 0.12, Y0, D + 0.12, 0, Y0 / 2, 0)]),
    };
  }
  const rng = RNG.from('kioskStock');
  const paint = [], dark = [], print = [], glass = [], stone = [], zinc = [], fabric = [], wood = [], pages = [], steel = [], lit = [];
  const R = (w, h, d, x, y, z, r = 0.006) => xf(rbox(w, h, d, r, 1), [x, y, z]);
  const LB = Y0 + 0.84;                       // top of the solid lower body
  const zF = D / 2 - 0.05, xS = W / 2 - 0.05; // lower body faces
  stone.push(R(W + 0.12, Y0, D + 0.12, 0, Y0 / 2, 0, 0.01));
  // carcass: corner posts, lower body, back wall, solid left side, header over the hatch
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) paint.push(R(0.09, TOP - Y0, 0.09, sx * (W / 2 - 0.045), (TOP + Y0) / 2, sz * (D / 2 - 0.045), 0.012));
  paint.push(R(W - 0.1, 0.84, D - 0.1, 0, Y0 + 0.42, 0, 0.004));
  paint.push(R(W - 0.1, TOP - LB, 0.04, 0, (TOP + LB) / 2, -D / 2 + 0.03, 0.004));
  paint.push(R(0.04, TOP - LB, D - 0.1, -W / 2 + 0.03, (TOP + LB) / 2, 0, 0.004));
  paint.push(R(W - 0.1, 0.52, 0.05, 0, 2.2, D / 2 - 0.03, 0.004));
  // raised panel mouldings on the lower body
  const frameRect = (w, h, cx, cy, plane, sgn) => {
    const t = 0.028, e = 0.014;
    for (const [bw, bh, bx, by] of [[w, t, 0, h / 2 - t / 2], [w, t, 0, -h / 2 + t / 2], [t, h - 2 * t, w / 2 - t / 2, 0], [t, h - 2 * t, -w / 2 + t / 2, 0]]) {
      if (plane === 'z') paint.push(R(bw, bh, e, cx + bx, cy + by, sgn * (zF + e / 2), 0.004));
      else paint.push(R(e, bh, bw, sgn * (xS + e / 2), cy + by, cx + bx, 0.004));
    }
  };
  for (let i = 0; i < 4; i++) for (const sz of [-1, 1]) frameRect(0.56, 0.6, -0.93 + i * 0.62, Y0 + 0.42, 'z', sz);
  for (let i = 0; i < 2; i++) for (const sx of [-1, 1]) frameRect(0.72, 0.6, -0.4 + i * 0.8, Y0 + 0.42, 'x', sx);
  paint.push(R(W - 0.06, 0.05, 0.06, 0, LB + 0.02, D / 2 - 0.02, 0.006));          // sill rail under the hatch
  // service hatch: frame, shutter box with guides, counter on brackets
  const hx = 2.2, hy0 = LB + 0.05, hy1 = 1.92;
  for (const sx of [-1, 1]) {
    paint.push(R(0.05, hy1 - hy0, 0.07, sx * (hx / 2 + 0.025), (hy0 + hy1) / 2, D / 2 - 0.02, 0.004));
    steel.push(R(0.025, hy1 - hy0, 0.035, sx * (hx / 2 - 0.012), (hy0 + hy1) / 2, D / 2 + 0.005, 0.002));
  }
  paint.push(R(hx + 0.1, 0.18, 0.16, 0, 2.03, D / 2 + 0.06, 0.012));                // shutter box
  steel.push(R(hx, 0.035, 0.012, 0, hy1 - 0.012, D / 2 + 0.008, 0.002));            // shutter bottom slat
  wood.push(R(2.1, 0.035, 0.34, 0, hy0 + 0.02, D / 2 + 0.12, 0.008));
  for (const x of [-0.85, 0, 0.85]) steel.push(bar([V(x, hy0, D / 2 + 0.26), V(x, hy0 - 0.24, D / 2 + 0.005)], 0.02, 0.008, { up: [1, 0, 0], r: 0.002, bend: 0 }));
  // interior: dark floor, ceiling and back lining; magazine shelves, bottles, a drinks cooler
  dark.push(R(W - 0.14, 0.02, D - 0.14, 0, hy0 - 0.03, 0, 0), R(W - 0.14, 0.02, D - 0.14, 0, TOP - 0.06, 0, 0));
  dark.push(R(W - 0.14, TOP - hy0, 0.02, 0, (TOP + hy0) / 2, -D / 2 + 0.06, 0));
  const covers = [];
  for (let r = 0; r < 3; r++) {
    const y = hy0 + 0.25 + r * 0.33;
    wood.push(R(1.5, 0.018, 0.24, -0.45, y - 0.01, -D / 2 + 0.19, 0.002));
    const rp = [], rc = [];
    magazineRow(7, -1.18, 0.28, rng, rp, rc, -0.12);
    for (const g of rp) pages.push(xf(g, [0, y, -D / 2 + 0.2]));
    for (const g of rc) covers.push(xf(g, [0, y, -D / 2 + 0.2]));
  }
  for (let r = 0; r < 2; r++) {
    const y = hy0 + 0.45 + r * 0.4;
    wood.push(R(0.6, 0.018, 0.3, 0.75, y - 0.01, -D / 2 + 0.2, 0.002));
    for (let i = 0; i < 6; i++) {
      const bx = 0.5 + i * 0.1 + rng.range(-0.01, 0.01), h = rng.range(0.2, 0.28);
      glass.push(xf(lathe([[0.032, 0], [0.032, h * 0.65], [0.012, h * 0.85], [0.012, h], [0, h]], 8), [bx, y, -D / 2 + 0.18 + rng.range(-0.04, 0.04)]));
    }
  }
  paint.push(R(0.6, 0.62, 0.45, 0.85, hy0 + 0.29, D / 2 - 0.45, 0.01));              // drinks cooler on the floor inside
  lit.push(xf(quad(0.5, 0.5, uvRect('cooler')), [0.85, hy0 + 0.3, D / 2 - 0.45 + 0.229]));
  // right side (+X): wall panels either side of a half-glazed door with a lever handle
  paint.push(R(0.04, TOP - LB, 0.62, W / 2 - 0.03, (TOP + LB) / 2, 0.53, 0.004), R(0.04, TOP - LB, 0.16, W / 2 - 0.03, (TOP + LB) / 2, -0.77, 0.004));
  glass.push(R(0.012, 1.0, 0.74, W / 2 - 0.045, LB + 0.6, -0.24, 0));
  for (const z of [0.17, -0.65]) paint.push(R(0.05, TOP - Y0 - 0.06, 0.06, W / 2 - 0.035, (TOP + Y0) / 2 - 0.03, z, 0.004));
  for (const y of [LB + 0.08, LB + 1.12, TOP - 0.08]) paint.push(R(0.05, 0.07, 0.86, W / 2 - 0.035, y, -0.24, 0.004));
  steel.push(tube([V(W / 2 - 0.005, LB - 0.05, 0.1), V(W / 2 + 0.04, LB - 0.05, 0.1), V(W / 2 + 0.04, LB - 0.05, -0.05)], 0.009, { radial: 6, bend: 0.02 }));
  steel.push(R(0.012, 0.07, 0.035, W / 2 - 0.015, LB - 0.12, 0.1, 0.003));
  for (const y of [Y0 + 0.3, TOP - 0.4]) steel.push(R(0.02, 0.09, 0.03, W / 2 - 0.005, y, -0.67, 0.004)); // hinges
  // roof: overhanging slab with fascia, half-round gutters with a downpipe, zinc hip roof
  paint.push(R(W + 0.4, 0.1, D + 0.4, 0, 2.52, 0, 0.015));
  paint.push(R(W + 0.44, 0.03, D + 0.44, 0, 2.465, 0, 0.004));
  for (const sz of [-1, 1]) zinc.push(xf(lathe([[0.045, 0], [0.045, W + 0.4], [0, W + 0.4]], 8, { phi0: 0, phiLen: Math.PI }), [-(W + 0.4) / 2, 2.55, sz * (D / 2 + 0.23)], [0, 0, -Math.PI / 2]));
  zinc.push(hipRoof(W + 0.39, D + 0.39, 2.57, 0.03, 0.2));     // on the slab, eaves flush with its edge
  zinc.push(xf(lathe([[0.03, 0], [0.03, 2.43], [0, 2.43]], 8), [-W / 2 - 0.15, 0.12, -D / 2 - 0.2]));
  // signs and posters: name band on the back, framed posters, menu on the left side
  const zb = -D / 2 + 0.01;                  // back wall face
  print.push(xf(quad(2.3, 0.3, uvRect('kioskBand')), [0, 2.27, zb - 0.003], [0, Math.PI, 0]));
  for (const [x, k] of [[-0.62, 'poster3'], [0.62, 'poster6']]) {
    print.push(xf(quad(0.98, 1.36, uvRect(k)), [x, 1.42, zb - 0.004], [0, Math.PI, 0]));
    steel.push(R(1.04, 0.025, 0.012, x, 1.42 + 0.69, zb - 0.006, 0.002), R(1.04, 0.025, 0.012, x, 1.42 - 0.69, zb - 0.006, 0.002));
    for (const dx of [-0.51, 0.51]) steel.push(R(0.025, 1.4, 0.012, x + dx, 1.42, zb - 0.006, 0.002));
  }
  print.push(xf(quad(1.5, 1.0, uvRect('kioskMenu')), [-W / 2 + 0.007, 1.8, 0], [0, -Math.PI / 2, 0]));
  // outside magazine rack against the left side: wire frame, three stepped rows
  {
    const rp = [], rc = [], rack = [], rw = 1.5;
    for (let r = 0; r < 3; r++) {
      const y = 0.35 + r * 0.25, z = 0.35 * (1 - y) - 0.02;
      const tp = [], tc = [];
      magazineRow(6, -rw / 2, rw / 2, rng, tp, tc, -0.26);
      for (const g of tp) rp.push(xf(g, [0, y, z]));
      for (const g of tc) rc.push(xf(g, [0, y, z]));
      rack.push(tube([V(-rw / 2, y + 0.005, z + 0.02), V(rw / 2, y + 0.005, z + 0.02)], 0.006, { radial: 5, bend: 0 }));
      rack.push(tube([V(-rw / 2, y + 0.13, z - 0.045), V(rw / 2, y + 0.13, z - 0.045)], 0.005, { radial: 5, bend: 0 }));
    }
    for (const x of [-rw / 2 - 0.01, rw / 2 + 0.01]) rack.push(tube([V(x, 0, 0.35), V(x, 1.0, 0.0), V(x, 1.05, -0.06)], 0.008, { radial: 6, bend: 0.03 }));
    // rack frame: x along the kiosk side, +z out of the left side (-X)
    const toSide = (g) => xf(g, [-W / 2 - 0.08, 0, 0], [0, -Math.PI / 2, 0]);
    steel.push(...rack.map(toSide)); pages.push(...rp.map(toSide)); covers.push(...rc.map(toSide));
  }
  print.push(...covers);
  // striped canvas awning off the roof fascia (stripes as vertex colours), hemmed valance
  const cA = srgb('#efe6cf'), cB = srgb('#2c5a44');
  const nS = 20, y0 = 2.4, y1 = 2.17, z0 = D / 2 + 0.16, z1 = D / 2 + 0.95, val = 0.17;
  for (let i = 0; i < nS; i++) {
    const xa = -1.25 + (2.5 * i) / nS, xb = -1.25 + (2.5 * (i + 1)) / nS, c = i % 2 ? cB : cA;
    const ym = (y0 + y1) / 2 - 0.012, zm = (z0 + z1) / 2;
    const P = [xa, y0, z0, xb, y0, z0, xa, ym, zm, xb, ym, zm, xa, y1, z1, xb, y1, z1,
      xa, y1, z1 + 0.003, xb, y1, z1 + 0.003, xa, y1 - val, z1 + 0.012, xb, y1 - val, z1 + 0.012];
    const n1 = [0, 0.95, 0.31];
    const N = [...n1, ...n1, ...n1, ...n1, ...n1, ...n1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    const UV = [xa, 0, xb, 0, xa, 0.42, xb, 0.42, xa, 0.84, xb, 0.84, xa, 0.84, xb, 0.84, xa, 1.01, xb, 1.01];
    const col = [];
    for (let k = 0; k < 10; k++) { const f = k >= 8 ? 0.82 : 1; col.push(c.r * f, c.g * f, c.b * f); }
    fabric.push(makeGeo(P, N, UV, [0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5, 6, 8, 7, 7, 8, 9], { color: { array: col, size: 3 } }));
  }
  for (const sx of [-1, 1]) steel.push(tube([V(sx * 1.24, 2.38, D / 2 + 0.03), V(sx * 1.24, y1 + 0.01, z1 - 0.02)], 0.008, { radial: 6, bend: 0 }));
  return {
    paint: merge(paint), dark: merge(dark), print: merge(print), glass: merge(glass), stone: merge(stone), zinc: merge(zinc), fabric: merge(fabric),
    wood: merge(wood), pages: merge(pages), steel: merge(steel), lit: merge(lit),
  };
}

// ------------------------------------------------------------------ advertising column
/** Advertising column: cast plinth, an old-paper ground with the current poster sheets
 *  pasted on it 2 mm proud (raised edges), a ribbed cornice and a domed cap with finial. */
function advertColumn(lod) {
  if (lod >= 2) {
    const band = COLUMN_TIERS.map(([y0, y1], tier) => cylPatch(0.562, 0, Math.PI * 2, y0, y1, uvSub('column', tier * 0.5, 0, tier * 0.5 + 0.5, 1), 8));
    return { iron: merge([lathe([[0.66, 0], [0.6, 0.3], [0.556, 0.33], [0.556, 2.57], [0.66, 2.7], [0.5, 2.95], [0.05, 3.19], [0, 3.33]], 8)]), band: merge(band), sheets: null, edges: null };
  }
  const seg = lod ? 16 : 48;
  const iron = lathe([[0.66, 0], [0.66, 0.08], [0.62, 0.12], [0.6, 0.24], [0.565, 0.3], [0.556, 0.33], [0.556, 0.355], [0.552, 0.36], [0.552, 2.54], [0.556, 2.545], [0.556, 2.57], [0.6, 2.6], [0.655, 2.65], [0.66, 2.72], [0.6, 2.76], [0.58, 2.8],
    [0.5, 2.95], [0.34, 3.08], [0.15, 3.16], [0.05, 3.19], [0.06, 3.23], [0.032, 3.31], [0, 3.33]], seg, { rmod: lod ? null : (ph, y) => (y > 2.8 && y < 3.17 ? 1 + 0.03 * Math.pow(Math.max(0, Math.cos(ph * 16)), 2) : 1), crease: 0.9 });
  // paper ground: two tiers, each mapped onto its own half of the column atlas region
  const r = 0.562, band = [], sheets = [], edges = [];
  COLUMN_TIERS.forEach(([y0, y1], tier) => {
    band.push(cylPatch(r, 0, Math.PI * 2, y0, y1, uvSub('column', tier * 0.5, 0, tier * 0.5 + 0.5, 1), seg));
    if (lod) return;
    for (const [f0, g0, f1, g1] of columnSheetRects(tier)) {
      const ph0 = f0 * Math.PI * 2, ph1 = f1 * Math.PI * 2, ya = y1 - g1 * (y1 - y0), yb = y1 - g0 * (y1 - y0);
      const n = Math.max(2, Math.ceil((ph1 - ph0) / (Math.PI * 2) * seg));
      sheets.push(cylPatch(r + 0.002, ph0, ph1, ya, yb, uvSub('column', tier * 0.5 + f0 * 0.5, g0, tier * 0.5 + f1 * 0.5, g1), n));
      // 2 mm paper edges: top and bottom rims, both sides
      for (const y of [ya, yb]) {
        const pos = [], nor = [], uv = [], idx = [];
        for (let i = 0; i <= n; i++) {
          const ph = ph0 + (ph1 - ph0) * (i / n), s = Math.sin(ph), c = Math.cos(ph);
          pos.push(s * r, y, c * r, s * (r + 0.002), y, c * (r + 0.002));
          const ny = y === yb ? 1 : -1;
          nor.push(0, ny, 0, 0, ny, 0); uv.push(0.5, 0.5, 0.5, 0.5);
          if (i < n) { const a = i * 2; if (ny > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
        }
        edges.push(makeGeo(pos, nor, uv, idx));
      }
      for (const [ph, sg] of [[ph0, -1], [ph1, 1]]) {
        const s = Math.sin(ph), c = Math.cos(ph), tx = c * sg, tz = -s * sg;
        edges.push(makeGeo([s * r, ya, c * r, s * (r + 0.002), ya, c * (r + 0.002), s * r, yb, c * r, s * (r + 0.002), yb, c * (r + 0.002)],
          [tx, 0, tz, tx, 0, tz, tx, 0, tz, tx, 0, tz], [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], sg > 0 ? [0, 1, 2, 1, 3, 2] : [0, 2, 1, 1, 2, 3]));
      }
    }
  });
  // small service door low on the column (its outline shows through the paper)
  const door = [];
  if (!lod) {
    for (const [a0, a1, y0, y1] of [[-0.3, 0.3, 0.38, 0.385], [-0.3, 0.3, 1.2, 1.205], [-0.3, -0.29, 0.38, 1.205], [0.29, 0.3, 0.38, 1.205]]) door.push(cylPatch(r + 0.0005, a0, a1, y0, y1, [0, 0, 1, 1], 6));
    door.push(xf(rbox(0.03, 0.03, 0.02, 0.004), [Math.sin(0.25) * 0.565, 0.8, Math.cos(0.25) * 0.565], [0, 0.25, 0]));
  }
  return { iron: merge([iron, ...door]), band: merge(band), sheets: sheets.length ? merge(sheets) : null, edges: edges.length ? merge(edges) : null };
}

// ------------------------------------------------------------------ bike rack / info board
function bikeRack(detail) {
  const hoops = [];
  for (let i = 0; i < 5; i++) {
    const x = -1.8 + i * 0.9;
    hoops.push(tube([V(x, 0, -0.36), V(x, 0.78, -0.36), V(x, 0.78, 0.36), V(x, 0, 0.36)], 0.024, { radial: [8, 5, 4][detail], bend: detail >= 2 ? 0.1 : 0.2, bendSegs: [4, 2, 1][detail], caps: detail < 2 }));
    if (!detail) for (const z of [-0.36, 0.36]) hoops.push(xf(lathe([[0.05, 0], [0.05, 0.008], [0.03, 0.016], [0.026, 0.03], [0, 0.03]], 10), [x, 0, z]));
  }
  return merge(hoops);
}

function infoBoard() {
  const frame = [], print = [], post = [];
  for (const sx of [-1, 1]) post.push(xf(rbox(0.08, 2.4, 0.08, 0.01), [sx * 0.69, 1.2, 0]));
  frame.push(xf(rbox(1.32, 1.78, 0.07, 0.012, 2), [0, 1.45, 0]));
  frame.push(xf(rbox(1.42, 0.05, 0.18, 0.01), [0, 2.385, 0]));
  for (const [side, rot] of [[1, 0], [-1, Math.PI]]) {
    print.push(xf(quad(1.18, 1.47, uvRect(side > 0 ? 'map0' : 'map1')), [0, 1.385, side * 0.0385], [0, rot, 0]));
    print.push(xf(quad(1.18, 0.148, uvRect('mapHead')), [0, 2.235, side * 0.0385], [0, rot, 0]));
  }
  return { frame: merge(frame), print: merge(print), post: merge(post) };
}

// ------------------------------------------------------------------ prototypes
export function buildStreetProtos(M, F) {
  const P = {};
  const bn = [bench(0), bench(1), bench(2)];
  P.bench = proto('bench', [{ geo: bn.map((b) => b.iron), mat: F.iron }, { geo: bn.map((b) => b.wood), mat: F.timber }], [30, 140]);
  const bh = [binHooded(0), binHooded(1), binHooded(2)];
  P.binHooded = proto('binHooded', [{ geo: bh.map((b) => b.body), mat: F.paint, tint: true }, { geo: bh.map((b) => b.liner), mat: F.rubber },
    { geo: bh.map((b) => b.trim), mat: F.rubber, cast: false }, { geo: bh.map((b) => b.decal), mat: F.print, cast: false }], [25, 110]);
  const bp = [binPost(0), binPost(1), binPost(2)];
  P.binPost = proto('binPost', [{ geo: bp.map((b) => b.body), mat: F.paint, tint: true }, { geo: bp.map((b) => b.liner), mat: F.rubber }], [25, 110]);
  P.bollardIron = proto('bollardIron', [{ geo: [bollardIron(16), bollardIron(8), bollardIron(5)], mat: F.iron }], [35, 120]);
  P.bollardStone = proto('bollardStone', [{ geo: [bollardStone(0), bollardStone(1)], mat: F.stone }], [60]);
  const k = [kiosk(0), kiosk(2)];
  P.kiosk = proto('kiosk', [{ geo: k.map((x) => x.paint), mat: F.paint, tint: true }, { geo: [k[0].dark, null], mat: F.interior }, { geo: [k[0].print, null], mat: F.print },
    { geo: [k[0].glass, null], mat: F.shelterGlass, cast: false }, { geo: k.map((x) => x.stone), mat: F.concrete }, { geo: k.map((x) => x.zinc), mat: F.pole },
    { geo: [k[0].fabric, null], mat: F.canopy }, { geo: [k[0].wood, null], mat: F.timber }, { geo: [k[0].pages, null], mat: F.pages },
    { geo: [k[0].steel, null], mat: F.galv }, { geo: [k[0].lit, null], mat: F.print, cast: false }], [90]);
  const c = [advertColumn(0), advertColumn(1), advertColumn(2)];
  P.column = proto('advertColumn', [{ geo: c.map((x) => x.iron), mat: F.paint, tint: true }, { geo: c.map((x) => x.band), mat: F.paper },
    { geo: c.map((x) => x.sheets), mat: F.paper, cast: false }, { geo: c.map((x) => x.edges), mat: F.pages, cast: false }], [40, 160]);
  P.bikeRack = proto('bikeRack', [{ geo: [bikeRack(0), bikeRack(1), bikeRack(2)], mat: F.galv }], [30, 110]);
  const ib = infoBoard();
  P.infoBoard = proto('infoBoard', [{ geo: ib.frame, mat: F.paint, tint: true }, { geo: ib.print, mat: F.print }, { geo: ib.post, mat: F.pole }]);
  return P;
}

const PAINT = {
  bin: ['#24302a', '#2a2c2e', '#3a3f3c'], binPost: ['#5d6266', '#4b5054', '#6b6f6a'],
  kiosk: ['#2e4a3b', '#3a3e41', '#d4cab3', '#5a2b2b'], column: ['#2f4a3c', '#2b2e30', '#3b4a5a'], board: ['#3a3f44', '#2f4a3c'],
};
const _m = new THREE.Matrix4(), _c = new THREE.Color();

/** Add the layout.furniture items of this chunk (except planters and platform fittings).
 *  Far chunks keep every item; its far level is a handful of triangles. */
export function placeStreetFurniture(chunk, app, inst, P) {
  const { route, layout } = app;
  for (const f of layout.inChunk('furniture', chunk.index)) {
    const rng = RNG.from(layout.seed, 'furn', f.id);
    const out = f.yaw + Math.PI / 2; // facing away from the tracks
    switch (f.type) {
      case 'bench':
        inst.add(P.bench, placeMatrix(route, f.s, f.d, 0, out + rng.range(-0.02, 0.02), _m, 0.9));
        break;
      case 'bin': {
        const hooded = rng.chance(0.55);
        inst.add(hooded ? P.binHooded : P.binPost, placeMatrix(route, f.s, f.d, 0, out + rng.range(-0.3, 0.3), _m, 0.22),
          _c.copy(srgb(rng.pick(hooded ? PAINT.bin : PAINT.binPost))).multiplyScalar(rng.range(0.9, 1.05)));
        break;
      }
      case 'bollard': {
        const cs = Math.round(f.s / 25) * 2 + (f.d > 0 ? 1 : 0); // one style per street mouth
        const stone = RNG.from(layout.seed, 'bollardStyle', cs).chance(0.35);
        inst.add(stone ? P.bollardStone : P.bollardIron, placeMatrix(route, f.s, f.d, 0, rng.range(0, 6.28), _m, 0.14));
        break;
      }
      case 'kiosk':
        inst.add(P.kiosk, placeMatrix(route, f.s, f.d, 0, out, _m, 1.6), _c.copy(srgb(rng.pick(PAINT.kiosk))));
        break;
      case 'advertColumn':
        inst.add(P.column, placeMatrix(route, f.s, f.d, 0, rng.range(0, 6.28), _m, 0.66), _c.copy(srgb(rng.pick(PAINT.column))));
        break;
      case 'bikeRack':
        inst.add(P.bikeRack, placeMatrix(route, f.s, f.d, 0, out, _m, 0.5));
        break;
      case 'infoBoard':
        inst.add(P.infoBoard, placeMatrix(route, f.s, f.d, 0, out + Math.PI / 2, _m, 0.5), _c.copy(srgb(rng.pick(PAINT.board))));
        break;
      default: break; // planters (vegetation) and platform fittings (platform.js)
    }
  }
}
