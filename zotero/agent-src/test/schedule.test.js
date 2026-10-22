import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextRun, dueSlot, validSchedule, migrateSchedule, scheduleText, minutesList } from '../src/schedule.js';
import { isDue, validateDraft } from '../src/routines.js';
import { createRoutineStore } from '../src/routine-store.js';

process.env.TZ = 'America/New_York';
const local = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const iso = (ms) => new Date(ms).toISOString();
const at = (...times) => ({ kind: 'at', times });
const sched = (days, times) => ({ days, times });
const wk = sched({ kind: 'weekdays' }, at('07:00', '18:30'));

// 2026-05-04 is a Monday.
test('weekdays at 07:00 and 18:30: several slots a day, skipping the weekend', () => {
  assert.equal(nextRun(wk, local(2026, 5, 4, 6, 0)), local(2026, 5, 4, 7, 0));
  assert.equal(nextRun(wk, local(2026, 5, 4, 7, 0)), local(2026, 5, 4, 18, 30), 'strictly after');
  assert.equal(nextRun(wk, local(2026, 5, 4, 18, 30)), local(2026, 5, 5, 7, 0));
  assert.equal(nextRun(wk, local(2026, 5, 8, 19, 0)), local(2026, 5, 11, 7, 0), 'Friday evening -> Monday');
  assert.equal(dueSlot(wk, local(2026, 5, 4, 12, 0)), local(2026, 5, 4, 7, 0));
  assert.equal(dueSlot(wk, local(2026, 5, 4, 6, 59)), local(2026, 5, 1, 18, 30), 'Monday early -> Friday evening');
  assert.equal(dueSlot(wk, local(2026, 5, 10, 12, 0)), local(2026, 5, 8, 18, 30), 'Sunday -> Friday evening');
});

test('simulated week: weekdays at 07:00 and 18:30 fire exactly those ten slots, once each', () => {
  const start = local(2026, 5, 3, 0, 0); // Sunday
  const end = local(2026, 5, 10, 0, 0);
  const fired = [];
  let lastSlot = iso(start);
  for (let t = start; t < end; t += 60_000) {
    const { due, slot } = isDue({ schedule: wk, status: 'active', lastSlot }, t);
    if (due) { fired.push(slot); lastSlot = slot; }
  }
  const want = [];
  for (let d = 4; d <= 8; d++) want.push(iso(local(2026, 5, d, 7, 0)), iso(local(2026, 5, d, 18, 30)));
  assert.deepEqual(fired, want);
});

test('some days: Mon, Wed, Fri at 09:15', () => {
  const s = sched({ kind: 'some', weekdays: [1, 3, 5] }, at('09:15'));
  assert.equal(nextRun(s, local(2026, 5, 4, 10, 0)), local(2026, 5, 6, 9, 15));
  assert.equal(nextRun(s, local(2026, 5, 8, 10, 0)), local(2026, 5, 11, 9, 15));
  assert.equal(dueSlot(s, local(2026, 5, 10, 10, 0)), local(2026, 5, 8, 9, 15));
});

test('every N days from a date: starts on the date, then steps, never before', () => {
  const s = sched({ kind: 'every', n: 3, from: '2026-05-04' }, at('06:00'));
  assert.equal(nextRun(s, local(2026, 5, 1, 0, 0)), local(2026, 5, 4, 6, 0), 'future start date');
  assert.equal(dueSlot(s, local(2026, 5, 1, 0, 0)), null, 'nothing is due before the start date');
  assert.equal(nextRun(s, local(2026, 5, 4, 6, 0)), local(2026, 5, 7, 6, 0));
  assert.equal(nextRun(s, local(2026, 5, 8, 0, 0)), local(2026, 5, 10, 6, 0));
  assert.equal(dueSlot(s, local(2026, 5, 9, 12, 0)), local(2026, 5, 7, 6, 0));
  assert.equal(nextRun(s, local(2027, 1, 1, 0, 0)), local(2027, 1, 2, 6, 0), 'a start date long ago keeps the cadence (243 days = 81 x 3)');
  assert.equal(nextRun(sched({ kind: 'every', n: 5, from: '2030-01-01' }, at('06:00')), local(2026, 5, 4)), local(2030, 1, 1, 6, 0), 'a start date years away');
});

test('monthly: day 15, last day (-1), and days a short month does not have', () => {
  const m15 = sched({ kind: 'monthly', day: 15 }, at('10:00'));
  assert.equal(nextRun(m15, local(2026, 5, 15, 10, 0)), local(2026, 6, 15, 10, 0));
  const last = sched({ kind: 'monthly', day: -1 }, at('10:00'));
  assert.equal(nextRun(last, local(2026, 2, 1)), local(2026, 2, 28, 10, 0));
  assert.equal(nextRun(last, local(2028, 2, 1)), local(2028, 2, 29, 10, 0), 'leap year');
  assert.equal(nextRun(last, local(2026, 4, 30, 10, 0)), local(2026, 5, 31, 10, 0));
  assert.equal(dueSlot(last, local(2026, 5, 20)), local(2026, 4, 30, 10, 0));
  const d31 = sched({ kind: 'monthly', day: 31 }, at('10:00'));
  assert.equal(nextRun(d31, local(2026, 2, 1)), local(2026, 2, 28, 10, 0), 'February has no 31st: its last day');
  assert.equal(nextRun(d31, local(2026, 4, 1)), local(2026, 4, 30, 10, 0));
  const d30 = sched({ kind: 'monthly', day: 30 }, at('10:00'));
  assert.equal(nextRun(d30, local(2026, 1, 31, 12)), local(2026, 2, 28, 10, 0));
  assert.equal(nextRun(d30, local(2026, 2, 28, 10, 0)), local(2026, 3, 30, 10, 0), 'one run per month, not two');
  const first = sched({ kind: 'monthly', day: 1 }, at('10:00'));
  assert.equal(nextRun(first, local(2026, 12, 1, 10, 0)), local(2027, 1, 1, 10, 0), 'across the year end');
});

test('hourly window: both edges are runs, nothing outside; the next day starts at the window start', () => {
  const s = sched({ kind: 'daily' }, { kind: 'hourly', every: 4, from: '08:00', to: '20:00' });
  assert.deepEqual(minutesList(s.times), [480, 720, 960, 1200]);
  assert.equal(nextRun(s, local(2026, 5, 4, 7, 0)), local(2026, 5, 4, 8, 0));
  assert.equal(nextRun(s, local(2026, 5, 4, 8, 0)), local(2026, 5, 4, 12, 0));
  assert.equal(nextRun(s, local(2026, 5, 4, 16, 0)), local(2026, 5, 4, 20, 0), 'the window end is a run');
  assert.equal(nextRun(s, local(2026, 5, 4, 20, 0)), local(2026, 5, 5, 8, 0));
  assert.equal(dueSlot(s, local(2026, 5, 4, 19, 59)), local(2026, 5, 4, 16, 0));
  assert.equal(dueSlot(s, local(2026, 5, 4, 7, 59)), local(2026, 5, 3, 20, 0));
  const odd = sched({ kind: 'daily' }, { kind: 'hourly', every: 5, from: '08:00', to: '20:00' });
  assert.deepEqual(minutesList(odd.times), [480, 780, 1080], 'a last step past the end is dropped');
  const weekdays = sched({ kind: 'weekdays' }, { kind: 'hourly', every: 4, from: '08:00', to: '20:00' });
  assert.equal(nextRun(weekdays, local(2026, 5, 8, 20, 0)), local(2026, 5, 11, 8, 0), 'every 4 hours on weekdays: Friday night -> Monday morning');
  assert.equal(nextRun(sched({ kind: 'daily' }, { kind: 'hourly', every: 1, from: '00:00', to: '23:00' }), local(2026, 5, 4, 23, 0)), local(2026, 5, 5, 0, 0));
});

test('DST: spring forward and fall back keep wall-clock times, never doubling or losing a slot', () => {
  const two = sched({ kind: 'daily' }, at('02:30', '09:00'));
  // US 2026-03-08: 02:30 does not exist and rolls to 03:30.
  assert.equal(iso(nextRun(two, local(2026, 3, 8, 0, 0))), iso(local(2026, 3, 8, 3, 30)));
  assert.equal(nextRun(two, local(2026, 3, 8, 3, 30)), local(2026, 3, 8, 9, 0));
  // US 2026-11-01: 01:30 happens twice and takes the first.
  const fb = sched({ kind: 'daily' }, at('01:30', '09:00'));
  const first = nextRun(fb, local(2026, 11, 1, 0, 0));
  assert.equal(iso(first), '2026-11-01T05:30:00.000Z');
  assert.equal(nextRun(fb, first), local(2026, 11, 1, 9, 0), 'not 01:30 again');
  // two times that land on one instant collapse
  const clash = sched({ kind: 'daily' }, at('02:00', '03:00'));
  const a = nextRun(clash, local(2026, 3, 8, 0, 0));
  assert.equal(iso(a), iso(local(2026, 3, 8, 3, 0)));
  assert.equal(nextRun(clash, a), local(2026, 3, 9, 2, 0));
  // 24h of slots across the whole day count
  let n = 0, t = local(2026, 3, 8, 0, 0) - 1;
  const hourly = sched({ kind: 'daily' }, { kind: 'hourly', every: 6, from: '00:00', to: '18:00' });
  while ((t = nextRun(hourly, t)) < local(2026, 3, 9, 0, 0)) n++;
  assert.equal(n, 4);
});

for (const zone of ['Europe/Berlin']) {
  test(`DST in ${zone}: 2026-03-29 and 2026-10-25`, () => {
    const prev = process.env.TZ;
    process.env.TZ = zone;
    try {
      const l = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
      const s = sched({ kind: 'daily' }, at('02:30', '08:00'));
      assert.equal(iso(nextRun(s, l(2026, 3, 29, 0, 0))), iso(l(2026, 3, 29, 3, 30)), 'spring forward rolls 02:30 to 03:30');
      assert.equal(iso(nextRun(s, l(2026, 3, 29, 3, 30))), iso(l(2026, 3, 29, 8, 0)));
      const fb = sched({ kind: 'daily' }, at('02:30', '08:00'));
      const first = nextRun(fb, l(2026, 10, 25, 0, 0));
      assert.equal(iso(first), '2026-10-25T00:30:00.000Z', 'fall back takes the first 02:30');
      assert.equal(nextRun(fb, first), l(2026, 10, 25, 8, 0));
    } finally { process.env.TZ = prev; }
  });
}

test('validSchedule canonicalises: sorted, deduplicated, padded', () => {
  const out = validSchedule(sched({ kind: 'some', weekdays: [5, 1, 1, 3] }, at('18:30', '7:05', '18:30')));
  assert.deepEqual(out, sched({ kind: 'some', weekdays: [1, 3, 5] }, at('07:05', '18:30')));
});

test('validSchedule rejects what cannot be a schedule', () => {
  const ok = at('07:00');
  const bad = (s, re) => assert.throws(() => validSchedule(s), re);
  bad(undefined, /when the routine runs/);
  bad(sched(undefined, ok), /which days/);
  bad(sched({ kind: 'fortnightly' }, ok), /every day, weekdays/);
  bad(sched({ kind: 'some', weekdays: [] }, ok), /at least one day/);
  bad(sched({ kind: 'some', weekdays: [7] }, ok), /day of the week/);
  bad(sched({ kind: 'every', n: 1, from: '2026-05-04' }, ok), /2 to 30/);
  bad(sched({ kind: 'every', n: 31, from: '2026-05-04' }, ok), /2 to 30/);
  bad(sched({ kind: 'every', n: 3, from: '2026-02-30' }, ok), /not a date/);
  bad(sched({ kind: 'every', n: 3 }, ok), /not a date/);
  bad(sched({ kind: 'monthly', day: 0 }, ok), /1 to 31/);
  bad(sched({ kind: 'monthly', day: 32 }, ok), /1 to 31/);
  bad(sched({ kind: 'daily' }, at()), /at least one time/);
  bad(sched({ kind: 'daily' }, at('07:00', '09:00', '11:00', '13:00', '15:00', '17:00', '19:00')), /up to 6/);
  bad(sched({ kind: 'daily' }, at('25:00')), /not a time/);
  bad(sched({ kind: 'daily' }, { kind: 'hourly', every: 13, from: '08:00', to: '20:00' }), /1 to 12/);
  bad(sched({ kind: 'daily' }, { kind: 'hourly', every: 0, from: '08:00', to: '20:00' }), /1 to 12/);
  bad(sched({ kind: 'daily' }, { kind: 'hourly', every: 2, from: '20:00', to: '08:00' }), /end after it starts/);
  bad(sched({ kind: 'daily' }, { kind: 'cron' }), /set times or every few hours/);
});

test('the once-an-hour floor: closer times are refused, exactly an hour is fine', () => {
  const bad = (days, times) => assert.throws(() => validSchedule(sched(days, times)), /more than once an hour/);
  bad({ kind: 'daily' }, at('07:00', '07:30'));
  bad({ kind: 'daily' }, at('07:00', '07:59'));
  assert.doesNotThrow(() => validSchedule(sched({ kind: 'daily' }, at('07:00', '08:00'))));
  bad({ kind: 'daily' }, at('00:15', '23:30'), 'across midnight, every day');
  bad({ kind: 'weekdays' }, at('00:15', '23:30'));
  bad({ kind: 'some', weekdays: [6, 0] }, at('00:15', '23:30'));
  assert.doesNotThrow(() => validSchedule(sched({ kind: 'some', weekdays: [1, 3] }, at('00:15', '23:30'))), 'days that never touch');
  assert.doesNotThrow(() => validSchedule(sched({ kind: 'monthly', day: 1 }, at('00:15', '23:30'))));
  assert.doesNotThrow(() => validSchedule(sched({ kind: 'daily' }, { kind: 'hourly', every: 1, from: '08:00', to: '20:00' })));
  assert.doesNotThrow(() => validSchedule(sched({ kind: 'daily' }, at('07:00'))));
});

test('migration: spec 011 shapes read as the new shape and fire at the same slots', () => {
  assert.deepEqual(migrateSchedule({ kind: 'daily', time: '07:30' }), sched({ kind: 'daily' }, at('07:30')));
  assert.deepEqual(migrateSchedule({ kind: 'weekly', weekday: 1, time: '18:00' }), sched({ kind: 'some', weekdays: [1] }, at('18:00')));
  const current = sched({ kind: 'daily' }, at('07:30'));
  assert.equal(migrateSchedule(current), current);
  const oldDaily = { kind: 'daily', time: '07:30' }, oldWeekly = { kind: 'weekly', weekday: 1, time: '18:00' };
  for (let t = local(2026, 3, 1); t < local(2026, 12, 1); t += 7 * 3_600_000 + 11 * 60_000) {
    assert.equal(nextRun(validSchedule(oldDaily), t), nextRun(sched({ kind: 'daily' }, at('07:30')), t));
    assert.equal(dueSlot(validSchedule(oldWeekly), t), dueSlot(sched({ kind: 'some', weekdays: [1] }, at('18:00')), t));
  }
  assert.deepEqual(validateDraft({ prompt: 'p', schedule: oldWeekly }).schedule, sched({ kind: 'some', weekdays: [1] }, at('18:00')));
});

test('catch-up: a long gap yields exactly one due slot, the latest, and running it makes the routine not due', () => {
  const s = sched({ kind: 'daily' }, at('07:00', '18:30'));
  const routine = { schedule: s, status: 'active', lastSlot: iso(local(2026, 5, 1, 7, 0)) };
  const now = local(2026, 5, 9, 12, 0);
  const first = isDue(routine, now);
  assert.equal(first.due, true);
  assert.equal(first.slot, iso(local(2026, 5, 9, 7, 0)), 'one slot, the latest, covering the whole gap');
  assert.equal(isDue({ ...routine, lastSlot: first.slot }, now).due, false, 'no second run for the same gap');
  assert.equal(isDue({ ...routine, lastSlot: first.slot }, local(2026, 5, 9, 18, 30)).due, true, 'the next slot is a new run');
});

test('scheduleText words every kind', () => {
  assert.equal(scheduleText(wk), 'Weekdays at 07:00 and 18:30');
  assert.equal(scheduleText(sched({ kind: 'daily' }, at('07:00'))), 'Every day at 07:00');
  assert.equal(scheduleText(sched({ kind: 'some', weekdays: [1, 3, 5] }, at('09:15'))), 'Monday, Wednesday and Friday at 09:15');
  assert.equal(scheduleText(sched({ kind: 'some', weekdays: [1] }, at('09:15'))), 'Every Monday at 09:15');
  assert.equal(scheduleText(sched({ kind: 'every', n: 3, from: '2026-05-04' }, at('06:00'))), 'Every 3 days at 06:00');
  assert.equal(scheduleText(sched({ kind: 'monthly', day: 1 }, at('10:00'))), 'The 1st of each month at 10:00');
  assert.equal(scheduleText(sched({ kind: 'monthly', day: 22 }, at('10:00'))), 'The 22nd of each month at 10:00');
  assert.equal(scheduleText(sched({ kind: 'monthly', day: -1 }, at('10:00'))), 'The last day of each month at 10:00');
  assert.equal(scheduleText(sched({ kind: 'weekdays' }, { kind: 'hourly', every: 4, from: '08:00', to: '20:00' })), 'Weekdays every 4 hours from 08:00 to 20:00');
  assert.equal(scheduleText(sched({ kind: 'daily' }, at('07:00', '12:00', '18:30'))), 'Every day at 07:00, 12:00 and 18:30');
});

// ---- the store migrates old files on first load ----
function memFs() {
  const files = new Map();
  return {
    files,
    read: async (p) => files.get(p) ?? null,
    writeAtomic: async (p, text) => { files.set(p, text); },
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
  };
}
const record = (id, schedule, over = {}) => ({
  id, name: id, prompt: 'p', skills: [], depth: 'standard', schedule, target: { kind: 'session' }, sources: null, scope: null,
  status: 'active', created: '2026-05-01T00:00:00.000Z', updated: '2026-05-01T00:00:00.000Z', lastSlot: '2026-05-03T11:30:00.000Z', lastRun: null, notify: false, ...over,
});

test('store: an old record is read as the new shape, rewritten once, and keeps its lastSlot', async () => {
  const fs = memFs();
  const store = createRoutineStore(fs, 'data');
  fs.files.set('data/routines/old1.json', JSON.stringify(record('old1', { kind: 'daily', time: '07:30' })));
  fs.files.set('data/routines/old2.json', JSON.stringify(record('old2', { kind: 'weekly', weekday: 1, time: '18:00' })));
  fs.files.set('data/routines/new1.json', JSON.stringify(record('new1', wk)));
  const list = await store.list();
  assert.deepEqual(list.map((r) => [r.id, r.schedule]), [['new1', wk], ['old1', sched({ kind: 'daily' }, at('07:30'))], ['old2', sched({ kind: 'some', weekdays: [1] }, at('18:00'))]]);
  const onDisk = JSON.parse(fs.files.get('data/routines/old2.json'));
  assert.deepEqual(onDisk.schedule, sched({ kind: 'some', weekdays: [1] }, at('18:00')), 'rewritten in the new shape');
  assert.equal(onDisk.lastSlot, '2026-05-03T11:30:00.000Z');
  const writes = [];
  const w = fs.writeAtomic; fs.writeAtomic = async (p, t) => { writes.push(p); return w(p, t); };
  await store.list();
  assert.deepEqual(writes, [], 'the second load writes nothing');
});

test('store: adopt merges a mix of old and new records by id', async () => {
  const fs = memFs();
  const store = createRoutineStore(fs, 'data');
  fs.files.set('data/routines/a.json', JSON.stringify(record('a', { kind: 'daily', time: '07:30' })));
  const later = '2026-05-02T00:00:00.000Z';
  const ids = await store.adopt([
    record('a', { kind: 'weekly', weekday: 2, time: '09:00' }, { updated: later, lastSlot: '2026-05-02T13:00:00.000Z' }), // old shape, newer
    record('b', wk), // new shape, new id
    record('c', { kind: 'daily', time: '06:00' }), // old shape, new id
  ]);
  assert.deepEqual(ids, ['a', 'b', 'c']);
  const a = await store.read('a');
  assert.deepEqual(a.schedule, sched({ kind: 'some', weekdays: [2] }, at('09:00')));
  assert.equal(a.lastSlot, '2026-05-03T11:30:00.000Z', 'the later lastSlot wins');
  assert.deepEqual((await store.read('c')).schedule, sched({ kind: 'daily' }, at('06:00')));
  assert.deepEqual(await store.adopt([record('b', wk)]), ['b']);
  assert.deepEqual((await store.read('b')).schedule, wk);
});
