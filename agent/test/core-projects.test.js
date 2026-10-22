// Spec 011 U5: the projects service inside the runtime (assign for chats and reports, create with a project, a
// deleted project leaving its members alone). Invented data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { memoryFs } from './support/memory-fs.mjs';

const noopLibrary = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
const provider = {
  id: 'fake', caps: {},
  async status() { return { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
  async models() { return []; }, async signIn() { throw new Error('n/a'); }, async signOut() {},
  async *turn() { yield { type: 'final', text: 'ok', json: null, usage: {} }; },
  async dispose() {},
};
const gateway = {
  open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
  mcpServers: { async reports() { return []; }, async save(config) { return { config, state: 'connected', error: null, tools: [] }; }, async remove() {}, rows: () => [] },
  async dispose() {},
};

async function setup() {
  const fs = memoryFs();
  const service = await createLocalRuntime({
    platform: { fs }, library: noopLibrary, notes: {}, dataDir: 'data', providers: new Map([['fake', provider]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }), limits: { total: 6 },
  });
  return { fs, service };
}

/** A review directory as reviews.start leaves it, without running a pipeline. */
function seedReview(fs, id, request) {
  fs.files.set(`data/reviews/${id}/request.json`, JSON.stringify(request));
}
const request = { question: 'Do voles sleep?', scope: { kind: 'library' }, sources: ['papers'], years: { from: null, to: null }, depth: 'standard', systematic: true, skills: [{ name: 'tidy', hash: 'h', block: 'b' }] };

test('create, rename, list by name, remove', async () => {
  const { service } = await setup();
  const b = await service.projects.create('  Voles ');
  await service.projects.create('Apes');
  assert.equal(b.name, 'Voles');
  assert.deepEqual((await service.projects.list()).map((p) => p.name), ['Apes', 'Voles']);
  assert.equal((await service.projects.rename(b.id, 'Field voles')).name, 'Field voles');
  await service.projects.remove(b.id);
  assert.deepEqual((await service.projects.list()).map((p) => p.name), ['Apes']);
  await assert.rejects(() => service.projects.create(' '), /Give the project a name/);
});

test('assign a chat appends one project record and conversations.list shows it; null takes it out', async () => {
  const { service } = await setup();
  const p = await service.projects.create('Voles');
  const id = await service.conversations.create('chat');
  await service.projects.assign({ kind: 'chat', id }, p.id);
  const records = await service.conversations.load(id);
  assert.equal(records.filter((r) => r.type === 'project').length, 1);
  assert.equal((await service.conversations.list()).find((c) => c.id === id).project, p.id);
  await service.projects.assign({ kind: 'chat', id }, null);
  assert.equal((await service.conversations.list()).find((c) => c.id === id).project, null);
});

test('conversations.create with a project seeds meta.project', async () => {
  const { service } = await setup();
  const p = await service.projects.create('Voles');
  const id = await service.conversations.create('chat', { project: p.id });
  const other = await service.conversations.create('chat');
  const list = await service.conversations.list();
  assert.equal(list.find((c) => c.id === id).project, p.id);
  assert.equal('project' in list.find((c) => c.id === other), false);
});

test('assign a report patches request.json only, and reviews.list exposes the project', async () => {
  const { fs, service } = await setup();
  const p = await service.projects.create('Voles');
  seedReview(fs, 'R100', request);
  await service.projects.assign({ kind: 'review', id: 'R100' }, p.id);
  const saved = JSON.parse(fs.files.get('data/reviews/R100/request.json'));
  assert.deepEqual(saved, { ...request, project: p.id });
  const listed = await service.reviews.list();
  assert.equal(listed.find((r) => r.id === 'R100').project, p.id);
  await service.projects.assign({ kind: 'review', id: 'R100' }, null);
  assert.deepEqual(JSON.parse(fs.files.get('data/reviews/R100/request.json')), request);
  assert.equal('project' in (await service.reviews.list()).find((r) => r.id === 'R100'), false);
});

test('an unknown chat, report or project is refused in plain words', async () => {
  const { service } = await setup();
  const p = await service.projects.create('Voles');
  const id = await service.conversations.create('chat');
  await assert.rejects(() => service.projects.assign({ kind: 'chat', id: 'nope' }, p.id), /There is no chat with that id\./);
  await assert.rejects(() => service.projects.assign({ kind: 'review', id: 'nope' }, p.id), /There is no report with that id\./);
  await assert.rejects(() => service.projects.assign({ kind: 'review', id: '../x' }, p.id), /There is no report with that id\./);
  await assert.rejects(() => service.projects.assign({ kind: 'chat', id }, 'gone'), /There is no project with that id\./);
  await assert.rejects(() => service.projects.assign({ kind: 'note', id }, p.id), /Only a chat or a report/);
});

test('removing a project leaves its members listed with the stale id', async () => {
  const { fs, service } = await setup();
  const p = await service.projects.create('Voles');
  const id = await service.conversations.create('chat', { project: p.id });
  seedReview(fs, 'R100', { ...request, project: p.id });
  await service.projects.remove(p.id);
  assert.equal((await service.conversations.list()).find((c) => c.id === id).project, p.id);
  assert.equal((await service.reviews.list()).find((r) => r.id === 'R100').project, p.id);
  assert.deepEqual(await service.projects.list(), []);
});

test('adopt takes in a project made elsewhere, once', async () => {
  const { service } = await setup();
  const rec = { id: 'zp1', name: 'From Zotero', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(await service.projects.adopt([rec]), ['zp1']);
  assert.deepEqual(await service.projects.adopt([rec]), ['zp1']);
  assert.equal((await service.projects.list()).length, 1);
});
