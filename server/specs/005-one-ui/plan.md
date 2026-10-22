# Plan: One UI for Zotero and Obsidian, and a Papers / Notes choice

Status: DRAFT 2026-09-26, awaiting review together with spec.md. Nothing built yet.

## Before starting

- The 0.21/0.22 work in `zotero-plugin` is committed (git status on 2026-09-26 shows modified core.js,
  library-http.js, remote.js, agentd.mjs, tests and README). The move in C1 must start from a clean tree.
- Obsidian plugin under local git (open question 4), or a dated copy of `obsidian-plugin/src` + `styles.css`.
- Baseline pictures: run t-chat-look and t-sidebar once and keep `look-*.png` / `sidebar-*.png` to compare
  against after the move.

## Where the code is

- Zotero chat: `zotero-plugin/content/chat.js` (ChatView, ChatTab, CSS in `ChatView.style`), `chat-sidebar.js`,
  `find-view.js`, `report-view.js`, `discover.js`; loaded by `bootstrap.js` with `loadSubScript`.
- Zotero panels: `second-brain.js` (item-pane section, related lists, paper note), `search.xhtml` / `search.js`
  / `search.css`, `note-frame.*`, `preferences.*`.
- Engine: `agent-src/src/tools.js` (+ `tools.d.ts`), `core.js` (`defaultToolContext`), `service.d.ts`,
  `domain.d.ts`, `library-http.js`, `review.js`, `prompts.js`, `remote.js`, `node/agentd.mjs`;
  `content/agent-host.js` (`ZoteroLibrary`).
- Server: `kb.py` (`Searcher._allowed`, `search`, CLI), `http_api.py` (`/search`), `tests/`.
- Obsidian: `obsidian-plugin/src/chat.ts`, `find-papers.ts`, `search.ts`, `related.ts`, `duplicates.ts`,
  `zotero.ts`, `status.ts`, `main.ts`, `styles.css`, `esbuild.config.mjs`, `install.sh`.
- Zotero harness: `agent-src/dev/zotero-harness/harness.sh` + `tests/`; live: `zotero-plugin/dev/live`.

## Stage A: the source split in the engine (no UI change)

### A1. Server: search everything except a source
- kb.py: `_allowed(..., exclude_source)` adds `AND source NOT IN (...)`; `search(..., exclude_source=None)`;
  CLI `--not-source`. http_api.py `/search` reads `exclude_source` (comma list).
- Python test in `tests/`: with a small fixture index, `exclude_source=zotero` returns no `zotero/` path and
  `source=zotero` returns only them.
- Verify: tests pass; `kb.py search "sleep" --not-source zotero -k 20` on the real index lists no `zotero/`
  path; `curl '/search?q=sleep&exclude_source=zotero'` the same; restart the server service.

### A2. agent-src: `sources = { papers, notes, scholarly, web }`
- `tools.d.ts` ToolContext and LibraryBackend (`only?: "papers" | "notes"`); tools.js gating and filtering
  (`search_library` passes `only`; `read_source` refuses a ref of a disabled kind; `related_sources` drops them).
- `service.d.ts` SendInput / ask opts gain `sources?`; `core.js` `defaultToolContext` uses them; user record
  stores `sources`; `remote.js` and `agentd.mjs` pass them through.
- `domain.d.ts` ReviewSource → papers / notes / scholarly / web; `review.js` normalises `"library"` to both at
  read time; `prompts.js` enum follows.
- `library-http.js`: papers → `source=zotero`, notes → `exclude_source=zotero`.
- Tests (node --test): gating table for the 4 library combinations; `read_source` refusal; old review request
  with `"library"` runs sub-questions with papers + notes; old user record without `sources` loads.
- Verify: `npm test`, `npm run typecheck`, `npm run build` (agentd) and `build:zotero` (agent.js); restart
  agentd; `dev/ask.mjs` with `sources: {papers: false, notes: true}` cites only vault notes.
- Both apps still work: neither UI sends `sources`, so defaults apply (today's behaviour).

### A3. Zotero-local library honours `only`
- `agent-host.js` `ZoteroLibrary.search`: rules in spec §5.
- Harness test `t-sources-local.js` with `SB_SERVER=http://127.0.0.1:9`: `only: "papers"` returns items,
  `only: "notes"` returns `[]`, no `only` returns papers.
- Verify: the new test plus t42-library and t43 pass.

## Stage B: the shared UI package, empty

### B1. `ui-src` skeleton, tokens, icons, harness
- `ui-src/package.json` (esbuild, typescript, playwright as devDeps), `build.mjs` → `content/sb-ui.js`
  (IIFE `SecondBrainUI`) + `content/sb-ui.css`; `src/index.js`, `src/dom.js` (`h()` with XHTML namespace),
  `src/icons.js` (today's `ChatView.ICONS` + panel icons), `src/host.d.ts` (spec §2), `styles/ui.css`,
  `styles/tokens-zotero.css`, `styles/tokens-obsidian.css`.
- `dev/harness/index.html`, `fake-host.js` (invented fixtures only), `dev/run.mjs` (Playwright; both maps ×
  light/dark); `.gitignore` for `dev/out/`.
- A trivial component (an icon row and a pill row) proves the pipeline.
- `build.sh` runs `ui-src` build; bootstrap.js loads `sb-ui.js` (unused yet).
- Verify: `npm test` in ui-src green with 4 screenshots; the check-2 grep (no host variables outside token maps)
  added as a test; `build.sh` produces an xpi that behaves exactly as 0.22; Obsidian build unchanged.

## Stage C: the chat, one implementation

### C1. Move the chat into ui-src (Zotero only)
- Move `ChatView` (minus `Zotero.*` calls), the markdown renderer, `FindView`, `ReportView` and the chat CSS into
  `ui-src/src/chat/`. Every `Zotero.*` / `this.sb.*` use (about 40, listed by `grep` in chat.js, find-view.js,
  report-view.js) becomes a `UiHost` call.
- `content/ui-host-zotero.js`: the Zotero adapter (Prefs, IOUtils files, item picker, reader / selection
  context, `discover.js` for `searchOutside`, add to library, scope names, selectByCitekey / openNoteTab / openURL,
  style injection per chrome document). `ChatTab` and `ChatSidebar` shrink to shells that make a host and a view.
- Class names stay `sb-ai-*`; behaviour and pixels stay as 0.22, including the calmer report card
  (`stages()` / `planCard()`, spec §4), which is the reference for the shared ReportView.
- Verify: the stage-B harness renders every mode with the fake host; **every** Zotero harness test passes
  unmodified (t-unified-chat, t43, t-chat-look, t-sidebar, t-find-papers, t-history-collapse, t-chat-scope,
  t-focus-steady, t-int-d-remote-runtime); new `look-*.png` / `sidebar-*.png` match the baseline by eye; version
  0.23.0 built and installed in the real Zotero; a chat and a report run there.

### C2. Source pills in the shared chat
- `SOURCES` becomes Papers · Notes · Scholarly · Web, shown in every mode (spec §5 table); `savedSources()`
  reads both pref shapes; offline Notes mark via `host.where()`; Find papers disables Notes and Web with the
  reason; Send disabled when all are off.
- Chat / Quick answer send `sources`; Find papers maps papers → library rows; reports send the new
  ReviewSource list; FindView reads old `{ library, scholarly }` saved searches.
- Harness (ui-src): for each mode × representative combinations, the recorded request carries the expected
  sources; the pref migration; the offline mark.
- Zotero harness `t-sources.js`: pills in all modes, remembered across a new chat and a restart of the view,
  old pref migrated, Notes offline mark with `SB_SERVER` dead.
- Verify: those tests + all C1 tests; in the real Zotero with the server up, a Papers-only chat cites only
  papers and a Notes-only chat only notes (success checks 6–10). Version 0.24.0.

### C3. Obsidian runs the shared chat
- `obsidian-plugin/src/ui-host.ts`: the Obsidian adapter (plugin data prefs, vault adapter files under the plugin
  folder, active note + `zotero-key` front matter as context, `active-leaf-change`, FuzzySuggestModal picker,
  `openZotero` / `openExternal`, OpenAlex through `requestUrl` for `searchOutside`, `Notice`). `can.scopes`,
  `can.addToLibrary`, `can.openInTab` false.
- `ChatView extends ItemView` becomes a thin shell that mounts the shared view; delete the old chat.ts body and
  the UI half of find-papers.ts (keep saved-find reading if the shared FindView needs a format bridge).
- `esbuild.config.mjs` builds `main.js` and writes `styles.css` = `sb-ui.css` + `tokens-obsidian.css` + the
  remaining panel CSS; `sbc-*` rules deleted.
- `dev/smoke.mjs` (CDP) or the manual checklist: open the chat, the four empty states, a chat answer, a Find
  papers table, a report plan card, the pills; screenshots next to the Zotero ones.
- Verify: `tsc --noEmit`, build, `install.sh`, smoke; spec checks 1, 3, 5, 8, 9 in Obsidian. Version 0.4.0.

### C4. Drift guard
- ui-src test: the DOM class tree of each rendered state is identical for the Zotero and Obsidian token maps.
- A test in each host that fails if a host file defines `.sb-ai-` CSS or builds chat DOM itself (grep).
- Verify: both tests pass; a deliberate `.sb-ai-send` rule added to chat-sidebar.js makes the Zotero one fail.

## Stage D: the older panels on the same design

Each unit: build the component in ui-src with harness screenshots, move the Zotero panel and the Obsidian
panel onto it, delete the old CSS, check both apps. The data calls stay where they are (host side) unless the
panel is identical in both apps.

### D1. Panel components
- Drawn to spec §4: text first, row actions and field outlines on hover / focus, one primary button, one
  status line.
- `Section` (collapsible, count, header buttons), `Row` (title, meta, snippet, optional score bar), `SearchBar`
  (box + Papers · Notes pills + "More" source filter), `PaperCard`, `StatusPanel`, empty / loading / error
  states.
- Verify: harness screenshots of each, both maps, light / dark.

### D2. Search
- Obsidian `SearchView` and the Zotero search window on `SearchPanel`; the `<select>` sources become pills +
  "More" (Zotero, My notes, Notion, PDFs, Images, AI notes). The Zotero window loads `sb-ui.js` / `sb-ui.css`
  into `search.xhtml`; its online and related modes use the same rows.
- Verify: a harness test for the Zotero search window (query, Papers-only hits, open a hit); Obsidian smoke with
  the same query; search.css shrinks to window layout only.

### D3. Related notes and the paper pane
- Zotero item-pane section (Related notes, Similar papers, paper note header) and Obsidian `RelatedView` +
  `ZoteroView` on `Section` / `Row` / `PaperCard`.
- Verify: t-focus-steady and a new `t-item-pane-look.js` (pictures, light / dark); Obsidian smoke on a note
  with a `zotero-key`.

### D4. Duplicates and status
- Obsidian `DuplicatesView` and `StatusView`, and the Zotero index state (preferences), on the shared components.
- Verify: harness pictures; Obsidian smoke; Zotero preferences opens and shows counts.

### D5. Clean-up
- Remove the `--sb-*` color variables from second-brain.js, `sbs-*` rules from Obsidian's CSS, unused icons.
- Verify: success check 11 greps; every Zotero harness test; Obsidian smoke; both apps installed.

## Verification summary

| Unit | Automatic | Real app |
| --- | --- | --- |
| A1 | Python tests, CLI, curl | server restarted |
| A2 | agent-src tests + typecheck | `dev/ask.mjs` against agentd |
| A3 | t-sources-local, t42, t43 | — |
| B1 | ui-src `npm test` (4 pictures) | 0.22 behaviour unchanged |
| C1 | ui-src tests; all Zotero harness tests unmodified | Zotero 0.23.0 installed, chat + report |
| C2 | ui-src source tests; t-sources | Papers-only / Notes-only chats cite correctly |
| C3 | tsc; ui-src with Obsidian map; plan-card hover/focus pictures (check 12) | Obsidian 0.4.0 smoke + screenshots |
| C4 | drift tests | — |
| D1–D5 | harness pictures per component; panel tests | both apps per unit |

Each unit ends with both apps built and installed (memory: "always install after building" applies to these
plugins too), and a short Result section added here, as in specs 002–004.

## Result (Stage D)

### D1. Panel components (2026-10-02)
Built in `zotero-plugin/ui-src/src/panels/`: `panels.js` (Button, IconButton, StateLine, Section, Row, Tabs, SearchBar,
PaperCard, Highlight, Progress, StatusPanel) and `data.js` (pure helpers: `scopeOf` / `pillsFor` / `togglePill` for the
Papers / Notes pills and the More filter, `closeness`, `byline`, `metaOf`, `badgeOf`, `tidy`, `duration`). CSS is in
`styles/ui.css`, every rule scoped under `.sb-p` (the class a host puts on a panel root) so Obsidian's own button and input
rules lose; only `--sb-ui-*` tokens (check 2 stays green; the highlight colour is the component-local `--sb-ui-hl`).
Seven icons added (trash, refresh, quote, book, pen; the rest reused). Rules from spec 4 as built: row and section actions
and the search field outline appear only on hover / focus (always visible on touch); one primary per card; one state line;
every button has `white-space: normal`; the related score is a 5-level bar plus its label (the same grading both hosts used,
Zotero's calibration kept through `closeness(score, calibration)`); a zero count is not shown.
- Verified (harness, `npm test` in ui-src): `test/panels-data.test.js` (8 tests) and `dev/panels-checks.mjs` (52 checks):
  both token maps x light / dark x widths 960 / 700 / 360 with no overflow and no page error (screenshots
  `dev/out/panels-*.png`), with an Obsidian-like hostile button/input sheet applied: actions opacity 0 -> 1 on hover and on
  focus-within, buttons wrap and ignore the host shadow, a long button label wraps inside the card at 360, a long row title
  clamps to two lines, one primary per card, popover stays inside the panel, pills / More produce the expected scope,
  reduced motion stops the status pulse.
- Totals after D1: ui-src node tests 75 pass; harness all checks pass (613 PASS lines). `tsc` in ui-src has 35 errors that
  were there before (perf-common.js and others); none in panels.
- Only harness-checked: nothing is mounted in an app yet (D2-D4 do that).

### D2. Search (2026-10-02)
`ui-src/src/panels/search-panel.js` adds `SearchPanel`: the box, the Papers / Notes pills with the "More" filter, one status
line, result rows (hit = icon, title, byline or folder + date, passages with their last heading), keyboard (arrows, Enter;
Enter opens the selected hit before the box's own "search now"), a stale-answer guard, and slots for host extras (`extra`,
`tools`, `footer`). The pills map to the server as `scopeOf`: Papers alone `source=zotero`, Notes alone `exclude_source=zotero`
(A1), both none; a More source wins and sets the pills to its side.
- Obsidian: `src/search.ts` is now ~50 lines on `SearchPanel`; rows are still wired by `links.wire` (open, Cmd-click new tab,
  context menu, drag, hover preview) through the adapter's `decorate`, with passage events stopped from reaching the row so a
  click opens once. All ten sources of the old dropdown are in More ("Any source" first); "Copy results as links" is the
  tools button. `styles-panels.css` only makes the view fill (the old `sbs-hit`/`sbs-bar` rules stay until D5).
- Zotero: `search.xhtml` loads the Zotero token map, `sb-ui.css`, `sb-ui.js`; `search.js` supplies the data and the two online
  modes (Find new papers, related) through the panel's `handler` / `setRows`, drawn with the same rows, `Section` per group,
  Add / In your library buttons; `search.css` is 12 lines (window layout + the citation chip). `searchAll` gains `exclude`
  and, with the server down, refuses a notes-only or non-Zotero-source search with the usual "Second Brain isn't running"
  line instead of silently returning papers. Not done: the toolbar dropdown search (`addToolbarSearch`) keeps its own rows and
  chips; it moves in D5 only if D3 leaves it styled by removed classes (see D3).
- Verified (harness): `dev/panels-checks.mjs` grew to 84 checks including the real `content/search.js` loaded on stubbed
  chrome globals (`dev/harness/search-window.html`): tabs, pills, More list, Papers-only / Notes-only requests, Enter / click
  opening, Escape closing the menu then the window, offline message, online rows, Add once then "Added", remembered services.
  `npm test` (ui-src): 75 node tests, 645 PASS lines, 0 FAIL; Obsidian `tsc --noEmit` clean, 17 unit tests pass.
- Only harness-checked, OWED in real apps: (Zotero) a `t-search.js` real-Zotero test: open the window, query, Papers pill, open
  a hit, Find new papers, Add, check `SecondBrainUI` loads in the XUL window and the tokens resolve (`getComputedStyle`).
  (Obsidian) smoke: open Vault search, query, Papers / Notes pills, More > PDFs, click a hit, Cmd-click, right-click menu, drag
  a row into a note, "Copy results as links", widths 360 and 960.

### D3. Related notes and the paper pane (2026-10-02)
- Shared additions: `Section` takes `onToggle`, `Subhead`, `ChipRow`; `PaperCard` draws its action row (and rule) only once it has an
  action; `.sb-p.is-flat` (transparent, for panels inside another app's pane), `.sb-p-page` / `.sb-p-scroll` for reading pages.
- Obsidian: `RelatedView` is `Section` + `Row` (score bar and label from `closeness`, copy-all in the section header, "Add it now" as the
  one primary, errors as one state line); `ZoteroView` is `PaperCard` (kicker, 20 px title, authors with "+N more", venue, @citekey and
  DOI chips, Open PDF as the one primary, paper note / Show in Zotero / Insert citation as quiet buttons), `Section`s for Abstract,
  Highlights (`Highlight`, right-click copies the quote with citation), My notes (Obsidian's `MarkdownRenderer`), In your notes, a
  lazy Full text (closed until opened) and the Collections / Tags chips. `src/panel-rows.ts` gives a Row Obsidian's behaviour
  (`links.wire`: open, Cmd-click, context menu, drag, hover preview, and Enter). Local `Row`/`Highlight` interfaces renamed so they do
  not shadow the components.
- Zotero: the item-pane lists (`list()`) draw shared Section + Row (closeness graded with the model's own calibration where there
  is one; a click opens the paper or note as before); status lines are `StateLine`; the paper-note tab header is `PaperCard`
  (kicker "Paper note", title, byline). The note editor, its toolbar and the Focus mode are untouched (non-goal). The toolbar search
  dropdown moved onto the same Row / StateLine / pills so the old row classes are free to delete (D5).
  Behaviour change worth knowing: the five-dot closeness indicator is now the bar + label Obsidian used (one look in both apps).
- Verified (harness): `dev/panels-checks.mjs` 111 checks: the REAL `second-brain.js` `list()`, `stateLine`, `addUiStyles` and the
  paper-note header on stubbed chrome (`dev/harness/item-pane.html`), light and dark at 960 / 360 / 280 px: counts, empty line,
  closeness labels (fixed and calibrated), nothing sticks out, transparent on the pane colour, tokens resolve, two style links
  only once, two-line title clamp at 280, click opens `zotero/KEY`. `npm test` ui-src 75 node tests, 672 PASS lines, 0 FAIL;
  Obsidian `tsc --noEmit` clean, 17 tests pass; all `content/*.js` parse.
- OWED in the real apps: (Zotero) `t-item-pane-look.js` in the real-Zotero harness (pictures light/dark of the pane section with related
  notes and similar papers, t-focus-steady must still pass, a row click selects the paper, the paper-note tab header, and the toolbar
  search dropdown: type, arrows, Enter, chips); (Obsidian) smoke on a note with a `zotero-key` and on a plain note: Related sidebar rows,
  Cmd-click, right-click, "Add it now" for an unindexed note; the Zotero item tab: header, Open PDF menu with several PDFs, paper note
  create / open, highlights, full text opens on demand, widths 360 and 960.

### D4. Duplicates and status (2026-10-02)
- Obsidian `DuplicatesView`: header with one icon button, one info line, shared `Tabs` with counts, groups as bordered boxes of `Row`s
  (Compare / Trash appear on hover or focus; a trashed row is dimmed and struck through), the identical-copies callout with one
  danger button, `Subhead`s for the conflict lists. `StatusView`: one `StatusPanel` rendered in place on the 2 s poll (dot, label,
  bar, lines, Stop or Update now as the one primary, coverage table, notes); the confirm modal is still Obsidian's own `Modal`.
  `duration` / `ago` / `until` moved to ui-src (`duration` re-exported for `main.ts`).
- Zotero: Settings -> Second Brain shows the local search model state as a compact `StatusPanel` (dot, one line, an indeterminate bar
  while it downloads / starts / reads the library); the Download / Remove buttons stay Zotero's own. The window gets the shared sheets
  through `SecondBrain.addUiStyles`; `SecondBrain.UI = SecondBrainUI` makes the component set reachable from the settings window. There
  are no per-source counts in Zotero (the index lives in the server), so the Zotero "status" is the model state only.
- Verified (harness): `dev/panels-checks.mjs` 117 checks, adding: group = 1 px box, 10 px corners; callout button wraps inside the box
  and nothing scrolls sideways at 960 and 360 with the Obsidian-like button sheet; compact state is regular weight, transparent,
  indeterminate bar; trashed row dimmed / struck / inert; `render()` replaces in place. ui-src `npm test`: 75 node tests, 0 FAIL;
  Obsidian `tsc --noEmit` clean, 17 tests pass; `preferences.js` and `ui-host-zotero.js` parse.
- OWED in the real apps: (Zotero) open Settings -> Second Brain and read the model state in each of absent / downloading / ready (the panel
  inside the settings window, tokens resolve, no layout jump when the Download button shows); (Obsidian) smoke: Duplicate notes (tabs,
  compare, trash with the confirm modal, restore from trash, "Check again"), Search index (running and idle states, Stop, Update now,
  the confirm modal for re-reading images, the 2 s refresh not losing the scroll position), at widths 360 and 960.

### D5. Clean-up (2026-10-02)
- Removed: Obsidian's whole `sbs-*` panel CSS (about 115 rules; `styles.css` now has none), `iconButton` and `badge()` in `links.ts`, the
  `tidy` re-export in `search.ts`; the settings-tab and status-bar classes that were still `sbs-` became `sb-set-*` and the chat root
  `sb-chat-root`, so no `sbs-` / `sbc-` string is left in `src/` or either stylesheet. In `second-brain.js`: the item-pane rules for rows,
  labels, titles, metas, badges, cards, hints, closeness dots, the note-tab kicker / title, the toolbar rows' old classes and chips
  (21 rules found unused by grepping every class against all content, editor and ui-src sources), the dead `.sb-ed` colour variables
  (`--sb-link`, `--sb-muted`, `--sb-quote`, `--sb-code-bg`; the editor's colours are set inside its own frame by `note-frame.css` and
  `editor.js` `applyColors`), and the unused `kind()` / `button()` methods. The editor's user-chosen sheet colour and accent, which
  `second-brain.js` read as `--sb-sheet-bg` / `--sb-accent`, are now `--ed-sheet-bg` / `--ed-accent` (set by `editor.js`).
  Icons: every name in the set is referenced by product code, so none was removed (the spec's seven panel names are all in use).
- Left on purpose: `--sb-*` colour variables in `note-frame.css` and `editor-src` (the note editor, a non-goal), `--sb-chat-h` /
  `--sb-chat-nav-w` in `chat-sidebar.js` (layout sizes, not colours), editor.js's own `sb-button` / `sb-count` / `sb-hl-*` classes.
- New guard `ui-src/test/check11-cleanup.test.js` (3 tests): no `--sb-*` property in `second-brain.js`; no `sbs-` / `sbc-` in Obsidian's
  CSS or views; no host stylesheet rule starting with a shared `.sb-p-*` class. The C4 drift guard and check 2 are still green.
- Success check 11 greps, run today: `grep -c "sbs-\|sbc-" obsidian-plugin/styles.css` = 0; `grep -e "--sb-" content/second-brain.js` = nothing.
- Final totals (harness only, no real app): ui-src `npm test` = 78 node tests pass, 678 harness PASS lines, 0 FAIL (117 of them the panel
  checks); Obsidian `tsc --noEmit` clean, 17 unit tests pass, esbuild bundle builds; all `content/*.js` parse.
- Not run, per the memory limits: the real-Zotero harness (every t-* test), real Obsidian, `agent-src` tests (untouched). Nothing was
  published, no manifest bumped, no xpi built, `install.sh` not run, so neither app has the Stage D look yet.
- OWED before publishing (check 13 "both apps build, install and open their chat"): run the whole real-Zotero harness suite on a fresh
  profile (t-focus-steady, t-sidebar, t-unified-chat, t43-chat and the rest must be unchanged) plus the new tests named under D2 (`t-search`),
  D3 (`t-item-pane-look`) and D4 (settings state); then an Obsidian smoke of all panel views listed under D2-D4.
