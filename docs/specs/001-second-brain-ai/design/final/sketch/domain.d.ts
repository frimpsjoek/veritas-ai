// Domain types shared by every module and every host. Nothing here names a wire format
// (JSON-RPC, stream-json, chat/completions, MCP). Wire types are parsed into these inside providers/ and tools/.

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ConversationId = Brand<string, "ConversationId">; // ULID, minted by the runtime that owns the store
export type ReviewId = Brand<string, "ReviewId">;
export type SubQuestionId = Brand<string, "SubQuestionId">;
export type Citekey = Brand<string, "Citekey">;
export type NotePath = Brand<string, "NotePath">;            // vault-relative, or "zotero/<KEY>"

// ---------- providers and models ----------

export type ProviderId = "codex" | "claude" | `oss:${string}`; // oss:<endpoint name from settings>
export type Role = "chat" | "ask" | "lead" | "researcher" | "writer";
export type WebMode = "off" | "cached" | "live";

/** What a role runs on. Settings hold one per Role; read at turn start, so a change applies to the next message (F1, criterion 10). */
export interface ModelChoice { provider: ProviderId; model: string | null; effort?: "low" | "medium" | "high" }

export interface ProviderStatus {
  provider: ProviderId;
  state: "missing" | "signed_out" | "ready" | "unreachable";
  version: string | null;
  account: { kind: "chatgpt" | "claude" | "api_key" | "none"; label: string | null; plan: string | null };
  usage: { kind: "rate_limit"; percentUsed: number; resetsAt: string } | { kind: "cost"; usdToday: number } | null;
  installHelp: string | null;                                   // plain-language guide when state is "missing"
}

// ---------- the event stream every UI renders ----------

/** Tool activity in plain language. `kind` drives the icon; `label` is the sentence the UI shows ("Searching your papers for 'X'"). */
export type ActivityKind = "library" | "read" | "scholarly" | "web" | "mcp" | "thinking";

export type AgentEvent<S = never> =
  | { type: "text"; delta: string }
  | { type: "activity"; id: string; phase: "start" | "end"; kind: ActivityKind; label: string; ok?: boolean }
  | { type: "notice"; kind: "rate_limit" | "cost" | "retrying"; text: string }
  | { type: "done"; answer: Answer<S> }
  | { type: "failed"; error: AgentError };

/** Events carry a per-conversation sequence number so a client can reconnect with `after` (SSE on desktop, long-poll on the phone). */
export type Sequenced<E> = E & { seq: number };

export type AgentErrorKind =
  | "not_installed" | "signed_out" | "rate_limited" | "model_unavailable"
  | "cancelled" | "provider_crashed" | "bad_output"
  | "policy_violation";   // the provider tried to run a command or edit a file; the turn is stopped
export interface AgentError { kind: AgentErrorKind; message: string } // message is plain language, stderr already cleaned

// ---------- answers and citations ----------

export type CitationRef =
  | { kind: "note"; path: NotePath }       // [[Note]]
  | { kind: "paper"; citekey: Citekey }    // [@citekey]
  | { kind: "web"; url: string };

/** A citation is "resolved" only if the library has it (note/paper) or a tool result in this turn returned it (web). */
export type Citation =
  | { ref: CitationRef; status: "resolved"; title: string; retrievedThisTurn: boolean }
  | { ref: CitationRef; status: "unknown" };

export interface Answer<S = never> {
  text: string;                      // Markdown with citations inline
  citations: Citation[];
  structured: [S] extends [never] ? null : S; // present iff the turn asked for an output schema; already validated
  usage: { inputTokens?: number; outputTokens?: number; usd?: number };
}

/** Ask's answer is a typed outcome, so "not in your library" is a value, not a string match. */
export type AskResult = { status: "answered"; markdown: string } | { status: "not_found"; markdown: string };

// ---------- conversations ----------

export type Attachment =
  | { kind: "zoteroItem"; citekey: Citekey } | { kind: "note"; path: NotePath }
  | { kind: "collection"; name: string } | { kind: "tag"; name: string } | { kind: "quote"; text: string };

/** One JSONL line in a conversation file. Only finished turns are stored; streaming deltas never touch disk. */
export type ConversationRecord =
  | { type: "meta"; id: ConversationId; mode: "chat" | "ask"; title: string; created: string }
  | { type: "rename"; title: string; at: string }
  | { type: "user"; text: string; attachments: Attachment[]; web: WebMode; at: string }
  | { type: "assistant"; answer: Answer<unknown>; model: ModelChoice; activities: string[]; at: string }
  | { type: "failed"; error: AgentError; at: string };

export interface ConversationSummary { id: ConversationId; mode: "chat" | "ask"; title: string; updated: string }

// ---------- literature review ----------

export type Scope =
  | { kind: "library" } | { kind: "collection"; name: string } | { kind: "tag"; name: string } | { kind: "savedSearch"; name: string };
export type ReviewSource = "library" | "scholarly" | "web";
export type Depth = "quick" | "standard" | "deep"; // quick: 3 sub-questions/3 researchers, standard: 5/3, deep: 8/5

export interface ReviewRequest {
  question: string; scope: Scope; sources: ReviewSource[];
  years: { from: number | null; to: number | null }; depth: Depth;
}

export interface SubQuestion { id: SubQuestionId; question: string; strategy: string; sources: ReviewSource[] }
export interface Plan { subQuestions: SubQuestion[] }            // lead output, schema-validated

export interface Source { citekey: Citekey | null; doi: string | null; url: string | null; title: string; year: number | null; inLibrary: boolean }
export interface Finding { claim: string; sources: Source[]; quotes: string[]; confidence: "low" | "medium" | "high" }
export interface SearchLogEntry { query: string; source: string; results: number }
export interface Findings { subQuestion: SubQuestionId; findings: Finding[]; searchLog: SearchLogEntry[] } // researcher output

export interface Screened { findings: Finding[]; sources: Source[]; outside: Source[]; searchLog: SearchLogEntry[] } // pure dedupe by DOI/citekey

export interface Report {                                        // writer output, schema-validated
  title: string; scope: string; method: string; themes: { heading: string; body: string }[];
  evidence: { claim: string; sources: Citekey[]; strength: "weak" | "moderate" | "strong" }[];
  disagreements: string; gaps: string; references: Source[];
}

/** Derived from which stage files exist; never stored as a field that could drift. */
export type ReviewStatus =
  | { state: "running"; stage: StageId; agents: { subQuestion: SubQuestionId; state: "waiting" | "running" | "done" | "failed" }[] }
  | { state: "awaiting_approval"; plan: Plan }
  | { state: "stopped"; stage: StageId; reason: "cancelled" | "crashed" | AgentErrorKind } // resumable
  | { state: "done"; notePath: NotePath };

export type StageId = "plan" | "approve" | "research" | "screen" | "synthesize" | "publish";

export interface ReviewProgress { id: ReviewId; status: ReviewStatus; papersFound: number; outside: Source[] }
