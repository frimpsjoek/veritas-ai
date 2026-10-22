// @ts-check
// agent-src/src/radar.js. Spec 012 R1: pure radar logic. A raw paper from any source becomes a RadarItem; duplicates
// across sources merge; what the library or the seen set already holds is dropped; the top rows are picked. No fs,
// no network, no clock.

/** @typedef {import("./radar-types").RadarItem} RadarItem */
/** @typedef {import("./radar-types").RawPaper} RawPaper */
/** @typedef {import("./radar-types").RadarConfig} RadarConfig */

export const DATABASES = ['openalex', 'semanticscholar', 'arxiv', 'crossref', 'europepmc', 'biorxiv', 'chemrxiv'];

export const normTitle = (/** @type {unknown} */ t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const normDoi = (/** @type {unknown} */ d) => String(d ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '');
const normArxiv = (/** @type {unknown} */ a) => String(a ?? '').trim().toLowerCase().replace(/^arxiv:\s*/, '').replace(/v\d+$/, '');
/** arXiv's own DOI form: 10.48550/arXiv.2401.01234. */
const arxivOfDoi = (/** @type {string} */ doi) => /^10\.48550\/arxiv\.(.+)$/.exec(doi)?.[1] ?? null;
/** A title shorter than this is too generic to join two records on ("Introduction"). */
const MIN_TITLE_KEY = 20;

/** Every identity a paper answers to, strongest first. @param {{ doi?: string | null, arxiv?: string | null, title?: string }} p @returns {string[]} */
export function keysOf(p) {
  const keys = [];
  const doi = normDoi(p.doi);
  const arxiv = normArxiv(p.arxiv) || (doi && arxivOfDoi(doi)) || '';
  if (doi) keys.push(`doi:${doi}`);
  if (arxiv) keys.push(`arxiv:${arxiv}`);
  const title = normTitle(p.title);
  if (title.length >= MIN_TITLE_KEY) keys.push(`title:${title}`);
  return keys;
}

/** The id a row is stored and shown under: the first key. Falls back to a short title key. @param {{ doi?: string | null, arxiv?: string | null, title?: string }} p */
export const paperId = (p) => keysOf(p)[0] ?? `title:${normTitle(p.title)}`;

/** @param {RawPaper} raw @param {string} sourceId @returns {RadarItem | null} */
export function normalise(raw, sourceId) {
  const title = String(raw.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const doi = normDoi(raw.doi) || null;
  const arxiv = normArxiv(raw.arxiv) || (doi && arxivOfDoi(doi)) || null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date ?? '') ? /** @type {string} */ (raw.date) : null;
  const url = raw.url || (doi ? `https://doi.org/${doi}` : arxiv ? `https://arxiv.org/abs/${arxiv}` : null);
  return {
    id: paperId({ doi, arxiv, title }), doi, arxiv, openalexId: raw.openalexId ?? null, title,
    authors: (raw.authors ?? []).map((a) => String(a).trim()).filter(Boolean),
    venue: String(raw.venue ?? '').trim(), date, year: raw.year ?? (date ? Number(date.slice(0, 4)) : null),
    abstract: String(raw.abstract ?? '').trim(), url, links: url ? [url] : [], sources: [sourceId], kind: raw.kind || null,
    ...(raw.keywords?.length ? { keywords: raw.keywords } : {}),
  };
}

/**
 * Which record kinds a database, journal or author source may bring in (OpenAlex `type` words). R5 tunes this table.
 * A kind not listed, and a record with none, is kept: only a known non-paper is a reason to hide something.
 */
export const RECORD_KINDS = Object.freeze({
  article: true, preprint: true, review: true, 'book-chapter': true, proceedings: true, book: true,
  dataset: false, dissertation: false, other: false, paratext: false, 'peer-review': false, erratum: false, editorial: false, letter: false,
});
/** Repositories that hold uploads, not papers: the venue, the link's host or the DOI prefix gives them away. */
const REPOSITORY = /zenodo|figshare|repositor|dspace|eprints|scholarworks|digital ?commons/i;
const REPOSITORY_HOST = /(^|\.)(zenodo\.org|figshare\.com)$/i;
const REPOSITORY_DOI = /^10\.(5281|6084)\//;

/** True for a record that is not a paper: a dataset, thesis or other non-paper kind, or a repository upload. @param {RadarItem} it */
export function isNonPaper(it) {
  if (it.kind && RECORD_KINDS[/** @type {keyof typeof RECORD_KINDS} */ (it.kind)] === false) return true;
  let host = '';
  try { host = new URL(it.url ?? '').hostname; } catch { /* no usable link */ }
  return REPOSITORY.test(it.venue) || REPOSITORY_HOST.test(host) || REPOSITORY_DOI.test(it.doi ?? '');
}

const isPreprintVenue = (/** @type {string} */ v) => !v || /arxiv|rxiv|preprint|ssrn|research square/i.test(v);

/** Folds `b` into `a`: a journal version leads over a preprint, links and sources from both stay. @param {RadarItem} a @param {RadarItem} b @returns {RadarItem} */
function fold(a, b) {
  const lead = isPreprintVenue(a.venue) && !isPreprintVenue(b.venue) ? b : a;
  const other = lead === a ? b : a;
  const pick = (/** @type {any} */ x, /** @type {any} */ y) => x || y;
  const doi = pick(lead.doi, other.doi), arxiv = pick(lead.arxiv, other.arxiv);
  return {
    ...lead, doi, arxiv, openalexId: pick(lead.openalexId, other.openalexId), kind: pick(lead.kind, other.kind),
    authors: lead.authors.length >= other.authors.length ? lead.authors : other.authors,
    abstract: lead.abstract.length >= other.abstract.length ? lead.abstract : other.abstract,
    date: [lead.date, other.date].filter(Boolean).sort()[0] ?? null,
    year: lead.year ?? other.year,
    url: pick(lead.url, other.url),
    links: [...new Set([...lead.links, ...other.links])],
    sources: [...new Set([...lead.sources, ...other.sources])],
    id: paperId({ doi, arxiv, title: lead.title }),
  };
}

/**
 * One row per paper: items sharing a DOI, else an arXiv id, else a normalised title are the same paper. Joins are
 * transitive (a preprint and a journal version linked only through a third record still merge).
 * @param {RadarItem[]} items @returns {RadarItem[]}
 */
export function mergeItems(items) {
  /** @type {(RadarItem | null)[]} */
  const slots = [];
  /** @type {Map<string, number>} */
  const at = new Map();
  for (const item of items) {
    let target = -1;
    for (const key of keysOf(item)) { const hit = at.get(key); if (hit != null) { target = hit; break; } }
    if (target < 0) { target = slots.length; slots.push(item); }
    else {
      slots[target] = fold(/** @type {RadarItem} */ (slots[target]), item);
      for (const key of keysOf(item)) {
        const other = at.get(key);
        if (other != null && other !== target && slots[other]) {
          slots[target] = fold(/** @type {RadarItem} */ (slots[target]), /** @type {RadarItem} */ (slots[other]));
          slots[other] = null;
          for (const [k, v] of at) if (v === other) at.set(k, target);
        }
      }
    }
    for (const key of keysOf(/** @type {RadarItem} */ (slots[target]))) at.set(key, target);
  }
  return /** @type {RadarItem[]} */ (slots.filter(Boolean));
}

/**
 * Drops what the library holds (DOI, arXiv id, title) and what an earlier digest showed. Both are matched on every
 * identity the item has, so a preprint seen last week hides its journal version today.
 * @param {RadarItem[]} items
 * @param {{ doi?: string | null, title?: string }[]} library
 * @param {Record<string, unknown>} seen
 * @returns {RadarItem[]}
 */
export function dropKnown(items, library, seen) {
  const known = new Set();
  for (const l of library) for (const k of keysOf({ doi: l.doi, title: l.title })) known.add(k);
  return items.filter((it) => !keysOf(it).some((k) => known.has(k) || k in seen));
}

/** Highest score first; ties go to the newer paper, then id, so a run is deterministic. @param {RadarItem[]} scored @param {number} n */
export function pickTop(scored, n) {
  return [...scored]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.date ?? '').localeCompare(a.date ?? '') || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, n));
}

// ---------- config validation (the boundary: routines.create / update) ----------

const origin = (/** @type {any} */ o) => (['seed', 'user', 'learned'].includes(o) ? o : 'user');
const weight = (/** @type {any} */ w) => (typeof w === 'number' && Number.isFinite(w) && w > 0 ? Math.min(w, 10) : 1);
const str = (/** @type {any} */ v) => (typeof v === 'string' ? v.trim() : '');

/** @param {any} list @param {string} what */
function followed(list, what) {
  return (Array.isArray(list) ? list : []).map((f) => {
    const name = str(f?.name);
    if (!name) throw new Error(`A ${what} needs a name.`);
    return { name, openalexId: str(f.openalexId) || null, weight: weight(f.weight), origin: origin(f.origin), ...(str(f.match) ? { match: str(f.match) } : {}) };
  });
}

/** @param {any} s @param {number} i @returns {import("./radar-types").RadarSource} */
const MCP_ARGS_MAX = 4096;

/** Ready-made MCP sources for the setup screen; "{query}" in `args` becomes the topic. */
export const MCP_PRESETS = Object.freeze({
  // Search ranks by relevance across all years, so trending is added for recent papers; the date filter and the
  // score floor keep only new, on-topic rows. Daily Papers by date rejects 2026 dates (hf_fs EINVAL, 2026-10-11).
  huggingface: Object.freeze({ server: 'huggingface', tool: 'hf_fs', args: Object.freeze({ operations: [{ cmd: 'search', args: ['hf://papers', '{query}'] }, { cmd: 'ls', args: ['hf://papers/trending'] }] }) }),
});

/** @param {any} s @param {number} i */
function source(s, i) {
  const on = s?.on !== false;
  const need = (/** @type {string} */ v, /** @type {string} */ msg) => { if (!v) throw new Error(msg); return v; };
  switch (s?.kind) {
    case 'database': {
      if (!DATABASES.includes(s.db)) throw new Error(`Unknown database "${s.db}".`);
      return { id: str(s.id) || `database:${s.db}`, on, kind: 'database', db: s.db };
    }
    case 'feed': {
      const url = need(str(s.url), 'A feed needs its address.');
      if (!/^https?:\/\//i.test(url)) throw new Error('A feed address starts with http:// or https://.');
      return { id: str(s.id) || `feed:${url}`, on, kind: 'feed', url, title: str(s.title) || url };
    }
    case 'journal': {
      const openalexId = need(str(s.openalexId), 'A journal needs its OpenAlex id.');
      return { id: str(s.id) || `journal:${openalexId}`, on, kind: 'journal', openalexId, name: str(s.name) || openalexId, issn: str(s.issn) || null };
    }
    case 'author': {
      const openalexId = need(str(s.openalexId), 'An author needs their OpenAlex id.');
      return { id: str(s.id) || `author:${openalexId}`, on, kind: 'author', openalexId, name: str(s.name) || openalexId };
    }
    case 'mcp': {
      const server = need(str(s.server), 'An MCP source needs a server.'), tool = need(str(s.tool), 'An MCP source needs a tool.');
      if (s.args !== undefined) {
        if (!s.args || typeof s.args !== 'object' || Array.isArray(s.args)) throw new Error('The MCP arguments must be an object.');
        if (JSON.stringify(s.args).length > MCP_ARGS_MAX) throw new Error('The MCP arguments are too long.');
      }
      return { id: str(s.id) || `mcp:${server}/${tool}`, on, kind: 'mcp', server, tool, ...(s.args !== undefined ? { args: s.args } : {}) };
    }
    default: throw new Error(`Source ${i + 1} is not a database, feed, journal, author or MCP tool.`);
  }
}

/**
 * Checks a radar config and fills defaults. Throws an Error with a plain-language message.
 * @param {any} radar @returns {RadarConfig}
 */
export function validateRadar(radar) {
  if (!radar || typeof radar !== 'object') throw new Error('A reading radar needs its settings.');
  const scope = radar.scope ?? { kind: 'library' };
  if (!['library', 'collections', 'tag', 'savedSearch'].includes(scope.kind)) throw new Error('The radar reads from the whole library or from collections.');
  if (scope.kind === 'collections' && !(Array.isArray(scope.keys) && scope.keys.length)) throw new Error('Pick at least one collection.');
  const p = radar.profile ?? {};
  const topics = (Array.isArray(p.topics) ? p.topics : []).map((/** @type {any} */ t) => {
    const text = str(t?.text);
    if (!text) throw new Error('A topic needs some words.');
    return { text, weight: weight(t.weight), origin: origin(t.origin) };
  });
  const sources = (Array.isArray(radar.sources) ? radar.sources : []).map(source);
  const ids = new Set();
  for (const s of sources) { if (ids.has(s.id)) throw new Error('The same source is listed twice.'); ids.add(s.id); }
  const size = radar.size ?? {};
  const fresh = size.fresh ?? 8, older = size.older ?? 1, discover = size.discover ?? 3;
  if (!Number.isInteger(fresh) || fresh < 1 || fresh > 50) throw new Error('A radar shows between 1 and 50 new papers.');
  if (!Number.isInteger(older) || older < 0 || older > 20) throw new Error('A radar shows between 0 and 20 older papers.');
  if (!Number.isInteger(discover) || discover < 0 || discover > 10) throw new Error('A radar shows between 0 and 10 papers that might interest you.');
  const seeds = radar.seeds == null ? undefined : validSeeds(radar.seeds);
  const threshold = radar.threshold == null ? undefined : validThreshold(radar.threshold);
  return { scope, profile: { topics, authors: followed(p.authors, 'followed author'), journals: followed(p.journals, 'watched journal') }, sources, size: { fresh, older, discover }, note: radar.note !== false,
    ...(seeds ? { seeds } : {}), ...(threshold ? { threshold } : {}) };
}

export const MIN_SEEDS = 3;
const strings = (/** @type {any} */ v) => (Array.isArray(v) ? [...new Set(v.map(str).filter(Boolean))] : []);

/** Spec radar-seeds G1. @param {any} s @returns {import("./radar-types").RadarSeeds} */
function validSeeds(s) {
  if (typeof s !== 'object') throw new Error('The seed papers are not in a form the radar understands.');
  const mine = (Array.isArray(s.mine) ? s.mine : []).map((/** @type {any} */ m) => {
    const title = str(m?.title);
    if (!title) throw new Error('One of your papers has no title.');
    return { title, year: Number.isInteger(m.year) ? m.year : null, doi: str(m.doi) || null, key: str(m.key) || null, abstract: str(m.abstract).slice(0, 4000), openalexId: str(m.openalexId) || null };
  });
  const papers = strings(s.papers), collections = strings(s.collections);
  // A paper of yours without the library and without an abstract has nothing to compare with.
  const usable = mine.filter((/** @type {any} */ m) => m.key || m.abstract).length + papers.length;
  if (!collections.length && usable < MIN_SEEDS) throw new Error(`Pick at least ${MIN_SEEDS} papers for the radar to start from.`);
  const author = s.author && typeof s.author === 'object' && str(s.author.name)
    ? { name: str(s.author.name), orcid: str(s.author.orcid) || null, openalexId: str(s.author.openalexId) || null } : null;
  const categories = strings(s.categories).filter((c) => /^[a-z-]+(\.[A-Za-z-]+)?$/.test(c)).slice(0, 8);
  return { mine, papers, collections, author, categories };
}

/** Spec radar-seeds G4. @param {any} t @returns {import("./radar-types").RadarThreshold} */
function validThreshold(t) {
  const share = (/** @type {any} */ v) => typeof v === 'number' && v > 0 && v < 1;
  if (!share(t.abstract)) throw new Error('The radar threshold must be between 0 and 1.');
  if (t.full != null && !share(t.full)) throw new Error('The radar threshold for whole papers must be between 0 and 1.');
  return { abstract: t.abstract, full: t.full ?? null, ...(t.calibration ? { calibration: t.calibration } : {}) };
}

/** What the server needs to know the seeds by (radar_api.seed_matrix). @param {import("./radar-types").RadarSeeds} seeds
 *  @returns {import("./radar-types").SeedBody} */
export function seedBody(seeds) {
  return {
    keys: [...new Set([...seeds.mine.flatMap((m) => (m.key ? [m.key] : [])), ...seeds.papers])],
    collections: seeds.collections,
    texts: seeds.mine.filter((m) => !m.key && m.abstract).map((m) => ({ title: m.title, text: m.abstract })),
  };
}
