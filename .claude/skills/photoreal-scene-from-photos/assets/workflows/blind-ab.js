export const meta = {
  name: 'blind-ab',
  description: 'Blind side-by-side of two commits: render identical views from both builds serially, make neutral L/R sheets, three independent judges pick the more photographic half against the reference photos, tally and suggest accept or revert',
  whenToUse: 'Before accepting a round (panel scores drift between fresh panels), or to choose between two variants. args: { oldRef, newRef, tag, scoreOld, scoreNew }. Fill every <<FILL: ...>> first.',
  phases: [
    { title: 'Render', detail: 'serial renders from both builds, neutral side-by-side sheets' },
    { title: 'Judge', detail: '3 blind judges with different weightings against the reference photos' },
  ],
}

// Worked example: 12 views, 24 serial captures (14 min), 3 judges (4-7 min each). Result: new 20 votes,
// old 13, ties 3; new won 7 views, old 4, 1 even -> new accepted. The views the old build won
// (golden hour, dusk) became the "fix first" list for any later round.
// Caveat seen: procedural content that differs between the builds (other shop signs, other people)
// changes what a view shows, not only how well it is rendered; the render agent flags such views.

// ============================ FILL IN: project specifics ============================
const ROOT = '<<FILL: absolute repository path>>'
const SUBJECT = '<<FILL: neutral description for the judges, e.g. a street with a tram line>>'
const CAPTURE = '<<FILL: capture command run from INSIDE each exported tree, e.g. timeout 600 python3 tools/shoot.py --params "<params>" --out <png> --settle 6 --timeout 300 (log must show ready=True and 0 console errors)>>'
const EXPORT_NOTE = '<<FILL: anything an exported tree needs to run, e.g. create an empty .work directory inside each export, since the capture tool writes browser profiles there; large git-ignored assets to copy in, if any>>'
const VIEWS = [
  // 8-12 views: the standard views plus close-ups of the things that changed (people, a facade, the vehicle, dusk).
  // Use frozen time (freeze=1, speed=0) so both builds show the same moment.
  { id: 1, params: '<<FILL: e.g. speed=0&freeze=1>>', note: '<<FILL: e.g. default view>>' },
  // { id: 2, params: 's=700&tod=0.1&speed=0&freeze=1', note: 'midday' },
]
// Judge weightings: one overall, two that weigh different aspects first.
const JUDGE_LENSES = [
  'overall photographic realism',
  'light, colour and materials first, then everything else',
  'people, motion cues and street life first, then everything else',
]
// ====================================================================================

const A = args || {}
if (JSON.stringify({ ROOT, SUBJECT, CAPTURE, EXPORT_NOTE, VIEWS }).includes('<<FILL')) {
  throw new Error('blind-ab: replace every <<FILL: ...>> placeholder before running')
}
if (!A.oldRef || !A.newRef) throw new Error('blind-ab: pass args.oldRef and args.newRef (commit hashes)')
const TAG = A.tag || 'ab'
const DIR = `${ROOT}/.work/${TAG}`

// Which build goes on the LEFT of each sheet: fixed, irregular, balanced, never written to disk.
// (Workflow scripts cannot draw random numbers, which would break resume; vary the pattern by hand.)
const LEFT_PATTERN = [true, false, false, true, true, false, true, false, false, true, false, true]
const OLD_LEFT = VIEWS.map((v, i) => LEFT_PATTERN[i % LEFT_PATTERN.length])
log(`old build on the left in ${OLD_LEFT.filter(Boolean).length} of ${VIEWS.length} sheets`)

const RENDER_SCHEMA = {
  type: 'object',
  properties: {
    sheets: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, path: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string', description: 'content differences between the halves, render problems' } }, required: ['id', 'path', 'ok'] } },
    problems: { type: 'string' },
  },
  required: ['sheets', 'problems'],
}
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    votes: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' }, pick: { type: 'string', enum: ['L', 'R', 'tie'] }, margin: { type: 'string', enum: ['clear', 'slight', 'none'] }, why: { type: 'string' } }, required: ['id', 'pick', 'margin', 'why'] } },
    summary: { type: 'string' },
  },
  required: ['votes', 'summary'],
}

phase('Render')
const order = VIEWS.map((v, i) => `view ${String(v.id).padStart(2, '0')}: params "${v.params}" - put the ${OLD_LEFT[i] ? 'OLD' : 'NEW'} build on the LEFT`).join('\n')
const render = await agent(`You prepare a blind image comparison for a photoreal browser renderer (repository ${ROOT}; tooling in docs/ARCHITECTURE.md). Do NOT edit any tracked file and run no state-changing git command.
BUILDS: OLD = commit ${A.oldRef}, NEW = commit ${A.newRef}. Export each with git archive into ${DIR}/old and ${DIR}/new. ${EXPORT_NOTE}. Run each build's OWN tools from its own folder, so each serves its own files.
RENDER strictly one capture at a time, each under a time limit, on a quiet machine (check uptime, GPU load and that no other headless browser is running before each; wait if busy): ${CAPTURE}. For each view render OLD and NEW at 1920x1080 with exactly the same params. Check every log for a ready frame and 0 console errors; re-run a capture once if it failed. Leave no browser running at the end.
SHEETS: for each view make ONE side-by-side JPEG, ${DIR}/sheets/view_NN.jpg (NN = 01, 02, ...): the two renders scaled to 1600 px wide each, side by side with an 8 px dark gap, labelled only 'L' and 'R' in small text at the top. Follow this left/right assignment exactly:
${order}
Then DELETE every raw render, log and intermediate image that could reveal which side is which (keep only the sheets in ${DIR}/sheets/ and nothing else under ${DIR}/ except the two exported trees, whose renders and logs you must also delete). Do not write the assignment anywhere on disk.
In each sheet's note, say if the halves differ in CONTENT (different signs, people, objects), not only in rendering quality.
Reply with the structured result: each sheet path, whether both halves rendered correctly (ok), and any problem.`, { label: 'ab:render', phase: 'Render', schema: RENDER_SCHEMA })

phase('Judge')
const sheets = ((render && render.sheets) || []).filter((s) => s.ok)
if (sheets.length < VIEWS.length) log(`only ${sheets.length}/${VIEWS.length} sheets rendered correctly; judging those`)
const list = sheets.map((s) => `view ${s.id}: ${s.path}`).join('\n')
const judges = await parallel(JUDGE_LENSES.map((lens, j) => () => agent(`You are an expert photo-forensics judge in a blind test. Each image below is a side-by-side of two renders (L and R) of the same camera view of ${SUBJECT}, made by two versions of the same renderer. Study the reference photographs of the real place first: ${ROOT}/reference/ (open each with the Read tool). Then open every sheet and, for each view, pick the half that looks MORE like a real photograph of that place (L, R or tie), with how clear the margin is and a one-sentence reason naming the decisive differences. Weigh: ${lens}. Ignore the labels and any small framing differences; judge only realism. Do not look for or open any other files under ${DIR}/ or anywhere else to find out which version is which; judge only what you see.
SHEETS:
${list}
Reply with the structured result.`, { label: `ab:judge${j + 1}`, phase: 'Judge', schema: JUDGE_SCHEMA })))

const tally = { old: 0, new: 0, tie: 0, clearOld: 0, clearNew: 0 }
const perView = {}
for (const jd of judges.filter(Boolean)) for (const v of jd.votes || []) {
  const idx = VIEWS.findIndex((x) => x.id === v.id)
  if (idx < 0) continue
  let who = 'tie'
  if (v.pick === 'L') who = OLD_LEFT[idx] ? 'old' : 'new'
  if (v.pick === 'R') who = OLD_LEFT[idx] ? 'new' : 'old'
  tally[who]++
  if (who !== 'tie' && v.margin === 'clear') tally[who === 'old' ? 'clearOld' : 'clearNew']++
  ;(perView[v.id] = perView[v.id] || []).push({ who, margin: v.margin, why: v.why })
}
const viewWinner = Object.fromEntries(Object.entries(perView).map(([id, vs]) => {
  const n = vs.filter((x) => x.who === 'new').length
  const o = vs.filter((x) => x.who === 'old').length
  return [id, n > o ? 'new' : o > n ? 'old' : 'tie']
}))
const wins = Object.values(viewWinner)
const newViews = wins.filter((w) => w === 'new').length
const oldViews = wins.filter((w) => w === 'old').length
const scoreOk = (typeof A.scoreOld === 'number' && typeof A.scoreNew === 'number') ? A.scoreNew >= A.scoreOld : true
// Rule used in the worked example: accept if the new build wins the votes and the re-score did not drop.
const verdict = (tally.new > tally.old && newViews >= oldViews && scoreOk) ? 'accept new' : 'keep old (revert with a new commit, do not rewrite history)'
log(`blind A/B votes: new ${tally.new}, old ${tally.old}, tie ${tally.tie}; views new ${newViews}, old ${oldViews} -> ${verdict}`)
return {
  verdict,
  tally,
  viewWinner,
  oldWonViews: VIEWS.filter((v) => viewWinner[v.id] === 'old').map((v) => ({ id: v.id, note: v.note, why: (perView[v.id] || []).filter((x) => x.who === 'old').map((x) => x.why) })),
  perView,
  render,
  judgeSummaries: judges.filter(Boolean).map((j) => j.summary),
}
