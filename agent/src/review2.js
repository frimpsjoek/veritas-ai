// @ts-check
// agent-src/src/review2.js. Spec 007 §2: the second stage table (pipeline 2) for a research report. Stages read and
// write files in reviews/<id>/ exactly as pipeline 1 does (output file = done, WAIT for a human). Screening and
// extraction both go through extract.js, so they share its batching, quote check and cell shapes.
import { WAIT } from './wait.js';
import { STANDALONE_SCHEMA, standalonePrompt, CLARIFY_SCHEMA, PLAN_SCHEMA_2, PLAN_SCHEMA_SYSTEMATIC, CANDIDATES_SCHEMA, REPORT_SCHEMA_2, SKILL_REPORT_SCHEMA, DEPTH_PRESETS, REPORT_CAPS, SYSTEMATIC_CAPS, clarifyPrompt, systematicClarifyPrompt, leadPrompt2, systematicLeadPrompt, candidatesPrompt, writerPrompt2 } from './prompts.js';
import { skillSection } from './skills.js';
import { extractBatches, selectTargets, slugColumn, cellKey } from './extract.js';
import { rowIdFor } from './sessions.js';
import { arxivIdOf } from './open-access.js';
import { renderReport, skillReport } from './report.js';

/** @typedef {import("./review").StageCtx} StageCtx */
/** @typedef {import("./domain").PaperRow} PaperRow */
/** @typedef {import("./domain").ColumnSpec} ColumnSpec */
/** @typedef {import("./domain").Cell} Cell */
/** @typedef {import("./domain").Plan} Plan */

const MAX_QUESTIONS = 2;

/** The web mode a report that lists "web" runs with: the one saved when it started (request.web), else live. @param {{ web?: string } | undefined} request @returns {"cached" | "live"} */
export function reportWebMode(request) {
  return request?.web === 'cached' ? 'cached' : 'live';
}

/** The search / lead / writer turns of pipeline 2 use the same tool context shape as pipeline 1's; extraction and
 *  writing use none at all: they read only what our code puts in the prompt. @param {StageCtx} ctx @param {string} suffix */
function noTools(ctx, suffix) {
  return {
    scope: ctx.request.scope, web: /** @type {const} */ ('off'),
    sources: { papers: false, notes: false, scholarly: false, web: false },
    audit: `review:${ctx.reviewId}:${suffix}`, none: true,
  };
}

/** @param {StageCtx} ctx @param {string[]} sources @param {string} suffix @param {{ calls: number, failed: number, firstError?: string }} [tally] */
export function searchTools(ctx, sources, suffix, tally = { calls: 0, failed: 0 }) {
  const list = sources.length ? sources : ctx.request.sources;
  const papers = list.includes('papers') || list.includes('library');
  const notes = list.includes('notes') || list.includes('library');
  return { scope: ctx.request.scope, web: list.includes('web') ? reportWebMode(ctx.request) : /** @type {const} */ ('off'), sources: { papers, notes, scholarly: list.includes('scholarly'), web: list.includes('web') }, audit: `review:${ctx.reviewId}:${suffix}`, searchTally: tally };
}

/** Keeps at most 2 well-formed questions with 2-4 choices and unique ids; whatever the model sent beyond that is dropped. @param {any} out */
export function cleanQuestions(out) {
  const seen = new Set();
  const questions = [];
  for (const q of Array.isArray(out?.questions) ? out.questions : []) {
    const question = String(q?.question ?? '').trim();
    const choices = (Array.isArray(q?.choices) ? q.choices : []).map((c) => String(c ?? '').trim()).filter(Boolean).slice(0, 4);
    if (!question || choices.length < 2) continue;
    let id = String(q?.id ?? '').trim() || `q${questions.length + 1}`;
    if (seen.has(id)) id = `q${questions.length + 1}`;
    seen.add(id);
    questions.push({ id, question, choices, other: Boolean(q?.other) });
    if (questions.length === MAX_QUESTIONS) break;
  }
  return questions;
}

/** @param {StageCtx} ctx */
export async function clarifyStage(ctx) {
  await withStandaloneQuestion(ctx);
  // The lead may not ask when the researcher chose "run it automatically": its own defaults become "assumed" lines.
  if (ctx.settings.autoApprove) return { questions: [], answers: [] };
  // Restart while waiting: the questions are already on disk, so no second turn.
  if (await ctx.has('clarify-questions.json')) return WAIT;
  const out = await ctx.turns.structured('lead', (ctx.request.systematic ? systematicClarifyPrompt : clarifyPrompt)(ctx.request), CLARIFY_SCHEMA, noTools(ctx, 'clarify'), ctx.signal);
  const questions = cleanQuestions(out);
  if (!questions.length) return { questions: [], answers: [] };
  await ctx.write('clarify-questions.json', questions);
  return WAIT;
}

/** Spec 030 R12: a report started in a chat thread carries that conversation (`request.thread`, set at start); its
 *  message is turned into a standalone question once, before anything is planned, and every later stage (the plan,
 *  the searches, the report's title) works from it. The words typed stay as `asked`. Saved in request.json, so a
 *  restart does not ask again. A failed turn leaves the question as typed. @param {StageCtx} ctx */
export async function withStandaloneQuestion(ctx) {
  const request = /** @type {any} */ (ctx.request);
  if (!request.thread || request.asked) return;
  let question = '';
  try {
    const out = await ctx.turns.structured('lead', standalonePrompt(request.question, request.thread), STANDALONE_SCHEMA, noTools(ctx, 'standalone'), ctx.signal);
    question = String(/** @type {any} */ (out)?.question ?? '').trim().replace(/\s+/g, ' ').slice(0, 400);
  } catch { /* the question stays as typed */ }
  request.asked = request.question;
  if (question) request.question = question;
  await ctx.write('request.json', request);
}

/** @param {import("./domain").ReviewRequest} request */
function capsFor(request) {
  const table = request.systematic ? SYSTEMATIC_CAPS : REPORT_CAPS;
  return { ...(table[request.depth] ?? table.quick) };
}

/** @param {StageCtx} ctx */
export async function plan2Stage(ctx) {
  const preset = DEPTH_PRESETS[ctx.request.depth] ?? DEPTH_PRESETS.quick;
  const clarified = /** @type {import("./domain").Clarified | null} */ (await ctx.has('clarify.json') ? await ctx.read('clarify.json') : null);
  const prompt = ctx.request.systematic ? systematicLeadPrompt(ctx.request, preset.subQuestions, clarified) : leadPrompt2(ctx.request, preset.subQuestions, clarified, ctx.settings.autoApprove);
  const out = /** @type {any} */ (await ctx.turns.structured('lead', prompt, ctx.request.systematic ? PLAN_SCHEMA_SYSTEMATIC : PLAN_SCHEMA_2, searchToolsForPlan(ctx), ctx.signal));
  return normalizePlan(out, ctx.request);
}

/** The lead plans with the search tools available (it may look at what the library holds), like pipeline 1's. @param {StageCtx} ctx */
function searchToolsForPlan(ctx) { return searchTools(ctx, [], 'plan'); }

/**
 * Turns the model's plan into the stored one: criterion and column ids, caps from the depth, at most 2 preferred
 * criteria unless the model marked one strict.
 * @param {any} out @param {import("./domain").ReviewRequest} request
 * @returns {Plan}
 */
export function normalizePlan(out, request) {
  const used = new Set();
  const uniqueId = (base) => { let id = base; let n = 2; while (used.has(id)) id = `${base}_${n++}`; used.add(id); return id; };
  const criteria = (Array.isArray(out?.criteria) ? out.criteria : []).filter((c) => String(c?.text ?? '').trim()).slice(0, 3)
    .map((c, i) => ({ id: /** @type {any} */ (`criterion_${i + 1}`), text: String(c.text).trim(), strict: Boolean(c.strict) }));
  const columns = (Array.isArray(out?.columns) ? out.columns : []).filter((c) => String(c?.name ?? '').trim()).slice(0, 8)
    .map((c) => ({ id: /** @type {any} */ (uniqueId(slugColumn(String(c.name)))), name: String(c.name).trim(), instruction: String(c.instruction ?? '').trim(), kind: /** @type {const} */ ('text') }));
  const plan = {
    subQuestions: out.subQuestions,
    criteria, columns,
    assumed: (Array.isArray(out?.assumed) ? out.assumed : []).map((a) => String(a).trim()).filter(Boolean),
    caps: capsFor(request),
  };
  if (request.systematic) {
    plan.protocol = cleanProtocol(out?.protocol);
    plan.criteria = withStrictCriterion(plan.criteria, request.question);
  } else if (request.on) plan.criteria = withTopicCriterion(plan.criteria, request.question);
  return plan;
}

/** @param {any} p @returns {import("./domain").Protocol} */
export function cleanProtocol(p) {
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const designs = Array.isArray(p?.studyDesigns) && p.studyDesigns.length ? p.studyDesigns.map(String) : null;
  return { population: text(p?.population), intervention: text(p?.intervention), comparison: text(p?.comparison), outcomes: text(p?.outcomes), studyDesigns: /** @type {any} */ (designs) };
}

/** A systematic review needs a strict criterion to screen on: the first one the lead wrote becomes strict when it marked
 *  none, and with no criteria at all the review's own question is the one. @param {import("./domain").Criterion[]} criteria @param {string} question */
export function withStrictCriterion(criteria, question) {
  if (criteria.some((c) => c.strict)) return criteria;
  if (criteria.length) return criteria.map((c, i) => (i === 0 ? { ...c, strict: true } : c));
  return [{ id: /** @type {any} */ ('criterion_1'), text: `Addresses the question: ${question}`, strict: true }];
}

/** Spec 030 R9: a Research report started on a paper set (a Find search in the thread, "Report on these") did not
 *  search for its papers, so the set may hold papers on other topics; with only "prefer" criteria every one was kept
 *  (54 of 54 in the live check, warm dense matter among them). One strict criterion, the question itself, is added:
 *  a paper whose text says it is not about the question is left out, one the text does not settle stays (unclear).
 *  The lead's own criteria are kept as they are. @param {import("./domain").Criterion[]} criteria @param {string} question */
export function withTopicCriterion(criteria, question) {
  if (criteria.some((c) => c.strict)) return criteria;
  return [...criteria, { id: /** @type {any} */ (`criterion_${criteria.length + 1}`), text: `Is about the question: ${question}`, strict: true }];
}

/** @param {StageCtx} ctx */
export async function approve2Stage(ctx) {
  if (!ctx.settings.autoApprove) return WAIT;
  return ctx.read('plan.json');
}

// ---------- search ----------

/** @param {string} title */
function normTitle(title) { return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/**
 * One PaperRow per paper across every sub-question's candidates, de-duplicated by DOI, citekey and normalised title
 * (the same three rules `screen()` uses). The richer record wins field by field.
 * @param {import("./domain").Candidate[][]} lists @param {number} cap
 * @returns {PaperRow[]}
 */
export function mergeCandidates(lists, cap) {
  /** @type {{ doi: string | null; citekey: string | null; nt: string; c: import("./domain").Candidate; foundBy: Set<string> }[]} */
  const buckets = [];
  lists.forEach((list, li) => {
    for (const c of list) {
      const doi = c.doi ? c.doi.toLowerCase() : null;
      const nt = normTitle(c.title);
      if (!c.title?.trim()) continue;
      const hit = buckets.find((b) => (doi && b.doi === doi) || (c.citekey && b.citekey === c.citekey) || (nt && b.nt === nt));
      if (!hit) { buckets.push({ doi, citekey: c.citekey ?? null, nt, c: { ...c }, foundBy: new Set([`q${li + 1}`]) }); continue; }
      hit.foundBy.add(`q${li + 1}`);
      hit.doi ??= doi; hit.citekey ??= c.citekey ?? null;
      const m = hit.c;
      m.citekey ??= c.citekey; m.doi ??= c.doi; m.url ??= c.url; m.year ??= c.year;
      if ((c.abstract ?? '').length > (m.abstract ?? '').length) m.abstract = c.abstract;
      if (!(m.authors ?? []).length) m.authors = c.authors ?? [];
      if (!m.venue) m.venue = c.venue ?? '';
    }
  });
  return buckets.slice(0, Math.max(0, cap)).map((b, i) => {
    const c = b.c;
    return /** @type {PaperRow} */ ({
      id: rowIdFor(c, i),
      ref: c.citekey ? { kind: 'paper', citekey: c.citekey } : { kind: 'web', url: c.doi ? `https://doi.org/${c.doi}` : (c.url ?? '') },
      inLibrary: Boolean(c.citekey), title: c.title.trim(), authors: c.authors ?? [], year: c.year ?? null, venue: c.venue ?? '',
      doi: c.doi ?? null, url: c.url ?? null, abstract: c.abstract ?? '', citations: null,
      // A library paper may have a text the extract stage can read; textFor falls back to the abstract when it has none.
      fullText: Boolean(c.citekey), pdfUrl: null, studyType: null, foundBy: [...b.foundBy],
    });
  });
}

/** Spec 030 R9: the rows of a paper set a report starts from ("Report on these", or a report asked in a thread after a
 *  Find search). A library paper is read the way the report's own search reads it (mergeCandidates above): its text
 *  when the library has one, the abstract otherwise. A Find search marks every row `fullText: false`, which left
 *  even library papers read from the abstract alone. Outside papers are left as they are.
 *  @param {PaperRow[]} rows @returns {PaperRow[]} */
export function seededRows(rows) {
  return rows.map((row) => (row.inLibrary && row.ref?.kind === 'paper' ? { ...row, fullText: true } : row));
}

/** How much of a library paper's start stands in for its abstract once checked against the library. */
const VERIFY_CHARS = 1500;

/**
 * Researcher-returned candidates are claims, not records: the citekey may be invented and the abstract is whatever the
 * model transcribed (it may be empty, reworded, or copied from a neighbour). Each row is checked against the library
 * through the read/search tools it already has:
 *  - a citekey the library does not know is dropped and the row becomes an outside paper;
 *  - a row without a citekey whose DOI (found in the paper's own text) or exact normalised title matches a library
 *    paper becomes that paper;
 *  - a library paper's abstract is replaced by the library's text ("library");
 *  - an outside paper keeps what the researcher wrote, marked "unverified" (or "none" when it wrote nothing).
 * A library that cannot be read (an error) leaves the row as it was, marked "unverified": nothing is called checked
 * that was not.
 * @param {PaperRow[]} rows @param {{ read: import("./tools").LibraryBackend["read"]; search: import("./tools").LibraryBackend["search"] }} library @param {AbortSignal} [signal]
 * @returns {Promise<PaperRow[]>}
 */
export async function verifyCandidates(rows, library, signal) {
  const out = new Array(rows.length);
  let next = 0;
  /** @param {PaperRow} row @returns {"unverified" | "none"} */
  const statusOf = (row) => ((row.abstract ?? '').trim() ? 'unverified' : 'none');
  const outside = (row) => ({ ...row, ref: /** @type {import("./domain").CitationRef} */ ({ kind: 'web', url: row.doi ? `https://doi.org/${row.doi}` : (row.url ?? '') }), inLibrary: false, fullText: false, abstractStatus: statusOf(row) });
  const fromLibrary = (row, ref, text) => ({
    ...row, ref, inLibrary: true, fullText: true, abstract: text.slice(0, VERIFY_CHARS), abstractStatus: /** @type {const} */ ('library'),
  });
  /** @param {PaperRow} row */
  async function verify(row) {
    try {
      if (row.ref.kind === 'paper') {
        const got = await library.read(row.ref, { maxChars: VERIFY_CHARS });
        if (!got) {
          // Not in the library: the citekey was the model's invention. The DOI and title may still find the real paper.
          return (await findByDoiOrTitle({ ...row, ref: { kind: 'web', url: row.doi ? `https://doi.org/${row.doi}` : (row.url ?? '') } })) ?? outside(row);
        }
        const text = (got.text ?? '').trim();
        return text ? fromLibrary(row, row.ref, text) : { ...row, abstractStatus: statusOf(row) };
      }
      return (await findByDoiOrTitle(row)) ?? outside(row);
    } catch {
      return { ...row, abstractStatus: statusOf(row) };
    }
  }
  /** @param {PaperRow} row @returns {Promise<PaperRow | null>} */
  async function findByDoiOrTitle(row) {
    const doi = row.doi?.toLowerCase().trim();
    const nt = normTitle(row.title);
    /** @type {{ ref: import("./domain").CitationRef; title: string }[]} */
    const seen = [];
    const probe = async (text) => {
      for (const h of await library.search({ text, scope: { kind: 'library' }, limit: 5, only: 'papers' })) {
        if (h.ref.kind === 'paper' && !seen.some((x) => x.ref.kind === 'paper' && x.ref.citekey === /** @type {any} */ (h.ref).citekey)) seen.push(h);
      }
    };
    if (doi) await probe(doi);
    if (nt) await probe(row.title);
    for (const h of seen) {
      const got = await library.read(h.ref, { maxChars: VERIFY_CHARS });
      const text = (got?.text ?? '').trim();
      if (!text) continue;
      if ((doi && new RegExp(`${doi.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![a-z0-9])`).test(text.toLowerCase())) || (nt && normTitle(got?.title || h.title) === nt)) return fromLibrary(row, h.ref, text);
    }
    return null;
  }
  async function worker() {
    while (!signal?.aborted) {
      const i = next++;
      if (i >= rows.length) return;
      out[i] = await verify(rows[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, Math.max(1, rows.length)) }, worker));
  return out.map((r, i) => r ?? rows[i]);
}

/** @param {StageCtx} ctx */
/**
 * An outside paper's abstract is the index's text when the index has one (status "source"), not what a researcher model
 * copied back. Papers with no DOI, or none found, keep whatever they had.
 * @param {PaperRow[]} rows @param {((dois: string[]) => Promise<Map<string, string>>) | undefined} lookup
 * @returns {Promise<PaperRow[]>}
 */
export async function withIndexAbstracts(rows, lookup) {
  const wanted = rows.filter((r) => !r.inLibrary && r.doi).map((r) => /** @type {string} */ (r.doi));
  if (!lookup || !wanted.length) return rows;
  const found = await lookup(wanted).catch(() => new Map());
  return rows.map((r) => {
    const text = !r.inLibrary && r.doi ? found.get(r.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, '')) : undefined;
    return text ? { ...r, abstract: text, abstractStatus: /** @type {const} */ ('source') } : r;
  });
}

export async function searchStage(ctx) {
  const plan = /** @type {Plan} */ (await ctx.read('approved-plan.json'));
  const caps = plan.caps ?? capsFor(ctx.request);
  const perQuestion = Math.max(5, Math.ceil(caps.candidates / Math.max(1, plan.subQuestions.length)) + 5);
  const todo = [];
  for (const sq of plan.subQuestions) if (!(await ctx.has(`search/${sq.id}.json`))) todo.push(sq);

  // A researcher turn that fails (a crash, a bad answer) is retried once; what the last attempt said is kept, so a
  // stopped review says why instead of just "did not finish".
  /** @type {Map<string, unknown>} */
  const failures = new Map();
  /** Every search tool call of this stage, across questions and retries. */
  const tally = { calls: 0, failed: 0 };
  await Promise.allSettled(todo.map(async (sq) => {
    for (let attempt = 1; attempt <= 2 && !ctx.signal.aborted; attempt++) {
      try {
        const out = /** @type {any} */ (await ctx.turns.structured('researcher', candidatesPrompt(ctx.request, sq, perQuestion), CANDIDATES_SCHEMA, searchTools(ctx, sq.sources, sq.id, tally), ctx.signal));
        await ctx.write(`search/${sq.id}.json`, { subQuestion: sq.id, candidates: Array.isArray(out?.candidates) ? out.candidates : [], searchLog: Array.isArray(out?.searchLog) ? out.searchLog : [] });
        ctx.onProgress?.();
        return;
      } catch (error) {
        failures.set(sq.id, error);
      }
    }
  }));

  const lists = [];
  const searchLog = [];
  for (const sq of plan.subQuestions) {
    if (!(await ctx.has(`search/${sq.id}.json`))) {
      if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const why = failures.get(sq.id);
      throw Object.assign(new Error(`the researcher for "${sq.id}" did not finish${why ? `: ${why instanceof Error ? why.message : String(why)}` : ''}`), { kind: /** @type {any} */ (why)?.kind ?? 'provider_crashed' });
    }
    const f = await ctx.read(`search/${sq.id}.json`);
    lists.push(f.candidates);
    searchLog.push(...f.searchLog);
  }
  const merged = mergeCandidates(lists, caps.candidates);
  // Nothing found because every search errored is a stopped review, not a report with no included studies. Only
  // searches that ran this time are counted (a restart that resumes finished questions has none, and carries on).
  if (!merged.length && tally.calls > 0 && tally.failed === tally.calls) {
    throw Object.assign(new Error(`The searches failed: ${tally.firstError ?? 'no search could be run'}. Nothing was found because nothing could be searched, so no report was written.`), { kind: 'provider_crashed' });
  }
  // Without a library handle (tests, a host that has none) the rows stay as the researchers wrote them, with no status.
  const checked = ctx.library ? await verifyCandidates(merged, ctx.library, ctx.signal) : merged;
  const rows = await withIndexAbstracts(checked, ctx.abstractsByDoi);
  if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  return { rows, searchLog };
}

// ---------- screening (criteria as columns) ----------

/** @param {Plan} plan @returns {ColumnSpec[]} */
export function criterionColumns(plan) {
  return (plan.criteria ?? []).map((c) => ({ id: c.id, name: c.text, instruction: `Does the paper meet this criterion: ${c.text}`, kind: /** @type {const} */ ('criterion') }));
}

/**
 * The AI's call, derived and never asked for (spec 007 §2.4): any strict criterion answered "no" excludes; a strict
 * criterion the text did not settle makes the row unclear (kept); everything else includes.
 * @param {import("./domain").Criterion[]} criteria @param {Record<string, Cell>} cells
 * @returns {import("./domain").ScreenDecision}
 */
export function decide(criteria, cells) {
  /** @type {import("./domain").ColumnId[]} */
  const because = [];
  let unclear = false;
  for (const c of criteria.filter((x) => x.strict)) {
    const cell = cells?.[c.id];
    if (cell?.state === 'filled' && cell.value === 'no') because.push(c.id);
    else if (!cell || cell.state !== 'filled' || cell.value === 'unclear') unclear = true;
  }
  return { ai: because.length ? 'exclude' : unclear ? 'unclear' : 'include', because, user: null };
}

/** What happens to a row: the user's override wins, otherwise the AI's exclusion. @param {import("./domain").ScreenDecision | undefined} d */
export function isIncluded(d) {
  if (!d) return true;
  if (d.user) return d.user === 'include';
  return d.ai !== 'exclude';
}

/** A cell the model settled (an answer, or "not reported"); a failed or missing one is still to do. @param {Cell | undefined} c */
const isFinal = (c) => c?.state === 'filled' || c?.state === 'not_found';

/** More failed cells than this share of an extraction stops the review (resumable) instead of writing a table that is mostly holes. */
export const MAX_FAILED_SHARE = 0.25;

/**
 * Runs extract.js's batches for a stage, keeping what is done in `<suffix>-partial.json` after every batch: a stopped
 * review (rate limit, timeouts, cancel) resumes with only the missing or failed cells, not the whole stage. Throws
 * when every batch failed, or when more than MAX_FAILED_SHARE of the cells are still failed (the partial file stays).
 * @param {StageCtx} ctx @param {{ targets: ReturnType<typeof selectTargets>; text: "abstract" | "head" | "best"; suffix: string }} a
 */
async function runExtraction(ctx, { targets, text, suffix }) {
  const reader = ctx.extract;
  if (!reader) throw new Error('this runtime cannot read paper text for extraction');
  const partialFile = `${suffix}-partial.json`;
  /** @type {Map<string, Cell>} */
  const produced = new Map();
  if (await ctx.has(partialFile)) {
    for (const [key, cell] of /** @type {[string, Cell][]} */ (await ctx.read(partialFile))) if (cell.state === 'filled' || cell.state === 'not_found') produced.set(key, cell);
  }
  /** The reduced targets for what is still to do: every (row, column) not already produced as filled or not_found. */
  const remaining = () => {
    /** @type {Map<string, ColumnSpec[]>} */
    const need = new Map();
    for (const row of targets.rows) {
      const cols = (targets.need.get(row.id) ?? []).filter((c) => !isFinal(produced.get(cellKey(row.id, c.id))));
      if (cols.length) need.set(row.id, cols);
    }
    return { ...targets, rows: targets.rows.filter((r) => need.has(r.id)), need };
  };
  let total = 0;
  for (const cols of targets.need.values()) total += cols.length;
  /** @type {unknown} */
  let firstError = null;
  // One retry of the failed batches: a turn that crashed or timed out once usually answers the second time.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const todo = remaining();
    if (!todo.need.size) break;
    const outcome = await extractBatches({
      targets: todo, text, signal: ctx.signal,
      workers: reader.workers,
      readText: (row) => reader.readText(row, text),
      turn: (prompt, schema, signal) => ctx.turns.structured('extract', skillSection(ctx.request) ? `${prompt}\n\n${skillSection(ctx.request)}` : prompt, schema, noTools(ctx, suffix), signal),
      async onBatch(cells) {
        for (const w of cells) produced.set(cellKey(w.row, w.column), w.cell);
        await ctx.write(partialFile, [...produced]);
        ctx.onProgress?.();
      },
    });
    if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    firstError ??= outcome.firstError;
    if (attempt === 1 && outcome.batches > 0 && outcome.failedBatches === outcome.batches) throw outcome.firstError;
    if (!outcome.failedBatches) break;
  }
  const left = [...targets.rows].reduce((n, r) => n + (targets.need.get(r.id) ?? []).filter((c) => !isFinal(produced.get(cellKey(r.id, c.id)))).length, 0);
  if (total && left / total > MAX_FAILED_SHARE) {
    throw Object.assign(new Error(`${left} of ${total} cells could not be filled: ${firstError instanceof Error ? firstError.message : 'a turn failed'}`), { kind: /** @type {any} */ (firstError)?.kind ?? 'provider_crashed' });
  }
  return produced;
}

/** @param {Map<string, Cell>} produced @param {PaperRow[]} rows @param {ColumnSpec[]} columns */
function cellsOf(produced, rows, columns) {
  /** @type {Record<string, Record<string, Cell>>} */
  const cells = {};
  for (const r of rows) {
    cells[r.id] = {};
    for (const c of columns) cells[r.id][c.id] = produced.get(cellKey(r.id, c.id)) ?? { state: 'pending' };
  }
  return cells;
}

/** Spec 031 R1: an outside paper with no abstract is screened on its title alone, and read from nothing. Before
 *  screening, each such row with a DOI or an arXiv id is looked up (`lookup`, scholarly.js fillAbstracts) and gets
 *  the abstract found, marked "source". Returns `rows` itself when nothing changed. Never throws.
 *  @param {PaperRow[]} rows @param {StageCtx["fillAbstracts"]} lookup @returns {Promise<PaperRow[]>} */
export async function withFilledAbstracts(rows, lookup) {
  const empty = rows.filter((r) => !r.inLibrary && !(r.abstract ?? '').trim() && (r.doi || arxivIdOf(r)));
  if (!lookup || !empty.length) return rows;
  const found = await lookup(empty.map((r) => ({ id: r.id, doi: r.doi, arxiv: arxivIdOf(r) }))).catch(() => new Map());
  if (!found.size) return rows;
  return rows.map((r) => (found.has(r.id) ? { ...r, abstract: /** @type {string} */ (found.get(r.id)), abstractStatus: /** @type {const} */ ('source') } : r));
}

/** Spec 031 R2: each kept outside paper with where it can be read (`access`, and `pdfUrl` for a free copy). Library
 *  papers are read from the library and are not looked up. Never throws.
 *  @param {PaperRow[]} rows @param {StageCtx["openAccess"]} lookup @returns {Promise<PaperRow[]>} */
export async function withOpenAccess(rows, lookup) {
  const outside = rows.filter((r) => !r.inLibrary);
  if (!lookup || !outside.length) return rows;
  const found = await lookup(outside).catch(() => /** @type {import("./open-access").Access[]} */ ([]));
  const byId = new Map(outside.map((r, i) => [r.id, found[i]]));
  return rows.map((r) => {
    const a = byId.get(r.id);
    if (!a) return r;
    return a.access === 'open' ? { ...r, access: a.access, pdfUrl: a.pdfUrl, ...(a.alternates?.length ? { pdfAlternates: a.alternates } : {}) } : { ...r, access: a.access };
  });
}

/** Spec 031 R4: how the kept papers were read, for "How this was done". @param {PaperRow[]} rows */
export function readCounts(rows) {
  const counts = { library: 0, open_access: 0, abstract: 0, none: 0 };
  for (const r of rows) counts[r.readFrom ?? (r.inLibrary ? 'library' : (r.abstract ?? '').trim() ? 'abstract' : 'none')] += 1;
  return counts;
}

/** Spec 031 R4: one sentence on what the extracted papers were read from, so a thin report says why; the papers with
 *  no text are named (at most 8). '' for an empty table. @param {PaperRow[]} rows */
export function readSentence(rows) {
  if (!rows.length) return '';
  const c = readCounts(rows);
  const n = (/** @type {number} */ k, /** @type {string} */ one, /** @type {string} */ many) => `${k} ${k === 1 ? one : many}`;
  const full = c.library + c.open_access;
  const parts = [`${full} ${full === 1 ? 'was' : 'were'} read in full (${c.library} from your library, ${c.open_access} from free copies found online)`];
  if (c.abstract) parts.push(`${c.abstract} from the abstract only`);
  if (c.none) parts.push(`${c.none} had no text to read`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const none = rows.filter((r) => r.readFrom === 'none').slice(0, 8).map((r) => `"${r.title}"`);
  return `Of the ${n(rows.length, 'paper', 'papers')} with data extracted, ${list}.${none.length ? ` No text: ${none.join('; ')}${c.none > none.length ? ' and more' : ''}.` : ''}`;
}

/** @param {StageCtx} ctx */
export async function screen2Stage(ctx) {
  const plan = /** @type {Plan} */ (await ctx.read('approved-plan.json'));
  const candidates = /** @type {import("./domain").Candidates} */ (await ctx.read('candidates.json'));
  const rows = await withFilledAbstracts(candidates.rows, ctx.fillAbstracts);
  if (rows !== candidates.rows) await ctx.write('candidates.json', { ...candidates, rows });
  const criteria = plan.criteria ?? [];
  /** @type {Record<string, import("./domain").ScreenDecision>} */
  const decisions = {};
  /** @type {Record<string, Record<string, Cell>>} */
  let cells = {};
  // Fastest skips the screening turn outside a systematic review: every candidate stays in, the cap decides (ranked, in extract).
  const skip = ctx.request.depth === 'fastest' && !ctx.request.systematic;
  if (criteria.length && rows.length && !skip) {
    const columns = criterionColumns(plan);
    const targets = selectTargets(/** @type {any} */ ({ columns: [], rows, cells: {} }), { add: columns, rows: 'all' }, { maxRows: rows.length });
    cells = cellsOf(await runExtraction(ctx, { targets, text: ctx.request.depth === 'fastest' ? 'abstract' : 'head', suffix: 'screen' }), rows, columns);
    await ctx.remove('screen-partial.json');
  }
  /** @type {Record<string, number>} */
  const perCriterion = {};
  for (const r of rows) {
    const d = skip ? { ai: /** @type {const} */ ('include'), because: [], user: null } : decide(criteria, cells[r.id] ?? {});
    decisions[r.id] = d;
    for (const id of d.because) perCriterion[id] = (perCriterion[id] ?? 0) + 1;
  }
  return { decisions, criteria, perCriterion, cells };
}

// ---------- extraction ----------

/** The columns the report fills when the plan named none: three defaults plus one per sub-question. @param {Plan} plan @returns {ColumnSpec[]} */
export function defaultColumns(plan) {
  /** @type {ColumnSpec[]} */
  const cols = [
    { id: /** @type {any} */ ('main_findings'), name: 'Main findings', instruction: 'The main findings', kind: 'text', preset: 'main_findings' },
    { id: /** @type {any} */ ('methodology'), name: 'Methodology', instruction: 'The study design and methods', kind: 'text', preset: 'methodology' },
    { id: /** @type {any} */ ('limitations'), name: 'Limitations', instruction: 'The limitations the study reports', kind: 'text', preset: 'limitations' },
  ];
  const used = new Set(cols.map((c) => c.id));
  for (const sq of plan.subQuestions) {
    let id = `sq_${slugColumn(sq.id)}`;
    while (used.has(/** @type {any} */ (id))) id += '_';
    used.add(/** @type {any} */ (id));
    cols.push({ id: /** @type {any} */ (id), name: sq.question.length > 60 ? `${sq.question.slice(0, 57)}...` : sq.question, instruction: `What the paper says about: ${sq.question}`, kind: 'text' });
  }
  return cols;
}

/** The rows that go on to extraction, in candidate order, capped. @param {PaperRow[]} rows @param {import("./domain").Screening} screening @param {number} cap */
export function includedRows(rows, screening, cap) {
  return rows.filter((r) => isIncluded(screening.decisions[r.id])).slice(0, Math.max(0, cap));
}

/**
 * Fastest keeps candidates up to the cap without a model's say, so the cap picks by the signals the search already holds:
 * papers with an abstract to read first, then the ones more sub-questions found, then the user's own library. Stable.
 * @param {PaperRow[]} rows
 */
export function rankCandidates(rows) {
  const key = (/** @type {PaperRow} */ r) => [(r.abstract ?? '').trim() ? 1 : 0, (r.foundBy ?? []).length, r.inLibrary ? 1 : 0];
  return rows.map((r, i) => ({ r, i, k: key(r) })).sort((a, b) => b.k[0] - a.k[0] || b.k[1] - a.k[1] || b.k[2] - a.k[2] || a.i - b.i).map((x) => x.r);
}

/** @param {StageCtx} ctx */
export async function extract2Stage(ctx) {
  const plan = /** @type {Plan} */ (await ctx.read('approved-plan.json'));
  const { rows: all } = /** @type {import("./domain").Candidates} */ (await ctx.read('candidates.json'));
  const screening = /** @type {import("./domain").Screening} */ (await ctx.read('screening.json'));
  const caps = plan.caps ?? capsFor(ctx.request);
  const fastest = ctx.request.depth === 'fastest';
  const kept = includedRows(fastest ? rankCandidates(all) : all, screening, caps.extract);
  const columns = plan.columns?.length ? plan.columns : defaultColumns(plan);
  if (!kept.length) return { columns, rows: [], cells: {} };
  // spec 031 D1: only the kept papers (at most caps.extract) are looked up and downloaded; Fastest reads abstracts only
  const rows = fastest ? kept : await withOpenAccess(kept, ctx.openAccess);
  const targets = selectTargets(/** @type {any} */ ({ columns: [], rows, cells: {} }), { add: columns, rows: 'all' }, { maxRows: rows.length });
  /** @type {Map<string, "library" | "open_access" | "abstract">} */
  const readFrom = new Map();
  const reading = ctx.extract ? {
    ...ctx,
    extract: {
      ...ctx.extract,
      readText: async (/** @type {PaperRow} */ row, /** @type {any} */ mode) => {
        const got = await /** @type {NonNullable<StageCtx["extract"]>} */ (ctx.extract).readText(row, mode);
        if (got) readFrom.set(row.id, got.from === 'abstract' ? 'abstract' : row.inLibrary ? 'library' : 'open_access');
        return got;
      },
    },
  } : ctx;
  const produced = await runExtraction(reading, { targets, text: fastest ? 'abstract' : (ctx.request.text ?? 'head'), suffix: 'extract' });
  // a row read before a restart (its cells came from extract-partial.json) was not read again: say what it had
  /** @param {PaperRow} r @returns {NonNullable<PaperRow["readFrom"]>} */
  const had = (r) => (r.inLibrary ? 'library' : (r.abstract ?? '').trim() ? 'abstract' : 'none');
  const read = rows.map((r) => /** @type {PaperRow} */ ({ ...r, readFrom: readFrom.get(r.id) ?? had(r) }));
  const table = { columns, rows: read, cells: cellsOf(produced, read, columns) };
  await ctx.remove('extract-partial.json');
  return table;
}

// ---------- the unclear wait (systematic only) ----------

/** More than this share of the candidates unclear and the review asks before extracting (spec 007 §2.5). */
export const UNCLEAR_SHARE = 0.1;

/** Rows the AI could not settle and the researcher has not decided. @param {PaperRow[]} rows @param {import("./domain").Screening} screening */
export function unclearRows(rows, screening) {
  return rows.filter((r) => screening.decisions[r.id]?.ai === 'unclear' && !screening.decisions[r.id]?.user);
}

/** @param {StageCtx} ctx */
export async function reviewUnclearStage(ctx) {
  const { rows } = /** @type {import("./domain").Candidates} */ (await ctx.read('candidates.json'));
  const screening = /** @type {import("./domain").Screening} */ (await ctx.read('screening.json'));
  const unclear = unclearRows(rows, screening).length;
  if (!rows.length || unclear / rows.length <= UNCLEAR_SHARE) return { unclear, asked: false };
  return WAIT;
}

/** The "Let me look" list: each unclear row with the strict criteria it was unclear on. @param {import("./domain").Candidates} candidates @param {any} screening */
export function unclearList(candidates, screening) {
  const strict = (screening.criteria ?? []).filter((c) => c.strict);
  return unclearRows(candidates.rows, screening).map((r) => ({
    id: r.id, title: r.title, year: r.year,
    because: strict.filter((c) => { const cell = screening.cells?.[r.id]?.[c.id]; return !cell || cell.state !== 'filled' || cell.value === 'unclear'; }).map((c) => c.text),
    include: true,
  }));
}

// ---------- counts, synthesis, publishing ----------

/**
 * The numbers the method section and the progress line report, from the files alone.
 * @param {import("./domain").Candidates | null} candidates @param {import("./domain").Screening | null} screening @param {import("./domain").ReviewTable | null} table
 */
export function countsOf(candidates, screening, table) {
  const found = candidates?.rows.length ?? 0;
  const excluded = screening ? (candidates?.rows ?? []).filter((r) => !isIncluded(screening.decisions[r.id])).length : 0;
  return { candidates: found, included: found - excluded, excluded, extracted: table?.rows.length ?? 0 };
}

/** @param {import("./domain").ReviewTable} table */
function tableForWriter(table) {
  return {
    columns: table.columns,
    rows: table.rows.map((r) => ({ id: r.id, title: r.title, citekey: r.ref.kind === 'paper' ? r.ref.citekey : null, year: r.year })),
    cells: Object.fromEntries(table.rows.map((r) => [r.id, Object.fromEntries(table.columns.flatMap((c) => {
      const cell = table.cells[r.id]?.[c.id];
      return cell?.state === 'filled' ? [[c.id, cell.value]] : [];
    }))])),
  };
}

/**
 * The writer's report with its evidence checked against the table: a cell that is not there (or has no value) is
 * dropped, and a source that is not an included paper is dropped, so a link the UI follows always lands. A source is a
 * table row id or a citekey (spec 030 R9): a library paper becomes its citekey, a paper outside the library its link
 * (DOI or URL) in `links`. Before, only citekeys counted, so a report on outside papers had no evidence at all.
 * @param {any} out @param {import("./domain").ReviewTable} table
 */
export function checkEvidence(out, table) {
  /** @type {Map<string, import("./domain").PaperRow>} */
  const byKey = new Map();
  for (const r of table.rows) {
    byKey.set(r.id, r);
    if (r.ref.kind === 'paper') byKey.set(r.ref.citekey, r);
  }
  const linkOf = (/** @type {import("./domain").PaperRow} */ r) => (r.doi ? `https://doi.org/${r.doi}` : r.url || (r.ref.kind === 'web' ? r.ref.url : '')) || null;
  const evidence = (Array.isArray(out?.evidence) ? out.evidence : []).map((e) => {
    const rows = [...new Set((e.sources ?? []).map((k) => byKey.get(String(k))).filter(Boolean))];
    const sources = rows.flatMap((r) => (r.ref.kind === 'paper' ? [r.ref.citekey] : []));
    const links = rows.flatMap((r) => (r.ref.kind === 'paper' || !linkOf(r) ? [] : [{ url: /** @type {string} */ (linkOf(r)), title: r.title, year: r.year ?? null }]));
    return {
      claim: e.claim, strength: e.strength, sources, ...(links.length ? { links } : {}),
      cells: (e.cells ?? []).filter((c) => table.cells[c.row]?.[c.column]?.state === 'filled'),
    };
  }).map((e) => {
    // A claim resting on a cell read from an unchecked abstract says so (the model cannot add or drop this flag).
    const unverified = e.cells.some((c) => /** @type {any} */ (table.cells[c.row][c.column]).unverified);
    return unverified ? { ...e, unverified: true } : e;
  });
  return { ...out, evidence };
}

/** @param {StageCtx} ctx */
export async function synthesize2Stage(ctx) {
  const table = /** @type {import("./domain").ReviewTable} */ (await ctx.read('table.json'));
  const candidates = /** @type {import("./domain").Candidates} */ (await ctx.read('candidates.json'));
  const screening = /** @type {import("./domain").Screening} */ (await ctx.read('screening.json'));
  const counts = countsOf(candidates, screening, table);
  const references = table.rows.map((r) => ({ citekey: r.ref.kind === 'paper' ? r.ref.citekey : null, doi: r.doi, url: r.url, title: r.title, year: r.year, inLibrary: r.inLibrary }));
  const prompt = writerPrompt2(ctx.request, tableForWriter(table), counts);
  if (skillSection(ctx.request)) {
    const skilled = /** @type {{ title: string; scope: string; method: string; body: string }} */ (await ctx.turns.structured('writer', prompt, SKILL_REPORT_SCHEMA, noTools(ctx, 'writer'), ctx.signal));
    return skillReport(skilled, new Set(references.flatMap((r) => (r.citekey ? [r.citekey] : []))), references);
  }
  const out = await ctx.turns.structured('writer', prompt, REPORT_SCHEMA_2, noTools(ctx, 'writer'), ctx.signal);
  const checked = checkEvidence(out, table);
  // spec 031 R4: what the papers were read from, written by our code, not the model
  const read = readSentence(table.rows);
  return { ...checked, ...(read ? { method: [checked.method, read].filter(Boolean).join(' ') } : {}), references };
}

/** @param {StageCtx} ctx */
export async function publish2Stage(ctx) {
  const report = /** @type {import("./domain").Report} */ (await ctx.read('report.json'));
  const candidates = /** @type {import("./domain").Candidates} */ (await ctx.read('candidates.json'));
  const screening = /** @type {import("./domain").Screening} */ (await ctx.read('screening.json'));
  const table = /** @type {import("./domain").ReviewTable} */ (await ctx.read('table.json'));
  const plan = ctx.request.systematic ? /** @type {Plan} */ (await ctx.read('approved-plan.json')) : null;
  const roleModel = await ctx.getRoleModel('writer');
  const modelLabel = roleModel.model ? `${roleModel.provider}/${roleModel.model}` : roleModel.provider;
  const { markdown, frontMatter } = renderReport(report, ctx.request, { model: modelLabel, date: new Date().toISOString().slice(0, 10) }, candidates.searchLog, { counts: countsOf(candidates, screening, table), screening, table, protocol: plan?.protocol ?? null });
  return ctx.notes.publish({ reviewId: ctx.reviewId, title: report.title, markdown, frontMatter });
}
