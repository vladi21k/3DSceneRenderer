// Placement of infill for each opening kind: picks the cached templates, colours and the
// per-window interior parameters, and appends them to the chunk kit.
import { RNG } from '../../core/rng.js';
import { joineryStyle, joineryTpl, glassTpl, shutterTpl } from './windows.js';
import { paint } from './kit.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Interior glass attributes for an opening with glass at local depth zRef. */
export function glassAttrs(ctx, o, { W, H, D, roomY0, seed, drape, kind, zRef = -0.012, lit = o.lit }) {
  const winY0 = o.y - roomY0, winY1 = winY0 + o.h;
  const baseH = roomY0 - ctx.plan.groundAt(o.uc);
  const hw = o.w / 2;
  return {
    aRoomP: (k, sp, a, i) => { a[i] = W / 2 + sp[k * 3]; a[i + 1] = winY0 + sp[k * 3 + 1]; a[i + 2] = Math.max(0, zRef - sp[k * 3 + 2]); a[i + 3] = hw; },
    aRoomS: [W, H, D, baseH],
    aWin: [seed, lit, drape, kind],
    aFac: [ctx.angle, ctx.streetW, winY0, winY1],
  };
}

export function buildWindowInfill(kit, ctx, o, m) {
  const plan = ctx.plan;
  if (!ctx.joinery) {
    ctx.joinery = joineryStyle(plan, RNG.from(plan.seed, 'joinery'));
    ctx.frameRGB = paint(ctx.joinery.type === 'alu' && /green|teal/.test(plan.style.frameColor) ? 'white' : plan.style.frameColor);
    ctx.shutterRGB = paint(plan.style.shutterColor);
  }
  const v = ctx.joinery;
  const r = RNG.from(o.id);
  // joinery, with a little per-window paint variation (repainted at different times)
  const fc = ctx.frameRGB, k = 0.9 + r.next() * 0.16;
  kit.get('frame').add(joineryTpl(o, v, ctx.q), m, fc[0] * k, fc[1] * k, fc[2] * k);

  // glass + interior
  const floor = plan.floors[o.floor];
  const bay = plan.bays[o.bay];
  const roomY0 = floor.y + 0.02;
  const W = clamp(bay ? bay.w : 3.6, Math.max(2.4, o.w + 0.5), 4.8);
  const H = Math.max(2.4, floor.h - 0.3);
  const D = 3.4 + r.next() * 1.8;
  const seed = r.next();
  let drape = 0;
  const dr = r.next();
  if (o.curtain) drape = (dr < 0.33 ? 1 : dr < 0.62 ? 2 : dr < 0.84 ? 3 : 4) + 0.1 + r.next() * 0.8;
  else if (dr < 0.2) drape = 3 + 0.05 + r.next() * 0.35;
  kit.get('glass').add(glassTpl(o, v), m, 1, 1, 1, glassAttrs(ctx, o, { W, H, D, roomY0, seed, drape, kind: 0 }));

  // louvred shutters
  if (o.shutters) {
    const sc = ctx.shutterRGB, ks = 0.85 + r.next() * 0.2;
    kit.get('shutter').add(shutterTpl(o, o.shutters, ctx.q), m, sc[0] * ks, sc[1] * ks, sc[2] * ks);
  }
}
