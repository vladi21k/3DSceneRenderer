// Pedestrian record. Positions are route coordinates: `s` is unwrapped (continuous
// across the loop seam, in the same frame as Crowd.camU), `d` is the lateral offset.
// Velocities are metric (m/s) along the route tangent (vs) and to the right (vd).
// alpha is the body facing relative to the route tangent (rad, + turns to the right).

export const KIND = { WALKER: 0, SEATED: 1, PASSENGER: 2, STANDER: 3 };
export const ST = { WALK: 0, GOTO: 1, STAND: 2, WAIT: 3, SEATED: 4, PLATFORM: 5 };
export const TASK = {
  NONE: 0, BROWSE: 1, ENTER: 2, CROSS: 3, SIDE_OUT: 4, EMERGE: 5, TO_PLATFORM: 6,
  BOARD: 7, ALIGHT: 8, SIT: 9, LEAVE_SEAT: 10, CHAT: 11, PAUSE: 12, SERVE: 13,
};
export const LANE = { SIDE: 0, EDGE: 1, CORR: 2 };
/** Mobility role: pushing a stroller, riding a bicycle, walking beside a bicycle. */
export const MOB = { NONE: 0, STROLLER: 1, CYCLE: 2, WALKBIKE: 3 };
/** Renderer pose / prop codes of each role (docs/ARCHITECTURE.md, Mobility extension). */
export const MOB_POSE = [0, 3, 4, 5];
export const MOB_PROP = [0, 1, 2, 2];

export const STATE_NAMES = Object.fromEntries(Object.entries(ST).map(([k, v]) => [v, k.toLowerCase()]));
export const TASK_NAMES = Object.fromEntries(Object.entries(TASK).map(([k, v]) => [v, k.toLowerCase()]));
export const KIND_NAMES = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k.toLowerCase()]));
export const MOB_NAMES = Object.fromEntries(Object.entries(MOB).map(([k, v]) => [v, k.toLowerCase()]));

export class Agent {
  constructor(slot) {
    this.slot = slot;
    this.active = false;
    this.serial = 0;          // spawn counter, changes on every reuse of the slot
    this.kind = KIND.WALKER;
    this.state = ST.WALK;
    this.task = TASK.NONE;
    this.step = 0;            // progress inside a multi-step task
    this.s = 0; this.d = 0;   // position (route coords, s unwrapped)
    this.vs = 0; this.vd = 0; // velocity (m/s)
    this.side = 1;            // sidewalk side the agent belongs to (+1 right, −1 left)
    this.dir = 1;             // walking direction along s
    this.v0 = 1.35;           // preferred walking speed
    this.vmax = 1.6;
    this.lane = LANE.SIDE; this.laneF = 0.5; this.laneD = 0;
    this.gs = 0; this.gd = 0; // goal of GOTO
    this.gTol = 0.25;
    this.timer = 0;           // generic countdown (stand / wait durations)
    this.thinkT = 0;          // countdown to the next decision
    this.faceA = 0;           // facing to hold while standing
    this.alpha = 0;           // current body facing
    this.leader = null;       // group leader (followers only)
    this.nFollow = 0;         // followers (leaders only)
    this.slotF = 0; this.slotR = 0;
    this.appearance = 0; this.phase = 0; this.pose = 0;
    this.look = 0; this.lookGoal = 0; this.lookT = 0; this.tramLookT = 0;
    this.clearing = false; this.clearTo = 0;
    this.noRect = false;      // may enter café / platform footprints (patrons, passengers)
    this.inDoor = false;      // inside a shop doorway recess (no facade clamp)
    this.doorS0 = 0; this.doorS1 = 0;
    this.mouth = null;        // cross street used by SIDE_OUT / EMERGE
    this.after = 0;           // follow-up task after crossing
    this.feature = null;      // café chair / platform this agent belongs to
    this.stuckT = 0;
    this.h = 0;               // height above paving (platforms)
    this.simple = false;      // far: kinematics only
    this.x = 0; this.y = 0; this.z = 0; this.heading = 0; this.speed = 0;
    this.next = -1;           // grid linked list
    this.followers = [];      // group members (leaders only)
    this.door = null;         // shop opening used by ENTER
    this.slotX = 0;           // lateral position inside a side street
    this.crossS = 0;          // s where a crossing reaches the far side
    this.tramLookS = 0;       // window in which the agent looks at the tram
    this.bellT = 0;           // reacting to the bell until this time
    this.dreamy = false;      // absorbed (phone, conversation): notices the tram late
    this.fresh = false;       // spawned this frame (for the visible-spawn statistics)
    this.src = '';            // where it came from (statistics)
    this.stride = 1.5; this.strideV = -1; // cached gait cycle length and the speed it was computed for
    this.afs = 0; this.afd = 0; // avoidance force (recomputed every other frame)
    this.laneT = 0; this.laneTT = 0; // cached lane target and its refresh countdown
    // tram awareness
    this.clearT = 4.5;        // seconds before the tram arrives that this person leaves its track
    this.needsBell = false;   // will only notice the tram once it rings
    this.dodge = 0; this.dodgeT = 0; // short sidestep away from the passing tram (signed d offset, until time)
    this.passT = -1e9;        // last time the tram passing by was noticed
    // motion
    this.px = 0; this.pz = 0; this.pValid = false; // world position at the previous output (actual displacement)
    this.speedA = 0;          // smoothed actual speed (drives the gait)
    this.moving = false;      // wants to move this frame (standing states: stepping into place)
    this.vmaxCur = 1.6;       // speed limit of this frame (statistics)
    this.wSeed = 0;           // personal noise seed (lane wander, pace, heading jitter)
    this.uturnT = 0; this.uturnDir = 1; this.uturnSgn = 1; // smooth turn-around in progress
    this.driftT = 0; this.driftF = 0.9; // drifting towards the shop windows until time
    // groups
    this.baseF = 0; this.baseR = 0; // slot in the leader's frame before the slow wander
    this.singleT = 0;         // walking single file behind the leader until this time
    this.stuckF = 0;          // follower held back by constraints (s)
    this.chatS = 0; this.chatD = 0; // standing spot in a conversation circle
    this.isChild = false; this.height = 1.7;
    this.wT = 6; this.paceT = 9; this.faceJ = 0; // slot wander period, pace drift period, facing jitter
    this.bandW = 9;           // width of the sidewalk band around (lane walkers)
    this.dodgeD0 = 0;         // d where a standing sidestep started
    this.seatS = 0; this.seatD = 0; // seat being eased into
    this.crossOK = 0;         // committed to crossing the band until this time
    this.guardian = null;     // adult a seated child belongs to
    this.bornT = 0;           // crowd time of the spawn (statistics)
    this.platformOK = false;  // a walker who stepped up onto a platform to let the tram by
    // mobility (strollers, bicycles)
    this.mob = 0;             // MOB role
    this.propSeed = 0;        // stroller / bicycle model and colour (renderer)
    this.lean = 0;            // rider lean (rad, + leans left), from the turn rate
    this.fp0s = 0; this.fp0d = 0; this.fp1s = 0; this.fp1d = 0; this.fpR = 0; // prop capsule (metric offsets from the body)
    this.extLo = 0; this.extHi = 0; // how far the prop reaches past the body circle towards −d / +d
    this.extS = 0;            // ... and along s (either way)
    this.bikeV = 0;           // riding speed along the bicycle (m/s)
    this.yawW = 0;            // bicycle turn rate relative to the route frame (rad/s)
    this.cT = 0;              // cyclist: line (signed d) chosen last frame (passing offsets are kept steady)
    this.slowT = 0;           // cyclist: seconds spent held to walking pace (dismounts after a while)
    this.stallT = 0;          // cyclist: seconds stopped dead (wedged)
    this.mountT = 0;          // walking a bicycle: earliest time to get back on
    this.mvS0 = 0; this.mvS1 = 0; this.mvD0 = 0; this.mvD1 = 0; this.mvOn = false; // cyclist lane change (ramp along s)
    this.mvBand = false;      // ... crossing the ride track's band
    this.mvToBand = false;    // ... into a line inside the band (the ride track's half, tram far)
    this.mvBIn = 0; this.mvBOut = 0; // ... where the ramp enters / leaves the band (s)
    this.mvLane = null; this.mvOld = null; // ... the lane it leads to / came from
    this.nearT = 0;           // cyclist: the tram counts as near until this time (latched)
    this.clearHi = false; this.clearSpare = 0; // side and margin chosen when clearing the band
    this.prevHead = 0;        // world heading at the last output (lean)
    this.headValid = false;
    this.rx = 0;              // cyclist crossing a rail: 0 no, 1 swinging away first, 2 crossing
    this.rxSgn = 1; this.rxEnd = 0; this.rxSetup = 0; this.rxT = 0; this.rxSetupT = 0; this.rxHold = 0; this.rxV = 2; this.rxFirst = 0; this.rxWhy = '';
    this.stopT = 0;           // cyclist: seconds stopped
    this.stopNP = 0;          // ... of which with nobody in the way
    this.stallTry = 0;        // ... when getting off was last tried (stopT)
    this.stallSeen = false;   // ... counted as a stall (statistics)
    this.narrowS = null;      // cyclist: where the sidewalk ahead gets too narrow to ride (s)
    this.mobPrev = 0; this.mobT = -1e9; this.footW = 1; // prop sliding to its new place after getting on / off (footprint.js)
    this.stepT = 0; this.stepS = 0; this.stepD = 0;
    this.pinned = false;
    this.waitX = 0;           // cyclist: waiting for people to clear its way across a rail (until)
    this.waitXT = 0;          // ... for how long (a lane change is given up after a while)
    this.dmNext = 0;
    // oncoming units (tram.js): the unit whose zone this is (id or −1), the side chosen to leave
    // its band (±1, 0 none), clearing for it this frame / a cab clearing re-aimed for it, bell
    this.uI = -1; this.uSide = 0; this.uClr = false; this.uOver = false; this.ubellT = 0;
    this.lookU = -1;          // looking at this unit (−1: the cab tram)
    // walking behind slower people (behaviour.js headway): refresh countdown, speed cap, passing
    // line (signed d) until ovT, free width for the group's formation
    this.hwT = 0; this.hwV = 99; this.ovT = 0; this.ovD = 0; this.freeW = 9;
    this.platSt = null;       // station whose platform this walker uses as a sidewalk (platformOK)
    this.platSide = 1;        // ... and on which side
    this.boardU = -1;         // boarding this oncoming unit (left platform)
    this.stnS = null;         // cyclist: a stop ahead, gets off before this s
    this.askT = 0;            // cyclist: when (stopT) it last waited for people to make way
    // both trams at once (tram.js): the oncoming unit whose pass overlaps the cab's here (id + 1,
    // 0 none), out to this corridor edge (±1, 0 none), clearing for the pair this frame
    this.pair = 0; this.pSide = 0; this.pClr = false;
    this.cabTo = 0;           // target chosen when clearing for the cab (signed d)
    this.uHold = false;       // clearing for the cab, but waiting for a unit to go by first
    this.hurry = 2.15;        // brisk pace when clearing a track (the elderly cannot trot)
    this.ownV0 = 1.35;        // own walking pace (before any group pace)
    this.ageK = 'adult';      // age class of the appearance (adult | teen | old | walkOld | child)
    // walking abreast of a stranger (steering): seconds so far, pace factor and until when
    this.abT = 0; this.paceK = 1; this.paceKT = 0;
    this.role = '';           // 'staff': a café waiter
    this.cafeT = null;        // ... its terrace (feature)
    this.path = null; this.pathI = 0; this.serveFace = 0; this.serveTi = -1; // ... its round: waypoints [s, d], facing at the table
    this.inSide = false;      // out in a side street (beyond the main street's building line)
    this.sideX = 0;           // ... how far (m) beyond it
    this.pauseFace = 0; this.pauseT = 0; // a pause about to start on arrival: facing and duration
    this.sideA = 0; this.sideEnd = 0; this.stuckN = 0; // side street: sidewalk line (a), how far in to go, retries
    this.laneUrgent = false;  // the lane target moved out of a tram's berth: stepping over briskly
    this.wards = [];          // children seated with this adult (population)
    this.spawnHidden = false; // spawned where nobody could see it (statistics)
    // per-frame scratch (fields rather than number arguments: a double passed to a call that is
    // not inlined is boxed, and that is garbage per agent and per frame)
    this.prevD = 0; this.stepDt = 0; // lateral position before this step, and the step's dt (tram.constrain)
    this.moveDist = 0;        // horizontal distance the figure moved since the last output (gait)
    this.km = 1;              // metres per unit of s at the agent (steering, once per step)
    this.kap = 0; this.kapS = -1e9; // route curvature at kapS (refreshed every 0.5 m)
    this.front = 0; this.frontN = -1; // tram.js frontFor of this frame, and the frame it is for
    this.ws = 0; this.wd = 0; this.wValid = false; // (s, d) of the world position last computed (crowd._output)
    this.hT = 0;              // platform height under the feet there
    this.rh = 0; this.rhS = 0; this.rhValid = false; // route heading at rhS (refreshed every 0.2 m)
    this.wvx = 0; this.wvz = 0; // world velocity of the figure (m/s, actual displacement)
    this.lnN = 0; this.lnJ = 0; this.fwF = 0; this.fwR = 0; this.fwTT = 0; // slow noise (pace, heading jitter, group slot wander), 4 Hz
    settleAgent(this);
  }
}

// Integer fields (codes, indices, bit fields): they never hold fractions.
const INT_FIELDS = new Set(['slot', 'serial', 'kind', 'state', 'task', 'step', 'lane', 'next', 'nFollow', 'mob', 'mobPrev',
  'propSeed', 'appearance', 'wSeed', 'uI', 'lookU', 'boardU', 'pair', 'serveTi', 'pathI', 'frontN', 'stuckN', 'after']);

/** Fixes an object's hidden class up front (agents, and the scratch objects the per-frame code
 *  shares). V8 gives a numeric field that starts as a small integer the integer representation,
 *  and a field written only once is taken as constant; the first fraction written to such a field
 *  later (a rare event mid-ride: the first cyclist, the tram's first acceleration) or its first
 *  rewrite changes the class, and every function compiled against the old one is thrown back to
 *  unoptimised code for a while (where every number it touches is boxed: garbage, and a hitch).
 *  So each numeric field (but the `ints`) is given the double representation now, and every
 *  number and boolean field is written twice. */
export function settleShape(o, ints = null) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'number') { o[k] = ints && ints.has(k) ? v + 1 : 0.5; o[k] = v; }
    else if (typeof v === 'boolean') { o[k] = !v; o[k] = v; }
  }
  return o;
}

function settleAgent(a) {
  settleShape(a, INT_FIELDS);
  // (null or a number)
  a.narrowS = 0.5; a.narrowS = null;
  a.stnS = 0.5; a.stnS = null;
}
