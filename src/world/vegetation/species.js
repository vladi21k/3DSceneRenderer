// Street tree species and the procedural templates built from them.
//
// The street is planted with young pagoda trees (Styphnolobium-like, ovate leaflets,
// open rounded crown splitting into a few scaffold limbs) and narrow-leaved ash
// (lanceolate leaflets, oval crown with a central leader), with the odd older, denser
// tree (hackberry/fig-like simple leaves). All sizes are metres.
//
// Leaf atlas: 6 x 6 cells (see leafAtlas.js). Each near cell is a shoot tip seen from
// above, carrying a clump of leaves; the far cells are clumps composed from them.

export const ATLAS_GRID = 6;
const seq = (a, n) => Array.from({ length: n }, (_, i) => a + i);
export const CELL = {
  pagoda: seq(0, 8),
  ash: seq(8, 8),
  dense: seq(16, 4),
  shrub: seq(20, 2),
  pelargonium: [22],   // pelargonium leaves (flowers are separate upright cards)
  umbel: [23],         // flower umbel on its stalk, seen from the side
  clumpPagoda: [24, 25],
  clumpAsh: [26, 27],
  clumpDense: [28],
  clumpShrub: [29],
};

/**
 * Foliage appearance per species: atlas cells, card sizes and leaf tint.
 *   card       L0 card size (m); a card carries one shoot tip with its leaf clump
 *   clumpCard  L2 clump card size (m)
 */
export const FOLIAGE = {
  pagoda: { cells: CELL.pagoda, clumps: CELL.clumpPagoda, card: 0.45, clumpCard: 1.1, tint: [1.0, 1.0, 1.0] },
  ash: { cells: CELL.ash, clumps: CELL.clumpAsh, card: 0.47, clumpCard: 1.1, tint: [0.97, 0.99, 1.0] },
  dense: { cells: CELL.dense, clumps: CELL.clumpDense, card: 0.5, clumpCard: 1.15, tint: [1.0, 1.0, 1.0] },
  shrub: { cells: CELL.shrub, clumps: CELL.clumpShrub, card: 0.3, clumpCard: 0.6, tint: [1, 1, 1] },
};

/**
 * Tree templates. Each one is grown once at init (space colonisation inside a crown
 * envelope) and instanced along the street with per-tree scale, mirror, lean, yaw and tint.
 *   height       total height of the template
 *   crownBase    height of the lowest scaffold limb (clear stem below)
 *   crownR       crown radius (half the crown width)
 *   shape        envelope profile: 'round' | 'oval' | 'vase' | 'broad'
 *   trunkR       trunk radius at 1 m
 *   leader       central leader continues up into the crown (ash) or splits (pagoda)
 *   scaffolds    number of primary limbs seeded where the stem splits
 *   attractors   number of attraction points (crown density)
 *   step/infl/kill  space colonisation parameters
 *   spurs        probability of a short leaf-bearing side shoot per node
 *   cardsPerTip  leaf cards per terminal shoot; inner shoots carry fewer
 *   droop        how much slender shoots and leaf clumps hang
 *   stake        young tree still tied to stakes
 */
const young = { mature: false, step: 0.19, infl: 0.95, kill: 0.3, spurs: 0.9, cardsPerTip: 2.6 };
export const TEMPLATES = [
  { ...young, id: 'pagodaA', species: 'pagoda', height: 6.0, crownBase: 2.35, crownR: 1.75, shape: 'round', trunkR: 0.06, leader: false, scaffolds: 4, attractors: 1000, droop: 0.12, stake: true },
  { ...young, id: 'pagodaB', species: 'pagoda', height: 6.7, crownBase: 2.55, crownR: 1.95, shape: 'vase', trunkR: 0.07, leader: false, scaffolds: 3, attractors: 1150, droop: 0.15, stake: false },
  { ...young, id: 'pagodaC', species: 'pagoda', height: 5.3, crownBase: 2.2, crownR: 1.45, shape: 'round', trunkR: 0.05, leader: false, scaffolds: 3, attractors: 750, droop: 0.1, stake: true },
  { ...young, id: 'pagodaD', species: 'pagoda', height: 6.3, crownBase: 2.45, crownR: 1.7, shape: 'oval', trunkR: 0.065, leader: false, scaffolds: 5, attractors: 1050, droop: 0.13, stake: false },
  { ...young, id: 'pagodaE', species: 'pagoda', height: 5.7, crownBase: 2.3, crownR: 1.8, shape: 'broad', trunkR: 0.06, leader: false, scaffolds: 3, attractors: 950, droop: 0.16, stake: true },
  { ...young, id: 'ashA', species: 'ash', height: 6.4, crownBase: 2.4, crownR: 1.55, shape: 'oval', trunkR: 0.06, leader: true, scaffolds: 0, attractors: 1000, droop: 0.05, stake: true },
  { ...young, id: 'ashB', species: 'ash', height: 7.1, crownBase: 2.6, crownR: 1.8, shape: 'oval', trunkR: 0.07, leader: true, scaffolds: 0, attractors: 1200, droop: 0.07, stake: false },
  { ...young, id: 'ashC', species: 'ash', height: 5.8, crownBase: 2.3, crownR: 1.5, shape: 'round', trunkR: 0.055, leader: true, scaffolds: 0, attractors: 850, droop: 0.06, stake: true },
  { ...young, id: 'ashD', species: 'ash', height: 6.8, crownBase: 2.5, crownR: 1.7, shape: 'vase', trunkR: 0.065, leader: false, scaffolds: 3, attractors: 1100, droop: 0.08, stake: false },
  { id: 'pagodaM', species: 'pagoda', mature: true, height: 9.6, crownBase: 3.3, crownR: 2.9, shape: 'broad', trunkR: 0.15,
    leader: false, scaffolds: 4, attractors: 2600, step: 0.24, infl: 1.15, kill: 0.36, spurs: 0.8, cardsPerTip: 1.7, droop: 0.15, stake: false },
  { id: 'denseM', species: 'dense', mature: true, height: 10.4, crownBase: 3.5, crownR: 3.0, shape: 'round', trunkR: 0.17,
    leader: false, scaffolds: 3, attractors: 3000, step: 0.24, infl: 1.15, kill: 0.34, spurs: 0.85, cardsPerTip: 1.7, droop: 0.06, stake: false },
  { id: 'ashM', species: 'ash', mature: true, height: 9.2, crownBase: 3.2, crownR: 2.5, shape: 'oval', trunkR: 0.14,
    leader: true, scaffolds: 0, attractors: 2400, step: 0.24, infl: 1.15, kill: 0.36, spurs: 0.8, cardsPerTip: 1.7, droop: 0.08, stake: false },
];

/** Shrub templates for planters (no trunk, a mound of shoots), footprint in metres. */
export const SHRUBS = [
  { id: 'troughA', kind: 0, width: 1.3, depth: 0.5, height: 0.5, shoots: 210, flowers: 0 },
  { id: 'troughB', kind: 0, width: 1.3, depth: 0.5, height: 0.42, shoots: 150, flowers: 26 },
  { id: 'troughC', kind: 0, width: 1.3, depth: 0.5, height: 0.46, shoots: 170, flowers: 12 },
  { id: 'squareA', kind: 1, width: 0.68, depth: 0.68, height: 0.55, shoots: 120, flowers: 14 },
  { id: 'squareB', kind: 1, width: 0.68, depth: 0.68, height: 0.6, shoots: 140, flowers: 0 },
];
