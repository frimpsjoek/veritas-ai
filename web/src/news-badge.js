// @ts-check
// ui-src/src/web/news-badge.js. Spec 028 R7: the count of new papers on the rail's Home item, kept up to date on every
// view, not only while Home paints. The shell reads it again at start, on a route change, when the window comes back
// into focus and after a paper stopped being news anywhere (host.newsChanged); the count is waiting.js's, so the badge
// and Home's "N new papers" line agree.
import { h } from '../../ui/src/dom.js';
import { waitingPapers } from '../../ui/src/home/waiting.js';

/** Reads at most once in this many ms; a call inside the gap reads once at its end, so the last change still shows. */
export const BADGE_GAP_MS = 2000;

/** The count on the rail's Home item; hidden at 0. @param {Document} doc @param {number} n */
export function showWaiting(doc, n) {
  const home = doc.querySelector('.sbw-nav-item[data-view="home"]');
  if (!home) return;
  let badge = /** @type {HTMLElement | null} */ (home.querySelector('.sbw-nav-badge'));
  if (!badge) { badge = h(doc, 'span', 'sbw-nav-badge'); home.append(badge); }
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

/**
 * The badge's reader. `refresh()` reads `conversations.list()` and shows the count; `refresh(true)` reads now, as after
 * a paper was marked viewed. A failed read leaves the badge as it was.
 * @param {Document} doc @param {{ ai(): Promise<any>, logError(error: unknown): void }} host
 * @param {{ now?: () => number, setTimer?: (fn: () => void, ms: number) => unknown }} [clock] for tests
 */
export function newsBadge(doc, host, { now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
  let last = -Infinity;
  let queued = false;
  let reads = 0;
  const read = async () => {
    last = now();
    const mine = ++reads;
    try {
      const list = await (await host.ai()).conversations.list();
      if (mine === reads) showWaiting(doc, waitingPapers(list, now()));
    } catch (error) { host.logError(error); }
  };
  return {
    /** @param {boolean} [force] read now, whatever the gap */
    refresh(force = false) {
      const wait = last + BADGE_GAP_MS - now();
      if (force || wait <= 0) return read();
      if (!queued) {
        queued = true;
        setTimer(() => { queued = false; void read(); }, wait);
      }
      return Promise.resolve();
    },
  };
}

/**
 * What the shell does with the badge: `route()` on every view, a read when the window comes back into focus (from
 * `start()` until `stop()`), and `host.newsChanged` reading at once after a paper stopped being news anywhere.
 * @param {Window} win @param {{ newsChanged?: () => void }} host @param {{ refresh(force?: boolean): Promise<void> }} badge
 */
export function followNews(win, host, badge) {
  host.newsChanged = () => { void badge.refresh(true); };
  const onFocus = () => { void badge.refresh(); };
  return {
    route() { void badge.refresh(); },
    start() { win.addEventListener('focus', onFocus); },
    stop() {
      win.removeEventListener('focus', onFocus);
      host.newsChanged = undefined;
    },
  };
}
