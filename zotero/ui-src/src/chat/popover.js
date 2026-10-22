// @ts-check
// ui-src/src/chat/popover.js. The one small floating menu the artifact panel uses for its version menu, download
// menu, sort menu, the "Artifacts (N)" list and the citation-chip popover. It sits inside `container` (which must
// be position: relative), just under `anchor`, stays inside the container's edges, and closes on an outside press
// or Escape. Only one is open at a time per container.
import { h } from '../dom.js';
import { icon } from '../icons.js';

const OPEN = new WeakMap();

/**
 * @param {Document} doc @param {HTMLElement} container @param {HTMLElement} anchor
 * @param {(pop: HTMLElement, close: () => void) => void} fill builds the popover's content
 * @param {{ className?: string, onClose?: () => void, above?: boolean }} [opts] `above`: open over the anchor (a composer at the bottom of the pane), if it fits there
 * @returns {{ el: HTMLElement, close: () => void, place: () => void }} `place` re-places the menu after its content changed size
 */
export function openPopover(doc, container, anchor, fill, opts = {}) {
  OPEN.get(container)?.();
  const pop = h(doc, 'div', `sb-art-pop${opts.className ? ` ${opts.className}` : ''}`);
  pop.setAttribute('role', 'menu');
  const close = () => {
    if (OPEN.get(container) === close) OPEN.delete(container);
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    pop.remove();
    opts.onClose?.();
  };
  const onOutside = (/** @type {Event} */ event) => {
    const target = /** @type {Node} */ (event.target);
    if (!pop.contains(target) && !anchor.contains(target)) close();
  };
  const onKey = (/** @type {KeyboardEvent} */ event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  fill(pop, close);
  container.append(pop);
  const place = () => {
    const box = container.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    const room = box.width - 16;
    pop.style.maxWidth = `${Math.max(200, room)}px`;
    const width = pop.offsetWidth;
    const left = Math.min(Math.max(8, at.left - box.left), Math.max(8, box.width - width - 8));
    pop.style.left = `${left}px`;
    const below = at.bottom - box.top + 4;
    const fitsAbove = at.top - pop.offsetHeight - 4 >= 8; // in the window, not the container: a composer's menu may rise out of its box
    pop.style.top = `${opts.above && fitsAbove ? at.top - box.top - pop.offsetHeight - 4 : below}px`;
  };
  place();
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKey, true);
  OPEN.set(container, close);
  return { el: pop, close, place };
}

/** One row of a menu: an optional check mark, the label, and a quiet second line. Clicking runs `onClick` and
 *  closes the menu. @param {Document} doc @param {{ label: string, hint?: string, icon?: string, selected?: boolean, disabled?: boolean, onClick: () => void }} item @param {() => void} close */
export function menuItem(doc, item, close) {
  const row = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sb-art-item${item.selected ? ' is-selected' : ''}`));
  row.setAttribute('type', 'button');
  row.setAttribute('role', 'menuitem');
  row.disabled = Boolean(item.disabled);
  if (item.icon) row.append(icon(doc, item.icon, 'sb-ai-icon'));
  const text = h(doc, 'span', 'sb-art-item-text');
  text.append(h(doc, 'span', 'sb-art-item-label', item.label));
  if (item.hint) text.append(h(doc, 'span', 'sb-art-item-hint', item.hint));
  row.append(text);
  row.addEventListener('click', (event) => { event.stopPropagation(); close(); item.onClick(); });
  return row;
}

const SHEETS = new WeakMap();

/**
 * A full sheet over `container` (which must be position: relative) for narrow screens: a back button and a title,
 * then the content, scrolling inside. Filters and Columns use it below 560 px where a popover would not fit
 * (spec 007 §4 "Widths"). Escape or the back button closes it.
 * @param {Document} doc @param {HTMLElement} container @param {string} title
 * @param {(body: HTMLElement, close: () => void) => void} fill @param {{ className?: string, onClose?: () => void }} [opts]
 * @returns {{ el: HTMLElement, close: () => void }}
 */
export function openSheet(doc, container, title, fill, opts = {}) {
  SHEETS.get(container)?.();
  const sheet = h(doc, 'div', `sb-art-sheet${opts.className ? ` ${opts.className}` : ''}`);
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', title);
  const close = () => {
    if (SHEETS.get(container) === close) SHEETS.delete(container);
    doc.removeEventListener('keydown', onKey, true);
    sheet.remove();
    opts.onClose?.();
  };
  const onKey = (/** @type {KeyboardEvent} */ event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  const head = h(doc, 'div', 'sb-art-sheet-head');
  const back = h(doc, 'button', 'sb-art-back');
  back.setAttribute('type', 'button');
  back.append(icon(doc, 'back', 'sb-ai-icon'), h(doc, 'span', '', 'Back'));
  back.addEventListener('click', close);
  head.append(back, h(doc, 'span', 'sb-art-sheet-title', title));
  const body = h(doc, 'div', 'sb-art-sheet-body');
  fill(body, close);
  sheet.append(head, body);
  container.append(sheet);
  doc.addEventListener('keydown', onKey, true);
  SHEETS.set(container, close);
  return { el: sheet, close };
}
