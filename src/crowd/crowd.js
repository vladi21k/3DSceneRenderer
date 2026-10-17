import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { StreetMap } from './behaviour/streetMap.js';
import { Visibility } from './behaviour/visibility.js';
import { Population } from './behaviour/population.js';
import { Steering } from './behaviour/steering.js';
import { TramWatch } from './behaviour/tram.js';
import { KIND, ST, STATE_NAMES, TASK_NAMES, KIND_NAMES } from './behaviour/agent.js';
import { MAX_AGENTS, RIDE_D, SWEPT_HALF, SWEPT_AHEAD, AGENT_R } from './behaviour/constants.js';

// Crowd behaviour: where the pedestrians of the street go and what they do. The
// figures themselves are drawn by app.humans; this module feeds it one record per
// slot every frame. Contract: docs/ARCHITECTURE.md (humans / crowd).
//
//   behaviour/streetMap   walkable space precomputed from the layout (+ shop doors)
//   behaviour/population  spawning where unseen, recycling, groups, cafés, benches, platforms
//   behaviour/behaviour   decisions and tasks (browse, shops, side streets, crossings…)
//   behaviour/steering    social-force avoidance, obstacles, walls, gait and gaze
//   behaviour/tram        tram clearance, bell requests, swept-volume guarantee
//   behaviour/visibility  frustum / facade / occluder tests for hidden spawns

const PI = Math.PI;
const _v = new THREE.Vector3();

class CrowdSim {
  constructor(app, opts = {}) {
    this.app = app;
    this.route = app.route;
    this.layout = app.layout;
    this.seed = app.layout.seed;
    this.rng = RNG.from(this.seed, 'crowd');
    this.humans = app.humans && !app.humans.disabled ? app.humans : null;
    this.map = new StreetMap(app, opts);
    this.vis = new Visibility(app.route);
    this.counts = { seated: 0, passenger: 0, stand: 0, walker: 0 };
    this.tram = new TramWatch(this);
    this.population = new Population(this);
    this.steering = new Steering(this);
    this.time = 0; this.dt = 0;
    this.camU = null; this.camW = 0;
    this.out = { x: 0, y: 0, z: 0, heading: 0, speed: 0, phase: 0, pose: 0, look: 0, appearance: 0, visible: true };
    this.popIn = [0, 0, 0, 0]; this.popSrc = {}; this.featureIn = [0, 0];
    this.events = {};
    this.perf = { avg: [0, 0, 0, 0], acc: [0, 0, 0, 0], max: [0, 0, 0, 0], n: 0, over: 0, ring: new Float32Array(240), ri: 0, rn: 0 };
    this.check = { on: app.params.num('crowdCheck', 0) === 1, samples: 0, violations: 0, minClear: 99, log: [], wall: 0, wallLog: [], overlap: 0, agentFrames: 0, teleports: 0, teleLog: [] };
    // renderer slots; alloc may hand back the first index of our block
    const base = this.humans && this.humans.alloc ? this.humans.alloc(MAX_AGENTS) : 0;
    this.base = Number.isInteger(base) ? base : 0;
    app.events.on('bell', () => this.onBell());
  }

  /** Event counters for the debug stats. */
  tally(k) { this.events[k] = (this.events[k] || 0) + 1; }

  featureRng(...parts) { return RNG.from(this.seed, 'crowd', ...parts); }
  /** Wrapped route s → unwrapped s in the crowd frame (nearest copy to the camera). */
  unwrap(s) { return this.camU + this.route.delta(this.camW, s); }

  onKill(a) { if (this.humans && this.humans.setVisible) this.humans.setVisible(this.base + a.slot, false); }

  /** The bell is routine on this street: people on or right beside the ride track look round
   *  and step clear; on the sidewalks only a few glance up. */
  onBell() {
    this.tram.onBell(this.time);
    const r = this.rng, tram = this.tram;
    const reach = Math.max(40, 1.5 * tram.stopDist);
    let reacted = 0;
    for (const a of this.population.agents) {
      if (!a.active || a.state === ST.SEATED) continue;
      const ahead = a.s - tram.trainU;
      if (ahead < -8 || ahead > reach + 20) continue;
      const near = Math.abs(a.d - RIDE_D) < 3.5 && ahead < reach;
      if (!r.chance(near ? 0.85 : 0.08)) continue;
      const delay = Math.max(0, ahead) / 340 + r.range(0.2, 1.2); // sound travel + reaction
      a.tramLookS = this.time + delay;
      a.tramLookT = a.tramLookS + (near ? r.range(1.2, 2.6) : r.range(0.4, 0.9));
      reacted++;
      if (!near) continue;
      a.bellT = this.time + delay + 5;
      // beside the track (not in the band): a step back, turning towards the tram
      const dl = a.d - RIDE_D;
      if (Math.abs(dl) > 1.9 && a.kind !== KIND.SEATED) {
        a.dodge = Math.sign(dl) * r.range(0.35, 0.7); a.dodgeT = a.tramLookS + 2.2; a.dodgeD0 = a.d;
        if (a.state === ST.STAND || a.state === ST.WAIT || a.state === ST.PLATFORM) a.faceA = this._faceTram(a);
      }
    }
    this.lastBellReact = reacted;
  }

  /** Route-relative facing (alpha) towards the cab. */
  _faceTram(a) { return Math.atan2(RIDE_D - a.d, this.tram.trainU - a.s); }

  /** Head yaw (relative to the body, + left) that looks at the cab. */
  lookAtTram(a) {
    if (this.time < a.tramLookS && a.state !== ST.WAIT) return a.lookGoal;
    const p = this.route.toWorld(this.tram.trainU, RIDE_D, 2.2, _v);
    const yaw = Math.atan2(-(p.x - a.x), -(p.z - a.z));
    let rel = yaw - a.heading;
    rel = ((rel + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI;
    if (Math.abs(rel) > 2.3) return Math.sign(rel) * 0.9; // tram right behind: a glance over the shoulder
    if (Math.abs(rel) < PI / 2) return Math.max(-0.7, Math.min(0.7, rel)); // in front: a turn of the head
    return Math.max(-1.2, Math.min(1.2, rel));
  }

  update(dt, app) {
    const t0 = performance.now();
    const route = this.route;
    const camS = app.cameraS ?? app.train?.s ?? app.startS;
    let first = false;
    if (this.camU === null) { this.camU = camS; this.camW = route.wrap(camS); first = true; }
    else {
      const dd = route.delta(this.camW, camS);
      if (Math.abs(dd) > 150) { // teleport: start over around the new position
        this.population.reset();
        first = true;
      }
      this.camU += dd; this.camW = route.wrap(camS);
    }
    const trainU = this.camU + route.delta(camS, app.train?.s ?? camS);
    this.tram.update(app, trainU);
    this.vis.update(app.camera, this.camU, camS);
    if (first) this.population.fillInitial();

    this.dt = dt;
    if (dt > 0) {
      this.time += dt;
      const t1 = performance.now();
      this.population.maintain(dt);
      const t2 = performance.now();
      this.steering.step(dt);
      const t3 = performance.now();
      this.tram.flushRequests(app, this.time);
      this._lap(1, t2 - t1); this._lap(2, t3 - t2);
    }
    const t4 = performance.now();
    this._output(dt);
    this._lap(3, performance.now() - t4);
    this._lap(0, performance.now() - t0);
    if (this.check.on) this._selfCheck(app);
  }

  /** CPU time per part: 0 total, 1 population, 2 steering, 3 output (averaged over 60 frames, max after warm-up). */
  _lap(k, ms) {
    const p = this.perf;
    p.acc[k] += ms;
    if (k === 0) { p.ring[p.ri] = ms; p.ri = (p.ri + 1) % p.ring.length; p.rn = Math.min(p.rn + 1, p.ring.length); }
    if (this.time > 2) { p.max[k] = Math.max(p.max[k], ms); if (k === 0 && ms > 1.5) p.over++; }
    if (k === 0 && ++p.n >= 60) {
      for (let i = 0; i < 4; i++) { p.avg[i] = p.acc[i] / p.n; p.acc[i] = 0; }
      p.n = 0;
    }
  }

  _output(dt) {
    const route = this.route, map = this.map, H = this.humans, o = this.out, ck = this.check;
    for (const a of this.population.agents) {
      if (!a.active) continue;
      // platforms raise the feet
      let hT = 0;
      if (a.noRect && a.state !== ST.SEATED) { const pl = map.platformAt(a.s, a.d >= 0 ? 1 : -1, Math.abs(a.d), -0.05); if (pl) hT = pl.h; }
      a.h += Math.max(-1.5 * dt, Math.min(1.5 * dt, hT - a.h));
      if (dt === 0 || a.fresh) a.h = hT;
      route.toWorld(a.s, a.d, a.h, _v);
      a.x = _v.x; a.y = _v.y; a.z = _v.z;
      // distance actually covered since the last frame (drives the gait phase)
      let dist = 0;
      if (a.pValid && !a.fresh) {
        const dx = a.x - a.px, dz = a.z - a.pz;
        dist = Math.sqrt(dx * dx + dz * dz);
        if (ck.on && dt > 0 && dist > 3 * Math.max(1.6, a.vmaxCur) * dt * (a.simple ? 2 : 1) + 0.01) {
          ck.teleports++;
          if (ck.teleLog.length < 10) ck.teleLog.push({ t: +this.time.toFixed(2), dist: +dist.toFixed(2), rel: +(a.s - this.camU).toFixed(1), d: +a.d.toFixed(2), st: STATE_NAMES[a.state], task: TASK_NAMES[a.task], lead: !!a.leader });
        }
      }
      a.px = a.x; a.pz = a.z; a.pValid = true;
      this.steering.animate(a, dt, H, dist);
      if (a.fresh) {
        // appearances in plain view, by distance (spawns that passed a hidden test are not counted)
        a.fresh = false;
        if (this.time > 1 && (a.src === 'seat' || a.src === 'platform') && this.vis.inView(a.s, a.d)) {
          const k = Math.abs(a.s - this.camU) < 450 ? 0 : 1;
          this.featureIn[k]++;
        }
        if (this.time > 1 && !a.spawnHidden && this.vis.inView(a.s, a.d)) {
          const side = a.d >= 0 ? 1 : -1, m = map.mouthAt(a.s, side);
          const behind = a.inDoor || Math.abs(a.d) > (m ? map.mouthLine(m, side) : map.facadeAt(a.s, side)) - 0.2;
          if (!behind) {
            const dist2 = Math.abs(a.s - this.camU);
            this.popIn[dist2 < 100 ? 0 : dist2 < 250 ? 1 : dist2 < 450 ? 2 : 3]++;
            this.popSrc[a.src] = (this.popSrc[a.src] || 0) + 1;
          }
        }
      }
      a.heading = route.heading(a.s) - PI / 2 - a.alpha;
      if (!H || !H.set) continue;
      o.x = a.x; o.y = a.y; o.z = a.z;
      o.heading = a.heading; o.speed = a.speed; o.phase = a.phase; o.pose = a.pose;
      o.look = a.look; o.appearance = a.appearance; o.visible = true;
      H.set(this.base + a.slot, o);
    }
  }

  /** Independent check of the hard guarantee from the world positions handed to the renderer. */
  _selfCheck(app) {
    const ck = this.check, route = this.route, tr = app.train;
    if (!tr) return;
    const map = this.map;
    for (const a of this.population.agents) {
      if (!a.active) continue;
      // walls and obstacles (route coordinates)
      const side = a.d >= 0 ? 1 : -1, ad = Math.abs(a.d);
      // (seated patrons sit where the layout put the chairs)
      if (a.state !== ST.SEATED && !a.inDoor && !map.mouthAt(a.s, side) && ad > map.wallAt(a.s, side) + 0.02) {
        ck.wall++;
        if (ck.wallLog.length < 8) ck.wallLog.push({ s: +this.route.wrap(a.s).toFixed(1), d: +a.d.toFixed(2), wall: +map.wallAt(a.s, side).toFixed(2), st: STATE_NAMES[a.state], task: TASK_NAMES[a.task], kind: KIND_NAMES[a.kind], src: a.src });
      }
      if (a.state !== ST.SEATED && a.kind !== KIND.PASSENGER) {
        const n = map.gatherCircles(a.s, 1);
        for (let q = 0; q < n; q++) {
          const i = map.qI[q], ds = map.qDS[q], dd = map.cD[i] - a.d;
          if (ds * ds + dd * dd < (map.cR[i] + AGENT_R * 0.5) ** 2) { ck.overlap++; break; }
        }
      }
      ck.agentFrames++;
      if (Math.abs(a.s - this.tram.trainU) > 20) continue;
      const p = route.project(a.x, a.z, route.wrap(a.s), 4);
      const ahead = route.delta(tr.s, p.s);
      const lat = Math.abs(p.d - RIDE_D) - SWEPT_HALF - AGENT_R;
      ck.samples++;
      if (ahead > -AGENT_R && ahead < SWEPT_AHEAD + AGENT_R) {
        ck.minClear = Math.min(ck.minClear, lat);
        if (lat < 0) {
          ck.violations++;
          if (ck.log.length < 20) ck.log.push({ t: +this.time.toFixed(2), ahead: +ahead.toFixed(2), d: +p.d.toFixed(2), state: STATE_NAMES[a.state], task: TASK_NAMES[a.task] });
        }
      }
    }
  }

  /** Percentile of the total update time over the last 240 frames. */
  _pct(q) {
    const p = this.perf;
    if (!p.rn) return 0;
    const v = Array.from(p.ring.subarray(0, p.rn)).sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(q * v.length))];
  }

  stats() {
    const byState = {}, byTask = {}, byKind = {};
    let active = 0, clearing = 0, simple = 0, followers = 0, corridor = 0, children = 0, childAlone = 0;
    const lanes = [0, 0, 0], band = [0, 0, 0, 0];
    for (const a of this.population.agents) {
      if (!a.active) continue;
      active++;
      byState[STATE_NAMES[a.state]] = (byState[STATE_NAMES[a.state]] || 0) + 1;
      byTask[TASK_NAMES[a.task]] = (byTask[TASK_NAMES[a.task]] || 0) + 1;
      byKind[KIND_NAMES[a.kind]] = (byKind[KIND_NAMES[a.kind]] || 0) + 1;
      if (a.clearing) clearing++;
      if (a.simple) simple++;
      if (a.leader) followers++;
      if (a.isChild) { children++; if (!a.leader && !a.guardian) childAlone++; }
      if (Math.abs(a.d) < 3.4) corridor++;
      if (a.state === ST.WALK && !a.leader) lanes[a.lane]++;
      if (a.s - this.camU > 30 && a.s - this.camU < 250) {
        const k = a.d < -3.4 ? 0 : a.d < -0.2 ? 1 : a.d < 3.4 ? 2 : 3;
        band[k]++;
      }
    }
    const ck = this.check, pop = this.population;
    return {
      active, walkerTarget: Math.round(pop.walkerTarget), byKind, byState, byTask, clearing, simple, followers, corridor, children, childAlone,
      lanes: { side: lanes[0], edge: lanes[1], corridor: lanes[2] },
      crossSection30to250m: { leftWalk: band[0], leftTrack: band[1], rideTrack: band[2], rightWalk: band[3] },
      tram: { ...this.tram.stats, v: +this.tram.v.toFixed(2), clearAhead: +this.tram.clearAhead.toFixed(1), stoppedAt: this.tram.stoppedAt ? this.tram.stoppedAt.id : null },
      violationLog: this.tram.violationLog.slice(0, 5), reqLog: this.tram.reqLog, rescueLog: this.tram.rescueLog,
      check: ck.on ? { samples: ck.samples, violations: ck.violations, minClear: +ck.minClear.toFixed(3), log: ck.log.slice(0, 5), agentFrames: ck.agentFrames, wall: ck.wall, wallLog: ck.wallLog, obstacleOverlap: ck.overlap, teleports: ck.teleports, teleLog: ck.teleLog.slice(0, 5), blocked: this.tram.stats.blocked } : null,
      population: pop.stats, events: this.events,
      visibleSpawns: { under100m: this.popIn[0], under250m: this.popIn[1], under450m: this.popIn[2], beyond450m: this.popIn[3], bySource: this.popSrc },
      featureArrivalsInView: { under450m: this.featureIn[0], beyond450m: this.featureIn[1] },
      blockLog: this.check.on ? summarize(this.tram.blockLog) : null,
      visibleDespawns: { under100m: pop.popOut[0], under250m: pop.popOut[1], under450m: pop.popOut[2], beyond450m: pop.popOut[3] },
      cpuMedianMs: +this._pct(0.5).toFixed(3), cpuP95Ms: +this._pct(0.95).toFixed(3),
      cpuMs: +this.perf.avg[0].toFixed(3), cpuMaxMs: +this.perf.max[0].toFixed(3), framesOver1_5ms: this.perf.over,
      cpuParts: { population: [+this.perf.avg[1].toFixed(3), +this.perf.max[1].toFixed(2)], steering: [+this.perf.avg[2].toFixed(3), +this.perf.max[2].toFixed(2)], output: [+this.perf.avg[3].toFixed(3), +this.perf.max[3].toFixed(2)] },
    };
  }
}

/** Count identical strings (debug logs). */
function summarize(list) {
  const m = {};
  for (const k of list) m[k] = (m[k] || 0) + 1;
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8));
}

export default {
  name: 'crowd',
  async init(app) {
    // the shopfront layout (where the door is in a shop opening, roller shutters) comes from the
    // facades; without it people only use house doors
    let shopLayout = null;
    try { shopLayout = (await import('../world/facades/shops.js')).shopLayout || null; } catch (e) { shopLayout = null; }
    this.sim = new CrowdSim(app, { shopLayout });
  },
  update(dt, app) { this.sim.update(dt, app); },
  /** Debug / test counters: counts by kind, state and task, tram clearance stats, cpu time. */
  stats() { return this.sim ? this.sim.stats() : null; },
  /** Read-only view of the agents (for tests and other systems). */
  agents() { return this.sim ? this.sim.population.agents.filter((a) => a.active) : []; },
};
