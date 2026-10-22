// @ts-check
// agent-src/src/settings.js (T6.2). One persisted JSON record, owned by the runtime: the sidecar's data dir in
// server mode, the Zotero data dir when standalone (same `dataDir` createLocalRuntime already takes). Every
// role, endpoint, MCP server and search preference lives in this one file so a Settings change is visible to
// the very next turn (core.js's TurnRunner resolves the model at call time, never at startup) without a
// restart, which is F1/criterion 10's whole point.
import { lastFour } from './secrets.js';

const FILE = 'settings.json';

/** @typedef {import("./domain").Role} Role */
/** @typedef {import("./domain").ModelChoice} ModelChoice */
/** @typedef {import("./domain").WebMode} WebMode */
/** @typedef {import("./tools").McpServerConfig} McpServerConfig */

/** `extract` is deliberately absent: unset means "the researcher's choice" (spec 007 §5.2), resolved in `roleModel`.
 *  @type {Record<Exclude<Role, "extract">, ModelChoice>} */
const DEFAULT_ROLES = {
  chat: { provider: 'codex', model: null },
  ask: { provider: 'codex', model: null },
  lead: { provider: 'codex', model: null },
  researcher: { provider: 'codex', model: null },
  writer: { provider: 'codex', model: null },
};

// A turn's own generation or tool loop must not require a human to notice and hand-cancel it: T7.1 found a lead's
// plan turn stream text for 16 minutes with no cap before someone cancelled it by hand (evidence/p7-t71-*). Chat
// and Ask are interactive (a person is watching); lead/researcher/writer run unattended inside a review and get
// more room, since a sub-question's research legitimately takes several tool calls.
/** @type {Record<Role, number>} */
export const DEFAULT_TURN_WALL_CLOCK_MS = {
  chat: 5 * 60_000,
  ask: 5 * 60_000,
  lead: 6 * 60_000,
  researcher: 8 * 60_000,
  writer: 8 * 60_000,
  extract: 3 * 60_000, // per batch turn (spec 007 §5.2)
};
// 25 stopped a legitimate library question with no answer at all (a real Codex turn made 26 calls, re-reading papers
// in parallel, 2026-09-29); 40 still ends a runaway loop long before the wall clock does. A user setting overrides it.
export const DEFAULT_TOOL_CALL_BUDGET = 40;
/** spec 007 §5.2 caps for a columns step. `concurrency` is extraction turns at once; core.js never lets it pass the
 *  slot pool's total (the Mac's 6-process limit). */
export const DEFAULT_RESEARCH = { askFirstRows: 50, askFirstCells: 200, maxRows: 400, concurrency: 3 };

/** spec 010. Scan folders are where this Mac keeps MLX models (the Content drive, then the usual HF cache); `python` null
 *  means the arm64 venv the benchmark used, resolved by the provider (the default python3 is x86_64 under Rosetta). */
export const DEFAULT_LOCAL = {
  scanDirs: ['/Volumes/Content/models', '/Volumes/Content/Offload/dev/cache/huggingface/hub', '~/.cache/huggingface/hub'],
  idleMinutes: 5, python: null, allowReports: false, external: true,
};
/** What a chat searches when nothing else says: the Sources chips in Settings and the chat's own source pills read and
 *  write this one record. `web` is only on/off; which mode it runs in (`webSearchDefault`) is Research's choice and never written
 *  from here. `null` in settings.json means never chosen, which reads as these. */
export const DEFAULT_SOURCE_SWITCHES = { papers: true, notes: true, scholarly: true, web: false };

/** @param {unknown} base @param {unknown} patch @returns {import("./settings").SourceSwitches | null} */
function mergeSources(base, patch) {
  if (patch === undefined) return /** @type {any} */ (base) ?? null;
  if (patch === null) return null;
  const from = { ...DEFAULT_SOURCE_SWITCHES, ...(/** @type {any} */ (base) ?? {}) };
  const p = /** @type {any} */ (patch);
  return {
    papers: typeof p.papers === 'boolean' ? p.papers : Boolean(from.papers),
    notes: typeof p.notes === 'boolean' ? p.notes : Boolean(from.notes),
    scholarly: typeof p.scholarly === 'boolean' ? p.scholarly : Boolean(from.scholarly),
    web: typeof p.web === 'boolean' ? p.web : Boolean(from.web),
    // optional: the Valency Bond connector's switch, kept only once set (absent means on)
    ...(typeof p.valency === 'boolean' ? { valency: p.valency } : typeof from.valency === 'boolean' ? { valency: from.valency } : {}),
  };
}

/** The switches in force: the saved ones, or the defaults when none were saved. @param {{ sources?: import("./settings").SourceSwitches | null }} settings */
export function sourceSwitches(settings) {
  return { ...DEFAULT_SOURCE_SWITCHES, ...(settings?.sources ?? {}) };
}

/** Roles a local model serves without the Advanced switch: grounded Q&A only (the user's benchmark, 2026-09-15). */
export const LOCAL_DEFAULT_ROLES = /** @type {import("./domain").Role[]} */ (['chat', 'ask']);

/** @param {import("./domain").Role} role @param {import("./domain").ModelChoice | null | undefined} choice @param {{ allowReports: boolean }} local */
export function localRoleRefusal(role, choice, local) {
  if (choice?.provider !== 'local' || local.allowReports || LOCAL_DEFAULT_ROLES.includes(role)) return null;
  return 'On this Mac models only answer questions in Chat and Ask. Pick Codex or Claude Code for reports in Settings.';
}

/** @param {unknown} patch @returns {import("./settings").LocalSettings} */
function mergeLocal(base, patch) {
  const out = { ...DEFAULT_LOCAL, ...(base ?? {}), ...(patch ?? {}) };
  out.scanDirs = Array.isArray(out.scanDirs) ? out.scanDirs.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim()) : [...DEFAULT_LOCAL.scanDirs];
  const minutes = Number(out.idleMinutes);
  out.idleMinutes = Number.isFinite(minutes) && minutes >= 1 ? Math.min(240, Math.round(minutes)) : DEFAULT_LOCAL.idleMinutes;
  out.allowReports = out.allowReports === true;
  out.external = out.external !== false;
  out.python = typeof out.python === 'string' && out.python.trim() ? out.python.trim() : null;
  return out;
}

/**
 * @typedef {{
 *   roles: import("./domain").RoleChoices,
 *   endpoints: { name: string, baseUrl: string, key: string | null }[],
 *   webSearchDefault: WebMode,
 *   defaultModel: ModelChoice | null,
 *   shownModels: string[],
 *   addedModels: { provider: import("./domain").ProviderId, id: string }[],
 *   mcp: (McpServerConfig & { trustUnmarked?: boolean })[],
 *   turnLimits: { wallClockMs: Partial<Record<Role, number>>, toolCallBudget: number | null },
 *   research: { askFirstRows: number, askFirstCells: number, maxRows: number, concurrency: number },
 *   local: import("./settings").LocalSettings,
 *   openalex: { apiKey: string | null },
 *   sources: import("./settings").SourceSwitches | null,
 * }} Settings
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    roles: { ...DEFAULT_ROLES }, endpoints: [], webSearchDefault: 'off', defaultModel: null, shownModels: [], addedModels: [], mcp: [],
    turnLimits: { wallClockMs: {}, toolCallBudget: null },
    research: { ...DEFAULT_RESEARCH },
    local: mergeLocal(null, null),
    openalex: { apiKey: null },
    sources: null,
  };
}

/** Fills in anything a partially-written or older settings.json is missing, rather than replacing it outright:
 *  a Settings UI that only ever calls `update()` with a subset can't accidentally drop the rest. */
/** A null role in a patch (`update({ roles: { extract: null } })`) clears it, the same as setRole(role, null). */
function dropNullRoles(roles) {
  return /** @type {import("./domain").RoleChoices} */ (Object.fromEntries(Object.entries(roles).filter(([, v]) => v !== null)));
}

/** @param {unknown} key */
const cleanKey = (key) => (typeof key === 'string' && key.trim() ? key.trim() : null);

// ---------------------------------------------------------------- keys (server spec 020)
// On disk a key is a reference, `{ secret: "openalex", last4: "a1b2" }`; the value lives in the secret store
// (secrets.js). In memory it is the plain string, for the code that uses it. What the UI gets is `{ set: true,
// last4 }` (viewSettings); a value like that sent back means "keep the key I have".
const SECRET_ENV = /(key|token|secret|password)/i;
const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key)$|key|token|secret/i;
const slug = (/** @type {string} */ text) => String(text).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'x';
/** @param {any} v */
export const isSecretRef = (v) => Boolean(v && typeof v === 'object' && typeof v.secret === 'string');
/** @param {any} v */
export const isKeptKey = (v) => Boolean(v && typeof v === 'object' && v.set === true);

/** Every key a settings object holds: its secret name, and how to read and write it in place.
 *  @param {any} s @returns {{ name: string, get: () => any, put: (v: any) => void }[]} */
function keyFields(s) {
  const out = [];
  if (s?.openalex) out.push({ name: 'openalex', get: () => s.openalex.apiKey, put: (v) => { s.openalex.apiKey = v; } });
  for (const e of Array.isArray(s?.endpoints) ? s.endpoints : []) {
    if (e && 'key' in e) out.push({ name: `endpoint:${slug(e.name)}`, get: () => e.key, put: (v) => { e.key = v; } });
  }
  for (const c of Array.isArray(s?.mcp) ? s.mcp : []) out.push(...mcpKeyFields(c));
  return out;
}

/** @param {any} c an outside source's config */
function mcpKeyFields(c) {
  const out = [];
  for (const [bag, test] of /** @type {const} */ ([['env', SECRET_ENV], ['headers', SECRET_HEADER]])) {
    const values = c?.[bag];
    if (!values || typeof values !== 'object') continue;
    for (const k of Object.keys(values)) {
      if (test.test(k)) out.push({ name: `mcp:${slug(c.name)}:${bag === 'env' ? 'env' : 'header'}:${slug(k)}`, get: () => values[k], put: (v) => { values[k] = v; } });
    }
  }
  return out;
}

/** @param {any} v */
const shown = (v) => (typeof v === 'string' && v ? { set: true, last4: lastFour(v) } : isSecretRef(v) ? { set: true, last4: v.last4 ?? '' } : v ?? null);

/** Settings as the UI may see them: every key replaced by `{ set: true, last4 }`. @template T @param {T} settings @returns {T} */
export function viewSettings(settings) {
  const copy = structuredClone(settings);
  for (const f of keyFields(copy)) f.put(shown(f.get()));
  return copy;
}

/** One outside source's config as the UI may see it. @template T @param {T} config @returns {T} */
export function viewMcpConfig(config) {
  const copy = structuredClone(config);
  for (const f of mcpKeyFields(copy)) f.put(shown(f.get()));
  return copy;
}

/** Puts back the keys the UI could not send (it only has `{ set: true }`): from `current`, matched by name.
 *  @param {any} incoming @param {any} current same shape (an outside source's config, or an endpoint) */
function keepKeys(incoming, current, fields) {
  const now = new Map(current ? fields(current).map((/** @type {any} */ f) => [f.name, f.get()]) : []);
  for (const f of fields(incoming)) if (isKeptKey(f.get())) f.put(now.get(f.name) ?? null);
  return incoming;
}

/** @param {unknown} v @returns {ModelChoice | null} */
function cleanChoice(v) {
  const c = /** @type {any} */ (v);
  if (!c || typeof c.provider !== 'string') return null;
  return { provider: c.provider, model: typeof c.model === 'string' && c.model ? c.model : null, ...(c.effort ? { effort: c.effort } : {}) };
}
/** @param {unknown} v */
const uniqueStrings = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x))] : []);
/** @param {unknown} v @returns {{ provider: import("./domain").ProviderId, id: string }[]} */
function cleanAdded(v) {
  const seen = new Set();
  return (Array.isArray(v) ? v : []).flatMap((a) => {
    const id = typeof a?.id === 'string' ? a.id.trim() : '';
    if (!id || typeof a?.provider !== 'string' || seen.has(`${a.provider}:${id}`)) return [];
    seen.add(`${a.provider}:${id}`);
    return [{ provider: a.provider, id }];
  });
}

/** spec 016 "Use one default for everything": the patch that sets `defaultModel` and clears every role that already
 *  equals it, so those roles read "Same as default". A patch, not a Settings: `update` merges, and a cleared role is `null`.
 *  @param {Pick<Settings, "roles">} settings @param {ModelChoice} choice
 *  @returns {{ defaultModel: ModelChoice, roles: Record<string, null> }} */
export function useOneDefault(settings, choice) {
  const same = (/** @type {ModelChoice} */ a) => a.provider === choice.provider && (a.model ?? null) === (choice.model ?? null) && (a.effort ?? null) === (choice.effort ?? null);
  const roles = Object.fromEntries(Object.entries(settings.roles ?? {}).filter(([, c]) => c && same(c)).map(([r]) => [r, null]));
  return { defaultModel: choice, roles };
}

function merge(base, patch) {
  return {
    roles: dropNullRoles({ ...base.roles, ...(patch.roles ?? {}) }),
    endpoints: patch.endpoints ?? base.endpoints,
    webSearchDefault: patch.webSearchDefault ?? base.webSearchDefault,
    defaultModel: patch.defaultModel !== undefined ? cleanChoice(patch.defaultModel) : (base.defaultModel ?? null),
    shownModels: patch.shownModels !== undefined ? uniqueStrings(patch.shownModels) : (base.shownModels ?? []),
    addedModels: patch.addedModels !== undefined ? cleanAdded(patch.addedModels) : (base.addedModels ?? []),
    mcp: patch.mcp ?? base.mcp,
    turnLimits: {
      wallClockMs: { ...base.turnLimits?.wallClockMs, ...(patch.turnLimits?.wallClockMs ?? {}) },
      toolCallBudget: patch.turnLimits?.toolCallBudget !== undefined ? patch.turnLimits.toolCallBudget : (base.turnLimits?.toolCallBudget ?? null),
    },
    research: { ...DEFAULT_RESEARCH, ...(base.research ?? {}), ...(patch.research ?? {}) },
    local: mergeLocal(base.local, patch.local),
    openalex: { apiKey: patch.openalex?.apiKey !== undefined ? cleanKey(patch.openalex.apiKey) : (base.openalex?.apiKey ?? null) },
    sources: mergeSources(base.sources, patch.sources),
  };
}

/** The `local` block straight from settings.json, fresh on every call, so the provider never holds a stale copy of what
 *  the runtime's own store just wrote. @param {import("./platform").Platform["fs"]} fs @param {string} dataDir */
export async function readLocalSettings(fs, dataDir) {
  try {
    const text = await fs.read(`${dataDir}/${FILE}`);
    return mergeLocal(null, text ? JSON.parse(text).local : null);
  } catch { return mergeLocal(null, null); }
}

/** The `addedModels` ("Add a model ID…") for one provider, straight from settings.json, fresh on every call like
 *  `readLocalSettings`, so a model the user just added is listed without the provider holding a copy.
 *  @param {import("./platform").Platform["fs"]} fs @param {string} dataDir @param {import("./domain").ProviderId} provider */
export async function readAddedModels(fs, dataDir, provider) {
  try {
    const text = await fs.read(`${dataDir}/${FILE}`);
    return cleanAdded(text ? JSON.parse(text).addedModels : []).filter((a) => a.provider === provider).map((a) => a.id);
  } catch { return []; }
}

/**
 * @param {import("./platform").Platform["fs"]} fs
 * @param {string} dataDir
 * @param {{ cloudDefault?: () => Promise<string | null>, secrets?: import("./secrets.js").SecretStore | null }} [opts] `secrets`: where
 *   keys live (secrets.js); without it keys stay in the file, as before hidden-keys (tests, old callers). `cloudDefault`: the first cloud provider that is ready
 *   (Codex, then Claude Code), used for a role the user never chose, so a Mac without Codex does not default to it.
 *   A role saved in settings.json is never replaced.
 */
export function createSettingsStore(fs, dataDir, opts = {}) {
  const path = `${dataDir}/${FILE}`;
  const secrets = opts.secrets ?? null;
  /** Secret names this file refers to, so a key the user removed is removed from the store too. @type {Set<string>} */
  const stored = new Set();
  /** @type {Settings | null} */
  let cached = null;
  let loading = null;
  /** The roles the user (or a Settings change) actually set; the rest are defaults, resolved at read time. @type {Set<string>} */
  const chosen = new Set();

  /** @param {import("./domain").RoleChoices} roles */
  async function withDefaults(roles, settings = cached) {
    const missing = Object.keys(DEFAULT_ROLES).filter((r) => !chosen.has(r));
    const chosenDefault = settings?.defaultModel ?? null;
    // A local default does not reach the report roles unless the user allowed it; those fall back to today's default.
    const fits = (r) => chosenDefault && !localRoleRefusal(/** @type {Role} */ (r), chosenDefault, settings?.local ?? DEFAULT_LOCAL);
    const rest = missing.filter((r) => !fits(r));
    const provider = rest.length ? await opts.cloudDefault?.().catch(() => null) : null;
    return {
      ...DEFAULT_ROLES,
      ...roles,
      ...Object.fromEntries(missing.filter(fits).map((r) => [r, { ...chosenDefault }])),
      ...(provider ? Object.fromEntries(rest.map((r) => [r, { provider, model: null }])) : {}),
    };
  }

  async function load() {
    if (cached) return cached;
    if (!loading) {
      loading = (async () => {
        const text = await fs.read(path);
        const saved = text ? JSON.parse(text) : null;
        for (const role of Object.keys(saved?.roles ?? {})) chosen.add(role);
        // References become values from the store; a key still written out in full (before hidden-keys) moves there.
        let plain = false;
        for (const f of keyFields(saved)) {
          const v = f.get();
          if (isSecretRef(v)) { stored.add(v.secret); f.put(secrets ? await secrets.get(v.secret).catch(() => null) : null); }
          else if (typeof v === 'string' && v) plain = true;
        }
        cached = saved ? merge(defaultSettings(), saved) : defaultSettings();
        if (secrets && plain) await persist(cached);
        return cached;
      })();
    }
    return loading;
  }

  /** @param {Settings} next @param {string[]} [touched] roles this change set */
  async function persist(next, touched = []) {
    for (const role of touched) chosen.add(role);
    cached = next;
    // Only chosen roles are written: saving a search preference must not freeze today's default provider into the file.
    const roles = Object.fromEntries(Object.entries(next.roles).filter(([role]) => chosen.has(role)));
    const out = structuredClone({ ...next, roles });
    if (secrets) {
      const kept = new Set();
      for (const f of keyFields(out)) {
        const v = f.get();
        if (typeof v === 'string' && v) { await secrets.set(f.name, v); kept.add(f.name); f.put({ secret: f.name, last4: lastFour(v) }); }
        else f.put(null);
      }
      for (const name of stored) if (!kept.has(name)) await secrets.remove(name).catch(() => {});
      stored.clear();
      for (const name of kept) stored.add(name);
    }
    await fs.writeAtomic(path, JSON.stringify(out, null, 2), { private: true });
    return next;
  }

  return {
    async get() { const s = await load(); return { ...s, roles: await withDefaults(s.roles, s) }; },
    /** A role set to `null` is cleared: it reads "Same as default" again. @param {Record<string, any>} patch */
    async update(patch) {
      const current = await load();
      if (isKeptKey(patch.openalex?.apiKey)) { const { apiKey: _kept, ...rest } = patch.openalex; patch = { ...patch, openalex: rest }; }
      if (Array.isArray(patch.endpoints)) {
        const fields = (/** @type {any} */ e) => keyFields({ endpoints: [e] });
        patch = { ...patch, endpoints: patch.endpoints.map((e) => keepKeys(structuredClone(e), current.endpoints.find((c) => c.name === e.name), fields)) };
      }
      if (Array.isArray(patch.mcp)) patch = { ...patch, mcp: patch.mcp.map((c) => keepKeys(structuredClone(c), current.mcp.find((m) => m.name === c.name), mcpKeyFields)) };
      const entries = Object.entries(patch.roles ?? {});
      for (const [role, v] of entries) if (v === null) chosen.delete(role);
      return persist(merge(await load(), patch), entries.filter(([, v]) => v !== null).map(([role]) => role));
    },
    /** The default web mode for a message that does not say (spec 016 S3). Reads the file only: no provider status calls. */
    async endpoints() { return (await load()).endpoints; },
    async webDefault() { return (await load()).webSearchDefault; },
    async sourceDefaults() { return sourceSwitches(await load()); },

    /** `extract` is `null` while unset (the UI's "Default"); `roleModel('extract')` then follows the researcher. */
    async roles() { const s = await load(); const roles = await withDefaults(s.roles, s); return { ...roles, extract: roles.extract ?? null }; },
    /** @param {Role} role */
    async roleModel(role) {
      const s = await load();
      const roles = await withDefaults(s.roles, s);
      if (role === 'extract') return roles.extract ?? roles.researcher ?? DEFAULT_ROLES.researcher;
      return roles[role] ?? DEFAULT_ROLES[role];
    },
    /** `null` clears the override ("Same as default"). @param {Role} role @param {ModelChoice | null} choice */
    async setRole(role, choice) {
      const s = await load();
      const refusal = localRoleRefusal(role, choice, s.local);
      if (refusal) throw Object.assign(new Error(refusal), { kind: 'model_unavailable' });
      if (choice === null) {
        const { [role]: _dropped, ...rest } = s.roles;
        chosen.delete(role);
        return persist({ ...s, roles: rest });
      }
      return persist({ ...s, roles: { ...s.roles, [role]: choice } }, [role]);
    },

    /** @param {Role} role @returns {Promise<{ wallClockMs: number, toolCallBudget: number }>} */
    async turnLimits(role) {
      const s = await load();
      return {
        wallClockMs: s.turnLimits.wallClockMs[role] ?? DEFAULT_TURN_WALL_CLOCK_MS[role],
        // Extraction turns get their text from our code and run with no tools at all (spec 007 §5.2); core.js
        // enforces that through ToolContext.none, so this 0 is informational there.
        toolCallBudget: role === 'extract' ? 0 : (s.turnLimits.toolCallBudget ?? DEFAULT_TOOL_CALL_BUDGET),
      };
    },

    async research() { return (await load()).research; },

    async mcpServers() { return (await load()).mcp; },
    /** @param {McpServerConfig & { trustUnmarked?: boolean }} config */
    async saveMcpServer(config) {
      const s = await load();
      const full = keepKeys(structuredClone(config), s.mcp.find((c) => c.name === config.name), mcpKeyFields);
      const mcp = [...s.mcp.filter((c) => c.name !== config.name), full];
      await persist({ ...s, mcp });
      return full;
    },
    /** @param {string} name */
    async removeMcpServer(name) {
      const s = await load();
      return persist({ ...s, mcp: s.mcp.filter((c) => c.name !== name) });
    },
  };
}
