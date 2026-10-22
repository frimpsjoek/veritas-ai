import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectOf, filterEntries, switcherLabel, emptyLine, deleteLine, projectMenu, rowMenu, ALL_CHATS } from '../src/chat/projects-data.js';

const voles = { id: 'p1', name: 'Voles' };
const owls = { id: 'p2', name: 'Owls' };
const chat = (id, project) => ({ kind: 'chat', conversation: { id, ...(project !== undefined ? { project } : {}) } });
const report = (id, project) => ({ kind: 'report', progress: { id, ...(project ? { project } : {}) } });
const find = { kind: 'find', search: { id: 's' } };

test('projectOf: a known id, none, removed (null) and a deleted project all read correctly', () => {
  assert.equal(projectOf({ project: 'p1' }, ['p1']), 'p1');
  assert.equal(projectOf({}, ['p1']), null);
  assert.equal(projectOf({ project: null }, ['p1']), null);
  assert.equal(projectOf({ project: 'gone' }, ['p1']), null);
  assert.equal(projectOf(undefined, ['p1']), null);
});

test('filterEntries: no project open lists everything; a project lists its chats and reports only', () => {
  const entries = [chat('a', 'p1'), chat('b'), chat('c', null), report('r1', 'p1'), report('r2'), find, chat('d', 'p2')];
  assert.equal(filterEntries(entries, null, ['p1', 'p2']), entries);
  assert.deepEqual(filterEntries(entries, 'p1', ['p1', 'p2']).map((e) => e.conversation?.id ?? e.progress?.id), ['a', 'r1']);
  assert.deepEqual(filterEntries(entries, 'p2', ['p1', 'p2']).map((e) => e.conversation.id), ['d']);
});

test('filterEntries: an open project that no longer exists shows everything; a dangling member is not in any project', () => {
  const entries = [chat('a', 'gone'), chat('b', 'p1')];
  assert.equal(filterEntries(entries, 'gone', ['p1']), entries);
  assert.deepEqual(filterEntries(entries, 'p1', ['p1']).map((e) => e.conversation.id), ['b']);
});

test('switcherLabel and the lines', () => {
  assert.equal(switcherLabel(null), ALL_CHATS);
  assert.equal(switcherLabel(undefined), 'All chats');
  assert.equal(switcherLabel(voles), 'Voles');
  assert.equal(emptyLine(null), 'Your chats and reports appear here.');
  assert.match(emptyLine(voles), /^Nothing in Voles yet\. Start a chat, or move one here from its \.\.\. menu\.$/);
  assert.equal(deleteLine(voles), 'Delete "Voles"? Its chats and reports stay in your history.');
});

test('projectMenu: All chats first, projects, then New project; rename/delete only with one open', () => {
  const none = projectMenu([owls, voles], null);
  assert.deepEqual(none.map((r) => r.label ?? '-'), ['All chats', 'Owls', 'Voles', '-', 'New project...']);
  assert.equal(none[0].selected, true);
  const open = projectMenu([owls, voles], 'p1');
  assert.deepEqual(open.map((r) => r.label ?? '-'), ['All chats', 'Owls', 'Voles', '-', 'New project...', 'Rename project...', 'Delete project...']);
  assert.equal(open[0].selected, false);
  assert.equal(open.find((r) => r.id === 'p1').selected, true);
  assert.equal(projectMenu([voles], 'gone')[0].selected, true); // a missing open project reads as All chats
});

test('rowMenu: a chat in a project can be renamed, moved, removed, deleted', () => {
  const rows = rowMenu(chat('a', 'p1'), [voles, owls]);
  assert.deepEqual(rows.map((r) => r.label ?? '-'), ['Rename', 'Move to project', 'Voles', 'Owls', 'New project...', 'Remove from project', '-', 'Delete']);
  assert.equal(rows.find((r) => r.id === 'p1').selected, true);
});

test('rowMenu: no Remove from project for a chat in none (or a deleted one); a report has no Rename or Delete', () => {
  assert.ok(!rowMenu(chat('a'), [voles]).some((r) => r.action === 'remove-from'));
  assert.ok(!rowMenu(chat('a', 'gone'), [voles]).some((r) => r.action === 'remove-from'));
  const r = rowMenu(report('r', 'p1'), [voles]);
  assert.deepEqual(r.map((x) => x.label ?? '-'), ['Move to project', 'Voles', 'New project...', 'Remove from project']);
});

test('rowMenu: an older server (no projects) keeps Rename and Delete only; a saved search just Delete', () => {
  assert.deepEqual(rowMenu(chat('a'), [], false).map((r) => r.label ?? '-'), ['Rename', '-', 'Delete']);
  assert.deepEqual(rowMenu(find, [voles]).map((r) => r.label ?? '-'), ['Delete']);
});
