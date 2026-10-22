# Grounding for the Second Brain AI design (architect Phase A)

Date: 2026-09-25. Everything below was observed this session. Spike scripts are in the session scratchpad (`spike/`). They are reproduced in `tasks.md` task T0 so they can be rerun.

## Requirement change after the spec was approved

The user added: "not only codex but also claude code and open source as well." The AI must run on three kinds of provider.

- **Codex** (ChatGPT sign-in or API key).
- **Claude Code** (Claude subscription sign-in or API key).
- **Open-source models**: local servers with an OpenAI-compatible API (LM Studio, Ollama, llama.cpp, mlx_lm.server, vLLM), and optionally hosted open-model endpoints (OpenRouter and the like).

Installed on this Mac: Codex 0.155.0-alpha.16 inside ChatGPT.app (no `codex` on PATH), Claude Code 2.1.282 (`~/.local/bin/claude`), LM Studio CLI `lms`, opencode, gemini CLI, and Node 22.22.3 (`~/.local/bin/node`). No local model server was running.

## Spike results (all passed)

| Test | Result |
| --- | --- |
| Codex `app-server` with `experimentalApi: true` and `thread/start.dynamicTools` | The model called our host tool. `item/tool/call` arrived as a server request, and we replied `{contentItems:[{type:"inputText",text}], success:true}`. Final answer at 12.9 s. ChatGPT sign-in. |
| Codex `app-server` with `-c mcp_servers.stub.url=http://127.0.0.1:8765/mcp` (streamable HTTP, plain JSON responses, no SSE) | Codex ran initialize, tools/list and tools/call. Answer at 12.0 s. |
| Claude Code `claude -p --output-format stream-json --verbose --mcp-config mcp.json --strict-mcp-config --tools "" --allowedTools mcp__stub__search_library --setting-sources "" --no-session-persistence --model sonnet` | Init listed only `mcp__stub__search_library`. It called the tool and returned the exact text. 6.7 s wall, `apiKeySource: none` (subscription), and `total_cost_usd` is reported. |

Isolation finding: `codex app-server` has no `--ignore-user-config`, and the spike loaded the user's `~/.codex/config.toml` MCP servers. One of them kept failing in stderr (`rmcp::transport::worker ... 127.0.0.1:29979`). The engine must isolate, for example with a dedicated `CODEX_HOME` that holds only a copy or symlink of `auth.json`, or with `-c mcp_servers={}` plus explicit overrides. Which approach works is to be verified.

Conclusion: **MCP over streamable HTTP is a tool channel shared by both agent CLIs.** Codex also has in-process `dynamicTools`. Open-source chat endpoints have no agent loop, so our core must run the tool loop and call tools itself.

## Codex app-server protocol (v2, generated schema)

- Client requests used: `initialize` (`capabilities.experimentalApi`), `thread/start` (`cwd`, `ephemeral`, `sandbox`, `approvalPolicy`, `config`, `developerInstructions`, `baseInstructions`, `model`, `dynamicTools`), `turn/start` (`input`, `effort`, `model`, `outputSchema`), `turn/interrupt`, `model/list`, `account/read`, `account/login/start` (`apiKey` | `chatgpt` | `chatgptDeviceCode`), `account/logout`, `account/rateLimits/read`, `mcpServerStatus/list`, `config/mcpServer/reload`.
- Notifications used: `item/agentMessage/delta`, `item/started`, `item/completed` (types `agentMessage`, `reasoning`, `dynamicToolCall`, `mcpToolCall`, web search items, `commandExecution`, `fileChange`), `turn/completed`, `item/reasoning/summaryTextDelta`, `account/login/completed`, `account/rateLimits/updated`, `error`.
- Server requests to answer: `item/tool/call` (host tools), and `*requestApproval` (always decline).
- Web search mode: `disabled | cached | indexed | live`, with optional `allowed_domains`.

## Claude Code headless

- `claude -p` with `--output-format stream-json --verbose` streams `system/init` (tools, mcp servers, apiKeySource), `assistant` messages (text and tool_use blocks), `user` (tool_result) and `result` (duration, cost, session id). `--include-partial-messages` gives token deltas.
- Multi-turn: `--input-format stream-json` keeps one process per conversation, or `--resume <session_id>` per turn.
- Web search: allow the built-in `WebSearch` and `WebFetch` tools (`--tools "WebSearch,WebFetch"`). Isolation flags as in the spike. Model: `--model`. Reasoning: `--effort`.
- Sign-in: uses the existing Claude login. `claude setup-token` or `ANTHROPIC_API_KEY` are the alternatives.

## Existing system (from the code surveys, file:line in the survey reports)

- **Server** `~/obsidian-kb/http_api.py`: stdlib `ThreadingHTTPServer`, one thread per request, hand-dispatched routes. Auth: localhost is trusted, anything else needs a bearer token (`data/api-token`). `X-KB-Client: agent` limits a request to `AGENT_ROUTES` and applies `privacy.json` plus the audit log. A global `LOCK` guards search, so a stream must never hold it. There is no streaming today because every response sets `Content-Length`.
- **MCP** `server.py`: a stdio MCP server with 6 read-only tools (`search_notes`, `read_note`, `note_links`, `related_notes`, `recent_notes`, `index_status`). It is a thin HTTP client of `kb.py serve` that sends the agent header.
- **Obsidian plugin**: esbuild with TypeScript and `ItemView`s (Search, Related, Duplicates, Zotero, Status). `Api.call` goes through `requestUrl`, which cannot stream. Node `http` is available on desktop only. On the phone the plugin reaches the server over Tailscale with a bearer token.
- **Zotero plugin** (public repo): a plain-JS bootstrap plugin. Tabs come from `Zotero_Tabs.add` (the note-tab pattern). Chrome dialogs, a preferences pane, and `ObsidianStore`/`LocalStore` dual mode (works with no server). The built-in search model runs in `engine.html` web workers. `discover.js` has multi-source scholarly search (OpenAlex, S2, arXiv, Crossref, Europe PMC, bioRxiv/medRxiv, ChemRxiv), fanned out with `Promise.allSettled`. HTTP goes through `Zotero.HTTP.request`. Zotero also runs a local HTTP server on port 23119 (`Zotero.Server.Endpoints`), which a plugin can extend. Whether that can serve MCP JSON-RPC POSTs is **not yet verified**.
- **Safe note writes**: `paper_notes._create_locked` (WRITE_LOCK, dedupe, collision-safe name, baseline hash) and `_save_locked` (hash-based 409). Reports belong in `ai_notes/`, which search ranks lower.
- **LexImmigration Codex integration**: `codex exec --json` per call, isolation flags `--ignore-user-config -c skills.include_instructions=false --sandbox read-only --ephemeral --ignore-rules --skip-git-repo-check`, a temp cwd, binary lookup order (env, then bundled, then ChatGPT.app, then PATH), `codex debug models` for the live model list (64 MB buffer), and stderr cleanup (it echoes prompts and rmcp trace lines). There is no parallel orchestration.

## Constraints

- The Zotero plugin must work with no server and no Obsidian. It is public, and other users have only Zotero plus some provider.
- Obsidian mobile works through the server only.
- Agents are read and search only. The only writes are chat history and reports, done by our code.
- Parallel researcher threads are capped at 5 by default (the Mac swapped with 14 parallel agent processes on 2026-09-22).
- Zotero chrome JS is ES2022-plus. There is no Node in Zotero. Processes are spawned with `Subprocess.sys.mjs` (stdin/stdout pipes).
- New dependencies need the user's approval.

## MCP catalog research (summary; full notes in `research-mcp-catalog.md`)

Default catalog, all read-only and free: PubMed/Europe PMC (`cyanheads/pubmed-mcp-server`), ClinicalTrials.gov, PubChem, ChEMBL, arXiv full text (all cyanheads), `openags/paper-search-mcp` with its Google Scholar scraper disabled, Unpaywall, Wikipedia, and NASA ADS and INSPIRE-HEP (niche). Optional and paid-limited: Consensus (remote), Exa, Tavily. Rejected: Google Scholar scrapers (against the ToS), Scite and Elicit (no verified public MCP), Brave (redundant with web search), and dedicated S2/OpenAlex MCPs (redundant with the built-ins).

## Spike 2: Zotero's built-in HTTP server as the MCP endpoint (verified 2026-09-25)

Harness: a headless Zotero 10 with a scratch profile, scratch data dir and `extensions.zotero.httpServer.port=23191`. A 20-line bootstrap plugin registers `Zotero.Server.Endpoints["/second-brain/mcp"]` (`supportedMethods:["POST"]`, `supportedDataTypes:["application/json"]`), and `init(req)` returns `[status, "application/json", body]`.

- A plain curl JSON-RPC `tools/call` got the correct response.
- A request with a foreign `Origin` header had its connection dropped by Zotero, which is built-in protection against browser pages.
- **Claude Code** connected, listed and called the tool (2.9 s, haiku).
- **Codex** listed the tool, but **refused to call it** with "MCP tool call requires approval, but approval policy is never" when the tool had no `annotations.readOnlyHint: true`. With the annotation it called the tool and answered in 12 s.

Consequences:
1. Zotero standalone can serve our tools to both CLIs from Zotero's own server. No extra port or process is needed. Notifications must return 202 with an empty body.
2. **Every tool we expose must carry `annotations: { readOnlyHint: true }`.** Under `approvalPolicy: never`, Codex blocks MCP tools that aren't marked read-only. User-added MCP servers whose tools lack the hint will fail under Codex. The UI must surface that, or the engine must set a per-server approval override if Codex supports one (to verify).
3. The endpoint is reachable by any local process, like Zotero's connector endpoints. Decide whether a per-session token in the URL path is needed.

## P0 spikes (2026-09-25, all passed)

1. **Private `CODEX_HOME`.** A dir holding `auth.json` as a symlink to `~/.codex/auth.json`, plus our `config.toml` with `[features] apps = false, plugins = false, memories = false`. `account/read {refreshToken:true}` refreshed the token: `last_refresh` in `~/.codex/auth.json` went from 2026-09-22 to 2026-09-25, and **the symlink survived**, so writes go through to the real file and the user's own Codex stays signed in. With apps and plugins off, `mcpServerStatus/list` is empty and stderr is clean. With apps left on, a built-in `codex_apps` MCP server loads.
2. **Per-thread `thread/start.config.mcp_servers` is honoured.** Two threads in one app server, each with its own MCP URL (ports 8771 and 8772), each called only its own server. → **Uniform MCP face for Codex and Claude. The `dynamicTools` face is deleted from the design.**
3. **Claude structured output.** `claude -p --json-schema <schema>` exists in 2.1.282. Use it natively. The repair turn stays for the OpenAI-compatible provider only.
4. **Zotero.Server request.** `init(req)` gets `{method, pathname, pathParams, searchParams, headers, data}`, with header keys lowercased (`req.headers.authorization`). A path with a token suffix returns 404 (exact path match). → **Per-session token in the `Authorization: Bearer` header**, on the fixed path `/second-brain/mcp`.
