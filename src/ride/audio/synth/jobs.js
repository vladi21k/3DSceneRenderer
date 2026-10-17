// The list of buffers to synthesize, in priority order (sounds needed right after
// the start click first, long ambience beds last). Shared by the synthesis worker and
// the in-thread fallback. Yields {name, chans: Float32Array[], rate}.
import { bellStrike } from './bell.js';
import { streetIR } from './reverb.js';
import { rollingTexture, clack, frog, scrape, brakeCreak } from './rail.js';
import { airHiss, doorMotion, doorChime, doorBeep, compressorLoop, fanLoop } from './vehicle.js';
import { babbleBed, voiceShot } from './voice.js';
import { birdCall, footstep, clink, carHorn, trafficBed } from './street.js';
import { noiseLoop } from './noise.js';

export const LOW_SR = 24000; // beds with little content above ~10 kHz are synthesized at a lower rate
export const BIRD_KINDS = ['sparrow', 'sparrow', 'sparrow', 'bulbul', 'bulbul', 'swift', 'swift', 'pigeon'];

const as = (chans) => (Array.isArray(chans) ? chans : [chans]);

export async function* synthJobs(sr) {
  const lo = Math.min(sr, LOW_SR);
  const item = (name, chans, rate = sr) => ({ name, chans: as(chans), rate });
  for (let k = 0; k < 3; k++) yield item('bell' + k, bellStrike(sr, k));
  yield item('ir', streetIR(sr));
  yield item('noiseW', noiseLoop(sr, 'white', 4.3));
  yield item('noiseP', noiseLoop(sr, 'pink', 5.7));
  for (let k = 0; k < 8; k++) yield item('clack' + k, clack(sr, k));
  for (let k = 0; k < 3; k++) yield item('frog' + k, frog(sr, k));
  for (let k = 0; k < 2; k++) yield item('scrape' + k, scrape(sr, k));
  yield item('rolling', rollingTexture(sr));
  yield item('fan', fanLoop(lo), lo);
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
  // street
  yield item('babbleA', await babbleBed(lo, 13.1, 'A', 11), lo);
  for (let k = 0; k < BIRD_KINDS.length; k++) yield item('bird' + k, birdCall(sr, BIRD_KINDS[k], k));
  for (let k = 0; k < 9; k++) yield item('step' + k, footstep(sr, k));
  yield item('babbleB', await babbleBed(lo, 11.7, 'B', 10), lo);
  yield item('traffic', trafficBed(lo, 21), lo);
  for (let k = 0; k < 8; k++) yield item('clink' + k, clink(sr, k));
  for (let k = 0; k < 3; k++) yield item('horn' + k, carHorn(lo, k), lo);
  for (let k = 0; k < 3; k++) yield item('laugh' + k, voiceShot(lo, 'laugh', k), lo);
  for (let k = 0; k < 4; k++) yield item('call' + k, voiceShot(lo, 'call', k), lo);
  for (let k = 0; k < 4; k++) yield item('phrase' + k, voiceShot(lo, 'phrase', k), lo);
}
