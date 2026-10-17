import * as THREE from 'three';
import { TRACK_OFFSET } from '../core/config.js';
import { U } from '../core/uniforms.js';
import { Events } from '../core/events.js';
import { Tram } from './train.js';
import { CAR, buildModels } from './trams/model.js';
import { makeLampAtlas } from './trams/display.js';

// Oncoming trams: the other units of the line, on the left track (d = −TRACK_OFFSET),
// running the loop the other way. The cab tram itself is never rendered.
//
//  - Driving: the same vehicle and driver model as the cab tram (train.js Tram), run on a
//    mirrored copy of the route, so they keep the curve and switch limits, brake into the
//    stops on the left platforms, dwell 12-18 s and ring their bell on departure and at
//    cross streets. Two units half a loop apart: about four encounters per lap.
//  - People: a unit brakes for anybody on (or stepping onto) its track ahead, rings, and
//    stops short when it must; app.trams.units tells the crowd where they are.
//  - Rendering (trams/model.js): three articulated bodies placed on the track each frame
//    (each body on the chord between its articulation points), three levels of detail by
//    projected size, a coarse depth-only hull for the sun's shadow, lamp levels following
//    the light (headlights by day, lit saloon windows at dusk).
//
// Debug: tram=<s> starts the first unit with its nose at s.
// API: app.trams.units[] = {id, s (leading nose, route s), speed (m/s, travelling towards
// −s), accel, dir (−1), d, length, halfWidth, state, phase, bellAt, active}.
// Emits app.events 'tram-bell' {unit, s, d} when one of them rings.

const LOD_PX = [55, 14];          // projected px per metre (1080 lines) above which LOD 0 / 1 draw
const SCAN_DT = 0.1;              // s between scans of the people ahead
const VIEW = [-90, 700];          // drawn while the nose is within this range of the camera (m)
// where each unit's nose starts: m beyond the default start plus a share of the loop
const UNITS = [
  { ahead: 190, loop: 0, line: '1', dest: 'CENTRAL STATION' },
  { ahead: 190, loop: 0.48, line: '1', dest: 'MARKET SQUARE' },
];

const _P = Array.from({ length: 4 }, () => new THREE.Vector3());
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FAR_SPHERE = new THREE.Sphere(new THREE.Vector3(0, -1e7, 0), 1e-3);

/** The route seen by a tram running the other way: s' = −s. */
function mirrorRoute(route) {
  const m = (s) => route.wrap(-s);
  return {
    length: route.length,
    wrap: (s) => route.wrap(s),
    delta: (a, b) => route.delta(a, b),
    curvature: (s) => -route.curvature(m(s)),
    grade: (s) => -route.grade(m(s)),
  };
}

/** Stops, cross streets and switches in mirrored coordinates; a unit stops with its nose
 *  as far into the left platform as the cab tram does on the right one. */
function mirrorLayout(layout, route) {
  const m = (s) => route.wrap(-s);
  return {
    seed: layout.seed,
    stations: layout.stations.map((st) => ({ id: st.id, s: m(st.s), len: st.len, stopS: m(2 * st.s - st.stopS) })),
    crossStreets: layout.crossStreets.map((c) => ({ s: m(c.s), width: c.width })),
    isInCrossover: (s, margin) => layout.isInCrossover(m(s), margin),
  };
}

const trams = {
  name: 'trams',
  units: [],

  async init(app) {
    this.app = app;
    app.trams = this;
    const M = app.materials, route = app.route;
    const own = (k) => ({ owner: `trams.${k}` });
    // library variants: one shader program with the rest of the vertex-coloured paint / metal / glass
    const white = new THREE.Color(1, 1, 1);
    this.mats = {
      // silver metallic paint, tinted glazing
      body: M.get('paint.frame', { vertexColors: true, color: white, metalness: 0.7, roughness: 0.75, userData: own('body') }),
      glass: M.get('glass.shop', { vertexColors: true, emissive: [1.0, 0.96, 0.9], emissiveIntensity: 0, userData: own('glass') }),
      ws: M.get('glass.shop', { vertexColors: true, userData: own('windscreen') }),
      metal: M.get('metal.galvanized', { vertexColors: true, userData: own('metal') }),
    };
    this.gain = (M.uniforms && M.uniforms.emissiveGain) || { value: 1 };

    const atlases = UNITS.map((u) => makeLampAtlas(u.line, u.dest));
    this.models = buildModels(atlases[0]);           // the atlases share their layout
    // lamps: the display and the lamp lenses have their own levels (one program for all units)
    this.lampLv = { value: new THREE.Vector2(1, 1) };
    this.lampMats = atlases.map((a, i) => M.track(this._lampMaterial(a, i)));

    // ---- units and their drivers
    const mr = mirrorRoute(route), ml = mirrorLayout(app.layout, route);
    const base = app.layout.defaultStartS ?? 0;
    const camS = app.params.view ? app.params.view[0] : app.startS;
    const force = app.params.num('tram', null);       // debug / tests: tram=<s> puts the first unit's nose there
    this.units = UNITS.map((def, i) => {
      let s = route.wrap(base + def.ahead + def.loop * route.length);
      // never start right beside the camera: move a unit that would further down the line
      const rel = route.delta(camS, s);
      if (rel > -CAR.length - 50 && rel < 140) s = route.wrap(s + 420);
      if (i === 0 && force != null) s = route.wrap(force);
      const bus = new Events();
      const tram = new Tram({ route: mr, layout: ml }, { s: route.wrap(-s), auto: true, events: bus });
      const unit = {
        id: i, tram, s, speed: tram.speed, accel: 0, dir: -1, d: -TRACK_OFFSET, length: CAR.length, halfWidth: CAR.halfWidth,
        state: tram.state, phase: null, bellAt: -1e9, active: true, obs: Infinity, lod: 2, dist: Infinity,
        root: this._unitMeshes(i),
      };
      bus.on('bell', () => {
        unit.bellAt = tram.t;
        app.events.emit('tram-bell', { unit: i, s: unit.s, d: unit.d });
      });
      app.scene.add(unit.root);
      return unit;
    });
    this._scanT = 0;
    this._place(app);
    // stay visible until the first frame: the start-up shader compile only sees visible objects
    for (const u of this.units) u.root.visible = true;
  },

  /** Unlit lamp material: atlas × vertex colour × level (display or lens, by atlas region). */
  _lampMaterial(atlas, i) {
    const m = new THREE.MeshBasicMaterial({ name: `trams.lamps${i}`, map: atlas.texture, vertexColors: true });
    const lv = this.lampLv, split = ((atlas.display[2] + atlas.lens[0]) / 2).toFixed(4);
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uLampLv = lv;
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', 'uniform vec2 uLampLv;\nvoid main() {')
        .replace('#include <color_fragment>', `#include <color_fragment>\n\tdiffuseColor.rgb *= mix( uLampLv.x, uLampLv.y, step( ${split}, vMapUv.x ) );`);
    };
    m.customProgramCacheKey = () => `trams-lamps-${split}`;
    return m;
  },

  /** Scene objects of one unit: three bodies, each with its LOD groups and shadow hull. */
  _unitMeshes(i) {
    const root = new THREE.Group();
    root.name = `trams:unit${i}`;
    const { mats, models } = this;
    const lamp = this.lampMats[i];
    root.userData.bodies = ['lead', 'mid', 'trail'].map((kind) => {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      const set = kind === 'mid' ? models.mid : models.cab;
      const lods = set.map((m, lod) => {
        const lg = new THREE.Group();
        lg.matrixAutoUpdate = false;
        lg.name = `trams:${kind}:lod${lod}`;
        const parts = [['body', mats.body], ['glass', mats.glass], ['ws', mats.ws], ['metal', mats.metal],
          [kind === 'lead' ? 'lampLead' : 'lampTrail', lamp]];
        for (const [k, mat] of parts) {
          const geo = m[k];
          if (!geo) continue;
          const mesh = new THREE.Mesh(geo, mat);
          mesh.matrixAutoUpdate = false;
          mesh.castShadow = false;
          mesh.receiveShadow = !k.startsWith('lamp');
          mesh.name = `trams:${kind}:${k}`;
          lg.add(mesh);
        }
        lg.visible = lod === 2;
        g.add(lg);
        return lg;
      });
      // depth-only hull for the sun's cascades: never drawn in the main pass (its bounding
      // sphere lies far below the street), the cascades test the true sphere (env shadow proxy)
      const hg = (kind === 'mid' ? models.hull.mid : models.hull.cab).clone();
      hg.boundingSphere = FAR_SPHERE.clone();
      const hull = new THREE.Mesh(hg, mats.body);
      hull.matrixAutoUpdate = false;
      hull.castShadow = true;
      hull.receiveShadow = false;
      hull.name = `trams:${kind}:shadow`;
      hull.userData.shadowProxy = { active: true };
      hull.userData.shadowSphere = new THREE.Sphere();
      g.add(hull);
      root.add(g);
      return { group: g, lods, hull, len: kind === 'mid' ? CAR.joints[2] - CAR.joints[1] : CAR.joints[1] };
    });
    return root;
  },

  update(dt, app) {
    const tr = app.train;
    const h = !tr || tr.holding ? 0 : dt;
    if (h > 0) {
      this._scanT -= h;
      if (this._scanT <= 0) { this._scanT = SCAN_DT; this._scan(app); }
    }
    for (const u of this.units) {
      const t = u.tram;
      t.obstacle = u.obs;
      t.step(h);
      if (h > 0 && u.obs < 45 && t.speed > 0.5) t.ringBell(true);
      u.s = app.route.wrap(-t.s);
      u.speed = t.speed; u.accel = t.accel; u.state = t.state; u.phase = t.phase;
    }
    this._place(app);
    this._lights();
  },

  /** People on (or stepping onto) a unit's track ahead of its nose: distance to the nearest. */
  _scan(app) {
    for (const u of this.units) u.obs = Infinity;
    const cr = app.crowd;
    if (!cr || cr.disabled || typeof cr.agents !== 'function') return;
    const sim = cr.sim;
    if (!sim || typeof sim.camU !== 'number' || typeof sim.camW !== 'number') return;
    const route = app.route, reach = CAR.halfWidth + 0.55;
    for (const a of cr.agents()) {
      const dl = a.d + TRACK_OFFSET, dp = dl + (a.vd || 0) * 1.4;
      if (Math.abs(dl) > reach && Math.abs(dp) > reach && dl * dp > 0) continue;   // stays clear
      const s = route.wrap(sim.camW + (a.s - sim.camU));
      for (const u of this.units) {
        const ahead = route.delta(s, u.s);
        if (ahead > -1 && ahead < 160 && ahead < u.obs) u.obs = Math.max(0, ahead);
      }
    }
  },

  /** Bodies on the track, LOD by projected size, shadow spheres. */
  _place(app) {
    const { route, camera } = app;
    const camS = app.cameraS ?? app.startS;
    const f1080 = 540 / Math.tan((camera.fov * Math.PI) / 360);
    const J = CAR.joints;
    for (const u of this.units) {
      const rel = route.delta(camS, u.s);
      const on = rel > VIEW[0] && rel < VIEW[1];
      u.root.visible = on;
      if (!on) continue;
      for (let k = 0; k < 4; k++) route.toWorld(u.s + J[k], -TRACK_OFFSET, 0, _P[k]);
      let dist = Infinity;
      for (let k = 0; k < 4; k++) dist = Math.min(dist, _P[k].distanceTo(camera.position));
      // nearest point of the bodies: between the articulations when passing alongside
      for (let k = 0; k < 3; k++) {
        _f.subVectors(_P[k + 1], _P[k]);
        const t = Math.max(0, Math.min(1, _b.subVectors(camera.position, _P[k]).dot(_f) / _f.lengthSq()));
        dist = Math.min(dist, _b.copy(_P[k]).addScaledVector(_f, t).distanceTo(camera.position));
      }
      u.dist = dist;
      const px = f1080 / Math.max(dist, 1);
      const hyst = (lod, th) => (u.lod <= lod ? px > th * 0.92 : px > th * 1.08);
      const lod = hyst(0, LOD_PX[0]) ? 0 : hyst(1, LOD_PX[1]) ? 1 : 2;
      u.lod = lod;
      const B = u.root.userData.bodies;
      this._body(B[0], _P[0], _P[1], lod);
      this._body(B[1], _P[1], _P[2], lod);
      this._body(B[2], _P[3], _P[2], lod);
    }
  },

  /** One body: local −z from R to F (its leading end), origin at F. */
  _body(b, F, R, lod) {
    _f.subVectors(F, R).normalize();
    _r.crossVectors(_f, UP).normalize();
    _u.crossVectors(_r, _f);
    _b.copy(_f).negate();
    const m = b.group.matrix;
    m.makeBasis(_r, _u, _b).setPosition(F);
    b.group.matrixWorldNeedsUpdate = true;
    for (let k = 0; k < 3; k++) b.lods[k].visible = k === lod;
    const sp = b.hull.userData.shadowSphere;
    sp.center.addVectors(F, R).multiplyScalar(0.5);
    sp.center.y += 1.7;
    sp.radius = b.len / 2 + 2;
  },

  /** Lamp levels follow the light: a daylight-readable display dimmed at dusk, headlights
   *  (a little lower at night), and the saloon lighting showing through the side windows
   *  once it gets dark. */
  _lights() {
    const night = Math.min(1, Math.max(0, U.uNight.value));
    const ln = (a, b) => Math.exp(Math.log(a) + night * (Math.log(b) - Math.log(a)));
    this.lampLv.value.set(ln(0.12, 0.014), ln(0.12, 0.06));
    this.mats.glass.emissiveIntensity = night * 0.0017 * this.gain.value;
  },
};

export default trams;
