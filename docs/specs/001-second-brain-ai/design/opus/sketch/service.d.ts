// The one public surface. Every UI (Zotero tab, Obsidian view on desktop and phone) talks to an AgentService.
// Two implementations exist and the UI cannot tell them apart:
//   LocalRuntime  : the core in this process (Zotero standalone; the Node sidecar behind the server)
//   RemoteRuntime : an HTTP client of the sidecar, through the Python server (Obsidian always; Zotero when the server runs)
import type {
  AgentEvent, Sequenced, ConversationId, ConversationSummary, ConversationRecord, Attachment, WebMode, Role,
  ModelChoice, ProviderId, ProviderStatus, AskResult, Answer, ReviewId, ReviewRequest, ReviewProgress, Plan,
} from "./domain";
import type { McpServerConfig, McpServerReport } from "./tools";

export interface SendInput { text: string; attachments?: Attachment[]; web?: WebMode }

export interface AgentService {
  readonly where: "local" | "server";

  conversations: {
    list(): Promise<ConversationSummary[]>;
    load(id: ConversationId): Promise<ConversationRecord[]>;
    create(mode: "chat" | "ask"): Promise<ConversationId>;
    rename(id: ConversationId, title: string): Promise<void>;
    remove(id: ConversationId): Promise<void>;
    /** Streams one turn. Aborting the signal interrupts the provider; the stream then ends with failed{cancelled}.
     *  `after` resumes a stream this client lost (reconnect, phone waking up). */
    send(id: ConversationId, input: SendInput, opts?: { signal?: AbortSignal; after?: number }): AsyncIterable<Sequenced<AgentEvent>>;
  };

  /** One question, one answer, not stored as a conversation. Used by the "Ask about selection" commands. */
  ask(question: string, opts?: { attachments?: Attachment[]; web?: WebMode; signal?: AbortSignal }): AsyncIterable<AgentEvent<AskResult>>;

  reviews: {
    start(req: ReviewRequest): Promise<ReviewId>;
    /** Progress snapshots until the review is done, stopped or awaiting approval. Idempotent: resumes a stopped review. */
    watch(id: ReviewId, opts?: { signal?: AbortSignal }): AsyncIterable<ReviewProgress>;
    approvePlan(id: ReviewId, plan: Plan): Promise<void>;
    resume(id: ReviewId): Promise<void>;
    cancel(id: ReviewId): Promise<void>;
    list(): Promise<ReviewProgress[]>;
    export(id: ReviewId, format: "md" | "docx" | "pdf"): Promise<{ path: string }>;
  };

  providers: {
    status(): Promise<ProviderStatus[]>;
    models(provider: ProviderId): Promise<{ id: string; label: string; isDefault: boolean }[]>;
    signIn(provider: ProviderId, method: "browser" | "device_code" | { apiKey: string }): Promise<{ openUrl?: string; code?: string; done: Promise<ProviderStatus> }>;
    signOut(provider: ProviderId): Promise<void>;
    roles(): Promise<Record<Role, ModelChoice>>;
    setRole(role: Role, choice: ModelChoice): Promise<void>;
  };

  mcp: {
    list(): Promise<McpServerReport[]>;
    save(config: McpServerConfig): Promise<McpServerReport>;   // connects and lists tools: this is the "Test" button
    remove(name: string): Promise<void>;
  };
}

/** Host capabilities the core needs. Zotero implements it with Subprocess.sys.mjs, IOUtils, Zotero.Server; Node with child_process, fs, http. */
export type { Platform } from "./platform";

/** Composition roots. The only two constructors the hosts call. */
export declare function createLocalRuntime(deps: {
  platform: import("./platform").Platform;
  library: import("./tools").LibraryBackend;   // Zotero: local index + Zotero API; sidecar: Python agent routes (privacy.json applies)
  notes: import("./review").NoteSink;          // Zotero: local notes folder; sidecar: POST /ai-note on the Python server
  dataDir: string;                             // chats/, reviews/, settings.json, codex-home/
}): Promise<AgentService & { dispose(): Promise<void> }>;

export declare function createRemoteRuntime(transport: {
  request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown>;
  /** SSE on desktop (Node http, Zotero.HTTP); long-poll on the phone (requestUrl with ?after=seq). Same event log either way. */
  stream(path: string, after: number, signal?: AbortSignal): AsyncIterable<{ seq: number; data: unknown }>;
}): AgentService;
