import * as THREE from 'three';
import { TRACK_OFFSET, EYE_HEIGHT, DEFAULT_VFOV, AXLES } from '../core/config.js';
import { RNG, noise1, hash2 } from '../core/rng.js';
import { U } from '../core/uniforms.js';
import { input } from './input.js';

// Cab camera: the driver's eye in the cab body, EYE_HEIGHT above the rail top.
// Contract (docs/ARCHITECTURE.md): sets app.camera from app.train, sets app.cameraS,
// exposes yaw / pitch (look offsets, radians: + yaw = left, + pitch = up).
//
// The camera is mounted on the car body, like a cab-ride camera:
//  - body frame: the axis through the two bogie pivots of the cab module, so in a curve
//    the cab points across the bend (the track sweeps towards the inside of the frame
//    and the outer facades fill it); the eye sits 1.7 m behind the cab front on that
//    axis. The driver's head turns a little towards where the track goes;
//  - body on its suspension: lateral sway and yaw from track alignment, a 1.1-1.6 Hz body
//    hunting oscillation growing with speed², vertical
//    bob and pitch from track level, roll from cross level and an outward roll in
//    curves (v²κ), pitch from traction / braking with a spring-back at the stop;
//  - framing: at the telephoto default (DEFAULT_VFOV) the gaze settles far down the line,
//    so the rails run to a clear vanishing point on straights and bends alike; at wide
//    angles it is the plain body-mounted view with a slight turn into curves;
//  - impacts at the same rail joints / turnout parts and the same axles (config AXLES)
//    the audio uses (app.audio.features), so each bump lands with its knock;
//  - a fine traction / running buzz, boarding movements and door shudders at stops;
//  - mouse look (grab and drag the view) with soft limits, easing back to centre when released;
//  - zoom (Z / X / wheel / UI) between 12° and 60° vertical FOV, smoothed in log space;
//    portrait screens keep the landscape horizontal view;
//  - motion data for a shutter blur in post: previous view-projection, cut flag, and an
//    exposure that follows the light like an auto-exposing camera: a short daylight shutter
//    (crisp edges, as in daytime cab footage) opening up to 1/50 s at dusk, with the
//    streak-length cap scaled to it and lowered at wide angles.
// The tram itself is never rendered: no cab, console or windscreen in view at any zoom.
// Simulation-driven motion uses the train clock, so it stands still while frozen or held.

const DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapAngle = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };

export const RIG = {
  eyeBack: 1.7,             // m, driver's eye behind the cab front
  pivot1: 3.125,            // m behind the cab front: cab bogie centre (body pivot)
  pivot2: 14.525,           // second bogie centre (sets the body axis)
  lookAhead: 10,            // m, where the driver looks along the track (wide angle)
  headTurn: 0.22,           // share of the angle to that point the head turns (rest: body axis)
  teleLookAhead: 80,        // m, gaze point at the telephoto default: far down the line...
  teleHeadTurn: 0.7,        // ...and how far the view turns towards it
  teleFov: [20, 40],        // vertical FOV range blending telephoto (≤) into wide-angle (≥) framing
  basePitch: -0.7 * DEG,    // slight downward gaze (vanishing point a little above centre)
  gazeFreq: 0.55,           // Hz, head-turn spring (critically damped)
  rollPerLat: 0.32 * DEG,   // body roll per m/s² of lateral acceleration (outward)
  pitchPerAcc: 0.42 * DEG,  // body pitch per m/s² of longitudinal acceleration
  rollArm: 2.0,             // m, eye height above the roll centre
  stopSpring: 3.4 * DEG,    // pitch-rate kick per m/s² of final braking when the tram comes to rest
  vib: { pitch: 0.035 * DEG, yaw: 0.014 * DEG, roll: 0.017 * DEG },   // RMS buzz at 45 km/h
  // body hunting: the car body's yaw / lateral oscillation on its secondary suspension
  // (wheelset hunting coupled through the bogies), 1.1-1.6 Hz with a drifting frequency
  // and amplitude; the RMS given at `ref` m/s, growing with the square of speed (capped)
  hunt: { yaw: 0.032 * DEG, lat: 0.003, ref: 7.5, max: 1.4, freq: [1.1, 1.6] },
  dipKick: 1.5,             // dipped / insulated joints knock harder than the welds
  shutterDay: 1 / 160,      // s, exposure in daylight (camera motion blur in post)...
  shutterNight: 1 / 50,     // ...opening up towards dusk (U.uNight), interpolated in stops
  blurMaxPx: 32,            // streak cap (px at 1080 lines) at the night shutter, scaled with the shutter
  blurWideCut: 0.45,        // share of the cap removed at wide angles (edges move fastest there)
  yawLimit: 60 * DEG,
  pitchLimit: 25 * DEG,
  returnOmega: 5,           // 1/s, critically damped return to centre (~1 s)
  fovMin: 12,
  fovMax: 60,
  portraitMaxFov: 50,       // portrait screens: widest automatic vertical FOV
};

/** Damped oscillator x'' = w²(target - x) - 2ζw x' (+ kicks). */
class Spring {
  constructor(freqHz, zeta) { this.w = 2 * Math.PI * freqHz; this.z = zeta; this.x = 0; this.v = 0; }
  step(target, h) {
    const a = this.w * this.w * (target - this.x) - 2 * this.z * this.w * this.v;
    this.v += a * h;
    this.x += this.v * h;
  }
  /** Kick that peaks at roughly `amp` displacement. */
  kick(amp) { this.v += amp * this.w; }
}

// Track geometry irregularities (metres / radians) as smooth functions of route position.
const alignment = (s) => 0.02 * noise1(s / 9.5, 11) + 0.0022 * noise1(s / 3.3, 12);
const level = (s) => 0.0035 * noise1(s / 7.5, 21) + 0.0012 * noise1(s / 2.4, 22);
const crossLevel = (s) => 0.0007 * noise1(s / 12, 31) + 0.0003 * noise1(s / 4.1, 32);

/** Fine body buzz (traction, running gear), unit RMS: three octaves around 7, 11, 17 Hz. */
const buzz = (t, seed) => (0.7 * noise1(t * 7.1, seed) + 0.45 * noise1(t * 11.3, seed + 1) + 0.25 * noise1(t * 17.2, seed + 2)) / 0.42;

/** Critically damped follow with target-rate feed-forward (no lag on a steadily
 *  changing target, soft response to changes of rate). */
function follow(g, target, dt) {
  const w = 2 * Math.PI * RIG.gazeFreq;
  const tv = (target - g.target) / dt;
  g.target = target;
  const n = Math.ceil(dt / (1 / 120)), h = dt / n;
  for (let i = 0; i < n; i++) {
    g.v += (w * w * (g.target - g.x) + 2 * w * (tv - g.v)) * h;
    g.x += g.v * h;
  }
}

/** Soft limit: linear up to 70 % of the limit, then eases asymptotically into it. */
function soft(x, lim) {
  const k = 0.7 * lim, ax = Math.abs(x);
  return ax <= k ? x : Math.sign(x) * (k + (lim - k) * Math.tanh((ax - k) / (lim - k)));
}
function softInv(y, lim) {
  const k = 0.7 * lim, ay = Math.min(Math.abs(y), lim * 0.999);
  return ay <= k ? y : Math.sign(y) * (k + (lim - k) * Math.atanh((ay - k) / (lim - k)));
}

/** Joints when the audio module is not running: the audio's statistics (18 m rails, almost
 *  all welded with sev 0.03-0.1, 12 % insulated / dipped joints with sev 0.45-1.0, the
 *  turnout parts of each crossover flagged xo), not the same positions. */
function fallbackFeatures(route, layout) {
  const rng = RNG.from(layout.seed ?? 7, 'rig-joints');
  const out = [];
  for (let s = rng.range(2, 18); s < route.length - 2; s += 18 + rng.range(-0.35, 0.35)) {
    if (layout.isInCrossover(s, 4)) continue;
    const dipped = rng.chance(0.12);
    out.push({ s, kind: 'joint', sev: dipped ? rng.range(0.45, 1.0) : rng.range(0.03, 0.1) });
  }
  for (const c of layout.crossovers) {
    const facing = c.from > 0, at = (x) => route.wrap(facing ? c.s0 + x : c.s1 - x);
    out.push({ s: at(0), kind: 'joint', sev: 0.5, xo: true }, { s: at(6.4), kind: 'joint', sev: 0.75, xo: true },
      { s: at(14), kind: 'check', sev: 0.7, xo: true }, { s: at(15.6), kind: 'frog', sev: 1, xo: true },
      { s: at(19.2), kind: 'joint', sev: 0.7, xo: true }, { s: at(23.5), kind: 'joint', sev: 0.55, xo: true });
  }
  return out.sort((a, b) => a.s - b.s);
}

/** Index of the first feature with s > x (sorted list, wraps to 0). */
function nextIndex(F, x) {
  let lo = 0, hi = F.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (F[m].s <= x) lo = m + 1; else hi = m; }
  return lo % F.length;
}

const cameraRig = {
  name: 'cameraRig',
  yaw: 0,            // look offset (rad, + = left)
  pitch: 0,          // look offset (rad, + = up)
  fov: DEFAULT_VFOV, // vertical FOV for a 16:9 screen (portrait screens widen it)
  targetFov: DEFAULT_VFOV,
  fovMin: RIG.fovMin,
  fovMax: RIG.fovMax,
  shutterSec: RIG.shutterDay,  // exposure for the shutter blur in post (follows the light)
  blurMaxPx: RIG.blurMaxPx * RIG.shutterDay / RIG.shutterNight,  // streak cap, px at 1080 lines
  cut: true,         // the view jumped this frame: no motion blur
  prevViewProj: null, // last frame's projection × view matrix (for the shutter blur in post)
  _hf: { pitch: 0, yaw: 0, roll: 0, lat: 0 },   // current body buzz / hunting (rad, m)
  _huntPh: 0,         // hunting oscillator phase (rad)
  _tallPitch: 0,      // extra downward tilt on tall (portrait) screens

  async init(app) {
    this.app = app;
    const T = app.THREE;
    this._p1 = new T.Vector3(); this._p2 = new T.Vector3(); this._p3 = new T.Vector3();
    this._eye = new T.Vector3(); this._axis = new T.Vector3();
    this._qBody = new T.Quaternion(); this._qHead = new T.Quaternion(); this._e = new T.Euler(0, 0, 0, 'YXZ');
    this.prevViewProj = new T.Matrix4();
    this._lookOut = { dx: 0, dy: 0 };
    app.camera.rotation.order = 'YXZ';
    // the telephoto default unless fov= is given; an explicit fov= is honoured exactly
    // (captures, any aspect), user zoom stays within the limits
    this.fixedFov = app.params.fov != null;
    this.fov = this.targetFov = app.params.fov ?? DEFAULT_VFOV;
    this._applyFov(app.camera);

    // body dynamics
    this.lat = new Spring(0.8, 0.22);
    this.yawB = new Spring(0.75, 0.3);
    this.vert = new Spring(1.3, 0.25);
    this.pitchB = new Spring(0.75, 0.38);
    this.roll = new Spring(0.65, 0.3);
    this.tick = new Spring(8, 0.18);
    this.head = null;          // head turn {x, v, target} (rad), initialised on the first frame
    this.headP = null;
    this._prevS = null;
    this._prevV = 0; this._prevAcc = 0;
    this._lastT = 0;
    this.F = null;             // track features (resolved on the first update: audio inits later)
    this._cursor = new Int32Array(AXLES.length).fill(-1);
    this.board = null;         // boarding movements while the doors are open

    // mouse look state
    this.look = { rawYaw: 0, rawPitch: 0, vy: 0, vp: 0 };
    input.attach(app.canvas);
    input.on('dragStart', () => {
      this.look.rawYaw = softInv(this.yaw, RIG.yawLimit);
      this.look.rawPitch = softInv(this.pitch, RIG.pitchLimit);
      this.look.vy = 0; this.look.vp = 0;
    });
    input.on('dragEnd', () => { this.look.vy = 0; this.look.vp = 0; });

    // stops: passengers boarding rock the body a little; the doors closing give a shudder
    app.events.on('doors', (e) => {
      const t = app.train ? app.train.t : 0;
      if (e && e.open) {
        const rng = RNG.from('board', e.station ? e.station.id : 0, e.visit || 0);
        this.board = { rng, next: t + rng.range(0.4, 1.2) };
      } else {
        this.board = null;
        this.pitchB.kick(0.04 * DEG);
        this.roll.kick(0.04 * DEG);
      }
    });
  },

  /** Set the vertical FOV (degrees, 16:9 equivalent); smoothed unless immediate. */
  setFov(deg, immediate = false) {
    this.targetFov = clamp(deg, RIG.fovMin, RIG.fovMax);
    this.fixedFov = false;
    if (immediate) this.fov = this.targetFov;
  },

  update(dt, app) {
    const { route, camera } = app;
    const tr = app.train && !app.train.disabled ? app.train : null;
    const s = tr ? tr.s : app.startS;
    const v = tr ? tr.speed : 0;
    const acc = tr ? tr.accel || 0 : 0;
    const rdt = Math.min(app.realDt ?? dt, 0.1);
    // simulation step: the train clock (stands still while frozen / before the ride starts)
    const tNow = tr ? tr.t : app.time;
    const sdt = dt > 0 ? Math.max(0, Math.min(0.1, tNow - this._lastT)) : 0;
    this._lastT = tNow;

    // motion-blur input: last frame's view-projection, before this frame moves the camera
    this.prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const fov0 = camera.fov;
    this.cut = this._prevS === null || Math.abs(route.delta(this._prevS, s)) > 5 || !!app.params.view;

    // ---- body frame: axis through the bogie pivots, eye on its forward extension
    const p1 = route.toWorld(s - RIG.pivot1, TRACK_OFFSET, 0, this._p1);
    const p2 = route.toWorld(s - RIG.pivot2, TRACK_OFFSET, 0, this._p2);
    const ax = this._axis.subVectors(p1, p2).normalize();
    const bodyH = Math.atan2(-ax.z, ax.x);
    const bodyP = Math.asin(clamp(ax.y, -1, 1));
    const eye = this._eye.copy(ax).multiplyScalar(RIG.pivot1 - RIG.eyeBack).add(p1);
    app.cameraS = route.wrap(s - RIG.eyeBack);

    // ---- head: turns towards the track ahead (from the body axis); a long lens looks far
    // down the line so the rails keep running to the vanishing point through bends
    const tele = smoothstep(Math.log(RIG.teleFov[1]), Math.log(RIG.teleFov[0]), Math.log(this.fov));
    const look = RIG.lookAhead + tele * (RIG.teleLookAhead - RIG.lookAhead);
    const share = RIG.headTurn + tele * (RIG.teleHeadTurn - RIG.headTurn);
    const pa = route.toWorld(s - RIG.eyeBack + look, TRACK_OFFSET, 0, this._p3);
    const dx = pa.x - eye.x, dz = pa.z - eye.z;
    const turnT = share * wrapAngle(Math.atan2(-dz, dx) - bodyH);
    const tiltT = share * (Math.atan2(pa.y - eye.y, Math.hypot(dx, dz)) - bodyP);
    if (!this.head) {
      this.head = { x: turnT, v: 0, target: turnT };
      this.headP = { x: tiltT, v: 0, target: tiltT };
    }
    if (sdt > 0) { follow(this.head, turnT, sdt); follow(this.headP, tiltT, sdt); }

    // ---- car body dynamics
    if (sdt > 0) this._body(sdt, tNow, s, v, acc, tr, route, app);
    this._prevS = s;

    // ---- mouse look, zoom
    this._look(rdt);
    this._zoom(rdt, camera);
    if (Math.abs(camera.fov - fov0) > 0.1 * fov0) this.cut = true;
    this._exposure(camera);

    // ---- compose: body pose, then the head inside it
    const hv = this._hf;
    const right = this.lat.x + hv.lat - this.roll.x * RIG.rollArm;
    const up = EYE_HEIGHT + this.vert.x + this.tick.x;
    const rx = -ax.z, rz = ax.x, rl = Math.hypot(rx, rz) || 1;    // body right (horizontal)
    camera.position.set(eye.x + (rx / rl) * right, eye.y + up, eye.z + (rz / rl) * right);
    this._qBody.setFromEuler(this._e.set(
      bodyP + this.pitchB.x + this.tick.x * 0.9 + hv.pitch,
      bodyH - Math.PI / 2 + this.yawB.x + hv.yaw,
      this.roll.x + hv.roll, 'YXZ'));
    this._qHead.setFromEuler(this._e.set(RIG.basePitch + this._tallPitch + this.headP.x + this.pitch, this.head.x + this.yaw, 0, 'YXZ'));
    camera.quaternion.copy(this._qBody).multiply(this._qHead);
  },

  _body(dt, t, s, v, acc, tr, route, app) {
    const f = smoothstep(0, 9, v);          // track excitation grows with speed
    const s1 = s - RIG.pivot1, s2 = s - RIG.pivot2;
    const aLat = v * v * route.curvature(s - 6);
    const latT = f * alignment(s1);
    // body yaw: alignment difference between the bogies plus a slow hunting of the body
    const yawT = f * ((alignment(s1) - alignment(s2)) / (RIG.pivot2 - RIG.pivot1) + 0.0011 * noise1(s / 7.3, 13));
    const vertT = f * level(s1);
    let pitchT = RIG.pitchPerAcc * acc + f * (level(s1) - level(s2)) / (RIG.pivot2 - RIG.pivot1);
    pitchT = Math.sign(pitchT) * Math.min(Math.abs(pitchT), 0.6 * DEG + 0.3 * Math.max(0, Math.abs(pitchT) - 0.6 * DEG));
    const rollT = -RIG.rollPerLat * aLat + f * crossLevel(s1);

    // stopping: the brake stops doing work and the body springs back nose-up
    if (this._prevV > 0 && v === 0 && this._prevAcc < -0.15) this.pitchB.v += RIG.stopSpring * Math.abs(this._prevAcc);
    this._prevV = v; this._prevAcc = acc;

    this._impacts(s, v, route, app);

    // boarding at a stop: people stepping in rock the body a little
    const b = this.board;
    if (b && t >= b.next) {
      const r = b.rng;
      this.roll.kick(r.range(-1, 1) * 0.03 * DEG);
      this.vert.kick(-r.range(0.4, 1) * 0.0015);
      b.next = t + r.range(0.6, 2.0);
    }

    // fine buzz: running gear grows with speed, the traction drive hums under power
    const th = tr ? tr.throttle || 0 : 0;
    const k = Math.pow(v / 12.5, 1.3) + 0.15 * smoothstep(0.2, 0.5, th) + 0.04;
    const hv = this._hf;
    hv.pitch = RIG.vib.pitch * k * buzz(t, 101);
    hv.yaw = RIG.vib.yaw * k * buzz(t, 111);
    hv.roll = RIG.vib.roll * k * buzz(t, 121);

    // body hunting: a drifting 1.1-1.6 Hz yaw / sway (sine of unit RMS, amplitude wandering
    // ±40 %), lateral motion a quarter period behind the yaw
    const H = RIG.hunt;
    const fh = H.freq[0] + (H.freq[1] - H.freq[0]) * (0.5 + 0.5 * noise1(t * 0.13, 141));
    this._huntPh = (this._huntPh + 2 * Math.PI * fh * dt) % (2 * Math.PI * 64);
    const ah = Math.min(H.max, (v / H.ref) ** 2) * Math.SQRT2 * (1 + 0.4 * noise1(t * 0.31, 143));
    hv.yaw += H.yaw * ah * Math.sin(this._huntPh);
    hv.lat = H.lat * ah * Math.sin(this._huntPh - Math.PI / 2);

    const n = Math.ceil(dt / (1 / 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      this.lat.step(latT, h);
      this.yawB.step(yawT, h);
      this.vert.step(vertT, h);
      this.pitchB.step(pitchT, h);
      this.roll.step(rollT, h);
      this.tick.step(0, h);
    }
  },

  /** Rail joints, switch toes, frogs and check rails under each axle (one cursor per axle). */
  _impacts(s, v, route, app) {
    if (!this.F) {
      const au = app.audio;
      this.F = au && !au.disabled && au.features && au.features.length ? au.features : fallbackFeatures(route, app.layout);
    }
    const F = this.F;
    if (!F.length) return;
    const jump = this._prevS === null || Math.abs(route.delta(this._prevS, s)) > 25;
    const strength = Math.min(1, v / 11) * (0.6 + 0.4 * Math.min(1, v / 14));
    for (let c = 0; c < AXLES.length; c++) {
      const axle = AXLES[c], sa = route.wrap(s - axle.offset);
      if (jump || this._cursor[c] < 0) { this._cursor[c] = nextIndex(F, sa); continue; }
      for (let guard = 0; guard < 8; guard++) {
        const ft = F[this._cursor[c]];
        if (route.delta(sa, ft.s) > 0) break;          // not reached yet
        this._cursor[c] = (this._cursor[c] + 1) % F.length;
        if (v < 0.3) continue;
        const w = axle.weight * strength;
        // welds are barely there, dipped joints knock, the frog nose hits hardest
        const sev = ft.sev < 0.25 ? ft.sev * 0.25 : ft.sev * (ft.kind === 'joint' ? RIG.dipKick : 1);
        const k = ft.kind === 'frog' ? 1.8 : ft.kind === 'check' ? 0.5 : 1;
        this.tick.v -= 0.04 * w * sev * k;
        this.vert.v -= 0.004 * w * sev * k;
        if (ft.kind === 'frog' || ft.kind === 'check') {
          const side = hash2(Math.round(ft.s * 10), 7) & 1 ? 1 : -1;
          this.lat.v += 0.012 * w * ft.sev * side;
          this.yawB.v += 0.004 * w * ft.sev * side;
        }
      }
    }
  },

  /** Shutter time from the light (log-interpolated: the camera's auto exposure works in
   *  stops) and the streak cap: scaled with the shutter, narrower at wide angles where the
   *  frame edges sweep fastest. */
  _exposure(camera) {
    const night = clamp(U.uNight.value, 0, 1);
    this.shutterSec = Math.exp(Math.log(RIG.shutterDay) + night * (Math.log(RIG.shutterNight) - Math.log(RIG.shutterDay)));
    const wide = smoothstep(Math.log(RIG.teleFov[0]), Math.log(45), Math.log(camera.fov));
    this.blurMaxPx = RIG.blurMaxPx * (this.shutterSec / RIG.shutterNight) * (1 - RIG.blurWideCut * wide);
  },

  _look(rdt) {
    const L = this.look;
    const { dx, dy } = input.consumeLook(this._lookOut);
    if (input.dragging) {
      const H = (this.app.canvas && this.app.canvas.clientHeight) || window.innerHeight || 1080;
      // grab the view (as the cursor shows): the scene under the cursor moves with it, at any zoom
      const sens = (this.app.camera.fov * DEG) / H;
      L.rawYaw = clamp(L.rawYaw + dx * sens, -RIG.yawLimit * 1.6, RIG.yawLimit * 1.6);
      L.rawPitch = clamp(L.rawPitch + dy * sens, -RIG.pitchLimit * 1.6, RIG.pitchLimit * 1.6);
      const ty = soft(L.rawYaw, RIG.yawLimit), tp = soft(L.rawPitch, RIG.pitchLimit);
      const k = 1 - Math.exp(-rdt / 0.045);
      this.yaw += (ty - this.yaw) * k;
      this.pitch += (tp - this.pitch) * k;
    } else if (this.yaw !== 0 || this.pitch !== 0) {
      // critically damped return to centre
      const w = RIG.returnOmega;
      const n = Math.max(1, Math.ceil(rdt / (1 / 120))), h = rdt / n;
      for (let i = 0; i < n; i++) {
        L.vy += (-w * w * this.yaw - 2 * w * L.vy) * h; this.yaw += L.vy * h;
        L.vp += (-w * w * this.pitch - 2 * w * L.vp) * h; this.pitch += L.vp * h;
      }
      if (Math.abs(this.yaw) < 1e-5 && Math.abs(L.vy) < 1e-5) { this.yaw = 0; L.vy = 0; }
      if (Math.abs(this.pitch) < 1e-5 && Math.abs(L.vp) < 1e-5) { this.pitch = 0; L.vp = 0; }
    }
  },

  _zoom(rdt, camera) {
    let t = this.targetFov;
    const zin = input.held('zoomIn'), zout = input.held('zoomOut'), wheel = input.consumeWheel();
    if (zin) t *= Math.exp(-0.9 * rdt);
    if (zout) t *= Math.exp(0.9 * rdt);
    if (wheel) t *= Math.exp(wheel * 0.0011);
    if (zin || zout || wheel) { this.targetFov = clamp(t, RIG.fovMin, RIG.fovMax); this.fixedFov = false; }
    const k = 1 - Math.exp(-rdt / 0.12);
    const f = Math.exp(Math.log(this.fov) + (Math.log(this.targetFov) - Math.log(this.fov)) * k);
    this.fov = Math.abs(f - this.targetFov) < 1e-4 ? this.targetFov : f;
    this._applyFov(camera);
  },

  /** Camera FOV from the 16:9-equivalent one: narrower-than-16:9 screens keep (most of)
   *  the landscape horizontal view instead of cropping it down to the rails. */
  _applyFov(camera) {
    let fov = this.fov;
    const aspect = camera.aspect || 16 / 9;
    if (!this.fixedFov && aspect < 1.5) {
      const p = smoothstep(1.5, 1.0, aspect);
      const wide = (2 / DEG) * Math.atan(Math.tan((fov * DEG) / 2) * Math.pow((16 / 9) / aspect, p));
      fov = Math.min(wide, Math.max(fov, RIG.portraitMaxFov));
    }
    // a taller view tilts down a little so the street, not the sky, fills it
    this._tallPitch = -0.15 * (fov - this.fov) * DEG;
    if (Math.abs(camera.fov - fov) > 1e-6) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  },
};
export default cameraRig;
