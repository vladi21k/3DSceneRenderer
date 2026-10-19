import { hash2 } from '../../core/rng.js';
import { ST, TASK, KIND } from './agent.js';

// How people stand: the standing stance handed to the renderer (humans.set() field `idle`)
// from what they are doing. People standing together in conversation take turns talking (the
// one speaking gestures, the others listen in a stance of their own, now and then two talk at
// once); people waiting at a stop look along the street for the tram or read their phone;
// someone waiting by a door looks about; window shoppers stand with their hands behind their
// back, arms folded or a hand on the hip; a waiter at a table talks (taking the order) and
// stands with the hands behind the back in the doorway. Everybody else keeps their own stance
// (from the appearance seed). A choice holds while the situation lasts (a cross-fade in the
// renderer for every change), so a person never fidgets between stances.
//
// Stances (humans.js): 0 relaxed weight shifts, 1 phone, 2 arms folded, 3 hands in pockets, 4 hand
// on hip, 5 hands behind the back, 6 talking with gestures, 7 looking about; −1 the person's own.
// They follow the appearance: no phone, folded arms or hands behind the back with a shopping
// bag in hand, no hands in pockets in a skirt, no phone for the elderly, and what children do.

export const IDLE = { OWN: -1, RELAX: 0, PHONE: 1, FOLD: 2, POCKET: 3, HIP: 4, BACK: 5, TALK: 6, LOOK: 7 };
/** Kinds of pause (agent.pauseK), set where the pause starts. */
export const PAUSE = { NONE: 0, DOOR: 1, POLE: 2, PHONE: 3, SIDE: 4 };

const { OWN, RELAX, PHONE, FOLD, POCKET, HIP, BACK, TALK, LOOK } = IDLE;
// weighted choices, flat [stance, weight, …]
const LISTEN = [RELAX, 30, FOLD, 18, POCKET, 18, HIP, 12, BACK, 8, LOOK, 4];
const BROWSE = [RELAX, 30, BACK, 22, FOLD, 20, HIP, 15, POCKET, 13];
const PLATFORM = [LOOK, 36, PHONE, 30, OWN, 34];
const P_DOOR = [LOOK, 45, PHONE, 30, OWN, 25];
const P_POLE = [OWN, 40, PHONE, 30, LOOK, 20, FOLD, 10];
const P_PHONE = [PHONE, 76, LOOK, 14, OWN, 10];
const P_SIDE = [OWN, 50, PHONE, 30, LOOK, 20];
const DOORWAY = [BACK, 50, RELAX, 35, FOLD, 15];
const WAIT_ONE = [OWN, 70, LOOK, 30];

/** Can this person (appearance ap) stand like this? */
function fits(ap, v) {
  if (v < 0 || !ap) return true;
  const age = ap.age;
  if (age === 'child' || age === 'toddler') return v === RELAX || v === LOOK || v === TALK || v === FOLD;
  // (a shopping bag in hand: the hand stays down)
  if (ap.carry && (v === PHONE || v === FOLD || v === HIP || v === BACK || v === TALK)) return false;
  if (ap.skirtPart && v === POCKET) return false;
  if (age === 'old' && v === PHONE) return false;
  // (hands behind the back is a man's habit, and an older woman's)
  if (ap.female && age !== 'old' && v === BACK) return false;
  return true;
}

/** The person's own stance where it fits the situation (phone and talking excluded), else −1. */
function ownCalm(ap) {
  const v = ap ? ap.idle : RELAX;
  return v === PHONE || v === TALK || v === LOOK ? -1 : v;
}

/** Weighted pick from a flat [stance, weight, …] list at u in [0, 1), skipping stances that do
 *  not fit; own: what OWN stands for here (−1 leaves the person's own stance). */
function pick(ap, L, u, own) {
  let tot = 0;
  for (let i = 0; i < L.length; i += 2) if (fits(ap, L[i] < 0 ? own : L[i])) tot += L[i + 1];
  if (tot <= 0) return own;
  let x = u * tot;
  for (let i = 0; i < L.length; i += 2) {
    const v = L[i] < 0 ? own : L[i];
    if (!fits(ap, v)) continue;
    x -= L[i + 1];
    if (x < 0) return v;
  }
  return own;
}

/** Deterministic fraction [0, 1) for this person and a salt. */
const frac = (n, salt) => (hash2(n, salt) & 0xffff) / 65536;

/** Updates a.idle (−1: the person's own) for the situation a is in now. Per frame and per agent,
 *  after steering.animate (a.pose, a.speed): cheap while the situation and its turn last. A new
 *  stance is handed over only while the renderer can blend to it (standing still: it cross-fades;
 *  walking briskly: the standing clips have no weight), never while slowing to a stop. */
export function stanceOf(c, a) {
  const L = a.leader || a;
  const group = L.followers.length > 0 && (a.state === ST.STAND || a.state === ST.WAIT || a.state === ST.PLATFORM);
  // the situation: state and task, in a group or alone, a waiter's step, the kind of pause
  const key = a.state | (a.task << 3) | (group ? 256 : 0) | (a.role === 'staff' ? 512 + (a.step << 10) : 0) | (a.pauseK << 14) | (a.mob ? 1 << 17 : 0);
  if (key !== a.idleK || c.time >= a.idleT) choose(c, a, L, group, key);
  if (a.idle !== a.idleW && (a.pose !== 0 || a.speed > 0.8 || a.fresh)) a.idle = a.idleW;
}

function choose(c, a, L, group, key) {
  a.idleK = key;
  a.idleT = 1e9;
  // (seated, riding or pushing something: the renderer has poses of its own)
  if (a.mob || a.state === ST.SEATED) { a.idleW = OWN; return; }
  const ap = c.humans && c.humans.appearanceOf ? c.humans.appearanceOf(a.appearance) : null;
  const st = a.state;
  if (a.role === 'staff') {
    // walking: relaxed when slowing down (never a phone); at the table: talking (taking the
    // order) or listening; in the doorway: hands behind the back
    if (st === ST.STAND && a.step === 1) a.idleW = frac(a.serial, c.time | 0) < 0.7 ? TALK : RELAX;
    else if (st === ST.STAND) a.idleW = pick(ap, DOORWAY, frac(a.serial, 7), RELAX);
    else a.idleW = RELAX;
    return;
  }
  if (group) { conversation(c, a, L, ap); return; }
  if (st === ST.PLATFORM) { a.idleW = pick(ap, PLATFORM, frac(a.serial, 11), OWN); return; }
  if (st === ST.STAND) {
    if (a.task === TASK.BROWSE) { a.idleW = pick(ap, BROWSE, frac(a.serial, 13), ownCalm(ap)); return; }
    if (a.task === TASK.PAUSE) {
      const P = a.pauseK === PAUSE.DOOR ? P_DOOR : a.pauseK === PAUSE.PHONE ? P_PHONE : a.pauseK === PAUSE.SIDE ? P_SIDE : P_POLE;
      a.idleW = pick(ap, P, frac(a.serial, 17 + a.pauseK), OWN);
      return;
    }
    // (a chat partner left alone: back to a calm stance of their own)
    a.idleW = a.task === TASK.CHAT ? pick(ap, LISTEN, frac(a.serial, 19), ownCalm(ap)) : OWN;
    return;
  }
  if (st === ST.WAIT && a.kind !== KIND.PASSENGER) { a.idleW = pick(ap, WAIT_ONE, frac(a.serial, 23), OWN); return; }
  a.idleW = OWN;
}

/** People standing together: one speaks (gesturing), the others listen, in turns of a few
 *  seconds; now and then a second voice. Window shoppers and people waiting together talk less. */
function conversation(c, a, L, ap) {
  const n = 1 + L.followers.length;
  const chat = L.task === TASK.CHAT || a.task === TASK.CHAT;
  // turns of 3.5-8.5 s, per group, all members switching together
  const P = 3.5 + 5 * frac(L.serial, 41), off = P * frac(L.serial, 43);
  const turn = Math.floor((c.time + off) / P);
  a.idleT = (turn + 1) * P - off;
  const me = a === L ? 0 : 1 + L.followers.indexOf(a);
  const talks = chat || frac(L.serial, turn * 7 + 3) < 0.55;
  const speaker = talks ? hash2(L.serial, turn) % n : -1;
  const second = chat && frac(a.serial, turn * 5 + 1) < 0.18;
  if ((me === speaker || second) && fits(ap, TALK)) { a.idleW = TALK; return; }
  // listening: each person's own calm stance, else one picked for them (stable over the turns)
  const own = ownCalm(ap);
  if (L.task === TASK.BROWSE) a.idleW = pick(ap, BROWSE, frac(a.serial, 13), own);
  else a.idleW = own >= 0 && frac(a.serial, 47) < 0.6 ? own : pick(ap, LISTEN, frac(a.serial, 19), own);
}
