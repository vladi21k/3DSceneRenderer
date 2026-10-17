import * as THREE from 'three';
import { RNG, loopNoise1 } from '../core/rng.js';
import { CHUNK_LEN, TRACK_ZONE_HALF, TRACK_OFFSET } from '../core/config.js';

// Deterministic master plan of the whole loop. Every generator reads its placements
// from here so modules never overlap each other and the crowd knows the obstacles.
//
// All placements are in route coordinates (s, d) unless stated otherwise; `side`
// is +1 for the right side of the street (direction of travel) and -1 for the left.

export const PLATFORM_W = 2.9;        // platform depth from the corridor edge
export const PLATFORM_H = 0.30;       // platform top above paving (low-floor tram)
export const PLATFORM_LEN = 52;
export const POLE_D = TRACK_ZONE_HALF + 0.55;   // lamp / catenary pole line
export const TREE_D = TRACK_ZONE_HALF + 1.75;   // street tree line
export const SIDE_LOT_START = 16;                // side-street facades begin this far from the main facade line

export class Layout {
  constructor(route, seed = 7) {
    this.route = route;
    this.seed = seed;
    this.L = route.length;
    this.nChunks = Math.ceil(this.L / CHUNK_LEN);
    this._planStations();
    this._planCrossovers();
    this._planCrossStreets();
    this._planLots();
    this._planPoles();
    this._planTrees();
    this._planCafes();
    this._planFurniture();
    this._planObstacles();
    this._bucket();
    this._planStart();
  }

  // ------------------------------------------------------------------ street width
  /** Facade line offset magnitude (m) on `side` (+1 right, -1 left) at s. */
  halfWidth(s, side) {
    const base = 11.9;
    const sw = this.route.wrap(s), L = this.route.length;   // periodic in L: no seam at the loop wrap
    const n = loopNoise1(sw, L, 170, side > 0 ? 11 : 23) * 1.1 + loopNoise1(sw, L, 55, side > 0 ? 5 : 9) * 0.25;
    let w = base + n;
    // keep room around platforms
    for (const st of this.stations || []) {
      const dd = Math.abs(this.route.delta(st.s, s));
      if (dd < st.len / 2 + 25) w = Math.max(w, 12.6);
    }
    return w;
  }

  isInCrossStreet(s, side, margin = 0) {
    for (const c of this.crossStreets) {
      if (c.side !== side && c.side !== 0) continue;
      if (Math.abs(this.route.delta(c.s, s)) < c.width / 2 + margin) return c;
    }
    return null;
  }
  isInStation(s, margin = 0) {
    for (const st of this.stations) if (Math.abs(this.route.delta(st.s, s)) < st.len / 2 + margin) return st;
    return null;
  }
  isInCrossover(s, margin = 0) {
    for (const c of this.crossovers) {
      const d0 = this.route.delta(c.s0, s), d1 = this.route.delta(c.s1, s);
      if (d0 > -margin && d1 < margin) return c;
    }
    return null;
  }

  // ------------------------------------------------------------------ stations
  /** Max |curvature| over [s0, s1]. */
  maxCurv(s0, s1, step = 4) {
    let k = 0;
    for (let s = s0; s <= s1; s += step) k = Math.max(k, Math.abs(this.route.curvature(s)));
    return k;
  }

  _planStations() {
    const r = this.route, rng = RNG.from(this.seed, 'stations');
    this.stations = [];
    // stops need nearly straight track (R > ~1000 m) for the platform plus approach
    let s = 620;
    while (s < this.L - 300) {
      if (this.maxCurv(s - 70, s + 45) < 1 / 1000 && Math.abs(r.grade(s)) < 0.035) {
        this.stations.push({ id: this.stations.length, s, len: PLATFORM_LEN, stopS: s + PLATFORM_LEN / 2 - 4 });
        s += rng.range(620, 860);
      } else s += 10;
    }
    // check wrap distance between last and first
    if (this.stations.length > 1 && this.L - this.stations[this.stations.length - 1].s + this.stations[0].s < 400) this.stations.pop();
    for (const st of this.stations) {
      st.platforms = [
        { side: +1, s0: st.s - st.len / 2, s1: st.s + st.len / 2, d0: TRACK_ZONE_HALF, d1: TRACK_ZONE_HALF + PLATFORM_W, h: PLATFORM_H },
        { side: -1, s0: st.s - st.len / 2, s1: st.s + st.len / 2, d0: -TRACK_ZONE_HALF - PLATFORM_W, d1: -TRACK_ZONE_HALF, h: PLATFORM_H },
      ];
    }
  }

  // ------------------------------------------------------------------ crossovers (switches)
  _planCrossovers() {
    // A single crossover between the two tracks a little beyond some stations, plus one
    // on the main avenue so the default view shows switches in the distance.
    this.crossovers = [];
    const add = (s0, dir) => this.crossovers.push({ s0, s1: s0 + 34, len: 34, from: dir, kind: 'single' });
    // facing points on the ride track at s0 when from = +1 (diverges right->left)
    const straightish = (s0) => this.maxCurv(s0 - 5, s0 + 40) < 1 / 1500;
    for (let s0 = 230; s0 < 420; s0 += 5) if (straightish(s0)) { add(s0, +1); break; }
    this.stations.forEach((st, i) => {
      if (i % 2 === 1) {
        for (let s0 = st.s + st.len / 2 + 50; s0 < st.s + st.len / 2 + 160; s0 += 5) {
          if (straightish(s0)) { add(s0, i % 4 === 1 ? -1 : +1); break; }
        }
      }
    });
  }

  // ------------------------------------------------------------------ cross streets
  _planCrossStreets() {
    const r = this.route, rng = RNG.from(this.seed, 'cross');
    this.crossStreets = [];
    // junction curve: a wide intersection on the outer side
    for (const seg of r.segments) {
      if (seg.junction) this.crossStreets.push({ s: (seg.s0 + seg.s1) / 2, width: 18, side: +1, junction: true, depth: 70 });
    }
    let s = 60;
    while (s < this.L - 60) {
      s += rng.range(110, 230);
      const width = rng.range(8.5, 13);
      if (this.isInStation(s, width / 2 + 30) || this.isInCrossover(s, width / 2 + 12)) continue;
      if (this.crossStreets.some((c) => Math.abs(r.delta(c.s, s)) < c.width / 2 + width / 2 + 40)) continue;
      const seg = r.segmentAt(s);
      if (seg.type === 'curve' && seg.radius < 200) continue;
      const side = rng.weighted([[0, 0.45], [+1, 0.28], [-1, 0.27]]);
      this.crossStreets.push({ s, width, side, depth: rng.range(45, 80), angle: rng.range(-12, 12) * Math.PI / 180 });
    }
    this.crossStreets.sort((a, b) => a.s - b.s);
  }

  // ------------------------------------------------------------------ building lots
  _planLots() {
    const r = this.route;
    this.lots = [];
    for (const side of [-1, +1]) {
      const rng = RNG.from(this.seed, 'lots', side);
      // free intervals between the cross streets opening on this side
      const gaps = this.crossStreets.filter((c) => c.side === 0 || c.side === side)
        .map((c) => [c.s - c.width / 2, c.s + c.width / 2]).sort((x, y) => x[0] - y[0]);
      const free = [];
      if (!gaps.length) free.push([0, this.L, false]);
      else for (let i = 0; i < gaps.length; i++) {
        const fa = gaps[i][1];
        const fb = i + 1 < gaps.length ? gaps[i + 1][0] : gaps[0][0] + this.L;
        if (fb - fa > 3) free.push([fa, fb, true]);
      }
      let lotIndex = 0;
      for (const [fa, fb, bounded] of free) {
        let s = fa;
        while (fb - s > 0.5) {
          const k = Math.abs(r.curvature(s));
          const maxLen = k > 1 / 120 ? 9 : k > 1 / 300 ? 15 : 26;
          let len = Math.min(rng.range(11, 27), maxLen);
          const room = fb - s;
          if (room - len < 7) len = room;
          if (len > maxLen * 1.5) len = room / Math.ceil(room / maxLen) > maxLen ? maxLen : room / Math.ceil(room / maxLen);
          const s0 = s, s1 = Math.min(fb, s + len);
          const mid = (s0 + s1) / 2;
          const d = this.halfWidth(mid, side) + rng.range(0, 0.35);
          const lot = {
            id: `${side > 0 ? 'R' : 'L'}${lotIndex++}`,
            side, s0: r.wrap(s0), s1: r.wrap(s0) + (s1 - s0), len: s1 - s0, d,
            seed: (rng.next() * 4294967296) >>> 0,
            cornerStart: bounded && s0 === fa, cornerEnd: bounded && s1 >= fb - 1e-6,
            depth: rng.range(13, 20),
          };
          if (lot.cornerStart || lot.cornerEnd) lot.depth = SIDE_LOT_START; // corner block meets the side-street row
          lot.frame = this.lotFrame(lot);
          // corner flags in facade coordinates (u = 0 is the viewer-left end)
          lot.cornerU0 = side > 0 ? lot.cornerEnd : lot.cornerStart;
          lot.cornerU1 = side > 0 ? lot.cornerStart : lot.cornerEnd;
          this.lots.push(lot);
          s = s1;
        }
      }
    }
    // side-street lots (facades along cross streets), a couple per street side
    this.sideLots = [];
    for (const c of this.crossStreets) {
      const sides = c.side === 0 ? [-1, +1] : [c.side];
      for (const side of sides) {
        const rng = RNG.from(this.seed, 'side', Math.round(c.s), side);
        for (const edge of [-1, +1]) { // the two facades lining the side street
          let x = SIDE_LOT_START;
          while (x < c.depth + SIDE_LOT_START) {
            const len = Math.min(rng.range(10, 22), c.depth + SIDE_LOT_START - x + 2);
            const lot = { id: `X${Math.round(c.s)}_${side}_${edge}_${Math.round(x)}`, side, cross: c, edge, x0: x, x1: x + len, len, seed: (rng.next() * 4294967296) >>> 0, depth: rng.range(12, 18), sideStreet: true };
            lot.frame = this.sideLotFrame(lot);
            lot.s0 = c.s; lot.s1 = c.s;
            this.sideLots.push(lot);
            x += len;
          }
        }
      }
    }
  }

  /** Facade frame of a main-street lot. u runs to the viewer's right when looking at the
   *  facade from the street, v up, n out of the wall towards the street (right-handed). */
  lotFrame(lot) {
    const r = this.route;
    const sideD = lot.side * lot.d;
    const a = r.toWorld(lot.s0, sideD, 0), b = r.toWorld(lot.s1, sideD, 0);
    const p0 = lot.side > 0 ? b : a, p1 = lot.side > 0 ? a : b; // u = 0 at viewer-left end
    const uDir = new THREE.Vector3(p1.x - p0.x, 0, p1.z - p0.z);
    const width = uDir.length();
    uDir.normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const nDir = new THREE.Vector3().crossVectors(uDir, up).normalize();
    const g0 = p0.y, g1 = p1.y; // ground (paving) height at both ends of the facade
    const floorRef = Math.max(g0, g1);
    const origin = new THREE.Vector3(p0.x, floorRef, p0.z);
    const m = new THREE.Matrix4().makeBasis(uDir, up, nDir).setPosition(origin);
    return { origin, uDir, nDir, up, width, ground0: g0, ground1: g1, floorRef, matrix: m };
  }

  sideLotFrame(lot) {
    // side street leaves the main street at c.s on `side`, perpendicular (+angle)
    const r = this.route, c = lot.cross;
    const smp = r.sample(c.s);
    const dirOut = smp.right.clone().multiplyScalar(lot.side).applyAxisAngle(new THREE.Vector3(0, 1, 0), c.angle || 0);
    const along = smp.tanH.clone();
    const start = r.toWorld(c.s, lot.side * this.halfWidth(c.s, lot.side), 0);
    // facade line: offset by ±width/2 along the main street direction
    const off = along.clone().multiplyScalar(lot.edge * c.width / 2);
    const a = start.clone().add(off).addScaledVector(dirOut, lot.x0);
    const b = start.clone().add(off).addScaledVector(dirOut, lot.x1);
    // the facade faces into the side street: normal = -edge * along
    const nWanted = along.clone().multiplyScalar(-lot.edge);
    let p0 = a, p1 = b;
    let uDir = new THREE.Vector3(p1.x - p0.x, 0, p1.z - p0.z).normalize();
    let nDir = new THREE.Vector3().crossVectors(uDir, new THREE.Vector3(0, 1, 0)).normalize();
    if (nDir.dot(nWanted) < 0) { p0 = b; p1 = a; uDir.negate(); nDir.negate(); }
    const width = a.distanceTo(b);
    const up = new THREE.Vector3(0, 1, 0);
    // side streets keep the junction's elevation (flat) for simplicity
    const floorRef = start.y;
    const origin = new THREE.Vector3(p0.x, floorRef, p0.z);
    const m = new THREE.Matrix4().makeBasis(uDir, up, nDir).setPosition(origin);
    return { origin, uDir, nDir, up, width, ground0: floorRef, ground1: floorRef, floorRef, matrix: m };
  }

  // ------------------------------------------------------------------ poles (lamps + catenary)
  _planPoles() {
    const r = this.route;
    this.poles = [];
    let s = 6;
    while (s < this.L - 4) {
      const k = Math.abs(r.curvature(s));
      const spacing = k > 1 / 100 ? 13 : k > 1 / 300 ? 20 : 27;
      for (const side of [-1, +1]) {
        let d = POLE_D;
        const st = this.isInStation(s, 2);
        if (st) d = TRACK_ZONE_HALF + PLATFORM_W + 0.35;
        this.poles.push({ s, side, d: side * d, id: this.poles.length, lamp: true, banner: false });
      }
      s += spacing;
    }
    // A facing pair standing in a cross-street mouth moves to the nearer corner (same s for
    // both sides), or is dropped when that corner is already taken by another pair.
    const kept = [];
    for (let i = 0; i < this.poles.length; i += 2) {
      const pair = [this.poles[i], this.poles[i + 1]];
      const mouth = pair.map((p) => this.isInCrossStreet(p.s, p.side, 0.6)).find(Boolean);
      if (!mouth) { kept.push(pair); continue; }
      const half = mouth.width / 2 + 0.9, s0 = pair[0].s;
      const cands = [mouth.s - half, mouth.s + half].sort((a, b) => Math.abs(r.delta(s0, a)) - Math.abs(r.delta(s0, b)));
      const ok = (sn) => pair.every((p) => !this.isInCrossStreet(sn, p.side, 0.6))
        && !!this.isInStation(sn, 2) === !!this.isInStation(s0, 2)
        && !kept.some((q) => Math.abs(r.delta(q[0].s, sn)) < 6);
      const sn = cands.find(ok);
      if (sn === undefined) continue;
      for (const p of pair) p.s = r.wrap(sn);
      kept.push(pair);
    }
    this.poles = kept.flat().sort((a, b) => a.s - b.s || a.side - b.side);
    this.poles.forEach((p, i) => { p.id = i; });
    // banners on some poles (pairs)
    const rng = RNG.from(this.seed, 'banners');
    for (const p of this.poles) if (rng.chance(0.18)) p.banner = true;
  }

  // ------------------------------------------------------------------ trees
  _planTrees() {
    const r = this.route;
    this.trees = [];
    for (const side of [-1, +1]) {
      const rng = RNG.from(this.seed, 'trees', side);
      let s = rng.range(2, 8);
      while (s < this.L) {
        const ok = !this.isInStation(s, 4) && !this.isInCrossStreet(s, side, 2.5) && !this.isInCrossStreet(s, 0, 2.5)
          && !this.poles.some((p) => p.side === side && Math.abs(r.delta(p.s, s)) < 2.4)
          && Math.abs(r.curvature(s)) < 1 / 80;
        if (ok && rng.chance(0.86)) {
          const mature = rng.chance(0.18);
          this.trees.push({ s, side, d: side * (TREE_D + rng.range(-0.15, 0.15)), id: this.trees.length, seed: (rng.next() * 4294967296) >>> 0,
            height: mature ? rng.range(8, 11) : rng.range(5.0, 7.2), crown: mature ? rng.range(4.5, 6.5) : rng.range(2.6, 3.8), mature });
        }
        s += rng.range(8.5, 12.5);
      }
    }
  }

  // ------------------------------------------------------------------ cafes
  _planCafes() {
    this.cafes = [];
    const rng = RNG.from(this.seed, 'cafes');
    for (const lot of this.lots) {
      if (lot.len < 10 || this.isInStation((lot.s0 + lot.s1) / 2, 6)) continue;
      if (!rng.chance(0.27)) continue;
      const side = lot.side;
      const s0 = lot.s0 + 1.2, s1 = lot.s1 - 1.2;
      const dFacade = lot.d - 0.6;
      const rows = rng.int(1, 3);
      const style = rng.weighted([['umbrella', 0.6], ['open', 0.2], ['awning', 0.2]]);
      const chairStyle = rng.pick(['bistro', 'plastic', 'wicker', 'metal']);
      const tables = [];
      for (let row = 0; row < rows; row++) {
        const dd = dFacade - 1.3 - row * 1.55;
        if (dd < TREE_D + 1.2) break;
        const step = rng.range(1.8, 2.3);
        for (let s = s0 + 0.9; s < s1 - 0.6; s += step) {
          const ts = s + rng.range(-0.15, 0.15);
          const td = side * (dd + rng.range(-0.12, 0.12));
          const nCh = rng.weighted([[2, 0.5], [3, 0.2], [4, 0.3]]);
          const chairs = [];
          const rot0 = rng.range(0, Math.PI * 2);
          for (let c = 0; c < nCh; c++) {
            const a = (nCh === 2 ? (c * Math.PI) + Math.PI / 2 : (c / nCh) * Math.PI * 2) + (nCh === 2 ? 0 : rot0 * 0.1) + rng.range(-0.25, 0.25);
            const rr = 0.62;
            chairs.push({ s: ts + Math.cos(a) * rr, d: td + Math.sin(a) * rr, yaw: a + Math.PI, occupied: false });
          }
          tables.push({ s: ts, d: td, shape: rng.chance(0.7) ? 'round' : 'square', chairs });
        }
      }
      if (!tables.length) continue;
      const umbrellas = [];
      if (style === 'umbrella') {
        const us = rng.range(2.8, 3.6);
        for (let s = s0 + us / 2; s < s1 - us / 2 + 0.5; s += us + 0.2) {
          umbrellas.push({ s, d: side * (dFacade - 1.3 - (rows - 1) * 0.78), size: us, color: rng.pick(['cream', 'cream', 'white', 'navy', 'burgundy', 'sand']) });
        }
      }
      this.cafes.push({ id: this.cafes.length, lot: lot.id, side, s0, s1, dIn: side * (dFacade - 1.3 - rows * 1.55 - 0.2), dOut: side * dFacade, style, chairStyle, tables, umbrellas });
      lot.cafe = this.cafes.length - 1;
    }
  }

  // ------------------------------------------------------------------ furniture
  _planFurniture() {
    const r = this.route, rng = RNG.from(this.seed, 'furniture');
    this.furniture = [];
    const add = (type, s, d, yaw = 0, extra = {}) => this.furniture.push({ type, s, d, yaw, id: this.furniture.length, ...extra });
    // bins next to some poles, benches between trees
    for (const p of this.poles) {
      if (this.isInStation(p.s, 3)) continue;
      if (rng.chance(0.28)) add('bin', p.s + 1.0, p.d + Math.sign(p.d) * 0.55, 0);
    }
    for (let i = 0; i < this.trees.length - 1; i++) {
      const a = this.trees[i], b = this.trees[i + 1];
      if (a.side !== b.side) continue;
      const gap = r.delta(a.s, b.s);
      if (gap > 7 && gap < 14 && rng.chance(0.33)) {
        const s = a.s + gap / 2;
        if (this.poles.some((p) => p.side === a.side && Math.abs(r.delta(p.s, s)) < 1.6)) continue;
        // bench faces the sidewalk (away from the tracks)
        add('bench', s, a.side * (TREE_D + 0.2), a.side > 0 ? 0 : Math.PI, { faceSide: a.side });
      }
    }
    // bollards closing cross streets
    for (const c of this.crossStreets) {
      const sides = c.side === 0 ? [-1, +1] : [c.side];
      for (const side of sides) {
        const d = side * (this.halfWidth(c.s, side) - 0.4);
        const n = Math.max(3, Math.floor(c.width / 1.6));
        for (let i = 0; i <= n; i++) add('bollard', c.s - c.width / 2 + 0.8 + (c.width - 1.6) * (i / n), d, 0);
      }
    }
    // kiosks, planters, advert columns, bike racks in the furniture strip
    let s = 30;
    while (s < this.L) {
      s += rng.range(60, 140);
      const side = rng.chance(0.5) ? 1 : -1;
      if (this.isInStation(s, 8) || this.isInCrossStreet(s, side, 4) || this.cafes.some((c) => c.side === side && s > c.s0 - 3 && s < c.s1 + 3)) continue;
      const type = rng.weighted([['planter', 0.35], ['kiosk', 0.15], ['advertColumn', 0.15], ['bikeRack', 0.15], ['infoBoard', 0.2]]);
      const d = side * (TREE_D + (type === 'kiosk' ? 2.6 : 1.8));
      add(type, s, d, side > 0 ? 0 : Math.PI);
    }
    // platform fittings
    for (const st of this.stations) {
      for (const pl of st.platforms) {
        const dmid = (pl.d0 + pl.d1) / 2;
        add('shelter', st.s + (pl.side > 0 ? 6 : -6), dmid + pl.side * 0.6, pl.side > 0 ? 0 : Math.PI, { station: st.id, platformSide: pl.side, h: pl.h });
        add('ticketMachine', st.s + (pl.side > 0 ? -9 : 9), dmid + pl.side * 0.9, pl.side > 0 ? 0 : Math.PI, { station: st.id, h: pl.h });
        add('stopSign', st.s + (pl.side > 0 ? 18 : -18), dmid + pl.side * 0.8, pl.side > 0 ? 0 : Math.PI, { station: st.id, h: pl.h });
      }
    }
  }

  // ------------------------------------------------------------------ obstacles (crowd)
  _planObstacles() {
    const ob = [];
    for (const p of this.poles) ob.push({ kind: 'circle', s: p.s, d: p.d, r: 0.25 });
    for (const t of this.trees) ob.push({ kind: 'circle', s: t.s, d: t.d, r: 0.45 });
    for (const f of this.furniture) {
      if (f.type === 'shelter') { // glazed shelter on the platform: ~3.6 m along, ~1.4 m deep
        ob.push({ kind: 'rect', s0: f.s - 1.8, s1: f.s + 1.8, d0: f.d - 0.7, d1: f.d + 0.7, shelter: f.station });
        continue;
      }
      const r = { bin: 0.35, bench: 0.9, bollard: 0.15, planter: 0.8, kiosk: 1.6, advertColumn: 0.7, bikeRack: 1.0, infoBoard: 0.5, ticketMachine: 0.45, stopSign: 0.2 }[f.type] ?? 0.5;
      if (r > 0) ob.push({ kind: 'circle', s: f.s, d: f.d, r });
    }
    for (const c of this.cafes) ob.push({ kind: 'rect', s0: c.s0 - 0.2, s1: c.s1 + 0.2, d0: Math.min(c.dIn, c.dOut), d1: Math.max(c.dIn, c.dOut), cafe: c.id });
    for (const st of this.stations) for (const pl of st.platforms) ob.push({ kind: 'rect', s0: pl.s0, s1: pl.s1, d0: pl.d0, d1: pl.d1, platform: st.id });
    this.obstacles = ob;
  }

  // ------------------------------------------------------------------ chunk buckets
  _bucket() {
    const n = this.nChunks;
    const mk = () => Array.from({ length: n }, () => []);
    const idx = (s) => Math.floor(this.route.wrap(s) / CHUNK_LEN) % n;
    this.byChunk = { lots: mk(), sideLots: mk(), poles: mk(), trees: mk(), cafes: mk(), furniture: mk(), obstacles: mk(), crossStreets: mk(), stations: mk(), crossovers: mk() };
    for (const l of this.lots) this.byChunk.lots[idx((l.s0 + l.s1) / 2)].push(l);
    for (const l of this.sideLots) this.byChunk.sideLots[idx(l.cross.s)].push(l);
    for (const p of this.poles) this.byChunk.poles[idx(p.s)].push(p);
    for (const t of this.trees) this.byChunk.trees[idx(t.s)].push(t);
    for (const c of this.cafes) this.byChunk.cafes[idx((c.s0 + c.s1) / 2)].push(c);
    for (const f of this.furniture) this.byChunk.furniture[idx(f.s)].push(f);
    for (const c of this.crossStreets) this.byChunk.crossStreets[idx(c.s)].push(c);
    for (const st of this.stations) this.byChunk.stations[idx(st.s)].push(st);
    for (const c of this.crossovers) this.byChunk.crossovers[idx(c.s0)].push(c);
    for (const o of this.obstacles) {
      const a = o.kind === 'rect' ? o.s0 : o.s - o.r, b = o.kind === 'rect' ? o.s1 : o.s + o.r;
      const i0 = idx(a), i1 = idx(b);
      this.byChunk.obstacles[i0].push(o);
      if (i1 !== i0) this.byChunk.obstacles[i1].push(o);
    }
  }

  /** Items of `kind` whose anchor falls in chunk i. */
  inChunk(kind, i) { return this.byChunk[kind][((i % this.nChunks) + this.nChunks) % this.nChunks]; }
  chunkIndex(s) { return Math.floor(this.route.wrap(s) / CHUNK_LEN) % this.nChunks; }

  /** Obstacles near s (within ±range metres). */
  obstaclesNear(s, range = CHUNK_LEN) {
    const i = this.chunkIndex(s), out = [];
    const k = Math.ceil(range / CHUNK_LEN);
    for (let j = -k; j <= k; j++) for (const o of this.inChunk('obstacles', i + j)) out.push(o);
    return out;
  }

  /** Next station stop position strictly ahead of s (on the ride track). */
  nextStation(s) {
    let best = null, bestD = Infinity;
    for (const st of this.stations) {
      const d = this.route.delta(s, st.stopS);
      const dd = d < -1 ? d + this.L : d;
      if (dd >= -1 && dd < bestD) { bestD = dd; best = st; }
    }
    return { station: best, distance: bestD };
  }

  _planStart() {
    // Default start: on the main avenue with a long straight view and the crossover ahead.
    const avenue = this.route.segments[0];
    this.defaultStartS = avenue.s0 + 25;
  }

  trackD(track) { return track * TRACK_OFFSET; }
}
