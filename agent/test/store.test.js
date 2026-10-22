import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationStore, ulid } from '../src/store.js';
import { memoryFs } from './support/memory-fs.mjs';

test('ulid: sortable by creation time and unique', () => {
  const a = ulid(1000);
  const b = ulid(1001);
  assert.ok(a < b);
  assert.notEqual(ulid(1000), ulid(1000)); // random suffix differs
});

test('append then load round-trips records in order', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats');
  const id = ulid();
  await store.append(id, { type: 'meta', id, mode: 'chat', title: 'New chat', created: '2026-01-01T00:00:00Z' });
  await store.append(id, { type: 'user', text: 'hi', attachments: [], web: 'off', at: '2026-01-01T00:00:01Z' });
  const records = await store.load(id);
  assert.equal(records.length, 2);
  assert.equal(records[1].text, 'hi');
});

test('a conversation not on disk loads as an empty history, not an error', async () => {
  const store = conversationStore(memoryFs(), '/data/chats');
  assert.deepEqual(await store.load('missing'), []);
});

test('after a restart (a fresh store instance over the same files) history rebuilds unchanged', async () => {
  const fs = memoryFs();
  const id = ulid();
  const first = conversationStore(fs, '/data/chats');
  await first.append(id, { type: 'meta', id, mode: 'chat', title: 'New chat', created: '2026-01-01T00:00:00Z' });
  await first.append(id, { type: 'user', text: 'hi', attachments: [], web: 'off', at: '2026-01-01T00:00:01Z' });

  const restarted = conversationStore(fs, '/data/chats'); // simulates the process restarting; only `fs` persists
  const records = await restarted.load(id);
  assert.equal(records.length, 2);
  const summaries = await restarted.list();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, id);
});

test('adopt is idempotent: an id already owned here keeps its own history', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats');
  const id = ulid();
  await store.append(id, { type: 'meta', id, mode: 'chat', title: 'Local title', created: '2026-01-01T00:00:00Z' });

  const incoming = `${JSON.stringify({ type: 'meta', id, mode: 'chat', title: 'Server title', created: '2026-01-02T00:00:00Z' })}\n`;
  await store.adopt([{ id, jsonl: incoming }]);
  const records = await store.load(id);
  assert.equal(records[0].title, 'Local title', 'adopt must not overwrite an id already owned here');

  const otherId = ulid();
  await store.adopt([{ id: otherId, jsonl: incoming.replace(id, otherId) }]);
  assert.ok((await store.load(otherId)).length > 0, 'adopt does write a genuinely new id');
});

// ---------- spec 007 E1: result versions and .d folder adoption ----------

test('writeResult/readResult round-trip a version file under chats/<id>.d/results/<resultId>/v<n>.json', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats');
  const id = ulid();
  const body = { ref: { id: 'R1', version: 1 }, kind: 'papers', title: 'Widgets', created: 't', madeBy: 'S1', from: [], change: '', query: null, rows: [], columns: [], cells: {}, screening: null, summary: null };
  await store.writeResult(id, 'R1', 1, body);
  assert.ok(fs.files.has(`/data/chats/${id}.d/results/R1/v1.json`));
  const read = await store.readResult(id, 'R1', 1);
  assert.deepEqual(read, body);
  assert.equal(await store.readResult(id, 'R1', 2), null); // a version never written
});

test('a result file with no matching `result` record (crash between the two writes) is simply never surfaced by list/load', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats');
  const id = ulid();
  await store.append(id, { type: 'meta', id, mode: 'chat', title: 'New chat', created: 't0' });
  await store.writeResult(id, 'R1', 1, { ref: { id: 'R1', version: 1 }, kind: 'papers', title: 'Widgets' });
  // no `result` record appended: store.load only ever reads the .jsonl, so the orphan file is invisible to it.
  const records = await store.load(id);
  assert.equal(records.some((r) => r.type === 'result'), false);
  const summaries = await store.list();
  assert.equal(summaries[0].artifacts, 0);
});

test('adopt copies the .d folder (results) alongside the jsonl, keep-the-first per id', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats');
  const id = ulid();
  const jsonl = `${JSON.stringify({ type: 'meta', id, mode: 'chat', title: 'Server session', created: 't0' })}\n`;
  const resultBody = JSON.stringify({ ref: { id: 'R1', version: 1 }, kind: 'papers', title: 'Widgets' });
  await store.adopt([{ id, jsonl, files: [{ path: `${id}.d/results/R1/v1.json`, text: resultBody }] }]);
  assert.deepEqual(await store.readResult(id, 'R1', 1), JSON.parse(resultBody));

  // Adopting the same id again (server restart replaying the same incoming batch) must not touch what's here,
  // even though the incoming files differ -- the same keep-the-first rule store.adopt already gives the jsonl.
  const otherBody = JSON.stringify({ ref: { id: 'R1', version: 1 }, kind: 'papers', title: 'Different' });
  await store.adopt([{ id, jsonl, files: [{ path: `${id}.d/results/R1/v1.json`, text: otherBody }] }]);
  const still = await store.readResult(id, 'R1', 1);
  assert.equal(still.title, 'Widgets');
});

test('rename appends a rename record; list reflects the latest title', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats');
  const id = ulid();
  await store.append(id, { type: 'meta', id, mode: 'chat', title: 'Original', created: '2026-01-01T00:00:00Z' });
  await store.append(id, { type: 'rename', title: 'Renamed', at: '2026-01-01T00:00:01Z' });
  const [summary] = await store.list();
  assert.equal(summary.title, 'Renamed');
});

// ---------- spec 011 U5: project membership ----------

test('summary project: meta.project seeds it, a project record overrides it, null clears it, none leaves no key', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats');
  const plain = ulid(), seeded = ulid();
  await store.append(plain, { type: 'meta', id: plain, mode: 'chat', title: 'Plain', created: '2026-01-01T00:00:00Z' });
  await store.append(seeded, { type: 'meta', id: seeded, mode: 'chat', title: 'Seeded', created: '2026-01-01T00:00:01Z', project: 'P1' });
  const by = async () => Object.fromEntries((await store.list()).map((s) => [s.id, s]));
  assert.equal('project' in (await by())[plain], false, 'a chat with no project has no project key');
  assert.equal((await by())[seeded].project, 'P1');
  await store.append(seeded, { type: 'project', project: 'P2', at: '2026-01-01T00:00:02Z' });
  assert.equal((await by())[seeded].project, 'P2');
  await store.append(seeded, { type: 'project', project: null, at: '2026-01-01T00:00:03Z' });
  assert.equal((await by())[seeded].project, null);
  await store.append(plain, { type: 'project', project: 'P1', at: '2026-01-01T00:00:04Z' });
  assert.equal((await by())[plain].project, 'P1');
});

test('adopt carries project records across unchanged', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/data/chats');
  const id = ulid();
  const jsonl = [
    { type: 'meta', id, mode: 'chat', title: 'From Zotero', created: '2026-01-01T00:00:00Z', project: 'P1' },
    { type: 'project', project: 'P2', at: '2026-01-01T00:00:01Z' },
  ].map((r) => JSON.stringify(r)).join('\n');
  await store.adopt([{ id, jsonl }]);
  assert.equal((await store.list())[0].project, 'P2');
  assert.equal((await store.load(id)).filter((r) => r.type === 'project').length, 1);
});
