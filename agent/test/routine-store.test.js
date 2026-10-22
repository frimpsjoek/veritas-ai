import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoutineStore, mergeRoutines } from '../src/routine-store.js';
import { memoryFs } from './support/memory-fs.mjs';

const routine = (id, over = {}) => ({
  id, name: id, prompt: 'p', skills: [], depth: 'standard', schedule: { kind: 'daily', time: '07:00' }, target: { kind: 'session' },
  sources: null, scope: null, status: 'active', created: '2026-05-01T00:00:00.000Z', updated: '2026-05-01T00:00:00.000Z',
  lastSlot: null, lastRun: null, notify: false, ...over,
});

test('write then read and list: one file per routine under routines/, oldest first', async () => {
  const fs = memoryFs();
  const store = createRoutineStore(fs, 'data');
  await store.write(routine('b', { created: '2026-05-02T00:00:00.000Z' }));
  await store.write(routine('a'));
  assert.ok(fs.files.has('data/routines/a.json'));
  assert.deepEqual((await store.list()).map((r) => r.id), ['a', 'b']);
  assert.equal((await store.read('a')).name, 'a');
  assert.equal(await store.read('missing'), null);
});

test('list skips files that do not parse and ignores other files; ids with separators are refused', async () => {
  const fs = memoryFs();
  const store = createRoutineStore(fs, 'data');
  await store.write(routine('ok'));
  fs.files.set('data/routines/bad.json', '{ not json');
  fs.files.set('data/routines/noid.json', '{"name":"x"}');
  fs.files.set('data/routines/readme.txt', 'hi');
  assert.deepEqual((await store.list()).map((r) => r.id), ['ok']);
  await assert.rejects(() => store.write(routine('../evil')), /Invalid routine id/);
  await assert.rejects(() => store.read('a/b'), /Invalid routine id/);
});

test('an empty or missing routines folder lists nothing', async () => {
  assert.deepEqual(await createRoutineStore(memoryFs(), 'data').list(), []);
});

test('adopt is idempotent by id and returns the ids taken in', async () => {
  const fs = memoryFs();
  const store = createRoutineStore(fs, 'data');
  const records = [routine('x'), routine('y'), { name: 'no id' }, routine('../z')];
  assert.deepEqual(await store.adopt(records), ['x', 'y']);
  const before = new Map(fs.files);
  assert.deepEqual(await store.adopt(records), ['x', 'y']);
  assert.deepEqual([...fs.files], [...before], 'second adopt changes nothing');
});

test('adopt merges with an existing record, keeping the later lastSlot and its run', async () => {
  const fs = memoryFs();
  const store = createRoutineStore(fs, 'data');
  const run = (at) => ({ at, slot: at, status: 'done', added: 1 });
  await store.write(routine('r', { updated: '2026-05-03T00:00:00.000Z', name: 'server copy', lastSlot: '2026-05-04T07:00:00.000Z', lastRun: run('2026-05-04T07:00:05.000Z') }));
  await store.adopt([routine('r', { updated: '2026-05-05T00:00:00.000Z', name: 'zotero copy', lastSlot: '2026-05-02T07:00:00.000Z', lastRun: run('2026-05-02T07:00:05.000Z') })]);
  const merged = await store.read('r');
  assert.equal(merged.name, 'zotero copy', 'later-updated fields win');
  assert.equal(merged.lastSlot, '2026-05-04T07:00:00.000Z', 'but a slot already run is never forgotten');
  assert.equal(merged.lastRun.at, '2026-05-04T07:00:05.000Z');
});

test('mergeRoutines is symmetric in lastSlot and lastRun, and tolerates nulls', () => {
  const a = routine('r', { lastSlot: '2026-05-04T07:00:00.000Z', lastRun: { at: '2026-05-04T07:00:05.000Z', slot: 's', status: 'done' } });
  const b = routine('r', { updated: '2026-06-01T00:00:00.000Z', lastSlot: null, lastRun: null });
  for (const m of [mergeRoutines(a, b), mergeRoutines(b, a)]) {
    assert.equal(m.lastSlot, a.lastSlot);
    assert.equal(m.lastRun.at, a.lastRun.at);
  }
});

test('mergeRoutines keeps the later lastDone from either copy and adds none when neither has one', () => {
  const a = routine('r', { lastDone: '2026-05-04T07:00:05.000Z' });
  const b = routine('r', { updated: '2026-06-01T00:00:00.000Z', lastDone: '2026-05-02T07:00:05.000Z' });
  assert.equal(mergeRoutines(a, b).lastDone, '2026-05-04T07:00:05.000Z');
  assert.equal(mergeRoutines(b, a).lastDone, '2026-05-04T07:00:05.000Z');
  assert.equal('lastDone' in mergeRoutines(routine('r'), routine('r')), false);
});

test('list and read skip records that parse but are not valid routines; adopt refuses them', async () => {
  const fs = memoryFs();
  const store = createRoutineStore(fs, 'data');
  await store.write(routine('ok'));
  fs.files.set('data/routines/badtime.json', JSON.stringify(routine('badtime', { schedule: { kind: 'daily', time: '25:00' } })));
  fs.files.set('data/routines/nosched.json', JSON.stringify({ ...routine('nosched'), schedule: undefined }));
  fs.files.set('data/routines/badday.json', JSON.stringify(routine('badday', { schedule: { kind: 'weekly', weekday: 9, time: '07:00' } })));
  assert.deepEqual((await store.list()).map((r) => r.id), ['ok']);
  assert.equal(await store.read('badtime'), null);
  const taken = await store.adopt([routine('badtime2', { schedule: { kind: 'daily', time: 'x' } }), routine('fine')]);
  assert.deepEqual(taken, ['fine']);
  assert.ok(!fs.files.has('data/routines/badtime2.json'));
});

test('unreadable() names each file list() skips, with a plain reason', async () => {
  const fs = memoryFs();
  const store = createRoutineStore(fs, 'data');
  await store.write(routine('ok'));
  fs.files.set('data/routines/bad.json', '{ not json');
  fs.files.set('data/routines/noid.json', '{"name":"x"}');
  fs.files.set('data/routines/nosched.json', JSON.stringify(routine('nosched', { prompt: '' })));
  fs.files.set('data/routines/readme.txt', 'hi');
  const broken = await store.unreadable();
  assert.deepEqual(broken.map((b) => b.file).sort(), ['bad.json', 'noid.json', 'nosched.json']);
  assert.match(broken.find((b) => b.file === 'bad.json').problem, /not valid JSON/);
  assert.match(broken.find((b) => b.file === 'nosched.json').problem, /Say what the routine should look for/);
  assert.ok(broken.every((b) => b.problem && !/^Error/.test(b.problem)));
});
