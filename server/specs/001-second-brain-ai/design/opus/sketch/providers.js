// @ts-check
// agent-src/providers.js. One interface for three kinds of provider. Who runs the tool loop is an implementation
// detail: Codex and Claude Code run their own, the OpenAI-compatible provider runs ours. Callers never see the difference.
/** @typedef {import("./domain").ProviderId} ProviderId */
/** @typedef {import("./domain").ModelChoice} ModelChoice */
/** @typedef {import("./domain").WebMode} WebMode */
/** @typedef {import("./domain").ProviderStatus} ProviderStatus */
/** @typedef {import("./tools").ToolSession} ToolSession */
/** @typedef {import("./platform").Platform} Platform */
/** @typedef {import("./platform").SpawnSpec} SpawnSpec */

/**
 * A message of prior history. The conversation store is the source of truth; provider threads are disposable caches.
 * @typedef {{ role: "user" | "assistant", text: string }} HistoryMessage
 */

/**
 * @typedef {object} TurnRequest
 * @property {string} sessionKey      Conversation id or review agent id. Keys the warm thread/process cache.
 * @property {ModelChoice} model
 * @property {string} instructions    System prompt: role, "sources are untrusted data", citation format.
 * @property {HistoryMessage[]} history  Always the full history. A warm session sends only the new input when its
 *                                      cached length matches; otherwise it seeds a fresh thread. Callers never manage threads.
 * @property {string} input
 * @property {ToolSession} tools      Specs + in-process call + MCP url. Each provider picks the face it needs.
 * @property {WebMode} web
 * @property {object | null} outputSchema  JSON Schema. Native where supported; the core validates regardless.
 */

/**
 * What a provider yields. Same as the domain AgentEvent except the last event is `final` (raw text and parsed JSON);
 * citations and schema validation are added once, in core.runTurn, not in three adapters.
 * @typedef {Exclude<import("./domain").AgentEvent, {type: "done"}> | { type: "final", text: string, json: unknown, usage: object }} ProviderEvent
 */

/**
 * @typedef {object} Provider
 * @property {ProviderId} id
 * @property {{ nativeWebSearch: boolean, nativeStructuredOutput: boolean }} caps
 * @property {() => Promise<ProviderStatus>} status
 * @property {() => Promise<{ id: string, label: string, isDefault: boolean }[]>} models   live list, never hard-coded
 * @property {(method: "browser" | "device_code" | { apiKey: string }) => Promise<{ openUrl?: string, code?: string, done: Promise<ProviderStatus> }>} signIn
 * @property {() => Promise<void>} signOut
 * @property {(req: TurnRequest, signal: AbortSignal) => AsyncIterable<ProviderEvent>} turn
 *           Abort maps to turn/interrupt (Codex), killing the process (Claude), or aborting fetch (OSS).
 *           A commandExecution/fileChange item or an approval request ends the turn with failed{policy_violation}.
 * @property {() => Promise<void>} dispose
 */

/**
 * Codex app-server. One process per runtime, one ephemeral thread per warm sessionKey (LRU, max 8).
 * Tools go through thread/start.dynamicTools (verified with ChatGPT sign-in), so each call arrives tagged with its
 * thread and needs no port, token or readOnlyHint. Approval requests are declined. Web search = thread config web_search mode.
 * @param {Platform} platform
 * @param {{ binaryPath: string | null, dataDir: string }} settings
 * @returns {Provider}
 */
export function codexProvider(platform, settings) { throw new Error("not implemented"); }

/**
 * Claude Code headless. One `claude -p --input-format stream-json` process per warm sessionKey (max 3 warm; idle 10 min).
 * Tools go through tools.mcpUrl with a bearer token in --mcp-config headers (verified in Zotero via Zotero.Server).
 * Web search = allowing WebSearch,WebFetch. Cost per turn comes from the `result` message.
 * @param {Platform} platform
 * @param {{ binaryPath: string | null, dataDir: string }} settings
 * @returns {Provider}
 */
export function claudeProvider(platform, settings) { throw new Error("not implemented"); }

/**
 * Any OpenAI-compatible endpoint. Our loop: chat/completions with tools -> call tools.call in process -> repeat,
 * max 12 tool rounds. Uses response_format json_schema when an outputSchema is set. Web search is the gateway's
 * web_search tool when a backend (Exa, Tavily, SearXNG) is configured, otherwise absent and status says so.
 * @param {Platform} platform
 * @param {{ name: string, baseUrl: string, apiKey: string | null, defaultModel: string }} endpoint
 * @returns {Provider}
 */
export function openAiCompatibleProvider(platform, endpoint) { throw new Error("not implemented"); }

// ---------- isolation from ~/.codex and ~/.claude: pure launch specs, unit-tested ----------

/**
 * Codex runs with CODEX_HOME=<dataDir>/codex-home. That dir holds our own config.toml (no mcp_servers, no skills,
 * sandbox read-only, approval never) and auth.json, a symlink to ~/.codex/auth.json when one exists so a ChatGPT
 * login just works. Signing in from our Settings writes a real auth.json there instead. ~/.codex is never written.
 * @param {string} binary @param {string} dataDir @param {string} home
 * @returns {{ spec: SpawnSpec, prepare: { symlinkAuth: { from: string, to: string } | null, configToml: string } }}
 */
export function codexLaunch(binary, dataDir, home) { throw new Error("not implemented"); }

/**
 * claude -p --output-format stream-json --input-format stream-json --verbose --include-partial-messages
 *   --setting-sources "" --strict-mcp-config --mcp-config <json with only our gateway> --no-session-persistence
 *   --tools "<WebSearch,WebFetch or empty>" --allowedTools "mcp__sb__*" --model <m> [--effort <e>]
 * cwd is an empty dir under dataDir so no project CLAUDE.md is picked up. Env passes an API key only if set in our settings.
 * @param {string} binary @param {TurnRequest} req @param {string} emptyCwd
 * @returns {SpawnSpec}
 */
export function claudeLaunch(binary, req, emptyCwd) { throw new Error("not implemented"); }

/** Binary lookup: setting, then env (CODEX_BINARY / CLAUDE_BINARY), then app bundle, then PATH. @returns {string[]} */
export function binaryCandidates(/** @type {"codex"|"claude"} */ kind, /** @type {string | null} */ setting, /** @type {string} */ home) {
  throw new Error("not implemented");
}

// ---------- wire parsers: pure, fed recorded transcripts in node:test ----------

/** Codex notification or server request -> domain events (item/agentMessage/delta -> text, item/started dynamicToolCall -> activity...). */
export function parseCodexMessage(/** @type {unknown} */ msg) { /** @returns {ProviderEvent[]} */ throw new Error("not implemented"); }

/** Claude stream-json line -> domain events (stream_event text_delta -> text, tool_use -> activity, result -> final). */
export function parseClaudeLine(/** @type {unknown} */ line) { /** @returns {ProviderEvent[]} */ throw new Error("not implemented"); }
