// @ts-check
// web/src/server-light.js. A small light in the window's top corner: on while the server answers, an empty ring when it
// does not. A view only learns the server went away when it next asks, so the light asks by itself every so often.
import { h } from '../../ui/src/dom.js';

export const CHECK_MS = 15000;

/** What the light says. @param {'server' | 'local' | 'offline'} where */
export const lightState = (where) => (where === 'offline'
  ? { on: false, label: "Can't reach the Veritas server" }
  : { on: true, label: 'Veritas server is running' });

/**
 * @param {Document} doc
 * @param {Pick<import("../../ui/src/host").UiHost, 'where' | 'onWhereChange' | 'json'>} host
 * @param {{ setInterval: (fn: () => void, ms: number) => any, clearInterval: (timer: any) => void }} [clock]
 */
export function serverLight(doc, host, clock = globalThis) {
  const root = h(doc, 'span', 'sbw-server-light');
  root.setAttribute('role', 'status');
  const paint = () => {
    const { on, label } = lightState(host.where());
    root.classList.toggle('is-on', on);
    root.title = label;
    root.setAttribute('aria-label', label);
  };
  paint();
  const stopListening = host.onWhereChange(paint);
  // The answer itself does not matter: the host hears whether the server answered, and calls `paint` on a change.
  const timer = clock.setInterval(() => { void host.json('/ping').catch(() => {}); }, CHECK_MS);
  return { root, stop() { stopListening(); clock.clearInterval(timer); } };
}
