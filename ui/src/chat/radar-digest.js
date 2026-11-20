// @ts-check
// ui-src/src/chat/radar-digest.js. Spec 012 R4: the reading radar's digest drawn on a papers result. The summary line above
// the table, a "why read this" line under each title, and row actions (Add to Zotero or Read later, Like, Not for me), that
// each tell the engine through `radar.feedback` and offer Undo for five seconds. A settled row says what happened and keeps
// an Undo link. The table renderer asks this class for the bits, as icons; Home's judging asks for labelled pills with their
// keys and the collection menu (`judging`). The words and rules are in radar-digest-data.js.
import { h } from '../dom.js';
import { lucide } from '../icons.js';
import { LOGOS, logoSvg } from '../logos.js';
import { digestOf, keyOf, rowLine, actionList, settledLabel, toastText, outsidePaper, likeAdd } from './radar-digest-data.js';
import { collectionMenu, COLLECTION_PREF } from '../home/collection-menu.js';
import { collectionLabel, collectionTarget } from '../home/collection-data.js';
import { bookmarkButton, readFailed, readingEntries, refreshReadingList, saveLater, unsaveLater } from '../reading-list.js';
import { listedAs } from '../reading-list-data.js';

/** @typedef {import("../host").UiHost} UiHost */
/** @typedef {import("../../../agent/src/domain").PaperRow} PaperRow */
/** @typedef {import("./radar-digest-data.js").Verdict} Verdict */
/** @typedef {import("./radar-digest-data.js").Mark} Mark */

/** Spec 029 R9: the engine puts a liked paper on Read later and takes it off when the Like goes, so the list is read
 *  again when a Like came or went. @param {string | undefined | null} was @param {string} now */
export const likeMoved = (was, now) => (was === 'liked') !== (now === 'liked');

/** The icon a settled row shows beside what happened. @type {Record<Verdict, Mark>} */
const SETTLED_MARK = { added: { logo: 'zotero' }, later: { lucide: 'bookmark' }, liked: { lucide: 'thumbsUp' }, dismissed: { lucide: 'thumbsDown' } };

/** @param {Document} doc @param {Mark} mark */
const markSvg = (doc, mark) => ('logo' in mark ? logoSvg(doc, LOGOS[mark.logo], 14, 'sb-logo sb-dg-mark') : lucide(doc, mark.lucide, 14));

export const TOAST_MS = 5000;
const SETTLED = '.sb-art-row, .sb-art-rowcard, .sbw-paper';  // table row, card, or a paper on Home

/** Papers already reported as viewed while this page is open, as "session\nrow": each is told once. */
const VIEWED = new Set();
/** Tells still on their way, by the same key: a second caller (Home's click and the reader it opens, spec 028 R6) waits
 *  for the first one's answer instead of telling again, so Home still reads its counts again. */
const TELLING = new Map();

/**
 * The person opened a paper of a routine's issue without opening its chat: one paper less of news on that session
 * (conversations.markViewed, which ignores rows that were never news). Resolves true once the engine was told; an older
 * server has no markViewed, and the count then drops only when the chat is opened. A tell that went through also tells
 * the host (`newsChanged`), so a count kept outside the page that opened the paper (the web rail's badge) reads again.
 * @param {UiHost} host @param {string | null | undefined} session @param {string | null | undefined} rowId @returns {Promise<boolean>}
 */
export function markViewed(host, session, rowId) {
  const key = `${session}\n${rowId}`;
  if (!session || !rowId || VIEWED.has(key)) return TELLING.get(key) ?? Promise.resolve(false);
  VIEWED.add(key);
  const telling = (async () => {
    try {
      const ai = await host.ai();
      const told = ai.conversations.markViewed?.(/** @type {any} */ (session), [/** @type {any} */ (rowId)]);
      if (!told) return false; // an older server
      await told;
      host.newsChanged?.();
      return true;
    } catch (error) {
      VIEWED.delete(key); // told nobody: the next open tries again
      host.logError(error);
      return false;
    } finally {
      TELLING.delete(key);
    }
  })();
  TELLING.set(key, telling);
  return telling;
}

export class RadarDigest {
  /** @param {UiHost} host @param {Document} doc @param {HTMLElement} mount the panel, which holds the toast @param {{ routine: string, summary: string, judging?: boolean }} digest */
  constructor(host, doc, mount, digest) {
    this.host = host;
    this.doc = doc;
    this.mount = mount;
    this.routine = digest.routine;
    this.summary = digest.summary;
    this.judging = !!digest.judging;
    /** @type {Map<string, string>} the collection a paper was just added to, for its settled line */
    this.placed = new Map();
    /** Added while Zotero or its plugin could not take them: queued, not yet in the library. @type {Set<string>} */
    this.waiting = new Set();
    /** @type {Promise<any> | null} */ this.collections = null;
    /** @type {(() => void) | null} a verdict was loaded, given or taken back */ this.onChange = null;
    /** @type {Map<string, Verdict>} what was done with each paper, by radar key */
    this.verdicts = new Map();
    /** @type {Map<string, Set<HTMLElement>>} the action boxes drawn for each paper */
    this.boxes = new Map();
    /** @type {Set<string>} papers with a click in flight */
    this.busy = new Set();
    /** @type {HTMLElement | null} */ this.toast = null;
    /** @type {ReturnType<typeof setTimeout> | null} */ this.timer = null;
    this.canAdd = !!host.can.addToLibrary && !!host.addToLibrary;
    /** @type {string | null} the session whose results are drawn, for `viewed`; the panel sets it */
    this.session = null;
    /** Papers (by radar key) the `later` verdict put on the Read later list here, the only ones its Undo takes off. @type {Set<string>} */
    this.laterAdded = new Set();
    void this.load();
  }

  /** A paper was opened from the digest table: it is no longer news (markViewed). @param {PaperRow} row */
  viewed(row) {
    void markViewed(this.host, this.session, row.id);
  }

  /** Earlier clicks, so a reopened digest still shows them. */
  async load() {
    try {
      const ai = await this.host.ai();
      const done = await ai.radar?.verdicts?.(this.routine);
      for (const [key, verdict] of Object.entries(done ?? {})) if (!this.verdicts.has(key) && verdict !== 'shown' && verdict !== 'off') this.verdicts.set(key, verdict);
      for (const key of this.boxes.keys()) this.paint(key);
      this.onChange?.();
    } catch (error) { this.host.logError(error); }
  }

  /** The line above the tables. */
  summaryNode() {
    return h(this.doc, 'div', 'sb-dg-summary', this.summary);
  }

  /** The "why read this" line, or the note that there was no abstract. @param {PaperRow} row */
  line(row) {
    const line = rowLine(row);
    return line ? h(this.doc, 'div', `sb-dg-line${line.muted ? ' is-muted' : ''}`, line.text) : null;
  }

  /** The action box for one row; repainted in place when the row is settled or undone. @param {PaperRow} row */
  actions(row) {
    const key = keyOf(row);
    const box = h(this.doc, 'div', 'sb-dg-acts');
    if (!key) return box;
    let set = this.boxes.get(key);
    if (!set) this.boxes.set(key, (set = new Set()));
    set.add(box);
    box.dataset.radarRow = key;
    this.fill(box, row, key);
    return box;
  }

  /** Greys a row (the `tr` or card) that was dismissed before it was drawn. @param {HTMLElement} rowEl @param {PaperRow | null} paper */
  mark(rowEl, paper) {
    const verdict = paper ? this.verdicts.get(keyOf(paper) ?? '') : undefined;
    rowEl.classList.toggle('is-dismissed', verdict === 'dismissed');
    rowEl.classList.toggle('is-settled', !!verdict);
  }

  /** @param {string} key */
  paint(key) {
    for (const box of this.boxes.get(key) ?? []) {
      // A box drawn into a list that is not on the page yet (Home builds the issue first) is kept, not dropped: only
      // one that was on the page and left it is gone for good.
      if (!box.isConnected && /** @type {any} */ (box).__shown) { this.boxes.get(key)?.delete(box); continue; }
      if (box.isConnected) /** @type {any} */ (box).__shown = true;
      const row = /** @type {PaperRow | undefined} */ (/** @type {any} */ (box).__row);
      if (row) this.fill(box, row, key);
    }
  }

  /** @param {HTMLElement} box @param {PaperRow} row @param {string} key */
  fill(box, row, key) {
    /** @type {any} */ (box).__row = row;
    const verdict = this.verdicts.get(key);
    const busy = this.busy.has(key);
    box.closest(SETTLED)?.classList.toggle('is-dismissed', verdict === 'dismissed');
    box.closest(SETTLED)?.classList.toggle('is-settled', !!verdict);
    box.replaceChildren();
    if (verdict) {
      const state = h(this.doc, 'span', `sb-dg-state${verdict === 'dismissed' ? ' is-dismissed' : ''}`);
      const placed = verdict === 'added' ? this.placed.get(key) : '';
      const said = verdict === 'added' && this.waiting.has(key) ? 'Waiting for Zotero' : settledLabel(verdict);
      state.append(markSvg(this.doc, SETTLED_MARK[verdict]), this.doc.createTextNode(placed ? `${said} \u00B7 ${placed}` : said));
      box.append(state, ...this.bookmark(box, row), this.button('Undo', () => this.undo(row), false, busy, null, 'Take this back'));
      return;
    }
    for (const a of actionList(this.canAdd)) {
      const b = this.button(a.label, () => this.choose(row, a.verdict), a.primary, busy, a.mark, a.hint, true);
      if (!this.judging) { box.append(b); continue; }
      b.dataset.key = a.key;
      b.setAttribute('aria-keyshortcuts', a.key);
      if (a.verdict !== 'added') { box.append(b); continue; }
      const split = h(this.doc, 'span', 'sb-split');
      split.append(b, collectionMenu(this.doc, this.host, { buttonClass: 'sb-dg-chev', list: this.collectionList() }).el);
      box.append(split);
    }
    // spec 028 R10: its own toggle beside Add to Zotero; without Zotero the first action is Read later already
    const mark = this.bookmark(box, row);
    if (mark.length) box.firstElementChild?.after(...mark);
  }

  /** The row's Read later toggle where there is Zotero too: one per box, kept across repaints. @param {HTMLElement} box
   *  @param {PaperRow} row @returns {HTMLElement[]} */
  bookmark(box, row) {
    if (!this.canAdd) return [];
    const kept = /** @type {any} */ (box);
    kept.__bookmark ??= bookmarkButton(this.doc, this.host, outsidePaper(row), { className: 'sb-dg-act is-icon', iconOnly: true });
    return [kept.__bookmark];
  }

  /** The `later` verdict also puts the paper on the Read later list, and taking it back takes it off, unless it was
   *  listed before the verdict (or by a verdict given before this page opened). The verdict stands when the list could
   *  not be changed. @param {PaperRow} row @param {boolean} on */
  async keepLater(row, on) {
    const key = keyOf(row) ?? '';
    try {
      const paper = outsidePaper(row);
      if (on) {
        // read afresh: a save made since in another window must not count as this verdict's
        const read = readingEntries(this.host, true);
        const known = await read;
        await saveLater(this.host, this.doc, paper);
        // not known whether it was listed before (the read failed, and any list it gave is an older one): Undo leaves
        // it, rather than take off a paper saved earlier
        if (!readFailed(read) && known !== undefined && !listedAs(known, paper)) this.laterAdded.add(key);
        return;
      }
      if (!this.laterAdded.delete(key)) return;
      const listed = listedAs(await readingEntries(this.host), paper);
      if (listed) await unsaveLater(this.host, this.doc, listed.id);
    } catch (error) { this.host.logError(error); }
  }

  /** One request for the collections, however many rows ask. */
  collectionList() {
    return (this.collections ??= new Promise((resolve) => { resolve(this.host.collections()); }).catch(() => []));
  }

  /** Papers among `rows` that have a verdict. @param {PaperRow[]} rows */
  judged(rows) {
    return rows.filter((row) => this.verdicts.has(keyOf(row) ?? '')).length;
  }

  /** @param {PaperRow} row */
  settled(row) {
    return this.verdicts.has(keyOf(row) ?? '');
  }

  /** A key pressed on Home: `added` is the row's save action, Read later where there is no Zotero. A settled row is left
   *  alone (Undo is the way to change it). @param {PaperRow} row @param {Verdict} verdict */
  judgeKey(row, verdict) {
    if (this.settled(row)) return;
    void this.choose(row, verdict === 'added' && !this.canAdd ? 'later' : verdict);
  }

  /** What the reader needs to judge a paper opened from this issue, the same verdicts as the row's.
   *  @param {PaperRow} row @returns {import("../host").RadarLink | null} */
  readerLink(row) {
    const key = keyOf(row);
    if (!key) return null;
    // the issue it was drawn in, now: Home's digest moves on to the next issue shown, the link stays with this one
    const session = this.session;
    return { routine: this.routine, key, paper: outsidePaper(row), verdict: () => this.verdicts.get(key) ?? null, tell: (verdict) => this.tell(row, verdict), viewed: () => markViewed(this.host, session, row.id) };
  }

  /** Tells the engine a verdict given elsewhere (the reader) and shows it here too. Throws if the engine could not be told.
   *  @param {PaperRow} row @param {Verdict | 'undo'} verdict @returns {Promise<Verdict | null>} */
  async tell(row, verdict) {
    const key = /** @type {string} */ (keyOf(row));
    const ai = await this.host.ai();
    const was = this.verdicts.get(key);
    const out = await ai.radar.feedback(this.routine, key, verdict);
    if (out.verdict === 'shown') this.verdicts.delete(key); else this.verdicts.set(key, /** @type {Verdict} */ (out.verdict));
    if (verdict === 'liked') await this.likeToZotero(row);
    if (likeMoved(was, out.verdict)) void refreshReadingList(this.host, this.doc);
    if (out.verdict === 'later' && was !== 'later') await this.keepLater(row, true);
    else if (was === 'later' && out.verdict !== 'later') await this.keepLater(row, false);
    this.paint(key);
    this.onChange?.();
    return this.verdicts.get(key) ?? null;
  }

  /** @param {string} label @param {() => void} run @param {boolean} primary @param {boolean} disabled
   *  @param {Mark | null} [mark] the icon before the label @param {string} [hint] the tooltip
   *  @param {boolean} [iconOnly] the icon alone; the label stays for screen readers */
  button(label, run, primary, disabled, mark = null, hint = '', iconOnly = false) {
    const b = /** @type {HTMLButtonElement} */ (h(this.doc, 'button', `sb-dg-act${primary ? ' is-primary' : ''}${iconOnly ? ' is-icon' : ''}`));
    if (mark) b.append(markSvg(this.doc, mark));
    b.append(iconOnly ? h(this.doc, 'span', 'sb-dg-label', label) : this.doc.createTextNode(label));
    b.setAttribute('type', 'button');
    if (hint) b.title = hint;
    if (iconOnly) b.setAttribute('aria-label', label);
    b.disabled = disabled;
    b.addEventListener('click', (event) => { event.stopPropagation(); run(); });
    return b;
  }

  /** @param {PaperRow} row @param {Verdict} verdict */
  async choose(row, verdict) {
    const key = keyOf(row);
    if (!key || this.busy.has(key)) return;
    this.busy.add(key);
    this.paint(key);
    try {
      if (verdict === 'added') {
        const list = this.judging ? await this.collectionList() : null;
        const collection = collectionTarget(list, String(this.host.prefs?.get(COLLECTION_PREF) ?? ''));
        const out = await this.host.addToLibrary?.([outsidePaper(row)], collection ? { collection } : undefined);
        if (!out?.items?.[0]) { this.host.notice("Couldn't add that paper to Zotero."); return; }
        if (String(out.items[0].key).startsWith('queued-')) this.waiting.add(key); else this.waiting.delete(key);
        if (collection) this.placed.set(key, collectionLabel(list, collection));
      }
      const ai = await this.host.ai();
      await ai.radar.feedback(this.routine, key, verdict);
      this.verdicts.set(key, verdict);
      if (verdict === 'later') await this.keepLater(row, true);
      const zotero = verdict === 'liked' ? await this.likeToZotero(row) : null;
      if (verdict === 'liked') void refreshReadingList(this.host, this.doc); // the engine put it on Read later
      this.say(toastText(verdict, zotero ? { zotero } : undefined), () => this.undo(row));
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't save that. Try again.");
    } finally {
      this.busy.delete(key);
      this.paint(key);
      this.onChange?.();
    }
  }

  /** Settings > Reading radar > "When you like a paper": also into Zotero, tagged Liked, in To classify. The like
   *  stands even when Zotero could not be reached. @param {PaperRow} row @returns {Promise<'added' | 'queued' | null>} */
  async likeToZotero(row) {
    const add = likeAdd(this.host.prefs, this.canAdd);
    if (!add) return null;
    const key = keyOf(row);
    try {
      const out = await this.host.addToLibrary?.([outsidePaper(row)], add);
      const item = out?.items?.[0];
      if (!item) { this.host.notice("Liked, but couldn't add it to Zotero."); return null; }
      const queued = String(item.key).startsWith('queued-');
      if (key) { if (queued) this.waiting.add(key); else this.waiting.delete(key); this.placed.set(key, add.collectionName); }
      return queued ? 'queued' : 'added';
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Liked, but couldn't add it to Zotero.");
      return null;
    }
  }

  /** @param {PaperRow} row */
  async undo(row) {
    const key = keyOf(row);
    if (!key || this.busy.has(key)) return;
    const was = this.verdicts.get(key);
    this.busy.add(key);
    this.paint(key);
    try {
      const ai = await this.host.ai();
      const out = await ai.radar.feedback(this.routine, key, 'undo');
      if (out.verdict === 'shown') this.verdicts.delete(key); else this.verdicts.set(key, /** @type {Verdict} */ (out.verdict));
      if (was === 'later' && out.verdict !== 'later') await this.keepLater(row, false);
      if (likeMoved(was, out.verdict)) void refreshReadingList(this.host, this.doc);
      // Undo takes back what the radar learned. A paper already in Zotero stays there.
      this.say(was === 'added' ? 'Undone. The paper stays in Zotero.' : toastText('undo'));
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't undo that. Try again.");
    } finally {
      this.busy.delete(key);
      this.paint(key);
      this.onChange?.();
    }
  }

  /** One toast at a time, for five seconds. @param {string} text @param {() => void} [onUndo] */
  say(text, onUndo) {
    this.hideToast();
    const toast = h(this.doc, 'div', 'sb-dg-toast');
    toast.setAttribute('role', 'status');
    toast.append(h(this.doc, 'span', 'sb-dg-toast-text', text));
    if (onUndo) toast.append(this.button('Undo', () => { this.hideToast(); onUndo(); }, false, false));
    this.mount.append(toast);
    this.toast = toast;
    this.timer = setTimeout(() => this.hideToast(), TOAST_MS);
  }

  hideToast() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.toast?.remove();
    this.toast = null;
  }
}

export { digestOf };
