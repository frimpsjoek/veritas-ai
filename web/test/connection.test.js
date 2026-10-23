// @ts-check
// Phase 3 Task 3: which server the web app talks to, the sign-in link, the http warning and the Bearer token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentServer, loadServers, needsHttpsWarning, normaliseServerUrl, parseSignInHash, saveServer, switchServer,
} from '../src/connection.js';
import { createFetchApi } from '../src/transport.js';

/** A Storage stand-in over a Map. */
function memoryStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key: (/** @type {number} */ i) => [...map.keys()][i] ?? null,
    getItem: (/** @type {string} */ k) => (map.has(k) ? map.get(k) : null),
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { map.set(k, String(v)); },
    removeItem: (/** @type {string} */ k) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

test('parses both sign-in link formats', () => {
  assert.deepEqual(parseSignInHash('#server=https%3A%2F%2Fmac.example.ts.net%3A8443%2F&t=abc123'), { server: 'https://mac.example.ts.net:8443', token: 'abc123' });
  assert.deepEqual(parseSignInHash('#t=abc123'), { token: 'abc123' });
  assert.deepEqual(parseSignInHash('server=127.0.0.1:27190'), { server: 'http://127.0.0.1:27190' });
  assert.equal(parseSignInHash('#/home'), null);
  assert.equal(parseSignInHash(''), null);
  assert.equal(normaliseServerUrl(' mac.local:27190/ '), 'http://mac.local:27190');
  assert.equal(normaliseServerUrl('https://mac.example.ts.net//'), 'https://mac.example.ts.net');
});

test('same origin needs no saved server', () => {
  const storage = memoryStorage();
  const served = { origin: 'https://mac.example.ts.net', protocol: 'https:', pathname: '/app/' };
  assert.deepEqual(currentServer(storage, served), { url: 'https://mac.example.ts.net', token: null, sameOrigin: true });
  // a static host (GitHub Pages) with nothing saved goes to setup
  const hosted = { origin: 'https://someone.github.io', protocol: 'https:', pathname: '/veritas-ai/' };
  assert.equal(currentServer(storage, hosted), null);
  saveServer(storage, { url: 'https://mac.example.ts.net', token: 't1', name: 'Mac' });
  assert.equal(currentServer(storage, hosted)?.url, 'https://mac.example.ts.net');
  assert.equal(currentServer(storage, hosted)?.token, 't1');
  // saving the same URL again replaces the entry instead of adding one
  saveServer(storage, { url: 'https://mac.example.ts.net/', token: 't2', name: 'Mac' });
  assert.deepEqual(loadServers(storage), [{ url: 'https://mac.example.ts.net', token: 't2', name: 'Mac' }]);
  // a broken entry in storage is ignored, not thrown
  storage.setItem('veritas.servers', '{not json');
  assert.deepEqual(loadServers(storage), []);
});

test('warns for plain http to another host from an https page', () => {
  assert.equal(needsHttpsWarning('https://someone.github.io/veritas-ai/', 'http://192.168.1.20:27190'), true);
  assert.equal(needsHttpsWarning('https://someone.github.io/veritas-ai/', 'http://localhost:27190'), false);
  assert.equal(needsHttpsWarning('https://someone.github.io/veritas-ai/', 'http://127.0.0.1:27190'), false);
  assert.equal(needsHttpsWarning('https://someone.github.io/veritas-ai/', 'https://mac.example.ts.net'), false);
  assert.equal(needsHttpsWarning('http://localhost:5173/', 'http://192.168.1.20:27190'), false);
  assert.equal(needsHttpsWarning('https://someone.github.io/', 'not a url'), false);
});

test('transport sends the bearer token', async () => {
  /** @type {{ url: string, init: any }[]} */ const seen = [];
  const fakeFetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init) => { seen.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); });
  await createFetchApi('https://mac.example.ts.net', { fetch: fakeFetch, token: 'tok' }).call('/web/state');
  await createFetchApi('https://mac.example.ts.net', { fetch: fakeFetch, token: 'tok' }).call('/web/state', 'POST', { a: 1 });
  await createFetchApi('', { fetch: fakeFetch }).call('/ping');
  assert.equal(seen[0].url, 'https://mac.example.ts.net/web/state');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');
  assert.equal(seen[1].init.headers.Authorization, 'Bearer tok');
  assert.equal(seen[1].init.headers['Content-Type'], 'application/json');
  assert.equal(seen[2].init.headers?.Authorization, undefined);
});

test('switching server clears cached views', () => {
  const storage = memoryStorage();
  saveServer(storage, { url: 'https://a.example', token: 'ta', name: 'A' });
  saveServer(storage, { url: 'https://b.example', token: 'tb', name: 'B' });
  switchServer(storage, 'https://a.example');
  storage.setItem('sbw-library-v1:all', '[{"key":"FROM_A"}]');
  storage.setItem('sbw-theme', 'dark');
  switchServer(storage, 'https://b.example');
  const hosted = { origin: 'https://someone.github.io', protocol: 'https:', pathname: '/' };
  assert.equal(currentServer(storage, hosted)?.url, 'https://b.example');
  assert.equal(storage.getItem('sbw-library-v1:all'), null, "server A's library rows are gone");
  assert.equal(storage.getItem('sbw-theme'), 'dark', 'per-device choices stay');
  // switching to a server that is not saved does nothing
  switchServer(storage, 'https://c.example');
  assert.equal(currentServer(storage, hosted)?.url, 'https://b.example');
});

test('server addresses are http or https only', async () => {
  const { normaliseServerUrl } = await import('../src/connection.js');
  assert.equal(normaliseServerUrl('mac.example.ts.net:8443'), 'http://mac.example.ts.net:8443');
  assert.equal(normaliseServerUrl('https://mac.example.ts.net/'), 'https://mac.example.ts.net');
  for (const bad of ['javascript://x', 'file:///etc', 'data://x', 'ftp://host']) assert.equal(normaliseServerUrl(bad), '', bad);
});

test('a sign-in link asks before connecting to a new server or changing a code', async () => {
  const { signInPlan } = await import('../src/connection.js');
  const saved = [{ url: 'https://mac.example.ts.net', token: 'old', name: 'Mac' }];
  assert.deepEqual(signInPlan({ server: 'https://evil.example', token: 'x' }, saved, null),
    { ask: true, target: 'https://evil.example', token: 'x', isNew: true });
  assert.deepEqual(signInPlan({ token: 'junk' }, saved, 'https://mac.example.ts.net'),
    { ask: true, target: 'https://mac.example.ts.net', token: 'junk', isNew: false });
  assert.deepEqual(signInPlan({ server: 'https://mac.example.ts.net', token: 'old' }, saved, null),
    { ask: false, target: 'https://mac.example.ts.net', token: 'old', isNew: false });
  assert.equal(signInPlan({ server: 'javascript://x', token: 'x' }, saved, null), null);
  assert.equal(signInPlan({ token: 'x' }, [], null), null); // a bare code with no server to give it to
});

test('an unreachable server gets both likely causes, with the command to allow this page', async () => {
  const { unreachableMessage } = await import('../src/connection.js');
  const text = unreachableMessage('https://app.example/veritas/', 'https://mac.example.ts.net');
  assert.match(text, /Couldn't reach https:\/\/mac\.example\.ts\.net/);
  assert.match(text, /kb\.py web-origins add https:\/\/app\.example/);
  assert.match(unreachableMessage('https://app.example/', 'http://192.168.1.5:27182'), /plain http address/);
});
