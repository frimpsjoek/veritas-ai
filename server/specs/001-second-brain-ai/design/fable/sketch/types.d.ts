// Domain types for the Second Brain agent core. No wire or transport types appear here.

// ---- branded ids ----------------------------------------------------------
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type ReviewId = string & { readonly __brand: "ReviewId" };
export type SubQuestionId = string & { readonly __brand: "SubQuestionId" };
export type ProviderId = "codex" | "claude" | `openai:${string}`; // openai:<endpoint name from settings>

// ---- what the user attaches and asks -------------------------------------
export type Attachment =
  | { kind: "zotero-item"; key: string }
  | { kind: "zotero-collection"; key: string }
  | { kind: "note"; path: string }
  | { kind: "tag"; tag: string }
  | { kind: "quote"; text: string };

export interface UserMessage { text: string; attachments?: Attachment[] }

export type WebSearchMode = "off" | "cached" | "live";

// ---- events the UI consumes (one union for all providers, local or remote) --
export type AgentEvent =
  | { type: "turn.started"; conversationId: ConversationId; provider: ProviderId; model: string }
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.started"; callId: string; label: string; kind: "library" | "scholarly" | "web" | "mcp" } // label is plain language: "Searching your papers for 'X'"
  | { type: "tool.finished"; callId: string; ok: boolean; summary: string }
  | { type: "citation.checked"; citation: Citation }
  | { type: "policy.violation"; what: "shell" | "file-edit" | "approval-request"; detail: string } // fails the turn
  | { type: "status"; usage?: Usage }
  | { type: "turn.done"; result: TurnResult }
  | { type: "turn.failed"; error: AgentError };

export type Citation =
  | { kind: "note"; path: string; resolved: boolean }
  | { kind: "paper"; citekey: string; resolved: boolean; zoteroKey?: string }
  | { kind: "web"; url: string; resolved: true };

export interface Usage { inputTokens?: number; outputTokens?: number; costUsd?: number; rateLimit?: { used: number; limit: number; resetsAt?: string } }

export interface TurnResult { text: string; citations: Citation[]; structured?: unknown; usage?: Usage }

export type AgentError =
  | { code: "provider-missing"; provider: ProviderId; installGuide: string }
  | { code: "not-signed-in"; provider: ProviderId }
  | { code: "cancelled" }
  | { code: "schema-invalid"; detail: string }
  | { code: "policy"; what: "shell" | "file-edit" | "approval-request" }
  | { code: "transport"; detail: string };

// ---- the one interface every UI uses ------------------------------------
export interface Runtime {
  conversations: {
    create(opts: { mode: "chat" | "ask"; provider?: ProviderId; model?: string; web?: WebSearchMode }): Promise<Conversation>;
    list(): Promise<ConversationSummary[]>;
    get(id: ConversationId): Promise<Conversation>;
    rename(id: ConversationId, title: string): Promise<void>;
    delete(id: ConversationId): Promise<void>;
    /** Adopt conversations from another store (Zotero local → server). Idempotent by id. */
    import(conversations: Conversation[]): Promise<{ added: number; skipped: number }>;
  };
  /** Stream one turn. The async iterator ends after turn.done or turn.failed. */
  send(id: ConversationId, message: UserMessage, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  /** Single-shot grounded answer; a throwaway conversation behind the scenes. */
  ask(message: UserMessage, opts?: { provider?: ProviderId; web?: WebSearchMode }, signal?: AbortSignal): Promise<TurnResult>;
  reviews: {
    start(input: ReviewInput): Promise<ReviewState>;
    resume(id: ReviewId): Promise<ReviewState>;      // same as start for an existing id
    approvePlan(id: ReviewId, plan: PlanOutput): Promise<void>; // user-edited plan replaces plan.json, then continues
    cancel(id: ReviewId): Promise<void>;
    watch(id: ReviewId): AsyncIterable<ReviewEvent>;
    list(): Promise<ReviewState[]>;
    export(id: ReviewId, format: "md" | "docx" | "pdf"): Promise<{ path: string }>;
  };
  providers: {
    status(): Promise<ProviderStatus[]>;
    models(id: ProviderId): Promise<string[]>;       // live list, never hard-coded
    signIn(id: ProviderId, how: "chatgpt" | "device-code" | { apiKey: string }): Promise<void>;
    signOut(id: ProviderId): Promise<void>;
  };
  mcp: {
    test(server: McpServerConfig): Promise<McpTestResult>;
  };
}

export interface Conversation { id: ConversationId; title: string; mode: "chat" | "ask"; provider: ProviderId; model: string; web: WebSearchMode; turns: StoredTurn[]; createdAt: string }
export interface ConversationSummary { id: ConversationId; title: string; updatedAt: string }
export type StoredTurn = { role: "user"; message: UserMessage; at: string } | { role: "assistant"; result: TurnResult; at: string };

export interface ProviderStatus {
  id: ProviderId; found: boolean; version?: string;
  auth: { kind: "chatgpt" | "claude-subscription" | "api-key" | "none"; plan?: string };
  usage?: Usage; installGuide?: string;
}

// ---- literature review ---------------------------------------------------
export type ReviewScope = { kind: "library" } | { kind: "collection"; key: string } | { kind: "tag"; tag: string } | { kind: "saved-search"; key: string };
export interface ReviewRoles { lead: ProviderId; researcher: ProviderId; writer: ProviderId; models?: Partial<Record<keyof ReviewRoles, string>> }
export interface ReviewInput {
  question: string; scope: ReviewScope; sources: ("library" | "scholarly" | "web")[];
  years: [number | null, number | null]; depth: "quick" | "standard" | "deep";
  roles: ReviewRoles; autoApprovePlan?: boolean;
}

export type StageId = "plan" | "research" | "screen" | "synthesize";
export type StageStatus = "pending" | "running" | "awaiting-approval" | "done";
export interface ReviewState {
  id: ReviewId; input: ReviewInput; startedAt: string;
  stages: Record<StageId, StageStatus>;           // derived from files on disk plus the live signal, never stored
  status: "running" | "awaiting-approval" | "done" | "cancelled" | "failed";
  reportPath?: string;
}
export type ReviewEvent =
  | { type: "stage.changed"; stage: StageId; status: StageStatus }
  | { type: "agent.status"; subQuestion: SubQuestionId; status: "queued" | "running" | "done" | "failed"; label: string }
  | { type: "paper.found"; paper: FoundPaper }
  | { type: "review.done"; state: ReviewState }
  | { type: "review.failed"; error: AgentError };

// Structured outputs; the runtime validates against the JSON Schema in prompts.js before these types are trusted.
export interface PlanOutput { subQuestions: { id: SubQuestionId; question: string; strategy: string; sources: ("library" | "scholarly" | "web")[] }[] }
export interface FindingsOutput { subQuestion: SubQuestionId; claims: Claim[]; searchLog: { query: string; source: string; count: number }[] }
export interface Claim { text: string; sources: SourceRef[]; quotes: string[]; confidence: "low" | "medium" | "high" }
export type SourceRef = { kind: "paper"; citekey?: string; doi?: string; title: string } | { kind: "note"; path: string } | { kind: "web"; url: string; title: string };
export interface FoundPaper { doi?: string; title: string; inLibrary: boolean; citekey?: string; year?: number }
export interface ScreenedOutput { claims: Claim[]; papers: FoundPaper[]; duplicatesMerged: number }

// ---- provider contract (implemented three times, seen only by runtime.js) --
export interface TurnRequest {
  system: string; history: StoredTurn[]; message: UserMessage;
  model: string; web: WebSearchMode; effort?: "low" | "medium" | "high";
  schema?: object;                                // JSON Schema for structured output
}
export interface Session { provider: ProviderId; conversationId: ConversationId; close(): Promise<void> }
export interface Provider {
  id: ProviderId;
  /** Native structured output; when false the runtime puts the schema in the prompt and validates. */
  capabilities: { nativeSchema: boolean; nativeWebSearch: boolean };
  status(): Promise<ProviderStatus>;
  models(): Promise<string[]>;
  open(conversationId: ConversationId): Promise<Session>;
  /** Streams events to sink and resolves when the turn is over. Must observe signal and translate it into interrupt. */
  turn(session: Session, request: TurnRequest, tools: ToolSet, sink: (ev: AgentEvent) => void, signal: AbortSignal): Promise<TurnResult>;
  signIn?(how: "chatgpt" | "device-code" | { apiKey: string }): Promise<void>;
  signOut?(): Promise<void>;
}

// ---- tools --------------------------------------------------------------
export interface ToolSpec { name: string; description: string; inputSchema: object; kind: "library" | "scholarly" | "web" | "mcp"; label(args: unknown): string }
export interface ToolResult { text: string; sources?: SourceRef[] }
export interface ToolSet {
  specs(): ToolSpec[];
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
  /** The aggregated MCP endpoint the agentic CLIs are pointed at. Every published tool carries readOnlyHint. */
  mcpUrl(): string;
}
export type McpServerConfig = { name: string; enabled: boolean } & ({ transport: "stdio"; command: string; args: string[]; env?: Record<string, string> } | { transport: "http"; url: string; headers?: Record<string, string> });
export interface McpTestResult { ok: boolean; tools: { name: string; readOnly: boolean; exposed: boolean }[]; error?: string }

// ---- what a host provides to createRuntime --------------------------------
export interface Host {
  dataDir: string;                                // the store this runtime owns; exactly one runtime per dataDir
  spawn(cmd: string, args: string[], opts: { env?: Record<string, string>; cwd?: string }): Promise<ChildProcessLike>;
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{ status: number; text(): Promise<string>; body?: AsyncIterable<string> }>;
  files: { read(path: string): Promise<string | null>; write(path: string, text: string): Promise<void>; append(path: string, line: string): Promise<void>; list(dir: string): Promise<string[]>; remove(path: string): Promise<void> };
  /** Publish the aggregated MCP handler at a URL only this runtime knows; returns that URL. */
  serveMcp(handler: (body: string) => Promise<{ status: number; body: string }>): Promise<string>;
  /** Built-in tool handlers backed by this host's data (local index in Zotero, kb.py in the sidecar). */
  tools: Record<"search_library" | "read_source" | "search_scholarly" | "current_item", (args: unknown, signal: AbortSignal) => Promise<ToolResult>>;
  /** Writes a report note collision-safely (LocalStore folder, or POST /ai-note on the server). */
  writeReport(title: string, frontMatter: Record<string, unknown>, body: string): Promise<{ path: string }>;
  which(binary: "codex" | "claude" | "node"): Promise<string | null>;
}
export interface ChildProcessLike { stdin: { write(s: string): void; end(): void }; stdout: AsyncIterable<string>; stderr: AsyncIterable<string>; kill(): void; exited: Promise<number> }

export interface Settings {
  providers: { chat: ProviderId; ask: ProviderId; review: ReviewRoles };
  endpoints: { name: string; baseUrl: string; apiKey?: string; model: string }[];
  webDefault: WebSearchMode; webBackend?: { kind: "exa" | "tavily" | "searxng"; url?: string; apiKey?: string };
  mcpServers: McpServerConfig[];
  parallel: { researchers: 1 | 2 | 3 | 4 | 5 };
  binaries: { codex?: string; claude?: string; node?: string };
}
