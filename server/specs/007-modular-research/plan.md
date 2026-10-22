# Plan: Modular research, with data as the results

Status: DRAFT 2026-09-26, awaiting review together with spec.md. Nothing built yet. Starts after spec 005 C4
(the shared chat runs in both hosts); spec 006 (auto-update) and 005's D units are independent of it apart from
the order question in spec.md.

## Before starting

- Spec 005 C1–C4 done: `ChatView`, `FindView`, `ReportView` live in `ui-src/src/chat/`; both hosts load them;
  the drift test passes. 007 edits those shared files, never the per-host copies.
- Clean trees in `zotero-plugin` (git) and `obsidian-plugin` (local git from 005 decision 4).
- Baseline pictures from the ui-src harness (both maps, light / dark) and the Zotero harness, to compare after
  E3 and E6.
- A fixture session folder under `ui-src/dev/fixtures/` and `agent-src/test/fixtures/`: invented papers only
  (public repo rule).

## Where the code is

- Engine: `agent-src/src/domain.d.ts`, `service.d.ts`, `tools.d.ts`, `store.js` (conversation JSONL, `adopt`),
  `core.js` (`createLocalRuntime`: `conversations.send`, `ask`, `reviews.*`, `TurnRunner`, `defaultToolContext`),
  `tools.js` (tool rows), `review.js` (stage tables, `WAIT`, `deriveStatus`, `reviewProgress`), `report.js`
  (`screen`, `renderReport`), `prompts.js` (schemas and prompts), `settings.js` (roles, turn limits),
  `eventlog.js`, `remote.js`, `node/agentd.mjs` (route table; the Python server forwards `/agent/*` unchanged,
  so no `http_api.py` change), `providers/{codex,claude,openai}.js` (reasoning events).
- Shared UI: `ui-src/src/chat/{chat,find-view,report-view,markdown}.js`, `ui-src/src/host.d.ts`,
  `ui-src/styles/`, `ui-src/dev/harness/fake-host.js`.
- Hosts: `zotero-plugin/content/ui-host-zotero.js`, `discover.js`; `obsidian-plugin/src/ui-host.ts`.
- Tests: `agent-src/test/*.test.js` (node --test), `ui-src` `npm test` (unit + Playwright harness),
  `agent-src/dev/zotero-harness/tests/`, `obsidian-plugin/dev/smoke.mjs`.

## Stage E: modular research

Each unit ends with: agent-src `npm test` + `npm run typecheck`, ui-src `npm test`, every Zotero harness test,
Zotero xpi built and installed, Obsidian built and installed (smoke), agentd restarted when the engine changed,
and a short Result section added here. Versions: Zotero minor +1 and Obsidian minor +1 per unit that ships UI.

### E1. Steps and results in the engine (no UI change)

- `domain.d.ts`: the §1.1–1.3 types (`ResultRef`, `PaperRow`, `ColumnSpec`, `Cell`, `Result`, `StepInput`,
  `SessionRecord`, `ResultSummary`); `ConversationSummary` gains `artifacts` and `kind`.
- `sessions.js` (new, pure where it can be): `manifest(records)` rebuilds steps, results and the current result
  from the JSONL; `legacyView(records)` maps old chats to steps with virtual `answer` results; result file paths;
  next `S`/`R` ids.
- `store.js`: result versions under `chats/<id>.d/results/`, written with `writeAtomic` before the `result`
  record is appended; `adopt` copies `.d` files with keep-the-first.
- `service.d.ts` + `core.js`: `sessions.view(id)`, `sessions.read(id, ref)`, `sessions.put(id, input, draft)`
  (for `find` / `import` / `narrow`), `sessions.restore(id, ref)`, `sessions.setCurrent(id, ref)`;
  `SendInput.on?`; `ToolContext.session?`.
- `tools.js`: `read_result` row (activity kind `result`), the manifest block in chat instructions, and the
  `chat_papers` tool narrowing when `on` is set.
- `agentd.mjs` routes `/sessions/view|read|put|restore|current`; `remote.js` client for them.
- Legacy importers (pure, in agent-src so both hosts share them): `papersFromFind(saved)` for both Zotero and
  Obsidian saved-search shapes, `papersFromReview(screened)`.
- Tests: manifest from a hand-written JSONL; an old chat JSONL loads as steps with no file written (hash
  check); put → read round trip, V1 → V2 → restore V3; crash between result file and record (file ignored);
  adopt copies results once; `read_result` paging, column selection, `seen` includes outside DOI refs;
  citation validator resolves a DOI link from `read_result` (spec check 6); a scripted provider asked a
  follow-up calls `read_result` (spec check 5).
- Verify: the above; `dev/ask.mjs` extended with `--session` against agentd: put a fixture paper set, ask about
  it, the transcript shows `read_result` and no `search_*`.
- Both apps: unchanged (no UI calls the new API yet).

### E2. Activity lines and folded reasoning

- `domain.d.ts`: `ActivityLine`, `reasoning` / `line` events, activity `result` kind.
- `activity.js` (agent-src, pure): `compactActivities(events)` per spec §3.2; `linesFromLabels(activities)` for
  old records.
- Providers: forward reasoning where the wire has it (Codex reasoning summary items, Claude thinking blocks,
  OpenAI-compatible `reasoning_content`). First task: confirm the exact event names from a recorded transcript of
  each (`dev/scan-transcripts.mjs`); a provider without them just emits none.
- `core.js`: assistant records store `lines` and `reasoning` (≤ 4,000 chars); reasoning is never replayed as
  history.
- ui-src: `ActivityLine` component (icon, title · detail, chevron; running = one live line; expanded = grey
  reasoning + labels); the chat and FindView use it instead of one `sb-ai-activity` per tool call.
- Tests: compaction table (searches only, reads only, mixed, failed call, reasoning only, `read_result`);
  old record folds to "Used N tools"; harness pictures collapsed / expanded, both maps.
- Verify: a real Codex chat and a real Claude chat each show one line per step and a reasoning fold when the
  provider sent reasoning (spec check 14, chat part); t-chat-look and t-unified-chat pass (update selectors only
  where they counted per-tool lines, and say so in the Result).

### E3. Artifacts: result cards, side panel, versions, export

- ui-src: `ArtifactCard`, `ArtifactPanel` (header, version menu, download menu, expand, close, toolbar with
  Search and Sort; Filters and Columns arrive in E4), table renderer with sticky first column, citation chips and
  the quote popover, the three width layouts of spec §4 (the < 560 px card list), "Artifacts (N)" header list.
- Exporters (`ui-src/src/export/`, pure): CSV (with optional quote columns), RIS (moved from find-view), Markdown.
  `UiHost.saveFile`: Zotero save dialog; Obsidian vault write under `Second Brain/Exports/` + "Save as note".
- Find papers writes its result: a new search calls `sessions.put({ kind: "find" … }, papers)`; the table in
  the thread is the ArtifactPanel's table in "main pane" mode. Old saved searches still open in the old path
  and import on first step (spec §1.4).
- Chat tables: `sb-table` block parsing in `core.js` after `done` (`TABLE_SCHEMA`, citation validation, `revises`
  → V+1), `result` event, fallback notice.
- Tests: exporter goldens; `sb-table` parse / fallback; harness: card → panel open, version switch and restore,
  search and sort, each width (960, 700, 360 px) with measured "no horizontal scroll" at 360; Zotero
  `t-artifacts.js`; Obsidian smoke opens a panel and exports CSV into the vault.
- Verify: spec checks 3, 7, 15 (minus filters/columns); a real "make a table of …" chat produces a table
  artifact in both apps.

### E4. Columns and filters on paper sets

- agent-src `extract.js`: batching (8 abstracts / 1 full text per turn), `EXTRACT_SCHEMA`, text supply via
  `library.read`, quote check (pure), partial file + `cell` events, stop / resume, caps from `settings.research`;
  role `extract` in settings (default = researcher's choice), turn limit 3 min, tool budget 0.
- `sessions.run(id, { kind: "columns" … })` + `sessions.cancel(id, step)`; its own eventlog key per step so a
  chat can continue while a step runs; agentd `/sessions/run`, `/sessions/events`, `/sessions/cancel`.
- discover.js and the Obsidian OpenAlex path keep study-type data (S2 `publicationTypes`, Europe PMC
  `pubTypeList`, OpenAlex `type`) and `fullText` / `pdfUrl` / `citations` on rows.
- ui-src: `ColumnsPanel` (free text + presets), confirm line with turn estimate, skeleton cells filling live,
  Stop / "Fill the rest"; `FiltersPopover` (spec §5.3 table, data-gated), "Keep these N" → `narrow` put.
- Settings UI (both hosts): the `extract` role row next to the other roles.
- Tests: batch planner (row / cell counts → turns); quote check with planted wrong quote; stop mid-run then
  resume fills only pending cells; filters on the fixture set, hidden when data is absent; harness pictures.
- Verify: spec checks 8, 9, 10; a live 20-paper, 3-column step in Zotero with ≥ 90% verified quotes; the same
  set filtered and narrowed in Obsidian.

### E5. Chat with papers

- ui-src: side-panel tabs "Chat with papers | Columns" when a paper set is the main pane; scope line (ticked /
  visible / all); answers mirrored in the thread; "Papers | Chat" tabs under 560 px; expand-swap from E3 wired to
  it.
- Engine: `conversations.send` with `on` (E1) — instructions for set-only answers, inline titles on the first
  turn.
- Tests: recorded `SendInput.on` for ticked vs filtered vs all; a scripted answer's citations resolve inside the
  set and a citation to a paper outside it shows red; harness pictures at 960 and 360 px.
- Verify: spec check 6; a real question over a 20-paper set in both apps answers without any `search_*` call.

### E6. Add step, grouped menu, empty state

- ui-src: mode menu with Workflows / Tools groups (names per open question 1); "+ Add step" menu filtered by the
  current result's kind; the "On: …" current-result chip in the composer; Chat with papers / Extract data
  starting from a picker (`import from: "selection"`); empty-state cards from `conversations.list()` (recent
  sessions first, then context suggestions); history icons by first step kind and artifact counts; saved
  searches hidden once imported.
- Tests: menu contents per result kind; empty state with 0, 1 and 5 sessions; an old saved search imports once
  and disappears from the history; harness pictures.
- Verify: spec checks 1, 2, 16; the full check-1 session done by hand in Zotero and repeated in Obsidian.

### E7. Clarify, plan, and reports written from the table (pipeline 2, Research report)

- `review.js`: `REVIEW_STAGES_2` (clarify, plan, approve, search, screen, extract, synthesize, publish), table
  chosen by `request.pipeline`; `awaiting_answer` status; `reviews.answer`; `lines` and `counts` in
  `ReviewProgress`, derived from files.
- `prompts.js`: `CLARIFY_SCHEMA` (≤ 2 questions, 2–4 choices), plan schema with optional criteria / columns /
  assumed / caps, candidate-returning researcher prompt, writer prompt over `table.json` with evidence →
  cells links; `REPORT_SCHEMA` evidence gains `cells` and `rows` (optional, so pipeline-1 reports still parse).
- Screening as criterion columns and extraction through `extract.js` (E4); report caps by depth.
- `report.js`: `renderReport` renders the method counts and an extraction-table appendix for pipeline 2.
- Session link: a report step records `request.session`; its `table.json` and candidates show as pointer
  artifacts in the session; "Write a report from this" (`synthesize` step) runs only the synthesize stage on a
  session table.
- ui-src: `ClarifyCard`; plan card gains criteria (Strict / Preferred on hover) and "Columns to extract";
  ReportView shows the stage lines from `lines`; clicking an evidence claim opens its cells' quotes.
- Tests: pipeline-1 review fixtures (including one paused at approve) resume unchanged; clarify with 0 questions
  never waits; answer → resume; restart while waiting; evidence → cells round trip; method counts equal the
  files; golden report render for pipeline 2.
- Verify: spec checks 4, 11, 12; one real quick report in Zotero (Codex) and one started from Obsidian.

### E8. Systematic review

- `Protocol` (PICOS) in the plan schema and card; ≥ 1 strict criterion required; columns seeded from outcomes;
  larger caps confirmed on the card; the unclear-rows `WAIT` above 10%; user overrides in the screening view
  (the artifact panel with the Screening filter); method section with per-criterion exclusion counts and
  overrides.
- Mode menu: Systematic review appears (hidden before this unit, never shown greyed out).
- Tests: protocol schema; decision derivation (strict no excludes, unclear keeps, override wins and is counted
  separately); the 10% rule; golden method section.
- Verify: spec check 13; one real systematic review on a narrow question with ~100 candidates, reviewed by the
  user.

## Recommended order and why

E1 → E2 → E3 → E4 → E5 → E6 → E7 → E8.

- **E1 first**: every other unit reads or writes results; building the store and `read_result` with no UI change
  means both apps keep working and the data model gets tested before anything draws it.
- **E2 next**: small, visible, and independent of results; it also gives E4's extraction and E7's stages the line
  component they report through.
- **E3 before E4/E5**: columns and chat-with-papers both live in the panel's layout.
- **E6 after the pieces exist**: Add step can only offer steps that work.
- **E7/E8 last**: they reuse extraction (E4), clarify needs the card style settled, and they change the review
  engine, which has the most saved state to keep compatible.

## Verification summary

| Unit | Automatic | Real app |
| --- | --- | --- |
| E1 | agent-src store / manifest / legacy / `read_result` tests, scripted provider | `dev/ask.mjs --session` against agentd |
| E2 | compaction table, legacy fold, harness pictures | Codex and Claude chats, both apps |
| E3 | exporters, `sb-table` parse, harness widths (measured), t-artifacts | chat-made table + CSV export, both apps |
| E4 | batch planner, quote check, stop / resume, filters | 20 × 3 live extraction (Zotero), filters (Obsidian) |
| E5 | `on` recording, set-only citations, harness | set-only answers, both apps |
| E6 | menu per kind, empty state, import-once | the spec check-1 session in both apps |
| E7 | pipeline-1 compatibility, clarify, evidence → cells, goldens | quick report, Zotero + Obsidian |
| E8 | protocol, decisions, 10% rule, goldens | one systematic review, user-reviewed |

Each unit ends with both apps built and installed (memory: "always install after building") and a short Result
section added here, as in specs 002–005.

## Result: E3 engine (chat tables)

- `agent-src/src/table.js` (new): `TABLE_SCHEMA`, `TABLE_INSTRUCTIONS`, block extract / `parseTable` / `buildTableResult` / Markdown fallback. `core.js` `finishTable` runs at the chat turn's `done`: writes the `table` result (new, or V+1 via `"revises"`; row ids kept by label), then `step` / `result` / `step_end` records, strips the block from the stored answer, and emits `{type:"result", summary, step}` before `done` (so the remote client, which stops at `done`, still gets it; eventlog and remote forward it unchanged).
- A bad block stays as a Markdown table; `done.notice` and the assistant record's `notice` carry "Couldn't turn this into a table". Invalid cites are dropped from the cell and counted in the version's `change` line.
- Deviation: chat turns did not write a `chat` step before this, so only a turn that makes a table writes step records (a plain chat is byte-identical to before and stays legacy). `list()` artifacts/kind was already done in E1 (`summaryExtras`).
- The live `text` deltas still contain the block while streaming; the UI must hide an open `sb-table` fence until `done` replaces the text.
- Tests: `test/sb-table.test.js` (8); suite 253 pass, typecheck clean. Real run: Claude provider via `dev/ask.mjs --session` (temp data dir) wrote `chats/<id>.d/results/R2/v1.json` and emitted the `result` event.

## Result: E3 UI (artifacts, ui-src only)

- New: `src/export/` (csv, ris, markdown, save; pure, goldens in `test/golden/`), `chat/artifact-card.js`, `artifact-panel.js` (header, version menu, read-only old versions with "Restore as V(n+1)", download menu, expand, close, Search, Sort, ticks), `artifact-table.js` (sticky first column, grey citation chips with quote popover, skeleton cells, card list below 560 px), `artifact-data.js`, `popover.js`. `UiHost.saveFile?` is optional; Download falls back to `exportRows` (CSV/RIS), then a Blob download.
- `chat.js`: cards under answers (from `result` events and from `sessions.view` + `step_end` on reopen), "Artifacts (N)" list, layouts 960 / 560 / 360 with a drag handle (each side at least 360). Streamed `sb-table` fences are hidden ("Making a table…"); `done.notice` shows. `markdown.js` now renders GitHub tables (the fallback needs it).
- Find papers: after rows and summary, `sessions.put(find step, PapersResult)` in a session of its own (`conversations.create`); the saved search stores `session`, the history hides `kind:"find"` sessions, old searches open unchanged.
- Tests: node 29 pass; harness adds 70 artifact checks (three widths with measured no-scroll at 360, both token maps, light/dark, parity). `npm run typecheck`: 35 errors, all in `dev/harness/perf-common.js` and present before this unit; none in new code.
- Deviations: expand hides the thread (Chat-with-papers side panel is E5); panel opens without a slide animation; no Add to Zotero on ticks yet; Filters/Columns left for E4.

## Result: E4 hosts (discover.js, Obsidian OpenAlex, settings rows)

- `content/discover.js`: OpenAlex `open_access` requested; S2 `publicationTypes` requested; Europe PMC `pubTypeList` kept (already in `resultType=core`). Every row now carries `studyType`, `fullText`, `pdfUrl`, `citations` (null when the source gave none; arXiv has no count). Study type is mapped only from a stated label (`studyTypeOfLabel`): OpenAlex `type: "review"` gives review, anything else null; S2/Europe PMC labels give meta_analysis / systematic_review / rct / longitudinal / review, "other" for a named non-design type (ClinicalTrial, Editorial...), null for JournalArticle. The dedupe merge fills missing fields from the later duplicate.
- `content/ui-host-zotero.js`: `searchOutside` passes the four fields (extra properties: `OutsidePaper` in host.d.ts lacks them). Library rows (`libraryPaperRow`, now async) get `fullText` (a PDF/HTML/text attachment file exists on disk) and `studyType` from tags / Extra "Publication Type:" lines only, null when labels conflict.
- Obsidian: new `src/paper-meta.ts` (pure), `ui-host.ts` OpenAlex rows spread `metaFromOpenAlex`; Obsidian library rows have no such data, so those filters hide there.
- Settings: `extract` row "Reading papers for columns" plus the hint, in `content/preferences.js` and `src/main.ts`. Both role lists are hard-coded in the hosts (not derived from the engine). The row has a "Default" option that calls `setRole("extract", null)`; the engine must accept null (= researcher's model) and `roles()` may omit `extract`.
- Tests: `obsidian-plugin` `npm test` 17 pass (2 new tests in `paper-meta.test.ts`); `zotero-plugin/test/discover-meta.test.mjs` 4 pass (loads discover.js in node). `tsc -p .` 0 errors.
- Real APIs: OpenAlex returns `type:"review"`, `cited_by_count`, `open_access.oa_url`; `best_oa_location` was null for a green-OA review while `oa_url` existed, hence the `oa_url` fallback. Europe PMC returns `pubTypeList.pubType: ["review-article","Review","Journal Article"]` and `["Meta-Analysis","Journal Article"]`. Semantic Scholar answered 429 (keyless, not retried), so its field names are unverified live.

## Result: E4 engine (columns, agent-src only)

- New `agent-src/src/extract.js`: `EXTRACT_SCHEMA` (rows, then a list of `{column, status, value, quotes}` cells, so the schema is the same for every column set and works with strict structured output), pure planner (`planBatches`: abstracts 8 a turn, `best` 1 a turn; papers with no text are skipped and cost no turn), `selectTargets` / `estimateStep` (caps), `checkQuote` (whitespace, case, curly quotes and dashes folded), `textFor` (library full text up to 20,000 chars, else abstract), `extractBatches` (worker pool; a failed batch fails only its cells), `versionCells`. Criterion columns answer yes / no / unclear.
- `core.js`: `sessions.run|estimate|events|cancel`. Turns go through `runner.structured("extract", …)` with `ToolContext.none` (no tools offered, any tool call fails the batch: budget 0). One event log per step (`<session>/<step>`); each batch appends to `steps/<S>.partial.jsonl`, emits `cell` + `progress`; the end writes V+1 (`from: [on]`, change "Added columns …"), the `result` record, `step_end` and the `end` event. Stop = `cancelled`; runtime `dispose` = `stopped`; a step with no `step_end` and nothing running it (crash) is settled from the partial file on the next `view` / `run` / `events`. One columns step at a time per session. `events` on a step this process has no log for answers with one synthesized `end`.
- Settings: role `extract` (unset follows the researcher; `roles()` reports `extract: null` when unset; `setRole("extract", null)` and `update({roles:{extract:null}})` clear it; other roles refuse null), wall clock 3 min, tool budget 0; `research` block `{askFirstRows 50, askFirstCells 200, maxRows 400, concurrency 3}` (`settings.research()`); concurrency never above the pool total (6). Default slot limits gain `extract: 3`.
- Wire: agentd `POST /sessions/run|estimate|cancel`, `GET /sessions/events` (long-poll batches of `{seq, ...StepEvent}`, returns at the first quiet moment; giving up is an abort of the subscription, `eventlog.subscribe` now wakes on abort); `remote.js` client for all four.
- Contract notes for the UI: `estimate.rows` is rows asked for, `cells`/`turns` are what would run after the `maxRows` cap. `rows: "pending"` takes only pending and failed cells (rows never touched are not "pending"). Cells of unselected rows have no entry (not `pending`).
- Bug found by the real run: the Claude CLI delivers a structured answer through a synthetic `StructuredOutput` tool, which showed as "Using StructuredOutput" activity and tripped the zero tool budget. `providers/claude.js` now drops it (also removes that line from review activity).
- Tests: `test/extract.test.js` (18) plus one updated assertion in `local-runtime.test.js`; suite 272 pass, typecheck clean.
- Real run (`dev/extract.mjs`, Claude provider, 6 invented papers with realistic abstracts, 2 columns, abstract mode): 1 turn, 6.4 s, 12 of 12 cells filled, 12 of 12 quotes verified (ratio 1.00). The first attempt (before the fix above) failed all cells with the tool-budget error; 2 turns of quota in total. Not yet run: Codex, `best` (full text) mode, 20-paper live step.

## Result: E4 UI (columns, filters, live fill; ui-src only)

- New: `chat/columns-panel.js` (search or create a column with an example, Current columns with the instruction on hover, drag or arrow-key reorder, ×; nine presets as quiet "+" rows; staged "Ready to add" chips; "Fill N columns" then the one-line confirm with Continue / Only the first 50 / Not now), `chat/filters-popover.js` (Cancel / Apply; a section only when rows carry its data), `openSheet` in `popover.js` (Filters and Columns are full sheets below 560 px). Pure logic in `artifact-data.js`: `PRESETS`, `filterOptions`, `applyFilters`, `describeFilters` / `removeFilter`, `keepWhy`, `narrowDraft`, `withoutColumn`, `withLive`, `cellProgress`, `restCells`, `untouched`, `confirmLine`. Icons `filter`, `columns`, `plus`, `grip`.
- `artifact-panel.js`: Filters and Columns buttons (Filters hidden when no row carries data for any filter; Columns only on the latest version and only when the engine has run / estimate / events), removable filter chips, "Showing N of M", "Keep these N" (ticked visible rows, else the visible rows) as a `narrow` put whose `why` lists the filters ("Kept 18 of 40: has PDF, 2020-2026"), then opens the new set (`onNew` hook, `chat.js`). Filters, search, sort and column order are view state in host prefs per session and result (`artifactView:<session>:<result>`), never a version.
- Live fill: `sessions.estimate`, then `sessions.run`, then `sessions.events` (cell / progress / end). New columns show at once with skeleton bars; each `cell` event swaps just that cell (batched, 120 ms; the rest of the table, buttons and scroll are never rebuilt, so Stop and ticks stay clickable). Progress line "Filling 3 columns · 12 of 40" with Stop (`sessions.cancel`). On end the panel reads the version the step wrote and shows V+1. Banner: "Stopped - 24 of 80 done" after a Stop, "150 of 360 done" otherwise, with "Fill the rest". Dashed underline on values with no verified quote, "Unverified" on such chips, "Not reported in the abstract" for not_found, a small Retry on failed cells.
- Host types: `OutsidePaper` and `LibraryPaperRow` gained optional `studyType`, `fullText`, `pdfUrl`, `citations`; `FindView` carries them into `PaperRow` only when the source gave them (Obsidian library rows have none, so those filters stay hidden there).
- Tests: node 41 pass (12 new: filters on the fixture set, "a filter whose data no row has is not shown", chips and `why`, saved filters, order, narrow draft, presets and specs, confirm line, progress / overlay / remove column). Harness: `dev/columns-checks.mjs` adds 54 checks (preset to skeleton to cells to V2; confirm line for 120 rows; Only the first 50; ticked rows; Stop then "Fill the rest" fills exactly the missing cells; Retry; reorder and remove; Filters gating, Cancel / Apply, chips, persistence, Keep these N; bare rows offer no Filters; 360 px sheets and filling measured with no horizontal scroll; both token maps light and dark with identical class trees for the Columns popover, the progress line and the Filters popover). The fake engine is in `dev/harness/fake-host.js`. Typecheck: 35 errors, all the old ones in `dev/harness/perf-common.js`; Obsidian `tsc -p .` shows no ui-src error (one remaining error, `src/main.ts` line 358, `RoleChoices` with `extract: null`, is the hosts unit's).
- Screenshots read (`dev/out/*.png`): popover, confirm line, stopped banner, filters (both maps, dark), 360 sheets and filling. Fixed from them: the sheet had inherited the popover's class (340 px wide, 570 px tall, 364 px scroll) so it did not cover the panel; Search took a whole row so Columns wrapped alone (basis 96 px now); Cancel / Apply scrolled away in the tall Filters popover (sticky now); the Stop button was rebuilt on every progress event and could not be clicked (progress bar now updates in place).
- Deviations and assumptions: remove column is `sessions.put` with `{kind:"columns", add:[], rows:[]}` and a draft carrying the existing result id (the engine makes V+1; a dedicated step kind would be cleaner). Reorder is view state, not a version. Retry re-adds that column for that row (`add:[spec], rows:[row]`; the engine replaces an existing column in place); a limited step's untouched rows are "Fill the rest" by re-adding the columns for those rows because `rows:"pending"` skips them (engine note). The progress numbers are the engine's `done` / `total`; the stopped banner counts cells from the version. "Keep these N" makes no card in the thread (no answer to hang it on); it shows in "Artifacts (N)". Abstract contains: every entry must appear; does not contain: none may. "In library / outside" shows only when the set has both.

## Result: E5 engine (chat with papers, agent-src only)

- `conversations.send` with `on` is now a `chat_papers` turn. The set is pinned to a version (`on.result.version` filled from the latest when absent); a missing or non-papers set fails cleanly (`bad_output`, no step). Tools: `read_result` (that result only; the subset is a hard limit, the model's own `rows` can only narrow it) and `read_source` (only library papers that are rows of the subset). The gateway drops every other row for such a turn, MCP rows included, and the turn runs with web off and sources `{papers}` only. `read_result` now returns each row's abstract (capped 1,500 chars) on an `on` turn (plain turns: `abstracts: true` to ask), and says `[more rows: call read_result again with offset N]` when a page is cut. The real run showed the model otherwise saw titles only.
- Instructions: `CHAT_PAPERS_INSTRUCTIONS` (prompts.js) plus `TABLE_INSTRUCTIONS` plus a scope block (`chatPapersBlock`, sessions.js): every turn names the subset; the first turn of a set (no earlier user record with `on.result.id`) lists the subset's labels, titles, years (capped 6,000 chars, "... and N more").
- Records: user record gets `on` and `step`, then a `step` record `{kind:"chat_papers", text, on, rows}` (reads `[on.result]`); assistant gets `step` and `on`; `step_end` done / failed / stopped (finally) is written once. A table made in the turn joins that step (no second step), its `from` lists the `on` result (plus `revises`), `madeBy` is that step, `step_end.writes` is the table. Types: `domain.d.ts` (user and assistant records), `service.d.ts` (`load` doc).
- Citations: `restrictToRows` (citations.js) after the turn's validation: a cite to a subset row resolves (library by citekey, outside paper by DOI link in any doi.org spelling, no tool call needed); anything else, even a real library paper, becomes `unknown`. Applied before the table reads the citations, so cells drop outside cites too.
- Tests: `test/chat-papers.test.js` (11), suite 283 pass, typecheck clean.
- Real run (`dev/chat-papers.mjs`, Claude provider, temp data dir, 6 invented papers, all rows): tool calls `read_result` only, no search/web, records `step:S2:chat_papers` / `step_end:S2:done`, `user.on` set. Answer correct from the abstracts, but the model wrote outside papers as `[@10.9999/fixture.1]` (not a valid citekey form), so 0 citations were extracted. Prompt tightened afterwards (plain https://doi.org/ link, never `[@...]`); that fix has not been re-run live.
- Deviations: 3 real turns used (the first had no MCP mount in the dev script, so the model emitted a tool call as text). Table lineage uses only the current turn's `on` (a plain follow-up with no `on` gets none).

## Result: E5 UI (chat with papers; ui-src only)

- New: `chat/papers-chat-data.js` (pure: `chatScope` ticked / visible / all with the "All N" toggle, `describeOn`, `turnsOn`, suggestions, the table ask), `chat/papers-chat.js` (the tab: composer "Ask anything about these papers", scope line with the quiet toggle, suggestion pills, threads per result, "Make a table from this" under the newest answer, sent with the same `on`).
- `chat.js`: `askPapers(text, on, tab)` sends `conversations.send(id, { text, on, ... })` and streams every event into the thread turn and the tab turn at once (`stream` takes several turns; `handleEvent` split out; results noted once). `addUser` shows the recorded scope ("8 of 40 papers") and takes a container; `paintRecordedAnswer` is shared by a reopened thread and the tab. A reopened conversation rebuilds the tab from user records' `on.result.id` (`storedTurnsOn`).
- `artifact-panel.js`: structure is now main (head, tabs, set, chat pane) plus a chat column. A paper set at its latest version with rows offers tabs "Papers | Chat with papers" ("Papers | Chat" under 560 px); tables and older versions offer nothing (hidden). Expand (>= 960 px) makes the set the main pane, the thread goes away and the chat becomes a 400 px column with the same turns; expand again or x swaps back. Ticks, search and filters update the scope line live and drop the "All N" toggle.
- Tests: node 51 pass (10 new for scope, `describeOn`, `turnsOn`); harness 40 new checks (`dev/papers-chat-checks.mjs`): tab only for paper sets, hidden on an old version, recorded `on` for filtered / ticked / all, answer in tab and thread, red chip for a paper outside the set, Make a table, expand swap and back, restore after reopen, 700 / 360 px measured with no horizontal scroll, both token maps light and dark, DOM parity incl. the tab. Fake host records `on` on the stored user record like the engine. Typecheck clean (only old perf-common), Obsidian `tsc -p .` clean.
- Screenshots read (`dev/out/papers-chat-*.png`): answer beside the set, expanded column, 360 empty and answered (both maps, dark), 700. Fixed from the first run: citations used bare `(@key)` in my fixture so no chip drew (real syntax is `[@key]`); the "All N" toggle stayed on after ticking rows; the tab was built empty on reopen because it painted before the records loaded. The harness lacked the hosts' citation colours, so it now carries the same two rules.
- Deviations: while expanded the whole thread is replaced by the set's chat (turns about that result only), not the full thread; the tab is hidden for tables (E6's picker covers other sources); no slide animation.

## Result: E6 UI (menu, Add step, chip, empty state; ui-src only)

- New: `chat/steps-data.js` (pure: `MODE_GROUPS`, `normalizeMode`, `stepChoices(kind)`, `currentResult`, `ago`/`sessionMeta`, `historyEntries`, `cardSplit`, paper rows and `importDraft` for the picker; unit-tested). `chat.js`: mode menu is `<optgroup>`s (Workflows: Chat, Research report; Tools: Find papers, Chat with papers, Extract data, Quick answer; Systematic review not in the DOM). Saved `chatMode` values keep working; the two picker modes are never remembered. "+ Add step" (`.sb-addstep`, dashed quiet pill in the flow after the last thing in the thread) offers by the current result's kind: paper set Add columns / Keep filtered rows / Chat with these; table Chat about this table; report Chat about this report. Picking opens the panel on its Chat tab / Columns popover / Filters popover (`ArtifactPanel.startStep`), or, for table/report, puts the composer in Chat with "Ask about this table…". Chip "On: <title> Vn ×" in the box (only with results), x = start fresh; the panel header has a "…" menu with "Use for next step" (`sessions.setCurrent`, chip follows). Empty state: up to three session cards (title, kind icon, "Research report · 4 days ago", artifact count) above the unchanged context pills; history rows carry `kind-<kind>` classes, the kind icon, a count badge and a quiet dot while the open session runs. Picker for Chat with papers / Extract data (only when the session has no paper set; otherwise they open its set): Selected papers (hidden when none), A collection / A tag (only `host.can.scopes`), saved Find searches; it puts `import from:"selection"` (or `find:<id>`), then opens the Chat tab or the Columns popover.
- Saved searches: `FindView.list` now returns `session`. History lists a search whose JSON names an existing session once, as that session (the row keeps the search's id and `is-find` class, plus `data-session`, and opens the search table); an old search with no session imports on its first step (`import from:"find:<id>"`, rows from `FindView.papersResult()`, search JSON gets `session`), so no reimplementation of `papersFromFind` was needed in the UI.
- Tests: node 59 pass (8 new); harness 53 steps checks (`dev/steps-checks.mjs`, page `dev/harness/steps.html`): menu labels and groups, remembered mode, 0/1/5 sessions, card click, history icon/count/dot, Add step per kind, chip, Use for next step, each step's landing, recorded import put, Obsidian (no scopes) picker, collection pick, old search import once, both token maps light/dark at 360 px measured with no horizontal scroll, DOM parity. `dev/harness/fake-host.js` gained an opt-in conversation list. Typecheck: only old perf-common errors; Obsidian `tsc -p .` clean.
- Screenshots read (`dev/out/steps-*.png`): fixed from them: the Add step menu was squashed to a sliver (the shared popover's `max-height: 60%` resolved against the tiny wrapper); at 360 px the cards wrapped 2+1 with clipped meta (now one column below ~350 px); the history drawer hid the picker in the harness (pictures use it collapsed).
- Deviations: (1) Chat about this table/report sends no `on`, because the engine (core.js) fails a non-papers `on`; the chat is a plain turn in the session and `setCurrent` is recorded. (2) Collection / tag picks use `host.searchLibrary("", scope, 200)`; Zotero's local search with empty text is unverified, so an empty answer says "Couldn't find any papers there". (3) Selected papers are enriched by title search (`searchLibrary(label)`, matched by citekey), else a bare row. (4) The native `<select>` stays (grouped by optgroup), not a custom menu. (5) "Use for next step" is in the panel's "…" menu only, not on cards. (6) Cards do not cap the context pills (up to three cards, pills as before).

## Result: Live activity feed (engine + ui-src) and composer send placement

- Engine: the `activity` end event now carries optional `detail`, `count` and `source {kind: paper|note|web, title (80 chars), host?}`. Tools return `meta` beside their text (`search_library` "12 papers"/"8 results", `search_scholarly`, `related_sources` counts; `read_source` and `read_result` the title read); the tool session records it and core.js (`enrichActivity`) attaches it to the matching end event by tool name and arguments, for all three providers (the model sees none of it). Start labels: a `read_source` names the source by title when the session already knows it (from a search) or `library.resolve` answers within 350 ms, else "Reading a source"; Claude's WebFetch reads "Reading <host>"; `read_result` and related labels lost their raw ids. The end label reuses the start label.
- `activity.js`: `ActivityLine.entries?: ActivityEntry[]` ({id, kind, state, label, detail?, source?}) next to `items`; a page read (WebFetch or a web source) counts as a read, not a search, and titles say "read 11 sources · read 1 page"; `linesFromLabels` derives entries (kind guessed from the label); new `pastTense`.
- UI (`chat.js`, `find-view.js`, `icons.js`): a running turn's newest line is open and lists its steps: icon by kind (magnifier for searches, paper/note/globe/sparkle for reads and results), present tense with the shimmer while running then past tense, muted detail, running dot / check / red x; new rows slide in (not under reduced motion); the list is at most nine 22 px rows, scrolls to the newest, one line per row with ellipsis (safe under Obsidian's `button{white-space:nowrap}`). Reasoning streams as a grey "Thinking" block and folds to "Thought". At done/stopped/failed the line folds to its summary; the chevron (now a keyboard-reachable button) reopens the list. `turn.expanded` plus new `turn.closed` remember manual open/close. Find papers' summary uses the same list. Reopened chats fold, expand from `entries`; old records expand to labels.
- Composer: send moved out of the wrapping controls row into `.sb-ai-inputrow` beside the message box (bottom aligned); Stop stays there. Chat with papers already had send in its box; measured. Also `.sb-ai-suggestions { max-width: 100% }` (nowrap pills overflowed at 360 px).
- Tests: agent-src 293 (10 new), ui-src node 62 + harness incl. 75+ new live-feed and composer checks (`dev/live-checks.mjs`, page `dev/harness/live.html`), parity tree gained `activity-live`. Composer heights (monospace 15 px, nowrap, old arrangement emulated by moving send back): 360 px 205 -> 169 px; widths 360-900 never taller, largest saving 36 px (the lone send row).
- Deviations: no favicons (a globe icon with the host); "kept N facts / saved N documents" needs pipeline steps that emit them (Find/extract `line` events) and is not produced by tool activity; the harness `fold-state-survives` check now asserts the auto-open then close-stays-closed behaviour.

## Result: Live activity from the tool host

- Problem (measured with real Codex in Obsidian): the feed showed nothing for ~30 s, then 9 rows at once, then 9 more at ~55 s. Codex batches a script's nested `mcpToolCall` items and reports them late.
- Fix: the tool host reports its own calls. `tools.js` sessions gained `onActivity(listener)` and `isHostTool(name)`; `session.call` emits `{phase:"start", id:"h:<n>", kind, label, tool, args}` on entry (read labels wait at most 350 ms for a source title) and `{phase:"end", ok, label, ...meta}` on exit, with `detail`/`count`/`source` taken from the tool's own result.
- New `src/merge.js`: `mergeHostEvents` races the provider's `next()` against a wakeable queue (no polling), keeps order within each source, flushes queued host events when the provider ends, and after an abort gives a non-unwinding provider a 2 s grace. `dedupeHostTools` drops the provider's activity for our lib tools (bare or `mcp__lib__` names, plus Codex's "Running a tool script" wrapper) once the host has reported them; provider events for other tools (web search, WebFetch, third-party MCP, commands) pass through. Fallback: a provider lib-tool event is held until the host reports it (then dropped) or the provider says something else or ends (then released in order). `tools.none` turns and sessions without `onActivity` keep provider events.
- `core.js`: the turn loop reads the merged stream; host events skip `enrichActivity`. Stored `lines` use `compactActivities` over the merged events, same shape as before (ids of lib rows are now `h:<n>`).
- Tests: agent-src 299 (6 new in `test/live-activity.test.js`: silent provider gets events at call time, no doubles, fallback, merge order/flush, abort grace, real cancel). One legitimate change: `core.test.js` "end events carry count/detail/source" now finds rows by tool, not provider id.
- Real check (`dev/live-timing.mjs`, temp dataDir, real kb at :27182), ms since send. Codex: first text 8034; start search 14765; end 18982 (10 results); starts of 3 reads 23228/23231/23236 (the model issued them in parallel); done 58533. Claude: start search 3161; end 5393; reads start 7299, 7373, 7663 with ends right after; first text 16058; done 18732. Events are spread over the run, no bursts.
