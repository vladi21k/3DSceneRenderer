import * as THREE from 'three';
import { GeoBuilder, lathe, sweepPlanar, simplifyPath, rod } from './geo.js';
import { armDesign } from './armDesign.js';

// Shared geometry of the ornamental lamp / catenary standard. Pole-local frame: origin at
// the paving on the pole axis, +Y up, +X towards the street centre (the tracks).
//
//  shaft : cast base with fluted drum, tapered steel shaft, bead rings, span-wire band
//          with an eye towards the street, finial.
//  arm   : swan-neck bracket with forged scrolls, collar sleeves, stem and lantern hood.
//          Placed at TRACK_ARM_Y (towards the tracks) or, rotated 180°, at WALK_ARM_Y.
//  glass : opal lantern bowl matching `arm`.

export const POLE_TOP = 8.45;
export const SPAN_Y = 7.55;          // span wire attachment height
export const FEEDER_Y = 8.12;        // feeder cable clamp height
export const PULL_OFF_Y = 6.3;       // pull-off anchor band (outer poles on curves)
export const TRACK_ARM_Y = 5.75;     // lower collar of the track-side bracket (apex stays below the span)
export const WALK_ARM_Y = 5.0;       // lower collar of the sidewalk-side bracket
export const ARM_REACH = 1.2;
export const SPAN_EYE_X = 0.135;     // eye bolt offset from the pole axis

const LANTERN_GLASS_Y = -0.45;       // glass centre below the hang point

export function shaftRadius(y) {
  return 0.092 - (0.092 - 0.074) * THREE.MathUtils.clamp((y - 1.3) / (POLE_TOP - 1.4), 0, 1);
}

/** Grime / AO baked into vertex colours (multiplies the paint albedo). */
function poleColor(x, y, z, nx, ny, nz) {
  let r = 1, g = 1, b = 1;
  // contact AO at the paving and splash dust on the lower metre
  const ao = 0.55 + 0.45 * THREE.MathUtils.smoothstep(y, 0.0, 0.16);
  const dust = (1 - THREE.MathUtils.smoothstep(y, 0.04, 0.75)) * (0.55 + 0.45 * Math.max(0, ny));
  r *= ao * (1 + 0.85 * dust); g *= ao * (1 + 0.75 * dust); b *= ao * (1 + 0.55 * dust);
  // fine dust on upward-facing surfaces everywhere (tops of mouldings, brackets, hoods)
  const up = Math.max(0, ny - 0.55) / 0.45;
  r *= 1 + 0.35 * up; g *= 1 + 0.32 * up; b *= 1 + 0.25 * up;
  // run-off streaks under mouldings: slightly darker band below each horizontal ledge
  const streak = 0.04 * Math.sin(y * 7.3 + Math.atan2(z, x) * 3.0) * Math.sin(y * 2.1);
  r *= 1 + streak; g *= 1 + streak; b *= 1 + streak;
  return [r, g, b];
}

function armColor(x, y, z, nx, ny, nz) {
  // shadowed junction against the shaft, dust on top faces
  const near = THREE.MathUtils.smoothstep(Math.hypot(x, z), 0.08, 0.2);
  const ao = 0.72 + 0.28 * near;
  const up = Math.max(0, ny - 0.5) / 0.5;
  return [ao * (1 + 0.32 * up), ao * (1 + 0.29 * up), ao * (1 + 0.22 * up)];
}

function baseProfile() {
  const P = [];
  P.push([0.215, 0.0], [0.215, 0.045, true], [0.2, 0.062, true]);
  // torus moulding
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * Math.PI; P.push([0.168 + Math.cos(a) * 0.034, 0.1 + Math.sin(a) * 0.034]); }
  P.push([0.166, 0.14, true]);
  // cove (scotia) rising into the drum
  for (let i = 1; i <= 4; i++) { const t = i / 4; P.push([0.166 - 0.016 * Math.sin(t * Math.PI / 2), 0.14 + 0.1 * t]); }
  P.push([0.158, 0.255, true], [0.158, 0.275, true], [0.15, 0.29, true]);
  // fluted drum (flutes cut by the lathe between 0.3 and 1.08)
  P.push([0.15, 0.31], [0.1495, 0.335], [0.1485, 0.42], [0.148, 0.6], [0.143, 0.9], [0.1405, 1.03], [0.14, 1.055], [0.139, 1.09, true]);
  // capital: bead, ogee, neck into the shaft
  P.push([0.152, 1.1, true], [0.152, 1.135, true], [0.14, 1.15, true]);
  P.push([0.132, 1.18], [0.118, 1.225], [0.104, 1.27], [0.096, 1.3, true]);
  return P;
}

function shaftProfile() {
  const P = [[shaftRadius(1.28), 1.28]];
  // plain tapered shaft with bead rings
  const rings = [2.45, 7.15];
  let y = 1.28;
  for (const ry of rings) {
    P.push([shaftRadius(ry - 0.03), ry - 0.03, true]);
    P.push([shaftRadius(ry) + 0.013, ry - 0.015], [shaftRadius(ry) + 0.016, ry], [shaftRadius(ry) + 0.013, ry + 0.015]);
    P.push([shaftRadius(ry + 0.03), ry + 0.03, true]);
    y = ry;
  }
  void y;
  // pull-off clamp band and span band
  P.push([shaftRadius(PULL_OFF_Y - 0.045), PULL_OFF_Y - 0.045, true], [shaftRadius(PULL_OFF_Y) + 0.011, PULL_OFF_Y - 0.04, true], [shaftRadius(PULL_OFF_Y) + 0.011, PULL_OFF_Y + 0.04, true], [shaftRadius(PULL_OFF_Y + 0.045), PULL_OFF_Y + 0.045, true]);
  P.push([shaftRadius(SPAN_Y - 0.06), SPAN_Y - 0.06, true], [shaftRadius(SPAN_Y) + 0.014, SPAN_Y - 0.055, true], [shaftRadius(SPAN_Y) + 0.014, SPAN_Y + 0.055, true], [shaftRadius(SPAN_Y + 0.06), SPAN_Y + 0.06, true]);
  P.push([shaftRadius(FEEDER_Y - 0.04), FEEDER_Y - 0.04, true], [shaftRadius(FEEDER_Y) + 0.012, FEEDER_Y - 0.035, true], [shaftRadius(FEEDER_Y) + 0.012, FEEDER_Y + 0.035, true], [shaftRadius(FEEDER_Y + 0.04), FEEDER_Y + 0.04, true]);
  // cap and finial
  const t = POLE_TOP;
  P.push([shaftRadius(t - 0.12), t - 0.12, true], [0.09, t - 0.11, true], [0.09, t - 0.065, true], [0.072, t - 0.05], [0.05, t - 0.03], [0.022, t - 0.012]);
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * Math.PI; P.push([0.034 * Math.cos(a) + 0.0001, t + 0.03 + 0.034 * Math.sin(a)]); }
  P.push([0.008, t + 0.08], [0.0, t + 0.13]);
  return P;
}

function lanternMetalProfile(lo) {
  const P = [
    [0.168, -0.33], [0.182, -0.33, true], [0.182, -0.296, true], [0.3, -0.296, true],
    [0.31, -0.29], [0.31, -0.279, true], [0.296, -0.275],
    [0.235, -0.258], [0.165, -0.232], [0.11, -0.2], [0.075, -0.17], [0.058, -0.152, true],
    [0.058, -0.112, true], [0.066, -0.109], [0.066, -0.1, true], [0.034, -0.096], [0.012, -0.094],
  ];
  if (!lo) for (let i = 0; i <= 5; i++) { const a = -Math.PI / 3 + (i / 5) * (Math.PI * 5 / 6); P.push([0.019 * Math.cos(a), -0.078 + 0.019 * Math.sin(a)]); }
  P.push([0.0, -0.058]);
  return P;
}

function lanternGlassProfile() {
  return [[0.0, -0.575], [0.045, -0.568], [0.095, -0.545], [0.137, -0.508], [0.166, -0.46], [0.178, -0.405], [0.177, -0.36], [0.17, -0.33], [0.13, -0.322]];
}

/** Build the shared geometries. Returns {lod0: {shaft, arm, glass}, lod1: {...}, info}. */
export function buildPoleKit() {
  const design = armDesign(ARM_REACH);
  const hang = design.hang;

  const make = (lo) => {
    // ---- shaft
    const sb = new GeoBuilder();
    lathe(sb, baseProfile(), lo ? 12 : 64, { flutes: lo ? null : { count: 16, depth: 0.075, y0: 0.32, y1: 1.06 } });
    lathe(sb, shaftProfile(), lo ? 10 : 28);
    if (!lo) {
      // eye bolt for the span wire (towards the street), feeder lug on the sidewalk side
      rod(sb, [shaftRadius(SPAN_Y), SPAN_Y, 0], [SPAN_EYE_X - 0.01, SPAN_Y, 0], 0.011, 6);
      torusRing(sb, [SPAN_EYE_X, SPAN_Y, 0], 0.02, 0.0065, 'z');
      rod(sb, [-shaftRadius(FEEDER_Y), FEEDER_Y, 0], [-0.17, FEEDER_Y, 0], 0.012, 6);
    }
    const shaft = sb.toGeometry(poleColor);

    // ---- arm (+ collar sleeves, stem, lantern hood)
    const ab = new GeoBuilder();
    for (const e of design.elements) {
      if (lo && !['main', 'tie', 'foot'].includes(e.name)) continue;
      const pts = simplifyPath(e.pts, lo ? 14 : 5, lo ? 0.12 : 0.05);
      const sec = e.prof === 'tube' ? { kind: 'round', r: e.r } : { kind: 'bar', w: e.w, t: e.t };
      sweepPlanar(ab, pts, sec, (x, y, z) => [x, y, z], lo ? (e.prof === 'tube' ? 5 : 4) : (e.prof === 'tube' ? 10 : 8), !lo);
    }
    for (const cy of design.collars) {
      const r = 0.097;
      lathe(ab, [[r - 0.01, cy - 0.055], [r, cy - 0.045, true], [r + 0.004, cy - 0.03], [r + 0.004, cy + 0.03], [r, cy + 0.045, true], [r - 0.01, cy + 0.055]], lo ? 8 : 20);
    }
    // stem from the crook down to the lantern, lantern hood
    rod(ab, [hang[0], hang[1] + 0.02, 0], [hang[0], hang[1] - 0.07, 0], 0.009, lo ? 4 : 6, false);
    const lb = new GeoBuilder();
    lathe(lb, lanternMetalProfile(lo), lo ? 10 : 28, { tube: 0.05 });
    ab.append(lb, new THREE.Matrix4().makeTranslation(hang[0], hang[1], 0));
    const arm = ab.toGeometry(armColor);

    // ---- glass
    const gb = new GeoBuilder();
    lathe(gb, lanternGlassProfile(), lo ? 10 : 28, { tube: 0.15 });
    const glassG = new GeoBuilder().append(gb, new THREE.Matrix4().makeTranslation(hang[0], hang[1], 0));
    const glass = glassG.toGeometry();

    for (const g of [shaft, arm, glass]) g.userData.shared = true;
    return { shaft, arm, glass };
  };

  return {
    lod0: make(false),
    lod1: make(true),
    info: {
      hang,
      glassCentre: new THREE.Vector3(hang[0], hang[1] + LANTERN_GLASS_Y, 0), // arm-local
      armTop: design.top,
    },
  };
}

/** Small torus (eye) at c with major radius R, tube r, axis along 'x'|'y'|'z'. */
function torusRing(b, c, R, r, axis = 'z') {
  const tg = new THREE.TorusGeometry(R, r, 6, 12);
  const m = new THREE.Matrix4();
  if (axis === 'x') m.makeRotationY(Math.PI / 2);
  else if (axis === 'y') m.makeRotationX(Math.PI / 2);
  m.setPosition(c[0], c[1], c[2]);
  const p = tg.attributes.position, n = tg.attributes.normal, uv = tg.attributes.uv;
  const tmp = new GeoBuilder();
  for (let i = 0; i < p.count; i++) tmp.vert(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i), uv.getX(i) * 0.1, uv.getY(i) * 0.04, r);
  const idx = tg.index.array;
  for (let i = 0; i < idx.length; i += 3) tmp.tri(idx[i], idx[i + 1], idx[i + 2]);
  tg.dispose();
  b.append(tmp, m);
}
