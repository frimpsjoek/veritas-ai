// @ts-check
// agent-src/src/review.js. The literature review as a stage table over files in reviews/<id>/.
// Resume = first stage whose output file is missing. Status is derived from the files, never stored beside them.
import { compactActivities } from './activity.js';
import { DEPTH_PRESETS, PLAN_SCHEMA, FINDINGS_SCHEMA, REPORT_SCHEMA, SKILL_REPORT_SCHEMA, leadPrompt, researcherPrompt, writerPrompt } from './prompts.js';
import { skillSection } from './skills.js';
import { screen, renderReport, skillReport } from './report.js';
import { errorMessage } from './errors.js';
import { WAIT } from './wait.js';
import { reportWebMode, clarifyStage, plan2Stage, approve2Stage, searchStage, screen2Stage, extract2Stage, synthesize2Stage, publish2Stage, countsOf, isIncluded, reviewUnclearStage, unclearList } from './review2.js';

/** @typedef {import("./domain").ReviewRequest} ReviewRequest */
/** @typedef {import("./domain").ReviewStatus} ReviewStatus */
/** @typedef {import("./domain").ReviewProgress} ReviewProgress */
/** @typedef {import("./domain").StageId} StageId */
/** @typedef {import("./domain").Plan} Plan */
/** @typedef {import("./domain").Report} Report */
/** @typedef {import("./domain").NotePath} NotePath */
/** @typedef {import("./domain").ModelChoice} ModelChoice */

/** Where a finished report goes; see service.d.ts. @typedef {import("./service").NoteSink} NoteSink */

/**
 * @typedef {object} StageCtx
 * @property {string} reviewId
 * @property {ReviewRequest} request
 * @property {(file: string) => Promise<any>} read        reads an earlier stage's output
 * @property {(file: string, value: unknown) => Promise<void>} write  atomic; a partial file never exists
 * @property {(file: string) => Promise<boolean>} has
 * @property {(file: string) => Promise<void>} remove
 * @property {import("./provider").TurnRunner} turns         role-aware: picks ModelChoice from settings, takes a slot
 * @property {(role: import("./domain").Role) => Promise<ModelChoice>} getRoleModel
 * @property {NoteSink} notes
 * @property {{ autoApprove: boolean }} settings
 * @property {{ workers: number, readText: (row: import("./domain").PaperRow, mode: "abstract" | "head" | "best") => Promise<{ text: string; from: "abstract" | "full_text" } | null> }} [extract]
 *   pipeline 2's screening and extraction: how many batches run at once and how a paper's text is read
 * @property {{ read: import("./tools").LibraryBackend["read"]; search: import("./tools").LibraryBackend["search"] }} [library]
 *   pipeline 2's search stage checks researcher-returned candidates against it; absent = nothing is checked or marked
 * @property {(dois: string[]) => Promise<Map<string, string>>} [abstractsByDoi]
 *   looks outside papers' abstracts up by DOI in the scholarly index; absent = researchers' own copies stand
 * @property {AbortSignal} signal
 * @property {() => void} [onProgress]  called after a stage finishes and after each researcher's findings file is
 *   written, so a watcher can be pushed a fresh snapshot without polling. Optional: tests may omit it.
 */

/**
 * @typedef {object} Stage
 * @property {StageId} id
 * @property {string} output        the file whose existence means "done"
 * @property {(ctx: StageCtx) => Promise<unknown | typeof WAIT>} run   returns WAIT when a human must act first
 */

export { WAIT };

/** @type {Stage[]} */
export const REVIEW_STAGES = [
  { id: 'plan', output: 'plan.json', run: planStage },
  { id: 'approve', output: 'approved-plan.json', run: approveStage },
  { id: 'research', output: 'findings.json', run: researchStage },
  { id: 'screen', output: 'screened.json', run: screenStage },
  { id: 'synthesize', output: 'report.json', run: synthesizeStage },
  { id: 'publish', output: 'note.json', run: publishStage },
];

/** spec 007 §2.1: the second stage table. Chosen by `request.pipeline`; a review with none runs `REVIEW_STAGES`.
 *  @type {Stage[]} */
export const REVIEW_STAGES_2 = [
  { id: 'clarify', output: 'clarify.json', run: clarifyStage },
  { id: 'plan', output: 'plan.json', run: plan2Stage },
  { id: 'approve', output: 'approved-plan.json', run: approve2Stage },
  { id: 'search', output: 'candidates.json', run: searchStage },
  { id: 'screen', output: 'screening.json', run: screen2Stage },
  { id: 'extract', output: 'table.json', run: extract2Stage },
  { id: 'synthesize', output: 'report.json', run: synthesize2Stage },
  { id: 'publish', output: 'note.json', run: publish2Stage },
];

/** spec 007 E8: a Systematic review is pipeline 2 with one more stage after screening, which waits only when more than
 *  10% of the candidates are unclear. @type {Stage[]} */
export const REVIEW_STAGES_SYSTEMATIC = [
  ...REVIEW_STAGES_2.slice(0, 5),
  { id: 'review', output: 'screening-reviewed.json', run: reviewUnclearStage },
  ...REVIEW_STAGES_2.slice(5),
];

/** @param {{ pipeline?: number; systematic?: boolean } | null | undefined} request */
export function stagesFor(request) {
  if (request?.pipeline !== 2) return REVIEW_STAGES;
  return request.systematic ? REVIEW_STAGES_SYSTEMATIC : REVIEW_STAGES_2;
}

/**
 * @param {StageCtx} ctx @param {import("./domain").ReviewSource[]} sources @param {string} auditSuffix
 * @returns {import("./tools").ToolContext}
 */
export function toolContextFor(ctx, sources, auditSuffix) {
  const list = Array.isArray(sources) && sources.length ? sources : ctx.request.sources;
  // "library" is the pre-005 value (an unresumed review, an old plan); it always expands to both papers and
  // notes, read at call time, so nothing on disk needs rewriting.
  const papers = list.includes('papers') || list.includes('library');
  const notes = list.includes('notes') || list.includes('library');
  return {
    scope: ctx.request.scope,
    web: list.includes('web') ? reportWebMode(ctx.request) : 'off',
    sources: { papers, notes, scholarly: list.includes('scholarly'), web: list.includes('web') },
    audit: `review:${ctx.reviewId}:${auditSuffix}`,
  };
}

/** @param {StageCtx} ctx */
async function planStage(ctx) {
  const preset = DEPTH_PRESETS[ctx.request.depth] ?? DEPTH_PRESETS.quick;
  return ctx.turns.structured('lead', leadPrompt(ctx.request, preset.subQuestions), PLAN_SCHEMA, toolContextFor(ctx, [], 'plan'), ctx.signal);
}

/** @param {StageCtx} ctx */
async function approveStage(ctx) {
  if (!ctx.settings.autoApprove) return WAIT;
  return ctx.read('plan.json');
}

/** @param {StageCtx} ctx */
async function researchStage(ctx) {
  const plan = /** @type {Plan} */ (await ctx.read('approved-plan.json'));
  const todo = [];
  for (const sq of plan.subQuestions) if (!(await ctx.has(`findings/${sq.id}.json`))) todo.push(sq);

  await Promise.allSettled(todo.map(async (sq) => {
    const tools = toolContextFor(ctx, sq.sources, sq.id);
    // FINDINGS_SCHEMA is the parser here: the provider was held to it (natively, or by openai.js's repair turn).
    const structured = /** @type {{ findings?: import("./domain").Finding[], searchLog?: import("./domain").SearchLogEntry[] }} */ (
      await ctx.turns.structured('researcher', researcherPrompt(ctx.request, sq), FINDINGS_SCHEMA, tools, ctx.signal));
    /** @type {import("./domain").Findings} */
    const findings = {
      subQuestion: sq.id,
      // inLibrary is derived here, never trusted from the model: a citekey only exists for items already in
      // Zotero, so its presence alone is what makes a source "in the library".
      findings: (structured.findings ?? []).map((f) => ({ ...f, sources: f.sources.map((s) => ({ ...s, inLibrary: Boolean(s.citekey) })) })),
      searchLog: structured.searchLog ?? [],
    };
    await ctx.write(`findings/${sq.id}.json`, findings);
    ctx.onProgress?.();
  }));

  const all = [];
  for (const sq of plan.subQuestions) {
    if (!(await ctx.has(`findings/${sq.id}.json`))) {
      if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      throw Object.assign(new Error(`the researcher for "${sq.id}" did not finish`), { kind: 'provider_crashed' });
    }
    all.push(await ctx.read(`findings/${sq.id}.json`));
  }
  return all;
}

/** @param {StageCtx} ctx */
async function screenStage(ctx) {
  const all = /** @type {import("./domain").Findings[]} */ (await ctx.read('findings.json'));
  return screen(all);
}

/** @param {StageCtx} ctx */
async function synthesizeStage(ctx) {
  const screened = /** @type {import("./domain").Screened} */ (await ctx.read('screened.json'));
  if (skillSection(ctx.request)) {
    const out = /** @type {{ title: string; scope: string; method: string; body: string }} */ (
      await ctx.turns.structured('writer', writerPrompt(ctx.request, screened), SKILL_REPORT_SCHEMA, toolContextFor(ctx, [], 'writer'), ctx.signal));
    return skillReport(out, new Set(screened.sources.flatMap((s) => (s.citekey ? [s.citekey] : []))), screened.sources);
  }
  const structured = /** @type {Omit<Report, "references">} */ (
    await ctx.turns.structured('writer', writerPrompt(ctx.request, screened), REPORT_SCHEMA, toolContextFor(ctx, [], 'writer'), ctx.signal));
  // references are attached here, not asked of the model: screen() already has exact bibliographic data for
  // every in-library source the writer was allowed to cite.
  return { ...structured, references: screened.sources };
}

/** @param {StageCtx} ctx */
async function publishStage(ctx) {
  const report = /** @type {Report} */ (await ctx.read('report.json'));
  const screened = /** @type {import("./domain").Screened} */ (await ctx.read('screened.json'));
  const roleModel = await ctx.getRoleModel('writer');
  const modelLabel = roleModel.model ? `${roleModel.provider}/${roleModel.model}` : roleModel.provider;
  const { markdown, frontMatter } = renderReport(report, ctx.request, { model: modelLabel, date: new Date().toISOString().slice(0, 10) }, screened.searchLog);
  return ctx.notes.publish({ reviewId: ctx.reviewId, title: report.title, markdown, frontMatter });
}

function reasonFor(error) {
  if (error?.name === 'AbortError') return 'cancelled';
  if (typeof error?.kind === 'string') return error.kind;
  return 'crashed';
}

/**
 * Runs from the first missing output to the end, or to WAIT. Safe to call twice: the second caller just re-walks
 * the same stage table, and every output is written atomically after its stage finishes, so a crash at any point
 * resumes cleanly by re-running only the stage(s) whose output is still missing.
 * @param {StageCtx} ctx
 * @returns {Promise<void>}
 */
export async function runReview(ctx) {
  try {
    for (const stage of stagesFor(ctx.request)) {
      if (await ctx.has(stage.output)) continue;
      if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const result = await stage.run(ctx);
      if (result === WAIT) { ctx.onProgress?.(); return; }
      await ctx.write(stage.output, result);
      ctx.onProgress?.();
    }
    await ctx.remove('stopped.json'); // clear a stale stopped.json (e.g. from a crash a resume just recovered from)
  } catch (error) {
    await ctx.write('stopped.json', { reason: reasonFor(error), message: errorMessage(error), at: new Date().toISOString() });
  }
}

/**
 * Status from the directory listing alone: note.json -> done; an in-flight run -> running at the first missing
 * stage; else stopped.json (reason) present -> stopped; else approve missing and plan present -> awaiting_approval;
 * else running (idle, not yet started) at the first missing stage.
 * Pipeline 2 adds awaiting_answer: clarify's questions are on disk and nothing runs.
 * @param {string[]} files @param {boolean} inFlight @param {number} [pipeline]
 * @returns {{ state: "done" } | { state: "running"; stage: StageId } | { state: "stopped"; stage: StageId } | { state: "awaiting_approval" } | { state: "awaiting_answer" } | { state: "awaiting_review" }}
 */
export function deriveStatus(files, inFlight, pipeline = 1, systematic = false) {
  const set = new Set(files);
  if (set.has('note.json')) return { state: 'done' };
  const next = stagesFor({ pipeline, systematic }).find((s) => !set.has(s.output));
  const stage = next ? next.id : 'publish';
  if (inFlight) return { state: 'running', stage };
  if (set.has('stopped.json')) return { state: 'stopped', stage };
  if (next && next.id === 'clarify' && set.has('clarify-questions.json')) return { state: 'awaiting_answer' };
  if (next && next.id === 'review' && set.has('screening.json')) return { state: 'awaiting_review' };
  if (next && next.id === 'approve' && set.has('plan.json')) return { state: 'awaiting_approval' };
  return { state: 'running', stage };
}

/**
 * Per-sub-question progress, derived from the plan and which findings files exist. Empty before a plan exists.
 * @param {(file: string) => Promise<unknown>} read @param {(file: string) => Promise<boolean>} has
 * @param {string[]} files @param {StageId} stage @param {number} [pipeline]
 * @returns {Promise<Extract<ReviewStatus, { state: "running" }>["agents"]>}
 */
async function agentsOf(read, has, files, stage, pipeline = 1) {
  const dir = pipeline === 2 ? 'search' : 'findings';
  const working = pipeline === 2 ? 'search' : 'research';
  if (!files.includes('approved-plan.json') && !files.includes('plan.json')) return [];
  const plan = /** @type {Plan} */ (files.includes('approved-plan.json') ? await read('approved-plan.json') : await read('plan.json'));
  /** @type {Extract<ReviewStatus, { state: "running" }>["agents"]} */
  const out = [];
  for (const sq of plan.subQuestions) {
    const done = await has(`${dir}/${sq.id}.json`);
    out.push({ subQuestion: sq.id, state: done ? 'done' : (stage === working ? 'running' : 'waiting') });
  }
  return out;
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** When a review started, from the time half of its ULID id; null for an id that isn't a ULID. @param {string} id */
function startedAt(id) {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  let ms = 0;
  for (const char of id.slice(0, 10)) ms = ms * 32 + ULID_ALPHABET.indexOf(char);
  return new Date(ms).toISOString();
}

/**
 * The full ReviewProgress (service.d.ts / domain.d.ts) a watcher sees, built from deriveStatus plus whatever
 * extra content each state needs (the plan to approve, the note path, per-agent state, papers found so far).
 * `withReport` adds the finished Report; watchers want it to show the review, list() leaves it out.
 * @param {{ read(file: string): Promise<any>, has(file: string): Promise<boolean> }} io
 * @param {import("./domain").ReviewId} id @param {string[]} files @param {boolean} inFlight
 * @param {{ withReport?: boolean }} [opts]
 * @returns {Promise<ReviewProgress>}
 */
export async function reviewProgress(io, id, files, inFlight, { withReport = false } = {}) {
  const request = files.includes('request.json') ? await io.read('request.json') : null;
  const pipeline = request?.pipeline === 2 ? 2 : 1;
  const coarse = deriveStatus(files, inFlight, pipeline, Boolean(request?.systematic));
  /** @type {ReviewStatus} */
  let status;
  if (coarse.state === 'awaiting_review') {
    const [candidates, screening] = await Promise.all([io.read('candidates.json'), io.read('screening.json')]);
    status = { state: 'awaiting_review', unclear: unclearList(candidates, screening), total: candidates.rows.length };
  } else if (coarse.state === 'awaiting_answer') {
    status = { state: 'awaiting_answer', questions: await io.read('clarify-questions.json') };
  } else if (coarse.state === 'done') {
    const note = await io.read('note.json');
    status = { state: 'done', notePath: note.path };
  } else if (coarse.state === 'awaiting_approval') {
    status = { state: 'awaiting_approval', plan: await io.read('plan.json') };
  } else if (coarse.state === 'stopped') {
    const stopped = await io.read('stopped.json');
    status = { state: 'stopped', stage: coarse.stage, reason: stopped?.reason ?? 'crashed' };
  } else {
    status = { state: 'running', stage: coarse.stage, agents: await agentsOf(io.read, io.has, files, coarse.stage, pipeline) };
  }
  const screened = files.includes('screened.json') ? await io.read('screened.json') : null;
  const candidates = pipeline === 2 && files.includes('candidates.json') ? await io.read('candidates.json') : null;
  /** @type {ReviewProgress} */
  const progress = {
    id, status,
    papersFound: candidates ? candidates.rows.length : (screened?.sources.length ?? 0),
    outside: candidates ? candidates.rows.filter((r) => !r.inLibrary).map((r) => ({ citekey: null, doi: r.doi, url: r.url, title: r.title, year: r.year, inLibrary: false })) : (screened?.outside ?? []),
    question: request?.question ?? null, started: startedAt(id),
    ...(request?.project ? { project: request.project } : {}),
    ...(request?.skills?.length ? { skills: request.skills.map((k) => ({ name: k.name, hash: k.hash, ...(k.notice ? { notice: k.notice } : {}) })) } : {}),
  };
  if (files.includes('usage.json')) {
    const usage = await io.read('usage.json').catch(() => null);
    if (typeof usage?.text === 'string' && usage.text) progress.usage = usage.text;
  }
  if (pipeline === 2) {
    progress.lines = await reviewLines(io, files, status, Boolean(request?.systematic));
    progress.counts = await reviewCounts(io, files);
    if (request?.systematic) progress.systematic = true;
  }
  if (withReport && status.state === 'done') {
    progress.report = await io.read('report.json');
    if (pipeline === 2 && files.includes('table.json')) progress.table = await io.read('table.json');
  }
  return progress;
}

/** Pipeline 2's stage lines and counts, derived from the files so a reopened review shows the same text (spec 007 §3.3). */
async function reviewCounts(io, files) {
  if (!files.includes('candidates.json')) return null;
  const [candidates, screening, table] = await Promise.all([
    io.read('candidates.json'),
    files.includes('screening.json') ? io.read('screening.json') : null,
    files.includes('table.json') ? io.read('table.json') : null,
  ]);
  return countsOf(candidates, screening, table);
}

/** @param {string} id @param {ActivityLine["icon"]} icon @param {string} title @param {string | null} detail @param {"running" | "done" | "failed"} state @returns {ActivityLine} */
function line(id, icon, title, detail, state = 'done') { return { id, icon, title, detail, state, items: [], reasoning: null }; }
/** @typedef {import("./domain").ActivityLine} ActivityLine */

/** The running "Searching" line: the researchers' calls so far, grouped the way a chat groups them. @param {any[]} events */
function searchingLine(events) {
  const base = line('search', 'scholarly', 'Searching', null, 'running');
  if (!events.length) return base;
  const lines = compactActivities(events);
  base.items = lines.flatMap((l) => l.items ?? []);
  base.entries = lines.flatMap((l) => l.entries ?? []);
  base.detail = lines.map((l) => l.detail).filter(Boolean).join(' · ') || null;
  return base;
}

/** @param {{ read(file: string): Promise<any>, live?: () => any[] }} io @param {string[]} files @param {ReviewStatus} status @returns {Promise<ActivityLine[]>} */
async function reviewLines(io, files, status, systematic = false) {
  const has = (f) => files.includes(f);
  const running = status.state === 'running' ? status.stage : null;
  /** @type {ActivityLine[]} */
  const out = [];
  if (has('clarify.json')) {
    const c = await io.read('clarify.json');
    const said = (c.answers ?? []).map((a) => { const q = c.questions.find((x) => x.id === a.id); return a.other ?? (a.choice != null ? q?.choices[a.choice] : null); }).filter(Boolean);
    if (c.questions.length) out.push(line('clarify', 'clarify', 'Clarified the scope', said.length ? said.join('; ') : null));
  } else if (running === 'clarify') out.push(line('clarify', 'clarify', 'Clarifying the scope', null, 'running'));
  if (has('plan.json')) {
    const p = await io.read('plan.json');
    if (systematic && p.protocol) out.push(line('plan', 'plan', 'Wrote the protocol', `${(p.criteria ?? []).length} criteria, ${(p.columns ?? []).length} columns`));
    else if (p.subQuestions.length) out.push(line('plan', 'plan', `Planned ${p.subQuestions.length} sub-question${p.subQuestions.length === 1 ? '' : 's'}`, null));
  } else if (running === 'plan') out.push(line('plan', 'plan', 'Planning', null, 'running'));
  if (has('candidates.json')) {
    const c = await io.read('candidates.json');
    if (c.searchLog.length) out.push(line('search', 'scholarly', 'Ran searches', `${c.searchLog.length} search${c.searchLog.length === 1 ? '' : 'es'}, ${c.rows.length} papers`));
    if (has('screening.json') && (await io.read('screening.json')).criteria?.length) {
      const s = await io.read('screening.json');
      const unclear = c.rows.filter((r) => s.decisions[r.id]?.ai === 'unclear' && isIncluded(s.decisions[r.id])).length;
      const kept = c.rows.filter((r) => isIncluded(s.decisions[r.id])).length;
      out.push(line('screen', 'screen', `Screened ${c.rows.length} papers`, `kept ${kept}${unclear ? `, ${unclear} unclear` : ''}`));
    } else if (running === 'screen' && !has('screening.json')) out.push(line('screen', 'screen', `Screening ${c.rows.length} papers`, null, 'running'));
  } else if (running === 'search') out.push(searchingLine(io.live?.() ?? []));
  if (has('table.json')) {
    const t = await io.read('table.json');
    out.push(line('extract', 'extract', `Extracted ${t.columns.length} column${t.columns.length === 1 ? '' : 's'} from ${t.rows.length} papers`, null));
  } else if (running === 'extract') out.push(line('extract', 'extract', 'Extracting', null, 'running'));
  if (has('report.json')) out.push(line('synthesize', 'write', 'Wrote the report from the table', null));
  else if (running === 'synthesize') out.push(line('synthesize', 'write', 'Writing the report from the table', null, 'running'));
  return out;
}

export { DEPTH_PRESETS };
