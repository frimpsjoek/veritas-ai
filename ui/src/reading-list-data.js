// @ts-check
// ui/src/reading-list-data.js. Spec 028 R10-R12: the pure part of Read later, tested in node. The words, the id a paper
// is listed under (the engine's own rule), the Unread and Read sections, the badge count, and which entries are
// already in the Zotero library. reading-list.js and the web app's later view draw it.
import { idOf, idsOf } from '../../agent/src/reading-list.js';
import { plainProse } from './paper-text.js';
import { ago } from './chat/steps-data.js';

/** @typedef {import("../../agent/src/service").ReadingListEntry} ReadingListEntry */

export const LATER = 'Read later';
export const SAVED = 'Saved to read later';
export const REMOVE = 'Remove from Read later';
export const MARK_READ = 'Mark as read';
export const MARK_UNREAD = 'Mark as unread';
export const UNREAD = 'Unread';
export const READ = 'Read';
export const LATER_EMPTY = 'Nothing saved to read later yet.';
export const NOTHING_UNREAD = 'Nothing unread. What you have read is below.';
export const LATER_FAILED = "Couldn't load your Read later list.";
export const IN_ZOTERO = 'In your Zotero library';

/** The id a paper is (or would be) listed under, or null. @param {Partial<import("../../agent/src/service").ReadingListPaper>} paper */
export const readingId = (paper) => idOf(paper);

/** The entry `paper` is on the list as, by any id either one has (DOI, arXiv id, address), or null: a paper saved by
 *  its arXiv id shows as saved where it is opened by its DOI. @param {ReadingListEntry[] | null | undefined} list
 *  @param {Partial<import("../../agent/src/service").ReadingListPaper>} paper @returns {ReadingListEntry | null} */
export function listedAs(list, paper) {
  const ids = idsOf(paper);
  if (!list || !ids.length) return null;
  return list.find((e) => ids.includes(e.id)) ?? list.find((e) => idsOf(e).some((id) => ids.includes(id))) ?? null;
}

/** The bookmark's words: what it shows, and its tooltip (what pressing it does). @param {boolean} saved */
export const bookmarkCopy = (saved) => (saved
  ? { label: SAVED, hint: REMOVE }
  : { label: LATER, hint: 'Read later: keep this paper to read when you are ready' });

/** The badge: entries not read yet. @param {ReadingListEntry[]} entries */
export const unreadCount = (entries) => entries.filter((e) => !e.read).length;

const desc = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? 1 : a > b ? -1 : 0);

/** Unread, newest added first (oldest first for `order` 'oldest'), then Read, most recently read first.
 *  @param {ReadingListEntry[]} entries @param {'newest' | 'oldest'} [order] */
export function laterSections(entries, order = 'newest') {
  const byAdded = order === 'oldest' ? (/** @type {ReadingListEntry} */ a, /** @type {ReadingListEntry} */ b) => desc(b.added, a.added) : (/** @type {ReadingListEntry} */ a, /** @type {ReadingListEntry} */ b) => desc(a.added, b.added);
  return {
    unread: entries.filter((e) => !e.read).sort(byAdded),
    read: entries.filter((e) => e.read).sort((a, b) => desc(String(a.read), String(b.read)) || desc(a.added, b.added)),
  };
}

/** Spec 029 R1: when it went on the list, "Saved 3 days ago" ("Liked …" for a paper a Like put there); after two weeks
 *  the day, "Saved on Nov 3". @param {ReadingListEntry} entry @param {number} [now] */
export function savedLine(entry, now = Date.now()) {
  const when = ago(entry.added, now);
  if (!when) return '';
  const verb = entry.via === 'like' ? 'Liked' : 'Saved';
  if (/ago$|^just now$/.test(when)) return `${verb} ${when}`;
  const at = new Date(entry.added);
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  return `${verb} on ${at.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

/** The line under a title: venue and year. @param {ReadingListEntry} entry */
export const entryMeta = (entry) => [entry.venue, entry.year ? String(entry.year) : ''].filter(Boolean).join(' · ');

// TeX accents as letters first (plainProse), so "M{\o}ller" and "Møller" fold alike
const fold = (/** @type {unknown} */ title) => plainProse(title).normalize('NFC').toLowerCase().replace(/<[^>]+>|\\[a-z]*|[^\p{L}\p{N}\\]+/gu, '');

/** Entries already in Zotero, matched by DOI or else by title, to the item's key.
 *  @param {ReadingListEntry[]} entries @param {{ key: string, title: string, doi?: string }[]} rows the library's items
 *  @returns {Map<string, string>} entry id -> Zotero key */
export function zoteroKeys(entries, rows) {
  const byDoi = new Map(), byTitle = new Map();
  for (const row of rows) {
    if (row.doi) byDoi.set(String(row.doi).toLowerCase(), row.key);
    const t = fold(row.title);
    if (t.length >= 12 && !byTitle.has(t)) byTitle.set(t, row.key);
  }
  const out = new Map();
  for (const e of entries) {
    const key = (e.doi && byDoi.get(e.doi.toLowerCase())) || byTitle.get(fold(e.title));
    if (key) out.set(e.id, key);
  }
  return out;
}

/** Spec 029 R4: the filter box and the sort switch show once the list holds this many papers. */
export const LATER_TOOLS_AT = 10;
export const LATER_FILTER = 'Filter by title, author or journal';
export const SORT_NEWEST = 'Newest saved';
export const SORT_OLDEST = 'Oldest saved';
/** @param {string} q */
export const noMatch = (q) => `No papers match “${q}”.`;

// letters and digits only, accents and case off, TeX drawn first: "Møller", "M{\o}ller" and "moller" are one
const words = (/** @type {unknown} */ v) => plainProse(v).normalize('NFD').replace(/\p{M}+/gu, '').replace(/ø/gi, 'o').toLowerCase();

/** Entries whose title, authors or venue hold every word of `query`. An empty query keeps them all.
 *  @param {ReadingListEntry[]} entries @param {string} query */
export function filterLater(entries, query) {
  const want = words(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!want.length) return entries;
  return entries.filter((e) => {
    const hay = words([e.title, ...(e.authors ?? []), e.venue].join(' '));
    return want.every((w) => hay.includes(w));
  });
}
