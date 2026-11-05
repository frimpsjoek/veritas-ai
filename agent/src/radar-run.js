// @ts-check
// agent-src/src/radar-run.js. Spec 012 R1: one radar run up to the point of writing. Fetch every source, merge, drop what
// is known, score, pick the top rows, and work out the next RadarState. It writes nothing: core.js writes the session
// first and the state after it, so a crash between the two shows a paper twice rather than never.

import { fetchAll, politeFetch, REQUEST_BUDGET, HOST_GAPS } from './radar-sources.js';
import { worthReading } from './radar-older.js';
import { mightInterest } from './radar-discover.js';
import { mergeItems, dropKnown, pickTop, keysOf, seedBody, seedsKey, MIN_SEEDS } from './radar.js';
import { calibrateRadar, CALIBRATION_VERSION } from './radar-seeds.js';
import { score, rescoreWhole, seedBar, neighbour, hubOnly } from './radar-score.js';
import { abstractsByDoi, fillAbstracts } from './scholarly.js';
import { judgePool } from './radar-judge.js';
import { taughtSeeds } from './radar-feedback.js';

/** @typedef {import("./radar-types").RadarItem} RadarItem */
/** @typedef {import("./radar-types").RadarState} RadarState */

const SHOWN_TEXT = 800;
/** Spec radar-seeds: a run looks back at most this far, however long ago the last one was. */
export const SEED_WINDOW_DAYS = 7;
/** New arXiv papers read whole per run (D2: only those past the abstract cut), a PDF every 3 s, at most this many
 *  closest to any one seed: the top 40 by abstract used to be mostly one broad seed's. */
export const WHOLE_PAPERS = 100;
export const WHOLE_SEED_SHARE = 20;
/** The server reads this many per call (radar_api.FULLTEXT_MAX). */
const WHOLE_BATCH = 40;
/** The abstract pass keeps papers this far below the abstract threshold; the whole-paper pass decides them. */
export const ABSTRACT_MARGIN = 0.03;
/** That lower bar, and never below where the unrelated fields end: a day's whole-paper reads are not for those.
 *  @param {import("./radar-types").RadarThreshold} threshold */
const lowerBar = (threshold) => Math.max(threshold.abstract - ABSTRACT_MARGIN, threshold.calibration?.abstract?.unrelated?.p95 ?? -Infinity);
/** Until a radar is calibrated, the 2026-10-11 floor stands in. */
const DEFAULT_CUT = 0.7;
/** A day with fewer New rows than this fills them from just under the bar, so there are enough to rate and teach it. */
export const FILL_TO = 25;
/** How far under its bar a paper still counts as near it, and how many are kept per stage in the radar's near-bar ledger. */
const NEAR_WINDOW = 0.03;
export const NEAR_BAR_STAGE = 20;
/** Candidates from under the bar the profile check reads beside the rest, more when the rest are few. */
const NEAR_JUDGED = 10;
const HISTORY_DAYS = 7;
/** A run that tried to calibrate and failed tries again after this long. */
const CALIBRATE_RETRY_MS = 86_400_000;
/** Record kinds read on their title alone, left out unless a followed author wrote them. */
const BOOK_KINDS = new Set(['book-chapter', 'book']);
/** Title-only papers whose abstract is looked up one by one per run (Crossref, Semantic Scholar, arXiv), best first. */
export const ABSTRACT_LOOKUPS = 20;

/** The fetch for those lookups: at most one request a second to each of the two keyless APIs (two per paper at most).
 *  @param {typeof fetch} fetchFn */
export const abstractNet = (fetchFn) => politeFetch(fetchFn, 2 * ABSTRACT_LOOKUPS + 2, { gaps: { ...HOST_GAPS, 'api.crossref.org': 1000, 'api.semanticscholar.org': 1000 } }).fetch;
export const NEEDS_SERVER = 'The reading radar needs the library server, which is not available here.';

/**
 * @param {{
 *   config: import("./radar-types").RadarConfig, since: string, now: string, fetch: typeof fetch,
 *   library: import("./tools").LibraryBackend, hub?: any, state: RadarState, signal?: AbortSignal, budget?: number,
 *   keyed?: boolean, abstractFetch?: typeof fetch, sleep?: (ms: number) => Promise<void>,
 *   judge?: (pool: RadarItem[], profile: { topics: string[], seeds: string[], rejected: string[], liked?: string[] }) => Promise<{ off: Set<string>, error: string | null }>,
 * }} run `keyed`: the user has saved an OpenAlex key; "Might interest you" needs one, and is left out when it is false or absent.
 *   `sleep` stands in for the waits between arXiv API requests (tests).
 *   `abstractFetch` (abstractNet): papers that came without an abstract are looked up before the final ranking; absent,
 *   only the picked rows are, in OpenAlex, after it.
 *   `judge` (radar-judge.js): the profile check; the New rows are picked from the best-ranked candidates it lets through,
 *   and those it rejects are remembered as seen ("off") so they don't come back. Absent, the ranking alone picks.
 * @returns {Promise<{ picked: RadarItem[], older: RadarItem[], olderNote: string | null, discover: RadarItem[], discoverNote: string | null, announced: string[], state: RadarState, failed: { source: string, error: string }[], sourcesAnswered: number, offProfile: number, judgeProblem: string | null, requests: number, threshold: import("./radar-types").RadarThreshold | null }>}
 *   `threshold`: a calibration this run made (the caller saves it on the radar); null when it made none.
 */
export async function collectRadar(run) {
  const { config, library, state } = run;
  if (!library.items || !library.radarScore) throw new Error(NEEDS_SERVER);
  const active = config.sources.filter((s) => s.on);
  if (!active.length) throw new Error('No source is turned on.');
  const collections = config.scope.kind === 'collections' ? config.scope.keys : null;
  const chosen = config.seeds ? seedBody(config.seeds) : null;
  // A seed radar looks back at most SEED_WINDOW_DAYS (D3), even after a long pause.
  const floorDate = new Date(Date.parse(run.now) - SEED_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const since = chosen && run.since < floorDate ? floorDate : run.since;
  const seedPlan = chosen ? { categories: config.seeds?.categories ?? [], phrases: await seedPhrases(library, chosen) } : null;

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
  const seedTitle = (/** @type {string} */ label) => String(titles.get(label) ?? label.replace(/^(text|liked):/, '')).replace(/<[^>]+>/g, '');
  let threshold = config.threshold ?? null;
  // Without a calibration every margin is the plain similarity and a seed close to everything wins by default; the
  // setup calibrates, but a failed try there (arXiv busy, say) left the radar on the 0.70 default for good.
  let calibrated = null, calibrateTried = state.calibrateTried;
  if (chosen && config.seeds && library.radarCalibrate && wantsCalibration(config.seeds, chosen, threshold, state.calibrateTried, run.now)) {
    calibrateTried = run.now;
    const got = await calibrateRadar({ fetch: run.fetch, library, seeds: config.seeds, ...(run.sleep ? { sleep: run.sleep } : {}) });
    if (got.threshold) threshold = calibrated = got.threshold;
  }
  // Compared with what the user chose and, at a lower weight, what they liked; only the first was calibrated.
  const taught = chosen ? taughtSeeds(state) : [];
  const seeds = chosen && taught.length ? { ...chosen, taught } : chosen;
  const cut = seeds ? (threshold ? lowerBar(threshold) : DEFAULT_CUT) : undefined;
  const baseline = threshold?.calibration?.baseline ?? null;
  const scoring = { backend: library, collections, profile: config.profile, state, watched, seeds, cut, seedTitle, baseline, rankBar: baseline && threshold ? threshold.abstract : null };
  const abstracts = { ...state.abstracts };
  if (run.abstractFetch) {
    // A title shares one noun phrase with a seed and scores as if it were the seed's topic. A first pass orders the
    // title-only papers so the lookups go to those most likely to be shown; the final pass reads what was found.
    const first = await score(fresh, { ...scoring, cut: -Infinity });
    const bare = first.filter((it) => !it.abstract && (it.doi || it.arxiv)).slice(0, ABSTRACT_LOOKUPS);
    const found = bare.length ? await fillAbstracts(run.abstractFetch, bare, { cache: abstracts, now: Date.parse(run.now), lookups: ABSTRACT_LOOKUPS }) : new Map();
    for (const it of fresh) it.abstract = found.get(it.id) ?? it.abstract;
  }
  const readable = readableItems(fresh, active, Boolean(run.abstractFetch));
  let ranked = /** @type {RadarItem[]} */ ([]);
  /** @type {{ it: RadarItem, stage: 'bar' | 'judge' | 'hub gap' }[]} */
  let cuts = [];
  /** Under the bar, closest first; papers read whole and not, each against its own bar. @type {RadarItem[]} */
  let under = [];
  if (seeds && baseline && threshold) {
    const all = await score(readable, { ...scoring, cut: -Infinity });
    const decided = await decideWhole(all.filter((it) => seedBar(it) >= /** @type {number} */ (cut)), { library, seeds, threshold, seedTitle, baseline });
    const unread = all.filter((it) => seedBar(it) < /** @type {number} */ (cut)).map((it) => ({ it, gap: seedBar(it) - threshold.abstract }));
    const near = [...decided.under, ...unread].filter((u) => u.gap >= -NEAR_WINDOW && seedBar(u.it) >= unrelatedEnd(threshold, u.it));
    const hubs = (/** @type {RadarItem} */ it) => hubOnly(it, config.profile.topics);
    ranked = decided.kept.filter((it) => !hubs(it));
    under = near.sort((a, b) => b.gap - a.gap).map((u) => u.it).filter((it) => !hubs(it));
    cuts = [...decided.kept.filter(hubs), ...near.map((u) => u.it).filter(hubs)].map((it) => ({ it, stage: /** @type {const} */ ('hub gap') }));
  } else {
    ranked = await score(readable, scoring);
    if (seeds) ranked = (await decideWhole(ranked, { library, seeds, threshold, seedTitle, baseline })).kept;
  }
  let top = pickTop(ranked, config.size.fresh);
  /** @type {RadarItem[]} */
  let off = [];
  let judgeProblem = /** @type {string | null} */ (null);
  if (run.judge && (top.length || under.length)) {
    const best = pickTop(ranked, judgePool(config.size.fresh));
    const pool = [...best, ...under.slice(0, Math.max(NEAR_JUDGED, judgePool(config.size.fresh) - best.length))];
    const seedTitles = [...(config.seeds?.mine ?? []).map((m) => m.title), ...(config.seeds?.papers ?? []).map((k) => seedTitle(`zotero/${k}`))].filter((t) => t && !t.startsWith('zotero/'));
    const rejected = state.examples.negative.slice(-12).map((e) => e.text.split('. ')[0].slice(0, 200));
    const judged = await run.judge(pool, { topics: config.profile.topics.map((t) => t.text), seeds: seedTitles, rejected, liked: taught.map((t) => t.title) });
    judgeProblem = judged.error;
    // Only what was read is decided: a rejected paper is left out, the rest keep their rank.
    off = pool.filter((it) => judged.off.has(it.id));
    top = best.filter((it) => !judged.off.has(it.id)).slice(0, config.size.fresh);
    cuts.push(...off.map((it) => ({ it, stage: /** @type {const} */ ('judge') })));
    // Only what the profile check read and let through; when the check failed, nothing has been vetted.
    const room = Math.min(FILL_TO, config.size.fresh) - top.length;
    if (!judged.error && room > 0) top = [...top, ...pool.slice(best.length).filter((it) => !judged.off.has(it.id)).slice(0, room).map((it) => ({ ...it, nearBar: true }))];
  }
  const shownNow = new Set(top.map((it) => it.id));
  cuts.push(...under.filter((it) => !shownNow.has(it.id) && !off.includes(it)).map((it) => ({ it, stage: /** @type {const} */ ('bar') })));

  const missing = run.abstractFetch ? [] : top.filter((it) => !it.abstract && it.doi);
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
  const next = { ...state, refs, abstracts, ...(cuts.length ? { nearBar: nearBarLedger(cuts, run.now) } : {}), ...(calibrateTried ? { calibrateTried } : {}), phrases: { ...state.phrases, rotation: state.phrases.rotation + 1, announce: [] }, seen: { ...state.seen }, sourceStatus: { ...state.sourceStatus }, feedCache: { ...state.feedCache }, shown: { ...state.shown } };
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
  for (const it of off) for (const key of keysOf(it)) next.seen[key] = { at: run.now, verdict: 'off' };
  for (const it of [...top, ...older, ...discover]) {
    for (const key of keysOf(it)) next.seen[key] = { at: run.now, verdict: 'shown' };
    // What a click on this row needs later (radar-feedback.js): the text for the examples, the people and venue to learn.
    next.shown[it.id] = { keys: keysOf(it), title: it.title, text: `${it.title}. ${it.abstract}`.slice(0, SHOWN_TEXT), authors: it.authors, venue: it.venue, sources: it.sources, ...(it.keywords?.length ? { keywords: it.keywords } : {}) };
  }
  return { picked: top, older, olderNote, discover, discoverNote, announced: state.phrases.announce, state: next, failed, sourcesAnswered: answered, offProfile: off.length, judgeProblem, requests: fetched.requests + olderRequests + discoverRequests, threshold: calibrated };
}

/** The radar's ledger of what was cut near the bar on its last run, and where: per stage, the closest first (they come in that order).
 *  @param {{ it: RadarItem, stage: 'bar' | 'judge' | 'hub gap' }[]} cuts @param {string} at @returns {import("./radar-types").NearBarLedger} */
function nearBarLedger(cuts, at) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  const rows = [];
  for (const { it, stage } of cuts) {
    const n = counts.get(stage) ?? 0;
    if (n >= NEAR_BAR_STAGE) continue;
    counts.set(stage, n + 1);
    rows.push({ title: it.title, seed: it.why?.seed?.title ?? '', margin: it.why?.seed?.margin ?? 0, stage });
  }
  return { at, rows };
}

/** Where the unrelated fields end for this paper's kind of text; nothing from there on is near the user's interests.
 *  @param {import("./radar-types").RadarThreshold} threshold @param {RadarItem} it */
const unrelatedEnd = (threshold, it) => (it.why?.seed?.whole ? threshold.calibration?.full : threshold.calibration?.abstract)?.unrelated?.p95 ?? -Infinity;

/**
 * The candidates worth ranking. A book or book chapter, and a paper only a database search found that still has no
 * abstract once abstracts were looked up (`looked`), is judged on its title alone, and a title shares a word with some
 * seed often enough to pass (2026-10-29: a nucleation chapter from Crossref at 0.86). They are left out. A journal or
 * feed the user follows keeps its papers without abstracts (many publisher feeds send none), and an author they follow
 * keeps everything.
 * @param {RadarItem[]} items @param {import("./radar-types").RadarSource[]} active @param {boolean} looked
 */
export function readableItems(items, active, looked) {
  const followed = new Set(active.flatMap((s) => (s.kind === 'author' ? [s.id] : [])));
  const searchedOnly = (/** @type {RadarItem} */ it) => it.sources.every((id) => id.startsWith('database:'));
  return items.filter((it) => it.sources.some((id) => followed.has(id))
    || (!BOOK_KINDS.has(it.kind ?? '') && !(looked && searchedOnly(it) && !it.abstract)));
}

/**
 * A seed radar calibrates on a run when it has no threshold, or when its seeds or the calibration's logic changed since
 * (one made before calibrations remembered their seeds is kept); not when a try failed less than a day ago, nor with fewer seeds
 * than the server's minimum and no collection to fill them.
 * @param {import("./radar-types").RadarSeeds} seeds @param {import("./radar-types").SeedBody} body
 * @param {import("./radar-types").RadarThreshold | null} threshold @param {string | undefined} tried @param {string} now
 */
function wantsCalibration(seeds, body, threshold, tried, now) {
  if (tried && Date.parse(now) - Date.parse(tried) < CALIBRATE_RETRY_MS) return false;
  if (!body.collections.length && body.keys.length + body.texts.length < MIN_SEEDS) return false;
  const made = threshold?.calibration;
  return !threshold || Boolean(made?.seedsKey && (made.seedsKey !== seedsKey(seeds) || (made.version ?? 1) < CALIBRATION_VERSION));
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

/** The arXiv candidates to read whole, best first: at most WHOLE_PAPERS, and WHOLE_SEED_SHARE closest to one seed.
 *  @param {RadarItem[]} ranked */
function wholeList(ranked) {
  /** @type {Map<string, number>} */
  const perSeed = new Map();
  const out = [];
  for (const it of ranked) {
    if (!it.arxiv || out.length >= WHOLE_PAPERS) continue;
    const seed = it.why?.seed?.label ?? '';
    if ((perSeed.get(seed) ?? 0) >= WHOLE_SEED_SHARE) continue;
    perSeed.set(seed, (perSeed.get(seed) ?? 0) + 1);
    out.push(it);
  }
  return out;
}

/**
 * The whole-paper pass (spec 021 G3, D2): arXiv candidates past the abstract cut are read whole (wholeList) and
 * judged on that; the rest, and any paper that could not be read, are judged on their abstract. A paper with no arXiv
 * copy can never be read, and 0 of 248 journal papers passed the abstract bar (2026-11-03) while preprints passed
 * through the whole-paper one: on a calibrated radar it is judged at the bar that gets a preprint read, and ranks from there.
 * @param {RadarItem[]} ranked best first, each with why.similarity to its closest seed
 * @param {{ library: import("./tools").LibraryBackend, seeds: import("./radar-types").SeedBody, threshold: import("./radar-types").RadarThreshold | null, seedTitle: (label: string) => string, baseline?: import("./radar-types").SeedBaseline | null }} ctx
 * @returns {Promise<{ kept: RadarItem[], under: { it: RadarItem, gap: number }[] }>} `gap`: how far past (under: below) the bar that paper had to clear
 */
async function decideWhole(ranked, ctx) {
  const abstractCut = ctx.threshold?.abstract ?? DEFAULT_CUT;
  const wholeCut = ctx.threshold?.full ?? null;
  /** @type {Record<string, { seed_max?: number, seed_best?: string | null, seed_raw?: number, seed_second?: number | null, seed_lonely?: boolean, error?: string }>} */
  let whole = {};
  const toRead = wholeList(ranked);
  if (wholeCut != null && toRead.length && ctx.library.radarFulltext) {
    for (let i = 0; i < toRead.length; i += WHOLE_BATCH) {
      const items = toRead.slice(i, i + WHOLE_BATCH).map((it) => ({ id: it.id, arxiv: /** @type {string} */ (it.arxiv) }));
      try { Object.assign(whole, await ctx.library.radarFulltext({ seeds: ctx.seeds, items, ...(ctx.baseline ? { baseline: ctx.baseline } : {}) })); } catch { /* those papers keep their abstract */ }
    }
  }
  const noCopy = ctx.baseline && ctx.threshold ? ctx.threshold.abstract - lowerBar(ctx.threshold) : 0;
  const out = [], under = [];
  for (const it of ranked) {
    const w = whole[it.id];
    if (w && typeof w.seed_max === 'number' && w.seed_best) {
      const read = rescoreWhole(it, w.seed_raw ?? w.seed_max, { label: w.seed_best, title: ctx.seedTitle(w.seed_best), margin: Math.round(w.seed_max * 1000) / 1000, ...neighbour(w) }, ctx.baseline ? wholeCut : null);
      if (w.seed_max >= /** @type {number} */ (wholeCut)) out.push(read); else under.push({ it: read, gap: w.seed_max - /** @type {number} */ (wholeCut) });
    } else {
      const bar = it.arxiv ? abstractCut : abstractCut - noCopy;
      if (seedBar(it) >= bar) out.push(it.arxiv ? it : { ...it, score: Math.round(((it.score ?? 0) + noCopy) * 1000) / 1000 }); else under.push({ it, gap: seedBar(it) - bar });
    }
  }
  return { kept: out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)), under };
}
