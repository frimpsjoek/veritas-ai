// @ts-check
// ui-src/dev/harness/fake-host.js. A UiHost (../../src/host.d.ts) backed entirely by memory: no real Zotero,
// Obsidian, network or file system. Invented papers and notes only (spec 005: "nothing personal goes in it").
// Used by the shared Playwright harness (dev/run.mjs) and can be reused by node tests that want a UiHost without
// a browser.

/** A small tree (two roots, one with two children) — enough to exercise tri-state ticking and the filter box.
 * @type {import("../../src/host").CollectionNode[]} */
const COLLECTIONS = [
  { key: 'ecology', name: 'Ecology', parent: null, count: 1 },
  { key: 'foraging', name: 'Foraging', parent: 'ecology', count: 2 },
  { key: 'migration', name: 'Migration', parent: 'ecology', count: 1 },
  { key: 'design', name: 'Doorknob Design', parent: null, count: 4 },
];

/** @type {import("../../src/host").OutsidePaper[]} */
const OUTSIDE_PAPERS = [
  { title: 'Foraging Strategies of the Lesser Spangled Vole', authors: ['A. Bramblewood', 'C. Quills'], year: 2021,
    venue: 'Journal of Invented Zoology', doi: '10.9999/jiz.2021.001', abstract: 'A survey of foraging patterns.',
    url: 'https://example.invalid/vole-foraging', source: 'openalex' },
  { title: 'A Unified Theory of Doorknob Ergonomics', authors: ['P. Handlebar'], year: 2019,
    venue: 'Proceedings of Everyday Design', doi: null, abstract: 'Doorknobs, revisited.',
    url: 'https://example.invalid/doorknob-theory', source: 'arxiv' },
];

/** spec 007 E3: an in-memory session (`store.results`: id -> versions; `store.puts`: every put) behind
 * `ai.sessions`, so the artifact panel can list, read, put and restore without an engine.
 * @returns {{ results: Record<string, any[]>, puts: any[], restores: any[], records: any[], runs: any[], estimates: any[], cancels: any[], steps: Record<string, any>, stepSeq: number, cellDelay: number, conversations: any[] | null, current: any, currents: any[], recordsBy: Record<string, any[]> }} */
export function createSessionStore(results = {}) {
  return { results, puts: [], restores: [], records: [],
    /** the fake engine's columns steps (E4): every run/estimate/cancel call, each step's event buffer, and its pace */
    runs: /** @type {any[]} */ ([]), estimates: /** @type {any[]} */ ([]), cancels: /** @type {any[]} */ ([]), steps: /** @type {Record<string, any>} */ ({}), stepSeq: 10, cellDelay: 15,
    /** spec 007 E6: set to an array and the fake keeps a conversation list (list/create/rename/remove, `put` updates a session's artifact count
     *  and first-step kind); `current` / `currents` are what `setCurrent` recorded; `recordsBy[id]` are a session's records. Off (null) by default. */
    conversations: /** @type {any[] | null} */ (null), current: null, currents: /** @type {any[]} */ ([]), recordsBy: /** @type {Record<string, any[]>} */ ({}) };
}

/** A cell the fake engine "extracts": a value, a verified quote from the abstract, or (every 7th / 5th row) not found / unverified. */
function fakeCell(row, column, index) {
  if (index % 7 === 3) return { state: 'not_found', note: 'Not reported in the abstract' };
  const text = (row.abstract || row.title || '').slice(0, 30);
  return { state: 'filled', value: `${column.name}: ${(row.title || row.label || '').slice(0, 24)}`, quotes: [{ text, ref: row.ref ?? { kind: 'web', url: 'https://example.invalid' }, from: 'abstract', verified: index % 5 !== 4 }],
    citations: row.ref ? [row.ref] : [] };
}

/** The fake columns step: emits `cell` events one by one (paced by `store.cellDelay`), a `progress` per row, honours
 *  cancel, then writes V+1 (unfinished cells stay pending) and ends. Follows the engine contract in spec 007 §5.2. */
async function runFakeStep(store, input, st) {
  const versions = store.results[input.on.id];
  const base = versions[input.on.version - 1] ?? versions[versions.length - 1];
  const rowsById = new Map(base.rows.map((r) => [r.id, r]));
  const cells = structuredClone(base.cells ?? {});
  const have = new Set(base.columns.map((c) => c.id));
  const columns = [...base.columns.map((c) => input.add.find((a) => a.id === c.id) ?? c), ...input.add.filter((c) => !have.has(c.id))];
  const isOpen = (cell) => cell && (cell.state === 'pending' || cell.state === 'failed'); // rows never touched are not pending (extract.js)
  /** @type {[string, any][]} */
  let targets = [];
  if (input.rows === 'pending') {
    for (const row of base.rows) for (const c of base.columns) if (isOpen(base.cells?.[row.id]?.[c.id])) targets.push([row.id, c]);
  } else {
    const ids = input.rows === 'all' ? base.rows.map((r) => r.id) : input.rows;
    for (const id of ids) for (const c of input.add) targets.push([id, c]);
    for (const [id, c] of targets) (cells[id] ??= {})[c.id] = { state: 'pending' };
  }
  const push = (data) => { st.events.push({ seq: st.events.length + 1, data }); st.wake?.(); };
  let done = 0;
  let status = 'done';
  let lastRow = null;
  for (const [id, c] of targets) {
    if (st.cancelled) { status = 'stopped'; break; }
    await new Promise((r) => setTimeout(r, store.cellDelay));
    if (st.cancelled) { status = 'stopped'; break; }
    const row = rowsById.get(id);
    const cell = fakeCell(row, c, [...rowsById.keys()].indexOf(id));
    (cells[id] ??= {})[c.id] = cell;
    done += 1;
    push({ type: 'cell', result: base.ref.id, row: id, column: c.id, cell });
    if (lastRow !== id || done === targets.length) push({ type: 'progress', done, total: targets.length });
    lastRow = id;
  }
  const ref = { id: input.on.id, version: versions.length + 1 };
  const names = input.add.map((c) => c.name);
  versions.push({ ...base, ref, columns, cells, created: new Date().toISOString(), change: names.length ? `Added column${names.length > 1 ? 's' : ''} ${names.join(', ')}` : 'Filled the rest' });
  st.done = true;
  push({ type: 'end', status, writes: [ref] });
}

function fakeSessions(store) {
  const summaryOf = (id) => {
    const versions = store.results[id];
    const last = versions[versions.length - 1];
    return { ref: { id, version: versions.length }, kind: last.kind, title: last.title, versions: versions.length,
      rows: Array.isArray(last.rows) ? last.rows.length : null, columns: (last.columns ?? []).map((c) => c.name), updated: last.created };
  };
  return {
    async view(id) {
      // `resultsBy[id]`: one session's own results (the web Home's radar issue); every other caller shares `results`
      const own = store.resultsBy?.[id];
      if (own) return { steps: [], results: own.map((b) => ({ ref: b.ref, kind: b.kind, title: b.title, versions: 1, rows: b.rows?.length ?? null, columns: [], updated: b.created ?? '' })), current: null };
      return { steps: [], results: Object.keys(store.results).map(summaryOf), current: store.current };
    },
    async read(id, ref) {
      const own = store.resultsBy?.[id]?.find((b) => b.ref.id === ref.id);
      if (own) return own;
      const versions = store.results[ref.id];
      return versions?.[(ref.version ?? versions.length) - 1] ?? null;
    },
    async put(id, input, draft) {
      store.puts.push({ id, input, draft });
      const conv = store.conversations?.find((c) => c.id === id);
      if (conv) { if (!conv.artifacts) conv.kind = input?.kind === 'find' ? 'find' : conv.kind; conv.artifacts = (conv.artifacts ?? 0) + (store.results[draft.ref?.id] ? 0 : 1); conv.updated = new Date().toISOString(); }
      if (input?.kind === 'columns' && store.results[draft.ref?.id]) { // a new version of an existing result, as the engine does
        const versions = store.results[draft.ref.id];
        versions.push({ ...draft, ref: { id: draft.ref.id, version: versions.length + 1 }, created: new Date().toISOString() });
        return summaryOf(draft.ref.id);
      }
      const rid = `R${Object.keys(store.results).length + 1}`;
      store.results[rid] = [{ ...draft, ref: { id: rid, version: 1 } }];
      return summaryOf(rid);
    },
    async restore(_id, ref) {
      store.restores.push(ref);
      const versions = store.results[ref.id];
      versions.push({ ...versions[ref.version - 1], ref: { id: ref.id, version: versions.length + 1 }, change: `Restored V${ref.version}`, created: new Date().toISOString() });
      return summaryOf(ref.id);
    },
    async setCurrent(_id, ref) { store.currents.push(ref); store.current = ref; },
    // ---- E4: the columns engine (spec 007 §5.2), scripted
    async estimate(_id, input) {
      store.estimates.push(input);
      const base = store.results[input.on.id]?.[input.on.version - 1];
      const rows = input.rows === 'all' ? base.rows.length : Array.isArray(input.rows) ? input.rows.length : base.rows.length;
      const cells = rows * input.add.length;
      return { rows, cells, turns: Math.ceil(rows / 8), askFirst: rows > 50 || cells > 200, maxRows: 50, capped: rows > 400 };
    },
    async run(id, input) {
      const step = `S${++store.stepSeq}`;
      const st = { events: [], wake: null, cancelled: false, done: false };
      store.runs.push({ id, input, step });
      store.steps[step] = st;
      runFakeStep(store, input, st);
      return { step };
    },
    async *events(_id, step, after, signal) {
      const st = store.steps[step];
      let at = after;
      for (;;) {
        if (signal?.aborted) return;
        if (at < st.events.length) { const e = st.events[at++]; yield e; if (e.data.type === 'end') return; continue; }
        await new Promise((resolve) => { st.wake = resolve; signal?.addEventListener('abort', resolve, { once: true }); });
      }
    },
    async cancel(_id, step) { store.cancels.push(step); store.steps[step].cancelled = true; },
  };
}

/** Outside sources saved in this page: ai() builds a new service each call, so the list lives here. */
const MCP_SAVED = new Map();

/** A scripted AgentService: records every SendInput/ask() call (spec 005 §7) and answers with a canned "done".
 * @returns {any} loosely typed on purpose — ConversationId/ReviewId are branded strings (domain.d.ts) and this
 * is throwaway test scaffolding, not a second implementation to keep in sync with that branding. */
function scriptedAgentService(calls, reply, store, providers) {
  const answer = { text: 'ok', citations: [], structured: null, usage: {} };
  return {
    where: /** @type {"local"} */ ('local'),
    conversations: {
      list: async () => (store?.conversations ? store.conversations.map((c) => ({ ...c })) : []),
      load: async (id) => store?.recordsBy?.[id] ?? store?.records ?? [],
      create: async () => {
        if (!store?.conversations) return 'conv1';
        const id = `sess${store.conversations.length + 1}`;
        store.conversations.push({ id, mode: 'chat', title: 'New chat', updated: new Date().toISOString(), artifacts: 0, kind: 'chat' });
        return id;
      },
      rename: async (id, title) => { const c = store?.conversations?.find((x) => x.id === id); if (c) c.title = title; },
      remove: async (id) => { if (store?.conversations) store.conversations = store.conversations.filter((c) => c.id !== id); },
      adopt: async () => [],
      send(id, input) {
        calls.push({ kind: 'send', id, input });
        const stream = reply ? reply(input) : (async function* () { yield { type: 'done', answer }; })();
        if (!store) return stream;
        // as the engine does (spec 007 E5): the user record carries `on`, and the answer is an ordinary assistant record
        store.records.push({ type: 'user', text: input.text, attachments: [], web: 'off', ...(input.on ? { on: JSON.parse(JSON.stringify(input.on)) } : {}), at: new Date().toISOString() });
        return (async function* () {
          for await (const event of stream) {
            if (event.type === 'done') store.records.push({ type: 'assistant', answer: event.answer, model: { provider: 'x', model: 'y' }, activities: [], at: new Date().toISOString() });
            yield event;
          }
        })();
      },
    },
    ask(question, opts) {
      calls.push({ kind: 'ask', question, opts });
      if (reply) return reply({ text: question, ...opts });
      return (async function* () { yield { type: 'done', answer: { ...answer, structured: { status: 'answered', markdown: 'ok' } } }; })();
    },
    reviews: {
      list: async () => [],
      async estimate(req) {
        calls.push({ kind: 'review-estimate', req });
        // The engine's shape (agent-src/src/estimate.js): a typical run, the low and high ends, and `range` ("low-high") that the label shows.
        const [turns, low, high] = { fastest: [8, 6, 12], quick: [12, 9, 17], standard: [22, 16, 30], deep: [38, 28, 54] }[req.depth] ?? [22, 16, 30];
        return { turns, low, high, range: `${low}-${high}` };
      },
      async start(req) { calls.push({ kind: 'review', req }); return 'review1'; },
      watch: async function* () {},
      async approvePlan() {}, async answer() {}, async screened() {}, async resume() {}, async cancel() {}, async export() { return { path: '' }; },
    },
    providers: providers ?? { async status() { return []; }, async models() { return []; }, async signIn() { return { done: Promise.resolve(null) }; }, async signOut() {}, async roles() { return {}; }, async setRole() {} },
    // Outside sources (spec 020 G3): remembers what was saved, hides keys the way the runtime does
    // ({ set: true, last4 }; that marker sent back keeps the key), and refuses any key containing "bad" with a 401.
    mcp: (() => {
      const saved = MCP_SAVED;
      const secretName = (k) => /key|token|secret|password|authorization/i.test(k);
      const view = (c) => { const v = structuredClone(c); for (const bag of [v.env, v.headers]) for (const k of Object.keys(bag ?? {})) if (secretName(k) && typeof bag[k] === 'string' && bag[k]) bag[k] = { set: true, last4: bag[k].length >= 12 ? bag[k].slice(-4) : '' }; return v; };
      const report = (c) => { const bad = JSON.stringify(c).includes('bad'); return { config: view(c), state: bad ? 'failed' : 'connected', error: bad ? 'HTTP 401 Unauthorized' : null, tools: bad ? [] : [{ name: 'search', verdict: 'exposed' }, { name: 'fetch', verdict: 'exposed' }] }; };
      return {
        async list() { return [...saved.values()].map(report); },
        async save(c) {
          const old = saved.get(c.name);
          const next = structuredClone(c);
          for (const bag of ['env', 'headers']) for (const [k, v] of Object.entries(next[bag] ?? {})) if (v && typeof v === 'object' && v.set) next[bag][k] = old?.[bag]?.[k] ?? null;
          saved.set(c.name, next);
          /** @type {any} */ (window).__mcpSaved = Object.fromEntries(saved);
          return report(next);
        },
        async remove(name) { saved.delete(name); },
      };
    })(),
    settings: providers?.settings ?? { async get() { return {}; }, async update(p) { return p; } },
    sessions: fakeSessions(store ?? createSessionStore()),
    // the web shell's Home, Routines and Projects pages read these; absent unless the store sets them, so no other harness page changes
    ...(store?.routines ? { routines: { async list() { if (store.routinesFail) throw Object.assign(new Error('HTTP 503'), { status: 503 }); return structuredClone(store.routines); }, async runNow() { return { started: true }; }, async pause() {}, async resume() {}, async archive() {},
      // the web Sources page saves a radar here: kept in the list and in `store.saves` so a check can read what was written
      async create(d) { const r = { ...structuredClone(d), id: `r${store.routines.length + 1}`, status: 'active', running: false, nextRun: new Date(Date.now() + 3600_000).toISOString() }; store.saves = [...(store.saves ?? []), { kind: 'create', draft: structuredClone(d) }]; store.routines.push(r); return r; },
      async update(id, d) { const r = store.routines.find((x) => x.id === id); if (r) Object.assign(r, structuredClone(d)); store.saves = [...(store.saves ?? []), { kind: 'update', id, draft: structuredClone(d) }]; return r ?? d; },
      async adopt() { return []; } } } : {}),
    // the library's suggestions and the address checker, scripted by `store.radar` (invented names only)
    ...(store?.radar ? { radar: { async profile() { return structuredClone(store.radar.seed); }, async checkSource(input) { store.checked = [...(store.checked ?? []), input]; return structuredClone(store.radar.check(input)); }, async forgetTopic(routineId, text) { store.forgotten = [...(store.forgotten ?? []), { routineId, text }]; return { forgotten: true }; },
      // spec 021: the own-papers lookup and the calibration, invented
      async myPapers(input) { store.myPapersAsked = [...(store.myPapersAsked ?? []), input]; return structuredClone(store.radar.mine ?? { authors: [], chosen: null, papers: [], problem: 'No papers.' }); },
      // spec 012 R4 on Home too: a click is recorded; Undo goes back to shown
      async feedback(routineId, key, verdict) { store.feedback = [...(store.feedback ?? []), { routineId, key, verdict }]; return { verdict: verdict === 'undo' ? 'shown' : verdict, changed: true }; },
      async verdicts() { const out = {}; for (const f of store.feedback ?? []) { if (f.verdict === 'undo') delete out[f.key]; else out[f.key] = f.verdict; } return out; },
      async prepareSeeds(seeds) { store.prepared = [...(store.prepared ?? []), structuredClone(seeds)]; return { categories: ['q-bio.PE'], threshold: { abstract: 0.77, full: 0.81, calibration: null }, problem: null }; } } } : {}),
    ...(store?.projects ? { projects: { async list() { return structuredClone(store.projects); }, async create(name) { const p = { id: `p${store.projects.length + 1}`, name, created: '', updated: '' }; store.projects.push(p); return p; }, async rename() {}, async remove() {}, async assign() {}, async adopt() { return []; } } } : {}),
  };
}

/** spec 010: a scripted `ai.providers` with an "On this Mac" provider, for the Answer-with menu. `roles` is mutated by setRole; calls are recorded. */
/** @param {{ calls?: any[], status?: any, models?: any[], roles?: any, shown?: string[], cloudModels?: Record<string, any[]> }} [opts] `shown` seeds settings.shownModels (spec 016); `cloudModels` is what each cloud provider lists */
export function createLocalProviders({ calls = [], status, models, roles, shown, cloudModels } = {}) {
  /** @type {any} */
  const state = {
    status: status !== undefined ? status : { provider: 'local', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null, detail: '3 models found.' },
    models: models ?? LOCAL_MODELS,
    settings: { roles: {}, defaultModel: null, shownModels: shown ?? [], addedModels: [], endpoints: [] },
    roles: roles ?? { chat: { provider: 'codex', model: null }, ask: { provider: 'codex', model: null }, lead: { provider: 'codex', model: null }, researcher: { provider: 'codex', model: null }, writer: { provider: 'codex', model: null }, extract: null },
  };
  return {
    state,
    settings: {
      async get() { return { ...structuredClone(state.settings), roles: JSON.parse(JSON.stringify(state.roles)) }; },
      async update(patch) { calls.push({ kind: 'settings', patch: structuredClone(patch) }); Object.assign(state.settings, structuredClone(patch)); return structuredClone(state.settings); },
    },
    async status() { return [{ provider: 'codex', state: 'ready', version: null, account: { kind: 'chatgpt', label: null, plan: null }, usage: null, installHelp: null }, ...(state.status ? [state.status] : [])]; },
    async models(provider) { return provider === 'local' || provider === undefined ? state.models : (cloudModels ?? {})[provider] ?? []; },
    async signIn() { return { done: Promise.resolve(null) }; }, async signOut() {},
    async roles() { return JSON.parse(JSON.stringify(state.roles)); },
    async setRole(role, choice) { calls.push({ kind: 'setRole', role, choice }); if (state.refuse) throw new Error(state.refuse); state.roles[role] = choice; },
  };
}

export const LOCAL_MODELS = [
  { id: 'mlx:ConwayResearch/Underdog-Woof-4B-1.1', label: 'Underdog Woof 4B 1.1', isDefault: true, source: 'mlx', sizeBytes: 4.2 * 1024 ** 3, note: 'Best of the models tried here. Still gets some facts wrong.', unavailable: null },
  { id: 'mlx:ConwayResearch/Underdog-Woof-2B-1.1', label: 'Underdog Woof 2B 1.1', isDefault: false, source: 'mlx', sizeBytes: 2.1 * 1024 ** 3, note: 'Often refuses or misses answers.', unavailable: null },
  { id: 'ollama:a-model-with-a-really-long-name-that-should-wrap-instead-of-running-off-the-edge:latest', label: 'a-model-with-a-really-long-name-that-should-wrap-instead-of-running-off-the-edge:latest', isDefault: false, source: 'ollama', sizeBytes: null, note: 'Served by Ollama. Not tested on your library.', unavailable: null },
];

/**
 * @param {{ kind?: import("../../src/host").HostKind, placement?: import("../../src/host").Placement,
 *           can?: Partial<import("../../src/host").UiHost["can"]>, where?: "server" | "local" | "offline",
 *           calls?: unknown[], reply?: (input: any) => AsyncIterable<any>,
 *           context?: import("../../src/host").ContextItem[],
 *           candidates?: import("../../src/host").ContextCandidate[],
 *           sessionStore?: ReturnType<typeof createSessionStore>, saveFile?: boolean, providers?: any }} [opts] `calls`, when given, records every
 * SendInput/ask()/reviews.start() call; `reply`, when given, is the event stream every send/ask answers with;
 * `context` is what the user is looking at (change it with `_setContext`); `candidates` turns on the `+`/`@` picker; `sessionStore` is what `ai.sessions` reads and writes; `saveFile: false`
 * leaves the host without `saveFile` (the Download fallbacks), whose calls are otherwise recorded in `_saved`.
 * @returns {import("../../src/host").UiHost & { _saved: { name: string, text: string, mime: string }[], _setWhere(next: "server" | "local" | "offline"): void,
 *           _setContext(items: import("../../src/host").ContextItem[]): void,
 *           ready: Promise<void>, json(): Promise<any>, setContext(items: import("../../src/host").ContextItem[]): void, setOpenRef(): void, setBrowser(fn: ((url: string) => void) | null): void }}
 */
export function createFakeHost(opts = {}) {
  const prefsData = {};
  const filesData = new Map();
  let whereState = opts.where ?? 'server';
  const whereListeners = new Set();
  const contextListeners = new Set();
  let contextItems = opts.context ?? [];
  const candidates = opts.candidates;
  const saved = [];
  /** @type {((url: string) => void) | null} */ let browserHook = null;

  return {
    kind: opts.kind ?? 'zotero',
    placement: opts.placement ?? (opts.kind === 'web' ? 'page' : 'tab'),
    can: {
      scopes: opts.kind !== 'obsidian',
      addToLibrary: opts.kind !== 'obsidian' && opts.kind !== 'web',
      openInTab: opts.kind !== 'obsidian' && opts.kind !== 'web',
      notesWithoutServer: false,
      linksInside: opts.kind === 'web',
      ...opts.can,
    },

    async ai() {
      if (opts.calls) return scriptedAgentService(opts.calls, opts.reply, opts.sessionStore, opts.providers);
      throw new Error('fake-host: no AgentService (pass `calls: []` for a scripted one)');
    },
    where: () => whereState,
    onWhereChange(listener) {
      whereListeners.add(listener);
      return () => whereListeners.delete(listener);
    },
    // Test-only hook, not part of UiHost: lets a harness scenario flip the server up/down.
    _setWhere(next) { whereState = next; for (const l of whereListeners) l(); },

    prefs: {
      get: (key) => prefsData[key],
      set: (key, value) => { prefsData[key] = value; },
    },

    files: {
      async list(dir) { return [...filesData.keys()].filter((p) => p.startsWith(`${dir}/`)); },
      async read(path) { return filesData.has(path) ? filesData.get(path) : null; },
      async write(path, text) { filesData.set(path, text); },
      async remove(path) { filesData.delete(path); },
    },

    async context() { return contextItems; },
    // Test-only hook, not part of UiHost: what the user is looking at changes (a note opened, text selected).
    _setContext(items) { contextItems = items; for (const l of contextListeners) l(); },
    onContextChange(listener) {
      contextListeners.add(listener);
      return () => contextListeners.delete(listener);
    },
    async pickPapers() { return []; },
    async scopeNames() { return ['Invented Saved Search']; },
    async collections() { return COLLECTIONS; },
    ...(candidates ? { async contextCandidates() { return candidates; } } : {}),

    openRef() {},
    openLink(url, o) {
      // mirrors the web host (src/web/host.js): inside goes to the shell's browser panel, outside is recorded
      if (opts.kind === 'web' && !o?.outside && browserHook) browserHook(url);
      else (globalThis.__opened ??= []).push({ kind: 'url', url, outside: true });
    },
    setBrowser(fn) { browserHook = fn; },
    revealFile() {},
    ...(opts.kind === 'web' ? {} : { openInTab() {} }),

    async searchOutside() { return { papers: OUTSIDE_PAPERS, failed: [] }; },
    async addToLibrary(papers) { opts.calls?.push({ kind: 'add-to-library', titles: papers.map((p) => p.title), dois: papers.map((p) => p.doi) }); return { items: papers.map((_, i) => ({ key: `fake-${i}`, citekey: `fake${i}2026` })) }; },

    notice(text) { opts.calls?.push({ kind: 'notice', text }); },
    // the web host's extras (src/web/host.js), used by the shell
    ready: Promise.resolve(),
    async json() { return { coverage: [{ source: 'zotero', documents: 12 }, { source: 'personal', documents: 40 }], running: false }; },
    setContext(items) { contextItems = items; for (const l of contextListeners) l(); },
    setOpenRef() {},
    logError() {},
    mount(root) { document.body.appendChild(root); },

    // ---------- unit C1 additions (host.d.ts)
    async confirm() { return true; },
    async promptText(_message, initial) { return initial; },
    citeLabel() { return null; },
    async resolveLabel(citekey) { return citekey; },
    async searchLibrary() { return []; },
    async libraryPaperByKey() { return null; },
    async exportRows() { return true; },
    async writeFile() {},
    ...(opts.saveFile === false ? {} : { async saveFile(name, text, mime) { saved.push({ name, text, mime }); return { path: `/exports/${name}` }; } }),
    _saved: saved,
  };
}
