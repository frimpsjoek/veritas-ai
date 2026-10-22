import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnChangeUserText, columnChangeReply } from '../src/column-change.js';

const col = (id, name, instruction = '') => ({ id, name, instruction });
const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((t) => ({ id: t.toLowerCase(), title: `Paper ${t}` }));

test('the user turn names one column with its instruction, or several without', () => {
  assert.equal(columnChangeUserText([col('geo', 'Binding geometry', 'how the molecule binds')]), 'Add the column “Binding geometry”: how the molecule binds');
  assert.equal(columnChangeUserText([col('geo', 'Binding geometry')]), 'Add the column “Binding geometry”');
  assert.equal(columnChangeUserText([col('a', 'A'), col('b', 'B'), col('c', 'C')]), 'Add 3 columns: “A”, “B” and “C”');
});

test('the reply counts filled cells and names the papers with no data, at most four', () => {
  const cells = { a: 'filled', b: 'filled', c: 'not_found', d: 'not_found', e: 'not_found', f: 'not_found', g: 'not_found' };
  const text = columnChangeReply({ add: [col('geo', 'Binding geometry')], rows, status: 'done', cellOf: (r) => ({ state: cells[r], ...(cells[r] === 'filled' ? { value: 'v', quotes: [], citations: [] } : { note: 'n' }) }) });
  assert.equal(text, 'Done. “Binding geometry”: 2 of 7 filled, 5 not reported (Paper C; Paper D; Paper E; Paper F; and 1 more).');
});

test('a column with no blanks has no "not reported" part; two columns read one after the other', () => {
  const filled = { state: 'filled', value: 'v', quotes: [], citations: [] };
  const text = columnChangeReply({ add: [col('x', 'X'), col('y', 'Y')], rows: rows.slice(0, 2), status: 'done', cellOf: (r, c) => (c === 'x' ? filled : { state: 'not_found', note: '' }) });
  assert.equal(text, 'Done. “X”: 2 of 2 filled. “Y”: 0 of 2 filled, 2 not reported (Paper A; Paper B).');
});

test('a stopped step says so, and a failed one says the table is as it was', () => {
  assert.match(columnChangeReply({ add: [col('x', 'X')], rows: rows.slice(0, 1), status: 'stopped', cellOf: () => undefined }), /^Stopped before every paper was read\./);
  assert.equal(columnChangeReply({ add: [col('x', 'X')], rows, status: 'failed', cellOf: () => undefined }), 'I couldn\'t fill “X”. The table is as it was.');
});
