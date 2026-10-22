// @ts-check
// ui-src/src/index.js. Entry point bundled by build.mjs into content/sb-ui.js (IIFE, global SecondBrainUI) and
// imported directly by Obsidian's esbuild. Stage B (this file, for now): a trivial component — an icon row and
// a pill row — that proves the pipeline end to end (host, tokens, icons, `h()`) before the real chat moves in
// (stage C). `renderSourcePills` previews spec 005 §5's four source pills so the shared harness has something
// real to screenshot in both token maps, light and dark.
import { h } from './dom.js';
import { icon, ICONS } from './icons.js';

/** @typedef {import("./host").UiHost} UiHost */
/** @typedef {import("../../agent/src/domain").Sources} Sources */

export const PILL_ICON = { papers: 'paper', notes: 'note', scholarly: 'scholarly', web: 'web' };

/** @type {Sources} */
const DEFAULT_SOURCES = { papers: true, notes: true, scholarly: true, web: false };

/**
 * Renders every icon in the shared set as a row, so a broken glyph or a namespace mistake (createElement instead
 * of createElementNS) is visible immediately in both a Zotero chrome document and an ordinary HTML one.
 * @param {Document} doc
 */
export function renderIconRow(doc) {
  const row = h(doc, 'div', 'sb-p-icon-row');
  for (const name of Object.keys(ICONS)) row.append(icon(doc, name, 'sb-p-icon'));
  return row;
}

/**
 * The four source pills (spec 005 §5). Reads and writes `host.prefs` under "chatSources", the same key both
 * real hosts use, so this trivial component already exercises the whole UiHost -> prefs round trip.
 * @param {Document} doc @param {UiHost} host
 */
export function renderSourcePills(doc, host) {
  const row = h(doc, 'div', 'sb-p-pill-row');
  const sources = { ...DEFAULT_SOURCES, ...(host.prefs.get('chatSources') ?? {}) };
  for (const key of /** @type {('papers' | 'notes' | 'scholarly' | 'web')[]} */ (['papers', 'notes', 'scholarly', 'web'])) {
    const pill = h(doc, 'button', 'sb-p-pill');
    pill.setAttribute('type', 'button');
    pill.append(icon(doc, PILL_ICON[key], 'sb-p-icon'), h(doc, 'span', '', key[0].toUpperCase() + key.slice(1)));
    pill.classList.toggle('is-on', Boolean(sources[key]));
    pill.setAttribute('aria-pressed', String(Boolean(sources[key])));
    pill.addEventListener('click', () => {
      sources[key] = !sources[key];
      host.prefs.set('chatSources', sources);
      pill.classList.toggle('is-on', sources[key]);
      pill.setAttribute('aria-pressed', String(sources[key]));
    });
    row.append(pill);
  }
  return row;
}

/**
 * @param {Document} doc @param {UiHost} host
 */
export function renderDemo(doc, host) {
  const root = h(doc, 'div', 'sb-p-demo');
  root.append(renderIconRow(doc), renderSourcePills(doc, host));
  host.mount(root);
  return root;
}

export { h } from './dom.js';
export { icon, ICONS } from './icons.js';

// spec 005 C1: the shared chat, moved from the Zotero-only content/chat.js, content/find-view.js and
// content/report-view.js.
export { ChatView } from './chat/chat.js';
export { FindView } from './chat/find-view.js';
export { ReportView } from './chat/report-view.js';
export { renderMarkdown } from './chat/markdown.js';

// spec 007 E3: artifacts (result cards, the side panel) and the pure exporters behind Download.
export { ArtifactCard } from './chat/artifact-card.js';
export { ArtifactPanel, downloadResult } from './chat/artifact-panel.js';
export { toCsv } from './export/csv.js';
export { toRis } from './export/ris.js';
export { toMarkdown } from './export/markdown.js';

// spec 005 D1: the panel components (Section, Row, SearchBar, PaperCard, StatusPanel, states) and their pure helpers.
export { Button, IconButton, StateLine, Section, Row, Tabs, SearchBar, PaperCard, Highlight, Progress, StatusPanel, Subhead, ChipRow } from './panels/panels.js';
export * from './panels/data.js';
export { SearchPanel } from './panels/search-panel.js';
// spec 013 W2: Related, Links and Duplicates, host-agnostic (Obsidian passes fetchJSON/open/decorate; the web app its router).
export { RelatedPanel, LinksPanel, DuplicatesPanel } from './panels/related-panels.js';
export * from './panels/related-data.js';
// spec 014 G4: Home, mounted by Zotero's Home tab and Obsidian's Home view.
export { HomeView } from './home/home.js';

// spec 016: the one Settings view, mounted by the Zotero preferences pane and the Obsidian settings tab.
export { SettingsView } from './settings/settings-view.js';
