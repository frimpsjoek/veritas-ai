// @ts-check
// ui-src/src/web/library-view.js. The Library page (spec 013 W2, ledger 7): a collection tree with counts beside a
// flat table of the papers in the chosen collection. The table draws only the rows in view, because the whole library
// is ~3,500 papers. Ticking rows raises one filled action, "Ask about N", which opens Chat with those papers as context.
// The view is built once and kept by the shell, so coming Back from a paper finds the same collection, scroll and ticks.
import { h } from '../../ui/src/dom.js';
import { icon } from '../../ui/src/icons.js';
import { formatRoute } from '../../ui/src/sources/route.js';
import { titleNodes } from '../../ui/src/chat/markdown.js';
import { apiOf, authorLine } from '../../ui/src/sources/view-kit.js';
import { ancestorsOf, contextOf, nextSort, rowOfHit, rowOfItem, sortRows, treeRows, visibleRange } from './library-data.js';

/** @typedef {import("./library-data.js").LibRow} LibRow */
/** @typedef {import("./library-data.js").CollectionNode} CollectionNode */
/** @typedef {import("../../ui/src/sources/view-kit.js").ViewContext} ViewContext */

const ROW_HEIGHT = 56;
const SEARCH_MS = 250;
const SEARCH_LIMIT = 100;
const STORE_PREFIX = 'sbw-library-v1:';

/** The rows last shown for a collection, kept in this browser so a reload paints at once while the server answers
 *  (the full library is a 4 MB reply). Storage can be blocked or full; then there is simply no cache.
 *  @param {Window} win @param {string} key @returns {LibRow[] | null} */
function readStored(win, key) {
  try { return JSON.parse(win.localStorage.getItem(STORE_PREFIX + key) ?? 'null'); } catch { return null; }
}

/** @param {Window} win @param {string} key @param {LibRow[]} rows */
function writeStored(win, key, rows) {
  try { win.localStorage.setItem(STORE_PREFIX + key, JSON.stringify(rows)); } catch { /* full or blocked: the next load just waits for the server */ }
}

/** @param {LibRow[]} a @param {LibRow[]} b */
const sameRows = (a, b) => a.length === b.length && a.every((row, i) => row.key === b[i].key && row.title === b[i].title);

/** @param {ViewContext} ctx */
export function createLibraryView(ctx) {
  const { host, doc, win, go } = ctx;
  const api = apiOf(host);

  const root = h(doc, 'div', 'sbw-lib');
  const treeBox = h(doc, 'aside', 'sbw-lib-tree');
  const main = h(doc, 'section', 'sbw-lib-main');
  root.append(treeBox, main);

  // ---- state
  /** @type {CollectionNode[]} */ let nodes = [];
  let nodesLoaded = false;
  /** @type {Set<string>} */ const open = new Set();
  /** @type {string | null} */ let collection = null;
  /** @type {Map<string, LibRow[]>} */ const cache = new Map();
  /** @type {LibRow[]} */ let base = [];
  /** @type {LibRow[] | null} */ let found = null;
  let query = '';
  /** @type {import("./library-data.js").SortState} */ let sort = { by: 'year', dir: 1 };
  /** @type {Map<string, LibRow>} */ const ticked = new Map();
  let token = 0;
  let searchToken = 0;
  /** @type {any} */ let searchTimer = null;
  let loadError = '';
  let loading = true;
  let drawn = false;

  // ---- main column
  const head = h(doc, 'div', 'sbw-lib-head');
  const title = h(doc, 'h1', 'sbw-h1 sbw-lib-title', 'Library');
  const crumb = h(doc, 'span', 'sbw-lib-crumb');
  title.append(crumb);
  head.append(title);

  const bar = h(doc, 'div', 'sbw-lib-bar');
  const collectionsToggle = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-lib-collections'));
  collectionsToggle.setAttribute('type', 'button');
  collectionsToggle.setAttribute('aria-expanded', 'false');
  collectionsToggle.append(icon(doc, 'folder', 'sb-p-icon sbw-quiet-icon'), h(doc, 'span', '', 'Collections'));
  const search = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-lib-search'));
  search.type = 'search';
  search.placeholder = 'Search papers';
  search.setAttribute('aria-label', 'Search papers');
  const sortBox = h(doc, 'div', 'sbw-lib-sort');
  sortBox.setAttribute('role', 'group');
  sortBox.setAttribute('aria-label', 'Sort');
  sortBox.append(h(doc, 'span', 'sbw-lib-sort-label', 'Sort'));
  /** @type {Map<"year" | "title", HTMLButtonElement>} */
  const sortButtons = new Map();
  for (const [by, label] of /** @type {["year" | "title", string][]} */ ([['year', 'Year'], ['title', 'Title']])) {
    const button = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-lib-sortbtn', label));
    button.setAttribute('type', 'button');
    button.addEventListener('click', () => { sort = nextSort(effectiveSort(), by); sortTouched = true; scroller.scrollTop = 0; refresh(); });
    sortButtons.set(by, button);
    sortBox.append(button);
  }
  const ask = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary sbw-lib-ask'));
  ask.setAttribute('type', 'button');
  ask.hidden = true;
  const clear = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-lib-clear', 'Clear'));
  clear.setAttribute('type', 'button');
  clear.hidden = true;
  bar.append(collectionsToggle, search, sortBox, h(doc, 'span', 'sbw-spacer-x'), clear, ask);

  const status = h(doc, 'p', 'sbw-hint sbw-lib-status');
  status.setAttribute('role', 'status');
  const columns = h(doc, 'div', 'sbw-lib-cols');
  columns.setAttribute('aria-hidden', 'true');
  for (const label of ['', 'Title', 'Authors', 'Year', 'Venue']) columns.append(h(doc, 'span', '', label));
  const scroller = h(doc, 'div', 'sbw-lib-scroll');
  scroller.setAttribute('role', 'table');
  scroller.setAttribute('aria-label', 'Papers');
  const space = h(doc, 'div', 'sbw-lib-space');
  const rowsBox = h(doc, 'div', 'sbw-lib-rows');
  space.append(rowsBox);
  scroller.append(space);
  main.append(head, bar, status, columns, scroller);

  // ---- the rows on show
  // Search results start in the server's relevance order until the reader picks a sort.
  let sortTouched = false;
  /** @returns {import("./library-data.js").SortState} */
  const effectiveSort = () => (found && !sortTouched ? { by: 'relevance', dir: 1 } : sort);
  const shown = () => sortRows(found ?? base, effectiveSort());
  /** @type {LibRow[]} */ let list = [];
  let rangeKey = '';

  /** @param {LibRow} row @param {number} index */
  function makeRow(row, index) {
    const el = h(doc, 'div', 'sbw-lib-row');
    el.setAttribute('role', 'row');
    el.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
    el.classList.toggle('is-ticked', ticked.has(row.key));
    const tick = h(doc, 'label', 'sbw-chk');
    const box = /** @type {HTMLInputElement} */ (h(doc, 'input'));
    box.type = 'checkbox';
    box.checked = ticked.has(row.key);
    box.setAttribute('aria-label', `Select ${row.title}`);
    box.addEventListener('change', () => {
      if (box.checked) ticked.set(row.key, row); else ticked.delete(row.key);
      el.classList.toggle('is-ticked', box.checked);
      paintAsk();
    });
    tick.append(box);
    tick.addEventListener('click', (event) => event.stopPropagation());

    const text = h(doc, 'div', 'sbw-lib-text');
    const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-lib-link'));
    link.append(titleNodes(doc, row.title));
    link.href = formatRoute({ view: 'paper', key: row.key });
    link.title = row.title;
    const meta = [authorLine(row.authors, 2), row.venue].filter(Boolean).join(' · ');
    text.append(link, h(doc, 'span', 'sbw-lib-sub', meta));
    el.append(tick, text,
      h(doc, 'span', 'sbw-lib-authors', authorLine(row.authors, 3)),
      h(doc, 'span', 'sbw-lib-year', row.year ? String(row.year) : ''),
      h(doc, 'span', 'sbw-lib-venue', row.venue));
    el.addEventListener('click', (event) => {
      if (event.defaultPrevented || /** @type {HTMLElement} */ (event.target).closest('a')) return;
      go({ view: 'paper', key: row.key });
    });
    return el;
  }

  function drawRows(force = false) {
    const { first, last } = visibleRange({ scrollTop: scroller.scrollTop, viewport: scroller.clientHeight || 600, rowHeight: ROW_HEIGHT, total: list.length });
    const key = `${first}:${last}`;
    if (!force && key === rangeKey) return;
    rangeKey = key;
    const fragment = doc.createDocumentFragment();
    for (let i = first; i < last; i++) fragment.append(makeRow(list[i], i));
    rowsBox.replaceChildren(fragment);
    if (!drawn && last > first) {
      drawn = true;
      // Read by dev/web-library-checks.mjs: time from opening #/library to the first rows on screen.
      win.performance.mark('sbw-library-first-rows');
    }
  }

  function paintStatus() {
    status.replaceChildren();
    status.classList.toggle('is-error', Boolean(loadError));
    if (loadError) {
      status.append(`Couldn't load the library: ${loadError} `);
      const retry = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-link sbw-linkbtn', 'Try again'));
      retry.setAttribute('type', 'button');
      retry.addEventListener('click', () => { void load(); });
      status.append(retry);
    } else if (loading) {
      status.textContent = 'Loading…';
    } else if (found) {
      status.append(found.length ? `${found.length}${found.length >= SEARCH_LIMIT ? '+' : ''} ${found.length === 1 ? 'paper' : 'papers'} for “${query}”` : `No papers match “${query}”.`);
    } else if (!base.length) {
      status.textContent = collection ? 'No papers in this collection yet.' : 'Your library is empty.';
    } else {
      status.textContent = `${base.length.toLocaleString()} ${base.length === 1 ? 'paper' : 'papers'}`;
    }
  }

  function paintSortButtons() {
    const effective = effectiveSort().by;
    for (const [by, button] of sortButtons) {
      const on = effective === by;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
      button.dataset.dir = on ? String(sort.dir) : '';
      button.setAttribute('aria-label', on ? `${by === 'year' ? 'Year' : 'Title'}, ${by === 'year' ? (sort.dir === 1 ? 'newest first' : 'oldest first') : (sort.dir === 1 ? 'A to Z' : 'Z to A')}` : `Sort by ${by}`);
    }
  }

  function paintAsk() {
    const n = ticked.size;
    ask.hidden = n === 0;
    clear.hidden = n === 0;
    ask.textContent = `Ask about ${n}`;
    root.classList.toggle('has-ticks', n > 0);
  }

  function refresh() {
    list = shown();
    space.style.height = `${list.length * ROW_HEIGHT}px`;
    paintStatus();
    paintSortButtons();
    paintAsk();
    scroller.hidden = columns.hidden = Boolean(loadError) || (!loading && list.length === 0);
    drawRows(true);
  }

  // ---- loading
  async function load() {
    const mine = ++token;
    loadError = '';
    const cacheKey = collection ?? '';
    const cached = cache.get(cacheKey);
    if (cached) { base = cached; loading = false; refresh(); return; }
    const stored = readStored(win, cacheKey);
    loading = !stored;
    base = stored ?? [];
    refresh();
    /** @type {LibRow[] | null} */ let rows = null;
    let failure = '';
    try {
      const reply = await api('/zotero/items', collection ? { collections: collection, fields: 'slim' } : { fields: 'slim' });
      if (mine !== token) return;
      /** @type {LibRow[]} */
      const loaded = (reply?.items ?? []).map(rowOfItem);
      rows = loaded;
      cache.set(cacheKey, loaded);
      writeStored(win, cacheKey, loaded);
    } catch (error) {
      if (mine !== token) return;
      failure = String(/** @type {any} */ (error)?.message ?? error);
    }
    loading = false;
    if (rows) { if (!stored || !sameRows(stored, rows)) base = rows; } else if (!stored) loadError = failure; // a stored copy stays when the server does not answer
    refresh();
    paintTree();
  }

  async function runSearch() {
    const text = search.value.trim();
    const mine = ++searchToken;
    query = text;
    if (!text) { found = null; sortTouched = false; scroller.scrollTop = 0; refresh(); return; }
    try {
      const hits = await api('/search', { q: text, source: 'zotero', limit: SEARCH_LIMIT, ...(collection ? { collections: collection } : {}) });
      if (mine !== searchToken) return;
      /** @type {Map<string, LibRow>} */ const byKey = new Map();
      for (const hit of hits ?? []) { const row = rowOfHit(hit); if (row && !byKey.has(row.key)) byKey.set(row.key, row); }
      found = [...byKey.values()];
      loadError = '';
    } catch (error) {
      if (mine !== searchToken) return;
      found = [];
      host.notice(`Search failed: ${/** @type {any} */ (error)?.message ?? error}`);
    }
    scroller.scrollTop = 0;
    refresh();
  }

  async function loadTree() {
    try {
      nodes = (await api('/zotero/collections')) ?? [];
    } catch (error) {
      host.logError(error);
      nodes = [];
    }
    nodesLoaded = true;
    if (collection) for (const ancestor of ancestorsOf(nodes, collection)) open.add(ancestor);
    paintTree();
    paintCrumb();
  }

  // ---- the tree
  function paintTree() {
    treeBox.replaceChildren();
    treeBox.append(h(doc, 'div', 'sbw-tree-head', 'Collections'));
    const all = /** @type {HTMLAnchorElement} */ (h(doc, 'a', `sbw-tree-row${collection === null ? ' is-selected' : ''}`));
    all.href = formatRoute({ view: 'library' });
    all.append(h(doc, 'span', 'sbw-tree-twist'), h(doc, 'span', 'sbw-tree-name', 'All papers'), h(doc, 'span', 'sbw-tree-count', cache.get('') ? cache.get('')?.length.toLocaleString() ?? '' : ''));
    if (collection === null) all.setAttribute('aria-current', 'page');
    treeBox.append(all);
    const list = h(doc, 'div', 'sbw-tree-list');
    for (const { node, depth, hasChildren, open: isOpen } of treeRows(nodes, open)) {
      const row = /** @type {HTMLAnchorElement} */ (h(doc, 'a', `sbw-tree-row${node.key === collection ? ' is-selected' : ''}`));
      row.href = formatRoute({ view: 'library', collection: node.key });
      row.style.paddingInlineStart = `${12 + depth * 14}px`;
      if (node.key === collection) row.setAttribute('aria-current', 'page');
      const twist = /** @type {HTMLElement} */ (h(doc, 'span', 'sbw-tree-twist'));
      if (hasChildren) {
        twist.classList.add('has-children');
        twist.setAttribute('role', 'button');
        twist.setAttribute('aria-label', `${isOpen ? 'Collapse' : 'Expand'} ${node.name}`);
        twist.append(icon(doc, 'chevron', `sb-p-icon${isOpen ? ' is-open' : ''}`));
        twist.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (open.has(node.key)) open.delete(node.key); else open.add(node.key);
          paintTree();
        });
      }
      row.append(twist, h(doc, 'span', 'sbw-tree-name', node.name), h(doc, 'span', 'sbw-tree-count', String(node.count)));
      list.append(row);
    }
    treeBox.append(list);
    if (nodesLoaded && !nodes.length) treeBox.append(h(doc, 'p', 'sbw-hint sbw-tree-empty', 'No collections.'));
  }

  function paintCrumb() {
    const node = nodes.find((n) => n.key === collection);
    crumb.textContent = collection ? ` / ${node?.name ?? collection}` : '';
  }

  // ---- events
  scroller.addEventListener('scroll', () => drawRows(), { passive: true });
  new (/** @type {any} */ (win)).ResizeObserver(() => drawRows(true)).observe(scroller);
  search.addEventListener('input', () => { win.clearTimeout(searchTimer); searchTimer = win.setTimeout(() => { void runSearch(); }, SEARCH_MS); });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { win.clearTimeout(searchTimer); void runSearch(); }
    if (event.key === 'Escape' && search.value) { search.value = ''; void runSearch(); }
  });
  // Wide: the button hides or shows the collections column, like the chat history, and the choice is kept.
  // Narrow: it opens the collections over the list, as before.
  const wide = () => Boolean(win.matchMedia?.('(min-width: 700px)').matches);
  const applyCollapsed = (/** @type {boolean} */ collapsed) => {
    root.classList.toggle('hide-tree', collapsed);
    if (wide()) collectionsToggle.setAttribute('aria-expanded', String(!collapsed));
    collectionsToggle.title = collapsed ? 'Show collections' : 'Hide collections';
  };
  applyCollapsed(Boolean(host.prefs?.get?.('libraryTreeCollapsed')));
  collectionsToggle.addEventListener('click', () => {
    if (wide()) {
      const collapsed = !root.classList.contains('hide-tree');
      host.prefs?.set?.('libraryTreeCollapsed', collapsed);
      applyCollapsed(collapsed);
      return;
    }
    const on = root.classList.toggle('show-tree');
    collectionsToggle.setAttribute('aria-expanded', String(on));
  });
  treeBox.addEventListener('click', (event) => {
    if (/** @type {HTMLElement} */ (event.target).closest('a')) {
      root.classList.remove('show-tree');
      collectionsToggle.setAttribute('aria-expanded', 'false');
    }
  });
  clear.addEventListener('click', () => { ticked.clear(); refresh(); });
  ask.addEventListener('click', () => {
    host.setContext(contextOf([...ticked.values()]));
    go({ view: 'chat' });
  });

  return {
    root,
    /** Shows the library for a route; a repeat of the same collection keeps its rows, scroll and ticks.
     *  @param {{ collection?: string }} route */
    show(route) {
      const next = route.collection ?? null;
      if (!nodesLoaded && !nodes.length) void loadTree();
      if (next !== collection || !base.length && !loadError) {
        const changed = next !== collection;
        collection = next;
        if (changed) {
          search.value = '';
          found = null;
          query = '';
          sortTouched = false;
          scroller.scrollTop = 0;
          for (const ancestor of ancestorsOf(nodes, next ?? '')) open.add(ancestor);
        }
        void load();
      } else {
        refresh();
      }
      paintTree();
      paintCrumb();
      win.requestAnimationFrame(() => drawRows(true));
    },
  };
}
