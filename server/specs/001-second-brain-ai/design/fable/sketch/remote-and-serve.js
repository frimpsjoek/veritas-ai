// remote.js: the Runtime over HTTP. serve.js: the inverse, exposing a local Runtime. Both speak the same routes,
// so a UI cannot tell a local runtime from a remote one.
//
// Routes (all under /agent, proxied by the Python server in server mode so the phone's bearer token applies):
//   GET    /agent/conversations                      POST /agent/conversations            POST /agent/conversations/import
//   GET    /agent/conversations/:id                  PATCH/DELETE /agent/conversations/:id
//   POST   /agent/conversations/:id/send   SSE of AgentEvent (client aborts the request to cancel)
//   POST   /agent/ask                      SSE of AgentEvent
//   GET/POST /agent/reviews, GET /agent/reviews/:id, POST /agent/reviews/:id/{resume,approve,cancel,export}
//   GET    /agent/reviews/:id/events       SSE of ReviewEvent
//   GET    /agent/providers, GET /agent/providers/:id/models, POST /agent/providers/:id/{sign-in,sign-out}
//   POST   /agent/mcp/test
// Plus, on the sidecar only and never proxied: POST /mcp/<token>  the aggregated MCP endpoint for the CLIs.

/**
 * @param {string} baseUrl  the Python server (Obsidian) or Zotero's sb.server; never the sidecar directly
 * @param {string} [token]  bearer token when not localhost
 * @param {(url: string, init: object) => AsyncIterable<string>} sse  host-provided streaming fetch: Node http on Obsidian desktop, fetch on phone, Zotero.HTTP in Zotero
 * @returns {import("./types").Runtime}
 */
export function connectRuntime(baseUrl, token, sse) { throw new Error("not implemented"); }

/**
 * Sidecar entry. Node only. Binds 127.0.0.1:port; returns the MCP url containing this runtime's token.
 * @param {import("./types").Runtime} runtime
 */
export function serveRuntime(runtime, opts) { throw new Error("not implemented"); }

/** Pure. One AgentEvent or ReviewEvent → an SSE frame ("event: <type>\ndata: <json>\n\n"). */
export function frame(event) { throw new Error("not implemented"); }
/** Pure. Inverse of frame; parses at the boundary, throws on unknown event types. */
export function parseFrame(text) { throw new Error("not implemented"); }
