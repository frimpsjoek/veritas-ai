// @ts-check
// ui-src/src/links.js. Spec 015 B1/B4: how a web link is opened. Every link place calls `host.openLink` through here,
// so no view opens a window itself and the host alone decides where a link goes (inside the app or the system browser).
import { h } from './dom.js';
import { icon } from './icons.js';
import { menuItem } from './chat/popover.js';

export const OPEN_LINKS_PREF = 'openLinks';

/** @typedef {{ openLink(url: string, opts?: { outside?: boolean }): void, can?: { linksInside?: boolean } }} LinkHost */

/** The user's choice (spec 016's Settings row writes it); anything but 'outside' means inside.
 *  @param {{ get<T>(key: string): T | undefined }} prefs @returns {'inside' | 'outside'} */
export function linkMode(prefs) {
  return prefs.get(OPEN_LINKS_PREF) === 'outside' ? 'outside' : 'inside';
}

/** @param {string} url */
export function isWebUrl(url) {
  return /^https?:\/\//i.test(url);
}

/** A link whose target is a PDF file (spec 015 D4), by its address; the server also recognises PDFs by their bytes.
 *  @param {string} url */
export function isPdfUrl(url) {
  try {
    const u = new URL(url);
    return /\.pdf$/i.test(u.pathname) || (/(^|\.)arxiv\.org$/i.test(u.hostname) && /^\/pdf\//.test(u.pathname));
  } catch { return false; }
}

/** Where a link goes: 'inside' (the app's own browser), 'outside' (the system browser) or 'scheme' (zotero:, obsidian:
 *  and other non-web links, handed to the system). A link marked outside always goes outside; so does every link when
 *  the setting says so or the host has no browser to show. @param {string} url @param {{ outside?: boolean } | undefined} opts
 *  @param {{ mode: 'inside' | 'outside', hasBrowser: boolean }} where @returns {'inside' | 'outside' | 'scheme'} */
export function planOpen(url, opts, where) {
  if (!isWebUrl(url)) return 'scheme';
  return opts?.outside || where.mode === 'outside' || !where.hasBrowser ? 'outside' : 'inside';
}

/** A modified click (⌘, Ctrl, Shift) means "somewhere else": the system browser. @param {MouseEvent} event */
export function wantsOutside(event) {
  return event.metaKey || event.ctrlKey || event.shiftKey;
}

/** Whether this host has a place inside the app for links (so ↗ and the choice menu mean something). @param {LinkHost} host */
export function hasInside(host) {
  return Boolean(host.can?.linksInside);
}

/** Makes `a` open `url` through the host on a plain click or Enter-click. Keeps a real href for the keyboard and
 *  screen readers. @template {HTMLElement} E @param {E} a @param {LinkHost} host @param {string} url @returns {E} */
export function wireLink(a, host, url) {
  if (a.tagName === 'A') {
    a.setAttribute('href', url);
    a.setAttribute('rel', 'noopener noreferrer');
  } else {
    a.setAttribute('role', 'link');
    a.tabIndex = 0;
    a.addEventListener('keydown', (event) => { if (event.key === 'Enter') host.openLink(url); });
  }
  a.addEventListener('click', (event) => { event.preventDefault(); host.openLink(url, wantsOutside(event) ? { outside: true } : undefined); });
  if (hasInside(host)) a.addEventListener('contextmenu', (event) => linkMenu(a.ownerDocument, host, url, event));
  return a;
}

/** Routes every http(s) link inside `root` (rendered notes, a reader view) through the host with one listener.
 *  @param {HTMLElement | DocumentFragment | Element} root @param {LinkHost} host */
export function interceptLinks(root, host) {
  const target = (/** @type {Event} */ event) => {
    const a = /** @type {Element | null} */ (/** @type {Element} */ (event.target)?.closest?.('a[href]'));
    const href = a?.getAttribute('href') ?? '';
    return a && isWebUrl(href) ? href : null;
  };
  root.addEventListener('click', (e) => {
    const event = /** @type {MouseEvent} */ (e);
    const href = target(event);
    if (!href) return;
    event.preventDefault();
    host.openLink(href, wantsOutside(event) ? { outside: true } : undefined);
  });
  root.addEventListener('contextmenu', (e) => {
    const href = target(e);
    if (href && hasInside(host)) linkMenu(root.ownerDocument ?? /** @type {Document} */ (/** @type {unknown} */ (root)), host, href, /** @type {MouseEvent} */ (e));
  });
}

/** The small ↗ next to a link: this one goes to the system browser, whatever the setting says (spec 015 B4).
 *  Null in a host with nowhere inside, where every link already goes outside. @param {Document} doc @param {LinkHost} host @param {string} url */
export function outsideButton(doc, host, url) {
  if (!hasInside(host)) return null;
  const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-link-out'));
  b.setAttribute('type', 'button');
  b.title = 'Open in your browser';
  b.setAttribute('aria-label', 'Open in your browser');
  b.append(icon(doc, 'open', 'sb-ai-icon'));
  b.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); host.openLink(url, { outside: true }); });
  return b;
}

/** Right-click / long-press on a link: the two places it can go. @param {Document} doc @param {LinkHost} host @param {string} url @param {MouseEvent} event */
export function linkMenu(doc, host, url, event) {
  event.preventDefault();
  const pop = h(doc, 'div', 'sb-art-pop sb-link-menu');
  pop.setAttribute('role', 'menu');
  pop.style.position = 'fixed';
  const close = () => { doc.removeEventListener('pointerdown', onOutside, true); doc.removeEventListener('keydown', onKey, true); pop.remove(); };
  const onOutside = (/** @type {Event} */ e) => { if (!pop.contains(/** @type {Node} */ (e.target))) close(); };
  const onKey = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Escape') close(); };
  pop.append(
    menuItem(doc, { label: 'Open in Second Brain', onClick: () => host.openLink(url, { outside: false }) }, close),
    menuItem(doc, { label: 'Open in your browser', icon: 'open', onClick: () => host.openLink(url, { outside: true }) }, close),
  );
  doc.body.append(pop);
  const win = doc.defaultView;
  const width = pop.offsetWidth, height = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(event.clientX, (win?.innerWidth ?? 800) - width - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(event.clientY, (win?.innerHeight ?? 600) - height - 8))}px`;
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKey, true);
}
