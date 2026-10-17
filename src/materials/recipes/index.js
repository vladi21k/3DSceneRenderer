import * as stone from './stone.js';
import * as paving from './paving.js';
import * as metal from './metal.js';
import * as misc from './misc.js';

// Every bake recipe by name (see baker.js for the recipe format).
export const RECIPES = Object.fromEntries(
  [stone, paving, metal, misc].flatMap((m) => Object.values(m)).map((r) => [r.name, r]),
);
