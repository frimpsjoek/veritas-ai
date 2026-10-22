# Module map

All agent code lives in `zotero-plugin/agent-src/` (public repo, zero npm dependencies, `node --test`). One source tree,
three bundles.

| Module | Owns | Used by |
| --- | --- | --- |
| `domain.d.ts` | Every type a UI or store sees: events, answers, citations, conversation records, review data. | everything |
| `service.d.ts` | `AgentService`, the only surface UIs call. `createLocalRuntime`, `createRemoteRuntime`. | Zotero tab, Obsidian view |
| `core.js` | `TurnRunner` (role to model, slot, tool session, schema and citation validation), slot pool, conversation store, event log, `createLocalRuntime`. | review.js, hosts |
| `providers.js` | `Provider` interface, the Codex, Claude Code and OpenAI-compatible adapters, isolation launch specs, wire parsers. | core.js |
| `tools.js` | Tool registry rows, `ToolGateway` (in-process, dynamicTools and MCP faces), `McpHub` for user servers, `handleMcp`, citation validator, scholarly sources (moved from `discover.js`). | core.js, providers.js |
| `review.js` | `REVIEW_STAGES`, `runReview`, `screen`, `renderReport`, `deriveStatus`. | core.js |
| `remote.js` | `createRemoteRuntime`: AgentService over HTTP, SSE or long-poll with `after`. | Obsidian, Zotero when the server runs |
| `platform.d.ts` | The host port: spawn, fs, fetch, serve. | core, providers, tools |
| `gecko/platform.js` | Platform on Subprocess.sys.mjs, IOUtils, Zotero.Server (`/second-brain/mcp`). | Zotero bundle |
| `node/platform.mjs`, `node/agentd.mjs` | Platform on Node; the sidecar: HTTP routes derived 1:1 from AgentService methods, secret check. | sidecar bundle |

Bundles: `content/agent.js` (Zotero: core + gecko + remote), `dist/agentd.mjs` (sidecar: core + node),
`obsidian-plugin` imports `remote.js` only.

Host glue (not in agent-src):

- `zotero-plugin/content/chat.js`: the Chat/Ask/Review tab. Calls `SecondBrain.ai()`, which returns the remote runtime
  when `/agent/ping` answers and the local one otherwise. It switches only when no local turn or review is in flight,
  and on switching to remote it adopts local conversations and finished reviews.
- `zotero-plugin/content/agent-host.js`: the Zotero `LibraryBackend` (reuses `searchAll`, the local index and Zotero full text) and the local `NoteSink`.
- `obsidian-plugin/src/chat.ts`: the `ItemView`. Transport is Node `http` SSE on desktop and `requestUrl` long-poll on the phone.
- `agent_api.py`: sidecar supervisor, `/agent/*` forwarding, `/ai-note` writer.

Flow of one Chat turn (sidecar case): `chat.ts` -> `remote.js` -> Python `forward` -> `agentd` route ->
`core.TurnRunner.stream` -> `Provider.turn` -> CLI -> tool call -> `ToolGateway` -> `LibraryBackend` -> Python `/search` (privacy applied).
Three files of ours on the agent side of the wire: core, providers, tools.
