// @ts-check
// agent-src/src/radar-run.js. Spec 012 R1: one radar run up to the point of writing. Fetch every source, merge, drop what
// is known, score, pick the top rows, and work out the next RadarState. It writes nothing: core.js writes the session
// first and the state after it, so a crash between the two shows a paper twice rather than never.

import { fetchAll, politeFetch, REQUEST_BUDGET } from './radar-sources.js';
import { worthReading } from './radar-older.js';
import { mightInterest } from './radar-discover.js';
import { mergeItems, dropKnown, pickTop, keysOf, seedBody } from './radar.js';
import { score, rescoreWhole } from './radar-score.js';
import { abstractsByDoi } from './scholarly.js';

/** @typedef {import("./radar-types").RadarItem} RadarItem */
/** @typedef {import("./radar-types").RadarState} RadarState */

const SHOWN_TEXT = 800;
/** Spec radar-seeds: a run looks back at most this far, however long ago the last one was. */
export const SEED_WINDOW_DAYS = 7;
/** New arXiv papers read whole per run (D2: only those past the abstract cut). */
export const WHOLE_PAPERS = 40;
/** The abstract pass keeps papers this far below the abstract threshold; the whole-paper pass decides them. */
export const ABSTRACT_MARGIN = 0.03;
/** Until a radar is calibrated, the 2026-10-11 floor stands in. */
const DEFAULT_CUT = 0.7;
const HISTORY_DAYS = 7;
export const NEEDS_SERVER = 'The reading radar needs the library server, which is not available here.';

/**
 * @param {{
 *   config: import("./radar-types").RadarConfig, since: string, now: string, fetch: typeof fetch,
 *   library: import("./tools").LibraryBackend, hub?: any, state: RadarState, signal?: AbortSignal, budget?: number,
 *   keyed?: boolean,
 * }} run `keyed`: the user has saved an OpenAlex key; "Might interest you" needs one, and is left out when it is false or absent.
 * @returns {Promise<{ picked: RadarItem[], older: RadarItem[], olderNote: string | null, discover: RadarItem[], discoverNote: string | null, announced: string[], state: RadarState, failed: { source: string, error: string }[], sourcesAnswered: number, requests: number }>}
 */
export async function collectRadar(run) {
  const { config, library, state } = run;
  if (!library.items || !library.radarScore) throw new Error(NEEDS_SERVER);
  const active = config.sources.filter((s) => s.on);
  if (!active.length) throw new Error('No source is turned on.');
  const collections = config.scope.kind === 'collections' ? config.scope.keys : null;
  const seeds = config.seeds ? seedBody(config.seeds) : null;
  // A seed radar looks back at most SEED_WINDOW_DAYS (D3), even after a long pause.
  const floorDate = new Date(Date.parse(run.now) - SEED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const since = seeds && run.since < floorDate ? floorDate : run.since;
  const seedPlan = seeds ? { categories: config.seeds?.categories ?? [], phrases: await seedPhrases(library, seeds) } : null;

  const [libraryItems, fetched] = await Promise.all([
    library.items({ collections: null }),
    fetchAll({ sources: active, profile: config.profile, since, fetch: run.fetch, hub: run.hub, feedCache: state.feedCache, budget: run.budget, rotation: state.phrases.rotation, seedPlan }),
  ]);
  if (run.signal?.aborted) throw new Error('stopped');

  const failed = fetched.results.filter((r) => r.error).map((r) => ({ source: r.id, error: /** @type {string} */ (r.error) }));
  const answered = fetched.results.length - failed.length;
  if (!answered) throw new Error(`None of the sources answered (${failed[0]?.error ?? 'unknown'})`);

  const merged = mergeItems(fetched.results.flatMap((r) => r.items)).filter((it) => it.url);
  const fresh = dropKnown(merged, libraryItems, state.seen);
  const watched = {
    authors: active.flatMap((s) => (s.kind === 'author' ? [s.name] : [])),
    journals: active.flatMap((s) => (s.kind === 'journal' ? [s.name] : [])),
  };
  const titles = new Map(libraryItems.map((it) => [`zotero/${it.key}`, it.title]));
  // Zotero titles can hold markup (<i>GW</i>); the why line is plain text.
  const seedTitle = (/** @type {string} */ label) => String(titles.get(label) ?? label.replace(/^text:/, '')).replace(/<[^>]+>/g, '');
  const threshold = config.threshold ?? null;
  const cut = seeds ? (threshold ? threshold.abstract - ABSTRACT_MARGIN : DEFAULT_CUT) : undefined;
  const baseline = threshold?.calibration?.baseline ?? null;
  let ranked = await score(fresh, { backend: library, collections, profile: config.profile, state, watched, seeds, cut, seedTitle, baseline });
  if (seeds) ranked = await decideWhole(ranked, { library, seeds, threshold, seedTitle, baseline });
  const top = pickTop(ranked, config.size.fresh);

  const missing = top.filter((it) => !it.abstract && it.doi);
  if (missing.length) {
    const found = await abstractsByDoi(run.fetch, missing.map((it) => /** @type {string} */ (it.doi)));
    for (const it of missing) it.abstract = found.get(/** @type {string} */ (it.doi)) ?? it.abstract;
  }

  // A day with nothing new stays quiet (spec section 3, step 6), so older papers are only looked for beside New rows.
  let older = /** @type {RadarItem[]} */ ([]), olderNote = /** @type {string | null} */ (null), refs = state.refs, olderRequests = 0;
  let discover = /** @type {RadarItem[]} */ ([]), discoverNote = /** @type {string | null} */ (null);
  const wantsOlder = top.length > 0 && config.size.older > 0;
  const discoverSize = config.size.discover ?? 3;
  const wantsDiscover = top.length > 0 && discoverSize > 0;
  const scopeItems = wantsOlder || wantsDiscover ? (collections ? await library.items({ collections }) : libraryItems) : libraryItems;
  if (wantsOlder) {
    const net = politeFetch(run.fetch, Math.max(0, (run.budget ?? REQUEST_BUDGET) - fetched.requests));
    const seenKeys = new Set([...Object.keys(state.seen), ...top.flatMap(keysOf)]);
    const found = await worthReading({ libraryItems, scopeItems, newRows: top, state, fetch: net.fetch, now: run.now, size: config.size, seenKeys, library, collections });
    older = found.rows; olderNote = found.note; refs = found.state.refs; olderRequests = net.used();
  }
  let discoverRequests = 0;
  if (wantsDiscover && run.keyed) {
    const net = politeFetch(run.fetch, Math.max(0, (run.budget ?? REQUEST_BUDGET) - fetched.requests - olderRequests));
    // Everything a followed source returned counts as known: this group is for papers none of them published.
    const known = new Set([...Object.keys(state.seen), ...merged.flatMap(keysOf), ...older.flatMap(keysOf)]);
    const found = await mightInterest({ libraryItems, scopeItems, config, state, fetch: net.fetch, now: run.now, size: { discover: discoverSize }, seenKeys: known, library, collections });
    discover = found.rows; discoverNote = found.note; discoverRequests = net.used();
  } else if (wantsDiscover && run.keyed === false) discoverNote = 'Might interest you skipped (no OpenAlex key)';

  /** @type {RadarState} */
  const next = { ...state, refs, phrases: { ...state.phrases, rotation: state.phrases.rotation + 1, announce: [] }, seen: { ...state.seen }, sourceStatus: { ...state.sourceStatus }, feedCache: { ...state.feedCache }, shown: { ...state.shown } };
  // Per source, how many items it gave and how many made the digest, over the last week (spec 021 G2b).
  const keptBy = new Map();
  for (const it of top) for (const id of it.sources) keptBy.set(id, (keptBy.get(id) ?? 0) + 1);
  const weekAgo = new Date(Date.parse(run.now) - HISTORY_DAYS * 86_400_000).toISOString();
  for (const r of fetched.results) {
    const before = state.sourceStatus[r.id];
    const history = [...(before?.history ?? []).filter((h) => h.at >= weekAgo), { at: run.now, items: r.items.length, kept: keptBy.get(r.id) ?? 0 }];
    next.sourceStatus[r.id] = { at: run.now, items: r.items.length, skipped: r.skipped ?? 0, error: r.error, quietRuns: r.error ? before?.quietRuns ?? 0 : r.items.length ? 0 : (before?.quietRuns ?? 0) + 1, ...(before?.suggestRemove ? { suggestRemove: true } : {}), history };
    const source = active.find((s) => s.id === r.id);
    if (source?.kind === 'feed' && r.cache && !r.error) next.feedCache[source.url] = r.cache;
  }
  for (const it of [...top, ...older, ...discover]) {
    for (const key of keysOf(it)) next.seen[key] = { at: run.now, verdict: 'shown' };
    // What a click on this row needs later (radar-feedback.js): the text for the examples, the people and venue to learn.
    next.shown[it.id] = { keys: keysOf(it), title: it.title, text: `${it.title}. ${it.abstract}`.slice(0, SHOWN_TEXT), authors: it.authors, venue: it.venue, sources: it.sources, ...(it.keywords?.length ? { keywords: it.keywords } : {}) };
  }
  return { picked: top, older, olderNote, discover, discoverNote, announced: state.phrases.announce, state: next, failed, sourcesAnswered: answered, requests: fetched.requests + olderRequests + discoverRequests };
}

/** Search phrases from the seeds' titles (the server's profile narrowed to them); none when the server cannot.
 *  @param {import("./tools").LibraryBackend} library @param {import("./radar-types").SeedBody} seeds */
async function seedPhrases(library, seeds) {
  if (!seeds.keys.length || !library.radarProfile) return seeds.texts.map((t) => t.title).slice(0, 3);
  try {
    const profile = await library.radarProfile({ scope: { collections: null }, seeds: { keys: seeds.keys } });
    return profile.topics.slice(0, 5).map((t) => t.text);
  } catch { return []; }
}

/**
 * The whole-paper pass (spec 021 G3, D2): the best arXiv candidates past the abstract cut are read whole and
 * judged on that; the rest, and any paper that could not be read, are judged on their abstract.
 * @param {RadarItem[]} ranked best first, each with why.similarity to its closest seed
 * @param {{ library: import("./tools").LibraryBackend, seeds: import("./radar-types").SeedBody, threshold: import("./radar-types").RadarThreshold | null, seedTitle: (label: string) => string, baseline?: import("./radar-types").SeedBaseline | null }} ctx
 */
async function decideWhole(ranked, ctx) {
  const abstractCut = ctx.threshold?.abstract ?? DEFAULT_CUT;
  const wholeCut = ctx.threshold?.full ?? null;
  /** @type {Record<string, { seed_max?: number, seed_best?: string | null, seed_raw?: number, error?: string }>} */
  let whole = {};
  const toRead = ranked.filter((it) => it.arxiv).slice(0, WHOLE_PAPERS);
  if (wholeCut != null && toRead.length && ctx.library.radarFulltext) {
    try { whole = await ctx.library.radarFulltext({ seeds: ctx.seeds, items: toRead.map((it) => ({ id: it.id, arxiv: /** @type {string} */ (it.arxiv) })), ...(ctx.baseline ? { baseline: ctx.baseline } : {}) }); } catch { whole = {}; }
  }
  const out = [];
  for (const it of ranked) {
    const w = whole[it.id];
    if (w && typeof w.seed_max === 'number' && w.seed_best) {
      if (w.seed_max >= /** @type {number} */ (wholeCut)) out.push(rescoreWhole(it, w.seed_raw ?? w.seed_max, { label: w.seed_best, title: ctx.seedTitle(w.seed_best), margin: Math.round(w.seed_max * 1000) / 1000 }));
    } else if ((it.why?.seed?.margin ?? it.why?.similarity ?? 0) >= abstractCut) out.push(it);
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
