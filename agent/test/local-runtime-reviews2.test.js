// Pipeline 2 through the real AgentService surface: clarify -> answer -> approve -> done, the session link, and a
// report started on a paper set. review2.test.js covers the stages; this covers core.js's wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { memoryFs } from './support/memory-fs.mjs';

const REQUEST = { question: 'Does spaced repetition beat massed practice?', scope: { kind: 'library' }, sources: ['papers'], years: { from: null, to: null }, depth: 'quick', pipeline: 2 };
const cand = (n) => ({ citekey: `k${n}`, doi: null, url: null, title: `Paper ${n}`, year: 2020, abstract: `Spaced practice helped learners in study ${n}.`, authors: [], venue: '' });

function fakeProvider({ questions = [], seen = [], candidates = null, beforeCandidates = null } = {}) {
  return {
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req) {
      seen.push(req.input.split('\n')[0]);
      let json;
      if (/^A researcher wants a literature report/.test(req.input)) json = { questions };
      else if (/^Plan a literature review/.test(req.input)) json = { subQuestions: [{ id: 'sq1', question: 'part 1', strategy: 's', sources: ['papers'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] };
      else if (/finding papers for one sub-question/.test(req.input)) { if (beforeCandidates) yield* beforeCandidates(); json = { candidates: candidates ?? [cand(1), cand(2)], searchLog: [{ query: 'q', source: 'papers', results: 2 }] }; }
      else if (/^You extract data/.test(req.input)) {
        const ids = [...req.input.matchAll(/### Paper (\S+)/g)].map((m) => m[1]);
        json = { rows: ids.map((row) => ({ row, cells: [{ column: 'main_findings', status: 'found', value: 'helped', quotes: ['Spaced practice helped'] }] })) };
      } else json = { title: 'A report', scope: 's', method: 'm', themes: [], evidence: [{ claim: 'It helps', sources: ['k1'], strength: 'strong', cells: [{ row: 'p:k1', column: 'main_findings' }] }], disagreements: '', gaps: '' };
      yield { type: 'final', text: JSON.stringify(json), json, usage: {} };
    },
    async dispose() {},
  };
}

async function runtime(fs, opts) {
  const gateway = { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; } }, async dispose() {} };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); }, ...(opts?.library ?? {}) };
  const published = [];
  const notes = { async publish(note) { published.push(note); return { path: `ai_notes/${note.title}.md` }; } };
  const ai = await createLocalRuntime({ platform: { fs }, library, notes, dataDir: '/data', providers: new Map([['fake', fakeProvider(opts)]]), gateway, getRoleModel: async () => ({ provider: 'fake', model: 'm1' }) });
  return { ai, published };
}

async function until(ai, id, state) {
  let last;
  for await (const p of ai.reviews.watch(id)) { last = p; if (p.status.state === state) return p; }
  throw new Error(`never reached ${state}, ended at ${last?.status.state}`);
}

const QUESTIONS = [{ id: 'route', question: 'Which route?', choices: ['Narrative', 'Formal'], other: true }];

test('start -> awaiting_answer -> answer -> awaiting_approval -> approvePlan -> done, with lines and counts', async () => {
  const fs = memoryFs();
  const { ai, published } = await runtime(fs, { questions: QUESTIONS });
  const id = await ai.reviews.start(REQUEST);
  const asked = await until(ai, id, 'awaiting_answer');
  assert.equal(asked.status.questions[0].id, 'route');

  await assert.rejects(() => ai.reviews.answer(id, [{ id: 'nope', choice: 0, other: null }]), /no such question/);
  await ai.reviews.answer(id, [{ id: 'route', choice: 1, other: null }]);
  const plan = await until(ai, id, 'awaiting_approval');
  assert.deepEqual(plan.lines.map((l) => l.title).slice(0, 2), ['Clarified the scope', 'Planned 1 sub-question']);
  assert.equal(plan.lines[0].detail, 'Formal');

  await ai.reviews.approvePlan(id, plan.status.plan);
  const done = await until(ai, id, 'done');
  assert.equal(published.length, 1);
  assert.deepEqual(done.counts, { candidates: 2, included: 2, excluded: 0, extracted: 2 });
  assert.equal(done.report.evidence[0].cells[0].row, 'p:k1');
  assert.match(published[0].markdown, /2 papers were found/);

  await ai.reviews.answer(id, [{ id: 'route', choice: 0, other: null }]); // a second answer changes nothing
  assert.equal(JSON.parse(await fs.read(`/data/reviews/${id}/clarify.json`)).answers[0].choice, 1);
});

test('an answer typed into Other wins over a choice, and an empty answer is "You decide"', async () => {
  const fs = memoryFs();
  const seen = [];
  const { ai } = await runtime(fs, { questions: [...QUESTIONS, { id: 'when', question: 'From when?', choices: ['2015', 'Any'], other: false }], seen });
  const id = await ai.reviews.start(REQUEST);
  await until(ai, id, 'awaiting_answer');
  await ai.reviews.answer(id, [{ id: 'route', choice: 0, other: '  scoping review  ' }]);
  await until(ai, id, 'awaiting_approval');
  const clarified = JSON.parse(await fs.read(`/data/reviews/${id}/clarify.json`));
  assert.deepEqual(clarified.answers, [{ id: 'route', choice: null, other: 'scoping review' }, { id: 'when', choice: null, other: null }]);
});

test('a review started from a session is one report step; when done it adds the report and the papers result', async () => {
  const fs = memoryFs();
  const { ai } = await runtime(fs);
  const session = await ai.conversations.create('chat');
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true, session });
  await until(ai, id, 'done');
  await new Promise((r) => setTimeout(r, 20));
  const view = await ai.sessions.view(session);
  assert.equal(view.steps.length, 1);
  assert.equal(view.steps[0].input.kind, 'report');
  assert.equal(view.steps[0].status, 'done');
  assert.deepEqual(view.results.map((r) => r.kind), ['report', 'papers']);
  const papers = await ai.sessions.read(session, view.results[1].ref);
  assert.equal(papers.rows.length, 2);
  assert.equal(papers.cells['p:k1'].main_findings.state, 'filled');
  const report = await ai.sessions.read(session, view.results[0].ref);
  assert.equal(report.review, id);
});

test('"Report on these": a review started on a paper set skips the search and starts from its rows', async () => {
  const fs = memoryFs();
  const seen = [];
  const { ai } = await runtime(fs, { seen });
  const session = await ai.conversations.create('chat');
  const rows = [cand(7), cand(8), cand(9)].map((c) => ({ id: `p:${c.citekey}`, ref: { kind: 'paper', citekey: c.citekey }, inLibrary: true, title: c.title, authors: [], year: 2020, venue: '', doi: null, url: null, abstract: c.abstract, citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: [] }));
  const summary = await ai.sessions.put(session, { kind: 'import', from: 'selection', label: 'x' }, { kind: 'papers', title: 'Set', query: null, rows, columns: [], cells: {}, screening: null, summary: null, from: [], change: '' });
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true, session, on: summary.ref });
  const done = await until(ai, id, 'done');
  assert.ok(!seen.some((l) => /finding papers/.test(l)), 'no researcher ran');
  assert.deepEqual(done.counts, { candidates: 3, included: 3, excluded: 0, extracted: 3 });
});

test('a pipeline-1 request (no `pipeline`) is untouched, and answering it is refused', async () => {
  const fs = memoryFs();
  const { ai } = await runtime(fs);
  const id = await ai.reviews.start({ ...REQUEST, pipeline: undefined, autoApprove: true });
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(() => ai.reviews.answer(id, []), /not waiting for answers/);
});

test('export renders the method counts and the extraction table for a pipeline-2 review', async () => {
  const fs = memoryFs();
  const { ai } = await runtime(fs);
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true });
  await until(ai, id, 'done');
  const out = await ai.reviews.export(id, 'md');
  const text = await fs.read(out.path);
  assert.match(text, /2 papers were found\. 0 were screened out, 2 were included, and 2 had data extracted\./);
  assert.match(text, /## Extraction table/);
});

const filled = (value, ref) => ({ state: 'filled', value, quotes: [], citations: [ref] });

test('"Write a report from this": a table with filled cells runs only synthesize and publish', async () => {
  const fs = memoryFs();
  const seen = [];
  const { ai, published } = await runtime(fs, { seen });
  const session = await ai.conversations.create('chat');
  const ref = { kind: 'paper', citekey: 'k1' };
  const table = await ai.sessions.put(session, { kind: 'import', from: 'selection', label: 'x' }, {
    kind: 'table', title: 'Trials', change: '', from: [],
    columns: [{ id: 'main_findings', name: 'Main findings', instruction: 'f', kind: 'text' }],
    rows: [{ id: 'r1', label: 'Study one', paper: null }, { id: 'r2', label: 'Study two', paper: null }],
    cells: { r1: { main_findings: filled('helped', ref) }, r2: { main_findings: { state: 'not_found', note: 'n' } } },
  });
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true, session, on: table.ref, fromTable: true });
  const done = await until(ai, id, 'done');
  assert.deepEqual(seen.map((l) => l.slice(0, 12)), ['Write a lite'], 'only the writer ran');
  assert.deepEqual(done.counts, { candidates: 2, included: 1, excluded: 1, extracted: 1 }, 'the row with nothing filled is left out');
  assert.equal(published.length, 1);
  assert.deepEqual(done.lines.map((l) => l.title), ['Extracted 1 column from 1 papers', 'Wrote the report from the table']);
});

test('a table with nothing filled cannot start a report', async () => {
  const fs = memoryFs();
  const { ai } = await runtime(fs);
  const session = await ai.conversations.create('chat');
  const table = await ai.sessions.put(session, { kind: 'import', from: 'selection', label: 'x' }, {
    kind: 'table', title: 'Empty', change: '', from: [], columns: [{ id: 'a', name: 'A', instruction: '', kind: 'text' }],
    rows: [{ id: 'r1', label: 'One', paper: null }], cells: { r1: { a: { state: 'pending' } } },
  });
  await assert.rejects(() => ai.reviews.start({ ...REQUEST, session, on: table.ref, fromTable: true }), /Nothing is filled in yet/);
});

test('a library paper is read from the library, so a candidate with no abstract still gets extracted and its quotes check against that text', async () => {
  const fs = memoryFs();
  const reads = [];
  const { ai } = await runtime(fs, {
    candidates: [{ ...cand(1), abstract: '' }, { ...cand(2), abstract: 'A reworded abstract the model made up.' }],
    library: { async read(ref) { reads.push(ref.citekey); return { title: 'T', text: `Skip to main content. Abstract. Spaced practice helped learners in study ${ref.citekey.slice(1)}.` }; } },
  });
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true });
  await until(ai, id, 'done');
  const table = JSON.parse(await fs.read(`/data/reviews/${id}/table.json`));
  console.log('DEBUG reads', reads, JSON.stringify(table.cells['p:k1']).slice(0,300), JSON.stringify(table.rows.map(r=>[r.id,r.inLibrary])));
  assert.ok(reads.includes('k1') && reads.includes('k2'), 'both library papers were read from the library');
  assert.equal(table.cells['p:k1'].main_findings.state, 'filled', 'the empty abstract was no obstacle');
  assert.equal(table.cells['p:k1'].main_findings.quotes[0].verified, true);
  assert.equal(table.cells['p:k1'].main_findings.quotes[0].from, 'full_text');
});

test('researcher activity shows in the running Searching line while the search is still going', async () => {
  const fs = memoryFs();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ai } = await runtime(fs, {
    candidates: [cand(1), cand(2)],
    beforeCandidates: async function* () {
      yield { type: 'activity', id: 'a1', phase: 'start', kind: 'scholarly', label: 'Searched OpenAlex: spaced practice', tool: 'search_scholarly', args: { query: 'spaced practice' } };
      yield { type: 'activity', id: 'a1', phase: 'end', ok: true, label: 'Searched OpenAlex: spaced practice' };
      await gate;
    },
  });
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true });
  let seen = null;
  for await (const p of ai.reviews.watch(id)) {
    const searching = p.lines?.find((l) => l.id === 'search' && l.state === 'running');
    if (searching?.items?.length) { seen = searching; release(); break; }
  }
  assert.ok(seen, 'a running search line carried the researcher\'s calls');
  assert.match(seen.items[0], /OpenAlex/);
  assert.ok(seen.detail, 'with a summary detail');
  await until(ai, id, 'done');
});
