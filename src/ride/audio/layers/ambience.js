// Street ambience heard from the cab, driven by the people actually in the street
// (app.crowd agents; a layout-based stand-in when the crowd module is absent):
//  - conversations: people standing, waiting and sitting 9-40 m away talk in turns;
//    each turn is an excerpt of a pooled utterance, played at that person's voice
//    pitch, placed at their position (level, air absorption, stereo direction) and
//    followed as the tram moves. The pool is resequenced endlessly, so the murmur
//    never loops. A live speech-shaped hubbub stands for the crowd further away.
//  - footsteps of the walkers passing within a few metres (on their actual gait
//    phase), audible when the tram stands;
//  - birds (phrases assembled from single notes at runtime), swifts screaming over
//    the roofs (most active at dusk), a distant laugh or call, café tableware, far-off
//    traffic and car horns, leaves in the wind.
// All of it reaches the driver through the cab shell (engine far shell): closed and
// dark while moving, the driver's window open at a stop, wide open with the doors.
import { RNG, noise1, hash2 } from '../../../core/rng.js';
import { glide, clamp } from '../dsp.js';
import { SPEAKERS, UTT_PER } from '../synth/voice.js';

const SLOTS = 7;       // HRTF emitters for one-shots
const STEPS = 3;       // footstep emitters following walkers
const TALKERS = 12;    // concurrent conversation voices
const HEAD = 1.55;     // m, mouth height
// crowd agent states (crowd/behaviour/agent.js ST): WALK 0, GOTO 1, STAND 2, WAIT 3, SEATED 4, PLATFORM 5
const isStill = (a) => a.state >= 2;
const isWalking = (a) => a.state <= 1 && a.speed > 0.4;
const byDist = (p, q) => p.dist - q.dist;

export class AmbienceLayer {
  constructor(e) {
    this.e = e;
    const ctx = e.ctx;
    this.pre = new GainNode(ctx, { gain: 1 });
    this.pre.connect(e.bus.ambience);
    this.rng = RNG.from('audio-amb', e.opts.seed ?? 3);

    // ---- conversations
    this.talkBus = new GainNode(ctx, { gain: 1 });
    this.talkBus.connect(this.pre);
    this.talkers = [];
    for (let i = 0; i < TALKERS; i++) {
      const lvl = new GainNode(ctx, { gain: 0 });
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 5000, Q: 0.6 });
      const pan = new StereoPannerNode(ctx, { pan: 0 });
      lvl.connect(lp).connect(pan).connect(this.talkBus);
      this.talkers.push({ lvl, lp, pan, busy: -1, end: -1, who: null, serial: -1, pos: null, gain: 0 });
    }
    // ---- far crowd: speech-shaped noise with a syllabic flutter, one per side
    this.hub = [-1, 1].map((side) => {
      const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 520, Q: 0.6 });
      const hs = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 1400, gain: -6 });
      const mod = new GainNode(ctx, { gain: 1 });
      const depth = new GainNode(ctx, { gain: 0.35 });
      e.drift(4.5).connect(depth).connect(mod.gain);
      const g = new GainNode(ctx, { gain: 0 });
      const pan = new StereoPannerNode(ctx, { pan: side * 0.55 });
      e.noise().connect(bp).connect(hs).connect(mod).connect(g).connect(pan).connect(this.pre);
      return { g, side };
    });
    // ---- distant traffic: a live far rumble, plus cars passing on far streets (random
    // one-shots with their own pan sweeps)
    this.traffic = { g: new GainNode(ctx, { gain: 0 }) };
    this.traffic.g.connect(this.pre);
    this.rumble = new GainNode(ctx, { gain: 1 });
    const rd = new GainNode(ctx, { gain: 0.3 });
    e.drift(0.12).connect(rd).connect(this.rumble.gain);
    this.rumble.connect(this.traffic.g);
    for (const side of [-1, 1]) {
      const lp1 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 110, Q: 0.5 });
      const lp2 = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 260, Q: 0.6 });
      const g = new GainNode(ctx, { gain: 0.6 });
      e.noise().connect(lp1).connect(lp2).connect(g).connect(new StereoPannerNode(ctx, { pan: side * 0.7 })).connect(this.rumble);
    }
    this.leaves = { bp: new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 4800, Q: 0.5 }), g: new GainNode(ctx, { gain: 0 }) };
    e.noise().connect(this.leaves.bp).connect(this.leaves.g).connect(this.pre);

    // ---- one-shot emitters
    const emitter = () => {
      const g = new GainNode(ctx, { gain: 0 });
      const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 16000, Q: 0.6 });
      const p = e.panner(3, 1);
      g.connect(lp).connect(p).connect(this.pre);
      return { g, lp, p, until: -1, who: null, serial: -1, ph: 0, kind: 0 };
    };
    this.slots = Array.from({ length: SLOTS }, emitter);
    this.steps = Array.from({ length: STEPS }, emitter);

    this.surveyT = -1;
    this.dens = [0.6, 0.6];
    this.people = 0.6;
    this.still = [];
    this.walkers = [];
    this._walkerPool = [];      // {a, dist} records reused by every survey
    this.virtual = false;
    this.cafe = null;
    this._cafe = { c: null, w: 0 };
    this.trees = [];
    this.bags = {};
    this.lastPlayed = new Map();
    this._rel = {};
    this.debug = { talking: 0, steps: 0, agents: 0, still: 0, walkers: 0 };
    // test hook (engine opts.ambMute: ['talk', 'hub', 'traffic', 'leaves', 'shots'])
    const mute = new Set(e.opts.ambMute || []);
    if (mute.has('talk')) this.talkBus.disconnect();
    if (mute.has('hub')) for (const h of this.hub) h.g.disconnect();
    if (mute.has('traffic')) this.traffic.g.disconnect();
    if (mute.has('leaves')) this.leaves.g.disconnect();
    if (mute.has('shots')) for (const sl of [...this.slots, ...this.steps]) sl.p.disconnect();
  }

  update(dt, st, now, tick) {
    const e = this.e, v = st.speed;
    if (st.t - this.surveyT > 0.5 || st.t < this.surveyT) { this.surveyT = st.t; this._survey(st); }

    const day = 1 - clamp(st.night || 0, 0, 1);
    // people near the line pause and step back while the tram rolls past
    const duck = 1 / (1 + v / 16);
    for (const h of this.hub) glide(h.g.gain, 0.14 * this.dens[h.side > 0 ? 1 : 0] * duck, now, 1.2, 1e-3);
    glide(this.talkBus.gain, 1.25 * duck, now, 0.8, 1e-3);
    glide(this.traffic.g.gain, 0.07 * (0.6 + 0.4 * day), now, 1.5, 1e-3);
    const wind = clamp(st.wind ?? 0.35, 0, 1);
    const gust = 0.6 + 0.4 * noise1(st.t * 0.35, 9);
    glide(this.leaves.g.gain, (0.0025 + 0.0125 * wind * gust) * (this.trees.length ? 1 : 0.4), now, 0.4, 1e-3);

    this._talk(dt, st, now, tick);
    this._footsteps(st, now);

    // ---- one-shots (Poisson spawns)
    if (dt > 0) {
      const r = this.rng, crowd = this.people;
      const P = (rate) => r.next() < rate * dt;
      const tod = st.tod ?? 0;
      const still = v < 0.5;
      const birdRate = still && this.trees.length ? 0.15 : 0.08;
      if (P(birdRate * (0.25 + 0.75 * day))) this._bird(st, now);
      if (P(0.035 * (tod > 0.5 ? 1.5 : 1) * (0.4 + 0.6 * Math.max(day, tod > 0.5 ? 1 : 0)))) this._swift(st, now);
      if (this.virtual && still && P(0.16 * crowd)) this._virtualWalker(st, now);
      if (still && e.doorsOpen && P(0.03 * crowd)) this._voice('laugh', st, now);
      if (P(0.012 * crowd)) this._voice('call', st, now);
      if (this.cafe && P(0.35 * this.cafe.w * crowd)) this._clink(st, now);
      if (P(1 / 2.6)) this._carPass(now);
      if (P(1 / 75)) this._horn(st, now);
    }
  }

  // ------------------------------------------------------------------ surroundings

  /** Every 0.5 s: the café and trees around, the people standing (talkers) and walking
   *  close by (footsteps), the crowd density per side. Reuses its arrays and records. */
  _survey(st) {
    const { layout, route } = this.e;
    const s = st.s, ci = layout.chunkIndex(s);
    let cafe = null;
    const trees = this.trees;
    trees.length = 0;
    for (let j = -1; j <= 2; j++) {
      for (const c of layout.inChunk('cafes', ci + j)) {
        const dd = Math.max(0, Math.abs(route.delta(s, (c.s0 + c.s1) / 2)) - (c.s1 - c.s0) / 2);
        const w = clamp(1 - dd / 45, 0, 1);
        if (w > 0 && (!cafe || w > cafe.w)) { cafe = this._cafe; cafe.c = c; cafe.w = w; }
      }
      for (const t of layout.inChunk('trees', ci + j)) trees.push(t);
    }
    this.cafe = cafe;

    const L = st.listener;
    const agents = this._agents();
    this.virtual = !agents;
    let near0 = 0, near1 = 0, nw = 0;
    const still = this.still, walkers = this.walkers, pool = this._walkerPool;
    still.length = 0; walkers.length = 0;
    if (agents && L) {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (a.active === false) continue;           // (a stand-in list may hold inactive ones)
        const dx = a.x - L.px, dz = a.z - L.pz, dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > 45) continue;
        if (dist < 30) { if (a.d >= 0) near1++; else near0++; }
        if (isStill(a) && dist > 9) still.push(a);
        else if (isWalking(a) && dist < 12) {
          const w = pool[nw] || (pool[nw] = { a: null, dist: 0 });
          w.a = a; w.dist = dist; nw++;
          walkers.push(w);
        } else if (isWalking(a) && dist > 9 && a.leader) still.push(a); // walking groups chat too
      }
      for (let i = nw; i < pool.length; i++) pool[i].a = null;   // (hold no stale agents)
      walkers.sort(byDist);
      this.dens[0] = clamp(near0 / 12, 0.08, 1.6);
      this.dens[1] = clamp(near1 / 12, 0.08, 1.6);
      this.debug.agents = near0 + near1;
    } else {
      // stand-in: density from what the layout puts here (cafés, stops, cross streets)
      const dens = [0.55, 0.55];
      if (cafe) dens[cafe.c.side > 0 ? 1 : 0] += 0.45 * cafe.w;
      if (layout.isInStation(s, 35)) { dens[0] += 0.35; dens[1] += 0.45; }
      if (layout.isInCrossStreet(s, 1, 15) || layout.isInCrossStreet(s, -1, 15)) { dens[0] += 0.1; dens[1] += 0.1; }
      this.dens = dens.map((d) => clamp(d, 0, 1.6));
      const r = this.rng;
      for (const side of [-1, 1]) {
        const n = Math.round(7 * this.dens[side > 0 ? 1 : 0]);
        for (let i = 0; i < n; i++) {
          const ss = s + r.range(-30, 45);
          const p = this.e.at(ss, side * r.range(4.8, layout.halfWidth(ss, side) - 0.6), 0);
          this.still.push({ x: p.x, y: p.y, z: p.z, appearance: r.int(0, 1e6), serial: 0, virtual: true });
        }
      }
    }
    this.people = 0.5 * (this.dens[0] + this.dens[1]);
    this.debug.still = this.still.length;
    this.debug.walkers = this.walkers.length;
  }

  _agents() {
    const c = this.e.crowd;
    if (!c) return null;
    try { const a = c(); return Array.isArray(a) && a.length ? a : null; } catch { return null; }
  }

  // ------------------------------------------------------------------ conversations

  _talk(dt, st, now, tick) {
    const e = this.e, r = this.rng;
    let active = 0;
    for (const t of this.talkers) if (t.end > now) active++;
    this.debug.talking = active;
    // roughly a third of the people standing about are talking at any moment
    const target = Math.min(TALKERS, Math.round(this.still.length * 0.35 + 1));
    if (dt > 0 && active < target && r.next() < 4 * dt) this._startTalk(st, now);
    if (!tick) return;
    for (const t of this.talkers) {
      if (t.end < now - 0.2 || !t.who) continue;
      if (!t.who.virtual && (t.who.serial !== t.serial || !t.who.active)) { // walked off / recycled
        glide(t.lvl.gain, 0, now, 0.15, 0); t.who = null; continue;
      }
      this._aim(t, now, 0.12);
    }
  }

  _startTalk(st, now) {
    const e = this.e, r = this.rng;
    const t = this.talkers.find((x) => x.busy < now);
    if (!t || !this.still.length) return;
    const busy = new Set(this.talkers.filter((x) => x.end > now).map((x) => x.who));
    let who = null;
    for (let k = 0; k < 6 && !who; k++) { const c = r.pick(this.still); if (!busy.has(c)) who = c; }
    if (!who) return;
    const h = hash2(who.appearance | 0, 101);
    const spk = h % SPEAKERS, rate = 0.94 + 0.12 * ((h >>> 8) % 1000) / 1000;
    const u = r.int(0, UTT_PER - 1);
    const buf = e.bank.get('utt' + (u * SPEAKERS + spk)) || e.bank.get('utt' + spk);
    if (!buf) return;
    // one turn: an excerpt of the utterance
    const len = Math.min(buf.duration - 0.1, r.range(1.4, 3.4));
    const off = r.range(0, Math.max(0, buf.duration - len));
    const t0 = now + 0.05, dur = len / rate;
    t.who = who; t.serial = who.serial; t.pos = who.virtual ? { x: who.x, y: who.y + HEAD, z: who.z } : null;
    t.gain = r.range(0.75, 1.25);
    this._aim(t, now, 0);
    const src = e.shot(buf, t.lvl, t0, 0, rate, off, len);
    if (!src) return;
    const g = src.out.gain;
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(1, t0 + 0.06);
    g.setValueAtTime(1, t0 + dur - 0.1);
    g.linearRampToValueAtTime(0, t0 + dur);
    t.end = t0 + dur;
    t.busy = t.end + r.range(0.3, 2.2); // then listens for a while
  }

  /** Level, air absorption and direction of a talker from where they are now. */
  _aim(t, now, tc) {
    const w = t.who;
    let p = t.pos;
    if (!p && w) { p = this._aimP || (this._aimP = { x: 0, y: 0, z: 0 }); p.x = w.x; p.y = w.y + HEAD; p.z = w.z; }
    if (!p) return;
    const rel = this.e.relative(p, this._rel);
    const d = Math.max(4, rel.dist);
    const level = t.gain * clamp(4 / d, 0, 0.45);
    // air, bodies in the way, and a little head shadow from behind
    const lp = clamp(9000 * Math.pow(4 / d, 0.55), 1500, 7500) * (0.8 + 0.2 * (rel.front + 1) / 2);
    if (tc <= 0) {
      t.lvl.gain.cancelScheduledValues(now); t.lvl.gain.setValueAtTime(level, now); t.lvl.gain.__last = level;
      t.lp.frequency.setValueAtTime(lp, now); t.lp.frequency.__last = lp;
      t.pan.pan.setValueAtTime(rel.pan * 0.9, now); t.pan.pan.__last = rel.pan * 0.9;
    } else {
      glide(t.lvl.gain, level, now, tc, 5e-3);
      glide(t.lp.frequency, lp, now, tc, 5e-3);
      glide(t.pan.pan, rel.pan * 0.9, now, tc, 5e-3);
    }
  }

  // ------------------------------------------------------------------ footsteps

  /** Steps of the walkers passing close by, fired on their gait phase (0 and 0.5). */
  _footsteps(st, now) {
    const e = this.e;
    const listening = st.speed < 1.0 && !this.virtual;
    let n = 0;
    for (let i = 0; i < STEPS; i++) {
      const em = this.steps[i];
      let a = em.who;
      if (a && (!listening || a.serial !== em.serial || !a.active)) { em.who = a = null; }
      if (!a && listening) {
        const c = this.walkers.find((x) => !this.steps.some((o) => o.who === x.a) && x.a.active);
        if (c) {
          a = em.who = c.a; em.serial = a.serial; em.ph = a.phase;
          em.kind = hash2(a.appearance | 0, 202) % 3;
          e.anchor(em.p, () => ({ x: a.x, y: a.y + 0.03, z: a.z }), now + 3600);
          em.lp.frequency.setValueAtTime(14000, now);
          em.g.gain.setValueAtTime(1, now);
        }
      }
      if (!a) { em.p.__em && (em.p.__em.until = 0); continue; }
      n++;
      const ph = a.phase, prev = em.ph;
      em.ph = ph;
      // a heel strike at each half cycle
      const crossed = (prev < 0.5 && ph >= 0.5) || ph < prev;
      if (!crossed || a.speed < 0.3) continue;
      const r = this.rng;
      const buf = e.bank.get('step' + (em.kind + 3 * r.int(0, 2)));
      if (!buf) continue;
      const accent = ph < prev ? 1 : 0.85; // left / right foot differ a little
      const g = (em.kind === 1 ? r.range(0.25, 0.4) : r.range(0.35, 0.6)) * accent;
      e.shot(buf, em.g, now + 0.02, g, 1 + r.range(-0.05, 0.05));
    }
    this.debug.steps = n;
  }

  /** Stand-in passer-by when no crowd simulation runs. */
  _virtualWalker(st, now) {
    const e = this.e, r = this.rng;
    const kind = r.int(0, 2);
    const steps = r.int(7, 16);
    const interval = 1 / r.range(1.75, 2.15);
    const sl = this._slot(now, steps * interval + 0.3);
    if (!sl) return;
    const side = r.chance(0.5) ? 1 : -1;
    const d = side * r.range(4.6, 9.5);
    const s0 = st.s + r.range(-8, 22);
    const dir = r.chance(0.5) ? 1 : -1, sp = r.range(1.15, 1.5);
    const t0 = now;
    const where = (t) => { const p = e.at(s0 + dir * sp * (t - t0), d, 0.05); return { x: p.x, y: p.y, z: p.z }; };
    this._place(sl, where, st, now, kind === 1 ? r.range(0.25, 0.4) : r.range(0.35, 0.6), 2);
    for (let i = 0; i < steps; i++) {
      const buf = e.bank.get('step' + (kind + 3 * r.int(0, 2)));
      if (!buf) return;
      const accent = i % 2 ? 0.85 : 1;
      e.shot(buf, sl.g, now + 0.05 + i * interval * (1 + r.range(-0.03, 0.03)), accent * r.range(0.8, 1.1), 1 + r.range(-0.05, 0.05));
    }
  }

  // ------------------------------------------------------------------ one-shots

  _slot(now, dur) {
    for (const sl of this.slots) if (sl.until < now) { sl.until = now + dur + 0.25; return sl; }
    return null;
  }

  /** Prepare a slot for a sound at a world point (or path): air absorption, level, position. */
  _place(sl, where, st, now, gain, ref) {
    const p = typeof where === 'function' ? where(now) : where;
    const dist = this.e.relative(p, this._rel).dist;
    sl.lp.frequency.setValueAtTime(clamp(18000 * Math.pow(8 / Math.max(8, dist), 0.6), 2200, 18000), now);
    sl.g.gain.setValueAtTime(gain, now);
    sl.p.refDistance = ref;
    this.e.anchor(sl.p, where, sl.until);
  }

  /** Shuffle bag over the variants of `name`: none replays within `hold` seconds. */
  _pick(name, now, hold = 90) {
    const n = this.e.bank.variants(name).length;
    if (!n) return null;
    let bag = this.bags[name];
    if (!bag || !bag.length) {
      bag = this.bags[name] = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) { const j = this.rng.int(0, i); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    }
    for (let k = 0; k < bag.length; k++) {
      const key = name + bag[k];
      if (now - (this.lastPlayed.get(key) ?? -1e9) >= hold) {
        bag.splice(k, 1);
        this.lastPlayed.set(key, now);
        return this.e.bank.get(key);
      }
    }
    return null;
  }

  _bird(st, now) {
    const e = this.e, r = this.rng;
    const kind = r.weighted([['sparrow', 0.62], ['bulbul', 0.28], ['pigeon', 0.1]]);
    const notes = kind === 'pigeon' ? [] : e.bank.variants(kind);
    // assemble the phrase: [buffer, time offset, gain, rate]
    const phrase = [];
    let t = 0;
    if (kind === 'pigeon') {
      const buf = this._pick('pigeon', now, 20);
      if (!buf) return;
      phrase.push([buf, 0, 1, 1 + r.range(-0.03, 0.03)]);
      t = buf.duration;
    } else {
      if (notes.length < 4) return;
      const count = kind === 'sparrow' ? r.int(2, 7) : r.int(3, 5);
      let note = r.pick(notes), rep = 0;
      for (let i = 0; i < count; i++) {
        // sparrows repeat a note a few times before changing it
        if (kind === 'bulbul' || rep >= r.int(1, 3)) { note = r.pick(notes); rep = 0; }
        rep++;
        phrase.push([note, t, r.range(0.6, 1), 1 + r.range(-0.025, 0.025)]);
        t += note.duration + (kind === 'sparrow' ? r.range(0.05, 0.18) : r.range(0.035, 0.12));
      }
    }
    const sl = this._slot(now, t);
    if (!sl) return;
    let p;
    if (kind === 'pigeon' || !this.trees.length) {
      // on a ledge or balcony
      const side = r.chance(0.5) ? 1 : -1;
      const ss = st.s + r.range(-15, 50);
      p = e.at(ss, side * (e.layout.halfWidth(ss, side) - 0.4), r.range(5, 14));
    } else {
      const tr = r.pick(this.trees);
      p = e.at(tr.s + r.range(-1, 1), tr.d + r.range(-1, 1), (tr.height || 6) * r.range(0.55, 0.9));
    }
    this._place(sl, { x: p.x, y: p.y, z: p.z }, st, now, kind === 'pigeon' ? 0.35 : r.range(0.25, 0.5), 3);
    for (const [buf, dt, g, rate] of phrase) e.shot(buf, sl.g, now + 0.02 + dt, g, rate);
  }

  _swift(st, now) {
    const e = this.e, r = this.rng;
    const buf = this._pick('swift', now, 25);
    const sl = buf && this._slot(now, buf.duration);
    if (!sl) return;
    // a small party racing along above the street
    const s0 = st.s + r.range(-20, 60), d0 = r.range(-12, 12), h = r.range(16, 30);
    const dir = r.chance(0.5) ? 1 : -1, sp = r.range(10, 17), lat = r.range(-4, 4);
    const t0 = now;
    const where = (t) => { const p = e.at(s0 + dir * sp * (t - t0), d0 + lat * (t - t0), h); return { x: p.x, y: p.y, z: p.z }; };
    this._place(sl, where, st, now, r.range(0.12, 0.25), 6);
    e.shot(buf, sl.g, now + 0.02, 1, 1 + r.range(-0.05, 0.05));
  }

  /** A laugh (12-25 m, someone standing or sitting) or a call across the street (20-50 m). */
  _voice(kind, st, now) {
    const e = this.e, r = this.rng;
    const [d0, d1] = kind === 'call' ? [20, 50] : [12, 25];
    let p = null;
    const L = st.listener;
    if (!this.virtual && L) {
      const pool = this.still.filter((a) => { const d = Math.hypot(a.x - L.px, a.z - L.pz); return d >= d0 && d <= d1; });
      if (pool.length) { const a = r.pick(pool); p = { x: a.x, y: a.y + HEAD, z: a.z }; }
    }
    if (!p) {
      const side = r.chance(0.5) ? 1 : -1, ahead = r.range(d0, d1) * (r.chance(0.75) ? 1 : -1);
      const q = e.at(st.s + ahead, side * r.range(4.5, 10.5), HEAD);
      p = { x: q.x, y: q.y, z: q.z };
    }
    const buf = this._pick(kind, now, 90);
    const sl = buf && this._slot(now, buf.duration);
    if (!sl) return;
    const g = kind === 'call' ? r.range(0.4, 0.6) : r.range(0.13, 0.2);
    this._place(sl, p, st, now, g, 4);
    e.shot(buf, sl.g, now + 0.02, 1, 1 + r.range(-0.03, 0.03));
  }

  _clink(st, now) {
    const e = this.e, r = this.rng;
    const tables = this.cafe.c.tables;
    if (!tables || !tables.length) return;
    const vs = e.bank.variants('clink');
    if (!vs.length) return;
    const buf = r.pick(vs);
    const sl = this._slot(now, buf.duration);
    if (!sl) return;
    const tb = r.pick(tables);
    const p = e.at(tb.s + r.range(-0.4, 0.4), tb.d + r.range(-0.4, 0.4), 0.78);
    this._place(sl, { x: p.x, y: p.y, z: p.z }, st, now, r.range(0.12, 0.25), 1.5);
    e.shot(buf, sl.g, now + 0.02, 1, 1 + r.range(-0.02, 0.02));
  }

  /** A car passing on a distant street: its own level, speed and pan sweep. */
  _carPass(now) {
    const e = this.e, r = this.rng;
    const vs = e.bank.variants('carpass');
    if (!vs.length) return;
    const buf = r.pick(vs), rate = r.range(0.9, 1.1), dur = buf.duration / rate, t0 = now + 0.05;
    const pan = new StereoPannerNode(e.ctx, { pan: 0 });
    const p0 = r.range(-1, 1), p1 = clamp(p0 + r.range(-1.2, 1.2), -1, 1);
    pan.pan.setValueAtTime(p0, t0 + dur * 0.33);
    pan.pan.linearRampToValueAtTime(p1, t0 + dur * 0.67);
    pan.connect(this.traffic.g);
    const src = e.shot(buf, pan, t0, r.range(0.25, 0.8), rate);
    if (src) src.addEventListener('ended', () => { try { pan.disconnect(); } catch { /* gone */ } });
  }

  _horn(st, now) {
    const e = this.e, r = this.rng;
    const vs = e.bank.variants('horn');
    if (!vs.length) return;
    const buf = r.pick(vs);
    const sl = this._slot(now, buf.duration + 1.5);
    if (!sl) return;
    const side = r.chance(0.5) ? 1 : -1;
    const p = e.at(st.s + r.range(-60, 180), side * r.range(16, 45), 1.0);
    this._place(sl, { x: p.x, y: p.y, z: p.z }, st, now, r.range(0.3, 0.5), 20);
    e.shot(buf, sl.g, now + 0.02, 1);
  }
}
