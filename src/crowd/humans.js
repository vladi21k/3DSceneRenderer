import * as THREE from 'three';
import { loadHumanAssets } from './humans/assets.js';
import { Rig, bakeClips, CLIPS, CLIP, NUM_BONES, BONE, SEAT_HEIGHT } from './humans/anim.js';
import { deriveAppearance, writeRow, ROW_TEXELS } from './humans/appearance.js';
import { makeHumanMaterials, hangProfile, BONE_DYN } from './humans/material.js';
import { makeSkirtPart, makePhonePart, appendPart, partRanges, subGeometry } from './humans/parts.js';
import { BlobShadows } from './humans/blobs.js';
import { HumansTest } from './humans/test.js';

// Human figures: rendering + animation (crowd behaviour lives in crowd.js).
// Contract (docs/ARCHITECTURE.md):
//   alloc(count) -> first slot index; set(i, {x,y,z,heading,speed,phase,pose,look,appearance,visible});
//   setVisible(i, false); strideLength(appearance, speed); heightOf(appearance)
//
// Figures are SDF-sculpted bodies (tools/blender/humans_build.py) with LODs, drawn with
// one instanced draw per base body (male / female / child) and LOD (the nearest LODs one
// draw per worn part). Each frame the CPU blends baked clips per visible figure (cross-fading
// pose changes, keeping every bone rigid), adds the head turn, folds in the figure's
// transform and writes 22 bone matrices plus a little per-frame state into a row of a float
// texture; visible figures are packed into the first rows so only those are uploaded. The
// vertex shader skins from it. Clothing, skin and hair are shaded per fragment from a
// per-figure "look" row (appearance.js).
// Testing: humanstest=1 (humans/test.js); humans_dir=<dir> loads a trial asset build;
// humans_dbg=1|2|3 shows baked occlusion / aux attributes / garment ease instead of shading.

const BASES = ['male', 'female', 'child'];
// figure height on screen (px) above which each LOD is used, by number of LODs in the asset
const LOD_PX = { 4: [300, 84, 26], 5: [480, 200, 84, 26] };
const SKIRT_GRID = { 4: [[48, 22], [20, 10], [10, 5], [8, 3]], 5: [[48, 22], [28, 14], [16, 8], [10, 5], [8, 3]] };
const BONE_W = BONE_DYN + 2;              // texels per bone row: 22 bones x 3x4 matrix, then 2 state texels
const MAT_N = NUM_BONES * 12;
const SKIRT_ID = 250;                     // part id of the runtime skirt / coat shell
const PHONE_ID = 251;                     // part id of the runtime phone
const SPLIT_LODS = 2;                     // the nearest LODs draw body and each worn part separately
const FADE = { stand: 0.75, sit: 1.0 };   // pose cross-fade times (s): folding the arms or raising a phone takes a moment
const _frustum = new THREE.Frustum();
const _m = new THREE.Matrix4();
const _sph = new THREE.Sphere();
const _gait = { a: 0, b: -1, wa: 1, wb: 0, idle: 0, extra: 1, phone: 0 };

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
  rowSlot: new Int32Array(0),

  async init(app) {
    this.app = app;
    let assets;
    try {
      // humans_dir=<repo-relative dir> loads a trial build instead of assets/humans/ (testing)
      const dir = app.params.str('humans_dir', 'assets/humans').replace(/^\/+|\/+$/g, '');
      assets = await loadHumanAssets(new URL(`../../${dir}/`, import.meta.url).href);
    } catch (e) {
      console.warn('[humans] figure assets unavailable, figures disabled', e);
      return;
    }
    this.parts = { ...(assets.meta.parts || {}), skirt: SKIRT_ID, phone: PHONE_ID };
    this.morphScale = assets.meta.morphScale;
    this.shapeScale = assets.meta.shapeScale || [0, 0, 0, 0];
    this.ensureCapacity(Math.max(512, this.used));

    // rigs + baked motion per base body
    this.bases = {};
    for (const name of BASES) {
      const b = assets.bases[name];
      if (!b) continue;
      const rig = new Rig(b.skeleton, b.info);
      const baked = bakeClips(rig);
      const walkV = CLIPS.map((c) => (c.kind === 'walk' ? rig.walkParams(c).v : 0));
      // single frames used to re-pose the upper body while walking (phone, carried bag)
      const frame = (clip, f) => baked.data.slice((baked.offsets[clip] + f) * MAT_N, (baked.offsets[clip] + f + 1) * MAT_N);
      const phone = frame(CLIP.idlePhone, 0), hang = frame(CLIP.idle, 0);
      this.bases[name] = { name, info: b.info, rig, baked, walkV, lods: b.lods, phone, hang };
    }
    if (!Object.keys(this.bases).length) return;
    this.nLod = Math.min(...Object.values(this.bases).map((B) => B.lods.length));
    this.lodPx = LOD_PX[this.nLod] || LOD_PX[4];
    const grid = SKIRT_GRID[this.nLod] || SKIRT_GRID[4];

    this.group = new THREE.Group();
    this.group.name = 'humans';
    app.scene.add(this.group);
    for (const B of Object.values(this.bases)) {
      const hang = hangProfile(B.lods[0], B.info);
      const { mat, depth, uniforms } = makeHumanMaterials(B, this.parts, this.boneTex, this.lookTex, this.morphScale, this.shapeScale, hang,
        app.params.num('humans_dbg', 0));
      app.materials.register('humans.' + B.name, mat);
      app.materials.track(mat);
      B.mat = mat;
      B.uniforms = uniforms;
      // draws: near LODs get one draw per part (sharing buffers through draw ranges) so a
      // figure only submits its own hair / hat / bag; far LODs draw everything merged and
      // the vertex shader collapses the parts the figure does not wear
      B.draws = [];
      B.drawAt = [];
      const phonePart = makePhonePart(B.rig, B.info, PHONE_ID);
      for (let li = 0; li < this.nLod; li++) {
        const [nt, nr] = grid[Math.min(li, grid.length - 1)];
        let g = appendPart(B.lods[li], makeSkirtPart(nt, nr, SKIRT_ID));
        if (li < this.nLod - 1) g = appendPart(g, phonePart);
        const byPart = new Map();
        if (li < SPLIT_LODS) {
          for (const [pid, r] of partRanges(g)) byPart.set(pid, this._addDraw(B, subGeometry(g, r.start, r.count), mat, depth, `${li}.p${pid}`));
        } else {
          const d = this._addDraw(B, g, mat, depth, `${li}`);
          // the farthest figures (a few pixels tall) get a soft ground blob instead (BlobShadows)
          d.mesh.castShadow = li < this.nLod - 1;
          byPart.set(-1, d);
        }
        B.drawAt.push(byPart);
      }
    }
    this.blobs = new BlobShadows(app, this.capacity);
    this.group.add(this.blobs.mesh);
    this.ready = true;
    if (app.params.num('humanstest', 0)) this.test = new HumansTest(app, this);
  },

  _addDraw(B, g, mat, depth, tag) {
    g.setAttribute('iRow', newRowAttr(this.capacity));
    g.instanceCount = 0;
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `humans.${B.name}.lod${tag}`;
    mesh.frustumCulled = true;        // bounds are refit to the instances every frame
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = depth;
    mesh.visible = false;
    this.group.add(mesh);
    const d = { mesh, list: new Int32Array(this.capacity), count: 0 };
    B.draws.push(d);
    return d;
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
    let S = st[g.a] * g.wa + (g.b >= 0 && g.b < CLIP.idle ? st[g.b] * g.wb : 0);
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
    const look = new Float32Array(cap * ROW_TEXELS * 4);
    if (this.lookTex) look.set(this.lookTex.image.data);
    const old = [this.boneTex, this.lookTex];
    this.boneTex = dataTexture(new Float32Array(cap * BONE_W * 4), BONE_W, cap, true);
    this.lookTex = dataTexture(look, ROW_TEXELS, cap, false);
    this.capacity = cap;
    this.rowSlot = new Int32Array(cap);
    for (const B of Object.values(this.bases || {})) {
      if (B.uniforms) { B.uniforms.uBoneTex.value = this.boneTex; B.uniforms.uLookTex.value = this.lookTex; }
      for (const d of B.draws || []) { d.mesh.geometry.setAttribute('iRow', newRowAttr(cap)); d.list = new Int32Array(cap); }
    }
    if (this.blobs) this.blobs.ensureCapacity(cap);
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
    for (const B of Object.values(this.bases)) for (const d of B.draws) d.count = 0;
    const bones = this.boneTex.image.data;
    const look = this.lookTex;
    const maxLod = this.nLod - 1;
    const lodPx = this.lodPx;
    this.blobs.begin();
    let lookDirty = false, n = 0;
    for (let i = 0; i < this.used; i++) {
      const s = this.slots[i];
      if (!s.visible || s.appearance === null) continue;
      if (!s.a) {
        s.a = this.appearanceOf(s.appearance);
        writeRow(look.image.data, i, s.a);
        s.bagHidden = false;
        s.posePrev = -1;               // a new person in this slot: no cross-fade from the last one
        if (!look.userData.fresh) look.addUpdateRange(i * ROW_TEXELS * 4, ROW_TEXELS * 4);
        lookDirty = true;
      }
      const a = s.a;
      // seated people put their bags down (bags would hover behind the chair)
      const hideBag = s.pose === 2 && a.bagPart > 0;
      if (hideBag !== s.bagHidden) {
        look.image.data[(i * ROW_TEXELS + 11) * 4 + 3] = (hideBag ? 0 : a.bagPart) + a.skirtPart * 256;
        s.bagHidden = hideBag;
        if (!look.userData.fresh) look.addUpdateRange((i * ROW_TEXELS + 11) * 4, 4);
        lookDirty = true;
      }
      const B = this.bases[a.base];
      const sc = a.height / B.info.H;
      _sph.center.set(s.x, s.y + 0.5 * a.height, s.z);
      _sph.radius = 0.62 * a.height + 0.3;
      if (!_frustum.intersectsSphere(_sph)) { s.lod = -1; continue; }
      const px = (a.height / Math.max(0.5, _sph.center.distanceTo(camPos))) * pxPerM;
      let lod = 0;
      while (lod < lodPx.length && px <= lodPx[lod]) lod++;
      lod = Math.min(lod, maxLod);
      if (s.lod >= 0 && lod !== s.lod) {      // hysteresis against flicker at the thresholds
        const edge = lodPx[Math.min(lod, s.lod)];
        if (Math.abs(px - edge) < edge * 0.08) lod = s.lod;
      }
      s.lod = lod;
      const row = n++;
      this.rowSlot[row] = i;
      this._pose(row, i, s, a, B, sc, bones);
      const at = B.drawAt[lod];
      const all = at.get(-1);
      if (all) all.list[all.count++] = row;
      else {
        pushDraw(at.get(0), row);
        if (a.hairPart) pushDraw(at.get(a.hairPart), row);
        if (a.beardPart) pushDraw(at.get(a.beardPart), row);
        if (a.hatPart) pushDraw(at.get(a.hatPart), row);
        if (a.bagPart && !s.bagHidden) pushDraw(at.get(a.bagPart), row);
        if (a.skirtPart) pushDraw(at.get(a.skirtPart), row);
        if (a.glasses && this.parts.glasses) pushDraw(at.get(this.parts.glasses), row);
        if (s.phoneOn) pushDraw(at.get(PHONE_ID), row);
      }
      if (lod === maxLod) this.blobs.add(s.x, s.y, s.z, a.height);
    }
    for (const B of Object.values(this.bases)) {
      B.draws.forEach(({ mesh, list: L, count: cnt }) => {
        const g = mesh.geometry;
        const attr = g.attributes.iRow;
        // bounds of this draw's instances, so shadow cascades can skip it entirely
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let k = 0; k < cnt; k++) {
          const s = this.slots[this.rowSlot[L[k]]];
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
    this.blobs.end(app);
    // only the rows of this frame's figures are uploaded (see dataTexture)
    if (n > 0) {
      this.boneTex.userData.rows = n;
      this.boneTex.needsUpdate = true;
    }
    if (lookDirty) look.needsUpdate = true;
    this.perf.figures = n;
    this.perf.ms = this.perf.ms * 0.95 + (performance.now() - t0) * 0.05;
  },

  /** Blend the figure's pose and write bone row `row` (model -> world) plus its state texels. */
  _pose(row, i, s, a, B, sc, out) {
    // small far figures re-blend their clips every other frame (staggered); the
    // transform below is still applied every frame so camera motion stays exact
    const M = s.model || (s.model = new Float32Array(MAT_N));
    const frame = this.app.frame;
    if (s.pose !== s.posePrev || s.lod < 2 || ((frame + i) & 1) === 0 || s.blendFrame < frame - 2 || s.blendBase !== B) {
      this._blend(s, a, B, sc, M);
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
    // state texels: gait phase, speed, seated blend, ground height | look row, phone shown, hands in pockets
    const o = base + BONE_DYN * 4;
    out[o] = s.phase; out[o + 1] = s.pose === 0 ? s.speed : 0; out[o + 2] = s.seatW; out[o + 3] = s.y;
    out[o + 4] = i; out[o + 5] = s.phoneOn ? 1 : 0; out[o + 6] = s.pocketW; out[o + 7] = 0;
  },

  _blend(s, a, B, sc, M) {
    const bk = B.baked;
    const t = this.time;
    // pose changes cross-fade from a snapshot of the last displayed pose
    if (s.pose !== s.posePrev) {
      if (s.posePrev >= 0 && s.blendBase === B) {
        s.fromM = s.fromM || new Float32Array(MAT_N);
        s.fromM.set(M);
        s.fadeT0 = t;
        s.fadeDur = s.pose === 2 || s.posePrev === 2 ? FADE.sit : FADE.stand;
        s.fromPhone = s.phoneW;
        s.fromPocket = s.pocketW;
        s.fromSeat = s.seatW;
      } else {
        s.fadeDur = 0;
      }
      s.posePrev = s.pose;
    }
    M.fill(0);
    let phone = 0, pocket = 0;
    if (s.pose === 2) {
      addClip(M, bk, CLIP.sit + a.sit, t / 11 + a.seedT, 1);
    } else if (s.pose === 1) {
      addClip(M, bk, CLIP.idle + a.idle, t / 9.5 + a.seedT, 1);
      phone = a.idle === 1 ? 1 : 0;
      pocket = a.idle === 3 ? 1 : 0;
    } else {
      const g = gaitBlend(B, a, s.speed, sc);
      addClip(M, bk, g.a, s.phase, g.wa);
      if (g.b >= 0 && g.wb > 0.001) addClip(M, bk, g.b, g.b >= CLIP.idle ? t / 9.5 + a.seedT : s.phase, g.wb);
      // upper-body variations carried by the walking chest
      if (a.phoneWalk) { overrideBones(M, B.phone, PHONE_BONES, 1); phone = 1; }
      else if (a.carry) overrideBones(M, B.hang, CARRY_BONES, 0.65);
      else if (a.idle === 1 && g.b >= CLIP.idle) phone = g.wb;
      if (a.idle === 3 && g.b >= CLIP.idle) pocket = g.wb;
    }
    rigidify(M, B.rig.rest);
    let w = 1;
    if (s.fadeDur > 0) {
      w = smooth01((t - s.fadeT0) / s.fadeDur);
      if (w < 1) {
        const F = s.fromM;
        for (let k = 0; k < MAT_N; k++) M[k] = F[k] + (M[k] - F[k]) * w;
        rigidify(M, B.rig.rest);
        phone = s.fromPhone + (phone - s.fromPhone) * w;
        pocket = s.fromPocket + (pocket - s.fromPocket) * w;
      } else s.fadeDur = 0;
    }
    s.phoneW = phone;
    s.pocketW = pocket;
    s.phoneOn = phone > 0.5;
    const seat = s.pose === 2 ? 1 : 0;
    s.seatW = s.fadeDur > 0 ? s.fromSeat + (seat - s.fromSeat) * w : seat;
    // head turn: the neck takes a third, the head the rest, both about their own joints
    const look = Math.max(-1.25, Math.min(1.25, s.look || 0));
    if (look > 1e-3 || look < -1e-3) {
      rotateBoneY(M, B.rig.rest, BONE.neck, BONE.neck, look * 0.35);
      rotateBoneY(M, B.rig.rest, BONE.head, BONE.neck, look * 0.35);
      rotateBoneY(M, B.rig.rest, BONE.head, BONE.head, look * 0.65);
    }
  },

  /** Submitted geometry for the main pass (draws, instances, triangles), for profiling. */
  stats() {
    let draws = 0, inst = 0, tris = 0;
    const lods = new Array(this.nLod || 0).fill(0);
    for (const s of this.slots) if (s.visible && s.lod >= 0 && s.a) lods[s.lod]++;
    for (const B of Object.values(this.bases || {})) {
      for (const d of B.draws) {
        if (!d.count) continue;
        draws++;
        inst += d.count;
        const g = d.mesh.geometry;
        tris += d.count * Math.min(g.drawRange.count, g.index.count) / 3;
      }
    }
    return { draws, instances: inst, triangles: Math.round(tris), figures: this.perf.figures, lods,
      blobs: this.blobs ? this.blobs.count : 0, cpuMs: +this.perf.ms.toFixed(3) };
  },

  dispose() {},
};

function pushDraw(d, i) { if (d) d.list[d.count++] = i; }

const PHONE_BONES = [BONE.armR, BONE.foreR, BONE.handR, BONE.neck, BONE.head];
const CARRY_BONES = [BONE.armR, BONE.foreR, BONE.handR];
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
    let ax = M[o], ay = M[o + 4], az = M[o + 8];
    let l = Math.hypot(ax, ay, az) || 1;
    ax /= l; ay /= l; az /= l;
    let bx = M[o + 1], by = M[o + 5], bz = M[o + 9];
    const d = ax * bx + ay * by + az * bz;
    bx -= ax * d; by -= ay * d; bz -= az * d;
    l = Math.hypot(bx, by, bz) || 1;
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
    lod: -1, blendFrame: -10, blendBase: null, model: null, bagHidden: false,     // model: pose before the figure transform
    posePrev: -1, fromM: null, fadeT0: 0, fadeDur: 0, seatW: 0, fromSeat: 0, phoneW: 0, fromPhone: 0, phoneOn: false,
    pocketW: 0, fromPocket: 0 };
}

function newRowAttr(n) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  a.setUsage(THREE.DynamicDrawUsage);
  return a;
}

/**
 * Float RGBA data texture. With `rows`, an update uploads only the first userData.rows rows
 * (the visible figures are packed there): the image height is lowered for the upload and
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
  const idle = CLIP.idle + a.idle;          // standing still in pose 0 is the same as pose 1
  out.a = CLIP.walk; out.b = -1; out.wa = 1; out.wb = 0; out.idle = 0; out.extra = 1;
  if (a.walkOld) {
    out.a = CLIP.walkOld;
    const w = smooth01((vb - 0.08) / 0.4);
    if (w < 1) { out.b = idle; out.wa = w; out.wb = 1 - w; out.idle = 1; }
    out.extra = Math.max(1, vb / V[CLIP.walkOld]) ** 0.5;
    return out;
  }
  const v0 = V[CLIP.walkSlow], v1 = V[CLIP.walk], v2 = V[CLIP.walkBrisk];
  if (vb < v0) {
    const w = smooth01((vb - 0.06) / (v0 * 0.8));
    out.a = CLIP.walkSlow; out.wa = w; out.b = idle; out.wb = 1 - w; out.idle = w < 1 ? 1 : 0;
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
