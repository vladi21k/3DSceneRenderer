// The list of buffers to synthesize, in priority order, split in two parts that run
// in parallel workers: 'a' (everything mechanical and the street one-shots, sounds
// needed right after the start click first) and 'b' (the crowd's voices, interleaved
// by speaker so the conversations have variety from the first second). Shared by the
// synthesis workers and the in-thread fallback. Yields {name, chans: Float32Array[], rate}.
import { bellStrike } from './bell.js';
import { streetIR, cabIR } from './reverb.js';
import { grit, thump, clack, frog, scrape, brakeCreak, rattle } from './rail.js';
import { airHiss, doorMotion, doorChime, doorBeep, compressorLoop, fanLoop } from './vehicle.js';
import { utterance, voiceShot, SPEAKERS, UTT_PER } from './voice.js';
import { birdNote, birdCall, NOTES, footstep, clink, carHorn, trafficBed } from './street.js';

export const LOW_SR = 24000;   // beds with little content above ~10 kHz are synthesized at a lower rate
export const VOICE_SR = 16000; // distant voices (air absorption and the cab take the top end anyway)
export const BANK_VERSION = 'tram-audio-3';

const as = (chans) => (Array.isArray(chans) ? chans : [chans]);

/** part: 'a', 'b' or 'all'. */
export async function* synthJobs(sr, part = 'all') {
  const lo = Math.min(sr, LOW_SR), vr = Math.min(sr, VOICE_SR);
  const item = (name, chans, rate = sr) => ({ name, chans: as(chans), rate });
  if (part !== 'b') {
    for (let k = 0; k < 3; k++) yield item('bell' + k, bellStrike(sr, k));
    // street canyon about 21 m and 28 m between the facades (listener 1.6 m right of centre)
    yield item('irN', streetIR(sr, { right: 8.9, left: 12.1 }));
    yield item('irW', streetIR(sr, { right: 12.4, left: 15.6 }));
    yield item('irCab', cabIR(sr));
    for (let k = 0; k < 12; k++) yield item('grit' + k, grit(sr, k));
    for (let k = 0; k < 4; k++) yield item('thump' + k, thump(sr, k));
    for (let k = 0; k < 8; k++) yield item('clack' + k, clack(sr, k));
    yield item('fan', fanLoop(lo), lo);
    for (let k = 0; k < 3; k++) yield item('frog' + k, frog(sr, k));
    for (let k = 0; k < 2; k++) yield item('scrape' + k, scrape(sr, k));
    for (let k = 0; k < 4; k++) yield item('rattle' + k, rattle(sr, k));
    yield item('traffic', trafficBed(lo, 21), lo);
    yield item('compressor', compressorLoop(lo), lo);
    for (let k = 0; k < 2; k++) {
      yield item('hissStop' + k, airHiss(sr, 'stop', k));
      yield item('hissRelease' + k, airHiss(sr, 'release', k));
      yield item('creak' + k, brakeCreak(sr, k));
    }
    yield item('doorOpen', doorMotion(sr, true));
    yield item('doorClose', doorMotion(sr, false));
    yield item('chime', doorChime(sr));
    yield item('beep', doorBeep(sr));
    for (let k = 0; k < 9; k++) yield item('step' + k, footstep(sr, k));
    for (const kind of Object.keys(NOTES)) for (let k = 0; k < NOTES[kind]; k++) yield item(kind + k, birdNote(sr, kind, k));
    for (let k = 0; k < 4; k++) yield item('swift' + k, birdCall(sr, 'swift', k));
    for (let k = 0; k < 2; k++) yield item('pigeon' + k, birdCall(sr, 'pigeon', k));
    for (let k = 0; k < 8; k++) yield item('clink' + k, clink(sr, k));
    for (let k = 0; k < 3; k++) yield item('horn' + k, carHorn(lo, k), lo);
  }
  if (part !== 'a') {
    // utt<i>: speaker i % SPEAKERS, its utterance floor(i / SPEAKERS)
    for (let u = 0; u < UTT_PER; u++) {
      for (let spk = 0; spk < SPEAKERS; spk++) yield item('utt' + (u * SPEAKERS + spk), utterance(vr, spk, u), vr);
    }
    for (let k = 0; k < 8; k++) yield item('laugh' + k, voiceShot(vr, 'laugh', k), vr);
    for (let k = 0; k < 6; k++) yield item('call' + k, voiceShot(vr, 'call', k), vr);
  }
}
