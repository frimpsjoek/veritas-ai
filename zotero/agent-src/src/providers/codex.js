// @ts-check
// agent-src/src/providers/codex.js
// The Codex app-server adapter. Tools reach Codex over MCP (thread/start.config.mcp_servers), the P0-reconciled
// face shared with Claude Code (grounding.md P0 spike 2: dynamicTools is gone, per-thread MCP config is honoured).
// codexLaunch and codexHomePlan are pure; ensureCodexHome is the one place that touches the filesystem, and it is
// idempotent so a second run never clobbers a real auth.json or re-signs anyone out.

import { rateLimitNotice } from './usage.js';
import { readAddedModels } from '../settings.js';

/** @typedef {import("../platform").Platform} Platform */
/** @typedef {import("../platform").SpawnSpec} SpawnSpec */

// code_mode_host lets Codex write JavaScript that calls our tools through an `exec` item instead of calling them
// directly (T7.1's transcript audit: all 86 real tool calls went through this path, evidence/p7-t71-criterion6-
// transcript-scan.txt). Setting `features.code_mode_host = false` here was tried and reverted: two live runs
// through dev/ask.mjs against real Codex 0.155.0-alpha.16 both failed closed instead of falling back to a direct
// mcpToolCall -- the model saw the "Code Mode is unavailable" warning, never retried with a direct call, and
// answered "the library tools are unavailable in this session" (evidence/fix-codemode.txt). So the gateway's own
// read-only boundary (scanCodeModeExec, below) is what keeps exec safe, not turning it off.
const CONFIG_TOML = '[features]\napps = false\nplugins = false\nmemories = false\n';

/** Binary lookup order (spec.md assumption 2): a settings path, then CODEX_BINARY, then the ChatGPT.app bundle, then PATH. */
export function binaryCandidates(setting, env = {}) {
  return [setting, env.CODEX_BINARY, '/Applications/ChatGPT.app/Contents/Resources/codex', 'codex'].filter(Boolean);
}

/** Where the private CODEX_HOME lives and what it needs to contain. Pure: describes the plan, does no I/O. */
export function codexHomePlan(dataDir, home) {
  const dir = `${dataDir}/codex-home`;
  return {
    dir,
    configTomlPath: `${dir}/config.toml`,
    configToml: CONFIG_TOML,
    // A symlink, not a copy, so a token refresh Codex performs on the real file is visible here too (verified P0.1).
    authSymlink: { from: `${home}/.codex/auth.json`, to: `${dir}/auth.json` },
  };
}

/**
 * Creates the private CODEX_HOME if needed. Idempotent: re-running never overwrites a symlink or file that is
 * already correct, so a concurrent caller or a prior real sign-in through Settings is never clobbered.
 * @param {Platform["fs"]} fs
 * @param {ReturnType<typeof codexHomePlan>} plan
 */
export async function ensureCodexHome(fs, plan) {
  const currentConfig = await fs.read(plan.configTomlPath);
  if (currentConfig !== plan.configToml) await fs.writeAtomic(plan.configTomlPath, plan.configToml);
  const authAlreadyThere = (await fs.read(plan.authSymlink.to)) !== null;
  if (!authAlreadyThere) {
    try {
      await fs.symlink(plan.authSymlink.from, plan.authSymlink.to);
    } catch (error) {
      // Lost a race with another caller, or the user's own ~/.codex/auth.json doesn't exist yet (not signed in).
      // Either way this isn't fatal here; codex itself will report signed_out.
    }
  }
}

/**
 * Pure: the argv, the env (CODEX_HOME only; the caller's platform.spawn merges it into the process env) and the
 * thread/start params. No I/O, so it is unit-testable without a filesystem.
 * @param {{ binary: string, dataDir: string, home: string, cwd?: string, mcpUrl: string, mcpToken: string,
 *           model?: string | null, effort?: import("../domain").Effort | null, webMode?: "off" | "cached" | "live" | null }} opts
 */
export function codexLaunch(opts) {
  const homePlan = codexHomePlan(opts.dataDir, opts.home);
  const cwd = opts.cwd ?? opts.dataDir;
  /** @type {SpawnSpec} */
  const spec = { cmd: opts.binary, args: ['app-server'], env: { CODEX_HOME: homePlan.dir }, cwd };
  const threadStart = {
    cwd,
    ephemeral: true,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    model: opts.model ?? null,
    config: {
      // A per-session bearer token in the MCP server config maps every tool call back to this turn's ToolContext.
      // bearer_token is rejected for streamable_http ("bearer_token is not supported for streamable_http") on
      // codex-cli 0.155.0-alpha.16, so the token travels as a plain header instead (grounding.md's P0 spike 4
      // already put it in Authorization for the Zotero.Server face; this is the same header on the Codex side).
      mcp_servers: { lib: { url: opts.mcpUrl, http_headers: { Authorization: `Bearer ${opts.mcpToken}` } } },
      // Top-level `web_search` ("cached" | "live"). codex-cli 0.155.0-alpha.16 rejects `tools.web_search = "live"`
      // ("did not match any variant of untagged enum WebSearchToolConfigInput") and fails the whole turn.
      ...(opts.webMode && opts.webMode !== 'off' ? { web_search: opts.webMode } : {}),
    },
  };
  return { spec, homePlan, threadStart, effort: opts.effort ?? null };
}

/**
 * Pure: turns `codex login status`'s plain text into a ProviderStatus account/state. Real lines seen on
 * codex-cli 0.155.0-alpha.16: "Logged in using ChatGPT", "Logged in using an API key", "Not logged in". Found
 * live (not in a fixture): codex-cli prints this to stderr, not stdout, when stdout isn't a tty (every spawned
 * case) -- so the caller passes both `lines` (stdout) and `stderrTail` (stderr) here, and both are checked.
 * @param {string[]} lines @param {string} [stderrTail]
 */
export function parseCodexLoginStatus(lines, stderrTail = '') {
  const text = `${lines.join('\n')}\n${stderrTail}`;
  if (/not logged in/i.test(text)) return { state: /** @type {const} */ ('signed_out'), account: { kind: /** @type {const} */ ('none'), label: null, plan: null } };
  if (/logged in using chatgpt/i.test(text)) return { state: /** @type {const} */ ('ready'), account: { kind: /** @type {const} */ ('chatgpt'), label: null, plan: null } };
  if (/logged in using an? api key/i.test(text)) return { state: /** @type {const} */ ('ready'), account: { kind: /** @type {const} */ ('api_key'), label: null, plan: null } };
  return { state: /** @type {const} */ ('signed_out'), account: { kind: /** @type {const} */ ('none'), label: null, plan: null } };
}

/** Runs a plain codex subcommand (not app-server) against the private CODEX_HOME, and collects its stdout lines.
 *  Used for `login status`/`login`/`logout` and `--version`, none of which speak JSON-RPC. */
async function runCodexCli(platform, binary, dataDir, home, args) {
  const homePlan = codexHomePlan(dataDir, home);
  await ensureCodexHome(platform.fs, homePlan);
  const child = await platform.spawn({ cmd: binary, args, env: { CODEX_HOME: homePlan.dir }, cwd: dataDir });
  const lines = [];
  for await (const line of child.lines()) lines.push(line);
  const code = await child.exited;
  return { code, lines, stderr: child.stderrTail() };
}

/** The `effort` field of the app server's turn/start. Codex names low, medium, high and xhigh; Claude's "max" is its
 *  highest, so it maps to xhigh. Anything else is left out so the thread keeps its own default instead of failing the turn.
 *  @param {string | null | undefined} effort @returns {"low" | "medium" | "high" | "xhigh" | undefined} */
export function codexTurnEffort(effort) {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort;
  return effort === 'max' ? 'xhigh' : undefined;
}

const CODEX_EFFORTS = /** @type {import("../domain").Effort[]} */ (['low', 'medium', 'high']);

/**
 * Pure: maps one `model/list` page from the app server to ProviderModels. The app server's model entry carries
 * `id`/`model`, `displayName`, `description`, `supportedReasoningEfforts: [{ reasoningEffort, description }]`,
 * `isDefault` and `hidden`; every field is read defensively (alternative spellings, strings or objects), because this
 * was written without a real Codex to record from. Hidden entries and entries with no id are dropped.
 * @param {any} result the JSON-RPC `result` @returns {{ models: import("../domain").ProviderModel[], next: string | null }}
 */
export function mapCodexModelList(result) {
  const list = Array.isArray(result) ? result : (result?.data ?? result?.models ?? result?.items ?? []);
  const known = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'minimal']);
  const models = (Array.isArray(list) ? list : []).flatMap((m) => {
    const id = typeof m === 'string' ? m : (m?.model ?? m?.id);
    if (typeof id !== 'string' || !id || m?.hidden === true) return [];
    const raw = m?.supportedReasoningEfforts ?? m?.supported_reasoning_efforts ?? m?.reasoningEfforts ?? [];
    const efforts = (Array.isArray(raw) ? raw : []).map((e) => (typeof e === 'string' ? e : (e?.reasoningEffort ?? e?.effort ?? e?.id)))
      .filter((e) => typeof e === 'string' && known.has(e) && e !== 'minimal');
    const label = [m?.displayName, m?.display_name, m?.name].find((v) => typeof v === 'string' && v) ?? id;
    const hint = typeof m?.description === 'string' && m.description.trim() ? m.description.trim() : null;
    return [{ id, label, hint, efforts: /** @type {import("../domain").Effort[]} */ ([...new Set(efforts)]), source: /** @type {const} */ ('provider'), isDefault: m?.isDefault === true }];
  });
  const next = result?.nextCursor ?? result?.next_cursor ?? null;
  return { models, next: typeof next === 'string' && next ? next : null };
}

/** Asks a short-lived `codex app-server` for `model/list` (initialize, initialized, then the paged request) and always
 *  ends the process. Throws on a timeout or a JSON-RPC error; the caller decides what that means.
 *  @param {Platform} platform @param {{ spec: import("../platform").SpawnSpec, homePlan: any }} launch @param {number} timeoutMs */
async function codexListModels(platform, launch, timeoutMs) {
  await ensureCodexHome(platform.fs, launch.homePlan);
  const child = await platform.spawn(launch.spec);
  let timer;
  try {
    const write = (msg) => child.write(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    const read = (async () => {
      /** @type {import("../domain").ProviderModel[]} */
      const out = [];
      let nextId = 1;
      const request = (method, params) => { nextId += 1; return write({ id: nextId, method, params }).then(() => nextId); };
      let waiting = 1;
      await write({ id: 1, method: 'initialize', params: { clientInfo: { name: 'second-brain', version: '0' }, capabilities: { experimentalApi: true } } });
      for await (const line of child.lines()) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== waiting || (msg.result === undefined && !msg.error)) continue;
        if (msg.error) throw new Error(msg.error.message ?? 'model/list failed');
        if (waiting === 1) {
          await write({ method: 'initialized', params: {} });
          waiting = await request('model/list', {});
          continue;
        }
        const page = mapCodexModelList(msg.result);
        out.push(...page.models);
        if (!page.next || out.length > 500) return out;
        waiting = await request('model/list', { cursor: page.next });
      }
      throw new Error('The Codex app server ended before it listed its models.');
    })();
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Codex did not list its models in time.')), timeoutMs); });
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
    await child.kill().catch(() => {});
  }
}

/** @param {string} name @returns {import("../domain").ActivityKind} */
const TOOL_KIND = (name) => {
  if (name === 'search_library') return 'library';
  if (name === 'read_source') return 'read';
  if (name === 'search_scholarly') return 'scholarly';
  if (name === 'web_search') return 'web';
  if (name === 'read_result') return 'result';
  return 'mcp';
};

function activityLabel(tool, args) {
  const q = args?.query ?? args?.q ?? '';
  switch (tool) {
    case 'search_library': return `Searching your papers for "${q}"`;
    case 'read_source': return `Reading ${args?.title ?? args?.ref ?? 'a source'}`;
    case 'search_scholarly': return `Searching the literature for "${q}"`;
    case 'web_search': return `Searching the web for "${q}"`;
    // This is the fallback label only. The event also carries `tool`/`args`, so activity.js's compactActivities
    // resolves the precise "Referenced "title" Vn" wording (spec 007 §1.5) from the turn's own session manifest.
    case 'read_result': return `Referenced result ${args?.result ?? ''}`;
    default: return `Using ${tool}`;
  }
}

// Disabling code_mode_host was tried and reverted (see the CONFIG_TOML comment above): it made real Codex runs
// fail closed instead of falling back to a direct mcpToolCall. This is the fallback the task asked for instead --
// code-mode `exec` (model-written JavaScript) stays allowed, but only when every call inside it targets our own
// read-only gateway. It mirrors dev/scan-transcripts.mjs's own offline audit of the same boundary (that script
// greps the SQLite trace log's "ToolCall: exec <body>" text for this exact pattern), applied live instead of
// after the fact. The wire item's own field names for the code body weren't pinned down against a live capture
// (two real dev/ask.mjs runs this session both used direct mcpToolCall, never code mode), so this stringifies the
// whole item rather than reading one named field, and the check degrades safely either way: a call this can't see
// is also a call scan-transcripts.mjs's own offline audit (a required nightly/CI check) would still catch.
const EXEC_BEYOND_GATEWAY = /tools\.(?!mcp__lib__)[A-Za-z_]\w*|\brequire\(|\bimport\(|\bprocess\.|child_process|\bfs\.|\bDeno\./;

/** @param {any} item @returns {boolean} true if this code-mode exec item's body calls anything besides our own `tools.mcp__lib__*` rows. */
function execEscapesGateway(item) {
  return EXEC_BEYOND_GATEWAY.test(JSON.stringify(item));
}

/** True for a Codex "code mode" tool item: model-written JavaScript run through `exec`, as opposed to a direct
 *  `mcpToolCall`. Matches the app-server's own camelCase item-type convention (`mcpToolCall`, `commandExecution`,
 *  `fileChange`) and the `custom_tool_call`/`exec` names the trace log (`otel.name`, `ToolCall: exec ...`) uses. */
function isCodeModeExec(item) {
  return item?.type === 'customToolCall' && item?.tool === 'exec';
}

/** Cleans a stderr tail before it ever reaches a user: rmcp transport trace and prompt echoes are noise, not signal. */
export function cleanStderr(tail) {
  return (tail || '')
    .split('\n')
    .filter((line) => line && !/rmcp::|^\s*\[?(TRACE|DEBUG)\]?/.test(line))
    .slice(-5)
    .join('\n')
    .trim();
}

/**
 * Maps one Codex app-server JSON-RPC message to zero or more domain-shaped provider events. Pure: fed recorded
 * or synthesized transcripts in node:test. `commandExecution`, `fileChange` and any `*requestApproval` end the
 * turn with failed{policy_violation}, which is what makes success criterion 6 a runtime guarantee.
 * @returns {import("../provider").ProviderEvent[]}
 */
export function parseCodexMessage(msg) {
  if (!msg || typeof msg !== 'object') return [];
  if (msg.error && !msg.method) {
    return [{ type: 'failed', error: { kind: 'provider_crashed', message: msg.error.message ?? 'Codex reported an error.' } }];
  }
  const method = msg.method;
  if (!method) return [];
  const p = msg.params ?? {};

  if (msg.id != null && /requestapproval$/i.test(method)) {
    return [{ type: 'failed', error: { kind: 'policy_violation', message: 'Codex asked for approval to act; approvals are refused automatically.' } }];
  }

  switch (method) {
    case 'item/agentMessage/delta':
      return p.delta ? [{ type: 'text', delta: p.delta }] : [];

    case 'item/started': {
      const item = p.item;
      if (item?.type === 'mcpToolCall') {
        return [{ type: 'activity', id: item.id, phase: 'start', kind: TOOL_KIND(item.tool), label: activityLabel(item.tool, item.arguments), tool: item.tool, args: item.arguments }];
      }
      if (isCodeModeExec(item) && execEscapesGateway(item)) {
        return [{ type: 'failed', error: { kind: 'policy_violation', message: 'Codex ran code-mode JavaScript that reached beyond the library tools; the turn was stopped.' } }];
      }
      if (isCodeModeExec(item)) {
        return [{ type: 'activity', id: item.id, phase: 'start', kind: 'mcp', label: 'Running a tool script' }];
      }
      return [];
    }

    case 'item/completed': {
      const item = p.item;
      if (item?.type === 'mcpToolCall') {
        return [{ type: 'activity', id: item.id, phase: 'end', kind: TOOL_KIND(item.tool), label: activityLabel(item.tool, item.arguments), ok: !item.error, tool: item.tool, args: item.arguments }];
      }
      if (item?.type === 'commandExecution' || item?.type === 'fileChange') {
        const what = item.type === 'commandExecution' ? 'run a command' : 'edit a file';
        return [{ type: 'failed', error: { kind: 'policy_violation', message: `Codex tried to ${what}; the turn was stopped.` } }];
      }
      // Code mode (model-written JavaScript run through `exec`) is allowed only when every call inside it
      // targets our own read-only gateway (`tools.mcp__lib__*`); anything else ends the turn the same way a
      // command or file edit does. See EXEC_BEYOND_GATEWAY above.
      if (isCodeModeExec(item) && execEscapesGateway(item)) {
        return [{ type: 'failed', error: { kind: 'policy_violation', message: 'Codex ran code-mode JavaScript that reached beyond the library tools; the turn was stopped.' } }];
      }
      if (isCodeModeExec(item)) {
        return [{ type: 'activity', id: item.id, phase: 'end', kind: 'mcp', label: 'Running a tool script', ok: !item.error }];
      }
      // Reasoning summary items (spec 007 §3.1): confirmed live shape (rollout log + codex-mcp-tool.jsonl fixture,
      // both real captures) is `{ type: "reasoning", summary: [{ type: "summary_text", text }], content: [...] }`.
      // The app-server has no delta for these today, so the whole summary is forwarded at once on completion; a
      // Codex build that sends none (summary and content both empty) emits no event.
      if (item?.type === 'reasoning') {
        const text = [...(item.summary ?? []), ...(item.content ?? [])]
          .map((s) => (typeof s === 'string' ? s : s?.text))
          .filter(Boolean)
          .join('\n\n');
        return text ? [{ type: 'reasoning', delta: text }] : [];
      }
      return [];
    }

    case 'turn/completed': {
      const turn = p.turn ?? {};
      if (turn.status === 'interrupted' || turn.error?.type === 'interrupted') {
        return [{ type: 'failed', error: { kind: 'cancelled', message: 'Interrupted.' } }];
      }
      if (turn.error) {
        return [{ type: 'failed', error: { kind: 'provider_crashed', message: turn.error.message ?? 'Codex reported an error.' } }];
      }
      const items = turn.items ?? [];
      const final = [...items].reverse().find((it) => it.type === 'agentMessage');
      return [{ type: 'final', text: final?.text ?? '', json: null, usage: {} }];
    }

    case 'account/rateLimits/updated': {
      const rl = p.rateLimits?.primary;
      if (!rl) return [];
      const hours = Math.round((rl.windowDurationMins ?? 0) / 60) || 1;
      return [rateLimitNotice({ text: `Codex: ${rl.usedPercent}% of the ${hours}h window used`, percentUsed: Number(rl.usedPercent) || 0, windowMinutes: Number(rl.windowDurationMins) || 300, resetsAt: rl.resetsAt })];
    }

    case 'error': {
      // The real shape nests one level deeper than the protocol summary suggests: params.error.message, not
      // params.message (observed live against 0.155.0-alpha.16; params.message is kept as a fallback).
      const message = p.error?.message ?? p.message ?? 'Codex reported an error.';
      return [{ type: 'failed', error: { kind: 'provider_crashed', message } }];
    }

    default:
      return [];
  }
}

const MAX_WARM = 3;
const IDLE_MS = 10 * 60 * 1000;

/**
 * Small pool of warm Codex threads, one per sessionKey, mirroring claude.js's `createWarmPool`: the store is
 * the source of truth (design rule), so a cached entry is a disposable optimization, never load-bearing. An
 * entry also carries `seenLen`, the length of `req.history` the thread has already been shown; a turn reuses
 * the thread only when that matches the incoming turn's `history.length` exactly, so a store rebuild, a
 * skipped turn, or any other drift falls back to a fresh thread rather than silently diverging from the store.
 * @param {{ max?: number, idleMs?: number, kill?: (child: import("../platform").ChildProcess) => Promise<void>, now?: () => number,
 *           schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>, clear?: (timer: ReturnType<typeof setTimeout>) => void }} [opts]
 */
export function createCodexPool({ max = MAX_WARM, idleMs = IDLE_MS, kill = async () => {}, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), clear = (t) => clearTimeout(t) } = {}) {
  const entries = new Map(); // sessionKey -> { child, threadId, seenLen, idCounter, lastUsed, timer }

  function touch(sessionKey) {
    const entry = entries.get(sessionKey);
    if (!entry) return;
    entry.lastUsed = now();
    clear(entry.timer);
    entry.timer = schedule(() => evict(sessionKey), idleMs);
  }

  function evict(sessionKey) {
    const entry = entries.get(sessionKey);
    if (!entry) return;
    entries.delete(sessionKey);
    clear(entry.timer);
    kill(entry.child).catch(() => {});
  }

  function evictLru() {
    let oldestKey = null;
    let oldest = Infinity;
    for (const [key, entry] of entries) {
      if (entry.lastUsed < oldest) { oldest = entry.lastUsed; oldestKey = key; }
    }
    if (oldestKey != null) evict(oldestKey);
  }

  return {
    get(sessionKey) { return entries.get(sessionKey) ?? null; },
    set(sessionKey, entry) {
      // A turn re-sets an existing key's entry (its seenLen moved on), not just first-time creation; clear
      // that entry's old idle timer first, or the replaced timer object leaks and never fires clearTimeout,
      // keeping the process alive for a full idleMs even after this pool is disposed.
      const existing = entries.get(sessionKey);
      if (existing) clear(existing.timer);
      else if (entries.size >= max) evictLru();
      entries.set(sessionKey, { ...entry, lastUsed: now(), timer: schedule(() => evict(sessionKey), idleMs) });
    },
    touch,
    evict,
    size() { return entries.size; },
    async disposeAll() {
      for (const key of [...entries.keys()]) evict(key);
    },
  };
}

/**
 * Pure: what a fresh thread (no warm cache to lean on) needs sent as its single turn input, so a conversation's
 * earlier turns still reach the model even though this thread never saw them itself. A warm, matching thread
 * skips this entirely and gets only the new message, since the thread already remembers everything.
 * @param {import("../provider").HistoryMessage[]} history @param {string} input
 */
export function formatCodexInput(history, input) {
  if (!history || !history.length) return input;
  const transcript = history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`).join('\n\n');
  return `Earlier in this conversation:\n\n${transcript}\n\n---\n\nNow continue the conversation. Respond to this next message:\n\n${input}`;
}

/**
 * The Provider. `turn()` reuses a warm thread per sessionKey when its `seenLen` matches the incoming turn's
 * history (the common case: the same conversation, one turn after another, nothing evicted it in between).
 * Otherwise it spawns a fresh thread and replays the conversation as text (`formatCodexInput`), since a Codex
 * thread has no API to seed prior turns without triggering a model response for each one. Approval requests
 * are declined automatically over the wire, matching approvalPolicy "never".
 * @param {Platform} platform
 * @param {{ binaryPath: string | null, dataDir: string, home: string }} settings
 * @returns {import("../provider").Provider}
 */
export function codexProvider(platform, settings) {
  const pool = createCodexPool({ kill: (child) => child.kill() });

  async function resolveBinary() {
    return platform.which(binaryCandidates(settings.binaryPath, process.env ?? {}));
  }

  /** @returns {Promise<import("../domain").ProviderStatus>} */
  async function status() {
    const binary = await resolveBinary();
    if (!binary) {
      return { provider: 'codex', state: 'missing', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: 'Install ChatGPT.app or the codex CLI, then sign in.' };
    }
    // `codex login status` is the exact command criterion 10's own verify step checks the UI against.
    // Real-account usage (rate limits) needs an app-server account/read round trip this pass didn't build a
    // verified client for; left null rather than guessed (P6 rationale entry: a documented gap, not silent).
    const [versionResult, loginResult] = await Promise.all([
      runCodexCli(platform, binary, settings.dataDir, settings.home, ['--version']).catch(() => null),
      runCodexCli(platform, binary, settings.dataDir, settings.home, ['login', 'status']).catch(() => null),
    ]);
    const version = versionResult?.lines?.[0]?.replace(/^codex-cli\s+/, '') ?? null;
    if (!loginResult) return { provider: 'codex', state: 'unreachable', version, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null };
    const parsed = parseCodexLoginStatus(loginResult.lines, loginResult.stderr);
    return { provider: 'codex', state: parsed.state, version, account: parsed.account, usage: null, installHelp: parsed.state === 'signed_out' ? 'Sign in with your ChatGPT account or an API key.' : null };
  }

  return {
    id: /** @type {const} */ ('codex'),
    caps: { nativeWebSearch: true, nativeStructuredOutput: true },

    status,

    /** Codex's own list (`model/list` on the app server) plus the IDs the user added; [] when Codex is not installed.
     *  If the app server cannot answer (signed out, too old), the added IDs alone are listed. */
    async models() {
      const binary = await resolveBinary();
      if (!binary) return [];
      const launch = codexLaunch({ binary, dataDir: settings.dataDir, home: settings.home, mcpUrl: '', mcpToken: '' });
      /** @type {import("../domain").ProviderModel[]} */
      const listed = await codexListModels(platform, launch, 10_000).catch(() => []);
      const known = new Set(listed.map((m) => m.id));
      const added = (await readAddedModels(platform.fs, settings.dataDir, 'codex')).filter((id) => !known.has(id));
      return [...listed, ...added.map((id) => ({ id, label: id, hint: null, efforts: [...CODEX_EFFORTS], source: /** @type {const} */ ('added'), isDefault: false }))];
    },

    /** `browser`/`device_code`: `codex login` on its own starts the ChatGPT browser flow and blocks until it
     *  completes or is cancelled; `--device-auth` is the device-code variant. Both print the URL (and, for
     *  device auth, the code) to stdout before blocking, which is what `openUrl`/`code` below come from.
     *  `{ apiKey }`: `codex login --with-api-key`, key piped on stdin. Real account state, never exercised here
     *  without the user's explicit go-ahead (ask-first, per this task's own rule). */
    async signIn(method) {
      const binary = await resolveBinary();
      if (!binary) throw new Error('Codex is not installed.');
      const homePlan = codexHomePlan(settings.dataDir, settings.home);
      await ensureCodexHome(platform.fs, homePlan);
      if (typeof method === 'object' && method.apiKey) {
        const child = await platform.spawn({ cmd: binary, args: ['login', '--with-api-key'], env: { CODEX_HOME: homePlan.dir }, cwd: settings.dataDir });
        await child.write(method.apiKey);
        await child.kill(); // stdin isn't a tty here; closing it the same way piping would signals EOF
        const code = await child.exited;
        if (code !== 0) throw new Error(cleanStderr(child.stderrTail()) || 'codex login --with-api-key failed.');
        return { done: Promise.resolve(await status()) };
      }
      const args = method === 'device_code' ? ['login', '--device-auth'] : ['login'];
      const child = await platform.spawn({ cmd: binary, args, env: { CODEX_HOME: homePlan.dir }, cwd: settings.dataDir });
      /** @type {string | undefined} */
      let openUrl;
      /** @type {string | undefined} */
      let code;
      const done = (async () => {
        for await (const line of child.lines()) {
          const urlMatch = line.match(/https?:\/\/\S+/);
          const codeMatch = line.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
          if (urlMatch && !openUrl) openUrl = urlMatch[0];
          if (codeMatch && !code) code = codeMatch[1];
        }
        const exitCode = await child.exited;
        if (exitCode !== 0) throw new Error(cleanStderr(child.stderrTail()) || 'codex login failed or was cancelled.');
        return status();
      })();
      // Give the process a moment to print the URL/code before returning them alongside the still-running `done`.
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { openUrl, code, done };
    },

    async signOut() {
      const binary = await resolveBinary();
      if (!binary) return;
      await runCodexCli(platform, binary, settings.dataDir, settings.home, ['logout']).catch(() => {});
    },

    async *turn(req, signal) {
      const binary = await resolveBinary();
      if (!binary) {
        yield { type: 'failed', error: { kind: 'not_installed', message: 'Codex is not installed. Install ChatGPT.app or the codex CLI.' } };
        return;
      }

      const poolKey = req.sessionKey;
      const cached = pool.get(poolKey);
      const reuse = !!cached && cached.seenLen === req.history.length;
      if (cached && !reuse) pool.evict(poolKey); // drift from the store: drop the stale thread, start clean.

      const launch = codexLaunch({
        binary,
        dataDir: settings.dataDir,
        home: settings.home,
        mcpUrl: req.tools.mcp.url,
        mcpToken: req.tools.mcp.token,
        model: req.model?.model ?? null,
        effort: req.model?.effort ?? null,
        webMode: req.web,
      });

      let child, threadId, idCounter;
      if (reuse) {
        ({ child, threadId } = cached);
        idCounter = cached.idCounter;
      } else {
        await ensureCodexHome(platform.fs, launch.homePlan);
        child = await platform.spawn(launch.spec);
        threadId = null;
        idCounter = 0;
      }

      const send = async (method, params) => {
        idCounter += 1;
        await child.write(JSON.stringify({ jsonrpc: '2.0', id: idCounter, method, params }));
        return idCounter;
      };
      const notify = (method, params) => child.write(JSON.stringify({ jsonrpc: '2.0', method, params }));

      // turn/interrupt needs the turn's id as well as the thread's: without it Codex answers "Invalid request:
      // missing field `turnId`" and keeps generating (found live, T7.1: a Cancel became provider_crashed). The id
      // comes from turn/start's reply or the turn/started notification; before either, there is no turn to
      // interrupt, so stopping means ending the process.
      let turnId = null;
      const onAbort = () => {
        if (turnId) send('turn/interrupt', { threadId, turnId }).catch(() => {});
        else child.kill().catch(() => {});
      };
      signal.addEventListener('abort', onAbort);

      const inputText = reuse ? req.input : formatCodexInput(req.history, req.input);
      let cacheable = false;
      let nextSeenLen = req.history.length;

      try {
        if (reuse) {
          await send('turn/start', { threadId, input: [{ type: 'text', text: inputText }], effort: codexTurnEffort(launch.effort), outputSchema: req.outputSchema ?? undefined });
        } else {
          await send('initialize', { clientInfo: { name: 'second-brain', version: '0' }, capabilities: { experimentalApi: true } });
          await notify('initialized', {});
          await send('thread/start', {
            cwd: launch.threadStart.cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
            model: launch.threadStart.model, config: launch.threadStart.config,
            developerInstructions: req.instructions || undefined,
          });
        }

        let ended = false;
        for await (const line of child.lines()) {
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (process.env.SECOND_BRAIN_DEBUG_CODEX) process.stderr.write(`RAW: ${line}\n`);

          if (!reuse && msg.id === 2 && msg.result?.thread) {
            threadId = msg.result.thread.id;
            await send('turn/start', { threadId, input: [{ type: 'text', text: inputText }], effort: codexTurnEffort(launch.effort), outputSchema: req.outputSchema ?? undefined });
            continue;
          }

          const startedTurn = msg.result?.turn?.id ?? (msg.method === 'turn/started' ? msg.params?.turn?.id : null);
          if (startedTurn) turnId = startedTurn;

          if (msg.id != null && typeof msg.method === 'string' && /requestapproval$/i.test(msg.method)) {
            await child.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } }));
          }

          for (const parsed of parseCodexMessage(msg)) {
            // Once the user has stopped the turn, any failure that follows is the stop, not a crash.
            const ev = signal.aborted && parsed.type === 'failed' && parsed.error.kind !== 'policy_violation'
              ? { type: /** @type {const} */ ('failed'), error: { kind: /** @type {const} */ ('cancelled'), message: 'Interrupted.' } }
              : parsed;
            // Record the outcome before yielding: TurnRunner (core.js) stops reading at `final`, which closes this
            // generator at the yield, so anything after it never runs. Set after the yield, the thread was never
            // kept, and every real Codex turn started a new app server (found measuring first-token latency, T7.1).
            if (ev.type === 'final') { ended = true; cacheable = true; nextSeenLen = req.history.length + 2; }
            if (ev.type === 'failed') { ended = true; cacheable = false; }
            yield ev;
          }
          if (ended) break;
        }
        if (!ended) {
          yield { type: 'failed', error: { kind: signal.aborted ? 'cancelled' : 'provider_crashed', message: signal.aborted ? 'Interrupted.' : (cleanStderr(child.stderrTail()) || 'Codex exited unexpectedly.') } };
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        if (cacheable && threadId) {
          pool.set(poolKey, { child, threadId, seenLen: nextSeenLen, idCounter });
        } else {
          pool.evict(poolKey);
          await child.kill().catch(() => {});
        }
      }
    },

    async dispose() {
      await pool.disposeAll();
    },
  };
}
