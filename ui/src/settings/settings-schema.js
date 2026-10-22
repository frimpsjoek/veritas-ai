// @ts-check
// ui-src/src/settings/settings-schema.js (spec 016 U2). The one table behind Settings in Zotero, Obsidian and the web
// app: sections in order, and under each its rows. A row says what it is called, the one grey sentence under it,
// what control it needs, which apps show it, and where its value lives. The three hosts cannot drift because none of
// them lists rows of its own. A row whose host filter matches but has no renderer or handler in that host stays out
// of sight (the UI hides, never greys out), which is how rows that need a host-only widget wait for U5.
//
// Where a value lives (`store`):
//   "prefs"   host.prefs (Zotero.Prefs, Obsidian plugin data, the web app's prefs), keyed by `key`
//   "engine"  the agent's settings.json through (await host.ai()).settings.get/update, `key` a dotted path
//   "none"    nothing stored: an action, an info line or a widget that does its own saving (`custom` / `action`)

/** @typedef {"zotero" | "obsidian" | "web"} SettingsHost */
/** @typedef {"select" | "radio" | "toggle" | "text" | "password" | "number" | "lines" | "action" | "info" | "custom" | "placeholder"} RowKind */
/** @typedef {{
 *   id: string, section: string, label: string, help: string, kind: RowKind, hosts: SettingsHost[],
 *   advanced?: boolean, store: "prefs" | "engine" | "none", key?: string,
 *   options?: [string, string][], numeric?: boolean, nullable?: boolean, min?: number, max?: number, scale?: number, unit?: string,
 *   def?: unknown, needs?: "linksInside", custom?: string, action?: string, when?: "desktop" | "mobile", placeholder?: string, buttonLabel?: string, keywords?: string,
 * }} SettingsRow */
/** @typedef {{ id: string, label: string, icon: string, lead?: string }} SettingsSection */

/** @type {SettingsSection[]} */
export const SECTIONS = [
  { id: 'general', label: 'General', icon: 'settingsGeneral' },
  { id: 'models', label: 'Models', icon: 'settingsModels' },
  { id: 'mac', label: 'On this Mac', icon: 'settingsMac' },
  { id: 'research', label: 'Research', icon: 'settingsResearch' },
  { id: 'papers', label: 'Finding papers', icon: 'settingsPapers' },
  { id: 'radar', label: 'Reading radar', icon: 'settingsRadar' },
  { id: 'routines', label: 'Routines', icon: 'clock' },
  { id: 'sources', label: 'Sources and tools', icon: 'settingsSources' },
  { id: 'folders', label: 'Folders', icon: 'settingsIndex' },
  { id: 'index', label: 'Search index', icon: 'settingsIndex' },
  { id: 'server', label: 'Server and phone', icon: 'settingsServer' },
  { id: 'about', label: 'About', icon: 'settingsAbout' },
];

const ALL = /** @type {SettingsHost[]} */ (['zotero', 'obsidian', 'web']);
const WEB = /** @type {SettingsHost[]} */ (['web']);
const ZOTERO = /** @type {SettingsHost[]} */ (['zotero']);
const OBSIDIAN = /** @type {SettingsHost[]} */ (['obsidian']);

/** The engine's time limit per task, in minutes here and milliseconds there (agent-src/src/settings.js
 *  DEFAULT_TURN_WALL_CLOCK_MS; test/settings-schema.test.js keeps the two equal). */
export const WALL_CLOCK_DEFAULT_MINUTES = { chat: 5, ask: 5, lead: 6, researcher: 8, writer: 8, extract: 3 };
const TASKS = /** @type {[string, string][]} */ ([
  ['chat', 'Chat'], ['ask', 'Quick answer'], ['lead', 'Planning a review'], ['researcher', 'Researching for a review'],
  ['writer', 'Writing a review'], ['extract', 'Reading papers for columns'],
]);

/** @type {SettingsRow[]} */
export const ROWS = [
  // ------------------------------------------------------------------ General
  { id: 'general.theme', section: 'general', label: 'Appearance', help: 'Light, dark, or whatever this device is set to.', kind: 'radio', hosts: WEB, store: 'prefs', key: 'webTheme', def: 'system',
    options: [['system', 'Match this device'], ['light', 'Light'], ['dark', 'Dark']], keywords: 'theme dark light mode' },
  { id: 'general.homeColumns', section: 'general', label: 'Home: papers in columns', help: 'Two columns show only when the window is wide enough; a narrower window always shows one.', kind: 'radio', hosts: ALL, store: 'prefs', key: 'homeColumns', def: 'auto',
    options: [['auto', 'Two columns on wide screens'], ['one', 'Always one column']], keywords: 'layout columns home radar papers one two width' },
  { id: 'general.openLinks', section: 'general', label: 'Open links', help: 'Where a web link opens when you click it.', kind: 'radio', hosts: ['web', 'obsidian'], needs: 'linksInside', store: 'prefs', key: 'openLinks', def: 'inside',
    options: [['inside', 'Inside the app'], ['outside', 'In your browser']], keywords: 'links web page browser viewer external' },
  { id: 'general.colors', section: 'general', label: 'Colors', help: "By default the writing space uses Zotero's colors and follows light and dark mode.", kind: 'custom', hosts: ZOTERO, store: 'none', custom: 'zoteroColors', keywords: 'color background text accent highlight' },
  { id: 'general.updatesZotero', section: 'general', label: 'Updates', help: 'A new build from your Second Brain server can install itself while Zotero keeps running, with no restart. Public installs should leave this on GitHub releases.', kind: 'select', hosts: ZOTERO, store: 'prefs', key: 'updates', def: 'github',
    options: [['server', 'From my Second Brain server'], ['github', 'From GitHub releases (default)'], ['off', 'Off']] },
  { id: 'general.updatesObsidian', section: 'general', label: 'Updates', help: 'A new build from your Second Brain server can install itself while Obsidian keeps running, checked every 15 minutes.', kind: 'select', hosts: OBSIDIAN, store: 'prefs', key: 'updates', def: 'server',
    options: [['server', 'From my Second Brain server'], ['off', 'Off']] },
  { id: 'general.copyDepth', section: 'general', label: 'Copy for AI: link depth', help: '1 copies the note and the notes it links to; 2 also copies the notes those link to.', kind: 'select', hosts: OBSIDIAN, store: 'prefs', key: 'contextDepth', numeric: true, def: 1,
    options: [['0', 'Just the note'], ['1', '1 level'], ['2', '2 levels']] },
  { id: 'general.copySimilar', section: 'general', label: 'Copy for AI: add similar notes', help: 'Also include the 5 notes most similar in meaning, even if not linked.', kind: 'toggle', hosts: OBSIDIAN, store: 'prefs', key: 'contextSimilar', def: false },

  // ------------------------------------------------------------------ Models (models-widget.js draws it whole)
  { id: 'models.main', section: 'models', label: '', help: '', kind: 'custom', hosts: ALL, store: 'none', custom: 'models', keywords: 'models default model per task effort claude codex sonnet opus haiku provider cloud service endpoint openrouter lm studio add model id answer with menu' },

  // ------------------------------------------------------------------ On this Mac
  { id: 'mac.scanDirs', section: 'mac', label: 'Folders to look for models in', help: 'One folder per line. Models are found live, so adding one here is enough.', kind: 'lines', hosts: ALL, store: 'engine', key: 'local.scanDirs' },
  { id: 'mac.idleMinutes', section: 'mac', label: 'Stop an idle model after', help: 'Minutes without a question. The model opens again on the next one. Stopping it frees the memory it uses.', kind: 'number', hosts: ALL, store: 'engine', key: 'local.idleMinutes', min: 1, def: 5, unit: 'minutes' },
  { id: 'mac.allowReports', section: 'mac', label: 'Allow local models for reports', help: 'Not recommended. In tests a small model made up numbers and looped on long reports. Reports are written by Codex or Claude Code unless you turn this on.', kind: 'toggle', hosts: ALL, store: 'engine', key: 'local.allowReports', def: false },
  { id: 'mac.python', section: 'mac', label: 'Python for local models', help: 'Leave empty to use the arm64 environment Second Brain set up. Only change it if you moved that environment.', kind: 'text', hosts: ALL, store: 'engine', key: 'local.python', nullable: true, advanced: true, def: null, placeholder: 'Automatic' },
  { id: 'mac.external', section: 'mac', label: 'Use models from other apps', help: 'Also offer models that other apps on this Mac already downloaded.', kind: 'toggle', hosts: ALL, store: 'engine', key: 'local.external', advanced: true, def: true },

  // ------------------------------------------------------------------ Research
  { id: 'research.web', section: 'research', label: 'Search the web', help: 'A change here applies to new messages, with nothing to restart.', kind: 'select', hosts: ALL, store: 'engine', key: 'webSearchDefault', def: 'off',
    options: [['off', 'Off'], ['cached', 'When it helps'], ['live', 'Always']] },
  { id: 'research.askFirstRows', section: 'research', label: 'Ask first above this many papers', help: 'A step that would read more papers than this asks before it starts.', kind: 'number', hosts: ALL, store: 'engine', key: 'research.askFirstRows', min: 1, def: 50, advanced: true },
  { id: 'research.askFirstCells', section: 'research', label: 'Ask first above this many table cells', help: 'Papers times columns. A table bigger than this asks before it starts.', kind: 'number', hosts: ALL, store: 'engine', key: 'research.askFirstCells', min: 1, def: 200, advanced: true },
  { id: 'research.maxRows', section: 'research', label: 'Most papers in one table', help: 'A hard limit for a single step, however much you say yes.', kind: 'number', hosts: ALL, store: 'engine', key: 'research.maxRows', min: 1, def: 400, advanced: true },
  { id: 'research.concurrency', section: 'research', label: 'Researchers working in parallel', help: 'How many papers are read at the same time. Never above 6; more is faster but slows the Mac.', kind: 'number', hosts: ALL, store: 'engine', key: 'research.concurrency', min: 1, max: 6, def: 3, advanced: true, keywords: 'concurrency' },
  { id: 'research.toolCalls', section: 'research', label: 'Most lookups per answer', help: 'How many times one answer may search or read before it must stop. Empty means the built-in limit of 40.', kind: 'number', hosts: ALL, store: 'engine', key: 'turnLimits.toolCallBudget', nullable: true, min: 1, def: null, advanced: true, placeholder: '40', keywords: 'tool call budget' },
  ...TASKS.map(([role, label]) => /** @type {SettingsRow} */ ({
    id: `research.minutes.${role}`, section: 'research', label: `Time limit: ${label.toLowerCase()}`, help: 'Minutes before this task is stopped.', kind: 'number', hosts: ALL, store: 'engine',
    key: `turnLimits.wallClockMs.${role}`, scale: 60000, min: 1, def: WALL_CLOCK_DEFAULT_MINUTES[/** @type {"chat"} */ (role)], advanced: true, unit: 'minutes', keywords: 'time wall clock limit',
  })),

  // ------------------------------------------------------------------ Finding papers
  { id: 'papers.email', section: 'papers', label: 'Email', help: 'Unpaywall asks for a real address you read, as its terms request. It also makes Crossref faster. It stays on this computer.', kind: 'text', hosts: ZOTERO, store: 'prefs', key: 'email', placeholder: 'you@university.edu', keywords: 'unpaywall crossref' },
  { id: 'papers.openalex', section: 'papers', label: 'OpenAlex API key', help: 'OpenAlex limits how much anyone can search without a key. A free key from openalex.org removes the limit, for every app.', kind: 'custom', hosts: ALL, store: 'none', custom: 'openalexKey', keywords: 'openalex key api limit' },
  { id: 'papers.unpaywall', section: 'papers', label: 'Unpaywall API key', help: 'Optional. Leave empty to use your email instead. If it says "Invalid api_key", clear it.', kind: 'password', hosts: ZOTERO, store: 'prefs', key: 'unpaywallKey', placeholder: 'api_key' },
  { id: 'papers.s2', section: 'papers', label: 'Semantic Scholar API key', help: 'Free. Without a key it often says "too many requests". Request one at semanticscholar.org/product/api.', kind: 'password', hosts: ZOTERO, store: 'prefs', key: 'semanticScholarKey', placeholder: 'x-api-key' },
  { id: 'papers.test', section: 'papers', label: 'Test keys', help: 'Each service should say "works". Nothing here is required: without keys the PDF finder still tries arXiv, Semantic Scholar and Europe PMC.', kind: 'action', hosts: ZOTERO, store: 'none', action: 'testKeys', buttonLabel: 'Test keys' },

  // ------------------------------------------------------------------ Reading radar and routines (web: moved here from the sidebar)
  { id: 'radar.setup', section: 'radar', label: '', help: '', kind: 'custom', hosts: WEB, store: 'none', custom: 'radarSetup', keywords: 'radar reading new papers seeds my papers journals feeds arxiv sources topics authors daily' },
  { id: 'routines.list', section: 'routines', label: 'Your routines', help: 'Reports and watches that run on a schedule, and the reading radar. Open one to change it, run it now or pause it.', kind: 'custom', hosts: WEB, store: 'none', custom: 'routinesList', keywords: 'routines schedule watch digest daily weekly report automation' },

  // ------------------------------------------------------------------ Sources and tools
  { id: 'sources.chips', section: 'sources', label: '', help: '', kind: 'custom', hosts: ALL, store: 'none', custom: 'sourcesChips', keywords: 'sources papers notes zotero obsidian clippings images pdfs scholarly openalex web radar watch feeds on off' },
  { id: 'sources.mcp', section: 'sources', label: 'Outside sources', help: "Read-only lookups such as PubMed or ClinicalTrials.gov. Every tool a server offers is checked first: anything that can change something is hidden, and anything that doesn't say is hidden until you trust that server.", kind: 'custom', hosts: ALL, store: 'none', custom: 'mcp', advanced: true, keywords: 'mcp server pubmed trust tool' },
  { id: 'sources.radar', section: 'sources', label: 'Radar sources', help: 'The journals, feeds and searches your radar watches.', kind: 'custom', hosts: WEB, store: 'none', custom: 'radarLink', advanced: true },

  // ------------------------------------------------------------------ Search index
  { id: 'folders.list', section: 'folders', label: 'Folders the search reads', help: 'Any folder of notes, PDFs and images on the computer that runs Second Brain. An Obsidian vault and your Zotero library are recognised by what is in them.', kind: 'custom', hosts: WEB, store: 'none', custom: 'folders', keywords: 'folders vault obsidian zotero library add folder markdown pdf' },
  { id: 'index.status', section: 'index', label: 'What the search covers', help: 'What is indexed, and whether it is up to date.', kind: 'custom', hosts: WEB, store: 'none', custom: 'indexStatus', keywords: 'index update coverage documents' },
  { id: 'index.open', section: 'index', label: 'Index status', help: "What's indexed, what's running now, and buttons to update, stop or re-read sources.", kind: 'action', hosts: OBSIDIAN, store: 'none', action: 'openIndexStatus', buttonLabel: 'Open' },

  // ------------------------------------------------------------------ Server and phone
  { id: 'server.start', section: 'server', label: 'Start the index server with Obsidian', help: 'Runs the local search index while Obsidian is open, and keeps it up to date.', kind: 'toggle', hosts: OBSIDIAN, when: 'desktop', store: 'prefs', key: 'startServer', def: true },
  { id: 'server.kbDir', section: 'server', label: 'Index folder', help: 'Where kb.py lives.', kind: 'text', hosts: OBSIDIAN, when: 'desktop', store: 'prefs', key: 'kbDir' },
  { id: 'server.vault', section: 'server', label: 'Obsidian vault', help: 'Optional. With the server, notes sync with Obsidian and you get similar papers, notes that cite a paper, full-text search and the drive search for lost PDFs.', kind: 'text', hosts: ZOTERO, store: 'prefs', key: 'vault', placeholder: 'Second-Brain' },
  { id: 'server.addressZotero', section: 'server', label: 'Server address', help: 'Where the Second Brain server listens.', kind: 'text', hosts: ZOTERO, store: 'prefs', key: 'server', def: 'http://127.0.0.1:27182' },
  { id: 'server.tokenZotero', section: 'server', label: 'Access token', help: 'Only for a server on another computer: the token it shows when you set up a device. A server on this computer needs none.', kind: 'password', hosts: ZOTERO, store: 'prefs', key: 'token', keywords: 'token bearer server remote' },
  { id: 'server.addressObsidian', section: 'server', label: 'Mac address', help: "The Mac's Tailscale address and port.", kind: 'text', hosts: OBSIDIAN, store: 'prefs', key: 'remoteUrl', keywords: 'tailscale server address' },
  { id: 'server.token', section: 'server', label: 'Access token', help: 'Filled in by the setup QR code on your Mac.', kind: 'text', hosts: OBSIDIAN, when: 'mobile', store: 'prefs', key: 'token' },
  { id: 'server.test', section: 'server', label: 'Test connection', help: 'Checks that this device can reach your Mac.', kind: 'action', hosts: OBSIDIAN, when: 'mobile', store: 'none', action: 'testConnection', buttonLabel: 'Test' },
  { id: 'server.python', section: 'server', label: 'Python for the index', help: 'The Python that runs the search index.', kind: 'text', hosts: OBSIDIAN, when: 'desktop', store: 'prefs', key: 'python', advanced: true },
  { id: 'server.port', section: 'server', label: 'Port', help: 'Local port. Only this Mac and your Tailscale devices can reach it.', kind: 'number', hosts: OBSIDIAN, when: 'desktop', store: 'prefs', key: 'port', min: 1025, max: 65535, advanced: true },
  { id: 'server.phone', section: 'server', label: 'Use on your phone', help: 'Opens Second Brain on your phone, already signed in.', kind: 'custom', hosts: ['web', 'obsidian'], store: 'none', custom: 'phone', keywords: 'phone qr tailscale iphone' },

  // ------------------------------------------------------------------ About
  { id: 'about.version', section: 'about', label: 'Version', help: 'The build you are running.', kind: 'custom', hosts: ALL, store: 'none', custom: 'version' },
  { id: 'about.update', section: 'about', label: 'Check for updates', help: 'Looks for a newer build now instead of waiting for the next check.', kind: 'action', hosts: ['zotero', 'obsidian'], store: 'none', action: 'checkUpdates', buttonLabel: 'Check now' },
  { id: 'about.logs', section: 'about', label: 'Logs folder', help: 'Where Second Brain writes its logs, for when something goes wrong.', kind: 'action', hosts: ALL, store: 'none', action: 'openLogs', buttonLabel: 'Show' },
  { id: 'about.diagnostics', section: 'about', label: 'Copy diagnostics', help: 'Copies version and status details you can paste into a message. It contains no keys or notes.', kind: 'action', hosts: ALL, store: 'none', action: 'copyDiagnostics', buttonLabel: 'Copy' },
];

// ---------------------------------------------------------------------------------------- reading and writing

/** Dotted-path read. @param {any} object @param {string} path */
export function getPath(object, path) {
  return path.split('.').reduce((value, part) => (value == null ? undefined : value[part]), object);
}

/** A nested patch from a dotted path: ("turnLimits.wallClockMs.chat", 60000) -> { turnLimits: { wallClockMs: { chat: 60000 } } }.
 *  @param {string} path @param {unknown} value @returns {Record<string, any>} */
export function patchFor(path, value) {
  return path.split('.').reduceRight((inner, part) => ({ [part]: inner }), /** @type {any} */ (value));
}

/** The value a row shows: stored, else its default (already in display units). A stored number with a `scale` is shown divided (minutes, not ms).
 *  @param {SettingsRow} row @param {{ prefs: { get<T>(k: string): T | undefined }, settings: any }} state */
export function readRow(row, state) {
  if (!row.key) return undefined;
  let value = row.store === 'engine' ? getPath(state.settings, row.key) : state.prefs.get(row.key);
  if (value === undefined || value === null || value === '') return row.def ?? (row.nullable ? null : undefined);
  return typeof value === 'number' && row.scale ? value / row.scale : value;
}

/** What gets written for an edited row, as { prefs: [key, value] } or { engine: patch }, or null when the value is not
 *  acceptable (not a number, out of range). An emptied text pref is cleared (undefined); everything else is stored as
 *  given, so a host's own default can change later without a stale copy of it sitting in the prefs.
 *  @param {SettingsRow} row @param {unknown} value @returns {{ prefs: [string, unknown] } | { engine: Record<string, any> } | null} */
export function writeRow(row, value) {
  if (!row.key) throw new Error(`row ${row.id} has no key`);
  let next = value;
  if (row.kind === 'number' || row.numeric) {
    next = value === '' || value == null ? null : Number(value);
    if (next != null && (!Number.isFinite(/** @type {number} */ (next)) || (row.min != null && /** @type {number} */ (next) < row.min) || (row.max != null && /** @type {number} */ (next) > row.max))) return null;
    if (next == null && !row.nullable) return null;
    if (typeof next === 'number' && row.scale) next = Math.round(next * row.scale);
  } else if (row.kind === 'lines') {
    next = String(value).split('\n').map((line) => line.trim()).filter(Boolean);
  } else if (row.kind === 'text' || row.kind === 'password') {
    next = String(value ?? '').trim();
    if (next === '' && row.nullable) next = null;
  }
  if (row.store === 'engine') return { engine: patchFor(row.key, next) };
  return { prefs: /** @type {[string, unknown]} */ ([row.key, next === '' ? undefined : next]) };
}

// ---------------------------------------------------------------------------------------- which rows show

/** @param {SettingsRow} row @param {SettingsHost} host @param {"desktop" | "mobile"} [platform] */
export function rowApplies(row, host, platform = 'desktop') {
  return row.hosts.includes(host) && (!row.when || row.when === platform);
}

/** A row with `needs` is drawn only where the host has that capability (UiHost.can), e.g. Open links where links open inside the app.
 *  @param {SettingsRow} row @param {Record<string, boolean> | undefined} can */
export function rowAllowed(row, can) {
  return !row.needs || Boolean(can?.[row.needs]);
}

/** @param {SettingsRow} row @param {string} query */
export function rowMatches(row, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [row.label, row.help, row.keywords ?? ''].some((text) => text.toLowerCase().includes(needle));
}

/**
 * What the view draws: the sections that have rows, each with the rows to show.
 * - No query: only the chosen `section` (null = every section), its advanced rows only when `advanced[section]`.
 * - A query: every section's matching rows, advanced ones included (a hit you cannot see is no hit), sections with
 *   no hit left out.
 * @param {{ host: SettingsHost, platform?: "desktop" | "mobile", query?: string, section?: string | null, advanced?: Record<string, boolean>, supports?: (row: SettingsRow) => boolean }} opts
 * @returns {{ section: SettingsSection, rows: SettingsRow[], hiddenAdvanced: number }[]}
 */
export function visibleSections({ host, platform = 'desktop', query = '', section = null, advanced = {}, supports = () => true }) {
  const searching = query.trim() !== '';
  const out = [];
  for (const s of SECTIONS) {
    if (!searching && section && s.id !== section) continue;
    const mine = ROWS.filter((r) => r.section === s.id && rowApplies(r, host, platform) && supports(r));
    const hits = mine.filter((r) => rowMatches(r, query));
    const shown = searching || advanced[s.id] ? hits : hits.filter((r) => !r.advanced);
    if (shown.length || (!searching && section && s.id === section)) out.push({ section: s, rows: shown, hiddenAdvanced: hits.length - shown.length });
  }
  return out;
}

/** The sections the sidebar lists for this host (one with no row to show is left out). @param {SettingsHost} host @param {"desktop" | "mobile"} [platform] @param {(row: SettingsRow) => boolean} [supports] */
export function sidebarSections(host, platform = 'desktop', supports = () => true) {
  return SECTIONS.filter((s) => ROWS.some((r) => r.section === s.id && rowApplies(r, host, platform) && supports(r)));
}
