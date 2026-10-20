# Materials, procedural textures and architectural geometry

How to get photographic surfaces with **zero external textures**: every map baked on the GPU at
start-up from code, every building generated from a shared plan, every surface worn according to
where it sits. Worked example: `/home/vlad/dev/reps/3DSceneRenderer` (`src/materials/`,
`src/world/`). The numbers are from that project (a limestone tram street, three.js r186, 17°
telephoto default); keep the methods, re-measure the values against your own reference photos.

## Contents
1 Ground rules · 2 GPU-baked tileable textures · 3 Runtime surface patch (anti-tiling, specular
AA) · 4 Reference values · 5 Per-building tint and baked AO · 6 Facade plans as the geometry
driver · 7 Stone · 8 Paving · 9 Rails · 10 Glass and interior mapping · 11 Ironwork · 12
Vegetation · 13 Thin wires · 14 Street furniture, signs, street-life density · 15 Repetition and
clone detection · 16 LOD by projected size · 17 CG tells and what fixed them · 18 What never
reached the target

## 1. Ground rules
- **UVs in metres everywhere** (1 UV unit = 1 m). Materials own the tile scale and publish their
  metrics (`materials.meta[name]`: tile, course height, joint width, mean albedo). Any module can
  then lay out UVs without knowing texture sizes, and align geometry to the texture's joints.
- **Linear albedo, matched to a measurement.** Next to every colour, note what it was matched to
  (an sRGB crop of a reference, an R/B ratio, a saturation). Critics' adjectives swing both ways
  between rounds ("too dark" became "too pale", then "crushed to black"); measured targets do not.
- **Model the process, not the pattern.** Every surface that read as CG was a pattern (hatch,
  blob, dot grid, ellipse); every one that read as real simulated how it was made or worn: a chisel
  driven one way, rain hanging from a joint, wheels polishing a band, dust settling on what faces up.
- **Diagnose before fixing.** Switch terms off one at a time (set a uniform to 0, `skip=` a
  module, raycast the pixel to find which mesh and material drew it). Many "material" tells were
  another module's light, a coordinate bug or a baked feature nobody suspected (sections 7, 8, 10).
- **Build a material preview page on day one** (`tools/textures/preview.html`: grid / wall /
  street / single-map modes, sun and camera parameters, `measure(recipe, map, region)` for map
  means). Judging a recipe inside the full app costs minutes per look.

## 2. GPU-baked tileable textures
A recipe is a GLSL function run per texel, in metres inside the tile (`src/materials/recipes/`):
```glsl
struct Surf { vec3 albedo; float rough; float height; float ao; float metal; float cover; };
void surface(vec2 m, inout Surf s) { Cell c = rowsCell(m); /* blocks, joints, wear ... */ }
// recipe: { name, size: 2048, tile: [4.2, 4.2], ss: 2, layout: {rowH, rows, seg, jitter, seed},
//           pass: {normal, ao, aoRadius, cavity}, heightA?, mask?: 'metal'|'paint', aniso?, flat }
```
Two passes (`src/materials/baker.js`):
- **Pass A**: recipe → half-float MRT (albedo, roughness) + (height in m, AO, mask), 2×2
  supersampled per texel (`ss: 2`) so sub-texel features do not alias into the map.
- **Pass B** (shared): Sobel normal from the height in true metres per texel, a 24-tap horizon
  cavity AO, then two RGBA8 targets: `albedo` (sRGB) + roughness in alpha, and `surface` =
  (normal.xy, |normal.xy|², AO). The squared-length **moment survives mip-mapping**, so the runtime
  recovers the normal variance the mips averaged away (section 3). Optional: height in the albedo
  alpha (`heightA: [lo, hi]`) for parallax; a metal or paint-coverage mask in `surface.b`.
- Mipmaps and anisotropic filtering on; cap anisotropy per recipe (4× on fine detail maps).
- **Seamless by construction**: every noise (gradient, fBm, ridged, Voronoi, domain warp) is
  periodic over the tile with an integer period count (`per = round(tile × freq)`). Never blend
  edges to hide seams.
- **One integer hash shared bit-for-bit** by the baker, the runtime shader and JavaScript
  (`glsl/common.js`, `buildings/coursing.js`): the shader re-derives the block layout for
  per-block variation, and JS predicts where joints fall so geometry can land on them (section 7).

| Map | Size | Tile | Texel | Role |
|---|---|---|---|---|
| ashlar | 2048² | 4.2 m | 2 mm | blocks, joints, arrises; crisp at 1 m |
| paving | 2048² | 3.2 m | 1.6 mm | setts and joints |
| rustic | 2048×1024 | 4 × 2 m | 2 mm | bosses + height for parallax |
| tooling, pitch | 1024² | 0.64 / 0.5 m | 0.5-0.6 mm | chisel strokes, pitting (per-block detail) |
| granite | 512² | 0.25 m | 0.5 mm | crystals (detail) |
| macro | 256² raw | 1 m | - | 4 channels of periodic noise for all runtime variation |

- 34 recipes, 43 library materials; texture memory grew 77 → 227 MB as hero maps doubled. Rule:
  hero surfaces at 1.5-2 mm per texel for the closest expected view (a pedestrian at 1 m); micro
  detail (tool marks, crystals) goes into small detail tiles applied per block, not the big map.
- **Start-up**: allocate every target and fill it with the recipe's flat mean (`flat`), so all
  materials build at once; compile all bake programs in one `compileAsync` batch (parallel
  compile), resolve uniforms after all have linked, then draw. The cost is the driver's deferred
  compile on first draw (ashlar ~200 ms first draw vs 7-9 ms steady); the whole bake is 1.5-2.2 s
  cold, behind the loading screen. After start-up, bake one recipe per frame, largest first.
  Time bakes with a 1-pixel read-back (`gl.finish` returned early; CPU submit times mean nothing).
- **Make the bake a readiness gate** (`materials.ready`), or the first frames and captures show
  flat stand-ins. No persistent cache was needed: compile, not pixels, dominated.
- Publish each map's measured mean albedo (`meta.albedo`) so far-field stand-ins and line
  overlays read it and LOD hand-overs match in tone.

## 3. Runtime surface patch: anti-tiling, variation, specular AA
One chained `onBeforeCompile` patch on MeshStandard / MeshPhysical (`src/materials/surface.js`):
- **Row layout in the shader**: each course shifted along u by a hash (kills 2D repetition);
  per-block tint (value ±12%, hue between two end colours, roughness), per-course banding, outlier
  families (15% of stone blocks: pink, ochre, grey), and part of the tone from 1-3 m noise
  sampled at the block centre, so tones drift in runs as quarry batches do.
- **Box-filter the block tint over the pixel footprint** (neighbours blend) instead of fading it
  to the mean: the patchwork then survives on oblique facades 80-150 m away.
- **Mirror the lookup per block** (u, v or both on 75% of blocks): joints map onto themselves,
  so one baked block reads as four.
- **Macro layer**: two lookups of the 256² noise at ~4 m and ~17 m periods; keep it faint on stone
  (±4%: stronger read as cloud mottling). On paving, stretch it along the street (an isotropic
  2 m blotch foreshortens into a thin cross-street band at telephoto).
- **Detail maps fade by footprint** (`1 − smoothstep(3, 12, detail texels per pixel)`) and stop
  being fetched; their mean variance moves into roughness.
- **Specular anti-aliasing** (no mirror lines on rails, poles, rounded arrises):
```glsl
float var = max(S.b - dot(n.xy, n.xy) - 0.004, 0.0);      // variance hidden in the mips
vec3 g = normalize(vNormal);                               // + curvature under the pixel
float gv = min(0.5 * (dot(dFdx(g), dFdx(g)) + dot(dFdy(g), dFdy(g))), 0.18);
float a2 = r * r; r = min(sqrt(sqrt(a2 * a2 + var + gv)), 1.0);   // alpha^2 += variance
```
- **Few programs**: feature families `lite` (plain lookups), `full` (layout, joints, spots,
  detail, dressing, weathering, lanes) and `relief` (parallax); uniforms switch features inside a
  family. 139 programs cost ~9.4 s of serial compile at start-up; two broad families compiled
  20-29% faster than finer splits.
- **Count occlusion once.** One critique found crevice darkening applied 4-5 times (albedo × AO in
  the bake, baked AO, micro-shadowing, SSAO, vertex AO): a dirty halo under every block. Keep
  albedo cavity ≤ 0.08, baked AO radius ≤ 8 mm (small scale only), and scale baked AO to 0.6 while
  SSAO runs (`materials.uniforms.aoScale`).
- Clamp every patched output to finite, non-negative values; use `flat` varyings for per-object
  ids and `centroid` vertex colours under MSAA (section 10, 11).

## 4. Reference values
Linear albedo, from the final build; measured against the street's reference photos.

| Surface | Albedo | Roughness / other |
|---|---|---|
| Limestone, baked mean | (0.60, 0.47, 0.27), R/B 2.2 | 0.86-0.93 face, 0.95 joint |
| Lime pointing | (0.56, 0.475, 0.30), near stone hue | grey mortar turns white under blue sky |
| Granite setts (mean) | (0.157, 0.168, 0.192), cool | flamed 0.70, worn 0.655 |
| Light stone edge band | (0.214, 0.213, 0.207) | ~1.3× setts: a subtle stripe |
| Mortar strips by rails | 0.7-0.85× the setts | 20 mm wide, not 70 |
| Rail running band | ~0.45 grey steel, metal 1 | 0.23-0.5 effective, streaked |
| Rail oxide shoulder / bevel | (0.20, 0.17, 0.14) / (0.17, 0.125, 0.085) | 0.68 / 0.74, metal 0.5 / 0.38 |
| Flangeway groove | ~0.03-0.05 + cavity AO | specular occluded by the AO |
| Window glass base | (0.028, 0.032, 0.035) | 0.03 clean, 0.1 dusty low corners, F0 0.04 |
| Black iron / pole paint | 0.032 / (0.125, 0.152, 0.148) | satin ~0.5 |
| Zebra paint | ~0.59 | paint:paving 1.2-1.25 (photos 1.12-1.32) |
| Leaf base | (0.06, 0.12, 0.028) | 0.45; transmission (0.45, 0.7, 0.15) |

Targets worth measuring on references: sunlit and shaded R/B, HSV saturation of sunlit stone
(photos 0.21-0.34), block-scale luminance std on 1000 px frames (photos ~18-42, median ~28),
sigma-1 high-pass mean (6.8-16), clipped pixel share (median 1.35%).

## 5. Per-building tint and baked AO in vertex colours
- The plan picks an **absolute stone tint** per lot (cream, honey, pale, pinkish, grey, golden);
  the shell applies `(tint / cream)^1.25` as a vertex-colour multiplier on the baked texture
  (`buildings/shade.js stoneStyle`). A **tone table** walks each side of the street and makes a lot
  differ in tone group (warm / middle / cool) from its neighbour 80% of the time; a per-lot value
  factor 0.92-1.06 and ~15% "never cleaned" sooty fronts.
- **Watch compounding saturation.** The baked limestone was pushed honey (saturation 0.16 → 0.27,
  on target); the honey tints and the 1.25 exponent multiplied on top gave egg-yolk walls
  (0.41-0.51 against the photos' 0.21-0.34). Measure saturation after every multiplier in the
  chain, not per layer.
- **Baked AO and grime per vertex**: 1D tables along v at 5 cm steps per face (under cornices and
  string courses, in reveals, the splash zone). Vertex colour is limited by tessellation, so add
  vertex rows where gradients must be sharp (+5, +18, +40 cm above the paving).
- Compact format: unorm8 × 4, rgb = sqrt(colour / 2), a = grime / 2 (decoded in the vertex
  shader); an int16 × 4 `aRun` attribute names the occluder above each vertex (slab, sill,
  console), so run-off is shaded per pixel without extra geometry.

## 6. Facade plans as the geometry driver
`facadePlan(lot)` (`src/world/facadePlan.js`) is pure, cached data in facade coordinates (u along
the wall, v up, w out); see world-architecture.md section 8 for the contract. What it buys here:
```js
{ floors: [{y, h, kind}], bays: [{u0, u1, w}], openings: [{kind: 'shop'|'door'|'window'|
  'balconyDoor', uc, w, y, h, top: 'flat'|'round'|'segment'|'pointed', recess, shutters, ac,
  lit}], balconies: [{floor, u0, u1, depth, slabT, railing, consoles}], courses, cornice,
  parapet, roof, rooftop, signs, style: {era, tint, courseH, blockL, tooled, rusticGround, ...},
  coursing: {ch, v0}, relief, returns, upper, vista }
```
- Consumers: building shell (masonry), facades (glazing, shopfronts, signs, interiors), ironwork
  (slabs, consoles, railings), crowd (doors), far field. Each extension uses its **own RNG
  stream** (`RNG.from(seed, 'shell')`), so adding a feature never shifts earlier draws.
- **Publish shape decisions both ways.** Consoles landed on arch voussoirs and keystones until
  the plan exported `headDressing(plan, orn, o)` (extent and top of each arch ring, lintel, hood);
  open shutters passed through corbels until ironwork published `consolesOf(lot)`; ground-floor
  heads now stay under `groundHeadLim` to leave 0.8 m of console room under first-floor slabs.
- Variety that read as a real street: eras 40 / 36 / 24% (Ottoman / Mandate / later blocks with
  wide flat windows and slab balconies, half colour-washed); 2-9 floors weighted to 4-6; bay
  rhythms even / wide centre / wide ends; set-back penthouses; chamfered corners.
- **The vanishing point decides the shot.** `plan.vista` marks lots that close the view. Tall
  9-12 storey grid towers there (with sky murals) read as glass curtain walls and CG boxes; 2-4
  storeys above the street wall, stone-clad, with shutters, AC units and rooftop tanks, read real.

## 7. Stone: coursing, dressing, joints, rustication, weathering
**Coursing aligned to the architecture.** `coursing(plan)`: course height `ch` is chosen so a
typical storey holds whole courses; window sills sit on a bed joint and each window from sill to
spring line is whole courses. For head joints, a JS replica of the shader's layout finds, per course
and per run of wall between two jambs, a small u stretch (a few %) and shift that puts a head joint
on each jamb. Reveals and jambs take the facade's coursing mirrored about the arris, so joints wrap
corners. Before this, joints sliced jambs and left 2-3 cm slivers beside surrounds and quoins.

**Tool marks (taltish).** Six rounds, each found wanting: invisible (stucco panels) → fish-scale
comb rows → hairy random scratches → a quilt of hatched patches ("embossed wallpaper") → a
halftone hatch → crosshatch. What finally read as dressed stone (`recipes/stone.js tooling`):
- one working direction per block (35-100° from horizontal), never a crossing pass;
- strokes 10-15 cm long, one chisel wide (4.4-5.9 cm), in rows that each start at their own
  offset (aligned bite ends read as a second hatch);
- passes of 2-3 strokes, each with its own angle (±3.5°), tooth pitch (2.8-5.2 mm) and depth;
  uneven teeth, ragged bite end, 1 in 11 strokes missing, depth drifting over 20-40 cm;
- relief carries it in sun; dust in the grooves (albedo) carries it in shade;
- mix per block: 60% taltish, 25% pecked, 15% rubbed; fade to 55-70% at 3-8 m. At 6 m the face
  should read as smooth, softly mottled stone, as in the photographs.

**Joints and arrises.** Pointing 4-8 mm, width wandering along the joint, recessed 0.7-2.5 mm,
lime coloured close to the stone (linear R/B ~1.85 vs 2.2). Arris worn to a 1-4 mm dusty chamfer
along about half its length. Chips: irregular flakes outlined by 3-4 straight fracture facets,
0.8-2.2 mm deep, slightly **darker** than the face, about one per 2 m of arris on half the blocks.
Failures on the way: "melted wax" beads (rounded 6-16 mm arris), grey putty blobs, white half-moon
notches (elliptical, paler chips), and a bright ruled line above every bed joint (the up-facing
chamfer catches a high sun: dust it, darker and rougher).

**Rock-faced rustication.** Read as cauliflower, crumpled foil, then foam pillows. Better: per
block 3-5 large struck planes (6-20°) round an undulating crown, 1-2 conchoidal scars at the edge,
pitching bites along the break line, a flat drafted margin of 15-25 mm, joints 2 cm deep; boss
5-9 cm proud. Height in the albedo alpha drives **parallax-occlusion relief** (12-24 steps by view
angle, one secant refinement, a 14-step self-shadow march to the sun with per-pixel jitter,
full within 20 m, gone by 35 m), plus a relief sky-occlusion from the height so bosses keep form
in shade. Cost ≤ 1.2 ms in the worst close-up. **Limit**: parallax cannot change the mesh
outline; pier corners and reveals stay ruler-straight unless the shell models proud blocks.

**Weathering from orientation and placement**, never isotropic blobs:
- Ledges (world normal y > 0.4-0.85) collect patchy dust; soffits evenly dark; up-facing V-joint
  chamfers dusty.
- Run-off: a lattice of single streaks: columns every ~0.6 m, a slot every 2.4-4 m of height,
  about half filled; each hangs from a bed joint, 4-14 cm wide, 0.8-2.6 m long, widening ~70% and
  fading as it runs down; strength drifting along the wall in broad stretches.
- Placement-driven (buildings' `aRun`): soot crust under cornices and slab soffits, trails from
  sill ends, slab corners and console feet, rust tails under neglected railings (the same
  neglect hash the railing shader uses); a dirty foot 0.5-0.8 m high at ×0.8, 1.0-1.3 m by jambs.
- Soil colour **warm brown-grey** (run-off ≈ luminance × (0.98, 0.84, 0.62)): neutral grey
  turned olive under golden light. Compute masks in continuous facade metres so they cross piers
  and material borders; masks per material stopped as rectangles at every face edge.
- Rendered fronts: uneven fade paler towards the top, 1-4 m repair patches within ±5% tone,
  stains under sills, hairline cracks from sill corners.
- **The coordinate bug**: weathering placed along the wall from `dot(worldPos, tangent)` with the
  tangent taken from a snorm8 normal (±0.3°) at ~1.4 km from the origin jumped metres between
  vertices: grey-green "airbrushing" and barcode stripes on consoles. Use per-face frames or
  attributes for facade coordinates, never world position against a quantised normal.

## 8. Paving
- **Layout from the photos**: 0.40 × 0.20 m setts in running bond, courses across the street on
  the track corridor (along it on sidewalks). Split the joints: bed joints tight and sand-filled
  (faint pale lines), head joints wider, mostly sand, some dirty (soft grey dashes); each joint
  has its own width, fill depth and fill, keyed by the joint's id so both setts agree.
- **Cool granite**: albedo cooled from ~0.29 warm grey to (0.157, 0.168, 0.192); per sett a
  finish (flamed: paler, matt; worn: darker, satin, dished, rounded arrises) and sparse
  inclusions (xenoliths 3.5%, aplite veins 8%; rust specks on 20% of setts were called measles).
- **Tone variance, by rounds**: ±4% (corridor std 7 vs 14-18 in photos: too clean) → ±14%
  (a checker mosaic) → independent ±7% + correlated 1-3 m noise at the sett centre + 3.5% odd
  setts. Per-sett roughness ±3% only: more made single setts glint as a barcode at grazing sun.
- **Grazing joint masking**: at a low angle the near arris hides a recessed joint. Use the
  footprint anisotropy and only below ~10° elevation (`smoothstep(5, 10, anisotropy)`, strength
  0.4); an early `smoothstep(1.6, 4)` erased the bed joints and left a sheet with dashes.
- **Far blend**: once a pixel spans 8-45% of a course, blend to the map's mean (last mip) under the
  smooth tone drift and draw joints analytically as box-filtered pale dusty lines. Diagnosis
  first: the telephoto "plank deck with dark dashes" was **not** the spill blots (switching them
  off changed nothing) but baked corner spalls and dirt-filled joints foreshortened to 1-3 px;
  dark specks fell ~5×. It overshot: the corridor at 30-200 m lost its joint grid (section 18).
- **Grime from placement** (vertex colour and line decals per chunk): soft brake-dust bands
  0.05-0.35 m beside each rail; one continuous 0.75 m drip strip between the rails with ±45%
  density over 5-20 m (single oval decals read as smears); oil only under standing trams at stops;
  rust halos round covers; a darker trodden lane on sidewalks; kerb grime. Relaid strips end on
  bed joints, but their 16-32% tone shift still read as flat decals: keep it to 5-10% and let the
  sett texture show through (asked for, never done).
- **Gum and spills** drawn at runtime per global sett, so they never repeat with the tile: gum
  lognormal 0.6-3 cm, outline warped ±40%, 1 in 8 smeared, 0.55-0.8× the sett (grey, matt),
  clustered by a 3-8 m mask where people wait, a fifth as dense over the rails. Identical dark
  ellipses read as drilled holes.

## 9. Rails
- **Width first**: 70 mm mortar strips made each rail read twice its width; 20 mm strips at
  0.7-0.85× the paving tone fixed it. Groove albedo ~0.03 with cavity AO folded into F0 and F90
  (the walls otherwise mirror sky into a pale band).
- **Head bake by zone** (u along the rail, v across the head, pinned to the profile): a 16-26 mm
  ragged running band; polished stretches between duller ones; 0.3-2 m brown-filmed stretches;
  blue-grey skid burns; mid-scale lengthwise streaks (fake anisotropy; a fine brushed grain read
  as chrome); oxide shoulders and bevel off the band (section 4). Publish per-zone means
  (`meta['rail.head'].zones`) so the far overlay matches the 3D rail.
- **Sheen in shade**: rails read as dark slots because the canyon was occluded twice (the
  environment cube already contained the street canyon; the street shader multiplied by 0.38
  more). Fix: no extra occlusion, and bend the reflection lobe along the rail axis into the sky
  slot down the street (wheel polish spreads it round a cone). Target band ≈ 1.15× the shaded
  setts (measured in a reference); got 1.16-1.30×.
- **Far rails**: an analytic ribbon widened to ≥ 1 px that integrates the cross-section (head,
  groove, lip, seals) over the pixel footprint. **Average bands physically**: each band adds its
  own diffuse and specular share; mixing albedo and metalness separately gave edge pixels partial
  metalness, bright fringes and dash trains.

## 10. Glass and interior mapping
- **Interior mapping**: a room box traced per pixel behind the glass (homes ~4 m deep, shops ~7 m)
  with floors, ceilings, furniture with eased edges and contact shadow, shelves of goods from an
  atlas, mannequins, curtains, blinds (`src/world/facades/interior.js`). Skip furniture once a
  pixel covers more than 6-11 cm of glass, fading so nothing pops.
- **Reflection**: trace a stand-in of the opposite facade row (storeys, shop band, awnings,
  roofline, sun/shade line), the paving and trees; above the rooflines look the sky up **at the
  same elevation along the street**. The env cube, captured mid-street, saw the dark window grid
  opposite and made every upper window a black hole. Both faces reflect: ~8% face-on, 15% at 60°,
  27% at 70°.
- **Brightness**: by day goods near the glass sit at 1/5-1/4 of the shaded street and the back of
  the shop at 1/10 (retail ~1000-1500 lux against 50-100 klux outside); the reflection dominates
  wherever it shows anything bright. From dusk lamps follow the exposure within a physical range
  (`uShopNight = clamp(4 / exposure, 0.0075, 0.035)`), 2700-5000 K by trade, ~40% of rooms lit.
- **Artefacts and their real causes**:
  - speckle in curtains and goods: per-window seeds passed as interpolated varyings (1e-7 noise
    through hashes). Fix: `flat` varyings and window-local coordinates.
  - moiré and crawl: unfiltered `step(fract(...))` blinds and folds. Box-filter every periodic
    pattern by `fwidth` and fade to its mean below ~2-3 px per period.
  - blocky "pixel art" reflections: a nearest-looking block menu board and unfiltered niches,
    then low-res mosaic cells. Filter by footprint; never nearest-sample a stand-in.
  - a blown-out "second sun" in glossy glass: env's canyon cross-bounce was a horizontal
    directional light at eye height. Fill lights standing in for area sources must be
    diffuse-only.
  - cardboard ghosts: stand-in people in the reflection. Removed.
  - far windows flat dark: the glass lost the depth test to the shell's back plate; offset the
    far glass forward 3 cm with polygon offset.

## 11. Ironwork: geometry near, coverage cards far
- Instanced geometry near (bay tessellation by chord error < 0.4 px), **coverage cards** far: an
  atlas whose alpha is the true iron coverage per texel at every mip (plain box filter).
- **Hand over by union, not dither**: geometry alone above 2.2 px bar width, card fading in from
  2.2 to 1.3 px, geometry fading out to 0.8 px. A dithered swap drew stippled barbed wire.
- Alpha-to-coverage on the MSAA target, **rounded to whole samples**
  (`floor(a * samples + 0.5) / samples`): some drivers dither fractional coverage over a
  screen-fixed 2×2 pattern (a checkerboard on the iron). Without MSAA a 0.5 cut aliases.
- Grazing angles: count the bar width smaller by `|n·v| / 0.35` (cards take over early), and let
  each stroke orientation in the card add cover for the members' depth, so the railing closes
  into a dark band as real ones do (thin ghost lines otherwise; no Fresnel rise on a lattice).
- Shadows from position-only light stand-ins; thin parts cast only in cascades whose texels can
  hold them; cards cast their true share of iron.
- **Consoles**: `ExtrudeGeometry` gives every facet a flat normal and its UVs jumped up to 0.95 m
  between facets (barcode stripes). Own sweep: 8 segments per right angle, 40° crease angle,
  arc-length UVs, grime in facade metres so streaks hang plumb.
- Rust and paint wear from a world-space neglect field computed identically in JS and GLSL
  (`ironNeglect`), published per balcony so the wall below gets matching rust tails. Paint per
  lot: 60% black, the rest greens, blue-greys, oxide brown.
- Planting is a census decision (section 15), and two critic lenses pulled it both ways: 2/3 of
  balconies with geraniums read fake; 24% planted read bare; final 61% on the avenue, ~30%
  elsewhere, varied by household (geranium, herbs, ivy, surfinia, bougainvillea, dry boxes).

## 12. Vegetation
- **Templates**: 14 trees grown once by space colonisation inside a crown envelope (pipe-model
  radii, three LODs), mirrored copies (z negated, winding reversed) double them; per tree scale in
  x and z apart, lean, yaw, tint; never the same template as the previous tree on that side.
- **Leaf atlas** painted on CPU canvases in workers (GPU canvas read-back waited behind the
  start-up compile: trees came up bare on a loaded machine). Coverage-preserving alpha mips,
  alpha-to-coverage rounded to samples, mips biased half a level coarser. Make the atlas a
  readiness gate.
- **Crown as a medium**, not solid cards: move each leaf's shadow lookup towards the sun about a
  third of the way to the crown exit (outer leaves shade inner ones, no darkened tiers);
  self-shadow as exp(−density × path); sky occluded by the path to the crown surface; the core
  gets ~40% of the shell's non-sun light. Transmission only from the far side, ~0.55 of the lit
  face.
- **The neon-green failure**: back-lit leaves at low sun clipped to neon. Cap transmission and
  specular of a light at 8× the sky irradiance (lamps 14×, lamps transmit 0.3 of the sun's
  share), and pull colour back from the gamut edge in the grade.
- **Ping-pong to avoid**: canopies "2-2.5× too dark" → albedo and transmission raised → "pale
  over-translucent lime" → neon → near crowns crushing to black. Fix to measured green-pixel
  means of the references (here ~(70-90, 85-105, 45-60) sRGB in sun) and luminance spread
  inside the crown (photos 3.5-5.3 EV p90-p10), not to the last adjective.
- **Wind**: trunk sway stiffening with height^1.8, branch motion, flutter that rotates the outer
  half of each card about its own axis; the same code in the depth material so shadows move.
- **Shadows**: drop ~30% of leaf cards in the shadow pass and tighten alpha test to 0.56
  (dappled shade, sun flecks); a soft sky-occlusion disc on the paving under each crown.
- Density: crowns filled 25.8% of the default frame and walled off the facades; 20% read right
  (cards per shoot tip 3.5 → 2.2, crown bases raised to 2.55-2.9 m on young trees).

## 13. Thin wires and sub-pixel lines
- Wires as ribbons expanded in the vertex shader to max(true diameter, ~1 px); alpha carries the
  true coverage (diameter / drawn width). Draw them **opaque with alpha-to-coverage** under MSAA:
  blended wires wrote no depth, so DOF, SSAO and haze treated them as sky.
- Thin opaque parts (lamp scrolls, far bars) inflated to a minimum pixel width must carry
  `alpha = 1 / inflation` too; at full opacity far scrolls read as heavy pen strokes.
- Guard every normalise in wire maths (end-on and straight-down views produce zero vectors).

## 14. Street furniture, signs and street-life density
- **Measure colour, not impressions**: share of vivid non-foliage pixels (S > 0.45, V > 0.22,
  hue outside 60-170°) in the street band (rows 40-85%). Renders started at 1.8-3.4% against
  3.6-10% in the photos; strong awning and fascia palettes, door displays and branded umbrellas
  brought it to 7.3-10.8% (photo median ~6-7%).
- **Signs**: fictional proper names (Hebrew over English, 60 names, 6 letterings), a second line
  (trade, phone, year), a logo mark; name at 56-66% of the board height; no blank fascia ever;
  pictogram-only faces ≤ 15%; a trade that does not cluster never repeats within two shops; 40
  poster designs dealt per 40 m block from three phased pools (no design twice within ~80 m).
  Use real vocabulary for legible text (menus, map legends); pseudo-words read fake.
- **Text resolution bugs**: glyph cells kept their empty margins, so text drew at 40% size (crop
  each cell to its measured ink); a 128 px cell on a 0.5 m board is 150 texels/m, magnified
  4.6× at 3.6 m: 256 px cells plus a clamped Catmull-Rom close-up filter; an atlas index arriving
  interpolated as 8.9999995 picked the wrong column (round before `mod`).
- **Wear on every prop** (`patchStreetWear`): dusty tops, edges rubbed by curvature, splash and
  scuffs at the foot, run-off, stickers on 80%, a tag on a third. Pristine primitives were the
  most-cited furniture tell.
- **Goods with volume**: 40-60 instanced fruit heaped per crate; garments as 2-4 cm shells with
  folds and drooping sleeves; pillowed bags. Flat cards fall apart within 10 m. Register every
  stand as a crowd obstacle.
- **Café umbrellas**: identical cream squares at one height formed continuous tents. Per café:
  3-5 m square or rectangular, hem 2.3-2.7 m, a palette, 12 fictional brands on half the
  valances, some furled or absent, suppress runs facing each other within 40 m. Smooth curved
  props: ≥ 24 segments on visible curves, 12-16 sides on caps (octagonal ends read low-poly).

## 15. Repetition and clone detection
- **Census hooks**: count every decision over the whole loop (planting by balcony, flags,
  consoles per slab, shop types per front) and compare with a reference census.
- **Adjacency checks** from the layout: the same tree template at s = 154.8 and 163.6 m was
  found by script, not by eye.
- **Frame-occurrence counts**: a critic found one red SALE disc in 9 of 31 frames and the same
  price stickers on two shops 12 m apart.
- Fixes that worked: mirroring (templates, texture blocks), independent RNG tags per decision
  (four adjacent shutters down at noon came from lot-level correlation), runtime features per
  global cell (spills), no-repeat windows (~80 m posters, two shops for trades), pools of 30-40
  designs per kind.

## 16. LOD by projected size
- Choose detail **per instance from projected size every frame**, so it follows the zoom: at 17°
  200 m is ~5.5 cm per pixel, like 50 m at 60°. Distance thresholds tuned at a wide lens popped
  at telephoto (a 1 m bin is 18 px tall at 200 m and appeared from nothing).
- Thresholds that worked: chord error < 0.4 px; omitted features < 0.6 px; trees 460 / 95 px
  projected height with 8% hysteresis and a 0.35 s cross-fade (complementary dither, resolved by
  TAA); shadows at no more detail than the cascade texel holds.
- The building LOD at 200-680 m keeps every cornice profile and hood; drop only sub-pixel parts
  (dentils become a vertex-colour stripe). Verify with fixed-step recordings and frame
  differences, not stills.

## 17. CG tells that kept coming back, and what fixed them
| Tell | Real cause | Fix that worked |
|---|---|---|
| Rails as chrome tubes | uniform bright head, brushed grain | narrow ragged band, oxide sides, streaks, sky-slot lobe |
| Rails as dark slots in shade | canyon occluded twice | single occlusion, lobe bent along the rail |
| Paving "tiled floor" / cobble net | equal dark joints, deep chamfers | split bed / head joints, sand fill, eased arrises |
| Checker mosaic, then barcode glints | uncorrelated tone, per-sett roughness | correlated tone, roughness ±3%, far fade |
| Telephoto plank deck with dashes | baked chips foreshortened | far blend to mean + analytic joint lines |
| Ashlar like plaster | dressing too faint | process-modelled strokes, relief + dust |
| Melted wax / half-moon chips | round arris, elliptical paler chips | worn chamfer, faceted darker flakes |
| Rustication as foam / foil | noise bumps, normal map only | struck planes + parallax + relief AO |
| Camouflage blotches on walls | isotropic noise stains | run-off streaks from joints and occluders |
| Grey-green airbrushed walls | quantised-normal coordinate bug | per-face facade coordinates, warm soil |
| Barcode stripes on consoles | ExtrudeGeometry facet UVs and normals | own sweep, arc-length UVs, crease angle |
| Black upper windows | env cube saw opposite windows | sky looked up along the street |
| Second sun in shop glass | directional fill light | diffuse-only fill |
| Stippled iron / leaves | dithered hand-over, driver A2C dither | union cards, coverage rounded to samples |
| Neon foliage | uncapped back-light | caps vs sky irradiance, gamut pull-back |
| Blank sign swatches | glyph cell margins | crop to ink, size text to board |
| Pristine props | no wear layer | shared curvature / foot / sticker wear patch |

## 18. What never reached the target
Final surfaces score 6/10 (it had been 6.5 the round before); the blind A/B still preferred the
final build overall. Open at the end:
- Corridor setts at 30-200 m lost their joint grid (high-pass std 3.4 vs 7.6-21 in references):
  the far blend fixed the dashes but flattened the field. Keep the box-filtered joints as a grid.
- Honey and golden lots egg-yolk saturated, limestone mustard in shade (section 5).
- Rock-faced rustication still reads as soft pillows with blue-black joints; silhouettes straight.
- Rails still read as bright chrome lines at telephoto; critics asked for rougher, then glossier.
- Corbels are simple rolls where references show carved volutes and acanthus.
- Shop interiors pale and empty by day, glowing slabs at night; reflections still blocky close up.
- Hung goods still strips and boxes; some fascias blank; kiosk prints look corrupted up close.
Lesson: the hero surfaces in the default view (paving, rails, stone saturation) cost more in a
blind comparison than any close-up; fix those first and verify each at the default lens.
