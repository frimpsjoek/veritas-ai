// ToolRegistry: the only MCP server the agentic CLIs ever see. Built-ins plus user-added servers, aggregated,
// every published tool stamped annotations.readOnlyHint: true. Open-source providers call it in-process.
/** @typedef {import("./types").ToolSet} ToolSet */
/** @typedef {import("./types").ToolSpec} ToolSpec */
/** @typedef {import("./types").McpServerConfig} McpServerConfig */

/** Built-in rows. Handlers come from Host.tools; specs are fixed here so prompts and labels are one source of truth. */
export const BUILTIN_TOOLS = /** @type {Record<string, Omit<ToolSpec, "name">>} */ ({
  search_library:   { description: "...", inputSchema: {}, kind: "library",   label: (a) => `Searching your papers and notes for '${a.query}'` },
  read_source:      { description: "...", inputSchema: {}, kind: "library",   label: (a) => `Reading ${a.ref}` },
  search_scholarly: { description: "...", inputSchema: {}, kind: "scholarly", label: (a) => `Searching the literature for '${a.query}'` },
  current_item:     { description: "...", inputSchema: {}, kind: "library",   label: () => "Looking at the selected item" },
  web_search:       { description: "...", inputSchema: {}, kind: "web",       label: (a) => `Searching the web for '${a.query}'` }, // present only when settings.webBackend is set and the provider has no native web search
});

/** Names of user MCP tools known to be read-only even when their server omits readOnlyHint (the curated catalog fills this). */
export const VETTED_READ_ONLY = new Set(["search_papers", "fetch_article", "get_article_metadata"]);

/** @implements {ToolSet} */
export class ToolRegistry {
  /** @param {import("./types").Host} host @param {() => import("./types").Settings} settings */
  constructor(host, settings) { throw new Error("not implemented"); }

  /** Built-ins + tools from enabled user servers, connected lazily; user tools are namespaced `<server>__<tool>`. */
  specs() { throw new Error("not implemented"); }
  /** Routes to Host.tools or to the owning MCP client. Applies no policy itself: exposure was decided in specs(). */
  call(name, args, signal) { throw new Error("not implemented"); }
  mcpUrl() { throw new Error("not implemented"); }

  /**
   * Pure over registry state. The streamable-HTTP MCP handler the host publishes: initialize, tools/list, tools/call;
   * notifications → 202 empty body. tools/list stamps annotations.readOnlyHint on every entry.
   * @param {string} body  raw JSON-RPC request body
   * @returns {Promise<{status:number, body:string}>}
   */
  handleMcp(body) { throw new Error("not implemented"); }

  /** Connection test for Settings: lists the server's tools and says which will be exposed and why not. */
  test(server) { throw new Error("not implemented"); }
}

/**
 * Pure. Decides exposure for one user tool: exposed iff annotations.readOnlyHint === true or name ∈ VETTED_READ_ONLY.
 * @returns {{ exposed: boolean, reason?: "no-read-only-hint" }}
 */
export function exposure(tool) { throw new Error("not implemented"); }

/** Minimal MCP client used for user servers. stdio via host.spawn, http via host.fetch. */
export class McpClient {
  /** @param {McpServerConfig} config */
  constructor(host, config) { throw new Error("not implemented"); }
  listTools() { throw new Error("not implemented"); }
  callTool(name, args, signal) { throw new Error("not implemented"); }
  close() { throw new Error("not implemented"); }
}
