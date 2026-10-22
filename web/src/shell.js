// @ts-check
// ui-src/src/web/shell.js. The web app's frame: a left rail, a hash router and the open view. Exactly one ChatView
// is ever mounted, and it is switched by mode: OPEN_VIEWS in chat.js is page-global, so a second one would double
// every history refresh and fight over the same conversation.
import { h } from '../../ui/src/dom.js';
import { icon } from '../../ui/src/icons.js';
import { ChatView } from '../../ui/src/chat/chat.js';
import { VIEW_MODES } from '../../ui/src/chat/steps-data.js';
import { parseRoute, formatRoute, webLinks } from '../../ui/src/sources/route.js';
import { applyTheme, paintWebHome, paintProjects, paintSettings } from './pages.js';
import { createLibraryView } from './library-view.js';
import { paintNotes } from './notes-view.js';
import { paintPaper } from './paper-view.js';
import { paintNote } from './note-view.js';
import { createBrowserPanel } from './browser-panel.js';
import { documentUrl, isDocumentPath } from '../../ui/src/sources/view-kit.js';
import { headerProgress } from './progress-view.js';

/** @typedef {import("../../ui/src/sources/route.js").WebRoute} WebRoute */

// `wide`: not on the phone bar, which has room for four items plus More (ledger 12); the More menu lists them there.
const RAIL = [
  { view: 'home', label: 'Home', icon: 'home' },
  { view: 'chat', label: 'Chat', icon: 'chat' },
  { view: 'library', label: 'Library', icon: 'paper' },
  { view: 'notes', label: 'Notes', icon: 'note' },
  { view: 'projects', label: 'Projects', icon: 'folder', wide: true },
];
const TITLES = { home: 'Home', chat: 'Chat', library: 'Library', notes: 'Notes', paper: 'Paper', note: 'Note', routines: 'Routines', projects: 'Projects', sources: 'Sources', settings: 'Settings' };
const SYNC_MS = 800;

/** @param {{ host: ReturnType<typeof import("./host.js").createWebHost>, doc?: Document, win?: Window }} options */
export function createShell({ host, doc = document, win = /** @type {Window} */ (doc.defaultView) }) {
  const root = h(doc, 'div', 'sbw');
  const rail = h(doc, 'nav', 'sbw-rail');
  rail.setAttribute('aria-label', 'Veritas');
  const brand = h(doc, 'div', 'sbw-brand');
  const mark = /** @type {HTMLImageElement} */ (h(doc, 'img', 'sbw-brand-mark'));
  mark.src = 'veritas-mark-180.png';
  mark.alt = '';
  brand.append(mark, h(doc, 'span', 'sbw-brand-name', 'Veritas'));
  const nav = h(doc, 'div', 'sbw-nav');
  /** @type {Map<string, HTMLAnchorElement>} */
  const links = new Map();
  for (const item of RAIL) {
    const link = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-nav-item'));
    link.href = formatRoute(/** @type {WebRoute} */ ({ view: item.view }));
    link.dataset.view = item.view;
    link.append(icon(doc, item.icon, 'sb-p-icon sbw-nav-icon'), h(doc, 'span', 'sbw-nav-label', item.label));
    link.title = item.label;
    link.setAttribute('aria-label', item.label);
    if (item.wide) link.classList.add('is-wide-only');
    links.set(item.view, link);
    nav.append(link);
  }
  const more = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-nav-item sbw-more'));
  more.setAttribute('type', 'button');
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  more.title = 'More';
  more.setAttribute('aria-label', 'More');
  more.append(icon(doc, 'more', 'sb-p-icon sbw-nav-icon'), h(doc, 'span', 'sbw-nav-label', 'More'));
  const menu = h(doc, 'div', 'sbw-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  for (const [label, route, phoneOnly] of /** @type {[string, WebRoute, boolean][]} */ ([
    ['Projects', { view: 'projects' }, true],
    ['Settings', { view: 'settings' }, false], ['Search index', { view: 'settings', section: 'index' }, false],
    ['Server', { view: 'settings', section: 'server' }, false],
  ])) {
    const item = /** @type {HTMLAnchorElement} */ (h(doc, 'a', `sbw-menu-item${phoneOnly ? ' is-phone-only' : ''}`, label));
    item.href = formatRoute(route);
    item.setAttribute('role', 'menuitem');
    menu.append(item);
  }
  const closeMenu = () => { menu.hidden = true; more.setAttribute('aria-expanded', 'false'); };
  more.addEventListener('click', () => { menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', String(!menu.hidden)); });
  menu.addEventListener('click', closeMenu);
  doc.addEventListener('pointerdown', (event) => {
    const target = /** @type {Node} */ (event.target);
    if (!menu.hidden && !menu.contains(target) && !more.contains(target)) closeMenu();
  });
  doc.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
  // Light/dark in one click: the rail button from 700 px, a More menu item on the phone. Settings still offers "Match this device".
  const isDark = () => doc.documentElement.getAttribute('data-theme') === 'dark'
    || (!doc.documentElement.hasAttribute('data-theme') && Boolean(win.matchMedia?.('(prefers-color-scheme: dark)').matches));
  const themeButton = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-nav-item sbw-theme is-wide-only'));
  themeButton.setAttribute('type', 'button');
  const themeItem = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sbw-menu-item is-phone-only'));
  themeItem.setAttribute('type', 'button');
  themeItem.setAttribute('role', 'menuitem');
  const paintThemeControls = () => {
    const label = isDark() ? 'Light mode' : 'Dark mode';
    themeButton.replaceChildren(icon(doc, isDark() ? 'sun' : 'moon', 'sb-p-icon sbw-nav-icon'), h(doc, 'span', 'sbw-nav-label', label));
    themeButton.title = label;
    themeButton.setAttribute('aria-label', label);
    themeItem.textContent = label;
  };
  const flipTheme = () => {
    const next = isDark() ? 'light' : 'dark';
    host.prefs.set('webTheme', next);
    applyTheme(doc, next);
    paintThemeControls();
  };
  themeButton.addEventListener('click', flipTheme);
  themeItem.addEventListener('click', flipTheme);
  win.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', paintThemeControls);
  new (/** @type {any} */ (win).MutationObserver)(paintThemeControls).observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  paintThemeControls();
  menu.prepend(themeItem);
  rail.append(brand, nav, h(doc, 'div', 'sbw-spacer'), themeButton, more, menu);

  const main = h(doc, 'main', 'sbw-main');
  const chatHost = h(doc, 'div', 'sbw-view sbw-view-chat');
  const page = h(doc, 'div', 'sbw-view sbw-view-page');
  // spec 019 G2: a thin bar under the header while the index builds; it opens Settings > Search index
  main.append(headerProgress(doc, host, formatRoute({ view: 'settings', section: 'index' })), chatHost, page);
  root.append(rail, main);
  // Spec 015: web links open in a panel over the content area (the host decides inside or outside).
  const browser = createBrowserPanel({ host, doc, win, into: main });
  host.setBrowser((url) => browser.open(url));

  /** @type {ReturnType<typeof createLibraryView> | null} */ let library = null;
  /** @type {ChatView | null} */ let chat = null;
  /** @type {WebRoute} */ let route = { view: 'home' };
  let renderToken = 0;

  const go = (/** @type {WebRoute} */ next) => { win.location.hash = formatRoute(next); };

  // Citations in chat open the paper or note here instead of leaving for Zotero or Obsidian.
  host.setOpenRef(/** @param {any} ref */ (ref) => {
    if (ref.kind === 'note' && isDocumentPath(ref.path)) { host.openLink(new URL(documentUrl(ref.path), win.location.href).href, { outside: true }); return true; }
    if (ref.kind === 'note') { go({ view: 'note', path: ref.path }); return true; }
    if (ref.kind !== 'paper') return false;
    void host.json(`/links?${new URLSearchParams({ path: `@${ref.citekey}` })}`).then(
      (found) => { if (found?.path?.startsWith('zotero/')) go({ view: 'paper', key: found.path.slice('zotero/'.length) }); else host.notice(`Couldn't find @${ref.citekey} in your library.`); },
      () => host.notice(`Couldn't find @${ref.citekey} in your library.`),
    );
    return true;
  });

  /** The one ChatView, built on first use. */
  function chatView() {
    if (!chat) {
      chat = new ChatView(host, doc);
      chatHost.append(/** @type {HTMLElement} */ (chat.root));
      // A phone opens on the thread, not on the history drawer, until the user has chosen either way.
      if (host.prefs.get('historyCollapsed') === undefined && win.innerWidth < 560) chat.applyHistoryCollapsed(true);
    }
    return chat;
  }

  /** @param {ChatView} view @param {string} id */
  async function openSession(view, id) {
    if (view.conversationID === id || view.reviewID === id || view.findID === id) return;
    await view.refreshList(); // knows which sessions are saved Find searches
    const known = view.recent.find((c) => c.id === id);
    if (known) await view.openSession(known); else await view.openConversation(id);
  }

  /** @param {WebRoute} next @param {number} token */
  async function showChat(next, token) {
    const view = chatView();
    const wantsRoutines = next.view === 'routines';
    const mode = wantsRoutines ? 'routines' : next.view === 'chat' ? next.mode : undefined;
    if (next.view === 'chat' && next.project !== undefined && view.projectId !== next.project) view.setProject(next.project);
    if (next.view === 'chat' && next.session) {
      await openSession(view, next.session);
    } else if (mode && view.mode !== mode) {
      view.setMode(mode);
    } else if (next.view === 'chat' && !mode && VIEW_MODES.includes(view.mode)) {
      view.setMode('chat');
    }
    if (token !== renderToken) return;
    view.refreshContext();
  }

  /** Reflects what the chat is showing back into the hash (replace, so Back is not filled with every click). */
  function syncHash() {
    if (!chat || route.view !== 'chat' && route.view !== 'routines') return;
    const current = chat;
    /** @type {WebRoute} */
    let next;
    if (route.view === 'routines') {
      if (current.mode === 'routines') return;
      next = { view: 'chat', ...(current.mode !== 'chat' ? { mode: /** @type {any} */ (current.mode) } : {}), ...(current.conversationID ? { session: current.conversationID } : {}) };
    } else {
      const session = current.conversationID ?? current.reviewID ?? current.findID ?? undefined;
      const mode = ['ask', 'find', 'report', 'systematic'].includes(current.mode) ? /** @type {any} */ (current.mode) : undefined;
      if (VIEW_MODES.includes(current.mode)) { next = { view: 'routines' }; }
      else next = { view: 'chat', ...(mode ? { mode } : {}), ...(session ? { session } : {}), ...(current.projectId ? { project: current.projectId } : {}) };
    }
    const hash = formatRoute(next);
    if (hash === win.location.hash) return;
    route = next;
    win.history.replaceState(null, '', hash);
    paintRail();
  }

  function paintRail() {
    const active = route.view === 'paper' ? 'library' : route.view === 'note' ? 'notes' : route.view;
    for (const [view, link] of links) {
      link.classList.toggle('is-active', view === active);
      if (view === active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    more.classList.toggle('is-active', route.view === 'settings' || route.view === 'routines' || (win.innerWidth < 700 && route.view === 'projects'));
    doc.title = route.view === 'home' ? 'Veritas' : `${TITLES[route.view]} · Veritas`;
  }

  async function render() {
    const token = ++renderToken;
    browser.close();
    route = parseRoute(win.location.hash);
    paintRail();
    root.classList.toggle('is-reading', route.view === 'paper' || route.view === 'note');
    const inChat = route.view === 'chat' || route.view === 'routines';
    chatHost.hidden = !inChat;
    page.hidden = inChat;
    if (inChat) { await showChat(route, token); return; }
    const ctx = { host, doc, win, go, links: webLinks(host) };
    // Library, Notes, the readers and Settings scroll inside themselves; the other pages scroll as a whole.
    page.classList.toggle('is-fill', ['library', 'paper', 'note', 'settings'].includes(route.view));
    if (route.view === 'library') {
      library ??= createLibraryView(ctx);
      if (library.root.parentElement !== page) page.replaceChildren(library.root);
      library.show(route);
      return;
    }
    // Each paint gets its own slot, so a page still loading when the route changes writes into a slot that is gone.
    const slot = h(doc, 'div', 'sbw-slot');
    page.replaceChildren(slot);
    if (route.view === 'notes') await paintNotes(slot, ctx, route);
    else if (route.view === 'paper') await paintPaper(slot, ctx, route);
    else if (route.view === 'note') await paintNote(slot, ctx, route);
    else if (route.view === 'home') await paintWebHome(slot, ctx, route);
    else if (route.view === 'projects') await paintProjects(slot, ctx);
    else if (route.view === 'settings') await paintSettings(slot, { ...ctx, section: route.section });
  }

  const onHash = () => { void render(); };
  /** @type {any} */ let timer = null;
  return {
    root,
    get chat() { return chat; },
    go,
    render,
    /** Mounts into the document and starts listening. */
    start() {
      host.mount(root);
      win.addEventListener('hashchange', onHash);
      timer = setInterval(syncHash, SYNC_MS);
      return render();
    },
    destroy() {
      win.removeEventListener('hashchange', onHash);
      host.setBrowser(null);
      clearInterval(timer);
      chat?.destroy();
      root.remove();
    },
  };
}
