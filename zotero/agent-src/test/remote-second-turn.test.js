// A second question in the same chat must show its own events, never the previous turn's (a failure from the
// first turn was replayed under the second question). Driven through the same loopback wire as remote.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createRemoteRuntime } from '../src/remote.js';
import { routes } from '../src/node/agentd.mjs';
import { memoryFs } from './support/memory-fs.mjs';

const status = { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null };
/** Fails the first turn (like Codex not installed), answers the second. */
function provider() {
  let n = 0;
  return {
    id: 'fake', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return status; }, async models() { return []; },
    async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn() {
      n += 1;
      await new Promise((r) => setTimeout(r, 20));
      if (n === 1) { yield { type: 'failed', error: { kind: 'not_installed', message: 'Codex is not installed.' } }; return; }
      yield { type: 'final', text: `answer ${n}`, json: null, usage: {} };
    },
    async dispose() {},
  };
}
const gateway = {
  open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
  mcpServers: { async reports() { return []; } }, async dispose() {},
};
const lib = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };

function loopback(service) {
  const table = routes();
  const wire = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const find = (method, path) => table.find((r) => r.method === method && r.path === path);
  return {
    async request(method, path, body) {
      const [pathname, search] = path.split('?');
      const args = { ...Object.fromEntries(new URLSearchParams(search ?? '')), ...(body ?? {}) };
      // a real HTTP hop: the request reaches the server a moment after the client starts reading events
      await new Promise((r) => setTimeout(r, 5));
      return wire(await find(method, pathname).call(service, args, { signal: new AbortController().signal }));
    },
    async *stream(path, after, signal) {
      const [pathname, search] = path.split('?');
      const { id } = Object.fromEntries(new URLSearchParams(search ?? ''));
      const row = find('GET', pathname);
      let cursor = after;
      while (!signal?.aborted) {
        const batch = await row.call(service, { id, after: cursor }, { signal });
        for (const ev of batch) { cursor = ev.seq; yield { seq: ev.seq, data: wire(ev) }; }
        if (batch.some((ev) => ev.type === 'done' || ev.type === 'failed')) return;
        if (!batch.length) await new Promise((r) => setTimeout(r, 2));
      }
    },
  };
}

async function collect(it) { const out = []; for await (const e of it) out.push(e); return out; }

test('the second turn of a chat streams its own events, not the first turn\'s failure', async () => {
  const service = await createLocalRuntime({
    platform: { fs: memoryFs() }, library: lib, notes: {}, dataDir: 'data', providers: new Map([['fake', provider()]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }), limits: { total: 6 },
  });
  const remote = createRemoteRuntime(loopback(service));
  const id = await remote.conversations.create('chat');
  const first = await collect(remote.conversations.send(id, { text: 'one' }));
  assert.equal(first.at(-1).type, 'failed');
  const second = await collect(remote.conversations.send(id, { text: 'two' }));
  assert.equal(second.at(-1).type, 'done', `second turn ended with ${second.at(-1).type}`);
  assert.equal(second.at(-1).answer.text, 'answer 2');
  assert.ok(!second.some((e) => e.type === 'failed'));
});

test('a question sent while a turn is running says so, instead of replaying the log; a refused send ends with its error', async () => {
  const service = await createLocalRuntime({
    platform: { fs: memoryFs() }, library: lib, notes: {}, dataDir: 'data', providers: new Map([['fake', provider()]]),
    gateway, getRoleModel: async () => ({ provider: 'fake', model: null }), limits: { total: 6 },
  });
  const remote = createRemoteRuntime(loopback(service));
  const id = await remote.conversations.create('chat');
  const running = collect(remote.conversations.send(id, { text: 'one' }));
  await new Promise((r) => setTimeout(r, 12));
  const busy = await collect(remote.conversations.send(id, { text: 'hi' }));
  assert.equal(busy.length, 1);
  assert.equal(busy[0].type, 'failed');
  assert.match(busy[0].error.message, /still coming in this chat/);
  assert.equal((await running).at(-1).type, 'failed'); // the first turn is untouched (Codex-style failure)
  // a turn the server refuses to start (an unknown paper set) ends with the server's own words
  const refused = await collect(remote.conversations.send(id, { text: 'x', on: { result: { id: 'nope' }, rows: 'all' } }));
  assert.equal(refused.at(-1).type, 'failed');
  assert.match(refused.at(-1).error.message, /no paper set nope/);
});

/** First turn waits until it is cancelled (as a real provider does on its abort signal); later turns answer at once. */
function hangingProvider() {
  let n = 0;
  return {
    id: 'fake', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return status; }, async models() { return []; },
    async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn(_req, signal) {
      n += 1;
      if (n === 1) {
        await new Promise((resolve) => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', resolve, { once: true }); setTimeout(resolve, 5000); });
        yield { type: 'failed', error: { kind: 'cancelled', message: 'Stopped.' } };
        return;
      }
      yield { type: 'final', text: `answer ${n}`, json: null, usage: {} };
    },
    async dispose() {},
  };
}

async function service2(p) {
  return createLocalRuntime({
    platform: { fs: memoryFs() }, library: lib, notes: {}, dataDir: 'data', providers: new Map([['fake', p]]),
    gateway, getRoleModel: async () => ({ provider: 'fake', model: null }), limits: { total: 6 },
  });
}

test('Stop on a remote turn cancels it on the server, so the next question is not "busy"', async () => {
  const service = await service2(hangingProvider());
  const remote = createRemoteRuntime(loopback(service));
  const id = await remote.conversations.create('chat');
  const stop = new AbortController();
  const first = collect(remote.conversations.send(id, { text: 'one' }, { signal: stop.signal }));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await service.conversations.cursor(id)).inFlight, true);
  stop.abort();
  await first;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await service.conversations.cursor(id)).inFlight, false, 'the server turn was stopped, not left to run');
  const next = await collect(remote.conversations.send(id, { text: 'two' }));
  assert.equal(next.at(-1).type, 'done');
});

test('a question sent the instant the last answer arrives is not refused as busy', async () => {
  const service = await service2(hangingProvider());
  const remote = createRemoteRuntime(loopback(service));
  const id = await remote.conversations.create('chat');
  const stop = new AbortController();
  const first = collect(remote.conversations.send(id, { text: 'one' }, { signal: stop.signal }));
  await new Promise((r) => setTimeout(r, 30));
  stop.abort(); await first; await new Promise((r) => setTimeout(r, 60));
  for (const text of ['a', 'b', 'c']) {
    const events = await collect(remote.conversations.send(id, { text }));
    assert.equal(events.at(-1).type, 'done', `${text}: ${JSON.stringify(events.at(-1))}`);
  }
});
