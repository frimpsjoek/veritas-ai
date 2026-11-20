// @ts-check
// ui-src/src/home/waiting.js. Spec 028 R5: how many new papers wait, the one count Home's "N new papers" line and the
// web rail's Home badge both show. Only radar issues with news from the last NEWS_DAYS count: an older issue stays on
// the Earlier issues shelf, but its unread papers are no longer "waiting".

/** Days an issue's unread papers count as waiting. */
export const NEWS_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * The unread radar papers over the conversations whose news is at most NEWS_DAYS old. An issue's age is `news.at`,
 * when the newest run that brought it unread papers ran (sessions.js newsOf), else the conversation's `updated`: a
 * chat about an old issue moves `updated` but brings no new papers, so `news.at` is the better clock. A date that
 * cannot be read counts (news is never hidden by a bad date).
 * @param {any[]} conversations as `conversations.list()` gives them @param {number} [now] ms, for tests
 * @returns {number}
 */
export function waitingPapers(conversations, now = Date.now()) {
  const since = now - NEWS_DAYS * DAY_MS;
  let sum = 0;
  for (const c of conversations ?? []) {
    const papers = Number(c?.news?.papers) || 0;
    if (papers <= 0) continue;
    const at = Date.parse(c.news.at || c.updated || '');
    if (Number.isFinite(at) && at < since) continue;
    sum += papers;
  }
  return sum;
}
