// Sources chips: the saved switches are what a send without `sources` searches (older Obsidian builds, remote and MCP callers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createToolGateway } from '../src/tools.js';
import { memoryFs } from './support/memory-fs.mjs';

/** Sends one message and reports the stored user record's `sources` and what `search_library` asked the backend for. */
async function sendSeen(settings, sendInput) {
  const searches = [];
  const library = { async search(q) { searches.push(q.only); return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const provider = {
    id: 'fake', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; }, async signIn() {}, async signOut() {},
    async *turn(req) { await req.tools.call('search_library', { query: 'x' }, new AbortController().signal); yield { type: 'final', text: 'ok', json: null, usage: {} }; },
    async dispose() {},
  };
  const service = await createLocalRuntime({
    platform: { fs: memoryFs() }, library, notes: {}, dataDir: '/d', providers: new Map([['fake', provider]]), getRoleModel: async () => ({ provider: 'fake', model: null }),
    gateway: await createToolGateway(fetch, library, {}),
  });
  if (settings) await service.settings.update(settings);
  const id = await service.conversations.create('chat');
  for await (const ev of service.conversations.send(id, { text: 'hello', ...sendInput })) void ev;
  const user = (await service.conversations.load(id)).find((r) => r.type === 'user');
  await service.dispose();
  return { sources: user.sources, searches };
}

test('a send without sources follows the saved switches', async () => {
  const seen = await sendSeen({ sources: { notes: false } }, {});
  assert.deepEqual(seen.sources, { papers: true, notes: false, scholarly: true, web: false });
  assert.deepEqual(seen.searches, ['papers']);
});

test('web in the default sources follows the web mode of the send', async () => {
  const seen = await sendSeen({ sources: { papers: false } }, { web: 'cached' });
  assert.deepEqual(seen.sources, { papers: false, notes: true, scholarly: true, web: true });
  assert.deepEqual(seen.searches, ['notes']);
});

test('sources in the send win over the saved switches', async () => {
  const seen = await sendSeen({ sources: { notes: false } }, { sources: { papers: false, notes: true, scholarly: false, web: false } });
  assert.deepEqual(seen.sources, { papers: false, notes: true, scholarly: false, web: false });
  assert.deepEqual(seen.searches, ['notes']);
});

test('with nothing saved, everything is on', async () => {
  const seen = await sendSeen(null, {});
  assert.deepEqual(seen.sources, { papers: true, notes: true, scholarly: true, web: false });
  assert.deepEqual(seen.searches, [undefined]);
});
