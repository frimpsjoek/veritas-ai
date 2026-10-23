// @ts-check
// web/src/connection.js. Which Veritas server the web app talks to. The app is static files that can be hosted
// anywhere (GitHub Pages, the desktop window, or the server's own /app/), so it keeps its servers in this browser's
// localStorage: `veritas.servers` = [{ url, token, name }] and `veritas.current` = the url in use. Served by the server
// itself at /app/, it needs no entry and signs in with the cookie as before. Pure functions over a Storage-like
// object and a Location-like object, so the tests run without a browser.

export const SERVERS_KEY = 'veritas.servers';
export const CURRENT_KEY = 'veritas.current';
/** localStorage keys that hold one server's data (library-view.js keeps rows under sbw-library-v1:<collection>). */
const SERVER_CACHE_PREFIXES = ['sbw-library-'];

/** @typedef {{ url: string, token: string, name: string }} Server */
/** @typedef {{ url: string, token: null, sameOrigin: true }} SameOrigin */
/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>} StorageLike */
/** @typedef {{ origin: string, protocol: string, pathname: string }} LocationLike */

/** "mac.local:27190/" → "http://mac.local:27190"; a URL with a scheme keeps it. Trailing slashes go.
 *  @param {string} text */
export function normaliseServerUrl(text) {
  let url = String(text ?? '').trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  if (!/^https?:\/\//i.test(url)) return ''; // a Veritas server is reached over http(s) only
  return url.replace(/\/+$/, '');
}

/** Why a page on https cannot reach a plain-http server on another computer. */
export const HTTPS_WARNING = 'This page is on https, so the browser will not let it reach a plain http address on another computer. '
  + "Use the server's https address (the one in the phone link), or localhost on the same computer.";

/**
 * What to say when a server cannot be reached. A server that refuses this page's address (not in its web-origins
 * list) looks the same to the page as one that is off, so both causes are named, with the command for the first.
 * @param {string} pageUrl @param {string} serverUrl
 */
export function unreachableMessage(pageUrl, serverUrl) {
  if (needsHttpsWarning(pageUrl, serverUrl)) return `Couldn't reach ${serverUrl}. ${HTTPS_WARNING}`;
  let origin = pageUrl;
  try { origin = new URL(pageUrl).origin; } catch { /* shown as it is */ }
  return `Couldn't reach ${serverUrl}. Check that the computer is awake and the address is right. If it is, the server may `
    + `not accept this page yet: on the server, run kb.py web-origins add ${origin}`;
}

/**
 * What a sign-in link should do. Anyone can send a link, so it never switches server or replaces a code silently:
 * `ask` is true when the server is not saved yet or the code differs from the saved one. null: nothing to do (no
 * usable server, or a bare code with no server to give it to).
 * @param {{ server?: string, token?: string }} link @param {Server[]} saved @param {string | null} current the current server's URL
 * @returns {{ ask: boolean, target: string, token: string, isNew: boolean } | null}
 */
export function signInPlan(link, saved, current) {
  if (!link.token) return null;
  const target = link.server !== undefined ? normaliseServerUrl(link.server) : (current ?? '');
  if (!target) return null;
  const known = saved.find((s) => s.url === target);
  if (!link.server && !known) return null;
  return { ask: !known || known.token !== link.token, target, token: link.token, isNew: !known };
}

/** @param {StorageLike} storage @returns {Server[]} */
export function loadServers(storage) {
  try {
    const list = JSON.parse(storage.getItem(SERVERS_KEY) ?? '[]');
    if (!Array.isArray(list)) return [];
    return list
      .filter((s) => s && typeof s.url === 'string' && s.url && typeof s.token === 'string')
      .map((s) => ({ url: normaliseServerUrl(s.url), token: s.token, name: typeof s.name === 'string' ? s.name : '' }));
  } catch { return []; }
}

/** Adds the server, or replaces the saved one with the same URL. @param {StorageLike} storage @param {Server} server */
export function saveServer(storage, server) {
  const url = normaliseServerUrl(server.url);
  const entry = { url, token: server.token, name: server.name || hostOf(url) };
  const list = loadServers(storage).filter((s) => s.url !== url);
  storage.setItem(SERVERS_KEY, JSON.stringify([...list, entry]));
}

/** Forgets a server (and stops using it if it was the current one). @param {StorageLike} storage @param {string} url */
export function removeServer(storage, url) {
  const target = normaliseServerUrl(url);
  storage.setItem(SERVERS_KEY, JSON.stringify(loadServers(storage).filter((s) => s.url !== target)));
  if (storage.getItem(CURRENT_KEY) === target) storage.removeItem(CURRENT_KEY);
}

/**
 * Makes a saved server the current one and drops what the browser kept of the previous server's data, so nothing
 * of it is painted while the new one answers. The caller then reloads the page, which empties every in-memory
 * cache (prefs, chat, keys). Per-device choices (theme) stay. An unknown URL changes nothing.
 * @param {StorageLike} storage @param {string} url @returns {boolean} whether it switched
 */
export function switchServer(storage, url) {
  const target = normaliseServerUrl(url);
  if (!loadServers(storage).some((s) => s.url === target)) return false;
  const stale = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && SERVER_CACHE_PREFIXES.some((p) => key.startsWith(p))) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
  storage.setItem(CURRENT_KEY, target);
  return true;
}

/** The page is the server's own /app/ (or the server's sign-in page next to it). @param {LocationLike} location */
export function isServedByServer(location) {
  return /^https?:$/.test(location.protocol) && /^\/app(\/|$)/.test(location.pathname);
}

/**
 * The server to use: the saved current one; else, on the server's own /app/, that server (cookie sign-in); else
 * the first saved server; else null (show setup).
 * @param {StorageLike} storage @param {LocationLike} location @returns {Server | SameOrigin | null}
 */
export function currentServer(storage, location) {
  const servers = loadServers(storage);
  let current = null;
  try { current = storage.getItem(CURRENT_KEY); } catch { /* blocked storage: nothing saved */ }
  const chosen = current ? servers.find((s) => s.url === current) : undefined;
  if (chosen) return chosen;
  if (isServedByServer(location)) return { url: location.origin, token: null, sameOrigin: true };
  return servers[0] ?? null;
}

/**
 * Reads a sign-in link's fragment. New links: `#server=<url>&t=<token>`; old ones (the server's /app/login): `#t=<token>`.
 * The fragment never reaches a server. Anything else (an app route like #/home) is null.
 * @param {string} hash @returns {{ server?: string, token?: string } | null}
 */
export function parseSignInHash(hash) {
  const text = String(hash ?? '').replace(/^#/, '');
  if (!text || text.startsWith('/')) return null;
  const params = new URLSearchParams(text);
  const server = params.get('server');
  const token = params.get('t');
  if (!server && !token) return null;
  return { ...(server ? { server: normaliseServerUrl(server) } : {}), ...(token ? { token } : {}) };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A page that is not itself plain http (an https page, the desktop window) cannot reach a plain-http server on
 *  another computer: the browser blocks it as mixed content. localhost is exempt. @param {string} pageUrl @param {string} serverUrl */
export function needsHttpsWarning(pageUrl, serverUrl) {
  try {
    const page = new URL(pageUrl);
    const server = new URL(serverUrl);
    return page.protocol !== 'http:' && server.protocol === 'http:' && !LOOPBACK.has(server.hostname);
  } catch { return false; }
}

/** @param {string} url */
function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}
