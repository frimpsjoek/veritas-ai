// @ts-check
// web/src/later-view.js. Spec 028 R11/R12: the Read later list. Unread (newest first), then Read; each row its title
// (arXiv's TeX drawn), authors, venue and year, and Open, Mark as read or unread, Remove from Read later. Opening a
// paper opens it in the reader (or Browse, where papers open there) and marks it read. The same list is the Read later
// view and Library's Read later filter, and the rail's Read later item carries the unread count.
import { h } from '../../ui/src/dom.js';
import { icon, lucide } from '../../ui/src/icons.js';
import { openImageViewer } from '../../ui/src/image-viewer.js';
import { getPapers } from '../../ui/src/get-paper.js';
import { stateWords } from '../../ui/src/get-paper-data.js';
import { setPaperText } from '../../ui/src/paper-text.js';
import { authorLine } from '../../ui/src/sources/view-kit.js';
import { formatRoute } from '../../ui/src/sources/route.js';
import { markLater, onReadingList, readingEntries, refreshReadingList, unsaveLater } from '../../ui/src/reading-list.js';
import { entryMeta, filterLater, laterSections, noMatch, savedLine, LATER_FILTER, LATER_TOOLS_AT, SORT_NEWEST, SORT_OLDEST, unreadCount, IN_ZOTERO, LATER_FAILED, LATER, LATER_EMPTY, MARK_READ, NOTHING_UNREAD, MARK_UNREAD, READ, REMOVE, UNREAD } from '../../ui/src/reading-list-data.js';

/** @typedef {import("../../agent/src/service").ReadingListEntry} ReadingListEntry */

/** @typedef {{ inZotero?: (entries: ReadingListEntry[]) => Promise<Map<string, string>>, keep?: boolean, hidden?: () => boolean }} LaterOptions */

/** Whether the Read fold is open, for the window's life (the Read later page is built again on every visit). */
let foldOpen = false;

/** The list, repainted after every change. @param {{ host: any, doc: Document }} ctx @param {LaterOptions} [opts] */
export const laterList = (ctx, opts) => laterPane(ctx, opts).root;

/**
 * The list and `show()`. `inZotero` gives, for each entry already in the Zotero library, its item key. `keep`: the list
 * belongs to a view that is kept and shown again (Library), so it listens for as long as the page lives. `hidden`: while
 * it says so a change is not painted (nor `inZotero` asked, which can read the whole library); `show()` paints the
 * newest list then. @param {{ host: any, doc: Document }} ctx @param {LaterOptions} [opts]
 */
export function laterPane({ host, doc }, opts = {}) {
  const root = h(doc, 'div', 'sbw-later');
  // the rows go in `body`; spec 029 R4's filter and sort bar goes before it once the list is long enough
  const body = h(doc, 'div', 'sbw-later-body');
  body.append(h(doc, 'p', 'sbw-hint', 'Loading…'));
  root.append(body);
  let paintToken = 0;
  let query = '';
  /** @type {'newest' | 'oldest'} */ let order = 'newest';
  /** @type {ReadingListEntry[] | null} the list last painted, for a filter or sort change */ let last = null;
  const bar = h(doc, 'div', 'sbw-later-bar');
  const filter = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-later-filter'));
  filter.type = 'search';
  filter.placeholder = LATER_FILTER;
  filter.setAttribute('aria-label', LATER_FILTER);
  filter.addEventListener('input', () => { query = filter.value; if (last) void paint(last); });
  const sort = /** @type {HTMLSelectElement} */ (h(doc, 'select', 'sbw-later-sort'));
  sort.setAttribute('aria-label', 'Sort');
  for (const [value, label] of [['newest', SORT_NEWEST], ['oldest', SORT_OLDEST]]) {
    const option = /** @type {HTMLOptionElement} */ (h(doc, 'option', '', label));
    option.value = value;
    sort.append(option);
  }
  sort.addEventListener('change', () => { order = sort.value === 'oldest' ? 'oldest' : 'newest'; if (last) void paint(last); });
  bar.append(filter, sort);
  /** The bar before the rows, only for a long list. @param {boolean} on */
  let barOn = false;
  const tools = (/** @type {boolean} */ on) => {
    if (on === barOn) return; // the bar stays put while typing, so the box keeps its focus
    barOn = on;
    root.replaceChildren(...(on ? [bar, body] : [body]));
  };

  /** @param {string} label @param {() => Promise<unknown>} run @param {string} [cls] @param {(() => Element) | null} [glyph]
   *  spec 029 R2: an icon alone, its words the tooltip and the accessible name (kept in the button for screen readers) */
  const action = (label, run, cls = 'sbw-quiet', glyph = null) => {
    const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', glyph ? `${cls} sbw-later-icon` : cls, glyph ? undefined : label));
    if (glyph) {
      b.append(glyph(), h(doc, 'span', 'sbw-later-label', label));
      b.title = label;
      b.setAttribute('aria-label', label);
    }
    b.setAttribute('type', 'button');
    b.addEventListener('click', async () => {
      b.disabled = true;
      // a change repaints the row; an Open that changes nothing (read already, or marking it read failed) does not
      try { await run(); } catch (error) { host.logError(error); host.notice("Couldn't save that. Try again."); } finally { b.disabled = false; }
    });
    return b;
  };

  /** @param {ReadingListEntry} entry */
  const open = (entry) => {
    host.openLink(entry.url);
    if (!entry.read) void markLater(host, doc, entry.id, true).catch((/** @type {unknown} */ error) => host.logError(error));
  };

  /** Spec 029 R11: the paper's graphical abstract (or first figure) beside its words, from the server's figure finder
   *  (Home's /paper-figure), asked only once the row comes into view; nothing is drawn until a picture has loaded.
   *  @param {ReadingListEntry} entry @param {HTMLElement} text @param {HTMLElement} rowEl */
  function figure(entry, text, rowEl) {
    if (typeof host.json !== 'function' || !(entry.doi || entry.arxiv)) return;
    const box = h(doc, 'span', 'sbw-later-figure');
    box.hidden = true;
    text.append(box); // first in the text, floated, so the words run round it
    const ask = () => {
      const query = new URLSearchParams({ doi: entry.doi ?? '', ...(entry.arxiv ? { arxiv: entry.arxiv } : {}) });
      void Promise.resolve(host.json(`/paper-figure?${query}`)).then((/** @type {any} */ found) => {
        if (!found?.image) return;
        const img = /** @type {HTMLImageElement} */ (h(doc, 'img', 'sbw-later-figure-img'));
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.decoding = 'async';
        img.addEventListener('load', () => { box.hidden = false; rowEl.classList.add('has-figure'); }, { once: true });
        img.addEventListener('error', () => img.remove(), { once: true });
        img.src = found.image;
        box.append(img);
        // spec 029 R12: the picture opens full screen, by click or Enter / Space
        box.setAttribute('role', 'button');
        box.tabIndex = 0;
        box.title = 'View full screen';
        box.setAttribute('aria-label', `View the picture for “${entry.title.slice(0, 80)}” full screen`);
        const view = () => openImageViewer(doc, { src: found.image, alt: 'Graphical abstract', open: (u) => host.openLink(u) });
        box.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); view(); });
        box.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); view(); } });
      }, () => {});
    };
    const IO = /** @type {any} */ (doc.defaultView)?.IntersectionObserver;
    if (!IO) { ask(); return; }
    const seen = new IO((/** @type {any[]} */ changes) => {
      if (!changes.some((c) => c.isIntersecting)) return;
      seen.disconnect();
      ask();
    }, { rootMargin: '200px' });
    seen.observe(rowEl);
  }

  /** @param {ReadingListEntry} entry @param {Map<string, string>} zotero */
  function row(entry, zotero) {
    const el = h(doc, 'div', `sbw-later-row${entry.read ? ' is-read' : ''}`);
    el.dataset.id = entry.id;
    const text = h(doc, 'div', 'sbw-later-text');
    figure(entry, text, el);
    const title = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-later-title'));
    title.href = entry.url;
    setPaperText(title, entry.title);
    title.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return; // a new tab, as any link
      event.preventDefault();
      open(entry);
    });
    text.append(title);
    const authors = authorLine(entry.authors, 3);
    if (authors) text.append(h(doc, 'span', 'sbw-later-meta', authors));
    const meta = entryMeta(entry);
    if (meta) text.append(h(doc, 'span', 'sbw-later-meta', meta));
    // spec 029 R1: two lines of the abstract, its TeX drawn as the title's is, and when it went on the list
    if (entry.abstract) {
      const abstract = h(doc, 'p', 'sbw-later-abstract');
      setPaperText(abstract, entry.abstract);
      text.append(abstract);
    }
    const saved = savedLine(entry);
    if (saved) text.append(h(doc, 'span', 'sbw-later-saved', saved));
    const key = zotero.get(entry.id);
    if (key) {
      const mine = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-later-zotero', IN_ZOTERO));
      mine.href = formatRoute({ view: 'paper', key });
      text.append(mine);
    }
    const acts = h(doc, 'div', 'sbw-later-acts');
    // spec 031 R5, spec 032: a paper not in the library yet: its free PDF kept, in Zotero or in Veritas › Papers
    const getPdf = key ? null : action('Get PDF', async () => {
      const got = await getPapers(host, [{ title: entry.title, authors: entry.authors, year: entry.year, venue: entry.venue, doi: entry.doi ?? null, arxiv: entry.arxiv ?? null, url: entry.url, abstract: entry.abstract ?? '', source: 'read later' }], { openOne: true });
      if (got.states[0]) host.notice?.(stateWords(got.states[0]));
      if (got.added) await paint(last);
    }, 'sbw-quiet', () => icon(doc, 'download', 'sb-p-icon sbw-later-glyph'));
    acts.append(
      action('Open', async () => open(entry), 'sbw-quiet sbw-later-open'),
      ...(getPdf ? [getPdf] : []),
      action(entry.read ? MARK_UNREAD : MARK_READ, () => markLater(host, doc, entry.id, !entry.read), 'sbw-quiet', () => lucide(doc, entry.read ? 'refreshCw' : 'check', 16)),
      action(REMOVE, () => unsaveLater(host, doc, entry.id), 'sbw-quiet', () => icon(doc, 'trash', 'sb-p-icon sbw-later-glyph')),
    );
    el.append(text, acts);
    return el;
  }

  /** @param {ReadingListEntry[] | null} list */
  async function paint(list) {
    const mine = ++paintToken;
    last = list;
    tools(Boolean(list && list.length >= LATER_TOOLS_AT));
    if (!list) { body.replaceChildren(h(doc, 'p', 'sbw-hint', 'This server has no Read later list yet.')); return; }
    if (!list.length) { body.replaceChildren(h(doc, 'p', 'sbw-hint sbw-later-empty', LATER_EMPTY)); return; }
    /** @type {Map<string, string>} */ let zotero = new Map();
    try { zotero = (await opts.inZotero?.(list)) ?? zotero; } catch (error) { host.logError(error); }
    if (mine !== paintToken) return;
    const shown = list.length >= LATER_TOOLS_AT ? filterLater(list, query) : list;
    if (!shown.length) { body.replaceChildren(h(doc, 'p', 'sbw-hint sbw-later-nomatch', noMatch(query.trim()))); return; }
    const { unread, read } = laterSections(shown, list.length >= LATER_TOOLS_AT ? order : 'newest');
    body.replaceChildren();
    if (unread.length) {
      const section = h(doc, 'section', 'sbw-later-section');
      section.dataset.section = UNREAD;
      section.append(h(doc, 'h2', 'sbw-h2', `${UNREAD} · ${unread.length}`));
      for (const entry of unread) section.append(row(entry, zotero));
      body.append(section);
    } else body.append(h(doc, 'p', 'sbw-hint sbw-later-none', NOTHING_UNREAD));
    if (read.length) {
      // spec 029 R3: Read folds under its heading, shut at first; opened or shut, it stays so while the window lives
      const section = /** @type {HTMLDetailsElement} */ (h(doc, 'details', 'sbw-later-section sbw-later-fold'));
      section.dataset.section = READ;
      section.open = foldOpen;
      const summary = h(doc, 'summary', 'sbw-h2 sbw-later-fold-head');
      summary.append(lucide(doc, 'chevronDown', 14), doc.createTextNode(`${READ} · ${read.length}`));
      section.append(summary);
      section.addEventListener('toggle', () => { foldOpen = section.open; });
      for (const entry of read) section.append(row(entry, zotero));
      body.append(section);
    }
  }

  /** @type {{ list: ReadingListEntry[] | null } | null} the newest list not painted, while hidden */ let missed = null;
  onReadingList(doc, host, opts.keep ? null : root, (list) => {
    if (opts.hidden?.()) { missed = { list }; return; }
    missed = null;
    void paint(list);
  });
  // A first read that failed (server down, or one with no reading list) is not left on "Loading…": it says so, with
  // Try again; a list read later (the button, focus, a change) paints over it.
  const unknown = () => {
    const again = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Try again'));
    again.type = 'button';
    again.addEventListener('click', async () => {
      again.disabled = true;
      if ((await refreshReadingList(host, doc)) === undefined) again.disabled = false;
    });
    const line = h(doc, 'p', 'sbw-hint sbw-later-failed', LATER_FAILED);
    line.append(' ', again);
    body.replaceChildren(line);
  };
  void readingEntries(host).then((list) => { if (list === undefined && !paintToken) unknown(); });
  return {
    root,
    show() {
      if (!missed) return;
      const { list } = missed;
      missed = null;
      void paint(list);
    },
  };
}

/** The Read later page. @param {HTMLElement} into @param {{ host: any, doc: Document }} ctx */
export async function paintLater(into, ctx) {
  const page = h(ctx.doc, 'div', 'sbw-page sbw-later-page');
  page.append(h(ctx.doc, 'h1', 'sbw-h1', LATER), laterList(ctx));
  into.replaceChildren(page);
  // a list changed in another window (or the Zotero plugin) shows when the page opens
  await refreshReadingList(ctx.host, ctx.doc);
}

/** Keeps the unread count on a rail item, hidden at 0, after every change and when the window comes back. `dispose`
 *  stops listening for the window's focus (the shell's destroy).
 *  @param {Document} doc @param {Window} win @param {any} host @param {HTMLElement} link
 *  @returns {{ badge: HTMLElement, dispose(): void }} */
export function laterBadge(doc, win, host, link) {
  const badge = h(doc, 'span', 'sbw-nav-badge');
  badge.hidden = true;
  link.append(badge);
  /** @param {ReadingListEntry[] | null} list */
  const paint = (list) => {
    const n = list ? unreadCount(list) : 0;
    badge.textContent = String(n);
    badge.hidden = n === 0;
    link.setAttribute('aria-label', n ? `${LATER}, ${n} unread` : LATER);
  };
  onReadingList(doc, host, link, paint);
  const onFocus = () => { void refreshReadingList(host, doc); };
  win.addEventListener('focus', onFocus);
  return { badge, dispose: () => win.removeEventListener('focus', onFocus) };
}
