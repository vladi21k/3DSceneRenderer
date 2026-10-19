import * as THREE from 'three';
import { Rig, bakeClips, bakeClip, CLIPS, CLIP, NUM_BONES, BONE, SEAT_HEIGHT, PHONE_IDLE, PHONE_SIT, CUP_SIT, SIT_NO_TABLE } from './humans/anim.js';
import { loadCast, mergeMeshes } from './humans/mh/cast.js';
import { castAppearance, castToddler, castCharacter, castWaiter, waiterFits, BAG } from './humans/mh/appearance.js';
import { buildParts } from './humans/mh/parts.js';
import { makeFigureMaterials, writeLook, BONE_W, BONE_DYN, LOOK_W, FACE } from './humans/mh/shading.js';
import { FigureBatch } from './humans/mh/batch.js';
import { HumansTest } from './humans/test.js';
import { Mobility } from './humans/mobility.js';
import { U } from '../core/uniforms.js';

// Human figures: rendering + animation (crowd behaviour lives in crowd.js).
// Contract (docs/ARCHITECTURE.md):
//   alloc(count) -> first slot index; set(i, {x,y,z,heading,speed,phase,pose,look,appearance,visible});
//   setVisible(i, false); strideLength(appearance, speed, pose); cycleLength(appearance); heightOf(appearance)
//   holdWith (set() field): slot index of the person this one walks hand in hand with (a child
//   with its parent), or of the stroller pusher whose stroller it holds on to; -1 / absent: none.
//   Pass it every frame. The renderer picks the hands on the sides facing each other, meets them
//   between the two (the adult's arm drops, the child's rises) and lets go when they drift apart.
//   outfit (optional set() field): 'waiter' dresses café staff: a white or light plain shirt, dark trousers,
//   dark shoes and a long waist apron, no bag or phone (the seed's own character when it can wear it,
//   else one of the same sex near its height); heightOf / strideLength / cycleLength then describe the
//   waiter. Absent: the seed's own clothes.
//   fill, shade (optional set() fields; supportsFill = true): indoor light for passengers inside a tram: fill
//   [r, g, b] = extra irradiance / pi (linear, scene units) on the figure's diffuse light, shade 0..1 = the share
//   of the sky / environment light it keeps. Absent: none, 1.
//   table (optional set() field): false for a seat without a table in front (a bench): the person sits
//   with the hands resting on the thighs (pose 2); absent / true: the café stances (hands on the table).
//   idle (optional set() field, 0-7): the standing stance for pose 1 (0 relaxed weight shifts, 1 phone, 2 arms
//   folded, 3 hands in pockets, 4 hand on hip, 5 hands behind the back, 6 talking with gestures, 7 looking
//   about); absent: the person's own (from the appearance seed).
//   Strollers with a child (prop seed): a toddler sits in the seat (a baby lies in a pram), drawn
//   from a pool of slots allocated here.
//   Mobility (poses 3 stroller / 4 riding / 5 walking a bicycle, set() fields prop, propSeed, lean,
//   steer): supportsPose(p); the props are drawn by humans/mobility.js with the kits in humans/props/;
//   build(chunk) returns the chunk's parked bicycles.
//
// The people are the cast of assets/humans_mh (MakeHuman characters built by tools/blender/mh_build.py:
// men, women, teens, children, the elderly and toddlers, dressed, with four LODs each; hair as layered
// strand cards on LOD 0-1). An appearance seed picks a character and varies it (humans/mh/appearance.js:
// garment colours and patterns, hair shade, skin, height, the face's shape and marks, glasses or
// sunglasses, a bag, how the person stands, sits and walks). Every character carries its own
// skeleton; its clips (walks, idles, sitting) are baked once from humans/anim.js. Each frame the CPU
// blends the clips of every figure in view (or whose shadow is), adds the head turn and hand holds,
// folds in the figure's transform and writes 22 bone matrices plus a little state into a row of a float
// texture. All figures are drawn by one multi-draw per pass (humans/mh/batch.js) and skinned and shaded
// by humans/mh/shading.js.
// Testing: humanstest=1 (humans/test.js; ht_mode=cast lines up the whole cast, ht_outfit=waiter dresses
// every figure as café staff); propstest=1
// (humans/props/test.js); humans_tex=2 loads the texture arrays at half resolution; humans_bind=1 shows
// the bind pose; humans_dbg=1|2|3|4|5|6|7|8 shows baked occlusion / albedo / beard edge distance / skin decals /
// regions and inner faces / no skin / hat brim / hair fade and strand direction; humans_face=<k> scales the per-person
// face shapes (0: every instance of a character alike); humans_src=<dir> loads another build of the cast; humans_prof=1
// times the figure draws on the GPU (humans.batch.profile(): ms per frame, view and shadow passes).
// stats(): sub-draws, figures, posed figures, triangles and LODs of the view, shadow sub-draws, CPU ms,
// initMs (load: waiting for the cast; bake: rigs, clips and parts; rig, prep, parts, merge, compile and
// the cast's own download / decode timings, cast.bin / albedo / normal / raw).
// Per-frame code makes (almost) no garbage: scratch arrays, no Math.hypot, float arguments of large
// functions passed through typed arrays or slot fields, the batch's view order by a radix sort.
// Clips are baked at init for what each character plays (toddlers: their stroller seats; the walks of
// the elderly and of long skirts only for them), any other on first use (humans/anim.js bakeClip).
// The cast's texture strips are decoded off the main thread (humans/mh/decode.worker.js).

const TODDLER_POOL = 64;                  // slots for the children riding in strollers
// figure height on screen (px) above which LOD 0 / 1 / 2 are used (a little finer than the cast's own
// suggestion: the GPU has the headroom, and the coarsest level's hair cap reads as a helmet above ~15 px)
const LOD_PX = [260, 72, 15];
const MAT_N = NUM_BONES * 12;
const FADE = { stand: 0.75, sit: 1.0 };   // pose cross-fade times (s): folding the arms or raising a phone takes a moment
const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _sph = new THREE.Sphere();
const _gait = { a: 0, b: -1, wa: 1, wb: 0, idle: 0, extra: 1, phone: 0 };
const _gaitIn = new Float64Array(2);    // gaitBlend's speed and scale
const _hv = new THREE.Vector3(), _hw = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const TAU = Math.PI * 2;
const _hold = [0, 0, 0], _holdI = [0, 0, -1], _holdP = [0, 0, 0];
const _extra = [-1, -1, -1, -1], _extraFar = [-1, -1, -1, -1], _shadowExtra = [-1, -1];
const FALLBACK = { age: 'adult', base: 'male', female: false, height: 1.72, carry: false, phoneWalk: false, walkOld: false,
  skirtPart: 0, sit: 0, idle: 0, body: '', scale: 1 };
// (Math.hypot boxes its arguments on every call: these are inlined)
function hyp2(x, y) { return Math.sqrt(x * x + y * y); }
function hyp3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }

// the cast starts downloading and decoding as soon as this module is imported, while the modules
// before it initialise (humans_tex=2 loads the texture arrays at half resolution)
// (humans_src=<path under the site root>: another build of the cast, for testing)
const CAST_URL = (() => {
  try {
    const src = new URLSearchParams(location.search).get('humans_src');
    if (src && /^[\w./-]+$/.test(src) && !src.includes('..')) return new URL('../../' + src.replace(/^\/+|\/+$/g, '') + '/', import.meta.url).href;
  } catch (e) { /* default */ }
  return new URL('../../assets/humans_mh/', import.meta.url).href;
})();
let castLoad = null;
function startCastLoad(texScale) {
  if (!castLoad || castLoad.texScale !== texScale) {
    castLoad = { texScale, promise: loadCast(CAST_URL, { texScale }) };
    castLoad.promise.catch(() => {});      // (reported by init)
  }
  return castLoad.promise;
}
const texScaleParam = () => {
  try { return Math.max(1, Math.min(4, parseInt(new URLSearchParams(location.search).get('humans_tex') || '1', 10) || 1)); } catch (e) { return 1; }
};
try { startCastLoad(texScaleParam()); } catch (e) { /* retried by init */ }
// the mobility props' modules (bicycles, strollers) are fetched alongside, not when init gets to them
const propsLoad = import('./humans/props/index.js');
propsLoad.catch(() => {});             // (reported by init)

/** Yield to the event loop for a moment (a message-channel task: setTimeout(0) is clamped to >= 4 ms
 *  and can be held much longer on a busy page). */
function yieldTask() {
  return new Promise((resolve) => {
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
      ch.port2.postMessage(0);
    } catch (e) { setTimeout(resolve, 0); }
  });
}

/** Toddler seed from a stroller's prop seed. */
function hashSeed(n) { n = Math.imul(n ^ 0x5f3759df, 0x2c1b3c6d); n ^= n >>> 15; return n >>> 0; }

const humans = {
  name: 'humans',
  capacity: 0,
  used: 0,
  ready: false,
  slots: [],
  cache: new Map(),
  parts: {},
  time: 0,
  perf: { ms: 0, figures: 0, posed: 0 },
  rowSlot: new Int32Array(0),

  async init(app) {
    this.app = app;
    const tInit = performance.now();
    // mobility props (bicycles, strollers; also the parked bicycles of build()): optional
    try {
      this.props = await propsLoad;
      this._tProps = Math.round(performance.now() - tInit);
    } catch (e) {
      console.warn('[humans] mobility props unavailable', e);
      this.props = null;
    }
    let cast;
    const tLoad = performance.now();
    try {
      const texScale = Math.max(1, Math.min(4, app.params.num('humans_tex', 1) | 0));
      cast = await startCastLoad(texScale);
    } catch (e) {
      console.warn('[humans] figure assets unavailable, figures disabled', e);
      return;
    }
    this.cast = cast;
    // version 2 casts: skin decals (beard growth, hair-coloured scalp), inner hem faces, beard shells;
    // beardBase (version 3): the beard part is the base the strand shells grow from (beardShellsFromBase)
    const feats = Array.isArray(cast.doc.features) ? cast.doc.features : [];
    this.v2 = (cast.doc.version | 0) >= 2 && feats.includes('decal');
    this.beardBase = feats.includes('beardBase');
    // eyebrows drawn on the skin from the brow cards' line (humans_brows=0: the cards themselves)
    this.browsOnSkin = app.params.num('humans_brows', 1) > 0;
    this.initMs = { props: this._tProps || 0, load: Math.round(performance.now() - tLoad) };
    const tBake = performance.now();
    this.bindPose = app.params.num('humans_bind', 0) > 0;
    FACE.scale = app.params.num('humans_face', 1);
    // (humans_lod=a,b,c: other LOD thresholds, for testing)
    const lp = (app.params.str('humans_lod', '') || '').split(',').map(Number).filter((x) => x > 0);
    this.lodPx = lp.length === 3 ? lp : LOD_PX;
    this.ensureCapacity(Math.max(512, this.used));

    // per character: rig + baked motion, accessories, draw ranges in the merged buffers
    this.bases = {};
    const meshes = [], ranges = [];
    const refs = [];
    let tRig = 0, tPrep = 0, tParts = 0;
    for (let ci = 0; ci < cast.chars.length; ci++) {
      const c = cast.chars[ci];
      let tq = performance.now();
      const rig = new Rig({ parent: c.skeleton.parent, joints: c.skeleton.joints }, c.info);
      // (the clips this character can play are baked now, any other on first use)
      const baked = bakeClips(rig, clipsFor(c));
      const walkV = CLIPS.map((cl) => (cl.kind === 'walk' ? rig.walkParams(cl).v : 0));
      // single frames used to re-pose the upper body while walking (phone, carried bag)
      const frame = (clip, f) => (bakeClip(baked, clip), baked.data).slice((baked.offsets[clip] + f) * MAT_N, (baked.offsets[clip] + f + 1) * MAT_N);
      const B = { name: c.id, index: ci, char: c, info: c.info, rig, baked, walkV, phone: frame(CLIP.idlePhone, 0), hang: frame(CLIP.idle, 0) };
      this.bases[c.id] = B;
      tRig += performance.now() - tq; tq = performance.now();
      // the hem of a skirt or dress (rest height): skin above it is kept inside the cloth (mh/shading.js)
      c.hemY = -1;
      { const T = c.raw.tex, Pp = c.raw.pos; let y = Infinity;
        for (let v = 0; v < c.raw.n; v++) if (T[v * 4 + 3] & 8) y = Math.min(y, Pp[v * 3 + 1]);
        if (y < Infinity) c.hemY = y; }
      // (casts with skin decals carry beard volume shells of their own)
      hatBrim(c);
      eyeRadius(c);
      faceMarks(c);
      if (this.browsOnSkin) browLine(c);
      beardFade(c, this.beardBase ? 0.01 : this.v2 ? 0.015 : 0.035);
      if (this.beardBase) beardShellsFromBase(c);
      else if (!this.v2) beardShells(c);
      tPrep += performance.now() - tq; tq = performance.now();
      const parts = buildParts(c, { apron: waiterFits(c) });
      tParts += performance.now() - tq;
      B.fit = parts.fit; delete parts.fit;
      refs.push({ B, mesh: meshes.length, parts: Object.keys(parts) });
      meshes.push(c.raw);
      for (const k of Object.keys(parts)) meshes.push(parts[k]);
      // (let the page breathe now and then: a message-channel yield, not a clamped timer)
      if (ci % 12 === 11) await yieldTask();
    }
    this.initMs.bake = Math.round(performance.now() - tBake);
    Object.assign(this.initMs, { rig: Math.round(tRig), prep: Math.round(tPrep), parts: Math.round(tParts), cast: cast.timing || null });
    let tq = performance.now();
    const merged = mergeMeshes(meshes);
    this.initMs.merge = Math.round(performance.now() - tq);
    for (const { B, mesh, parts } of refs) {
      const r0 = merged.ranges[mesh];
      B.bodyR = B.char.lods.map((L) => ranges.push({ start: r0.ibase + L.start, count: L.count }) - 1);
      B.partR = {};
      parts.forEach((k, j) => {
        const r = merged.ranges[mesh + 1 + j];
        B.partR[k] = ranges.push({ start: r.ibase, count: meshes[mesh + 1 + j].index.length }) - 1;
      });
    }
    // the CPU copies of the cast are not needed any more
    for (const c of cast.chars) c.raw = null;
    this.stats_ = { vertices: merged.vertices, indices: merged.indices };

    this.group = new THREE.Group();
    this.group.name = 'humans';
    app.scene.add(this.group);
    const { mat, depth, uniforms } = makeFigureMaterials({ bones: this.boneTex, look: this.lookTex, albedo: cast.albedo, normal: cast.normal },
      cast.layerRough, app.materials, app.params.num('humans_dbg', 0), this.v2,
      { beardBase: this.beardBase, brows: this.browsOnSkin && cast.chars.some((c) => c.brow) });
    app.materials.register('humans.figures', mat);
    app.materials.track(mat);
    this.uniforms = uniforms;
    this.batch = new FigureBatch(app, merged.geometry, ranges, mat, depth, uniforms);
    this.batch.mesh.userData.dynamicCaster = true;
    this.group.add(this.batch.mesh);
    // children riding in strollers: a pool of slots for the toddler figures
    this.compFirst = -1;
    if (cast.chars.some((c) => c.ageClass === 'toddler')) {
      this.compFirst = this.alloc(TODDLER_POOL);
      for (let k = 0; k < TODDLER_POOL; k++) { const c = this.slots[this.compFirst + k]; c.comp = true; c.owner = -1; c.compKey = NaN; }
    }
    this.babyQ = [];
    this.babyN = 0;
    this.tcache = new Map();
    this.holdList = [];
    if (this.props) {
      try {
        tq = performance.now();
        this.mob = new Mobility(app, this, this.props);
        this.initMs.mob = Math.round(performance.now() - tq);
        this.group.add(this.mob.object);
      } catch (e) {
        console.warn('[humans] mobility props disabled', e);
        this.mob = null;
      }
    }
    this.cache.clear();       // appearances asked for before the cast was loaded
    tq = performance.now();
    this._precompile(app);
    this.initMs.compile = Math.round(performance.now() - tq);
    this.ready = true;
    this.initMs.total = Math.round(performance.now() - tInit);
    if (app.params.num('humanstest', 0)) this.test = new HumansTest(app, this);
    // propstest=1: the props' own close-up harness (humans/props/test.js, pt_* parameters)
    if (this.props && app.params.num('propstest', 0)) this.props.mountPropsTest(app).catch((e) => console.warn('[humans] props test', e));
  },

  /** Build the figures' (and props') shader programs now, so the first figures to walk into view
   *  do not stall a frame while their program compiles. */
  _precompile(app) {
    const shown = [];
    try {
      const m = this.batch.mesh;
      m.visible = true; shown.push(m);
      if (this.mob) for (const w of this.mob.warmMeshes()) { w.visible = true; shown.push(w); }
      app.renderer.compile(this.group, app.camera, app.scene);
    } catch (e) {
      console.warn('[humans] shader warm-up skipped', e);
    }
    for (const m of shown) m.visible = false;
  },

  // ------------------------------------------------------------------ contract API

  /** Reserve `count` figure slots; returns the first slot index. */
  alloc(count) {
    const first = this.used;
    this.used += count;
    for (let i = first; i < this.used; i++) this.slots.push(newSlot());
    if (this.boneTex) this.ensureCapacity(this.used);
    return first;
  },

  set(i, o) {
    const s = this.slots[i];
    if (!s) return;
    // non-finite inputs would poison the bone matrices: keep the last good value
    if (o.x !== undefined && Number.isFinite(o.x + o.y + o.z)) { s.x = o.x; s.y = o.y; s.z = o.z; }
    if (Number.isFinite(o.heading)) s.heading = o.heading;
    if (Number.isFinite(o.speed)) s.speed = Math.max(0, o.speed);
    if (Number.isFinite(o.phase)) s.phase = o.phase;
    if (o.pose !== undefined) s.pose = o.pose | 0;
    if (Number.isFinite(o.look)) s.look = o.look;
    if (o.appearance !== undefined && o.appearance !== s.appearance) {
      s.appearance = o.appearance;
      s.a = null;
    }
    // outfit (optional): 'waiter' dresses café staff (light shirt, dark trousers, a waist apron)
    const outfit = o.outfit === 'waiter' ? 1 : 0;
    if (outfit !== s.outfit) { s.outfit = outfit; s.a = null; }
    // mobility: prop kind / seed, the bicycle's lean and handlebar angle (rad, + left; derived from
    // the turn when not given)
    if (o.prop !== undefined) s.prop = o.prop | 0;
    if (o.propSeed !== undefined) s.propSeed = o.propSeed | 0;
    // (NaN, not null, when absent: the slot's fields stay unboxed doubles)
    s.leanIn = Number.isFinite(o.lean) ? o.lean : NaN;
    s.steerIn = Number.isFinite(o.steer) ? o.steer : NaN;
    // standing stance override (optional): 0 relaxed, 1 phone, 2 arms folded, 3 hands in pockets, 4 hand
    // on hip, 5 hands behind the back, 6 talking, 7 looking about; absent / -1: the person's own
    s.idleIn = Number.isInteger(o.idle) && o.idle >= 0 && o.idle <= 7 ? o.idle : -1;
    // hand in hand with slot holdWith (or holding on to its stroller)
    s.holdWith = Number.isInteger(o.holdWith) && o.holdWith >= 0 && o.holdWith !== i ? o.holdWith : -1;
    // seated without a table in front (a bench, a shelter seat): table false rests the hands on the thighs
    s.tableIn = o.table === false ? 0 : 1;
    // indoors (a tram's passengers): fill = extra irradiance / pi (linear rgb) on the diffuse light, shade = the
    // share of the sky / environment light kept (0..1); absent: none, 1
    const f = o.fill;
    if (f && f.length >= 3 && Number.isFinite(f[0] + f[1] + f[2])) { s.fillR = Math.max(0, f[0]); s.fillG = Math.max(0, f[1]); s.fillB = Math.max(0, f[2]); }
    else { s.fillR = 0; s.fillG = 0; s.fillB = 0; }
    s.shade = Number.isFinite(o.shade) ? Math.min(1, Math.max(0, o.shade)) : 1;
    s.visible = o.visible !== false;
  },

  /** set() takes the indoor light fields fill and shade (see set). */
  supportsFill: true,

  /** Poses this renderer can show: 0-2 always, 3-5 (stroller, riding, walking a bicycle) with the props. */
  supportsPose(p) { return p >= 0 && p <= 2 ? true : p >= 3 && p <= 5 ? !!(this.ready && this.mob) : false; },

  /** Parked bicycles of a chunk (racks, leaning on poles / trees), or null. */
  build(chunk, app) {
    if (!this.props) return null;
    try {
      return this.props.buildParkedBicycles(chunk, app);
    } catch (e) {
      if (!this._parkWarned) { this._parkWarned = true; console.warn('[humans] parked bicycles failed', e); }
      return null;
    }
  },

  dispose(obj) {
    if (this.props && obj) this.props.disposeParkedBicycles(obj);
  },

  setVisible(i, v) { const s = this.slots[i]; if (s) s.visible = !!v; },

  heightOf(appearance) { return this._personOf(appearance).height; },

  /** Metres travelled per crank revolution when riding: the gearing of the bikes this person
   *  rides (kids' 20-inch bikes for children, city / commuter gearing for everyone else). */
  cycleLength(appearance) {
    const a = this._personOf(appearance);
    return a.age === 'child' || a.height < 1.45 ? 3.05 : 4.4;
  },

  /** Distance covered per gait cycle (two steps) at `speed` m/s, so phase advances without foot slide.
   *  Pose 4 (riding): per crank turn. Poses 3 and 5 (pushing a stroller, walking a bicycle) walk
   *  on the same clips as everyone else, so they share the walk stride. */
  strideLength(appearance, speed, pose = 0) {
    if (pose === 4) return this.cycleLength(appearance);
    return this._stride(appearance, speed);
  },

  _stride(appearance, speed) {
    const a = this._personOf(appearance);
    const B = this.bases && this.bases[a.body];
    if (!B) return 1.48 * (0.55 + 0.32 * speed);
    const sc = a.height / B.info.H;
    _gaitIn[0] = speed; _gaitIn[1] = sc;
    const g = gaitBlend(B, a, a.idle);
    const st = B.baked.strides;
    let S = st[g.a] * g.wa + (g.b >= 0 && g.b < CLIP.idle ? st[g.b] * g.wb : 0);
    if (g.idle > 0) S = st[g.a] * (0.55 + 0.45 * g.wa);
    return Math.max(0.3, S * sc * g.extra);
  },

  /** The person for appearance seed `seed` (outfit 1: dressed as a waiter, see castWaiter). */
  appearanceOf(seed, outfit = 0) {
    const cache = outfit ? this.wcache : this.cache;
    let a = cache.get(seed);
    if (!a) {
      if (!this.cast) return FALLBACK;
      if (cache.size > 6000) cache.clear();
      const f = this.forced.get(seed);
      a = f ? castCharacter(seed >>> 0, this.cast, f.index, f.own) : outfit ? castWaiter(seed >>> 0, this.cast) : castAppearance(seed >>> 0, this.cast);
      cache.set(seed, a);
    }
    return a;
  },
  wcache: new Map(),

  /** The person the contract's per-seed queries (heightOf, strideLength, cycleLength) describe: the
   *  waiter for seeds last shown with outfit 'waiter' (the character may differ from the seed's own). */
  _personOf(seed) { return this.appearanceOf(seed, this.waiterSeeds.has(seed) ? 1 : 0); },
  waiterSeeds: new Set(),
  _markWaiter(seed) {
    if (this.waiterSeeds.size > 4000) this.waiterSeeds.clear();
    this.waiterSeeds.add(seed);
  },

  /** Testing: appearance `seed` shows character `index` of the cast (own: its own colours). */
  forceCharacter(seed, index, own = false) {
    this.forced.set(seed, { index, own });
    this.cache.delete(seed);
    return seed;
  },
  forced: new Map(),

  ensureCapacity(n) {
    if (n <= this.capacity) return;
    const cap = Math.max(64, 1 << Math.ceil(Math.log2(n)));
    const look = new Float32Array(cap * LOOK_W * 4);
    if (this.lookTex) look.set(this.lookTex.image.data);
    const old = [this.boneTex, this.lookTex];
    this.boneTex = dataTexture(new Float32Array(cap * BONE_W * 4), BONE_W, cap, true);
    this.lookTex = dataTexture(look, LOOK_W, cap, false);
    this.capacity = cap;
    this.rowSlot = new Int32Array(cap);
    if (this.uniforms) { this.uniforms.uBoneTex.value = this.boneTex; this.uniforms.uLookTex.value = this.lookTex; }
    old.forEach((t) => t && t.dispose());
  },

  // ------------------------------------------------------------------ per frame

  update(dt, app) {
    if (!this.ready) return;
    const t0 = performance.now();
    this.time += dt;
    if (this.test) this.test.update(dt);
    const cam = app.camera;
    const mob = this.mob;
    if (mob) mob.begin(cam, app.renderer);
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_m);
    this._camPos = cam.position;
    _fwd.set(0, 0, -1).transformDirection(cam.matrixWorld);
    this._pxPerM = (app.renderer.domElement.height || 1080) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    // the sun's horizontal shadow direction and reach per metre of height (off-screen figures whose
    // shadow falls into view are posed too)
    const sd = U.uSunDir ? U.uSunDir.value : null;
    if (sd) {
      const el = Math.max(0.12, sd.y);
      const hl = Math.sqrt(sd.x * sd.x + sd.z * sd.z) || 1;
      const S = this._shadowDir || (this._shadowDir = { x: 0, z: 0, k: 0 });
      S.x = -sd.x / hl; S.z = -sd.z / hl; S.k = Math.min(12, Math.sqrt(1 - el * el) / el);
      this._shadow = S;
    } else this._shadow = null;
    this._bones = this.boneTex.image.data;
    const look = this.lookTex;
    this._lookDirty = false;
    this._n = 0;
    this.babyN = 0;
    this.batch.begin(app.frame, cam);
    // who walks hand in hand with whom this frame (both sides' arms)
    this._holdPrep();
    for (let i = 0; i < this.used; i++) {
      const s = this.slots[i];
      if (s.comp || !s.visible || s.appearance === null) continue;
      if (!s.a) {
        s.a = this.appearanceOf(s.appearance, s.outfit);
        if (s.outfit) this._markWaiter(s.appearance);
        this._newLook(i, s);
      }
      const a = s.a;
      const B = this.bases[a.body];
      if (!B) continue;
      // (the figure's scale travels in the slot: a float argument to a large function is boxed)
      s.sc = a.height / B.info.H;
      // mobility props follow their figure (culled and LOD'd by their own instancers)
      if (mob && s.pose >= 3) {
        const st = mob.track(s, a, dt, this.time);
        if (st && s.prop) {
          mob.draw(s, st);
          // a child riding in the stroller (its figure is placed after this loop)
          if (st.prop === 1 && (st.look.flags & mob.babyFlag) && this.compFirst >= 0) this._queueBaby(i, s, st);
        }
      } else if (s.mob) s.mob.valid = false;
      this._emit(i, s, a, B);
    }
    this._babies();
    this.batch.end();
    if (mob) mob.end();
    // only the rows of this frame's figures are uploaded (see dataTexture)
    const n = this._n;
    if (n > 0) {
      this.boneTex.userData.rows = n;
      this.boneTex.needsUpdate = true;
    }
    if (this._lookDirty) look.needsUpdate = true;
    this.perf.figures = this.batch.nView;
    this.perf.posed = n;
    this.perf.ms = this.perf.ms * 0.95 + (performance.now() - t0) * 0.05;
  },

  /** A new person in slot i: write its look row, reset its pose history. */
  _newLook(i, s) {
    const look = this.lookTex;
    writeLook(look.image.data, i, s.a);
    s.posePrev = -1;               // a new person in this slot: no cross-fade from the last one
    s.idleShown = -1;
    if (!look.userData.fresh) look.addUpdateRange(i * LOOK_W * 4, LOOK_W * 4);
    this._lookDirty = true;
  },

  /** Cull, pick the LOD, pose and queue figure i for drawing. */
  _emit(i, s, a, B) {
    const h = a.height;
    _sph.center.set(s.x, s.y + 0.5 * h, s.z);
    _sph.radius = 0.62 * h + 0.3;
    let inView = _frustum.intersectsSphere(_sph);
    if (!inView) {
      // its shadow may still fall into view (low sun): the sphere stretched along the shadow
      const S = this._shadow;
      if (!S) { s.lod = -1; return; }
      const L = Math.min(25, h * S.k) * 0.5;
      _sph.center.x += S.x * L; _sph.center.z += S.z * L;
      _sph.center.y -= 0.4 * h;
      _sph.radius += L;
      if (!_frustum.intersectsSphere(_sph)) { s.lod = -1; return; }
      _sph.center.set(s.x, s.y + 0.5 * h, s.z);
      _sph.radius = 0.62 * h + 0.3;
    }
    const lodPx = this.lodPx;
    const dist = _sph.center.distanceTo(this._camPos);
    const px = (h / Math.max(0.5, dist)) * this._pxPerM;
    let lod = 0;
    while (lod < lodPx.length && px <= lodPx[lod]) lod++;
    lod = Math.min(lod, 3);
    if (s.lod >= 0 && lod !== s.lod) {      // hysteresis against flicker at the thresholds
      const edge = lodPx[Math.min(lod, s.lod)];
      if (Math.abs(px - edge) < edge * 0.08) lod = s.lod;
    }
    s.lod = lod;
    s.inView = inView;
    const row = this._n++;
    this.rowSlot[row] = i;
    this._pose(row, i, s, a, B, this._bones);
    // accessories: the phone or cup in hand, a bag (put down when seated; a shopping bag does not stay
    // in a hand that holds a stroller, a bicycle or a child's hand)
    const P = B.partR;
    _extra.fill(-1); _extraFar.fill(-1); _shadowExtra.fill(-1);
    let k = 0, kf = 0;
    if (s.phoneOn) _extra[k++] = P.phone;
    else if (s.cupOn) _extra[k++] = P.cup;
    // a waiter's apron
    if (a.apron && P.apron !== undefined) { _extra[k++] = P.apron; _extraFar[kf++] = P.apronFar; _shadowExtra[1] = P.apronFar; }
    // glasses (sunglasses by day only, a coarse pair on the far LODs; a thin frame is sub-pixel there)
    if (a.glasses === 1 && P.sunglasses !== undefined && U.uNight.value < 0.35) { _extra[k++] = P.sunglasses; if (P.sunglassesFar !== undefined) _extraFar[kf++] = P.sunglassesFar; }
    else if (a.glasses === 2 && P.glasses !== undefined) _extra[k++] = P.glasses;
    if (a.bag && s.pose !== 2) {
      const handBusy = s.pose >= 3 || (s.hold && s.hold.side === 'R');
      if (a.bag === BAG.BACKPACK) { _extra[k++] = P.backpack; _extraFar[kf++] = P.backpackFar; _shadowExtra[0] = P.backpackFar; }
      else if (a.bag === BAG.SHOULDER) { _extra[k++] = P.shoulder; _extraFar[kf++] = P.shoulderFar; _shadowExtra[0] = P.shoulderFar; }
      else if (a.bag === BAG.SHOPPING && !handBusy) { _extra[k++] = P.shopping; _extraFar[kf++] = P.shopping; _shadowExtra[0] = P.shopping; }
    }
    const bi = this.batch.add(row, inView, lod, B.bodyR, _extra, _extraFar, _shadowExtra);
    // (the bounding sphere and view depth written straight into the batch's arrays: no boxed float arguments)
    const S = this.batch.sph, c = _sph.center;
    S[bi * 4] = c.x; S[bi * 4 + 1] = c.y; S[bi * 4 + 2] = c.z; S[bi * 4 + 3] = _sph.radius;
    this.batch.depth[bi] = (c.x - this._camPos.x) * _fwd.x + (c.y - this._camPos.y) * _fwd.y + (c.z - this._camPos.z) * _fwd.z;
  },

  _queueBaby(i, s, st) {
    let q = this.babyQ[this.babyN];
    if (!q) q = this.babyQ[this.babyN] = { i: 0, s: null, st: null };
    q.i = i; q.s = s; q.st = st;
    this.babyN++;
  },

  /** Children riding in this frame's strollers: a toddler sits in the seat (a baby lies in a
   *  pram's bassinet), drawn from the pool of slots. */
  _babies() {
    const first = this.compFirst;
    if (first < 0) return;
    const kit = this.mob && this.mob.strollers;
    for (let k = 0; k < TODDLER_POOL; k++) this.slots[first + k].used = false;
    for (let q = 0; q < this.babyN; q++) {
      const { i, s, st } = this.babyQ[q];
      const seat = kit && kit.babySeat ? kit.babySeat(st.v) : null;
      if (!seat) continue;
      // keep the child this pusher had last frame
      let ci = s.babySlot ?? -1;
      if (ci < 0 || this.slots[ci].owner !== i || this.slots[ci].used) {
        ci = -1;
        for (let k = 0; k < TODDLER_POOL; k++) {
          const c = this.slots[first + k];
          if (!c.used && c.owner < 0) { ci = first + k; break; }
        }
        if (ci < 0) {
          for (let k = 0; k < TODDLER_POOL; k++) {
            const c = this.slots[first + k];
            if (!c.used) { ci = first + k; break; }
          }
        }
        if (ci < 0) continue;            // more strollers in view than seats in the pool
        s.babySlot = ci;
      }
      const c = this.slots[ci];
      c.used = true;
      c.owner = i;
      const key = (s.propSeed | 0) * 2 + (seat.lie ? 1 : 0);      // (a number: no string per frame)
      if (c.compKey !== key) {
        c.compKey = key;
        let a = this.tcache.get(key);
        if (!a) {
          if (this.tcache.size > 512) this.tcache.clear();
          a = castToddler(hashSeed(s.propSeed | 0), this.cast, seat.lie);
          this.tcache.set(key, a);
        }
        if (!a) { c.used = false; continue; }
        c.a = a;
        c.appearance = -1;
        this._newLook(ci, c);
        c.lod = -1;
      }
      const B = this.bases[c.a.body];
      // the seat in the world: prop origin + Ry(heading) Rx(pitch) seat (as mobility.draw places it)
      const ch = Math.cos(s.heading), sh = Math.sin(s.heading);
      const ox = s.x + ch * st.offX + sh * st.offZ, oz = s.z - sh * st.offX + ch * st.offZ;
      const cp = Math.cos(st.pitch), sp = Math.sin(st.pitch);
      const ly = cp * seat.y - sp * seat.z, lz = sp * seat.y + cp * seat.z;
      c.x = ox + ch * seat.x + sh * lz;
      c.z = oz - sh * seat.x + ch * lz;
      c.y = s.y + ly - SEAT_HEIGHT;
      c.heading = s.heading;
      c.speed = 0; c.phase = 0; c.pose = 2; c.look = 0; c.visible = true;
      c.prop = 0; c.holdWith = -1; c.hold = null;
      // far away the child is a few pixels inside the canopy
      const px = (c.a.height / Math.max(0.5, hyp3(c.x - this._camPos.x, c.y - this._camPos.y, c.z - this._camPos.z))) * this._pxPerM;
      if (px <= this.lodPx[2] * 0.8) { c.visible = false; c.lod = -1; continue; }
      c.sc = c.a.height / B.info.H;
      this._emit(ci, c, c.a, B);
    }
    for (let k = 0; k < TODDLER_POOL; k++) {
      const c = this.slots[first + k];
      if (!c.used) { c.owner = -1; c.visible = false; }
    }
  },

  /**
   * Hand-in-hand links for this frame. A child (holdWith = adult's slot) and its adult each get
   * the hand on the side facing the other; the hands meet between the two at a height both reach
   * (the adult's arm hangs, the child's rises). Holding on to a stroller (holdWith = the pusher):
   * the child's hand goes to the stroller's side frame. Links that drift apart let go.
   */
  _holdPrep() {
    for (const i of this.holdList) { const s = this.slots[i]; if (s) s.hold = null; }
    this.holdList.length = 0;
    if (!this.mob) return;
    for (let i = 0; i < this.used; i++) {
      const s = this.slots[i];
      if (s.comp || s.holdWith < 0 || !s.visible || s.appearance === null) continue;
      const p = this.slots[s.holdWith];
      if (!p || !p.visible || p.appearance === null || p.comp) continue;
      if (s.pose > 1 || !(p.pose <= 1 || p.pose === 3)) continue;
      // (s.a is left for the main loop to set: it writes the look row when it does)
      const a = s.a || this.appearanceOf(s.appearance), pa = p.a || this.appearanceOf(p.appearance);
      const Bs = this.bases[a.body], Bp = this.bases[pa.body];
      if (!Bs || !Bp) continue;
      let dh = p.heading - s.heading;
      dh = ((dh + Math.PI) % TAU + TAU) % TAU - Math.PI;
      if (Math.abs(dh) > 0.7) continue;
      const cs = Math.cos(s.heading), sn = Math.sin(s.heading);
      const dx = p.x - s.x, dz = p.z - s.z;
      const lat = dx * cs - dz * sn, fwd = -dx * sn - dz * cs;
      if (p.pose === 3) {
        // the stroller's side frame on the child's side, a little ahead of the handle
        const st = p.mob;
        if (!st || !st.valid || st.prop !== 1) continue;
        const cp = Math.cos(p.heading), spn = Math.sin(p.heading);
        const ox = p.x + cp * st.offX + spn * st.offZ, oz = p.z - spn * st.offX + cp * st.offZ;
        const rx = (s.x - ox) * cp - (s.z - oz) * spn;          // the child across the stroller's frame
        if (Math.abs(rx) < 0.25 || Math.abs(rx) > 1.0) continue;
        const side = lat > 0 ? 'R' : 'L';
        const sh = this._shoulderW(s, a, Bs, side, _hv);
        const reach = this._reach(a, Bs);
        // a hand on the side tube that runs from the handle down to the fold hinge, at a height
        // the child reaches comfortably
        const gy = Math.min(p.y + 0.9, Math.max(sh.y - 0.5 * reach, p.y + 0.6));
        const u = Math.min(1, Math.max(0, (1.02 - (gy - p.y)) / 0.4));
        const sx = Math.sign(rx) * 0.245, sz = -0.27 * u;
        const gx = ox + cp * sx + spn * sz, gz = oz - spn * sx + cp * sz;
        if (hyp3(gx - sh.x, gy - sh.y, gz - sh.z) > reach * 0.97) continue;
        s.hold = { side, x: gx, y: gy, z: gz, adult: false };
        this.holdList.push(i);
        continue;
      }
      if (Math.abs(lat) < 0.22 || Math.abs(lat) > 0.95 || Math.abs(fwd) > 0.55) continue;
      const side = lat > 0 ? 'R' : 'L';
      const latP = -dx * Math.cos(p.heading) + dz * Math.sin(p.heading);
      const sideP = latP > 0 ? 'R' : 'L';
      // the phone hand stays on the phone, the shopping bag in its hand
      if (((pa.phoneWalk || pa.carry) && sideP === 'R') || ((a.phoneWalk || a.carry) && side === 'R')) continue;
      const shS = this._shoulderW(s, a, Bs, side, _hv);
      const shP = this._shoulderW(p, pa, Bp, sideP, _hw);
      const rS = this._reach(a, Bs), rP = this._reach(pa, Bp);
      // height: as low as the taller one's hanging arm reaches; the smaller one raises its arm
      const tall = shP.y > shS.y;
      const shT = tall ? shP : shS, shL = tall ? shS : shP, rT = tall ? rP : rS, rL = tall ? rS : rP;
      const lowT = shT.y - 0.92 * rT;
      // (a small child reaches up, the hand up to above its shoulder)
      if (lowT > shL.y + 0.14) continue;            // too small a child for this adult's hand
      const gy = Math.max(lowT, shL.y - 0.8 * rL);
      const gx = (shS.x + shP.x) * 0.5 - sn * 0.06, gz = (shS.z + shP.z) * 0.5 - cs * 0.06;
      if (hyp3(gx - shL.x, gy - shL.y, gz - shL.z) > rL * 0.98 || hyp3(gx - shT.x, gy - shT.y, gz - shT.z) > rT * 0.98) continue;
      s.hold = { side, x: gx, y: gy, z: gz, adult: !tall };
      p.hold = { side: sideP, x: gx, y: gy, z: gz, adult: tall };
      this.holdList.push(i, s.holdWith);
    }
  },

  /** World position of slot s's shoulder joint on side `side`. */
  _shoulderW(s, a, B, side, out) {
    const j = B.rig.rest[side === 'R' ? BONE.armR : BONE.armL];
    const sc = a.height / B.info.H;
    const c = Math.cos(s.heading), sn = Math.sin(s.heading);
    return out.set(s.x + (c * j.x + sn * j.z) * sc, s.y + j.y * sc, s.z + (-sn * j.x + c * j.z) * sc);
  },

  /** Shoulder-to-grip reach of a figure (m). */
  _reach(a, B) {
    return (B.rig.ua + B.rig.fa + 0.09 * (B.info.H / 1.76)) * (a.height / B.info.H);
  },

  /** Blend the figure's pose and write bone row `row` (model -> world) plus its state texels. */
  _pose(row, i, s, a, B, out) {
    const sc = s.sc;
    // small far figures (and those only casting a shadow into view) re-blend their clips every other
    // frame (staggered); the transform below is still applied every frame so camera motion stays exact
    const M = s.model || (s.model = new Float32Array(MAT_N));
    const frame = this.app.frame;
    // (riders: every frame until they are tiny, so the feet keep up with the pedals; figures a few
    // pixels tall and those only casting a shadow into view every third frame)
    const every = !s.inView || s.lod >= 3 ? 3 : s.lod === 2 && s.pose !== 4 ? 2 : 1;
    if (every === 1 || s.pose !== s.posePrev || (frame + i) % every === 0 || s.blendFrame < frame - every || s.blendBase !== B) {
      this._blend(s, a, B, M);
      s.blendFrame = frame;
      s.blendBase = B;
    }
    // figure transform: T(x, y, z) * Ry(heading) * S(sc); seated figures keep the seat height
    const c = Math.cos(s.heading) * sc, sn = Math.sin(s.heading) * sc;
    const y0 = s.y + SEAT_HEIGHT * (1 - sc) * s.seatW;
    const base = row * BONE_W * 4;
    for (let k = 0; k < MAT_N; k += 12) {
      const o = base + k;
      for (let col = 0; col < 4; col++) {
        const m0 = M[k + col], m1 = M[k + 4 + col], m2 = M[k + 8 + col];
        out[o + col] = c * m0 + sn * m2;
        out[o + 4 + col] = sc * m1;
        out[o + 8 + col] = -sn * m0 + c * m2;
      }
      out[o + 3] += s.x;
      out[o + 7] += y0;
      out[o + 11] += s.z;
    }
    // state texels: gait phase, speed, seated blend, ground height | look row, phone shown, hands in pockets, scale |
    // indoor fill light (irradiance / pi), the share of the sky light it loses
    const o = base + BONE_DYN * 4;
    out[o] = s.phase; out[o + 1] = s.pose === 0 || s.pose === 3 || s.pose === 5 ? s.speed : 0; out[o + 2] = s.seatW; out[o + 3] = s.y;
    out[o + 4] = i; out[o + 5] = s.phoneOn ? 1 : 0; out[o + 6] = s.pocketW; out[o + 7] = sc;
    out[o + 8] = s.fillR; out[o + 9] = s.fillG; out[o + 10] = s.fillB; out[o + 11] = 1 - s.shade;
  },

  _blend(s, a, B, M) {
    const sc = s.sc;
    const bk = B.baked;
    const t = this.time;
    if (this.bindPose) {
      // testing (humans_bind=1): the bind pose
      for (let b = 0; b < NUM_BONES; b++) M.set(IDENT34, b * 12);
      s.seatW = 0; s.phoneOn = s.cupOn = false; s.pocketW = 0;
      return;
    }
    // standing stance: the person's own, or the one the crowd asks for (set() field idle)
    const idle = s.idleIn >= 0 ? s.idleIn : a.idle;
    // pose changes (and a new standing stance) cross-fade from a snapshot of the last displayed pose
    if (s.pose !== s.posePrev || (s.pose === 1 && idle !== s.idleShown && s.idleShown >= 0)) {
      if (s.posePrev >= 0 && s.blendBase === B) {
        s.fromM = s.fromM || new Float32Array(MAT_N);
        s.fromM.set(M);
        s.fadeT0 = t;
        s.fadeDur = s.pose === 2 || s.posePrev === 2 ? FADE.sit : FADE.stand;
        s.fromPhone = s.phoneW;
        s.fromPocket = s.pocketW;
        s.fromSeat = s.seatW;
        s.fromCup = s.cupW;
      } else {
        s.fadeDur = 0;
      }
      s.posePrev = s.pose;
    }
    s.idleShown = idle;
    M.fill(0);
    let phone = 0, pocket = 0, cup = 0;
    // mobility poses (props shown): 3 pushing a stroller and 5 walking a bicycle re-pose the arms
    // of the walk; 4 riding is solved whole (humans/mobility.js)
    const mobP = !!(this.mob && s.mob && s.mob.valid && s.prop && s.pose >= 3 && s.pose <= 5);
    if (s.pose === 2) {
      const sv = s.tableIn ? a.sit : SIT_NO_TABLE[a.sit];
      addClip(M, bk, CLIP.sit + sv, t / (CLIPS[CLIP.sit + sv].frames > 64 ? 14 : 11) + a.seedT, 1);
      phone = PHONE_SIT.includes(sv) ? 1 : 0;
      cup = CUP_SIT.includes(sv) ? 1 : 0;
    } else if (s.pose === 1) {
      addClip(M, bk, CLIP.idle + idle, t / idlePeriod(idle) + a.seedT, 1);
      phone = PHONE_IDLE.includes(idle) ? 1 : 0;
      pocket = idle === 3 ? 1 : 0;
    } else if (mobP && s.pose === 4) {
      this.mob.pose(s, a, B, M);
    } else {
      _gaitIn[0] = s.speed; _gaitIn[1] = sc;
      const g = gaitBlend(B, a, mobP ? 0 : idle);
      addClip(M, bk, g.a, s.phase, g.wa);
      if (g.b >= 0 && g.wb > 0.001) addClip(M, bk, g.b, g.b >= CLIP.idle ? t / idlePeriod(g.b - CLIP.idle) + a.seedT : s.phase, g.wb);
      // upper-body variations carried by the walking chest (not while the hands hold a prop)
      if (mobP) { /* hands on the stroller / bicycle below */ }
      else if (a.phoneWalk) { overrideBones(M, B.phone, PHONE_BONES, 1); phone = 1; }
      else if (a.carry) overrideBones(M, B.hang, CARRY_BONES, 0.65);
      else if (PHONE_IDLE.includes(idle) && g.b >= CLIP.idle) phone = g.wb;
      if (!mobP && idle === 3 && g.b >= CLIP.idle) pocket = g.wb;
    }
    if (!(mobP && s.pose === 4)) rigidify(M, B.rig.rest);
    // a shoulder bag at the left hip holds the left arm a little out from the side, so the arm hangs
    // and swings past the bag (not in the stances that fold, pocket or hide the left hand)
    if (a.bag === BAG.SHOULDER && !mobP && s.pose <= 1 && !(s.hold && s.hold.side === 'L')) {
      let wOut = 0;
      if (s.pose === 1) wOut = BAG_ARM_OUT[idle];
      else { const g = _gait; wOut = g.b >= CLIP.idle ? 1 - g.wb * (1 - BAG_ARM_OUT[g.b - CLIP.idle]) : 1; }
      if (wOut > 0.01) {
        const c = BONE.spine2 * 12;
        _rot[0] = M[c + 2]; _rot[1] = M[c + 6]; _rot[2] = M[c + 10]; _rot[3] = -BAG_ARM_ANGLE * wOut;
        rotBones(M, B.rig.rest, LARM_BONES, BONE.armL, _rot);
      }
    }
    if (mobP && s.pose !== 4) {
      // pushing leans the trunk in a little from the hips; stoop as usual; then hands on the prop
      const lean = (s.pose === 3 ? 5.5 : 2) * Math.PI / 180;
      _ang[0] = -lean; pitchBones(M, B.rig.rest, LEAN_BONES, BONE.spine1, _ang);
      if (a.stoop > 0.005) { _ang[0] = -a.stoop; pitchBones(M, B.rig.rest, STOOP_BONES, BONE.spine2, _ang); }
      _ang[0] = (lean + a.stoop) * 0.65; pitchBones(M, B.rig.rest, HEAD_BONES, BONE.neck, _ang);
      this.mob.pose(s, a, B, M);
    }
    let w = 1;
    if (s.fadeDur > 0) {
      w = smooth01((t - s.fadeT0) / s.fadeDur);
      if (w < 1) {
        const F = s.fromM;
        for (let k = 0; k < MAT_N; k++) M[k] = F[k] + (M[k] - F[k]) * w;
        rigidify(M, B.rig.rest);
        phone = s.fromPhone + (phone - s.fromPhone) * w;
        pocket = s.fromPocket + (pocket - s.fromPocket) * w;
        cup = s.fromCup + (cup - s.fromCup) * w;
      } else s.fadeDur = 0;
    }
    s.phoneW = phone;
    s.pocketW = pocket;
    s.cupW = cup;
    s.phoneOn = phone > 0.5;
    s.cupOn = cup > 0.5;
    const seat = s.pose === 2 ? 1 : 0;
    s.seatW = s.fadeDur > 0 ? s.fromSeat + (seat - s.fromSeat) * w : seat;
    // older people's rounded upper back: the chest and everything it carries tip forward about
    // the mid spine, the neck and head take most of it back so the gaze stays level
    if (a.stoop > 0.005 && !mobP) {
      _ang[0] = -a.stoop; pitchBones(M, B.rig.rest, STOOP_BONES, BONE.spine2, _ang);
      _ang[0] = a.stoop * 0.65; pitchBones(M, B.rig.rest, HEAD_BONES, BONE.neck, _ang);
    }
    // head turn: the neck takes a third, the head the rest, both about their own joints
    // (a rider's head turn is part of the riding pose)
    const look = mobP && s.pose === 4 ? 0 : Math.max(-1.25, Math.min(1.25, s.look || 0));
    if (look > 1e-3 || look < -1e-3) {
      _ang[0] = look * 0.35; rotateBoneY(M, B.rig.rest, BONE.neck, BONE.neck, _ang);
      _ang[0] = look * 0.35; rotateBoneY(M, B.rig.rest, BONE.head, BONE.neck, _ang);
      _ang[0] = look * 0.65; rotateBoneY(M, B.rig.rest, BONE.head, BONE.head, _ang);
    }
    // hand in hand: the near arm reaches the meeting point (the other one swings on)
    if (s.hold && this.mob && s.pose <= 1) {
      const h = s.hold, P = this.mob.poser(B);
      const c = Math.cos(s.heading), sn = Math.sin(s.heading);
      const dx = (h.x - s.x) / sc, dy = (h.y - s.y) / sc, dz = (h.z - s.z) / sc;
      _hold[0] = c * dx - sn * dz; _hold[1] = dy; _hold[2] = sn * dx + c * dz;
      const sg = h.side === 'R' ? 1 : -1;
      // thumb forward; the adult's elbow hangs back and out, the child's points down and back
      _holdI[0] = 0; _holdI[1] = h.adult ? -0.25 : 0.35; _holdI[2] = -1;
      _holdP[0] = sg * (h.adult ? 0.55 : 0.35); _holdP[1] = -0.75; _holdP[2] = 0.45;
      P.armOnto(M, h.side, _hold, _holdI, _holdP, -12 * Math.PI / 180, 0);
    }
  },

  /** Submitted geometry for the main pass (sub-draws, figures, triangles), for profiling. */
  stats() {
    const lods = [0, 0, 0, 0];
    for (const s of this.slots) if (s.visible && s.lod >= 0 && s.a && s.inView) lods[s.lod]++;
    const b = this.batch ? this.batch.stats : {};
    return { draws: b.view || 0, figures: this.perf.figures, posed: this.perf.posed, triangles: Math.round(b.tris || 0), lods,
      shadowDraws: b.shadow || 0, shadowTriangles: Math.round(b.shadowTris || 0), shadowPasses: b.passes || 0,
      cpuMs: +this.perf.ms.toFixed(3), props: this.mob ? this.mob.stats() : null, buffers: this.stats_, initMs: this.initMs };
  },
};

/**
 * Beards are a single shell over the skin: its edges (cheeks, neck, round the mouth) thin out over
 * `range` (3.5 cm; 1.5 cm over a version 2 cast's beard growth decal) instead of ending in a hard mask line. Per beard vertex the distance (m) to the shell's
 * boundary (shortest path along the shell's edges) goes into tex.y (0..254 = 0..3.5 cm; the beard has
 * no normal layer), which the shader turns into strand coverage.
 */
function beardFade(c, range = 0.035) {
  const raw = c.raw, T = raw.tex, P = raw.pos, I = raw.index;
  const L0 = c.lods[0];
  const edges = new Map(), adj = new Map();
  const key = (a, b) => (a < b ? a * 1048576 + b : b * 1048576 + a);
  for (let t = L0.start; t < L0.start + L0.count; t += 3) {
    const a = I[t], b = I[t + 1], d = I[t + 2];
    if (T[a * 4 + 2] !== 11) continue;
    for (const [u, v] of [[a, b], [b, d], [d, a]]) {
      const k = key(u, v);
      edges.set(k, (edges.get(k) || 0) + 1);
      if (!adj.has(u)) adj.set(u, []);
      if (!adj.has(v)) adj.set(v, []);
      adj.get(u).push(v); adj.get(v).push(u);
    }
  }
  if (!adj.size) return;
  const dist = new Map();
  const queue = [];
  for (const [k, n] of edges) {
    if (n !== 1) continue;
    const u = Math.floor(k / 1048576), v = k % 1048576;
    dist.set(u, 0); dist.set(v, 0); queue.push(u, v);
  }
  // (Bellman-Ford style relaxation: the shell is small)
  for (let it = 0; it < 40 && queue.length; it++) {
    const next = [];
    for (const u of queue) {
      const du = dist.get(u);
      for (const v of adj.get(u)) {
        const l = hyp3(P[u * 3] - P[v * 3], P[u * 3 + 1] - P[v * 3 + 1], P[u * 3 + 2] - P[v * 3 + 2]);
        if (!dist.has(v) || du + l < dist.get(v) - 1e-6) { dist.set(v, du + l); next.push(v); }
      }
    }
    queue.length = 0; queue.push(...new Set(next));
  }
  for (let v = 0; v < raw.n; v++) {
    if (T[v * 4 + 2] !== 11) continue;
    const d = dist.has(v) ? dist.get(v) : range;
    T[v * 4 + 1] = Math.round(Math.min(1, d / range) * 254);
  }
}

/**
 * Two more beard shells (3 and 6 mm out along the normals, flags 64 / 128) on the near LODs, which the
 * shader thins into strands: the beard gets depth and a soft, fuzzy outline instead of a painted mask.
 */
function beardShells(c) {
  const raw = c.raw, T = raw.tex, I = raw.index;
  const OFF = [0.003, 0.006], FL = [64, 128];
  const vmap = new Map();             // base vertex -> index of its first new copy
  const add = [];                     // base vertices that get copies
  const per = [];                     // per LOD: base beard triangles
  for (let l = 0; l < c.lods.length; l++) {
    const L = c.lods[l], tris = [];
    if (l <= 1) {
      for (let t = L.start; t < L.start + L.count; t += 3) {
        const a = I[t], b = I[t + 1], d = I[t + 2];
        if (T[a * 4 + 2] !== 11 || (T[a * 4 + 3] & 2)) continue;
        tris.push(a, b, d);
        for (const v of [a, b, d]) if (!vmap.has(v)) { vmap.set(v, add.length); add.push(v); }
      }
    }
    per.push(tris);
  }
  if (!add.length) return;
  const n0 = raw.n, nAdd = add.length * OFF.length, n = n0 + nAdd;
  const grow = (A, k) => { const B = new A.constructor(n * k); B.set(A.subarray(0, n0 * k)); return B; };
  const pos = grow(raw.pos, 3), nrm = grow(raw.nrm, 4), uv = grow(raw.uv, 2), bi = grow(raw.bi, 4), bw = grow(raw.bw, 4), tex = grow(raw.tex, 4);
  for (let k = 0; k < OFF.length; k++) {
    for (let j = 0; j < add.length; j++) {
      const v = add[j], w = n0 + k * add.length + j;
      const nx = raw.nrm[v * 4] / 127, ny = raw.nrm[v * 4 + 1] / 127, nz = raw.nrm[v * 4 + 2] / 127;
      const l = hyp3(nx, ny, nz) || 1;
      for (let i = 0; i < 3; i++) pos[w * 3 + i] = raw.pos[v * 3 + i] + [nx, ny, nz][i] / l * OFF[k];
      for (let i = 0; i < 4; i++) { nrm[w * 4 + i] = raw.nrm[v * 4 + i]; bi[w * 4 + i] = raw.bi[v * 4 + i]; bw[w * 4 + i] = raw.bw[v * 4 + i]; tex[w * 4 + i] = raw.tex[v * 4 + i]; }
      tex[w * 4 + 3] |= FL[k];
      uv[w * 2] = raw.uv[v * 2]; uv[w * 2 + 1] = raw.uv[v * 2 + 1];
    }
  }
  // the index list again, each near LOD followed by its shells
  const extra = per.reduce((a, t) => a + t.length * OFF.length, 0);
  const idx = new Uint32Array(I.length + extra);
  let o = 0;
  for (let l = 0; l < c.lods.length; l++) {
    const L = c.lods[l], start = o;
    idx.set(I.subarray(L.start, L.start + L.count), o); o += L.count;
    for (let k = 0; k < OFF.length; k++) for (const v of per[l]) idx[o++] = n0 + k * add.length + vmap.get(v);
    c.lods[l] = { ...L, start, count: o - start };
  }
  Object.assign(raw, { n, pos, nrm, uv, bi, bw, tex, index: idx });
}

/**
 * Face landmarks (rest pose) for the per-person face shape (mh/shading.js hFaceWarp): the nose tip (the
 * frontmost skin on the midline between the eyes and the mouth), the mouth line and the chin (the lowest
 * front skin on the midline), and the head scale from the eyes' spacing -> c.face, or null.
 */
function faceMarks(c) {
  const raw = c.raw, T = raw.tex, P = raw.pos, e = c.info.eyeR;
  c.face = null;
  if (!e) return;
  const hk = Math.max(0.6, Math.abs(e[0]) * 2 / 0.064);
  let nz = Infinity, ny = 0, cy = Infinity, cz = 0;
  for (let v = 0; v < raw.n; v++) {
    if (T[v * 4 + 2] !== 0) continue;
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (Math.abs(x) > 0.008 * hk) continue;
    if (y < e[1] - 0.015 * hk && y > e[1] - 0.065 * hk && z < nz) { nz = z; ny = y; }
  }
  if (!(nz < Infinity)) return;
  for (let v = 0; v < raw.n; v++) {
    if (T[v * 4 + 2] !== 0) continue;
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    if (Math.abs(x) > 0.01 * hk || z > nz + 0.045 * hk || y > ny - 0.04 * hk || y < ny - 0.11 * hk) continue;
    if (y < cy) { cy = y; cz = z; }
  }
  if (!(cy < Infinity)) cy = ny - 0.075 * hk;
  // (the mouth line about two fifths of the way from the nose tip to the chin)
  c.face = { nose: [0, ny, nz], mouthY: ny + (cy - ny) * 0.42, chinY: cy, hk };
}

/** Eyeball radius (rest pose, m) from the eye vertices around the right eye's centre: c.eyeR. */
function eyeRadius(c) {
  const raw = c.raw, T = raw.tex, P = raw.pos, e = c.info.eyeR;
  c.eyeR = 0;
  if (!e) return;
  let s = 0, n = 0;
  const L0 = c.lods[0];
  for (let t = L0.start; t < L0.start + L0.count; t++) {
    const v = raw.index[t];
    if (T[v * 4 + 2] !== 4 || P[v * 3] < 0) continue;
    s += hyp3(P[v * 3] - e[0], P[v * 3 + 1] - e[1], P[v * 3 + 2] - e[2]); n++;
  }
  if (n > 8) c.eyeR = s / n;
}

/**
 * Eyebrows drawn on the skin: the line of the brow cards (both sides folded onto |x|): the centre
 * line y = a + b |x| + c x^2 (least squares over bins along the brow), the half height at its inner
 * and outer ends (t0, t1, widened a little: the card's painted brow fills most of it), its x range and
 * depth -> c.brow. The brow cards' triangles leave every LOD (the shader draws the brows).
 */
function browLine(c) {
  const raw = c.raw, T = raw.tex, P = raw.pos, I = raw.index;
  const L0 = c.lods[0];
  const pts = [];
  const seen = new Uint8Array(raw.n);
  for (let t = L0.start; t < L0.start + L0.count; t++) {
    const v = I[t];
    if (T[v * 4 + 2] !== 2 || (T[v * 4 + 3] & 2) || seen[v]) continue;
    seen[v] = 1;
    pts.push([Math.abs(P[v * 3]), P[v * 3 + 1], P[v * 3 + 2]]);
  }
  c.brow = null;
  if (pts.length < 12) return;
  let x0 = Infinity, x1 = -Infinity, z = 0;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z += p[2]; }
  z /= pts.length;
  const NB = 8, bins = Array.from({ length: NB }, () => ({ lo: Infinity, hi: -Infinity }));
  for (const p of pts) {
    const b = Math.min(NB - 1, Math.floor(((p[0] - x0) / Math.max(1e-4, x1 - x0)) * NB));
    bins[b].lo = Math.min(bins[b].lo, p[1]); bins[b].hi = Math.max(bins[b].hi, p[1]);
  }
  // least squares y = a + b x + c x^2 through the bins' centres, and a linear half height
  const S = new Float64Array(9), R = new Float64Array(3);
  let tw = 0, ta = 0, tb = 0, tx = 0, txx = 0;
  for (let i = 0; i < NB; i++) {
    const B = bins[i];
    if (B.hi < B.lo) continue;
    const x = x0 + ((i + 0.5) / NB) * (x1 - x0), y = 0.5 * (B.lo + B.hi), h = 0.5 * (B.hi - B.lo);
    const f = [1, x, x * x];
    for (let r = 0; r < 3; r++) { R[r] += f[r] * y; for (let q = 0; q < 3; q++) S[r * 3 + q] += f[r] * f[q]; }
    tw++; ta += h; tb += h * x; tx += x; txx += x * x;
  }
  if (tw < 4) return;
  const m = new THREE.Matrix3().fromArray(Array.from(S)).invert().toArray();
  const a = m[0] * R[0] + m[3] * R[1] + m[6] * R[2], b = m[1] * R[0] + m[4] * R[1] + m[7] * R[2], cc = m[2] * R[0] + m[5] * R[1] + m[8] * R[2];
  const den = tw * txx - tx * tx;
  const k1 = den !== 0 ? (tw * tb - tx * ta) / den : 0, k0 = (ta - k1 * tx) / tw;
  // (the strip is a little taller than the painted brow; brows 6-10 mm tall at the head, 3 mm at the tail)
  const hs = c.info.H / 1.76;
  // (fuller than the cards' painted line: a real brow is a band of hairs about a centimetre tall at its head)
  const t0 = THREE.MathUtils.clamp((k0 + k1 * x0) * 1.5, 0.0046 * hs, 0.0072 * hs);
  const t1 = THREE.MathUtils.clamp((k0 + k1 * x1) * 1.25, 0.0026 * hs, 0.004 * hs);
  c.brow = { x0, x1, a, b, c: cc, t0, t1, z };
  // the brow cards leave every LOD
  for (let l = 0; l < c.lods.length; l++) {
    const L = c.lods[l];
    let w = L.start;
    for (let t = L.start; t < L.start + L.count; t += 3) {
      if (T[I[t] * 4 + 2] === 2) continue;
      I[w] = I[t]; I[w + 1] = I[t + 1]; I[w + 2] = I[t + 2]; w += 3;
    }
    for (let t = w; t < L.start + L.count; t++) I[t] = I[w - 1] ?? 0;
    c.lods[l] = { ...L, count: w - L.start };
  }
}

/**
 * Beard strand shells (cast feature beardBase): copies of the beard base's vertices, one per shell, the
 * shell's index in flags bits 4-7 (h = index / 15: the vertex shader grows it out along the normal by
 * h x the beard's length there, uv.x). LOD 0 gets up to 15 shells (fewer for a short beard), LOD 1
 * three, LOD 2 one; the base itself (and its back faces) is not drawn.
 */
function beardShellsFromBase(c) {
  const raw = c.raw, T = raw.tex, I = raw.index, UV = raw.uv;
  let maxLen = 0;
  for (let v = 0; v < raw.n; v++) if (T[v * 4 + 2] === 11) maxLen = Math.max(maxLen, (UV[v * 2] / 65535) * 0.04);
  const per = [], used = new Map(), list = [];
  // shells per LOD (indices 1..15)
  const nS = Math.max(4, Math.min(15, Math.round(maxLen * 100 * 6)));
  const sets = [[], [5, 10, 15], [10], []];
  for (let k = 1; k <= nS; k++) sets[0].push(Math.round((k / nS) * 15));
  for (let l = 0; l < c.lods.length; l++) {
    const L = c.lods[l], tris = [];
    for (let t = L.start; t < L.start + L.count; t += 3) {
      const a = I[t];
      if (T[a * 4 + 2] !== 11 || (T[a * 4 + 3] & 2)) continue;
      tris.push(I[t], I[t + 1], I[t + 2]);
      for (let k = 0; k < 3; k++) if (!used.has(I[t + k])) { used.set(I[t + k], list.length); list.push(I[t + k]); }
    }
    per.push(tris);
  }
  if (!list.length) return;
  const shells = [...new Set(sets.flat())].sort((x, y) => x - y);
  const sIndex = new Map(shells.map((s, i) => [s, i]));
  const n0 = raw.n, n = n0 + list.length * shells.length;
  const grow = (A, k) => { const B = new A.constructor(n * k); B.set(A.subarray(0, n0 * k)); return B; };
  const pos = grow(raw.pos, 3), nrm = grow(raw.nrm, 4), uv = grow(raw.uv, 2), bi = grow(raw.bi, 4), bw = grow(raw.bw, 4), tex = grow(raw.tex, 4);
  for (let si = 0; si < shells.length; si++) {
    for (let j = 0; j < list.length; j++) {
      const v = list[j], w = n0 + si * list.length + j;
      for (let i = 0; i < 3; i++) pos[w * 3 + i] = raw.pos[v * 3 + i];
      for (let i = 0; i < 4; i++) { nrm[w * 4 + i] = raw.nrm[v * 4 + i]; bi[w * 4 + i] = raw.bi[v * 4 + i]; bw[w * 4 + i] = raw.bw[v * 4 + i]; tex[w * 4 + i] = raw.tex[v * 4 + i]; }
      tex[w * 4 + 3] = (raw.tex[v * 4 + 3] & 15) | (shells[si] << 4);
      uv[w * 2] = raw.uv[v * 2]; uv[w * 2 + 1] = raw.uv[v * 2 + 1];
    }
  }
  // the index list again: each LOD without its beard base, followed by its shells (outermost last)
  let extra = 0;
  for (let l = 0; l < c.lods.length; l++) extra += per[l].length * sets[l].length;
  const idx = new Uint32Array(I.length + extra);
  let o = 0;
  for (let l = 0; l < c.lods.length; l++) {
    const L = c.lods[l], start = o;
    for (let t = L.start; t < L.start + L.count; t += 3) {
      if (T[I[t] * 4 + 2] === 11) continue;
      idx[o++] = I[t]; idx[o++] = I[t + 1]; idx[o++] = I[t + 2];
    }
    for (const s of sets[l]) {
      const base = n0 + sIndex.get(s) * list.length;
      for (const v of per[l]) idx[o++] = base + used.get(v);
    }
    c.lods[l] = { ...L, start, count: o - start };
  }
  Object.assign(raw, { n, pos, nrm, uv, bi, bw, tex, index: idx.subarray(0, o) });
}

/**
 * A hat's band height and brim radius about the head's vertical axis (rest pose), for the shader's
 * brim shadow on the face: c.hat = {band, rb} or null.
 */
function hatBrim(c) {
  const raw = c.raw, T = raw.tex, P = raw.pos;
  const hc = c.info.headC || c.skeleton.joints[5];
  const ys = [];
  for (let v = 0; v < raw.n; v++) if (T[v * 4 + 2] === 10) ys.push(P[v * 3 + 1]);
  c.hat = null;
  if (ys.length < 20) return;
  ys.sort((a, b) => a - b);
  const band = ys[Math.floor(ys.length * 0.08)];
  let rb = 0;
  for (let v = 0; v < raw.n; v++) {
    if (T[v * 4 + 2] !== 10 || P[v * 3 + 1] > band + 0.03) continue;
    rb = Math.max(rb, hyp2(P[v * 3] - hc[0], P[v * 3 + 2] - hc[2]));
  }
  // (the brim's height over the face: its front edge, which may sit higher or lower than the band)
  const fy = [];
  for (let v = 0; v < raw.n; v++) {
    if (T[v * 4 + 2] !== 10) continue;
    const dx = P[v * 3] - hc[0], dz = P[v * 3 + 2] - hc[2];
    if (dz < -0.5 * rb && hyp2(dx, dz) > 0.8 * rb) fy.push(P[v * 3 + 1]);
  }
  fy.sort((a, b) => a - b);
  c.hat = { band: fy.length ? fy[Math.floor(fy.length * 0.5)] : band, rb };
}

/**
 * The clips a character plays (baked at init; any other is baked on first use): toddlers ride in
 * strollers (their two seated clips); everyone else walks, stands and sits, the elderly with their own
 * walks and long skirts with theirs.
 */
function clipsFor(c) {
  const cls = c.ageClass;
  const bot = c.outfit && c.outfit.bottom;
  const longSkirt = !!bot && bot.suit === 'female_elegantsuit01' && bot.cut === 'skirt' && (bot.length ?? 0) > 0.5;
  return (ci) => {
    const n = CLIPS[ci].name;
    if (cls === 'toddler') return n === 'sitStroller' || n === 'lieBaby' || n === 'idle';
    if (n === 'sitStroller' || n === 'lieBaby') return false;
    if (n === 'walkOld' || n === 'walkSenior') return cls === 'old';
    if (n === 'walkSkirt') return longSkirt;
    return true;
  };
}

/** Idle clip cycle (s): the talking idle has its own, longer, cycle. */
function idlePeriod(v) { return CLIPS[CLIP.idle + v] && CLIPS[CLIP.idle + v].frames > 64 ? 12 : 9.5; }

const PHONE_BONES = [BONE.armR, BONE.foreR, BONE.handR, BONE.neck, BONE.head];
const STOOP_BONES = [BONE.spine2, BONE.neck, BONE.head, BONE.clavL, BONE.armL, BONE.foreL, BONE.handL,
  BONE.clavR, BONE.armR, BONE.foreR, BONE.handR];
const HEAD_BONES = [BONE.neck, BONE.head];
const LEAN_BONES = [BONE.spine1, ...STOOP_BONES];
const CARRY_BONES = [BONE.armR, BONE.foreR, BONE.handR];
const LARM_BONES = [BONE.armL, BONE.foreL, BONE.handL];
// (left arm held out by a shoulder bag: angle, and per standing stance whether it applies)
const BAG_ARM_ANGLE = 4.5 * Math.PI / 180;
const BAG_ARM_OUT = [1, 1, 0, 0, 0, 0, 1, 1];
const _rot = new Float64Array(4), _ang = new Float64Array(1);     // (axis and angle for rotBones: passed in an array, not as boxed floats)
const IDENT34 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const _T = new Float32Array(12), _inv = new Float32Array(12), _tmp = new Float32Array(12);

/** C = A * B for 3x4 affine matrices (row-major, implicit last row 0 0 0 1). */
function mul34(A, ao, B2, bo, C, co) {
  for (let r = 0; r < 3; r++) {
    const a0 = A[ao + r * 4], a1 = A[ao + r * 4 + 1], a2 = A[ao + r * 4 + 2], a3 = A[ao + r * 4 + 3];
    for (let c = 0; c < 4; c++) {
      C[co + r * 4 + c] = a0 * B2[bo + c] + a1 * B2[bo + 4 + c] + a2 * B2[bo + 8 + c] + (c === 3 ? a3 : 0);
    }
  }
}

/** Inverse of a 3x4 affine matrix whose 3x3 part is a rotation (skin matrices of the rig). */
function invRigid34(A, ao, out) {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 4 + c] = A[ao + c * 4 + r];
  for (let r = 0; r < 3; r++) out[r * 4 + 3] = -(out[r * 4] * A[ao + 3] + out[r * 4 + 1] * A[ao + 7] + out[r * 4 + 2] * A[ao + 11]);
}

/** Replace (or blend towards) bones of M with those of pose F, re-parented onto M's chest. */
function overrideBones(M, F, bones, w) {
  const c = BONE.spine2 * 12;
  invRigid34(F, c, _inv);
  mul34(M, c, _inv, 0, _T, 0);            // walking chest * inverse(source chest)
  for (const b of bones) {
    const o = b * 12;
    mul34(_T, 0, F, o, _tmp, 0);
    for (let k = 0; k < 12; k++) M[o + k] += (_tmp[k] - M[o + k]) * w;
  }
}

/**
 * Linear blends of rotation matrices shrink (and shear) the bones. Re-orthonormalise each
 * bone's 3x3 part and re-solve its translation so the bone's joint stays where the blend put it.
 */
function rigidify(M, rest) {
  for (let b = 0; b < NUM_BONES; b++) {
    const o = b * 12, j = rest[b];
    // blended joint position (what the linear blend got right)
    const px = M[o] * j.x + M[o + 1] * j.y + M[o + 2] * j.z + M[o + 3];
    const py = M[o + 4] * j.x + M[o + 5] * j.y + M[o + 6] * j.z + M[o + 7];
    const pz = M[o + 8] * j.x + M[o + 9] * j.y + M[o + 10] * j.z + M[o + 11];
    // columns c0, c1 of the 3x3 part: Gram-Schmidt, c2 = c0 x c1
    // (Math.sqrt, never Math.hypot: the latter boxes its arguments on every call)
    let ax = M[o], ay = M[o + 4], az = M[o + 8];
    let l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    ax /= l; ay /= l; az /= l;
    let bx = M[o + 1], by = M[o + 5], bz = M[o + 9];
    const d = ax * bx + ay * by + az * bz;
    bx -= ax * d; by -= ay * d; bz -= az * d;
    l = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
    bx /= l; by /= l; bz /= l;
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    M[o] = ax; M[o + 4] = ay; M[o + 8] = az;
    M[o + 1] = bx; M[o + 5] = by; M[o + 9] = bz;
    M[o + 2] = cx; M[o + 6] = cy; M[o + 10] = cz;
    M[o + 3] = px - (ax * j.x + bx * j.y + cx * j.z);
    M[o + 7] = py - (ay * j.x + by * j.y + cy * j.z);
    M[o + 11] = pz - (az * j.x + bz * j.y + cz * j.z);
  }
}

function newSlot() {
  return { x: 0, y: -1000, z: 0, heading: 0, speed: 0, phase: 0, pose: 1, look: 0, appearance: null, visible: false, a: null,
    lod: -1, inView: false, blendFrame: -10, blendBase: null, model: null,     // model: pose before the figure transform
    posePrev: -1, fromM: null, fadeT0: 0, fadeDur: 0, seatW: 0, fromSeat: 0, phoneW: 0, fromPhone: 0, phoneOn: false,
    cupW: 0, fromCup: 0, cupOn: false,
    pocketW: 0, fromPocket: 0, prop: 0, propSeed: 0, leanIn: NaN, steerIn: NaN, mob: null, sc: 0.5,
    holdWith: -1, hold: null, comp: false, babySlot: -1, idleIn: -1, idleShown: -1, outfit: 0, tableIn: 1,
    fillR: 0, fillG: 0, fillB: 0, shade: 1 };
}

/**
 * Float RGBA data texture. With `rows`, an update uploads only the first userData.rows rows
 * (the posed figures are packed there): the image height is lowered for the upload and
 * restored right after it. The first upload always allocates the full height.
 */
function dataTexture(data, w, h, rows) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  if (!rows) {
    // until the first (full) upload has happened, partial update ranges must not be used
    t.userData.fresh = true;
    t.onUpdate = () => { t.userData.fresh = false; };
  } else {
    let allocated = false;
    t.onUpdate = () => { t.image.height = h; allocated = true; };
    Object.defineProperty(t.userData, 'rows', {
      set(n) { if (allocated) t.image.height = Math.max(1, Math.min(h, n)); },
      get() { return t.image.height; },
    });
  }
  return t;
}

/** Accumulate w * clip(time) (frames linearly interpolated) into M. */
function addClip(M, bk, clip, time, w) {
  if (!bk.ready[clip]) bakeClip(bk, clip);
  const n = bk.frames[clip];
  const f = (((time % 1) + 1) % 1) * n;
  const fi = Math.floor(f);
  const i0 = fi % n, i1 = (i0 + 1) % n, ft = f - fi;
  const o0 = (bk.offsets[clip] + i0) * MAT_N, o1 = (bk.offsets[clip] + i1) * MAT_N;
  const w0 = w * (1 - ft), w1 = w * ft;
  const D = bk.data;
  for (let k = 0; k < MAT_N; k++) M[k] += D[o0 + k] * w0 + D[o1 + k] * w1;
}

/** Which clips play at a speed: walk clips bracket the body-normalised speed, slow walking blends into standing. */
function gaitBlend(B, a, idleVar) {
  // (speed and scale in _gaitIn: float arguments to a call that is not inlined are boxed)
  const vb = _gaitIn[0] / Math.sqrt(Math.max(0.3, _gaitIn[1]));
  const V = B.walkV;
  const out = _gait;
  const idle = CLIP.idle + idleVar;         // standing still in pose 0 is the same as pose 1
  out.a = CLIP.walk; out.b = -1; out.wa = 1; out.wb = 0; out.idle = 0; out.extra = 1;
  if (a.walkOld || a.gait === 1 || a.longSkirt) {
    // frail and senior walkers, and women in ankle-length skirts (shorter steps, a low heel lift
    // so the trailing leg does not kick into the hem): one clip of their own; faster walking only
    // quickens the steps (stretching the stride without the clip would slide the planted foot)
    const c = a.walkOld ? CLIP.walkOld : a.longSkirt ? CLIP.walkSkirt : CLIP.walkSenior;
    out.a = c;
    const w = smooth01((vb - 0.08) / 0.4);
    if (w < 1) { out.b = idle; out.wa = w; out.wb = 1 - w; out.idle = 1; }
    return out;
  }
  const v0 = V[CLIP.walkSlow], v1 = V[CLIP.walk], v2 = V[CLIP.walkBrisk], v3 = V[CLIP.walkFast];
  if (vb < v0) {
    const w = smooth01((vb - 0.06) / (v0 * 0.8));
    out.a = CLIP.walkSlow; out.wa = w; out.b = idle; out.wb = 1 - w; out.idle = w < 1 ? 1 : 0;
  } else if (vb < v1) {
    const w = (vb - v0) / (v1 - v0);
    out.a = CLIP.walkSlow; out.wa = 1 - w; out.b = CLIP.walk; out.wb = w;
  } else if (vb < v2) {
    const w = (vb - v1) / (v2 - v1);
    out.a = CLIP.walk; out.wa = 1 - w; out.b = CLIP.walkBrisk; out.wb = w;
  } else if (vb < v3) {
    const w = (vb - v2) / (v3 - v2);
    out.a = CLIP.walkBrisk; out.wa = 1 - w; out.b = CLIP.walkFast; out.wb = w;
  } else {
    out.a = CLIP.walkFast; out.extra = Math.min(1.25, (vb / v3) ** 0.5);
  }
  return out;
}

function smooth01(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }

/** Pitch bones (3x4 matrices of M) about the lateral axis of pivot bone p through its posed joint (A[0]: angle, < 0: forward). */
function pitchBones(M, rest, bones, p, A) {
  const ang = A[0];
  const k = p * 12, r = rest[p];
  const px = M[k] * r.x + M[k + 1] * r.y + M[k + 2] * r.z + M[k + 3];
  const py = M[k + 4] * r.x + M[k + 5] * r.y + M[k + 6] * r.z + M[k + 7];
  const pz = M[k + 8] * r.x + M[k + 9] * r.y + M[k + 10] * r.z + M[k + 11];
  let ax = M[k], ay = M[k + 4], az = M[k + 8];
  const l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  ax /= l; ay /= l; az /= l;
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  const R00 = t * ax * ax + c, R01 = t * ax * ay - s * az, R02 = t * ax * az + s * ay;
  const R10 = t * ax * ay + s * az, R11 = t * ay * ay + c, R12 = t * ay * az - s * ax;
  const R20 = t * ax * az - s * ay, R21 = t * ay * az + s * ax, R22 = t * az * az + c;
  for (let bi = 0; bi < bones.length; bi++) {
    const o = bones[bi] * 12;
    for (let col = 0; col < 3; col++) {
      const x = M[o + col], y = M[o + 4 + col], z = M[o + 8 + col];
      M[o + col] = R00 * x + R01 * y + R02 * z;
      M[o + 4 + col] = R10 * x + R11 * y + R12 * z;
      M[o + 8 + col] = R20 * x + R21 * y + R22 * z;
    }
    const x = M[o + 3] - px, y = M[o + 7] - py, z = M[o + 11] - pz;
    M[o + 3] = R00 * x + R01 * y + R02 * z + px;
    M[o + 7] = R10 * x + R11 * y + R12 * z + py;
    M[o + 11] = R20 * x + R21 * y + R22 * z + pz;
  }
}

/** Rotate bones (3x4 matrices of M) about the unit-ish axis (ax, ay, az) through pivot bone p's posed joint. */
function rotBones(M, rest, bones, p, R) {
  let ax = R[0], ay = R[1], az = R[2];
  const ang = R[3];
  const k = p * 12, r = rest[p];
  const px = M[k] * r.x + M[k + 1] * r.y + M[k + 2] * r.z + M[k + 3];
  const py = M[k + 4] * r.x + M[k + 5] * r.y + M[k + 6] * r.z + M[k + 7];
  const pz = M[k + 8] * r.x + M[k + 9] * r.y + M[k + 10] * r.z + M[k + 11];
  const l = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
  ax /= l; ay /= l; az /= l;
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  const R00 = t * ax * ax + c, R01 = t * ax * ay - s * az, R02 = t * ax * az + s * ay;
  const R10 = t * ax * ay + s * az, R11 = t * ay * ay + c, R12 = t * ay * az - s * ax;
  const R20 = t * ax * az - s * ay, R21 = t * ay * az + s * ax, R22 = t * az * az + c;
  for (let bi = 0; bi < bones.length; bi++) {
    const o = bones[bi] * 12;
    for (let col = 0; col < 3; col++) {
      const x = M[o + col], y = M[o + 4 + col], z = M[o + 8 + col];
      M[o + col] = R00 * x + R01 * y + R02 * z;
      M[o + 4 + col] = R10 * x + R11 * y + R12 * z;
      M[o + 8 + col] = R20 * x + R21 * y + R22 * z;
    }
    const x = M[o + 3] - px, y = M[o + 7] - py, z = M[o + 11] - pz;
    M[o + 3] = R00 * x + R01 * y + R02 * z + px;
    M[o + 7] = R10 * x + R11 * y + R12 * z + py;
    M[o + 11] = R20 * x + R21 * y + R22 * z + pz;
  }
}

/** Rotate bone b's 3x4 matrix about the vertical through pivot bone p's posed joint by A[0]. */
function rotateBoneY(M, rest, b, p, A) {
  const ang = A[0];
  const k = p * 12, r = rest[p];
  const px = M[k] * r.x + M[k + 1] * r.y + M[k + 2] * r.z + M[k + 3];
  const pz = M[k + 8] * r.x + M[k + 9] * r.y + M[k + 10] * r.z + M[k + 11];
  const c = Math.cos(ang), s = Math.sin(ang);
  const o = b * 12;
  for (let col = 0; col < 4; col++) {
    const x = M[o + col], z = M[o + 8 + col];
    M[o + col] = c * x + s * z;
    M[o + 8 + col] = -s * x + c * z;
  }
  // keep the pivot fixed
  M[o + 3] += px - (c * px + s * pz);
  M[o + 11] += pz - (-s * px + c * pz);
}

export default humans;
