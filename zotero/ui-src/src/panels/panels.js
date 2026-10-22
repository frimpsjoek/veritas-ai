// @ts-check
// ui-src/src/panels/panels.js. The panel components of spec 005 D1, drawn to §4: content reads as text first; row
// actions and field outlines appear on hover or focus; one primary button per card, the rest quiet text buttons; one
// line of status. Plain DOM through `h()`, so the same code runs in Zotero's chrome documents and in Obsidian.
// Every root carries `sb-p` (the CSS scope that beats Obsidian's own button and input styles); class names are sb-p-*.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { badgeOf, isPaperPath, pillsFor, togglePill as togglePillState } from './data.js';
import { authorAvatar } from '../avatars.js';

/** @typedef {{ icon?: string, label: string, onClick: (event: MouseEvent) => void }} PanelAction */

/** A quiet text button (the default), or the card's one primary. Long labels wrap (Obsidian's buttons are nowrap).
 *  @param {Document} doc @param {string} label @param {(event: MouseEvent) => void} onClick
 *  @param {{ primary?: boolean, danger?: boolean, icon?: string, title?: string, disabled?: boolean }} [opts] */
export function Button(doc, label, onClick, opts = {}) {
  const button = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sb-p-btn${opts.primary ? ' is-primary' : ''}${opts.danger ? ' is-danger' : ''}`));
  button.setAttribute('type', 'button');
  if (opts.icon) button.append(icon(doc, opts.icon, 'sb-p-icon'));
  button.append(h(doc, 'span', 'sb-p-btn-text', label));
  if (opts.title) button.title = opts.title;
  button.disabled = Boolean(opts.disabled);
  button.addEventListener('click', (event) => { event.stopPropagation(); onClick(event); });
  return button;
}

/** A 24 px icon-only button (32 where there is no hover). @param {Document} doc @param {string} iconName @param {string} label @param {(event: MouseEvent) => void} onClick */
export function IconButton(doc, iconName, label, onClick) {
  const button = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-p-iconbtn'));
  button.setAttribute('type', 'button');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(doc, iconName, 'sb-p-icon'));
  button.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); onClick(event); });
  return button;
}

/** The one status line: loading, an error, or "nothing here". @param {Document} doc @param {'loading' | 'error' | 'empty' | 'info'} kind @param {string} text */
export function StateLine(doc, kind, text) {
  const line = h(doc, 'div', `sb-p-state is-${kind}`, text);
  if (kind === 'error') line.setAttribute('role', 'alert');
  else line.setAttribute('role', 'status');
  return line;
}

/** @param {Document} doc @param {PanelAction[]} actions */
function actionsBox(doc, actions) {
  const box = h(doc, 'span', 'sb-p-acts');
  for (const a of actions) box.append(IconButton(doc, a.icon ?? 'more', a.label, a.onClick));
  return box;
}

/**
 * A collapsible section: chevron, title, count; header actions (copy as links, ...) appear on hover or focus.
 * @param {Document} doc
 * @param {{ title: string, count?: number | null, actions?: PanelAction[], open?: boolean, empty?: string, onToggle?: (open: boolean) => void }} o
 */
export function Section(doc, o) {
  const el = h(doc, 'section', 'sb-p-section');
  const head = h(doc, 'div', 'sb-p-section-head');
  const toggle = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-p-section-toggle'));
  toggle.setAttribute('type', 'button');
  const chevron = icon(doc, 'chevron', 'sb-p-icon sb-p-chevron');
  const label = h(doc, 'span', 'sb-p-section-label', o.title);
  const count = h(doc, 'span', 'sb-p-count');
  toggle.append(chevron, label, count);
  head.append(toggle);
  if (o.actions?.length) head.append(actionsBox(doc, o.actions));
  const body = h(doc, 'div', 'sb-p-section-body');
  el.append(head, body);
  const setOpen = (/** @type {boolean} */ open) => {
    el.classList.toggle('is-closed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    body.hidden = !open;
  };
  const setCount = (/** @type {number | null | undefined} */ n) => { count.textContent = n ? String(n) : ''; };
  toggle.addEventListener('click', () => { const open = Boolean(body.hidden); setOpen(open); o.onToggle?.(open); });
  setCount(o.count);
  setOpen(o.open !== false);
  if (o.empty && !o.count) body.append(StateLine(doc, 'empty', o.empty));
  return { el, head, body, setCount, setOpen };
}

/**
 * One result row: title (with the paper / note icon and a PDF / Image badge), a meta line, an optional snippet, the
 * score bar for related items, and trailing content. Row actions are icon buttons that show on hover or focus.
 * `passages` are the sub-lines of a search hit (heading + snippet), each opening on its own.
 * @param {Document} doc
 * @param {{ title: string, meta?: string, path?: string, icon?: string, badge?: string | null, snippet?: string | Node,
 *   passages?: { heading?: string, snippet: string | Node, onOpen?: (event: MouseEvent | KeyboardEvent) => void }[],
 *   score?: { level: number, label: string, tip: string } | null, trailing?: Node | null, actions?: PanelAction[],
 *   onOpen?: (event: MouseEvent | KeyboardEvent) => void, tip?: string, selected?: boolean, wrapTitle?: boolean }} o
 */
export function Row(doc, o) {
  const el = h(doc, 'div', 'sb-p-row');
  const main = h(doc, 'div', 'sb-p-row-main');
  const titleEl = h(doc, 'div', 'sb-p-row-title');
  const kindIcon = o.icon ?? (o.path ? (isPaperPath(o.path) ? 'paper' : 'note') : null);
  // a note says who wrote it: you (a person) or an agent (the AI mark); papers keep the paper icon
  const author = kindIcon === 'note' && o.path ? authorAvatar(doc, o.path, 14) : null;
  if (author) { author.classList.add('sb-p-row-icon'); titleEl.append(author); } else if (kindIcon) titleEl.append(icon(doc, kindIcon, 'sb-p-icon sb-p-row-icon'));
  const badge = o.badge === undefined && o.path ? badgeOf(o.path) : o.badge;
  const text = h(doc, 'span', 'sb-p-row-text', o.title);
  if (badge && badge !== 'Zotero') titleEl.append(h(doc, 'span', 'sb-p-badge', badge));
  titleEl.append(text);
  main.append(titleEl);
  if (o.meta) main.append(h(doc, 'div', 'sb-p-row-meta', o.meta));
  if (o.score) {
    const score = h(doc, 'div', 'sb-p-score');
    const bar = h(doc, 'span', 'sb-p-score-bar');
    const fill = h(doc, 'span', 'sb-p-score-fill');
    fill.style.width = `${o.score.level * 20}%`;
    bar.append(fill);
    score.append(bar, h(doc, 'span', 'sb-p-score-label', o.score.label));
    score.title = o.score.tip;
    score.setAttribute('aria-label', o.score.tip);
    main.append(score);
  }
  if (o.snippet) {
    const snip = h(doc, 'div', 'sb-p-row-snippet');
    snip.append(o.snippet);
    main.append(snip);
  }
  /** @type {HTMLElement[]} */
  const passages = [];
  for (const p of o.passages ?? []) {
    const line = h(doc, 'div', 'sb-p-passage');
    if (p.heading) line.append(h(doc, 'div', 'sb-p-passage-heading', p.heading));
    const snip = h(doc, 'div', 'sb-p-row-snippet');
    snip.append(p.snippet);
    line.append(snip);
    if (p.onOpen) {
      const open = p.onOpen;
      line.classList.add('is-link');
      line.addEventListener('click', (event) => { event.stopPropagation(); open(event); });
    }
    passages.push(line);
    main.append(line);
  }
  el.append(main);
  if (o.trailing || o.actions?.length) {
    const side = h(doc, 'div', 'sb-p-row-side');
    if (o.trailing) side.append(o.trailing);
    if (o.actions?.length) side.append(actionsBox(doc, o.actions));
    el.append(side);
  }
  if (o.tip) el.title = o.tip;
  if (o.selected) el.classList.add('is-selected');
  if (o.onOpen) {
    const open = o.onOpen;
    el.classList.add('is-link');
    el.tabIndex = 0;
    el.addEventListener('click', (event) => open(event));
    el.addEventListener('keydown', (event) => {
      if (event.target === el && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(event); }
    });
  }
  return { el, main, titleEl, passages };
}

/** Segmented choice (Duplicates' kinds, Search's My library / Find new papers). @param {Document} doc
 *  @param {{ id: string, label: string, count?: number | null }[]} tabs @param {string} active @param {(id: string) => void} onPick */
export function Tabs(doc, tabs, active, onPick) {
  const el = h(doc, 'div', 'sb-p-tabs');
  el.setAttribute('role', 'tablist');
  for (const tab of tabs) {
    const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sb-p-tab${tab.id === active ? ' is-on' : ''}`));
    b.setAttribute('type', 'button');
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(tab.id === active));
    b.append(h(doc, 'span', 'sb-p-btn-text', tab.label));
    if (tab.count != null) b.append(h(doc, 'span', 'sb-p-count', String(tab.count)));
    b.addEventListener('click', () => onPick(tab.id));
    el.append(b);
  }
  return el;
}

/**
 * The search box with the two source pills (Papers, Notes) and a "More" popover for the finer source filter
 * (spec 005 §6). Reports every change through `onChange`; the host decides what to search.
 * @param {Document} doc
 * @param {{ placeholder: string, value?: string, papers?: boolean, notes?: boolean, specific?: string,
 *   options?: [string, string][], showPills?: boolean, onQuery: (query: string, immediate: boolean) => void,
 *   onScope: (scope: { papers: boolean, notes: boolean, specific: string }) => void }} o
 */
export function SearchBar(doc, o) {
  const el = h(doc, 'div', 'sb-p-searchbar');
  const box = h(doc, 'div', 'sb-p-searchbox');
  box.append(icon(doc, 'find', 'sb-p-icon'));
  const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sb-p-input'));
  input.type = 'search';
  input.placeholder = o.placeholder;
  input.value = o.value ?? '';
  input.setAttribute('aria-label', o.placeholder);
  box.append(input);
  el.append(box);
  input.addEventListener('input', () => o.onQuery(input.value, false));
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') o.onQuery(input.value, true); });

  const state = { papers: o.papers !== false, notes: o.notes !== false, specific: o.specific ?? '' };
  const row = h(doc, 'div', 'sb-p-pill-row');
  el.append(row);
  /** @type {HTMLButtonElement | null} */
  let more = null;
  let pop = /** @type {HTMLElement | null} */ (null);
  const closePop = () => { pop?.remove(); pop = null; more?.setAttribute('aria-expanded', 'false'); };
  const draw = () => {
    row.replaceChildren();
    if (o.showPills === false) return;
    for (const [key, label, iconName] of /** @type {['papers' | 'notes', string, string][]} */ ([['papers', 'Papers', 'paper'], ['notes', 'Notes', 'note']])) {
      const pill = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sb-p-pill${state[key] ? ' is-on' : ''}`));
      pill.setAttribute('type', 'button');
      pill.setAttribute('aria-pressed', String(state[key]));
      pill.title = key === 'papers' ? 'Search the Zotero library' : 'Search the Obsidian vault: notes, PDFs and images';
      pill.append(icon(doc, iconName, 'sb-p-icon'), h(doc, 'span', 'sb-p-btn-text', label));
      pill.addEventListener('click', () => {
        closePop();
        const next = togglePillState(state, key);
        Object.assign(state, next);
        draw();
        o.onScope({ ...state });
      });
      row.append(pill);
    }
    if (o.options?.length) {
      const chosen = o.options.find(([value]) => value && value === state.specific);
      more = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sb-p-more${chosen ? ' is-on' : ''}`));
      more.setAttribute('type', 'button');
      more.setAttribute('aria-haspopup', 'listbox');
      more.setAttribute('aria-expanded', 'false');
      more.append(h(doc, 'span', 'sb-p-btn-text', chosen ? chosen[1] : 'More'), icon(doc, 'chevron', 'sb-p-icon sb-p-more-chevron'));
      more.addEventListener('click', () => {
        if (pop) return closePop();
        openMore();
      });
      row.append(more);
    }
  };
  const openMore = () => {
    if (!more) return;
    pop = h(doc, 'div', 'sb-p-pop');
    pop.setAttribute('role', 'listbox');
    for (const [value, label] of o.options ?? []) {
      const item = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sb-p-pop-item${value === state.specific ? ' is-selected' : ''}`));
      item.setAttribute('type', 'button');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(value === state.specific));
      item.append(h(doc, 'span', 'sb-p-pop-check'), h(doc, 'span', 'sb-p-btn-text', label));
      if (value === state.specific) item.firstElementChild?.append(icon(doc, 'check', 'sb-p-icon'));
      item.addEventListener('click', () => {
        closePop();
        state.specific = value;
        Object.assign(state, value ? pillsFor(value) : { papers: true, notes: true });
        draw();
        o.onScope({ ...state });
      });
      pop.append(item);
    }
    row.append(pop);
    more.setAttribute('aria-expanded', 'true');
    const away = (/** @type {Event} */ event) => {
      const target = /** @type {Node} */ (event.target);
      if (pop && !pop.contains(target) && !more?.contains(target)) { closePop(); doc.removeEventListener('pointerdown', away, true); }
    };
    doc.addEventListener('pointerdown', away, true);
    pop.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); closePop(); more?.focus(); } });
    /** @type {HTMLElement | null} */ (pop.querySelector('.is-selected') ?? pop.firstElementChild)?.focus();
  };
  draw();
  return {
    el, input, state,
    /** Set the scope from outside (the host remembering it). @param {{ papers: boolean, notes: boolean, specific?: string }} scope */
    setScope(scope) { Object.assign(state, { specific: '' }, scope); draw(); },
    showPills(/** @type {boolean} */ on) { o.showPills = on; draw(); },
  };
}

/**
 * The paper header (Obsidian's Zotero tab, Zotero's paper-note tab): a kicker, the title at 20 px, authors with a
 * "+N more" link, a venue line, quiet chips (@citekey, DOI), and one row of actions of which only one is primary.
 * @param {Document} doc
 * @param {{ kicker?: string, title: string, authors?: string[], authorsShown?: number, venue?: string,
 *   chips?: { text: string, title?: string, href?: string, quiet?: boolean, onClick?: (event: MouseEvent) => void }[],
 *   actions?: { label: string, icon?: string, primary?: boolean, onClick: (event: MouseEvent) => void }[],
 *   openLink?: (url: string, opts?: { outside?: boolean }) => void }} o `openLink`: where a chip's web address goes (the host's, spec 015)
 */
export function PaperCard(doc, o) {
  const el = h(doc, 'header', 'sb-p-paper');
  if (o.kicker) el.append(h(doc, 'div', 'sb-p-kicker', o.kicker));
  el.append(h(doc, 'h1', 'sb-p-paper-title', o.title));
  if (o.authors?.length) {
    const shown = o.authorsShown ?? 8;
    const line = h(doc, 'div', 'sb-p-authors', o.authors.slice(0, shown).join(', '));
    if (o.authors.length > shown) {
      const more = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-p-linkbtn', ` +${o.authors.length - shown} more`));
      more.setAttribute('type', 'button');
      more.addEventListener('click', () => { line.textContent = /** @type {string[]} */ (o.authors).join(', '); });
      line.append(more);
    }
    el.append(line);
  }
  if (o.venue) el.append(h(doc, 'div', 'sb-p-venue', o.venue));
  if (o.chips?.length) {
    const chips = h(doc, 'div', 'sb-p-chips');
    for (const c of o.chips) {
      const chip = /** @type {HTMLElement} */ (c.href ? h(doc, 'a', 'sb-p-chip', c.text) : c.onClick ? h(doc, 'button', 'sb-p-chip', c.text) : h(doc, 'span', 'sb-p-chip', c.text));
      if (c.href) {
        chip.setAttribute('href', c.href); chip.setAttribute('rel', 'noopener');
        const url = c.href;
        chip.addEventListener('click', (event) => { if (!o.openLink) return; event.preventDefault(); o.openLink(url, /** @type {MouseEvent} */ (event).metaKey || /** @type {MouseEvent} */ (event).ctrlKey ? { outside: true } : undefined); });
      }
      if (c.onClick) { chip.setAttribute('type', 'button'); chip.addEventListener('click', c.onClick); }
      if (c.title) { chip.title = c.title; chip.setAttribute('aria-label', c.title); }
      if (c.quiet) chip.classList.add('is-quiet');
      chips.append(chip);
    }
    el.append(chips);
  }
  // the action row (and its rule) exists only once there is an action
  const bar = h(doc, 'div', 'sb-p-paper-actions');
  /** @param {{ label: string, icon?: string, primary?: boolean, onClick: (event: MouseEvent) => void }} a */
  const addAction = (a) => { if (!bar.isConnected) el.append(bar); const b = Button(doc, a.label, a.onClick, { primary: a.primary, icon: a.icon }); bar.append(b); return b; };
  for (const a of o.actions ?? []) addAction(a);
  return { el, bar, addAction };
}

/** A highlight the user made in a PDF: coloured edge, text, comment, page. @param {Document} doc
 *  @param {{ type?: string, text?: string, comment?: string, color?: string, page?: string, onContext?: (event: MouseEvent) => void }} o */
export function Highlight(doc, o) {
  const el = h(doc, 'div', `sb-p-highlight${o.type === 'underline' ? ' is-underline' : ''}`);
  if (o.color) el.style.setProperty('--sb-ui-hl', o.color);
  if (o.text) el.append(h(doc, 'div', 'sb-p-highlight-text', o.text));
  if (o.comment) el.append(h(doc, 'div', 'sb-p-highlight-comment', o.comment));
  if (o.page) el.append(h(doc, 'div', 'sb-p-highlight-page', `p. ${o.page}`));
  if (o.onContext) el.addEventListener('contextmenu', o.onContext);
  return el;
}

/** A thin progress bar; indeterminate when `fraction` is null. @param {Document} doc @param {number | null} fraction @param {{ small?: boolean }} [o] */
export function Progress(doc, fraction, o = {}) {
  const bar = h(doc, 'div', `sb-p-progress${o.small ? ' is-small' : ''}${fraction == null ? ' is-indeterminate' : ''}`);
  bar.setAttribute('role', 'progressbar');
  const fill = h(doc, 'div', 'sb-p-progress-fill');
  if (fraction != null) {
    const pct = Math.max(0, Math.min(100, fraction * 100));
    fill.style.width = `${pct}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  }
  bar.append(fill);
  return bar;
}

/**
 * The index at a glance (Obsidian's Search index view, Zotero's local model state): one status line with a dot, a
 * progress bar while something runs, a few quiet detail lines, the actions (one primary), and an optional table of
 * counts per source with how much is searchable by meaning. `render()` replaces the content in place, so a 2 s poll
 * keeps the same root.
 * @typedef {{ state: 'running' | 'idle' | 'error' | 'off', label: string, progress?: { done: number, total: number } | null,
 *   lines?: string[], actions?: { label: string, primary?: boolean, danger?: boolean, onClick: (event: MouseEvent) => void, disabled?: boolean }[],
 *   rows?: { label: string, count: number, pct: number }[], notes?: string[], compact?: boolean }} StatusSpec
 * @param {Document} doc @param {StatusSpec} [spec]
 */
export function StatusPanel(doc, spec) {
  const el = h(doc, 'div', 'sb-p-status');
  /** @param {StatusSpec} s */
  const render = (s) => {
    el.replaceChildren();
    el.classList.toggle('is-compact', Boolean(s.compact));
    const head = h(doc, 'div', 'sb-p-status-head');
    head.append(h(doc, 'span', `sb-p-dot is-${s.state}`), h(doc, 'span', 'sb-p-status-label', s.label));
    el.append(head);
    if (s.state === 'running') el.append(Progress(doc, s.progress && s.progress.total > 0 ? s.progress.done / s.progress.total : null));
    for (const line of s.lines ?? []) el.append(h(doc, 'div', 'sb-p-meta', line));
    if (s.actions?.length) {
      const bar = h(doc, 'div', 'sb-p-status-actions');
      for (const a of s.actions) bar.append(Button(doc, a.label, a.onClick, { primary: a.primary, danger: a.danger, disabled: a.disabled }));
      el.append(bar);
    }
    if (s.rows?.length) {
      const table = h(doc, 'div', 'sb-p-coverage');
      const header = h(doc, 'div', 'sb-p-coverage-row is-head');
      for (const t of ['Source', 'Items', 'Searchable by meaning']) header.append(h(doc, 'span', '', t));
      table.append(header);
      for (const r of s.rows) {
        const row = h(doc, 'div', 'sb-p-coverage-row');
        row.append(h(doc, 'span', 'sb-p-coverage-name', r.label), h(doc, 'span', 'sb-p-num', r.count.toLocaleString()));
        const cell = h(doc, 'span', 'sb-p-coverage-cell');
        cell.append(Progress(doc, r.pct / 100, { small: true }), h(doc, 'span', 'sb-p-num', `${r.pct}%`));
        row.append(cell);
        table.append(row);
      }
      el.append(table);
    }
    for (const note of s.notes ?? []) el.append(h(doc, 'div', 'sb-p-meta', note));
  };
  if (spec) render(spec);
  return { el, render };
}

/** A small heading inside a section ("Cites this paper", an attachment's name). @param {Document} doc @param {string} text */
export function Subhead(doc, text) { return h(doc, 'div', 'sb-p-subhead', text); }

/** A labelled run of quiet chips (collections, tags). @param {Document} doc @param {string} label @param {string[]} items */
export function ChipRow(doc, label, items) {
  const row = h(doc, 'div', 'sb-p-chips');
  row.append(h(doc, 'span', 'sb-p-meta', label));
  for (const item of items) row.append(h(doc, 'span', 'sb-p-chip is-quiet', item));
  return row;
}
