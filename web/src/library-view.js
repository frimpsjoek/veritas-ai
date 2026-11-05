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
import { ancestorsOf, contextOf, crumbPath, nextSort, rowOfHit, rowOfItem, parseStored, searchingLine, searchLine, searchPlaceholder, sortRows, staleLine, treeRows, visibleRange } from './library-data.js';

/** @typedef {import("./library-data.js").LibRow} LibRow */
/** @typedef {import("./library-data.js").CollectionNode} CollectionNode */
/** @typedef {import("../../ui/src/sources/view-kit.js").ViewContext} ViewContext */

const ROW_HEIGHT = 56;
const SKELETON_ROWS = 8;
const SEARCH_MS = 250;
const SEARCH_LIMIT = 100;
const STORE_PREFIX = 'sbw-library-v1:';
const TREE_KEY = 'sbw-library-tree-v1';

/** The rows last shown for a collection and when they were saved, kept in this browser so a reload paints at once while
 *  the server answers (the full library is a 4 MB reply). Storage can be blocked or full; then there is simply no cache.
 *  @param {Window} win @param {string} key @returns {{ at: string | null, rows: LibRow[] } | null} */
function readStored(win, key) {
  try { return parseStored(win.localStorage.getItem(STORE_PREFIX + key)); } catch { return null; }
}

/** @param {Window} win @param {string} key @param {LibRow[]} rows */
function writeStored(win, key, rows) {
  try { win.localStorage.setItem(STORE_PREFIX + key, JSON.stringify({ at: new Date().toISOString(), rows })); } catch { /* full or blocked: the next load just waits for the server */ }
}

/** The collections last listed, for when the server doesn't answer. @param {Window} win @returns {CollectionNode[]} */
function readStoredTree(win) {
  try { return JSON.parse(win.localStorage.getItem(TREE_KEY) ?? '[]'); } catch { return []; }
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
  let searching = false;
  let searchFailed = false;
  let pendingSearch = ''; // what "Search all papers" carries over to the whole library
  /** @type {any} */ let searchTimer = null;
  let loadError = '';
  let stale = false; // the rows on show are the stored copy: the server didn't answer
  /** @type {string | null} */ let staleAt = null;
  let treeFailed = false;
  let loading = true;
  let drawn = false;

  // ---- main column
  const head = h(doc, 'div', 'sbw-lib-head');
  const collectionsToggle = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-lib-collections'));
  collectionsToggle.setAttribute('type', 'button');
  collectionsToggle.setAttribute('aria-label', 'Collections');
  collectionsToggle.setAttribute('aria-expanded', 'false');
  collectionsToggle.append(icon(doc, 'panelLeft'));
  const title = h(doc, 'h1', 'sbw-h1 sbw-lib-title', 'Library');
  const crumb = h(doc, 'span', 'sbw-lib-crumb');
  title.append(crumb);
  head.append(collectionsToggle, title);

  const bar = h(doc, 'div', 'sbw-lib-bar');
  // below 700 px the tree is a sheet: this chip names the chosen collection and opens it
  const chip = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-lib-chip'));
  chip.setAttribute('type', 'button');
  chip.setAttribute('aria-expanded', 'false');
  const chipName = h(doc, 'span', 'sbw-lib-chip-name', 'All papers');
  chip.append(icon(doc, 'folder'), chipName, icon(doc, 'chevron'));
  const search = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-lib-search'));
  search.type = 'search';
  search.placeholder = 'Search papers';
  search.setAttribute('aria-label', 'Search papers');
  const sortBox = h(doc, 'div', 'sbw-lib-sort');
  sortBox.setAttribute('role', 'group');
  sortBox.setAttribute('aria-label', 'Sort');
  sortBox.append(h(doc, 'span', 'sbw-lib-sort-label', 'Sort'));
  // the server's order, the one a search starts in; it shows only during a search
  const relevance = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-lib-sortbtn', 'Relevance'));
  relevance.setAttribute('type', 'button');
  relevance.hidden = true;
  relevance.addEventListener('click', () => { sortTouched = false; scroller.scrollTop = 0; refresh(); });
  sortBox.append(relevance);
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
  bar.append(chip, search, sortBox, h(doc, 'span', 'sbw-spacer-x'), clear, ask);

  const staleBox = h(doc, 'div', 'sbw-lib-stale');
  staleBox.setAttribute('role', 'status');
  staleBox.hidden = true;
  const status = h(doc, 'p', 'sbw-hint sbw-lib-status');
  status.setAttribute('role', 'status');
  const columns = h(doc, 'div', 'sbw-lib-cols');
  columns.setAttribute('role', 'row');
  columns.setAttribute('aria-rowindex', '1');
  for (const label of ['', 'Title', 'Authors', 'Year', 'Venue']) {
    const cell = h(doc, 'span', '', label);
    cell.setAttribute('role', 'columnheader');
    if (!label) cell.setAttribute('aria-label', 'Select');
    columns.append(cell);
  }
  const scroller = h(doc, 'div', 'sbw-lib-scroll');
  scroller.setAttribute('role', 'rowgroup');
  // the table is the header and the scrolling rows together; only the rows in view exist, so the count is stated
  const table = h(doc, 'div', 'sbw-lib-table');
  table.setAttribute('role', 'table');
  table.setAttribute('aria-label', 'Papers');
  const space = h(doc, 'div', 'sbw-lib-space');
  const rowsBox = h(doc, 'div', 'sbw-lib-rows');
  space.append(rowsBox);
  scroller.append(space);
  table.append(columns, scroller);
  main.append(head, bar, staleBox, status, table);

  // ---- the rows on show
  // Search results start in the server's relevance order until the reader picks a sort.
  let sortTouched = false;
  /** @returns {import("./library-data.js").SortState} */
  const effectiveSort = () => (found && !sortTouched ? { by: 'relevance', dir: 1 } : sort);
  const shown = () => sortRows(found ?? base, effectiveSort());
  // A search still on its way shows the old rows in their old order; its button is lit from the start.
  const litSort = () => (query && !sortTouched ? 'relevance' : sort.by);
  const collectionName = () => crumbPath(nodes, collection).at(-1)?.name ?? '';
  /** @type {LibRow[]} */ let list = [];
  let rangeKey = '';

  /** @param {LibRow} row @param {number} index */
  function makeRow(row, index) {
    const el = h(doc, 'div', 'sbw-lib-row');
    el.setAttribute('role', 'row');
    el.setAttribute('aria-rowindex', String(index + 2));
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
    for (const cell of Array.from(el.children)) cell.setAttribute('role', 'cell');
    el.addEventListener('click', (event) => {
      if (event.defaultPrevented || /** @type {HTMLElement} */ (event.target).closest('a')) return;
      go({ view: 'paper', key: row.key });
    });
    return el;
  }

  /** Grey rows of the real height while the first answer is on its way, so the list doesn't jump when it arrives. */
  function drawSkeleton() {
    const fragment = doc.createDocumentFragment();
    for (let i = 0; i < SKELETON_ROWS; i++) {
      const el = h(doc, 'div', 'sbw-lib-skel');
      el.style.transform = `translateY(${i * ROW_HEIGHT}px)`;
      el.append(h(doc, 'span'), h(doc, 'span', 'sbw-lib-skel-text'), h(doc, 'span', 'sbw-lib-skel-wide'), h(doc, 'span', 'sbw-lib-skel-year'), h(doc, 'span', 'sbw-lib-skel-wide'));
      fragment.append(el);
    }
    rowsBox.setAttribute('aria-hidden', 'true');
    rowsBox.replaceChildren(fragment);
    rangeKey = '';
  }

  function drawRows(force = false) {
    if (loading && !list.length) { drawSkeleton(); return; }
    rowsBox.removeAttribute('aria-hidden');
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

  /** @param {string} label @param {() => void} action */
  function linkButton(label, action) {
    const button = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-link sbw-linkbtn', label));
    button.setAttribute('type', 'button');
    button.addEventListener('click', action);
    return button;
  }

  function paintStatus() {
    status.replaceChildren();
    status.classList.toggle('is-error', Boolean(loadError) || searchFailed);
    if (loadError) {
      status.append(`Couldn't load the library: ${loadError} `, linkButton('Try again', () => { void load(); }));
    } else if (searchFailed) {
      status.append("Search isn't working · ", linkButton('Try again', () => { void runSearch(); }));
    } else if (searching) {
      status.append(icon(doc, 'loader', 'sb-p-icon sbw-lib-spin'), searchingLine(collectionName()));
    } else if (loading) {
      status.textContent = 'Loading…';
    } else if (found) {
      status.append(searchLine({ query, count: found.length, limit: SEARCH_LIMIT, collectionName: collectionName() }));
      if (!found.length && collection) {
        status.append(' ', linkButton('Search all papers', () => { pendingSearch = query; go({ view: 'library' }); }));
      }
    } else if (!base.length) {
      status.textContent = collection ? 'No papers in this collection yet.' : 'Your library is empty.';
    } else {
      status.textContent = `${base.length.toLocaleString()} ${base.length === 1 ? 'paper' : 'papers'}`;
    }
  }

  function paintStale() {
    staleBox.hidden = !stale;
    if (!stale) return;
    const line = h(doc, 'span', 'sbw-lib-stale-line', staleLine(staleAt));
    const retry = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button sbw-lib-stale-retry', 'Try again'));
    retry.setAttribute('type', 'button');
    retry.addEventListener('click', () => { void load(); if (treeFailed) void loadTree(); });
    staleBox.replaceChildren(icon(doc, 'alert', 'sb-p-icon sbw-lib-stale-icon'), line, retry);
  }

  function paintSortButtons() {
    const effective = litSort();
    relevance.hidden = !query;
    relevance.classList.toggle('is-on', effective === 'relevance');
    relevance.setAttribute('aria-pressed', String(effective === 'relevance'));
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
    space.style.height = `${(loading && !list.length ? SKELETON_ROWS : list.length) * ROW_HEIGHT}px`;
    table.setAttribute('aria-rowcount', String(list.length + 1));
    paintStatus();
    paintStale();
    paintSortButtons();
    paintAsk();
    scroller.hidden = columns.hidden = Boolean(loadError) || (!loading && list.length === 0);
    drawRows(true);
  }

  // ---- loading
  async function load() {
    const mine = ++token;
    loadError = '';
    stale = false;
    const cacheKey = collection ?? '';
    const cached = cache.get(cacheKey);
    if (cached) { base = cached; loading = false; refresh(); return; }
    const stored = readStored(win, cacheKey);
    loading = !stored;
    base = stored?.rows ?? [];
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
    if (rows) { if (!stored || !sameRows(stored.rows, rows)) base = rows; }
    else if (stored) { stale = true; staleAt = stored.at; } // a stored copy stays when the server does not answer, and says so
    else loadError = failure;
    refresh();
    paintTree();
  }

  async function runSearch() {
    const text = search.value.trim();
    const mine = ++searchToken;
    query = text;
    searchFailed = false;
    searching = Boolean(text);
    if (!text) { found = null; sortTouched = false; scroller.scrollTop = 0; refresh(); return; }
    paintStatus();
    paintSortButtons();
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
      searchFailed = true;
      host.logError(error);
    }
    searching = false;
    scroller.scrollTop = 0;
    refresh();
  }

  async function loadTree() {
    try {
      nodes = (await api('/zotero/collections')) ?? [];
      treeFailed = false;
      try { win.localStorage.setItem(TREE_KEY, JSON.stringify(nodes)); } catch { /* full or blocked: no saved copy */ }
    } catch (error) {
      host.logError(error);
      treeFailed = true;
      if (!nodes.length) nodes = readStoredTree(win);
    }
    nodesLoaded = true;
    if (collection) for (const ancestor of ancestorsOf(nodes, collection)) open.add(ancestor);
    paintTree();
    paintCrumb();
  }

  // ---- the tree
  function paintTree() {
    treeBox.replaceChildren();
    const treeHead = h(doc, 'div', 'sbw-tree-head', 'Collections');
    const closeSheet = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-tree-close'));
    closeSheet.setAttribute('type', 'button');
    closeSheet.setAttribute('aria-label', 'Close collections');
    closeSheet.append(icon(doc, 'close'));
    closeSheet.addEventListener('click', () => { setSheet(false); collectionsToggle.focus(); });
    treeHead.append(closeSheet);
    treeBox.append(treeHead);
    const all = h(doc, 'div', `sbw-tree-row${collection === null ? ' is-selected' : ''}`);
    const allLink = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-tree-link'));
    allLink.href = formatRoute({ view: 'library' });
    allLink.append(h(doc, 'span', 'sbw-tree-name', 'All papers'), h(doc, 'span', 'sbw-tree-count', cache.get('') ? cache.get('')?.length.toLocaleString() ?? '' : ''));
    if (collection === null) allLink.setAttribute('aria-current', 'page');
    all.append(h(doc, 'span', 'sbw-tree-twist'), allLink);
    treeBox.append(all);
    const list = h(doc, 'div', 'sbw-tree-list');
    for (const { node, depth, hasChildren, open: isOpen } of treeRows(nodes, open)) {
      const row = h(doc, 'div', `sbw-tree-row${node.key === collection ? ' is-selected' : ''}`);
      row.style.paddingInlineStart = `${12 + depth * 14}px`;
      const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-tree-link'));
      link.href = formatRoute({ view: 'library', collection: node.key });
      if (node.key === collection) link.setAttribute('aria-current', 'page');
      link.append(h(doc, 'span', 'sbw-tree-name', node.name), h(doc, 'span', 'sbw-tree-count', String(node.count)));
      /** @type {HTMLElement} */ let twist = h(doc, 'span', 'sbw-tree-twist');
      if (hasChildren) {
        // a real button beside the link (a button inside a link is neither valid nor reachable by keyboard)
        twist = h(doc, 'button', 'sbw-tree-twist has-children');
        twist.setAttribute('type', 'button');
        twist.setAttribute('aria-expanded', String(isOpen));
        twist.setAttribute('aria-label', `${isOpen ? 'Collapse' : 'Expand'} ${node.name}`);
        twist.append(icon(doc, 'chevron', `sb-p-icon${isOpen ? ' is-open' : ''}`));
        twist.addEventListener('click', () => {
          if (open.has(node.key)) open.delete(node.key); else open.add(node.key);
          paintTree();
          twistOf(node.key)?.focus(); // the redraw replaced the button that had the focus
        });
        twist.dataset.key = node.key;
      }
      row.append(twist, link);
      list.append(row);
    }
    treeBox.append(list);
    if (treeFailed) {
      const note = h(doc, 'p', 'sbw-hint sbw-tree-empty', nodes.length ? "Can't reach the server; this is the last list this browser kept. " : "Can't reach the server. ");
      note.append(linkButton('Try again', () => { void loadTree(); }));
      treeBox.append(note);
    } else if (nodesLoaded && !nodes.length) treeBox.append(h(doc, 'p', 'sbw-hint sbw-tree-empty', 'No collections.'));
  }

  /** @param {string} key */
  const twistOf = (key) => /** @type {HTMLElement[]} */ (Array.from(treeBox.querySelectorAll('button.sbw-tree-twist'))).find((b) => b.dataset.key === key);

  /** The whole path after "Library": each ancestor a link, the chosen collection plain. */
  function paintCrumb() {
    const path = crumbPath(nodes, collection);
    crumb.replaceChildren();
    path.forEach((step, i) => {
      crumb.append(' / ');
      if (i === path.length - 1) { crumb.append(step.name); return; }
      const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-lib-crumb-link', step.name));
      link.href = formatRoute({ view: 'library', collection: step.key });
      crumb.append(link);
    });
    chipName.textContent = collectionName() || 'All papers';
    search.placeholder = searchPlaceholder(collectionName());
    search.setAttribute('aria-label', search.placeholder);
  }

  // ---- events
  scroller.addEventListener('scroll', () => drawRows(), { passive: true });
  new (/** @type {any} */ (win)).ResizeObserver(() => drawRows(true)).observe(scroller);
  search.addEventListener('input', () => {
    // says so at once, in place of a count that no longer holds, and an answer still on its way is for the old words;
    // clearing the box waits for the timer like any other edit
    searchToken++;
    if (search.value.trim()) { searching = true; searchFailed = false; paintStatus(); }
    win.clearTimeout(searchTimer);
    searchTimer = win.setTimeout(() => { void runSearch(); }, SEARCH_MS);
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { win.clearTimeout(searchTimer); void runSearch(); }
    if (event.key === 'Escape' && search.value) { search.value = ''; void runSearch(); }
  });
  // Wide: the button hides or shows the collections column, like the chat history, and the choice is kept.
  // Narrow: it and the chip open the collections as a sheet over the list.
  const wide = () => Boolean(win.matchMedia?.('(min-width: 700px)').matches);
  const applyCollapsed = (/** @type {boolean} */ collapsed) => {
    root.classList.toggle('hide-tree', collapsed);
    if (wide()) collectionsToggle.setAttribute('aria-expanded', String(!collapsed));
    collectionsToggle.title = collapsed ? 'Show collections' : 'Hide collections';
  };
  applyCollapsed(Boolean(host.prefs?.get?.('libraryTreeCollapsed')));
  /** @param {boolean} on */
  function setSheet(on) {
    root.classList.toggle('show-tree', on);
    collectionsToggle.setAttribute('aria-expanded', String(on));
    chip.setAttribute('aria-expanded', String(on));
    if (on) /** @type {HTMLElement | null} */ (treeBox.querySelector('.sbw-tree-close'))?.focus();
  }
  collectionsToggle.addEventListener('click', () => {
    if (wide()) {
      const collapsed = !root.classList.contains('hide-tree');
      host.prefs?.set?.('libraryTreeCollapsed', collapsed);
      applyCollapsed(collapsed);
      return;
    }
    setSheet(!root.classList.contains('show-tree'));
  });
  chip.addEventListener('click', () => setSheet(true));
  treeBox.addEventListener('click', (event) => {
    if (/** @type {HTMLElement} */ (event.target).closest('a')) setSheet(false);
  });
  treeBox.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && root.classList.contains('show-tree')) { setSheet(false); collectionsToggle.focus(); }
  });
  // a tap on the list closes the sheet; the buttons that open it decide for themselves
  main.addEventListener('pointerdown', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    if (root.classList.contains('show-tree') && !collectionsToggle.contains(target) && !chip.contains(target)) setSheet(false);
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
          search.value = pendingSearch;
          pendingSearch = '';
          found = null;
          query = '';
          searching = false;
          searchFailed = false;
          searchToken++;
          sortTouched = false;
          scroller.scrollTop = 0;
          for (const ancestor of ancestorsOf(nodes, next ?? '')) open.add(ancestor);
        }
        void load();
        if (changed && search.value) void runSearch();
      } else {
        refresh();
      }
      paintTree();
      paintCrumb();
      win.requestAnimationFrame(() => drawRows(true));
    },
  };
}
