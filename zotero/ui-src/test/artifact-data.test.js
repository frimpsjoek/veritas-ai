// Spec 007 E3: the artifact panel's pure logic: card text, search, sort, sort menu, version dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardMeta, searchRows, sortRows, sortOptions, sortLabel, visibleRows, shortDate, hasQuotes } from '../src/chat/artifact-data.js';
import { toGrid } from '../src/export/common.js';
import { papersV1, papersV2, tableV2 } from './fixtures/artifacts.js';

const summary = (kind, rows, columns = []) => ({ ref: { id: 'R1', version: 2 }, kind, title: 'T', versions: 2, rows, columns, updated: '2026-09-28T10:00:00Z' });

test('card line: "Table · 9 rows · V2", "Papers · 40 · 2 columns · V1", older says a newer version exists', () => {
  assert.equal(cardMeta(summary('table', 9), 2, false), 'Table · 9 rows · V2');
  assert.equal(cardMeta(summary('table', 1), 1, false), 'Table · 1 row · V1');
  assert.equal(cardMeta(summary('papers', 40, ['A', 'B']), 1, false), 'Papers · 40 · 2 columns · V1');
  assert.equal(cardMeta(summary('papers', 40, ['A']), 1, false), 'Papers · 40 · 1 column · V1');
  assert.equal(cardMeta(summary('papers', 40), 1, false), 'Papers · 40 · V1');
  assert.equal(cardMeta(summary('table', 9), 1, true), 'Table · 9 rows · V1 · a newer version exists');
});

test('search matches title, authors, abstract and cell text, every word, any case', () => {
  const rows = toGrid(papersV2).rows;
  const ids = (q) => searchRows(rows, q).map((r) => r.id);
  assert.deepEqual(ids('doorknob'), ['doi:10.9999/ergo.2019.7']);          // title
  assert.deepEqual(ids('MARLOW'), ['p:bramblewood2021']);                  // author
  assert.deepEqual(ids('migration studies'), ['t:seasonal-migration-of-burrowing-owls']); // abstract
  assert.deepEqual(ids('twenty-six'), ['p:hoarding2018']);                 // cell text
  assert.deepEqual(ids('not reported'), ['doi:10.9999/ergo.2019.7']);      // a "not found" note counts
  assert.deepEqual(ids('vole zzz'), []);                                   // every word must match
  assert.equal(ids('   ').length, 4);
});

test('sort: year, citations (rows with none go last both ways), title and any column', () => {
  const rows = toGrid(papersV2).rows;
  const ids = (sort) => sortRows(rows, sort).map((r) => r.paper.year);
  assert.deepEqual(ids({ key: 'year', dir: 'asc' }), [2018, 2019, 2021, 2023]);
  assert.deepEqual(ids({ key: 'year', dir: 'desc' }), [2023, 2021, 2019, 2018]);
  const cites = (dir) => sortRows(rows, { key: 'citations', dir }).map((r) => r.paper.citations);
  assert.deepEqual(cites('desc'), [127, 35, 8, null]);
  assert.deepEqual(cites('asc'), [8, 35, 127, null]);
  assert.equal(sortRows(rows, { key: 'title', dir: 'asc' })[0].paper.year, 2019); // "A Unified…" before "Foraging…"
  const byColumn = sortRows(rows, { key: 'col:sample-size', dir: 'asc' }).map((r) => r.id);
  assert.equal(byColumn[0], 'doi:10.9999/ergo.2019.7'); // "Not reported…" sorts before "Three…" and "Twenty-six…"
  assert.equal(byColumn.at(-1), 't:seasonal-migration-of-burrowing-owls'); // failed cell has no text: last
  assert.equal(sortRows(rows, null), rows);
});

test('the Sort menu offers year and title for papers, citations only when some row has them, then every column', () => {
  assert.deepEqual(sortOptions(toGrid(papersV1)).map((o) => o.key), ['title', 'year', 'citations']);
  assert.deepEqual(sortOptions(toGrid(papersV2)).map((o) => o.key), ['title', 'year', 'citations', 'col:main-finding', 'col:sample-size']);
  assert.deepEqual(sortOptions(toGrid(tableV2)).map((o) => o.key), ['label', 'col:approach', 'col:limit']);
  const noCites = { ...papersV1, rows: papersV1.rows.map((r) => ({ ...r, citations: null })) };
  assert.ok(!sortOptions(toGrid(noCites)).some((o) => o.key === 'citations'));
  assert.equal(sortLabel(toGrid(papersV2), { key: 'year', dir: 'desc' }), 'Sort: Year ↓');
  assert.equal(sortLabel(toGrid(papersV2), null), 'Sort: None');
});

test('visibleRows searches first, then sorts', () => {
  const { rows } = visibleRows(papersV2, { search: 'vole', sort: { key: 'year', dir: 'asc' } });
  assert.deepEqual(rows.map((r) => r.paper.year), [2018, 2021]);
});

test('quotes are detected, dates read short', () => {
  assert.ok(hasQuotes(papersV2));
  assert.ok(!hasQuotes(papersV1));
  const now = new Date('2026-09-29T12:00:00');
  assert.match(shortDate('2026-09-28T10:00:00', now), /28/);
  assert.equal(shortDate('nonsense'), '');
});

// ------------------------------------------------------------------ E4: filters, columns, keep (spec 007 §5.3, §5.1)
import { filterOptions, applyFilters, describeFilters, removeFilter, filtersActive, cleanFilters, keepWhy, viewParts, narrowDraft, PRESETS, specFromText, specFromPreset, columnId, confirmLine, cellProgress, withLive, withoutColumn, applyOrder, isUnverified, pendingCells, restCells, untouched } from '../src/chat/artifact-data.js';
import { bigPapers, bareRows } from './fixtures/artifacts.js';

const idsOf = (result, filters) => applyFilters(toGrid(result).rows, filters, result).map((r) => r.id);

test('filters narrow a fixture set: Has PDF, dates, study type, abstract contains / excludes, in library', () => {
  const r = papersV2;
  assert.deepEqual(idsOf(r, { hasPdf: true }), ['p:bramblewood2021', 't:seasonal-migration-of-burrowing-owls', 'p:hoarding2018']);
  assert.deepEqual(idsOf(r, { yearFrom: 2019, yearTo: 2021 }), ['p:bramblewood2021', 'doi:10.9999/ergo.2019.7']);
  assert.deepEqual(idsOf(r, { yearFrom: 2022 }), ['t:seasonal-migration-of-burrowing-owls']);
  assert.deepEqual(idsOf(r, { studyTypes: ['review', 'meta_analysis'] }), ['t:seasonal-migration-of-burrowing-owls', 'p:hoarding2018']);
  assert.deepEqual(idsOf(r, { contains: ['VOLES'] }), ['p:bramblewood2021']);                        // case-insensitive
  assert.deepEqual(idsOf(r, { contains: ['voles', 'meadows'] }), ['p:bramblewood2021']);              // every entry must appear
  assert.deepEqual(idsOf(r, { contains: ['voles', 'owls'] }), []);
  assert.deepEqual(idsOf(r, { excludes: ['doorknobs', 'caching'] }), ['p:bramblewood2021', 't:seasonal-migration-of-burrowing-owls']);
  assert.deepEqual(idsOf(r, { library: 'in' }), ['p:bramblewood2021', 'p:hoarding2018']);
  assert.deepEqual(idsOf(r, { library: 'out' }), ['doi:10.9999/ergo.2019.7', 't:seasonal-migration-of-burrowing-owls']);
  assert.deepEqual(idsOf(r, { hasPdf: true, library: 'in', yearFrom: 2020 }), ['p:bramblewood2021']); // filters combine
  assert.equal(idsOf(r, {}).length, 4);
});

test('column value contains: words in any order, on a filled column', () => {
  assert.deepEqual(idsOf(papersV2, { column: { id: 'main-finding', text: 'PATCH average' } }), ['p:bramblewood2021']);
  assert.deepEqual(idsOf(papersV2, { column: { id: 'sample-size', text: 'studies' } }), ['p:hoarding2018']);
  assert.deepEqual(idsOf(tableV2, { column: { id: 'limit', text: 'vole' } }), ['x:1']);                // a free table has this filter too
});

test('screening: the user override wins over the AI call, and rows with no call drop out', () => {
  const screened = { ...papersV2, screening: {
    'p:bramblewood2021': { ai: 'include', because: [], user: null },
    'doi:10.9999/ergo.2019.7': { ai: 'exclude', because: [], user: 'include' },
    'p:hoarding2018': { ai: 'unclear', because: [], user: null },
  } };
  assert.deepEqual(idsOf(screened, { screening: ['include'] }), ['p:bramblewood2021', 'doi:10.9999/ergo.2019.7']);
  assert.deepEqual(idsOf(screened, { screening: ['unclear'] }), ['p:hoarding2018']);
});

test('a filter whose data no row has is not shown (spec check 10)', () => {
  const none = filterOptions(bareRows());
  assert.equal(none.hasPdf, false);
  assert.equal(none.years, null);
  assert.deepEqual(none.studyTypes, []);
  assert.equal(none.abstract, false);
  assert.equal(none.library, false);              // every paper is in the library: nothing to tell apart
  assert.equal(none.screening, false);
  assert.deepEqual(none.columns, []);
  const some = filterOptions(papersV2);
  assert.equal(some.hasPdf, true);
  assert.deepEqual(some.years, { min: 2018, max: 2023 });
  assert.deepEqual(some.studyTypes, ['review', 'meta_analysis', 'longitudinal']);   // only the values present, in a fixed order
  assert.equal(some.library, true);
  assert.equal(some.screening, false);            // never screened
  assert.deepEqual(some.columns.map((c) => c.id), ['main-finding', 'sample-size']);
  // the fixture's V1 has no filled column, so no Column value filter
  assert.deepEqual(filterOptions(papersV1).columns, []);
  // a chat-made table has no paper data at all: only Column value
  const t = filterOptions(tableV2);
  assert.equal(t.hasPdf || t.abstract || t.library || t.screening || t.studyTypes.length > 0 || t.years !== null, false);
  assert.equal(t.columns.length, 2);
  // Obsidian-style rows: no studyType, no fullText, so those two stay hidden while dates and abstract show
  const obsidian = { ...papersV1, rows: ROWSNoFacts() };
  const o = filterOptions(obsidian);
  assert.deepEqual([o.hasPdf, o.studyTypes.length, o.years !== null, o.abstract], [false, 0, true, true]);
});
function ROWSNoFacts() { return papersV1.rows.map((r) => ({ ...r, studyType: null, fullText: false, pdfUrl: null })); }

test('chips: one per active filter, removable, and "Kept 18 of 40: has PDF, 2020-2026"', () => {
  const f = { hasPdf: true, yearFrom: 2020, yearTo: 2026, studyTypes: ['rct', 'review'], contains: ['acorn'], excludes: ['mice'], library: 'in', screening: ['include'], column: { id: 'main-finding', text: 'patch' } };
  const chips = describeFilters(f, papersV2);
  assert.deepEqual(chips.map((c) => c.label), ['Has PDF', '2020-2026', 'RCT', 'Review', 'Abstract has “acorn”', 'Abstract without “mice”', 'In library', 'Screening: Included', 'Main finding contains “patch”']);
  assert.deepEqual(describeFilters({ yearFrom: 2020 }, null).map((c) => c.label), ['From 2020']);
  assert.deepEqual(describeFilters({ yearTo: 2020 }, null).map((c) => c.label), ['Up to 2020']);
  assert.equal(describeFilters(removeFilter(f, 'type:rct'), papersV2).length, chips.length - 1);
  assert.deepEqual(removeFilter(removeFilter({ hasPdf: true, yearFrom: 2020 }, 'pdf'), 'year'), {});
  assert.equal(filtersActive({}), false);
  assert.equal(filtersActive({ contains: [] }), false);
  assert.equal(filtersActive({ hasPdf: true }), true);
  assert.equal(keepWhy({ kept: 18, total: 40, parts: ['Has PDF', '2020-2026'] }), 'Kept 18 of 40: has PDF, 2020-2026');
  assert.equal(keepWhy({ kept: 3, total: 40, parts: ['RCT', 'ticked rows'] }), 'Kept 3 of 40: RCT, ticked rows');
  assert.equal(keepWhy({ kept: 3, total: 40, parts: [] }), 'Kept 3 of 40');
  assert.deepEqual(viewParts({ filters: { hasPdf: true }, result: papersV2, search: ' vole ', ticked: 2 }), ['Has PDF', 'search “vole”', 'ticked rows']);
});

test('saved filters read back cleaned', () => {
  assert.deepEqual(cleanFilters(null), {});
  assert.deepEqual(cleanFilters({ hasPdf: false, yearFrom: 'x', contains: ['a', '', 3], library: 'sideways', column: { id: 'c', text: '  ' } }), { contains: ['a'] });
  assert.deepEqual(cleanFilters({ hasPdf: true, yearFrom: 2020, library: 'out' }), { hasPdf: true, yearFrom: 2020, library: 'out' });
});

test('filters work at scale: 120 invented papers', () => {
  const big = bigPapers(120);
  assert.equal(idsOf(big, { hasPdf: true }).length, 40);
  assert.equal(idsOf(big, { library: 'in' }).length, 30);
  assert.equal(idsOf(big, { contains: ['acorns'] }).length, 24);
  assert.ok(idsOf(big, { hasPdf: true, yearFrom: 2020, yearTo: 2026 }).length < 40);
});

test('visibleRows applies filters, then search, and the dragged column order', () => {
  const v = visibleRows(papersV2, { filters: { hasPdf: true }, search: 'owls', order: ['sample-size', 'main-finding'] });
  assert.deepEqual(v.rows.map((r) => r.id), ['t:seasonal-migration-of-burrowing-owls']);
  assert.equal(v.total, 4);
  assert.deepEqual(v.grid.columns.map((c) => c.id), ['sample-size', 'main-finding']);
  assert.deepEqual(applyOrder([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['c']).map((c) => c.id), ['c', 'a', 'b']);
});

test('narrowDraft: the kept rows, their cells and screening, a new result id, why as the change line', () => {
  const draft = narrowDraft(papersV2, ['p:hoarding2018', 'p:bramblewood2021'], 'Kept 2 of 4: has PDF');
  assert.equal(draft.kind, 'papers');
  assert.deepEqual(draft.rows.map((r) => r.id), ['p:hoarding2018', 'p:bramblewood2021']);   // in the order given
  assert.deepEqual(Object.keys(draft.cells).sort(), ['p:bramblewood2021', 'p:hoarding2018']);
  assert.equal(draft.columns.length, 2);
  assert.equal(draft.change, 'Kept 2 of 4: has PDF');
  assert.equal(draft.ref.id, 'R0');
  assert.deepEqual(draft.from, [{ id: 'R1', version: 2 }]);
  assert.equal(draft.title, 'Vole foraging and hoarding (2 kept)');
  assert.equal(narrowDraft({ kind: 'report' }, [], ''), null);
});

test('narrowDraft: a cited summary of the whole set is not carried onto the smaller set (spec 002 U2: never stale)', () => {
  const cited = { ...papersV2, summary: { markdown: 'Voles hoard [@hoarding2018].', citations: [] } };
  assert.equal(narrowDraft(cited, ['p:hoarding2018'], 'Kept 1 of 4').summary, null);
  assert.ok(cited.summary, 'the version it was kept from still has its summary');
});

test('columns: presets, free-text specs (the instruction is the text as typed), unique ids', () => {
  assert.deepEqual(PRESETS.map((p) => p.name), ['Summary', 'Main findings', 'Methodology', 'Intervention', 'Outcome measured', 'Limitations', 'Sample', 'Study type', 'Population']);
  assert.ok(PRESETS.every((p) => p.instruction.length > 10));
  const preset = specFromPreset(PRESETS[5], ['limitations']);
  assert.deepEqual([preset.id, preset.name, preset.preset, preset.kind], ['limitations-2', 'Limitations', 'limitations', 'text']);
  const free = specFromText('  What went   wrong for the voles? ', []);
  assert.deepEqual([free.name, free.instruction, free.preset], ['What went wrong for the voles?', 'What went wrong for the voles?', undefined]);
  assert.ok(specFromText('x'.repeat(30) + ' ' + 'y'.repeat(30), []).name.endsWith('…'));
  assert.equal(columnId('!!!', []), 'column');
});

test('the confirm line reads "Fill 3 columns for 120 papers? About 15 turns."', () => {
  assert.equal(confirmLine({ columns: 3, rows: 120, turns: 15, noun: 'paper' }), 'Fill 3 columns for 120 papers? About 15 turns.');
  assert.equal(confirmLine({ columns: 1, rows: 1, turns: 1, noun: 'row' }), 'Fill 1 column for 1 row? About 1 turn.');
});

test('progress, live overlay, unverified cells and removing a column', () => {
  assert.deepEqual(cellProgress(papersV2), { done: 7, total: 8, pending: 1, failed: 1, absent: 0 });
  assert.deepEqual(cellProgress(papersV1), { done: 0, total: 0, pending: 0, failed: 0, absent: 0 });
  // rows a step never asked for have no entry: absent, not pending; "Fill the rest" (rows: pending) leaves them alone
  const partial = { ...papersV2, cells: { 'p:hoarding2018': papersV2.cells['p:hoarding2018'] } };
  assert.deepEqual(cellProgress(partial), { done: 2, total: 8, pending: 0, failed: 0, absent: 6 });
  assert.deepEqual(restCells(partial), {});
  assert.deepEqual(untouched(partial).rows, ['p:bramblewood2021', 'doi:10.9999/ergo.2019.7', 't:seasonal-migration-of-burrowing-owls']);
  assert.deepEqual(untouched(partial).columns.map((c) => c.id), ['main-finding', 'sample-size']);
  const add = [{ id: 'limits', name: 'Limits', instruction: '', kind: 'text' }];
  const live = { columns: add, cells: pendingCells(papersV1, add, 'all') };
  const shown = withLive(papersV1, live);
  assert.deepEqual(shown.columns.map((c) => c.id), ['limits']);
  assert.equal(shown.cells['p:hoarding2018'].limits.state, 'pending');
  live.cells['p:hoarding2018'].limits = { state: 'filled', value: 'x', quotes: [], citations: [] };
  assert.equal(withLive(papersV1, live).cells['p:hoarding2018'].limits.state, 'filled');
  assert.equal(papersV1.columns.length, 0);                                                // the stored version is untouched
  assert.deepEqual(Object.keys(restCells(papersV2)).sort(), ['t:seasonal-migration-of-burrowing-owls']);
  assert.equal(isUnverified({ state: 'filled', value: 'v', quotes: [{ verified: false }], citations: [] }), true);
  assert.equal(isUnverified({ state: 'filled', value: 'v', quotes: [{ verified: true }], citations: [] }), false);
  assert.equal(isUnverified({ state: 'filled', value: 'v', quotes: [], citations: [] }), true);
  assert.equal(isUnverified({ state: 'not_found', note: '' }), false);
  const without = withoutColumn(papersV2, 'sample-size');
  assert.deepEqual(without.columns.map((c) => c.id), ['main-finding']);
  assert.equal(without.cells['p:hoarding2018']['sample-size'], undefined);
  assert.equal(without.change, 'Removed column Sample size');
  assert.equal(papersV2.columns.length, 2);
});

import { sourcesOf } from '../src/chat/artifact-data.js';

test('sourcesOf: each paper with a quote once, its quotes under it with the column name; rows without quotes are left out', () => {
  const table = {
    kind: 'table', ref: { id: 'T', version: 1 }, title: 'T', created: '', madeBy: 'S1', from: [], change: '',
    columns: [{ id: 'geo', name: 'Binding geometry', instruction: '' }, { id: 'res', name: 'Result', instruction: '' }],
    rows: [{ id: 'a', label: 'Paper A', paper: 'a' }, { id: 'b', label: 'Paper B', paper: 'b' }, { id: 'c', label: 'Paper C', paper: 'c' }],
    cells: {
      a: { geo: { state: 'filled', value: 'atop', quotes: [{ text: 'bound atop gold', ref: { kind: 'web', url: 'u' }, from: 'abstract', verified: true }], citations: [] },
           res: { state: 'filled', value: 'x', quotes: [{ text: 'G = 0.01 G0', ref: { kind: 'web', url: 'u' }, from: 'full_text', verified: false }], citations: [] } },
      b: { geo: { state: 'not_found', note: 'Not reported in the abstract' } },
      c: { geo: { state: 'filled', value: 'v', quotes: [], citations: [] } },
    },
  };
  const out = sourcesOf(table);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'Paper A');
  assert.deepEqual(out[0].quotes.map((q) => [q.column, q.text, q.from, q.verified]),
    [['Binding geometry', 'bound atop gold', 'abstract', true], ['Result', 'G = 0.01 G0', 'full_text', false]]);
  assert.deepEqual(sourcesOf({ kind: 'report', ref: { id: 'R', version: 1 } }), []);
});

import { hasGaps, gapCells } from '../src/chat/artifact-data.js';

test('hasGaps and gapCells find only the "not reported" cells', () => {
  const filled = { state: 'filled', value: 'v', quotes: [], citations: [] };
  const table = {
    kind: 'table', ref: { id: 'T', version: 2 }, title: 'T', created: '', madeBy: 'S1', from: [], change: '',
    columns: [{ id: 'a', name: 'A', instruction: '' }, { id: 'b', name: 'B', instruction: '' }],
    rows: [{ id: 'r1', label: 'One', paper: null }, { id: 'r2', label: 'Two', paper: null }],
    cells: { r1: { a: filled, b: { state: 'not_found', note: '' } }, r2: { a: { state: 'failed', error: 'x' }, b: filled } },
  };
  assert.equal(hasGaps(table), true);
  assert.deepEqual(gapCells(table), { r1: { b: { state: 'pending' } } });
  assert.equal(hasGaps({ ...table, cells: { r1: { a: filled }, r2: { b: filled } } }), false);
  assert.deepEqual(gapCells({ kind: 'report', ref: { id: 'R', version: 1 } }), {});
});
