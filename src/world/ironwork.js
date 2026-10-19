import * as THREE from 'three';
import { RNG, hash2 } from '../core/rng.js';
import { CHUNK_LEN, VIEW_AHEAD, VIEW_BEHIND, LOD0_DIST } from '../core/config.js';
import { facadePlan } from './facadePlan.js';
import { DESIGNS, RAIL_H } from './ironwork/patterns.js';
import { bayGeometry, postGeometry, buildAtlas, atlasV, ATLAS, TOL } from './ironwork/railings.js';
import {
  slabPath, writeSlab, writeSlabShadow, corbelGeometry, corbelTemplate, CORBEL, balusterGeometry, plinthProfile, copingProfile,
  BALUSTRADE, makeStoneMaterial, GRIME, shadowTemplates, writeBalustradeShadow,
} from './ironwork/stone.js';
import { GeoWriter, PosWriter, writePos, sweepPath, box } from './ironwork/geo.js';
import { InstanceCollector, InstancePool, FlagPool } from './ironwork/instancer.js';
import { Strip } from './ironwork/strip.js';
import {
  makeMaterials, PAINTS, PAINT_W, uIronPx, uIronA2C, uIronCardK, uIronGeoK, uIwWiden, geoLimit, angleK, ironNeglect,
} from './ironwork/mats.js';
import { buildAttachAssets, makeAttachMaterials, writeTemplate, PLANT, BOX_SOIL, TROUGH_SOIL, DISH_W, FLAG } from './ironwork/attach.js';
import { balconyConsoles, CONSOLE } from './ironwork/consoles.js';

// Balconies and facade attachments: moulded stone slabs on carved consoles (placed by
// ironwork/consoles.js: scroll, stepped or block, clear of the dressing below), wrought-iron
// railings (instanced geometry near, coverage cards far) or stone balustrades, planters,
// AC units, flags and dishes. Everything is placed from facadePlan(lot) in the lot's
// facade frame (u along the wall, v up, w out of the wall). Contract: docs/ARCHITECTURE.md.
// Published for other modules: app.systems.ironwork.consolesOf(lot) writes the console
// positions under every balcony onto its facade plan (plan.balconies[i].consoles, see
// consolesFor), so run-off, grime and shutter clearances can follow the real consoles,
// and how far its iron railing is left to rust (plan.balconies[i].rust, 0 kept up .. 1
// rusting, 0 under a stone balustrade: the neglect the railing and slab shaders draw,
// mats.js ironNeglect), so rust stains on the wall below can follow the railing.
// When it is valid: always. It is pure (facade plan and lot seed only), deterministic
// and cached per plan, and needs no init, so another module may call it from its own
// init or build. Reading plan.balconies[i].consoles directly is valid once ironwork's
// init has run (it fills every lot and side lot of the layout, before the first chunk
// is built); a module that reads them during its own init, or plans that are not
// layout lots, call consolesOf(lot) first. Every balcony then has an array ([] where
// the slab rests on the dressing below).
//
// Level of detail is chosen per INSTANCE (each railing bay, post, console, baluster,
// plant, planter strap, AC unit) in update(), from projected sizes, so it follows the FOV:
//   rail   bay tessellation level whose chord error stays under 0.4 px (railings.js TOL),
//          then nothing once bars are thinner than ~0.8 px, foreshortening included
//          (the cards carry on)
//   post   finial post / plain post, same range
//   carve  carved consoles, turned balusters / light levels whose omissions (~1 cm)
//          stay under 0.6 px, so the switch does not show
//   plant  full plantings / light ones (same rule) / far ones, a few larger cards
//          covering as much, once the light level's leaves are under 2 px
//   strap  planter hook straps, until they are thinner than a pixel
//   ac     AC unit with pipes and brackets / the bare body, same rule for the pipes
// Railing cards are always present: they fade in under the geometry and take over from
// it without holes (see ironwork/mats.js). Far chunks (lod 1) have cards only, far
// consoles merged into the stone mesh, the same instanced plants as near chunks and the
// same satellite dishes, coarse.
//
// Draw calls: nothing is drawn per chunk. Merged geometry goes into one strip per
// material and detail range for the whole street (ironwork/strip.js: one draw per pass,
// culled per chunk block) and instances into one pool per family (ironwork/instancer.js:
// one draw per detail level in use, culled per chunk and, within it, per balcony stretch
// or window). A chunk's build returns an empty marker group; its blocks and instances
// are shown when the streamer shows the chunk and released on dispose. Builds are
// prepared ahead in small steps (see prefetch and warmStart).
// Shadows: position-only strips of light stand-ins cast them, the drawn geometry casts
// nothing. Slabs, consoles, balustrade rails and AC bodies cast in every cascade; the
// small and thin parts (balusters, pots, planters, chairs, poles, brackets, pipes, dishes) only
// in the fine cascades, whose texels can hold them (userData.thinCaster). The railing
// cards (thin) and a coarse twin of the flags cast the rest; the cards cast their true
// share of iron where the bars are finer than a shadow texel (mats.js cardDepthMaterial).
// Weathering: each railing's neglect (mats.js iwNeglect: kept up, chalking, rusting)
// drives its rust and paint wear near and far and the rust running from its feet down
// the slab edge (stone.js); consoles and slab edges carry dirt streaks and soot.

const _l = new THREE.Matrix4(), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _sz = new THREE.Vector2();
const _q = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _c4 = new THREE.Matrix4(), _pm = new THREE.Matrix4(), _fr = new THREE.Frustum();
const _pb = new THREE.Matrix4(), _pl = new THREE.Matrix4(), _pv = new THREE.Vector3();

/** Time slice (ms per frame) for preparing upcoming chunks in update(). */
const PREFETCH_MS = 0.5;

// Balcony gardening. A building's residents garden a little, some or a lot (lotStyle
// greenery: the chance that a household plants); on the avenue (s < AVENUE_END) most
// buildings are keen and over half the balconies carry flowers, elsewhere about a
// third. What one household grows differs from the next: geraniums above all (boxes of
// them hung on the rail, spilling over its front), herbs, trailing greens, surfinia,
// bougainvillea, now and then boxes left to dry out or standing empty; on the floor
// pots and potted shrubs.
const AVENUE_END = 1500;
const GROW = { GERANIUM: 0, HERBS: 1, GREEN: 2, SURFINIA: 3, BOUG: 4, DRY: 5, EMPTY: 6 };
const GROW_W = [0.52, 0.08, 0.1, 0.09, 0.08, 0.07, 0.06];
// Linear albedo tints of the flowering parts. Geraniums: scarlet, red, pink, magenta,
// orange, white, salmon, lilac.
const FLOWERS = [[0.62, 0.012, 0.016], [0.75, 0.03, 0.02], [0.82, 0.16, 0.3], [0.5, 0.02, 0.17], [0.85, 0.2, 0.1], [0.8, 0.78, 0.74], [0.85, 0.32, 0.2], [0.45, 0.2, 0.5]];
const FLOWER_W = [0.3, 0.26, 0.16, 0.07, 0.05, 0.08, 0.05, 0.03];
// potted shrubs (oleander, hibiscus, myrtle, lemon): flowering tints, or leafy ones
const SHRUB_BLOOM = [[0.8, 0.25, 0.42], [0.85, 0.82, 0.78], [0.75, 0.05, 0.08], [0.09, 0.16, 0.05], [0.09, 0.16, 0.05]];
// Flags (the atlas cells of attach.js flagTexture): the national white with two blue
// stripes and the emblem, the same sun-faded, plain stripes, blue over white.
const FLAG_W = [0.62, 0.2, 0.12, 0.06];
const FLAG_UV = [[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]];   // atlas offsets of the four cells
const FLAG_L = FLAG.L, FLAG_H = FLAG.H, FLAG_TOP = 1.85;       // cloth size, hoist top up the pole
// herb spikes: lavender, sage blue, basil white, not in flower (leafy)
const HERBS = [[0.32, 0.2, 0.55], [0.2, 0.12, 0.42], [0.7, 0.7, 0.66], [0.09, 0.16, 0.05]];
const HERB_W = [0.25, 0.15, 0.2, 0.4];
// surfinia: purple, magenta, white, pink, crimson; trailing greens hide their flowers
const SURFINIA = [[0.32, 0.03, 0.42], [0.62, 0.04, 0.3], [0.78, 0.78, 0.74], [0.8, 0.3, 0.48], [0.5, 0.03, 0.05]];
const TRAIL_GREEN = [0.05, 0.1, 0.03];
// bougainvillea bracts: magenta, purple, cerise, pink, cream
const BOUG = [[0.55, 0.015, 0.22], [0.4, 0.02, 0.3], [0.7, 0.04, 0.26], [0.8, 0.2, 0.42], [0.78, 0.74, 0.68]];
const BOUG_W = [0.42, 0.2, 0.2, 0.12, 0.06];
// withered flower heads
const WITHERED = [[0.16, 0.09, 0.045], [0.24, 0.15, 0.08], [0.11, 0.07, 0.045], [0.3, 0.22, 0.12]];
// planter boxes and troughs: terracotta (three), brown, green, white and anthracite
// plastic, fibre-cement grey, galvanised zinc
const BOXES = [[0.42, 0.16, 0.08], [0.36, 0.14, 0.06], [0.4, 0.22, 0.13], [0.12, 0.065, 0.035], [0.035, 0.075, 0.04], [0.6, 0.59, 0.55], [0.045, 0.045, 0.045], [0.3, 0.29, 0.27], [0.36, 0.37, 0.36]];
const BOX_W = [0.2, 0.12, 0.1, 0.12, 0.1, 0.12, 0.1, 0.08, 0.06];
const POTS = [[0.42, 0.16, 0.08], [0.32, 0.11, 0.05], [0.36, 0.14, 0.06], [0.2, 0.1, 0.055], [0.07, 0.11, 0.07], [0.42, 0.41, 0.38]];
const CHAIRS = [[0.75, 0.75, 0.72], [0.07, 0.2, 0.1], [0.5, 0.5, 0.48]];
const LEAFY = [0.09, 0.16, 0.05];
const TOWELS = [[0.8, 0.8, 0.78], [0.62, 0.55, 0.42], [0.12, 0.2, 0.42], [0.55, 0.12, 0.1], [0.3, 0.45, 0.35], [0.75, 0.65, 0.2]];
const WHITE = [1, 1, 1];
// instance families (constant keys and options: one lookup per family and chunk)
const CORBEL_KEYS = ['corbel0', 'corbel1', 'corbel2'], PLANT_KEYS = Object.values(PLANT).map((k) => `plant${k}`);
const POST_FACES = [[1, 0], [0, 1]]; // the two crossed sprite quads of a post card
const PLANT_OPTS = { cls: 'plant' }, CORBEL_OPTS = { cls: 'carve', radius: 1 }, BALUSTER_OPTS = { cls: 'carve', thin: true };
const BAY_OPTS = { cls: 'rail', radius: 0.8, angle: true, thin: true }, POST_OPTS = { cls: 'post', radius: 1.2, thin: true };
// All dishes in town aim at the same satellite: a fixed world direction (south-west, 40° up).
// An offset dish receives from about 22° above its face's normal, so the face itself
// looks out nearly level (18° up).
const DISH_DIR = new THREE.Vector3(-0.55, 0.64, 0.53).normalize();
const DISH_AIM = new THREE.Vector3(DISH_DIR.x, 0, DISH_DIR.z).normalize().multiplyScalar(Math.cos(0.314)).setY(Math.sin(0.314));
// dish paint (tints on the light grey of the template): off-white, light grey, dark grey
const DISH_PAINT = [[1.04, 1.04, 1.05], [0.86, 0.87, 0.88], [0.42, 0.42, 0.43]], DISH_PAINT_W = [[0, 0.6], [1, 0.28], [2, 0.12]];
// Stone tints are relative to the cream reference, exactly as the buildings tint theirs.
// WARM shifts the dressed-stone albedo toward the mean of the ashlar blocks around it
// (their per-block hue variation leans warm), measured on screen at equal lighting.
const CREAM = [0.86, 0.80, 0.68], WARM = [1.02, 1.0, 0.965];

const weighted = (r, w) => { let x = r.next() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0) return i; } return w.length - 1; };

/** Sphere around facade anchors (x, y, z, r, ...) padded for attachments and flags. */
function boundsOf(a) {
  const bx = new THREE.Box3();
  for (let i = 0; i < a.length; i += 4) bx.expandByPoint(_p.set(a[i], a[i + 1], a[i + 2]));
  const sp = bx.getBoundingSphere(new THREE.Sphere());
  let r = 0;
  for (let i = 0; i < a.length; i += 4) r = Math.max(r, sp.center.distanceTo(_p.set(a[i], a[i + 1], a[i + 2])) + a[i + 3]);
  sp.radius = r + 6;
  return sp;
}

/** Per-building ironwork style (deterministic from the lot seed). */
function lotStyle(lot, plan) {
  const r = new RNG(hash2(lot.seed, 0x1f0e));
  const era = plan.style.era;
  const design = era === 'modern' ? r.weighted([[5, 0.6], [2, 0.25], [6, 0.15]])
    : era === 'mandate' ? r.weighted([[2, 0.24], [6, 0.22], [3, 0.18], [0, 0.14], [5, 0.08], [1, 0.14]])
      : r.weighted([[0, 0.26], [1, 0.22], [4, 0.22], [3, 0.16], [6, 0.14]]);
  const paint = r.chance(0.6) ? -1 : weighted(r, PAINT_W);
  const railH = r.range(0.96, 1.07);
  const corbel = era === 'modern' ? -1 : r.chance(0.6) ? 0 : 1;
  const slabVariant = era === 'modern' || (era === 'mandate' && r.chance(0.45)) ? 1 : 0;
  const roundStone = r.chance(0.45);
  if (!r.chance(0.1)) r.next(); // (a former draw, kept so the choices after it stay put)
  const flowers = weighted(r, FLOWER_W);
  const pots = r.int(0, POTS.length - 1);
  r.int(0, 3); // (a former draw, kept so the choices after it stay put)
  const k = r.range(0.95, 1.02);
  // (on rendered blocks the slabs, consoles and balustrades are dressing: stone, not render)
  const stone = plan.style.finish === 'render' && plan.style.stone ? plan.style.stone : plan.style.tint;
  const tint = stone.map((t, i) => Math.pow(t / CREAM[i], 1.1) * k * WARM[i]);
  // gardening (a stream of its own). On the avenue a few buildings have bare balconies,
  // in a third some households plant and in the rest (the keen ones) most do: over half
  // the balconies carry flowers. Elsewhere over a third of the buildings are bare and
  // about a third of the balconies are planted. Each building leans toward some
  // plantings; the keen ones let fewer boxes dry out.
  const avenue = lot.s0 < AVENUE_END;
  const rg = new RNG(hash2(lot.seed, 0x6a7d));
  const keen = rg.next();
  const greenery = avenue
    ? (keen < 0.12 ? rg.range(0.04, 0.2) : keen < 0.45 ? rg.range(0.38, 0.66) : rg.range(0.7, 0.95))
    : (keen < 0.38 ? rg.range(0, 0.08) : keen < 0.74 ? rg.range(0.16, 0.45) : rg.range(0.5, 0.85));
  const grow = GROW_W.map((w, i) => w * rg.range(0.3, 1.7) * (i >= GROW.DRY ? 1.3 - greenery : 1));
  const box = weighted(rg, BOX_W);
  // carved stone (a stream of its own): every slab sits on consoles, modern fronts on
  // plain stepped or block ones; console width and the height of the slab's moulded
  // edge vary from building to building
  const rs = new RNG(hash2(lot.seed, 0x5c0e));
  const plainCorbel = rs.chance(0.55) ? CONSOLE.TIERED : CONSOLE.BLOCK;
  const corbelW = rs.range(0.9, 1.3);
  const edge = rs.range(0.02, 0.06);
  // flags (a stream of its own): in some buildings (more on the avenue) several
  // households hang a flag down the front of their railing, elsewhere hardly any do;
  // the building's usual flag design
  const rf = new RNG(hash2(lot.seed, 0x7f1a));
  const flagK = avenue ? (rf.chance(0.18) ? rf.range(0.25, 0.55) : rf.range(0, 0.02))
    : (rf.chance(0.1) ? rf.range(0.2, 0.45) : rf.range(0, 0.015));
  const flag = weighted(rf, FLAG_W);
  return {
    design, paint, railH, corbel: corbel < 0 ? plainCorbel : corbel, corbelW, edge, slabVariant, roundStone, tint,
    greenery, grow, box, flowers, pots, flag, flagK, avenue,
  };
}

/** The consoles under balcony `bal` (consoles.js), for the building's style `st`; also
 *  published on the balcony as bal.consoles = [{u, h, w}]: u the console's centre along
 *  the facade, h how far its lowest point (the scroll's pendant knob included) hangs
 *  below the soffit (bal.y - bal.slabT), w its width. */
function consolesFor(plan, st, bal) {
  const D = bal.depth;
  const rc = bal.railing === 'stone' && st.roundStone ? Math.min(0.3, D * 0.35) : 0;
  const Hc = THREE.MathUtils.clamp(0.36 + 0.32 * D, 0.5, 0.74);
  const W2 = (CORBEL.W * st.corbelW) / 2;
  const foot = st.corbel === CONSOLE.SCROLL ? CORBEL.FOOT * (Hc / CORBEL.H) : 0;
  const place = balconyConsoles(plan, bal, { Hc, W2, rc, kind: st.corbel, foot });
  if (!bal.consoles) {
    const knob = place.kind === CONSOLE.SCROLL ? CORBEL.FOOT * (place.h / CORBEL.HV[CONSOLE.SCROLL]) : 0;
    bal.consoles = place.u.map((u) => ({ u, h: place.h + knob, w: W2 * 2 }));
  }
  return place;
}

/** Neglect of a balcony's iron railing as its shaders draw it (mats.js ironNeglect, at
 *  the middle of its front, half way up), 0 for a stone balustrade. */
function railRust(lot, bal) {
  if (bal.railing === 'stone') return 0;
  _rp.set((bal.u0 + bal.u1) / 2, bal.y + 0.5, bal.depth - 0.05).applyMatrix4(lot.frame.matrix);
  return ironNeglect(_rp.x, _rp.y, _rp.z);
}
const _rp = new THREE.Vector3(); // (railRust's own: other modules call consolesOf)

/** Bracket position for a facade flag: the pier nearest the planned spot that is clear
 *  of the windows on that floor (null if none). */
function flagPier(plan, f) {
  const fl = plan.floors.find((x) => f.y >= x.y && f.y < x.y + x.h) || plan.floors[plan.floors.length - 1];
  const cands = [plan.pierL * 0.5, ...plan.bays.slice(1).map((b) => b.u0), plan.width - plan.pierR * 0.5];
  const ops = plan.openings.filter((o) => o.floor === fl.index);
  let best = null;
  for (const u of cands) {
    if (ops.some((o) => Math.abs(u - o.uc) < o.w / 2 + 0.42)) continue;
    if (best === null || Math.abs(u - f.u) < Math.abs(best - f.u)) best = u;
  }
  return best;
}

/** True where a flag on a pole from facade (u, v, w) at elevation `el` (radians), its
 *  cloth `s` times the template, keeps clear of the plan's balconies: slab, consoles and
 *  railing as a box (padded 0.1 m along the wall; `own`, the balcony the pole is tied
 *  to, unpadded and met only by the cloth). The hanging cloth is boxed generously: from
 *  the hoist down by its whole fly length, ±0.15 m along the wall. */
function flagClear(plan, u, v, w, el, s, own) {
  const sn = Math.sin(el), cs = Math.cos(el);
  const hb = FLAG_TOP - FLAG_H * s, L = FLAG_L * s;
  // cloth box (v, w): hoist bottom / top points on the pole, the fly hanging below
  const cv0 = v + hb * sn - L * 0.98, cv1 = v + FLAG_TOP * sn + 0.05;
  const cw0 = w + hb * cs - 0.12;
  for (const b of plan.balconies) {
    const pad = b === own ? 0 : 0.1;
    const bu0 = b.u0 - pad, bu1 = b.u1 + pad;
    const bv0 = b.y - b.slabT - 0.8, bv1 = b.y + 1.15, bw1 = b.depth + 0.08;
    if (u + 0.15 > bu0 && u - 0.15 < bu1 && cv1 > bv0 && cv0 < bv1 && cw0 < bw1) return false;
    if (b === own || u < bu0 || u > bu1) continue;
    for (let i = 1; i <= 10; i++) {
      const t = (i / 10) * (FLAG_TOP + 0.1), pv = v + t * sn, pw = w + t * cs;
      if (pv > bv0 && pv < bv1 && pw < bw1) return false;
    }
  }
  return true;
}

const ironwork = {
  name: 'ironwork',

  async init(app) {
    // consoles of every balcony in town, published on the plans before any module builds
    // a chunk (see consolesOf)
    const L = app.layout;
    for (const list of [L.lots, L.sideLots]) for (const lot of list) this.consolesOf(lot);
    this.atlas = buildAtlas();
    this.mats = makeMaterials(app, this.atlas);
    this.stoneMat = makeStoneMaterial(app);
    this.geo = {
      bay: DESIGNS.map((d) => [0, 1, 2].map((lod) => bayGeometry(d, lod))),
      post: [postGeometry(0), postGeometry(1)],
      corbel: [0, 1, 2].map((v) => [corbelGeometry(v, 0), corbelGeometry(v, 1)]),
      corbelFar: [0, 1, 2].map((v) => corbelTemplate(v)),
      baluster: [balusterGeometry(0), balusterGeometry(1)],
      shadow: shadowTemplates(),
    };
    this.att = buildAttachAssets();
    this.amats = makeAttachMaterials(app);
    this.app = app;
    this.live = new Set();     // marker groups handed to the streamer
    this.pending = new Set();  // ... whose chunk is not shown yet
    this.jobs = new Map();     // chunk index * 2 + lod -> build job (see prefetch)
    this._pf = this.prefetchScratch();
    this.spare = [];           // spare writer sets
    this.uniforms = { uIronPx, uIronA2C, uIronCardK, uIronGeoK, uIwWiden }; // for inspection / debugging
    this.lastPx = 0;
    this.census = null;        // set to a Map to record what full-detail builds plant (debugging)

    // street-wide meshes: merged strips per material, instance pools per family, flags
    this.root = new THREE.Group();
    this.root.name = 'ironwork';
    app.scene.add(this.root);
    // Near (lod 0) and far (lod 1) chunks fill separate strips: each ring then holds its
    // chunks in route order, so the blocks a pass sees form a tight index span.
    const strip = (mat, streams, name, opts) => {
      const s = new Strip(mat, streams, { scene: app.scene, name: `ironwork:${name}`, ...opts });
      this.root.add(s.mesh);
      return s;
    };
    // (capacities: about twice the most a dense stretch uses, so the rings rarely grow)
    const K = 1024, set = (tag, cap) => ({
      stone: strip(this.stoneMat, ['normal', 'uv', 'color', 'aGk'], `stone${tag}`, { instanceColor: true, vCap: cap.stone[0] * K, iCap: cap.stone[1] * K }),
      cards: strip(this.mats.card, ['normal', 'uv', 'color'], `cards${tag}`, { castShadow: true, thin: true, vCap: 32 * K, iCap: 48 * K }),
      parts: strip(this.amats.parts, ['normal', 'uv', 'color'], `parts${tag}`, { instanceColor: true, vCap: cap.parts[0] * K, iCap: cap.parts[1] * K }),
      // shadow casters only (the stone program, never drawn in the view)
      shadow: strip(this.stoneMat, [], `shadow${tag}`, { shadowOnly: true, instanceColor: true, vCap: cap.shadow[0] * K, iCap: cap.shadow[1] * K }),
    });
    this.strips = {
      near: set('', { stone: [128, 256], parts: [64, 96], shadow: [128, 512] }),
      far: set('Far', { stone: [192, 448], parts: [16, 32], shadow: [64, 256] }),
    };
    // railing cards cast their true share of iron (mats.js cardDepthMaterial)
    for (const k in this.strips) this.strips[k].cards.mesh.customDepthMaterial = this.mats.cardDepth;
    Object.assign(this.strips.near, {
      stains: strip(this.amats.stain, ['normal', 'uv'], 'stains', { vCap: K, iCap: 2 * K }),
      thin: strip(this.stoneMat, [], 'thinShadow', { shadowOnly: true, thin: true, instanceColor: true, vCap: 112 * K, iCap: 512 * K }),
    });
    // instance pools of every family and the flags: created now (empty), so the start-up
    // compile covers their programs instead of the first frame
    this.pools = new Map();
    this.poolList = [];        // (the same, for per-frame loops)
    for (const f of this.families()) this.poolOf(f);
    this.flagPool = new FlagPool(this.att.flag, this.att.flagShadow, this.amats.flag, this.amats.flagDepth, this.root, app.scene);
    await this.warmStart(app);
  },

  /** Prepares the chunks the streamer asks for first (around the start position and the
   *  inspection view) while the loading screen is up, so the start-up builds and the
   *  first frames' far chunks hand over finished groups. */
  async warmStart(app) {
    const n = app.layout.nChunks, around = [app.startS];
    if (app.params.view) around.push(app.params.view[0]);
    let yielded = performance.now();
    for (const s of around) {
      for (let i = Math.floor((s - VIEW_BEHIND) / CHUNK_LEN); i <= Math.floor((s + VIEW_AHEAD) / CHUNK_LEN); i++) {
        const idx = ((i % n) + n) % n;
        const dist = Math.max(0, Math.abs(i * CHUNK_LEN + CHUNK_LEN / 2 - s) - CHUNK_LEN / 2);
        const lod = dist < LOD0_DIST ? 0 : 1, key = idx * 2 + lod;
        if (this.jobs.has(key)) continue;
        const j = this.job(idx, lod);
        this.runJob(j, Infinity);
        this.jobs.set(key, j);
        // let the loading screen breathe now and then
        if (performance.now() - yielded > 40) { await new Promise((r) => setTimeout(r, 0)); yielded = performance.now(); }
      }
    }
  },

  /** Every instance family the builds add to: {key, levels, material, opts}. */
  families() {
    const G = this.geo, M = this.mats, A = this.att, out = [];
    DESIGNS.forEach((_, i) => out.push(
      { key: `bay${i}`, levels: G.bay[i], material: M.iron, opts: BAY_OPTS },
      { key: `bay${i}p`, levels: G.bay[i], material: M.paint, opts: BAY_OPTS }));
    out.push({ key: 'post', levels: G.post, material: M.ironPost, opts: POST_OPTS });
    out.push({ key: 'postp', levels: G.post, material: M.paintPost, opts: POST_OPTS });
    CORBEL_KEYS.forEach((key, v) => out.push({ key, levels: G.corbel[v], material: this.stoneMat, opts: CORBEL_OPTS }));
    out.push({ key: 'baluster', levels: G.baluster, material: this.stoneMat, opts: BALUSTER_OPTS });
    PLANT_KEYS.forEach((key, k) => out.push({ key, levels: A.plants.levels[k], material: this.amats.plant, opts: PLANT_OPTS }));
    for (const p of A.pooled.values()) out.push({ key: p.key, levels: p.levels, material: this.amats.parts, opts: p });
    return out;
  },

  /** Publishes the console positions under every balcony of `lot` on its facade plan
   *  (plan.balconies[i].consoles = [{u, h, w}], see consolesFor) and returns the plan's
   *  balconies. Pure, deterministic and cached per plan: valid at any time from module
   *  load on (it uses no state of this module), before or after ironwork builds the lot
   *  (buildings places run-off streaks under the consoles, facades keeps open shutter
   *  leaves clear of them). */
  consolesOf(lot) {
    const plan = facadePlan(lot);
    let st = null;
    for (const bal of plan.balconies) {
      if (!bal.consoles) consolesFor(plan, (st ||= lotStyle(lot, plan)), bal);
      if (bal.rust === undefined) bal.rust = railRust(lot, bal);
    }
    return plan.balconies;
  },

  // ---------------------------------------------------------------- chunk jobs
  // A chunk is built in small steps (one balcony, or one facade's attachments) into a
  // job. update() advances the jobs of the chunks the streamer is about to ask for (the
  // next detail upgrades and the far horizon) within a time slice per frame, so build()
  // mostly hands over a finished group; a chunk nobody prepared is built in full on the
  // spot. The content is identical either way (everything is seeded per lot).

  /** New build job for chunk `index` at detail `lod`. */
  job(index, lod) {
    const L = this.app.layout;
    let lots = [...L.inChunk('lots', index), ...L.inChunk('sideLots', index)];
    // side-street facades are seen down the side street: left out of far chunks beyond
    // the corner lots
    if (lod) lots = lots.filter((l) => !(l.sideStreet && l.x0 > 24));
    if (!lots.length) return { index, lod, steps: null, ctx: null, group: null };
    const ctx = {
      lod,                // detail level of the lot being built (may drop below the chunk's)
      chunkLod: lod,
      clutter: true,
      inst: new InstanceCollector(),
      w: this.writers(),
      flags: [],
      bounds: [],         // facade centres (x, y, z, r): culling sphere of the chunk's blocks
    };
    Object.assign(ctx, ctx.w); // ctx.stone, ctx.cards, ctx.parts, ctx.stains, ctx.shadow, ctx.thin
    return { index, lod, steps: this.steps(ctx, lots), ctx, group: undefined };
  },

  /** Writers of a chunk's merged geometry (one per strip). Their contents are copied into
   *  the strips when the chunk is finished, so a few sets, grown to chunk size, are reused. */
  writers() {
    return this.spare.pop() || {
      stone: new GeoWriter(16384, { kind: true }), cards: new GeoWriter(4096), parts: new GeoWriter(32768),
      stains: new GeoWriter(256), shadow: new PosWriter(16384), thin: new PosWriter(2048),
    };
  },

  recycle(w) {
    if (w && this.spare.length < 4) { for (const k in w) w[k].reset(); this.spare.push(w); }
  },

  /** The build steps of a chunk: one per balcony, one per facade's attachments. */
  * steps(ctx, lots) {
    for (const lot of lots) {
      // deep side-street lots get far-range detail; beyond the corner lots (35 m and
      // more from any camera on the main street, at grazing angles) the floor clutter
      // behind the railings is left out: it is hidden by the bars and the slab
      ctx.lod = ctx.chunkLod || (lot.sideStreet && lot.x0 > 60) ? 1 : 0;
      ctx.clutter = !lot.sideStreet || lot.x0 <= 24;
      const plan = facadePlan(lot);
      const st = lotStyle(lot, plan);
      _p.set(lot.frame.width / 2, plan.totalHeight / 2, 0).applyMatrix4(lot.frame.matrix);
      ctx.bounds.push(_p.x, _p.y, _p.z, Math.max(lot.frame.width, plan.totalHeight) / 2);
      for (let i = 0; i < plan.balconies.length; i++) {
        this.balcony(ctx, lot, plan, st, plan.balconies[i], i);
        yield;
      }
      this.facadeAttachments(ctx, lot, plan, st);
      yield;
      // corner returns and chamfered corner faces: window AC units and flower boxes
      for (const r of plan.returns || []) {
        _p.set(r.width / 2, plan.totalHeight / 2, 0).applyMatrix4(r.frame.matrix);
        ctx.bounds.push(_p.x, _p.y, _p.z, Math.max(r.width, plan.totalHeight) / 2);
        this.facadeAttachments(ctx, r, r, st);
      }
    }
  },

  /** Advances a job until `deadline` (performance.now() ms); true once its group is made. */
  runJob(j, deadline) {
    if (j.group !== undefined) return true;
    if (j.steps) {
      for (;;) {
        if (performance.now() > deadline) return false;
        if (j.steps.next().done) break;
      }
      j.steps = null;
    }
    // making the meshes is one step of up to ~0.5 ms: it waits for a fresh slice
    if (performance.now() > deadline - PREFETCH_MS * 0.7) return false;
    j.group = this.finish(j.ctx);
    if (j.group) Object.assign(j.group.userData, { index: j.index, lod: j.lod });
    j.ctx = null;
    return true;
  },

  /** Drops a job that will not be asked for. */
  dropJob(j) {
    if (j.group) this.dispose(j.group);
    else if (j.ctx) this.recycle(j.ctx.w);
  },

  build(chunk) {
    const key = chunk.index * 2 + (chunk.lod ? 1 : 0);
    let j = this.jobs.get(key);
    if (j) this.jobs.delete(key);
    else j = this.job(chunk.index, chunk.lod);
    this.runJob(j, Infinity);
    const g = j.group;
    if (!g) return null;
    // drawn from the moment the streamer shows the chunk (see update / dispose)
    this.live.add(g);
    this.pending.add(g);
    return g;
  },

  /** True once the streamer shows the chunk group a marker belongs to. */
  shown(g) {
    const c = g.parent;
    return !!(c && c.visible && c.parent);
  },

  /** Starts drawing a chunk's blocks, instances and flags. */
  activate(g) {
    this.pending.delete(g);
    const u = g.userData;
    u.active = true;
    for (const [strip, b] of u.blocks) strip.activate(b);
    for (const [pool, e] of u.entries) pool.attach(e);
    if (u.flags) this.flagPool.attach(u.flags);
  },

  /** Brings the instance pools and flags up to date (view culling per chunk, levels,
   *  packing) for this frame's camera (final once cameraRig has run). */
  refresh(force = false) {
    const camera = this.app.camera;
    camera.updateMatrixWorld();
    _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _fr.setFromProjectionMatrix(_pm, camera.coordinateSystem, camera.reversedDepth);
    const L = this.limits(this.lastPx || uIronPx.value), cam = camera.position, P = this.poolList;
    for (let i = 0; i < P.length; i++) { const p = P[i]; p.update(cam, p.cls ? L[p.cls] : null, force, _fr); }
    this.flagPool.flush();
  },

  /** The pool of an instance family (created with its first entry). */
  poolOf(e) {
    let p = this.pools.get(e.key);
    if (!p) {
      this.pools.set(e.key, (p = new InstancePool(e.key, e.levels, e.material, e.opts, this.root)));
      this.poolList.push(p);
    }
    return p;
  },

  /** Prepares the chunks the streamer will ask for next, within a per-frame time slice,
   *  nearest first: a chunk not built yet at the detail the streamer builds it at (full
   *  inside LOD0_DIST), the full-detail upgrade inside LOD0_DIST + 80 m, the next two
   *  chunks beyond the far horizon. Jobs no longer wanted are dropped. */
  prefetch(app) {
    const s = app.cameraS;
    if (s == null) return;
    // (allocation-free per frame: scratch maps, records and callbacks live in this._pf)
    const n = app.layout.nChunks, pf = this._pf;
    if (!pf.have || pf.have.length !== n) pf.have = new Int8Array(n);
    const have = pf.have.fill(-1);
    this.live.forEach(pf.noteLive); // chunk index -> finest detail level built (-1: none)
    pf.n = 0;
    const i0 = Math.floor((s - VIEW_BEHIND) / CHUNK_LEN), i1 = Math.floor((s + VIEW_AHEAD) / CHUNK_LEN);
    for (let i = i0; i <= i1 + 2; i++) {
      const idx = ((i % n) + n) % n;
      const dist = Math.max(0, Math.abs(i * CHUNK_LEN + CHUNK_LEN / 2 - s) - CHUNK_LEN / 2);
      const h = have[idx], first = dist < LOD0_DIST ? 0 : 1;
      if (h < 0) pf.want(idx * 2 + first, idx, first, dist);
      if (dist < LOD0_DIST + 80 && (h < 0 ? first : h) > 0) pf.want(idx * 2, idx, 0, dist);
    }
    if (this.jobs.size) this.jobs.forEach(pf.dropUnwanted);
    const deadline = performance.now() + PREFETCH_MS;
    for (let k = 0; k < pf.n; k++) {
      const w = pf.list[k];
      let j = this.jobs.get(w.key);
      if (!j) { j = this.job(w.idx, w.lod); this.jobs.set(w.key, j); }
      if (!this.runJob(j, deadline)) break;
    }
  },

  /** Scratch state of prefetch(): the wanted builds, nearest first (pf.list[0 .. pf.n),
   *  records reused from frame to frame), and its callbacks. */
  prefetchScratch() {
    const pf = {
      have: null, list: [], n: 0,
      noteLive: (g) => {
        const { index, lod } = g.userData, h = pf.have[index];
        if (h < 0 || lod < h) pf.have[index] = lod;
      },
      // insertion by distance, after equal ones: a chunk's first build stays ahead of its
      // upgrade
      want: (key, idx, lod, dist) => {
        const L = pf.list;
        let w = L[pf.n];
        if (!w) L.push((w = { key: 0, idx: 0, lod: 0, dist: 0 }));
        let k = pf.n++;
        while (k > 0 && L[k - 1].dist > dist) { L[k] = L[k - 1]; k--; }
        L[k] = w;
        w.key = key; w.idx = idx; w.lod = lod; w.dist = dist;
      },
      dropUnwanted: (j, key) => {
        for (let k = 0; k < pf.n; k++) if (pf.list[k].key === key) return;
        this.dropJob(j);
        this.jobs.delete(key);
      },
    };
    return pf;
  },

  /** One balcony: slab, consoles, railing, then what the residents put on it. */
  balcony(ctx, lot, plan, st, bal, index) {
    const { lod, inst } = ctx;
    const F = lot.frame.matrix;
    inst.cluster(); // the balcony's instances are culled together
    const r = new RNG(hash2(lot.seed, 977 + index));
    const { y, slabT: T, depth: D, u0, u1 } = bal;
    const isStone = bal.railing === 'stone';
    const tint = st.tint;
    const dirt = r.range(0.84, 1.0);

    // ---- slab (and its shadow caster): T thick at the wall, its moulded edge E tall
    const rc = isStone && st.roundStone ? Math.min(0.3, D * 0.35) : 0;
    const E = THREE.MathUtils.clamp(T + st.edge, 0.16, 0.22);
    ctx.stone.setMatrix(F).color(tint[0], tint[1], tint[2]);
    writeSlab(ctx.stone, slabPath(u0, u1, D, rc), y, T, E, st.slabVariant, lod, dirt, D, !isStone);
    // (rounded corners of two chords: inside the convex corner)
    writeSlabShadow(ctx.shadow.setMatrix(F), slabPath(u0, u1, D, rc, 0.25, 2), y, T, E, st.slabVariant, lod);

    // ---- consoles: on the piers between the openings below, or shortened to stand on
    // their dressing (see ironwork/consoles.js); their fronts tuck under the drip lip
    const cw = st.corbelW, place = consolesFor(plan, st, bal);
    const variant = place.kind, sz = (D - 0.07) / CORBEL.D, sy = place.h / CORBEL.HV[variant];
    const c = [tint[0] * dirt, tint[1] * dirt, tint[2] * dirt];
    for (const u of place.u) {
      _l.makeScale(cw, sy, sz).setPosition(u, y - T, 0);
      _m.multiplyMatrices(F, _l);
      // far chunks: merged into the stone mesh; near: instanced, carved or light per
      // instance. The light console casts the shadow either way.
      if (lod) writeTemplate(ctx.stone.kind(GRIME.NONE), this.geo.corbelFar[variant], _m, c);
      else inst.add(CORBEL_KEYS[variant], this.geo.corbel[variant], this.stoneMat, _m, c, CORBEL_OPTS);
      writePos(ctx.shadow, this.geo.shadow.corbel[variant], _m);
    }

    // ---- railing
    // (the balustrade draws from its own stream so far/near builds place contents alike)
    if (isStone) this.balustrade(ctx, F, bal, rc, tint, new RNG(hash2(lot.seed, 4111 + index)));
    else this.ironRailing(ctx, lot, bal, st);

    this.balconyContents(ctx, lot, plan, st, bal, index, r);
  },

  /** What the residents keep on a balcony: planter boxes on the rail (or the coping, or
   *  a trough on the floor), pots and potted shrubs, a chair, an AC unit, now and then a
   *  towel or a flag hung down the front of the railing or on a pole. */
  balconyContents(ctx, lot, plan, st, bal, index, r) {
    const { lod } = ctx;
    const F = lot.frame.matrix, A = this.att;
    const { y, depth: D, u0, u1 } = bal;
    const len = u1 - u0, hs = st.railH;
    const iron = bal.railing !== 'stone';
    const top = y + (iron ? RAIL_H * hs : BALUSTRADE.H);
    // a flag hung down the front of the railing (decided alike in near and far builds)
    const flagged = iron ? this.railFlag(ctx, F, lot, bal, st, index, top) : null;
    // does this household plant at all? (decided alike in near and far builds)
    const planted = r.chance(st.greenery);
    let boxes = 0, grow = -1, where = null;
    if (planted && r.chance(0.85)) {
      const col = r.chance(0.6) ? BOXES[st.box] : BOXES[weighted(r, BOX_W)];
      const bl = r.range(0.6, 1.0);
      // boxes along the front: one to a row filling most of it
      const fit = Math.max(1, Math.floor((len - 0.1) / (bl + 0.1)));
      const n = Math.max(1, Math.min(fit, Math.round((len * r.range(0.3, 0.95)) / bl)));
      grow = this.growOf(st, r);
      // hung on the handrail (mostly outside), standing on a balustrade's coping clear of
      // its rounded corners, or (plantings that do not hang) a trough on the floor; boxes
      // stay inside the railing where a flag hangs down its front
      const low = grow === GROW.HERBS || grow === GROW.DRY || grow === GROW.EMPTY;
      where = !iron ? 'coping' : r.weighted([['out', 0.68], ['in', 0.17], ['floor', low ? 0.35 : 0]]);
      if (flagged && where === 'out') where = 'in';
      let lo = u0 + 0.08 + bl / 2, hi = u1 - 0.08 - bl / 2, w, yb;
      if (where === 'coping') {
        const rc = st.roundStone ? Math.min(0.3, D * 0.35) : 0, i = 0.13;
        const e = i + Math.max(0, rc - i * 0.5) + bl / 2 + 0.02;
        lo = u0 + e; hi = u1 - e;
        w = D - i; yb = top;
      } else if (where === 'floor') {
        w = D - 0.2; yb = y;
      } else {
        w = D - 0.05 + (where === 'out' ? 0.13 : -0.13); yb = top - 0.19;
      }
      const trough = where === 'coping' || where === 'floor' ? r.chance(0.6) : false;
      for (let k = 0; k < n; k++) {
        const u = u0 + len * ((k + 0.5) / n) + r.range(-0.12, 0.12) * len / n;
        _pb.multiplyMatrices(F, _l.makeTranslation(lo < hi ? THREE.MathUtils.clamp(u, lo, hi) : (u0 + u1) / 2, yb, w));
        // most households fill their boxes alike
        if (k && r.chance(0.35)) {
          const g = this.growOf(st, r);
          if (where !== 'floor' || g === GROW.HERBS || g === GROW.DRY || g === GROW.EMPTY) grow = g;
        }
        this.planter(ctx, _pb, bl, col, grow, this.tintOf(st, grow, r), trough, r, where === 'in');
        if (!lod && (where === 'out' || where === 'in')) this.part(ctx, A.hooks[where === 'out' ? 0 : 1], _m.multiplyMatrices(_pb, _l.makeScale(bl, 1, 1)));
        boxes++;
      }
    }
    const rec = this.census && !ctx.chunkLod ? {
      planted, boxes, grow, where, flag: !!flagged, pots: 0, shrubs: 0, s: lot.s0, side: lot.side, sideStreet: !!lot.sideStreet, y,
      at: _q.set((u0 + u1) / 2, y, D).applyMatrix4(F).toArray(),
    } : null;
    if (rec) this.census.set(`${lot.seed}:${index}`, rec);
    if (lod || !ctx.clutter) return;
    // an AC unit standing on the balcony floor beside the door
    const door = plan.openings.find((o) => o.balcony === index);
    let acU = null;
    if (door && (door.ac || r.chance(0.08)) && len > 1.6) {
      const side = r.chance(0.5) ? -1 : 1;
      acU = THREE.MathUtils.clamp(door.uc + side * (door.w / 2 + 0.5), u0 + 0.5, u1 - 0.5);
      _l.makeTranslation(acU, y + 0.06, -0.06);
      this.acUnit(ctx, _m.multiplyMatrices(F, _l), false);
    }
    // potted shrubs in the back corners beside the door (an oleander, a lemon tree, a
    // myrtle), in keen households above all
    const shrubs = [];
    if (D > 0.55 && len > 1.3 && (planted ? r.chance(0.42) : r.chance(0.04))) {
      const both = len > 2.4 && r.chance(0.35);
      const first = r.chance(0.5) ? -1 : 1;
      for (const side of both ? [-1, 1] : [first]) {
        const s = r.range(1.45, 1.85);
        const u = side < 0 ? u0 + 0.12 + 0.14 * s : u1 - 0.12 - 0.14 * s;
        if (acU !== null && Math.abs(u - acU) < 0.75) continue;
        if (door && Math.abs(u - door.uc) < door.w / 2 + 0.1 && D < 1.0) continue;
        const w = Math.min(0.14 * s + 0.08, D * 0.45);
        _l.makeRotationY(r.range(0, 6.28)).scale(_a.set(s, s * r.range(0.95, 1.15), s)).setPosition(u, y, w);
        this.part(ctx, A.pot, _m.multiplyMatrices(F, _l), POTS[(st.pots + (r.chance(0.3) ? 2 : 0)) % POTS.length]);
        const k = r.range(0.75, 1.15);
        _l.makeRotationY(r.range(0, 6.28)).scale(_a.set(k * r.range(0.85, 1.1), k, k * r.range(0.85, 1.1))).setPosition(u, y + 0.2 * s, w);
        this.plant(ctx, PLANT.SHRUB, _m.multiplyMatrices(F, _l), SHRUB_BLOOM[r.int(0, SHRUB_BLOOM.length - 1)]);
        shrubs.push(u);
      }
      if (rec) rec.shrubs = shrubs.length;
    }
    const clearOfShrubs = (u, gap) => shrubs.every((x) => Math.abs(u - x) > gap);
    // pots on the floor along the front, inside the railing: in many planted households,
    // and now and then a forgotten one on a bare balcony
    if (planted ? r.chance(0.55) : r.chance(0.06)) {
      const n = planted ? r.int(1, Math.max(1, Math.min(4, Math.floor(len / 0.45)))) : 1;
      const potCol = POTS[(st.pots + (r.chance(0.2) ? 1 : 0)) % POTS.length];
      for (let k = 0; k < n; k++) {
        const u = u0 + 0.3 + (len - 0.6) * ((k + r.range(0.3, 0.7)) / n);
        // (clear of a trough standing along the front)
        const w = where === 'floor' ? Math.max(0.2, D - r.range(0.45, 0.52)) : D - r.range(0.25, 0.32);
        const s = r.range(0.8, 1.2);
        const rot = r.range(0, 6.28), col = r.chance(0.7) ? potCol : POTS[r.int(0, POTS.length - 1)];
        // a geranium (not every one in bloom), a herb, a dried-out one or bare soil
        const what = planted ? r.weighted([[PLANT.POT, 0.58], [PLANT.HERB, 0.24], [PLANT.DRY, 0.08], [-1, 0.1]])
          : r.weighted([[PLANT.DRY, 0.5], [-1, 0.3], [PLANT.HERB, 0.2]]);
        const rot2 = r.range(0, 6.28);
        const tint = what === PLANT.POT ? (r.chance(0.75) ? this.flower(st, r) : LEAFY)
          : what === PLANT.HERB ? HERBS[weighted(r, HERB_W)] : WITHERED[r.int(0, WITHERED.length - 1)];
        if (!clearOfShrubs(u, 0.42)) continue;
        _l.makeRotationY(rot).scale(_a.set(s, s, s)).setPosition(u, y, w);
        this.part(ctx, A.pot, _m.multiplyMatrices(F, _l), col);
        if (rec) rec.pots++;
        if (what < 0) continue;
        _l.makeRotationY(rot2).scale(_a.set(s, s, s)).setPosition(u, y + 0.2 * s, w);
        this.plant(ctx, what, _m.multiplyMatrices(F, _l), tint);
      }
    }
    // a plastic chair (where no trough or shrub takes the room)
    if (r.chance(0.1) && D > 0.75 && where !== 'floor') {
      const u = u0 + len * r.range(0.2, 0.8);
      _l.makeRotationY(r.range(-0.6, 0.6) + (r.chance(0.5) ? 0 : Math.PI)).setPosition(u, y, D * 0.5);
      if (clearOfShrubs(u, 0.6)) this.part(ctx, A.chair, _m.multiplyMatrices(F, _l), CHAIRS[r.int(0, CHAIRS.length - 1)]);
    }
    // a towel or rug airing over the front rail (not over a flag)
    if (iron && r.chance(0.04) && !flagged) {
      _l.makeScale(r.range(0.5, 0.9), 1, 1).setPosition(u0 + len * r.range(0.25, 0.75), top, D - 0.05);
      const ti = r.int(0, TOWELS.length - 1), T = A.towels[(ti + st.design) % A.towels.length];
      this.part(ctx, lod ? T.far : T.near, _m.multiplyMatrices(F, _l), TOWELS[ti]);
    }
    // a small flag on a pole tied to the outside of a front corner post, leaning out
    // of the facade (clear of the railing and of the balcony beside it)
    if (iron && !flagged && r.chance(0.015)) {
      const side = r.chance(0.5) ? -1 : 1;
      const u = side < 0 ? u0 - 0.03 : u1 + 0.03;
      this.flag(ctx, F, plan, u, y + 0.32, D - 0.05, 0.6, this.flagDesign(st, r), r.range(0, 30), r.range(38, 52), bal);
    }
  },

  /** A flag hung flat down the front of an iron railing, tied over the handrail at its
   *  top corners: in the households of the building that hang one (st.flagK), on the
   *  front run clear of the posts. Its own stream, so near and far builds hang it alike.
   *  Returns [u0, u1] of the cloth, or null. */
  railFlag(ctx, F, lot, bal, st, index, top) {
    const { depth: D, u0, u1 } = bal;
    if (u1 - u0 < 1.1 || st.flagK <= 0) return null;
    const rf = new RNG(hash2(lot.seed, 0x3c51 + index));
    if (!rf.chance(st.flagK)) return null;
    const s = rf.range(0.95, 1.25), wF = FLAG_H * s;
    const room = u1 - u0 - 0.24 - wF;
    if (room < 0) return null;
    // at the middle of the front, or nearer one end
    const t = rf.chance(0.45) ? 0.5 : rf.chance(0.5) ? rf.range(0, 0.2) : rf.range(0.8, 1);
    const a = u0 + 0.12 + room * t, b = a + wF;
    // cloth frame: x down the front (leaning out a little, clear of the slab edge), y
    // along the rail from its right-hand tie (the hoist runs y 0 .. -H), z out
    _a.set(0, -1, 0.05).normalize().transformDirection(F).multiplyScalar(s);
    _b.set(1, 0, 0).transformDirection(F).multiplyScalar(s);
    _c.crossVectors(_a, _b).normalize().multiplyScalar(s);
    _p.set(b, top + 0.02, D - 0.012).applyMatrix4(F);
    _m.makeBasis(_a, _b, _c).setPosition(_p);
    ctx.flags.push({ m: _m.clone(), uv: FLAG_UV[this.flagDesign(st, rf)], phase: 100 + rf.range(0, 30) });
    return [a, b];
  },

  /** A flag's design: mostly the building's own. */
  flagDesign(st, r) { return r.chance(0.75) ? st.flag : weighted(r, FLAG_W); },

  /** Window AC units, window flower boxes, flags and satellite dishes of one facade
   *  (`lot` needs only {seed, frame}: a corner return passes itself as both). */
  facadeAttachments(ctx, lot, plan, st) {
    const { lod } = ctx;
    const F = lot.frame.matrix, A = this.att;
    const r = new RNG(hash2(lot.seed, 0x5eed));
    for (const o of plan.openings) {
      if (o.kind !== 'window') continue;
      ctx.inst.cluster(); // each window's attachments are culled together
      if (o.ac) {
        // under one side of the window, clear of the sill and its corbels; where the unit
        // or its brackets reach a string course it stands off the wall in front of it
        const u = o.uc + (r.chance(0.5) ? -1 : 1) * (o.w / 2 + 0.05) * r.range(0.45, 0.9);
        const top = o.y - 0.37, bot = top - 0.55 - 0.22;
        let w = -0.02;
        for (const c of plan.courses) if (c.y < top && c.y + c.h > bot) w = Math.max(w, c.proj - 0.07);
        _l.makeTranslation(u, top - 0.55, w);
        this.acUnit(ctx, _m.multiplyMatrices(F, _l), true);
      }
      if (o.flowerBox) this.sillBox(ctx, lot, st, o, F);
    }
    for (const f of plan.flags) {
      const u = flagPier(plan, f);
      if (u !== null) this.flag(ctx, F, plan, u, f.y, 0, 1, this.flagDesign(st, r), r.range(0, 30), r.range(30, 45));
    }
    // satellite dish on the top floor, only where the facade can see the satellite: the
    // mount square to the wall on a pier, the dish clamped to its mast and turned to the
    // satellite (far builds place the same dishes, coarse)
    if (r.chance(0.14) && plan.bays.length > 1) {
      _a.copy(lot.frame.nDir);
      if (_a.dot(_b.set(DISH_DIR.x, 0, DISH_DIR.z).normalize()) > 0.25) {
        const fl = plan.floors[plan.floors.length - 1];
        const k = r.int(1, plan.bays.length - 1);
        const u = plan.bays[k].u0, v = fl.y + r.range(1.1, 1.8);
        const paint = DISH_PAINT[r.weighted(DISH_PAINT_W)];
        this.part(ctx, lod ? A.dishMountFar : A.dishMount, _m.multiplyMatrices(F, _l.makeTranslation(u, v, DISH_W)));
        _p.set(u, v, DISH_W).applyMatrix4(F);
        _l.lookAt(_c.set(0, 0, 0), _q.copy(DISH_AIM).negate(), _b.set(0, 1, 0)).setPosition(_p);
        this.part(ctx, lod ? A.dishFar : A.dish, _l, paint);
      }
    }
  },

  /** A planter standing on a window sill, half inside the reveal, where the plan has one
   *  and the household plants (the building's greenery decides, as on its balconies). */
  sillBox(ctx, lot, st, o, F) {
    const r = new RNG(hash2(lot.seed, hash2(Math.round(o.uc * 100), Math.round(o.y * 100))));
    const planted = r.chance(Math.min(1, st.greenery * 2.2));
    if (this.census && !ctx.chunkLod) this.census.set(`${lot.seed}:w${o.uc.toFixed(2)}:${o.y.toFixed(2)}`, { sill: true, planted });
    if (!planted) return;
    let grow = this.growOf(st, r);
    if (grow === GROW.BOUG) grow = GROW.GREEN;
    const col = r.chance(0.6) ? BOXES[st.box] : BOXES[weighted(r, BOX_W)];
    _pb.multiplyMatrices(F, _l.makeTranslation(o.uc, o.y + 0.012, 0.03));
    this.planter(ctx, _pb, o.w + 0.06, col, grow, this.tintOf(st, grow, r), r.chance(0.6), r);
  },

  /** What a household grows (GROW), after the building's leaning. */
  growOf(st, r) { return weighted(r, st.grow); },

  /** Geranium colour: the building's favourite, or any. */
  flower(st, r) { return FLOWERS[r.chance(0.7) ? st.flowers : weighted(r, FLOWER_W)]; },

  /** Tint of a planting's flowering parts. */
  tintOf(st, grow, r) {
    switch (grow) {
      case GROW.GERANIUM: return this.flower(st, r);
      case GROW.HERBS: return HERBS[weighted(r, HERB_W)];
      case GROW.GREEN: return TRAIL_GREEN;
      case GROW.SURFINIA: return SURFINIA[r.int(0, SURFINIA.length - 1)];
      case GROW.BOUG: return BOUG[weighted(r, BOUG_W)];
      default: return WITHERED[r.int(0, WITHERED.length - 1)];
    }
  },

  /** Planter box or trough (`base`: its foot, unscaled; `len` its length along x) and what
   *  grows in it (GROW, tint). Whole-box plantings (0.8 m long) are fitted to the length,
   *  mirrored at random, and hang over the front edge (over the back with `inward`: a box
   *  hung inside the railing); herbs and dried-out plants are pot-sized clumps along it, a
   *  gap here and there. The far chunks use the same instanced plants (their light levels)
   *  and the same draws, so nothing changes when a chunk is rebuilt at full detail. */
  planter(ctx, base, len, col, grow, tint, trough, r, inward = false) {
    const A = this.att;
    this.part(ctx, trough ? A.trough : A.box, _pl.multiplyMatrices(base, _l.makeScale(len, 1, 1)), col);
    const soil = trough ? TROUGH_SOIL : BOX_SOIL;
    if (grow === GROW.EMPTY) return;
    if (grow === GROW.HERBS || grow === GROW.DRY) {
      const n = Math.max(1, Math.round(len / 0.27));
      for (let k = 0; k < n; k++) {
        if (n > 1 && r.chance(0.1)) continue;
        const s = r.range(0.85, 1.1) * (trough ? 0.9 : 1);
        _l.makeRotationY(r.range(0, 6.28)).scale(_pv.set(s * 0.85, s, s * 0.85))
          .setPosition(len * ((k + 0.5) / n - 0.5) + r.range(-0.03, 0.03), soil, r.range(-0.015, 0.015));
        this.plant(ctx, grow === GROW.HERBS ? PLANT.HERB : PLANT.DRY, _pl.multiplyMatrices(base, _l), k && r.chance(0.3) ? this.tintOf(null, grow, r) : tint);
      }
      return;
    }
    const kind = grow === GROW.GERANIUM ? PLANT.BOX : grow === GROW.BOUG ? PLANT.BOUG : PLANT.TRAIL;
    const n = Math.max(1, Math.round(len / 0.85)), sx = len / (n * 0.8);
    for (let k = 0; k < n; k++) {
      _l.makeRotationY(inward ? Math.PI : 0).scale(_pv.set(r.chance(0.5) ? sx : -sx, 1, 1)).setPosition(len * ((k + 0.5) / n - 0.5), soil, 0);
      this.plant(ctx, kind, _pl.multiplyMatrices(base, _l), tint);
    }
  },

  /** Instanced planting (PLANT family): full, light and far versions per instance. */
  plant(ctx, kind, m, tint) {
    const P = this.att.plants;
    ctx.inst.add(PLANT_KEYS[kind], P.levels[kind], this.amats.plant, m, tint, PLANT_OPTS);
  },

  /** A part into the merged parts mesh (or its instance pool), and its stand-in into the
   *  shadow caster it belongs to (solid, or small / thin for the fine cascades). Far
   *  chunks' parts cast no shadow (planters and AC bodies a few pixels tall). */
  part(ctx, t, m, tint = WHITE) {
    const A = this.att, pooled = A.pooled.get(t);
    if (pooled) ctx.inst.add(pooled.key, pooled.levels, this.amats.parts, m, tint, pooled);
    else writeTemplate(ctx.parts, t, m, tint);
    if (ctx.chunkLod) return;
    const c = A.cast.get(t);
    if (c) writePos(ctx.shadow, c, m);
    else { const th = A.thin.get(t); if (th) writePos(ctx.thin, th, m); }
  },

  /** Split AC unit (matrix: unit frame on the wall): textured body, pipes, brackets
   *  (instanced, see attach.js), their shadow stand-ins and the wall stain. */
  acUnit(ctx, m, wallMounted) {
    const A = this.att, P = A.pooled.get(wallMounted ? 'acWall' : 'acFloor');
    ctx.inst.add(P.key, P.levels, this.amats.parts, m, wallMounted ? WHITE : [0.92, 0.92, 0.92], P);
    if (ctx.chunkLod) return;
    writePos(ctx.shadow, A.cast.get(A.acBody), m);
    if (ctx.lod) return; // pipes and brackets are sub-pixel beyond 200 m
    writePos(ctx.thin, A.thin.get(A.acPipes), m);
    if (wallMounted) {
      writePos(ctx.thin, A.thin.get(A.acBrackets), m);
      writeTemplate(ctx.stains, A.acStain, m);
    }
  },

  /** Flag on an angled pole: bracket at facade (u, v, w), the pole out of the wall and
   *  up at `elDeg`, the cloth (`size`: scale of the FLAG_L x FLAG_H template) hanging from
   *  its upper part; `design` an atlas cell, `phase` its motion. The pole is raised, then
   *  the flag made smaller, where the pole or the hanging cloth would meet a balcony of
   *  the plan (`own`: the balcony whose corner post the pole is tied to, met only by the
   *  cloth); else no flag. Returns true once placed. */
  flag(ctx, F, plan, u, v, w, size, design, phase, elDeg, own = null) {
    let el = -1, s = size;
    for (const [e, k] of [[elDeg, 1], [Math.max(elDeg, 52), 1], [60, 0.85], [62, 0.7]]) {
      const er = THREE.MathUtils.degToRad(e);
      if (flagClear(plan, u, v, w, er, size * k, own)) { el = er; s = size * k; break; }
    }
    if (el < 0) return false;
    // pole direction p and the cloth's fly direction q (square to the pole, down and out)
    // in facade space (u, v, w), then to world; the frames are right-handed
    const p = _a.set(0, Math.sin(el), Math.cos(el)).transformDirection(F);
    const q = _b.set(0, -Math.cos(el), Math.sin(el)).transformDirection(F);
    const n = _c.crossVectors(q, p);
    const base = _p.set(u, v, w).applyMatrix4(F);
    // pole (template is along +y); a 3 cm pole is sub-pixel in far chunks
    _l.makeBasis(q, p, n).setPosition(base);
    if (!ctx.lod) this.part(ctx, this.att.pole, _l);
    // cloth: local x = fly (q), y = along the pole (p), hoist top at 1.85 m up the pole
    _m.makeBasis(_q.copy(q).multiplyScalar(s), _pv.copy(p).multiplyScalar(s), _c.multiplyScalar(s)).setPosition(base.addScaledVector(p, 1.85));
    ctx.flags.push({ m: _m.clone(), uv: FLAG_UV[design], phase });
    return true;
  },

  ironRailing(ctx, lot, bal, st) {
    const { lod, inst } = ctx;
    const F = lot.frame.matrix;
    const { y, depth: D, u0, u1 } = bal;
    const design = DESIGNS[st.design];
    const painted = st.paint >= 0;
    const mat = painted ? this.mats.paint : this.mats.iron;
    const postMat = painted ? this.mats.paintPost : this.mats.ironPost;
    // (black iron instances are white: every railing pool has instance colours)
    const color = painted ? PAINTS[st.paint] : WHITE;
    const hs = st.railH;
    const i = 0.05; // railing centre line inset from the slab edge
    const rp = [[u0 + i, 0], [u0 + i, D - i], [u1 - i, D - i], [u1 - i, 0]];
    const cw = ctx.cards.setMatrix(F);
    const cc = painted ? color : this.mats.ironColor();
    cw.color(cc[0], cc[1], cc[2]);
    const vb = atlasV(st.design, 0), vt = atlasV(st.design, RAIL_H);
    const bayKey = `bay${st.design}${painted ? 'p' : ''}`, postKey = painted ? 'postp' : 'post';
    for (let k = 0; k < rp.length - 1; k++) {
      const A = rp[k], B = rp[k + 1];
      const du = B[0] - A[0], dw = B[1] - A[1], len = Math.sqrt(du * du + dw * dw);
      if (len < 0.08) continue;
      const tu = du / len, tw = dw / len;
      const nb = Math.max(1, Math.round(len / design.W)), sx = len / (nb * design.W);
      if (!lod) {
        for (let b = 0; b < nb; b++) {
          const o = b * design.W * sx;
          _l.set(tu * sx, 0, -tw, A[0] + tu * o, 0, hs, 0, y, tw * sx, 0, tu, A[1] + tw * o, 0, 0, 0, 1);
          inst.add(bayKey, this.geo.bay[st.design], mat, _m.multiplyMatrices(F, _l), color, BAY_OPTS);
        }
      }
      // card for this run (also casts the railing shadow at every distance)
      const nx = -tw, nz = tu, yt = y + RAIL_H * hs;
      const a = cw.v(A[0], y, A[1], nx, 0, nz, 0, vb), b = cw.v(B[0], y, B[1], nx, 0, nz, nb, vb);
      const c = cw.v(B[0], yt, B[1], nx, 0, nz, nb, vt), d = cw.v(A[0], yt, A[1], nx, 0, nz, 0, vt);
      cw.quad(a, b, c, d);
    }
    // corner and wall-end posts: two crossed sprite quads each on the cards, geometry near
    const pv0 = atlasV(ATLAS.POST_ROW, 0), pv1 = atlasV(ATLAS.POST_ROW, RAIL_H + 0.1), ph = ATLAS.POST_W / 2;
    for (const P of rp) {
      for (const [eu, ew] of POST_FACES) {
        const yt = y + (RAIL_H + 0.1) * hs;
        const a = cw.v(P[0] - eu * ph, y, P[1] - ew * ph, -ew, 0, eu, 0, pv0), b = cw.v(P[0] + eu * ph, y, P[1] + ew * ph, -ew, 0, eu, 1, pv0);
        const c = cw.v(P[0] + eu * ph, yt, P[1] + ew * ph, -ew, 0, eu, 1, pv1), d = cw.v(P[0] - eu * ph, yt, P[1] - ew * ph, -ew, 0, eu, 0, pv1);
        cw.quad(a, b, c, d);
      }
      if (!lod) {
        _l.makeScale(1, hs, 1).setPosition(P[0], y, P[1]);
        inst.add(postKey, this.geo.post, postMat, _m.multiplyMatrices(F, _l), color, POST_OPTS);
      }
    }
  },

  balustrade(ctx, F, bal, rc, tint, r) {
    const { lod, inst } = ctx;
    const { y, depth: D, u0, u1 } = bal;
    const i = 0.13;
    const path = slabPath(u0 + i, u1 - i, D - i, Math.max(0, rc - i * 0.5), 0.04);
    const S = ctx.stone, SW = ctx.shadow;
    S.setMatrix(_m.multiplyMatrices(F, _l.makeTranslation(0, y, 0)));
    SW.setMatrix(_m);
    S.color(tint[0], tint[1], tint[2]);
    sweepPath(S, path, plinthProfile(), { shadeFn: (o, v) => (v < 0.02 ? 0.8 : 0.95) });
    sweepPath(S, path, copingProfile(lod), { shadeFn: (o, v) => (v < BALUSTRADE.H - BALUSTRADE.COPING + 0.01 ? 0.75 : 1) });
    // pedestals at the wall ends and the front corners
    const hP = BALUSTRADE.H - BALUSTRADE.PLINTH - BALUSTRADE.COPING;
    const ped = [path[0], path[path.length - 1]];
    if (rc <= 0.01) ped.push(path[1], path[2]);
    for (const P of ped) box(S, P[0], BALUSTRADE.PLINTH + hP / 2, P[1], 0.2, hP, 0.2, 0.85, 'ud');
    writeBalustradeShadow(SW, rc > 0.01 ? slabPath(u0 + i, u1 - i, D - i, Math.max(0, rc - i * 0.5), 0.04, 2) : path, ped);
    // far: one darkened panel per run stands in for the row of balusters (at 200 m and
    // beyond they read as a mid-tone band anyway)
    if (lod) {
      S.color(tint[0] * 0.72, tint[1] * 0.72, tint[2] * 0.72);
      const y0 = BALUSTRADE.PLINTH, y1 = BALUSTRADE.H - BALUSTRADE.COPING;
      for (let k = 0; k < path.length - 1; k++) {
        const A = path[k], B = path[k + 1];
        const du = B[0] - A[0], dw = B[1] - A[1], l = Math.sqrt(du * du + dw * dw) || 1;
        const nx = -dw / l, nz = du / l;
        for (const sg of [1, -1]) {
          const a = S.v(A[0], y0, A[1], nx * sg, 0, nz * sg, 0, y0), b = S.v(B[0], y0, B[1], nx * sg, 0, nz * sg, l, y0);
          const c = S.v(B[0], y1, B[1], nx * sg, 0, nz * sg, l, y1), d = S.v(A[0], y1, A[1], nx * sg, 0, nz * sg, 0, y1);
          if (sg > 0) S.quad(a, b, c, d); else S.quad(b, a, d, c);
        }
      }
      // (no shadow for the panel: balusters are thin casters, and what it would shade
      // lies behind it)
      return;
    }
    // balusters along the path, kept clear of the pedestals
    const col = [tint[0], tint[1], tint[2]];
    for (let k = 0; k < path.length - 1; k++) {
      const A = path[k], B = path[k + 1];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const n = Math.floor(len / BALUSTRADE.SPACING);
      if (n < 1) continue;
      const step = len / n;
      for (let j = 0; j <= n; j++) {
        const t = (j * step) / len;
        const u = A[0] + (B[0] - A[0]) * t, w = A[1] + (B[1] - A[1]) * t;
        let clash = false;
        for (let q = 0; q < ped.length && !clash; q++) { const du = ped[q][0] - u, dw = ped[q][1] - w; clash = du * du + dw * dw < 0.17 * 0.17; }
        if (clash) continue;
        if (j === n && k < path.length - 2) continue; // shared with the next segment
        _l.makeRotationY(r.range(0, Math.PI)).setPosition(u, y + BALUSTRADE.PLINTH, w);
        inst.add('baluster', this.geo.baluster, this.stoneMat, _m.multiplyMatrices(F, _l), col, BALUSTER_OPTS);
        writePos(ctx.thin, this.geo.shadow.baluster, _m);
      }
    }
  },

  /** Hands a finished chunk's geometry to the strips (inactive blocks: vertex data is
   *  uploaded now, drawing starts on activate) and returns its marker group, or null. */
  finish(ctx) {
    // one conservative sphere for all of the chunk's blocks (cheaper than scanning vertices)
    const sphere = boundsOf(ctx.bounds);
    const blocks = [], S = ctx.chunkLod ? this.strips.far : this.strips.near;
    for (const k in S) {
      const b = S[k].alloc(ctx.w[k], sphere);
      if (b) blocks.push([S[k], b]);
    }
    const entries = ctx.inst.entries().map((e) => [this.poolOf(e), e]);
    let flags = null;
    if (ctx.flags.length) {
      // matrices plus the per-flag design offset and wave phase
      const n = ctx.flags.length;
      flags = { n, m: new Float32Array(n * 16), a: new Float32Array(n * 3), box: new THREE.Box3() };
      ctx.flags.forEach((f, i) => {
        f.m.toArray(flags.m, i * 16);
        flags.a[i * 3] = f.uv[0]; flags.a[i * 3 + 1] = f.uv[1]; flags.a[i * 3 + 2] = f.phase;
        flags.box.expandByPoint(_p.setFromMatrixPosition(f.m));
      });
    }
    this.recycle(ctx.w);
    if (!blocks.length && !entries.length && !flags) return null;
    const g = new THREE.Group();
    g.name = 'ironwork';
    Object.assign(g.userData, { blocks, entries, flags, active: false, lod: ctx.chunkLod });
    return g;
  },

  /** Releases a chunk's blocks, instances and flags. When an upgraded chunk replaces this
   *  one, the streamer has just shown it: it starts drawing in the same frame. */
  dispose(g) {
    this.live.delete(g);
    this.pending.delete(g);
    const u = g.userData;
    for (const [strip, b] of u.blocks || []) strip.free(b);
    for (const [pool, e] of u.entries || []) pool.detach(e);
    if (u.flags) this.flagPool.detach(u.flags);
    u.blocks = u.entries = null; u.flags = null;
    for (const p of this.pending) if (p.userData.index === u.index && this.shown(p)) this.activate(p);
    this.refresh();
  },

  /** Distance limits per detail class for the current projection (see header). The
   *  railing bays' last limit shrinks with the view angle (mats.js angleK). */
  limits(px) {
    // (cached: the table changes with the projection only)
    const c = this._lim;
    if (c && c.px === px && c.ipx === uIronPx.value && c.gk === uIronGeoK.value) return c.L;
    const geo = geoLimit() + 0.5;
    const d1 = (TOL[1] * px) / 0.4, d2 = (TOL[2] * px) / 0.4;
    const carve = (0.01 * px) / 0.6; // what the light levels leave out (~1 cm) is under 0.6 px
    // far plants once the light level's leaves (14 cm) are under 2 px; planter hook
    // straps (2.6 cm) and AC pipes (3.6 cm) go once they are under a pixel
    const L = {
      rail: Object.assign([d1, d2, geo], { angleK }), post: [d2, geo], carve: [carve, Infinity], plant: [carve, 0.07 * px, Infinity],
      strap: [0.026 * px], ac: [0.036 * px, Infinity],
    };
    this._lim = { px, ipx: uIronPx.value, gk: uIronGeoK.value, L };
    return L;
  },

  update(dt, app) {
    // projected pixels per metre at 1 m distance
    app.renderer.getDrawingBufferSize(_sz);
    const px = 0.5 * _sz.y * app.camera.projectionMatrix.elements[5];
    uIronPx.value = px;
    const post = app.post;
    uIronA2C.value = post && !post.disabled && post.sceneRT ? post.sceneRT.samples | 0 : 0;
    // a zoom changes every limit; otherwise an entry is revisited once the camera has
    // moved further than the slack its last partition left
    const zoomed = Math.abs(px - this.lastPx) > 0.01 * px;
    if (zoomed) this.lastPx = px;
    this.prefetch(app);
    if (this.pending.size) for (const g of this.pending) if (this.shown(g)) this.activate(g);
    this.refresh(zoomed);
  },
};

export default ironwork;
