import * as THREE from 'three';
import { hash2 } from '../../core/rng.js';
import { BONE } from './anim.js';

// Mobility poses for the figures (docs/ARCHITECTURE.md, Mobility extension) and the props they
// carry along:
//   pose 3  pushing a stroller: the walk clips, the trunk leaning in a little, both hands on the
//           handle grips (arm IK every frame, so the arms take up the chest's bob and sway)
//   pose 4  riding a bicycle: seated on the saddle, hands on the grips, the pelvis and spine
//           leaning towards the bars (solved per rider so the arms reach), legs driven by the crank
//           (two-bone IK of hip, knee and ankle to the pedal spindles with an ankling foot), the
//           rider leaning with the bike; at a standstill the rider slides off the saddle and puts
//           a foot down while the bike tilts towards it
//   pose 5  walking beside a bicycle held on the walker's right: walk clips with the near hand on
//           the bike's left grip (or one hand on the grip and the other on the saddle)
// Every pose is built in the figure's own model space (origin at the crowd position, -Z ahead),
// so pose changes cross-fade like any other. Props are drawn with the kits' instancers
// (props/index.js): wheels roll with distance, cranks turn with the gait phase, bikes lean into
// turns and steer, stroller casters trail.

const NB = 22;
const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const HAND_SCALE = { male: 1.0, female: 0.9, child: 0.76, kid: 0.62 };

// ------------------------------------------------------------------ small vector / 3x3 helpers
// 3x3 rotations are row-major (9 numbers at an offset), vectors are [x, y, z]

const v3 = () => new Float64Array(3);
function set3(o, x, y, z) { o[0] = x; o[1] = y; o[2] = z; return o; }
function norm3(o) { const l = Math.hypot(o[0], o[1], o[2]) || 1; o[0] /= l; o[1] /= l; o[2] /= l; return o; }
function cross3(a, b, o) { const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]; o[0] = x; o[1] = y; o[2] = z; return o; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
/** o = R(m, mo) * v */
function app3(m, mo, x, y, z, o) {
  o[0] = m[mo] * x + m[mo + 1] * y + m[mo + 2] * z;
  o[1] = m[mo + 3] * x + m[mo + 4] * y + m[mo + 5] * z;
  o[2] = m[mo + 6] * x + m[mo + 7] * y + m[mo + 8] * z;
  return o;
}
const _mt = new Float64Array(9);
/** C = A * B (C may alias A or B) */
function mul3(A, ao, B, bo, C, co) {
  for (let r = 0; r < 3; r++) {
    const a0 = A[ao + r * 3], a1 = A[ao + r * 3 + 1], a2 = A[ao + r * 3 + 2];
    for (let c = 0; c < 3; c++) _mt[r * 3 + c] = a0 * B[bo + c] + a1 * B[bo + 3 + c] + a2 * B[bo + 6 + c];
  }
  for (let k = 0; k < 9; k++) C[co + k] = _mt[k];
}
function setRx(m, o, a) { const c = Math.cos(a), s = Math.sin(a); m[o] = 1; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0; m[o + 4] = c; m[o + 5] = -s; m[o + 6] = 0; m[o + 7] = s; m[o + 8] = c; }
function setRy(m, o, a) { const c = Math.cos(a), s = Math.sin(a); m[o] = c; m[o + 1] = 0; m[o + 2] = s; m[o + 3] = 0; m[o + 4] = 1; m[o + 5] = 0; m[o + 6] = -s; m[o + 7] = 0; m[o + 8] = c; }
function setRz(m, o, a) { const c = Math.cos(a), s = Math.sin(a); m[o] = c; m[o + 1] = -s; m[o + 2] = 0; m[o + 3] = s; m[o + 4] = c; m[o + 5] = 0; m[o + 6] = 0; m[o + 7] = 0; m[o + 8] = 1; }
/** Rotation about unit axis k by a. */
function setRaxis(m, o, kx, ky, kz, a) {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  m[o] = t * kx * kx + c; m[o + 1] = t * kx * ky - s * kz; m[o + 2] = t * kx * kz + s * ky;
  m[o + 3] = t * kx * ky + s * kz; m[o + 4] = t * ky * ky + c; m[o + 5] = t * ky * kz - s * kx;
  m[o + 6] = t * kx * kz - s * ky; m[o + 7] = t * ky * kz + s * kx; m[o + 8] = t * kz * kz + c;
}
const _ta = v3(), _tn = v3(), _tc = v3(), _ua = v3(), _un = v3(), _uc = v3();
/** Rotation taking frame (d0, n0) onto (d1, n1): d = primary direction, n = secondary axis. */
function frameMatch(out, o, d0, n0, d1, n1) {
  const a = norm3(set3(_ta, d0[0], d0[1], d0[2]));
  let k = dot3(n0, a);
  const na = norm3(set3(_tn, n0[0] - a[0] * k, n0[1] - a[1] * k, n0[2] - a[2] * k));
  const ca = cross3(a, na, _tc);
  const b = norm3(set3(_ua, d1[0], d1[1], d1[2]));
  k = dot3(n1, b);
  const nb = norm3(set3(_un, n1[0] - b[0] * k, n1[1] - b[1] * k, n1[2] - b[2] * k));
  const cb = cross3(b, nb, _uc);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[o + r * 3 + c] = b[r] * a[c] + nb[r] * na[c] + cb[r] * ca[c];
}
const _iu = v3(), _iv = v3();
/** Two-bone IK: mid joint bending towards `pole`, end clamped to the reach. Returns the reach ratio. */
function ik2(root, target, l1, l2, pole, reach, mid, end) {
  let dx = target[0] - root[0], dy = target[1] - root[1], dz = target[2] - root[2];
  let d = Math.hypot(dx, dy, dz);
  const u = set3(_iu, dx / (d || 1), dy / (d || 1), dz / (d || 1));
  const want = d;
  d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-3), (l1 + l2) * reach);
  const k = dot3(pole, u);
  const v = norm3(set3(_iv, pole[0] - u[0] * k, pole[1] - u[1] * k, pole[2] - u[2] * k));
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  for (let i = 0; i < 3; i++) { mid[i] = root[i] + u[i] * a + v[i] * h; end[i] = root[i] + u[i] * d; }
  return want / (l1 + l2);
}
const smooth01 = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ per-body poser

// pose scratch: world (figure model space) rotation and joint position per bone
const PR = new Float64Array(NB * 9), PP = new Float64Array(NB * 3);
const _a = v3(), _b = v3(), _c = v3(), _d = v3(), _e = v3(), _f = v3(), _g = v3(), _h = v3(), _p = v3(), _q = v3();
const _m9 = new Float64Array(9), _n9 = new Float64Array(9);

export class Poser {
  constructor(rig) {
    this.rig = rig;
    const R = rig.rest;
    this.rest = new Float64Array(NB * 3);
    R.forEach((v, i) => { this.rest[i * 3] = v.x; this.rest[i * 3 + 1] = v.y; this.rest[i * 3 + 2] = v.z; });
    this.parent = rig.parent;
    this.k = rig.H / 1.76;
    this.l1 = rig.l1; this.l2 = rig.l2; this.ua = rig.ua; this.fa = rig.fa;
    const hs = HAND_SCALE[rig.kind] ?? this.k;
    this.arm = {};
    for (const s of ['L', 'R']) {
      const sg = s === 'R' ? 1 : -1;
      const E = rig.elbow[s];
      const sh = R[BONE['arm' + s]], el = R[BONE['fore' + s]], wr = R[BONE['hand' + s]];
      const du = [el.x - sh.x, el.y - sh.y, el.z - sh.z], df = [wr.x - el.x, wr.y - el.y, wr.z - el.z];
      norm3(du); norm3(df);
      const ha = norm3([df[0], df[1], df[2] - 0.05]);           // hand axis, as sculpted
      const pn = norm3(cross3(ha, [0, 0, 1], [0, 0, 0]).map((x) => x * sg));   // palm normal (medial)
      const th = [0, 0, -1];                                     // thumb / index side (forward at rest)
      this.arm[s] = {
        sg, b: [BONE['clav' + s], BONE['arm' + s], BONE['fore' + s], BONE['hand' + s]],
        du, df, axis: [E.axis.x, E.axis.y, E.axis.z], wd: [E.wd.x, E.wd.y, E.wd.z], th, ha, pn,
        // grip (a bar in the curled fingers) and palm-on-a-surface points, relative to the wrist joint at rest
        grip: [ha[0] * 0.098 * hs + pn[0] * 0.026 * hs, ha[1] * 0.098 * hs + pn[1] * 0.026 * hs, ha[2] * 0.098 * hs + pn[2] * 0.026 * hs],
        palm: [ha[0] * 0.062 * hs + pn[0] * 0.022 * hs, ha[1] * 0.062 * hs + pn[1] * 0.022 * hs, ha[2] * 0.062 * hs + pn[2] * 0.022 * hs],
        reach: this.ua + this.fa + 0.1 * hs,
      };
    }
    this.leg = {};
    for (const s of ['L', 'R']) {
      const t = R[BONE['thigh' + s]], k = R[BONE['shin' + s]], f = R[BONE['foot' + s]];
      const dT0 = [k.x - t.x, k.y - t.y, k.z - t.z], dS0 = [f.x - k.x, f.y - k.y, f.z - k.z];
      const n0 = norm3(cross3(dT0, [0, 0, -1], [0, 0, 0]));
      const fo = rig.foot[s];
      this.leg[s] = {
        sg: s === 'R' ? 1 : -1, b: [BONE['thigh' + s], BONE['shin' + s], BONE['foot' + s], BONE['toe' + s]], dT0, dS0, n0,
        // ankle relative to the sole under the ball of the foot (rest)
        ankBall: [fo.ankle.x - fo.ball.x, fo.ankle.y - fo.ball.y, fo.ankle.z - fo.ball.z],
      };
    }
    // sit bones: below and a little behind the hip joints (the pelvis rocks forward about them)
    const hL = R[BONE.thighL], hR = R[BONE.thighR];
    this.hipC = [(hL.x + hR.x) / 2, (hL.y + hR.y) / 2, (hL.z + hR.z) / 2];
    this.isch = [this.hipC[0], this.hipC[1] - 0.088 * this.k, this.hipC[2] + 0.035 * this.k];
    this.hipHalf = Math.abs(hR.x - hL.x) / 2;
    this.legLen = this.l1 + this.l2;
    this.miss = 0;
    this.missStat = null;      // testing: {max, n} of the hand's distance from its hold point (model units)
  }

  /** FK of one bone from its parent (rotation local to the parent's world rotation). */
  _fk(b, localR, lo) {
    const pa = this.parent[b], r = this.rest;
    if (localR) mul3(PR, pa * 9, localR, lo || 0, PR, b * 9);
    else for (let k = 0; k < 9; k++) PR[b * 9 + k] = PR[pa * 9 + k];
    app3(PR, pa * 9, r[b * 3] - r[pa * 3], r[b * 3 + 1] - r[pa * 3 + 1], r[b * 3 + 2] - r[pa * 3 + 2], _p);
    PP[b * 3] = PP[pa * 3] + _p[0]; PP[b * 3 + 1] = PP[pa * 3 + 1] + _p[1]; PP[b * 3 + 2] = PP[pa * 3 + 2] + _p[2];
  }

  /** Torso of a rider in the scratch pose: pelvis rocked forward on the sit point, spine flexed,
   *  head kept looking ahead, shoulders protracted. lean = trunk pitch (rad), sit = sit point. */
  _torso(sit, lean, pelvisK, roll, yaw, look) {
    const r = this.rest;
    const ap = lean * pelvisK, a1 = lean * (1 - pelvisK) * 0.55, a2 = lean * (1 - pelvisK) * 0.45;
    // root: identity at the origin
    setRx(PR, 0, 0); PP[0] = 0; PP[1] = 0; PP[2] = 0;
    // pelvis: R = Ry(yaw) Rx(-ap) Rz(roll), placed so the sit bones rest on the sit point
    setRy(_m9, 0, yaw); setRx(_n9, 0, -ap); mul3(_m9, 0, _n9, 0, _m9, 0);
    setRz(_n9, 0, roll); mul3(_m9, 0, _n9, 0, PR, 9);
    app3(PR, 9, r[3] - this.isch[0], r[4] - this.isch[1], r[5] - this.isch[2], _p);
    PP[3] = sit[0] + _p[0]; PP[4] = sit[1] + _p[1]; PP[5] = sit[2] + _p[2];
    setRx(_m9, 0, -a1); setRz(_n9, 0, -roll * 0.6); mul3(_m9, 0, _n9, 0, _m9, 0);
    this._fk(BONE.spine1, _m9);
    setRx(_m9, 0, -a2); setRz(_n9, 0, -roll * 0.3); mul3(_m9, 0, _n9, 0, _m9, 0);
    this._fk(BONE.spine2, _m9);
    // neck and head extend to keep the gaze ahead (a little down), and take the head turn
    setRx(_m9, 0, lean * 0.5); setRy(_n9, 0, look * 0.35); mul3(_n9, 0, _m9, 0, _m9, 0);
    this._fk(BONE.neck, _m9);
    setRx(_m9, 0, lean * 0.42 - 4 * D2R); setRy(_n9, 0, look * 0.65); mul3(_n9, 0, _m9, 0, _m9, 0);
    this._fk(BONE.head, _m9);
    // clavicles protract (shoulders come forward) as the arms reach for the bars
    const cf = (6 + 12 * Math.min(1, lean / 0.8)) * D2R;
    for (const s of ['L', 'R']) {
      const A = this.arm[s];
      setRy(_m9, 0, A.sg * cf);
      this._fk(A.b[0], _m9);
      app3(PR, A.b[0] * 9, r[A.b[1] * 3] - r[A.b[0] * 3], r[A.b[1] * 3 + 1] - r[A.b[0] * 3 + 1], r[A.b[1] * 3 + 2] - r[A.b[0] * 3 + 2], _p);
      PP[A.b[1] * 3] = PP[A.b[0] * 3] + _p[0]; PP[A.b[1] * 3 + 1] = PP[A.b[0] * 3 + 1] + _p[1]; PP[A.b[1] * 3 + 2] = PP[A.b[0] * 3 + 2] + _p[2];
    }
  }

  /** Shoulder-to-grip distance of the scratch pose's side s over the arm's reach. */
  _reachRatio(s, grip) {
    const b = this.arm[s].b[1] * 3;
    return Math.hypot(grip[0] - PP[b], grip[1] - PP[b + 1], grip[2] - PP[b + 2]) / this.arm[s].reach;
  }

  /** Trunk lean (rad) for a rider sitting at `sit` so both hands reach the grips with the elbows
   *  a little bent; at least `hint` (the bike's riding posture). */
  solveLean(sit, gripL, gripR, hint, pelvisK, want = 0.93) {
    const ratio = (lean) => { this._torso(sit, lean, pelvisK, 0, 0, 0); return Math.max(this._reachRatio('L', gripL), this._reachRatio('R', gripR)); };
    if (ratio(hint) <= want) return hint;
    let lo = hint, hi = 1.25;
    if (ratio(hi) > want) return hi;
    for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; if (ratio(m) > want) lo = m; else hi = m; }
    return hi;
  }

  /**
   * Arm of side s in the scratch pose (shoulder already placed) to a grip: hand-hold point `G`
   * (model space), thumb / index side towards `I`, elbow towards `pole`, wrist flexion `flex` (rad,
   * + towards the palm). palm = true places the palm flat on a surface instead of a grip in the fingers.
   */
  _armTo(s, G, I, pole, flex, palm = false) {
    const A = this.arm[s];
    const [, bA, bF, bH] = A.b;
    const sh = _a; sh[0] = PP[bA * 3]; sh[1] = PP[bA * 3 + 1]; sh[2] = PP[bA * 3 + 2];
    const off = palm ? A.palm : A.grip;
    // wrist target: grip minus the hand's offset (iterated: the hand's orientation follows the IK)
    const W = _b, E = _c, Wd = _d;
    set3(_e, G[0] - sh[0], G[1] - sh[1], G[2] - sh[2]); norm3(_e);
    W[0] = G[0] - _e[0] * 0.09 * this.k; W[1] = G[1] - _e[1] * 0.09 * this.k + 0.02 * this.k; W[2] = G[2] - _e[2] * 0.09 * this.k;
    for (let it = 0; it < 10; it++) {
      ik2(sh, W, this.ua, this.fa, pole, 0.985, E, Wd);
      set3(_f, E[0] - sh[0], E[1] - sh[1], E[2] - sh[2]);         // upper arm
      set3(_g, Wd[0] - E[0], Wd[1] - E[1], Wd[2] - E[2]);         // forearm
      cross3(_f, _g, _h); norm3(_h);
      frameMatch(PR, bA * 9, A.du, A.axis, _f, _h);
      frameMatch(PR, bF * 9, A.df, A.th, _g, I);
      setRaxis(_m9, 0, A.wd[0], A.wd[1], A.wd[2], flex);
      mul3(PR, bF * 9, _m9, 0, PR, bH * 9);
      // where the hold point ends up: move the wrist target by the miss
      app3(PR, bH * 9, off[0], off[1], off[2], _q);
      const mx = G[0] - (Wd[0] + _q[0]), my = G[1] - (Wd[1] + _q[1]), mz = G[2] - (Wd[2] + _q[2]);
      // (damped after a few steps: a palm laid flat can make the plain update overshoot)
      const g = it < 4 ? 1 : 0.6;
      W[0] = Wd[0] + mx * g; W[1] = Wd[1] + my * g; W[2] = Wd[2] + mz * g;
      this.miss = Math.sqrt(mx * mx + my * my + mz * mz);
      if (this.miss < 3e-4) break;
    }
    if (this.missStat) {
      const R = this.missStat;
      R.max = Math.max(R.max, this.miss); R.n++;
      if (this.miss > 0.005) { R.bad = (R.bad || 0) + 1; const d = Math.hypot(G[0] - sh[0], G[1] - sh[1], G[2] - sh[2]) / (this.ua + this.fa); R.far = Math.max(R.far || 0, d); if (d < 0.97) R.nonconv = (R.nonconv || 0) + 1; }
    }
    PP[bF * 3] = E[0]; PP[bF * 3 + 1] = E[1]; PP[bF * 3 + 2] = E[2];
    PP[bH * 3] = Wd[0]; PP[bH * 3 + 1] = Wd[1]; PP[bH * 3 + 2] = Wd[2];
  }

  /** Leg of side s in the scratch pose to an ankle target; foot rotation Rf (9 at fo). */
  _legTo(s, ankle, pole, Rf, fo) {
    const L = this.leg[s], r = this.rest;
    const [bT, bS, bF, bX] = L.b;
    // hip joint from the pelvis
    app3(PR, 9, r[bT * 3] - r[3], r[bT * 3 + 1] - r[4], r[bT * 3 + 2] - r[5], _p);
    const hip = _a; hip[0] = PP[3] + _p[0]; hip[1] = PP[4] + _p[1]; hip[2] = PP[5] + _p[2];
    const ratio = ik2(hip, ankle, this.l1, this.l2, pole, 0.999, _c, _d);
    set3(_f, _c[0] - hip[0], _c[1] - hip[1], _c[2] - hip[2]);
    set3(_g, _d[0] - _c[0], _d[1] - _c[1], _d[2] - _c[2]);
    cross3(_f, pole, _h); norm3(_h);
    cross3(_g, pole, _e); norm3(_e);
    if (dot3(_e, _h) < 0.2) set3(_e, _h[0], _h[1], _h[2]);
    frameMatch(PR, bT * 9, L.dT0, L.n0, _f, _h);
    frameMatch(PR, bS * 9, L.dS0, L.n0, _g, _e);
    for (let k = 0; k < 9; k++) { PR[bF * 9 + k] = Rf[fo + k]; PR[bX * 9 + k] = Rf[fo + k]; }
    PP[bT * 3] = hip[0]; PP[bT * 3 + 1] = hip[1]; PP[bT * 3 + 2] = hip[2];
    PP[bS * 3] = _c[0]; PP[bS * 3 + 1] = _c[1]; PP[bS * 3 + 2] = _c[2];
    PP[bF * 3] = _d[0]; PP[bF * 3 + 1] = _d[1]; PP[bF * 3 + 2] = _d[2];
    app3(PR, bF * 9, r[bX * 3] - r[bF * 3], r[bX * 3 + 1] - r[bF * 3 + 1], r[bX * 3 + 2] - r[bF * 3 + 2], _p);
    PP[bX * 3] = _d[0] + _p[0]; PP[bX * 3 + 1] = _d[1] + _p[1]; PP[bX * 3 + 2] = _d[2] + _p[2];
    return ratio;
  }

  /** Distance from side s's hip joint (scratch pose pelvis) to point q. */
  hipDist(s, q) {
    const b = this.leg[s].b[0] * 3, r = this.rest;
    app3(PR, 9, r[b] - r[3], r[b + 1] - r[4], r[b + 2] - r[5], _p);
    return Math.hypot(q[0] - PP[3] - _p[0], q[1] - PP[4] - _p[1], q[2] - PP[5] - _p[2]);
  }

  /** Ankle target for the sole under the ball of the foot at `ball` with foot rotation Rf. */
  ankleFor(s, ball, Rf, fo, out) {
    const o = this.leg[s].ankBall;
    app3(Rf, fo, o[0], o[1], o[2], out);
    out[0] += ball[0]; out[1] += ball[1]; out[2] += ball[2];
    return out;
  }

  /** Write the scratch pose as skin matrices into M (12 floats per bone), through X = Rx * p + t. */
  _write(M, X, t) {
    const r = this.rest;
    for (let b = 0; b < NB; b++) {
      const o = b * 12;
      let R = PR, ro = b * 9;
      if (X) { mul3(X, 0, PR, b * 9, _m9, 0); R = _m9; ro = 0; }
      let px = PP[b * 3], py = PP[b * 3 + 1], pz = PP[b * 3 + 2];
      if (X) { app3(X, 0, px, py, pz, _p); px = _p[0] + t[0]; py = _p[1] + t[1]; pz = _p[2] + t[2]; }
      const jx = r[b * 3], jy = r[b * 3 + 1], jz = r[b * 3 + 2];
      for (let row = 0; row < 3; row++) {
        const a0 = R[ro + row * 3], a1 = R[ro + row * 3 + 1], a2 = R[ro + row * 3 + 2];
        M[o + row * 4] = a0; M[o + row * 4 + 1] = a1; M[o + row * 4 + 2] = a2;
        M[o + row * 4 + 3] = (row === 0 ? px : row === 1 ? py : pz) - (a0 * jx + a1 * jy + a2 * jz);
      }
    }
  }

  /** Read bone b's posed rotation / joint position from skin matrices M into the scratch pose. */
  _read(M, b) {
    const o = b * 12, r = this.rest;
    for (let row = 0; row < 3; row++) for (let c = 0; c < 3; c++) PR[b * 9 + row * 3 + c] = M[o + row * 4 + c];
    const jx = r[b * 3], jy = r[b * 3 + 1], jz = r[b * 3 + 2];
    for (let row = 0; row < 3; row++) PP[b * 3 + row] = M[o + row * 4] * jx + M[o + row * 4 + 1] * jy + M[o + row * 4 + 2] * jz + M[o + row * 4 + 3];
  }

  _writeBone(M, b) {
    const o = b * 12, r = this.rest;
    const jx = r[b * 3], jy = r[b * 3 + 1], jz = r[b * 3 + 2];
    for (let row = 0; row < 3; row++) {
      const a0 = PR[b * 9 + row * 3], a1 = PR[b * 9 + row * 3 + 1], a2 = PR[b * 9 + row * 3 + 2];
      M[o + row * 4] = a0; M[o + row * 4 + 1] = a1; M[o + row * 4 + 2] = a2;
      M[o + row * 4 + 3] = PP[b * 3 + row] - (a0 * jx + a1 * jy + a2 * jz);
    }
  }

  /**
   * Re-pose one arm of a blended pose M (walking figures: stroller handle, bicycle grip or saddle).
   * The clavicle protracts by `clav` (rad) about the chest's vertical, then shoulder -> hand IK.
   */
  armOnto(M, s, G, I, pole, flex, clav = 0, palm = false) {
    const A = this.arm[s];
    const [bC, bA, bF, bH] = A.b;
    this._read(M, BONE.spine2);
    this._read(M, bC);
    if (clav) {
      // rotate the clavicle about the chest's up axis through its own joint
      const cu = BONE.spine2 * 9;
      setRaxis(_m9, 0, PR[cu + 1], PR[cu + 4], PR[cu + 7], A.sg * clav);
      mul3(_m9, 0, PR, bC * 9, PR, bC * 9);
    }
    const r = this.rest;
    app3(PR, bC * 9, r[bA * 3] - r[bC * 3], r[bA * 3 + 1] - r[bC * 3 + 1], r[bA * 3 + 2] - r[bC * 3 + 2], _p);
    PP[bA * 3] = PP[bC * 3] + _p[0]; PP[bA * 3 + 1] = PP[bC * 3 + 1] + _p[1]; PP[bA * 3 + 2] = PP[bC * 3 + 2] + _p[2];
    this._armTo(s, G, I, pole, flex, palm);
    this._writeBone(M, bC); this._writeBone(M, bA); this._writeBone(M, bF); this._writeBone(M, bH);
  }
}

// ------------------------------------------------------------------ mobility props + poses

const _M4 = new THREE.Matrix4();
const _anim = [0, 0, 0, 0];
const _att = {};
const _satt = {};
const _X = new Float64Array(9), _t = v3();
const _G = [v3(), v3()], _I = [v3(), v3()], _pole = v3(), _ball = v3(), _ank = v3();
const _RF = new Float64Array(18), _RG = new Float64Array(9);
const _hold = { x: 0, y: 0, z: 0 };
const _ropt = { roll: 0, crank: 0, steer: 0, saddle: 0 }, _sopt = { roll: 0, swivel: 0 };
const SIDES = [['L', 0], ['R', 1]];
const M3 = [0, 1, 2, 4, 5, 6, 8, 9, 10];     // the 3x3 part of a Matrix4's elements
const POLE_KNEE = [norm3([-0.1, 0.15, -1]), norm3([0.1, 0.15, -1])];   // L, R

/** Per-slot state of a figure with a mobility prop. */
function newMob() {
  return { key: '', prop: 0, kit: null, v: 0, look: null, ride: null, walk: null, roll: 0, crankOff: 0, crank: 0, steer: 0,
    lean: 0, pitch: 0, omega: 0, swivel: 0, stopW: 0, px: 0, py: 0, pz: 0, ph: 0, valid: false,
    offX: 0, offZ: 0, offL: 0, toX: 0, toZ: 0, toL: 0, fromX: 0, fromZ: 0, fromL: 0, fadeT0: -1, fadeDur: 0, pose: -1,
    sitR: v3(), sitS: v3(), footSide: -1, hold: 0, pushOff: 0.4 };
}

export class Mobility {
  constructor(app, humans, P) {
    this.app = app;
    this.h = humans;
    this.P = P;
    this.bikes = P.bicycleKit(app);
    this.strollers = P.strollerKit(app);
    // (far bicycles, a few pixels of spokes and tubes, cast no shadow; strollers always do)
    this.bikeInst = this.bikes.createInstancer({ capacity: 64, name: 'humans.bicycles', shadowLod: 1 });
    this.strollerInst = this.strollers.createInstancer({ capacity: 48, name: 'humans.strollers' });
    this.object = new THREE.Group();
    this.object.name = 'humans.props';
    this.object.add(this.bikeInst.object, this.strollerInst.object);
    this.posers = new Map();
    this.time = 0;
    this.reachStat = null;
    // test harness: force a bicycle / stroller variant (ht_var / ht_svar)
    const fv = app.params.num('ht_var', -1), fs = app.params.num('ht_svar', -1);
    this.forceV = fv >= 0 ? fv : null;
    this.forceS = fs >= 0 ? fs : null;
  }

  poser(B) {
    let p = this.posers.get(B);
    if (!p) { p = new Poser(B.rig); this.posers.set(B, p); }
    return p;
  }

  /** One mesh of each kit (created now), for the shader warm-up at start-up. */
  warmMeshes() {
    return [this.bikeInst._slot(0, 2).mesh, this.strollerInst._slot(0, 2).mesh];
  }

  begin(camera, renderer) {
    this.bikeInst.begin(camera, renderer);
    this.strollerInst.begin(camera, renderer);
  }

  end() {
    this.bikeInst.end();
    this.strollerInst.end();
  }

  stats() {
    const a = this.bikeInst.stats(), b = this.strollerInst.stats();
    return { props: a.props + b.props, draws: a.draws + b.draws, triangles: a.triangles + b.triangles };
  }

  /** Per-frame prop state of slot s (motion estimates, wheel roll, crank, lean): call for every
   *  visible figure in a mobility pose, before posing it. Returns the state or null. */
  track(s, a, dt, time) {
    const prop = s.pose === 3 ? 1 : s.pose === 4 || s.pose === 5 ? 2 : 0;
    if (!prop) { if (s.mob) s.mob.valid = false; return null; }
    const st = s.mob || (s.mob = newMob());
    const kit = prop === 1 ? this.strollers : this.bikes;
    const key = `${prop}:${s.propSeed | 0}:${s.appearance}`;
    if (st.key !== key) {
      st.key = key; st.prop = prop; st.kit = kit;
      st.look = prop === 1 ? kit.pick(s.propSeed | 0, { variant: this.forceS })
        : kit.pick(s.propSeed | 0, { riderHeight: a.height, child: a.age === 'child', variant: this.forceV });
      st.v = st.look.variant;
      st.ride = null;           // rider fit (frame size, saddle, lean) and walking stance are solved on first use
      st.walk = null;
      const h = hash2(s.propSeed | 0, 0x2b1d) >>> 0;
      st.footSide = (h & 3) === 0 ? 1 : -1;          // most riders put the left foot down
      st.hold = ((h >> 4) % 100) < 62 ? 0 : 1;       // walking a bike: near hand on the grip / grip + saddle
      st.roll = ((h >> 8) % 1000) / 1000 * 3;
      st.crankOff = 0;
      st.valid = false;
      if (prop === 1) {
        const d = kit.variants[st.v].dims;
        st.pushOff = Math.max(0.36, Math.min(0.46, (d.pushOffset ?? 0.4) + 0.12 * (a.height - 1.7)));
      }
    }
    // motion: heading rate (turn), slope (pitch)
    if (st.valid && dt > 0) {
      let dh = s.heading - st.ph;
      dh = ((dh + Math.PI) % TAU + TAU) % TAU - Math.PI;
      const w = Math.abs(dh) < 1 ? dh / dt : 0;
      st.omega += (w - st.omega) * Math.min(1, dt * 5);
      const dx = s.x - st.px, dz = s.z - st.pz, dy = s.y - st.py, dist = Math.hypot(dx, dz);
      if (dist > 0.004 && dist < 1.5) {
        // moving forward up a slope tips the nose up
        const fwd = (-Math.sin(s.heading) * dx - Math.cos(s.heading) * dz) >= 0 ? 1 : -1;
        const p = Math.max(-0.12, Math.min(0.12, Math.atan2(dy * fwd, dist)));
        st.pitch += (p - st.pitch) * Math.min(1, dt * 2.5);
      }
    } else if (!st.valid) { st.omega = 0; st.pitch = 0; }
    st.px = s.x; st.py = s.y; st.pz = s.z; st.ph = s.heading;
    const fresh = !st.valid;
    st.valid = true;
    const v = s.speed;
    st.roll += v * dt;
    // where the prop sits relative to the figure (local metres), blended over a pose change
    if (prop === 1) { st.toX = 0; st.toZ = -st.pushOff; st.toL = 0; }
    else if (s.pose === 4) {
      const d = kit.variants[st.v].dims;
      st.toX = 0; st.toZ = -(d.front + d.rear) / 2 * this._rideFit(st, a).k; st.toL = 0;
    } else {
      const fit = this._walkFit(st, a);
      st.toX = -fit.x; st.toZ = -fit.z; st.toL = 0.05;
    }
    if (st.pose !== s.pose) {
      if (st.pose >= 3 && !fresh) { st.fromX = st.offX; st.fromZ = st.offZ; st.fromL = st.offL; st.fadeT0 = time; st.fadeDur = 0.75; }
      else st.fadeDur = 0;
      st.pose = s.pose;
    }
    let w = 1;
    if (st.fadeDur > 0) { w = smooth01((time - st.fadeT0) / st.fadeDur); if (w >= 1) st.fadeDur = 0; }
    st.offX = st.fromX + (st.toX - st.fromX) * w;
    st.offZ = st.fromZ + (st.toZ - st.fromZ) * w;
    st.offL = st.fromL + (st.toL - st.fromL) * w;
    if (st.fadeDur === 0) { st.fromX = st.toX; st.fromZ = st.toZ; st.fromL = st.toL; }
    if (prop === 2) {
      const V = kit.variants[st.v];
      const wb = V.dims.wheelbase;
      if (s.pose === 4) {
        // standing still: a foot goes down and the bike tips towards it
        const want = 1 - smooth01((v - 0.25) / 0.9);
        st.stopW = fresh ? want : st.stopW + Math.max(-dt * 1.6, Math.min(dt * 1.6, want - st.stopW));
        const turnLean = s.leanIn !== null ? s.leanIn : Math.max(-0.45, Math.min(0.45, Math.atan((v * st.omega) / 9.81)));
        st.lean = turnLean * (1 - st.stopW) + st.stopW * -st.footSide * 0.13;
        st.steer = s.steerIn !== null ? s.steerIn : Math.max(-0.5, Math.min(0.5, Math.atan((wb * st.omega) / Math.max(0.8, v))));
        st.steer *= 1 - 0.6 * st.stopW;
        // cranks follow the gait phase; at a standstill the pedal of the foot that stays on is
        // brought round to the front (back-pedalling), ready to push off
        const ph = s.phase * TAU;
        if (st.stopW > 0.6 && v < 0.2) {
          const ready = st.footSide < 0 ? 50 * D2R : 230 * D2R;
          let d = ready - (ph + st.crankOff);
          d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
          st.crankOff += Math.max(-dt * 2.2, Math.min(dt * 2.2, d));
        }
        st.crank = ph + st.crankOff;
      } else {
        // walked: no pedalling; the front wheel follows the turn, the bike leans in a little
        st.stopW = 0;
        // (the hand on the grip steers: walkers keep the bars nearly straight)
        st.steer = Math.max(-0.25, Math.min(0.25, Math.atan((wb * st.omega) / Math.max(0.5, v)) * 0.6));
        st.lean = st.offL;
      }
    } else {
      // casters trail the turn
      const d = kit.variants[st.v].dims;
      if (v > 0.05) {
        const sw = Math.atan2(st.omega * d.length * 0.85, v);
        st.swivel += (sw - st.swivel) * Math.min(1, dt * 8);
      }
    }
    return st;
  }

  /** Draw the prop of slot s (after track). */
  draw(s, st) {
    const kit = st.kit;
    const ch = Math.cos(s.heading), sh = Math.sin(s.heading);
    // prop origin = figure position + Ry(heading) * offset
    const ox = s.x + ch * st.offX + sh * st.offZ, oz = s.z - sh * st.offX + ch * st.offZ;
    if (st.prop === 1) {
      kit.matrix(_M4, ox, s.y, oz, s.heading, 0, st.pitch);
      _sopt.roll = st.roll; _sopt.swivel = st.swivel;
      kit.anim(_anim, st.v, _sopt);
      this.strollerInst.add(st.v, _M4, _anim, st.look.look);
    } else {
      const fit = this._rideFit(st, s.a);
      kit.matrix(_M4, ox, s.y, oz, s.heading, st.lean, st.pitch);
      if (fit.k !== 1) {
        // frame size: the model scaled about its ground point (wheels roll on the smaller radius)
        const e = _M4.elements;
        for (const i of M3) e[i] *= fit.k;
      }
      _ropt.roll = st.roll / fit.k; _ropt.crank = st.crank; _ropt.steer = st.steer; _ropt.saddle = fit.saddle;
      kit.anim(_anim, st.v, _ropt);
      this.bikeInst.add(st.v, _M4, _anim, st.look.look);
    }
  }

  /**
   * Where someone walking this bike stands beside it (bike-local metres, the bike at its frame size)
   * and how they hold it: the near (right) hand on the left grip, or the left hand on that grip and
   * the right palm on the saddle. The stance is chosen per person so that the arms reach with the
   * elbows a little bent through the walk (cached per slot).
   */
  _walkFit(st, a) {
    if (st.walk) return st.walk;
    const B = this.h.bases[a.body];
    const P = this.poser(B);
    const sc = a.height / B.info.H;
    const k = this._rideFit(st, a).k;
    const at = this.bikes.attachments(st.v, 0, 0, this._rideFit(st, a).saddle, {});
    const gx = at.gripL.x * k, gy = at.gripL.y * k, gz = at.gripL.z * k;
    const hx = at.saddleNose.x * k, hy = (at.saddleNose.y + 0.01) * k, hz = (at.saddleNose.z * 0.4 + at.saddle.z * 0.6) * k;
    const r = P.rest;
    const ratio = (side, px, py, pz, wx, wz, palm) => {
      const b = BONE['arm' + side] * 3, A = P.arm[side];
      const reach = (palm ? P.ua + P.fa + 0.062 * (HAND_SCALE[B.rig.kind] ?? 1) : A.reach) * sc;
      return Math.hypot(px - wx - r[b] * sc, py - r[b + 1] * sc, pz - wz - r[b + 2] * sc) / reach;
    };
    let best = null;
    for (const hold of st.hold === 1 ? [1, 0] : [0]) {
      for (const wx of [-0.38, -0.42, -0.46]) {
        for (let i = 0; i <= 24; i++) {
          const wz = gz + 0.18 + (i / 24) * 0.5;
          let f;
          if (hold === 0) f = Math.abs(ratio('R', gx, gy, gz, wx, wz, false) - 0.8) + 0.02 * Math.abs(wx + 0.42);
          else f = Math.max(ratio('L', gx, gy, gz, wx, wz, false), ratio('R', hx, hy, hz, wx, wz, true)) + 0.02 * Math.abs(wx + 0.42);
          if (!best || f < best.f) best = { f, hold, x: wx, z: wz };
        }
      }
      if (hold === 1 && best.f <= 0.86) break;       // both hands reach: keep the two-handed hold
      if (hold === 1) best = null;
    }
    st.hold = best.hold;
    st.walk = { x: best.x, z: best.z };
    return st.walk;
  }

  /**
   * Rider fit for this bike and body (cached per slot): frame size, saddle height, trunk lean.
   * Bikes come in frame sizes: the shared model is scaled per rider (k, about 0.85-1.05; a small
   * frame on smaller wheels for a short rider) and the seat post set so the knee stays a little
   * bent with the pedal at its lowest. All attachment points are bike-local x k.
   */
  _rideFit(st, a) {
    if (st.ride) return st.ride;
    const B = this.h.bases[a.body];
    const P = this.poser(B);
    const kit = this.bikes, v = st.v, V = kit.variants[v];
    const sc = a.height / B.info.H;
    const fit = { saddle: kit.saddleFor(v, a.height), lean: 0, pk: 0.5, sc, k: 1, kk: 1 / sc, P };
    const sit = v3(), gL = v3(), gR = v3();
    const hint = (V.dims.riderLean ?? 0.3) + (a.stoop || 0) * 0.5 + ((hash2(a.seed | 0, 77) >>> 0) % 100) / 100 * 0.08;
    fit.pk = 0.42 + 0.2 * Math.min(1, hint / 0.8);
    const toM = (p, o) => set3(o, p.x * fit.kk, p.y * fit.kk, p.z * fit.kk);
    const lean = () => {
      kit.attachments(v, 0, 0, fit.saddle, _att);
      toM(_att.saddle, sit); toM(_att.gripL, gL); toM(_att.gripR, gR);
      return P.solveLean(sit, gL, gR, hint, fit.pk);
    };
    // largest hip -> ankle distance over the crank turn (x leg length), trunk lean l
    const maxReach = (saddle, l) => {
      fit.saddle = saddle;
      kit.attachments(v, 0, 0, saddle, _att);
      toM(_att.saddle, sit);
      P._torso(sit, l, fit.pk, 0, 0, 0);
      let m = 0;
      for (let i = 0; i < 12; i++) {
        const c = (i / 12) * TAU;
        kit.attachments(v, c, 0, saddle, _att);
        footRot(_RF, 9, 1, pedalPitch(c), 0, 0);
        toM(_att.pedalR, _ball); _ball[1] += 0.013 * fit.kk;
        P.ankleFor('R', _ball, _RF, 9, _ank);
        m = Math.max(m, P.hipDist('R', _ank));
      }
      return m / P.legLen;
    };
    // seat post: as low as the frame allows (clamp 3 cm above the seat tube) up to a long post
    const L = V.layout;
    const post = (V.spec.saddleH - L.saddleT - L.stTop.y) / L.seatDir.y;
    const lo0 = Math.max(V.dims.saddleRange[0] - 0.08, -(post - 0.03)), hi0 = V.dims.saddleRange[1] + 0.1;
    const want = 0.955;
    const solve = (k) => {
      fit.k = k; fit.kk = k / sc;
      fit.saddle = kit.saddleFor(v, a.height / k);
      const l = lean();
      let lo = lo0, hi = hi0;
      if (maxReach(hi, l) <= want) return { saddle: hi, r: maxReach(hi, l) };
      const rl = maxReach(lo, l);
      if (rl >= want) return { saddle: lo, r: rl };
      for (let i = 0; i < 10; i++) { const m = (lo + hi) / 2; if (maxReach(m, l) > want) hi = m; else lo = m; }
      return { saddle: lo, r: want };
    };
    // frame size: the standard frame unless the rider cannot reach (short) or sits far too low (tall)
    let res = solve(1);
    if (res.r > want + 0.01) {
      for (const k of [0.95, 0.9, 0.86]) { res = solve(k); if (res.r <= want + 0.01) break; }
    } else if (res.saddle >= hi0 - 1e-3 && res.r < 0.93) {
      res = solve(1.04);
    }
    fit.saddle = res.saddle;
    fit.lean = lean();
    st.sitR.set(sit);
    // standing astride with a foot down: off the saddle's nose, trunk more upright
    kit.attachments(v, 0, 0, fit.saddle, _att);
    set3(st.sitS, st.footSide * 0.05 / sc, 0, _att.saddleNose.z * fit.kk - 0.1 / sc);
    st.ride = fit;
    return fit;
  }

  /**
   * Pose a figure in a mobility pose into M (model-space skin matrices). For walking poses M
   * already holds the blended walk; for riding it is overwritten. Returns false if nothing was done.
   */
  pose(s, a, B, M) {
    const st = s.mob;
    if (!st) return false;
    const P = this.poser(B);
    const sc = a.height / B.info.H;
    if (s.pose === 4) return this._ride(s, a, M, st, P, sc);
    const flexGrip = -14 * D2R;
    if (s.pose === 3) {
      const kit = this.strollers;
      kit.attachments(st.v, _satt);
      // grips in the figure's model space: (offset + Rx(pitch) grip) / sc
      for (let i = 0; i < 2; i++) {
        const g = i ? _satt.gripR : _satt.gripL;
        const cp = Math.cos(st.pitch), sp = Math.sin(st.pitch);
        set3(_G[i], (st.offX + g.x) / sc, (cp * g.y - sp * g.z) / sc, (st.offZ + sp * g.y + cp * g.z) / sc);
        set3(_I[i], i ? -1 : 1, 0, 0);
      }
      for (const [s_, i] of SIDES) {
        const sg = i ? 1 : -1;
        set3(_pole, sg * 0.45, -0.55, 0.6); norm3(_pole);
        P.armOnto(M, s_, _G[i], _I[i], _pole, flexGrip, 7 * D2R);
      }
      return true;
    }
    // walking a bike: near (right) hand on the bike's left grip; some hold the grip with the left
    // hand and rest the right on the saddle
    const kit = this.bikes;
    const fit = this._rideFit(st, a), k = fit.k;
    kit.attachments(st.v, st.crank, st.steer, fit.saddle, _att);
    const toFig = (p, o) => {
      // bike-local -> figure model space: offset + Rz(lean) k p (pitch ignored for the hands)
      const c = Math.cos(st.lean) * k, sn = Math.sin(st.lean) * k;
      return set3(o, (st.offX + c * p.x - sn * p.y) / sc, (sn * p.x + c * p.y) / sc, (st.offZ + k * p.z) / sc);
    };
    if (st.hold === 0) {
      toFig(_att.gripL, _G[1]);
      set3(_I[1], _att.gripDirL.x, _att.gripDirL.y, _att.gripDirL.z);
      set3(_pole, 0.35, -0.6, 0.55); norm3(_pole);
      P.armOnto(M, 'R', _G[1], _I[1], _pole, flexGrip, 4 * D2R);
    } else {
      toFig(_att.gripL, _G[0]);
      set3(_I[0], -_att.gripDirL.x, -_att.gripDirL.y, -_att.gripDirL.z);
      set3(_pole, -0.5, -0.55, 0.55); norm3(_pole);
      P.armOnto(M, 'L', _G[0], _I[0], _pole, flexGrip, 6 * D2R);
      // right palm on the front of the saddle, fingers forward, the arm hanging down to it
      const sp = _att.saddle, sn = _att.saddleNose;
      _hold.x = sn.x; _hold.y = sn.y + 0.01; _hold.z = sn.z * 0.4 + sp.z * 0.6;
      toFig(_hold, _G[1]);
      set3(_I[1], -0.35, 0, -1); norm3(_I[1]);
      set3(_pole, 0.35, -0.75, 0.55); norm3(_pole);
      P.armOnto(M, 'R', _G[1], _I[1], _pole, -25 * D2R, 0, true);
    }
    return true;
  }

  _ride(s, a, M, st, P, sc) {
    const kit = this.bikes, v = st.v, V = kit.variants[v];
    const fit = this._rideFit(st, a);
    const crank = st.crank;
    kit.attachments(v, crank, st.steer, fit.saddle, _att);
    const kk = fit.kk;
    const toM = (p, o) => set3(o, p.x * kk, p.y * kk, p.z * kk);
    const w = smooth01(st.stopW);
    // pelvis: riding (sit bones on the saddle) -> standing astride (off the nose)
    const sitR = _c; toM(_att.saddle, sitR);
    const lean = fit.lean * (1 - 0.45 * w);
    const pk = fit.pk * (1 - 0.7 * w);
    // pedalling rocks the pelvis a little (more for upright riders)
    const sway = (1 - w) * Math.min(1, s.speed / 1.5);
    // (standing astride, the body stays upright while the bike tips towards the foot that is down)
    const roll = sway * 1.6 * D2R * Math.sin(crank) * (1.2 - 0.5 * Math.min(1, fit.lean)) - w * st.lean;
    // the shoulders turn with the bars (the far grip comes back towards the rider)
    const yaw = sway * 1.2 * D2R * Math.cos(crank) + st.steer * 0.5;
    // bike-local ground under the foot that goes down (the bike leans by st.lean)
    const fs = st.footSide;                        // -1 left foot down
    const sideK = fs < 0 ? 'L' : 'R';
    const tl = Math.tan(st.lean), tp = Math.tan(st.pitch);
    const sit = _e;
    if (w > 0.001) {
      // standing: hip height such that the down leg is nearly straight to the ground
      const gx = fs * (0.27 + 0.05 * (V.dims.width - 0.55)), gz = st.sitS[2] * sc - 0.05;
      const gy = (tp * gz) / Math.max(0.5, Math.cos(st.lean)) - tl * gx;
      footRot(_RG, 0, fs, -6 * D2R, -st.lean, -st.pitch);
      set3(_ball, gx / sc, gy / sc, gz / sc);
      P.ankleFor(sideK, _ball, _RG, 0, _ank);
      const hipX = st.sitS[0] + fs * P.hipHalf;
      const L = P.legLen * 0.975;
      const dx = _ank[0] - hipX, dz = _ank[2] - st.sitS[2];
      const hipY = _ank[1] + Math.sqrt(Math.max(0.01, L * L - dx * dx - dz * dz));
      const sitSy = Math.min(sitR[1], hipY - (P.hipC[1] - P.isch[1]));
      sit[0] = sitR[0] + (st.sitS[0] - sitR[0]) * w;
      sit[1] = sitR[1] + (sitSy - sitR[1]) * w;
      sit[2] = sitR[2] + (st.sitS[2] - sitR[2]) * w;
    } else set3(sit, sitR[0], sitR[1], sitR[2]);
    P._torso(sit, lean, pk, roll, yaw, Math.max(-1.1, Math.min(1.1, s.look || 0)));
    // hands on the grips
    const drop = V.spec.bar.type === 'drop';
    for (const [k, i] of SIDES) {
      const g = i ? _att.gripR : _att.gripL, gd = i ? _att.gripDirR : _att.gripDirL;
      const sg = i ? 1 : -1;
      if (drop) {
        // on the hoods (handshake grip): the palm rests on the hood's top inner side, thumb up and in
        set3(_G[i], g.x * kk - sg * 0.004 / sc, g.y * kk + 0.004 / sc, g.z * kk);
        set3(_I[i], -sg * 0.8, 0.6, 0); norm3(_I[i]);
        set3(_pole, sg * 0.45, -0.75, 0.35); norm3(_pole);
        P._armTo(k, _G[i], _I[i], _pole, -8 * D2R, true);
      } else {
        // round the grip, thumb towards the stem
        toM(g, _G[i]);
        set3(_I[i], -gd.x, -gd.y, -gd.z);
        set3(_pole, sg * 0.3, -0.75, 0.5); norm3(_pole);
        P._armTo(k, _G[i], _I[i], _pole, -12 * D2R);
      }
    }
    // legs: the ball of each foot on its pedal, the ankle working through the stroke
    for (const [k, i] of SIDES) {
      const ped = i ? _att.pedalR : _att.pedalL;
      const ca = i ? crank : crank + Math.PI;        // this foot's crank angle (0 = up)
      footRot(_RF, i * 9, i ? 1 : -1, pedalPitch(ca), 0, 0);
      toM(ped, _ball); _ball[1] += 0.013 * kk; _ball[2] += 0.008 * kk;
      P.ankleFor(k, _ball, _RF, i * 9, _ank);
      // a rider whose leg is short for this bike even with the saddle right down points the toes
      // further at the bottom of the stroke instead of straightening the knee off the pedal
      if (P.hipDist(k, _ank) > 0.972 * P.legLen) {
        let lo = 0, hi = 0.7;
        for (let it = 0; it < 7; it++) {
          const m = (lo + hi) / 2;
          footRot(_RF, i * 9, i ? 1 : -1, pedalPitch(ca) - m, 0, 0);
          P.ankleFor(k, _ball, _RF, i * 9, _ank);
          if (P.hipDist(k, _ank) > 0.972 * P.legLen) lo = m; else hi = m;
        }
        footRot(_RF, i * 9, i ? 1 : -1, pedalPitch(ca) - hi, 0, 0);
        P.ankleFor(k, _ball, _RF, i * 9, _ank);
      }
      if (k === sideK && w > 0.001) {
        // the foot leaves its pedal and steps down beside the bike (lifted clear on the way)
        const gx = fs * (0.27 + 0.05 * (V.dims.width - 0.55)), gz = st.sitS[2] * sc - 0.05;
        const gy = (tp * gz) / Math.max(0.5, Math.cos(st.lean)) - tl * gx;
        footRot(_RG, 0, fs, -6 * D2R, -st.lean, -st.pitch);
        set3(_ball, gx / sc, gy / sc, gz / sc);
        P.ankleFor(k, _ball, _RG, 0, _d);
        const u = w, lift = 0.07 / sc * Math.sin(Math.PI * u);
        _ank[0] += (_d[0] - _ank[0]) * u; _ank[1] += (_d[1] - _ank[1]) * u + lift; _ank[2] += (_d[2] - _ank[2]) * u;
        blendRot(_RF, i * 9, _RG, 0, u);
      }
      set3(_pole, POLE_KNEE[i][0], POLE_KNEE[i][1], POLE_KNEE[i][2]);
      const reach = P._legTo(k, _ank, _pole, _RF, i * 9);
      // (testing: leg reach statistics, hip-to-ankle over leg length; >= 0.999 would straighten the knee)
      const R = this.reachStat;
      if (R && w < 0.001) { R.min = Math.min(R.min, reach); R.max = Math.max(R.max, reach); R.n++; }
    }
    // into the figure's model space: X = Rx(pitch) Rz(lean), t = prop offset / sc
    setRx(_X, 0, st.pitch); setRz(_m9, 0, st.lean); mul3(_X, 0, _m9, 0, _X, 0);
    set3(_t, st.offX / sc, 0, st.offZ / sc);
    P._write(M, _X, _t);
    return true;
  }
}

/** Foot rotation: Rpre * Ry(toe out) * Rx(pitch) with Rpre = Rz(roll) Rx(pitchW) (ground tilt). */
function footRot(out, o, sg, pitch, roll, pitchW) {
  setRy(_m9, 0, -sg * 6 * D2R);
  setRx(_n9, 0, pitch);
  mul3(_m9, 0, _n9, 0, out, o);
  if (roll || pitchW) {
    setRz(_m9, 0, roll); setRx(_n9, 0, pitchW); mul3(_m9, 0, _n9, 0, _m9, 0);
    mul3(_m9, 0, out, o, out, o);
  }
}

/** out(o) = orthonormalised lerp(out(o), B(bo), u) (small angles). */
function blendRot(out, o, Bm, bo, u) {
  for (let k = 0; k < 9; k++) out[o + k] += (Bm[bo + k] - out[o + k]) * u;
  // Gram-Schmidt on the columns
  let ax = out[o], ay = out[o + 3], az = out[o + 6];
  let l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
  let bx = out[o + 1], by = out[o + 4], bz = out[o + 7];
  const d = ax * bx + ay * by + az * bz;
  bx -= ax * d; by -= ay * d; bz -= az * d;
  l = Math.hypot(bx, by, bz) || 1; bx /= l; by /= l; bz /= l;
  out[o] = ax; out[o + 3] = ay; out[o + 6] = az;
  out[o + 1] = bx; out[o + 4] = by; out[o + 7] = bz;
  out[o + 2] = ay * bz - az * by; out[o + 5] = az * bx - ax * bz; out[o + 8] = ax * by - ay * bx;
}

/** Foot pitch on the pedal through the stroke (rad, + toe up): ankling, toes lowest on the upstroke. */
function pedalPitch(ca) {
  return -(15 + 10 * Math.cos(ca - 210 * D2R)) * D2R;
}
