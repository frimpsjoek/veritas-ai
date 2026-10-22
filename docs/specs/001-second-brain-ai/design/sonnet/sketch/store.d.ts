export interface ChatEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  toolCalls?: { tool: string; args: unknown; result?: unknown }[];
  sources?: { kind: "note" | "zotero" | "web"; ref: string }[];
  providerId: string;
  ts: string;                         // ISO 8601
}

export interface ConversationSummary { id: string; title: string; updatedAt: string; providerId: string }

/** JSONL per conversation, append-only. Exactly one instance of this interface should ever be the live writer for
 *  a given conversation id at one time — see rationale.md's "one writer per store instance" invariant. */
export interface ConversationStore {
  append(conversationId: string, entry: ChatEntry): Promise<void>;
  read(conversationId: string): Promise<ChatEntry[]>;
  list(): Promise<ConversationSummary[]>;
  rename(conversationId: string, title: string): Promise<void>;
  delete(conversationId: string): Promise<void>;
}

/** Zotero-standalone only. Lives at <Zotero data dir>/second-brain/chats/. Stops being written to the moment the
 *  server becomes reachable — Zotero then talks to RemoteCore instead (see core.d.ts). */
export class LocalConversationStore implements ConversationStore {
  constructor(_dir: string) { throw new Error("not implemented"); }
  append(_conversationId: string, _entry: ChatEntry): Promise<void> { throw new Error("not implemented"); }
  read(_conversationId: string): Promise<ChatEntry[]> { throw new Error("not implemented"); }
  list(): Promise<ConversationSummary[]> { throw new Error("not implemented"); }
  rename(_conversationId: string, _title: string): Promise<void> { throw new Error("not implemented"); }
  delete(_conversationId: string): Promise<void> { throw new Error("not implemented"); }
}

/** Server-side, owned by the sidecar. Canonical whenever the server runs: Obsidian (desktop + mobile) and
 *  Zotero-with-server all read/write through this instance only, via RemoteCore. */
export class ServerConversationStore implements ConversationStore {
  constructor(_dataDir: string /* ~/obsidian-kb/data/chats */) { throw new Error("not implemented"); }
  append(_conversationId: string, _entry: ChatEntry): Promise<void> { throw new Error("not implemented"); }
  read(_conversationId: string): Promise<ChatEntry[]> { throw new Error("not implemented"); }
  list(): Promise<ConversationSummary[]> { throw new Error("not implemented"); }
  rename(_conversationId: string, _title: string): Promise<void> { throw new Error("not implemented"); }
  delete(_conversationId: string): Promise<void> { throw new Error("not implemented"); }
}

/** Runs once, at server (sidecar) startup. Copies in any Zotero-local JSONL files not already present in the
 *  canonical store — never merges byte-for-byte, matching the existing local-notes adoption pattern. Idempotent:
 *  a conversation id already present is skipped, so running it twice after a crash is safe (per
 *  make-operations-idempotent). */
export function adoptLocalConversations(
  _zoteroChatsDir: string,
  _target: ServerConversationStore
): Promise<{ adopted: number }> {
  throw new Error("not implemented");
}
