import * as THREE from 'three';
import { loadHumanAssets } from './humans/assets.js';
import { Rig, bakeClips, CLIPS, CLIP, NUM_BONES, BONE, SEAT_HEIGHT } from './humans/anim.js';
import { deriveAppearance, writeRow, ROW_TEXELS } from './humans/appearance.js';
import { makeHumanMaterials } from './humans/material.js';
import { makeSkirtPart, appendPart } from './humans/parts.js';
import { HumansTest } from './humans/test.js';

// Human figures: rendering + animation (crowd behaviour lives in crowd.js).
// Contract (docs/ARCHITECTURE.md):
//   alloc(count) -> first slot index; set(i, {x,y,z,heading,speed,phase,pose,look,appearance,visible});
//   setVisible(i, false); strideLength(appearance, speed); heightOf(appearance)
//
// Figures are SDF-sculpted bodies (tools/blender/humans_build.py) in three LODs, drawn
// with one instanced draw per base body (male / female / child) and LOD. Each frame the
// CPU blends two baked clips per visible figure, adds the head turn, folds in the
// figure's transform and writes 22 bone matrices into a float texture row; the vertex
// shader skins from it. Clothing, skin and hair are shaded per fragment from a
// per-figure "look" row (appearance.js).

const BASES = ['male', 'female', 'child'];
const LOD_PX = [270, 72];          // figure height on screen (px) above which LOD0 / LOD1 are used
const BONE_W = NUM_BONES * 3;      // texels per bone row
const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _sph = new THREE.Sphere();

const humans = {
  name: 'humans',
  capacity: 0,
  used: 0,
  ready: false,

  async init(app) {
    this.app = app;
    this.cache = new Map();
    this.slots = [];
    this.parts = {};
    this.time = 0;
    const url = new URL('../../assets/humans/', import.meta.url).href;
    let assets;
    try {
      assets = await loadHumanAssets(url);
    } catch (e) {
      console.warn('[humans] figure assets unavailable, figures disabled', e);
      return;
    }
    const meta = assets.meta;
    this.parts = { ...(meta.parts || {}), skirt: 250 };   // the skirt shell is generated at runtime
    this.morphScale = meta.morphScale;
    this.ensureCapacity(512);

    // rigs + baked motion per base body
    this.bases = {};
    let animRows = 0;
    for (const name of BASES) {
      const b = assets.bases[name];
      if (!b) continue;
      const rig = new Rig(b.skeleton, b.info);
      const baked = bakeClips(rig);
      const walkV = CLIPS.map((c) => (c.kind === 'walk' ? rig.walkParams(c).v : 0));
      this.bases[name] = { info: b.info, rig, baked, walkV, lods: b.lods, meshes: [] };
      animRows += baked.total;
    }
    void animRows;
    if (!Object.keys(this.bases).length) return;

    // shared GPU state
    this.group = new THREE.Group();
    this.group.name = 'humans';
    app.scene.add(this.group);
    const skirtId = this.parts.skirt;
    for (const [name, B] of Object.entries(this.bases)) {
      const { mat, depth, uniforms } = makeHumanMaterials(B, { ...this.parts, skirt: skirtId }, this.boneTex, this.lookTex, this.morphScale);
      app.materials.register('humans.' + name, mat);
      app.materials.track(mat);
      B.mat = mat;
      B.uniforms = uniforms;
      B.lods.forEach((geo, li) => {
        const g = appendPart(geo, makeSkirtPart([48, 20, 10][li], [22, 10, 5][li], skirtId));
        const iRow = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity), 1);
        iRow.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('iRow', iRow);
        g.instanceCount = 0;
        const mesh = new THREE.Mesh(g, mat);
        mesh.name = `humans.${name}.lod${li}`;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.customDepthMaterial = depth;
        mesh.visible = false;
        mesh.userData.count = 0;
        this.group.add(mesh);
        B.meshes.push(mesh);
      });
    }
    this.ready = true;
    if (app.params.num('humanstest', 0)) this.test = new HumansTest(app, this);
  },

  // ------------------------------------------------------------------ contract API

  ensureCapacity(n) {
    if (n <= this.capacity) return;
    const cap = Math.max(64, 1 << Math.ceil(Math.log2(n)));
    const bones = new Float32Array(cap * BONE_W * 4);
    const look = new Float32Array(cap * ROW_TEXELS * 4);
    if (this.boneTex) {
      bones.set(this.boneTex.image.data);
      look.set(this.lookTex.image.data);
    }
    const mk = (data, w) => {
      const t = new THREE.DataTexture(data, w, cap, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    const oldB = this.boneTex, oldL = this.lookTex;
    this.boneTex = mk(bones, BONE_W);
    this.lookTex = mk(look, ROW_TEXELS);
    this.capacity = cap;
    for (const B of Object.values(this.bases || {})) {
      if (B.uniforms) { B.uniforms.uBoneTex.value = this.boneTex; B.uniforms.uLookTex.value = this.lookTex; }
      for (const m of B.meshes) {
        const iRow = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
        iRow.setUsage(THREE.DynamicDrawUsage);
        m.geometry.setAttribute('iRow', iRow);
      }
    }
    oldB && oldB.dispose();
    oldL && oldL.dispose();
  },

  /** Reserve `count` figure slots; returns the first slot index. */
  alloc(count) {
    const first = this.used;
    this.used += count;
    for (let i = first; i < this.used; i++) this.slots.push(newSlot());
    if (this.ready || this.boneTex) this.ensureCapacity(this.used);
    return first;
  },

  set(i, o) {
    const s = this.slots[i];
    if (!s) return;
    if (o.x !== undefined) { s.x = o.x; s.y = o.y; s.z = o.z; }
    if (o.heading !== undefined) s.heading = o.heading;
    if (o.speed !== undefined) s.speed = o.speed;
    if (o.phase !== undefined) s.phase = o.phase;
    if (o.pose !== undefined) s.pose = o.pose;
    if (o.look !== undefined) s.look = o.look;
    if (o.appearance !== undefined && o.appearance !== s.appearance) {
      s.appearance = o.appearance;
      s.look_ = null;
    }
    s.visible = o.visible !== false;
  },

  setVisible(i, v) { const s = this.slots[i]; if (s) s.visible = !!v; },

  appearanceOf(seed) {
    let a = this.cache.get(seed);
    if (!a) {
      if (this.cache.size > 6000) this.cache.clear();
      a = deriveAppearance(seed, this.parts);
      if (!this.bases || !this.bases[a.base]) a.base = 'male';
      this.cache.set(seed, a);
    }
    return a;
  },

  heightOf(appearance) { return this.appearanceOf(appearance).height; },

  /** Distance covered per gait cycle (two steps) at `speed` m/s, so phase advances without foot slide. */
  strideLength(appearance, speed) {
    const a = this.appearanceOf(appearance);
    const B = this.bases && this.bases[a.base];
    if (!B) return 1.48 * (0.55 + 0.32 * speed);
    const sc = a.height / B.info.H;
    const g = gaitBlend(B, a, speed, sc);
    const st = B.baked.strides;
    let S = st[g.a] * g.wa + (g.b >= 0 ? st[g.b] * g.wb : 0);
    if (g.idle > 0) S = st[g.a] * (0.55 + 0.45 * g.wa);
    return Math.max(0.3, S * sc * g.extra);
  },

  // ------------------------------------------------------------------ per frame

  update(dt, app) {
    if (!this.ready) return;
    this.time += dt;
    if (this.test) this.test.update(dt);
    const cam = app.camera;
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_m);
    const camPos = cam.position;
    const pxPerRad = (app.renderer.domElement.height || 1080) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    const lists = {};
    for (const name of Object.keys(this.bases)) lists[name] = [[], [], []];
    const bones = this.boneTex.image.data;
    let lookDirty = false;
    for (let i = 0; i < this.used; i++) {
      const s = this.slots[i];
      if (!s.visible || s.appearance === null) continue;
      if (!s.look_) {
        s.look_ = this.appearanceOf(s.appearance);
        writeRow(this.lookTex.image.data, i, s.look_);
        lookDirty = true;
      }
      const a = s.look_;
      const B = this.bases[a.base];
      const sc = a.height / B.info.H;
      _sph.center.set(s.x, s.y + 0.9 * a.height / 1.76, s.z);
      _sph.radius = 1.1 * sc + 0.4;
      if (!_frustum.intersectsSphere(_sph)) continue;
      const dist = Math.max(0.5, _sph.center.distanceTo(camPos));
      const px = (a.height / dist) * pxPerRad;
      // LOD with a little hysteresis
      const prev = s.lod;
      let lod = px > LOD_PX[0] ? 0 : px > LOD_PX[1] ? 1 : 2;
      if (prev >= 0 && lod !== prev) {
        const edge = lod < prev ? LOD_PX[lod] : LOD_PX[prev];
        if (Math.abs(px - edge) < edge * 0.08) lod = prev;
      }
      s.lod = lod;
      this._pose(i, s, a, B, sc, bones);
      lists[a.base][lod].push(i);
    }
    for (const [name, B] of Object.entries(this.bases)) {
      B.meshes.forEach((mesh, li) => {
        const L = lists[name][li];
        const g = mesh.geometry;
        const attr = g.attributes.iRow;
        for (let k = 0; k < L.length; k++) attr.array[k] = L[k];
        g.instanceCount = L.length;
        mesh.visible = L.length > 0;
        if (L.length) { attr.clearUpdateRanges(); attr.addUpdateRange(0, L.length); attr.needsUpdate = true; }
      });
    }
    this.boneTex.needsUpdate = true;
    if (lookDirty) this.lookTex.needsUpdate = true;
  },

  /** Blend the baked clips for one figure and write its bone row (model -> world). */
  _pose(i, s, a, B, sc, out) {
    const bk = B.baked;
    const t = this.time;
    const seedT = (a.seed % 997) / 997;
    let src;
    if (s.pose === 2) {
      src = [[CLIP.sit + a.sit, (t / 11 + seedT) % 1, 1]];
    } else if (s.pose === 1) {
      src = [[CLIP.idle + a.idle, (t / 9.5 + seedT) % 1, 1]];
    } else {
      const g = gaitBlend(B, a, s.speed, sc);
      src = [[g.a, s.phase, g.wa]];
      if (g.b >= 0 && g.wb > 0.001) src.push([g.b, g.b >= CLIP.idle ? (t / 9.5 + seedT) % 1 : s.phase, g.wb]);
    }
    const M = this._mat || (this._mat = new Float32Array(NUM_BONES * 12));
    M.fill(0);
    for (const [clip, time, w] of src) {
      const n = bk.frames[clip];
      const f = (((time % 1) + 1) % 1) * n;
      const i0 = Math.floor(f) % n, i1 = (i0 + 1) % n, ft = f - Math.floor(f);
      const o0 = (bk.offsets[clip] + i0) * NUM_BONES * 12, o1 = (bk.offsets[clip] + i1) * NUM_BONES * 12;
      const w0 = w * (1 - ft), w1 = w * ft;
      const D = bk.data;
      for (let k = 0; k < NUM_BONES * 12; k++) M[k] += D[o0 + k] * w0 + D[o1 + k] * w1;
    }
    // head turn: neck takes a third, head the rest, both about their joints
    const look = Math.max(-1.25, Math.min(1.25, s.look || 0));
    if (Math.abs(look) > 1e-3) {
      rotateBonesY(M, B.rig.rest, [BONE.neck, BONE.head], BONE.neck, look * 0.35);
      rotateBonesY(M, B.rig.rest, [BONE.head], BONE.head, look * 0.65);
    }
    // instance transform: T(x, y, z) * Ry(heading) * S(sc)
    const c = Math.cos(s.heading) * sc, sn = Math.sin(s.heading) * sc;
    let y0 = s.y;
    if (s.pose === 2) y0 += SEAT_HEIGHT * (1 - sc);
    const base = i * BONE_W * 4;
    for (let b = 0; b < NUM_BONES; b++) {
      const k = b * 12, o = base + b * 12;
      for (let col = 0; col < 4; col++) {
        const m0 = M[k + col], m1 = M[k + 4 + col], m2 = M[k + 8 + col];
        out[o + col] = c * m0 + sn * m2 + (col === 3 ? s.x : 0);
        out[o + 4 + col] = sc * m1 + (col === 3 ? y0 : 0);
        out[o + 8 + col] = -sn * m0 + c * m2 + (col === 3 ? s.z : 0);
      }
    }
  },

  dispose() {},
};

function newSlot() {
  return { x: 0, y: -1000, z: 0, heading: 0, speed: 0, phase: 0, pose: 1, look: 0, appearance: null, visible: false, look_: null, lod: -1 };
}

/** Which clips play at a speed: walk clips bracket the body-normalised speed, slow walking blends into standing. */
function gaitBlend(B, a, speed, sc) {
  const vb = speed / Math.sqrt(Math.max(0.3, sc));
  const V = B.walkV;
  const out = { a: CLIP.walk, b: -1, wa: 1, wb: 0, idle: 0, extra: 1 };
  if (a.walkOld) {
    out.a = CLIP.walkOld;
    const w = smooth01((vb - 0.08) / 0.4);
    if (w < 1) { out.b = CLIP.idle; out.wa = w; out.wb = 1 - w; out.idle = 1; }
    out.extra = Math.max(1, vb / V[CLIP.walkOld]) ** 0.5;
    return out;
  }
  const v0 = V[CLIP.walkSlow], v1 = V[CLIP.walk], v2 = V[CLIP.walkBrisk];
  if (vb < v0) {
    const w = smooth01((vb - 0.06) / (v0 * 0.8));
    out.a = CLIP.walkSlow; out.wa = w; out.b = CLIP.idle; out.wb = 1 - w; out.idle = w < 1 ? 1 : 0;
  } else if (vb < v1) {
    const w = (vb - v0) / (v1 - v0);
    out.a = CLIP.walkSlow; out.wa = 1 - w; out.b = CLIP.walk; out.wb = w;
  } else if (vb < v2) {
    const w = (vb - v1) / (v2 - v1);
    out.a = CLIP.walk; out.wa = 1 - w; out.b = CLIP.walkBrisk; out.wb = w;
  } else {
    out.a = CLIP.walkBrisk; out.extra = Math.min(1.25, (vb / v2) ** 0.5);
  }
  return out;
}

function smooth01(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }

/** Rotate the given bones' 3x4 matrices about the vertical through `pivotBone`'s posed joint. */
function rotateBonesY(M, rest, bones, pivotBone, ang) {
  const k = pivotBone * 12, r = rest[pivotBone];
  const px = M[k] * r.x + M[k + 1] * r.y + M[k + 2] * r.z + M[k + 3];
  const pz = M[k + 8] * r.x + M[k + 9] * r.y + M[k + 10] * r.z + M[k + 11];
  const c = Math.cos(ang), s = Math.sin(ang);
  for (const b of bones) {
    const o = b * 12;
    for (let col = 0; col < 4; col++) {
      const x = M[o + col] - (col === 3 ? px : 0), z = M[o + 8 + col] - (col === 3 ? pz : 0);
      M[o + col] = c * x + s * z + (col === 3 ? px : 0);
      M[o + 8 + col] = -s * x + c * z + (col === 3 ? pz : 0);
    }
  }
}

export default humans;
