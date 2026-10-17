import * as THREE from 'three';

// Close-up harness for the mobility props in the app's own lighting. Mount it on a running app
// (the integrator can call it from humans.init when propstest=1, or from the console / capture tool):
//   import('./src/crowd/humans/props/index.js').then((m) => m.mountPropsTest(window.__app))
// URL parameters (all optional):
//   pt_mode    line | ride | lods | parked | strollers | mix   (default line)
//   pt_kind    bike | stroller | all (line / lods)
//   pt_ahead   metres ahead of the view position (default 6), or pt_s = absolute route s
//   pt_d       lateral centre of the lineup (default: the view's d), pt_sp spacing (m)
//   pt_axis    d (row across the street, default) | s (row along the street)
//   pt_rot     extra heading (deg): 0 = facing along the route (the camera sees their backs
//              when it looks along the route), 180 = facing the camera, 90 = side view
//   pt_variant variant id (city, dutch, road, hybrid, kids, ebike / pushchair, jogger, pram, umbrella)
//   pt_lod     force a LOD (0..2); pt_t = frozen animation time (s); pt_v = riding speed (m/s)
//   pt_steer, pt_crank (deg), pt_stand=1 (kickstand down), pt_baby=0|1, pt_seed
// e.g. ?only=humans,street,post&view=400,1.6,1.4,0,-4&fov=30&pt_mode=line&pt_rot=90&pt_axis=s

export function mountPropsTest(app, opts = {}) {
  return import('./index.js').then((M) => new PropsTest(app, M, opts));
}

class PropsTest {
  constructor(app, M, opts) {
    this.app = app;
    const p = app.params;
    const g = (k, d) => (opts[k] !== undefined ? opts[k] : p.str('pt_' + k, d));
    const n = (k, d) => { const v = g(k, null); return v === null || v === '' || isNaN(+v) ? d : +v; };
    this.mode = g('mode', 'line');
    this.kind = g('kind', this.mode === 'strollers' ? 'stroller' : 'bike');
    const view = p.view;
    this.s0 = n('s', (view ? view[0] : app.startS) + n('ahead', 6));
    this.d0 = n('d', view ? view[1] : 1.6);
    this.sp = n('sp', 1.0);
    this.axis = g('axis', 'd');
    this.rot = (n('rot', 0) * Math.PI) / 180;
    this.variant = g('variant', null);
    this.lod = n('lod', -1);
    this.tFix = n('t', null);
    this.v = n('v', 4.2);
    this.steer = (n('steer', 0) * Math.PI) / 180;
    this.crank = n('crank', null);
    this.stand = n('stand', 0) > 0;
    this.baby = n('baby', 1) > 0;
    this.seed = n('seed', 1);
    this.bikes = M.bicycleKit(app);
    this.strollers = this.kind !== 'bike' || this.mode === 'mix' || this.mode === 'ride' ? safe(() => M.strollerKit(app)) : null;
    this.bi = this.bikes.createInstancer({ capacity: 32, name: 'propstest.bikes' });
    app.scene.add(this.bi.object);
    if (this.strollers) {
      this.si = this.strollers.createInstancer({ capacity: 16, name: 'propstest.strollers' });
      app.scene.add(this.si.object);
    }
    this.M = new THREE.Matrix4();
    this.A = [0, 0, 0, 0];
    this.items = this._plan();
    this.t0 = performance.now();
    if (this.mode === 'parked') this._parked(M);
    const tick = () => { try { this.update(); } catch (e) { console.error('[propstest]', e); return; } requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.__propsTest = this;
    console.info('[propstest] bike kit built in', this.bikes.buildMs.toFixed(1), 'ms', this.strollers ? `strollers ${this.strollers.buildMs.toFixed(1)} ms` : '');
  }

  _plan() {
    const items = [];
    const bikes = this.bikes, st = this.strollers;
    const pickV = (kit) => (this.variant !== null && kit.byId[this.variant] !== undefined ? [kit.byId[this.variant]] : kit.variants.map((_, i) => i));
    if (this.mode === 'line' || this.mode === 'strollers') {
      const list = [];
      if (this.kind === 'bike' || this.kind === 'all') for (const v of pickV(bikes)) list.push({ kit: 'bike', v });
      if (st && (this.kind === 'stroller' || this.kind === 'all')) for (const v of pickV(st)) list.push({ kit: 'stroller', v });
      list.forEach((it, i) => {
        const o = (i - (list.length - 1) / 2) * this.sp;
        items.push({ ...it, s: this.axis === 's' ? this.s0 + o : this.s0, d: this.axis === 's' ? this.d0 : this.d0 + o, seed: this.seed * 101 + i });
      });
    } else if (this.mode === 'lods') {
      const vs = pickV(bikes);
      vs.forEach((v, i) => {
        for (let l = 0; l < 3; l++) items.push({ kit: 'bike', v, lod: l, s: this.s0 + i * 2.2, d: this.d0 + (l - 1) * 0.9, seed: this.seed * 101 + i });
      });
    } else if (this.mode === 'ride' || this.mode === 'mix') {
      // riders and pushers going both ways along the street, spread over 60 m
      for (let i = 0; i < 24; i++) {
        const stroller = st && i % 4 === 3;
        const kit = stroller ? 'stroller' : 'bike';
        const kitO = stroller ? st : bikes;
        const v = this.variant !== null && kitO.byId[this.variant] !== undefined ? kitO.byId[this.variant] : i % kitO.variants.length;
        const dir = i % 2 ? 1 : -1;
        items.push({ kit, v, s: this.s0 + ((i * 7.3) % 60) - 5, d: this.d0 + (-4 + ((i * 2.9) % 8)), dir, speed: stroller ? 1.2 : this.v * (0.8 + ((i * 0.37) % 0.4)), seed: this.seed * 101 + i });
      }
    }
    for (const it of items) {
      const kit = it.kit === 'bike' ? bikes : st;
      it.look = kit.pick(it.seed, it.kit === 'bike' ? { variant: it.v, parked: this.stand } : { variant: it.v, baby: this.baby });
      it.phase = (it.seed * 0.618) % 1;
    }
    return items;
  }

  _parked(M) {
    const { layout } = this.app;
    const i0 = Math.floor((this.s0 - 120) / 40), i1 = Math.floor((this.s0 + 160) / 40);
    this.parked = [];
    for (let i = i0; i <= i1; i++) {
      const idx = ((i % layout.nChunks) + layout.nChunks) % layout.nChunks;
      const chunk = { index: idx, s0: idx * 40, s1: idx * 40 + 40, lod: 0, rng: (tag) => M.RNG ? M.RNG.from(layout.seed, tag, idx) : null };
      const obj = M.buildParkedBicycles(chunk, this.app);
      if (obj) { this.app.scene.add(obj); this.parked.push(obj); }
    }
  }

  update() {
    const app = this.app;
    const t = this.tFix !== null ? this.tFix : (performance.now() - this.t0) / 1000;
    const { route } = app;
    const pos = new THREE.Vector3();
    this.bi.begin(app.camera, app.renderer);
    if (this.si) this.si.begin(app.camera, app.renderer);
    for (const it of this.items) {
      const kit = it.kit === 'bike' ? this.bikes : this.strollers;
      const inst = it.kit === 'bike' ? this.bi : this.si;
      let s = it.s, heading = route.yawAt(it.s) + this.rot, roll = 0, crank = 0, steer = this.steer, lean = 0;
      if (it.dir) {
        const span = 60;
        const u = (((it.speed * t + it.phase * span) % span) + span) % span;
        s = it.dir > 0 ? this.s0 - 5 + u : this.s0 + 55 - u;
        heading = route.yawAt(s) + (it.dir > 0 ? 0 : Math.PI);
        roll = it.speed * t;
        if (it.kit === 'bike') {
          crank = (roll / kit.cycleLength(it.v)) * Math.PI * 2;
          steer = 0.03 * Math.sin(t * 1.7 + it.seed);
          lean = 0.02 * Math.sin(t * 1.7 + it.seed + 0.6);
        }
      } else if (this.tFix === null && it.kit === 'bike') {
        roll = t * 1.2; crank = (roll / kit.cycleLength(it.v)) * Math.PI * 2;
      }
      if (this.crank !== null && it.kit === 'bike') crank = (this.crank * Math.PI) / 180;
      if (this.stand && it.kit === 'bike' && !it.dir) lean = 0.13;
      route.toWorld(s, it.d, 0, pos);
      kit.matrix(this.M, pos.x, pos.y, pos.z, heading, lean, 0);
      if (it.kit === 'bike') kit.anim(this.A, it.v, { roll, crank, steer, saddle: 0 });
      else kit.anim(this.A, it.v, { roll, swivel: 0 });
      inst.add(it.v, this.M, this.A, it.look.look, it.lod !== undefined ? it.lod : this.lod);
    }
    this.bi.end();
    if (this.si) this.si.end();
  }
}

function safe(fn) { try { return fn(); } catch (e) { console.error('[propstest]', e); return null; } }
