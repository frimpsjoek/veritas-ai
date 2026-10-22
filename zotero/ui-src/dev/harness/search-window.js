// @ts-nocheck -- harness glue. Stubs what a Zotero chrome window gives content/search.js, then loads the real file.
const params = new URLSearchParams(location.search);
const obsidian = params.get('tokens') === 'obsidian';
document.getElementById('tokens').setAttribute('href', '../../styles/tokens-zotero.css');
if (params.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
const calls = { searches: [], opened: [], shown: [], added: [], prefs: {}, launched: [], closed: 0, errors: [] };
const HITS = [
  { path: 'zotero/AAAA1111', title: 'Foraging Strategies of the Lesser Spangled Vole', zotero: { authors: ['A. Bramblewood'], year: '2021', venue: 'Journal of Invented Zoology' }, passages: [{ heading: 'Methods', snippet: 'Voles were tracked. See [@bramblewood2021].' }] },
  { path: 'Notes/Vole winter diet.md', title: 'Vole winter diet', modified: '2024-03-02', passages: [{ heading: '', snippet: 'Seeds and bark.' }] },
];
const PAPERS = [
  { title: 'A Unified Theory of Doorknob Ergonomics', authors: ['P. Handlebar'], year: 2019, venue: 'Proceedings of Everyday Design', doi: '10.1/x', abstract: 'Doorknobs, revisited.', cites: 12, sources: ['OpenAlex'] },
  { title: 'Already Owned Paper', authors: ['Q. Owner', 'R. Keeper', 'S. Third'], year: 2020, venue: 'V', key: 'OWNED001', abstract: '' },
];
class Discover {
  static SOURCES = [{ id: 'openalex', label: 'OpenAlex' }, { id: 'arxiv', label: 'arXiv' }];
  chosenSources() { return ['openalex']; }
  async search() { await new Promise((r) => setTimeout(r, 30)); const out = PAPERS.map((p) => ({ ...p })); out.failed = ['arXiv']; return out; }
  async related(item) { return { work: { title: 'Seed paper' }, groups: [['Cited by', [{ ...PAPERS[0] }]], ['References', [{ ...PAPERS[1] }]]] }; }
  async add(paper) { calls.added.push(paper.title); return { key: 'NEWKEY01' }; }
}
window.arguments = [{ SecondBrain: {
  Discover,
  async searchAll(query, limit, source, exclude) {
    calls.searches.push({ query, limit, source, exclude });
    if (query === 'offline-notes') throw new Error('Notes need the Second Brain server');
    return source === 'zotero' ? HITS.slice(0, 1) : exclude === 'zotero' ? HITS.slice(1) : HITS;
  },
  unreachable: (e) => `UNREACHABLE: ${e.message}`,
  renderSnippet(doc, text) { const f = doc.createDocumentFragment(); const parts = text.split(/(\[@[^\]]+\])/); for (const p of parts) { if (/^\[@/.test(p)) { const c = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span'); c.className = 'sb-cite-chip'; c.textContent = 'Bramblewood 2021'; f.append(c); } else f.append(p); } return f; },
  async papersInHits(hits) { return hits.filter((h) => h.path.startsWith('zotero/')).map((h) => h.path.slice(7)); },
  showPapersInLibrary(keys) { calls.shown.push(keys); },
  open(path) { calls.opened.push(path); },
} }];
window.opener = { Zotero: { Prefs: { get: () => null, set: (k, v) => { calls.prefs[k] = v; } }, launchURL: (u) => calls.launched.push(u), Libraries: { userLibraryID: 1 },
  Items: { getByLibraryAndKey: (lib, key) => ({ key, getField: () => 'Seed paper title' }) }, getMainWindow: () => ({ focus() {} }), logError: (e) => calls.errors.push(String(e)) } };
window.Services = { wm: { getMostRecentWindow: () => null } };
const realClose = window.close; window.close = () => { calls.closed += 1; };
window.__sbSearchWindow = { calls };
const script = document.createElement('script');
script.src = '/repo/content/search.js';
script.onload = () => { const wait = setInterval(() => { if (document.querySelector('.sb-p-search')) { clearInterval(wait); window.__sbHarnessReady = true; } }, 20); };
document.body.append(script);
