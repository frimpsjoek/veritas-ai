import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODE_GROUPS, isReviewMode, normalizeMode, stepChoices, onLabel, currentResult, ago, sessionMeta, historyEntries, cardSplit,
  paperRowFromContext, paperRowFromLibrary, importDraft, uniqueRows,
} from '../src/chat/steps-data.js';

const summary = (id, title, version, updated, kind = 'papers') => ({ ref: { id, version }, kind, title, versions: version, rows: 3, columns: [], updated });

test('the mode menu groups: Workflows (Chat, Research report, Systematic review) and Tools (Find papers, Chat with papers, Extract data, Quick answer)', () => {
  assert.deepEqual(MODE_GROUPS, [{ label: 'Workflows', ids: ['chat', 'report', 'systematic', 'routines'] }, { label: 'Tools', ids: ['find', 'papers', 'extract', 'ask'] }]);
});

test('an old saved mode maps onto a known one; the picker modes and Routines are never restored', () => {
  const known = ['chat', 'ask', 'find', 'report', 'systematic', 'papers', 'extract', 'routines'];
  for (const id of ['chat', 'ask', 'find', 'report', 'systematic']) assert.equal(normalizeMode(id, known), id);
  for (const bad of ['papers', 'extract', 'routines', 'nonsense', '', null, undefined, 7]) assert.equal(normalizeMode(bad, known), 'chat');
});

test('Add step offers only steps that fit the result kind and exist today', () => {
  assert.deepEqual(stepChoices('papers').map((c) => c.label), ['Add columns', 'Keep filtered rows', 'Chat with these']);
  assert.deepEqual(stepChoices('papers', { columns: false }).map((c) => c.label), ['Keep filtered rows', 'Chat with these']);
  assert.deepEqual(stepChoices('table').map((c) => c.label), ['Chat about this table']);
  assert.deepEqual(stepChoices('report').map((c) => c.label), ['Chat about this report']);
  assert.deepEqual(stepChoices('papers', { report: true }).map((c) => c.label), ['Add columns', 'Keep filtered rows', 'Chat with these', 'Report on these']);
  assert.deepEqual(stepChoices('table', { report: true }).map((c) => c.label), ['Chat about this table', 'Write a report from this']);
  assert.deepEqual(stepChoices('report', { report: true }).map((c) => c.label), ['Chat about this report']);
  assert.deepEqual(stepChoices('answer'), []);
  assert.deepEqual(stepChoices(null), []);
});

test('the current result: the picked one, else the newest; nothing once cleared or with no results', () => {
  const results = [summary('R1', 'Old', 2, '2026-09-01T00:00:00Z'), summary('R2', 'New', 1, '2026-09-02T00:00:00Z', 'table')];
  assert.equal(currentResult(results, null, false).ref.id, 'R2');
  assert.equal(currentResult(results, { id: 'R1' }, false).ref.id, 'R1');
  assert.equal(currentResult(results, { id: 'gone' }, false).ref.id, 'R2');
  assert.equal(currentResult(results, { id: 'R1' }, true), null);
  assert.equal(currentResult([], null, false), null);
  assert.equal(onLabel(results[0]), 'On: Old V2');
});

test('"4 days ago" and "Research report · 4 days ago"', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  assert.equal(ago('2026-09-29T11:59:40Z', now), 'just now');
  assert.equal(ago('2026-09-29T11:55:00Z', now), '5 minutes ago');
  assert.equal(ago('2026-09-29T11:00:00Z', now), '1 hour ago');
  assert.equal(ago('2026-09-25T12:00:00Z', now), '4 days ago');
  assert.equal(sessionMeta({ kind: 'report', updated: '2026-09-25T12:00:00Z' }, now), 'Research report · 4 days ago');
  assert.equal(sessionMeta({ kind: 'find', updated: '2026-09-29T11:00:00Z' }, now), 'Find papers · 1 hour ago');
});

test('history lists a saved search once: as its session when its JSON names one that exists', () => {
  const conversations = [
    { id: 'a', mode: 'chat', title: 'A', updated: '3' }, { id: 'b', mode: 'chat', title: 'B', updated: '2', kind: 'find' }, { id: 'c', mode: 'ask', title: 'C', updated: '1' },
  ];
  const searches = [
    { id: 'find-1', query: 'B', at: '2', count: 4, session: 'b' }, { id: 'find-2', query: 'old', at: '1', count: 2, session: null },
    { id: 'find-3', query: 'lost', at: '0', count: 2, session: 'deleted' },
  ];
  const shown = historyEntries(conversations, searches);
  assert.deepEqual(shown.sessions.map((s) => [s.conversation.id, s.search?.id ?? null]), [['a', null], ['b', 'find-1']]);
  assert.deepEqual(shown.searches.map((s) => s.id), ['find-2', 'find-3']);
});

test('the empty state shows at most three session cards', () => {
  assert.equal(cardSplit([1, 2, 3, 4, 5]).length, 3);
  assert.equal(cardSplit([1]).length, 1);
  assert.equal(cardSplit([]).length, 0);
});

test('paper rows for a picked set: library rows and bare chips get stable ids; duplicates drop', () => {
  const chip = paperRowFromContext({ attachment: { kind: 'zoteroItem', citekey: 'vole2021' }, label: 'Vole paper' });
  assert.equal(chip.id, 'p:vole2021');
  assert.deepEqual(chip.ref, { kind: 'paper', citekey: 'vole2021' });
  assert.equal(chip.inLibrary, true);
  assert.equal(paperRowFromContext({ attachment: { kind: 'note', path: 'x.md' }, label: 'n' }), null);
  const doi = paperRowFromLibrary({ ref: { kind: 'web', url: 'u' }, title: 'T', doi: '10.1/ABC' });
  assert.equal(doi.id, 'doi:10.1/abc');
  assert.equal(uniqueRows([chip, chip, doi]).length, 2);
  const draft = importDraft('2 selected papers', [chip]);
  assert.equal(draft.kind, 'papers');
  assert.equal(draft.rows.length, 1);
  assert.equal(draft.title, '2 selected papers');
});

test('isReviewMode: a report and a systematic review start reviews, nothing else does', () => {
  assert.deepEqual(['report', 'systematic', 'chat', 'find', 'ask', 'papers'].map(isReviewMode), [true, true, false, false, false, false]);
});
