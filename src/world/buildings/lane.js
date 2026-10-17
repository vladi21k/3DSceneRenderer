// Ground of the cross lane at the far end of a side street (a T junction, see
// buildings.js planBackdrops). The street module paves the side street's own width
// (and its run-out) only, so the lane's arms on either side, glimpsed past the last
// buildings of the side street, get a plain asphalt apron. It lies a few centimetres
// below the street's paving, which covers it where the two overlap.

const ASPHALT = [0.13, 0.128, 0.13];   // × the plaster albedo: weathered asphalt

/** Lane apron description in a backdrop-style frame: {lane: true, id, frame, u0, u1, w0, w1, v}. */
export function* laneSteps(B, ln) {
  B.begin();
  B.frameFromLot(ln.frame);
  B.setUV();
  B.flat = ASPHALT;
  B.rectV(B.sink('dark'), ln.u0, ln.u1, ln.w0, ln.w1, ln.v, 1);
  B.flat = [1, 1, 1];
  yield;
}
