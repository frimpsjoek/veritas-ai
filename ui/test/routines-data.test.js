import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TABS, groupByStatus, scheduleText, nextRunText, lastRunLine, cardActions, TEMPLATES, draftFromTemplate, draftForArtifact, emptyText, LIMIT_LINE, splitBroken, brokenLine, newsLabel, newsTitle, newsSession, projectLine, projectChoices,
} from '../src/chat/routines-data.js';

process.env.TZ = 'America/New_York';
const local = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const r = (id, status, over = {}) => ({ id, name: id, status, lastRun: null, ...over });

test('tabs are Active, Paused, Archived, in that order', () => {
  assert.deepEqual(TABS.map((t) => t.label), ['Active', 'Paused', 'Archived']);
});

test('groupByStatus splits by status, keeps order, floats a running routine up', () => {
  const g = groupByStatus([r('a', 'active'), r('b', 'paused'), r('c', 'active', { running: true }), r('d', 'archived'), r('e', 'active')]);
  assert.deepEqual(g.active.map((x) => x.id), ['c', 'a', 'e']);
  assert.deepEqual(g.paused.map((x) => x.id), ['b']);
  assert.deepEqual(g.archived.map((x) => x.id), ['d']);
  assert.deepEqual(groupByStatus([]), { active: [], paused: [], archived: [] });
});

test('scheduleText words every schedule, old shapes included', () => {
  assert.equal(scheduleText({ kind: 'daily', time: '07:30' }), 'Every day at 07:30');
  assert.equal(scheduleText({ kind: 'weekly', weekday: 1, time: '18:00' }), 'Every Monday at 18:00');
  assert.equal(scheduleText({ kind: 'weekly', weekday: 0, time: '09:00' }), 'Every Sunday at 09:00');
  assert.equal(scheduleText({ days: { kind: 'weekdays' }, times: { kind: 'at', times: ['07:00', '18:30'] } }), 'Weekdays at 07:00 and 18:30');
});

test('nextRunText: today, tomorrow, weekday, date; paused, archived and running win', () => {
  const now = local(2026, 5, 4, 6, 0); // Monday
  const at = (d, h, m) => new Date(local(2026, 5, d, h, m)).toISOString();
  assert.equal(nextRunText({ status: 'active', nextRun: at(4, 7, 30) }, now), 'Next run: today at 07:30');
  assert.equal(nextRunText({ status: 'active', nextRun: at(5, 7, 30) }, now), 'Next run: tomorrow at 07:30');
  assert.equal(nextRunText({ status: 'active', nextRun: at(8, 18, 0) }, now), 'Next run: Friday at 18:00');
  assert.match(nextRunText({ status: 'active', nextRun: at(20, 7, 30) }, now), /^Next run: .+ at 07:30$/);
  assert.equal(nextRunText({ status: 'paused', nextRun: at(5, 7, 30) }, now), 'Paused');
  assert.equal(nextRunText({ status: 'archived', nextRun: null }, now), 'Archived');
  assert.equal(nextRunText({ status: 'active', nextRun: at(5, 7, 30), running: true }, now), 'Running now');
  assert.equal(nextRunText({ status: 'active', nextRun: null }, now), '');
});

test('lastRunLine: not run, done with counts, nothing new, skipped, failed', () => {
  const now = local(2026, 5, 4, 12, 0);
  const at = new Date(local(2026, 5, 4, 10, 0)).toISOString();
  assert.equal(lastRunLine({ lastRun: null }, now), 'Has not run yet');
  assert.equal(lastRunLine({ lastRun: { at, status: 'done', added: 3 } }, now), 'Ran 2 hours ago: 3 new papers');
  assert.equal(lastRunLine({ lastRun: { at, status: 'done', added: 1 } }, now), 'Ran 2 hours ago: 1 new paper');
  assert.equal(lastRunLine({ lastRun: { at, status: 'done', added: 0 } }, now), 'Ran 2 hours ago: nothing new');
  assert.equal(lastRunLine({ lastRun: { at, status: 'done', summary: 'Wrote a review' } }, now), 'Ran 2 hours ago: Wrote a review');
  assert.equal(lastRunLine({ lastRun: { at, status: 'skipped', reason: 'Codex window 63% used at 07:30' } }, now), 'Skipped 2 hours ago: Codex window 63% used at 07:30');
  assert.equal(lastRunLine({ lastRun: { at, status: 'failed', reason: 'stopped' } }, now), 'Failed 2 hours ago: stopped');
  assert.equal(lastRunLine({ lastRun: { at, status: 'failed' } }, now), 'Failed 2 hours ago');
});

test('cardActions: Run now disabled while running or paused; Pause becomes Resume; archived can only be restored', () => {
  assert.deepEqual(cardActions({ status: 'active' }).map((a) => a.id), ['run', 'pause', 'edit', 'archive']);
  assert.equal(cardActions({ status: 'active', running: true })[0].disabled, true);
  assert.equal(cardActions({ status: 'active' })[0].disabled, false);
  assert.deepEqual(cardActions({ status: 'paused' }).map((a) => a.id), ['run', 'resume', 'edit', 'archive']);
  assert.equal(cardActions({ status: 'paused' })[0].disabled, true);
  assert.deepEqual(cardActions({ status: 'archived' }).map((a) => a.id), ['restore']);
});

test('three templates: daily preprint digest, weekly watch, citation watch; drafts are valid-looking and independent copies', () => {
  assert.deepEqual(TEMPLATES.map((t) => t.id), ['preprint-digest', 'weekly-watch', 'citation-watch']);
  for (const t of TEMPLATES) {
    assert.ok(t.title && t.blurb);
    assert.equal(sheetProblem({ name: 'x', prompt: 'x', schedule: t.draft.schedule }), null, 'a template schedule is one the engine accepts');
    assert.ok(t.draft.prompt.length > 20);
    assert.deepEqual(t.draft.target, { kind: 'session' });
  }
  assert.equal(TEMPLATES[0].draft.schedule.days.kind, 'daily');
  assert.deepEqual(TEMPLATES[1].draft.schedule.days, { kind: 'some', weekdays: [1] });
  const copy = draftFromTemplate('weekly-watch');
  copy.name = 'changed';
  assert.equal(draftFromTemplate('weekly-watch').name, 'Weekly new-papers watch');
  assert.equal(draftFromTemplate('nope'), null);
});

test('draftFromTemplate works where the host has no structuredClone (Zotero chrome scope)', () => {
  const saved = globalThis.structuredClone;
  delete globalThis.structuredClone;
  try {
    assert.equal(draftFromTemplate('weekly-watch').name, 'Weekly new-papers watch');
  } finally {
    globalThis.structuredClone = saved;
  }
});

test('draftForArtifact targets that result and defaults a daily schedule', () => {
  const d = draftForArtifact({ session: 'S1', result: 'R2', title: 'Gold-electrode junctions' });
  assert.deepEqual(d.target, { kind: 'artifact', session: 'S1', result: { id: 'R2' } });
  assert.equal(d.name, 'Watch: Gold-electrode junctions');
  assert.deepEqual(d.schedule, { days: { kind: 'daily' }, times: { kind: 'at', times: ['07:30'] } });
  assert.equal(draftForArtifact({ session: 'S1', result: 'R2' }).name, 'Watch for new papers');
});

test('empty text and the honest limit line', () => {
  assert.match(emptyText('active'), /Start from one of these/);
  assert.equal(emptyText('paused'), 'Nothing is paused.');
  assert.match(LIMIT_LINE, /server or Zotero is running/);
});

import { estimateText, sheetProblem, addedRowSet, runNowLine, nextFreeTime, previewText, scheduleFromWhen, whenFromSchedule } from '../src/chat/routines-data.js';
import { nextRun } from '../../agent/src/schedule.js';

test('estimateText prefers the engine range, falls back to turns, and to the bare name', () => {
  assert.equal(estimateText('Balanced', { range: '9-18', turns: 13 }), 'Balanced · about 9-18 turns');
  assert.equal(estimateText('Fast', { turns: 12 }), 'Fast · about 12 turns');
  assert.equal(estimateText('Smart', null), 'Smart');
  assert.equal(estimateText('Smart', {}), 'Smart');
});

test('sheetProblem names what is missing, in order', () => {
  const ok = { name: 'Voles', prompt: 'Find vole papers', schedule: sched({ kind: 'daily' }, at('07:30')) };
  assert.equal(sheetProblem(ok), null);
  assert.match(sheetProblem({ ...ok, name: '  ' }), /name/);
  assert.match(sheetProblem({ ...ok, prompt: '' }), /look for/);
  assert.match(sheetProblem({ ...ok, schedule: sched({ kind: 'daily' }, at('')) }), /not a time/);
  assert.match(sheetProblem({ ...ok, schedule: sched({ kind: 'daily' }, at('24:00')) }), /not a time/);
  assert.match(sheetProblem({ ...ok, schedule: sched({ kind: 'some', weekdays: [] }, at('08:00')) }), /day/);
  assert.match(sheetProblem({ ...ok, schedule: sched({ kind: 'daily' }, at('08:00', '08:30')) }), /once an hour/);
  assert.equal(sheetProblem({ ...ok, schedule: sched({ kind: 'some', weekdays: [0] }, at('08:00')) }), null);
  assert.match(sheetProblem({ ...ok, schedule: undefined }), /when the routine runs/);
});

const sched = (days, times) => ({ days, times });
const at = (...times) => ({ kind: 'at', times });

test('the When row model round-trips every schedule kind', () => {
  const cases = [
    sched({ kind: 'daily' }, at('07:30')),
    sched({ kind: 'weekdays' }, at('07:00', '18:30')),
    sched({ kind: 'some', weekdays: [1, 3, 5] }, at('09:15')),
    sched({ kind: 'every', n: 3, from: '2026-05-04' }, at('06:00')),
    sched({ kind: 'monthly', day: -1 }, at('10:00')),
    sched({ kind: 'monthly', day: 1 }, { kind: 'hourly', every: 4, from: '08:00', to: '20:00' }),
  ];
  for (const c of cases) assert.deepEqual(scheduleFromWhen(whenFromSchedule(c)), c);
  const fresh = whenFromSchedule(null, local(2026, 5, 4));
  assert.deepEqual(scheduleFromWhen(fresh), sched({ kind: 'daily' }, at('07:30')), 'a new routine defaults to daily 07:30');
  assert.equal(fresh.from, '2026-05-04');
  // choosing another days kind keeps what the other controls held
  const w = whenFromSchedule(sched({ kind: 'some', weekdays: [2, 4] }, at('09:00')));
  w.days = 'monthly'; w.days = 'some';
  assert.deepEqual(scheduleFromWhen(w).days, { kind: 'some', weekdays: [2, 4] });
});

test('nextFreeTime adds an hour after the latest time and never repeats one', () => {
  assert.equal(nextFreeTime([]), '07:30');
  assert.equal(nextFreeTime(['07:30']), '08:30');
  assert.equal(nextFreeTime(['07:30', '18:30']), '19:30');
  assert.equal(nextFreeTime(['23:30']), '00:30');
});

test('previewText is the engine nextRun: today, then the next day it runs', () => {
  const s = sched({ kind: 'weekdays' }, at('07:00', '18:30'));
  const mon = local(2026, 5, 4, 12, 0); // Monday
  assert.equal(previewText(s, mon), 'Next: today 18:30, then tomorrow 07:00');
  assert.equal(previewText(s, local(2026, 5, 4, 6, 0)), 'Next: today 07:00, then 18:30', 'same day: just the time');
  const fri = local(2026, 5, 8, 19, 0);
  assert.equal(previewText(s, fri), 'Next: Mon 07:00, then 18:30');
  assert.equal(previewText(sched({ kind: 'monthly', day: 1 }, at('10:00')), mon), 'Next: Jun 1 10:00, then Jul 1 10:00');
  assert.equal(previewText(sched({ kind: 'daily' }, at('08:00', '08:30')), mon), '', 'invalid: no preview');
  // the same instants the engine returns
  for (const now of [mon, fri, local(2026, 3, 7, 12), local(2026, 11, 1, 0)]) {
    const first = nextRun(s, now);
    assert.ok(previewText(s, now).includes(`${String(new Date(first).getHours()).padStart(2, '0')}:${String(new Date(first).getMinutes()).padStart(2, '0')}`));
  }
});

test('addedRowSet reads the shown version only and tolerates its absence', () => {
  assert.deepEqual([...addedRowSet({ addedRows: ['x:9', 'x:10'] })], ['x:9', 'x:10']);
  assert.equal(addedRowSet({}).size, 0);
  assert.equal(addedRowSet(null).size, 0);
});

test('runNowLine says why a run did not start', () => {
  assert.match(runNowLine({ started: true }), /Started/);
  assert.equal(runNowLine({ started: false, reason: 'Already running.' }), 'Already running.');
  assert.equal(runNowLine({ started: false }), 'It could not start.');
});

test('splitBroken keeps broken files out of the cards, and brokenLine says it once, quietly', () => {
  const list = [r('a', 'active'), { broken: true, id: 'torn.json', file: 'torn.json', name: 'torn.json', problem: 'the file is not valid JSON' }, r('b', 'paused')];
  const { routines, broken } = splitBroken(list);
  assert.deepEqual(routines.map((x) => x.id), ['a', 'b']);
  assert.equal(brokenLine(broken), '1 routine file could not be read: torn.json \u2014 the file is not valid JSON');
  assert.equal(brokenLine([]), '');
  assert.match(brokenLine([...broken, { name: 'x.json', problem: 'it has no usable id' }]), /^2 routine files could not be read: torn\.json .* valid JSON; x\.json .* usable id$/);
  assert.deepEqual(splitBroken(undefined), { routines: [], broken: [] });
});

test('newsLabel and newsTitle: "3 new", singular title, nothing for none', () => {
  assert.equal(newsLabel({ papers: 3, at: 'x' }), '3 new');
  assert.equal(newsTitle({ papers: 1 }), '1 new paper from a routine');
  assert.equal(newsTitle({ papers: 3 }), '3 new papers from a routine');
  for (const none of [undefined, null, {}, { papers: 0 }]) { assert.equal(newsLabel(none), ''); assert.equal(newsTitle(none), ''); }
});

test('newsSession: a link only for a finished run that added papers to a session that still has news', () => {
  const yes = () => true, no = () => false;
  const digest = { lastRun: { status: 'done', added: 4, session: 'S1' }, target: { kind: 'session' } };
  assert.equal(newsSession(digest, yes), 'S1');
  assert.equal(newsSession(digest, no), null, 'opened already');
  const watch = { lastRun: { status: 'done', added: 2 }, target: { kind: 'artifact', session: 'S2', result: { id: 'R1' } } };
  assert.equal(newsSession(watch, (id) => id === 'S2'), 'S2');
  assert.equal(newsSession({ ...watch, lastRun: { status: 'done', added: 0 } }, yes), null);
  assert.equal(newsSession({ ...watch, lastRun: { status: 'failed', added: 2 } }, yes), null);
  assert.equal(newsSession({ lastRun: null, target: { kind: 'session' } }, yes), null);
  assert.equal(newsSession({ lastRun: { status: 'done', added: 1 }, target: { kind: 'session' } }, yes), null, 'no session to open');
});

test('projectLine: "In <name>" only while the project exists', () => {
  const projects = [{ id: 'P1', name: 'Voles' }];
  assert.equal(projectLine({ project: 'P1' }, projects), 'In Voles');
  assert.equal(projectLine({ project: 'gone' }, projects), '');
  assert.equal(projectLine({}, projects), '');
  assert.equal(projectLine({ project: 'P1' }, []), '');
});

test('projectChoices: hidden without projects; None first; open project preselected for a new routine only', () => {
  const projects = [{ id: 'P1', name: 'Voles' }, { id: 'P2', name: 'Owls' }];
  assert.deepEqual(projectChoices([], null, 'P1', true), { options: [], selected: '' });
  const fresh = projectChoices(projects, null, 'P2', true);
  assert.deepEqual(fresh.options.map((o) => o.label), ['None', 'Voles', 'Owls']);
  assert.equal(fresh.selected, 'P2');
  assert.equal(projectChoices(projects, null, 'P2', false).selected, '', 'an existing routine with none stays none');
  assert.equal(projectChoices(projects, 'P1', 'P2', false).selected, 'P1');
  assert.equal(projectChoices(projects, 'gone', 'P2', false).selected, '', 'a deleted project reads as none');
  assert.equal(projectChoices(projects, null, 'gone', true).selected, '');
});
