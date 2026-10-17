import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { TRACK_ZONE_HALF } from '../../core/config.js';

// Tram signals (white bar aspects in a black three-lens head on a bordered backboard) at
// the approach to every cross street, and two-aspect pedestrian lights at both ends of
// the crossing over the tracks. Two materials only: a vertex-coloured body (post, housing,
// visors, border, dark lenses) and one emissive atlas for every lit aspect; every part is
// instanced per chunk, so building a junction costs nothing on the CPU.
// Local frame: origin on the paving, +Y up, lenses face +Z.

const TRAM_POLE_H = 3.35;
const PED_POLE_H = 2.75;

// albedo (linear) of the body parts
const C_POST = [0.05, 0.053, 0.055], C_HOUSING = [0.022, 0.022, 0.022], C_BORDER = [0.62, 0.62, 0.58], C_LENS = [0.008, 0.008, 0.008];

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
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (CELL.white + 0.25 + uv.getX(i) * 0.5) / CELLS, 0.25 + uv.getY(i) * 0.5);
  g.translate(x, y, z);
  return g;
}

/** Shared signal geometries: {tramBody, tramGo, tramStop, pedBody, pedLit}. */
export function buildSignalKit() {
  const kit = {};
  // --- tram head: housing, backboard with white border, three visored lenses
  const body = [postGeometry(TRAM_POLE_H - 0.3)];
  const head = new RoundedBoxGeometry(0.3, 0.82, 0.14, 2, 0.025); head.translate(0, TRAM_POLE_H + 0.1, 0);
  body.push(colored(head, C_HOUSING));
  const board = new RoundedBoxGeometry(0.42, 0.94, 0.02, 2, 0.008); board.translate(0, TRAM_POLE_H + 0.1, -0.08);
  body.push(colored(board, C_HOUSING));
  const border = new RoundedBoxGeometry(0.47, 0.99, 0.012, 2, 0.005); border.translate(0, TRAM_POLE_H + 0.1, -0.093);
  body.push(colored(border, C_BORDER));
  const lensY = [TRAM_POLE_H + 0.36, TRAM_POLE_H + 0.1, TRAM_POLE_H - 0.16];
  for (const y of lensY) {
    const v = visor(0.105, 0.16); v.translate(0, y, 0.07); body.push(colored(v, C_HOUSING));
    const l = new THREE.CircleGeometry(0.095, 20); l.translate(0, y, 0.071); body.push(colored(l, C_LENS));
  }
  kit.tramBody = merge(body);
  // lit aspects: bottom vertical bar = proceed, top horizontal bar = stop
  kit.tramGo = merge([litBar(0.03, 0.14, 0, lensY[2], 0.073)]);
  kit.tramStop = merge([litBar(0.14, 0.03, 0, lensY[0], 0.073)]);

  // --- pedestrian head: two lenses (red standing figure lit, green walking dark)
  const pb = [postGeometry(PED_POLE_H - 0.23)];
  const ph = new RoundedBoxGeometry(0.26, 0.56, 0.15, 2, 0.02); ph.translate(0, PED_POLE_H + 0.05, 0);
  pb.push(colored(ph, C_HOUSING));
  const pedY = [PED_POLE_H + 0.18, PED_POLE_H - 0.08];
  for (const y of pedY) { const v = visor(0.1, 0.13); v.translate(0, y, 0.075); pb.push(colored(v, C_HOUSING)); }
  kit.pedBody = merge(pb);
  kit.pedLit = merge([litDisc(0.09, CELL.red, 0, pedY[0], 0.076), litDisc(0.09, CELL.green, 0, pedY[1], 0.076)]);
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
  man(S * CELL.green, true, '#021a0a'); // unlit aspect: only a faint trace
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  return t;
}

/** Placements for the signals of one cross street: [{kind, s, d, face}] with face the
 *  direction the lenses look towards ('back' = towards -s, 'fwd', 'left', 'right'). */
export function signalPlacements(c, layout) {
  const out = [];
  const dEdge = TRACK_ZONE_HALF + 0.38;
  const ci = layout.chunkIndex(c.s);
  const near = [...layout.inChunk('poles', ci - 1), ...layout.inChunk('poles', ci), ...layout.inChunk('poles', ci + 1)];
  const clearOfPoles = (s, d) => !near.some((p) => Math.sign(p.d) === Math.sign(d) && Math.abs(layout.route.delta(p.s, s)) < 1.4);
  const place = (s, d, kind, face) => {
    let ss = s;
    for (let k = 0; k < 4 && !clearOfPoles(ss, d); k++) ss += (face === 'back' ? -1.5 : 1.5);
    out.push({ kind, s: ss, d, face });
  };
  // tram signals before the junction for each direction of travel
  place(c.s - c.width / 2 - 3.5, +dEdge, 'tram', 'back');
  place(c.s + c.width / 2 + 3.5, -dEdge, 'tram', 'fwd');
  // pedestrian lights at both kerbs of the crossing, facing across the tracks
  place(c.s + 1.6, +dEdge, 'ped', 'left');
  place(c.s - 1.6, -dEdge, 'ped', 'right');
  return out;
}
