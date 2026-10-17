import * as THREE from 'three';
import { RNG } from '../../core/rng.js';
import { lathe, tube, bar, rbox, xf, merge, makeGeo, quad } from './kit.js';
import { proto, placeMatrix } from './instancer.js';
import { uvRect } from './prints.js';

// Street furniture from layout.furniture: cast-iron benches with timber slats, litter
// bins, bollards, newspaper / coffee kiosks, advertising columns, bike racks and city
// map boards. Authoring frame: +Y up, +Z front, origin on the paving.

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const srgb = (h) => new THREE.Color().setStyle(h, THREE.SRGBColorSpace);

// ------------------------------------------------------------------ bench
function benchEnd(x) {
  // cast-iron end frame: swept bars in the YZ plane, 35 mm thick
  const b = (pts, w = 0.034, h = 0.042) => bar(pts.map(([z, y]) => V(x, y, z)), w, h, { up: [1, 0, 0], r: 0.008, bend: 0.06, bendSegs: 3 });
  const parts = [
    b([[0.21, 0], [0.2, 0.2], [0.185, 0.42]]),                        // front leg
    b([[-0.26, 0], [-0.22, 0.2], [-0.19, 0.4]]),                      // rear leg
    b([[0.235, 0.43], [0.05, 0.415], [-0.19, 0.4], [-0.22, 0.55], [-0.265, 0.84]], 0.034, 0.05), // seat rail into back support
    b([[-0.215, 0.63], [0.0, 0.64], [0.19, 0.625]], 0.034, 0.05),     // armrest
    b([[0.185, 0.42], [0.2, 0.52], [0.19, 0.6]], 0.03, 0.036),         // arm post
  ];
  // scroll curl at the armrest end
  const curl = [];
  for (let i = 0; i <= 14; i++) {
    const a = (i / 14) * Math.PI * 1.7, r = 0.055 * (1 - i / 22);
    curl.push(V(x, 0.575 + Math.cos(a) * r, 0.19 + Math.sin(a) * r));
  }
  parts.push(tube(curl, 0.016, { radial: 6, bend: 0 }));
  // feet pads
  parts.push(xf(rbox(0.06, 0.02, 0.07, 0.004), [x, 0.01, 0.21]), xf(rbox(0.06, 0.02, 0.07, 0.004), [x, 0.01, -0.26]));
  return parts;
}

function bench(lod) {
  const L = 1.8;
  if (lod) {
    const B = (w, h, d, x, y, z, rx = 0) => xf(rbox(w, h, d, 0), [x, y, z], [rx, 0, 0]);
    return {
      iron: merge([B(0.04, 0.62, 0.45, -0.82, 0.31, 0), B(0.04, 0.62, 0.45, 0.82, 0.31, 0)]),
      wood: merge([B(L, 0.035, 0.42, 0, 0.43, 0), B(L, 0.3, 0.035, 0, 0.65, -0.235, -0.25)]),
    };
  }
  const iron = [...benchEnd(-L / 2 + 0.08), ...benchEnd(L / 2 - 0.08)];
  const wood = [];
  const seat = [[0.215, 0.425], [0.135, 0.437], [0.055, 0.44], [-0.025, 0.437], [-0.105, 0.43], [-0.18, 0.42]];
  for (const [z, y] of seat) wood.push(xf(rbox(L, 0.032, 0.068, 0.007, 2), [0, y + 0.016, z]));
  for (let i = 0; i < 3; i++) {
    const t = 0.32 + i * 0.27;
    const z = -0.2 - 0.06 * t, y = 0.45 + 0.38 * t;
    wood.push(xf(rbox(L, 0.075, 0.03, 0.007, 2), [0, y, z + 0.022], [-0.25, 0, 0]));
  }
  return { iron: merge(iron), wood: merge(wood) };
}

// ------------------------------------------------------------------ bins
function binHooded() {
  const flutes = (ph, y) => (y > 0.13 && y < 0.72 ? 1 + 0.03 * Math.max(0, Math.cos(ph * 18)) : 1);
  const body = lathe([[0.265, 0], [0.265, 0.045], [0.24, 0.065], [0.225, 0.1], [0.225, 0.13], [0.218, 0.72], [0.235, 0.74], [0.24, 0.79], [0.226, 0.81], [0.2, 0.812]], 36, { rmod: flutes });
  const hood = lathe([[0.2, 0.872], [0.245, 0.874], [0.25, 0.9], [0.238, 0.95], [0.17, 0.995], [0.07, 1.025], [0.035, 1.035], [0.04, 1.055], [0.028, 1.075], [0, 1.08]], 28);
  const posts = [0, 1, 2].map((k) => xf(rbox(0.025, 0.07, 0.02, 0.004), [Math.sin(k * 2.094) * 0.21, 0.842, Math.cos(k * 2.094) * 0.21], [0, k * 2.094, 0]));
  const liner = lathe([[0.198, 0.35], [0.198, 0.85], [0.185, 0.86], [0.0, 0.8]], 20);
  return { body: merge([body, hood, ...posts]), liner: merge([liner]) };
}

function binPost() {
  const body = xf(rbox(0.42, 0.6, 0.3, 0.035, 2), [0, 0.62, 0.05]);
  const lid = xf(rbox(0.44, 0.05, 0.32, 0.015, 2), [0, 0.945, 0.05]);
  const post = lathe([[0.04, 0], [0.04, 1.0], [0.032, 1.01], [0, 1.01]], 12);
  xf(post, [0, 0, -0.14]);
  const slot = xf(rbox(0.3, 0.08, 0.02, 0.01), [0, 0.82, 0.205]);
  return { body: merge([body, lid, post]), liner: merge([slot]) };
}

// ------------------------------------------------------------------ bollards
function bollardIron() {
  return merge([lathe([[0.12, 0], [0.12, 0.02], [0.1, 0.04], [0.086, 0.09], [0.076, 0.68], [0.086, 0.7], [0.088, 0.74], [0.072, 0.755], [0.064, 0.8], [0.072, 0.845],
    [0.062, 0.89], [0.042, 0.925], [0.047, 0.945], [0.033, 0.975], [0, 0.985]], 16)]);
}
function bollardStone() {
  const post = xf(rbox(0.26, 0.52, 0.26, 0.028, 2), [0, 0.26, 0]);
  const cap = lathe([[0.19, 0.52], [0.19, 0.545], [0.12, 0.6], [0, 0.62]], 4, { phi0: Math.PI / 4 });
  return merge([post, cap]);
}

// ------------------------------------------------------------------ kiosk
function kiosk() {
  const W = 2.6, D = 1.8, paint = [], dark = [], print = [], glass = [], stone = [], zinc = [], fabric = [], wood = [];
  stone.push(xf(rbox(W + 0.12, 0.12, D + 0.12, 0.01), [0, 0.06, 0]));
  paint.push(xf(rbox(W, 0.85, D, 0.012, 2), [0, 0.12 + 0.425, 0]));               // lower body
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) paint.push(xf(rbox(0.09, 1.5, 0.09, 0.01), [sx * (W / 2 - 0.045), 1.72, sz * (D / 2 - 0.045)]));
  paint.push(xf(rbox(W, 1.5, 0.05, 0.008), [0, 1.72, -D / 2 + 0.025]));             // back wall
  paint.push(xf(rbox(0.05, 1.5, D, 0.008), [-W / 2 + 0.025, 1.72, 0]));              // solid side (magazines)
  paint.push(xf(rbox(W, 0.36, 0.06, 0.008), [0, 2.29, D / 2 - 0.03]));               // header over the hatch
  paint.push(xf(rbox(W + 0.4, 0.12, D + 0.4, 0.02), [0, 2.53, 0]));                  // roof slab
  for (let i = 0; i < 4; i++) paint.push(xf(rbox(0.6, 0.6, 0.012, 0.004), [-0.96 + i * 0.64, 0.55, D / 2 + 0.006])); // panel mouldings
  zinc.push(lathe([[1.62, 2.59], [1.62, 2.61], [0.25, 2.8], [0, 2.82]], 4, { phi0: Math.PI / 4 }));
  // right side: glazed upper part
  glass.push(xf(rbox(0.012, 1.1, D - 0.2, 0), [W / 2 - 0.03, 1.55, 0]));
  // hatch: counter, dark interior with stocked shelves
  wood.push(xf(rbox(2.1, 0.04, 0.34, 0.008), [0, 0.99, D / 2 + 0.08]));
  dark.push(xf(rbox(W - 0.12, 0.02, D - 0.12, 0), [0, 0.97, 0]));
  const shelvesQ = quad(2.3, 0.8, uvRect('magazines'));
  print.push(xf(shelvesQ, [0, 1.55, -D / 2 + 0.06]));
  // signs, posters, magazine rack outside
  print.push(xf(quad(2.3, 0.3, uvRect('kioskBand')), [0, 2.29, D / 2 + 0.002]));
  print.push(xf(quad(2.3, 0.3, uvRect('kioskBand')), [0, 2.29, -D / 2 - 0.002], [0, Math.PI, 0]));
  print.push(xf(quad(1.0, 1.4, uvRect('poster3')), [-0.6, 1.5, -D / 2 - 0.002], [0, Math.PI, 0]));
  print.push(xf(quad(1.0, 1.4, uvRect('poster6')), [0.6, 1.5, -D / 2 - 0.002], [0, Math.PI, 0]));
  print.push(xf(quad(1.5, 1.0, uvRect('kioskMenu')), [-W / 2 - 0.002, 1.75, 0], [0, -Math.PI / 2, 0]));
  print.push(xf(quad(1.4, 0.7, uvRect('magazines')), [-W / 2 - 0.09, 0.95, 0], [-0.25, -Math.PI / 2, 0]));
  dark.push(xf(rbox(0.06, 0.75, 1.5, 0.004), [-W / 2 - 0.05, 0.86, 0]));            // rack box
  // awning over the hatch
  const aw = makeGeo([-1.25, 2.1, D / 2 + 0.01, 1.25, 2.1, D / 2 + 0.01, -1.25, 1.88, D / 2 + 0.75, 1.25, 1.88, D / 2 + 0.75],
    [0, 0.95, 0.3, 0, 0.95, 0.3, 0, 0.95, 0.3, 0, 0.95, 0.3], [-1.25, 0, 1.25, 0, -1.25, 0.78, 1.25, 0.78], [0, 2, 1, 1, 2, 3]);
  const val = xf(rbox(2.5, 0.2, 0.01, 0), [0, 1.78, D / 2 + 0.755]);
  fabric.push(aw, val);
  return { paint: merge(paint), dark: merge(dark), print: merge(print), glass: merge(glass), stone: merge(stone), zinc: merge(zinc), fabric: merge(fabric), wood: merge(wood) };
}

// ------------------------------------------------------------------ advertising column
function advertColumn(variant, lod) {
  const seg = lod ? 12 : 40;
  const iron = lathe([[0.66, 0], [0.66, 0.08], [0.62, 0.12], [0.6, 0.24], [0.565, 0.3], [0.556, 0.33], [0.556, 2.57], [0.6, 2.6], [0.655, 2.65], [0.66, 2.72], [0.6, 2.76], [0.58, 2.8],
    [0.5, 2.95], [0.34, 3.08], [0.15, 3.16], [0.05, 3.19], [0.06, 3.23], [0.032, 3.31], [0, 3.33]], seg, { rmod: lod ? null : (ph, y) => (y > 2.8 && y < 3.17 ? 1 + 0.02 * Math.cos(ph * 16) : 1) });
  // poster band with atlas UVs (u around, v up)
  const [u0, v0, u1, v1] = uvRect(`column${variant}`);
  const pos = [], nor = [], uv = [], idx = [], r = 0.562, y0 = 0.36, y1 = 2.54;
  for (let i = 0; i <= seg; i++) {
    const ph = (i / seg) * Math.PI * 2, s = Math.sin(ph), c = Math.cos(ph);
    for (const [y, v] of [[y0, v0], [y1, v1]]) { pos.push(s * r, y, c * r); nor.push(s, 0, c); uv.push(u0 + (u1 - u0) * (i / seg), v); }
  }
  for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
  return { iron: merge([iron]), band: merge([makeGeo(pos, nor, uv, idx)]) };
}

// ------------------------------------------------------------------ bike rack / info board
function bikeRack() {
  const hoops = [];
  for (let i = 0; i < 5; i++) {
    const x = -1.8 + i * 0.9;
    hoops.push(tube([V(x, 0, -0.36), V(x, 0.78, -0.36), V(x, 0.78, 0.36), V(x, 0, 0.36)], 0.024, { radial: 8, bend: 0.2, bendSegs: 6 }));
    for (const z of [-0.36, 0.36]) hoops.push(xf(lathe([[0.05, 0], [0.05, 0.008], [0.03, 0.016], [0.026, 0.03], [0, 0.03]], 10), [x, 0, z]));
  }
  return merge(hoops);
}

function infoBoard() {
  const frame = [], print = [], post = [];
  for (const sx of [-1, 1]) post.push(xf(rbox(0.08, 2.4, 0.08, 0.01), [sx * 0.69, 1.2, 0]));
  frame.push(xf(rbox(1.32, 1.78, 0.07, 0.012, 2), [0, 1.45, 0]));
  frame.push(xf(rbox(1.42, 0.05, 0.18, 0.01), [0, 2.385, 0]));
  for (const [side, rot] of [[1, 0], [-1, Math.PI]]) {
    print.push(xf(quad(1.18, 1.47, uvRect(side > 0 ? 'map0' : 'map1')), [0, 1.385, side * 0.0365], [0, rot, 0]));
    print.push(xf(quad(1.18, 0.148, uvRect('mapHead')), [0, 2.235, side * 0.0365], [0, rot, 0]));
  }
  return { frame: merge(frame), print: merge(print), post: merge(post) };
}

// ------------------------------------------------------------------ prototypes
export function buildStreetProtos(M, F) {
  const P = {};
  const iron = M.get('metal.iron'), pole = M.get('metal.pole');
  for (const lod of [0, 1]) {
    const b = bench(lod);
    P[`bench${lod}`] = proto('bench', [{ geo: b.iron, mat: iron }, { geo: b.wood, mat: M.get('wood.bench') }]);
  }
  const bh = binHooded(), bp = binPost();
  P.binHooded = proto('binHooded', [{ geo: bh.body, mat: F.paint, tint: true }, { geo: bh.liner, mat: M.get('rubber') }]);
  P.binPost = proto('binPost', [{ geo: bp.body, mat: F.paint, tint: true }, { geo: bp.liner, mat: M.get('rubber') }]);
  P.bollardIron = proto('bollardIron', [{ geo: bollardIron(), mat: iron }]);
  P.bollardStone = proto('bollardStone', [{ geo: bollardStone(), mat: M.get('stone.smooth') }]);
  const k = kiosk();
  P.kiosk = proto('kiosk', [{ geo: k.paint, mat: F.paint, tint: true }, { geo: k.dark, mat: M.get('rubber') }, { geo: k.print, mat: F.print }, { geo: k.glass, mat: F.glass, cast: false },
    { geo: k.stone, mat: M.get('concrete') }, { geo: k.zinc, mat: pole }, { geo: k.fabric, mat: F.canopy, tint: true }, { geo: k.wood, mat: M.get('wood.bench') }]);
  for (const lod of [0, 1]) for (const v of [0, 1]) {
    const c = advertColumn(v, lod);
    P[`column${v}_${lod}`] = proto('advertColumn', [{ geo: c.iron, mat: F.paint, tint: true }, { geo: c.band, mat: F.print }]);
  }
  P.bikeRack = proto('bikeRack', [{ geo: bikeRack(), mat: M.get('metal.galvanized') }]);
  const ib = infoBoard();
  P.infoBoard = proto('infoBoard', [{ geo: ib.frame, mat: F.paint, tint: true }, { geo: ib.print, mat: F.print }, { geo: ib.post, mat: pole }]);
  return P;
}

const PAINT = {
  bin: ['#24302a', '#2a2c2e', '#3a3f3c'], binPost: ['#5d6266', '#4b5054', '#6b6f6a'],
  kiosk: ['#2e4a3b', '#3a3e41', '#d4cab3', '#5a2b2b'], column: ['#2f4a3c', '#2b2e30', '#3b4a5a'], board: ['#3a3f44', '#2f4a3c'],
};
const _m = new THREE.Matrix4(), _c = new THREE.Color();

/** Add the layout.furniture items of this chunk (except planters and platform fittings). */
export function placeStreetFurniture(chunk, app, inst, P) {
  const { route, layout } = app;
  const lod = chunk.lod;
  for (const f of layout.inChunk('furniture', chunk.index)) {
    const rng = RNG.from(layout.seed, 'furn', f.id);
    const out = f.yaw + Math.PI / 2; // facing away from the tracks
    switch (f.type) {
      case 'bench':
        inst.add(P[`bench${lod}`], placeMatrix(route, f.s, f.d, 0, out + rng.range(-0.02, 0.02), _m));
        break;
      case 'bin': {
        if (lod) break;
        const hooded = rng.chance(0.55);
        inst.add(hooded ? P.binHooded : P.binPost, placeMatrix(route, f.s, f.d, 0, out + rng.range(-0.3, 0.3), _m),
          _c.copy(srgb(rng.pick(hooded ? PAINT.bin : PAINT.binPost))).multiplyScalar(rng.range(0.9, 1.05)));
        break;
      }
      case 'bollard': {
        if (lod) break;
        const cs = Math.round(f.s / 25) * 2 + (f.d > 0 ? 1 : 0); // one style per street mouth
        const stone = RNG.from(layout.seed, 'bollardStyle', cs).chance(0.35);
        inst.add(stone ? P.bollardStone : P.bollardIron, placeMatrix(route, f.s, f.d, 0, rng.range(0, 6.28), _m));
        break;
      }
      case 'kiosk':
        inst.add(P.kiosk, placeMatrix(route, f.s, f.d, 0, out, _m), _c.copy(srgb(rng.pick(PAINT.kiosk))));
        break;
      case 'advertColumn':
        inst.add(P[`column${rng.int(0, 1)}_${lod}`], placeMatrix(route, f.s, f.d, 0, rng.range(0, 6.28), _m), _c.copy(srgb(rng.pick(PAINT.column))));
        break;
      case 'bikeRack':
        if (!lod) inst.add(P.bikeRack, placeMatrix(route, f.s, f.d, 0, out, _m));
        break;
      case 'infoBoard':
        inst.add(P.infoBoard, placeMatrix(route, f.s, f.d, 0, out + Math.PI / 2, _m), _c.copy(srgb(rng.pick(PAINT.board))));
        break;
      default: break; // planters (vegetation) and platform fittings (platform.js)
    }
  }
}
