import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { TRACK_OFFSET, RAIL_CENTER } from '../core/config.js';
import { StreetMap } from './behaviour/streetMap.js';
import { Visibility } from './behaviour/visibility.js';
import { Population } from './behaviour/population.js';
import { Steering } from './behaviour/steering.js';
import { TramWatch } from './behaviour/tram.js';
import { KIND, ST, MOB, MOB_POSE, MOB_PROP, STATE_NAMES, TASK_NAMES, KIND_NAMES, MOB_NAMES } from './behaviour/agent.js';
import { MAX_AGENTS, RIDE_D, SWEPT_HALF, SWEPT_AHEAD, AGENT_R, FOOT, CELL, GRID_D } from './behaviour/constants.js';

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
//   behaviour/cyclist     cyclists: riding lines, passing, lane changes, getting on and off
//   behaviour/footprint   stroller / bicycle footprints for avoidance and the tram clearance
//
// Strollers and bicycles (Mobility extension): a person pushing a stroller is pose 3 /
// prop 1, a cyclist pose 4 / prop 2, someone walking a bicycle pose 5 / prop 2; propSeed
// picks the model and colour, `lean` (rad, + leans left, like three.js rotations) is the
// bicycle's lean from its turn rate and `steer` the handlebar angle (rad, + to the left);
// `speed` is the riding speed and `phase` the crank turn (0..1 per revolution) for a
// cyclist. A walked bicycle is held on the person's right. If the renderer cannot show a pose
// (no app.humans.supportsPose(p) / cycleLength yet) those roles are not used and everyone
// walks. Testing: crowd_mob=force keeps the roles anyway, crowd_mob=0 turns them off,
// crowd_mobx=<k> multiplies their shares, crowd_dbg=1 outlines the footprints, crowdCheck=1
// adds the independent swept-volume / obstacle / facade checks (props included).

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
    this._mobility(app);
    this.map = new StreetMap(app, opts);
    this.vis = new Visibility(app.route);
    this.counts = { seated: 0, passenger: 0, stand: 0, walker: 0 };
    this.tram = new TramWatch(this);
    this.population = new Population(this);
    this.steering = new Steering(this);
    this.time = 0; this.dt = 0;
    this.camU = null; this.camW = 0;
    this.out = { x: 0, y: 0, z: 0, heading: 0, speed: 0, phase: 0, pose: 0, look: 0, appearance: 0, visible: true, prop: 0, propSeed: 0, lean: 0, steer: 0 };
    this.popIn = [0, 0, 0, 0]; this.popSrc = {}; this.featureIn = [0, 0, 0];
    this.events = {};
    this.perf = { avg: [0, 0, 0, 0], acc: [0, 0, 0, 0], max: [0, 0, 0, 0], n: 0, over: 0, ring: new Float32Array(240), ri: 0, rn: 0 };
    this.check = { on: app.params.num('crowdCheck', 0) === 1, samples: 0, violations: 0, minClear: 99, log: [], wall: 0, wallLog: [], overlap: 0, agentFrames: 0, teleports: 0, teleLog: [],
      propSamples: 0, propViolations: 0, propMinClear: 99, propLog: [], propOverlap: 0, propWall: 0, propWallLog: [],
      // strollers / bicycles against people and against each other (world space, within 60 m of the camera)
      pa: { frames: 0, agentOverlap: 0, propOverlap: 0, minAgentGap: 99, minPropGap: 99, pairs: new Set(), log: [] } };
    // renderer slots; alloc may hand back the first index of our block
    const base = this.humans && this.humans.alloc ? this.humans.alloc(MAX_AGENTS) : 0;
    this.base = Number.isInteger(base) ? base : 0;
    app.events.on('bell', () => this.onBell());
    // crowd_dbg=1: outlines of the stroller / bicycle footprints (testing only)
    if (app.params.num('crowd_dbg', 0) === 1) this._initDebug(app);
  }

  _initDebug(app) {
    const SEG = 14, MAXN = 96;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAXN * SEG * 2 * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const col = new Float32Array(MAXN * SEG * 2 * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, fog: false });
    if (app.materials && app.materials.track) app.materials.track(mat);
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false; lines.renderOrder = 999;
    app.scene.add(lines);
    this.dbg = { lines, pos, col, SEG, MAXN };
  }

  _drawDebug() {
    const D = this.dbg, route = this.route;
    let k = 0;
    const put = (s, d, c) => { route.toWorld(s, d, 0.08, _v); D.pos[k * 3] = _v.x; D.pos[k * 3 + 1] = _v.y; D.pos[k * 3 + 2] = _v.z; D.col[k * 3] = c[0]; D.col[k * 3 + 1] = c[1]; D.col[k * 3 + 2] = c[2]; k++; };
    const COL = [null, [1, 0.2, 0.8], [0.1, 0.9, 1], [1, 0.8, 0.1]];
    let n = 0;
    for (const a of this.population.agents) {
      if (!a.active || !a.mob || a.fpR <= 0 || n >= D.MAXN) continue;
      n++;
      const kk = Math.max(0.5, 1 + route.curvature(a.s) * a.d), c = COL[a.mob];
      // capsule outline: the two end circles' outer halves + the sides
      const ax = a.fp0s, ay = a.fp0d, bx = a.fp1s, by = a.fp1d, r = a.fpR;
      const ang = Math.atan2(by - ay, bx - ax);
      const pts = [];
      for (let i = 0; i <= 6; i++) { const t = ang + PI / 2 + (i / 6) * PI; pts.push([ax + r * Math.cos(t), ay + r * Math.sin(t)]); }
      for (let i = 0; i <= 6; i++) { const t = ang - PI / 2 + (i / 6) * PI; pts.push([bx + r * Math.cos(t), by + r * Math.sin(t)]); }
      for (let i = 0; i < pts.length && i < D.SEG; i++) {
        const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
        put(a.s + p0[0] / kk, a.d + p0[1], c); put(a.s + p1[0] / kk, a.d + p1[1], c);
      }
    }
    D.lines.geometry.setDrawRange(0, k);
    D.lines.geometry.attributes.position.needsUpdate = true;
    D.lines.geometry.attributes.color.needsUpdate = true;
  }

  /** Which mobility poses the renderer can show (strollers 3, riding 4, walking a bicycle 5). */
  _mobility(app) {
    const H = this.humans, mode = app.params.str('crowd_mob', 'auto');
    const sup = (p) => {
      if (!H) return false;
      if (typeof H.supportsPose === 'function') { try { return !!H.supportsPose(p); } catch (e) { return false; } }
      return typeof H.cycleLength === 'function';
    };
    this.poseOK = [true, sup(3), sup(4), sup(5)];
    const force = mode === 'force';
    this.mobRole = [false, force || this.poseOK[1], force || this.poseOK[2], force || this.poseOK[3]];
    this.mobOn = mode !== '0' && mode !== 'off' && this.mobRole.some((x) => x);
    // crowd_mobx=<k>: k times the usual shares (close-up test shots)
    this.mobX = Math.max(0, Math.min(8, app.params.num('crowd_mobx', 1)));
  }

  /** May agents take this mobility role? */
  mobOK(m) { return this.mobOn && !!this.mobRole[m]; }

  /** Pose code handed to the renderer for a (the walking pose if it cannot show the role's). */
  poseOf(a) { return a.mob && this.poseOK[a.mob] ? MOB_POSE[a.mob] : a.pose; }

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
    if (this.dbg) this._drawDebug();
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
      if ((a.noRect || a.platformOK) && a.state !== ST.SEATED) hT = map.platformHeight(a.s, a.d >= 0 ? 1 : -1, Math.abs(a.d));
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
          const r = Math.abs(a.s - this.camU), k = r < 450 ? 0 : r < 660 ? 1 : 2;
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
      if (a.mob === MOB.CYCLE) {
        // lean into the turn: from the world turn rate (route bends included), smoothed
        let lean = 0;
        if (a.headValid && dt > 0) {
          let dh = a.heading - a.prevHead;
          dh = ((dh + PI) % (2 * PI) + 2 * PI) % (2 * PI) - PI;
          lean = Math.atan((a.bikeV * (dh / dt)) / 9.81);   // + leans left (into a left turn)
          lean = Math.max(-0.45, Math.min(0.45, lean));
          a.lean += (lean - a.lean) * Math.min(1, dt * 6);
        }
        if (dt > 0 || !a.headValid) { a.prevHead = a.heading; a.headValid = true; }
      } else a.lean = 0;
      if (!H || !H.set) continue;
      o.x = a.x; o.y = a.y; o.z = a.z;
      o.heading = a.heading; o.speed = a.mob === MOB.CYCLE ? a.bikeV : a.speed; o.phase = a.phase;
      const shown = a.mob && this.poseOK[a.mob];
      o.pose = shown ? MOB_POSE[a.mob] : a.pose;
      o.prop = shown ? MOB_PROP[a.mob] : 0; o.propSeed = a.propSeed; o.lean = shown ? a.lean : 0;
      // handlebar angle (rad, + to the left) of a bicycle following its turn: tan δ = wheelbase · ω / v
      o.steer = shown && a.mob === MOB.CYCLE ? Math.max(-0.5, Math.min(0.5, Math.atan((1.05 * -a.yawW) / Math.max(0.8, a.bikeV)))) : 0;
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
        if (ck.wallLog.length < 8) ck.wallLog.push({ s: +this.route.wrap(a.s).toFixed(1), d: +a.d.toFixed(2), wall: +map.wallAt(a.s, side).toFixed(2), st: STATE_NAMES[a.state], task: TASK_NAMES[a.task], kind: KIND_NAMES[a.kind], mob: a.mob, src: a.src });
      }
      if (a.state !== ST.SEATED && a.kind !== KIND.PASSENGER) {
        const n = map.gatherCircles(a.s, 1);
        for (let q = 0; q < n; q++) {
          const i = map.qI[q], ds = map.qDS[q], dd = map.cD[i] - a.d;
          if (ds * ds + dd * dd < (map.cR[i] + AGENT_R * 0.5) ** 2) { ck.overlap++; break; }
        }
      }
      ck.agentFrames++;
      if (a.mob && a.state !== ST.SEATED) { this._checkProp(a, tr, map); this._checkPropPeople(a); }
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

  /** The stroller / bicycle in world space (from the heading handed to the renderer): never in
   *  the swept volume, never through a pole or a facade. */
  _checkProp(a, tr, map) {
    const ck = this.check, route = this.route, F = FOOT[a.mob];
    if (!F) return;
    // three.js yaw: forward = (−sin h, −cos h), right = (cos h, −sin h)
    const h = a.heading, fx = -Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
    const pts = _pp;
    for (let e = 0; e < 2; e++) {
      const f = e ? F.f1 : F.f0;
      const x = a.x + fx * f + rx * F.l, z = a.z + fz * f + rz * F.l;
      const p = route.project(x, z, route.wrap(a.s), 4);
      pts[e].s = this.unwrap(p.s); pts[e].d = p.d;
    }
    // facade
    for (const p of pts) {
      const side = p.d >= 0 ? 1 : -1;
      if (!a.inDoor && !map.mouthAt(p.s, side) && Math.abs(p.d) + F.r > map.facadeAt(p.s, side) + 0.02) {
        ck.propWall++;
        if (ck.propWallLog.length < 6) ck.propWallLog.push({ t: +this.time.toFixed(1), mob: MOB_NAMES[a.mob], s: +route.wrap(p.s).toFixed(1), d: +p.d.toFixed(2), fac: +map.facadeAt(p.s, side).toFixed(2), st: STATE_NAMES[a.state], task: TASK_NAMES[a.task], lead: !!a.leader });
      }
    }
    // poles / trunks (mid point too)
    const ms = (pts[0].s + pts[1].s) / 2, md = (pts[0].d + pts[1].d) / 2;
    const n = map.gatherCircles(ms, 1.5);
    for (let q = 0; q < n; q++) {
      const i = map.qI[q], cs = map.qDS[q] + ms, cd = map.cD[i];
      const d2 = segPointDist2(pts[0].s, pts[0].d, pts[1].s, pts[1].d, cs, cd);
      if (d2 < (map.cR[i] + F.r * 0.5) ** 2) { ck.propOverlap++; break; }
    }
    // the swept volume
    const ahead0 = pts[0].s - this.tram.trainU, ahead1 = pts[1].s - this.tram.trainU;
    if (Math.max(ahead0, ahead1) < -F.r - 1 || Math.min(ahead0, ahead1) > SWEPT_AHEAD + F.r + 1) return;
    ck.propSamples++;
    const inWin = (x) => x > -F.r && x < SWEPT_AHEAD + F.r;
    if (!inWin(ahead0) && !inWin(ahead1) && !(ahead0 < 0 && ahead1 > 0) && !(ahead1 < 0 && ahead0 > 0)) return;
    const d0 = pts[0].d - RIDE_D, d1 = pts[1].d - RIDE_D;
    const straddle = (d0 < 0) !== (d1 < 0);
    const lat = straddle ? -F.r : Math.min(Math.abs(d0), Math.abs(d1)) - SWEPT_HALF - F.r;
    ck.propMinClear = Math.min(ck.propMinClear, lat);
    if (lat < 0) {
      ck.propViolations++;
      if (ck.propLog.length < 12) ck.propLog.push({ t: +this.time.toFixed(2), mob: MOB_NAMES[a.mob], ahead: [+ahead0.toFixed(2), +ahead1.toFixed(2)], d: [+pts[0].d.toFixed(2), +pts[1].d.toFixed(2)], st: STATE_NAMES[a.state], task: TASK_NAMES[a.task], clr: a.clearing });
    }
  }

  /** World-space prop capsule of a (as drawn from the heading handed to the renderer) → o = [x0, z0, x1, z1, r]. */
  _propSeg(a, o) {
    const F = FOOT[a.mob], h = a.heading;
    const fx = -Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
    o[0] = a.x + fx * F.f0 + rx * F.l; o[1] = a.z + fz * F.f0 + rz * F.l;
    o[2] = a.x + fx * F.f1 + rx * F.l; o[3] = a.z + fz * F.f1 + rz * F.l; o[4] = F.r;
    return o;
  }

  /** Nobody walks through a stroller or a bicycle, and no two of them overlap: the prop's
   *  capsule against every other body (a torso of radius 0.21 m) and every other prop, from the
   *  positions and headings handed to the renderer, within 60 m of the camera. */
  _checkPropPeople(a) {
    if (!FOOT[a.mob] || Math.abs(a.s - this.camU) > 60) return;
    const pa = this.check.pa, st = this.steering, agents = this.population.agents;
    const P = this._propSeg(a, _sa);
    pa.frames++;
    const ix = Math.floor((a.s - st.s0) / CELL), iy = Math.floor((a.d + GRID_D) / CELL);
    let body = false, prop = false;
    for (let x = ix - 2; x <= ix + 2; x++) {
      if (x < 0 || x >= st.nx) continue;
      for (let y = iy - 1; y <= iy + 1; y++) {
        if (y < 0 || y >= st.ny) continue;
        for (let j = st.head[x * st.ny + y]; j >= 0; j = agents[j].next) {
          const b = agents[j];
          if (b === a || !b.active) continue;
          const gb = Math.sqrt(segSegDist2(P[0], P[1], P[2], P[3], b.x, b.z, b.x, b.z)) - P[4] - 0.21;
          pa.minAgentGap = Math.min(pa.minAgentGap, gb);
          if (gb < 0) { body = true; this._paLog(a, b, 'body', gb); }
          if (b.mob && FOOT[b.mob] && b.state !== ST.SEATED && b.slot > a.slot) {
            const Q = this._propSeg(b, _sb);
            const gp = Math.sqrt(segSegDist2(P[0], P[1], P[2], P[3], Q[0], Q[1], Q[2], Q[3])) - P[4] - Q[4];
            pa.minPropGap = Math.min(pa.minPropGap, gp);
            if (gp < 0) { prop = true; this._paLog(a, b, 'prop', gp); }
          }
        }
      }
    }
    if (body) pa.agentOverlap++;
    if (prop) pa.propOverlap++;
  }

  _paLog(a, b, what, gap) {
    const pa = this.check.pa, key = `${a.slot}:${a.serial}/${b.slot}:${b.serial}/${what}`;
    if (pa.pairs.has(key)) return;
    pa.pairs.add(key);
    if (pa.log.length < 10) pa.log.push({ t: +this.time.toFixed(1), what, mob: MOB_NAMES[a.mob], other: MOB_NAMES[b.mob], gap: +gap.toFixed(2), s: +this.route.wrap(a.s).toFixed(1), d: +a.d.toFixed(2), bd: +b.d.toFixed(2), st: STATE_NAMES[a.state], bst: STATE_NAMES[b.state] });
  }

  /** Percentile of the total update time over the last 240 frames. */
  _pct(q) {
    const p = this.perf;
    if (!p.rn) return 0;
    const v = Array.from(p.ring.subarray(0, p.rn)).sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(q * v.length))];
  }

  stats() {
    const byState = {}, byTask = {}, byKind = {}, byMob = {};
    let active = 0, clearing = 0, simple = 0, followers = 0, corridor = 0, children = 0, childAlone = 0;
    let mobInView = 0, cycV = 0, cycN = 0, strollerKids = 0, strollerPartners = 0;
    let cycStopped = 0, cycStall5 = 0, cycStallMax = 0, cycRail = 0, cycCrossing = 0;
    const lanes = [0, 0, 0], band = [0, 0, 0, 0];
    for (const a of this.population.agents) {
      if (!a.active) continue;
      active++;
      byState[STATE_NAMES[a.state]] = (byState[STATE_NAMES[a.state]] || 0) + 1;
      byTask[TASK_NAMES[a.task]] = (byTask[TASK_NAMES[a.task]] || 0) + 1;
      byKind[KIND_NAMES[a.kind]] = (byKind[KIND_NAMES[a.kind]] || 0) + 1;
      if (a.mob) {
        byMob[MOB_NAMES[a.mob]] = (byMob[MOB_NAMES[a.mob]] || 0) + 1;
        if (this.vis.inView(a.s, a.d)) mobInView++;
        if (a.mob === MOB.CYCLE) {
          cycV += a.bikeV; cycN++;
          if (a.bikeV < 0.1) cycStopped++;
          if (a.stopNP > 5) cycStall5++;
          cycStallMax = Math.max(cycStallMax, a.stopNP);
          if (a.rx) cycCrossing++;
          const ad = Math.abs(a.d);
          if (Math.abs(ad - (TRACK_OFFSET - RAIL_CENTER)) < 0.3 || Math.abs(ad - (TRACK_OFFSET + RAIL_CENTER)) < 0.3) cycRail++;
        }
        if (a.mob === MOB.STROLLER) for (const f of a.followers) { if (f.isChild) strollerKids++; else strollerPartners++; }
      }
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
      mobility: { on: this.mobOn, poses: this.poseOK.slice(1), byMob, inView: mobInView, cycleMeanKmh: cycN ? +((cycV / cycN) * 3.6).toFixed(1) : 0, strollerKids, strollerPartners },
      // cyclists now: stopped, stopped for more than 5 s with nobody in the way (should be 0; the
      // event count is events.cycleStall5s), longest such stop (s), within 0.3 m of a rail, crossing one
      cyclists: { stopped: cycStopped, stalledNoPeople5s: cycStall5, stallMaxS: +cycStallMax.toFixed(1), nearRail: cycRail, crossingRail: cycCrossing },
      lanes: { side: lanes[0], edge: lanes[1], corridor: lanes[2] },
      crossSection30to250m: { leftWalk: band[0], leftTrack: band[1], rideTrack: band[2], rightWalk: band[3] },
      tram: { ...this.tram.stats, v: +this.tram.v.toFixed(2), clearAhead: +this.tram.clearAhead.toFixed(1), stoppedAt: this.tram.stoppedAt ? this.tram.stoppedAt.id : null },
      violationLog: this.tram.violationLog.slice(0, 5), reqLog: this.tram.reqLog, rescueLog: this.tram.rescueLog,
      check: ck.on ? { samples: ck.samples, violations: ck.violations, minClear: +ck.minClear.toFixed(3), log: ck.log.slice(0, 5), agentFrames: ck.agentFrames, wall: ck.wall, wallLog: ck.wallLog, obstacleOverlap: ck.overlap, teleports: ck.teleports, teleLog: ck.teleLog.slice(0, 5), blocked: this.tram.stats.blocked,
        prop: { samples: ck.propSamples, violations: ck.propViolations, minClear: +ck.propMinClear.toFixed(3), log: ck.propLog.slice(0, 6), obstacleOverlap: ck.propOverlap, wall: ck.propWall, wallLog: ck.propWallLog },
        // frames (within 60 m) of a stroller / bicycle overlapping a body or another one, distinct pairs
        propPeople: { frames: ck.pa.frames, agentOverlap: ck.pa.agentOverlap, propOverlap: ck.pa.propOverlap, pairs: ck.pa.pairs.size, minAgentGap: +ck.pa.minAgentGap.toFixed(3), minPropGap: +ck.pa.minPropGap.toFixed(3), log: ck.pa.log } } : null,
      population: pop.stats, events: this.events,
      visibleSpawns: { under100m: this.popIn[0], under250m: this.popIn[1], under450m: this.popIn[2], beyond450m: this.popIn[3], bySource: this.popSrc },
      featureArrivalsInView: { under450m: this.featureIn[0], under660m: this.featureIn[1], beyond660m: this.featureIn[2] },
      blockLog: this.check.on ? summarize(this.tram.blockLog) : null,
      visibleDespawns: { under100m: pop.popOut[0], under250m: pop.popOut[1], under450m: pop.popOut[2], beyond450m: pop.popOut[3] },
      cpuMedianMs: +this._pct(0.5).toFixed(3), cpuP95Ms: +this._pct(0.95).toFixed(3),
      cpuMs: +this.perf.avg[0].toFixed(3), cpuMaxMs: +this.perf.max[0].toFixed(3), framesOver1_5ms: this.perf.over,
      cpuParts: { population: [+this.perf.avg[1].toFixed(3), +this.perf.max[1].toFixed(2)], steering: [+this.perf.avg[2].toFixed(3), +this.perf.max[2].toFixed(2)], output: [+this.perf.avg[3].toFixed(3), +this.perf.max[3].toFixed(2)] },
    };
  }
}

const _pp = [{ s: 0, d: 0 }, { s: 0, d: 0 }];
const _sa = new Float64Array(5), _sb = new Float64Array(5);
/** Squared distance between segments p0p1 and q0q1 (2D). */
function segSegDist2(p0x, p0y, p1x, p1y, q0x, q0y, q1x, q1y) {
  const ux = p1x - p0x, uy = p1y - p0y, vx = q1x - q0x, vy = q1y - q0y, wx = p0x - q0x, wy = p0y - q0y;
  const a = ux * ux + uy * uy, b = ux * vx + uy * vy, c = vx * vx + vy * vy, d = ux * wx + uy * wy, e = vx * wx + vy * wy;
  const cl = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  let s = 0, t = 0;
  if (a < 1e-9 && c < 1e-9) { s = 0; t = 0; }
  else if (a < 1e-9) { s = 0; t = cl(e / c); }
  else if (c < 1e-9) { t = 0; s = cl(-d / a); }
  else {
    const den = a * c - b * b;
    s = den > 1e-9 ? cl((b * e - c * d) / den) : 0;
    t = (b * s + e) / c;
    if (t < 0) { t = 0; s = cl(-d / a); } else if (t > 1) { t = 1; s = cl((b - d) / a); }
  }
  const dx = p0x + ux * s - q0x - vx * t, dy = p0y + uy * s - q0y - vy * t;
  return dx * dx + dy * dy;
}
/** Squared distance from point (px, py) to segment (ax, ay)-(bx, by). */
function segPointDist2(ax, ay, bx, by, px, py) {
  const ux = bx - ax, uy = by - ay, l2 = ux * ux + uy * uy;
  let t = l2 > 1e-9 ? ((px - ax) * ux + (py - ay) * uy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + ux * t - px, dy = ay + uy * t - py;
  return dx * dx + dy * dy;
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
