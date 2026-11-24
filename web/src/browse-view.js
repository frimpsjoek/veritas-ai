// @ts-check
// web/src/browse-view.js. Browse (spec 027 G1): a bar of tabs and a page area. The page itself is a native webview
// the desktop app places over the page area (browse_show with its rectangle) and hides whenever something of the
// web app is drawn over it: another view, the reader panel, a menu, a dialog.
import { h } from '../../ui/src/dom.js';
import { icon } from '../../ui/src/icons.js';
import { paperMenuOn } from '../../ui/src/paper-menu.js';
import { emptyTabs, newTabId, reduceTabs, saveLabel, shownTab, tabTitle } from './browse-state.js';

/** Web app parts drawn over the content area: while any is open, the native page must not cover it. */
export const COVERS = '.sbw-overlay, .sbw-menu:not([hidden]), .sb-art-pop, .sb-art-sheet, .sbw-browser:not([hidden])';

/** @param {Element} el */
function rectOf(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/**
 * @param {Document} doc
 * @param {import('./desktop.js').Bridge} bridge
 * @param {{ openLink(url: string, opts?: { outside?: boolean, reader?: boolean }): void, can?: { addToLibrary?: boolean } }} host
 */
export function createBrowseView(doc, bridge, host) {
  // spec 032: without a Zotero library the PDF goes to Veritas's own Papers folder, so the button says only "Save PDF"
  const zotero = () => host.can?.addToLibrary !== false;
  const win = /** @type {Window} */ (doc.defaultView);
  let state = emptyTabs();
  let visible = false;
  /** @type {string} */ let lastShow = '';

  const el = h(doc, 'section', 'sbw-browse');
  el.setAttribute('aria-label', 'Browse');
  const strip = h(doc, 'div', 'sbw-browse-tabs');
  strip.setAttribute('role', 'tablist');
  const bar = h(doc, 'div', 'sbw-browse-bar');
  /** @param {string} name @param {string} label @param {() => void} run */
  const tool = (name, label, run) => {
    const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-browser-tool'));
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(icon(doc, name, 'sb-p-icon'));
    b.addEventListener('click', run);
    return b;
  };
  const back = tool('back', 'Back', () => { const t = shownTab(state); if (t) void bridge.invoke('browse_back', { tab: t.id }); });
  const forward = tool('forward', 'Forward', () => { const t = shownTab(state); if (t) void bridge.invoke('browse_forward', { tab: t.id }); });
  const reload = tool('refresh', 'Reload', () => { const t = shownTab(state); if (t) void bridge.invoke('browse_reload', { tab: t.id }); });
  const address = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-browse-address'));
  address.type = 'text';
  address.placeholder = 'Type a link or a DOI';
  address.setAttribute('aria-label', 'Address');
  address.spellcheck = false;
  address.autocomplete = 'off';
  const problem = h(doc, 'span', 'sbw-browse-problem');
  problem.setAttribute('role', 'status');
  /** A quiet line for what a tab's right-click menu did ("Link copied"): the page covers the window's own. */
  const note = h(doc, 'span', 'sbw-browse-note');
  note.setAttribute('role', 'status');
  /** @param {string} message */
  const say = (message) => { note.textContent = message; win.setTimeout(() => { if (note.textContent === message) note.textContent = ''; }, 1600); };
  const reader = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button sbw-browse-reader', 'Reader'));
  reader.type = 'button';
  reader.title = 'Open this page in the reader';
  const save = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button is-primary sbw-browse-save', saveLabel(null, zotero())));
  save.type = 'button';
  const saveState = h(doc, 'span', 'sbw-browse-save-state');
  saveState.setAttribute('role', 'status');
  saveState.setAttribute('aria-live', 'polite');
  bar.append(back, forward, reload, address, problem, note, saveState, reader, save);
  const area = h(doc, 'div', 'sbw-browse-page');
  const empty = h(doc, 'div', 'sbw-browse-empty', 'Open a paper from Home, Library or a chat, or type a link or a DOI above.');
  area.append(empty);
  el.append(strip, bar, area);

  /** @param {import('./browse-state.js').TabAction} action */
  const apply = (action) => { state = reduceTabs(state, action); paint(); place(); };

  function paint() {
    const shown = shownTab(state);
    strip.replaceChildren(...state.tabs.map((tab) => {
      const item = h(doc, 'div', `sbw-browse-tab${tab.id === state.shown ? ' is-active' : ''}`);
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(tab.id === state.shown));
      const name = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-browse-tab-name', tabTitle(tab)));
      name.type = 'button';
      name.title = tab.url;
      name.addEventListener('click', () => apply({ type: 'show', tab: tab.id }));
      paperMenuOn(item, () => ({ title: tab.title, url: tab.url }), { say });
      const close = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-browse-tab-close'));
      close.type = 'button';
      close.title = 'Close tab';
      close.setAttribute('aria-label', `Close ${tabTitle(tab)}`);
      close.append(icon(doc, 'close', 'sb-p-icon'));
      close.addEventListener('click', () => { void bridge.invoke('browse_close', { tab: tab.id }); apply({ type: 'closed', tab: tab.id }); });
      item.append(name, close);
      return item;
    }));
    const plus = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-browse-new'));
    plus.type = 'button';
    plus.title = 'New tab';
    plus.setAttribute('aria-label', 'New tab');
    plus.append(icon(doc, 'plus', 'sb-p-icon'));
    plus.addEventListener('click', () => { address.value = ''; problem.textContent = ''; state = { ...state, shown: null }; paint(); place(); address.focus(); });
    strip.append(plus);
    back.disabled = !shown?.canGoBack;
    forward.disabled = !shown?.canGoForward;
    reload.disabled = !shown;
    reader.disabled = !shown;
    save.disabled = !shown || shown.save?.status === 'saving';
    if (doc.activeElement !== address) address.value = shown?.url ?? '';
    const status = shown?.save ?? null;
    save.textContent = status && status.status !== 'failed' ? saveLabel(status) : saveLabel(null, zotero());
    saveState.textContent = status?.status === 'failed' ? saveLabel(status) : '';
    saveState.title = saveState.textContent;
    save.classList.toggle('is-done', status?.status === 'added' || status?.status === 'already' || status?.status === 'queued' || status?.status === 'kept');
    empty.hidden = Boolean(shown);
  }

  /** Puts the shown tab over the page area, or hides every tab when Browse is not on screen or something covers it. */
  function place() {
    const shown = shownTab(state);
    const covered = Boolean(doc.querySelector(COVERS));
    if (!visible || covered || !shown || !area.isConnected) {
      if (lastShow !== 'hidden') { lastShow = 'hidden'; void bridge.invoke('browse_hide').catch(() => {}); }
      return;
    }
    const rect = rectOf(area);
    const key = `${shown.id} ${rect.x} ${rect.y} ${rect.width} ${rect.height}`;
    if (key === lastShow) return;
    lastShow = key;
    void bridge.invoke('browse_show', { tab: shown.id, rect }).catch(() => {});
  }

  /** @param {string} text @param {string} [tab] */
  async function go(text, tab) {
    problem.textContent = '';
    const id = tab ?? newTabId();
    try {
      await bridge.invoke('browse_open', { tab: id, text });
      if (!tab) apply({ type: 'open', tab: id, url: text });
      else place();
    } catch (error) {
      problem.textContent = String(error instanceof Error ? error.message : error);
    }
  }

  address.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = address.value.trim();
    if (!text) return;
    void go(text, shownTab(state)?.id);
    address.blur();
  });
  address.addEventListener('input', () => { problem.textContent = ''; });
  reader.addEventListener('click', () => { const t = shownTab(state); if (t) host.openLink(t.url, { reader: true }); });
  save.addEventListener('click', () => {
    const t = shownTab(state);
    if (!t) return;
    apply({ type: 'saved', tab: t.id, status: 'saving' });
    bridge.invoke('browse_save_pdf', { tab: t.id }).catch((error) => apply({ type: 'saved', tab: t.id, status: 'failed', message: String(error) }));
  });

  bridge.on('browse://state', (p) => apply({ type: 'state', tab: p.tab, url: p.url, title: p.title, canGoBack: p.canGoBack, canGoForward: p.canGoForward, loading: p.loading }));
  bridge.on('browse://saved', (p) => apply({ type: 'saved', tab: p.tab, status: p.status, message: p.message }));
  bridge.on('browse://closed', (p) => apply({ type: 'closed', tab: p.tab }));
  bridge.on('browse://new-tab', (p) => { void go(p.url); });

  new (/** @type {any} */ (win).ResizeObserver)(() => place()).observe(area);
  win.addEventListener('resize', () => place());
  // a menu, dialog or the reader panel drawn over Browse hides the page; it comes back when they close
  new (/** @type {any} */ (win).MutationObserver)(() => place()).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });

  return {
    el,
    /** Opens `url` in a new tab and shows it. @param {string} url */
    open(url) { return go(url); },
    show() { visible = true; lastShow = ''; paint(); place(); },
    hide() { visible = false; place(); },
    /** Forgets every tab (Sign out of sites closed them in the app). */
    reset() { state = emptyTabs(); paint(); place(); },
  };
}
