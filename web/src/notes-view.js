// @ts-check
// ui-src/src/web/notes-view.js. The Notes page (spec 013 W2): search over the vault, or the recently changed notes
// while the box is empty. Rows open the note reader. Spec 029 R15: each row has a mark for its kind (daily note, chat,
// digest, …), two lines of text and "kind · when · folder"; a kind filter; Recent in day groups; a page as wide as Read later.
import { h } from '../../ui/src/dom.js';
import { formatRoute } from '../../ui/src/sources/route.js';
import { titleNodes } from '../../ui/src/chat/markdown.js';
import { apiOf, folderLabel, isNotePath } from '../../ui/src/sources/view-kit.js';
import { icon } from '../../ui/src/icons.js';
import { NOTE_KINDS, dayGroup, kindCounts, modifiedAt, noteKind, readableTitle, whenLine } from '../../ui/src/note-kind.js';

/** @typedef {import("../../ui/src/sources/view-kit.js").ViewContext} ViewContext */
/** @typedef {import("../../ui/src/note-kind.js").NoteKind} NoteKind */

const SEARCH_MS = 250;
const RECENT_LIMIT = 40;
const SEARCH_LIMIT = 40;

/** Only notes have a reader (Markdown, and .markdown/.txt in listed folders); PDFs and images are not listed.
 *  @param {{ path: string }} item */
const isNote = (item) => isNotePath(item.path);

/** The note rows for a /search or /recent reply. A hit's first passage is its second line. Spec 029 R15: each row
 *  knows its kind (note-kind.js) and when it changed. @param {any[]} items */
export function noteRows(items) {
  return items.filter(isNote).map((item) => {
    const passage = item.passages?.[0];
    const path = String(item.path);
    return {
      path, title: String(item.title), folder: folderLabel(path), modified: String(item.modified ?? ''), at: modifiedAt(item.modified),
      kind: noteKind(path, item.source), snippet: passage ? String(passage.snippet).replace(/\s+/g, ' ').trim().slice(0, 240) : '',
      // kept for callers that read one line: folder · modified
      meta: [folderLabel(path), item.modified].filter(Boolean).join(' · '),
    };
  });
}

/** "Daily note · 2 hours ago · 2026/11-November". @param {ReturnType<typeof noteRows>[number]} row @param {number} [now] */
export function noteLine(row, now = Date.now()) {
  const when = Number.isFinite(row.at) ? whenLine(row.at, now) : row.modified;
  // a daily note's folder (2026/11-November) only repeats its date
  const folder = row.folder === 'Vault' || row.kind === 'daily' ? '' : row.folder;
  return [NOTE_KINDS[row.kind].label, when, folder].filter(Boolean).join(' · ');
}

/** The kind filter's choice, kept for the window's life (like Read later's fold). @type {NoteKind | 'all'} */
let shownKind = 'all';

/** @param {HTMLElement} into @param {ViewContext} ctx @param {{ q?: string }} route */
export async function paintNotes(into, ctx, route) {
  const { host, doc, win } = ctx;
  const api = apiOf(host);
  const page = h(doc, 'div', 'sbw-page sbw-notes sbw-notes-page');
  const search = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-lib-search sbw-notes-search'));
  search.type = 'search';
  search.placeholder = 'Search your notes';
  search.setAttribute('aria-label', 'Search your notes');
  search.value = route.q ?? '';
  const heading = h(doc, 'h2', 'sbw-h2');
  const kinds = h(doc, 'div', 'sbw-notes-kinds');
  kinds.setAttribute('role', 'group');
  kinds.setAttribute('aria-label', 'Show notes of one kind');
  const status = h(doc, 'p', 'sbw-hint');
  status.setAttribute('role', 'status');
  const list = h(doc, 'div', 'sbw-list sbw-notes-list');
  page.append(h(doc, 'h1', 'sbw-h1', 'Notes'), search, heading, kinds, status, list);
  into.replaceChildren(page);

  let token = 0;
  /** @type {any} */ let timer = null;
  /** @type {ReturnType<typeof noteRows>} */ let rows = [];
  let searching = false;

  /** @param {ReturnType<typeof noteRows>[number]} row */
  const rowOf = (row) => {
    const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-note-row'));
    link.href = formatRoute({ view: 'note', path: row.path });
    link.dataset.kind = row.kind;
    const mark = h(doc, 'span', `sbw-note-mark is-${row.kind}`);
    mark.title = NOTE_KINDS[row.kind].label;
    mark.append(icon(doc, NOTE_KINDS[row.kind].icon, 'sb-p-icon'));
    const text = h(doc, 'span', 'sbw-card-text');
    const cardTitle = h(doc, 'span', 'sbw-card-title');
    const shownTitle = readableTitle(row.title, row.kind);
    cardTitle.append(titleNodes(doc, shownTitle));
    if (shownTitle !== row.title) cardTitle.title = row.title;
    text.append(cardTitle);
    if (row.snippet) text.append(h(doc, 'span', 'sbw-note-snippet', row.snippet));
    text.append(h(doc, 'span', 'sbw-card-meta', noteLine(row)));
    link.append(mark, text);
    return link;
  };

  function draw() {
    const counts = kindCounts(rows);
    if (shownKind !== 'all' && !counts.some((c) => c.kind === shownKind)) shownKind = 'all';
    /** @param {NoteKind | 'all'} kind @param {string} label @param {number} n */
    const chip = (kind, label, n) => {
      const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-chip sbw-notes-kind'));
      b.type = 'button';
      b.dataset.kind = kind;
      b.setAttribute('aria-pressed', String(shownKind === kind));
      if (kind !== 'all') b.append(icon(doc, NOTE_KINDS[kind].icon, 'sb-p-icon'));
      b.append(`${label} `, h(doc, 'span', 'sbw-notes-kind-n', String(n)));
      b.addEventListener('click', () => { shownKind = kind; draw(); });
      return b;
    };
    // a filter is worth showing only when the list holds more than one kind
    kinds.replaceChildren(...(counts.length > 1 ? [chip('all', 'All', rows.length), ...counts.map((c) => chip(c.kind, NOTE_KINDS[c.kind].plural, c.count))] : []));
    kinds.hidden = counts.length < 2;
    const shown = shownKind === 'all' ? rows : rows.filter((r) => r.kind === shownKind);
    if (searching) { list.replaceChildren(...shown.map(rowOf)); return; }
    // Recent comes in day groups: Today, Yesterday, This week, Earlier
    /** @type {Map<string, HTMLElement[]>} */ const groups = new Map();
    for (const row of shown) {
      const name = dayGroup(row.at);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)?.push(rowOf(row));
    }
    list.replaceChildren(...[...groups].flatMap(([name, els]) => [h(doc, 'h3', 'sbw-notes-day', name), ...els]));
  }

  async function run() {
    const mine = ++token;
    const q = search.value.trim();
    heading.textContent = q ? 'Results' : 'Recent';
    status.textContent = 'Loading…';
    list.replaceChildren();
    kinds.replaceChildren();
    kinds.hidden = true;
    let found;
    try {
      const reply = q
        ? await api('/search', { q, exclude_source: 'zotero', limit: SEARCH_LIMIT })
        : await api('/recent', { days: 90, limit: RECENT_LIMIT + 20 });
      found = noteRows(reply ?? []).slice(0, q ? SEARCH_LIMIT : RECENT_LIMIT);
    } catch (error) {
      if (mine === token) status.textContent = `Couldn't load notes: ${/** @type {any} */ (error)?.message ?? error}`;
      return;
    }
    if (mine !== token) return;
    rows = found;
    searching = Boolean(q);
    status.textContent = rows.length ? '' : q ? `No notes match “${q}”.` : 'No notes changed lately.';
    draw();
  }

  search.addEventListener('input', () => { win.clearTimeout(timer); timer = win.setTimeout(() => { void run(); }, SEARCH_MS); });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    win.clearTimeout(timer);
    // The query goes in the address so Back from a note returns to the same results.
    win.history.replaceState(null, '', formatRoute({ view: 'notes', q: search.value.trim() }));
    void run();
  });
  await run();
}
