// Sources chips: an outside server's `enabled` flag is its on/off switch, saved and honoured by the next turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createToolGateway } from '../src/tools.js';
import { memoryFs } from './support/memory-fs.mjs';
import { fakeMcpSpawn } from './fake-mcp.mjs';

const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
const CONFIG = { name: 'lib', enabled: true, transport: 'stdio', command: process.execPath, args: [], env: {}, trustUnmarked: true };

test('mcp.save with enabled false disables the server, persists it, hides its tools; enabled true reconnects', async () => {
  const fs = memoryFs();
  const gateway = await createToolGateway(fetch, library, { spawn: fakeMcpSpawn([{ name: 'mystery', description: 'no annotations' }]) });
  const service = await createLocalRuntime({ platform: { fs }, library, notes: {}, dataDir: '/d', providers: new Map(), gateway });
  const toolNames = () => {
    const s = gateway.open({ scope: { kind: 'library' }, web: 'off', sources: { papers: true, notes: true, scholarly: true, web: false }, audit: 't' });
    const names = s.specs.map((t) => t.name);
    s.close();
    return names;
  };
  try {
    assert.equal((await service.mcp.save(CONFIG)).state, 'connected');
    assert.ok(toolNames().includes('lib__mystery'));

    const off = await service.mcp.save({ ...CONFIG, enabled: false });
    assert.equal(off.state, 'disabled');
    assert.equal(off.config.trustUnmarked, true, 'the trust choice survives');
    assert.equal(toolNames().some((n) => n.startsWith('lib__')), false);
    const saved = JSON.parse(await fs.read('/d/settings.json'));
    assert.deepEqual(saved.mcp.map((c) => [c.name, c.enabled, c.trustUnmarked]), [['lib', false, true]]);

    assert.equal((await service.mcp.save(CONFIG)).state, 'connected');
    assert.ok(toolNames().includes('lib__mystery'));
  } finally { await service.dispose(); }
});
