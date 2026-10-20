export const meta = {
  name: 'photoreal-loop',
  description: 'Photoreal refinement rounds: a multi-lens critic panel scores the whole app against the reference photos, owners fix their issues in parallel, a serial verification catches regressions and owners fix them; repeat to a target, then a fresh re-score',
  whenToUse: 'After integration, when every subsystem exists and the app runs clean. Fill every <<FILL: ...>> first. args: { rounds, target, holdOwners, holdAlways, tag, issuesFile, scores, fixOwners, extraIssues, extraChecks, prevViews, verify, rescore }',
  phases: [
    { title: 'Critique', detail: 'lens critics (light, surfaces, shot/motion, people, street life) score against the reference photos' },
    { title: 'Fix', detail: 'one owner agent per area fixes its merged issues' },
    { title: 'Verify', detail: 'one serial regression check on a quiet machine, then regression fixes' },
    { title: 'Rescore', detail: 'a fresh panel scores the result' },
  ],
}

// Worked example: a 3-round loop (4 lenses, 40 agents, 7.5 h) took the panel mean 4.9 -> 5.9 -> 6.25;
// later single rounds with verify + regression fixes + re-score (20-26 agents, ~6.3 h each) took
// 6.1 -> 6.3 -> 6.5. The 8.5 target was never reached: decide acceptance with blind-ab.js, not the score.
//
// args (all optional):
//   rounds (3), target (8.5, compared with the MINIMUM lens score), tag ('loop', scratch folder name)
//   holdOwners: owners skipped in round 1 only; holdAlways: owners skipped every round (another team owns their files)
//   issuesFile + scores + fixOwners: CONTINUATION mode. Skip the round-1 critique; fixers read their
//     issues from <issuesFile> under byOwner.<owner> (written by the orchestrator from a previous run's critics).
//   extraIssues: { owner: [{ severity, title, evidence, fix }] } the orchestrator's own findings, added in round 1
//   extraChecks: string, more serial checks for this round (e.g. a probe for a bug fixed last round)
//   prevViews: folder of the last verification's standard views, for the round-1 comparison
//   verify (true), rescore (true)
// Save each result to .work/ after the run: the orchestrator needs rounds[].fixed[].requests,
// rounds[].contracts and finalCrits (grouped byOwner, they seed the next round in continuation mode).

// ============================ FILL IN: project specifics ============================
const ROOT = '<<FILL: absolute repository path>>'
const OWNERS = {
  // key: 'files this owner may edit'. Keep it identical to the ownership table in the contract doc.
  '<<FILL: owner key, e.g. env>>': '<<FILL: globs, e.g. src/env/** (sky, sun, shadows, haze, lights, post-processing)>>',
  // ... one entry per owner area; include 'core' for the shared files, with "(be conservative: everything depends on these; never rename public APIs)"
}
const CONTEXT = `PROJECT: <<FILL: one line, e.g. a PHOTOREAL first-person tram cab-ride through a historic limestone city street, in the browser (three.js r186 vendored, plain ES modules, no build step)>>. Repository: ${ROOT}. It is judged in a BLIND side-by-side comparison with real photographs and footage of the place: reference/ (open them with the Read tool; study them closely, they describe the scene). <<FILL: budget, e.g. Quality comes first; the user accepts 30 fps at 1920x1080 (<= ~28 ms GPU, <= 20 ms CPU, no riding hitches over 60 ms). Today the GPU runs ~13 ms, so there is headroom.>>
READ docs/ARCHITECTURE.md for tooling and URL params: <<FILL: capture and recording tools with their main params, e.g. python3 tools/shoot.py (screenshots, --eval, --hitches, view=s,d,h,yaw,pitch, s, tod, fov, freeze=1, only=, skip=, debug=1) and python3 tools/record.py (fixed-step video frames you can open to judge motion)>>.
<<FILL: camera or user decisions that must not be undone, e.g. the cab camera is a fixed cab mount at the user's request; never reintroduce view panning or change the default lens>>
TONE TARGETS measured on 1000 px downscales of the reference photos: <<FILL: e.g. p2 luma 3-40 (median 13), clipped pixels (max channel >= 250) 0.05-11.6% (median 1.35%), Hasler colourfulness 28-60, mean HSV saturation 0.22-0.52; metric script: .work/metrics.py>>.
Recent work and measurements: <<FILL: e.g. docs/PLAN.md, the last serial verification result file and its standard views folder, the latest review file>>.`
const STANDARD_VIEWS = '<<FILL: 6-10 fixed views every critic and verifier shoots, e.g. default; s=700 tod 0.1; s=1450 tod 0.55; s=2440 tod 0.3 fov 28; s=3300 tod 0.8; s=4100 tod 0.97; s=5000 tod 0.45 fov 40; view=430,9,1.7,-60,8>>'
const PROBES = '<<FILL: regression probes with expected results, e.g. people on the ground: timeout 300 python3 tools/shoot.py --params "s=1450&tod=0.55&speed=0" --shots 0 --settle 8 --eval "$(cat .work/probes/height.js)" (expect bad: 0); camera centring sweep .work/probes/cam.js (expect 0/101 frames with the other track nearer the centre)>>'
const BEHAVIOUR = '<<FILL: behaviour spot checks, e.g. a platform stop with dwell and the departure bell; crowdCheck=1 for 90 s through a stop (0 violations); people react to the bell>>'
const LENSES = [
  { key: 'light', text: 'LIGHT, TONE AND ATMOSPHERE: exposure, black levels and shadow detail, highlight roll-off and clipping, white balance and colour, sky (clear, haze, clouds), sun and shade relationship, bounce light, aerial perspective, every time of day (lamps, shop light, headlights at dusk), bloom and glare. Measure tone with the metric scripts on the same kind of framing as the references. <<FILL: known open items for this lens, or "none known">>' },
  { key: 'surfaces', text: 'SURFACES AND GEOMETRY: every material (stone, paving, metal, glass, wood, canvas, paint); wear, dirt, weathering and how they vary; scale cues; edge quality (bevels, chamfers, joints, silhouettes); repetition and tiling; mid- and far-distance detail and LOD pop-in; the far field at the vanishing point. Include close inspection views and the default view. <<FILL: known open items>>' },
  { key: 'shot', text: 'SHOT AND MOTION: does the ride read as real footage from the vehicle? Record short clips (straight, gentle and tight bends, a stop, something passing) and judge the frame sequences: camera sway, vibration, speed feel, motion blur, temporal AA ghosting or shimmer, streaming pop-in, composition against the references. <<FILL: known open items; decisions the user owns that critics must not judge>>' },
  { key: 'people', text: 'PEOPLE AND CROWD: figures at 2-6 m, 10-30 m and telephoto distance (faces, hair, skin, clothing and folds, shoes, bags, hands), proportions by age and sex, gait and idle poses, seated people, wheeled props; crowd density, flow, groups, variety and clones, reactions to the vehicle, against the references. Use the figure test harness as well as full-app views. <<FILL: harness params; known open items>>' },
  { key: 'streetlife', text: 'STREET LIFE AND DRESSING: shopfronts, signage (density, languages, colour, scale, wear), window displays and goods outside, cafe terraces, street furniture, trees and planters, poles, lamps and wires, banners and flags; whether the place feels as busy, varied and lived-in as the references. <<FILL: known open items>>' },
  // Drop or rename lenses to fit the scene (a canal ride needs WATER; a mountain railway needs TERRAIN AND VEGETATION).
]
// ====================================================================================

const A = args || {}
if (JSON.stringify({ ROOT, OWNERS, CONTEXT, STANDARD_VIEWS, PROBES, BEHAVIOUR, LENSES }).includes('<<FILL')) {
  throw new Error('photoreal-loop: replace every <<FILL: ...>> placeholder before running')
}
const OWNER_KEYS = Object.keys(OWNERS)
const MAX_ROUNDS = A.rounds || 3
const TARGET = A.target || 8.5
const TAG = A.tag || 'loop'
const HOLD_ALWAYS = A.holdAlways || []
const DO_VERIFY = A.verify !== false
const DO_RESCORE = A.rescore !== false
const SEV = { critical: 0, major: 1, minor: 2 }

const RULES = `RULES: only edit the files you own. No state-changing git commands (a checkpoint loop commits the tree every ~20 minutes, so never leave a file broken or half-edited for long: make each change complete before moving on). Never write any AI model, AI company or AI tool name anywhere, and never describe the work in code comments or docs as done by agents, critics, reviewers' panels or workflows. No web searches for this place or its assets. Deterministic content. Zero console errors at all times. Run every capture with a time limit (e.g. timeout 600 ...) and make sure no headless browser you started is still running when you finish: an orphaned browser rendering uncapped once held the GPU at 97% for an hour. Verify every change with screenshots next to the references, and with measurements. Other owners work in parallel and the GPU is shared, so prefer structural metrics; a serial verification pass times things afterwards. Before declining anything for a missing API, re-read the other module's code at the end of your work; put what you need from files you do not own into "requests" with the exact API.
REGRESSION GUARD: half-finished edits by two owners once drew people floating tens of metres above the ground, and a cloth change once broke a pose. Check your screenshots for anything floating, sunk, missing or broken, and if you touch positions, heights, the route, start-up order or the figures, run the probes: ${PROBES}.`

const ISSUE = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
    owner: { type: 'string', enum: OWNER_KEYS },
    title: { type: 'string' },
    evidence: { type: 'string', description: 'screenshot paths, params, crops, measurements, and which reference photo shows how it should look' },
    fix: { type: 'string', description: 'concrete technical direction' },
  },
  required: ['severity', 'owner', 'title', 'evidence', 'fix'],
}
const CRIT = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    score: { type: 'number', description: '1-10: how photographic this aspect is next to the references (10 = indistinguishable)' },
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: ISSUE, description: 'ranked by how much each costs in a blind comparison; at most 14' },
    screenshots: { type: 'array', items: { type: 'string' } },
  },
  required: ['lens', 'score', 'summary', 'strengths', 'issues', 'screenshots'],
}
const REPORT = {
  type: 'object',
  properties: {
    owner: { type: 'string' },
    done: { type: 'array', items: { type: 'string' }, description: 'each change with before/after evidence' },
    declined: { type: 'array', items: { type: 'string' }, description: 'issues not fixed, with the concrete reason' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    contracts: { type: 'array', items: { type: 'string' }, description: 'new or changed public APIs, fields or URL params for the contract doc' },
    perf: { type: 'string' },
    requests: { type: 'array', items: { type: 'string' } },
  },
  required: ['owner', 'done', 'declined', 'filesChanged', 'contracts', 'perf', 'requests'],
}
const VERIFY = {
  type: 'object',
  properties: {
    metrics: { type: 'string', description: 'timings with the machine load next to every number' },
    checks: { type: 'string', description: 'pass/fail of every check with evidence' },
    regressions: { type: 'array', items: ISSUE },
    screenshots: { type: 'array', items: { type: 'string' } },
  },
  required: ['metrics', 'checks', 'regressions', 'screenshots'],
}

const holdNote = (held) => held.length
  ? `\nNOTE: the files of ${held.join(', ')} are being reworked by a separate team right now. Do NOT assign issues to ${held.join(' or ')}; in that area, report only what other owners can fix.`
  : ''

const critic = (L, round, phaseName, prevNote, held) => agent(`You are a ruthless photorealism critic for a blind comparison between renders and real photographs. ${CONTEXT}

Round ${round}. YOUR LENS: ${L.text}${holdNote(held)}

Take at least 16 fresh screenshots that suit your lens (save them under .work/${TAG}/crit_r${round}_${L.key}/): the standard views (${STANDARD_VIEWS}) plus close inspection views and frames that show your area best. LOOK at every image next to the reference photos and crop details. Be adversarial and specific, and measure where you can: name what gives each frame away as computer graphics, rank issues by how much they cost in a blind comparison, and give each one exactly one owner (the module whose files hold the fix: ${OWNER_KEYS.join(', ')}; see the ownership in docs/ARCHITECTURE.md) and a concrete fix. Score this aspect 1-10. Do NOT edit any files. Run every capture with a time limit and leave no browser running.${prevNote}
Your final reply is ONLY the structured report.`, { label: `crit:r${round}:${L.key}`, phase: phaseName, schema: CRIT })

const runPanel = async (round, phaseName, prevNote, held) => {
  const raw = await parallel(LENSES.map((L) => () => critic(L, round, phaseName, prevNote, held)))
  // key everything by the lens key (critics tend to echo the whole lens text in "lens")
  const crits = raw.map((c, i) => (c ? { ...c, lens: LENSES[i].key } : null)).filter(Boolean)
  const scores = Object.fromEntries(crits.map((c) => [c.lens, c.score]))
  const vals = crits.map((c) => c.score)
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  const min = vals.length ? Math.min(...vals) : 0
  log(`round ${round} panel: ${JSON.stringify(scores)} (mean ${mean.toFixed(2)}, min ${min})`)
  if (crits.length < LENSES.length) log(`round ${round}: only ${crits.length}/${LENSES.length} critics reported`)
  return { crits, scores, mean, min }
}

const history = []
let lastPanel = null
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const held = [...HOLD_ALWAYS, ...(round === 1 && A.holdOwners ? A.holdOwners : [])]
  const continuation = round === 1 && A.issuesFile
  const last = history[history.length - 1]
  const prevNote = last
    ? `\nPrevious round (${last.round}): owners reported (done / declined / requests): ${JSON.stringify(last.fixed).slice(0, 9000)}\nCheck that those fixes really improved things. Turn any still-valid cross-area request into an issue for the right owner, and look for anything new or remaining.`
    : ''

  // ---- Critique (round 1, or the re-score of the previous round) ----
  let panel
  if (continuation) {
    panel = { crits: [], scores: A.scores || {}, mean: 0, min: 0 }
    log(`round 1: continuation mode, issues from ${A.issuesFile}`)
  } else {
    phase('Critique')
    panel = await runPanel(round, 'Critique', prevNote, held)
    if (!panel.crits.length) { log('no critic reported; stopping'); break }
    if (panel.min >= TARGET) { history.push({ round, scores: panel.scores, stopped: 'target reached' }); lastPanel = panel; break }
  }
  lastPanel = panel

  // ---- Fix: merge issues per owner across lenses ----
  phase('Fix')
  const byOwner = {}
  for (const c of panel.crits) for (const i of c.issues || []) (byOwner[i.owner] = byOwner[i.owner] || []).push({ ...i, lens: c.lens })
  if (round === 1 && A.extraIssues) for (const [o, list] of Object.entries(A.extraIssues)) byOwner[o] = [...(byOwner[o] || []), ...list.map((i) => ({ ...i, owner: o, lens: 'orchestrator' }))]
  const deferred = Object.entries(byOwner).filter(([o]) => held.includes(o)).flatMap(([, l]) => l)
  if (deferred.length) log(`round ${round}: deferring ${deferred.length} issues for ${held.join(', ')}`)
  const fixOwners = continuation
    ? (A.fixOwners || OWNER_KEYS).filter((o) => OWNERS[o] && !held.includes(o))
    : Object.keys(byOwner).filter((o) => OWNERS[o] && !held.includes(o))
  const sorted = (o) => JSON.stringify((byOwner[o] || []).slice().sort((a, b) => SEV[a.severity] - SEV[b.severity]), null, 1).slice(0, 30000)
  const issueText = (o) => continuation
    ? `YOUR ISSUES are in ${A.issuesFile} under byOwner.${o} (fields severity, title, evidence, fix, lens); read them first. An earlier attempt at this fix may have been interrupted part-way, so some of it may already be in the tree: read the current code and continue from there.${byOwner[o] ? `\nALSO these issues:\n${sorted(o)}` : ''}`
    : `ISSUES:\n${sorted(o)}`
  const fixes = await parallel(fixOwners.map((o) => () => agent(`You are a senior graphics engineer on this project. ${CONTEXT}

YOUR AREA: ${o}
YOU OWN: ${OWNERS[o]}
${RULES}

Round ${round}. A panel of critics, each with one lens, scored the build against the reference photos (scores: ${JSON.stringify(panel.scores)}). Fix the issues assigned to you, critical and major first, then as many minor ones as is sensible. Some may overlap; merge them. If two critics disagree, follow the reference photos. Read your current code first, and re-verify each fix with before/after screenshots next to the references. Issues you already fixed in an earlier round that the critics still raise need a deeper fix, not a tweak. Hold the performance budget and add no per-frame garbage.
${issueText(o)}
When finished, reply with ONLY the structured report.`, { label: `fix:r${round}:${o}`, phase: 'Fix', schema: REPORT })))
  const reports = fixes.filter(Boolean)
  const noReport = fixOwners.filter((o, i) => !fixes[i])
  if (noReport.length) log(`round ${round}: no fix report from ${noReport.join(', ')}`)

  // ---- Verify: one serial agent, then regression fixes ----
  let verify = null
  let regFixes = []
  if (DO_VERIFY) {
    phase('Verify')
    const fixSummary = JSON.stringify(reports.map((r) => ({ owner: r.owner, done: r.done, declined: r.declined, contracts: r.contracts }))).slice(0, 30000)
    const prevViews = round === 1 ? (A.prevViews || 'the last verification\'s standard views (see "Recent work" above)') : `.work/${TAG}/verify_r${round - 1}/views/`
    verify = await agent(`You are the QA engineer. ${CONTEXT}
The owners just made these changes: ${fixSummary}
Run captures ONE AT A TIME (never in parallel), each with a time limit; before each timing run check uptime, GPU load and running headless browsers, wait while the machine is busy, and report the load next to every number. Save everything under .work/${TAG}/verify_r${round}/. Do NOT edit files.
CHECKS: (1) regression probes at the standard views: ${PROBES}; and LOOK for anything floating, sunk, clipping or missing in the screenshots; (2) 0 console errors in every run, including debug runs at two views, dusk, and a short recording; (3) the standard views (${STANDARD_VIEWS}) compared with ${prevViews} and the references: anything broken, popping, z-fighting, blown or crushed, and the tone targets; (4) timing with a frame cap: two ~35 s rides, GPU/CPU median and p95, frames over 50/60 ms; cold start over 3 runs; (5) behaviour: ${BEHAVIOUR}${A.extraChecks ? `; (6) ${A.extraChecks}` : ''}.
Return the metrics, check results, screenshots and every regression with exactly one owner and a fix.`, { label: `verify:r${round}`, phase: 'Verify', schema: VERIFY })
    const regs = (verify && verify.regressions) || []
    const regOwners = [...new Set(regs.map((r) => r.owner))].filter((o) => OWNERS[o] && !held.includes(o))
    regFixes = (await parallel(regOwners.map((o) => () => agent(`You are a senior graphics engineer on this project. ${CONTEXT}

YOUR AREA: ${o}
YOU OWN: ${OWNERS[o]}
${RULES}

The serial verification found these regressions in your area after the fix round. Fix them at the root and re-verify:
${JSON.stringify(regs.filter((r) => r.owner === o), null, 1)}
Verification metrics for context: ${((verify && verify.metrics) || '').slice(0, 5000)}
When finished, reply with ONLY the structured report.`, { label: `reg:r${round}:${o}`, phase: 'Verify', schema: REPORT })))).filter(Boolean)
    log(`round ${round}: ${regs.length} regressions, ${regFixes.length} regression fixes reported`)
  }

  history.push({
    round,
    scores: panel.scores,
    mean: panel.mean,
    issues: Object.values(byOwner).reduce((n, l) => n + l.length, 0),
    deferred,
    fixed: reports.map((r) => ({ owner: r.owner, done: r.done, declined: r.declined, requests: r.requests })),
    contracts: [...reports, ...regFixes].flatMap((r) => (r.contracts || []).map((c) => `${r.owner}: ${c}`)),
    verify: verify ? { metrics: verify.metrics, checks: verify.checks, regressions: verify.regressions } : null,
    regFixes: regFixes.map((r) => ({ owner: r.owner, done: r.done, declined: r.declined })),
  })
}

// ---- Final re-score by a fresh panel (also the first critique of any next round) ----
let final = null
const lastRound = history.length ? history[history.length - 1] : null
if (DO_RESCORE && lastRound && !lastRound.stopped) {
  phase('Rescore')
  const n = lastRound.round + 1
  const prevNote = `\nPrevious round (${lastRound.round}): owners reported: ${JSON.stringify(lastRound.fixed).slice(0, 9000)}\nCheck that those fixes really improved things, and look for anything new or remaining.`
  final = await runPanel(n, 'Rescore', prevNote, HOLD_ALWAYS)
}
// Save final.crits to a file (byOwner) to seed the next round in continuation mode.
return {
  rounds: history,
  finalScores: final ? final.scores : (lastPanel ? lastPanel.scores : null),
  finalMean: final ? final.mean : (lastPanel ? lastPanel.mean : null),
  finalCrits: final ? final.crits : null,
}
