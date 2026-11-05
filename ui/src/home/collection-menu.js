// @ts-check
// ui-src/src/home/collection-menu.js. The collection half of an "Add to Zotero" split button, shared by Home's judging
// row, the reader and the PDF bar: a chevron that opens a small searchable menu of the library's collections (My
// Library first, the tree under it, the one last used marked). The pick is remembered in the `zoteroCollection` pref,
// so the next Add goes to the same place. No "New collection": no host offers a way to make one. The rows and the
// button's wording come from collection-data.js.
import { h } from '../dom.js';
import { lucide } from '../icons.js';
import { collectionRows, collectionLabel } from './collection-data.js';

export const COLLECTION_PREF = 'zoteroCollection';

/**
 * @param {Document} doc @param {any} host a UiHost (collections(), prefs)
 * @param {{ buttonClass: string, onPick?: (key: string) => void }} o `buttonClass` styles the chevron like the button it sits beside
 * @returns {{ el: HTMLElement, toggle: HTMLButtonElement, key: () => string, close: () => void }} `el` wraps the chevron and the menu
 */
export function collectionMenu(doc, host, o) {
  const root = h(doc, 'span', 'sb-coll');
  const toggle = /** @type {HTMLButtonElement} */ (h(doc, 'button', `${o.buttonClass} sb-coll-toggle`));
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.append(lucide(doc, 'chevronDown', 14));
  root.append(toggle);
  /** @type {import('./collection-data.js').CollectionLike[] | null} */ let collections = null;
  let key = String(host.prefs.get(COLLECTION_PREF) ?? '');
  /** @type {HTMLElement | null} */ let pop = null;
  const say = () => {
    const label = collectionLabel(collections, key);
    toggle.title = `Add to ${label} (change)`;
    toggle.setAttribute('aria-label', `Collection: ${label}. Pick another`);
  };
  say();
  const loading = Promise.resolve(host.collections?.()).then((/** @type {any} */ list) => { collections = Array.isArray(list) ? list : []; say(); }, () => { collections = []; say(); });

  const close = () => {
    if (!pop) return;
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    pop.remove();
    pop = null;
    toggle.setAttribute('aria-expanded', 'false');
  };
  const onOutside = (/** @type {Event} */ event) => { if (!root.contains(/** @type {Node} */ (event.target))) close(); };
  const onKey = (/** @type {KeyboardEvent} */ event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); toggle.focus(); } };

  const pick = (/** @type {string} */ next) => {
    key = next;
    host.prefs.set(COLLECTION_PREF, next);
    say();
    close();
    o.onPick?.(next);
  };

  const open = async () => {
    if (pop) { close(); return; }
    await loading;
    const menu = h(doc, 'div', 'sb-coll-pop');
    menu.setAttribute('role', 'menu');
    const search = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-coll-search'));
    search.type = 'search';
    search.placeholder = 'Find a collection';
    search.setAttribute('aria-label', 'Find a collection');
    const list = h(doc, 'div', 'sb-coll-list');
    const fill = () => {
      const rows = collectionRows(collections, { query: search.value, lastUsed: String(host.prefs.get(COLLECTION_PREF) ?? '') });
      list.replaceChildren(...rows.map((row) => {
        const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sb-coll-row${row.key === key ? ' is-on' : ''}`));
        b.setAttribute('type', 'button');
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(row.key === key));
        b.style.setProperty('--depth', String(row.depth));
        if (row.key) b.append(lucide(doc, 'folder', 13));
        b.append(h(doc, 'span', 'sb-coll-name', row.name));
        if (row.note) b.append(h(doc, 'small', 'sb-coll-note', row.note));
        b.addEventListener('click', () => pick(row.key));
        return b;
      }));
      if (!rows.length) list.append(h(doc, 'p', 'sb-coll-none', 'No collection by that name'));
    };
    search.addEventListener('input', fill);
    search.addEventListener('keydown', (event) => {
      // Enter takes the first match; the arrows walk the rows
      if (event.key === 'Enter') { event.preventDefault(); /** @type {HTMLButtonElement | null} */ (list.querySelector('.sb-coll-row'))?.click(); }
      if (event.key === 'ArrowDown') { event.preventDefault(); /** @type {HTMLElement | null} */ (list.querySelector('.sb-coll-row'))?.focus(); }
    });
    list.addEventListener('keydown', (event) => {
      const rows = /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll('.sb-coll-row')));
      const at = rows.indexOf(/** @type {HTMLElement} */ (doc.activeElement));
      if (event.key === 'ArrowDown' && at >= 0) { event.preventDefault(); rows[Math.min(rows.length - 1, at + 1)]?.focus(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); if (at > 0) rows[at - 1].focus(); else search.focus(); }
    });
    fill();
    menu.append(search, list);
    root.append(menu);
    pop = menu;
    toggle.setAttribute('aria-expanded', 'true');
    doc.addEventListener('pointerdown', onOutside, true);
    doc.addEventListener('keydown', onKey, true);
    search.focus();
  };
  toggle.addEventListener('click', (event) => { event.stopPropagation(); void open(); });
  return { el: root, toggle, key: () => key, close };
}
