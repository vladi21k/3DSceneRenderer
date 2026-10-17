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
//   behaviour/streetMap   walkable space precomputed from the layout
//   behaviour/population  spawning where unseen, recycling, cafés, platforms
//   behaviour/behaviour   decisions and tasks (browse, shops, side streets, crossings…)
//   behaviour/steering    social-force avoidance, obstacles, walls, gait and gaze
//   behaviour/tram        tram clearance, bell requests, swept-volume guarantee
//   behaviour/visibility  frustum / facade occlusion tests for hidden spawns

const PI = Math.PI;
const _v = new THREE.Vector3();

class CrowdSim {
  constructor(app) {
    this.app = app;
    this.route = app.route;
    this.layout = app.layout;
    this.seed = app.layout.seed;
    this.rng = RNG.from(this.seed, 'crowd');
    this.map = new StreetMap(app);
    this.vis = new Visibility(app.route);
    this.tram = new TramWatch(this);
    this.population = new Population(this);
    this.steering = new Steering(this);
    this.counts = { seated: 0, passenger: 0, stand: 0, walker: 0 };
    this.time = 0;
    this.camU = null; this.camW = 0;
    this.out = { x: 0, y: 0, z: 0, heading: 0, speed: 0, phase: 0, pose: 0, look: 0, appearance: 0, visible: true };
    this.perf = { ms: 0, acc: 0, n: 0, max: 0 };
    this.check = { on: app.params.num('crowdCheck', 0) === 1, samples: 0, violations: 0, minClear: 99, log: [] };
    this.humans = app.humans && !app.humans.disabled ? app.humans : null;
    if (this.humans && this.humans.alloc) this.humans.alloc(MAX_AGENTS);
    this.debug = null;
    if (app.params.num('crowdDebug', 0) === 1) {
      import('./behaviour/debugView.js').then((m) => { this.debug = new m.DebugView(app, MAX_AGENTS); });
    }
    app.events.on('bell', () => this.onBell());
  }

  featureRng(...parts) { return RNG.from(this.seed, 'crowd', ...parts); }
  /** Wrapped route s → unwrapped s in the crowd frame (nearest copy to the camera). */
  unwrap(s) { return this.camU + this.route.delta(this.camW, s); }

  onKill(a) { if (this.humans && this.humans.setVisible) this.humans.setVisible(a.slot, false); }

  /** Everyone in front of the tram turns to look; people by the track hurry off it. */
  onBell() {
    this.tram.onBell(this.time);
    const r = this.rng;
    for (const a of this.population.agents) {
      if (!a.active) continue;
      const ahead = a.s - this.tram.trainU;
      if (ahead < -12 || ahead > 170 || Math.abs(a.d) > 10) continue;
      const delay = Math.max(0, ahead) / 340 + r.range(0.15, 0.6); // sound travel + reaction
      a.tramLookS = this.time + delay;
      a.tramLookT = this.time + delay + r.range(1.4, 3.2);
      a.bellT = this.time + delay + 5;
      // step back from the corridor edge
      if (a.state !== ST.SEATED && Math.abs(a.d) > 3 && Math.abs(a.d) < 5.2 && !a.noRect) a.vd += Math.sign(a.d) * r.range(0.4, 0.8);
    }
  }

  /** Head yaw (relative to the body, + left) that looks at the cab. */
  lookAtTram(a) {
    if (this.time < a.tramLookS && a.state !== ST.WAIT) return a.lookGoal;
    const p = this.route.toWorld(this.tram.trainU, RIDE_D, 2.2, _v);
    const yaw = Math.atan2(-(p.x - a.x), -(p.z - a.z));
    let rel = yaw - a.heading;
    rel = ((rel + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI;
    return Math.max(-1.25, Math.min(1.25, rel));
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
        for (const a of this.population.agents) if (a.active) this.population.kill(a);
        first = true;
      }
      this.camU += dd; this.camW = route.wrap(camS);
    }
    const trainU = this.camU + route.delta(camS, app.train?.s ?? camS);
    this.tram.update(app, trainU);
    this.vis.update(app.camera, this.camU, camS);
    if (first) { this._count(); this.population.fillInitial(); }

    if (dt > 0) {
      this.time += dt;
      this._count();
      this.population.maintain(dt);
      this.steering.step(dt);
      this.tram.flushRequests(app, this.time);
    }
    this._output(dt);
    if (this.check.on) this._selfCheck(app);
    if (this.debug) this.debug.update(this.population.agents);

    const ms = performance.now() - t0;
    const p = this.perf;
    p.acc += ms; p.n++; p.max = Math.max(p.max, ms);
    if (p.n >= 60) { p.ms = p.acc / p.n; p.acc = 0; p.n = 0; }
  }

  _count() {
    const k = this.counts;
    k.seated = 0; k.passenger = 0; k.stand = 0; k.walker = 0;
    for (const a of this.population.agents) {
      if (!a.active) continue;
      if (a.kind === KIND.SEATED) k.seated++;
      else if (a.kind === KIND.PASSENGER) k.passenger++;
      else { k.walker++; if (a.state === ST.STAND) k.stand++; }
    }
  }

  _output(dt) {
    const route = this.route, map = this.map, H = this.humans, o = this.out;
    for (const a of this.population.agents) {
      if (!a.active) continue;
      // platforms raise the feet
      let hT = 0;
      if (a.noRect) { const pl = map.platformAt(a.s, a.d >= 0 ? 1 : -1, Math.abs(a.d), -0.05); if (pl) hT = pl.h; }
      a.h += Math.max(-1.5 * dt, Math.min(1.5 * dt, hT - a.h));
      if (dt === 0) a.h = hT;
      route.toWorld(a.s, a.d, a.h, _v);
      a.x = _v.x; a.y = _v.y; a.z = _v.z;
      this.steering.animate(a, dt, H);
      a.heading = route.heading(a.s) - PI / 2 - a.alpha;
      if (!H || !H.set) continue;
      o.x = a.x; o.y = a.y; o.z = a.z;
      o.heading = a.heading; o.speed = a.speed; o.phase = a.phase; o.pose = a.pose;
      o.look = a.look; o.appearance = a.appearance; o.visible = true;
      H.set(a.slot, o);
    }
  }

  /** Independent check of the hard guarantee from the world positions handed to the renderer. */
  _selfCheck(app) {
    const ck = this.check, route = this.route, tr = app.train;
    if (!tr) return;
    for (const a of this.population.agents) {
      if (!a.active) continue;
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

  stats() {
    const byState = {}, byTask = {}, byKind = {};
    let active = 0, clearing = 0, simple = 0, followers = 0, corridor = 0;
    for (const a of this.population.agents) {
      if (!a.active) continue;
      active++;
      byState[STATE_NAMES[a.state]] = (byState[STATE_NAMES[a.state]] || 0) + 1;
      byTask[TASK_NAMES[a.task]] = (byTask[TASK_NAMES[a.task]] || 0) + 1;
      byKind[KIND_NAMES[a.kind]] = (byKind[KIND_NAMES[a.kind]] || 0) + 1;
      if (a.clearing) clearing++;
      if (a.simple) simple++;
      if (a.leader) followers++;
      if (Math.abs(a.d) < 3.4) corridor++;
    }
    const ck = this.check;
    return {
      active, walkerTarget: Math.round(this.population.walkerTarget), byKind, byState, byTask, clearing, simple, followers, corridor,
      tram: { ...this.tram.stats, v: +this.tram.v.toFixed(2), clearAhead: +this.tram.clearAhead.toFixed(1), stoppedAt: this.tram.stoppedAt ? this.tram.stoppedAt.id : null },
      violationLog: this.tram.violationLog.slice(0, 5),
      check: ck.on ? { samples: ck.samples, violations: ck.violations, minClear: +ck.minClear.toFixed(3), log: ck.log.slice(0, 5) } : null,
      population: this.population.stats,
      cpuMs: +this.perf.ms.toFixed(3), cpuMaxMs: +this.perf.max.toFixed(3),
    };
  }
}

export default {
  name: 'crowd',
  async init(app) {
    this.sim = new CrowdSim(app);
  },
  update(dt, app) { this.sim.update(dt, app); },
  /** Debug / test counters: counts by kind, state and task, tram clearance stats, cpu time. */
  stats() { return this.sim ? this.sim.stats() : null; },
  /** Read-only view of the agents (for tests and other systems). */
  agents() { return this.sim ? this.sim.population.agents.filter((a) => a.active) : []; },
};
