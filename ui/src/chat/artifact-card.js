// @ts-check
// ui-src/src/chat/artifact-card.js. The card a result leaves in the thread (spec 007 §4, Elicit 9.21.56): a small
// icon tile, the title, "Table · 9 rows · V2" (or "Papers · 40 · 2 columns · V1"), and on hover two quiet icons,
// download and open. A card for an older version says "V1 · a newer version exists". Clicking the card opens the
// panel; the card holds no result body, only the summary the engine sent.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { cardMeta, KIND_ICON } from './artifact-data.js';

/** @typedef {import("../../../agent/src/domain").ResultSummary} ResultSummary */

export class ArtifactCard {
  /**
   * @param {Document} doc
   * @param {ResultSummary} summary the version this card was made for
   * @param {{ onOpen: (ref: ResultSummary["ref"]) => void, onDownload?: (ref: ResultSummary["ref"]) => void }} actions
   *   `onDownload` is left out when the host can't save anything (the icon is then not drawn).
   */
  constructor(doc, summary, actions) {
    this.doc = doc;
    this.summary = summary;
    this.actions = actions;
    this.older = false;
    this.root = h(doc, 'div', 'sb-art-card');
    this.root.setAttribute('role', 'button');
    this.root.setAttribute('tabindex', '0');
    this.thumb = h(doc, 'span', 'sb-art-card-thumb');
    this.title = h(doc, 'span', 'sb-art-card-title');
    this.meta = h(doc, 'span', 'sb-art-card-meta');
    const text = h(doc, 'span', 'sb-art-card-text');
    text.append(this.title, this.meta);
    const acts = h(doc, 'span', 'sb-art-card-acts');
    if (actions.onDownload) acts.append(this.action('download', 'Download', () => actions.onDownload?.(this.summary.ref)));
    acts.append(this.action('open', 'Open', () => actions.onOpen(this.summary.ref)));
    this.root.append(this.thumb, text, acts);
    this.root.addEventListener('click', () => actions.onOpen(this.summary.ref));
    this.root.addEventListener('keydown', (event) => {
      if (event.target === this.root && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); actions.onOpen(this.summary.ref); }
    });
    this.paint();
  }

  /** @param {string} name @param {string} label @param {() => void} run */
  action(name, label, run) {
    const btn = h(this.doc, 'button', 'sb-art-card-act');
    btn.setAttribute('type', 'button');
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.append(icon(this.doc, name, 'sb-ai-icon'));
    btn.addEventListener('click', (event) => { event.stopPropagation(); run(); });
    return btn;
  }

  paint() {
    const { summary } = this;
    this.thumb.replaceChildren(icon(this.doc, KIND_ICON[summary.kind] ?? 'table', 'sb-ai-icon'));
    this.title.textContent = summary.title;
    this.meta.textContent = cardMeta(summary, summary.ref.version, this.older);
    this.root.classList.toggle('is-older', this.older);
    this.root.setAttribute('aria-label', `${summary.title}. ${this.meta.textContent}`);
  }

  /** A newer version of this result was written: this card now says so. @param {number} latest */
  setLatest(latest) {
    this.older = latest > this.summary.ref.version;
    this.paint();
  }
}
