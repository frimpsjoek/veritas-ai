// @ts-check
// ui-src/src/chat/filters-popover.js. The Filters popover (spec 007 §5.3, Elicit 9.22.31): Cancel / Apply, then one
// section per filter, each drawn ONLY when the rows carry the data it needs (hidden, never greyed out): Has PDF,
// Publication date (a year range), Study type (the values present), Abstract contains / does not contain (several
// words each), In library / outside, Screening (when the set was screened) and Column value. Journal quality is not
// built: no source we call gives quartiles. It edits a copy and hands the result to `onApply`, so Cancel changes nothing.
import { h } from '../dom.js';
import { STUDY_TYPE_NAMES, SCREEN_NAMES, cleanFilters } from './artifact-data.js';

/** @typedef {import("./artifact-data.js").Filters} Filters */

/**
 * @param {Document} doc @param {HTMLElement} box
 * @param {{ options: ReturnType<typeof import("./artifact-data.js").filterOptions>, filters: Filters, apply: (filters: Filters) => void, close: () => void }} o
 */
export function fillFilters(doc, box, o) {
  box.classList.add('sb-flt');
  /** @type {Filters} */
  const draft = JSON.parse(JSON.stringify(cleanFilters(o.filters))) // plain data; Zotero's bundle scope has no structuredClone;
  const { options } = o;

  const section = (/** @type {string} */ title) => {
    const sec = h(doc, 'div', 'sb-flt-sec');
    sec.append(h(doc, 'div', 'sb-flt-title', title));
    box.append(sec);
    return sec;
  };
  const check = (/** @type {string} */ label, /** @type {boolean} */ on, /** @type {(v: boolean) => void} */ set, /** @type {string} */ cls = '') => {
    const row = h(doc, 'label', `sb-flt-check ${cls}`.trim());
    const input = /** @type {HTMLInputElement} */ (h(doc, 'input'));
    input.type = 'checkbox';
    input.checked = on;
    input.addEventListener('change', () => set(input.checked));
    row.append(input, h(doc, 'span', '', label));
    return row;
  };

  const head = h(doc, 'div', 'sb-flt-head');
  const cancel = h(doc, 'button', 'sb-flt-btn', 'Cancel');
  cancel.setAttribute('type', 'button');
  cancel.addEventListener('click', o.close);
  const apply = h(doc, 'button', 'sb-flt-btn is-primary', 'Apply');
  apply.setAttribute('type', 'button');
  apply.addEventListener('click', () => { o.apply(cleanFilters(draft)); o.close(); });
  head.append(cancel, apply);
  box.append(head);

  if (options.hasPdf) {
    const sec = section('Full text');
    sec.append(check('Has a PDF or full text', Boolean(draft.hasPdf), (v) => { draft.hasPdf = v; }, 'is-toggle'));
  }

  if (options.years) {
    const sec = section('Publication date');
    const row = h(doc, 'div', 'sb-flt-years');
    const field = (/** @type {string} */ label, /** @type {"yearFrom" | "yearTo"} */ key, /** @type {number} */ hint) => {
      const wrap = h(doc, 'label', 'sb-flt-field');
      const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-flt-input'));
      input.type = 'text';
      input.inputMode = 'numeric';
      input.placeholder = String(hint);
      input.setAttribute('aria-label', `${label} (year)`);
      input.value = draft[key] != null ? String(draft[key]) : '';
      input.addEventListener('input', () => {
        const n = Number.parseInt(input.value, 10);
        if (Number.isFinite(n) && n >= 1000 && n <= 3000) draft[key] = n; else delete draft[key];
      });
      wrap.append(h(doc, 'span', 'sb-flt-sub', label), input);
      return wrap;
    };
    row.append(field('From', 'yearFrom', options.years.min), field('To', 'yearTo', options.years.max));
    sec.append(row);
  }

  if (options.studyTypes.length) {
    const sec = section('Study type');
    const chosen = new Set(draft.studyTypes ?? []);
    for (const t of options.studyTypes) {
      sec.append(check(/** @type {any} */ (STUDY_TYPE_NAMES)[t] ?? t, chosen.has(t), (v) => {
        if (v) chosen.add(t); else chosen.delete(t);
        draft.studyTypes = [...chosen];
      }));
    }
  }

  if (options.abstract) {
    const sec = section('Abstract keywords');
    for (const [key, label, placeholder] of /** @type {const} */ ([['contains', 'Abstract contains', 'Contains'], ['excludes', 'Abstract does not contain', 'Does not contain']])) {
      sec.append(h(doc, 'div', 'sb-flt-sub', label));
      const line = h(doc, 'div', 'sb-flt-add');
      const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-flt-input'));
      input.type = 'text';
      input.placeholder = placeholder;
      input.setAttribute('aria-label', label);
      const add = h(doc, 'button', 'sb-flt-btn', 'Add');
      add.setAttribute('type', 'button');
      const words = h(doc, 'div', 'sb-flt-words');
      const paintWords = () => {
        words.replaceChildren();
        for (const w of draft[key] ?? []) {
          const pill = h(doc, 'span', 'sb-flt-word');
          pill.append(h(doc, 'span', '', w));
          const x = h(doc, 'button', 'sb-flt-word-x', '×');
          x.setAttribute('type', 'button');
          x.setAttribute('aria-label', `Remove ${w}`);
          x.addEventListener('click', () => { draft[key] = (draft[key] ?? []).filter((v) => v !== w); paintWords(); });
          pill.append(x);
          words.append(pill);
        }
      };
      const take = () => {
        const text = input.value.trim().replace(/\s+/g, ' ');
        if (text && !(draft[key] ?? []).some((v) => v.toLowerCase() === text.toLowerCase())) draft[key] = [...(draft[key] ?? []), text];
        input.value = '';
        paintWords();
      };
      add.addEventListener('click', take);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); take(); } });
      line.append(input, add);
      sec.append(line, words);
      paintWords();
    }
  }

  if (options.library) {
    const sec = section('Where it is');
    for (const [value, label] of /** @type {const} */ ([[null, 'Anywhere'], ['in', 'In my library'], ['out', 'Outside my library']])) {
      const row = h(doc, 'label', 'sb-flt-check');
      const input = /** @type {HTMLInputElement} */ (h(doc, 'input'));
      input.type = 'radio';
      input.name = 'sb-flt-library';
      input.checked = (draft.library ?? null) === value;
      input.addEventListener('change', () => { if (value) draft.library = value; else delete draft.library; });
      row.append(input, h(doc, 'span', '', label));
      sec.append(row);
    }
  }

  if (options.screening) {
    const sec = section('Screening');
    const chosen = new Set(draft.screening ?? []);
    for (const [value, label] of Object.entries(SCREEN_NAMES)) {
      sec.append(check(label, chosen.has(value), (v) => { if (v) chosen.add(value); else chosen.delete(value); draft.screening = [...chosen]; }));
    }
  }

  if (options.columns.length) {
    const sec = section('Column value');
    const pick = /** @type {HTMLSelectElement} */ (h(doc, 'select', 'sb-flt-input'));
    pick.setAttribute('aria-label', 'Column');
    for (const c of options.columns) { const opt = /** @type {HTMLOptionElement} */ (h(doc, 'option', '', c.name)); opt.value = c.id; pick.append(opt); }
    pick.value = draft.column?.id ?? options.columns[0].id;
    const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-flt-input'));
    input.type = 'text';
    input.placeholder = 'Contains…';
    input.setAttribute('aria-label', 'Column contains');
    input.value = draft.column?.text ?? '';
    const set = () => { if (input.value.trim()) draft.column = { id: pick.value, text: input.value }; else delete draft.column; };
    pick.addEventListener('change', set);
    input.addEventListener('input', set);
    sec.append(pick, input);
  }
}
