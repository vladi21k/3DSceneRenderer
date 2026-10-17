import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { disposeObject } from './streaming.js';
import { buildPoleKit, TRACK_ARM_Y, WALK_ARM_Y } from './catenary/poleKit.js';
import { planOverhead, buildOverheadChunk, buildInsulatorGeometry, buildClampGeometry } from './catenary/overhead.js';
import { patchThin, makeWireMaterial, makeGlassMaterial, patchBanner, updateScreenUniforms } from './catenary/shaders.js';
import { buildBannerBracket, buildBannerCloth, buildBannerAtlas, BANNER_DESIGNS, BANNER_X0, BANNER_X1, BANNER_Y0, BANNER_Y1 } from './catenary/banners.js';
import { buildSignalKit, signalPlacements, buildAspectAtlas } from './catenary/signals.js';
import { buildStickers, buildStickerAtlas } from './catenary/wear.js';

// Lamp standards, overhead contact line, pole banners and traffic signals.
// Contract: docs/ARCHITECTURE.md. Placements come from layout.poles / layout.crossStreets.
//
// Per chunk: instanced shafts, brackets and lantern glass (one draw call each), one
// ribbon mesh for every wire, instanced insulators and clamps near the camera, merged
// banners and stickers, instanced signal parts at junctions. Full-detail chunks carry a
// hi and a mid tessellation of the standards and swap them by camera distance; far
// chunks use the lo kit. Everything heavy is built once in init().

const HI_DIST = 55;          // chunk near edge closer than this: hi tessellation

const _x = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0), _z = new THREE.Vector3();
const _t = new THREE.Matrix4(), _r = new THREE.Matrix4().makeRotationY(Math.PI);
const _p = new THREE.Vector3();

const catenary = {
  name: 'catenary',

  async init(app) {
    const { materials: M, layout, route } = app;
    this.app = app;
    this.kit = buildPoleKit();
    this.plan = planOverhead(app);
    this.insulatorGeo = buildInsulatorGeometry();
    this.clampGeo = buildClampGeometry();
    this.bracketGeo = buildBannerBracket();
    this.signalKit = buildSignalKit();
    this.live = new Set(); // full-detail chunk parts with a hi / mid pair

    // ---- materials: library ones where they exist, own ones registered (and so tracked)
    // Own variant of the pole paint (unique key) so the thin-part patch stays private. The
    // baked vertex colours carry AO and grime; when the library treats vertex colour as the
    // paint albedo, the paint colour is folded into the per-instance colour instead.
    this.poleMat = patchThin(M.get('metal.pole', { vertexColors: true, catenaryThin: true }));
    this.paint = new THREE.Color(1, 1, 1);
    if (M.meta?.['metal.pole']?.vertexColor === 'albedo') this.paint.copy(M.get('metal.pole').color);
    this.glassMat = makeGlassMaterial(M);
    this.wireMat = M.register('catenary.wire', makeWireMaterial());
    this.insulatorMat = M.register('catenary.insulator', patchThin(new THREE.MeshStandardMaterial({ color: 0x5b5752, roughness: 0.5, metalness: 0.0, vertexColors: true })));
    this.bannerMat = M.register('catenary.banner', patchBanner(new THREE.MeshStandardMaterial({ map: buildBannerAtlas(layout.seed), roughness: 0.9, metalness: 0, side: THREE.DoubleSide }), [BANNER_X1 - BANNER_X0, BANNER_Y1 - BANNER_Y0]));
    this.signalMat = M.register('catenary.signalBody', new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide }));
    this.stickerMat = M.register('catenary.sticker', new THREE.MeshStandardMaterial({ map: buildStickerAtlas(layout.seed), vertexColors: true, roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
    // LED aspects, about 0.5 scene units (~16,000 cd/m²): clearly lit in sunshine
    this.aspectMat = M.register('catenary.signalAspect', new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.2, metalness: 0, emissive: 0xffffff, emissiveMap: buildAspectAtlas(), emissiveIntensity: 0.55 }));

    // ---- per-pole fixtures (deterministic) and the lamp head table for env
    this.fixtures = new Map();
    const heads = [];
    // on curves the outer pole anchors the pull-offs, so it has no track-side bracket
    const pullOffPoles = new Set();
    for (const sp of this.plan.spans) if (sp.curved) pullOffPoles.add(sp.kSign > 0 ? sp.R : sp.L);
    for (const p of layout.poles) {
      const rng = RNG.from(layout.seed, 'poleFix', Math.round(route.wrap(p.s) * 10));
      let type = rng.weighted([['double', 0.6], ['track', 0.32], ['walk', 0.08]]);
      if (pullOffPoles.has(p)) type = 'walk';
      const f = {
        track: type !== 'walk', walk: type !== 'track',
        tint: 0.9 + rng.next() * 0.16,
        design: Math.floor(rng.next() * BANNER_DESIGNS),
      };
      this.fixtures.set(p, f);
      const pm = this.poleMatrix(p, new THREE.Matrix4());
      for (const arm of this.armMatrices(pm, f)) {
        const pos = this.kit.info.glassCentre.clone().applyMatrix4(arm);
        heads.push({ position: pos, s: route.wrap(p.s), side: p.side, d: p.d, height: pos.y - route.elevation(p.s) });
      }
    }
    heads.sort((a, b) => a.s - b.s);
    this.heads = heads;
  },

  /** Pole frame: +X towards the street centre, +Y up, origin on the paving. */
  poleMatrix(p, out) {
    const { route } = this.app;
    const smp = route.sample(p.s);
    _x.copy(smp.right).multiplyScalar(-Math.sign(p.d || 1));
    _z.crossVectors(_x, _y);
    route.toWorld(p.s, p.d, 0, _p);
    return out.makeBasis(_x, _y, _z).setPosition(_p);
  },

  armMatrices(pm, f) {
    const out = [];
    if (f.track) out.push(pm.clone().multiply(_t.makeTranslation(0, TRACK_ARM_Y, 0)));
    if (f.walk) out.push(pm.clone().multiply(_r).multiply(_t.makeTranslation(0, WALK_ARM_Y, 0)));
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

    // ---- lamp standards (+ near/mid detail sets for full-detail chunks)
    const hiSet = new THREE.Group(), midSet = new THREE.Group();
    hiSet.name = 'hi'; midSet.name = 'mid';
    const poles = layout.inChunk('poles', chunk.index);
    if (poles.length) {
      const shafts = [], arms = [], armTint = [], shaftTint = [], brackets = [], bracketTint = [], cloth = [];
      for (const p of poles) {
        const f = this.fixtures.get(p);
        const pm = this.poleMatrix(p, new THREE.Matrix4());
        const tint = this.paint.clone().multiplyScalar(f.tint);
        shafts.push(pm); shaftTint.push(tint);
        for (const am of this.armMatrices(pm, f)) { arms.push(am); armTint.push(tint); }
        if (p.banner) {
          brackets.push(pm); bracketTint.push(tint);
          const g = buildBannerCloth(f.design, (p.id * 0.618) % 1);
          g.applyMatrix4(pm);
          cloth.push(g);
        }
      }
      // every level casts (env shadows reach ~700 m; silhouettes match across levels, so
      // nothing pops when a chunk swaps tessellation or LOD)
      const standards = (target, K) => {
        target.add(instanced(K.shaft, this.poleMat, shafts, shaftTint, 'poles'));
        if (arms.length) {
          target.add(instanced(K.arm, this.poleMat, arms, armTint, 'brackets'));
          target.add(instanced(K.glass, this.glassMat, arms, null, 'lanterns', false));
        }
      };
      if (far) standards(group, this.kit.lo);
      else {
        standards(hiSet, this.kit.hi); standards(midSet, this.kit.mid);
        const st = buildStickers(poles, (p, out) => this.poleMatrix(p, out), layout.seed);
        if (st) { const mesh = new THREE.Mesh(st, this.stickerMat); mesh.name = 'stickers'; mesh.receiveShadow = true; group.add(mesh); }
      }
      if (brackets.length) {
        group.add(instanced(this.bracketGeo, this.poleMat, brackets, bracketTint, 'bannerBrackets', !far));
        const mesh = new THREE.Mesh(mergeSimple(cloth), this.bannerMat);
        mesh.name = 'banners'; mesh.castShadow = !far; mesh.receiveShadow = true;
        group.add(mesh);
      }
    }

    // ---- overhead line
    const oh = buildOverheadChunk(app, this.plan, chunk);
    if (oh.wires) group.add(wireMesh(oh.wires, this.wireMat, 'wires'));
    if (oh.insulators.length) hiSet.add(instanced(this.insulatorGeo, this.insulatorMat, oh.insulators, null, 'insulators', false));
    if (oh.clamps.length) hiSet.add(instanced(this.clampGeo, this.insulatorMat, oh.clamps, null, 'clamps', false));
    if (oh.insulatorRibbons) midSet.add(wireMesh(oh.insulatorRibbons, this.wireMat, 'insulatorsFar'));

    if (!far && (hiSet.children.length || midSet.children.length)) {
      group.add(hiSet, midSet);
      const entry = { s0: chunk.s0, s1: chunk.s1, hi: hiSet, mid: midSet };
      this.setDetail(entry, app.cameraS ?? app.startS);
      group.userData.catenaryLive = entry;
      this.live.add(entry);
    }

    // ---- signals at cross streets
    const cs = layout.inChunk('crossStreets', chunk.index);
    if (cs.length) this.buildSignals(group, cs, app, far);

    return group;
  },

  dispose(obj) {
    if (obj.userData.catenaryLive) this.live.delete(obj.userData.catenaryLive);
    disposeObject(obj);
  },

  /** Show the hi or mid tessellation of a full-detail chunk depending on camera distance. */
  setDetail(e, sCam) {
    const { route } = this.app;
    const a = route.delta(sCam, e.s0), b = route.delta(sCam, e.s1);
    const near = a <= 0 && b >= 0 ? 0 : Math.min(Math.abs(a), Math.abs(b));
    const hi = near < HI_DIST;
    e.hi.visible = hi; e.mid.visible = !hi;
  },

  buildSignals(group, crossStreets, app, far) {
    const { route, layout } = app;
    const SK = this.signalKit;
    const sets = { tramBody: [], tramGo: [], tramStop: [], pedBody: [], pedLit: [] };
    for (const c of crossStreets) {
      for (const sg of signalPlacements(c, layout)) {
        const smp = route.sample(sg.s);
        const fz = new THREE.Vector3();
        if (sg.face === 'back') fz.copy(smp.tanH).negate();
        else if (sg.face === 'fwd') fz.copy(smp.tanH);
        else if (sg.face === 'left') fz.copy(smp.right).negate();
        else fz.copy(smp.right);
        const fx = new THREE.Vector3().crossVectors(_y, fz);
        const m = new THREE.Matrix4().makeBasis(fx, _y, fz).setPosition(route.toWorld(sg.s, sg.d, 0));
        if (sg.kind === 'tram') {
          sets.tramBody.push(m);
          // the tram is cleared through: proceed for the ride direction, stop for the other
          (sg.face === 'back' ? sets.tramGo : sets.tramStop).push(m);
        } else {
          sets.pedBody.push(m); sets.pedLit.push(m);
        }
      }
    }
    for (const [k, list] of Object.entries(sets)) {
      if (!list.length) continue;
      const body = k.endsWith('Body');
      group.add(instanced(SK[k], body ? this.signalMat : this.aspectMat, list, null, 'signals', body && !far));
    }
  },

  update(dt, app) {
    updateScreenUniforms(app);
    const sCam = app.cameraS ?? app.startS;
    for (const e of this.live) this.setDetail(e, sCam);
  },
};

function wireMesh(geo, mat, name) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name; m.castShadow = false; m.receiveShadow = false;
  m.renderOrder = 2;
  return m;
}

function instanced(geo, mat, matrices, tints, name, cast = true) {
  const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
  if (tints) for (let i = 0; i < matrices.length; i++) mesh.setColorAt(i, tints[i]);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = name;
  mesh.castShadow = cast; mesh.receiveShadow = true;
  return mesh;
}

/** Merge geometries sharing an attribute layout (attributes missing anywhere are dropped). */
function mergeSimple(list) {
  const names = Object.keys(list[0].attributes).filter((k) => list.every((g) => g.attributes[k]));
  let nV = 0, nI = 0;
  for (const g of list) { nV += g.attributes.position.count; nI += g.index ? g.index.count : g.attributes.position.count; }
  const out = new THREE.BufferGeometry();
  for (const k of names) {
    const size = list[0].attributes[k].itemSize;
    const arr = new Float32Array(nV * size);
    let o = 0;
    for (const g of list) { arr.set(g.attributes[k].array, o * size); o += g.attributes.position.count; }
    out.setAttribute(k, new THREE.BufferAttribute(arr, size));
  }
  const idx = nV > 65535 ? new Uint32Array(nI) : new Uint16Array(nI);
  let o = 0, base = 0;
  for (const g of list) {
    const n = g.attributes.position.count;
    if (g.index) { const a = g.index.array; for (let i = 0; i < a.length; i++) idx[o++] = a[i] + base; }
    else for (let i = 0; i < n; i++) idx[o++] = i + base;
    base += n;
    g.dispose();
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

export default catenary;
