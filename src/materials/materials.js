import * as THREE from 'three';

// Material library (PLACEHOLDER — flat colours). Contract in docs/ARCHITECTURE.md.
// All library geometry uses UVs in metres (1 UV unit = 1 m); materials own the scale.

const DEFS = {
  'stone.ashlar': { color: 0xd8c8a8, roughness: 0.85 },
  'stone.smooth': { color: 0xe0d2b4, roughness: 0.7 },
  'stone.rough': { color: 0xcbb994, roughness: 0.95 },
  'paving.street': { color: 0x8e8e8a, roughness: 0.9 },
  'paving.sidewalk': { color: 0x9a9893, roughness: 0.9 },
  'paving.band': { color: 0xc9c5bb, roughness: 0.8 },
  'paving.platform': { color: 0xa6a39c, roughness: 0.85 },
  'rail.head': { color: 0xd0d0d4, roughness: 0.25, metalness: 1 },
  'rail.side': { color: 0x4a3a30, roughness: 0.7, metalness: 0.6 },
  'rail.groove': { color: 0x2a2622, roughness: 0.9 },
  'metal.iron': { color: 0x1a1a1a, roughness: 0.55, metalness: 0.6 },
  'metal.pole': { color: 0x3b3e40, roughness: 0.5, metalness: 0.5 },
  'metal.galvanized': { color: 0x9a9d9f, roughness: 0.45, metalness: 1 },
  'metal.steel': { color: 0xb8bbbe, roughness: 0.3, metalness: 1 },
  'metal.wire': { color: 0x5a4a3a, roughness: 0.4, metalness: 1 },
  'glass.shop': { color: 0x203038, roughness: 0.05, metalness: 0.2 },
  'glass.window': { color: 0x1a2228, roughness: 0.08, metalness: 0.3 },
  'glass.lamp': { color: 0xf2efe6, roughness: 0.2, emissive: 0x000000 },
  'fabric.awning': { color: 0xb5402e, roughness: 0.9 },
  'fabric.umbrella': { color: 0xe9e2d0, roughness: 0.9 },
  'fabric.flag': { color: 0xf0f0f0, roughness: 0.85, side: THREE.DoubleSide },
  'wood.shutter': { color: 0x3c5a3a, roughness: 0.7 },
  'wood.door': { color: 0x4a3020, roughness: 0.6 },
  'wood.bench': { color: 0x7a5534, roughness: 0.75 },
  'paint.frame': { color: 0x2d3a30, roughness: 0.5 },
  'plastic.chair': { color: 0x9fb8c8, roughness: 0.6 },
  'concrete': { color: 0xa09a90, roughness: 0.9 },
  'roof.tile': { color: 0xa5532f, roughness: 0.8 },
  'roof.membrane': { color: 0x8a8580, roughness: 0.9 },
  'plaster': { color: 0xd8cfc0, roughness: 0.9 },
  'bark': { color: 0x5a4a3c, roughness: 0.95 },
  'leaf': { color: 0x4a6a2a, roughness: 0.7, side: THREE.DoubleSide },
  'rubber': { color: 0x202020, roughness: 0.9 },
  'asphalt': { color: 0x3a3a3a, roughness: 0.95 },
  'sign.panel': { color: 0x203a5a, roughness: 0.5 },
  'emissive.warm': { color: 0x000000, emissive: 0xffd9a0, emissiveIntensity: 0 },
};

const lib = new Map();
const variants = new Map();
const listeners = new Set();
const tracked = new Set();

function make(name) {
  const d = DEFS[name];
  if (!d) {
    console.warn('[materials] unknown material', name);
    return new THREE.MeshStandardMaterial({ color: 0xff00ff });
  }
  const m = new THREE.MeshStandardMaterial(d);
  m.name = name;
  return m;
}

const materials = {
  name: 'materials',
  textures: new Map(),
  async init(app) {
    this.app = app;
    for (const k of Object.keys(DEFS)) this.register(k, make(k));
  },
  /** Shared material by name. opts: {vertexColors:true} returns a cached variant. */
  get(name, opts) {
    if (!lib.has(name)) this.register(name, make(name));
    if (!opts || !Object.keys(opts).length) return lib.get(name);
    const key = name + JSON.stringify(opts);
    if (!variants.has(key)) {
      const m = lib.get(name).clone();
      Object.assign(m, opts);
      m.name = key;
      m.needsUpdate = true;
      variants.set(key, m);
      this.track(m);
    }
    return variants.get(key);
  },
  register(name, mat) { mat.name = mat.name || name; lib.set(name, mat); this.track(mat); return mat; },
  /** Every material that ends up in the scene must be tracked so lighting can configure it. */
  track(mat) { if (!tracked.has(mat)) { tracked.add(mat); for (const fn of listeners) fn(mat); } return mat; },
  all() { return [...tracked]; },
  onTrack(fn) { listeners.add(fn); for (const m of tracked) fn(m); return () => listeners.delete(fn); },
  names() { return [...lib.keys()]; },
};

export default materials;
