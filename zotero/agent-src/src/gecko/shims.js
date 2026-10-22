// Injected by build-zotero.mjs in place of the Node globals the shared core names (process, crypto), so the
// core's source stays host-neutral. Only this bundle sees these bindings; Zotero's own scope is untouched.
/* global Services, Zotero */

export const process = {
  env: new Proxy({}, {
    get: (_, name) => (typeof name === 'string' && Services.env.exists(name) ? Services.env.get(name) : undefined),
  }),
  stderr: { write: (text) => Zotero.debug(`Second Brain AI: ${String(text).trimEnd()}`) },
};

// Zotero's plugin sandbox lacks these DOM classes; the main window (or the hidden window before it opens) has them.
const win = () => Zotero.getMainWindow() ?? Services.appShell.hiddenDOMWindow;
/** @param {"AbortController" | "DOMException"} name */
const fromWindow = (name) => globalThis[name] ?? class { constructor(...args) { return new (win()[name])(...args); } };

export const AbortController = fromWindow('AbortController');
export const DOMException = fromWindow('DOMException');

export const crypto = {
  // win(), not getMainWindow() alone: with no main window open yet (startup, or every window closed on macOS)
  // the hidden window still has crypto, the same fallback AbortController and DOMException use above.
  /** @param {Uint8Array} array */
  getRandomValues: (array) => (globalThis.crypto ?? win().crypto).getRandomValues(array),
};
