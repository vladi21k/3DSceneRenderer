import { TRACK_OFFSET, EYE_HEIGHT, DEFAULT_VFOV } from '../core/config.js';
import { noise1, hash2 } from '../core/rng.js';
import { input } from './input.js';

// Cab camera: the driver's eye on the ride track at EYE_HEIGHT above the rail top.
// Contract (docs/ARCHITECTURE.md): sets app.camera from app.train, sets app.cameraS,
// exposes yaw / pitch (look offsets, radians: + yaw = left, + pitch = up).
//
// Motion model (all driven by the route position, so it is tied to the track and fades
// out when the tram stands still):
//  - gaze: the chord to a point ~10 m ahead on the ride track, followed by a damped
//    spring with rate feed-forward (no lag on steady curves, soft on curve entries);
//  - car body on its suspension: lateral sway and yaw from track alignment, vertical
//    bob and pitch from track level, roll from cross level and an outward roll in
//    curves (v²κ), pitch from traction / braking (nose dips when braking, rebounds at
//    a stop);
//  - rail joints (every 18 m) and switch toes / frogs give small, damped ticks as each
//    axle of the cab bogies passes over them;
//  - mouse look (drag) with soft limits, easing back to centre when released;
//  - zoom (Z / X / wheel / UI) between 12° and 60° vertical FOV, smoothed in log space.

const DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapAngle = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };

export const RIG = {
  lookAhead: 10,            // m, gaze chord along the ride track
  curveGaze: 20,            // m added in tight curves (R ≲ 60 m) at telephoto focal lengths
  basePitch: -0.7 * DEG,    // slight downward gaze (vanishing point a little above centre)
  gazeFreq: 0.55,           // Hz, gaze spring (critically damped)
  bogie1: 2.6,              // m behind the cab front: first axle of the cab bogie
  wheelbase: 1.8,
  bogieSpacing: 9.0,        // to the next bogie (pitch / yaw lever)
  joint: 18,                // m, rail length between joints
  rollPerLat: 0.32 * DEG,   // body roll per m/s² of lateral acceleration (outward)
  pitchPerAcc: 0.42 * DEG,  // body pitch per m/s² of longitudinal acceleration
  rollArm: 2.0,             // m, eye height above the roll centre
  yawLimit: 60 * DEG,
  pitchLimit: 25 * DEG,
  returnOmega: 5,           // 1/s, critically damped return to centre (~1 s)
  fovMin: 12,
  fovMax: 60,
};

/** Damped oscillator x'' = w²(target - x) - 2ζw x' (+ kicks). */
class Spring {
  constructor(freqHz, zeta) { this.w = 2 * Math.PI * freqHz; this.z = zeta; this.x = 0; this.v = 0; }
  step(target, h) {
    const a = this.w * this.w * (target - this.x) - 2 * this.z * this.w * this.v;
    this.v += a * h;
    this.x += this.v * h;
  }
}

// Track geometry irregularities (metres / radians) as smooth functions of route position.
const alignment = (s) => 0.0055 * noise1(s / 9.5, 11) + 0.0022 * noise1(s / 3.3, 12);
const level = (s) => 0.0035 * noise1(s / 7.5, 21) + 0.0012 * noise1(s / 2.4, 22);
const crossLevel = (s) => 0.0007 * noise1(s / 12, 31) + 0.0003 * noise1(s / 4.1, 32);

/** Soft limit: linear up to 70 % of the limit, then eases asymptotically into it. */
function soft(x, lim) {
  const k = 0.7 * lim, ax = Math.abs(x);
  return ax <= k ? x : Math.sign(x) * (k + (lim - k) * Math.tanh((ax - k) / (lim - k)));
}
function softInv(y, lim) {
  const k = 0.7 * lim, ay = Math.min(Math.abs(y), lim * 0.999);
  return ay <= k ? y : Math.sign(y) * (k + (lim - k) * Math.atanh((ay - k) / (lim - k)));
}

const cameraRig = {
  name: 'cameraRig',
  yaw: 0,            // look offset (rad, + = left)
  pitch: 0,          // look offset (rad, + = up)
  fov: DEFAULT_VFOV,
  targetFov: DEFAULT_VFOV,
  fovMin: RIG.fovMin,
  fovMax: RIG.fovMax,

  async init(app) {
    this.app = app;
    const T = app.THREE;
    this._p = new T.Vector3(); this._a = new T.Vector3(); this._b = new T.Vector3();
    app.camera.rotation.order = 'YXZ';
    // an explicit fov= is honoured exactly (captures); user zoom stays within the limits
    this.fov = this.targetFov = app.params.fov ?? clamp(app.camera.fov || DEFAULT_VFOV, RIG.fovMin, RIG.fovMax);
    app.camera.fov = this.fov;
    app.camera.updateProjectionMatrix();

    // body dynamics
    this.lat = new Spring(0.8, 0.22);
    this.yawB = new Spring(0.9, 0.3);
    this.vert = new Spring(1.3, 0.25);
    this.pitchB = new Spring(0.75, 0.38);
    this.roll = new Spring(0.65, 0.3);
    this.tick = new Spring(8, 0.18);
    this.gaze = null;          // {x, v} heading (rad), initialised on the first frame
    this.gazePitch = null;
    this._prevS = null;

    // switch toes / frogs on the ride track (stronger impacts, lateral check-rail kick)
    this.features = [];
    for (const c of app.layout.crossovers) {
      const facing = c.from > 0;
      const toe = facing ? c.s0 : c.s1, frog = facing ? c.s0 + c.len * 0.45 : c.s1 - c.len * 0.45;
      this.features.push({ s: toe, k: 1.4, lat: 0.4 }, { s: frog, k: 2.6, lat: 1 });
    }

    // mouse look state
    this.look = { rawYaw: 0, rawPitch: 0, vy: 0, vp: 0 };
    input.attach(app.canvas);
    input.on('dragStart', () => {
      this.look.rawYaw = softInv(this.yaw, RIG.yawLimit);
      this.look.rawPitch = softInv(this.pitch, RIG.pitchLimit);
      this.look.vy = 0; this.look.vp = 0;
    });
    input.on('dragEnd', () => { this.look.vy = 0; this.look.vp = 0; });
  },

  /** Set the vertical FOV (degrees); smoothed unless immediate. */
  setFov(deg, immediate = false) {
    this.targetFov = clamp(deg, RIG.fovMin, RIG.fovMax);
    if (immediate) this.fov = this.targetFov;
  },

  update(dt, app) {
    const { route, camera } = app;
    const tr = app.train;
    const s = tr && !tr.disabled ? tr.s : app.startS;
    const v = tr && !tr.disabled ? tr.speed : 0;
    const acc = tr && !tr.disabled ? tr.accel || 0 : 0;
    const rdt = Math.min(app.realDt ?? dt, 0.1);
    app.cameraS = s;

    // ---- gaze along the ride track. In tight curves the driver looks further round the
    // bend; at telephoto focal lengths that keeps the track in frame instead of the outer wall.
    const kAhead = Math.max(Math.abs(route.curvature(s + 6)), Math.abs(route.curvature(s + 16)), Math.abs(route.curvature(s + 26)));
    const zoomK = 1 - smoothstep(25, 55, this.fov);
    const look = RIG.lookAhead + RIG.curveGaze * smoothstep(1 / 450, 1 / 90, kAhead) * zoomK;
    const pA = route.toWorld(s, TRACK_OFFSET, 0, this._a);
    const pB = route.toWorld(s + look, TRACK_OFFSET, 0, this._b);
    const dx = pB.x - pA.x, dz = pB.z - pA.z;
    const chordH = Math.atan2(-dz, dx);
    const chordP = Math.atan2(pB.y - pA.y, Math.hypot(dx, dz));
    if (!this.gaze) {
      this.gaze = { x: chordH, v: 0, target: chordH };
      this.gazePitch = { x: chordP, v: 0, target: chordP };
    }
    if (dt > 0) {
      const w = 2 * Math.PI * RIG.gazeFreq;
      for (const [g, t] of [[this.gaze, chordH], [this.gazePitch, chordP]]) {
        const tv = wrapAngle(t - g.target) / dt;       // target rate (feed-forward)
        g.target = t;
        const n = Math.ceil(dt / (1 / 120)), h = dt / n;
        for (let i = 0; i < n; i++) {
          const err = wrapAngle(g.target - g.x);
          g.v += (w * w * err + 2 * w * (tv - g.v)) * h;
          g.x += g.v * h;
        }
      }
    }

    // ---- car body dynamics
    if (dt > 0) this._body(dt, s, v, acc, route);

    // ---- mouse look
    this._look(rdt);

    // ---- zoom
    this._zoom(rdt, camera);

    // ---- compose
    const right = this.lat.x - this.roll.x * RIG.rollArm;
    const up = this.vert.x + this.tick.x;
    route.toWorld(s, TRACK_OFFSET + right, EYE_HEIGHT + up, camera.position);
    camera.rotation.set(
      this.gazePitch.x + RIG.basePitch + this.pitchB.x + this.tick.x * 0.9 + this.pitch,
      this.gaze.x - Math.PI / 2 + this.yawB.x + this.yaw,
      this.roll.x,
      'YXZ',
    );
  },

  _body(dt, s, v, acc, route) {
    const f = smoothstep(0, 9, v);          // track excitation grows with speed
    const s1 = s - RIG.bogie1, s2 = s1 - RIG.bogieSpacing;
    const aLat = v * v * route.curvature(s - 4);
    const latT = f * alignment(s1);
    const yawT = f * (alignment(s1) - alignment(s2)) / RIG.bogieSpacing;
    const vertT = f * level(s1);
    let pitchT = RIG.pitchPerAcc * acc + f * (level(s1) - level(s2)) / RIG.bogieSpacing;
    pitchT = Math.sign(pitchT) * Math.min(Math.abs(pitchT), 0.6 * DEG + 0.3 * Math.max(0, Math.abs(pitchT) - 0.6 * DEG));
    const rollT = -RIG.rollPerLat * aLat + f * crossLevel(s1);

    // rail joints, switch toes and frogs under each axle of the cab bogies
    if (this._prevS !== null) {
      const ds = route.delta(this._prevS, s);
      if (ds > 0 && ds < 5) {
        const strength = Math.min(1, v / 11) * (0.6 + 0.4 * Math.min(1, v / 14));
        const axles = [[RIG.bogie1, 1], [RIG.bogie1 + RIG.wheelbase, 0.85], [RIG.bogie1 + RIG.bogieSpacing, 0.35], [RIG.bogie1 + RIG.bogieSpacing + RIG.wheelbase, 0.3]];
        for (const [off, w] of axles) {
          const a0 = this._prevS - off, a1 = a0 + ds;
          const j0 = Math.floor(a0 / RIG.joint), j1 = Math.floor(a1 / RIG.joint);
          if (j1 > j0) {
            const jv = 0.55 + 0.9 * (hash2(j1, 5) / 4294967296);   // joints are not all alike
            this.tick.v -= 0.036 * strength * w * jv;
            this.vert.v -= 0.004 * strength * w * jv;
          }
          for (const ft of this.features) {
            const d0 = route.delta(ft.s, a0);
            if (d0 < 0 && d0 + ds >= 0) {
              this.tick.v -= 0.036 * strength * w * ft.k;
              this.lat.v += 0.012 * strength * w * ft.lat;
              this.yawB.v += 0.004 * strength * w * ft.lat;
            }
          }
        }
      }
    }
    this._prevS = s;

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

  _look(rdt) {
    const L = this.look;
    if (input.dragging) {
      const { dx, dy } = input.consumeLook();
      const H = (this.app.canvas && this.app.canvas.clientHeight) || window.innerHeight || 1080;
      const sens = (this.fov * DEG) / H;        // the scene follows the cursor at any zoom
      L.rawYaw = clamp(L.rawYaw - dx * sens, -RIG.yawLimit * 1.6, RIG.yawLimit * 1.6);
      L.rawPitch = clamp(L.rawPitch - dy * sens, -RIG.pitchLimit * 1.6, RIG.pitchLimit * 1.6);
      const ty = soft(L.rawYaw, RIG.yawLimit), tp = soft(L.rawPitch, RIG.pitchLimit);
      const k = 1 - Math.exp(-rdt / 0.045);
      this.yaw += (ty - this.yaw) * k;
      this.pitch += (tp - this.pitch) * k;
    } else {
      input.consumeLook();
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
    if (zin || zout || wheel) this.targetFov = clamp(t, RIG.fovMin, RIG.fovMax);
    const k = 1 - Math.exp(-rdt / 0.12);
    const f = Math.exp(Math.log(this.fov) + (Math.log(this.targetFov) - Math.log(this.fov)) * k);
    this.fov = Math.abs(f - this.targetFov) < 1e-4 ? this.targetFov : f;
    if (Math.abs(camera.fov - this.fov) > 1e-6) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  },
};
export default cameraRig;
