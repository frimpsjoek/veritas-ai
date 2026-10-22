// @ts-nocheck -- harness glue (loose window globals), like the other pages in this folder.
// ui-src/dev/harness/home.js. Mounts SecondBrainUI.HomeView on a fake plugin host over web-store.js's invented library.
// `window.__sbHome` = { opened (every target Home handed to the host), json (every server call), ready }.
import { createFakeHost } from './fake-host.js';
import { webStore } from './web-store.js';

const params = new URLSearchParams(location.search);
const obsidian = params.get('tokens') === 'obsidian';
document.getElementById('tokens').setAttribute('href', obsidian ? '../../styles/tokens-obsidian.css' : '../../styles/tokens-zotero.css');
if (params.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
if (obsidian) {
  const standins = document.getElementById('standins');
  standins.textContent = standins.textContent.replace(':root[data-theme="dark"] {', ':root[data-theme="dark"] body {').replace(/:root \{/, 'body {');
}

// A 2x1 PNG, so "a graphical abstract was found" shows without a network.
const FIGURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGNoAAMACocDAcTGH2YAAAAASUVORK5CYII=';
const state = { opened: [], json: [], ready: false };
const host = createFakeHost({ kind: obsidian ? 'obsidian' : 'zotero', placement: 'tab', calls: [], sessionStore: webStore(params) });
host.json = async (path) => {
  state.json.push(path);
  return path.startsWith('/paper-figure') ? { image: FIGURE } : {};
};
const view = SecondBrainUI.HomeView(document, host, { open: (target) => state.opened.push(target) });
document.getElementById('frame').append(view.root);
state.refresh = () => view.refresh();
window.__sbHome = state;
state.ready = true;
