// The only vocabulary the UI, the citation validator and review stages consume. Every provider parses its own
// wire format into this union at the boundary (per boundary-discipline); nothing downstream imports a wire type.

/** Where a value came from, so the UI can render "not found in your library" instead of inventing a citation. */
export type SourceRef =
  | { kind: "note"; path: string }
  | { kind: "zotero"; citekey: string }
  | { kind: "web"; url: string };

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | {
      type: "tool_call";
      phase: "started" | "completed";
      callId: string;
      tool: string;
      args?: unknown;                 // present on "started"
      result?: ToolResult;            // present on "completed"
      ok?: boolean;                   // present on "completed"
    }
  | { type: "web_search"; phase: "started" | "completed"; query: string; resultCount?: number }
  | { type: "usage"; costUsd?: number; rateLimit?: RateLimitInfo }
  | { type: "turn_completed"; stopReason: "end" | "interrupted" | "error"; sources: SourceRef[] }
  | { type: "error"; message: string; recoverable: boolean };

export interface RateLimitInfo {
  windowLabel: string;                // e.g. "5h" — provider-defined, shown verbatim
  usedPercent: number;
  resetsAt?: string;                  // ISO 8601
}

export interface ToolResult {
  ok: boolean;
  contentText?: string;               // what the model sees
  sources?: SourceRef[];              // what the citation validator checks against
  error?: string;
}

/** Never constructed by callers; the seam that would leak a wire format is exactly this function's absence. */
export function parseCodexNotification(_raw: unknown): AgentEvent {
  throw new Error("not implemented");
}
export function parseClaudeStreamJsonLine(_raw: string): AgentEvent | null {
  throw new Error("not implemented");
}
