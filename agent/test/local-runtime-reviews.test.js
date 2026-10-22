// End-to-end reviews through the real AgentService surface (createLocalRuntime), not review.js in isolation:
// this is what proves core.js's wiring (the review event log, the AbortController map, resume-after-restart)
// actually satisfies service.d.ts, the same surface agentd.mjs and the Zotero/Obsidian panels call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { memoryFs } from './support/memory-fs.mjs';

const REQUEST = { question: 'Does spaced repetition beat massed practice?', scope: { kind: 'library' }, sources: ['library'], years: { from: null, to: null }, depth: 'quick' };

function fakeProvider() {
  return {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req) {
      let json;
      if (/^Plan a literature review/.test(req.input)) {
        json = { subQuestions: [{ id: 'sq1', question: 'part 1', strategy: 's', sources: ['library'] }, { id: 'sq2', question: 'part 2', strategy: 's', sources: ['library'] }] };
      } else if (/researching one sub-question/.test(req.input)) {
        const id = req.input.includes('part 1') ? 'sq1' : 'sq2';
        json = { findings: [{ claim: `claim for ${id}`, sources: [{ citekey: id, doi: null, url: null, title: `Paper ${id}`, year: 2022 }], quotes: ['q'], confidence: 'high' }], searchLog: [{ query: id, source: 'library', results: 1 }] };
      } else {
        json = { title: 'A review', scope: 'the whole library', method: 'Searched the library.', themes: [], evidence: [], disagreements: '', gaps: '' };
      }
      yield { type: 'final', text: JSON.stringify(json), json, usage: {} };
    },
    async dispose() {},
  };
}

function runtime(fs, dataDir = '/data') {
  const gateway = { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; } }, async dispose() {} };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const published = [];
  const notes = { async publish(note) { published.push(note); return { path: `ai_notes/Literature Reviews/${note.title}.md` }; } };
  return { published, ai: createLocalRuntime({ platform: { fs }, library, notes, dataDir, providers: new Map([['fake', fakeProvider()]]), gateway, getRoleModel: async () => ({ provider: 'fake', model: 'm1' }) }) };
}

test('start -> watch (awaiting_approval) -> approvePlan -> watch (done), and the note is published exactly once', async () => {
  const fs = memoryFs();
  const { ai: aiPromise, published } = runtime(fs);
  const ai = await aiPromise;
  const id = await ai.reviews.start(REQUEST);

  const first = [];
  for await (const p of ai.reviews.watch(id)) { first.push(p); if (p.status.state === 'awaiting_approval') break; }
  assert.equal(first.at(-1).status.state, 'awaiting_approval');
  assert.equal(first.at(-1).status.plan.subQuestions.length, 2);

  await ai.reviews.approvePlan(id, first.at(-1).status.plan);

  const second = [];
  for await (const p of ai.reviews.watch(id)) { second.push(p); if (p.status.state === 'done') break; }
  assert.equal(second.at(-1).status.state, 'done');
  assert.equal(published.length, 1);
  assert.equal(second.at(-1).papersFound, 2);
});

test('cancel mid-review reaches "stopped", and resume in a fresh runtime (same dataDir) picks it back up', async () => {
  const fs = memoryFs();
  const { ai: aiPromise } = runtime(fs);
  const ai = await aiPromise;
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true });

  // race the cancel against the run: whichever wins, the review must land on a stable, resumable state.
  await ai.reviews.cancel(id);
  for await (const p of ai.reviews.watch(id)) { if (p.status.state === 'done' || p.status.state === 'stopped') break; }

  const list = await ai.reviews.list();
  const found = list.find((p) => p.id === id);
  assert.ok(found.status.state === 'done' || found.status.state === 'stopped', found.status.state);

  if (found.status.state === 'stopped') {
    // simulate a restart: a brand-new runtime instance over the same on-disk files, no in-memory review log
    const { ai: freshPromise } = runtime(fs);
    const fresh = await freshPromise;
    await fresh.reviews.resume(id);
    for await (const p of fresh.reviews.watch(id)) { if (p.status.state === 'done') break; }
    const done = (await fresh.reviews.list()).find((p) => p.id === id);
    assert.equal(done.status.state, 'done');
  }
});

test('export needs a finished report', async () => {
  const fs = memoryFs();
  const { ai: aiPromise } = runtime(fs);
  const ai = await aiPromise;
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true });
  for await (const p of ai.reviews.watch(id)) { if (p.status.state === 'done') break; }
  const result = await ai.reviews.export(id, 'md');
  assert.match(result.path, /export\.md$/);
  const text = await fs.read(result.path);
  assert.match(text, /^---\ntype: "literature-review"/);
  assert.match(text, /## References/);
});

test('reopening a review shows where it is now, not the plan it was waiting on earlier', async () => {
  const fs = memoryFs();
  const { ai: aiPromise } = runtime(fs);
  const ai = await aiPromise;
  const id = await ai.reviews.start(REQUEST);
  let plan;
  for await (const p of ai.reviews.watch(id)) if (p.status.state === 'awaiting_approval') { plan = p.status.plan; break; }
  await ai.reviews.approvePlan(id, plan);
  for await (const p of ai.reviews.watch(id)) if (p.status.state === 'done') break;

  // a client that stops at the first settled state (remote.js does) must land on "done"
  const reopened = [];
  for await (const p of ai.reviews.watch(id)) reopened.push(p.status.state);
  assert.deepEqual(reopened, ['done']);
});

test('start saves the Research web mode on a request that lists web, so a resume reads the same value', async () => {
  for (const [saved, expected] of [['cached', 'cached'], ['live', 'live'], ['off', 'live']]) {
    const fs = memoryFs();
    const ai = await runtime(fs).ai;
    await ai.settings.update({ webSearchDefault: saved });
    const id = await ai.reviews.start({ ...REQUEST, sources: ['library', 'web'] });
    const request = JSON.parse(await fs.read(`/data/reviews/${id}/request.json`));
    assert.equal(request.web, expected, `saved ${saved}`);
    ai.reviews.cancel?.(id);
  }
  const fs = memoryFs();
  const ai = await runtime(fs).ai;
  await ai.settings.update({ webSearchDefault: 'cached' });
  const id = await ai.reviews.start(REQUEST);
  assert.equal(JSON.parse(await fs.read(`/data/reviews/${id}/request.json`)).web, undefined);
});
