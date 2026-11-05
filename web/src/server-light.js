// @ts-check
// web/src/server-light.js. A small light in the window's top corner: green while the server answers, an empty ring when
// it does not, a pulsing ring while it says it is still starting, an arc round the dot while a routine runs. A click
// opens a popover with since when and, when it is down, Try now. A view only learns the server went away when it next
// asks, so the light asks by itself every so often.
import { h } from '../../ui/src/dom.js';
import { lucide } from '../../ui/src/icons.js';

export const CHECK_MS = 15000;

/** @param {number} ms */
const clockTime = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * What the light says.
 * @param {'server' | 'local' | 'offline'} where
 * @param {{ ready?: boolean, busy?: string | null, since?: number | null }} [seen] `ready`: false only when /ping says so
 *   (a server that does not send it is ready); `busy`: the routine running; `since`: when this state began, or for a
 *   server that went away, when it last answered
 */
export function lightState(where, { ready = true, busy = null, since = null } = {}) {
  const at = since == null ? '' : clockTime(since);
  if (where === 'offline') {
    return { state: /** @type {const} */ ('down'), on: false, canTry: true, label: "Can't reach the Veritas server", head: 'The server is not answering', body: `${at ? `Last answered at ${at}. ` : ''}Veritas keeps trying by itself.` };
  }
  if (!ready) return { state: /** @type {const} */ ('starting'), on: true, canTry: false, label: 'Veritas server is starting', head: 'The server is starting', body: `${at ? `Since ${at}. ` : ''}The page fills in by itself.` };
  if (busy) return { state: /** @type {const} */ ('busy'), on: true, canTry: false, label: `Veritas server is running ${busy}`, head: `${busy} is running`, body: at ? `Since at least ${at}.` : '' };
  return { state: /** @type {const} */ ('up'), on: true, canTry: false, label: 'Veritas server is running', head: 'The server is running', body: at ? `Answering since ${at}.` : '' };
}

const STATES = /** @type {const} */ (['up', 'starting', 'busy', 'down']);

/**
 * @param {Document} doc
 * @param {Pick<import("../../ui/src/host").UiHost, 'where' | 'onWhereChange' | 'json'> & { ai?: () => Promise<any> }} host
 * @param {{ setInterval: (fn: () => void, ms: number) => any, clearInterval: (timer: any) => void, now?: () => number }} [clock]
 */
export function serverLight(doc, host, clock = globalThis) {
  const now = () => (clock.now ?? Date.now)();
  const root = h(doc, 'span', 'sbw-server-light');
  // A 24 px target round the 9 px dot.
  const button = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-server-button'));
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.append(h(doc, 'span', 'sbw-server-dot'));
  const pop = h(doc, 'div', 'sbw-server-pop');
  pop.hidden = true;
  root.append(button, pop);

  let ready = true;
  /** @type {string | null} */ let busy = null;
  /** @type {string | null} */ let shown = null;
  let since = now();
  let answered = now();
  let trying = false;
  let tried = false;

  const paint = () => {
    const seen = lightState(host.where(), { ready, busy, since });
    if (shown !== seen.state) {
      since = seen.state === 'down' ? answered : shown === null ? since : now();
      shown = seen.state;
      tried = false;
    }
    const word = lightState(host.where(), { ready, busy, since });
    for (const state of STATES) root.classList.toggle(`is-${state}`, word.state === state);
    button.title = word.label;
    button.setAttribute('aria-label', word.label);
    if (pop.hidden) return;
    pop.replaceChildren(h(doc, 'strong', 'sbw-server-head', word.head));
    if (word.body) pop.append(h(doc, 'p', 'sbw-server-body', word.body));
    if (tried && word.canTry) pop.append(h(doc, 'p', 'sbw-server-body', 'Still no answer.'));
    if (word.canTry) {
      const again = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button sbw-server-try'));
      again.type = 'button';
      again.disabled = trying;
      again.append(lucide(doc, 'refreshCw', 14), trying ? 'Trying…' : 'Try now');
      again.addEventListener('click', (event) => {
        event.stopPropagation();
        trying = true;
        paint();
        return check().then(() => { trying = false; tried = true; paint(); });
      });
      pop.append(again);
    }
  };

  /** Asks /ping (the host hears whether it answered, and calls `paint` on a change); a `ready` field is read if there is one.
   *  `routines`: also which routine runs, where the host can say. */
  const check = async (routines = false) => {
    try {
      const answer = /** @type {any} */ (await host.json('/ping'));
      answered = now();
      ready = answer?.ready !== false;
    } catch { return; }
    if (routines && ready && host.ai) {
      try {
        const list = await (await host.ai()).routines?.list();
        busy = (list ?? []).find((/** @type {any} */ r) => r.running)?.name ?? null;
      } catch { busy = null; }
    }
    paint();
  };

  const onOutside = (/** @type {Event} */ event) => { if (!root.contains(/** @type {Node} */ (event.target))) close(); };
  const onKey = (/** @type {KeyboardEvent} */ event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); button.focus(); } };
  const close = () => {
    if (pop.hidden) return;
    pop.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
  };
  button.addEventListener('click', () => {
    if (!pop.hidden) { close(); return; }
    pop.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    doc.addEventListener('pointerdown', onOutside, true);
    doc.addEventListener('keydown', onKey, true);
    paint();
  });

  paint();
  const stopListening = host.onWhereChange(paint);
  void check();
  const timer = clock.setInterval(() => { void check(true); }, CHECK_MS);
  return { root, button, pop, stop() { close(); stopListening(); clock.clearInterval(timer); } };
}
