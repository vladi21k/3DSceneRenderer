# World architecture: a path-based world many agents can build at once

The skeleton that let 13 builder agents (and about 200 sub-agents over three days) work on one
browser scene in parallel without overwriting each other. Worked example: the tram cab ride in
`/home/vlad/dev/reps/3DSceneRenderer` (`src/world/route.js`, `layout.js`, `facadePlan.js`,
`streaming.js`, `src/main.js`, `src/core/*`, `docs/ARCHITECTURE.md`).

## Contents
1. Build the skeleton first, alone
2. Route coordinates (s, d, h)
3. Closed loop: clothoids and exact closure
4. Nothing ruler-straight, nothing flat
5. Periodic noise: no seam at the wrap
6. One shared ground surface
7. The deterministic master layout plan
8. Shared architectural plans (the facade plan)
9. The module contract
10. Chunk streaming, LOD rebuilds and staged reveal
11. The far field
12. Deterministic randomness
13. ARCHITECTURE.md as the contract
14. Adapting this to another scene

---

## 1. Build the skeleton first, alone

The orchestrator wrote the whole skeleton itself, within the first half hour, before launching
any builder: the route, the layout plan, the facade plan format, chunk streaming, the module loader
with error isolation, one **placeholder module per area** (grey boxes, flat colours), the
headless capture tool and `docs/ARCHITECTURE.md`. The grey-box street rendered end to end; then
13 builders launched, each replacing one placeholder.

Why this order works:
- Every builder starts from a running app and a screenshot tool, so it can judge its own part in
  context from minute one.
- Shared data (where things are, how big, which way they face) exists before anyone needs to
  agree on it. Builders never negotiate positions; they read them.
- Each placeholder already obeys the contract, so a half-finished area never blocks the others.

Keep these files owned by one "core" owner (the orchestrator, or one core agent per round):
`route.js`, `layout.js`, `streaming.js`, `main.js`, `src/core/*`, the architecture doc. Other areas
send change requests for them (see section 13).

## 2. Route coordinates (s, d, h)

Put everything in coordinates attached to the path the camera travels:

| Coordinate | Meaning | Example values |
|---|---|---|
| `s` | distance along the street centre line, metres, wraps at `route.length` | 0 to about 6000 |
| `d` | lateral offset, + to the right of travel | track centres ±1.6, poles ±3.95, trees ±5.15, facades ±11 to 13.5 |
| `h` | height above the local ground | rail top 0, eye 2.75, contact wire 6.0 |

The cab camera itself is just `(s, +1.6, 2.75)` plus sway and bob: on the right-hand track, at
driver eye height, fixed to the cab body. An earlier rig turned the view toward a point 80 m
ahead; in bends that put the other track mid-frame, and the user saw it as riding between the
two tracks instead of on the rails.

Why: the camera's position is one number (`s`); streaming keys on `s`; the street cross-section
is a set of constant `d` lines; the crowd steers in (s, d); and every module agrees on "beside the
track" without world maths. A canal boat (d from the canal axis, h above water), a mountain
railway or a sidewalk walk maps the same way.

API that proved necessary (`src/world/route.js`):
- `toWorld(s, d, h, out)`, `sample(s, out)` → `{pos, tan, tanH, right, heading, curvature, grade}`,
  `heading(s)`, `curvature(s)` (+ = left), `elevation(s)`, `grade(s)`, `groundY(s, d)`.
- `wrap(s)`, `delta(a, b)` (shortest signed distance on the loop), `project(x, z, sHint)` → `{s, d}`.
- `yawAt(s)` (rotation that points local −Z along travel), `offsetScale(s, d) = 1 + κ·d`: the
  arc-length scale of an offset line. Facades on the inside of a bend are shorter than the centre
  line; geometry laid along `d = const` must use it or it stretches.
- Allocation-free forms for hot loops: always pass `out`; `toWorldOf(o, out)` reads `o.s/o.d/o.h`;
  `route.io` (a `Float64Array(8)`) carries inputs and outputs without boxed numbers. The crowd
  calls this per person per frame and the street per vertex (see performance.md, Garbage).

Implementation: build curvature as piecewise-linear pieces, integrate heading and position once
into tables at 0.5 m (Simpson sub-steps), then interpolate. Heading convention used: tangent
`(cos θ, 0, −sin θ)`, right `(−Tz, 0, Tx)`.

```js
// _world(a, out): a = [s, d, h]; tables x, z, th, y at DS = 0.5 m
const fi = wrap(s) / DS, i = Math.floor(fi), f = fi - i;
const th = th_[i] + (th_[i+1] - th_[i]) * f, tx = Math.cos(th), tz = -Math.sin(th);
out.x = x[i] + (x[i+1] - x[i]) * f - tz * d;     // field writes: no boxed call arguments
out.z = z[i] + (z[i+1] - z[i]) * f + tx * d;
out.y = y[i] + (y[i+1] - y[i]) * f + h + (Math.abs(d) > SURF_EDGE ? surface(s, d) : 0);
```

## 3. Closed loop: clothoids and exact closure

A loop never ends, never needs a turnaround, and is long enough not to repeat visibly (about
6 km here: eight minutes or more of riding before anything recurs).

- Describe the loop as a list of segments: `straight {len, min}` and `curve {turn°, radius,
  trans}` where `trans` is the clothoid (linear curvature ramp) length at each end. Clothoids
  matter: an arc joined directly to a straight starts bending abruptly, which shows as an elbow in
  the rails seen in perspective and a lateral jerk in the camera.
- Make the turns sum to exactly 360° so the heading closes by construction.
- Close the position by lengthening two straights: the end error `E` is a 2-vector, so solve
  `a·dirA + b·dirB = −E`. Try every pair of straights, skip near-parallel pairs (|det| < 0.3) and
  pairs that would drop below their `min` length, keep the smallest |a| + |b|. The first version
  used a fixed pair and pushed the main avenue to a negative length.
- Spread the tiny remaining table residual linearly over the loop so `s = L` meets `s = 0` exactly.
- Real numbers: radii 58 m (one tight junction curve) to 1100 m, clothoids 18 to 40 m; stops only
  where curvature < 1/1000 over the platform plus approach and grade < 3.5 %.

## 4. Nothing ruler-straight, nothing flat

The user corrected the first version: real track curves, and real ground has a slight hill and
is never an even plane. The default view sat on a dead-straight 560 m avenue with hills too gentle
to read. Fixes that worked:

- **S-meanders**: every straight of 230 m or more gets a pair of opposite bends with net zero
  turn (±2.5° to 4.1°, radius 1400 to 2150 m, 30 m clothoids). Closure is unaffected.
- **Elevation** = three sines with an integer number of cycles per loop (amplitudes 1.6, 0.9 and
  0.3 m) + periodic bumps (von Mises: `a·exp(κ(cos(2π(s−c)/L) − 1))`, a smooth bump that is
  periodic in L) + **mesas** (eased climb at a steady grade, level top, eased descent, evaluated at
  the copy of `s` nearest the mesa so the net rise around the loop is zero). Cap grades at 6.5 %
  (the steepest came out at 5.9 %).
- **Design elevation for the default shot.** At a 17° telephoto lens a gentle hill is invisible.
  The avenue now climbs 21 m at about 5.8 % from 240 to 510 m ahead of the start, so the rising
  paving fills about 15 % of the frame, as in the reference photos. A critic asked for 120 px of
  road between 200 and 400 m; with grades capped this gave 96 px, and the owner documented the
  trade-off instead of breaking the near street.
- Place the start in a shallow sag and the first stop on the level top: stops need level track.

## 5. Periodic noise: no seam at the wrap

Any quantity that varies along `s` (ground undulation, street width, wear, tints) must repeat
exactly at `L`, or the loop seam shows. QA measured a 2.4 to 10 cm ground step at the seam and a
street-width jump from 11.27 to 11.61 m, until every along-route noise became periodic:

```js
// src/core/rng.js: a whole number of lattice cells fits the loop
export function loopNoise1(s, L, wavelength, seed) {
  const cells = Math.max(1, Math.round(L / wavelength));
  return noise1p((s / L) * cells, cells, seed);   // lattice index taken modulo `cells`
}
```

Ask every builder to use `loopNoise1/2` (or `noise1p`) for anything indexed by `s`, and test
the wrap explicitly (render s = L − 2 and s = 2; ride across it).

## 6. One shared ground surface

`route.surface(s, d)` shapes the ground outside the track corridor: a 1.6 % cross-fall rising
toward the facades, a slow hillside tilt of ±1.3 % (320 m wavelength), and 2 cm + 1 cm settlement
undulation (6.5 m and 2.3 m wavelengths), flat at rail level inside the corridor (|d| < 3.66 m)
and level again beyond the facade line (|d| > 13 m). `toWorld` and `groundY` include it.

Rules that kept objects on the ground:
- Place everything with `toWorld(s, d, h)`, h above the local ground. Never `sample(s).pos` plus
  your own offsets.
- Layer the ground, each layer owned once: macro shape `route.surface` (core) → paving as drawn
  with millimetre gutters and crowns `street.heightAt(s, d)` (street) → each building's ground line
  `plan.groundAt(u)` within 0.9 m of a facade (buildings) → side-street frames
  `street.mouth(c, side)` / `sideHeightAt` (street).
- Roll out a shared ground change behind a switch. The surface function was written while
  builders were mid-flight and shipped disabled (`route.surfaceEnabled`); turning it on before the
  paving mesh followed it would have left buildings and trees floating. It went on at integration.
- Add a permanent "people on the ground" probe to every QA pass (every figure's height minus
  the ground under it; this project used ±10 cm). Floating figures reached the user once: a
  half-finished edit, caught between saves by an automatic commit while three owners edited the
  crowd, frame-loop and streaming code at once.
- Known gap: `groundY` does not model side-street carriageways, so figures 28 to 52 m up a side
  street were up to 0.28 m off. Model every walkable surface in the shared function, or give each
  one its own documented frame.

## 7. The deterministic master layout plan

`new Layout(route, seed)` computes the whole world plan once, in dependency order. Every module
reads placements from it; nobody invents overlapping ones.

| Step | Places | Constraints read from earlier steps (real values) |
|---|---|---|
| stations | stops with side platforms 52 m × 2.9 m × 0.30 m | κ < 1/1000, grade < 3.5 %, 620 to 860 m apart |
| start | `defaultStartS` | the composition the brief asked for (avenue s0 + 25) |
| crossovers | 34 m switches | near-straight (κ < 1/1500), one in view from the start |
| crossStreets | width 8.5 to 13 m, side, depth, angle | not in stations or crossovers; 40 m clear of each other |
| lots | building lots per side | fill gaps between mouths; 11 to 27 m long, 15 m max where R < 300, 9 m where R < 120 |
| poles | lamp + catenary pole pairs | every 27 m (20 m in bends, 13 m in tight ones); out of side-street mouths |
| trees | tree line at d ≈ ±5.15 | 8.5 to 12.5 m apart, not within 2.4 m of a pole, not in mouths or stops |
| cafés | terraces on ground-floor shops | error-diffused frontage share: 28 % on the avenue and near stops, 10 % elsewhere |
| furniture, obstacles | benches, bins, kiosks...; circles and rects for the crowd | everything above |

Then `_bucket()` puts every item in per-chunk lists: `layout.inChunk(kind, chunkIndex)` is all a
chunk builder needs, and `obstaclesNear(s, range)` serves the crowd.

Patterns worth copying:
- **Error diffusion for shares.** Each lot adds `share × length` to what its side "owes"; a run of
  terraces starts once enough is owed and each terrace pays its length back. Coverage stays
  steady while the runs stay irregular. A per-lot coin flip gave 8.5 % on the avenue where 28 %
  was wanted.
- **Plan the opening shot in the layout.** The right sidewalk ahead of the default start always
  opens with a café run; stops sit on the level hilltop; a crossover sits in the first view.
- **Write-back.** Modules that refine a plan write the drawn values back: vegetation writes each
  tree's drawn height, crown radius and crown base into `layout.trees`; furniture writes which
  tables are laid. Document which modules see planned values (their init runs earlier) and which
  see drawn ones.
- **Late registration.** `layout.addObstacles([...])` lets a module register things it places
  itself (A-frame boards, goods stands) during its init, before the crowd's init reads them.
- **Layout changes ripple.** Doubling the café terraces (134 → 252) changed furniture density,
  crowd seating budgets, shop awnings and triangle counts. Change shared plans through their owner
  and send a request to every consumer the change touches.

## 8. Shared architectural plans (the facade plan)

`facadePlan(lot)` returns a cached, deterministic description of one building front: floors,
bays (of varying widths), openings (kind, shape, recess, shutters, lit, awning...), balconies,
cornice, roof, rooftop clutter, signs and style (era, stone tint, finish). Four modules draw from
it (shell masonry, window and shop infill, ironwork, the far field) and the crowd uses its doors.

- Give every lot a frame: `u` along the facade (to the viewer's right), `v` up from a floor
  reference, `w` out of the wall, plus a matrix to world. Infill then sits at `w = −recess` with
  no world maths.
- **Extend, never rename.** Consumers depend on field names; additions are free.
- **Export the helpers that decide shapes** (arch outlines, head dressings, keystone spans), so
  a balcony console and the arch under it agree without their owners talking.
- Make consumers iterate generic lists (`plan.returns`, each bay's own `u0/u1/w`), never assume
  `bays[0].w` for all bays: bay rhythms were made uneven later (a wide centre bay, wide end bays),
  and only generic consumers survive that kind of extension.
- Let the plan see the camera: `plan.vista` counts how many cab positions (sampled every 20 m)
  see the lot close the view down the street, so landmark blocks go where the camera looks.

## 9. The module contract

```js
export default {
  name: 'street',
  lods: [0, 1],                // detail levels this module builds (default [0, 1])
  async init(app) {},          // once, in registry order
  build(chunk, app) {},        // return an Object3D for this chunk, or null
  dispose(obj, chunk, app) {}, // default: dispose non-shared geometries
  update(dt, app) {},          // per frame: train → cameraRig → others in registry order
  whenReady: null,             // promise: content finished after init (atlas, bake) must be on screen
};
```

- **Dynamic import per module, error isolation.** A module that throws at load, init, build or
  update is logged and disabled (on a load or init error at once; after more than 3 build or 5
  update errors); the app keeps running.
  Retry a failed import once with `?retry=1` (a busy static server dropped requests).
- **No static imports between modules.** Talk through `app.systems.<name>` (with aliases such as
  `app.materials`, `app.env`). Static imports only of the shared core. A pure helper of another
  module may be loaded with a guarded dynamic import that falls back on failure.
- **`app` carries the shared world**: `THREE, renderer, scene, camera, params, U` (shared
  uniforms such as time, wind, sun, night), `events, route, layout, world, systems, dt, realDt`
  (wall-clock delta clamped to [0, 0.1] s so nothing jumps after a stall) and `perf`.
- **Switches every builder uses**: `only=a,b` (core modules always load), `skip=a,b`,
  `view=s,d,h,yawDeg,pitchDeg` (free inspection camera in route coordinates; `view=430,9,1.7,-60,8`
  stands on the right sidewalk facing the facades), `s=`, `tod=`, `fov=`, `freeze=1`, `seed=`,
  `capture=1` (no UI), `rec=<fps>` (fixed-step offline recording), `debug=1`. Add an A/B switch
  for every core optimisation (`boot=serial`, `glsort=0`, `lightloop=0`...) so any regression can be
  bisected in one run.
- **Keep the app loading at all times.** Other agents screenshot the whole app every few minutes;
  one syntax error blanks everyone's evidence. Builders edit only files they own.

## 10. Chunk streaming, LOD rebuilds and staged reveal

| Constant | Value | Why |
|---|---|---|
| `CHUNK_LEN` | 40 m | about 3 s of travel at 50 km/h; small enough to time-slice, large enough to batch |
| `VIEW_BEHIND` | 60 m | side views under mouse look, shadows cast from behind |
| `LOD0_DIST` | 200 m | full detail; at 17° that is about 5.5 cm per pixel |
| `VIEW_AHEAD` | 680 m | lod 1: drops only sub-pixel detail, keeps every moulding |
| `VIEW_FAR` | 1400 m | lod 2, the far field (section 11) |

`chunk = {index, s0, s1, lod, group, rng(tag)}`. Per frame `world.update(sCam)`:
1. Recycle chunks outside [s − 60, s + 1400]; dispose their parts (shared geometries flagged
   `geometry.userData.shared = true` survive).
2. Queue missing chunks and **LOD upgrades** nearest first. An upgrade builds a replacement
   (`c.next`) in the background; the old chunk stays visible until the new one is revealed, so
   there is never a gap.
3. Build module parts in a time slice of about 7 ms per frame. Budget per chunk per module:
   under 3 ms at lod 0 and 1 ms at lod 1.
4. Once running (`world.staged`), a finished chunk is not shown at once: `compileAsync` its group
   against the scene's render target, resolve its programs, **send its vertex buffers to the GPU
   ahead** through never-drawn "uploader" meshes (a mesh with an empty material array: the renderer
   uploads the attributes when it walks the scene but draws and compiles nothing), then reveal its
   parts nearest chunk first. Uploads ahead and reveals share a 2 MB per-frame byte budget.

Why the staging exists: a lod 0 facade part alone held 4 to 11 MB of vertex data; revealing a
whole 9 to 23 MB chunk in one frame stalled the GL calls after it for 55 to 350 ms. A 4 MB reveal
cap brought the worst frame from about 195 ms to 59 ms; uploading ahead brought reveal frames to
7 to 21 ms CPU. Details in performance.md.

Heavy modules **prefetch**: `world.upcoming(sCam, lookAhead, out)` lists the chunks the streamer
will build next (and those that will need lod 0 within `lookAhead` metres). Buildings and facades
generate geometry ahead in small steps within an absolute per-frame budget, so `build()` only
wraps finished geometry (facades: build max 0.1 ms while riding). Before the ride starts,
`world.update(s, 40)` builds chunks at the detail they will need 40 m on, so the first lod 0
upgrade does not land 0.7 s into the ride.

**Shared-batch pattern** for small repeated things (railings, lamps, café tables): `build()`
returns an empty marker group; the instances live in one scene-level batch per material, and a
chunk's instances draw while its marker is visible. Ironwork went from 191 to 45 draw calls this
way; catenary's batches took it from 110 to 10.

Start-up uses the same machinery: `world.prime(s, 240, onProgress, lods, only)` builds the
chunks near the start synchronously (with `only`, just the modules initialised so far); the view
is ready once every chunk within 160 m is built and every readiness gate has settled.

## 11. The far field

A critic flagged sky at the vanishing point: the street ended at 680 m. The fix was a core-owned
lod 2 builder (`src/core/farfield.js`) from 680 to 1400 m, built **from the same plans**: each lot
a block of its plan's height and stone tint with cornice, balconies and openings; paving between
the facade lines with the corridor bands; trees drawn with the vegetation module's own coarsest
geometry (`vegetation.farTree(t)`), so the handover does not change species, size or tint.

- One merged mesh, one material, one draw call per far chunk; about 1 ms to build; +18 draw calls
  and about 30k triangles in all; no shadow casting.
- Beyond the sun's shadow range (700 m) it shades itself as a street canyon: per vertex it stores
  its lateral offset and the block heights on both sides, and cuts the sun where the ray passes
  below the block on the sun's side.
- Only builders listing 2 in `lods` see lod 2, so no other module had to change. When a far chunk
  comes within 680 m, the full chunk is built and its first reveal hides the far part (no
  overlap, no z-fighting).
- Colours come from the materials library's published mean albedos, not hard-coded guesses
  (measured far facade R/B 1.32 against 1.31 near).
- Debug switch `ffnear=<m>` starts the far field nearer, to compare it side by side with real chunks.

## 12. Deterministic randomness

- `RNG.from(...parts)` hashes a seed and string tags into a mulberry32 generator; chunks get
  `chunk.rng(tag) = RNG.from(seed, tag, index)`. Results then do not depend on build order, frame
  rate or which chunk streamed first.
- Never `Math.random()` for world content. Determinism made A/B screenshots, blind comparisons
  of two builds at identical views, offline recordings and "same bug at the same s" debugging
  possible.
- Refactor hot paths with a bit-identical check: the route and noise rewrites were verified on
  200k to 1.2M random samples with 0 mismatches before shipping.

## 13. ARCHITECTURE.md as the contract

Every agent prompt starts with "read docs/ARCHITECTURE.md first; follow it exactly". It holds:
hard rules (determinism, no reference photos as textures, clean metadata), tooling and switches,
coordinates and conventions, the layout plan fields, the facade plan fields, the module contract,
start-up rules, each module's published API, streaming, budgets, garbage rules, and a **code
areas table** (area → files owned). A change one area needs in another's files goes through that
area's contract: the agent writes it into a `requests` field of its final report, and the
orchestrator routes it to the owner next round (one sweep handled 189 such requests).

Keep it a current specification, not a changelog: after a few rounds of "Contract additions"
sections it was rewritten so each addition sits in its own section. Put measured numbers in it
(albedos, budgets, timings) so agents stop guessing, and have the core owner fold every
report's `contracts` field into it at the end of each round.

## 14. Adapting this to another scene

| Scene | s | d | h | Loop? |
|---|---|---|---|---|
| Canal boat ride | canal centre line | from canal axis (quays, towpaths at fixed d) | above water / quay | closed loop of canals, or ping-pong with a turning basin |
| Mountain railway | track | from track centre (cuttings, retaining walls) | above rail; the shared `surface(s, d)` keeps climbing or falling away from the track instead of levelling off | out and back: mirror the ride or end at a terminus |
| City walk | sidewalk line | from the walking line (kerb, facades) | above pavement | closed block loop |
| Village drive | road centre | lanes, verges, hedges | above road | loop of lanes |

Checklist:
- [ ] Route with clothoids, exact closure, no ruler-straight segment, designed elevation that
      reads at the default lens; allocation-free `toWorld` with `out`.
- [ ] Every along-path noise periodic in the loop length; seam tested.
- [ ] One ground function used by placement and by the ground mesh; walkable surfaces all modelled.
- [ ] Master plan computed once, bucketed per chunk, with error diffusion for shares and the
      opening shot planned in.
- [ ] Shared plan objects for anything several modules dress, with exported shape helpers.
- [ ] Module contract with dynamic import, error isolation, `only/skip/view` switches.
- [ ] Streaming with time slices, background LOD swaps, staged reveal under a byte budget, far field.
- [ ] Placeholders for every area and the contract doc written before the first builder starts.
