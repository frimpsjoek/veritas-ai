// @ts-check
// ui-src/src/web/paper-view.js. The paper reader (spec 013 W2, ledger 8): contents on the left, the article in the
// middle (title, authors, abstract at 66 to 70 characters, the PDF with highlighting, highlights, notes) and a 320 px
// panel on the right (Info, Related, Links). Below 960 px only the article shows and the panel sits behind one
// toggle.
import { h } from '../../ui/src/dom.js';
import { icon } from '../../ui/src/icons.js';
import { LOGOS, logoSvg } from '../../ui/src/logos.js';
import { ChipRow, Highlight } from '../../ui/src/panels/panels.js';
import { LinksPanel, RelatedPanel } from '../../ui/src/panels/related-panels.js';
import { titleNodes } from '../../ui/src/chat/markdown.js';
import { interceptLinks, wireLink } from '../../ui/src/links.js';
import { apiOf, authorLine, doiUrl, noteFragment, panelBlock, openRefHandler, titleResolver } from '../../ui/src/sources/view-kit.js';
import { formatRoute } from '../../ui/src/sources/route.js';
import { chipLabel } from './library-data.js';
import { PdfViewer } from './pdf-viewer.js';

/** @typedef {import("../../ui/src/sources/view-kit.js").ViewContext} ViewContext */

const WIDE = 960;

/**
 * Asks for the first byte of a PDF, so the page can say why one is missing before PDF.js shows a bare error.
 * (The server answers HEAD with 501, and a Range request is what the PDF viewer sends anyway.)
 * @param {Window} win @param {string} src @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function probePdf(win, src) {
  try {
    const response = await win.fetch(src, { headers: { Range: 'bytes=0-0' } });
    if (response.ok) return { ok: true };
    const text = await response.text().catch(() => '');
    let message = text.trim();
    try { message = String(JSON.parse(text).error ?? message); } catch { /* a plain-text message */ }
    return { ok: false, message: message || `The server answered ${response.status}.` };
  } catch (error) {
    return { ok: false, message: `Couldn't reach the server (${/** @type {any} */ (error)?.message ?? error}).` };
  }
}

/** The parts of /zotero?key= this page reads. @param {any} item */
export function paperParts(item) {
  const attachments = /** @type {any[]} */ (Array.isArray(item.attachments) ? item.attachments : []);
  const pdf = attachments.find((a) => a.content_type === 'application/pdf') ?? null;
  const highlights = attachments.flatMap((a) => a.highlights ?? []);
  const authors = /** @type {any[]} */ (item.creators ?? []);
  const writers = authors.filter((c) => c.role === 'author');
  return {
    pdf, highlights,
    notes: /** @type {string[]} */ (Array.isArray(item.notes) ? item.notes.filter((/** @type {string} */ n) => String(n).trim()) : []),
    authors: (writers.length ? writers : authors).map((c) => String(c.name)),
  };
}

/** @typedef {import('./pdf-viewer.js').Mark} Mark */

/** The PDF's highlights already in Zotero that can be drawn (those with a position). @param {any} pdf @returns {Mark[]} */
export function savedMarks(pdf) {
  return /** @type {any[]} */ (pdf.highlights ?? [])
    .filter((hl) => (hl.type === 'highlight' || hl.type === 'underline') && Array.isArray(hl.position?.rects) && Number.isInteger(hl.position?.pageIndex))
    .map((hl) => ({ color: String(hl.color || ''), position: hl.position, waiting: false, text: hl.text }));
}

/** Highlights made here that the Zotero plugin has yet to save. @param {import('../../ui/src/panels/related-panels.js').FetchJSON} api @param {string} key @returns {Promise<Mark[]>} */
async function waitingMarks(api, key) {
  const queue = await api('/zotero/pending-adds').catch(() => []);
  return (Array.isArray(queue) ? queue : [])
    .filter((e) => e?.kind === 'annotation' && e.key === key && e.annotation?.position)
    .map((e) => ({ color: String(e.annotation.color), position: e.annotation.position, waiting: true, text: e.annotation.text }));
}

/** @param {HTMLElement} into @param {ViewContext} ctx @param {{ key: string }} route */
export async function paintPaper(into, ctx, route) {
  const { host, doc, win, go } = ctx;
  const api = apiOf(host);
  const wrap = h(doc, 'div', 'sbw-reader-wrap');
  into.replaceChildren(wrap);
  const status = h(doc, 'p', 'sbw-hint sbw-reader-status', 'Loading…');
  wrap.append(status);

  /** @type {any} */ let item;
  try {
    item = await api('/zotero', { key: route.key });
  } catch (error) {
    const missing = /** @type {any} */ (error)?.status === 404;
    status.textContent = missing ? "This paper isn't in your library any more." : `Couldn't load this paper: ${/** @type {any} */ (error)?.message ?? error}`;
    const back = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-link', 'Back to the library'));
    back.href = formatRoute({ view: 'library' });
    status.append(' ', back);
    return;
  }
  const parts = paperParts(item);
  const zoteroUri = String(item.zotero_uri || `zotero://select/library/items/${route.key}`);
  win.document.title = `${item.title} · Veritas`;

  // ---- the shell of the page
  const reader = h(doc, 'div', 'sbw-reader');
  const bar = h(doc, 'div', 'sbw-reader-bar');
  const back = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-quiet sbw-reader-back'));
  back.href = formatRoute({ view: 'library' });
  back.setAttribute('aria-label', 'Back to the library');
  back.append(icon(doc, 'back', 'sb-p-icon sbw-quiet-icon'), h(doc, 'span', '', 'Library'));
  const openZotero = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-quiet'));
  openZotero.append(logoSvg(doc, LOGOS.zotero, 14), h(doc, 'span', '', 'Open in Zotero'));
  openZotero.href = zoteroUri;
  const toggle = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-reader-toggle'));
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-label', 'Show or hide the side panel');
  toggle.append(icon(doc, 'columns', 'sb-p-icon sbw-quiet-icon'), h(doc, 'span', '', 'Info'));
  const ask = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary', 'Ask about this'));
  ask.setAttribute('type', 'button');
  ask.addEventListener('click', () => {
    host.setContext([{ attachment: { kind: 'zoteroItem', citekey: item.citekey || route.key }, label: chipLabel({ key: route.key, title: item.title, authors: parts.authors, year: Number.parseInt(item.year, 10) || null, venue: '', citekey: '' }), why: 'reading' }]);
    go({ view: 'chat' });
  });
  bar.append(back, h(doc, 'span', 'sbw-spacer-x'), openZotero, toggle, ask);

  const toc = h(doc, 'nav', 'sbw-reader-toc');
  toc.setAttribute('aria-label', 'Contents');
  const article = h(doc, 'article', 'sbw-reader-article');
  const panel = h(doc, 'aside', 'sbw-reader-panel sb-p');
  panel.setAttribute('aria-label', 'Details');
  reader.append(toc, article, panel);
  wrap.replaceChildren(bar, reader);

  const setPanel = (/** @type {boolean} */ on) => {
    reader.classList.toggle('is-panel-open', on);
    toggle.setAttribute('aria-expanded', String(on));
  };
  setPanel(into.clientWidth >= WIDE || win.innerWidth >= WIDE + 224);
  toggle.addEventListener('click', () => setPanel(!reader.classList.contains('is-panel-open')));

  // ---- the article
  const head = h(doc, 'header', 'sbw-reader-head');
  const heading = h(doc, 'h1', 'sbw-reader-title');
  heading.append(titleNodes(doc, item.title));
  head.append(heading);
  if (parts.authors.length) head.append(h(doc, 'p', 'sbw-reader-authors', authorLine(parts.authors, 6)));
  const venue = [item.year, item.venue].filter(Boolean).join(' · ');
  if (venue) head.append(h(doc, 'p', 'sbw-reader-venue', venue));
  if (item.doi) {
    const doi = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-reader-doi', `doi:${item.doi}`));
    wireLink(doi, host, doiUrl(item.doi));
    head.append(doi);
  }
  article.append(head);

  /** @param {string} id @param {string} label @param {number | null} count */
  const addSection = (id, label, count) => {
    const section = h(doc, 'section', 'sbw-reader-section');
    section.id = `sbw-sec-${id}`;
    section.append(h(doc, 'h2', 'sbw-reader-h2', label));
    article.append(section);
    const link = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-toc-item'));
    link.setAttribute('type', 'button');
    link.append(h(doc, 'span', '', label), count ? h(doc, 'span', 'sbw-tree-count', String(count)) : '');
    link.addEventListener('click', () => { section.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
    toc.append(link);
    return section;
  };
  toc.append(h(doc, 'div', 'sbw-tree-head', 'Contents'));

  const abstract = addSection('abstract', 'Abstract', null);
  if (item.abstract) abstract.append(h(doc, 'p', 'sbw-prose sbw-abstract', String(item.abstract)));
  else abstract.append(h(doc, 'p', 'sbw-hint', 'This paper has no abstract in Zotero.'));

  const pdfSection = addSection('pdf', 'PDF', null);
  if (parts.pdf) {
    const pdf = parts.pdf;
    const src = `${win.location.origin}/zotero/pdf?${new URLSearchParams({ key: pdf.key })}`;
    pdfSection.append(h(doc, 'p', 'sbw-hint', 'Checking the PDF…'));
    const cantShow = (/** @type {string} */ message) => {
      const missing = h(doc, 'div', 'sbw-pdf-missing');
      const open = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sb-button sbw-brand-button'));
      open.append(logoSvg(doc, LOGOS.zotero, 16), h(doc, 'span', '', 'Open in Zotero'));
      open.href = String(pdf.open_uri || `zotero://open-pdf/library/items/${pdf.key}`);
      missing.append(h(doc, 'p', 'sbw-pdf-missing-title', "Can't show this PDF here"), h(doc, 'p', 'sbw-hint', message), open);
      pdfSection.querySelector('.sbw-pdf')?.remove();
      pdfSection.append(missing);
    };
    void Promise.all([probePdf(win, src), waitingMarks(api, pdf.key)]).then(([result, waiting]) => {
      pdfSection.querySelector('.sbw-hint')?.remove();
      if (!result.ok) return cantShow(result.message);
      const problem = h(doc, 'p', 'sbw-hint sbw-pdf-problem');
      problem.hidden = true;
      const viewer = PdfViewer(doc, win, {
        src, title: pdf.title || 'PDF', openRaw: () => host.openLink(new URL(src, win.location.href).href, { outside: true }), marks: [...savedMarks(pdf), ...waiting],
        save: (annotation) => api('/zotero/annotate', {}, { method: 'POST', body: { key: pdf.key, annotation } }),
        failed: (message) => { problem.textContent = message; problem.hidden = false; },
      });
      pdfSection.append(viewer.el, problem);
      viewer.ready.catch((error) => cantShow(`PDF.js couldn't open it (${error?.message ?? error}).`));
    });
  } else {
    const open = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sb-button sbw-brand-button'));
    open.append(logoSvg(doc, LOGOS.zotero, 16), h(doc, 'span', '', 'Open in Zotero'));
    open.href = zoteroUri;
    pdfSection.append(h(doc, 'p', 'sbw-hint', 'No PDF is attached to this paper.'), open);
  }

  if (parts.highlights.length) {
    const section = addSection('highlights', 'Highlights', parts.highlights.length);
    const list = h(doc, 'div', 'sb-p sbw-highlights');
    for (const hl of parts.highlights) list.append(Highlight(doc, { type: hl.type, text: hl.text, comment: hl.comment, color: hl.color, page: hl.page }));
    section.append(list);
  }
  if (parts.notes.length) {
    const section = addSection('notes', 'Notes', parts.notes.length);
    for (const markdown of parts.notes) {
      const body = h(doc, 'div', 'sbw-prose sbw-note-body');
      section.append(body);
      body.textContent = 'Loading…';
      void api('/render', {}, { method: 'POST', body: { markdown } }).then(
        (reply) => { body.replaceChildren(noteFragment(doc, String(reply?.html ?? ''))); interceptLinks(body, host); },
        () => { body.textContent = markdown; },
      );
    }
  }

  // ---- the panel: Info, Related, Links
  const path = `zotero/${route.key}`;
  const openRef = openRefHandler(win, go);
  const resolveTitle = titleResolver(api);

  const info = h(doc, 'div');
  const facts = h(doc, 'dl', 'sbw-facts');
  /** @param {string} label @param {string | Node | null | undefined} value */
  const fact = (label, value) => {
    if (!value) return;
    const cell = h(doc, 'dd');
    cell.append(value);
    facts.append(h(doc, 'dt', '', label), cell);
  };
  const type = String(item.type ?? '').replace(/([A-Z])/g, ' $1').toLowerCase();
  fact('Type', type ? type.charAt(0).toUpperCase() + type.slice(1) : null);
  fact('Date', item.date);
  fact('Volume', [item.volume, item.issue && `(${item.issue})`, item.pages && `pp. ${item.pages}`].filter(Boolean).join(' '));
  fact('Cite as', item.citekey ? `@${item.citekey}` : null);
  if (item.url) {
    const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-link', String(item.url).replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)));
    wireLink(link, host, item.url);
    fact('Link', link);
  }
  info.append(facts);
  if (item.collections?.length) info.append(ChipRow(doc, 'In', item.collections));
  if (item.tags?.length) info.append(ChipRow(doc, 'Tags', item.tags));

  const related = RelatedPanel(doc, { fetchJSON: api, open: openRef, linked: false });
  const links = LinksPanel(doc, { fetchJSON: api, open: openRef, resolveTitle });
  panel.append(panelBlock(doc, 'Info', info), panelBlock(doc, 'Related', related.el), panelBlock(doc, 'Links', links.el));
  void related.show(path);
  void links.show(path);
}
