// Sources chips: settings.sources over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentd } from '../src/node/agentd.mjs';
import { createLocalRuntime } from '../src/core.js';
import { createProviders } from '../src/providers/index.js';
import { memoryFs } from './support/memory-fs.mjs';

const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
const gateway = { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; }, async save() {}, async remove() {}, rows: () => [] }, async dispose() {} };

test('POST /settings sources round-trips; one key keeps the others; null resets', async () => {
  const platform = { fs: memoryFs(), fetch: async () => { throw new Error('ECONNREFUSED'); }, which: async () => null };
  const service = await createLocalRuntime({ platform, library, notes: {}, dataDir: 'data', providers: createProviders(platform, { dataDir: 'data', home: '/h' }), gateway });
  const agentd = createAgentd(service, { secret: 's', mcpHandler: async () => ({ status: 200, body: '{}' }) });
  const base = `http://127.0.0.1:${await agentd.listen(0)}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: 'Bearer s', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await call('GET', '/settings')).body.sources, null, 'never chosen');
    assert.equal((await call('POST', '/settings', { sources: { notes: false } })).status, 200);
    assert.deepEqual((await call('GET', '/settings')).body.sources, { papers: true, notes: false, scholarly: true, web: false });
    await call('POST', '/settings', { sources: { scholarly: false } });
    assert.deepEqual((await call('GET', '/settings')).body.sources, { papers: true, notes: false, scholarly: false, web: false }, 'a single key leaves the others');
    await call('POST', '/settings', { webSearchDefault: 'live' });
    assert.deepEqual((await call('GET', '/settings')).body.sources, { papers: true, notes: false, scholarly: false, web: false }, 'an unrelated save keeps them');
    await call('POST', '/settings', { sources: null });
    assert.equal((await call('GET', '/settings')).body.sources, null);
  } finally { await agentd.close(); await service.dispose(); }
});
