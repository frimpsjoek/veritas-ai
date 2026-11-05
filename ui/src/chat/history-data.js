// @ts-check
// ui-src/src/chat/history-data.js. The pure side of the chat history list: the day groups (Today / Yesterday /
// Earlier), the short "when" label of a row, and the client-side "Find a chat" filter. No DOM; chat.js draws them.

/** @typedef {{ kind: string, at?: string, conversation?: { title?: string }, progress?: { question?: string }, search?: { query?: string } }} ListEntry */

const DAY_MS = 86_400_000;

/** @param {string | Date} iso @param {Date} now */
function daysBefore(iso, now) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return Infinity;
  const start = (/** @type {Date} */ d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(now) - start(date)) / DAY_MS);
}

/** The group a row belongs to. @param {string} iso @param {Date} [now] @returns {'Today' | 'Yesterday' | 'Earlier'} */
export function dayGroup(iso, now = new Date()) {
  const days = daysBefore(iso, now);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : 'Earlier';
}

/** The entries, already in order, under their group headings; a group with nothing in it is left out.
 *  @template {{ at?: string }} T @param {T[]} entries @param {Date} [now] @returns {{ label: string, entries: T[] }[]} */
export function groupEntries(entries, now = new Date()) {
  /** @type {{ label: string, entries: T[] }[]} */ const groups = [];
  for (const entry of entries) {
    const label = dayGroup(entry.at ?? '', now);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.entries.push(entry); else groups.push({ label, entries: [entry] });
  }
  return groups;
}

/** A time for today, "Oct 27" for another day this year, "Mar 3, 2025" for an older one. @param {string} iso @param {Date} [now] */
export function whenLabel(iso, now = new Date()) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  if (daysBefore(iso, now) <= 0) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Does a title match what was typed in "Find a chat"? Every word must appear, in any order. @param {string} title @param {string} query */
export function matchesFind(title, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = title.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** What a history row is called, whatever its kind. @param {ListEntry} entry */
export function entryTitle(entry) {
  if (entry.kind === 'chat') return entry.conversation?.title ?? '';
  if (entry.kind === 'report') return entry.progress?.question || 'Research report';
  return entry.search?.query ?? '';
}
