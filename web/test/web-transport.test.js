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
