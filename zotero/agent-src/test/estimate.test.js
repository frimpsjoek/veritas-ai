import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateReport } from '../src/estimate.js';

test('quick and standard match the live runs of 2026-10-07 (11 and 15 turns)', () => {
  // quick: 3 researchers + clarify + plan + writer + 3 screening turns (23 papers / 8) + 2 extraction turns (13 / 8)
  const q = estimateReport('quick');
  const s = estimateReport('standard');
  assert.ok(Math.abs(q.turns - 11) <= 1, JSON.stringify(q));
  assert.ok(Math.abs(s.turns - 15) <= 2, JSON.stringify(s));
  assert.ok(q.low <= 11 && 11 <= q.high && s.low <= 15 && 15 <= s.high);
});

test('the estimate carries a range label for when it is uncertain', () => {
  const e = estimateReport('quick');
  assert.equal(e.range, `${e.low}-${e.high}`);
});

test('depth is monotonic: fastest < quick < standard < deep, for reports and systematic reviews', () => {
  for (const systematic of [false, true]) {
    const [f, q, s, d] = ['fastest', 'quick', 'standard', 'deep'].map((depth) => estimateReport(depth, { systematic }).turns);
    assert.ok(f <= q && q <= s && s < d, `${systematic}: ${f} ${q} ${s} ${d}`);
  }
  const [f, q] = ['fastest', 'quick'].map((depth) => estimateReport(depth));
  assert.ok(f.turns < q.turns && f.high < q.high, `a report at fastest prices fewer turns than quick: ${JSON.stringify([f, q])}`);
});

test('fastest prices no screening turns and ignores full-text reading', () => {
  const f = estimateReport('fastest');
  assert.equal(f.turns, estimateReport('fastest', { text: 'best' }).turns);
  assert.equal(f.turns, 1 + 1 + 1 + 3 + 2, 'clarify, plan, writer, 3 researchers, 2 extraction batches');
});

test('low <= turns <= high at every depth', () => {
  for (const depth of /** @type {const} */ (['fastest', 'quick', 'standard', 'deep'])) {
    const e = estimateReport(depth);
    assert.ok(e.low <= e.turns && e.turns <= e.high, JSON.stringify(e));
  }
});

test('running automatically skips the clarify turn; reading full text costs a turn per paper', () => {
  assert.equal(estimateReport('standard', { autoApprove: true }).turns, estimateReport('standard').turns - 1);
  assert.ok(estimateReport('standard', { text: 'best' }).turns > estimateReport('standard').turns);
});

test('an unknown depth is priced as standard', () => {
  assert.deepEqual(estimateReport(/** @type {any} */ ('weird')), estimateReport('standard'));
});
