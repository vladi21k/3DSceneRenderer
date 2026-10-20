# Camera, motion, vehicles, audio and UI

How to make a first-person ride read as real footage shot from a vehicle: where the camera
sits and how it moves, how the vehicle drives, how other vehicles hold up as focal points,
synthesized sound, a minimal UI, and offline video recording. The worked example is a tram
cab ride (three.js, plain ES modules); the same rules apply to a boat, a railway, a car or a
walk. Code: `/home/vlad/dev/reps/3DSceneRenderer/src/ride/` (`cameraRig.js`, `train.js`,
`trams.js` + `trams/`, `input.js`, `ui.js`, `audio.js` + `audio/`), `tools/record.py`.

## Contents
1. Brief compliance comes first
2. The camera: body-mounted, on the track
3. Lens and eye height: defaults vs trade-offs
4. Motion that reads as footage
5. Mouse look and zoom
6. Vehicle dynamics and the automatic driver
7. Oncoming vehicles as focal points
8. Synthesized audio
9. Minimal UI and capture mode
10. Recording videos offline
11. What went wrong (timeline) and the checklist

---

## 1. Brief compliance comes first

Copy the brief's hard constraints word for word into every build, critique and fix prompt
for this area, and add a QA check for each one. Critics optimise for "looks like the
footage" and will happily recommend things the brief forbids.

- **Never render your own vehicle.** The brief said the tram is never rendered: no cab,
  dashboard or hood. A ride critic marked "at wide FOV the cab is missing (floating
  camera)" as an issue and proposed a dash, A-pillars and windscreen dust. The fix agent
  built them, and they showed up when the user zoomed out. The orchestrator removed them by
  hand. After that, every QA pass checked "no vehicle geometry visible from the cab at any
  FOV" (12-60°, looking ±60° sideways) and scanned the scene for meshes inside the vehicle's
  envelope.
- **What you may still do with the invisible vehicle.** It can cast a shadow (depth-only
  hulls, never drawn in the main pass), so the street and people beside it are shaded. It
  can also appear in other vehicles' glass reflections as simple boxes. Neither makes it
  visible from the camera, and both add realism.
- **Brief vs realism conflicts go to the user.** For example: the brief asks for rail-joint
  vibration, but real grooved street rail is continuously welded. Satisfy the brief in the
  realistic way (section 4) and say how you did it. When a critic argues against a number the
  brief fixed (eye height 2.5-3 m, a telephoto default), present the measured trade-off to the
  user and change nothing until they answer. Never let a fix agent change it.
- Put the open decisions in the remaining-work notes. Here the user never chose between the
  17° and 24-30° lens, or between 2.75 m and about 2.2 m eye height, so both stayed open.

## 2. The camera: body-mounted, on the track

Real cab footage comes from a camera bolted to the vehicle body. The view axis is the
body's axis. It does **not** turn toward the line ahead. In a bend the track sweeps toward
the inside of the frame while the outer facade fills it. That is the look to reproduce.

**Mount geometry** (`cameraRig.js`):
- The body axis is the track tangent and grade at the centre of the cab module's **own**
  bogie (axles 2.2 m and 4.05 m behind the front). Read it from the route's smooth heading.
  A chord across a 0.5 m route table jittered on such a short base.
- The eye is 1.7 m behind the cab front, on that axis, over the ride-track centre, at
  `EYE_HEIGHT` above the rail top.
- The base pitch is -0.7°, which puts the vanishing point about 40-45% down the frame (as in
  the reference).
- Compose the pose as body (yaw, pitch, roll from the suspension) multiplied by head (mouse
  look plus base pitch). Keep look offsets inside the body frame.
- An early version took the axis from the chord to the second bogie, which sits under the
  *middle* body. That pointed the view about 7 m further across every bend. Moving it to the
  cab's own bogie cut the worst bend drift from 381 to 227 px. In the tightest bend it raised
  the time the track 30 m ahead is in frame from 20% to 40%.

**Never pan toward a gaze point.** This was the most expensive camera mistake:

| When | What happened |
|---|---|
| Initial spec | "Look direction follows the track tangent ~8-12 m ahead": a chase camera, written by the orchestrator |
| Critique 1 | "Gaze turns into curves like a chase camera" (+21.9° off the body axis in the R=58 m bend). Rewritten as a body frame plus a 22% head turn |
| Integration | To keep the rails in a 17° frame through bends, an agent added a **70% head turn toward a point 80 m ahead**. Its metric (track 80 m ahead inside the central 80% of the frame: 8% → 0.1% of positions) improved, but it was the wrong metric |
| User, day 3 | "It looks like it is between the left and right rail pairs." Measured: the ride track was up to ~450 px off centre in bends, with the *other* track mid-frame |
| Fix | `headTurn = teleHeadTurn = 0`: a fixed cab mount. Kept from then on, and listed as a forbidden change in every later prompt |

Why it matters: the rails under the cab are the main cue that you are riding *on* them. Any
view rotation that isn't body rotation slides them sideways and breaks the cue.

**Verify with a rail-centring sweep** after any camera change. Step the vehicle along a long
stretch with bends and project the ride-track centre at the bottom edge of the frame
(`.work/m46/cam/variants.js`):

```js
// for s in 300..2300 step 20: place the train, update the rig, then:
const D = firstDistanceVisibleAtBottom();            // metres ahead where the track enters the frame
const xRide  = project(route.toWorld(camS + D, +1.6, 0)).x;   // ride track centre (px)
const xOther = project(route.toWorld(camS + D, -1.6, 0)).x;   // other track
rows.push({ dev: Math.abs(xRide - W/2), otherCloser: Math.abs(xOther - W/2) < Math.abs(xRide - W/2) });
// pass: otherCloser count 0/101; on straights |dev| <= ~10 px (measured 949-969 px at 1920 wide)
```

Report p50/p95/max deviation as well. In bends a fixed mount *should* show a deviation (the
track sweeps across the frame), but the other track must never be nearer the centre.

**Make capture params authoritative.** A critic reported that `fov=17` rendered a wide view.
It could not be reproduced, but initialisation was made explicit: `fov = params.fov ??
DEFAULT_VFOV`, an explicit value is honoured exactly at any aspect, and user zoom clears it.
Check the projection matrix after load: `P[5] = 1/tan(fov/2)` is 6.6912 at 17°. Captions on
every shared shot should state the lens. At one point a 28° shot sent as "telephoto" looked
no tighter than the default, and the confusion lasted until someone checked that the default
was 17°.

## 3. Lens and eye height: defaults vs trade-offs

The brief asked for a default that "reproduces the reference's telephoto down-the-street
composition". A 17° vertical FOV (about 80 mm full-frame equivalent, about 30° horizontal at
16:9) matched it on straights: converging rails, stacked poles, the street climbing toward the
vanishing point. The cost shows up with a fixed mount:

| Vertical FOV (35 mm equiv.) | Ground visible from | R=58 m bend: track 30 m ahead in frame | Longest stretch with no track |
|---|---|---|---|
| 17° (80 mm), default | ~17 m ahead | 35-40% of the bend | 6.4 s (a still of shopfronts) |
| 24° (56 mm) | ~12 m | 100% | 0 s |
| 30° (45 mm) | ~9.5-10 m | 100%, and the R=150 m line stays in frame to 120 m | 0 s |

- Show the trade-off to the user as a 2×2 still of one tight bend plus two short clips
  (the user here got 17° vs 30°), with the frame centre marked. Keep the brief's default until
  they decide.
- At a long lens the platform at a stop is below the bottom edge (ground starts 17 m ahead),
  so a 14 s dwell reads as stopping in the middle of the street. The suggested fix, still
  open, was to set the stop mark 10-12 m short of the platform end.
- Eye height: the brief said 2.5-3 m, and 2.75 m was used. Solving head and feet positions of
  two walkers in the reference photo put that camera at about 1.85 m. Real low-floor drivers
  sit at about 2.0-2.3 m, so near crowds are seen from above. This stayed a user decision.
  For a new scene, estimate the reference camera height the same way on day 1 and raise any
  conflict with the brief straight away.

## 4. Motion that reads as footage

A camera that is too smooth reads as a gimbal or a dolly. A pure sine reads as a spring.
Too much reads as a game. Measure motion in **pixels at the default lens**: at 17° and 1080
lines, 1° is about 63 px, so tiny angles are visible. These targets were reached and passed
the last motion review (score 7/10):

| Component | Model | Measured at 17° |
|---|---|---|
| Running shake | Angular buzz, 3 noise octaves at 7/11/17 Hz; amplitude (v/12.5)^1.3 + 0.15 under traction + a 0.04 floor; RMS 0.05°/0.028°/0.025° pitch/yaw/roll at 45 km/h | pitch 0.9-1.3 px, yaw 0.6-0.8 px high-pass RMS (was 0.2-0.36 px: "gimbal") |
| Body hunting | Broadband noise over the **distance run** (wavelengths 6/3/1.6 m, i.e. 0.6-2.5 Hz at 25-30 km/h), amplitude ∝ v², wandering ±30% | Spectrum peaks spread 0.08-0.42 Hz (was a pure 1.5 Hz weave of ±5-10 px) |
| Sway, bob, roll | Spring-damper per axis driven by smooth track irregularities (alignment, level, cross level as noise of route position); outward roll 0.32°/(m/s²) lateral | Lateral drift under 2 cm; roll ~0.4° in curves |
| Joint knocks | Kick per axle passing a feature, scaled by axle weight × severity: weld 0.04, dipped 0.11, frog/check 0.2 | 4-7 px in axle pairs (7 frames apart at 27 km/h = 1.8 m axle spacing) |
| Turnout jolts | Sideways yaw/roll springs (5.5/6.5 Hz) kicked at the switch toe (×1.6), check rail (×0.6) and frog, with the sign set by the rail | 6-9 px two-axis jolts through a crossover |
| Brake dive / squat | 0.22° per m/s² (was 0.42) | about 9 px dive (was 24-31 px: too much) |
| Stop spring-back | Pitch-rate kick of 1.8°/s per m/s² of final braking when v reaches 0 | One nose-up overshoot settling in about 1.5 s |
| Dwell | Boarding rocks every 0.6-2 s (±0.03° roll, -1.5 mm), a 0.04° shudder when the doors close | Visible micro-motion: the frame isn't frozen while stopped |

Implementation rules that mattered:
- **Use one feature table for both picture and sound.** Rail joints, welds and turnout
  parts are generated once (`audio/track.js`): 18 m rails, 88% welds with severity
  0.03-0.1, 12% dipped joints with 0.45-1.0, plus toe, heel, check, frog and closure for each
  crossover. A single axle table (`AXLES` in `core/config.js`: offsets 2.2/4.05/13.6/15.45/25/
  26.85 m, weights 1.0→0.12) feeds both. The camera keeps one cursor per axle into the sorted
  list, so every visible bump lands with its knock. Before this, the audio used random joints
  and the camera a fixed 18 m grid with different axle offsets, so they never coincided.
- Welded street track has almost no clack. Meet a "joint vibration" requirement with faint
  weld thumps, rare dipped joints and real turnout clatter, not a regular clickety-clack.
- Drive the springs from the **simulation clock**, not wall time, and sub-step them
  (240 Hz). A frozen (`freeze=1`) or held vehicle then stands still and captures repeat.
- Drive track-excited motion (hunting, irregularities, knocks) by **distance travelled**,
  so it scales with speed and stops at rest. Drive only the running buzz by sim time, scaled
  by speed and traction.
- Shutter blur: give the post pass last frame's view-projection, a `cut` flag (jump > 5 m,
  FOV change > 10%, inspection view) and a shutter time that follows the light: 1/160 s by day
  (crisp, as daytime cab footage is), 1/50 s at dusk. Cap the streak at 32 px at 1/50 s,
  scaled with the shutter and lowered at wide angles.
- How the critics measured motion: record a fixed-step clip (section 10), then compute
  high-pass pitch/yaw RMS in px from the rig's angles, image phase correlation between
  frames, and frame-difference spikes for pop-in. Every number in the table above came from
  that kind of probe, not from someone looking at it.

```js
class Spring {                       // x'' = w²(target - x) - 2ζw x'  (+ kicks)
  constructor(hz, zeta) { this.w = 2 * Math.PI * hz; this.z = zeta; this.x = 0; this.v = 0; }
  step(t, h) { this.v += (this.w * this.w * (t - this.x) - 2 * this.z * this.w * this.v) * h; this.x += this.v * h; }
  kick(amp) { this.v += amp * this.w; }   // peaks at about `amp`
}
// lat 0.8 Hz ζ0.22, yaw 0.75/0.3, vert 1.3/0.25, pitch 0.75/0.38, roll 0.65/0.3, tick 8/0.18
```

## 5. Mouse look and zoom

- **Grab-style drag.** The scene under the cursor moves with it, at any zoom: sensitivity is
  `fov_rad / screenHeight` per px. The first build turned the view the opposite way from the
  grab cursor. It was flipped on purpose and documented.
- **Soft limits.** Movement is linear up to 70% of the limit (±60° yaw, ±25° pitch), then
  eases asymptotically into the limit with tanh. Keep a raw accumulator and the inverse
  (atanh) so a new drag starts where the view is. QA measured the yaw held at ±56.8° and the
  pitch at ±24.96°.
- **Spring return.** On release a critically damped spring brings the view back (ω = 5/s). It
  looks centred after about 1 s and is within 0.5° in 1.2-1.45 s.
- **Zoom** (Z/X held, mouse wheel, lens slider) runs from 12° to 60° vertical. Work in log
  space: held keys multiply by `exp(±0.9·dt)`, the wheel by `exp(delta·0.0011)`, smoothed with
  τ = 0.12 s. Show it as a 35 mm-equivalent focal length (`12 / tan(fov/2)`).
- **Portrait screens.** Keep the 16:9 *horizontal* view (vertical up to 50°) and tilt down a
  little. Otherwise a 17° vertical lens on a phone leaves a 7.9° slit of rails.

## 6. Vehicle dynamics and the automatic driver

Write the vehicle and driver as a **pure simulation class with no DOM**
(`new Tram(app, {s, speed}).step(dt)`). Agents can then run whole laps offline in Node and
measure stop error, jerk, lateral acceleration and the response to people, with no GPU. The
same class drives the oncoming units on a mirrored route.

| Parameter | Value | Why |
|---|---|---|
| Traction | 1.15 m/s² to 32 km/h, then constant power, governor 50 km/h | Light-rail datasheet shape |
| Brakes | service 1.2, emergency 2.5 m/s² | |
| Jerk / snap | 0.9 m/s³, ramp ends rounded at 3.2 m/s⁴ | Every throttle or brake change eases in like a traction controller; no lurch |
| Resistance | Running resistance (Davis formula) plus route grade (×1.08 rotating mass) | The climb is felt: 0.62 m/s² net on a 5.8% grade |
| Cruise | 40-45 km/h on a clear corridor, easing to 23-28 km/h as pedestrian load ahead rises (smoothed over 5 s) | Critique: "cruises at 40-45 through a dense mall" |
| Curve limit | `v = sqrt(aLat(R)·R)`, aLat 0.9 m/s² for R ≥ 150 m easing to 0.55 for R ≤ 60 m | The R=58 corner at about 20 km/h, as a driver takes it (25 km/h looked hurried) |
| Turnouts | 25 km/h until the **rear** has cleared | |
| Limit table | Speed limit at every metre, built once | No route queries per frame |
| Coasting | No power once a stop or lower limit is within 1.35× the braking distance | Critique: "robotic: powers toward a stop, then over-brakes" |
| Station stop | 0.85 m/s² easing to 0.42 at rest; the last 1-2.5 m at the exact constant rate | Lands within 1-2 cm, firm stop, no creep |
| Dwell | 12-18 s (seeded per station and visit); doors open +1.1 s, close 4.2 s before departure, bell 1.5 s before | Measured 13.9 s; matches real stops |
| Start | Nothing moves before the world is ready and the user clicks; then bell, and departure 1.2 s later | Critique: the tram drove 250 m behind the "Click to ride" overlay |

**Bell rate limiting.** Automatic rings at least 4 s apart, manual at least 0.25 s apart, and
departure rings forced. Automatic rings come from station departures, some cross streets
(about 60%, once per pass) and crowd requests. The bell sound layer has its own rules too
(section 8).

**Braking for people** (an integration contract with the crowd):
- The crowd sends `bell-request {urgency}` while someone is near the track ahead, at most
  every ~2.5 s.
- The driver *holds* the urgency for 3 s between requests. The first version let it decay
  in 0.5 s, so at the crowd's real cadence pre-braking never engaged. An offline run showed
  41 km/h through people on the track.
- Lesson: write the **cadence** into the contract, and test the receiver at the sender's
  real cadence (every frame, 1 s, 2.5 s).
- A hard safety net on top: `setObstacle(distance, source)` from any source makes the
  vehicle stop 5 m short. It uses the emergency brake only when the service brake can't make
  it. For the oncoming units, which have their own people scan, the need must also hold for
  0.18 s (two scans), so one flickering report doesn't throw it.
- Held by someone for 2 s: ring and creep up at 5 km/h to 2 m short. After an emergency
  stop: stand 3.5-5 s, ring, move off.
- People react to a bell 0.15-0.75 s after it and sidestep. QA result: 0 people inside the
  swept volume over 2 × 150 s, and the track clear 2.5 s after every bell.

## 7. Oncoming vehicles as focal points

The oncoming tram sits at the vanishing point of the default frame. It drew more critique
than anything else in this area: "placeholder", then "clay model", then "chrome", then
"hovers", then "CG cab box".

**Driving.** Use the same vehicle and driver class on a mirrored route. Two units half a loop
apart gave about 4 encounters per lap. They stop at their own platforms, ring at cross
streets and brake for people. Make sure people also clear *their* track. Otherwise a unit
waits mid-block and freezes the default composition.

**Placement.** Place each articulated body every frame on the chord between its
articulation points on the track. Use 3 LODs by projected size (55 / 14 px per metre at 1080
lines) with 8% hysteresis. Before "ready", draw one micro-scaled mesh of every LOD and
material so its shaders compile then, not when the unit first appears.

**Make it sit on the rails** (the "hovering" fix, verified against the reference's dark line
under the body):
- Bring the skirt down to 0.11 m above the rail, with a black rubber edge.
- Close the space under the body with a near-black underframe at every LOD (floor pan at
  0.28 m, a keel of ducts, bogie frames, track brakes, wheels), so no line of sight passes
  under the car.
- Make the **shadow hull closed**. The depth pass draws back faces, so an open-bottomed hull
  let sunlight through under the car: lit paving under the skirt, and window-shaped sun
  patches beside it.
- Add a contact shade on the paving under each body: it multiplies the paving by 0.28 and
  fades out about 0.35 m outside the outline.
- QA check: the strip under the body at 20-60 m must read darker than the paving
  (47-57 vs 178 after the fix; before, it was *brighter* than the street).

**Paint and glass are different materials. Tune them separately.**
- Paint: satin metallic under a clear coat of 0.3 at roughness 0.2, with lower panels
  rougher. One low-frequency panel waviness (a 0.55/m wave of 6 mrad), not many ripples:
  multi-frequency ripples folded the reflection into repeated copies of walkers.
- Glass: near-mirror, environment roughness about 0.03-0.05. Windscreen head-on reflectance
  about 0.09-0.15, with the Fresnel rise coming from the lighting. Each side pane gets its own
  tiny tilt (±2.5 mrad) so mirrored lines step at the pillars.
- Regression to learn from: a fix for "chrome-like paint" softened every reflection, and the
  windscreen went milky. The user noticed that the front "no longer rendered correctly". A
  focused follow-up fix kept the paint satin and made all glazing sharp again. When you soften
  one material class, verify the others with before/after crops at 15, 40 and 120 m and at two
  times of day.

**Reflections from the TAA history** (`trams/materials.js`). Cube maps can't show the
walkers and shopfronts beside the vehicle. Instead:
- Intersect the reflected ray with proxy planes: the paving and the two facade lines.
- Look up the hit point in **last frame's resolved image** (the temporal anti-aliasing
  history) through last frame's view-projection.
- For rough lobes use the bloom pyramid's blurred levels (1/2 to 1/32 resolution), choosing
  the level from the lobe footprint and the per-pixel lookup stretch.
- Fall back to the environment cube off-screen. Switch the history lookup off on a cut, a
  jump or a zoom change.
- Damp the sharp reflection where the half-resolution depth shows something much nearer
  than the proxy point. Without this, one walker is copied into several panes.
- Limit: what lies behind the camera is never in the history, so the centre of a head-on
  windscreen only reflects the environment model.

**Life inside.** Use real crowd figures as passengers near the camera and a per-pixel traced
saloon far away. Light it by the saloon lamps after dark. Put a dimmed driver in a dark cab:
cab interiors lit like a showroom read as a "lit box with a mannequin".

**Still open at the end:** the front reads as CG (a flat-lit cab and a crisp driver, a
lightbox windscreen at dusk), and the sides lack a clear dark window band. Budget a dedicated
owner for the focal vehicle from the start, with reference crops of the real vehicle side by
side at fixed distances.

## 8. Synthesized audio

Use WebAudio only, with no recordings. Create the AudioContext on the user's start click,
never in capture mode (a test flag `audio=1` forces it on with a device-less sink:
`sinkId: {type: 'none'}`). Headless Chrome's real output clock sometimes never advanced.

**Architecture** (`audio/engine.js`):
- **Buses**: bell, rolling, joints, squeal, traction, aux, brakes, doors, ambience, passing.
  Then compressor → limiter → soft clip → volume (v² taper, saved in localStorage). Suspend
  while the tab is hidden; M mutes.
- **Tram-local spatial frame**: sources fixed to the vehicle (bell, doors, squealing wheel)
  never move. Update only the listener and world emitters, at 25 Hz with linear ramps (no
  zipper noise).
- **The cab shell is the mix.** Outside sound goes through a "far shell":
  - closed while moving: -15 dB, 1.5 kHz low-pass, -6 dB shelf;
  - driver's window open at a stop: -7 dB, 6 kHz;
  - doors open: flat to 16 kHz;
  - ramp between states over about 1.5 s.

  The first build changed only 1.6-2.9 dB between states, so the synthetic crowd was exposed
  all the time. Target: street murmur 15-25 dB under the rolling noise while moving.
- **Reverbs**: street-canyon impulse responses (narrow and wide, chosen by street width), and
  a 0.2 s cab/saloon room for the doors.
- **Bank**: buffers are synthesized in 2 workers in priority order (bell, impulse response
  and joints first) and cached in IndexedDB, one buffer per transaction. Cloning the
  ~40 MB bank at once stalled a frame for about 60 ms just as the tram pulled away.

**Layers and the recipes that worked:**

| Layer | Recipe |
|---|---|
| Bell | Dome modes at F1 = 642 Hz × [1, 1.506, 2.412, 2.951, 4.176, 5.093, 6.012, 8.231, 10.86, 13.74], T60 3.4 s → 0.26 s; each mode a split pair 0.45-2.4 Hz apart (beating); 14 short high modes at 3.2-11.5 kHz; a 2-3 ms band-passed hammer burst at 3.8 kHz; an 88 Hz solenoid thump. "Ding-ding" = 2 strikes 0.2 s apart, pairs at least 0.35 s apart, requests dropped while a pair is pending or began < 0.45 s ago, each strike damps the ring. HRTF at the nose plus a street-reverb send |
| Rolling | **Live** non-repeating noise from an AudioWorklet: rumble modulated at 1× and 2× wheel rate, decorrelated L/R roar with a random swell, corrugation bands at v/λ, Poisson grit grains; level ∝ v^1.5 |
| Joints | Scheduled ahead on the audio clock: every axle × every feature in the shared table. Welds are a ≤300 Hz thump about 21 dB under rolling; dipped joints and turnouts knock |
| Curve squeal | Curvature above 1/150 m⁻¹ and v > 8 km/h: a 2-6 kHz limit-cycle tone that switches on abruptly, comes in bursts at the same spots, hops between two modes, has noise jitter and **no LFO vibrato** (a sine vibrato read as a synth lead), plus flange hiss. Equal-power panning: Chrome's HRTF cut a narrowband source below the listener by about 13 dB |
| Inverter | Real 3-phase PWM in a worklet: asynchronous carrier steps (740/830/990/1110 Hz), then synchronous modes (33/21/15/9 pulses), producing the full sideband family; fades out when coasting; plus motor and gear-mesh tones (19 teeth) |
| Brakes, doors | Pad modes f, 1.47f, 2.31f gating on and off; a stick-slip groan below 1.4 m/s; a settle clunk timed to standstill; air exhaust; 4 staggered doors with chime and beeps |
| Passing vehicle | One HRTF source riding the point of the 32 m body nearest the listener (a line source), Doppler on the gear whine, silent beyond 320 m |
| Ambience | Driven by the real crowd agents: 60 pooled utterances from 20 voices, played as random excerpts at each person's pitch and position, never closer than 9 m; a live hubbub for the far crowd; birds assembled from single notes; swifts at dusk |

**Test offline, because agents can't listen.** `app.audio.test({scenario, seconds, speed,
layers, wav, bands})` renders the real engine through an OfflineAudioContext. It steps
`update()` on a virtual 60 Hz clock first, solos each bus, and reports RMS, peak and
octave-band levels, optionally as a WAV for ffmpeg spectrograms. The audio critic used it to
find defects nobody had heard:
- Spectral-frame autocorrelation of a 40 s render peaked at 7.95 s and 13.1 s: the baked
  rolling loop and the babble loops repeated audibly. Replaced by live noise and granular
  resequencing.
- Per-state levels showed the cab shell barely changed (see above).
- Joint peaks were measured against the rolling RMS. Target: plain-line peaks at most 6 dB
  above it.

Be honest in the report: every audio judgement here came from levels and spectra. A human
listening pass, especially on the formant-synthesized voices, was never done. Recorded videos
were silent (section 10).

## 9. Minimal UI and capture mode

- **Layout**: bottom left, the speed in km/h (64 px, weight 200, tabular numerals), a thin
  master-controller strip (brake in warm orange), auto/manual and next-stop distance. Bottom
  right, the time-of-day slider with a clock and phase label, and the lens slider shown in mm.
  System font stack, no external fonts.
- **Legibility over pale sunlit paving**: a bottom gradient shade is not enough. Put local
  radial scrims behind each corner block, use text alphas of at least .84 / .5, 2 px slider
  tracks, and a text shadow. Check contrast at midday and golden hour.
- **Flow**: a "Click to ride" overlay with the control legend appears once the world is
  ready. The click starts audio and the ride. A controls hint fades after 7 s, and H hides
  everything. Write to the DOM only when a value changes.
- **`capture=1` builds no DOM at all, has no start gate and no audio.** Every screenshot and
  video comes from this mode, so no UI ever leaks into a judged frame. The loading veil must be
  gone in the same frame the app becomes ready. Capture tools wait for it, because one
  recording started on the veil.

## 10. Recording videos offline

A screenshot taken during a live ride stalls that frame, so live screen recording stutters.
Use a fixed-step record mode instead:

- `rec=<fps>`: once ready, the render loop stops. Each `app.recStep(n)` advances the
  simulation clock by exactly 1/fps per frame, however long rendering takes. Wall-clock timers
  serve only as per-frame work budgets, so that is safe.
- `tools/record.py` (DevTools protocol, headless Chrome on the GPU):
  - wait for the veil to clear;
  - step 60 warm-up frames (TAA history, staged reveal);
  - then per frame: `recStep(1)` and grab a JPEG at quality 94;
  - at 46-125 ms per frame, a 45 s clip takes about 1 minute.
- Encode in the Docker tools image:

```sh
ffmpeg -framerate 30 -i frames/%05d.jpg -c:v libx264 -pix_fmt yuv420p -movflags +faststart \
       -preset slow -crf 18 name_1080p.mp4
ffmpeg ... -vf scale=1280:-2:flags=lanczos -preset veryslow -crf 28 \
       -maxrate ${kbps}k -bufsize ${kbps}k name_phone.mp4      # ~3 MB for remote/phone delivery
```

- **Size limit**: uploads to the user's phone above about 3.2 MB timed out (a 9 MB clip
  failed), so the recorder always writes a ~3 MB `_phone.mp4`. Send clips one at a time so one
  failure doesn't block the rest.
- **Use clips as test instruments.** Critics opened the frame JPEGs to judge motion, measured
  frame-to-frame differences (even differences mean no pops), counted knock frames and took
  phase correlation. QA records a 2 s `rec=30` clip each round to prove the mode still works.
- **Gap**: videos were silent, since the sound is generated live. Not done here, but the
  clean fix: drive the OfflineAudioContext harness with the recorded vehicle timeline (s,
  speed, events per frame) and mux the WAV with ffmpeg.

## 11. What went wrong (timeline) and the checklist

| Failure | Cause | Lesson |
|---|---|---|
| Cab interior visible when zoomed out | A critic's suggestion was followed against the brief | Put brief constraints in every critic and fixer prompt; QA "no own-vehicle geometry at any FOV" |
| Camera "between the rail pairs" | Gaze-point panning (70% toward 80 m ahead), first specced by the orchestrator | Fixed body mount; rail-centring sweep in every verify |
| View pointed across bends | Body axis from the wrong bogie | Use the cab module's own support |
| Gimbal-smooth motion, then a spring-like weave | Low amplitudes; a single-sine hunting term | Targets in px at the default lens; broadband noise over distance |
| Picture bumps and audio knocks never matched | Two separate joint lists and axle tables | One shared feature and axle table |
| No pre-braking for people | Request cadence 2.5 s vs a 0.5 s decay | Cadence in the contract; test at the real cadence |
| Tram drove behind the start overlay | No hold before the click | Hold until ready and started; then a standing start |
| Oncoming tram: chrome → milky → hovering | One shared reflection softening; an open shadow hull | Separate paint and glass; closed hull, underframe, contact shade |
| Front "broken" in a checkpoint shot | The shot caught an owner mid-edit | Compare only finished states; before/after crops |
| Audio loops, exposed crowd | Baked loops; a weak cab model | Live noise, a granular pool, a shell model, offline correlation tests |

**Checklist before calling this area done**
- [ ] No part of the own vehicle visible at any FOV or look angle; its shadow is allowed
- [ ] Rail-centring sweep passes (other track never nearer the centre; straights within ~10 px)
- [ ] Default lens and eye height match the brief; trade-offs measured and given to the user
- [ ] Motion probes in px at the default lens: shake about 1 px RMS, knocks in axle pairs, dive under ~10 px
- [ ] Knock frames line up with joint sounds (shared table)
- [ ] Offline lap: stops within 2 cm, jerk ≤ 0.9 m/s³, lateral ≤ curve limit, dwell in range, bell before departure
- [ ] People: 0 swept-volume violations over several minutes; the track clear 2.5 s after a bell
- [ ] Oncoming vehicle: dark gap under the body, solid shadow, sharp glass, satin paint, no duplicated walkers
- [ ] Mouse-look limits and return time, zoom limits, `fov=` honoured exactly, portrait view sane
- [ ] Audio harness: no clipping or NaN, state levels (moving, standing, doors open) distinct, no loop peaks in autocorrelation
- [ ] `capture=1` frames free of UI and veil; a 2 s `rec=30` clip encodes with even frame differences
