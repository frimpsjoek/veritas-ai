// @ts-check
// ui-src/src/web/index.js. Entry of the browser app (build-web.mjs bundles it as an ES module): the web host, then
// the shell on top of it.
import { createWebHost } from './host.js';
import { createShell } from './shell.js';
import { applyTheme } from './pages.js';

export { createWebHost, createShell };

/** Boots the app into `document`. @param {{ base?: string }} [options] */
export async function startApp(options = {}) {
  try { applyTheme(document, localStorage.getItem('sbw-theme') ?? 'system'); } catch { /* storage blocked: the system theme applies */ }
  const host = createWebHost({ base: options.base });
  await host.ready;
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
