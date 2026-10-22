// @ts-check
// ui-src/src/web/host.js. The browser's UiHost (host.d.ts): the shared chat, Find papers and reports running as a
// page served by the Second Brain server, with neither Zotero nor Obsidian open. Everything goes to the server the
// page came from, so no CORS is involved and nothing is fetched from another origin.
import { createRemoteRuntime } from '../../../agent-src/src/remote.js';
import { createFetchApi, createWebTransport } from './transport.js';
import { createDialogs } from './dialogs.js';
import { linkMode, planOpen } from '../links.js';

/** @typedef {import("../host").UiHost} UiHost */
/** @typedef {import("../host").ContextItem} ContextItem */
/** @typedef {import("../host").LibraryPaperRow} LibraryPaperRow */

const VAULT = 'Second-Brain';
const PREFS_FLUSH_MS = 300;

/** @param {any} hit a /search result */
function paperRow(hit) {
  if (!hit?.zotero) return null;
  const key = String(hit.path).replace(/^zotero\//, '');
  return /** @type {LibraryPaperRow} */ ({
    ref: { kind: 'paper', citekey: hit.zotero.citekey || key },
    title: hit.title, authors: hit.zotero.authors ?? [],
    year: hit.zotero.year ? Number(hit.zotero.year) || null : null,
    venue: hit.zotero.venue ?? '', doi: hit.zotero.doi || null,
    abstract: (hit.passages ?? []).map((/** @type {any} */ p) => p.snippet).join(' ').slice(0, 1500),
    key,
  });
}

/** @param {any} item a /zotero?key= result */
function rowFromItem(item) {
  const authors = (item.creators ?? []).filter((/** @type {any} */ c) => c.role === 'author' || item.creators.every((/** @type {any} */ x) => x.role !== 'author')).map((/** @type {any} */ c) => c.name);
  return /** @type {LibraryPaperRow} */ ({
    ref: { kind: 'paper', citekey: item.citekey || item.key },
    title: item.title, authors, year: item.year ? Number(item.year) || null : null,
    venue: item.venue ?? '', doi: item.doi || null, abstract: String(item.abstract ?? '').slice(0, 1500), key: item.key,
  });
}

/** Short author label for a citation chip: "Smith & Jones 2021", "Smith et al. 2021". @param {any} item */
function citationLabel(item) {
  const authors = (item.creators ?? []).filter((/** @type {any} */ c) => c.role === 'author' || item.creators.every((/** @type {any} */ x) => x.role !== 'author'));
  const last = (/** @type {any} */ a) => String(a.name).split(' ').pop();
  const names = authors.length > 2 ? `${last(authors[0])} et al.` : authors.map(last).join(' & ');
  return [names, item.year].filter(Boolean).join(' ');
}

/**
 * @param {{ base?: string, doc?: Document, win?: Window, fetch?: typeof fetch, onOpenRef?: (ref: import("../../../agent-src/src/domain").CitationRef) => boolean | void, onSignedOut?: (() => void) | null }} [options]
 *   `onOpenRef` lets the shell show a paper or note itself; returning true means it did. The default is a deep link
 *   into Zotero or Obsidian.
 * @returns {UiHost & { ready: Promise<void>, json(path: string, method?: "GET" | "POST" | "DELETE" | "PATCH", body?: unknown): Promise<any>, setContext(items: ContextItem[]): void, setOpenRef(fn: ((ref: any) => boolean | void) | null): void, setBrowser(fn: ((url: string) => void) | null): void }}
 */
export function createWebHost(options = {}) {
  const doc = options.doc ?? document;
  const win = /** @type {any} */ (options.win ?? doc.defaultView ?? window);
  const base = options.base ?? win.location.origin;
  let openRefHook = options.onOpenRef ?? null;
  /** @type {((url: string) => void) | null} */ let browserHook = null;

  /** @type {"server" | "offline"} */
  let whereState = 'server';
  const whereListeners = new Set();
  /** @type {any} */ let pingTimer = null;
  const setReachable = (/** @type {boolean} */ up) => {
    const next = up ? 'server' : 'offline';
    if (next === whereState) return;
    whereState = next;
    for (const listener of whereListeners) listener();
    if (!up && !pingTimer) {
      pingTimer = setInterval(() => { void api.call('/ping').catch(() => {}); }, 10000);
    } else if (up && pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  };
  const api = createFetchApi(base, { fetch: options.fetch, onReachable: setReachable });
  const dialogs = createDialogs(doc);

  // ---- remembered state: held in memory so prefs.get stays synchronous, written through to the server
  /** @type {Record<string, unknown>} */ let prefsCache = {};
  /** @type {Record<string, string>} */ let filesCache = {};
  /** @type {Record<string, unknown>} */ let pendingPrefs = {};
  /** @type {any} */ let flushTimer = null;
  const flushPrefs = async () => {
    flushTimer = null;
    const batch = pendingPrefs;
    pendingPrefs = {};
    if (!Object.keys(batch).length) return;
    try { await api.call('/web/state', 'POST', { prefs: batch }); } catch (error) { host.logError(error); }
  };
  const ready = api.call('/web/state').then((state) => {
    const loaded = /** @type {any} */ (state) ?? {};
    // anything set before the load finished wins over what the server had
    prefsCache = { ...(loaded.prefs ?? {}), ...prefsCache };
    filesCache = { ...(loaded.files ?? {}), ...filesCache };
  }).then(async () => {
    // Add to Zotero only where the server has a Zotero library (spec 018); without one, papers are kept to read later.
    const sources = /** @type {any} */ (await api.call('/sources').catch(() => null));
    if (sources && 'zotero' in sources) host.can.addToLibrary = Boolean(sources.zotero);
  }).catch((/** @type {any} */ error) => {
    // A phone that has not signed in yet gets 401: the sign-in page (login.html next to index.html) takes it from here.
    if (error?.status === 401 && options.onSignedOut !== null) (options.onSignedOut ?? (() => win.location.replace(new URL('login', win.location.href).href)))();
  });

  const transport = createWebTransport(api);
  /** @type {Promise<import("../../../agent-src/src/service").AgentService> | null} */
  let service = null;

  /** @type {ContextItem[]} */ let contextItems = [];
  const contextListeners = new Set();

  /** zotero/KEY for a citekey or item key, as /links resolves it. @type {Map<string, string>} */
  const keyCache = new Map();
  async function resolveKey(/** @type {string} */ citekey) {
    const cached = keyCache.get(citekey);
    if (cached) return cached;
    for (const path of /^[A-Z0-9]{8}$/.test(citekey) ? [`@${citekey}`, `zotero/${citekey}`] : [`@${citekey}`]) {
      try {
        const info = await api.call(`/links?${new URLSearchParams({ path })}`);
        const found = /** @type {any} */ (info)?.path;
        if (found) { keyCache.set(citekey, found); return /** @type {string} */ (found); }
      } catch { /* try the next form */ }
    }
    return null;
  }
  /** @type {Map<string, string>} */ const labelCache = new Map();

  /** @type {ReturnType<typeof createWebHost>} */
  const host = {
    kind: 'web',
    placement: 'page',
    can: { scopes: true, addToLibrary: true, openInTab: false, notesWithoutServer: false, linksInside: true },
    ready,
    json: (path, method, body) => api.call(path, method, body),

    ai() {
      service ??= Promise.resolve(createRemoteRuntime(transport));
      return service;
    },
    where: () => whereState,
    onWhereChange(listener) {
      whereListeners.add(listener);
      return () => whereListeners.delete(listener);
    },

    prefs: {
      get: (key) => /** @type {any} */ (prefsCache[key]),
      set(key, value) {
        if (value === undefined) delete prefsCache[key]; else prefsCache[key] = value;
        pendingPrefs[key] = value === undefined ? null : value;
        flushTimer ??= setTimeout(() => void flushPrefs(), PREFS_FLUSH_MS);
      },
    },
    files: {
      async list(dir) { return Object.keys(filesCache).filter((path) => path.startsWith(`${dir}/`)); },
      async read(path) { return Object.hasOwn(filesCache, path) ? filesCache[path] : null; },
      async write(path, text) {
        await api.call('/web/state', 'POST', { files: { [path]: text } });
        filesCache[path] = text;
      },
      async remove(path) {
        await api.call('/web/state', 'POST', { files: { [path]: null } });
        delete filesCache[path];
      },
    },

    async context() { return contextItems; },
    setContext(items) {
      contextItems = items;
      for (const listener of contextListeners) listener();
    },
    onContextChange(listener) {
      contextListeners.add(listener);
      return () => contextListeners.delete(listener);
    },
    async pickPapers() {
      const rows = await dialogs.pickRows(async (query) => {
        const hits = /** @type {any[]} */ (await api.call(`/search?${new URLSearchParams({ q: query, source: 'zotero', limit: '20' })}`));
        return hits.filter((hit) => hit.zotero).map((hit) => ({
          id: hit.path, title: hit.title, detail: [hit.zotero.authors?.[0], hit.zotero.year].filter(Boolean).join(' · '),
          citekey: hit.zotero.citekey || String(hit.path).replace(/^zotero\//, ''),
        }));
      });
      return rows.map((row) => ({ attachment: /** @type {any} */ ({ kind: 'zoteroItem', citekey: row.citekey }), label: row.title, why: /** @type {const} */ ('selected') }));
    },
    async contextCandidates() {
      const [collections, recent] = await Promise.all([
        api.call('/zotero/collections').catch(() => []),
        api.call(`/recent?${new URLSearchParams({ days: '3650', limit: '400' })}`).catch(() => []),
      ]);
      return [
        .../** @type {any[]} */ (collections).map((c) => ({ category: /** @type {const} */ ('collection'), label: c.name, attachment: /** @type {any} */ ({ kind: 'collection', name: c.name }) })),
        .../** @type {any[]} */ (recent).map((r) => {
          const paper = String(r.path).startsWith('zotero/');
          const folder = paper ? undefined : String(r.path).split('/').slice(0, -1).join('/') || undefined;
          return /** @type {import("../host").ContextCandidate} */ ({
            category: paper ? 'paper' : 'note', label: r.title, detail: folder,
            attachment: paper ? { kind: 'zoteroItem', citekey: String(r.path).slice('zotero/'.length) } : { kind: 'note', path: r.path },
          });
        }),
      ];
    },
    // Zotero tags and saved searches are not in the index, so (like Obsidian) there is nothing to list for them
    async scopeNames() { return []; },
    collections: () => /** @type {any} */ (api.call('/zotero/collections').catch(() => [])),

    openRef(ref) {
      if (openRefHook?.(ref)) return;
      if (ref.kind === 'paper') {
        void (async () => {
          const path = await resolveKey(ref.citekey);
          if (!path) { host.notice(`Couldn't find @${ref.citekey} in your library.`); return; }
          win.location.assign(`zotero://select/library/items/${path.replace(/^zotero\//, '')}`);
        })();
      } else if (ref.kind === 'note') {
        win.location.assign(`obsidian://open?vault=${encodeURIComponent(VAULT)}&file=${encodeURIComponent(ref.path.replace(/\.md$/, ''))}`);
      } else if (ref.kind === 'web') {
        host.openLink(ref.url);
      }
    },
    setOpenRef(fn) { openRefHook = fn; },
    /** Spec 015: inside the browser panel (shell.js sets it) unless the link is marked outside, the setting says outside,
     *  or it is not a web page (zotero:, obsidian:). */
    openLink(url, opts) {
      let abs = url;
      try { abs = new URL(url, win.location.href).href; } catch { /* left as given */ }
      const plan = planOpen(abs, opts, { mode: linkMode(host.prefs), hasBrowser: Boolean(browserHook) });
      if (plan === 'scheme') win.location.assign(url);
      else if (plan === 'outside') win.open(abs, '_blank', 'noopener');
      else browserHook?.(abs);
    },
    setBrowser(fn) { browserHook = fn; },
    revealFile(path) { host.notice(`Saved to ${path}`); },

    // The page never fetches other origins itself; the sidecar searches the outside sources for it.
    async searchOutside(query, perSource) {
      try {
        return await (await host.ai()).scholarly.search(query, perSource);
      } catch (error) {
        return { papers: [], failed: [`outside sources (${error instanceof Error ? error.message : 'server unavailable'})`] };
      }
    },

    notice: (text) => dialogs.notice(text),
    logError(error) { console.error(error); },
    mount(root) { doc.body.appendChild(root); },

    confirm: (message, opts) => dialogs.confirm(message, opts),
    promptText: (message, initial, opts) => dialogs.promptText(message, initial, opts),
    citeLabel(citekey) {
      const label = labelCache.get(citekey);
      return label ? { label } : null;
    },
    async resolveLabel(citekey) {
      const cached = labelCache.get(citekey);
      if (cached) return cached;
      let label = citekey;
      try {
        const path = await resolveKey(citekey);
        if (path) label = citationLabel(await api.call(`/zotero?${new URLSearchParams({ key: path.replace(/^zotero\//, '') })}`)) || citekey;
      } catch { /* the citekey itself is the answer, as the contract says */ }
      labelCache.set(citekey, label);
      return label;
    },

    async addToLibrary(papers) {
      const reply = /** @type {any} */ (await api.call('/zotero/add', 'POST', { papers }));
      const results = /** @type {{ status: string, key?: string, id?: string }[]} */ (reply.results ?? []);
      const queued = results.some((r) => r.status === 'queued');
      if (results.some((r) => r.status === 'added')) host.notice(queued ? 'Some papers were added to Zotero; the rest will be added when Zotero opens.' : 'Added to Zotero');
      else if (queued) host.notice('Will be added when Zotero opens');
      // A queued paper has no Zotero key yet; its queue id stands in so the UI shows it as taken care of.
      return { items: results.map((r) => {
        if (r.status === 'failed') return null;
        const key = r.status === 'added' && r.key ? r.key : `queued-${r.id}`;
        return { key, citekey: key };
      }) };
    },

    async searchLibrary(query, _scope, limit) {
      try {
        const hits = /** @type {any[]} */ (await api.call(`/search?${new URLSearchParams({ q: query, source: 'zotero', limit: String(limit) })}`));
        return hits.map(paperRow).filter((row) => row != null);
      } catch { return []; }
    },
    async libraryPaperByKey(key) {
      try { return rowFromItem(await api.call(`/zotero?${new URLSearchParams({ key })}`)); } catch { return null; }
    },

    async exportRows(text, format, suggestedName) {
      download(doc, win, suggestedName, text, format === 'ris' ? 'application/x-research-info-systems' : 'text/csv');
      return true;
    },
    async writeFile(path, text) {
      download(doc, win, path.split('/').pop() || 'export.txt', text, 'text/plain');
    },
    async saveFile(name, text, mime) {
      download(doc, win, name, text, mime);
      host.notice(`Downloaded ${name}`);
      return {};
    },
  };
  return host;
}

/** @param {Document} doc @param {any} win @param {string} name @param {string} text @param {string} mime */
function download(doc, win, name, text, mime) {
  const link = /** @type {HTMLAnchorElement} */ (doc.createElementNS('http://www.w3.org/1999/xhtml', 'a'));
  link.href = win.URL.createObjectURL(new win.Blob([text], { type: mime }));
  link.download = name;
  doc.body.append(link);
  link.click();
  link.remove();
  win.setTimeout(() => win.URL.revokeObjectURL(link.href), 4000);
}
