// @ts-check
// ui-src/src/chat/artifact-data.js. The artifact panel's logic with no DOM: the card's one-line description, which
// rows a search keeps, how a sort orders them, and the version menu's dates. Pure, so node tests cover it
// (test/artifact-data.test.js) and the panel and the narrow card list share one answer.
import { toGrid, cellPlain } from '../export/common.js';

/** @typedef {import("../../../agent/src/domain").ResultSummary} ResultSummary */
/** @typedef {import("../../../agent/src/domain").Result} Result */
/** @typedef {import("../export/common.js").Grid} Grid */
/** @typedef {import("../export/common.js").GridRow} GridRow */
/** @typedef {{ key: string, dir: "asc" | "desc" }} SortState */
/** @typedef {{ hasPdf?: boolean, yearFrom?: number | null, yearTo?: number | null, studyTypes?: string[], contains?: string[], excludes?: string[],
 *             library?: "in" | "out" | null, screening?: string[], column?: { id: string, text: string } | null }} Filters */
/** @typedef {import("../../../agent/src/domain").ColumnSpec} ColumnSpec */
/** @typedef {import("../../../agent/src/domain").Cell} Cell */

export const KIND_NAME = { papers: 'Papers', table: 'Table', report: 'Report', answer: 'Answer' };
export const KIND_ICON = { papers: 'paper', table: 'table', report: 'report', answer: 'chat' };

/** "3 rows", "1 row". @param {number} n */
const rowsWord = (n) => `${n} ${n === 1 ? 'row' : 'rows'}`;

/**
 * The card's second line: "Table · 9 rows · V2", "Papers · 40 · 2 columns · V1"; an older version says a newer
 * one exists: "V1 · a newer version exists".
 * @param {ResultSummary} summary @param {number} version the version this card shows @param {boolean} older
 */
export function cardMeta(summary, version, older) {
  const parts = [KIND_NAME[summary.kind] ?? 'Result'];
  if (summary.rows != null) parts.push(summary.kind === 'papers' ? String(summary.rows) : rowsWord(summary.rows));
  const columns = summary.columns?.length ?? 0;
  if (summary.kind === 'papers' && columns) parts.push(`${columns} ${columns === 1 ? 'column' : 'columns'}`);
  parts.push(older ? `V${version} · a newer version exists` : `V${version}`);
  return parts.join(' · ');
}

/** "26 Sep 2026", or the time for today. @param {string} iso @param {Date} [now] */
export function shortDate(iso, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

/** Everything a search looks in for one row: title, authors, abstract, venue and every cell's words.
 *  @param {GridRow} row */
export function rowText(row) {
  const p = row.paper;
  const parts = [row.label];
  if (p) parts.push(p.authors.join(' '), p.abstract, p.venue, String(p.year ?? ''));
  for (const cell of Object.values(row.cells)) parts.push(cellPlain(cell));
  return parts.join('\n').toLowerCase();
}

/** @param {GridRow[]} rows @param {string} query */
export function searchRows(rows, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((row) => { const text = rowText(row); return words.every((w) => text.includes(w)); });
}

/** What the Sort menu offers: the paper's year and citations, its title, then every column. Never hidden data:
 *  a key no row has a value for is simply not offered.
 *  @param {Grid} grid @returns {{ key: string, label: string }[]} */
export function sortOptions(grid) {
  const out = [];
  if (grid.isPapers) {
    out.push({ key: 'title', label: 'Title' }, { key: 'year', label: 'Year' });
    if (grid.rows.some((r) => r.paper?.citations != null)) out.push({ key: 'citations', label: 'Citations' });
  } else out.push({ key: 'label', label: 'Name' });
  for (const column of grid.columns) out.push({ key: `col:${column.id}`, label: column.name });
  return out;
}

/** The value a row sorts by: a number for year/citations, text otherwise, null when it has none (those go last).
 *  @param {GridRow} row @param {string} key @returns {number | string | null} */
function sortValue(row, key) {
  if (key === 'year') return row.paper?.year ?? null;
  if (key === 'citations') return row.paper?.citations ?? null;
  if (key === 'title' || key === 'label') return row.label || null;
  const text = cellPlain(row.cells[key.replace(/^col:/, '')]).trim();
  return text || null;
}

/** A stable sort; rows with no value stay at the end whichever way it runs. @param {GridRow[]} rows @param {SortState | null} sort */
export function sortRows(rows, sort) {
  if (!sort || sort.key === 'none') return rows;
  const sign = sort.dir === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row, sort.key) }))
    .sort((a, b) => {
      if (a.value == null || b.value == null) return a.value == null && b.value == null ? a.index - b.index : a.value == null ? 1 : -1;
      const order = typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value
        : String(a.value).localeCompare(String(b.value), undefined, { numeric: true, sensitivity: 'base' });
      return order * sign || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** The rows the table shows: filters, then search, then sort; the columns in the user's order.
 *  `total` is every row of the version, so the panel can say "Showing 12 of 40".
 *  @param {Result} result @param {{ search?: string, sort?: SortState | null, filters?: Filters | null, order?: string[] | null }} view */
export function visibleRows(result, view) {
  const whole = toGrid(result);
  const grid = view.order?.length ? { ...whole, columns: applyOrder(whole.columns, view.order) } : whole;
  const rows = sortRows(searchRows(applyFilters(grid.rows, view.filters ?? null, result), view.search ?? ''), view.sort ?? null);
  return { grid, rows, total: grid.rows.length };
}

/** Columns in the order the user dragged them to; a column the order doesn't know keeps its place at the end.
 *  @template {{ id: string }} C @param {C[]} columns @param {string[]} order @returns {C[]} */
export function applyOrder(columns, order) {
  const rank = new Map(order.map((id, i) => [id, i]));
  return columns.map((c, i) => ({ c, i })).sort((a, b) => (rank.get(a.c.id) ?? 1e6 + a.i) - (rank.get(b.c.id) ?? 1e6 + b.i)).map((e) => e.c);
}

/** The Sort button's label. @param {Grid} grid @param {SortState | null} sort */
export function sortLabel(grid, sort) {
  if (!sort || sort.key === 'none') return 'Sort: None';
  const name = sortOptions(grid).find((o) => o.key === sort.key)?.label ?? 'None';
  return `Sort: ${name} ${sort.dir === 'desc' ? '↓' : '↑'}`;
}

/** Whether any cell in the result carries a quote (decides if "CSV with quotes" is offered). @param {Result} result */
export function hasQuotes(result) {
  return toGrid(result).rows.some((row) => Object.values(row.cells).some((cell) => cell.state === 'filled' && cell.quotes?.length));
}

/**
 * Every paper a table or paper set draws on, with the quotes behind its cells grouped under it (spec 011 U2's Sources
 * view). Rows with no quote are left out; a column's name sits beside each quote so it reads "Binding geometry: ...".
 * @param {Result} result
 * @returns {{ rowId: string, title: string, ref: import("../../../agent/src/domain").CitationRef | null, doi: string | null, year: number | null,
 *   quotes: { column: string, text: string, from: "abstract" | "full_text", verified: boolean }[] }[]}
 */
export function sourcesOf(result) {
  const grid = toGrid(result);
  const names = new Map(grid.columns.map((c) => [c.id, c.name]));
  const out = [];
  for (const row of grid.rows) {
    const quotes = [];
    for (const [columnId, cell] of Object.entries(row.cells)) {
      if (cell.state !== 'filled') continue;
      for (const q of cell.quotes ?? []) quotes.push({ column: names.get(/** @type {any} */ (columnId)) ?? columnId, text: q.text, from: q.from, verified: Boolean(q.verified) });
    }
    if (!quotes.length) continue;
    out.push({ rowId: row.id, title: row.label, ref: row.paper?.ref ?? null, doi: row.paper?.doi ?? null, year: row.paper?.year ?? null, quotes });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- columns (spec 007 §5.1)

/** The quiet "+" rows of the Columns panel, each with the instruction the extraction reads. @type {{ preset: NonNullable<ColumnSpec["preset"]>, name: string, instruction: string }[]} */
export const PRESETS = [
  { preset: 'summary', name: 'Summary', instruction: 'A two-sentence summary of what the paper did and what it found.' },
  { preset: 'main_findings', name: 'Main findings', instruction: 'The main findings of the paper, in one or two sentences.' },
  { preset: 'methodology', name: 'Methodology', instruction: 'How the study was done: its design, data and methods.' },
  { preset: 'intervention', name: 'Intervention', instruction: 'The intervention or treatment that was tested, and what it was compared with.' },
  { preset: 'outcome', name: 'Outcome measured', instruction: 'What was measured as the outcome, and how.' },
  { preset: 'limitations', name: 'Limitations', instruction: 'The limitations the authors mention, or that follow from the design.' },
  { preset: 'sample', name: 'Sample', instruction: 'Who or what was studied, and how many (the sample size).' },
  { preset: 'study_type', name: 'Study type', instruction: 'The kind of study: randomized trial, cohort study, review, case study and so on.' },
  { preset: 'population', name: 'Population', instruction: 'The population or setting the study covers.' },
];

/** A column id from its name: lower-case words joined by "-", made unique among `taken`. @param {string} name @param {Iterable<string>} taken */
export function columnId(name, taken) {
  const used = new Set(taken);
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'column';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** @param {(typeof PRESETS)[number]} preset @param {Iterable<string>} taken @returns {ColumnSpec} */
export function specFromPreset(preset, taken) {
  return /** @type {ColumnSpec} */ ({ id: columnId(preset.name, taken), name: preset.name, instruction: preset.instruction, kind: 'text', preset: preset.preset });
}

/** A free-text column: the instruction is the text as typed, nothing rewritten; the name is its first words.
 *  @param {string} text @param {Iterable<string>} taken @returns {ColumnSpec} */
export function specFromText(text, taken) {
  const instruction = text.trim().replace(/\s+/g, ' ');
  const name = instruction.length > 40 ? `${instruction.slice(0, 40).replace(/\s+\S*$/, '')}…` : instruction;
  return /** @type {ColumnSpec} */ ({ id: columnId(name.replace(/…$/, ''), taken), name, instruction, kind: 'text' });
}

/** "Fill 3 columns for 120 papers? About 15 turns." @param {{ columns: number, rows: number, turns: number, noun: string }} c */
export function confirmLine({ columns, rows, turns, noun }) {
  const plural = (/** @type {number} */ n, /** @type {string} */ one, /** @type {string} */ many) => `${n} ${n === 1 ? one : many}`;
  return `Fill ${plural(columns, 'column', 'columns')} for ${plural(rows, noun, `${noun}s`)}? About ${plural(turns, 'turn', 'turns')}.`;
}

/** How far the columns are filled: `done` cells (filled, not found or failed) of `total`. `pending` cells are the ones a
 *  stopped step left ("Fill the rest" takes them and the failed ones); `absent` cells are rows a step never asked for
 *  (the engine writes no entry for them, and rows never touched are not "pending").
 *  @param {Result} result @returns {{ done: number, total: number, pending: number, failed: number, absent: number }} */
export function cellProgress(result) {
  const grid = toGrid(result);
  let done = 0; let total = 0; let failed = 0; let pending = 0; let absent = 0;
  for (const row of grid.rows) for (const column of grid.columns) {
    total += 1;
    const cell = row.cells[column.id];
    if (!cell) absent += 1;
    else if (cell.state === 'pending') pending += 1;
    else { done += 1; if (cell.state === 'failed') failed += 1; }
  }
  return { done, total, pending, failed, absent };
}

/** A filled cell none of whose quotes passed the check (or that has none) is drawn with a dashed underline.
 *  @param {Cell | undefined} cell */
export function isUnverified(cell) {
  return cell?.state === 'filled' && !(cell.quotes ?? []).some((q) => q.verified);
}

/**
 * The version being shown with a running fill laid over it: the new columns as they will be, and every cell that
 * has arrived so far. `live.cells` starts as pending for the rows and columns the step will fill.
 * @param {Result} result @param {{ columns: ColumnSpec[], cells: Record<string, Record<string, Cell>> }} live @returns {Result}
 */
export function withLive(result, live) {
  if (result.kind !== 'papers' && result.kind !== 'table') return result;
  const have = new Set(result.columns.map((c) => c.id));
  const columns = [...result.columns, ...live.columns.filter((c) => !have.has(c.id))];
  /** @type {Record<string, Record<string, Cell>>} */
  const cells = { ...result.cells };
  for (const [row, byColumn] of Object.entries(live.cells)) cells[row] = { ...(cells[row] ?? {}), ...byColumn };
  return /** @type {Result} */ ({ ...result, columns, cells });
}

/** Pending cells for a step about to start: each row in scope by each new column (rows "all" = every row).
 *  @param {Result} result @param {ColumnSpec[]} add @param {string[] | "all"} rows */
export function pendingCells(result, add, rows) {
  const grid = toGrid(result);
  const ids = rows === 'all' ? grid.rows.map((r) => r.id) : rows;
  /** @type {Record<string, Record<string, Cell>>} */
  const cells = {};
  for (const id of ids) cells[id] = Object.fromEntries(add.map((c) => [c.id, /** @type {Cell} */ ({ state: 'pending' })]));
  return cells;
}

/** The version without one column (written as a new version, never an edit). @param {Result} result @param {string} columnId @returns {Result | null} */
export function withoutColumn(result, columnId) {
  if (result.kind !== 'papers' && result.kind !== 'table') return null;
  const column = result.columns.find((c) => c.id === columnId);
  if (!column) return null;
  const cells = Object.fromEntries(Object.entries(result.cells ?? {}).map(([row, byColumn]) => {
    const rest = { .../** @type {Record<string, Cell>} */ (byColumn) };
    delete rest[columnId];
    return [row, rest];
  }));
  return /** @type {Result} */ ({ ...result, columns: result.columns.filter((c) => c.id !== columnId), cells, from: [result.ref], change: `Removed column ${column.name}` });
}

// ---------------------------------------------------------------------------------------------- filters (spec 007 §5.3)

export const STUDY_TYPE_NAMES = { review: 'Review', systematic_review: 'Systematic review', meta_analysis: 'Meta-analysis', rct: 'RCT', longitudinal: 'Longitudinal', other: 'Other' };
const STUDY_TYPE_ORDER = Object.keys(STUDY_TYPE_NAMES);
export const SCREEN_NAMES = { include: 'Included', exclude: 'Excluded', unclear: 'Unclear' };

/** Whether any filter is set. @param {Filters | null | undefined} f */
export function filtersActive(f) {
  return describeFilters(f, null).length > 0;
}

/** A row's screening call: the user's override when there is one, else the AI's. @param {Result} result @param {string} rowId */
function screenOf(result, rowId) {
  const d = result.kind === 'papers' ? /** @type {Record<string, import("../../../agent/src/domain").ScreenDecision> | null} */ (result.screening)?.[rowId] : null;
  return d ? d.user ?? d.ai : null;
}

/**
 * Which filters the Filters popover offers for this version: only those whose data at least one row carries (spec
 * 007 §5.3: hidden, not greyed). Journal quality is not built. A non-paper table offers only "Column value".
 * @param {Result} result
 */
export function filterOptions(result) {
  const grid = toGrid(result);
  const papers = grid.rows.flatMap((r) => (r.paper ? [r.paper] : []));
  const years = papers.map((p) => p.year).filter((y) => typeof y === 'number');
  const types = new Set(papers.map((p) => p.studyType).filter(Boolean));
  const filledColumns = grid.columns.filter((c) => grid.rows.some((r) => r.cells[c.id]?.state === 'filled'));
  return {
    hasPdf: papers.some((p) => p.fullText || p.pdfUrl),
    years: years.length ? { min: Math.min(...years), max: Math.max(...years) } : null,
    studyTypes: STUDY_TYPE_ORDER.filter((t) => types.has(/** @type {any} */ (t))),
    abstract: papers.some((p) => (p.abstract ?? '').trim()),
    // In library / outside is offered when the set has both kinds; a set of one kind has nothing to tell apart.
    library: papers.some((p) => p.inLibrary) && papers.some((p) => !p.inLibrary),
    screening: result.kind === 'papers' && result.screening != null,
    columns: filledColumns.map((c) => ({ id: c.id, name: c.name })),
  };
}

/** @param {string} text */
const words = (text) => text.toLowerCase().split(/\s+/).filter(Boolean);

/** The rows that pass every set filter. Pure. @param {GridRow[]} rows @param {Filters | null} filters @param {Result} result */
export function applyFilters(rows, filters, result) {
  if (!filters || !filtersActive(filters)) return rows;
  const f = filters;
  return rows.filter((row) => {
    const p = row.paper;
    if (p) {
      if (f.hasPdf && !(p.fullText || p.pdfUrl)) return false;
      if ((f.yearFrom != null || f.yearTo != null) && (p.year == null || (f.yearFrom != null && p.year < f.yearFrom) || (f.yearTo != null && p.year > f.yearTo))) return false;
      if (f.studyTypes?.length && !(p.studyType && f.studyTypes.includes(p.studyType))) return false;
      const abstract = (p.abstract ?? '').replace(/\s+/g, ' ').toLowerCase();
      if (f.contains?.length && !f.contains.every((w) => abstract.includes(w.toLowerCase()))) return false;
      if (f.excludes?.length && f.excludes.some((w) => abstract.includes(w.toLowerCase()))) return false;
      if (f.library === 'in' && !p.inLibrary) return false;
      if (f.library === 'out' && p.inLibrary) return false;
      if (f.screening?.length) { const call = screenOf(result, row.id); if (!call || !f.screening.includes(call)) return false; }
    }
    if (f.column?.text.trim()) {
      const text = cellPlain(row.cells[f.column.id]).toLowerCase();
      if (!words(f.column.text).every((w) => text.includes(w))) return false;
    }
    return true;
  });
}

/** One removable chip per active filter, in a stable order: `{ key, label }`. `result` names the column. @param {Filters | null | undefined} f @param {Result | null} result */
export function describeFilters(f, result) {
  /** @type {{ key: string, label: string }[]} */
  const out = [];
  if (!f) return out;
  if (f.hasPdf) out.push({ key: 'pdf', label: 'Has PDF' });
  if (f.yearFrom != null || f.yearTo != null) {
    out.push({ key: 'year', label: f.yearFrom != null && f.yearTo != null ? `${f.yearFrom}-${f.yearTo}` : f.yearFrom != null ? `From ${f.yearFrom}` : `Up to ${f.yearTo}` });
  }
  for (const t of f.studyTypes ?? []) out.push({ key: `type:${t}`, label: /** @type {any} */ (STUDY_TYPE_NAMES)[t] ?? t });
  for (const w of f.contains ?? []) out.push({ key: `contains:${w}`, label: `Abstract has “${w}”` });
  for (const w of f.excludes ?? []) out.push({ key: `excludes:${w}`, label: `Abstract without “${w}”` });
  if (f.library) out.push({ key: 'library', label: f.library === 'in' ? 'In library' : 'Outside library' });
  for (const s of f.screening ?? []) out.push({ key: `screen:${s}`, label: `Screening: ${/** @type {any} */ (SCREEN_NAMES)[s] ?? s}` });
  if (f.column?.text.trim()) {
    const name = result && 'columns' in result ? result.columns.find((c) => c.id === f.column?.id)?.name : null;
    out.push({ key: 'column', label: `${name ?? 'Column'} contains “${f.column.text.trim()}”` });
  }
  return out;
}

/** The filters without the one chip `key` names. @param {Filters} f @param {string} key @returns {Filters} */
export function removeFilter(f, key) {
  const next = { ...f };
  const kind = key.split(':')[0];
  const value = key.slice(key.indexOf(':') + 1);
  if (kind === 'pdf') delete next.hasPdf;
  else if (kind === 'year') { delete next.yearFrom; delete next.yearTo; }
  else if (kind === 'type') next.studyTypes = (f.studyTypes ?? []).filter((t) => t !== value);
  else if (kind === 'contains') next.contains = (f.contains ?? []).filter((w) => w !== value);
  else if (kind === 'excludes') next.excludes = (f.excludes ?? []).filter((w) => w !== value);
  else if (kind === 'library') delete next.library;
  else if (kind === 'screen') next.screening = (f.screening ?? []).filter((t) => t !== value);
  else if (kind === 'column') delete next.column;
  return next;
}

/** A saved filter state read back from prefs, with anything malformed dropped. @param {any} raw @returns {Filters} */
export function cleanFilters(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const strings = (/** @type {any} */ v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : undefined);
  /** @type {Filters} */
  const out = {};
  if (raw.hasPdf === true) out.hasPdf = true;
  if (Number.isFinite(raw.yearFrom)) out.yearFrom = raw.yearFrom;
  if (Number.isFinite(raw.yearTo)) out.yearTo = raw.yearTo;
  for (const key of /** @type {const} */ (['studyTypes', 'contains', 'excludes', 'screening'])) { const v = strings(raw[key]); if (v?.length) out[key] = v; }
  if (raw.library === 'in' || raw.library === 'out') out.library = raw.library;
  if (raw.column && typeof raw.column.id === 'string' && typeof raw.column.text === 'string' && raw.column.text.trim()) out.column = { id: raw.column.id, text: raw.column.text };
  return out;
}

/** "has PDF", "RCT": a chip's words inside a sentence. @param {string} s */
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/** The `why` of a `narrow` step: "Kept 18 of 40: has PDF, 2020-2026". @param {{ kept: number, total: number, parts: string[] }} c */
export function keepWhy({ kept, total, parts }) {
  const tail = parts.map(lowerFirst).join(', ');
  return `Kept ${kept} of ${total}${tail ? `: ${tail}` : ''}`;
}

/** What the current view is made of, for `why`: each filter chip, a search, ticked rows. @param {{ filters: Filters | null, result: Result, search: string, ticked: number }} c */
export function viewParts({ filters, result, search, ticked }) {
  const parts = describeFilters(filters, result).map((d) => d.label);
  if (search.trim()) parts.push(`search “${search.trim()}”`);
  if (ticked) parts.push('ticked rows');
  return parts;
}

/**
 * The new paper set (or table) a "Keep these N" makes: the kept rows in their current order, their cells, the
 * screening calls, every column. The engine gives it its own result id (`R0` is never a real id) and step.
 * @param {Result} result @param {string[]} keep row ids @param {string} why @returns {Result | null}
 */
export function narrowDraft(result, keep, why) {
  if (result.kind !== 'papers' && result.kind !== 'table') return null;
  const byId = new Map(/** @type {any[]} */ (result.rows).map((r) => [r.id, r]));
  const rows = keep.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
  const cells = Object.fromEntries(rows.flatMap((r) => (result.cells?.[r.id] ? [[r.id, result.cells[r.id]]] : [])));
  const title = `${result.title} (${rows.length} kept)`;
  const base = { ...result, ref: { id: 'R0', version: 1 }, title, from: [result.ref], change: why, rows, cells };
  if (result.kind === 'papers') {
    const screening = result.screening ? Object.fromEntries(rows.flatMap((r) => (result.screening?.[r.id] ? [[r.id, result.screening[r.id]]] : []))) : null;
    return /** @type {Result} */ ({ ...base, screening, summary: null });
  }
  return /** @type {Result} */ (base);
}

/** Pending cells for what "Fill the rest" will run again: every pending or failed cell that has an entry (rows the
 *  step never asked for have none, and are not run by `rows: "pending"`). @param {Result} result */
export function restCells(result) {
  const grid = toGrid(result);
  /** @type {Record<string, Record<string, Cell>>} */
  const cells = {};
  for (const row of grid.rows) {
    for (const column of grid.columns) {
      const cell = row.cells[column.id];
      if (cell && (cell.state === 'pending' || cell.state === 'failed')) (cells[row.id] ??= {})[column.id] = { state: 'pending' };
    }
  }
  return cells;
}

/** True when a table or paper set has a cell that came back "not reported" (the gap fill has something to look for). @param {Result} result */
export function hasGaps(result) {
  return toGrid(result).rows.some((row) => Object.values(row.cells).some((cell) => cell.state === 'not_found'));
}

/** Pending cells for what the gap fill reads again: every "not reported" cell. @param {Result} result */
export function gapCells(result) {
  const grid = toGrid(result);
  /** @type {Record<string, Record<string, Cell>>} */
  const cells = {};
  for (const row of grid.rows) {
    for (const column of grid.columns) if (row.cells[column.id]?.state === 'not_found') (cells[row.id] ??= {})[column.id] = { state: 'pending' };
  }
  return cells;
}

/** The columns and rows that have no entry at all (a step limited to the first 50 leaves the rest so): what a second
 *  fill has to ask for, since `rows: "pending"` does not take them. @param {Result} result */
export function untouched(result) {
  const grid = toGrid(result);
  const rows = grid.rows.filter((r) => grid.columns.some((c) => !r.cells[c.id])).map((r) => r.id);
  const columns = grid.columns.filter((c) => grid.rows.some((r) => !r.cells[c.id]));
  return { rows, columns };
}
