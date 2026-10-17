import * as THREE from 'three';
import { GeoBuilder, lathe, sweepPlanar, simplifyPath, rod } from './geo.js';
import { armDesign, UPPER_COLLAR } from './armDesign.js';
import { lanternMetalProfile, lanternGlassProfile, STEM_LEN, GLASS_CENTRE } from './lantern.js';

// Shared geometry of the ornamental lamp / catenary standard. Pole-local frame: origin at
// the paving on the pole axis, +Y up, +X towards the street centre (the tracks).
//
//  shaft : cast base with fluted drum, tapered steel shaft, bead rings, the two bracket
//          collars, pull-off / span / feeder clamp bands, eye bolt, finial.
//  arm   : forged double-rail lyre bracket with scrolls, stem and lantern hood. Placed at
//          ARM_Y towards the tracks and/or, rotated 180°, towards the sidewalk.
//  glass : clear prismatic acorn bowl matching `arm`.
//
// Every vertex carries aWear (rust weight, run-off streak weight, lamp-lit underside) for
// the weathering and night-glow terms of the pole material (shaders.js).

export const POLE_TOP = 8.45;
export const SPAN_Y = 6.62;          // span wire eye height (the span sags to ~6.45 over the tracks)
export const FEEDER_Y = 8.05;        // feeder cable clamp height
export const PULL_OFF_Y = 6.3;       // pull-off anchor band (outer poles on curves)
export const ARM_Y = 5.1;            // lower bracket collar (the arch stays ~0.4 m below the span)
export const ARM_REACH = 1.0;        // design scale (hang point ~1.3 m from the pole axis)
export const SPAN_EYE_X = 0.135;     // eye bolt offset from the pole axis
export const COLLARS = [ARM_Y, ARM_Y + UPPER_COLLAR * ARM_REACH];

const smooth = THREE.MathUtils.smoothstep;

export function shaftRadius(y) {
  return 0.092 - (0.092 - 0.074) * THREE.MathUtils.clamp((y - 1.3) / (POLE_TOP - 1.4), 0, 1);
}

// ledges that shed rain water: run-off streaks start just below them
const LEDGES = [1.1, 2.43, COLLARS[0] - 0.056, COLLARS[1] - 0.056, PULL_OFF_Y - 0.045, SPAN_Y - 0.06, 7.13, FEEDER_Y - 0.04];

/** Grime / AO baked into vertex colours (multiplies the paint albedo). */
function poleColor(x, y, z, nx, ny, nz) {
  let r = 1, g = 1, b = 1;
  // contact AO at the paving and splash dust on the lower metre
  const ao = 0.55 + 0.45 * smooth(y, 0.0, 0.16);
  const dust = (1 - smooth(y, 0.04, 0.75)) * (0.55 + 0.45 * Math.max(0, ny));
  r *= ao * (1 + 0.7 * dust); g *= ao * (1 + 0.62 * dust); b *= ao * (1 + 0.45 * dust);
  // chalky, sun-faded paint and fine dust on upward-facing surfaces (tops of mouldings)
  const up = Math.max(0, ny - 0.55) / 0.45;
  r *= 1 + 0.4 * up; g *= 1 + 0.37 * up; b *= 1 + 0.3 * up;
  // slight darkening in the hollows under mouldings
  if (ny < -0.4) { r *= 0.86; g *= 0.86; b *= 0.86; }
  return [r, g, b];
}

function armColor(x, y, z, nx, ny, nz) {
  // shadowed junction against the shaft, dust on top faces
  const near = smooth(Math.hypot(x, z), 0.08, 0.2);
  const ao = 0.72 + 0.28 * near;
  const up = Math.max(0, ny - 0.5) / 0.5;
  return [ao * (1 + 0.36 * up), ao * (1 + 0.33 * up), ao * (1 + 0.26 * up)];
}

/** Rust / streak weights on the shaft (pole-local position and normal). */
function shaftWear(i, x, y, z, nx, ny) {
  let rust = 0.95 * (1 - smooth(y, 0.02, 0.3));                 // splash zone at the foot
  if (ny < -0.35) rust = Math.max(rust, 0.5);                    // drip edges under mouldings
  if (ny > 0.6) rust = Math.max(rust, 0.4);                      // ledges where water stands
  for (const c of COLLARS) if (Math.abs(y - c) < 0.07) rust = Math.max(rust, 0.42);
  let streak = 0;
  for (const L of LEDGES) if (y < L && y > L - 0.9) streak = Math.max(streak, 1 - (L - y) / 0.9);
  return [rust, streak, 0];
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

function shaftProfile(step) {
  const bands = [];
  // bead rings
  for (const ry of [2.45, 7.15]) bands.push({ y0: ry - 0.03, y1: ry + 0.03, P: [
    [shaftRadius(ry - 0.03), ry - 0.03, true], [shaftRadius(ry) + 0.013, ry - 0.015], [shaftRadius(ry) + 0.016, ry], [shaftRadius(ry) + 0.013, ry + 0.015], [shaftRadius(ry + 0.03), ry + 0.03, true]] });
  // bracket collars: split sleeves with a chamfered lip
  for (const cy of COLLARS) {
    const r = 0.097;
    bands.push({ y0: cy - 0.06, y1: cy + 0.06, P: [
      [shaftRadius(cy - 0.06), cy - 0.06, true], [r - 0.01, cy - 0.055, true], [r, cy - 0.045, true], [r + 0.004, cy - 0.03],
      [r + 0.004, cy + 0.03], [r, cy + 0.045, true], [r - 0.01, cy + 0.055, true], [shaftRadius(cy + 0.06), cy + 0.06, true]] });
  }
  // pull-off, span and feeder clamp bands
  for (const [cy, h, o] of [[PULL_OFF_Y, 0.04, 0.011], [SPAN_Y, 0.055, 0.014], [FEEDER_Y, 0.035, 0.012]]) {
    bands.push({ y0: cy - h - 0.005, y1: cy + h + 0.005, P: [
      [shaftRadius(cy - h - 0.005), cy - h - 0.005, true], [shaftRadius(cy) + o, cy - h, true], [shaftRadius(cy) + o, cy + h, true], [shaftRadius(cy + h + 0.005), cy + h + 0.005, true]] });
  }
  bands.sort((a, b) => a.y0 - b.y0);
  // plain tapered shaft between the bands, with intermediate rings so the per-vertex
  // weathering weights resolve
  const P = [[shaftRadius(1.28), 1.28]];
  let y = 1.28;
  const t = POLE_TOP;
  const fill = (y1) => {
    if (step) for (let yy = y + step; yy < y1 - step * 0.5; yy += step) P.push([shaftRadius(yy), yy]);
  };
  for (const b of bands) { fill(b.y0); P.push(...b.P); y = b.y1; }
  fill(t - 0.12);
  // cap and finial
  P.push([shaftRadius(t - 0.12), t - 0.12, true], [0.09, t - 0.11, true], [0.09, t - 0.065, true], [0.072, t - 0.05], [0.05, t - 0.03], [0.022, t - 0.012]);
  for (let i = 0; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * Math.PI; P.push([0.034 * Math.cos(a) + 0.0001, t + 0.03 + 0.034 * Math.sin(a)]); }
  P.push([0.008, t + 0.08], [0.0, t + 0.13]);
  return P;
}

// Detail levels: hi (near), mid (rest of the full-detail range), lo (far chunks). All
// levels keep every scroll so the silhouette never pops; only tessellation drops.
const LEVELS = {
  hi: { base: 48, shaft: 20, lantern: 24, tube: 8, bar: 8, ang: 5.5, len: 0.05, caps: true, flutes: true, hardware: true, step: 0.25 },
  mid: { base: 14, shaft: 10, lantern: 12, tube: 5, bar: 4, ang: 11, len: 0.11, caps: false, flutes: false, hardware: true, step: 0.6 },
  lo: { base: 8, shaft: 7, lantern: 8, tube: 4, bar: 4, ang: 18, len: 0.18, caps: false, flutes: false, hardware: false, step: 0 },
};

/** Build the shared geometries. Returns {hi|mid|lo: {shaft, arm, glass}, info}. */
export function buildPoleKit() {
  const design = armDesign(ARM_REACH);
  const hang = design.hang;

  const make = (L) => {
    // ---- shaft
    const sb = new GeoBuilder();
    lathe(sb, baseProfile(), L.base, { flutes: L.flutes ? { count: 16, depth: 0.075, y0: 0.32, y1: 1.06 } : null });
    lathe(sb, shaftProfile(L.step), L.shaft);
    if (L.hardware) {
      // eye bolt for the span wire (towards the street), feeder lug on the sidewalk side
      rod(sb, [shaftRadius(SPAN_Y), SPAN_Y, 0], [SPAN_EYE_X - 0.01, SPAN_Y, 0], 0.011, 6);
      torusRing(sb, [SPAN_EYE_X, SPAN_Y, 0], 0.02, 0.0065, 'z');
      rod(sb, [-shaftRadius(FEEDER_Y), FEEDER_Y, 0], [-0.17, FEEDER_Y, 0], 0.012, 6);
    }
    sb.paintWear(0, shaftWear);
    const shaft = sb.toGeometry(poleColor);

    // ---- arm (rails, stays, scrolls, stem, lantern hood), relative to the lower collar
    const ab = new GeoBuilder();
    for (const e of design.elements) {
      const i0 = ab.count;
      const pts = simplifyPath(e.pts, L.ang, L.len);
      const sec = e.prof === 'tube' ? { kind: 'round', r: e.r } : { kind: 'bar', w: e.w, t: e.t };
      sweepPlanar(ab, pts, sec, (x, y, z) => [x, y, z], e.prof === 'tube' ? L.tube : L.bar, L.caps);
      // forged tips and scroll eyes rust first; the stays rust where they meet the collars
      const len = ab.uv[ab.count * 2 - 2];
      const stay = e.name.startsWith('stay');
      ab.paintWear(i0, (i, x, y, z, nx, ny, nz, u) => {
        const tip = stay ? 1 - smooth(u, 0.0, 0.07) : Math.max(1 - smooth(u, 0.0, 0.06), smooth(u, len - 0.06, len));
        return [Math.max(0.65 * tip, ny < -0.5 ? 0.25 : 0), 0, 0];
      });
    }
    // stem from the volute down to the lantern
    rod(ab, [hang[0], hang[1] + 0.012, 0], [hang[0], hang[1] - STEM_LEN + 0.015, 0], 0.011, Math.min(6, L.tube), false);
    const lb = new GeoBuilder();
    lathe(lb, lanternMetalProfile(!L.hardware), L.lantern, { tube: 0.06 });
    // hood: rust along the rolled brim and the top of the cone, run-off below the lip,
    // and the underside lit by the lamp at night
    lb.paintWear(0, (i, x, y, z, nx, ny) => {
      const r = Math.hypot(x, z);
      const lit = ny < -0.3 && y < -0.38 ? 1 : (y < -0.43 && r < 0.16 ? 1 : 0);
      const rust = r > 0.27 && y < -0.39 ? 0.55 : (ny > 0.6 ? 0.35 : 0);
      const streak = y < -0.15 && y > -0.27 ? 0.6 : 0;
      return [rust, streak, lit];
    });
    ab.append(lb, new THREE.Matrix4().makeTranslation(hang[0], hang[1], 0));
    const arm = ab.toGeometry(armColor);

    // ---- glass
    const gb = new GeoBuilder();
    lathe(gb, lanternGlassProfile(), L.lantern, { tube: 0.15 });
    const glass = new GeoBuilder().append(gb, new THREE.Matrix4().makeTranslation(hang[0], hang[1], 0)).toGeometry();

    for (const g of [shaft, arm, glass]) g.userData.shared = true;
    return { shaft, arm, glass };
  };

  return {
    hi: make(LEVELS.hi),
    mid: make(LEVELS.mid),
    lo: make(LEVELS.lo),
    info: {
      hang,
      glassCentre: new THREE.Vector3(hang[0], hang[1] + GLASS_CENTRE, 0), // arm-local
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
  for (let i = 0; i < p.count; i++) tmp.vert(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i), uv.getX(i) * 0.1, uv.getY(i) * 0.04, r, [0.3, 0, 0]);
  const idx = tg.index.array;
  for (let i = 0; i < idx.length; i += 3) tmp.tri(idx[i], idx[i + 1], idx[i + 2]);
  tg.dispose();
  b.append(tmp, m);
}
