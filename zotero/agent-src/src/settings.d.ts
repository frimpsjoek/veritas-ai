// agent-src/src/settings.js (T6.2). One persisted JSON record, owned by the runtime that holds `dataDir`
// (the sidecar's data dir in server mode, the Zotero data dir when standalone). TurnRunner resolves a role's
// model at call time (core.js), so a change here is visible to the very next turn: no restart (F1, criterion 10).
import type { Role, RoleChoices, ModelChoice, WebMode, ProviderId } from "./domain";
import type { McpServerConfig } from "./tools";

export interface Settings {
  roles: RoleChoices;
  endpoints: { name: string; baseUrl: string; key: string | null }[];       // OpenAI-compatible endpoints (oss:<name>)
  webSearchDefault: WebMode;
  /** spec 016: the one model for every role the user did not set. null = today's behaviour (first ready provider, model null). */
  defaultModel: ModelChoice | null;
  /** "claude:sonnet", "codex:gpt-5.5": the models the Answer-with menu lists under Cloud. */
  shownModels: string[];
  /** "Add a model ID…": exact IDs typed by the user. */
  addedModels: { provider: ProviderId; id: string }[];
  mcp: (McpServerConfig & { trustUnmarked?: boolean })[];
  // Per-role wall-clock cap (ms) and a per-turn tool-call budget, both overridable here; unset roles/fields fall
  // back to settings.js's DEFAULT_TURN_WALL_CLOCK_MS / DEFAULT_TOOL_CALL_BUDGET. See core.js's TurnRunner.
  turnLimits: { wallClockMs: Partial<Record<Role, number>>; toolCallBudget: number | null };
  /** spec 007 §5.2: caps on a columns step. Chat-driven steps over `askFirstRows` rows or `askFirstCells` cells ask
   *  first; `maxRows` is a hard cap per step. `concurrency` = extraction turns at once (default 3, never above 6). */
  research: { askFirstRows: number; askFirstCells: number; maxRows: number; concurrency: number };
  /** spec 010: the "On this Mac" provider. `python` null = ~/woof-bench/.venv/bin/python (arm64 venv; never PATH's python3). */
  local: LocalSettings;
  /** The user's free OpenAlex key (openalex.org/settings/api); null = the shared free limit. `limitUntil` is status only, filled by the runtime's settings.get. */
  openalex: { apiKey: string | null; limitUntil?: string | null };
  /** What a chat searches when the message does not say (Settings' Sources chips and the chat's source pills share it);
   *  `web` is on/off only; its mode is `webSearchDefault`. null = never chosen, read as DEFAULT_SOURCE_SWITCHES. A patch may name only some keys. */
  sources: SourceSwitches | null;
}

export interface SourceSwitches { papers: boolean; notes: boolean; scholarly: boolean; web: boolean }

/** What `settings.update` takes: any subset; a role set to `null` is cleared. */
export type SettingsPatch = Partial<Omit<Settings, "roles" | "local" | "sources">> & { roles?: Partial<Record<Role, ModelChoice | null>>; local?: Partial<LocalSettings>; sources?: Partial<SourceSwitches> | null };

export interface LocalSettings { scanDirs: string[]; idleMinutes: number; python: string | null; allowReports: boolean; external: boolean }

/** Pure: the settings patch that sets `defaultModel` to `choice` and clears (null) every role equal to it, so those roles read "Same as default". */
export declare function useOneDefault(settings: Pick<Settings, "roles">, choice: ModelChoice): { defaultModel: ModelChoice; roles: Record<string, null> };
export declare function defaultSettings(): Settings;
export declare const DEFAULT_TURN_WALL_CLOCK_MS: Record<Role, number>;
export declare const DEFAULT_TOOL_CALL_BUDGET: number;
export declare const DEFAULT_RESEARCH: Settings["research"];
export declare const DEFAULT_LOCAL: LocalSettings;
export declare const DEFAULT_SOURCE_SWITCHES: SourceSwitches;
/** Pure: the switches in force (saved, else the defaults). */
export declare function sourceSwitches(settings: { sources?: SourceSwitches | null }): SourceSwitches;
/** Roles an "On this Mac" model may serve without the Advanced switch. */
export declare const LOCAL_DEFAULT_ROLES: Role[];
/** Pure: the plain sentence when `choice` may not serve `role` (a local model on a report role without allowReports); null when fine. */
export declare function localRoleRefusal(role: Role, choice: ModelChoice | null | undefined, local: Pick<LocalSettings, "allowReports">): string | null;
/** Reads the `local` block straight from settings.json (fresh each call; defaults for anything missing). */
export declare function readLocalSettings(fs: import("./platform").Platform["fs"], dataDir: string): Promise<LocalSettings>;

/** The IDs typed with "Add a model ID…" for one provider, read fresh from settings.json. */
export declare function readAddedModels(fs: import("./platform").Platform["fs"], dataDir: string, provider: ProviderId): Promise<string[]>;

export interface SettingsStore {
  get(): Promise<Settings>;
  /** A role set to `null` in `patch.roles` is cleared ("Same as default"). */
  update(patch: SettingsPatch): Promise<Settings>;
  /** The saved custom endpoints (oss:<name>). */
  endpoints(): Promise<Settings["endpoints"]>;
  /** The default web mode for a message that does not say. */
  webDefault(): Promise<WebMode>;
  /** The source switches in force for a message that does not send `sources`. */
  sourceDefaults(): Promise<SourceSwitches>;
  roles(): Promise<RoleChoices>;
  roleModel(role: Role): Promise<ModelChoice>;
  /** `null` clears the role's override (back to the default model; for `extract`, the researcher's choice). */
  setRole(role: Role, choice: ModelChoice | null): Promise<Settings>;
  research(): Promise<Settings["research"]>;
  turnLimits(role: Role): Promise<{ wallClockMs: number; toolCallBudget: number }>;
  mcpServers(): Promise<Settings["mcp"]>;
  /** Returns the config as saved: keys the UI sent as `{ set: true }` are filled back in from the stored ones. */
  saveMcpServer(config: Settings["mcp"][number]): Promise<Settings["mcp"][number]>;
  removeMcpServer(name: string): Promise<Settings>;
}

export declare function createSettingsStore(fs: import("./platform").Platform["fs"], dataDir: string, opts?: { cloudDefault?: () => Promise<string | null>; secrets?: import("./secrets.js").SecretStore | null }): SettingsStore;

/** Server spec 020: what the UI gets in place of a key (the service's settings.get, the outside-source list).
 *  Sent back unchanged in an update, it means "keep the key". */
export interface KeyShown { set: true; last4: string }
/** Settings with every key replaced by KeyShown (typed as Settings: the UI reads key fields through keyState()). */
export declare function viewSettings<T>(settings: T): T;
export declare function viewMcpConfig<T>(config: T): T;
export declare function isSecretRef(v: unknown): boolean;
export declare function isKeptKey(v: unknown): boolean;
