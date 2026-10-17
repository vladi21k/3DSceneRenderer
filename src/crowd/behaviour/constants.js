import { TRACK_OFFSET, TRACK_ZONE_HALF } from '../../core/config.js';
import { TREE_D } from '../../world/layout.js';

// Tunables of the pedestrian simulation. Distances in metres, times in seconds.

export const MAX_AGENTS = 480;          // renderer slots allocated once
export const RANGE_BEHIND = 42;         // agents further behind the camera are recycled
export const RANGE_AHEAD = 560;         // populated distance ahead of the camera
export const FAR_TAPER = 450;           // density tapers off beyond this (heavier haze, tiny figures)
export const FAR_SLACK = 40;            // walkers may go this far past the range before they must leave
export const FAR_HARD = 120;            // ... and are removed regardless beyond this
export const SIMPLE_BEYOND = 340;       // beyond this agents skip avoidance (cheap kinematics only)
export const FAR_SPAWN_BAND = 44;       // new arrivals appear in the last metres of the range

// population mix
export const WALKER_DENSITY = 0.32;     // walkers per metre of street per side (before local multipliers)
export const MAX_SEATED = 104;
export const MAX_PASSENGERS = 46;
export const STANDER_TARGET = 34;       // people standing and talking in small groups

// bodies and gait
export const AGENT_R = 0.28;            // body radius used for avoidance and the tram clearance
export const WALK_MEAN = 1.36, WALK_SD = 0.14, WALK_MIN = 1.08, WALK_MAX = 1.65;
export const HURRY = 2.15;              // brisk trot when clearing the track
export const TURN_RATE = 4.0;           // rad/s, max heading change

// street cross-section (|d|)
export const SIDEWALK_IN = TREE_D + 0.8;           // inner edge of the shop-side walking band
export const EDGE_LANE = TRACK_ZONE_HALF + 0.55;   // walking line just outside the track corridor (pole strip)
export const WALL_GAP = 0.32;                      // never closer than this to a facade (centre)

// tram clearance. The camera rides d = TRACK_OFFSET; the cab sweeps |d − TRACK_OFFSET| < 1.5.
export const RIDE_D = TRACK_OFFSET;
export const SWEPT_HALF = 1.5;
export const SWEPT_AHEAD = 8;
export const BAND = SWEPT_HALF + AGENT_R + 0.03;   // centre must stay outside |d − RIDE_D| < BAND
export const BAND_LO = RIDE_D - BAND;              // safe left of the ride track (between tracks)
export const BAND_HI = RIDE_D + BAND;              // safe right of the ride track (corridor edge)
export const TRAM_LEN = 34;                        // tram body length behind the cab front
export const NO_GO_AHEAD = 14;                     // never step in front of the tram closer than this, even stopped
export const BRAKE_DECEL = 1.2;                    // service brake used for stopping distances
export const PASS_BASE = SWEPT_HALF + AGENT_R + 0.6; // comfortable distance (centre) from the ride track while the tram passes
export const PASS_PER_V = 0.04;                    // ... plus this per m/s of tram speed
export const CLEAR_T = [3.5, 6.0];                 // seconds before the tram arrives that people leave its track
export const CLEAR_T_DREAMY = [2.0, 3.0];          // absorbed people (phone, conversation)

// spatial hash
export const CELL = 2.0;
export const GRID_D = 26;                          // grid covers |d| <= GRID_D

// mobility roles (strollers, bicycles). Shares of the walking population, kept by spawning to the deficit.
export const MOB_SHARE = { stroller: 0.05, cycle: 0.045, walkbike: 0.015 };
export const STROLLER_V = [0.98, 1.28];            // pushing a stroller: a little slower than walking
export const WALKBIKE_V = [1.02, 1.32];
export const CYCLE_V = [2.8, 5.0];                 // 10-18 km/h
export const CYCLE_CLEAR_T = [6.5, 9.5];           // cyclists leave the ride track earlier (they are faster)
export const CYCLE_FALLBACK = 5.0;                 // m per crank revolution when the renderer gives none
// Prop footprints as capsules in the person's frame: from f0 to f1 metres ahead of the body
// centre, l metres to the right, radius r. A stroller reaches ~1.1 m ahead; a bicycle is
// ~1.8 m long centred on its rider; a walked bicycle is held beside the person (on their right).
export const FOOT = [
  null,
  { f0: 0.42, f1: 0.80, l: 0, r: 0.31 },
  { f0: -0.56, f1: 0.56, l: 0, r: 0.33 },
  { f0: -0.28, f1: 0.82, l: 0.42, r: 0.30 },
];
