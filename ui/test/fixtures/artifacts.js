// Invented papers and results for the artifact tests and the shared harness (this repo is public: nothing real,
// nothing personal). Shapes follow agent-src/src/domain.d.ts (PapersResult, TableResult, Cell, Quote).

const ref = (citekey) => ({ kind: 'paper', citekey });
const web = (url) => ({ kind: 'web', url });

export const ROWS = [
  { id: 'p:bramblewood2021', ref: ref('bramblewood2021'), inLibrary: true, title: 'Foraging Strategies of the Lesser Spangled Vole',
    authors: ['A. Bramblewood', 'C. Quills', 'D. Thistledown', 'E. Marlow'], year: 2021, venue: 'Journal of Invented Zoology', doi: '10.9999/jiz.2021.001',
    url: null, abstract: 'A survey of foraging patterns across three meadows. Voles leave a patch when the return falls below the meadow average. Results held in every season.',
    citations: 127, fullText: true, pdfUrl: null, studyType: 'longitudinal', foundBy: ['Your library'] },
  { id: 'doi:10.9999/ergo.2019.7', ref: web('https://doi.org/10.9999/ergo.2019.7'), inLibrary: false, title: 'A Unified Theory of Doorknob Ergonomics',
    authors: ['P. Handlebar'], year: 2019, venue: 'Proceedings of Everyday Design', doi: '10.9999/ergo.2019.7', url: 'https://example.invalid/doorknob-theory',
    abstract: 'Doorknobs, revisited. We argue that grip diameter predicts comfort better than material.', citations: 35, fullText: false, pdfUrl: null, studyType: null, foundBy: ['OpenAlex'] },
  { id: 't:seasonal-migration-of-burrowing-owls', ref: web('https://example.invalid/owls'), inLibrary: false, title: 'Seasonal Migration of Burrowing Owls: A Review',
    authors: ['M. Featherstone', 'R. Alder'], year: 2023, venue: 'Annals of Imaginary Ornithology', doi: null, url: 'https://example.invalid/owls',
    abstract: 'A review of twelve migration studies. Timing shifts earlier by two days per decade.', citations: null, fullText: true, pdfUrl: 'https://example.invalid/owls.pdf', studyType: 'review', foundBy: ['Semantic Scholar'] },
  { id: 'p:hoarding2018', ref: ref('hoarding2018'), inLibrary: true, title: 'Voles, "Squirrels" and Other Hoarders: a Meta-analysis, with Notes',
    authors: ['J. Acorn', 'K. Burrow'], year: 2018, venue: 'Journal of Invented Zoology', doi: '10.9999/jiz.2018.044', url: null,
    abstract: 'Pooled effect sizes for caching behaviour in captive rodents.', citations: 8, fullText: true, pdfUrl: null, studyType: 'meta_analysis', foundBy: ['Your library', 'OpenAlex'] },
];

const quote = (text, r, from = 'abstract', verified = true) => ({ text, ref: r, from, verified });
const filled = (value, quotes = [], citations = quotes.map((q) => q.ref)) => ({ state: 'filled', value, quotes, citations });

const base = { created: '2026-09-28T09:00:00.000Z', madeBy: 'S1', from: [] };

/** Papers V1: four papers, no columns. */
export const papersV1 = {
  ...base, kind: 'papers', ref: { id: 'R1', version: 1 }, title: 'Vole foraging and hoarding', change: 'Found papers', query: 'vole foraging',
  rows: ROWS, columns: [], cells: {}, screening: null, summary: null,
};

/** Papers V2: two columns, one cell still pending, one not found, one failed. */
export const papersV2 = {
  ...papersV1, ref: { id: 'R1', version: 2 }, created: '2026-09-28T10:30:00.000Z', change: 'Added columns Main finding, Sample size',
  columns: [
    { id: 'main-finding', name: 'Main finding', instruction: 'What is the main finding?', kind: 'text', preset: 'main_findings' },
    { id: 'sample-size', name: 'Sample size', instruction: 'How many animals?', kind: 'text', preset: 'sample' },
  ],
  cells: {
    'p:bramblewood2021': {
      'main-finding': filled('Voles leave a patch when the return falls below the meadow average.', [quote('Voles leave a patch when the return falls below the meadow average.', ref('bramblewood2021'))]),
      'sample-size': filled('Three meadows, 212 voles', [quote('across three meadows', ref('bramblewood2021'), 'full_text', false)]),
    },
    'doi:10.9999/ergo.2019.7': {
      'main-finding': filled('Grip diameter predicts comfort better than material.', [quote('grip diameter predicts comfort better than material', web('https://doi.org/10.9999/ergo.2019.7'))]),
      'sample-size': { state: 'not_found', note: 'Not reported in the abstract' },
    },
    't:seasonal-migration-of-burrowing-owls': {
      'main-finding': { state: 'pending' },
      'sample-size': { state: 'failed', error: 'The turn timed out' },
    },
    'p:hoarding2018': {
      'main-finding': filled('Caching rises with food scarcity across captive rodents.', [
        quote('Pooled effect sizes for caching behaviour in captive rodents.', ref('hoarding2018')),
        quote('effect sizes were largest for voles', ref('bramblewood2021'), 'full_text'),
      ]),
      'sample-size': filled('Twenty-six studies'),
    },
  },
};

/** A table the chat made: V1 has one column, V2 adds one. */
export const tableV1 = {
  ...base, kind: 'table', ref: { id: 'R2', version: 1 }, title: 'Vole foraging models', change: 'Made from the chat',
  columns: [{ id: 'approach', name: 'Approach', instruction: 'How it works', kind: 'text' }],
  rows: [{ id: 'x:1', label: 'Patch-leaving model', paper: null }, { id: 'x:2', label: 'Central-place model', paper: null }],
  cells: {
    'x:1': { approach: filled('Leave when the return drops below the average.', [], [ref('bramblewood2021')]) },
    'x:2': { approach: filled('Carry food back to a nest; load size grows with distance.', [quote('load size grows with distance', ref('hoarding2018'), 'abstract')]) },
  },
};
export const tableV2 = {
  ...tableV1, ref: { id: 'R2', version: 2 }, created: '2026-09-28T11:00:00.000Z', change: 'Added column Main limitation',
  columns: [...tableV1.columns, { id: 'limit', name: 'Main limitation', instruction: 'Biggest weakness', kind: 'text' }],
  cells: {
    'x:1': { ...tableV1.cells['x:1'], limit: filled('Assumes the vole knows the meadow average.') },
    'x:2': { ...tableV1.cells['x:2'], limit: { state: 'not_found', note: 'Not discussed' } },
  },
};

/** The two results as a session would hold them: id -> versions in order. */
export function sessionResults() {
  return { R1: [structuredClone(papersV1), structuredClone(papersV2)], R2: [structuredClone(tableV1), structuredClone(tableV2)] };
}

/** A papers result of `n` invented papers (E4: 40 for stop / resume, 120 for the confirm line). Every 3rd has a PDF, years
 *  2015-2026, study types cycle, every 4th is in the library. */
export function bigPapers(n, id = 'R9') {
  const types = ['rct', 'review', null, 'meta_analysis', 'longitudinal', 'systematic_review'];
  const rows = Array.from({ length: n }, (_, i) => ({
    id: `x:${i + 1}`, ref: { kind: 'web', url: `https://example.invalid/p${i + 1}` }, inLibrary: i % 4 === 0,
    title: `Invented Study ${i + 1} of Meadow Life`, authors: [`A. Author${i + 1}`], year: 2015 + (i % 12), venue: 'Journal of Invented Zoology',
    doi: null, url: `https://example.invalid/p${i + 1}`, abstract: `Paper ${i + 1} looks at voles.${i % 5 === 0 ? ' It mentions acorns.' : ''} It measures burrow depth.`,
    citations: i, fullText: i % 3 === 0, pdfUrl: null, studyType: types[i % types.length], foundBy: ['OpenAlex'],
  }));
  return { ...base, kind: 'papers', ref: { id, version: 1 }, title: `Invented set of ${n}`, change: 'Found papers', query: 'voles', rows, columns: [], cells: {}, screening: null, summary: null };
}

/** The same rows with no data behind any optional filter: nothing to offer. */
export function bareRows() {
  const set = /** @type {any} */ (bigPapers(4, 'R8'));
  set.rows = set.rows.map((r) => ({ ...r, fullText: false, pdfUrl: null, year: null, studyType: null, abstract: '', inLibrary: true }));
  return set;
}
