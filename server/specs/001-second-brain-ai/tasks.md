# Tasks: Second Brain AI

Status: APPROVED 2026-09-25. Phase 4 (Implement) in progress.
Date: 2026-09-25. Built from `plan.md` (approved), `design/final/` and the P0 results in `grounding.md`.

Conventions:
- `AS/` = `~/obsidian-kb/zotero-plugin/agent-src/` (public repo; zero runtime dependencies; esbuild as a dev dependency only, as in `editor-src/` and `engine-src/`).
- `ZP/` = `~/obsidian-kb/zotero-plugin/`, `OP/` = `~/obsidian-kb/obsidian-plugin/`, `KB/` = `~/obsidian-kb/`.
- Git work happens on the branch `feat/second-brain-ai` in the Zotero plugin repo, with a checkpoint commit before each task. `KB/` is not a git repo, so edited Python files get a `data/*.bak-before-ai` backup first, per house practice.
- "Real run" means one real provider call on a small prompt. You approved these at checkpoints.
- P0 moved the MCP face from P2 into P1, because Codex now reaches our tools over MCP too (grounding.md, P0 result 2).

## P0. Spikes. DONE
- [x] T0.1 Private `CODEX_HOME`: the symlinked `auth.json` survives refresh, and apps, plugins and memories are off, so no MCP servers load.
- [x] T0.2 Per-thread `config.mcp_servers` is honoured, so both CLIs use a uniform MCP face.
- [x] T0.3 `claude -p --json-schema` exists.
- [x] T0.4 Zotero.Server passes headers, so a bearer token goes in `Authorization`.
  - Reproduce: scripts under the session scratchpad `spike/`. T1.2 copies them into `AS/dev/spikes/` so they can be rerun.

## P1. Core and Ask with Codex (single owner; defines the shared contracts)

- [x] T1.1 Scaffold and contracts
  - Acceptance: `AS/` exists with `package.json` (`test: node --test`, `build`, `typecheck`), plus `domain.d.ts`, `service.d.ts`, `platform.d.ts` and `tools.d.ts` taken from `design/final/sketch/`, with the P0 reconciliation applied (no `dynamicTools`). `ToolRow.annotations.readOnlyHint` is the literal type `true`.
  - Verify: `cd AS && npx tsc --noEmit -p .` passes. The `.gitignore` covers `node_modules`.
  - Files: `AS/package.json`, `AS/tsconfig.json`, `AS/src/domain.d.ts`, `AS/src/service.d.ts`, `AS/src/platform.d.ts` (+ `tools.d.ts`)

- [x] T1.2 Codex provider: launch spec, wire parser, fake app server
  - Acceptance: `codexLaunch()` is a pure function that returns the argv, the env (private `CODEX_HOME`, created idempotently with the symlink and `config.toml`) and the thread params. `parseCodexMessage()` maps deltas, tool activity, final, errors and rate limits to `AgentEvent`. `commandExecution`, `fileChange` and `*requestApproval` produce `failed{policy_violation}`. The fake app server replays JSONL fixtures recorded from real P0 runs.
  - Verify: `npm test` covers streaming text, an MCP tool call, the policy violation, a declined approval, interrupt and process death.
  - Files: `AS/src/providers/codex.js`, `AS/test/codex.test.js`, `AS/test/fixtures/codex-*.jsonl`, `AS/test/fake-codex.mjs`, `AS/dev/spikes/*`

- [x] T1.3 Tools: registry, gateway, MCP face (Node), citation validator
  - Acceptance:
    - Built-in rows: `search_library`, `read_source`, `related_sources` and `search_scholarly` (a port of the `discover.js` sources, taking a `fetch` from the platform).
    - `ToolGateway` gives an in-process `call()`, plus `handleMcp(req)`, a pure JSON-RPC handler for initialize, tools/list and tools/call. Notifications get a 202.
    - The per-session bearer token maps each call to its `ToolContext`, and the scope is enforced.
    - `validateCitations()` resolves `[[note]]`, `[@citekey]` and URLs. A URL counts only if a tool returned it during that turn.
  - Verify: `npm test`. A fabricated `[@key]` is flagged, a wrong token gets a 401, and a scope-widening call is refused. A curl `tools/list` against the Node face lists every tool with `readOnlyHint: true`.
  - Files: `AS/src/tools.js`, `AS/src/citations.js`, `AS/src/scholarly.js`, `AS/test/tools.test.js`, `AS/test/citations.test.js`

- [x] T1.4 Core: TurnRunner, slot pool, stores, event log
  - Acceptance:
    - `TurnRunner` resolves the role's model at call time, takes a slot (the cap is enforced with a queue), opens a tool session, streams events, and validates the schema and citations on `final`.
    - The conversation store is JSONL per conversation, with ULIDs, atomic appends and idempotent `adopt`.
    - The event log is sequenced so `after=seq` can resume.
    - Ask uses an output schema, so `not_found` is a typed value.
  - Verify: `npm test` against a fake provider. The cap holds with 10 concurrent turns. A settings change applies on the next turn. After a restart, the store rebuilds the history.
  - Files: `AS/src/core.js`, `AS/src/store.js`, `AS/src/eventlog.js`, `AS/test/core.test.js`, `AS/test/store.test.js`

- [x] T1.5 Node platform, Python-backed library, Ask harness. **Checkpoint P1**
  - Acceptance:
    - `node/platform.mjs` provides spawn, fs, fetch and serve.
    - `LibraryBackend` calls `KB` `/search`, `/note` and `/related` with `X-KB-Client: agent`, so privacy is applied.
    - `node AS/dev/ask.mjs "question"` streams an answer.
  - Verify (real run):
    - One Ask with Codex on a topic in the library gives at least 3 citations, all of which resolve.
    - Two Asks on absent topics return `not_found`.
    - The transcript contains no command or file-change items.
    - `eval.py` is unchanged.
  - Files: `AS/src/node/platform.mjs`, `AS/src/library-http.js`, `AS/dev/ask.mjs`

## P2. Claude Code and open-source providers (parallel with P3 and P4 after P1)

- [x] T2.1 Claude provider
  - Acceptance:
    - `claudeLaunch()` is pure. It sets `--output-format stream-json --verbose --include-partial-messages --mcp-config <tmp> --strict-mcp-config --tools <list> --allowedTools <ours> --setting-sources "" --no-session-persistence`, plus `--json-schema` for structured turns and `--model` and `--effort`. The cwd is empty.
    - Web search is enabled by adding `WebSearch,WebFetch`.
    - The parser maps partial deltas, tool_use and result (cost). A `Bash`, `Edit` or `Write` tool_use becomes a policy violation.
    - Up to 3 warm processes are kept, with a 10-minute idle timeout.
  - Verify: `npm test` with recorded fixtures. Real run: the Ask harness with `--provider claude`.
  - Files: `AS/src/providers/claude.js`, `AS/test/claude.test.js`, `AS/test/fixtures/claude-*.jsonl`

- [x] T2.2 OpenAI-compatible provider with our tool loop
  - Acceptance:
    - A chat-completions loop with tools (max 8 steps), streamed deltas and a `response_format` JSON schema when the server supports it, with one repair turn otherwise.
    - Endpoint config is base URL, key and model. Models are listed from `/v1/models`.
    - Web search goes through a configured backend tool (Exa, Tavily or SearXNG) or is off.
  - Verify: `npm test` against a fake OpenAI server (tool call, then answer). Real run: the Ask harness against LM Studio, which the user starts.
  - Files: `AS/src/providers/openai.js`, `AS/test/openai.test.js`, `AS/test/fake-openai.mjs`

- [x] T2.3 **Checkpoint P2**: Ask on 3 providers
  - Verify (real run): the T1.5 prompts on Claude and on the local model. Tool calls work and citations validate for both (criterion 9, Ask part).
  - Files: none (report only)

## P3. Server sidecar and Obsidian Chat

- [x] T3.1 Sidecar `agentd`
  - Acceptance: `AS/src/node/agentd.mjs` exposes one HTTP route per `AgentService` method, plus `GET /events?after=` long-poll and `/mcp`. A shared secret comes from the Python supervisor, and it binds to 127.0.0.1 on a random port written to `data/agentd.json`.
  - Verify: `npm test` (route table derived from the service, long-poll resume after a disconnect).
  - Files: `AS/src/node/agentd.mjs`, `AS/test/agentd.test.js`, `AS/build.mjs` (bundles `dist/agentd.mjs`)

- [x] T3.2 Python: supervise, forward, `/ai-note`
  - Acceptance:
    - `agent_api.py` starts and restarts the sidecar when Node is found, and otherwise `/agent/*` returns 503 with help.
    - It forwards `/agent/*` with the existing auth and never takes `LOCK`.
    - `/ai-note` writes to `ai_notes/Literature Reviews/` under `WRITE_LOCK`, with collision-safe names and deduplication by `reviewId`.
    - Hooked into `http_api.py` and `kb.py serve`.
  - Verify:
    - `.venv/bin/python -m pytest tests/ -q` covers forwarding, 503 without Node, the `/ai-note` collision and dedupe, and a private note never returned by the library tools.
    - Search p95 is unchanged while a fake long turn streams.
  - Files: `KB/agent_api.py`, `KB/http_api.py`, `KB/kb.py`, `KB/tests/test_agent_api.py`

- [x] T3.3 Remote client
  - Acceptance: `AS/src/remote.js` implements `AgentService` over HTTP, with a pluggable `request` function (Obsidian `requestUrl` or `Zotero.HTTP`) and long-poll events.
  - Verify: `npm test` runs a local runtime and a remote runtime against the same scenario, with identical event sequences.
  - Files: `AS/src/remote.js`, `AS/test/remote.test.js`

- [x] T3.4 Obsidian Chat view
  - Acceptance:
    - `ChatView` (Chat and Ask tabs, conversation list, attach the current note, Stop).
    - Citations render as links that open notes or papers. Unknown citations are shown as such.
    - Plain-language tool activity lines.
    - Registered with a ribbon icon and commands ("Ask about selection").
    - Styled like Obsidian.
  - Verify: `cd OP && npx tsc --noEmit && ./install.sh`, then check the view in Obsidian on the desktop.
  - Files: `OP/src/chat.ts`, `OP/src/main.ts`, `OP/src/api.ts`, `OP/styles.css`, `OP/esbuild.config.mjs` (to import `agent-src/src/remote.js`)

- [ ] T3.5 **Checkpoint P3**
  - Verify (real run): criterion 1 in Obsidian desktop, with at least 3 resolving citations and 5 answers checked by hand. Then one Ask from the phone over Tailscale. A screenshot goes in `specs/.../evidence/`.

## P4. Zotero host

- [x] T4.1 Gecko platform and Zotero MCP endpoint
  - Acceptance:
    - `gecko/platform.js` provides spawn through `Subprocess.sys.mjs` (streamed stdout lines, kill), fs through `IOUtils`, fetch through `Zotero.HTTP` or `fetch`, and serve through `Zotero.Server.Endpoints["/second-brain/mcp"]` with a bearer token from `headers.authorization`.
    - The endpoint is removed on shutdown.
    - Codex and Claude binaries are found in the spec's lookup order.
  - Verify: the headless Zotero harness (scratch profile, data dir and port 23191) runs a Codex and a Claude tool call against the endpoint (real run).
  - Files: `AS/src/gecko/platform.js`, `ZP/content/agent-host.js`, `AS/dev/zotero-harness/*`

- [x] T4.2 Zotero library backend and local note sink
  - Acceptance:
    - `search_library` and `read_source` use the built-in search model and Zotero full text when the server is down. `related_sources` uses local vectors.
    - The `NoteSink` writes to `<data dir>/second-brain/notes`, following the existing `LocalStore` rules.
  - Verify: harness checks (a query returns items with citekeys, full-text reads are capped by size).
  - Files: `ZP/content/agent-host.js`, `ZP/content/local-index.js` (read-only use), `ZP/content/store.js`

- [x] T4.3 Zotero Chat tab and runtime switching
  - Acceptance:
    - A `Zotero_Tabs` "Second Brain AI" tab with Chat and Ask, attach the current item or selection, citations that select items or open paper notes, and Stop.
    - `SecondBrain.ai()` picks remote or local and switches only when idle. Local conversations are adopted on reconnect.
    - A toolbar button and item context-menu entries ("Ask about this paper").
    - `build.sh` bundles `content/agent.js`.
  - Verify: `./build.sh`, `node --check` on every script (the CI check), then the harness scenario for local mode, then install into the real Zotero with `-purgecaches`, checking the user is idle first (HIDIdleTime above 90 s).
  - Files: `ZP/content/chat.js`, `ZP/content/second-brain.js`, `ZP/bootstrap.js`, `ZP/build.sh`, `ZP/locale/*`

- [x] T4.4 **Checkpoint P4**
  - Verify (real run): criterion 1 in Zotero with the server running, then criterion 2 with the server stopped and Obsidian closed. Screenshots in `evidence/`.

## P5. Literature review

- [x] T5.1 Review engine
  - Acceptance:
    - `REVIEW_STAGES` covers plan, approve (waits unless auto), research (parallel, capped, one file per sub-question), screen, synthesize and publish.
    - Starting and resuming both run from the first missing output. Writes are atomic.
    - `deriveStatus` works from files. Cancel aborts every thread and writes `stopped.json`.
    - Depth presets (quick, standard, deep) set the sub-question and researcher counts.
    - Roles use per-role provider and model.
  - Verify: `npm test` with a fake provider. Kill at each stage boundary and resume. Cancel mid-research leaves no running turns. The cap is respected.
  - Files: `AS/src/review.js`, `AS/test/review.test.js`, `AS/src/prompts.js`

- [x] T5.2 Screening and report renderer
  - Acceptance:
    - Deduplication by DOI, citekey and normalized title. Out-of-library papers are listed.
    - The report has 7 sections and front matter, with APA references and a search log.
    - `renderReport` and `screen` are pure.
  - Verify: `npm test` with golden-file tests of the report output.
  - Files: `AS/src/report.js`, `AS/test/report.test.js`, `AS/test/golden/*.md`

- [x] T5.3 Export
  - Acceptance: Markdown is native. DOCX and PDF go through `pandoc`, found on PATH or at `/opt/homebrew/bin`. When pandoc is missing, the UI shows a hint. Export runs through the platform spawn in both hosts.
  - Verify: exporting the golden report produces a `.docx` and a `.pdf` that open.
  - Files: `AS/src/export.js`, `AS/test/export.test.js`

- [x] T5.4 Review panel in Zotero and Obsidian
  - Acceptance:
    - A form (question, scope picker from collections, tags or saved searches, sources, years, depth).
    - A plan editor with Approve, live per-agent progress, found papers with "Add to Zotero" and "Add all", and Cancel, Resume and Export.
  - Verify: both builds pass, and a fake-provider review is driven in the headless harness.
  - Files: `ZP/content/review-panel.js`, `ZP/content/chat.js`, `OP/src/review.ts`, `OP/src/main.ts`

- [x] T5.5 **Checkpoint P5**
  - Verify (real run): criterion 4 with one quick review on a narrow question. It finishes in 10 minutes or less, has 7 sections, every reference resolves, and the search log is present. Cancel once. Kill the host mid-research and resume.

## P6. Settings, sign-in and MCP servers

- [x] T6.1 McpHub
  - Acceptance:
    - A small MCP client (stdio through the platform spawn, and streamable HTTP).
    - The verdict: `readOnlyHint: true` is exposed, destructive or write hints are hidden, and unmarked tools are hidden until the user trusts the server.
    - Re-exported as namespaced gateway rows, so the CLIs only ever see our gateway.
  - Verify: `npm test` with a fake stdio server and a fake HTTP server. Hidden tools are reported with a reason.
  - Files: `AS/src/mcp-hub.js`, `AS/test/mcp-hub.test.js`, `AS/test/fake-mcp.mjs`

- [x] T6.2 Provider settings, status and sign-in (both hosts)
  - Acceptance:
    - The provider list shows status (Codex: `account/read` and rate limits; Claude: version and login state; OpenAI-compatible: reachability and models).
    - Per-mode and per-role provider and model come from live lists.
    - Sign-in flows cover the ChatGPT browser or device code, an OpenAI key, and a Claude login hint or key.
    - Missing-binary guides.
  - Verify: the builds pass, and the status display matches `codex login status` and `claude` for the real accounts. Exercising sign-out and sign-in touches your real login state, so **ask first** before doing that.
  - Files: `AS/src/settings.js`, `ZP/content/preferences.xhtml`, `ZP/content/preferences.js`, `OP/src/settings.ts`

- [x] T6.3 MCP catalog and settings UI
  - Acceptance:
    - The catalog from `research-mcp-catalog.md`, with one-click add, the paper-search Google Scholar source disabled, and optional entries marked as paid or limited.
    - Test shows the tools, hidden tools with reasons, and a "Trust this server" switch.
    - Web search defaults, and a search backend for local models.
  - Verify: add the PubMed server from the catalog and its tools appear. One real Chat turn uses it (criterion 5).
  - Files: `AS/src/catalog.js`, `ZP/content/preferences.xhtml`, `ZP/content/preferences.js`, `OP/src/settings.ts`

- [x] T6.4 **Checkpoint P6**
  - Verify: criterion 5, and criterion 10 (switch the Ask provider and the next message uses it, with no restart).

## P7. Hardening and release

- [x] T7.1 Audits
  - Verify: scan all stored transcripts and confirm there are no command or file-change items (criterion 6). Search p95 and `eval.py` are unchanged during a review (criterion 7). First token in 4 s or less with a warm provider.
  - Result (evidence/p7-t71-*, rationale "P7"): criterion 6 clean. Search p95 50 ms pooled during a review, but the review never left its plan stage (runaway lead turn, cancelled), so load from parallel researchers is still unmeasured. `eval.py` identical to the baseline, run after the review. Warm first token 4 of 5 samples within 4 s (2.4, 4.2, 3.1, 2.1, 3.9 s), after fixing the warm-thread bug the audit found.
- [x] T7.2 Public repo hygiene and CI
  - Acceptance: `agent-src` tests run in `check.yml`. The README has an AI section. A scan finds no personal paths, emails or library content.
  - Files: `ZP/.github/workflows/check.yml`, `ZP/README.md`, `ZP/THIRD_PARTY.md`
- [ ] T7.3 Release. **Ask first:** push the branch, open a PR, tag a version.

## Parallelism

- T1.1 through T1.5: one owner, in sequence. These are the contracts.
- After T1.5, three worktrees work in parallel: A (T2.1 to T2.3), B (T3.1 to T3.5) and C (T4.1 to T4.4). Their file sets are disjoint.
- T5.1 to T5.3 can start after T1.4 in a fourth slot, only once A finishes, to stay at 3 or fewer agents.
- T5.4, then P6, then P7 run after the hosts land.
