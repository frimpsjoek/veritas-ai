// Domain types shared by every module and every host. Nothing here names a wire format
// (JSON-RPC, stream-json, chat/completions, MCP). Wire types are parsed into these inside providers/ and tools/.

export type Brand<T, B extends string> = T & { readonly __brand: B };
export type ConversationId = Brand<string, "ConversationId">; // ULID, minted by the runtime that owns the store
export type ReviewId = Brand<string, "ReviewId">;
export type SubQuestionId = Brand<string, "SubQuestionId">;
export type Citekey = Brand<string, "Citekey">;
export type NotePath = Brand<string, "NotePath">;            // vault-relative, or "zotero/<KEY>"

// ---------- spec 007: sessions, steps and results ----------

export type SessionId = ConversationId;                    // a session is a conversation; no second id space
export type StepId = Brand<string, "StepId">;               // "S1", "S2" ... per session
export type ResultId = Brand<string, "ResultId">;           // "R1", "R2" ... per session
export type RowId = Brand<string, "RowId">;                 // "p:<citekey>" | "doi:<doi>" | "t:<title hash>" | "x:<n>"
export type ColumnId = Brand<string, "ColumnId">;           // slug of the column name, unique within a result

export interface ResultRef { id: ResultId; version: number }
export type ResultKind = "papers" | "table" | "report" | "answer";

export type StudyType = "review" | "systematic_review" | "meta_analysis" | "rct" | "longitudinal" | "other";

/** `ref` is how answers cite it: a paper ref when it's in Zotero, a note ref for a vault PDF, a web ref to its
 *  DOI link (https://doi.org/...) or URL when it's outside. */
export interface PaperRow {
  id: RowId; ref: CitationRef; inLibrary: boolean;
  title: string; authors: string[]; year: number | null; venue: string;
  doi: string | null; url: string | null; abstract: string;
  /** spec 012: set on a reading radar's rows, so "why is this here" has an answer. */
  radar?: { key: string; score: number; why: import("./radar-types").RadarWhy; links: string[]; sources: string[]; date: string | null; reason?: string; /** One model line from the abstract (R4); absent when the model failed or there was no abstract. */ why_line?: string };
  /** Where `abstract` came from, set by a review's search stage: "library" = read from the library itself; "unverified" =
   *  an outside paper's abstract as the researcher model transcribed it, never checked; "none" = nothing was returned.
   *  Missing on rows older than this field and on rows built elsewhere (Find papers, chat tables). */
  abstractStatus?: "library" | "source" | "unverified" | "none";
  citations: number | null;
  fullText: boolean;
  pdfUrl: string | null;
  studyType: StudyType | null;
  foundBy: string[];
}

export interface ColumnSpec {
  id: ColumnId; name: string;
  instruction: string;
  kind: "text" | "number" | "criterion";
  preset?: "summary" | "main_findings" | "methodology" | "intervention" | "outcome" | "limitations"
         | "sample" | "study_type" | "population";
}

/** `unverified`: the text the quote was checked against is an outside paper's abstract as a researcher transcribed it. */
export interface Quote { text: string; ref: CitationRef; from: "abstract" | "full_text"; verified: boolean; unverified?: boolean }
export type Cell =
  | { state: "filled"; value: string; quotes: Quote[]; citations: CitationRef[]; unverified?: boolean }
  | { state: "not_found"; note: string }
  | { state: "failed"; error: string }
  | { state: "pending" };

export interface ScreenDecision {
  ai: "include" | "exclude" | "unclear";
  because: ColumnId[];
  user: "include" | "exclude" | null;
}

interface ResultBase {
  ref: ResultRef; title: string; created: string;
  madeBy: StepId; from: ResultRef[];
  change: string;
}
export interface PapersResult extends ResultBase {
  kind: "papers"; query: string | null;
  rows: PaperRow[]; columns: ColumnSpec[];
  cells: Record<RowId, Record<ColumnId, Cell>>;
  screening: Record<RowId, ScreenDecision> | null;
  summary: { markdown: string; citations: Citation[] } | null;
  /** spec 007 E8: set only on the virtual `screening` result of a systematic review that waits on its unclear papers
   *  (session id `review:<id>`); `unclear` are the rows the researcher may still toggle, with the strict criteria each
   *  was unclear on. Answered through `reviews.screened(review, overrides)`. */
  gate?: { review: ReviewId; unclear: { id: RowId; because: string[] }[] };
  /** spec 011 U4: the rows a routine run added to make this version (highlighted in the table); absent on every other version. */
  addedRows?: RowId[];
  /** spec 012 R4: set on a reading radar's digest results; the digest view reads the summary line and the routine id for feedback. */
  radar?: { routine: string; summary: string };
}
export interface TableResult extends ResultBase {
  kind: "table"; columns: ColumnSpec[];
  rows: { id: RowId; label: string; paper: RowId | null }[];
  cells: Record<RowId, Record<ColumnId, Cell>>;
}
/** A pointer: the body stays in reviews/<id>/report.json, never copied. */
export interface ReportResult extends ResultBase { kind: "report"; review: ReviewId }
/** Virtual: built at read time from an assistant record; no file. */
export interface AnswerResult extends ResultBase { kind: "answer"; answer: Answer<unknown> }
export type Result = PapersResult | TableResult | ReportResult | AnswerResult;

export interface ResultSummary {
  ref: ResultRef; kind: ResultKind; title: string; versions: number;
  rows: number | null; columns: string[]; updated: string;
}

export type StepInput =
  | { kind: "chat"; text: string }
  | { kind: "ask"; text: string }
  | { kind: "find"; query: string; sources: Sources; scope: Scope }
  | { kind: "import"; from: `find:${string}` | `review:${string}` | "selection"; label: string }
  | { kind: "columns"; on: ResultRef; add: ColumnSpec[]; rows: RowId[] | "all" | "pending" | "gaps"; text: "abstract" | "best" } // "pending" = Fill the rest (E4); "gaps" = read the "not reported" cells again (spec 011 U2)
  | { kind: "narrow"; on: ResultRef; keep: RowId[]; why: string }
  | { kind: "radar"; routine: string; since: string }                          // a reading radar run made this session's first papers (spec 012)
  | { kind: "routine"; routine: string; on: ResultRef; since: string }        // a routine run added rows to a paper set (spec 011 U4)
  | { kind: "restore"; on: ResultRef }                                        // "Restore as V(n+1)" (§4)
  | { kind: "screen"; on: ResultRef; criteria: Criterion[] }
  | { kind: "chat_papers"; text: string; on: ResultRef; rows: RowId[] | "all" }
  | { kind: "report"; on: ResultRef | null; request: ReviewRequest; review?: ReviewId }
  | { kind: "synthesize"; on: ResultRef; question: string };

export interface Criterion { id: ColumnId; text: string; strict: boolean }
export type StepKind = StepInput["kind"];

/** Persisted alongside a `ConversationRecord` in the same JSONL. `ConversationRecord` itself never changes shape. */
export type SessionRecord =
  | ConversationRecord
  | { type: "step"; id: StepId; input: StepInput; reads: ResultRef[]; at: string }
  | { type: "step_end"; id: StepId; status: "done" | "failed" | "cancelled" | "stopped";
      writes: ResultRef[]; line?: ActivityLine; error?: AgentError; at: string }
  | { type: "result"; summary: ResultSummary; at: string }
  | { type: "current"; ref: ResultRef; at: string };

// ---------- providers and models ----------

export type ProviderId = "codex" | "claude" | "local" | `oss:${string}`; // oss:<endpoint name from settings>
export type Role = "chat" | "ask" | "lead" | "researcher" | "writer" | "extract";
/** Roles as reported: `extract` is `null` while unset, which means "the researcher's choice" (spec 007 §5.2). */
export type RoleChoices = Record<Exclude<Role, "extract">, ModelChoice> & { extract?: ModelChoice | null };
/** spec 007 E4: what a running columns step streams (service.d.ts `sessions.events`). */
export type StepEvent =
  | { type: "cell"; result: ResultId; row: RowId; column: ColumnId; cell: Cell }
  | { type: "progress"; done: number; total: number }
  | { type: "end"; status: "done" | "failed" | "cancelled" | "stopped"; writes: ResultRef[]; error?: unknown };
/** The cost of a columns step before it runs. `rows` is what was asked for; `cells` and `turns` are what would run
 *  (after the `maxRows` cap). `askFirst` = more than `askFirstRows` rows or `askFirstCells` cells. */
export interface StepEstimate { rows: number; cells: number; turns: number; askFirst: boolean; maxRows: number; capped: boolean }
export type WebMode = "off" | "cached" | "live";

/** What a role runs on. Settings hold one per Role; read at turn start, so a change applies to the next message (F1, criterion 10). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"; // claude --effort takes all five; codex low/medium/high
export interface ModelChoice { provider: ProviderId; model: string | null; effort?: Effort }

/** spec 016: what `providers.models(id)` returns for every provider. `source` says who listed it: the provider itself,
 *  our built-in list (Claude has no list command), or an ID the user typed ("Add a model ID"). */
export interface ProviderModel {
  id: string;
  label: string;
  hint: string | null;
  efforts: Effort[];
  source: "provider" | "builtin" | "added";
  isDefault: boolean;
}

export interface ProviderStatus {
  provider: ProviderId;
  state: "missing" | "signed_out" | "ready" | "unreachable" | "loading";
  version: string | null;
  account: { kind: "chatgpt" | "claude" | "api_key" | "none"; label: string | null; plan: string | null };
  /** `rate_limit` is the latest window reading a turn reported (spec 011 U4): `at` is when, `windowMinutes` how long the window lasts. */
  usage: { kind: "rate_limit"; percentUsed: number; resetsAt?: string; windowMinutes?: number; at?: string } | { kind: "cost"; usdToday: number } | null;
  installHelp: string | null;                                   // plain-language guide when state is "missing"
  /** spec 010: one plain sentence for the settings row and the Answer-with menu ("3 models found."). Absent on the cloud providers. */
  detail?: string | null;
}

/** What `providers.models(id)` returns: a ProviderModel for Codex, Claude Code and endpoints; a LocalModel for "On this Mac". */
export type ListedModel = ProviderModel | LocalModel;

/** spec 010: a model the `local` provider can use (`providers.models("local")`). `id` is `<source>:<name>`. */
export interface LocalModel {
  id: string; label: string; isDefault: boolean;
  source: "mlx" | "ollama" | "lmstudio";
  sizeBytes: number | null;
  /** One honest line shown beside the model ("Not tested on your library"). */
  note: string;
  /** Why it cannot be used right now ("Needs mlx-lm, which isn't installed."); null when it can. */
  unavailable?: string | null;
}

// ---------- the event stream every UI renders ----------

/** Tool activity in plain language. `kind` drives the icon; `label` is the sentence the UI shows ("Searching your papers for 'X'"). */
export type ActivityKind = "library" | "read" | "scholarly" | "web" | "mcp" | "thinking" | "result";

/** spec 007 §3.1. One quiet, collapsed-by-default line per step ("Ran analysis · Conducted 4 searches"); expanding
 *  shows `items` (the individual tool labels) and `reasoning` (grey, when the provider gave any). Built by
 *  `activity.js`'s `compactActivities` (live and from a reopened chat's JSONL) so both fold identically. */
/** What a finished tool call tells the live feed: `detail` ("12 papers"), how many hits, or what was read. */
export interface ActivitySource { kind: "paper" | "note" | "web"; title: string; host?: string }
export interface ActivityMeta { detail?: string; count?: number; source?: ActivitySource }
/** One step of a turn, for the live list. `label` is the present-tense start label; the UI words it as past tense once `state` is done. */
export interface ActivityEntry {
  id: string; kind: ActivityKind; state: "running" | "done" | "failed"; label: string;
  detail?: string; source?: ActivitySource;
}

export interface ActivityLine {
  id: string;
  icon: ActivityKind | "clarify" | "plan" | "screen" | "extract" | "write";
  title: string;                   // "Ran analysis"
  detail: string | null;           // "Conducted 4 searches"
  state: "running" | "done" | "failed";
  items: string[];                 // the individual labels, shown when expanded
  entries?: ActivityEntry[];       // the same steps with kind/state/detail/source, so the UI can draw icons and status
  reasoning: string | null;        // folded grey text, when the provider gave any
}

export type AgentEvent<S = never> =
  | { type: "text"; delta: string }
  // `tool` and `args` are the raw tool call name/arguments (when the provider has them); `compactActivities`
  // uses them to build richer detail than the label alone can (e.g. resolving a `read_result` call's result
  // title/version, spec 007 §1.5's "Referenced "title" Vn" wording).
  | { type: "activity"; id: string; phase: "start" | "end"; kind: ActivityKind; label: string; ok?: boolean; tool?: string; args?: Record<string, unknown>;
      /** On an `end` event, filled from the tool result by the engine (core.js). */
      detail?: string; count?: number; source?: ActivitySource }
  // spec 007 §3.1: provider reasoning (Codex reasoning summary items, Claude thinking blocks, an OpenAI-compatible
  // `reasoning_content` field), streamed as plain text. A provider that sends none emits none.
  | { type: "reasoning"; delta: string }
  // An engine-authored step line (pipeline stages, extraction, spec 007 §3.3), already shaped as one ActivityLine;
  // the UI appends it as-is, with no further grouping.
  | { type: "line"; line: ActivityLine }
  | { type: "notice"; kind: "rate_limit" | "cost" | "retrying" | "format_fallback" | "loading" | "local_guard"; text: string;
      /** spec 011 U4: on a `rate_limit` notice, the numbers behind `text`. */
      usage?: { percentUsed: number; windowMinutes: number; resetsAt?: string } }
  // spec 007 §1.6: a chat turn made (or revised) a `table` result from its sb-table block. Sent before `done`, so
  // a client that stops reading at `done` still sees it. `summary.ref.version` > 1 means a new version of an old table.
  | { type: "result"; summary: ResultSummary; step: StepId }
  // `notice` is set when the turn's sb-table block could not become a table (the block stays as a Markdown table).
  | { type: "done"; answer: Answer<S>; notice?: string }
  | { type: "failed"; error: AgentError };

/** Events carry a per-conversation sequence number so a client can reconnect with `after` (SSE on desktop, long-poll on the phone). */
export type Sequenced<E> = E & { seq: number };

export type AgentErrorKind =
  | "not_installed" | "signed_out" | "rate_limited" | "model_unavailable"
  | "cancelled" | "provider_crashed" | "bad_output" | "busy"
  | "policy_violation"    // the provider tried to run a command or edit a file; the turn is stopped
  | "timeout"             // the turn ran past its role's wall-clock limit (TurnRunner, core.js)
  | "tool_budget";        // the turn made more tool calls than its role's per-turn budget (TurnRunner, core.js)
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
  /** spec 010: the passages a local (retrieval-first) turn was given, shown folded under the answer. */
  passages?: { ref: CitationRef; title: string; snippet: string }[];
}

/** Ask's answer is a typed outcome, so "not in your library" is a value, not a string match. */
export type AskResult = { status: "answered"; markdown: string } | { status: "not_found"; markdown: string };

// ---------- conversations ----------

export type Attachment =
  | { kind: "zoteroItem"; citekey: Citekey } | { kind: "note"; path: NotePath }
  | { kind: "collection"; name: string } | { kind: "tag"; name: string } | { kind: "quote"; text: string };

/** One JSONL line in a conversation file. Only finished turns are stored; streaming deltas never touch disk. */
export type ConversationRecord =
  | { type: "meta"; id: ConversationId; mode: "chat" | "ask"; title: string; created: string; /** spec 011 U4: the routine that started this session. */ routine?: string;
      /** spec 011 U5: the project this chat was born in. */ project?: ProjectId }
  | { type: "rename"; title: string; at: string }
  /** spec 011 U5: moves the chat into a project (`null` = out of any). The last one wins over `meta.project`. */
  | { type: "project"; project: ProjectId | null; at: string }
  /** The user opened the chat. Routine news older than this is not news. Written by `conversations.markSeen`, only when there is some. */
  | { type: "seen"; at: string }
  /** A routine run put `added` papers into this session (a new version of its table, or the report a new session holds). */
  | { type: "routine_run"; routine: string; added: number; at: string;
      /** A radar run's top paper, for its Home cover: the title and "first author, venue". */
      top?: { title: string; by?: string } }
  | { type: "user"; text: string; attachments: Attachment[]; web: WebMode; sources?: Sources;
      /** spec 007 §6: set on a Chat-with-papers turn: the paper set and rows it was about (the side panel filters by `on.result`). */
      on?: { result: ResultRef; rows: RowId[] | "all" };
      /** The `chat_papers` step this turn ran as. */
      step?: StepId;
      /** spec 011 U2: written by a columns step (the change asked, then how it went), not typed in the composer. */
      columnChange?: true; at: string }
  // `lines` is the compacted activity (spec 007 §3.2), built once by `compactActivities` when the turn ends and
  // stored so a reopened chat folds exactly as it streamed. `reasoning` is kept only here (never replayed to a
  // model as history) and capped at 4,000 characters. Both are optional so a pre-E2 record (only `activities`)
  // still parses; `activity.js`'s `linesFromLabels` folds those into one "Used N tools" line at read time.
  | { type: "assistant"; answer: Answer<unknown>; model: ModelChoice; activities: string[]; lines?: ActivityLine[]; reasoning?: string | null;
      /** spec 007 §1.6: "Couldn't turn this into a table" when the answer's sb-table block failed to parse. */
      notice?: string;
      /** The step this turn ran as: set when the turn made a table, and on every Chat-with-papers turn. */
      step?: StepId;
      /** Same scope as the user record of this turn (Chat with papers). */
      on?: { result: ResultRef; rows: RowId[] | "all" };
      /** spec 011 U2: the reply to a column change. */
      columnChange?: true;
      /** spec 011 U3: each skill the turn ran with and the hash of the SKILL.md it read, so a run can be reproduced. */
      skills?: SkillRef[]; at: string }
  | { type: "failed"; error: AgentError; at: string };

export interface ConversationSummary {
  id: ConversationId; mode: "chat" | "ask"; title: string; updated: string;
  /** spec 007: how many artifact (papers/table/report) results the session holds, and its first step's kind, for
   *  the history icon and empty-state cards. Both 0 / "chat" for a session with no step/result records yet. */
  artifacts: number; kind: "chat" | "find" | "report" | "systematic";
  /** spec 011 U4: set on a session a routine started (the history list shows a clock). */
  routine?: string;
  /** spec 011 U5: the project this chat is in (the last `project` record, else `meta.project`); `null` once taken out;
   *  absent for a chat that never had one. An id with no project behind it (deleted) means "no project". */
  project?: ProjectId | null;
  /** Papers routine runs added since the user last opened this chat; absent when none. A session a routine started counts
   *  as news until it is opened. */
  news?: { papers: number; at: string };
  /** The words on this session's Home cover (sessions.js `coverOf`). Absent for an empty chat. */
  cover?: SessionCover;
}

/** `title` replaces a placeholder chat title with the first question; `quote` is the italic line; `by` credits it
 *  ("6 sources", "Jane Doe, Nature"); `count` is a radar issue's "8 new papers". */
export interface SessionCover {
  kind: "chat" | "find" | "report" | "radar";
  title?: string; quote?: string; by?: string; count?: string;
}

// ---------- projects (spec 011 U5) ----------

export type ProjectId = string;
/** A label for chats and reports (a Zotero collection, not a folder): deleting it deletes only this record. */
export interface Project { id: ProjectId; name: string; created: string; updated: string }

// ---------- routines (spec 011 U4) ----------

/** Local time throughout. Spec 012 section 5. Floor: no more than one run an hour (validation rejects the rest). */
export type RoutineWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type RoutineDays =
  | { kind: "daily" }
  | { kind: "weekdays" }
  | { kind: "some"; weekdays: RoutineWeekday[] }
  | { kind: "every"; n: number; from: string }
  | { kind: "monthly"; day: number };
export type RoutineTimes = { kind: "at"; times: string[] } | { kind: "hourly"; every: number; from: string; to: string };
/** `every`: N = 2-30 days from a YYYY-MM-DD date. `monthly`: 1-31 (a shorter month uses its last day) or -1 = last day. `at`: 1-6 "HH:MM". `hourly`: every 1-12 hours, from/to inclusive. */
export type RoutineSchedule = { days: RoutineDays; times: RoutineTimes };
/** The spec 011 shape. Accepted on input and read from old files; stored routines always hold RoutineSchedule. */
export type LegacyRoutineSchedule = { kind: "daily"; time: string } | { kind: "weekly"; weekday: RoutineWeekday; time: string };
export type RoutineTarget = { kind: "artifact"; session: string; result: { id: string } } | { kind: "session" };
export interface RoutineRun {
  at: string; slot: string | null; status: "done" | "failed" | "skipped"; reason?: string; added?: number;
  session?: string; review?: string; writes?: ResultRef[]; summary?: string;
}
export interface Routine {
  /** The project a new session each run starts in. Unknown or deleted means none. Artifact routines use their session's. */
  project?: ProjectId;
  id: string; name: string; prompt: string; skills: string[]; depth: Depth; schedule: RoutineSchedule; target: RoutineTarget;
  /** A `Sources` object, or null for the default (library papers and scholarly search). */
  sources: Sources | null; scope: Scope | null;
  status: "active" | "paused" | "archived"; created: string; updated: string;
  /** ISO of the slot last run or skipped: the idempotency key. */
  lastSlot: string | null;
  /** ISO of the last run that finished "done"; the next watch run searches from the day before it. */
  lastDone?: string | null;
  lastRun: RoutineRun | null; notify: boolean;
  /** spec 012: missing means today's behaviour (a watch when `target` is an artifact, else a digest). */
  kind?: "watch" | "digest" | "radar";
  /** Present when `kind` is "radar". */
  radar?: import("./radar-types").RadarConfig;
}
export interface RoutineDraft {
  prompt: string; name?: string; skills?: string[]; depth?: Depth; schedule: RoutineSchedule | LegacyRoutineSchedule; target?: RoutineTarget;
  sources?: Sources | null; scope?: Scope | null; status?: Routine["status"]; project?: ProjectId | null;
  kind?: Routine["kind"]; radar?: Routine["radar"];
}
export type RoutineView = Routine & { nextRun: string | null; running: boolean; /** A radar's last answer per source id (its own state file). */ radarStatus?: Record<string, import("./radar-types").SourceStatus>; /** Profile changes the radar made itself after an Add, each undoable. */ radarLearned?: import("./radar-types").LearnedEntry[]; /** Spec 017: phrases that came from two liked papers and are not topics yet. */ radarLearning?: { text: string; count: number }[] };
/** A routine file that could not be read. `list()` returns these among the RoutineViews (never scheduled); the view shows one quiet line for them. */
export type BrokenRoutine = { broken: true; id: string; file: string; name: string; problem: string };

// ---------- literature review ----------

/** Spec 008 Z3: `keys` are Zotero collection keys, not names — a key includes all its descendant collections
 *  (Z2), and unlike a name it's stable and unambiguous (Zotero allows the same name under different parents). A
 *  pre-Z3 persisted `{ kind: "collection"; name }` (an old review's request.json, a saved Find papers search) is
 *  never rewritten; every reader maps it to this shape at read time with scope.js's migrateScope. */
export type Scope =
  | { kind: "library" } | { kind: "collections"; keys: string[] } | { kind: "tag"; name: string } | { kind: "savedSearch"; name: string };
/** Spec 005: "library" is split into "papers" (Zotero) and "notes" (the Obsidian vault). A ReviewSource array or
 *  Sources record read from disk may still carry the old "library" value (an unresumed review, an old pref);
 *  every reader normalises it to both papers and notes, never rewriting the file. */
export type ReviewSource = "papers" | "notes" | "scholarly" | "web" | "library";
/** One value per app (spec 005 §5): what the chat's four source pills search. */
export interface Sources { papers: boolean; notes: boolean; scholarly: boolean; web: boolean }
export type Depth = "fastest" | "quick" | "standard" | "deep"; // fastest: as quick, no screening turn, abstracts only; quick: 3 sub-questions/3 researchers, standard: 5/3, deep: 8/5

/** One skill a run carried: `hash` is the SHA-256 of its SKILL.md, `block` the text put in the prompts (capped), `notice` set when it was cut. */
export interface SkillRef { name: string; hash: string; cut?: boolean }
export interface SkillRun extends SkillRef { block: string; notice?: string | null }

export interface ReviewRequest {
  question: string; scope: Scope; sources: ReviewSource[];
  years: { from: number | null; to: number | null }; depth: Depth;
  /** Skip the approve stage's WAIT and run straight through (spec F4: "run it automatically"). Default false: pause. */
  autoApprove?: boolean;
  /** spec 007 §2.1: 2 = clarify → plan → approve → search → screen → extract → synthesize → publish. Missing = 1. */
  pipeline?: 1 | 2;
  /** Pipeline 2 only: start from this session table's / paper set's rows instead of searching (Write a report from this). */
  on?: ResultRef | null;
  /** What pipeline 2's screening and extraction read. Default "head": a library paper's first ~4,000 characters from
   *  the library itself (its abstract sits there), else the abstract a search returned; 8 papers a turn. "abstract":
   *  only the abstract a search returned. "best": a library paper's full text, one paper a turn (slow, and past the
   *  3-minute turn limit on long texts with many columns). */
  text?: "abstract" | "head" | "best";
  /** spec 007 E8: a Systematic review: a PICOS protocol, at least one strict criterion, larger caps, and a wait when
   *  more than 10% of the candidates are unclear. Only with `pipeline: 2`. */
  systematic?: boolean;
  /** The session (conversation) this review was started from; a finished review adds its results there. */
  session?: ConversationId;
  /** spec 011 U3: skills to run with. The caller sends names only (`block` and `hash` are filled in when the review starts and
   *  stay in request.json, so a resumed review reads the same text). */
  skills?: (Partial<SkillRun> & { name: string })[];
  /** spec 011 U5: the project this report belongs to. Moved later by `projects.assign`. */
  project?: ProjectId;
  /** The web mode a report that lists "web" runs with, read from the saved Research setting when the review starts (so a
   *  resume reads the same value). Missing = live. */
  web?: "cached" | "live";
  /** "Write a report from this": `on` is a table or paper set with columns; only synthesize and publish run. */
  fromTable?: boolean;
}

/** spec 007 §2.2: at most 2 per review, each with 2-4 short choices. */
export interface ClarifyQuestion { id: string; question: string; choices: string[]; other: boolean }
/** `choice` is an index into `choices`; null + null = "You decide". */
export interface ClarifyAnswer { id: string; choice: number | null; other: string | null }
/** clarify.json: what was asked and what the user said. */
export interface Clarified { questions: ClarifyQuestion[]; answers: ClarifyAnswer[] }

export interface SubQuestion { id: SubQuestionId; question: string; strategy: string; sources: ReviewSource[] }
/** PICOS (spec 007 §2.3): a field that does not apply to the question is null, never invented. */
export interface Protocol {
  population: string | null; intervention: string | null; comparison: string | null;
  outcomes: string | null; studyDesigns: StudyType[] | null;
}

/** Lead output, schema-validated. Every field after `subQuestions` is pipeline 2 and optional, so old plans parse. */
export interface Plan {
  subQuestions: SubQuestion[];
  protocol?: Protocol;            // systematic mode only
  criteria?: Criterion[];         // report mode: 0-2 "Preferred"
  columns?: ColumnSpec[];         // what extract fills; defaults per mode
  assumed?: string[];             // "Assumed: 2015 onward" when clarify was skipped
  caps?: { candidates: number; extract: number };
}

export interface Source { citekey: Citekey | null; doi: string | null; url: string | null; title: string; year: number | null; inLibrary: boolean }
export interface Finding { claim: string; sources: Source[]; quotes: string[]; confidence: "low" | "medium" | "high" }
export interface SearchLogEntry { query: string; source: string; results: number }
export interface Findings { subQuestion: SubQuestionId; findings: Finding[]; searchLog: SearchLogEntry[] } // researcher output

export interface Screened { findings: Finding[]; sources: Source[]; outside: Source[]; searchLog: SearchLogEntry[] } // pure dedupe by DOI/citekey

/** A pipeline-2 evidence entry points at the table cells it rests on (spec 007 §2.1). */
export interface CellRef { row: RowId; column: ColumnId }
export interface Report {                                        // writer output, schema-validated
  title: string; scope: string; method: string; themes: { heading: string; body: string }[];
  evidence: { claim: string; sources: Citekey[]; strength: "weak" | "moderate" | "strong"; cells?: CellRef[]; unverified?: boolean }[];
  disagreements: string; gaps: string; references: Source[];
  /** Set when a skill shaped the report: markdown in the skill's own form, citing papers as [@citekey]. themes/evidence are then empty. */
  body?: string;
}

/** Derived from which stage files exist; never stored as a field that could drift. */
export type ReviewStatus =
  | { state: "running"; stage: StageId; agents: { subQuestion: SubQuestionId; state: "waiting" | "running" | "done" | "failed" }[] }
  | { state: "awaiting_answer"; questions: ClarifyQuestion[] }
  | { state: "awaiting_review"; unclear: UnclearRow[]; total: number }
  | { state: "awaiting_approval"; plan: Plan }
  | { state: "stopped"; stage: StageId; reason: "cancelled" | "crashed" | AgentErrorKind } // resumable
  | { state: "done"; notePath: NotePath };

export type StageId = "review" | "clarify" | "plan" | "approve" | "research" | "search" | "screen" | "extract" | "synthesize" | "publish";

export interface ReviewProgress {
  id: ReviewId; status: ReviewStatus; papersFound: number; outside: Source[];
  question?: string | null;  // from request.json; optional so an older server's progress still parses
  started?: string | null;   // ISO time, from the ReviewId's ULID timestamp
  report?: Report;           // only from watch(), once the review is done
  /** Systematic review (spec 007 E8), from request.json; absent for a report. */
  systematic?: boolean;
  /** spec 011 U5, from request.json: the project this report belongs to. */
  project?: ProjectId;
  /** spec 011 U3, from request.json: the skills this review runs with and the hash of each SKILL.md; `notice` when one was cut. */
  skills?: { name: string; hash: string; notice?: string }[];
  /** spec 011 U1: the latest provider rate-limit notice seen while this review ran ("Codex: 63% of the 5h window used"), for one quiet line in the report. */
  usage?: string;
  /** Pipeline 2, with `report`: the extraction table its evidence entries point into (cells carry the quotes). */
  table?: ReviewTable;
  /** Pipeline 2, derived from the files (spec 007 §3.3); absent for pipeline 1. */
  lines?: ActivityLine[];
  counts?: { candidates: number; included: number; excluded: number; extracted: number } | null;
}

/** A paper the AI could not settle against a strict criterion, for the "Let me look" list (systematic only). */
export interface UnclearRow { id: RowId; title: string; year: number | null; because: string[]; include: boolean }

/** spec 007 §2.1: what the `search` stage writes per sub-question. */
export interface Candidate { citekey: Citekey | null; doi: string | null; url: string | null; title: string; year: number | null; abstract: string; authors: string[]; venue: string }
/** candidates.json: merged and de-duplicated, one PaperRow each. */
export interface Candidates { rows: PaperRow[]; searchLog: SearchLogEntry[] }
/** screening.json: derived decisions per row (spec 007 §2.4) plus the counts the method section reports. */
export interface Screening {
  decisions: Record<RowId, ScreenDecision>;
  criteria: Criterion[];
  perCriterion: Record<string, number>;   // strict-criterion id -> rows excluded because of it
}
/** table.json: the extraction table the writer works from. Same shape as a session TableResult minus its result
 *  bookkeeping, so it can become a pointer artifact as-is. */
export interface ReviewTable { columns: ColumnSpec[]; rows: PaperRow[]; cells: Record<RowId, Record<ColumnId, Cell>> }
