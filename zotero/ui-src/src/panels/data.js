// @ts-check
// ui-src/src/panels/data.js. The pure (no DOM) half of the panel components (spec 005 D1): what a search hit's
// second line says, how close a similar paper is, and how the Papers / Notes pills plus the "More" source filter
// turn into the server's `source` / `exclude_source` parameters. Node tests cover all of it (test/panels-data.test.js).

/** @typedef {{ authors?: string[], year?: string | number, venue?: string, citekey?: string, doi?: string, url?: string, type?: string, collections?: string[], zotero_uri?: string }} ZoteroMeta */
/** @typedef {{ path: string, title: string, zotero?: ZoteroMeta | null, modified?: string, passages?: { heading?: string, snippet: string }[] }} HitLike */

/** "Zotero", "PDF", "Image" or null (a Markdown note) -- which badge a result row shows. @param {string} path */
export function badgeOf(path) {
  if (path.startsWith('zotero/')) return 'Zotero';
  if (/\.pdf$/i.test(path)) return 'PDF';
  if (!path.endsWith('.md')) return 'Image';
  return null;
}

/** @param {string} path */
export const isPaperPath = (path) => path.startsWith('zotero/');

/** "Chen et al." / "Chen & Ruiz" from full names. @param {string[] | undefined} authors */
export function shortAuthors(authors) {
  const list = authors ?? [];
  const last = (/** @type {string} */ a) => a.split(' ').pop() ?? a;
  return list.length > 2 ? `${last(list[0])} et al.` : list.map(last).join(' & ');
}

/** "Chen et al. · 2022 · Nature" @param {ZoteroMeta | null | undefined} z */
export function byline(z) {
  if (!z) return '';
  return [shortAuthors(z.authors), z.year, z.venue].filter(Boolean).join(' · ');
}

/** @param {string} path */
export function folderOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? 'Vault' : path.slice(0, i);
}

/** The second line of a result row: authors, year and venue for a paper; folder and date for a note or file.
 *  @param {HitLike} hit */
export function metaOf(hit) {
  if (isPaperPath(hit.path)) return byline(hit.zotero) || 'Paper';
  return [folderOf(hit.path), hit.modified].filter(Boolean).join(' · ');
}

/** Snippets are raw Markdown; strip the marks that read as noise in a preview. @param {string} text */
export function tidy(text) {
  return String(text ?? '').replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
}

/** @param {string} text */
export function lastHeading(text) {
  return text ? text.split(' > ').pop() ?? '' : '';
}

/**
 * Where the pills and the More filter point the search. A chosen source wins (it is a finer cut of one pill);
 * Papers alone is `source=zotero`, Notes alone is everything but Zotero (`exclude_source=zotero`, spec 005 A1),
 * both or neither is no filter.
 * @param {{ papers: boolean, notes: boolean, specific?: string }} state
 * @returns {{ source: string, exclude: string }}
 */
export function scopeOf(state) {
  if (state.specific) return { source: state.specific, exclude: '' };
  if (state.papers && !state.notes) return { source: 'zotero', exclude: '' };
  if (state.notes && !state.papers) return { source: '', exclude: 'zotero' };
  return { source: '', exclude: '' };
}

/** Choosing a specific source in More sets the pills to the side it belongs to. @param {string} specific */
export function pillsFor(specific) {
  if (!specific) return { papers: true, notes: true };
  return specific === 'zotero' ? { papers: true, notes: false } : { papers: false, notes: true };
}

/**
 * Toggling a pill flips that side. A chosen source is dropped first (the pills are the coarser control and the user
 * just used them); turning the last one off resets to both on, so a search never has nothing to search.
 * @param {{ papers: boolean, notes: boolean, specific?: string }} state @param {'papers' | 'notes'} key
 */
export function togglePill(state, key) {
  const next = state.specific ? { ...pillsFor(state.specific) } : { papers: state.papers, notes: state.notes };
  next[key] = !next[key];
  if (!next.papers && !next.notes) { next.papers = true; next.notes = true; }
  return { ...next, specific: '' };
}

/** Graded against this library (spec 007 notes, 2026-09-22): an unrelated pair of papers scores about 0.73 and 99% of
 *  pairs stay under 0.86. A host with its own model (Zotero standalone) passes its calibration percentiles.
 *  @param {number} score @param {{ p90: number, p99: number, p999: number, p9999: number, p50?: number } | null} [calibration]
 *  @returns {{ level: number, label: string, tip: string }} */
export function closeness(score, calibration = null) {
  const steps = calibration ? [calibration.p9999, calibration.p999, calibration.p99, calibration.p90] : [0.92, 0.88, 0.85, 0.8];
  const table = /** @type {[number, number, string][]} */ ([[steps[0], 5, 'Very close'], [steps[1], 4, 'Close'], [steps[2], 3, 'Related'], [steps[3], 2, 'Loosely related'], [-1, 1, 'Distant']]);
  const [, level, label] = table.find(([min]) => score >= min) ?? table[4];
  const tip = calibration && calibration.p50 != null
    ? `${label}: similarity ${score.toFixed(2)}. Two unrelated papers in your library score about ${calibration.p50.toFixed(2)}; ${calibration.p99.toFixed(2)} is closer than 99% of pairs.`
    : `${label}: similarity ${score.toFixed(2)}. Two unrelated papers score about 0.73; 0.86 is closer than 99% of pairs.`;
  return { level, label, tip };
}

/** "3 min", "2.1 h" @param {number} seconds */
export function duration(seconds) {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/** @param {number} epochSeconds @param {number} [now] */
export function ago(epochSeconds, now = Date.now() / 1000) {
  const s = now - epochSeconds;
  return s < 60 ? 'just now' : `${duration(s)} ago`;
}

/** @param {number} epochSeconds @param {number} [now] */
export function until(epochSeconds, now = Date.now() / 1000) {
  const s = epochSeconds - now;
  return s <= 30 ? 'any moment' : `in ${duration(s)}`;
}
