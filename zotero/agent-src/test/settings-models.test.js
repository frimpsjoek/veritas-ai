// spec 016 E1: the default model, role clearing, old files, and the web-search default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, defaultSettings, useOneDefault } from '../src/settings.js';
import { createLocalRuntime } from '../src/core.js';
import { memoryFs } from './support/memory-fs.mjs';

const SONNET = { provider: 'claude', model: 'sonnet' };

test('check 1: a role saves {provider, model, effort}', async () => {
  const fs = memoryFs();
  const store = createSettingsStore(fs, '/d');
  await store.update({ roles: { writer: { provider: 'claude', model: 'opus', effort: 'xhigh' } } });
  const file = JSON.parse(await fs.read('/d/settings.json'));
  assert.deepEqual(file.roles.writer, { provider: 'claude', model: 'opus', effort: 'xhigh' });
  assert.deepEqual(await store.roleModel('writer'), { provider: 'claude', model: 'opus', effort: 'xhigh' });
});

test('check 1: unchosen roles resolve to the default model; "Same as default" (null) writes nothing for the role', async () => {
  const fs = memoryFs();
  const store = createSettingsStore(fs, '/d', { cloudDefault: async () => 'codex' });
  assert.deepEqual(await store.roleModel('chat'), { provider: 'codex', model: null }, 'no default model: today\'s behaviour');
  await store.update({ defaultModel: { ...SONNET, effort: 'high' }, roles: { writer: { provider: 'claude', model: 'opus' } } });
  assert.deepEqual(await store.roleModel('chat'), { ...SONNET, effort: 'high' });
  assert.deepEqual(await store.roleModel('lead'), { ...SONNET, effort: 'high' });
  assert.deepEqual(await store.roleModel('writer'), { provider: 'claude', model: 'opus' });
  assert.equal((await store.get()).roles.ask.model, 'sonnet');
  await store.update({ roles: { writer: null } });
  assert.deepEqual(await store.roleModel('writer'), { ...SONNET, effort: 'high' }, 'cleared role follows the default');
  const file = JSON.parse(await fs.read('/d/settings.json'));
  assert.deepEqual(file.roles, {}, 'a cleared role is not written');
  assert.deepEqual(file.defaultModel, { ...SONNET, effort: 'high' });
  await store.setRole('chat', { provider: 'claude', model: 'haiku' });
  await store.setRole('chat', null);
  assert.equal((await store.roleModel('chat')).model, 'sonnet', 'setRole(role, null) clears any role');
});

test('check 1: a local default does not reach the report roles unless reports are allowed', async () => {
  const store = createSettingsStore(memoryFs(), '/d', { cloudDefault: async () => 'claude' });
  await store.update({ defaultModel: { provider: 'local', model: 'mlx:woof' } });
  assert.equal((await store.roleModel('chat')).provider, 'local');
  assert.deepEqual(await store.roleModel('writer'), { provider: 'claude', model: null });
  await store.update({ local: { allowReports: true } });
  assert.equal((await store.roleModel('writer')).provider, 'local');
});

test('check 1: an old settings file (every role claude/model null, localSearchBackend) loads unchanged; useOneDefault clears roles equal to the default', async () => {
  const fs = memoryFs();
  const old = { roles: Object.fromEntries(['chat', 'ask', 'lead', 'researcher', 'writer'].map((r) => [r, { provider: 'claude', model: null }])),
    endpoints: [], webSearchDefault: 'cached', localSearchBackend: { kind: 'exa', url: 'x', key: null }, mcp: [] };
  await fs.writeAtomic('/d/settings.json', JSON.stringify(old));
  const store = createSettingsStore(fs, '/d');
  const s = await store.get();
  assert.deepEqual(s.roles.writer, { provider: 'claude', model: null });
  assert.equal(s.defaultModel, null);
  assert.deepEqual([s.shownModels, s.addedModels], [[], []]);
  assert.equal(s.webSearchDefault, 'cached');
  assert.equal('localSearchBackend' in s, false);
  assert.equal('localSearchBackend' in defaultSettings(), false);

  const patch = useOneDefault(s, { provider: 'claude', model: null });
  assert.deepEqual(Object.keys(patch.roles).sort(), ['ask', 'chat', 'lead', 'researcher', 'writer']);
  await store.update(useOneDefault(s, SONNET)); // nothing equals sonnet: roles stay
  assert.equal((await store.roleModel('writer')).model, null);
  await store.update(patch);
  const file = JSON.parse(await fs.read('/d/settings.json'));
  assert.deepEqual(file.roles, {});
  assert.deepEqual(file.defaultModel, { provider: 'claude', model: null });
  assert.equal('localSearchBackend' in file, false, 'the dead key is dropped on the next save');
});

test('shownModels and addedModels are cleaned and persist', async () => {
  const fs = memoryFs();
  const store = createSettingsStore(fs, '/d');
  await store.update({ shownModels: ['claude:sonnet', 'claude:sonnet', 'codex:gpt-5.5', ''], addedModels: [{ provider: 'claude', id: ' claude-opus-4-1 ' }, { provider: 'claude', id: 'claude-opus-4-1' }, { provider: 'codex', id: '' }] });
  const s = await createSettingsStore(fs, '/d').get();
  assert.deepEqual(s.shownModels, ['claude:sonnet', 'codex:gpt-5.5']);
  assert.deepEqual(s.addedModels, [{ provider: 'claude', id: 'claude-opus-4-1' }]);
  await store.update({ webSearchDefault: 'live' });
  assert.equal((await store.get()).shownModels.length, 2, 'an unrelated update keeps them');
});

async function chatWebSeen(settings, sendInput) {
  const seen = [];
  const provider = {
    id: 'fake', caps: { nativeWebSearch: false, nativeStructuredOutput: false },
    async status() { return { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; }, async signIn() {}, async signOut() {},
    async *turn(req) { seen.push(req.web); yield { type: 'final', text: 'ok', json: null, usage: {} }; },
    async dispose() {},
  };
  const fs = memoryFs();
  const service = await createLocalRuntime({
    platform: { fs }, library: { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } },
    notes: {}, dataDir: '/d', providers: new Map([['fake', provider]]), getRoleModel: async () => ({ provider: 'fake', model: null }),
    gateway: { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; } }, async dispose() {} },
  });
  if (settings) await service.settings.update(settings);
  const id = await service.conversations.create('chat');
  for await (const ev of service.conversations.send(id, { text: 'hello', ...sendInput })) void ev;
  await service.dispose();
  return seen;
}

test('check 6: with no web in the message, sources.web switches it on and webSearchDefault only picks the mode; a message that says wins', async () => {
  assert.deepEqual(await chatWebSeen(null, {}), ['off']);
  assert.deepEqual(await chatWebSeen({ webSearchDefault: 'live' }, {}), ['off'], 'Research alone never turns the web on');
  assert.deepEqual(await chatWebSeen({ sources: { web: true } }, {}), ['live'], 'on with Research off or unknown is live');
  assert.deepEqual(await chatWebSeen({ sources: { web: true }, webSearchDefault: 'cached' }, {}), ['cached']);
  assert.deepEqual(await chatWebSeen({ sources: { web: true }, webSearchDefault: 'live' }, {}), ['live']);
  assert.deepEqual(await chatWebSeen({ webSearchDefault: 'live' }, { web: 'off' }), ['off']);
  assert.deepEqual(await chatWebSeen({ webSearchDefault: 'off' }, { web: 'cached' }), ['cached']);
});
