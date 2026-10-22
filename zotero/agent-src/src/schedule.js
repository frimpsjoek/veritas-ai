// @ts-check
// agent-src/src/schedule.js. Spec 012 slice 0: the routine Schedule -- its shape, validation, migration from the
// spec 011 shapes, and the slot math (nextRun / dueSlot). Pure: no fs, no clock, no network. The UI bundle imports
// this file too, so the "Next: ..." preview is the engine's own answer.
//
// All times are LOCAL. Occurrences are built with `new Date(y, mo, d, h, m)`: a time that does not exist (spring
// forward, 02:30) rolls forward (03:30); a time that happens twice (fall back, 01:30) takes the first occurrence.
// Two wall-clock times that land on the same instant collapse to one occurrence.

/** @typedef {0 | 1 | 2 | 3 | 4 | 5 | 6} Weekday 0 = Sunday */
/** @typedef {{ kind: 'daily' }
 *   | { kind: 'weekdays' }
 *   | { kind: 'some', weekdays: Weekday[] }
 *   | { kind: 'every', n: number, from: string }
 *   | { kind: 'monthly', day: number }} Days  every: N days (2-30) from a YYYY-MM-DD date; monthly: day 1-31 (a short month uses its last day) or -1 = last day */
/** @typedef {{ kind: 'at', times: string[] } | { kind: 'hourly', every: number, from: string, to: string }} Times  at: 1-6 "HH:MM"; hourly: every N hours (1-12) from "HH:MM" to "HH:MM" inclusive */
/** @typedef {{ days: Days, times: Times }} Schedule */

export const MAX_TIMES = 6;
const MIN_GAP_MINUTES = 60;
const HORIZON_DAYS = 400;

/** "07:30" or "7:30" -> { h: 7, m: 30 }. Throws on anything else. @param {string} time */
export function parseTime(time) {
  const hit = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
  const h = hit ? Number(hit[1]) : NaN;
  const m = hit ? Number(hit[2]) : NaN;
  if (!hit || h > 23 || m > 59) throw new Error(`"${time}" is not a time of day (use HH:MM, 00:00 to 23:59).`);
  return { h, m };
}

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const minutesOf = (/** @type {string} */ time) => { const { h, m } = parseTime(time); return h * 60 + m; };
const clock = (/** @type {number} */ minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** @param {string} date YYYY-MM-DD -> UTC day number, or throws */
function dayNumber(date) {
  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  const t = hit ? Date.UTC(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3])) : NaN;
  if (!hit || !Number.isFinite(t) || new Date(t).getUTCDate() !== Number(hit[3])) throw new Error(`"${date}" is not a date (use YYYY-MM-DD).`);
  return Math.round(t / 86_400_000);
}
const dayNumberOf = (/** @type {Date} */ d) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);

/** The wall-clock minutes-of-day a Times value stands for, sorted and unique. @param {Times} times @returns {number[]} */
export function minutesList(times) {
  if (times.kind === 'at') return [...new Set(times.times.map(minutesOf))].sort((a, b) => a - b);
  const out = [];
  for (let at = minutesOf(times.from); at <= minutesOf(times.to); at += times.every * 60) out.push(at);
  return out;
}

/** @param {Days} days @param {Date} day */
function runsOn(days, day) {
  switch (days.kind) {
    case 'daily': return true;
    case 'weekdays': return day.getDay() >= 1 && day.getDay() <= 5;
    case 'some': return days.weekdays.includes(/** @type {Weekday} */ (day.getDay()));
    case 'every': { const gap = dayNumberOf(day) - dayNumber(days.from); return gap >= 0 && gap % days.n === 0; }
    case 'monthly': {
      const last = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
      return day.getDate() === (days.day === -1 ? last : Math.min(days.day, last));
    }
  }
}

/** The occurrences (ms, ascending) on the calendar day `base` + `offset`, empty when the schedule skips that day.
 *  @param {any} schedule @param {number[]} minutes @param {Date} base @param {number} offset @returns {number[]} */
function occurrencesOn(schedule, minutes, base, offset) {
  const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
  if (!runsOn(schedule.days, day)) return [];
  const at = minutes.map((/** @type {number} */ m) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60, 0, 0).getTime());
  return [...new Set(at)].sort((a, b) => a - b);
}

/**
 * The first occurrence strictly after `fromMs`.
 * @param {Schedule} schedule @param {number} fromMs @returns {number} ms since epoch
 */
export function nextRun(schedule, fromMs) {
  schedule = migrateSchedule(schedule);
  const minutes = minutesList(schedule.times);
  const base = new Date(fromMs);
  // An "every N days" schedule that starts in the future begins on its start date: jump there instead of scanning.
  const start = schedule.days.kind === 'every' ? Math.max(0, dayNumber(schedule.days.from) - dayNumberOf(base)) : 0;
  for (let i = Math.max(0, start - 1); i <= start + HORIZON_DAYS; i++) {
    for (const at of occurrencesOn(schedule, minutes, base, i)) if (at > fromMs) return at;
  }
  throw new Error('No next run found for this schedule.');
}

/**
 * The latest occurrence at or before `nowMs`, or null when there is none yet (an "every N days" schedule that has not
 * reached its start date).
 * @param {Schedule} schedule @param {number} nowMs @returns {number | null} ms since epoch
 */
export function dueSlot(schedule, nowMs) {
  schedule = migrateSchedule(schedule);
  const minutes = minutesList(schedule.times);
  const base = new Date(nowMs);
  for (let i = 0; i >= -HORIZON_DAYS; i--) {
    const at = occurrencesOn(schedule, minutes, base, i);
    for (let k = at.length - 1; k >= 0; k--) if (at[k] <= nowMs) return at[k];
  }
  return null;
}

/** Can two days in a row both run? Then the last time of one day and the first of the next are neighbours. @param {Days} days */
function hasConsecutiveDays(days) {
  if (days.kind === 'daily' || days.kind === 'weekdays') return true;
  if (days.kind === 'some') return days.weekdays.some((d) => days.weekdays.includes(/** @type {Weekday} */ ((d + 1) % 7)));
  return false;
}

/** @param {any} n @param {number} lo @param {number} hi @param {string} what */
function intIn(n, lo, hi, what) {
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${what} must be a whole number from ${lo} to ${hi}.`);
  return n;
}

/** @param {any} d @returns {Days} */
function validDays(d) {
  if (!d || typeof d !== 'object') throw new Error('Choose which days the routine runs.');
  switch (d.kind) {
    case 'daily': return { kind: 'daily' };
    case 'weekdays': return { kind: 'weekdays' };
    case 'some': {
      if (!Array.isArray(d.weekdays)) throw new Error('Choose a day of the week (0 = Sunday to 6 = Saturday).');
      const set = [...new Set(d.weekdays.map((/** @type {unknown} */ w) => intIn(w, 0, 6, 'A day of the week')))].sort((a, b) => a - b);
      if (!set.length) throw new Error('Choose at least one day of the week.');
      return { kind: 'some', weekdays: /** @type {Weekday[]} */ (set) };
    }
    case 'every': {
      dayNumber(d.from);
      return { kind: 'every', n: intIn(d.n, 2, 30, 'Days between runs'), from: d.from };
    }
    case 'monthly': {
      if (d.day !== -1) intIn(d.day, 1, 31, 'The day of the month');
      return { kind: 'monthly', day: d.day };
    }
  }
  throw new Error('Choose every day, weekdays, some days, every few days or monthly.');
}

/** @param {any} t @param {Days} days @returns {Times} */
function validTimes(t, days) {
  if (!t || typeof t !== 'object') throw new Error('Choose when in the day the routine runs.');
  /** @type {Times} */
  let out;
  if (t.kind === 'at') {
    if (!Array.isArray(t.times) || !t.times.length) throw new Error('Add at least one time of day.');
    const list = [...new Set(t.times.map((/** @type {string} */ x) => clock(minutesOf(x))))].sort();
    if (list.length > MAX_TIMES) throw new Error(`A routine can run at up to ${MAX_TIMES} times a day.`);
    out = { kind: 'at', times: list };
  } else if (t.kind === 'hourly') {
    const every = intIn(t.every, 1, 12, 'Hours between runs');
    const from = clock(minutesOf(t.from)), to = clock(minutesOf(t.to));
    if (minutesOf(from) > minutesOf(to)) throw new Error('The window must end after it starts.');
    out = { kind: 'hourly', every, from, to };
  } else {
    throw new Error('Choose set times or every few hours.');
  }
  const mins = minutesList(out);
  for (let i = 1; i < mins.length; i++) if (mins[i] - mins[i - 1] < MIN_GAP_MINUTES) throw new Error('A routine cannot run more than once an hour.');
  if (mins.length > 1 && hasConsecutiveDays(days) && mins[0] + 1440 - mins[mins.length - 1] < MIN_GAP_MINUTES) throw new Error('A routine cannot run more than once an hour.');
  return out;
}

/**
 * Reads a spec 011 schedule (`{kind:'daily', time}` / `{kind:'weekly', weekday, time}`) as the current shape. A schedule
 * already in the current shape comes back unchanged.
 * @param {any} s @returns {any}
 */
export function migrateSchedule(s) {
  if (s && typeof s === 'object' && !s.days && s.time !== undefined) {
    if (s.kind === 'daily') return { days: { kind: 'daily' }, times: { kind: 'at', times: [s.time] } };
    if (s.kind === 'weekly') return { days: { kind: 'some', weekdays: [s.weekday] }, times: { kind: 'at', times: [s.time] } };
  }
  return s;
}

/** True for a schedule still in the spec 011 shape. @param {any} s */
export const isLegacySchedule = (s) => !!s && typeof s === 'object' && !s.days && s.time !== undefined && (s.kind === 'daily' || s.kind === 'weekly');

/** Checks a schedule (either shape) and returns it canonical: sorted, deduplicated, "HH:MM". Throws a plain message. @param {unknown} schedule @returns {Schedule} */
export function validSchedule(schedule) {
  const s = migrateSchedule(schedule);
  if (!s || typeof s !== 'object') throw new Error('Choose when the routine runs.');
  const days = validDays(s.days);
  return { days, times: validTimes(s.times, days) };
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** 1 -> "1st", 22 -> "22nd", 13 -> "13th". @param {number} n */
export const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`;

/** "Every day", "Weekdays", "Monday, Wednesday and Friday", "Every 3 days", "The 1st of each month". @param {Days} days */
export function daysText(days) {
  switch (days.kind) {
    case 'daily': return 'Every day';
    case 'weekdays': return 'Weekdays';
    case 'some': {
      const names = days.weekdays.map((d) => WEEKDAY[d]);
      if (names.length === 1) return `Every ${names[0]}`;
      return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    }
    case 'every': return `Every ${days.n} days`;
    case 'monthly': return days.day === -1 ? 'The last day of each month' : `The ${ordinal(days.day)} of each month`;
  }
}

/** "07:00 and 18:30", "07:00, 12:00 and 18:30", or "every 4 hours from 08:00 to 20:00". @param {Times} times */
export function timesText(times) {
  if (times.kind === 'hourly') return `${times.every === 1 ? 'every hour' : `every ${times.every} hours`} from ${times.from} to ${times.to}`;
  const t = times.times;
  return t.length === 1 ? t[0] : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`;
}

/** The whole schedule in plain words: "Weekdays at 07:00 and 18:30", "Every day every 4 hours from 08:00 to 20:00". @param {Schedule} schedule */
export function scheduleText(schedule) {
  schedule = migrateSchedule(schedule);
  if (!schedule?.days || !schedule?.times) return '';
  const when = schedule.times.kind === 'hourly' ? timesText(schedule.times) : `at ${timesText(schedule.times)}`;
  return `${daysText(schedule.days)} ${when}`;
}
