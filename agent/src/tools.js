// @ts-check
// agent-src/src/tools.js. The tool gateway: one registry of read-only rows, served in-process or over MCP.
// Every built-in row stamps annotations.readOnlyHint: true (tools.d.ts makes the field's type the literal `true`,
// so this can't be forgotten). handleMcp is the pure JSON-RPC handler; createMcpHttpHandler adds the per-session
// bearer-token check in front of it, which is what the "wrong token gets 401" and "notifications get 202" rules
// need to hold even for an unauthenticated caller.
import { searchScholarly, SOURCES } from './scholarly.js';
import { createMcpHub } from './mcp-hub.js';
import { errorMessage } from './errors.js';
import { renderResult } from './sessions.js';

/** How long a read waits for its source's title before it starts with the plain label. */
const DESCRIBE_MS = 350;

const READ_ONLY = Object.freeze({ readOnlyHint: true });

/** The year range a library search is limited to: the model's `years`, with a routine's `since` (YYYY-MM-DD) as a
 *  floor it cannot go below. A year the model sent that is not a 4-digit number is ignored.
 *  @param {any} asked @param {string} [since] @returns {{ from: number | null, to: number | null } | null} */
function yearsOf(asked, since) {
  const year = (v) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= 1000 && n <= 9999 ? n : null; };
  let from = year(asked?.from);
  const to = year(asked?.to);
  const floor = year(/^(\d{4})-\d{2}-\d{2}$/.exec(since ?? '')?.[1]);
  if (floor != null && (from == null || from < floor)) from = floor;
  return from == null && to == null ? null : { from, to };
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.trunc(v))) : fallback;
}

/** @param {import("./domain").CitationRef} ref */
function labelForRef(ref) {
  if (ref.kind === 'note') return `[[${ref.path}]]`;
  if (ref.kind === 'paper') return `[@${ref.citekey}]`;
  return ref.url;
}

/** A title short enough for one row. @param {unknown} t */
function shortTitle(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 79).trimEnd()}…` : s;
}

/** @param {number} n @param {string} word */
function countOf(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/** The host of a URL, without "www.". @param {string} url */
export function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, '') || undefined; } catch { return undefined; }
}

/** What the model asked for; the library backend decides whether it exists. @returns {import("./domain").CitationRef | null} */
function refFromArgs(args) {
  if (args.citekey) return { kind: 'paper', citekey: /** @type {import("./domain").Citekey} */ (String(args.citekey)) };
  if (args.note) return { kind: 'note', path: /** @type {import("./domain").NotePath} */ (String(args.note)) };
  if (args.url) return { kind: 'web', url: String(args.url) };
  return null;
}

/** @param {import("./tools").LibraryBackend} library @param {typeof fetch} fetchFn @param {{ scholarly?: string[] }} settings
 *  @returns {import("./tools").ToolRow[]} */
function builtinRows(library, fetchFn, settings) {
  return [
    {
      name: 'search_library',
      description: "Search the user's own notes and papers by meaning. Returns titles, years and short snippets.",
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' }, years: { type: 'object', description: 'Only papers published in these years (notes have no year and are left out).', properties: { from: { type: ['integer', 'null'] }, to: { type: ['integer', 'null'] } } } }, required: ['query'] },
      annotations: READ_ONLY,
      activity: { kind: 'library', label: (a) => `Searching your papers for "${a?.query ?? ''}"` },
      // A `chat_papers` turn (ctx.session.on set, spec 007 §6) narrows to read_result/read_source only, so the
      // model can't re-search the whole library for a question scoped to one paper set.
      enabled: (ctx) => (ctx.sources.papers || ctx.sources.notes) && !ctx.session?.on,
      async run(args, ctx) {
        // ctx.scope is the only scope ever used, so a review scoped to a collection cannot be widened by args.
        // Papers-only or notes-only narrows the backend search; both on searches everything (today's behaviour).
        const only = ctx.sources.papers && !ctx.sources.notes ? 'papers' : (!ctx.sources.papers && ctx.sources.notes ? 'notes' : undefined);
        /** A search that failed is a tool error, never "No matches": the model must not report an empty library for a slow server. */
        const years = yearsOf(args.years, ctx.since);
        const results = await library.search({ text: String(args.query ?? ''), scope: ctx.scope, limit: clamp(args.limit, 1, 20, 8), only, ...(years ? { years } : {}) })
          .catch((error) => { throw new Error(`The library search failed (${errorMessage(error)}). That is not "no matches": the library was not searched.`); });
        const seen = results.map((r) => r.ref);
        const text = results.length
          ? results.map((r, i) => `${i + 1}. ${labelForRef(r.ref)} — ${r.title}${r.year ? ` (${r.year})` : ''}\n   ${r.snippet}`).join('\n')
          : 'No matches in your library.';
        const noun = only === 'papers' ? 'paper' : only === 'notes' ? 'note' : 'result';
        return { text, seen, titles: results.map((r) => [r.ref, r.title]),
          meta: { count: results.length, detail: results.length ? countOf(results.length, noun) : 'No matches' } };
      },
    },
    {
      name: 'read_source',
      description: 'Read a note or paper already found by search_library, optionally one section.',
      inputSchema: { type: 'object', properties: { note: { type: 'string' }, citekey: { type: 'string' }, heading: { type: 'string' }, maxChars: { type: 'integer' } } },
      annotations: READ_ONLY,
      activity: { kind: 'read', label: () => 'Reading a source' },
      enabled: (ctx) => ctx.sources.papers || ctx.sources.notes,
      async run(args, ctx) {
        const ref = refFromArgs(args);
        if (!ref) return { text: 'Give a note path or a citekey.', seen: [] };
        // A `chat_papers` turn (spec 007 §6) reads only library papers that are rows of its subset.
        if (ctx.session?.on) {
          const on = ctx.session.on;
          const body = await ctx.session.read(on.result);
          const rows = body?.kind === 'papers' ? (on.rows === 'all' ? body.rows : body.rows.filter((r) => /** @type {string[]} */ (on.rows).includes(r.id))) : [];
          const allowed = ref.kind === 'paper' && rows.some((r) => r.inLibrary && r.ref.kind === 'paper' && r.ref.citekey === ref.citekey);
          if (!allowed) return { text: `${labelForRef(ref)} is not one of the papers you are chatting with, or is not in the library. Use read_result for the papers in this set.`, seen: [] };
        }
        // A ref of a kind the chat has turned off is refused, so the model can't reach notes through a paper's
        // related list (or vice versa) when that source is off.
        if (ref.kind === 'paper' && !ctx.sources.papers) return { text: 'Papers are turned off for this chat.', seen: [] };
        if (ref.kind === 'note' && !ctx.sources.notes) return { text: 'Notes are turned off for this chat.', seen: [] };
        const result = await library.read(ref, { heading: args.heading, maxChars: clamp(args.maxChars, 500, 20000, 6000) });
        if (!result) return { text: `${labelForRef(ref)} was not found in the library.`, seen: [] };
        return { text: `${result.title}\n\n${result.text}`, seen: [ref], titles: [[ref, result.title]],
          meta: { source: { kind: ref.kind === 'web' ? 'web' : ref.kind, title: shortTitle(result.title), ...(ref.kind === 'web' ? { host: hostOf(ref.url) } : {}) } } };
      },
    },
    {
      name: 'related_sources',
      description: 'Papers and notes related to a given note or paper: links, citing work, shared tags.',
      inputSchema: { type: 'object', properties: { note: { type: 'string' }, citekey: { type: 'string' }, limit: { type: 'integer' } } },
      annotations: READ_ONLY,
      activity: { kind: 'library', label: () => 'Finding related sources' },
      enabled: (ctx) => (ctx.sources.papers || ctx.sources.notes) && !ctx.session?.on,
      async run(args, ctx) {
        const ref = refFromArgs(args);
        if (!ref) return { text: 'Give a note path or a citekey.', seen: [] };
        if (ref.kind === 'paper' && !ctx.sources.papers) return { text: 'Papers are turned off for this chat.', seen: [] };
        if (ref.kind === 'note' && !ctx.sources.notes) return { text: 'Notes are turned off for this chat.', seen: [] };
        const all = await library.related(ref, { limit: clamp(args.limit, 1, 20, 8) });
        // Drop results of a kind that is off, so a paper's related list can't surface notes when Notes is off
        // (and vice versa).
        const results = all.filter((r) => (r.ref.kind === 'paper' ? ctx.sources.papers : r.ref.kind === 'note' ? ctx.sources.notes : true));
        const seen = results.map((r) => r.ref);
        const text = results.length
          ? results.map((r, i) => `${i + 1}. ${labelForRef(r.ref)} — ${r.title}\n   ${r.snippet}`).join('\n')
          : 'Nothing related found in the library.';
        return { text, seen, titles: results.map((r) => [r.ref, r.title]),
          meta: { count: results.length, detail: results.length ? `${results.length} related` : 'Nothing related' } };
      },
    },
    {
      // spec 007 §1.5. Only offered when the turn carries a session; a `chat_papers` turn (ctx.session.on set)
      // narrows it to the one result it's scoped to, so the model can't wander into another result in the same
      // session by naming a different id.
      name: 'read_result',
      description: 'Read a paper set or table already in this session by its id (e.g. "R2"), instead of searching again.',
      inputSchema: { type: 'object', properties: {
        result: { type: 'string' }, version: { type: 'integer' },
        rows: { type: 'array', items: { type: 'string' } }, columns: { type: 'array', items: { type: 'string' } },
        offset: { type: 'integer' }, maxChars: { type: 'integer' }, abstracts: { type: 'boolean' },
      }, required: ['result'] },
      annotations: READ_ONLY,
      activity: { kind: 'result', label: () => 'Reading your results' },
      enabled: (ctx) => Boolean(ctx.session),
      async run(args, ctx) {
        const session = ctx.session;
        if (!session) return { text: 'No session for this turn.', seen: [] };
        const resultId = session.on ? session.on.result.id : String(args.result ?? '');
        if (session.on && String(args.result ?? '') !== session.on.result.id) {
          return { text: `This turn only reads ${session.on.result.id} (the papers you're chatting with).`, seen: [] };
        }
        let version = session.on?.result.version;
        if (args.version != null) { const v = Number(args.version); if (Number.isFinite(v)) version = Math.trunc(v); }
        const result = await session.read({ id: resultId, version });
        if (!result) return { text: `No result ${resultId}${version ? ` V${version}` : ''} in this session.`, seen: [] };
        // The subset of a chat_papers turn is a hard limit: the model's own `rows` can only narrow it further.
        let rows = args.rows;
        if (session.on && session.on.rows !== 'all') {
          const subset = session.on.rows;
          rows = Array.isArray(args.rows) && args.rows.length ? args.rows.filter((r) => /** @type {string[]} */ (subset).includes(String(r))) : subset;
          if (!rows.length) return { text: 'None of those rows are in the papers you are chatting with.', seen: [] };
        }
        // Abstracts come with the rows in a chat_papers turn (they are what the question is answered from), or when asked for.
        const rendered = renderResult(result, { rows, columns: args.columns, abstracts: session.on ? args.abstracts !== false : args.abstracts === true, offset: clamp(args.offset, 0, Number.MAX_SAFE_INTEGER, 0), maxChars: clamp(args.maxChars, 500, 20000, 12000) });
        return { text: rendered.text, seen: rendered.seen,
          meta: { source: { kind: result.kind === 'report' ? 'note' : 'paper', title: shortTitle(result.title) } } };
      },
    },
    {
      name: 'search_scholarly',
      description: 'Search scholarly sources (OpenAlex, arXiv, Crossref, Europe PMC and more) for papers not necessarily in the library.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
      annotations: READ_ONLY,
      activity: { kind: 'scholarly', label: (a) => `Searching the literature for "${a?.query ?? ''}"` },
      enabled: (ctx) => ctx.sources.scholarly && !ctx.session?.on,
      async run(args, ctx) {
        const papers = await searchScholarly(fetchFn, String(args.query ?? ''), { limit: clamp(args.limit, 1, 20, 10), sources: settings.scholarly, ...(ctx.since ? { since: ctx.since } : {}) });
        /** @type {import("./domain").CitationRef[]} */
        const seen = papers.filter((p) => p.url).map((p) => ({ kind: 'web', url: p.url }));
        const text = papers.length
          ? papers.map((p, i) => `${i + 1}. ${p.title}${p.year ? ` (${p.year})` : ''} — ${p.venue || p.source}${p.doi ? ` doi:${p.doi}` : ''}${p.url ? `\n   ${p.url}` : ''}`).join('\n')
          : 'No results.';
        return { text, seen, meta: { count: papers.length, detail: papers.length ? countOf(papers.length, 'paper') : 'No results' } };
      },
    },
  ];
}

function randomToken() {
  // Web Crypto, not node:crypto, so the gateway also runs inside Zotero (Node 22 has it as a global too).
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {typeof fetch} fetchFn
 * @param {import("./tools").LibraryBackend} library
 * @param {{ mcpUrl?: string, scholarly?: string[], spawn?: import("./platform").Platform["spawn"],
 *           mcp?: (import("./tools").McpServerConfig & { trustUnmarked?: boolean })[] }} settings
 * @returns {Promise<import("./tools").ToolGateway & { _sessionForToken(token: string): import("./tools").ToolSession | null }>}
 */
export async function createToolGateway(fetchFn, library, settings = {}) {
  const rows = builtinRows(library, fetchFn, settings);
  const sessions = new Map(); // token -> ToolSession
  // T6.1: createToolGateway's declared signature (tools.d.ts) takes the full Platform; this impl keeps the
  // narrower `fetchFn` every existing caller and test already passes (T1.3's reconciliation), and widens it
  // into a minimal { fetch, spawn } shim so McpHub gets stdio only when a real spawn is actually supplied.
  const mcpPlatform = { fetch: fetchFn, spawn: settings.spawn ?? (() => Promise.reject(new Error('This host cannot run a local MCP server (stdio spawn is unavailable).'))) };
  const mcpHub = createMcpHub(mcpPlatform, { initial: settings.mcp ?? [] });
  await mcpHub.ready;

  // One MCP token per conversation key. Codex keeps a conversation's thread between turns, and the thread's MCP
  // config (with its Authorization header) is fixed when the thread starts, so turn 2 still sends turn 1's token.
  // Reusing the token and pointing it at the new turn's session keeps that thread's tool calls working (a fresh
  // token per turn made every second Codex turn fail with 401 Unauthorized). A turn still open under the same key
  // gets a token of its own, so two live turns never share one.
  /** @type {Map<string, string>} */
  const keyTokens = new Map();
  const MAX_KEYS = 500;

  /** @param {any} ctx @param {{ key?: string }} [opts] */
  function open(ctx, opts = {}) {
    const kept = opts.key ? keyTokens.get(opts.key) : undefined;
    const token = kept && !sessions.has(kept) ? kept : randomToken();
    if (opts.key && !kept) {
      keyTokens.set(opts.key, token);
      const oldest = keyTokens.keys().next().value;
      if (keyTokens.size > MAX_KEYS && oldest !== undefined) keyTokens.delete(oldest);
    }
    const seen = [];
    /** Finished calls' activity meta, waiting for the engine to attach it to the matching end event. @type {{ tool: string, key: string, meta: import("./domain").ActivityMeta }[]} */
    const metaLog = [];
    /** ref key -> human title, from search/read results this session, so a later read can be named at its start. @type {Map<string, string>} */
    const titles = new Map();
    const bare = (n) => String(n ?? '').replace(/^mcp__lib__/, '');
    const keyOf = (a) => { try { return JSON.stringify(a ?? {}); } catch { return ''; } };
    // A `chat_papers` turn (ctx.session.on, spec 007 §6) gets read_result and read_source only: no search, no web, no MCP.
    const scoped = (r) => !ctx.session?.on || r.name === 'read_result' || r.name === 'read_source';
    /** Live activity (spec 007): the host reports each of its own tool calls the moment it starts and ends, so the feed
     *  does not wait on a provider's (batched, late) notifications. @type {Set<(ev: any) => void>} */
    const listeners = new Set();
    const builtinNames = new Set(rows.map((r) => r.name));
    const isHostTool = (n) => builtinNames.has(bare(n));
    let callSeq = 0;
    const emit = (ev) => { for (const l of [...listeners]) { try { l(ev); } catch { /* a listener must not break a tool call */ } } };
    const enabledRows = () => (ctx.none ? [] : [...rows, ...mcpHub.rows()].filter((r) => scoped(r) && r.enabled(ctx)));
    const session = {
      specs: enabledRows().map((r) => ({ name: r.name, description: r.description, inputSchema: r.inputSchema })),
      async call(name, args, signal) {
        const row = enabledRows().find((r) => r.name === name);
        if (!row) return { ok: false, text: `Unknown or disabled tool: ${name}` };
        const reported = isHostTool(name) && listeners.size > 0;
        // A review counts its search tools' outcomes (ToolContext.searchTally): a stage whose every search failed is not an empty result.
        const searchTool = Boolean(ctx.searchTally) && (bare(name) === 'search_library' || bare(name) === 'search_scholarly');
        const id = `h:${++callSeq}`;
        let label = '';
        const base = { id, kind: row.activity.kind, tool: row.name, args: args ?? {} };
        if (reported) {
          try { label = row.activity.label(args ?? {}); } catch { label = `Using ${row.name}`; }
          // A read can name its source when the title is already known or cheap to find; never wait long for it.
          if (row.name === 'read_source') {
            let timer;
            const named = await Promise.race([session.describe(name, args).catch(() => null), new Promise((r) => { timer = setTimeout(() => r(null), DESCRIBE_MS); })]);
            clearTimeout(timer);
            if (typeof named === 'string') label = named;
          }
          emit({ type: 'activity', phase: 'start', label, ...base });
        }
        try {
          const out = await row.run(args ?? {}, ctx, signal ?? new AbortController().signal);
          seen.push(...out.seen);
          if (searchTool) ctx.searchTally.calls += 1;
          for (const [ref, title] of out.titles ?? []) if (title) titles.set(labelForRef(ref), String(title));
          // Reported live from the host, so nothing downstream needs the meta a second time.
          if (out.meta && !reported) metaLog.push({ tool: name, key: keyOf(args ?? {}), meta: out.meta });
          if (reported) emit({ type: 'activity', phase: 'end', label, ok: true, ...base, ...(out.meta ?? {}) });
          return { ok: true, text: out.text, ...(out.meta ? { meta: out.meta } : {}) };
        } catch (error) {
          if (reported) emit({ type: 'activity', phase: 'end', label, ok: false, ...base });
          if (searchTool) { ctx.searchTally.calls += 1; ctx.searchTally.failed += 1; ctx.searchTally.firstError ??= errorMessage(error); }
          return { ok: false, text: errorMessage(error) };
        }
      },
      onActivity(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      isHostTool,
      mcp: { url: settings.mcpUrl ?? '', token },
      takeMeta(name, args) {
        const n = bare(name); const k = keyOf(args);
        let i = metaLog.findIndex((m) => m.tool === n && m.key === k);
        if (i < 0) i = metaLog.findIndex((m) => m.tool === n);
        return i < 0 ? null : metaLog.splice(i, 1)[0].meta;
      },
      async describe(name, args) {
        // Only a read of a named library source has a title worth waiting for; everything else keeps its label.
        if (bare(name) !== 'read_source') return null;
        const ref = refFromArgs(args ?? {});
        if (!ref || ref.kind === 'web') return null;
        const known = titles.get(labelForRef(ref));
        if (known) return `Reading “${shortTitle(known)}”`;
        try {
          const hit = [...(await library.resolve([ref])).values()][0];
          if (hit?.title) { titles.set(labelForRef(ref), hit.title); return `Reading “${shortTitle(hit.title)}”`; }
        } catch { /* fall through to the plain label */ }
        return 'Reading a source';
      },
      seen: () => seen.slice(),
      close() { sessions.delete(token); },
    };
    sessions.set(token, session);
    return session;
  }

  return {
    open,
    mcpServers: mcpHub,
    async dispose() { sessions.clear(); for (const name of (await mcpHub.reports()).map((r) => r.config.name)) await mcpHub.remove(name); },
    _sessionForToken: (token) => sessions.get(token) ?? null,
  };
}

function jsonRpcResult(id, result) {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function jsonRpcError(id, code, message) {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

/**
 * Pure JSON-RPC handler for the MCP HTTP face. `session === null` means an unrecognized or missing token: a
 * notification still gets 202 (nothing to leak), but any request gets 401.
 * @param {string} body
 * @param {import("./tools").ToolSession | null} session
 */
export async function handleMcp(body, session) {
  let req;
  try {
    req = JSON.parse(body);
  } catch {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }
  const isNotification = !('id' in req);
  if (!session) {
    return isNotification ? { status: 202, body: '' } : { status: 401, body: JSON.stringify({ jsonrpc: '2.0', id: req.id ?? null, error: { code: -32001, message: 'Unauthorized' } }) };
  }
  try {
    switch (req.method) {
      case 'initialize':
        return jsonRpcResult(req.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'second-brain', version: '0' } });
      case 'notifications/initialized':
        return { status: 202, body: '' };
      case 'tools/list':
        return jsonRpcResult(req.id, {
          tools: session.specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.inputSchema, annotations: { readOnlyHint: true } })),
        });
      case 'tools/call': {
        const { name, arguments: args } = req.params ?? {};
        const result = await session.call(name, args, new AbortController().signal);
        return jsonRpcResult(req.id, { content: [{ type: 'text', text: result.text }], isError: !result.ok });
      }
      default:
        return isNotification ? { status: 202, body: '' } : jsonRpcError(req.id, -32601, `Unknown method: ${req.method}`);
    }
  } catch (error) {
    return jsonRpcError(req.id ?? null, -32000, errorMessage(error));
  }
}

/** @param {{ _sessionForToken(token: string): import("./tools").ToolSession | null }} gateway @returns {import("./platform").HttpHandler} */
export function createMcpHttpHandler(gateway) {
  return async (req) => {
    const auth = req.headers?.authorization ?? req.headers?.Authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const session = token ? gateway._sessionForToken(token) : null;
    return handleMcp(req.body, session);
  };
}

export { SOURCES as SCHOLARLY_SOURCES };
export { createMcpHub, verdictFor, reasonForVerdict } from './mcp-hub.js';
