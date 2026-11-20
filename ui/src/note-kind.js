// @ts-check
// ui/src/note-kind.js. Spec 029 R15: what kind of note a path is (a daily note, a saved chat, a reading digest, an
// AI note, a web clipping, a video transcript, a Notion import, a project note, or any other note), so the Notes page
// gives each kind its own mark and can be filtered by kind. Pure: path, title and index source in, a kind out.

/** @typedef {'daily' | 'chat' | 'digest' | 'ai' | 'clip' | 'video' | 'notion' | 'project' | 'note'} NoteKind */

/** Label, the filter's plural, and the icon (ui/src/icons.js) of each kind, in the order the filter lists them. */
export const NOTE_KINDS = /** @type {const} */ ({
  note: { label: 'Note', plural: 'Notes', icon: 'note' },
  daily: { label: 'Daily note', plural: 'Daily notes', icon: 'calendar' },
  project: { label: 'Project note', plural: 'Projects', icon: 'folder' },
  chat: { label: 'Saved chat', plural: 'Chats', icon: 'chat' },
  digest: { label: 'Reading digest', plural: 'Digests', icon: 'scholarly' },
  ai: { label: 'AI note', plural: 'AI notes', icon: 'sparkle' },
  clip: { label: 'Web clipping', plural: 'Clippings', icon: 'web' },
  video: { label: 'Video notes', plural: 'Videos', icon: 'play' },
  notion: { label: 'From Notion', plural: 'Notion', icon: 'book' },
});

/** The folder path inside a listed folder ("notion:/x/y.md" → "x/y.md"); vault paths as they are. @param {string} path */
const innerOf = (path) => path.replace(/^[a-z0-9][a-z0-9-]{0,31}:\//, '');

/** @param {string} path @param {string} [source] the index's source name ("personal", "Notion", "Clippings", "youtube", "ai_notes") @returns {NoteKind} */
export function noteKind(path, source = '') {
  const inner = innerOf(String(path));
  const src = String(source).toLowerCase();
  const file = inner.slice(inner.lastIndexOf('/') + 1);
  if (src === 'ai_notes' || /^(ai_notes|copilot)\//i.test(inner)) return 'ai';
  if (src === 'youtube' || /(^|\/)youtube\//i.test(inner)) return 'video';
  if (src === 'clippings' || /(^|\/)clippings\//i.test(inner)) return 'clip';
  if (src === 'notion' || /(^|\/)notion\//i.test(inner)) return 'notion';
  if (/(^|\/)chats\//i.test(inner)) return 'chat';
  if (/(^|\/)digests\//i.test(inner) || /reading radar\.md$/i.test(file)) return 'digest';
  if (/^\d{4}-\d{2}-\d{2}\.(md|markdown|txt)$/i.test(file)) return 'daily';
  if (/(^|\/)projects?\//i.test(inner)) return 'project';
  return 'note';
}

/** The kinds present in `rows`, in NOTE_KINDS order, with how many of each. @param {{ kind: NoteKind }[]} rows */
export function kindCounts(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  return /** @type {NoteKind[]} */ (Object.keys(NOTE_KINDS)).filter((k) => counts.has(k)).map((kind) => ({ kind, count: counts.get(kind) }));
}

/** "2026-11-18 11:58" (the index's local time) or an ISO time, as epoch ms; NaN when it is neither. @param {string} [modified] */
export const modifiedAt = (modified) => Date.parse(String(modified ?? '').trim().replace(' ', 'T'));

/** The day group a time falls in: Today, Yesterday, This week (the 7 days before), Earlier. @param {number} at @param {number} [now] */
export function dayGroup(at, now = Date.now()) {
  if (!Number.isFinite(at)) return 'Earlier';
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const day = 86400000;
  if (at >= start.getTime()) return 'Today';
  if (at >= start.getTime() - day) return 'Yesterday';
  if (at >= start.getTime() - 6 * day) return 'This week';
  return 'Earlier';
}

/** A title fit to read: a saved chat without its date and id ("2026-11-18 Reading radar (27JGZMXS)" → "Reading radar",
 *  "2026-11-16_batoms_phase-2c-test_89f01f" → "batoms phase 2c test"); a daily note as its day ("Wed, Nov 18, 2026").
 *  Anything else as it is. @param {string} title @param {NoteKind} kind */
export function readableTitle(title, kind) {
  const t = String(title);
  if (kind === 'daily') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (!m) return t;
    const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (kind !== 'chat') return t;
  let s = t.replace(/^\d{4}-\d{2}-\d{2}[ _]+/, '').replace(/\s*\([A-Z0-9]{6,10}\)$/, '').replace(/_[0-9a-f]{6}$/, '');
  if (/^[\w-]+$/.test(s) && /[_-]/.test(s)) s = s.replace(/[_-]+/g, ' ');
  return s.trim() || t;
}

/** "3 hours ago" for the last two weeks, then the day ("Oct 1"; "Oct 1, 2025" in another year). @param {number} at @param {number} [now] */
export function whenLine(at, now = Date.now()) {
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
