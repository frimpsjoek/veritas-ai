// @ts-check
// ui-src/src/web/note-view.js. The note reader (spec 013 W2): a vault note rendered by the server, with wiki links routed
// inside the app and citations opening the paper. Same three-column frame as the paper reader; the left column holds
// the note's headings and the right panel Related and Links.
import { h } from '../../ui/src/dom.js';
import { icon } from '../../ui/src/icons.js';
import { LOGOS, logoSvg } from '../../ui/src/logos.js';
import { LinksPanel, RelatedPanel } from '../../ui/src/panels/related-panels.js';
import { interceptLinks } from '../../ui/src/links.js';
import { apiOf, folderLabel, isListedPath, linkWikiTargets, noteFragment, obsidianUri, openRefHandler, panelBlock, titleFromPath, protectMath, readerMarkdown, restoreMath, titleResolver, withoutComments, withoutFrontMatter } from '../../ui/src/sources/view-kit.js';
import { formatRoute } from '../../ui/src/sources/route.js';
import { mathNode, titleNodes } from '../../ui/src/chat/markdown.js';

/** @typedef {import("../../ui/src/sources/view-kit.js").ViewContext} ViewContext */

const WIDE = 960;
const MAX_CHARS = 2_000_000;

/** @param {HTMLElement} into @param {ViewContext} ctx @param {{ path: string }} route */
export async function paintNote(into, ctx, route) {
  const { host, doc, win, go } = ctx;
  const api = apiOf(host);
  const wrap = h(doc, 'div', 'sbw-reader-wrap');
  const status = h(doc, 'p', 'sbw-hint sbw-reader-status', 'Loading…');
  wrap.append(status);
  into.replaceChildren(wrap);

  /** @type {any} */ let note;
  /** @type {string[]} */ let known = [];
  try {
    [note, known] = await Promise.all([
      api('/note', { path: route.path, max_chars: MAX_CHARS }),
      // the notes this one links to: how a [[wiki link]] finds its page
      api('/links', { path: route.path }).then((l) => [...(l.links_to ?? []), ...(l.linked_from ?? [])], () => []),
    ]);
  } catch (error) {
    const missing = /** @type {any} */ (error)?.status === 404;
    status.textContent = missing ? "This note isn't in the vault any more." : `Couldn't load this note: ${/** @type {any} */ (error)?.message ?? error}`;
    const back = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-link', 'Back to notes'));
    back.href = formatRoute({ view: 'notes' });
    status.append(' ', back);
    return;
  }
  const title = titleFromPath(route.path);
  win.document.title = `${title} · Second Brain`;

  let html = '';
  const { markdown, formulas } = protectMath(withoutComments(withoutFrontMatter(String(note.text))));
  try {
    html = String((await api('/render', {}, { method: 'POST', body: { markdown: readerMarkdown(linkWikiTargets(markdown, known, route.path)) } }))?.html ?? '');
  } catch (error) {
    status.textContent = `Couldn't draw this note: ${/** @type {any} */ (error)?.message ?? error}`;
    return;
  }

  const reader = h(doc, 'div', 'sbw-reader');
  const bar = h(doc, 'div', 'sbw-reader-bar');
  const back = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-quiet sbw-reader-back'));
  back.href = formatRoute({ view: 'notes' });
  back.setAttribute('aria-label', 'Back to notes');
  back.append(icon(doc, 'back', 'sb-p-icon sbw-quiet-icon'), h(doc, 'span', '', 'Notes'));
  const openObsidian = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-quiet'));
  openObsidian.append(logoSvg(doc, LOGOS.obsidian, 14), h(doc, 'span', '', 'Open in Obsidian'));
  openObsidian.href = obsidianUri(route.path);
  if (isListedPath(route.path)) openObsidian.hidden = true;  // a listed folder (spec 018) is not in the vault
  const toggle = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet sbw-reader-toggle'));
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-label', 'Show or hide the side panel');
  toggle.append(icon(doc, 'columns', 'sb-p-icon sbw-quiet-icon'), h(doc, 'span', '', 'Related'));
  const ask = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary', 'Ask about this'));
  ask.setAttribute('type', 'button');
  ask.addEventListener('click', () => {
    host.setContext([{ attachment: { kind: 'note', path: route.path }, label: title, why: 'active-note' }]);
    go({ view: 'chat' });
  });
  bar.append(back, h(doc, 'span', 'sbw-spacer-x'), openObsidian, toggle, ask);

  const toc = h(doc, 'nav', 'sbw-reader-toc');
  toc.setAttribute('aria-label', 'Contents');
  const article = h(doc, 'article', 'sbw-reader-article');
  const panel = h(doc, 'aside', 'sbw-reader-panel sb-p');
  panel.setAttribute('aria-label', 'Related');
  reader.append(toc, article, panel);
  wrap.replaceChildren(bar, reader);
  const setPanel = (/** @type {boolean} */ on) => {
    reader.classList.toggle('is-panel-open', on);
    toggle.setAttribute('aria-expanded', String(on));
  };
  setPanel(into.clientWidth >= WIDE || win.innerWidth >= WIDE + 224);
  toggle.addEventListener('click', () => setPanel(!reader.classList.contains('is-panel-open')));

  const head = h(doc, 'header', 'sbw-reader-head');
  const heading = h(doc, 'h1', 'sbw-reader-title');
  heading.append(titleNodes(doc, title));
  head.append(heading, h(doc, 'p', 'sbw-reader-venue', folderLabel(route.path)));
  const body = h(doc, 'div', 'sbw-prose sbw-note-body');
  const fragment = noteFragment(doc, html);
  restoreMath(doc, fragment, formulas, mathNode);
  body.append(fragment);
  interceptLinks(body, host);
  // A note often opens with its own title; the header already shows it.
  const first = body.firstElementChild;
  if (first && /^H1$/i.test(first.tagName) && first.textContent?.trim().toLowerCase() === title.toLowerCase()) first.remove();
  article.append(head, body);
  if (note.truncated) article.append(h(doc, 'p', 'sbw-hint', 'This note is very long; only the first part is shown. Open it in Obsidian for the rest.'));

  toc.append(h(doc, 'div', 'sbw-tree-head', 'Contents'));
  const headings = Array.from(body.querySelectorAll('h1, h2, h3'));
  for (const heading of headings) {
    const item = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sbw-toc-item is-level-${heading.tagName.slice(1)}`, heading.textContent ?? ''));
    item.setAttribute('type', 'button');
    item.addEventListener('click', () => heading.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    toc.append(item);
  }
  if (!headings.length) toc.hidden = true;

  const openRef = openRefHandler(win, go);
  const resolveTitle = titleResolver(api);
  const related = RelatedPanel(doc, { fetchJSON: api, open: openRef, linked: false });
  const links = LinksPanel(doc, { fetchJSON: api, open: openRef, resolveTitle });
  panel.append(panelBlock(doc, 'Related', related.el), panelBlock(doc, 'Links', links.el));
  void related.show(route.path);
  void links.show(route.path);
}
