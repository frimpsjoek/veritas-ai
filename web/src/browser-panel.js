// @ts-check
// ui-src/src/web/browser-panel.js. Spec 015 B3: links open in a panel over the content area, closed like the full
// screen views (a close button, Escape). Three kinds of answer from GET /web/page: the framed page itself, the reader
// view (the readable article, drawn like a note), and a plain card when neither works. A PDF goes to the PDF reader.
import { h } from '../../ui/src/dom.js';
import { icon } from '../../ui/src/icons.js';
import { interceptLinks, isPdfUrl } from '../../ui/src/links.js';
import { noteFragment } from '../../ui/src/sources/view-kit.js';
import { PdfViewer } from './pdf-viewer.js';
import { mathNode } from '../../ui/src/chat/markdown.js';
import { addressOf, blockedReason, createHistory, fileNameOf, firstPrefer, mathParts, pageQuery, readerPlan, sourceOf, stepBack } from './browser-state.js';

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
  const back = tool('back', 'Back', () => { const step = stepBack(history); if ('show' in step) void show(step.show, false); else api.close(); });
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
    // on the first page ← closes the panel, so it is never greyed out
    back.title = history.canGoBack ? 'Back' : 'Back (close)';
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

  /** @param {{ url: string, title: string, html: string, byline?: string, abstract?: string, math?: boolean }} page */
  function readerView(page) {
    const plan = readerPlan(page);
    // inline TeX ($…$, \(…\)) drawn as MathML, only for answers the server marked as having math
    const words = (/** @type {string} */ value) => plan.math ? withMath(value) : doc.createTextNode(value);
    const article = h(doc, 'article', plan.articleClass);
    const top = h(doc, 'header', 'sbw-reader-head');
    const heading = h(doc, 'h1', 'sbw-reader-title');
    heading.append(words(plan.title));
    top.append(heading);
    if (plan.byline) top.append(h(doc, 'p', 'sbw-reader-authors', plan.byline));
    if (plan.meta) top.append(h(doc, 'p', 'sbw-reader-venue', plan.meta));
    if (plan.subjects.length) {
      const chips = h(doc, 'p', 'sbw-reader-chips');
      for (const s of plan.subjects) {
        const chip = h(doc, 'span', `sbw-reader-chip${s.primary ? ' is-primary' : ''}`, s.label);
        if (s.code && s.code !== s.label) chip.title = s.code;
        chips.append(chip);
      }
      top.append(chips);
    }
    if (plan.links.length || plan.citation) {
      const row = h(doc, 'p', 'sbw-reader-links');
      for (const link of plan.links) {
        const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet', link.label));
        b.setAttribute('type', 'button');
        b.title = link.outside ? `${addressOf(link.url)} (opens in your browser)` : addressOf(link.url);
        // the PDF goes to the PDF reader and the full text to this reader, both in the panel (Back returns here); a
        // publisher's page goes to the system browser, since publishers refuse to load here (bot protection)
        if (link.outside) b.append(icon(doc, 'open', 'sb-p-icon sbw-reader-out'));
        b.addEventListener('click', () => (link.outside ? host.openLink(link.url, { outside: true }) : api.open(link.url)));
        row.append(b);
      }
      if (plan.citation) {
        const cite = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-quiet', 'Copy citation'));
        cite.setAttribute('type', 'button');
        cite.title = plan.citation;
        cite.prepend(icon(doc, 'quote', 'sb-p-icon sbw-reader-cite'));
        cite.addEventListener('click', () => copyText(plan.citation, 'Citation copied'));
        row.append(cite);
      }
      top.append(row);
    }
    article.append(top);
    // a paper's graphical abstract, only when the figure finder (Home's /paper-figure: the publisher page's preview
    // image when that page answers, or a figure at a known address) has a real one; nothing is drawn while it looks
    if (plan.landing && plan.doi) figureOf(plan.doi, top);
    const text = h(doc, 'div', 'sbw-note-body');
    if (plan.abstractHtml) {
      text.append(h(doc, 'h2', 'sbw-reader-label', plan.abstractLabel), noteFragment(doc, plan.abstractHtml, host));
    } else if (plan.abstract) {
      const abstract = h(doc, 'p');
      abstract.append(words(plan.abstract));
      text.append(h(doc, 'h2', 'sbw-reader-label', plan.abstractLabel), abstract);
    }
    text.append(noteFragment(doc, plan.html, host));
    if (plan.math) drawMath(text);
    // links in the article are relative to the page; the server already made them absolute
    interceptLinks(text, innerHost);
    article.append(text);
    if (plan.landing) article.append(landingFoot(plan));
    body.replaceChildren(article);
    body.scrollTop = 0;
    // a paper's landing page has its publisher's page as a button already (and ↗ in the bar)
    modeButton.hidden = plan.landing;
    modeButton.textContent = 'Original page';
    // a paper answer comes back for its own address whatever is asked (arXiv refuses frames), so its page opens outside
    modeButton.onclick = plan.paper
      ? () => host.openLink(page.url, { outside: true })
      : () => { if (history.current) void show({ url: history.current.url }, false); };
  }

  /** Under a paper's abstract: its DOI, and that only the abstract is open here, with the publisher's page (outside).
   *  @param {ReturnType<typeof readerPlan>} plan */
  function landingFoot(plan) {
    const foot = h(doc, 'footer', 'sbw-reader-foot');
    /** @param {string} label @param {string} url */
    const outsideLink = (label, url) => {
      const a = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-reader-out-link', label));
      a.href = url;
      a.rel = 'noopener noreferrer';
      a.append(icon(doc, 'open', 'sb-p-icon sbw-reader-out'));
      a.addEventListener('click', (event) => { event.preventDefault(); host.openLink(url, { outside: true }); });
      return a;
    };
    if (plan.doi) {
      const line = h(doc, 'p', 'sbw-reader-doi-line', 'DOI ');
      line.append(outsideLink(plan.doi, plan.doiUrl));
      foot.append(line);
    }
    const publisher = plan.links.find((l) => l.outside)?.url || plan.doiUrl;
    if (publisher) {
      const note = h(doc, 'p', 'sbw-reader-access', 'Only the abstract is open here. ');
      note.append(outsideLink('Read it on the publisher\u2019s page', publisher));
      foot.append(note);
    }
    return foot;
  }

  /** @param {string} doi @param {HTMLElement} after */
  function figureOf(doi, after) {
    const mine = token;
    host.json(`/paper-figure?${new URLSearchParams({ doi })}`).then((/** @type {any} */ found) => {
      if (mine !== token || !found?.image || !/^(https?:\/\/|data:image\/)/i.test(String(found.image))) return;
      const box = h(doc, 'figure', 'sbw-reader-figure');
      box.hidden = true;
      const img = /** @type {HTMLImageElement} */ (h(doc, 'img'));
      img.alt = 'Graphical abstract';
      img.referrerPolicy = 'no-referrer';
      img.decoding = 'async';
      img.addEventListener('load', () => { box.hidden = false; }, { once: true });
      img.addEventListener('error', () => box.remove(), { once: true });
      img.src = String(found.image);
      box.append(img);
      after.after(box);
    }, () => {});
  }

  /** @param {string} value @param {string} done */
  function copyText(value, done) {
    const clip = /** @type {any} */ (win.navigator)?.clipboard;
    if (!clip?.writeText) { host.notice("Couldn't copy here; the citation is in the button's tooltip."); return; }
    clip.writeText(value).then(() => host.notice(done), () => host.notice("Couldn't copy the citation."));
  }

  /** Draws the TeX in the reader's text nodes (not in code). @param {HTMLElement} root */
  function drawMath(root) {
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    /** @type {Text[]} */ const found = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (/[$\\]/.test(node.nodeValue ?? '') && !node.parentElement?.closest('code, pre')) found.push(/** @type {Text} */ (node));
    }
    for (const node of found) node.replaceWith(withMath(node.nodeValue ?? ''));
  }

  /** A text with its TeX drawn as MathML (KaTeX, as in chat). @param {string} text */
  function withMath(text) {
    const out = doc.createDocumentFragment();
    for (const part of mathParts(text)) out.append('tex' in part ? mathNode(doc, part.tex, false) : part.text);
    return out;
  }

  /** @param {string} url @param {string} title */
  function pdf(url, title) {
    modeButton.hidden = true;
    // /web/page already fetched this and saw a PDF, so there is no probe; PDF.js reports a later failure through `ready`
    const path = `/web/pdf?${new URLSearchParams({ url })}`;
    const src = `${host.server.url}${path}`;
    const problem = h(doc, 'p', 'sbw-hint sbw-pdf-problem');
    problem.hidden = true;
    const viewer = PdfViewer(doc, win, {
      // from another origin PDF.js gets the bytes, fetched with the token (no cookie goes there)
      src, data: host.server.sameOrigin ? undefined : host.assets.bytes(path),
      title: title || 'PDF', marks: [], openRaw: () => host.openLink(url, { outside: true }),
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
