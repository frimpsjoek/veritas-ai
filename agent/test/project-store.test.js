import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectStore, mergeProjects } from '../src/project-store.js';
import { memoryFs } from './support/memory-fs.mjs';

const t0 = '2026-05-01T00:00:00.000Z';
const t1 = '2026-05-02T00:00:00.000Z';

test('create and list: one file per project under projects/, in name order', async () => {
  const fs = memoryFs();
  const store = createProjectStore(fs, 'data');
  await store.create('b', 'Voles', t0);
  await store.create('a', '  zebra   finches ', t0);
  await store.create('c', 'apes', t0);
  assert.ok(fs.files.has('data/projects/b.json'));
  assert.deepEqual((await store.list()).map((p) => p.name), ['apes', 'Voles', 'zebra finches']);
  assert.deepEqual(JSON.parse(fs.files.get('data/projects/b.json')), { id: 'b', name: 'Voles', created: t0, updated: t0 });
});

test('a blank or very long name is refused in plain words; ids with separators are refused', async () => {
  const store = createProjectStore(memoryFs(), 'data');
  await assert.rejects(() => store.create('a', '   ', t0), /Give the project a name/);
  await assert.rejects(() => store.create('a', 'x'.repeat(81), t0), /at most 80/);
  await assert.rejects(() => store.read('../evil'), /no project with that id/);
});

test('rename keeps created and sets updated; renaming an unknown project is refused', async () => {
  const store = createProjectStore(memoryFs(), 'data');
  await store.create('a', 'Voles', t0);
  const renamed = await store.rename('a', 'Field voles', t1);
  assert.deepEqual(renamed, { id: 'a', name: 'Field voles', created: t0, updated: t1 });
  assert.equal((await store.read('a')).name, 'Field voles');
  await assert.rejects(() => store.rename('nope', 'x', t1), /no project with that id/);
});

test('remove deletes the file; removing it again is harmless', async () => {
  const store = createProjectStore(memoryFs(), 'data');
  await store.create('a', 'Voles', t0);
  await store.remove('a');
  assert.deepEqual(await store.list(), []);
  await store.remove('a');
});

test('list skips torn, nameless and foreign files', async () => {
  const fs = memoryFs();
  const store = createProjectStore(fs, 'data');
  await store.create('ok', 'Voles', t0);
  fs.files.set('data/projects/bad.json', '{ not json');
  fs.files.set('data/projects/noname.json', '{"id":"noname"}');
  fs.files.set('data/projects/readme.txt', 'hi');
  assert.deepEqual((await store.list()).map((p) => p.id), ['ok']);
  assert.equal(await store.read('bad'), null);
});

test('an empty or missing projects folder lists nothing', async () => {
  assert.deepEqual(await createProjectStore(memoryFs(), 'data').list(), []);
});

test('adopt is idempotent by id and returns the ids taken in; unusable records are left out', async () => {
  const fs = memoryFs();
  const store = createProjectStore(fs, 'data');
  const rec = { id: 'a', name: 'Voles', created: t0, updated: t0 };
  assert.deepEqual(await store.adopt([rec, { id: '../x', name: 'bad' }, { id: 'n' }, null]), ['a']);
  const before = fs.files.get('data/projects/a.json');
  assert.deepEqual(await store.adopt([rec]), ['a']);
  assert.equal(fs.files.get('data/projects/a.json'), before);
  assert.equal((await store.list()).length, 1);
});

test('adopt keeps the later updated copy, whichever side holds it', async () => {
  const store = createProjectStore(memoryFs(), 'data');
  await store.create('a', 'Voles', t0);
  await store.adopt([{ id: 'a', name: 'Field voles', created: t0, updated: t1 }]);
  assert.equal((await store.read('a')).name, 'Field voles');
  await store.adopt([{ id: 'a', name: 'Old name', created: t0, updated: t0 }]);
  assert.equal((await store.read('a')).name, 'Field voles');
  const a = { id: 'a', name: 'A', created: t0, updated: t0 }, b = { ...a, name: 'B', updated: t1 };
  assert.equal(mergeProjects(a, b).name, 'B');
  assert.equal(mergeProjects(b, a).name, 'B');
});
