// Routine news (what a routine run added since the user last opened a chat) and routines filed under a project.
// Invented papers only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createRemoteRuntime } from '../src/remote.js';
import { routes } from '../src/node/agentd.mjs';
import { newsOf } from '../src/sessions.js';
import { conversationStore } from '../src/store.js';
import { memoryFs } from './support/memory-fs.mjs';

process.env.TZ = 'America/New_York';
const local = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const cand = (n) => ({ citekey: null, doi: `10.9999/inv.${n}`, url: null, title: `Invented study ${n} of sleep spindles`, year: 2026, abstract: `Spindles rose in study ${n}.`, authors: ['Doe, J.'], venue: 'J. Invented' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what = 'condition', ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await check(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(10); }
}

function provider(state) {
  return {
    id: 'fake', caps: {},
    async status() { return { provider: 'fake', state: 'ready', version: null, account: { kind: 'none', label: null, plan: null }, usage: null, installHelp: null }; },
    async models() { return []; }, async signIn() { throw new Error('n/a'); }, async signOut() {},
    async *turn(req) {
      let json;
      if (/^Plan a literature review/.test(req.input)) json = { subQuestions: [{ id: 'sq1', question: 'part 1', strategy: 's', sources: ['papers'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] };
      else if (/finding papers for one sub-question/.test(req.input)) json = { candidates: state.found, searchLog: [{ query: 'q', source: 'scholarly', results: state.found.length }] };
      else if (/^You extract data/.test(req.input)) {
        const ids = [...req.input.matchAll(/### Paper (\S+)/g)].map((m) => m[1]);
        json = { rows: ids.map((row) => ({ row, cells: [{ column: 'main_findings', status: 'found', value: 'helped', quotes: ['Spindles rose'] }] })) };
      } else json = { title: 'A digest', scope: 's', method: 'm', themes: [], evidence: [], disagreements: '', gaps: '' };
      yield { type: 'final', text: JSON.stringify(json), json, usage: {} };
    },
    async dispose() {},
  };
}

function setup(found = [cand(1), cand(2), cand(3)]) {
  const fs = memoryFs();
  const state = { found };
  const clock = { t: local(2026, 5, 4, 8, 0) };
  const gateway = { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; } }, async dispose() {} };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const skills = { async list() { return []; }, async get() { return null; }, async put() {}, async remove() {} };
  const make = () => createLocalRuntime({
    platform: { fs, fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) }, library, notes: { async publish(n) { return { path: `${n.title}.md` }; } }, skills, dataDir: '/data',
    providers: new Map([['fake', provider(state)]]), gateway, getRoleModel: async () => ({ provider: 'fake', model: 'm1' }),
    clock: () => clock.t, routines: { tickMs: 15, startupGraceMs: 0 },
  });
  return { fs, state, clock, make };
}

async function seedSession(ai) {
  const id = await ai.conversations.create('chat');
  await ai.sessions.put(id, { kind: 'find', query: 'sleep', sources: {}, scope: { kind: 'library' } }, {
    kind: 'papers', ref: { id: '', version: 0 }, title: 'Sleep spindles', created: '', madeBy: '', from: [], change: 'Found papers', query: 'sleep',
    rows: [1, 2].map((n) => ({ id: `doi:10.9999/inv.${n}`, ref: { kind: 'web', url: `https://doi.org/10.9999/inv.${n}` }, inLibrary: false, title: `Invented study ${n} of sleep spindles`, authors: [], year: 2026, venue: '', doi: `10.9999/inv.${n}`, url: null, abstract: '', citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: [] })),
    columns: [], cells: {}, screening: null, summary: null,
  });
  return { id, ref: (await ai.sessions.view(id)).results[0].ref };
}
const watch = (session, ref, over = {}) => ({ name: 'Spindle watch', prompt: 'new sleep spindle papers', schedule: { kind: 'daily', time: '23:59' }, target: { kind: 'artifact', session, result: { id: ref.id } }, ...over });
const summaryOf = async (ai, id) => (await ai.conversations.list()).find((c) => c.id === id);

test('newsOf: routine papers after the last seen; none for records without either; seen at the same instant is seen', () => {
  assert.equal(newsOf([{ type: 'meta' }, { type: 'user', text: 'hi', at: '2026-05-04T10:00:00.000Z' }]), undefined);
  const runs = [{ type: 'routine_run', routine: 'r', added: 2, at: '2026-05-04T10:00:00.000Z' }, { type: 'routine_run', routine: 'r', added: 3, at: '2026-05-05T10:00:00.000Z' }];
  assert.deepEqual(newsOf(runs), { papers: 5, at: '2026-05-05T10:00:00.000Z' });
  assert.deepEqual(newsOf([...runs, { type: 'seen', at: '2026-05-04T12:00:00.000Z' }]), { papers: 3, at: '2026-05-05T10:00:00.000Z' });
  assert.equal(newsOf([...runs, { type: 'seen', at: '2026-05-05T10:00:00.000Z' }]), undefined);
  assert.equal(newsOf([{ type: 'routine_run', routine: 'r', added: 0, at: '2026-05-04T10:00:00.000Z' }]), undefined);
});

test('an old conversation (no routine or seen records) has no news key, and markSeen writes nothing', async () => {
  const t = setup();
  const ai = await t.make();
  const id = await ai.conversations.create('chat');
  assert.equal('news' in (await summaryOf(ai, id)), false);
  const before = await t.fs.read(`/data/chats/${id}.jsonl`);
  await ai.conversations.markSeen(id);
  await ai.conversations.markSeen('nosuchchat');
  assert.equal(await t.fs.read(`/data/chats/${id}.jsonl`), before);
  await ai.dispose();
});

test('artifact target: a run that adds papers is news on that session until it is opened; markSeen is idempotent', async () => {
  const t = setup();
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const r = await ai.routines.create(watch(id, ref));
  await ai.routines.runNow(r.id);
  await until(async () => (await ai.routines.list())[0].lastRun, 'the run');
  const s = await summaryOf(ai, id);
  assert.deepEqual(s.news, { papers: 1, at: new Date(t.clock.t).toISOString() });
  const updated = s.updated;

  await ai.conversations.markSeen(id);
  const after = await summaryOf(ai, id);
  assert.equal('news' in after, false);
  assert.equal(after.updated, updated, 'opening a chat does not move it up the history');
  const log = await t.fs.read(`/data/chats/${id}.jsonl`);
  await ai.conversations.markSeen(id);
  await ai.conversations.markSeen(id);
  assert.equal(await t.fs.read(`/data/chats/${id}.jsonl`), log, 'nothing new, nothing appended');

  // a second run that finds more papers is news again, and only its own papers
  t.state.found = [cand(1), cand(2), cand(3), cand(4), cand(5)];
  t.clock.t += 3_600_000;
  await ai.routines.runNow(r.id);
  await until(async () => (await summaryOf(ai, id)).news, 'the second run');
  assert.equal((await summaryOf(ai, id)).news.papers, 2);
  await ai.dispose();
});

test('a run that adds nothing is not news', async () => {
  const t = setup([cand(1), cand(2)]);
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const r = await ai.routines.create(watch(id, ref));
  await ai.routines.runNow(r.id);
  await until(async () => (await ai.routines.list())[0].lastRun, 'the run');
  assert.equal('news' in (await summaryOf(ai, id)), false);
  await ai.dispose();
});

test('session target: the new session is news until opened, and it lands in the routine project; the report carries it', async () => {
  const t = setup();
  const ai = await t.make();
  const project = await ai.projects.create('Voles');
  const r = await ai.routines.create({ name: 'Digest', prompt: 'sleep spindles', depth: 'quick', schedule: { kind: 'daily', time: '23:59' }, target: { kind: 'session' }, project: project.id });
  assert.equal(r.project, project.id);
  await ai.routines.runNow(r.id);
  const run = await until(async () => (await ai.routines.list())[0].lastRun, 'the digest');
  assert.equal(run.status, 'done', run.reason);
  const made = await summaryOf(ai, run.session);
  assert.equal(made.project, project.id);
  assert.equal(made.news.papers > 0, true);
  const progress = (await ai.reviews.list()).find((p) => p.id === run.review);
  assert.equal(progress.project, project.id);
  const request = JSON.parse(await t.fs.read(`/data/reviews/${run.review}/request.json`));
  assert.equal(request.project, project.id);
  await ai.conversations.markSeen(run.session);
  assert.equal('news' in (await summaryOf(ai, run.session)), false);
  await ai.dispose();
});

test('routine.project: an unknown id means none; a deleted project means none at run time; update can clear it', async () => {
  const t = setup();
  const ai = await t.make();
  const unknown = await ai.routines.create({ prompt: 'p', schedule: { kind: 'daily', time: '23:59' }, project: 'nosuchproject' });
  assert.equal('project' in unknown, false);
  const project = await ai.projects.create('Voles');
  const r = await ai.routines.create({ prompt: 'sleep spindles', depth: 'quick', schedule: { kind: 'daily', time: '23:59' }, project: project.id });
  assert.equal(r.project, project.id);
  assert.equal((await ai.routines.update(r.id, { name: 'Renamed' })).project, project.id, 'an edit keeps it');
  assert.equal((await ai.routines.update(r.id, { project: 'nosuchproject' })).project, undefined);
  assert.equal((await ai.routines.update(r.id, { project: project.id })).project, project.id);
  await ai.projects.remove(project.id);
  await ai.routines.runNow(r.id);
  const run = await until(async () => (await ai.routines.list()).find((x) => x.id === r.id).lastRun, 'the run');
  assert.equal('project' in (await summaryOf(ai, run.session)), false);
  assert.equal((await ai.routines.update(r.id, { project: null })).project, undefined);
  await ai.dispose();
});

test('POST /conversations/seen and remote.js markSeen reach the same service', async () => {
  const t = setup();
  const ai = await t.make();
  const { id, ref } = await seedSession(ai);
  const r = await ai.routines.create(watch(id, ref));
  await ai.routines.runNow(r.id);
  await until(async () => (await summaryOf(ai, id)).news, 'news');
  const table = routes();
  const transport = {
    async request(method, path, body) {
      const row = table.find((x) => x.method === method && x.path === path);
      assert.ok(row, `${method} ${path} has a route`);
      const out = await row.call(ai, body ?? {}, { signal: new AbortController().signal });
      return out === undefined ? null : JSON.parse(JSON.stringify(out));
    },
    async *stream() {},
  };
  await createRemoteRuntime(transport).conversations.markSeen(id);
  assert.equal('news' in (await summaryOf(ai, id)), false);
  await ai.dispose();
});

test('store.summarize: seen records do not change `updated`', async () => {
  const fs = memoryFs();
  const store = conversationStore(fs, '/c');
  await store.append('A', { type: 'meta', id: 'A', mode: 'chat', title: 't', created: '2026-05-01T00:00:00.000Z' });
  await store.append('A', { type: 'routine_run', routine: 'r', added: 2, at: '2026-05-02T00:00:00.000Z' });
  await store.append('A', { type: 'seen', at: '2026-05-09T00:00:00.000Z' });
  const [s] = await store.list();
  assert.equal(s.updated, '2026-05-02T00:00:00.000Z');
  assert.equal('news' in s, false);
});
