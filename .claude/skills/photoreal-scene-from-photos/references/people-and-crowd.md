# People and crowd: photoreal pedestrians for a first-person ride

Worked example: `/home/vlad/dev/reps/3DSceneRenderer` (figures: `src/crowd/humans.js`, `src/crowd/humans/**`,
`tools/blender/mh_*.py`, `docker/Dockerfile.mh`, `assets/humans_mh/`; behaviour: `src/crowd/crowd.js`,
`src/crowd/behaviour/**`). People were the weakest area all project long and the area judges notice first.

## Contents
1. Key lessons
2. Bodies: why hand-made figures plateaued, and the switch to a human generator
3. The MPFB2 (MakeHuman) build pipeline
4. Rendering hundreds of figures
5. Crowd behaviour
6. What still read as game-like, and next steps

## 1. Key lessons

- **Start with a parametric human generator, not hand-made bodies.** About 11 hours of procedural bodies with
  build, critique and fix loops scored 3.5-5.2/10. The MakeHuman cast was live in the app about 3.5 h after its
  Docker image build started and scored 5 on its first review. Faces, child proportions, skin and real garments
  come with it.
- **Split figures from behaviour behind a small contract** (`alloc`, `set(i, {...})`, `strideLength`,
  `heightOf`). The crowd needed no changes when the whole renderer was replaced.
- **Judge people in distance bands.** By the end the crowd looked photographic at 30-150 m but still read as
  a good game cast inside about 10-15 m. Critics that shot close-ups scored lower even after real fixes.
- **Count everything in the reference photos** (strollers, bikes, bags, group share, café occupancy, density).
  Guessed shares were 5-20 times too high and made the street read as a different city.
- **Make track safety time-based and verify it in code.** People leave the vehicle's path at their own time to
  arrival. A final projection then enforces the hard guarantee, and an independent per-frame checker counts
  violations over millions of samples.
- **Add a ground-contact probe and an artefact probe to every verification pass.** Floating people and streak
  bands both came back through edits in other areas.
- **Bone matrices that carry world placement need weights that sum to exactly 1.** If they don't, vertices are
  pulled towards the world origin and show as coloured streaks across the street.

## 2. Bodies: why hand-made figures plateaued, and the switch to a generator

**What was tried first.** Bodies were sculpted as signed distance fields in Blender Python (3 bodies, then 5
including a 0.86 m toddler), meshed with surface nets and decimated into 4-5 LODs. Clothes were shader layers
over the skin with analytic skirt and coat shells. Hair was solid shells with strand shading. 21 accessory
parts were fitted per body. Walks came from foot placement plus 2-bone leg IK. It was cheap at runtime: 400
figures in about 25 draws and 2 ms GPU.

| Stage | People score | What the critics kept finding |
|---|---|---|
| SDF build + fix | 4 | grey or black helmet hair, hair through hats, faceted faces, clothes reading as body paint, claw hands, pose snaps |
| User: "backs look weird; anatomy of men, women, children; add strollers and bicycles" → anatomy rework | 5.2 | trousers shrink-wrapping the buttocks, coat-hanger shoulders with no trapezius slope, glued-on hair, legs piercing skirts, doll toddlers |
| Full-app people lens | 3.5 | streak bug, mask faces, children 7.1 heads tall (adult ratio), one dead symmetric idle for everyone |
| MakeHuman cast, 2 review rounds | 5, 5 | photographic at 15-150 m; under 8 m: shell beards, plastic helmet hair, garment holes, LOD blotches |
| Strand hair, face variety, cloth drape | 6, then 5.5 (stricter close-up critic) | shrink-wrapped clothes, helmet hair, straps off the body, waxy faces, people hovering |
| Contact shade, individually drawn folds, face self-shadow | 6 | see section 6 |

**Why it plateaued.** With hand-made bodies every anatomical and costume fact has to be invented: trapezius
slope, the gluteal bridge under trousers, head-to-height ratio by age, eyelids, hems. Each fix revealed the
next missing fact, and every critic round returned 14-20 items. Scores stayed between 3.5 and 5.2 whatever was
fixed, because the reviewers' complaints were about how the bodies were built, not how they were lit.

**Why the generator raised the score.** MakeHuman targets give real sex and age anatomy, true child proportions
(head about 1/5-1/6 of height), textured skins for each age, sex and ancestry, eyes, brows, lashes and real
garment meshes with seams. The system assets are CC0 and so is the output. The MPFB2 add-on is GPL-3.0, used as
a build tool only and never shipped. **Rule: when the top figure issues are about anatomy, faces, hair or
garment construction, change where the geometry comes from instead of patching it.**

## 3. The MPFB2 (MakeHuman) build pipeline

**Image** (`docker/Dockerfile.mh`, built on the project's Blender tools image; `tools/mh_fetch.sh` downloads
about 330 MB into a git-ignored `docker/mh/`):
```dockerfile
FROM tramline-tools:latest
COPY mh/mpfb.zip mh/system_assets.zip /opt/mh/
ENV BLENDER_USER_RESOURCES=/opt/mh/blender_user
RUN mkdir -p /opt/mh/blender_user /opt/mh/system_assets && unzip -q /opt/mh/system_assets.zip -d /opt/mh/system_assets \
 && HOME=/tmp blender -b --factory-startup --python-expr "import bpy; bpy.ops.extensions.package_install_files(filepath='/opt/mh/mpfb.zip', repo='user_default', enable_on_install=True); bpy.ops.wm.save_userpref()"
```
- Don't pass `--factory-startup` when you build characters, because it disables the add-on. Learn the scripting
  API from the add-on's `services/` folder (HumanService, TargetService, ClothesService, RigService).
- Smoke-test one character with a preview render before you hand the pipeline to agents.

**Stages** (`mh_build.py --stages chars,hair,tex,export,preview --jobs 12`; a full rebuild of 49 characters
took 1.5-4.5 min depending on the stages and jobs; the output is deterministic, bit for bit):

| Stage | Does |
|---|---|
| chars | one Blender process per character: macros, shape targets, `game_engine` rig, CC0 clothes, hair, brows, lashes, eyes, hat; garment edits and clean-up; the runtime rest pose applied; weights converted to the runtime skeleton → `raw/<id>.npz` |
| hair | `mh_hair.py`: strand-card hair groomed inside each style's CC0 proxy |
| tex | `mh_tex.py`: shared texture arrays, garment detail layers, synthesised folds (`mh_folds.py`), WebP strips |
| export | `mh_export.py`: meshoptimizer LODs (run in node), per-vertex AO, quantised geometry → `cast.json` + `cast.bin.gz` |
| preview | Cycles lineup (front, side, back) rendered from the exported files, which also tests the format. In the worked example it fell behind the final format: run `mh_preview.py --debug nonormal` |

**Cast design** (`tools/blender/mh_cast.py`, plain data importable from Blender and python3):

| Class | Count | Notes |
|---|---|---|
| Men | 16 | ages 21-57, slim to heavy (belly and double-chin targets), 3 in black suits with fedoras and beards like the reference crowd |
| Women | 14 | tees, blouses, jeans, shorts, knee skirts, long modest skirts, dresses |
| Elderly | 6 | stooped and senior walks; spectacles on about 34 % |
| Teens / children | 4 / 6 | children aged 5-10 with a child-face target set |
| Toddlers | 3 | strollers only; a baby in a pram is a toddler drawn at 74 % scale |

- **Stature:** solve the height macro per character so the crown matches a stature table (error under 2 mm).
  Use mean adult 1.755 m for men and 1.625 m for women (SD 0.07 / 0.065), children from an age table (1.10 m
  at 5, 1.38 m at 10), and shrink 1.8 mm per year after 55. Heights on foot span 1.11-1.85 m.
- **Faces:** add `mouth-angles-up 0.32` to every face, because MakeHuman's neutral mouth reads as a frown at
  street distance. Children get rounder skulls, bigger eyes, a small nose and a short lower face, and each
  character a few small face targets so the cast does not look like siblings.
- **Mix:** take ancestry weights, skin textures and tone gains from the people visible in the reference
  photos, and weight how often each character is picked to match them.
- **Outfits:** mix tops and bottoms from different CC0 suits, cut sleeves and trouser legs to length with a
  square hem, and lengthen and flare skirts. Store garments as neutral detail textures tinted at runtime
  (`albedo = 2 × texel × tint`), so a few garment meshes give hundreds of looks.

**Build-time checks** (each fixed a defect the critics found; make them fail the build):
- every top covers its waistband by at least 3 cm in the rest pose (the CC0 sports top is a crop top, which
  showed a bare midriff in the default view);
- body skin is hidden only where a garment on the same limb covers it, tested with two-sided ray casts over
  the whole pose set; keep 3 cm of skin under hems and cuffs, because a raised arm opens a sleeve;
- skin that pokes through tight cloth is sunk 3.5-4 mm; feet inside shoes are dropped; pockets, slits and
  skirt vents are closed; AO pits more than 0.12 darker than their neighbours are lifted (stitched vents baked
  black slots);
- no hair shows above a hat or covers the eyes: cut fringe polygons inside a window in front of the face, fade
  the cut strand ends, and seat hats about 3.5 cm above the eyes.

**Rig transfer.** Convert to a compact 22-bone runtime skeleton (root, pelvis, 2 spine, neck, head, and per side
clavicle, arm, forearm, hand, thigh, shin, foot, toe), so that procedural clips can be baked per character:
```python
GE_MAP = {'spine_02': {'spine1': 0.5, 'spine2': 0.5}, 'ball_l': {'toeL': 1}, ...}  # game_engine → runtime
for f in ('thumb', 'index', 'middle', 'ring', 'pinky'): GE_MAP[f'{f}_01_l'] = {'handL': 1}  # fingers fold in
```
Before export, pose the rest into hanging arms (8-17°), elbows bent 12-14°, palms to the thighs, curled fingers
and ankles under the hips, and apply that pose. Each character carries its own joints, so clips fit its body.
The downside is that with no finger bones, hand poses can't vary per person.

**Hair** (`mh_hair.py`). The CC0 hair proxies look like helmets up close. Re-groom each style as strand cards
using the proxy as an envelope:
- blue-noise roots on the scalp, strands growing along the style's flow (crown whorl, parting or tie) under
  gravity and held at a layer depth under the envelope;
- 4 layers: a dense base so no scalp shows, mid, outer, and flyaways outside the envelope;
- about 550 strands per head, later 1.7-2× on long styles, gathered into locks with gaps between them;
- LOD 0 all cards, LOD 1 a third (wider), LOD 2 the proxy, LOD 3 an opaque cap. Long hair hangs as a layer
  about 4 cm deep, not a single sheet.

**Beards.** Do stubble as a per-vertex beard-growth decal that darkens the skin towards the hair colour, with
a feathered, broken edge kept clear of the lips. Full beards are shells grown from a base at runtime (15 on LOD
0, 3 on LOD 1, 1 on LOD 2). A single opaque shell read as a knitted balaclava. The last critic saw dithered
shells as "translucent grey smoke" under TAA and recommended a hard alpha threshold (alpha-to-coverage); that
change was never verified.

**Cloth folds** (`mh_folds.py`). The CC0 garments are shrink-fitted shells, and critics called them "shrink-wrap"
in every round. Two passes helped:
- **Geometric drape:** subdivide each garment once and let tops hang 2 cm off the body below the chest.
- **Synthesised relief:** a height field in body-relative frames, baked to a normal and cavity map per suit.
  Draw every fold separately (position, tilt, length and depth from a deterministic draw, tapered ends): armpit
  fans, elbow rings, waist bunching, crotch whiskers, 2-4 Z-folds stacked over the shoe, gored skirt flutes.

Periodic cosine folds read as "printed bands" and identical fans on every back. That was still a critic item at
the end.

**LODs and export** (meshoptimizer):

| Part | Triangles per LOD 0 / 1 / 2 / 3 |
|---|---|
| body | 8500 / 1700 / 560 / 210 |
| suit | 16000 / 1100 / 360 / 130 |
| hair | cards / cards / 380 proxy / 60 cap |
| whole character after cloth and hair | about 42k / 6.3k / 1.8k / 0.45k |

- Simplify each LOD from the previous one with UVs and normals as attributes, and lock garment borders.
- Never use the Prune option: it silently deleted whole garments at LOD 2-3.
- Hair and beards need absolute error bounds (0.0015 / 0.006 / 0.018 / 0.05 m); a triangle budget collapses
  hair sheets into planks.
- Far LODs pull skin 9-14 mm under garments and swell the garments 7-11 mm. Otherwise the simplified layers cut
  through each other in blotches, and that was the LOD 2 that most of the crowd used.
- Lift the AO inside the mouth and eye sockets to 0.72 at far LODs, because dark open mouths read as screams.

**Format and budget.** One gzip binary per cast. Per vertex:
- position `int16×3` (per-character min and range);
- normal `int8×4` with the AO in w;
- uv `uint16×2`;
- skin index `uint8×4` and skin weight `uint8×4` that sum to exactly 255;
- tex `uint8×4` (layer, normal layer, region, flags).

Albedo is a set of 1024² texture-array layers stored as WebP strips of 8 layers. Alpha goes in a separate
opaque strip, because browsers premultiply decoded alpha. The arrays take about 300 MB of GPU memory, and
`humans_tex=2` cuts that by 4×. Download size grew 12.3 → 19 → 24.5 → 27.5 → 29.4 MB against a 30 MB budget,
so set the budget early.

**Promote and verify.** One fix agent died after building a better cast into a scratch folder, and HEAD shipped
the old one while the scripts were a version ahead. Make "copy to `assets/`, bump `cast.json` version, reload
in the app, screenshot" an explicit final step.

## 4. Rendering hundreds of figures

**Data flow** (`humans.js`, `mh/batch.js`, `mh/shading.js`):
```
crowd.update → humans.set(i,{x,y,z,heading,speed,phase,pose,look,appearance,idle,holdWith,prop,...})
humans.update: cull per figure → LOD by projected height → blend 2 baked clips + head turn + hand-hold IK
             → write 22 bones × 3 texels (3×4 matrix incl. world placement) + 3 state texels → bone texture row
batch: ONE WEBGL_multi_draw per pass; sub-draw = (figure LOD range | accessory); gl_DrawID → indirect texture → row
vertex: 4-bone skinning from the row; look row (34 texels) = tints, patterns, face shape, glasses, landmarks
```
- **Animation:** clips are procedural (7 walks including senior, old and skirt, 8 idles, about 10 sit
  variants, stroller seat, baby). Bake each clip per character only when that character plays it, and the rest
  on first use; 49 rigs take about 0.3-0.45 s.
- **Pose changes:** cross-fade 0.75 s (1.0 s for sitting). A linear blend of matrices shrinks the body, so
  re-orthonormalise the bones after blending, without allocating.
- **Phase:** the crowd advances it by distance / `strideLength(appearance, speed, pose)`, so feet never slide
  (measured slip under 1 mm per frame).
- **LOD by projected height**, not distance, because the lens zooms: `px = height / dist × H / (2 tan(vfov/2))`.
  Thresholds 260 / 72 / 15 px. At a 17° vertical FOV that puts LOD 1 at about 24-85 m and LOD 2 at about 85-410 m.
  A default view of about 660 figures splits roughly [4, 68, 390, 200] across LOD 0-3, so **LOD 2 is what the
  telephoto audience sees: make it clean.**
- **Shadow passes:** a separate list per cascade, at LOD 1 at best and LOD 2 or 3 where cascade texels exceed
  0.03 or 0.09 m, with coarse bag stand-ins. Figures that are off screen but cast a shadow into view are still
  posed.
- **Update rate:** figures under about 15 px and shadow-only figures re-blend every 3rd frame, LOD 2 every 2nd,
  riders every frame so feet stay on the pedals.
- **Cost** on a mid-range desktop GPU at 1080p: about 665 figures cost 2.6-3.1 ms view + 0.35 ms shadow, 1.6 M
  triangles, one call per pass and about 1.1 ms CPU. Budget about 4 ms GPU for people including shadows.

**Shading recipes that moved scores** (`mh/shading.js`):

| Part | Recipe |
|---|---|
| any physical material | three.js keeps grazing reflectance (F90) at 1 even with low specular, which made hair and cloth look plastic: scale F90 per region (strand cards 0.04, hair proxy 0.12, cloth about 0.45) |
| skin | wrapped diffuse with a red-shifted terminator, F0 about 0.028, roughness 0.36-0.45 on the T-zone and 0.6 on the cheeks; redness, freckles and moles by seed; pores only up close |
| face | per-person face warp in the vertex shader around landmarks (nose, jaw, chin, cheeks, brows, lips); a self-shadow from the head bone's axes that darkens the eye sockets, upper lip and under the jaw under a high sun. Without it faces at 5-30 m read as "flat beige ovals" |
| eyes | wet cornea (roughness 0.035) with a sky catch light; sclera albedo capped near 0.6 and darker on darker skin; iris about 0.4 of the eyeball radius; socket occlusion |
| hair | two Kajiya-Kay lobes along the strand tangent derived from position (UV-derived tangents split mirrored halves), root-to-tip tone, jitter per card, depth occlusion, a transmitted lobe for backlight, alpha-to-coverage at the MSAA sample count, dithered per frame for TAA |
| garments | detail × tint, per-seed hue (±16°) and lightness (±22 %) jitter. Fade saturated dyes (saturation ×0.75-0.95, value −5…−15 %, smallest linear channel ≥ 12 % of the largest); lemon and lime at the gamut edge read as CG paint |
| clone breakers | glasses (sunglasses on about 22 % of adults by day, spectacles 11 %) were the strongest variety cue at street distance |

**Contact shade** (`mh/contact.js`). Shoe-to-paving contact is millimetres, below what screen-space AO or shadow
maps resolve, so people seemed to hover. Draw one multiply-blended ground ellipse per planted foot and a fainter
patch under people who stand or sit, fading out between 25 and 45 m: one draw, quads written on the CPU. The
last critic called it "a hard dark puck, drawn even under a foot in the air". Size it to the sole (about 0.27 ×
0.09 m), use a centre strength of 0.35 or less, and fade it by `1 − smoothstep(0.005, 0.04, min(heelY, toeY))`.

**Motion.** TAA smeared walkers to about half their detail (Laplacian variance 461 moving vs 992 frozen). A per-
pixel motion map for figures fixed it at 0.02 ms. Publish fast movers such as cyclists as moving boxes for the
motion blur.

**Bugs worth knowing in advance:**

| Symptom | Cause | Fix |
|---|---|---|
| coloured streaks and bands across the street, converging on one point | far-LOD skin weights did not sum to 1 after quantisation and decimation; bone matrices include world placement, so missing weight pulls towards the world origin | `W /= max(dot(W, vec4(1)), 1e-4)` in the shader; export uint8 weights that sum to exactly 255; an optional guard that collapses any vertex more than 1.6 × height from the root |
| long sheets from mid-distance figures | unworn parts "hidden" by moving their vertices to `(0, −500, 0)`; merged far LODs shared vertices between parts | collapse into the figure's own hip bone, or better, draw each part as its own sub-draw range so nothing is collapsed |
| red streak in the distance | toddlers riding in strollers at coarse LODs | don't draw a passenger under about 12-15 px (it is inside the canopy anyway) |
| sparkles and NaN pixels near figures | under MSAA the per-vertex AO varying was extrapolated outside small far triangles and went negative; a normalize of a zero bump vector | clamp varyings (`clamp(vAO, 0, 1)`) and guard normalize. Find the module with a show/hide A/B over whole TAA jitter cycles, because single readings swing 2-14 |
| folded arms: upper arms gone, forearms floating | the stance aimed the elbows in a fixed direction, putting them 2-9 cm inside wider torsos | measure each character's torso and arm thickness at load, place the elbows 1.6-7 cm clear, and swing any IK elbow outward if it would sink in |
| shoulder bag 11 cm behind the buttocks, straps through the torso | rigid box fitted to old bodies | re-fit per character, re-project strap paths onto the clothed torso after every smoothing pass, take each strap vertex's skin weights from the cloth under it |
| 426 KB of garbage per frame and GC hitches | `Math.hypot` (boxes its arguments), per-frame closures, comparator sorts, null defaults | scratch typed arrays, slot fields, a radix sort for the draw order, NaN defaults: down to 12.6 KB per frame |
| risk: the first figure shadow (for example after a time-of-day change) compiles mid-ride | `renderer.compile` does not reach `customDepthMaterial` | warm up with one shadow draw before ready |

**Floating people regression.** The user reported people floating in the air "while previously this worked
fine": most of the crowd showed as specks in the sky in one checkpoint and hung above a stop in the next. The
checkpoint had caught a half-finished edit while three owners were editing crowd, frame-loop and streaming code
at once. Measure it instead of eyeballing it: for every active agent compute
`offset = y − agent.h − groundY(s, d)` at the 8 standard views (600-800 people each). The project's probe
(`.work/m46/float/probe.js`) only flagged offsets over 1 m. Use 0.1 m on the main street instead: the
largest real offset was a 10 cm side-street kerb, and up to 0.28 m in side streets, whose carriageway `groundY`
does not model. Make this probe part of every QA pass and of your own acceptance check before you
accept a round. People stand on the route's ground height plus 0.30 m on platforms. In side streets, place them
in that street's own frame and level, blended over the first 4 m past the corner.

## 5. Crowd behaviour

**Contract.** The crowd decides where people are and what they do, and the renderer only draws. Per frame it
sends position, heading, speed, phase, pose (0 walk, 1 stand, 2 sit, 3 push stroller, 4 ride, 5 walk bike), head
`look`, an `idle` stance chosen from context, `holdWith` (the slot of the companion whose hand is held),
`outfit` ('waiter'), and `table: false` for benches. A single appearance seed derives everything else.

**Population and spawning** (`behaviour/population.js`, `visibility.js`):
- Keep people from 42 m behind to 560 m ahead, up to 980 slots (about 775 active). Density is flat from 30 to
  400 m and tapers to 0.75 between 450 and 560 m. The telephoto view looks hardest at 100-400 m, and density
  that halved past 150 m was a critic item.
- Agents beyond 340 m skip avoidance and just move.
- Spawn only where unseen: outside the frustum, inside door recesses or side streets the sight line cannot
  enter, or 2-10 m behind a taller figure or kiosk on the same camera ray. Recycle behind the camera.
  Unconditional far spawns showed figures popping in at 420-460 m.
- Draw seeds from a bank of 2048 so that no cast character repeats within 20 m, or within 12 s of walking past.
  With 49 characters for about 700 people each one appears about 13 times. Two identical men side by side were
  a critic finding.

**Composition targets, measured on the reference photos:**

| Quantity | Target used |
|---|---|
| density at telephoto | about 9-12 people per 10 m of street |
| in company | about 50-65 %: pairs 70 %, threes 22 %, fours 8 %; partners 0.52-0.64 m between body centres |
| children | about 5 %, never alone: only as followers of an adult, hand in hand within 110 m of the camera |
| strollers / riders / walked bikes | 1.5 % / 0.8 % / 0.4 % of walkers (first guess 4.5 % / 3-4 % / 1.5 % read as a cycling city) |
| shopping bags | about 13 % (40 % of people leaving a shop door) |
| café tables taken | about two in three on the main avenue by day, 2-3 per table, following the time of day; waiters serve |
| standing (chats, pauses, windows) | 8-12 % of the visible crowd, kept up for the whole ride, not just at start |
| walking speed | adult N(1.34, 0.13), teen 1.40, over 65 1.08, frail 0.88 m/s; ×0.95 with shopping, ×0.88 on the phone |

**Symptom → fix (each was a critic finding):**

| Looked simulated | Fix |
|---|---|
| strangers walking in lockstep lines of 4-6 | after 1.5 s side by side at the same pace, one drops back (×0.86-0.91) and one pulls ahead |
| groups as rigid rows with identical heading | V or 2+1 shapes, slots wandering ±0.3 m, own pace ±6 %, single file below 1.2-1.5 m of free width, heads turned to whoever talks |
| feet walking while the body is held | velocity from the actual movement; phase advanced by distance actually moved |
| 1-4 m sideways jumps when a café or platform limit snapped | rectangles pushed out through the nearest edge, correction capped at 2·vmax·dt per frame |
| everyone turned to stare into the cab at the bell | only people near the track react; the sidewalk glances at 8 %; delays staggered 0.2-1.2 s |
| first fill gave every stroller and bike to the bins near the camera | plain per-walker draw on the first fill; deficit spawning only far out, capped at 2× the share |
| bench sitters holding hands over an invisible table | `table: false` → hands on the thighs, crossed legs |
| walking through display glass and closed shutters | doors taken from the facade plan, with shutter state |
| platform passengers in an even single file | clusters at the shelter and expected doors (still flagged at the end) |

**Track clearance: time-based, then guaranteed** (`behaviour/tram.js`, constants in `behaviour/constants.js`):
```js
const BAND = SWEPT_HALF /*1.5*/ + AGENT_R /*0.28*/ + CLEAR_MARGIN /*0.33*/;  // centre outside |d − rideD| < 2.11 m
// per agent: tta = metres to the cab front / cab speed (allow for acceleration)
// on the track and tta < own clearT (3.5-6 s; absorbed 2-3 s) + exit time → walk to the nearer safe edge
// tta < CLEAR_DEADLINE (4 s) + exit time → trot (HURRY 2.15 m/s; elderly 1.45 / 1.15)
// absorbed with their back to the cab → bell-request from about 7.5 s
// beside the band inside the zone → kerb: no step in; crossers wait half-turned towards the tram
// after steering: any body or prop capsule still in the band 0-8 m ahead → final projection (counted as a rescue)
```
- A fixed clearing distance left the vehicle's half of the corridor empty for 140 m ahead, which looked staged.
  With per-person times the track is used until each person's own moment, and they step off at varied
  distances, often with a look back.
- A margin outside the swept volume matters. Without it the closest pass measured 4 cm. With 0.33 m the minimum
  is 0.33-0.65 m, and the driver brakes only for bodies really inside the band.
- **Oncoming vehicles** need the same rules mirrored around their own track. Until they had them, oncoming
  trams stopped and crept behind walkers.
- **Pair rule:** when the cab and an oncoming tram pass a spot within 3 s of each other, nobody may wait on the
  0.5 m strip between the tracks. Everyone goes to the corridor edges.
- A rescue push into the other tram's body produced a visible 3.4 m one-frame teleport. Never push across a
  track. In view, do a visible sidestep at 2.2 m/s or more; teleport only when out of sight.
- **Bell:** people on the track within reach react 0.15-0.75 s after the ring, are out of the band about 1.8 s
  later, and nobody steps on for 5 s. A second ring extends the reaction rather than resetting it. Target: 0
  people on the track 2.5 s after any bell, with 78-91 % of people near the track looking round.
- With a free inspection camera, the camera is a 0.9 m obstacle, so nobody walks through it.

**Automated checks** (`crowdCheck=1`; an independent re-projection of every figure's world position and prop
capsule into route coordinates):
- **Counters:** `violations` (body in the swept band 0-8 m ahead), `minClear`, `rescues`, `teleports` (more
  than 3·vmax·dt in one frame), `lateBand` (on the track with the cab under 3 s away), `squeeze` (between the
  tracks while two trams pass), `leftTrack` (inside an oncoming body), `propPeople`, `wall`, spawns or despawns
  in view, `childAlone`, `clearTTA` percentiles, and `brakeLog` (whom the driver braked for).
- **Runs:**
  - a fast simulation stepping train, camera and crowd at a fixed 60 Hz with no rendering, 6-10 simulated
    minutes from 4 start points including the loop wrap (1.5 M samples, 0 violations);
  - real-app rides with the checker on;
  - fixed-step recording mode, so that A/B runs give identical crowds (compare end-of-ride fingerprints).

**Strollers and bicycles.** The user asked for them mid-build. They were built in JS from real dimensions:
- **Models:** 6 bicycle and 4 stroller variants, instanced, with per-instance animation state packed into the
  instance matrix's free row. Spokes are real geometry near and alpha-to-coverage cones far.
- **Attachments API:** grips, pedals, saddle and child seat, which the rider IK reads. Each rider is fitted
  once: trunk lean to reach the grips, seat post for about 28° of knee bend at the bottom of the stroke, and a
  foot put down when stopped.
- **Footprints:** crowd capsules measured on the drawn models (stroller 0.28-1.47 m ahead, ridden bike ±0.97 m,
  walked bike 1.06 m behind to 1.28 m ahead on the right). Body-against-capsule separation brought prop overlaps
  from 0.5-2.5 % of frames to 0.
- **Cyclist behaviour:** pure pursuit over 9 candidate lines. Grooved rails are crossed at 40° or more with an
  S-bend and never ridden along inside the gauge. A rider stopped for 2.2 s with nobody ahead dismounts and
  walks.

## 6. What still read as game-like, and next steps

| Distance | Final verdict (people 6/10, street life 7/10) |
|---|---|
| 30-300 m, telephoto | close to photographic: density, mix of ages and dress, pairs, people on the rails, shadows |
| 10-30 m | passable; faces read as flat ovals under a high sun until the face self-shadow arrived, still waxy within about 15 m |
| under 10-15 m | "a good game cast"; most standard views contain someone this close (platforms, frame corners, stops) |

**The critics' recurring close-up tells:**
- clothing as smooth shells: the same symmetric fold fan on every tee back, skirts as rigid bells or
  lampshades with a bulge behind the hips, aprons as rigid tubes;
- hair as a helmet or one flat sheet, bobs as jagged card clumps, short hair as a moulded cap;
- faces waxy, flat or "dead-eyed"; beards as opaque shells, later as translucent smoke; brows like marker pen;
- straps standing off the body, bags as rigid grey boxes, backpack webbing ending in hooks;
- hands as claws; one pose that loses an arm from the front (hands behind the back); folded arms floating;
- crop-top midriffs, gamut-edge garments, chest prints looking like UI icons;
- no contact darkening (hovering), then a contact puck under lifted feet; phone screens glowing like torches at
  night;
- repetition: 49 characters, identical idles in sync, neighbours in identical outfits;
- groups shoulder to shoulder with bodies overlapping. The critic measured about 20 % in groups, the owner
  58-67 %: share the probe scripts and definitions, or the two will argue.

**Most promising next steps, in order:**
1. Cloth-simulate each garment against the body in the build (rest, sit and walk extremes), bake the result and
   blend pose wrinkle maps by joint angle. Give skirts 2 swing bones per side.
2. Grow the cast to 60 or more and add garment layers worn per person (open overshirts, light jackets, caps and
   sun hats on about 8-10 %), hairstyle swaps between compatible bodies, and more shoe models.
3. Keep 2-3 finger bones per hand in the runtime skeleton, so relaxed hands, phones and bag handles can vary.
4. Hair: more and narrower cards with clumping, baked strand tangents, a Marschner-style lobe, and secondary
   motion for long hair and ponytails.
5. Fix the contact shade (sole-sized, weaker, faded by heel and toe height), enforce a 0.45 m minimum body
   separation in groups, and cluster platform waiting.
6. Untested option: for the few figures that come within 5 m, check whether a higher-detail freely licensed
   human source with shippable output exists before spending more rounds on shader tweaks.

**Process lessons for the people track:**
- Give figures and behaviour separate owners. Hold the figure files out of general photoreal loops while a
  dedicated people workflow edits them. When the user's anatomy feedback arrived mid-pass, a dedicated follow-up
  was queued instead of letting two agents edit the same files.
- Build a harness from day one (`humanstest=1`: whole-cast lineups, walk, sit, family, stroller and ride modes,
  filters by class or garment, `view=` cameras with yaw 180 for backs). Critics and fixers both live in it.
- Ask the people critic for at least 14 shots: lineups front, side and back at 3-6 m, people walking away,
  telephoto crowds, cyclists, strollers, cafés, three times of day, and a short recording for gait and TAA.
- On a GPU shared with other agents, timer readings varied 2-5×. Report structural numbers (triangles,
  sub-draws), interleave old and new builds in A/B runs, and leave absolute timing to a serial quiet-machine pass.
