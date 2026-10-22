// @ts-nocheck -- UI glue like chat.js; skills-data.js is the checked, tested part.
// ui-src/src/chat/skills-dialog.js. Spec 011 U3: the Skills dialog opened from the composer's `+` menu. Tabs All / By you /
// Built-in with a search box; "Use skill" puts a removable chip in the composer; "Create skill" has three routes: with the
// assistant (one turn drafts a SKILL.md the user edits before saving), upload a .md, or by hand. Skills are text: nothing
// here grants a tool. The list is read again every time the dialog opens, so an edit made in Obsidian shows up here.
import { el, button, installStyle } from './dom-helpers.js';
import { icon } from '../icons.js';
import { TABS, filterSkills, safeName, fieldsFromFile, formProblem, fileFromFields } from './skills-data.js';

export class SkillsDialog {
  /** @param {any} chat the ChatView (doc, host, root) @param {(name: string) => void} onUse */
  constructor(chat, onUse) {
    this.chat = chat;
    this.doc = chat.doc;
    this.onUse = onUse;
    this.tab = 'all';
    this.query = '';
    this.list = [];
    this.root = null;
  }

  get isOpen() { return Boolean(this.root?.isConnected); }

  e(tag, cls, text) { return el(this.doc, tag, cls, text); }

  async open() {
    if (this.isOpen) return;
    SkillsDialog.style(this.doc);
    this.root = this.e('div', 'sb-sk-overlay');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Skills');
    this.root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); this.close(); } });
    this.chat.root.append(this.root);
    await this.showList();
  }

  close() {
    this.root?.remove();
    this.root = null;
    this.chat.input?.focus();
  }

  /** The dialog's frame (title and ×), then `body`. */
  frame(title, body, back) {
    const head = this.e('div', 'sb-sk-head');
    if (back) {
      const b = this.e('button', 'sb-sk-back');
      b.setAttribute('type', 'button');
      b.append(icon(this.doc, 'back', 'sb-ai-icon'), this.e('span', '', 'Skills'));
      b.addEventListener('click', () => this.showList());
      head.append(b);
    }
    const x = this.e('button', 'sb-sk-x');
    x.setAttribute('type', 'button');
    x.setAttribute('aria-label', 'Close');
    x.append(icon(this.doc, 'close', 'sb-ai-icon'));
    x.addEventListener('click', () => this.close());
    head.append(this.e('span', 'sb-sk-title', title), this.e('span', 'sb-ed-spacer'), x);
    const card = this.e('div', 'sb-sk-card');
    card.append(head, body);
    this.root.replaceChildren(card);
  }

  async service() {
    const ai = await this.chat.host.ai();
    if (!ai.skills) throw new Error('Skills need the updated Second Brain server. Restart it and try again.');
    return ai.skills;
  }

  // ------------------------------------------------------------------ the list

  async showList() {
    const body = this.e('div', 'sb-sk-body');
    const bar = this.e('div', 'sb-sk-bar');
    const tabs = this.e('div', 'sb-sk-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of TABS) {
      const t = this.e('button', `sb-sk-tab${this.tab === id ? ' is-on' : ''}`, label);
      t.setAttribute('type', 'button');
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(this.tab === id));
      t.dataset.tab = id;
      t.addEventListener('click', () => { this.tab = id; this.paintList(); for (const o of tabs.children) { o.classList.toggle('is-on', o.dataset.tab === id); o.setAttribute('aria-selected', String(o.dataset.tab === id)); } });
      tabs.append(t);
    }
    this.search = this.e('input', 'sb-sk-search');
    this.search.type = 'text';
    this.search.placeholder = 'Search skills';
    this.search.value = this.query;
    this.search.addEventListener('input', () => { this.query = this.search.value; this.paintList(); });
    const create = button(this.doc, 'Create skill', () => this.showCreate(), true);
    create.classList.add('sb-sk-create');
    bar.append(tabs, this.search, create);
    this.rows = this.e('div', 'sb-sk-rows');
    this.status = this.e('div', 'sb-sk-status');
    body.append(bar, this.status, this.rows);
    this.frame('Skills', body, false);
    try {
      this.list = await (await this.service()).list();
      this.paintList();
    } catch (error) {
      this.status.textContent = String(error?.message ?? error);
      this.status.classList.add('is-error');
    }
  }

  paintList() {
    this.rows.replaceChildren();
    const shown = filterSkills(this.list, this.tab, this.query);
    if (!shown.length) {
      this.rows.append(this.e('div', 'sb-sk-empty', this.query.trim() || (this.tab === 'mine' && !this.list.some((x) => x.source === 'user')) ? (this.query.trim() ? 'No skill matches.' : 'No skills yet. Use Create skill to write one.') : 'No skills here.'));
      return;
    }
    for (const skill of shown) this.rows.append(this.row(skill));
  }

  row(skill) {
    const row = this.e('div', `sb-sk-row${skill.warning ? ' is-broken' : ''}`);
    row.dataset.name = skill.name;
    const text = this.e('div', 'sb-sk-text');
    const title = this.e('div', 'sb-sk-name');
    title.append(this.e('span', 'sb-sk-name-text', skill.name), this.e('span', 'sb-sk-badge', skill.source === 'builtin' ? 'Built-in' : 'By you'));
    text.append(title);
    if (skill.warning) text.append(this.e('div', 'sb-sk-warn', `Can't be used: ${skill.warning}`));
    else text.append(this.e('div', 'sb-sk-desc', skill.description));
    const actions = this.e('div', 'sb-sk-actions');
    const use = button(this.doc, 'Use skill', () => { this.onUse(skill.name); this.close(); }, true);
    use.classList.add('sb-sk-use');
    use.disabled = Boolean(skill.warning);
    actions.append(use, button(this.doc, skill.source === 'builtin' ? 'View' : 'Edit', () => this.showEdit(skill)));
    if (skill.source === 'user') actions.append(button(this.doc, 'Delete', () => this.remove(skill)));
    row.append(text, actions);
    return row;
  }

  async remove(skill) {
    try {
      await (await this.service()).remove(skill.name);
      await this.showList();
      this.status.textContent = `“${skill.name}” was moved to the vault's .trash folder.`;
    } catch (error) {
      this.status.textContent = String(error?.message ?? error);
      this.status.classList.add('is-error');
    }
  }

  // ------------------------------------------------------------------ creating

  showCreate() {
    const body = this.e('div', 'sb-sk-body');
    body.append(this.e('div', 'sb-sk-hint', 'A skill is a short set of instructions you attach to a question, such as the shape of a report or how to compare options. It never gives the assistant new abilities.'));
    const routes = this.e('div', 'sb-sk-routes');
    const route = (cls, label, hint, run) => {
      const b = this.e('button', `sb-sk-route ${cls}`);
      b.setAttribute('type', 'button');
      b.append(this.e('span', 'sb-sk-route-label', label), this.e('span', 'sb-sk-route-hint', hint));
      b.addEventListener('click', run);
      routes.append(b);
    };
    route('is-assistant', 'With the assistant', 'Describe it in a sentence; the assistant drafts it and you edit before saving.', () => this.showAssistant());
    route('is-upload', 'Upload a .md file', 'A SKILL.md, or any Markdown file with instructions.', () => this.pickFile());
    route('is-hand', 'By hand', 'Write the name, description and instructions yourself.', () => this.showEdit(null));
    body.append(routes);
    this.frame('Create skill', body, true);
  }

  showAssistant() {
    const body = this.e('div', 'sb-sk-body');
    body.append(this.e('label', 'sb-sk-label', 'What should the skill do?'));
    const box = this.e('textarea', 'sb-sk-text-in');
    box.rows = 4;
    box.placeholder = 'For example: summarize each paper in two sentences, then list what they disagree on.';
    const status = this.e('div', 'sb-sk-status');
    const go = button(this.doc, 'Draft it', async () => {
      if (!box.value.trim()) { status.textContent = 'Say what the skill is for.'; return; }
      go.disabled = true;
      status.classList.remove('is-error');
      status.textContent = 'Drafting…';
      try {
        const draft = await (await this.service()).draft(box.value.trim());
        this.showEdit(null, { ...fieldsFromFile(draft.text, draft.name), note: 'Drafted by the assistant. Read it, change what you like, then save.' });
      } catch (error) {
        go.disabled = false;
        status.textContent = String(error?.message ?? error);
        status.classList.add('is-error');
      }
    }, true);
    go.classList.add('sb-sk-draft');
    body.append(box, status, go);
    this.frame('Draft with the assistant', body, true);
    box.focus();
  }

  /** The browser's file chooser; the chosen file goes to takeUpload. */
  pickFile() {
    const input = this.e('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try { this.takeUpload(await file.text(), file.name); } catch (error) { this.host_error(error); }
    });
    input.click();
  }

  host_error(error) { this.chat.host.logError?.(error); this.chat.host.notice?.(String(error?.message ?? error)); }

  /** An uploaded file's text becomes the editor's fields, to check before saving. */
  takeUpload(text, filename) {
    if (text.length > 64_000) { this.chat.host.notice?.('That file is too large for a skill (the limit is 64 KB).'); return; }
    this.showEdit(null, { ...fieldsFromFile(text, filename), note: 'Check the name and instructions, then save.' });
  }

  // ------------------------------------------------------------------ editing

  /** `skill`: a listed one to edit/view, or null for a new one. `preset`: fields (and a note) to start from. */
  async showEdit(skill, preset) {
    let fields = preset ?? { name: '', description: '', instructions: '' };
    let readOnly = false;
    let editing = null;
    if (skill) {
      try {
        const full = await (await this.service()).get(skill.name);
        const text = full?.text ?? '';
        fields = fieldsFromFile(text, skill.name);
        if (skill.warning || !full?.text) fields.name = skill.name;
      } catch (error) { this.host_error(error); return; }
      readOnly = skill.source === 'builtin';
      editing = readOnly ? null : skill.name;
    }
    const body = this.e('div', 'sb-sk-body');
    if (fields.note) body.append(this.e('div', 'sb-sk-hint', fields.note));
    if (skill?.warning) body.append(this.e('div', 'sb-sk-warn', `This file can't be used yet: ${skill.warning}`));
    const field = (label, node) => { const w = this.e('label', 'sb-sk-field'); w.append(this.e('span', 'sb-sk-label', label), node); return w; };
    const name = this.e('input', 'sb-sk-in sb-sk-in-name'); name.type = 'text'; name.value = fields.name; name.maxLength = 64;
    const description = this.e('input', 'sb-sk-in sb-sk-in-desc'); description.type = 'text'; description.value = fields.description; description.placeholder = 'One line: when to use it';
    const instructions = this.e('textarea', 'sb-sk-text-in sb-sk-in-body'); instructions.rows = 12; instructions.value = fields.instructions;
    instructions.placeholder = 'What to do and what the answer should look like.';
    for (const n of [name, description, instructions]) { n.readOnly = readOnly; }
    if (editing) name.readOnly = true; // a rename would leave the old folder behind; copy it instead
    const status = this.e('div', 'sb-sk-status');
    const actions = this.e('div', 'sb-sk-actions is-form');
    if (readOnly) {
      actions.append(button(this.doc, 'Use skill', () => { this.onUse(skill.name); this.close(); }, true),
        button(this.doc, 'Copy to edit', () => this.showEdit(null, { ...fields, name: `${fields.name} copy`, note: 'This is your own copy. Change it, then save.' })));
    } else {
      const save = button(this.doc, 'Save skill', async () => {
        const f = { name: name.value, description: description.value, instructions: instructions.value };
        const taken = editing ? [] : this.list.filter((s) => s.source === 'user').map((s) => s.name);
        const problem = formProblem(f, taken);
        if (problem) { status.textContent = problem; status.classList.add('is-error'); return; }
        save.disabled = true;
        try {
          await (await this.service()).put(f.name.trim(), fileFromFields(f));
          await this.showList();
          this.status.textContent = `Saved “${f.name.trim()}”.`;
        } catch (error) {
          save.disabled = false;
          status.textContent = String(error?.message ?? error);
          status.classList.add('is-error');
        }
      }, true);
      save.classList.add('sb-sk-save');
      actions.append(save, button(this.doc, 'Cancel', () => this.showList()));
    }
    body.append(field('Name', name), field('Description', description), field('Instructions', instructions), status, actions);
    this.frame(readOnly ? skill.name : editing ? `Edit ${skill.name}` : 'New skill', body, true);
  }

  static style(doc) {
    installStyle(doc, 'second-brain-skills-style', SKILLS_CSS);
  }
}

// Obsidian gives every button a nowrap label, a fill and a fixed height: the long names and hints here need `white-space: normal`.
const SKILLS_CSS = `
.sb-ai { position: relative; }
.sb-sk-overlay { position: absolute; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box;
	background: color-mix(in srgb, var(--sb-ui-bg) 70%, transparent); }
.sb-sk-card { display: flex; flex-direction: column; width: min(640px, 100%); max-height: 100%; box-sizing: border-box; border-radius: 10px;
	border: 1px solid var(--sb-ui-line); background: var(--sb-ui-bg); color: var(--sb-ui-text); font-size: 13px; overflow: hidden; }
.sb-sk-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--sb-ui-line); }
.sb-sk-title { font-size: 15px; font-weight: 600; }
.sb-sk-body { display: flex; flex-direction: column; gap: 10px; padding: 12px; overflow-y: auto; min-height: 0; }
.sb-sk-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sb-sk-tabs { display: flex; gap: 2px; }
.sb-sk .sb-sk-tab, .sb-ai .sb-sk-tab, .sb-ai .sb-sk-back, .sb-ai .sb-sk-x, .sb-ai .sb-sk-route { white-space: normal; height: auto; box-shadow: none; font: inherit; color: var(--sb-ui-muted); background: transparent; border: none; cursor: pointer; }
.sb-ai .sb-sk-tab { padding: 4px 10px; border-radius: 12px; }
.sb-ai .sb-sk-tab.is-on { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-ai .sb-sk-back { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px; }
.sb-ai .sb-sk-x { padding: 2px 4px; }
.sb-sk-search, .sb-sk-in, .sb-sk-text-in { font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--sb-ui-line); background: var(--sb-ui-bg); color: var(--sb-ui-text); outline: none; box-shadow: none; box-sizing: border-box; }
.sb-sk-search { flex: 1; min-width: 120px; }
.sb-sk-search:focus, .sb-sk-in:focus, .sb-sk-text-in:focus { border-color: var(--sb-ui-accent); }
.sb-sk-in, .sb-sk-text-in { width: 100%; }
.sb-sk-text-in { resize: vertical; line-height: 1.4; }
.sb-sk-rows { display: flex; flex-direction: column; gap: 6px; }
.sb-sk-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--sb-ui-line); border-radius: 8px; }
.sb-sk-row.is-broken { border-color: var(--sb-ui-danger); }
.sb-sk-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sb-sk-name { display: flex; align-items: center; gap: 6px; font-weight: 600; min-width: 0; }
.sb-sk-name-text { overflow-wrap: anywhere; }
.sb-sk-badge { flex: none; font-size: 10.5px; font-weight: 400; color: var(--sb-ui-faint); border: 1px solid var(--sb-ui-line); border-radius: 8px; padding: 0 6px; }
.sb-sk-desc { color: var(--sb-ui-muted); overflow-wrap: anywhere; }
.sb-sk-warn { color: var(--sb-ui-danger); overflow-wrap: anywhere; }
.sb-sk-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.sb-sk-actions .sb-button { white-space: normal; }
.sb-sk-actions.is-form { justify-content: flex-start; }
.sb-sk-hint, .sb-sk-status, .sb-sk-empty { color: var(--sb-ui-muted); font-size: 12px; overflow-wrap: anywhere; }
.sb-sk-status:empty { display: none; }
.sb-sk-status.is-error { color: var(--sb-ui-danger); }
.sb-sk-routes { display: flex; flex-direction: column; gap: 6px; }
.sb-ai .sb-sk-route { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: start; padding: 10px 12px; border: 1px solid var(--sb-ui-line); border-radius: 8px; color: var(--sb-ui-text); }
.sb-ai .sb-sk-route:hover { background: var(--sb-ui-hover); }
.sb-sk-route-label { font-weight: 600; }
.sb-sk-route-hint { color: var(--sb-ui-muted); font-size: 12px; }
.sb-sk-field { display: flex; flex-direction: column; gap: 3px; }
.sb-sk-label { font-size: 11.5px; color: var(--sb-ui-muted); }
.sb-sk-bar .sb-button, .sb-sk-card .sb-button { white-space: normal; }
@media (max-width: 480px) { .sb-sk-row { flex-direction: column; align-items: stretch; } .sb-sk-actions { justify-content: flex-start; } }
`;
