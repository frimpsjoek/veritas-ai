// @ts-check
// ui-src/src/web/browser-panel.js. Spec 015 B3: links open in a panel over the content area, closed like the full
// screen views (a close button, Escape). Three kinds of answer from GET /web/page: the framed page itself, the reader
// view (the readable article, drawn like a note), and a plain card when neither works. A PDF goes to the PDF reader.
import { h } from '../../ui/src/dom.js';
import { icon } from '../../ui/src/icons.js';
import { interceptLinks, isPdfUrl } from '../../ui/src/links.js';
import { noteFragment } from '../../ui/src/sources/view-kit.js';
import { PdfViewer } from './pdf-viewer.js';
import { addressOf, blockedReason, createHistory, fileNameOf, firstPrefer, pageQuery, sourceOf } from './browser-state.js';

const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';

/**
 * @param {{ host: any, doc: Document, win: Window, into: HTMLElement }} o `into` is the shell's content area (position: relative)
 * @returns {{ open(url: string): void, close(): void, readonly isOpen: boolean, el: HTMLElement }}
 */
export function createBrowserPanel({ host, doc, win, into }) {
  const root = h(doc, 'section', 'sbw-browser');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Web page');
  root.hidden = true;
  const bar = h(doc, 'div', 'sbw-browser-bar');
  /** @param {string} name @param {string} label @param {() => void} run */
  const tool = (name, label, run) => {
    const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-browser-tool'));
    b.setAttribute('type', 'button');
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(doc, name, 'sb-p-icon'));
    b.addEventListener('click', run);
    return b;
  };
  const back = tool('back', 'Back', () => { const entry = history.back(); if (entry) void show(entry, false); });
  const where = h(doc, 'div', 'sbw-browser-where');
  const titleEl = h(doc, 'span', 'sbw-browser-title');
  const addressEl = h(doc, 'span', 'sbw-browser-address');
  where.append(titleEl, addressEl);
  const reload = tool('refresh', 'Reload', () => { if (history.current) void show(history.current, false); });
  const modeButton = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-browser-text'));
  modeButton.setAttribute('type', 'button');
  modeButton.hidden = true;
  const outside = tool('open', 'Open in your browser', () => { if (history.current) host.openLink(shownUrl, { outside: true }); });
  const closer = tool('close', 'Close', () => api.close());
  bar.append(back, where, reload, modeButton, outside, closer);
  const body = h(doc, 'div', 'sbw-browser-body');
  root.append(bar, body);
  into.append(root);

  const history = createHistory();
  let shownUrl = '';
  let token = 0;
  /** @type {HTMLElement | null} */ let returnTo = null;

  /** Links inside the reader view stay in the panel; a modified click goes to the system browser. */
  const innerHost = { can: { linksInside: true }, openLink: (/** @type {string} */ url, /** @type {{ outside?: boolean } | undefined} */ opts) => { if (opts?.outside) host.openLink(url, { outside: true }); else api.open(url); } };

  /** @param {string} title @param {string} url @param {string} [source] where the server found this copy */
  function head(title, url, source = '') {
    shownUrl = url;
    titleEl.textContent = title || addressOf(url);
    addressEl.textContent = source ? `${source} · ${addressOf(url)}` : addressOf(url);
    root.dataset.url = url;
    back.disabled = !history.canGoBack;
  }

  /** @param {string} reason @param {string} url @param {string} [title] */
  function card(reason, url, title) {
    head(title ?? '', url);
    modeButton.hidden = true;
    const box = h(doc, 'div', 'sbw-browser-card');
    box.append(h(doc, 'h2', 'sbw-browser-card-title', "This page can't open here"), h(doc, 'p', 'sbw-hint', reason));
    const go = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary', 'Open in your browser'));
    go.setAttribute('type', 'button');
    go.addEventListener('click', () => host.openLink(url, { outside: true }));
    box.append(go);
    body.replaceChildren(box);
  }

  /** @param {import('./browser-state.js').Entry} entry @param {boolean} push */
  async function show(entry, push) {
    const mine = ++token;
    if (push) history.push(entry); else history.replace(entry);
    head('', entry.url);
    modeButton.hidden = true;
    if (isPdfUrl(entry.url) && !entry.prefer) {
      const name = fileNameOf(entry.url);
      head(name, entry.url);
      return pdf(entry.url, name);
    }
    body.replaceChildren(h(doc, 'p', 'sbw-hint sbw-browser-status', 'Opening…'));
    /** @type {any} */ let answer = null;
    /** @type {unknown} */ let failure = null;
    try { answer = await host.json(`/web/page?${pageQuery(entry)}`); } catch (error) { failure = error; }
    if (mine !== token) return;
    if (!answer || answer.mode === 'blocked') return card(blockedReason(answer, failure), answer?.url ?? entry.url, answer?.title);
    head(answer.title, answer.url, sourceOf(answer));
    if (answer.mode === 'pdf') return pdf(answer.url, answer.title);
    if (answer.mode === 'frame') return framed(answer);
    return readerView(answer);
  }

  /** @param {{ url: string, title: string }} page */
  function framed(page) {
    const frame = /** @type {HTMLIFrameElement} */ (h(doc, 'iframe', 'sbw-browser-frame'));
    frame.setAttribute('sandbox', FRAME_SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = page.title;
    frame.src = page.url;
    body.replaceChildren(frame);
    modeButton.hidden = false;
    modeButton.textContent = 'Reader view';
    modeButton.onclick = () => { if (history.current) void show({ url: history.current.url, prefer: 'reader' }, false); };
  }

  /** @param {{ url: string, title: string, html: string, byline?: string }} page */
  function readerView(page) {
    const article = h(doc, 'article', 'sbw-browser-article');
    article.append(h(doc, 'h1', 'sbw-reader-title', page.title));
    if (page.byline) article.append(h(doc, 'p', 'sbw-reader-authors', page.byline));
    const text = h(doc, 'div', 'sbw-prose sbw-note-body');
    text.append(noteFragment(doc, page.html));
    // links in the article are relative to the page; the server already made them absolute
    interceptLinks(text, innerHost);
    article.append(text);
    body.replaceChildren(article);
    body.scrollTop = 0;
    modeButton.hidden = false;
    modeButton.textContent = 'Original page';
    modeButton.onclick = () => { if (history.current) void show({ url: history.current.url }, false); };
  }

  /** @param {string} url @param {string} title */
  function pdf(url, title) {
    modeButton.hidden = true;
    // /web/page already fetched this and saw a PDF, so there is no probe; PDF.js reports a later failure through `ready`
    const src = `${win.location.origin}/web/pdf?${new URLSearchParams({ url })}`;
    const problem = h(doc, 'p', 'sbw-hint sbw-pdf-problem');
    problem.hidden = true;
    const viewer = PdfViewer(doc, win, {
      src, title: title || 'PDF', marks: [], openRaw: () => host.openLink(url, { outside: true }),
      failed: (message) => { problem.textContent = message; problem.hidden = false; },
    });
    body.replaceChildren(viewer.el, problem);
    viewer.ready.catch((error) => card(`PDF.js couldn't open it (${error?.message ?? error}).`, url, title));
  }

  const onKey = (/** @type {KeyboardEvent} */ event) => { if (event.key === 'Escape' && !root.hidden) api.close(); };
  doc.addEventListener('keydown', onKey);

  const api = {
    el: root,
    get isOpen() { return !root.hidden; },
    /** @param {string} url */
    open(url) {
      if (root.hidden) { returnTo = /** @type {HTMLElement | null} */ (doc.activeElement); history.clear(); }
      root.hidden = false;
      void show({ url, prefer: firstPrefer(url, win.location.protocol) }, true);
    },
    close() {
      token++;
      root.hidden = true;
      history.clear();
      body.replaceChildren();
      returnTo?.focus?.();
      returnTo = null;
    },
  };
  return api;
}
