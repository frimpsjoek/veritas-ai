import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, readLocalSettings, localRoleRefusal, DEFAULT_LOCAL, defaultSettings } from '../src/settings.js';
import { memoryFs } from './support/memory-fs.mjs';

test('defaults: the Content drive, the HF cache, 5 idle minutes, reports off', async () => {
  const s = defaultSettings();
  assert.deepEqual(s.local, DEFAULT_LOCAL);
  assert.equal(s.local.idleMinutes, 5);
  assert.equal(s.local.allowReports, false);
  assert.ok(s.local.scanDirs.includes('/Volumes/Content/models'));
  assert.equal(s.local.python, null);
});

test('update({local}) merges field by field and sanitizes', async () => {
  const fs = memoryFs();
  const store = createSettingsStore(fs, 'data');
  await store.update({ local: { idleMinutes: 10 } });
  assert.equal((await store.get()).local.idleMinutes, 10);
  assert.deepEqual((await store.get()).local.scanDirs, DEFAULT_LOCAL.scanDirs, 'untouched fields keep their value');
  await store.update({ local: { idleMinutes: -3, scanDirs: [' /a ', '', 7], python: '  ', allowReports: 'yes' } });
  const local = (await store.get()).local;
  assert.equal(local.idleMinutes, 5, 'nonsense falls back to the default');
  assert.deepEqual(local.scanDirs, ['/a']);
  assert.equal(local.python, null);
  assert.equal(local.allowReports, false, 'only a real true turns the switch on');
  // readLocalSettings sees the persisted file, fresh
  assert.equal((await readLocalSettings(fs, 'data')).scanDirs[0], '/a');
  assert.deepEqual(await readLocalSettings(memoryFs(), 'data'), DEFAULT_LOCAL);
});

test('setRole refuses a local model for report roles unless the switch is on', async () => {
  const store = createSettingsStore(memoryFs(), 'data');
  const local = { provider: 'local', model: null };
  await store.setRole('chat', local);
  await store.setRole('ask', local);
  for (const role of ['lead', 'researcher', 'writer', 'extract']) {
    await assert.rejects(() => store.setRole(role, local), /only answer questions in Chat and Ask/);
  }
  assert.equal((await store.roles()).lead.provider, 'codex', 'a refused choice changes nothing');
  await store.update({ local: { allowReports: true } });
  await store.setRole('lead', local);
  assert.equal((await store.roles()).lead.provider, 'local');
  await store.setRole('extract', null); // clearing is always fine
});

test('localRoleRefusal is about local choices only', () => {
  assert.equal(localRoleRefusal('lead', { provider: 'codex', model: null }, { allowReports: false }), null);
  assert.equal(localRoleRefusal('lead', null, { allowReports: false }), null);
  assert.match(localRoleRefusal('writer', { provider: 'local', model: null }, { allowReports: false }), /Chat and Ask/);
  assert.equal(localRoleRefusal('chat', { provider: 'local', model: null }, { allowReports: false }), null);
});
