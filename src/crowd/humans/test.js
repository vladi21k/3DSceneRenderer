import { hash2 } from '../../core/rng.js';

// Figure test harness (humanstest=1, best with only=humans):
//   ht_mode = grid | walk | cross | sit | mix   (default mix)
//   ht_n    = number of figures (default 24)
//   ht_d    = metres ahead of the start position (default 30)
//   ht_seed = appearance seed offset, ht_v = fixed walking speed (m/s), ht_look = head yaw (rad)
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
    this.s0 = (p.view ? p.view[0] : app.startS) + this.d0;
    this.first = humans.alloc(this.n);
    this.t = 0;
    this.figs = [];
    for (let i = 0; i < this.n; i++) {
      const app_ = hash2(this.seed * 7919 + i, 4242) >>> 0;
      const f = { i: this.first + i, app: app_, phase: (i * 0.37) % 1 };
      const mode = this.mode === 'mix' ? ['walk', 'walk', 'cross', 'grid', 'sit'][i % 5] : this.mode;
      f.mode = mode;
      if (mode === 'grid') { f.d = -((this.n - 1) * 0.5) * 0.85 + i * 0.85; f.s = this.s0; }
      else if (mode === 'sit') { f.d = -3 + (i % 6) * 1.2; f.s = this.s0 + 2 + Math.floor(i / 6) * 1.5; }
      else if (mode === 'cross') { f.d = -9 + ((i * 3.7) % 18); f.s = this.s0 - 6 + ((i * 2.3) % 14); f.dir = i % 2 ? 1 : -1; }
      else { f.d = -7 + ((i * 2.9) % 14); f.s = this.s0 + ((i * 5.3) % 30) - 10; f.dir = i % 3 === 0 ? 1 : -1; }
      f.v = this.v ?? [0.7, 1.0, 1.25, 1.4, 1.6, 1.9][i % 6];
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
      } else if (f.mode === 'sit') {
        heading = route.yawAt(s) + Math.PI;
        pose = 2;
      } else if (f.mode === 'cross') {
        speed = f.v; pose = 0;
        const span = 18;
        const u = ((f.v * this.t + (f.d + 9)) % span + span) % span;
        d = f.dir > 0 ? -9 + u : 9 - u;
        heading = route.yawAt(s) + (f.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
      } else {
        speed = f.v; pose = 0;
        const span = 40;
        const u = ((f.v * this.t + (f.s - this.s0 + 10)) % span + span) % span;
        s = f.dir > 0 ? this.s0 - 10 + u : this.s0 + 30 - u;
        heading = route.yawAt(s) + (f.dir > 0 ? 0 : Math.PI);
      }
      if (speed > 0) f.phase = (f.phase + (speed * dt) / h.strideLength(f.app, speed)) % 1;
      const p = route.toWorld(s, d, 0);
      o.x = p.x; o.y = p.y; o.z = p.z;
      o.heading = heading; o.speed = speed; o.phase = f.phase; o.pose = pose;
      o.look = this.lookYaw; o.appearance = f.app; o.visible = true;
      h.set(f.i, o);
    }
  }
}
