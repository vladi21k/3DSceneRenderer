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
// Figures are SDF-sculpted bodies (tools/blender/humans_build.py) with LODs, drawn with
// one instanced draw per base body (male / female / child) and LOD. Each frame the CPU
// blends two baked clips per visible figure, adds the head turn, folds in the figure's
// transform and writes 22 bone matrices into a float texture row; the vertex shader
// skins from it. Clothing, skin and hair are shaded per fragment from a per-figure
// "look" row (appearance.js).

const BASES = ['male', 'female', 'child'];
const LOD_PX = [270, 72, 26];             // figure height on screen (px) above which LOD 0 / 1 / 2 are used
const SKIRT_GRID = [[48, 22], [20, 10], [10, 5], [8, 3]];
const BONE_W = NUM_BONES * 3;             // texels per bone row (3x4 matrix per bone)
const MAT_N = NUM_BONES * 12;
const SKIRT_ID = 250;                     // part id of the runtime skirt / coat shell
const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _sph = new THREE.Sphere();
const _gait = { a: 0, b: -1, wa: 1, wb: 0, idle: 0, extra: 1 };
const _mat = new Float32Array(MAT_N);

const humans = {
  name: 'humans',
  capacity: 0,
  used: 0,
  ready: false,
  slots: [],
  cache: new Map(),
  parts: {},
  time: 0,
  perf: { ms: 0, figures: 0 },

  async init(app) {
    this.app = app;
    let assets;
    try {
      assets = await loadHumanAssets(new URL('../../assets/humans/', import.meta.url).href);
    } catch (e) {
      console.warn('[humans] figure assets unavailable, figures disabled', e);
      return;
    }
    this.parts = { ...(assets.meta.parts || {}), skirt: SKIRT_ID };
    this.morphScale = assets.meta.morphScale;
    this.ensureCapacity(Math.max(512, this.used));

    // rigs + baked motion per base body
    this.bases = {};
    for (const name of BASES) {
      const b = assets.bases[name];
      if (!b) continue;
      const rig = new Rig(b.skeleton, b.info);
      const baked = bakeClips(rig);
      const walkV = CLIPS.map((c) => (c.kind === 'walk' ? rig.walkParams(c).v : 0));
      this.bases[name] = { name, info: b.info, rig, baked, walkV, lods: b.lods, meshes: [] };
    }
    if (!Object.keys(this.bases).length) return;
    this.nLod = Math.min(...Object.values(this.bases).map((B) => B.lods.length));

    this.group = new THREE.Group();
    this.group.name = 'humans';
    app.scene.add(this.group);
    for (const B of Object.values(this.bases)) {
      const { mat, depth, uniforms } = makeHumanMaterials(B, this.parts, this.boneTex, this.lookTex, this.morphScale);
      app.materials.register('humans.' + B.name, mat);
      app.materials.track(mat);
      B.mat = mat;
      B.uniforms = uniforms;
      for (let li = 0; li < this.nLod; li++) {
        const [nt, nr] = SKIRT_GRID[Math.min(li, SKIRT_GRID.length - 1)];
        const g = appendPart(B.lods[li], makeSkirtPart(nt, nr, SKIRT_ID));
        g.setAttribute('iRow', newRowAttr(this.capacity));
        g.instanceCount = 0;
        const mesh = new THREE.Mesh(g, mat);
        mesh.name = `humans.${B.name}.lod${li}`;
        mesh.frustumCulled = true;        // bounds are refit to the instances every frame
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.customDepthMaterial = depth;
        mesh.visible = false;
        this.group.add(mesh);
        B.meshes.push(mesh);
      }
      B.lists = B.meshes.map(() => new Int32Array(this.capacity));
      B.counts = new Int32Array(this.nLod);
    }
    this.ready = true;
    if (app.params.num('humanstest', 0)) this.test = new HumansTest(app, this);
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
    if (o.x !== undefined) { s.x = o.x; s.y = o.y; s.z = o.z; }
    if (o.heading !== undefined) s.heading = o.heading;
    if (o.speed !== undefined) s.speed = o.speed;
    if (o.phase !== undefined) s.phase = o.phase;
    if (o.pose !== undefined) s.pose = o.pose;
    if (o.look !== undefined) s.look = o.look;
    if (o.appearance !== undefined && o.appearance !== s.appearance) {
      s.appearance = o.appearance;
      s.a = null;
    }
    s.visible = o.visible !== false;
  },

  setVisible(i, v) { const s = this.slots[i]; if (s) s.visible = !!v; },

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

  appearanceOf(seed) {
    let a = this.cache.get(seed);
    if (!a) {
      if (this.cache.size > 6000) this.cache.clear();
      a = deriveAppearance(seed, this.parts);
      if (this.bases && !this.bases[a.base]) a.base = 'male';
      a.seedT = (seed % 997) / 997;
      this.cache.set(seed, a);
    }
    return a;
  },

  ensureCapacity(n) {
    if (n <= this.capacity) return;
    const cap = Math.max(64, 1 << Math.ceil(Math.log2(n)));
    const bones = new Float32Array(cap * BONE_W * 4);
    const look = new Float32Array(cap * ROW_TEXELS * 4);
    if (this.boneTex) { bones.set(this.boneTex.image.data); look.set(this.lookTex.image.data); }
    const old = [this.boneTex, this.lookTex];
    this.boneTex = dataTexture(bones, BONE_W, cap);
    this.lookTex = dataTexture(look, ROW_TEXELS, cap);
    this.capacity = cap;
    for (const B of Object.values(this.bases || {})) {
      if (B.uniforms) { B.uniforms.uBoneTex.value = this.boneTex; B.uniforms.uLookTex.value = this.lookTex; }
      for (const m of B.meshes) m.geometry.setAttribute('iRow', newRowAttr(cap));
      B.lists = B.meshes.map(() => new Int32Array(cap));
    }
    old.forEach((t) => t && t.dispose());
  },

  // ------------------------------------------------------------------ per frame

  update(dt, app) {
    if (!this.ready) return;
    const t0 = performance.now();
    this.time += dt;
    if (this.test) this.test.update(dt);
    const cam = app.camera;
    _m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_m);
    const camPos = cam.position;
    const pxPerM = (app.renderer.domElement.height || 1080) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    for (const B of Object.values(this.bases)) B.counts.fill(0);
    const bones = this.boneTex.image.data;
    const maxLod = this.nLod - 1;
    let lookDirty = false, n = 0;
    for (let i = 0; i < this.used; i++) {
      const s = this.slots[i];
      if (!s.visible || s.appearance === null) continue;
      if (!s.a) {
        s.a = this.appearanceOf(s.appearance);
        writeRow(this.lookTex.image.data, i, s.a);
        lookDirty = true;
      }
      const a = s.a;
      const B = this.bases[a.base];
      const sc = a.height / B.info.H;
      _sph.center.set(s.x, s.y + 0.5 * a.height, s.z);
      _sph.radius = 0.62 * a.height + 0.3;
      if (!_frustum.intersectsSphere(_sph)) continue;
      const px = (a.height / Math.max(0.5, _sph.center.distanceTo(camPos))) * pxPerM;
      let lod = px > LOD_PX[0] ? 0 : px > LOD_PX[1] ? 1 : px > LOD_PX[2] ? 2 : 3;
      if (s.lod >= 0 && lod !== s.lod) {      // hysteresis against flicker at the thresholds
        const edge = LOD_PX[Math.min(lod, s.lod)];
        if (Math.abs(px - edge) < edge * 0.08) lod = s.lod;
      }
      s.lod = lod;
      this._pose(i, s, a, B, sc, bones);
      const l = Math.min(lod, maxLod);
      B.lists[l][B.counts[l]++] = i;
      n++;
    }
    for (const B of Object.values(this.bases)) {
      B.meshes.forEach((mesh, li) => {
        const L = B.lists[li], cnt = B.counts[li];
        const g = mesh.geometry;
        const attr = g.attributes.iRow;
        // bounds of this draw's instances, so shadow cascades can skip it entirely
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let k = 0; k < cnt; k++) {
          const s = this.slots[L[k]];
          attr.array[k] = L[k];
          if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
          if (s.y < y0) y0 = s.y; if (s.y > y1) y1 = s.y;
          if (s.z < z0) z0 = s.z; if (s.z > z1) z1 = s.z;
        }
        g.instanceCount = cnt;
        mesh.visible = cnt > 0;
        if (cnt) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, cnt);
          attr.needsUpdate = true;
          g.boundingSphere.center.set((x0 + x1) / 2, (y0 + y1) / 2 + 0.9, (z0 + z1) / 2);
          g.boundingSphere.radius = 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0) + 1.3;
        }
      });
    }
    this.boneTex.needsUpdate = true;
    if (lookDirty) this.lookTex.needsUpdate = true;
    this.perf.figures = n;
    this.perf.ms = this.perf.ms * 0.95 + (performance.now() - t0) * 0.05;
  },

  /** Blend the baked clips for one figure and write its bone row (model -> world). */
  _pose(i, s, a, B, sc, out) {
    const bk = B.baked;
    const t = this.time;
    const M = _mat;
    M.fill(0);
    if (s.pose === 2) {
      addClip(M, bk, CLIP.sit + a.sit, t / 11 + a.seedT, 1);
    } else if (s.pose === 1) {
      addClip(M, bk, CLIP.idle + a.idle, t / 9.5 + a.seedT, 1);
    } else {
      const g = gaitBlend(B, a, s.speed, sc);
      addClip(M, bk, g.a, s.phase, g.wa);
      if (g.b >= 0 && g.wb > 0.001) addClip(M, bk, g.b, g.b >= CLIP.idle ? t / 9.5 + a.seedT : s.phase, g.wb);
    }
    // head turn: the neck takes a third, the head the rest, both about their own joints
    const look = Math.max(-1.25, Math.min(1.25, s.look || 0));
    if (look > 1e-3 || look < -1e-3) {
      rotateBoneY(M, B.rig.rest, BONE.neck, BONE.neck, look * 0.35);
      rotateBoneY(M, B.rig.rest, BONE.head, BONE.neck, look * 0.35);
      rotateBoneY(M, B.rig.rest, BONE.head, BONE.head, look * 0.65);
    }
    // figure transform: T(x, y, z) * Ry(heading) * S(sc); seated figures keep the seat height
    const c = Math.cos(s.heading) * sc, sn = Math.sin(s.heading) * sc;
    const y0 = s.pose === 2 ? s.y + SEAT_HEIGHT * (1 - sc) : s.y;
    const base = i * BONE_W * 4;
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
  },

  dispose() {},
};

function newSlot() {
  return { x: 0, y: -1000, z: 0, heading: 0, speed: 0, phase: 0, pose: 1, look: 0, appearance: null, visible: false, a: null, lod: -1 };
}

function newRowAttr(n) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

function dataTexture(data, w, h) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Accumulate w * clip(time) (frames linearly interpolated) into M. */
function addClip(M, bk, clip, time, w) {
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
function gaitBlend(B, a, speed, sc) {
  const vb = speed / Math.sqrt(Math.max(0.3, sc));
  const V = B.walkV;
  const out = _gait;
  out.a = CLIP.walk; out.b = -1; out.wa = 1; out.wb = 0; out.idle = 0; out.extra = 1;
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

/** Rotate bone b's 3x4 matrix about the vertical through pivot bone p's posed joint. */
function rotateBoneY(M, rest, b, p, ang) {
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
