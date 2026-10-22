// @ts-check
// ui-src/src/panels/related-panels.js. Related, Links and Duplicates as host-agnostic panels (spec 013 W2). They are
// ported from obsidian-plugin/src/{related,duplicates}.ts and keep their grouping, labels and empty states. A host
// supplies `fetchJSON` (its way of calling the server) and `open` (what a row does); everything that only one host can
// do (copy as links, hover preview, move to trash, the cursor's section) is an optional hook, and a panel without the
// hook simply leaves that control out.
import { h } from '../dom.js';
import { Button, IconButton, Row, Section, StateLine, Subhead, Tabs } from './panels.js';
import {
  DUPLICATE_TABS, conflictIntro, conflictMeta, duplicateCount, duplicateGroups, linkGroups, linkedRows, relatedProblem,
  rowMeta, rowScore, sectionRows, similarRows, tagRows, titleOf, isZoteroRef,
} from './related-data.js';
import { byline, folderOf } from './data.js';

/** @typedef {import("./related-data.js").NoteRef} NoteRef */
/** @typedef {import("./related-data.js").RelRow} RelRow */
/** @typedef {import("./related-data.js").Related} Related */
/** @typedef {import("./related-data.js").Duplicates} Duplicates */
/** @typedef {import("./related-data.js").Conflicts} Conflicts */
/** @typedef {import("./related-data.js").LocalLinks} LocalLinks */
/** @typedef {import("./related-data.js").SectionMatch} SectionMatch */
/** A server call. `error.status` carries the HTTP status. @typedef {(route: string, params?: Record<string, string | number>, init?: { method?: "GET" | "POST", body?: unknown }) => Promise<any>} FetchJSON */
/** What a row does when opened (click, Enter, Space). @typedef {(ref: NoteRef, heading: string | null, event?: MouseEvent | KeyboardEvent) => void} OpenRef */
/** Lets a host add its own behaviour to a row (hover preview, drag, context menu). @typedef {(el: HTMLElement, ref: NoteRef, heading: string | null) => void} DecorateRow */

/** @param {Document} doc @param {HTMLElement} root @param {string} label @param {RelRow[]} rows @param {string} empty
 *  @param {{ open: OpenRef, decorate?: DecorateRow, copyLinks?: (rows: RelRow[]) => void }} hooks */
function rowSection(doc, root, label, rows, empty, hooks) {
  const section = Section(doc, {
    title: label, count: rows.length, empty,
    actions: rows.length && hooks.copyLinks ? [{ icon: 'duplicate', label: 'Copy as links', onClick: () => hooks.copyLinks?.(rows) }] : [],
  });
  for (const row of rows) {
    const shown = Row(doc, {
      path: row.path, title: row.title, meta: rowMeta(row), score: rowScore(row),
      onOpen: (event) => hooks.open(row, row.heading ?? null, event),
    });
    hooks.decorate?.(shown.el, row, row.heading ?? null);
    section.body.append(shown.el);
  }
  root.append(section.el);
}

/**
 * What relates to one note or paper: what it links to and is linked from, similar notes, notes sharing its tags, and
 * (Obsidian) the passages close to the section being edited.
 * `localLinks` is the host's own link graph, used when the index is unreachable or does not know the note.
 * `linked: false` leaves the Linked section out, for a host that shows the Links panel next to this one.
 * @param {Document} doc
 * @param {{ fetchJSON: FetchJSON, open: OpenRef, decorate?: DecorateRow, copyLinks?: (rows: RelRow[]) => void,
 *   localLinks?: (path: string) => LocalLinks, linked?: boolean, limit?: number, afterIndexMs?: number }} o
 */
export function RelatedPanel(doc, o) {
  const el = h(doc, 'div', 'sb-p sb-p-related');
  let seq = 0;
  let sectionSeq = 0;
  /** @type {HTMLElement | null} */ let sectionEl = null;
  /** @type {string | null} */ let current = null;
  const hooks = { open: o.open, decorate: o.decorate, copyLinks: o.copyLinks };

  /** @param {string} path @param {{ title?: string, force?: boolean }} [opts] */
  async function show(path, opts = {}) {
    if (path === current && !opts.force) return;
    current = path;
    const mine = ++seq;
    sectionSeq++;
    el.replaceChildren();
    if (opts.title) el.append(h(doc, 'div', 'sb-p-for', opts.title));
    sectionEl = h(doc, 'div');
    const status = StateLine(doc, 'loading', 'Finding related notes…');
    const body = h(doc, 'div');
    el.append(sectionEl, status, body);

    /** @type {Related | null} */ let related = null;
    let problem = { message: '', notIndexed: false };
    try {
      related = await o.fetchJSON('/related', { path, limit: o.limit ?? 12 });
    } catch (error) {
      problem = relatedProblem(/** @type {any} */ (error));
    }
    if (mine !== seq) return;
    status.remove();

    const local = o.localLinks?.(path) ?? null;
    if (o.linked !== false) rowSection(doc, body, 'Linked', linkedRows(related, local), 'No links to or from this note.', hooks);
    if (!related) {
      body.append(StateLine(doc, 'error', problem.message));
      if (problem.notIndexed) {
        const add = Button(doc, 'Add it now', async () => {
          await o.fetchJSON('/index', {}, { method: 'POST' });
          add.disabled = true;
          const label = add.lastElementChild;
          if (label) label.textContent = 'Adding…';
          globalThis.setTimeout(() => { void show(path, { ...opts, force: true }); }, o.afterIndexMs ?? 15000);
        }, { primary: true });
        body.append(add);
      }
      return;
    }
    rowSection(doc, body, 'Similar', similarRows(related), 'Nothing similar found.', hooks);
    rowSection(doc, body, 'Shared tags', tagRows(related), "No other notes share this note's tags.", hooks);
  }

  /** Shows the passages near the section being edited; `null` clears them. @param {{ label: string, matches: SectionMatch[] } | null} section */
  function setSection(section) {
    if (!sectionEl) return;
    sectionSeq++;
    sectionEl.replaceChildren();
    if (section) rowSection(doc, sectionEl, section.label, sectionRows(section.matches), 'Nothing close to this section.', hooks);
  }

  return { el, show, setSection, get current() { return current; } };
}

/**
 * The link graph of one note or paper from /links: what it links to, what links to it, and wiki links that have no
 * note yet. A paper's rows are titled from the library when `resolveTitle` is given (the graph itself has only paths).
 * @param {Document} doc
 * @param {{ fetchJSON: FetchJSON, open: OpenRef, decorate?: DecorateRow, resolveTitle?: (path: string) => Promise<string | null> }} o
 */
export function LinksPanel(doc, o) {
  const el = h(doc, 'div', 'sb-p sb-p-links');
  let seq = 0;
  /** @type {string | null} */ let current = null;

  /** @param {string} path @param {{ force?: boolean }} [opts] */
  async function show(path, opts = {}) {
    if (path === current && !opts.force) return;
    current = path;
    const mine = ++seq;
    el.replaceChildren(StateLine(doc, 'loading', 'Finding links…'));
    let graph;
    try {
      graph = linkGroups(await o.fetchJSON('/links', { path }));
    } catch (error) {
      if (mine !== seq) return;
      el.replaceChildren(StateLine(doc, 'error', `Couldn't load links: ${/** @type {any} */ (error)?.message ?? 'unknown error'}`));
      return;
    }
    if (mine !== seq) return;
    el.replaceChildren();
    for (const [label, refs, empty] of /** @type {[string, NoteRef[], string][]} */ ([
      ['Links to', graph.outgoing, 'This note links to nothing yet.'],
      ['Linked from', graph.incoming, 'No note links here.'],
    ])) {
      const section = Section(doc, { title: label, count: refs.length, empty });
      for (const ref of refs) {
        const row = Row(doc, { path: ref.path, title: ref.title, meta: isZoteroRef(ref) ? 'Paper' : folderOf(ref.path), onOpen: (event) => o.open(ref, null, event) });
        o.decorate?.(row.el, ref, null);
        section.body.append(row.el);
        if (isZoteroRef(ref) && o.resolveTitle) {
          void o.resolveTitle(ref.path).then((title) => {
            if (title && mine === seq) row.titleEl.querySelector('.sb-p-row-text')?.replaceChildren(title);
          });
        }
      }
      el.append(section.el);
    }
    if (graph.missing.length) {
      const section = Section(doc, { title: 'No note yet', count: graph.missing.length });
      for (const name of graph.missing) section.body.append(h(doc, 'div', 'sb-p-meta', name));
      el.append(section.el);
    }
  }

  return { el, show, get current() { return current; } };
}

const GROUP_CAP = 300;

/**
 * Notes that are the same note twice, and sync-conflict copies. It never removes anything by itself: a host that can
 * remove (Obsidian, to its trash) passes `onTrash`/`onCompare`; without them the panel is a read-only report.
 * `onTrash(paths, rowEl)` gets the row to strike through, or null when it removed a whole batch (the panel re-checks then).
 * @param {Document} doc
 * @param {{ fetchJSON: FetchJSON, open: OpenRef, decorate?: DecorateRow,
 *   onTrash?: (paths: string[], row: HTMLElement | null) => void | Promise<void>, onCompare?: (left: string, right: string) => void }} o
 */
export function DuplicatesPanel(doc, o) {
  const el = h(doc, 'div', 'sb-p sb-p-wide sb-p-dups');
  const head = h(doc, 'div', 'sb-p-head');
  head.append(h(doc, 'div', 'sb-p-title', 'Duplicate notes'), IconButton(doc, 'refresh', 'Check again', () => { void check(); }));
  const note = StateLine(doc, 'info', o.onTrash
    ? 'Nothing is removed unless you click. Removed notes go to your trash and can be restored.'
    : 'This is a report. Open a note to review it; removing copies is done in Obsidian.');
  const tabsEl = h(doc, 'div');
  const body = h(doc, 'div');
  el.append(head, note, tabsEl, body);
  /** @type {import("./related-data.js").DuplicateTab} */ let tab = 'exact';
  /** @type {Duplicates | null} */ let dups = null;
  /** @type {Conflicts | null} */ let conflicts = null;
  let seq = 0;

  async function check() {
    const mine = ++seq;
    body.replaceChildren(StateLine(doc, 'loading', 'Comparing notes… (sync conflicts can take a minute)'));
    try {
      [dups, conflicts] = await Promise.all([o.fetchJSON('/duplicates'), o.fetchJSON('/conflicts')]);
    } catch (error) {
      if (mine === seq) body.replaceChildren(StateLine(doc, 'error', `Couldn't check for duplicates: ${/** @type {any} */ (error)?.message ?? 'unknown error'}`));
      return;
    }
    if (mine === seq) paint();
  }

  /** @param {NoteRef} ref @param {NoteRef[]} group @param {HTMLElement[]} rowBox */
  function actionsFor(ref, group, rowBox) {
    /** @type {import("./panels.js").PanelAction[]} */
    const actions = [];
    if (isZoteroRef(ref)) return actions;
    if (o.onCompare && group.length === 2) {
      const [a, b] = group;
      actions.push({ icon: 'columns', label: 'Compare side by side', onClick: () => o.onCompare?.(a.path, b.path) });
    }
    if (o.onTrash) actions.push({ icon: 'trash', label: 'Move this copy to trash', onClick: () => { void o.onTrash?.([ref.path], rowBox[0] ?? null); } });
    return actions;
  }

  /** @param {{ refs: NoteRef[], score?: number }[]} groups @param {string} intro */
  function paintGroups(groups, intro) {
    body.append(StateLine(doc, 'info', intro));
    if (!groups.length) { body.append(StateLine(doc, 'empty', 'None found.')); return; }
    for (const group of groups.slice(0, GROUP_CAP)) {
      const box = h(doc, 'div', 'sb-p-group');
      if (group.score) box.append(h(doc, 'div', 'sb-p-meta', `Similarity ${group.score}`));
      for (const ref of group.refs) {
        /** @type {HTMLElement[]} */ const self = [];
        const row = Row(doc, {
          path: ref.path, title: ref.title, meta: isZoteroRef(ref) ? byline(ref.zotero) : folderOf(ref.path),
          actions: actionsFor(ref, group.refs, self), onOpen: (event) => o.open(ref, null, event),
        });
        self.push(row.el);
        o.decorate?.(row.el, ref, null);
        box.append(row.el);
      }
      body.append(box);
    }
    if (groups.length > GROUP_CAP) body.append(h(doc, 'div', 'sb-p-meta', `…and ${groups.length - GROUP_CAP} more`));
  }

  function paintConflicts() {
    const c = /** @type {Conflicts} */ (conflicts);
    body.append(StateLine(doc, 'info', conflictIntro(c)));
    if (c.identical.length && o.onTrash) {
      const card = h(doc, 'div', 'sb-p-group sb-p-callout');
      const text = h(doc, 'div', 'sb-p-callout-text');
      text.append(
        h(doc, 'div', 'sb-p-row-text', `Remove the ${c.identical.length} identical copies`),
        h(doc, 'div', 'sb-p-row-meta is-wrap', 'Each is byte-for-byte the same as its original, so nothing is lost. They go to your trash.'),
      );
      card.append(text, Button(doc, 'Move to trash', () => { void Promise.resolve(o.onTrash?.(c.identical.map((e) => e.copy), null)).then(check); }, { danger: true, icon: 'trash' }));
      body.append(card);
    }
    if (c.different.length) {
      body.append(Subhead(doc, 'Different from the original'));
      for (const entry of c.different.slice(0, GROUP_CAP)) {
        const original = { path: entry.original, title: titleOf(entry.original) };
        /** @type {HTMLElement[]} */ const self = [];
        /** @type {import("./panels.js").PanelAction[]} */
        const actions = [];
        if (o.onCompare) actions.push({ icon: 'columns', label: 'Compare copy with original', onClick: () => o.onCompare?.(entry.original, entry.copy) });
        if (o.onTrash) actions.push({ icon: 'trash', label: 'Move the copy to trash', onClick: () => { void o.onTrash?.([entry.copy], self[0] ?? null); } });
        const row = Row(doc, { path: entry.original, title: original.title, meta: conflictMeta(entry), actions, onOpen: (event) => o.open(original, null, event) });
        self.push(row.el);
        o.decorate?.(row.el, original, null);
        body.append(row.el);
      }
      if (c.different.length > GROUP_CAP) body.append(h(doc, 'div', 'sb-p-meta', `…and ${c.different.length - GROUP_CAP} more`));
    }
    if (c.no_original.length) {
      body.append(Subhead(doc, 'Copies whose original is gone'));
      for (const e of c.no_original.slice(0, 100)) body.append(h(doc, 'div', 'sb-p-meta', e.copy));
    }
  }

  function paint() {
    tabsEl.replaceChildren(Tabs(doc, DUPLICATE_TABS.map(([id, label]) => ({ id, label, count: duplicateCount(dups, conflicts, id) })), tab, (id) => {
      tab = /** @type {typeof tab} */ (id);
      paint();
    }));
    body.replaceChildren();
    const shaped = duplicateGroups(/** @type {Duplicates} */ (dups), tab);
    if (shaped) paintGroups(shaped.groups, shaped.intro); else paintConflicts();
  }

  return { el, check };
}
