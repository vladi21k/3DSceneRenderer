import * as THREE from 'three';
import { RNG, hash2 } from '../../../core/rng.js';
import { propMaterials, packColor, packLook, FLAG } from './shading.js';
import { BIKE_SPECS, makeBikeVariant, bikeAttachments } from './bicycle.js';
import { STROLLER_SPECS, makeStrollerVariant, strollerAttachments } from './stroller.js';
import { PropInstancer, propMatrix, pxPerMetre, LOD_PX } from './instancer.js';
import { setParkedKit } from './parked.js';

// Mobility props for the figures: bicycles and strollers (geometry, materials, animation
// pivots, rider / pusher attachment points) plus parked bicycles per chunk.
//
//   const bikes = createBicycleKit(THREE, app.materials, seed);
//   const look = bikes.pick(propSeed, { riderHeight });          // variant + colours (deterministic)
//   const inst = bikes.createInstancer({ capacity: 64 });  app.scene.add(inst.object);
//   per frame: inst.begin(camera, renderer);
//              bikes.matrix(M, x, y, z, heading, lean, pitch);    // prop-local origin: ground under the bottom bracket
//              bikes.anim(A, look.variant, { roll, crank, steer, saddle });
//              inst.add(look.variant, M, A, look.look);
//              inst.end();
//   rider IK targets: bikes.attachments(look.variant, crank, steer, saddle) (prop-local; apply M)
//
// Strollers work the same way (createStrollerKit; anim from { roll, swivel }; attachments give
// the handle grips; the prop origin is the ground below the middle of the handle).
// Parked bicycles: buildParkedBicycles(chunk, app) from humans.build, disposeParkedBicycles(obj)
// from humans.dispose (see parked.js).

export { FLAG, propMatrix, pxPerMetre, LOD_PX };

const TAU = Math.PI * 2;

function jitterHex(hex, r, amount = 0.05) {
  const c = new THREE.Color(hex);
  const k = 1 + (r.next() * 2 - 1) * amount;
  c.r = Math.min(1, c.r * k); c.g = Math.min(1, c.g * k); c.b = Math.min(1, c.b * k);
  return c.getHex();
}

const ACCENT = { black: '#161718', cream: '#e6dec9', silver: '#a9adb0', white: '#efefec' };
// adult variant weights on this street (city / commuter bikes dominate)
const BIKE_WEIGHTS = { city: 0.3, dutch: 0.1, road: 0.1, hybrid: 0.25, ebike: 0.25, kids: 0 };

/**
 * Bicycle kit. Variants: city step-through (fenders, chain guard, rack, wire basket, dynamo lamp),
 * classic twin-tube roadster (full chain case), road bike (drop bars), hybrid (flat bar), kids' 20"
 * bike, electric city bike (mid motor, battery, suspension fork). Each with 3 LODs.
 */
export function createBicycleKit(THREE_ = THREE, materials = null, rngSeed = 1) {
  void THREE_;
  const t0 = performance.now();
  const mats = propMaterials(materials);
  const variants = BIKE_SPECS.map((spec) => {
    const v = makeBikeVariant(spec);
    v.reach = 1.25;
    return v;
  });
  const byId = Object.fromEntries(variants.map((v, i) => [v.id, i]));
  const kit = {
    kind: 'bicycle',
    variants, byId, mats, material: mats.mat, depthMaterial: mats.depth,
    buildMs: 0,

    /**
     * Deterministic choice for a prop seed: {variant, colorA, colorB, finish, wear, look}.
     * opts.child picks the kids' bike; opts.riderHeight (m) excludes frames that do not fit;
     * opts.parked sets the kickstand flag.
     */
    pick(seed, { child = false, riderHeight = null, parked = false, variant = null } = {}) {
      const r = new RNG(hash2(seed | 0, 0x6b1c ^ (rngSeed | 0)));
      let vi = variant !== null ? (typeof variant === 'string' ? byId[variant] : variant) : -1;
      if (vi < 0 || vi === undefined) {
        if (child || (riderHeight && riderHeight < 1.45)) vi = byId.kids;
        else {
          const items = variants.map((v, i) => [i, BIKE_WEIGHTS[v.id] || 0])
            .filter(([i]) => !riderHeight || (riderHeight >= variants[i].spec.rider[0] - 0.05 && riderHeight <= variants[i].spec.rider[1] + 0.1));
          vi = r.weighted(items.length ? items : [[byId.city, 1]]);
        }
      }
      const spec = variants[vi].spec;
      const colorA = jitterHex(r.pick(spec.paints), r, 0.06);
      const acc = r.pick(spec.accent);
      const colorB = acc === 'same' ? colorA : jitterHex(ACCENT[acc] || acc, r, 0.04);
      const finish = r.pick(spec.finishes);
      const wear = r.int(1, 5);
      const flags = parked && spec.extras.stand ? FLAG.STAND : 0;
      return { variant: vi, colorA, colorB, finish, wear, flags, look: [packColor(colorA), packColor(colorB), packLook(finish, wear, flags)] };
    },

    /** Re-pack a look's flags (e.g. kickstand down when parked). */
    setFlags(p, flags) { p.flags = flags; p.look[2] = packLook(p.finish, p.wear, flags); return p; },

    /** Animation vector: roll = distance rolled (m), crank (rad), steer (rad, + left), saddle (m along the seat tube). */
    anim(out, v, { roll = 0, wheel = null, crank = 0, steer = 0, saddle = 0 } = {}) {
      const R = variants[v].dims.wheelRadius;
      const a = wheel !== null ? wheel : (roll / R) % TAU;
      out[0] = a; out[1] = saddle; out[2] = crank % TAU; out[3] = steer;
      return out;
    },

    /** Saddle offset (m along the seat tube) that fits a rider of this height. */
    saddleFor(v, riderHeight) {
      const V = variants[v];
      const L = V.layout;
      const cur = (V.spec.saddleH - L.bb.y) / L.seatDir.y;     // BB -> saddle top along the tube
      const want = 0.41 * riderHeight * (V.spec.adult ? 1 : 1.02);
      const [a, b] = V.dims.saddleRange;
      return Math.max(a, Math.min(b, want - cur));
    },

    /** Metres travelled per crank revolution (the rider's cadence: phase += speed / cycleLength). */
    cycleLength(v) { return variants[v].dims.metersPerCrankRev; },

    /** Rider contact points in prop-local space (see bicycle.js bikeAttachments). */
    attachments(v, crank = 0, steer = 0, saddle = 0, out = {}) { return bikeAttachments(variants[v], crank, steer, saddle, out); },

    matrix: propMatrix,
    createInstancer(opts = {}) { return new PropInstancer(kit, { name: 'bicycles', ...opts }); },
  };
  kit.buildMs = performance.now() - t0;
  scheduleLod0(variants);
  return kit;
}

/** Build the close-up LODs in the background, one variant per idle slice. */
function scheduleLod0(variants) {
  let i = 0;
  const step = () => {
    if (i >= variants.length) return;
    try { variants[i++].ensureLod0(); } catch (e) { console.warn('[props] close-up LOD build failed', e); }
    setTimeout(step, 30);
  };
  setTimeout(step, 200);
}

/**
 * Stroller kit. Variants: modern 4-wheel pushchair (canopy, basket), jogging 3-wheeler,
 * classic pram with a bassinet, umbrella stroller. Optional seated / lying baby.
 */
export function createStrollerKit(THREE_ = THREE, materials = null, rngSeed = 1) {
  void THREE_;
  const t0 = performance.now();
  const mats = propMaterials(materials);
  const variants = STROLLER_SPECS.map((spec) => {
    const v = makeStrollerVariant(spec);
    v.reach = 1.0;
    return v;
  });
  const byId = Object.fromEntries(variants.map((v, i) => [v.id, i]));
  const kit = {
    kind: 'stroller',
    variants, byId, mats, material: mats.mat, depthMaterial: mats.depth,
    buildMs: 0,

    /** {variant, colorA (fabric), colorB (frame), look}; opts.baby (default 85 %) shows a child. */
    pick(seed, { baby = null, variant = null } = {}) {
      const r = new RNG(hash2(seed | 0, 0x57a1 ^ (rngSeed | 0)));
      let vi = variant !== null ? (typeof variant === 'string' ? byId[variant] : variant) : -1;
      if (vi < 0 || vi === undefined) vi = r.weighted(variants.map((v, i) => [i, v.spec.weight]));
      const spec = variants[vi].spec;
      const colorA = jitterHex(r.pick(spec.fabrics), r, 0.06);
      const colorB = jitterHex(r.pick(spec.frames), r, 0.03);
      const hasBaby = baby !== null ? baby : r.chance(0.85);
      const flags = hasBaby ? FLAG.BABY : 0;
      const skin = r.int(0, 3), cloth = r.int(0, 7), hat = r.chance(0.4) ? 1 : 0;
      const finish = 3, wear = r.int(1, 4);
      return { variant: vi, colorA, colorB, flags, skin, cloth, hat, finish, wear,
        look: [packColor(colorA), packColor(colorB), packLook(finish, wear, flags, skin, cloth, hat)] };
    },

    /** Animation vector from distance rolled (m) and the front casters' swivel (rad). */
    anim(out, v, { roll = 0, swivel = 0 } = {}) {
      const d = variants[v].dims;
      out[0] = (roll / d.rearRadius) % TAU; out[1] = (roll / d.frontRadius) % TAU; out[2] = 0; out[3] = swivel;
      return out;
    },

    /** Pusher contact points (prop-local): handle grips L / R, handle centre, baby seat. */
    attachments(v, out = {}) { return strollerAttachments(variants[v], out); },

    matrix: propMatrix,
    createInstancer(opts = {}) { return new PropInstancer(kit, { name: 'strollers', ...opts }); },
  };
  kit.buildMs = performance.now() - t0;
  scheduleLod0(variants);
  return kit;
}

// one shared kit per app (parked bicycles and the moving riders use the same models)
const kits = new WeakMap();
export function bicycleKit(app) {
  let k = kits.get(app);
  if (!k) { k = {}; kits.set(app, k); }
  if (!k.bike) k.bike = createBicycleKit(THREE, app.materials, (app.layout && app.layout.seed) || 1);
  return k.bike;
}
export function strollerKit(app) {
  let k = kits.get(app);
  if (!k) { k = {}; kits.set(app, k); }
  if (!k.stroller) k.stroller = createStrollerKit(THREE, app.materials, (app.layout && app.layout.seed) || 1);
  return k.stroller;
}

setParkedKit(bicycleKit);
export { buildParkedBicycles, disposeParkedBicycles, parkedBicycleFootprints, parkedBicyclePlan } from './parked.js';
export { mountPropsTest } from './test.js';
