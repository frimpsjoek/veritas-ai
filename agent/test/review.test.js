import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_STAGES, toolContextFor, runReview, deriveStatus, reviewProgress } from '../src/review.js';
import { ulid } from '../src/store.js';
import { createSlots, createTurnRunner } from '../src/core.js';
import { memoryFs } from './support/memory-fs.mjs';

const REQUEST = { question: 'Does X help Y?', scope: { kind: 'library' }, sources: ['library'], years: { from: null, to: null }, depth: 'quick' };

function planWith(ids) {
  return { subQuestions: ids.map((id) => ({ id, question: `about ${id}`, strategy: 's', sources: ['library'] })) };
}

function findingsFor(id) {
  return { findings: [{ claim: `claim ${id}`, sources: [{ citekey: `key-${id}`, doi: null, url: null, title: `Paper ${id}`, year: 2020 }], quotes: ['q'], confidence: 'medium' }], searchLog: [{ query: id, source: 'library', results: 1 }] };
}

const REPORT_STUB = { title: 'T', scope: 'S', method: 'M', themes: [], evidence: [], disagreements: '', gaps: '' };

/** A fake ctx.turns.structured, dispatching on role. `researcher` looks up its sub-question id from the audit
 *  string tools carries (review:<id>:<sqId>), which is exactly what review.js's toolContextFor stamps. */
function fakeTurns(overrides = {}) {
  const calls = { lead: 0, researcher: 0, writer: 0 };
  return {
    calls,
    async structured(role, prompt, schema, tools, signal) {
      calls[role] += 1;
      if (overrides[role]) return overrides[role]({ prompt, tools, signal });
      if (role === 'lead') return planWith(['sq1', 'sq2']);
      if (role === 'researcher') return findingsFor(tools.audit.split(':').pop());
      return REPORT_STUB;
    },
  };
}

function stageCtx({ id = 'r1', request = REQUEST, autoApprove = false, turns = fakeTurns(), notes, signal } = {}) {
  const fs = memoryFs();
  const dir = `reviews/${id}`;
  const published = [];
  return {
    fs,
    ctx: {
      reviewId: id,
      request,
      read: async (f) => JSON.parse(await fs.read(`${dir}/${f}`)),
      write: async (f, v) => fs.writeAtomic(`${dir}/${f}`, JSON.stringify(v)),
      has: async (f) => (await fs.read(`${dir}/${f}`)) !== null,
      remove: async (f) => fs.remove(`${dir}/${f}`),
      turns,
      getRoleModel: async () => ({ provider: 'fake', model: 'm1' }),
      notes: notes ?? { async publish(note) { published.push(note); return { path: `ai_notes/Literature Reviews/${note.title}.md` }; } },
      settings: { autoApprove },
      signal: signal ?? new AbortController().signal,
    },
    published,
    files: async () => [...fs.files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
  };
}

test('runs end to end with autoApprove, writing every stage file atomically and publishing the note', async () => {
  const { ctx, files, published } = stageCtx({ autoApprove: true });
  await runReview(ctx);
  const list = await files();
  for (const stage of REVIEW_STAGES) assert.ok(list.includes(stage.output), `missing ${stage.output}`);
  assert.ok(!list.includes('stopped.json'));
  assert.equal(published.length, 1);
  assert.equal(deriveStatus(list, false).state, 'done');
  const screened = await ctx.read('screened.json');
  assert.equal(screened.sources.length, 2); // sq1 + sq2, each one in-library source
});

test('spec 005: a legacy request.sources of ["library"] expands to papers + notes for every stage\'s tools', async () => {
  const seenSources = [];
  const t = fakeTurns({
    lead: ({ tools }) => { seenSources.push(tools.sources); return planWith(['sq1']); },
    researcher: ({ tools }) => { seenSources.push(tools.sources); return findingsFor(tools.audit.split(':').pop()); },
  });
  const { ctx } = stageCtx({ autoApprove: true, turns: t, request: { ...REQUEST, sources: ['library'] } });
  await runReview(ctx);
  assert.ok(seenSources.length >= 2);
  for (const sources of seenSources) {
    assert.equal(sources.papers, true);
    assert.equal(sources.notes, true);
  }
});

test('spec 005: a new-style request.sources of ["papers"] only turns papers on', async () => {
  let seen = null;
  const t = fakeTurns({ lead: ({ tools }) => { seen = tools.sources; return planWith(['sq1']); } });
  const { ctx } = stageCtx({ autoApprove: true, turns: t, request: { ...REQUEST, sources: ['papers'] } });
  await runReview(ctx);
  assert.deepEqual(seen, { papers: true, notes: false, scholarly: false, web: false });
});

test('a report that lists web runs with the mode saved on its request, live when none was saved', () => {
  const ctx = (request) => ({ request: { ...REQUEST, ...request }, reviewId: 'r1' });
  assert.equal(toolContextFor(ctx({ web: 'cached' }), ['web'], 'x').web, 'cached');
  assert.equal(toolContextFor(ctx({ web: 'live' }), ['web'], 'x').web, 'live');
  assert.equal(toolContextFor(ctx({}), ['web'], 'x').web, 'live');
  assert.equal(toolContextFor(ctx({ web: 'cached' }), ['papers'], 'x').web, 'off');
});

test('approve pauses without autoApprove; approvePlan then resumes the rest', async () => {
  const t = fakeTurns();
  const { ctx, files } = stageCtx({ autoApprove: false, turns: t });
  await runReview(ctx);
  let list = await files();
  assert.deepEqual(list, ['plan.json']);
  assert.deepEqual(deriveStatus(list, false), { state: 'awaiting_approval' });
  assert.equal(t.calls.lead, 1);

  // the runtime's approvePlan writes the (possibly user-edited) plan directly, then re-runs
  const edited = await ctx.read('plan.json');
  await ctx.write('approved-plan.json', edited);
  await runReview(ctx);
  list = await files();
  assert.equal(t.calls.lead, 1); // plan.json already existed: never re-planned
  assert.ok(list.includes('note.json'));
  assert.equal(deriveStatus(list, false).state, 'done');
});

test('kill at a stage boundary and resume: only the missing stages re-run', async () => {
  const t = fakeTurns();
  const { ctx, files } = stageCtx({ autoApprove: true, turns: t });
  await runReview(ctx);
  assert.equal(t.calls.writer, 1);

  // simulate a crash that lost everything from synthesize onward
  await ctx.remove('report.json');
  await ctx.remove('note.json');
  await runReview(ctx);
  assert.equal(t.calls.lead, 1, 'plan stage did not re-run');
  assert.equal(t.calls.researcher, 2, 'research stage did not re-run (both sub-questions already had files)');
  assert.equal(t.calls.writer, 2, 'synthesize re-ran because report.json was missing');
  const list = await files();
  assert.ok(list.includes('note.json'));
});

test('cancel mid-research resolves promptly, writes stopped.json{reason: cancelled}, and keeps finished work', async () => {
  const controller = new AbortController();
  const t = fakeTurns({
    researcher: async ({ tools, signal }) => {
      const sq = tools.audit.split(':').pop();
      if (sq === 'sq1') return findingsFor('sq1');
      // sq2 hangs until the review is cancelled, exactly like a real aborted provider turn. The abort listener is
      // attached as the very first thing this branch does, so the test's own `controller.abort()` below (which
      // only fires once it has independent proof sq1's file is on disk) can never race it.
      return new Promise((_resolve, reject) => {
        if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  });
  const { ctx: base, files } = stageCtx({ autoApprove: true, turns: t, signal: controller.signal });
  let sq1Written;
  const sq1WrittenPromise = new Promise((resolve) => { sq1Written = resolve; });
  const ctx = { ...base, write: async (f, v) => { await base.write(f, v); if (f === 'findings/sq1.json') sq1Written(); } };

  const done = runReview(ctx);
  await sq1WrittenPromise; // sq1's file is confirmed on disk before we cancel
  controller.abort();
  await done; // must resolve, not hang: nothing is left running

  const list = await files();
  assert.ok(list.includes('stopped.json'));
  assert.equal((await ctx.read('stopped.json')).reason, 'cancelled');
  assert.ok(!list.includes('findings.json'), 'research stage did not complete');
  assert.ok(list.includes('findings/sq1.json'), 'the researcher that finished before cancel keeps its file');
  assert.ok(!list.includes('findings/sq2.json'));
  assert.equal(deriveStatus(list, false).state, 'stopped');
});

test('a crashed researcher (non-abort error) leaves the review stopped with reason "provider_crashed", not "cancelled"', async () => {
  const t = fakeTurns({
    researcher: async ({ tools }) => {
      if (tools.audit.endsWith('sq2')) throw new Error('boom');
      return findingsFor('sq1');
    },
  });
  const { ctx, files } = stageCtx({ autoApprove: true, turns: t });
  await runReview(ctx);
  const stopped = await ctx.read('stopped.json');
  assert.equal(stopped.reason, 'provider_crashed');
  assert.ok((await files()).includes('findings/sq1.json'));
});

test('the researcher slot pool caps concurrency even when every sub-question is ready to run at once', async () => {
  const state = { active: 0, peak: 0 };
  const provider = {
    id: 'fake', caps: {},
    async status() { return null; },
    async models() { return []; },
    async *turn() {
      state.active += 1; state.peak = Math.max(state.peak, state.active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      state.active -= 1;
      yield { type: 'final', text: JSON.stringify({ findings: [], searchLog: [] }), json: { findings: [], searchLog: [] }, usage: {} };
    },
    async dispose() {},
  };
  const gateway = { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, seen: () => [], close() {} }; }, async dispose() {} };
  const library = { async resolve() { return new Map(); } };
  const slots = createSlots({ total: 6, perRole: { researcher: 3 } });
  const turns = createTurnRunner({ providers: new Map([['fake', provider]]), getRoleModel: async () => ({ provider: 'fake', model: null }), gateway, library, slots });

  const { ctx, files } = stageCtx({ autoApprove: true, turns });
  await ctx.write('plan.json', planWith(['sq1', 'sq2', 'sq3', 'sq4', 'sq5', 'sq6', 'sq7', 'sq8']));
  await ctx.write('approved-plan.json', await ctx.read('plan.json'));
  await runReview(ctx); // resumes from research, since plan/approve already exist

  assert.ok(state.peak <= 3, `peak concurrent researchers was ${state.peak}, expected <= 3`);
  assert.equal((await files()).filter((f) => f.startsWith('findings/')).length, 8);
});

test('deriveStatus reads the files alone: done, running, stopped and awaiting_approval', () => {
  assert.deepEqual(deriveStatus(['note.json'], false), { state: 'done' });
  assert.deepEqual(deriveStatus(['plan.json', 'approved-plan.json', 'findings.json'], true), { state: 'running', stage: 'screen' });
  assert.deepEqual(deriveStatus(['plan.json', 'stopped.json'], false), { state: 'stopped', stage: 'approve' });
  assert.deepEqual(deriveStatus(['plan.json'], false), { state: 'awaiting_approval' });
  assert.deepEqual(deriveStatus([], false), { state: 'running', stage: 'plan' });
});

test('reviewProgress enriches deriveStatus with the plan, note path, papers found and per-agent state', async () => {
  const { ctx, files } = stageCtx({ autoApprove: true });
  await runReview(ctx);
  const list = await files();
  const io = { read: ctx.read, has: ctx.has };
  const progress = await reviewProgress(io, 'r1', list, false);
  assert.equal(progress.status.state, 'done');
  assert.equal(progress.papersFound, 2);
  assert.equal(progress.outside.length, 0);
  assert.equal(progress.report, undefined, 'list() snapshots leave the report out');
  const watched = await reviewProgress(io, 'r1', list, false, { withReport: true });
  assert.ok(watched.report?.title, 'watch() snapshots carry the finished report');
  assert.equal(watched.started, null, 'a non-ULID id has no start time');
  const at = Date.UTC(2026, 8, 26, 14, 30, 5, 123);
  assert.equal((await reviewProgress(io, ulid(at), list, false)).started, new Date(at).toISOString());

  const { ctx: waitingCtx, files: waitingFiles } = stageCtx({ autoApprove: false });
  await runReview(waitingCtx);
  const waitList = await waitingFiles();
  const waitingProgress = await reviewProgress({ read: waitingCtx.read, has: waitingCtx.has }, 'r2', waitList, false);
  assert.equal(waitingProgress.status.state, 'awaiting_approval');
  assert.equal(waitingProgress.status.plan.subQuestions.length, 2);
});
