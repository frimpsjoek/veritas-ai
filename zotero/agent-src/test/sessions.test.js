// Spec 007 E1: pure session helpers (manifest, legacyView, legacy importers, read_result rendering).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  manifest, legacyView, isLegacy, summaryExtras, nextStepId, nextResultId, rowIdFor,
  papersFromFind, papersFromReview, renderResult, manifestBlock,
} from '../src/sessions.js';

const PAPER = (over = {}) => ({
  id: 'p:doe2021', ref: { kind: 'paper', citekey: 'doe2021' }, inLibrary: true,
  title: 'A study of widgets', authors: ['Doe, J.'], year: 2021, venue: 'J. Widgets',
  doi: '10.1/doe', url: null, abstract: 'Widgets are studied.', citations: 3,
  fullText: true, pdfUrl: null, studyType: null, foundBy: ['Your library'], ...over,
});

function papersResult(over = {}) {
  return {
    ref: { id: 'R1', version: 1 }, title: 'Widgets', created: '2026-01-01T00:00:00Z', madeBy: 'S1', from: [], change: '',
    kind: 'papers', query: 'widgets',
    rows: [PAPER()],
    columns: [{ id: 'summary', name: 'Summary', instruction: 'summarize', kind: 'text' }],
    cells: { 'p:doe2021': { summary: { state: 'filled', value: 'Widgets do things.', quotes: [{ text: 'widgets do things', ref: { kind: 'paper', citekey: 'doe2021' }, from: 'abstract', verified: true }], citations: [] } } },
    screening: null, summary: null,
    ...over,
  };
}

// ---------- manifest: rebuilt purely from JSONL records ----------

test('manifest rebuilds steps, results and current from a hand-written JSONL', () => {
  const records = [
    { type: 'meta', id: 'c1', mode: 'chat', title: 'New chat', created: '2026-01-01T00:00:00Z' },
    { type: 'step', id: 'S1', input: { kind: 'find', query: 'widgets', sources: { papers: true, notes: false, scholarly: true, web: false }, scope: { kind: 'library' } }, reads: [], at: '2026-01-01T00:00:01Z' },
    { type: 'result', summary: { ref: { id: 'R1', version: 1 }, kind: 'papers', title: 'Widgets', versions: 1, rows: 1, columns: [], updated: '2026-01-01T00:00:01Z' }, at: '2026-01-01T00:00:01Z' },
    { type: 'step_end', id: 'S1', status: 'done', writes: [{ id: 'R1', version: 1 }], at: '2026-01-01T00:00:02Z' },
  ];
  const view = manifest(records);
  assert.equal(view.steps.length, 1);
  assert.equal(view.steps[0].status, 'done');
  assert.equal(view.results.length, 1);
  assert.equal(view.results[0].ref.version, 1);
  assert.deepEqual(view.current, { id: 'R1', version: 1 }); // no explicit `current` record: defaults to the newest result
});

test('manifest keeps only the latest ResultSummary per id, with the right version count', () => {
  const records = [
    { type: 'step', id: 'S1', input: { kind: 'find', query: 'x' }, reads: [], at: 't1' },
    { type: 'result', summary: { ref: { id: 'R1', version: 1 }, kind: 'papers', title: 'Widgets', versions: 1, rows: 5, columns: [], updated: 't1' }, at: 't1' },
    { type: 'step_end', id: 'S1', status: 'done', writes: [{ id: 'R1', version: 1 }], at: 't1' },
    { type: 'step', id: 'S2', input: { kind: 'columns', on: { id: 'R1', version: 1 }, add: [], rows: 'all', text: 'abstract' }, reads: [{ id: 'R1', version: 1 }], at: 't2' },
    { type: 'result', summary: { ref: { id: 'R1', version: 2 }, kind: 'papers', title: 'Widgets', versions: 2, rows: 5, columns: ['Summary'], updated: 't2' }, at: 't2' },
    { type: 'step_end', id: 'S2', status: 'done', writes: [{ id: 'R1', version: 2 }], at: 't2' },
  ];
  const view = manifest(records);
  assert.equal(view.results.length, 1);
  assert.equal(view.results[0].ref.version, 2);
  assert.equal(view.results[0].versions, 2);
});

test('manifest honours an explicit `current` record over the newest result', () => {
  const records = [
    { type: 'step', id: 'S1', input: { kind: 'find', query: 'x' }, reads: [], at: 't1' },
    { type: 'result', summary: { ref: { id: 'R1', version: 1 }, kind: 'papers', title: 'A', versions: 1, rows: 1, columns: [], updated: 't1' }, at: 't1' },
    { type: 'step_end', id: 'S1', status: 'done', writes: [{ id: 'R1', version: 1 }], at: 't1' },
    { type: 'step', id: 'S2', input: { kind: 'find', query: 'y' }, reads: [], at: 't2' },
    { type: 'result', summary: { ref: { id: 'R2', version: 1 }, kind: 'papers', title: 'B', versions: 1, rows: 1, columns: [], updated: 't2' }, at: 't2' },
    { type: 'step_end', id: 'S2', status: 'done', writes: [{ id: 'R2', version: 1 }], at: 't2' },
    { type: 'current', ref: { id: 'R1', version: 1 }, at: 't3' },
  ];
  const view = manifest(records);
  assert.deepEqual(view.current, { id: 'R1', version: 1 });
});

test('a step with no matching step_end shows as still running (resumable)', () => {
  const records = [
    { type: 'step', id: 'S1', input: { kind: 'columns', on: { id: 'R1', version: 1 }, add: [], rows: 'all', text: 'abstract' }, reads: [], at: 't1' },
  ];
  const view = manifest(records);
  assert.equal(view.steps[0].status, 'running');
});

// ---------- legacy view: no file written, hash of the underlying fs untouched ----------

test('an old chat JSONL (no step/result/current records) loads as steps with no file written', () => {
  const records = [
    { type: 'meta', id: 'c1', mode: 'chat', title: 'New chat', created: 't0' },
    { type: 'user', text: 'What is this about?', attachments: [], web: 'off', at: 't1' },
    { type: 'assistant', answer: { text: 'It is about widgets.', citations: [], structured: null, usage: {} }, model: { provider: 'fake', model: null }, activities: [], at: 't2' },
  ];
  assert.equal(isLegacy(records), true);
  const view = legacyView(records);
  assert.equal(view.steps.length, 1);
  assert.equal(view.steps[0].status, 'done');
  assert.equal(view.steps[0].virtualAnswer.answer.text, 'It is about widgets.');
  // Answer results are virtual: never listed as artifacts.
  assert.deepEqual(view.results, []);
});

test('isLegacy is false the moment any step/result/current record exists', () => {
  const records = [{ type: 'meta', id: 'c1', mode: 'chat', title: 'x', created: 't0' }, { type: 'current', ref: { id: 'R1', version: 1 }, at: 't1' }];
  assert.equal(isLegacy(records), false);
});

test('summaryExtras: a legacy chat has 0 artifacts and kind "chat"; a find session counts its papers/table/report results', () => {
  const legacy = [{ type: 'meta', id: 'c1', mode: 'chat', title: 'x', created: 't0' }];
  assert.deepEqual(summaryExtras(legacy), { artifacts: 0, kind: 'chat' });

  const findSession = [
    { type: 'step', id: 'S1', input: { kind: 'find', query: 'widgets', sources: {}, scope: { kind: 'library' } }, reads: [], at: 't1' },
    { type: 'result', summary: { ref: { id: 'R1', version: 1 }, kind: 'papers', title: 'Widgets', versions: 1, rows: 5, columns: [], updated: 't1' }, at: 't1' },
    { type: 'step_end', id: 'S1', status: 'done', writes: [{ id: 'R1', version: 1 }], at: 't1' },
  ];
  assert.deepEqual(summaryExtras(findSession), { artifacts: 1, kind: 'find' });
});

// ---------- ids ----------

test('nextStepId / nextResultId count from the records, not from array length', () => {
  const records = [
    { type: 'step', id: 'S1' }, { type: 'step', id: 'S2' },
    { type: 'result', summary: { ref: { id: 'R1' } } }, { type: 'result', summary: { ref: { id: 'R1' } } }, // R1 V1, V2: still one id
  ];
  assert.equal(nextStepId(records), 'S3');
  assert.equal(nextResultId(records), 'R2');
  assert.equal(nextStepId([]), 'S1');
  assert.equal(nextResultId([]), 'R1');
});

test('rowIdFor prefers citekey, then DOI, then a stable title hash, then an index', () => {
  assert.equal(rowIdFor({ citekey: 'doe2021', doi: '10.1/x', title: 'T' }, 0), 'p:doe2021');
  assert.equal(rowIdFor({ doi: '10.1/X', title: 'T' }, 0), 'doi:10.1/x');
  const a = rowIdFor({ title: 'A Study of Widgets' }, 0);
  const b = rowIdFor({ title: 'a study of widgets' }, 5); // same title, different casing/index: same id
  assert.equal(a, b);
  assert.equal(rowIdFor({}, 3), 'x:3');
});

// ---------- legacy importers ----------

test('papersFromFind maps a saved Find papers search into PapersResult rows', () => {
  const saved = { query: 'widgets', papers: [{ citekey: 'doe2021', title: 'A study of widgets', authors: ['Doe'], year: 2021, abstract: 'x' }], summary: { markdown: 'Top sources', citations: [] } };
  const { query, rows, summary } = papersFromFind(saved);
  assert.equal(query, 'widgets');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'p:doe2021');
  assert.equal(rows[0].ref.kind, 'paper');
  assert.equal(summary.markdown, 'Top sources');
});

test('papersFromFind falls back to a DOI web ref for an outside paper with no citekey', () => {
  const { rows } = papersFromFind({ papers: [{ doi: '10.1/x', title: 'Outside paper' }] });
  assert.deepEqual(rows[0].ref, { kind: 'web', url: 'https://doi.org/10.1/x' });
  assert.equal(rows[0].inLibrary, false);
});

test('papersFromReview merges sources and outside into one row list', () => {
  const rows = papersFromReview({ sources: [{ citekey: 'a2021', title: 'In library' }], outside: [{ doi: '10.1/b', title: 'Outside' }] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].inLibrary, true);
  assert.equal(rows[1].inLibrary, false);
});

// ---------- read_result rendering ----------

test('renderResult: header line + one line per row; seen includes every row ref (incl. outside DOI refs)', () => {
  const result = papersResult({ rows: [PAPER(), PAPER({ id: 'x:1', ref: { kind: 'web', url: 'https://doi.org/10.2/out' }, inLibrary: false, title: 'Outside paper', doi: '10.2/out' })] });
  const { text, seen } = renderResult(result, {});
  assert.match(text, /^R1 "Widgets" V1 · papers · 2 rows/);
  assert.match(text, /p:doe2021 \[@doe2021\] — A study of widgets \(2021\)/);
  assert.match(text, /x:1 https:\/\/doi\.org\/10\.2\/out — Outside paper/);
  assert.deepEqual(seen, [{ kind: 'paper', citekey: 'doe2021' }, { kind: 'web', url: 'https://doi.org/10.2/out' }]);
});

test('renderResult: column selection narrows both which columns show and includes quotes only then', () => {
  const result = papersResult();
  const all = renderResult(result, {});
  assert.doesNotMatch(all.text, /widgets do things/); // no columns named: no quotes, to keep it short
  const withColumn = renderResult(result, { columns: ['summary'] });
  assert.match(withColumn.text, /Summary: Widgets do things\./);
  assert.match(withColumn.text, /widgets do things/); // quotes included once a column is named
});

test('renderResult: rows filter narrows to just those rows', () => {
  const result = papersResult({ rows: [PAPER(), PAPER({ id: 'p:other', ref: { kind: 'paper', citekey: 'other' }, title: 'Other paper' })] });
  const { text } = renderResult(result, { rows: ['p:other'] });
  assert.doesNotMatch(text, /A study of widgets/);
  assert.match(text, /Other paper/);
});

test('renderResult: paging by maxChars/offset always lands on a page boundary and nextOffset resumes exactly', () => {
  const rows = Array.from({ length: 20 }, (_, i) => PAPER({ id: `x:${i}`, ref: { kind: 'web', url: `https://doi.org/10.1/${i}` }, title: `Paper number ${i}`, doi: `10.1/${i}` }));
  const result = papersResult({ rows, columns: [] });
  const page1 = renderResult(result, { maxChars: 200 });
  assert.ok(page1.nextOffset != null);
  const page2 = renderResult(result, { maxChars: 200, offset: page1.nextOffset });
  assert.notEqual(page1.text, page2.text);
});

test('renderResult on an answer result pages the answer text; a report result points at its review', () => {
  const answer = { ref: { id: 'R3', version: 1 }, title: 'q', created: 't', madeBy: 'S3', from: [], change: '', kind: 'answer', answer: { text: 'The answer body.', citations: [], structured: null, usage: {} } };
  assert.match(renderResult(answer, {}).text, /The answer body\./);
  const report = { ref: { id: 'R4', version: 1 }, title: 'A report', created: 't', madeBy: 'S4', from: [], change: '', kind: 'report', review: 'rev1' };
  assert.match(renderResult(report, {}).text, /review rev1/);
});

// ---------- manifest block for turn instructions ----------

test('manifestBlock lists every result with the current one marked, and stays under 1200 chars', () => {
  const view = { results: [
    { ref: { id: 'R1', version: 2 }, kind: 'papers', title: 'Widgets', versions: 2, rows: 40, columns: ['Summary', 'Methodology'], updated: 't' },
    { ref: { id: 'R2', version: 1 }, kind: 'table', title: 'DeepH models', versions: 1, rows: 9, columns: [], updated: 't' },
  ], current: { id: 'R2', version: 1 } };
  const block = manifestBlock(view);
  assert.match(block, /R1 "Widgets" V2 · papers, 40 rows, columns: Summary, Methodology/);
  assert.match(block, /R2 "DeepH models" V1 · table, 9 rows \(current\)/);
  assert.match(block, /read them with read_result before searching again/);
  assert.ok(block.length <= 1200);
});

test('manifestBlock is empty with no results (a plain chat)', () => {
  assert.equal(manifestBlock({ results: [], current: null }), '');
});
