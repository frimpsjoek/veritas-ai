// @ts-check
// ui-src/src/panels/search-panel.js. SearchPanel (spec 005 D2): the search box, the Papers / Notes pills with the "More"
// source filter, one line of status, and result rows -- the same in Obsidian's Vault search view and Zotero's search
// window. It owns the query flow (debounce, stale-answer guard, keyboard); the host's `adapter` supplies the data and what
// opening a hit means. A host with extra modes (Zotero's "Find new papers") sets `handler` and draws through `setRows` /
// `setStatus`, so every mode uses the same rows and status line.
import { h } from '../dom.js';
import { Row, SearchBar, StateLine } from './panels.js';
import { lastHeading, metaOf, scopeOf, tidy } from './data.js';

/** @typedef {import("./data.js").HitLike} Hit */
/** @typedef {{ icon?: string, label: string, onClick: (event: MouseEvent) => void }} PanelAction */
/**
 * @typedef {object} SearchAdapter
 * @property {(query: string, scope: { source: string, exclude: string }, limit: number) => Promise<Hit[]>} search
 * @property {(hit: Hit, opts: { newTab: boolean, heading: string | null }) => void} open
 * @property {(doc: Document, snippet: string) => Node} [snippet] how a passage's text is drawn (Zotero turns citekeys into chips)
 * @property {(el: HTMLElement, hit: Hit, heading: string | null) => void} [decorate] extra wiring on a row and on each passage (Obsidian: context menu, drag, hover preview)
 * @property {(hit: Hit) => PanelAction[]} [rowActions]
 * @property {(error: unknown) => string} [unreachable] the status line for a failed search
 * @property {(hits: Hit[], seq: number, panel: SearchPanel) => void} [after] runs after the rows are drawn (Zotero's "Show N papers in library")
 * @property {(hits: Hit[]) => string} [statusText]
 */

export class SearchPanel {
  /**
   * @param {Document} doc
   * @param {{ adapter: SearchAdapter, placeholder: string, hint: string, limit?: number, options?: [string, string][],
   *   showPills?: boolean, selectFirst?: boolean, enterOpens?: boolean, papers?: boolean, notes?: boolean, specific?: string,
   *   onScope?: (scope: { papers: boolean, notes: boolean, specific: string }) => void }} o
   */
  constructor(doc, o) {
    this.doc = doc;
    this.o = o;
    this.adapter = o.adapter;
    this.limit = o.limit ?? 25;
    this.seq = 0;
    /** @type {Hit[]} */
    this.hits = [];
    this.selected = -1;
    /** @type {null | ((query: string, seq: number) => (void | Promise<void>))} */
    this.handler = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
    this.root = h(doc, 'div', 'sb-p sb-p-search');
    this.bar = SearchBar(doc, {
      placeholder: o.placeholder, papers: o.papers, notes: o.notes, specific: o.specific, options: o.options, showPills: o.showPills,
      onQuery: (query, immediate) => this.query(immediate),
      onScope: (scope) => { o.onScope?.(scope); this.run(); },
    });
    /** a host's own controls between the bar and the status (Zotero's service checkboxes) */
    this.extra = h(doc, 'div', 'sb-p-search-extra');
    this.statusRow = h(doc, 'div', 'sb-p-search-statusrow');
    this.statusEl = h(doc, 'div', 'sb-p-state is-info', o.hint);
    this.statusEl.setAttribute('role', 'status');
    /** a host's quiet tools on the status line (Obsidian: copy results as links) */
    this.tools = h(doc, 'div', 'sb-p-search-tools');
    this.statusRow.append(this.statusEl, this.tools);
    this.results = h(doc, 'div', 'sb-p-results');
    this.results.setAttribute('role', 'listbox');
    this.footer = h(doc, 'div', 'sb-p-search-footer');
    this.root.append(this.bar.el, this.extra, this.statusRow, this.results, this.footer);
    // capture: an Enter that opens the selected hit must run before the box's own Enter (search now) does
    this.root.addEventListener('keydown', (event) => this.key(event), true);
  }

  get input() { return this.bar.input; }
  focus() { this.input.focus(); }
  /** @param {string} query */
  setQuery(query) { this.input.value = query; this.run(); }

  /** @param {string} text @param {'info' | 'loading' | 'error' | 'empty'} [kind] */
  setStatus(text, kind = 'info') {
    this.statusEl.className = `sb-p-state is-${kind}`;
    this.statusEl.textContent = text;
    this.statusEl.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  }

  clear() {
    this.hits = [];
    this.selected = -1;
    this.results.replaceChildren();
    this.footer.replaceChildren();
  }

  /** Draw something other than library hits (Zotero's online rows). @param {Node[]} nodes */
  setRows(nodes) {
    this.hits = [];
    this.selected = -1;
    this.results.replaceChildren(...nodes);
  }

  /** @param {number} seq */
  isCurrent(seq) { return seq === this.seq; }

  /** @param {boolean} immediate */
  query(immediate) {
    if (this.timer) clearTimeout(this.timer);
    if (immediate) this.run();
    else this.timer = setTimeout(() => this.run(), 120);
  }

  async run() {
    if (this.timer) clearTimeout(this.timer);
    const query = this.input.value.trim();
    const seq = ++this.seq;
    if (this.handler) { await this.handler(query, seq); return; }
    if (!query) { this.clear(); this.setStatus(this.o.hint); return; }
    this.setStatus('Searching…', 'loading');
    let hits;
    try {
      hits = await this.adapter.search(query, scopeOf(this.bar.state), this.limit);
    } catch (error) {
      if (seq === this.seq) this.setStatus(this.adapter.unreachable?.(error) ?? `Search failed: ${/** @type {Error} */ (error)?.message ?? error}`, 'error');
      return;
    }
    if (seq !== this.seq) return; // a newer search has started
    this.hits = hits;
    this.selected = hits.length && this.o.selectFirst ? 0 : -1;
    this.footer.replaceChildren();
    this.draw();
    this.setStatus(hits.length ? (this.adapter.statusText?.(hits) ?? `${hits.length} result${hits.length === 1 ? '' : 's'}`) : 'No matches.', hits.length ? 'info' : 'empty');
    this.adapter.after?.(hits, seq, this);
  }

  draw() {
    const doc = this.doc;
    const adapter = this.adapter;
    this.results.replaceChildren();
    this.hits.forEach((hit, index) => {
      const open = (/** @type {MouseEvent | KeyboardEvent} */ e, /** @type {string | null} */ heading) => adapter.open(hit, { newTab: Boolean(e.metaKey || e.ctrlKey), heading });
      const passages = (hit.passages ?? []).map((p) => {
        const heading = p.heading ? lastHeading(p.heading) : '';
        return { heading, snippet: adapter.snippet ? adapter.snippet(doc, p.snippet) : tidy(p.snippet), raw: p.heading || null,
          ...(adapter.decorate ? {} : { onOpen: (/** @type {MouseEvent | KeyboardEvent} */ e) => open(e, p.heading || null) }) };
      });
      const row = Row(doc, {
        path: hit.path, title: hit.title, meta: metaOf(hit), passages, selected: index === this.selected,
        actions: adapter.rowActions?.(hit),
        ...(adapter.decorate ? {} : { onOpen: (/** @type {MouseEvent | KeyboardEvent} */ e) => open(e, null) }),
      });
      row.el.dataset.index = String(index);
      row.el.setAttribute('role', 'option');
      if (adapter.decorate) {
        row.el.classList.add('is-link');
        row.el.tabIndex = 0;
        adapter.decorate(row.el, hit, null);
        row.passages.forEach((el, n) => {
          el.classList.add('is-link');
          adapter.decorate?.(el, hit, hit.passages?.[n]?.heading || null);
          // a passage sits inside its row: what the host wired on it must not also reach the row's own wiring
          for (const type of ['click', 'contextmenu', 'mouseover', 'dragstart']) el.addEventListener(type, (e) => e.stopPropagation());
        });
      }
      this.results.append(row.el);
    });
  }

  /** @param {KeyboardEvent} event */
  key(event) {
    if (this.handler || !this.hits.length) return;
    const target = /** @type {HTMLElement} */ (event.target);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (target.closest('.sb-p-pop')) return;
      event.preventDefault();
      const next = Math.max(0, Math.min(this.hits.length - 1, this.selected + (event.key === 'ArrowDown' ? 1 : -1)));
      this.select(next);
    } else if (event.key === 'Enter') {
      const rowEl = target.closest('.sb-p-row');
      const index = rowEl ? Number(/** @type {HTMLElement} */ (rowEl).dataset.index) : (this.o.enterOpens && this.selected >= 0 ? this.selected : -1);
      const hit = this.hits[index];
      if (!hit || target.closest('button')) return;
      event.preventDefault();
      event.stopPropagation();
      this.adapter.open(hit, { newTab: Boolean(event.metaKey || event.ctrlKey), heading: null });
    }
  }

  /** @param {number} index */
  select(index) {
    this.selected = index;
    const rows = Array.from(this.results.querySelectorAll('.sb-p-row'));
    rows.forEach((row, n) => row.classList.toggle('is-selected', n === index));
    rows[index]?.scrollIntoView({ block: 'nearest' });
  }
}

export { StateLine };
