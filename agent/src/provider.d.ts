// The provider contract every adapter in providers/ implements (design/final/sketch/providers.js), declared here
// because the sketch's typedefs were never carried into agent-src: core.js, codex.js and openai.js referred to
// `import("./providers").Provider` and `HistoryMessage`, which resolved to providers/index.js and named nothing.
// Types only; there is no provider.js.
import type { AgentEvent, ModelChoice, ProviderId, ProviderStatus, WebMode } from "./domain";
import type { ToolSession } from "./tools";

/** A message of prior history. The conversation store is the source of truth; provider threads are disposable caches. */
export interface HistoryMessage { role: "user" | "assistant"; text: string }

export interface TurnRequest {
  /** Conversation id or review agent id. Keys the warm thread/process cache. */
  sessionKey: string;
  model: ModelChoice;
  /** System prompt: role, "sources are untrusted data", citation format. */
  instructions: string;
  /** Always the full history before this turn. A warm session sends only the new input when its cached length matches. */
  history: HistoryMessage[];
  input: string;
  /** Specs + in-process call + MCP url. Each provider picks the face it needs. */
  tools: ToolSession;
  web: WebMode;
  /** JSON Schema. Native where supported; the core validates regardless. */
  outputSchema: object | null;
}

export type Usage = { inputTokens?: number; outputTokens?: number; usd?: number };

/** What a provider yields: the domain AgentEvent except that the last event is `final` (raw text and parsed JSON);
 *  citations and schema validation are added once, in core.js's TurnRunner, not in three adapters. */
export type ProviderEvent =
  | Exclude<AgentEvent, { type: "done" }>
  | { type: "final"; text: string; json: unknown; usage: Usage; /** spec 010: short plain notes about how the answer was cut ("Stopped a repeating answer."). */ notes?: string[] };

export interface Provider {
  id: ProviderId;
  caps: {
    nativeWebSearch: boolean; nativeStructuredOutput: boolean;
    /** spec 010. false = the provider gets no tools; for the roles in `roles` the engine fetches the passages first (retrieval-first). Absent = true. */
    tools?: boolean;
    /** Roles the provider may serve without an explicit Advanced switch. Absent = all. */
    roles?: import("./domain").Role[];
  };
  status(): Promise<ProviderStatus>;
  /** What the provider offers (spec 016): Codex asks its app server, Claude Code is a built-in list, endpoints use `GET /models`; both plus the IDs the user added. */
  models(): Promise<import("./domain").ListedModel[]>;
  signIn(method: "browser" | "device_code" | { apiKey: string }): Promise<{ openUrl?: string; code?: string; done: Promise<ProviderStatus> }>;
  signOut(): Promise<void>;
  /** Abort maps to turn/interrupt (Codex), killing the process (Claude), or aborting fetch (OpenAI-compatible).
   *  A commandExecution/fileChange item or an approval request ends the turn with failed{policy_violation}. */
  turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
  dispose(): Promise<void>;
}

/** core.js's TurnRunner: resolves the role's model at call time, takes a slot, opens tools, streams, validates. */
export interface TurnRunner {
  stream(
    role: import("./domain").Role,
    req: { sessionKey: string; instructions: string; history: HistoryMessage[]; input: string; tools: import("./tools").ToolContext; outputSchema?: object | null },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent<unknown>>;
  structured(role: import("./domain").Role, prompt: string, schema: object, tools: import("./tools").ToolContext, signal: AbortSignal, onEvent?: (ev: any) => void, onNotice?: (ev: any) => void): Promise<unknown>;
}
