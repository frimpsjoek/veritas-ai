// @ts-check
// ui-src/src/chat/fuzzy.js. Ranking for the `+`/`@` context picker (spec 008 C3): a small subsequence matcher,
// at most 30 results, shown grouped by category in a fixed order.

/** @typedef {import("../host").ContextCandidate} ContextCandidate */

export const PICKER_LIMIT = 30;
/** Category order and heading, fixed whatever the scores. */
export const PICKER_CATEGORIES = /** @type {const} */ ([['note', 'Notes'], ['paper', 'Papers'], ['collection', 'Collections']]);

/**
 * Higher is better; null when `query` is not a subsequence of `text`. Consecutive letters and letters at a word
 * start score more, a plain substring more again, so "vole" ranks "Vole diary" above "various old entries".
 * @param {string} query @param {string} text
 */
export function fuzzyScore(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 3;
    if (at === 0 || !/[a-z0-9]/.test(t[at - 1])) score += 2;
    prev = at;
    from = at + 1;
  }
  const sub = t.indexOf(q);
  if (sub !== -1) score += sub === 0 ? 15 : 10;
  return score - t.length * 0.01;
}

/** Matches each category keeps even when another category has more, better-scoring ones. */
const CATEGORY_SHARE = 5;

/**
 * The picker's rows: up to `limit` matches, grouped by PICKER_CATEGORIES order. Each category's best
 * CATEGORY_SHARE matches are kept first, so 8,000 notes can't hide the one matching paper; the rest of the rows go
 * to the best scores overall. An empty query shows the first few of each category instead.
 * @param {ContextCandidate[]} candidates @param {string} query @param {number} [limit]
 * @returns {{ category: ContextCandidate["category"], heading: string, items: ContextCandidate[] }[]}
 */
export function rankCandidates(candidates, query, limit = PICKER_LIMIT) {
  /** @type {ContextCandidate[]} */
  let chosen;
  if (!query.trim()) {
    const each = Math.floor(limit / PICKER_CATEGORIES.length);
    chosen = PICKER_CATEGORIES.flatMap(([category]) => candidates.filter((c) => c.category === category).slice(0, each));
  } else {
    const ranked = candidates
      .map((c) => ({ c, score: fuzzyScore(query.trim(), c.label) }))
      .filter((r) => r.score !== null)
      .sort((a, b) => /** @type {number} */ (b.score) - /** @type {number} */ (a.score))
      .map((r) => r.c);
    const keep = new Set(PICKER_CATEGORIES.flatMap(([category]) => ranked.filter((c) => c.category === category).slice(0, CATEGORY_SHARE)));
    for (const c of ranked) {
      if (keep.size >= limit) break;
      keep.add(c);
    }
    chosen = ranked.filter((c) => keep.has(c));
  }
  return PICKER_CATEGORIES
    .map(([category, heading]) => ({ category, heading, items: chosen.filter((c) => c.category === category) }))
    .filter((group) => group.items.length);
}
