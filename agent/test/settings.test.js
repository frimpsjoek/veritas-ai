import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, DEFAULT_TURN_WALL_CLOCK_MS, DEFAULT_TOOL_CALL_BUDGET } from '../src/settings.js';
import { memoryFs } from './support/memory-fs.mjs';

test('turnLimits(): defaults per role with no settings.json written', async () => {
  const store = createSettingsStore(memoryFs(), 'data');
  for (const role of ['chat', 'ask', 'lead', 'researcher', 'writer']) {
    const limits = await store.turnLimits(role);
    assert.equal(limits.wallClockMs, DEFAULT_TURN_WALL_CLOCK_MS[role]);
    assert.equal(limits.toolCallBudget, DEFAULT_TOOL_CALL_BUDGET);
  }
});

test('turnLimits(): an update() patch overrides one role\'s wall clock and the global tool budget, leaving the rest at default', async () => {
  const store = createSettingsStore(memoryFs(), 'data');
  await store.update({ turnLimits: { wallClockMs: { researcher: 60_000 }, toolCallBudget: 10 } });

  const researcher = await store.turnLimits('researcher');
  assert.equal(researcher.wallClockMs, 60_000);
  assert.equal(researcher.toolCallBudget, 10);

  const chat = await store.turnLimits('chat');
  assert.equal(chat.wallClockMs, DEFAULT_TURN_WALL_CLOCK_MS.chat, 'a role not named in the patch keeps its default');
  assert.equal(chat.toolCallBudget, 10, 'the tool-call budget is global, not per-role');
});

test('turnLimits(): the override survives a second update() to an unrelated field (merge, not replace)', async () => {
  const store = createSettingsStore(memoryFs(), 'data');
  await store.update({ turnLimits: { wallClockMs: { lead: 90_000 }, toolCallBudget: null } });
  await store.update({ webSearchDefault: 'live' });
  const lead = await store.turnLimits('lead');
  assert.equal(lead.wallClockMs, 90_000);
});

test('a role the user never chose follows the first ready cloud provider; a saved role is never replaced; saving something else does not freeze the default', async () => {
  const { createSettingsStore } = await import('../src/settings.js');
  const fs = memoryFs();
  let ready = 'claude';
  const make = () => createSettingsStore(fs, '/d', { cloudDefault: async () => ready });
  const a = make();
  assert.equal((await a.roleModel('chat')).provider, 'claude');
  assert.equal((await a.roles()).writer.provider, 'claude');
  await a.setRole('chat', { provider: 'local', model: 'm' });
  await a.update({ webSearchDefault: 'live' });
  const file = JSON.parse(await fs.read('/d/settings.json'));
  assert.deepEqual(Object.keys(file.roles), ['chat']); // only the chosen role is on disk
  ready = 'codex';
  const b = make();
  assert.equal((await b.roleModel('chat')).provider, 'local');
  assert.equal((await b.roleModel('ask')).provider, 'codex'); // follows what is ready now
  ready = null;
  assert.equal((await make().roleModel('lead')).provider, 'codex'); // nothing ready: the old default
});

test('the cloud default is not remembered while a provider is still loading, and is once settled', async () => {
  const { createLocalRuntime } = await import('../src/core.js');
  let state = 'loading';
  const prov = (id) => ({ id, caps: {}, async status() { return { provider: id, state: id === 'claude' ? state : 'missing' }; }, async models() { return []; }, async dispose() {} });
  const ai = await createLocalRuntime({
    platform: { fs: memoryFs() }, library: { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } },
    notes: {}, dataDir: '/d', providers: new Map([['codex', prov('codex')], ['claude', prov('claude')]]),
    gateway: { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; } }, async dispose() {} },
  });
  assert.equal((await ai.providers.roles()).chat.provider, 'codex'); // nothing ready yet: the old default
  state = 'ready';
  assert.equal((await ai.providers.roles()).chat.provider, 'claude'); // seen at once, not after a 15 s cache
  state = 'missing';
  assert.equal((await ai.providers.roles()).chat.provider, 'claude'); // a settled answer is kept
  await ai.dispose();
});
