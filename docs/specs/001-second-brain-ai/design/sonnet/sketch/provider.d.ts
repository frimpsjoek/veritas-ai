import type { AgentEvent } from "./events";
import type { ToolRegistry } from "./tools";

/** One turn's input. Attachments and history are resolved to plain text/refs before this boundary — providers
 *  never see an Obsidian TFile or a Zotero item. */
export interface TurnInput {
  text: string;
  attachments?: { label: string; text: string }[];
  outputSchema?: unknown;             // JSON schema, for structured stages (review plan/findings)
}

export interface ThreadOptions {
  model?: string;                     // absent = provider's account default
  effort?: "low" | "medium" | "high";
  webSearch?: "off" | "cached" | "live";
  systemPrompt: string;               // includes "notes/papers/web are untrusted data"
  tools: ToolRegistry;
}

/** A live conversation with one provider. One AgentThread per Chat conversation or per review sub-agent call. */
export interface AgentThread {
  readonly id: string;
  send(input: TurnInput): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

/** The one interface every provider implements, regardless of whether it drives its own loop (Codex, Claude Code)
 *  or needs ours (OpenAiCompatProvider + ToolLoopRunner). Callers hold an AgentProvider, never a CLI handle. */
export interface AgentProvider {
  readonly id: string;                // "codex" | "claude-code" | "openai-compat:<configured-name>"
  readonly kind: "cli-loop" | "in-process-loop";
  status(): Promise<ProviderStatus>;
  startThread(opts: ThreadOptions): Promise<AgentThread>;
}

export interface ProviderStatus {
  found: boolean;
  version?: string;
  signedIn: boolean;
  signInMethod?: "chatgpt" | "api-key" | "subscription" | "none";
  rateLimit?: { usedPercent: number; windowLabel: string };
  installGuideUrl?: string;           // shown instead of the AI buttons when !found
}

/** Isolation flags live inside these constructors only; nothing above AgentProvider can see or override them. */
export class CodexProvider implements AgentProvider {
  readonly id = "codex";
  readonly kind = "cli-loop";
  constructor(_opts: { binaryPath: string; codexHome: string /* dedicated, holds a copied auth.json only */ }) {
    throw new Error("not implemented");
  }
  status(): Promise<ProviderStatus> { throw new Error("not implemented"); }
  startThread(_opts: ThreadOptions): Promise<AgentThread> { throw new Error("not implemented"); }
  // internally: thread/start with sandbox:"read-only", approvalPolicy:"never", mcp_servers={} plus our
  // McpToolServer url, dynamicTools built from ToolRegistry.list(); always answers *requestApproval with decline.
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly id = "claude-code";
  readonly kind = "cli-loop";
  constructor(_opts: { binaryPath: string; mcpConfigPath: string /* points at our McpToolServer only */ }) {
    throw new Error("not implemented");
  }
  status(): Promise<ProviderStatus> { throw new Error("not implemented"); }
  startThread(_opts: ThreadOptions): Promise<AgentThread> { throw new Error("not implemented"); }
  // internally: claude -p --output-format stream-json --verbose --strict-mcp-config --mcp-config <ours>
  // --setting-sources "" --tools "" --allowedTools <derived from ToolRegistry.list()> --no-session-persistence
}

export class OpenAiCompatProvider implements AgentProvider {
  readonly kind = "in-process-loop";
  constructor(
    public readonly id: string,
    _opts: { baseUrl: string; apiKey?: string; model: string }
  ) { throw new Error("not implemented"); }
  status(): Promise<ProviderStatus> { throw new Error("not implemented"); }
  startThread(_opts: ThreadOptions): Promise<AgentThread> { throw new Error("not implemented"); }
  // internally: delegates every send() to ToolLoopRunner.run(thisEndpoint, tools, input)
}

/** The loop OpenAiCompatProvider brings, since chat-completions endpoints have none of their own. */
export interface ToolLoopRunner {
  run(endpoint: { baseUrl: string; apiKey?: string; model: string }, tools: ToolRegistry, input: TurnInput):
    AsyncIterable<AgentEvent>;
  // loop: request -> if tool_calls, ToolRegistry.call() each, emit tool_call started/completed, append results,
  // request again; else stream text deltas; stop on finish_reason or an interrupt() call recorded on an
  // AbortController threaded through from the AgentThread wrapper.
}
