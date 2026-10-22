import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHub, verdictFor, reasonForVerdict } from '../src/mcp-hub.js';
import { fakeMcpSpawn, startFakeMcpHttp } from './fake-mcp.mjs';

const READ_ONLY_TOOL = { name: 'search', description: 'search things', annotations: { readOnlyHint: true } };
const WRITE_TOOL = { name: 'delete_everything', description: 'deletes things', annotations: { readOnlyHint: false } };
const DESTRUCTIVE_TOOL = { name: 'rm', description: 'rm -rf', annotations: { destructiveHint: true } };
const UNMARKED_TOOL = { name: 'mystery', description: 'no annotations at all' };

test('verdictFor: hint true exposed, write/destructive hidden, unmarked hidden unless trusted', () => {
  assert.equal(verdictFor(READ_ONLY_TOOL, false), 'exposed');
  assert.equal(verdictFor(WRITE_TOOL, false), 'hidden_writes');
  assert.equal(verdictFor(DESTRUCTIVE_TOOL, false), 'hidden_writes');
  assert.equal(verdictFor(UNMARKED_TOOL, false), 'hidden_unmarked');
  assert.equal(verdictFor(UNMARKED_TOOL, true), 'exposed');
  assert.equal(reasonForVerdict('hidden_writes'), 'marks itself as able to change things');
  assert.equal(reasonForVerdict('hidden_unmarked'), "doesn't say whether it changes things");
  assert.equal(reasonForVerdict('exposed'), null);
});

test('stdio server: connects, reports every tool with its verdict, exposes only the read-only one as a gateway row', async () => {
  const hub = createMcpHub({ fetch, spawn: fakeMcpSpawn([READ_ONLY_TOOL, WRITE_TOOL, UNMARKED_TOOL]) });
  const report = await hub.save({ name: 'lib', enabled: true, transport: 'stdio', command: process.execPath, args: [], env: {} });
  assert.equal(report.state, 'connected');
  assert.equal(report.error, null);
  const byName = Object.fromEntries(report.tools.map((t) => [t.name, t.verdict]));
  assert.deepEqual(byName, { search: 'exposed', delete_everything: 'hidden_writes', mystery: 'hidden_unmarked' });

  const rows = hub.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'lib__search');
  assert.deepEqual(rows[0].annotations, { readOnlyHint: true });
  const out = await rows[0].run({ query: 'x' });
  assert.equal(out.text, 'ran search'); // the fake server's default result text
  assert.deepEqual(out.seen, []);

  const reports = await hub.reports();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].config.name, 'lib');
  await hub.remove('lib');
  assert.equal((await hub.reports()).length, 0);
});

test('trusting a server exposes its previously-hidden unmarked tool on the next save', async () => {
  const hub = createMcpHub({ fetch, spawn: fakeMcpSpawn([UNMARKED_TOOL]) });
  await hub.save({ name: 'lib', enabled: true, transport: 'stdio', command: process.execPath, args: [], env: {} });
  assert.equal(hub.rows().length, 0);
  await hub.save({ name: 'lib', enabled: true, transport: 'stdio', command: process.execPath, args: [], env: {}, trustUnmarked: true });
  assert.equal(hub.rows().length, 1);
  assert.equal(hub.rows()[0].name, 'lib__mystery');
  await hub.remove('lib'); // kills the fake server's process; otherwise it outlives the test and node --test hangs on exit
});

test('a server startup failure is reported plainly and never throws', async () => {
  const hub = createMcpHub({ fetch, spawn: async () => { throw new Error('spawn ENOENT: no such binary'); } });
  const report = await hub.save({ name: 'broken', enabled: true, transport: 'stdio', command: '/no/such/binary', args: [], env: {} });
  assert.equal(report.state, 'failed');
  assert.match(report.error, /ENOENT/);
  assert.deepEqual(hub.rows(), []);
});

test('a disabled server config reports "disabled" and exposes nothing, without connecting', async () => {
  let spawned = false;
  const spawn = fakeMcpSpawn([READ_ONLY_TOOL]);
  const hub = createMcpHub({ fetch, spawn: (...args) => { spawned = true; return spawn(...args); } });
  const report = await hub.save({ name: 'off', enabled: false, transport: 'stdio', command: process.execPath, args: [], env: {} });
  assert.equal(report.state, 'disabled');
  assert.equal(spawned, false);
});

test('http (streamable) server: connects over a real loopback socket and exposes its read-only tool', async () => {
  const server = await startFakeMcpHttp([READ_ONLY_TOOL, DESTRUCTIVE_TOOL]);
  try {
    const hub = createMcpHub({ fetch, spawn: async () => { throw new Error('not used'); } });
    const report = await hub.save({ name: 'remote', enabled: true, transport: 'http', url: server.url, headers: {} });
    assert.equal(report.state, 'connected');
    const byName = Object.fromEntries(report.tools.map((t) => [t.name, t.verdict]));
    assert.deepEqual(byName, { search: 'exposed', rm: 'hidden_writes' });
    assert.deepEqual(hub.rows().map((r) => r.name), ['remote__search']);
  } finally {
    await server.close();
  }
});

test('http server: a non-2xx / erroring initialize is reported as failed, not thrown', async () => {
  const server = await startFakeMcpHttp([READ_ONLY_TOOL], { failInit: true });
  try {
    const hub = createMcpHub({ fetch, spawn: async () => { throw new Error('not used'); } });
    const report = await hub.save({ name: 'remote', enabled: true, transport: 'http', url: server.url, headers: {} });
    assert.equal(report.state, 'failed');
    assert.ok(report.error);
  } finally {
    await server.close();
  }
});

test('initial (saved) servers are connected before createMcpHub\'s `ready` resolves', async () => {
  const hub = createMcpHub({ fetch, spawn: fakeMcpSpawn([READ_ONLY_TOOL]) }, {
    initial: [{ name: 'lib', enabled: true, transport: 'stdio', command: process.execPath, args: [], env: {} }],
  });
  await hub.ready;
  assert.equal(hub.rows().length, 1);
  assert.equal((await hub.reports())[0].state, 'connected');
  await hub.remove('lib');
});

test('a host with no spawn (e.g. no stdio support) reports the stdio server as failed, plainly, not a crash', async () => {
  const hub = createMcpHub({ fetch, spawn: () => Promise.reject(new Error('This host cannot run a local MCP server (stdio spawn is unavailable).')) });
  const report = await hub.save({ name: 'lib', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'whatever'], env: {} });
  assert.equal(report.state, 'failed');
  assert.match(report.error, /stdio spawn is unavailable/);
});

test('hub.call runs one exposed tool directly and refuses hidden, missing or disconnected ones with a plain message', async () => {
  const hub = createMcpHub({ fetch, spawn: fakeMcpSpawn([READ_ONLY_TOOL, WRITE_TOOL]) });
  await hub.save({ name: 'lib', enabled: true, transport: 'stdio', command: process.execPath, args: [], env: {} });
  assert.equal(await hub.call('lib', 'search', { query: 'x' }), 'ran search');
  await assert.rejects(hub.call('lib', 'delete_everything', {}), /able to change things/);
  await assert.rejects(hub.call('lib', 'nope', {}), /no tool nope/);
  await assert.rejects(hub.call('ghost', 'search', {}), /ghost is not connected/);
  await hub.remove('lib');
});

test('http server that requires a session id: handshake offers 2025-03-26, lists tools, calls a tool', async () => {
  const server = await startFakeMcpHttp([READ_ONLY_TOOL], { sessions: true });
  try {
    const hub = createMcpHub({ fetch, spawn: async () => { throw new Error('not used'); } });
    const report = await hub.save({ name: 'hf', enabled: true, transport: 'http', url: server.url, headers: {} });
    assert.equal(report.state, 'connected', report.error);
    assert.deepEqual(report.tools.map((t) => t.name), ['search']);
    assert.deepEqual(server.stats.versions, ['2025-03-26']);
    assert.equal(await hub.call('hf', 'search', { query: 'x' }), 'ran search');
    assert.equal(server.stats.initializes, 1);
  } finally {
    await server.close();
  }
});

test('http server that forgets the session: the client re-initializes once and retries the call', async () => {
  const server = await startFakeMcpHttp([READ_ONLY_TOOL], { sessions: true, sse: true });
  try {
    const hub = createMcpHub({ fetch, spawn: async () => { throw new Error('not used'); } });
    await hub.save({ name: 'hf', enabled: true, transport: 'http', url: server.url, headers: {} });
    server.stats.forget();
    assert.equal(await hub.call('hf', 'search', {}), 'ran search');
    assert.equal(server.stats.initializes, 2);
  } finally {
    await server.close();
  }
});

test('http server without session ids still works and is initialized once', async () => {
  const server = await startFakeMcpHttp([READ_ONLY_TOOL]);
  try {
    const hub = createMcpHub({ fetch, spawn: async () => { throw new Error('not used'); } });
    await hub.save({ name: 'old', enabled: true, transport: 'http', url: server.url, headers: {} });
    assert.equal(await hub.call('old', 'search', {}), 'ran search');
    assert.equal(server.stats.initializes, 1);
  } finally {
    await server.close();
  }
});

test('a server with its own source switch (valency) is offered only while that switch is on; others ignore it', async () => {
  const hub = createMcpHub({ fetch, spawn: fakeMcpSpawn([READ_ONLY_TOOL]) });
  await hub.save({ name: 'valency', enabled: true, transport: 'stdio', command: process.execPath, args: [], env: {} });
  await hub.save({ name: 'lib', enabled: true, transport: 'stdio', command: process.execPath, args: [], env: {} });
  const on = (sources) => hub.rows().filter((r) => r.enabled(/** @type {any} */ ({ sources }))).map((r) => r.name).sort();
  const base = { papers: true, notes: true, scholarly: true, web: false };
  assert.deepEqual(on(base), ['lib__search', 'valency__search'], 'unset means on');
  assert.deepEqual(on({ ...base, valency: false }), ['lib__search']);
  assert.deepEqual(on({ ...base, valency: true }), ['lib__search', 'valency__search']);
  await hub.remove('valency');
  await hub.remove('lib');
});
