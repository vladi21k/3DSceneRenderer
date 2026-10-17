import * as THREE from 'three';
import { RNG, noise1 } from '../../core/rng.js';
import { TRACK_OFFSET, CONTACT_WIRE_HEIGHT } from '../../core/config.js';
import { WireBuilder, WIRE_COLORS, sagCurve } from './wires.js';
import { SPAN_Y, SPAN_EYE_X, FEEDER_Y, PULL_OFF_Y } from './poleKit.js';
import { GeoBuilder, lathe, rod } from './geo.js';

// Overhead contact line, suspended from cross-span wires between facing pole pairs.
//  - contact wire per track at CONTACT_WIRE_HEIGHT, zig-zag stagger on straights,
//    pulled to the outside of curves so the chords stay over the pantograph
//  - cross-span wire from eye bolt to eye bolt with a small sag, so it crosses the tracks
//    only ~0.45 m above the contact wires; slim rod insulators near both poles and in
//    the middle (section isolation)
//  - at each support: a short double dropper with compact insulators from the span down
//    to the contact-wire clamp, and a registration arm (bent 22 mm tube) from the clamp,
//    held by a thin stay up to the span; on curves the arm points to the outer pole and
//    a pull-off wire anchors it there
//  - occasional feeder cable along one pole line, crossover wire over track crossovers

const STAGGER = 0.2;
const DROP_R = 0.004, SPAN_R = 0.0055, STAY_R = 0.003, CONTACT_R = 0.006, FEEDER_R = 0.011, ARM_R = 0.011;
const DROP_GAP = 0.06;               // the two droppers of a support, across the track
const ARM_LEN = 0.9;                 // registration arm base length (instances scale it)
const STAY_END = 0.32;               // |d| where the stays of straight track meet the span
const SPAN_INS = 0.3, DROP_INS = 0.2;

/** Plans the spans once for the whole loop. poles: the rendered poles; frame(p) returns
 *  the pole matrix (pole-local +X towards the street centre). */
export function planOverhead(app, poles, frame) {
  const { layout, route } = app;
  const groups = new Map();
  for (const p of poles) {
    const k = Math.round(route.wrap(p.s) * 100);
    if (!groups.has(k)) groups.set(k, { s: route.wrap(p.s), L: null, R: null });
    groups.get(k)[p.side < 0 ? 'L' : 'R'] = p;
  }
  const spans = [...groups.values()].filter((g) => g.L && g.R).sort((a, b) => a.s - b.s);
  const n = spans.length;
  const rng = RNG.from(layout.seed, 'overhead');
  const at = (p, x, y) => new THREE.Vector3(x, y, 0).applyMatrix4(frame(p));
  spans.forEach((sp, i) => {
    sp.i = i;
    sp.next = spans[(i + 1) % n];
    sp.prev = spans[(i - 1 + n) % n];
    sp.len = route.delta(sp.s, sp.next.s);
    if (sp.len <= 0) sp.len += route.length;
    sp.h = CONTACT_WIRE_HEIGHT + rng.range(-0.025, 0.025);
    sp.width = Math.abs(sp.R.d - sp.L.d) - 2 * SPAN_EYE_X;
    sp.sag = rng.range(0.022, 0.028) * sp.width;
    sp.feeder = noise1(sp.s / 380, 77) > -0.35;
    sp.stayJit = [rng.range(-0.04, 0.04), rng.range(-0.04, 0.04)];
    // world anchor points from the (raked) pole frames
    sp.eyeL = at(sp.L, SPAN_EYE_X, SPAN_Y); sp.eyeR = at(sp.R, SPAN_EYE_X, SPAN_Y);
    sp.pullL = at(sp.L, 0.1, PULL_OFF_Y); sp.pullR = at(sp.R, 0.1, PULL_OFF_Y);
    sp.feedL = at(sp.L, -0.17, FEEDER_Y);
  });
  for (const sp of spans) {
    const k = route.curvature(sp.s);
    const lenP = route.delta(sp.prev.s, sp.s), lenN = sp.len;
    const sag = ((lenP * lenP + lenN * lenN) / 2) * Math.abs(k) / 8;
    const w = THREE.MathUtils.smoothstep(Math.abs(k), 1 / 2500, 1 / 700);
    sp.curved = Math.abs(k) > 1 / 650;
    sp.kSign = Math.sign(k);
    sp.off = {};
    for (const t of [-1, 1]) {
      const zig = (sp.i % 2 ? 1 : -1) * t * STAGGER;
      sp.off[t] = zig * (1 - 0.75 * w) + Math.sign(k) * Math.min(0.34, sag / 2) * w;
    }
  }
  // bucket by chunk
  const byChunk = new Map();
  for (const sp of spans) {
    const ci = layout.chunkIndex(sp.s);
    if (!byChunk.has(ci)) byChunk.set(ci, []);
    byChunk.get(ci).push(sp);
  }
  return { spans, byChunk };
}

/** Slim rod insulator (silicone housing with a few small sheds, galvanised end fittings)
 *  along +Y, centred. */
export function buildInsulatorGeometry({ L = 0.3, sheds = 3, R = [0.025, 0.022] } = {}) {
  const b = new GeoBuilder();
  const P = [];
  const h = L / 2, core = 0.009, fit = 0.045;
  P.push([0.0, -h - 0.018], [0.006, -h - 0.016], [0.011, -h, true], [0.011, -h + fit, true], [core, -h + fit + 0.004, true]);
  for (let i = 0; i < sheds; i++) {
    const y = -h + fit + 0.03 + (i * (L - 2 * fit - 0.06)) / Math.max(1, sheds - 1);
    const r = R[i % 2];
    P.push([core, y - 0.007, true], [r, y - 0.002], [r, y + 0.0015, true], [core, y + 0.005, true]);
  }
  P.push([core, h - fit - 0.004, true], [0.011, h - fit, true], [0.011, h, true], [0.006, h + 0.016], [0.0, h + 0.018]);
  lathe(b, P, 9, { tube: 0.011 });
  // galvanised fittings read lighter than the grey housing
  const g = b.toGeometry((x, y) => (Math.abs(y) > h - fit - 0.002 ? [1.5, 1.5, 1.5] : [1, 1, 1]));
  g.userData.shared = true;
  return g;
}

/** Contact-wire clamp (ear) along +Y. */
export function buildClampGeometry() {
  const b = new GeoBuilder();
  lathe(b, [[0.0, -0.07], [0.008, -0.068], [0.014, -0.05, true], [0.014, 0.05, true], [0.008, 0.068], [0.0, 0.07]], 8, { tube: 0.012 });
  const g = b.toGeometry(() => [0.45, 0.45, 0.45]);
  g.userData.shared = true;
  return g;
}

// registration arm centre line in its local frame (x along the arm, y up), base length
const ARM_PTS = (() => {
  const pts = [[0, 0.015]];
  for (const [len, deg] of [[0.2, 25], [0.5, 6], [0.2, -5]]) {
    const a = pts[pts.length - 1], r = (deg * Math.PI) / 180;
    pts.push([a[0] + Math.cos(r) * len, a[1] + Math.sin(r) * len]);
  }
  const k = ARM_LEN / pts[pts.length - 1][0];
  return pts.map(([x, y]) => [x * k, y]);
})();
const ARM_TIP = ARM_PTS[ARM_PTS.length - 1];

/** Registration arm: bent galvanised tube with a clamp on the contact wire and an eye for
 *  the stay at the tip. Local frame: origin at the clamp, +X along the arm, +Y up. */
export function buildArmGeometry() {
  const b = new GeoBuilder();
  for (let i = 1; i < ARM_PTS.length; i++) {
    const a = ARM_PTS[i - 1], c = ARM_PTS[i];
    rod(b, [a[0], a[1], 0], [c[0], c[1], 0], ARM_R, 7, i === ARM_PTS.length - 1);
    if (i < ARM_PTS.length - 1) {
      // knuckle at the bend
      const kb = new GeoBuilder();
      lathe(kb, [[0.0, -ARM_R], [ARM_R * 0.8, -ARM_R * 0.6], [ARM_R * 1.02, 0], [ARM_R * 0.8, ARM_R * 0.6], [0.0, ARM_R]], 7, { tube: ARM_R });
      b.append(kb, new THREE.Matrix4().makeTranslation(c[0], c[1], 0));
    }
  }
  // clamp block on the contact wire and the stay eye at the tip
  const cb = new GeoBuilder();
  lathe(cb, [[0.0, -0.05], [0.012, -0.045, true], [0.016, -0.03, true], [0.016, 0.03, true], [0.012, 0.045, true], [0.0, 0.05]], 8, { tube: 0.014 });
  b.append(cb, new THREE.Matrix4().makeRotationX(Math.PI / 2));
  rod(b, [ARM_TIP[0] - 0.01, ARM_TIP[1], 0], [ARM_TIP[0] + 0.035, ARM_TIP[1] + 0.012, 0], 0.006, 6);
  const g = b.toGeometry(() => [1, 1, 1]);
  g.userData.shared = true;
  return g;
}

const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s1 = new THREE.Vector3(1, 1, 1);
const _v = new THREE.Vector3(), _w = new THREE.Vector3();

/** Instance matrix: object +Y along dir, centred at p. */
function alongMatrix(p, dir) {
  _q.setFromUnitVectors(_up, _w.copy(dir).normalize());
  return _m.compose(p, _q, _s1).clone();
}

/** Builds the overhead line of one chunk:
 *  {wires, detailRibbons, spanInsulators, dropInsulators, arms, clamps} where the last
 *  four are instance matrices (full-detail chunks only) and detailRibbons is the cheap
 *  ribbon stand-in for them beyond the near range. Far chunks fold the stand-ins into
 *  `wires`. */
export function buildOverheadChunk(app, plan, chunk) {
  const { route, layout } = app;
  const lo = chunk.lod > 0;
  const wb = new WireBuilder();
  const ib = lo ? wb : new WireBuilder();
  const spanIns = [], dropIns = [], arms = [], clamps = [];
  const spans = plan.byChunk.get(chunk.index) || [];

  const addInsulator = (list, L, p, dir) => {
    if (!lo) list.push(alongMatrix(p, dir));
    const d = _v.copy(dir).normalize().multiplyScalar(L * 0.5);
    ib.add([p.clone().sub(d), p.clone().add(d)], 0.013, WIRE_COLORS.insulator);
  };

  for (const sp of spans) {
    const smp = route.sample(sp.s);
    const right = smp.right;
    const dL = sp.L.d - Math.sign(sp.L.d) * SPAN_EYE_X, dR = sp.R.d - Math.sign(sp.R.d) * SPAN_EYE_X;
    // span wire: straight chord between the eye bolts with a parabolic sag
    const spanAt = (u, out = new THREE.Vector3()) => out.lerpVectors(sp.eyeL, sp.eyeR, u).setY(THREE.MathUtils.lerp(sp.eyeL.y, sp.eyeR.y, u) - sp.sag * 4 * u * (1 - u));
    const uOf = (d) => (d - dL) / (dR - dL);
    const spanPt = (d) => spanAt(uOf(d));

    const pts = [];
    const N = lo ? 8 : 18;
    for (let i = 0; i <= N; i++) pts.push(spanAt(i / N));
    wb.add(pts, SPAN_R, WIRE_COLORS.steel);
    // slim rod insulators near both poles and between the tracks
    for (const d of [dL + 0.75, 0, dR - 0.75]) addInsulator(spanIns, SPAN_INS, spanPt(d), spanPt(d + 0.05).sub(spanPt(d - 0.05)));

    for (const t of [-1, 1]) {
      const dS = t * TRACK_OFFSET + sp.off[t];
      const sup = route.toWorld(sp.s, dS, sp.h);
      // contact wire to the next span
      const nx = sp.next;
      const supN = route.toWorld(nx.s, t * TRACK_OFFSET + nx.off[t], nx.h);
      const cw = sagCurve(sup, supN, 0.0011 * sp.len + 0.01, Math.max(3, Math.ceil(sp.len / (lo ? 9 : 2.5))));
      wb.add(cw, CONTACT_R, WIRE_COLORS.contact);
      if (!lo) clamps.push(alongMatrix(sup, _v.subVectors(supN, sup)));

      // double dropper: span -> compact insulator -> strand -> yoke on the clamp
      const yoke = sup.clone().addScaledVector(_up, 0.055);
      for (const o of [-DROP_GAP / 2, DROP_GAP / 2]) {
        const top = spanPt(dS + o);
        const bot = yoke.clone().addScaledVector(right, o * 0.6);
        const len = top.y - bot.y;
        const insC = top.clone().addScaledVector(_up, -(0.03 + DROP_INS / 2));
        const below = top.clone().addScaledVector(_up, -(0.03 + DROP_INS));
        if (len > DROP_INS + 0.08) {
          wb.add([top, top.clone().addScaledVector(_up, -0.03)], DROP_R, WIRE_COLORS.steel);
          wb.add([below, bot], DROP_R, WIRE_COLORS.steel);
          addInsulator(dropIns, DROP_INS, insC, _up);
        } else wb.add([top, bot], DROP_R, WIRE_COLORS.steel);
      }

      // registration arm from the clamp; on straight track it points towards the street
      // centre and a stay holds its tip from the span, on curves it points to the outer
      // pole and a pull-off wire anchors it there
      let dir, scale, anchor;
      if (sp.curved) {
        const outer = sp.kSign > 0 ? sp.R : sp.L;
        dir = Math.sign(outer.d);
        scale = 0.75;
        anchor = outer === sp.R ? sp.pullR : sp.pullL;
      } else {
        dir = -t;
        const tipD = STAY_END + 0.42 + sp.stayJit[t > 0 ? 1 : 0];
        scale = THREE.MathUtils.clamp((Math.abs(dS) - tipD) / ARM_LEN, 0.6, 1.3);
      }
      const ax = right.clone().multiplyScalar(dir);
      const az = new THREE.Vector3().crossVectors(ax, _up);
      const am = new THREE.Matrix4().makeBasis(ax.clone().multiplyScalar(scale), _up, az).setPosition(sup);
      const tip = new THREE.Vector3(ARM_TIP[0] + 0.03, ARM_TIP[1] + 0.012, 0).applyMatrix4(am);
      if (!sp.curved) anchor = spanPt(t * (STAY_END + sp.stayJit[t > 0 ? 1 : 0]));
      // ribbon stand-in for the tube (far chunks, and the mid range of near chunks)
      ib.add(ARM_PTS.map(([x, y]) => new THREE.Vector3(x, y, 0).applyMatrix4(am)), ARM_R, WIRE_COLORS.arm);
      if (!lo) arms.push(am);
      if (sp.curved) {
        wb.add([tip, anchor], DROP_R, WIRE_COLORS.steel);
        const ip = new THREE.Vector3().lerpVectors(tip, anchor, 0.12);
        addInsulator(dropIns, DROP_INS, ip, _v.subVectors(anchor, tip));
      } else wb.add([tip, anchor], STAY_R, WIRE_COLORS.steel);
    }

    // feeder cable along the left pole line
    if (sp.feeder) wb.add(sagCurve(sp.feedL, sp.next.feedL, 0.012 * sp.len, lo ? 6 : 14), FEEDER_R, WIRE_COLORS.feeder);
  }

  // crossover wire between the two contact wires, easing onto the main wires at both ends
  for (const c of layout.inChunk('crossovers', chunk.index)) {
    const dA = c.from * TRACK_OFFSET, dB = -c.from * TRACK_OFFSET;
    const sA = c.s0 - 4, len = c.s1 - c.s0 + 8;
    const pts = [];
    const n = lo ? 6 : 16;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const e = THREE.MathUtils.smoothstep(u, 0.0, 1.0);
      pts.push(route.toWorld(sA + len * u, dA + (dB - dA) * e, CONTACT_WIRE_HEIGHT + 0.02 - 0.03 * 4 * u * (1 - u)));
    }
    wb.add(pts, CONTACT_R, WIRE_COLORS.contact);
  }

  return {
    wires: wb.toGeometry(),
    detailRibbons: lo ? null : ib.toGeometry(),
    spanInsulators: spanIns, dropInsulators: dropIns, arms, clamps,
  };
}
