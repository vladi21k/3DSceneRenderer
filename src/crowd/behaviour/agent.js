// Pedestrian record. Positions are route coordinates: `s` is unwrapped (continuous
// across the loop seam, in the same frame as Crowd.camU), `d` is the lateral offset.
// Velocities are metric (m/s) along the route tangent (vs) and to the right (vd).
// alpha is the body facing relative to the route tangent (rad, + turns to the right).

export const KIND = { WALKER: 0, SEATED: 1, PASSENGER: 2, STANDER: 3 };
export const ST = { WALK: 0, GOTO: 1, STAND: 2, WAIT: 3, SEATED: 4, PLATFORM: 5 };
export const TASK = {
  NONE: 0, BROWSE: 1, ENTER: 2, CROSS: 3, SIDE_OUT: 4, EMERGE: 5, TO_PLATFORM: 6,
  BOARD: 7, ALIGHT: 8, SIT: 9, LEAVE_SEAT: 10, CHAT: 11, PAUSE: 12,
};
export const LANE = { SIDE: 0, EDGE: 1, CORR: 2 };

export const STATE_NAMES = Object.fromEntries(Object.entries(ST).map(([k, v]) => [v, k.toLowerCase()]));
export const TASK_NAMES = Object.fromEntries(Object.entries(TASK).map(([k, v]) => [v, k.toLowerCase()]));
export const KIND_NAMES = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k.toLowerCase()]));

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
    this.guardian = null;     // adult a seated child belongs to
  }
}
