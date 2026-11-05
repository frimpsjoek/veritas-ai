// @ts-check
// ui-src/src/home/collection-data.js. The pure part of the collection menu behind Add to Zotero (collection-menu.js):
// which rows it lists for a query, and what the button says for the chosen collection. Tested in node.

/** @typedef {{ key: string, name: string, parent?: string | null }} CollectionLike */
/** @typedef {{ key: string, name: string, depth: number, note: '' | 'default' | 'last used' }} CollectionRow */

export const MY_LIBRARY = 'My Library';

/** @param {CollectionLike[]} list @returns {Map<string | null, CollectionLike[]>} parent key (root: null) -> children by name; a lost parent counts as root */
function byParent(list) {
  const keys = new Set(list.map((c) => c.key));
  /** @type {Map<string | null, CollectionLike[]>} */ const under = new Map();
  for (const c of list) {
    const parent = c.parent && keys.has(c.parent) ? c.parent : null;
    under.set(parent, [...(under.get(parent) ?? []), c]);
  }
  for (const children of under.values()) children.sort((a, b) => a.name.localeCompare(b.name));
  return under;
}

/** "Physics › Condensed matter": a collection named by its ancestors. @param {CollectionLike[]} list @param {string} key */
function pathOf(list, key) {
  const byKey = new Map(list.map((c) => [c.key, c]));
  /** @type {string[]} */ const names = [];
  for (let at = byKey.get(key); at; at = at.parent ? byKey.get(at.parent) : undefined) { names.unshift(at.name); if (names.length > 20) break; }
  return names.join(' › ');
}

/**
 * The menu's rows. Without a query: My Library, then the tree, each row at its depth. With one: every collection whose
 * name holds it, flat and named by its path, so a match deep in the tree still says where it is.
 * @param {CollectionLike[] | null | undefined} collections @param {{ query: string, lastUsed: string }} o @returns {CollectionRow[]}
 */
export function collectionRows(collections, { query, lastUsed }) {
  const list = Array.isArray(collections) ? collections : [];
  const note = (/** @type {string} */ key) => (key === '' ? 'default' : key === lastUsed ? 'last used' : '');
  const q = query.trim().toLowerCase();
  if (q) {
    /** @type {CollectionRow[]} */ const out = [];
    if (MY_LIBRARY.toLowerCase().includes(q)) out.push({ key: '', name: MY_LIBRARY, depth: 0, note: note('') });
    const walk = (/** @type {string | null} */ parent, /** @type {Map<string | null, CollectionLike[]>} */ under) => {
      for (const c of under.get(parent) ?? []) {
        if (c.name.toLowerCase().includes(q)) out.push({ key: c.key, name: pathOf(list, c.key), depth: 0, note: note(c.key) });
        walk(c.key, under);
      }
    };
    walk(null, byParent(list));
    return out;
  }
  /** @type {CollectionRow[]} */ const out = [{ key: '', name: MY_LIBRARY, depth: 0, note: note('') }];
  const under = byParent(list);
  const walk = (/** @type {string | null} */ parent, /** @type {number} */ depth) => {
    for (const c of under.get(parent) ?? []) { out.push({ key: c.key, name: c.name, depth, note: note(c.key) }); walk(c.key, depth + 1); }
  };
  walk(null, 0);
  return out;
}

/** What the split button's tooltip names: the chosen collection by its path, My Library for none or one that is gone.
 *  @param {CollectionLike[] | null | undefined} collections @param {string} key */
export function collectionLabel(collections, key) {
  const list = Array.isArray(collections) ? collections : [];
  return key && list.some((c) => c.key === key) ? pathOf(list, key) : MY_LIBRARY;
}

/** The key to add to: the chosen collection while it still exists; null means My Library, as the button then says.
 *  @param {CollectionLike[] | null | undefined} collections @param {string} key @returns {string | null} */
export function collectionTarget(collections, key) {
  return key && Array.isArray(collections) && collections.some((c) => c.key === key) ? key : null;
}
