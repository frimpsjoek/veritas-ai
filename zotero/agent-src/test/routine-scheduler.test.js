import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRoutineScheduler } from '../src/routine-scheduler.js';
import { createRoutineStore } from '../src/routine-store.js';
import { memoryFs } from './support/memory-fs.mjs';

process.env.TZ = 'America/New_York';
const local = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const iso = (ms) => new Date(ms).toISOString();

const routine = (id, over = {}) => ({
  id, name: id, prompt: 'p', skills: [], depth: 'standard', schedule: { kind: 'daily', time: '07:30' }, target: { kind: 'session' },
  sources: null, scope: null, status: 'active', created: '2026-05-01T00:00:00.000Z', updated: '2026-05-01T00:00:00.000Z',
  lastSlot: null, lastRun: null, notify: false, ...over,
});

function setup(over = {}) {
  const fs = memoryFs();
  const store = createRoutineStore(fs, 'data');
  const clock = { now: local(2026, 5, 4, 8, 0) };
  const runs = [];
  const logs = [];
  const deps = {
    store, clock: () => clock.now, tickMs: 60_000, startupGraceMs: 45_000, log: (l) => logs.push(l),
    run: async (r, ctx) => { runs.push({ id: r.id, ...ctx }); return { status: 'done', added: 2, summary: 'ok' }; },
    ...over,
  };
  return { fs, store, clock, runs, logs, deps };
}

/** Fire the interval once and wait for the tick (and any run) to settle. */
async function pulse(scheduler, clock, ms = 60_000) {
  clock.now += ms;
  mock.timers.tick(60_000);
  await scheduler.idle();
}

test('waits out the startup grace, then runs a missed routine once and records the slot first and the run after', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup();
    await t.store.write(routine('r1'));
    const s = createRoutineScheduler(t.deps);
    // Grace is 45 s and ticks are 60 s: the first tick (t = 60 s) is past grace, so it runs.
    await pulse(s, t.clock);
    assert.equal(t.runs.length, 1);
    assert.equal(t.runs[0].trigger, 'schedule');
    assert.equal(t.runs[0].slot, iso(local(2026, 5, 4, 7, 30)));
    const saved = await t.store.read('r1');
    assert.equal(saved.lastSlot, iso(local(2026, 5, 4, 7, 30)));
    assert.equal(saved.lastRun.status, 'done');
    assert.equal(saved.lastRun.added, 2);
    assert.equal(saved.lastDone, saved.lastRun.at, 'a done run sets lastDone');
    assert.equal(saved.lastRun.slot, saved.lastSlot);
    await pulse(s, t.clock);
    await pulse(s, t.clock);
    assert.equal(t.runs.length, 1, 'the same slot never runs twice');
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('no tick before the startup grace has passed', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup({ startupGraceMs: 150_000 });
    await t.store.write(routine('r1'));
    const s = createRoutineScheduler(t.deps);
    await pulse(s, t.clock);
    await pulse(s, t.clock);
    assert.equal(t.runs.length, 0);
    await pulse(s, t.clock);
    assert.equal(t.runs.length, 1);
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('three missed days collapse to one run, and the next day runs again at its slot', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup();
    await t.store.write(routine('r1', { lastSlot: iso(local(2026, 5, 1, 7, 30)) }));
    const s = createRoutineScheduler(t.deps);
    await pulse(s, t.clock);
    assert.equal(t.runs.length, 1);
    await pulse(s, t.clock, 24 * 3600_000 - 60_000); // next morning, after 07:30
    assert.equal(t.runs.length, 2);
    assert.equal(t.runs[1].slot, iso(local(2026, 5, 5, 7, 30)));
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('over two runtime lifetimes on the same files, one slot runs once', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup();
    await t.store.write(routine('r1'));
    const first = createRoutineScheduler(t.deps);
    await pulse(first, t.clock);
    await first.dispose();
    const second = createRoutineScheduler(t.deps);
    await pulse(second, t.clock);
    await pulse(second, t.clock);
    assert.equal(t.runs.length, 1);
    await second.dispose();
  } finally { mock.timers.reset(); }
});

test('isOwner false never runs; paused and archived routines never run', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup({ isOwner: () => false });
    await t.store.write(routine('r1'));
    const s = createRoutineScheduler(t.deps);
    await pulse(s, t.clock);
    await pulse(s, t.clock);
    assert.equal(t.runs.length, 0);
    assert.equal((await t.store.read('r1')).lastSlot, null, 'a non-owner does not even claim the slot');
    await s.dispose();

    const u = setup();
    await u.store.write(routine('p', { status: 'paused' }));
    await u.store.write(routine('a', { status: 'archived' }));
    const s2 = createRoutineScheduler(u.deps);
    await pulse(s2, u.clock);
    assert.equal(u.runs.length, 0);
    await s2.dispose();
  } finally { mock.timers.reset(); }
});

test('one run at a time: due routines run in order, and a tick during a run does nothing', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let release;
    let active = 0, peak = 0;
    const t = setup({
      run: async (r) => { active++; peak = Math.max(peak, active); await new Promise((res) => { release = res; }); active--; return { status: 'done', added: 0 }; },
    });
    await t.store.write(routine('r1', { created: '2026-05-01T00:00:00.000Z' }));
    await t.store.write(routine('r2', { created: '2026-05-02T00:00:00.000Z' }));
    const s = createRoutineScheduler(t.deps);
    t.clock.now += 60_000;
    mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(s.runningId(), 'r1');
    t.clock.now += 60_000;
    mock.timers.tick(60_000); // overlapping tick
    await new Promise((r) => setImmediate(r));
    assert.equal(peak, 1);
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(s.runningId(), 'r2', 'the second due routine starts after the first is recorded');
    release();
    await s.idle();
    assert.equal(peak, 1);
    assert.equal((await t.store.read('r1')).lastRun.status, 'done');
    assert.equal((await t.store.read('r2')).lastRun.status, 'done');
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('runNow while a run is going is refused; otherwise it ignores the slot and the quota and consumes no slot', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let release;
    const t = setup({
      quota: () => ({ ok: false, why: 'Codex window 63% used at 07:30' }),
      run: async (r, ctx) => { t.runs.push({ id: r.id, ...ctx }); await new Promise((res) => { release = res; }); return { status: 'done', added: 0 }; },
    });
    const slot = iso(local(2026, 5, 4, 7, 30));
    await t.store.write(routine('r1', { lastSlot: slot }));
    const s = createRoutineScheduler(t.deps);
    const a = await s.runNow('r1');
    assert.equal(a.started, true);
    assert.equal(s.runningId(), 'r1');
    assert.deepEqual(await s.runNow('r1'), { started: false, reason: 'Another routine is running.' });
    release();
    await a.done;
    assert.equal(t.runs[0].trigger, 'manual');
    const saved = await t.store.read('r1');
    assert.equal(saved.lastSlot, slot, 'a manual run leaves lastSlot alone');
    assert.equal(saved.lastRun.status, 'done');
    assert.equal((await s.runNow('nope')).started, false);
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('a quota refusal skips the run, consumes the slot and records the reason', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup({ quota: () => ({ ok: false, why: 'Codex window 63% used at 07:30' }) });
    await t.store.write(routine('r1'));
    const s = createRoutineScheduler(t.deps);
    await pulse(s, t.clock);
    await pulse(s, t.clock);
    assert.equal(t.runs.length, 0);
    const saved = await t.store.read('r1');
    assert.equal(saved.lastRun.status, 'skipped');
    assert.equal(saved.lastRun.reason, 'Codex window 63% used at 07:30');
    assert.equal(saved.lastSlot, iso(local(2026, 5, 4, 7, 30)));
    assert.match(t.logs.join('\n'), /skipped \(Codex window 63%/);
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('a failing run is recorded as failed with its message and the slot stays consumed', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup({ run: async () => { throw new Error('provider unavailable'); } });
    await t.store.write(routine('r1'));
    const s = createRoutineScheduler(t.deps);
    await pulse(s, t.clock);
    await pulse(s, t.clock);
    const saved = await t.store.read('r1');
    assert.equal(saved.lastRun.status, 'failed');
    assert.equal(saved.lastRun.reason, 'provider unavailable');
    assert.equal(saved.lastSlot, iso(local(2026, 5, 4, 7, 30)));
    assert.equal(saved.lastDone ?? null, null, 'a failed run does not move lastDone');
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('a pause or edit made during a run survives; only lastRun is written', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let release;
    let t;
    t = setup({ run: async (r) => { await new Promise((res) => { release = res; }); return { status: 'done', added: 1 }; } });
    await t.store.write(routine('r1'));
    const s = createRoutineScheduler(t.deps);
    t.clock.now += 60_000;
    mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));
    await t.store.write({ ...(await t.store.read('r1')), status: 'paused', name: 'edited' });
    release();
    await s.idle();
    const saved = await t.store.read('r1');
    assert.equal(saved.status, 'paused');
    assert.equal(saved.name, 'edited');
    assert.equal(saved.lastRun.status, 'done');
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('dispose stops the interval and aborts the running run as failed/stopped', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let signalSeen;
    const t = setup({
      run: (r, ctx) => new Promise((resolve, reject) => { signalSeen = ctx.signal; ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))); }),
    });
    await t.store.write(routine('r1'));
    await t.store.write(routine('r2', { created: '2026-05-02T00:00:00.000Z' }));
    const s = createRoutineScheduler(t.deps);
    t.clock.now += 60_000;
    mock.timers.tick(60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(s.runningId(), 'r1');
    await s.dispose();
    assert.equal(signalSeen.aborted, true);
    const saved = await t.store.read('r1');
    assert.deepEqual([saved.lastRun.status, saved.lastRun.reason], ['failed', 'stopped']);
    assert.equal((await t.store.read('r2')).lastSlot, null, 'the next due routine was not claimed after dispose');
    // After dispose no timer fires and nothing new starts.
    const before = t.runs.length;
    t.clock.now += 3 * 60_000;
    mock.timers.tick(3 * 60_000);
    await s.idle();
    assert.equal(t.runs.length, before);
    assert.deepEqual(await s.runNow('r2'), { started: false, reason: 'Routines are stopped.' });
  } finally { mock.timers.reset(); }
});

test('a routine paused during an earlier run does not run, and stays paused (fresh read before claiming)', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup();
    await t.store.write(routine('r1'));
    await t.store.write(routine('r2', { created: '2026-05-02T00:00:00.000Z' }));
    const ran = [];
    const s = createRoutineScheduler({ ...t.deps, run: async (r) => {
      ran.push(r.id);
      if (r.id === 'r1') await t.store.write({ ...(await t.store.read('r2')), status: 'paused' });
      return { status: 'done', added: 0, summary: 'ok' };
    } });
    await pulse(s, t.clock);
    assert.deepEqual(ran, ['r1']);
    const r2 = await t.store.read('r2');
    assert.equal(r2.status, 'paused');
    assert.equal(r2.lastSlot, null);
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('a malformed record never stops the others: the good one runs', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup();
    t.fs.files.set('data/routines/bad.json', JSON.stringify({ id: 'bad', status: 'active', schedule: { kind: 'daily', time: '99:99' } }));
    t.fs.files.set('data/routines/bad2.json', JSON.stringify({ id: 'bad2', status: 'active' }));
    await t.store.write(routine('good'));
    const s = createRoutineScheduler(t.deps);
    await pulse(s, t.clock);
    assert.deepEqual(t.runs.map((r) => r.id), ['good']);
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('a throwing isDue for one record (stale snapshot bypassing the store) does not stop the others', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup();
    const good = routine('good');
    const bad = routine('bad', { schedule: { kind: 'daily', time: 'nope' } });
    const store = { list: async () => [bad, good], read: async (id) => (id === 'good' ? good : bad), write: async () => {} };
    const s = createRoutineScheduler({ ...t.deps, store });
    await pulse(s, t.clock);
    assert.deepEqual(t.runs.map((r) => r.id), ['good']);
    await s.dispose();
  } finally { mock.timers.reset(); }
});

test('a quota error runs the routine; a throw after the claim records a failed lastRun instead of eating the slot silently', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup();
    await t.store.write(routine('q'));
    const s = createRoutineScheduler({ ...t.deps, quota: async () => { throw new Error('boom'); } });
    await pulse(s, t.clock);
    assert.equal(t.runs.length, 1, 'quota failure is treated as ok');
    await s.dispose();
  } finally { mock.timers.reset(); }
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const t = setup();
    await t.store.write(routine('w'));
    let fail = true;
    const store = { list: () => t.store.list(), read: (id) => t.store.read(id), write: async (r) => {
      if (fail && r.lastRun?.status === 'skipped') { fail = false; throw new Error('disk full'); }
      return t.store.write(r);
    } };
    const s = createRoutineScheduler({ ...t.deps, store, quota: async () => ({ ok: false, why: 'half used' }) });
    await pulse(s, t.clock);
    const saved = await t.store.read('w');
    assert.equal(saved.lastRun?.status, 'failed');
    assert.match(saved.lastRun.reason, /disk full/);
    await s.dispose();
  } finally { mock.timers.reset(); }
});
