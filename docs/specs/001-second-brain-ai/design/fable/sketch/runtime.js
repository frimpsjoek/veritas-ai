// createRuntime: the local Runtime. Owns provider dispatch, the parallel Gate, citation validation and the store.
// Exactly one createRuntime per dataDir: the sidecar in server mode, Zotero in standalone mode.
/** @typedef {import("./types").Runtime} Runtime */
/** @typedef {import("./types").Host} Host */
/** @typedef {import("./types").Settings} Settings */
/** @typedef {import("./types").AgentEvent} AgentEvent */

/**
 * Counting semaphore for agent turns. One per runtime, so every review and chat in this process shares it.
 * Because only one runtime runs agents at a time (server mode delegates), this is the machine-wide cap.
 */
export class Gate {
  /** @param {number} max 1..5, from Settings.parallel.researchers */
  constructor(max) { throw new Error("not implemented"); }
  /** @returns {Promise<() => void>} release function; rejects with {code:"cancelled"} if signal fires while queued */
  acquire(signal) { throw new Error("not implemented"); }
}

/**
 * @param {Host} host
 * @param {() => Settings} settings  read on every turn, so a settings change applies to the next message (criterion 10)
 * @returns {Runtime}
 */
export function createRuntime(host, settings) {
  // TODO providers = { codex: new CodexProvider(host), claude: new ClaudeProvider(host), ...settings().endpoints.map(OpenAIProvider) }
  // TODO tools = new ToolRegistry(host, settings); mcpUrl published once via host.serveMcp(tools.handleMcp)
  // TODO store = new ConversationStore(host.files, host.dataDir), reviews = new ReviewStore(...)
  // TODO send(): gate.acquire → provider.turn(...) with sink that also appends to the store → validateCitations(result, tools)
  //      → citation.checked events → append assistant turn → turn.done. Any policy.violation aborts and records turn.failed.
  // TODO ask(): create conversation {mode:"ask"} with the Ask system prompt, one send, delete conversation unless it had citations worth keeping
  // TODO reviews.*: delegate to runReview(ctx) in review.js with ctx = { runtime internals, gate, store, host.writeReport }
  throw new Error("not implemented");
}

/**
 * Wraps a provider turn so a schema request always yields validated `structured` output.
 * Native schema providers pass it through; others get the schema appended to the system prompt.
 * On validation failure, retries once with the validator's message as the next user message.
 * @param {import("./types").Provider} provider
 * @param {import("./types").TurnRequest} request  with request.schema set
 * @returns {Promise<import("./types").TurnResult>}
 */
export function structuredTurn(provider, session, request, tools, sink, signal) { throw new Error("not implemented"); }
