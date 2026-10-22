import { test } from 'node:test';
import assert from 'node:assert/strict';
import { versionCells, cellKey } from '../src/extract.js';
import { gapFillReply } from '../src/column-change.js';

const col = { id: 'c', name: 'C', instruction: 'x', kind: 'text' };
const base = { cells: { r1: { c: { state: 'not_found' } }, r2: { c: { state: 'not_found' } } } };
const targets = { columns: [col], need: new Map([['r1', [col]], ['r2', [col]]]) };

test('a failed produced cell does not overwrite a not-reported base cell', () => {
  const produced = new Map([
    [cellKey('r1', 'c'), { state: 'failed', error: 'Claude exited unexpectedly.' }],
    [cellKey('r2', 'c'), { state: 'filled', value: 'n=40' }],
  ]);
  const v = versionCells(/** @type {any} */ (base), /** @type {any} */ (targets), /** @type {any} */ (produced));
  assert.equal(v.cells.r1.c.state, 'not_found');
  assert.equal(v.cells.r2.c.state, 'filled');
});

test('a failed cell with no base cell is still recorded as failed', () => {
  const produced = new Map([[cellKey('r1', 'c'), { state: 'failed', error: 'boom' }]]);
  const v = versionCells(/** @type {any} */ ({ cells: {} }), /** @type {any} */ (targets), /** @type {any} */ (produced));
  assert.equal(v.cells.r1.c.state, 'failed');
});

test('gapFillReply says plainly how many could not be read', () => {
  assert.equal(
    gapFillReply({ found: 1, total: 8, failed: 1, status: 'done' }),
    'Done. Found a value for 1 of 8 cells that had none; 1 could not be read this time, the rest are still not reported.',
  );
  assert.match(gapFillReply({ found: 0, total: 8, failed: 3, status: 'done' }), /3 could not be read/);
  assert.equal(
    gapFillReply({ found: 1, total: 8, status: 'done' }),
    'Done. Found a value for 1 of 8 cells that had none; the rest are still not reported.',
  );
});
