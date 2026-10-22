// @ts-check
// ui-src/src/chat/radar-digest-data.js. Spec 012 R4: the pure part of the digest view, tested in node. What a radar row says
// under its title, which actions it offers, and the words of the toast. radar-digest.js draws it.

/** @typedef {import("../../../agent-src/src/domain").PaperRow} PaperRow */
/** @typedef {import("../../../agent-src/src/domain").Result} Result */
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
 * The row's actions, drawn as icons alone; each says in its tooltip (and to a screen reader) what it does and teaches.
 * The first saves the paper: Add to Zotero where this setup has a Zotero library, Read later where it has none.
 * @param {boolean} canAdd whether this host can add to the library
 * @returns {{ verdict: Verdict, label: string, primary: boolean, mark: Mark, hint: string }[]}
 */
export function actionList(canAdd) {
  /** @type {{ verdict: Verdict, label: string, primary: boolean, mark: Mark, hint: string }} */
  const save = canAdd
    ? { verdict: 'added', label: 'Add to Zotero', primary: true, mark: { logo: 'zotero' }, hint: 'Add to Zotero: save this paper to your library (more like this)' }
    : { verdict: 'later', label: 'Read later', primary: true, mark: { lucide: 'bookmark' }, hint: 'Read later: keep this paper on your reading list (more like this)' };
  return [
    save,
    { verdict: 'liked', label: 'Like', primary: false, mark: { lucide: 'thumbsUp' }, hint: 'Like: show me more papers like this' },
    { verdict: 'dismissed', label: 'Dislike', primary: false, mark: { lucide: 'thumbsDown' }, hint: 'Dislike: not relevant, show fewer papers like this' },
  ];
}

/** What a settled row says in place of its actions. @param {Verdict} verdict */
export const settledLabel = (verdict) => (verdict === 'added' ? 'Added to Zotero' : verdict === 'later' ? 'Saved to read later' : verdict === 'liked' ? 'Liked' : 'Disliked');

/** The toast after a click, and after Undo. @param {Verdict | 'undo'} verdict */
export function toastText(verdict) {
  if (verdict === 'undo') return 'Undone';
  return verdict === 'added' ? 'Added to Zotero' : verdict === 'later' ? 'Saved to read later' : verdict === 'liked' ? 'Liked: more like this' : 'Disliked: fewer like this';
}

/** A row as the host's "add to library" takes it. @param {PaperRow} row @returns {OutsidePaper} */
export function outsidePaper(row) {
  return {
    title: row.title, authors: row.authors, year: row.year, venue: row.venue, doi: row.doi, abstract: row.abstract,
    url: row.doi ? `https://doi.org/${row.doi}` : row.url, source: row.foundBy[0] ?? 'radar',
    arxiv: row.pdfUrl?.match(/arxiv\.org\/pdf\/([^?#]+)/i)?.[1] ?? null, citations: row.citations,
  };
}
