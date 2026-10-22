// @ts-check
// ui-src/src/chat/papers-chat.js. "Chat with papers" (spec 007 §6, unit E5; Elicit 9.23.41): the side-panel tab beside a
// paper set. Its own composer ("Ask anything about these papers"), a scope line under it ("These 18 papers", with a
// quiet "All 40" toggle), and the turns that were about this result. It is a view of the same conversation: a question
// asked here is an ordinary chat turn (ChatView.askPapers streams it into the thread and into this tab at once), and a
// reopened conversation restores the tab from the stored user records' `on`. The turns are drawn by the chat's own
// renderers (streaming text, activity lines, citation chips), so answers look the same in both places.
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { SUGGESTIONS, TABLE_ASK } from './papers-chat-data.js';

/** @typedef {ReturnType<typeof import("./papers-chat-data.js").chatScope>} Scope */

export class PapersChat {
  /**
   * @param {any} chat the ChatView (askPapers, storedTurnsOn, addUser, addAnswer, paintRecordedAnswer, icon, stop)
   * @param {Document} doc
   * @param {{ scope: () => Scope, setAll: (all: boolean) => void, ref: () => { id: string, version: number } | null }} source
   *   what the panel knows: the scope of a question, the "All N" toggle, and the result on screen
   */
  constructor(chat, doc, source) {
    this.chat = chat;
    this.doc = doc;
    this.source = source;
    /** @type {Map<string, HTMLElement>} one thread per result, kept while the conversation stays open */
    this.threads = new Map();
    /** @type {string | null} */ this.resultId = null;
    /** @type {HTMLElement | null} the answer that currently offers "Make a table from this" */
    this.actionTurn = null;
    this.pinned = true;
    this.root = h(doc, 'div', 'sb-pc');
    this.head = h(doc, 'div', 'sb-pc-head', 'Chat with papers');
    this.scroll = h(doc, 'div', 'sb-pc-scroll');
    this.scroll.addEventListener('scroll', () => { this.pinned = this.scroll.scrollTop + this.scroll.clientHeight >= this.scroll.scrollHeight - 80; });
    this.empty = h(doc, 'div', 'sb-pc-empty');
    this.empty.append(icon(doc, 'chat', 'sb-ai-icon sb-pc-empty-icon'), h(doc, 'div', 'sb-pc-empty-title', 'Ask about these papers'),
      h(doc, 'div', 'sb-pc-empty-text', 'Answers come only from the papers in scope, and say which ones do not address your question.'));
    const pills = h(doc, 'div', 'sb-pc-pills');
    for (const text of SUGGESTIONS) {
      const pill = h(doc, 'button', 'sb-ai-pill sb-pc-pill');
      pill.setAttribute('type', 'button');
      pill.append(h(doc, 'span', '', text));
      pill.title = text;
      pill.addEventListener('click', () => this.submit(text));
      pills.append(pill);
    }
    this.empty.append(pills);
    this.threadBox = h(doc, 'div', 'sb-pc-threads');
    this.scroll.append(this.threadBox, this.empty);

    const composer = h(doc, 'div', 'sb-pc-composer');
    const box = h(doc, 'div', 'sb-pc-box');
    this.input = /** @type {HTMLTextAreaElement} */ (h(doc, 'textarea', 'sb-pc-input'));
    this.input.rows = 2;
    this.input.placeholder = 'Ask anything about these papers';
    this.input.setAttribute('aria-label', 'Ask anything about these papers');
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.submit(); }
    });
    this.input.addEventListener('input', () => { this.fit(); this.syncRunning(); });
    this.send = h(doc, 'button', 'sb-ai-send sb-pc-send');
    this.send.setAttribute('type', 'button');
    this.send.addEventListener('click', () => (this.chat.running ? this.chat.stop() : this.submit()));
    box.append(this.input, this.send);
    this.scope = h(doc, 'div', 'sb-pc-scope');
    this.scopeText = h(doc, 'span', 'sb-pc-scope-text');
    this.scopeToggle = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-pc-scope-toggle'));
    this.scopeToggle.setAttribute('type', 'button');
    this.scopeToggle.addEventListener('click', () => {
      const s = this.source.scope();
      if (s.toggle) { this.source.setAll(s.toggle.to === 'all'); this.renderScope(); }
    });
    this.scope.append(this.scopeText, this.scopeToggle);
    composer.append(box, this.scope);
    this.root.append(this.head, this.scroll, composer);
    this.syncRunning();
    this.renderScope();
  }

  fit() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`;
  }

  /** The tab's own title shows only when the tab is a column (a tab already says its name). @param {boolean} column */
  setColumn(column) {
    this.root.classList.toggle('is-column', column);
  }

  /** Forgets every thread: a different conversation was opened, or a new one started. */
  reset() {
    this.threads.clear();
    this.threadBox.replaceChildren();
    this.resultId = null;
    this.actionTurn = null;
    this.paintEmpty();
  }

  /** Shows the turns about a result, building them from the stored records the first time. @param {string} resultId */
  show(resultId) {
    this.resultId = resultId;
    let thread = this.threads.get(resultId);
    if (!thread) {
      thread = h(this.doc, 'div', 'sb-pc-thread');
      this.threads.set(resultId, thread);
      this.threadBox.append(thread);
      this.restore(resultId, thread);
    }
    for (const [id, el] of this.threads) el.hidden = id !== resultId;
    this.paintEmpty();
    this.renderScope();
  }

  /** @param {string} resultId @param {HTMLElement} thread */
  restore(resultId, thread) {
    const turns = this.chat.storedTurnsOn(resultId);
    let last = null;
    for (const { user, reply } of turns) {
      this.chat.addUser(user.text, [], { on: user.on, into: thread });
      if (reply?.type === 'assistant') last = { turn: this.chat.paintRecordedAnswer(thread, reply), on: user.on };
      else if (reply?.type === 'failed') { this.chat.fail(this.chat.addAnswer(thread), reply.error); last = null; }
    }
    if (last) this.offerTable(last.turn, last.on);
  }

  paintEmpty() {
    const thread = this.resultId ? this.threads.get(this.resultId) : null;
    this.empty.hidden = Boolean(thread && thread.childElementCount);
  }

  /** The scope line under the composer, and whether Send is live. */
  renderScope() {
    const s = this.source.scope();
    this.scopeText.textContent = s.label;
    this.scopeText.title = s.ticked ? 'The papers you ticked' : s.whole ? 'Every paper in this set' : 'The papers showing now';
    this.scopeToggle.hidden = !s.toggle;
    if (s.toggle) this.scopeToggle.textContent = s.toggle.label;
    this.syncRunning();
  }

  /** Send becomes Stop while any answer is coming (the thread's composer and this one share the turn). */
  syncRunning() {
    const running = Boolean(this.chat.running);
    this.send.replaceChildren(icon(this.doc, running ? 'stop' : 'send', 'sb-ai-icon'));
    this.send.setAttribute('aria-label', running ? 'Stop' : 'Send');
    this.send.title = running ? 'Stop the answer' : 'Send (Enter)';
    const ready = this.input.value.trim() && !this.source.scope().empty;
    this.send.dataset.state = running ? 'stop' : ready ? 'ready' : 'idle';
  }

  follow() {
    if (this.pinned) this.scroll.scrollTop = this.scroll.scrollHeight;
  }

  /** @param {string} [given] a suggestion or the table ask; else what is typed @param {any} [onOverride] the scope to reuse (the table ask) */
  async submit(given, onOverride) {
    const text = (given ?? this.input.value).trim();
    const scope = this.source.scope();
    const ref = this.source.ref();
    const thread = this.resultId ? this.threads.get(this.resultId) : null;
    if (!text || this.chat.running || !ref || !thread || scope.empty) return;
    if (given === undefined) { this.input.value = ''; this.fit(); }
    const on = onOverride ?? { result: { id: ref.id, version: ref.version }, rows: scope.rows };
    this.actionTurn?.querySelector('.sb-pc-actions')?.remove();
    this.actionTurn = null;
    this.empty.hidden = true;
    this.pinned = true;
    await this.chat.askPapers(text, on, {
      container: thread, follow: () => this.follow(),
      done: (/** @type {any} */ turn, /** @type {boolean} */ failed) => { if (!failed) this.offerTable(turn, on); this.paintEmpty(); this.follow(); },
    });
    this.syncRunning();
  }

  /** A quiet "Make a table from this" under the newest answer: it asks the chat for a table of the same papers
   *  (spec 007 §1.6). @param {any} turn @param {any} on */
  offerTable(turn, on) {
    const root = /** @type {HTMLElement} */ (turn.root ?? turn);
    if (turn.root?.dataset?.state === 'failed' || turn.cards?.childElementCount) return; // a table was already made
    this.actionTurn?.querySelector('.sb-pc-actions')?.remove();
    const row = h(this.doc, 'div', 'sb-pc-actions');
    const btn = h(this.doc, 'button', 'sb-pc-make', 'Make a table from this');
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', () => { row.remove(); this.submit(TABLE_ASK, on); });
    row.append(btn);
    root.append(row);
    this.actionTurn = root;
  }
}
