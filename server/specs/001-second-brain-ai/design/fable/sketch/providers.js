// The three providers. Wire formats stay inside this file; everything leaving it is an AgentEvent or TurnResult.
// In the real tree these are providers/codex.js, providers/claude.js, providers/openai.js; merged here for the sketch.
/** @typedef {import("./types").Provider} Provider */
/** @typedef {import("./types").Host} Host */
/** @typedef {import("./types").AgentEvent} AgentEvent */

// ---------------------------------------------------------------- Codex --
/** @implements {Provider} */
export class CodexProvider {
  id = /** @type {const} */ ("codex");
  capabilities = { nativeSchema: true, nativeWebSearch: true };
  /** @param {Host} host @param {() => string | undefined} binaryPref */
  constructor(host, binaryPref) { throw new Error("not implemented"); }

  /** One `codex app-server` process per runtime, started lazily; threads are cheap and share it. */
  async process() { throw new Error("not implemented"); }

  status() { throw new Error("not implemented"); }   // account/read + account/rateLimits/read; found/version from `codex --version`
  models() { throw new Error("not implemented"); }   // model/list
  signIn(how) { throw new Error("not implemented"); } // account/login/start {apiKey | chatgpt | chatgptDeviceCode}, wait for account/login/completed
  signOut() { throw new Error("not implemented"); }

  /** thread/start with the isolation config; returns a Session holding the threadId. */
  open(conversationId) { throw new Error("not implemented"); }

  /**
   * turn/start with input from request.history + request.message, outputSchema = request.schema.
   * Notifications → events (see parseCodexNotification). Server request item/tool/call is impossible here
   * (no dynamicTools); *requestApproval is answered with decline and emitted as policy.violation.
   * signal → turn/interrupt.
   */
  turn(session, request, tools, sink, signal) { throw new Error("not implemented"); }
}

/**
 * Thread start params that keep Codex isolated from ~/.codex/config.toml while reusing its auth.
 * Real CODEX_HOME; per-thread config replaces mcp_servers with only the aggregated endpoint.
 * @returns {{ ephemeral: true, sandbox: "read-only", approvalPolicy: "never", config: Record<string, unknown> }}
 */
export function codexThreadParams(mcpUrl, web) {
  // TODO config: { mcp_servers: { sb: { url: mcpUrl } }, web_search: web === "off" ? "disabled" : web, skills: { include_instructions: false } }
  // TODO verify (open question 1): if thread/start.config cannot replace mcp_servers, pass -c at process start instead
  throw new Error("not implemented");
}

/**
 * Pure. One JSON-RPC notification → zero or more domain events.
 * item/agentMessage/delta → text.delta; item/reasoning/summaryTextDelta → reasoning.delta
 * item/started {mcpToolCall} → tool.started (label from ToolSpec.label(args)); item/completed {mcpToolCall} → tool.finished
 * item/started {webSearch} → tool.started kind "web"
 * item/completed {commandExecution | fileChange} → policy.violation (the turn fails)
 * turn/completed → turn.done built by the caller; account/rateLimits/updated → status
 * @param {unknown} notification  raw parsed JSON
 * @param {import("./types").ToolSet} tools
 * @returns {AgentEvent[]}
 */
export function parseCodexNotification(notification, tools) { throw new Error("not implemented"); }

// --------------------------------------------------------------- Claude --
/** @implements {Provider} */
export class ClaudeProvider {
  id = /** @type {const} */ ("claude");
  capabilities = { nativeSchema: false, nativeWebSearch: true };
  constructor(host, binaryPref) { throw new Error("not implemented"); }

  status() { throw new Error("not implemented"); }   // `claude --version`; auth from a probe turn's system/init apiKeySource, cached
  models() { throw new Error("not implemented"); }   // TODO no list endpoint verified; return the aliases Claude accepts (sonnet, opus, haiku) plus a free-text field
  /** A long-lived `claude -p --input-format stream-json` process per open conversation. */
  open(conversationId) { throw new Error("not implemented"); }
  /** Writes one user message to stdin; parses assistant/user/result lines until result. signal → kill process, emit cancelled. */
  turn(session, request, tools, sink, signal) { throw new Error("not implemented"); }
}

/**
 * Pure. The exact argv the spike verified, plus web tools when web !== "off".
 * @returns {string[]}
 */
export function claudeArgs(model, mcpUrl, web) {
  // TODO ["-p","--output-format","stream-json","--input-format","stream-json","--verbose","--include-partial-messages",
  //       "--mcp-config",<json with sb → mcpUrl>,"--strict-mcp-config","--tools", web==="off" ? "" : "WebSearch,WebFetch",
  //       "--allowedTools","mcp__sb__*", "--setting-sources","", "--no-session-persistence","--model",model]
  throw new Error("not implemented");
}

/**
 * Pure. One stream-json line → events. assistant text/tool_use → text.delta / tool.started; user tool_result → tool.finished;
 * a tool_use whose name is Bash, Edit, Write, or any non-mcp__sb__/WebSearch/WebFetch → policy.violation; result → status (cost).
 * Stderr lines go through cleanStderr() before any surface.
 * @returns {AgentEvent[]}
 */
export function parseClaudeLine(line, tools) { throw new Error("not implemented"); }

// --------------------------------------------------------------- OpenAI --
/** @implements {Provider} */
export class OpenAIProvider {
  /** @param {{name:string, baseUrl:string, apiKey?:string, model:string}} endpoint */
  constructor(host, endpoint, settings) { throw new Error("not implemented"); }
  get id() { return /** @type {const} */ (`openai:${this.endpoint.name}`); }
  capabilities = { nativeSchema: true, nativeWebSearch: false }; // web_search is a registry tool backed by settings.webBackend, or absent

  status() { throw new Error("not implemented"); }   // GET /models reachable? found=true; auth kind api-key or none
  models() { throw new Error("not implemented"); }   // GET /models
  open(conversationId) { throw new Error("not implemented"); }
  /**
   * Our loop: messages = system + history + message; tools = tools.specs() as function tools.
   * Repeat: stream /chat/completions (SSE) → text.delta; tool_calls → tool.started, tools.call(), tool.finished, append tool message.
   * Stop on a message with no tool calls or after MAX_TOOL_ROUNDS. response_format json_schema when request.schema.
   */
  turn(session, request, tools, sink, signal) { throw new Error("not implemented"); }
}
export const MAX_TOOL_ROUNDS = 12;

/** Pure. Strips echoed prompts and rmcp trace lines before stderr reaches any UI. */
export function cleanStderr(text) { throw new Error("not implemented"); }
