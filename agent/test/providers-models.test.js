// spec 016 E2/E3: what each provider lists as models, and the oss:<name> registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { codexProvider, mapCodexModelList } from '../src/providers/codex.js';
import { claudeProvider, claudeModels } from '../src/providers/claude.js';
import { createProviders, syncEndpointProviders } from '../src/providers/index.js';
import { createSettingsStore } from '../src/settings.js';
import { memoryFs } from './support/memory-fs.mjs';
import { scriptedFetch } from './fake-openai.mjs';

const FAKE = fileURLToPath(new URL('./fake-codex-models.mjs', import.meta.url));

function spawnFake(env, sent) {
  const child = spawn(process.execPath, [FAKE], { env: { ...process.env, ...env } });
  child.stdin.on('error', () => {});
  return {
    lines() { const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity }); return { [Symbol.asyncIterator]: () => rl[Symbol.asyncIterator]() }; },
    async write(line) { sent?.push(JSON.parse(line)); if (child.stdin.writable) child.stdin.write(line + '\n'); },
    stderrTail() { return ''; },
    async kill() { child.kill(); },
    exited: new Promise((resolve) => child.on('exit', (code) => resolve(code ?? 0))),
  };
}

function platformFor({ env = {}, sent, which = '/fake/codex', fs = memoryFs(), fetch } = {}) {
  const spawned = [];
  return {
    spawned,
    async spawn(spec) { const c = spawnFake(env, sent); spawned.push({ spec, child: c }); return c; },
    async which() { return which; }, fetch, fs, homeDir: '/h',
  };
}

const PAGE1 = {
  data: [
    { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Latest frontier model', isDefault: true, hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'medium', description: '' }, { reasoningEffort: 'high', description: '' }], defaultReasoningEffort: 'medium' },
    { id: 'old-hidden', model: 'old-hidden', displayName: 'Old', hidden: true, supportedReasoningEfforts: [] },
  ],
  nextCursor: 'p2',
};
const PAGE2 = { data: [{ id: 'gpt-5.5-mini', model: 'gpt-5.5-mini', displayName: 'GPT-5.5 mini', description: '  ', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'minimal' }] }], nextCursor: null };

test('check 2: the Codex list comes from the app server model/list (paged, hidden dropped), plus added IDs', async () => {
  const fs = memoryFs();
  await createSettingsStore(fs, '/d').update({ addedModels: [{ provider: 'codex', id: 'gpt-x' }, { provider: 'claude', id: 'claude-other' }, { provider: 'codex', id: 'gpt-5.5' }] });
  const sent = [];
  const platform = platformFor({ env: { PAGES: JSON.stringify([PAGE1, PAGE2]) }, sent, fs });
  const models = await codexProvider(platform, { binaryPath: null, dataDir: '/d', home: '/h' }).models();
  assert.deepEqual(models, [
    { id: 'gpt-5.5', label: 'GPT-5.5', hint: 'Latest frontier model', efforts: ['low', 'medium', 'high'], source: 'provider', isDefault: true },
    { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini', hint: null, efforts: ['low'], source: 'provider', isDefault: false },
    { id: 'gpt-x', label: 'gpt-x', hint: null, efforts: ['low', 'medium', 'high'], source: 'added', isDefault: false },
  ]);
  assert.deepEqual(sent.map((m) => m.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.equal(sent[3].params.cursor, 'p2');
  assert.equal(platform.spawned[0].spec.args[0], 'app-server');
  assert.equal(await Promise.race([platform.spawned[0].child.exited, new Promise((r) => setTimeout(() => r('alive'), 2000))]) !== 'alive', true, 'the app server is ended after listing');
});

test('check 2: Codex missing lists nothing; an app server that errors lists only the added IDs', async () => {
  const missing = platformFor({ which: null });
  assert.deepEqual(await codexProvider(missing, { binaryPath: null, dataDir: '/d', home: '/h' }).models(), []);
  assert.equal(missing.spawned.length, 0);
  const fs = memoryFs();
  await createSettingsStore(fs, '/d').update({ addedModels: [{ provider: 'codex', id: 'gpt-x' }] });
  const failing = platformFor({ env: { MODE: 'error' }, fs });
  assert.deepEqual((await codexProvider(failing, { binaryPath: null, dataDir: '/d', home: '/h' }).models()).map((m) => [m.id, m.source]), [['gpt-x', 'added']]);
});

test('mapCodexModelList reads alternative spellings and ignores junk', () => {
  const { models, next } = mapCodexModelList({ models: [{ model: 'a', display_name: 'A', supported_reasoning_efforts: ['high', 'max', 'weird'] }, { nothing: true }, 'b', null], next_cursor: '' });
  assert.deepEqual(models.map((m) => [m.id, m.label, m.efforts]), [['a', 'A', ['high', 'max']], ['b', 'b', []]]);
  assert.equal(next, null);
  assert.deepEqual(mapCodexModelList([{ id: 'x' }]).models.map((m) => m.id), ['x']);
  assert.deepEqual(mapCodexModelList(undefined), { models: [], next: null });
});

test('check 2: the Claude list is the built-in aliases plus added IDs', async () => {
  const fs = memoryFs();
  const provider = claudeProvider({ fs, which: async () => null }, { binaryPath: null, dataDir: '/d', home: '/h' });
  const builtin = await provider.models();
  assert.deepEqual(builtin.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.ok(builtin.every((m) => m.source === 'builtin' && m.hint && m.label && m.efforts.join() === 'low,medium,high,xhigh,max'));
  await createSettingsStore(fs, '/d').update({ addedModels: [{ provider: 'claude', id: 'claude-opus-4-1' }, { provider: 'claude', id: 'sonnet' }, { provider: 'codex', id: 'nope' }] });
  const withAdded = await provider.models();
  assert.deepEqual(withAdded.map((m) => [m.id, m.source]).slice(4), [['claude-opus-4-1', 'added']], 'listed on the next call; an alias is not repeated');
  assert.equal(claudeModels([]).length, 4);
});

test('check 2: an endpoint\'s list comes from GET /models and its status names itself', async () => {
  const fetchFn = scriptedFetch([{ models: ['m1', 'm2'] }, { models: [] }]);
  const providers = createProviders({ fs: memoryFs(), fetch: fetchFn, which: async () => null }, { dataDir: '/d', home: '/h', endpoints: [{ name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1/', key: 'k' }] });
  const p = providers.get('oss:openrouter');
  assert.equal(p.id, 'oss:openrouter');
  assert.deepEqual((await p.models()).map((m) => m.id), ['m1', 'm2']);
  assert.equal((await p.status()).provider, 'oss:openrouter');
});

test('check 2: oss:<name> providers follow settings.endpoints: added, replaced when changed, removed; others untouched', () => {
  const platform = { fs: memoryFs(), fetch: scriptedFetch([]), which: async () => null };
  const providers = createProviders(platform, { dataDir: '/d', home: '/h', oss: { baseUrl: 'http://dev/v1' } });
  assert.deepEqual([...providers.keys()].sort(), ['claude', 'codex', 'local', 'oss:default']);
  syncEndpointProviders(platform, providers, [{ name: 'a', baseUrl: 'http://a/v1', key: null }, { name: ' b ', baseUrl: 'http://b/v1', key: 'k' }, { name: '', baseUrl: 'http://x', key: null }, { name: 'c', baseUrl: '', key: null }]);
  assert.deepEqual([...providers.keys()].sort(), ['claude', 'codex', 'local', 'oss:a', 'oss:b', 'oss:default']);
  const a = providers.get('oss:a');
  syncEndpointProviders(platform, providers, [{ name: 'a', baseUrl: 'http://a/v1', key: null }]);
  assert.equal(providers.get('oss:a'), a, 'unchanged: same instance');
  assert.equal(providers.has('oss:b'), false);
  syncEndpointProviders(platform, providers, [{ name: 'a', baseUrl: 'http://a2/v1', key: null }]);
  assert.notEqual(providers.get('oss:a'), a, 'a changed address replaces it');
  syncEndpointProviders(platform, providers, []);
  assert.deepEqual([...providers.keys()].sort(), ['claude', 'codex', 'local', 'oss:default']);
});
