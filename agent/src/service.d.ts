// The one public surface. Every UI (Zotero tab, Obsidian view on desktop and phone) talks to an AgentService.
// Two implementations exist and the UI cannot tell them apart:
//   LocalRuntime  : the core in this process (Zotero standalone; the Node sidecar behind the server)
//   RemoteRuntime : an HTTP client of the sidecar, through the Python server (Obsidian always; Zotero when the server runs)
import type {
  AgentEvent, Sequenced, RoleChoices, StepEvent, StepEstimate, ConversationId, ConversationSummary, ConversationRecord, Attachment, WebMode, Role,
  ModelChoice, ProviderId, ProviderStatus, AskResult, Answer, ReviewId, ReviewRequest, ReviewProgress, Plan, Scope,
  Sources, SessionId, ResultRef, Result, ResultSummary, RowId, StepId, StepInput, SessionRecord, ClarifyAnswer,
} from "./domain";
import type { McpServerConfig, McpServerReport } from "./tools";
import type { Settings } from "./settings";

/** `scope` narrows search_library the same way a review's scope does (tools.js ToolContext); left out, or
 *  `{ kind: "library" }`, searches the whole library. `sources` (spec 005 §5) is the chat's four pills; left
 *  out, today's defaults apply (papers, notes, scholarly on; web on iff `web` isn't "off"). */
/** spec 007 §6: `on` scopes a turn to one result (chat_papers). When set, tools narrow to `read_result` (that
 *  result only) and `read_source` for rows in it; search tools are off, regardless of `sources`. */
export interface SendInput { text: string; /** spec 011 U3: skill names to run this turn with. */ skills?: string[]; attachments?: Attachment[]; web?: WebMode; scope?: Scope; sources?: Sources; on?: { result: ResultRef; rows: RowId[] | "all" } }

export interface AgentService {
  readonly where: "local" | "server";

  conversations: {
    list(): Promise<ConversationSummary[]>;
    /** spec 007: a session's records, which is a superset of the plain-chat `ConversationRecord` shapes -- `step`,
     *  `step_end`, `result` and `current` records are interleaved in the same file (domain.d.ts's `SessionRecord`).
     *  A Chat-with-papers turn's `user` and `assistant` records carry `on: { result, rows }` and `step`, so a panel can
     *  show only the turns about one result (`on.result.id`), and a reopened answer knows its scope. */
    load(id: ConversationId): Promise<SessionRecord[]>;
    /** `opts.project` (spec 011 U5) starts the chat inside that project. */
    create(mode: "chat" | "ask", opts?: { project?: string }): Promise<ConversationId>;
    rename(id: ConversationId, title: string): Promise<void>;
    /** The user opened this chat: routine news in it is no longer news (`ConversationSummary.news`). Writes nothing
     *  when there is none, so calling it on every open is cheap. */
    markSeen(id: ConversationId): Promise<void>;
    remove(id: ConversationId): Promise<void>;
    /** Streams one turn. Aborting the signal interrupts the provider; the stream then ends with failed{cancelled}.
     *  `after` resumes a stream this client lost (reconnect, phone waking up). */
    send(id: ConversationId, input: SendInput, opts?: { signal?: AbortSignal; after?: number }): AsyncIterable<Sequenced<AgentEvent>>;
    /** Stops the turn running in this conversation, whoever started it. A no-op when none runs. */
    cancel(id: ConversationId): Promise<void>;
    /** Where the live event log of a conversation stands (last sequence number, and whether a turn is running). The log
     *  keeps a finished turn's events for a few minutes, so a client starting a turn reads from `seq`, not from 0. */
    cursor(id: ConversationId): Promise<{ seq: number; inFlight: boolean }>;
    /** Takes over conversations from a runtime that used to own them (Zotero standalone switching to the
     *  server). Idempotent by conversation id: adopting the same id twice keeps its first history, never
     *  duplicates or overwrites it. Returns the ids now owned here. */
    adopt(files: { id: ConversationId; jsonl: string; files?: { path: string; text: string }[] }[]): Promise<ConversationId[]>;
  };

  /** One question, one answer, not stored as a conversation. Used by the "Ask about selection" commands. */
  ask(question: string, opts?: { attachments?: Attachment[]; web?: WebMode; scope?: Scope; sources?: Sources; signal?: AbortSignal }): AsyncIterable<AgentEvent<AskResult>>;

  reviews: {
    /** Estimated model turns for a report at this depth (typical, and a low-high range); spec 011 U1. */
    estimate(req: Pick<ReviewRequest, "depth" | "systematic" | "text" | "autoApprove">): Promise<{ turns: number; low: number; high: number }>;
    start(req: ReviewRequest): Promise<ReviewId>;
    /** Progress snapshots until the review is done, stopped or awaiting approval; each carries `seq` for `after`
     *  (a dropped connection resumes with the last seq it saw, same as conversations.send's `after`). Watching
     *  alone never starts or resumes a stopped review — call resume() for that. */
    watch(id: ReviewId, opts?: { signal?: AbortSignal; after?: number }): AsyncIterable<Sequenced<ReviewProgress>>;
    approvePlan(id: ReviewId, plan: Plan): Promise<void>;
    /** spec 007 §2.2: answers the clarify cards of a pipeline-2 review (`awaiting_answer`) and resumes it. */
    answer(id: ReviewId, answers: ClarifyAnswer[]): Promise<void>;
    /** spec 007 E8: settles a systematic review's unclear papers (`awaiting_review`) and resumes it. `overrides` are the
     *  researcher's calls; none = keep every unclear paper. */
    screened(id: ReviewId, overrides: { id: RowId; include: boolean }[]): Promise<void>;
    resume(id: ReviewId): Promise<void>;
    cancel(id: ReviewId): Promise<void>;
    list(): Promise<ReviewProgress[]>;
    export(id: ReviewId, format: "md" | "docx" | "pdf"): Promise<{ path: string }>;
  };

  providers: {
    status(): Promise<ProviderStatus[]>;
    models(provider: ProviderId): Promise<import("./domain").ListedModel[]>;
    signIn(provider: ProviderId, method: "browser" | "device_code" | { apiKey: string }): Promise<{ openUrl?: string; code?: string; done: Promise<ProviderStatus> }>;
    signOut(provider: ProviderId): Promise<void>;
    roles(): Promise<RoleChoices>;
    /** `null` clears the `extract` override (back to the researcher's choice); other roles refuse it. */
    setRole(role: Role, choice: ModelChoice | null): Promise<void>;
  };

  /** spec 007 E1: the session (= conversation) as a stack of steps and typed, versioned results. No UI calls
   *  this yet (E1 ships no UI change); `read_result` (tools.js) and a scripted provider are the only readers so
   *  far. `run`/`cancel` (columns, screen, synthesize -- E4/E5/E7) are added by a later unit. */
  sessions: {
    /** The session's steps, results (latest `ResultSummary` per id) and current result, read-time-mapped from
     *  legacy chats (no step/result records at all) per §1.4. */
    view(id: ConversationId): Promise<{ steps: SessionStepView[]; results: ResultSummary[]; current: ResultRef | null }>;
    /** One version's full body. `ref.version` omitted reads the latest. Null when the id/version doesn't exist. */
    read(id: ConversationId, ref: { id: string; version?: number }): Promise<Result | null>;
    /** Runs a UI-made step (`find`, `import`, `narrow`): the caller already has the finished result (`draft`);
     *  this stores it as a new result (or a new version, when `draft.ref.id` names an existing one) and appends
     *  the `step`/`step_end`/`result` records. Returns the written `ResultSummary`. */
    put(id: ConversationId, input: StepInput, draft: Result): Promise<ResultSummary>;
    /** Re-reads an older version and writes it again as the newest version (`change: "Restored Vn"`). */
    restore(id: ConversationId, ref: ResultRef): Promise<ResultSummary>;
    /** Records which result later steps read by default (a `current` record). */
    setCurrent(id: ConversationId, ref: ResultRef): Promise<void>;
    /** spec 007 E4: starts a `columns` step. Resolves once the `step` record is written; extraction continues in
     *  the background (watch it with `events`). `rows: "pending"` re-runs only pending and failed cells. */
    run(id: ConversationId, input: Extract<StepInput, { kind: "columns" }>): Promise<{ step: StepId }>;
    /** What `run` would cost, so the UI can ask first (`askFirst`) and say "About N turns". */
    estimate(id: ConversationId, input: Extract<StepInput, { kind: "columns" }>): Promise<StepEstimate>;
    /** Replays a step's events from `after`, then follows it live; ends after the `end` event. A step this process
     *  no longer holds a log for gets one synthesized `end` from its records. */
    events(id: ConversationId, step: StepId, after: number, signal?: AbortSignal): AsyncIterable<{ seq: number; data: StepEvent }>;
    /** Stop: writes the version with what is done (unfinished cells pending); `end.status` is "cancelled". */
    cancel(id: ConversationId, step: StepId): Promise<void>;
  };

  /** spec 011 U3: the user's skills (vault `Second Brain/Skills/<name>/SKILL.md`) plus the built-in starters. A skill is text
   *  added to a prompt; it never grants a tool. A broken or oversize file is listed with `warning` and cannot be used. */
  skills: {
    list(): Promise<import("./skills").SkillSummary[]>;
    /** One skill with its text; a broken one has `warning` and no body; null when there is none. */
    get(name: string): Promise<import("./skills").Skill | import("./skills").SkillSummary | null>;
    /** Saves a SKILL.md (front matter name must equal `name`); refuses what could not be used afterwards. */
    put(name: string, text: string): Promise<import("./skills").Skill>;
    /** Moves the user's skill to the vault's .trash; a built-in cannot be removed. */
    remove(name: string): Promise<void>;
    /** One model turn: a SKILL.md drafted from the user's description, for them to edit. Nothing is saved. */
    draft(description: string): Promise<{ name: string; text: string }>;
  };

  /** spec 011 U4: saved, repeatable sessions that run on a schedule while the runtime is up (design: specs/011-elicit-parity/u4-design.md,
   *  API: u4-api.md). Obsidian reaches the server's; Zotero without the server runs its own and hands them over (`adopt`). */
  routines: {
    /** Every routine, plus a `BrokenRoutine` for each file that could not be read (tell them apart with `broken`). */
    list(): Promise<(import("./domain").RoutineView | import("./domain").BrokenRoutine)[]>;
    create(draft: import("./domain").RoutineDraft): Promise<import("./domain").Routine>;
    /** A changed schedule sets `lastSlot` to now (an edit never fires an old slot). */
    update(id: string, patch: Partial<import("./domain").RoutineDraft>): Promise<import("./domain").Routine>;
    /** Starts at once and returns; ignores the 50% rule and the slot; refused while another routine runs. */
    runNow(id: string): Promise<{ started: boolean; reason?: string }>;
    pause(id: string): Promise<import("./domain").Routine>;
    resume(id: string): Promise<import("./domain").Routine>;
    archive(id: string): Promise<import("./domain").Routine>;
    /** Takes in routines made elsewhere, by id; idempotent. */
    adopt(records: import("./domain").Routine[]): Promise<string[]>;
  };

  /** spec 011 U5: projects are labels for chats and reports (design: specs/011-elicit-parity/u5-design.md). Membership is stored
   *  in the member, so removing a project leaves every chat and report in the history. */
  projects: {
    /** By name. */
    list(): Promise<import("./domain").Project[]>;
    create(name: string): Promise<import("./domain").Project>;
    rename(id: string, name: string): Promise<import("./domain").Project>;
    /** Deletes the project only; its chats and reports keep their history (and a stale id, which means "no project"). */
    remove(id: string): Promise<void>;
    /** Moves one chat or report into a project (`null` = out of any). Refuses an id that does not exist. */
    assign(target: { kind: "chat" | "review"; id: string }, project: string | null): Promise<void>;
    /** Takes in projects made elsewhere, by id; idempotent. */
    adopt(records: import("./domain").Project[]): Promise<string[]>;
  };

  /** spec 012 R2: what the reading radar's setup sheet asks. Both throw the "needs the library server" message where there is none. */
  radar: {
    /** The library's topics, authors and journals as a profile to confirm; authors and journals carry their OpenAlex id and a `match` label. */
    profile(scope?: Scope): Promise<import("./radar-types").RadarProfile>;
    /** What a feed address, an ISSN or a journal name is. Never throws for what the user typed (see SourceCheck). */
    checkSource(input: string): Promise<import("./radar-types").SourceCheck>;
    /** Spec radar-seeds G1: the user's own papers from OpenAlex (by ORCID or name; `openalexId` picks one of several namesakes). */
    myPapers(input: { name: string; orcid?: string | null; openalexId?: string | null }): Promise<{ authors: { openalexId: string; label: string }[]; chosen: string | null; papers: (import("./radar-types").MyPaper & { inLibrary: boolean })[]; problem: string | null }>;
    /** Spec radar-seeds G2, G4: the seeds' arXiv categories and a threshold calibrated on this library (null with `problem` when it could not be). */
    prepareSeeds(seeds: import("./radar-types").RadarSeeds): Promise<{ categories: string[]; threshold: import("./radar-types").RadarThreshold | null; problem: string | null }>;
    /** spec 012 R4: a click on a digest row. `paperKey` is the row's `radar.key`. Idempotent; `undo` reverts that paper's last verdict
     *  exactly. `changed` is false when nothing needed to move. Throws for a paper the radar never showed. */
    /** What the user already did with the papers this radar showed lately, by `radar.key`; papers nothing was done with are left out. */
    /** Spec 017: the person removed a learned topic; it goes and is never learned again. */
    forgetTopic(routineId: string, text: string): Promise<{ forgotten: boolean }>;
    verdicts(routineId: string): Promise<Record<string, import("./radar-types").Verdict>>;
    feedback(routineId: string, paperKey: string, verdict: import("./radar-types").FeedbackVerdict): Promise<{ verdict: import("./radar-types").Verdict; changed: boolean }>;
  };

  /** Outside paper search for hosts that cannot fetch other origins (the web app). One row per paper, per source. */
  scholarly: {
    search(query: string, perSource: number): Promise<{ papers: OutsidePaperRow[]; failed: string[] }>;
  };

  mcp: {
    list(): Promise<McpServerReport[]>;
    save(config: McpServerConfig): Promise<McpServerReport>;   // connects and lists tools: this is the "Test" button
    remove(name: string): Promise<void>;
  };

  /** T6.2: the one persisted record (settings.d.ts). `update` is a partial patch, so a Settings UI that only
   *  ever touches one field (say, webSearchDefault) can't accidentally drop the rest. A role set to `null` is cleared
   *  ("Same as default", spec 016); `endpoints` also registers/removes the `oss:<name>` providers. */
  settings: {
    get(): Promise<Settings>;
    update(patch: import("./settings").SettingsPatch): Promise<Settings>;
  };
}

/** Where a finished literature review goes, supplied by the host like LibraryBackend. Sidecar: POST /ai-note on the
 *  Python server (collision-safe create under WRITE_LOCK, ai_notes/Literature Reviews/YYYY-MM-DD <title>.md).
 *  Zotero standalone: the plugin's local notes folder, so `path` is a vault-relative NotePath from the server but a
 *  plain filesystem path from Zotero. `reviewId` is written into front matter, so a second call finds the existing
 *  note instead of creating a copy. Declared here, not in review.js, so a consumer of this file (Obsidian) never
 *  has the type checker reach into the review engine's JavaScript. */
/** One step as `sessions.view` reports it: same shape `sessions.js`'s `manifest`/`legacyView` build internally. */
export interface SessionStepView {
  id: StepId | string; input: StepInput; reads: ResultRef[]; at: string;
  status: "running" | "done" | "failed" | "cancelled" | "stopped";
  writes: ResultRef[]; error?: unknown;
}

export interface NoteSink {
  publish(note: { reviewId: string; title: string; markdown: string; frontMatter?: Record<string, unknown> }): Promise<{ path: string }>;
}

/** Host capabilities the core needs. Zotero implements it with Subprocess.sys.mjs, IOUtils, Zotero.Server; Node with child_process, fs, http. */
export type { Platform } from "./platform";

/** Composition roots. The only two constructors the hosts call. */
export declare function createLocalRuntime(deps: {
  platform: import("./platform").Platform;
  library: import("./tools").LibraryBackend;   // Zotero: local index + Zotero API; sidecar: Python agent routes (privacy.json applies)
  notes: NoteSink;                              // Zotero: local notes folder; sidecar: POST /ai-note on the Python server
  skills?: import("./skills").SkillSource;     // where skills live (the server's /skills routes); default: <dataDir>/skills
  dataDir: string;                             // chats/, reviews/, settings.json, codex-home/
  notesDir?: string;                           // the output notes folder; each chat is mirrored as Markdown in <notesDir>/chats
  secrets?: import("./secrets.js").SecretStore; // tests; default: the Keychain on a Mac, else <dataDir>/secrets.json (spec 020)
  clock?: () => number;                        // tests; default Date.now
  routines?: { isOwner?: () => boolean | Promise<boolean>; tickMs?: number; startupGraceMs?: number };
}): Promise<AgentService & { dispose(): Promise<void> }>;

export declare function createRemoteRuntime(transport: {
  request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown>;
  /** SSE on desktop (Node http, Zotero.HTTP); long-poll on the phone (requestUrl with ?after=seq). Same event log either way. */
  stream(path: string, after: number, signal?: AbortSignal): AsyncIterable<{ seq: number; data: unknown }>;
}): AgentService;

export interface OutsidePaperRow {
  title: string; authors: string[]; year: number | null; venue: string; doi: string | null; abstract: string;
  url: string | null; source: string; arxiv: string | null; citations: number | null;
}
