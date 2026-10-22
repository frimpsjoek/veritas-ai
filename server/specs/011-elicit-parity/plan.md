# Plan: bring Elicit's remaining features into Second Brain (spec 011)

Date: 2026-10-05. Repo: `~/obsidian-kb` (specs) and `~/obsidian-kb/zotero-plugin` (engine `agent-src`, shared UI `ui-src`).
Evidence: a live session in Elicit (Arc, trial account) on 2026-10-05, plus a gap check against specs 005, 007, 008 and the code.

## 1. What is already built (do not rebuild)

Specs 005, 007 (E1-E8) and 008 already give us the Elicit core, built from the user's 2026-09-26 screenshots:
sessions as a stack of steps; table/paper-set/report artifacts with versions (V1, V2); per-cell quotes with a
quote check; search/sort/filter; columns panel with remove; chat with papers; clarify cards; compacted activity
lines; systematic review with a protocol; CSV/RIS/Markdown export; mode menu (Workflows/Tools); empty-state cards.
`extract.js` already returns `not_found` per cell. `artifact-panel.js` already has column add/remove
(lines ~616-664, 859). Pending from earlier work and a prerequisite here: the 0.39.3 abstract lookup
(`abstractsByDoi`, built and unit-tested 2026-10-05, not yet published or checked on an outside-paper question).

## 2. What Elicit has that we do not (from the live session)

| # | Elicit behavior seen | Our state | In this plan |
|---|---|---|---|
| 1 | **Skills**: reusable instructions (SKILL.md: name, description, body); create with AI, upload, or by hand; "Use skill" inserts a chip in the prompt; Strategy/Landscapes chips are skills | none (grep finds no skill code) | U3 |
| 2 | **Routines**: scheduled research tasks (daily preprint digest, weekly trial watch), Active/Paused/Archived; "Create routine for artifact" | none | U4 |
| 3 | **Depth dial**: five stops Fastest 0.3x, Fast 0.5x, Balanced 1x, Smart 5x, one locked; shown as usage | a Quick/Standard/Deep select in the options row (`chat.js` ~327); no turn estimate for reports | U1 |
| 4 | **Table edits as conversation**: a column change is posted as a "Column changes" turn, the agent answers in prose, writes "not reported" where sources lack data, then offers follow-up chips such as "Find full-text evidence for the unreported binding geometries" | column ops run as direct steps; no follow-up chips; no gap-fill step | U2 |
| 5 | Sources view (all cited sources of an artifact) | none | U2 |
| 6 | Projects (group sessions); "Add to project" | none | Not in scope (user did not pick it); noted in section 9 |
| 7 | Library selection panel ("New from selection": systematic review, extract data, chat with papers) | covered by the tools menu in 007 section 7 | Not in scope |
| 8 | Report format picker (General Review, 1-Page Overview, Research Gap Analysis) | not present | Folded into U3 as three built-in skills |

## 3. Decisions taken (user, 2026-10-05)

1. Scope and order: Skills, Routines, Depth dial + usage, Table-as-conversation + gap fill. Build order below
   differs from this list only because Routines needs Skills and Depth first.
2. Routines run **only while the KB server (or Zotero's own runtime) is up**. No new background job. Missed runs catch up once at startup.
3. Skills live in the **vault**: `Second Brain/Skills/<name>/SKILL.md`, editable in Obsidian.

## 4. Build order

| Unit | Title | Depends on | Version |
|---|---|---|---|
| U0 | Publish the abstract lookup | live check on an outside-paper question | 0.39.3 |
| U1 | Depth dial + honest usage | none | 0.40.0 |
| U2 | Table-as-conversation, gap fill, follow-ups, sources view | none (U1 helps) | 0.41.0 |
| U3 | Skills | none | 0.42.0 |
| U4 | Routines | U1, U3 | 0.43.0 |

Each unit ends with both apps building, installing and opening a session (spec 007 check 18). Publish only after the
unit's checks pass: both apps auto-install within 15 minutes.

## 5. Units

### U0. Publish the abstract lookup (0.39.3)
- Run `dev/report.mjs` on a question whose candidates are mostly outside the library (for example a topic with few Zotero papers), `--depth quick`.
- Check the saved `rows` for `inLibrary:false` rows with `abstractStatus:"source"` and a non-empty abstract; count them.
- Then bump both manifests, build the xpi, run `obsidian-plugin/install.sh`.
- Verify: `npm test` (409 pass), `npm run typecheck` clean, real-Zotero harness suite (10 tests) green on fresh profiles.

### U1. Depth dial + honest usage (0.40.0)
Elicit shows a made-up "usage multiplier". We have no price list, so ours shows what we can measure: **estimated
model turns** for the chosen depth.
**Corrected after reading the code (2026-10-06):** depth already exists with three real levels. `prompts.js` has
`DEPTH_PRESETS` (quick 3 / standard 5 / deep 8 sub-questions), `REPORT_CAPS` and `SYSTEMATIC_CAPS` (candidates and
extract caps, `deep` included), and the options row in `chat.js` (~327) is a `<select>` of Quick / Standard / Deep.
`estimateStep` in `extract.js` only prices column steps (rows, cells, turns), not a report. So U1 is smaller than first
written: no new engine knobs are needed to ship the dial.
- **Stops**: a three-stop slider replacing the select, named **Fast / Balanced / Smart** (stored values stay
  `quick` / `standard` / `deep`, so every saved request and review keeps working). A fourth stop, **Fastest**
  (abstracts only, no model screening turn), is a follow-up that needs its own knobs and a measured quality check; it is
  not part of U1. The locked fifth stop is dropped.
- **Report estimate (new)**: `estimateReport(depth, systematic)` in `agent-src/src/review2.js` (or a small new
  `estimate.js`), a pure function: clarify (0-2) + plan (1) + researchers (sub-questions, up to 2 attempts each) +
  screening batches + extraction batches (from the caps and `extractBatch`) + writer (1). It returns `{ turns, low, high }`.
  Exposed through `reviews.estimate` and `remote.js` like `sessions.estimate`.
- **UI**: a slider in the options row (`ui-src/src/chat/chat.js`) with a label under it ("Balanced - about 22 turns"),
  fed by the report estimate. Keyboard: arrow keys move the stop; the label is read by screen readers.
- **Usage meter**: one quiet line showing the provider's own signal where we already have it (Codex 5-hour window,
  Claude cost notices). No new API calls.
- **Tests**: `estimateReport` table (every depth, systematic and not) and monotonic (quick < standard < deep); existing `quick`/`standard`/`deep` records still load; harness renders the slider in both token maps.
- **Check**: Fast vs Smart on the same question differ in estimated turns by at least 2x, and each estimate is within 25% of the actual turns of a live run (the 2026-10-05 quick run: 12 papers extracted, 230 s).

### U2. Table-as-conversation, gap fill, follow-ups, sources view (0.41.0)
- **Column changes are conversation turns.** Add, edit, remove and reorder write a `column_change` user record into the
  thread (a structured card: "Add 'Binding geometry' + instructions") and then run the existing `columns` step.
  The agent's reply is a short prose summary with citations. The gear panel (edit name/instructions, Update, Delete)
  goes through the same path. Versions still bump (V2). `artifact-panel.js` `removeColumn` and the add path call one
  shared `applyColumnChange()`.
- **Honest blanks**: `not_found` cells render as "not reported" (already the data; UI wording and a muted style), and the
  reply names which rows have no data.
- **Gap-fill step** (`kind: "fill"`): re-runs extraction only for `not_found` cells with a stronger text source: library
  papers read at `text: "best"`, outside papers fetched from their OA PDF URL when present. Writes a new version; cells
  that stay empty stay "not reported". Uses the existing estimate/confirm card above the row/cell caps.
- **Follow-up chips**: each answer's structured output gets an optional `followUps: string[]` (max 2). No extra turn.
  The first chip is always the gap-fill when a table has any `not_found` cell. Chips render under the answer and set
  the composer text on click (no auto-send).
- **Sources view**: artifact menu item "Sources (N)" lists every paper cited by the artifact with its quotes
  grouped per paper, reusing the supporting-quotes popover content.
- **Tests**: golden for the `column_change` record; fill step only touches `not_found` cells (fixture); follow-ups parsed and capped; reopening an old session without these records still renders.
- **Check**: in a live run, add one column to an 8-row table, see a V2 and a reply naming rows with no data; click the gap-fill chip and see at least one cell change or the reply say none could be found.

**Result (2026-10-06, 0.41.0).** Shipped: adding columns is a `columnChange` user turn plus a plain reply written by
our code (no model turn): "Done. “X”: 6 of 8 filled, 2 not reported (Paper A; Paper B)", painted live and on reopen;
`rows: "gaps"` gap fill (re-reads only the "not reported" cells at `text: "best"`, one paper a turn) with its own
user turn and reply ("Found a value for 2 of 2 cells that had none"); one follow-up chip under a reply when the newest
version still has blank cells (`.sb-ai-followup`, runs on click, nothing sent to the composer); Sources view
("Sources (N)" in the artifact's More menu). Not built, on purpose: model-written `followUps` on every answer (the
gap fill is the only follow-up that has a clear action) and the per-column gear panel posting turns (it still goes
through the same step, so it gets the turns too, but its own panel is unchanged). "Not reported" wording already existed.
Checks: engine 420, ui-src 86, real Zotero t-columns 8/8, t-gap-fill 6/6 (chip, V3, turns, Sources view of 10 papers),
plus t-unified-chat, t-papers-chat, t-sidebar, t-find-papers, t-report, t-depth, t-chat-look. Found: t-find-papers
looked at the old depth `<select>` (now a detached helper) and needed to look at `depthField`.

### U3. Skills (0.42.0)
Skills are user-authored instructions, not code. They never grant tools (tools stay read-only by construction).
- **Format**: `SKILL.md` with frontmatter `name`, `description` and a markdown body, one per folder
  `Second Brain/Skills/<name>/SKILL.md`. Hash recorded in each run record for reproducibility.
- **Storage access**: Obsidian reads and writes the vault folder directly. Zotero and the engine go through two small
  server endpoints in `kb.py`/`http_api.py`: `GET /skills`, `GET /skills/<name>`, `PUT /skills/<name>`,
  `DELETE /skills/<name>` (delete moves to a `.trash` folder, never removes outright). Bearer token as for other endpoints.
- **Engine** (`agent-src/src/skills.js`): `loadSkills`, `renderSkillBlock(skill, cap)`; the chosen skill's body is added
  as a "Skill" section to the lead, researcher and extract prompts, capped at 6,000 characters (longer is cut with a
  notice on the step line). The user record gets `skills: [name]`.
- **UI** (`ui-src`, shared by both hosts): "Skills" in the composer's `+` menu (Attach file, Add from library, Skills);
  a dialog with All / By you / Built-in tabs and search; "Create skill" with three routes: *with the assistant*
  (one turn drafts SKILL.md from the user's description; the user edits before saving), *upload* a `.md`, or *by hand*
  (name, description, instructions). "Use skill" inserts a chip in the composer; the chip is removable.
- **Built-in starters** (generic, invented examples only, public repo safe): compare options across a series of
  items, literature gap analysis, one-page overview, reproducibility review of a paper. The three report formats Elicit
  offers (General Review, 1-Page Overview, Research Gap Analysis) ship as built-ins here instead of a separate picker.
- **Safety**: skill text is trusted as the user's own prompt; skills read from other sources are shown in full before
  first use. Oversize or malformed files are listed with a warning, never executed partly.
- **Tests**: parse/validate frontmatter; cap and notice; endpoints reject path traversal (`../`) and names with separators; both hosts list the same skills (class-tree drift test).
- **Check**: create a skill with the assistant, edit it in Obsidian, see the edit in Zotero within one refresh; a run with the skill records its hash and the output follows its instructions on a fixture question.

**Result (2026-10-07, 0.42.0 pending publish).** Built: `skills.py` + `GET /skills`, `GET|PUT|DELETE /skills/<name>` in `http_api.py`
(one-segment names, no `..`, atomic save, 64 KB cap, delete moves to `Skills/.trash`, bearer token for non-local hosts, refused
for agents); engine `skills.js` (front matter parse, SHA-256, `renderSkillBlock` with the 6,000-character cut and notice, a store
over a `SkillSource`, the five built-in starters, a data-folder source for Zotero without the server, the assistant draft turn);
`AgentService.skills` (list/get/put/remove/draft) in local, remote and agentd. A skill goes into chat turns (`SendInput.skills`; user
record `skills: [name]`, reply `skills: [{name, hash}]`) and into reports (`ReviewRequest.skills`, resolved once at start and kept
in request.json with name, hash and text; `progress.skills`). UI: Skills dialog (All / By you / Built-in, search, create with the
assistant / upload / by hand, edit, delete, view and copy a starter), "Use skill" chips in the composer (Skills row in the `+`
picker, a Skills button where the host has no picker; in a report `+` opens Skills), a "Skill:" line under the message and in the
report. Deviations: the skill block is also added to the candidates and writer prompts (a report format such as 1-Page Overview
has to reach the writer); the local (On this Mac) guarded turn ignores skills because it replaces the instructions; a Zotero with no
server keeps skills in its own data folder, which does not merge with the vault. Checks: python 19 new (temp vault; traversal,
separators, oversize, trash, token, agent refusal), engine 480 (16 + 3 new skills tests, incl. agentd + remote round trip), ui-src
100 (5 new), engine typecheck clean (ui-src typecheck shows the same 36 pre-existing errors as HEAD), obsidian-plugin tsc, build
and its 17 tests. Real Zotero `t-skills.js`: 17 of 18 checks passed on a fresh profile (list, tabs, search, create by hand, with
the assistant, upload, name refusals; the 18th was a test bug, fixed); the rest of the file (outside edits, warnings, chip, chat
turn with hash, report request, delete to .trash) and t-unified-chat, t-chat-look, t-depth, t-gap-fill were NOT re-run: Zotero.app
was replaced at 07:29 and now aborts at launch (exit 134, even with an empty profile). Live skill run not done.

### U4. Routines (0.43.0)
A routine is a saved, repeatable session. Decision: runs only while the server (or Zotero's runtime) is up.
- **Record** `data/agent/routines/<id>.json`: `name`, `prompt`, `skills[]`, `depth`, `schedule` (daily HH:MM or weekly
  weekday HH:MM), `target` (`artifact` ref or `new session each run`), `status` (`active|paused|archived`),
  `lastRun`, `nextRun`, `lastResult`.
- **Scheduler** in the engine (`agent-src/src/routines.js`): a one-minute tick while the runtime is up. On startup,
  a missed schedule runs **once** (no backlog of N runs). One routine at a time through the existing slot pool, never
  above the Mac's 6-process limit. A run is skipped, and logged, when the provider's window is above 50% used.
- **Incremental runs**: a routine over an artifact passes `since = lastRun` to the search tools and drops rows whose DOI
  is already in the target, then writes a new version. A "what changed" view highlights added rows.
- **Notification**: a card in the Routines list, plus an optional one-line summary through the existing Telegram helper
  (`hermes send`) when the user has set it. Off by default.
- **UI**: a Routines view (Active / Paused / Archived) from the mode menu and sidebar; suggested templates (daily
  preprint digest for a topic, weekly new-papers watch for an author or topic, citation watch for one paper);
  "Create routine for artifact" in the artifact menu; Run now, Pause, Archive.
- **Honest limit shown in the UI**: "Routines run while Second Brain is running." If the KB server is not running at the
  scheduled time they catch up the next time it starts.
- **Tests**: schedule math (next run across DST and weekday boundaries) with an injected clock; catch-up runs once; skipped-window logging; incremental dedupe by DOI; concurrency cap.
- **Check**: create a daily routine, stop and restart the server past its time, see exactly one run and one new version; a second run with no new papers writes no new version.

## 6. Cross-cutting rules

- Tools stay read-only; every write (results, versions, skills, routines) is done by our own code after a turn.
- Public repo: invented fixtures only, no personal data in specs, skills or tests.
- Every unit: unit tests in `agent-src` and `ui-src`, a real-Zotero harness test for the new UI, and both apps built and opened.
- Cost: new model turns (assistant-drafted skills, follow-ups) are one structured field on turns that already happen, except skill drafting, which is one turn the user asks for.
- Back-compat: no existing session, chat, review or saved search changes on disk when opened (hash check, spec 007 check 4).

## 7. Verification gates (per unit and at the end)

1. `npm test` in `agent-src` and `ui-src`, `npm run typecheck`, all green.
2. Real-Zotero harness suite on fresh profiles (one test per profile; they pollute each other otherwise).
3. Perf gate (`perf/gate.sh`) once a clean baseline exists; the baseline needs a quiet machine.
4. One live run with the real provider per unit (U1: two depths; U2: add column + gap fill; U3: a skill run; U4: catch-up run).
5. Owed GUI checks in the real Zotero and Obsidian windows, done with the user (the app cannot be screenshotted without taking over the screen).

## 8. Risks and how the plan handles them

- **Quota and memory**: live runs spend provider quota and need free RAM. Run them one at a time, only on a quiet machine (the machine was swapping heavily on 2026-10-05).
- **Skill text that misleads the agent**: capped length, shown to the user, hash recorded, no tool grants.
- **Routines silently not running**: the UI states the "while running" limit; catch-up runs once; a missed-run notice is logged. If the user later wants reliability, a KB-server LaunchAgent is a separate action that needs their explicit OK.
- **Estimate accuracy (U1)**: if `sessions.estimate` is off by more than 25%, the label shows a range rather than a point.
- **Resolved**: `sessions.estimate` prices column steps only; U1 adds a report estimate (see U1).

## 9. Not in this plan (and why)

- Projects (grouping sessions) and the Library "New from selection" panel: not chosen. They are small follow-ups once Skills and Routines exist.
- Clinical trials as a source, payments, team collaboration: already non-goals in spec 007.
- Direct cell editing: Elicit itself routes edits through the agent; we follow that, which keeps versions and quotes consistent.

## 10. Files to touch (known) and create

Touch: `ui-src/src/chat/chat.js` (depth control), `ui-src/src/chat/artifact-panel.js` (column changes, menu items),
`agent-src/src/settings.js` (depth table), `agent-src/src/sessions.js` (estimate, `column_change`, `fill` step),
`agent-src/src/extract.js` (gap-fill targeting), `agent-src/src/prompts.js` (skill block, followUps field),
`agent-src/src/review2.js` (depth knobs), `kb.py` and `http_api.py` (skills endpoints).
Create: `agent-src/src/skills.js`, `agent-src/src/routines.js`, `ui-src/src/chat/skills-dialog.js`,
`ui-src/src/chat/routines-view.js`, `specs/011-elicit-parity/spec.md` and `plan.md` (this plan, copied in), built-in skill files, tests for each.

**U4 result (2026-10-07, published with U3 as 0.43.0).** Routines: pure schedule math/store/scheduler (54afb7a),
engine wiring + usage memo + report usage line (f1d615f..0917394), Routines view/sheet, "Create routine for this",
new-row highlight, estimate range label (4b85a91), review fixes (2ea9c56: re-read before claim, invalid records
skipped, claim-block failures recorded; skills.py skips symlinks 7003c6e), Zotero-scope structuredClone fix (4aa81be).
Live-check fixes from 0.40/0.41: gap fill keeps "not reported" on a failed read and counts failures (e4b5b66, b257492),
estimate recalibrated (standard 14 vs 15 actual, was 22) with a range, library search timeout is an error not 0 results
(2e78910). Checks: engine 507, ui-src 105, python skills 21; real Zotero t-skills 36/36, t-routines 30/30, t-depth,
t-gap-fill, t-columns, t-unified-chat, t-chat-look, t-papers-chat, t-sidebar, t-find-papers, t-report all green.
0.42.0 was never published on its own. Owed: live skill run and live routine catch-up run with the real provider;
real-window GUI checks in Zotero and Obsidian.

**U5 result (2026-10-07, design u5-design.md).** The user asked to close every open item, including the two left out in section 9.

Built:
- Projects engine 92aa872: project-store, conversation `project` records, ReviewRequest.project, six agentd routes, Zotero hand-over.
- Projects UI 9b271a4: a switcher at the top of the history, and a `...` / right-click menu on each chat and report row.
- New from selection d7e188b, e80d27e, db59a7d: the empty-chat card and a "Second Brain AI" item submenu. Starts are guarded because the menu command fired three times.
- One-click provider switch on "not installed" errors: 53db52f.

Look fixes from screenshot checks:
- 0.43.3 routine cards.
- Zotero's 25px button max-height is lifted for our buttons (18b79ca).
- Obsidian cards and primary buttons (cc633c2).

Live checks:
- A real routine run wrote a report with 56 papers.
- Outside-library abstracts were filled for 40 of 41 DOI rows, and the text matched OpenAlex.

Gates:
- engine 540; ui-src node 125 + Playwright 779 (all green); python 40; obsidian tsc + tests.
- Real-Zotero: t-projects 33, t-new-from-selection 19, t-provider-switch 10, plus the full suite.
