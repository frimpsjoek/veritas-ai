// Seam 3 (rationale.md T4.3 #2, "post-merge seam"): content/agent-host.js's remoteTransport() used to guess a
// `{ events: [...], done }` page shape for GET /agent/events?after=, but agentd.mjs's real /events route (below,
// via its own exported `routes()`) answers with a plain JSON array of flattened Sequenced<AgentEvent> records.
// This test is a loopback built from that same route table, the way remote.test.js proves createRemoteRuntime
// against it; here it specifically exercises the polling shape content/agent-host.js's remoteTransport() now
// uses (a plain array, cursor advanced by the last event's own `seq`), which is Zotero's one real caller of
// this transport contract besides Obsidian's (obsidian-plugin/src/agent-api.ts, already shaped this way).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createRemoteRuntime } from '../src/remote.js';
import { routes } from '../src/node/agentd.mjs';
import { memoryFs } from './support/memory-fs.mjs';

function fakeProvider(events) {
  return {
    id: 'fake', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return null; }, async models() { return []; },
    async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn() { for (const ev of events) yield ev; },
    async dispose() {},
  };
}

function fakeGateway() {
  return {
    open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
    mcpServers: { async reports() { return []; }, async save() { throw new Error('n/a'); }, async remove() {}, rows: () => [] },
    async dispose() {},
  };
}

const noopLibrary = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };

async function makeService() {
  return createLocalRuntime({
    platform: { fs: memoryFs() }, library: noopLibrary, notes: {}, dataDir: 'data',
    providers: new Map([['fake', fakeProvider([
      { type: 'text', delta: 'See ' },
      { type: 'final', text: 'See [@smith2021].', json: null, usage: {} },
    ])]]),
    gateway: fakeGateway(),
    getRoleModel: async () => ({ provider: 'fake', model: null }),
    limits: { total: 6 },
  });
}

/** The exact algorithm content/agent-host.js's remoteTransport() runs against `${server}/agent${path}`, minus
 *  Zotero.HTTP: GET the route table directly instead of over a socket, so this stays a Node test. */
function zoteroShapedTransport(service) {
  const table = routes();
  function parseQuery(search) { return Object.fromEntries(new URLSearchParams(search)); }
  const call = async (method, path, body) => {
    const [pathname, search] = path.split('?');
    const row = table.find((r) => r.method === method && r.path === pathname);
    if (!row) throw new Error(`no route for ${method} ${path}`);
    const args = { ...parseQuery(search ?? ''), ...(body ?? {}) };
    return row.call(service, args, { signal: new AbortController().signal });
  };
  return {
    request: call,
    async *stream(path, after, signal) {
      let cursor = after;
      while (!signal?.aborted) {
        const batch = /** @type {any[]} */ (await call('GET', `${path}${path.includes('?') ? '&' : '?'}after=${cursor}`));
        for (const event of batch ?? []) { cursor = event.seq; yield { seq: event.seq, data: event }; }
        if ((batch ?? []).some((ev) => ev.type === 'done' || ev.type === 'failed')) return;
      }
    },
  };
}

test('the Zotero-shaped transport (plain array, no {events,done} wrapper) drives a full turn to done', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(zoteroShapedTransport(service));

  const id = await remote.conversations.create('chat');
  const events = [];
  for await (const ev of remote.conversations.send(id, { text: 'hello' })) events.push(ev);

  assert.ok(events.some((e) => e.type === 'text'));
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, JSON.stringify(events));
  assert.equal(done.answer.text, 'See [@smith2021].');
});

test('the Zotero-shaped transport carries conversations.adopt, idempotently', async () => {
  const service = await makeService();
  const remote = createRemoteRuntime(zoteroShapedTransport(service));

  const incoming = [
    JSON.stringify({ type: 'meta', id: 'zotero-1', mode: 'chat', title: 'From Zotero', created: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'user', text: 'hi', attachments: [], web: 'off', at: '2026-01-01T00:00:01.000Z' }),
  ].join('\n');

  assert.deepEqual(await remote.conversations.adopt([{ id: 'zotero-1', jsonl: incoming }]), ['zotero-1']);
  assert.deepEqual(await remote.conversations.adopt([{ id: 'zotero-1', jsonl: incoming }]), ['zotero-1']);
  const records = await remote.conversations.load('zotero-1');
  assert.equal(records.filter((r) => r.type === 'meta').length, 1);
});
