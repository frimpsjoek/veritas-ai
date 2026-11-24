import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebTransport } from '../src/transport.js';

const restarting = () => Object.assign(new Error('the agent sidecar is (re)starting'), { status: 503 });

test('a request sent while the sidecar restarts is sent again once it is back', async () => {
  let calls = 0;
  const waits = [];
  const api = { call: async () => { calls += 1; if (calls < 3) throw restarting(); return { id: 'ok' }; } };
  const out = await createWebTransport(api, { sleep: async (ms) => { waits.push(ms); } }).request('POST', '/conversations/c1/send', {});
  assert.deepEqual(out, { id: 'ok' });
  assert.deepEqual(waits, [1000, 2000]);
});

test('a sidecar that stays down fails after about 15 s, and other errors fail at once', async () => {
  const waits = [];
  const down = { call: async () => { throw restarting(); } };
  await assert.rejects(createWebTransport(down, { sleep: async (ms) => { waits.push(ms); } }).request('GET', '/x'), /starting/);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000]);
  let calls = 0;
  const broken = { call: async () => { calls += 1; throw Object.assign(new Error('bad'), { status: 400 }); } };
  await assert.rejects(createWebTransport(broken, { sleep: async () => {} }).request('GET', '/x'), /bad/);
  assert.equal(calls, 1);
});

test('builtScript reads the bundle a page names', async () => {
  const { builtScript } = await import('../src/index.js');
  assert.equal(builtScript('<link rel="stylesheet" href="app-1.css">\n<script type="module" src="app-4dbd7a1b.js"></script>'), 'app-4dbd7a1b.js');
  assert.equal(builtScript('<html></html>'), null);
});

test('any 401 after start tells the host (the saved code stopped working)', async () => {
  const { createFetchApi } = await import('../src/transport.js');
  let told = 0;
  const api = createFetchApi('https://mac.example.ts.net', {
    fetch: async () => new Response(JSON.stringify({ error: 'a valid token is required' }), { status: 401 }),
    onUnauthorized: () => { told += 1; },
  });
  await assert.rejects(api.call('/search?q=x'));
  assert.equal(told, 1);
});

/** A fetch that never answers until its signal aborts, as a server that hangs. */
const hanging = (seen) => async (_url, init) => {
  seen?.push(init?.signal ?? null);
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), { once: true });
  });
};

test('a server call that gets no answer fails after the timeout with an error the views can show, not "Loading…" for ever', async () => {
  const { createFetchApi, CALL_TIMEOUT_MS } = await import('../src/transport.js');
  assert.equal(CALL_TIMEOUT_MS, 60_000);
  /** @type {boolean[]} */ const reach = [];
  const api = createFetchApi('https://mac.example', { fetch: hanging(), timeoutMs: 30, onReachable: (up) => reach.push(up) });
  const started = Date.now();
  await assert.rejects(api.call('/zotero/items'), (error) => /took more than/.test(error.message) && error.timeout === true);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(reach, [false]); // the server light says so, as for a dropped connection
});

test('a caller\'s own abort is not a timeout, and a call with no timeout (0) waits', async () => {
  const { createFetchApi } = await import('../src/transport.js');
  /** @type {boolean[]} */ const reach = [];
  const api = createFetchApi('https://mac.example', { fetch: hanging(), timeoutMs: 5000, onReachable: (up) => reach.push(up) });
  const controller = new AbortController();
  const call = api.call('/search?q=x', 'GET', undefined, controller.signal);
  controller.abort();
  await assert.rejects(call, (error) => !error.timeout);
  assert.deepEqual(reach, []);
  // no timeout: still waiting after the default would have fired for a 20 ms one
  const slow = createFetchApi('https://mac.example', { timeoutMs: 20, fetch: (_url, init) => new Promise((resolve, reject) => {
    const done = setTimeout(() => resolve(new Response('{"ok":true}')), 60);
    init?.signal?.addEventListener('abort', () => { clearTimeout(done); reject(new Error('aborted')); }, { once: true });
  }) });
  assert.deepEqual(await slow.call('/x', 'GET', undefined, undefined, 0), { ok: true });
  await assert.rejects(slow.call('/x'), /took more than/);
});

test('the agent forward and its long poll have no call timeout (an answer or a held poll can take longer)', async () => {
  /** @type {any[]} */ const seen = [];
  const api = { call: async (...args) => { seen.push(args); await new Promise((r) => setTimeout(r, 1)); return []; } }; // a real wait: an empty poll answered at once would spin
  const transport = createWebTransport(api, { sleep: async () => {} });
  await transport.request('POST', '/ask', { question: 'q' });
  const controller = new AbortController();
  const stream = transport.stream('/conversations/events?id=c1', 0, controller.signal);
  const next = stream.next();
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await next;
  assert.equal(seen[0][4], 0);
  assert.equal(seen[1][4], 0);
});
