// agent-src/src/catalog.js (T6.3). Static MCP server catalog data, sourced from research-mcp-catalog.md and
// re-verified against each repo's README (see catalog.js's own header comment for which entries and when).
import type { McpServerConfig } from "./tools";

export interface CatalogEntry {
  id: string;
  name: string;
  homepage: string;
  description: string;
  tier: "default" | "niche" | "optional";
  auth: string;
  /** Whether this entry's package name and stdio/http invocation were confirmed against the repo's own README
   *  this task (WebFetch), rather than carried over unverified from the research doc. */
  verified: boolean;
  /** A caveat the Settings UI shows next to the entry (e.g. "paid or limited", or a known config gap). */
  note?: string;
  config: McpServerConfig;
  /** What the Connect guide asks for (server spec 020 G3); absent = nothing to type. */
  setup?: Setup;
}

/** A `key` is secret (Keychain, never shown again); an `email` is not. `prefix` goes before what is pasted ("Bearer "). */
export interface SetupField { in: "env" | "header"; name: string; label: string; kind: "key" | "email"; optional?: boolean; prefix?: string }
export interface Setup { fields: SetupField[]; getKey?: { url: string; steps: string } }

export declare const MCP_CATALOG: CatalogEntry[];
export declare function catalogEntry(id: string): CatalogEntry | null;
/** The entry's config with what the user typed put in (trimmed, prefixed). */
export declare function applySetup(entry: CatalogEntry, values: Record<string, string>): McpServerConfig;
/** Labels of required fields still empty, and of emails that do not look like one. */
export declare function setupMissing(entry: CatalogEntry, values: Record<string, string>): string[];
