import * as THREE from 'three';
import { hash2 } from '../../core/rng.js';

// Figure test harness (humanstest=1, best with only=humans):
//   ht_mode = grid | walk | cross | sit | cafe | crowd | mix   (default mix)
//             cafe: seated at the café chairs nearest the lineup position (add furniture to only=)
//   ht_n    = number of figures (default 24)
//   ht_d    = metres ahead of the start position (default 30)
//   ht_seed = appearance seed offset, ht_v = fixed walking speed (m/s), ht_look = head yaw (rad)
//   ht_c    = lateral centre of the lineup (route d, metres), ht_sp = grid spacing (m)
//   ht_rot  = extra heading for grid / sit figures (deg; 180 shows their backs, 90 a profile)
//   ht_filter = skirt | dress | hat | cap | sunhat | suit | old | oldwalk | child | beard | glasses |
//               shorts | bag | backpack | phone | cross | pocket | long | heavy | male | female | balding |
//               man | woman | teen | kid (4-6 body) | boy | girl | oldman | oldwoman | tee
//   ht_first = index of the first figure in the seed's sequence (to isolate one person)
//   ht_pose = pose switching test: figures alternate walk / stand / sit every ht_pose seconds
//   ht_tread = 1: grid figures walk in place (a treadmill) at ht_v (default 1.3 m/s), for gait checks
//   ht_filter may list several filters (comma separated): figure i takes filter i % count
//   ht_dir  = 1 / -1: every walker heads away from / towards the start of the route
// e.g. ?only=humans&humanstest=1&ht_mode=grid&view=400,1.6,1.7,0,0&fov=17

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
    this.s0 = (p.view ? p.view[0] : app.startS) + this.d0;
    this.first = humans.alloc(this.n);
    this.t = 0;
    this.figs = [];
    const chairs = this.mode === 'cafe' ? this._chairs() : [];
    for (let i = 0; i < this.n; i++) {
      const app_ = this._pick(this.filters.length ? this.filters[i % this.filters.length] : null);
      const f = { i: this.first + i, app: app_, phase: (i * 0.37) % 1 };
      const mode = this.mode === 'mix' ? ['walk', 'walk', 'cross', 'grid', 'sit'][i % 5] : this.mode;
      f.mode = mode;
      if (mode === 'grid') { f.d = this.c - ((this.n - 1) * 0.5) * this.sp + i * this.sp; f.s = this.s0; }
      else if (mode === 'cafe') {
        const ch = chairs[i % Math.max(1, chairs.length)];
        if (ch) { f.s = ch.s; f.d = ch.d; f.heading = ch.heading; } else { f.s = this.s0; f.d = 0; }
      }
      else if (mode === 'sit') { f.d = -3 + (i % 6) * 1.2; f.s = this.s0 + 2 + Math.floor(i / 6) * 1.5; }
      else if (mode === 'cross') { f.d = -9 + ((i * 3.7) % 18); f.s = this.s0 - 6 + ((i * 2.3) % 14); f.dir = i % 2 ? 1 : -1; }
      else if (mode === 'crowd') {
        // spread like the street crowd: sidewalks + track zone, 10..300 m ahead
        f.d = -10 + ((i * 7.31) % 20); f.s = this.s0 + 10 + ((i * 37.7) % 290); f.dir = i % 2 ? 1 : -1; f.mode = 'walk'; f.span = 300;
      } else { f.d = -7 + ((i * 2.9) % 14); f.s = this.s0 + ((i * 5.3) % 30) - 10; f.dir = i % 3 === 0 ? 1 : -1; }
      f.v = this.v ?? (this.tread ? 1.3 : [0.7, 1.0, 1.25, 1.4, 1.6, 1.9][i % 6]);
      if (this.dir && f.dir) f.dir = this.dir;
      this.figs.push(f);
    }
  }

  update(dt) {
    const { route } = this.app;
    const h = this.h;
    this.t += dt;
    const o = {};
    for (const f of this.figs) {
      let s = f.s, d = f.d, heading, speed = 0, pose = 1;
      if (f.mode === 'grid') {
        heading = route.yawAt(s) + Math.PI;
        if (this.tread) { speed = f.v; pose = 0; }
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
      if (speed > 0) f.phase = (f.phase + (speed * dt) / h.strideLength(f.app, speed)) % 1;
      const p = route.toWorld(s, d, 0);
      o.x = p.x; o.y = p.y; o.z = p.z;
      o.heading = heading; o.speed = speed; o.phase = f.phase; o.pose = pose;
      o.look = this.lookYaw; o.appearance = f.app; o.visible = true;
      h.set(f.i, o);
    }
  }

  /** Appearance seed of the next figure of the sequence that passes ht_filter. */
  _pick(filter) {
    const want = FILTERS[filter];
    for (let tries = 0; tries < 5000; tries++) {
      const seed = hash2(this.seed * 7919 + this.nextK++, 4242) >>> 0;
      if (!want || want(this.h.appearanceOf(seed), this.h.parts)) return seed;
    }
    return hash2(this.seed * 7919, 4242) >>> 0;
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
};
