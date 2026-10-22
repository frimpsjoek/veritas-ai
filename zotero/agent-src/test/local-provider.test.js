import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createNodePlatform } from '../src/node/platform.mjs';
import { localProvider, createThinkFilter, stripThink, driveMessage } from '../src/providers/local.js';
import { createProviders } from '../src/providers/index.js';
import { detectExternal } from '../src/local/external.js';
import { ASK_SCHEMA } from '../src/core.js';
import { startFakeServer } from './fake-local-server.mjs';
import { makeRoot, removeRoot, writeModel } from './support/model-tree.mjs';

const platform = createNodePlatform({ homeDir: '/nonexistent-home' });

/** A tree with Woof 4B + Qwen on a fake "drive", a fake python, and a settings.json pointing at them. */
async function world({ drive = true, mlx = true, scan } = {}) {
  const root = await makeRoot();
  const models = path.join(root, 'Volumes', 'Content', 'models');
  if (drive) {
    await writeModel(path.join(models, 'ConwayResearch', 'Underdog-Woof-4B-1.1'), { weights: 4000 });
    await writeModel(path.join(models, 'mlx-community', 'Qwen3.5-4B-MLX-4bit'), { weights: 3000 });
  }
  const py = path.join(root, 'venv', 'bin', 'python');
  await fsp.mkdir(path.dirname(py), { recursive: true });
  await fsp.writeFile(py, '');
  if (mlx) await fsp.mkdir(path.join(root, 'venv', 'lib', 'python3.12', 'site-packages', 'mlx_lm'), { recursive: true });
  else await fsp.mkdir(path.join(root, 'venv', 'lib', 'python3.12', 'site-packages'), { recursive: true });
  const dataDir = path.join(root, 'data');
  await platform.fs.writeAtomic(path.join(dataDir, 'settings.json'), JSON.stringify({ local: { scanDirs: scan ?? [models], python: py } }));
  return { root, models, py, dataDir };
}

function fakeManager(baseUrl) {
  const calls = { ensure: [], begin: 0, end: 0, disposed: false };
  let id = null;
  return {
    calls,
    ensure: async (m) => { calls.ensure.push(m); id = m.id; return { baseUrl }; },
    begin() { calls.begin += 1; }, end() { calls.end += 1; },
    state: () => ({ state: id ? 'ready' : 'stopped', id }),
    stop: async () => {}, dispose: async () => { calls.disposed = true; },
  };
}

function request(overrides = {}) {
  return {
    sessionKey: 's', model: { provider: 'local', model: null }, instructions: 'Answer only from the passages.', history: [],
    input: 'What did Smith find?', tools: { specs: [], call: async () => ({ ok: false, text: '' }), seen: () => [], close() {}, mcp: { url: '', token: '' } },
    web: 'off', outputSchema: null, ...overrides,
  };
}

/** Waits (up to 3 s) for a condition that depends on the fake server noticing a disconnect. */
async function until(fn) { for (let i = 0; i < 150 && !fn(); i += 1) await new Promise((r) => setTimeout(r, 20)); }

async function collect(it) { const out = []; for await (const ev of it) out.push(ev); return out; }
const text = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');

test('a guarded MLX turn: request body carries temperature 0, thinking off, <= 600 tokens, stream, and no tools', async () => {
  const w = await world(); const fake = await startFakeServer(); const manager = fakeManager(fake.baseUrl);
  try {
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    fake.next({ pieces: ['Smith found ', 'a 12% gain [@smith2020].'] });
    const events = await collect(provider.turn(request(), new AbortController().signal));
    const body = fake.requests[0];
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.ok(body.max_tokens <= 600);
    assert.equal(body.stream, true);
    assert.equal('tools' in body, false);
    assert.equal('response_format' in body, false);
    assert.equal(body.model, path.join(w.models, 'ConwayResearch', 'Underdog-Woof-4B-1.1'), 'mlx_lm.server is addressed by the model path it loaded');
    assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
    // streaming
    assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.delta), ['Smith found ', 'a 12% gain [@smith2020].']);
    const final = events.at(-1);
    assert.equal(final.type, 'final');
    assert.equal(final.text, 'Smith found a 12% gain [@smith2020].');
    assert.deepEqual(final.usage, { inputTokens: 40, outputTokens: 12 });
    // the default model is Woof 4B; the server manager was bracketed by begin/end around the turn
    assert.equal(manager.calls.ensure[0].id, 'mlx:ConwayResearch/Underdog-Woof-4B-1.1');
    assert.deepEqual([manager.calls.begin, manager.calls.end], [1, 1]);
    assert.equal(events[0].type, 'notice');
    assert.match(events[0].text, /Opening Underdog Woof 4B 1\.1/);
  } finally { await fake.close(); await removeRoot(w.root); }
});

test('a repeating model is stopped, the client disconnects, and the repeats are dropped with a notice', async () => {
  const w = await world(); const fake = await startFakeServer(); const manager = fakeManager(fake.baseUrl);
  try {
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    fake.next({ repeat: 'The data are inconclusive on this point.\n' });
    const events = await collect(provider.turn(request(), new AbortController().signal));
    const final = events.at(-1);
    assert.equal(final.type, 'final');
    assert.equal(final.text, 'The data are inconclusive on this point.');
    assert.deepEqual(final.notes, ['Stopped a repeating answer.']);
    assert.ok(events.some((e) => e.type === 'notice' && e.kind === 'local_guard'));
    await until(() => fake.state.clientClosed === 1);
    assert.equal(fake.state.clientClosed, 1, 'the stream was aborted, not left running');
  } finally { await fake.close(); await removeRoot(w.root); }
});

test('hitting the length limit adds a note; Ask wraps the plain text as an answered result', async () => {
  const w = await world(); const fake = await startFakeServer(); const manager = fakeManager(fake.baseUrl);
  try {
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    fake.next({ pieces: ['A long answer that was cut'], finish: 'length' });
    const events = await collect(provider.turn(request({ outputSchema: ASK_SCHEMA }), new AbortController().signal));
    const final = events.at(-1);
    assert.deepEqual(final.notes, ['Short answer: stopped at the length limit.']);
    assert.deepEqual(JSON.parse(final.text), { status: 'answered', markdown: 'A long answer that was cut' });
    assert.equal('response_format' in fake.requests[0], false);
  } finally { await fake.close(); await removeRoot(w.root); }
});

test('an empty think block is hidden, and a server error becomes a plain failure', async () => {
  const w = await world(); const fake = await startFakeServer(); const manager = fakeManager(fake.baseUrl);
  try {
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    fake.next({ pieces: ['<thi', 'nk>\n\n</think>\n\n', 'Real answer.'] });
    const events = await collect(provider.turn(request(), new AbortController().signal));
    assert.equal(text(events), 'Real answer.');
    assert.equal(events.at(-1).text, 'Real answer.');
    fake.next({ status: 500, text: 'boom' });
    const failed = await collect(provider.turn(request(), new AbortController().signal));
    assert.deepEqual(failed.at(-1), { type: 'failed', error: { kind: 'provider_crashed', message: 'boom' } });
    fake.next({ pieces: [] });
    const empty = await collect(provider.turn(request(), new AbortController().signal));
    assert.equal(empty.at(-1).error.kind, 'bad_output');
  } finally { await fake.close(); await removeRoot(w.root); }
});

test('Stop (abort) ends the turn as cancelled', async () => {
  const w = await world(); const fake = await startFakeServer(); const manager = fakeManager(fake.baseUrl);
  try {
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    fake.next({ endless: (i) => `Sentence number ${i} says something new. ` });
    const controller = new AbortController();
    const events = [];
    for await (const ev of provider.turn(request(), controller.signal)) { events.push(ev); if (ev.type === 'text') controller.abort(); }
    assert.deepEqual(events.at(-1), { type: 'failed', error: { kind: 'cancelled', message: 'Interrupted.' } });
    await until(() => fake.state.clientClosed === 1);
    assert.equal(fake.state.clientClosed, 1);
  } finally { await fake.close(); await removeRoot(w.root); }
});

test('a server manager refusal (not enough memory) fails the turn with its own plain message', async () => {
  const w = await world();
  try {
    const manager = fakeManager('http://127.0.0.1:1/v1');
    manager.ensure = async () => { throw Object.assign(new Error('There isn\'t enough free memory to open X.'), { kind: 'model_unavailable', tooBig: true }); };
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    const events = await collect(provider.turn(request(), new AbortController().signal));
    assert.deepEqual(events.at(-1), { type: 'failed', error: { kind: 'model_unavailable', message: 'There isn\'t enough free memory to open X. Qwen3.5 4B MLX 4bit doesn\'t fit either. Or choose a cloud model for Chat in Settings.' } });
    assert.equal(manager.calls.end, 1, 'the idle clock is released even when the start fails');
  } finally { await removeRoot(w.root); }
});

test('no room for the chosen model: the next smaller one of the same family answers, with a notice', async () => {
  const w = await world(); const fake = await startFakeServer(); const manager = fakeManager(fake.baseUrl);
  try {
    await writeModel(path.join(w.models, 'ConwayResearch', 'Underdog-Woof-2B-1.1'), { weights: 2000 });
    const tried = [];
    manager.ensure = async (m) => {
      tried.push(m.label);
      if (!m.label.includes('2B')) throw Object.assign(new Error(`There isn't enough free memory to open ${m.label}.`), { kind: 'model_unavailable', tooBig: true });
      return { baseUrl: fake.baseUrl };
    };
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    const woof4 = (await provider.models()).find((m) => m.label.includes('Woof 4B'));
    fake.next({ pieces: ['Hello.'] });
    const events = await collect(provider.turn(request({ model: { provider: 'local', model: woof4.id } }), new AbortController().signal));
    assert.equal(tried.length, 2);
    assert.match(tried[1], /Woof 2B/, 'the same family comes before a bigger model of another family');
    assert.ok(events.some((e) => e.type === 'notice' && /There isn't room for .*Woof 4B.* so .*Woof 2B.* is answering/.test(e.text)), JSON.stringify(events));
    assert.equal(text(events), 'Hello.');
    assert.equal(fake.requests[0].model, path.join(w.models, 'ConwayResearch', 'Underdog-Woof-2B-1.1'));
  } finally { await fake.close?.(); await removeRoot(w.root); }
});

test('a failure that is not about room (a crash) does not try other models', async () => {
  const w = await world();
  try {
    const manager = fakeManager('http://127.0.0.1:1/v1');
    let calls = 0;
    manager.ensure = async () => { calls += 1; throw Object.assign(new Error('The model stopped while opening.'), { kind: 'provider_crashed' }); };
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    const events = await collect(provider.turn(request(), new AbortController().signal));
    assert.equal(calls, 1);
    assert.equal(events.at(-1).error.kind, 'provider_crashed');
  } finally { await removeRoot(w.root); }
});

test('models with no room in memory are not offered: "Free memory first", read fresh each time; the loaded one stays', async () => {
  const w = await world();
  try {
    let free = 1024 ** 3 * 0.5;
    const manager = fakeManager('http://127.0.0.1:1/v1');
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 60_000, externals: [], memory: async () => free });
    const tight = await provider.models();
    assert.ok(tight.length >= 2 && tight.every((m) => /^Free memory first: it needs about \d+\.\d GB, about 0\.5 GB is free\.$/.test(m.unavailable)), JSON.stringify(tight));
    free = 1024 ** 3 * 64;
    assert.ok((await provider.models()).every((m) => m.unavailable === null), 'more memory: offered again without waiting for the catalog');
    free = 1024 ** 3 * 0.5;
    await manager.ensure({ id: tight[0].id });
    const loaded = await provider.models();
    assert.equal(loaded.find((m) => m.id === tight[0].id).unavailable, null, 'the model already loaded stays selectable');
  } finally { await removeRoot(w.root); }
});

test('an Ollama / LM Studio style server is used as-is: nothing is started', async () => {
  const w = await world({ drive: false }); const fake = await startFakeServer({ models: ['llama3.2:3b', 'nomic-embed-text'] });
  try {
    const manager = fakeManager('http://127.0.0.1:1/v1');
    const externals = [{ source: 'ollama', label: 'Ollama', baseUrl: fake.baseUrl }, { source: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1/v1' }];
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals });
    const models = await provider.models();
    assert.deepEqual(models.map((m) => [m.id, m.source]), [['ollama:llama3.2:3b', 'ollama']], 'the embedding model and the absent server are dropped');
    assert.equal(models[0].isDefault, true);
    fake.next({ pieces: ['Hi.'] });
    const events = await collect(provider.turn(request({ model: { provider: 'local', model: 'ollama:llama3.2:3b' } }), new AbortController().signal));
    assert.equal(events.at(-1).text, 'Hi.');
    assert.equal(fake.requests[0].model, 'llama3.2:3b');
    assert.equal(manager.calls.ensure.length, 0);
    assert.equal(manager.calls.begin, 0);
    assert.equal(events.some((e) => e.type === 'notice'), false);
  } finally { await fake.close(); await removeRoot(w.root); }
});

test('status: ready with the models counted; drive missing; mlx-lm missing; nothing found', async () => {
  const ready = await world(); const rm = [ready.root];
  try {
    const provider = localProvider(platform, { dataDir: ready.dataDir, home: '/h', server: fakeManager('x'), catalogTtlMs: 0, externals: [] });
    const st = await provider.status();
    assert.equal(st.state, 'ready');
    assert.equal(st.detail, '2 models found.');
    assert.equal(st.provider, 'local');
    assert.equal(st.account.kind, 'none');
    const list = await provider.models();
    assert.deepEqual(list.map((m) => m.id), ['mlx:ConwayResearch/Underdog-Woof-4B-1.1', 'mlx:mlx-community/Qwen3.5-4B-MLX-4bit']);
    assert.equal(list[0].isDefault, true);
    assert.equal(list[0].sizeBytes, 4000);

    const gone = await world({ drive: false, scan: ['/Volumes/Content-test-not-mounted/models'] }); rm.push(gone.root);
    const p2 = localProvider(platform, { dataDir: gone.dataDir, home: '/h', server: fakeManager('x'), catalogTtlMs: 0, externals: [] });
    const s2 = await p2.status();
    assert.equal(s2.state, 'unreachable');
    assert.equal(s2.detail, 'The Content-test-not-mounted drive isn\'t connected, so its models can\'t be used. Other servers on this Mac still work.');
    assert.deepEqual(await p2.models(), []);
    const failed = await collect(p2.turn(request(), new AbortController().signal));
    assert.equal(failed.at(-1).error.kind, 'model_unavailable');
    assert.match(failed.at(-1).error.message, /drive isn't connected/);

    const nomlx = await world({ mlx: false }); rm.push(nomlx.root);
    const p3 = localProvider(platform, { dataDir: nomlx.dataDir, home: '/h', server: fakeManager('x'), catalogTtlMs: 0, externals: [] });
    const s3 = await p3.status();
    assert.equal(s3.state, 'missing');
    assert.match(s3.detail, /need mlx-lm, which isn't installed/);
    assert.match(s3.installHelp, /pip install mlx-lm/);
    assert.equal((await p3.models()).every((m) => m.unavailable), true);

    const empty = await world({ drive: true, scan: [path.join(ready.root, 'empty-but-exists')] }); rm.push(empty.root);
    await fsp.mkdir(path.join(ready.root, 'empty-but-exists'));
    const s4 = await localProvider(platform, { dataDir: empty.dataDir, home: '/h', server: fakeManager('x'), catalogTtlMs: 0, externals: [] }).status();
    assert.equal(s4.state, 'missing');
    assert.equal(s4.detail, 'No local models found.');
  } finally { for (const r of rm) await removeRoot(r); }
});

test('status is loading while a model opens, and says which is loaded afterwards', async () => {
  const w = await world();
  try {
    const manager = fakeManager('x');
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    manager.state = () => ({ state: 'loading', id: 'mlx:ConwayResearch/Underdog-Woof-4B-1.1' });
    assert.deepEqual(await provider.status().then((s) => [s.state, s.detail]), ['loading', 'Opening Underdog Woof 4B 1.1...']);
    manager.state = () => ({ state: 'ready', id: 'mlx:ConwayResearch/Underdog-Woof-4B-1.1' });
    assert.match((await provider.status()).detail, /Underdog Woof 4B 1\.1 is loaded\./);
  } finally { await removeRoot(w.root); }
});

test('a turn with tools offered (the reports switch) goes through the plain tool loop on the same server', async () => {
  const w = await world(); const fake = await startFakeServer(); const manager = fakeManager(fake.baseUrl);
  try {
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    fake.next({ pieces: ['Plan done.'] });
    const withTools = request({ tools: { specs: [{ name: 'search_library', description: 'd', inputSchema: { type: 'object' } }], call: async () => ({ ok: true, text: '' }), seen: () => [], close() {}, mcp: { url: '', token: '' } } });
    const events = await collect(provider.turn(withTools, new AbortController().signal));
    assert.equal(events.at(-1).text, 'Plan done.');
    assert.equal(fake.requests[0].tools.length, 1, 'tools are sent only on this path');
  } finally { await fake.close(); await removeRoot(w.root); }
});

test('signIn and signOut do nothing; dispose disposes the server; the provider is registered with its caps', async () => {
  const w = await world();
  try {
    const manager = fakeManager('x');
    const provider = localProvider(platform, { dataDir: w.dataDir, home: '/h', server: manager, catalogTtlMs: 0, externals: [] });
    assert.equal((await (await provider.signIn('browser')).done).state, 'ready');
    await provider.signOut();
    await provider.dispose();
    assert.equal(manager.calls.disposed, true);
    assert.deepEqual(provider.caps, { nativeWebSearch: false, nativeStructuredOutput: false, tools: false, roles: ['chat', 'ask'] });
    const all = createProviders(platform, { dataDir: w.dataDir, home: '/h' });
    assert.equal(all.get('local').id, 'local');
    await all.get('local').dispose();
  } finally { await removeRoot(w.root); }
});

test('think filter and helpers', () => {
  const f = createThinkFilter();
  assert.equal(['<think>', 'plan', '</think>', '\n\nHello'].map((d) => f.push(d)).join(''), 'Hello');
  const g = createThinkFilter();
  assert.equal(g.push('No tag here'), 'No tag here');
  const h = createThinkFilter();
  assert.equal(h.push('<th'), '');
  assert.equal(h.flush(), '<th', 'a stream that ends on a lone prefix keeps it');
  assert.equal(stripThink('<think>a</think>\nB'), 'B');
  assert.equal(driveMessage(['/Volumes/Content/models', '/Users/x/.cache']), "The Content drive isn't connected, so its models can't be used.");
  assert.equal(driveMessage(['/Users/x/.cache']), null);
});

test('detectExternal times out an unresponsive server without throwing', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const started = Date.now();
  assert.deepEqual(await detectExternal(hang, [{ source: 'ollama', label: 'Ollama', baseUrl: 'http://x/v1' }], 50), []);
  assert.ok(Date.now() - started < 1000);
});
