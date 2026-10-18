import * as THREE from 'three';
import { loadCast } from './cast.js';
import { makeCastMaterial } from './material.js';
import { castAppearance } from './appearance.js';
import { Rig, bakeClips, CLIP, NUM_BONES } from '../anim.js';

// Test harness for the MakeHuman-based cast (mhtest=1, best with only=humans or only=street,humans,post):
// the characters of assets/humans_mh stand in a row across the street, animated with the runtime rig
// (src/crowd/humans/anim.js: Rig + bakeClips) through the converted skin weights.
//   mh_mode = walk (treadmill, default) | idle | sit | rest (bind pose) | mix (walk / idle / sit by figure)
//   mh_v = walking speed (m/s, default 1.3); mh_clip = a clip name from anim.js CLIPS (overrides mh_mode)
//   mh_lod = 0..3 (default 0); mh_only = comma separated ids; mh_class = adult | old | teen | child | toddler
//   mh_d = metres ahead of the view position (default 6); mh_c = lateral centre (route d); mh_sp = spacing (m)
//   mh_rot = extra heading (deg; 180 shows the backs, 90 a profile); mh_n = max figures
//   mh_crowd = k: a street crowd instead of the row: every character k times, walking both ways along the
//            street (sidewalks and track zone) over mh_len metres ahead (default 60); LOD by screen height
//   mh_people = n: a crowd of n people from appearance seeds (mh/appearance.js: character + colours per seed)
// e.g. ?only=street,humans,post&mhtest=1&view=400,1.6,1.4,0,-3&fov=30&mh_d=7

const MAT_N = NUM_BONES * 12;

export class MhPreview {
  constructor(app) {
    this.app = app;
    const p = app.params;
    this.mode = p.str('mh_mode', 'walk');
    this.v = p.num('mh_v', 1.3);
    this.clipName = p.str('mh_clip', '');
    this.lod = Math.max(0, Math.min(3, p.num('mh_lod', 0)));
    this.only = (p.str('mh_only', '') || '').split(',').filter(Boolean);
    this.cls = p.str('mh_class', '');
    this.d0 = p.num('mh_d', 6);
    this.c = p.num('mh_c', p.view ? p.view[1] : 0);
    this.sp = p.num('mh_sp', 0.8);
    this.rot = (p.num('mh_rot', 0) * Math.PI) / 180;
    this.n = p.num('mh_n', 64);
    this.crowd = p.num('mh_crowd', 0);
    this.people = p.num('mh_people', 0);
    this.len = p.num('mh_len', 60);
    this.t = 0;
    this.figs = [];
    this.group = new THREE.Group();
    this.group.name = 'humans.mhtest';
    app.scene.add(this.group);
    this.ready = this._init().catch((e) => console.warn('[mhtest] cast unavailable', e));
  }

  async _init() {
    const app = this.app;
    const base = new URL('../../../../assets/humans_mh/', import.meta.url).href;
    const cast = await loadCast(base);
    this.cast = cast;
    let chars = cast.chars;
    if (this.only.length) chars = chars.filter((c) => this.only.includes(c.id));
    if (this.cls) chars = chars.filter((c) => c.ageClass === this.cls);
    chars = chars.slice(0, this.n);
    const s0 = (app.params.view ? app.params.view[0] : app.startS) + this.d0;
    const route = app.route;
    const rigs = new Map();
    const list = [], looks = [];
    if (this.people > 0) {
      for (let k = 0; k < this.people; k++) {
        const a = castAppearance(1000 + k * 7919, cast);
        list.push(a.char); looks.push(a);
      }
      this.crowd = 1;
    } else if (this.crowd > 0) for (let k = 0; k < this.crowd; k++) chars.forEach((c) => list.push(c));
    else chars.forEach((c) => list.push(c));
    list.forEach((c, i) => {
      if (!rigs.has(c.id)) {
        const rig = new Rig({ parent: c.skeleton.parent, joints: c.skeleton.joints }, c.info);
        rigs.set(c.id, { rig, baked: bakeClips(rig) });
      }
      const { rig, baked } = rigs.get(c.id);
      const { mat, depth, uniforms } = makeCastMaterial(cast, looks[i] ? looks[i].tints : c.tints, c);
      app.materials.track(mat);
      const L = c.lods[this.lod];
      const g = c.geometry.clone();
      g.setDrawRange(L.start, L.count);
      const mesh = new THREE.Mesh(g, mat);
      mesh.customDepthMaterial = depth;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.userData.dynamicCaster = true;
      mesh.name = 'mhtest.' + c.id;
      this.group.add(mesh);
      const mode = this.mode === 'mix' ? ['walk', 'idle', 'walk', 'sit'][i % 4] : this.mode;
      const f = { c, rig, baked, uniforms, mesh, s: s0, d: this.c + (i - (list.length - 1) / 2) * this.sp, phase: (i * 0.37) % 1, mode,
        M: new Float32Array(MAT_N), dir: 0, v: this.v };
      if (this.crowd > 0) {
        // deterministic scatter: both sidewalks and the track zone, walking along the street both ways
        const h1 = Math.sin(i * 12.9898) * 43758.5453, h2 = Math.sin(i * 78.233) * 12543.123, h3 = Math.sin(i * 39.425) * 24634.6345;
        const r1 = h1 - Math.floor(h1), r2 = h2 - Math.floor(h2), r3 = h3 - Math.floor(h3);
        f.s = s0 + r1 * this.len;
        f.d = r2 < 0.38 ? -(5 + r3 * 5) : r2 < 0.76 ? 5 + r3 * 5 : -3 + r3 * 6;
        f.dir = r3 < 0.5 ? 1 : -1;
        f.v = c.ageClass === 'old' ? 0.9 + 0.2 * r1 : c.ageClass === 'toddler' ? 0.6 : 1.1 + 0.4 * r1;
        f.mode = 'walk';
        f.lods = c.lods;
      }
      this.figs.push(f);
    });
    console.log(`[mhtest] ${this.figs.length} characters, LOD ${this.lod}`);
  }

  update(dt) {
    if (!this.figs.length) return;
    this.t += dt;
    const route = this.app.route;
    const P = new THREE.Vector3();
    for (const f of this.figs) {
      const bk = f.baked;
      let clip, time;
      if (this.clipName && CLIP[this.clipName] !== undefined) {
        clip = CLIP[this.clipName];
        time = clip < CLIP.idle ? (f.phase += dt * this.v / Math.max(0.3, bk.strides[clip])) : this.t / 9 + f.phase;
      } else if (f.mode === 'walk') {
        clip = f.v < 1.0 ? CLIP.walkSlow : f.v > 1.5 ? CLIP.walkBrisk : CLIP.walk;
        if (f.c.ageClass === 'old') clip = CLIP.walkSenior;
        const stride = Math.max(0.3, bk.strides[clip]);
        f.phase += dt * f.v / stride;
        time = f.phase;
        if (f.dir) {
          // walking along the street (wraps inside the crowd zone)
          f.s += f.dir * f.v * dt * (bk.strides[clip] > 0 ? 1 : 0);
          const s0 = (this.app.params.view ? this.app.params.view[0] : this.app.startS) + this.d0;
          if (f.s > s0 + this.len) f.s -= this.len;
          if (f.s < s0) f.s += this.len;
        }
      } else if (f.mode === 'idle') { clip = CLIP.idle; time = this.t / 9.5 + f.phase; }
      else if (f.mode === 'sit') { clip = f.c.ageClass === 'toddler' ? CLIP.sitStroller : CLIP.sit; time = this.t / 11 + f.phase; }
      else clip = -1;
      const M = f.M;
      if (clip < 0) {
        // bind pose: identity skin matrices
        for (let b = 0; b < NUM_BONES; b++) M.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], b * 12);
      } else {
        const n = bk.frames[clip];
        const fr = (((time % 1) + 1) % 1) * n;
        const i0 = Math.floor(fr) % n, i1 = (i0 + 1) % n, w = fr - Math.floor(fr);
        const o0 = (bk.offsets[clip] + i0) * MAT_N, o1 = (bk.offsets[clip] + i1) * MAT_N;
        for (let k = 0; k < MAT_N; k++) M[k] = bk.data[o0 + k] * (1 - w) + bk.data[o1 + k] * w;
      }
      route.toWorld(f.s, f.d, 0, P);
      const heading = f.dir ? route.yawAt(f.s) + (f.dir > 0 ? 0 : Math.PI) : route.yawAt(f.s) + Math.PI + this.rot;
      if (f.lods) {
        // LOD by screen height (px), as the renderer will: >300 LOD0, >84 LOD1, >26 LOD2, else LOD3
        const cam = this.app.camera;
        const px = (f.c.height / Math.max(0.5, P.distanceTo(cam.position))) * (this.app.renderer.domElement.height / (2 * Math.tan(cam.fov * Math.PI / 360)));
        const l = px > 300 ? 0 : px > 84 ? 1 : px > 26 ? 2 : 3;
        f.mesh.geometry.setDrawRange(f.lods[l].start, f.lods[l].count);
      }
      const c = Math.cos(heading), sn = Math.sin(heading);
      const out = f.uniforms.uBones.value;
      for (let k = 0; k < MAT_N; k += 12) {
        for (let col = 0; col < 4; col++) {
          const m0 = M[k + col], m1 = M[k + 4 + col], m2 = M[k + 8 + col];
          out[k + col] = c * m0 + sn * m2;
          out[k + 4 + col] = m1;
          out[k + 8 + col] = -sn * m0 + c * m2;
        }
        out[k + 3] += P.x; out[k + 7] += P.y; out[k + 11] += P.z;
      }
    }
  }
}
