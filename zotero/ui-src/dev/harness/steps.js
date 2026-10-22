// @ts-nocheck -- harness glue (loose window globals), like the other pages in this folder.
// ui-src/dev/harness/steps.js. Builds ChatViews on fake hosts for dev/steps-checks.mjs (spec 007 E6): `window.__sbS.make(opts)`
// returns { chat, host, store, calls }. Invented content only.
import { createFakeHost, createSessionStore, createLocalProviders, LOCAL_MODELS } from './fake-host.js';
import { sessionResults, ROWS } from '../../test/fixtures/artifacts.js';

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
frame.style.cssText = `${width ? `width:${width}px;` : ''} height:${params.get('bare') ? '100vh' : '720px'}; border:${params.get('bare') ? '0' : '1px solid var(--sb-ui-line)'};`;

const DAY = 86400000;
const TITLES = ['Excited-state ML review', 'Vole foraging table', 'Which meadows have owls?', 'Doorknob ergonomics', 'Hoarding meta-analysis'];
const KINDS = ['report', 'find', 'chat', 'chat', 'report'];

/** A saved Find search as it sits on disk (searches/<id>.json), with or without its session. */
export function savedSearch(id, query, session = null, at = new Date(Date.now() - DAY).toISOString()) {
  const rows = ROWS.map((r) => ({ title: r.title, authors: r.authors, year: String(r.year), venue: r.venue, doi: r.doi, abstract: r.abstract, key: r.inLibrary ? `K${r.id}` : null,
    citekey: r.ref.kind === 'paper' ? r.ref.citekey : null, sources: r.foundBy, url: r.url }));
  return { id, query, at, scope: { kind: 'library' }, sources: { papers: true, scholarly: true }, failed: [], rows, summary: null, session };
}

/**
 * @param {{ sessions?: number, results?: 'none' | 'all', context?: any[], searches?: any[], kind?: 'zotero' | 'obsidian', frameFresh?: boolean,
 *           library?: (query: string, scope: any) => any[], prefs?: Record<string, any> }} [opts]
 */
async function make(opts = {}) {
  const store = createSessionStore(opts.results === 'all' ? sessionResults() : {});
  store.conversations = [];
  const now = Date.now();
  for (let i = 0; i < (opts.sessions ?? 0); i++) {
    store.conversations.push({ id: `old${i + 1}`, mode: 'chat', title: TITLES[i % TITLES.length], updated: new Date(now - (i === 0 ? 4 : i + 4) * DAY).toISOString(), artifacts: i === 0 ? 2 : i, kind: KINDS[i % KINDS.length] });
  }
  const calls = [];
  const providers = opts.local ? createLocalProviders({ calls, ...(opts.local === true ? {} : opts.local) }) : undefined;
  const host = createFakeHost({ kind: opts.kind ?? 'zotero', placement: 'tab', calls, sessionStore: store, context: opts.context ?? [], providers });
  for (const search of opts.searches ?? []) await host.files.write(`searches/${search.id}.json`, JSON.stringify(search));
  host.searchLibrary = async (query, scope) => (opts.library ? opts.library(query, scope) : []);
  host.citeLabel = (citekey) => ({ label: citekey });
  for (const [key, value] of Object.entries({ ...(params.get('bare') ? { historyCollapsed: true } : {}), ...(opts.prefs ?? {}) })) host.prefs.set(key, value);
  if (opts.radar) fakeRadar(host, calls, opts.radar);
  const chat = new SecondBrainUI.ChatView(host, document);
  frame.replaceChildren(chat.root);
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { chat, host, store, calls, providers };
}

/**
 * spec 012 R2: gives the fake host the engine's `radar` API and a routines list that keeps what the sheet saves (`calls`
 * records `{ kind: 'radar-profile' | 'radar-check' | 'routine-create' | 'routine-update' }`). Invented names only.
 * `settings.routines` seeds the list; `settings.mcp` the connected servers.
 */
function fakeRadar(host, calls, settings) {
  const list = structuredClone(settings.routines ?? []);
  const reports = settings.mcp ?? [];
  const journal = (n, name, issn) => ({ openalexId: `S${n}`, name, issn, match: `${name}, Invented Press, 1,200 works` });
  const radar = {
    async profile(scope) {
      calls.push({ kind: 'radar-profile', scope });
      await new Promise((r) => setTimeout(r, 40));
      return {
        topics: [{ text: 'vole foraging behaviour', weight: 1, origin: 'seed' }, { text: 'burrow ecology', weight: 0.6, origin: 'seed' }, { text: 'seed hoarding', weight: 0.3, origin: 'seed' }],
        authors: [{ name: 'Bramblewood, A.', weight: 1, origin: 'seed', openalexId: 'A1', match: 'A. Bramblewood, Invented University, 120 works' }, { name: 'C. Quills', weight: 1, origin: 'seed', openalexId: null, match: null }],
        journals: [{ name: 'Journal of Invented Zoology', weight: 1, origin: 'seed', openalexId: 'S1', match: 'Journal of Invented Zoology, Invented Press, 1,200 works' }],
      };
    },
    async checkSource(input) {
      calls.push({ kind: 'radar-check', input });
      await new Promise((r) => setTimeout(r, 20));
      if (input.includes('nature.example')) return { kind: 'feed-blocked', url: input, reason: 'This site sends feed requests to a sign-in page.', journals: [journal(2, 'Nature of Voles', '1234-5678'), journal(3, 'Nature Burrows', null)] };
      if (input.includes('good.example')) return { kind: 'feed', url: input, title: 'Good feed', items: 12 };
      if (/^\d{4}-\d{3}[\dX]$/.test(input)) return { kind: 'journal', ...journal(4, 'Invented Materials', input) };
      if (input === 'invented') return { kind: 'journals', options: [journal(5, 'Invented Letters', '1111-2222'), journal(6, 'Invented Reviews', null)] };
      return { kind: 'error', message: `No journal found for "${input}". Try its full name or its ISSN.` };
    },
  };
  // spec 012 R4: verdicts the digest sets (`settings.verdicts` seeds an earlier session); `failFeedback` makes the next call throw.
  const done = new Map(Object.entries(settings.verdicts ?? {}));
  const last = new Map();
  radar.verdicts = async (routineId) => { calls.push({ kind: 'radar-verdicts', routineId }); return Object.fromEntries(done); };
  radar.feedback = async (routineId, paperKey, verdict) => {
    calls.push({ kind: 'radar-feedback', routineId, paperKey, verdict });
    if (settings.failFeedback) throw new Error('offline');
    if (verdict === 'undo') {
      // What the radar learned from that paper goes from the routine's profile and its learned log, as the engine does.
      for (const r of list) {
        const gone = (r.radarLearned ?? []).filter((l) => l.paper === paperKey);
        r.radarLearned = (r.radarLearned ?? []).filter((l) => l.paper !== paperKey);
        for (const l of gone) for (const f of ['authors', 'journals']) if (r.radar?.profile?.[f]) r.radar.profile[f] = r.radar.profile[f].filter((x) => !(x.origin === 'learned' && x.name === l.name));
      }
      const was = last.get(paperKey) ?? null; last.delete(paperKey); if (was) done.set(paperKey, was); else done.delete(paperKey); return { verdict: was ?? 'shown', changed: true };
    }
    last.set(paperKey, done.get(paperKey) ?? null);
    done.set(paperKey, verdict);
    return { verdict, changed: true };
  };
  const base = host.ai.bind(host);
  host.ai = async () => ({
    ...(await base()), radar,
    mcp: { async list() { return structuredClone(reports); }, async save() {}, async remove() {} },
    routines: {
      async list() { return structuredClone(list); },
      async create(d) {
        calls.push({ kind: 'routine-create', draft: structuredClone(d) });
        const r = { ...structuredClone(d), id: `rad${list.length + 1}`, status: 'active', prompt: 'Reading radar', lastRun: null, running: false, nextRun: new Date(Date.now() + 3600e3).toISOString() };
        list.push(r);
        return r;
      },
      async update(id, patch) { calls.push({ kind: 'routine-update', id, patch: structuredClone(patch) }); const r = list.find((x) => x.id === id); Object.assign(r, structuredClone(patch)); return r; },
      async runNow() { return { started: true }; }, async pause() {}, async resume() {}, async archive() {}, async adopt() { return []; },
    },
  });
}

/** A session open in the chat with one result of each kind you ask for, as if the engine had stored them. */
async function withResults(ctx, kinds) {
  const { chat, store } = ctx;
  const created = new Date().toISOString();
  const make = {
    papers: () => ({ kind: 'papers', ref: { id: 'R1', version: 1 }, title: 'Vole foraging and hoarding', created, madeBy: 'S1', from: [], change: 'Found papers', query: 'vole', rows: ROWS, columns: [], cells: {}, screening: null, summary: null }),
    table: () => ({ kind: 'table', ref: { id: 'R2', version: 1 }, title: 'Vole models', created, madeBy: 'S2', from: [], change: 'Made a table', columns: [{ id: 'a', name: 'Model', instruction: '', kind: 'text' }], rows: [{ id: 'r1', label: 'Patch model', paper: null }], cells: { r1: { a: { state: 'filled', value: 'Patch leaving', quotes: [], citations: [] } } } }),
    report: () => ({ kind: 'report', ref: { id: 'R3', version: 1 }, title: 'Vole review', created, madeBy: 'S3', from: [], change: 'Report', review: 'rev1' }),
  };
  chat.sessionID = 'sessX';
  chat.conversationID = 'sessX';
  store.results = {};
  chat.artifacts = [];
  chat.sessionResults = chat.artifacts;
  chat.thread.replaceChildren();
  for (const kind of kinds) {
    const body = make[kind]();
    store.results[body.ref.id] = [body];
    chat.noteArtifact({ ref: body.ref, kind: body.kind, title: body.title, versions: 1, rows: Array.isArray(body.rows) ? body.rows.length : null, columns: (body.columns ?? []).map((c) => c.name), updated: created }, { skipPanel: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const cards = chat.thread.appendChild(chat.el('div', 'sb-art-cards'));
  for (const a of chat.artifacts) chat.addArtifactCard(cards, a);
  chat.renderAddStep();
}

/** A radar digest open in the chat: a New result and a Worth reading result, as the engine writes them. Invented papers only. */
export const DIGEST_SUMMARY = '5 new from 4 sources · 2 worth reading · chemRxiv failed (timeout)';
async function withDigest(ctx, { routine = 'radX', only = null } = {}) {
  const { chat, store } = ctx;
  const created = new Date().toISOString();
  const row = (n, over = {}) => ({
    id: `doi:10.9999/vole.${n}`, ref: { kind: 'web', url: `https://doi.org/10.9999/vole.${n}` }, inLibrary: false, title: over.title ?? `Burrow depth tracks soil moisture in ${['meadow', 'upland', 'fen', 'verge', 'dune'][n % 5]} voles`,
    authors: ['A. Bramblewood', 'C. Quills', 'D. Thistledown', 'E. Marlow'], year: 2026, venue: 'Journal of Invented Zoology', doi: `10.9999/vole.${n}`, url: `https://doi.org/10.9999/vole.${n}`,
    abstract: over.abstract ?? 'Burrows were deeper where soil held more water. The effect held across two seasons.', abstractStatus: over.abstract === '' ? 'none' : 'source', citations: over.cites ?? null, fullText: false, pdfUrl: null, studyType: null, foundBy: ['arXiv'],
    radar: { key: `doi:10.9999/vole.${n}`, score: 0.8, why: { similarity: 0.8, author: 0, journal: 0, topic: 0, negative: 0 }, links: [], sources: ['database:arxiv'], date: '2026-10-08', ...(over.radar ?? {}) },
  });
  const news = [
    row(1, { radar: { why_line: 'Links burrow depth to soil moisture, which your foraging papers treat as a fixed background.' } }),
    row(2, { title: 'A very long title about seasonal variation in the caching behaviour of captive and wild-caught lesser spangled voles across three meadow types', radar: { why_line: 'Gives a field test of the patch-leaving rule you follow.' } }),
    row(3, { abstract: '' }),
    row(4, { radar: { why_line: 'Extends the hoarding meta-analysis in your library to wild populations.' } }),
    row(5, { radar: { why_line: 'Same group as the Bramblewood foraging study you added last month.' } }),
  ];
  const older = [
    row(6, { title: 'Optimal foraging in patchy environments', cites: 812, radar: { reason: 'Cited by 7 papers in your library, including Foraging Strategies of the Lesser Spangled Vole.' } }),
    row(7, { title: 'The marginal value theorem revisited', cites: 430, radar: { reason: 'Cited by 4 papers in your library, including Voles, Squirrels and Other Hoarders.' } }),
  ];
  const mk = (id, title, rows) => ({ kind: 'papers', ref: { id, version: 1 }, title, created, madeBy: 'S1', from: [], change: title, query: null, rows, columns: [], cells: {}, screening: null, summary: null, addedRows: rows.map((r) => r.id), radar: { routine, summary: DIGEST_SUMMARY } });
  const bodies = [mk('R1', 'New', news), mk('R2', 'Worth reading', older)].filter((b) => !only || b.title === only);
  chat.sessionID = 'sessD';
  chat.conversationID = 'sessD';
  store.results = {};
  chat.artifacts = [];
  chat.sessionResults = chat.artifacts;
  chat.thread.replaceChildren();
  for (const body of bodies) {
    store.results[body.ref.id] = [body];
    chat.noteArtifact({ ref: body.ref, kind: 'papers', title: body.title, versions: 1, rows: body.rows.length, columns: [], updated: created }, { skipPanel: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const cards = chat.thread.appendChild(chat.el('div', 'sb-art-cards'));
  for (const a of chat.artifacts) chat.addArtifactCard(cards, a);
  chat.renderAddStep();
}

const classTree = (node) => {
  if (node.nodeType !== 1) return null;
  return { tag: node.tagName.toLowerCase(), cls: [...node.classList].sort(), kids: [...node.childNodes].map(classTree).filter(Boolean) };
};

window.__sbS = { make, withResults, withDigest, savedSearch, classTree, frame, ROWS };
window.__sbHarnessReady = true;
