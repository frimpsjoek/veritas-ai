// @ts-check
// ui-src/src/paper-menu.js. Right-click (or long-press) on a paper anywhere it is listed — Home, a digest or papers
// table, Library, a Browse tab — opens one menu: Open, Open in your browser, Copy link, Copy title and link, Share….
// Share opens the system's share menu where the browser engine has one (navigator.share), else copies the title and
// link. What the menu hands over is decided in paper-share.js.
import { h } from './dom.js';
import { menuItem } from './chat/popover.js';
import { menuItems, paperLink, shareText, shareOutcome } from './paper-share.js';

/** @typedef {import('./paper-share.js').SharedPaper} SharedPaper */
/** `say` replaces the line at the bottom of the window, for a place where something covers it (Browse's page).
 *  @typedef {{ openLink?: (url: string, opts?: { outside?: boolean }) => void, say?: (message: string) => void }} PaperMenuHost */

/** Puts `text` on the clipboard: the async clipboard first, else a hidden textarea and copy (Zotero's panes, older
 *  WebKit). @param {Document} doc @param {string} text @returns {Promise<boolean>} */
export async function copyText(doc, text) {
  try {
    await doc.defaultView?.navigator.clipboard.writeText(text);
    return true;
  } catch { /* falls through */ }
  const area = /** @type {HTMLTextAreaElement} */ (doc.createElementNS('http://www.w3.org/1999/xhtml', 'textarea'));
  area.value = text;
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  (doc.body ?? doc.documentElement).append(area);
  area.select();
  let ok = false;
  try { ok = doc.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

/** The system share menu with the paper's title and link, else a copy of both.
 *  @param {Document} doc @param {SharedPaper} paper @returns {Promise<import('./paper-share.js').ShareResult>} */
export async function sharePaper(doc, paper) {
  const text = shareText(paper);
  const url = paperLink(paper);
  if (!text || !url) return 'failed';
  const nav = /** @type {any} */ (doc.defaultView?.navigator);
  if (typeof nav?.share === 'function') {
    try {
      await nav.share({ title: String(paper.title ?? '').trim() || undefined, text: String(paper.title ?? '').trim() || undefined, url });
      return 'shared';
    } catch (error) {
      if (/** @type {any} */ (error)?.name === 'AbortError') return 'cancelled';
      // NotAllowedError and the like: the engine has the call but not the menu here; copy instead
    }
  }
  return (await copyText(doc, text)) ? 'copied' : 'failed';
}

/** A short line at the bottom of the window for a moment ("Link copied"). @param {Document} doc @param {string} message */
export function flash(doc, message) {
  doc.querySelector('.sb-paper-flash')?.remove();
  const note = h(doc, 'div', 'sb-paper-flash', message);
  note.setAttribute('role', 'status');
  (doc.body ?? doc.documentElement).append(note);
  doc.defaultView?.setTimeout(() => note.remove(), 1600);
}

/** Opens the menu for `paper` at the pointer. Nothing opens for a paper without a link to share.
 *  @param {Document} doc @param {SharedPaper} paper @param {MouseEvent} event @param {PaperMenuHost} [host] */
export function openPaperMenu(doc, paper, event, host = {}) {
  const items = menuItems(paper, { canOpen: typeof host.openLink === 'function' });
  if (!items.length) return false;
  event.preventDefault();
  event.stopPropagation();
  doc.querySelector('.sb-paper-menu')?.remove();
  const url = /** @type {string} */ (paperLink(paper));
  const pop = h(doc, 'div', 'sb-art-pop sb-link-menu sb-paper-menu');
  pop.setAttribute('role', 'menu');
  pop.style.position = 'fixed';
  const close = () => { doc.removeEventListener('pointerdown', onOutside, true); doc.removeEventListener('keydown', onKey, true); pop.remove(); };
  const onOutside = (/** @type {Event} */ e) => { if (!pop.contains(/** @type {Node} */ (e.target))) close(); };
  const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') close(); };
  const say = (/** @type {string} */ message) => (host.say ? host.say(message) : flash(doc, message));
  const copy = async (/** @type {string} */ text, /** @type {string} */ said) => say((await copyText(doc, text)) ? said : "Couldn't copy");
  /** @type {Record<string, () => void>} */
  const run = {
    open: () => host.openLink?.(url),
    'open-outside': () => host.openLink?.(url, { outside: true }),
    'copy-link': () => { void copy(url, 'Link copied'); },
    'copy-text': () => { void copy(/** @type {string} */ (shareText(paper)), 'Title and link copied'); },
    share: () => { void sharePaper(doc, paper).then((result) => { const said = shareOutcome(result); if (said) say(said); }); },
  };
  for (const item of items) {
    const row = menuItem(doc, { label: item.label, icon: item.icon, onClick: run[item.id] }, close);
    row.dataset.action = item.id;
    pop.append(row);
  }
  (doc.body ?? doc.documentElement).append(pop);
  const win = doc.defaultView;
  const width = pop.offsetWidth, height = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(event.clientX, (win?.innerWidth ?? 800) - width - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(event.clientY, (win?.innerHeight ?? 600) - height - 8))}px`;
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKey, true);
  return true;
}

/** Right-click on `el` opens the paper's menu. `paper` may be a function, for a row whose paper changes after it is
 *  drawn. A paper with no link leaves the system's own menu alone.
 *  @template {HTMLElement} E @param {E} el @param {SharedPaper | (() => SharedPaper | null)} paper @param {PaperMenuHost} [host] @returns {E} */
export function paperMenuOn(el, paper, host) {
  el.addEventListener('contextmenu', (event) => {
    const p = typeof paper === 'function' ? paper() : paper;
    if (p) openPaperMenu(el.ownerDocument, p, /** @type {MouseEvent} */ (event), host);
  });
  return el;
}
