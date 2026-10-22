// @ts-nocheck -- UI glue moved from content/*.js (spec 005 C1), which was never typechecked in Zotero either;
// host.d.ts, tools.d.ts and domain.d.ts are still the checked interfaces these files must match.
// ui-src/src/chat/find-view.js. Moved from content/find-view.js's SecondBrain.FindView (spec 005 C1). Same
// behaviour and pixels as 0.22. Saved searches move from IOUtils/PathUtils to `host.files` (small JSON files
// under "finds/"); the library column and outside search move from `sb.agent.library()`/`sb.Discover` to
// `host.searchLibrary`/`host.searchOutside`/`host.libraryPaperByKey`; export moves to `host.exportRows`.
import { el, button, installStyle } from './dom-helpers.js';
import { toRis } from '../export/ris.js';
import { addLabel } from '../host-words.js';

// "searches", not "finds": the pre-005 folder name (PathUtils.join(dataDir, "second-brain", "searches")), kept
// so saved Find papers searches from before this move still open (success check 9).
const DIR = 'searches';

// Pre-005 Zotero harness tests (t-find-papers.js, t-sidebar.js) call the statics the old way — list(),
// load(id), remove(id), no host — because a ChatView's host used to be implicit (`this.sb`). Those tests are
// required to pass unmodified (spec 005 C1), so ChatView's constructor registers "whichever host is currently
// in use" here, and a bare-id call falls back to it; a real host argument (anything with `.files`) always wins.
let defaultHost = null;
export function setDefaultHost(host) { defaultHost = host; }
function resolveHost(maybeHost) { return maybeHost && typeof maybeHost === 'object' && maybeHost.files ? maybeHost : defaultHost; }

export class FindView {
  static LIBRARY_LIMIT = 15;
  static PER_SOURCE = 10;
  static SUMMARIZE = 8;

  /** Saved searches, newest first: { id, query, at, count }. @param {import("../host").UiHost} [host] */
  static async list(host) {
    host = resolveHost(host);
    const out = [];
    for (const path of await host.files.list(DIR)) {
      if (!path.endsWith('.json')) continue;
      try {
        const saved = JSON.parse(await host.files.read(path));
        out.push({ id: saved.id, query: saved.query, at: saved.at, count: saved.rows?.length ?? 0, session: saved.session ?? null });
      } catch (error) { host.logError(error); }
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  }

  /** `load(host, id)`, or the pre-005 `load(id)`. */
  static async load(hostOrId, maybeId) {
    const id = maybeId ?? hostOrId;
    const host = resolveHost(maybeId === undefined ? undefined : hostOrId);
    return JSON.parse(await host.files.read(`${DIR}/${id}.json`));
  }

  /** `remove(host, id)`, or the pre-005 `remove(id)`. */
  static async remove(hostOrId, maybeId) {
    const id = maybeId ?? hostOrId;
    const host = resolveHost(maybeId === undefined ? undefined : hostOrId);
    await host.files.remove(`${DIR}/${id}.json`);
  }

  /** `saved` is a search read back from disk; without it the view is for a new search (call run()). Its
   *  `sources` may still be the pre-005 `{ library, scholarly }` shape (read-time migration only, spec 005 §5:
   *  nothing on disk is rewritten). */
  constructor(chat, { query, scope = { kind: 'library' }, sources = { papers: true, scholarly: true }, saved = null }) {
    this.chat = chat;
    this.host = chat.host;
    this.id = saved?.id ?? `find-${Date.now().toString(36)}`;
    this.query = saved?.query ?? query;
    this.scope = saved?.scope ?? scope;
    const savedSources = saved?.sources;
    this.sources = savedSources
      ? { papers: savedSources.papers ?? savedSources.library ?? true, scholarly: savedSources.scholarly ?? true }
      : sources;
    this.at = saved?.at ?? new Date().toISOString();
    this.session = saved?.session ?? null; // spec 007 E3: the session that holds this search's papers as a result
    this.rows = saved?.rows ?? [];
    this.summary = saved?.summary ?? null;
    this.failed = saved?.failed ?? [];
    this.ticked = new Set();
    this.root = this.el('div', 'sb-ai-answer sb-fp');
    if (saved) this.render();
  }

  el(tag, cls, text) { return el(this.chat.doc, tag, cls, text); }

  button(label, onClick, primary = false) { return button(this.chat.doc, label, onClick, primary); }

  // ------------------------------------------------------------------ searching

  async run(signal) {
    const status = this.el('div', 'sb-ai-activity is-running', 'Searching…');
    this.root.replaceChildren(status);
    const names = [this.sources.papers && 'your library', this.sources.scholarly && 'scholarly databases'].filter(Boolean);
    if (!names.length) {
      this.root.replaceChildren(this.el('div', 'sb-ai-error', 'Pick at least one place to search: Papers or Scholarly.'));
      return;
    }
    status.textContent = `Searching ${names.join(' and ')}…`;
    const [library, outside] = await Promise.all([
      this.sources.papers ? this.libraryRows().catch((error) => { this.host.logError(error); return []; }) : [],
      this.sources.scholarly ? this.host.searchOutside(this.query, FindView.PER_SOURCE)
        .catch((error) => { this.host.logError(error); return { papers: [], failed: ['scholarly search'] }; }) : { papers: [], failed: [] },
    ]);
    if (signal?.aborted) return;
    this.failed = outside.failed ?? [];
    this.rows = await this.merge(library, (outside.papers ?? []).map((r) => this.fromOutside(r)));
    await this.save();
    this.render();
    if (this.rows.length) await this.summarize(this.rows.slice(0, FindView.SUMMARIZE), signal);
    await this.putResult();
  }

  /** spec 007 E3: the finished search also becomes a papers result (R1 V1) in a session of its own, so it shows
   *  under "Artifacts" and later steps can read it. Never fails the search: the saved search above stays as it was. */
  async putResult() {
    if (!this.rows.length) return;
    try {
      const ai = await this.host.ai();
      if (!ai.sessions?.put) return;
      if (!this.session) {
        this.session = await ai.conversations.create('chat');
        await ai.conversations.rename(this.session, this.query.replace(/\s+/g, ' ').slice(0, 200)); // full query, as the saved search's row showed it (the row ellipsizes)
      }
      const sources = { papers: Boolean(this.sources.papers), notes: false, scholarly: Boolean(this.sources.scholarly), web: false };
      const summary = await ai.sessions.put(this.session, { kind: 'find', query: this.query, sources, scope: this.scope }, this.papersResult());
      await this.save();
      this.chat.setFindSession?.(this, this.session, summary);
    } catch (error) {
      this.host.logError(error);
    }
  }

  /** The rows as a PapersResult draft (domain.d.ts PaperRow); the engine assigns the result id, version and step. */
  papersResult() {
    const taken = new Set();
    const rowId = (row) => {
      const base = row.citekey ? `p:${row.citekey}` : row.doi ? `doi:${row.doi.toLowerCase()}` : `t:${this.normalizeTitle(row.title).replace(/ /g, '-').slice(0, 48)}`;
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}~${n}`;
      taken.add(id);
      return id;
    };
    const rows = this.rows.map((row) => ({
      id: rowId(row),
      ref: row.citekey ? { kind: 'paper', citekey: row.citekey } : { kind: 'web', url: row.doi ? `https://doi.org/${row.doi}` : row.url ?? row.pdf ?? '' },
      inLibrary: Boolean(row.key), title: row.title, authors: row.authors ?? [], year: Number(row.year) || null, venue: row.venue ?? '',
      doi: row.doi ?? null, url: row.url ?? null, abstract: row.abstract ?? '', citations: row.citations ?? null,
      fullText: row.fullText ?? Boolean(row.pdf), pdfUrl: row.pdfUrl ?? row.pdf ?? null, studyType: row.studyType ?? null, foundBy: row.sources ?? [],
    }));
    return {
      kind: 'papers', ref: { id: 'R1', version: 1 }, title: this.query, created: this.at, madeBy: 'S1', from: [], change: 'Found papers',
      query: this.query, rows, columns: [], cells: {}, screening: null, summary: this.summary,
    };
  }

  async libraryRows() {
    const hits = await this.host.searchLibrary(this.query, this.scope, FindView.LIBRARY_LIMIT);
    return hits.filter((hit) => hit.ref.kind === 'paper').map((hit) => this.fromLibraryHit(hit));
  }

  /** @param {import("../host").LibraryPaperRow} hit */
  fromLibraryHit(hit) {
    return {
      title: hit.title, authors: hit.authors ?? [], year: hit.year ?? '', venue: hit.venue ?? '',
      doi: hit.doi ?? null, abstract: hit.abstract ?? '', key: hit.key ?? null,
      citekey: hit.ref.kind === 'paper' ? hit.ref.citekey : null, sources: ['Your library'],
      ...this.sourceFacts(hit),
    };
  }

  fromOutside(r) {
    return {
      title: r.title, authors: r.authors ?? [], year: r.year ?? '', venue: r.venue ?? '', doi: r.doi ?? null,
      arxiv: r.arxiv ?? null, pmid: r.pmid ?? null, pdf: r.pdf ?? null, type: r.type ?? 'article',
      abstract: (r.abstract ?? '').slice(0, 1500), url: r.url ?? null, key: r.key ?? null, citekey: null, sources: [r.source ?? 'Scholarly'],
      ...this.sourceFacts(r),
    };
  }

  /** What a source knew about a paper beyond its text (spec 007 E4): only the facts it gave, none guessed.
   *  @param {{ studyType?: any, fullText?: boolean, pdfUrl?: string | null, citations?: number | null }} r */
  sourceFacts(r) {
    return {
      ...(r.studyType != null ? { studyType: r.studyType } : {}), ...(r.fullText != null ? { fullText: r.fullText } : {}),
      ...(r.pdfUrl != null ? { pdfUrl: r.pdfUrl } : {}), ...(r.citations != null ? { citations: r.citations } : {}),
    };
  }

  normalizeTitle(title) {
    return (title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /** Library and outside results alternate by rank, so the top of the table (and the summary of its top papers)
   *  has both. A paper already listed (same item, DOI or title) is merged into the earlier row, never shown twice. */
  async merge(library, outside) {
    const ranked = [];
    for (let i = 0; i < Math.max(library.length, outside.length); i++) ranked.push(...[library[i], outside[i]].filter(Boolean));
    const rows = [];
    const seen = new Map();
    const keysOf = (row) => [row.key && `key:${row.key}`, row.doi && `doi:${row.doi.toLowerCase()}`,
      `title:${this.normalizeTitle(row.title)}`].filter(Boolean);
    for (const row of ranked) {
      if (!row.title) continue;
      const keys = keysOf(row);
      const earlier = keys.map((k) => seen.get(k)).find(Boolean);
      if (earlier) {
        earlier.sources = [...new Set([...earlier.sources, ...row.sources])];
        earlier.doi ??= row.doi;
        earlier.pdf ??= row.pdf;
        earlier.studyType ??= row.studyType;
        earlier.pdfUrl ??= row.pdfUrl;
        earlier.citations ??= row.citations;
        if (row.fullText) earlier.fullText = true;
        if (!earlier.abstract) earlier.abstract = row.abstract;
        continue;
      }
      // found outside but already in the library: show it as the user's own item
      let shown = row;
      if (row.key && !row.citekey) {
        const hit = await this.host.libraryPaperByKey(row.key).catch(() => null);
        if (hit) shown = { ...this.fromLibraryHit(hit), sources: [...new Set(['Your library', ...row.sources])] };
      }
      [...keys, ...keysOf(shown)].forEach((k) => seen.set(k, shown));
      rows.push(shown);
    }
    return rows;
  }

  // ------------------------------------------------------------------ the summary

  /** One grounded answer over the given rows: library papers go in as papers, outside ones as their abstract. */
  async summarize(rows, signal) {
    const box = this.root.querySelector('.sb-fp-summary');
    box.replaceChildren();
    const turn = { root: box, activities: this.el('div', 'sb-ai-activities'), text: this.el('div', 'sb-ai-text is-waiting', 'Summarizing the top papers…'),
      notice: this.el('div', 'sb-ai-notice'), events: [], expanded: new Set(), textFlushed: false,
      // no "Worked for" line here, but the same live list: open while the summary is written, folded once it is done
      live: { status: 'running', thinking: new Map(), startedAt: Date.now(), endedAt: null, time: null, frame: null, ticker: null } };
    box.append(turn.activities, turn.text, turn.notice);
    const attachments = rows.map((row) => (row.citekey ? { kind: 'zoteroItem', citekey: row.citekey } : {
      kind: 'quote',
      text: `${row.title} (${[row.authors[0] && `${row.authors[0]}${row.authors.length > 1 ? ' et al.' : ''}`, row.year].filter(Boolean).join(', ')})`
        + `${row.doi ? ` https://doi.org/${row.doi}` : ''}. Abstract: ${row.abstract || 'none'}`,
    }));
    const question = `In one short paragraph, summarize what these papers say about: "${this.query}". Cite each point: [@citekey] for papers in my library, the DOI link for the others.`;
    try {
      const ai = await this.host.ai();
      let done = null;
      const events = ai.ask(question, { attachments, web: 'off', signal });
      for await (const event of events) {
        if (event.type === 'activity' || event.type === 'reasoning' || event.type === 'line') {
          turn.events.push(event);
          this.chat.renderActivities(turn);
        } else if (event.type === 'done') done = event.answer;
        else if (event.type === 'failed') throw Object.assign(new Error(event.error.message), { kind: event.error.kind });
      }
      if (done) {
        this.summary = { markdown: done.structured?.markdown ?? done.text, citations: done.citations ?? [] };
        this.chat.finish(turn, this.summary.markdown, this.summary.citations);
        turn.notice.textContent = ''; // outside papers are cited by link and are expected not to be in the library
        await this.save();
      }
    } catch (error) {
      if (error.kind === 'cancelled' || signal?.aborted) this.chat.fail(turn, { kind: 'cancelled' });
      else this.chat.fail(turn, { message: `Couldn't write the summary: ${error.message}` });
    }
  }

  // ------------------------------------------------------------------ the table

  render() {
    const counts = this.el('div', 'sb-fp-count');
    const inLibrary = this.rows.filter((r) => r.key).length;
    counts.textContent = `${this.rows.length} papers · ${inLibrary} in your library`
      + (this.failed.length ? ` · couldn't reach ${this.failed.join(', ')}` : '');
    const summary = this.el('div', 'sb-fp-summary');
    if (this.summary) {
      const turn = { root: summary, activities: this.el('div'), text: this.el('div'), notice: this.el('div', 'sb-ai-notice'), events: [], expanded: new Set(), textFlushed: false };
      summary.append(turn.text, turn.notice);
      this.chat.finish(turn, this.summary.markdown, this.summary.citations);
      turn.notice.textContent = '';
    }
    if (!this.rows.length) {
      this.root.replaceChildren(counts, this.el('div', 'sb-ai-text', 'No papers found. Try other words, or turn on Scholarly.'));
      return;
    }
    this.actions = this.el('div', 'sb-fp-actions');
    this.table = this.el('div', 'sb-fp-table');
    this.root.replaceChildren(summary, counts, this.actions, this.table);
    this.renderActions();
    this.renderRows();
  }

  renderActions() {
    const picked = this.picked();
    const all = /** @type {HTMLInputElement} */ (this.el('input', 'sb-fp-tick'));
    all.type = 'checkbox';
    all.title = 'Tick all';
    all.checked = this.ticked.size === this.rows.length;
    all.indeterminate = this.ticked.size > 0 && !all.checked;
    all.addEventListener('change', () => {
      this.ticked = all.checked ? new Set(this.rows.map((_, i) => i)) : new Set();
      this.renderActions();
      this.renderRows();
    });
    const label = this.el('span', 'sb-fp-picked', this.ticked.size ? `${this.ticked.size} ticked` : 'Tick papers to use them');
    const chat = this.button('Chat about these', () => this.chatAbout(), true);
    chat.disabled = !this.ticked.size;
    const outside = picked.filter((r) => !r.key);
    const add = this.button(addLabel(this.host, outside.length || null), () => this.addToZotero(add));
    add.hidden = !this.host.can.addToLibrary;
    add.disabled = !outside.length;
    add.title = "Save the ticked papers that aren't in your library yet";
    const summarize = this.button('Summarize these', () => this.chat.runInThread((signal) => this.summarize(picked, signal)));
    summarize.disabled = !this.ticked.size;
    const csv = this.button('Export CSV', () => this.exportAs('csv'));
    const ris = this.button('Export RIS', () => this.exportAs('ris'));
    for (const b of [csv, ris]) b.title = this.ticked.size ? 'Export the ticked papers' : 'Export every paper in the table';
    this.actions.replaceChildren(all, label, this.el('span', 'sb-ed-spacer'), chat, summarize, add, csv, ris);
  }

  renderRows() {
    this.table.replaceChildren();
    this.rows.forEach((row, i) => {
      const line = this.el('div', `sb-fp-row${this.ticked.has(i) ? ' is-ticked' : ''}`);
      const tick = /** @type {HTMLInputElement} */ (this.el('input', 'sb-fp-tick'));
      tick.type = 'checkbox';
      tick.checked = this.ticked.has(i);
      tick.addEventListener('change', () => {
        if (tick.checked) this.ticked.add(i);
        else this.ticked.delete(i);
        line.classList.toggle('is-ticked', tick.checked);
        this.renderActions();
      });
      const paper = this.el('div', 'sb-fp-paper');
      const title = this.el('a', 'sb-fp-title', row.title);
      title.title = row.key ? 'Show in your library' : row.doi ? `Open https://doi.org/${row.doi}` : '';
      title.addEventListener('click', () => this.openRow(row));
      const authors = row.authors.length > 3 ? `${row.authors.slice(0, 3).join(', ')} et al.` : row.authors.join(', ');
      const meta = this.el('div', 'sb-fp-meta', [authors, row.year, row.venue].filter(Boolean).join(' · '));
      const where = this.el('div', 'sb-fp-where');
      where.append(this.el('span', `sb-fp-badge${row.key ? ' is-library' : ''}`, row.key ? 'In library' : row.sources.join(', ')));
      paper.append(title, meta, where);
      line.append(tick, paper, this.el('div', 'sb-fp-abstract', this.shortSummary(row.abstract)));
      this.table.append(line);
    });
  }

  /** The first two sentences of the abstract, which is what a reader scans for. */
  shortSummary(abstract) {
    if (!abstract) return 'No abstract.';
    const sentences = abstract.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(\s|$)/g) ?? [abstract];
    return sentences.slice(0, 2).join('').trim();
  }

  picked() {
    return this.ticked.size ? [...this.ticked].sort((a, b) => a - b).map((i) => this.rows[i]) : [];
  }

  openRow(row) {
    if (row.citekey) this.host.openRef({ kind: 'paper', citekey: row.citekey }, { newTab: false });
    else if (row.doi) this.host.openLink(`https://doi.org/${row.doi}`);
  }

  // ------------------------------------------------------------------ actions

  /** The ticked papers become the next chat's context: library ones as papers, outside ones as their abstract. */
  async chatAbout() {
    const rows = this.picked();
    if (this.chat.running) {
      this.chat.stop(); // the summary may still be writing; the mode can't change until it ends
      await this.chat.job;
    }
    this.chat.setMode('chat');
    for (const row of rows) {
      const attachment = row.citekey ? { kind: 'zoteroItem', citekey: row.citekey }
        : { kind: 'quote', text: `${row.title} (${row.year || 'n.d.'})${row.doi ? ` https://doi.org/${row.doi}` : ''}. Abstract: ${row.abstract || 'none'}` };
      if (this.chat.attachments.some((a) => JSON.stringify(a.attachment) === JSON.stringify(attachment))) continue;
      const first = row.authors[0] ? `${row.authors[0]}${row.authors.length > 1 ? ' et al.' : ''}` : row.title.slice(0, 40);
      this.chat.attachments.push({ attachment, label: [first, row.year].filter(Boolean).join(' ') });
    }
    this.chat.renderChips();
    this.chat.input.focus();
  }

  async addToZotero(btn) {
    const rows = this.picked().filter((r) => !r.key);
    btn.disabled = true;
    const outsidePapers = rows.map((row) => ({
      title: row.title, authors: row.authors, year: row.year || null, venue: row.venue, doi: row.doi,
      abstract: row.abstract, url: row.doi ? `https://doi.org/${row.doi}` : null, source: row.sources[0] ?? 'unknown',
      arxiv: row.arxiv, pmid: row.pmid, pdf: row.pdf, type: row.type, key: row.key,
    }));
    try {
      const result = await this.host.addToLibrary?.(outsidePapers);
      // Mutate each row in place (same objects this.rows holds), the way the pre-005 code updated .key/.citekey
      // as discover.add() finished each one — result.items is parallel to `rows`, index for index.
      result?.items?.forEach((item, i) => {
        if (!item) return;
        rows[i].key = item.key;
        rows[i].citekey = item.citekey;
      });
    } catch (error) {
      this.host.logError(error);
    }
    await this.save();
    this.render();
  }

  async exportAs(format) {
    const rows = this.ticked.size ? this.picked() : this.rows;
    const suggested = `${this.query.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60) || 'papers'}.${format}`;
    const text = format === 'csv' ? this.csv(rows) : this.ris(rows);
    await this.host.exportRows(text, format, suggested);
  }

  /** No dialog: writes straight to `path` (a full path, host-format). Not used by the "Export CSV"/"Export RIS"
   *  buttons (exportAs, above, which goes through the host's picker) — kept for callers that already have a
   *  destination path (the Zotero harness's t-find-papers.js checks CSV/RIS content this way). */
  async writeExport(format, path) {
    const rows = this.ticked.size ? this.picked() : this.rows;
    await this.host.writeFile(path, format === 'csv' ? this.csv(rows) : this.ris(rows));
  }

  csv(rows) {
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [['Title', 'Authors', 'Year', 'Venue', 'DOI', 'In library', 'Found in', 'Abstract'].map(cell).join(',')];
    for (const r of rows) lines.push([r.title, r.authors.join('; '), r.year, r.venue, r.doi, r.key ? 'yes' : 'no', r.sources.join('; '), r.abstract].map(cell).join(','));
    return lines.join('\r\n') + '\r\n';
  }

  ris(rows) {
    return toRis(rows);
  }

  async save() {
    const saved = { id: this.id, query: this.query, at: this.at, scope: this.scope, sources: this.sources, failed: this.failed, rows: this.rows, summary: this.summary, session: this.session };
    await this.host.files.write(`${DIR}/${this.id}.json`, JSON.stringify(saved));
  }

  static style(doc) {
    installStyle(doc, 'second-brain-find-style', FIND_CSS);
  }
}

const FIND_CSS = `
.sb-fp { gap: 10px; }
.sb-fp-summary:empty { display: none; }
.sb-fp-summary { display: flex; flex-direction: column; gap: 6px; }
.sb-fp-count { font-size: 11.5px; color: var(--sb-ui-muted); }
.sb-fp-actions { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
	padding: 6px 0; background: var(--sb-ui-bg); }
.sb-fp-picked { font-size: 11.5px; color: var(--sb-ui-muted); }
.sb-fp-actions .sb-button { border-radius: 999px; padding: 3px 10px; }
.sb-fp-actions .sb-button.is-primary { align-self: auto; font-weight: 600; color: var(--sb-ui-text); border-color: var(--sb-ui-accent);
	background: color-mix(in srgb, var(--sb-ui-accent) 18%, transparent); }
.sb-fp-actions .sb-button:disabled { opacity: .45; cursor: default; }
.sb-fp-table { display: flex; flex-direction: column; border: 1px solid var(--sb-ui-line); border-radius: 10px; overflow: hidden; }
.sb-fp-row { display: grid; grid-template-columns: 20px minmax(0, 1fr) minmax(0, 1.2fr); gap: 12px; padding: 10px 12px;
	border-top: 1px solid var(--sb-ui-line); align-items: start; }
.sb-fp-row:first-child { border-top: none; }
.sb-fp-row.is-ticked { background: color-mix(in srgb, var(--sb-ui-accent) 8%, transparent); }
.sb-fp-tick { margin: 2px 0 0; }
.sb-fp-paper { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.sb-fp-title { font-weight: 600; color: var(--sb-ui-text); cursor: pointer; line-height: 1.35; text-decoration: none; }
.sb-fp-title:hover { text-decoration: underline; }
.sb-fp-meta { font-size: 11.5px; color: var(--sb-ui-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-fp-badge { font-size: 11.5px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--sb-ui-line); color: var(--sb-ui-muted); }
.sb-fp-badge.is-library { border-color: var(--sb-ui-accent); color: var(--sb-ui-text); }
.sb-fp-abstract { font-size: 12.5px; line-height: 1.45; color: var(--sb-ui-muted); display: -webkit-box; -webkit-line-clamp: 4;
	-webkit-box-orient: vertical; overflow: hidden; }
`;
