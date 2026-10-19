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
- [x] `docs/ARCHITECTURE.md`: module contracts for the parallel build

## M2 — Parallel subsystem build (one owner per area)
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
- [x] M3: 8 area owners (cross-module requests, budgets), then a full-app photoreal review (5.5/10) plus perf/QA review, then owner fixes
- [x] Core: periodic loop noise (no seam), background compile and byte-budgeted staged chunk reveal, program first-use during loading, oncoming trams registered, ride-time build stats, upcoming(lookAhead), contracts documented
- [x] Startup: shaders were compiled twice (screen vs HDR target); cold start 32 s → 15 s
- [x] Route reshaped (user request): gentle bends and S-meanders, so no street is ruler-straight; designed hills (the avenue climbs ~9 m ahead of the start, then crests)
- [x] Uneven ground (user request): shared `route.surface(s, d)` with sidewalk cross-fall, a slow hillside tilt across the street and settlement undulation, applied by toWorld and the paving mesh so every object sits on it
- [x] All modules running together, clean console (0 errors across views)
- [x] 30 fps at 1920×1080 (quality first), quiet-machine QA Oct 19: GPU 11-14 ms median (p95 ≤ 15 ms) of a 28 ms budget, CPU p95 ≤ 10 ms, ≤ 945 calls, ≤ 8.9 M triangles; 0 frames over 50 ms through streaming, stops, the loop wrap and a time-of-day sweep (the s≈1600 hitch is gone); heap flat over a 3-minute ride
- [~] Progressive loading: cold start 17.1 s median on a quiet machine (was 19.3 s; compile 9.3 s for 128 programs, module init 4.7 s); target ≤ 10 s

## M4 — Photoreal review loops
- [x] Photoreal loop, 3 rounds: a 4-lens review (lighting/atmosphere, materials/geometry, shot/motion, people) followed by parallel owner fixes. Panel mean 4.9 → 5.9 → 6.25 (lighting 5→6, surfaces 6→6.5, shot 5→6.5, people/crowd 3.5→6)
- [x] Highlights: AgX camera tone curve with veiling glare and highlight recovery; sun-only daylight white balance; volumetric cumulus/cirrus regimes; cool granite paving; relief rustication; oncoming trams with street reflections; per-object motion blur; crowd pair-clearing rule and tram obstacle braking
- [x] M4.5: request sweep (189 cross-module requests/notes), GC/hitch reduction (whole-app garbage 1365 → 920 KB/frame), contract docs
- [x] M4.6 (Oct 19): status audit, then a build round on what it found: a 175-183 ms hitch at s≈1600 every lap, golden-hour paving clip, double lamp halo at dusk, surfaces too clean and tone too muted against the reference photos (measured), sparse shopfronts, regular facade massing, cold start 19 s, unwired APIs (cyclist motion blur, far-field trees, console drips)
- [x] M4.6 serial quiet-machine perf + behaviour QA (M5): every behaviour check passes
- [x] M4.6 fixes from QA: blacks back in the photos' range (p2 16-28 by day; the golden-hour stop at 53 is still high), midday paving less washed out, sky read-back stall removed, crowd clearance margin 0.33 m, garbage cut (crowd ~6-16 KB per update, ironwork, three's render lists and uniform setters), V-joint chamfers rebuilt, start-up overlapped; verified Oct 19 23:10: 6 cold-start views with 0 console errors and no floating people (644-774 agents each), ride s 1540-1835 GPU 13.0/14.1 ms, CPU p95 7.7 ms, 0 hitches
- [x] Cab camera fixed to the cab body (user request): no pan toward a gaze point, so the ride rails stay under the camera; the other track never sits mid-frame
- [ ] Screenshot review against the reference photos (default telephoto, midday, golden hour, dusk, close-ups)
- [ ] Fix rounds until no frame reads as a 3D demo

## M4b — People rebuild (CC0 MakeHuman)
- [x] Docker image tramline-mh: MPFB2 add-on plus MakeHuman CC0 system assets (tools/mh_fetch.sh, docker/Dockerfile.mh)
- [x] MPFB2 character generator (49-character cast: men, women, teens, children, elderly, toddlers; summer clothing) → renderer integration on the existing contract → 2 review/fix rounds (people 5/10 at telephoto-photographic, game-like close up)
- [x] Ship the round-2 cast, then round 3 (Oct 19): strand hair and beards, eyes and brows, face variety and no neighbouring clones, clean coarse LODs, bags and straps, seated skirts, no crop tops, per-frame garbage

## M5 — Behaviour verification
- [x] Pedestrians never pass through the camera (0 violations in 2 × 150 s, min clearance 4 cm); they clear the tracks and react to the bell (85% look round within 2.5 s)
- [x] Platform stop (on stopS), dwell 13.9-14.8 s, departure with bell; throttle/brake; mouse look limits (±57°/±25°) and return to centre (1.2-1.5 s)
- [x] Time-of-day transitions; loop wrap; no streaming hitches (0 frames over 50 ms)

## M6 — Delivery
- [ ] README: run command, how each part was built, performance trade-offs, asset licences
- [ ] Blind-comparison scrub: no model/company names in code, comments, titles, files, metadata
- [ ] Final screenshots
