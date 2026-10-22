import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, nextRun, dueSlot, isDue, validateDraft, planSince, newRows, changeLine, quotaAllows } from '../src/routines.js';

// Local-time schedules: pin the zone so the suite means the same thing on every machine.
process.env.TZ = 'America/New_York';
const local = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const iso = (ms) => new Date(ms).toISOString();
const daily = (time) => ({ kind: 'daily', time });
const weekly = (weekday, time) => ({ kind: 'weekly', weekday, time });

test('parseTime accepts HH:MM and H:MM and throws on anything else', () => {
  assert.deepEqual(parseTime('07:30'), { h: 7, m: 30 });
  assert.deepEqual(parseTime('7:05'), { h: 7, m: 5 });
  assert.deepEqual(parseTime('23:59'), { h: 23, m: 59 });
  for (const bad of ['24:00', '12:60', '7', '', 'noon', '12:5', undefined]) assert.throws(() => parseTime(bad), /not a time/);
});

test('daily nextRun: before the time it is today, at or after it is tomorrow', () => {
  assert.equal(nextRun(daily('07:30'), local(2026, 5, 4, 6, 0)), local(2026, 5, 4, 7, 30));
  assert.equal(nextRun(daily('07:30'), local(2026, 5, 4, 7, 30)), local(2026, 5, 5, 7, 30), 'strictly after');
  assert.equal(nextRun(daily('07:30'), local(2026, 5, 4, 20, 0)), local(2026, 5, 5, 7, 30));
});

test('weekly nextRun crosses the week boundary and month end', () => {
  // 2026-05-04 is a Monday. Weekly on Sunday (0) at 09:00.
  assert.equal(new Date(local(2026, 5, 4)).getDay(), 1);
  assert.equal(nextRun(weekly(0, '09:00'), local(2026, 5, 4, 10, 0)), local(2026, 5, 10, 9, 0));
  // Same weekday, time already passed: a full week later.
  assert.equal(nextRun(weekly(1, '09:00'), local(2026, 5, 4, 10, 0)), local(2026, 5, 11, 9, 0));
  // Same weekday, time not yet passed: today.
  assert.equal(nextRun(weekly(1, '09:00'), local(2026, 5, 4, 8, 0)), local(2026, 5, 4, 9, 0));
  // Month end: Thursday 2026-04-30 -> Wednesday (3) 2026-05-06.
  assert.equal(nextRun(weekly(3, '12:00'), local(2026, 4, 30, 13, 0)), local(2026, 5, 6, 12, 0));
});

test('dueSlot is the latest occurrence at or before now, across midnight and weekdays', () => {
  assert.equal(dueSlot(daily('07:30'), local(2026, 5, 4, 7, 29)), local(2026, 5, 3, 7, 30));
  assert.equal(dueSlot(daily('07:30'), local(2026, 5, 4, 7, 30)), local(2026, 5, 4, 7, 30));
  assert.equal(dueSlot(daily('23:50'), local(2026, 5, 4, 0, 10)), local(2026, 5, 3, 23, 50), 'just after midnight is still last night\'s slot');
  assert.equal(dueSlot(weekly(5, '08:00'), local(2026, 5, 4, 12, 0)), local(2026, 5, 1, 8, 0), 'Friday before Monday');
  assert.equal(dueSlot(weekly(1, '08:00'), local(2026, 5, 4, 7, 0)), local(2026, 4, 27, 8, 0), 'same weekday, earlier than the time: last week');
});

test('isDue: only active routines, false at lastSlot, one slot for three missed days', () => {
  const now = local(2026, 5, 7, 8, 0);
  const base = { schedule: daily('07:30'), status: 'active', lastSlot: null };
  assert.deepEqual(isDue(base, now), { due: true, slot: iso(local(2026, 5, 7, 7, 30)) }, 'never run -> due');
  const ran = { ...base, lastSlot: iso(local(2026, 5, 7, 7, 30)) };
  assert.equal(isDue(ran, now).due, false, 'false at lastSlot');
  assert.equal(isDue(ran, local(2026, 5, 8, 7, 29)).due, false);
  assert.equal(isDue(ran, local(2026, 5, 8, 7, 30)).due, true);
  const stale = { ...base, lastSlot: iso(local(2026, 5, 3, 7, 30)) };
  const hit = isDue(stale, now);
  assert.equal(hit.due, true);
  assert.equal(hit.slot, iso(local(2026, 5, 7, 7, 30)), 'three missed days collapse to the latest slot');
  assert.equal(isDue({ ...stale, lastSlot: hit.slot }, now).due, false, 'after running that slot, nothing is owed');
  for (const status of ['paused', 'archived']) assert.deepEqual(isDue({ ...base, status }, now), { due: false, slot: null });
});

test('a schedule edit that sets lastSlot to now is not due until the next slot', () => {
  const now = local(2026, 5, 4, 12, 0);
  const edited = { schedule: daily('07:30'), status: 'active', lastSlot: iso(now) };
  assert.equal(isDue(edited, now).due, false);
  assert.equal(isDue(edited, local(2026, 5, 5, 7, 30)).due, true);
});

test('US spring forward 2026-03-08: a daily 02:30 runs once, at 03:30', () => {
  const s = daily('02:30');
  const at = nextRun(s, local(2026, 3, 7, 12, 0));
  assert.equal(iso(at), '2026-03-08T07:30:00.000Z'); // 03:30 EDT
  assert.equal(iso(nextRun(s, at)), '2026-03-09T06:30:00.000Z');
  assert.equal(dueSlot(s, local(2026, 3, 8, 12, 0)), at);
  assert.equal(isDue({ schedule: s, status: 'active', lastSlot: iso(at) }, local(2026, 3, 8, 23, 0)).due, false);
});

test('US fall back 2026-11-01: a daily 01:30 takes the first occurrence and runs once', () => {
  const s = daily('01:30');
  const at = nextRun(s, local(2026, 10, 31, 12, 0));
  assert.equal(iso(at), '2026-11-01T05:30:00.000Z'); // 01:30 EDT
  assert.equal(iso(nextRun(s, at)), '2026-11-02T06:30:00.000Z', 'the repeated 01:30 EST is skipped');
  // An hour later (01:30 EST, the second pass) that slot is still the one already run.
  const second = Date.parse('2026-11-01T06:30:00.000Z');
  assert.equal(dueSlot(s, second), at);
});

test('Europe spring forward 2026-03-29: a daily 02:30 runs once, at 03:30 CEST', () => {
  process.env.TZ = 'Europe/Berlin';
  try {
    const s = daily('02:30');
    const at = nextRun(s, local(2026, 3, 28, 12, 0));
    assert.equal(iso(at), '2026-03-29T01:30:00.000Z');
    assert.equal(iso(nextRun(s, at)), '2026-03-30T00:30:00.000Z');
  } finally { process.env.TZ = 'America/New_York'; }
});

test('Europe fall back 2026-10-25: a daily 02:30 takes the first occurrence and runs once', () => {
  process.env.TZ = 'Europe/Berlin';
  try {
    const s = daily('02:30');
    const at = nextRun(s, local(2026, 10, 24, 12, 0));
    assert.equal(iso(at), '2026-10-25T00:30:00.000Z'); // 02:30 CEST
    assert.equal(iso(nextRun(s, at)), '2026-10-26T01:30:00.000Z');
  } finally { process.env.TZ = 'America/New_York'; }
});

test('weekly across a DST change keeps the wall-clock time', () => {
  // Sunday 2026-03-01 09:00 EST; the next Sunday 2026-03-08 09:00 is EDT (one hour earlier in UTC).
  const first = local(2026, 3, 1, 9, 0);
  const next = nextRun(weekly(0, '09:00'), first);
  assert.equal(iso(next), '2026-03-08T13:00:00.000Z');
  assert.equal(iso(first), '2026-03-01T14:00:00.000Z');
});

test('validateDraft fills defaults and normalises the time', () => {
  const out = validateDraft({ prompt: '  new preprints on topic X ', schedule: { kind: 'daily', time: '7:05' } });
  assert.deepEqual(out, {
    name: 'new preprints on topic X', prompt: 'new preprints on topic X', skills: [], depth: 'standard',
    schedule: { days: { kind: 'daily' }, times: { kind: 'at', times: ['07:05'] } }, target: { kind: 'session' }, sources: null, scope: null, status: 'active', notify: false,
  });
  const full = validateDraft({
    name: 'Watch', prompt: 'p', skills: ['a', 'a', ' b '], depth: 'deep', schedule: { kind: 'weekly', weekday: 3, time: '18:00' },
    target: { kind: 'artifact', session: 'S1', result: { id: 'R1', extra: 1 } }, notify: true,
  });
  assert.deepEqual(full.skills, ['a', 'b']);
  assert.deepEqual(full.target, { kind: 'artifact', session: 'S1', result: { id: 'R1' } });
  assert.equal(full.notify, false, 'notify is reserved');
});

test('validateDraft rejects a bad schedule, target, depth or empty prompt', () => {
  const ok = { prompt: 'p', schedule: daily('07:00') };
  assert.throws(() => validateDraft(null), /name and a prompt/);
  assert.throws(() => validateDraft({ ...ok, prompt: '  ' }), /what the routine should look for/);
  assert.throws(() => validateDraft({ ...ok, schedule: undefined }), /when the routine runs/);
  assert.throws(() => validateDraft({ ...ok, schedule: { kind: 'monthly', time: '07:00' } }), /which days/);
  assert.throws(() => validateDraft({ ...ok, schedule: { kind: 'daily', time: '25:00' } }), /not a time/);
  assert.throws(() => validateDraft({ ...ok, schedule: { kind: 'weekly', weekday: 7, time: '07:00' } }), /day of the week/);
  assert.throws(() => validateDraft({ ...ok, schedule: { kind: 'weekly', time: '07:00' } }), /day of the week/);
  assert.throws(() => validateDraft({ ...ok, target: { kind: 'artifact', session: 'S1' } }), /session and result/);
  assert.throws(() => validateDraft({ ...ok, target: { kind: 'email' } }), /artifact or starts a new session/);
  assert.throws(() => validateDraft({ ...ok, depth: 'extreme' }), /quick, standard or deep/);
});

test('every saved depth still validates, and fastest is accepted', () => {
  for (const depth of ['quick', 'standard', 'deep', 'fastest']) assert.equal(validateDraft({ prompt: 'p', schedule: daily('07:00'), depth }).depth, depth);
});

test('planSince is the last finished run (or creation) minus one day, as a date', () => {
  assert.equal(planSince({ lastDone: '2026-05-04T07:30:10.000Z', created: '2026-01-01T00:00:00.000Z' }), '2026-05-03');
  assert.equal(planSince({ lastDone: null, created: '2026-01-01T00:00:00.000Z' }), '2025-12-31');
  assert.equal(planSince({ created: 'garbage' }, Date.parse('2026-02-10T00:00:00Z')), '2026-02-09');
});

test('planSince ignores a failed or skipped lastRun: only lastDone moves the window', () => {
  const r = { lastDone: '2026-05-01T07:00:00.000Z', lastRun: { at: '2026-05-04T07:00:00.000Z', slot: 's', status: 'failed' }, created: '2026-01-01T00:00:00.000Z' };
  assert.equal(planSince(r), '2026-04-30');
});

test('newRows drops matches by DOI (case, doi.org prefix), citekey and normalised title', () => {
  const existing = [
    { title: 'Alpha study', doi: '10.1/ABC', ref: { kind: 'paper', citekey: 'alpha2020' } },
    { title: 'Beta: a Study!', doi: null, citekey: 'beta2021' },
  ];
  const found = [
    { title: 'Different title', doi: 'https://doi.org/10.1/abc' },
    { title: 'Something else', doi: null, citekey: 'beta2021' },
    { title: 'beta a study', doi: null },
    { title: 'Gamma', doi: '10.2/g' },
    { title: 'Gamma again', doi: '10.2/G' },
    { title: 'Delta', doi: null },
    { title: 'DELTA!', doi: null },
    { title: '  ', doi: '10.3/blank' },
  ];
  assert.deepEqual(newRows(found, existing).map((r) => r.title), ['Gamma', 'Delta']);
  assert.deepEqual(newRows([], existing), []);
  assert.equal(newRows(found, []).length, 5, 'repeats inside the found list collapse too');
});

test('changeLine words one, many, none and the already-here count', () => {
  assert.equal(changeLine(3, 2), 'Routine: 3 new papers (2 already here)');
  assert.equal(changeLine(1, 0), 'Routine: 1 new paper');
  assert.equal(changeLine(0, 4), 'Routine: no new papers (4 already here)');
});

test('quotaAllows: no memo runs, fresh 63% skips with the reason, stale 63% and local run, under 50% runs', () => {
  const now = local(2026, 5, 4, 8, 0);
  const at = local(2026, 5, 4, 7, 30);
  assert.deepEqual(quotaAllows(null, now), { ok: true });
  assert.deepEqual(quotaAllows({ percentUsed: 63, at, windowMinutes: 300, provider: 'codex' }, now), { ok: false, why: 'Codex window 63% used at 07:30' });
  assert.deepEqual(quotaAllows({ percentUsed: 63, at: new Date(at).toISOString(), windowMinutes: 300, provider: 'claude' }, now), { ok: false, why: 'Claude window 63% used at 07:30' });
  assert.equal(quotaAllows({ percentUsed: 63, at: local(2026, 5, 4, 1, 0), windowMinutes: 300, provider: 'codex' }, now).ok, true, 'older than its window');
  assert.equal(quotaAllows({ percentUsed: 63, at, windowMinutes: 300, provider: 'local' }, now).ok, true);
  assert.equal(quotaAllows({ percentUsed: 99, at, windowMinutes: 300, provider: 'oss:gpt' }, now).ok, true);
  assert.equal(quotaAllows({ percentUsed: 49.9, at, windowMinutes: 300, provider: 'codex' }, now).ok, true);
  assert.equal(quotaAllows({ percentUsed: 50, at, windowMinutes: 300, provider: 'codex' }, now).ok, false, '50% is the threshold');
});

test('validateDraft keeps a project id and drops anything that is not one', () => {
  const base = { prompt: 'p', schedule: { kind: 'daily', time: '07:00' } };
  assert.equal(validateDraft({ ...base, project: ' P1 ' }).project, 'P1');
  for (const project of [undefined, null, '', '  ', 5, {}]) assert.equal('project' in validateDraft({ ...base, project }), false);
});
