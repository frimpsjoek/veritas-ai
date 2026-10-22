import type { AgentEvent } from "./events";
import type { ReviewEvent, ReviewSpec } from "./review";
import type { ConversationSummary } from "./store";

export interface UserMessage { text: string; attachments?: { label: string; text: string }[] }
export interface ChatOptions { providerId: string; model?: string; webSearch?: "off" | "cached" | "live" }
export interface AskOptions extends ChatOptions {}
export interface AskResult { text: string; sources: { kind: string; ref: string }[]; found: boolean }

export interface ReviewHandle { id: string }
export type Unsubscribe = () => void;

/** The one facade every host imports. Two concrete backings share this interface exactly — callers never branch
 *  on which one they got; SecondBrainCore.forHost() decides once, at construction. */
export interface SecondBrainCore {
  openConversation(seed?: { itemKey?: string; notePath?: string }): Promise<ConversationSummary>;
  listConversations(): Promise<ConversationSummary[]>;
  renameConversation(id: string, title: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  chat(conversationId: string, message: UserMessage, opts: ChatOptions): AsyncIterable<AgentEvent>;
  ask(question: string, opts: AskOptions): Promise<AskResult>;
  interrupt(conversationId: string): Promise<void>;

  startReview(spec: ReviewSpec): Promise<ReviewHandle>;
  resumeReview(reviewId: string): Promise<ReviewHandle>;
  subscribeReview(reviewId: string, onEvent: (e: ReviewEvent) => void): Unsubscribe;
  cancelReview(reviewId: string): Promise<void>;
}

export type HostRole = "zotero" | "obsidian";

export const SecondBrainCore = {
  /** Picks EmbeddedCore when this process can host the core (Zotero always; Obsidian desktop always) and a
   *  RemoteCore only actually dials out when a server is configured and reachable — otherwise EmbeddedCore runs
   *  solo. Obsidian mobile has no EmbeddedCore option and always gets RemoteCore. */
  forHost(_opts: {
    role: HostRole;
    dataDir?: string;                 // Zotero: <Zotero data dir>/second-brain
    remoteUrl?: string;                // server base URL, if configured
    token?: string;                    // bearer token for remote
    platform?: "desktop" | "mobile";   // Obsidian only
  }): SecondBrainCore {
    throw new Error("not implemented");
  },
};

/** Owns providers, a ToolRegistry, a ConversationStore and (if this process runs reviews) a ParallelCap. Used by
 *  Zotero always, and by Obsidian desktop when no server is reachable or for the interactive Chat/Ask path. */
export class EmbeddedCore implements SecondBrainCore {
  openConversation(_seed?: unknown): Promise<ConversationSummary> { throw new Error("not implemented"); }
  listConversations(): Promise<ConversationSummary[]> { throw new Error("not implemented"); }
  renameConversation(_id: string, _title: string): Promise<void> { throw new Error("not implemented"); }
  deleteConversation(_id: string): Promise<void> { throw new Error("not implemented"); }
  chat(_conversationId: string, _message: UserMessage, _opts: ChatOptions): AsyncIterable<AgentEvent> {
    throw new Error("not implemented");
  }
  ask(_question: string, _opts: AskOptions): Promise<AskResult> { throw new Error("not implemented"); }
  interrupt(_conversationId: string): Promise<void> { throw new Error("not implemented"); }
  startReview(_spec: ReviewSpec): Promise<ReviewHandle> { throw new Error("not implemented"); }
  resumeReview(_reviewId: string): Promise<ReviewHandle> { throw new Error("not implemented"); }
  subscribeReview(_reviewId: string, _onEvent: (e: ReviewEvent) => void): Unsubscribe {
    throw new Error("not implemented");
  }
  cancelReview(_reviewId: string): Promise<void> { throw new Error("not implemented"); }
}

/** A thin SSE/REST client of agent_api.py, talking to the sidecar's EmbeddedCore on the other end. Used by
 *  Obsidian mobile always, and by Obsidian desktop / Zotero whenever a server is reachable (so chat/review state
 *  is shared and the parallel cap has one owner, per rationale.md). */
export class RemoteCore implements SecondBrainCore {
  constructor(_opts: { baseUrl: string; token?: string }) { throw new Error("not implemented"); }
  openConversation(_seed?: unknown): Promise<ConversationSummary> { throw new Error("not implemented"); }
  listConversations(): Promise<ConversationSummary[]> { throw new Error("not implemented"); }
  renameConversation(_id: string, _title: string): Promise<void> { throw new Error("not implemented"); }
  deleteConversation(_id: string): Promise<void> { throw new Error("not implemented"); }
  chat(_conversationId: string, _message: UserMessage, _opts: ChatOptions): AsyncIterable<AgentEvent> {
    throw new Error("not implemented");   // GET/POST + SSE to /agent/chat, re-parsed back into AgentEvent
  }
  ask(_question: string, _opts: AskOptions): Promise<AskResult> { throw new Error("not implemented"); }
  interrupt(_conversationId: string): Promise<void> { throw new Error("not implemented"); }
  startReview(_spec: ReviewSpec): Promise<ReviewHandle> { throw new Error("not implemented"); }
  resumeReview(_reviewId: string): Promise<ReviewHandle> { throw new Error("not implemented"); }
  subscribeReview(_reviewId: string, _onEvent: (e: ReviewEvent) => void): Unsubscribe {
    throw new Error("not implemented");   // SSE to /agent/review/:id/events
  }
  cancelReview(_reviewId: string): Promise<void> { throw new Error("not implemented"); }
}
