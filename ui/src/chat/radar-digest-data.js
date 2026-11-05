// @ts-check
// ui-src/src/chat/radar-digest-data.js. Spec 012 R4: the pure part of the digest view, tested in node. What a radar row says
// under its title, which actions it offers, and the words of the toast. radar-digest.js draws it.

/** @typedef {import("../../../agent/src/domain").PaperRow} PaperRow */
/** @typedef {import("../../../agent/src/domain").Result} Result */
/** @typedef {"added" | "later" | "liked" | "dismissed"} Verdict */
/** @typedef {import("../host").OutsidePaper} OutsidePaper */

export const NO_ABSTRACT = 'No abstract to go on';

/** The routine and summary line of a radar digest's result, or null for any other result. @param {Result | null | undefined} result */
export function digestOf(result) {
  const radar = result?.kind === 'papers' ? result.radar : undefined;
  return radar?.routine ? { routine: radar.routine, summary: radar.summary } : null;
}

/** A row's radar key, or null when the row did not come from a radar (it then has no actions). @param {PaperRow} row */
export const keyOf = (row) => row.radar?.key ?? null;

/**
 * The line under a title: a New row's "why read this" (or the plain note that there was no abstract), a Worth reading row's
 * cited-by reason. `muted` marks the note, which is not a reason.
 * @param {PaperRow} row @returns {{ text: string, muted: boolean } | null}
 */
export function rowLine(row) {
  const radar = row.radar;
  if (!radar) return null;
  if (radar.reason) return { text: radar.reason, muted: false };
  if (radar.why_line) return { text: radar.why_line, muted: false };
  return row.abstract ? null : { text: NO_ABSTRACT, muted: true };
}

/** @typedef {{ logo: "zotero" } | { lucide: "bookmark" | "thumbsUp" | "thumbsDown" }} Mark the action's icon: a brand logo, or a Lucide icon */

/**
 * The row's actions; each says in its tooltip (and to a screen reader) what it does and teaches, and `key` is the
 * letter that does the same from the keyboard on Home. The first saves the paper: Add to Zotero where this setup has
 * a Zotero library, Read later where it has none.
 * @param {boolean} canAdd whether this host can add to the library
 * @returns {{ verdict: Verdict, label: string, key: string, primary: boolean, mark: Mark, hint: string }[]}
 */
export function actionList(canAdd) {
  /** @type {{ verdict: Verdict, label: string, key: string, primary: boolean, mark: Mark, hint: string }} */
  const save = canAdd
    ? { verdict: 'added', label: 'Add to Zotero', key: 'a', primary: true, mark: { logo: 'zotero' }, hint: 'Add to Zotero: save this paper to your library (more like this)' }
    : { verdict: 'later', label: 'Read later', key: 'a', primary: true, mark: { lucide: 'bookmark' }, hint: 'Read later: keep this paper on your reading list (more like this)' };
  return [
    save,
    { verdict: 'liked', label: 'Like', key: 'l', primary: false, mark: { lucide: 'thumbsUp' }, hint: 'Like: show me more papers like this' },
    { verdict: 'dismissed', label: 'Not for me', key: 'd', primary: false, mark: { lucide: 'thumbsDown' }, hint: 'Not for me: show fewer papers like this' },
  ];
}

/** What a settled row says in place of its actions: what happened, and what the radar took from it. @param {Verdict} verdict */
export const settledLabel = (verdict) => (verdict === 'added' ? 'Added to Zotero' : verdict === 'later' ? 'Saved to read later' : verdict === 'liked' ? 'Liked: more like this' : 'Not for me: fewer like this');

/** The toast after a click, and after Undo. @param {Verdict | 'undo'} verdict */
export function toastText(verdict) {
  if (verdict === 'undo') return 'Undone';
  return verdict === 'added' ? 'Added to Zotero' : verdict === 'later' ? 'Saved to read later' : settledLabel(verdict);
}

/** @typedef {{ kind: 'seed' | 'topic' | 'author' | 'journal' | 'note' | 'via', text: string, hint: string }} WhyChip */

const SEED_TITLE_MAX = 48;

/**
 * Why the radar matched a paper, as a quiet line of facts from `radar.why` (radar-types RadarWhy): the closest seed,
 * a learned or followed topic, a followed author or journal, then where it came from. Display only. `titleOnly`
 * and `nearBar` (a row just under the threshold, which the scoring may mark; absent on older issues) are notes.
 * @param {PaperRow} row @returns {WhyChip[]}
 */
export function whyChips(row) {
  const radar = /** @type {any} */ (row.radar);
  if (!radar) return [];
  const why = radar.why ?? null;
  /** @type {WhyChip[]} */ const out = [];
  if (why?.seed?.title) {
    const title = why.seed.title.length > SEED_TITLE_MAX ? `${why.seed.title.slice(0, SEED_TITLE_MAX).replace(/\s+\S*$/, '')}\u2026` : why.seed.title;
    out.push({ kind: 'seed', text: `close to \u201C${title}\u201D`, hint: `Closest of your seed papers (${Math.round((why.similarity ?? 0) * 100) / 100}, ${why.seed.whole ? 'whole paper' : 'abstract'})` });
  }
  if (why?.learned) out.push({ kind: 'topic', text: why.learned, hint: 'A topic the radar learned from papers you liked' });
  else if (why && why.topic > 0) out.push({ kind: 'topic', text: 'a topic you follow', hint: 'Matches one of your topics' });
  if (why && why.author > 0) out.push({ kind: 'author', text: 'an author you follow', hint: 'One of its authors is in your profile' });
  if (why && why.journal > 0) out.push({ kind: 'journal', text: 'a journal you follow', hint: 'Published in a journal you follow' });
  if (why && why.titleOnly) out.push({ kind: 'note', text: 'title only', hint: 'No abstract: judged by its title alone, so it counts less' });
  if (radar.nearBar === true) out.push({ kind: 'note', text: 'just under the bar', hint: 'Scored just below the threshold; shown so you can say whether it belongs' });
  const via = (row.foundBy ?? []).filter(Boolean);
  const sources = via.length ? via : (radar.sources ?? []).filter(Boolean);
  if (sources.length) out.push({ kind: 'via', text: `via ${sources.join(', ')}`, hint: 'Where the radar found it' });
  return out;
}

/** @typedef {{ label: string, url: string, kind: 'full' | 'pdf' | 'abstract' | 'publisher', outside: boolean }} OpenLink */

/** @param {string} url */
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/**
 * The ways into a paper from its entry, best first: the full text (fullText on its url), the PDF, the abstract (its
 * DOI, which the reader shows as the paper's page, else its url), and the publisher's page outside when its address
 * is not already one of those. Each address once.
 * @param {PaperRow} row @returns {OpenLink[]}
 */
export function openLinks(row) {
  /** @type {OpenLink[]} */ const out = [];
  const seen = new Set();
  const add = (/** @type {OpenLink} */ link) => { if (link.url && !seen.has(link.url) && /^https?:\/\//i.test(link.url)) { seen.add(link.url); out.push(link); } };
  if (row.fullText && row.url) add({ label: 'Full text', url: row.url, kind: 'full', outside: false });
  if (row.pdfUrl) add({ label: 'PDF', url: row.pdfUrl, kind: 'pdf', outside: false });
  const abstract = row.doi ? `https://doi.org/${row.doi}` : row.url;
  if (abstract) add({ label: 'Abstract', url: abstract, kind: 'abstract', outside: false });
  if (row.url && row.doi) add({ label: hostOf(row.url) || 'publisher', url: row.url, kind: 'publisher', outside: true });
  return out;
}

/** The progress line under an issue's papers. @param {number} judged @param {number} total */
export function judgedLine(judged, total) {
  if (total > 0 && judged >= total) return `All ${total} judged \u00B7 thank you, the radar learned from each`;
  return `${judged} of ${total} judged \u00B7 every click teaches the radar`;
}

/** Home's keys: j / k move between papers, a / l / d judge the current one. Nothing while typing or with a modifier.
 *  @param {{ key: string, target: any, metaKey: boolean, ctrlKey: boolean, altKey: boolean }} event
 *  @returns {'next' | 'prev' | Verdict | null} */
export function keyAction(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const tag = String(event.target?.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) return null;
  return event.key === 'j' ? 'next' : event.key === 'k' ? 'prev' : event.key === 'a' ? 'added' : event.key === 'l' ? 'liked' : event.key === 'd' ? 'dismissed' : null;
}

/** A row as the host's "add to library" takes it. @param {PaperRow} row @returns {OutsidePaper} */
export function outsidePaper(row) {
  return {
    title: row.title, authors: row.authors, year: row.year, venue: row.venue, doi: row.doi, abstract: row.abstract,
    url: row.doi ? `https://doi.org/${row.doi}` : row.url, source: row.foundBy[0] ?? 'radar',
    arxiv: row.pdfUrl?.match(/arxiv\.org\/pdf\/([^?#]+)/i)?.[1] ?? null, citations: row.citations,
  };
}
