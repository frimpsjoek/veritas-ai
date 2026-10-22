# U4 Routines: design (spec 011, 0.43.0)

Date: 2026-10-07. Author: design review (Fable) against the real code. Decisions D1-D7 accepted by the lead as recommended (see section 8).

## 0. Facts that shape the design

1. Two runtimes, two data dirs. Sidecar: `~/obsidian-kb/data/agent` (agentd `--data`, supervised by `agent_api.supervise()` from `http_api.serve()`). Zotero standalone: `<Zotero.DataDirectory>/second-brain`. `AgentHost.ai()` pings `/agent/ping` every 10 s and switches to the server runtime when it answers, adopting `chats/*.jsonl` (`adoptInto`). Obsidian is always remote, so it never schedules.
2. No quota read on demand. `ProviderStatus.usage` is always `null` (codex.js, claude.js). Only mid-turn notices carry it: Codex `account/rateLimits/updated` (`usedPercent`, `windowDurationMins`), Claude `rate_limit_event` (`unifiedWindows.five_hour.utilization`); today they become `{type:'notice', kind:'rate_limit', text}` and the number is lost.
3. No `since` anywhere. `search_scholarly` takes query/limit only; `library.search` declares `years` but `library-http.js` ignores it.
4. Find results are built in the UI (`find-view.js` -> `sessions.put`); the engine's search path is review2 `searchStage` (researcher turn + `CANDIDATES_SCHEMA` + `mergeCandidates`, which dedupes by DOI/citekey/title).
5. The slot pool is per process (`createSlots`, total 6, researcher 3, extract 3); routine turns through `runner.structured` respect it.
6. No Telegram/`hermes` code in the repo.

## 1. Module layout

- `agent-src/src/routines.js` pure: schedule math, record validation, run planning, dedupe (no fs, no clock)
- `agent-src/src/routine-store.js` fs: `routines/<id>.json` read/list/writeAtomic; adopt
- `agent-src/src/core.js` `createRoutineScheduler()` wiring + `routines` service block + `executeRoutine()` + usage memo
- `agent-src/src/scholarly.js` `since` filter per source; `tools.js` optional `since` on search_scholarly, `ToolContext.since` applied regardless of the model
- `service.d.ts`, `remote.js`, `node/agentd.mjs`, `domain.d.ts` API surface
- `content/agent-host.js` `isOwner()` for the Zotero local runtime; adopt routines on switch
- `ui-src/src/chat/routines-data.js` pure (grouping, labels, templates, nextRun text); `routines-view.js` view + create/edit sheet; `chat.js`, `steps-data.js`, `artifact-panel.js`, `artifact-table.js` entries and highlight

### routines.js exports
```js
/** @typedef {{ kind:'daily', time:string } | { kind:'weekly', weekday:0|1|2|3|4|5|6, time:string }} Schedule  // "HH:MM" local */
export function parseTime(time)            // { h, m }; throws on bad input
export function nextRun(schedule, fromMs)  // first occurrence strictly after fromMs, local time
export function dueSlot(schedule, nowMs)   // latest occurrence <= nowMs, or null
export function isDue(routine, nowMs)      // { due, slot }: slot > lastSlot && status==='active'
export function validateDraft(draft)       // fills defaults, rejects bad schedule/target
export function planSince(routine, nowMs)  // ISO date = lastRun.at ?? created, minus 1 day slack
export function newRows(found, existing)   // drop DOI (lowercased) / citekey / normalised-title matches
export function changeLine(added, skipped) // "Routine: 3 new papers (2 already here)"
export function quotaAllows(usage, nowMs)  // { ok, why } — the 50% rule, section 4
```
Local-time math uses `new Date(y, mo, d, h, m)`: a nonexistent spring-forward time rolls forward (02:30 -> 03:30), an ambiguous fall-back time takes the first occurrence. Tests set `process.env.TZ` and cover 2026-03-08 / 2026-11-01 (US) and 2026-03-29 / 2026-10-25 (Europe).

### Record: `<dataDir>/routines/<ulid>.json` (writeAtomic)
```js
/** @typedef {{
 *   id, name, prompt, skills: string[], depth: 'quick'|'standard'|'deep', schedule: Schedule,
 *   target: { kind:'artifact', session, result: { id } } | { kind:'session' },
 *   sources, scope, status: 'active'|'paused'|'archived', created, updated,
 *   lastSlot: string|null,   // ISO of the slot last run or skipped: the idempotency key
 *   lastRun: null | { at, slot, status:'done'|'failed'|'skipped', reason?, added?, session?, writes?, review?, summary? },
 *   notify: boolean          // reserved, false (D5)
 * }} Routine */
```
`nextRun` is computed, never stored. `lastSlot` is written BEFORE a run starts, so catch-up, restarts or a second owner can never run the same slot twice; a crash mid-run consumes the slot.

## 2. Service API
```ts
routines: {
  list(): Promise<(Routine & { nextRun: string | null; running: boolean })[]>;
  create(draft: RoutineDraft): Promise<Routine>;
  update(id, patch): Promise<Routine>;        // schedule change sets lastSlot = now (D7)
  runNow(id): Promise<{ started: boolean; reason?: string }>;  // ignores quota rule and lastSlot; refused while one runs
  pause(id); resume(id); archive(id);         // -> Routine
  adopt(records: Routine[]): Promise<string[]>; // idempotent by id; merge keeps the later lastSlot
}
```
agentd: `GET /routines`, `POST /routines`, `POST /routines/update {id, patch}`, `POST /routines/run {id}`, `POST /routines/pause|resume|archive {id}`, `POST /routines/adopt {records}`; remote.js mirrors them. `providers.status().usage` becomes non-null when a memo exists.

## 3. Scheduler and single ownership

`createRoutineScheduler({ store, clock, tickMs: 60_000, startupGraceMs: 45_000, isOwner, run, log })` in `createLocalRuntime` (new optional deps `clock`, `routines: { isOwner }`; defaults `Date.now`, `() => true`). Each tick: `if (!isOwner()) return`; for each active routine `isDue`; at most one run at a time (in-memory running id; the slot pool caps processes). `dispose()` clears the interval and aborts the running run (`lastRun.status='failed', reason:'stopped'`).

Owner (D1): agentd always owns while the server runs. Zotero local runtime: `isOwner = () => !host.pinged.ok`, ping refreshed inside the tick (3 s timeout, cached 10 s). When the server appears, `adoptInto(server)` also calls `server.routines.adopt(localRoutines)` and moves local files to `routines-adopted/` (D2). The slot key makes any overlap harmless. Obsidian never schedules. UI line: "Routines run while the Second Brain server or Zotero is running. Missed runs catch up once."

Catch-up once: first tick after grace runs `dueSlot(now)` if > lastSlot; N missed days collapse to one run.

## 4. The 50% provider-window rule (D3)

Providers add a structured field to the rate-limit notice: `{ type:'notice', kind:'rate_limit', text, usage: { percentUsed, windowMinutes, resetsAt? } }` (Codex `usedPercent`, `windowDurationMins`; Claude `utilization*100`, 300; verify field names live). core.js keeps a `UsageMemo` per provider `{ percentUsed, at, windowMinutes }`, exposed in `providers.status().usage`. `quotaAllows`: skip when `percentUsed >= 50` and memo younger than its window; run when no memo, stale memo, or the role's provider is `local`/`oss:*`. A skip writes `lastRun = { status:'skipped', reason:'Codex window 63% used at 07:30' }`, consumes the slot, and shows on the card.

## 5. Runs (D4, D6)

Artifact target (watch): one `researcher` structured turn (`CANDIDATES_SCHEMA`, prompt from `routine.prompt` + skill block + "only papers published since <since>"), tools `search_scholarly` + `search_library` with `ToolContext.since = planSince(routine)`. `since` in scholarly.js: OpenAlex `filter=from_publication_date:`, Crossref `filter=from-pub-date:`, Europe PMC `FIRST_PDATE:[since TO *]`, arXiv `submittedDate:[sinceT0000 TO *]`, Semantic Scholar `publicationDateOrYear=since:`; others rely on dedupe. Then `newRows(found, base.rows)`; none -> `lastRun {status:'done', added:0}` and NO version. Otherwise a step `{ kind:'routine', routine:id, on: baseRef, since }`, V+1 with `rows: [...base.rows, ...added]`, cells unchanged (new rows pending; Fill the rest handles them), `change: changeLine(...)`, `addedRows: RowId[]` (new optional `PapersResult.addedRows`), `step_end` ActivityLine "Routine found 3 new papers". `artifact-table.js` highlights `addedRows` rows (`.sb-art-row-new`).

Session target: `conversations.create('chat')` with `meta.routine = id` (`ConversationSummary.routine?` for a badge), then `reviews.start({ question: prompt, depth, skills, sources, scope, years:{from:null,to:null}, pipeline:2, autoApprove:true, session })`; record `lastRun.review/.session`. Both shapes write `lastRun.summary` for the card. Missing skill: run without it, note in `lastRun.reason`.

## 6. UI

- `steps-data.js` MODE_GROUPS Workflows gains `routines` ("Routines"); `chat.js setMode` opens `RoutinesView` in the thread area, no composer, never persisted as `chatMode`.
- `routines-view.js`: tabs Active / Paused / Archived; card per routine (name, schedule text, next run, last run line, Run now / Pause|Resume / Archive / Edit); three template cards when empty (daily preprint digest for a topic, weekly new-papers watch for an author or topic, citation watch for one paper — invented examples); sheet: name, prompt, Skills (U3 chip picker), depth (U1 dial), schedule (Daily|Weekly, weekday, `<input type=time>`), target (this artifact / new session each run), sources. Footer: the honest limit line.
- `artifact-panel.js openMore`: "Create routine for this" (papers results) -> `chat.openRoutines({ target, name })`.
- `chat.js refreshList`: clock icon on sessions with `routine`.
- Obsidian: rebuild only. Zotero: `agent-host.js` isOwner + adoption.
- Telegram (D5): not built; `notify` reserved.

## 7. Tests

Unit (`agent-src/test/routines.test.js`, injected clock, TZ): daily before/after; weekly across week boundary; DST forward/back; dueSlot across midnight; isDue false at lastSlot; three missed days -> one slot; update resets lastSlot; quotaAllows (none, fresh 63%, stale 63%, local); newRows by DOI case/citekey/title; changeLine. `core.test.js`: due routine runs once over two runtime lifetimes on the same fs; isOwner false never runs; runNow while running refused; artifact target writes V2 with addedRows, second run with nothing new writes no version; skipped writes lastRun.skipped; dispose stops the interval. agentd + remote route tests; scholarly per-source since URLs; `ui-src/test/routines-data.test.js`.

Harness `t-routines.js` (scripted provider + stubbed fetch, fresh profile): open Routines from the mode menu, create a daily routine over an 8-row artifact with time one minute ago -> one card, one run (V2, two highlighted rows, change line); Run now with nothing new -> no V3; Pause moves it out of Active; "Create routine for this" prefills the sheet.

Live check: create a routine in Zotero with the server up (lands on the sidecar), stop `kb.py serve` past the time, restart, wait 45 s: exactly one new version and `lastSlot` = that slot; Run now with nothing new: no version.

## 8. Decisions (accepted 2026-10-07)

D1 owner by existing ping (sidecar when up, else Zotero). D2 adopt Zotero-made routines into the server like chats. D3 remembered-notice memo, run when unknown, shown on card. D4 watch = one researcher turn + dedupe + version; session = pipeline-2 review with autoApprove. D5 no Telegram; `notify` reserved. D6 `since` for OpenAlex/Crossref/Europe PMC/arXiv/Semantic Scholar. D7 schedule edit sets lastSlot = now.
Risks: sleeping Mac (timers pause, slot math catches up next tick, stated in footer); U3 interface drift (routines store skill names, resolve at run time).
