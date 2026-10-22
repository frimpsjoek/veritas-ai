import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsStore, DEFAULT_SOURCE_SWITCHES, sourceSwitches } from '../src/settings.js';
import { memoryFs } from './support/memory-fs.mjs';

test('source switches: unsaved reads as all on and stays null in the file', async () => {
  const fs = memoryFs();
  const store = createSettingsStore(fs, 'data');
  assert.equal((await store.get()).sources, null);
  assert.deepEqual(await store.sourceDefaults(), DEFAULT_SOURCE_SWITCHES);
  await store.update({ webSearchDefault: 'cached' });
  assert.equal(JSON.parse(await fs.read('data/settings.json')).sources, null, 'an unrelated change does not freeze the defaults');
});

test('source switches: a patch may name one key; the others keep their value; non-booleans are ignored', async () => {
  const fs = memoryFs();
  const store = createSettingsStore(fs, 'data');
  await store.update({ sources: { notes: false } });
  assert.deepEqual(await store.sourceDefaults(), { papers: true, notes: false, scholarly: true, web: false });
  await store.update({ sources: { scholarly: false, papers: 'yes', extra: true } });
  assert.deepEqual((await store.get()).sources, { papers: true, notes: false, scholarly: false, web: false });
  await store.update({ sources: { web: true } });
  assert.deepEqual((await store.get()).sources, { papers: true, notes: false, scholarly: false, web: true }, 'web is a fourth switch');
  assert.equal((await store.get()).webSearchDefault, 'off', 'turning it on does not touch the Research mode');
  await store.update({ sources: { web: false } });
  const reread = createSettingsStore(fs, 'data');
  assert.deepEqual(await reread.sourceDefaults(), { papers: true, notes: false, scholarly: false, web: false }, 'saved to settings.json');
  await reread.update({ sources: null });
  assert.equal((await reread.get()).sources, null, 'null goes back to the defaults');
});

test('sourceSwitches fills in what an old or partial record lacks', () => {
  assert.deepEqual(sourceSwitches({}), DEFAULT_SOURCE_SWITCHES);
  assert.deepEqual(sourceSwitches({ sources: { papers: false, notes: true, scholarly: true } }), { papers: false, notes: true, scholarly: true, web: false });
});

test('the optional valency switch is kept once set and absent until then', async () => {
  const { sourceSwitches: sw } = await import('../src/settings.js');
  assert.equal('valency' in sw({}), false);
  assert.equal(sw({ sources: { papers: true, notes: true, scholarly: true, web: false, valency: false } }).valency, false);
});
