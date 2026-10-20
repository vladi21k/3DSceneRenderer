# Build plan — street tram cab ride

Status legend: [x] done · [~] in progress · [ ] todo

## M0 — Environment & tooling
- [x] Docker tools image (`docker/Dockerfile`, wrapper `tools/dk`): Blender 4.5 LTS, Node 24, Python numpy/scipy/Pillow, ImageMagick, ffmpeg, gltf-transform
- [x] three.js r186 vendored in `vendor/three` (MIT), so the app runs with no build step
- [x] Headless GPU capture tool `tools/shoot.py` (DevTools protocol, screenshots + console + stats)
- [x] Local git repository, committed at each milestone

## M1 — Core skeleton and contracts
- [x] Route: closed loop (~5 km), straights + clothoid curves (one tight R≈60 m curve), gentle grades
- [x] Layout plan: stations/platforms, crossovers (switches), cross streets, building lots, poles, trees, cafés, furniture, obstacles
- [x] Facade plan format shared by building modules
- [x] Chunk streaming (40 m chunks, time-sliced builds, LOD rebuilds, recycling behind the camera)
- [x] Module system: dynamic import per module, error isolation, `only=`/`skip=` switches, inspection camera `view=`
- [x] Placeholder renderer for every module, so the grey-box street renders end to end
- [x] `docs/ARCHITECTURE.md`: module contracts

## M2 — Subsystem build
- [x] Materials: GPU-baked procedural PBR textures (limestone ashlar, pavers, rail steel, iron, canvas, glass, wood…)
- [x] Buildings: massing, ashlar walls, arched/rect openings, cornices, roofs, rooftop clutter, side streets
- [x] Facade details: balconies + wrought iron, awnings, shopfronts with interiors, signage, AC units, flower boxes, flags
- [x] Street & track: pavers, embedded grooved rails, crossovers/switches, edge bands, markings, drains, manholes
- [x] Vegetation: young street trees with leaf translucency + wind, planters
- [x] Lamps & catenary: ornate curved-arm lamp poles, span wires, contact wires, insulators, traffic signals
- [x] Street furniture: café tables/chairs/umbrellas, platform + shelter, benches, bins, bollards, kiosks, banners
- [x] Sky/lighting/post: physical sky + drifting clouds, HDR env, sun + cascaded soft shadows, AO, haze, DOF, bloom, filmic tone map, AA, time of day, dusk lights + headlight
- [x] Human figures: varied bodies/clothing at true height, walk cycle, idle/sit poses, instanced
- [x] Crowd behaviour: walking flows, track crossings, clearing for the tram, platform waiting, café patrons
- [x] Ride: tram dynamics, auto/manual throttle, curve speed limits, platform stop + dwell, sway/bob/joint vibration, mouse look, UI
- [x] Audio: synthesized bell (spatial), rumble, joints, curve squeal, motor hum, street ambience

## M2b — Figures follow-up (user requests)
- [x] Anatomy rework: distinct male / female / child (and elderly) proportions and silhouettes, correct back view (shoulder blades, spine groove, trapezius, glutes, calves, hair from behind), sex- and age-specific gait
- [x] Strollers: parents pushing strollers (pose + animated stroller model)
- [x] Bicycles: cyclists riding (pedalling, rolling wheels), people walking bikes, parked bikes at racks
- [x] Crowd roles for strollers and cyclists (lanes, speeds, tram avoidance)

## M3 — Integration & performance
- [x] M3: per-area integration (cross-module requests, budgets), then a full-app image-quality review (5.5/10) plus a perf/QA pass, then fixes
- [x] Core: periodic loop noise (no seam), background compile and byte-budgeted staged chunk reveal, program first-use during loading, oncoming trams registered, ride-time build stats, upcoming(lookAhead), contracts documented
- [x] Startup: shaders were compiled twice (screen vs HDR target); cold start 32 s → 15 s
- [x] Route reshaped (user request): gentle bends and S-meanders, so no street is ruler-straight; designed hills (the avenue climbs ~9 m ahead of the start, then crests)
- [x] Uneven ground (user request): shared `route.surface(s, d)` with sidewalk cross-fall, a slow hillside tilt across the street and settlement undulation, applied by toWorld and the paving mesh so every object sits on it
- [x] All modules running together, clean console (0 errors across views)
- [x] 30 fps at 1920×1080 (quality first), quiet-machine QA Oct 19: GPU 11-14 ms median (p95 ≤ 15 ms) of a 28 ms budget, CPU p95 ≤ 10 ms, ≤ 945 calls, ≤ 8.9 M triangles; 0 frames over 50 ms through streaming, stops, the loop wrap and a time-of-day sweep (the s≈1600 hitch is gone); heap flat over a 3-minute ride
- [~] Progressive loading: cold start about 16.7 s on a quiet machine (was 19.3 s; compile about 9.4 s for 139 programs, which the browser runs one at a time); target ≤ 10 s, see Remaining work

## M4 — Image-quality passes
- [x] Photoreal loop, 3 rounds: a four-area image-quality review (lighting/atmosphere, materials/geometry, shot/motion, people) followed by fixes. Mean score 4.9 → 5.9 → 6.25 (lighting 5→6, surfaces 6→6.5, shot 5→6.5, people/crowd 3.5→6)
- [x] Highlights: AgX camera tone curve with veiling glare and highlight recovery; sun-only daylight white balance; volumetric cumulus/cirrus regimes; cool granite paving; relief rustication; oncoming trams with street reflections; per-object motion blur; crowd pair-clearing rule and tram obstacle braking
- [x] M4.5: cross-module request sweep (189 items), GC/hitch reduction (whole-app garbage 1365 → 920 KB/frame), contract docs
- [x] M4.6 (Oct 19): status audit, then a build round on what it found: a 175-183 ms hitch at s≈1600 every lap, golden-hour paving clip, double lamp halo at dusk, surfaces too clean and tone too muted against the reference photos (measured), sparse shopfronts, regular facade massing, cold start 19 s, unwired APIs (cyclist motion blur, far-field trees, console drips)
- [x] M4.6 serial quiet-machine perf + behaviour QA (M5): every behaviour check passes
- [x] M4.6 fixes from QA: blacks back in the photos' range (p2 16-28 by day; the golden-hour stop at 53 is still high), midday paving less washed out, sky read-back stall removed, crowd clearance margin 0.33 m, garbage cut (crowd ~6-16 KB per update, ironwork, three's render lists and uniform setters), V-joint chamfers rebuilt, start-up overlapped; verified Oct 19 23:10: 6 cold-start views with 0 console errors and no floating people (644-774 people each), ride s 1540-1835 GPU 13.0/14.1 ms, CPU p95 7.7 ms, 0 hitches
- [x] Cab camera fixed to the cab body (user request): no pan toward a gaze point, so the ride rails stay under the camera; the other track never sits mid-frame
- [x] M4.7 (Oct 20) photoreal round: a five-area image-quality review (light, surfaces, shot/motion, people, street life) of the cold-start build scored 6.1; fixes, a serial verification and regression fixes, then a fresh review: light 6.5, surfaces 6.5, shot/motion 6.5, street life 6.5, people 5.5 (mean 6.3). Landed: camera-like tone at every time of day (golden-hour shade p2 53 -> 16-24, deep-blue dusk, pale horizon haze), satin tram paint with sharp glass, rail-joint knocks and irregular hunting, opaque worn zebras, grey rail steel, run-off streaks and recessed joints on ashlar, dirty wall bases and varied stone tones, balcony geraniums and flags, named shop signs, fruit crates and hung garments, varied café umbrellas, push-carts and utility cabinets, fuller terraces, bell reactions and track clearing, draped clothing and a fixed folded-arms pose, crisp price cards, a start-up frame watchdog, capture tools that never leave browsers behind. Verified: 0 console errors, people on the ground at all standard views, GPU 14.3-14.6 ms median at a 60 fps cap with 0 frames over 60 ms, cold start ~16 s.
- [x] M4.8 (Oct 20) photoreal round on the M4.7 findings, then a serial verification, regression fixes and a fresh five-area review: light 6.5, surfaces 6, shot/motion 7, people 6, street life 7 (mean 6.5, M4.7 6.3). Oncoming trams stand on the rails (skirt, underframe, closed shadow hull, contact shade); contact shadows under people's feet; individually drawn clothing folds, face self-shadow, denser locked hair, real bag materials; walkers in pairs and groups; TAA keeps walkers sharp; reflective upper windows; smooth telephoto paving; lower stone towers at the vanishing point; 3300 K lamps with light around each lantern; 2.5x larger sign lettering; worn street furniture; no leafless trees after load; no stall at ride start
- [x] Blind side-by-side of M4.7 (e1242da) against M4.8 (e56c665): 12 identical views compared against the reference photos by three independent reviewers who did not know which build was which. M4.8 preferred 20 times, M4.7 13, 3 ties; M4.8 better in 7 views, M4.7 in 4, 1 even. M4.8 accepted
- [x] Work paused here (Oct 20) at the user's request; see "Remaining work" below

## M4b — People rebuild (CC0 MakeHuman)
- [x] Docker image tramline-mh: MPFB2 add-on plus MakeHuman CC0 system assets (tools/mh_fetch.sh, docker/Dockerfile.mh)
- [x] MPFB2 character generator (49-character cast: men, women, teens, children, elderly, toddlers; summer clothing) → renderer integration on the existing contract → 2 review and fix passes (people 5/10 at telephoto-photographic, game-like close up)
- [x] Ship the round-2 cast, then round 3 (Oct 19): strand hair and beards, eyes and brows, face variety and no neighbouring clones, clean coarse LODs, bags and straps, seated skirts, no crop tops, per-frame garbage

## M5 — Behaviour verification
- [x] Pedestrians never pass through the camera (0 violations in 2 × 150 s, min clearance 4 cm); they clear the tracks and react to the bell (85% look round within 2.5 s)
- [x] Platform stop (on stopS), dwell 13.9-14.8 s, departure with bell; throttle/brake; mouse look limits (±57°/±25°) and return to centre (1.2-1.5 s)
- [x] Time-of-day transitions; loop wrap; no streaming hitches (0 frames over 50 ms)

## M6 — Delivery
- [x] README: run command, controls, how each part was built, performance trade-offs, asset licences (README.md)
- [x] Metadata scrub: no tool or vendor names in code, comments, docs, commit messages or image metadata (checked Oct 20)
- [x] Final screenshots (docs/screenshots/)

## Remaining work (if the project is resumed)
Status when paused (Oct 20): image-quality review 6.5/10; 0 console errors; GPU about 15.5 ms median per frame at 1920x1080 on the RTX 4060 Ti (budget 28 ms for 30 fps), 0 riding frames over 60 ms at a 30 fps cap; cold start about 16.7 s.

Open decisions
- Default lens: 17 deg (current; matches the long-lens reference, but in tight bends the line leaves the frame for up to about 6 s) or 24-30 deg (the line stays in frame through every bend).
- Eye height: 2.75 m sits about 0.9 m above the reference camera.

Where M4.7 still looked better in the side-by-side (fix first)
- Dusk (s=4100, tod 0.97): facades are washed warm and evenly up to the top floors; M4.7's cooler blue-hour ambient, camera-like lamp halos and darker upper floors read more like a night photo.
- Golden hour (s=1450, tod 0.55): greyer and flatter than M4.7's warm haze.
- Midday shade: near tree crowns crush to near-black, and shaded paving takes a blue cast.

Open findings, by area (most costly first)
- People close up (6/10): clothing still reads as shells (repeated fold fans on tee backs, rigid skirt bells); long hair hangs as a sheet, bobs as card clumps, short hair as a cap; waxy faces at 3-15 m and smoky beards; chest prints look like stickers; the contact shade is a hard puck and shows under lifted feet; phones glow at dusk. Missing garment layers (jackets, overshirts), caps and sun hats; the cast is 49 characters.
- Crowd: group members overlap shoulder to shoulder; groups are still a minority at some spots.
- Materials and surfaces (6/10): limestone too saturated in shade (mustard/cardboard); honey and golden lots egg-yolk saturated; rock-faced rustication reads as foam pillows with blue-black joints; rails read as chrome at telephoto; corridor setts lose their joint grid at 30-200 m; relaid-sett patches look like decals; vanishing-point blocks are clean boxes with flat adverts; balcony corbels are simple rolls where the references have carved volutes and acanthus.
- Oncoming trams: the cab still reads as a lit box with a crisp mannequin driver; the side glazing reads as a corrugated mirror without a clear window band.
- Street life (7/10): shop interiors are pale empty boxes by day and glowing slabs at night; blocky reflections in shop glass; hung goods are still strips and rigid boxes; some fascias still blank; kiosk and cabinet prints look corrupted up close; a hard cascade-seam shadow under café canopies at golden hour.
- Light (6.5/10): sunset to dusk still reads as blue-tinted daylight with weak lamp pools; midday mid-tones about 0.4-0.5 EV darker than the photos while wide sunlit paving burns; shaded crowns crush to black; nothing vivid reaches the gamut edge.
- Shot: at a stop no part of the platform is in frame, so the dwell reads as stopping mid-street.

Performance and robustness
- Cold start about 16.7 s against the 10 s target: about 139 programs compile one at a time in the browser's GPU process; fewer or smaller programs (e.g. sun-shadow sampling, light loops) are the main lever.
- Rare single broken HDR pixels from foliage and facade materials (centroid interpolation of the shading varyings is the likely fix).
- The triangle count peaks near the 10 M budget (9.8 M) on busy stretches.
