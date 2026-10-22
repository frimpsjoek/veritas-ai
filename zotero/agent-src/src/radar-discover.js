// @ts-check
// agent-src/src/radar-discover.js. Spec 014 G2: "Might interest you". Papers no followed source published, found through
// what the user kept or rated well: papers citing several of the library's most-cited papers, recent papers by co-authors
// of followed authors, and OpenAlex's related works of papers rated Add or Read later. No model is called. Each finder
// is pure apart from the injected fetch.

import { fromOpenAlex, OPENALEX_FIELDS } from './scholarly.js';
import { normalise, normDoi, keysOf, isNonPaper } from './radar.js';
import { score } from './radar-score.js';

/** @typedef {import("./radar-types").RadarItem} RadarItem */
/** @typedef {import("./radar-types").RadarState} RadarState */
/** @typedef {import("./radar-types").LibraryItem} LibraryItem */

export const DISCOVER = {
  /** Library papers whose citation counts are looked up, newest first (one request per 50). */
  libraryCap: 100,
  batch: 50,
  /** The most-cited of those are "key papers"; a work citing `minCited` of them is a candidate. */
  keyPapers: 10,
  minCited: 2,
  windowDays: 30,
  /** Co-authors followed up per run, and followed authors read for them. */
  coauthors: 5,
  perPage: 50,
  /** Rated papers whose related works are read, and the oldest a related paper may be. */
  rated: 10,
  relatedYears: 2,
};

const API = 'https://api.openalex.org';
const shortId = (/** @type {unknown} */ id) => String(id ?? '').replace(/^https?:\/\/openalex\.org\//, '');
const BUDGET = /request budget/;
const day = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);
const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;

/** @param {typeof fetch} fetchFn @param {string} path @returns {Promise<any[]>} */
async function results(fetchFn, path) {
  const res = await fetchFn(`${API}${path}`);
  if (!res.ok) throw new Error(`api.openalex.org: HTTP ${res.status}`);
  return (await res.json()).results ?? [];
}

/** The DOIs of up to `size` per request, as `doi:a|b` filters. @param {string[]} dois */
const doiBatches = (dois) => Array.from({ length: Math.ceil(dois.length / DISCOVER.batch) }, (_, i) => dois.slice(i * DISCOVER.batch, (i + 1) * DISCOVER.batch));

/** @param {any} work @param {string} reason @returns {RadarItem | null} */
function itemOf(work, reason) {
  const item = normalise(fromOpenAlex(work), 'discover');
  return item ? { ...item, cites: work.cited_by_count ?? 0, reason } : null;
}

/** The library's most-cited papers' OpenAlex ids. @param {typeof fetch} fetchFn @param {LibraryItem[]} library */
async function keyPaperIds(fetchFn, library) {
  const dois = [...new Set(
    [...library].sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).flatMap((it) => { const d = normDoi(it.doi); return d ? [d] : []; }),
  )].slice(0, DISCOVER.libraryCap);
  /** @type {{ id: string, cited: number }[]} */
  const found = [];
  for (const batch of doiBatches(dois)) {
    const works = await results(fetchFn, `/works?filter=doi:${batch.map(encodeURIComponent).join('|')}&per_page=${DISCOVER.batch}&select=id,cited_by_count`);
    for (const w of works) found.push({ id: shortId(w.id), cited: w.cited_by_count ?? 0 });
  }
  return found.sort((a, b) => b.cited - a.cited || (a.id < b.id ? -1 : 1)).slice(0, DISCOVER.keyPapers).map((f) => f.id);
}

/**
 * Recent works that cite two or more of the library's most-cited papers.
 * @param {typeof fetch} fetchFn @param {{ library: LibraryItem[], now: string }} run @returns {Promise<RadarItem[]>}
 */
export async function citingKeyPapers(fetchFn, run) {
  const keys = await keyPaperIds(fetchFn, run.library);
  if (keys.length < DISCOVER.minCited) return [];
  const from = day(Date.parse(run.now) - DISCOVER.windowDays * 86400000);
  const works = await results(fetchFn, `/works?filter=cites:${keys.join('|')},from_publication_date:${from}&sort=publication_date:desc&per_page=${DISCOVER.perPage}&select=${OPENALEX_FIELDS},referenced_works`);
  const keySet = new Set(keys);
  /** @type {RadarItem[]} */
  const out = [];
  for (const w of works) {
    const n = new Set((w.referenced_works ?? []).map(shortId).filter((/** @type {string} */ id) => keySet.has(id))).size;
    if (n < DISCOVER.minCited) continue;
    const item = itemOf(w, `Cites ${plural(n, 'paper', 'papers')} in your library`);
    if (item) out.push({ ...item, why: { similarity: 0, author: 0, journal: 0, topic: 0, negative: 0, citedBy: { count: n, titles: [] } } });
  }
  return out.sort((a, b) => (b.why?.citedBy?.count ?? 0) - (a.why?.citedBy?.count ?? 0));
}

/**
 * Recent works by the people who most often co-author with a followed author.
 * @param {typeof fetch} fetchFn @param {{ followed: { name: string, openalexId: string }[], now: string }} run @returns {Promise<RadarItem[]>}
 */
export async function coauthorsOfFollowed(fetchFn, run) {
  const followed = new Map(run.followed.map((f) => [shortId(f.openalexId), f.name]));
  if (!followed.size) return [];
  const own = await results(fetchFn, `/works?filter=author.id:${[...followed.keys()].join('|')}&sort=publication_date:desc&per_page=${DISCOVER.perPage}&select=id,authorships`);
  /** @type {Map<string, { count: number, of: string }>} */
  const coauthors = new Map();
  for (const w of own) {
    const ids = (w.authorships ?? []).map((/** @type {any} */ a) => shortId(a.author?.id)).filter(Boolean);
    const lead = ids.find((/** @type {string} */ id) => followed.has(id));
    if (!lead) continue;
    for (const id of ids) {
      if (followed.has(id)) continue;
      const seen = coauthors.get(id);
      if (seen) seen.count += 1; else coauthors.set(id, { count: 1, of: /** @type {string} */ (followed.get(lead)) });
    }
  }
  const top = [...coauthors].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1)).slice(0, DISCOVER.coauthors);
  if (!top.length) return [];
  const from = day(Date.parse(run.now) - DISCOVER.windowDays * 86400000);
  const works = await results(fetchFn, `/works?filter=author.id:${top.map(([id]) => id).join('|')},from_publication_date:${from}&sort=publication_date:desc&per_page=${DISCOVER.perPage}&select=${OPENALEX_FIELDS}`);
  const by = new Map(top);
  /** @type {RadarItem[]} */
  const out = [];
  for (const w of works) {
    const ids = (w.authorships ?? []).map((/** @type {any} */ a) => shortId(a.author?.id));
    // A work that already has a followed author is the followed source's to show.
    if (ids.some((/** @type {string} */ id) => followed.has(id))) continue;
    const hit = ids.find((/** @type {string} */ id) => by.has(id));
    const item = hit ? itemOf(w, `By a co-author of ${by.get(hit)?.of}`) : null;
    if (item) out.push(item);
  }
  return out;
}

/**
 * OpenAlex's related works of the papers rated Add, Read later or Like, most recently rated first.
 * @param {typeof fetch} fetchFn @param {{ state: RadarState, now: string }} run @returns {Promise<RadarItem[]>}
 */
export async function relatedToRated(fetchFn, run) {
  const rated = Object.entries(run.state.seen)
    .filter(([key, v]) => key.startsWith('doi:') && (v.verdict === 'added' || v.verdict === 'later' || v.verdict === 'liked'))
    .sort((a, b) => b[1].at.localeCompare(a[1].at) || (a[0] < b[0] ? -1 : 1))
    .slice(0, DISCOVER.rated).map(([key]) => key.slice(4));
  if (!rated.length) return [];
  const titleOf = (/** @type {string} */ doi, /** @type {string} */ fallback) => Object.values(run.state.shown).find((s) => s.keys.includes(`doi:${doi}`))?.title || fallback;
  const sources = await results(fetchFn, `/works?filter=doi:${rated.map(encodeURIComponent).join('|')}&per_page=${DISCOVER.rated}&select=id,doi,display_name,related_works`);
  /** @type {Map<string, string>} related work id -> title of the rated paper */
  const via = new Map();
  const ratedIds = new Set(sources.map((s) => shortId(s.id)));
  for (const s of sources) {
    const title = titleOf(normDoi(s.doi), String(s.display_name ?? ''));
    for (const id of (s.related_works ?? []).map(shortId)) if (id && !ratedIds.has(id) && !via.has(id)) via.set(id, title);
  }
  const ids = [...via.keys()].slice(0, DISCOVER.perPage);
  if (!ids.length) return [];
  const from = day(Date.parse(run.now) - DISCOVER.relatedYears * 365 * 86400000);
  const works = await results(fetchFn, `/works?filter=openalex:${ids.join('|')},from_publication_date:${from}&sort=publication_date:desc&per_page=${DISCOVER.perPage}&select=${OPENALEX_FIELDS}`);
  /** @type {RadarItem[]} */
  const out = [];
  for (const w of works) {
    const title = via.get(shortId(w.id));
    const item = title ? itemOf(w, `Related to ${title}, which you saved`) : null;
    if (item) out.push(item);
  }
  return out;
}

/**
 * Runs the three finders, drops what is held or already known, scores the rest with the profile and keeps the top
 * `size.discover`. A finder that fails leaves a note and does not stop the others.
 * @param {{
 *   libraryItems: LibraryItem[], scopeItems: LibraryItem[], config: import("./radar-types").RadarConfig, state: RadarState,
 *   fetch: typeof fetch, now: string, size: { discover: number }, seenKeys: Set<string>,
 *   library: Pick<import("./tools").LibraryBackend, 'radarScore'>, collections?: string[] | null,
 * }} run `fetch` is the run's budgeted fetch; `seenKeys` holds everything the followed sources returned or earlier issues showed.
 * @returns {Promise<{ rows: RadarItem[], note: string | null }>}
 */
export async function mightInterest(run) {
  if (run.size.discover <= 0) return { rows: [], note: null };
  const notes = /** @type {string[]} */ ([]);
  const attempt = async (/** @type {string} */ doing, /** @type {() => Promise<RadarItem[]>} */ find) => {
    try { return await find(); } catch (e) {
      const text = String(/** @type {any} */ (e)?.message ?? e);
      notes.push(/** @type {any} */ (e)?.name === 'OpenAlexLimit' ? `Might interest you stopped: ${text}` : BUDGET.test(text) ? `Might interest you stopped early: the request limit for this run was reached while ${doing}.` : `Might interest you stopped early: ${text} while ${doing}.`);
      return [];
    }
  };
  const { profile, sources } = run.config;
  const followed = [
    ...profile.authors.flatMap((a) => (a.openalexId ? [{ name: a.name, openalexId: a.openalexId }] : [])),
    ...sources.flatMap((s) => (s.kind === 'author' && s.on ? [{ name: s.name, openalexId: s.openalexId }] : [])),
  ];
  const found = [
    ...await attempt('looking for papers that cite yours', () => citingKeyPapers(run.fetch, { library: run.scopeItems, now: run.now })),
    ...await attempt('reading your followed authors\' co-authors', () => coauthorsOfFollowed(run.fetch, { followed, now: run.now })),
    ...await attempt('reading the related works of papers you saved', () => relatedToRated(run.fetch, { state: run.state, now: run.now })),
  ];

  const held = new Set(run.libraryItems.flatMap((it) => keysOf({ doi: it.doi, title: it.title })));
  const taken = new Set();
  /** @type {RadarItem[]} */
  const items = [];
  // The finders' order is the tie-break for a paper two of them found: the first reason stays.
  for (const it of found) {
    const keys = keysOf(it);
    if (isNonPaper(it) || !it.url || keys.some((k) => held.has(k) || run.seenKeys.has(k) || taken.has(k))) continue;
    for (const k of keys) taken.add(k);
    items.push(it);
  }
  if (!items.length) return { rows: [], note: notes.length ? notes.join(' ') : null };
  const ranked = await score(items, {
    backend: run.library, collections: run.collections ?? null, profile, state: run.state,
    watched: { authors: sources.flatMap((s) => (s.kind === 'author' ? [s.name] : [])), journals: sources.flatMap((s) => (s.kind === 'journal' ? [s.name] : [])) },
  });
  return { rows: ranked.slice(0, run.size.discover), note: notes.length ? notes.join(' ') : null };
}
