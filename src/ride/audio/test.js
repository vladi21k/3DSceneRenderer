// Offline verification harness. Renders a driving scenario through the real engine
// with an OfflineAudioContext (the engine's update() is stepped on a virtual 60 Hz
// clock first, which schedules all automation), once per solo'd bus plus the full
// mix, and reports levels. Usage from tools/shoot.py:
//   --eval "window.__app.audio.test({scenario:'cruise', speed:30, seconds:6})"
// Options: scenario cruise|accel|stop|depart|ride|curve|crossover|bell|bellspam|station|idle,
//   seconds, speed (km/h), throttle, s (start position), layers (array of bus names
//   or 'none'), raw (skip compressor/limiter), wav (return the mix as base64 WAV),
//   bands (octave-band levels per layer), solo (bus for the 'mix' render / WAV),
//   sampleRate, night (0..1), tod (0..1), wind, events ([{t, type, data}]),
//   worklet (false: force the buffer-noise fallback), ambMute (ambience parts to mute),
//   updateHz (engine update rate on the virtual clock, default 60).
import { EYE_HEIGHT, TRACK_OFFSET } from '../../core/config.js';
import { Bank } from './bank.js';
import { AudioEngine, BUSES } from './engine.js';

const banks = new Map();
function bankFor(sr) {
  if (!banks.has(sr)) banks.set(sr, new Bank(sr));
  return banks.get(sr).build();
}

const kmh = (x) => x / 3.6;

/** Build a scenario: start position, speed/throttle/accel profiles and timed events. */
function scenario(app, o) {
  const { route, layout } = app;
  const name = o.scenario || 'cruise';
  const T = o.seconds;
  let s0 = o.s ?? layout.defaultStartS;
  const ev = [];
  let v, thr, acc;
  const A = 1.1; // m/s^2 service acceleration / braking
  if (name === 'accel') {
    const vmax = kmh(o.speed ?? 50);
    v = (t) => Math.min(vmax, A * Math.max(0, t - 0.5));
    acc = (t) => (t > 0.5 && A * (t - 0.5) < vmax ? A : 0);
    thr = (t) => (t > 0.5 && A * (t - 0.5) < vmax ? 1 : 0);
  } else if (name === 'stop') {
    const v0 = kmh(o.speed ?? 25), tb = 0.8, tStop = tb + v0 / A;
    v = (t) => (t < tb ? v0 : Math.max(0, v0 - A * (t - tb)));
    acc = (t) => (t >= tb && t < tStop ? -A : 0);
    thr = (t) => (t >= tb && t < tStop ? -0.9 : 0);
    ev.push({ t: tStop + 1.4, type: 'doors', data: { open: true } });
    ev.push({ t: tStop + 6.5, type: 'doors', data: { open: false } });
  } else if (name === 'depart') {
    const t0 = 3.0, vmax = kmh(o.speed ?? 40);
    v = (t) => Math.min(vmax, A * Math.max(0, t - t0));
    acc = (t) => (t > t0 && A * (t - t0) < vmax ? A : 0);
    thr = (t) => (t > t0 - 0.3 && A * (t - t0) < vmax ? 1 : 0);
    ev.push({ t: 0.1, type: 'doors', data: { open: false } });
  } else if (name === 'ride') {
    // doors close, pull away, cruise (bell), brake to the next stop, doors open
    const tA = 3.2, vmax = kmh(o.speed ?? 35), tAe = tA + vmax / A, tB = tAe + 7, tS = tB + vmax / A;
    v = (t) => (t < tA ? 0 : t < tAe ? A * (t - tA) : t < tB ? vmax : Math.max(0, vmax - A * (t - tB)));
    acc = (t) => (t > tA && t < tAe ? A : t > tB && t < tS ? -A : 0);
    thr = (t) => (t > tA - 0.3 && t < tAe ? 1 : t >= tAe && t < tB ? 0.12 : t >= tB && t < tS ? -0.9 : 0);
    ev.push({ t: 0.2, type: 'doors', data: { open: false } }, { t: tAe + 1.5, type: 'bell', data: {} }, { t: tS + 1.3, type: 'doors', data: { open: true } });
  } else if (name === 'station') {
    v = () => 0; thr = () => 0; acc = () => 0;
    ev.push({ t: 0.5, type: 'doors', data: { open: true } });
  } else if (name === 'idle') {
    v = () => 0; thr = () => 0; acc = () => 0;
  } else if (name === 'bellspam') {
    // B held down / hammered: a press every 0.25 s from 0.5 s to 3 s
    v = () => 0; thr = () => 0; acc = () => 0;
    for (let t = 0.5; t <= 3.001; t += 0.25) ev.push({ t, type: 'bell', data: { auto: false } });
  } else {
    const vc = kmh(o.speed ?? (name === 'curve' ? 20 : 30));
    v = () => vc; acc = () => 0; thr = () => o.throttle ?? 0;
    if (name === 'curve') {
      const seg = route.segments.reduce((a, b) => (b.radius < a.radius ? b : a));
      s0 = o.s ?? (seg.s0 + seg.s1) / 2 - (vc * T) / 2;
    } else if (name === 'crossover') {
      const c = layout.crossovers[0];
      s0 = o.s ?? c.s0 - vc * 0.6;
    } else if (name === 'bell') {
      ev.push({ t: 0.3, type: 'bell', data: { auto: false } }, { t: T * 0.55, type: 'bell', data: { auto: true } });
    }
  }
  for (const e of o.events || []) ev.push(e);
  ev.sort((a, b) => a.t - b.t);
  return { name, s0, v, thr, acc, ev };
}

function listenerAt(route, s, out) {
  const p = route.toWorld(s, TRACK_OFFSET, EYE_HEIGHT);
  const q = route.toWorld(s + 1, TRACK_OFFSET, EYE_HEIGHT);
  const dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z, n = Math.hypot(dx, dy, dz) || 1;
  Object.assign(out, { px: p.x, py: p.y, pz: p.z, fx: dx / n, fy: dy / n, fz: dz / n, ux: 0, uy: 1, uz: 0 });
  return out;
}

async function renderOnce(app, bank, sc, o, solo) {
  const sr = o.sampleRate, T = o.seconds;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.floor(sr * T), sampleRate: sr });
  if (o.worklet === false) ctx.__tramWorklet = false;
  await AudioEngine.prepare(ctx);
  const eng = new AudioEngine(ctx, bank, { route: app.route, layout: app.layout, features: app.audio.features }, { solo, raw: o.raw, seed: o.seed ?? 1, ambMute: o.ambMute });
  eng.setLevel(1, 0, 0.001);
  const dt = 1 / (o.updateHz || 60);
  const st = { t: 0, s: sc.s0, speed: 0, accel: 0, throttle: 0, state: 'run', night: o.night ?? 0, tod: o.tod ?? 0, wind: o.wind ?? 0.35, listener: {} };
  let s = sc.s0, k = 0;
  for (let t = 0; t < T; t += dt) {
    st.t = t; st.s = app.route.wrap(s);
    st.speed = sc.v(t); st.accel = sc.acc(t); st.throttle = sc.thr(t);
    listenerAt(app.route, st.s, st.listener);
    while (k < sc.ev.length && sc.ev[k].t <= t) { eng.event(sc.ev[k].type, sc.ev[k].data, sc.ev[k].t); k++; }
    eng.update(dt, st, t);
    s += st.speed * dt;
  }
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  return { buf, ms: performance.now() - t0, endS: app.route.wrap(s), eng };
}

const db = (x) => +(20 * Math.log10(Math.max(1e-9, x))).toFixed(1);

function measure(buf, withBands = false, windowS = 0) {
  const chans = [buf.getChannelData(0), buf.getChannelData(1)];
  let e = 0, pk = 0, clipped = 0, nan = 0;
  for (const c of chans) for (let i = 0; i < c.length; i++) {
    const x = c[i];
    if (!Number.isFinite(x)) { nan++; continue; }
    e += x * x; const a = Math.abs(x); if (a > pk) pk = a; if (a >= 0.999) clipped++;
  }
  const out = { rms: db(Math.sqrt(e / (chans[0].length * 2))), peak: db(pk) };
  if (clipped) out.clipped = clipped;
  if (nan) out.nan = nan;
  if (withBands) out.bands = octaveBands(chans[0], buf.sampleRate);
  if (windowS) {
    const w = Math.floor(windowS * buf.sampleRate), list = [];
    for (let i = 0; i + w <= chans[0].length; i += w) {
      let s = 0; for (let j = i; j < i + w; j++) s += chans[0][j] ** 2 + chans[1][j] ** 2;
      list.push(db(Math.sqrt(s / (2 * w))));
    }
    out.windows = list;
  }
  return out;
}

/** Octave-band RMS (dB) with simple RBJ band-pass filters. */
function octaveBands(x, sr) {
  const res = {};
  for (const fc of [63, 125, 250, 500, 1000, 2000, 4000, 8000]) {
    const w = (2 * Math.PI * fc) / sr, al = Math.sin(w) / (2 * 1.41), cw = Math.cos(w), a0 = 1 + al;
    const b0 = al / a0, b2 = -al / a0, a1 = (-2 * cw) / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, e = 0;
    for (let i = 0; i < x.length; i++) {
      const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = y; e += y * y;
    }
    res[fc] = db(Math.sqrt(e / x.length));
  }
  return res;
}

function wavBase64(buf) {
  const n = buf.length, ch = buf.numberOfChannels, sr = buf.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  str(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const cs = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { data.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(cs[c][i] * 32767))), true); o += 2; }
  const bytes = new Uint8Array(data.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function runAudioTest(app, opts = {}) {
  const o = { seconds: 6, sampleRate: 48000, ...opts };
  const t0 = performance.now();
  const bank = await bankFor(o.sampleRate);
  const bankMs = Math.round(bank.ms || performance.now() - t0);
  const sc = scenario(app, o);
  const report = { scenario: sc.name, seconds: o.seconds, s0: +sc.s0.toFixed(1), bankMs, bankSource: bank.source, layers: {} };
  const list = o.layers === 'none' ? [] : o.layers || BUSES;
  for (const name of list) {
    const r = await renderOnce(app, bank, sc, o, name);
    report.layers[name] = measure(r.buf, !!o.bands);
  }
  const mix = await renderOnce(app, bank, sc, o, o.solo || null);
  report.mix = measure(mix.buf, true, o.window ?? 0.5);
  report.mix.renderMs = Math.round(mix.ms);
  report.endS = +mix.endS.toFixed(1);
  report.ambience = { ...mix.eng.layers.ambience.debug };
  report.worklet = mix.eng.worklet;
  if (o.wav) report.wav = wavBase64(mix.buf);
  return report;
}
