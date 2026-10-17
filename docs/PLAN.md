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
- [ ] Anatomy rework: distinct male / female / child (and elderly) proportions and silhouettes, correct back view (shoulder blades, spine groove, trapezius, glutes, calves, hair from behind), sex- and age-specific gait
- [ ] Strollers: parents pushing strollers (pose + animated stroller model)
- [ ] Bicycles: cyclists riding (pedalling, rolling wheels), people walking bikes, parked bikes at racks
- [ ] Crowd roles for strollers and cyclists (lanes, speeds, tram avoidance)

## M3 — Integration & performance
- [~] M3 workflow running: 8 area agents (cross-module requests, budgets), then a full-app photoreal critic plus perf/QA review, then owner fixes
- [x] Startup: shaders were compiled twice (screen vs HDR target); cold start 32 s → 15 s
- [x] Route reshaped (user request): gentle bends and S-meanders, so no street is ruler-straight; designed hills (the avenue climbs ~9 m ahead of the start, then crests)
- [x] Uneven ground (user request): shared `route.surface(s, d)` with sidewalk cross-fall, a slow hillside tilt across the street and settlement undulation, applied by toWorld and the paving mesh so every object sits on it
- [ ] All modules running together, clean console
- [ ] 60 fps at 1920×1080 target; draw calls / triangles / chunk build time within budget
- [ ] Progressive loading: first frame quickly, then streaming

## M4 — Photoreal review loops
- [ ] Screenshot review against the reference photos (default telephoto, midday, golden hour, dusk, close-ups)
- [ ] Fix rounds until no frame reads as a 3D demo

## M5 — Behaviour verification
- [ ] Pedestrians never pass through the camera; they clear the tracks and react to the bell
- [ ] Platform stop, dwell, departure; throttle/brake; mouse look limits and return to centre
- [ ] Time-of-day transitions; loop wrap without visible repetition; no streaming hitches

## M6 — Delivery
- [ ] README: run command, how each part was built, performance trade-offs, asset licences
- [ ] Blind-comparison scrub: no model/company names in code, comments, titles, files, metadata
- [ ] Final screenshots
