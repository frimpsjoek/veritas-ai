// @ts-check
// agent-src/src/library-http.js. A LibraryBackend backed by the Python server's HTTP API (http_api.py). Every
// request carries X-KB-Client: agent, which is what makes privacy.json and the audit log apply, the same as
// every other agent route. Used by the Node sidecar, the one agent runtime (Zotero and Obsidian are its clients).
import { citationKey } from './citations.js';
import { migrateScope } from './scope.js';

const PREFIX = 'zotero/';
/** The first /search after the server starts loads the embedding model: about 30 s was seen under load. */
const SEARCH_TIMEOUT_MS = 90_000;
const READ_TIMEOUT_MS = 30_000;
/** Reading new arXiv papers whole, or calibrating with some (spec 021): one PDF every 3 s on the server. */
const WHOLE_PAPERS_MS = 20 * 60_000;

/** A path the server returned: "zotero/<KEY>" is a paper, anything else a vault note.
 *  @param {string} pathValue @returns {import("./domain").CitationRef} */
function refFromPath(pathValue) {
  return pathValue.startsWith(PREFIX)
    ? { kind: 'paper', citekey: /** @type {import("./domain").Citekey} */ (pathValue.slice(PREFIX.length)) }
    : { kind: 'note', path: /** @type {import("./domain").NotePath} */ (pathValue) };
}

/** @param {import("./domain").CitationRef} ref */
function pathFromRef(ref) {
  if (ref.kind === 'note') return ref.path;
  if (ref.kind === 'paper') return `${PREFIX}${ref.citekey}`;
  return null; // web refs are not library reads
}

function snippetOf(hit) {
  return hit.passages?.[0]?.snippet ?? '';
}

function yearOf(hit) {
  const y = hit.zotero?.year;
  return typeof y === 'number' ? y : (typeof y === 'string' && /^\d{4}$/.test(y) ? Number(y) : null);
}

/**
 * The sidecar's NoteSink (review.js): POST /ai-note on the Python server. Deliberately sends no X-KB-Client
 * header — "agent" would put this route behind AGENT_ROUTES and get it refused (http_api.py), which is the
 * same "not available to agents" wall /agent/providers sits behind (design/final/rationale.md's P3 note).
 * @param {typeof fetch} fetchFn
 * @param {{ baseUrl: string }} opts
 * @returns {import("./service").NoteSink}
 */
export function createHttpNoteSink(fetchFn, opts) {
  return {
    async publish({ reviewId, title, markdown, frontMatter }) {
      const res = await fetchFn(new URL('/ai-note', opts.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folder: 'ai_notes/Literature Reviews', title, markdown, reviewId, frontMatter }),
      });
      if (!res.ok) throw new Error(`/ai-note: HTTP ${res.status}`);
      return res.json();
    },
  };
}

/**
 * The user's skills in the vault, through the server's /skills routes (http_api.py). Like the note sink it sends no
 * X-KB-Client header: these routes are for the plugins, and an agent's own calls to them are refused.
 * @param {typeof fetch} fetchFn
 * @param {{ baseUrl: string | (() => string), token?: string | null }} opts
 * @returns {import("./skills").SkillSource}
 */
export function createHttpSkillSource(fetchFn, opts) {
  const headers = { 'content-type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const url = (/** @type {string} */ route) => new URL(route, typeof opts.baseUrl === 'function' ? opts.baseUrl() : opts.baseUrl);
  const route = (/** @type {string} */ name) => `/skills/${encodeURIComponent(name)}`;
  async function failed(res, what) {
    const detail = await res.json().then((j) => j?.error, () => null);
    throw new Error(detail ? String(detail) : `${what}: HTTP ${res.status}`);
  }
  return {
    async list() {
      const res = await fetchFn(url('/skills'), { headers });
      if (!res.ok) await failed(res, '/skills');
      return res.json();
    },
    async get(name) {
      const res = await fetchFn(url(route(name)), { headers });
      if (res.status === 404) return null;
      if (!res.ok) await failed(res, '/skills');
      return res.json();
    },
    async put(name, text) {
      const res = await fetchFn(url(route(name)), { method: 'PUT', headers, body: JSON.stringify({ text }) });
      if (!res.ok) await failed(res, '/skills');
      return res.json();
    },
    async remove(name) {
      const res = await fetchFn(url(route(name)), { method: 'DELETE', headers });
      if (!res.ok) await failed(res, '/skills');
    },
  };
}

/**
 * @param {typeof fetch} fetchFn
 * @param {{ baseUrl: string, token?: string | null, searchTimeoutMs?: number, timeoutMs?: number }} opts
 * @returns {import("./tools").LibraryBackend}
 */
export function createHttpLibraryBackend(fetchFn, opts) {
  const headers = { 'X-KB-Client': 'agent', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) };
  const searchTimeoutMs = opts.searchTimeoutMs ?? SEARCH_TIMEOUT_MS;
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;

  /** A failure carries `status` (the HTTP status; 504 for a timeout), so a host that tells "server is gone" (no status,
   *  connection refused) from "server answered badly" does not mistake a slow or failing server for an absent one and
   *  quietly answer from a smaller index: that made a failed search look like zero results. */
  async function getJSON(routePath, params, limitMs = timeoutMs) {
    const url = new URL(routePath, opts.baseUrl);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    // Zotero's chrome scope has no AbortController, so the timer races the request and aborts it only where it can.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(Object.assign(new Error(`${routePath} did not answer within ${Math.round(limitMs / 1000)} seconds`), { kind: 'timeout', status: 504 }));
      }, limitMs);
    });
    const request = (async () => {
      const res = await fetchFn(url, { headers, ...(controller ? { signal: controller.signal } : {}) });
      if (res.status === 404) return null;
      if (!res.ok) throw Object.assign(new Error(`${routePath}: HTTP ${res.status}`), { status: res.status });
      return res.json();
    })();
    request.catch(() => {}); // a request that loses the race must not become an unhandled rejection
    try { return await Promise.race([request, timedOut]); } finally { clearTimeout(timer); }
  }

  /** JSON in, JSON out, for the radar's POST/PUT routes. A failure carries `status` like getJSON's. */
  async function sendJSON(method, routePath, body, limitMs = timeoutMs) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(Object.assign(new Error(`${routePath} did not answer within ${Math.round(limitMs / 1000)} seconds`), { kind: 'timeout', status: 504 }));
      }, limitMs);
    });
    const request = (async () => {
      const res = await fetchFn(new URL(routePath, opts.baseUrl), { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), ...(controller ? { signal: controller.signal } : {}) });
      if (!res.ok) throw Object.assign(new Error(`${routePath}: HTTP ${res.status}`), { status: res.status });
      return res.json().catch(() => ({}));
    })();
    request.catch(() => {});
    try { return await Promise.race([request, timedOut]); } finally { clearTimeout(timer); }
  }

  /** Spec 008 Z1: the collection tree, key/name/parent, fetched once and cached — only a pre-Z3 `{ kind:
   *  "collection"; name }` scope (an old review's request.json, a saved Find papers search; nothing on disk is
   *  ever rewritten) needs it, to map that name back to the key(s) the current `collections=` param wants. */
  let collectionsPromise = null;
  async function collections() {
    collectionsPromise ??= getJSON('/zotero/collections', {}).then((list) => list ?? []).catch(() => []);
    return collectionsPromise;
  }

  return {
    /** `scope` (Scope, domain.d.ts) narrows the Python server's /search the same way a Zotero-local search does
     *  (agent-host.js's scopeKeys): `collections` maps to `?collections=K1,K2` (http_api.py resolves each key's
     *  descendants server-side, kb.py's `_allowed`), a tag to the existing `tag` param. A savedSearch can't be
     *  resolved here — the server has no Zotero API to ask what it matches — so it runs as a whole-library
     *  search; chat.js's "Look in" labels that limitation instead of pretending it narrowed anything. */
    async search({ text, limit, only, scope, years }) {
      const params = { q: text, limit: limit ?? 8 };
      if (only === 'papers') params.source = 'zotero';
      else if (only === 'notes') params.exclude_source = 'zotero';
      // A pre-Z3 persisted scope (an old review's request.json, a saved Find papers search) may still literally
      // be `{ kind: "collection"; name }` at runtime even though Scope no longer declares it; treat it as
      // untrusted input here, same as domain.d.ts's comment on the type says every reader must.
      const legacy = /** @type {{ kind: unknown }} */ (scope);
      const resolved = legacy?.kind === 'collection' ? migrateScope(legacy, await collections()) : scope;
      if (resolved?.kind === 'collections' && resolved.keys.length) params.collections = resolved.keys.join(',');
      else if (resolved?.kind === 'tag') params.tag = resolved.name;
      if (years?.from != null) params.year_from = years.from;
      if (years?.to != null) params.year_to = years.to;
      const hits = (await getJSON('/search', params, searchTimeoutMs)) ?? [];
      return hits.map((hit) => ({ ref: refFromPath(hit.path), title: hit.title ?? hit.path, snippet: snippetOf(hit), year: yearOf(hit) }));
    },

    /** @param {import("./domain").CitationRef} ref @param {{ heading?: string, maxChars?: number }} [opts] */
    async read(ref, { heading, maxChars } = {}) {
      const relPath = pathFromRef(ref);
      if (!relPath) return null;
      const data = await getJSON('/note', { path: relPath, heading, max_chars: maxChars ?? 6000 });
      if (!data) return null;
      return { title: data.title ?? relPath, text: data.text ?? '' };
    },

    /** @param {import("./domain").CitationRef} ref @param {{ limit?: number }} [opts] */
    async related(ref, { limit } = {}) {
      const relPath = pathFromRef(ref);
      if (!relPath) return [];
      const data = await getJSON('/related', { path: relPath, limit: limit ?? 8 });
      if (!data) return [];
      return (data.similar ?? []).slice(0, limit ?? 8).map((n) => ({ ref: refFromPath(n.path), title: n.title ?? n.path, snippet: 'Related by meaning.' }));
    },

    /** @param {{ collections: string[] | null }} q */
    async items({ collections }) {
      const data = await getJSON('/zotero/items', collections?.length ? { collections: collections.join(',') } : {}, searchTimeoutMs);
      if (!data) throw new Error('/zotero/items: this server is too old for the radar');
      return data.items ?? [];
    },

    /** @param {import("./radar-types").ScoreRequest} q */
    async radarScore(q) {
      const data = await sendJSON('POST', '/radar/score', q, searchTimeoutMs);
      return data?.scores ?? {};
    },

    /** @param {{ scope: import("./radar-types").ScoreScope, seeds?: { keys: string[] } }} q */
    async radarProfile(q) {
      return sendJSON('POST', '/radar/profile', q, searchTimeoutMs);
    },

    /** Spec radar-seeds G3. The server reads each PDF at most one every 3 s, so 40 papers can take minutes.
     *  @param {{ seeds: import("./radar-types").SeedBody, items: { id: string, arxiv: string }[], baseline?: import("./radar-types").SeedBaseline | null }} q */
    async radarFulltext(q) {
      const data = await sendJSON('POST', '/radar/fulltext', q, WHOLE_PAPERS_MS);
      return data?.scores ?? {};
    },

    /** Spec radar-seeds G4. @param {{ seeds: import("./radar-types").SeedBody, unrelated: { title: string, abstract: string, arxiv: string | null }[], field?: { title: string, abstract: string, arxiv: string | null }[], full_papers?: number }} q */
    async radarCalibrate(q) {
      return sendJSON('POST', '/radar/calibrate', q, WHOLE_PAPERS_MS);
    },

    /** @param {string} file @param {string} text */
    async writeDigest(file, text) {
      await sendJSON('PUT', `/digests/${encodeURIComponent(file)}`, { text });
    },

    async resolve(refs) {
      const map = new Map();
      for (const ref of refs) {
        const key = citationKey(ref); // the validator looks results up by this exact key
        if (map.has(key)) continue;
        const relPath = pathFromRef(ref);
        try {
          const data = relPath ? await getJSON('/note', { path: relPath, max_chars: 1 }) : null;
          map.set(key, data ? { title: data.title ?? relPath } : null);
        } catch {
          map.set(key, null);
        }
      }
      return map;
    },
  };
}
