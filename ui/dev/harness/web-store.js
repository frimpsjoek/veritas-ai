// @ts-nocheck -- harness fixture: the store grows fields createSessionStore does not declare.
// ui-src/dev/harness/web-store.js. The invented library both Home harness pages show: web.html (the web shell) and
// home.html (the plugins' HomeView). Sessions, a radar issue with its papers, routines, the radar's seed and checks.
import { createSessionStore } from './fake-host.js';

/** @param {URLSearchParams} params ?routines=none (no radar yet), ?issues=none (no radar issues) */
export function webStore(params) {
  const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
  const store = createSessionStore();
  const radarAt = new Date(Date.now() - 60_000).toISOString();
  store.conversations = [
    { id: 'c1', mode: 'chat', title: 'Foraging in voles', updated: hoursAgo(2), artifacts: 0, kind: 'chat', cover: { kind: 'chat', title: 'What do voles eat?', quote: 'Seeds and roots.' } },
    { id: 'c2', mode: 'chat', title: 'Doorknob ergonomics', updated: hoursAgo(30), artifacts: 1, kind: 'find' },
    { id: 'c3', mode: 'chat', title: 'Voles weekly', updated: hoursAgo(5), artifacts: 1, kind: 'find', routine: 'r1', news: { papers: 3, at: hoursAgo(5) } },
    { id: 'c4', mode: 'chat', title: 'Reading radar', updated: radarAt, artifacts: 1, kind: 'chat', routine: 'r2', news: { papers: 5, at: radarAt },
      cover: { kind: 'radar', quote: 'Burrow microclimates in field voles', by: 'A. Vole, Ecology', count: '5 new papers' } },
    { id: 'c5', mode: 'chat', title: 'New chat', updated: hoursAgo(50), artifacts: 2, kind: 'report',
      cover: { kind: 'report', title: 'What Voles Eat: A Review', quote: 'What do voles eat across seasons?', by: '12 papers' } },
    { id: 'c6', mode: 'chat', title: 'Reading radar', updated: hoursAgo(26), artifacts: 1, kind: 'chat', routine: 'r2', cover: { kind: 'radar', quote: 'Yesterday in vole land', count: '1 new paper' } },
    ...Array.from({ length: 7 }, (_, i) => ({ id: `old${i + 1}`, mode: 'chat', title: `Old vole question ${i + 1}`, updated: hoursAgo(200 + i), artifacts: 0, kind: 'chat' })),
  ];
  store.resultsBy = { c4: [
    // the issue's radar and each paper's radar key: Home draws the rating actions from them (Add, Read later, Not relevant)
    { kind: 'papers', ref: { id: 'R1', version: 1 }, title: 'New', created: radarAt, radar: { routine: 'r2', summary: '2 new from 2 sources' }, rows: [
      { id: 'a', title: 'Burrow microclimates in field voles', authors: ['A. Vole', 'B. Mole'], venue: 'Ecology', year: 2026, doi: '10.1/vole', foundBy: ['bioRxiv', 'Ecology feed'], abstract: `Field voles dig burrows whose air stays warmer than the surface through winter. ${'We logged temperature in forty burrows across two winters. '.repeat(6)}The end.`, radar: { key: 'doi:10.1/vole', date: '2026-10-10', why_line: 'Burrows stay four degrees warmer than the surface.' } },
      { id: 'b', title: 'Seed caching under snow', authors: ['C. Shrew'], venue: 'Oikos', year: 2026, url: 'https://example.org/seeds', abstract: 'Voles cache seeds under the snowpack.', radar: { key: 'title:seed caching under snow', date: '2026-10-09' } },
    ] },
    { kind: 'papers', ref: { id: 'R2', version: 1 }, title: 'Worth reading', created: radarAt, radar: { routine: 'r2', summary: '2 new from 2 sources' }, rows: [
      { id: 'c', title: 'A classic of vole ecology', authors: ['D. Field'], venue: 'J. Mammal.', year: 1990, radar: { key: 'title:a classic of vole ecology', reason: 'Cited by 3 papers in your library' } },
    ] },
  ], c6: [
    { kind: 'papers', ref: { id: 'R1', version: 1 }, title: 'New', created: hoursAgo(26), rows: [
      { id: 'y', title: 'Yesterday in vole land', authors: ['E. Past'], venue: 'Oikos', year: 2026, radar: { date: '2026-10-09', why_line: 'An older issue.' } },
    ] },
  ] };
  store.recordsBy.c1 = [
    { type: 'user', text: 'What do voles eat?', attachments: [], web: 'off', at: hoursAgo(2) },
    { type: 'assistant', answer: { text: 'Seeds and roots.', citations: [], structured: null, usage: {} }, model: { provider: 'x', model: 'y' }, activities: [], at: hoursAgo(2) },
  ];
  store.routines = [{
    id: 'r1', name: 'Voles weekly', prompt: 'New papers on voles', skills: [], depth: 'quick', status: 'active', created: hoursAgo(900), updated: hoursAgo(900),
    schedule: { kind: 'daily', time: '07:30' }, target: { kind: 'session' }, sources: null, scope: null, lastSlot: null, notify: false, nextRun: new Date(Date.now() + 3600_000).toISOString(), running: false,
    lastRun: { at: hoursAgo(5), slot: null, status: 'done', added: 3, session: 'c3' },
  }, {
    id: 'r2', name: 'Reading radar', prompt: 'Reading radar', kind: 'radar', skills: [], depth: 'standard', status: 'active', created: hoursAgo(900), updated: hoursAgo(900),
    schedule: { kind: 'daily', time: '07:00' }, target: { kind: 'session' }, sources: null, scope: null, lastSlot: null, notify: false, nextRun: new Date(Date.now() + 3600_000).toISOString(), running: false,
    lastDone: radarAt, lastRun: { at: radarAt, slot: null, status: 'done', added: 5, session: 'c4' },
    radar: { scope: { kind: 'library' }, note: true, size: { fresh: 8, older: 1, discover: 3 },
      profile: { topics: [{ text: 'burrow ecology', weight: 1, origin: 'user' }], authors: [], journals: [] },
      sources: [{ id: 'database:arxiv', on: true, kind: 'database', db: 'arxiv' }] },
  }];
  // ?routines=none is a fresh data folder: no radar, so Home opens on who and what to follow (spec 014 G1)
  if (params.get('routines') === 'none') store.routines = [];
  // ?routines=fail: the server cannot list routines (restarting); Home must not offer to set a radar up
  if (params.get('routines') === 'fail') store.routinesFail = true;
  if (params.get('issues') === 'none') store.conversations = store.conversations.filter((c) => c.cover?.kind !== 'radar');
  const journal = (n, name, issn) => ({ openalexId: `S${n}`, name, issn, match: `${name}, Invented Press, 1,200 works` });
  store.radar = {
    // spec 021: two namesakes, then four invented papers: two in the library, one with only an abstract, one with neither
    mine: {
      authors: [{ openalexId: 'A9', label: 'Ada Burrow, Invented University, 4 works' }, { openalexId: 'A10', label: 'Ada Burrow, Other College, 2 works' }],
      chosen: 'A9', problem: null,
      papers: [
        { title: 'Vole foraging under snow', year: 2025, doi: '10.1/v1', key: 'K0001', abstract: 'voles forage', openalexId: 'W1', inLibrary: true },
        { title: 'Burrow temperature in winter', year: 2024, doi: '10.1/v2', key: 'K0002', abstract: 'burrows', openalexId: 'W2', inLibrary: true },
        { title: 'Seed caches of field voles', year: 2023, doi: '10.1/v3', key: null, abstract: 'cached seeds', openalexId: 'W3', inLibrary: false },
        { title: 'A conference poster', year: 2022, doi: null, key: null, abstract: '', openalexId: 'W4', inLibrary: false },
      ],
    },
    seed: {
      topics: [{ text: 'vole foraging behaviour', weight: 1, origin: 'seed' }, { text: 'burrow ecology', weight: 0.6, origin: 'seed' }, { text: 'seed hoarding', weight: 0.3, origin: 'seed' }],
      authors: [{ name: 'A. Bramblewood', weight: 1, origin: 'seed', openalexId: 'A1', match: 'A. Bramblewood, Invented University, 120 works' }, { name: 'C. Quills', weight: 0.5, origin: 'seed', openalexId: 'A2', match: 'C. Quills, Invented Institute, 40 works' }],
      journals: [{ name: 'Journal of Invented Zoology', weight: 1, origin: 'seed', openalexId: 'S1', match: 'Journal of Invented Zoology, Invented Press, 1,200 works' }, { name: 'Annals of Burrowing', weight: 0.4, origin: 'seed', openalexId: 'S2', match: 'Annals of Burrowing, Invented Press, 300 works' }],
    },
    check(input) {
      if (input.includes('good.example')) return { kind: 'feed', url: input, title: 'Good feed', items: 12 };
      if (input.includes('nature.example')) return { kind: 'feed-blocked', url: input, reason: 'This site sends feed requests to a sign-in page.', journals: [journal(7, 'Nature of Voles', '1234-5678')] };
      if (/^\d{4}-\d{3}[\dX]$/.test(input)) return { kind: 'journal', ...journal(4, 'Invented Materials', input) };
      if (input === 'invented') return { kind: 'journals', options: [journal(5, 'Invented Letters', '1111-2222'), journal(6, 'Invented Reviews', null)] };
      return { kind: 'error', message: `No journal found for "${input}". Try its full name or its ISSN.` };
    },
  };
  store.projects = [{ id: 'p1', name: 'Voles', created: hoursAgo(100), updated: hoursAgo(100) }];
  return store;
}
