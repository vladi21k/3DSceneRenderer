# Photoreal checklist: catch the CG tells before a critic does

Run this against your own screenshots before any critic or human sees them. Each row gives the recurring CG tell (in the words critics used), how to detect it (view plus metric), the target taken from the reference photos, and the fix that actually moved the score. The numbers come from the worked example: a sunny limestone street with twin tram tracks, 7 reference photos, a 17° telephoto cab view, three.js r186 (repo `/home/vlad/dev/reps/3DSceneRenderer`). Recompute every target from your own references; keep the method.

## Contents
0. Set-up: build the reference envelope first
1. Exposure and tone · 2. Colour and white balance · 3. Sky and clouds · 4. Shadows and AO
5. Haze, depth and the far field · 6. Materials and stone · 7. Paving and rails · 8. Glass and interiors
9. Vegetation · 10. Wires, ironwork and aliasing · 11. Density, repetition and street life
12. People, close and far · 13. Crowd behaviour · 14. Vehicles · 15. Motion and camera
16. Time-of-day variants · 17. Robustness tells to automate
18. Score trajectory: what moved, what never did, what oscillated
19. Writing critic prompts · 20. Blind A/B acceptance

Glossary: **p2/p50/p98** = luma percentiles (0-255 sRGB); **clip%** = pixels with max channel ≥ 250; **Hasler** = Hasler-Süsstrunk colourfulness; **sat** = mean HSV saturation; **R/B** = mean red over mean blue (warmth); **G/mRB** = green over mean(R, B) (above 1 = olive/green, below 1 = magenta); **EV** = one stop (factor 2); **px RMS at 17°** = camera motion converted to screen pixels at the default lens.

## 0. Set-up: build the reference envelope first

Critics who opine drift; critics who measure converge. Before round one, measure every reference photo with one script and keep the table in the project docs and in every critic and fixer brief.

```python
# tone.py img... : the metric set every round used (from .work/m46/env/metrics.py)
import sys, numpy as np; from PIL import Image
def tone(p):
    im = Image.open(p).convert('RGB'); w = 1000; h = round(im.height * w / im.width)
    a = np.asarray(im.resize((w, h), Image.LANCZOS)).astype(float); R, G, B = a[..., 0], a[..., 1], a[..., 2]
    Y = .2126*R + .7152*G + .0722*B; mx, mn = a.max(-1), a.min(-1)
    rg, yb = R - G, .5*(R + G) - B
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    return dict(mean=Y.mean(), p2=np.percentile(Y, 2), p50=np.median(Y), p98=np.percentile(Y, 98),
                clip=(mx >= 250).mean()*100, sat=sat.mean(), sat_b3=sat[2*h//3:].mean(), rb=R.mean()/B.mean(),
                hasler=np.hypot(rg.std(), yb.std()) + .3*np.hypot(rg.mean(), yb.mean()))
for f in sys.argv[1:]: print(f, {k: round(v, 3) for k, v in tone(f).items()})
```

Add patch measurements (box means and HSV sat) for: sunlit paving, shaded paving, sunlit stone, shaded stone, the sky slot near the horizon, a sunlit crown, a shaded crown, shop glass, upper windows. Add a detail metric (mean absolute Laplacian at 640 px wide, or 16 px block luma std) and a street-band "vivid accent" share.

| Quantity | Reference envelope in the worked example |
|---|---|
| Full frame by day | mean 110-144 (median 131), p50 115-169, p98 200-249, p2 3-40 (median 13), clip 0.05-11.6% (median 1.35%), Hasler 28-60, sat 0.22-0.52 |
| Detail | Laplacian 0.10-0.20 (renders started at 0.06-0.09); 16 px block std 18.5-42 (median ~28) |
| Paving | sunlit 178-211 sRGB, std 10-29, R/B 0.88-0.97; shaded sat 0.05-0.09, R/B 0.88-0.95; sun:shade ≥ 3.4:1 linear, ~10:1 under a crown |
| Limestone | shaded sat 0.04-0.24, R/B 1.05-1.30; sunlit sat 0.15-0.35; paving darker than sunlit facades |
| Sky | below 10° elevation: 205-250 sRGB, sat 0.02-0.12; slot is the brightest region; clouds near white (sat < 0.05) |
| Foliage | ~12% of frame (3-29%); shaded crown luma 67-83, p5 4-16; sunlit crown std 45-68, p5 10-22 |
| Windows, colour | upper panes luma 60-105 (p95 125-207); street-band vivid pixels 3.6-10.2%; pixels above 0.85 sat ~1-3%, crushed channel 0.01-0.75% |

- **Flag graded photos and drop them from colour targets.** Two of the seven references were colour-graded (one warm-graded, one phone-processed). A critic who took stone warmth from them pushed limestone to R/B 1.7; two rounds later another critic measured "egg-yolk" walls and pulled it back to 1.05-1.30. Use the median of the ungraded set, never the extreme.
- **Fix the standard views** and shoot them identically every round: default ride view; midday mid-route; golden hour at a stop; a wider lens (28°) late morning; sunset; dusk; afternoon at 40°; one pedestrian-height close-up of a facade. Freeze the simulation (`freeze=1`, `speed=0`) for stills, record fixed-step clips for motion.
- **Write every target as a two-sided range** ("p2 12-25", not "lift the blacks"). One-sided fixes caused every oscillation listed in section 18.
- **Before editing code, simulate the change on the capture** (for example invert the tone curve, add +0.75 EV, re-measure). One critic did this and landed exactly on the reference histogram.

## 1. Exposure and tone

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Milky, lifted blacks, a tone-mapped HDR frame" | p2, p10, p90/p10 in EV, black% (max ch ≤ 16) | p2 3-40 (aim 10-25), p90/p10 4.6-6.2 EV sunny | Refit the toe to camera-JPEG targets by numpy grid fit (−3 EV→sRGB 31, −2→52, 0→121, +2→215); add a black point after the tone mapper; keep the deep toe through golden hour |
| "Dim, muddy, overcast-dim under a blue sky; no whites" | mean, p50, p98, clip% | mean 110-130, p98 ≥ 205-225, clip 0.5-3% (≤ 7%) | Anchor day exposure to incident light (exposure ∝ π / Eh, so an 18% card in sun lands near mid grey) and clamp the auto-meter by day to [0.7, 1.35]; then calibrate the constant against the histogram (it still needed +0.76 EV). Unanchored, exposure swung −1.15, +1.2, −0.75 EV over three rounds |
| "Graded render: nothing ever clips" | clip% (renders were 0.01-0.15%) | median ~1.35%; the sky slot's blue channel clips like a JPEG | Move the highlight knee from +1 to about +1.6 EV by day; let the sunlit sky slot and white umbrellas reach 229-255 |
| "Golden hour into the sun is a milky veil" | p90/p10 on a backlit telephoto (was 1.85 EV) | ≥ 3.5 EV; up to ~8% clipped sky is fine (the backlit reference clips 11%) | Cut sun veil 0.004→0.0012 with a tighter angular falloff; when backlit, meter the street to about −0.5 EV and let the sky blow |
| "Exposure depends on view direction" | same time of day, facing towards vs away from the sun | means within ~15 levels | View-independent ceiling at sunset (exposure ≤ 1.5× the base), meter correction clamped |
| "Wide sunlit paving burns to a textureless sheet" | sunlit paving mean and std | 178-210 with std ≥ 10 | Ease the curve's slope above mid grey (1.12→1.0) and lift mid-tones +0.3 EV instead of raising exposure |
| Exposure pumping in motion | frame mean over a recorded 6-8 s ride | ≤ 1.3 levels frame to frame | Pass condition only; keep the meter slow |

## 2. Colour and white balance

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Sunlit grey paving reads warm beige" | R/B of sunlit paving (was 1.06-1.11) | 0.92-0.98 | Balance on the sun's direct component only (a camera "daylight" preset), drop the warm highlight tint by day, cool the paving albedo |
| "Shade too bright and not blue" then later "shade lavender-blue" | shaded paving sat and R/B | sat 0.08-0.13, R/B 0.88-0.93 by day | Do not double-count bounce: the canyon env map already holds it, so cut the extra hemisphere fill {0.4, 0.55}→{0.15, 0.2}; gate bounce by the opposite facade's sunlit fraction |
| "Limestone mustard or cardboard in shade; shade more saturated than sun" | stone sat and R/B in shade vs sun | shade sat 0.15-0.28, R/B 1.15-1.35; never above the sunlit sat | Albedo B/R up ((0.6, 0.47, 0.27)→(0.58, 0.52, 0.40)); turn the global saturation boost into vibrance (weight by (1−s)², day boost 1.3→1.1); cut warm cross-bounce 0.22→0.12. Still open at the end |
| "Magenta/mauve dusk paving, olive facades" | G/mRB of neutral surfaces from tod 0.65 on | 0.97-1.02; between lamp pools hue 215-230 | Constrain WB gains to the daylight locus (gG = √(gR·gB) ± 1%), never a green or magenta push; lamps as 3000-3500 K blackbody (G/R ≥ 0.75) |
| "Pastel: nothing vivid reaches the gamut edge" vs "neon foliage, crushed blue channels" | share of pixels above 0.85 sat; share with a channel < 4 while max > 80 | ~1-3% and 0.05-0.3% | Soft saturation ceiling starting ~0.82 and limiting ~0.98 instead of a hard clamp; cap garment and sign chroma at source |
| "Sunlit stone highlights apricot, not cream" | mean sat of warm pixels at luma 190-220 | ≤ 0.25 | Desaturate above +1.5 stops towards the illuminant's white |
| "Golden warmth orange-pink, not cream-yellow" | G/mRB of golden paving; blown sky colour | 1.03-1.07; sky about (250, 248, 225), not neutral 255 | Golden-hour WB on the yellow side; in-scatter colour from the sun aureole |
| "Recovered glints become grey-cyan tiles" | sunlit setts with B ≥ R−5 | none | Compress highlights as one RGB scale in scene-linear before the gamut knee |

## 3. Sky and clouds

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Water ripples / regular dash field over the whole sky" | 4× crop of the sky slot | a few long fraying wisps; 55-70% clear | Noise anisotropy 8:1→~2.5:1, large coverage mask, fade contrast below 8-15° elevation |
| "Polka-dot / cotton-ball cumulus; a lone sprite puff" | equal sizes and spacing in a crop | size spread, flat darker bases, groups | Domain-warped fbm with a low-frequency coverage mask, lognormal sizes, bases ~0.6× darker, drop cells under ~400 m |
| "Cirrus as smoke rings / vertical brush strokes" | closed loops, screen-vertical streaks | fibrous, wind-aligned | Stretch 1:8 along the wind in the cloud plane; warp < 0.3 of feature size; add a fibrous erosion octave |
| "Low sky saturated blue" | sat of sky below 10° (was 0.34-0.53) | ≤ 0.15, 205-240 sRGB, brightening towards the vanishing point | Make the sky-saturation boost depend on view elevation (1.0 below 8°); aerosol whitening near the ground |
| "Slate/denim sky darker than the sunlit street" | slot luma vs sunlit paving | slot always brighter | Near non-absorbing aerosol (albedo ≥ 0.95), low scale height (~0.8 km), brighter ground albedo |
| "Clouds tinted blue" | cloud-top sat | < 0.06 | Multiply the sky boost by (1 − cloud opacity) |
| "Sunset sky a flat salmon card, red pinned" or "pure white" | vertical gradient and hue across the slot | ≥ 25 levels; horizon hue 30-40°, peach-pink above | Apply the horizon cap to the final metered exposure; soft gamut knee near 0.85 |
| "Sky away from a low sun mint, olive or khaki" | B vs G | B > G by ≥ 5-8% | Exclude sky pixels (depth = far) from split-toning and any green WB push |

## 4. Shadows and AO

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Penumbra is a screen-door stipple" | high-pass std inside the penumbra band vs lit paving | ≤ 1.5× | 16-24 taps in the penumbra with early-out, per-frame rotation resolved by TAA, or a depth-aware blur of the shadow term |
| "Contact shadows 5× too soft" / "far building shadows too crisp" | edge ramp width on the receiver | penumbra ≈ 0.0093 × (receiver−blocker distance) m (the sun's 0.53°) | PCSS-style blocker search with probes reaching 25-80 m |
| "Tree shadows are solid blobs, no sun-flecks" | dappling in a sidewalk crop | mottled, many flecks | Keep leaf holes in the shadow pass: no mip-based alpha boost, clamp the lookup mip, coverage-preserving alpha mips |
| "Staircase/comb shadow on thin canvas, rope under sills, cascade seam patch" | close-up of valances and sills; hard rectangular patch | smooth edges | Receiver-plane bias, normal offset ≥ 3 texels for thin receivers, texel-snapped cascades, blend 10-15% at cascade borders |
| "Dirty halos under every block; joints drawn in ink" | count the occlusion layers | one per scale | Occlusion had been stacked 5 times (baked albedo cavity, material AO, micro-shadow, vertex AO, SSAO); keep albedo cavity ≤ 0.08 |
| "Shaded facades evenly lit; signs and sills float" | darkening within 10 cm under sills in shade | ≥ 25% (reference facade std 55-73) | SSAO radius 0.5-1 m plus a short contact term, weighted up where the sun shadow says shade |
| "Shadows are thin grey veils" | sun:shade on paving, linear | ≥ 3.4:1 open, ~10:1 under crowns | Cut sky/env light on the canyon floor 20-25%, lower floor bounce |
| "A second sun in every shop window" | small blown disc in glass | none | A fake bounce light was a directional light with specular; make bounce lights diffuse-only |

## 5. Haze, depth and the far field

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "The world ends; sky shows through the street at the vanishing point" | 5° view down a long straight | built mass closes every vista | A cheap far band (680-1400 m) of extruded boxes with averaged facade colour, or a hazy terminal card |
| "The street hardly climbs; the references show a rising ramp" | far road height in px | 10-25% of frame (≥ 120 px at 17°) | Put the start in a sag; 5-6% grade 120-380 m ahead |
| "Far facades milky beige" (midday) vs "no aerial perspective" (evening) | luma std of a 250-400 m block; window darkness | dry midday: std ≥ 40, windows < 60 sRGB; haze adds < 10% at 50 m, 25-35% at 500 m | Day extinction 1.1e-3→~0.4e-3 per m; keep the milky band in the sky only; remove a double-counted aureole and a 0.2 floor on sun visibility in the shaded canyon |
| "Vanishing point held by clean CG boxes; a sky mural reads as mirror glass" | 4× crop of the vanishing point | jumble of shutters, AC units, tanks, signs | Per-window states (shutters ~40%, AC ~30%), roof tanks, patched washes; towers ≤ 2-3 storeys above the street wall; no sky-coloured murals on axis |
| "Miniature look" | circle of confusion at 10-18 m | sharp by day | f/8 by day (hyperfocal ~10 m), f/4 only at dusk |
| "Softer than 1080p footage" | Laplacian metric | reference 0.10-0.20 | Mild luma unsharp mask (1 px, 0.3-0.45) after tone mapping; check anisotropy |
| "Lamp halos read as fog in dry air" | glow fills metres around globes | tight bloom | Airlight 2.5e-3→6e-4; let the bloom pyramid make the halo |

## 6. Materials and stone

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Ashlar is smooth stucco with lines drawn on it" | luminance CV inside one sunlit block; facade high-pass/mean at 20-60 m | CV ~0.13 (render 0.027); 0.20-0.28 (render 0.12-0.17) | Tooling 1-2 mm deep in the normal map, not albedo; per-block value ±12-20% with pink/ochre/grey outlier families on 15-25% |
| "Tooling: hairy scratches, embossed wallpaper, halftone hatch, pencil crosshatch" | 1 m close-up | parallel strokes, one direction per block | One angle per block ± 25°, strokes in groups, spacing 2-6 mm, albedo share ≤ 0.35-0.5, fade by ~4 m |
| "Rock-faced rustication: crumpled foil → cauliflower → foam pillows" | in-block CV (0.22-0.27 vs 0.53); joints blue-black in shade | hard facets, deep warm-grey joints | Parallax relief with self-shadow helped in sun only; still open. Needs facet planes tilted 8-15° with sharp breaks, a 6-10 mm margin break, and relief AO applied to sky light |
| "Weathering is camouflage blotches / airbrushing / rectangles that stop at material edges" | hue of the darkest 15% equals the brightest (value-only grime) | dark run-off under every sill, slab and console; darker base | Run-off seeded at sill ends, slab corners and console feet, stretched 1:8-1:15, 2-15 cm wide, 0.3-2 m long, warm brown-grey (≈ 0.42, 0.38, 0.33 × albedo), computed in continuous facade space; splash band 0-0.6 m |
| "Neighbouring lots one honey tone" / "egg-yolk lots" | per-lot tone in a telephoto crop | white, cream, pink, grey mixed; sat 0.22-0.34 | Widen the tint palette by value, not chroma; ±8% value per lot |
| "Putty beads / white half-moon chips / a ruled bright line on every bed joint" | close-up of arrises | sparse chips, recessed light joints | Chips one per 0.3-2 m, irregular, darker in AO; joints 4-8 mm, light grey-beige, recessed |
| "Detail fades to uniform beige beyond 40 m" | far facade block patchwork | course banding survives | Bake per-block tint into a small mipmapped cell texture instead of fading it out |
| "Barcode stripes on consoles, wood grain on stone" | stretched texture along sweeps | isotropic grain | Facade-metre or triplanar UVs on swept stone |
| "Factory-new street furniture; white paint chips like snow on modern shopfronts" | close-ups at 1-3 m | grime band 0-0.4 m, stickers, chips only on old timber | Shared wear pass on every prop; per-instance tint and lean |

## 7. Paving and rails

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Rails are chrome tubes; two bright lines per rail; white lines at telephoto" | px/mm of the bright band; rail vs paving luminance | bright band 20-30 mm, no brighter than sunlit paving except when looking into a low sun; in shade the band ≥ 1.1× adjacent setts | Band roughness 0.25-0.5 with lengthwise streaks, oxide shoulders (albedo 0.12-0.18, rough 0.7), specular occlusion except along the street axis. Flagged in every round; never fully solved |
| "Rails twice as wide" / "leopard aggregate beside rails" | strip width (was 70 mm per side) | thin lines with setts tight to the rail | Mortar strip 70→20-25 mm, close to the paving tone, no aggregate texture |
| "Groove orange, cork or leopard print" | groove albedo | near-black grime line (0.03-0.08) | ≤ 3% clustered grit |
| "Rails alias into dashed staircases" | grazing view at 10-40 m in motion | no crawl | Footprint-aware coverage (feature width / fwidth), specular AA from normal variance |
| Paving brightness and texture, in order: "near-white" → "too clean (std 7 vs 14-18)" → "checker mosaic" → "barcode glints" → "plank deck at 30-200 m" | sunlit paving mean; block std; mid-distance crop | 178-210, std 10-29, joint grid visible at 30-100 m | Albedo −30% and cooler; per-sett tone correlated (half per cell, half 1-3 m noise) at ±7%; fade per-sett variance to its mip-correct value, keep joints as box-filtered coverage (lighter dust lines far away); 1-5 m wear mottling 8-12% |
| "Gum spots are drilled holes; rust specks are measles" | identical crisp dark ellipses | irregular grey blotches clustered at stops and cafés | Lognormal 0.6-3 cm, warped outline, 0.55-0.8× sett albedo |
| "Zebra stripes pristine white / milky veil / camouflage holes" | stripe albedo and edges | worn grey-white, joints showing | Opaque paint at albedo 0.6-0.7, wear as flakes along joints and tread lines. Flagged 6 times; still pristine at the end |
| "No placement-driven grime"; "relaid patches look like decals" | near rails, tree grates, facade bases, under tables | darker bands where use concentrates; patches ≤ 5-10% tone shift | Grime by layout: 0.2-0.4 m brake-dust strip by rails, rings round grates, base band; continuous drip band between rails |

## 8. Glass and interiors

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Shop glass near-black at midday" | glass vs shaded stone, EV | 1.5-2.5 EV below shaded stone, carrying street reflections | Fresnel F0 0.04, roughness ≤ 0.05, never darken the specular path with the interior or AO term |
| "Reflections grey, blocky, pixel art; ghost people in the glass" | 2× crop of shop windows | sharp or softly blurred continuous image | Footprint-filter every reflected pattern, blur growing with distance; drop figures from fake reflections |
| "Daytime interiors glow white, brighter than the stone" | interior p90 vs adjacent sunlit facade p50 | interior ≤ 0.15 of sunlit facade radiance | Scale interior emission by a daylight factor; full only at night |
| "Interiors are empty voids, primitive white boxes, cloned grids" | 2-15 m shopfront views | stock in a 0.3-1.2 m front zone, ≤ 30% plain wall | Stocked shelves, mannequins, posters, sticker clutter. Partly open at the end |
| "Dusk interiors clip to cool white; evenly lit slabs" | glass pixels at tod 1 | R > G > B, R/B ≥ 1.4 (homes); walls 140-200 sRGB, only hotspots above 235 | Lower interior levels ~3×, 2700-3500 K, 3-4 ceiling-spot pools with falloff to ~40% at the sides |
| "Upper windows are black holes" | pane luma on the shaded side by day | 50-110, never under 35; open windows 25-50 | Fresnel reflection of the canyon env map, inner net curtains or blinds on ~60% |
| "Recessed doors are black voids; far windows flat dark rectangles" | the red-glass test: swap the glass material for flat red and look for missing red | every opening shows red | Glass sat behind an occluding back plate or in depth conflict; move glass forward, polygon offset |
| "Fake light pools are a film on the paving; people in them unlit" | hard unlit strips inside pools | light reaches everything in the pool | Depth-projected decal light, tinted with the room lamp colour |

## 9. Vegetation

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Fern fronds; spiky starburst crowns" | silhouette of an isolated tree | rounded, lumpy clusters | Clumped atlas cells (~55% fill), cards centred inside the hull |
| Crown brightness swung for 6 rounds: "pale lime cut-outs" ↔ "near-black masses" | sunlit crown median and std; shaded crown luma and p5; green-pixel mean | sunlit median 60-100, std ≥ 50, p5 ≤ 25; shaded 55-85, p5 10-20; mean ≈ (70-90, 85-105, 45-60) | Measure all of these every time. Lever by lever: shadow pass keeps leaf holes, soft self-shadow, interior AO floor ~0.5 on indirect only, crown-depth occlusion 0.15-0.25 at the core, a glossy sky-reflection lobe (F0 0.04, rough 0.35-0.45) so shaded leaves mirror the sky |
| "Crowns wall off the facades" | foliage share of frame; foliage luma vs frame mean | ≤ 18% (reference average ~12%); ≥ 0.6× frame mean | Thin cards 30-35% for a 25-35% gap fraction; few mature trees on the main view axis |
| "Visible clones" | neighbouring crowns | no two neighbours alike | Mirrored templates, non-uniform scale ±10%, lean 2-3°, reject the neighbour's template |
| "Leaf edges stair-step and crawl; far crowns milky; shimmer when frozen" | frozen-frame difference concentrated in crowns | grain only | Alpha-to-coverage with coverage-preserving mips; coverage mip from the minor axis |
| "Trunk reads as a timber post / crocodile bark / no flare" | 1-3 m crop | grey young bark with lenticels, root flare | +30-45% flare over the bottom 0.3 m, a different colour from stakes |
| "Neon leaves under street lamps"; "every tree bare after load" | dusk crop; capture right after ready on a busy machine | olive-yellow; always leafed | Cap point-light transmission at 8-10× sky irradiance; gate readiness on the leaf atlas |

## 10. Wires, ironwork and aliasing

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Railings break into barbed wire / stippled dotted chains" | moving 4-frame sequence at 20-35 m | stable lattice | Cards carry true coverage (box-filtered alpha mips, low alpha test); cross-fade LODs through alpha-to-coverage, not a screen-locked discard dither |
| "Octagonal rings; scrolls straightened into stick figures" | 20° close look at balconies 14-33 m away | smooth curves | Choose LOD by screen-space chord error (< 0.4 px), not by a fixed distance |
| "Far filigree drawn as heavy black pen strokes" | 100-300 m at 8° | grey haze, as in the photos | Minimum-pixel inflation must cut alpha by the same factor |
| "Wires go see-through with post-processing on; DOF and AO treat them as sky" | post on vs off A/B | identical opaque wires | Opaque wires with alpha-to-coverage and depth write |
| "Catenary built wrong (ladders of hangers)" | crop of spans vs a reference crop | short double droppers, registration arms | Check structure against the photos, not memory |
| "Moiré in blinds, flag weave, shelf patterns" | 11-50 m views | none | Box-filter every periodic pattern with fwidth; fade to the mean below 2-3 px |
| "Far detail crawls and sparkles at speed" | two frames 5 cm apart: % of far pixels changing > 16 levels (was 3-4%) | ≈ 0 | TAA: sub-pixel jitter, reprojection, YCoCg variance clip, reset on camera cuts |
| "Poles are black PVC pipe; pole pairs are mirror images" | pole shaft median sRGB | 55-80 grey-green satin | Brighter paint, roughness 0.5, rust on ~30% of bases by hash, side in the random key |

## 11. Density, repetition and street life

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Café terraces are gridded seas of identical chairs" | tables per terrace | 4-8 in one or two loose rows, cap ~10 | Jitter, skipped slots, 1 row 70% of the time |
| "Identical cream umbrellas form one continuous tent" | umbrella run in a telephoto | sizes 3-5 m, hem 2.2-2.7 m, colours and brand prints, ~20% closed, gaps | Per-café variation and printed valances |
| "Signs are game icons, generic trade words, tiny lettering, blank swatches" | fascia crops at 20-60 m | fictional proper names; lettering 45-60% of board height, 65-90% of width; 10-20% "loud" boards | Name generator (local language first); lettering enlarged 2.5× in the round where street life rose 6.5→7 |
| "Same SALE disc in 9 of 31 frames; posters repeat 12 m apart" | count repeats across frames | none within 80-150 m | ≥ 30 designs, hashed with a no-repeat window |
| "Street level is half as colourful as the references" | vivid non-foliage pixels in the street band (S > 0.45, V > 0.22, hue outside 60-170°) | reference median ~6% | Saturated awnings and fascias on ~40%, door displays; went 1.8-3.4% → 7-11% |
| "Pseudo-Latin word salad on boards" | read any text above 6 px | real generic vocabulary | Word lists of real local and English words |
| "Hung goods are paper cut-outs and rigid boxes" | 3-15 m crops | volume, overlap, sag | 1-4 cm thick shells, 10-14 per metre overlapping. Never fully solved |
| "Missing clutter types; nothing above the ground floor" | inventory the references | carts, utility cabinets, hoardings, upper banners | Add each type with obstacles registered for the crowd |

## 12. People, close and far

Telephoto crowds (30-300 m) read as photographic from early on. Figures inside 10-15 m stayed the main tell of every frame and never passed 6/10, despite a full rebuild on a character generator and eight people critiques with fixes.

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Garment-coloured ribbons and spikes shoot across the frame" (critical, every frame) | toggle figures off; spikes vanish | none | Skin weights lost part of their sum after a redistribution: renormalise, scan every LOD for sum ≠ 1, clamp the skinned offset, guard non-finite bone matrices |
| "Mannequins: dead-armed symmetric stance, claw hands, zombie forearm" | 4-6 m lineups | weight on one leg, relaxed curled fingers | ≥ 6 idle variants with weight shifts, desynchronised per figure; fingers flexed 15-45° |
| "Children have adult proportions and faces" | heads per stature | ~6.0-6.3 heads at 9-10 years (renders 7.1); bideltoid/stature men 0.26, women 0.235 | Continuous head ratio by height; child face morphs |
| "Clothes are shrink-wrapped shells; the same fold fan on every tee back; skirts are rigid bells" | backs at 3-10 m (the cab mostly sees backs) | drape, irregular folds, swinging hems | Fold normal maps seeded per character; skirts with flute folds and a hem spring lagging 80-150 ms. Still open |
| "Hair is a helmet, a curtain, or grey-silver from a strong specular" | hair luma vs the same figure's dark trousers | within 1.3× | Card hair with tapered alpha, dual-lobe highlight along the strand tangent, check mirrored-UV tangents |
| "Beards are balaclavas, knitted blocks, then grey smoke" | 1-3 m front and profile | soft dark volume | Stubble as an albedo decal; strands with alpha fade at the border |
| "Faces are flat beige ovals under a high sun; waxy; marker brows; glassy eyes" | 5-30 m faces | dark sockets, shine on forehead and nose | Baked cavity as directional occlusion on the sun term (0.35 sockets, 0.5 under nose and chin); oily lobe (rough ~0.35, F0 0.028); brows as 6-10 mm decals |
| "Bags are boxes; straps are hoses that float" | 2-4 m | soft bodies, flat webbing on the body | Webbing 3-4 cm wide, 3-5 mm off the surface |
| "Highlighter-yellow garments" | garment sat (0.96 vs ≤ 0.88 in refs) | ≤ ~0.8 | Smallest linear channel ≥ 0.12 of the largest |
| "People hover" then "a hard puck under a lifted foot" | shaded feet | thin dark line at the sole edge | Sole-sized contact decal (0.27 × 0.09 m, ≤ 0.35) fading with foot height 0.5-4 cm |
| "TAA smears walkers" | Laplacian variance moving vs frozen (461 vs 992) | equal to static scene | Per-pixel velocity from previous bone matrices |
| "LOD tears and blotches pop at 72 px" | force each LOD on a lineup | clean | Simplify per region and layer, lock seams, dilate texture islands 8 px |

## 13. Crowd behaviour

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "Bicycles and strollers 5-20× the references" | count props in the reference photos | here 0 riders in 6 of 7 photos, ~1 stroller per 80 people | Shares 5%/4.5% → 1.5%/0.8%; plain per-walker draw so first fill does not bunch props near the camera |
| "Strangers walk abreast in ranks, a group-photo line-up" | rank metric: ≥ 4 people within 1 m along the street, chained < 1.1 m sideways | < 10% of samples (was 42%) | Lateral wander, ±15% speed spread, 1.3 s headway behind slower walkers |
| "Most people walk alone at even spacing" | group share | 40-50% (pairs 30-35%, trios 10-12%) at 0.55-0.7 m | Group slots in V shapes, minimum 0.45 m between bodies |
| "Late clearing; strolling in the ride track without a glance; refuge between two passing trams; teleports" | nearest person in the swept path at 28 km/h; teleport counter | ≥ 22 m ahead; 0 teleports above 1 m | Per-agent clear time 3.5-6 s, time-window test against every tram, glance back, visible sidesteps |
| "The bell makes the whole street stare into the lens" | heads turned after a bell | only people near the track react | p 0.85 within 3.5 m of the track, 0.08 on sidewalks |
| "Café terraces empty near the camera" | seated / chairs by distance band | 50-70% occupied (was 7-9%) | Fill set tables within 150 m first; follow time of day |
| "Density halves beyond 150 m, where the telephoto looks" | people per 10 m by distance | flat out to ~400 m | Flatten the density curve; cheap far LOD |
| "Platform single file; side streets empty; standers vanish; figures pop at the far end" | platform spacing; side-street counts; standers over 80 s | clusters, 1-3 people per 10 m, 8-12% standing; spawn only where hidden | Cluster sampling, side-street spawns, a maintained stander target, hidden spawn tests |

## 14. Vehicles

The oncoming tram sits at the focal point of the default composition, so each fix exposed the next tell: "placeholder: black windscreen slab, beige side" → "clay model" → "chrome mirror repeating one walker five times" → "floats: lit paving under the skirt" → "lit box cab with a crisp mannequin driver; corrugated mirror sides".

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| Hovering vehicle | luma of the gap under the body vs paving | near-black (reference 102 vs paving 164) | Skirt 0.10-0.12 m above rail, near-black underframe, closed shadow hull, soft contact shade; moved shot 6.5→7 |
| Body reads as chrome or clay | crop at 2-5 m and 45 m next to a reference crop | satin silver, reflections only in glass | Base roughness ~0.3, clear coat ~0.5 at 0.04; blurred, confidence-weighted screen-space reflection |
| Windscreen black slab, then a lit box | windscreen vs body luma by day and dusk | sky and street dominate; driver a faint shape; dark at night | Fresnel-dominated glass (F0 ~0.2 for the rake), dark cab plastics, instrument-only light at night |
| No other vehicles at all | any frame | trams on the line (2-4 encounters per lap); parked cars in side-street mouths | Add them; then blobby close-range cars become the next tell |
| Sun through tram windows at full brightness | patches inside its shadow | 25-50% of sun, broken up | Partial transmission in the shadow hull |

## 15. Motion and camera

| CG tell | Detect | Target | Fix that moved it |
|---|---|---|---|
| "A chase camera swinging into bends"; the user: "it looks like it sits between the rail pairs" | screen x of the ride-track centre at frame bottom, swept along the route | track locked under the frame centre | Camera fixed to the cab body, no gaze panning, axis from the front bogie |
| "Gimbal-stabilised, pixel-locked" | high-passed pitch/yaw in px RMS at the default lens | pitch 0.9-1.3 px, yaw 0.6-0.8 px at 17°; angular, not translational | Speed-scaled multi-octave vibration |
| "Joint knocks invisible, periodic, or out of sync with the sound" | knock positions in a recording vs audio events | knocks in axle pairs (1.8 m apart), frog 4-8 px decaying in ~0.25 s, 85-90% welds silent | One shared track-feature list for camera and audio |
| "Sway is a pure 1.5 Hz sine: a camera on a spring" | yaw spectrum | broadband 0.6-2.5 Hz | Band-limited noise driven by distance travelled |
| "Soft suspension": 24-25 px dive under braking | pitch per m/s² | 0.2-0.25° per m/s² (about 9-11 px) | Halve the gain, keep one spring-back overshoot at the stop |
| "Razor sharp" then "near trees and people smeared" | streak px on near poles | 1/160 s by day, 1/50 s at dusk | Light-dependent shutter; per-object velocity for trams and walkers |
| Speed reads staged | km/h through crowds and tight curves | walking-plus pace in a busy mall; R58 at ~20 km/h | Speed scaled by corridor load; lateral limit 0.55-0.6 m/s² below R100 |
| Streaming pop-in | per-tile frame-difference spikes in the vanishing-point region | spikes only from walkers | Byte-capped staged reveal, prefetch ahead |
| Lens choice in bends (user decision) | % of a tight bend with the track 30 m ahead in frame | report: 17° 35%, 24° and 30° 100% | Measure and hand the trade-off to the user; do not change the lens unasked |
| Eye too high; platform never in frame at a stop | solve camera height from two walkers' head and foot rows | reference camera ~1.85 m (render 2.9 m) | Report as decisions; move the stop mark 10-12 m short of the platform end |

## 16. Time-of-day variants

| Time | Checks and targets |
|---|---|
| Midday | Section 1-2 envelope; open shade blue-grey not lavender; sky slot brightest; crisp far facades |
| Golden hour | Sun must reach the street: at 10° elevation and 25° off-axis a 17 m street wall shadows 41 m across a 24 m street, so the default view had no sunlight at all; rotate the street azimuth so the sun is 9-11° off axis. Lit stone R/B 1.6-2.0 cream-gold, shaded paving 165-190 with R/B 1.10-1.15 and G/mRB 1.03-1.07, p2 12-25, sky blown cream, long people shadows. Backlit and front-lit frames were the most photographic of the project |
| Sunset | Lamps on from tod ~0.72; globes brighter than the sky behind them (≥ 230; radiance was 6-8× too low); slot gradient 25+ levels, horizon hue 30-40° |
| Blue hour | Sky-lit surfaces blue-grey (hue 215-230, R/B 0.7-0.85); lamp pools hue 30-45 at ≥ 1.8× the paving between them (≥ 1.3× at sunset); upper floors ≥ 1 stop below the lamp-lit ground floor; no even lilac ambient; facades above 8 m not warm |
| Night | p2 ≤ 8, black 3-10%; 25-45% of upper windows lit at 2700-4000 K; globes with a hot core and warm body, hood silhouette readable, halo to 2-3× globe radius; discrete pools (spot ~0.95 rad, penumbra 0.4), lamps out of tree crowns; dipped headlight (cut-off above ~1 m, ~4300 K) |
| Haze regime | p2 ≤ 30, Hasler ≥ 26, sat ≥ 0.18; bright cream sky, not grey overcast under hard sun |

In the final blind comparison the previous build still won both dusk views and golden hour: keep a frozen "best so far" capture of each time of day and compare every change against it.

## 17. Robustness tells to automate

Several "critical" visual findings were bugs, visible in every frame. Automate these so critics never spend a round on them:

- **Non-finite pixels.** A zero normal at an awning's dome pole became NaN, then black dashes (RGB 9, 9, 7) on hazy facades 250-490 m away, 8-32 clusters per frame. Wires seen end-on produced ~1000 per frame. Count non-finite and negative pixels in a debug pass (target ≤ 3), sanitise in post, but fix at the source.
- **Geometry thrown across the frame** (skin weights, IK targets): clamp and assert in debug; toggle modules off to isolate.
- **Floating or sunk people** (the user caught a regression): a height probe at all standard views after any change near positions or start-up order.
- **Hero objects regressing** (the user caught a broken tram front): A/B crops of hero objects every round.
- **Capture hygiene:** no loading overlay in frames, no captures before every async asset (leaf atlas, baked materials) is ready, serial captures on a quiet machine, no orphaned headless browsers (one held the GPU at 97% for an hour and corrupted every timing).
- **Depth precision:** prints 0.5 mm off their panel z-fight from 50 m (24-bit depth, near plane 0.3 m); offset ≥ 3 mm or use polygon offset.
- **Interpenetration counters:** 109 of 452 umbrellas overlapped after a dodge pass; chairs through umbrella bases; sitters through armrests; furniture sunk into a raised sidewalk. Count overlaps at init and warn.

## 18. Score trajectory: what moved, what never did, what oscillated

| Stage | Panel (score 1-10, 10 = indistinguishable from the photos) |
|---|---|
| Per-module critiques, modules in isolation | 4-5 everywhere (people 4, trees 4, ironwork 4, furniture 4, facades 4, ride 4, audio 4; buildings, crowd, materials, sky/light, street, catenary 5) |
| First full-app photo review | 5.5 |
| Four-lens loop, rounds 1-3 (light / surfaces / people / shot) | 5, 6, 3.5, 5 → 6, 6, 5.5, 6 → 6, 6.5, 6, 6.5 (means 4.9 → 5.9 → 6.25) |
| People rebuilt on a character generator, 2 rounds | 5, 5 |
| Five lenses with close-ups and recorded motion (stricter panel) | 6.1 → 6.3 |
| Final round | light 6.5, surfaces 6, shot 7, people 6, street life 7 (mean 6.5); blind A/B 20-13 with 3 ties |

**What moved scores from 3.5-5 to 6+:**
- Removing bugs that marked every frame: figure spikes, NaN specks, the world ending at 680 m, the placeholder tram, missing TAA.
- Tone driven by the reference histogram envelope: light reached 6 in round 2 and held 6-6.5 once every round measured p2, p50, p98, clip and Hasler against the photos.
- Composition and motion measured in pixels: street climb, far backdrop, fixed cab mount, joint knocks, shutter.
- Crowd composition counted from the photos (prop shares, groups, ranks, terrace occupancy).
- Street-life density and colour by metric: proper sign names, vivid-pixel share, varied umbrellas, flags and flowers (6 → 7).
- Grounding the oncoming tram (shot 6.5 → 7).

**What never moved (open after 6+ rounds):** people within 10-15 m (clothing shells, hair, faces, bags); rails reading as chrome; rock-faced rustication; pristine zebras; shop interiors and hung goods; the oncoming tram's cab and glazing; dusk lamp pools; shaded crowns. Each needs a new technique (cloth simulation, strand hair, faceted relief, real interiors), not more parameter tuning. Spot these by round 2 and plan them as build work.

**What oscillated (ping-pong):**
- Exposure: golden hour −1.15 EV, then day +1.2 EV, then day −0.75 to −1 EV.
- Foliage: pale lime → 1-1.5 EV too dark → flat lime → near-black → evenly lit lime → shaded crowns crushed.
- Shade colour: too blue → too warm and bright → too blue.
- Stone: grey-cream → honey (R/B 1.7, from graded photos) → egg-yolk.
- Haze: too weak → milky. Flower boxes: on every balcony → rare. Motion blur: none → 1/50 s smear → 1/160 s.

Causes: single-number targets, one-sided fixes, a different critic each round reading different reference photos, and fixes judged by the next panel instead of re-measured by the fixer. Countermeasures: two-sided ranges from the reference median, two metrics per property (level and contrast, for example crown median and p5), A/B toggles, a "strengths" list the fixers must not break, and the previous round's numbers in every new brief.

Fresh panels also got stricter (close-ups, recorded clips), so absolute scores understate progress. Use them to rank issues, and use the blind A/B (section 20) to accept or reject a build.

## 19. Writing critic prompts

- **Lenses:** 4-5 that do not overlap. The final set was light/tone/atmosphere; surfaces/geometry; shot/motion; people/crowd; street life/dressing. Each lens text lists its sub-aspects and the distances to check (2-6 m, 10-30 m, telephoto) and names the known issues, so the critic confirms them rather than rediscovers them.
- **Stance:** "a ruthless photorealism critic for a blind comparison between renders and real photographs". Ask it to name what gives each frame away as computer graphics.
- **Evidence over opinion:** at least 16 fresh captures: the fixed standard views plus close inspection views, recordings for motion, and crops. Put the reference envelope (section 0) in the brief, so findings arrive as numbers next to reference numbers.
- **Output contract:** a score, a summary, a strengths list (what the fixers must not break), and at most 14 issues ranked by cost in a blind comparison. Each issue has a severity, exactly one owner from the module ownership map, a title, evidence (paths, view params, crop boxes, measurements, which reference shows the truth) and a concrete fix with acceptance ranges.
- **Boundaries:** read-only (critics may read code, and one found the skin-weight root cause by reading it); a time limit on every capture; leave no browser running; "note but do not judge" for decisions that belong to the user (lens, eye height).
- **Pipeline after critique:** one fixer per owner, given its issues by severity plus leftovers from the last round, each re-verifying with before/after captures next to the references → one serial QA pass (one capture at a time, machine load reported) whose regressions go back to owners → a fresh panel re-scores.

```js
const ISSUE = { severity: ['critical','major','minor'], owner: OWNER_KEYS, title: '',
  evidence: 'paths, params, crops, measurements, and which reference shows how it should look',
  fix: 'concrete direction with two-sided acceptance numbers' }
const CRIT = { lens: '', score: '1-10 (10 = indistinguishable)', summary: '', strengths: [], issues: '≤ 14, ranked by blind-test cost', screenshots: [] }
```

Watch-outs: critics' proposed numbers can overshoot (the +1.2 EV exposure fix), so the fixer must re-measure against the range. A loaded machine corrupts timings and even frames (loading veils in captures). Owners read GPU back-pressure stalls as real stalls unless timing runs are frame-capped.

## 20. Blind A/B acceptance

Use this to decide whether a round made things better. Each panel's scores are too noisy to decide on their own.

1. **Declare the rule first:** accept the new build if it wins the blind votes and the re-score does not drop; otherwise revert with a new commit (never rewrite history).
2. **Export both builds** (`git archive` at each commit); each runs its own tools from its own folder.
3. **Identical views:** 12 fixed views (the 8 standard views plus the oncoming tram, people at a stop at 40°, a facade close-up and a wide dusk view), frozen, same params, 1920×1080, rendered one at a time on a quiet machine. Check ready, 0 console errors, no overlay.
4. **Neutral sheets:** two halves 1600 px wide with an 8 px gap, labelled only "L" and "R". The side is shuffled per view and kept only in the orchestrating script. Delete raw renders and logs.
5. **Three independent judges**, each studying the reference photos first, each weighting a different lens: overall realism; light, colour and materials first; people, motion and street life first. Per view each returns L, R or tie, a margin (clear, slight, none) and a one-sentence reason. They may not open other files.
6. **Tally in the script:** votes, clear wins, per-view majority. The worked example gave 20-13 with 3 ties, and 7-4-1 by view. Two judges leaned one way and the people-weighted judge leaned the other, which shows why one judge is not enough.
7. **Keep the losses:** the views the old build won (dusk mood, golden-hour warmth, near crowns going black) became the top of the remaining-work list.

Pitfall: hold procedural content identical between builds. In two views the sign artwork and the seated figures differed, so judges compared content as well as rendering. Fix the seed and the content generators, or exclude such views.

Deeper reading in the worked example: `docs/PLAN.md` (score history and the remaining-work list), `.work/m46/env/metrics.py` (tone metrics), `tools/shoot.py` and `tools/record.py` (stills with `view=`, `freeze=`, `skip=`, `debug=1`; fixed-step clips), `reference/` (the 7 photos), and `.work/` critique captures by round (`.work/shots/m4_r*`, `.work/m47/crit_*`, `.work/m48/crit_*`).
