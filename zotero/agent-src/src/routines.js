// @ts-check
// agent-src/src/routines.js. Spec 011 U4: pure routine logic -- schedule math, record validation, run planning and
// dedupe. No fs, no clock, no network: every function takes the time it needs (ms since epoch) so tests inject it.
//
// Schedule shape, validation and slot math live in schedule.js (pure, shared with the UI bundle); they are re-exported here.

import { validSchedule } from './schedule.js';
import { validateRadar } from './radar.js';
export { parseTime, nextRun, dueSlot, migrateSchedule, isLegacySchedule, validSchedule, scheduleText } from './schedule.js';
import { dueSlot } from './schedule.js';

/** @typedef {import('./schedule.js').Schedule} Schedule */
/** @typedef {{ kind: 'artifact', session: string, result: { id: string } } | { kind: 'session' }} RoutineTarget */
/** @typedef {{ at: string, slot: string | null, status: 'done' | 'failed' | 'skipped', reason?: string, added?: number, session?: string, writes?: any[], review?: string, summary?: string }} RoutineRun */
/**
 * @typedef {{
 *   id: string, name: string, prompt: string, skills: string[], depth: 'fastest' | 'quick' | 'standard' | 'deep', schedule: Schedule,
 *   target: RoutineTarget, sources: any, scope: any, status: 'active' | 'paused' | 'archived', created: string, updated: string,
 *   lastSlot: string | null, lastDone?: string | null, lastRun: RoutineRun | null, notify: boolean, project?: string,
 *   kind?: 'watch' | 'digest' | 'radar', radar?: import("./radar-types").RadarConfig
 * }} Routine
 */
/** @typedef {{ percentUsed: number, at: number | string, windowMinutes: number, provider?: string, resetsAt?: string }} Usage */

export const DEPTHS = ['fastest', 'quick', 'standard', 'deep'];
const KINDS = ['watch', 'digest', 'radar'];
const DAY_MS = 86_400_000;

/**
 * Is there a slot that has not been run or skipped yet? Missed days collapse to the single latest slot. A routine
 * that was never run (`lastSlot` null) is due as soon as its latest slot has passed.
 * @param {Pick<Routine, 'schedule' | 'status' | 'lastSlot'>} routine @param {number} nowMs
 * @returns {{ due: boolean, slot: string | null }} slot is the ISO time of the latest occurrence (the idempotency key)
 */
export function isDue(routine, nowMs) {
  if (routine.status !== 'active') return { due: false, slot: null };
  const at = dueSlot(routine.schedule, nowMs);
  if (at == null) return { due: false, slot: null };
  const slot = new Date(at).toISOString();
  const last = routine.lastSlot ? Date.parse(routine.lastSlot) : -Infinity;
  return { due: at > last, slot };
}

/** @param {unknown} target @returns {RoutineTarget} */
function validTarget(target) {
  const t = /** @type {any} */ (target);
  if (t == null || t.kind === 'session') return { kind: 'session' };
  if (t.kind === 'artifact') {
    if (typeof t.session !== 'string' || !t.session || typeof t.result?.id !== 'string' || !t.result.id) throw new Error('An artifact routine needs the session and result it updates.');
    return { kind: 'artifact', session: t.session, result: { id: t.result.id } };
  }
  throw new Error('A routine updates an artifact or starts a new session each run.');
}

/**
 * Checks a user's draft and fills defaults. Returns the editable fields of a routine only; the caller adds id,
 * created, updated, lastSlot and lastRun. Throws an Error with a plain-language message.
 * @param {any} draft
 * @returns {Pick<Routine, 'name' | 'prompt' | 'skills' | 'depth' | 'schedule' | 'target' | 'sources' | 'scope' | 'status' | 'notify' | 'project' | 'kind' | 'radar'>}
 */
export function validateDraft(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('A routine needs a name and a prompt.');
  const kind = draft.kind ?? null;
  if (kind != null && !KINDS.includes(kind)) throw new Error('A routine is a watch, a digest or a reading radar.');
  const radar = kind === 'radar' ? validateRadar(draft.radar) : null;
  // A radar is described by its profile and sources, not a prompt.
  const prompt = String(draft.prompt ?? '').trim() || (radar ? 'Reading radar' : '');
  if (!prompt) throw new Error('Say what the routine should look for.');
  const name = String(draft.name ?? '').trim() || prompt.slice(0, 60);
  const depth = draft.depth ?? 'standard';
  if (!DEPTHS.includes(depth)) throw new Error('Depth is fastest, quick, standard or deep.');
  const skills = Array.isArray(draft.skills) ? [...new Set(draft.skills.map((s) => String(s).trim()).filter(Boolean))] : [];
  const status = draft.status ?? 'active';
  if (!['active', 'paused', 'archived'].includes(status)) throw new Error('Status is active, paused or archived.');
  // A project is a label a new session each run is filed under. Whether it still exists is the engine's to check;
  // here anything that is not an id means none.
  if (radar && draft.target?.kind === 'artifact') throw new Error('A reading radar starts a new chat each run.');
  const project = typeof draft.project === 'string' && draft.project.trim() ? draft.project.trim() : null;
  return {
    name, prompt, skills, depth, schedule: validSchedule(draft.schedule), target: validTarget(draft.target),
    sources: draft.sources ?? null, scope: draft.scope ?? null, status, notify: false,
    ...(project ? { project } : {}),
    ...(kind ? { kind } : {}), ...(radar ? { radar } : {}),
  };
}

/**
 * The date a watch run searches from: the last run that finished (`lastDone`, or creation) minus one day of slack, as
 * YYYY-MM-DD in UTC. A failed or skipped run never moves the window, so the papers it missed are found next time.
 * Dedupe by DOI/title catches the overlap.
 * @param {Pick<Routine, 'lastDone' | 'created'>} routine @param {number} [nowMs] fallback when neither date parses
 */
export function planSince(routine, nowMs = Date.now()) {
  let from = Date.parse(routine.lastDone ?? routine.created);
  if (!Number.isFinite(from)) from = nowMs;
  return new Date(from - DAY_MS).toISOString().slice(0, 10);
}

const normTitle = (title) => String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normDoi = (doi) => String(doi ?? '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');
const citekeyOf = (row) => row?.citekey ?? (row?.ref?.kind === 'paper' ? row.ref.citekey : null) ?? null;

/**
 * The found papers that are not already in `existing`, matched like review2's mergeCandidates: DOI (lower-cased),
 * citekey, normalised title. Repeats inside `found` collapse to the first.
 * @template {{ title?: string, doi?: string | null, citekey?: string | null, ref?: any }} T
 * @param {T[]} found @param {{ title?: string, doi?: string | null, citekey?: string | null, ref?: any }[]} existing @returns {T[]}
 */
export function newRows(found, existing) {
  const dois = new Set(), keys = new Set(), titles = new Set();
  const note = (row) => {
    const d = normDoi(row.doi), k = citekeyOf(row), t = normTitle(row.title);
    if (d) dois.add(d);
    if (k) keys.add(k);
    if (t) titles.add(t);
  };
  for (const row of existing ?? []) note(row);
  const out = [];
  for (const row of found ?? []) {
    const d = normDoi(row.doi), k = citekeyOf(row), t = normTitle(row.title);
    if (!t) continue;
    if ((d && dois.has(d)) || (k && keys.has(k)) || titles.has(t)) continue;
    note(row);
    out.push(row);
  }
  return out;
}

/** "Routine: 3 new papers (2 already here)". @param {number} added @param {number} skipped */
export function changeLine(added, skipped) {
  const what = added === 0 ? 'no new papers' : `${added} new ${added === 1 ? 'paper' : 'papers'}`;
  return `Routine: ${what}${skipped > 0 ? ` (${skipped} already here)` : ''}`;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * The 50% provider-window rule. Unknown usage (never seen, or older than its window) runs; a local model has no
 * window. Skips when the remembered window is at least half used.
 * @param {Usage | null | undefined} usage @param {number} nowMs @returns {{ ok: boolean, why?: string }}
 */
export function quotaAllows(usage, nowMs) {
  if (!usage || typeof usage.percentUsed !== 'number') return { ok: true };
  const provider = String(usage.provider ?? '');
  if (provider === 'local' || provider.startsWith('oss:')) return { ok: true };
  const at = typeof usage.at === 'number' ? usage.at : Date.parse(usage.at);
  if (!Number.isFinite(at)) return { ok: true };
  const windowMs = (usage.windowMinutes > 0 ? usage.windowMinutes : 300) * 60_000;
  if (nowMs - at >= windowMs) return { ok: true };
  if (usage.percentUsed < 50) return { ok: true };
  const when = new Date(at);
  const label = provider ? provider[0].toUpperCase() + provider.slice(1) : 'Provider';
  return { ok: false, why: `${label} window ${Math.round(usage.percentUsed)}% used at ${pad(when.getHours())}:${pad(when.getMinutes())}` };
}
