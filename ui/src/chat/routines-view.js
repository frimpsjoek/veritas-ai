// @ts-nocheck -- UI glue like skills-dialog.js; routines-data.js is the checked, tested part.
// ui-src/src/chat/routines-view.js. Spec 011 U4: the Routines view (opened from the mode menu, in the thread area, no
// composer) and the create/edit sheet. A routine is a saved question that runs by itself on a daily or weekly schedule and
// either adds new papers to a table or starts a fresh session. Cards show what it does, when it runs next and how the last
// run went; the schedule math and the runs are the engine's (`ai.routines`), this file only draws and asks.
// Gotchas kept from the other views: no global `Event` in Zotero's chrome scope (never `new Event`), and every button that
// can hold long text sets `white-space: normal` because Obsidian's buttons are nowrap.
import { el, button, installStyle } from './dom-helpers.js';
import { SkillsDialog } from './skills-dialog.js';
import { whenRowMethods, installWhenStyle } from './when-row.js';
import { RadarSheet } from './radar-sheet.js';
import { RADAR_CARD, radarAvailable } from './radar-data.js';
import { icon } from '../icons.js';
import {
  TABS, DAY_KINDS, PICK_DAYS, MAX_TIMES, LIMIT_LINE, TEMPLATES, groupByStatus, scheduleText, nextRunText, lastRunLine, cardActions, draftFromTemplate,
  emptyText, estimateText, nextFreeTime, ordinal, previewText, scheduleProblem, scheduleFromWhen, whenFromSchedule, splitBroken, brokenLine, sheetProblem, runNowLine, newsSession, projectLine, projectChoices,
} from './routines-data.js';

const DEPTHS = [['fastest', 'Fastest'], ['quick', 'Fast'], ['standard', 'Balanced'], ['deep', 'Smart']];
const SOURCE_LABELS = [['papers', 'Papers'], ['notes', 'Notes'], ['scholarly', 'Scholarly'], ['web', 'Web']];
const POLL_MS = 15_000;

/** The engine's routines service, or a plain message when the server is too old. @param {any} chat */
async function routinesService(chat) {
  const ai = await chat.host.ai();
  if (!ai.routines) throw new Error('Routines need the updated Veritas server. Restart it and try again.');
  return ai.routines;
}

export class RoutinesView {
  /** @param {any} chat the ChatView */
  constructor(chat) {
    this.chat = chat;
    this.doc = chat.doc;
    this.tab = 'active';
    this.list = [];
    this.broken = [];
    this.news = new Set();
    this.error = '';
    this.notes = new Map(); // routine id -> { text, lastAt }: a line under its card ("Started.", why Run now refused) until another run ends
    this.root = el(this.doc, 'div', 'sb-rt');
    RoutinesView.style(this.doc);
    this.build();
    void this.load();
    this.timer = chat.win.setInterval(() => {
      if (!this.root.isConnected) { this.dispose(); return; }
      void this.load();
    }, POLL_MS);
  }

  dispose() {
    if (this.timer) this.chat.win.clearInterval(this.timer);
    this.timer = null;
  }

  e(tag, cls, text) { return el(this.doc, tag, cls, text); }

  build() {
    const head = this.e('div', 'sb-rt-head');
    head.append(this.e('span', 'sb-rt-title', 'Routines'), this.e('span', 'sb-ed-spacer'));
    const create = button(this.doc, 'New routine', () => this.openSheet({ draft: null }), true);
    create.classList.add('sb-rt-new');
    head.append(create);
    if (radarAvailable(this.chat.host.where())) {
      const radar = button(this.doc, 'New radar', () => this.openRadar({}));
      radar.classList.add('sb-rt-new-radar');
      head.append(radar);
    }
    this.tabs = this.e('div', 'sb-rt-tabs');
    this.tabs.setAttribute('role', 'tablist');
    for (const tab of TABS) {
      const t = this.e('button', 'sb-rt-tab', tab.label);
      t.setAttribute('type', 'button');
      t.setAttribute('role', 'tab');
      t.dataset.tab = tab.id;
      t.addEventListener('click', () => { this.tab = tab.id; this.paint(); });
      this.tabs.append(t);
    }
    this.status = this.e('div', 'sb-rt-status');
    this.warning = this.e('div', 'sb-rt-status sb-rt-warning');
    this.body = this.e('div', 'sb-rt-body');
    this.foot = this.e('div', 'sb-rt-foot', LIMIT_LINE);
    this.root.append(head, this.tabs, this.status, this.warning, this.body, this.foot);
  }

  async load() {
    try {
      ({ routines: this.list, broken: this.broken } = splitBroken(await (await routinesService(this.chat)).list()));
      this.error = '';
      await Promise.all([this.loadNews(), this.loadProjects()]);
    } catch (error) {
      this.error = String(error?.message ?? error);
    }
    this.paint();
  }

  /** The projects, read here: one made since the history last loaded (or in the other app) must still name its cards. */
  async loadProjects() {
    try {
      const ai = await this.chat.host.ai();
      this.projects = ai.projects ? await ai.projects.list() : [];
    } catch { this.projects = this.chat.projects ?? []; }
  }

  /** Which sessions still hold routine news, read only when a card could link to one (the history list is not polled for this). */
  async loadNews() {
    this.news = new Set();
    if (!this.list.some((r) => r.lastRun?.status === 'done' && r.lastRun.added > 0)) return;
    try {
      const ai = await this.chat.host.ai();
      for (const c of await ai.conversations.list()) if (c.news) this.news.add(c.id);
    } catch { /* a plain line is fine without it */ }
  }

  paint() {
    if (!this.root.isConnected && this.body.childElementCount) return;
    const groups = groupByStatus(this.list);
    for (const t of this.tabs.children) {
      const on = t.dataset.tab === this.tab;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', String(on));
      const base = TABS.find((x) => x.id === t.dataset.tab)?.label ?? '';
      const n = groups[t.dataset.tab].length;
      t.textContent = n ? `${base} (${n})` : base;
    }
    this.status.textContent = this.error;
    this.status.classList.toggle('is-error', Boolean(this.error));
    this.warning.textContent = this.error ? '' : brokenLine(this.broken);
    this.body.replaceChildren();
    if (this.error) return;
    const shown = groups[this.tab];
    if (!shown.length) {
      if (this.tab === 'active' && !this.list.length) {
        this.body.append(this.e('div', 'sb-rt-empty', emptyText('active')));
        const templates = this.e('div', 'sb-rt-templates');
        if (radarAvailable(this.chat.host.where())) templates.append(this.templateCard(RADAR_CARD, () => this.openRadar({})));
        for (const t of TEMPLATES) templates.append(this.templateCard(t));
        this.body.append(templates);
      } else {
        this.body.append(this.e('div', 'sb-rt-empty', this.tab === 'active' ? 'Nothing is active.' : emptyText(this.tab)));
      }
      return;
    }
    for (const routine of shown) this.body.append(this.card(routine));
  }

  templateCard(template, onOpen) {
    // A div, not a <button>: Zotero's buttons keep a one-line height, so the blurb spilled over the next card.
    const card = this.e('div', 'sb-rt-template');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.dataset.template = template.id;
    card.append(this.e('span', 'sb-rt-template-title', template.title), this.e('span', 'sb-rt-template-blurb', template.blurb));
    const open = onOpen ?? (() => this.openSheet({ draft: draftFromTemplate(template.id) }));
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
    return card;
  }

  card(routine) {
    const card = this.e('div', `sb-rt-card${routine.running ? ' is-running' : ''}`);
    card.dataset.id = routine.id;
    const text = this.e('div', 'sb-rt-text');
    text.append(this.e('div', 'sb-rt-name', routine.name));
    text.append(this.e('div', 'sb-rt-schedule', scheduleText(routine.schedule)));
    const next = nextRunText(routine);
    if (next) text.append(this.e('div', 'sb-rt-next', next));
    const last = this.e('div', `sb-rt-last${routine.lastRun?.status === 'failed' ? ' is-error' : ''}`, lastRunLine(routine));
    // New papers nobody has looked at yet: the line opens them.
    const fresh = newsSession(routine, (id) => this.news.has(id));
    if (fresh) {
      last.classList.add('is-link');
      last.setAttribute('role', 'link');
      last.tabIndex = 0;
      last.title = 'Open the new papers';
      const go = () => this.chat.openConversation(fresh);
      last.addEventListener('click', go);
      last.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); go(); } });
    }
    text.append(last);
    text.append(this.e('div', 'sb-rt-target', routine.kind === 'radar' ? 'Reading radar: a new chat each run, only when there is something new' : routine.target?.kind === 'artifact' ? 'Adds new papers to a table' : 'Starts a new session each run'));
    const where = projectLine(routine, this.projects ?? this.chat.projects);
    if (where) text.append(this.e('div', 'sb-rt-project', where));
    const note = this.notes.get(routine.id);
    if (note && note.lastAt === (routine.lastRun?.at ?? null)) text.append(this.e('div', 'sb-rt-note', note.text));
    const actions = this.e('div', 'sb-rt-actions');
    for (const action of cardActions(routine)) {
      const b = button(this.doc, action.label, () => this.act(routine, action.id), action.id === 'run');
      b.dataset.action = action.id;
      b.disabled = Boolean(action.disabled);
      actions.append(b);
    }
    const session = routine.lastRun?.session;
    if (session) {
      const open = button(this.doc, 'Open last run', () => this.chat.openConversation(session));
      open.dataset.action = 'open';
      actions.append(open);
    }
    card.append(text, actions);
    return card;
  }

  async act(routine, id) {
    if (id === 'edit') { routine.kind === 'radar' ? this.openRadar({ routine }) : this.openSheet({ routine }); return; }
    try {
      const svc = await routinesService(this.chat);
      if (id === 'run') {
        this.notes.set(routine.id, { text: runNowLine(await svc.runNow(routine.id)), lastAt: routine.lastRun?.at ?? null });
      } else {
        this.notes.delete(routine.id);
        // "Restore" is `resume`: the engine puts an archived routine back to active.
        await svc[id === 'restore' ? 'resume' : id](routine.id);
      }
    } catch (error) {
      this.notes.set(routine.id, { text: String(error?.message ?? error), lastAt: routine.lastRun?.at ?? null });
    }
    await this.load();
  }

  openRadar({ routine }) {
    new RadarSheet(this.chat, { routine, projects: this.projects, onSaved: () => this.load() }).open();
  }

  openSheet({ routine, draft }) {
    new RoutineSheet(this.chat, { routine, draft, projects: this.projects, onSaved: () => this.load() }).open();
  }

  static style(doc) {
    installStyle(doc, 'second-brain-routines-style', ROUTINES_CSS);
    installWhenStyle(doc);
  }
}

/** The create/edit sheet: an overlay on the chat, like the Skills dialog. `routine` edits; `draft` starts a new one from it. */
export class RoutineSheet {
  /** @param {any} chat @param {{ routine?: any, draft?: any, onSaved?: () => void }} opts */
  constructor(chat, { routine, draft, onSaved, projects }) {
    this.chat = chat;
    this.doc = chat.doc;
    this.routine = routine ?? null;
    this.onSaved = onSaved;
    const start = routine ?? draft ?? {};
    this.fields = {
      name: start.name ?? '',
      prompt: start.prompt ?? '',
      skills: [...(start.skills ?? [])],
      depth: start.depth ?? 'standard',
      schedule: start.schedule ?? null,
      target: start.target ?? { kind: 'session' },
      sources: { ...(start.sources ?? chat.sources ?? { papers: true, notes: true, scholarly: true, web: false }) },
      scope: start.scope ?? chat.scopeValue?.() ?? { kind: 'library' },
      project: start.project ?? null,
    };
    // Only when the engine has projects and at least one exists; a new routine starts in the project open in the history.
    this.projectList = projects ?? chat.projects ?? [];
    this.projectChoice = projectChoices(this.projectList, routine?.project, chat.projectId, !routine);
    this.when = whenFromSchedule(this.fields.schedule);
    this.artifactTarget = this.fields.target.kind === 'artifact' ? this.fields.target : null;
    this.depthSeq = 0;
    this.root = null;
  }

  e(tag, cls, text) { return el(this.doc, tag, cls, text); }

  open() {
    RoutinesView.style(this.doc);
    SkillsDialog.style(this.doc);
    this.root = this.e('div', 'sb-sk-overlay sb-rt-overlay');
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', this.routine ? 'Edit routine' : 'New routine');
    this.root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); this.close(); } });
    this.chat.root.append(this.root);
    this.paint();
    this.nameInput.focus();
  }

  close() {
    this.root?.remove();
    this.root = null;
  }

  field(label, node) {
    const w = this.e('div', 'sb-sk-field');
    w.append(this.e('span', 'sb-sk-label', label), node);
    return w;
  }

  paint() {
    const f = this.fields;
    const body = this.e('div', 'sb-sk-body');
    this.nameInput = this.e('input', 'sb-sk-in sb-rt-in-name');
    this.nameInput.type = 'text'; this.nameInput.value = f.name; this.nameInput.maxLength = 80;
    this.nameInput.placeholder = 'For example: New vole burrow papers';
    this.promptInput = this.e('textarea', 'sb-sk-text-in sb-rt-in-prompt');
    this.promptInput.rows = 4; this.promptInput.value = f.prompt;
    this.promptInput.placeholder = 'What should it look for each time?';
    body.append(this.field('Name', this.nameInput), this.field('What to look for', this.promptInput));

    this.chipsBox = this.e('div', 'sb-rt-chips');
    const add = button(this.doc, 'Add a skill', () => new SkillsDialog(this.chat, (name) => { if (!f.skills.includes(name)) f.skills.push(name); this.paintChips(); }).open());
    add.classList.add('sb-rt-addskill');
    const skills = this.e('div', 'sb-rt-skills');
    skills.append(this.chipsBox, add);
    body.append(this.field('Skills', skills));
    this.paintChips();

    // depth: the same four stops and estimate as a report's depth slider
    this.depthSlider = this.e('input', 'sb-ai-depth sb-rt-depth');
    this.depthSlider.type = 'range'; this.depthSlider.min = '0'; this.depthSlider.max = String(DEPTHS.length - 1); this.depthSlider.step = '1';
    this.depthSlider.setAttribute('aria-label', 'Depth');
    this.depthSlider.value = String(Math.max(0, DEPTHS.findIndex(([v]) => v === f.depth)));
    this.depthLabel = this.e('span', 'sb-ai-depth-label sb-rt-depth-label');
    this.depthSlider.addEventListener('input', () => { f.depth = DEPTHS[Number(this.depthSlider.value)][0]; this.syncDepth(); });
    const depth = this.e('div', 'sb-rt-depthrow');
    depth.append(this.depthSlider, this.depthLabel);
    body.append(this.field('Depth', depth));
    this.syncDepth();

    // when: days, then times, then a plain preview of the next two runs
    this.whenBox = this.e('div', 'sb-rt-when');
    this.paintWhen();
    body.append(this.field('When', this.whenBox));

    // target
    const targets = this.e('div', 'sb-rt-targets');
    this.targetKind = this.artifactTarget ? this.fields.target.kind : 'session';
    const choice = (value, label) => {
      const row = this.e('label', 'sb-rt-radio');
      const input = this.e('input');
      input.type = 'radio'; input.name = 'sb-rt-target'; input.value = value; input.checked = this.targetKind === value;
      input.addEventListener('change', () => { if (input.checked) this.targetKind = value; });
      row.append(input, this.e('span', '', label));
      targets.append(row);
    };
    if (this.artifactTarget) choice('artifact', 'Add new papers to this table');
    choice('session', 'Start a new session each run');
    body.append(this.field('Where results go', targets));
    this.paintProject(body, targets);

    // sources
    const sources = this.e('div', 'sb-rt-sources');
    for (const [id, label] of SOURCE_LABELS) {
      const b = this.e('button', `sb-rt-source${f.sources[id] ? ' is-on' : ''}`, label);
      b.setAttribute('type', 'button');
      b.dataset.source = id;
      b.setAttribute('aria-pressed', String(Boolean(f.sources[id])));
      b.addEventListener('click', () => { f.sources[id] = !f.sources[id]; b.classList.toggle('is-on', f.sources[id]); b.setAttribute('aria-pressed', String(f.sources[id])); });
      sources.append(b);
    }
    body.append(this.field('Where to look', sources));

    this.message = this.e('div', 'sb-sk-status');
    const actions = this.e('div', 'sb-sk-actions is-form');
    this.saveButton = button(this.doc, this.routine ? 'Save changes' : 'Create routine', () => this.save(), true);
    this.saveButton.classList.add('sb-rt-save');
    actions.append(this.saveButton, button(this.doc, 'Cancel', () => this.close()));
    body.append(this.message, actions);

    const head = this.e('div', 'sb-sk-head');
    const x = this.e('button', 'sb-sk-x');
    x.setAttribute('type', 'button'); x.setAttribute('aria-label', 'Close');
    x.append(icon(this.doc, 'close', 'sb-ai-icon'));
    x.addEventListener('click', () => this.close());
    head.append(this.e('span', 'sb-sk-title', this.routine ? 'Edit routine' : 'New routine'), this.e('span', 'sb-ed-spacer'), x);
    const card = this.e('div', 'sb-sk-card');
    card.append(head, body);
    this.root.replaceChildren(card);
  }

  /** "Project": a select for a new-session routine, the table's own project (read-only) for one that updates a table. */
  paintProject(body, targets) {
    this.projectBox = null;
    this.projectNote = null;
    if (this.projectChoice.options.length) {
      this.projectPick = this.e('select', 'sb-sk-in sb-rt-project-pick');
      for (const o of this.projectChoice.options) { const opt = this.e('option', '', o.label); opt.value = o.id; this.projectPick.append(opt); }
      this.projectPick.value = this.projectChoice.selected;
      this.projectBox = this.field('Project', this.projectPick);
      body.append(this.projectBox);
    }
    if (this.artifactTarget) {
      this.projectNote = this.field('Project', this.e('span', 'sb-rt-project-note', 'Same as the table'));
      body.append(this.projectNote);
      // Which project that is: the table's session knows.
      Promise.resolve().then(async () => {
        const ai = await this.chat.host.ai();
        const hit = (await ai.conversations.list()).find((c) => c.id === this.artifactTarget.session);
        const own = this.projectList.find((p) => p.id === hit?.project);
        this.projectNote.lastChild.textContent = own ? own.name : 'None';
      }).catch(() => { this.projectNote?.remove(); this.projectNote = null; });
    }
    const sync = () => {
      const artifact = this.targetKind === 'artifact';
      if (this.projectBox) this.projectBox.hidden = artifact;
      if (this.projectNote) this.projectNote.hidden = !artifact;
    };
    this.syncProject = sync;
    for (const input of targets.querySelectorAll('input')) input.addEventListener('change', sync);
    sync();
  }

  paintChips() {
    this.chipsBox.replaceChildren();
    for (const name of this.fields.skills) {
      const chip = this.e('span', 'sb-ai-chip sb-ai-skill-chip');
      chip.title = `Skill: ${name}`;
      const remove = this.e('button', 'sb-ai-chip-x', '×');
      remove.title = 'Remove this skill';
      remove.addEventListener('click', () => { this.fields.skills = this.fields.skills.filter((n) => n !== name); this.paintChips(); });
      chip.append(icon(this.doc, 'sparkle', 'sb-ai-icon'), this.e('span', 'sb-ai-chip-label', name), remove);
      this.chipsBox.append(chip);
    }
  }

  /** The stop's name, then what it costs in model turns once the engine answers (same wording as the report options). */
  syncDepth() {
    const idx = Number(this.depthSlider.value);
    const [value, name] = DEPTHS[idx];
    this.depthLabel.textContent = name;
    this.depthSlider.setAttribute('aria-valuetext', name);
    const seq = ++this.depthSeq;
    Promise.resolve().then(async () => {
      const ai = await this.chat.host.ai();
      if (typeof ai.reviews?.estimate !== 'function') return;
      const estimate = await ai.reviews.estimate({ depth: value, systematic: false });
      if (seq !== this.depthSeq) return;
      const text = estimateText(name, estimate);
      this.depthLabel.textContent = text;
      this.depthSlider.setAttribute('aria-valuetext', text);
    }).catch(() => { /* the estimate is a nicety */ });
  }

  /** What the form holds now, as the service's draft. */
  collect() {
    const f = this.fields;
    const schedule = scheduleFromWhen(this.when);
    const target = this.targetKind === 'artifact' && this.artifactTarget ? this.artifactTarget : { kind: 'session' };
    const draft = { name: this.nameInput.value.trim(), prompt: this.promptInput.value.trim(), skills: [...f.skills], depth: f.depth, schedule, target, sources: { ...f.sources }, scope: f.scope };
    // null clears an earlier project when editing; a new routine just leaves it out.
    if (this.projectPick && target.kind === 'session') {
      if (this.projectPick.value) draft.project = this.projectPick.value;
      else if (this.routine) draft.project = null;
    }
    return draft;
  }

  async save() {
    const draft = this.collect();
    const problem = sheetProblem(draft);
    if (problem) { this.message.textContent = problem; this.message.classList.add('is-error'); return; }
    this.saveButton.disabled = true;
    this.message.classList.remove('is-error');
    this.message.textContent = 'Saving…';
    try {
      const svc = await routinesService(this.chat);
      if (this.routine) await svc.update(this.routine.id, draft);
      else await svc.create(draft);
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

Object.assign(RoutineSheet.prototype, whenRowMethods);

// Obsidian gives every button a nowrap label, a fill and a fixed height: names, blurbs and notes here need `white-space: normal`.
// The sheet reuses the Skills dialog's overlay, card and field classes (SkillsDialog.style is loaded with it).
const ROUTINES_CSS = `
.sb-rt { display: flex; flex-direction: column; gap: 10px; padding: 16px; max-width: 760px; margin: 0 auto; box-sizing: border-box; color: var(--sb-ui-text); font-size: 13px; }
.sb-rt-head { display: flex; align-items: center; gap: 8px; }
.sb-rt-title { font-size: 16px; font-weight: 600; }
.sb-rt-tabs { display: flex; flex-wrap: wrap; gap: 2px; }
.sb-ai .sb-rt-tab, .sb-ai .sb-rt-template { white-space: normal; height: auto; box-shadow: none; font: inherit; cursor: pointer; }
.sb-ai .sb-rt-tab { padding: 4px 10px; border: none; border-radius: 12px; background: transparent; color: var(--sb-ui-muted); }
.sb-ai .sb-rt-tab.is-on { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-rt-body { display: flex; flex-direction: column; gap: 8px; }
.sb-rt-card { display: flex; align-items: flex-start; gap: 12px; padding: 10px 12px; border: 1px solid var(--sb-ui-line); border-radius: 8px; }
.sb-rt-card.is-running { border-color: var(--sb-ui-accent); }
.sb-rt-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sb-rt-name { font-weight: 600; overflow-wrap: anywhere; }
.sb-rt-schedule, .sb-rt-next, .sb-rt-last, .sb-rt-target, .sb-rt-project, .sb-rt-note { color: var(--sb-ui-muted); font-size: 12px; overflow-wrap: anywhere; }
.sb-rt-last.is-error { color: var(--sb-ui-danger); }
.sb-rt-last.is-link { color: var(--sb-ui-accent); cursor: pointer; text-decoration: underline; }
.sb-rt-note { color: var(--sb-ui-text); }
.sb-rt-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; max-width: 46%; }
.sb-rt-actions .sb-button, .sb-rt-overlay .sb-button, .sb-rt .sb-button { white-space: normal; }
.sb-rt-empty, .sb-rt-status { color: var(--sb-ui-muted); font-size: 12.5px; overflow-wrap: anywhere; }
.sb-rt-status:empty { display: none; }
.sb-rt-status.is-error { color: var(--sb-ui-danger); }
.sb-rt-templates { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
.sb-ai .sb-rt-template { display: flex; box-sizing: border-box; min-width: 0; flex-direction: column; align-items: flex-start; gap: 4px; text-align: start; padding: 12px; border: 1px solid var(--sb-ui-line); border-radius: 8px; background: transparent; color: var(--sb-ui-text); }
.sb-ai .sb-rt-template:hover { background: var(--sb-ui-hover); }
.sb-rt-template-title { font-weight: 600; }
.sb-rt-template-blurb { color: var(--sb-ui-muted); font-size: 12px; }
.sb-rt-foot { margin-top: 6px; color: var(--sb-ui-faint); font-size: 11.5px; overflow-wrap: anywhere; }
.sb-rt-skills, .sb-rt-depthrow, .sb-rt-when, .sb-rt-sources, .sb-rt-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sb-rt-overlay .sb-sk-field[hidden] { display: none; }
.sb-rt-project-note { color: var(--sb-ui-muted); }
.sb-rt-targets { display: flex; flex-direction: column; gap: 4px; }
.sb-rt-radio { display: flex; align-items: center; gap: 6px; }
@media (max-width: 480px) { .sb-rt-card { flex-direction: column; align-items: stretch; } .sb-rt-actions { justify-content: flex-start; max-width: none; } }
`;
