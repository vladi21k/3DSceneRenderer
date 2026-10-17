import * as THREE from 'three';

// Procedural motion for the crowd figures, baked once per base skeleton into skin
// matrices (bone world x inverse bind, 3x4 row-major, 12 floats per bone).
//
// Walks are driven by foot placement: each foot rolls heel -> flat -> ball while it is
// planted (so it never slides relative to the street), swings along a clearance arc,
// and 2-bone IK solves hips and knees. The pelvis height falls out of the leg lengths
// (inverted pendulum), giving the natural vertical bob. Pelvis rotation / list /
// sway, thorax counter-rotation, stabilised head and counter-swinging arms with
// elbow flexion follow published gait kinematics.
//
// Rest pose: every bone's rest orientation is the identity in model space (figure
// faces -Z, right = +X), so a bone's world matrix is [R | p] and its skin matrix is
// [R | p - R * restJoint].

export const CLIPS = [
  // name, frames, kind, params
  { name: 'walkSlow', frames: 40, kind: 'walk', v: 0.75 },
  { name: 'walk', frames: 40, kind: 'walk', v: 1.25 },
  { name: 'walkBrisk', frames: 40, kind: 'walk', v: 1.75 },
  { name: 'walkOld', frames: 40, kind: 'walk', v: 0.95, old: true },
  { name: 'idle', frames: 64, kind: 'idle', variant: 0 },
  { name: 'idlePhone', frames: 64, kind: 'idle', variant: 1 },
  { name: 'idleCross', frames: 64, kind: 'idle', variant: 2 },
  { name: 'idlePocket', frames: 64, kind: 'idle', variant: 3 },
  { name: 'sit', frames: 32, kind: 'sit', variant: 0 },
  { name: 'sitBack', frames: 32, kind: 'sit', variant: 1 },
  { name: 'sitLean', frames: 32, kind: 'sit', variant: 2 },
];
export const CLIP = Object.fromEntries(CLIPS.map((c, i) => [c.name, i]));
export const SEAT_HEIGHT = 0.46;

const B = {
  root: 0, pelvis: 1, spine1: 2, spine2: 3, neck: 4, head: 5,
  clavL: 6, armL: 7, foreL: 8, handL: 9, clavR: 10, armR: 11, foreR: 12, handR: 13,
  thighL: 14, shinL: 15, footL: 16, toeL: 17, thighR: 18, shinR: 19, footR: 20, toeR: 21,
};
export const BONE = B;
const NB = 22;
const DEG = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);

const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const smoother = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * t * (t * (t * 6 - 15) + 10); };
const qAxis = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(axis, deg * DEG);
const qEuler = (x, y, z, order = 'YXZ') => new THREE.Quaternion().setFromEuler(new THREE.Euler(x * DEG, y * DEG, z * DEG, order));

/** Rotation taking frame (d0, n0) onto (d1, n1); d = bone direction, n = secondary axis. */
function matchFrames(d0, n0, d1, n1) {
  const a = d0.clone().normalize(), b = d1.clone().normalize();
  const na = n0.clone().addScaledVector(a, -n0.dot(a)).normalize();
  const nb = n1.clone().addScaledVector(b, -n1.dot(b)).normalize();
  const M0 = new THREE.Matrix4().makeBasis(a, na, new THREE.Vector3().crossVectors(a, na));
  const M1 = new THREE.Matrix4().makeBasis(b, nb, new THREE.Vector3().crossVectors(b, nb));
  return new THREE.Quaternion().setFromRotationMatrix(M1.multiply(M0.transpose()));
}

/** Two-bone IK: returns the mid joint position bending towards `pole`. */
function solveIK(root, target, l1, l2, pole, reach = 0.999) {
  const dv = target.clone().sub(root);
  let d = dv.length();
  const u = dv.divideScalar(d || 1);
  d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-3), (l1 + l2) * reach);
  const v = pole.clone().addScaledVector(u, -pole.dot(u)).normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  return { mid: root.clone().addScaledVector(u, a).addScaledVector(v, h), end: root.clone().addScaledVector(u, d) };
}

export class Rig {
  constructor(skel, info) {
    this.parent = skel.parent;
    this.rest = skel.joints.map((j) => new THREE.Vector3(...j));
    this.info = info;
    const R = this.rest;
    this.H = info.H;
    this.side = { L: -1, R: 1 };
    this.l1 = R[B.thighR].distanceTo(R[B.shinR]);
    this.l2 = R[B.shinR].distanceTo(R[B.footR]);
    this.ua = R[B.armR].distanceTo(R[B.foreR]);
    this.fa = R[B.foreR].distanceTo(R[B.handR]);
    this.ankleY = R[B.footR].y;
    this.heelZ = info.heelZ;
    this.toeZ = info.toeZ;
    this.hipY = R[B.thighR].y;
    // foot landmarks relative to the ankle, per side (x from the rest skeleton)
    this.foot = {};
    for (const s of ['L', 'R']) {
      const an = R[B['foot' + s]], toe = R[B['toe' + s]];
      this.foot[s] = {
        heel: new THREE.Vector3(an.x, 0, info.heelZ),
        ball: new THREE.Vector3(toe.x, 0, toe.z),
        tip: new THREE.Vector3(toe.x + (toe.x - an.x) * 0.25, 0.012, info.toeZ),
        ankle: an.clone(),
      };
    }
    // elbow hinge axes and rest flexion; rest palm normal (faces the thigh, as sculpted)
    this.elbow = {};
    for (const s of ['L', 'R']) {
      const sh = R[B['arm' + s]], el = R[B['fore' + s]], wr = R[B['hand' + s]];
      const du = el.clone().sub(sh).normalize(), df = wr.clone().sub(el).normalize();
      const axis = new THREE.Vector3().crossVectors(du, new THREE.Vector3(0, 0, -1)).normalize();
      const ha = df.clone().add(new THREE.Vector3(0, 0, -0.05)).normalize();
      const pn = new THREE.Vector3().crossVectors(ha, new THREE.Vector3(0, 0, 1)).multiplyScalar(this.side[s]).normalize();
      this.elbow[s] = { axis, rest: Math.acos(Math.min(1, du.dot(df))) / DEG, du, df, pn };
    }
  }

  /** Builds world rotations / positions for one pose description. */
  solve(P) {
    const R = this.rest, par = this.parent;
    const q = Array.from({ length: NB }, () => new THREE.Quaternion());
    const p = Array.from({ length: NB }, () => new THREE.Vector3());
    const fk = (b, local) => {
      const pa = par[b];
      q[b].copy(q[pa]).multiply(local || new THREE.Quaternion());
      p[b].copy(R[b]).sub(R[pa]).applyQuaternion(q[pa]).add(p[pa]);
    };
    // pelvis + spine
    p[B.pelvis].copy(R[B.pelvis]).add(P.pelvisOffset);
    q[B.pelvis].copy(P.pelvisQ);
    fk(B.spine1, P.spine1Q);
    fk(B.spine2, P.spine2Q);
    fk(B.neck, P.neckQ);
    fk(B.head, P.headQ);
    // arms
    for (const s of ['L', 'R']) {
      const sg = this.side[s], A = P.arm[s];
      fk(B['clav' + s], A.clavQ);
      if (A.ik) { this._armIK(s, A, q, p, fk); continue; }
      // upper arm direction in the thorax frame: abduction then forward flexion
      const abd = A.abd * DEG, fl = A.flex * DEG;
      const dir = new THREE.Vector3(sg * Math.sin(abd), -Math.cos(abd), 0).applyAxisAngle(X, fl);
      const fwd = new THREE.Vector3(0, 0, -1).applyAxisAngle(X, fl);
      const du = this.elbow[s].du;
      let local = matchFrames(du, new THREE.Vector3(0, 0, -1), dir, fwd);
      // twist about the arm axis: + external rotation, - internal (forearm across the body)
      if (A.twist) local = qAxis(dir, A.twist * sg).multiply(local);
      // the clavicle carries the arm; express the thorax-frame rotation relative to it
      const clavInv = (A.clavQ || new THREE.Quaternion()).clone().invert();
      fk(B['arm' + s], clavInv.multiply(local));
      fk(B['fore' + s], qAxis(this.elbow[s].axis, A.elbow - this.elbow[s].rest));
      fk(B['hand' + s], A.handQ);
    }
    // legs: IK to ankle targets, then foot orientation in world
    for (const s of ['L', 'R']) {
      const L = P.leg[s];
      const hip = R[B['thigh' + s]].clone().sub(R[B.pelvis]).applyQuaternion(q[B.pelvis]).add(p[B.pelvis]);
      const pole = L.pole || new THREE.Vector3(0, 0, -1);
      const ik = solveIK(hip, L.ankle, this.l1, this.l2, pole);
      const dT0 = R[B['shin' + s]].clone().sub(R[B['thigh' + s]]);
      const dS0 = R[B['foot' + s]].clone().sub(R[B['shin' + s]]);
      const n0 = new THREE.Vector3().crossVectors(dT0, new THREE.Vector3(0, 0, -1)).normalize();
      const dT = ik.mid.clone().sub(hip), dS = ik.end.clone().sub(ik.mid);
      const n1 = new THREE.Vector3().crossVectors(dT, pole).normalize();
      const n1s = new THREE.Vector3().crossVectors(dS, pole).normalize();
      if (n1s.dot(n1) < 0.2) n1s.copy(n1);
      p[B['thigh' + s]].copy(hip);
      q[B['thigh' + s]].copy(matchFrames(dT0, n0, dT, n1));
      p[B['shin' + s]].copy(ik.mid);
      q[B['shin' + s]].copy(matchFrames(dS0, n0, dS, n1s));
      p[B['foot' + s]].copy(ik.end);
      q[B['foot' + s]].copy(L.footQ);
      const toeLocal = qAxis(X, L.toe || 0);
      q[B['toe' + s]].copy(q[B['foot' + s]]).multiply(toeLocal);
      p[B['toe' + s]].copy(R[B['toe' + s]]).sub(R[B['foot' + s]]).applyQuaternion(q[B['foot' + s]]).add(p[B['foot' + s]]);
    }
    return { q, p };
  }

  /** Arm placed by two-bone IK: wrist target, elbow pole and palm direction given in the
   *  rest-pose thorax frame (they follow the posed chest). */
  _armIK(s, A, q, p, fk) {
    const R = this.rest, E = this.elbow[s];
    const cq = q[B.spine2], cp = p[B.spine2];
    const toModel = (v) => v.clone().sub(R[B.spine2]).applyQuaternion(cq).add(cp);
    fk(B['arm' + s]);                                  // shoulder joint position
    const sh = p[B['arm' + s]].clone();
    const ik = solveIK(sh, toModel(A.ik.target), this.ua, this.fa, A.ik.pole.clone().applyQuaternion(cq), 0.985);
    const dU = ik.mid.clone().sub(sh), dF = ik.end.clone().sub(ik.mid);
    const nU = new THREE.Vector3().crossVectors(dU, dF).normalize();
    q[B['arm' + s]].copy(matchFrames(E.du, E.axis, dU, nU));
    p[B['fore' + s]].copy(ik.mid);
    q[B['fore' + s]].copy(matchFrames(E.df, E.pn, dF, A.ik.palm.clone().applyQuaternion(cq)));
    p[B['hand' + s]].copy(ik.end);
    q[B['hand' + s]].copy(q[B['fore' + s]]).multiply(A.handQ || new THREE.Quaternion());
  }

  /** Skin matrices (12 floats per bone) for a solved pose. */
  skin(pose, out, off) {
    const m = new THREE.Matrix4(), t = new THREE.Vector3();
    for (let b = 0; b < NB; b++) {
      m.makeRotationFromQuaternion(pose.q[b]);
      t.copy(this.rest[b]).applyQuaternion(pose.q[b]);
      const e = m.elements; // column-major
      const o = off + b * 12;
      const px = pose.p[b].x - t.x, py = pose.p[b].y - t.y, pz = pose.p[b].z - t.z;
      out[o] = e[0]; out[o + 1] = e[4]; out[o + 2] = e[8]; out[o + 3] = px;
      out[o + 4] = e[1]; out[o + 5] = e[5]; out[o + 6] = e[9]; out[o + 7] = py;
      out[o + 8] = e[2]; out[o + 9] = e[6]; out[o + 10] = e[10]; out[o + 11] = pz;
    }
  }

  /** Model-space positions of the foot contact points for a pose (for ground checks). */
  footPoints(pose, s) {
    const f = this.foot[s], qf = pose.q[B['foot' + s]], pf = pose.p[B['foot' + s]];
    const qt = pose.q[B['toe' + s]], pt = pose.p[B['toe' + s]];
    const toeJ = this.rest[B['toe' + s]];
    return {
      heel: f.heel.clone().sub(f.ankle).applyQuaternion(qf).add(pf),
      ball: f.ball.clone().sub(f.ankle).applyQuaternion(qf).add(pf),
      tip: f.tip.clone().sub(toeJ).applyQuaternion(qt).add(pt),
    };
  }

  // ------------------------------------------------------------------ pose generators

  basePose() {
    const arm = () => ({ abd: 7, flex: 0, elbow: 14, clavQ: new THREE.Quaternion(), handQ: new THREE.Quaternion(), twist: 0 });
    return {
      pelvisOffset: new THREE.Vector3(), pelvisQ: new THREE.Quaternion(),
      spine1Q: new THREE.Quaternion(), spine2Q: new THREE.Quaternion(),
      neckQ: new THREE.Quaternion(), headQ: new THREE.Quaternion(),
      arm: { L: arm(), R: arm() },
      leg: { L: { ankle: this.rest[B.footL].clone(), footQ: new THREE.Quaternion(), toe: 0 },
        R: { ankle: this.rest[B.footR].clone(), footQ: new THREE.Quaternion(), toe: 0 } },
    };
  }

  /** Walk cycle sample. phase 0 = right heel strike, 0.5 = left heel strike. */
  walkParams(clip) {
    const k = this.H / 1.76;                 // body scale relative to the reference adult
    const legL = (this.l1 + this.l2) / 0.835;
    const v = clip.v * Math.sqrt(k);         // dynamically similar speed for this body
    // walk ratio model: step length = sqrt(WR * v * 60), WR scales with stature
    const wr = 0.0065 * legL * (clip.old ? 0.82 : 1);
    const step = Math.sqrt(wr * v * 60);
    const S = 2 * step;
    const sn = S / (1.42 * legL);            // stride relative to a normal adult walk
    return {
      v, S, sn, old: !!clip.old,
      D: clip.old ? 0.65 : THREE.MathUtils.clamp(0.66 - 0.05 * (v - 0.75), 0.58, 0.66),
      armAmp: (clip.old ? 6 : 6 + 13 * sn * sn) * (clip.v > 1.5 ? 1.15 : 1),
      lean: clip.old ? 7 : 2.5 + 2.5 * (sn - 0.8),
      stepHalfW: 0.055 * legL + (clip.old ? 0.025 : 0),
    };
  }

  walkPose(phase, W) {
    const P = this.basePose();
    const { S, D } = W;
    const phiVert = 0.27;              // stance foot under the hip (mid-stance)
    const ffEnd = 0.07;                // heel rocker ends (foot flat)
    const hoStart = 0.33 + 0.02 * (1 - W.sn); // heel off: roll over the ball
    const tbStart = hoStart + 0.62 * (D - hoStart); // then over the toe tips until toe-off
    const thHS = 14 + 4 * W.sn, thB = -(26 + 6 * W.sn), thTO = -(50 + 12 * W.sn);
    const legs = {};
    for (const s of ['L', 'R']) {
      const sg = this.side[s];
      const f = this.foot[s];
      const phi = ((phase - (s === 'R' ? 0 : 0.5)) % 1 + 1) % 1;
      const xLat = sg * W.stepHalfW;     // feet land close to the line of progression
      const relHeel = (ph) => f.heel.z + S * (ph - phiVert);
      const rot = (v, th) => v.clone().applyAxisAngle(X, th * DEG);
      const ballAt = (ph) => new THREE.Vector3(xLat + (f.ball.x - f.heel.x), 0, relHeel(ph) + (f.ball.z - f.heel.z));
      // ankle while rolling over the ball with toes flat, then the whole foot pivots on the toe tip
      const ankleBall = (ph, th) => ballAt(ph).add(rot(f.ankle.clone().sub(f.ball), th));
      const toeTip = (ph) => ballAt(ph).add(new THREE.Vector3(0, 0, f.tip.z - f.ball.z));
      const ankleToe = (ph, th) => {
        const a0 = ankleBall(ph, thB);       // configuration when the toe rocker starts (toes flat)
        const tip = toeTip(ph);
        return tip.clone().add(rot(a0.sub(tip), th - thB));
      };
      let ankle, th, toe = 0;
      if (phi < D) {
        if (phi < hoStart) {
          th = phi < ffEnd ? thHS * (1 - smooth(phi / ffEnd)) : 0;
          const heel = new THREE.Vector3(xLat, 0, relHeel(phi));
          ankle = heel.add(rot(f.ankle.clone().sub(f.heel), th));
        } else if (phi < tbStart) {
          const u = (phi - hoStart) / (tbStart - hoStart);
          th = thB * Math.pow(u, 1.3);
          ankle = ankleBall(phi, th);
          toe = -th;
        } else {
          const u = (phi - tbStart) / (D - tbStart);
          th = thB + (thTO - thB) * smooth(u);
          ankle = ankleToe(phi, th);
          toe = -thB;
        }
      } else {
        const u = (phi - D) / (1 - D);
        // toe lifts quickly after toe-off, the foot is level by mid swing, heel leads at strike
        th = u < 0.45 ? thTO + (2 - thTO) * smooth(u / 0.45) : 2 + (thHS - 2) * smooth((u - 0.45) / 0.55);
        toe = u < 0.3 ? -thB * (1 - smooth(u / 0.3)) : 0;
        const aTO = ankleToe(D, thTO);
        const heelHS = new THREE.Vector3(xLat, 0, relHeel(0));   // next strike: one stride ahead of toe-off
        const aHS = heelHS.add(rot(f.ankle.clone().sub(f.heel), thHS));
        ankle = aTO.clone().lerp(aHS, smoother(u));
        ankle.y += (0.03 + 0.02 * W.sn) * Math.sin(Math.PI * Math.pow(u, 0.75));
        ankle.x += sg * 0.012 * Math.sin(Math.PI * u);   // slight circumduction
      }
      legs[s] = { ankle, th, toe, phi, stance: phi < D, loaded: phi < hoStart };
    }
    // pelvis height: as high as the planted legs allow (inverted pendulum), smoothed
    const hipH = (s, lg) => {
      const hipRest = this.rest[B['thigh' + s]];
      const dx = lg.ankle.x - hipRest.x, dz = lg.ankle.z - hipRest.z;
      // effective leg length: ~8 deg knee flexion at mid-stance, ~16 deg in loading response
      const L = (this.l1 + this.l2) * (0.997 - 0.008 * Math.exp(-(((lg.phi - 0.12) / 0.07) ** 2)));
      return lg.ankle.y + Math.sqrt(Math.max(0.01, L * L - dx * dx - dz * dz));
    };
    // only legs on the heel / flat foot carry the pelvis; a leg rolling off its toes flexes the knee
    let yHip = Infinity;
    for (const s of ['L', 'R']) if (legs[s].loaded) yHip = Math.min(yHip, hipH(s, legs[s]));
    if (!isFinite(yHip)) yHip = this.hipY;
    yHip = THREE.MathUtils.clamp(yHip, this.hipY - 0.055 * (this.H / 1.76), this.hipY - 0.006);
    P._yHip = yHip;
    P._legs = legs;
    // pelvis rotations
    const c2 = Math.cos(2 * Math.PI * phase);
    const yaw = (4 + 2 * W.sn) * c2;                                   // right hip forward at right strike
    const roll = (W.old ? 2 : 3.2) * Math.sin(2 * Math.PI * (phase + 0.15));
    const tilt = 1.5 * Math.cos(4 * Math.PI * (phase - 0.1));
    const sway = 0.018 * Math.sin(2 * Math.PI * (phase - 0.02)) * (W.old ? 1.5 : 1);
    // (rotation about +X by a negative angle pitches forward)
    P.pelvisQ = qEuler(tilt - W.lean * 0.25, yaw, roll);
    P.pelvisOffset.set(sway, 0, 0);
    // thorax counter-rotates; trunk leans forward; head stabilised against everything below
    P.spine1Q = qEuler(-W.lean * 0.35, -yaw * 0.9, -roll * 0.5);
    P.spine2Q = qEuler(-W.lean * 0.45, -yaw * 1.1, -roll * 0.45);
    // (an older walker's stoop is taken back in the neck, so the gaze stays level)
    P.neckQ = qEuler(W.lean * (W.old ? 0.6 : 0.45) - tilt * 0.5, yaw * 0.5, -roll * 0.03);
    P.headQ = qEuler(W.lean * 0.45 + 1, yaw * 0.5, -roll * 0.02);
    // arms counter-swing with a slight lag; elbows flex more when the arm is forward
    for (const s of ['L', 'R']) {
      const sg = this.side[s];
      const a = Math.cos(2 * Math.PI * (phase - (s === 'R' ? 0 : 0.5) - 0.06));
      const flex = -W.armAmp * a - 3;                               // right arm back at right strike
      const A = P.arm[s];
      A.flex = flex + (W.old ? 3 : 0);
      A.abd = 8 + 2 * Math.abs(a);
      A.elbow = 14 + Math.max(0, flex) * 0.9 + (W.old ? 5 : 0) + 4 * W.sn;
      A.twist = -12;
      A.handQ = qAxis(X, 6 + Math.max(0, flex) * 0.15);
      A.clavQ = qAxis(X, -flex * 0.12 * sg * 0);
    }
    return P;
  }

  finishWalk(P) {
    // place the pelvis height then orient feet
    P.pelvisOffset.y = P._yHip - this.hipY;
    for (const s of ['L', 'R']) {
      const lg = P._legs[s];
      P.leg[s].ankle = lg.ankle;
      P.leg[s].footQ = qAxis(X, lg.th);
      P.leg[s].toe = lg.toe;
      P.leg[s].pole = new THREE.Vector3(this.side[s] * 0.12, -0.05, -1).normalize();
    }
    return P;
  }

  idlePose(t, variant) {
    const P = this.basePose();
    const w = Math.sin(2 * Math.PI * t);                // weight shift L <-> R
    const sh = 0.032 * w;
    const breath = Math.sin(2 * Math.PI * t * 5);
    P.pelvisOffset.set(sh, -0.012 - 0.008 * Math.abs(w), 0);
    P.pelvisQ = qEuler(1.5, 2.5 * Math.sin(2 * Math.PI * t + 1), -3.2 * w);
    P.spine1Q = qEuler(-1, -1.5 * Math.sin(2 * Math.PI * t + 1), 2.2 * w);
    P.spine2Q = qEuler(0.6 * breath - 1, 0, 1.4 * w);
    P.neckQ = qEuler(variant === 1 ? -14 : -1, 0, -0.6 * w);
    const look = variant === 1 ? 0 : 14 * Math.sin(2 * Math.PI * t * 2 + 0.5) * smooth(Math.abs(Math.sin(2 * Math.PI * t * 2)));
    P.headQ = qEuler(variant === 1 ? -16 : 0, look, 0);
    for (const s of ['L', 'R']) {
      const sg = this.side[s];
      const f = this.foot[s];
      // feet stay planted; the unloaded knee bends as the pelvis shifts over the other leg
      const an = f.ankle.clone();
      an.x = sg * (Math.abs(f.ankle.x) + 0.012);
      an.z = f.ankle.z + (s === 'L' ? -0.035 : 0.02);
      P.leg[s].ankle = an;
      P.leg[s].footQ = qAxis(Y, -sg * 5);
      P.leg[s].pole = new THREE.Vector3(sg * 0.15, 0, -1).normalize();
      const A = P.arm[s];
      A.abd = 10 + 1.2 * Math.sin(2 * Math.PI * t + sg);
      A.flex = 2 + 2 * Math.sin(2 * Math.PI * t * 2 + sg);
      A.elbow = 12 + 3 * Math.sin(2 * Math.PI * t * 3);
      A.twist = -10;
    }
    if (variant === 1) {
      // looking at a phone held in the right hand, left hand loose
      const A = P.arm.R;
      A.flex = 14; A.abd = 4; A.elbow = 96; A.twist = -62;
      A.handQ = qEuler(-20, 0, 15);
      P.arm.L.elbow = 20;
    } else if (variant === 2) {
      // arms folded across the chest: the right forearm in front, its hand tucked under the
      // left upper arm; the left forearm behind it with the hand resting on the right biceps
      const k = this.H / 1.76, shY = this.rest[B.armR].y, shX = this.rest[B.armR].x;
      const br = 0.004 * Math.sin(2 * Math.PI * t * 5);
      P.arm.R.ik = { target: new THREE.Vector3(-shX * 0.70, shY - 0.235 * k + br, -0.155 * k),
        pole: new THREE.Vector3(0.6, -0.7, 0.35), palm: new THREE.Vector3(0.0, -0.25, 1) };
      P.arm.L.ik = { target: new THREE.Vector3(shX * 0.80, shY - 0.200 * k + br, -0.120 * k),
        pole: new THREE.Vector3(-0.6, -0.7, 0.35), palm: new THREE.Vector3(0.3, -0.2, 1) };
      P.arm.R.handQ = qEuler(0, 0, -10);
      P.arm.L.handQ = qEuler(0, 0, 20);
    } else if (variant === 3) {
      // hands in the front pockets
      for (const s of ['L', 'R']) {
        const A = P.arm[s];
        A.flex = 8; A.abd = 15; A.elbow = 34; A.twist = -34;
        A.handQ = qEuler(18, 0, 0);
      }
    }
    return P;
  }

  sitPose(t, variant) {
    const P = this.basePose();
    const breath = Math.sin(2 * Math.PI * t * 4);
    // seat: ischia on the seat, thighs forward, feet on the ground
    const seatY = SEAT_HEIGHT;
    const hipAbove = 0.085 * (this.H / 1.76);
    const hipY = seatY + hipAbove;
    P.pelvisOffset.set(0, hipY - this.hipY, 0.05);
    // + recline leans back, - leans forward over the table
    const recline = variant === 1 ? 12 : variant === 2 ? -16 : 2;
    P.pelvisQ = qEuler(8 + recline * 0.4, 0, 0);
    P.spine1Q = qEuler(-4 + recline * 0.3 + 0.5 * breath, 0, 0);
    P.spine2Q = qEuler(-3 + recline * 0.3, 2 * Math.sin(2 * Math.PI * t), 0);
    const look = 12 * Math.sin(2 * Math.PI * t * 2);
    P.neckQ = qEuler(-recline * 0.4 + (variant === 2 ? -6 : 0), look * 0.4, 0);
    P.headQ = qEuler(-recline * 0.5 + (variant === 2 ? -12 : 1), look * 0.6, 0);
    const thighZ = -this.l1 * 0.97;
    for (const s of ['L', 'R']) {
      const sg = this.side[s];
      const L = P.leg[s];
      const an = new THREE.Vector3(sg * (0.10 * this.H / 1.76 + 0.02), this.ankleY, thighZ + 0.06 + 0.05 + 0.05);
      if (variant === 1 && s === 'R') {
        // right leg crossed over the left knee
        an.set(-0.02, hipY + 0.06, thighZ - 0.12);
        L.pole = new THREE.Vector3(0.3, 0.7, -0.6).normalize();
        L.footQ = qEuler(-20, 25, 0);
      } else {
        L.pole = new THREE.Vector3(sg * 0.1, 0.25, -1).normalize();
        L.footQ = qAxis(Y, -sg * 6);
      }
      L.ankle = an;
      const A = P.arm[s];
      if (variant === 1) {          // hands in the lap
        A.flex = 18; A.abd = 6; A.elbow = 62; A.twist = -30;
      } else if (variant === 2) {   // forearms on the table edge
        A.flex = 48; A.abd = 14; A.elbow = 66; A.twist = -35;
      } else {                      // hands on the table
        A.flex = 32; A.abd = 12; A.elbow = 72; A.twist = -30;
      }
      A.flex += 2 * Math.sin(2 * Math.PI * t + sg);
    }
    return P;
  }
}

/** Bakes every clip for a rig. Returns {data: Float32Array, offsets: [frame0 per clip], frames, strides}. */
export function bakeClips(rig) {
  const total = CLIPS.reduce((a, c) => a + c.frames, 0);
  const data = new Float32Array(total * NB * 12);
  const offsets = [];
  const strides = [];
  let f0 = 0;
  for (const clip of CLIPS) {
    offsets.push(f0);
    let W = null;
    if (clip.kind === 'walk') W = rig.walkParams(clip);
    strides.push(W ? W.S : 0);
    // walks: compute raw pelvis heights for all frames, then smooth them cyclically
    const poses = [];
    for (let i = 0; i < clip.frames; i++) {
      const t = i / clip.frames;
      if (clip.kind === 'walk') poses.push(rig.walkPose(t, W));
      else if (clip.kind === 'idle') poses.push(rig.idlePose(t, clip.variant));
      else poses.push(rig.sitPose(t, clip.variant));
    }
    if (clip.kind === 'walk') {
      const n = poses.length, ys = poses.map((p) => p._yHip);
      const sm = ys.map((_, i) => {
        let a = 0, w = 0;
        for (let k = -3; k <= 3; k++) { const g = Math.exp(-(k * k) / 4); a += ys[(i + k + n) % n] * g; w += g; }
        return Math.min(a / w, ys[i] + 0.004);
      });
      poses.forEach((p, i) => { p._yHip = sm[i]; rig.finishWalk(p); });
    }
    for (let i = 0; i < clip.frames; i++) {
      let pose = rig.solve(poses[i]);
      if (clip.kind === 'walk') {
        // swing foot ground clearance (toe tip / heel never below the street)
        for (const s of ['L', 'R']) {
          if (poses[i]._legs[s].stance) continue;
          const fp = rig.footPoints(pose, s);
          const low = Math.min(fp.tip.y, fp.heel.y, fp.ball.y);
          if (low < 0.012) { poses[i].leg[s].ankle.y += 0.012 - low; pose = rig.solve(poses[i]); }
        }
      }
      rig.skin(pose, data, (f0 + i) * NB * 12);
    }
    f0 += clip.frames;
  }
  return { data, offsets, frames: CLIPS.map((c) => c.frames), strides, total };
}

export const NUM_BONES = NB;
