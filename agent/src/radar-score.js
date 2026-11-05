// @ts-check
// agent-src/src/radar-score.js. Spec 012 R1: ranks candidate papers with no model call. The server's embeddings give
// each paper a similarity to the library and a closeness to dismissed papers; rules add the rest. Every part is kept on
// the row (`why`) so "why is this here" has an answer.

/** @typedef {import("./radar-types").RadarItem} RadarItem */

/** Tuned in R5 against the user's ratings. Nothing else in the radar holds a number that changes ranking. */
export const SCORE_BATCH = 500;

export const WEIGHTS = {
  followedAuthor: 0.15,
  watchedJournal: 0.10,
  topicMatch: 0.05,
  /** At most this many topic lines count, so a long profile cannot swamp similarity. */
  topicCap: 3,
  /** A topic line matches when this share of its words appear in the title or abstract. */
  topicWords: 0.6,
  /** Closeness to a dismissed paper below this costs nothing; at 1.0 it costs `negativePenalty`. */
  negativeStart: 0.8,
  negativePenalty: 0.3,
  /** A paper with no abstract is embedded from its title alone, and a short title sharing one noun phrase with a seed
   *  scores close to it whatever the paper is about. On the 2026-10-29 issue, the five papers scored both ways were
   *  0.04-0.13 closer by title alone (mean 0.078), so a title-only paper counts this much less and must clear the
   *  floor (or a seed radar's cut) by as much. */
  titleOnly: 0.08,
  /** Rows scoring below this are not worth a place in a digest: a day with none writes nothing. */
  floor: 0.7, // 2026-10-11 live run: similarities 0.61-0.86 (median 0.73); an unrelated text scored 0.68
  /** Examples sent to the server per call. */
  exampleCap: 50,
};

/** On a calibrated seed radar the score is the margin past the bar (0.00-0.10 on 2026-11-03), so the bonuses that
 *  were sized for plain similarity would decide the ranking on their own; these are the same bonuses at that scale. */
export const BAR_WEIGHTS = { followedAuthor: 0.02, watchedJournal: 0.01, topicMatch: 0.01, negativePenalty: 0.1 };

const fold = (/** @type {string} */ s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Words that say nothing about a topic: "AI agents for science" matched any paper with "agents" and "for". */
const STOP = new Set('the and for with from into of in on to by at an as is be or not via using towards toward their its'.split(' '));
const words = (/** @type {string} */ s) => fold(s).replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));

/** "Jane Q. Smith", "Smith, J." and "J Smith" all become "smith j". @param {string} name */
export function nameKey(name) {
  const { last, given } = nameParts(name);
  return last ? `${last} ${given[0] ?? ''}`.trim() : '';
}

/** @param {string} name @returns {{ last: string, given: string }} the first given name whole ("zhen-fei"), or its initial */
function nameParts(name) {
  const clean = fold(name).replace(/[.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return { last: '', given: '' };
  const parts = clean.includes(',') ? clean.split(',').map((p) => p.trim()) : null;
  const last = parts ? parts[0] : clean.split(' ').at(-1) ?? '';
  const given = (parts ? parts[1] ?? '' : clean.split(' ').slice(0, -1).join(' ')).split(' ')[0] ?? '';
  return { last, given };
}

/** The same person: the last names agree, and so do the given names when both are written out ("Zhen-Fei Liu" is not
 *  "Zhao Liu"); a side that gives only an initial matches on it. @param {string} a @param {string} b */
export function sameName(a, b) {
  const x = nameParts(a), y = nameParts(b);
  if (!x.last || x.last !== y.last) return false;
  if (x.given.length <= 1 || y.given.length <= 1) return (x.given[0] ?? '') === (y.given[0] ?? '');
  return x.given === y.given;
}

export const venueKey = (/** @type {string} */ v) => fold(v).replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * @param {RadarItem[]} items
 * @param {{
 *   backend: Pick<import("./tools").LibraryBackend, 'radarScore'>,
 *   collections: string[] | null,
 *   profile: import("./radar-types").RadarProfile,
 *   state: Pick<import("./radar-types").RadarState, 'examples'>,
 *   watched?: { authors?: string[], journals?: string[] },
 *   seeds?: import("./radar-types").SeedBody | null,
 *   cut?: number,
 *   seedTitle?: (label: string) => string,
 *   baseline?: import("./radar-types").SeedBaseline | null,
 *   rankBar?: number | null,
 * }} ctx `watched` adds names from author and journal sources the user switched on to the profile's own lists.
 *   `seeds` (spec 021): similarity is to the closest seed, not the library average; `cut` replaces the floor
 *   (the abstract pass of a seed radar keeps a little below its threshold; the full-text pass decides).
 *   `rankBar`: a calibrated radar's abstract threshold; such a radar ranks on how far a paper is past it.
 * @returns {Promise<RadarItem[]>} the items at or above the floor, best first, each with `score` and `why`
 */
export async function score(items, ctx) {
  if (!items.length) return [];
  if (!ctx.backend.radarScore) throw new Error('The library server does not offer scoring.');
  const text = (/** @type {RadarItem} */ it) => `${it.title}. ${it.abstract}`.slice(0, 2000);
  const positives = ctx.state.examples.positive.slice(-WEIGHTS.exampleCap).map((e) => e.text);
  const negatives = ctx.state.examples.negative.slice(-WEIGHTS.exampleCap).map((e) => e.text);
  /** @type {Record<string, import("./radar-types").SeedScore>} */
  const scores = {};
  // The server takes at most SCORE_BATCH items per call; a busy day across many sources has more.
  for (let i = 0; i < items.length; i += SCORE_BATCH) {
    const part = await ctx.backend.radarScore({
      scope: { collections: ctx.collections }, positives, negatives,
      items: items.slice(i, i + SCORE_BATCH).map((it) => ({ id: it.id, text: text(it) })),
      ...(ctx.seeds ? { seeds: ctx.seeds } : {}), ...(ctx.seeds && ctx.baseline ? { baseline: ctx.baseline } : {}),
    });
    Object.assign(scores, part);
  }

  /** @type {{ name: string, weight: number }[]} */
  const authors = [];
  /** @type {Map<string, number>} */
  const journals = new Map();
  for (const a of ctx.profile.authors) if (nameKey(a.name)) authors.push({ name: a.name, weight: a.weight });
  for (const n of ctx.watched?.authors ?? []) if (nameKey(n) && !authors.some((a) => sameName(a.name, n))) authors.push({ name: n, weight: 1 });
  for (const j of ctx.profile.journals) journals.set(venueKey(j.name), j.weight);
  for (const n of ctx.watched?.journals ?? []) if (!journals.has(venueKey(n))) journals.set(venueKey(n), 1);
  journals.delete('');
  const topics = ctx.profile.topics.map((t) => ({ text: t.text, learned: t.origin === 'learned', words: [...new Set(words(t.text))], weight: t.weight })).filter((t) => t.words.length);
  const W = ctx.rankBar != null ? { ...WEIGHTS, ...BAR_WEIGHTS } : WEIGHTS;

  const out = items.map((it) => {
    const s = scores[it.id] ?? { similarity: 0, negative: 0 };
    const hit = it.authors.flatMap((a) => authors.filter((f) => sameName(f.name, a)).map((f) => f.weight));
    const venue = journals.get(venueKey(it.venue));
    const bag = new Set(words(`${it.title} ${it.abstract}`));
    const hits = topics.filter((t) => t.words.filter((w) => bag.has(w)).length / t.words.length >= WEIGHTS.topicWords);
    const matched = hits.slice(0, WEIGHTS.topicCap);
    const learnedHit = hits.find((t) => t.learned);
    // Seed radar: show the plain similarity to the closest seed; keep or drop on its margin over that seed's baseline.
    const seed = ctx.seeds && s.seed_best ? { label: s.seed_best, title: ctx.seedTitle?.(s.seed_best) ?? s.seed_best, whole: false, margin: round(s.seed_max ?? 0) } : null;
    const why = {
      similarity: round(ctx.seeds ? s.seed_raw ?? s.seed_max ?? 0 : s.similarity),
      ...(seed ? { seed } : {}),
      author: hit.length ? round(W.followedAuthor * Math.max(...hit)) : 0,
      journal: venue != null ? round(W.watchedJournal * venue) : 0,
      topic: round(matched.reduce((sum, t) => sum + W.topicMatch * t.weight, 0)),
      negative: round(-W.negativePenalty * Math.max(0, s.negative - WEIGHTS.negativeStart) / (1 - WEIGHTS.negativeStart)) || 0,
      ...(learnedHit ? { learned: learnedHit.text } : {}),
      ...(String(it.abstract ?? '').trim() ? {} : { titleOnly: -WEIGHTS.titleOnly }),
    };
    return { ...it, why, score: round(fit(why.similarity, seed?.margin, ctx.rankBar) + why.author + why.journal + why.topic + why.negative + (why.titleOnly ?? 0)) };
  });
  const cut = ctx.cut ?? WEIGHTS.floor;
  // A seed radar's threshold is calibrated on similarity alone (spec 021 G4); the bonuses only rank.
  const kept = ctx.seeds ? out.filter((it) => seedBar(it) >= cut) : out.filter((it) => (it.score ?? 0) >= cut);
  return kept.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

const round = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;

/** What ranks a paper. Plain similarity favours whatever is close to the whole field, and a whole paper scores higher than
 *  an abstract whatever it is about (2026-11-02: 13 of 15 rows matched one broad seed, all 15 read whole). A calibrated
 *  radar ranks on how far the margin is past the threshold for that kind of text, which compares both fairly.
 *  @param {number} similarity @param {number | undefined} margin @param {number | null | undefined} bar */
const fit = (similarity, margin, bar) => (bar != null && margin != null ? margin - bar : similarity);

/** What a seed radar's cut compares: the margin over the closest seed's baseline, less the title-only discount.
 *  @param {RadarItem} it */
export const seedBar = (it) => (it.why?.seed?.margin ?? it.why?.similarity ?? 0) + (it.why?.titleOnly ?? 0);

/** The score again after the paper was read whole (spec 021 G3): the whole-paper similarity replaces the
 *  abstract's, the bonuses stay. `bar`: a calibrated radar's whole-paper threshold.
 *  @param {RadarItem} it @param {number} similarity @param {{ label: string, title: string, margin?: number }} seed @param {number | null} [bar] */
export function rescoreWhole(it, similarity, seed, bar = null) {  // seed: { label, title, margin? }
  // Read whole, the paper is no longer judged on its title.
  const { titleOnly: _read, ...rest } = /** @type {import("./radar-types").RadarWhy} */ (it.why);
  const why = /** @type {import("./radar-types").RadarWhy} */ ({ ...rest, similarity: round(similarity), seed: { ...seed, whole: true } });
  return { ...it, why, score: round(fit(why.similarity, seed.margin, bar) + why.author + why.journal + why.topic + why.negative) };
}
