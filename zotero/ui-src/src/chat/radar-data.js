// @ts-check
// ui-src/src/chat/radar-data.js. Spec 012 R2: the pure model and wording of the Reading radar setup sheet. The form,
// its defaults, the lines under each source, what to say about a pasted address, and the routine draft it saves as.
// No DOM, so node tests run it. The engine owns validation (agent-src/src/radar.js validateRadar); this file only keeps
// the user from saving what it would refuse, in the user's words.

import { ago } from './steps-data.js';
import { whenFromSchedule, scheduleFromWhen, scheduleProblem } from './routines-data.js';
import { MCP_PRESETS } from '../../../agent-src/src/radar.js';

/** @typedef {import('../../../agent-src/src/radar-types').Weighted} Weighted */
/** @typedef {import('../../../agent-src/src/radar-types').Followed} Followed */
/** @typedef {import('../../../agent-src/src/radar-types').SourceCheck} SourceCheck */
/** @typedef {import('../../../agent-src/src/radar-types').JournalOption} JournalOption */
/** @typedef {import('../../../agent-src/src/radar-types').SourceStatus} SourceStatus */
/** @typedef {{ url: string, title: string, on: boolean }} FeedRow */
/** @typedef {{ openalexId: string, name: string, issn: string | null, on: boolean }} JournalRow */
/** @typedef {{ server: string, tool: string, label: string, args?: Record<string, unknown>, on: boolean }} McpRow */
/**
 * @typedef {{
 *   name: string, scope: { kind: 'library' } | { kind: 'collections', keys: string[] }, project: string | null,
 *   profile: { topics: Weighted[], authors: Followed[], journals: Followed[] },
 *   databases: Record<string, boolean>, feeds: FeedRow[], journals: JournalRow[], mcp: McpRow[],
 *   size: { fresh: number, older: number, discover: number }, sizeTouched: boolean,
 *   when: import('./routines-data.js').When, note: boolean,
 *   seeds?: import('../../../agent-src/src/radar-types').RadarSeeds | null,
 *   threshold?: import('../../../agent-src/src/radar-types').RadarThreshold | null,
 * }} RadarForm
 */

export const DATABASES = /** @type {const} */ ([
  ['arxiv', 'arXiv'], ['chemrxiv', 'chemRxiv'], ['openalex', 'OpenAlex'], ['biorxiv', 'bioRxiv and medRxiv'],
  ['crossref', 'Crossref'], ['semanticscholar', 'Semantic Scholar'], ['europepmc', 'Europe PMC'],
]);
const DEFAULT_ON = ['arxiv', 'chemrxiv', 'openalex'];

/** Spec 012 decision: 8 new + 1 older for a daily radar, 15 + 5 for a weekly one. */
export const SIZE_DEFAULTS = Object.freeze({ daily: Object.freeze({ fresh: 8, older: 1, discover: 3 }), weekly: Object.freeze({ fresh: 15, older: 5, discover: 3 }) });

/** The Routines starter card that opens the setup sheet. Only a host on the library server shows it: the radar scores on its embeddings. */
export const RADAR_CARD = Object.freeze({ id: 'reading-radar', title: 'Reading radar', blurb: 'Each morning, new papers in your field and older ones worth reading, picked from your library.' });

/** Whether the radar can be set up here. @param {'server' | 'local' | 'offline'} where */
export const radarAvailable = (where) => where === 'server';

export const BLOCKED_OFFER = 'Add the journal by name';

/** A radar that runs about once a week or less gets the weekly size. @param {unknown} schedule */
export function sizeDefaults(schedule) {
  const days = /** @type {any} */ (schedule)?.days;
  const weekly = days?.kind === 'monthly' || (days?.kind === 'some' && days.weekdays.length <= 1) || (days?.kind === 'every' && days.n >= 7);
  return weekly ? SIZE_DEFAULTS.weekly : SIZE_DEFAULTS.daily;
}

/** A new radar's form: daily at 07:00, the three default databases, the daily size. @param {{ scope?: RadarForm['scope'], project?: string | null, now?: number }} [opts] @returns {RadarForm} */
export function newForm({ scope, project, now } = {}) {
  const when = whenFromSchedule(null, now);
  when.times = ['07:00'];
  return {
    name: 'Reading radar', scope: scope ?? { kind: 'library' }, project: project ?? null,
    profile: { topics: [], authors: [], journals: [] },
    databases: Object.fromEntries(DATABASES.map(([id]) => [id, DEFAULT_ON.includes(id)])),
    feeds: [], journals: [], mcp: [], size: { ...SIZE_DEFAULTS.daily }, sizeTouched: false, when, note: true,
    seeds: null, threshold: null,
  };
}

/** Spec radar-seeds D4: a radar that starts from seed papers shows up to 15 a day. */
export const SEED_FRESH = 15;

/** The form for an existing radar routine. Authors and journals the profile already follows are not listed twice as sources. @param {any} routine @returns {RadarForm} */
export function formFromRoutine(routine) {
  const radar = routine.radar ?? {};
  const form = newForm({ scope: radar.scope?.kind === 'collections' ? radar.scope : { kind: 'library' }, project: routine.project ?? null });
  const profile = radar.profile ?? {};
  const followed = (/** @type {Followed[] | undefined} */ list) => (list ?? []).map((f) => ({ ...f }));
  form.name = routine.name ?? form.name;
  form.profile = { topics: (profile.topics ?? []).map((/** @type {Weighted} */ t) => ({ ...t })), authors: followed(profile.authors), journals: followed(profile.journals) };
  form.when = whenFromSchedule(routine.schedule);
  form.size = { fresh: radar.size?.fresh ?? 8, older: radar.size?.older ?? 1, discover: radar.size?.discover ?? 3 };
  form.sizeTouched = true;
  form.note = radar.note !== false;
  form.seeds = radar.seeds ? structuredClone(radar.seeds) : null;
  form.threshold = radar.threshold ? structuredClone(radar.threshold) : null;
  form.databases = Object.fromEntries(DATABASES.map(([id]) => [id, false]));
  const covered = new Set([...form.profile.authors, ...form.profile.journals].map((f) => f.openalexId).filter(Boolean));
  for (const s of radar.sources ?? []) {
    if (s.kind === 'database') form.databases[s.db] = s.on;
    else if (s.kind === 'feed') form.feeds.push({ url: s.url, title: s.title, on: s.on });
    else if (s.kind === 'journal' && !covered.has(s.openalexId)) form.journals.push({ openalexId: s.openalexId, name: s.name, issn: s.issn, on: s.on });
    else if (s.kind === 'author' && !covered.has(s.openalexId)) form.profile.authors.push({ name: s.name, openalexId: s.openalexId, weight: 1, origin: 'user' });
    else if (s.kind === 'mcp') form.mcp.push({ server: s.server, tool: s.tool, label: mcpLabel(s), ...(s.args ? { args: s.args } : {}), on: s.on });
  }
  return form;
}

/** @param {{ server: string, tool: string }} s */
const mcpLabel = (s) => (s.server === MCP_PRESETS.huggingface.server && s.tool === MCP_PRESETS.huggingface.tool ? 'Hugging Face papers' : `${s.server}: ${s.tool}`);

/**
 * The profile the library suggests, folded into what the user already has: items the user added or the radar learned stay,
 * seeded ones are replaced by the new suggestion (the same person is not listed twice).
 * @param {RadarForm['profile']} have @param {RadarForm['profile']} seeded @returns {RadarForm['profile']}
 */
export function mergeSeed(have, seeded) {
  const keep = (/** @type {any[]} */ list) => list.filter((x) => x.origin !== 'seed');
  const key = (/** @type {{ text?: string, name?: string }} */ x) => (x.text ?? x.name ?? '').toLowerCase();
  const fold = (/** @type {any[]} */ mine, /** @type {any[]} */ fresh) => {
    const own = keep(mine);
    const taken = new Set(own.map(key));
    return [...own, ...fresh.filter((x) => !taken.has(key(x)))];
  };
  return { topics: fold(have.topics, seeded.topics), authors: fold(have.authors, seeded.authors), journals: fold(have.journals, seeded.journals) };
}

/** A new line in a profile list: trimmed, no empty, no repeat (ignoring case). Returns the list and whether it changed.
 *  @template {{ text?: string, name?: string }} T @param {T[]} list @param {'text' | 'name'} field @param {string} value */
export function addEntry(list, field, value) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || list.some((x) => (x[field] ?? '').toLowerCase() === text.toLowerCase())) return { list, added: false };
  const entry = field === 'text' ? { text, weight: 1, origin: 'user' } : { name: text, openalexId: null, weight: 1, origin: 'user' };
  return { list: [...list, /** @type {any} */ (entry)], added: true };
}

/** @template T @param {T[]} list @param {number} index @returns {T[]} */
export const removeAt = (list, index) => list.filter((_, i) => i !== index);

/** The muted line under a person or journal that OpenAlex matched, or says nothing matched. @param {Followed} f */
export function matchLine(f) {
  if (f.match) return f.match;
  return f.openalexId ? 'Matched in OpenAlex' : f.origin === 'seed' ? 'No match in OpenAlex, so it will not be followed' : 'Not matched in OpenAlex yet';
}

/** Dismissals in a row that make the radar suggest dropping a source (the engine's DISMISS_STREAK). */
const SUGGEST_AFTER = 3;

/** What a source last answered: "Fetched 2 hours ago, 14 papers", "Failed 2 hours ago: HTTP 403", or '' before its first run.
 *  @param {SourceStatus | undefined} status @param {number} [now] */
export function statusLine(status, now = Date.now()) {
  if (!status) return '';
  const when = ago(status.at, now);
  if (status.error) return `Failed ${when}: ${status.error}`;
  const n = status.items;
  const found = n === 0 ? 'nothing new' : `${n} ${n === 1 ? 'paper' : 'papers'}`;
  return `Fetched ${when}, ${found}${status.suggestRemove ? `. You marked the last ${SUGGEST_AFTER} papers from here as not relevant. You could remove it.` : ''}`;
}

/** What to show for what the user pasted. `kind` picks the tone; `options` are journals to add; `offer` is the "by name" link.
 *  @param {SourceCheck} check @returns {{ tone: 'ok' | 'warn' | 'error', text: string, options: JournalOption[], offer: string | null, feed: { url: string, title: string } | null }} */
export function checkNotice(check) {
  switch (check.kind) {
    case 'feed': return { tone: 'ok', text: `${check.title}: a feed with ${check.items} ${check.items === 1 ? 'item' : 'items'}.`, options: [], offer: null, feed: { url: check.url, title: check.title } };
    case 'journal': return { tone: 'ok', text: check.match, options: [check], offer: null, feed: null };
    case 'journals': return { tone: 'ok', text: 'Which journal?', options: check.options, offer: null, feed: null };
    case 'feed-blocked': return {
      tone: 'warn', offer: BLOCKED_OFFER, feed: null, options: check.journals,
      text: `${check.reason} The radar can still follow the journal itself.${check.journals.length ? '' : ' Type its name or ISSN.'}`,
    };
    default: return { tone: 'error', text: check.message, options: [], offer: null, feed: null };
  }
}

/** @param {RadarForm} form @param {{ url: string, title: string }} feed Adds a feed once; returns whether it was new. */
export function addFeed(form, feed) {
  if (form.feeds.some((f) => f.url === feed.url)) return false;
  form.feeds.push({ url: feed.url, title: feed.title, on: true });
  return true;
}

/** Adds a journal to the sources once (also when the profile already follows it). @param {RadarForm} form @param {JournalOption} journal */
export function addJournal(form, journal) {
  if (form.journals.some((j) => j.openalexId === journal.openalexId) || form.profile.journals.some((j) => j.openalexId === journal.openalexId)) return false;
  form.journals.push({ openalexId: journal.openalexId, name: journal.name, issn: journal.issn, on: true });
  return true;
}

/**
 * The MCP tools worth offering from the connected servers: the Hugging Face preset when that server is connected, then any
 * tool that says it searches papers. Nothing is on until the user ticks it.
 * @param {{ config: { name: string }, state: string, tools: { name: string, description: string }[] }[]} reports @returns {McpRow[]}
 */
export function mcpChoices(reports) {
  const rows = [];
  const preset = MCP_PRESETS.huggingface;
  for (const r of reports ?? []) {
    if (r.state !== 'connected') continue;
    const name = r.config.name;
    if (name === preset.server && r.tools.some((t) => t.name === preset.tool)) rows.push({ server: name, tool: preset.tool, label: 'Hugging Face papers', args: /** @type {Record<string, unknown>} */ (JSON.parse(JSON.stringify(preset.args))), on: false });
    for (const t of r.tools) {
      if (name === preset.server && t.name === preset.tool) continue;
      if (/paper|scholar|arxiv|pubmed|literature|citation/i.test(`${t.name} ${t.description}`)) rows.push({ server: name, tool: t.name, label: `${name}: ${t.name}`, on: false });
    }
  }
  return rows;
}

/** The choices with the ones the radar already uses ticked, and any it uses that are no longer connected kept (so saving does not drop them). @param {McpRow[]} choices @param {McpRow[]} used */
export function mergeMcp(choices, used) {
  const key = (/** @type {McpRow} */ r) => `${r.server}/${r.tool}`;
  const have = new Map(used.map((r) => [key(r), r]));
  const out = choices.map((c) => (have.has(key(c)) ? { ...c, on: have.get(key(c))?.on ?? false } : c));
  for (const u of used) if (!choices.some((c) => key(c) === key(u))) out.push(u);
  return out;
}

/** What the form is missing, in the user's words, or null when it can be saved. @param {RadarForm} form */
export function radarProblem(form) {
  if (!form.name.trim()) return 'Give the radar a name.';
  if (form.scope.kind === 'collections' && !form.scope.keys.length) return 'Pick at least one collection, or look at the whole library.';
  // A radar that starts from seed papers needs no topics (spec 021); one without seeds still does.
  if (form.seeds && seedCount(form.seeds) < 3 && !form.seeds.collections.length) return 'Pick at least 3 papers for the radar to start from.';
  if (!form.seeds && !form.profile.topics.length) return 'Add at least one topic to look for.';
  const sources = sourcesOf(form);
  if (!sources.some((s) => s.on)) return 'Turn on at least one place to look.';
  const { fresh, older, discover } = form.size;
  if (!Number.isInteger(fresh) || fresh < 1 || fresh > 50) return 'Show between 1 and 50 new papers.';
  if (!Number.isInteger(older) || older < 0 || older > 20) return 'Show between 0 and 20 older papers.';
  if (!Number.isInteger(discover) || discover < 0 || discover > 10) return 'Show between 0 and 10 papers that might interest you.';
  return scheduleProblem(scheduleFromWhen(form.when));
}

/** Every source the form describes, in engine shape: the ticked databases, feeds, journals, MCP tools, and the authors and journals the profile follows (only those OpenAlex matched).
 *  @param {RadarForm} form */
export function sourcesOf(form) {
  /** @type {Map<string, any>} */
  const out = new Map();
  const put = (/** @type {any} */ s) => { if (!out.has(s.id)) out.set(s.id, s); };
  for (const [id] of DATABASES) put({ id: `database:${id}`, on: Boolean(form.databases[id]), kind: 'database', db: id });
  for (const f of form.feeds) put({ id: `feed:${f.url}`, on: f.on, kind: 'feed', url: f.url, title: f.title });
  for (const j of form.journals) put({ id: `journal:${j.openalexId}`, on: j.on, kind: 'journal', openalexId: j.openalexId, name: j.name, issn: j.issn });
  for (const m of form.mcp) put({ id: `mcp:${m.server}/${m.tool}`, on: m.on, kind: 'mcp', server: m.server, tool: m.tool, ...(m.args ? { args: m.args } : {}) });
  for (const a of form.profile.authors) if (a.openalexId) put({ id: `author:${a.openalexId}`, on: true, kind: 'author', openalexId: a.openalexId, name: a.name });
  for (const j of form.profile.journals) if (j.openalexId) put({ id: `journal:${j.openalexId}`, on: true, kind: 'journal', openalexId: j.openalexId, name: j.name, issn: null });
  return [...out.values()];
}

/** The routine draft the sheet saves. @param {RadarForm} form */
export function draftFromForm(form) {
  const scope = form.scope;
  return {
    name: form.name.trim(), kind: /** @type {const} */ ('radar'), schedule: scheduleFromWhen(form.when), target: { kind: /** @type {const} */ ('session') }, scope,
    ...(form.project ? { project: form.project } : {}),
    radar: { scope, profile: form.profile, sources: sourcesOf(form), size: form.seeds && !form.sizeTouched ? { ...form.size, fresh: SEED_FRESH } : { ...form.size }, note: form.note,
      ...(form.seeds ? { seeds: form.seeds } : {}), ...(form.threshold ? { threshold: form.threshold } : {}) },
  };
}

/** Seed papers the radar can compare with: your papers in the library or with an abstract, and the library papers picked.
 *  @param {import('../../../agent-src/src/radar-types').RadarSeeds} seeds */
export function seedCount(seeds) {
  return new Set([...seeds.mine.filter((m) => m.key || m.abstract).map((m) => m.key ?? `t:${m.title}`), ...seeds.papers]).size;
}

/** The entries the radar learned for one profile row, newest last. `kind` is the list the row is in. @param {{ kind: 'author' | 'venue', name: string, paper: string, title: string }[]} learned @param {'authors' | 'journals'} list @param {string} name */
export function learnedFor(learned, list, name) {
  const kind = list === 'authors' ? 'author' : 'venue';
  const same = (/** @type {string} */ s) => s.trim().toLowerCase();
  return (learned ?? []).filter((l) => l.kind === kind && same(l.name) === same(name));
}

/** After an undo the server's author and journal lists win, but a row the user added here and has not saved stays. @param {Followed[]} server @param {Followed[]} local */
export function afterUnlearn(server, local) {
  const names = new Set(server.map((f) => f.name.trim().toLowerCase()));
  return [...server, ...local.filter((f) => f.origin !== 'learned' && !names.has(f.name.trim().toLowerCase()))];
}

/** Liked papers a phrase needs before it is searched; the engine's LEARN_AFTER (agent-src/src/radar-phrases.js). */
export const LEARN_AFTER = 3;

/** What a learned topic's chip says on hover or tap: "from 3 papers you kept". @param {Weighted} topic */
export function learnedNote(topic) {
  const n = topic.papers ?? 0;
  return n ? `from ${n} ${n === 1 ? 'paper' : 'papers'} you kept` : 'learned from your ratings';
}

/** One "Learning…" line: "moiré excitons, 2 of 3". @param {{ text: string, count: number }} phrase */
export const learningText = (phrase) => `${phrase.text}, ${phrase.count} of ${LEARN_AFTER}`;

/** The phrases a routine view lists as still being learned (two papers so far), most first. @param {any} routine @returns {{ text: string, count: number }[]} */
export const learningOf = (routine) => (Array.isArray(routine?.radarLearning) ? routine.radarLearning.filter((/** @type {any} */ l) => l && l.text && l.count < LEARN_AFTER) : []);
