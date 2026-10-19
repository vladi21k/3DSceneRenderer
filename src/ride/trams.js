import * as THREE from 'three';
import { TRACK_OFFSET, TRACK_ZONE_HALF } from '../core/config.js';
import { U } from '../core/uniforms.js';
import { Events } from '../core/events.js';
import { Tram, DRIVE, BESIDE, crowdCorridor } from './train.js';
import { RNG } from '../core/rng.js';
import { CAR, SALOON, buildModels } from './trams/model.js';
import { makeLampAtlas } from './trams/display.js';
import { makeBodyMaterial, makeGlassMaterial, makeFrontMaterial, makeMetalMaterial, makeInteriorMaterial, makeSharedRefl, makeUnitUniforms } from './trams/materials.js';

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
//    the light (headlights by day, dimmer at night). Glass and paint mirror the street as
//    post's anti-aliasing history saw it last frame (each unit's mirror planes are set
//    here), and the cab tram where it stands beside them (it is never drawn: its bodies are
//    boxes in the reflection shaders). The destination display shows behind the top band of
//    the windscreen.
//  - Saloon and passengers: near a unit (LOD 0 / 1) the side glazing is see-through over a
//    modelled saloon (seats, poles, lights) with passengers in it, figures of the humans module
//    placed through its public contract (alloc / set / setVisible / heightOf; each unit has its
//    own deterministic load), lit as indoors (set's fill: the ceiling lights after dark; shade:
//    the share of the sky's light that reaches them under the roof). Far away the glazing is
//    opaque over a saloon traced in its shader (lit at night). Without humans' indoor light
//    (supportsFill) the near glazing too turns to the traced saloon after dark, cross-faded in
//    the twilight.
//  - The cab tram's own shadow: three depth-only hulls on its track (never drawn in the main
//    pass), so the tram the camera rides in shades the street and the people beside it.
//
// Debug: tram=<s> starts the first unit with its nose at s; cabshadow=0 drops the cab tram's
// shadow (A/B), cabshadow=2 keeps it in the inspection view (view=) to look at it from outside.
// API: app.trams.units[] = {id, s (leading nose, route s), prevS (s at the previous frame),
// speed (m/s, travelling towards −s), accel, dir (−1), d, length, halfWidth, state, phase,
// bellAt, active, obs (m from the nose to the nearest person its driver brakes for)}.
// Drivers: a unit's people scan is its obstacle source (Tram.setObstacle); the emergency
// brake needs two scans running; held by somebody it rings and creeps up (train.js).
// Emits app.events 'tram-bell' {unit, s, d} when one of them rings.

const REFL_D = [6, 7.5];          // route d of the street-reflection planes (right, left), at most the facade lines
const REFL_LV = ['h1', 'h2', 'h3', 'h4', 'h5'];   // the blurred levels' uniforms (makeSharedRefl)
const LOD_PX = [55, 14];          // projected px per metre (1080 lines) above which LOD 0 / 1 draw
const SCAN_DT = 0.1;              // s between scans of the people ahead
const EB_CONFIRM = 0.18;          // s the scan must keep asking for the emergency brake (two scans running)
const VIEW = [-90, 650];          // drawn while the nose is within this range of the camera (m): the built street
// where each unit's nose starts: m beyond the default start plus a share of the loop
const UNITS = [
  { ahead: 190, loop: 0, line: '1', dest: 'CENTRAL STATION' },
  { ahead: 190, loop: 0.48, line: '1', dest: 'MARKET SQUARE' },
];

const _P = Array.from({ length: 4 }, () => new THREE.Vector3());
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3(), _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FAR_SPHERE = new THREE.Sphere(new THREE.Vector3(0, -1e7, 0), 1e-3);
// (one record for every passenger's humans.set: no garbage per frame)
const PAX_SET = { x: 0, y: 0, z: 0, heading: 0, speed: 0, phase: 0, pose: 2, look: 0, appearance: 0, visible: true, idle: -1, fill: [0, 0, 0], shade: 1 };
// passengers' indoor light (humans set fill / shade): the share of the sky and environment light
// that reaches them through the windows under the roof (as the saloon mesh and the traced saloon
// get), and the ceiling lights' irradiance / pi at full night (the saloon's own, makeInteriorMaterial)
// times the share a figure catches (upward faces all of it, vertical ones about a third)
const PAX_SHADE = 0.42;
const PAX_LAMP = 0.022 / Math.PI * 0.6;
const PAX_LAMP_C = [0.97, 0.98, 1.0];

/** A unit's corridor load weights (it runs on the left track, d < 0), see _loads. */
const unitWeight = (off, d) => (d < -TRACK_ZONE_HALF ? DRIVE.besideW : d < 0.2 ? 1 : d <= TRACK_ZONE_HALF ? 0.6 : 0);
// people scan (see _scan): the stretch ahead of the nose, the reach from the left track's
// centre (body half width + a person + a little), the strip searched (a crosser predicted
// 1.4 s ahead may still be up to ~2 m outside it), and the nearest found (largest offset)
const SCAN = { ahead: 160, reach: 0, half: 0, best: -1 };
SCAN.reach = CAR.halfWidth + 0.38;
SCAN.half = TRACK_OFFSET + SCAN.reach + 2.2;
/** weight(off, d, vd?) for the scan: records the largest offset (the nearest to the nose) of
 *  anybody on the track or stepping onto it within 1.4 s (vd: lateral velocity, m/s). */
const scanWeight = (off, d, vd) => {
  const dl = d + TRACK_OFFSET, dp = dl + (vd > 0 || vd < 0 ? vd : 0) * 1.4, r = SCAN.reach;
  if (dl > r || dl < -r) { if ((dp > r || dp < -r) && dl * dp > 0) return 0; }
  if (off > SCAN.best) SCAN.best = off;
  return 1;
};

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
    // own materials (trams/materials.js), one set per unit (its seed and the street around
    // it; the programs are shared): clear-coated metallic silver paint, flush tinted glazing
    // with black frit over the traced saloon, the cab front glass; the pantograph paint
    this.gain = (M.uniforms && M.uniforms.emissiveGain) || { value: 1 };
    this.refl = makeSharedRefl();
    this.metal = M.track(makeMetalMaterial());
    // lamps: the display and the lamp lenses have their own levels (one program for all units)
    this.lampLv = { value: new THREE.Vector2(1, 1) };
    // see-through side glazing by day (passengers of the humans module behind it), the traced
    // saloon after dark; 0..1, see _lights
    this.see = { value: 0 };
    this._inner = []; this._innerOn = null;             // the saloon meshes (shown while see > 0)
    const atlases = UNITS.map((u) => makeLampAtlas(u.line, u.dest));
    this.unitMats = UNITS.map((def, i) => {
      const uni = makeUnitUniforms(this.refl, 3.7 + i * 11.3);
      // the seat fabric (as the traced saloon picks it from the unit's seed)
      const seat = ((3.7 + i * 11.3) * 0.37) % 1 >= 0.6 ? new THREE.Color(0.14, 0.04, 0.045) : new THREE.Color(0.06, 0.08, 0.15);
      return {
        uni, metal: this.metal,
        glass: M.track(makeGlassMaterial(`trams.glass${i}`, uni, this.gain)),
        glassSee: M.track(makeGlassMaterial(`trams.glassSee${i}`, uni, this.gain, this.see)),
        inner: M.track(makeInteriorMaterial(uni, this.gain, seat)),
        body: M.track(makeBodyMaterial(uni)),
        // cab front glass: the leading cab has its driver at the controls, the trailing one is
        // empty; the destination display shows behind its top band
        front: M.track(makeFrontMaterial(uni, { driver: true, gain: this.gain, atlas: atlases[i], lampLv: this.lampLv })),
        frontTrail: M.track(makeFrontMaterial(uni, { driver: false, gain: this.gain, atlas: atlases[i], lampLv: this.lampLv })),
      };
    });
    this.mats = this.unitMats[0];
    this.models = buildModels(atlases[0]);           // the atlases share their layout
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
      const tram = new Tram({ route: mr, layout: ml }, { s: route.wrap(-s), auto: true, events: bus, ebConfirm: EB_CONFIRM });
      const unit = {
        id: i, tram, s, prevS: s, speed: tram.speed, accel: 0, dir: -1, d: -TRACK_OFFSET, length: CAR.length, halfWidth: CAR.halfWidth,
        state: tram.state, phase: null, bellAt: -1e9, active: true, obs: Infinity, lod: 2, dist: Infinity, acc: 0,
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
    // stay visible until the first frame, every level of detail: the start-up shader compile
    // only sees visible objects
    for (const u of this.units) {
      u.root.visible = true;
      for (const b of u.root.userData.bodies) for (const lg of b.lods) lg.visible = true;
    }
    this.pax = null;                                  // passengers: allocated on the first update (humans ready)
    // the cab tram's own shadow: its three bodies as depth-only hulls on its track (never drawn
    // in the main pass, as the units' hulls), so it shades the street, the people beside it and a
    // passing unit like the tram the camera rides in
    this.cabHull = new THREE.Group();
    this.cabHull.name = 'trams:cabShadow';
    this.cabHull.userData.hulls = ['cab', 'mid', 'cab'].map((kind) => {
      const hg = (kind === 'mid' ? this.models.hull.mid : this.models.hull.cab).clone();
      hg.boundingSphere = FAR_SPHERE.clone();
      const h = new THREE.Mesh(hg, this.unitMats[0].body);
      h.matrixAutoUpdate = false;
      h.castShadow = true;
      h.receiveShadow = false;
      h.name = `trams:cab:${kind}:shadow`;
      h.userData.shadowProxy = { active: false };
      h.userData.shadowSphere = new THREE.Sphere();
      this.cabHull.add(h);
      return h;
    });
    app.scene.add(this.cabHull);
    this._cabShadow = app.params.num('cabshadow', 1);
    // start-up warm-up: until the app is ready every part of the units draws once a frame,
    // scaled to micrometres 2 m in front of the eye, so each program's first draw and each
    // geometry's and atlas's upload happen behind the loading screen, not as the first unit
    // comes into view (see _warmup)
    this._warm = this._warmGroup();
    app.scene.add(this._warm);
  },

  /** One tiny mesh for every geometry and every material the units draw (shared with them). */
  _warmGroup() {
    const g = new THREE.Group();
    g.name = 'trams:warmup';
    g.matrixAutoUpdate = false;
    const geos = new Set(), mats = new Set();
    for (const u of this.units) {
      for (const b of u.root.userData.bodies) {
        for (const lg of b.lods) {
          for (const m of lg.children) {
            if (geos.has(m.geometry) && mats.has(m.material)) continue;
            geos.add(m.geometry); mats.add(m.material);
            const w = new THREE.Mesh(m.geometry, m.material);
            w.matrixAutoUpdate = false;
            w.frustumCulled = false;
            w.castShadow = false;
            w.receiveShadow = m.receiveShadow;
            w.name = 'trams:warm';
            // (counts the frames the warm-up drew: stats for the start-up checks)
            if (!g.children.length) w.onAfterRender = () => { this.warmDraws = (this.warmDraws || 0) + 1; };
            g.add(w);
          }
        }
      }
    }
    return g;
  },

  /** Keep the warm-up meshes just in front of the eye until the app is ready, then drop them. */
  _warmup(app) {
    const g = this._warm;
    if (!g) return;
    if (app.ready) { app.scene.remove(g); this._warm = null; return; }
    const c = app.camera;
    _f.set(0, 0, -1).applyQuaternion(c.quaternion);
    g.matrix.makeScale(1e-5, 1e-5, 1e-5).setPosition(c.position.x + _f.x * 2, c.position.y + _f.y * 2, c.position.z + _f.z * 2);
    g.matrixWorldNeedsUpdate = true;
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
    const { models } = this;
    const mats = this.unitMats[i];
    const lamp = this.lampMats[i];
    root.userData.bodies = ['lead', 'mid', 'trail'].map((kind) => {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      const set = kind === 'mid' ? models.mid : models.cab;
      const lods = set.map((m, lod) => {
        const lg = new THREE.Group();
        lg.matrixAutoUpdate = false;
        lg.name = `trams:${kind}:lod${lod}`;
        // (the near levels: see-through glazing over the saloon; the far one: traced, opaque)
        const glass = lod < 2 ? mats.glassSee : mats.glass;
        const parts = [['body', mats.body], ['glassR', glass], ['glassL', glass], ['front', kind === 'trail' ? mats.frontTrail : mats.front], ['metal', mats.metal],
          ['inner', mats.inner], [kind === 'lead' ? 'lampLead' : kind === 'mid' ? 'lampMid' : 'lampTrail', lamp]];
        for (const [k, mat] of parts) {
          const geo = m[k];
          if (!geo) continue;
          const mesh = new THREE.Mesh(geo, mat);
          mesh.matrixAutoUpdate = false;
          mesh.castShadow = false;
          mesh.receiveShadow = !k.startsWith('lamp');
          mesh.name = `trams:${kind}:${k}`;
          if (k === 'inner') this._inner.push(mesh);
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
    // pedestrian load of each unit's corridor ahead sets its driver's cruise (as for the
    // cab tram): every second while running, taken at once until the ride starts
    this._loadT = (this._loadT || 0) - h;
    if (h === 0 || this._loadT <= 0) { this._loadT = 1; this._loads(app, h === 0); }
    for (const u of this.units) {
      const t = u.tram;
      t.setObstacle(u.obs, 'scan');
      // units out of sight are stepped in 0.1 s strides (the driver model's largest step)
      u.acc += h;
      if (u.root.visible || u.acc >= 0.1) {
        while (u.acc > 1e-6) { const d = Math.min(0.1, u.acc); t.step(d); u.acc -= d; }
      }
      if (h > 0 && u.obs < 45 && t.speed > 0.5) t.ringBell(true);
      u.prevS = u.s;
      u.s = app.route.wrap(-t.s);
      u.speed = t.speed; u.accel = t.accel; u.state = t.state; u.phase = t.phase;
    }
    this._place(app);
    this._warmup(app);
    this._lights(app);
    this._reflection(app);
    this._cabBoxes(app);
    this._passengers(app);
  },

  /** The cab tram (never drawn) as three boxes along its track, for the reflections in the
   *  units' glass and paint (trams/materials.js tramCabRefl). Off in the inspection view. */
  _cabBoxes(app) {
    const R = this.refl, tr = app.train;
    const live = !!(tr && !tr.disabled && Number.isFinite(tr.s));
    const on = live && !app.params.view;
    R.cabOn.value = on ? 1 : 0;
    const H = this.cabHull ? this.cabHull.userData.hulls : null;
    // (cabshadow=2: also in the inspection view, to look at it from outside)
    const shade = this._cabShadow === 2 ? live : on && this._cabShadow !== 0;
    if (H) for (let i = 0; i < 3; i++) H[i].userData.shadowProxy.active = shade;
    if (!on && !shade) return;
    const J = CAR.joints, route = app.route;
    for (let i = 0; i < 3; i++) {
      const F = route.toWorld(tr.s - J[i], TRACK_OFFSET, 0, _P[0]);
      const B = route.toWorld(tr.s - J[i + 1], TRACK_OFFSET, 0, _P[1]);
      _b.subVectors(B, F);
      const len = _b.length();
      _b.multiplyScalar(1 / Math.max(len, 1e-3));          // local +z: towards the rear
      _r.crossVectors(UP, _b).normalize();                 // local +x (the unit's frame: right of travel)
      _u.crossVectors(_b, _r);
      const m = R.cabM.value[i];
      m.makeBasis(_r, _u, _b).setPosition(F);
      if (H) {
        // the shadow hulls: the rear body is a cab turned round (its nose at the rear end)
        const h = H[i];
        if (i < 2) h.matrix.copy(m);
        else { _f.copy(_b).negate(); _r.negate(); h.matrix.makeBasis(_r, _u, _f).setPosition(B); _r.negate(); }
        h.matrixWorldNeedsUpdate = true;
        const sp = h.userData.shadowSphere;
        sp.center.addVectors(F, B).multiplyScalar(0.5);
        sp.center.y += 1.7;
        sp.radius = len / 2 + 2;
      }
      m.invert();
      R.cabL.value[i].set(CAR.halfWidth, 3.3, len - CAR.gap / 2);
    }
  },

  /** Passengers: figures of the humans module (its public contract: alloc, set, setVisible,
   *  heightOf) seated and standing in the saloons (trams/model.js SALOON spots), drawn while a
   *  unit is near enough for its see-through glazing (LOD 0 / 1) and the glazing is see-through
   *  (day and night with humans' indoor light, see _lights). Lit as indoors: the share of the sky
   *  light that reaches them under the roof (shade) and the ceiling lights after dark (fill).
   *  Each unit carries its own, deterministic load: about four seats in ten taken and a few
   *  people standing at the doors. */
  _passengers(app) {
    const H = app.humans;
    if (!H || H.disabled || typeof H.set !== 'function') return;
    if (!this.pax) { if (!H.ready || typeof H.alloc !== 'function') return; this.pax = this._allocPax(app, H) || []; }
    const see = this.see.value, o = PAX_SET;
    // indoor light (when humans takes it): the ceiling lights follow the night
    if (H.supportsFill) {
      const e = Math.min(1, Math.max(0, U.uNight.value)) * this.gain.value * PAX_LAMP;
      o.fill[0] = e * PAX_LAMP_C[0]; o.fill[1] = e * PAX_LAMP_C[1]; o.fill[2] = e * PAX_LAMP_C[2];
      o.shade = PAX_SHADE;
    }
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i], P = u.pax;
      if (!P || !P.length) continue;
      const show = see > 0.02 && u.root.visible && u.lod <= 1;
      if (!show) {
        if (u.paxOn) { for (let k = 0; k < P.length; k++) H.setVisible(P[k].slot, false); u.paxOn = false; }
        continue;
      }
      u.paxOn = true;
      const B = u.root.userData.bodies;
      for (let k = 0; k < P.length; k++) {
        const p = P[k], e = B[p.b].group.matrix.elements, x = p.x, y = SALOON.yf, z = p.z;
        o.x = e[0] * x + e[4] * y + e[8] * z + e[12];
        o.y = e[1] * x + e[5] * y + e[9] * z + e[13];
        o.z = e[2] * x + e[6] * y + e[10] * z + e[14];
        // facing along the body (local ±z), turned a little
        const c = Math.cos(p.dh), sn = Math.sin(p.dh);
        const fx = p.f * e[8], fz = p.f * e[10];
        o.heading = Math.atan2(-(fx * c + fz * sn), -(fz * c - fx * sn));
        o.pose = p.pose; o.look = p.look; o.appearance = p.app; o.phase = p.phase; o.idle = p.idle;
        H.set(p.slot, o);
      }
    }
  },

  /** Reserve the passengers' figure slots and pick who sits and stands where (per unit). */
  _allocPax(app, H) {
    const spots = this.models.spots, seed = app.layout.seed ?? 7;
    let total = 0;
    const lists = this.units.map((u, i) => {
      const rng = RNG.from('tram-pax', seed, i), list = [];
      const pick = (lo, hi) => {
        for (let t = 0; t < 12; t++) {
          const a = rng.int(0, 999999), h = typeof H.heightOf === 'function' ? H.heightOf(a) : 1.7;
          if (h >= lo && h <= hi) return a;
        }
        return -1;
      };
      for (let b = 0; b < 3; b++) {
        const S = b === 1 ? spots.mid : spots.cab;
        for (const p of S.seats) {
          if (!rng.chance(0.42)) continue;
          const a = pick(rng.chance(0.9) ? 1.45 : 1.15, 1.98);
          if (a >= 0) list.push({ b, x: p.x, z: p.z, f: p.f, dh: rng.range(-0.12, 0.12), pose: 2, app: a, look: rng.range(-0.35, 0.35), phase: rng.next(), idle: -1 });
        }
        for (const p of S.stand) {
          if (!rng.chance(p.door ? 0.2 : 0.08)) continue;
          const a = pick(1.5, 1.92);
          if (a < 0) continue;
          // at the doors facing them or the aisle; in the aisle along the car (either way)
          const f = rng.chance(0.5) ? p.f : -p.f;
          list.push({ b, x: p.x + rng.range(-0.06, 0.06), z: p.z + rng.range(-0.08, 0.08), f, dh: p.door ? rng.range(-1.2, 1.2) : rng.range(-0.3, 0.3), pose: 1,
            app: a, look: rng.range(-0.5, 0.5), phase: rng.next(), idle: rng.chance(0.3) ? 1 : -1 });
        }
      }
      total += list.length;
      return list;
    });
    if (!total) return null;
    const first = H.alloc(total);
    let n = first;
    for (let i = 0; i < lists.length; i++) {
      for (const p of lists[i]) { p.slot = n++; H.setVisible(p.slot, false); }
      this.units[i].pax = lists[i];
      this.units[i].paxOn = false;
    }
    return lists;
  },

  /** Street reflection inputs (trams/materials.js): last frame's anti-aliased image and its
   *  view-projection from post, while it is valid for this frame (no cut, jump or zoom);
   *  each visible unit's mirror planes (mid-sidewalk, at most the facade lines) and paving
   *  height at its middle. */
  _reflection(app) {
    const post = app.systems.post, cam = app.camera, rig = app.cameraRig, R = this.refl;
    // post's history: its `history` {texture, viewProj, valid} when it offers one, else the
    // anti-aliasing targets it keeps (the last resolved frame and its view-projection)
    let tex = null, vp = null, on = false;
    if (post && !post.disabled) {
      const h = post.history;
      if (h && h.texture && h.viewProj) { tex = h.texture; vp = h.viewProj; on = h.valid !== false; }
      else if (post.taaOn && post.taaRT && post.prevVP) { tex = post.taaRT[post.taaPing ^ 1].texture; vp = post.prevVP; on = !!post.taaValid; }
    }
    if (on) {
      const cut = rig && !rig.disabled && rig.cut && !app.params.view;
      const jump = post.prevCamPos && cam.position.distanceToSquared(post.prevCamPos) > 16;
      const zoom = post.prevFov != null && Math.abs(cam.fov - post.prevFov) > 0.03 * Math.max(cam.fov, 1);
      on = !cut && !jump && !zoom && !!tex;
    }
    R.on.value = on ? 1 : 0;
    if (on) {
      R.hist.value = tex;
      R.vp.value.copy(vp);
      // blurred levels of the same frame (post's bloom pyramid, 1/2 .. 1/32 resolution: it still
      // holds last frame's while the scene renders) and its view depth (half resolution); the
      // reflections fall back to the sharp image alone when post has none
      const D = post.downs, z = post.zRT;
      let lv = 0;
      if (Array.isArray(D)) {
        for (; lv < 5 && D[lv] && D[lv].texture; lv++) R[REFL_LV[lv]].value = D[lv].texture;
      }
      R.lv.value = lv;
      R.z.value = z && z.texture ? z.texture : null;
      R.zOn.value = R.z.value ? 1 : 0;
    }
    const route = app.route, layout = app.layout;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!u.root.visible) continue;
      const uni = this.unitMats[i].uni;
      const sm = route.wrap(u.s + CAR.length / 2);
      const smp = route.sample(sm, this._smp || (this._smp = {}));
      const nx = smp.right.x, nz = smp.right.z, np = nx * smp.pos.x + nz * smp.pos.z;
      const hwR = layout.halfWidth(sm, 1), hwL = layout.halfWidth(sm, -1);
      // mirror planes (materials.js): mid-sidewalk, where the people, trees and poles stand
      uni.uTramStreet.value.set(nx, nz, np + Math.min(hwR, REFL_D[0]), np - Math.min(hwL, REFL_D[1]));
      uni.uTramGround.value = route.toWorld(sm, -TRACK_OFFSET, 0, _b).y;
    }
  },

  /** Weighted people in each unit's track corridor 5-200 m ahead of its nose -> Tram.load:
   *  its half of the corridor 1, the other half 0.6, the strip of BESIDE m outside the
   *  corridor on its side DRIVE.besideW (as for the cab tram, train.js). From the crowd's
   *  public corridor count. */
  _loads(app, immediate) {
    const cr = crowdCorridor(app);
    if (!cr) return;
    const U = this.units;
    for (let i = 0; i < U.length; i++) {
      // a unit travels towards −s: its stretch ahead lies below its nose
      const s = U[i].s, n = cr.corridorCount(s - 200, s - 5, unitWeight, TRACK_ZONE_HALF + BESIDE);
      U[i].tram.setLoad(n / DRIVE.busyPeople, immediate);
    }
  },

  /** People on (or stepping onto) a unit's track ahead of its nose: distance to the nearest,
   *  from the crowd's public corridor count over the 160 m ahead (scanWeight keeps the
   *  nearest; a lateral velocity, when the crowd passes one, adds who is about to step on). */
  _scan(app) {
    const U = this.units;
    for (let i = 0; i < U.length; i++) U[i].obs = Infinity;
    const cr = crowdCorridor(app);
    if (!cr) return;
    for (let i = 0; i < U.length; i++) {
      const u = U[i];
      SCAN.best = -1;
      cr.corridorCount(u.s - SCAN.ahead, u.s + 1, scanWeight, SCAN.half);
      if (SCAN.best >= 0) u.obs = Math.max(0, SCAN.ahead - SCAN.best);
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
      // (hysteresis: a level once reached holds until 8 % past its threshold)
      const lod = px > LOD_PX[0] * (u.lod <= 0 ? 0.92 : 1.08) ? 0 : px > LOD_PX[1] * (u.lod <= 1 ? 0.92 : 1.08) ? 1 : 2;
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
   *  a little lower at night (the saloon's own lights are part of the glass shader). */
  _lights(app) {
    const night = Math.min(1, Math.max(0, U.uNight.value));
    // the side glazing: see-through near (with the passengers behind it, lit as indoors by
    // humans' fill / shade, day and night); without that indoor light the traced saloon with its
    // lights after dark (passengers lit by what lights the street are kept until the twilight is
    // deep, sunset). Needs the humans module.
    const H = app.humans, people = !!(H && !H.disabled && H.ready && this.pax && this.pax.length);
    const k = H && H.supportsFill ? 0 : Math.min(1, Math.max(0, (night - 0.6) / 0.35));
    this.see.value = people ? 1 - k * k * (3 - 2 * k) : 0;
    // the modelled saloon only while the glazing lets it through
    const inner = this.see.value > 0.005;
    if (inner !== this._innerOn) { this._innerOn = inner; for (let i = 0; i < this._inner.length; i++) this._inner[i].visible = inner; }
    // (log-interpolated: 0.12 -> 0.014 display, 0.12 -> 0.06 lenses)
    this.lampLv.value.set(0.12 * Math.pow(0.014 / 0.12, night), 0.12 * Math.pow(0.06 / 0.12, night));
  },
};

export default trams;
