// @ts-check
// agent-src/src/routine-scheduler.js. Spec 011 U4: the one-minute tick that runs due routines. Everything it touches
// is injected (store, clock, owner check, the run itself, the quota rule, the log) so tests drive it with a fake
// clock and fake timers; core.js wires the real ones.
//
// Guarantees: one run at a time; a slot is written to the store BEFORE its run starts (so a restart, catch-up or a
// second owner can never run the same slot twice, and a crash mid-run consumes the slot); missed days collapse to
// one run (isDue); the first tick waits out a startup grace; dispose() stops the timer and aborts the running run.
// Two exceptions to the slot: a reading radar that has never run starts on the next tick, and one whose scheduled run
// failed gets its slot again a little later (see dueNow). After the computer has slept, nothing starts until it has
// stayed awake past the same grace: a Mac wakes for moments at night, and a run started then is cut off when it sleeps.

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
 *   wakeGapMs?: number,
 *   isOwner?: () => boolean | Promise<boolean>,
 *   run: (routine: Routine, ctx: { slot: string | null, signal: AbortSignal, trigger: 'schedule' | 'manual' }) => Promise<RunResult>,
 *   quota?: (routine: Routine, nowMs: number) => { ok: boolean, why?: string } | Promise<{ ok: boolean, why?: string }>,
 *   log?: (line: string) => void,
 * }} RoutineSchedulerDeps
 */

const RETRY_AFTER_MS = 30 * 60_000;
const MAX_TRIES = 3;

/**
 * A radar's scheduled run that failed may try its slot again: a radar reads feeds and scores them, so the usual failure
 * (asleep, offline, the server busy) passes. Only `tries` marks a scheduled run; one the user started or stopped is theirs.
 * @param {Routine} r @param {number} nowMs
 */
function mayRetry(r, nowMs) {
  const last = r.lastRun;
  if (r.kind !== 'radar' || r.status !== 'active' || last?.status !== 'failed' || last.reason === 'stopped') return false;
  if (!last.tries || last.tries >= MAX_TRIES || !last.slot || last.slot !== r.lastSlot) return false;
  return nowMs - Date.parse(last.at) >= RETRY_AFTER_MS;
}

/**
 * isDue, plus a reading radar that has never run (no lastRun, no lastDone): it is due now, so a new radar fills Home
 * at once instead of after its first slot. Only radars: a watch or digest calls a model, so it keeps to the time the
 * user chose. Its slot is now and is claimed like any other, so it happens once: a slot claimed after the routine was
 * created means this first run already started (a crash mid-run must not repeat it on every restart).
 * @param {Routine} r @param {number} nowMs @returns {{ due: boolean, slot: string | null }}
 */
function dueNow(r, nowMs) {
  const hit = isDue(r, nowMs);
  if (!hit.due && mayRetry(r, nowMs)) return { due: true, slot: r.lastSlot };
  if (hit.due || r.kind !== 'radar' || r.status !== 'active' || r.lastRun || r.lastDone) return hit;
  if (r.lastSlot && Date.parse(r.lastSlot) >= Date.parse(r.created)) return hit;
  return { due: true, slot: new Date(nowMs).toISOString() };
}

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
  const wakeGapMs = deps.wakeGapMs ?? 5 * 60_000;
  // The timer does not fire while the computer sleeps, so a long gap between beats means it has just woken.
  let settledFrom = clock();
  let lastBeat = settledFrom;
  const beat = () => {
    const now = clock();
    if (now - lastBeat > wakeGapMs) settledFrom = now;
    lastBeat = now;
  };

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
    const before = routine.lastRun;
    const tries = trigger === 'schedule' ? { tries: (before?.slot === slot && before?.tries || 0) + 1 } : {};
    /** @type {RoutineRun} */
    let lastRun;
    try {
      const result = await run(routine, { slot, signal, trigger });
      lastRun = signal.aborted ? { at: stamp(), slot, status: 'failed', reason: 'stopped', ...tries } : { ...result, at: stamp(), slot, ...tries };
    } catch (err) {
      lastRun = { at: stamp(), slot, status: 'failed', reason: signal.aborted ? 'stopped' : String(/** @type {any} */ (err)?.message ?? err), ...tries };
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
      if (clock() - settledFrom < graceMs) return;
      if (!(await isOwner())) return;
      const due = [];
      for (const r of await store.list()) {
        try {
          const hit = dueNow(r, clock());
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
          if (!fresh || !dueNow(fresh, clock()).due) continue;
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

  const timer = setInterval(() => { beat(); if (!ticking && !running) busy = tick(); }, tickMs);
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
