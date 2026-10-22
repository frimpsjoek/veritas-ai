# Module map (candidate: sonnet)

```
@second-brain/agent-core/            one JS package, three hosts import it unmodified
  events.d.ts                        AgentEvent union — the only type the UI and stage code see
  provider.d.ts                      AgentProvider / AgentThread interface
  providers/
    codex-provider.js                drives codex app-server, translates item/* -> AgentEvent
    claude-code-provider.js          drives `claude -p --output-format stream-json`
    openai-compat-provider.js        + tool-loop-runner.js (the loop CLIs bring themselves)
  tools.d.ts                         ToolSpec, ToolRegistry, McpToolServer, DynamicToolBridge
  tools/
    dynamic-tool-bridge.js           Codex item/tool/call -> ToolRegistry.call
    mcp-tool-server.js               streamable-HTTP JSON-RPC server over ToolRegistry
    server-transport.d.ts            transport seam: NodeHttpTransport | ZoteroServerTransport
  review.d.ts                        ReviewStage, ReviewRunner, ReviewSpec, ParallelCap
  review/
    stages.js                        plan/research/screen/synthesize, matches the spec's table
    parallel-cap.js
  store.d.ts                         ConversationStore, ReviewStore, adoptLocalConversations
  core.d.ts                          SecondBrainCore facade: EmbeddedCore, RemoteCore
  citations.js                       validator: every [[Note]] / [@key] checked against the library

zotero-plugin/agent-src/             builds into content/agent.js (existing build step, unchanged)
  zotero-tool-registry.js            fills ToolRegistry from local-index.js + discover.js
  zotero-server-transport.js         implements server-transport.d.ts on Zotero.Server.Endpoints
  local-conversation-store.js        implements store.d.ts, JSONL under <Zotero data dir>/second-brain/chats/
zotero-plugin/content/chat.js        UI only: calls SecondBrainCore.forHost({role:"zotero", ...})

obsidian-plugin/src/
  agent/core-host.ts                 EmbeddedCore wiring for desktop (Node http already available)
  agent/remote-client.ts             RemoteCore: SSE + REST client, used by mobile always, desktop when
                                      a server is reachable
  chat.ts                            UI only: calls SecondBrainCore.forHost({role:"obsidian", ...})

~/obsidian-kb/ (Python server)
  agent_api.py                       new: /agent/chat (SSE), /agent/review/* (SSE), sidecar supervisor,
                                      mounts McpToolServer's HTTP surface, server-side ToolRegistry via
                                      kb.py + privacy.json (reuses http_api.py's LOCK discipline: never
                                      held across a stream)
  agent-sidecar/                     the Node process agent_api.py spawns; hosts @second-brain/agent-core
                                      unmodified, owns the canonical ConversationStore + ReviewStore
  data/chats/<id>.jsonl               canonical store, sidecar is sole writer while server runs
  data/reviews/<id>/{plan,findings,screened,report}.*   stage outputs, resume marker = first missing file
```

Call-chain depth check (per laziness-protocol): Zotero UI -> `SecondBrainCore` -> `EmbeddedCore` ->
`AgentProvider`/`ToolRegistry` is three hops from click to model call, same for Obsidian desktop. Obsidian
mobile/server path: UI -> `SecondBrainCore` -> `RemoteCore` (SSE) -> sidecar's `EmbeddedCore` -> provider/registry —
four hops, the extra one being the unavoidable network boundary to a process that must outlive the UI.
