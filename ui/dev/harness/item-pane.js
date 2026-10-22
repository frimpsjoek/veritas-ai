// @ts-nocheck -- harness glue. Loads the real content/ui-host-zotero.js and second-brain.js on stubs and draws the item pane's lists.
const params = new URLSearchParams(location.search);
document.getElementById('tokens').setAttribute('href', '../../styles/tokens-zotero.css');
if (params.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
const width = params.get('w');
const pane = document.getElementById('pane');
if (width) pane.style.width = `${width}px`;
window.Zotero = { Prefs: { get: () => null, set() {} }, Libraries: { userLibraryID: 1 }, Items: {}, getActiveZoteroPane: () => null, logError() {}, ItemTreeManager: {} };
window.Services = { wm: { getMostRecentWindow: () => null } };
const load = (src) => new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(src)); document.body.append(s); });
await load('/repo/content/second-brain.js');
await load('/repo/content/ui-host-zotero.js');
const sb = window.SecondBrain;
sb.rootURI = '/repo/';
const opened = [];
sb.open = (path) => opened.push(path);
const box = document.createElement('div');
box.className = 'sb-body';
pane.append(box);
const more = sb.related_(document);
box.append(more);
sb.list(more, 'Cited in your notes', [{ path: 'Notes/Vole winter diet.md', title: 'Vole winter diet' }], 'No other notes cite this paper. Cite it anywhere as [@key].');
sb.list(more, 'Related notes', [], 'Nothing close in your notes.');
sb.list(more, 'Similar papers in your library', [
  { path: 'zotero/AAAA1111', title: 'A Unified Theory of Doorknob Ergonomics, with a Very Long Subtitle That Goes On And On Past Any Pane Width', score: 0.93, zotero: { authors: ['P. Handlebar', 'Q. Knob', 'R. Latch'], year: '2019', venue: 'Proceedings of Everyday Design' } },
  { path: 'zotero/BBBB2222', title: 'Foraging Strategies of the Lesser Spangled Vole', score: 0.5, calibration: { p50: 0.3, p90: 0.4, p99: 0.45, p999: 0.5, p9999: 0.6 }, zotero: { authors: ['A. Bramblewood'], year: '2021' } },
], 'No similar papers found.');
box.append(sb.stateLine(document, 'info', 'For similar papers without Obsidian, download the search model in Second Brain settings (⚙).'));
const head = sb.el(document, 'div', 'sb-note-head sb-p is-flat');
head.append(SecondBrainUI.PaperCard(document, { kicker: 'Paper note', title: 'Foraging Strategies of the Lesser Spangled Vole', venue: 'Bramblewood · 2021 · Journal of Invented Zoology' }).el);
pane.append(head);
sb.addUiStyles(document, '/repo/'); // must be idempotent and add exactly two links
window.__sbItemPane = { opened };
window.__sbHarnessReady = true;
