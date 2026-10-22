// @ts-check
// ui-src/src/chat/steps-data.js. Pure helpers for spec 007 E6 (grouped mode menu, "+ Add step", the empty state's
// session cards, history rows, the picker that makes an `import from: "selection"` step). No DOM, so node tests run it.
// The small paper mappings here are reimplemented in ui-src on purpose: the built bundle must not import
// agent-src/src/sessions.js (papersFromFind lives there; find-view.js's own papersResult() does the Find mapping).

/** @typedef {import("../../../agent/src/domain").ResultSummary} ResultSummary */
/** @typedef {import("../../../agent/src/domain").PaperRow} PaperRow */

/** The mode menu (spec 007 §7, decision 1). */
export const MODE_GROUPS = [
  { label: 'Workflows', ids: ['chat', 'report', 'systematic', 'routines'] },
  { label: 'Tools', ids: ['find', 'papers', 'extract', 'ask'] },
];

/** Modes that need a paper set: they start with a picker when the session has none. */
export const PICKER_MODES = ['papers', 'extract'];

/** Modes that open a view in the thread instead of a conversation (Routines, spec 011 U4): never remembered as `chatMode`. */
export const VIEW_MODES = ['routines'];

/** The two modes that start a review (spec 007): a Research report and a Systematic review share the composer and the ReportView. @param {string} mode */
export const isReviewMode = (mode) => mode === 'report' || mode === 'systematic';

/** Old saved `chatMode` values keep working (the four original ids are unchanged); anything unknown is Chat. The two
 *  picker modes and Routines are transient, never remembered.
 *  @param {unknown} saved @param {string[]} known */
export function normalizeMode(saved, known) {
  return typeof saved === 'string' && known.includes(saved) && !PICKER_MODES.includes(saved) && !VIEW_MODES.includes(saved) ? saved : 'chat';
}

/** Icon names for modes the icon set has no glyph of that name for. */
export const MODE_ICON = { papers: 'paper', extract: 'columns', systematic: 'report', routines: 'clock' };
/** @param {string} id */
export const modeIconName = (id) => MODE_ICON[/** @type {"papers" | "extract"} */ (id)] ?? id;

/** What "+ Add step" offers for a result of this kind (spec 007 §7); a step that is not built yet is not listed.
 *  @param {string | null | undefined} kind @param {{ columns?: boolean, report?: boolean }} [can] `columns`: the engine can fill
 *  columns; `report`: it runs pipeline 2, so a paper set or table can start a report (spec 007 E7)
 *  @returns {{ id: "columns" | "keep" | "chat" | "report", label: string, icon: string }[]} */
export function stepChoices(kind, can = {}) {
  if (kind === 'papers') {
    return [
      ...(can.columns === false ? [] : [{ id: /** @type {const} */ ('columns'), label: 'Add columns', icon: 'columns' }]),
      { id: 'keep', label: 'Keep filtered rows', icon: 'filter' },
      { id: 'chat', label: 'Chat with these', icon: 'chat' },
      ...(can.report ? [{ id: /** @type {const} */ ('report'), label: 'Report on these', icon: 'report' }] : []),
    ];
  }
  if (kind === 'table') {
    return [
      { id: 'chat', label: 'Chat about this table', icon: 'chat' },
      ...(can.report ? [{ id: /** @type {const} */ ('report'), label: 'Write a report from this', icon: 'report' }] : []),
    ];
  }
  if (kind === 'report') return [{ id: 'chat', label: 'Chat about this report', icon: 'chat' }];
  return [];
}

/** The composer's chip: "On: Excited-state ML V2". @param {ResultSummary} summary */
export function onLabel(summary) {
  return `On: ${summary.title} V${summary.ref.version}`;
}

/** The result the next step works on: the one the user picked, else the newest, unless the user cleared it.
 *  @param {ResultSummary[]} results @param {{ id: string } | null | undefined} picked @param {boolean} cleared */
export function currentResult(results, picked, cleared) {
  if (cleared || !results.length) return null;
  const chosen = picked && results.find((r) => r.ref.id === picked.id);
  if (chosen) return chosen;
  return [...results].sort((a, b) => (a.updated < b.updated ? 1 : -1))[0];
}

export const SESSION_KIND_NAME = { chat: 'Chat', find: 'Find papers', report: 'Research report', systematic: 'Systematic review' };
export const SESSION_KIND_ICON = { chat: 'chat', find: 'find', report: 'report', systematic: 'report' };

/** "just now", "5 minutes ago", "3 hours ago", "4 days ago", then the date. @param {string} iso @param {number} [now] */
export function ago(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return new Date(at).toLocaleDateString();
}

/** "Research report · 4 days ago". @param {{ kind?: string, updated: string }} summary @param {number} [now] */
export function sessionMeta(summary, now) {
  return `${SESSION_KIND_NAME[/** @type {"chat"} */ (summary.kind ?? 'chat')] ?? 'Chat'} · ${ago(summary.updated, now)}`;
}

/** "1 artifact", "5 artifacts". @param {number} n */
export const artifactsWord = (n) => `${n} ${n === 1 ? 'artifact' : 'artifacts'}`;

/**
 * What the history lists, once each. A saved Find search whose JSON carries a `session` that exists is replaced by that
 * session (a Find or an imported search); the session row opens the search (`search` is set on it). Everything else
 * stays as it was.
 * @param {{ id: string, mode: string, title: string, updated: string, artifacts?: number, kind?: string }[]} conversations
 * @param {{ id: string, query: string, at: string, count: number, session?: string | null }[]} searches
 * @returns {{ sessions: { conversation: any, search: any | null }[], searches: any[] }}
 */
export function historyEntries(conversations, searches) {
  const chats = conversations.filter((c) => c.mode === 'chat');
  const bySession = new Map(searches.filter((s) => s.session).map((s) => [s.session, s]));
  const ids = new Set(chats.map((c) => c.id));
  return {
    sessions: chats.map((conversation) => ({ conversation, search: bySession.get(conversation.id) ?? null })),
    searches: searches.filter((s) => !(s.session && ids.has(s.session))),
  };
}

/** The cards of the empty state: the three most recent sessions, newest first (context suggestions follow as pills).
 *  @template T @param {T[]} sessionsNewestFirst @param {number} [max] */
export function cardSplit(sessionsNewestFirst, max = 3) {
  return sessionsNewestFirst.slice(0, max);
}

/** @param {string} title */
const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

/** A paper row from a library row (host.searchLibrary) or, failing that, from what a chip knows.
 *  @param {any} row @returns {PaperRow} */
export function paperRowFromLibrary(row) {
  const citekey = row.ref?.kind === 'paper' ? row.ref.citekey : null;
  return {
    id: /** @type {any} */ (citekey ? `p:${citekey}` : row.doi ? `doi:${String(row.doi).toLowerCase()}` : `t:${slug(row.title ?? '')}`),
    ref: citekey ? { kind: 'paper', citekey } : { kind: 'web', url: row.doi ? `https://doi.org/${row.doi}` : row.url ?? '' },
    inLibrary: true, title: row.title ?? '(untitled)', authors: row.authors ?? [], year: row.year ?? null, venue: row.venue ?? '',
    doi: row.doi ?? null, url: row.url ?? null, abstract: row.abstract ?? '', citations: row.citations ?? null,
    fullText: Boolean(row.fullText), pdfUrl: row.pdfUrl ?? null, studyType: row.studyType ?? null, foundBy: ['Your library'],
  };
}

/** @param {{ attachment: any, label: string }} item @returns {PaperRow | null} */
export function paperRowFromContext(item) {
  if (item.attachment?.kind !== 'zoteroItem') return null;
  return paperRowFromLibrary({ ref: { kind: 'paper', citekey: item.attachment.citekey }, title: item.label });
}

/** The draft an import step stores (the engine assigns the result id, version and step).
 *  @param {string} label @param {PaperRow[]} rows */
export function importDraft(label, rows) {
  return {
    kind: /** @type {const} */ ('papers'), ref: { id: 'R1', version: 1 }, title: label, created: new Date().toISOString(), madeBy: 'S1', from: [],
    change: 'Imported papers', query: null, rows, columns: [], cells: {}, screening: null, summary: null,
  };
}

/** Rows unique by id, in order. @param {PaperRow[]} rows */
export function uniqueRows(rows) {
  const seen = new Set();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}
