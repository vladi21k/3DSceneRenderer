import { MAX_SPEED } from '../core/config.js';
import { RNG, noise1, hash2 } from '../core/rng.js';
import { U } from '../core/uniforms.js';
import { input } from './input.js';

// Tram dynamics: a ~32 m, five-module low-floor light-rail vehicle on the ride track.
// Contract (docs/ARCHITECTURE.md): app.train = {s, speed, accel, throttle, auto, state,
// nextStop, curvature, bellAt}. `s` is the cab front along the route.
//
//  - Traction: constant-torque up to vBase, constant power above, governor at 50 km/h.
//    Davis running resistance and the route grade act on the vehicle.
//  - Effort (motor/brake acceleration) is jerk limited with a softened onset, so every
//    change of throttle or brake ramps in smoothly like a real traction controller.
//  - Master controller notches: EB, B4..B1, N, P1..P4 (W / S step through them).
//  - Auto driver: cruise 40-45 km/h, curve limit sqrt(aLat R), 25 km/h over crossovers
//    (until the rear of the tram has cleared), braking curves to every restriction and a
//    jerk-softened station stop with the cab front at station.stopS, dwell 12-18 s.
//  - Station stops are automatic in manual mode too (hold W to run through a stop),
//    and a speed supervisor keeps manual driving within curve / switch limits.
//  - Bell: B / Space, on departure, at some cross streets, and on crowd 'bell-request'
//    (rate limited); a pedestrian that stays on the track makes the tram pre-brake.

const KMH = 1 / 3.6;
const G = 9.81;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export const VEHICLE = {
  length: 32,              // m, cab front to rear coupler
  aTraction: 1.15,         // m/s², starting acceleration (constant-torque region)
  vBase: 32 * KMH,         // end of the constant-torque region
  vMax: MAX_SPEED,         // 50 km/h governor
  aService: 1.2,           // full service brake
  aEmergency: 2.5,         // emergency brake (incl. magnetic track brakes)
  jerk: 0.9,               // m/s³ comfort jerk limit
  jerkEmergency: 5,
  snap: 3.2,               // m/s⁴, rounds the start / end of every jerk ramp
  rotMass: 1.08,           // rotating-mass factor for grade forces
};

export const DRIVE = {
  cruiseKmh: [40, 45],
  aLat: 0.9,               // m/s² lateral comfort limit in curves
  crossoverKmh: 25,
  aStop: 0.85,             // planned station braking
  aRestrict: 0.6,          // planned braking towards curve / switch limits
  gain: 0.65,              // speed controller gain (1/s)
  scanAhead: 240,          // m of route scanned for restrictions
  dwell: [12, 18],         // s
  autoBellGap: 4,          // s between automatic bells
};

/** Master controller positions, brake (left) to power (right). */
export const NOTCHES = [
  { id: 'EB', effort: -1, emergency: true },
  { id: 'B4', effort: -1 },
  { id: 'B3', effort: -0.75 },
  { id: 'B2', effort: -0.5 },
  { id: 'B1', effort: -0.25 },
  { id: 'N', effort: 0 },
  { id: 'P1', effort: 0.25 },
  { id: 'P2', effort: 0.5 },
  { id: 'P3', effort: 0.75 },
  { id: 'P4', effort: 1 },
];
const N_INDEX = 5;

/** Stopping-distance table for a braking curve whose deceleration eases off
 *  towards standstill (aEnd·aPlan at 0 m/s, full aPlan above vEase). */
class BrakeCurve {
  constructor(aPlan, vEase, endFrac) {
    this.aPlan = aPlan; this.vEase = vEase; this.endFrac = endFrac;
    this.dv = 0.02;
    const n = Math.ceil(20 / this.dv) + 1;
    this.D = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const vm = (i - 0.5) * this.dv;
      this.D[i] = this.D[i - 1] + (vm * this.dv) / this.decel(vm);
    }
  }
  decel(v) { return this.aPlan * Math.min(1, this.endFrac + (1 - this.endFrac) * v / this.vEase); }
  /** Highest speed from which the tram stops within distance d. */
  speed(d) {
    const D = this.D;
    if (d <= 0) return 0;
    let lo = 0, hi = D.length - 1;
    if (d >= D[hi]) return hi * this.dv;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (D[m] < d) lo = m; else hi = m; }
    return (lo + (d - D[lo]) / (D[hi] - D[lo])) * this.dv;
  }
}

const STOP_CURVE = new BrakeCurve(DRIVE.aStop, 2.4, 0.3);

/** Pure simulation of the vehicle and its driver (no DOM), so it can also be run
 *  offline: new Tram(app, {s, speed, events}).step(dt). */
export class Tram {
  constructor(app, opts = {}) {
    this.route = app.route;
    this.layout = app.layout;
    this.events = opts.events || app.events;
    this.t = 0;
    this.s = this.route.wrap(opts.s ?? app.startS ?? 0);
    this.auto = opts.auto ?? true;
    this.notch = N_INDEX;
    this.aMotor = 0;            // applied traction (+) / brake (-) acceleration, m/s²
    this.jerkNow = 0;
    this.accel = 0;             // net longitudinal acceleration
    this.throttle = 0;
    this.emergency = false;
    this.state = 'run';
    this.phase = null;          // HUD hint: arriving | doors-open | doors-closing | departing | ready
    this.seq = null;            // station dwell / standing-start timeline
    this.served = -1;           // station just served (ignored until left behind)
    this.skipped = -1;          // station passed without stopping
    this.assist = -1;           // station whose stop the assist is braking for (manual)
    this.overrideHeld = false;  // W physically held (to run through a stop)
    this._overrideT = 0;
    this.bellAt = -1e9;
    this._autoBellT = -1e9;
    this._manualBellT = -1e9;
    this._departT = -1e9;
    this.req = { u: 0, lastT: -1e9, persist: 0 };
    this.caution = 0;
    this.limit = Infinity;      // current speed restriction at the cab (m/s)
    this.vRef = 0;
    this._rung = new Set();
    this._visits = 0;
    this._lim = new Float32Array(512);
    this.curvature = this.route.curvature(this.s);
    this.nextStop = { station: null, distance: Infinity };

    if (this.events && this.events.on) this.events.on('bell-request', (e) => this.onBellRequest(e));

    // initial speed: given, or what the driver would be doing here
    this._updateStop();
    const r = this._restriction(0);
    let v0 = opts.speed;
    if (v0 == null) {
      v0 = Math.min(this.cruise(this.s), r.v);
      if (this.nextStop.station) v0 = Math.min(v0, STOP_CURVE.speed(this.nextStop.distance));
    }
    this.speed = Math.max(0, v0);
    // drop a stop that cannot be made comfortably from the initial speed
    const st = this.nextStop;
    if (st.station && this.speed > STOP_CURVE.speed(st.distance) + 1.2) { this.skipped = st.station.id; this._updateStop(); }
    // pre-load the motor with the effort that holds this speed (no start-up lurch)
    this.aMotor = this.speed > 0.1 ? clamp(this._resist(this.speed) + this._gradeAcc(), -VEHICLE.aService, this._tracMax(this.speed)) : 0;
    if (this.speed < 0.05) {
      this.speed = 0;
      const ns = this.nextStop;
      if (ns.station && Math.abs(ns.distance) < 3) this._beginDwell(ns.station, true);
      else this.seq = { kind: 'start', t0: this.t, dur: 2.6, belled: false };
      this.aMotor = -0.6;                              // standing on the holding brake
    }
  }

  // ------------------------------------------------------------------ vehicle model
  _tracMax(v) {
    const gov = clamp((VEHICLE.vMax + 0.4 - v) / 1.2, 0, 1);
    return VEHICLE.aTraction * Math.min(1, VEHICLE.vBase / Math.max(v, 0.1)) * gov;
  }
  _resist(v) { return v > 0.01 ? 0.011 + 0.0004 * v + 0.00011 * v * v : 0; }
  _gradeAcc() { return (G * this.route.grade(this.s)) / VEHICLE.rotMass; }

  /** Cruise speed for the section (40-45 km/h, varying smoothly along the line). */
  cruise(s) {
    const [a, b] = DRIVE.cruiseKmh;
    return ((a + b) / 2 + ((b - a) / 2) * noise1(this.route.wrap(s) / 380, 77)) * KMH;
  }

  // ------------------------------------------------------------------ restrictions
  /** Allowed speed now from curve / crossover limits ahead (braking curves), the
   *  feed-forward deceleration of that curve, and the limit at the tram itself. */
  _restriction(shift) {
    const route = this.route, layout = this.layout, step = 2;
    const back = Math.ceil(VEHICLE.length / step), ahead = Math.ceil(DRIVE.scanAhead / step);
    const n = Math.min(this._lim.length, back + ahead + 1);
    const vx = DRIVE.crossoverKmh * KMH;
    for (let i = 0; i < n; i++) {
      const y = this.s + (i - back) * step;
      const k = Math.abs(route.curvature(y));
      let v = k > 1e-5 ? Math.sqrt(DRIVE.aLat / k) : 99;
      if (layout.isInCrossover(y, 3)) v = Math.min(v, vx);
      this._lim[i] = v;
    }
    let best = 99, bestA = 0, here = 99, bestW = 99;
    for (let j = 0; j + back < n; j++) {
      // limit for the cab at x = s + j·step: every part of the tram (back to its rear) must respect it
      let w = 99;
      for (let i = j; i <= j + back; i++) if (this._lim[i] < w) w = this._lim[i];
      if (j === 0) here = w;
      if (w >= 99) continue;
      const dist = Math.max(0, j * step - shift);
      const v = Math.sqrt(w * w + 2 * DRIVE.aRestrict * dist);
      // feed-forward fades out over the last ~1.5 m/s so the brake releases onto the limit
      if (v < best) { best = v; bestW = w; bestA = j === 0 ? 0 : -DRIVE.aRestrict * smoothstep(0, 1.5, v - w); }
    }
    this.limit = here;
    return { v: best, a: bestA, w: bestW };
  }

  // ------------------------------------------------------------------ stations
  _updateStop() {
    const L = this.route.length;
    let best = null, bestD = Infinity;
    for (const st of this.layout.stations) {
      let d = this.route.wrap(st.stopS - this.s);
      if (d > L - 60) d -= L;                         // up to 60 m behind: negative
      if (st.id === this.served || st.id === this.skipped) {
        // ignored until the cab has left it behind
        if (d < -2) { if (st.id === this.served) this.served = -1; else this.skipped = -1; }
        continue;
      }
      if (d < -2) continue;
      if (d < bestD) { bestD = d; best = st; }
    }
    this.nextStop.station = best;                     // updated in place (no per-frame garbage)
    this.nextStop.distance = bestD;
    return this.nextStop;
  }

  _beginDwell(station, immediate = false) {
    this._visits++;
    const rng = RNG.from('dwell', station.id, this._visits);
    this.seq = {
      kind: 'station', station, t0: this.t - (immediate ? 2 : 0),
      dur: rng.range(DRIVE.dwell[0], DRIVE.dwell[1]), opened: false, closed: false, belled: false,
    };
    this.assist = -1;
    this.speed = 0;
    this.emergency = false;
    if (!this.auto) this.notch = N_INDEX;
    this.events.emit('station-arrive', { station });
  }

  _runSeq() {
    const q = this.seq, t = this.t - q.t0;
    if (q.kind === 'station') {
      if (!q.opened && t >= 1.1) { q.opened = true; this.events.emit('doors', { open: true, station: q.station }); }
      if (!q.closed && t >= q.dur - 4.2) { q.closed = true; this.events.emit('doors', { open: false, station: q.station }); }
      if (!q.belled && t >= q.dur - 1.5) { q.belled = true; this.ringBell(true, true); }
      this.phase = !q.opened ? 'arriving' : !q.closed ? 'doors-open' : 'doors-closing';
    } else {
      const go = this.auto || this.notch > N_INDEX;   // manual: waits for the driver to notch up
      if (!q.belled && t >= 0.9 && go) { q.belled = true; this.ringBell(true, true); }
      this.phase = go ? 'departing' : 'ready';
    }
    if (t >= q.dur && (q.kind === 'station' || q.belled)) {
      if (q.kind === 'station') {
        this.served = q.station.id;
        this.events.emit('station-depart', { station: q.station });
        if (!this.auto && this.notch <= N_INDEX) this.notch = N_INDEX + 3;   // automatic stop, automatic departure
      }
      this.seq = null;
      this._departT = this.t;
      this.state = 'depart';
    }
  }

  // ------------------------------------------------------------------ bell
  ringBell(auto = false, force = false) {
    if (auto && !force && this.t - this._autoBellT < DRIVE.autoBellGap) return false;
    if (!auto && this.t - this._manualBellT < 0.25) return false;
    if (auto) this._autoBellT = this.t; else this._manualBellT = this.t;
    this.bellAt = this.t;
    this.events.emit('bell', { auto });
    return true;
  }

  onBellRequest(e) {
    const u = clamp(+(e && e.urgency) || 0, 0, 1);
    this.req.u = Math.max(this.req.u, u);
    this.req.lastT = this.t;
    if (u >= 0.15 && this.speed > 0.5) this.ringBell(true);
  }

  // ------------------------------------------------------------------ controls
  setAuto(on) {
    if (on === this.auto) return;
    this.auto = on;
    if (!on) this.notch = this._nearestNotch();
  }
  _nearestNotch() {
    if (this.emergency) return 0;
    const th = this.throttle;
    if (th > 0.12) return N_INDEX + clamp(Math.round(th * 4), 1, 4);
    if (th < -0.12) return N_INDEX - clamp(Math.round(-th * 4), 1, 4);
    return N_INDEX;
  }
  stepNotch(dir) {
    if (this.auto) { this.auto = false; this.notch = this._nearestNotch(); }
    this.notch = clamp(this.notch + dir, 0, NOTCHES.length - 1);
  }

  // ------------------------------------------------------------------ driver
  /** Speed controller: desired net acceleration towards vRef with feed-forward. */
  _control(vRef, aFF) {
    const aDes = clamp(aFF + DRIVE.gain * (vRef - this.speed), -VEHICLE.aService, VEHICLE.aTraction);
    return aDes + this._resist(this.speed) + this._gradeAcc();
  }

  _command(dt) {
    const v = this.speed;
    const shift = v * 0.7 * smoothstep(1.5, 5, v);  // anticipate the jerk-limited brake onset
    const r = this._restriction(shift);
    const cruise = this.cruise(this.s);

    // pedestrians that stay on the track ahead: pre-brake (both modes)
    const q = this.req;
    if (this.t - q.lastT > 0.5) q.u = Math.max(0, q.u - 0.6 * dt);
    q.persist = q.u > 0.3 ? q.persist + dt : Math.max(0, q.persist - 2 * dt);
    const target = smoothstep(0.3, 1, q.u) * smoothstep(0.8, 2.2, q.persist);
    this.caution += (target - this.caution) * Math.min(1, dt * (target > this.caution ? 1.5 : 0.4));
    const vCaution = this.caution > 0.005 ? cruise * (1 - this.caution) : Infinity;

    // station stop
    const ns = this.nextStop;
    let vStop = Infinity;
    if (ns.station) {
      vStop = STOP_CURVE.speed(Math.max(0, ns.distance + 0.25 - shift));   // +0.25: final-creep controller lag
      if (v > vStop + 1.2 && this.assist !== ns.station.id) {   // not committed to this stop yet
        this.skipped = ns.station.id;                 // can no longer stop comfortably
        this._updateStop();
        vStop = Infinity;
      }
    }

    let vRef = Math.min(cruise, vCaution), aFF = 0;
    if (r.v < vRef) { vRef = r.v; aFF = r.a; }
    let aCmd;
    let assisted = false;
    if (this.auto) {
      // a slower limit within braking reach: no point accelerating towards it
      if (r.v < cruise) { const hold = Math.max(r.w, v); if (hold < vRef) { vRef = hold; aFF = 0; } }
      if (vStop < vRef) { vRef = vStop; aFF = -STOP_CURVE.decel(vStop); }
      if (ns.station && vStop <= cruise) this.assist = ns.station.id;   // committed to the stop
      aCmd = this._control(vRef, aFF);
      this.emergency = false;
    } else {
      const notch = NOTCHES[this.notch];
      this.emergency = !!notch.emergency;
      aCmd = notch.emergency ? -VEHICLE.aEmergency
        : notch.effort >= 0 ? notch.effort * this._tracMax(v) : notch.effort * VEHICLE.aService;
      // station stop assist: brakes for the platform unless W is held
      if (ns.station && vStop < Math.max(cruise, v) + 3) {        // approaching the platform
        this._overrideT = this.overrideHeld ? this._overrideT + dt : 0;
        if (this._overrideT > 0.5) { this.skipped = ns.station.id; this.assist = -1; this._overrideT = 0; this._updateStop(); }
        else if (this.assist === ns.station.id || v + 0.3 >= vStop) {
          this.assist = ns.station.id;
          if (!this.emergency) aCmd = Math.min(aCmd, this._control(vStop, -STOP_CURVE.decel(vStop)));
          assisted = true;
        }
      }
      // supervision: curve / switch limits, pedestrians, governor
      const vSup = Math.min(r.v, vCaution, VEHICLE.vMax);
      if (v > vSup - 0.5) aCmd = Math.min(aCmd, this._control(vSup, vSup === r.v ? r.a : 0));
    }
    this.vRef = vRef;
    this.assisting = assisted;
    return aCmd;
  }

  // ------------------------------------------------------------------ step
  step(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    this.t += dt;
    this._updateStop();

    let aCmd;
    this.phase = null;
    if (this.seq) {
      this._runSeq();
      aCmd = -0.6;                                    // holding brake, door interlock
    }
    if (!this.seq) {
      aCmd = this._command(dt);
      if (this.state === 'depart' && this.t - this._departT < 2 && this.speed < 3) this.phase = 'departing';
    }
    aCmd = clamp(aCmd, this.emergency ? -VEHICLE.aEmergency : -VEHICLE.aService, this._tracMax(this.speed));

    // integrate in small sub-steps (jerk-limited effort, then the vehicle)
    const n = Math.ceil(dt / (1 / 120)), h = dt / n;
    const J = this.emergency ? VEHICLE.jerkEmergency : VEHICLE.jerk;
    const snap = this.emergency ? 40 : VEHICLE.snap;
    let aNet = 0;
    for (let i = 0; i < n; i++) {
      const jd = clamp((aCmd - this.aMotor) / 0.3, -J, J);
      this.jerkNow += clamp(jd - this.jerkNow, -snap * h, snap * h);
      this.aMotor += this.jerkNow * h;
      const v = this.speed;
      aNet = this.aMotor - this._resist(v) - this._gradeAcc();
      if (v <= 0 && aNet <= 0) { aNet = 0; this.speed = 0; continue; }   // brakes hold / no roll-back
      let nv = v + aNet * h;
      if (nv < 0) { aNet = -v / h; nv = 0; }
      this.s = this.route.wrap(this.s + (v + nv) * 0.5 * h);
      this.speed = nv;
    }
    this.accel = aNet;
    this.throttle = clamp(this.aMotor >= 0 ? this.aMotor / Math.max(0.3, this._tracMax(this.speed)) : this.aMotor / VEHICLE.aService, -1, 1);
    this.curvature = this.route.curvature(this.s);
    this._updateStop();

    // arrival: stopped at the platform
    const ns = this.nextStop;
    if (!this.seq && ns.station && this.speed < 0.02 && Math.abs(ns.distance) < 1.5
      && this.assist === ns.station.id) this._beginDwell(ns.station);

    this._crossStreetBell();
    this._updateState();
  }

  _crossStreetBell() {
    if (!this.auto || this.speed < 5) return;
    for (const c of this.layout.crossStreets) {
      const d = this.route.delta(this.s, c.s);
      const key = Math.round(c.s);
      if (d > 20 && d < 45) {
        if (!this._rung.has(key) && hash2(key, 31) % 10 < 6 && this.ringBell(true)) this._rung.add(key);
      } else if (d < -30 && this._rung.has(key)) this._rung.delete(key);
    }
  }

  _updateState() {
    if (this.seq) this.state = this.seq.kind === 'station' ? 'dwell' : 'depart';
    else if (this.state === 'depart' && this.speed < 18 * KMH && this.t - this._departT < 15) this.state = 'depart';
    else if (this.aMotor < -0.15 || this.assisting || this.speed === 0) this.state = 'brake';
    else this.state = 'run';
  }
}

// ---------------------------------------------------------------------- module
const train = {
  name: 'train',
  // contract fields (kept in sync with the simulation every frame)
  s: 0, speed: 0, accel: 0, throttle: 0, auto: true, state: 'run',
  nextStop: { station: null, distance: Infinity }, curvature: 0, bellAt: -1e9,
  notches: NOTCHES,

  async init(app) {
    this.app = app;
    const p = app.params;
    this.tram = new Tram(app, { s: app.startS, speed: p.speed == null ? null : p.speed * KMH, auto: p.auto });
    input.attach(app.canvas);
    let lastNotchMs = 0;
    const notch = (dir, e) => {
      const now = performance.now();
      if (e.repeat && now - lastNotchMs < 170) return;   // held key: ~6 notches/s
      lastNotchMs = now;
      this.tram.stepNotch(dir);
      this.sync();
    };
    input.on('notchUp', (e) => notch(+1, e));
    input.on('notchDown', (e) => notch(-1, e));
    input.on('auto', (e) => { if (!e.repeat) { this.setAuto(!this.auto); } });
    input.on('bell', (e) => { if (!e.repeat) this.ringBell(); });
    this.sync();
  },

  update(dt, app) {
    this.tram.overrideHeld = input.held('notchUp');
    this.tram.step(dt);
    this.sync();
    U.uSpeed.value = this.speed;
    void app;
  },

  sync() {
    const t = this.tram;
    this.s = t.s; this.speed = t.speed; this.accel = t.accel; this.throttle = t.throttle;
    this.auto = t.auto; this.state = t.state; this.nextStop = t.nextStop; this.curvature = t.curvature;
    this.bellAt = t.bellAt; this.notch = t.notch; this.notchId = NOTCHES[t.notch].id;
    this.emergency = t.emergency; this.limit = t.limit; this.phase = t.phase; this.caution = t.caution;
    this.assisting = t.assisting; this.cruise = t.cruise(t.s);
  },

  // controls used by the UI
  setAuto(on) { this.tram.setAuto(!!on); this.sync(); },
  stepNotch(dir) { this.tram.stepNotch(dir); this.sync(); },
  ringBell() { return this.tram.ringBell(false); },
};
export default train;
