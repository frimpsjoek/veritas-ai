// Spec 007 E5 (engine): chat with papers, a `conversations.send` turn scoped by `on`. Invented papers only (public repo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { createToolGateway } from '../src/tools.js';
import { restrictToRows, scopeKey } from '../src/citations.js';
import { chatPapersBlock, subsetRows } from '../src/sessions.js';
import { memoryFs } from './support/memory-fs.mjs';

const fence = (obj) => `\`\`\`sb-table\n${JSON.stringify(obj)}\n\`\`\``;

function libRow(citekey, title, year) {
  return { id: `p:${citekey}`, ref: { kind: 'paper', citekey }, inLibrary: true, title, authors: ['Doe, J.'], year, venue: 'J. Invented', doi: null, url: null, abstract: `Abstract of ${title}.`, citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: ['library'] };
}
function outRow(n, title, year) {
  return { id: `doi:10.9999/inv.${n}`, ref: { kind: 'web', url: `https://doi.org/10.9999/inv.${n}` }, inLibrary: false, title, authors: ['Roe, R.'], year, venue: 'J. Invented', doi: `10.9999/inv.${n}`, url: null, abstract: `Abstract of ${title}.`, citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: ['fixture'] };
}
const ROWS = [
  libRow('alpha2020', 'Alpha widgets and spindle density', 2020),
  libRow('beta2021', 'Beta widgets in older adults', 2021),
  outRow(3, 'Gamma widgets outside the library', 2019),
  outRow(4, 'Delta widgets and naps', 2022),
];
const draft = (rows = ROWS) => ({ kind: 'papers', ref: { id: '', version: 0 }, title: 'Widget papers', created: '', madeBy: '', from: [], change: 'Found', query: 'widgets', rows, columns: [], cells: {}, screening: null, summary: null });

/** Provider whose `script(req, n)` returns the final text (and may call tools first). */
async function setup(script) {
  const fs = memoryFs();
  const titles = { alpha2020: 'Alpha widgets and spindle density', beta2021: 'Beta widgets in older adults', other2018: 'Other widgets not in the set' };
  const library = {
    async search() { return []; },
    async read(ref) { return titles[ref.citekey] ? { title: titles[ref.citekey], text: `Full text of ${titles[ref.citekey]}.` } : null; },
    async related() { return []; },
    async resolve(refs) { return new Map(refs.filter((r) => r.kind === 'paper' && titles[r.citekey]).map((r) => [`paper:${r.citekey}`, { title: titles[r.citekey] }])); },
  };
  const gateway = await createToolGateway(fetch, library, {});
  const turns = [];
  const provider = {
    id: 'fake', caps: {}, async status() { return null; }, async models() { return []; },
    async *turn(req) {
      const rec = { instructions: req.instructions, specs: req.tools.specs.map((s) => s.name), web: req.web };
      turns.push(rec);
      const text = await script({ req, rec, call: (name, args) => req.tools.call(name, args) }, turns.length);
      if (text instanceof Error) { yield { type: 'failed', error: { kind: 'provider_crashed', message: 'boom' } }; return; }
      yield { type: 'final', text, json: null, usage: {} };
    },
    async dispose() {},
  };
  const ai = await createLocalRuntime({
    platform: { fs }, library, notes: null, dataDir: '/data', providers: new Map([['fake', provider]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
  const id = await ai.conversations.create('chat');
  const put = await ai.sessions.put(id, { kind: 'find', query: 'widgets', sources: {}, scope: { kind: 'library' } }, draft());
  return { ai, id, ref: put.ref, turns };
}

async function send(ai, id, input) {
  const events = [];
  for await (const ev of ai.conversations.send(id, input)) events.push(ev);
  return events;
}

test('tools: an `on` turn offers read_result and read_source only; a plain turn still offers search', async () => {
  const { ai, id, ref, turns } = await setup(() => 'ok');
  await send(ai, id, { text: 'about these', on: { result: ref, rows: 'all' }, web: 'on' });
  await send(ai, id, { text: 'plain question' });
  assert.deepEqual([...turns[0].specs].sort(), ['read_result', 'read_source']);
  assert.equal(turns[0].web, 'off');
  assert.ok(turns[1].specs.includes('search_library') && turns[1].specs.includes('search_scholarly'), turns[1].specs.join());
});

test('rows subset: read_result shows only those rows, others are unreadable; read_source only for subset library papers', async () => {
  const seen = {};
  const { ai, id, ref } = await setup(async ({ call }) => {
    seen.all = (await call('read_result', { result: 'R1' })).text;
    seen.other = (await call('read_result', { result: 'R9' })).text;
    seen.asked = (await call('read_result', { result: 'R1', rows: ['p:beta2021', 'doi:10.9999/inv.3'] })).text;
    seen.onlyOutside = await call('read_result', { result: 'R1', rows: ['doi:10.9999/inv.3'] });
    seen.readIn = await call('read_source', { citekey: 'alpha2020' });
    seen.readOutOfSubset = await call('read_source', { citekey: 'beta2021' });
    seen.readNotInSet = await call('read_source', { citekey: 'other2018' });
    seen.note = await call('read_source', { note: 'Some note' });
    return 'ok';
  });
  await send(ai, id, { text: 'q', on: { result: ref, rows: ['p:alpha2020', 'doi:10.9999/inv.4'] } });
  assert.match(seen.all, /Alpha widgets/);
  assert.match(seen.all, /Delta widgets/);
  assert.doesNotMatch(seen.all, /Beta widgets|Gamma widgets/);
  assert.match(seen.other, /only reads R1/);
  // The model's own `rows` can only narrow: both requested rows are outside the subset.
  assert.match(seen.asked, /None of those rows/);
  assert.match(seen.onlyOutside.text, /None of those rows/);
  assert.equal(seen.readIn.ok, true);
  assert.match(seen.readIn.text, /Full text of Alpha/);
  assert.match(seen.readOutOfSubset.text, /not one of the papers/);
  assert.match(seen.readNotInSet.text, /not one of the papers/);
  assert.match(seen.note.text, /not one of the papers/);
});

test('first chat_papers turn lists titles and years inline; the second does not; both name the scope', async () => {
  const { ai, id, ref, turns } = await setup(() => 'ok');
  const on = { result: ref, rows: ['p:alpha2020', 'doi:10.9999/inv.3'] };
  await send(ai, id, { text: 'one', on });
  await send(ai, id, { text: 'two', on });
  assert.match(turns[0].instructions, /Alpha widgets and spindle density \(2020\)/);
  assert.match(turns[0].instructions, /Gamma widgets outside the library \(2019\) \[outside your library\]/);
  assert.doesNotMatch(turns[0].instructions, /Beta widgets/);
  assert.match(turns[0].instructions, /2 of 4 papers of R1/);
  assert.doesNotMatch(turns[1].instructions, /Alpha widgets and spindle density/);
  assert.match(turns[1].instructions, /2 of 4 papers of R1/);
  assert.match(turns[0].instructions, /Answer only from these papers/);
  assert.match(turns[0].instructions, /do not address the question/);
});

test('inline titles are capped near 6000 characters', () => {
  const rows = Array.from({ length: 300 }, (_, i) => outRow(i, `Invented widget study number ${i} with a fairly long descriptive title`, 2000 + (i % 20)));
  const block = chatPapersBlock({ ref: { id: 'R1', version: 1 }, title: 'Big' }, rows, 300, { result: { id: 'R1', version: 1 } }, true);
  assert.ok(block.length <= 6000, String(block.length));
  assert.match(block, /\.\.\. and \d+ more/);
  assert.equal(chatPapersBlock(null, rows, 300, { result: { id: 'R1', version: 1 } }, false).includes('The papers:'), false);
});

test('citations: inside the subset resolve (library and DOI link); outside it, even a real library paper, is unresolved', async () => {
  const text = 'A [@alpha2020]; B https://doi.org/10.9999/INV.3 ; C [@beta2021]; D https://doi.org/10.9999/inv.4 ; E [@other2018].';
  const { ai, id, ref } = await setup(() => text);
  const events = await send(ai, id, { text: 'q', on: { result: ref, rows: ['p:alpha2020', 'doi:10.9999/inv.3'] } });
  const done = events.find((e) => e.type === 'done');
  const by = Object.fromEntries(done.answer.citations.map((c) => [c.ref.kind === 'paper' ? c.ref.citekey : c.ref.url, c]));
  assert.equal(by.alpha2020.status, 'resolved');
  assert.equal(by['https://doi.org/10.9999/INV.3'].status, 'resolved');
  assert.equal(by['https://doi.org/10.9999/INV.3'].title, 'Gamma widgets outside the library');
  assert.equal(by.beta2021.status, 'unknown');
  assert.equal(by['https://doi.org/10.9999/inv.4'].status, 'unknown');
  assert.equal(by.other2018.status, 'unknown');
  // Stored on the assistant record too, so a reopened answer shows the same red chips.
  const rec = (await ai.conversations.load(id)).find((r) => r.type === 'assistant');
  assert.deepEqual(rec.answer.citations, done.answer.citations);
});

test('restrictToRows / scopeKey: pure', () => {
  assert.equal(scopeKey({ kind: 'web', url: 'http://dx.doi.org/10.1/AbC' }), scopeKey({ kind: 'web', url: 'https://doi.org/10.1/abc' }));
  const out = restrictToRows([
    { ref: { kind: 'paper', citekey: 'a' }, status: 'resolved', title: 'A', retrievedThisTurn: false },
    { ref: { kind: 'paper', citekey: 'z' }, status: 'resolved', title: 'Z', retrievedThisTurn: false },
    { ref: { kind: 'web', url: 'https://doi.org/10.1/x' }, status: 'unknown' },
  ], [{ ref: { kind: 'paper', citekey: 'a' }, title: 'A' }, { ref: { kind: 'web', url: 'https://doi.org/10.1/x' }, title: 'X' }]);
  assert.deepEqual(out.map((c) => c.status), ['resolved', 'unknown', 'resolved']);
  assert.deepEqual(subsetRows({ kind: 'papers', rows: ROWS }, ['p:beta2021']).map((r) => r.id), ['p:beta2021']);
});

test('persisted: user and assistant records carry `on` and the step; step and step_end are written', async () => {
  const { ai, id, ref } = await setup(() => 'Answer [@alpha2020].');
  const on = { result: ref, rows: ['p:alpha2020'] };
  await send(ai, id, { text: 'What is alpha?', on });
  const records = await ai.conversations.load(id);
  const user = records.find((r) => r.type === 'user');
  assert.deepEqual(user.on, { result: ref, rows: ['p:alpha2020'] });
  assert.equal(user.step, 'S2'); // S1 is the find step
  assert.deepEqual(user.sources, { papers: true, notes: false, scholarly: false, web: false });
  assert.deepEqual(records.find((r) => r.type === 'assistant').on, user.on);
  assert.equal(records.find((r) => r.type === 'assistant').step, 'S2');
  const step = records.find((r) => r.type === 'step' && r.id === 'S2');
  assert.deepEqual(step.input, { kind: 'chat_papers', text: 'What is alpha?', on: ref, rows: ['p:alpha2020'] });
  assert.deepEqual(step.reads, [ref]);
  const end = records.find((r) => r.type === 'step_end' && r.id === 'S2');
  assert.equal(end.status, 'done');
  assert.deepEqual(end.writes, []);
  assert.equal(records.filter((r) => r.type === 'step_end' && r.id === 'S2').length, 1);
  const view = await ai.sessions.view(id);
  assert.equal(view.steps.find((s) => s.id === 'S2').input.kind, 'chat_papers');
  // A version pinned: `on.result` names the version even when the caller sent it without one.
  await send(ai, id, { text: 'again', on: { result: { id: 'R1' }, rows: 'all' } });
  assert.deepEqual((await ai.conversations.load(id)).filter((r) => r.type === 'user').at(-1).on.result, ref);
});

test('a failed chat_papers turn closes its step as failed; a missing set fails cleanly with no step', async () => {
  const { ai, id, ref } = await setup(() => new Error('x'));
  const events = await send(ai, id, { text: 'q', on: { result: ref, rows: 'all' } });
  assert.ok(events.some((e) => e.type === 'failed'));
  const records = await ai.conversations.load(id);
  assert.equal(records.find((r) => r.type === 'step_end' && r.id === 'S2').status, 'failed');
  const bad = await send(ai, id, { text: 'q', on: { result: { id: 'R7', version: 1 }, rows: 'all' } });
  assert.equal(bad.find((e) => e.type === 'failed').error.kind, 'bad_output');
  assert.equal((await ai.conversations.load(id)).filter((r) => r.type === 'step').length, 2); // find + the first turn only
});

test('a table made in a chat_papers turn joins that step and lists the paper set in `from`; outside cites are dropped', async () => {
  const table = { title: 'Widgets compared', columns: ['Finding'], rows: [
    { label: 'Alpha', cells: { Finding: { value: 'Spindles rose', cite: ['[@alpha2020]'] } } },
    { label: 'Beta', cells: { Finding: { value: 'Older adults', cite: ['[@beta2021]'] } } },
  ] };
  const { ai, id, ref } = await setup(() => `Here.\n\n${fence(table)}\n\nDone [@alpha2020].`);
  const events = await send(ai, id, { text: 'Make a table', on: { result: ref, rows: ['p:alpha2020', 'doi:10.9999/inv.3'] } });
  const res = events.find((e) => e.type === 'result');
  assert.equal(res.summary.kind, 'table');
  assert.equal(res.step, 'S2');
  const body = await ai.sessions.read(id, res.summary.ref);
  assert.deepEqual(body.from, [ref]);
  assert.equal(body.madeBy, 'S2');
  assert.deepEqual(body.cells['x:2'] ?? body.cells[body.rows[1].id], { finding: { state: 'filled', value: 'Older adults', quotes: [], citations: [] } });
  assert.match(body.change, /dropped 1 unverified/);
  const records = await ai.conversations.load(id);
  assert.equal(records.filter((r) => r.type === 'step').length, 2, 'one step for the turn, not two');
  const ends = records.filter((r) => r.type === 'step_end' && r.id === 'S2');
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].writes, [res.summary.ref]);
  assert.equal(records.find((r) => r.type === 'assistant').step, 'S2');
  assert.deepEqual(records.find((r) => r.type === 'assistant').on.result, ref);
});

test('regression: a plain chat turn has no `on`, no step, and sees its manifest', async () => {
  const { ai, id, turns } = await setup(() => 'plain');
  await send(ai, id, { text: 'hello' });
  const records = await ai.conversations.load(id);
  const user = records.find((r) => r.type === 'user');
  assert.equal(user.on, undefined);
  assert.equal(user.step, undefined);
  assert.equal(records.filter((r) => r.type === 'step').length, 1); // the find step only
  assert.match(turns[0].instructions, /This session already holds these results/);
  assert.doesNotMatch(turns[0].instructions, /chatting with/);
});

test('read_result: an `on` turn gets abstracts with the rows; a plain turn only when asked; a long set says there is more', async () => {
  const got = {};
  const { ai, id, ref } = await setup(async ({ call, rec }, n) => {
    if (n === 1) got.on = (await call('read_result', { result: 'R1' })).text;
    else {
      got.plain = (await call('read_result', { result: 'R1' })).text;
      got.asked = (await call('read_result', { result: 'R1', abstracts: true })).text;
      got.paged = (await call('read_result', { result: 'R1', abstracts: true, maxChars: 500 })).text;
    }
    return 'ok';
  });
  await send(ai, id, { text: 'q', on: { result: ref, rows: 'all' } });
  await send(ai, id, { text: 'plain' });
  assert.match(got.on, /Abstract: Abstract of Alpha widgets/);
  assert.doesNotMatch(got.plain, /Abstract:/);
  assert.match(got.asked, /Abstract: Abstract of Delta/);
  assert.match(got.paged, /\[more rows: call read_result again with offset 500\]/);
});
