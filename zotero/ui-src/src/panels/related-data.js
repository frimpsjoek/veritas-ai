// @ts-check
// ui-src/src/panels/related-data.js. The pure half of the Related, Links and Duplicates panels (spec 013 W2), ported
// from obsidian-plugin/src/{related,duplicates,links}.ts so Obsidian and the web app group, label and word
// them the same way. No DOM; test/related-data.test.js covers it.
import { byline, closeness, metaOf, tidy } from './data.js';

/** @typedef {{ path: string, title: string, source?: string, zotero?: import("./data.js").ZoteroMeta | null }} NoteRef */
/** @typedef {NoteRef & { score: number }} Similar */
/** @typedef {NoteRef & { tags: string[] }} TagMatch */
/** @typedef {NoteRef & { heading: string, score: number, snippet: string }} SectionMatch */
/** @typedef {{ path: string, links_to: string[], linked_from: string[], refs?: Record<string, NoteRef>, similar?: Similar[], shared_tags?: TagMatch[] }} Related */
/** @typedef {{ exact: string[][], near: { paths: string[], score: number }[], zotero: NoteRef[][] }} Duplicates */
/** @typedef {{ copy: string, original: string, copy_chars: number, original_chars: number, copy_newer: boolean }} ConflictEntry */
/** @typedef {{ total: number, identical: ConflictEntry[], different: ConflictEntry[], no_original: { copy: string }[] }} Conflicts */
/** @typedef {NoteRef & { note?: string, score?: number, heading?: string | null }} RelRow */
/** @typedef {{ links: string[], backlinks: string[] }} LocalLinks */

/** The server marks a wiki link with no note behind it. */
const MISSING = '(no note)';

/** @param {string} path */
export function titleOf(path) {
  return path.split('/').pop()?.replace(/\.md$/, '') ?? path;
}

/** @param {string} path */
export const isMissing = (path) => path.endsWith(MISSING);

/** @param {NoteRef} ref */
export const isZoteroRef = (ref) => ref.path.startsWith('zotero/');

/**
 * The "Linked" rows: every note this one links to or that links here, each once, labelled by direction. Links come from
 * the index when it answered (they include Zotero citations); `local` is the host's own link graph for when it did not
 * (Obsidian on a phone without the Mac). Wiki links to notes that do not exist are dropped from the index's list.
 * @param {Related | null} related @param {LocalLinks | null} [local]
 * @returns {RelRow[]}
 */
export function linkedRows(related, local = null) {
  const outgoing = related ? related.links_to.filter((p) => !isMissing(p)) : local?.links ?? [];
  const backlinks = related ? related.linked_from : local?.backlinks ?? [];
  const both = new Set(outgoing.filter((p) => backlinks.includes(p)));
  return [...new Set([...outgoing, ...backlinks])].map((path) => ({
    ...(related?.refs?.[path] ?? { path, title: titleOf(path) }),
    note: both.has(path) ? 'both ways' : backlinks.includes(path) ? 'links here' : 'linked',
  }));
}

/** @param {Related} related @returns {RelRow[]} */
export function similarRows(related) {
  return (related.similar ?? []).map((s) => ({ ...s, note: byline(s.zotero) || undefined }));
}

/** A tag weight (e.g. 6.9) is not a similarity, so these rows carry no score. @param {Related} related @returns {RelRow[]} */
export function tagRows(related) {
  return (related.shared_tags ?? []).map((t) => ({ ...t, score: undefined, note: t.tags.map((tag) => `#${tag}`).join(' ') }));
}

/** Passages of other notes that sit close to the section being edited. @param {SectionMatch[]} matches @returns {RelRow[]} */
export function sectionRows(matches) {
  return matches.map((m) => ({ ...m, note: tidy(m.snippet).slice(0, 140) }));
}

/** The meta line of a related row: its own note, else the generic one for a paper or file. @param {RelRow} row */
export function rowMeta(row) {
  return row.note ?? (metaOf(/** @type {any} */ (row)) || undefined);
}

/** @param {RelRow} row */
export function rowScore(row) {
  return row.score !== undefined ? closeness(row.score) : null;
}

/** What to tell the user when /related fails. A 404 means the note is not indexed yet and can be added.
 *  @param {{ status?: number, message?: string }} error @returns {{ message: string, notIndexed: boolean }} */
export function relatedProblem(error) {
  if (error.status === 404) return { message: "This note isn't in the index yet. New notes are added every 5 minutes.", notIndexed: true };
  return { message: `Couldn't load related notes: ${error.message ?? 'unknown error'}`, notIndexed: false };
}

/**
 * The link graph of one note for the Links panel: outgoing and incoming, missing notes kept apart (they are shown but
 * cannot be opened), and a note that links both ways appears in both lists.
 * @param {{ links_to?: string[], linked_from?: string[] }} links
 * @returns {{ outgoing: NoteRef[], incoming: NoteRef[], missing: string[] }}
 */
export function linkGroups(links) {
  const to = links.links_to ?? [];
  const ref = (/** @type {string} */ path) => ({ path, title: titleOf(path) });
  return {
    outgoing: to.filter((p) => !isMissing(p)).map(ref),
    incoming: (links.linked_from ?? []).map(ref),
    missing: to.filter(isMissing).map((p) => p.slice(0, -MISSING.length).trim()),
  };
}

export const DUPLICATE_TABS = /** @type {const} */ ([['exact', 'Identical'], ['near', 'Nearly identical'], ['conflicts', 'Sync conflicts'], ['zotero', 'Zotero']]);
/** @typedef {"exact" | "near" | "conflicts" | "zotero"} DuplicateTab */

/** @param {Duplicates | null} dups @param {Conflicts | null} conflicts @param {DuplicateTab} tab */
export function duplicateCount(dups, conflicts, tab) {
  if (!dups || !conflicts) return 0;
  return tab === 'conflicts' ? conflicts.total : dups[tab].length;
}

/** @param {string[]} paths @returns {NoteRef[]} */
const refsOf = (paths) => paths.map((path) => ({ path, title: titleOf(path) }));

/** The groups of one tab and the sentence that explains them; null for the conflicts tab, which has its own layout.
 *  @param {Duplicates} dups @param {DuplicateTab} tab @returns {{ intro: string, groups: { refs: NoteRef[], score?: number }[] } | null} */
export function duplicateGroups(dups, tab) {
  if (tab === 'exact') return { intro: 'Notes with exactly the same text.', groups: dups.exact.map((paths) => ({ refs: refsOf(paths) })) };
  if (tab === 'near') {
    return { intro: 'Notes whose content is almost the same (similarity 0.985 or more, similar length). Compare before removing.', groups: dups.near.map((g) => ({ refs: refsOf(g.paths), score: g.score })) };
  }
  if (tab === 'zotero') return { intro: 'Zotero items with the same DOI or title. Merge them in Zotero (Duplicate Items).', groups: dups.zotero.map((refs) => ({ refs })) };
  return null;
}

/** @param {Conflicts} c */
export function conflictIntro(c) {
  return `${c.total} copies made by sync conflicts. ${c.identical.length} are identical to their original; ${c.different.length} differ and need a look.`;
}

/** @param {ConflictEntry} entry */
export function conflictMeta(entry) {
  const folder = entry.original.includes('/') ? entry.original.slice(0, entry.original.lastIndexOf('/')) : 'Vault';
  return `${folder} · copy ${entry.copy_chars.toLocaleString()} chars vs original ${entry.original_chars.toLocaleString()}${entry.copy_newer ? ' · copy is newer' : ''}`;
}
