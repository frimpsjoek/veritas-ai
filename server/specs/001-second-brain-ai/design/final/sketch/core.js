// @ts-check
// agent-src/core.js. The runtime: providers + gateway + stores + slot pool, composed behind AgentService.
/** @typedef {import("./domain").Role} Role */
/** @typedef {import("./domain").AgentEvent} AgentEvent */
/** @typedef {import("./tools").ToolContext} ToolContext */

/**
 * The single place a turn runs. Resolves the role's ModelChoice from settings at call time, acquires a slot,
 * opens a ToolSession, streams provider events through, then on `final`: validates JSON against the schema
 * (one repair turn on failure, else failed{bad_output}), validates citations, and emits `done`.
 * @typedef {object} TurnRunner
 * @property {(role: Role, req: { sessionKey: string, history: import("./providers").HistoryMessage[], input: string, tools: ToolContext },
 *             signal: AbortSignal) => AsyncIterable<AgentEvent>} stream
 * @property {<T>(role: Role, prompt: string, schema: object, tools: ToolContext & { agentId: string }, signal: AbortSignal) => Promise<T>} structured
 */

/**
 * One pool per runtime process. Since a machine runs one runtime at a time (sidecar when the server is up, Zotero
 * otherwise), this is the cross-host cap. Limits: researcher turns <= settings (default 3, hard max 5); all agent
 * turns <= 6. Acquire is FIFO and abortable, so a cancelled review releases its waiters.
 * @param {{ total: number, perRole: Partial<Record<Role, number>> }} limits
 * @returns {{ acquire(role: Role, signal: AbortSignal): Promise<() => void> }}
 */
export function createSlots(limits) { throw new Error("not implemented"); }

/**
 * Conversation files are JSONL, one per id, owned by exactly one writer: this runtime. `adopt` takes files from
 * a runtime that used to own them (Zotero standalone -> sidecar) and is idempotent by id.
 * @param {import("./platform").Platform["fs"]} fs @param {string} dir
 */
export function conversationStore(fs, dir) {
  return {
    /** @returns {Promise<import("./domain").ConversationSummary[]>} */ list: async () => { throw new Error("not implemented"); },
    /** @param {string} id */ load: async (id) => { throw new Error("not implemented"); },
    /** @param {string} id @param {import("./domain").ConversationRecord} rec */ append: async (id, rec) => { throw new Error("not implemented"); },
    /** @param {string} id */ remove: async (id) => { throw new Error("not implemented"); },
    /** @param {{ id: string, jsonl: string }[]} files @returns {Promise<string[]>} ids now owned here */ adopt: async (files) => { throw new Error("not implemented"); },
  };
}

/**
 * Per conversation, the live turn's events with sequence numbers, kept until the turn ends plus 5 minutes.
 * A reconnecting client passes `after`; a second `send` while a turn runs is refused, so one turn per conversation.
 */
export function eventLog() { throw new Error("not implemented"); }

/** Composition root. Wires providers, gateway, stores, slots and review runs into an AgentService. See service.d.ts. */
export async function createLocalRuntime(/** @type {any} */ deps) { throw new Error("not implemented"); }
