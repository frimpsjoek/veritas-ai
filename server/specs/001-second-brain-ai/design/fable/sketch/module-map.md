# Module map

```
zotero-plugin/agent-src/            shared core, dependency-free ESM, no Node or Zotero globals
  types.d.ts                        every domain type: AgentEvent, Runtime, Provider, Host, ToolSet, Review
  runtime.js                        createRuntime(host, settings): dispatch, Gate (cap), citation validation, store writes
  remote.js                         connectRuntime(url, token): the same Runtime over SSE (used by Obsidian and by Zotero in server mode)
  providers/codex.js                app-server JSON-RPC over host.spawn; ThreadItem → AgentEvent
  providers/claude.js               claude -p stream-json over host.spawn; messages → AgentEvent
  providers/openai.js               chat-completions streaming + our tool loop; ToolSet.call in-process
  tools.js                          ToolRegistry: built-ins + user MCP servers, readOnlyHint stamping, MCP request handler (pure)
  review.js                         REVIEW_STAGES table, runReview (start = resume), per-subquestion findings files
  store.js                          ConversationStore + ReviewStore over host.files; single writer per data dir
  citations.js                      pure: extract [[Note]] / [@key] / URLs, validate through ToolSet, mark unresolved
  prompts.js                        pure: system prompts per mode and role, structured-output schemas
  serve.js                          serveRuntime(runtime, {port}): /agent/* SSE + /mcp/<token>; Node only (sidecar entry)
  test/fake-app-server.mjs          replays recorded JSON-RPC transcripts (node:test)

zotero-plugin/content/
  agent.js                          built bundle of agent-src (esbuild, iife on SecondBrain.Agent)
  zotero-host.js                    ZoteroHost: Subprocess.sys.mjs, IOUtils, Zotero.HTTP, Zotero.Server.Endpoints, local index handlers
  chat.js                           Chat/Ask/Review tab; SecondBrain.runtimeFor(sb) picks remote or local

obsidian-plugin/src/
  chat.ts                           ItemView over connectRuntime; desktop uses Node http for SSE, phone uses fetch over Tailscale

~/obsidian-kb/
  agent_api.py                      sidecar supervisor, /agent/* streaming proxy (no LOCK), /ai-note collision-safe writer
  data/chats/<id>.jsonl             sidecar-owned in server mode; <Zotero data dir>/second-brain/chats in standalone
  data/reviews/<id>/                review.json, plan.json, findings/<sq>.json, screened.json, report.md
```

Data flow for one chat turn (three files): `chat.js` → `runtime.js` → `providers/*.js`, with `tools.js` answering tool calls from the CLI through the host's MCP endpoint. Review adds `review.js` between the UI and `runtime.send`.
