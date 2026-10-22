// Spec 017 K5: the one-off migration, run against a temp copy of invented routine files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, RADAR_ID, WEEKLY_ID, TOPIC } from '../dev/migrate-017.mjs';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'mig017-'));
  const dir = join(root, 'routines');
  await mkdir(dir);
  const radar = { id: RADAR_ID, name: 'Reading radar', kind: 'radar', status: 'active', updated: '2026-10-12T00:00:00.000Z', radar: { profile: { topics: [{ text: 'quantum dots', weight: 1, origin: 'seed' }], authors: [], journals: [] }, sources: [] } };
  const weekly = { id: WEEKLY_ID, name: 'Weekly: equivariant networks for molecules', status: 'paused', updated: '2026-10-09T00:00:00.000Z' };
  await writeFile(join(dir, `${RADAR_ID}.json`), JSON.stringify(radar, null, 2));
  await writeFile(join(dir, `${WEEKLY_ID}.json`), JSON.stringify(weekly, null, 2));
  return { root, dir, radar, weekly };
}
const read = async (dir, id) => JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'));

test('adds the topic as a user topic, archives the weekly routine, and backs up both first', async () => {
  const { root, dir, radar, weekly } = await setup();
  const out = await migrate(dir, { now: '2026-10-14T00:00:00.000Z' });
  assert.deepEqual(out.changed, [RADAR_ID, WEEKLY_ID]);
  const r = await read(dir, RADAR_ID);
  assert.deepEqual(r.radar.profile.topics.at(-1), { text: TOPIC, weight: 1, origin: 'user' });
  assert.equal(r.radar.profile.topics.length, 2);
  assert.equal(r.updated, '2026-10-14T00:00:00.000Z');
  const w = await read(dir, WEEKLY_ID);
  assert.equal(w.status, 'archived');
  assert.equal(w.name, weekly.name, 'nothing else about the routine changes');
  assert.deepEqual(await readdir(join(root, 'routines.bak-017')), [`${RADAR_ID}.json`, `${WEEKLY_ID}.json`].sort());
  assert.deepEqual(JSON.parse(await readFile(join(root, 'routines.bak-017', `${RADAR_ID}.json`), 'utf8')), radar);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'routines.bak-017', `${WEEKLY_ID}.json`), 'utf8')), weekly);
});

test('a second run changes nothing and keeps the first backup', async () => {
  const { root, dir } = await setup();
  await migrate(dir, { now: '2026-10-14T00:00:00.000Z' });
  const before = await Promise.all([RADAR_ID, WEEKLY_ID].map((id) => readFile(join(dir, `${id}.json`), 'utf8')));
  const again = await migrate(dir, { now: '2026-10-15T00:00:00.000Z' });
  assert.deepEqual(again.changed, []);
  assert.deepEqual(await Promise.all([RADAR_ID, WEEKLY_ID].map((id) => readFile(join(dir, `${id}.json`), 'utf8'))), before);
  assert.equal(JSON.parse(await readFile(join(root, 'routines.bak-017', `${RADAR_ID}.json`), 'utf8')).radar.profile.topics.length, 1);
});

test('a topic with the same words already in the radar is not added twice', async () => {
  const { dir } = await setup();
  const r = await read(dir, RADAR_ID);
  r.radar.profile.topics.push({ text: 'Graph neural networks, equivariant', weight: 0.4, origin: 'seed' });
  await writeFile(join(dir, `${RADAR_ID}.json`), JSON.stringify(r));
  const out = await migrate(dir);
  assert.deepEqual(out.changed, [WEEKLY_ID]);
  assert.equal((await read(dir, RADAR_ID)).radar.profile.topics.length, 2);
});

test('a missing file stops before anything is written', async () => {
  const { root, dir } = await setup();
  await import('node:fs/promises').then((fs) => fs.rm(join(dir, `${WEEKLY_ID}.json`)));
  await assert.rejects(migrate(dir), /Missing/);
  assert.equal((await read(dir, RADAR_ID)).radar.profile.topics.length, 1);
  await assert.rejects(readdir(join(root, 'routines.bak-017')));
});
