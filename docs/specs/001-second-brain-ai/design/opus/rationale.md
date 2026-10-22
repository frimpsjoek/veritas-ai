# Second Brain AI: architecture (opus candidate)

## Problem

Chat, Ask and a multi-agent literature review must run on three kinds of provider and in three hosts. Two providers (Codex app-server, Claude Code headless) run their own tool loop over different wire formats. OpenAI-compatible endpoints run no loop at all. Zotero must work alone, with no Node, spawning processes through `Subprocess.sys.mjs`. Obsidian on the phone can only reach the Python server. Constraints from grounding: Zotero's 23119 server works as an MCP endpoint for both CLIs (verified). Codex refuses MCP tools without `readOnlyHint: true` under approval `never`. `codex app-server` loads `~/.codex/config.toml` unless isolated. The server's `LOCK` must never be held by a stream. `privacy.json` applies on the `X-KB-Client: agent` routes. The Mac swaps past about 6 parallel agent processes.

## Usage (caller's view)

Every UI holds one `AgentService` and cannot tell whether the core runs in-process or behind the server.

```js
// Zotero chat tab (content/chat.js)
const ai = await SecondBrain.ai();              // remote runtime if /agent/ping answers, else the local one
const id = conversationId ?? await ai.conversations.create("chat");
for await (const ev of ai.conversations.send(id, { text, attachments: [{ kind: "zoteroItem", citekey }], web: "cached" }, { signal: stop.signal })) {
  if (ev.type === "text") view.append(ev.delta);
  else if (ev.type === "activity") view.activity(ev);          // "Searching your papers for 'X'"
  else if (ev.type === "done") view.finish(ev.answer.citations); // unknown ones marked, never shown as real
  else if (ev.type === "failed") view.error(ev.error.message);
}
```

```ts
// Obsidian view (src/chat.ts), desktop and phone
const ai = createRemoteRuntime(Platform.isMobile ? longPollTransport(api) : sseTransport(api));
for await (const ev of ai.ask(selection, { attachments: [{ kind: "note", path }] })) {
  if (ev.type === "done" && ev.answer.structured.status === "not_found") showNotFound(ev.answer.structured.markdown);
}
```

```js
// Review panel, either host
const rid = await ai.reviews.start({ question, scope: { kind: "collection", name: "Sleep" }, sources: ["library", "scholarly"], years: { from: 2018, to: null }, depth: "quick" });
for await (const p of ai.reviews.watch(rid)) {
  if (p.status.state === "awaiting_approval") await ai.reviews.approvePlan(rid, await editPlan(p.status.plan));
  render(p);                                                     // stages, per-agent state, papers found
}
cancelButton.onclick = () => ai.reviews.cancel(rid);             // Resume later: ai.reviews.resume(rid)
```

## Shape

**One runtime per machine, one writer per store.** The core is one zero-dependency ES2022 tree (`agent-src/`) with two runtime placements. Zotero standalone runs it in-process. When the server runs, it runs in a Node sidecar that `kb.py serve` supervises, and every UI, Zotero included, becomes a remote client. Obsidian never hosts the core. So at any moment exactly one process owns `chats/` and `reviews/` and holds the slot pool. The cross-host parallel cap and the single-writer rule then need no cross-process locking (per separate-before-serializing-shared-state). Zotero switches runtime only when nothing local is in flight, and on switching it adopts local conversations and finished reviews into the sidecar. `adopt` is idempotent by ULID.

**One provider interface.** `Provider.turn(req, signal) → AsyncIterable<ProviderEvent>`. Who runs the loop is private. Codex and Claude run theirs; the OpenAI-compatible adapter runs ours against the in-process tool face. The caller always passes the full history from our store. Each adapter keeps a small LRU of warm threads or processes keyed by `sessionKey` and sends only the new input when the cache matches. Our store is the source of truth and provider sessions are disposable caches, so restarts, provider switches and adoption never lose context. Wire parsers (`parseCodexMessage`, `parseClaudeLine`) are pure and map into the domain `AgentEvent` union: `text`, `activity`, `notice`, `done`, `failed`. No wire type crosses `providers.js` (per boundary-discipline). A `commandExecution` or `fileChange` item, or an approval request, ends the turn with `failed{policy_violation}`. That makes success criterion 6 a runtime guarantee, not just an audit.

**One tool gateway with three faces.** The gateway turns a registry of read-only rows into whatever each provider needs. OpenAI-compatible gets an in-process `call`. Codex gets `dynamicTools` (verified with ChatGPT sign-in, per-thread by construction, no port, no hint problem). Claude Code gets MCP over HTTP: a `Zotero.Server` endpoint on 23119 in Zotero, the sidecar's port behind the server. A per-session bearer token in `--mcp-config` headers maps each call to its `ToolContext`. User-added MCP servers are connected by the gateway's `McpHub` and re-exported as namespaced rows. The CLIs never see a user MCP config. Three problems collapse into one module. Isolation is total. The read-only policy is one verdict function: hint true is exposed, write or destructive is hidden, unmarked is hidden until the user trusts the server. And open-source models get user MCP tools for free. The `ToolContext` carries the review scope, so a researcher cannot widen it.

**Validation lives once, in `TurnRunner`.** It resolves the role's `ModelChoice` at call time, so a Settings change applies on the next message. It then takes a slot and opens a tool session. On `final` it validates JSON against the output schema (native where supported, one repair turn otherwise) and runs `validateCitations`. A web link counts as resolved only if a tool result in that turn returned it. Ask uses an output schema, so "not found" is a typed value.

**The review is a stage table over files** (`plan → approve → research → screen → synthesize → publish`). Resume starts at the first missing output, and every write is atomic. Research resumes per sub-question (`findings/<sq>.json`). Human approval is a stage that returns `WAIT`. Status is derived from the listing by `deriveStatus`. Screening and rendering are pure. `publish` goes through a `NoteSink`: the Python server's new `/ai-note` (collision-safe, under `WRITE_LOCK`, deduplicated by `reviewId` in front matter) or Zotero's local notes folder. Cancel aborts one controller per review. That becomes `turn/interrupt`, a process kill or a fetch abort, and writes `stopped.json`.

**Isolation.** Codex runs with `CODEX_HOME=<data>/codex-home`: our own `config.toml` plus `auth.json` symlinked from `~/.codex`, so an existing ChatGPT login works and `~/.codex` is never written. Claude runs with `--setting-sources "" --strict-mcp-config --no-session-persistence`, an explicit `--tools` list and an empty cwd. Both are pure `*Launch` functions under unit test.

**Interface depth.** UIs see one service of about 20 methods. Behind it sit three wire protocols, thread caching, tool serving on two kinds of HTTP server, MCP aggregation, schema repair, citation checks, slot scheduling, resumable stages and runtime switching. Hosts implement one `Platform` port (spawn, fs, fetch, serve) plus a `LibraryBackend` and a `NoteSink`. The Python server gains only supervision, byte forwarding and one writer. It holds no agent logic.

## Synthesis decision

## Tradeoffs accepted

- We accept Node as a dependency of server-side AI (Obsidian and the phone) in exchange for one core instead of a Python port. Without Node, `/agent/*` returns 503 with help and Zotero stays local.
- We accept that conversations adopted by the server are unavailable in Zotero while the server is down, in exchange for a single writer and no sync.
- We accept writing a small MCP client (stdio and HTTP) in the core, in exchange for user servers that work identically on all three providers and never touch the CLIs' config.
- We accept Codex `dynamicTools` being an experimental API, in exchange for per-thread tool context with no port. The MCP face is the verified fallback: swap one adapter.
- Warm Claude processes (at most 3, 10-minute idle) cost memory, in exchange for meeting the 4 s first-token target.
- Forwarding in Python looks like a pass-through. It keeps one exposed port and the existing bearer and Tailscale auth.

## Alternatives considered

- **Two interfaces (an agentic CLI one and a model-plus-our-loop one).** Every caller and the review runner would branch on provider kind. It exposes the loop owner, which is exactly what callers must not know. Rejected on depth.
- **Obsidian desktop hosts the core.** The phone still needs the server. That means two runtimes writing one store and two slot pools. It breaks single-writer and the cap.
- **Python port of orchestration.** Two cores to keep in lockstep: parsers, prompts, stage machine, validator. Every provider change is made twice.
- **User MCP servers passed straight to each CLI.** It hits Codex's `readOnlyHint` refusals and leaks config handling into three adapters. Open-source models would need a separate path anyway.
- **Zotero always runs its own core and writes to the server's store over HTTP.** Two runtimes means two Codex processes and a cap that needs a cross-process lease.

## Open questions and risks

- Does `thread/start.dynamicTools` stay stable across Codex releases, given that `experimentalApi` is required? If not, is per-thread `config.mcp_servers` honoured (unverified) so the MCP face can carry a per-thread token?
- Does a symlinked `auth.json` survive Codex token refresh, or does refresh replace the symlink with a file and split the logins? Spike before building.
- Does `claude -p` accept a native JSON schema flag in 2.1.x? The repair turn covers it either way.
- Should the Zotero standalone MCP endpoint also check that the caller is a child process we spawned, or is the per-session bearer token enough?
- Is losing offline access to adopted conversations acceptable, or should Zotero keep a read-only cache?

## Next implementation step

Build `providers.js` parsers and `codexLaunch`/`claudeLaunch` against recorded transcripts in `node:test`, with the fake app server, including the policy-violation and approval-decline cases.
