// @ts-check
// ui-src/src/web/pdf-viewer.js. The paper reader's PDF (spec 014 G3): PDF.js (vendored, src/web/vendor/pdfjs) draws each
// page when it nears the screen, with a text layer for selecting. Selecting text on one page opens a bar with Zotero's
// eight colours and a comment box; a colour draws the highlight at once and hands it to `save`, which queues it for
// Zotero. Highlights already in Zotero, and those still waiting for it, are drawn on their pages.
import { h } from '../../ui/src/dom.js';
import { ZOTERO_COLORS, buildHighlight, toPageBox } from './pdf-geometry.js';

/** @typedef {import('./pdf-geometry.js').HighlightJSON} HighlightJSON */
/** @typedef {import('./pdf-geometry.js').PdfPosition} PdfPosition */
/** @typedef {import('./pdf-geometry.js').Transform} Transform */
/** @typedef {import('./pdf-geometry.js').Box} Box */
/** A highlight drawn on the PDF: in Zotero already, or queued for it. @typedef {{ color: string, position: PdfPosition, waiting: boolean, text?: string }} Mark */
/** @typedef {{ status: 'added' | 'queued' }} SaveResult */
/**
 * What a selection was when the bar opened; kept, since typing a comment clears the selection.
 * @typedef {{ pageIndex: number, text: string, boxes: Box[], offset: number }} Picked
 */

const MAX_WIDTH = 1000;
const WAITING = 'Waiting for Zotero';

/** @type {Promise<any> | null} */ let pdfjs = null;
/** PDF.js, loaded the first time a PDF opens; build-web.mjs copies its files beside the app under hashed names. */
function loadPdfjs() {
  pdfjs ??= (async () => {
    const lib = await import(new URL(SB_PDFJS.lib, import.meta.url).href);
    lib.GlobalWorkerOptions.workerSrc = new URL(SB_PDFJS.worker, import.meta.url).href;
    return lib;
  })();
  pdfjs.catch(() => { pdfjs = null; });
  return pdfjs;
}

/** The selection's first character within the page's text, counted over the text layer's text nodes. @param {Element} layer @param {Range} range */
function textOffset(layer, range) {
  let start = range.startContainer;
  let within = range.startOffset;
  if (start.nodeType !== 3) {
    const child = start.childNodes[range.startOffset] ?? start;
    const walker = layer.ownerDocument.createTreeWalker(child, NodeFilter.SHOW_TEXT);
    start = walker.nextNode() ?? start;
    within = 0;
  }
  const walker = layer.ownerDocument.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === start) return offset + within;
    offset += node.textContent?.length ?? 0;
  }
  return 0;
}

/**
 * @param {Document} doc @param {Window} win
 * @param {{ src: string, title: string, openRaw?: () => void, marks: Mark[], save: (json: HighlightJSON) => Promise<SaveResult>, failed: (message: string) => void }} o
 * @returns {{ el: HTMLElement, ready: Promise<void> }}
 */
export function PdfViewer(doc, win, o) {
  const el = h(doc, 'div', 'sbw-pdf');
  const bar = h(doc, 'div', 'sbw-pdf-bar');
  const status = h(doc, 'span', 'sbw-pdf-status', 'Loading the PDF…');
  status.setAttribute('aria-live', 'polite');
  const raw = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-quiet sbw-pdf-open', 'Open PDF'));
  raw.href = o.src;
  raw.rel = 'noopener';
  raw.addEventListener('click', (event) => { if (!o.openRaw) return; event.preventDefault(); o.openRaw(); });
  bar.append(status, h(doc, 'span', 'sbw-spacer-x'), raw);
  const pagesEl = h(doc, 'div', 'sbw-pdf-pages');
  pagesEl.setAttribute('aria-label', o.title);
  el.append(bar, pagesEl);

  const marks = [...o.marks];
  /** @type {any} */ let pdf = null;
  /** @type {any} */ let lib = null;
  /** @type {{ el: HTMLElement, canvas: HTMLCanvasElement, marksEl: HTMLElement, textEl: HTMLElement, base: { width: number, height: number }, transform: Transform | null, viewBox: number[], label: string, drawn: number, gen: number }[]} */
  const pages = [];
  let width = 0;

  const say = () => {
    const waiting = marks.filter((m) => m.waiting).length;
    status.textContent = waiting ? `${waiting} highlight${waiting === 1 ? '' : 's'} waiting for Zotero` : 'Select text to highlight it.';
  };

  const drawMarks = (/** @type {number} */ index) => {
    const page = pages[index];
    if (!page?.transform) return;
    const transform = page.transform;
    page.marksEl.replaceChildren(...marks.filter((m) => m.position.pageIndex === index).flatMap((m) => m.position.rects.map((rect) => {
      const box = toPageBox(rect, transform);
      const mark = h(doc, 'div', `sbw-pdf-mark${m.waiting ? ' is-waiting' : ''}`);
      Object.assign(mark.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
      mark.style.setProperty('--sbw-mark', m.color || ZOTERO_COLORS[0].hex);
      if (m.waiting) mark.title = WAITING;
      return mark;
    })));
  };

  const render = async (/** @type {number} */ index) => {
    const page = pages[index];
    if (page.drawn === width) return;
    const gen = ++page.gen;
    page.drawn = width;
    const pdfPage = await pdf.getPage(index + 1);
    if (gen !== page.gen) return;
    const unit = pdfPage.getViewport({ scale: 1 });
    page.base = { width: unit.width, height: unit.height };
    const viewport = pdfPage.getViewport({ scale: width / unit.width });
    const ratio = win.devicePixelRatio || 1;
    page.el.style.width = `${viewport.width}px`;
    page.el.style.height = `${viewport.height}px`;
    page.el.style.setProperty('--scale-factor', String(viewport.scale));
    page.el.style.setProperty('--total-scale-factor', String(viewport.scale * (pdfPage.userUnit || 1)));
    page.transform = viewport.transform;
    page.viewBox = pdfPage.view;
    page.canvas.width = Math.floor(viewport.width * ratio);
    page.canvas.height = Math.floor(viewport.height * ratio);
    page.canvas.style.width = `${viewport.width}px`;
    page.canvas.style.height = `${viewport.height}px`;
    drawMarks(index);
    await pdfPage.render({ canvasContext: page.canvas.getContext('2d'), viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise;
    if (gen !== page.gen) return;
    const textEl = h(doc, 'div', 'textLayer');
    await new lib.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: textEl, viewport }).render();
    if (gen !== page.gen) return;
    page.textEl.replaceWith(textEl);
    page.textEl = textEl;
    page.el.classList.add('is-drawn');
  };

  const near = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const index = Number(/** @type {HTMLElement} */ (entry.target).dataset.pageIndex);
      render(index).catch((error) => { status.textContent = `Couldn't draw page ${index + 1}: ${error?.message ?? error}`; });
    }
  }, { rootMargin: '800px 0px' });

  /** Sizes every page for the current width (pages not drawn yet take the first page's shape) and draws those in view again. */
  const layout = () => {
    const next = Math.floor(Math.min(pagesEl.clientWidth, MAX_WIDTH));
    if (!next || Math.abs(next - width) < 2) return;
    width = next;
    for (const page of pages) {
      page.el.style.width = `${width}px`;
      page.el.style.height = `${(width * page.base.height) / page.base.width}px`;
      near.unobserve(page.el);
      near.observe(page.el);
    }
  };

  // ---- the highlight bar
  const tools = h(doc, 'div', 'sbw-hl-bar');
  tools.hidden = true;
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'Highlight');
  const swatches = h(doc, 'div', 'sbw-hl-swatches');
  const comment = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-input sbw-hl-comment'));
  comment.type = 'text';
  comment.placeholder = 'Comment (optional)';
  comment.setAttribute('aria-label', 'Comment');
  for (const { name, hex } of ZOTERO_COLORS) {
    const swatch = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-hl-swatch'));
    swatch.type = 'button';
    swatch.style.setProperty('--sbw-mark', hex);
    swatch.setAttribute('aria-label', `Highlight in ${name.toLowerCase()}`);
    swatch.dataset.color = hex;
    swatch.title = name;
    // keep the text selected while the button is pressed
    swatch.addEventListener('mousedown', (event) => event.preventDefault());
    swatch.addEventListener('click', () => { void create(hex); });
    swatches.append(swatch);
  }
  tools.append(swatches, comment);
  el.append(tools);

  /** @type {Picked | null} */ let picked = null;
  /** @type {string} */ let lastColor = ZOTERO_COLORS[0].hex;
  const close = () => { tools.hidden = true; picked = null; comment.value = ''; };
  comment.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void create(lastColor); }
    if (event.key === 'Escape') close();
  });

  /** The selection, if it lies on one page's text. @returns {{ picked: Picked, last: DOMRect } | null} */
  const readSelection = () => {
    const selection = win.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    const startNode = range.startContainer.nodeType === 1 ? /** @type {Element} */ (range.startContainer) : range.startContainer.parentElement;
    const endNode = range.endContainer.nodeType === 1 ? /** @type {Element} */ (range.endContainer) : range.endContainer.parentElement;
    const pageEl = startNode?.closest('.sbw-pdf-page');
    if (!pageEl || !pagesEl.contains(pageEl) || endNode?.closest('.sbw-pdf-page') !== pageEl) return null;
    const index = Number(/** @type {HTMLElement} */ (pageEl).dataset.pageIndex);
    const page = pages[index];
    const origin = pageEl.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0
      && r.right > origin.left && r.left < origin.right && r.bottom > origin.top && r.top < origin.bottom);
    if (!rects.length || !page.transform) return null;
    const boxes = rects.map((r) => ({ left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top }));
    return { picked: { pageIndex: index, text: selection.toString(), boxes, offset: textOffset(page.textEl, range) }, last: rects[rects.length - 1] };
  };

  let timer = 0;
  /** @type {ResizeObserver | null} */ let resized = null;
  const selected = () => {
    win.clearTimeout(timer);
    timer = win.setTimeout(() => {
      if (!el.isConnected) {
        doc.removeEventListener('selectionchange', selected);
        near.disconnect();
        resized?.disconnect();
        return;
      }
      if (tools.contains(doc.activeElement)) return; // typing a comment clears the selection; the bar keeps what it picked
      const found = readSelection();
      if (!found) { if (!tools.hidden) close(); return; }
      picked = found.picked;
      tools.hidden = false;
      const frame = el.getBoundingClientRect();
      const left = Math.max(0, Math.min(found.last.left - frame.left, frame.width - tools.offsetWidth));
      tools.style.left = `${left}px`;
      tools.style.top = `${found.last.bottom - frame.top + 8}px`;
    }, 120);
  };
  doc.addEventListener('selectionchange', selected);

  /** @param {string} color */
  const create = async (color) => {
    const chosen = picked;
    const page = chosen && pages[chosen.pageIndex];
    if (!chosen || !page?.transform) return;
    lastColor = color;
    const json = buildHighlight({ ...chosen, comment: comment.value, color, pageLabel: page.label, transform: page.transform, viewBox: page.viewBox });
    close();
    win.getSelection()?.removeAllRanges();
    if (!json) return;
    /** @type {Mark} */ const mark = { color, position: json.position, waiting: true, text: json.text };
    marks.push(mark);
    drawMarks(chosen.pageIndex);
    say();
    try {
      const result = await o.save(json);
      mark.waiting = result.status !== 'added';
    } catch (error) {
      marks.splice(marks.indexOf(mark), 1);
      o.failed(`Couldn't save the highlight: ${/** @type {any} */ (error)?.message ?? error}`);
    }
    drawMarks(chosen.pageIndex);
    say();
  };

  const ready = (async () => {
    lib = await loadPdfjs();
    pdf = await lib.getDocument({ url: o.src, isEvalSupported: false }).promise;
    const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const labels = /** @type {string[] | null} */ (await pdf.getPageLabels().catch(() => null));
    for (let index = 0; index < pdf.numPages; index += 1) {
      const pageEl = h(doc, 'div', 'sbw-pdf-page');
      pageEl.dataset.pageIndex = String(index);
      const canvas = /** @type {HTMLCanvasElement} */ (h(doc, 'canvas', 'sbw-pdf-canvas'));
      const marksEl = h(doc, 'div', 'sbw-pdf-marks');
      const textEl = h(doc, 'div', 'textLayer');
      pageEl.append(canvas, marksEl, textEl);
      pagesEl.append(pageEl);
      pages.push({ el: pageEl, canvas, marksEl, textEl, base: { width: first.width, height: first.height }, transform: null, viewBox: [0, 0, first.width, first.height], label: labels?.[index] || String(index + 1), drawn: 0, gen: 0 });
    }
    say();
    layout();
    const observer = new ResizeObserver(() => layout());
    observer.observe(pagesEl);
    resized = observer;
  })();
  ready.catch(() => { status.textContent = ''; });
  return { el, ready };
}
