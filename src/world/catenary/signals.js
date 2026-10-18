import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TRACK_ZONE_HALF } from '../../core/config.js';

// Tram signals (a compact black square head with a white border and one lit white bar:
// vertical = proceed, horizontal = stop) at the approach to every cross street, mounted on
// the nearest catenary pole at about 3.2 m or, failing that, on a short post of their own;
// and two-aspect pedestrian lights at both ends of the crossing over the tracks: green
// walking figure while no tram is near, flashing green for a few seconds, then the red
// standing figure while a tram approaches or passes (see catenary.js: pedState).
// Two materials only: a vertex-coloured body (post, housing, visors, border, dark lenses)
// and one emissive atlas for every lit aspect; every part is instanced per chunk, so
// building a junction costs nothing on the CPU.
// Local frame: origin on the paving (or at the mount height for 'head' parts), +Y up,
// lenses face +Z.

const TRAM_HEAD_Y = 3.2;            // centre of the tram signal head above the paving
const PED_POLE_H = 2.75;
export const MOUNT_X = 0.3;         // pole axis to head centre (pole-mounted heads)

// albedo (linear) of the body parts
// (the white border is painted on the front of the backboard only: from behind a head is
// a dark grey powder-coated plate with its mounting bracket, never a white sign)
const C_POST = [0.08, 0.088, 0.088], C_HOUSING = [0.03, 0.031, 0.031], C_BACK = [0.05, 0.051, 0.05], C_BORDER = [0.62, 0.62, 0.58], C_LENS = [0.008, 0.008, 0.008];

// emissive atlas cells (u ranges): white bar, red standing figure, green walking figure
const CELL = { white: 0, red: 1, green: 2 };
const CELLS = 3;

function colored(g, c) {
  const x = g.index ? g.toNonIndexed() : g;
  const n = x.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(c, i * 3);
  x.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!x.attributes.uv) x.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return x;
}

function postGeometry(h) {
  const pts = [[0.075, 0], [0.075, 0.05], [0.062, 0.07], [0.05, 0.1], [0.046, h - 0.03], [0.05, h - 0.02], [0.04, h], [0.0, h + 0.005]];
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 14);
  return colored(g, C_POST);
}

function visor(r, depth) {
  // open half-cylinder hood over a lens (top half), axis along +Z
  const g = new THREE.CylinderGeometry(r, r, depth, 12, 1, true, -Math.PI / 2, Math.PI);
  g.rotateX(-Math.PI / 2); // the z > 0 half of the shell becomes the top half
  g.translate(0, 0, depth / 2);
  return g;
}

/** Lens disc with UVs mapped into an atlas cell. */
function litDisc(r, cell, x, y, z) {
  const g = new THREE.CircleGeometry(r, 20);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (cell + 0.5 + (p.getX(i) / r) * 0.5) / CELLS, 0.5 - (p.getY(i) / r) * 0.5);
  g.translate(x, y, z);
  return g;
}

function litBar(w, h, x, y, z) {
  // LED bar aspect, uv into the white cell
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (CELL.white + 0.25 + uv.getX(i) * 0.5) / CELLS, 0.25 + uv.getY(i) * 0.5);
  g.translate(x, y, z);
  return g;
}

/** Shared signal geometries: {tramHead, tramPost, tramMount, tramGo, tramStop, pedBody, pedRed, pedGreen}.
 *  Tram parts are in the head frame (origin on the paving below the head centre). */
export function buildSignalKit() {
  const kit = {};
  const y = TRAM_HEAD_Y;
  // --- tram head: housing, backboard with a white border painted on its front face,
  //     hooded aspect; behind the board a vertical mounting strap
  const head = new RoundedBoxGeometry(0.27, 0.27, 0.11, 2, 0.02); head.translate(0, y, 0);
  const board = new RoundedBoxGeometry(0.37, 0.37, 0.016, 2, 0.006); board.translate(0, y, -0.062);
  const frame = [];
  for (const [w, h, x, yy] of [[0.35, 0.022, 0, 0.164], [0.35, 0.022, 0, -0.164], [0.022, 0.306, 0.164, 0], [0.022, 0.306, -0.164, 0]]) {
    const b = new THREE.BoxGeometry(w, h, 0.003); b.translate(x, y + yy, -0.0525);
    frame.push(colored(b, C_BORDER));
  }
  const strap = new RoundedBoxGeometry(0.07, 0.3, 0.025, 2, 0.006); strap.translate(0, y, -0.082);
  const v = visor(0.115, 0.1); v.translate(0, y, 0.055);
  const lens = new THREE.CircleGeometry(0.105, 24); lens.translate(0, y, 0.056);
  kit.tramHead = merge([colored(head, C_HOUSING), colored(board, C_BACK), ...frame, colored(strap, C_BACK), colored(v, C_HOUSING), colored(lens, C_LENS)]);
  kit.tramPost = merge([postGeometry(y - 0.14)]);
  // pole mount: a short tube from the back of the head to a clamp band around the pole,
  // which stands MOUNT_X to the head's +X side
  const tube = new THREE.CylinderGeometry(0.022, 0.022, MOUNT_X - 0.16, 10); tube.rotateZ(Math.PI / 2); tube.translate(0.08 + (MOUNT_X - 0.16) / 2, y, -0.03);
  const band = new THREE.CylinderGeometry(0.1, 0.1, 0.07, 18, 1, true); band.translate(MOUNT_X, y, 0);
  const plate = new RoundedBoxGeometry(0.1, 0.16, 0.03, 2, 0.008); plate.translate(0.1, y, -0.04);
  kit.tramMount = merge([colored(tube, C_POST), colored(band, C_POST), colored(plate, C_POST)]);
  // lit aspects (one bar each, inside the hood)
  kit.tramGo = merge([litBar(0.034, 0.17, 0, y, 0.058)]);
  kit.tramStop = merge([litBar(0.17, 0.034, 0, y, 0.058)]);

  // --- pedestrian head: two lenses (red standing figure lit, green walking dark)
  const pb = [postGeometry(PED_POLE_H - 0.23)];
  const ph = new RoundedBoxGeometry(0.26, 0.56, 0.15, 2, 0.02); ph.translate(0, PED_POLE_H + 0.05, 0);
  pb.push(colored(ph, C_HOUSING));
  const pedY = [PED_POLE_H + 0.18, PED_POLE_H - 0.08];
  for (const yy of pedY) { const vv = visor(0.1, 0.13); vv.translate(0, yy, 0.075); pb.push(colored(vv, C_HOUSING)); }
  kit.pedBody = merge(pb);
  // the two aspects are separate instances: their brightness (instance colour) follows
  // the crossing's state; a dark aspect still shows a faint trace of its figure
  kit.pedRed = merge([litDisc(0.09, CELL.red, 0, pedY[0], 0.076)]);
  kit.pedGreen = merge([litDisc(0.09, CELL.green, 0, pedY[1], 0.076)]);
  for (const k of Object.keys(kit)) kit[k].userData.shared = true;
  return kit;
}

function merge(list) {
  const geoms = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = geoms.reduce((n, g) => n + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]]) {
    if (!geoms.every((g) => g.attributes[name])) continue;
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const g of geoms) { arr.set(g.attributes[name].array, o * size); o += g.attributes.position.count; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

/** Emissive atlas for lit aspects: [white | red standing figure | green walking figure]. */
export function buildAspectAtlas() {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = S * CELLS; cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, S);
  // LED bar: bright core with a slightly softer rim
  const grad = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
  grad.addColorStop(0, '#fffaf0'); grad.addColorStop(0.7, '#fff3dc'); grad.addColorStop(1, '#d9cdb4');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  const man = (x0, walking, color) => {
    const cx = x0 + S / 2;
    g.fillStyle = color; g.strokeStyle = color; g.lineCap = 'round';
    g.beginPath(); g.arc(cx, 13, 5.5, 0, Math.PI * 2); g.fill();
    g.lineWidth = 7; g.beginPath(); g.moveTo(cx, 22); g.lineTo(cx, 38); g.stroke();
    g.lineWidth = 5;
    if (walking) {
      g.beginPath(); g.moveTo(cx, 38); g.lineTo(cx - 9, 54); g.moveTo(cx, 38); g.lineTo(cx + 8, 53); g.stroke();
      g.beginPath(); g.moveTo(cx, 25); g.lineTo(cx - 9, 35); g.moveTo(cx, 25); g.lineTo(cx + 9, 33); g.stroke();
    } else {
      g.beginPath(); g.moveTo(cx - 3, 38); g.lineTo(cx - 3, 55); g.moveTo(cx + 3, 38); g.lineTo(cx + 3, 55); g.stroke();
      g.beginPath(); g.moveTo(cx - 6, 24); g.lineTo(cx - 7, 38); g.moveTo(cx + 6, 24); g.lineTo(cx + 7, 38); g.stroke();
    }
  };
  man(S * CELL.red, false, '#ff3818');
  man(S * CELL.green, true, '#28f0a0'); // LED walking figure, blue-green
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  return t;
}

/** Placements for the signals of one cross street: [{kind, s, d, face, pole?}] with face
 *  the direction the lenses look towards ('back' = towards -s, 'fwd', 'left', 'right').
 *  Tram heads go on the nearest catenary pole on their side within 6 m before the
 *  junction (pole = that rendered pole); otherwise on their own post, kept clear of the
 *  street-tree crowns and of the poles. */
export function signalPlacements(c, layout, poles) {
  const out = [];
  const route = layout.route;
  const dEdge = TRACK_ZONE_HALF + 0.38;
  const ci = layout.chunkIndex(c.s);
  const near = [...poles(ci - 1), ...poles(ci), ...poles(ci + 1)];
  const trees = [...layout.inChunk('trees', ci - 1), ...layout.inChunk('trees', ci), ...layout.inChunk('trees', ci + 1)];
  const clear = (s, d) => !near.some((p) => Math.sign(p.d) === Math.sign(d) && Math.abs(route.delta(p.s, s)) < 1.4)
    && !trees.some((t) => Math.sign(t.d) === Math.sign(d) && Math.abs(route.delta(t.s, s)) < t.crown * 0.5 + 0.5);
  const place = (s, d, kind, face) => {
    let ss = s;
    for (let k = 0; k < 6 && !clear(ss, d); k++) {
      ss = face === 'back' ? s - 1.2 * (k + 1) : face === 'fwd' ? s + 1.2 * (k + 1) : s + (k % 2 ? -1 : 1) * 0.6 * (k + 1);
    }
    out.push({ kind, s: ss, d, face });
  };
  // tram signals before the junction for each direction of travel
  for (const [dir, side, face] of [[-1, +1, 'back'], [+1, -1, 'fwd']]) {
    const sIdeal = c.s + dir * (c.width / 2 + 3.5);
    let best = null, bestD = 6;
    for (const p of near) {
      if (Math.sign(p.d) !== side) continue;
      const off = route.delta(sIdeal, p.s) * dir; // > 0: pole further from the junction
      if (off > -2.5 && off < 6 && Math.abs(off) < bestD) { best = p; bestD = Math.abs(off); }
    }
    if (best) out.push({ kind: 'tram', s: best.s, d: best.d, face, pole: best });
    else place(sIdeal, side * dEdge, 'tram', face);
  }
  // pedestrian lights at both kerbs of the crossing, facing across the tracks
  place(c.s + 1.6, +dEdge, 'ped', 'left');
  place(c.s - 1.6, -dEdge, 'ped', 'right');
  return out;
}
