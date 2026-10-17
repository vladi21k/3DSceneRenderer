import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GeoBuilder, lathe } from './geo.js';
import { TRACK_ZONE_HALF } from '../../core/config.js';

// Tram signals (white bar aspects in a black three-lens head) at the approach to every
// cross street, and two-aspect pedestrian lights at both ends of the crossing over the
// tracks. Geometry is shared; each chunk merges its few signals per material.
// Local frame of a signal: origin at the paving, +Y up, the lenses face +Z.

const TRAM_POLE_H = 3.35;
const PED_POLE_H = 2.75;

function postGeometry(h) {
  const b = new GeoBuilder();
  lathe(b, [[0.075, 0], [0.075, 0.05, true], [0.062, 0.07, true], [0.05, 0.1], [0.046, h - 0.03, true], [0.05, h - 0.02], [0.04, h], [0.0, h + 0.005]], 16);
  return b.toGeometry((x, y) => { const g = 0.6 + 0.4 * THREE.MathUtils.smoothstep(y, 0, 0.15); return [g, g, g]; });
}

function visor(r, depth) {
  // open half-cylinder hood over a lens (top half), axis along +Z
  const g = new THREE.CylinderGeometry(r, r, depth, 12, 1, true, -Math.PI / 2, Math.PI);
  g.rotateX(-Math.PI / 2); // the z > 0 half of the shell becomes the top half
  g.translate(0, 0, depth / 2);
  return g;
}

/** Shared signal geometries. */
export function buildSignalKit() {
  const kit = {};
  const housing = [], lensDark = [], lensLit = {};
  // --- tram head: 0.3 x 0.82 housing, three lenses
  const th = new RoundedBoxGeometry(0.3, 0.82, 0.14, 3, 0.025);
  th.translate(0, TRAM_POLE_H + 0.1, 0.0);
  housing.push(th);
  const bp = new RoundedBoxGeometry(0.42, 0.94, 0.02, 2, 0.008); // backboard
  bp.translate(0, TRAM_POLE_H + 0.1, -0.08);
  housing.push(bp);
  // white contrast border around the backboard
  const border = new RoundedBoxGeometry(0.47, 0.99, 0.012, 2, 0.005);
  border.translate(0, TRAM_POLE_H + 0.1, -0.093);
  kit.tramBorder = merge([border]);
  const lensY = [TRAM_POLE_H + 0.36, TRAM_POLE_H + 0.1, TRAM_POLE_H - 0.16];
  for (const y of lensY) {
    const v = visor(0.105, 0.16); v.translate(0, y, 0.07); housing.push(v);
    const l = new THREE.CircleGeometry(0.095, 20); l.translate(0, y, 0.071); lensDark.push(l);
  }
  // lit aspects (white bars): top = stop (horizontal), bottom = proceed (vertical)
  const hb = new THREE.PlaneGeometry(0.14, 0.03); hb.translate(0, lensY[0], 0.073);
  const vb = new THREE.PlaneGeometry(0.03, 0.14); vb.translate(0, lensY[2], 0.073);
  lensLit.stop = hb; lensLit.go = vb;
  kit.tramPost = postGeometry(TRAM_POLE_H - 0.3);
  kit.tramHousing = merge(housing);
  kit.tramLens = merge(lensDark);
  kit.tramStop = lensLit.stop; kit.tramGo = lensLit.go;

  // --- pedestrian head: two lenses
  const ph = new RoundedBoxGeometry(0.26, 0.56, 0.15, 3, 0.02);
  ph.translate(0, PED_POLE_H + 0.05, 0);
  const pv = [ph];
  const pl = [];
  const pedY = [PED_POLE_H + 0.18, PED_POLE_H - 0.08];
  for (const y of pedY) {
    const v = visor(0.1, 0.13); v.translate(0, y, 0.075); pv.push(v);
    const l = new THREE.CircleGeometry(0.09, 20); l.translate(0, y, 0.076); pl.push(l);
  }
  kit.pedPost = postGeometry(PED_POLE_H - 0.23);
  kit.pedHousing = merge(pv);
  kit.pedLensRed = pl[0];
  kit.pedLensGreen = pl[1];
  for (const k of Object.keys(kit)) kit[k].userData.shared = true;
  return kit;
}

function merge(list) {
  const geoms = list.map((g) => { const x = g.index ? g.toNonIndexed() : g; x.deleteAttribute('uv'); return x; });
  const total = geoms.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

/** Walking / standing figure icons for the pedestrian lenses (emissive maps). */
export function buildPedIconTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 128, 64);
  const man = (cx, walking) => {
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(cx, 13, 5.5, 0, Math.PI * 2); g.fill();
    g.lineCap = 'round'; g.strokeStyle = '#fff'; g.lineWidth = 7;
    g.beginPath(); g.moveTo(cx, 22); g.lineTo(cx, 38); g.stroke();
    g.lineWidth = 5;
    if (walking) {
      g.beginPath(); g.moveTo(cx, 38); g.lineTo(cx - 9, 54); g.moveTo(cx, 38); g.lineTo(cx + 8, 53); g.stroke();
      g.beginPath(); g.moveTo(cx, 25); g.lineTo(cx - 9, 35); g.moveTo(cx, 25); g.lineTo(cx + 9, 33); g.stroke();
    } else {
      g.beginPath(); g.moveTo(cx - 3, 38); g.lineTo(cx - 3, 55); g.moveTo(cx + 3, 38); g.lineTo(cx + 3, 55); g.stroke();
      g.beginPath(); g.moveTo(cx - 6, 24); g.lineTo(cx - 7, 38); g.moveTo(cx + 6, 24); g.lineTo(cx + 7, 38); g.stroke();
    }
  };
  man(32, false); man(96, true);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Placements for the signals of one cross street: [{kind, s, d, face}] with face = the
 *  route-relative direction the lenses look towards ('back' = towards -s, 'left'/'right'). */
export function signalPlacements(c, layout) {
  const out = [];
  const dEdge = TRACK_ZONE_HALF + 0.38;
  const clearOfPoles = (s, d) => {
    for (const p of layout.poles) if (Math.sign(p.d) === Math.sign(d) && Math.abs(layout.route.delta(p.s, s)) < 1.4) return false;
    return true;
  };
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
