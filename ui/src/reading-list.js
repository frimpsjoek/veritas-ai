// @ts-check
// ui/src/reading-list.js. Spec 028 R10: Read later for any view. One copy of the list per host, read once and kept up
// to date by every change made here; each change tells the window (READING_LIST_CHANGED) so the rail badge, the Read
// later view and every bookmark button repaint. A host whose engine has no reading list (an older server) shows no
// bookmark: the UI hides what is missing.
import { h } from './dom.js';
import { lucide } from './icons.js';
import { bookmarkCopy, listedAs, readingId } from './reading-list-data.js';

/** @typedef {import("../../agent/src/service").ReadingListEntry} ReadingListEntry */
/** @typedef {import("../../agent/src/service").ReadingListPaper} ReadingListPaper */
/** @typedef {import("./host").UiHost} UiHost */

/** The window event after the list changed; `detail` is the whole list. */
export const READING_LIST_CHANGED = 'sb-reading-list-changed';

/** host -> the list as last read or changed here (null: this engine has none). @type {WeakMap<object, Promise<ReadingListEntry[] | null | undefined>>} */
const LISTS = new WeakMap();
/** host -> the newest refresh asked for, so an older answer that comes back later is not told. @type {WeakMap<object, number>} */
const REFRESHES = new WeakMap();
/** host -> the last list the engine answered with, and which read it was, so a read that fails shows that list
 *  rather than "no list" (and an older read answering last does not replace a newer one).
 *  @type {WeakMap<object, { list: ReadingListEntry[] | null, read: number }>} */
const GOOD = new WeakMap();
/** Reads that failed, so a refresh that failed tells nobody: every view keeps what it shows. @type {WeakSet<Promise<unknown>>} */
const FAILED = new WeakSet();
let reads = 0;

/** @param {UiHost} host */
async function service(host) {
  const ai = await host.ai();
  return ai.readingList ?? null;
}

/** The list, newest first, or null where the engine has none. `fresh` asks the engine again. A read that failed is
 *  not kept (the next call asks again) and gives the last list read, or undefined when none was: not knowing is not
 *  "no list". @param {UiHost} host @param {boolean} [fresh] @returns {Promise<ReadingListEntry[] | null | undefined>} */
export function readingEntries(host, fresh = false) {
  const kept = LISTS.get(host);
  if (kept && !fresh) return kept;
  const read = ++reads;
  /** @type {Promise<ReadingListEntry[] | null | undefined>} */
  const list = service(host).then((svc) => (svc ? svc.list() : null)).then((got) => {
    if ((GOOD.get(host)?.read ?? 0) < read) GOOD.set(host, { list: got, read });
    return got;
  }, (error) => {
    host.logError(error);
    FAILED.add(list);
    if (LISTS.get(host) === list) LISTS.delete(host);
    return GOOD.get(host)?.list;
  });
  LISTS.set(host, list);
  return list;
}

/** Whether `read` (a promise readingEntries gave) failed, so the list it gave is the last one known, perhaps old.
 *  @param {Promise<unknown>} read */
export const readFailed = (read) => FAILED.has(read);

/** Runs one change, then reads the list again and tells the window. Throws when the engine refused.
 *  @template T @param {UiHost} host @param {Document} doc @param {(svc: NonNullable<Awaited<ReturnType<typeof service>>>) => Promise<T>} run @returns {Promise<T>} */
async function change(host, doc, run) {
  const svc = await service(host);
  if (!svc) throw new Error('This server has no Read later list.');
  const out = await run(svc);
  await refreshReadingList(host, doc);
  return out;
}

/** Reads the list again and tells the window, for a change made elsewhere (another window, the Zotero plugin). Only
 *  the newest refresh tells it: an older one answering last would paint a list from before. A read that failed tells
 *  nobody, so a bookmark, the badge and the views keep what they show through a blip.
 *  @param {UiHost} host @param {Document} doc */
export async function refreshReadingList(host, doc) {
  const mine = (REFRESHES.get(host) ?? 0) + 1;
  REFRESHES.set(host, mine);
  const read = readingEntries(host, true);
  const list = await read;
  if (REFRESHES.get(host) !== mine || FAILED.has(read)) return list;
  const win = /** @type {any} */ (doc.defaultView);
  if (win?.CustomEvent) win.dispatchEvent(new win.CustomEvent(READING_LIST_CHANGED, { detail: list }));
  return list;
}

/** @param {UiHost} host @param {Document} doc @param {ReadingListPaper} paper */
export const saveLater = (host, doc, paper) => change(host, doc, (svc) => svc.add(paper));
/** @param {UiHost} host @param {Document} doc @param {string} id */
export const unsaveLater = (host, doc, id) => change(host, doc, (svc) => svc.remove(id));
/** @param {UiHost} host @param {Document} doc @param {string} id @param {boolean} read */
export const markLater = (host, doc, id, read) => change(host, doc, (svc) => svc.markRead(id, read));

/** Changes an element may miss the page for before it is taken as never shown and stops listening. */
const UNSHOWN_CHANGES = 2;

/** Calls `paint(list)` now and after every change, until `el` has left the page (null: for as long as the page lives,
 *  for a view that is kept and shown again). An `el` that never reached the page stops after UNSHOWN_CHANGES changes.
 *  Nothing is painted while the list is not known yet (the first read failed). @param {Document} doc @param {UiHost} host
 *  @param {HTMLElement | null} el @param {(list: ReadingListEntry[] | null) => void} paint */
export function onReadingList(doc, host, el, paint) {
  const win = doc.defaultView;
  let shown = false;
  let missed = 0;
  const listener = (/** @type {any} */ event) => {
    if (!el || el.isConnected) shown = true;
    else if (shown || ++missed >= UNSHOWN_CHANGES) { win?.removeEventListener(READING_LIST_CHANGED, listener); return; }
    paint(event.detail ?? null);
  };
  win?.addEventListener(READING_LIST_CHANGED, listener);
  void readingEntries(host).then((list) => {
    if (el?.isConnected) shown = true; // painted on the page: once it leaves, the next change drops the listener
    if (list !== undefined) paint(list);
  });
}

/**
 * The bookmark toggle: "Read later", pressed "Saved to read later"; pressing again removes the paper. Hidden until the
 * list is known, and for good where there is none or the paper has nothing to be listed by.
 * @param {Document} doc @param {UiHost} host @param {ReadingListPaper} paper
 * @param {{ className?: string, iconOnly?: boolean, size?: number }} [opts]
 */
export function bookmarkButton(doc, host, paper, opts = {}) {
  const id = readingId(paper);
  const b = /** @type {HTMLButtonElement} */ (h(doc, 'button', `${opts.className ?? 'sb-button'} sb-bookmark`));
  b.setAttribute('type', 'button');
  b.hidden = true;
  /** The entry this paper is listed as (by any of its ids), or null. @type {ReadingListEntry | null} */
  let saved = null;
  const paint = () => {
    const copy = bookmarkCopy(Boolean(saved));
    b.replaceChildren(lucide(doc, 'bookmark', opts.size ?? 14), opts.iconOnly ? h(doc, 'span', 'sb-dg-label', copy.label) : doc.createTextNode(copy.label));
    b.title = copy.hint;
    b.setAttribute('aria-pressed', String(Boolean(saved)));
    if (opts.iconOnly) b.setAttribute('aria-label', copy.label);
    b.classList.toggle('is-on', Boolean(saved));
  };
  if (!id) return b;
  onReadingList(doc, host, b, (list) => {
    b.hidden = !list;
    saved = listedAs(list, paper);
    paint();
  });
  b.addEventListener('click', async (event) => {
    event.stopPropagation();
    b.disabled = true;
    try {
      if (saved) await unsaveLater(host, doc, saved.id); else await saveLater(host, doc, paper);
    } catch (error) {
      host.logError(error);
      host.notice("Couldn't save that. Try again.");
    } finally { b.disabled = false; }
  });
  return b;
}
