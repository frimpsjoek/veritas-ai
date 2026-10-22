// @ts-check
// agent-src/src/routine-scheduler.js. Spec 011 U4: the one-minute tick that runs due routines. Everything it touches
// is injected (store, clock, owner check, the run itself, the quota rule, the log) so tests drive it with a fake
// clock and fake timers; core.js wires the real ones.
//
// Guarantees: one run at a time; a slot is written to the store BEFORE its run starts (so a restart, catch-up or a
// second owner can never run the same slot twice, and a crash mid-run consumes the slot); missed days collapse to
// one run (isDue); the first tick waits out a startup grace; dispose() stops the timer and aborts the running run.

import { isDue } from './routines.js';

/** @typedef {import("./routines.js").Routine} Routine */
/** @typedef {import("./routines.js").RoutineRun} RoutineRun */
/** @typedef {Omit<RoutineRun, 'at' | 'slot'>} RunResult what a run reports; the scheduler stamps `at` and `slot` */

/**
 * @typedef {{
 *   store: { list(): Promise<Routine[]>, read(id: string): Promise<Routine | null>, write(r: Routine): Promise<unknown> },
 *   clock?: () => number,
 *   tickMs?: number,
 *   startupGraceMs?: number,
 *   isOwner?: () => boolean | Promise<boolean>,
 *   run: (routine: Routine, ctx: { slot: string | null, signal: AbortSignal, trigger: 'schedule' | 'manual' }) => Promise<RunResult>,
 *   quota?: (routine: Routine, nowMs: number) => { ok: boolean, why?: string } | Promise<{ ok: boolean, why?: string }>,
 *   log?: (line: string) => void,
 * }} RoutineSchedulerDeps
 */

/**
 * @param {RoutineSchedulerDeps} deps
 */
export function createRoutineScheduler(deps) {
  const { store, run } = deps;
  const clock = deps.clock ?? Date.now;
  const tickMs = deps.tickMs ?? 60_000;
  const graceMs = deps.startupGraceMs ?? 45_000;
  const isOwner = deps.isOwner ?? (() => true);
  const log = deps.log ?? (() => {});
  const startedAt = clock();

  /** @type {string | null} */
  let running = null;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {Promise<void>} */
  let busy = Promise.resolve();
  let ticking = false;
  let disposed = false;

  const stamp = () => new Date(clock()).toISOString();

  /** Runs one routine whose slot (if any) is already written; records lastRun. */
  async function execute(/** @type {Routine} */ routine, /** @type {string | null} */ slot, /** @type {'schedule' | 'manual'} */ trigger) {
    running = routine.id;
    controller = new AbortController();
    const { signal } = controller;
    /** @type {RoutineRun} */
    let lastRun;
    try {
      const result = await run(routine, { slot, signal, trigger });
      lastRun = signal.aborted ? { at: stamp(), slot, status: 'failed', reason: 'stopped' } : { ...result, at: stamp(), slot };
    } catch (err) {
      lastRun = { at: stamp(), slot, status: 'failed', reason: signal.aborted ? 'stopped' : String(/** @type {any} */ (err)?.message ?? err) };
    } finally {
      running = null;
      controller = null;
    }
    try {
      // Re-read: the user may have paused or edited it mid-run; keep their edits, change only lastRun.
      const current = (await store.read(routine.id)) ?? routine;
      await store.write({ ...current, lastRun, ...(lastRun.status === 'done' ? { lastDone: lastRun.at } : {}) });
    } catch (err) { log(`routine ${routine.id}: could not save the run (${/** @type {any} */ (err)?.message ?? err})`); }
    log(`routine ${routine.id}: ${lastRun.status}${lastRun.reason ? ` (${lastRun.reason})` : ''}`);
  }

  async function tick() {
    if (disposed || ticking || running) return;
    ticking = true;
    try {
      if (clock() - startedAt < graceMs) return;
      if (!(await isOwner())) return;
      const due = [];
      for (const r of await store.list()) {
        try {
          const hit = isDue(r, clock());
          if (hit.due) due.push({ r, slot: /** @type {string} */ (hit.slot) });
        } catch (err) { log(`routine ${r?.id}: skipped, record is invalid (${/** @type {any} */ (err)?.message ?? err})`); }
      }
      due.sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot));
      for (const { r, slot } of due) {
        if (disposed) break;
        // The snapshot is stale once an earlier run has taken minutes: re-read, and skip what is no longer due
        // (paused, archived, edited to another schedule, deleted).
        let claimed;
        try {
          const fresh = await store.read(r.id);
          if (!fresh || !isDue(fresh, clock()).due) continue;
          // Claim the slot first. From here the routine is never due for it again, whatever happens next.
          claimed = { ...fresh, lastSlot: slot };
          await store.write(claimed);
        } catch (err) { log(`routine ${r.id}: could not start (${/** @type {any} */ (err)?.message ?? err})`); continue; }
        /** @type {{ ok: boolean, why?: string }} */
        let verdict = { ok: true };
        if (deps.quota) {
          try { verdict = { ...verdict, ...(await deps.quota(claimed, clock())) }; }
          catch (err) { log(`routine ${r.id}: quota check failed, running anyway (${/** @type {any} */ (err)?.message ?? err})`); }
        }
        try {
          if (!verdict.ok) {
            await store.write({ ...claimed, lastRun: { at: stamp(), slot, status: 'skipped', reason: verdict.why } });
            log(`routine ${r.id}: skipped (${verdict.why})`);
            continue;
          }
        } catch (err) {
          const reason = String(/** @type {any} */ (err)?.message ?? err);
          log(`routine ${r.id}: failed before running (${reason})`);
          try { await store.write({ ...claimed, lastRun: { at: stamp(), slot, status: 'failed', reason } }); } catch {}
          continue;
        }
        await execute(claimed, slot, 'schedule');
      }
    } catch (err) {
      log(`routine tick failed: ${/** @type {any} */ (err)?.message ?? err}`);
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(() => { if (!ticking && !running) busy = tick(); }, tickMs);
  if (typeof timer === 'object' && /** @type {any} */ (timer)?.unref) /** @type {any} */ (timer).unref();

  return {
    /** One scheduling pass now (the interval calls this). Resolves when any run it started has finished. */
    tick() { if (!ticking && !running) busy = tick(); return busy; },
    /** The id of the routine running now, or null. */
    runningId() { return running; },
    /** Resolves when the current tick (and its run) is done. */
    idle() { return busy; },
    /**
     * Run now: ignores the quota rule and the slot, never consumes a slot, refused while another run is going.
     * `done` resolves when the run has been recorded.
     * @param {string} id @returns {Promise<{ started: boolean, reason?: string, done?: Promise<void> }>}
     */
    async runNow(id) {
      if (disposed) return { started: false, reason: 'Routines are stopped.' };
      if (running || ticking) return { started: false, reason: 'Another routine is running.' };
      const routine = await store.read(id);
      if (!routine) return { started: false, reason: 'No such routine.' };
      if (running || ticking) return { started: false, reason: 'Another routine is running.' };
      running = id; // claim before the first await inside execute
      const done = execute(routine, routine.lastSlot, 'manual');
      busy = done;
      return { started: true, done };
    },
    /** Stops the timer and aborts the running run; resolves once that run has been recorded as stopped. */
    async dispose() {
      disposed = true;
      clearInterval(timer);
      controller?.abort();
      await busy.catch(() => {});
    },
  };
}
