// @ts-check
// ui/src/image-viewer.js. Spec 029 R12: a picture full screen over the page. Wheel or trackpad zooms at the pointer,
// + and − (buttons or keys) zoom at the centre, a two-finger pinch zooms on a touch screen, a drag pans, a
// double-click toggles fit and 2×, 0 / Fit fits it, 1:1 shows it at its own size, the arrows pan, "Open original" opens
// the image address through the host. Escape, the close button or a click on the dark backdrop closes it and puts focus
// back where it was. The math is in image-viewer-data.js.
import { h } from './dom.js';
import { icon } from './icons.js';
import { clampView, fitView, panBy, percent, wheelFactor, zoomAt, STEP } from './image-viewer-data.js';

/** @typedef {import("./image-viewer-data.js").View} View */

/** How far a drag may move before a press on the backdrop no longer counts as a click that closes. */
const CLICK_SLOP = 4;
/** One arrow press pans this many screen pixels. */
const ARROW_STEP = 60;

/**
 * Opens `src` full screen. Returns `close`, which the caller may also call.
 * @param {Document} doc
 * @param {{ src: string, alt?: string, open: (url: string) => void }} picture `open` opens the original (the host's openLink)
 * @returns {{ close(): void, root: HTMLElement }}
 */
export function openImageViewer(doc, picture) {
  const win = /** @type {Window} */ (doc.defaultView);
  const before = /** @type {HTMLElement | null} */ (doc.activeElement);
  const root = h(doc, 'div', 'sb-iv');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', picture.alt || 'Picture');
  root.tabIndex = -1;

  const stage = h(doc, 'div', 'sb-iv-stage');
  const img = /** @type {HTMLImageElement} */ (h(doc, 'img', 'sb-iv-img'));
  img.alt = picture.alt ?? '';
  img.draggable = false;
  img.referrerPolicy = 'no-referrer';
  stage.append(img);

  const bar = h(doc, 'div', 'sb-iv-bar');
  /** @param {string} cls @param {string} label @param {Node | string} face @param {() => void} run */
  const button = (cls, label, face, run) => {
    const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sb-iv-btn ${cls}`));
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(face);
    b.addEventListener('click', (event) => { event.stopPropagation(); run(); });
    return b;
  };
  const level = h(doc, 'span', 'sb-iv-level');
  level.setAttribute('aria-live', 'polite');
  const out = button('sb-iv-out', 'Zoom out', '−', () => zoom(1 / STEP, null));
  const into = button('sb-iv-in', 'Zoom in', '+', () => zoom(STEP, null));
  const fit = button('sb-iv-fit', 'Fit to screen', 'Fit', () => set(fitView(size(), stageSize())));
  const actual = button('sb-iv-actual', 'Actual size', '1:1', () => set(clampView({ scale: 1, x: 0, y: 0 }, size(), stageSize())));
  const original = button('sb-iv-original', 'Open original', icon(doc, 'open', 'sb-p-icon'), () => picture.open(picture.src));
  const shut = button('sb-iv-close', 'Close', icon(doc, 'close', 'sb-p-icon'), () => close());
  bar.append(out, level, into, fit, actual, original, shut);
  root.append(stage, bar);

  /** @type {View} */ let view = { scale: 1, x: 0, y: 0 };
  let fitted = true; // follows the window's size until the person zooms or pans
  const size = () => ({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
  const stageSize = () => ({ width: stage.clientWidth || win.innerWidth, height: stage.clientHeight || win.innerHeight });
  const paint = () => {
    img.style.transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    level.textContent = percent(view.scale);
    root.classList.toggle('is-pannable', view.scale * size().width > stageSize().width + 1 || view.scale * size().height > stageSize().height + 1);
  };
  /** @param {View} next */
  const set = (next) => { view = next; fitted = false; paint(); };
  /** @param {number} factor @param {{ x: number, y: number } | null} at stage point from its centre */
  const zoom = (factor, at) => set(zoomAt(view, factor, at, size(), stageSize()));
  /** A client point as a point from the stage's centre. @param {number} cx @param {number} cy */
  const fromCentre = (cx, cy) => {
    const r = stage.getBoundingClientRect();
    return { x: cx - (r.left + r.width / 2), y: cy - (r.top + r.height / 2) };
  };

  img.addEventListener('load', () => {
    img.style.width = `${img.naturalWidth}px`;
    img.style.height = `${img.naturalHeight}px`;
    view = fitView(size(), stageSize());
    fitted = true;
    paint();
    root.classList.add('is-ready');
  }, { once: true });
  img.addEventListener('error', () => { root.classList.add('is-broken'); stage.append(h(doc, 'p', 'sb-iv-error', "Couldn't load this picture.")); }, { once: true });
  img.src = picture.src;

  stage.addEventListener('wheel', (event) => {
    event.preventDefault();
    zoom(wheelFactor(event.deltaY, event.deltaMode), fromCentre(event.clientX, event.clientY));
  }, { passive: false });

  // one pointer pans, two pinch; a press that hardly moved on the backdrop closes
  /** @type {Map<number, { x: number, y: number }>} */ const pointers = new Map();
  let moved = 0;
  /** @type {{ distance: number, view: View, mid: { x: number, y: number } } | null} */ let pinch = null;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2) };
  };
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) moved = 0;
    if (pointers.size === 2) { const s = spread(); pinch = { distance: s.distance, view, mid: s.mid }; }
    root.classList.add('is-dragging');
  });
  stage.addEventListener('pointermove', (event) => {
    const was = pointers.get(event.pointerId);
    if (!was) return;
    const now = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, now);
    if (pinch && pointers.size === 2) {
      const s = spread();
      if (pinch.distance > 0) set(zoomAt(pinch.view, s.distance / pinch.distance, pinch.mid, size(), stageSize()));
      moved += CLICK_SLOP + 1;
      return;
    }
    moved += Math.abs(now.x - was.x) + Math.abs(now.y - was.y);
    if (moved > CLICK_SLOP) set(panBy(view, now.x - was.x, now.y - was.y, size(), stageSize()));
  });
  const lift = (/** @type {PointerEvent} */ event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!pointers.size) root.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', (event) => {
    const onBackdrop = event.target === stage;
    lift(event);
    if (onBackdrop && moved <= CLICK_SLOP && !pointers.size) close();
  });
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('dblclick', (event) => {
    event.preventDefault();
    const fitNow = fitView(size(), stageSize());
    if (view.scale > fitNow.scale * 1.05) set(fitNow);
    else set(zoomAt(view, (fitNow.scale * 2) / view.scale, fromCentre(event.clientX, event.clientY), size(), stageSize()));
  });

  /** @param {KeyboardEvent} event */
  const onKey = (event) => {
    const keys = /** @type {Record<string, () => void>} */ ({
      Escape: () => close(),
      '+': () => zoom(STEP, null), '=': () => zoom(STEP, null), '-': () => zoom(1 / STEP, null), _: () => zoom(1 / STEP, null),
      0: () => set(fitView(size(), stageSize())), 1: () => set(clampView({ scale: 1, x: 0, y: 0 }, size(), stageSize())),
      ArrowLeft: () => set(panBy(view, ARROW_STEP, 0, size(), stageSize())), ArrowRight: () => set(panBy(view, -ARROW_STEP, 0, size(), stageSize())),
      ArrowUp: () => set(panBy(view, 0, ARROW_STEP, size(), stageSize())), ArrowDown: () => set(panBy(view, 0, -ARROW_STEP, size(), stageSize())),
    });
    const run = keys[event.key];
    if (run && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); event.stopPropagation(); run(); return; }
    // keep Tab inside the viewer
    if (event.key === 'Tab') {
      const stops = Array.from(bar.querySelectorAll('button'));
      const i = stops.indexOf(/** @type {HTMLButtonElement} */ (doc.activeElement));
      event.preventDefault();
      stops[(i + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
    }
  };
  root.addEventListener('keydown', onKey);
  const onResize = () => { if (fitted) { view = fitView(size(), stageSize()); paint(); } else set(clampView(view, size(), stageSize())); };
  win.addEventListener('resize', onResize);

  // A web page has a <body>; Zotero's main window is a XUL document without one, so the viewer goes on its root.
  const body = /** @type {HTMLElement} */ (doc.body ?? doc.documentElement);
  const overflow = body.style.overflow;
  body.style.overflow = 'hidden';
  body.append(root);
  shut.focus();

  let open = true;
  function close() {
    if (!open) return;
    open = false;
    win.removeEventListener('resize', onResize);
    root.remove();
    body.style.overflow = overflow;
    before?.focus?.();
  }
  return { close, root };
}
