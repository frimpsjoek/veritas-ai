// Spec 007 E8: a Systematic review: PICOS protocol, a strict criterion, larger caps, the wait on unclear papers
// (only above 10%), overrides kept beside the AI's calls and counted in the method section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_STAGES_SYSTEMATIC, REVIEW_STAGES_2, runReview, deriveStatus, reviewProgress, stagesFor } from '../src/review.js';
import { CLARIFY_SCHEMA, PLAN_SCHEMA_SYSTEMATIC, PLAN_SCHEMA_2, CANDIDATES_SCHEMA, REPORT_SCHEMA_2, SYSTEMATIC_CAPS } from '../src/prompts.js';
import { normalizePlan, withStrictCriterion, cleanProtocol, unclearRows, unclearList, UNCLEAR_SHARE } from '../src/review2.js';
import { renderReport } from '../src/report.js';
import { createLocalRuntime } from '../src/core.js';
import { memoryFs } from './support/memory-fs.mjs';

const REQUEST = { question: 'Does spaced practice help adult learners?', scope: { kind: 'library' }, sources: ['papers'], years: { from: null, to: null }, depth: 'standard', pipeline: 2, systematic: true };
const cand = (n) => ({ citekey: `k${n}`, doi: `10.1/${n}`, url: null, title: `Paper ${n}`, year: 2020, abstract: `Abstract of paper ${n} about spaced practice in adults.`, authors: [], venue: '' });
const PROTOCOL = { population: 'Adult learners', intervention: 'Spaced practice', comparison: null, outcomes: 'Retention', studyDesigns: ['rct'] };

/** unclearIds: paper numbers the screening answers "unclear" for; `no`: the one it answers "no" for. */
function turns({ unclearIds = [], no = [2], n = 10, seen = {} } = {}) {
  return {
    async structured(role, prompt, schema, tools) {
      if (schema === CLARIFY_SCHEMA) { seen.clarify = prompt; return { questions: [] }; }
      if (schema === PLAN_SCHEMA_SYSTEMATIC || schema === PLAN_SCHEMA_2) {
        seen.planSchema = schema === PLAN_SCHEMA_SYSTEMATIC ? 'systematic' : 'report'; seen.plan = prompt;
        return { subQuestions: [{ id: 'sq1', question: 'Does it help?', strategy: 's', sources: ['papers'] }], criteria: [{ text: 'Adult learners', strict: true }, { text: 'Recent', strict: false }], columns: [{ name: 'Retention', instruction: 'r' }], assumed: [], protocol: PROTOCOL };
      }
      if (schema === CANDIDATES_SCHEMA) return { candidates: Array.from({ length: n }, (_, i) => cand(i + 1)), searchLog: [{ query: 'q', source: 'papers', results: n }] };
      if (schema === REPORT_SCHEMA_2) return { title: 'T', scope: 'S', method: 'M', themes: [], evidence: [], disagreements: '', gaps: '' };
      const rows = [];
      for (const block of prompt.split('### Paper ').slice(1)) {
        const id = block.split('\n')[0].trim();
        const num = Number(id.replace('p:key', '').replace('p:k', ''));
        const cols = /Columns to fill: (.*)/.exec(block)[1].split(', ');
        const abstract = /"""\n([\s\S]*?)\n"""/.exec(block)[1];
        rows.push({ row: id, cells: cols.map((column) => ({ column, status: 'found', quotes: [abstract.slice(0, 20)], value: column === 'criterion_1' ? (no.includes(num) ? 'no' : unclearIds.includes(num) ? 'unclear' : 'yes') : column.startsWith('criterion') ? 'yes' : 'ok' })) });
      }
      return { rows };
    },
  };
}

function stageCtx({ t = turns(), request = REQUEST, autoApprove = true } = {}) {
  const fs = memoryFs();
  const dir = 'reviews/s1';
  const published = [];
  return {
    published,
    files: async () => [...fs.files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    ctx: {
      reviewId: 's1', request,
      read: async (f) => JSON.parse(await fs.read(`${dir}/${f}`)), write: async (f, v) => fs.writeAtomic(`${dir}/${f}`, JSON.stringify(v)),
      has: async (f) => (await fs.read(`${dir}/${f}`)) !== null, remove: async (f) => fs.remove(`${dir}/${f}`),
      turns: t, getRoleModel: async () => ({ provider: 'fake', model: 'm' }),
      notes: { async publish(note) { published.push(note); return { path: 'x' }; } }, settings: { autoApprove },
      extract: { workers: 2, readText: async (row) => ({ text: row.abstract, from: 'abstract' }) }, signal: new AbortController().signal,
    },
  };
}

test('the systematic stage table is the report one with a review stage after screening', () => {
  assert.deepEqual(REVIEW_STAGES_SYSTEMATIC.map((s) => s.id), ['clarify', 'plan', 'approve', 'search', 'screen', 'review', 'extract', 'synthesize', 'publish']);
  assert.equal(stagesFor({ pipeline: 2, systematic: true }), REVIEW_STAGES_SYSTEMATIC);
  assert.equal(stagesFor({ pipeline: 2 }), REVIEW_STAGES_2);
  assert.equal(stagesFor({ systematic: true }).length, 6, 'pipeline 1 ignores the flag');
});

test('the plan: PICOS with nulls where nothing applies, caps by depth, and at least one strict criterion', () => {
  assert.deepEqual(cleanProtocol({ population: ' Adults ', intervention: '', comparison: null, outcomes: 'x', studyDesigns: [] }), { population: 'Adults', intervention: null, comparison: null, outcomes: 'x', studyDesigns: null });
  assert.deepEqual(cleanProtocol(undefined), { population: null, intervention: null, comparison: null, outcomes: null, studyDesigns: null });
  const at = (depth) => normalizePlan({ subQuestions: [], criteria: [{ text: 'A', strict: false }], columns: [], assumed: [], protocol: PROTOCOL }, { ...REQUEST, depth });
  assert.deepEqual(at('standard').caps, SYSTEMATIC_CAPS.standard);
  assert.deepEqual(at('quick').caps, { candidates: 300, extract: 80 });
  assert.deepEqual(at('deep').caps, { candidates: 600, extract: 150 });
  assert.equal(at('deep').criteria[0].strict, true, 'the first criterion becomes strict when none is');
  assert.deepEqual(withStrictCriterion([], 'Q?').map((c) => [c.strict, c.text]), [[true, 'Addresses the question: Q?']]);
  const two = [{ id: 'a', text: 'A', strict: false }, { id: 'b', text: 'B', strict: true }];
  assert.equal(withStrictCriterion(two, 'Q').filter((c) => c.strict).length, 1, 'an existing strict criterion is left alone');
  assert.equal(normalizePlan({ subQuestions: [] }, { ...REQUEST, systematic: false }).protocol, undefined, 'a report plan has no protocol');
});

test('a systematic review plans with the systematic schema, and the prompt asks for PICOS and a strict criterion', async () => {
  const seen = {};
  const { ctx } = stageCtx({ t: turns({ seen }), autoApprove: false }); // asks (zero questions), plans, waits at approve
  await runReview(ctx);
  assert.equal(seen.planSchema, 'systematic');
  assert.match(seen.plan, /PICOS protocol/);
  assert.match(seen.plan, /at least one strict/);
  assert.match(seen.clarify, /formal systematic review/);
  assert.deepEqual((await ctx.read('plan.json')).protocol, PROTOCOL);
});

test('10% unclear or fewer goes straight on; more asks first', async () => {
  assert.equal(UNCLEAR_SHARE, 0.1);
  const exactlyTen = stageCtx({ t: turns({ unclearIds: [3] }) }); // 1 of 10
  await runReview(exactlyTen.ctx);
  assert.ok((await exactlyTen.files()).includes('note.json'), '10% exactly does not wait');

  const over = stageCtx({ t: turns({ unclearIds: [3, 4] }) }); // 2 of 10
  await runReview(over.ctx);
  const list = await over.files();
  assert.ok(list.includes('screening.json') && !list.includes('table.json') && !list.includes('note.json'));
  await over.ctx.write('request.json', REQUEST);
  assert.deepEqual(deriveStatus(list, false, 2, true), { state: 'awaiting_review' });
  assert.equal(deriveStatus(list, true, 2, true).state, 'running');
  const progress = await reviewProgress({ read: over.ctx.read, has: over.ctx.has }, 's1', [...list, 'request.json'], false);
  assert.equal(progress.status.state, 'awaiting_review');
  assert.equal(progress.status.total, 10);
  assert.deepEqual(progress.status.unclear.map((u) => [u.id, u.because, u.include]), [['p:k3', ['Adult learners'], true], ['p:k4', ['Adult learners'], true]]);
});

test('a report (not systematic) never waits on unclear papers', async () => {
  const t = turns({ unclearIds: [1, 2, 3, 4, 5] });
  const { ctx, files } = stageCtx({ t, request: { ...REQUEST, systematic: false } });
  await runReview(ctx);
  assert.ok((await files()).includes('note.json'));
});

test('the researcher\'s calls are stored beside the AI\'s, win, and are counted apart in the method', async () => {
  const { ctx, published } = stageCtx({ t: turns({ unclearIds: [3, 4], no: [2, 5] }) });
  await runReview(ctx); // waits: 2 of 10 unclear
  const screening = await ctx.read('screening.json');
  assert.equal(screening.decisions['p:k2'].ai, 'exclude');
  assert.equal(screening.perCriterion.criterion_1, 2);
  // the runtime's screened(): restore paper 2 (AI excluded), remove paper 4 (AI unclear), then resume
  screening.decisions['p:k2'].user = 'include';
  screening.decisions['p:k4'].user = 'exclude';
  await ctx.write('screening.json', screening);
  await ctx.write('screening-reviewed.json', { overrides: 2 });
  await runReview(ctx);
  const table = await ctx.read('table.json');
  const ids = table.rows.map((r) => r.id);
  assert.ok(ids.includes('p:k2') && !ids.includes('p:k4') && ids.includes('p:k3'), ids.join());
  assert.equal(ids.includes('p:k5'), false, 'an AI exclusion the researcher left alone stays out');
  assert.equal((await ctx.read('screening.json')).decisions['p:k2'].ai, 'exclude', 'the AI call is kept');
  const md = published[0].markdown;
  assert.match(md, /Protocol:\n\n- Population: Adult learners\n- Intervention: Spaced practice\n- Comparison: not applicable\n- Outcomes: Retention\n- Study designs: rct/);
  assert.match(md, /- Adult learners \(strict\)\n- Recent \(preferred\)/);
  assert.match(md, /10 papers were found\. 2 were screened out, 8 were included, and 8 had data extracted\./);
  assert.match(md, /Excluded by criterion: Adult learners \(2\)\./);
  assert.match(md, /The researcher restored 1 and removed 1 paper after the AI's screening\./);
});

test('unclearList names only strict criteria the paper was unclear on', () => {
  const candidates = { rows: [{ id: 'a', title: 'A', year: 2020 }, { id: 'b', title: 'B', year: null }, { id: 'c', title: 'C', year: 1 }] };
  const f = (value) => ({ state: 'filled', value, quotes: [], citations: [] });
  const screening = {
    criteria: [{ id: 'x', text: 'Adults', strict: true }, { id: 'y', text: 'Recent', strict: false }],
    decisions: { a: { ai: 'unclear', because: [], user: null }, b: { ai: 'unclear', because: [], user: 'include' }, c: { ai: 'include', because: [], user: null } },
    cells: { a: { x: f('unclear'), y: f('unclear') } },
  };
  assert.deepEqual(unclearRows(candidates.rows, screening).map((r) => r.id), ['a'], 'a decided row is no longer unclear');
  assert.deepEqual(unclearList(candidates, screening), [{ id: 'a', title: 'A', year: 2020, because: ['Adults'], include: true }]);
});

test('renderReport without a protocol (a plain report) is unchanged', () => {
  const report = { title: 'T', scope: 's', method: 'M', themes: [], evidence: [], disagreements: '', gaps: '', references: [] };
  const screening = { decisions: {}, criteria: [], perCriterion: {} };
  const plain = renderReport(report, REQUEST, { model: 'm', date: 'd' }, [], { counts: { candidates: 1, included: 1, excluded: 0, extracted: 1 }, screening, table: { columns: [], rows: [], cells: {} } });
  assert.ok(!plain.markdown.includes('Protocol:'));
});

// ---------- through the runtime ----------

function runtimeProvider(o = {}) {
  const t = turns(o);
  return {
    id: 'fake', caps: {}, async status() { return null; }, async models() { return []; }, async dispose() {},
    async *turn(req) {
      const schema = req.outputSchema;
      const pick = /^A researcher wants/.test(req.input) ? CLARIFY_SCHEMA : /^Plan a literature review/.test(req.input) ? PLAN_SCHEMA_SYSTEMATIC : /finding papers/.test(req.input) ? CANDIDATES_SCHEMA : /^Write a literature review/.test(req.input) ? REPORT_SCHEMA_2 : schema;
      const json = await t.structured('x', req.input, pick, { audit: 'review:r:sq1' });
      yield { type: 'final', text: JSON.stringify(json), json, usage: {} };
    },
  };
}

async function runtime(fs, o) {
  const gateway = { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; } }, async dispose() {} };
  const library = { async search() { return []; }, async read() { return null; }, async related() { return []; }, async resolve() { return new Map(); } };
  const published = [];
  const ai = await createLocalRuntime({ platform: { fs }, library, notes: { async publish(n) { published.push(n); return { path: `ai_notes/${n.title}.md` }; } }, dataDir: '/data', providers: new Map([['fake', runtimeProvider(o)]]), gateway, getRoleModel: async () => ({ provider: 'fake', model: 'm' }) });
  return { ai, published };
}

async function until(ai, id, state) {
  for await (const p of ai.reviews.watch(id)) if (p.status.state === state) return p;
  throw new Error(`never reached ${state}`);
}

test('runtime: awaiting_review -> screened(overrides) -> done; the session reads as systematic', async () => {
  const fs = memoryFs();
  const { ai, published } = await runtime(fs, { unclearIds: [3, 4], no: [2] });
  const session = await ai.conversations.create('chat');
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true, session });
  const waiting = await until(ai, id, 'awaiting_review');
  assert.equal(waiting.status.unclear.length, 2);
  assert.match(waiting.lines.map((l) => l.title).join('|'), /Wrote the protocol/);
  assert.match(waiting.lines[0].detail, /2 criteria, 1 columns/);

  await assert.rejects(() => ai.reviews.screened(id, [{ id: 'p:nope', include: true }]), /no such paper/);
  await ai.reviews.screened(id, [{ id: 'p:k3', include: false }]);
  const done = await until(ai, id, 'done');
  assert.deepEqual(done.counts, { candidates: 10, included: 8, excluded: 2, extracted: 8 });
  assert.equal(published.length, 1);
  assert.match(published[0].markdown, /removed 1 paper/);
  await new Promise((r) => setTimeout(r, 20));
  const list = await ai.conversations.list();
  assert.equal(list.find((c) => c.id === session).kind, 'systematic');

  await ai.reviews.screened(id, [{ id: 'p:k1', include: false }]); // a second call changes nothing
  assert.equal(JSON.parse(await fs.read(`/data/reviews/${id}/screening.json`)).decisions['p:k1'].user, null);
});

test('runtime: "Include them all" (no overrides) keeps every unclear paper; a plain report refuses screened()', async () => {
  const fs = memoryFs();
  const { ai } = await runtime(fs, { unclearIds: [3, 4] });
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true });
  await until(ai, id, 'awaiting_review');
  await ai.reviews.screened(id, []);
  const done = await until(ai, id, 'done');
  assert.equal(done.counts.included, 9);
  const plain = await ai.reviews.start({ ...REQUEST, systematic: false, autoApprove: true });
  await until(ai, plain, 'done');
  await assert.rejects(() => ai.reviews.screened(plain, []), /not waiting for a screening decision/);
});

test('runtime: the screened papers open as a virtual result while the review waits, gate only until the answer', async () => {
  const fs = memoryFs();
  const { ai } = await runtime(fs, { unclearIds: [3, 4], no: [2] });
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true });
  await until(ai, id, 'awaiting_review');
  const waiting = await ai.sessions.read(`review:${id}`, { id: 'screening' });
  assert.equal(waiting.kind, 'papers');
  assert.equal(waiting.rows.length, 10);
  assert.deepEqual(waiting.columns.map((c) => c.kind), ['criterion', 'criterion']);
  assert.deepEqual(waiting.gate.unclear.map((u) => u.id).sort(), ['p:k3', 'p:k4']);
  assert.equal(waiting.gate.review, id);
  assert.match(waiting.gate.unclear[0].because[0], /Adult learners/);
  assert.equal(waiting.screening['p:k2'].ai, 'exclude');
  assert.equal(await ai.sessions.read(`review:${id}`, { id: 'R1' }), null, 'only the screening result exists');
  assert.equal(await ai.sessions.read('review:nosuchreview', { id: 'screening' }), null);
  assert.deepEqual((await fs.list('/data')).filter((n) => n.includes('review:')), [], 'nothing is stored for it');

  await ai.reviews.screened(id, [{ id: 'p:k3', include: false }]);
  const answered = await ai.sessions.read(`review:${id}`, { id: 'screening' });
  assert.equal(answered.gate, undefined, 'no toggles once the researcher has answered');
  assert.equal(answered.screening['p:k3'].user, 'exclude');
  await until(ai, id, 'done');
});

test('runtime: a review that never needed the wait has no gate on its screened papers', async () => {
  const fs = memoryFs();
  const { ai } = await runtime(fs, { unclearIds: [3] }); // 1 of 10 = 10%, not above it
  const id = await ai.reviews.start({ ...REQUEST, autoApprove: true });
  await until(ai, id, 'done');
  const result = await ai.sessions.read(`review:${id}`, { id: 'screening' });
  assert.equal(result.gate, undefined);
  assert.equal(result.screening['p:k3'].ai, 'unclear');
});
