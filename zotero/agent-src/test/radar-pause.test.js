// Sources chips: a paused radar is skipped by the scheduler and runs again after resume.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRoutineScheduler } from '../src/routine-scheduler.js';
import { createRoutineStore } from '../src/routine-store.js';
import { memoryFs } from './support/memory-fs.mjs';

process.env.TZ = 'America/New_York';
const local = (y, mo, d, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();

const radar = (over = {}) => ({
  id: 'rad', name: 'rad', prompt: 'p', skills: [], depth: 'standard', schedule: { kind: 'daily', time: '07:30' }, target: { kind: 'session' },
  sources: null, scope: null, status: 'active', kind: 'radar', radar: { profile: { topics: [{ text: 'sleep', weight: 1, origin: 'seed' }], authors: [], journals: [] }, sources: [] }, created: '2026-05-01T00:00:00.000Z', updated: '2026-05-01T00:00:00.000Z',
  lastSlot: null, lastRun: null, notify: false, ...over,
});

test('a paused radar does not run at its slot; after resume the next slot runs it', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const store = createRoutineStore(memoryFs(), 'data');
    const clock = { now: local(2026, 5, 4, 8, 0) };
    const runs = [];
    const s = createRoutineScheduler({
      store, clock: () => clock.now, tickMs: 60_000, startupGraceMs: 45_000, log: () => {},
      run: async (r) => { runs.push(r.id); return { status: 'done', added: 0, summary: 'ok' }; },
    });
    const pulse = async (ms = 60_000) => { clock.now += ms; mock.timers.tick(60_000); await s.idle(); };
    await store.write(radar({ status: 'paused' }));
    await pulse();
    await pulse();
    assert.equal(runs.length, 0, 'paused: the missed slot is not run');
    await store.write({ ...(await store.read('rad')), status: 'active' });
    await pulse(24 * 3600_000);
    assert.deepEqual(runs, ['rad'], 'resumed: it runs at the next slot');
    await s.dispose();
  } finally { mock.timers.reset(); }
});
