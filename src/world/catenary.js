import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { U } from '../core/uniforms.js';
import { disposeObject } from './streaming.js';
import { buildPoleKit, ARM_Y } from './catenary/poleKit.js';
import { planOverhead, buildOverheadChunk, buildInsulatorGeometry, buildClampGeometry, buildArmGeometry } from './catenary/overhead.js';
import { patchThin, makeWireMaterial, makeGlassMaterial, patchBanner, updateScreenUniforms, LAMP_RADIANCE, SU } from './catenary/shaders.js';
import { buildBannerBracket, buildBannerCloth, buildBannerAtlas, BANNER_DESIGNS, BANNER_X0, BANNER_X1, BANNER_Y0, BANNER_Y1 } from './catenary/banners.js';
import { buildSignalKit, signalPlacements, buildAspectAtlas, MOUNT_X } from './catenary/signals.js';
import { buildStickers, buildStickerAtlas } from './catenary/wear.js';
import { CatBatch, CatBatches, SlotBatch, NEAR, FAR } from './catenary/batch.js';
import { createLampGlow } from './catenary/glow.js';

// Lamp standards, overhead contact line, pole banners and traffic signals.
// Contract: docs/ARCHITECTURE.md. Placements come from layout.poles (pole pairs are kept
// out of cross-street mouths by the layout) and layout.crossStreets.
//
// Everything is instanced street-wide (catenary/batch.js: one multi-draw call per part
// and pass): standards, banners, fittings and signals as instances of shared geometry;
// each chunk's wire ribbons (every wire plus the ribbon stand-ins of the fittings) and
// merged stickers in geometry slots of their own batches.
// Each standard draws the hi, mid, lo or far (outline) tessellation by its camera
// distance (far chunks: far); near chunks show the fittings instead of their stand-ins.
// Brackets, scrolls and wires are thin casters; shafts stop casting in the coarsest
// cascade. Everything heavy is built once in init().
//
// Lit lanterns get a soft aureole (catenary/glow.js), one instanced draw round the camera.
//
// Debug URL switches: catslots=0 keeps per-chunk wire and sticker meshes; catglow=0 turns
// the lantern aureoles off.

// detail by distance (m at the 17° default lens, scaled by the field of view so it
// follows the size on screen): hi / mid / lo standards below these, far beyond (per
// standard); fittings instead of their ribbon stand-ins, per chunk (near edge)
const LEVEL_DIST = [12, 60, 140], FIT_DIST = 55, REF_FOV = 17;
const PAINT = [0.125, 0.152, 0.148]; // linear albedo of the grey-green satin paint
const BASE_R = 0.215;         // radius of the cast base of a standard
const DEG = Math.PI / 180;
// pedestrian lights: red while a tram is within RED_DIST m of the crossing (or RED_SEC s
// away at its speed) or over it, flashing green for BLINK_SEC s before that, green otherwise
const RED_DIST = 60, RED_SEC = 8, BLINK_SEC = 3, CLEAR_M = 4, TRAM_LEN = 32;
const PED_DARK = 0.03;        // brightness of an unlit aspect (instance colour)
const PED_NAMES = ['red', 'flash', 'green'];
const _on = new THREE.Color(1, 1, 1), _off = new THREE.Color(PED_DARK, PED_DARK, PED_DARK);

const _y = new THREE.Vector3(0, 1, 0);
const _t = new THREE.Matrix4(), _r = new THREE.Matrix4().makeRotationY(Math.PI);
const _c = new THREE.Color();
const _lvd = new Float64Array(LEVEL_DIST.length);
const _dir = new THREE.Vector3();

const catenary = {
  name: 'catenary',

  async init(app) {
    const { materials: M, layout, route } = app;
    this.app = app;
    this.kit = buildPoleKit();
    this.insSpanGeo = buildInsulatorGeometry({ L: 0.3, sheds: 3, R: [0.026, 0.022] });
    this.insDropGeo = buildInsulatorGeometry({ L: 0.2, sheds: 3, R: [0.024, 0.021] });
    this.clampGeo = buildClampGeometry();
    this.armGeo = buildArmGeometry();
    this.bracketGeo = buildBannerBracket();
    this.clothGeo = buildBannerCloth();
    this.signalKit = buildSignalKit();
    this.live = new Set(); // full-detail chunks: hi / mid switch
    this.lampRadiance = LAMP_RADIANCE;
    this.lampOn = 0;

    // multisampled frame (post on med / high): thin parts use alpha-to-coverage
    const post = app.systems.post;
    const msaa = !!(post && !post.disabled && post.q && post.q.msaa > 0);

    // ---- materials: library ones where they exist, own ones registered (and so tracked)
    // Own variant of the pole paint (unique key) so the thin-part patch stays private. The
    // baked vertex colours carry AO and grime around 1; the paint colour is the material
    // colour and the per-pole variation the instance colour.
    this.poleMat = patchThin(M.get('metal.pole', { vertexColors: true, catenaryPaint: true, color: PAINT, roughness: 0.5 }), { coverage: msaa });
    this.glassMat = makeGlassMaterial(M);
    this.wireMat = M.register('catenary.wire', makeWireMaterial(msaa));
    this.insulatorMat = M.register('catenary.insulator', patchThin(new THREE.MeshStandardMaterial({ color: 0x5f5c58, roughness: 0.45, metalness: 0.0, vertexColors: true }), { weather: false }));
    this.fittingMat = patchThin(M.get('metal.galvanized', { vertexColors: true, catenaryFitting: true }), { weather: false });
    this.bannerMat = M.register('catenary.banner', patchBanner(new THREE.MeshPhysicalMaterial({
      map: buildBannerAtlas(layout.seed), roughness: 0.82, metalness: 0, sheen: 0.4, sheenRoughness: 0.6, sheenColor: 0xd8d2c8, side: THREE.DoubleSide,
    }), [BANNER_X1 - BANNER_X0, BANNER_Y1 - BANNER_Y0], BANNER_DESIGNS));
    this.signalMat = M.register('catenary.signalBody', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide }));
    this.stickerMat = M.register('catenary.sticker', new THREE.MeshStandardMaterial({ map: buildStickerAtlas(layout.seed), vertexColors: true, roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    // LED aspects: about 0.55 scene units (~18,000 cd/m²) by day, dimmed at night (update)
    this.aspectMat = M.register('catenary.signalAspect', new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.2, metalness: 0, emissive: 0xffffff, emissiveMap: buildAspectAtlas(), emissiveIntensity: 0.55 }));
    // the instance colour dims an aspect that is off (pedestrian lights); chained after
    // any hook the lighting set on registration
    {
      const m = this.aspectMat, prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey ? m.customProgramCacheKey.bind(m) : null;
      m.onBeforeCompile = (shader, renderer) => {
        if (prev) prev.call(m, shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          #if defined( USE_COLOR_ALPHA ) || defined( USE_COLOR )
            totalEmissiveRadiance *= vColor.rgb;
          #endif`);
      };
      m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|catAspect1';
      m.needsUpdate = true;
    }
    this.pedRecs = new Set();   // chunk records holding pedestrian heads
    this.pedStates = new Map(); // crossing s -> {frame, st}: state of the frame (0 red, 1 flashing, 2 green)

    // ---- street-wide parts (see catenary/batch.js)
    this._initBatches(app);

    // ---- poles and their fixtures
    this.poles = layout.poles;
    this.byChunk = new Map();
    for (const p of this.poles) {
      const ci = layout.chunkIndex(p.s);
      if (!this.byChunk.has(ci)) this.byChunk.set(ci, []);
      this.byChunk.get(ci).push(p);
    }
    this.fixtures = new Map();
    for (const p of this.poles) {
      const rng = RNG.from(layout.seed, 'poleFix', Math.round(route.wrap(p.s) * 10), p.side);
      const type = rng.weighted([['double', 0.6], ['track', 0.32], ['walk', 0.08]]);
      const v = 1 + rng.range(-0.08, 0.08), h = rng.range(-1, 1);
      // banners: only about a third of the poles the layout offers carry one (a few runs of
      // an event's banners, not a festival street), each faded by its own months of sun
      const br = RNG.from(layout.seed, 'poleBanner', Math.round(route.wrap(p.s) * 10), p.side);
      this.fixtures.set(p, {
        type,
        tint: new THREE.Color(v * (1 - 0.015 * h), v, v * (1 + 0.03 * h)),
        design: Math.floor(rng.next() * BANNER_DESIGNS),
        phase: rng.next(),
        banner: !!p.banner && br.chance(0.34),
        fade: br.range(0.1, 0.45),
        // raked away from the span load, plus a small random lean
        rake: rng.range(0.3, 0.8) * DEG, leanX: rng.range(-0.15, 0.15) * DEG, leanZ: rng.range(-0.15, 0.15) * DEG,
        glass: [rng.range(0.95, 1.05), rng.range(-1, 1), rng.range(0.95, 1.05), rng.range(-1, 1)],
      });
      const f = this.fixtures.get(p);
      f.matrix = this.poleMatrix(p, new THREE.Matrix4());
    }
    this.plan = planOverhead(app, this.poles, (p) => this.fixtures.get(p).matrix);
    // on curves the outer pole anchors the pull-offs, so it has no track-side bracket
    const pullOffPoles = new Set();
    for (const sp of this.plan.spans) if (sp.curved) pullOffPoles.add(sp.kSign > 0 ? sp.R : sp.L);
    for (const p of this.poles) {
      const f = this.fixtures.get(p);
      const type = pullOffPoles.has(p) ? 'walk' : f.type;
      f.track = type !== 'walk'; f.walk = type !== 'track';
      f.arms = this.armMatrices(f.matrix, f);
    }

    // ---- lamp head table for env (glass centres follow the rake)
    const heads = [];
    for (const p of this.poles) {
      const f = this.fixtures.get(p);
      f.arms.forEach((arm, k) => {
        const pos = this.kit.info.glassCentre.clone().applyMatrix4(arm);
        // (glow: the bowl's own brightness, see the lantern instance colour in build)
        heads.push({ position: pos, s: route.wrap(p.s), side: p.side, d: p.d, height: pos.y - route.elevation(p.s), glow: f.glass[2 * k] });
      });
    }
    heads.sort((a, b) => a.s - b.s);
    this.heads = heads;
    this.glow = app.params.str('catglow') === '0' ? null : createLampGlow(app, heads);
  },

  _initBatches(app) {
    const K = this.kit, SK = this.signalKit;
    const B = (this.batches = new CatBatches(app));
    const lv = (k) => [K.hi[k], K.mid[k], K.lo[k], K.far[k]];
    // standards: shafts cast down to 0.12 m texels; brackets, scrolls and banner rods are
    // thin casters (the coarse cascades skip them)
    this.parts = {
      shafts: B.add(new CatBatch('catenary:shafts', this.poleMat, lv('shaft'), 96, { cast: true, shadowMaxTexel: 0.12 })),
      brackets: B.add(new CatBatch('catenary:brackets', this.poleMat, [...lv('arm'), this.bracketGeo], 160, { cast: true, thin: true })),
      lanterns: B.add(new CatBatch('catenary:lanterns', this.glassMat, lv('glass'), 160)),
      banners: B.add(new CatBatch('catenary:banners', this.bannerMat, [this.clothGeo], 32, { cast: true })),
      fittings: B.add(new CatBatch('catenary:fittings', this.fittingMat, [this.armGeo, this.clampGeo], 32)),
      insulators: B.add(new CatBatch('catenary:insulators', this.insulatorMat, [this.insSpanGeo, this.insDropGeo], 64)),
      signals: B.add(new CatBatch('catenary:signals', this.signalMat, [SK.tramHead, SK.tramPost, SK.tramMount, SK.pedBody], 32, { cast: true, shadowMaxTexel: 0.07 })),
      aspects: B.add(new CatBatch('catenary:signalAspects', this.aspectMat, [SK.tramGo, SK.tramStop, SK.pedRed, SK.pedGreen], 48)),
      // per-chunk wire ribbons (and their fitting stand-ins) and pole stickers
      wires: B.add(new SlotBatch('catenary:wires', this.wireMat, slotTemplate({ position: 3, aTan: 3, aWire: 2, color: 3 }), 72, 640, 1536)),
      stickers: B.add(new SlotBatch('catenary:stickers', this.stickerMat, slotTemplate({ position: 3, normal: 3, uv: 2, color: 3 }), 40, 256, 512)),
    };
    // the batch spans the street, so its sort position means nothing: blended wires (no
    // MSAA) go after the other transparent surfaces
    this.parts.wires.mesh.renderOrder = this.wireMat.transparent ? 10 : 2;
    this.parts.wires.mesh.userData.thinCaster = true;
    if (app.params.str('catslots') === '0') this.parts.wires.free.length = this.parts.stickers.free.length = 0;
    // geometry indices within the parts
    this.SIG = { tramHead: 0, tramPost: 1, tramMount: 2, pedBody: 3, tramGo: 0, tramStop: 1, pedRed: 2, pedGreen: 3 };
  },

  /** Pole frame: +X towards the street centre, +Y up, origin on the paving (sunk by the
   *  slope under the base so it never floats); raked. */
  poleMatrix(p, out) {
    const { route } = this.app;
    const f = this.fixtures.get(p);
    const smp = route.sample(p.s);
    const x = smp.right.clone().multiplyScalar(-Math.sign(p.d || 1));
    const z = new THREE.Vector3().crossVectors(x, _y);
    out.makeBasis(x, _y, z).setPosition(route.toWorld(p.s, p.d, -groundSink(route, p.s, p.d, BASE_R)));
    // rake: the top leans away from the track (rotation about local Z), plus a lean
    return out.multiply(_t.makeRotationFromEuler(new THREE.Euler(f.leanX, 0, f.rake + f.leanZ)));
  },

  armMatrices(pm, f) {
    const out = [];
    if (f.track) out.push(pm.clone().multiply(_t.makeTranslation(0, ARM_Y, 0)));
    if (f.walk) out.push(pm.clone().multiply(_r).multiply(_t.makeTranslation(0, ARM_Y, 0)));
    return out;
  },

  /** Lantern centres between sMin and sMax (route s, may wrap), nearest-s first:
   *  [{position: Vector3 (world, do not modify), s, side, d, height}]. */
  getLampHeads(sMin, sMax) {
    const H = this.heads || [];
    if (!H.length) return [];
    const L = this.app.route.length;
    if (sMax - sMin >= L) return H.slice();
    const a = this.app.route.wrap(sMin), span = sMax - sMin;
    let lo = 0, hi = H.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (H[m].s < a) lo = m + 1; else hi = m; }
    const out = [];
    for (let k = 0; k < H.length; k++) {
      const h = H[(lo + k) % H.length];
      let ds = h.s - a; if (ds < 0) ds += L;
      if (ds > span) break;
      out.push(h);
    }
    return out;
  },

  build(chunk, app) {
    const { layout } = app;
    const far = chunk.lod > 0;
    const group = new THREE.Group();
    group.name = 'catenary';
    const B = this.batches, P = this.parts;
    const rec = B.record(group, far);
    const STD = [0, 1, 2, 3];

    // ---- lamp standards, banners
    const poles = this.byChunk.get(chunk.index) || [];
    for (const p of poles) {
      const f = this.fixtures.get(p);
      B.put(rec, P.shafts, STD, f.matrix, f.tint);
      f.arms.forEach((am, k) => {
        const g = f.glass;
        B.put(rec, P.brackets, STD, am, f.tint);
        B.put(rec, P.lanterns, STD, am, _c.setRGB(g[2 * k] * (1 + 0.03 * g[2 * k + 1]), g[2 * k], g[2 * k] * (1 - 0.04 * g[2 * k + 1])));
      });
      if (f.banner) {
        B.put(rec, P.brackets, 4, f.matrix, f.tint);
        // per-instance wind phase, print cell and fading (read by the banner shader)
        B.put(rec, P.banners, 0, f.matrix, _c.setRGB(f.phase, f.design, f.fade));
      }
    }
    if (!far && poles.length) {
      const st = buildStickers(poles, (p, out) => out.copy(this.fixtures.get(p).matrix), layout.seed);
      if (st && !B.putSlot(rec, P.stickers, st)) { const mesh = new THREE.Mesh(st, this.stickerMat); mesh.name = 'stickers'; mesh.receiveShadow = true; group.add(mesh); }
    }

    // ---- overhead line
    const oh = buildOverheadChunk(app, this.plan, chunk);
    if (oh.wires && !B.putSlot(rec, P.wires, oh.wires)) group.add(wireMesh(oh.wires, this.wireMat, 'wires'));
    for (const m of oh.spanInsulators) B.put(rec, P.insulators, 0, m, null, NEAR);
    for (const m of oh.dropInsulators) B.put(rec, P.insulators, 1, m, null, NEAR);
    for (const m of oh.arms) B.put(rec, P.fittings, 0, m, null, NEAR);
    for (const m of oh.clamps) B.put(rec, P.fittings, 1, m, null, NEAR);
    let ribbons = null;
    if (oh.detailRibbons && !B.putSlot(rec, P.wires, oh.detailRibbons, FAR)) {
      ribbons = wireMesh(oh.detailRibbons, this.wireMat, 'overheadFar');
      group.add(ribbons);
    }

    // ---- signals at cross streets
    const cs = layout.inChunk('crossStreets', chunk.index);
    if (cs.length) this.buildSignals(rec, cs, app);

    this._lvDirty = true;
    if (!far) {
      const entry = { s0: chunk.s0, s1: chunk.s1, rec, ribbons };
      this.setDetail(entry, app.cameraS ?? app.startS);
      group.userData.catenaryLive = entry;
      this.live.add(entry);
    }
    return group;
  },

  dispose(obj) {
    this._lvDirty = true;
    if (obj.userData.catenaryLive) this.live.delete(obj.userData.catenaryLive);
    if (obj.userData.catRecord && this.pedRecs.delete(obj.userData.catRecord)) this._pedList = null;
    this.batches.release(obj.userData.catRecord);
    disposeObject(obj);
  },

  /** Near full-detail chunks show the fittings instead of their ribbon stand-ins. */
  setDetail(e, sCam) {
    const { route } = this.app;
    const a = route.delta(sCam, e.s0), b = route.delta(sCam, e.s1);
    const fit = (a <= 0 && b >= 0 ? 0 : Math.min(Math.abs(a), Math.abs(b))) < FIT_DIST * this._lens();
    this.batches.setNear(e.rec, fit);
    if (e.ribbons) e.ribbons.visible = !fit;
  },

  /** Distance scale of the current lens against the default one. */
  _lens() {
    const fov = this.app.camera.fov || REF_FOV;
    return THREE.MathUtils.clamp(REF_FOV / fov, 0.3, 1.5);
  },

  buildSignals(rec, crossStreets, app) {
    const { route, layout } = app;
    const B = this.batches, P = this.parts, I = this.SIG;
    const polesOf = (ci) => this.byChunk.get(ci) || [];
    for (const c of crossStreets) {
      for (const sg of signalPlacements(c, layout, polesOf)) {
        const smp = route.sample(sg.s);
        const fz = new THREE.Vector3();
        if (sg.face === 'back') fz.copy(smp.tanH).negate();
        else if (sg.face === 'fwd') fz.copy(smp.tanH);
        else if (sg.face === 'left') fz.copy(smp.right).negate();
        else fz.copy(smp.right);
        const fx = new THREE.Vector3().crossVectors(_y, fz);
        const m = new THREE.Matrix4().makeBasis(fx, _y, fz);
        if (sg.pole) {
          // on the pole: the head stands MOUNT_X towards the track from the pole axis
          // at the mount height (following the pole's rake)
          const pm = this.fixtures.get(sg.pole).matrix;
          const axis = new THREE.Vector3(0, 3.2, 0).applyMatrix4(pm);
          const toTrack = new THREE.Vector3().setFromMatrixColumn(pm, 0).setY(0).normalize();
          m.setPosition(axis.addScaledVector(toTrack, MOUNT_X).addScaledVector(_y, -3.2));
          B.put(rec, P.signals, I.tramMount, m);
        } else {
          m.setPosition(route.toWorld(sg.s, sg.d, -groundSink(route, sg.s, sg.d, 0.075)));
          if (sg.kind === 'tram') B.put(rec, P.signals, I.tramPost, m);
        }
        if (sg.kind === 'tram') {
          B.put(rec, P.signals, I.tramHead, m);
          // the tram is cleared through: proceed for the ride direction, stop for the other
          B.put(rec, P.aspects, sg.face === 'back' ? I.tramGo : I.tramStop, m);
        } else {
          B.put(rec, P.signals, I.pedBody, m);
          B.put(rec, P.aspects, I.pedRed, m);
          const red = rec.entries[rec.entries.length - 1].id;
          B.put(rec, P.aspects, I.pedGreen, m);
          const green = rec.entries[rec.entries.length - 1].id;
          (rec.peds || (rec.peds = [])).push({ s: c.s, red, green, state: -1, lit: -1 });
          this.pedRecs.add(rec);
          this._pedList = null;
        }
      }
    }
  },

  /** State of the pedestrian lights of the crossing at route s: 0 red (a tram is near
   *  or over it), 1 flashing green (red in a few seconds), 2 green. Memoised per frame. */
  pedState(sc) {
    const app = this.app, route = app.route;
    // one memo per crossing, kept (clearing a Map every frame makes garbage)
    const key = Math.round(sc * 10);
    let memo = this.pedStates.get(key);
    if (!memo) { memo = { frame: -1, st: 2 }; this.pedStates.set(key, memo); }
    if (memo.frame === app.frame) return memo.st;
    let st = 2;
    const tr = app.train;
    if (tr && Number.isFinite(tr.s)) st = Math.min(st, tramCheck(route, sc, tr.s, 1, TRAM_LEN, tr.speed));
    const units = app.trams && app.trams.units;
    if (units) {
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u && u.active !== false && Number.isFinite(u.s)) st = Math.min(st, tramCheck(route, sc, u.s, u.dir || -1, u.length || TRAM_LEN, u.speed));
      }
    }
    memo.frame = app.frame; memo.st = st;
    return st;
  },

  /** Pedestrian light at the crossing nearest route s (within 15 m): 'red', 'flash'
   *  (green, turning red within a few seconds) or 'green'; null where there is none. */
  signalAt(s) {
    const { route, layout } = this.app;
    let best = null, bd = 15;
    for (const c of layout.crossStreets) { const d = Math.abs(route.delta(c.s, s)); if (d < bd) { bd = d; best = c; } }
    if (!best) return null;
    return PED_NAMES[this.pedState(best.s)];
  },

  _updatePedLights(app) {
    if (!this.pedRecs.size) return;
    const asp = this.parts.aspects.mesh;
    const flashOn = ((app.time || 0) % 1) < 0.5;
    const list = this._pedList || (this._pedList = [...this.pedRecs]);
    for (let r = 0; r < list.length; r++) {
      const peds = list[r].peds;
      for (let q = 0; q < peds.length; q++) {
        const h = peds[q];
        const st = this.pedState(h.s);
        const lit = st === 0 ? 0 : st === 2 || flashOn ? 1 : 2;  // 0 red, 1 green, 2 dark
        if (lit === h.lit) continue;
        h.lit = lit;
        asp.setColorAt(h.red, lit === 0 ? _on : _off);
        asp.setColorAt(h.green, lit === 1 ? _on : _off);
      }
    }
  },

  update(dt, app) {
    // until ready every part draws once a frame (see CatBatches.warmup)
    if (!app.ready) this.batches.warmup(app.camera.position, app.camera.getWorldDirection(_dir));
    else if (this.batches.warm) this.batches.endWarmup();
    updateScreenUniforms(app, this.lampRadiance);
    // lamp switch-on level 0..1 (env.state.lamps: photocell ramp from t 0.64, full by 0.72,
    // then the night)
    this.lampOn =this.lampRadiance > 0 ? SU.uLamp.value / this.lampRadiance : 0;
    if (this.glow) this.glow.update(app.cameraS ?? app.startS, SU.uLamp.value);
    this._updatePedLights(app);
    // alpha-to-coverage rounds to whole samples of the scene target
    const post = app.post, rt = post && !post.disabled ? post.sceneRT : null;
    SU.uA2C.value = rt && rt.samples > 0 ? rt.samples : 0;
    // LED aspects dim at night so they do not flare
    this.aspectMat.emissiveIntensity = 0.55 * (1 - 0.93 * U.uNight.value);
    // detail levels: only when the eye moved, the lens changed or chunks came or went
    const sCam = app.cameraS ?? app.startS, k = this._lens(), cp = app.camera.position;
    const L = this._lv || (this._lv = { s: NaN, k: 0, x: 0, z: 0 });
    const mx = cp.x - L.x, mz = cp.z - L.z;
    if (this._lvDirty || !(Math.abs(sCam - L.s) < 0.25) || k !== L.k || mx * mx + mz * mz > 0.0625) {
      this._lvDirty = false;
      L.s = sCam; L.k = k; L.x = cp.x; L.z = cp.z;
      for (const e of this.live) this.setDetail(e, sCam);
      for (let i = 0; i < LEVEL_DIST.length; i++) _lvd[i] = LEVEL_DIST[i] * k;
      this.batches.updateLevels(cp, _lvd);
    }
  },
};

/** Pedestrian light state at crossing sc for one tram: front = its leading end, dir =
 *  travel direction (+1 / -1 in s), len = body behind the front (0 red, 1 flash, 2 green). */
function tramCheck(route, sc, front, dir, len, speed) {
  const ahead = route.delta(front, sc) * dir;   // crossing ahead of the front (m)
  if (ahead <= 0) return -ahead < len + CLEAR_M ? 0 : 2;  // over it, or gone
  const v = Math.max(0, speed || 0), redAt = Math.max(RED_DIST, v * RED_SEC);
  if (ahead < redAt) return 0;
  return v > 0.3 && (ahead - redAt) / v < BLINK_SEC ? 1 : 2;
}

/** Sink of an upright base of radius r (m) into the sloping paving at (s, d), so its
 *  downhill edge still touches the ground. */
function groundSink(route, s, d, r) {
  const gs = route.groundY(s + 0.25, d) - route.groundY(s - 0.25, d);
  const gd = route.groundY(s, d + 0.25) - route.groundY(s, d - 0.25);
  return r * 2 * Math.hypot(gs, gd);
}

/** Minimal geometry with the attribute layout {name: itemSize} of a slot batch. */
function slotTemplate(layout) {
  const g = new THREE.BufferGeometry();
  for (const [k, n] of Object.entries(layout)) g.setAttribute(k, new THREE.BufferAttribute(new Float32Array(3 * n), n));
  g.setIndex([0, 1, 2]);
  return g;
}

function wireMesh(geo, mat, name) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name; m.castShadow = false; m.receiveShadow = true;
  m.userData.thinCaster = true;
  m.renderOrder = 2;
  return m;
}

export default catenary;
