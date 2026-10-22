// @ts-check
// agent-src/src/radar-older.js. Spec 012 R3: "Worth reading". Older papers the user's own library keeps citing but does
// not hold, found from OpenAlex `referenced_works`. No model is called. Pure apart from the injected fetch.

import { openAlexWorks } from './scholarly.js';
import { normalise, normDoi, keysOf } from './radar.js';

/** @typedef {import("./radar-types").RadarItem} RadarItem */
/** @typedef {import("./radar-types").RadarState} RadarState */
/** @typedef {import("./radar-types").LibraryItem} LibraryItem */

export const OLDER = {
  scopeCap: 400,
  batch: 50,
  ttlMs: 30 * 24 * 3600 * 1000,
  /** A work is a candidate when this many scope papers cite it, or `newCited` of this run's New rows do. */
  libraryCited: 3,
  newCited: 2,
  /** Candidates whose metadata is fetched (one request). */
  metadataTop: 20,
};

const API = 'https://api.openalex.org';
const shortId = (/** @type {unknown} */ id) => String(id ?? '').replace(/^https?:\/\/openalex\.org\//, '');
const BUDGET = /request budget/;

/**
 * OpenAlex `referenced_works` for DOIs, one request per 50. Calls `onBatch` after each so a failure part-way keeps what
 * came before.
 * @param {typeof fetch} fetchFn @param {string[]} dois
 * @param {(found: Map<string, { id: string, ids: string[] }>, asked: string[]) => void} onBatch
 */
async function fetchRefs(fetchFn, dois, onBatch) {
  for (let at = 0; at < dois.length; at += OLDER.batch) {
    const asked = dois.slice(at, at + OLDER.batch);
    const res = await fetchFn(`${API}/works?filter=doi:${asked.map(encodeURIComponent).join('|')}&per_page=${OLDER.batch}&select=id,doi,referenced_works`);
    if (!res.ok) throw new Error(`api.openalex.org: HTTP ${res.status}`);
    const data = await res.json();
    /** @type {Map<string, { id: string, ids: string[] }>} */
    const found = new Map();
    for (const w of data.results ?? []) {
      const doi = normDoi(w.doi);
      if (!doi) continue;
      const here = { id: shortId(w.id), ids: (w.referenced_works ?? []).map(shortId).filter(Boolean) };
      // OpenAlex sometimes holds two records for one DOI, one of them empty: keep the one with references.
      const other = found.get(doi);
      found.set(doi, other && other.ids.length >= here.ids.length ? other : here);
    }
    onBatch(found, asked);
  }
}

const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;

/** @param {number} count @param {string[]} titles @param {number} newCount */
function reasonOf(count, titles, newCount) {
  const fromNew = newCount >= OLDER.newCited ? `${count ? '; also c' : 'C'}ited by ${newCount} of this run's new papers` : '';
  if (!count) return `${fromNew}`;
  return `Cited by ${plural(count, 'paper', 'papers')} in your library${titles.length ? `, including ${titles.join(', ')}` : ''}${fromNew}`;
}

/**
 * @param {{
 *   libraryItems: LibraryItem[], scopeItems: LibraryItem[], newRows: RadarItem[], state: RadarState, fetch: typeof fetch,
 *   now: string, size: { older: number }, seenKeys: Set<string>,
 *   library?: Pick<import("./tools").LibraryBackend, 'radarScore'>, collections?: string[] | null,
 * }} run `fetch` is the run's budgeted fetch. `scopeItems` are the papers whose references are counted; `libraryItems`
 * are everything that must not be suggested.
 * @returns {Promise<{ rows: RadarItem[], state: RadarState, note: string | null }>}
 */
export async function worthReading(run) {
  const none = { rows: [], state: run.state, note: null };
  if (run.size.older <= 0) return none;
  const refs = { ...run.state.refs };
  const notes = [];
  const done = (/** @type {RadarItem[]} */ rows) => ({ rows, state: { ...run.state, refs }, note: notes.length ? notes.join(' ') : null });
  const stop = (/** @type {unknown} */ e, /** @type {string} */ doing) => {
    const text = String(/** @type {any} */ (e)?.message ?? e);
    if (/** @type {any} */ (e)?.name === 'OpenAlexLimit') { notes.push(`Worth reading stopped: ${text}`); return; }
    notes.push(BUDGET.test(text) ? `Worth reading stopped early: the request limit for this run was reached while ${doing}.` : `Worth reading stopped early: ${text} while ${doing}.`);
  };
  const nowMs = Date.parse(run.now);

  const titleOf = new Map();
  const scopeDois = [...run.scopeItems]
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .flatMap((it) => { const doi = normDoi(it.doi); if (doi && !titleOf.has(doi)) { titleOf.set(doi, it.title); return [doi]; } return []; })
    .slice(0, OLDER.scopeCap);
  const stale = scopeDois.filter((d) => { const c = refs[d]; return !c || !(nowMs - Date.parse(c.at) <= OLDER.ttlMs); });
  try {
    await fetchRefs(run.fetch, stale, (found, asked) => {
      // A DOI OpenAlex does not know is cached as empty, so it is not asked again for 30 days.
      for (const d of asked) refs[d] = { at: run.now, ids: found.get(d)?.ids ?? [], ...(found.get(d) ? { id: found.get(d)?.id } : {}) };
    });
  } catch (e) { stop(e, 'reading your library\'s references'); }

  /** @type {Map<string, string[]>} work id -> citing titles */
  const citing = new Map();
  for (const d of scopeDois) {
    for (const id of new Set(refs[d]?.ids ?? [])) {
      const list = citing.get(id);
      if (list) list.push(/** @type {string} */ (titleOf.get(d))); else citing.set(id, [/** @type {string} */ (titleOf.get(d))]);
    }
  }

  /** @type {Map<string, number>} */
  const newCites = new Map();
  const newDois = [...new Set(run.newRows.flatMap((r) => (r.doi ? [normDoi(r.doi)] : [])))];
  if (newDois.length) {
    try {
      await fetchRefs(run.fetch, newDois, (found) => {
        for (const v of found.values()) for (const id of new Set(v.ids)) newCites.set(id, (newCites.get(id) ?? 0) + 1);
      });
    } catch (e) { stop(e, 'reading the new papers\' references'); }
  }

  const heldIds = new Set(run.libraryItems.flatMap((it) => { const id = refs[normDoi(it.doi)]?.id; return id ? [id] : []; }));
  const ranked = [...new Set([...citing.keys(), ...newCites.keys()])]
    .filter((id) => !heldIds.has(id) && ((citing.get(id)?.length ?? 0) >= OLDER.libraryCited || (newCites.get(id) ?? 0) >= OLDER.newCited))
    .sort((a, b) => (citing.get(b)?.length ?? 0) - (citing.get(a)?.length ?? 0) || (newCites.get(b) ?? 0) - (newCites.get(a) ?? 0) || (a < b ? -1 : 1))
    .slice(0, OLDER.metadataTop);
  if (!ranked.length) return done([]);

  /** @type {any[]} */
  let works = [];
  try { works = await openAlexWorks(run.fetch, `openalex:${ranked.join('|')}`, OLDER.metadataTop); } catch (e) { stop(e, 'looking up the papers it found'); return done([]); }

  const held = new Set(run.libraryItems.flatMap((it) => keysOf({ doi: it.doi, title: it.title })));
  /** @type {RadarItem[]} */
  const items = [];
  for (const w of works) {
    const item = normalise(w, 'citations');
    if (!item || keysOf(item).some((k) => held.has(k) || run.seenKeys.has(k))) continue;
    const titles = citing.get(item.openalexId ?? '') ?? [];
    const newCount = newCites.get(item.openalexId ?? '') ?? 0;
    items.push({
      ...item, cites: w.cites ?? 0, why: { similarity: 0, author: 0, journal: 0, topic: 0, negative: 0, citedBy: { count: titles.length, titles: titles.slice(0, 3), ...(newCount ? { newCount } : {}) } },
      reason: reasonOf(titles.length, titles.slice(0, 3), newCount),
    });
  }

  if (run.library?.radarScore && items.length) {
    try {
      const sims = await run.library.radarScore({
        scope: { collections: run.collections ?? null }, positives: [], negatives: [],
        items: items.map((it) => ({ id: it.id, text: `${it.title}. ${it.abstract}`.slice(0, 2000) })),
      });
      for (const it of items) { it.score = sims[it.id]?.similarity ?? 0; /** @type {any} */ (it.why).similarity = it.score; }
    } catch { /* similarity only breaks ties */ }
  }
  const countOf = (/** @type {RadarItem} */ it) => it.why?.citedBy?.count ?? 0;
  items.sort((a, b) => countOf(b) - countOf(a) || (b.why?.citedBy?.newCount ?? 0) - (a.why?.citedBy?.newCount ?? 0) || (b.score ?? 0) - (a.score ?? 0) || (a.id < b.id ? -1 : 1));
  return done(items.slice(0, run.size.older));
}
