import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayGroup, groupEntries, whenLabel, matchesFind, entryTitle, findEntries, noMatchLine, whereLabel, panelFoldsList, chatTitle, countPill, kindTitle } from '../src/chat/history-data.js';

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

test('findEntries filters every kind by its title and leaves the list alone with nothing typed', () => {
  const entries = [
    { kind: 'chat', conversation: { title: 'Winter foraging' } },
    { kind: 'report', progress: { question: 'What do voles eat in winter?' } },
    { kind: 'find', search: { query: 'doorknob ergonomics' } },
  ];
  assert.equal(findEntries(entries, ''), entries);
  assert.deepEqual(findEntries(entries, 'WINTER').map((e) => e.kind), ['chat', 'report']);
  assert.deepEqual(findEntries(entries, 'ergonomics door').map((e) => e.kind), ['find']);
  assert.deepEqual(findEntries(entries, 'zzz'), []);
});

test('noMatchLine quotes what was typed', () => {
  assert.equal(noMatchLine('voles'), 'No chats match “voles”.');
});

test('whereLabel says where the AI runs in two or three plain words', () => {
  assert.equal(whereLabel('server'), 'On the Veritas server');
  assert.equal(whereLabel('local'), 'On this computer');
});

test('panelFoldsList: only where the panel sits beside the thread and the room is short', () => {
  assert.equal(panelFoldsList(1199), true);
  assert.equal(panelFoldsList(960), true);
  assert.equal(panelFoldsList(1200), false);
  assert.equal(panelFoldsList(959), false); // the panel covers the list anyway
});

// spec 029 R7
test('chatTitle: a named chat keeps its name; one still called "New chat" shows its first question', () => {
  assert.equal(chatTitle({ title: 'Foraging in voles', cover: { kind: 'chat', title: 'What do voles eat?' } }), 'Foraging in voles');
  assert.equal(chatTitle({ title: 'New chat', cover: { kind: 'chat', title: 'What do voles eat?', quote: 'Seeds and roots.' } }), 'What do voles eat?');
  assert.equal(chatTitle({ title: 'Ask', cover: { kind: 'chat', title: 'Which owls hunt voles?' } }), 'Which owls hunt voles?');
  // a report's cover title is the report's name; the question asked is its quote
  assert.equal(chatTitle({ title: 'New chat', cover: { kind: 'report', title: 'What Voles Eat: A Review', quote: 'What do voles eat across seasons?' } }), 'What do voles eat across seasons?');
  assert.equal(chatTitle({ title: 'New chat', cover: { kind: 'find', quote: 'Papers on vole burrows' } }), 'Papers on vole burrows');
});

test('chatTitle: with no question yet, "New chat" stays', () => {
  assert.equal(chatTitle({ title: 'New chat' }), 'New chat');
  assert.equal(chatTitle({ title: 'New chat', cover: { kind: 'chat', quote: 'An answer with no question' } }), 'New chat');
  assert.equal(chatTitle({}), 'New chat');
});

test('entryTitle and "Find a chat" use the shown title, so a chat is found by the question on screen', () => {
  const entries = [{ kind: 'chat', conversation: { title: 'New chat', cover: { kind: 'chat', title: 'What do voles eat?' } } }];
  assert.equal(entryTitle(entries[0]), 'What do voles eat?');
  assert.equal(findEntries(entries, 'voles eat').length, 1);
});

test('countPill says what it counts, in words, with a longer tooltip', () => {
  assert.deepEqual(countPill(1), { text: '1 artifact', title: '1 artifact in this chat: the paper lists, tables and reports it made' });
  assert.equal(countPill(3).text, '3 artifacts');
});

test('kindTitle names each kind of session for its icon', () => {
  assert.deepEqual(['chat', 'find', 'report', 'systematic', undefined, 'other'].map(kindTitle), ['Chat', 'Find papers', 'Research report', 'Systematic review', 'Chat', 'Chat']);
});
