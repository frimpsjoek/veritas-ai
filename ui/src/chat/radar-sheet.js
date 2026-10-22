// @ts-nocheck -- UI glue like routines-view.js; radar-data.js is the checked, tested part.
// ui-src/src/chat/radar-sheet.js. Spec 012 R2: the Reading radar setup sheet, a sibling of RoutineSheet. One overlay on the
// chat with six sections (Name and scope, Profile, Sources, Size, When) as hairline rows and one filled button (Save). The
// profile is seeded from the library by `ai.radar.profile`; what the user pastes under Sources goes through
// `ai.radar.checkSource`. Saving creates or updates a routine of kind "radar". The look follows the web board's ledger:
// type over boxes, radii 6 / 12, one accent, two type sizes.
import { el, button, installStyle } from './dom-helpers.js';
import { SkillsDialog } from './skills-dialog.js';
import { CollectionTree } from './collection-tree.js';
import { icon } from '../icons.js';
import { whenRowMethods, installWhenStyle } from './when-row.js';
import { scheduleFromWhen, projectChoices } from './routines-data.js';
import {
  DATABASES, SIZE_DEFAULTS, newForm, formFromRoutine, mergeSeed, addEntry, removeAt, matchLine, statusLine, checkNotice, addFeed, addJournal,
  mcpChoices, mergeMcp, radarProblem, draftFromForm, sizeDefaults, learnedFor, afterUnlearn, learnedNote, learningText, learningOf,
} from './radar-data.js';

/** The engine's radar API, or a plain message when the server is too old or absent. @param {any} chat */
async function radarService(chat) {
  const ai = await chat.host.ai();
  if (!ai.radar) throw new Error('The reading radar needs the updated Veritas server. Restart it and try again.');
  return ai.radar;
}

export class RadarSheet {
  /** @param {any} chat @param {{ routine?: any, onSaved?: () => void, projects?: any[] }} opts */
  constructor(chat, { routine, onSaved, projects }) {
    this.chat = chat;
    this.doc = chat.doc;
    this.routine = routine ?? null;
    this.onSaved = onSaved;
    this.status = routine?.radarStatus ?? {};
    this.learned = routine?.radarLearned ?? [];
    this.learning = learningOf(routine);
    this.projectList = projects ?? chat.projects ?? [];
    this.projectChoice = projectChoices(this.projectList, routine?.project, chat.projectId, !routine);
    this.form = routine ? formFromRoutine(routine) : newForm({ project: this.projectChoice.selected || null });
    this.profileNote = '';
    this.checking = false;
    this.check = null;
    this.root = null;
    // The same When row as a routine's; a size the user has not touched follows the schedule (daily 8 + 1, weekly 15 + 5).
    this.when = this.form.when;
    this.paintWhen = whenRowMethods.paintWhen;
    this.syncPreview = () => { whenRowMethods.syncPreview.call(this); this.followSize(); };
  }

  e(tag, cls, text) { return el(this.doc, tag, cls, text); }

  open() {
    RadarSheet.style(this.doc);
    SkillsDialog.style(this.doc);
    this.root = this.e('div', 'sb-sk-overlay sb-ra-overlay');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', this.routine ? 'Edit reading radar' : 'New reading radar');
    this.root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); this.close(); } });
    this.chat.root.append(this.root);
    this.paint();
    this.nameInput.focus();
    void this.loadMcp();
    if (!this.routine) void this.seed();
  }

  close() {
    this.root?.remove();
    this.root = null;
  }

  static style(doc) {
    installStyle(doc, 'second-brain-radar-style', RADAR_CSS);
    installWhenStyle(doc);
  }

  section(title, ...nodes) {
    const s = this.e('section', 'sb-ra-section');
    s.append(this.e('h3', 'sb-ra-h', title), ...nodes);
    return s;
  }

  /** A hairline row: main text with an optional muted line, then controls. */
  row(main, meta, ...controls) {
    const r = this.e('div', 'sb-ra-row');
    const text = this.e('div', 'sb-ra-main');
    text.append(typeof main === 'string' ? this.e('span', 'sb-ra-title', main) : main);
    if (meta) text.append(this.e('span', 'sb-ra-meta', meta));
    r.append(text, ...controls);
    return r;
  }

  link(label, onClick, cls = '') {
    const b = this.e('button', `sb-ra-link ${cls}`.trim(), label);
    b.setAttribute('type', 'button');
    b.addEventListener('click', onClick);
    return b;
  }

  remove(label, onClick) {
    const x = this.e('button', 'sb-ra-x');
    x.setAttribute('type', 'button');
    x.setAttribute('aria-label', label);
    x.title = label;
    x.append(icon(this.doc, 'close', 'sb-ai-icon'));
    x.addEventListener('click', onClick);
    return x;
  }

  paint() {
    const f = this.form;
    const body = this.e('div', 'sb-sk-body sb-ra-body');

    this.nameInput = this.e('input', 'sb-sk-in sb-ra-name');
    this.nameInput.type = 'text'; this.nameInput.value = f.name; this.nameInput.maxLength = 80;
    this.nameInput.setAttribute('aria-label', 'Name');
    this.nameInput.addEventListener('input', () => { f.name = this.nameInput.value; });
    this.scopeBox = this.e('div', 'sb-ra-scope');
    body.append(this.section('Name', this.nameInput), this.section('Where to read from', this.scopeBox));
    this.paintScope();

    this.profileBox = this.e('div', 'sb-ra-profile');
    body.append(this.section('Profile', this.profileBox));
    this.paintProfile();

    this.sourcesBox = this.e('div', 'sb-ra-sources');
    body.append(this.section('Sources', this.sourcesBox));
    this.paintSources();

    this.sizeBox = this.e('div', 'sb-ra-size');
    body.append(this.section('Size', this.sizeBox));
    this.paintSize();

    this.whenBox = this.e('div', 'sb-rt-when');
    this.paintWhen();
    body.append(this.section('When', this.whenBox));

    this.message = this.e('div', 'sb-sk-status');
    const actions = this.e('div', 'sb-sk-actions is-form');
    this.saveButton = button(this.doc, this.routine ? 'Save changes' : 'Create radar', () => this.save(), true);
    this.saveButton.classList.add('sb-ra-save');
    actions.append(this.saveButton, button(this.doc, 'Cancel', () => this.close()));
    body.append(this.message, actions);

    const head = this.e('div', 'sb-sk-head');
    const x = this.remove('Close', () => this.close());
    head.append(this.e('span', 'sb-sk-title', this.routine ? 'Edit reading radar' : 'Reading radar'), this.e('span', 'sb-ed-spacer'), x);
    const card = this.e('div', 'sb-sk-card sb-ra-card');
    card.append(head, body);
    this.root.replaceChildren(card);
  }

  // ---- scope ----

  paintScope() {
    const f = this.form;
    this.scopeBox.replaceChildren();
    if (this.chat.host.can?.scopes) {
      const pick = this.e('select', 'sb-sk-in sb-ra-scope-pick');
      for (const [v, l] of [['library', 'The whole library'], ['collections', 'Some collections']]) { const o = this.e('option', '', l); o.value = v; pick.append(o); }
      pick.value = f.scope.kind;
      pick.addEventListener('change', () => {
        f.scope = pick.value === 'collections' ? { kind: 'collections', keys: this.tree?.getKeys() ?? [] } : { kind: 'library' };
        this.paintScope();
      });
      this.scopeBox.append(pick);
      if (f.scope.kind === 'collections') {
        const wrap = this.e('div', 'sb-ra-tree');
        this.scopeBox.append(wrap);
        Promise.resolve(this.chat.host.collections()).then((nodes) => {
          if (!wrap.isConnected) return;
          CollectionTree.style(this.doc);
          this.tree = new CollectionTree(this.doc, nodes ?? [], f.scope.keys, () => { f.scope = { kind: 'collections', keys: this.tree.getKeys() }; });
          wrap.append(this.tree.root);
        }).catch((error) => this.chat.host.logError?.(error));
      }
    } else {
      this.scopeBox.append(this.e('span', 'sb-ra-meta', 'The whole library'));
    }
    if (this.projectChoice.options.length) {
      const pick = this.e('select', 'sb-sk-in sb-ra-project');
      pick.setAttribute('aria-label', 'Project');
      for (const o of this.projectChoice.options) { const opt = this.e('option', '', o.id ? `Project: ${o.label}` : 'No project'); opt.value = o.id; pick.append(opt); }
      pick.value = f.project ?? '';
      pick.addEventListener('change', () => { f.project = pick.value || null; });
      this.scopeBox.append(pick);
    }
  }

  // ---- profile ----

  async seed() {
    this.profileNote = 'Reading your library…';
    this.paintProfile();
    try {
      const profile = await (await radarService(this.chat)).profile(this.form.scope);
      this.form.profile = mergeSeed(this.form.profile, profile);
      this.profileNote = profile.topics.length ? '' : 'Your library did not suggest any topics. Add the ones you follow.';
    } catch (error) {
      this.profileNote = `Could not read your library: ${String(error?.message ?? error)}`;
    }
    if (this.root) this.paintProfile();
  }

  paintProfile() {
    const f = this.form;
    const box = this.profileBox;
    box.replaceChildren();
    const bar = this.e('div', 'sb-ra-bar');
    bar.append(this.e('span', `sb-ra-meta${this.profileNote.startsWith('Could not') ? ' is-error' : ''}`, this.profileNote || (this.routine ? 'What this radar looks for.' : 'Suggested from your library. Remove what is wrong and add what is missing.')), this.e('span', 'sb-ed-spacer'), this.link('Refresh from library', () => this.seed(), 'sb-ra-refresh'));
    box.append(bar);
    const lists = [
      ['topics', 'Topics', 'text', 'Add a topic', (t) => this.topicRow(t)],
      ['authors', 'Authors', 'name', 'Add an author', (a) => this.followedRow(a, `author:${a.openalexId}`, 'authors')],
      ['journals', 'Journals', 'name', 'Add a journal', (j) => this.followedRow(j, `journal:${j.openalexId}`, 'journals')],
    ];
    for (const [key, label, field, placeholder, render] of lists) {
      const group = this.e('div', 'sb-ra-group');
      group.dataset.list = key;
      group.append(this.e('div', 'sb-ra-sub', f.profile[key].length ? `${label} (${f.profile[key].length})` : label));
      for (const item of f.profile[key]) group.append(render(item));
      if (key === 'topics' && this.learning.length) group.append(this.row(this.e('span', 'sb-ra-title', 'Learning\u2026'), this.learning.map(learningText).join(' \u00B7 ')));
      group.append(this.adder(placeholder, (value) => {
        const out = addEntry(f.profile[key], field, value);
        if (out.added) { f.profile[key] = out.list; if (key !== 'topics') void this.matchNew(key); this.paintProfile(); }
        return out.added;
      }));
      box.append(group);
    }
  }

  /** A topic. One the radar learned says so, and its Remove also tells the radar never to learn it again (spec 017). */
  topicRow(t) {
    const f = this.form;
    const drop = () => { f.profile.topics = removeAt(f.profile.topics, f.profile.topics.indexOf(t)); this.paintProfile(); };
    if (t.origin !== 'learned') return this.row(t.text, null, this.remove(`Remove ${t.text}`, drop));
    const name = this.e('span', 'sb-ra-title', t.text);
    const tag = this.e('span', 'sb-ra-tag', 'learned');
    tag.title = learnedNote(t);
    name.append(' ', tag);
    return this.row(name, learnedNote(t), this.remove(`Remove ${t.text}`, async () => {
      try {
        if (this.routine?.id) await (await radarService(this.chat)).forgetTopic(this.routine.id, t.text);
        drop();
      } catch (error) {
        this.profileNote = `Could not remove that: ${String(error?.message ?? error)}`;
        if (this.root) this.paintProfile();
      }
    }));
  }

  followedRow(item, statusKey, key) {
    const line = [matchLine(item), statusLine(this.status[statusKey])].filter(Boolean).join(' · ');
    const mine = learnedFor(this.learned, key, item.name);
    const name = this.e('span', 'sb-ra-title', item.name);
    const controls = [this.remove(`Remove ${item.name}`, () => { this.form.profile[key] = removeAt(this.form.profile[key], this.form.profile[key].indexOf(item)); this.paintProfile(); })];
    if (item.origin === 'learned' || mine.length) {
      const tag = this.e('span', 'sb-ra-tag', 'learned');
      tag.title = mine.length ? `The radar added this after you added “${mine.at(-1).title}”.` : 'The radar added this itself.';
      name.append(' ', tag);
    }
    if (mine.length && this.routine) controls.unshift(this.link('Undo', () => this.unlearn(mine.at(-1)), 'sb-ra-unlearn'));
    return this.row(name, line, ...controls);
  }

  /** Takes back what the radar learned from one paper (its whole verdict, as Undo in the digest does), then shows the server's lists. */
  async unlearn(entry) {
    try {
      await (await radarService(this.chat)).feedback(this.routine.id, entry.paper, 'undo');
      const fresh = (await (await this.chat.host.ai()).routines.list()).find((r) => r.id === this.routine.id);
      this.learned = fresh?.radarLearned ?? [];
      for (const key of ['authors', 'journals']) this.form.profile[key] = afterUnlearn(fresh?.radar?.profile?.[key] ?? [], this.form.profile[key]);
      this.profileNote = '';
    } catch (error) {
      this.profileNote = `Could not undo that: ${String(error?.message ?? error)}`;
    }
    if (this.root) this.paintProfile();
  }

  /** A person or journal the user typed gets its OpenAlex match the same way a suggested one does: the journal lookup is `checkSource` by name. */
  async matchNew(key) {
    const item = this.form.profile[key].at(-1);
    if (!item || item.openalexId) return;
    if (key === 'journals') {
      try {
        const out = await (await radarService(this.chat)).checkSource(item.name);
        const hit = out.kind === 'journal' ? out : out.kind === 'journals' ? out.options[0] : null;
        if (hit) { item.openalexId = hit.openalexId; item.match = hit.match; }
      } catch { /* the row says "not matched yet" */ }
      if (this.root) this.paintProfile();
    }
  }

  /** An input with an Add link; Enter adds too. `onAdd(value)` returns whether it took the value. */
  adder(placeholder, onAdd) {
    const row = this.e('div', 'sb-ra-row sb-ra-add');
    const input = this.e('input', 'sb-sk-in sb-ra-add-in');
    input.type = 'text'; input.placeholder = placeholder; input.setAttribute('aria-label', placeholder);
    const go = () => { if (onAdd(input.value)) input.value = ''; else input.select?.(); };
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); go(); } });
    row.append(input, this.link('Add', go, 'sb-ra-add-go'));
    return row;
  }

  // ---- sources ----

  async loadMcp() {
    try {
      const ai = await this.chat.host.ai();
      if (typeof ai.mcp?.list !== 'function') return;
      this.form.mcp = mergeMcp(mcpChoices(await ai.mcp.list()), this.form.mcp);
      if (this.root) this.paintSources();
    } catch { /* tools are optional */ }
  }

  paintSources() {
    const f = this.form;
    const box = this.sourcesBox;
    box.replaceChildren();
    /** A ticked source: checkbox, name, its status line, and a remove link when the user added it. */
    const source = (key, label, on, set, meta, onRemove) => {
      const id = `ra-${key}`.replace(/[^\w-]/g, '_');
      const input = this.e('input');
      input.type = 'checkbox'; input.checked = on; input.id = `${id}-${Math.random().toString(36).slice(2, 7)}`;
      input.dataset.source = key;
      input.addEventListener('change', () => set(input.checked));
      const name = this.e('label', 'sb-ra-title', label);
      name.setAttribute('for', input.id);
      const r = this.row(name, [meta, statusLine(this.status[key])].filter(Boolean).join(' · '), ...(onRemove ? [this.remove(`Remove ${label}`, onRemove)] : []));
      r.prepend(input);
      r.classList.add('has-check');
      return r;
    };
    const dbs = this.e('div', 'sb-ra-group');
    dbs.append(this.e('div', 'sb-ra-sub', 'Databases'));
    for (const [id, label] of DATABASES) dbs.append(source(`database:${id}`, label, Boolean(f.databases[id]), (v) => { f.databases[id] = v; }, ''));
    box.append(dbs);

    const mine = this.e('div', 'sb-ra-group');
    mine.append(this.e('div', 'sb-ra-sub', 'Feeds and journals'));
    for (const feed of f.feeds) mine.append(source(`feed:${feed.url}`, feed.title, feed.on, (v) => { feed.on = v; }, feed.url, () => { f.feeds = removeAt(f.feeds, f.feeds.indexOf(feed)); this.paintSources(); }));
    for (const j of f.journals) mine.append(source(`journal:${j.openalexId}`, j.name, j.on, (v) => { j.on = v; }, j.issn ? `Journal, ISSN ${j.issn}` : 'Journal', () => { f.journals = removeAt(f.journals, f.journals.indexOf(j)); this.paintSources(); }));
    mine.append(this.checker());
    box.append(mine);

    if (f.mcp.length) {
      const tools = this.e('div', 'sb-ra-group');
      tools.append(this.e('div', 'sb-ra-sub', 'Connected tools'));
      for (const m of f.mcp) tools.append(source(`mcp:${m.server}/${m.tool}`, m.label, m.on, (v) => { m.on = v; }, ''));
      box.append(tools);
    }
  }

  /** "Add a feed or journal": one box for an address, a journal name or an ISSN, with the result as rows under it. */
  checker() {
    const wrap = this.e('div', 'sb-ra-check');
    const row = this.e('div', 'sb-ra-row sb-ra-add');
    this.checkInput = this.e('input', 'sb-sk-in sb-ra-add-in sb-ra-check-in');
    this.checkInput.type = 'text';
    this.checkInput.placeholder = 'Add a feed or journal: an address, a name or an ISSN';
    this.checkInput.setAttribute('aria-label', 'Add a feed or journal');
    this.checkInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void this.runCheck(); } });
    row.append(this.checkInput, this.link(this.checking ? 'Checking…' : 'Check', () => this.runCheck(), 'sb-ra-check-go'));
    wrap.append(row);
    this.checkBox = this.e('div', 'sb-ra-result');
    wrap.append(this.checkBox);
    this.paintCheck();
    return wrap;
  }

  async runCheck() {
    const typed = this.checkInput.value.trim();
    if (!typed || this.checking) return;
    this.checking = true;
    this.check = null;
    this.checkBox.replaceChildren(this.e('div', 'sb-ra-meta', 'Checking…'));
    try {
      this.check = checkNotice(await (await radarService(this.chat)).checkSource(typed));
    } catch (error) {
      this.check = { tone: 'error', text: String(error?.message ?? error), options: [], offer: null, feed: null };
    }
    this.checking = false;
    if (this.root) this.paintCheck();
  }

  paintCheck() {
    const box = this.checkBox;
    box.replaceChildren();
    const c = this.check;
    if (!c) return;
    const line = this.e('div', `sb-ra-note is-${c.tone}`, c.text);
    box.append(line);
    const done = () => { this.check = null; this.checkInput.value = ''; this.paintSources(); };
    if (c.feed) box.append(this.row(c.feed.title, c.feed.url, this.link('Add feed', () => { addFeed(this.form, c.feed); done(); }, 'sb-ra-add-feed')));
    for (const j of c.options) {
      const have = this.form.journals.some((x) => x.openalexId === j.openalexId) || this.form.profile.journals.some((x) => x.openalexId === j.openalexId);
      box.append(this.row(j.name, j.match, have ? this.e('span', 'sb-ra-meta', 'Added') : this.link('Add journal', () => { addJournal(this.form, j); done(); }, 'sb-ra-add-journal')));
    }
    if (c.offer) {
      box.append(this.link(c.offer, () => {
        this.checkInput.value = '';
        this.checkInput.placeholder = "The journal's name or ISSN";
        this.checkInput.focus();
        this.check = null;
        this.paintCheck();
      }, 'sb-ra-offer'));
    }
  }

  // ---- size ----

  paintSize() {
    const f = this.form;
    const box = this.sizeBox;
    box.replaceChildren();
    const number = (cls, label, key, min, max) => {
      const input = this.e('input', `sb-sk-in sb-ra-num ${cls}`);
      input.type = 'number'; input.min = String(min); input.max = String(max); input.value = String(f.size[key]);
      input.setAttribute('aria-label', label);
      input.addEventListener('input', () => { f.size[key] = Number(input.value); f.sizeTouched = true; });
      box.append(this.row(label, null, input));
      return input;
    };
    this.freshInput = number('sb-ra-fresh', 'New papers each run', 'fresh', 1, 50);
    this.olderInput = number('sb-ra-older', 'Older papers each run', 'older', 0, 20);
    this.discoverInput = number('sb-ra-discover', 'Papers that might interest you each run (needs an OpenAlex key)', 'discover', 0, 10);
    box.append(this.e('div', 'sb-ra-meta', `A daily radar shows ${SIZE_DEFAULTS.daily.fresh} new and ${SIZE_DEFAULTS.daily.older} older papers, a weekly one ${SIZE_DEFAULTS.weekly.fresh} and ${SIZE_DEFAULTS.weekly.older}. Quiet days show nothing.`));
  }

  /** Until the user types a size, it follows the schedule. */
  followSize() {
    const f = this.form;
    if (f.sizeTouched || !this.freshInput) return;
    f.size = { ...sizeDefaults(scheduleFromWhen(f.when)) };
    this.freshInput.value = String(f.size.fresh);
    this.olderInput.value = String(f.size.older);
    this.discoverInput.value = String(f.size.discover);
  }

  // ---- save ----

  async save() {
    const f = this.form;
    f.name = this.nameInput.value;
    const problem = radarProblem(f);
    if (problem) { this.message.textContent = problem; this.message.classList.add('is-error'); return; }
    const draft = draftFromForm(f);
    if (this.routine && !f.project) draft.project = null; // null clears an earlier project when editing
    this.saveButton.disabled = true;
    this.message.classList.remove('is-error');
    this.message.textContent = 'Saving…';
    try {
      const ai = await this.chat.host.ai();
      if (!ai.routines) throw new Error('Routines need the updated Veritas server. Restart it and try again.');
      if (this.routine) await ai.routines.update(this.routine.id, draft);
      else await ai.routines.create(draft);
    } catch (error) {
      this.saveButton.disabled = false;
      this.message.textContent = String(error?.message ?? error);
      this.message.classList.add('is-error');
      return;
    }
    this.close();
    this.onSaved?.();
  }
}

// Hairline rows, no nested boxes: the sheet card is the one rounded container (radius 12). Obsidian buttons are nowrap with a
// fill and a fixed height, so the link and remove buttons reset that.
const RADAR_CSS = `
.sb-ra-card { width: min(680px, 100%); border-radius: 12px; font-size: 15px; }
.sb-ra-card .sb-sk-title { font-size: 15px; }
.sb-ra-card .sb-ed-spacer { flex: 1; }
.sb-ra-body { gap: 0; padding: 4px 16px 16px; }
.sb-ra-section { padding: 12px 0 8px; border-bottom: 1px solid var(--sb-ui-line); }
.sb-ra-section:last-of-type { border-bottom: 0; }
.sb-ra-h { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--sb-ui-muted); }
.sb-ra-sub { margin: 10px 0 2px; font-size: 13px; color: var(--sb-ui-muted); }
.sb-ra-row { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 6px 0; border-bottom: 1px solid var(--sb-ui-line); }
.sb-ra-group > .sb-ra-row:last-child, .sb-ra-size > .sb-ra-row:last-of-type { border-bottom: 0; }
.sb-ra-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.sb-ra-title { overflow-wrap: anywhere; }
.sb-ra-meta { font-size: 13px; color: var(--sb-ui-muted); overflow-wrap: anywhere; }
.sb-ra-meta.is-error, .sb-ra-note.is-error { color: var(--sb-ui-danger); }
.sb-ra-note { font-size: 13px; padding: 6px 0; overflow-wrap: anywhere; color: var(--sb-ui-text); }
.sb-ra-note.is-warn { color: var(--sb-ui-muted); }
.sb-ra-bar { display: flex; align-items: center; gap: 8px; padding-bottom: 2px; }
.sb-ra-row.has-check input[type="checkbox"] { flex: none; margin: 0; }
.sb-ra-add { border-bottom: 0; }
.sb-ra-card .sb-ra-add-in { flex: 1; width: auto; min-width: 0; font-size: 15px; }
.sb-ra-card .sb-ra-num { width: 5em; flex: none; font-size: 15px; }
.sb-ra-scope { display: flex; flex-direction: column; gap: 8px; }
.sb-ra-name, .sb-ra-scope .sb-sk-in { font-size: 15px; }
.sb-ra-tree { max-height: 220px; overflow-y: auto; }
.sb-ai .sb-ra-link, .sb-ai .sb-ra-x { white-space: normal; height: auto; box-shadow: none; font: inherit; font-size: 13px; background: transparent; border: none; cursor: pointer; }
.sb-ai .sb-ra-link { flex: none; padding: 2px 4px; color: var(--sb-ui-accent); }
.sb-ai .sb-ra-link:hover { text-decoration: underline; }
.sb-ra-tag { margin-inline-start: 4px; padding: 0 6px; border: 1px solid var(--sb-ui-line); border-radius: 6px; font-size: 11.5px; font-weight: 400; color: var(--sb-ui-muted); }
.sb-ai .sb-ra-offer { padding: 4px 0; text-align: start; }
.sb-ai .sb-ra-x { flex: none; padding: 2px 4px; color: var(--sb-ui-muted); }
.sb-ai .sb-ra-x:hover { color: var(--sb-ui-text); }
.sb-ra-card .sb-rt-when { font-size: 13px; }
.sb-ra-overlay .sb-sk-actions { padding-top: 12px; }
`;
