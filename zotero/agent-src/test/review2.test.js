import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_STAGES_2, runReview, deriveStatus, reviewProgress, WAIT } from '../src/review.js';
import { CLARIFY_SCHEMA, PLAN_SCHEMA_2, CANDIDATES_SCHEMA, REPORT_SCHEMA_2, REPORT_CAPS } from '../src/prompts.js';
import { searchTools, verifyCandidates, mergeCandidates, rankCandidates, screen2Stage, decide, isIncluded, normalizePlan, cleanQuestions, checkEvidence, countsOf } from '../src/review2.js';
import { papersResultFromReview } from '../src/review-session.js';
import { createToolGateway } from '../src/tools.js';
import { memoryFs } from './support/memory-fs.mjs';

const REQUEST = { question: 'Does X help Y?', scope: { kind: 'library' }, sources: ['papers'], years: { from: null, to: null }, depth: 'quick', pipeline: 2 };

const cand = (n, extra = {}) => ({ citekey: `key${n}`, doi: `10.1/${n}`, url: null, title: `Paper ${n}`, year: 2020, abstract: `Abstract of paper ${n} says that X helps Y in trial ${n}.`, authors: ['A'], venue: 'J', ...extra });

/** Fake structured turns for pipeline 2, dispatching on the schema object the stage passed. */
function fakeTurns(o = {}) {
  const calls = { clarify: 0, plan: 0, search: 0, extract: [], writer: 0 };
  return {
    calls,
    async structured(role, prompt, schema, tools, signal) {
      if (schema === CLARIFY_SCHEMA) { calls.clarify += 1; return (o.clarify ?? (() => ({ questions: [] })))({ prompt }); }
      if (schema === PLAN_SCHEMA_2) {
        calls.plan += 1;
        return (o.plan ?? (() => ({
          subQuestions: [{ id: 'sq1', question: 'about one', strategy: 's', sources: ['papers'] }, { id: 'sq2', question: 'about two', strategy: 's', sources: ['papers'] }],
          criteria: [{ text: 'Is a trial', strict: true }, { text: 'Recent', strict: false }],
          columns: [{ name: 'Main findings', instruction: 'The findings' }],
          assumed: [],
        })))({ prompt });
      }
      if (schema === CANDIDATES_SCHEMA) {
        calls.search += 1;
        const sq = tools.audit.split(':').pop();
        return (o.search ?? (({ sq: id }) => ({ candidates: id === 'sq1' ? [cand(1), cand(2), cand(3)] : [cand(3), cand(4)], searchLog: [{ query: id, source: 'papers', results: 3 }] })))({ sq, tools });
      }
      if (schema === REPORT_SCHEMA_2) {
        calls.writer += 1;
        assert.equal(tools.none, true, 'the writer has no tools');
        return (o.writer ?? (({ prompt: p }) => ({ title: 'T', scope: 'S', method: 'M', themes: [], evidence: [{ claim: 'X helps', sources: ['key1', 'ghost'], strength: 'strong', cells: [{ row: 'p:key1', column: 'main_findings' }, { row: 'p:key1', column: 'nope' }] }], disagreements: '', gaps: '' })))({ prompt });
      }
      // extraction turn (screening or extract): answer every paper and column named in the prompt
      assert.equal(role, 'extract');
      assert.equal(tools.none, true, 'extraction turns run with no tools');
      calls.extract.push(prompt);
      return (o.extract ?? defaultExtract)({ prompt });
    },
  };
}

function defaultExtract({ prompt }) {
  const rows = [];
  for (const block of prompt.split('### Paper ').slice(1)) {
    const id = block.split('\n')[0].trim();
    const cols = /Columns to fill: (.*)/.exec(block)[1].split(', ');
    const abstract = /"""\n([\s\S]*?)\n"""/.exec(block)[1];
    rows.push({ row: id, cells: cols.map((column) => ({ column, status: 'found', value: column.startsWith('criterion') ? 'yes' : 'ok', quotes: [abstract.slice(0, 20)] })) });
  }
  return { rows };
}

function stageCtx({ id = 'r2', request = REQUEST, autoApprove = false, turns = fakeTurns(), signal } = {}) {
  const fs = memoryFs();
  const dir = `reviews/${id}`;
  const published = [];
  return {
    fs,
    ctx: {
      reviewId: id, request,
      read: async (f) => JSON.parse(await fs.read(`${dir}/${f}`)),
      write: async (f, v) => fs.writeAtomic(`${dir}/${f}`, JSON.stringify(v)),
      has: async (f) => (await fs.read(`${dir}/${f}`)) !== null,
      remove: async (f) => fs.remove(`${dir}/${f}`),
      turns,
      getRoleModel: async () => ({ provider: 'fake', model: 'm1' }),
      notes: { async publish(note) { published.push(note); return { path: `ai_notes/${note.title}.md` }; } },
      settings: { autoApprove },
      extract: (() => { const x = { workers: 2, modes: [], readText: async (row, mode) => { x.modes.push(mode); return row.abstract ? { text: row.abstract, from: 'abstract' } : null; } }; return x; })(),
      signal: signal ?? new AbortController().signal,
    },
    published,
    files: async () => [...fs.files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
  };
}

test('pipeline 2 stage table: clarify, plan, approve, search, screen, extract, synthesize, publish', () => {
  assert.deepEqual(REVIEW_STAGES_2.map((s) => s.id), ['clarify', 'plan', 'approve', 'search', 'screen', 'extract', 'synthesize', 'publish']);
});

test('clarify with 0 questions never waits: the plan stage runs straight away', async () => {
  const t = fakeTurns();
  const { ctx, files } = stageCtx({ turns: t });
  await runReview(ctx);
  const list = await files();
  assert.ok(list.includes('clarify.json') && list.includes('plan.json'));
  assert.ok(!list.includes('clarify-questions.json'));
  assert.deepEqual(deriveStatus(list, false, 2), { state: 'awaiting_approval' });
});

test('clarify with questions waits, survives a restart, and an answer resumes at the plan', async () => {
  const t = fakeTurns({ clarify: () => ({ questions: [
    { id: 'route', question: 'Which route?', choices: ['Narrative', 'Formal', 'Quick'], other: true },
    { id: 'when', question: 'From when?', choices: ['2015', 'Any'], other: false },
    { id: 'extra', question: 'A third', choices: ['a', 'b'], other: false },
  ] }) });
  const { ctx, files } = stageCtx({ turns: t });
  await runReview(ctx);
  let list = await files();
  assert.deepEqual(list, ['clarify-questions.json']);
  assert.equal(deriveStatus(list, false, 2).state, 'awaiting_answer');
  assert.equal(deriveStatus(list, true, 2).state, 'running');
  await ctx.write('request.json', REQUEST);
  const progress = await reviewProgress({ read: ctx.read, has: ctx.has }, 'r2', [...list, 'request.json'], false);
  assert.equal(progress.status.state, 'awaiting_answer');
  assert.equal(progress.status.questions.length, 2, 'at most two questions');

  await runReview(ctx); // "restart while waiting": no second clarify turn
  assert.equal(t.calls.clarify, 1);
  assert.deepEqual((await files()).filter((f) => f !== 'request.json'), ['clarify-questions.json']);

  const questions = await ctx.read('clarify-questions.json');
  await ctx.write('clarify.json', { questions, answers: [{ id: 'route', choice: 1, other: null }, { id: 'when', choice: null, other: null }] });
  await runReview(ctx);
  list = await files();
  assert.ok(list.includes('plan.json'));
  assert.equal(t.calls.clarify, 1);
  assert.equal(t.calls.plan, 1);
  assert.deepEqual(deriveStatus(list, false, 2), { state: 'awaiting_approval' });
});

test('the plan prompt carries the answers, and "You decide" is left to the lead', async () => {
  let planPrompt = '';
  const t = fakeTurns({ plan: ({ prompt }) => { planPrompt = prompt; return { subQuestions: [{ id: 'sq1', question: 'q', strategy: 's', sources: ['papers'] }], criteria: [], columns: [], assumed: ['Assumed: 2015 onward'] }; } });
  const { ctx } = stageCtx({ turns: t });
  await ctx.write('clarify.json', { questions: [{ id: 'route', question: 'Which route?', choices: ['Narrative', 'Formal'], other: true }, { id: 'when', question: 'From when?', choices: ['2015', 'Any'], other: false }], answers: [{ id: 'route', choice: 1, other: null }, { id: 'when', choice: null, other: null }] });
  await runReview(ctx);
  assert.match(planPrompt, /Which route\? Formal/);
  assert.match(planPrompt, /From when\? The researcher left this to you/);
  assert.deepEqual((await ctx.read('plan.json')).assumed, ['Assumed: 2015 onward']);
});

test('autoApprove skips clarify (no turn) and the lead is told to record what it assumed', async () => {
  let planPrompt = '';
  const t = fakeTurns({ plan: ({ prompt }) => { planPrompt = prompt; return { subQuestions: [{ id: 'sq1', question: 'q', strategy: 's', sources: ['papers'] }], criteria: [], columns: [], assumed: [] }; } });
  const { ctx } = stageCtx({ turns: t, autoApprove: true });
  await runReview(ctx);
  assert.equal(t.calls.clarify, 0);
  assert.match(planPrompt, /list each as a short line in "assumed"/);
});

test('runs end to end: candidates de-duplicated, strict criterion screens, table and report written from the table', async () => {
  const t = fakeTurns({
    // paper 2 fails the strict criterion, paper 4 is unclear
    extract: ({ prompt }) => {
      const out = defaultExtract({ prompt });
      for (const r of out.rows) for (const c of r.cells) if (c.column === 'criterion_1') c.value = r.row === 'p:key2' ? 'no' : r.row === 'p:key4' ? 'unclear' : 'yes';
      return out;
    },
  });
  const { ctx, files, published } = stageCtx({ turns: t, autoApprove: true });
  await runReview(ctx);
  const list = await files();
  for (const stage of REVIEW_STAGES_2) assert.ok(list.includes(stage.output), `missing ${stage.output}`);
  assert.ok(!list.includes('stopped.json'));

  const candidates = await ctx.read('candidates.json');
  assert.deepEqual(candidates.rows.map((r) => r.id), ['p:key1', 'p:key2', 'p:key3', 'p:key4'], 'paper 3 found twice is one row');
  assert.deepEqual(candidates.rows.find((r) => r.id === 'p:key3').foundBy, ['q1', 'q2']);
  assert.equal(candidates.searchLog.length, 2);

  const screening = await ctx.read('screening.json');
  assert.equal(screening.decisions['p:key2'].ai, 'exclude');
  assert.deepEqual(screening.decisions['p:key2'].because, ['criterion_1']);
  assert.equal(screening.decisions['p:key4'].ai, 'unclear', 'unclear is kept');
  assert.equal(screening.decisions['p:key1'].ai, 'include');
  assert.equal(screening.perCriterion.criterion_1, 1);

  const table = await ctx.read('table.json');
  assert.deepEqual(table.rows.map((r) => r.id), ['p:key1', 'p:key3', 'p:key4'], 'the excluded paper is not extracted');
  assert.equal(table.cells['p:key1'].main_findings.state, 'filled');
  assert.equal(table.cells['p:key1'].main_findings.quotes[0].verified, true);

  const report = await ctx.read('report.json');
  assert.deepEqual(report.evidence[0].sources, ['key1'], 'a source that is not an included citekey is dropped');
  assert.deepEqual(report.evidence[0].cells, [{ row: 'p:key1', column: 'main_findings' }], 'a cell that is not in the table is dropped');
  assert.equal(report.references.length, 3);

  assert.equal(published.length, 1);
  const md = published[0].markdown;
  assert.match(md, /4 papers were found\. 1 were screened out, 3 were included, and 3 had data extracted\./);
  assert.match(md, /Excluded by criterion: Is a trial \(1\)/);
  assert.match(md, /## Extraction table/);
  assert.match(md, /\| \[@key1\] \| ok \|/);
  assert.deepEqual(countsOf(candidates, screening, table), { candidates: 4, included: 3, excluded: 1, extracted: 3 });
});

test('the caps by depth limit candidates and extracted papers', async () => {
  const many = Array.from({ length: 30 }, (_, i) => cand(i + 1));
  const t = fakeTurns({
    search: () => ({ candidates: many, searchLog: [] }),
    plan: () => ({ subQuestions: [{ id: 'sq1', question: 'q', strategy: 's', sources: ['papers'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] }),
  });
  const { ctx } = stageCtx({ turns: t, autoApprove: true });
  await runReview(ctx);
  assert.equal((await ctx.read('plan.json')).caps.extract, REPORT_CAPS.quick.extract);
  assert.equal((await ctx.read('candidates.json')).rows.length, 30);
  assert.equal((await ctx.read('table.json')).rows.length, 20, 'quick extracts 20');
});

test('saved depths load unchanged: quick, standard and deep keep their caps, and fastest has its own', () => {
  const caps = (depth) => normalizePlan({ subQuestions: [], criteria: [], columns: [], assumed: [] }, { ...REQUEST, depth }).caps;
  assert.deepEqual(caps('quick'), { candidates: 60, extract: 20 });
  assert.deepEqual(caps('standard'), { candidates: 150, extract: 40 });
  assert.deepEqual(caps('deep'), { candidates: 300, extract: 80 });
  assert.deepEqual(caps('fastest'), REPORT_CAPS.fastest);
});

test('no criteria means every paper is included without a screening turn', async () => {
  const t = fakeTurns({ plan: () => ({ subQuestions: [{ id: 'sq1', question: 'q', strategy: 's', sources: ['papers'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] }) });
  const { ctx } = stageCtx({ turns: t, autoApprove: true });
  await runReview(ctx);
  const screening = await ctx.read('screening.json');
  assert.ok(Object.values(screening.decisions).every((d) => d.ai === 'include'));
  assert.ok(t.calls.extract.every((p) => !p.includes('criterion_1')), 'only extraction turns ran');
});

test('fastest: no screening turn, abstracts only, ranked candidates kept up to the cap', async () => {
  // 30 candidates; the last 10 have no abstract and key30 was found by both sub-questions
  const many = Array.from({ length: 30 }, (_, i) => cand(i + 1, i >= 20 ? { abstract: '' } : {}));
  const t = fakeTurns({
    search: ({ sq }) => ({ candidates: sq === 'sq1' ? many.slice(0, 29) : [many[29], many[4]], searchLog: [] }),
  });
  const { ctx } = stageCtx({ turns: t, autoApprove: true, request: { ...REQUEST, depth: 'fastest' } });
  await runReview(ctx);
  assert.equal((await ctx.read('plan.json')).caps.extract, REPORT_CAPS.fastest.extract);
  const screening = await ctx.read('screening.json');
  assert.ok(Object.values(screening.decisions).every((d) => d.ai === 'include'), 'every candidate stays in');
  assert.deepEqual(screening.cells, {}, 'no criterion was asked of the model');
  assert.ok(t.calls.extract.every((p) => !p.includes('criterion_1')), 'no screening turn ran');
  assert.equal(ctx.extract.modes.length > 0 && ctx.extract.modes.every((m) => m === 'abstract'), true, 'extraction never asks for full text');
  const table = await ctx.read('table.json');
  assert.equal(table.rows.length, REPORT_CAPS.fastest.extract);
  assert.equal(table.rows[0].id, 'p:key5', 'found by two sub-questions ranks first among papers with an abstract');
  assert.ok(table.rows.every((r) => r.abstract), 'papers with an abstract come before those without');
});

test('fastest in a systematic review still screens, on abstracts', async () => {
  const t = fakeTurns();
  const { ctx } = stageCtx({ turns: t, request: { ...REQUEST, depth: 'fastest', systematic: true } });
  await ctx.write('approved-plan.json', { subQuestions: [], criteria: [{ id: 'criterion_1', text: 'Is a trial', strict: true }], columns: [] });
  await ctx.write('candidates.json', { rows: [1, 2].map((n) => mergeCandidates([[cand(n)]], 5)[0]), searchLog: [] });
  const out = await screen2Stage(ctx);
  assert.ok(t.calls.extract.some((p) => p.includes('criterion_1')), 'the strict criterion was screened');
  assert.deepEqual(ctx.extract.modes.filter((m) => m !== 'abstract'), [], 'on abstracts');
  assert.equal(out.decisions['p:key1'].ai, 'include');
});

test('rankCandidates orders by abstract, then sub-questions that found it, then library, and is stable', () => {
  const row = (id, abstract, foundBy, inLibrary) => ({ id, abstract, foundBy, inLibrary });
  const ranked = rankCandidates([row('a', '', ['q1', 'q2'], true), row('b', 'x', ['q1'], false), row('c', 'x', ['q1'], true), row('d', 'x', ['q1', 'q2'], false), row('e', 'x', ['q1'], false)]);
  assert.deepEqual(ranked.map((r) => r.id), ['d', 'c', 'b', 'e', 'a']);
});

test('default columns: three standard ones plus one per sub-question when the plan named none', async () => {
  const t = fakeTurns({ plan: () => ({ subQuestions: [{ id: 'sq1', question: 'What works?', strategy: 's', sources: ['papers'] }], criteria: [], columns: [], assumed: [] }) });
  const { ctx } = stageCtx({ turns: t, autoApprove: true });
  await runReview(ctx);
  const table = await ctx.read('table.json');
  assert.deepEqual(table.columns.map((c) => c.name), ['Main findings', 'Methodology', 'Limitations', 'What works?']);
});

test('every extraction batch failing stops the review with a reason instead of writing an empty table', async () => {
  const t = fakeTurns({ extract: () => { throw Object.assign(new Error('boom'), { kind: 'rate_limited' }); } });
  const { ctx, files } = stageCtx({ turns: t, autoApprove: true });
  await runReview(ctx);
  const list = await files();
  assert.ok(list.includes('stopped.json'));
  assert.equal((await ctx.read('stopped.json')).reason, 'rate_limited');
  assert.ok(!list.includes('screening.json'));
  assert.equal(deriveStatus(list, false, 2).state, 'stopped');
});

test('progress: stage lines and counts come from the files', async () => {
  const { ctx, files } = stageCtx({ autoApprove: true });
  await runReview(ctx);
  const list = [...(await files()), 'request.json'];
  await ctx.write('request.json', REQUEST);
  const progress = await reviewProgress({ read: ctx.read, has: ctx.has }, 'r2', list, false, { withReport: true });
  assert.equal(progress.status.state, 'done');
  assert.deepEqual(progress.lines.map((l) => l.title), ['Planned 2 sub-questions', 'Ran searches', 'Screened 4 papers', 'Extracted 1 column from 4 papers', 'Wrote the report from the table']);
  assert.equal(progress.lines[1].detail, '2 searches, 4 papers');
  assert.deepEqual(progress.counts, { candidates: 4, included: 4, excluded: 0, extracted: 4 });
  assert.equal(progress.papersFound, 4);
});

test('decide: strict no excludes, unclear keeps, preferred never excludes; a user override wins and is kept apart', () => {
  const criteria = [{ id: 'a', text: 'A', strict: true }, { id: 'b', text: 'B', strict: false }];
  const cell = (value) => ({ state: 'filled', value, quotes: [], citations: [] });
  assert.equal(decide(criteria, { a: cell('no'), b: cell('yes') }).ai, 'exclude');
  assert.equal(decide(criteria, { a: cell('yes'), b: cell('no') }).ai, 'include');
  assert.equal(decide(criteria, { a: cell('unclear'), b: cell('yes') }).ai, 'unclear');
  assert.equal(decide(criteria, { a: { state: 'failed', error: 'x' }, b: cell('yes') }).ai, 'unclear');
  const excluded = decide(criteria, { a: cell('no'), b: cell('yes') });
  assert.equal(isIncluded(excluded), false);
  assert.equal(isIncluded({ ...excluded, user: 'include' }), true);
  assert.equal(isIncluded({ ai: 'include', because: [], user: 'exclude' }), false);
});

test('cleanQuestions caps at 2, needs 2-4 choices and unique ids', () => {
  const q = (id, n) => ({ id, question: `Q ${id}`, choices: Array.from({ length: n }, (_, i) => `c${i}`), other: false });
  const out = cleanQuestions({ questions: [q('a', 6), q('a', 3), q('c', 3), q('d', 1)] });
  assert.equal(out.length, 2);
  assert.equal(out[0].choices.length, 4);
  assert.notEqual(out[0].id, out[1].id);
  assert.deepEqual(cleanQuestions({ questions: [q('x', 1)] }), []);
});

test('mergeCandidates keeps the richer abstract and folds a DOI / title duplicate into one row', () => {
  const rows = mergeCandidates([[cand(1, { abstract: '' })], [cand(1, { citekey: null }), { ...cand(9), citekey: null, doi: null, title: 'PAPER 1!' }]], 10);
  assert.equal(rows.length, 1);
  assert.match(rows[0].abstract, /Abstract of paper 1/);
  assert.equal(rows[0].id, 'p:key1');
  assert.deepEqual(rows[0].foundBy, ['q1', 'q2']);
  assert.equal(mergeCandidates([[cand(1), cand(2), cand(3)]], 2).length, 2);
  const web = mergeCandidates([[cand(5, { citekey: null })]], 5)[0];
  assert.equal(web.inLibrary, false);
  assert.deepEqual(web.ref, { kind: 'web', url: 'https://doi.org/10.1/5' });
});

test('normalizePlan derives ids and caps, never trusting the model for them', () => {
  const plan = normalizePlan({ subQuestions: [], criteria: [{ text: 'A', strict: true }, { text: '  ', strict: true }], columns: [{ name: 'Sample size', instruction: 'n' }, { name: 'Sample size', instruction: 'n2' }], assumed: [' Assumed: 2015 '] }, { ...REQUEST, depth: 'deep' });
  assert.deepEqual(plan.criteria, [{ id: 'criterion_1', text: 'A', strict: true }]);
  assert.deepEqual(plan.columns.map((c) => c.id), ['sample_size', 'sample_size_2']);
  assert.deepEqual(plan.assumed, ['Assumed: 2015']);
  assert.deepEqual(plan.caps, REPORT_CAPS.deep);
});

test('checkEvidence drops cells that are pending or missing', () => {
  const table = { columns: [{ id: 'f', name: 'F' }], rows: [{ id: 'p:k', ref: { kind: 'paper', citekey: 'k' } }, { id: 'p:j', ref: { kind: 'paper', citekey: 'j' } }], cells: { 'p:k': { f: { state: 'filled', value: 'v', quotes: [], citations: [] } }, 'p:j': { f: { state: 'not_found', note: 'n' } } } };
  const out = checkEvidence({ evidence: [{ claim: 'c', strength: 'weak', sources: ['k', 'j', 'z'], cells: [{ row: 'p:k', column: 'f' }, { row: 'p:j', column: 'f' }, { row: 'p:zz', column: 'f' }] }] }, table);
  assert.deepEqual(out.evidence[0].cells, [{ row: 'p:k', column: 'f' }]);
  assert.deepEqual(out.evidence[0].sources, ['k', 'j']);
});

test('the session papers result carries criteria and extraction columns, cells and screening side by side', async () => {
  const { ctx } = stageCtx({ autoApprove: true });
  await runReview(ctx);
  const [candidates, screening, table, plan] = await Promise.all(['candidates.json', 'screening.json', 'table.json', 'approved-plan.json'].map((f) => ctx.read(f)));
  const body = papersResultFromReview({ candidates, screening, table, plan, question: REQUEST.question });
  assert.deepEqual(body.columns.map((c) => c.id), ['criterion_1', 'criterion_2', 'main_findings']);
  assert.equal(body.rows.length, 4);
  assert.equal(body.cells['p:key1'].criterion_1.state, 'filled');
  assert.equal(body.cells['p:key1'].main_findings.state, 'filled');
  assert.equal(body.screening['p:key1'].ai, 'include');
});

test('screening and extraction read a paper\'s head unless the request asks for the best text', async () => {
  const a = stageCtx({ autoApprove: true });
  await runReview(a.ctx);
  assert.ok(a.ctx.extract.modes.length > 0 && a.ctx.extract.modes.every((m) => m === 'head'));
  const b = stageCtx({ autoApprove: true, request: { ...REQUEST, text: 'best' } });
  await runReview(b.ctx);
  assert.ok(b.ctx.extract.modes.includes('best'), 'the extract stage asked for the best text');
});

test('a mostly failed extraction stops the review with the finished cells kept, and a resume redoes only the rest', async () => {
  let failing = true;
  const t = fakeTurns({
    plan: () => ({ subQuestions: [{ id: 'sq1', question: 'q', strategy: 's', sources: ['papers'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] }),
    search: () => ({ candidates: Array.from({ length: 24 }, (_, i) => cand(i + 1)), searchLog: [] }),
    extract: ({ prompt }) => {
      // 24 papers = 3 batches of 8; the first batch answers, the other two time out
      if (failing && !prompt.includes('### Paper p:key1\n')) throw Object.assign(new Error('This extract turn ran past its 3-minute limit and was stopped.'), { kind: 'timeout' });
      return defaultExtract({ prompt });
    },
  });
  const { ctx, files } = stageCtx({ turns: t, autoApprove: true, request: { ...REQUEST, depth: 'standard' } });
  await runReview(ctx);
  let list = await files();
  assert.ok(list.includes('stopped.json') && !list.includes('table.json'), 'no table of holes is written');
  assert.equal((await ctx.read('stopped.json')).reason, 'timeout');
  const partial = await ctx.read('extract-partial.json');
  assert.equal(partial.filter(([, c]) => c.state === 'filled').length, 8, 'the first batch is kept');

  failing = false;
  const before = t.calls.extract.length;
  await ctx.remove('stopped.json');
  await runReview(ctx);
  list = await files();
  assert.ok(list.includes('table.json') && list.includes('note.json') && !list.includes('extract-partial.json'));
  const rerun = t.calls.extract.slice(before).join('\n');
  assert.ok(!rerun.includes('### Paper p:key1\n'), 'a paper that was already done is not read again');
  assert.equal((await ctx.read('table.json')).rows.length, 24);
  assert.ok(Object.values((await ctx.read('table.json')).cells).every((row) => row.main_findings.state === 'filled'));
});

test('a batch that fails once is retried within the stage, so a transient crash leaves no holes', async () => {
  const failedOnce = new Set();
  const t = fakeTurns({
    plan: () => ({ subQuestions: [{ id: 'sq1', question: 'q', strategy: 's', sources: ['papers'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] }),
    search: () => ({ candidates: Array.from({ length: 16 }, (_, i) => cand(i + 1)), searchLog: [] }),
    extract: ({ prompt }) => {
      const first = /### Paper (\S+)/.exec(prompt)[1];
      if (first === 'p:key9' && !failedOnce.has(first)) { failedOnce.add(first); throw new Error('Claude exited unexpectedly.'); }
      return defaultExtract({ prompt });
    },
  });
  const { ctx, files } = stageCtx({ turns: t, autoApprove: true });
  await runReview(ctx);
  const list = await files();
  assert.ok(list.includes('note.json') && !list.includes('stopped.json'));
  assert.equal(failedOnce.size, 1, 'one batch failed once');
  const table = await ctx.read('table.json');
  assert.ok(Object.values(table.cells).every((row) => row.main_findings.state === 'filled'), 'and its cells were filled on the retry');
});

test('a researcher that fails once is retried; one that keeps failing stops the review and says why', async () => {
  const calls = new Map();
  const t = fakeTurns({
    plan: () => ({ subQuestions: [{ id: 'a', question: 'qa', strategy: 's', sources: ['papers'] }, { id: 'b', question: 'qb', strategy: 's', sources: ['papers'] }], criteria: [], columns: [{ name: 'Main findings', instruction: 'f' }], assumed: [] }),
    search: ({ sq }) => {
      const key = sq;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (key === 'a' && calls.get(key) === 1) throw Object.assign(new Error('Claude exited unexpectedly.'), { kind: 'provider_crashed' });
      if (key === 'b') throw Object.assign(new Error('the answer was not JSON'), { kind: 'bad_output' });
      return { candidates: [cand(1)], searchLog: [] };
    },
  });
  const { ctx, files } = stageCtx({ turns: t, autoApprove: true });
  await runReview(ctx);
  const stopped = await ctx.read('stopped.json');
  assert.equal(calls.get('a'), 2, 'a retried after its first crash');
  assert.equal(calls.get('b'), 2, 'b tried twice');
  assert.ok((await files()).includes('search/a.json'), 'a finished on the retry');
  assert.equal(stopped.reason, 'bad_output');
  assert.match(stopped.message, /"b" did not finish: the answer was not JSON/);
});

// ---------- a search stage whose every search failed stops instead of reporting nothing ----------

const FAILING_LIBRARY = { async search() { throw new Error('connect ECONNREFUSED 127.0.0.1:27182'); }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
const EMPTY_LIBRARY = { ...FAILING_LIBRARY, async search() { return []; } };

/** A researcher that really calls the tool gateway (its search_library hits `library`), then finds nothing. */
const searchingTurns = (library) => fakeTurns({
  search: async ({ tools }) => {
    const gateway = await createToolGateway(async () => { throw new Error('offline'); }, library, {});
    await gateway.open(tools).call('search_library', { query: 'x' });
    return { candidates: [], searchLog: [{ query: 'x', source: 'papers', results: 0 }] };
  },
});

test('every search failing and nothing found stops the review with a plain reason, and writes no report', async () => {
  const { ctx, files, published } = stageCtx({ turns: searchingTurns(FAILING_LIBRARY), autoApprove: true });
  await runReview(ctx);
  const stopped = await ctx.read('stopped.json');
  assert.match(stopped.message, /^The searches failed: .*ECONNREFUSED/);
  assert.equal(stopped.reason, 'provider_crashed');
  assert.equal(published.length, 0);
  assert.ok(!(await files()).includes('report.json'));
});

test('zero candidates from searches that worked is a normal result, not a stop', async () => {
  const { ctx, files } = stageCtx({ turns: searchingTurns(EMPTY_LIBRARY), autoApprove: true });
  await runReview(ctx);
  assert.ok(!(await files()).includes('stopped.json'));
  assert.ok((await files()).includes('candidates.json'));
});

// ---------- researcher-transcribed abstracts are checked against the library ----------

/** A library with two papers: key1 (the researcher copied a wrong abstract for it) and key2real (the researcher invented the citekey "ghost"). */
function fakeLibrary({ failRead = false } = {}) {
  const papers = {
    key1: { title: 'Paper 1', text: 'Paper 1\nLIBRARY abstract one: X helps Y.' },
    key2real: { title: 'Paper 2', text: 'Paper 2\nDOI: 10.1/2\nLIBRARY abstract two: X helps Y a bit.' },
  };
  const calls = { read: 0, search: 0 };
  return {
    calls,
    async read(ref) {
      calls.read += 1;
      if (failRead) throw new Error('library down');
      const p = ref.kind === 'paper' ? papers[ref.citekey] : null;
      return p ? { title: p.title, text: p.text } : null;
    },
    async search({ text }) {
      calls.search += 1;
      const t = text.toLowerCase();
      return Object.entries(papers).filter(([, p]) => p.text.toLowerCase().includes(t) || p.title.toLowerCase() === t)
        .map(([citekey, p]) => ({ ref: { kind: 'paper', citekey }, title: p.title, snippet: '', year: 2020 }));
    },
  };
}

const rowsFor = (...cands) => mergeCandidates([cands], 20);

test('verifyCandidates: a library paper gets the library\'s text, an invented citekey is matched by DOI, outside papers are marked', async () => {
  const lib = fakeLibrary();
  const rows = await verifyCandidates(rowsFor(
    cand(1, { abstract: 'a transcription that is wrong' }),
    cand(2, { citekey: 'ghost' }),
    cand(3, { citekey: null, doi: '10.1/3' }),
    cand(4, { citekey: null, doi: '10.1/4', abstract: '' }),
  ), lib);
  const [one, two, three, four] = rows;
  assert.equal(one.abstractStatus, 'library');
  assert.match(one.abstract, /LIBRARY abstract one/);
  assert.equal(one.inLibrary, true);
  assert.equal(two.abstractStatus, 'library', 'the invented citekey found the real paper by its DOI');
  assert.deepEqual(two.ref, { kind: 'paper', citekey: 'key2real' });
  assert.match(two.abstract, /LIBRARY abstract two/);
  assert.equal(three.abstractStatus, 'unverified');
  assert.equal(three.inLibrary, false);
  assert.match(three.abstract, /Abstract of paper 3/, 'the researcher\'s words are kept, just flagged');
  assert.equal(four.abstractStatus, 'none');
});

test('verifyCandidates: an unknown citekey with no match becomes an outside paper; a DOI prefix is not a match; a library error marks nothing checked', async () => {
  const lib = fakeLibrary();
  const [ghost] = await verifyCandidates(rowsFor(cand(7, { citekey: 'ghost7' })), lib);
  assert.equal(ghost.inLibrary, false);
  assert.equal(ghost.fullText, false);
  assert.equal(ghost.ref.kind, 'web');
  assert.equal(ghost.abstractStatus, 'unverified');
  const [prefix] = await verifyCandidates(rowsFor(cand(20, { citekey: null, doi: '10.1/2', title: 'Something else', abstract: 'x' })), fakeLibrary());
  assert.equal(prefix.abstractStatus, 'library', 'the DOI 10.1/2 is in the library text exactly');
  const [near] = await verifyCandidates(rowsFor(cand(21, { citekey: null, doi: '10.1/22', title: 'Something else', abstract: 'x' })), fakeLibrary());
  assert.equal(near.abstractStatus, 'unverified');
  const down = fakeLibrary({ failRead: true });
  const [kept] = await verifyCandidates(rowsFor(cand(1)), down);
  assert.equal(kept.abstractStatus, 'unverified', 'an unreadable library never yields "library"');
  assert.equal(kept.inLibrary, true);
});

test('a review with a library: unverified abstracts flag cells, quotes, evidence and the method; an empty abstract is never a filled cell', async () => {
  const lib = fakeLibrary();
  const t = fakeTurns({
    search: () => ({ candidates: [cand(1, { abstract: 'wrong' }), cand(3, { citekey: null }), cand(4, { citekey: null, abstract: '' })], searchLog: [] }),
    writer: () => ({ title: 'T', scope: 'S', method: 'M', themes: [], evidence: [
      { claim: 'from outside', sources: [], strength: 'weak', cells: [{ row: 'doi:10.1/3', column: 'main_findings' }] },
      { claim: 'from library', sources: ['key1'], strength: 'strong', cells: [{ row: 'p:key1', column: 'main_findings' }] },
    ], disagreements: '', gaps: '' }),
  });
  const { ctx, published } = stageCtx({ autoApprove: true, turns: t });
  ctx.library = lib;
  await runReview(ctx);
  const cands = await ctx.read('candidates.json');
  assert.deepEqual(cands.rows.map((r) => r.abstractStatus), ['library', 'unverified', 'none']);
  const table = await ctx.read('table.json');
  const lone = cands.rows[1].id;
  const blank = cands.rows[2].id;
  assert.equal(table.cells['p:key1'].main_findings.unverified, undefined);
  assert.equal(table.cells['p:key1'].main_findings.quotes[0].verified, true, 'quotes from the library\'s text count as verified');
  const outsideCell = table.cells[lone].main_findings;
  assert.equal(outsideCell.state, 'filled');
  assert.equal(outsideCell.unverified, true);
  assert.ok(outsideCell.quotes.length && outsideCell.quotes.every((q) => q.unverified && !q.verified));
  assert.equal(table.cells[blank].main_findings.state, 'not_found', 'no abstract, no filled cell');
  assert.ok(!t.calls.extract.some((p) => p.includes(`### Paper ${blank}`)), 'a paper with nothing to read never reaches the model');
  const report = await ctx.read('report.json');
  assert.equal(report.evidence.find((e) => e.claim === 'from outside').unverified, true);
  assert.equal(report.evidence.find((e) => e.claim === 'from library').unverified, undefined);
  const md = published[0].markdown;
  assert.match(md, /1 of the 3 papers with data extracted are outside the library/);
  assert.match(md, /1 outside paper came back with no abstract/);
  assert.match(md, /weak \(abstract not checked\)/);
});

test('without a library handle the search stage leaves rows unmarked (hosts that cannot check)', async () => {
  const { ctx } = stageCtx({ autoApprove: true });
  await runReview(ctx);
  const cands = await ctx.read('candidates.json');
  assert.ok(cands.rows.every((r) => r.abstractStatus === undefined));
});

test('pipeline 2 search tools take the web mode saved on the request', () => {
  const ctx = (web) => ({ request: { ...REQUEST, ...(web ? { web } : {}) }, reviewId: 'r1' });
  assert.equal(searchTools(ctx('cached'), ['web'], 's').web, 'cached');
  assert.equal(searchTools(ctx(), ['web'], 's').web, 'live');
  assert.equal(searchTools(ctx('cached'), ['papers'], 's').web, 'off');
});
