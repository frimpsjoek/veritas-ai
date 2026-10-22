// @ts-check
// ui-src/src/chat/routines-data.js. Spec 011 U4: pure helpers for the Routines view -- tabs, schedule and next-run
// wording, the last-run line, the starter templates, and the "When" row's pure model. No DOM, so node tests run it.
// Schedule shape, validation and slot math live in agent-src/src/schedule.js (pure, no fs, no clock); this file imports
// that one module so the sheet's "Next: ..." preview is the engine's own nextRun, not a second copy.

import { ago } from './steps-data.js';
import { nextRun, validSchedule } from '../../../agent/src/schedule.js';
export { scheduleText, ordinal, MAX_TIMES } from '../../../agent/src/schedule.js';

/** @typedef {import('../../../agent/src/schedule.js').Schedule} Schedule */
/** @typedef {{
 *   id: string, name: string, prompt: string, skills: string[], depth: 'fastest' | 'quick' | 'standard' | 'deep', schedule: Schedule,
 *   target: { kind: 'artifact', session: string, result: { id: string } } | { kind: 'session' },
 *   status: 'active' | 'paused' | 'archived', lastRun: null | { at: string, slot?: string | null, status: 'done' | 'failed' | 'skipped', reason?: string, added?: number, summary?: string },
 *   nextRun?: string | null, running?: boolean
 * }} RoutineCard */
/** @typedef {{ name: string, prompt: string, skills: string[], depth: 'fastest' | 'quick' | 'standard' | 'deep', schedule: Schedule, target: { kind: 'session' } }} RoutineTemplateDraft */

/** One or more set times on the given days. @param {Schedule['days']} days @param {...string} times @returns {Schedule} */
const at = (days, ...times) => ({ days, times: { kind: 'at', times } });

export const TABS = [
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'archived', label: 'Archived' },
];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAY_NAMES = WEEKDAYS;

/**
 * Routines per tab, each tab newest-updated first is the engine's job; here the order given is kept, except that a
 * running routine floats to the top of its tab.
 * @param {RoutineCard[]} routines @returns {{ active: RoutineCard[], paused: RoutineCard[], archived: RoutineCard[] }}
 */
export function groupByStatus(routines) {
  /** @type {{ active: RoutineCard[], paused: RoutineCard[], archived: RoutineCard[] }} */
  const out = { active: [], paused: [], archived: [] };
  for (const r of routines ?? []) (out[r.status] ?? out.active).push(r);
  for (const key of /** @type {const} */ (['active', 'paused', 'archived'])) out[key] = [...out[key].filter((r) => r.running), ...out[key].filter((r) => !r.running)];
  return out;
}

/**
 * The engine's list holds a `{ broken: true, name, problem }` item for each routine file it could not read; they are
 * never cards. @param {any[]} list @returns {{ routines: RoutineCard[], broken: { name: string, problem: string }[] }}
 */
export function splitBroken(list) {
  const routines = [];
  const broken = [];
  for (const r of list ?? []) {
    if (r?.broken) broken.push({ name: String(r.name ?? r.file ?? r.id ?? 'a file'), problem: String(r.problem ?? 'it could not be read') });
    else routines.push(r);
  }
  return { routines, broken };
}

/** One quiet line above the list, or '' when nothing is broken. @param {{ name: string, problem: string }[]} broken */
export function brokenLine(broken) {
  if (!broken?.length) return '';
  const what = broken.map((b) => `${b.name} \u2014 ${b.problem}`).join('; ');
  return `${broken.length} routine ${broken.length === 1 ? 'file' : 'files'} could not be read: ${what}`;
}

/** @param {Date} d */
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
/** @param {number} ms */
const dayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/**
 * "Next run: today at 07:30", "tomorrow at 07:30", "Monday at 18:00", "12 Jun at 07:30"; "Paused" / "Archived" /
 * "Running now" take precedence.
 * @param {Pick<RoutineCard, 'status' | 'nextRun' | 'running'>} routine @param {number} [now]
 */
export function nextRunText(routine, now = Date.now()) {
  if (routine.running) return 'Running now';
  if (routine.status === 'paused') return 'Paused';
  if (routine.status === 'archived') return 'Archived';
  const at = Date.parse(routine.nextRun ?? '');
  if (!Number.isFinite(at)) return '';
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  const when = new Date(at);
  const time = hhmm(when);
  if (days <= 0) return `Next run: today at ${time}`;
  if (days === 1) return `Next run: tomorrow at ${time}`;
  if (days < 7) return `Next run: ${WEEKDAYS[when.getDay()]} at ${time}`;
  return `Next run: ${when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`;
}

/**
 * The card's one-line outcome of the last run.
 * @param {Pick<RoutineCard, 'lastRun'>} routine @param {number} [now]
 */
export function lastRunLine(routine, now = Date.now()) {
  const run = routine.lastRun;
  if (!run) return 'Has not run yet';
  const when = ago(run.at, now);
  if (run.status === 'skipped') return `Skipped ${when}: ${run.reason ?? 'provider limit'}`;
  if (run.status === 'failed') return `Failed ${when}${run.reason ? `: ${run.reason}` : ''}`;
  const n = run.added;
  const found = typeof n === 'number' ? (n === 0 ? 'nothing new' : `${n} new ${n === 1 ? 'paper' : 'papers'}`) : (run.summary ?? 'done');
  return `Ran ${when}: ${found}`;
}

/** What the card's buttons are, in order, for a routine's state. @param {Pick<RoutineCard, 'status' | 'running'>} routine */
export function cardActions(routine) {
  if (routine.status === 'archived') return [{ id: 'restore', label: 'Restore' }];
  const base = [
    { id: 'run', label: 'Run now', disabled: !!routine.running || routine.status !== 'active' },
    routine.status === 'paused' ? { id: 'resume', label: 'Resume' } : { id: 'pause', label: 'Pause' },
    { id: 'edit', label: 'Edit' },
    { id: 'archive', label: 'Archive' },
  ];
  return base;
}

/** The honest limit, shown under the list. */
export const LIMIT_LINE = 'Routines run while the Second Brain server or Zotero is running. Missed runs catch up once.';

/**
 * The three starter cards (invented examples). Each is a draft for the create sheet; nothing is saved until the
 * user confirms.
 * @type {{ id: string, title: string, blurb: string, draft: RoutineTemplateDraft }[]}
 */
export const TEMPLATES = [
  {
    id: 'preprint-digest',
    title: 'Daily preprint digest',
    blurb: 'Every morning, new preprints on a topic you choose.',
    draft: {
      name: 'Daily preprint digest',
      prompt: 'Find preprints from the last day on this topic: <your topic>. Prefer studies with data, and say in one line why each one matters.',
      skills: [], depth: 'quick', schedule: at({ kind: 'daily' }, '07:30'), target: { kind: 'session' },
    },
  },
  {
    id: 'weekly-watch',
    title: 'Weekly new-papers watch',
    blurb: 'Once a week, new papers by an author or on a subject.',
    draft: {
      name: 'Weekly new-papers watch',
      prompt: 'Find new papers this week by <author name> or about <subject>. Skip anything already in the library.',
      skills: [], depth: 'standard', schedule: at({ kind: 'some', weekdays: [1] }, '08:00'), target: { kind: 'session' },
    },
  },
  {
    id: 'citation-watch',
    title: 'Citation watch for one paper',
    blurb: 'Weekly, papers that newly cite a paper you care about.',
    draft: {
      name: 'Citation watch',
      prompt: 'Find new papers that cite <paper title or DOI>. Note whether each one supports, extends or disputes it.',
      skills: [], depth: 'standard', schedule: at({ kind: 'some', weekdays: [5] }, '17:00'), target: { kind: 'session' },
    },
  },
];

/** A fresh copy of a template's draft, safe to edit. @param {string} id @returns {RoutineTemplateDraft | null} */
export function draftFromTemplate(id) {
  const hit = TEMPLATES.find((t) => t.id === id);
  return hit ? JSON.parse(JSON.stringify(hit.draft)) : null;
}

/**
 * Prefill for "Create routine for this" on a papers result: the routine keeps that table up to date.
 * @param {{ session: string, result: string, title?: string }} from @returns {Omit<RoutineTemplateDraft, 'target'> & { target: RoutineCard['target'] }}
 */
export function draftForArtifact(from) {
  const topic = (from.title ?? '').trim();
  return {
    name: topic ? `Watch: ${topic}`.slice(0, 80) : 'Watch for new papers',
    prompt: topic ? `Find new papers that belong in this table: ${topic}.` : 'Find new papers that belong in this table.',
    skills: [], depth: 'standard', schedule: at({ kind: 'daily' }, '07:30'),
    target: { kind: 'artifact', session: from.session, result: { id: from.result } },
  };
}

/** Empty-state text for a tab. @param {'active' | 'paused' | 'archived'} tab */
export function emptyText(tab) {
  if (tab === 'paused') return 'Nothing is paused.';
  if (tab === 'archived') return 'Nothing is archived.';
  return 'No routines yet. Start from one of these, or write your own.';
}

/**
 * The depth control's label: "Balanced · about 9-18 turns". The engine sends `range` ("9-18") and the older `turns`; the
 * range is what the live check showed is honest.
 * @param {string} name @param {{ range?: string, turns?: number } | null | undefined} estimate
 */
export function estimateText(name, estimate) {
  const about = estimate?.range ?? estimate?.turns;
  return about === undefined || about === null ? name : `${name} · about ${about} turns`;
}

/** Why a schedule cannot be saved, in the engine's words, or null. @param {unknown} schedule */
export function scheduleProblem(schedule) {
  try { validSchedule(schedule); return null; } catch (error) { return String(/** @type {any} */ (error)?.message ?? error); }
}

/** What the create/edit sheet is missing, in the user's words, or null when it can be saved.
 *  @param {{ name?: string, prompt?: string, schedule?: unknown }} fields */
export function sheetProblem(fields) {
  if (!(fields.name ?? '').trim()) return 'Give the routine a name.';
  if (!(fields.prompt ?? '').trim()) return 'Say what the routine should look for.';
  const problem = scheduleProblem(fields.schedule);
  if (problem) return problem;
  return null;
}

/**
 * Rows a version added (a routine's "new" rows), for the table's highlight. Only the version shown counts, so an
 * older or later version has its own set.
 * @param {any} result @returns {Set<string>}
 */
export function addedRowSet(result) {
  return new Set(Array.isArray(result?.addedRows) ? result.addedRows : []);
}

/** The service's refusal of Run now, in words. @param {{ started: boolean, reason?: string }} out */
export function runNowLine(out) {
  return out.started ? 'Started. The result appears when it finishes.' : (out.reason ?? 'It could not start.');
}

/** The badge on a history row or card: "3 new". Nothing when a chat has no news. @param {{ papers?: number } | null | undefined} news */
export function newsLabel(news) {
  const n = Number(news?.papers) || 0;
  return n > 0 ? `${n} new` : '';
}

/** The badge's tooltip. @param {{ papers?: number } | null | undefined} news */
export function newsTitle(news) {
  const n = Number(news?.papers) || 0;
  return n > 0 ? `${n} new ${n === 1 ? 'paper' : 'papers'} from a routine` : '';
}

/**
 * The session a card's "Ran ...: N new papers" line should open, or null. It needs a finished run that added papers
 * and a session that still has unseen news; once the user has opened that session the line is plain text again.
 * @param {{ lastRun?: { status?: string, added?: number, session?: string } | null, target?: { kind: string, session?: string } }} routine
 * @param {(id: string) => unknown} hasNews whether a session still has unseen routine news
 * @returns {string | null}
 */
export function newsSession(routine, hasNews) {
  const run = routine.lastRun;
  if (!run || run.status !== 'done' || !(Number(run.added) > 0)) return null;
  const id = run.session ?? (routine.target?.kind === 'artifact' ? routine.target.session : undefined);
  return id && hasNews(id) ? id : null;
}

/** The muted card line "In Voles", or '' when the routine has no project (or its project is gone).
 *  @param {{ project?: string | null }} routine @param {{ id: string, name: string }[]} projects */
export function projectLine(routine, projects) {
  const hit = routine.project ? (projects ?? []).find((p) => p.id === routine.project) : null;
  return hit ? `In ${hit.name}` : '';
}

/**
 * The sheet's Project choices: None, then every project. `selected` is the routine's own project when it still exists,
 * else the open project for a new routine, else none. Empty when there is nothing to choose (no projects), so the
 * sheet hides the field.
 * @param {{ id: string, name: string }[]} projects @param {string | null | undefined} own @param {string | null | undefined} open
 * @param {boolean} isNew
 * @returns {{ options: { id: string, label: string }[], selected: string }}
 */
export function projectChoices(projects, own, open, isNew) {
  const list = projects ?? [];
  if (!list.length) return { options: [], selected: '' };
  const exists = (/** @type {string | null | undefined} */ id) => (id && list.some((p) => p.id === id) ? id : '');
  const selected = isNew && !own ? exists(open) : exists(own);
  return { options: [{ id: '', label: 'None' }, ...list.map((p) => ({ id: p.id, label: p.name }))], selected };
}

// ---- the sheet's "When" row ----

export const DAY_KINDS = /** @type {const} */ ([['daily', 'Every day'], ['weekdays', 'Weekdays'], ['some', 'Pick days'], ['every', 'Every N days'], ['monthly', 'Monthly']]);
/** Monday first, the order a week reads in a picker: [weekday number, short label]. */
export const PICK_DAYS = /** @type {[number, string][]} */ ([[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']]);

/**
 * What the sheet edits: every control's value, kept even while another days/times kind is chosen, so switching back loses nothing.
 * @typedef {{ days: 'daily' | 'weekdays' | 'some' | 'every' | 'monthly', weekdays: number[], n: number, from: string, day: number,
 *   mode: 'at' | 'hourly', times: string[], every: number, hFrom: string, hTo: string }} When
 */

/** @param {number} ms YYYY-MM-DD in local time */
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The When row for a schedule (or a new routine's default: daily at 07:30). @param {Schedule | null | undefined} schedule @param {number} [now] @returns {When} */
export function whenFromSchedule(schedule, now = Date.now()) {
  /** @type {When} */
  const w = { days: 'daily', weekdays: [1], n: 2, from: localDate(now), day: 1, mode: 'at', times: ['07:30'], every: 4, hFrom: '08:00', hTo: '20:00' };
  const d = schedule?.days, t = schedule?.times;
  if (d) {
    w.days = d.kind;
    if (d.kind === 'some') w.weekdays = [...d.weekdays];
    if (d.kind === 'every') { w.n = d.n; w.from = d.from; }
    if (d.kind === 'monthly') w.day = d.day;
  }
  if (t?.kind === 'at') w.times = [...t.times];
  if (t?.kind === 'hourly') { w.mode = 'hourly'; w.every = t.every; w.hFrom = t.from; w.hTo = t.to; }
  return w;
}

/** The schedule the row describes, unvalidated (validSchedule says what is wrong with it). @param {When} w @returns {Schedule} */
export function scheduleFromWhen(w) {
  const days = w.days === 'some' ? { kind: 'some', weekdays: [...w.weekdays] }
    : w.days === 'every' ? { kind: 'every', n: w.n, from: w.from }
    : w.days === 'monthly' ? { kind: 'monthly', day: w.day }
    : { kind: w.days };
  const times = w.mode === 'hourly' ? { kind: 'hourly', every: w.every, from: w.hFrom, to: w.hTo } : { kind: 'at', times: [...w.times] };
  return /** @type {Schedule} */ (/** @type {unknown} */ ({ days, times }));
}

/** A time to add next to the ones already there: an hour after the latest, or 07:30 when there are none. @param {string[]} times */
export function nextFreeTime(times) {
  if (!times.length) return '07:30';
  const last = times.reduce((a, b) => (a > b ? a : b));
  const hour = Math.min(23, Number(last.slice(0, 2)) + 1);
  const free = (/** @type {number} */ h) => !times.includes(`${String(h).padStart(2, '0')}:${last.slice(3)}`);
  for (let h = hour; h < 24; h++) if (free(h)) return `${String(h).padStart(2, '0')}:${last.slice(3)}`;
  for (let h = 0; h < hour; h++) if (free(h)) return `${String(h).padStart(2, '0')}:${last.slice(3)}`;
  return '07:30';
}

const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** "today 18:30", "tomorrow 07:00", "Mon 07:00", "Jun 3 07:00". @param {number} ms @param {number} now */
function whenLabel(ms, now, withDay = true) {
  const time = hhmm(new Date(ms));
  if (!withDay) return time;
  const gap = Math.round((dayStart(ms) - dayStart(now)) / 86_400_000);
  if (gap === 0) return `today ${time}`;
  if (gap === 1) return `tomorrow ${time}`;
  if (gap < 7) return `${SHORT[new Date(ms).getDay()]} ${time}`;
  const d = new Date(ms);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()} ${time}`;
}

/**
 * The line under the When row: "Next: today 18:30, then Mon 07:00". Uses the engine's nextRun. Empty when the schedule
 * is not valid yet (the sheet shows the problem instead).
 * @param {unknown} schedule @param {number} [now]
 */
export function previewText(schedule, now = Date.now()) {
  try {
    const valid = validSchedule(schedule);
    const first = nextRun(valid, now);
    const second = nextRun(valid, first);
    return `Next: ${whenLabel(first, now)}, then ${whenLabel(second, now, dayStart(second) !== dayStart(first))}`;
  } catch { return ''; }
}
