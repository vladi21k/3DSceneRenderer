// Real-world dimensions (metres) and engine budgets shared by every module.

export const GAUGE = 1.435;               // standard gauge, inner faces of rail heads
export const RAIL_HEAD_W = 0.056;         // grooved rail (Ri59N-like) head width
export const RAIL_GROOVE_W = 0.042;       // flangeway groove width (inside of each rail)
export const RAIL_CENTER = (GAUGE + RAIL_HEAD_W) / 2; // rail centre line offset from track centre
export const TRACK_OFFSET = 1.6;          // track centre offset from street centre line (+ right / - left)
export const TRACK_ZONE_HALF = 3.4;       // half width of the paved track corridor
export const EDGE_BAND_W = 0.30;          // light stone band along both edges of the corridor
export const RIDE_TRACK = +1;             // the camera rides the right-hand track (d = +TRACK_OFFSET)

export const EYE_HEIGHT = 2.75;           // driver eye above rail top
export const CONTACT_WIRE_HEIGHT = 6.0;   // trolley wire above rail top

export const CHUNK_LEN = 40;              // streaming granularity along the route
export const VIEW_AHEAD = 680;            // metres of route kept built ahead of the camera
export const VIEW_FAR = 1400;             // far field (lod 2: core/farfield.js) runs on to here
export const VIEW_BEHIND = 60;            // metres kept behind
export const LOD0_DIST = 200;             // chunks closer than this are built at full detail

export const MAX_SPEED = 50 / 3.6;        // m/s
export const DEFAULT_VFOV = 17;           // degrees, telephoto default composition

// Tram axles, measured back from the cab front, with how strongly each one is felt/heard in
// the cab (shared by the camera rig's joint bumps and the audio's wheel-rail events).
export const AXLES = [
  { offset: 2.2, weight: 1.0 }, { offset: 4.05, weight: 0.92 },
  { offset: 13.6, weight: 0.34 }, { offset: 15.45, weight: 0.31 },
  { offset: 25.0, weight: 0.13 }, { offset: 26.85, weight: 0.12 },
];
