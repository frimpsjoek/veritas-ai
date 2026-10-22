// @ts-check
// ui-src/src/web/index.js. Entry of the browser app (build-web.mjs bundles it as an ES module): picks the server
// (connection.js: a sign-in link, the saved current one, or the server the page came from), then the web host and
// the shell on top of it. With no server to use, the setup screen.
import { createWebHost } from './host.js';
import { createShell } from './shell.js';
import { applyTheme } from './pages.js';
import { currentServer, isServedByServer, loadServers, parseSignInHash, saveServer, switchServer } from './connection.js';
import { paintSetup } from './setup-view.js';

export { createWebHost, createShell };

/** localStorage, or a throwaway in-memory one where storage is blocked (a private window): the app still runs for
 *  this visit. @param {Window} win @returns {Storage} */
function storageOf(win) {
  try { const s = win.localStorage; s.getItem('veritas.current'); return s; } catch { /* blocked */ }
  const map = new Map();
  return /** @type {Storage} */ (/** @type {unknown} */ ({
    get length() { return map.size; },
    key: (/** @type {number} */ i) => [...map.keys()][i] ?? null,
    getItem: (/** @type {string} */ k) => map.get(k) ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { map.set(k, String(v)); },
    removeItem: (/** @type {string} */ k) => { map.delete(k); },
    clear: () => map.clear(),
  }));
}

/**
 * A sign-in link (`#server=<url>&t=<token>`) saves that server and makes it current; the fragment then leaves the
 * address bar. An old `#t=<token>` link on the server's own /app/ goes to its cookie sign-in page; elsewhere it
 * renews the current server's code. @param {Window} win @param {Storage} storage @returns {boolean} false when the page is leaving
 */
function takeSignInLink(win, storage) {
  const link = parseSignInHash(win.location.hash);
  if (!link) return true;
  if (!link.server && link.token && isServedByServer(win.location)) {
    win.location.replace(new URL(`login${win.location.hash}`, win.location.href).href);
    return false;
  }
  const target = link.server ?? /** @type {any} */ (currentServer(storage, win.location))?.url;
  const known = loadServers(storage).find((s) => s.url === target);
  if (target && link.token && (link.server || known)) {
    saveServer(storage, { url: target, token: link.token, name: known?.name ?? '' });
    switchServer(storage, target);
  }
  win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}#/home`);
  return true;
}

/** Boots the app into `document`. `base`: talk to that server with its cookie, skipping the server choice (tests,
 *  the old same-origin entry). @param {{ base?: string }} [options] */
export async function startApp(options = {}) {
  const win = window;
  try { applyTheme(document, localStorage.getItem('sbw-theme') ?? 'system'); } catch { /* storage blocked: the system theme applies */ }
  const storage = storageOf(win);
  if (!options.base && !takeSignInLink(win, storage)) return { host: null, shell: null };
  /** @type {{ url: string, token: string | null, sameOrigin?: boolean } | null} */
  const server = options.base ? { url: options.base, token: null, sameOrigin: true } : currentServer(storage, win.location);
  const setup = (/** @type {string} */ problem = '') => { paintSetup(document.body, { doc: document, win, storage, problem: problem || undefined, server: problem ? server?.url : undefined }); };
  if (!server) { setup(); return { host: null, shell: null }; }
  let refused = false;
  const host = createWebHost({
    base: server.sameOrigin ? options.base : server.url,
    token: server.token,
    // On its own origin a 401 goes to the server's sign-in page (the host's default); a server elsewhere asks again here.
    onSignedOut: server.sameOrigin ? undefined : () => { refused = true; },
  });
  await host.ready;
  if (refused) {
    setup(`${server.url} did not accept the saved access code. Enter the current one, or pick another server.`);
    return { host: null, shell: null };
  }
  applyTheme(document, host.prefs.get('webTheme') ?? 'system');
  const shell = createShell({ host });
  await shell.start();
  watchForUpdates(document);
  return { host, shell };
}

/** The script name a page names: app-<hash>.js changes with every build. @param {string} html */
export function builtScript(html) {
  return /<script type="module" src="([^"]+)"/.exec(html)?.[1] ?? null;
}

/** A tab left open runs the build it loaded. Coming back to it, the app fetches index.html (served no-cache) and, when
 *  a newer build is installed and nothing is being typed, reloads onto it. @param {Document} doc */
function watchForUpdates(doc) {
  const mine = doc.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;
  if (!mine) return;
  let checking = false;
  const check = async () => {
    if (doc.visibilityState !== 'visible' || checking) return;
    checking = true;
    try {
      const html = await (await fetch(new URL('./', doc.baseURI), { cache: 'no-store' })).text();
      const latest = builtScript(html);
      const typing = Array.from(doc.querySelectorAll('textarea, input[type="text"], input:not([type])')).some((f) => /** @type {HTMLInputElement} */ (f).value.trim());
      if (latest && latest !== mine && !typing) doc.defaultView?.location.reload();
    } catch { /* offline: try again next time */ } finally { checking = false; }
  };
  doc.addEventListener('visibilitychange', () => { void check(); });
  doc.defaultView?.addEventListener('focus', () => { void check(); });
}

if (typeof document !== 'undefined' && !(/** @type {any} */ (globalThis).__SB_NO_AUTOSTART__)) {
  void startApp();
}
