import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRadarStore, emptyState, normaliseState, trimState, MAX_SEEN } from '../src/radar-state.js';
import { memoryFs } from './support/memory-fs.mjs';

test('state round-trips at <dataDir>/radar/<id>/state.json and reads empty when missing or torn', async () => {
  const fs = memoryFs();
  const store = createRadarStore(fs, '/data');
  assert.deepEqual(await store.read('r1'), emptyState());
  const state = { ...emptyState(), seen: { 'doi:10.1/x': { at: '2026-10-07T07:00:00.000Z', verdict: 'shown' } } };
  await store.write('r1', state);
  assert.ok(fs.files.has('/data/radar/r1/state.json'));
  assert.deepEqual(await store.read('r1'), state);
  fs.files.set('/data/radar/r1/state.json', '{ torn');
  assert.deepEqual(await store.read('r1'), emptyState());
  await assert.rejects(store.read('../etc'), /Invalid routine id/);
});

test('an older or partial file reads with every field present', () => {
  assert.deepEqual(normaliseState({ seen: { a: { at: 'x', verdict: 'shown' } } }), { ...emptyState(), seen: { a: { at: 'x', verdict: 'shown' } } });
  assert.deepEqual(normaliseState(null), emptyState());
  assert.deepEqual(normaliseState({ seen: [1], examples: 'x' }), emptyState());
});

test('the seen set keeps the newest entries past the cap', () => {
  const seen = {};
  for (let i = 0; i < MAX_SEEN + 10; i++) seen[`doi:${i}`] = { at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(6, '0')}Z`, verdict: 'shown' };
  const trimmed = trimState({ ...emptyState(), seen });
  assert.equal(Object.keys(trimmed.seen).length, MAX_SEEN);
  assert.ok(trimmed.seen[`doi:${MAX_SEEN + 9}`] || trimmed.seen['doi:59'], 'recent entries survive');
});
