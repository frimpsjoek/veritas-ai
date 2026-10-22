import type { ToolResult, SourceRef } from "./events";

/** A tool as every provider needs to see it. `readOnlyHint` is required, not optional-with-default: spike 2 found
 *  Codex refuses a tool call under approvalPolicy "never" without it, so a registry that compiled without the
 *  field would be a registry that silently breaks under one provider. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;               // JSON schema
  annotations: { readOnlyHint: true }; // literal true — a tool that isn't read-only doesn't belong in this registry
}

export interface ToolCallContext {
  conversationId?: string;
  reviewId?: string;
  clientKind: "agent";                // stamped on every host call so server-side privacy.json filtering applies
}

/** One registry per host process (Zotero, server, sidecar). Populated once at startup from that host's own
 *  backing (Zotero's local index, or the server's kb.py + privacy.json), plus any enabled user MCP servers merged
 *  in by ToolRegistry.mergeExternal(). This is the single source of truth every transport reads from — no
 *  transport keeps its own copy of the tool list. */
export interface ToolRegistry {
  list(): ToolSpec[];
  call(name: string, args: unknown, ctx: ToolCallContext): Promise<ToolResult>;
  mergeExternal(server: McpServerConfig): Promise<{ added: ToolSpec[]; rejected: RejectedTool[] }>;
}

export interface RejectedTool {
  name: string;
  reason: "missing-read-only-hint" | "duplicate-name" | "invalid-schema";
}

export function createToolRegistry(_backing: {
  searchLibrary(args: unknown, ctx: ToolCallContext): Promise<ToolResult>;
  readSource(args: unknown, ctx: ToolCallContext): Promise<ToolResult>;
  searchScholarly(args: unknown, ctx: ToolCallContext): Promise<ToolResult>;
}): ToolRegistry {
  throw new Error("not implemented");
}

// --- Transport: how a registry becomes reachable by a CLI that only speaks MCP (Claude Code, user MCP clients) ---

/** The seam that lets Zotero and the server share one MCP surface implementation while differing only in how
 *  bytes get to a socket. Codex does not use this — it gets DynamicToolBridge instead. */
export interface ServerTransport {
  listen(port: number): Promise<{ url: string }>;
  onRequest(handler: (body: unknown) => Promise<unknown>): void;
  close(): Promise<void>;
}

/** Confirmed by spike 2: works for both Claude Code and Codex's own MCP path (not just dynamicTools) against a
 *  streamable-HTTP JSON-RPC surface. Used inside the server process, riding http_api.py's ThreadingHTTPServer. */
export class NodeHttpTransport implements ServerTransport {
  listen(_port: number): Promise<{ url: string }> { throw new Error("not implemented"); }
  onRequest(_handler: (body: unknown) => Promise<unknown>): void { throw new Error("not implemented"); }
  close(): Promise<void> { throw new Error("not implemented"); }
}

/** Confirmed by spike 2: Zotero.Server.Endpoints (port 23119) accepted a streamable-HTTP MCP POST from both CLIs
 *  in standalone Zotero. No Node involved — this is the only transport Zotero standalone can host. */
export class ZoteroServerTransport implements ServerTransport {
  constructor(_opts: { path: string /* e.g. "/second-brain/mcp" */ }) { throw new Error("not implemented"); }
  listen(_port: number): Promise<{ url: string }> { throw new Error("not implemented"); }
  onRequest(_handler: (body: unknown) => Promise<unknown>): void { throw new Error("not implemented"); }
  close(): Promise<void> { throw new Error("not implemented"); }
}

/** MCP protocol (initialize, tools/list, tools/call) over a ToolRegistry, independent of transport. */
export class McpToolServer {
  constructor(_registry: ToolRegistry, _transport: ServerTransport) { throw new Error("not implemented"); }
  start(_port: number): Promise<{ url: string }> { throw new Error("not implemented"); }
  stop(): Promise<void> { throw new Error("not implemented"); }
}

/** Codex's own path: no network hop, answers item/tool/call directly. */
export class DynamicToolBridge {
  constructor(_registry: ToolRegistry) { throw new Error("not implemented"); }
  /** Called by CodexProvider when it receives a server request `item/tool/call`. */
  handle(_params: { tool: string; arguments: unknown; callId: string }): Promise<{
    contentItems: { type: "inputText"; text: string }[];
    success: boolean;
  }> { throw new Error("not implemented"); }
}

// --- User-added MCP servers (Settings) ---

export interface McpServerConfig {
  name: string;
  transport: { kind: "stdio"; command: string; args: string[]; env?: Record<string, string> }
           | { kind: "http"; url: string };
  enabled: boolean;
}

/** Settings' "test" action. Surfaces per-tool readOnlyHint status so the UI can mark tools that "won't work with
 *  Codex" instead of listing them as if they were fully usable everywhere. */
export function testMcpServer(_cfg: McpServerConfig): Promise<{
  reachable: boolean;
  tools: (ToolSpec | { name: string; missingReadOnlyHint: true })[];
}> {
  throw new Error("not implemented");
}
