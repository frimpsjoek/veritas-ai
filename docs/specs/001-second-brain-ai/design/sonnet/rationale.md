# Second Brain AI — architecture (candidate: sonnet)

## Problem

Three hosts (Zotero standalone, Obsidian desktop, Obsidian mobile through the server) must offer Chat, Ask and
literature review, driven by three kinds of provider: two agentic CLIs that run their own tool loop (Codex
app-server, Claude Code headless) and OpenAI-compatible endpoints that have no loop at all. Zotero has no Node, so
any code that must run inside it is plain JS. Obsidian mobile cannot run a provider at all. When the server is
running, chats and reviews must be shared and have one writer. The spike proved HTTP MCP works for both CLIs and
that Codex also has `dynamicTools`; it left `Zotero.Server.Endpoints` unverified for JSON-RPC POSTs. The design
must not leak `item/agentMessage/delta` vs. Claude's `stream-json` vs. an OpenAI SSE chunk past one seam.

## Usage (caller's view)

All three hosts import the same `@second-brain/agent-core` package and talk to one facade, `SecondBrainCore`. It
has two concrete backings — `EmbeddedCore` (owns providers and tools in this process) and `RemoteCore` (an SSE/REST
client of the server) — chosen once, by reachability, never branched on by callers.

```js
// zotero-plugin/content/chat.js — Zotero chat tab
const core = SecondBrainCore.forHost({ role: "zotero", dataDir: Zotero.SecondBrain.dataDir, serverUrl });
const conv = await core.openConversation(itemKey);
for await (const ev of core.chat(conv.id, { text }, { providerId: settings.chatProvider })) {
  if (ev.type === "text") appendToken(ev.delta);
  if (ev.type === "tool_call") showActivity(ev);           // "Searching your papers for 'X'"
  if (ev.type === "turn_completed") renderCitations(conv.id);
}
```

```ts
// obsidian-plugin/src/chat.ts — desktop or mobile, identical call
const core = SecondBrainCore.forHost({ role: "obsidian", app: this.app, remoteUrl: settings.remoteUrl, token });
for await (const ev of core.chat(conversationId, { text, attachments }, { providerId: settings.chatProvider })) {
  renderer.onEvent(ev);
}
```

```js
// review runner, either host
const handle = await core.startReview({
  question, scope, sources, yearRange, depth,
  providers: { lead: "claude-code", researcher: "codex", writer: "claude-code" },
});
core.subscribeReview(handle.id, (ev) => progressView.update(ev));   // stage, per-agent status, papers found
// later, after a restart:
const resumed = await core.resumeReview(handle.id);                // continues from last finished stage
```

One interface serves Chat, Ask (a non-streaming wrapper that awaits the same event stream and asserts one
citation-checked answer) and review. Callers never see wire formats, CLI flags, or which provider backs a mode.

## Shape

**Provider layer — one interface, two loop-drivers.** `AgentProvider.startThread()` returns an `AgentThread` whose
`send()` yields `AgentEvent`, a closed discriminated union (`text`, `reasoning`, `tool_call`, `web_search`, `usage`,
`turn_completed`, `error`). `CodexProvider` and `ClaudeCodeProvider` each drive their CLI's own loop and translate
its notifications into this union (Codex's `item/*` stream, Claude's `stream-json` blocks); both auto-decline every
`*requestApproval`. `OpenAiCompatProvider` has no loop to drive, so it is the one caller of `ToolLoopRunner`, a
module that calls chat-completions, executes any `tool_calls` against the shared `ToolRegistry`, appends results,
and loops — emitting the *same* event union by wrapping each call in synthetic `tool_call` start/complete events.
The UI, the citation validator and the review stage code all consume `AgentEvent` only; none of them import a
wire-format type (per boundary-discipline — parsing happens once, at the provider boundary).

**Tool channel — registry once, transport per constraint.** `ToolRegistry` (search_library, read_source,
search_scholarly, plus user MCP servers merged in) is the single source of truth for what an agent may call; each
host fills it from its own backing (Zotero's `local-index.js`/`discover.js`, or the server's `kb.py` +
`privacy.json`). Three transports reach it, chosen by what each provider actually accepts, not by host:
- Codex: `DynamicToolBridge` answers `item/tool/call` directly against the registry — no network hop, no server.
- Claude Code (any host) and user-added MCP servers: `McpToolServer`, one streamable-HTTP JSON-RPC surface
  (`initialize`, `tools/list`, `tools/call`) over the registry. In the server process this rides the existing
  `ThreadingHTTPServer`. In Zotero standalone there is no Node to run one, so `McpToolServer` gets a
  `ZoteroServerTransport` built on `Zotero.Server.Endpoints` (port 23119) — confirmed by spike 2: both Claude Code
  and Codex called a tool through it. `ZoteroServerTransport` is a second, swappable implementation of the same
  transport interface as the server's own, not a special case Zotero code branches on.
- OpenAI-compat: `ToolLoopRunner` calls `ToolRegistry.call()` in-process. No transport at all — the shortest path,
  since there is no external process to negotiate with.

**Every tool declares `annotations.readOnlyHint: true`, enforced at registration, not at call time.** Spike 2 found
Codex refuses an MCP tool call under `approvalPolicy: "never"` unless the tool's own schema carries that hint — a
missing-approval failure would otherwise look like a Codex bug when it is really a registry omission. `ToolSpec`
makes the hint a required field (not optional-with-default), so `ToolRegistry.register()` cannot compile a tool
without it (per encode-lessons-in-structure). User-added MCP servers are the one source of tools we don't author:
`McpServerConfig.test()` (the Settings "test" action, `mcpServerStatus/list`) inspects each returned tool's
annotations and the catalog/settings UI marks any tool missing `readOnlyHint` as "won't work with Codex" rather than
silently listing it as available — read-only-by-policy in F5/F6 becomes read-only-by-declaration here.

**Core hosting — one JS module, no Python port.** The core (JSON-RPC clients, orchestration, prompts, citation
validator, stage machine) is one package. Zotero has no choice but to host it directly (no Node). Obsidian desktop
also hosts it directly — it already runs a Node-capable Electron process for streaming (per the existing tech
stack) — so the common interactive case never pays for a sidecar. The server runs a **Node sidecar** it spawns and
supervises, hosting the identical package, because two requirements can't be met by Obsidian-hosts-the-core alone:
Obsidian mobile has no runtime for it, and a review must survive Obsidian being closed. A Python port was rejected
because it would fork prompts, event-translation and the citation validator into two languages that must stay
byte-identical; the sidecar keeps one implementation and pays only a supervised-child-process cost, which
`agent_api.py` already tolerates for `kb.py serve`'s own worker model.

**Literature review — data-first stage machine.** `ReviewStage<I,O>` matches the spec's table exactly: `run` is a
pure function from the previous stage's output to the next, `outputFile` is the resume marker. `ReviewRunner.resume(dir)`
is the entire resume story — no separate status field, no state enum, because the source of truth is which files
exist. `ParallelCap` is a plain counting semaphore threaded through the research stage's `Promise.allSettled` fan-out; it
lives whichever process runs the stage, so when the server is up, **all** reviews (from Zotero, Obsidian, or
mobile) execute inside the one sidecar — Zotero delegates review execution to the server instead of running its own,
specifically so the cap and the disk-resume state have one owner. Only in Zotero-standalone mode does Zotero run
`ReviewRunner` itself, and then it is the only host active, so the cap needs no cross-process coordination.
Cancellation is one `AbortController` per review; the signal reaches every open `AgentThread.interrupt()` and every
pending `ParallelCap` slot.

**Conversation store — one writer per store instance, never two live at once.** `ConversationStore.append` is the
only write path (JSONL). Zotero owns a `LocalConversationStore` used only while standalone. The server's sidecar
owns the canonical `ConversationStore` at `data/chats/`; Obsidian (desktop and mobile) and Zotero-with-server all
route through it as `RemoteCore` clients, so it is the sole writer whenever it exists. On server start,
`adoptLocalConversations(zoteroChatsDir)` copies in any Zotero-local JSONL files not already present — the same
adoption pattern the vault indexer already uses for local notes. The invariant callers can rely on: a store instance
is either local-and-solo or remote-and-shared, never both for the same conversation id.

**Isolation** is entirely inside `CodexProvider`/`ClaudeCodeProvider`'s constructors, invisible above them: a
dedicated `CODEX_HOME` per launch holding only a copied `auth.json`, `-c mcp_servers={}` plus our own
`McpToolServer` URL, `sandbox: "read-only"`, `approvalPolicy: "never"`; Claude gets `--strict-mcp-config
--mcp-config <ours> --setting-sources "" --tools ""`. No caller of `AgentProvider` can see or override these flags.

## Tradeoffs accepted

- We accept `Zotero.Server.Endpoints` as Zotero's only tool-serving transport (confirmed by spike 2) in exchange for
  zero new runtime dependencies in the public plugin; we still keep the transport behind an interface rather than
  calling `Zotero.Server` directly from `McpToolServer`; so a future constraint (e.g. concurrent request limits
  under a deep review) can swap the transport without touching the registry or either CLI provider.
- We accept a supervised Node sidecar (one more process, one more restart path) in exchange for a single
  orchestration implementation instead of a Python fork of prompts and the citation validator.
- We accept that Zotero-with-server gives up local review execution (always delegates to the sidecar) in exchange
  for one enforcement point for the parallel cap and one writer for chat/review state.
- We accept that `ToolLoopRunner` (open-source models) reconstructs synthetic `tool_call` start/complete events
  around a single request/response, which is less granular than the CLIs' native streaming, in exchange for callers
  never branching on provider kind.

## Alternatives considered

- **Two provider interfaces** (one for loop-driving CLIs, one for bare chat endpoints), with the UI switching on
  which it got. Rejected: it pushes the CLI-vs-loop distinction onto every caller, the exact leak
  boundary-discipline forbids; `AgentEvent` already hides it at no extra caller cost.
- **Python port of the core for the server**, so the server never spawns Node. Loses the single-implementation
  guarantee for prompts and the citation validator — the same review, run from Zotero (JS) and the server
  (Python), could silently diverge. Rejected as information leakage of the orchestration policy into two languages.
- **dynamicTools-only for Zotero, Claude Code out of scope there.** Simpler, but the spec requires Claude Code as a
  provider everywhere a provider works; Zotero is public and users may prefer Claude. Rejected as under-scoping the
  interface to fit one transport's limits instead of adding the one transport that's missing.

## Open questions and risks

- Is a supervised Node sidecar acceptable operationally (crash/restart policy, log location under
  `~/obsidian-kb/data/`), or would the user rather the server itself be blocked on review completion? Assumed:
  supervised and independently restartable, matching `kb.py serve`'s own worker model.
- Should `RemoteCore` cache anything client-side (e.g., last N events) to survive a dropped SSE connection, or is
  reconnect-and-replay-from-store sufficient? Assumed the latter, since `ConversationStore` already persists every
  turn.
- For a user-added MCP server that lacks `readOnlyHint` on some tools but not others: do we drop only the
  unannotated tools (partial catalog) or refuse the whole server? Assumed partial — Settings marks the specific
  tools that won't work with Codex, since Claude Code and open-source providers don't share that restriction.

## Next implementation step

Write `ToolSpec` and `ToolRegistry.register()` first (sketch/tools.d.ts already drafts them), since the
`readOnlyHint` requirement they enforce gates every other tool-facing piece: the Codex bridge, `McpToolServer`, and
the Settings catalog test.
