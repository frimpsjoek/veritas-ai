// @ts-check
// agent-src/src/sessions.js. Spec 007 E1: sessions are conversations that grew steps. Everything here is pure --
// no fs, no network -- so a session's shape can be rebuilt (and tested) straight from its JSONL records, the
// same way conversationStore rebuilds a conversation's history by re-reading its file (store.js's own comment).

/** @param {string} id @returns {string} the results directory for a session */
export function resultsDir(id) {
  return `${id}.d/results`;
}

/** @param {string} id @param {string} resultId @param {number} version */
export function resultPath(id, resultId, version) {
  return `${resultsDir(id)}/${resultId}/v${version}.json`;
}

/** @param {string} id @param {string} stepId */
export function partialStepPath(id, stepId) {
  return `${id}.d/steps/${stepId}.partial.jsonl`;
}

/** Next "S<n>" id given the steps already recorded (step records only; a session's own JSONL is the only source
 *  of truth). @param {{ type: string, id?: string }[]} records */
export function nextStepId(records) {
  return nextId(records, 'step', 'S');
}

/** Next "R<n>" id given the results already written (one `result` record per version; the id itself repeats
 *  across versions, so we look at ref.id, not `records.length`). @param {any[]} records */
export function nextResultId(records) {
  let max = 0;
  for (const r of records) {
    if (r.type !== 'result') continue;
    const n = Number(String(r.summary?.ref?.id ?? '').replace(/^R/, ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `R${max + 1}`;
}

function nextId(records, type, prefix) {
  let max = 0;
  for (const r of records) {
    if (r.type !== type) continue;
    const n = Number(String(r.id ?? '').replace(new RegExp(`^${prefix}`), ''));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

/**
 * Rebuilds a session's steps, results and current result from its JSONL alone (§1.3). A `result` file with no
 * `result` record (a crash between the two writes) simply never appears here, since this reads records only; a
 * `step` with no matching `step_end` shows as still "running" (resumable, §5.4).
 * @param {any[]} records
 * @returns {{ steps: SessionStep[]; results: import("./domain").ResultSummary[]; current: import("./domain").ResultRef | null }}
 */
export function manifest(records) {
  /** @type {SessionStep[]} */
  const steps = [];
  const stepById = new Map();
  /** @type {Map<string, import("./domain").ResultSummary>} */
  const latestByResult = new Map();
  const versionsByResult = new Map();
  /** @type {import("./domain").ResultRef | null} */
  let current = null;

  for (const r of records) {
    if (r.type === 'step') {
      /** @type {SessionStep} */
      const step = { id: r.id, input: r.input, reads: r.reads ?? [], at: r.at, status: 'running', writes: [], line: undefined, error: undefined };
      stepById.set(r.id, step);
      steps.push(step);
    } else if (r.type === 'step_end') {
      const step = stepById.get(r.id);
      if (!step) continue;
      step.status = r.status;
      step.writes = r.writes ?? [];
      step.line = r.line;
      step.error = r.error;
    } else if (r.type === 'result') {
      const id = r.summary.ref.id;
      versionsByResult.set(id, (versionsByResult.get(id) ?? 0) + 1);
      latestByResult.set(id, r.summary);
    } else if (r.type === 'current') {
      current = r.ref;
    }
  }

  const results = [...latestByResult.values()].map((summary) => ({
    ...summary,
    versions: versionsByResult.get(summary.ref.id) ?? summary.versions,
  }));

  if (!current && results.length) current = results[results.length - 1].ref;

  return { steps, results, current };
}

/**
 * How an old conversation (no step/result/current records at all) maps in read-time as a stack of `chat` (or
 * `ask`) steps writing virtual `answer` results (§1.4). Nothing is written to disk; the "answer" result exists
 * only for the duration of this call.
 * @param {any[]} records
 * @returns {{ steps: SessionStep[]; results: import("./domain").ResultSummary[]; current: import("./domain").ResultRef | null }}
 */
export function legacyView(records) {
  const meta = records.find((r) => r.type === 'meta');
  const mode = meta?.mode === 'ask' ? 'ask' : 'chat';
  /** @type {SessionStep[]} */
  const steps = [];
  let n = 0;
  /** @type {any} */
  let pendingUser = null;

  for (const r of records) {
    if (r.type === 'user') {
      pendingUser = r;
    } else if (r.type === 'assistant' && pendingUser) {
      n += 1;
      const stepId = /** @type {import("./domain").StepId} */ (`S${n}`);
      const resultRef = /** @type {import("./domain").ResultRef} */ ({ id: `R${n}`, version: 1 });
      /** @type {SessionStep} */
      const step = {
        id: stepId, input: { kind: mode, text: pendingUser.text }, reads: [], at: r.at,
        status: 'done', writes: [resultRef], line: undefined, error: undefined,
        virtualAnswer: { ref: resultRef, kind: 'answer', title: pendingUser.text.slice(0, 60), created: r.at, madeBy: stepId, from: [], change: '', answer: r.answer },
      };
      steps.push(step);
      pendingUser = null;
    } else if (r.type === 'failed' && pendingUser) {
      n += 1;
      steps.push({ id: `S${n}`, input: { kind: mode, text: pendingUser.text }, reads: [], at: r.at, status: 'failed', writes: [], line: undefined, error: r.error });
      pendingUser = null;
    }
  }
  // Legacy `answer` results are virtual (§1.2, AnswerResult) and never listed as artifacts (§ "words used here":
  // "answer results are not shown as cards"), so `results` here stays empty by design.
  return { steps, results: [], current: null };
}

/** True when a session's JSONL has never had a step/result/current record written to it: it's still an "old"
 *  chat and should be read through `legacyView`, not `manifest`. @param {any[]} records */
export function isLegacy(records) {
  return !records.some((r) => r.type === 'step' || r.type === 'result' || r.type === 'current');
}

/**
 * Papers routine runs added since the user last opened the session (spec 011 U4 follow-up). A `routine_run` record is
 * news when it is newer than the last `seen` record; a session with neither (every older chat) has none. Omitted
 * when 0. @param {any[]} records @returns {{ papers: number, at: string } | undefined}
 */
export function newsOf(records) {
  let seen = '';
  for (const r of records) if (r.type === 'seen' && r.at > seen) seen = r.at;
  let papers = 0, at = '';
  for (const r of records) {
    if (r.type !== 'routine_run' || r.at <= seen) continue;
    papers += Math.max(0, Number(r.added) || 0);
    if (r.at > at) at = r.at;
  }
  return papers > 0 ? { papers, at } : undefined;
}

/**
 * The session's `kind` and artifact count for `ConversationSummary` (§1.3).
 * @param {any[]} records
 * @returns {{ artifacts: number; kind: "chat" | "find" | "report" | "systematic" }}
 */
export function summaryExtras(records) {
  if (isLegacy(records)) {
    return { artifacts: 0, kind: 'chat' };
  }
  const { steps, results } = manifest(records);
  const first = steps[0];
  /** @type {"chat" | "find" | "report" | "systematic"} */
  let kind = 'chat';
  if (first) {
    // A `report` step whose request is a systematic review reads as "systematic" (spec 007 E8).
    if (first.input.kind === 'find' || first.input.kind === 'import') kind = 'find';
    else if (first.input.kind === 'report') kind = first.input.request?.systematic ? 'systematic' : 'report';
  }
  return { artifacts: results.filter((r) => r.kind === 'papers' || r.kind === 'table' || r.kind === 'report').length, kind };
}

/** Markdown down to one plain sentence: no headings, emphasis, links or [@citekey] marks, at most `max` characters. @param {string} text @param {number} [max] */
export function firstSentence(text, max = 180) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#+\s.*$/gm, ' ')
    .replace(/^\s*([-*>]|\d+\.)\s+/gm, '')
    .replace(/\[\[[^\]]*\]\]|\[@[^\]]*\]|\[\^?\d+\]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`|]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  const end = plain.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? plain.slice(0, end + 1) : plain;
  return sentence.length > max ? `${sentence.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : sentence;
}

const plural = (/** @type {number} */ n, /** @type {string} */ one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A machine-made file name (a 20+ character run with no spaces, like "stn-UYsg1j5y8PFZRFN…") reads as what the
 *  attachment is: "Summarize stn-UYsg…" becomes "Summarize an image". @param {string} text @param {any[]} attachments */
export function readableQuestion(text, attachments) {
  const note = attachments.find((a) => a?.kind === 'note')?.path ?? '';
  const what = /\.(png|jpe?g|gif|webp|heic|tiff?)$/i.test(note) ? 'an image' : /\.pdf$/i.test(note) ? 'a PDF' : 'a note';
  return text.replace(/(?<![\w/])[\w-]*(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{20,}(\.\w+)?/g, what).replace(/\s+/g, ' ').trim();
}

/**
 * The words on a session's cover in the web app's Home shelf: a quote under the title and who it is "by". A session
 * holding a report reads as that report (its title, the question asked, how many papers). A radar run reads as its top
 * paper. A find reads as its query. A chat reads as its first question and the opening of its last answer.
 * @param {any[]} records
 * @returns {import("./domain").SessionCover | undefined}
 */
export function coverOf(records) {
  const { steps, results } = isLegacy(records) ? { steps: [], results: [] } : manifest(records);
  const papers = Math.max(0, ...results.filter((r) => r.kind === 'papers').map((r) => Number(r.rows) || 0));
  const report = [...results].reverse().find((r) => r.kind === 'report');
  if (report) {
    const step = [...steps].reverse().find((s) => s.input?.kind === 'report');
    const asked = step?.input.kind === 'report' ? step.input.request?.question : undefined;
    return { kind: 'report', title: report.title, ...(asked ? { quote: firstSentence(asked) } : {}), ...(papers ? { by: plural(papers, 'paper') } : {}) };
  }
  const run = [...records].reverse().find((r) => r.type === 'routine_run' && r.top);
  if (steps[0]?.input?.kind === 'radar') {
    return { kind: 'radar', ...(run ? { quote: firstSentence(run.top.title), ...(run.top.by ? { by: run.top.by } : {}) } : {}), ...(papers ? { count: plural(papers, 'new paper') } : {}) };
  }
  if (steps[0]?.input?.kind === 'find') {
    return { kind: 'find', quote: firstSentence(steps[0].input.query ?? ''), ...(papers ? { by: plural(papers, 'paper') } : {}) };
  }
  const first = records.find((r) => r.type === 'user');
  const asked = first?.text ? readableQuestion(first.text, first.attachments ?? []) : undefined;
  const answer = [...records].reverse().find((r) => r.type === 'assistant')?.answer;
  const cited = (answer?.citations ?? []).filter((/** @type {any} */ c) => c.status === 'resolved').length;
  const said = answer?.text ? firstSentence(answer.text) : '';
  if (!asked && !said) return undefined;
  return { kind: 'chat', ...(asked ? { title: firstSentence(asked, 90) } : {}), ...(said ? { quote: said } : {}), ...(cited ? { by: plural(cited, 'source') } : {}) };
}

// ---------- legacy importers (pure; shared by both hosts per plan.md) ----------

/** @param {string} s */
function slugColumn(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
}

/** Builds a `RowId` for a paper the same way across every importer and extract.js batch (§1.1 sketch). Prefers a
 *  citekey (Zotero identity), then a DOI (identity across outside sources), then a stable hash of the title.
 *  @param {{ citekey?: string | null; doi?: string | null; title?: string | null }} p @param {number} idx */
export function rowIdFor(p, idx) {
  const raw = p.citekey ? `p:${p.citekey}` : p.doi ? `doi:${p.doi.toLowerCase()}` : p.title ? `t:${titleHash(p.title)}` : `x:${idx}`;
  return /** @type {import("./domain").RowId} */ (raw);
}

function titleHash(title) {
  let h = 0;
  const s = title.toLowerCase().replace(/\s+/g, ' ').trim();
  for (let i = 0; i < s.length; i++) { h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

/**
 * A saved Find papers search (Zotero's `second-brain/searches/find-*.json` or Obsidian's finds shape) as a
 * `PapersResult`'s rows. Both shapes carry a flat `papers`/`rows` array with roughly the same fields; unknown or
 * missing fields become the type's explicit "not known" value, never guessed. §1.4.
 * @param {{ query?: string | null; papers?: any[]; rows?: any[]; summary?: { markdown: string; citations: any[] } | null }} saved
 * @returns {{ query: string | null; rows: import("./domain").PaperRow[]; summary: { markdown: string; citations: any[] } | null }}
 */
export function papersFromFind(saved) {
  const list = saved.papers ?? saved.rows ?? [];
  const rows = list.map((p, i) => ({
    id: rowIdFor(p, i),
    ref: p.citekey ? { kind: 'paper', citekey: p.citekey } : (p.doi ? { kind: 'web', url: `https://doi.org/${p.doi}` } : { kind: 'web', url: p.url ?? '' }),
    inLibrary: Boolean(p.inLibrary ?? p.citekey),
    title: p.title ?? '(untitled)',
    authors: p.authors ?? [],
    year: p.year ?? null,
    venue: p.venue ?? '',
    doi: p.doi ?? null,
    url: p.url ?? null,
    abstract: p.abstract ?? '',
    citations: p.citations ?? null,
    fullText: Boolean(p.fullText),
    pdfUrl: p.pdfUrl ?? null,
    studyType: p.studyType ?? null,
    foundBy: p.foundBy ?? (p.source ? [p.source] : []),
  }));
  return { query: saved.query ?? null, rows: /** @type {import("./domain").PaperRow[]} */ (rows), summary: saved.summary ?? null };
}

/**
 * A review's `screened.json` (§1.4: "sources + outside") as a `PapersResult`'s rows, for "Add step" on a review
 * made before this spec.
 * @param {{ sources?: any[]; outside?: any[] }} screened
 * @returns {import("./domain").PaperRow[]}
 */
export function papersFromReview(screened) {
  const all = [...(screened.sources ?? []), ...(screened.outside ?? [])];
  return /** @type {import("./domain").PaperRow[]} */ (all.map((s, i) => ({
    id: rowIdFor(s, i),
    ref: s.citekey ? { kind: 'paper', citekey: s.citekey } : { kind: 'web', url: s.doi ? `https://doi.org/${s.doi}` : (s.url ?? '') },
    inLibrary: Boolean(s.inLibrary ?? s.citekey),
    title: s.title ?? '(untitled)',
    authors: s.authors ?? [],
    year: s.year ?? null,
    venue: s.venue ?? '',
    doi: s.doi ?? null,
    url: s.url ?? null,
    abstract: s.abstract ?? '',
    citations: s.citations ?? null,
    fullText: Boolean(s.fullText),
    pdfUrl: s.pdfUrl ?? null,
    studyType: s.studyType ?? null,
    foundBy: s.foundBy ?? [],
  })));
}

// ---------- read_result rendering (§1.5) ----------

/** @param {import("./domain").CitationRef} ref */
function labelForRef(ref) {
  if (ref.kind === 'note') return `[[${ref.path}]]`;
  if (ref.kind === 'paper') return `[@${ref.citekey}]`;
  return ref.url;
}

/**
 * The compact text rendering `read_result` returns: a header line, then one line per row (§1.5). Paging is by
 * character offset (`maxChars`), not by row, so a caller can always resume exactly where it left off.
 * @param {import("./domain").Result} result
 * @param {{ rows?: string[]; columns?: string[]; offset?: number; maxChars?: number; abstracts?: boolean }} opts
 * @returns {{ text: string; seen: import("./domain").CitationRef[]; nextOffset: number | null }}
 */
export function renderResult(result, opts = {}) {
  const maxChars = opts.maxChars ?? 12000;
  const offset = opts.offset ?? 0;
  if (result.kind === 'answer' || result.kind === 'report') {
    const body = result.kind === 'report' ? `Report ${result.ref.id} points at review ${result.review}; read it with the review tools.`
      : result.answer.text;
    const header = `${result.ref.id} "${result.title}" V${result.ref.version} · ${result.kind}`;
    const full = `${header}\n${body}`;
    const page = full.slice(offset, offset + maxChars);
    return { text: page, seen: [], nextOffset: offset + maxChars < full.length ? offset + maxChars : null };
  }

  // `result` is now known to be PapersResult | TableResult (answer/report returned above); each has its own row
  // shape (a paper vs. a free-table row-with-label), so the per-row label line is built per kind.
  const columnFilter = opts.columns?.length ? new Set(opts.columns) : null;
  const rowFilter = opts.rows?.length ? new Set(opts.rows) : null;
  const columns = result.columns.filter((c) => !columnFilter || columnFilter.has(c.id) || columnFilter.has(c.name));
  const rows = result.rows;
  const visibleRows = rowFilter ? rows.filter((r) => rowFilter.has(r.id)) : rows;

  const header = `${result.ref.id} "${result.title}" V${result.ref.version} · ${result.kind} · ${rows.length} rows${columns.length ? ` · columns: ${columns.map((c) => c.name).join(', ')}` : ''}`;

  /** @type {import("./domain").CitationRef[]} */
  const seen = [];
  const lines = visibleRows.map((genericRow) => {
    let label;
    if (result.kind === 'papers') {
      const row = /** @type {import("./domain").PaperRow} */ (genericRow);
      seen.push(row.ref);
      label = `${row.id} ${labelForRef(row.ref)} — ${row.title}${row.year ? ` (${row.year})` : ''}`;
    } else {
      const row = /** @type {{ id: string; label: string }} */ (genericRow);
      label = `${row.id} ${row.label}`;
    }
    const row = genericRow;
    const parts = [label];
    if (opts.abstracts && result.kind === 'papers') {
      const abstract = /** @type {import("./domain").PaperRow} */ (genericRow).abstract?.trim();
      parts.push(`   Abstract: ${abstract ? (abstract.length > 1500 ? `${abstract.slice(0, 1500)}...` : abstract) : '(none available)'}`);
    }
    for (const col of columns) {
      const cell = result.cells?.[row.id]?.[col.id];
      if (!cell) continue;
      if (cell.state === 'filled') {
        // Quotes only when the caller named specific columns (§1.5: "to keep it short").
        const quotes = columnFilter && cell.quotes.length ? ` (“${cell.quotes.map((q) => q.text).join('”, “')}”)` : '';
        parts.push(`   ${col.name}: ${cell.value}${quotes}`);
      } else if (cell.state === 'not_found') {
        parts.push(`   ${col.name}: ${cell.note}`);
      } else if (cell.state === 'pending') {
        parts.push(`   ${col.name}: (filling)`);
      }
    }
    return parts.join('\n');
  });

  const body = lines.join('\n');
  const full = `${header}\n${body}`;
  const page = full.slice(offset, offset + maxChars);
  const nextOffset = offset + maxChars < full.length ? offset + maxChars : null;
  // The model has to know there is more, or it answers from the first page as if it were the whole set.
  return { text: nextOffset == null ? page : `${page}\n[more rows: call read_result again with offset ${nextOffset}]`, seen, nextOffset };
}

/**
 * The manifest block put into every turn's instructions when the turn carries a session (§1.5), capped at 1,200
 * characters as the spec says. Kept as one line per result so `read_result` calls can name a result exactly.
 * @param {{ results: import("./domain").ResultSummary[]; current: import("./domain").ResultRef | null }} view
 */
export function manifestBlock(view) {
  if (!view.results.length) return '';
  const lines = view.results.map((r) => {
    const marker = view.current && view.current.id === r.ref.id ? ' (current)' : '';
    const cols = r.columns.length ? `, columns: ${r.columns.join(', ')}` : '';
    const rows = r.rows != null ? `, ${r.rows} rows` : '';
    return `- ${r.ref.id} "${r.title}" V${r.ref.version} · ${r.kind}${rows}${cols}${marker}`;
  });
  const block = [
    'This session already holds these results:',
    ...lines,
    'When the question is about these results, read them with read_result before searching again. Cite papers by the labels it returns.',
  ].join('\n');
  return block.length > 1200 ? `${block.slice(0, 1197)}...` : block;
}

/** Rows of a papers result that a `chat_papers` turn is scoped to (`rows: "all"` is every row).
 *  @param {import("./domain").Result | null} result @param {import("./domain").RowId[] | "all"} rows
 *  @returns {import("./domain").PaperRow[]} */
export function subsetRows(result, rows) {
  if (!result || result.kind !== 'papers') return [];
  if (rows === 'all') return result.rows;
  const want = new Set(rows);
  return result.rows.filter((r) => want.has(r.id));
}

/**
 * The scope block of a `chat_papers` turn (§6). Every turn says which set it is about; the first one also lists the
 * subset's titles and years inline (compact, capped) so a short question needs no tool call.
 * @param {import("./domain").ResultSummary | null} summary @param {import("./domain").PaperRow[]} rows @param {number} total
 * @param {{ result: import("./domain").ResultRef }} on @param {boolean} first @param {number} [cap]
 */
export function chatPapersBlock(summary, rows, total, on, first, cap = 6000) {
  const head = `You are chatting with ${rows.length === total ? `all ${total}` : `${rows.length} of ${total}`} papers of ${on.result.id}${summary ? ` "${summary.title}"` : ''}. Read them with read_result (result "${on.result.id}"); only these papers exist for this question.`;
  if (!first) return head;
  const lines = rows.map((r) => `- ${labelForRef(r.ref)} ${r.title}${r.year ? ` (${r.year})` : ''}${r.inLibrary ? '' : ' [outside your library]'}`);
  let out = `${head}\nThe papers:`;
  let shown = 0;
  for (const line of lines) {
    if (out.length + line.length + 1 > cap - 120) break;
    out += `\n${line}`; shown += 1;
  }
  if (shown < lines.length) out += `\n... and ${lines.length - shown} more; read_result lists them all.`;
  return out;
}

/**
 * @typedef {{
 *   id: string; input: import("./domain").StepInput; reads: import("./domain").ResultRef[]; at: string;
 *   status: "running" | "done" | "failed" | "cancelled" | "stopped";
 *   writes: import("./domain").ResultRef[]; line?: unknown; error?: import("./domain").AgentError;
 *   virtualAnswer?: import("./domain").AnswerResult;
 * }} SessionStep
 */
export const __types = true;
