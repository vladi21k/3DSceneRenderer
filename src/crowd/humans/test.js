import * as THREE from 'three';
import { hash2 } from '../../core/rng.js';

// Figure test harness (humanstest=1, best with only=humans):
//   ht_mode = grid | walk | cross | sit | cafe | crowd | mix   (default mix)
//             cafe: seated at the café chairs nearest the lineup position (add furniture to only=)
//   ht_n    = number of figures (default 24)
//   ht_d    = metres ahead of the start position (default 30)
//   ht_seed = appearance seed offset, ht_v = fixed walking speed (m/s), ht_look = head yaw (rad)
//   ht_c    = lateral centre of the lineup (route d, metres), ht_sp = grid spacing (m)
//   ht_axis = d (grid across the street, default) | s (grid along it)
//   ht_rot  = extra heading for grid / sit figures (deg; 180 shows their backs, 90 a profile)
//   ht_filter = skirt | dress | hat | cap | sunhat | suit | old | oldwalk | child | beard | glasses |
//               shorts | bag | backpack | phone | cross | pocket | long | heavy | male | female | balding |
//               man | woman | teen | kid (4-6 body) | boy | girl | oldman | oldwoman | tee | collar | tank |
//               scarf | longskirt
//   ht_first = index of the first figure in the seed's sequence (to isolate one person)
//   ht_pose = pose switching test: figures alternate walk / stand / sit every ht_pose seconds
//   ht_tread = 1: grid figures walk in place (a treadmill) at ht_v (default 1.3 m/s), for gait checks
//   ht_filter may list several filters (comma separated): figure i takes filter i % count
//   ht_dir  = 1 / -1: every walker heads away from / towards the start of the route
//   ht_mode=family: adults with a child walking hand in hand (holdWith), side by side; pairs stand
//             in a row across the street (ht_sp apart), walking in place with ht_tread=1, else
//             along the street; with ht_mob=stroller the adult pushes a stroller and the child
//             holds on to its side (ht_fam=kid|child picks the child's body; ht_side=1|-1 its side)
//   ht_baby = 1 / 0: force a child in every stroller / none (default: as the crowd picks)
// Mobility (poses 3-5 with their props):
//   ht_mob  = stroller | ride | walkbike | mix: figures push strollers / ride / walk bicycles
//             (works with grid, walk, cross, crowd; ht_mode=stroller|ride|walkbike|mobmix are walk
//             mode with that ht_mob); ht_mode=circle rides (or pushes) round circles of radius ht_r
//             (default 7 m) around the lineup position, for lean and steering
//   ht_mobk = k: only every k-th figure takes the ht_mob role (e.g. 400 figures, ht_mobk=10: 40 props)
//   ht_v    = speed (default: stroller 1.15, walking a bike 1.2, riding 4.2 m/s)
//   ht_stop = 1: riders stand with a foot down; ht_stop=<s> (> 1): they slow to a stop and ride
//             off again every <s> seconds
//   ht_mount = <s>: cyclists get off and walk their bicycle, then ride on, every <s> seconds
//   ht_prop = prop seed offset (picks bike / stroller models); ht_var / ht_svar = force a bicycle /
//             stroller variant index (bikes: 0 city, 1 roadster, 2 road, 3 hybrid, 4 kids, 5 e-bike;
//             strollers: 0 pushchair, 1 jogger, 2 pram, 3 umbrella)
// e.g. ?only=humans&humanstest=1&ht_mode=grid&view=400,1.6,1.7,0,0&fov=17
//      ?only=street,humans,post&humanstest=1&ht_mode=grid&ht_mob=ride&ht_tread=1&ht_n=5&ht_sp=1.5&ht_d=6&view=400,1.6,1.4,0,-4&fov=35

export class HumansTest {
  constructor(app, humans) {
    this.app = app;
    this.h = humans;
    const p = app.params;
    this.mode = p.str('ht_mode', 'mix');
    this.n = p.num('ht_n', 24);
    this.d0 = p.num('ht_d', 30);
    this.seed = p.num('ht_seed', 1);
    this.v = p.num('ht_v', null);
    this.lookYaw = p.num('ht_look', 0);
    this.c = p.num('ht_c', 0);
    this.sp = p.num('ht_sp', 0.85);
    this.rot = (p.num('ht_rot', 0) * Math.PI) / 180;
    this.firstFig = p.num('ht_first', 0);       // skip this many figures of the seed's sequence
    this.filters = (p.str('ht_filter', '') || '').split(',').filter(Boolean);
    this.tread = p.num('ht_tread', 0) > 0;
    this.dir = p.num('ht_dir', 0);
    this.nextK = this.firstFig;
    this.poseT = p.num('ht_pose', 0);
    // mobility: ht_mode=stroller|ride|walkbike|mobmix are walking figures with that prop
    const MOBM = { stroller: 'stroller', ride: 'ride', walkbike: 'walkbike', mobmix: 'mix' };
    this.mob = p.str('ht_mob', '') || MOBM[this.mode] || '';
    if (MOBM[this.mode]) this.mode = 'walk';
    this.stop = p.num('ht_stop', 0);
    this.mobK = p.num('ht_mobk', 0);
    this.mount = p.num('ht_mount', 0);
    this.propSeed = p.num('ht_prop', 0);
    this.radius = p.num('ht_r', 7);
    this.axisS = p.str('ht_axis', 'd') === 's';
    // ht_cam=target,dist,azimuth,elevation: the camera follows figure ht_camf (default 0) and looks at
    // its hands | head | body | hips | feet | prop (azimuth 0 = in front of it, 90 = its left side,
    // 180 = behind; degrees). Add view=... too so post treats every frame as a cut.
    const cam = (p.str('ht_cam', '') || '').split(',');
    this.cam = cam[0] ? { t: cam[0], dist: +(cam[1] || 2), az: (+(cam[2] || 0) * Math.PI) / 180, el: (+(cam[3] || 10) * Math.PI) / 180 } : null;
    this.camF = p.num('ht_camf', 0);
    this.s0 = (p.view ? p.view[0] : app.startS) + this.d0;
    this.family = this.mode === 'family';
    if (this.family) this.n = Math.max(2, this.n + (this.n & 1));
    this.famKind = p.str('ht_fam', '');
    this.famSide = p.num('ht_side', 0);
    this.first = humans.alloc(this.n);
    this.t = 0;
    this.figs = [];
    const chairs = this.mode === 'cafe' ? this._chairs() : [];
    for (let i = 0; i < this.n; i++) {
      if (this.family) { this.figs.push(this._familyFig(i)); continue; }
      // (ht_mobk=k: only every k-th figure has a prop, the rest walk)
      const mobOn = !this.mobK || i % this.mobK === 0;
      const mob = !mobOn ? '' : this.mob === 'mix' ? ['stroller', 'ride', 'ride', 'walkbike'][(i / (this.mobK || 1)) % 4 | 0] : this.mob;
      const pose = { stroller: 3, ride: 4, walkbike: 5 }[mob] || 0;
      const app_ = this._pick(this.filters.length ? this.filters[i % this.filters.length] : null, pose);
      const f = { i: this.first + i, app: app_, phase: (i * 0.37) % 1, pose, prop: pose === 3 ? 1 : pose ? 2 : 0,
        propSeed: (hash2(this.propSeed * 131 + i, 977) >>> 0) % 100000 };
      // ht_var=all: every model in turn (prop seeds that pick it)
      if (pose && p.str('ht_var', '') === 'all' && humans.mob) f.propSeed = this._seedFor(f, i);
      const mode = this.mode === 'mix' ? ['walk', 'walk', 'cross', 'grid', 'sit'][i % 5] : this.mode;
      f.mode = mode;
      if (mode === 'grid') {
        // ht_axis=s lines the grid up along the street (for side views from across it)
        const u = -((this.n - 1) * 0.5) * this.sp + i * this.sp;
        if (this.axisS) { f.d = this.c; f.s = this.s0 + u; } else { f.d = this.c + u; f.s = this.s0; }
      }
      else if (mode === 'cafe') {
        const ch = chairs[i % Math.max(1, chairs.length)];
        if (ch) { f.s = ch.s; f.d = ch.d; f.heading = ch.heading; } else { f.s = this.s0; f.d = 0; }
      }
      else if (mode === 'sit') { f.d = -3 + (i % 6) * 1.2; f.s = this.s0 + 2 + Math.floor(i / 6) * 1.5; }
      else if (mode === 'circle') { f.s = this.s0; f.d = this.c; f.a0 = (i / this.n) * Math.PI * 2; f.dir = i % 2 ? 1 : -1; }
      else if (mode === 'cross') { f.d = -9 + ((i * 3.7) % 18); f.s = this.s0 - 6 + ((i * 2.3) % 14); f.dir = i % 2 ? 1 : -1; }
      else if (mode === 'crowd') {
        // spread like the street crowd: sidewalks + track zone, 10..300 m ahead
        f.d = -10 + ((i * 7.31) % 20); f.s = this.s0 + 10 + ((i * 37.7) % 290); f.dir = i % 2 ? 1 : -1; f.mode = 'walk'; f.span = 300;
      } else { f.d = -7 + ((i * 2.9) % 14); f.s = this.s0 + ((i * 5.3) % 30) - 10; f.dir = i % 3 === 0 ? 1 : -1; }
      f.v = this.v ?? (pose === 4 ? [4.2, 3.4, 5.0, 3.8][i % 4] : pose === 3 ? 1.15 : pose === 5 ? 1.2
        : this.tread ? 1.3 : [0.7, 1.0, 1.25, 1.4, 1.6, 1.9][i % 6]);
      if (this.dir && f.dir) f.dir = this.dir;
      this.figs.push(f);
    }
  }

  /** Family pairs: even figures adults (pushing a stroller with ht_mob=stroller), odd ones the
   *  child beside them, holding the adult's hand or the stroller's side. */
  _familyFig(i) {
    const k = i >> 1, child = (i & 1) === 1;
    const strol = this.mob === 'stroller';
    const side = this.famSide || (k % 2 ? -1 : 1);
    const pose = !child && strol ? 3 : 0;
    const filt = child ? (this.famKind || (k % 2 ? 'kid' : 'child')) : (this.filters.length ? this.filters[k % this.filters.length] : (k % 2 ? 'man' : 'woman'));
    const app_ = this._pick(filt, pose);
    const u = -((this.n / 2 - 1) * 0.5) * this.sp * 2 + k * this.sp * 2;
    const lat = child ? side * (strol ? 0.62 : 0.42) : 0;
    const fwd = child && strol ? -0.42 : 0;
    const f = { i: this.first + i, app: app_, phase: (k * 0.37 + (child ? 0.21 : 0)) % 1, pose, prop: pose === 3 ? 1 : 0,
      propSeed: (hash2(this.propSeed * 131 + k, 977) >>> 0) % 100000, mode: this.tread ? 'grid' : 'walk', fam: true,
      partner: child ? this.first + i - 1 : -1, v: this.v ?? (this.tread ? 1.1 : 1.15), dir: this.dir || -1, lat, fwd };
    if (this.axisS) { f.d = this.c + lat; f.s = this.s0 + u + fwd; } else { f.d = this.c + u + lat; f.s = this.s0 + fwd; }
    return f;
  }

  update(dt) {
    const { route } = this.app;
    const h = this.h;
    this.t += dt;
    const o = {};
    for (const f of this.figs) {
      let s = f.s, d = f.d, heading, speed = 0, pose = 1;
      if (f.fam && f.mode === 'walk') {
        // the pair walks along the street together (the child keeps its place beside the adult)
        speed = f.v; pose = 0;
        const span = 40;
        const u = ((f.v * this.t) % span + span) % span;
        s = f.dir > 0 ? f.s - 10 + u : f.s + span - 10 - u;
        heading = route.yawAt(s) + (f.dir > 0 ? 0 : Math.PI);
      } else if (f.mode === 'grid') {
        heading = route.yawAt(s) + Math.PI;
        if (this.tread) { speed = f.v; pose = 0; }
      } else if (f.mode === 'circle') {
        // round a circle (centre at the lineup position), counter-clockwise for dir 1 (turning left)
        speed = f.v; pose = 0;
        const R = this.radius, ang = f.a0 + f.dir * (f.v * this.t) / R;
        const c = route.toWorld(this.s0, this.c, 0);
        const x = c.x + R * Math.cos(ang), z = c.z - R * Math.sin(ang);
        const p = route.project(x, z, this.s0);
        s = p.s; d = p.d;
        // velocity direction: d/dt (cos, -sin) = (-sin, -cos) * dir
        const vx = -Math.sin(ang) * f.dir, vz = -Math.cos(ang) * f.dir;
        heading = Math.atan2(-vx, -vz);
      } else if (f.mode === 'sit') {
        heading = route.yawAt(s) + Math.PI;
        pose = 2;
      } else if (f.mode === 'cafe') {
        heading = f.heading ?? route.yawAt(s);
        pose = 2;
      } else if (f.mode === 'cross') {
        speed = f.v; pose = 0;
        const span = 18;
        const u = ((f.v * this.t + (f.d + 9)) % span + span) % span;
        d = f.dir > 0 ? -9 + u : 9 - u;
        heading = route.yawAt(s) + (f.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      } else {
        speed = f.v; pose = 0;
        const span = f.span || 40;
        const u = ((f.v * this.t + (f.s - this.s0 + 10)) % span + span) % span;
        s = f.dir > 0 ? this.s0 - 10 + u : this.s0 + span - 10 - u;
        heading = route.yawAt(s) + (f.dir > 0 ? 0 : Math.PI);
      }
      if (f.mode === 'grid' || f.mode === 'sit') heading += this.rot;
      if (this.poseT > 0 && f.mode === 'grid') {
        // cycle walk-in-place -> stand -> sit to exercise the pose cross-fades
        const k = Math.floor((this.t + i0(f) * 0.37) / this.poseT) % 3;
        pose = k === 0 ? 0 : k === 1 ? 1 : 2;
        speed = k === 0 ? 1.2 : 0;
      }
      if (f.pose) {
        pose = f.pose;
        if (f.mode === 'grid' && !this.tread) speed = 0;
        if (this.mount > 0 && (pose === 4 || pose === 5)) {
          // ht_mount=T: get off and walk the bicycle, then ride on again, every T seconds
          const u = ((this.t + i0(f) * 1.3) % (2 * this.mount)) / this.mount;
          pose = u < 1 ? 4 : 5;
          if (f.mode !== 'grid' || this.tread) speed = pose === 4 ? Math.max(1.2, f.v * Math.min(1, u / 0.4)) : 1.2;
        }
        if (pose === 4 && this.stop) {
          // ht_stop=1: standing with a foot down; ht_stop=T: brake to a stop and ride off every T s
          if (this.stop <= 1) speed = 0;
          else {
            const u = ((this.t + i0(f) * 0.9) % this.stop) / this.stop;
            speed *= u < 0.35 ? 1 : u < 0.5 ? 1 - (u - 0.35) / 0.15 : u < 0.75 ? 0 : Math.min(1, (u - 0.75) / 0.15);
          }
        }
      }
      if (speed > 0) f.phase = (f.phase + (speed * dt) / h.strideLength(f.app, speed, pose)) % 1;
      const p = route.toWorld(s, d, 0);
      o.x = p.x; o.y = p.y; o.z = p.z;
      o.heading = heading; o.speed = speed; o.phase = f.phase; o.pose = pose;
      o.prop = f.prop; o.propSeed = f.propSeed;
      o.look = this.lookYaw; o.appearance = f.app; o.visible = true;
      o.holdWith = f.partner >= 0 ? f.partner : -1;
      h.set(f.i, o);
      f.x = o.x; f.y = o.y; f.z = o.z; f.heading = heading;
    }
    if (this.cam) this._camera();
  }

  _camera() {
    const f = this.figs[Math.min(this.figs.length - 1, this.camF)];
    if (!f || f.x === undefined) return;
    const C = this.cam, cam = this.app.camera;
    const ht = this.h.appearanceOf(f.app).height / 1.75;
    const L = { hands: [0, 1.02 * ht, -0.42], head: [0, 1.55 * ht, -0.1], body: [0, 1.1 * ht, 0], hips: [0, 0.9 * ht, 0],
      feet: [0, 0.28, -0.1], prop: [0, 0.6, f.pose === 3 ? -0.8 : 0] }[C.t] || [0, 1, 0];
    const c = Math.cos(f.heading), sn = Math.sin(f.heading);
    // figure-local (x right, -z ahead) -> world
    const tx = f.x + c * L[0] + sn * L[2], ty = f.y + L[1], tz = f.z - sn * L[0] + c * L[2];
    const a = f.heading + C.az;            // azimuth 0: on the figure's -Z side (in front)
    const dx = -Math.sin(a) * Math.cos(C.el), dz = -Math.cos(a) * Math.cos(C.el), dy = Math.sin(C.el);
    cam.position.set(tx + dx * C.dist, ty + dy * C.dist, tz + dz * C.dist);
    cam.up.set(0, 1, 0);
    cam.lookAt(tx, ty, tz);
    cam.updateMatrixWorld();
  }

  /** Appearance seed of the next figure of the sequence that passes ht_filter (and suits the
   *  mobility pose: pushers are adults, riders teens or adults without a skirt or long coat). */
  _pick(filter, pose = 0) {
    const want = FILTERS[filter];
    // (children only ride in the harness: ht_filter=child / kid / boy / girl skips the crowd's roles)
    const role = filter && /^(child|kid|boy|girl)$/.test(filter) ? null : ROLE[pose];
    for (let tries = 0; tries < 5000; tries++) {
      const seed = hash2(this.seed * 7919 + this.nextK++, 4242) >>> 0;
      const a = this.h.appearanceOf(seed);
      if ((!want || want(a, this.h.parts)) && (!role || role(a))) return seed;
    }
    return hash2(this.seed * 7919, 4242) >>> 0;
  }

  /** A prop seed whose model is the i-th variant (bicycles for this rider's size / strollers). */
  _seedFor(f, i) {
    const M = this.h.mob, a = this.h.appearanceOf(f.app);
    const kit = f.prop === 1 ? M.strollers : M.bikes;
    const opts = f.prop === 1 ? {} : { riderHeight: a.height, child: a.age === 'child' };
    const ok = [...new Set(Array.from({ length: 400 }, (_, k) => kit.pick(k, opts).variant))].sort();
    const want = ok[i % ok.length];
    for (let k = 0; k < 4000; k++) if (kit.pick(k, opts).variant === want) return k;
    return f.propSeed;
  }

  /** Chairs of the cafés around the lineup position, with the heading that faces their table. */
  _chairs() {
    const { route, layout } = this.app;
    const out = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const cafe of layout.cafes || []) {
      for (const t of cafe.tables) {
        if (Math.abs(route.delta(this.s0, t.s)) > 25) continue;
        route.toWorld(t.s, t.d, 0, b);
        for (const ch of t.chairs) {
          route.toWorld(ch.s, ch.d, 0, a);
          out.push({ s: ch.s, d: ch.d, heading: Math.atan2(-(b.x - a.x), -(b.z - a.z)), dist: Math.abs(route.delta(this.s0, ch.s)) });
        }
      }
    }
    return out.sort((p, q) => p.dist - q.dist);
  }
}

function i0(f) { return f.i; }

// who takes a mobility role (as the crowd chooses them)
const ROLE = {
  3: (a) => (a.age === 'adult' || (a.age === 'old' && !a.walkOld)) && !a.carry && !a.phoneWalk,
  4: (a) => (a.age === 'adult' || a.age === 'teen') && !a.skirtPart && !a.phoneWalk && !a.carry,
  5: (a) => (a.age === 'adult' || a.age === 'teen') && !a.skirtPart && !a.phoneWalk && !a.carry,
};

// ht_filter: only figures of one kind
const FILTERS = {
  skirt: (a) => a.skirtPart > 0 && a.topType !== 5,
  dress: (a) => a.topType === 7,
  hat: (a) => a.hatPart > 0,
  cap: (a, P) => a.hatPart === P.cap,
  sunhat: (a, P) => a.hatPart === P.sunhat,
  suit: (a) => a.topType === 5,
  old: (a) => a.age === 'old',
  oldwalk: (a) => a.walkOld,
  child: (a) => a.age === 'child',
  beard: (a) => a.beardPart > 0,
  glasses: (a) => a.glasses > 0,
  shorts: (a) => a.bottomType === 2,
  bag: (a, P) => a.bagPart === P.shoulderbag,
  backpack: (a, P) => a.bagPart === P.backpack,
  phone: (a) => a.phoneWalk,
  cross: (a) => a.idle === 2,
  pocket: (a) => a.idle === 3,
  long: (a, P) => a.hairPart === P.hair_long || a.hairPart === P.hair_ponytail,
  heavy: (a) => a.build > 0.5 || a.belly > 0.5,
  male: (a) => a.base === 'male',
  female: (a) => a.base === 'female',
  balding: (a, P) => a.hairPart === P.hair_balding || a.hairPart === P.hair_receding,
  man: (a) => a.base === 'male' && a.age === 'adult',
  woman: (a) => a.base === 'female' && a.age === 'adult',
  teen: (a) => a.age === 'teen',
  kid: (a) => a.body === 'kid',
  boy: (a) => a.age === 'child' && !a.female,
  girl: (a) => a.age === 'child' && a.female,
  oldman: (a) => a.age === 'old' && !a.female,
  oldwoman: (a) => a.age === 'old' && a.female,
  tee: (a) => a.topType === 0 && a.bottomType !== 3 && a.bottomType !== 5,
  collar: (a) => a.topType === 1 || a.topType === 2,
  tank: (a) => a.topType === 3,
  scarf: (a, P) => a.hairPart === P.scarf,
  longskirt: (a) => !!a.longSkirt,
};
