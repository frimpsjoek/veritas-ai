// @ts-check
// agent-src/src/routine-store.js. Spec 011 U4: one JSON file per routine at `<dataDir>/routines/<id>.json`, written
// with the platform's writeAtomic (temp file + rename), like every other store here. A file that does not parse is
// skipped, never fatal: a half-synced or hand-edited record must not stop the others from running. The same goes for
// a record that parses but is not a valid routine (bad time, missing schedule): it is skipped on read, list and adopt.

import { validateDraft } from './routines.js';
import { isLegacySchedule } from './schedule.js';

/** @typedef {import("./routines.js").Routine} Routine */
/** @typedef {Pick<import("./platform").Platform['fs'], 'read' | 'writeAtomic' | 'list'>} RoutineFs */

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : -Infinity; };

/** A record that can safely be written and scheduled: a path-safe id and a shape validateDraft accepts. @param {any} r */
function usable(r) {
  if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !SAFE_ID.test(r.id)) return false;
  try { validateDraft(r); return true; } catch { return false; }
}

/** Why a record cannot be used, in words a user can act on. @param {any} r @returns {string | null} null when it is usable */
function problemWith(r) {
  if (!r || typeof r !== 'object') return 'the file does not hold a routine';
  if (typeof r.id !== 'string' || !SAFE_ID.test(r.id)) return 'it has no usable id';
  try { validateDraft(r); return null; } catch (error) { return String(/** @type {any} */ (error)?.message ?? error).replace(/\.$/, '') || 'it is not a valid routine'; }
}

/**
 * The record that results from two copies of the same routine: the later-updated one's fields, except `lastSlot`
 * (the later of the two, so a slot already run anywhere is never run again) and `lastRun` (the one for the later slot).
 * @param {Routine} a @param {Routine} b @returns {Routine}
 */
export function mergeRoutines(a, b) {
  const winner = ms(b.updated) > ms(a.updated) ? b : a;
  const lastSlot = ms(a.lastSlot ?? '') >= ms(b.lastSlot ?? '') ? a.lastSlot ?? null : b.lastSlot ?? null;
  const runA = a.lastRun, runB = b.lastRun;
  const lastRun = !runA ? runB ?? null : !runB ? runA : ms(runB.at) > ms(runA.at) ? runB : runA;
  const lastDone = ms(a.lastDone ?? '') >= ms(b.lastDone ?? '') ? a.lastDone : b.lastDone;
  return { ...winner, lastSlot, ...(lastDone ? { lastDone } : {}), lastRun };
}

/**
 * @param {RoutineFs} fs @param {string} dataDir the agent data directory (routines live under `<dataDir>/routines`)
 */
export function createRoutineStore(fs, dataDir) {
  const dir = `${dataDir}/routines`;
  /** @param {string} id */
  const file = (id) => {
    if (!SAFE_ID.test(String(id))) throw new Error('Invalid routine id.');
    return `${dir}/${id}.json`;
  };

  /** @param {string} id @returns {Promise<Routine | null>} */
  async function read(id) {
    const text = await fs.read(file(id));
    if (text == null) return null;
    try {
      const raw = JSON.parse(text);
      if (!usable(raw)) return null;
      if (!isLegacySchedule(raw.schedule)) return raw;
      // A spec 011 record: read as the current shape and rewrite once, so the file is current from now on.
      const r = { ...raw, schedule: validateDraft(raw).schedule };
      await fs.writeAtomic(file(id), JSON.stringify(r, null, 2));
      return r;
    } catch { return null; }
  }

  return {
    read,
    /** Every readable routine, oldest first. @returns {Promise<Routine[]>} */
    async list() {
      const out = [];
      for (const name of await fs.list(dir)) {
        if (!name.endsWith('.json')) continue;
        const r = await read(name.slice(0, -5));
        if (r) out.push(r);
      }
      return out.sort((a, b) => ms(a.created) - ms(b.created) || (a.id < b.id ? -1 : 1));
    },
    /** The routine files list() leaves out, each with a plain reason: not JSON, no id, an invalid schedule. @returns {Promise<{ file: string, problem: string }[]>} */
    async unreadable() {
      const out = [];
      for (const file of await fs.list(dir)) {
        if (!file.endsWith('.json')) continue;
        const stem = file.slice(0, -5);
        if (!SAFE_ID.test(stem)) { out.push({ file, problem: 'its name is not a valid routine id' }); continue; }
        const text = await fs.read(`${dir}/${file}`);
        if (text == null) continue;
        let problem;
        try { problem = problemWith(JSON.parse(text)); } catch { problem = 'the file is not valid JSON'; }
        if (problem) out.push({ file, problem });
      }
      return out;
    },
    /** @param {Routine} routine */
    async write(routine) {
      await fs.writeAtomic(file(routine.id), JSON.stringify(routine, null, 2));
      return routine;
    },
    /**
     * Brings records made elsewhere (Zotero's own data folder) into this store. Idempotent by id: a record we
     * already hold is merged (see mergeRoutines), so adopting twice changes nothing. Returns the ids taken in.
     * @param {Routine[]} records @returns {Promise<string[]>}
     */
    async adopt(records) {
      const ids = [];
      for (const record of records ?? []) {
        if (!usable(record)) continue;
        const incoming = { ...record, schedule: validateDraft(record).schedule };
        const have = await read(incoming.id);
        const next = have ? mergeRoutines(have, incoming) : incoming;
        if (!have || JSON.stringify(next) !== JSON.stringify(have)) await fs.writeAtomic(file(incoming.id), JSON.stringify(next, null, 2));
        ids.push(incoming.id);
      }
      return ids;
    },
  };
}
