import { MAX_SPEED, TRACK_ZONE_HALF } from '../core/config.js';
import { RNG, noise1, hash2 } from '../core/rng.js';
import { U } from '../core/uniforms.js';
import { input } from './input.js';

// Tram dynamics: a ~32 m, five-module low-floor light-rail vehicle on the ride track.
// Contract (docs/ARCHITECTURE.md): app.train = {s, speed, accel, throttle, auto, state,
// nextStop, curvature, bellAt}. `s` is the cab front along the route. Also t (the
// simulation clock), holding (ride not started yet), coasting, notch, limit, phase.
//
//  - Traction: constant-torque up to vBase, constant power above, governor at 50 km/h.
//    Davis running resistance and the route grade act on the vehicle.
//  - Effort (motor/brake acceleration) is jerk limited with a softened onset, so every
//    change of throttle or brake ramps in smoothly like a real traction controller.
//  - Master controller notches: EB, B4..B1, N, P1..P4 (W / S step through them).
//  - Auto driver: cruise 40-45 km/h where the track corridor ahead is clear, easing down to
//    23-28 km/h (walking-plus pace) as more people walk in it (Tram.load: the corridor
//    count 5-200 m ahead, sampled every second and smoothed over ~5 s; the oncoming units
//    get theirs from trams.js), curve limit sqrt(aLat R), 25 km/h over crossovers
//    (until the rear of the tram has cleared), braking curves to every restriction and a
//    station stop with the cab front at station.stopS that ends firmly (~0.4 m/s², no
//    creeping), dwell 12-18 s with door events, bell, departure.
//  - Station stops are automatic in manual mode too (hold W to run through a stop),
//    and a speed supervisor keeps manual driving within curve / switch limits.
//  - Bell: B / Space, on departure, at some cross streets, and on crowd 'bell-request'
//    (rate limited); a pedestrian that stays on the track makes the tram pre-brake.
//  - The driver coasts: no more power once a stop or a slower limit is within ~1.35x
//    the braking distance, then a jerk-limited brake application that ends softly.
//  - Nothing moves before the ride starts (world ready; in the app, the start click).
//  - Tram.obstacle (m to something standing on the track ahead, set by the owner: the
//    oncoming units watch for people) brakes to stop short of it, emergency brake if need be.
//  - The oncoming units (./trams.js) are started from here while the module registry does
//    not list them (see _oncoming).

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
  busyKmh: [23, 28],       // cruise through a crowded pedestrian mall (load 1)
  busyPeople: 20,          // corridor people ahead (weighted) for a full load
  loadTau: 5,              // s, smoothing of the load
  aLat: 0.9,               // m/s² lateral comfort limit in curves
  crossoverKmh: 25,
  aStop: 0.85,             // planned station braking
  aRestrict: 0.6,          // planned braking towards curve / switch limits
  gain: 0.65,              // speed controller gain (1/s)
  scanAhead: 240,          // m of route scanned for restrictions
  dwell: [12, 18],         // s
  autoBellGap: 4,          // s between automatic bells
  coastMargin: 1.35,       // coast (no traction) within this multiple of the braking distance
  aCoastRestrict: 0.4,     // gentler curve that decides when to shut off power before a limit
  reqHold: 3.0,            // s a pedestrian request keeps its urgency (the crowd repeats every ~2.5 s)
  bellToGo: 1.2,           // s from the departure bell to moving off
  obstacleGap: 5,          // m short of an obstacle on the track where the tram stops
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

// planned stop: 0.85 m/s², easing to ~0.42 m/s² at standstill (a firm, short final stop)
const STOP_CURVE = new BrakeCurve(DRIVE.aStop, 1.6, 0.5);
const FINAL_STOP = [2.5, 1.0];   // m: blend into the required-rate final stop over these distances
const STOP_LAG = 0.0;         // m, final-stop aim point beyond the mark (0: the cab front stops on it)

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
    this.obstacle = Infinity;   // m to something standing on the track ahead (set by the owner)
    this.limit = Infinity;      // current speed restriction at the cab (m/s)
    this.vRef = 0;
    this.coasting = false;
    this.load = 0;              // pedestrian load of the corridor ahead (0..1, smoothed): lowers the cruise
    this.loadTarget = 0;
    this._givenSpeed = opts.speed != null;
    this._rung = new Set();
    this._visits = 0;
    this._lim = new Float32Array(512);
    this._r = { v: 99, a: 0, w: 99, hold: 99, holdW: 99 };
    this.curvature = this.route.curvature(this.s);
    this.nextStop = { station: null, distance: Infinity };
    this._queue = [];           // events raised before the first step (listeners may not exist yet)

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
      else this._beginStart();
      this.aMotor = -0.6;                              // standing on the holding brake
    }
    this._updateState();
  }

  /** Events go out from the first step on, so every listener has subscribed by then. */
  _emit(type, data) {
    if (this._queue) this._queue.push(type, data);
    else this.events.emit(type, data);
  }

  /** Standing start: bell, then move off DRIVE.bellToGo later (manual: once notched up). */
  _beginStart(belled = false, station = null) {
    this.seq = { kind: 'start', t0: this.t, bellT: belled ? this.t - DRIVE.bellToGo : -1e9, belled, station, release: false };
  }

  // ------------------------------------------------------------------ vehicle model
  _tracMax(v) {
    const gov = clamp((VEHICLE.vMax + 0.4 - v) / 1.2, 0, 1);
    return VEHICLE.aTraction * Math.min(1, VEHICLE.vBase / Math.max(v, 0.1)) * gov;
  }
  _resist(v) { return v > 0.01 ? 0.011 + 0.0004 * v + 0.00011 * v * v : 0; }
  _gradeAcc() { return (G * this.route.grade(this.s)) / VEHICLE.rotMass; }

  /** Cruise speed for the section (40-45 km/h, varying smoothly along the line), eased
   *  down towards 23-28 km/h by the pedestrian load of the corridor ahead. */
  cruise(s) {
    const n = noise1(this.route.wrap(s) / 380, 77);
    const [a, b] = DRIVE.cruiseKmh, [c, d] = DRIVE.busyKmh;
    const free = (a + b) / 2 + ((b - a) / 2) * n, busy = (c + d) / 2 + ((d - c) / 2) * n;
    return (free + (busy - free) * this.load) * KMH;
  }

  /** Pedestrian load ahead (0..1). Smoothed over DRIVE.loadTau while running; `immediate`
   *  sets it at once and, before the first step, starts the tram at the cruise it gives
   *  (unless an initial speed was asked for), so a ride never opens with a slow-down. */
  setLoad(x, immediate = false) {
    this.loadTarget = clamp(+x || 0, 0, 1);
    if (!immediate) return;
    this.load = this.loadTarget;
    if (this.t > 0 || this._givenSpeed || this.seq || this.speed < 0.05) return;
    const v = Math.min(this.speed, this.cruise(this.s));
    if (v >= this.speed) return;
    this.speed = v;
    this.aMotor = clamp(this._resist(v) + this._gradeAcc(), -VEHICLE.aService, this._tracMax(v));
  }

  // ------------------------------------------------------------------ restrictions
  /** Allowed speed now from curve / crossover limits ahead (braking curves), the
   *  feed-forward deceleration of that curve, the limit itself (w) and the gentler
   *  coast curve (hold) below which the driver shuts off power. `shift` moves the
   *  braking curves closer by the distance lost while the brake ramps in. */
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
    let best = 99, bestA = 0, here = 99, bestW = 99, hold = 99, holdW = 99;
    for (let j = 0; j + back < n; j++) {
      // limit for the cab at x = s + j·step: every part of the tram (back to its rear) must respect it
      let w = 99;
      for (let i = j; i <= j + back; i++) if (this._lim[i] < w) w = this._lim[i];
      if (j === 0) here = w;
      if (w >= 99) continue;
      const dist = Math.max(0, j * step - shift);
      const wt = w - 0.25;                            // drivers aim a little under the limit
      const v = Math.sqrt(wt * wt + 2 * DRIVE.aRestrict * dist);
      // feed-forward fades out as the tram gets down to the limit, so the brake releases onto it
      if (v < best) { best = v; bestW = w; bestA = j === 0 ? 0 : -DRIVE.aRestrict * smoothstep(0, 0.8, Math.min(v, this.speed) - wt); }
      const h = Math.sqrt(w * w + 2 * DRIVE.aCoastRestrict * dist);
      if (h < hold) { hold = h; holdW = w; }
    }
    this.limit = here;
    const r = this._r;
    r.v = best; r.a = bestA; r.w = bestW; r.hold = hold; r.holdW = holdW;
    return r;
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
    this._emit('station-arrive', { station, visit: this._visits });
  }

  _runSeq() {
    const q = this.seq, t = this.t - q.t0;
    if (q.kind === 'station') {
      const visit = this._visits;
      if (!q.opened && t >= 1.1) { q.opened = true; this._emit('doors', { open: true, station: q.station, visit }); }
      if (!q.closed && t >= q.dur - 4.2) { q.closed = true; this._emit('doors', { open: false, station: q.station, visit }); }
      if (!q.belled && t >= q.dur - 1.5) { q.belled = true; this.ringBell(true, true); }
      this.phase = !q.opened ? 'arriving' : !q.closed ? 'doors-open' : 'doors-closing';
      q.release = t >= q.dur - 0.7;                    // brakes release just before moving off
      if (t < q.dur) return;
      this.served = q.station.id;
      if (!this.auto && this.notch < N_INDEX) {
        // the driver is holding the tram on the brake: wait until notched up
        this._beginStart(true, q.station);
        this.phase = 'ready';
        return;
      }
      if (!this.auto && this.notch === N_INDEX) this.notch = N_INDEX + 3;   // automatic stop, automatic departure
      this._depart();
      return;
    }
    // standing start: bell, then move off a moment later (manual: waits for power)
    const go = this.auto || this.notch > N_INDEX;
    if (!q.belled && go && (!this.auto || t >= 0.5)) { q.belled = true; q.bellT = this.t; this.ringBell(true, true); }
    this.phase = go ? 'departing' : 'ready';
    q.release = go && q.belled && this.t - q.bellT >= DRIVE.bellToGo - 0.7;
    if (go && q.belled && this.t - q.bellT >= DRIVE.bellToGo) this._depart();
  }

  _depart() {
    const st = this.seq && this.seq.station;
    if (st) this._emit('station-depart', { station: st });
    this.seq = null;
    this._departT = this.t;
    this.state = 'depart';
  }

  // ------------------------------------------------------------------ bell
  ringBell(auto = false, force = false) {
    if (auto && !force && this.t - this._autoBellT < DRIVE.autoBellGap) return false;
    if (!auto && this.t - this._manualBellT < 0.25) return false;
    if (auto) this._autoBellT = this.t; else this._manualBellT = this.t;
    this.bellAt = this.t;
    this._emit('bell', { auto });
    return true;
  }

  /** Crowd request (repeated every ~2.5 s while someone stays near the track ahead). The
   *  urgency is held for DRIVE.reqHold s; a lower repeat lowers it only gradually. */
  onBellRequest(e) {
    const u = clamp(+(e && e.urgency) || 0, 0, 1), q = this.req;
    q.u = Math.max(u, Math.min(q.u, u + 0.2));
    q.lastT = this.t;
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

  /** Last metres of a station stop: brake at the constant rate that ends exactly at the
   *  mark (self-correcting, no creeping), so the stop ends firmly at ~0.4-0.5 m/s²
   *  instead of dragging out the last half metre. */
  _finalStop(aCmd, dist) {
    const v = this.speed;
    if (dist > FINAL_STOP[0] || v > 3 || v < 1e-3) return aCmd;
    const aReq = (v * v) / (2 * Math.max(0.02, dist + STOP_LAG));
    const w = smoothstep(FINAL_STOP[0], FINAL_STOP[1], dist);
    return aCmd + w * (-aReq + this._resist(v) + this._gradeAcc() - aCmd);
  }

  /** Distance (m) covered while the brake still builds up to -aPlan from the present effort. */
  _onset(v, aPlan) {
    const need = Math.max(0, this.aMotor + aPlan);
    return 0.5 * v * (need / VEHICLE.jerk + ((2 * VEHICLE.jerk) / VEHICLE.snap) * Math.min(1, need / aPlan));
  }

  _command(dt) {
    const v = this.speed;
    // braking curves are moved closer by the distance lost while the brake ramps in
    const shiftR = this._onset(v, DRIVE.aRestrict);
    const shiftS = this._onset(v, DRIVE.aStop);
    const r = this._restriction(shiftR);
    const cruise = this.cruise(this.s);

    // pedestrians that stay on the track ahead: pre-brake (both modes). The crowd repeats
    // its request every ~2.5 s, so the urgency is held between requests.
    const q = this.req, since = this.t - q.lastT;
    if (since > DRIVE.reqHold) {
      q.u = Math.max(0, q.u - 0.6 * dt);
      q.persist = Math.max(0, q.persist - 2 * dt);
    } else if (q.u > 0.3) q.persist += dt;
    const target = smoothstep(0.3, 1, q.u) * smoothstep(0.4, 1.6, q.persist);
    this.caution += (target - this.caution) * Math.min(1, dt * (target > this.caution ? 1.5 : 0.4));
    const vCaution = this.caution > 0.005 ? cruise * (1 - this.caution) : Infinity;

    // station stop
    const ns = this.nextStop;
    let vStop = Infinity, vCoastStop = Infinity;
    if (ns.station) {
      vStop = STOP_CURVE.speed(Math.max(0, ns.distance + STOP_LAG - shiftS));
      if (v > vStop + 1.2 && this.assist !== ns.station.id) {   // not committed to this stop yet
        this.skipped = ns.station.id;                 // can no longer stop comfortably
        this._updateStop();
        vStop = Infinity;
      } else vCoastStop = STOP_CURVE.speed(Math.max(0, ns.distance - shiftS) / DRIVE.coastMargin);
    }

    let vRef = Math.min(cruise, vCaution), aFF = 0;
    let aCmd;
    let assisted = false;
    if (this.auto) {
      // a stop or a slower limit ahead: no more power than needed to get there, then roll
      const limitAhead = r.hold < cruise && r.holdW < this.limit - 0.05;
      const vCoast = Math.min(vCoastStop, limitAhead ? r.holdW : Infinity);
      let coast = false;
      if (vCoast < vRef) {
        if (v >= vCoast - (this.coasting ? 1.0 : 0.1)) { coast = true; vRef = Math.min(vRef, v); }
        else vRef = vCoast;
      }
      this.coasting = coast;
      if (r.v < vRef) { vRef = r.v; aFF = r.a; }
      if (vStop < vRef) { vRef = vStop; aFF = -STOP_CURVE.decel(vStop); }
      if (ns.station && vStop <= cruise) this.assist = ns.station.id;   // committed to the stop
      // something on the track ahead: brake to stop short of it (emergency brake if need be)
      const ob = this.obstacle - DRIVE.obstacleGap;
      let emergency = false;
      if (ob < DRIVE.scanAhead) {
        const vObs = STOP_CURVE.speed(Math.max(0, ob - shiftS));
        if (vObs < vRef) { vRef = vObs; aFF = -STOP_CURVE.decel(vObs); }
        emergency = v > 0.5 && (v * v) / (2 * Math.max(0.5, ob + 2)) > VEHICLE.aService;
      }
      aCmd = this._control(vRef, aFF);
      if (coast) aCmd = Math.min(aCmd, 0);
      if (ns.station && this.assist === ns.station.id) aCmd = this._finalStop(aCmd, ns.distance);
      if (emergency) aCmd = -VEHICLE.aEmergency;
      this.emergency = emergency;
    } else {
      this.coasting = false;
      if (r.v < vRef) { vRef = r.v; aFF = r.a; }
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
          if (!this.emergency) aCmd = Math.min(aCmd, this._finalStop(this._control(vStop, -STOP_CURVE.decel(vStop)), ns.distance));
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
    if (this._queue) {
      // first step of the ride: deliver what happened while setting up
      const qu = this._queue;
      this._queue = null;
      for (let i = 0; i < qu.length; i += 2) this.events.emit(qu[i], qu[i + 1]);
    }
    dt = Math.min(dt, 0.1);
    this.t += dt;
    this.load += (this.loadTarget - this.load) * (1 - Math.exp(-dt / DRIVE.loadTau));
    this._updateStop();

    let aCmd;
    this.phase = null;
    if (this.seq) {
      this._runSeq();
      aCmd = this.seq && this.seq.release ? 0 : -0.6;   // holding brake, door interlock
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

/**
 * Weighted count of the people in the track corridor (|d| ≤ TRACK_ZONE_HALF), read from
 * the crowd: weight(u, d) with u = metres ahead of the camera along the route. Null
 * without a crowd.
 */
export function corridorPeople(app, weight) {
  const cr = app.crowd, sim = cr && !cr.disabled ? cr.sim : null;
  const agents = sim && sim.population && sim.population.agents;
  if (!agents || typeof sim.camU !== 'number') return null;
  let n = 0;
  for (const a of agents) {
    if (!a.active || !(Math.abs(a.d) <= TRACK_ZONE_HALF)) continue;
    n += weight(a.s - sim.camU, a.d);
  }
  return n;
}

// ---------------------------------------------------------------------- module
const train = {
  name: 'train',
  // contract fields (kept in sync with the simulation every frame)
  s: 0, speed: 0, accel: 0, throttle: 0, auto: true, state: 'run',
  nextStop: { station: null, distance: Infinity }, curvature: 0, bellAt: -1e9,
  notches: NOTCHES,
  t: 0,               // simulation clock (s): stands still while the ride is held
  holding: true,      // the ride has not started yet (world loading / start overlay)
  coasting: false,
  _trams: null,       // oncoming units started from here (see _oncoming)
  corridorCount: 0,   // weighted people in the track corridor ahead (last sample)
  pedLoad: 0,         // the driver's smoothed pedestrian load (0..1)
  _loadT: 0,
  _loadInit: false,
  _tramErrors: 0,

  async init(app) {
    this.app = app;
    const p = app.params;
    // interactive ride without an explicit speed: a standing start once the rider clicks
    const interactive = !p.capture && !!app.systems.ui;
    const speed = p.speed != null ? p.speed * KMH : interactive ? 0 : null;
    this.tram = new Tram(app, { s: app.startS, speed, auto: p.auto });
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
    await this._oncoming(app);
  },

  /** The oncoming units (./trams.js) are a module of their own; while the registry does not
   *  list it, the train starts it and drives its update (it honours only= / skip=). */
  async _oncoming(app) {
    const p = app.params;
    if (app.systems.trams || p.skip.includes('trams') || (p.only && !p.only.includes('trams'))) return;
    try {
      const m = (await import('./trams.js')).default;
      app.systems.trams = m;
      await m.init(app);
      this._trams = m;
    } catch (e) {
      console.error('[train] oncoming trams unavailable', e);
    }
  },

  update(dt, app) {
    // nothing moves until the world is ready and (in the app) the rider has clicked to start
    const ui = app.ui;
    this.holding = !app.ready || !!(ui && !ui.disabled && ui.holding);
    this._sampleLoad(app, dt);
    this.tram.overrideHeld = input.held('notchUp');
    this.tram.step(this.holding ? 0 : dt);
    this.sync();
    U.uSpeed.value = this.speed;
    const tm = this._trams;
    if (tm && !tm.disabled) {
      try { tm.update(dt, app); } catch (e) {
        console.error('[train] trams.update failed', e);
        if (++this._tramErrors > 5) tm.disabled = true;
      }
    }
  },

  /** People in the track corridor ahead set the driver's cruise (Tram.load): every second
   *  while riding; every frame (taken at once) until the ride starts, so it opens at the
   *  pace the street allows. */
  _sampleLoad(app, dt) {
    if (!this.holding && this._loadInit) {
      this._loadT -= dt;
      if (this._loadT > 0) return;
    }
    this._loadT = 1;
    const n = corridorPeople(app, (u, d) => (u > 5 && u < 200 ? (d > -0.2 ? 1 : 0.6) : 0));
    if (n == null) return;
    this.corridorCount = n;
    const x = n / DRIVE.busyPeople;
    if (this.holding || !this._loadInit) { this.tram.setLoad(x, true); this._loadInit = !this.holding; }
    else this.tram.setLoad(x);
  },

  sync() {
    const t = this.tram;
    this.s = t.s; this.speed = t.speed; this.accel = t.accel; this.throttle = t.throttle;
    this.auto = t.auto; this.state = t.state; this.nextStop = t.nextStop; this.curvature = t.curvature;
    this.bellAt = t.bellAt; this.notch = t.notch; this.notchId = NOTCHES[t.notch].id;
    this.emergency = t.emergency; this.limit = t.limit; this.phase = t.phase; this.caution = t.caution;
    this.assisting = t.assisting; this.coasting = t.coasting; this.cruise = t.cruise(t.s); this.t = t.t;
    this.pedLoad = t.load;
  },

  // controls used by the UI
  setAuto(on) { this.tram.setAuto(!!on); this.sync(); },
  stepNotch(dir) { this.tram.stepNotch(dir); this.sync(); },
  ringBell() { return this.tram.ringBell(false); },
};
export default train;
