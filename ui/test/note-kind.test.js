// Spec 029 R15: the kind of a note from its path and index source, readable titles, day groups and the "when" line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayGroup, kindCounts, modifiedAt, noteKind, readableTitle, whenLine } from '../src/note-kind.js';

test('noteKind tells the kinds apart from the path (as in the real vault) and the index source', () => {
  assert.equal(noteKind('2026/11-November/2026-11-18.md'), 'daily');
  assert.equal(noteKind('chats/2026-11-18 Reading radar (27JGZMXS).md'), 'chat');
  assert.equal(noteKind('chats/2026/11-November/2026-11-16_batoms_phase-2c_89f01f.md'), 'chat');
  assert.equal(noteKind('Second Brain/Digests/2026-11-18 Reading radar.md'), 'digest');
  assert.equal(noteKind('ai_notes/GW summary.md'), 'ai');
  assert.equal(noteKind('x.md', 'ai_notes'), 'ai');
  assert.equal(noteKind('Clippings/A page.md'), 'clip');
  assert.equal(noteKind('a.md', 'youtube'), 'video');
  assert.equal(noteKind('notion:/Braindump.md', 'Notion'), 'notion');
  assert.equal(noteKind('Projects/Alpha/plan.md'), 'project');
  assert.equal(noteKind('index.md'), 'note');
  assert.equal(noteKind('Voles/Seeds.md', 'personal'), 'note');
  // a chat about a daily date is still a chat; a dated file that is not just the date is a note
  assert.equal(noteKind('chats/2026-11-18.md'), 'chat');
  assert.equal(noteKind('Inbox/2026-11-18 meeting.md'), 'note');
});

test('kindCounts lists the kinds present in the filter order, with counts', () => {
  const rows = [{ kind: 'chat' }, { kind: 'note' }, { kind: 'chat' }, { kind: 'daily' }];
  assert.deepEqual(kindCounts(/** @type {any} */ (rows)), [{ kind: 'note', count: 1 }, { kind: 'daily', count: 1 }, { kind: 'chat', count: 2 }]);
  assert.deepEqual(kindCounts([]), []);
});

test('readableTitle drops a chat\'s date and id and names a daily note\'s day; other titles stay', () => {
  assert.equal(readableTitle('2026-11-18 Reading radar (27JGZMXS)', 'chat'), 'Reading radar');
  assert.equal(readableTitle('2026-11-16_batoms_this-is-the-phase-2c-acceptance-test-of_89f01f', 'chat'), 'batoms this is the phase 2c acceptance test of');
  assert.equal(readableTitle('2026-11-18', 'daily'), 'Wed, Nov 18, 2026');
  assert.equal(readableTitle('2026-11-18', 'note'), '2026-11-18');
  assert.equal(readableTitle('Gauge $U(1)$ idea', 'note'), 'Gauge $U(1)$ idea');
  assert.equal(readableTitle('2026-11-18 (ABCDEFGH)', 'chat'), '2026-11-18 (ABCDEFGH)', 'nothing left: the title as it was');
});

test('modifiedAt reads the index\'s "YYYY-MM-DD HH:MM" local time; dayGroup and whenLine from it', () => {
  const now = new Date(2026, 10, 18, 15, 0).getTime();
  assert.equal(modifiedAt('2026-11-18 11:58'), new Date(2026, 10, 18, 11, 58).getTime());
  assert.ok(Number.isNaN(modifiedAt('')));
  assert.equal(dayGroup(modifiedAt('2026-11-18 00:01'), now), 'Today');
  assert.equal(dayGroup(modifiedAt('2026-11-17 23:59'), now), 'Yesterday');
  assert.equal(dayGroup(modifiedAt('2026-11-12 09:00'), now), 'This week');
  assert.equal(dayGroup(modifiedAt('2026-11-11 23:00'), now), 'Earlier');
  assert.equal(dayGroup(NaN, now), 'Earlier');
  assert.equal(whenLine(modifiedAt('2026-11-18 11:58'), now), '3 hours ago');
  assert.equal(whenLine(modifiedAt('2026-11-17 15:00'), now), '1 day ago');
  assert.equal(whenLine(modifiedAt('2026-10-01 09:00'), now), 'Oct 1');
  assert.equal(whenLine(modifiedAt('2025-10-01 09:00'), now), 'Oct 1, 2025');
  assert.equal(whenLine(NaN, now), '');
});
