// @ts-check
// The index build's progress line (server spec 019 G2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etaText, progressLine, stageFraction } from '../src/progress-view.js';

test('time left reads like a person would say it', () => {
  assert.equal(etaText(null), '');
  assert.equal(etaText(42), 'less than a minute left');
  assert.equal(etaText(3013), 'about 50 min left');
  assert.equal(etaText(3600), 'about 1 h left');
  assert.equal(etaText(5400), 'about 1 h 30 min left');
});

test('the line for a running, a finished, a stopped and a failed build', () => {
  const running = { running: true, label: 'Reading Zotero', done: 1200, total: 3534, eta_seconds: 90 };
  assert.equal(progressLine(running), 'Reading Zotero · 1,200 of 3,534 · about 2 min left');
  assert.equal(progressLine({ running: true, label: 'Checking notes', done: 0, total: 0 }), 'Checking notes');
  assert.equal(progressLine({ running: false, label: 'Up to date' }), 'Up to date');
  assert.equal(progressLine({ running: false, label: 'Stopped' }), 'Stopped. What was done so far is kept.');
  assert.equal(progressLine({ running: false, label: 'Failed', error: 'OSError: disk full' }), 'Last build failed: OSError: disk full');
  assert.equal(stageFraction(running), 1200 / 3534);
  assert.equal(stageFraction({ running: false }), 0);
});
