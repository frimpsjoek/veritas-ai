// ui-src/test/papers-chat-data.test.js. Scope resolution for Chat with papers (spec 007 §6, E5): ticked vs visible vs all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chatScope, describeOn, turnsOn, SUGGESTIONS } from '../src/chat/papers-chat-data.js';

const ids = (n) => Array.from({ length: n }, (_, i) => `r${i + 1}`);

test('nothing narrowed: the whole set, rows "all", no toggle', () => {
  const s = chatScope({ visible: ids(40), ticked: new Set(), total: 40 });
  assert.equal(s.rows, 'all');
  assert.equal(s.label, 'All 40 papers');
  assert.equal(s.toggle, null);
  assert.equal(s.count, 40);
});

test('filtered: the visible rows, "These 18 papers", with an "All 40" toggle', () => {
  const s = chatScope({ visible: ids(18), ticked: new Set(), total: 40 });
  assert.deepEqual(s.rows, ids(18));
  assert.equal(s.label, 'These 18 papers');
  assert.deepEqual(s.toggle, { label: 'All 40', to: 'all' });
  assert.equal(s.ticked, false);
});

test('ticked rows win over the visible ones', () => {
  const s = chatScope({ visible: ids(18), ticked: new Set(['r2', 'r5']), total: 40 });
  assert.deepEqual(s.rows, ['r2', 'r5']);
  assert.equal(s.label, 'These 2 papers');
  assert.equal(s.ticked, true);
  assert.deepEqual(s.toggle, { label: 'All 40', to: 'all' });
});

test('a tick that a filter hides is not asked about', () => {
  const s = chatScope({ visible: ids(3), ticked: new Set(['r9']), total: 40 });
  assert.deepEqual(s.rows, ids(3));
  assert.equal(s.ticked, false);
});

test('the "All N" toggle asks about every row and offers the way back', () => {
  const s = chatScope({ visible: ids(18), ticked: new Set(['r2']), total: 40, all: true });
  assert.equal(s.rows, 'all');
  assert.equal(s.label, 'All 40 papers');
  assert.deepEqual(s.toggle, { label: 'These 1', to: 'these' });
});

test('one paper and no papers read plainly', () => {
  assert.equal(chatScope({ visible: ['r1'], ticked: new Set(), total: 4 }).label, 'This paper');
  const none = chatScope({ visible: [], ticked: new Set(), total: 4 });
  assert.equal(none.empty, true);
  assert.equal(none.label, 'No papers to ask about');
  assert.deepEqual(none.toggle, { label: 'All 4', to: 'all' });
});

test('every visible row ticked while others are hidden is still a subset', () => {
  const s = chatScope({ visible: ids(4), ticked: ids(4), total: 4 });
  assert.equal(s.rows, 'all'); // the whole set, however it was picked
});

test('describeOn: how a recorded scope reads', () => {
  assert.equal(describeOn({ rows: 'all' }, 40), 'All 40 papers');
  assert.equal(describeOn({ rows: ids(18) }, 40), '18 of 40 papers');
  assert.equal(describeOn({ rows: ['r1'] }, 40), '1 paper');
  assert.equal(describeOn({ rows: ids(3) }, null), '3 papers');
  assert.equal(describeOn({ rows: 'all' }, null), 'All papers');
  assert.equal(describeOn(undefined), '');
});

test('turnsOn: user records with on.result = this result, paired with their answers', () => {
  const on = (id, rows = 'all') => ({ result: { id, version: 1 }, rows });
  const records = [
    { type: 'meta' },
    { type: 'user', text: 'plain question' },
    { type: 'assistant', answer: { text: 'a0' } },
    { type: 'user', text: 'about R1', on: on('R1') },
    { type: 'assistant', answer: { text: 'a1' } },
    { type: 'user', text: 'about R2', on: on('R2', ['x']) },
    { type: 'failed', error: {} },
    { type: 'user', text: 'again R1', on: on('R1', ['r1']) },
  ];
  const r1 = turnsOn(records, 'R1');
  assert.deepEqual(r1.map((t) => t.user.text), ['about R1', 'again R1']);
  assert.equal(r1[0].reply.answer.text, 'a1');
  assert.equal(r1[1].reply, null);
  assert.equal(turnsOn(records, 'R2')[0].reply.type, 'failed');
  assert.deepEqual(turnsOn(records, 'R3'), []);
});

test('there are plain, generic suggestions', () => {
  assert.ok(SUGGESTIONS.length >= 2 && SUGGESTIONS.length <= 3);
});
