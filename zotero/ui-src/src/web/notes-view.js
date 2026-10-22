// @ts-check
// ui-src/src/web/notes-view.js. The Notes page (spec 013 W2): search over the vault, or the recently changed notes
// while the box is empty. Rows are 56 px hairline rows (ledger 3) and open the note reader.
import { h } from '../dom.js';
import { formatRoute } from './route.js';
import { titleNodes } from '../chat/markdown.js';
import { apiOf, folderLabel, isNotePath } from './view-kit.js';
import { authorAvatar } from '../avatars.js';

/** @typedef {import("./view-kit.js").ViewContext} ViewContext */

const SEARCH_MS = 250;
const RECENT_LIMIT = 40;
const SEARCH_LIMIT = 40;

/** Only notes have a reader (Markdown, and .markdown/.txt in listed folders); PDFs and images are not listed.
 *  @param {{ path: string }} item */
const isNote = (item) => isNotePath(item.path);

/** The note rows for a /search or /recent reply. A hit's first passage is its second line. @param {any[]} items */
export function noteRows(items) {
  return items.filter(isNote).map((item) => {
    const passage = item.passages?.[0];
    const where = [folderLabel(item.path), item.modified].filter(Boolean).join(' · ');
    return { path: String(item.path), title: String(item.title), meta: where, snippet: passage ? String(passage.snippet).replace(/\s+/g, ' ').trim().slice(0, 160) : '' };
  });
}

/** @param {HTMLElement} into @param {ViewContext} ctx @param {{ q?: string }} route */
export async function paintNotes(into, ctx, route) {
  const { host, doc, win } = ctx;
  const api = apiOf(host);
  const page = h(doc, 'div', 'sbw-page sbw-notes');
  const search = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-lib-search sbw-notes-search'));
  search.type = 'search';
  search.placeholder = 'Search your notes';
  search.setAttribute('aria-label', 'Search your notes');
  search.value = route.q ?? '';
  const heading = h(doc, 'h2', 'sbw-h2');
  const status = h(doc, 'p', 'sbw-hint');
  status.setAttribute('role', 'status');
  const list = h(doc, 'div', 'sbw-list');
  page.append(h(doc, 'h1', 'sbw-h1', 'Notes'), search, heading, status, list);
  into.replaceChildren(page);

  let token = 0;
  /** @type {any} */ let timer = null;

  async function run() {
    const mine = ++token;
    const q = search.value.trim();
    heading.textContent = q ? 'Results' : 'Recent';
    status.textContent = 'Loading…';
    list.replaceChildren();
    let rows;
    try {
      const reply = q
        ? await api('/search', { q, exclude_source: 'zotero', limit: SEARCH_LIMIT })
        : await api('/recent', { days: 90, limit: RECENT_LIMIT + 20 });
      rows = noteRows(reply ?? []).slice(0, q ? SEARCH_LIMIT : RECENT_LIMIT);
    } catch (error) {
      if (mine === token) status.textContent = `Couldn't load notes: ${/** @type {any} */ (error)?.message ?? error}`;
      return;
    }
    if (mine !== token) return;
    status.textContent = rows.length ? '' : q ? `No notes match “${q}”.` : 'No notes changed lately.';
    for (const row of rows) {
      const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-card sbw-note-row'));
      link.href = formatRoute({ view: 'note', path: row.path });
      const text = h(doc, 'span', 'sbw-card-text');
      const cardTitle = h(doc, 'span', 'sbw-card-title');
      const author = authorAvatar(doc, row.path, 16);
      if (author) { author.classList.add('sbw-note-author'); cardTitle.append(author); }
      cardTitle.append(titleNodes(doc, row.title));
      text.append(cardTitle, h(doc, 'span', 'sbw-card-meta', row.snippet || row.meta));
      if (row.snippet) text.title = row.meta;
      link.append(text);
      list.append(link);
    }
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
