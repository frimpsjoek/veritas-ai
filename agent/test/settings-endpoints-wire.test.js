// spec 016 E3: GET /providers/models for every provider id (oss:<name> included) and the new settings keys over the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentd } from '../src/node/agentd.mjs';
import { createLocalRuntime } from '../src/core.js';
import { createProviders } from '../src/providers/index.js';
import { memoryFs } from './support/memory-fs.mjs';

const noopLibrary = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
const gateway = { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; }, async save() {}, async remove() {}, rows: () => [] }, async dispose() {} };

async function withAgentd(run) {
  const fs = memoryFs();
  const fetchFn = async (url) => {
    if (String(url).startsWith('https://openrouter.ai/api/v1/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'or/a' }, { id: 'or/b' }] }) };
    throw new Error('ECONNREFUSED');
  };
  const platform = { fs, fetch: fetchFn, which: async () => null };
  const providers = createProviders(platform, { dataDir: 'data', home: '/h' });
  const service = await createLocalRuntime({ platform, library: noopLibrary, notes: {}, dataDir: 'data', providers, gateway });
  const agentd = createAgentd(service, { secret: 's', mcpHandler: async () => ({ status: 200, body: '{}' }) });
  const base = `http://127.0.0.1:${await agentd.listen(0)}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: 'Bearer s', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  try { await run(call, service); } finally { await agentd.close(); await service.dispose(); }
}

test('check 2 and E3: GET /providers/models answers for claude, codex, local and an oss:<name> added through settings', async () => {
  await withAgentd(async (call) => {
    const claude = await call('GET', '/providers/models?provider=claude');
    assert.equal(claude.status, 200);
    assert.deepEqual(claude.body.map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
    assert.deepEqual((await call('GET', '/providers/models?provider=codex')).body, [], 'Codex is not installed here');
    assert.equal((await call('GET', '/providers/models?provider=local')).status, 200);
    assert.deepEqual((await call('GET', `/providers/models?provider=${encodeURIComponent('oss:or')}`)).body, [], 'unknown until the endpoint is saved');

    const saved = await call('POST', '/settings', { endpoints: [{ name: 'or', baseUrl: 'https://openrouter.ai/api/v1', key: 'k' }] });
    assert.equal(saved.status, 200);
    const models = await call('GET', `/providers/models?provider=${encodeURIComponent('oss:or')}`);
    assert.deepEqual(models.body.map((m) => m.id), ['or/a', 'or/b']);
    const status = (await call('GET', '/providers')).body.find((p) => p.provider === 'oss:or');
    assert.equal(status.state, 'ready');

    await call('POST', '/settings', { endpoints: [] });
    assert.deepEqual((await call('GET', `/providers/models?provider=${encodeURIComponent('oss:or')}`)).body, [], 'removed with the endpoint');
  });
});

test('E3: the new settings keys round-trip over the wire; a null role clears it; added models list on the next call', async () => {
  await withAgentd(async (call) => {
    await call('POST', '/settings', {
      defaultModel: { provider: 'claude', model: 'sonnet', effort: 'high' }, shownModels: ['claude:sonnet', 'codex:gpt-5.5'],
      addedModels: [{ provider: 'claude', id: 'claude-opus-4-1' }], roles: { writer: { provider: 'claude', model: 'opus', effort: 'max' } },
    });
    const s = (await call('GET', '/settings')).body;
    assert.deepEqual(s.defaultModel, { provider: 'claude', model: 'sonnet', effort: 'high' });
    assert.deepEqual(s.shownModels, ['claude:sonnet', 'codex:gpt-5.5']);
    assert.deepEqual(s.roles.writer, { provider: 'claude', model: 'opus', effort: 'max' });
    assert.deepEqual(s.roles.chat, { provider: 'claude', model: 'sonnet', effort: 'high' }, 'an unchosen role reads the default');
    assert.equal((await call('GET', '/providers/models?provider=claude')).body.at(-1).id, 'claude-opus-4-1');

    await call('POST', '/settings', { roles: { writer: null } });
    assert.deepEqual((await call('GET', '/settings')).body.roles.writer, { provider: 'claude', model: 'sonnet', effort: 'high' });
    assert.equal('localSearchBackend' in (await call('GET', '/settings')).body, false);
  });
});
