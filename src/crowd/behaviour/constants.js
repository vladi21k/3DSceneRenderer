import { TRACK_OFFSET, TRACK_ZONE_HALF } from '../../core/config.js';
import { TREE_D } from '../../world/layout.js';

// Tunables of the pedestrian simulation. Distances in metres, times in seconds.

export const MAX_AGENTS = 440;          // renderer slots allocated once
export const RANGE_BEHIND = 42;         // agents further behind the camera are recycled
export const RANGE_AHEAD = 450;         // populated distance ahead of the camera
export const SIMPLE_BEYOND = 340;       // beyond this agents skip avoidance (cheap kinematics only)
export const FAR_SPAWN_BAND = 28;       // new arrivals appear in the last metres of the range

// population mix
export const WALKER_DENSITY = 0.32;     // walkers per metre of street per side (before local multipliers)
export const MAX_SEATED = 90;
export const MAX_PASSENGERS = 46;
export const STANDER_TARGET = 34;       // people standing and talking in small groups

// bodies and gait
export const AGENT_R = 0.28;            // body radius used for avoidance and the tram clearance
export const WALK_MEAN = 1.36, WALK_SD = 0.14, WALK_MIN = 1.08, WALK_MAX = 1.65;
export const HURRY = 2.15;              // brisk trot when clearing the track
export const TURN_RATE = 4.0;           // rad/s, max heading change

// street cross-section (|d|)
export const SIDEWALK_IN = TREE_D + 0.8;     // inner edge of the shop-side walking band
export const EDGE_LANE = TRACK_ZONE_HALF + 0.08; // walking line along the corridor edge
export const WALL_GAP = 0.32;                // never closer than this to a facade (centre)

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

// spatial hash
export const CELL = 2.0;
export const GRID_D = 26;                          // grid covers |d| <= GRID_D
