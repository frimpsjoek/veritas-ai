// @ts-nocheck -- harness glue (loose window globals), like the other pages in this folder.
// ui-src/dev/harness/report.js. A ChatView on a fake host whose `reviews.watch` plays a script of progress snapshots
// (one per watch() call, the way the real terminal states end a watch), for dev/report-checks.mjs (spec 007 E7).
// `window.__sbRp.make({ script })` returns { chat, host, calls }; `calls` records answer / approvePlan. Invented content only.
import { createFakeHost, createSessionStore } from './fake-host.js';

const params = new URLSearchParams(location.search);
const obsidian = params.get('tokens') === 'obsidian';
document.getElementById('tokens').setAttribute('href', obsidian ? '../../styles/tokens-obsidian.css' : '../../styles/tokens-zotero.css');
if (params.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
if (obsidian) {
  const standins = document.getElementById('standins');
  standins.textContent = standins.textContent.replace(':root[data-theme="dark"] {', ':root[data-theme="dark"] body {').replace(/:root \{/, 'body {');
}
if (params.get('bare')) document.body.classList.add('bare');
const frame = document.getElementById('frame');
const width = params.get('w');
frame.style.cssText = `${width ? `width:${width}px;` : ''} height:${params.get('bare') ? '100vh' : '760px'}; border:${params.get('bare') ? '0' : '1px solid var(--sb-ui-line)'};`;

const QUESTIONS = [
  { id: 'route', question: 'Which route should I use for this broad investigation?', choices: ['A narrative overview', 'A formal systematic review of trials only', 'A quick scan of the last five years'], other: true },
  { id: 'when', question: 'How far back should I look?', choices: ['2015 onward', 'Any year'], other: false },
];
const PLAN = {
  subQuestions: [
    { id: 'sq1', question: 'What do voles eat in winter?', strategy: 'Search foraging studies', sources: ['papers', 'scholarly'] },
    { id: 'sq2', question: 'How does snow depth change foraging?', strategy: 'Look for field experiments', sources: ['papers'] },
  ],
  criteria: [{ id: 'criterion_1', text: 'Reports a field study', strict: true }, { id: 'criterion_2', text: 'Published after 2010', strict: false }],
  columns: [{ id: 'main_findings', name: 'Main findings', instruction: 'The findings', kind: 'text' }, { id: 'sample_size', name: 'Sample size', instruction: 'n', kind: 'text' }],
  assumed: ['Assumed: 2015 onward'],
  caps: { candidates: 60, extract: 20 },
};
const LINES = {
  clarify: { id: 'clarify', icon: 'clarify', title: 'Clarified the scope', detail: 'A formal systematic review of trials only · 2015 onward', state: 'done', items: [], reasoning: null },
  plan: { id: 'plan', icon: 'plan', title: 'Planned 2 sub-questions', detail: null, state: 'done', items: [], reasoning: null },
  search: { id: 'search', icon: 'scholarly', title: 'Ran searches', detail: '4 searches, 12 papers', state: 'done', items: [], reasoning: null },
};
const cell = (value, quotes) => ({ state: 'filled', value, quotes, citations: [] });
const ref = (k) => ({ kind: 'paper', citekey: k });
const q = (text, verified = true) => ({ text, ref: ref('vole2020'), from: 'abstract', verified });
const TABLE = {
  columns: PLAN.columns,
  rows: [
    { id: 'p:vole2020', ref: ref('vole2020'), inLibrary: true, title: 'Winter diets of field voles', year: 2020, authors: [], venue: '', doi: null, url: null, abstract: '', citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: [] },
    { id: 'p:snow2018', ref: ref('snow2018'), inLibrary: true, title: 'Snow cover and burrowing', year: 2018, authors: [], venue: '', doi: null, url: null, abstract: '', citations: null, fullText: false, pdfUrl: null, studyType: null, foundBy: [] },
  ],
  cells: {
    'p:vole2020': { main_findings: cell('Voles ate mostly bark', [q('Voles ate mostly bark in winter'), q('A quote the paper never made', false)]), sample_size: cell('n = 40', [q('forty animals')]) },
    'p:snow2018': { main_findings: cell('Deep snow reduced foraging', [q('Deep snow reduced foraging bouts')]), sample_size: { state: 'not_found', note: 'n' } },
  },
};
const REPORT = {
  title: 'Winter foraging in voles', scope: 'The whole library', method: 'Searched the library and scholarly sources.',
  themes: [{ heading: 'Diet', body: 'Voles rely on bark [@vole2020].' }],
  evidence: [
    { claim: 'Voles eat mostly bark in winter', sources: ['vole2020'], strength: 'strong', cells: [{ row: 'p:vole2020', column: 'main_findings' }, { row: 'p:vole2020', column: 'sample_size' }] },
    { claim: 'Snow depth matters', sources: ['snow2018'], strength: 'moderate', cells: [{ row: 'p:snow2018', column: 'sample_size' }] },
  ],
  disagreements: 'None found.', gaps: 'Few long-term studies.',
  references: [{ citekey: 'vole2020', doi: null, url: null, title: 'Winter diets of field voles', year: 2020, inLibrary: true }, { citekey: 'snow2018', doi: null, url: null, title: 'Snow cover and burrowing', year: 2018, inLibrary: true }],
};

const SYS_PLAN = {
  subQuestions: [{ id: 'sq1', question: 'Does spaced practice improve retention in adults?', strategy: 'Search trials', sources: ['papers', 'scholarly'] }],
  protocol: { population: 'Adult learners', intervention: 'Spaced practice', comparison: null, outcomes: 'Retention at 4 weeks', studyDesigns: ['rct', 'meta_analysis'] },
  criteria: [{ id: 'criterion_1', text: 'Enrolled adults', strict: true }, { id: 'criterion_2', text: 'Reports a retention outcome', strict: false }],
  columns: [{ id: 'retention', name: 'Retention', instruction: 'r', kind: 'text' }, { id: 'sample_size', name: 'Sample size', instruction: 'n', kind: 'text' }],
  assumed: [], caps: { candidates: 300, extract: 80 },
};
const UNCLEAR = [
  { id: 'p:a', title: 'Spacing in undergraduates', year: 2019, because: ['Enrolled adults'], include: true },
  { id: 'p:b', title: 'A long and winding title about spaced repetition across many different learner populations and settings', year: 2021, because: ['Enrolled adults', 'Reports a retention outcome'], include: true },
  { id: 'p:c', title: 'Flashcards at work', year: null, because: ['Enrolled adults'], include: true },
];
/** The screened papers as the engine's virtual result (session `review:<id>`): 20 candidates, the first three unclear and toggleable. */
const paperRow = (id, title, year) => ({ id, ref: { kind: 'paper', citekey: id.slice(2) }, inLibrary: true, title, authors: ['A. Author'], year, venue: 'Journal of Spacing', doi: null, url: null, abstract: 'An abstract.', citations: null, fullText: true, pdfUrl: null, studyType: null, foundBy: [] });
function screeningResult(answered, overrides = []) {
  const rows = [...UNCLEAR.map((u) => paperRow(u.id, u.title, u.year)), ...Array.from({ length: 17 }, (_, i) => paperRow(`p:x${i + 1}`, `Settled paper ${i + 1}`, 2015 + (i % 8)))];
  const yes = { state: 'filled', value: 'yes', quotes: [], citations: [] };
  const unclear = { state: 'filled', value: 'unclear', quotes: [], citations: [] };
  const cells = Object.fromEntries(rows.map((r) => [r.id, { criterion_1: UNCLEAR.some((u) => u.id === r.id) ? unclear : yes, criterion_2: yes }]));
  const screening = Object.fromEntries(rows.map((r) => [r.id, { ai: UNCLEAR.some((u) => u.id === r.id) ? 'unclear' : 'include', because: [], user: overrides.find((o) => o.id === r.id) ? (overrides.find((o) => o.id === r.id).include ? 'include' : 'exclude') : null }]));
  return {
    kind: 'papers', title: 'Screened papers', query: 'q', change: 'Screened 20 papers: 20 kept', ref: { id: 'screening', version: 1 }, madeBy: 'S0', from: [], created: new Date().toISOString(),
    rows, columns: SYS_PLAN.criteria.map((c) => ({ id: c.id, name: c.text, instruction: c.text, kind: 'criterion' })), cells, screening, summary: null,
    ...(answered ? {} : { gate: { review: 'review1', unclear: UNCLEAR.map((u) => ({ id: u.id, because: u.because })) } }),
  };
}
const base = { id: 'review1', question: 'What do voles eat in winter?', started: new Date().toISOString(), outside: [], papersFound: 12 };
export const STATES = {
  asking: { ...base, status: { state: 'awaiting_answer', questions: QUESTIONS }, lines: [], counts: null },
  planning: { ...base, status: { state: 'awaiting_approval', plan: PLAN }, lines: [LINES.clarify], counts: null },
  searching: { ...base, status: { state: 'running', stage: 'search', agents: [{ subQuestion: 'sq1', state: 'done' }, { subQuestion: 'sq2', state: 'running' }] }, lines: [LINES.clarify, LINES.plan], counts: null },
  extracting: { ...base, status: { state: 'running', stage: 'extract', agents: [] }, lines: [LINES.clarify, LINES.plan, LINES.search], counts: { candidates: 12, included: 9, excluded: 3, extracted: 0 } },
  done: { ...base, status: { state: 'done', notePath: 'ai_notes/Winter foraging.md' }, lines: [], counts: { candidates: 12, included: 2, excluded: 10, extracted: 2 }, report: REPORT, table: TABLE },
  sysPlanning: { ...base, systematic: true, status: { state: 'awaiting_approval', plan: SYS_PLAN }, lines: [LINES.clarify], counts: null },
  searchLive: { ...base, status: { state: 'running', stage: 'search', agents: [{ subQuestion: 'sq1', state: 'running' }] }, lines: [LINES.clarify, LINES.plan, {
    id: 'search', icon: 'scholarly', title: 'Searching', detail: '2 searches · 1 read', state: 'running', reasoning: null,
    items: ['Searched OpenAlex: spaced practice adults', 'Searched your library: retention', 'Read a source'],
    entries: [
      { id: 'a1', kind: 'scholarly', state: 'done', label: 'Searched OpenAlex: spaced practice adults' },
      { id: 'a2', kind: 'library', state: 'done', label: 'Searched your library: retention' },
      { id: 'a3', kind: 'read', state: 'running', label: 'Reading a source' },
    ],
  }], counts: null },
  sysReview: { ...base, systematic: true, status: { state: 'awaiting_review', unclear: UNCLEAR, total: 20 }, lines: [LINES.clarify, LINES.plan, LINES.search], counts: { candidates: 20, included: 20, excluded: 0, extracted: 0 } },
  old: { ...base, status: { state: 'awaiting_approval', plan: { subQuestions: PLAN.subQuestions } } },
};

/** @param {{ script: any[], kind?: 'zotero' | 'obsidian' }} opts */
async function make(opts) {
  const calls = [];
  const host = createFakeHost({ kind: opts.kind ?? 'zotero', placement: 'tab', calls, sessionStore: createSessionStore({}) });
  const ai = await host.ai();
  host.ai = async () => ai; // the fake builds a new service per call; the script and the recorded calls need one
  let cursor = 0;
  ai.reviews.watch = async function* () { yield opts.script[Math.min(cursor++, opts.script.length - 1)]; };
  ai.reviews.answer = async (id, answers) => { calls.push({ kind: 'answer', id, answers }); };
  ai.reviews.approvePlan = async (id, plan) => { calls.push({ kind: 'approve', id, plan }); };
  let answered = false;
  let lastOverrides = [];
  ai.reviews.screened = async (id, overrides) => { calls.push({ kind: 'screened', id, overrides }); answered = true; lastOverrides = overrides; };
  const readSession = ai.sessions.read.bind(ai.sessions);
  ai.sessions.read = async (sessionId, ref) => (String(sessionId).startsWith('review:') ? screeningResult(answered, lastOverrides) : readSession(sessionId, ref));
  host.citeLabel = (citekey) => ({ label: citekey });
  window.__sbRp.calls = calls;
  const chat = new SecondBrainUI.ChatView(host, document);
  frame.replaceChildren(chat.root);
  await new Promise((resolve) => setTimeout(resolve, 60));
  window.__sbRp.chat = chat;
  chat.openReport('review1', 'What do voles eat in winter?');
  await new Promise((resolve) => setTimeout(resolve, 120));
  return { chat, host, calls };
}

window.__sbRp = { make, STATES, callsOf: () => window.__sbRp.calls ?? [] };
window.__sbHarnessReady = true;
