import * as THREE from 'three';
import { RNG, noise1 } from '../../core/rng.js';
import { TRACK_OFFSET, CONTACT_WIRE_HEIGHT } from '../../core/config.js';
import { WireBuilder, WIRE_COLORS, sagCurve } from './wires.js';
import { SPAN_Y, SPAN_EYE_X, FEEDER_Y, PULL_OFF_Y } from './poleKit.js';
import { GeoBuilder, lathe } from './geo.js';

// Overhead contact line, suspended from cross-span wires between facing pole pairs.
//  - contact wire per track at CONTACT_WIRE_HEIGHT, zig-zag stagger on straights,
//    pulled to the outside of curves so the chords stay over the pantograph
//  - cross-span wire with sag and rod insulators near the poles and between tracks
//  - hanger + insulator from the span down to a clamp on each contact wire
//  - pull-off arm + wire to the outside pole on curves
//  - occasional feeder cable along one pole line, crossover wire over track crossovers

const STAGGER = 0.2;
const HANGER_R = 0.005, SPAN_R = 0.0055, CONTACT_R = 0.006, FEEDER_R = 0.011;

/** Plans the spans once for the whole loop. */
export function planOverhead(app) {
  const { layout, route } = app;
  const groups = new Map();
  for (const p of layout.poles) {
    const k = Math.round(route.wrap(p.s) * 100);
    if (!groups.has(k)) groups.set(k, { s: route.wrap(p.s), L: null, R: null });
    groups.get(k)[p.side < 0 ? 'L' : 'R'] = p;
  }
  const spans = [...groups.values()].filter((g) => g.L && g.R).sort((a, b) => a.s - b.s);
  const n = spans.length;
  const rng = RNG.from(layout.seed, 'overhead');
  spans.forEach((sp, i) => {
    sp.i = i;
    sp.next = spans[(i + 1) % n];
    sp.prev = spans[(i - 1 + n) % n];
    sp.len = route.delta(sp.s, sp.next.s);
    if (sp.len <= 0) sp.len += route.length;
    sp.h = CONTACT_WIRE_HEIGHT + rng.range(-0.025, 0.025);
    sp.sag = rng.range(0.03, 0.045) * Math.abs(sp.R.d - sp.L.d);
    sp.feeder = noise1(sp.s / 380, 77) > -0.35;
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

/** Insulator (rod with sheds, galvanised end fittings) along +Y, centred, 0.38 m long. */
export function buildInsulatorGeometry() {
  const lo = false;
  const b = new GeoBuilder();
  const P = [];
  const L = 0.38, h = L / 2;
  P.push([0.0, -h - 0.02], [0.012, -h - 0.018], [0.016, -h, true], [0.016, -h + 0.05, true], [0.012, -h + 0.055, true]);
  const sheds = lo ? 3 : 6;
  for (let i = 0; i < sheds; i++) {
    const y = -h + 0.075 + (i * (L - 0.15)) / (sheds - 1);
    const R = i % 2 ? 0.034 : 0.044;
    P.push([0.012, y - 0.012, true], [R, y - 0.004], [R, y + 0.002, true], [0.012, y + 0.008, true]);
  }
  P.push([0.012, h - 0.055, true], [0.016, h - 0.05, true], [0.016, h, true], [0.012, h + 0.018], [0.0, h + 0.02]);
  lathe(b, P, 9, { tube: 0.012 });
  const g = b.toGeometry((x, y) => (Math.abs(y) > h - 0.056 ? [1.6, 1.6, 1.6] : [1, 1, 1]));
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

const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s1 = new THREE.Vector3(1, 1, 1);

/** Instance matrix: object +Y along dir, centred at p. */
function alongMatrix(p, dir) {
  _q.setFromUnitVectors(_up, dir.clone().normalize());
  return _m.compose(p, _q, _s1).clone();
}

/** World position of a pole's span eye. */
function spanEye(route, pole, out = new THREE.Vector3()) {
  const smp = route.sample(pole.s);
  const toCentre = -Math.sign(pole.d);
  route.toWorld(pole.s, pole.d + toCentre * SPAN_EYE_X, SPAN_Y, out);
  void smp;
  return out;
}

/** Builds the overhead line of one chunk:
 *  {wires, insulatorRibbons, insulators: Matrix4[], clamps: Matrix4[]}. Far chunks fold the
 *  insulator stand-ins (short thick ribbons) into `wires`; full-detail chunks return them
 *  separately so they can replace the real insulators beyond the near range. */
export function buildOverheadChunk(app, plan, chunk) {
  const { route, layout } = app;
  const lo = chunk.lod > 0;
  const wb = new WireBuilder();
  const ib = lo ? wb : new WireBuilder();
  const insulators = [], clamps = [];
  const spans = plan.byChunk.get(chunk.index) || [];

  // rod insulator: real geometry near, a short thick segment further away
  const addInsulator = (p, dir) => {
    if (!lo) insulators.push(alongMatrix(p, dir));
    const d = dir.clone().normalize().multiplyScalar(0.18);
    ib.add([p.clone().sub(d), p.clone().add(d)], 0.03, WIRE_COLORS.insulator);
  };

  for (const sp of spans) {
    const eL = spanEye(route, sp.L), eR = spanEye(route, sp.R);
    const dL = sp.L.d - Math.sign(sp.L.d) * SPAN_EYE_X, dR = sp.R.d - Math.sign(sp.R.d) * SPAN_EYE_X;
    // span height (above paving) at lateral offset d
    const spanH = (d) => { const u = (d - dL) / (dR - dL); return SPAN_Y - sp.sag * 4 * u * (1 - u); };
    const spanPt = (d) => route.toWorld(sp.s, d, spanH(d));

    // cross-span wire
    const pts = [];
    const N = lo ? 8 : 18;
    for (let i = 0; i <= N; i++) pts.push(spanPt(dL + ((dR - dL) * i) / N));
    pts[0].copy(eL); pts[N].copy(eR);
    wb.add(pts, SPAN_R, WIRE_COLORS.steel);
    const spanDir = new THREE.Vector3().subVectors(eR, eL).normalize();
    for (const d of [dL + 0.75, 0, dR - 0.75]) {
      const a = spanPt(d - 0.05), b = spanPt(d + 0.05);
      addInsulator(spanPt(d), b.sub(a));
    }
    void spanDir;

    for (const t of [-1, 1]) {
      const dS = t * TRACK_OFFSET + sp.off[t];
      const sup = route.toWorld(sp.s, dS, sp.h);
      const top = spanPt(dS);
      // hanger with an inline insulator
      const clampTop = sup.clone().add(new THREE.Vector3(0, 0.035, 0));
      wb.add([top, clampTop], HANGER_R, WIRE_COLORS.steel);
      const mid = new THREE.Vector3().lerpVectors(clampTop, top, 0.45);
      addInsulator(mid, new THREE.Vector3(0, 1, 0));
      // contact wire to the next span
      const nx = sp.next;
      const dN = t * TRACK_OFFSET + nx.off[t];
      const supN = route.toWorld(nx.s, dN, nx.h);
      const cw = sagCurve(sup, supN, 0.0011 * sp.len + 0.01, Math.max(3, Math.ceil(sp.len / (lo ? 9 : 2.5))));
      wb.add(cw, CONTACT_R, WIRE_COLORS.contact);
      if (!lo) clamps.push(alongMatrix(sup, new THREE.Vector3().subVectors(supN, sup)));

      // pull-off on curves: short registration arm, then a wire up to the outside pole
      if (sp.curved) {
        const outer = sp.kSign > 0 ? sp.R : sp.L;
        const out = Math.sign(outer.d);
        const armEnd = route.toWorld(sp.s, dS + out * 0.5, sp.h + 0.06);
        wb.add([sup, armEnd], 0.011, WIRE_COLORS.steel);
        // the outer pole carries no track-side bracket on curves (see catenary.init)
        const anchor = route.toWorld(sp.s, outer.d - out * 0.1, PULL_OFF_Y);
        wb.add([armEnd, anchor], HANGER_R, WIRE_COLORS.steel);
        const ip = new THREE.Vector3().lerpVectors(armEnd, anchor, 0.18);
        addInsulator(ip, new THREE.Vector3().subVectors(anchor, armEnd));
      }
    }

    // feeder cable along the left pole line
    if (sp.feeder) {
      const a = sp.L, b = sp.next.L;
      const A = route.toWorld(a.s, a.d - 0.16, FEEDER_Y), B = route.toWorld(b.s, b.d - 0.16, FEEDER_Y);
      wb.add(sagCurve(A, B, 0.012 * sp.len, lo ? 6 : 14), FEEDER_R, WIRE_COLORS.feeder);
    }
  }

  // crossover wire between the two contact wires
  for (const c of layout.inChunk('crossovers', chunk.index)) {
    const dA = c.from * TRACK_OFFSET, dB = -c.from * TRACK_OFFSET;
    const A = route.toWorld(c.s0 - 4, dA, CONTACT_WIRE_HEIGHT + 0.02), B = route.toWorld(c.s1 + 4, dB, CONTACT_WIRE_HEIGHT + 0.02);
    const pts = [];
    const n = lo ? 6 : 16;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const s = (c.s0 - 4) + (c.s1 - c.s0 + 8) * u;
      // straight in the middle, easing onto the main wires at both ends
      const e = THREE.MathUtils.smoothstep(u, 0.0, 1.0);
      pts.push(route.toWorld(s, dA + (dB - dA) * e, CONTACT_WIRE_HEIGHT + 0.02 - 0.03 * 4 * u * (1 - u)));
    }
    void A; void B;
    wb.add(pts, CONTACT_R, WIRE_COLORS.contact);
  }

  return { wires: wb.toGeometry(), insulatorRibbons: lo ? null : ib.toGeometry(), insulators, clamps };
}
