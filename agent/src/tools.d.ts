// agent-src/tools.js. The tool gateway: one registry per runtime that serves every provider two ways.
//   in-process call -> OpenAI-compatible loop
//   MCP over HTTP    -> Codex and Claude Code alike (Zotero.Server endpoint on 23119 in Zotero; the sidecar's
//                        port behind the server). P0 showed per-thread config.mcp_servers is honoured by Codex,
//                        so one MCP face now serves both CLIs; there is no dynamicTools face.
// User-added MCP servers are connected by the gateway, not by the CLIs. Neither CLI ever sees a user MCP config,
// which is what keeps ~/.codex and ~/.claude out and makes the read-only policy one rule in one place.
import type { Citekey, NotePath, Scope, WebMode, ActivityKind, CitationRef, Citation, Sources, SessionId, ResultRef, ResultSummary, RowId, Result } from "./domain";
import type { Platform } from "./platform";

/** Supplied by the host. The sidecar's backend calls the Python agent routes with X-KB-Client: agent, so privacy.json and the audit log apply unchanged. */
export interface LibraryBackend {
  /** `only` narrows to just the Zotero library ("papers") or just the vault ("notes"); omitted searches both. */
  search(q: { text: string; scope: Scope; years?: { from: number | null; to: number | null }; limit: number; only?: "papers" | "notes" }):
    Promise<{ ref: CitationRef; title: string; snippet: string; year: number | null }[]>;
  read(ref: CitationRef, opts: { heading?: string; maxChars: number }): Promise<{ title: string; text: string } | null>;
  resolve(refs: CitationRef[]): Promise<Map<string, { title: string } | null>>; // for the citation validator
  /** Added in T1.3: the related_sources tool and T1.5's LibraryBackend (which calls KB's /related) both need it;
   *  the sketch named the tool but left this off LibraryBackend. */
  related(ref: CitationRef, opts: { limit: number }): Promise<{ ref: CitationRef; title: string; snippet: string }[]>;
  /** spec 012 radar methods. A backend without them (Zotero standalone) cannot run a radar. */
  items?(q: { collections: string[] | null }): Promise<import("./radar-types").LibraryItem[]>;
  radarScore?(q: import("./radar-types").ScoreRequest): Promise<Record<string, import("./radar-types").SeedScore>>;
  /** Spec radar-seeds G3: new arXiv papers read whole and compared with the seeds; a paper that could not be read has `error`. */
  radarFulltext?(q: { seeds: import("./radar-types").SeedBody; items: { id: string; arxiv: string }[]; baseline?: import("./radar-types").SeedBaseline | null }): Promise<Record<string, { seed_max?: number; seed_best?: string | null; seed_raw?: number; error?: string }>>;
  /** Spec radar-seeds G4. */
  radarCalibrate?(q: { seeds: import("./radar-types").SeedBody; unrelated: { title: string; abstract: string; arxiv: string | null }[]; field?: { title: string; abstract: string; arxiv: string | null }[]; full_papers?: number }): Promise<{ abstract: import("./radar-types").ThresholdStats; full: import("./radar-types").ThresholdStats | null; seeds: number; at: number; baseline?: import("./radar-types").SeedBaseline; field?: { abstracts: number; whole: number } }>;
  radarProfile?(q: { scope: import("./radar-types").ScoreScope; seeds?: { keys: string[] } }): Promise<import("./radar-types").SeedProfile>;
  /** Writes `Second Brain/Digests/<file>.md` in the vault. */
  writeDigest?(file: string, text: string): Promise<void>;
}

export interface ToolContext {
  scope: Scope;                      // a review scoped to a collection passes it here; the model cannot widen it
  web: WebMode;
  sources: Sources;
  /** spec 007 §5.2: no tool is offered or callable (extraction turns, whose text our code supplies). */
  none?: boolean;
  audit: string;                     // "chat:<id>" | "review:<id>/researcher:<sq>"
  /** spec 011 U4: YYYY-MM-DD; search_scholarly keeps only papers published on or after it, whatever the model asks (a routine's window). */
  since?: string;
  /** A review's search stage reads this afterwards: how many search_library / search_scholarly calls ran, how many of them errored, and the first error's text. The gateway updates it. */
  searchTally?: { calls: number; failed: number; firstError?: string };
  /** spec 007 §1.5: present whenever the turn belongs to a session, so `read_result` can be offered and the
   *  manifest block can be built. `on` narrows a `chat_papers` turn to just that result (§6): search tools are
   *  refused and `read_result` only serves `on.result`. */
  session?: {
    id: SessionId; results: ResultSummary[];
    on?: { result: ResultRef; rows: RowId[] | "all" };
    /** Reads one version's full body; supplied by the runtime (core.js), backed by store.js's result files. */
    read(ref: { id: string; version?: number }): Promise<Result | null>;
  };
}

/** One row per tool. Everything the gateway exposes is read-only by construction; there is no field to say otherwise. */
export interface ToolRow {
  name: string;                      // search_library, read_source, search_scholarly, web_search, or "<server>__<tool>" for MCP
  description: string;
  inputSchema: object;
  /** Stamped by the gateway, never by a caller: a built-in tool cannot be registered without this literal.
   *  Codex refuses an MCP tool call under approvalPolicy "never" unless it carries this hint (grounding.md P0 spike 4). */
  annotations: { readOnlyHint: true };
  activity: { kind: ActivityKind; label(args: any): string };  // "Searching your papers for 'X'"
  enabled(ctx: ToolContext): boolean;
  run(args: any, ctx: ToolContext, signal: AbortSignal): Promise<ToolOutput>;
}

/** Tool text is wrapped as untrusted data before any model sees it; `seen` feeds the citation validator (web links are resolved only if seen). */
export interface ToolOutput {
  text: string; seen: CitationRef[];
  /** What the live activity row shows once this call ends ("12 papers", the title read). Never sent to a model. */
  meta?: import("./domain").ActivityMeta;
  /** ref -> human title pairs, so a later read of the same source can be named when it starts. */
  titles?: [CitationRef, string][];
}

/** A per-turn (or per-review-agent) view of the registry. Closing it revokes the MCP token. */
export interface ToolSession {
  specs: { name: string; description: string; inputSchema: object }[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<{ ok: boolean; text: string; meta?: import("./domain").ActivityMeta }>;
  /** The meta of a finished call (matched by tool name and arguments), handed out once; null when it had none. */
  takeMeta(name: string, args: unknown): import("./domain").ActivityMeta | null;
  /** A friendlier start label when the title of what is about to be read can be found cheaply; null keeps the default. */
  describe(name: string, args: unknown): Promise<string | null>;
  /** Live activity: called with a start event when one of the gateway's own (library) tools begins a call and an end
   *  event when it finishes, built from the tool's own result. Returns an unsubscribe. Optional: a session without it
   *  reports nothing and the engine falls back to the provider's own activity events. */
  onActivity?(listener: (ev: Extract<import("./domain").AgentEvent, { type: "activity" }>) => void): () => void;
  /** True for a tool this session reports through `onActivity` (bare or `mcp__lib__`-prefixed name). */
  isHostTool?(name: string): boolean;
  mcp: { url: string; token: string };        // Authorization: Bearer <token>; unknown token -> 401
  seen(): CitationRef[];                      // everything tool results returned in this session
  close(): void;
}

export interface ToolGateway {
  open(ctx: ToolContext): ToolSession;
  mcpServers: McpHub;
  dispose(): Promise<void>;
}

/** The gateway takes a `fetch`, not the full Platform: its only host dependencies are `fetch` (search_scholarly,
 *  HTTP MCP servers) and, optionally, `spawn` for stdio MCP servers (T1.3 and P6 reconciliation entries). A host
 *  without `spawn` gets stdio servers reported as failed with a plain message. */
export declare function createToolGateway(fetchFn: typeof fetch, library: LibraryBackend, settings?: {
  mcpUrl?: string;                            // where this host serves the MCP face; handed to Codex and Claude
  scholarly?: string[];                       // discover.js sources: openalex, s2, arxiv, crossref, europepmc, biorxiv, chemrxiv
  spawn?: Platform["spawn"];
  mcp?: (McpServerConfig & { trustUnmarked?: boolean })[];
}): Promise<ToolGateway & { _sessionForToken(token: string): ToolSession | null }>;

/** Pure JSON-RPC handler for the MCP HTTP face (initialize, tools/list with readOnlyHint:true on every tool, tools/call; notifications -> 202). */
export declare function handleMcp(body: string, session: ToolSession | null): Promise<{ status: number; body: string }>;

/** The MCP face as an HttpHandler: the bearer token picks the session, then handleMcp answers. */
export declare function createMcpHttpHandler(gateway: { _sessionForToken(token: string): ToolSession | null }): import("./platform").HttpHandler;

export declare const SCHOLARLY_SOURCES: string[];

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
  /** spec 012: one exposed tool of a connected server, called directly; its text. Rejects with a plain message. */
  call(server: string, tool: string, args: object): Promise<string>;
}

/** T6.1. platform.spawn for stdio servers, platform.fetch for streamable HTTP. `initial` seeds and connects the
 *  saved server list at startup (awaited by the returned `ready`, which createToolGateway awaits before it
 *  returns, so `rows()` already reflects every reachable saved server). */
export declare function createMcpHub(platform: { fetch: typeof fetch; spawn: import("./platform").Platform["spawn"] }, opts?: {
  initial?: (McpServerConfig & { trustUnmarked?: boolean })[];
}): McpHub & { ready: Promise<void> };

/** Pure: readOnlyHint:true -> "exposed"; destructiveHint:true or readOnlyHint:false -> "hidden_writes"; no hint
 *  at all -> "hidden_unmarked" unless trustUnmarked. */
export declare function verdictFor(tool: { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }, trustUnmarked: boolean): McpToolVerdict;

/** The Settings UI's human-readable reason for a hidden tool; null for "exposed". Not on the wire type itself. */
export declare function reasonForVerdict(verdict: McpToolVerdict): string | null;

/** Citation validator: extract [[Note]], [@key], and links from answer text, then resolve against the library and this turn's seen refs. */
export declare function validateCitations(text: string, library: LibraryBackend, seen: CitationRef[]): Promise<Citation[]>;
