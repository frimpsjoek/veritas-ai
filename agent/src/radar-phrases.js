// @ts-check
// agent-src/src/radar-phrases.js. Spec 017 K1: key phrases out of a paper the user liked. Deterministic and local: no
// model call, so the same rating always teaches the same thing. A phrase scores by how rare it is in the papers the radar
// has shown (idf against the seen stream) and is thrown out when dismissed papers carry it as often as liked ones do.

/** @typedef {{ title: string, text: string, keywords?: string[] }} PhrasePaper */

export const PHRASES_PER_PAPER = 6;
/** Liked papers a phrase must come from before it is searched (spec 017 D1). */
export const LEARN_AFTER = 3;
/** Learned topics kept at once; the weakest goes when an 11th arrives (D4). */
export const MAX_LEARNED = 10;
export const LEARNED_WEIGHT = 0.6;
/** What one Not relevant takes off a learned topic, and one more supporting paper adds. */
export const LEARNED_STEP = 0.2;
/** A learned topic below this is no longer searched; at zero it is dropped and never learned again. */
export const LEARNED_FLOOR = 0.25;
const MAX_WORDS = 4;
/** More than this share of the seen stream holding a phrase makes it background, not taste. Needs a stream to judge by. */
const COMMON_SHARE = 0.5;
const MIN_STREAM = 8;

const STOP = new Set(('a an the and or but nor of in on at to for from by with without within into onto over under about above below between among through during before after ' +
  'as is are was were be been being am do does did done have has had having it its this that these those their there then than so such not no yes can could may might must shall should will would ' +
  'we our us you your they them he she his her i me my which who whom whose what when where why how while whether either neither both each every any all some most more less much many few other another same ' +
  'also however thus hence therefore here via per vs versus et al e.g i.e').split(/\s+/));
/** Words every paper uses: they say nothing about the topic. */
const GENERIC = new Set(('novel approach approaches result results study studies paper papers method methods propose proposed present presented show shows shown showed using use used uses based ' +
  'new recent recently work works article research analysis demonstrate demonstrated demonstrates investigate investigated introduce introduced develop developed provide provides provided ' +
  'high low large small good better best different various several number numbers important significant significantly general generally potential possible further future early order ' +
  'first second third one two three four five case cases effect effects model models data performance application applications problem problems technique techniques framework system systems ' +
  'process review overview perspective abstract introduction conclusion conclusions achieve achieves achieved improve improves improved existing current well still often well-known ' +
  'increase increased increasing obtain obtained observe observed observes report reported find found finding findings suggest suggests ' +
  'discuss discussed discusses examine examined examines describe described describes explore explored explores consider considered considers reveal revealed reveals ' +
  'explain explained explains discussed discussion identify identified identifies include includes included provide offer offers allow allows enable enables ' +
  'advance advances advanced available thesis theses concept concepts proof proofs term terms multiple candidate candidates property properties strength strengths ' +
  'role roles type types class classes family families scheme schemes strategy strategies question questions challenge challenges aspect aspects issue issues ' +
  'tool tools key main major minor simple complex fundamental basic general unified efficient accurate robust scalable generalized extended improved ' +
  'experimental practical empirical like embargo expires room-temperature wide-range high-order high-performance data-efficient cost-effective state-of-the-art').split(/\s+/));

/** DFT, GW, MoS2: two capitals, or a capital and a digit. */
const FORMULA = /^(?=(?:.*\p{Lu}){2}|.*\p{Lu}.*\d)[\p{L}\d]{2,8}$/u;

const fold = (/** @type {string} */ s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** "networks" and "network" are one word; "ss" and short words are left alone. */
const stem = (/** @type {string} */ w) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') ? w.slice(0, -1) : w);
/** @param {string} text the folded words of a phrase or a document @returns {string[]} */
const tokens = (text) => fold(text).match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];

/** The same words in any order are one phrase. @param {string} text @returns {string} */
export function phraseKey(text) {
  return [...new Set(tokens(text).filter((w) => !STOP.has(w)).map(stem))].sort().join(' ');
}

/** True when every word of the phrase is in the text, in any order. @param {string} key a `phraseKey` @param {string} text */
export function carries(key, text) {
  if (!key) return false;
  const bag = new Set(tokens(text).map(stem));
  return key.split(' ').every((w) => bag.has(w));
}

/** Runs of content words, split at stop words, generic words, numbers and punctuation. @param {string} text @returns {string[][]} */
function chunks(text) {
  /** @type {string[][]} */
  const out = [];
  for (const segment of text.split(/[.,;:!?()[\]{}"“”‘’/\\]|\s[-–—]+\s|\n/)) {
    /** @type {string[]} */
    let run = [];
    for (const raw of segment.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []) {
      const w = fold(raw);
      if (STOP.has(w) || GENERIC.has(w) || /^\d+$/.test(w) || (w.length < 3 && !FORMULA.test(raw))) { if (run.length) out.push(run); run = []; } else run.push(raw);
    }
    if (run.length) out.push(run);
  }
  return out;
}

/** Every 1- to 4-word phrase of a document, as `key -> { text, count }`. @param {string} text @param {number} weight */
function grams(text, weight, /** @type {Map<string, { text: string, count: number }>} */ into, fromKeyword = false) {
  for (const run of chunks(text)) {
    for (let i = 0; i < run.length; i++) {
      for (let n = 1; n <= MAX_WORDS && i + n <= run.length; n++) {
        const words = run.slice(i, i + n);
        // One word says too little: it must come from the source's keywords, be an acronym or formula (DFT, MoS2), or be a hyphenated compound.
        if (n === 1 && !fromKeyword && !FORMULA.test(words[0]) && !words[0].includes('-')) continue;
        if (n === 1 && !fromKeyword && fold(words[0]).length < 2) continue;
        const key = phraseKey(words.join(' '));
        if (!key) continue;
        const text = n === 1 && FORMULA.test(words[0]) ? words[0] : words.join(' ').toLowerCase();
        const hit = into.get(key);
        if (hit) hit.count += weight; else into.set(key, { text, count: weight });
      }
    }
  }
}

/** Every phrase key a document holds, for document frequencies. @param {string} text @returns {Set<string>} */
function keysOfDoc(text) {
  /** @type {Map<string, { text: string, count: number }>} */
  const m = new Map();
  grams(text, 1, m);
  return new Set(m.keys());
}

/**
 * The phrases worth remembering from one liked paper, best first.
 * @param {PhrasePaper} paper
 * @param {{ liked: string[], dismissed: string[], seen: string[] }} ctx texts of the liked papers (this one included), the dismissed ones, and the other papers the radar has shown
 * @returns {{ key: string, text: string }[]}
 */
export function extractPhrases(paper, ctx) {
  /** @type {Map<string, { text: string, count: number }>} */
  const own = new Map();
  grams(paper.text, 1, own);
  grams(paper.title, 2, own);
  for (const kw of paper.keywords ?? []) {
    const run = chunks(kw);
    if (run.length === 1 && run[0].length <= MAX_WORDS) grams(run[0].join(' '), 3, own, true);
  }

  const df = (/** @type {string[]} */ docs) => {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (const d of docs) for (const k of keysOfDoc(d)) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const seenDf = df(ctx.seen), likedDf = df(ctx.liked), dismissedDf = df(ctx.dismissed);
  const nSeen = ctx.seen.length, nLiked = Math.max(1, ctx.liked.length), nDismissed = ctx.dismissed.length;

  const scored = [];
  for (const [key, { text, count }] of own) {
    const inSeen = seenDf.get(key) ?? 0;
    if (nSeen >= MIN_STREAM && inSeen / nSeen > COMMON_SHARE) continue;
    const bad = dismissedDf.get(key) ?? 0;
    if (bad > 0 && bad / nDismissed >= (likedDf.get(key) ?? 1) / nLiked) continue;
    const idf = 1 + Math.log((nSeen + 1) / (inSeen + 1));
    const size = key.split(' ').length;
    scored.push({ key, text, size, count, score: count * idf * (1 + 0.4 * (size - 1)) });
  }
  scored.sort((a, b) => b.score - a.score || b.size - a.size || (a.key < b.key ? -1 : 1));

  // A word inside a longer phrase that is at least as frequent here adds nothing.
  const wordsOf = scored.map((c) => new Set(c.key.split(' ')));
  const picked = scored.filter((c, i) => !scored.some((p, j) => p.size > c.size && p.count >= c.count && [...wordsOf[i]].every((w) => wordsOf[j].has(w)))).slice(0, PHRASES_PER_PAPER);
  return picked.map(({ key, text }) => ({ key, text }));
}
