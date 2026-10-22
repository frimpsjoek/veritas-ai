# Plan: Second Brain AI

Status: APPROVED 2026-09-25 (all four approval items: yes). Phase 3 (Tasks) in progress.
Date: 2026-09-25. Inputs: `spec.md` (approved, amended for providers), `grounding.md` (two spikes), `design/final/` (synthesized architecture), `research-mcp-catalog.md`.

## Architecture in one page

```
 Zotero tab (chat.js) ──┐                        ┌── Codex app-server (JSON-RPC stdio)
 Obsidian view (chat.ts)├─ AgentService ─ TurnRunner ─ Provider ─┼── claude -p stream-json
 Review panel ──────────┘      │              │                  └── OpenAI-compatible HTTP (our tool loop)
                               │              └─ ToolGateway ── LibraryBackend (Python /search | Zotero local index)
                               │                   │  faces: in-process · MCP over HTTP · (dynamicTools, if T0 says so)
                               │                   └─ McpHub ── user-added MCP servers (read-only verdict)
                               └─ stores: conversations (JSONL), reviews (stage files), event log (seq)
```

- **One JS core** in `zotero-plugin/agent-src/`. It has zero npm dependencies and is tested with `node --test`. It builds to three bundles: Zotero (in-process), the Node sidecar, and a remote client for Obsidian.
- **One runtime per machine.** When the server runs, its Node sidecar is the only runtime, and Zotero and Obsidian are clients. When Zotero is alone, Zotero is the runtime. One writer per store, and one slot pool for the parallel cap.
- **Python** only supervises the sidecar, forwards `/agent/*` behind the existing auth, applies privacy on library tools, and writes reports through a new collision-safe `/ai-note`.
- **Obsidian** uses a sequenced event log read by long-poll, on desktop and phone alike.
- **Isolation.** Codex runs with a private `CODEX_HOME` (our `config.toml` plus the user's `auth.json`). Claude runs with `--setting-sources "" --strict-mcp-config`, an explicit tool list and an empty cwd. User MCP servers connect to our gateway, never to the CLIs.
- **Safety at runtime.** A command, file-change or approval item from a provider fails the turn with `policy_violation`.

Details and rejected alternatives: `design/final/rationale.md`. Types: `design/final/sketch/`.

## Phases

Each phase ends in a working, checkable slice. It is built, verified and committed before the next phase starts.

### P0. Spikes (gate for everything)
Settle the four unverified facts the design branches on. Each takes minutes and uses at most one tiny prompt.
1. **Private `CODEX_HOME` with a symlinked `auth.json`.** Does `account/read` (with token refresh) keep the symlink, or does it replace it with a file? Does the private `config.toml` stop the user's MCP servers from loading? If refresh breaks the symlink, fall back to the real `CODEX_HOME` with per-thread config overrides.
2. **Per-thread `thread/start.config.mcp_servers`.** Two threads with different MCP URLs in one app server. Does each thread call its own URL? This decides uniform MCP or `dynamicTools` for Codex.
3. **Claude structured output.** Is there a native JSON-schema flag in 2.1.282? Otherwise use the repair turn.
4. **Zotero.Server request headers.** Can the endpoint read `Authorization`? This decides a header token or a path token.

Output: results appended to `grounding.md`, and `design/final` updated where a branch is resolved.

### P1. Core and Ask with Codex, end to end in Node
- `domain.d.ts`, `service.d.ts` and `platform.d.ts` land first. These are the shared contracts.
- Also in this phase: `providers.js` (Codex adapter and parser), `core.js` (TurnRunner, slot pool, conversation store, event log), and `tools.js` (registry, in-process face, citation validator), plus the Python-backed `LibraryBackend`.
- A fake app server replays recorded transcripts in `node:test`.
- Dev harness: `node agent-src/dev/ask.mjs "question"` runs against the real server's `/search`.
- **Checkpoint:** tests are green. A real Ask with Codex cites at least 3 library sources, all of which resolve. Ask on an absent topic returns `not_found`.

### P2. Claude Code and open-source providers

(After P0: the MCP face moved into P1, because Codex uses MCP too. `dynamicTools` is dropped.)
- Claude adapter and stream-json parser. The OpenAI-compatible adapter with our tool loop. The MCP face (Node `http`) with a per-session token.
- **Checkpoint:** the same Ask harness passes with Claude Code and with one local model through LM Studio, which the user starts. Recorded-transcript tests cover each parser and the policy-violation cases.

### P3. Server sidecar and Obsidian Chat
- `agent_api.py` (supervise `agentd.mjs`, forward `/agent/*` without the global LOCK, `/ai-note` writer under WRITE_LOCK). The sidecar routes derive 1:1 from `AgentService`.
- The Obsidian `ChatView` (Chat and Ask, citations as links, conversation list, Stop) uses `remote.js` long-poll.
- pytest: SSE and long-poll framing, privacy on library tools, `/ai-note` collision safety, search not blocked during a turn.
- **Checkpoint:** success criterion 1 in Obsidian desktop, then a quick check on the phone over Tailscale.

### P4. Zotero host
- `gecko/platform.js` (Subprocess, IOUtils, Zotero.Server MCP endpoint), `agent-host.js` (LibraryBackend on the built-in index and Zotero full text, local NoteSink), and the `chat.js` tab (Chat and Ask, attach the current item or selection).
- Runtime switching: remote when `/agent/ping` answers, otherwise local. Switch only when idle. Adopt local conversations idempotently.
- **Checkpoint:** criterion 1 in Zotero with the server running, and criterion 2 with the server stopped and Obsidian closed, tested in a headless Zotero harness and then the real app.

### P5. Literature review
- `review.js`: stages plan, approve, research (parallel, per-sub-question files), screen, synthesize and publish. `deriveStatus`, cancel and resume. The report renderer covers the 7 sections and APA references.
- A review panel in both hosts: question and scope form, plan editor with Approve, live progress, found papers with "Add to Zotero" and "Add all", Cancel and Resume.
- Export: Markdown (native), DOCX and PDF through `pandoc`, which is already installed at `/opt/homebrew/bin/pandoc`. When pandoc is missing, show a hint.
- **Checkpoint:** criterion 4. A quick review finishes in 10 minutes or less, the report has all 7 sections, every reference resolves, cancelling stops every thread, and a review killed mid-run resumes.

### P6. Settings: providers, sign-in, MCP
- Provider list with status (Codex rate limits, Claude cost, local endpoint reachability). Per-mode and per-role provider and model, from the live `model/list`, `claude` models and `/v1/models`.
- Sign-in flows (ChatGPT browser or device code, API keys, Claude login hint).
- The MCP server list with Test (showing hidden tools and reasons) and "Trust this server". The catalog is from the research, with one-click add. Web search defaults, and a search backend for local models.
- **Checkpoint:** criteria 5 and 10.

### P7. Hardening and release
- Latency and recall checks (criterion 7). Transcript audit for criterion 6. The first-token timing target.
- A public-repo hygiene scan (no personal paths or data). README and CI for `agent-src` tests.
- Release of the Zotero plugin: **ask first.**

## Throughput checkpoint

- **Blocking first steps.** P0 spikes, then the P1 contracts (`domain.d.ts`, `service.d.ts`, `platform.d.ts`, tool-row type) land on main before any fan-out.
- **Independent workstreams after P1.** Three workstreams in disjoint files. (a) P2 providers: `providers.js`, and the MCP face in `tools.js`. (b) P3 server and Obsidian: `agent_api.py`, `node/*`, `obsidian-plugin/src/chat.ts`. (c) P4 Zotero: `gecko/*`, `content/chat.js`, `agent-host.js`. P5 starts after P1 and needs only `core.js`. P6 follows P2.
- **Shared mutable state.** The contracts. Everything else is split by file. `tools.js` is touched by P1 and P2 only, in sequence. `core.js` changes after P1 go through me.
- **Smallest safe decomposition.** At most 3 parallel implementation agents at once, each in its own git worktree. The limit comes from the Mac concurrency limit and from reviewability. P1 is one owner, because it defines the contracts everything else builds on.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Codex 0.155 is an alpha that updates with ChatGPT.app. The protocol and the experimental `dynamicTools` may change. | Pin behavior with recorded-transcript tests. At startup, diff the generated schema for the methods we use and show a clear "Codex updated; AI may misbehave" notice. Prefer the stable MCP face if P0.2 allows it. |
| Real-provider tests spend the user's quota. | Fake servers for all unit tests. Real runs only at phase checkpoints, with small prompts. |
| The Mac runs out of memory with many agent processes. | One Codex app server serves all threads. At most 3 warm Claude processes. The review cap defaults to 3 (max 5). One runtime per machine. |
| The Zotero.Server endpoint is reachable by any local process. | Per-session token (P0.4). Only read-only tools. Zotero already drops foreign `Origin` headers. |
| Local open-source models make poor tool calls. | Strict JSON-schema tool args, one repair turn, and a UI label ("local models may miss sources"). Criterion 9 only requires working tool calls and validation. |
| The server now depends on Node. | Without Node, `/agent/*` returns 503 with help, and Zotero stays local. The Node path is discovered as `~/.local/bin/node`, then Homebrew, then PATH. |
| Prompt injection from notes or web pages. | Tool outputs are wrapped as data, agents are read-only, the policy-violation guard is on, and nothing is ever added to Zotero automatically. |

## Verification per phase

Each phase has a checkpoint above. The commands are in `spec.md` under Commands. Every phase also re-runs `eval.py` (recall unchanged), the Zotero CI checks (`node --check` and the build) and `npx tsc --noEmit` for Obsidian.

## Needs your approval in this plan

1. **Node for server-side AI.** The sidecar runs on Node 22, already installed at `~/.local/bin/node`. Zotero standalone doesn't need it.
2. **The agent core in the public Zotero repo.** The core is generic, with no personal data. Only `agent_api.py` and the Obsidian view stay private.
3. **pandoc for DOCX and PDF export.** It is already installed. It is optional, with Markdown always available.
4. **Real-provider test runs** at each checkpoint. About 5 to 10 small prompts per phase across Codex, Claude and a local model, plus one quick review in P5.
