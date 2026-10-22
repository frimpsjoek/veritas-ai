// @ts-check
// ui-src/src/chat/artifact-table.js. Draws a papers or table result's rows: as a table with a sticky first column
// (Elicit 9.22.03) or, below 560 px, as a list of cards, one per row, each column a label and a value (spec 007 §4
// "Widths"). Cells are text first: the value, then quiet grey citation chips after the sentence, "+N" for more than
// one (spec 005's chip). A chip opens a small popover with the quote, where it came from, an "Unverified" mark when
// the quote check failed, and Open. Pending cells are skeleton bars. Row ticks feed the panel's Download.
import { h } from '../dom.js';
import { outsideButton } from '../links.js';
import { cellRefs, cellQuotes, refKey, authorsShort } from '../export/common.js';
import { isUnverified } from './artifact-data.js';
import { keyOf } from './radar-digest-data.js';

/** @typedef {import("../host").UiHost} UiHost */
/** @typedef {import("../../../agent/src/domain").Cell} Cell */
/** @typedef {import("../../../agent/src/domain").CitationRef} CitationRef */
/** @typedef {import("../../../agent/src/domain").ColumnSpec} ColumnSpec */
/** @typedef {import("../export/common.js").Grid} Grid */
/** @typedef {import("../export/common.js").GridRow} GridRow */
/**
 * What the renderer needs from the panel. `popover` opens a floating box under an element and hands the caller its
 * content node.
 * @typedef {{ doc: Document, host: UiHost, ticked: Set<string>, onTick: () => void, onRetry?: (rowId: string, columnId: string) => void,
 *             added?: Set<string>, popover: (anchor: HTMLElement, fill: (pop: HTMLElement, close: () => void) => void, className?: string) => void,
 *             gate?: Gate, radar?: import("./radar-digest.js").RadarDigest }} TableContext
 * spec 007 E8: `gate` is set while a systematic review waits on its unclear papers: `unclear` maps each toggleable row to the
 * strict criteria it was unclear on, `keep` holds the researcher's calls so far (missing = included), `onChange` repaints the banner.
 * spec 012 R4: `radar` is set on a reading radar's digest; each paper then shows its "why read this" line and its row actions.
 * @typedef {{ unclear: Map<string, string[]>, keep: Map<string, boolean>, onChange: () => void }} Gate
 */

/** The first two sentences of an abstract, which is what a reader scans for. @param {string} abstract */
export function abstractLead(abstract) {
  if (!abstract) return 'No abstract.';
  const sentences = abstract.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(\s|$)/g) ?? [abstract];
  return sentences.slice(0, 2).join('').trim();
}

/** How a citation reads on a chip: "Wang 2024" for a paper (the host's label), the note's name, the link's site.
 *  @param {UiHost} host @param {CitationRef} ref @param {HTMLElement} node */
export function labelRef(host, ref, node) {
  if (ref.kind === 'paper') {
    const cached = host.citeLabel(ref.citekey);
    node.textContent = cached?.label ?? ref.citekey;
    if (!cached) host.resolveLabel(ref.citekey).then((label) => { node.textContent = label; }, () => {});
  } else if (ref.kind === 'note') node.textContent = ref.path.replace(/^.*\//, '').replace(/\.md$/, '');
  else {
    try { node.textContent = new (node.ownerDocument.defaultView?.URL ?? URL)(ref.url).hostname.replace(/^www\./, ''); } catch { node.textContent = ref.url; }
  }
}

/** @param {TableContext} ctx @param {CitationRef} ref */
function openCitation(ctx, ref) {
  ctx.host.openRef(ref, { newTab: false });
}

/** The grey chip after a cell's sentence. @param {TableContext} ctx @param {Cell} cell */
function citationChip(ctx, cell) {
  const refs = cellRefs(cell);
  if (!refs.length) return null;
  const chip = h(ctx.doc, 'button', 'sb-art-chip');
  chip.setAttribute('type', 'button');
  const first = h(ctx.doc, 'span', 'sb-art-chip-label');
  labelRef(ctx.host, refs[0], first);
  chip.append(first);
  if (refs.length > 1) chip.append(h(ctx.doc, 'span', 'sb-art-chip-more', `+${refs.length - 1}`));
  if (cellQuotes(cell).length && isUnverified(cell)) chip.append(h(ctx.doc, 'span', 'sb-art-chip-unverified', 'Unverified'));
  chip.title = 'Show where this comes from';
  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    ctx.popover(chip, (pop, close) => fillEvidence(ctx, pop, close, cell, refs), 'sb-art-evidence');
  });
  return chip;
}

/** The chip popover: per citation its label, each quote with its source and check mark, and Open.
 *  @param {TableContext} ctx @param {HTMLElement} pop @param {() => void} close @param {Cell} cell @param {CitationRef[]} refs */
function fillEvidence(ctx, pop, close, cell, refs) {
  const quotes = cellQuotes(cell);
  for (const ref of refs) {
    const block = h(ctx.doc, 'div', 'sb-art-ev');
    const head = h(ctx.doc, 'div', 'sb-art-ev-head');
    const name = h(ctx.doc, 'span', 'sb-art-ev-name');
    labelRef(ctx.host, ref, name);
    head.append(name);
    if (ref.kind !== 'web' || ref.url) {
      const open = h(ctx.doc, 'button', 'sb-art-ev-open', 'Open');
      open.setAttribute('type', 'button');
      open.addEventListener('click', (event) => { event.stopPropagation(); close(); openCitation(ctx, ref); });
      head.append(open);
    }
    block.append(head);
    const mine = quotes.filter((q) => refKey(q.ref) === refKey(ref));
    for (const q of mine) {
      block.append(h(ctx.doc, 'blockquote', 'sb-art-ev-quote', q.text));
      const meta = h(ctx.doc, 'div', 'sb-art-ev-meta');
      meta.append(h(ctx.doc, 'span', '', q.from === 'full_text' ? 'From the full text' : 'From the abstract'));
      if (!q.verified) meta.append(h(ctx.doc, 'span', 'sb-art-unverified', q.unverified ? 'Unverified: abstract not checked' : 'Unverified'));
      block.append(meta);
    }
    if (!mine.length) block.append(h(ctx.doc, 'div', 'sb-art-ev-meta', 'No quote saved for this one.'));
    pop.append(block);
  }
}

/** Three grey bars where a cell is still being filled (Elicit 9.23.35). @param {Document} doc */
function skeleton(doc) {
  const box = h(doc, 'div', 'sb-art-skel');
  for (const width of ['100%', '86%', '58%']) {
    const bar = h(doc, 'span', 'sb-art-skel-bar');
    bar.style.width = width;
    box.append(bar);
  }
  return box;
}

/** One cell's content: the text and its chip, a "not found" note, an error with a small retry, or the skeleton.
 *  A value none of whose quotes checked out is drawn with a dashed underline. `rowId` is what Retry re-runs.
 *  A cell that knows its row and column carries them in `data-cell`, so a live fill can swap just that cell.
 *  @param {TableContext} ctx @param {Cell | undefined} cell @param {string} [rowId] @param {string} [columnId] */
export function renderCell(ctx, cell, rowId, columnId) {
  const box = h(ctx.doc, 'div', 'sb-art-cell');
  if (rowId && columnId) box.setAttribute('data-cell', JSON.stringify([rowId, columnId]));
  if (!cell && !(rowId && columnId)) { box.append(skeleton(ctx.doc)); return box; }
  if (!cell) { box.append(h(ctx.doc, 'span', 'sb-art-note', 'Not filled in yet')); return box; }
  if (cell.state === 'pending') { box.append(skeleton(ctx.doc)); return box; }
  if (cell.state === 'not_found') { box.append(h(ctx.doc, 'span', 'sb-art-note', cell.note || 'Not reported in the abstract')); return box; }
  if (cell.state === 'failed') {
    const fail = h(ctx.doc, 'span', 'sb-art-fail', "Couldn't fill this in.");
    fail.title = cell.error ?? '';
    box.append(fail);
    if (ctx.onRetry && rowId && columnId) {
      const retry = h(ctx.doc, 'button', 'sb-art-retry', 'Retry');
      retry.setAttribute('type', 'button');
      retry.title = 'Try this one again';
      retry.addEventListener('click', (event) => { event.stopPropagation(); ctx.onRetry?.(rowId, columnId); });
      box.append(' ', retry);
    }
    return box;
  }
  const value = h(ctx.doc, 'span', `sb-art-value${isUnverified(cell) ? ' is-unverified' : ''}`, cell.value ?? '');
  if (isUnverified(cell)) value.title = 'No quote from the paper backs this up yet';
  box.append(value);
  const chip = citationChip(ctx, cell);
  if (chip) box.append(' ', chip);
  return box;
}

/** @param {TableContext} ctx @param {GridRow} row */
function openPaper(ctx, row) {
  const p = row.paper;
  if (!p) return;
  if (p.ref.kind === 'paper') openCitation(ctx, p.ref);
  else if (p.doi) ctx.host.openLink(`https://doi.org/${p.doi}`);
  else if (p.url) ctx.host.openLink(p.url);
}

/** The paper's own cell: title, authors "+N", venue, year · citations, where it lives, DOI, text depth.
 *  @param {TableContext} ctx @param {GridRow} row */
function paperCell(ctx, row) {
  const p = /** @type {NonNullable<GridRow["paper"]>} */ (row.paper);
  const box = h(ctx.doc, 'div', 'sb-art-paper');
  const title = h(ctx.doc, 'a', 'sb-art-title', p.title);
  title.setAttribute('role', 'link');
  title.setAttribute('tabindex', '0');
  title.title = p.inLibrary ? 'Show in your library' : p.doi ? `Open https://doi.org/${p.doi}` : '';
  title.addEventListener('click', () => openPaper(ctx, row));
  title.addEventListener('keydown', (event) => { if (event.key === 'Enter') openPaper(ctx, row); });
  box.append(title);
  const why = ctx.radar?.line(p);
  if (why) box.append(why);
  if (p.authors.length) box.append(h(ctx.doc, 'div', 'sb-art-meta', authorsShort(p.authors)));
  if (p.venue) box.append(h(ctx.doc, 'div', 'sb-art-meta', p.venue));
  const stats = [p.year, p.citations != null ? `${p.citations} ${p.citations === 1 ? 'citation' : 'citations'}` : null].filter(Boolean).join(' · ');
  if (stats) box.append(h(ctx.doc, 'div', 'sb-art-meta', stats));
  const tags = h(ctx.doc, 'div', 'sb-art-tags');
  // Reports and routines record their own search numbers ("q1") in foundBy: only a source name is shown.
  const source = p.foundBy.find((name) => !/^q\d+$/.test(name));
  tags.append(h(ctx.doc, 'span', `sb-art-tag${p.inLibrary ? ' is-library' : ''}`, p.inLibrary ? 'In library' : (source ?? 'Outside your library')));
  tags.append(h(ctx.doc, 'span', 'sb-art-tag', p.fullText ? 'Full text' : 'Abstract only'));
  if (p.doi) {
    const doi = h(ctx.doc, 'a', 'sb-art-doi', 'DOI');
    doi.setAttribute('role', 'link');
    doi.title = `https://doi.org/${p.doi}`;
    doi.addEventListener('click', () => ctx.host.openLink(`https://doi.org/${p.doi}`));
    tags.append(doi);
    const out = outsideButton(ctx.doc, ctx.host, `https://doi.org/${p.doi}`);
    if (out) tags.append(out);
  }
  box.append(tags);
  if (ctx.radar && keyOf(p)) box.append(ctx.radar.actions(p));
  return box;
}

/** The first column's content: the paper, or the row's label. @param {TableContext} ctx @param {GridRow} row */
function rowHead(ctx, row) {
  return row.paper ? paperCell(ctx, row) : h(ctx.doc, 'div', 'sb-art-label', row.label);
}

/** An unclear paper's include / leave-out switch, with the criteria it was unclear on. The text may be long and wraps
 *  (Obsidian's default button style is nowrap). @param {TableContext} ctx @param {GridRow} row */
function gateToggle(ctx, row) {
  const gate = /** @type {Gate} */ (ctx.gate);
  const box = h(ctx.doc, 'div', 'sb-art-gate');
  const because = gate.unclear.get(row.id) ?? [];
  if (because.length) box.append(h(ctx.doc, 'div', 'sb-art-gate-why', `Unclear on: ${because.join('; ')}`));
  const toggle = h(ctx.doc, 'button', 'sb-art-gate-toggle');
  toggle.setAttribute('type', 'button');
  const paint = () => {
    const on = gate.keep.get(row.id) !== false;
    toggle.textContent = on ? 'Included in the review' : 'Left out of the review';
    toggle.setAttribute('aria-pressed', String(on));
    toggle.classList.toggle('is-out', !on);
    toggle.closest('.sb-art-row, .sb-art-rowcard')?.classList.toggle('is-gate-out', !on);
  };
  toggle.addEventListener('click', () => { gate.keep.set(row.id, gate.keep.get(row.id) === false); paint(); gate.onChange(); });
  paint();
  box.append(toggle);
  return box;
}

/** @param {TableContext} ctx @param {GridRow} row */
function tickBox(ctx, row) {
  const tick = /** @type {HTMLInputElement} */ (h(ctx.doc, 'input', 'sb-art-tick'));
  tick.type = 'checkbox';
  tick.checked = ctx.ticked.has(row.id);
  tick.setAttribute('aria-label', `Tick ${row.label}`);
  tick.addEventListener('change', () => {
    if (tick.checked) ctx.ticked.add(row.id); else ctx.ticked.delete(row.id);
    tick.closest('.sb-art-row, .sb-art-rowcard')?.classList.toggle('is-ticked', tick.checked);
    ctx.onTick();
  });
  return tick;
}

/** A papers result with no columns still shows what each paper says: its abstract, in the column Elicit calls
 *  "Abstract summary". A radar digest has its why line under the title instead. @param {TableContext} ctx @param {Grid} grid */
function showsAbstract(ctx, grid) {
  return grid.isPapers && grid.columns.length === 0 && !ctx.radar;
}

/**
 * The table: header row, one row per visible row, first column sticky.
 * @param {TableContext} ctx @param {Grid} grid @param {GridRow[]} rows
 */
export function renderTable(ctx, grid, rows) {
  const { doc } = ctx;
  const wrap = h(doc, 'div', 'sb-art-tablewrap');
  const table = h(doc, 'table', `sb-art-table${ctx.radar ? ' is-radar' : ''}`);
  const headRow = h(doc, 'tr', 'sb-art-headrow');
  const first = h(doc, 'th', 'sb-art-th is-first');
  const all = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-art-tick'));
  all.type = 'checkbox';
  all.title = 'Tick all';
  all.setAttribute('aria-label', 'Tick all rows');
  all.checked = rows.length > 0 && rows.every((r) => ctx.ticked.has(r.id));
  all.indeterminate = !all.checked && rows.some((r) => ctx.ticked.has(r.id));
  all.addEventListener('change', () => {
    for (const r of rows) { if (all.checked) ctx.ticked.add(r.id); else ctx.ticked.delete(r.id); }
    ctx.onTick();
    for (const box of Array.from(wrap.querySelectorAll('tbody .sb-art-tick'))) /** @type {HTMLInputElement} */ (box).checked = all.checked;
    for (const tr of Array.from(wrap.querySelectorAll('tbody tr'))) tr.classList.toggle('is-ticked', all.checked);
  });
  first.append(all, h(doc, 'span', 'sb-art-th-label', grid.isPapers ? `Paper (${rows.length})` : `Item (${rows.length})`));
  headRow.append(first);
  const heads = showsAbstract(ctx, grid) ? ['Abstract summary'] : grid.columns.map((c) => c.name);
  for (const name of heads) headRow.append(h(doc, 'th', 'sb-art-th', name));
  const thead = h(doc, 'thead');
  thead.append(headRow);
  const tbody = h(doc, 'tbody');
  for (const row of rows) {
    const tr = h(doc, 'tr', `sb-art-row${ctx.ticked.has(row.id) ? ' is-ticked' : ''}${ctx.added?.has(row.id) ? ' sb-art-row-new' : ''}`);
    tr.setAttribute('data-row', row.id);
    const head = h(doc, 'td', 'sb-art-td is-first');
    const inner = h(doc, 'div', 'sb-art-first');
    inner.append(tickBox(ctx, row), rowHead(ctx, row));
    head.append(inner);
    if (ctx.gate?.unclear.has(row.id)) head.append(gateToggle(ctx, row));
    tr.append(head);
    if (ctx.gate?.keep.get(row.id) === false) tr.classList.add('is-gate-out');
    if (showsAbstract(ctx, grid)) tr.append(h(doc, 'td', 'sb-art-td', abstractLead(row.paper?.abstract ?? '')));
    else for (const column of grid.columns) {
      const td = h(doc, 'td', 'sb-art-td');
      td.append(renderCell(ctx, row.cells[column.id], row.id, column.id));
      tr.append(td);
    }
    ctx.radar?.mark(tr, row.paper);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

/**
 * Below 560 px: one card per row, the title line first, then each column as a label and a value.
 * @param {TableContext} ctx @param {Grid} grid @param {GridRow[]} rows
 */
export function renderCards(ctx, grid, rows) {
  const { doc } = ctx;
  const list = h(doc, 'div', 'sb-art-cardlist');
  for (const row of rows) {
    const card = h(doc, 'div', `sb-art-rowcard${ctx.ticked.has(row.id) ? ' is-ticked' : ''}${ctx.added?.has(row.id) ? ' sb-art-row-new' : ''}`);
    card.setAttribute('data-row', row.id);
    const top = h(doc, 'div', 'sb-art-first');
    top.append(tickBox(ctx, row), rowHead(ctx, row));
    card.append(top);
    if (ctx.gate?.unclear.has(row.id)) card.append(gateToggle(ctx, row));
    if (ctx.gate?.keep.get(row.id) === false) card.classList.add('is-gate-out');
    if (showsAbstract(ctx, grid)) {
      const field = h(doc, 'div', 'sb-art-field');
      field.append(h(doc, 'div', 'sb-art-field-label', 'Abstract summary'), h(doc, 'div', 'sb-art-cell', abstractLead(row.paper?.abstract ?? '')));
      card.append(field);
    } else for (const column of grid.columns) {
      const field = h(doc, 'div', 'sb-art-field');
      field.append(h(doc, 'div', 'sb-art-field-label', column.name), renderCell(ctx, row.cells[column.id], row.id, column.id));
      card.append(field);
    }
    ctx.radar?.mark(card, row.paper);
    list.append(card);
  }
  return list;
}
