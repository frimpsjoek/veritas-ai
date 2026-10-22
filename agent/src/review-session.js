// @ts-check
// agent-src/src/review-session.js. Spec 007 §2.1 "Session link": what a finished pipeline-2 review adds to the
// session it was started from. Pure: given the review's files, the results to write.
import { isIncluded, unclearList } from './review2.js';

/**
 * One `papers` result holding every candidate, with the screening criteria and the extraction columns as columns
 * and the AI's / the user's screening decisions beside them. Rows the screening excluded stay (the Screening
 * filter shows them); their extraction cells simply do not exist.
 * @param {{ candidates: import("./domain").Candidates; screening: import("./domain").Screening & { cells?: Record<string, Record<string, import("./domain").Cell>> }; table: import("./domain").ReviewTable; plan: import("./domain").Plan; question: string }} f
 * @returns {Omit<import("./domain").PapersResult, "ref" | "madeBy" | "created" | "from">}
 */
export function papersResultFromReview(f) {
  const criteria = (f.screening.criteria ?? []).map((c) => /** @type {import("./domain").ColumnSpec} */ ({ id: c.id, name: c.text, instruction: `Meets this criterion: ${c.text}`, kind: 'criterion' }));
  const columns = [...criteria, ...f.table.columns];
  /** @type {import("./domain").PapersResult["cells"]} */
  const cells = {};
  for (const r of f.candidates.rows) {
    /** @type {Record<string, import("./domain").Cell>} */
    const row = { ...(f.screening.cells?.[r.id] ?? {}), ...(f.table.cells[r.id] ?? {}) };
    if (Object.keys(row).length) cells[/** @type {any} */ (r.id)] = /** @type {any} */ (row);
  }
  return {
    kind: 'papers', title: f.question.length > 80 ? `${f.question.slice(0, 77)}...` : f.question, query: f.question,
    change: `Papers from the report: ${f.candidates.rows.filter((r) => isIncluded(f.screening.decisions[r.id])).length} of ${f.candidates.rows.length} kept`,
    rows: f.candidates.rows, columns, cells,
    screening: f.screening.criteria?.length ? /** @type {any} */ (f.screening.decisions) : null,
    summary: null,
  };
}

/** The virtual session id and result id the artifact panel uses to open a review's screened papers while it waits. */
export const SCREENING_RESULT_ID = 'screening';
export const screeningSessionId = (/** @type {string} */ review) => `review:${review}`;

/**
 * spec 007 E8: the screened papers of a systematic review, as a `papers` result the artifact panel can show while the
 * review waits on its unclear papers. Virtual: built from the review's files at read time and never stored, so it
 * cannot go stale (once the researcher has answered, `gate` disappears and the user's calls show in `screening`).
 * `gate` lists the rows the researcher may still toggle; the answer goes through the same `reviews.screened` as the
 * report card's.
 * @param {{ review: string; candidates: import("./domain").Candidates; screening: import("./domain").Screening & { cells?: Record<string, Record<string, import("./domain").Cell>> }; question: string; reviewed: boolean; at: string }} f
 * @returns {import("./domain").PapersResult}
 */
export function screeningResult(f) {
  const criteria = (f.screening.criteria ?? []).map((c) => /** @type {import("./domain").ColumnSpec} */ ({ id: c.id, name: c.text, instruction: `Meets this criterion: ${c.text}`, kind: 'criterion' }));
  /** @type {import("./domain").PapersResult["cells"]} */
  const cells = {};
  for (const r of f.candidates.rows) if (f.screening.cells?.[r.id]) cells[/** @type {any} */ (r.id)] = /** @type {any} */ (f.screening.cells[r.id]);
  const unclear = f.reviewed ? [] : unclearList(f.candidates, f.screening).map((u) => ({ id: u.id, because: u.because }));
  return {
    kind: 'papers', title: 'Screened papers', query: f.question,
    change: `Screened ${f.candidates.rows.length} papers: ${f.candidates.rows.filter((r) => isIncluded(f.screening.decisions[r.id])).length} kept`,
    ref: /** @type {any} */ ({ id: SCREENING_RESULT_ID, version: 1 }), madeBy: /** @type {any} */ ('S0'), from: [], created: f.at,
    rows: f.candidates.rows, columns: criteria, cells,
    screening: /** @type {any} */ (f.screening.decisions),
    summary: null,
    ...(unclear.length ? { gate: { review: /** @type {any} */ (f.review), unclear } } : {}),
  };
}

/**
 * "Write a report from this" (spec 007 §2.1 `synthesize` step): the files that let pipeline 2 start at the writer,
 * from a session result. A papers result gives its non-criterion columns; a chat-made table gives its columns and
 * one pseudo-paper per row (title = the row's label, ref = the first paper it cites). A row with no filled cell is
 * left out, and a table with nothing filled cannot be written from.
 * @param {import("./domain").Result} result @param {string} question
 * @returns {{ candidates: import("./domain").Candidates; screening: import("./domain").Screening; table: import("./domain").ReviewTable }}
 */
export function seedFromResult(result, question) {
  if (result.kind !== 'papers' && result.kind !== 'table') throw new Error('A report can be written from a paper set or a table.');
  /** @type {import("./domain").PaperRow[]} */
  let rows;
  if (result.kind === 'papers') rows = result.rows;
  else {
    rows = result.rows.map((r, i) => {
      const cited = Object.values(result.cells[r.id] ?? {}).flatMap((c) => (c.state === 'filled' ? c.citations : [])).find((c) => c.kind === 'paper' || c.kind === 'web');
      const ref = cited ?? { kind: /** @type {const} */ ('web'), url: '' };
      return /** @type {import("./domain").PaperRow} */ ({
        id: r.id, ref, inLibrary: ref.kind === 'paper', title: r.label || `Row ${i + 1}`, authors: [], year: null, venue: '', doi: null, url: ref.kind === 'web' ? ref.url || null : null,
        abstract: '', citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: [],
      });
    });
  }
  const columns = result.columns.filter((c) => c.kind !== 'criterion');
  const filled = (id) => columns.some((c) => result.cells[id]?.[c.id]?.state === 'filled');
  const kept = rows.filter((r) => filled(r.id));
  if (!kept.length) throw new Error('Nothing is filled in yet: add columns first, then write the report.');
  /** @type {import("./domain").ReviewTable["cells"]} */
  const cells = {};
  for (const r of kept) cells[r.id] = Object.fromEntries(columns.map((c) => [c.id, result.cells[r.id]?.[c.id] ?? { state: /** @type {const} */ ('pending') }]));
  /** @type {import("./domain").Screening["decisions"]} */
  const decisions = {};
  for (const r of rows) decisions[r.id] = { ai: 'include', because: [], user: kept.includes(r) ? null : 'exclude' };
  void question;
  return { candidates: { rows, searchLog: [] }, screening: { decisions, criteria: [], perCriterion: {} }, table: { columns, rows: kept, cells } };
}
