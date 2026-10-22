// @ts-nocheck -- UI glue like chat.js; host.d.ts's ContextCandidate is the checked shape.
// ui-src/src/chat/picker.js. The `+`/`@` context picker (spec 008 C3, after Copilot's AtMentionTypeahead): one
// searchable list of notes, papers and collections from host.contextCandidates(), ranked by fuzzy.js. Opened
// by the `+` button (with its own search box) or by typing `@` in the message (the text after it is the
// query, and choosing a row removes that "@query").
import { el } from './dom-helpers.js';
import { icon } from '../icons.js';
import { rankCandidates } from './fuzzy.js';

const CATEGORY_ICON = { note: 'note', paper: 'paper', collection: 'duplicate' };

export class ContextPicker {
  /** @param {any} view the ChatView @param {(candidate: import("../host").ContextCandidate) => void} onPick */
  constructor(view, onPick) {
    this.view = view;
    this.doc = view.doc;
    this.onPick = onPick;
    /** How it was opened ('@' or '+'), where the "@" sits in the message, and what the user is choosing from. */
    this.state = { via: null, anchor: -1, query: '', candidates: Promise.resolve([]), rows: [], active: 0 };
    this.root = el(this.doc, 'div', 'sb-ai-picker');
    this.root.hidden = true;
    this.search = el(this.doc, 'input', 'sb-ai-picker-search');
    this.search.type = 'text';
    this.search.placeholder = 'Search notes, papers and collections';
    this.search.addEventListener('input', () => this.setQuery(this.search.value));
    this.search.addEventListener('keydown', (event) => { this.handleKey(event); });
    this.list = el(this.doc, 'div', 'sb-ai-picker-list');
    this.list.setAttribute('role', 'listbox');
    const more = el(this.doc, 'button', 'sb-ai-picker-more', 'Search all papers…');
    more.addEventListener('mousedown', (event) => event.preventDefault());
    more.addEventListener('click', () => { this.close(); this.view.pickPapers(); });
    // spec 011 U3: Skills lives in the `+` menu beside Add from library
    const skills = el(this.doc, 'button', 'sb-ai-picker-more sb-ai-picker-skills', 'Skills…');
    skills.addEventListener('mousedown', (event) => event.preventDefault());
    skills.addEventListener('click', () => { this.close(); this.view.skillsDialog.open(); });
    this.skillsRow = skills;
    this.root.append(this.search, this.list, more, skills);
  }

  get isOpen() { return !this.root.hidden; }

  /** @param {'@' | '+'} via @param {string} [query] @param {number} [anchor] */
  open(via, query = '', anchor = -1) {
    Object.assign(this.state, { via, anchor });
    this.state.candidates = this.view.host.contextCandidates().catch((error) => { this.view.host.logError(error); return []; });
    this.root.hidden = false;
    this.search.hidden = via === '@';
    this.skillsRow.hidden = via === '@' || !this.view.skillsApply;
    this.search.value = '';
    if (via === '+') this.search.focus();
    this.setQuery(query);
  }

  close() {
    this.root.hidden = true;
    this.state.via = null;
  }

  async setQuery(query) {
    this.state.query = query;
    const candidates = await this.state.candidates;
    if (this.state.query !== query || !this.isOpen) return;
    const groups = rankCandidates(candidates, query);
    this.state.rows = groups.flatMap((g) => g.items);
    this.state.active = 0;
    this.render(groups);
  }

  render(groups) {
    this.list.replaceChildren();
    if (!groups.length) this.list.append(el(this.doc, 'div', 'sb-ai-picker-empty', 'Nothing matches'));
    let index = 0;
    for (const group of groups) {
      this.list.append(el(this.doc, 'div', 'sb-ai-picker-group', group.heading));
      for (const item of group.items) {
        const row = el(this.doc, 'button', 'sb-ai-picker-item');
        row.setAttribute('role', 'option');
        row.dataset.index = String(index++);
        row.append(icon(this.doc, CATEGORY_ICON[item.category] ?? 'note', 'sb-ai-icon'), el(this.doc, 'span', 'sb-ai-picker-label', item.label));
        if (item.detail) row.append(el(this.doc, 'span', 'sb-ai-picker-detail', item.detail));
        row.title = item.detail ? `${item.label}\n${item.detail}` : item.label;
        row.addEventListener('mousedown', (event) => event.preventDefault()); // keep the caret in the message
        row.addEventListener('click', () => this.choose(item));
        this.list.append(row);
      }
    }
    this.markActive();
  }

  markActive() {
    for (const row of this.list.querySelectorAll('.sb-ai-picker-item')) {
      const on = Number(row.dataset.index) === this.state.active;
      row.setAttribute('aria-selected', String(on));
      if (on) row.scrollIntoView?.({ block: 'nearest' });
    }
  }

  choose(item) {
    const input = this.view.input;
    if (this.state.via === '@') {
      const caret = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, this.state.anchor) + input.value.slice(caret);
      input.setSelectionRange(this.state.anchor, this.state.anchor);
    }
    this.close();
    this.onPick(item);
    input.focus();
    this.view.fitInput();
    this.view.renderSend();
  }

  /** Called on every edit of the message: an "@word" right before the caret opens or narrows the picker. */
  followInput() {
    const input = this.view.input;
    const caret = input.selectionStart ?? input.value.length;
    const match = /(^|\s)@([^\s@]*)$/.exec(input.value.slice(0, caret));
    if (match) {
      const anchor = caret - match[2].length - 1;
      if (this.state.via === '@' && this.state.anchor === anchor) this.setQuery(match[2]);
      else this.open('@', match[2], anchor);
    } else if (this.state.via === '@') this.close();
  }

  /** Arrow keys, Enter/Tab and Escape while open. Returns true when it used the key. @param {KeyboardEvent} event */
  handleKey(event) {
    if (!this.isOpen || event.isComposing) return false;
    const { rows } = this.state;
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) {
      this.state.active = (this.state.active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      this.markActive();
    } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && rows.length) {
      this.choose(rows[this.state.active]);
    } else if (event.key === 'Escape') {
      this.close();
      this.view.input.focus();
    } else {
      if (event.key === 'Enter' && this.state.via === '@') this.close();
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
}
