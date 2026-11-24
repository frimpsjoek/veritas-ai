// @ts-check
// web/src/browse-state.js. Browse's tabs as plain data (spec 027 G1): which are open, which is shown, what each page
// says about itself, and the Save button's words. The desktop app owns the real webviews; this mirrors them, and its
// ninth-tab rule matches the app's (app/src-tauri/src/browse/mod.rs `evict`).

import { plainText } from '../../ui/src/paper-text.js';

export const MAX_TABS = 8;

/** @typedef {{ status: 'saving' | 'added' | 'queued' | 'already' | 'kept' | 'failed', message?: string | null }} SaveState */
/** @typedef {{ id: string, url: string, title: string, canGoBack: boolean, canGoForward: boolean, loading: boolean, save: SaveState | null, used: number }} Tab */
/** @typedef {{ tabs: Tab[], shown: string | null, clock: number }} Tabs */
/** @typedef {{ type: 'open' | 'new-tab', tab: string, url: string }
 *   | { type: 'show' | 'closed', tab: string }
 *   | { type: 'state', tab: string, url: string, title: string, canGoBack: boolean, canGoForward: boolean, loading: boolean }
 *   | { type: 'saved', tab: string, status: SaveState['status'], message?: string | null }} TabAction */

/** @returns {Tabs} */
export function emptyTabs() {
  return { tabs: [], shown: null, clock: 0 };
}

/** @param {Tabs} state @returns {Tab | null} */
export function shownTab(state) {
  return state.tabs.find((t) => t.id === state.shown) ?? null;
}

/** @param {Tabs} state @param {TabAction} action @returns {Tabs} */
export function reduceTabs(state, action) {
  const clock = state.clock + 1;
  const has = state.tabs.some((t) => t.id === action.tab);
  switch (action.type) {
    case 'open':
    case 'new-tab': {
      if (has) return { ...state, clock, shown: action.tab, tabs: state.tabs.map((t) => (t.id === action.tab ? { ...t, url: action.url, save: null, used: clock } : t)) };
      let tabs = state.tabs;
      if (tabs.length >= MAX_TABS) {
        const oldest = tabs.filter((t) => t.id !== state.shown).reduce((a, b) => (b.used < a.used ? b : a));
        tabs = tabs.filter((t) => t.id !== oldest.id);
      }
      /** @type {Tab} */
      const tab = { id: action.tab, url: action.url, title: '', canGoBack: false, canGoForward: false, loading: true, save: null, used: clock };
      return { tabs: [...tabs, tab], shown: action.tab, clock };
    }
    case 'show':
      if (!has) return state;
      return { ...state, clock, shown: action.tab, tabs: state.tabs.map((t) => (t.id === action.tab ? { ...t, used: clock } : t)) };
    case 'closed': {
      if (!has) return state;
      const at = state.tabs.findIndex((t) => t.id === action.tab);
      const tabs = state.tabs.filter((t) => t.id !== action.tab);
      const shown = state.shown !== action.tab ? state.shown : (tabs[at] ?? tabs[at - 1] ?? null)?.id ?? null;
      return { tabs, shown, clock };
    }
    case 'state':
      if (!has) return state;
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id !== action.tab ? t : {
          ...t,
          url: action.url || t.url,
          title: action.title,
          canGoBack: action.canGoBack,
          canGoForward: action.canGoForward,
          loading: action.loading,
          // a Save's outcome is about the page it was pressed on
          save: action.url && action.url !== t.url ? null : t.save,
        })),
      };
    case 'saved':
      if (!has) return state;
      return { ...state, tabs: state.tabs.map((t) => (t.id === action.tab ? { ...t, save: { status: action.status, message: action.message ?? null } } : t)) };
    default:
      return state;
  }
}

/** The Save button's words for a tab's save state. `zotero`: this setup has a Zotero library (spec 032: without one the
 *  PDF goes to Veritas's own Papers folder). @param {SaveState | null} save @param {boolean} [zotero] */
export function saveLabel(save, zotero = true) {
  switch (save?.status) {
    case 'saving': return 'Saving…';
    case 'added': return 'Saved to Zotero';
    case 'queued': return 'Waiting for Zotero';
    case 'already': return 'Already in Zotero';
    case 'kept': return 'Saved to Veritas › Papers';
    case 'failed': return save.message || 'The PDF could not be saved';
    default: return zotero ? 'Save PDF to Zotero' : 'Save PDF';
  }
}

/** A tab's name: the page's title (an arXiv page's TeX as text), else its site. @param {{ url: string, title: string } | null} tab */
export function tabTitle(tab) {
  if (tab?.title) return /^https?:\/\/(?:[\w-]+\.)*arxiv\.org\//i.test(tab.url) ? plainText(tab.title) : tab.title;
  try {
    const url = new URL(tab?.url ?? '');
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname.replace(/^www\./, '');
  } catch { /* not a url */ }
  return 'New tab';
}

let counter = 0;
/** A new tab's id: letters and digits only, as the desktop app's labels allow. @returns {string} */
export function newTabId() {
  counter += 1;
  return `t${Date.now().toString(36)}${counter.toString(36)}`;
}
