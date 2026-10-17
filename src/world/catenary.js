import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { buildPoleKit, TRACK_ARM_Y, WALK_ARM_Y } from './catenary/poleKit.js';
import { planOverhead, buildOverheadChunk, buildInsulatorGeometry, buildClampGeometry } from './catenary/overhead.js';
import { patchThin, makeWireMaterial, makeGlassMaterial, patchBanner, makeLensMaterial, updateScreenUniforms } from './catenary/shaders.js';
import { buildBannerBracket, buildBannerCloth, buildBannerAtlas, BANNER_DESIGNS } from './catenary/banners.js';
import { buildSignalKit, signalPlacements, buildPedIconTexture } from './catenary/signals.js';

// Lamp standards, overhead contact line, pole banners and traffic signals.
// Contract: docs/ARCHITECTURE.md. Placements come from layout.poles / layout.crossStreets.
//
// Per chunk: instanced shafts, brackets and lantern glass (one draw call each), one
// ribbon mesh for every wire, instanced insulators and clamps near the camera, merged
// banners and signals where present. Everything heavy is built once in init().

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
    this.insulatorGeo = [buildInsulatorGeometry(false), buildInsulatorGeometry(true)];
    this.clampGeo = buildClampGeometry();
    this.bracketGeo = buildBannerBracket();
    this.signalKit = buildSignalKit();

    // ---- materials (library materials where they exist, own ones registered + tracked)
    let pole;
    try { pole = M.get('metal.pole', { vertexColors: true, catenaryThin: true }); } catch (e) { pole = M.get('metal.pole').clone(); pole.vertexColors = true; M.track(pole); }
    this.poleMat = patchThin(pole);
    this.glassMat = M.register('catenary.lanternGlass', makeGlassMaterial(M.get('glass.lamp')));
    this.wireMat = M.register('catenary.wire', makeWireMaterial());
    this.insulatorMat = M.register('catenary.insulator', patchThin(new THREE.MeshStandardMaterial({ color: 0x5b5752, roughness: 0.5, metalness: 0.0, vertexColors: true })));
    const atlas = buildBannerAtlas(layout.seed);
    this.bannerMat = M.register('catenary.banner', patchBanner(new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.88, metalness: 0, side: THREE.DoubleSide })));
    this.housingMat = M.register('catenary.signalHousing', new THREE.MeshStandardMaterial({ color: 0x141515, roughness: 0.6, metalness: 0.0, side: THREE.DoubleSide }));
    this.borderMat = M.register('catenary.signalBorder', new THREE.MeshStandardMaterial({ color: 0xd8d8d2, roughness: 0.55, metalness: 0.0 }));
    this.lensDarkMat = M.register('catenary.lensDark', new THREE.MeshStandardMaterial({ color: 0x060606, roughness: 0.08, metalness: 0.0 }));
    this.lensWhiteMat = M.register('catenary.lensWhite', makeLensMaterial(0xfff4e0, 5.5));
    const icons = buildPedIconTexture();
    const red = makeLensMaterial(0xff2a12, 4.5); red.emissiveMap = icons; red.name = 'catenary.lensPedRed';
    const green = makeLensMaterial(0x13ff7a, 0.06); green.emissiveMap = icons; green.name = 'catenary.lensPedGreen';
    this.pedRedMat = M.register('catenary.lensPedRed', red);
    this.pedGreenMat = M.register('catenary.lensPedGreen', green);
    // icon UVs relative to each lens centre: standing figure on red, walking on green
    fixIconUVs(this.signalKit.pedLensRed, 0);
    fixIconUVs(this.signalKit.pedLensGreen, 1);

    // ---- per-pole fixtures (deterministic) and the lamp head table for env
    this.fixtures = new Map();
    const heads = [];
    // on curves the outer pole anchors the pull-offs, so it has no track-side bracket
    const pullOffPoles = new Set();
    for (const sp of this.plan.spans) if (sp.curved) pullOffPoles.add(sp.kSign > 0 ? sp.R : sp.L);
    for (const p of layout.poles) {
      const rng = RNG.from(layout.seed, 'poleFix', Math.round(route.wrap(p.s) * 10));
      let type = rng.weighted([['double', 0.55], ['track', 0.33], ['walk', 0.12]]);
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

  /** Lantern centres between sMin and sMax (route s, may wrap): [{position, s, side, d, height}]. */
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
    const lo = chunk.lod > 0;
    const K = lo ? this.kit.lod1 : this.kit.lod0;
    const group = new THREE.Group();
    group.name = 'catenary';

    // ---- lamp standards
    const poles = layout.inChunk('poles', chunk.index);
    if (poles.length) {
      const shafts = [], arms = [], armTint = [], shaftTint = [], brackets = [];
      const cloth = [];
      for (const p of poles) {
        const f = this.fixtures.get(p);
        const pm = this.poleMatrix(p, new THREE.Matrix4());
        shafts.push(pm); shaftTint.push(f.tint);
        for (const am of this.armMatrices(pm, f)) { arms.push(am); armTint.push(f.tint); }
        if (p.banner) {
          brackets.push(pm);
          const g = buildBannerCloth(f.design, (p.id * 0.618) % 1);
          g.applyMatrix4(pm);
          cloth.push(g);
        }
      }
      group.add(instanced(K.shaft, this.poleMat, shafts, shaftTint, 'poles'));
      if (arms.length) {
        group.add(instanced(K.arm, this.poleMat, arms, armTint, 'brackets'));
        group.add(instanced(K.glass, this.glassMat, arms, null, 'lanterns'));
      }
      if (brackets.length) {
        group.add(instanced(this.bracketGeo, this.poleMat, brackets, null, 'bannerBrackets'));
        const g = mergeSimple(cloth);
        const mesh = new THREE.Mesh(g, this.bannerMat);
        mesh.name = 'banners'; mesh.castShadow = !lo; mesh.receiveShadow = true;
        group.add(mesh);
      }
    }

    // ---- overhead line
    const oh = buildOverheadChunk(app, this.plan, chunk);
    if (oh.wires) {
      const wires = new THREE.Mesh(oh.wires, this.wireMat);
      wires.name = 'wires'; wires.castShadow = false; wires.receiveShadow = false;
      wires.renderOrder = 2;
      group.add(wires);
    }
    if (oh.insulators.length) group.add(instanced(this.insulatorGeo[0], this.insulatorMat, oh.insulators, null, 'insulators', false));
    if (oh.clamps.length) group.add(instanced(this.clampGeo, this.insulatorMat, oh.clamps, null, 'clamps', false));

    // ---- signals at cross streets
    const cs = layout.inChunk('crossStreets', chunk.index);
    if (cs.length) this.buildSignals(group, cs, app);

    return group;
  },

  buildSignals(group, crossStreets, app) {
    const { route, layout } = app;
    const SK = this.signalKit;
    const parts = new Map(); // material -> geometries
    const add = (mat, geom, m) => { if (!parts.has(mat)) parts.set(mat, []); const g = geom.clone(); g.applyMatrix4(m); parts.get(mat).push(g); };
    for (const c of crossStreets) {
      for (const sg of signalPlacements(c, layout)) {
        const smp = route.sample(sg.s);
        // local +Z (lens direction) by facing
        const fz = new THREE.Vector3();
        if (sg.face === 'back') fz.copy(smp.tanH).negate();
        else if (sg.face === 'fwd') fz.copy(smp.tanH);
        else if (sg.face === 'left') fz.copy(smp.right).negate();
        else fz.copy(smp.right);
        const fx = new THREE.Vector3().crossVectors(_y, fz);
        const m = new THREE.Matrix4().makeBasis(fx, _y, fz).setPosition(route.toWorld(sg.s, sg.d, 0));
        if (sg.kind === 'tram') {
          add(this.poleMat, SK.tramPost, m);
          add(this.housingMat, SK.tramHousing, m);
          add(this.borderMat, SK.tramBorder, m);
          add(this.lensDarkMat, SK.tramLens, m);
          add(this.lensWhiteMat, sg.face === 'back' ? SK.tramGo : SK.tramStop, m);
        } else {
          add(this.poleMat, SK.pedPost, m);
          add(this.housingMat, SK.pedHousing, m);
          add(this.pedRedMat, SK.pedLensRed, m);
          add(this.pedGreenMat, SK.pedLensGreen, m);
        }
      }
    }
    for (const [mat, list] of parts) {
      const mesh = new THREE.Mesh(mergeSimple(list), mat);
      mesh.name = 'signals'; mesh.castShadow = mat === this.poleMat || mat === this.housingMat; mesh.receiveShadow = true;
      group.add(mesh);
    }
  },

  update(dt, app) {
    updateScreenUniforms(app);
  },
};

function instanced(geo, mat, matrices, tints, name, cast = true) {
  const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
  if (tints) {
    const c = new THREE.Color();
    for (let i = 0; i < matrices.length; i++) mesh.setColorAt(i, c.setScalar(tints[i]));
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = name;
  mesh.castShadow = cast; mesh.receiveShadow = true;
  return mesh;
}

/** Merge geometries that share the same attribute layout (position/normal[/uv/color/aBanner]). */
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

/** Pedestrian lens UVs relative to each lens centre (half 0 = standing, 1 = walking). */
function fixIconUVs(geom, half) {
  const p = geom.attributes.position;
  const uv = geom.attributes.uv;
  let cy = 0;
  for (let i = 0; i < p.count; i++) cy += p.getY(i);
  cy /= p.count;
  for (let i = 0; i < p.count; i++) {
    const u = (p.getX(i) / 0.09) * 0.5 + 0.5, v = ((p.getY(i) - cy) / 0.09) * 0.5 + 0.5;
    uv.setXY(i, (half + u) * 0.5, v);
  }
  uv.needsUpdate = true;
}

export default catenary;
