# Plan: Local models on this Mac

Status: DRAFT 2026-10-02, with spec.md. Order: engine pieces bottom-up (each testable alone), then the engine path,
then UI. One commit per unit in `zotero-plugin` (and `obsidian-plugin` in lockstep when its files change).
No unit publishes, bumps a manifest, builds an xpi or runs `obsidian-plugin/install.sh`. No unit loads a real model.

## Before starting

- Trees clean in `zotero-plugin` and `obsidian-plugin` (the existing untracked `.claude/` and `.impeccable` cache are not ours).
- Baseline: agent-src `npm test` and ui-src `npm test` green (numbers recorded in L0's Result).
- One process at a time (machine is swapping): no parallel test runs, no real Zotero, no real Obsidian.

## Where the code is

- New: `agent-src/src/local/{discover,memory,guards,server,external,retrieve}.js`, `agent-src/src/providers/local.js`.
- Touched: `providers/index.js` (register), `provider.d.ts` (caps), `domain.d.ts` (ProviderId, ProviderStatus, Answer.passages,
  notice kinds), `settings.js` + `settings.d.ts` (`local`, role gating), `platform.d.ts` + `node/platform.mjs` + `gecko/platform.js`
  (`fs.stat`), `core.js` (TurnRunner guarded path, `finish`), `prompts.js` (`LOCAL_INSTRUCTIONS`), `node/agentd.mjs` and
  `content/agent-host.js` (shutdown hooks).
- UI: `ui-src/src/chat/{local-menu,chat}.js`, `ui-src/styles/ui.css`, `ui-src/dev/harness/fake-host.js`, new `ui-src/dev/local-checks.mjs`;
  hosts: `content/preferences.js`, `obsidian-plugin/src/main.ts`.
- Tests: `agent-src/test/local-*.test.js`, `agent-src/test/fake-local-server.mjs`.

## L1. Platform stat, settings, discovery, memory

- `platform.d.ts`: optional `fs.stat(path): Promise<{ size: number; dir: boolean } | null>` (null = absent). Node and Gecko impls.
- `settings.js` / `settings.d.ts`: `local` block with defaults and merge; `localSettings()` reader.
- `local/discover.js`: `scanModels({ fs, dirs, home })` -> `{ models, missing }`; `isChatCapable`; `chooseDefault`.
- `local/memory.js`: `parseVmStat`, `availableBytes(spawn)`, `memoryVerdict({ modelBytes, availableBytes })` with the sentence.
- Tests: temp tree against the node platform (chat models, ASR, embeddings, GGUF-only, cache layout, duplicate, drive missing),
  settings merge, vm_stat fixture parsing, verdict sentences.

## L2. Server manager and guards

- `local/guards.js`: `createRepeatGuard({ minChars: 12, times: 3 })` fed text deltas; returns the safe prefix once it trips.
- `local/server.js`: `createLocalServer({ platform, dataDir, timers, pickPort, settings })`: `ensure(model, signal)`, `touch/begin/end`,
  idle stop, one model, memory refusal, pid file + stale reap, `stop()`, `dispose()`.
- Tests: fake spawn + fake fetch + fake timers: start once, reuse, switch stops first, idle stop, busy blocks idle,
  early exit reports stderr, memory refusal spawns nothing, dispose kills, stale pid reaped.

## L3. The `local` provider

- `local/external.js`: `detectExternal(fetch, endpoints)`.
- `providers/local.js`: `status()`, `models()`, `turn()` (guarded stream; unguarded delegate to `openaiProvider` when tools are offered),
  `signIn`/`signOut` no-ops, `dispose`. `providers/index.js` registers `local` always.
- `domain.d.ts`, `provider.d.ts` additions.
- Tests against a FAKE OpenAI-compatible HTTP server (`test/fake-local-server.mjs`, a real `node:http` listener): streaming, request body
  check (temperature 0, thinking off, max_tokens, no tools), repeated-line stop, length notice, Ask wrap, status states
  (ready, loading, drive missing, mlx missing), external detection, model default.

## L4. Engine: roles, retrieval-first, citations

- `settings.js`: `setRole` refusal; `core.js`: turn-time role gate; guarded path in `TurnRunner.stream` (`local/retrieve.js`,
  `LOCAL_INSTRUCTIONS`), zero-hit not-found, citation restriction to the retrieved set, `Answer.passages`, `done` carries it,
  assistant record stores it; `chat_papers` refusal.
- Tests: role gating (setRole and turn time, with `allowReports`), retrieval runs and the model sees the passages and no tools,
  zero hits spawns/loads nothing, citation outside the set is `unknown`, inside is resolved, passages stored and reloaded.

## L5. UI: Answer-with menu and passages

- `ui-src/src/chat/local-menu.js` (popover reusing `popover.js`), controls-row button in `chat.js`, "Passages used" block,
  CSS (`white-space: normal`), fake-host support, `dev/local-checks.mjs` (both token maps, light/dark, 960/700/360, nowrap-hostile sheet).
- Tests: node tests for the pure parts (menu model list, cloud-roles memory); harness checks.

## L6. Settings panes, shutdown hooks, runbook

- `content/preferences.js` and `obsidian-plugin/src/main.ts`: "On this Mac" status row, idle minutes, folders, Advanced toggle; role dropdowns
  filter `local`. `agentd.mjs` / `agent-host.js`: dispose the local provider on exit signals.
- `real-checks.md` finished against the final behavior.
- Tests: obsidian-plugin typecheck; agent-src and ui-src suites green.

Each unit ends with a short Result section below.

## Result: L1 platform stat, settings, discovery, memory

- `fs.stat` (optional) in `platform.d.ts`, Node and Gecko impls; `settings.local` block (`scanDirs`, `idleMinutes`, `python`, `allowReports`, `external`) with sanitizing merge,
  `readLocalSettings`, `localRoleRefusal`, and `setRole` refusing a local model on a report role. `local/discover.js` (`scanModels`, `inspectModel`), `local/memory.js`.
- Tests: `local-discover.test.js` (7: temp tree with chat models, ASR, whisper, embeddings, TTS, PII, GGUF-only, no-template, no-config, a cache-layout duplicate; drive missing; defaults; vm_stat), `local-settings.test.js` (4). Suite 348 -> 359.
- Deviation from the spec text: none. Note: Woof 4B ordering picks the highest version number in the name (1.1 before 1.0), not alphabetical.

## Result: L2 server manager and guards

- `local/server.js` (`createLocalServer`, `checkMlx`, `pythonFor`), `local/guards.js` (`createRepeatGuard`); `ChildProcess.pid` (optional) added to the platform port so a stale child can be reaped.
- Tests: `local-server.test.js` (14, fake spawn / fetch / clock: one start, reuse, switch stops first, concurrent ensures, idle stop + busy + reset + live setting, memory refusal spawns nothing, early exit error text, startup timeout kills, missing python / mlx-lm, dispose, stale pid reaped only if still `mlx_lm.server`), `local-guards.test.js` (4). Suite 377.
- Not covered by a unit test: the real port picking (`defaultPickPort` is untested; tests inject `pickPort`).

## Result: L3 the `local` provider

- `providers/local.js` (status, models, guarded stream, delegation to `openaiProvider` when tools are offered, no-op sign in/out, dispose), `local/external.js` (Ollama / LM Studio detection, 800 ms timeout), registered in `providers/index.js`. Types: `ProviderId` "local", `ProviderStatus.state` "loading" + `detail`, `LocalModel`, `caps.tools` / `caps.roles`, final event `notes`, notice kinds `loading` / `local_guard`.
- Tests: `local-provider.test.js` (13) against a real `node:http` fake OpenAI-compatible server (`test/fake-local-server.mjs`): request body (temperature 0, thinking off, max_tokens <= 600, stream, no tools, no response_format), streaming deltas, repeated-line stop with client disconnect, length note, Ask wrap, empty think block, server error, abort, memory refusal passthrough, Ollama-style server used as-is with nothing started, status states (ready / drive not connected / mlx-lm missing / nothing found / loading), tool loop only when tools are offered. Suite 390 (one flaky timing wait found and made robust).

## Result: L4 engine

- `core.js`: role gate in `TurnRunner.stream` (any provider with `caps.roles`), guarded retrieval-first path (`local/retrieve.js`: attached papers read first, then `library.search` limit 5, short follow-ups borrow the previous question), `LOCAL_INSTRUCTIONS`, zero hits => not-found with no model call (typed `not_found` for Ask), citations limited to the retrieved set (a real library paper outside it is `unknown`), `Answer.passages`, turn notes become `done.notice` and are stored, `session.on` turns refused with a plain sentence, tool session opened with `none: true`.
- Tests: `local-engine.test.js` (10). Suite 400, typecheck clean.

## Result: L5 UI

- `ui-src/src/chat/local-menu-data.js` (pure) + `local-menu.js` (button + menu, built on `popover.js`, which gained `above`), wired into `chat.js` (controls row, only in Chat and Quick answer, hidden when the engine has no `local` provider), "Passages used (N)" under local answers (live and reopened), fake host `createLocalProviders`, `dev/local-checks.mjs`.
- Tests: node `local-menu.test.js` (6; ui-src node suite 84). Harness: 92 local checks, both token maps x light/dark x 960 / 700 / 360, Obsidian's hostile button style (nowrap, 30 px height) on, long names wrap, nothing runs off the pane, switch moves Chat and Ask and restores the cloud choice, refused switch shows the engine's sentence, unavailable models disabled with the reason, passages folded and fit at 360.
- Harness tooling: `dev/run.mjs` gained `SB_BROWSER` (use an installed Chrome; Playwright's own download was missing on this Mac), `SB_ONLY` (run chosen suites), a `/favicon.ico` 204 and the failing resource URL in error text.
- Full-suite harness run under load average ~195 on installed Chrome: everything passed except `panels ... sb-p-progress-fill` (a different set of widths each run: animation timing, untouched code) and, before the favicon fix, three page-error checks caused by Chrome asking for `/favicon.ico`. The full run was not repeated after the favicon fix; the quick page checks were (all pass).
- Deviation: no per-message model switch (decision 4).

## Result: L6 settings panes, shutdown, runbook

- Zotero `content/preferences.js` + `.xhtml`: provider row shows the status sentence, Chat / Ask offer "On this Mac", report roles offer it only with the switch (or if already chosen), a refused change is explained, idle minutes / folders / switch rows. Obsidian `src/main.ts`: the same (lockstep, `tsc --noEmit` clean, 17 tests pass). `agentd.mjs`: SIGINT and `exit` also dispose the local provider (SIGTERM already did).
- `real-checks.md` written (runbook for the real Woof-4B check). Not run.
- Not built or published: no manifest bump, no xpi, no `install.sh`; `content/agent.js` and `content/sb-ui.js` are git-ignored build outputs (rebuilt locally, not committed).

## Result: real-model run and 0.39.1 (2026-10-03)

- Runbook steps 0-2 and the engine-level parts of step 3 ran against the real Woof 4B / 2B on this Mac (details in `real-checks.md`). Thinking is really off, citations and the not-in-passages answer behave, one server process at a time, idle stop and dispose work.
- Real bug found: a `.DS_Store` in the models folder crashed the scan (`ENOTDIR`). Fixed with `listDir` in `discover.js`, test added. agent-src 401 tests, obsidian-plugin 17, ui-src harness all green under installed Chrome, real-Zotero harness 24/26 files green (the other two: a stale spec-006 fixture test, and a test that needs the real server running, which passes when it is).
- Second real bug (found by a real `kill -9`): the stale-server reap ran after the memory check, so a leftover server's memory blocked the restart. Fixed (reap, wait, then check), test added.
- Published as 0.39.2 (both manifests, xpi, `install.sh`). Still owed: the GUI checks in the real apps.
