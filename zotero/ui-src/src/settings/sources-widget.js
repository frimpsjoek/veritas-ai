// @ts-check
// ui-src/src/settings/sources-widget.js. The Sources chips row of Settings (custom: 'sourcesChips'), drawn from
// sourcesModel() in sources-model.js: three groups of toggle chips, each with a small ring, and a "…" menu for the
// advanced things (outside servers and trust, the OpenAlex key, radar feeds, index status). A click writes through
// chipWrite() and then repaints from fresh reads, so the chip never shows a state the engine doesn't hold.
import { h, SVG_NS } from '../dom.js';
import { sourcesModel, chipWrite, MENU } from './sources-model.js';
import { mcpWidget, openalexKeyWidget } from './settings-widgets.js';

/** @typedef {import("./sources-model.js").SourceChip} SourceChip */
/** @typedef {import("./sources-model.js").SourceRing} SourceRing */

const RING = 56;
const STROKE = 8;
const RADIUS = (RING - STROKE) / 2;
const CIRCLE = 2 * Math.PI * RADIUS;
const PANEL_TITLES = { outsideServers: 'Outside sources and trust', openalexKey: 'OpenAlex key' };

/** @param {Document} doc @param {string} tag @param {Record<string, string>} attrs */
function svg(doc, tag, attrs) {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** One arc per segment around the circle; a lit arc takes the accent, an unlit one the track colour.
 *  @param {Document} doc @param {SourceRing} ring */
function ringSvg(doc, ring) {
  const root = svg(doc, 'svg', { class: 'sbs-ring', width: String(RING), height: String(RING), viewBox: `0 0 ${RING} ${RING}`, 'aria-hidden': 'true' });
  /** @type {{ weight: number, on: boolean }[]} */
  const parts = ring.kind === 'share'
    ? ring.segments.filter((s) => s.passages > 0).map((s) => ({ weight: s.passages, on: s.on }))
    : Array.from({ length: ring.total }, (_, i) => ({ weight: 1, on: i < ring.on }));
  const total = parts.reduce((a, p) => a + p.weight, 0) || 1;
  // a gap between arcs, but never so wide that a tiny arc vanishes
  const gap = parts.length > 1 ? Math.min(3, CIRCLE / parts.length / 4) : 0;
  let offset = 0;
  for (const part of parts) {
    const length = Math.max((part.weight / total) * CIRCLE - gap, 0.5);
    root.append(svg(doc, 'circle', {
      class: `sbs-ring-arc${part.on ? ' is-lit' : ''}`, cx: String(RING / 2), cy: String(RING / 2), r: String(RADIUS), fill: 'none', 'stroke-width': String(STROKE),
      'stroke-dasharray': `${length.toFixed(2)} ${(CIRCLE - length).toFixed(2)}`, 'stroke-dashoffset': String((-offset).toFixed(2)),
      transform: `rotate(-90 ${RING / 2} ${RING / 2})`,
    }));
    offset += (part.weight / total) * CIRCLE;
  }
  const text = svg(doc, 'text', { class: 'sbs-ring-center', x: String(RING / 2), y: String(RING / 2), 'text-anchor': 'middle', 'dominant-baseline': 'central' });
  text.textContent = ring.center;
  root.append(text);
  return root;
}

/**
 * @param {Document} doc
 * @param {any} host
 * @param {{ select: (section: string) => void, radarFeeds?: () => (HTMLElement | void) }} opts
 * @returns {HTMLElement}
 */
export function sourcesWidget(doc, host, opts) {
  const root = h(doc, 'div', 'sbs-sources');
  const head = h(doc, 'div', 'sbs-src-top');
  const intro = h(doc, 'p', 'sbs-help', 'Where new chats and reports look. Tap to turn one on or off.');
  const menu = /** @type {HTMLDetailsElement} */ (h(doc, 'details', 'sbs-src-menu'));
  const summary = h(doc, 'summary', 'sbs-src-more', '…');
  summary.setAttribute('role', 'button');
  summary.setAttribute('aria-label', 'More about sources');
  summary.setAttribute('aria-haspopup', 'menu');
  summary.setAttribute('aria-expanded', 'false');
  const menuList = h(doc, 'div', 'sbs-src-menu-list');
  menuList.setAttribute('role', 'menu');
  menu.append(summary, menuList);
  head.append(intro, menu);
  const panelBox = h(doc, 'div', 'sbs-src-panelbox');
  const body = h(doc, 'div', 'sbs-src-body');
  const note = h(doc, 'p', 'sbs-src-live');
  note.setAttribute('role', 'status');
  root.append(head, panelBox, body, note);

  /** @type {{ status: any, settings: any, mcp: any, routines: any }} */
  let data = { status: null, settings: null, mcp: null, routines: null };
  // Until the first reads answer there is nothing to say about counts, errors or empty lists, and no saved state to click on.
  let settingsKnown = false;
  let pending = true;
  const busy = new Set();
  /** @type {string | null} */
  let panel = null;

  // A confirmation is not an error: the error line keeps the danger colour of .sbs-note.
  const say = (/** @type {string} */ text, bad = false) => { note.className = bad ? 'sbs-note' : 'sbs-src-live'; note.textContent = text; };
  const fail = (/** @type {unknown} */ error, /** @type {string} */ text) => { host.logError?.(error); say(text, true); host.notice?.(text); };

  /** Each read may fail on its own (Zotero standalone has no search server); the view draws what it has. */
  async function load() {
    const ai = await Promise.resolve().then(() => host.ai()).catch((e) => { host.logError?.(e); return null; });
    const safe = (/** @type {() => Promise<any>} */ f) => Promise.resolve().then(f).catch(() => null);
    const reads = {
      status: safe(() => host.json('/status')), settings: safe(() => ai.settings.get()),
      mcp: safe(() => ai.mcp.list()), routines: safe(() => ai.routines.list()),
    };
    // saved settings first: the switches can draw (and be clicked) before the slower reads answer
    if (!settingsKnown) {
      data.settings = await reads.settings;
      settingsKnown = true;
      paint();
    }
    const [status, settings, mcp, routines] = await Promise.all([reads.status, reads.settings, reads.mcp, reads.routines]);
    data = { status, settings, mcp, routines };
    pending = false;
  }

  /** @param {SourceChip} chip */
  async function flip(chip) {
    const write = chipWrite(chip, { settings: data.settings, mcpReport: data.mcp });
    if (!write || busy.has(chip.id) || !settingsKnown) return;
    busy.add(chip.id);
    say('');
    paint();
    try {
      const ai = await host.ai();
      if (write.kind === 'engine') await ai.settings.update(write.patch);
      else if (write.kind === 'mcp') await ai.mcp.save(write.config);
      else await ai.routines[write.action](write.id);
      await load();
      // an engine from before `sources` drops the write and reads back unchanged
      if (write.kind === 'engine' && write.patch.sources && data.settings && data.settings.sources == null) {
        say(`${chip.label} can't be changed until the Second Brain engine is updated.`, true);
        return;
      }
      say(`${chip.label} turned ${chip.on ? 'off' : 'on'}`);
    } catch (error) {
      fail(error, `Couldn't change ${chip.label}. Try again.`);
    } finally {
      busy.delete(chip.id);
      paint();
    }
  }

  /** @param {SourceChip} chip */
  function chipEl(chip) {
    const el = /** @type {HTMLButtonElement} */ (h(doc, 'button', `sbs-chip is-${chip.tone}`));
    el.type = 'button';
    el.dataset.chip = chip.id;
    el.append(h(doc, 'span', 'sbs-chip-dot'), h(doc, 'span', 'sbs-chip-label', chip.label));
    if (chip.detail) el.append(h(doc, 'span', 'sbs-chip-detail', chip.detail));
    if (chip.hint) el.title = chip.hint;
    // no pressed state until the saved settings answer: a switch drawn "on" over unknown settings would be a guess
    if (settingsKnown) el.setAttribute('aria-pressed', String(chip.on));
    // aria-busy only: a disabled button would lose keyboard focus, and flip() already ignores a second press
    if (busy.has(chip.id) || !settingsKnown) el.setAttribute('aria-busy', 'true');
    el.addEventListener('click', () => void flip(chip));
    chipEls.set(chip.id, el);
    return el;
  }

  /** A status item is plain text with a dot, never a pill: nothing about it can be pressed, and why is written out. */
  function statusEl(/** @type {SourceChip} */ chip) {
    const el = h(doc, 'p', `sbs-src-status is-${chip.tone}`);
    el.dataset.chip = chip.id;
    el.append(h(doc, 'span', 'sbs-chip-dot'), h(doc, 'span', 'sbs-chip-label', chip.label));
    if (chip.detail) el.append(h(doc, 'span', 'sbs-chip-detail', chip.detail));
    if (chip.hint) el.append(h(doc, 'span', 'sbs-src-status-hint', chip.hint));
    return el;
  }

  /** @type {Map<string, HTMLButtonElement>} */
  const chipEls = new Map();

  function paint() {
    const view = sourcesModel(data.status, data.settings, data.mcp, data.routines, pending);
    const active = /** @type {HTMLElement | null} */ (doc.activeElement);
    const focused = active?.dataset?.chip ?? null;
    chipEls.clear();
    body.replaceChildren();
    for (const group of view.groups) {
      const section = h(doc, 'section', `sbs-src-group is-${group.id}`);
      section.dataset.group = group.id;
      section.setAttribute('role', 'group');
      const title = h(doc, 'h4', 'sbs-src-title', group.label);
      title.id = `sbs-src-${group.id}`;
      section.setAttribute('aria-labelledby', title.id);
      const text = h(doc, 'div', 'sbs-src-heading');
      text.append(title);
      if (group.ring) text.append(h(doc, 'p', 'sbs-src-note', group.ring.label));
      if (group.ring) section.append(ringSvg(doc, group.ring));
      section.append(text);
      if (group.empty) section.append(h(doc, 'p', 'sbs-src-empty', group.empty));
      else {
        const chips = h(doc, 'div', 'sbs-src-chips');
        for (const chip of group.chips) if (chip.kind !== 'status') chips.append(chipEl(chip));
        section.append(chips);
        for (const chip of group.chips) if (chip.kind === 'status') section.append(statusEl(chip));
        if (group.problem) section.append(h(doc, 'p', 'sbs-src-empty', group.problem));
      }
      body.append(section);
    }
    if (view.footer) body.append(h(doc, 'p', 'sbs-src-footer', view.footer));
    // the repaint replaced the button the keyboard was on; put focus back on its twin
    if (focused) chipEls.get(focused)?.focus();
  }

  for (const item of MENU) {
    if (!item.hosts.includes(host.kind)) continue;
    if (item.id === 'radarFeeds' && !opts.radarFeeds) continue;
    const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbs-src-item', item.label));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { menu.open = false; choose(item.id); });
    menuList.append(b);
  }

  function closePanel() {
    panel = null;
    panelBox.replaceChildren();
    void load().then(paint);
  }

  /** @param {import("./sources-model.js").SourceMenuId} id */
  function choose(id) {
    if (id === 'indexStatus') { opts.select('index'); return; }
    if (id === 'radarFeeds') { opts.radarFeeds?.()?.click(); return; }
    if (panel === id) { closePanel(); return; }
    panel = id;
    const box = h(doc, 'div', 'sbs-src-panel');
    const bar = h(doc, 'div', 'sbs-src-panel-bar');
    const done = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbm-link', 'Done'));
    done.type = 'button';
    done.addEventListener('click', () => { closePanel(); summary.focus?.(); });
    bar.append(h(doc, 'h4', 'sbs-src-title', PANEL_TITLES[id]), done);
    box.append(bar, id === 'outsideServers' ? mcpWidget(doc, host) : openalexKeyWidget(doc, host));
    panelBox.replaceChildren(box);
  }

  const menuItems = () => /** @type {HTMLElement[]} */ (Array.from(menuList.querySelectorAll('button')));
  // Enter and Space open the <details> natively; the menu then takes focus on its first item
  let openedByKey = false;
  const closeOnOutside = (/** @type {Event} */ e) => { if (!menu.contains(/** @type {Node} */ (e.target))) menu.open = false; };

  menu.addEventListener('toggle', () => {
    summary.setAttribute('aria-expanded', String(menu.open));
    if (menu.open) {
      doc.addEventListener('pointerdown', closeOnOutside);
      if (openedByKey) menuItems()[0]?.focus();
    } else doc.removeEventListener('pointerdown', closeOnOutside);
    openedByKey = false;
  });
  // Tab out of the menu closes it
  menu.addEventListener('focusout', (/** @type {FocusEvent} */ e) => {
    const to = /** @type {Node | null} */ (e.relatedTarget);
    if (menu.open && to && !menu.contains(to)) menu.open = false;
  });
  menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    const items = menuItems();
    if (e.key === 'Escape' && menu.open) { menu.open = false; summary.focus?.(); e.stopPropagation(); return; }
    if (!menu.open) {
      if (e.key === 'Enter' || e.key === ' ') openedByKey = true;
      else if (e.key === 'ArrowDown' && e.target === summary) { openedByKey = true; menu.open = true; e.preventDefault(); }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !items.length) return;
    const at = items.indexOf(/** @type {HTMLElement} */ (doc.activeElement));
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
    items[next].focus();
    e.preventDefault();
  });

  paint();
  void load().then(paint);
  return root;
}
