// @ts-check
// ui-src/src/chat/radar-digest.js. Spec 012 R4: the reading radar's digest drawn on a papers result. The summary line above
// the table, a "why read this" line under each title, and row actions, as icons (Add to Zotero or Read later, Like, Dislike), that
// each tell the engine through `radar.feedback` and offer Undo for five seconds. A settled row says what happened and keeps
// an Undo link. The table renderer asks this class for the bits; the words and rules are in radar-digest-data.js.
import { h } from '../dom.js';
import { lucide } from '../icons.js';
import { LOGOS, logoSvg } from '../logos.js';
import { digestOf, keyOf, rowLine, actionList, settledLabel, toastText, outsidePaper } from './radar-digest-data.js';

/** @typedef {import("../host").UiHost} UiHost */
/** @typedef {import("../../../agent/src/domain").PaperRow} PaperRow */
/** @typedef {import("./radar-digest-data.js").Verdict} Verdict */
/** @typedef {import("./radar-digest-data.js").Mark} Mark */

/** The icon a settled row shows beside what happened. @type {Record<Verdict, Mark>} */
const SETTLED_MARK = { added: { logo: 'zotero' }, later: { lucide: 'bookmark' }, liked: { lucide: 'thumbsUp' }, dismissed: { lucide: 'thumbsDown' } };

/** @param {Document} doc @param {Mark} mark */
const markSvg = (doc, mark) => ('logo' in mark ? logoSvg(doc, LOGOS[mark.logo], 14, 'sb-logo sb-dg-mark') : lucide(doc, mark.lucide, 14));

export const TOAST_MS = 5000;
const SETTLED = '.sb-art-row, .sb-art-rowcard, .sbw-paper';  // table row, card, or a paper on Home

export class RadarDigest {
  /** @param {UiHost} host @param {Document} doc @param {HTMLElement} mount the panel, which holds the toast @param {{ routine: string, summary: string }} digest */
  constructor(host, doc, mount, digest) {
    this.host = host;
    this.doc = doc;
    this.mount = mount;
    this.routine = digest.routine;
    this.summary = digest.summary;
    /** @type {Map<string, Verdict>} what was done with each paper, by radar key */
    this.verdicts = new Map();
    /** @type {Map<string, Set<HTMLElement>>} the action boxes drawn for each paper */
    this.boxes = new Map();
    /** @type {Set<string>} papers with a click in flight */
    this.busy = new Set();
    /** @type {HTMLElement | null} */ this.toast = null;
    /** @type {ReturnType<typeof setTimeout> | null} */ this.timer = null;
    this.canAdd = !!host.can.addToLibrary && !!host.addToLibrary;
    void this.load();
  }

  /** Earlier clicks, so a reopened digest still shows them. */
  async load() {
    try {
      const ai = await this.host.ai();
      const done = await ai.radar?.verdicts?.(this.routine);
      for (const [key, verdict] of Object.entries(done ?? {})) if (!this.verdicts.has(key) && verdict !== 'shown') this.verdicts.set(key, verdict);
      for (const key of this.boxes.keys()) this.paint(key);
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
      if (!box.isConnected) { if (/** @type {any} */ (box).__shown) this.boxes.get(key)?.delete(box); continue; }
      /** @type {any} */ (box).__shown = true;
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
      state.append(markSvg(this.doc, SETTLED_MARK[verdict]), this.doc.createTextNode(settledLabel(verdict)));
      box.append(state, this.button('Undo', () => this.undo(row), false, busy, null, 'Take this back'));
      return;
    }
    for (const a of actionList(this.canAdd)) box.append(this.button(a.label, () => this.choose(row, a.verdict), a.primary, busy, a.mark, a.hint, true));
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
        const out = await this.host.addToLibrary?.([outsidePaper(row)]);
        if (!out?.items?.[0]) { this.host.notice("Couldn't add that paper to Zotero."); return; }
      }
      const ai = await this.host.ai();
      await ai.radar.feedback(this.routine, key, verdict);
      this.verdicts.set(key, verdict);
      this.say(toastText(verdict), () => this.undo(row));
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't save that. Try again.");
    } finally {
      this.busy.delete(key);
      this.paint(key);
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
      // Undo takes back what the radar learned. A paper already in Zotero stays there.
      this.say(was === 'added' ? 'Undone. The paper stays in Zotero.' : toastText('undo'));
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't undo that. Try again.");
    } finally {
      this.busy.delete(key);
      this.paint(key);
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
