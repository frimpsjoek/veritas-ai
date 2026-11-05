import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayGroup, groupEntries, whenLabel, matchesFind, entryTitle } from '../src/chat/history-data.js';

const now = new Date(2026, 9, 29, 15, 0); // a Thursday afternoon, local time
const at = (daysAgo, hour = 10) => new Date(2026, 9, 29 - daysAgo, hour).toISOString();

test('dayGroup: today, yesterday, then everything else', () => {
  assert.equal(dayGroup(at(0, 1), now), 'Today');
  assert.equal(dayGroup(at(0, 14), now), 'Today');
  assert.equal(dayGroup(at(1, 23), now), 'Yesterday');
  assert.equal(dayGroup(at(2), now), 'Earlier');
  assert.equal(dayGroup(at(40), now), 'Earlier');
  assert.equal(dayGroup('not a date', now), 'Earlier');
});

test('groupEntries keeps the order given and drops empty groups', () => {
  const entries = [{ at: at(0) }, { at: at(0, 9) }, { at: at(5) }];
  assert.deepEqual(groupEntries(entries, now).map((g) => [g.label, g.entries.length]), [['Today', 2], ['Earlier', 1]]);
  assert.deepEqual(groupEntries([], now), []);
});

test('whenLabel: a time today, a short date otherwise, the year only when it differs', () => {
  assert.match(whenLabel(at(0, 18), now), /6:00/);
  assert.equal(whenLabel(at(2), now), new Date(at(2)).toLocaleDateString([], { month: 'short', day: 'numeric' }));
  const lastYear = new Date(2025, 2, 3).toISOString();
  assert.equal(whenLabel(lastYear, now), new Date(lastYear).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }));
  assert.equal(whenLabel('', now), '');
});

test('matchesFind: every word of the query, in any order, case-insensitive; an empty query matches all', () => {
  assert.ok(matchesFind('Foraging in voles', ''));
  assert.ok(matchesFind('Foraging in voles', 'VOLES'));
  assert.ok(matchesFind('Foraging in voles', 'voles foraging'));
  assert.ok(!matchesFind('Foraging in voles', 'owls'));
  assert.ok(!matchesFind('', 'voles'));
});

test('entryTitle reads the title of a chat, a report and a saved search', () => {
  assert.equal(entryTitle({ kind: 'chat', conversation: { title: 'A' } }), 'A');
  assert.equal(entryTitle({ kind: 'report', progress: { question: 'Q' } }), 'Q');
  assert.equal(entryTitle({ kind: 'report', progress: {} }), 'Research report');
  assert.equal(entryTitle({ kind: 'find', search: { query: 'S' } }), 'S');
});
