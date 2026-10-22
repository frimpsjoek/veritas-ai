// agent-src/tools.js. The tool gateway: one registry per runtime that serves every provider three ways.
//   in-process call   -> OpenAI-compatible loop
//   dynamicTools spec -> Codex
//   MCP over HTTP     -> Claude Code (Zotero.Server endpoint on 23119 in Zotero; the sidecar's port behind the server)
// User-added MCP servers are connected by the gateway, not by the CLIs. Neither CLI ever sees a user MCP config,
// which is what keeps ~/.codex and ~/.claude out and makes the read-only policy one rule in one place.
import type { Citekey, NotePath, Scope, WebMode, ActivityKind, CitationRef, Citation } from "./domain";
import type { Platform } from "./platform";

/** Supplied by the host. The sidecar's backend calls the Python agent routes with X-KB-Client: agent, so privacy.json and the audit log apply unchanged. */
export interface LibraryBackend {
  search(q: { text: string; scope: Scope; years?: { from: number | null; to: number | null }; limit: number; source?: "personal" | "zotero" }):
    Promise<{ ref: CitationRef; title: string; snippet: string; year: number | null }[]>;
  read(ref: CitationRef, opts: { heading?: string; maxChars: number }): Promise<{ title: string; text: string } | null>;
  resolve(refs: CitationRef[]): Promise<Map<string, { title: string } | null>>; // for the citation validator
}

export interface ToolContext {
  scope: Scope;                      // a review scoped to a collection passes it here; the model cannot widen it
  web: WebMode;
  sources: { library: boolean; scholarly: boolean; web: boolean };
  audit: string;                     // "chat:<id>" | "review:<id>/researcher:<sq>"
}

/** One row per tool. Everything the gateway exposes is read-only by construction; there is no field to say otherwise. */
export interface ToolRow {
  name: string;                      // search_library, read_source, search_scholarly, web_search, or "<server>__<tool>" for MCP
  description: string;
  inputSchema: object;
  activity: { kind: ActivityKind; label(args: any): string };  // "Searching your papers for 'X'"
  enabled(ctx: ToolContext): boolean;
  run(args: any, ctx: ToolContext, signal: AbortSignal): Promise<ToolOutput>;
}

/** Tool text is wrapped as untrusted data before any model sees it; `seen` feeds the citation validator (web links are resolved only if seen). */
export interface ToolOutput { text: string; seen: CitationRef[] }

/** A per-turn (or per-review-agent) view of the registry. Closing it revokes the MCP token. */
export interface ToolSession {
  specs: { name: string; description: string; inputSchema: object }[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<{ ok: boolean; text: string }>;
  mcp: { url: string; token: string };        // Authorization: Bearer <token>; unknown token -> 401
  seen(): CitationRef[];                      // everything tool results returned in this session
  close(): void;
}

export interface ToolGateway {
  open(ctx: ToolContext): ToolSession;
  mcpServers: McpHub;
  dispose(): Promise<void>;
}

export declare function createToolGateway(platform: Platform, library: LibraryBackend, settings: {
  scholarly: string[];                        // discover.js sources: openalex, s2, arxiv, crossref, europepmc, biorxiv, chemrxiv
  webBackend: { kind: "exa" | "tavily" | "searxng"; url: string; key: string | null } | null;
}): Promise<ToolGateway>;

/** Pure JSON-RPC handler for the MCP HTTP face (initialize, tools/list with readOnlyHint:true on every tool, tools/call; notifications -> 202). */
export declare function handleMcp(body: string, session: ToolSession | null): Promise<{ status: number; body: string }>;

// ---------- user-added MCP servers ----------

export type McpServerConfig =
  | { name: string; enabled: boolean; transport: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { name: string; enabled: boolean; transport: "http"; url: string; headers: Record<string, string> };

/** Tool policy is decided here once. readOnlyHint true -> exposed. readOnlyHint false or destructiveHint true -> hidden.
 *  No hint -> hidden until the user marks the server "read-only, I trust it" (the UI's warning). */
export type McpToolVerdict = "exposed" | "hidden_writes" | "hidden_unmarked";

export interface McpServerReport {
  config: McpServerConfig;
  state: "connected" | "failed" | "disabled";
  error: string | null;
  tools: { name: string; description: string; verdict: McpToolVerdict }[];
}

export interface McpHub {
  reports(): Promise<McpServerReport[]>;
  save(config: McpServerConfig & { trustUnmarked?: boolean }): Promise<McpServerReport>;
  remove(name: string): Promise<void>;
  rows(): ToolRow[];                          // exposed tools only, namespaced "<server>__<tool>"
}

/** Citation validator: extract [[Note]], [@key], and links from answer text, then resolve against the library and this turn's seen refs. */
export declare function validateCitations(text: string, library: LibraryBackend, seen: CitationRef[]): Promise<Citation[]>;
