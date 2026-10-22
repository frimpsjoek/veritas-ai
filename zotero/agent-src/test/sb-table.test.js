// Spec 007 E3 (engine): the chat's sb-table block becomes a `table` result (§1.6). Invented papers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalRuntime } from '../src/core.js';
import { extractTableBlock, parseTable, tableJsonToMarkdown } from '../src/table.js';
import { memoryFs } from './support/memory-fs.mjs';

const fence = (obj) => `\`\`\`sb-table\n${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\`\`\``;

const TABLE = {
  title: 'Widget models',
  columns: ['Family / relation', 'Why it matters'],
  rows: [
    { label: 'WidgetNet', cells: { 'Family / relation': { value: 'Graph model', cite: ['[@doe2021]'] }, 'Why it matters': { value: 'Fast', cite: ['[@ghost1999]'] } } },
    { label: 'GadgetNet', cells: { 'Family / relation': 'Kernel model' } },
  ],
};

/** A runtime whose provider replies with the next scripted text on each turn. */
async function runtimeScripted(replies) {
  const fs = memoryFs();
  const library = {
    async search() { return []; }, async read() { return null; }, async related() { return []; },
    async resolve(refs) { return new Map(refs.map((r) => [`paper:${r.citekey}`, r.citekey === 'doe2021' ? { title: 'Widgets, a study' } : null])); },
  };
  const gateway = { open() { return { specs: [], async call() { return { ok: true, text: '' }; }, mcp: { url: '', token: 't' }, seen: () => [], close() {} }; }, mcpServers: { async reports() { return []; } }, async dispose() {} };
  const provider = {
    id: 'fake', caps: {}, async status() { return null; }, async models() { return []; },
    async *turn() { yield { type: 'final', text: replies.shift(), json: null, usage: {} }; },
    async dispose() {},
  };
  const ai = await createLocalRuntime({
    platform: { fs }, library, notes: null, dataDir: '/data', providers: new Map([['fake', provider]]), gateway,
    getRoleModel: async () => ({ provider: 'fake', model: null }),
  });
  return { ai, fs };
}

async function turn(ai, id, text) {
  const events = [];
  for await (const ev of ai.conversations.send(id, { text })) events.push(ev);
  return events;
}

test('block parsing: extract, validate, markdown fallback shape', () => {
  const text = `Here.\n${fence(TABLE)}\nDone.`;
  const block = extractTableBlock(text);
  assert.ok(block);
  assert.equal(parseTable(block.json).ok, true);
  assert.equal(parseTable('{"columns":[],"rows":[]}').ok, false);
  assert.equal(parseTable('{"columns":["A"],"rows":[{"label":"x","cells":{"B":"y"}}]}').ok, false); // unknown column
  assert.match(tableJsonToMarkdown(JSON.stringify(TABLE)), /\| WidgetNet \| Graph model \[@doe2021\] \|/);
});

test('happy path: table result written, block removed, result event before done, step + summary in the view', async () => {
  const { ai, fs } = await runtimeScripted([`Here is the comparison.\n\n${fence(TABLE)}\n\nWidgetNet is from [@doe2021].`]);
  const id = await ai.conversations.create('chat');
  const events = await turn(ai, id, 'Make a table of widget models');
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('result') > -1 && types.indexOf('result') < types.indexOf('done'), types.join());
  const result = events.find((e) => e.type === 'result');
  assert.deepEqual(result.summary.ref, { id: 'R1', version: 1 });
  assert.equal(result.summary.kind, 'table');
  assert.equal(result.summary.title, 'Widget models');
  assert.equal(result.summary.versions, 1);
  assert.equal(result.summary.rows, 2);
  assert.deepEqual(result.summary.columns, ['Family / relation', 'Why it matters']);
  assert.ok(result.summary.updated);

  const done = events.find((e) => e.type === 'done');
  assert.ok(!done.answer.text.includes('sb-table'));
  assert.equal(done.notice, undefined);

  const body = JSON.parse(fs.files.get(`/data/chats/${id}.d/results/R1/v1.json`));
  assert.equal(body.kind, 'table');
  assert.deepEqual(body.columns.map((c) => c.id), ['family_relation', 'why_it_matters']);
  assert.deepEqual(body.rows, [{ id: 'x:1', label: 'WidgetNet', paper: null }, { id: 'x:2', label: 'GadgetNet', paper: null }]);
  const c = body.cells['x:1'];
  assert.deepEqual(c.family_relation, { state: 'filled', value: 'Graph model', quotes: [], citations: [{ kind: 'paper', citekey: 'doe2021' }] });
  // The invented [@ghost1999] cite is dropped from the cell (not fatal), and the cell keeps its value.
  assert.deepEqual(c.why_it_matters, { state: 'filled', value: 'Fast', quotes: [], citations: [] });
  assert.deepEqual(body.cells['x:2'].why_it_matters, { state: 'not_found', note: 'Not stated' });
  assert.match(body.change, /dropped 1 unverified citation/);

  const view = await ai.sessions.view(id);
  assert.equal(view.results.length, 1);
  assert.equal(view.steps.length, 1);
  assert.equal(view.steps[0].input.kind, 'chat');
  assert.deepEqual(view.steps[0].writes, [{ id: 'R1', version: 1 }]);
  assert.equal(view.steps[0].status, 'done');

  const records = await ai.conversations.load(id);
  const assistant = records.find((r) => r.type === 'assistant');
  assert.ok(!assistant.answer.text.includes('sb-table'));
  assert.equal(assistant.notice, undefined);
  assert.equal(assistant.step, 'S1');
  assert.deepEqual((await ai.conversations.list())[0].artifacts, 1);
});

test('a malformed block stays as a Markdown table with a notice; no step or file is written', async () => {
  const bad = { columns: ['A', 'B'], rows: [{ label: 'one', cells: { A: 'x', Nope: 'y' } }] }; // unknown column -> fails validation
  const { ai, fs } = await runtimeScripted([`Sure.\n${fence(bad)}`]);
  const id = await ai.conversations.create('chat');
  const events = await turn(ai, id, 'table please');
  assert.equal(events.some((e) => e.type === 'result'), false);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.notice, "Couldn't turn this into a table");
  assert.match(done.answer.text, /\| one \| x \| {2}\|/);
  assert.ok(!done.answer.text.includes('sb-table'));
  const assistant = (await ai.conversations.load(id)).find((r) => r.type === 'assistant');
  assert.equal(assistant.notice, "Couldn't turn this into a table");
  assert.deepEqual([...fs.files.keys()], [`/data/chats/${id}.jsonl`]);
  assert.equal((await ai.sessions.view(id)).results.length, 0);
});

test('unparseable JSON is kept as a json code block with the notice', async () => {
  const { ai } = await runtimeScripted([`Sure.\n${fence('{ not json')}`]);
  const id = await ai.conversations.create('chat');
  const done = (await turn(ai, id, 'table')).find((e) => e.type === 'done');
  assert.equal(done.notice, "Couldn't turn this into a table");
  assert.match(done.answer.text, /```json\n\{ not json\n```/);
});

test('"revises" writes V2 of the named table, keeping row ids by label; an unknown target makes a new result', async () => {
  const v2 = { ...TABLE, revises: 'R1', rows: [TABLE.rows[1], { label: 'NewNet', cells: { 'Family / relation': 'Fresh' } }] };
  const stray = { ...TABLE, revises: 'R9' };
  const { ai, fs } = await runtimeScripted([`One\n${fence(TABLE)}`, `Two\n${fence(v2)}`, `Three\n${fence(stray)}`]);
  const id = await ai.conversations.create('chat');
  await turn(ai, id, 'make it');
  const second = (await turn(ai, id, 'add NewNet, drop WidgetNet')).find((e) => e.type === 'result');
  assert.deepEqual(second.summary.ref, { id: 'R1', version: 2 });
  assert.equal(second.summary.versions, 2);
  const body2 = JSON.parse(fs.files.get(`/data/chats/${id}.d/results/R1/v2.json`));
  assert.deepEqual(body2.rows.map((r) => [r.id, r.label]), [['x:2', 'GadgetNet'], ['x:3', 'NewNet']]); // GadgetNet keeps x:2
  assert.deepEqual(body2.from, [{ id: 'R1', version: 1 }]);
  assert.ok(fs.files.has(`/data/chats/${id}.d/results/R1/v1.json`)); // V1 untouched
  const third = (await turn(ai, id, 'again')).find((e) => e.type === 'result');
  assert.deepEqual(third.summary.ref, { id: 'R2', version: 1 });
  const view = await ai.sessions.view(id);
  assert.deepEqual(view.results.map((r) => [r.ref.id, r.versions]), [['R1', 2], ['R2', 1]]);
});

test('a table row cites one paper that a papers result holds -> row.paper is that RowId', async () => {
  const { ai, fs } = await runtimeScripted([`Table\n${fence({ columns: ['Note'], rows: [{ label: 'The widget paper', cite: ['[@doe2021]'], cells: { Note: 'ok' } }, { label: 'Elsewhere', cells: { Note: { value: 'n', cite: ['[@doe2021]'] } } }] })}`]);
  const id = await ai.conversations.create('chat');
  await ai.sessions.put(id, { kind: 'find', query: 'w', sources: {}, scope: { kind: 'library' } }, {
    kind: 'papers', ref: { id: '', version: 0 }, title: 'Widgets', created: '', madeBy: '', from: [], change: '', query: 'w',
    rows: [{ id: 'p:doe2021', ref: { kind: 'paper', citekey: 'doe2021' }, inLibrary: true, title: 'Widgets, a study', authors: [], year: 2021, venue: '', doi: null, url: null, abstract: '', citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: [] }],
    columns: [], cells: {}, screening: null, summary: null,
  });
  const result = (await turn(ai, id, 'table')).find((e) => e.type === 'result');
  assert.deepEqual(result.summary.ref, { id: 'R2', version: 1 });
  const body = JSON.parse(fs.files.get(`/data/chats/${id}.d/results/R2/v1.json`));
  assert.deepEqual(body.rows.map((r) => r.paper), ['p:doe2021', 'p:doe2021']);
});

test('an old chat (no block) is unaffected: only the log is written, with the same record shapes as before', async () => {
  const { ai, fs } = await runtimeScripted(['Plain answer with [@doe2021].']);
  const id = await ai.conversations.create('chat');
  await turn(ai, id, 'hi');
  assert.deepEqual([...fs.files.keys()], [`/data/chats/${id}.jsonl`]);
  const records = await ai.conversations.load(id);
  assert.deepEqual(records.map((r) => r.type), ['meta', 'user', 'assistant']);
  assert.deepEqual(Object.keys(records[2]).sort(), ['activities', 'answer', 'at', 'lines', 'model', 'reasoning', 'type']);
  assert.equal(records[2].answer.text, 'Plain answer with [@doe2021].');
  const [summary] = await ai.conversations.list();
  assert.equal(summary.artifacts, 0);
  assert.equal(summary.kind, 'chat');
});

test('list(): a session that started with find reports kind "find" and its artifact count', async () => {
  const { ai } = await runtimeScripted([`T\n${fence(TABLE)}`]);
  const id = await ai.conversations.create('chat');
  await ai.sessions.put(id, { kind: 'find', query: 'w', sources: {}, scope: { kind: 'library' } }, {
    kind: 'papers', ref: { id: '', version: 0 }, title: 'W', created: '', madeBy: '', from: [], change: '', query: 'w', rows: [], columns: [], cells: {}, screening: null, summary: null,
  });
  await turn(ai, id, 'table');
  const [summary] = await ai.conversations.list();
  assert.equal(summary.kind, 'find');
  assert.equal(summary.artifacts, 2);
});
