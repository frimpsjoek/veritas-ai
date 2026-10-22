// @ts-check
// ui-src/src/web/library-data.js. The pure half of the Library view: item rows from /zotero/items and /search, the
// sort, the visible window of a long table, the collection tree, and the chat context a ticked row becomes.

/** @typedef {{ key: string, title: string, authors: string[], year: number | null, venue: string, citekey: string }} LibRow */
/** @typedef {{ key: string, name: string, parent: string | null, count: number }} CollectionNode */
/** @typedef {{ node: CollectionNode, depth: number, hasChildren: boolean, open: boolean }} TreeRow */
/** @typedef {{ by: "relevance" | "year" | "title", dir: 1 | -1 }} SortState */

/** One /zotero/items entry, reduced to what the table shows (the abstract is the bulk of the payload and is dropped).
 *  @param {any} item @returns {LibRow} */
export function rowOfItem(item) {
  const year = Number.parseInt(item.year, 10);
  return {
    key: String(item.key), title: String(item.title || 'Untitled'), authors: Array.isArray(item.authors) ? item.authors : [],
    year: Number.isFinite(year) ? year : null, venue: String(item.venue ?? ''), citekey: String(item.citekey ?? ''),
  };
}

/** A /search hit for a paper (path zotero/KEY) as a row; other hits are not papers. @param {any} hit @returns {LibRow | null} */
export function rowOfHit(hit) {
  if (!hit?.zotero || !String(hit.path).startsWith('zotero/')) return null;
  return rowOfItem({ ...hit.zotero, key: String(hit.path).slice('zotero/'.length), title: hit.title });
}

/** Newest first for the year, A to Z for the title (`dir` flips it); papers with no year sort last either way.
 *  `relevance` keeps the order the server gave. @param {LibRow[]} rows @param {SortState} sort @returns {LibRow[]} */
export function sortRows(rows, sort) {
  if (sort.by === 'relevance') return rows;
  const list = [...rows];
  if (sort.by === 'title') {
    return list.sort((a, b) => sort.dir * a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }));
  }
  return list.sort((a, b) => {
    if (a.year === b.year) return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
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
