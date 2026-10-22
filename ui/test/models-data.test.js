import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelsStore, parseKey, modelKey, providerState, pickableModels, checklist, endpointProblem, normalizeAddress, shownList } from '../src/settings/models-data.js';

const claudeModels = [
  { id: 'sonnet', label: 'Sonnet', hint: 'good for most questions', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], source: 'builtin', isDefault: false },
  { id: 'haiku', label: 'Haiku', hint: 'fastest', efforts: [], source: 'builtin', isDefault: false },
];

/** An engine in memory: settings.update merges like the real one (null role clears, other keys replace). */
function fakeAi({ statuses } = {}) {
  const settings = { roles: { chat: { provider: 'codex', model: null }, researcher: { provider: 'codex', model: null } }, endpoints: [], shownModels: [], addedModels: [], defaultModel: null };
  const calls = { models: [], updates: [] };
  const lists = { claude: [...claudeModels], codex: [{ id: 'gpt-5.5', label: 'GPT-5.5', hint: null, efforts: ['low', 'high'], source: 'provider', isDefault: true }] };
  const ai = {
    settings: {
      get: async () => structuredClone(settings),
      update: async (patch) => {
        calls.updates.push(structuredClone(patch));
        for (const [role, v] of Object.entries(patch.roles ?? {})) { if (v === null) delete settings.roles[role]; else settings.roles[role] = v; }
        for (const k of ['endpoints', 'shownModels', 'addedModels', 'defaultModel']) if (patch[k] !== undefined) settings[k] = patch[k];
        return structuredClone(settings);
      },
    },
    providers: {
      status: async () => statuses ?? [
        { provider: 'claude', state: 'ready', account: { kind: 'claude', label: 'me@x.org', plan: 'Max' }, installHelp: null },
        { provider: 'codex', state: 'missing', account: { kind: 'none', label: null, plan: null }, installHelp: 'Install the ChatGPT app.' },
      ],
      models: async (provider) => {
        calls.models.push(provider);
        if (provider.startsWith('oss:')) return lists[provider] ?? [{ id: 'llama-3', label: 'llama-3', hint: null, efforts: [], source: 'provider', isDefault: false }];
        const added = settings.addedModels.filter((a) => a.provider === provider).map((a) => ({ id: a.id, label: a.id, hint: null, efforts: [], source: 'added', isDefault: false }));
        return [...(lists[provider] ?? []), ...added];
      },
    },
  };
  return { ai, settings, calls };
}

const loaded = async (opts) => { const f = fakeAi(opts); const store = new ModelsStore(f.ai); await store.load(); return { ...f, store }; };

test('keys split into provider and model, endpoints and models with colons included', () => {
  assert.deepEqual(parseKey('claude:sonnet'), { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(parseKey('oss:or:meta/llama:free'), { provider: 'oss:or', model: 'meta/llama:free' });
  assert.deepEqual(parseKey('local:ollama:x'), { provider: 'local', model: 'ollama:x' });
  assert.equal(modelKey('codex', 'gpt-5.5'), 'codex:gpt-5.5');
});

test('saving the default writes defaultModel with its effort, and clears the tasks already set to it', async () => {
  const f = fakeAi();
  f.settings.roles.writer = { provider: 'claude', model: 'sonnet', effort: 'high' };
  const store = new ModelsStore(f.ai);
  await store.load();
  const { settings } = f;
  await store.saveDefault('claude:sonnet', 'high');
  assert.deepEqual(settings.defaultModel, { provider: 'claude', model: 'sonnet', effort: 'high' });
  assert.equal(settings.roles.writer, undefined, 'a task equal to the new default reads "Same as default"');
  assert.ok(settings.roles.chat, 'other tasks are left alone');
  await store.saveDefault('');
  assert.equal(settings.defaultModel, null);
});

test('a task set back to "Same as default" is written as roles:{x:null}; a task with its own model keeps provider, model, effort', async () => {
  const { store, calls, settings } = await loaded();
  await store.saveTask('chat', '');
  assert.deepEqual(calls.updates.at(-1), { roles: { chat: null } });
  assert.equal(settings.roles.chat, undefined);
  await store.saveTask('writer', 'claude:sonnet', 'max');
  assert.deepEqual(settings.roles.writer, { provider: 'claude', model: 'sonnet', effort: 'max' });
});

test('ticking a model writes shownModels as "provider:id", and unticking removes only that one', async () => {
  const { store, settings } = await loaded();
  await store.tick('claude', 'sonnet', true);
  await store.tick('claude', 'haiku', true);
  assert.deepEqual(settings.shownModels, ['claude:sonnet', 'claude:haiku']);
  await store.tick('claude', 'sonnet', false);
  assert.deepEqual(settings.shownModels, ['claude:haiku']);
  assert.deepEqual(checklist(store.state, 'claude').map((m) => [m.id, m.on, m.hint]), [['sonnet', false, 'good for most questions'], ['haiku', true, 'fastest']]);
});

test('Add a model ID writes addedModels, the model appears in the list ticked, and a repeat adds nothing', async () => {
  const { store, settings } = await loaded();
  assert.equal(await store.addModelId('claude', '  claude-sonnet-4-5-20250929 '), 'claude-sonnet-4-5-20250929');
  assert.deepEqual(settings.addedModels, [{ provider: 'claude', id: 'claude-sonnet-4-5-20250929' }]);
  assert.deepEqual(settings.shownModels, ['claude:claude-sonnet-4-5-20250929']);
  assert.ok(checklist(store.state, 'claude').some((m) => m.id === 'claude-sonnet-4-5-20250929' && m.on));
  await store.addModelId('claude', 'claude-sonnet-4-5-20250929');
  assert.equal(settings.addedModels.length, 1);
  assert.equal(await store.addModelId('claude', '   '), null);
});

test('an endpoint is saved with its address and key, and Fetch models asks /providers/models for oss:<name>', async () => {
  const { store, settings, calls } = await loaded();
  await store.saveEndpoint({ name: 'or', baseUrl: 'https://openrouter.ai/api/v1', key: 'sk-1' });
  assert.deepEqual(settings.endpoints, [{ name: 'or', baseUrl: 'https://openrouter.ai/api/v1', key: 'sk-1' }]);
  const list = await store.fetchEndpointModels('or');
  assert.deepEqual(calls.models.at(-1), 'oss:or');
  assert.deepEqual(list.map((m) => m.id), ['llama-3']);
  await store.saveEndpoint({ name: 'or', baseUrl: 'https://openrouter.ai/api/v1', key: '' });
  assert.equal(settings.endpoints.length, 1, 'saving the same name replaces it');
  assert.equal(settings.endpoints[0].key, null);
  await store.tick('oss:or', 'llama-3', true);
  await store.removeEndpoint('or');
  assert.deepEqual([settings.endpoints, settings.shownModels], [[], []]);
});

test('a provider row says what it is and offers the one fix', async () => {
  const { store } = await loaded();
  const [claude, codex] = ['claude', 'codex'].map((p) => providerState(store.state.statuses.find((s) => s.provider === p), p));
  assert.deepEqual([claude.pill, claude.action, claude.note], ['Ready', null, 'Signed in as me@x.org · Max']);
  assert.deepEqual([codex.pill, codex.action, codex.note], ['Not installed', 'install', 'Install the ChatGPT app.']);
  assert.deepEqual(providerState({ state: 'signed_out' }, 'codex').action, 'signIn');
  assert.deepEqual(checklist(store.state, 'codex'), [], 'a provider that is not ready lists no models');
});

test('the pickers offer the models of ready providers, and keep a current choice whose provider is not ready', async () => {
  const { store } = await loaded();
  assert.deepEqual(pickableModels(store.state, null).map((o) => o.value), ['claude:sonnet', 'claude:haiku']);
  const kept = pickableModels(store.state, { provider: 'codex', model: 'gpt-5.5' });
  assert.deepEqual(kept.at(-1), { value: 'codex:gpt-5.5', label: 'Codex · gpt-5.5' });
});

test('the menu list is the ticked models with their provider labels', () => {
  const rows = shownList(['claude:sonnet', 'claude:custom-id', 'oss:or:llama'], { claude: claudeModels });
  assert.deepEqual(rows.map((r) => [r.provider, r.model, r.label]), [['claude', 'sonnet', 'Sonnet'], ['claude', 'custom-id', 'custom-id'], ['oss:or', 'llama', 'llama']]);
});

test('an endpoint draft needs a name and an address; the address gets its scheme', () => {
  assert.equal(endpointProblem({ name: '', baseUrl: 'x' }, []), 'Give it a name.');
  assert.equal(endpointProblem({ name: 'a b', baseUrl: 'x' }, []), 'Use letters, numbers, dots or dashes in the name.');
  assert.equal(endpointProblem({ name: 'or', baseUrl: '' }, []), 'Enter its address.');
  assert.match(endpointProblem({ name: 'or', baseUrl: 'x' }, ['or']), /already/);
  assert.equal(endpointProblem({ name: 'or', baseUrl: 'x' }, []), null);
  assert.equal(normalizeAddress('localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(normalizeAddress(' https://a.b/v1 '), 'https://a.b/v1');
});
