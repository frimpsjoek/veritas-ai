// @ts-check
// ui-src/src/chat/artifact-panel.js. The side panel that opens a result (spec 007 §4, Elicit 9.22.03): a header
// with the title, a version menu (each version's change line and date; an old one is read-only with "Restore as
// V(n+1)"), a download menu (CSV, CSV with quotes, RIS, Markdown), expand and close; a toolbar with Search, Sort,
// Filters and Columns (spec 007 E4); and the rows as a table or, when narrow, a card list. Columns fills new columns
// live: skeleton cells that fill as `cell` events arrive, a progress line with Stop, "Fill the rest" after a stop.
// Filters, search and sort are view state kept in host prefs per session and result, never a version.
// The panel owns no layout: chat.js places it (side by side, over the thread, or full view) and tells it which.
import { h } from '../dom.js';
import { outsideButton } from '../links.js';
import { icon } from '../icons.js';
import { toCsv } from '../export/csv.js';
import { toRis } from '../export/ris.js';
import { toMarkdown } from '../export/markdown.js';
import { canSave, saveText, fileStem } from '../export/save.js';
import { toGrid } from '../export/common.js';
import { openPopover, openSheet, menuItem } from './popover.js';
import { fillColumns } from './columns-panel.js';
import { fillFilters } from './filters-popover.js';
import { renderTable, renderCards, renderCell } from './artifact-table.js';
import { PapersChat } from './papers-chat.js';
import { addedRowSet } from './routines-data.js';
import { RadarDigest } from './radar-digest.js';
import { digestOf } from './radar-digest-data.js';
import { chatScope } from './papers-chat-data.js';
import {
  KIND_ICON, KIND_NAME, shortDate, sortOptions, sortLabel, visibleRows, hasQuotes, filterOptions, filtersActive, describeFilters, removeFilter,
  cleanFilters, viewParts, keepWhy, narrowDraft, withoutColumn, withLive, pendingCells, cellProgress, confirmLine, restCells, untouched, sourcesOf, gapCells,
} from './artifact-data.js';

/** @typedef {import("../host").UiHost} UiHost */
/** @typedef {import("../../../agent/src/domain").Result} Result */
/** @typedef {import("../../../agent/src/domain").ResultSummary} ResultSummary */
/** @typedef {"side" | "cover" | "full"} PanelMode */
/** @typedef {import("../../../agent/src/domain").ColumnSpec} ColumnSpec */
/** @typedef {{ step: string, sessionId: string, resultId: string, columns: number, total: number, done: number, stopping: boolean, ended: boolean, ctl: AbortController }} Run */

/** The engine calls E4 uses (`sessions.run`, `estimate`, `events`, `cancel`). Typed here, loosely, until the engine's
 *  service.d.ts carries them; every one is optional so a host without them simply never offers Columns.
 *  @typedef {{ run?: (id: string, input: any) => Promise<{ step: string }>,
 *             estimate?: (id: string, input: any) => Promise<{ rows: number, cells: number, turns: number, askFirst: boolean, maxRows: number, capped?: boolean }>,
 *             events?: (id: string, step: string, after: number, signal?: AbortSignal) => AsyncIterable<{ seq: number, data: any }>,
 *             cancel?: (id: string, step: string) => Promise<void> }} FillApi */

/** A summary of a result body, for the cards and the Artifacts list. @param {Result} result @returns {ResultSummary} */
function summaryOf(result) {
  const rows = 'rows' in result && Array.isArray(result.rows) ? result.rows.length : null;
  const columns = 'columns' in result && Array.isArray(result.columns) ? result.columns.map((c) => c.name) : [];
  return { ref: result.ref, kind: result.kind, title: result.title, versions: result.ref.version, rows, columns, updated: result.created };
}

/**
 * Downloads a result in one format: the ticked rows when `only` is given, else every row. Used by the panel's
 * Download menu and by the card's download icon (which exports the whole result as CSV).
 * @param {UiHost} host @param {Document} doc @param {Result} result @param {"csv" | "csv-quotes" | "ris" | "md"} format
 * @param {Set<string> | null} [only]
 */
export async function downloadResult(host, doc, result, format, only = null) {
  const stem = fileStem(result.title, 'results');
  try {
    if (format === 'ris') {
      const rows = toGrid(result, only).rows.flatMap((r) => (r.paper ? [r.paper] : []));
      return await saveText(host, doc, 'ris', `${stem}.ris`, toRis(rows));
    }
    if (format === 'md') return await saveText(host, doc, 'md', `${stem}.md`, toMarkdown(result, { only }));
    return await saveText(host, doc, 'csv', `${stem}.csv`, toCsv(result, { quotes: format === 'csv-quotes', only }));
  } catch (error) {
    host.logError(error);
    host.notice("Couldn't save that file.");
  }
}

export class ArtifactPanel {
  /**
   * @param {{ host: UiHost, doc: Document }} owner
   * @param {{ onClose: () => void, onExpand: () => void, onChanged: (summary: ResultSummary) => void, onNew?: (summary: ResultSummary) => void, onUse?: (ref: { id: string, version: number }) => void, onRoutine?: (result: { id: string, title: string }) => void, onGateAnswered?: (review: string) => void, chat?: any }} hooks
   *   `onNew` is a result the panel made (Keep these N); the host lists it and may open it. `chat` is the ChatView that
   *   can answer questions about a paper set (askPapers); without it the panel has no Chat with papers tab.
   */
  constructor(owner, hooks) {
    this.host = owner.host;
    this.doc = owner.doc;
    this.hooks = hooks;
    /** @type {PanelMode} */ this.mode = 'side';
    this.expanded = false;
    /** @type {{ sessionId: string, id: string, latest: number, version: number, result: Result | null, status: "loading" | "ready" | "missing", gateFiltered?: boolean } | null} */
    this.state = null;
    /** @type {Map<number, Result | null>} versions read so far, by version number */
    this.versions = new Map();
    this.ticked = new Set();
    this.view = {
      search: '', sort: /** @type {import("./artifact-data.js").SortState | null} */ (null),
      filters: /** @type {import("./artifact-data.js").Filters} */ ({}), order: /** @type {string[] | null} */ (null),
    };
    /** @type {RadarDigest | undefined} */ this.digest = undefined;
    /** @type {Run | null} a columns step in flight */ this.run = null;
    /** @type {{ resultId: string, columns: ColumnSpec[], cells: Record<string, Record<string, import("../../../agent/src/domain").Cell>> } | null} what has arrived so far */ this.live = null;
    /** @type {ReturnType<typeof setTimeout> | null} */ this.repaintTimer = null;
    /** @type {{ run: Run, line: HTMLElement, fill: HTMLElement, stop: HTMLElement | null } | null} */ this.runUi = null;
    /** @type {Set<string>} cells (as JSON [row, column]) that arrived since the table was last touched */ this.dirty = new Set();
    /** @type {FillApi | null} the engine's columns calls, once a version has loaded */ this.api = null;
    /** @type {{ id: string, version: number, status: string } | null} how the last step in this panel ended, for the banner's words */ this.endedAs = null;
    /** @type {Map<string, boolean>} spec 007 E8: the researcher's calls on a review's unclear papers, not sent yet (missing = included) */ this.gateKeep = new Map();
    this.gateSent = false;
    this.serial = 0; // bumps on every open/refresh so a slow read can't overwrite a newer one
    this.root = h(this.doc, 'div', 'sb-art');
    this.head = h(this.doc, 'div', 'sb-art-head');
    this.banner = h(this.doc, 'div', 'sb-art-banner');
    this.runbar = h(this.doc, 'div', 'sb-art-runbar');
    this.toolbar = h(this.doc, 'div', 'sb-art-toolbar');
    this.chips = h(this.doc, 'div', 'sb-art-chips');
    this.body = h(this.doc, 'div', 'sb-art-body');
    // spec 007 E5: the set (banner .. body) and its chat. The chat is a tab beside the table; expanded, it is a column.
    this.tabs = h(this.doc, 'div', 'sb-art-tabs');
    this.set = h(this.doc, 'div', 'sb-art-set');
    this.set.append(this.banner, this.runbar, this.toolbar, this.chips, this.body);
    this.chatPane = h(this.doc, 'div', 'sb-art-chatpane');
    this.chatCol = h(this.doc, 'div', 'sb-art-chatcol');
    this.main = h(this.doc, 'div', 'sb-art-main');
    this.main.append(this.head, this.tabs, this.set, this.chatPane);
    this.root.append(this.main, this.chatCol);
    /** @type {"papers" | "chat"} which tab is showing when the chat is a tab */ this.tab = 'papers';
    this.chatAll = false; // "All N" toggled on
    /** @type {PapersChat | null} */
    this.pc = hooks.chat ? new PapersChat(hooks.chat, this.doc, { scope: () => this.chatScope(), setAll: (all) => { this.chatAll = all; }, ref: () => (this.state?.result?.ref ?? null) }) : null;
    this.paint();
  }

  // ------------------------------------------------------------------ opening

  /** Shows a result: the latest version, or `ref.version`. @param {string} sessionId @param {{ id: string, version?: number }} ref @param {number} [latest] */
  async open(sessionId, ref, latest) {
    const same = this.state?.sessionId === sessionId && this.state.id === ref.id;
    if (!same) { this.versions.clear(); this.ticked.clear(); this.chatAll = false; this.tab = 'papers'; this.gateKeep = new Map(); this.gateSent = false; }
    const known = latest ?? (same ? this.state?.latest : undefined) ?? ref.version ?? 1;
    this.state = { sessionId, id: ref.id, latest: known, version: ref.version ?? known, result: null, status: 'loading' };
    this.loadView();
    this.paint();
    await this.load(ref.version);
  }

  /** A newer version was written: follow it when the latest is on screen, otherwise just count it.
   *  @param {ResultSummary} summary */
  async refresh(summary) {
    const s = this.state;
    if (!s || s.id !== summary.ref.id) return;
    const following = s.version === s.latest;
    s.latest = Math.max(s.latest, summary.ref.version);
    this.versions.delete(summary.ref.version);
    if (following) { s.version = s.latest; await this.load(s.latest); } else this.paint();
  }

  /** @param {number} [version] */
  async load(version) {
    const s = this.state;
    if (!s) return;
    const mine = ++this.serial;
    let result = null;
    try {
      const ai = await this.host.ai();
      this.api = /** @type {FillApi} */ (/** @type {any} */ (ai.sessions));
      result = await ai.sessions.read(/** @type {any} */ (s.sessionId), { id: s.id, version });
    } catch (error) {
      this.host.logError(error);
    }
    if (mine !== this.serial || this.state !== s) return;
    s.result = result;
    s.status = result ? 'ready' : 'missing';
    if (result) {
      s.version = result.ref.version;
      s.latest = Math.max(s.latest, result.ref.version);
      this.versions.set(result.ref.version, result);
      // The list opens on the papers that need a decision; "Screening: Unclear" is a chip that can be taken off.
      if (/** @type {any} */ (result).gate && !s.gateFiltered) { s.gateFiltered = true; if (!this.view.filters.screening) this.view.filters = { ...this.view.filters, screening: ['unclear'] }; }
    }
    this.paint();
  }

  /** spec 007 E8: the review's wait on unclear papers, while this result is the latest version and the engine still offers it. */
  gate() {
    const s = this.state;
    return s?.result && s.version === s.latest ? (/** @type {any} */ (s.result).gate ?? null) : null;
  }

  /** The researcher's calls to send: only the papers turned off (an included unclear paper is the default). */
  gateOverrides() {
    return [...this.gateKeep].filter(([, on]) => !on).map(([id]) => ({ id, include: false }));
  }

  /** Sends the calls through the same `reviews.screened` the report card uses, then reads the result again (the toggles are gone once answered).
   *  @param {{ id: string, include: boolean }[]} overrides */
  async sendGate(overrides) {
    const gate = this.gate();
    if (!gate || this.gateSent) return;
    this.gateSent = true;
    this.paintBanner();
    try {
      await (await this.host.ai()).reviews.screened(/** @type {any} */ (gate.review), /** @type {any} */ (overrides));
    } catch (error) {
      this.gateSent = false;
      this.host.logError(error);
      this.host.notice(`Couldn't send that: ${/** @type {any} */ (error)?.message ?? error}`);
      this.paintBanner();
      return;
    }
    this.gateKeep = new Map();
    await this.load();
    this.hooks.onGateAnswered?.(gate.review);
  }

  /** @param {PanelMode} mode @param {boolean} expanded */
  setLayout(mode, expanded) {
    if (this.mode === mode && this.expanded === expanded) return;
    const cardsChanged = (this.mode === 'full') !== (mode === 'full');
    this.mode = mode;
    this.expanded = expanded;
    this.paintHead();
    if (cardsChanged) this.paintBody();
    this.paintChat();
  }

  // ------------------------------------------------------------------ Chat with papers (spec 007 §6, E5)

  /** Only a paper set at its latest version can be asked about (an older one is read-only), and only with rows. */
  chatAvailable() {
    const s = this.state;
    return Boolean(this.pc && s?.result?.kind === 'papers' && s.version === s.latest && s.result.rows.length && !(/** @type {any} */ (s.result).gate));
  }

  /** Whether the chat is a column beside the set (expanded) rather than a tab. */
  chatSplit() {
    return this.mode === 'side' && this.expanded && this.chatAvailable();
  }

  /** The papers a question would be about: ticked, else showing, else all (papers-chat-data.js). */
  chatScope() {
    const result = this.state?.result;
    if (!result) return chatScope({ visible: [], ticked: this.ticked, total: 0 });
    const { rows, total } = visibleRows(result, this.view);
    return chatScope({ visible: rows.map((r) => r.id), ticked: this.ticked, total, all: this.chatAll });
  }

  resetChat() {
    this.pc?.reset();
    this.chatAll = false;
    this.tab = 'papers';
  }

  syncChatRunning() {
    this.pc?.syncRunning();
  }

  /** @param {"papers" | "chat"} tab */
  setTab(tab) {
    this.tab = tab;
    this.paintChat();
    if (tab === 'chat') this.pc?.input.focus();
  }

  /** Places the chat: nowhere (not a paper set), a column (expanded), or a tab (with "Papers | Chat" above the set). */
  paintChat() {
    const pc = this.pc;
    const available = this.chatAvailable();
    const split = available && this.chatSplit();
    const asTab = available && !split;
    if (!available || !pc) this.tab = 'papers';
    const shownTab = asTab ? this.tab : 'papers';
    this.tabs.replaceChildren();
    this.tabs.hidden = !asTab;
    this.chatCol.hidden = !split;
    this.chatPane.hidden = !(asTab && shownTab === 'chat');
    this.set.hidden = asTab && shownTab === 'chat';
    this.root.classList.toggle('is-split', split);
    if (!pc || !available) return;
    pc.setColumn(split);
    (split ? this.chatCol : this.chatPane).append(pc.root);
    const id = this.state?.id;
    if (id && pc.resultId !== id) pc.show(id);
    pc.renderScope();
    if (!asTab) return;
    const labels = /** @type {[typeof shownTab, string][]} */ ([['papers', 'Papers'], ['chat', this.mode === 'full' ? 'Chat' : 'Chat with papers']]);
    for (const [id, label] of labels) {
      const tab = h(this.doc, 'button', `sb-art-tab${shownTab === id ? ' is-on' : ''}`, label);
      tab.setAttribute('type', 'button');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(shownTab === id));
      tab.addEventListener('click', () => this.setTab(id));
      this.tabs.append(tab);
    }
  }

  // ------------------------------------------------------------------ view state (kept per session and result)

  get viewKey() {
    return `artifactView:${this.state?.sessionId}:${this.state?.id}`;
  }

  loadView() {
    const saved = /** @type {any} */ (this.host.prefs.get(this.viewKey));
    this.view = {
      search: typeof saved?.search === 'string' ? saved.search : '', sort: saved?.sort?.key ? saved.sort : null,
      filters: cleanFilters(saved?.filters), order: Array.isArray(saved?.order) ? saved.order.filter((/** @type {any} */ id) => typeof id === 'string') : null,
    };
  }

  saveView() {
    this.host.prefs.set(this.viewKey, { search: this.view.search, sort: this.view.sort, filters: this.view.filters, order: this.view.order });
  }

  /** The version on screen with a running fill laid over it (new columns, the cells that have arrived).
   *  @returns {Result | null} */
  shown() {
    const s = this.state;
    if (!s?.result) return null;
    return this.live && this.live.resultId === s.id && s.version === s.latest ? withLive(s.result, this.live) : s.result;
  }

  /** The columns as the table shows them, in the user's order. */
  columnsInView() {
    const result = this.shown();
    return result ? visibleRows(result, { order: this.view.order }).grid.columns : [];
  }

  // ------------------------------------------------------------------ painting

  paint() {
    this.paintHead();
    this.paintBanner();
    this.paintRunbar();
    this.paintToolbar();
    this.paintChips();
    this.paintBody();
    this.paintChat();
  }

  /** @param {string} name @param {string} label @param {() => void} run @param {string} [cls] */
  iconButton(name, label, run, cls = '') {
    const btn = h(this.doc, 'button', `sb-art-iconbtn ${cls}`.trim());
    btn.setAttribute('type', 'button');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.append(icon(this.doc, name, 'sb-ai-icon'));
    btn.addEventListener('click', (event) => { event.stopPropagation(); run(); });
    return btn;
  }

  /** @param {HTMLElement} anchor @param {(pop: HTMLElement, close: () => void) => void} fill @param {string} [className] */
  popover(anchor, fill, className) {
    openPopover(this.doc, this.root, anchor, fill, { className });
  }

  paintHead() {
    const s = this.state;
    const kids = /** @type {HTMLElement[]} */ ([]);
    if (this.mode !== 'side') {
      const back = h(this.doc, 'button', 'sb-art-back');
      back.setAttribute('type', 'button');
      back.append(icon(this.doc, 'back', 'sb-ai-icon'), h(this.doc, 'span', '', 'Chat'));
      back.addEventListener('click', () => this.hooks.onClose());
      kids.push(back);
    }
    const result = s?.result;
    const title = h(this.doc, 'span', 'sb-art-head-title');
    title.append(icon(this.doc, KIND_ICON[result?.kind ?? 'table'] ?? 'table', 'sb-ai-icon'), h(this.doc, 'span', 'sb-art-head-text', result?.title ?? (s?.status === 'missing' ? 'Not available' : 'Loading…')));
    title.title = result?.title ?? '';
    kids.push(title);
    if (result && s) {
      const version = h(this.doc, 'button', `sb-art-version${s.version !== s.latest ? ' is-old' : ''}`);
      version.setAttribute('type', 'button');
      version.title = 'Versions of this result';
      version.append(h(this.doc, 'span', '', `V${s.version}`), icon(this.doc, 'chevron', 'sb-ai-icon'));
      version.addEventListener('click', (event) => { event.stopPropagation(); this.openVersions(version); });
      kids.push(version);
      if ((result.kind === 'papers' || result.kind === 'table') && this.canDownload()) {
        const dl = this.iconButton('download', 'Download', () => this.openDownloads(dl));
        kids.push(dl);
      }
    }
    if (result && s && (this.hooks.onUse || sourcesOf(result).length || this.canRoutine(result)) && !this.gate()) {
      const more = this.iconButton('more', 'More', () => this.openMore(more));
      kids.push(more);
    }
    if (this.mode === 'side') {
      kids.push(this.iconButton('expand', this.expanded ? 'Shrink back beside the chat' : 'Make this bigger', () => this.hooks.onExpand(), this.expanded ? 'is-on' : ''));
      kids.push(this.iconButton('close', 'Close', () => this.hooks.onClose()));
    }
    this.head.replaceChildren(...kids);
  }

  /** The old version's banner: what you're looking at and how to get back or make it current. */
  paintBanner() {
    const s = this.state;
    this.banner.replaceChildren();
    const gate = this.gate();
    if (gate && s) { this.paintGateBanner(gate); return; }
    this.banner.classList.remove('is-gate');
    this.banner.hidden = !(s?.result && s.version !== s.latest);
    if (this.banner.hidden || !s) return;
    const text = h(this.doc, 'span', 'sb-art-banner-text', `You're looking at V${s.version}, an older version. It can't be changed.`);
    const restore = /** @type {HTMLButtonElement} */ (h(this.doc, 'button', 'sb-art-banner-btn is-primary', `Restore as V${s.latest + 1}`));
    restore.setAttribute('type', 'button');
    restore.addEventListener('click', () => this.restore(restore));
    const latest = h(this.doc, 'button', 'sb-art-banner-btn', 'Back to the latest');
    latest.setAttribute('type', 'button');
    latest.addEventListener('click', () => this.showVersion(s.latest));
    this.banner.append(text, restore, latest);
  }

  /** @param {{ review: string, unclear: { id: string, because: string[] }[] }} gate */
  paintGateBanner(gate) {
    this.banner.hidden = false;
    this.banner.classList.add('is-gate');
    const total = this.state?.result?.kind === 'papers' ? this.state.result.rows.length : gate.unclear.length;
    const out = this.gateOverrides().length;
    const text = h(this.doc, 'span', 'sb-art-banner-text', `${gate.unclear.length} of ${total} papers are unclear. The abstracts don't settle the strict criteria for them. Turn off the ones to leave out, then continue.`);
    const all = /** @type {HTMLButtonElement} */ (h(this.doc, 'button', 'sb-art-banner-btn sb-art-gate-all', 'Include them all'));
    all.setAttribute('type', 'button');
    all.disabled = this.gateSent;
    all.addEventListener('click', () => this.sendGate([]));
    const go = /** @type {HTMLButtonElement} */ (h(this.doc, 'button', 'sb-art-banner-btn is-primary sb-art-gate-go', out ? `Continue, leaving out ${out}` : 'Continue with all of them'));
    go.setAttribute('type', 'button');
    go.disabled = this.gateSent;
    go.addEventListener('click', () => this.sendGate(this.gateOverrides()));
    this.banner.replaceChildren(text, all, go);
  }

  /** Sort, Filters and Columns need a table of rows; Columns only on the latest version, Filters only when some data allows one. */
  paintToolbar() {
    const s = this.state;
    const result = this.shown();
    const grid = result ? toGrid(result) : null;
    this.toolbar.hidden = !grid || !grid.rows.length && !this.view.search && !filtersActive(this.view.filters);
    this.toolbar.replaceChildren();
    if (this.toolbar.hidden || !grid || !result) return;
    const search = h(this.doc, 'label', 'sb-art-search');
    const input = /** @type {HTMLInputElement} */ (h(this.doc, 'input', 'sb-art-search-input'));
    input.type = 'text';
    input.placeholder = 'Search…';
    input.value = this.view.search;
    input.setAttribute('aria-label', 'Search these rows');
    input.addEventListener('input', () => { this.chatAll = false; this.view.search = input.value; this.saveView(); this.paintBody(); this.paintTicks(); this.paintChips(); });
    search.append(icon(this.doc, 'find', 'sb-ai-icon'), input);
    const sort = h(this.doc, 'button', 'sb-art-sort');
    sort.setAttribute('type', 'button');
    sort.append(icon(this.doc, 'sort', 'sb-ai-icon'), h(this.doc, 'span', 'sb-art-sort-label', sortLabel(grid, this.view.sort)));
    sort.addEventListener('click', (event) => { event.stopPropagation(); this.openSort(sort, grid); });
    this.toolbar.append(search, sort);
    const options = filterOptions(result);
    const offers = options.hasPdf || options.years || options.studyTypes.length || options.abstract || options.library || options.screening || options.columns.length;
    const active = describeFilters(this.view.filters, result).length;
    if (offers || active) {
      const filters = h(this.doc, 'button', `sb-art-tool sb-art-filters${active ? ' is-on' : ''}`);
      filters.setAttribute('type', 'button');
      filters.append(icon(this.doc, 'filter', 'sb-ai-icon'), h(this.doc, 'span', 'sb-art-tool-label', 'Filters'));
      if (active) filters.append(h(this.doc, 'span', 'sb-art-tool-count', String(active)));
      filters.addEventListener('click', (event) => { event.stopPropagation(); this.openFilters(filters); });
      this.toolbar.append(filters);
    }
    if (s && s.version === s.latest && this.canFill()) {
      const columns = h(this.doc, 'button', 'sb-art-tool sb-art-columns');
      columns.setAttribute('type', 'button');
      columns.append(icon(this.doc, 'columns', 'sb-ai-icon'), h(this.doc, 'span', 'sb-art-tool-label', 'Columns'));
      columns.addEventListener('click', (event) => { event.stopPropagation(); this.openColumns(columns); });
      this.toolbar.append(columns);
    }
    this.ticks = h(this.doc, 'span', 'sb-art-ticks');
    this.toolbar.append(this.ticks);
    this.paintTicks();
  }

  /** "3 ticked · Clear", and "Showing 4 of 9" while a search or filter is narrowing the rows. */
  paintTicks() {
    const result = this.shown();
    if (!this.ticks || !result) return;
    const { rows, total } = visibleRows(result, this.view);
    this.ticks.replaceChildren();
    if (rows.length !== total) this.ticks.append(h(this.doc, 'span', 'sb-art-count', `Showing ${rows.length} of ${total}`));
    if (this.ticked.size) {
      const clear = h(this.doc, 'button', 'sb-art-clear', 'Clear');
      clear.setAttribute('type', 'button');
      clear.addEventListener('click', () => { this.ticked.clear(); this.paintBody(); this.paintTicks(); this.paintChips(); });
      this.ticks.append(h(this.doc, 'span', 'sb-art-count', `${this.ticked.size} ticked`), clear);
    }
  }

  /** The active filters as removable chips, and "Keep these N" when the view is narrower than the result. */
  paintChips() {
    this.pc?.renderScope();
    const result = this.shown();
    this.chips.replaceChildren();
    const found = result ? describeFilters(this.view.filters, result) : [];
    const kept = result ? this.keepIds(result) : [];
    const total = result ? visibleRows(result, {}).total : 0;
    const narrowed = result ? kept.length < total : false;
    this.chips.hidden = !result || (!found.length && !narrowed) || Boolean(this.run) && !found.length;
    if (this.chips.hidden || !result) return;
    for (const filter of found) {
      const chip = h(this.doc, 'span', 'sb-art-fchip');
      chip.append(h(this.doc, 'span', 'sb-art-fchip-text', filter.label));
      const x = h(this.doc, 'button', 'sb-art-fchip-x');
      x.setAttribute('type', 'button');
      x.setAttribute('aria-label', `Remove the filter ${filter.label}`);
      x.append(icon(this.doc, 'close', 'sb-ai-icon'));
      x.addEventListener('click', () => this.setFilters(removeFilter(this.view.filters, filter.key)));
      chip.append(x);
      this.chips.append(chip);
    }
    if (found.length > 1) {
      const clear = h(this.doc, 'button', 'sb-art-clear', 'Clear filters');
      clear.setAttribute('type', 'button');
      clear.addEventListener('click', () => this.setFilters({}));
      this.chips.append(clear);
    }
    if (narrowed && kept.length && !this.run && !this.gate() && this.state?.version === this.state?.latest) {
      const keep = /** @type {HTMLButtonElement} */ (h(this.doc, 'button', 'sb-art-keep', `Keep these ${kept.length}`));
      keep.setAttribute('type', 'button');
      keep.title = 'Make a new paper set from just these rows. The original stays as it is.';
      keep.addEventListener('click', () => this.keepThese(keep));
      this.chips.append(keep);
    }
  }

  /** The rows "Keep these" would keep: the ticked ones that are still visible, else everything visible.
   *  @param {Result} result @returns {string[]} */
  keepIds(result) {
    const { rows } = visibleRows(result, this.view);
    const ticked = rows.filter((r) => this.ticked.has(r.id));
    return (ticked.length ? ticked : rows).map((r) => r.id);
  }

  /** @param {import("./artifact-data.js").Filters} filters */
  setFilters(filters) {
    this.chatAll = false;
    this.view.filters = filters;
    this.saveView();
    this.paintToolbar();
    this.paintChips();
    this.paintBody();
  }

  paintBody() {
    const s = this.state;
    this.body.replaceChildren();
    if (!s || s.status === 'loading') { this.body.append(this.loadingRows()); return; }
    const result = this.shown();
    if (!result) { this.body.append(h(this.doc, 'div', 'sb-art-empty', "This result isn't available any more. The rest of the chat is unaffected.")); return; }
    if (result.kind !== 'papers' && result.kind !== 'table') {
      this.body.append(h(this.doc, 'div', 'sb-art-empty', `This is ${KIND_NAME[result.kind] === 'Report' ? 'a report' : 'an answer'}. Open it from your history to read it.`));
      return;
    }
    const { grid, rows } = visibleRows(result, this.view);
    if (!grid.rows.length) { this.body.append(h(this.doc, 'div', 'sb-art-empty', 'No rows yet.')); return; }
    if (!rows.length) {
      const why = filtersActive(this.view.filters) ? 'No rows match these filters.' : `No rows match “${this.view.search}”.`;
      const empty = h(this.doc, 'div', 'sb-art-empty', why);
      if (filtersActive(this.view.filters)) {
        const clear = h(this.doc, 'button', 'sb-art-clear', 'Clear filters');
        clear.setAttribute('type', 'button');
        clear.addEventListener('click', () => this.setFilters({}));
        empty.append(' ', clear);
      }
      this.body.append(empty);
      return;
    }
    const ctx = this.tableContext();
    const digest = ctx.radar;
    if (digest) this.body.append(digest.summaryNode());
    this.body.append(this.mode === 'full' ? renderCards(ctx, grid, rows) : renderTable(ctx, grid, rows));
  }

  /** spec 012 R4: a reading radar's digest keeps what was clicked while the panel is open, so it outlives a repaint. */
  radarDigest() {
    const found = digestOf(this.shown());
    if (!found) return undefined;
    if (!this.digest || this.digest.routine !== found.routine) { this.digest?.hideToast(); this.digest = new RadarDigest(this.host, this.doc, this.root, found); }
    this.digest.summary = found.summary;
    return this.digest;
  }

  /** What the table renderer needs from this panel. */
  tableContext() {
    const s = this.state;
    const retry = s && this.canFill() && s.version === s.latest && !this.run ? (/** @type {string} */ row, /** @type {string} */ column) => this.retryCell(row, column) : undefined;
    const gate = this.gate();
    const unclear = gate ? new Map(gate.unclear.map((/** @type {any} */ u) => [u.id, u.because])) : null;
    const radar = this.radarDigest();
    return { doc: this.doc, host: this.host, ticked: this.ticked, added: radar ? undefined : addedRowSet(this.shown()), ...(radar ? { radar } : {}), onRetry: retry, ...(unclear ? { gate: { unclear, keep: this.gateKeep, onChange: () => this.paintBanner() } } : {}), onTick: () => { this.chatAll = false; this.paintTicks(); this.paintChips(); }, popover: (/** @type {HTMLElement} */ a, /** @type {any} */ f, /** @type {string | undefined} */ c) => this.popover(a, f, c) };
  }

  /** Grey bars in the shape of a table while the result is being read. */
  loadingRows() {
    const box = h(this.doc, 'div', 'sb-art-loading');
    for (let i = 0; i < 4; i++) {
      const row = h(this.doc, 'div', 'sb-art-skel');
      for (const width of ['100%', '82%', '54%']) { const bar = h(this.doc, 'span', 'sb-art-skel-bar'); bar.style.width = width; row.append(bar); }
      box.append(row);
    }
    return box;
  }

  // ------------------------------------------------------------------ columns and filters (spec 007 E4)

  /** Whether this host's engine can fill columns (it has run, estimate and events). Known once a version has loaded. */
  canFill() {
    const api = this.api;
    const kind = this.state?.result?.kind;
    return Boolean(api?.run && api.estimate && api.events) && (kind === 'papers' || kind === 'table') && !this.gate();
  }

  /** A popover beside the toolbar, or a full sheet below 560 px. @param {HTMLElement} anchor @param {string} title @param {(box: HTMLElement, close: () => void) => void} fill @param {string} className */
  overlay(anchor, title, fill, className) {
    if (this.mode === 'full') openSheet(this.doc, this.root, title, fill);
    else openPopover(this.doc, this.root, anchor, fill, { className });
  }

  /** @param {HTMLElement} anchor */
  openFilters(anchor) {
    const result = this.shown();
    if (!result) return;
    this.overlay(anchor, 'Filters', (box, close) => fillFilters(this.doc, box, {
      options: filterOptions(result), filters: this.view.filters, apply: (filters) => this.setFilters(filters), close,
    }), 'sb-flt-pop');
  }

  /** @param {HTMLElement} anchor */
  openColumns(anchor) {
    const result = this.shown();
    if (!result) return;
    this.overlay(anchor, 'Columns', (box, close) => fillColumns(this.doc, box, {
      columns: this.columnsInView(), busy: Boolean(this.run), noun: result.kind === 'papers' ? 'paper' : 'row',
      prepare: (specs) => this.prepareFill(specs),
      run: (specs, first) => this.startFill(specs, first),
      onRemove: (spec) => { close(); this.removeColumn(spec); },
      onReorder: (ids) => { this.view.order = ids; this.saveView(); this.paintBody(); },
      close,
    }), 'sb-col-pop');
  }

  /** Which rows a fill covers: the ticked rows that are visible, else every visible row (spec 007 §5.1). "all" when
   *  that is every row of the version. @returns {{ rows: string[] | "all", ids: string[] }} */
  fillScope() {
    const result = this.state?.result;
    if (!result) return { rows: [], ids: [] };
    const { rows, total } = visibleRows(result, this.view);
    const ticked = rows.filter((r) => this.ticked.has(r.id));
    const ids = (ticked.length ? ticked : rows).map((r) => r.id);
    return { rows: !ticked.length && ids.length === total ? 'all' : ids, ids };
  }

  /** Asks the engine what filling these columns would cost. @param {ColumnSpec[]} specs */
  async prepareFill(specs) {
    const s = this.state;
    const api = this.api;
    if (!s?.result || !api?.estimate) throw new Error('no estimate');
    const { rows } = this.fillScope();
    try {
      const est = await api.estimate(s.sessionId, { kind: 'columns', on: s.result.ref, add: specs, rows, text: 'abstract' });
      return { line: confirmLine({ columns: specs.length, rows: est.rows, turns: est.turns, noun: s.result.kind === 'papers' ? 'paper' : 'row' }), askFirst: Boolean(est.askFirst), maxRows: est.maxRows || 50 };
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't work out how long that would take.");
      throw error;
    }
  }

  /** @param {ColumnSpec[]} specs @param {number | null} first only the first N of the rows in scope */
  async startFill(specs, first) {
    const scope = this.fillScope();
    await this.fill(specs, first ? scope.ids.slice(0, first) : scope.rows);
  }

  /** Starts a columns step and follows it. `rows: "pending"` re-runs the pending and failed cells (Fill the rest);
   *  `add: []` with row ids is a Retry; `rows: "gaps"` reads the "not reported" cells again, from `text: "best"`.
   *  @param {ColumnSpec[]} specs @param {string[] | "all" | "pending" | "gaps"} rows @param {"abstract" | "best"} [text] */
  async fill(specs, rows, text = 'abstract') {
    const s = this.state;
    const api = this.api;
    if (!s?.result || !api?.run || this.run) return;
    const result = s.result;
    let step;
    try {
      ({ step } = await api.run(s.sessionId, { kind: 'columns', on: result.ref, add: specs, rows, text }));
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't start filling the columns.");
      throw error;
    }
    const cells = rows === 'pending' ? restCells(result) : rows === 'gaps' ? gapCells(result) : pendingCells(result, specs, rows);
    const columns = specs.length || new Set(Object.values(cells).flatMap((c) => Object.keys(c))).size;
    this.live = { resultId: s.id, columns: specs, cells };
    const run = /** @type {Run} */ ({ step, sessionId: s.sessionId, resultId: s.id, columns, total: 0, done: 0, stopping: false, ended: false, ctl: new (/** @type {Window & typeof globalThis} */ (this.doc.defaultView)).AbortController() }); // the window's: Zotero's bundle scope has no AbortController
    this.run = run;
    this.paint();
    this.watch(run, api);
  }

  /** Reads the step's events until it ends: cells land in the overlay, progress moves the line. @param {Run} run @param {FillApi} api */
  async watch(run, api) {
    try {
      for await (const { data } of /** @type {NonNullable<FillApi["events"]>} */ (api.events)(run.sessionId, run.step, 0, run.ctl.signal)) {
        if (run.ended) return;
        if (data.type === 'cell') {
          if (this.live && (typeof data.result === 'string' ? data.result : data.result?.id) === this.live.resultId) { // the engine sends the ResultId; a ref works too
            (this.live.cells[data.row] ??= {})[data.column] = data.cell;
            this.repaintSoon(data.row, data.column);
          }
        } else if (data.type === 'progress') {
          run.done = data.done; run.total = data.total;
          if (this.run === run) this.paintRunbar();
        } else if (data.type === 'end') { await this.finish(run, data); return; }
      }
      if (!run.ended) await this.finish(run, { status: 'failed', writes: [] });
    } catch (error) {
      if (run.ctl.signal.aborted) return;
      this.host.logError(error);
      if (!run.ended) await this.finish(run, { status: 'failed', writes: [] });
    }
  }

  /** Arriving cells are swapped into the table in batches (at most one every 120 ms), one cell at a time: the rows,
   *  buttons and scroll position around them are never rebuilt, so a click or a tick is not lost while a fill runs.
   *  @param {string} row @param {string} column */
  repaintSoon(row, column) {
    this.dirty.add(JSON.stringify([row, column]));
    if (this.repaintTimer) return;
    this.repaintTimer = setTimeout(() => { this.repaintTimer = null; this.flushCells(); }, 120);
  }

  flushCells() {
    const live = this.live;
    const s = this.state;
    const dirty = [...this.dirty];
    this.dirty.clear();
    if (!live || !s?.result || live.resultId !== s.id || !dirty.length) return;
    const ctx = this.tableContext();
    /** @type {Map<string, Element[]>} */
    const spots = new Map();
    for (const el of Array.from(this.body.querySelectorAll('[data-cell]'))) {
      const key = /** @type {string} */ (el.getAttribute('data-cell'));
      spots.set(key, [...(spots.get(key) ?? []), el]);
    }
    for (const key of dirty) {
      const [row, column] = JSON.parse(key);
      const cell = live.cells[row]?.[column];
      for (const el of spots.get(key) ?? []) el.replaceWith(renderCell(ctx, cell, row, column));
    }
  }

  /** The step ended: read the version it wrote and swap it in for the overlay (V+1), or say it failed.
   *  @param {Run} run @param {{ status: string, writes?: { id: string, version: number }[] }} end */
  async finish(run, end) {
    run.ended = true;
    if (end.status === 'failed') this.host.notice("Couldn't finish filling the columns.");
    const ref = end.writes?.[0];
    let result = null;
    if (ref) {
      try { result = await (await this.host.ai()).sessions.read(/** @type {any} */ (run.sessionId), { id: ref.id, version: ref.version }); } catch (error) { this.host.logError(error); }
    }
    if (this.run === run) this.run = null;
    if (this.repaintTimer) { clearTimeout(this.repaintTimer); this.repaintTimer = null; }
    this.dirty.clear();
    const s = this.state;
    if (result && s && s.sessionId === run.sessionId && s.id === result.ref.id) {
      const following = s.version === s.latest;
      s.latest = Math.max(s.latest, result.ref.version);
      this.versions.set(result.ref.version, result);
      if (following) { s.version = result.ref.version; s.result = result; s.status = 'ready'; }
    }
    this.live = null;
    this.endedAs = result ? { id: result.ref.id, version: result.ref.version, status: end.status } : null;
    this.paint();
    if (result) this.hooks.onChanged(summaryOf(result));
  }

  /** The progress line while a step runs, or the "Stopped" banner when the latest version has pending cells. */
  paintRunbar() {
    const s = this.state;
    const run = this.run && this.run.resultId === s?.id ? this.run : null;
    if (run) {
      const n = run.columns;
      const text = run.stopping ? 'Stopping…' : `Filling ${n === 1 ? '1 column' : `${n} columns`}${run.total ? ` · ${run.done} of ${run.total}` : ''}`;
      const width = `${run.total ? Math.round((run.done / run.total) * 100) : 0}%`;
      // The bar is updated in place while the step runs: a Stop button rebuilt on every progress event could not be clicked.
      const kept = this.runUi;
      if (kept && kept.run === run && this.runbar.contains(kept.line)) {
        kept.line.textContent = text;
        kept.fill.style.width = width;
        if (run.stopping) kept.stop?.remove();
        this.runbar.hidden = false;
        return;
      }
      this.runbar.replaceChildren();
      this.runbar.classList.remove('is-stopped');
      const line = h(this.doc, 'span', 'sb-art-runtext', text);
      const track = h(this.doc, 'span', 'sb-art-runtrack');
      const fill = h(this.doc, 'span', 'sb-art-runfill');
      fill.style.width = width;
      track.append(fill);
      this.runbar.append(line);
      /** @type {HTMLElement | null} */ let stop = null;
      if (!run.stopping) {
        stop = h(this.doc, 'button', 'sb-art-banner-btn sb-art-stop', 'Stop');
        stop.setAttribute('type', 'button');
        stop.addEventListener('click', () => this.stop(run));
        this.runbar.append(stop);
      }
      this.runbar.append(track);
      this.runUi = { run, line, fill, stop };
      this.runbar.hidden = false;
      return;
    }
    this.runUi = null;
    this.runbar.replaceChildren();
    this.runbar.classList.remove('is-stopped');
    const p = s?.result && s.version === s.latest && !this.run && this.canFill() ? cellProgress(s.result) : null;
    this.runbar.hidden = !p || p.total === 0 || (p.pending === 0 && p.absent === 0);
    if (this.runbar.hidden || !p) return;
    this.runbar.classList.add('is-stopped');
    const fillRest = /** @type {HTMLButtonElement} */ (h(this.doc, 'button', 'sb-art-banner-btn is-primary sb-art-fillrest', 'Fill the rest'));
    fillRest.setAttribute('type', 'button');
    fillRest.addEventListener('click', () => { fillRest.disabled = true; Promise.resolve(this.fillRest()).catch(() => { fillRest.disabled = false; }); });
    const e = this.endedAs;
    const stopped = e && s && e.id === s.id && e.version === s.version && (e.status === 'stopped' || e.status === 'cancelled');
    this.runbar.append(h(this.doc, 'span', 'sb-art-runtext', `${stopped ? 'Stopped - ' : ''}${p.done} of ${p.total} done`), fillRest);
  }

  /** @param {Run} run */
  async stop(run) {
    run.stopping = true;
    this.paintRunbar();
    try { await /** @type {NonNullable<FillApi["cancel"]>} */ (this.api?.cancel)?.(run.sessionId, run.step); } catch (error) { this.host.logError(error); }
  }

  /** A failed cell's small Retry: its column is added again for that one row (the engine replaces a column that
   *  already exists and fills the rows asked for). @param {string} rowId @param {string} columnId */
  async retryCell(rowId, columnId) {
    const spec = this.state?.result && 'columns' in this.state.result ? this.state.result.columns.find((c) => c.id === columnId) : null;
    if (!spec) return;
    try { await this.fill([spec], [rowId]); } catch { /* fill() has told the user */ }
  }

  /** "Fill the rest": the stopped step's pending and failed cells, or, when a step was limited to some rows, the rows
   *  and columns it never touched (the engine's `rows: "pending"` does not take those). */
  async fillRest() {
    const result = this.state?.result;
    if (!result) return;
    const p = cellProgress(result);
    if (p.pending || p.failed) return this.fill([], 'pending');
    const { rows, columns } = untouched(result);
    if (rows.length && columns.length) return this.fill(columns, rows);
  }

  /** "Keep these N": a new paper set from the rows on screen (ticked ones if any), written as a `narrow` step and opened.
   *  @param {HTMLButtonElement} button */
  async keepThese(button) {
    const s = this.state;
    const result = s?.result;
    if (!s || !result) return;
    const ids = this.keepIds(result);
    const total = visibleRows(result, {}).total;
    const why = keepWhy({ kept: ids.length, total, parts: viewParts({ filters: this.view.filters, result, search: this.view.search, ticked: this.ticked.size }) });
    const draft = narrowDraft(result, ids, why);
    if (!draft) return;
    button.disabled = true;
    try {
      const ai = await this.host.ai();
      const summary = await ai.sessions.put(/** @type {any} */ (s.sessionId), { kind: 'narrow', on: result.ref, keep: /** @type {any} */ (ids), why }, draft);
      this.hooks.onNew?.(summary);
    } catch (error) {
      button.disabled = false;
      this.host.logError(error);
      this.host.notice("Couldn't keep those rows.");
    }
  }

  /** Removing a column is a new version without it; earlier versions keep it. @param {ColumnSpec} spec */
  async removeColumn(spec) {
    const s = this.state;
    const result = s?.result;
    if (!s || !result || s.version !== s.latest || this.run) return;
    const draft = withoutColumn(result, spec.id);
    if (!draft) return;
    if (!(await this.host.confirm(`Remove the column “${spec.name}”? Earlier versions keep it.`, { title: 'Remove column' }))) return;
    try {
      const ai = await this.host.ai();
      const summary = await ai.sessions.put(/** @type {any} */ (s.sessionId), { kind: 'columns', on: result.ref, add: [], rows: [], text: 'abstract' }, draft);
      this.view.order = this.view.order?.filter((id) => id !== spec.id) ?? null;
      this.saveView();
      this.versions.delete(summary.ref.version);
      s.latest = summary.ref.version;
      await this.load(summary.ref.version);
      this.hooks.onChanged(summary);
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't remove that column.");
    }
  }

  // ------------------------------------------------------------------ menus

  /** @param {HTMLElement} anchor @param {import("../export/common.js").Grid} grid */
  openSort(anchor, grid) {
    this.popover(anchor, (pop, close) => {
      const current = this.view.sort;
      pop.append(menuItem(this.doc, { label: 'None', selected: !current, onClick: () => this.setSort(null) }, close));
      for (const option of sortOptions(grid)) {
        const on = current?.key === option.key;
        pop.append(menuItem(this.doc, {
          label: option.label, selected: on, hint: on ? (current?.dir === 'desc' ? 'High to low; press again to reverse' : 'Low to high; press again to reverse') : undefined,
          onClick: () => this.setSort({ key: option.key, dir: on ? (current?.dir === 'asc' ? 'desc' : 'asc') : option.key === 'citations' || option.key === 'year' ? 'desc' : 'asc' }),
        }, close));
      }
    });
  }

  /** @param {import("./artifact-data.js").SortState | null} sort */
  setSort(sort) {
    this.view.sort = sort;
    this.saveView();
    this.paintToolbar();
    this.paintBody();
  }

  /** The version menu: newest first, each with its change line and date. @param {HTMLElement} anchor */
  openVersions(anchor) {
    const s = this.state;
    if (!s) return;
    this.popover(anchor, (pop, close) => {
      const list = h(this.doc, 'div', 'sb-art-versions');
      pop.append(list);
      const fill = () => {
        list.replaceChildren();
        for (let v = s.latest; v >= 1; v--) {
          const known = this.versions.get(v);
          const hint = known ? [known.change, shortDate(known.created)].filter(Boolean).join(' · ') : 'Loading…';
          list.append(menuItem(this.doc, { label: `V${v}${v === s.latest ? ' (latest)' : ''}`, hint, selected: v === s.version, onClick: () => this.showVersion(v) }, close));
        }
      };
      fill();
      this.readVersions().then(() => { if (list.isConnected) fill(); });
    }, 'sb-art-versionmenu');
  }

  async readVersions() {
    const s = this.state;
    if (!s) return;
    const missing = [];
    for (let v = 1; v <= s.latest; v++) if (!this.versions.has(v)) missing.push(v);
    if (!missing.length) return;
    const ai = await this.host.ai();
    await Promise.all(missing.map(async (v) => {
      try { this.versions.set(v, await ai.sessions.read(/** @type {any} */ (s.sessionId), { id: s.id, version: v })); } catch { this.versions.set(v, null); }
    }));
  }

  /** @param {number} version */
  async showVersion(version) {
    const s = this.state;
    if (!s) return;
    const known = this.versions.get(version);
    if (known) { s.result = known; s.version = version; s.status = 'ready'; this.paint(); return; }
    await this.load(version);
  }

  /** "Restore as V(n+1)": the old version is written again as the newest. @param {HTMLButtonElement} button */
  async restore(button) {
    const s = this.state;
    if (!s) return;
    button.disabled = true;
    try {
      const ai = await this.host.ai();
      const summary = await ai.sessions.restore(/** @type {any} */ (s.sessionId), { id: /** @type {any} */ (s.id), version: s.version });
      this.versions.delete(summary.ref.version);
      s.latest = summary.ref.version;
      await this.load(summary.ref.version);
      this.hooks.onChanged(summary);
    } catch (error) {
      button.disabled = false;
      this.host.logError(error);
      this.host.notice("Couldn't restore that version.");
    }
  }

  /** Spec 011 U4: only a papers result can be kept up to date by a routine. @param {Result} result */
  canRoutine(result) {
    return Boolean(this.hooks.onRoutine) && result.kind === 'papers';
  }

  /** The artifact's own menu (spec 007 §7): "Use for next step" makes this result the one the next step works on. */
  /** @param {HTMLElement} anchor */
  openMore(anchor) {
    const s = this.state;
    const result = s?.result;
    const sources = result ? sourcesOf(result) : [];
    if (!s || !(this.hooks.onUse || sources.length || (result && this.canRoutine(result)))) return;
    this.popover(anchor, (pop, close) => {
      if (this.hooks.onUse) {
        pop.append(menuItem(this.doc, { label: 'Use for next step', hint: 'The next step you add works on this result', icon: 'open',
          onClick: () => this.hooks.onUse?.({ id: s.id, version: s.version }) }, close));
      }
      if (sources.length) {
        pop.append(menuItem(this.doc, { label: `Sources (${sources.length})`, hint: 'Every paper this rests on, with its quotes', icon: 'paper',
          onClick: () => this.showSources(anchor, sources) }, close));
      }
      if (result && this.canRoutine(result)) {
        pop.append(menuItem(this.doc, { label: 'Create routine for this', hint: 'Look for new papers on a schedule and add them here', icon: 'clock',
          onClick: () => this.hooks.onRoutine?.({ id: s.id, title: /** @type {any} */ (result).title ?? '' }) }, close));
      }
    }, 'sb-art-moremenu');
  }

  /** The Sources view: each paper once, with the quotes behind its cells under it. @param {HTMLElement} anchor @param {ReturnType<typeof sourcesOf>} sources */
  showSources(anchor, sources) {
    this.overlay(anchor, `Sources (${sources.length})`, (box) => {
      const list = h(this.doc, 'div', 'sb-art-sources');
      for (const source of sources) {
        const item = h(this.doc, 'section', 'sb-art-source');
        const title = h(this.doc, 'button', 'sb-art-source-title', source.year ? `${source.title} (${source.year})` : source.title);
        title.setAttribute('type', 'button');
        title.addEventListener('click', () => {
          if (source.ref && source.ref.kind === 'paper') this.host.openRef(source.ref, { newTab: false });
          else if (source.doi) this.host.openLink(`https://doi.org/${source.doi}`);
        });
        item.append(title);
        const out = source.doi && !(source.ref && source.ref.kind === 'paper') ? outsideButton(this.doc, this.host, `https://doi.org/${source.doi}`) : null;
        if (out) title.after(out);
        for (const quote of source.quotes) {
          const row = h(this.doc, 'p', `sb-art-source-quote${quote.verified ? '' : ' is-unverified'}`);
          row.append(h(this.doc, 'span', 'sb-art-source-column', `${quote.column}: `), `“${quote.text}”`);
          if (quote.from === 'full_text') row.append(' ', h(this.doc, 'span', 'sb-art-source-from', 'full text'));
          item.append(row);
        }
        list.append(item);
      }
      box.append(list);
    }, 'sb-art-sourcespop');
  }

  /** Starts one of "+ Add step"'s steps on the result showing: Chat opens its tab, Add columns opens the Columns
   *  popover, Keep filtered rows keeps the narrowed view or opens Filters first. @param {"columns" | "keep" | "chat"} step */
  startStep(step) {
    if (step === 'chat') { this.setTab('chat'); return; }
    if (step === 'columns') {
      const button = /** @type {HTMLElement | null} */ (this.toolbar.querySelector('.sb-art-columns'));
      if (button) this.openColumns(button);
      return;
    }
    const keep = /** @type {HTMLElement | null} */ (this.chips.querySelector('.sb-art-keep'));
    if (keep) { keep.click(); return; }
    const filters = /** @type {HTMLElement | null} */ (this.toolbar.querySelector('.sb-art-filters'));
    if (filters) this.openFilters(filters);
  }

  canDownload() {
    return canSave(this.host, this.doc, 'csv') || canSave(this.host, this.doc, 'md');
  }

  /** @param {HTMLElement} anchor */
  openDownloads(anchor) {
    const result = this.state?.result;
    if (!result) return;
    const grid = toGrid(result);
    const only = this.ticked.size ? new Set(this.ticked) : null;
    const count = only ? only.size : grid.rows.length;
    this.popover(anchor, (pop, close) => {
      pop.append(h(this.doc, 'div', 'sb-art-pop-head', only ? `${count} ticked ${count === 1 ? 'row' : 'rows'}` : `All ${count} ${count === 1 ? 'row' : 'rows'}`));
      /** @type {["csv" | "csv-quotes" | "ris" | "md", string, string, boolean][]} */
      const choices = [
        ['csv', 'CSV', 'Opens in Excel or Numbers', canSave(this.host, this.doc, 'csv')],
        ['csv-quotes', 'CSV with quotes', 'Adds the supporting quote next to each answer', canSave(this.host, this.doc, 'csv') && hasQuotes(result)],
        ['ris', 'RIS', 'For a reference manager', grid.isPapers && canSave(this.host, this.doc, 'ris')],
        ['md', 'Markdown', 'A table for notes and documents', canSave(this.host, this.doc, 'md')],
      ];
      for (const [format, label, hint, shown] of choices) {
        if (shown) pop.append(menuItem(this.doc, { label, hint, onClick: () => { downloadResult(this.host, this.doc, result, format, only); } }, close));
      }
    }, 'sb-art-downloadmenu');
  }
}
