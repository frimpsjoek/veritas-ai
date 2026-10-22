// @ts-check
// ui-src/src/home/links.js. Where something on Home leads, and how a link gets there in each host: the web app gives
// every link an href its router (or the browser) follows; a plugin has no router and opens the place itself.

/** @typedef {{ to: 'home' } | { to: 'sources' } | { to: 'routines' } | { to: 'session', id: string } | { to: 'issue', id: string } | { to: 'url', url: string }} HomeTarget */
/** @typedef {{ href: (target: HomeTarget) => string, openWeb?: (url: string, event: MouseEvent) => void } | { open: (target: HomeTarget) => void }} HomeLinks */

/** Makes `el` (an <a>) lead to `target`. Without an href it is still a link to the keyboard and to screen readers.
 *  @template {HTMLElement} E @param {E} el @param {HomeTarget} target @param {HomeLinks} links @returns {E} */
export function linkTo(el, target, links) {
  if ('href' in links) {
    el.setAttribute('href', links.href(target));
    if (target.to === 'url') {
      el.setAttribute('rel', 'noopener noreferrer');
      const open = links.openWeb;
      if (open) el.addEventListener('click', (event) => { event.preventDefault(); open(target.url, event); });
    }
    return el;
  }
  el.setAttribute('role', 'link');
  el.tabIndex = 0;
  const go = (/** @type {Event} */ event) => { event.preventDefault(); links.open(target); };
  el.addEventListener('click', go);
  el.addEventListener('keydown', (event) => { if (/** @type {KeyboardEvent} */ (event).key === 'Enter') go(event); });
  return el;
}
