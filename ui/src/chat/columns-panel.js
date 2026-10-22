// @ts-check
// ui-src/src/chat/columns-panel.js. The Columns panel (spec 007 §5.1, Elicit 9.22.23): "Search or create a column" (a
// plain line with an example), "Current columns" (instruction on hover, drag to reorder, × to remove), then the
// presets as quiet "+" rows. Picking a preset or typing a column stages it; "Fill N columns" asks the engine for an
// estimate and, when the step is big, shows the one-line confirm ("Fill 3 columns for 120 papers? About 15 turns.")
// with Continue / Only the first 50. The panel owns no engine calls: the artifact panel hands it `prepare` and `run`.
// It fills a box the caller provides, so the same content is a popover beside the toolbar or a full sheet when narrow.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { PRESETS, specFromPreset, specFromText } from './artifact-data.js';

/** @typedef {import("../../../agent/src/domain").ColumnSpec} ColumnSpec */
/**
 * @typedef {{ line: string, askFirst: boolean, maxRows: number }} Estimate
 * @typedef {{
 *   columns: ColumnSpec[],
 *   busy: boolean,
 *   noun: string,
 *   prepare: (specs: ColumnSpec[]) => Promise<Estimate>,
 *   run: (specs: ColumnSpec[], first: number | null) => Promise<void>,
 *   onRemove: (spec: ColumnSpec) => void,
 *   onReorder: (ids: string[]) => void,
 *   close: () => void,
 * }} ColumnsOptions
 */

/** @param {Document} doc @param {HTMLElement} box @param {ColumnsOptions} o */
export function fillColumns(doc, box, o) {
  box.classList.add('sb-col');
  let order = o.columns.map((c) => c.id);
  /** @type {ColumnSpec[]} */ let staged = [];
  let typed = '';
  /** @type {Estimate | null} */ let confirm = null;
  let working = false;
  const byId = () => new Map(o.columns.map((c) => [c.id, c]));
  const taken = () => [...o.columns.map((c) => c.id), ...staged.map((c) => c.id)];
  const has = (/** @type {string} */ name) => [...o.columns, ...staged].some((c) => c.name.toLowerCase() === name.toLowerCase());

  const paint = () => {
    box.replaceChildren();
    if (o.busy) {
      box.append(h(doc, 'div', 'sb-col-note', 'Filling in columns now. You can add more when it finishes.'));
      box.append(currentList());
      return;
    }
    box.append(searchBlock());
    if (staged.length) box.append(stagedBlock());
    const current = currentList();
    if (o.columns.length) box.append(current);
    box.append(presetList());
    if (staged.length) box.append(footer());
  };

  const searchBlock = () => {
    const block = h(doc, 'div', 'sb-col-search');
    block.append(h(doc, 'div', 'sb-col-label', 'Search or create a column'));
    block.append(h(doc, 'div', 'sb-col-help', 'Describe what you want pulled out of each paper, for example “sample size” or “what the authors say went wrong”.'));
    const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-col-input'));
    input.type = 'text';
    input.placeholder = 'e.g. Limitations, Survival time';
    input.value = typed;
    input.setAttribute('aria-label', 'Search or create a column');
    input.addEventListener('input', () => { typed = input.value; refreshLists(); });
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && typed.trim()) { event.preventDefault(); addTyped(); } });
    block.append(input);
    block.append(h(doc, 'div', 'sb-col-create'));
    // Promise, not queueMicrotask: Zotero's chrome window has no queueMicrotask global.
    Promise.resolve().then(refreshCreate);
    return block;
  };

  const addTyped = () => {
    const text = typed.trim();
    if (!text || has(specFromText(text, []).name)) { typed = ''; paint(); return; }
    staged.push(specFromText(text, taken()));
    typed = '';
    confirm = null;
    paint();
    /** @type {HTMLInputElement | null} */ (box.querySelector('.sb-col-input'))?.focus();
  };

  /** The “+ Add …” row that appears while there is text. */
  const refreshCreate = () => {
    const slot = box.querySelector('.sb-col-create');
    if (!slot) return;
    slot.replaceChildren();
    if (!typed.trim()) return;
    const add = h(doc, 'button', 'sb-col-row is-create');
    add.setAttribute('type', 'button');
    add.append(icon(doc, 'plus', 'sb-ai-icon'), h(doc, 'span', 'sb-col-row-text', `Add “${typed.trim()}”`));
    add.title = 'A new column that reads what you typed';
    add.addEventListener('click', addTyped);
    slot.append(add);
  };

  const refreshLists = () => {
    refreshCreate();
    const list = box.querySelector('.sb-col-presets');
    if (list) list.replaceWith(presetList());
  };

  const presetList = () => {
    const wrap = h(doc, 'div', 'sb-col-presets');
    const q = typed.trim().toLowerCase();
    const shown = PRESETS.filter((p) => !has(p.name) && (!q || p.name.toLowerCase().includes(q)));
    if (!shown.length) return wrap;
    wrap.append(h(doc, 'div', 'sb-col-head', 'Add columns'));
    for (const preset of shown) {
      const row = h(doc, 'button', 'sb-col-row is-preset');
      row.setAttribute('type', 'button');
      row.title = preset.instruction;
      row.append(icon(doc, 'plus', 'sb-ai-icon'), h(doc, 'span', 'sb-col-row-text', preset.name));
      row.addEventListener('click', () => { staged.push(specFromPreset(preset, taken())); confirm = null; typed = ''; paint(); });
      wrap.append(row);
    }
    return wrap;
  };

  const stagedBlock = () => {
    const wrap = h(doc, 'div', 'sb-col-staged');
    wrap.append(h(doc, 'div', 'sb-col-head', 'Ready to add'));
    for (const spec of staged) {
      const chip = h(doc, 'span', 'sb-col-chip');
      chip.title = spec.instruction;
      chip.append(h(doc, 'span', 'sb-col-chip-text', spec.name));
      const x = h(doc, 'button', 'sb-col-x');
      x.setAttribute('type', 'button');
      x.setAttribute('aria-label', `Don't add ${spec.name}`);
      x.append(icon(doc, 'close', 'sb-ai-icon'));
      x.addEventListener('click', () => { staged = staged.filter((c) => c !== spec); confirm = null; paint(); });
      chip.append(x);
      wrap.append(chip);
    }
    return wrap;
  };

  const currentList = () => {
    const wrap = h(doc, 'div', 'sb-col-current');
    if (!o.columns.length) return wrap;
    wrap.append(h(doc, 'div', 'sb-col-head', 'Current columns'));
    const spec = byId();
    let dragging = -1;
    const move = (/** @type {number} */ from, /** @type {number} */ to) => {
      if (to < 0 || to >= order.length || from === to) return;
      const next = [...order];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      order = next;
      o.onReorder(order);
    };
    order.forEach((id, index) => {
      const column = spec.get(id);
      if (!column) return;
      const row = h(doc, 'div', 'sb-col-item');
      row.draggable = true;
      row.title = column.instruction || column.name;
      const grip = h(doc, 'button', 'sb-col-grip');
      grip.setAttribute('type', 'button');
      grip.setAttribute('aria-label', `Move ${column.name}. Use the up and down arrow keys.`);
      grip.append(icon(doc, 'grip', 'sb-ai-icon'));
      grip.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        move(index, index + (event.key === 'ArrowUp' ? -1 : 1));
        paint();
        /** @type {HTMLElement | null} */ (box.querySelectorAll('.sb-col-grip')[Math.max(0, Math.min(order.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))])?.focus();
      });
      row.append(grip, h(doc, 'span', 'sb-col-item-name', column.name));
      if (!o.busy) {
        const x = h(doc, 'button', 'sb-col-x');
        x.setAttribute('type', 'button');
        x.setAttribute('aria-label', `Remove ${column.name}`);
        x.title = 'Remove this column';
        x.append(icon(doc, 'close', 'sb-ai-icon'));
        x.addEventListener('click', () => o.onRemove(column));
        row.append(x);
      }
      row.addEventListener('dragstart', (event) => { dragging = index; row.classList.add('is-dragging'); event.dataTransfer?.setData('text/plain', column.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
      row.addEventListener('dragover', (event) => { event.preventDefault(); });
      row.addEventListener('drop', (event) => { event.preventDefault(); if (dragging >= 0) { move(dragging, index); paint(); } dragging = -1; });
      wrap.append(row);
    });
    return wrap;
  };

  const footer = () => {
    const bar = h(doc, 'div', 'sb-col-foot');
    if (confirm) {
      const line = h(doc, 'div', 'sb-col-confirm', confirm.line);
      const actions = h(doc, 'div', 'sb-col-actions');
      const go = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-col-btn is-primary', 'Continue'));
      go.setAttribute('type', 'button');
      go.addEventListener('click', () => start(null));
      const first = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-col-btn', `Only the first ${confirm.maxRows}`));
      first.setAttribute('type', 'button');
      first.addEventListener('click', () => start(confirm?.maxRows ?? 50));
      const back = h(doc, 'button', 'sb-col-btn', 'Not now');
      back.setAttribute('type', 'button');
      back.addEventListener('click', () => { confirm = null; paint(); });
      actions.append(go, first, back);
      bar.append(line, actions);
      return bar;
    }
    const fill = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-col-btn is-primary sb-col-fill', `Fill ${staged.length === 1 ? '1 column' : `${staged.length} columns`}`));
    fill.setAttribute('type', 'button');
    fill.disabled = working;
    fill.addEventListener('click', async () => {
      working = true;
      fill.disabled = true;
      try {
        const estimate = await o.prepare(staged);
        working = false;
        if (estimate.askFirst) { confirm = estimate; paint(); } else await start(null);
      } catch { working = false; fill.disabled = false; }
    });
    bar.append(fill);
    return bar;
  };

  /** @param {number | null} first */
  const start = async (first) => {
    const specs = staged;
    try { await o.run(specs, first); o.close(); } catch { /* the caller has told the user */ }
  };

  paint();
}
