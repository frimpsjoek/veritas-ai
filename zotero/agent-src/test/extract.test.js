// Spec 007 E4: columns on paper sets. Invented papers only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createRemoteRuntime } from '../src/remote.js';
import { createAgentd } from '../src/node/agentd.mjs';
import { createSettingsStore, DEFAULT_TURN_WALL_CLOCK_MS } from '../src/settings.js';
import { foldText, checkQuote, planBatches, selectTargets, estimateStep, mergeColumns, textFor, FULL_TEXT_CHARS } from '../src/extract.js';
import { memoryFs } from './support/memory-fs.mjs';

const CAPS = { askFirstRows: 50, askFirstCells: 200, maxRows: 400 };

function paper(n, over = {}) {
  return {
    id: `x:${n}`, ref: { kind: 'web', url: `https://doi.org/10.9999/inv.${n}` }, inLibrary: false,
    title: `Invented study ${n} of sleep spindles`, authors: ['Doe, J.'], year: 2020 + (n % 5), venue: 'J. Invented',
    doi: `10.9999/inv.${n}`, url: null,
    abstract: `Sample sizes were ${n * 10} adults. Spindle density rose after training in study ${n}. A limitation is the short follow-up.`,
    citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: ['fixture'], ...over,
  };
}
const papers = (count, over) => Array.from({ length: count }, (_, i) => paper(i + 1, over));

const COLS = [
  { id: 'limitations', name: 'Limitations', instruction: 'the limitations the authors state', kind: 'text' },
  { id: 'sample', name: 'Sample size', instruction: 'how many participants', kind: 'text' },
];

/** Reads the batch prompt back into [{ id, cols, text }] so a scripted provider can answer what it was asked. */
function parsePrompt(input) {
  const out = [];
  const re = /### Paper (\S+)\nTitle: .*\nColumns to fill: (.*)\nText \((.*?)\):\n"""\n([\s\S]*?)\n"""/g;
  let m;
  while ((m = re.exec(input))) out.push({ id: m[1], cols: m[2].split(', '), from: m[3], text: m[4] });
  return out;
}

function scripted({ answer, gate, onTurn } = {}) {
  const turns = [];
  return {
    turns,
    id: 'fake', caps: {},
    async status() { return null; }, async models() { return []; },
    async *turn(req, signal) {
      const batch = parsePrompt(req.input);
      turns.push({ ids: batch.map((b) => b.id), tools: req.tools?.specs?.length ?? 0 });
      onTurn?.(batch);
      if (gate) {
        await new Promise((resolve) => { const t = gate(batch, resolve); signal?.addEventListener('abort', resolve, { once: true }); void t; });
        if (signal?.aborted) { yield { type: 'failed', error: { kind: 'cancelled', message: 'stopped' } }; return; }
      }
      const rows = batch.map((b) => ({
        row: b.id,
        cells: b.cols.map((c) => (answer ? answer(b, c) : {
          column: c, status: 'found', value: `value for ${c}`, quotes: [b.text.split('. ')[c === 'sample' ? 0 : 2].replace(/\.$/, '')],
        })),
      }));
      yield { type: 'final', text: JSON.stringify({ rows }), json: { rows }, usage: {} };
    },
    async dispose() {},
  };
}

const gateway = (seen = []) => ({
  open(ctx) { seen.push(ctx); return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; },
  mcpServers: { async reports() { return []; }, async save() { throw new Error('n/a'); }, async remove() {}, rows: () => [] },
  async dispose() {},
});

const library = (reads = {}) => ({ async search() { return []; }, async read(ref) { return reads[ref.citekey] ?? null; }, async related() { return []; }, async resolve() { return new Map(); } });

async function setup({ provider = scripted(), fs = memoryFs(), lib = library(), n = 10, rowOver, seen } = {}) {
  const ai = await createLocalRuntime({
    platform: { fs }, library: lib, notes: {}, dataDir: '/data',
    providers: new Map([['fake', provider]]), gateway: gateway(seen),
    getRoleModel: async () => ({ provider: 'fake', model: null }), limits: { total: 6 },
  });
  const id = await ai.conversations.create('chat');
  const put = await ai.sessions.put(id, { kind: 'find', query: 'sleep', sources: {}, scope: { kind: 'library' } }, {
    kind: 'papers', ref: { id: '', version: 0 }, title: 'Sleep spindles (fixture)', created: '', madeBy: '', from: [], change: 'Found papers',
    query: 'sleep', rows: papers(n, rowOver), columns: [], cells: {}, screening: null, summary: null,
  });
  return { ai, id, fs, provider, on: put.ref };
}

const columnsInput = (on, over = {}) => ({ kind: 'columns', on, add: COLS, rows: 'all', text: 'abstract', ...over });

async function collect(iter) { const out = []; for await (const e of iter) out.push(e); return out; }

// ---------- planner, targets, estimate ----------

test('planner: abstracts go 8 to a turn, best goes 1 to a turn, papers with nothing to read cost no turn', () => {
  const rows = papers(20);
  assert.equal(planBatches(rows, 'abstract').batches.length, 3);
  assert.deepEqual(planBatches(rows, 'abstract').batches.map((b) => b.length), [8, 8, 4]);
  assert.equal(planBatches(rows, 'best').batches.length, 20);
  const mixed = [paper(1, { abstract: '' }), paper(2, { abstract: '', inLibrary: true, fullText: true }), paper(3)];
  const abs = planBatches(mixed, 'abstract');
  assert.deepEqual(abs.skipped.map((r) => r.id), ['x:1', 'x:2']);
  assert.equal(abs.batches.length, 1);
  const best = planBatches(mixed, 'best');
  assert.deepEqual(best.skipped.map((r) => r.id), ['x:1'], 'a library paper with full text is readable even without an abstract');
  assert.equal(best.batches.length, 2);
});

test('estimate table: rows, cells and turns for abstract vs best, ask-first thresholds and the row cap', () => {
  const base = (n) => ({ rows: papers(n), columns: [], cells: {} });
  const est = (n, cols, text) => estimateStep(selectTargets(base(n), { add: cols, rows: 'all' }, CAPS), text, CAPS);
  const two = COLS; const three = [...COLS, { id: 'pop', name: 'Population', instruction: 'who', kind: 'text' }];
  assert.deepEqual(est(8, two, 'abstract'), { rows: 8, cells: 16, turns: 1, askFirst: false, maxRows: 400, capped: false });
  assert.deepEqual(est(9, two, 'abstract'), { rows: 9, cells: 18, turns: 2, askFirst: false, maxRows: 400, capped: false });
  assert.deepEqual(est(50, two, 'best'), { rows: 50, cells: 100, turns: 50, askFirst: false, maxRows: 400, capped: false });
  assert.equal(est(51, [COLS[0]], 'abstract').askFirst, true, 'more than 50 rows asks first');
  assert.equal(est(50, three, 'abstract').askFirst, false, '150 cells is under 200');
  assert.equal(est(67, three, 'abstract').askFirst, true, '201 cells asks first');
  assert.deepEqual(est(401, [COLS[0]], 'abstract'), { rows: 401, cells: 400, turns: 50, askFirst: true, maxRows: 400, capped: true });
  assert.deepEqual(est(120, three, 'abstract'), { rows: 120, cells: 360, turns: 15, askFirst: true, maxRows: 400, capped: false }, 'spec example: 3 columns, 120 papers, about 15 turns');
});

test('selectTargets: a re-added column replaces its spec, a subset of rows only fills those rows, pending takes only pending and failed cells', () => {
  const rows = papers(4);
  const base = { rows, columns: [COLS[0]], cells: { 'x:1': { limitations: { state: 'pending' } }, 'x:2': { limitations: { state: 'failed', error: 'e' } }, 'x:3': { limitations: { state: 'filled', value: 'v', quotes: [], citations: [] } } } };
  const pend = selectTargets(base, { add: [], rows: 'pending' }, CAPS);
  assert.deepEqual([...pend.need.keys()], ['x:1', 'x:2']);
  const some = selectTargets(base, { add: [COLS[1]], rows: ['x:3', 'x:4'] }, CAPS);
  assert.deepEqual([...some.need.keys()], ['x:3', 'x:4']);
  assert.deepEqual(some.columns.map((c) => c.id), ['limitations', 'sample']);
  assert.equal(mergeColumns([COLS[0]], [{ ...COLS[0], instruction: 'new' }]).length, 1);
});

// ---------- quote check ----------

test('quote check folds whitespace, case and curly quotes; anything else is unverified', () => {
  const text = 'The  authors say\nthe “short follow-up” was a limitation.';
  assert.equal(foldText('A  B\n c'), 'a b c');
  assert.equal(checkQuote('the "short FOLLOW-up" was a limitation', text), true);
  assert.equal(checkQuote('the long follow-up was a limitation', text), false);
  assert.equal(checkQuote('', text), false);
});

test('textFor reads the library full text up to 20,000 characters, else the abstract', async () => {
  const row = paper(1, { inLibrary: true, fullText: true, ref: { kind: 'paper', citekey: 'doe2021' } });
  const long = 'w '.repeat(30_000);
  const got = await textFor(row, 'best', async (_ref, opts) => { assert.equal(opts.maxChars, FULL_TEXT_CHARS); return { title: 't', text: long }; });
  assert.equal(got.from, 'full_text');
  assert.equal(got.text.length <= FULL_TEXT_CHARS, true);
  assert.equal((await textFor(row, 'best', async () => null)).from, 'abstract');
  assert.equal((await textFor(row, 'abstract', async () => { throw new Error('unused'); })).from, 'abstract');
  assert.equal(await textFor(paper(2, { abstract: '' }), 'best', async () => null), null);
});

// ---------- a whole step ----------

test('a run writes V2 from V1 with lineage, leaves V1 intact, streams cell/progress/end, and checks quotes (a planted wrong one is unverified)', async () => {
  const seen = [];
  const provider = scripted({
    answer: (b, c) => ({
      column: c, status: 'found', value: `v-${b.id}-${c}`,
      quotes: b.id === 'x:3' && c === 'limitations' ? ['the participants all quit on day two'] : [b.text.split('. ')[c === 'sample' ? 0 : 2].replace(/\.$/, '')],
    }),
  });
  const { ai, id, on, provider: p } = await setup({ provider, seen });
  const v1Before = JSON.stringify(await ai.sessions.read(id, on));
  const { step } = await ai.sessions.run(id, columnsInput(on));
  const events = await collect(ai.sessions.events(id, step, 0));
  const end = events.at(-1).data;
  assert.equal(end.type, 'end'); assert.equal(end.status, 'done');
  assert.deepEqual(end.writes, [{ id: on.id, version: 2 }]);
  assert.equal(events.filter((e) => e.data.type === 'cell').length, 20);
  const progress = events.filter((e) => e.data.type === 'progress').map((e) => e.data.done);
  assert.equal(progress[0], 0); assert.equal(progress.at(-1), 20);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  assert.equal(p.turns.length, 2, '10 papers = 8 + 2');
  assert.ok(seen.every((ctx) => ctx.none === true), 'extraction turns run with no tools');
  assert.ok(p.turns.every((t) => t.tools === 0));

  assert.equal(JSON.stringify(await ai.sessions.read(id, on)), v1Before, 'V1 is untouched');
  const v2 = await ai.sessions.read(id, { id: on.id, version: 2 });
  assert.deepEqual(v2.from, [on]);
  assert.equal(v2.change, 'Added columns Limitations, Sample size');
  assert.deepEqual(v2.columns.map((c) => c.id), ['limitations', 'sample']);
  assert.deepEqual(v2.rows, (await ai.sessions.read(id, on)).rows, 'rows carry over');
  const planted = v2.cells['x:3'].limitations;
  assert.equal(planted.state, 'filled');
  assert.equal(planted.quotes[0].verified, false);
  assert.equal(v2.cells['x:4'].limitations.quotes[0].verified, true);
  assert.equal(v2.cells['x:4'].limitations.quotes[0].from, 'abstract');
  assert.deepEqual(v2.cells['x:4'].limitations.citations, [v2.rows[3].ref]);
  const view = await ai.sessions.view(id);
  const st = view.steps.find((s) => s.id === step);
  assert.equal(st.status, 'done'); assert.deepEqual(st.writes, [{ id: on.id, version: 2 }]);
  assert.equal(view.results[0].versions, 2);
  assert.equal(await ai.settings.get().then((s) => s.research.maxRows), 400);
  assert.equal(await createSettingsStore(memoryFs(), '/x').research().then((r) => r.askFirstRows), 50);
});

test('adding columns is a turn in the thread: the user line, the step, then a reply that names the papers with no data', async () => {
  const provider = scripted({
    answer: (b, c) => (b.id === 'x:2' && c === 'sample'
      ? { column: c, status: 'not_found', value: null, quotes: [] }
      : { column: c, status: 'found', value: `v-${b.id}-${c}`, quotes: [b.text.split('. ')[c === 'sample' ? 0 : 2].replace(/\.$/, '')] }),
  });
  const { ai, id, on } = await setup({ provider });
  const { step } = await ai.sessions.run(id, columnsInput(on));
  await collect(ai.sessions.events(id, step, 0));
  const records = (await ai.conversations.load(id)).filter((r) => ['user', 'assistant'].includes(r.type));
  assert.deepEqual(records.map((r) => r.type), ['user', 'assistant']);
  assert.equal(records[0].text, 'Add 2 columns: “Limitations” and “Sample size”');
  assert.equal(records[1].step, step);
  assert.equal(records[1].answer.text, 'Done. “Limitations”: 10 of 10 filled. “Sample size”: 9 of 10 filled, 1 not reported (Invented study 2 of sleep spindles).');
  // a Retry (no new columns) is not a new conversation turn
  const retry = await ai.sessions.run(id, { kind: 'columns', on: { id: on.id, version: 2 }, add: [], rows: ['x:2'], text: 'abstract' }).catch(() => null);
  if (retry) await collect(ai.sessions.events(id, retry.step, 0));
  assert.equal((await ai.conversations.load(id)).filter((r) => r.type === 'user').length, 1);
});

test('gap fill: only the "not reported" cells run again, a stronger read can fill them, and the thread says what was found', async () => {
  let second = false;
  const provider = scripted({
    answer: (b, c) => (b.id === 'x:2' && c === 'sample' && !second
      ? { column: c, status: 'not_found', value: null, quotes: [] }
      : { column: c, status: 'found', value: `v-${b.id}-${c}`, quotes: [b.text.split('. ')[c === 'sample' ? 0 : 2].replace(/\.$/, '')] }),
  });
  const { ai, id, on } = await setup({ provider });
  const first = await ai.sessions.run(id, columnsInput(on));
  await collect(ai.sessions.events(id, first.step, 0));
  const v2 = await ai.sessions.read(id, { id: on.id, version: 2 });
  assert.equal(v2.cells['x:2'].sample.state, 'not_found');

  second = true;
  const gaps = { kind: 'columns', on: { id: on.id, version: 2 }, add: [], rows: 'gaps', text: 'best' };
  const estimate = await ai.sessions.estimate(id, gaps);
  assert.equal(estimate.cells, 1, 'only the one blank cell is priced');
  const { step } = await ai.sessions.run(id, gaps);
  await collect(ai.sessions.events(id, step, 0));
  const v3 = await ai.sessions.read(id, { id: on.id, version: 3 });
  assert.equal(v3.cells['x:2'].sample.state, 'filled');
  assert.equal(v3.cells['x:1'].sample.value, v2.cells['x:1'].sample.value, 'other cells carry over untouched');
  assert.equal(v3.change, 'Looked again for 1 cell with no data');

  const turns = (await ai.conversations.load(id)).filter((r) => r.columnChange);
  assert.deepEqual(turns.map((r) => r.type), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(turns[2].text, 'Look again for the cells with no data');
  assert.equal(turns[3].answer.text, 'Done. Found a value for 1 of 1 cell that had none; the rest are still not reported.');
  await assert.rejects(ai.sessions.run(id, { ...gaps, on: { id: on.id, version: 3 } }), /No empty cells to look for/);
});

test('gap fill: the reply counts cells that could not be read, separately from those still not reported', async () => {
  let second = false;
  const provider = scripted({
    answer: (b, c) => ((b.id === 'x:2' || b.id === 'x:3') && c === 'sample' && !second
      ? { column: c, status: 'not_found', value: null, quotes: [] }
      : { column: c, status: 'found', value: `v-${b.id}-${c}`, quotes: [b.text.split('. ')[c === 'sample' ? 0 : 2].replace(/\.$/, '')] }),
  });
  const real = provider.turn.bind(provider);
  provider.turn = async function* (req, signal) {
    if (second && parsePrompt(req.input).some((b) => b.id === 'x:3')) { yield { type: 'failed', error: { kind: 'provider_crashed', message: 'the model fell over' } }; return; }
    yield* real(req, signal);
  };
  const { ai, id, on } = await setup({ provider });
  const first = await ai.sessions.run(id, columnsInput(on));
  await collect(ai.sessions.events(id, first.step, 0));
  second = true;
  const { step } = await ai.sessions.run(id, { kind: 'columns', on: { id: on.id, version: 2 }, add: [], rows: 'gaps', text: 'best' });
  const events = await collect(ai.sessions.events(id, step, 0));
  assert.equal(events.at(-1).data.status, 'done');
  const reply = (await ai.conversations.load(id)).filter((r) => r.columnChange && r.type === 'assistant').at(-1);
  assert.equal(reply.answer.text, 'Done. Found a value for 1 of 2 cells that had none; 1 could not be read this time, the rest are still not reported.');
});

test('a failed batch marks only its own cells failed; other batches stay filled, step still done', async () => {
  const provider = scripted();
  const real = provider.turn.bind(provider);
  provider.turn = async function* (req, signal) {
    if (parsePrompt(req.input).some((b) => b.id === 'x:10')) { yield { type: 'failed', error: { kind: 'provider_crashed', message: 'the model fell over' } }; return; }
    yield* real(req, signal);
  };
  const { ai, id, on } = await setup({ provider });
  const { step } = await ai.sessions.run(id, columnsInput(on));
  const events = await collect(ai.sessions.events(id, step, 0));
  assert.equal(events.at(-1).data.status, 'done');
  const v2 = await ai.sessions.read(id, { id: on.id, version: 2 });
  assert.equal(v2.cells['x:1'].sample.state, 'filled');
  assert.equal(v2.cells['x:9'].sample.state, 'failed');
  assert.match(v2.cells['x:10'].limitations.error, /fell over/);
});

test('every batch failing ends the step failed, with the failed cells kept for a retry', async () => {
  const provider = scripted();
  provider.turn = async function* () { yield { type: 'failed', error: { kind: 'signed_out', message: 'Sign in again.' } }; };
  const { ai, id, on } = await setup({ provider, n: 3 });
  const { step } = await ai.sessions.run(id, columnsInput(on));
  const end = (await collect(ai.sessions.events(id, step, 0))).at(-1).data;
  assert.equal(end.status, 'failed'); assert.equal(end.error.kind, 'signed_out');
  const v2 = await ai.sessions.read(id, { id: on.id, version: 2 });
  assert.equal(v2.cells['x:1'].sample.state, 'failed');
});

test('a tool call during an extraction turn is refused (tool budget 0) and fails just that batch', async () => {
  const provider = scripted();
  provider.turn = async function* () { yield { type: 'activity', id: 'a', phase: 'start', kind: 'library', label: 'Searching' }; yield { type: 'final', text: '{"rows":[]}', json: { rows: [] }, usage: {} }; };
  const { ai, id, on } = await setup({ provider, n: 2 });
  const { step } = await ai.sessions.run(id, columnsInput(on));
  await collect(ai.sessions.events(id, step, 0));
  const v2 = await ai.sessions.read(id, { id: on.id, version: 2 });
  assert.match(v2.cells['x:1'].sample.error, /more than 0 tool calls/);
});

test('stop mid-run keeps what is done (rest pending); "Fill the rest" then runs only the pending cells as a new version', async () => {
  let release; let block = true;
  const provider = scripted({ gate: (batch, resolve) => { if (block && batch.some((b) => b.id === 'x:9')) { release = resolve; return null; } resolve(); return null; } });
  const { ai, id, on, provider: p } = await setup({ provider, n: 20 });
  await ai.settings.update({ research: { concurrency: 1 } });
  const { step } = await ai.sessions.run(id, columnsInput(on));
  const events = [];
  for await (const e of ai.sessions.events(id, step, 0)) {
    events.push(e);
    if (e.data.type === 'progress' && e.data.done === 16) await ai.sessions.cancel(id, step);
  }
  const end = events.at(-1).data;
  assert.equal(end.status, 'cancelled');
  assert.deepEqual(end.writes, [{ id: on.id, version: 2 }]);
  const v2 = await ai.sessions.read(id, { id: on.id, version: 2 });
  assert.equal(v2.cells['x:1'].sample.state, 'filled');
  assert.equal(v2.cells['x:8'].limitations.state, 'filled');
  assert.deepEqual(v2.cells['x:9'].sample, { state: 'pending' });
  assert.deepEqual(v2.cells['x:20'].limitations, { state: 'pending' });
  assert.match(v2.change, /stopped: 16 of 40 cells done/);
  assert.equal((await ai.sessions.view(id)).steps.find((s) => s.id === step).status, 'cancelled');
  void release; block = false;

  const turnsBefore = p.turns.length;
  const est = await ai.sessions.estimate(id, { kind: 'columns', on: { id: on.id, version: 2 }, add: [], rows: 'pending', text: 'abstract' });
  assert.deepEqual([est.rows, est.cells, est.turns], [12, 24, 2]);
  const second = await ai.sessions.run(id, { kind: 'columns', on: { id: on.id, version: 2 }, add: [], rows: 'pending', text: 'abstract' });
  const events2 = await collect(ai.sessions.events(id, second.step, 0));
  assert.equal(events2.at(-1).data.status, 'done');
  assert.equal(events2.filter((e) => e.data.type === 'cell').length, 24, 'only the pending cells');
  assert.equal(p.turns.length - turnsBefore, 2);
  assert.ok(!p.turns.slice(turnsBefore).some((t) => t.ids.includes('x:1')), 'finished rows are not asked again');
  const v3 = await ai.sessions.read(id, { id: on.id, version: 3 });
  assert.deepEqual(v3.from, [{ id: on.id, version: 2 }]);
  assert.equal(v3.change, 'Filled 24 remaining cells');
  assert.deepEqual(v3.cells['x:1'], v2.cells['x:1'], 'earlier cells carry over untouched');
  assert.equal(v3.cells['x:20'].limitations.state, 'filled');
  await assert.rejects(ai.sessions.run(id, { kind: 'columns', on: { id: on.id, version: 3 }, add: [], rows: 'pending', text: 'abstract' }), /Nothing left to fill/);
});

test('a second step in the same session is refused while one is running', async () => {
  let release;
  const provider = scripted({ gate: (_b, resolve) => { release = resolve; return null; } });
  const { ai, id, on } = await setup({ provider, n: 2 });
  const { step } = await ai.sessions.run(id, columnsInput(on));
  await assert.rejects(ai.sessions.run(id, columnsInput(on, { add: [COLS[0]] })), /already running/);
  await new Promise((r) => setTimeout(r, 20));
  release();
  await collect(ai.sessions.events(id, step, 0));
});

test('events replay from `after`, and a fresh runtime answers a finished step with one synthesized end', async () => {
  const fs = memoryFs();
  const { ai, id, on } = await setup({ fs, n: 3 });
  const { step } = await ai.sessions.run(id, columnsInput(on));
  const all = await collect(ai.sessions.events(id, step, 0));
  const tail = await collect(ai.sessions.events(id, step, 4));
  assert.deepEqual(tail.map((e) => e.seq), all.slice(4).map((e) => e.seq));
  assert.equal(tail.at(-1).data.type, 'end');

  const fresh = await createLocalRuntime({ platform: { fs }, library: library(), notes: {}, dataDir: '/data', providers: new Map([['fake', scripted()]]), gateway: gateway(), getRoleModel: async () => ({ provider: 'fake', model: null }) });
  const replay = await collect(fresh.sessions.events(id, step, 0));
  assert.equal(replay.length, 1);
  assert.deepEqual(replay[0].data, { type: 'end', status: 'done', writes: [{ id: on.id, version: 2 }] });
});

test('a step that died (no step_end) is settled from its partial file: version written, cells pending, ended stopped', async () => {
  const fs = memoryFs();
  const { ai, id, on } = await setup({ fs, n: 4 });
  // Simulate the process dying after one batch was saved: step record + partial file, nothing else.
  await fs.append(`/data/chats/${id}.jsonl`, JSON.stringify({ type: 'step', id: 'S2', input: columnsInput(on), reads: [on], at: new Date().toISOString() }));
  const done = { state: 'filled', value: 'kept', quotes: [], citations: [] };
  await fs.append(`/data/chats/${id}.d/steps/S2.partial.jsonl`, JSON.stringify({ cells: [{ row: 'x:1', column: 'limitations', cell: done }, { row: 'x:1', column: 'sample', cell: done }] }));
  const view = await ai.sessions.view(id);
  const st = view.steps.find((s) => s.id === 'S2');
  assert.equal(st.status, 'stopped');
  assert.deepEqual(st.writes, [{ id: on.id, version: 2 }]);
  const v2 = await ai.sessions.read(id, { id: on.id, version: 2 });
  assert.deepEqual(v2.cells['x:1'].limitations, done);
  assert.deepEqual(v2.cells['x:2'].limitations, { state: 'pending' });
  assert.equal(fs.files.has(`/data/chats/${id}.d/steps/S2.partial.jsonl`), false);
});

test('dispose stops a running step and still writes its version', async () => {
  const provider = scripted({ gate: () => null });
  const { ai, id, on } = await setup({ provider, n: 3 });
  const { step } = await ai.sessions.run(id, columnsInput(on));
  await new Promise((r) => setTimeout(r, 20));
  await ai.dispose();
  const st = (await ai.sessions.view(id)).steps.find((s) => s.id === step);
  assert.equal(st.status, 'stopped');
  assert.equal((await ai.sessions.read(id, { id: on.id, version: 2 })).cells['x:1'].sample.state, 'pending');
});

test('a criterion column answers yes / no / unclear', async () => {
  const provider = scripted({ answer: (b, c) => ({ column: c, status: 'found', value: 'Yes, clearly', quotes: [] }) });
  const { ai, id, on } = await setup({ provider, n: 1 });
  const crit = { id: 'adults', name: 'Adults only', instruction: 'are all participants adults', kind: 'criterion' };
  const { step } = await ai.sessions.run(id, columnsInput(on, { add: [crit] }));
  await collect(ai.sessions.events(id, step, 0));
  assert.equal((await ai.sessions.read(id, { id: on.id, version: 2 })).cells['x:1'].adults.value, 'yes');
});

// ---------- settings ----------

test('role extract: unset follows the researcher, setRole(null) clears it, wall clock 3 minutes, tool budget 0, research caps', async () => {
  const store = createSettingsStore(memoryFs(), '/d');
  await store.setRole('researcher', { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(await store.roleModel('extract'), { provider: 'claude', model: 'sonnet' });
  assert.equal((await store.roles()).extract, null);
  await store.setRole('extract', { provider: 'codex', model: 'mini' });
  assert.deepEqual(await store.roleModel('extract'), { provider: 'codex', model: 'mini' });
  assert.deepEqual((await store.roles()).extract, { provider: 'codex', model: 'mini' });
  await store.setRole('extract', null);
  assert.equal((await store.roles()).extract, null);
  assert.deepEqual(await store.roleModel('extract'), { provider: 'claude', model: 'sonnet' });
  await store.setRole('chat', null); // spec 016: any role clears back to "Same as default"
  assert.deepEqual(await store.roleModel('chat'), { provider: 'codex', model: null });
  assert.deepEqual(await store.turnLimits('extract'), { wallClockMs: 3 * 60_000, toolCallBudget: 0 });
  assert.equal(DEFAULT_TURN_WALL_CLOCK_MS.extract, 180_000);
  assert.deepEqual(await store.research(), { askFirstRows: 50, askFirstCells: 200, maxRows: 400, concurrency: 3 });
  await store.update({ research: { maxRows: 100 } });
  assert.deepEqual(await store.research(), { askFirstRows: 50, askFirstCells: 200, maxRows: 100, concurrency: 3 });
});

test('the cap is enforced: more than maxRows rows only runs the first maxRows', async () => {
  const { ai, id, on, provider } = await setup({ n: 12 });
  await ai.settings.update({ research: { maxRows: 5 } });
  const est = await ai.sessions.estimate(id, columnsInput(on));
  assert.deepEqual(est, { rows: 12, cells: 10, turns: 1, askFirst: false, maxRows: 5, capped: true });
  const { step } = await ai.sessions.run(id, columnsInput(on));
  await collect(ai.sessions.events(id, step, 0));
  const v2 = await ai.sessions.read(id, { id: on.id, version: 2 });
  assert.equal(v2.cells['x:5'].sample.state, 'filled');
  assert.equal(v2.cells['x:6'], undefined);
  assert.equal(provider.turns.length, 1);
});

// ---------- agentd + remote client ----------

function httpTransport(base, secret) {
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  const request = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw new Error((await res.json()).error);
    return res.json();
  };
  return {
    request,
    async *stream(path, after, signal) {
      let cursor = after;
      while (!signal?.aborted) {
        const batch = await request('GET', `${path}${path.includes('?') ? '&' : '?'}after=${cursor}`);
        for (const ev of batch) { cursor = ev.seq; yield { seq: ev.seq, data: ev }; }
      }
    },
  };
}

test('remote client round trip against agentd: estimate, run, events (replay from after), cancel, and setRole(null)', async () => {
  let release;
  const provider = scripted({ gate: (batch, resolve) => { if (batch.some((b) => b.id === 'x:9')) { release = resolve; return null; } resolve(); return null; } });
  const { ai, id, on } = await setup({ provider, n: 12 });
  await ai.settings.update({ research: { concurrency: 1 } });
  const agentd = createAgentd(ai, { secret: 's', mcpHandler: async () => ({ status: 200, body: '{}' }) });
  const port = await agentd.listen(0);
  try {
    const remote = createRemoteRuntime(httpTransport(`http://127.0.0.1:${port}`, 's'));
    const input = columnsInput(on);
    assert.deepEqual(await remote.sessions.estimate(id, input), { rows: 12, cells: 24, turns: 2, askFirst: false, maxRows: 400, capped: false });
    const { step } = await remote.sessions.run(id, input);
    assert.equal(step, 'S2');
    const seen = [];
    for await (const ev of remote.sessions.events(id, step, 0)) {
      seen.push(ev);
      assert.equal('seq' in ev.data, false, 'seq lives beside data, not inside it');
      if (ev.data.type === 'progress' && ev.data.done === 16) await remote.sessions.cancel(id, step);
    }
    assert.equal(seen.at(-1).data.type, 'end');
    assert.equal(seen.at(-1).data.status, 'cancelled');
    const replay = [];
    for await (const ev of remote.sessions.events(id, step, 3)) replay.push(ev);
    assert.deepEqual(replay.map((e) => e.seq), seen.filter((e) => e.seq > 3).map((e) => e.seq));
    const v2 = await remote.sessions.read(id, { id: on.id, version: 2 });
    assert.equal(v2.cells['x:1'].sample.state, 'filled');
    assert.deepEqual(v2.cells['x:12'].sample, { state: 'pending' });

    await remote.providers.setRole('extract', { provider: 'fake', model: null });
    assert.deepEqual((await remote.providers.roles()).extract, { provider: 'fake', model: null });
    await remote.providers.setRole('extract', null);
    assert.equal((await remote.providers.roles()).extract, null);
  } finally {
    void release;
    await agentd.close();
  }
});
