// @ts-nocheck -- harness glue (loose window globals), like the other pages in this folder.
// ui-src/dev/harness/panels.js. Every spec 005 D1 panel component with invented content, for dev/panels-checks.mjs.
// `window.__sbPanels` = { calls (what the components reported), ready }. Content is invented, never the user's library.
const params = new URLSearchParams(location.search);
const obsidian = params.get('tokens') === 'obsidian';
document.getElementById('tokens').setAttribute('href', obsidian ? '../../styles/tokens-obsidian.css' : '../../styles/tokens-zotero.css');
if (params.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
if (obsidian) {
  const standins = document.getElementById('standins');
  standins.textContent = standins.textContent.replace(':root[data-theme="dark"] {', ':root[data-theme="dark"] body {').replace(/:root \{/, 'body {');
}
const U = window.SecondBrainUI;
const frame = document.getElementById('frame');
const width = params.get('w');
if (width) frame.style.width = `${width}px`;
frame.style.padding = '12px';
const doc = document;
const calls = { opened: [], actions: [], scopes: [], queries: [], clicks: [] };

const heading = (text) => { const el = doc.createElement('div'); el.className = 'sb-p-meta'; el.style.cssText = 'margin: 16px 0 4px;'; el.textContent = text; el.dataset.demo = text; return el; };
const put = (id, node) => { const wrap = doc.createElement('div'); wrap.id = id; wrap.append(node); frame.append(heading(id), wrap); return wrap; };

// ---- SearchBar
const bar = U.SearchBar(doc, {
  placeholder: 'Search by words or meaning…', papers: true, notes: true,
  options: [['', 'Any source'], ['zotero', 'Zotero'], ['personal', 'My notes'], ['Notion', 'Notion'], ['pdf', 'PDFs'], ['image', 'Images'], ['ai_notes', 'AI notes']],
  onQuery: (q, now) => calls.queries.push([q, now]), onScope: (s) => calls.scopes.push(s),
});
put('searchbar', bar.el);

// ---- Section + Row (related notes): a long title, a score, actions, a trailing node, an empty section
const rel = U.Section(doc, { title: 'Linked', count: 3, actions: [{ icon: 'duplicate', label: 'Copy as links', onClick: () => calls.actions.push('copy-all') }] });
const near = U.closeness(0.93);
rel.body.append(
  U.Row(doc, { path: 'Notes/Vole winter diet.md', title: 'Vole winter diet', meta: 'Notes · both ways', onOpen: () => calls.opened.push('vole'),
    actions: [{ icon: 'duplicate', label: 'Copy link', onClick: () => calls.actions.push('copy-vole') }] }).el,
  U.Row(doc, { path: 'zotero/AAAA1111', title: 'A Unified Theory of Doorknob Ergonomics, with a Very Long Subtitle That Goes On To Say Rather More Than Anyone Needs To Read In One Sitting',
    meta: 'Handlebar · 2019 · Proceedings of Everyday Design', score: near, onOpen: () => calls.opened.push('doorknob') }).el,
  U.Row(doc, { path: 'Papers/Handle.pdf', title: 'Handle ergonomics scan', meta: 'Papers · 12 Mar 2024', badge: 'PDF', snippet: 'Grip strength dropped by a third when the handle diameter passed 45 mm in the trial.',
    onOpen: () => calls.opened.push('handle'), trailing: Object.assign(doc.createElement('span'), { className: 'sb-p-meta', textContent: '→' }) }).el,
);
put('section', rel.el);
const empty = U.Section(doc, { title: 'Shared tags', count: 0, empty: "No other notes share this note's tags." });
put('section-empty', empty.el);

// ---- a search hit with passages
put('hit', U.Row(doc, { path: 'zotero/BBBB2222', title: 'Foraging Strategies of the Lesser Spangled Vole', meta: 'Bramblewood & Quills · 2021 · Journal of Invented Zoology',
  passages: [
    { heading: 'Methods', snippet: 'Voles were tracked across 14 plots under three snow depths and their caches counted each dawn.', onOpen: () => calls.opened.push('passage-1') },
    { heading: 'Results', snippet: 'Caching rose with depth.', onOpen: () => calls.opened.push('passage-2') },
  ], onOpen: () => calls.opened.push('hit') }).el);

// ---- states
const states = doc.createElement('div');
states.append(U.StateLine(doc, 'loading', 'Searching…'), U.StateLine(doc, 'error', "Search failed: the Second Brain server isn't running."), U.StateLine(doc, 'empty', 'No matching notes.'));
put('states', states);

// ---- tabs
put('tabs', U.Tabs(doc, [{ id: 'exact', label: 'Identical', count: 4 }, { id: 'near', label: 'Nearly identical', count: 12 }, { id: 'conflicts', label: 'Sync conflicts', count: 0 }, { id: 'zotero', label: 'Zotero', count: 2 }], 'near', (id) => calls.clicks.push(`tab:${id}`)));

// ---- paper card + highlights
const card = U.PaperCard(doc, {
  kicker: 'Journal article', title: 'Foraging Strategies of the Lesser Spangled Vole in Deep Snow: A Survey Across Fourteen Alpine Plots',
  authors: ['A. Bramblewood', 'C. Quills', 'D. Thistle', 'E. Marlow', 'F. Pike', 'G. Rook', 'H. Sedge', 'I. Wren', 'J. Tamsin', 'K. Fennel'],
  venue: 'Journal of Invented Zoology 12(3) · pp. 40-58 · 2021',
  chips: [{ text: '@bramblewood2021', title: 'Copy citation', onClick: () => calls.clicks.push('chip-cite') }, { text: 'DOI 10.9999/jiz.2021.001', href: 'https://doi.org/10.9999/jiz.2021.001' }],
  actions: [{ label: 'Open PDF', icon: 'paper', primary: true, onClick: () => calls.clicks.push('open-pdf') }, { label: 'Create paper note', icon: 'pen', onClick: () => calls.clicks.push('note') },
    { label: 'Show in Zotero, and then keep the library window open next to this tab so that you can compare the two', icon: 'book', onClick: () => calls.clicks.push('zotero') }],
});
put('papercard', card.el);
const hls = doc.createElement('div');
hls.append(U.Highlight(doc, { type: 'highlight', color: '#ffd400', text: 'Caching rose with snow depth in every plot we measured, and the effect was largest where cover lasted past March.', comment: 'Check against the 2019 plots', page: '7' }),
  U.Highlight(doc, { type: 'underline', color: '#ff6666', text: 'Underlined sentence.', page: '9' }));
put('highlights', hls);

// ---- status panels
const running = U.StatusPanel(doc, { state: 'running', label: 'Reading Zotero items', progress: { done: 1200, total: 3500 }, lines: ['1,200 of 3,500 · 90/min · about 25 min left', 'Started 4 min ago'],
  actions: [{ label: 'Stop', danger: true, onClick: () => calls.clicks.push('stop') }],
  rows: [{ label: 'Zotero papers', count: 3517, pct: 100 }, { label: 'AI notes', count: 5503, pct: 64 }, { label: 'Images with text', count: 3587, pct: 8 }],
  notes: ['9,000 passages indexed', 'Keyword search covers everything immediately; search by meaning follows as passages are processed.'] });
put('status-running', running.el);
const idle = U.StatusPanel(doc, { state: 'idle', label: 'Idle', lines: ['Last run finished 5 min ago', 'Next automatic check in 3 min'],
  actions: [{ label: 'Update now', primary: true, onClick: () => calls.clicks.push('update') }, { label: 'Re-read Zotero', onClick: () => {} }, { label: 'Re-read every image and PDF, running text recognition on all of them again', onClick: () => {} }] });
put('status-idle', idle.el);
put('status-error', U.StatusPanel(doc, { state: 'error', label: 'Indexing stopped', lines: ['Error: the embedding model did not answer'], compact: true }).el);


// ---- SearchPanel (spec 005 D2) on a fake adapter: scope and query are recorded, `slow` delays an answer
const HITS = [
  { path: 'zotero/AAAA1111', title: 'Foraging Strategies of the Lesser Spangled Vole', zotero: { authors: ['A. Bramblewood', 'C. Quills'], year: '2021', venue: 'Journal of Invented Zoology' },
    passages: [{ heading: 'Methods > Plots', snippet: '**Voles** were tracked across 14 plots.' }] },
  { path: 'Notes/Vole winter diet.md', title: 'Vole winter diet', modified: '2024-03-02', passages: [{ heading: '', snippet: '## Seeds and bark, mostly. See [@bramblewood2021].' }] },
  { path: 'Scans/handle.pdf', title: 'Handle scan', modified: '2023-11-30', passages: [{ heading: 'Page 3', snippet: 'Grip strength dropped.' }] },
];
const sp = { searches: [], opens: [], decorated: 0, mode: 'ok' };
const adapter = {
  search: async (query, scope, limit) => {
    sp.searches.push({ query, scope, limit });
    if (sp.mode === 'error') throw new Error('Search backend exploded');
    if (query === 'slow') { await new Promise((r) => setTimeout(r, 300)); return [HITS[2]]; }
    if (query === 'none') return [];
    if (scope.source === 'zotero') return HITS.filter((x) => x.path.startsWith('zotero/'));
    if (scope.exclude === 'zotero') return HITS.filter((x) => !x.path.startsWith('zotero/'));
    return HITS;
  },
  open: (hit, opts) => sp.opens.push({ path: hit.path, newTab: opts.newTab, heading: opts.heading }),
  rowActions: (hit) => [{ icon: 'duplicate', label: 'Copy link', onClick: () => calls.actions.push(`copy:${hit.path}`) }],
  after: (hits, seq, panel) => { panel.footer.replaceChildren(U.Button(doc, `Show ${hits.length} papers in library`, () => calls.clicks.push('show-papers'))); },
};
const panel = new U.SearchPanel(doc, { adapter, placeholder: 'Search by words or meaning…', hint: 'Search your notes and Zotero library by words or meaning.', limit: 30, selectFirst: true, enterOpens: true,
  options: [['', 'Any source'], ['zotero', 'Zotero'], ['personal', 'My notes'], ['pdf', 'PDFs'], ['ai_notes', 'AI notes']] });
const spWrap = doc.createElement('div');
spWrap.id = 'searchpanel';
spWrap.style.cssText = 'height: 520px; border: 1px solid var(--sb-ui-line);';
spWrap.append(panel.root);
frame.append(heading('searchpanel'), spWrap);
// a second panel that decorates (Obsidian's way) and uses the handler (Zotero's online mode)
const deco = new U.SearchPanel(doc, { adapter: { ...adapter, decorate: (el, hit, heading) => { sp.decorated += 1; el.addEventListener('click', () => sp.opens.push({ path: hit.path, via: 'decorate', heading })); } }, placeholder: 'Search…', hint: 'Hint', showPills: false });
const decoWrap = doc.createElement('div');
decoWrap.id = 'searchdeco'; decoWrap.style.cssText = 'height: 320px; border: 1px solid var(--sb-ui-line);'; decoWrap.append(deco.root);
frame.append(heading('searchdeco'), decoWrap);

// ---- duplicates-like group, callout, removed row (spec 005 D4) and the compact, flat status used in Zotero's settings
const dg = doc.createElement('div');
dg.className = 'sb-p-group';
const dupRows = ['Notes/Vole diet.md', 'Notes/Vole diet 2.md'].map((path, n) => U.Row(doc, { path, title: n ? 'Vole diet 2 (a copy made by a sync conflict with a long name)' : 'Vole diet', meta: 'Notes', onOpen: () => calls.opened.push(path),
  actions: [{ icon: 'columns', label: 'Compare side by side', onClick: () => calls.actions.push('compare') }, { icon: 'trash', label: 'Move this copy to trash', onClick: () => dupRows[n].el.classList.add('sb-p-removed') }] }));
dg.append(U.Row(doc, { icon: 'duplicate', title: 'Group meta', meta: 'Similarity 0.99' }).el, ...dupRows.map((r) => r.el));
put('dups', dg);
const callout = doc.createElement('div');
callout.className = 'sb-p-group sb-p-callout';
const ctext = doc.createElement('div'); ctext.className = 'sb-p-callout-text';
ctext.innerHTML = '<div class="sb-p-row-text">Remove the 12 identical copies</div><div class="sb-p-row-meta is-wrap">Each is byte-for-byte the same as its original, so nothing is lost. They go to your trash.</div>';
callout.append(ctext, U.Button(doc, 'Move all twelve identical sync-conflict copies to the trash', () => calls.clicks.push('trash-all'), { danger: true, icon: 'trash' }));
put('callout', callout);
const flat = doc.createElement('div'); flat.className = 'sb-p is-flat'; flat.style.background = 'transparent';
const model = U.StatusPanel(doc, { state: 'running', label: 'Reading your library… 1200 / 3500', compact: true });
flat.append(model.el);
put('model-state', flat);

window.__sbPanels = { model, calls, bar, sp, panel, deco };
window.__sbHarnessReady = true;
