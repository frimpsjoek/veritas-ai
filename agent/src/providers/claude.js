// @ts-check
// agent-src/src/providers/claude.js
// The Claude Code adapter. Tools reach it over the same MCP-over-HTTP face Codex uses (providers/codex.js);
// the difference here is the wire format (`stream-json`) and the launch shape: `claude -p` needs a real
// `--mcp-config <file>` on disk (Codex passes its MCP config inline over JSON-RPC), and a `claude -p` process
// is naturally one-shot per prompt rather than a long-lived server, so T2.1 keeps up to MAX_WARM processes
// alive per sessionKey (fed further turns over `--input-format stream-json`) instead of spawning fresh every
// time, with an idle timeout so a stale conversation doesn't hold a process forever.

import { rateLimitNotice } from './usage.js';
import { readAddedModels } from '../settings.js';

const MAX_WARM = 3;
const IDLE_MS = 10 * 60 * 1000;

/** A fast, non-cryptographic string hash (FNV-1a), used only to key the warm pool by instructions text — no
 *  node:crypto import, so this file stays portable to the Gecko platform (Zotero has no Node). */
function hashInstructions(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Binary lookup order: a settings path, then CLAUDE_BINARY, then the known install path on this Mac, then PATH. */
export function binaryCandidates(setting, env = {}) {
  return [setting, env.CLAUDE_BINARY, env.HOME ? `${env.HOME}/.local/bin/claude` : null, 'claude'].filter(Boolean);
}

/**
 * Pure: `claude auth status`'s stdout is real JSON on 2.1.282 (`{ loggedIn, authMethod, apiProvider, email,
 * subscriptionType, ... }`), unlike codex's plain text. A parse failure or a non-JSON line is treated as signed
 * out rather than thrown, since this only ever feeds a status display.
 * @param {string} text
 */
export function parseClaudeAuthStatus(text) {
  try {
    const data = JSON.parse(text);
    if (!data.loggedIn) return { loggedIn: false, account: { kind: /** @type {const} */ ('none'), label: null, plan: null } };
    return { loggedIn: true, account: { kind: /** @type {const} */ ('claude'), label: data.email ?? null, plan: data.subscriptionType ?? data.apiProvider ?? null } };
  } catch {
    return { loggedIn: false, account: { kind: /** @type {const} */ ('none'), label: null, plan: null } };
  }
}

/**
 * Pure: the tmp mcp-config file this launch needs and its contents. One file per launch (not reused across
 * turns), so there's nothing to keep in sync afterward; the caller removes it once the process exits.
 * @param {string} dataDir @param {string} configId @param {string} mcpUrl @param {string} mcpToken
 */
export function claudeMcpConfigPlan(dataDir, configId, mcpUrl, mcpToken) {
  const path = `${dataDir}/claude-mcp/${configId}.json`;
  const content = JSON.stringify({ mcpServers: { lib: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${mcpToken}` } } } });
  return { path, content };
}

/** @type {Record<string, import("../domain").ActivityKind>} */
const NAMED_TOOL_KIND = { WebSearch: 'web', WebFetch: 'web' };
/** @param {string} name @returns {import("../domain").ActivityKind} */
function toolKind(name) {
  const bare = name.startsWith('mcp__lib__') ? name.slice('mcp__lib__'.length) : name;
  if (bare === 'search_library') return 'library';
  if (bare === 'read_source') return 'read';
  if (bare === 'related_sources') return 'library';
  if (bare === 'search_scholarly') return 'scholarly';
  if (bare === 'read_result') return 'result';
  return NAMED_TOOL_KIND[name] ?? 'mcp';
}

function activityLabel(name, input) {
  const bare = name.startsWith('mcp__lib__') ? name.slice('mcp__lib__'.length) : name;
  const q = input?.query ?? input?.q ?? '';
  switch (bare) {
    case 'search_library': return `Searching your papers for "${q}"`;
    case 'read_source': return `Reading ${input?.note ?? input?.citekey ?? 'a source'}`;
    case 'related_sources': return `Finding sources related to ${input?.note ?? input?.citekey ?? ''}`;
    case 'search_scholarly': return `Searching the literature for "${q}"`;
    case 'WebSearch': return `Searching the web for "${q}"`;
    case 'WebFetch': return `Reading ${input?.url ?? 'a web page'}`;
    // Fallback label; activity.js's compactActivities resolves "Referenced "title" Vn" from `tool`/`args`
    // carried on the event (spec 007 §1.5), using the turn's own session manifest.
    case 'read_result': return `Referenced result ${input?.result ?? ''}`;
    default: return `Using ${bare}`;
  }
}

/** Tools our sandbox must never expose. If the CLI ever surfaces one anyway (a config drift, a future default
 *  change), the turn is stopped the same way Codex stops on commandExecution/fileChange. */
const FORBIDDEN_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);

/** With --json-schema the CLI delivers the structured answer through a synthetic tool of this name. It is the answer
 *  itself, not a tool call: it must not show as activity, and must not count against a tool budget (an extraction
 *  turn's budget is zero, spec 007 §5.2). Found by the real E4 run. */
const ANSWER_TOOL = 'StructuredOutput';

/** `claude --effort` takes all five. @type {import("../domain").Effort[]} */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The CLI has no list command, so these are the `--model` aliases (`claude --help`): each follows the latest version.
 *  @type {{ id: string, label: string, hint: string }[]} */
const CLAUDE_ALIASES = [
  { id: 'fable', label: 'Fable', hint: 'The most capable, for the hardest work' },
  { id: 'opus', label: 'Opus', hint: 'Strong reasoning, for reports and long writing' },
  { id: 'sonnet', label: 'Sonnet', hint: 'Fast and good for most questions' },
  { id: 'haiku', label: 'Haiku', hint: 'Fastest, for quick answers' },
];

/** Pure. @param {string[]} added exact IDs the user typed @returns {import("../domain").ProviderModel[]} */
export function claudeModels(added) {
  const builtin = CLAUDE_ALIASES.map((m) => ({ ...m, efforts: [...CLAUDE_EFFORTS], source: /** @type {const} */ ('builtin'), isDefault: false }));
  const known = new Set(builtin.map((m) => m.id));
  return [...builtin, ...added.filter((id) => !known.has(id)).map((id) => ({ id, label: id, hint: null, efforts: [...CLAUDE_EFFORTS], source: /** @type {const} */ ('added'), isDefault: false }))];
}

/**
 * Pure: the argv, the env and the mcp-config file this launch needs. No I/O (the file itself is written by the
 * caller, mirroring codexLaunch/ensureCodexHome's split).
 * @param {{ binary: string, dataDir: string, cwd: string, configId: string, mcpUrl: string, mcpToken: string,
 *           toolNames: string[], instructions?: string | null, model?: string | null,
 *           effort?: import("../domain").Effort | null, webMode?: "off" | "cached" | "live" | null,
 *           outputSchema?: object | null, resume?: string | null }} opts
 */
export function claudeLaunch(opts) {
  const mcpConfigPlan = claudeMcpConfigPlan(opts.dataDir, opts.configId, opts.mcpUrl, opts.mcpToken);
  const webOn = !!opts.webMode && opts.webMode !== 'off';
  const mcpTools = opts.toolNames.map((n) => `mcp__lib__${n}`);
  const allowedTools = webOn ? [...mcpTools, 'WebSearch', 'WebFetch'] : mcpTools;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config', mcpConfigPlan.path,
    '--strict-mcp-config',
    '--tools', webOn ? 'WebSearch,WebFetch' : '',
    '--allowedTools', allowedTools.join(','),
    '--setting-sources', '',
    '--no-session-persistence',
  ];
  // --system-prompt (a full replacement, not --append-system-prompt) so Claude Code's own default coding-agent
  // system prompt never reaches the model: ASK_INSTRUCTIONS already states plainly that there is no shell, no
  // file access and no code execution, and a mixed-in default prompt about being a coding assistant is exactly
  // the kind of noise that once made Codex try a shell command on its first real turn (rationale.md, T1.5).
  if (opts.instructions) args.push('--system-prompt', opts.instructions);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.outputSchema) args.push('--json-schema', JSON.stringify(opts.outputSchema));
  if (opts.resume) args.push('--resume', opts.resume);

  /** @type {import("../platform").SpawnSpec} */
  const spec = { cmd: opts.binary, args, env: {}, cwd: opts.cwd };
  return { spec, mcpConfigPlan };
}

/**
 * Maps one `claude -p --output-format stream-json` line to zero or more domain-shaped provider events. Unlike
 * parseCodexMessage this is stateful (a closure, not a bare function): a `tool_result` line carries only the
 * `tool_use_id`, not the tool's name, so the parser remembers each in-flight call's name from its `tool_use`
 * block to label the matching "end" activity and to know which forbidden-tool check already fired.
 */
export function createClaudeParser() {
  const pending = new Map(); // tool_use_id -> { name, input }

  /** @returns {import("../provider").ProviderEvent[]} */
  function parse(msg) {
    if (!msg || typeof msg !== 'object') return [];

    if (msg.type === 'stream_event') {
      const event = msg.event ?? {};
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        return [{ type: 'text', delta: event.delta.text ?? '' }];
      }
      // Extended-thinking streams its own delta kind when the CLI is run with thinking on (spec 007 §3.1: Claude
      // Code thinking blocks). Confirmed live shape (this machine's own transcripts, `~/.claude/projects/*.jsonl`):
      // the completed block is `{ type: "thinking", thinking: "<text>", signature }`; the streamed delta mirrors
      // text_delta's shape with `type: "thinking_delta"` and a `thinking` field instead of `text`.
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
        return event.delta.thinking ? [{ type: 'reasoning', delta: event.delta.thinking }] : [];
      }
      return [];
    }

    if (msg.type === 'assistant') {
      const blocks = msg.message?.content ?? [];
      /** @type {import("../provider").ProviderEvent[]} */
      const out = [];
      for (const block of blocks) {
        if (block.type === 'thinking') {
          if (block.thinking) out.push({ type: 'reasoning', delta: block.thinking });
          continue;
        }
        if (block.type !== 'tool_use' || block.name === ANSWER_TOOL) continue;
        pending.set(block.id, { name: block.name, input: block.input });
        if (FORBIDDEN_TOOLS.has(block.name)) {
          out.push({ type: 'failed', error: { kind: 'policy_violation', message: `Claude tried to use ${block.name}; the turn was stopped.` } });
          continue;
        }
        out.push({ type: 'activity', id: block.id, phase: 'start', kind: toolKind(block.name), label: activityLabel(block.name, block.input), tool: block.name, args: block.input });
      }
      return out;
    }

    if (msg.type === 'user') {
      const blocks = msg.message?.content ?? [];
      /** @type {import("../provider").ProviderEvent[]} */
      const out = [];
      for (const block of blocks) {
        if (block.type !== 'tool_result') continue;
        const info = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        if (!info || FORBIDDEN_TOOLS.has(info.name)) continue; // the forbidden case already ended the turn
        out.push({ type: 'activity', id: block.tool_use_id, phase: 'end', kind: toolKind(info.name), label: activityLabel(info.name, info.input), ok: !block.is_error, tool: info.name, args: info.input });
      }
      return out;
    }

    if (msg.type === 'rate_limit_event') {
      const w = msg.rate_limit_info?.unifiedWindows?.five_hour;
      if (!w) return [];
      const percentUsed = Math.round((w.utilization ?? 0) * 100);
      return [rateLimitNotice({ text: `Claude: ${percentUsed}% of the 5h window used`, percentUsed, windowMinutes: 300, resetsAt: w.resetsAt ?? w.resets_at })];
    }

    if (msg.type === 'result') {
      if (msg.is_error) {
        const kind = msg.subtype === 'error_max_turns' ? 'bad_output' : 'provider_crashed';
        return [{ type: 'failed', error: { kind, message: msg.result ?? `Claude reported an error (${msg.subtype ?? 'unknown'}).` } }];
      }
      return [{
        type: 'final',
        text: msg.result ?? '',
        json: null,
        usage: { inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens, usd: msg.total_cost_usd },
      }];
    }

    return [];
  }

  return { parse };
}

/** Small LRU of warm `claude` processes, one per sessionKey, so a multi-turn conversation reuses its MCP
 *  handshake instead of paying it every message. Evicts the least-recently-used entry beyond `max`, and any
 *  entry idle past `idleMs`. Kept separate from claudeProvider so the eviction policy is unit-testable without
 *  a real subprocess.
 * @param {{ max?: number, idleMs?: number, kill?: (child: import("../platform").ChildProcess) => Promise<void>, now?: () => number,
 *           schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>, clear?: (timer: ReturnType<typeof setTimeout>) => void }} [opts] */
export function createWarmPool({ max = MAX_WARM, idleMs = IDLE_MS, kill = async () => {}, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), clear = (t) => clearTimeout(t) } = {}) {
  const entries = new Map(); // sessionKey -> { child, lastUsed, timer }

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
    get(sessionKey) { return entries.get(sessionKey)?.child ?? null; },
    set(sessionKey, child) {
      if (!entries.has(sessionKey) && entries.size >= max) evictLru();
      entries.set(sessionKey, { child, lastUsed: now(), timer: schedule(() => evict(sessionKey), idleMs) });
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
 * The Provider.
 * @param {import("../platform").Platform} platform
 * @param {{ binaryPath: string | null, dataDir: string, home: string }} settings
 * @returns {import("../provider").Provider}
 */
export function claudeProvider(platform, settings) {
  const pool = createWarmPool({ kill: (child) => child.kill() });

  async function resolveBinary() {
    return platform.which(binaryCandidates(settings.binaryPath, { CLAUDE_BINARY: process.env?.CLAUDE_BINARY, HOME: settings.home }));
  }

  async function runClaudeCli(binary, args) {
    const child = await platform.spawn({ cmd: binary, args, env: {}, cwd: settings.dataDir });
    const lines = [];
    for await (const line of child.lines()) lines.push(line);
    const code = await child.exited;
    return { code, lines, stderr: child.stderrTail() };
  }

  /** @returns {Promise<import("../domain").ProviderStatus>} */
  async function status() {
    const binary = await resolveBinary();
    if (!binary) {
      return { provider: 'claude', state: 'missing', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: 'Install Claude Code (`claude`), then sign in or run `claude setup-token`.' };
    }
    const [versionResult, authResult] = await Promise.all([
      runClaudeCli(binary, ['--version']).catch(() => null),
      runClaudeCli(binary, ['auth', 'status']).catch(() => null), // real, structured JSON on 2.1.282 (unlike codex's plain text)
    ]);
    const version = versionResult?.lines?.[0]?.split(' ')[0] ?? null;
    if (!authResult) return { provider: 'claude', state: 'unreachable', version, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null };
    const parsed = parseClaudeAuthStatus(authResult.lines.join('\n'));
    return { provider: 'claude', state: parsed.loggedIn ? 'ready' : 'signed_out', version, account: parsed.account, usage: null, installHelp: parsed.loggedIn ? null : 'Sign in with `claude` then `/login`, or set ANTHROPIC_API_KEY.' };
  }

  return {
    id: /** @type {const} */ ('claude'),
    caps: { nativeWebSearch: true, nativeStructuredOutput: true },

    status,

    async models() { return claudeModels(await readAddedModels(platform.fs, settings.dataDir, 'claude')); },

    /** `browser`/`device_code`: `claude auth login` opens the account's own browser flow and blocks until it
     *  finishes, printing a URL first (`--sso` forces the same URL-based flow rather than a device code, since
     *  `claude auth login --help` on 2.1.282 has no separate device-code flag). `{ apiKey }`: Claude has no
     *  scriptable "sign in with this key" command (ANTHROPIC_API_KEY is read from the process environment, not
     *  set by a CLI flag), so this throws a plain-language hint instead of faking a flow that doesn't exist. */
    async signIn(method) {
      const binary = await resolveBinary();
      if (!binary) throw new Error('Claude Code is not installed.');
      if (typeof method === 'object' && method.apiKey) {
        throw new Error('Claude Code reads ANTHROPIC_API_KEY from the environment; set it there, then restart Second Brain AI (there is no sign-in flow for it).');
      }
      const child = await platform.spawn({ cmd: binary, args: ['auth', 'login'], env: {}, cwd: settings.dataDir });
      /** @type {string | undefined} */
      let openUrl;
      const done = (async () => {
        for await (const line of child.lines()) {
          const match = line.match(/https?:\/\/\S+/);
          if (match && !openUrl) openUrl = match[0];
        }
        const exitCode = await child.exited;
        if (exitCode !== 0) throw new Error(child.stderrTail() || 'claude auth login failed or was cancelled.');
        return status();
      })();
      await new Promise((resolve) => setTimeout(resolve, 800)); // let it print the URL before we return it alongside `done`
      return { openUrl, done };
    },

    async signOut() {
      const binary = await resolveBinary();
      if (!binary) return;
      await runClaudeCli(binary, ['auth', 'logout']).catch(() => {});
    },

    async *turn(req, signal) {
      const binary = await resolveBinary();
      if (!binary) {
        yield { type: 'failed', error: { kind: 'not_installed', message: 'Claude Code is not installed. Install it with `claude` on PATH and sign in.' } };
        return;
      }

      const configId = `${req.sessionKey}-${Date.now()}`;
      const launch = claudeLaunch({
        binary,
        dataDir: settings.dataDir,
        cwd: `${settings.dataDir}/claude-cwd`,
        configId,
        mcpUrl: req.tools.mcp.url,
        mcpToken: req.tools.mcp.token,
        toolNames: req.tools.specs.map((s) => s.name),
        instructions: req.instructions || null,
        model: req.model?.model ?? null,
        effort: req.model?.effort ?? null,
        webMode: req.web,
        outputSchema: req.outputSchema ?? null,
      });
      await platform.fs.writeAtomic(launch.mcpConfigPlan.path, launch.mcpConfigPlan.content);
      // child_process.spawn needs cwd to already exist (ENOENT otherwise, easily mistaken for a missing
      // binary); the cwd itself stays otherwise empty, matching the isolation requirement.
      await platform.fs.writeAtomic(`${launch.spec.cwd}/.keep`, '');

      // --system-prompt is baked into the process at spawn time, so a warm process can only be reused for a
      // turn with the same instructions text; keying the pool on sessionKey alone would silently reuse a
      // process launched under different (e.g. stale) instructions.
      const poolKey = `${req.sessionKey}:${hashInstructions(req.instructions || '')}`;
      let child = pool.get(poolKey);
      const isWarm = !!child;
      if (!child) {
        child = await platform.spawn(launch.spec);
        pool.set(poolKey, child);
      } else {
        pool.touch(poolKey);
      }

      const parser = createClaudeParser();
      const onAbort = () => { child.kill().catch(() => {}); pool.evict(poolKey); };
      signal.addEventListener('abort', onAbort);

      try {
        const userLine = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: req.input }] } };
        await child.write(JSON.stringify(userLine));

        let ended = false;
        for await (const line of child.lines()) {
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (process.env.SECOND_BRAIN_DEBUG_CLAUDE) process.stderr.write(`RAW: ${line}\n`);

          for (const ev of parser.parse(msg)) {
            yield ev;
            if (ev.type === 'failed' || ev.type === 'final') ended = true;
          }
          if (ended) break;
        }
        if (!ended) {
          yield { type: 'failed', error: { kind: signal.aborted ? 'cancelled' : 'provider_crashed', message: signal.aborted ? 'Interrupted.' : (child.stderrTail() || 'Claude exited unexpectedly.') } };
          pool.evict(poolKey);
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        await platform.fs.remove(launch.mcpConfigPlan.path);
        if (!isWarm) {
          // A fresh process stays warm for the pool to reuse on the conversation's next turn; only a process
          // this turn found already dead (never added) needs no cleanup here beyond the removal above.
        }
      }
    },

    async dispose() {
      await pool.disposeAll();
    },
  };
}
