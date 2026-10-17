// Street tree species and the procedural templates built from them.
//
// The street is planted with young pagoda trees (Styphnolobium-like, ovate leaflets,
// open rounded crown splitting into a few scaffold limbs) and narrow-leaved ash
// (lanceolate leaflets, oval crown with a central leader), with the odd older, denser
// tree (hackberry/fig-like simple leaves). All sizes are metres.
//
// Leaf atlas cells (4 x 4 grid, see leafAtlas.js):
//   row 0  pagoda sprays      row 1  ash sprays
//   row 2  dense sprays x2, shrub spray, flowering pelargonium
//   row 3  far-LOD clumps: pagoda, ash, dense, shrub

export const ATLAS_GRID = 4;
export const CELL = {
  pagoda: [0, 1, 2, 3],
  ash: [4, 5, 6, 7],
  dense: [8, 9],
  shrub: [10],
  flower: [11],
  clumpPagoda: [12],
  clumpAsh: [13],
  clumpDense: [14],
  clumpShrub: [15],
};

/** Foliage appearance per species: atlas cells, card size and leaf colour (sRGB 0..255). */
export const FOLIAGE = {
  pagoda: { cells: CELL.pagoda, clump: CELL.clumpPagoda[0], card: 0.62, clumpCard: 1.5, tint: [1.0, 1.0, 1.0] },
  ash: { cells: CELL.ash, clump: CELL.clumpAsh[0], card: 0.62, clumpCard: 1.5, tint: [0.96, 0.98, 1.0] },
  dense: { cells: CELL.dense, clump: CELL.clumpDense[0], card: 0.52, clumpCard: 1.4, tint: [1.0, 1.0, 1.0] },
  shrub: { cells: CELL.shrub, clump: CELL.clumpShrub[0], card: 0.34, clumpCard: 0.7, tint: [1, 1, 1] },
};

/**
 * Tree templates. Each one is grown once at init (space colonisation inside a crown
 * envelope) and instanced along the street with per-tree scale, yaw and tint.
 *   height       total height of the template
 *   crownBase    height of the lowest scaffold limb (clear stem below)
 *   crownR       crown radius (half the crown width)
 *   shape        envelope profile: 'round' | 'oval' | 'vase' | 'broad'
 *   trunkR       trunk radius at 1 m
 *   leader       central leader continues up into the crown (ash) or splits (pagoda)
 *   scaffolds    number of primary limbs seeded where the stem splits
 *   attractors   number of attraction points (crown density)
 *   step/infl/kill  space colonisation parameters
 *   cardsPerTip  leaf cards per terminal shoot; density scales the inner shoots
 *   stake        young tree still tied to stakes
 */
export const TEMPLATES = [
  { id: 'pagodaA', species: 'pagoda', mature: false, height: 6.0, crownBase: 2.35, crownR: 1.75, shape: 'round', trunkR: 0.06,
    leader: false, scaffolds: 4, attractors: 520, step: 0.22, infl: 1.25, kill: 0.42, cardsPerTip: 1.35, droop: 0.12, stake: true },
  { id: 'pagodaB', species: 'pagoda', mature: false, height: 6.7, crownBase: 2.55, crownR: 1.95, shape: 'vase', trunkR: 0.07,
    leader: false, scaffolds: 3, attractors: 600, step: 0.23, infl: 1.3, kill: 0.42, cardsPerTip: 1.35, droop: 0.15, stake: false },
  { id: 'pagodaC', species: 'pagoda', mature: false, height: 5.3, crownBase: 2.2, crownR: 1.45, shape: 'round', trunkR: 0.05,
    leader: false, scaffolds: 3, attractors: 360, step: 0.21, infl: 1.15, kill: 0.42, cardsPerTip: 1.25, droop: 0.1, stake: true },
  { id: 'ashA', species: 'ash', mature: false, height: 6.4, crownBase: 2.4, crownR: 1.55, shape: 'oval', trunkR: 0.06,
    leader: true, scaffolds: 0, attractors: 520, step: 0.22, infl: 1.2, kill: 0.42, cardsPerTip: 1.35, droop: 0.05, stake: true },
  { id: 'ashB', species: 'ash', mature: false, height: 7.1, crownBase: 2.6, crownR: 1.8, shape: 'oval', trunkR: 0.07,
    leader: true, scaffolds: 0, attractors: 620, step: 0.23, infl: 1.3, kill: 0.42, cardsPerTip: 1.35, droop: 0.07, stake: false },
  { id: 'pagodaM', species: 'pagoda', mature: true, height: 9.6, crownBase: 3.3, crownR: 2.9, shape: 'broad', trunkR: 0.15,
    leader: false, scaffolds: 4, attractors: 1500, step: 0.27, infl: 1.6, kill: 0.5, cardsPerTip: 1.5, droop: 0.15, stake: false },
  { id: 'denseM', species: 'dense', mature: true, height: 10.4, crownBase: 3.5, crownR: 3.0, shape: 'round', trunkR: 0.17,
    leader: false, scaffolds: 3, attractors: 1700, step: 0.27, infl: 1.6, kill: 0.48, cardsPerTip: 2.0, droop: 0.06, stake: false },
  { id: 'ashM', species: 'ash', mature: true, height: 9.2, crownBase: 3.2, crownR: 2.5, shape: 'oval', trunkR: 0.14,
    leader: true, scaffolds: 0, attractors: 1350, step: 0.27, infl: 1.55, kill: 0.5, cardsPerTip: 1.6, droop: 0.08, stake: false },
];

/** Shrub templates for planters (no trunk, a mound of shoots), footprint in metres. */
export const SHRUBS = [
  { id: 'troughA', species: 'shrub', width: 1.3, depth: 0.5, height: 0.5, shoots: 80, flowers: 0 },
  { id: 'troughB', species: 'shrub', width: 1.3, depth: 0.5, height: 0.42, shoots: 60, flowers: 18 },
  { id: 'squareA', species: 'shrub', width: 0.68, depth: 0.68, height: 0.55, shoots: 48, flowers: 10 },
];
