# Lighting, sky, atmosphere, camera tone and post-processing

How to make a real-time frame read as a photograph and not as computer graphics. The worked example is a tram cab ride down a limestone street (three.js r186, `src/env/` in `/home/vlad/dev/reps/3DSceneRenderer`: `env.js`, `post.js`, `postShaders.js`, `sky.js`, `clouds.js`, `atmosphere.js`, `lights.js`, `sunShadow.js`, `shadowBatch.js`, `sunPath.js`). Its lighting critiques scored 5 (first build), then 5 → 6 → 6 over three photoreal rounds, then 6 → 6.5 → 6.5 out of 10. Golden hour and dusk never fully matched the photos, and a blind A/B preferred an *earlier* build for both (see section 17). Treat the values below as tested starting points, not as finished answers.

## Contents
1. The tells critics caught · 2. Ground rules · 3. HDR pipeline order · 4. Measuring against the photos · 5. Exposure · 6. Tone curve and colour rendering · 7. White balance · 8. Sky and atmosphere · 9. Clouds · 10. Sun · 11. Shadows · 12. Ambient: environment map, bounce, AO · 13. Aerial perspective · 14. Dusk and night · 15. Camera: AA, DOF, motion blur, sharpening · 16. Time of day without hitches · 17. What never reached the target · 18. Checklist

## 1. The tells critics caught
Every one of these was flagged in a real critique. They are what to look for in your own frames.
- **Milky blacks.** Shade and dark clothes sit at sRGB 30-50 (p2 luma 30-53) where the photos go to 3-40 (median 13). AgX's own toe, lens veil and over-exposure all cause it.
- **Crushed blacks.** A steep toe (−3 EV → sRGB 8) leaves 15-28 % of a golden-hour frame at black. The photos have 0.1-5 %.
- **The tone-mapped HDR look.** The sky is held at 189-214, nothing clips (0.01 % against a median of 1.35 % in the photos), and the colours go flat. Cameras let the sky and white shirts clip.
- **Mid-tones off by 0.5-1.2 EV.** This happened in both directions over six rounds (section 5).
- **Colour casts.** Olive sunset, mauve twilight paving, khaki or mint skies, pink lamp pools, egg-yolk or mustard stone, warm midday paving (section 7).
- **Wrong shade.** Shade too bright and yellow (−1.8 EV under the sun where the photos show −3.3 EV), or too blue and saturated.
- **Sky.** Saturated blue all the way down to the horizon, where every photo has a pale haze (HSV saturation 0.02-0.12). Cotton-ball cumulus, cirrus like water ripples or smoke rings, clouds tinted blue.
- **Lights.** Lamp pools that don't show, globes dimmer than the sunset sky, two halos per lamp, foggy halos, a floodlight headlight, shop interiors brighter than sunlit stone at noon.
- **Camera.** A miniature look from shallow DOF, smeared motion blur, an image softer than footage (detail 0.06 against 0.10-0.20), penumbrae that crawl in motion.

## 2. Ground rules
- **Fix physical units on day one** and publish them, so every module's emissives agree. Here 1.0 = 33,000 lux (or cd/m²). Midday sun ≈ 3-3.9; sunlit limestone 0.3-0.5; blue sky 0.2-0.4; lit shop window 0.01-0.03; lantern globe ≈ 0.1 (3,600 cd/m²; real opal glass is 2,000-8,000). Without this, the globes shipped at 80 cd/m² and were dimmer than the sunset sky.
- **Model a camera, not a grade.** Exposure follows the incident light, then a meter, a JPEG-like tone curve, a white-balance preset, lens veil and in-camera sharpening. Each knob then maps to something a photo shows, and critics can point at a cause.
- **Measure every change against the photos** (section 4). Eyeballing let the exposure swing ±1.2 EV between rounds.
- **One lever per symptom.** Blacks belong to the toe and deep-shadow term, not to underexposure. The mean belongs to exposure. Shade depth belongs to the ambient and bounce levels. Shade colour belongs to the white-balance strategy plus the bounce colour. Using one knob for two symptoms always regressed the other.
- **Make everything a function of time of day:** small tables `[[t, value], …]` with smoothstep interpolation, or log interpolation for exposure-like values. Constants that suit midday break golden hour.
- **Don't grade over another module's bug.** Stone too yellow is an albedo fix. Missing blacks may mean dark clothing albedo is above ~0.04 linear. Neon leaves need a cap on leaf translucency. Send these as requests to the owning module.

## 3. HDR pipeline order
```
scene → HalfFloat target, 4x MSAA, sub-pixel jitter in the PROJECTION only
SSAO (half res) → volumetric clouds (half res, sky pixels only)
prepass: clouds over sky, AO, lantern pools/wash, aerial perspective, sun glare, lamp airlight,
         heat shimmer, circle of confusion; non-finite/negative pixels filled; one-scale clamp
TAA → DOF gather → motion blur → bloom pyramid → metered exposure (log-average)
final: CA, luma sharpening, bloom/tail mix, veil, exposure, local highlight recovery,
       vignette, WB (separate street/sky gains), split tone, highlight recovery,
       sky treatment, AgX hue + camera curve, gamut knee, vibrance, sat ceiling, sRGB, grain
```
- Jitter only the projection. Shadow cascades are fitted from the unjittered matrices; jittering them makes the shadows shimmer.
- **Clean bad pixels before anything spreads them.** One NaN or negative pixel turns into a black hole through TAA, DOF and bloom. The prepass tests finite values by bit pattern (compilers can fold `isnan` away) and fills from the 4 neighbours. The clamp must be **one scale for all channels** (64 after exposure): a per-channel clamp turns a warm specular spark neutral, and highlight recovery then shows it as a cyan fleck. Keep a debug counter (`debug=1` → `stats().badPixels`) and fix sources upstream. Most were MSAA extrapolating vertex varyings; declaring them `centroid` fixed them.
- Apply WB in scene-linear before the curve, with separate gains for sky pixels (section 7). Apply sharpening to HDR luma in log space so it doesn't depend on exposure. Add grain last.
- Cost in the example: the whole post chain takes 0.7-1.2 ms by day on an RTX 4060 Ti at 1080p (TAA 0.2, final pass 0.15), and about 3 ms at dusk with the lamp airlight. Post was never the bottleneck; the scene and shadow passes were.

## 4. Measuring against the photos
Downscale every image the same way, then compare one envelope across all the reference photos. The worked example's script is `.work/m46/env/metrics.py`:
```python
a = np.asarray(Image.open(p).convert('RGB').resize((1000, h), Image.LANCZOS)).astype(float)
R,G,B = a[...,0],a[...,1],a[...,2]; Y = .2126*R+.7152*G+.0722*B; mx,mn = a.max(-1),a.min(-1)
clip = (mx >= 250).mean()*100                              # % pixels with a clipped channel
rg, yb = R-G, .5*(R+G)-B                                   # Hasler-Suesstrunk colourfulness
hasler = np.hypot(rg.std(), yb.std()) + .3*np.hypot(rg.mean(), yb.mean())
sat = np.where(mx > 0, (mx-mn)/np.maximum(mx, 1e-6), 0).mean()   # mean HSV saturation
p2, p50, p98 = np.percentile(Y, [2, 50, 98]); rb = R.mean()/B.mean()
```
Reference envelope from the 7 photos (sunny Mediterranean street, mostly long lens):

| Measure | Photos | Notes |
|---|---|---|
| p2 luma | 3-40, median 13 | darkest 2 %: hair, dark clothes, recesses |
| clipped % | 0.05-11.6, median 1.35 | mostly the sky's blue channel and sunlit whites |
| mean Y′ / p50 (sunny) | 110-144 / 115-169 | p98 203-249, p99 241-252 |
| Hasler / HSV sat | 28-60 / 0.22-0.52 | pixels over 0.85 sat 0.8-8 % (median 2.6); crushed channel 0.01-0.75 % |
| sunlit grey paving | sRGB 178-210, R/B 0.88-0.97 | joints still visible (std 10-29) |
| shaded paving | R/B 0.91-0.95, sat 0.05-0.09 | sun:shade ≈ 3.4:1 linear in the open, up to 10:1 under crowns |
| shaded limestone | sat 0.04-0.24, R/B 1.05-1.30 | sunlit stone ≤ 0.35 sat |
| sky below 10° / at 45° | sat 0.02-0.12 / (95-130, 145-180, 220-250) | fair-weather cloud sat < 0.05 |
| image detail | mean abs Laplacian at 640 px 0.10-0.20 | renders started at 0.06 |

- **Measure regions as well as whole frames.** Take box means, R/B, G / mean(R,B) (below 0.97 reads mauve, above 1.03 olive), hue and saturation of the shaded paving, the lit and shaded stone, the sky slot, the crowns and the lamp pools. Compare the same kind of region in a photo with similar framing.
- **Attribute before fixing.** Re-shoot with a single toggle: `veil`, `bloom`, haze in-scatter, `lhr=0` (local highlight recovery), `skysat=0`, headlight off, SSAO off, `ppl=0`, or lamps on/off. Several "lens" theories died this way. For example, bloom and veil moved p2 by at most 2 levels, so the real cause was exposure.
- To find directly sunlit pixels, diff the frame with the sun on and off. To tune a curve without reloading the app, dump the HDR buffer and replay a Python copy of the final pass offline; it matched the screenshots to within 0.001.
- **Use fixed standard views** (8 here: default, s=700 tod 0.1, s=1450 tod 0.55, …) at cold start, plus side-by-side contact sheets of render and photo. Expect p2 to move ±4 between runs as people walk through the frame, so judge medians over several runs.

## 5. Exposure
**Anchor it to the incident light, sunny-16 style, then apply a lift and a weak meter.**
```js
// Eh: sun * max(sunDir.y,0) + sky irradiance on a horizontal surface (scene units)
lnE = ln(KDAY*PI / max(Eh, EH_FULL))                   // a 0.18 albedo exposed to 0.18*KDAY
    + 0.7*ln(EH_FULL / clamp(Eh, 0.03, EH_FULL))       // partial adaptation: dusk stays darker
    + 0.5*ln(0.03 / min(Eh, 0.03));                    // even less below ~1000 lux
exposureBase = exp(lnE) * 2**EXPO_LIFT(t);             // KDAY 1.3, EH_FULL 1.9
```
- **EXPO_LIFT** (EV, by t) = `[[0,.72],[.3,.72],[.45,.85],[.55,.7],[.65,.5],[.78,0]]`. A photographer exposes a sunny street for the shade and the people, so whites and glints clip. After sunset the lift is 0 and the caps take over.
- **Meter:** a log-average of the HDR frame, weighted to the centre and lower half (`w = 1 − 1.6|q|² + 0.25·lowerHalf`), pulled towards a target with `corr = clamp((target/metered)^k, lo, hi)`. By day k = 0.3, clamp [0.75, 1.6], target 0.25. From t 0.35-0.6 it becomes k = 0.6, clamp [0.5, 4], target 0.32. Looking into a low sun multiplies the target by 0.85. An earlier factor of 0.6 made golden hour 1-1.3 stops too dark.
- **Caps go on the final metered exposure, not the base:** `expo = min(base*corr, exposureMax)`. When the cap sat on the base, the meter's ×3.4 push at sunset clipped the sky to (254,254,254). `exposureMax` is the minimum of three caps:
  - A **lit-stone cap** (from t 0.35) keeps sun-facing stone on the shoulder (exposed value 1.5) but lerps only half-way in log terms. Applied in full at 0.8, it underexposed golden hour by 1.15 EV (mean Y′ 62-77 against 128-142).
  - A **horizon cap** holds the sky slot at the end of the street to `HORIZON_LEVEL(t)`, weighted by view direction: `[[.1,64],[.25,24],[.45,60],[.62,52],[.8,9],[1,4.5]]`, where 64 means no cap.
  - A **view-independent dusk ceiling** of 1.8× nominal for t 0.72-0.82, 4.2× by the blue hour. Without it the anti-sun view at sunset opened up to an overcast-noon look (mean Y′ 93 against 63).

**The exposure saga.** Learn from it: every overshoot came from moving one knob to fix two symptoms.

| Round | Measured | Change | Result |
|---|---|---|---|
| Integration review | day p50 0.33-0.40 vs 0.45-0.65; p1 0.07 (AgX toe); ~0.6 EV under | camera curve with a black point; meter target 0.16 → 0.34 | p1 0.031, p50 0.49, p99 0.93 |
| Photoreal r1 | toe −3 EV → 8, black% 15-28; golden 1.15 EV under; sunset sky white | refit curve; lit-stone cap half-way; caps on the final exposure; veil | golden mean 77 → 123 |
| r2 | day **+1.24 EV hot**: p2 30-38, p90/p10 3.5-4 EV, granite 182-191 vs 122-137 | anchor to incident light, meter 0.3 by day | granite 135-137, p2 14-18 (overshot, see next row) |
| r3 | day **0.75 EV under**: mean 83-90, p98 158-187 vs 203-249 | EXPO_LIFT +0.84 EV, highlight knee table, soft black point | mean 118-126, p98 208-220 |
| QA | blacks lifted again (p2 33-51) by a softer toe added for shop-glass detail; near paving washed out | deep-shadow term; lift 0.84 → 0.40 | p2 ≤ 25 |
| regression | midday lost its clipped whites and colour | lift 0.55; gamut knee 0.84 by day | clip 1.6 %, Hasler 32 |
| last round | sun:shade only 3.2:1 | lift 0.72; image light 1.25 → 1.05; floor bounce 0.08 | 3.8:1, p2 8.9 |
| final critic | mid-tones 0.4-0.5 EV dark (p50 92-102) while wide sunlit paving burns flat at 215-225 | not done | open: the curve is too steep between mid grey and the shoulder |

## 6. Tone curve and colour rendering
**Split luminance from hue.** A camera-JPEG curve sets the luminance. AgX supplies only hue and chroma: blend AgX's chroma towards the scene's own ratios, 0.7 by day and 0.9 at low sun (sky pixels 0.95), then rescale the pixel to the curve's luminance. AgX alone left sunlit stone and the sky grey (scene 1.0 → sRGB ~197) and greyed saturated blue.
```glsl
float e = log2(Y / 0.18);                                         // stops from mid grey
e += (slope - 1.) * .5 * softplus((e - pivot) / .5);              // midday contrast 1.12 above pivot 0.3 only
e += toe.x * toe.z * softplus((toe.y - e) / toe.z);              // toe [0.22, 0.06, 0.5]: long camera toe
e -= deep.x * deep.z * softplus((deep.y - e) / deep.z);          // deep [1.6 day..0.3 dusk, -1.8 (-1.5 golden), 0.5]
float d = min(1., A / pow(1. + exp(-s * (e - e0)), q));          // A,s,e0,q = 1.1738, .6941, .8164, .8985
d = (d - b + b*exp(-d/b)) / (1. - b + b*exp(-1./b));             // soft black point b: .043 day, .018 dusk
```
- With the deep-shadow slope at 0.95, the daytime curve maps −1 stop → sRGB ~77, −2 → 43, −3 → 17, −4 → 5, mid grey → ~120 (0.47), +2 → 216, white at about +3.2-3.5 stops. The midday slope was later raised to 1.6, which pulls the deepest stops a little lower. Fit the curve to anchor points with `scipy.optimize.minimize` (`.work/m46/env/curvefit.py`) instead of hand-tuning.
- **History of the toe.** It started too steep (crushed). The refit lifted it (milky, p2 30-50). Then came a softplus toe, then the **deep-shadow term**: below about −1.8 stops the slope rises again, so dark clothes fall towards black while shade and dark shop glass keep detail. Dark-pixel maps showed the p2 pixels at −2.6 stops, which is why the term is centred there and not at −3.5.
- **Highlight recovery, global:** soft-knee log compression of luminance above a knee of +1.6 stops by day, +1.2 at golden hour and +1.0 at sunset. The slope is `[[.15,1],[.3,.5],[.55,.66],[.8,.5],[1,.6]]` (1 = off). This lets the sky over a shaded street keep its colour.
- **Highlight recovery, local:** a 1/8-resolution map of surface log-luminance (sky excluded, so the skyline gets no dark rim), blurred. Where the surroundings are more than 2.5 stops over mid grey, bright pixels come down by the excess. That way a backlit sheen on the paving comes down (10 % clipped → 0.9 %) while a small glint and the sky still clip. Apply it as **one RGB scale in scene-linear before the gamut knee**; otherwise glints turn into grey-cyan tiles. Fade it out over t 0.8-0.9.
- **Gamut knee.** By day the brightest channel may reach 1.0 (start 0.84), as in a camera JPEG. From t 0.55 it starts at 0.78, and after sunset the ceiling drops to 0.8/0.94 (street) and 0.72/0.86 (saturated sky), so the amber lamps and the afterglow bands keep their hue.
- **Vibrance, not saturation.** A global ×1.3 pushed shaded limestone to ochre (HSV sat 0.46-0.60). Scale the boost by `(1 − s)` and by `(1 − s)²` for orange hues (15-50°: skin and stone). Ease it to 0.6 in the highlights so sunlit stone rolls off to cream. Add a soft ceiling on display saturation that starts at 0.72 and approaches 0.92 (0.8 in deep shadow). The ceiling then overshot: nothing vivid reached the gamut edge (0.25-0.93 % of pixels over 0.85 sat against a median of 2.6 %). Golden hour fell to Hasler 23.9 and needed its own look: +0.25 saturation, vibrance reaching mid-saturated colours, ceiling [0.66, 0.86], none when backlit.
- **Lens veil.** Add `0.006 × frame mean HDR colour` everywhere, plus `0.0012 × sun × exp(−angle/0.25 rad)` while the camera stands in sun. This lifted backlit blacks from p2 1.9 to 32. The first sun term (0.004, falloff 0.5) made the golden telephoto milky (p10 91).

## 7. White balance
Use two axes, warm-cool (log R/B) and green-magenta (G against √(R·B)). The strategy changes with the light:

| t (light) | Balance on | Warm-cool share corrected | Notes |
|---|---|---|---|
| 0-0.3 (midday, afternoon) | direct sun only (a "daylight" preset) | 0.3 | sunlit grey paving neutral, sky-lit shade stays blue; shadow split tone −0.03 (cool) |
| 0.3-0.6 (golden) | blend to sun + sky; neutral weighted 0.9 towards the open-sky light | 0.25 | neutral green 1.02-1.04 so the shade isn't pink; warm shadow split tone +0.07; +5 % warm on highlights (street only) |
| 0.78+ (sunset) | none: a daylight-balanced camera | 0 | blue gain held up (≥ ~0.9 × red from t 0.72); green cap widens to 1.18-1.2 (the twilight sky is short of green from ozone) |
| 0.82-1 (blue hour) | cool shift to 0.3 at t 1 | 0 | green gain ≤ 1.38 × red, so pools stay amber; the warmth comes from the lamps |

- Keep gains on the daylight locus: green within [0.99, 1.03] × √(gR·gB) by day, and a neutral surface under the illuminant at G / mean(R,B) in [0.97, 1.0]. Normalise the gains to unit luminance.
- **Give sky pixels (depth = far) their own WB:** balanced on the illuminant, with no shade weighting and no green lift. They also skip the split toning. Otherwise the anti-solar sky turns mint or khaki.
- Counter-intuitive: lowering the shade weight at golden hour made the shade *bluer*. A warm shadow split tone was what made it warm-neutral.

| Cast | Cause | Fix |
|---|---|---|
| olive, murky sunset | a +5-6 % green WB term (gains 0.863/1.061/0.798) | no green push; daylight-locus clamp |
| mauve twilight paving | green term removed, ozone-short twilight light, red bounce | neutral G/mean(R,B) guard; green cap 1.12-1.2 after sunset |
| khaki sky, olive stone | green gain above both R and B (G/avg 1.13); ozone red absorption raised to 2.3e-3 | clamp; ozone red 1.75e-3; separate sky WB |
| mint golden sky | warm highlight tint applied to sky pixels | exclude the sky from split toning |
| pink pools, mauve dusk | pink-amber lamp colour + violet sky | 3300 K blackbody lamp (1.13, 0.611, 0.244); cool shift |
| brown/magenta shade | the environment map's canyon bounce assumed the whole opposite facade was sunlit | gate the bounce by the facade's sunlit fraction |
| warm midday paving (R/B 1.06-1.11 vs 0.88-0.94) | ~4700 K sun plus a warm WB constant plus warm paving albedo | sun-only daylight WB; granite albedo (0.17, 0.175, 0.185) |
| egg-yolk / mustard stone (sat 0.40-0.54) | yellow albedo (0.6, 0.47, 0.27) squared by wall-to-wall bounce, plus saturation | vibrance with orange protection; cross bounce half-neutral; albedo B/R ~0.69 (a materials fix, still open) |
| blue saturated open shade at the end (sat 0.18-0.22 vs 0.05-0.09) | the sun-only balance leaves the sky's full cast | open; suggested a correction share of 0.4 and a +0.02 shadow split tone |

## 8. Sky and atmosphere
- Use a physically based sky with LUTs (transmittance, multiple scattering, sky-view, after Hillaire 2020), rendered on the GPU and shared by the sky dome, clouds, environment map and aerial perspective. A CPU copy of the transmittance gives the sun its colour.
- **Aerosol** for a dusty summer city: load 32× the clean atmosphere, scale height 0.9 km, nearly non-absorbing (single-scattering albedo 0.975/0.965/0.95, so it adds light rather than greying), Mie g 0.66, Ångström exponent 0.6 (extinction ≈ 0.93/1.0/1.11 over R/G/B). Add a shallow city-haze layer at 2× density with a 0.5 km scale height: rays low over the horizon run kilometres through it, so the low band goes pale and milky while the zenith stays blue. Changing aerosol alone barely moved the zenith (a physical limit); most of that gain came from exposure plus post's sky treatment.
- **Ozone (Chappuis band)** decides whether the twilight sky reads blue-and-pink or khaki. Red absorption went 1.45e-3 → 2.3e-3 (that fixed mauve but caused khaki) → **1.75e-3/km**, with green 1.88e-3.
- **Sky treatment in the final pass**, on depth = far pixels only:
  - Keep chroma at 0.95 (AgX's inset/outset matrices grey a saturated blue).
  - Apply a blue-sky saturation boost of 1.8 by day, 1.3 by the blue hour, ramped by view elevation: by day full from ~9°; from golden hour none below 8° and full above 35°.
  - Scale the boost by `(1 − cloud opacity)` so clouds stay neutral.
  - Give warm sky its own small boost (1.1-1.25), and none within ~20° of the sun.
  - A warm sky 3.0-4.6 stops over mid grey runs to camera cream-white. This fixed the "flat apricot slab, only red clipped" backlit golden sky: 95 % of the slot clipped, as in the photo.
  - At sunset, apply a hue twist of 0.4 on saturated warm pixels (the horizon band goes to yellow-orange, 30-40°).
  - In the blue hour, remove 22 % of the red from blue pixels (deep blue at hue 215-222, not lavender).
- Weather regimes per seed (`sky=` URL): streaks, cumulus or haze. Each carries its own aerosol, dust haze and sky saturation scale. The haze regime uses aerosol 130× with a warm albedo (0.985, 0.94, 0.83), keeps half the sky boost, softens penumbrae ×1.3, and fades its street in-scatter in over the first 40 m, so the people nearby keep their blacks (p2 44 → 23).

## 9. Clouds
Volumetric fair-weather cumulus in a slab from 1.5 km, ray-marched at half resolution where the sky shows (0.1 ms). Shapes come from a 2D coverage field plus tileable 3D Perlin-Worley noise. Cirrus and altocumulus are textured layers. The failures, in the order they appeared:

| Failure | Cause | Fix |
|---|---|---|
| "cotton-ball polka dots", lone puff | uniform small cells, no clustering, dark cores missing | two cell scales (13 and 22 km, the second rotated 37°), domain warp ~2.4 km, 2-octave coverage, cells faded where the regional field shows no group; finally **no low cumulus in the default regime** |
| cirrus like water ripples | periodic anisotropic noise (2:16) applied everywhere | dedicated 1:8 wind-aligned streak noise, bend kept under one streak width, ridged fibres, two-level threshold, coverage mask (55-70 % clear), fade below 12° |
| cirrus like smoke rings / swirls | isotropic domain-warped fbm | clamp the warp so no closed loops form |
| stamped altocumulus lattice | one cell size on a regular grid | two sizes, warp halved, cell scale doubled |
| dark cloud blobs at dusk | ambient not following the sky | lift cloud ambient towards the sky colour; light clouds with the sun colour at 2 km |
| blue clouds | the sky saturation boost hit cloud pixels | mask the boost by cloud opacity |
| cumulus without bases | — | flat bases at a common height, greyer undersides (×0.42-0.6), log-normal sizes, a fine erosion octave below an 18-30° fov |
| cirrus as vertical brush strokes at telephoto | noise oriented in screen or elevation space | **open**: orient it along the wind in the cloud plane |

## 10. Sun
- **Take the sun's colour from atmospheric transmittance** at its true elevation, from a ~5900 K tint at the top of the atmosphere. A low sun at 11° then gave R/B ≈ 2.8 (with that round's aerosol), and lit limestone reached R/B 1.7-2.0. Before that, golden stone had midday's R/B of 1.31.
- Hide the sun behind an implied skyline: intensity × smoothstep(0°, 3°, elevation). Keep the light object with intensity 0 and skip its shadow passes (section 16).
- **Design the sun path for the shots you need.** Real solar geometry (31.8° N, early September) maps t onto the afternoon: t 0 ≈ 13:05 at 61°, 0.3 ≈ 15:30 at 35°, 0.55 ≈ 17:25 at 11.5°, 0.8 sunset, 1 civil twilight at −6°. The first build put the golden-hour sun 25° off the street axis, so 17 m buildings shadowed all 24 m of the street: "an overcast sepia day". Rotating the compass so the sun sits ~11° off axis left a sunlit strip with long figure shadows.
- **A visible sun:** draw the disc at full radiance in the view, and scale it only for the environment capture. A 16-tap 1×1 pass measures the visible share of the disc through depth and clouds. The prepass then adds analytic glare `E·vis·(4.8e-4/(θ² + 0.006²) + 4·exp(−θ/0.02))`, which doesn't depend on the clamped bloom.

## 11. Shadows (cascaded sun shadows)

| Item | Value and reason |
|---|---|
| Layout | 4 cascades in one atlas row of 4096-texel tiles (16384×4096) with an R8 colour plus 24-bit depth (320 MB instead of 512). Gives ~1 cm texels in cascade 0 and ~2 cm in cascade 1 at a 17° lens, so railing bars cast. Medium quality: 3×2048; low: 2×1536 |
| Range and splits | to 700 m. First split 30 m at 17°, × (17/fov)^0.8, clamped 8-40 m; logarithmic beyond; 14 % blend band. Beyond 700 m the far-field geometry shades itself as a canyon |
| Stability | rotation-stable bounding-sphere fit with the centre snapped to the texel grid (no shimmer when moving); each tile inset by the filter footprint so PCF never reads the neighbouring tile |
| Refresh | cascades 0-1 every frame, cascade 2 every 2nd, cascade 3 every 4th; all of them when the camera moves 3 m, turns 3°, or the fov or sun changes |
| Bias | depth −2e-5; normal offset 1.2 texels **of the cascade in use**; each tap compares against the receiver plane (depth gradient from screen derivatives). This removed the "rope" staircase and the streaks on grazing walls |
| Penumbra | blocker search probes 0.4-60 m towards the sun; half-width = 0.0047 × 1.1 × blocker distance (sun radius plus filter). Kernel min 1.5 texels (cascades 0-1), 2.2 (2-3), max 24; 16 taps, 32 for wide kernels. A cornice 60 m up-sun gets a ~0.5 m edge, an awning 1 m off a wall ~1 cm |
| Noise | interleaved-gradient rotation stepped each frame and resolved by TAA. A static per-pixel rotation gave salt-and-pepper penumbrae that crawled |
| Culling | casters must reach the cascade's depth slice (shadow length = height / tan elevation) and overlap the slice outline seen from the sun. Cascades 2-3 skip `thinCaster` meshes and casters under 1.5 texels: thin railings aliased into comb-like teeth 85 m+ away |
| Static proxies | merge each streamed chunk's static casters in the background (≤1 ms/frame) into depth-only meshes in 13.5 m cells, with detail and coarse versions. **Coarse drops triangles under 0.15 m.** At 0.35 m it opened gaps that let sun through as a comb of bright streaks along the rails. Reverse the winding of mirrored sources. Put the proxies' bounding sphere far below ground so the main pass culls them. Shadow draw calls 243 → 120 |
| Program churn | give each caster kind its own copy of the depth material (re-evaluations 8.3/frame → 0) |

- **Expensive gotcha:** shader loops with bounds the compiler can't see (a `+ zeroUniform` trick) stopped unrolling, and tap offsets went to local memory. That cost **4 ms GPU per frame** (19.3 → 15.4 ms) for an identical image. Keep loop bounds constant.
- Create the shadow atlas even when the sun is down. Lit shaders sample it, and at dusk the whole scene once rendered blank.
- Shadow hulls must be closed. The oncoming tram's open-bottomed hull let sun through under the car and printed window-shaped patches.
- Foliage shadows need alpha-tested cards or proxies with 30-40 % holes, so there are sun-flecks. Solid crown blobs were too light (−2 EV against −3.45 EV in the photos), and dense shade under crowns (10:1) was never reached.

## 12. Ambient: environment map, canyon bounce, AO
- **Environment map:** a 256 px HDR cube of the sky above a *procedural street-canyon model*: facades, paving, sky slot, window grid, and a darker, greyer band below 4.6 m for shopfronts and people. Without that band, glossy surfaces reflected a bright beige wall. PMREM-filter it progressively (9 frames, ≤ 0.8 ms each) every 8 s and whenever the street heading turns 7°. Filter into a back target and copy into the live one; swapping `scene.environment` forces every material to re-check its program.
- **Canyon bounce:** one hemisphere light (up: sunlit walls seen from the floor; down: sunlit floor seen from below) plus one horizontal directional "cross bounce" from the sunlit facade to the opposite one. Both are set every frame from the sunlit fractions, albedos and view factors, and both are always present (no recompiles). The cross bounce is a 10-20 m area source, so it must be **diffuse-only**: patch the light loop to restore the specular terms after `RE_Direct`. Its specular printed a "second sun" in shop glass (3008 px above 235).
- **The bounce oscillated over the rounds.** Integration review: "shade too blue and dark" (L 0.28 vs 0.57). Bounce was added at {up 0.4, down 0.55}. Round 1: double counted against the environment map, shade only −1.8 EV under the sun (photos −3.3), R/B 0.85-0.96 (photos 0.40-0.65), so it went to {0.15, 0.2}. Next: shade warmer than sun on the same stone, so the cross light was added. Later: shaded limestone ochre, so cross 0.22 → 0.12, tinted half-way to neutral. Final: `{up 0.055, down 0.08, cross 0.12, crossTint 0.5}`, with 30 % less facade bounce once the sun is under ~12°. Image-light level by t: `[[.3,1.05],[.5,1.2],[.86,1.25],[.97,.8],[1,.75]]`. **Lesson:** pin the shade ratio *and* the shade colour to photo regions before touching anything. Keep the sky, bounce and AO terms physically separate. Never let a grading knob compensate for a lighting term.
- **SSAO:** half resolution, Alchemy-style, 16 samples, 0.75 m world radius, strength 0.85, blurred with a depth-aware filter, fading out over 140-320 m, ×1.3 at night. Two bugs to avoid:
  - **Black crescents in armpits and shoulders:** the screen disc was clamped to 48 px, but the range check still used the full world radius. Use the clamped radius, and weaken AO within 4-16 m.
  - **Double darkening:** scale the materials' baked AO to 0.6 while SSAO runs.
  - Still open: shaded facades lack contact darkening under sills and signs (4 % against strong in the photos). The suggestion was a 0.5-1 m radius, weighted more where the sun shadow says the surface is in shade.

## 13. Aerial perspective and heat shimmer
- Apply aerial perspective in the prepass: `col·T + inscatter·(1 − T)` with `T = exp(−ext·dist)`.
  - **In-scatter source:** use the canyon-mean radiance (half sky slot and facades, half paving). The directional horizon radiance double-counts the sun's aureole and turned facades 35 m away into beige fog (2.8× too bright).
  - **Sun term:** HG with g 0.72, applied only to the part of the ray above the canyon's shadow plane (an analytic integral of a ramped lit fraction). A 0.2 floor on "sunlit air" fogged fully shaded streets.
- **Strength:** dust extinction ~1.1e-3/m (visibility ~3.5 km) suits the evening. On a clear midday keep only 0.38 of the extinction and 0.42 of the in-scatter (~0.42e-3/m). The dry midday photos keep crisp dark windows to 500 m; the stronger value made far facades milky (luma std 23 against 50). Looking into a low sun, cut the forward lobe to 0.35×.
- **Heat shimmer:** an angular jitter of 1.5e-4 rad (≤ 0.8 px, so it scales with the lens), 70-260 m away, low over the paving, faded out by t 0.4. Use cells taller than they are wide so edges waver instead of combing.

## 14. Dusk and night
- **Real lights with a fixed count:** a pool of 12 spot lights (8 on medium, 4 on low), one per lantern, re-assigned each frame to the nearest standards. Weights are smooth functions of view-weighted distance and an order statistic, so nothing pops when the ranking changes. Twenty-four farther standards are lit as screen-space pools out to 460 m with the complementary weight.
- **Place the light 0.22 m under the globe centre.** One light at a two-lantern centroid drew a glowing orb in mid-air and lit the scrolls like neon (1/d² at 0.2-0.5 m).
- **Lantern parameters:** 1400 cd downward, cone 1.35 rad, penumbra 0.35. An all-round glow is patched into the spot code for lanterns (marked by decay 1.99995): 0.75 sideways, 0.35 under the cap, 12 m reach, globe-size near clamp `d²/(d² + 0.3)`. Colour is a 3300 K blackbody `(1.13, 0.611, 0.244)`. A photocell ramp switches them on over t 0.64-0.72, shared with the globes, the wash and the airlight.
- **Globe radiance has to beat the sky:** 0.0024 → 0.11 scene units. Cap leaf response near lamps: diffuse ≤ 14× sky irradiance, transmission 0.3 of the sun's share. Otherwise crowns turn into neon-green lampshades.
- **Headlight:** a symmetric 15,000-26,000 cd floodlight lit poles and faces. Use a dipped beam instead: 7000 cd, half-angle 0.3 rad, aimed 20 m ahead, at ~4300 K, with a vertical cut-off 0.5-2° below horizontal (in the light loop and in the airlight).
- **Airlight halos:** use a forward-peaked phase (25 % isotropic, 75 % HG g 0.72) with scattering 6e-4/m. At 2.5e-3 the halos read as fog in dry summer air. Integrate it in closed form (Gauss-Legendre over the angle) with the globe radius, so there is no hot core.
- **Bloom:** mix in 0.018 of the blurred pyramid by day and 0.04 at night. Karis-weight the downsample. At night add a tail of 1.6 % of the 1/16 level so the halo reaches ~3× the globe radius. **Exactly one halo per lamp:** the glow pass for sources above white runs only while the lamp module's own aureoles are off.
- **Ambient at dusk:** drop the image light to 0.8 at t 0.97 and 0.75 at t 1. Otherwise an even lilac ambient flattens the street and upper floors match the ground floor. Targets: upper floors ≥ 1 stop under the lamp-lit ground floor; pools ≥ 1.5 stops over the paving between them; pools hue 30-45°, the paving between hue 215-230°.
- **Windows and shops:** cap lit-window radiance by the exposure (≤ 0.3 exposed), so they read as warm lamps behind curtains, not clipped neutral white. Light 25-40 % of the windows. By day, keep shop interiors ≤ 0.15 of the sunlit facade's radiance (about 1000 lux inside against 100 klx outside). A white-lit interior at noon is a strong CG tell.

## 15. Camera: anti-aliasing, DOF, motion blur, sharpening
- **4× MSAA plus TAA:** new-frame weight 0.1 (up to 0.3 with velocity), 16 Halton(2,3) jitters at 0.5 px peak to peak (MSAA already smooths the edges; a full pixel softens like a box filter). Catmull-Rom history fetch, YCoCg variance clip (γ 1) inside the min/max box, blending on tone-mapped values, history reset on cuts, jumps over 4 m and zooms. Cost 0.2 ms.
- **Moving objects need their own motion in TAA and blur.** Use oriented boxes for oncoming trams and cyclists (8 slots), and a per-frame motion map of walking people (≤ 384 instanced boxes within 140 m). On figures use a tighter clip (0.7σ) and at least 22 % new frame. Walkers' sharpness in motion went from 0.66 to 1.02 of a still frame, for 0.02 ms.
- **Alpha-to-coverage: round alpha to whole MSAA samples.** Some drivers dither fractional coverage over a screen-fixed 2×2 pattern, which TAA can't average away (it prints a checkerboard behind leaves and ironwork). Frame-varying dither averages out over ~10 frames; screen-fixed patterns stay visible.
- **DOF as a real sensor:** a 1"-type sensor (8.8 mm high; at 17° that's f ≈ 29 mm), f/8 by day to f/2.8 at dusk. By day focus at 16 m riding and 13 m standing (near hyperfocal, ~10 m at f/8); at dusk 45 m and 22 m. Allow a CoC of 0.5 px before any blur, capped at 2.5 px by day and 8 px at dusk. The first build's f/3.5 focused at 55 m blurred near figures 3-7 px and gave a **miniature look**.
- **Motion blur with a shutter that follows the light:** 1/160 s by day to 1/50 s at dusk, interpolated in stops. The streak cap is 32 px at 1080p at the night shutter and scales with the shutter. Reproject from depth, 10 taps, and leave the sky alone. A 1/50 s daylight shutter smeared near trees and people across a third of the frame.
- **In-camera sharpening:** a luma unsharp mask on HDR in log space, amount 0.8 after TAA (0.4 before it), limited to ±0.4 stop and faded across strong edges, so there are no halos. Detail went 0.06-0.09 → 0.10-0.13 (photos 0.10-0.20).
- **Lens details:** chromatic aberration 0.0004 (0.0012 tore thin dark bars into colour fringes; keep it off on thin dark lines). Vignette 0.25. Grain 0.012 as luminance noise that scales the pixel's own colour, so dark saturated crowns keep their hue. Dither after quantisation.

## 16. Time of day without hitches
- **No recompiles:** keep a fixed light count (12-light pool, headlight, sun, hemisphere, cross bounce). Patch the shared light loop to skip lights whose colour is 0 (a uniform, so the branch is coherent) and spot lights outside their cone or range. That alone cut the main pass by 25 % (18.3 → 13.8 ms), because dark lights still cost full BRDF evaluations. Verify that `renderer.info.programs` stays constant through a 0 → 1 → 0 sweep (it held at 135); `setTimeOfDay` took ≤ 0.4 ms.
- **No uniform garbage from dark lights:** hold their view-space position and direction vectors (210 → 113 KB/frame). At night, give the lit lights typed setters (169 KB → < 9 KB/frame).
- **No GPU readbacks at run time:** sky irradiance depends only on sun elevation, so render it for 129 times of day into one target at start-up, read it once (asynchronously), and interpolate in log space (0.7 % error). Each readback had stalled 90-506 ms, and `getBufferSubData` blocked even after the fence signalled. The stale CPU estimate also left dusk 5.5 stops dark while the time-of-day slider was dragged.
- Clamp a negative or zero frame step to 0 in env and post. A stale first-frame timestamp delayed the irradiance calibration, so two identical runs differed by 0.6 EV.
- Compile every post and env pass in parallel at init and give rarely used passes one warm-up draw. First-use stalls were 300-490 ms.

## 17. What never reached the target
- **Final scores:** light 6.5/10. Over the rounds, lighting was the slowest lens to improve, because each fix exposed the next layer.
- **Blind A/B of the last two builds** (12 views, three judges who didn't know which was which): the newer build won overall (20 to 13), but the *older* one won golden hour, late morning and both dusk views. The later fixes made those worse:
  - Gamut and vibrance guards made golden hour greyer and flatter.
  - The 12 m lantern glow washed facades warm up to the top floors.
  - Keep the previous build runnable and A/B every lighting round blind.
- **Golden hour:** the standard view reads as a dark, cool, overcast street. Shaded paving is ~1 stop under the backlit photo, and its warmth is orange-pink (G < R) where the photos are cream-yellow (G/mean(R,B) ≈ 1.066). The blown sky came out pure neutral, not cream.
- **Sunset to dusk (t 0.8-0.97):** it reads as blue-tinted daylight. Pools are only 1.17× the paving between them (target ≥ 1.8), the paving goes lavender, and the facades go olive. It only works at t 1, once the sky is gone.
- **Midday:** mid-tones are 0.4-0.5 EV dark (p50 92-102 against 115-169), while wide sunlit paving burns flat at 215-225. Open shade is too blue and saturated. Shaded crowns crush to luma ~24 (photos ~83: glossy leaves reflect the sky; a leaf sky-specular term was suggested). Nothing vivid reaches the gamut edge.
- **Other open items:** clouds still take some sky blue; cirrus looks like vertical brush strokes at telephoto; shaded facades lack occlusion; rare single NaN pixels from foliage and facade shaders.

## 18. Checklist
- [ ] Units fixed and published; emissives and lamp radiances set in those units.
- [ ] Reference envelope measured once (p2, clip %, Hasler, saturation, region colours) and kept in a script all critics use.
- [ ] Exposure = incident-light anchor × EXPO_LIFT(t) × weak meter, with caps applied to the final exposure.
- [ ] Curve fitted to stops → sRGB anchors. Toe, deep-shadow term and black point tuned on p2; the mean tuned on exposure.
- [ ] WB strategy per time of day; daylight-locus guard; separate sky WB; casts checked with G/mean(R,B) and R/B on grey paving.
- [ ] Sky low band pale (sat ≤ 0.15), zenith deep, clouds neutral, no ripples or rings, golden sky blown to cream.
- [ ] Sun colour from transmittance; sun path rotated so each key time has its cue (raking golden light, long shadows).
- [ ] Cascades snapped, receiver-plane bias, PCSS penumbrae, thin casters culled, constant loop bounds, closed hulls.
- [ ] Shade ratio (≈ 3.5:1 open) and shade colour pinned to photo regions before tuning bounce, AO or image light.
- [ ] Dusk: lights in the pool sit under the globes, 3300 K, pools ≥ 1.5 stops over the paving, one halo per lamp, dipped headlight.
- [ ] TAA with motion for every moving thing; alpha-to-coverage rounded; DOF and shutter follow the light; sharpening after TAA.
- [ ] Program count constant through a time-of-day sweep; no runtime readbacks; bad-pixel counter at 0.
- [ ] A blind A/B against the previous build before accepting a lighting round.
