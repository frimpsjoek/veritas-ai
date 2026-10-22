# Second Brain AI, candidate design (fable)

## Problem

Three modes (Chat, Ask, Literature review) must run on three provider kinds. Codex app-server and Claude Code run their own tool loop and speak different wire formats. OpenAI-compatible endpoints run no loop, so we must. The core must run inside Zotero with no Node and no server, and it must also serve Obsidian on desktop and phone through the Python server. Agents are read-only; the only writes are chat history and reports, by our code. Constraints from Phase A: `http_api.py` holds a global `LOCK` around search that no stream may hold; `paper_notes.py` owns `WRITE_LOCK` and the collision-safe note writer; the Zotero plugin already has an `ObsidianStore`/`LocalStore` dual mode; Spike 2 verified `Zotero.Server.Endpoints` as a streamable-HTTP MCP endpoint and showed Codex refuses any MCP tool without `annotations.readOnlyHint: true` under `approvalPolicy: never`.

## Usage (caller's view)

Every UI codes against one object, `Runtime`, and consumes one event union, `AgentEvent`. A host gets a `Runtime` in one of two ways: `createRuntime(host, settings)` runs the agents in this process, `connectRuntime(url, token)` talks to a runtime elsewhere over SSE. The two are interchangeable to the UI.

Zotero chat tab, standalone or with the server (`content/chat.js`):

```js
const runtime = SecondBrain.runtimeFor(sb);      // server up → connectRuntime(sb.server); else createRuntime(new ZoteroHost(sb))
const conv = await runtime.conversations.create({ mode: "chat", provider: prefs.chatProvider });
for await (const ev of runtime.send(conv.id, { text, attachments: [{ kind: "zotero-item", key: item.key }] }, signal)) {
  view.apply(ev);                                // text.delta, tool.started, citation.checked, turn.done ...
}
```

Obsidian view, desktop and phone (`src/chat.ts`), always the remote runtime:

```ts
const runtime = connectRuntime(api.base(), settings.token);
const answer = await runtime.ask({ text: selection, attachments: [{ kind: "note", path: file.path }] }, signal);
// answer.text has validated citations; answer.citations lists each with resolved:true|false
```

Review runner, any host:

```js
const review = await runtime.reviews.start({ question, scope: { kind: "collection", key }, sources: ["library", "scholarly", "web"], years: [2018, null], depth: "standard", roles: { lead: "claude", researcher: "codex", writer: "claude" } });
for await (const ev of runtime.reviews.watch(review.id)) progress.apply(ev);   // stage.changed, agent.status, paper.found, review.done
await runtime.reviews.cancel(review.id);         // stops every thread; state on disk stays resumable
// after an app restart:
await runtime.reviews.resume(review.id);         // continues at the first stage whose output file is missing
```

Sidecar (server mode) is the local runtime exposed over HTTP:

```js
const runtime = createRuntime(new NodeHost({ kbUrl: "http://127.0.0.1:27182", dataDir }), settings);
serveRuntime(runtime, { port: 27183 });          // /agent/* SSE routes, /mcp/<token> tool endpoint
```

## Shape

**One provider interface.** `Provider.turn(session, request, tools, sink, signal)` streams `AgentEvent`s and resolves a `TurnResult`. The three implementations differ in who runs the loop, not in the contract. `CodexProvider` and `ClaudeProvider` translate their wire notifications into events and hand tools over as an MCP URL. `OpenAIProvider` runs the loop itself: stream a chat completion, execute tool calls through `ToolSet.call`, append, repeat. Wire types never leave `providers/*.js`, per boundary-discipline. The `ThreadItem` variants (`agentMessage`, `mcpToolCall`, `webSearch`, `commandExecution`, `fileChange`, `reasoning`) and the Claude `assistant`/`user`/`result` messages both parse into the same `AgentEvent` union in `types.d.ts`. A `commandExecution` or `fileChange` item becomes `event.policy.violation`, which fails the turn; it is the runtime check behind success criterion 6.

**One tool channel, aggregated.** The core owns `ToolRegistry`: built-in tools (`search_library`, `read_source`, `search_scholarly`, `web_search`, plus Zotero-only `current_item`) and user-added MCP servers, which the core connects to as an MCP client (stdio through `host.spawn`, HTTP through `host.fetch`). It exposes everything through one streamable-HTTP MCP endpoint per host and stamps `annotations.readOnlyHint: true` on each tool it publishes. A user tool that lacks the hint and is not on our vetted read-only list is dropped and reported in the connection test. This is the F5 read-only policy and the Codex refusal solved by one structure, per model-the-domain. Claude Code and Codex each get exactly one MCP server (ours) plus their native web search. Codex `dynamicTools` is not used, so the two CLIs are configured identically. Where the endpoint is served is the host's decision: `Zotero.Server.Endpoints["/second-brain/mcp/<token>"]` on 23119 (verified), Node `http` in the sidecar, never the Python server. The per-runtime token in the path closes the any-local-process hole Spike 2 noted. Open-source providers skip the endpoint and call `ToolSet.call` in-process.

**Core in JS, three thin hosts, one runtime at a time.** `agent-src/` is dependency-free ESM using only a `Host` object (`spawn`, `fetch`, `files`, `serveMcp`, `tools`). Hosts are `ZoteroHost` (`Subprocess.sys.mjs`, `IOUtils`, `Zotero.HTTP`, local index), `NodeHost` (sidecar started by `kb.py serve`), and nothing for Obsidian, which is always a `connectRuntime` client. When the server runs, its sidecar is the only agent runtime and the only writer of `data/chats` and `data/reviews`; Zotero and Obsidian both connect to it. When the server is down, Zotero runs `createRuntime` over its own data dir. Exactly one runtime writes any given store, so no lock is needed, per separate-before-serializing-shared-state. On reconnect, Zotero imports its local conversations through `POST /agent/conversations/import`, which is idempotent by conversation id. The Python server keeps what it is good at: search under `LOCK`, privacy and audit under `X-KB-Client: agent`, the `WRITE_LOCK` note writer (new `POST /ai-note` route), and a streaming proxy for `/agent/*` so the phone reaches the sidecar with the existing token. No Python port of the orchestration exists.

**Review as a stage table with per-actor files.** `REVIEW_STAGES` is data: `plan → research → screen → synthesize`, each with an `output` path and a `run(ctx)` function. `research` writes `findings/<subquestion-id>.json` per researcher, so resume is per sub-question and no two agents share a file. Resume is "first stage whose output is missing", which makes `start` and `resume` the same operation, per make-operations-idempotent. Cancellation is one `AbortSignal` per review that every provider `turn` observes; `review.json.status` is derived from the files plus the signal, never stored separately. The parallel cap is a `Gate` on the `Runtime`, shared by every review and chat in the process; because only one runtime runs agents at a time, the process cap is the machine cap. Structured outputs: `TurnRequest.schema` is a JSON Schema; providers with native support (Codex `outputSchema`, OpenAI `response_format`) pass it through, Claude gets it in the prompt, and the core validates and retries once with the validation error, so callers always receive typed `PlanOutput` or `FindingsOutput`.

**Conversation store is the transcript of record.** JSONL per conversation, appended by the runtime only. Providers are stateless across process restarts: a `Session` may hold a live Codex thread id or a Claude stdin pipe, but a conversation reopened after restart is rebuilt from the store into the first turn. This keeps `ephemeral: true` for Codex and `--no-session-persistence` for Claude, so nothing lands in `~/.codex` or `~/.claude`.

**Isolation.** Codex runs with the real `CODEX_HOME` (so ChatGPT login and token refresh keep working) and per-thread `config` overrides: `mcp_servers` replaced with only ours, `sandbox: read-only`, `approvalPolicy: never`, `web_search` per conversation. Claude runs with the flags the spike verified (`--setting-sources "" --strict-mcp-config --tools "" --no-session-persistence`, `--allowedTools mcp__sb__*` plus `WebSearch,WebFetch` when web is on). Approval requests are answered with a decline by the provider and surfaced as `policy.violation`.

**Interface depth.** The UI learns two things, `Runtime` and `AgentEvent`. The runtime hides provider dispatch, the tool loop for open models, MCP aggregation, citation validation, the store, the stage machine and the cap. A provider author learns `Provider`, `Host` and `ToolSet`. Nothing about JSON-RPC ids, SSE framing, stream-json or Subprocess pipes is visible outside the file that owns it.

## Synthesis decision

## Tradeoffs accepted

- We accept a Node dependency for the server side (sidecar) in exchange for one core with zero Python duplication. Node is personal-machine only; the public Zotero plugin never needs it.
- We accept that Obsidian desktop cannot chat while the server is down, in exchange for a single writer of the shared store and one code path for desktop and phone.
- We accept dropping Codex `dynamicTools` (verified, in-process) in exchange for the two CLIs sharing one tool configuration and user MCP servers working under Codex at all.
- We accept that a rebuilt-from-transcript first turn costs tokens after a restart, in exchange for provider sessions that never depend on `~/.codex` or `~/.claude` session files.
- We accept a Python-to-sidecar HTTP hop for phone traffic, in exchange for one auth surface and one port for clients.

## Alternatives considered

- **Python port of the core.** Rejected. Two orchestrators drift; the review stage machine and citation validator would be tested twice. The Node sidecar keeps one implementation and Python's public surface stays a proxy plus a note writer.
- **Obsidian desktop plugin hosts the core.** Rejected. It makes the desktop plugin a second writer of `data/chats` whenever the server is also up, and the phone still needs a server-side runtime, so it does not remove the sidecar. It only adds a third host.
- **Codex `dynamicTools` plus per-CLI MCP config for user servers.** Rejected. Two channels for Codex, and user servers lacking `readOnlyHint` fail under Codex with no place for us to intervene. Aggregation gives one channel and one policy point.
- **Two provider interfaces (agentic CLI vs raw model).** Rejected. The difference is internal to the provider. Exposing it would make the review runner branch on provider kind, the temporal-decomposition smell.

## Implementation reconciliation

## Open questions and risks

1. Does Codex accept `mcp_servers` replacement via `thread/start.config` (per-thread), or only via `-c` at process start? If process-only, one app-server per runtime with `-c mcp_servers.sb.url=...` is still fine; it fixes the endpoint URL per runtime, which we have.
2. Does `claude -p --input-format stream-json` keep tool results across turns without `--resume`? If not, per-turn `claude -p` with the transcript prefix is the fallback; the interface does not change.
3. Should the aggregated endpoint hide user tools without `readOnlyHint` (current design) or pass them with a warning and let Codex fail? Hiding is safer and matches "read-only by policy".
4. For open models, does `response_format: json_schema` exist on the user's servers (LM Studio yes, Ollama partial)? The retry-with-error path covers the gap.
5. Node path discovery for the sidecar: settings field plus `~/.local/bin/node` plus PATH. Is a missing Node an error or a silent "AI off on the server"?

## Next implementation step

Write `agent-src/types.d.ts` and `agent-src/providers/codex.js` against the fake app-server transcript, so the first `node --test` proves a Codex turn parses into `AgentEvent`s and an `mcpToolCall` round-trips through the aggregated endpoint.
