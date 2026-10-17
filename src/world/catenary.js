import * as THREE from 'three';
import { RNG } from '../core/rng.js';
import { U } from '../core/uniforms.js';
import { disposeObject } from './streaming.js';
import { buildPoleKit, ARM_Y } from './catenary/poleKit.js';
import { planOverhead, buildOverheadChunk, buildInsulatorGeometry, buildClampGeometry, buildArmGeometry } from './catenary/overhead.js';
import { patchThin, makeWireMaterial, makeGlassMaterial, patchBanner, updateScreenUniforms, LAMP_RADIANCE } from './catenary/shaders.js';
import { buildBannerBracket, buildBannerCloth, buildBannerAtlas, BANNER_DESIGNS, BANNER_X0, BANNER_X1, BANNER_Y0, BANNER_Y1 } from './catenary/banners.js';
import { buildSignalKit, signalPlacements, buildAspectAtlas, MOUNT_X } from './catenary/signals.js';
import { buildStickers, buildStickerAtlas } from './catenary/wear.js';

// Lamp standards, overhead contact line, pole banners and traffic signals.
// Contract: docs/ARCHITECTURE.md. Placements come from layout.poles / layout.crossStreets;
// poles the plan puts inside a cross-street mouth are rendered at the nearer corner.
//
// Per chunk: instanced shafts, brackets and lantern glass (one draw call each), one
// ribbon mesh for every wire, instanced insulators, registration arms and clamps near the
// camera, instanced banners, merged stickers, instanced signal parts at junctions.
// Full-detail chunks carry a hi and a mid tessellation of the standards and swap them by
// camera distance; far chunks use the lo kit and cast only the shafts' shadows.
// Everything heavy is built once in init().

const HI_DIST = 55;           // chunk near edge closer than this: hi tessellation
const CAST_DIST = 120;        // mid-tessellation brackets cast shadows only this close
const PAINT = [0.125, 0.152, 0.148]; // linear albedo of the grey-green satin paint
const DEG = Math.PI / 180;

const _y = new THREE.Vector3(0, 1, 0);
const _t = new THREE.Matrix4(), _r = new THREE.Matrix4().makeRotationY(Math.PI);
const _c = new THREE.Color();

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
    this.live = new Set(); // full-detail chunk parts with a hi / mid pair
    this.lampRadiance = LAMP_RADIANCE;

    // multisampled frame (post on med / high): thin parts use alpha-to-coverage
    const post = app.systems.post;
    const msaa = !!(post && !post.disabled && post.q && post.q.msaa > 0);

    // ---- materials: library ones where they exist, own ones registered (and so tracked)
    // Own variant of the pole paint (unique key) so the thin-part patch stays private. The
    // baked vertex colours carry AO and grime around 1; the paint colour is the material
    // colour and the per-pole variation the instance colour.
    this.poleMat = patchThin(M.get('metal.pole', { vertexColors: true, catenaryThin: true, color: PAINT, roughness: 0.5 }), { coverage: msaa });
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

    // ---- rendered poles (cross-street mouths cleared) and their fixtures
    this.poles = relocatePoles(app);
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
      this.fixtures.set(p, {
        type,
        tint: new THREE.Color(v * (1 - 0.015 * h), v, v * (1 + 0.03 * h)),
        design: Math.floor(rng.next() * BANNER_DESIGNS),
        phase: rng.next(),
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
      for (const arm of this.fixtures.get(p).arms) {
        const pos = this.kit.info.glassCentre.clone().applyMatrix4(arm);
        heads.push({ position: pos, s: route.wrap(p.s), side: p.side, d: p.d, height: pos.y - route.elevation(p.s) });
      }
    }
    heads.sort((a, b) => a.s - b.s);
    this.heads = heads;
  },

  /** Pole frame: +X towards the street centre, +Y up, origin on the paving; raked. */
  poleMatrix(p, out) {
    const { route } = this.app;
    const f = this.fixtures.get(p);
    const smp = route.sample(p.s);
    const x = smp.right.clone().multiplyScalar(-Math.sign(p.d || 1));
    const z = new THREE.Vector3().crossVectors(x, _y);
    out.makeBasis(x, _y, z).setPosition(route.toWorld(p.s, p.d, 0));
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

    // ---- lamp standards (+ near/mid detail sets for full-detail chunks)
    const hiSet = new THREE.Group(), midSet = new THREE.Group();
    hiSet.name = 'hi'; midSet.name = 'mid';
    let midArms = null;
    const poles = this.byChunk.get(chunk.index) || [];
    if (poles.length) {
      const shafts = [], tints = [], arms = [], armTint = [], glassTint = [], banners = [], bannerData = [], bannerTint = [];
      for (const p of poles) {
        const f = this.fixtures.get(p);
        shafts.push(f.matrix); tints.push(f.tint);
        f.arms.forEach((am, k) => {
          arms.push(am); armTint.push(f.tint);
          const g = f.glass;
          glassTint.push(new THREE.Color(g[2 * k] * (1 + 0.03 * g[2 * k + 1]), g[2 * k], g[2 * k] * (1 - 0.04 * g[2 * k + 1])));
        });
        if (p.banner) {
          banners.push(f.matrix); bannerTint.push(f.tint);
          // per-instance wind phase and print cell (read by the banner shader)
          bannerData.push(_c.setRGB(f.phase, f.design, 0).clone());
        }
      }
      const standards = (target, K, castArms) => {
        target.add(instanced(K.shaft, this.poleMat, shafts, tints, 'poles', true));
        if (arms.length) {
          const a = instanced(K.arm, this.poleMat, arms, armTint, 'brackets', castArms);
          target.add(a, instanced(K.glass, this.glassMat, arms, glassTint, 'lanterns', false));
          return a;
        }
        return null;
      };
      if (far) standards(group, this.kit.lo, false);
      else {
        standards(hiSet, this.kit.hi, true);
        midArms = standards(midSet, this.kit.mid, true);
        const st = buildStickers(poles, (p, out) => out.copy(this.fixtures.get(p).matrix), layout.seed);
        if (st) { const mesh = new THREE.Mesh(st, this.stickerMat); mesh.name = 'stickers'; mesh.receiveShadow = true; group.add(mesh); }
      }
      if (banners.length) {
        group.add(instanced(this.bracketGeo, this.poleMat, banners, bannerTint, 'bannerBrackets', !far));
        group.add(instanced(this.clothGeo, this.bannerMat, banners, bannerData, 'banners', !far));
      }
    }

    // ---- overhead line
    const oh = buildOverheadChunk(app, this.plan, chunk);
    if (oh.wires) group.add(wireMesh(oh.wires, this.wireMat, 'wires'));
    if (oh.spanInsulators.length) hiSet.add(instanced(this.insSpanGeo, this.insulatorMat, oh.spanInsulators, null, 'insulators', false));
    if (oh.dropInsulators.length) hiSet.add(instanced(this.insDropGeo, this.insulatorMat, oh.dropInsulators, null, 'insulators', false));
    if (oh.arms.length) hiSet.add(instanced(this.armGeo, this.fittingMat, oh.arms, null, 'registrationArms', false));
    if (oh.clamps.length) hiSet.add(instanced(this.clampGeo, this.fittingMat, oh.clamps, null, 'clamps', false));
    if (oh.detailRibbons) midSet.add(wireMesh(oh.detailRibbons, this.wireMat, 'overheadFar'));

    if (!far && (hiSet.children.length || midSet.children.length)) {
      group.add(hiSet, midSet);
      const entry = { s0: chunk.s0, s1: chunk.s1, hi: hiSet, mid: midSet, midArms };
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

  /** Show the hi or mid tessellation of a full-detail chunk depending on camera distance;
   *  mid brackets stop casting beyond CAST_DIST (sub-texel in the far cascades). */
  setDetail(e, sCam) {
    const { route } = this.app;
    const a = route.delta(sCam, e.s0), b = route.delta(sCam, e.s1);
    const near = a <= 0 && b >= 0 ? 0 : Math.min(Math.abs(a), Math.abs(b));
    const hi = near < HI_DIST;
    e.hi.visible = hi; e.mid.visible = !hi;
    if (e.midArms) e.midArms.castShadow = near < CAST_DIST;
  },

  buildSignals(group, crossStreets, app, far) {
    const { route, layout } = app;
    const SK = this.signalKit;
    const sets = { tramHead: [], tramPost: [], tramMount: [], tramGo: [], tramStop: [], pedBody: [], pedLit: [] };
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
          sets.tramMount.push(m);
        } else {
          m.setPosition(route.toWorld(sg.s, sg.d, 0));
          if (sg.kind === 'tram') sets.tramPost.push(m);
        }
        if (sg.kind === 'tram') {
          sets.tramHead.push(m);
          // the tram is cleared through: proceed for the ride direction, stop for the other
          (sg.face === 'back' ? sets.tramGo : sets.tramStop).push(m);
        } else {
          sets.pedBody.push(m); sets.pedLit.push(m);
        }
      }
    }
    for (const [k, list] of Object.entries(sets)) {
      if (!list.length) continue;
      const lit = k === 'tramGo' || k === 'tramStop' || k === 'pedLit';
      group.add(instanced(SK[k], lit ? this.aspectMat : this.signalMat, list, null, 'signals', !lit && !far));
    }
  },

  update(dt, app) {
    updateScreenUniforms(app, this.lampRadiance);
    // LED aspects dim at night so they do not flare
    this.aspectMat.emissiveIntensity = 0.55 * (1 - 0.93 * U.uNight.value);
    const sCam = app.cameraS ?? app.startS;
    for (const e of this.live) this.setDetail(e, sCam);
  },
};

/** Rendered pole list: layout.poles, except that a facing pair with a pole inside a
 *  cross-street mouth moves to the nearer corner (same s for both, so the span still
 *  pairs), or is dropped when the corner is taken (trees, furniture, other poles). */
function relocatePoles(app) {
  const { layout, route } = app;
  const groups = new Map();
  for (const p of layout.poles) {
    const k = Math.round(route.wrap(p.s) * 100);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const near = (kind, s) => {
    const ci = layout.chunkIndex(s);
    return [...layout.inChunk(kind, ci - 1), ...layout.inChunk(kind, ci), ...layout.inChunk(kind, ci + 1)];
  };
  const out = [];
  for (const pair of groups.values()) {
    let mouth = null;
    for (const p of pair) mouth = mouth || layout.isInCrossStreet(p.s, p.side, 0.6);
    if (!mouth) { out.push(...pair); continue; }
    const s0 = pair[0].s;
    const half = mouth.width / 2 + 0.9;
    const cands = [mouth.s - half, mouth.s + half].sort((a, b) => Math.abs(route.delta(s0, a)) - Math.abs(route.delta(s0, b)));
    const fits = (s) => pair.every((p) => {
      if (layout.isInCrossStreet(s, p.side, 0.6)) return false;
      if (!!layout.isInStation(s, 2) !== !!layout.isInStation(p.s, 2)) return false;
      if (near('poles', s).some((q) => q.side === p.side && !pair.includes(q) && Math.abs(route.delta(q.s, s)) < 6)) return false;
      if (near('trees', s).some((t) => t.side === p.side && Math.abs(route.delta(t.s, s)) < 1.6)) return false;
      return !near('furniture', s).some((o) => Math.abs(route.delta(o.s, s)) < 1.1 && Math.abs(o.d - p.d) < 1.1);
    });
    const s = cands.find(fits);
    if (s == null) continue;
    for (const p of pair) out.push({ ...p, s: route.wrap(s), src: p });
  }
  return out;
}

function wireMesh(geo, mat, name) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name; m.castShadow = false; m.receiveShadow = true;
  m.renderOrder = 2;
  return m;
}

function instanced(geo, mat, matrices, colors, name, cast = true) {
  const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
  for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
  if (colors) for (let i = 0; i < matrices.length; i++) mesh.setColorAt(i, colors[i]);
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = name;
  mesh.castShadow = cast; mesh.receiveShadow = true;
  return mesh;
}

export default catenary;
