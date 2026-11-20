// @ts-check
// ui-src/src/web/library-data.js. The pure half of the Library view: item rows from /zotero/items and /search, the
// sort, the visible window of a long table, the collection tree, and the chat context a ticked row becomes.

/** @typedef {{ key: string, title: string, authors: string[], year: number | null, venue: string, citekey: string, doi: string }} LibRow */
/** @typedef {{ key: string, name: string, parent: string | null, count: number }} CollectionNode */
/** @typedef {{ node: CollectionNode, depth: number, hasChildren: boolean, open: boolean }} TreeRow */
/** @typedef {{ by: "relevance" | "year" | "title", dir: 1 | -1 }} SortState */

/** One /zotero/items entry, reduced to what the table shows (the abstract is the bulk of the payload and is dropped).
 *  @param {any} item @returns {LibRow} */
export function rowOfItem(item) {
  const year = Number.parseInt(item.year, 10);
  return {
    key: String(item.key), title: String(item.title || 'Untitled'), authors: Array.isArray(item.authors) ? item.authors : [],
    year: Number.isFinite(year) ? year : null, venue: String(item.venue ?? ''), citekey: String(item.citekey ?? ''), doi: String(item.doi ?? ''),
  };
}

/** A /search hit for a paper (path zotero/KEY) as a row; other hits are not papers. @param {any} hit @returns {LibRow | null} */
export function rowOfHit(hit) {
  if (!hit?.zotero || !String(hit.path).startsWith('zotero/')) return null;
  return rowOfItem({ ...hit.zotero, key: String(hit.path).slice('zotero/'.length), title: hit.title });
}

// One collator each, made once: localeCompare with options builds one per call, and a sort of ~3,500 rows makes ~40,000.
const BY_TITLE = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const BY_TITLE_PLAIN = new Intl.Collator(undefined, { sensitivity: 'base' });

/** Newest first for the year, A to Z for the title (`dir` flips it); papers with no year sort last either way.
 *  `relevance` keeps the order the server gave. @param {LibRow[]} rows @param {SortState} sort @returns {LibRow[]} */
export function sortRows(rows, sort) {
  if (sort.by === 'relevance') return rows;
  const list = [...rows];
  if (sort.by === 'title') {
    return list.sort((a, b) => sort.dir * BY_TITLE.compare(a.title, b.title));
  }
  return list.sort((a, b) => {
    if (a.year === b.year) return BY_TITLE_PLAIN.compare(a.title, b.title);
    if (a.year === null) return 1;
    if (b.year === null) return -1;
    return -sort.dir * (a.year - b.year);
  });
}

/** What clicking a sort button does: a new field starts at its natural direction, the same field flips it.
 *  Year's natural direction is newest first, the title's is A to Z. @param {SortState} sort @param {"year" | "title"} by @returns {SortState} */
export function nextSort(sort, by) {
  if (sort.by !== by) return { by, dir: 1 };
  return { by, dir: /** @type {1 | -1} */ (sort.dir === 1 ? -1 : 1) };
}

/** The slice of a fixed-height table to draw: the rows in view plus a buffer above and below.
 *  @param {{ scrollTop: number, viewport: number, rowHeight: number, total: number, buffer?: number }} o */
export function visibleRange({ scrollTop, viewport, rowHeight, total, buffer = 6 }) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
  const last = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + buffer);
  return { first, last: Math.max(first, last) };
}

/** The collections as the rows to show, depth first and name sorted, with only the children of open nodes.
 *  @param {CollectionNode[]} nodes @param {Set<string>} open @returns {TreeRow[]} */
export function treeRows(nodes, open) {
  /** @type {Map<string | null, CollectionNode[]>} */
  const byParent = new Map();
  const known = new Set(nodes.map((n) => n.key));
  for (const node of nodes) {
    const parent = node.parent && known.has(node.parent) ? node.parent : null; // an orphan is shown at the top
    const list = byParent.get(parent) ?? [];
    list.push(node);
    byParent.set(parent, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  /** @type {TreeRow[]} */ const out = [];
  const walk = (/** @type {string | null} */ parent, /** @type {number} */ depth) => {
    for (const node of byParent.get(parent) ?? []) {
      const hasChildren = (byParent.get(node.key) ?? []).length > 0;
      const isOpen = open.has(node.key);
      out.push({ node, depth, hasChildren, open: isOpen });
      if (hasChildren && isOpen) walk(node.key, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** Every ancestor of a collection, so a collection chosen from a link is visible in the tree.
 *  @param {CollectionNode[]} nodes @param {string} key @returns {string[]} */
export function ancestorsOf(nodes, key) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  /** @type {string[]} */ const out = [];
  for (let node = byKey.get(key); node?.parent; node = byKey.get(node.parent)) out.push(node.parent);
  return out;
}

/** The crumb's path: the root first, the chosen collection last. A key the tree does not know is shown as itself.
 *  @param {CollectionNode[]} nodes @param {string | null} key @returns {{ key: string, name: string }[]} */
export function crumbPath(nodes, key) {
  if (!key) return [];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const self = byKey.get(key);
  if (!self) return [{ key, name: key }];
  return [...ancestorsOf(nodes, key).reverse(), key].map((k) => ({ key: k, name: byKey.get(k)?.name ?? k }));
}

/** The status line of a finished search. @param {{ query: string, count: number, limit: number, collectionName?: string }} o */
export function searchLine({ query, count, limit, collectionName }) {
  const where = collectionName ? ` in ${collectionName}` : '';
  if (!count) return `No papers match “${query}”${where}.`;
  return `${count}${count >= limit ? '+' : ''} ${count === 1 ? 'paper' : 'papers'} for “${query}”${where}`;
}

/** The status line while a search runs. @param {string} [collectionName] */
export const searchingLine = (collectionName) => `Searching ${collectionName || 'your library'}…`;

/** The search box's hint. @param {string} [collectionName] */
export const searchPlaceholder = (collectionName) => (collectionName ? `Search in ${collectionName}` : 'Search papers');

/** What this browser kept for a collection: its rows and when they were saved. A copy from before the time was kept
 *  is a bare list. @param {string | null} raw @returns {{ at: string | null, rows: LibRow[] } | null} */
export function parseStored(raw) {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (Array.isArray(value)) return { at: null, rows: value };
    return Array.isArray(value?.rows) ? { at: value.at ?? null, rows: value.rows } : null;
  } catch { return null; }
}

/** How many collections keep a copy in this browser: the full library alone is a few MB of the ~5 MB a site gets. */
export const STORED_KEEP = 8;

/** Which stored copies stay after `key` is used: the most recently used first, at most `keep`. `present` is what this
 *  browser holds now, so copies saved before the list was kept are adopted or evicted, and names whose copy is gone drop
 *  out. @param {string[]} order most recent first @param {string} key @param {string[]} present @param {number} [keep]
 *  @returns {{ order: string[], evict: string[] }} */
export function keepStored(order, key, present, keep = STORED_KEEP) {
  const held = new Set(present);
  const known = [key, ...order.filter((k) => k !== key && held.has(k)), ...present.filter((k) => k !== key && !order.includes(k))];
  const kept = known.slice(0, keep);
  return { order: kept, evict: present.filter((k) => !kept.includes(k)) };
}

/** How long rows fetched from the server are shown without asking again: a paper added from Browse, the radar or Zotero
 *  itself shows on the next visit after this, without a reload (the desktop window can stay open for days). */
export const LIBRARY_MAX_AGE_MS = 60_000;

/** Are rows fetched at `at` (ms; 0 or null: never, or marked changed) still fresh at `now`?
 *  @param {number | null} at @param {number} now @param {number} [maxAge] */
export const isFresh = (at, now, maxAge = LIBRARY_MAX_AGE_MS) => Boolean(at) && now - /** @type {number} */ (at) < maxAge;

/** The window event that says the library changed in this app (an add to Zotero): the Library view refetches. */
export const LIBRARY_CHANGED = 'sbw-library-changed';

/** The banner over rows kept in this browser while the server does not answer. @param {string | null} at when they were stored @param {Date} [now] */
export function staleLine(at, now = new Date()) {
  const date = at ? new Date(at) : null;
  if (!date || Number.isNaN(date.getTime())) return "Showing a saved copy; the server isn't answering.";
  const sameDay = date.toDateString() === now.toDateString();
  const when = sameDay ? `at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : `on ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  return `Showing the copy saved ${when}; the server isn't answering.`;
}

/** A short label for a chat chip: "Chen 2022". @param {LibRow} row */
export function chipLabel(row) {
  const first = row.authors[0]?.split(' ').pop() ?? '';
  const who = row.authors.length > 2 ? `${first} et al.` : row.authors.slice(0, 2).map((a) => a.split(' ').pop()).join(' & ');
  return [who, row.year].filter(Boolean).join(' ') || row.title.slice(0, 40);
}

/** The papers a user ticked, as the chat's context (the same attachment the paper picker makes).
 *  @param {LibRow[]} rows @returns {import("../../ui/src/host").ContextItem[]} */
export function contextOf(rows) {
  return rows.map((row) => ({ attachment: /** @type {any} */ ({ kind: 'zoteroItem', citekey: row.citekey || row.key }), label: chipLabel(row), why: /** @type {const} */ ('selected') }));
}
