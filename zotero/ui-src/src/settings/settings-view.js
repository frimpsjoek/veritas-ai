// @ts-check
// ui-src/src/settings/settings-view.js (spec 016 U2). SettingsView(host, doc, mount): the one Settings, drawn from
// settings-schema.js. A list of sections with "Search settings" on top, and on the right plain rows (a label, one
// grey sentence, the control), no boxes. Below ~560 px of its own width the sections become a scrolling strip along
// the top. Which rows exist for this app and what is switched on live in the schema; this file only draws.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { ROWS, SECTIONS, readRow, rowAllowed, rowApplies, sidebarSections, visibleSections, writeRow } from './settings-schema.js';
import { mcpWidget, openalexKeyWidget } from './settings-widgets.js';
import { modelsWidget } from './models-widget.js';
import { sourcesWidget } from './sources-widget.js';

/**
 * @typedef {import("./settings-schema.js").SettingsRow} SettingsRow
 * @typedef {{
 *   renderers?: Record<string, (row: SettingsRow, ctx: { doc: Document, host: any, select: (section: string) => void }) => HTMLElement>,
 *   actions?: Record<string, (row: SettingsRow, say: (text: string) => void) => void | string | Promise<void | string>>,
 *   section?: string, platform?: "desktop" | "mobile",
 *   onChange?: (row: SettingsRow, value: unknown) => void,
 * }} SettingsOptions
 */

/** @param {any} host @param {Document} doc @param {HTMLElement} mount @param {SettingsOptions} [options] */
export function SettingsView(host, doc, mount, options = {}) {
  const kind = /** @type {import("./settings-schema.js").SettingsHost} */ (host.kind);
  const platform = options.platform ?? 'desktop';
  /** @type {Record<string, (row: SettingsRow, ctx: { doc: Document, host: any, select: (section: string) => void }) => HTMLElement>} */
  const renderers = {
    models: (_row, ctx) => modelsWidget(ctx.doc, ctx.host, { select: ctx.select }),
    openalexKey: (_row, ctx) => openalexKeyWidget(ctx.doc, ctx.host),
    mcp: (_row, ctx) => mcpWidget(ctx.doc, ctx.host),
    sourcesChips: (_row, ctx) => {
      const radar = ROWS.find((r) => r.id === 'sources.radar');
      const link = options.renderers?.radarLink;
      return sourcesWidget(ctx.doc, ctx.host, { select: ctx.select, radarFeeds: link && radar ? () => link(radar, ctx) : undefined });
    },
    ...options.renderers,
  };
  const actions = options.actions ?? {};
  /** Rows this host has what it needs to draw: a row with `needs` wants that capability in `host.can`, a custom row its
   *  renderer, an action row its handler. */
  const supports = (/** @type {SettingsRow} */ row) => rowAllowed(row, host.can)
    && (row.kind === 'custom' ? Boolean(renderers[row.custom ?? '']) : row.kind === 'action' ? Boolean(actions[row.action ?? '']) : true);

  const state = { prefs: host.prefs, /** @type {any} */ settings: {} };
  let section = options.section && sidebarSections(kind, platform, supports).some((s) => s.id === options.section) ? options.section : (sidebarSections(kind, platform, supports)[0]?.id ?? 'general');
  let query = '';
  /** @type {Record<string, boolean>} */
  const advanced = {};
  let engineError = false;

  /** @param {string} id */
  const goTo = (id) => { if (SECTIONS.some((s) => s.id === id)) { query = ''; search.value = ''; section = id; paint(); } };

  const root = h(doc, 'div', 'sbs');
  const side = h(doc, 'nav', 'sbs-side');
  side.setAttribute('aria-label', 'Settings sections');
  const search = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbs-search'));
  search.type = 'search';
  search.placeholder = 'Search settings';
  search.setAttribute('aria-label', 'Search settings');
  const nav = h(doc, 'div', 'sbs-nav');
  side.append(search, nav);
  const pane = h(doc, 'div', 'sbs-pane');
  const frame = h(doc, 'div', 'sbs-frame');
  frame.append(side, pane);
  root.append(frame);
  mount.replaceChildren(root);

  const paintNav = () => {
    nav.replaceChildren();
    for (const s of sidebarSections(kind, platform, supports)) {
      const item = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbs-nav-item'));
      item.type = 'button';
      item.dataset.section = s.id;
      item.append(icon(doc, s.icon, 'sbs-icon'), h(doc, 'span', 'sbs-nav-label', s.label));
      const on = !query && s.id === section;
      item.classList.toggle('is-active', on);
      if (on) item.setAttribute('aria-current', 'page');
      item.addEventListener('click', () => { query = ''; search.value = ''; section = s.id; paint(); });
      nav.append(item);
    }
  };

  /** @param {SettingsRow} row */
  const saveRow = async (row, /** @type {unknown} */ value, /** @type {HTMLElement} */ note) => {
    const write = writeRow(row, value);
    if (!write) {
      const range = row.min != null && row.max != null ? ` from ${row.min} to ${row.max}` : row.min != null ? ` of ${row.min} or more` : '';
      note.textContent = `Enter a number${range}.`;
      return false;
    }
    try {
      if ('prefs' in write) {
        const [key, v] = write.prefs;
        host.prefs.set(key, v);
        options.onChange?.(row, v);
      } else {
        state.settings = await (await host.ai()).settings.update(write.engine);
      }
      note.textContent = '';
      return true;
    } catch (error) {
      host.logError?.(error);
      note.textContent = "Couldn't save that.";
      return false;
    }
  };

  /** @param {SettingsRow} row */
  const control = (row, /** @type {HTMLElement} */ note, /** @type {() => void} */ redraw) => {
    const value = readRow(row, state);
    const commit = async (/** @type {unknown} */ v) => { if (await saveRow(row, v, note)) redraw(); };
    switch (row.kind) {
      case 'toggle': {
        const label = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbs-switch'));
        const box = /** @type {HTMLInputElement} */ (h(doc, 'input'));
        box.type = 'checkbox';
        box.checked = Boolean(value);
        box.setAttribute('role', 'switch');
        box.setAttribute('aria-label', row.label);
        box.addEventListener('change', () => void saveRow(row, box.checked, note).then((ok) => { if (!ok) box.checked = !box.checked; else redraw(); }));
        label.append(box, h(doc, 'span', 'sbs-switch-track'));
        return label;
      }
      case 'select': {
        const select = /** @type {HTMLSelectElement} */ (h(doc, 'select', 'sbs-select'));
        select.setAttribute('aria-label', row.label);
        for (const [v, text] of row.options ?? []) { const o = /** @type {HTMLOptionElement} */ (h(doc, 'option', '', text)); o.value = v; select.append(o); }
        select.value = String(value);
        select.addEventListener('change', () => void commit(row.numeric ? Number(select.value) : select.value));
        return select;
      }
      case 'radio': {
        const group = h(doc, 'div', 'sbs-radios');
        group.setAttribute('role', 'radiogroup');
        group.setAttribute('aria-label', row.label);
        for (const [v, text] of row.options ?? []) {
          const choice = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbs-radio'));
          const radio = /** @type {HTMLInputElement} */ (h(doc, 'input'));
          radio.type = 'radio';
          radio.name = `sbs-${row.id}`;
          radio.value = v;
          radio.checked = v === value;
          radio.addEventListener('change', () => { if (radio.checked) void commit(v); });
          choice.append(radio, h(doc, 'span', '', text));
          group.append(choice);
        }
        return group;
      }
      case 'lines': {
        const area = /** @type {HTMLTextAreaElement} */ (h(doc, 'textarea', 'sbs-input is-wide'));
        area.rows = 3;
        area.setAttribute('aria-label', row.label);
        area.value = Array.isArray(value) ? value.join('\n') : '';
        area.addEventListener('change', () => void saveRow(row, area.value, note));
        return area;
      }
      case 'text': case 'password': case 'number': {
        const input = /** @type {HTMLInputElement} */ (h(doc, 'input', `sbs-input${row.kind === 'number' ? ' is-number' : ''}`));
        input.type = row.kind === 'number' ? 'number' : row.kind;
        input.autocomplete = 'off';
        input.setAttribute('aria-label', row.label);
        if (row.placeholder) input.placeholder = row.placeholder;
        if (row.kind === 'number') { if (row.min != null) input.min = String(row.min); if (row.max != null) input.max = String(row.max); }
        // a password is never shown back
        input.value = row.kind === 'password' ? '' : value == null ? '' : String(value);
        if (row.kind === 'password' && state.prefs.get(row.key ?? '')) input.placeholder = 'Saved. Type to replace.';
        input.addEventListener('change', () => {
          if (row.kind === 'password' && !input.value.trim() && state.prefs.get(row.key ?? '')) return;
          void commit(input.value).then(() => { if (row.kind === 'password') input.value = ''; });
        });
        return input;
      }
      case 'action': {
        const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', row.buttonLabel ?? row.label));
        b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const say = (/** @type {string} */ text) => { note.textContent = text; };
            const result = await actions[row.action ?? '']?.(row, say);
            if (typeof result === 'string') say(result);
          } catch (error) { host.logError?.(error); note.textContent = String(/** @type {any} */ (error)?.message ?? error); }
          b.disabled = false;
        });
        return b;
      }
      case 'placeholder': return h(doc, 'p', 'sbs-placeholder', row.placeholder ?? row.label);
      case 'custom': return renderers[row.custom ?? '']?.(row, { doc, host, select: goTo }) ?? h(doc, 'span');
      default: return h(doc, 'span');
    }
  };

  /** @param {SettingsRow} row */
  const rowEl = (row) => {
    const el = h(doc, 'div', 'sbs-row');
    el.dataset.row = row.id;
    const stacked = row.kind === 'lines' || row.kind === 'custom' || row.kind === 'radio' || row.kind === 'placeholder';
    el.classList.toggle('is-stacked', stacked);
    const redraw = () => { const fresh = rowEl(row); el.replaceWith(fresh); };
    const text = h(doc, 'div', 'sbs-text');
    const note = h(doc, 'p', 'sbs-note');
    note.setAttribute('role', 'status');
    // custom rows carry their own label inside; placeholders show their line as the control
    el.classList.toggle('is-bare', !row.label);
    if (row.label) text.append(h(doc, 'span', 'sbs-label', row.label));
    if (row.help) text.append(h(doc, 'span', 'sbs-help', row.help));
    const ctl = h(doc, 'div', 'sbs-control');
    ctl.append(control(row, note, redraw));
    if (row.def !== undefined && row.store !== 'none' && row.kind !== 'password') {
      const current = readRow(row, state);
      if (current !== row.def && !(current == null && row.def == null)) {
        const reset = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbs-reset', 'Reset to default'));
        reset.type = 'button';
        reset.addEventListener('click', async () => {
          const write = await saveRow(row, row.def ?? '', note);
          if (write) redraw();
        });
        ctl.append(reset);
      }
    }
    if (row.label || row.help) el.append(text);
    el.append(ctl, note);
    return el;
  };

  const paint = () => {
    paintNav();
    pane.replaceChildren();
    const groups = visibleSections({ host: kind, platform, query, section, advanced, supports });
    if (engineError && ROWS.some((r) => r.store === 'engine')) pane.append(h(doc, 'p', 'sbs-banner', "Couldn't reach the Second Brain server, so some values show their defaults."));
    if (query && !groups.length) pane.append(h(doc, 'p', 'sbs-empty', `Nothing matches "${query}".`));
    for (const { section: s, rows, hiddenAdvanced } of groups) {
      const group = h(doc, 'section', 'sbs-group');
      group.dataset.section = s.id;
      group.append(h(doc, 'h2', 'sbs-title', s.label));
      for (const row of rows) group.append(rowEl(row));
      const hasAdvanced = ROWS.some((r) => r.section === s.id && r.advanced && rowApplies(r, kind, platform) && supports(r));
      if (!query && hasAdvanced) {
        const toggle = /** @type {HTMLLabelElement} */ (h(doc, 'label', 'sbs-advanced'));
        const box = /** @type {HTMLInputElement} */ (h(doc, 'input'));
        box.type = 'checkbox';
        box.setAttribute('role', 'switch');
        box.checked = Boolean(advanced[s.id]);
        box.addEventListener('change', () => { advanced[s.id] = box.checked; paint(); });
        toggle.append(box, h(doc, 'span', 'sbs-switch-track'), h(doc, 'span', 'sbs-advanced-label', 'Show advanced'));
        if (!box.checked && hiddenAdvanced) toggle.append(h(doc, 'span', 'sbs-help', `${hiddenAdvanced} more`));
        group.append(toggle);
      }
      pane.append(group);
    }
    pane.scrollTop = 0;
  };

  search.addEventListener('input', () => { query = search.value; paint(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; query = ''; paint(); } });
  paint();

  // engine values arrive after the first paint; the rows show their defaults until then
  if (ROWS.some((r) => r.store === 'engine' && rowApplies(r, kind, platform))) {
    Promise.resolve().then(() => host.ai()).then((ai) => ai.settings.get()).then((settings) => {
      state.settings = settings;
      paint();
    }).catch((error) => { host.logError?.(error); engineError = true; paint(); });
  }

  return {
    root,
    /** Go to a section (or none: stays). @param {string} id */
    select: goTo,
    /** @param {string} text */
    search(text) { search.value = text; query = text; paint(); },
  };
}
