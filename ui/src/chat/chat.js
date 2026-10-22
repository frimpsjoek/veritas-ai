// @ts-nocheck -- UI glue moved from content/*.js (spec 005 C1), which was never typechecked in Zotero either;
// host.d.ts, tools.d.ts and domain.d.ts are still the checked interfaces these files must match.
// ui-src/src/chat/chat.js. Moved from content/chat.js's SecondBrain.ChatView (spec 005 C1). Same behaviour and
// pixels as 0.22; every Zotero.*/this.sb.* use now goes through the UiHost the constructor is given. ChatTab and
// ChatSidebar (content/chat.js, content/chat-sidebar.js) shrink to shells that build a host and this view.
import { el, button, installStyle } from './dom-helpers.js';
import { icon, ICONS, SVG_NS } from '../icons.js';
import { renderMarkdown } from './markdown.js';
import { FindView, setDefaultHost } from './find-view.js';
import { ReportView } from './report-view.js';
import { CollectionTree } from './collection-tree.js';
// spec 007 E2: one shared, pure grouping function so a live turn folds exactly as the same JSONL folds when
// reopened (core.js stores `lines` computed by this same function). Same precedent as markdown.js's citationKey
// import: ui-src takes small pure helpers straight from agent-src rather than re-implementing them.
import { compactActivities, linesFromLabels, entriesFromLabels, pastTense } from '../../../agent/src/activity.js';
import { visibleText, hasTableBlock, formatElapsed } from './stream.js';
import { ScrollFollower } from './scroll-follow.js';
import { ContextPicker } from './picker.js';
import { LocalMenu } from './local-menu.js';
import { offerSwitch, NOT_INSTALLED } from './provider-switch.js';
import { usageLine } from './usage-line.js';
import { SkillsDialog } from './skills-dialog.js';
import { RoutinesView, RoutineSheet } from './routines-view.js';
import { selectionCard, selectedPapers, selectionLabel } from './selection-card.js';
import { estimateText, draftForArtifact } from './routines-data.js';
import { usedLine } from './skills-data.js';
import { ArtifactCard } from './artifact-card.js';
import { ArtifactPanel, downloadResult } from './artifact-panel.js';
import { openPopover, menuItem } from './popover.js';
import { buildSwitcher, paintSwitcher, openRowMenu } from './projects-menu.js';
import { filterEntries, emptyLine } from './projects-data.js';
import { newsLabel, newsTitle } from './routines-data.js';
import { KIND_NAME, KIND_ICON, hasGaps } from './artifact-data.js';
import { describeOn, turnsOn } from './papers-chat-data.js';
import { canSave } from '../export/save.js';
import { sourceHint, modeEmpty } from '../host-words.js';
import { pillsFrom, migrationPatch, togglePatch, webFor } from './sources-sync.js';
import {
  MODE_GROUPS, PICKER_MODES, VIEW_MODES, isReviewMode, normalizeMode, modeIconName, stepChoices, onLabel, currentResult, SESSION_KIND_ICON, sessionMeta,
  artifactsWord, historyEntries, cardSplit, paperRowFromLibrary, paperRowFromContext, importDraft, uniqueRows,
} from './steps-data.js';
import { personAvatar, aiAvatar } from '../avatars.js';

/** spec 007 §3.1's ActivityLine.icon values, mapped onto the existing icon set (no new pixel art for E2): search
 *  kinds reuse the source-pill icons, `read`/`mcp`/`thinking`/`result` reuse the closest existing shape. */
const ACTIVITY_ICON = {
  library: 'paper', read: 'note', scholarly: 'scholarly', web: 'web', mcp: 'status', thinking: 'ask', result: 'duplicate',
  clarify: 'ask', plan: 'report', screen: 'find', extract: 'duplicate', write: 'report',
};

/** The icon of one live step: a magnifier for any search, the paper / note / globe for what was read. */
function stepIcon(entry) {
  if (entry.kind === 'read') return entry.source?.kind === 'web' ? 'web' : entry.source?.kind === 'note' ? 'note' : 'paper';
  if (entry.kind === 'library' || entry.kind === 'scholarly' || entry.kind === 'web') return 'find';
  if (entry.kind === 'result') return 'sparkle';
  return ACTIVITY_ICON[entry.kind] ?? 'status';
}

/** A source pill's tooltip phrase, lower-cased to follow "Search ". */
const hintOf = (host, id, title) => { const text = sourceHint(host, id, title); return `${text.charAt(0).toLowerCase()}${text.slice(1)}`; };

/** Every open view, so a change made in one (a chat sent, renamed or deleted) shows in the others' history.
 *  Module-scope, not host-scope: Zotero's one loaded sb-ui.js has one Set shared by the tab and every sidebar;
 *  Obsidian's own separate main.js bundle gets its own, which is exactly the right boundary. */
const OPEN_VIEWS = new Set();

/** Makes `into`'s children match `next`'s while touching only what differs: a streamed answer re-renders every
 *  frame, but its finished blocks come out identical, so they keep their nodes (no relayout, selection and
 *  scroll anchors survive) and only the growing tail is swapped. */
function reconcileChildren(into, next) {
  const have = Array.from(into.childNodes);
  const want = Array.from(next.childNodes);
  want.forEach((node, i) => {
    const old = have[i];
    if (!old) into.append(node);
    else if (!old.isEqualNode(node)) old.replaceWith(node);
  });
  for (let i = want.length; i < have.length; i++) have[i].remove();
}

/** @typedef {import("../host").UiHost} UiHost */
/** @typedef {import("../host").ContextItem} ContextItem */

export class ChatView {
  static MODES = [
    { id: 'chat', label: 'Chat', title: 'A conversation about your library that remembers what was said', placeholder: 'Ask about your library…',
      empty: 'Ask anything about your papers and notes. Every answer says where each point comes from.',
      suggest: (papers) => papers.length === 1 ? [`Summarize ${papers[0]}`, 'What are its main limitations?']
        : papers.length ? ['Compare these papers', 'What do these papers agree on?']
        : ['What themes run through my library?', 'Which of my papers disagree with each other?'] },
    { id: 'ask', label: 'Quick answer', title: 'One question, one answer from your library', placeholder: 'Ask one question…',
      empty: "One question, one answer from your papers and notes. If your library doesn't cover it, you'll be told.",
      suggest: (papers) => papers.length === 1 ? [`What method does ${papers[0]} use?`]
        : papers.length ? ['What methods do these papers use?'] : ['What methods do my papers use most?'] },
    { id: 'find', label: 'Find papers', title: 'One table of papers on a topic, from your library and scholarly databases', placeholder: 'What papers are you looking for?',
      empty: 'Describe a topic. You get one table of papers from your library and scholarly databases, with a short summary of the top ones. Tick papers to chat about them, add them to Zotero or export them.',
      starters: ['Papers on ', 'Recent reviews of '] },
    { id: 'papers', label: 'Chat with papers', title: 'Pick some papers and ask about them', placeholder: 'Pick the papers first…',
      empty: 'Pick the papers you want to chat about. They open beside the chat, ready for your questions.' },
    { id: 'extract', label: 'Extract data', title: 'Pick some papers and fill columns from them', placeholder: 'Pick the papers first…',
      empty: 'Pick the papers you want data from. They open as a table where you add columns.' },
    { id: 'report', label: 'Research report', title: 'Plan and run a literature review across your library, scholarly search and the web',
      placeholder: 'What should the review answer?',
      empty: "Give a research question. You'll get a plan to check and approve, then the report appears here with an evidence table and references.",
      starters: ['What does the research say about ', 'How do studies measure '] },
    { id: 'systematic', label: 'Systematic review', title: 'A protocol-driven review: PICOS, screening criteria, and a method you can report',
      placeholder: 'What should the review answer?',
      empty: "Give a research question. You'll confirm a short protocol and its criteria, then the review screens the papers, extracts data from the ones that pass, and writes the report with its method.",
      starters: ['Does ', 'What is the effect of '] },
    { id: 'routines', label: 'Routines', title: 'Questions that run by themselves every day or week and bring back what is new', placeholder: '',
      empty: 'Routines run on a schedule and bring back new papers.' },
  ];

  static ICONS = ICONS;
  /** Spec 005 §5: Papers (the Zotero library) and Notes (the Obsidian vault) split out of the old single
   *  "Library" pill. Shown in every mode now (unit C2); Find papers disables Notes and Web (renderSources()). */
  static SOURCES = [
    ['papers', 'Papers', 'The Zotero library: metadata, abstract, your highlights and notes, full text'],
    ['notes', 'Notes', 'The Obsidian vault'],
    ['scholarly', 'Scholarly', 'Scholarly databases such as OpenAlex and Semantic Scholar'],
    ['web', 'Web', 'The open web'],
    // shown only while the Valency Bond connector is connected (refreshConnectors)
    ['valency', 'Valency', 'Valency Bond: 500M+ papers and preprints, ChemRxiv included'],
  ];

  /** Every open view refreshes its history, so a change made in one shows in the others. */
  static refreshAll() {
    for (const view of OPEN_VIEWS) view.refreshList();
  }

  /**
   * @param {UiHost} host
   * @param {Document} doc
   */
  constructor(host, doc) {
    this.host = host;
    // Pre-005 backward-compat only, not used by any code in this package: t-chat-scope.js monkeypatches
    // view.sb.ai directly, relying on host.ai() reading the same `sb` reference on every call.
    this.sb = host._sb;
    setDefaultHost(host); // pre-005 backward-compat for FindView's bare-id statics (find-view.js)
    this.doc = doc;
    this.win = doc.defaultView;
    this.mode = 'chat';
    this.conversationID = null;
    this.reviewID = null;
    this.report = null; // the ReportView in the thread, if a report is open
    this.findID = null; // the paper search in the thread, if one is open
    this.currentTitle = 'New chat';
    /** spec 007 E3: the session whose results the header lists and the panel opens. Equals `conversationID` in a
     *  chat; a Find papers search that was stored as a result has its own (find-view.js). */
    this.sessionID = null;
    /** @type {import("../../../agent/src/domain").ResultSummary[]} the latest summary of every result in it */
    this.artifacts = [];
    /** @type {ArtifactCard[]} every card drawn in the thread, so a newer version can mark the older ones */
    this.cards = [];
    /** @type {ArtifactPanel | null} */ this.panel = null;
    this.artifactOpen = false;
    this.artifactExpanded = false;
    /** spec 007 E6: the result the user picked with "Use for next step"; `currentCleared` = the chip's x (next step starts fresh) */
    this.pickedRef = null;
    this.currentCleared = false;
    /** the recent sessions the empty state offers, and what the history last listed (see refreshList) */
    this.recent = [];
    this.pendingAbout = null;
    this.picking = null;
    this.findView = null;
    this.attachments = []; // { attachment, label }
    /** spec 011 U3: the skills chosen for the next message (names); each is a removable chip */
    this.skills = [];
    this.skillsDialog = new SkillsDialog(this, (name) => this.useSkill(name));
    this.selected = []; // { attachment, label }[] selected in the library when the chat was opened, for suggestions
    this.running = null; // AbortController of the turn in flight
    /** @type {ContextItem[]} what the host says the user is looking at, attached to each message */
    this.context = [];
    /** contextItemKey()s the user took out with ×; a key leaves this set once the host stops reporting it */
    this.dismissed = new Set();
    ChatView.style(this.doc);
    ReportView.style(this.doc);
    FindView.style(this.doc);
    CollectionTree.style(this.doc);
    this.build();
    OPEN_VIEWS.add(this);
    this.unlistenWhere = host.onWhereChange(() => { this.refreshList(); this.renderSources(); void this.localMenu?.refresh(); });
    this.unlistenContext = host.onContextChange(() => this.refreshContext());
    this.refreshList();
    this.showEmpty();
  }

  el(tag, cls, text) { return el(this.doc, tag, cls, text); }

  icon(name, cls = 'sb-ai-icon') { return icon(this.doc, name, cls); }

  build() {
    const root = this.root = this.el('div', `sb-ai sb-ai-host-${this.host.placement}`);

    this.side = this.el('div', 'sb-ai-side');
    const newChat = button(this.doc, 'New chat', () => this.newChat());
    newChat.classList.add('sb-ai-new');
    this.list = this.el('div', 'sb-ai-list');
    this.projects = [];
    this.projectId = this.host.prefs.get('chatProject') || null;
    this.switcher = buildSwitcher(this);
    this.switcher.hidden = true; // shown once the engine says it has projects (an older server has none)
    this.side.append(this.switcher, newChat, this.list);

    const main = this.el('div', 'sb-ai-main');
    const head = this.head = this.el('div', 'sb-ai-head');
    this.historyToggle = this.el('button', 'sb-ai-history-toggle');
    this.historyToggle.addEventListener('click', () => this.setHistoryCollapsed(!this.historyCollapsed));
    this.historyNewChat = button(this.doc, 'New chat', () => this.newChat());
    this.historyNewChat.className = 'sb-ai-history-newchat';
    this.headerTitle = this.el('span', 'sb-ai-head-title');
    this.where = this.el('span', 'sb-ai-where');
    this.artifactsButton = this.el('button', 'sb-ai-artifacts-button');
    this.artifactsButton.hidden = true;
    this.artifactsButton.addEventListener('click', (event) => { event.stopPropagation(); this.openArtifactList(); });
    head.append(this.historyToggle, this.historyNewChat, this.headerTitle, this.where, this.artifactsButton);
    if (this.host.openInTab) {
      const openInTab = this.el('button', 'sb-ai-open-tab', '⤢');
      openInTab.title = 'Open this chat in its own tab';
      openInTab.addEventListener('click', () => this.host.openInTab());
      head.append(openInTab);
    }

    this.scroller = this.el('div', 'sb-ai-scroll');
    this.thread = this.el('div', 'sb-ai-thread');
    this.scroller.append(this.thread);
    this.jump = this.el('button', 'sb-ai-jump', '↓ Jump to latest');
    this.jump.hidden = true;
    this.jump.addEventListener('click', () => this.follower.follow());
    this.follower = new ScrollFollower(this.win, this.scroller, this.thread, (paused) => { this.jump.hidden = !paused; });

    const composer = this.composer = this.el('div', 'sb-ai-composer');
    const inner = this.el('div', 'sb-ai-composer-inner');
    const box = this.el('div', 'sb-ai-box');
    this.currentChip = this.el('div', 'sb-ai-current');
    this.currentChip.hidden = true;
    this.chips = this.el('div', 'sb-ai-chips');
    this.input = /** @type {HTMLTextAreaElement} */ (this.el('textarea', 'sb-ai-input'));
    this.input.rows = 2;
    this.input.addEventListener('keydown', (event) => {
      if (this.picker?.handleKey(event)) return;
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => { this.fitInput(); this.renderSend(); this.picker?.followInput(); });
    const row = this.el('div', 'sb-ai-row');
    const modeWrap = this.el('span', 'sb-ai-modewrap');
    this.modeIcon = this.el('span', 'sb-ai-modeicon');
    this.modePick = /** @type {HTMLSelectElement} */ (this.el('select', 'sb-ai-modepick'));
    this.modePick.title = 'What kind of help you want';
    // spec 007 §7: Workflows / Tools (Systematic review joins Workflows with E8)
    for (const group of MODE_GROUPS) {
      const box = /** @type {HTMLOptGroupElement} */ (this.el('optgroup'));
      box.label = group.label;
      for (const id of group.ids) {
        const mode = ChatView.MODES.find((m) => m.id === id);
        if (!mode) continue;
        const option = /** @type {HTMLOptionElement} */ (this.el('option', '', mode.label));
        option.value = mode.id;
        option.title = mode.title;
        box.append(option);
      }
      this.modePick.append(box);
    }
    this.modePick.addEventListener('change', () => this.setMode(this.modePick.value));
    modeWrap.append(this.modeIcon, this.modePick);
    this.sourceGroup = this.el('div', 'sb-ai-sources');
    this.sourceButtons = {};
    this.sources = this.savedSources();
    /** @type {any} */
    this.engineSettings = null;
    void this.syncSources();
    for (const [id, label, title] of ChatView.SOURCES) {
      const btn = this.el('button', 'sb-ai-source', label);
      btn.title = `Search ${hintOf(this.host, id, title)}`;
      btn.addEventListener('click', () => this.toggleSource(id));
      this.sourceButtons[id] = btn;
      this.sourceGroup.append(btn);
    }
    this.sourceButtons.valency.hidden = true;
    void this.refreshConnectors();
    this.optionsButton = this.el('button', 'sb-ai-options-button');
    this.optionsButton.title = 'Where to look, and for a report the years and depth';
    this.optionsButton.addEventListener('click', () => this.setOptionsOpen(this.reportOptions.hidden));
    // spec 008 C3: a host that can list what to attach gets the `+`/`@` picker; one that can't keeps its own
    // paper picker behind "+ Add papers…".
    this.picker = this.host.contextCandidates ? new ContextPicker(this, (candidate) => this.attach([candidate])) : null;
    if (this.picker) {
      this.attachButton = this.el('button', 'sb-ai-add', '+');
      this.attachButton.title = 'Add notes, papers or collections (or type @)';
      this.attachButton.setAttribute('aria-label', 'Add context');
      // a report takes no attachments, so there `+` goes straight to Skills
      this.attachButton.addEventListener('click', () => (isReviewMode(this.mode) ? this.skillsDialog.open() : this.picker.isOpen ? this.picker.close() : this.picker.open('+')));
    } else {
      this.attachButton = button(this.doc, '+ Add papers…', () => this.pickPapers());
      this.attachButton.title = 'Choose papers from your library to ask about';
    }
    // `Skills` sits in the `+` picker; a host with no picker gets its own button beside "+ Add papers…".
    this.skillsButton = this.picker ? null : button(this.doc, 'Skills', () => this.skillsDialog.open());
    this.send = this.el('button', 'sb-ai-send');
    this.send.addEventListener('click', () => (this.running ? this.stop() : this.submit()));
    this.box = box;
    this.localMenu = new LocalMenu(this);
    row.append(modeWrap, this.sourceGroup, this.optionsButton, this.localMenu.button, this.el('span', 'sb-ed-spacer'), ...(this.skillsButton ? [this.skillsButton] : []), this.attachButton);
    // The send button lives beside the message box, never in the controls row: those wrap (a narrow pane, a wide
    // monospace font) and a wrapped send would take a row of its own.
    const inputRow = this.el('div', 'sb-ai-inputrow');
    inputRow.append(this.input, this.send);
    box.append(this.buildReportOptions(), ...(this.picker ? [this.picker.root] : []), this.currentChip, this.chips, inputRow, row);
    inner.append(this.jump, box);
    composer.append(inner);
    this.setRunning(null);

    main.append(head, this.scroller, composer);
    // spec 007 E3: the artifact panel's pane, beside the thread (>= 960 px), over it (560-959) or full view (< 560)
    this.artifactPane = this.el('div', 'sb-ai-artifact');
    this.artifactPane.hidden = true;
    root.append(this.side, main, this.artifactPane);
    const saved = this.host.prefs.get('chatMode');
    this.setMode(normalizeMode(saved, ChatView.MODES.map((m) => m.id)));
    void this.localMenu.refresh(); // spec 010: shows "Answer with" only when the engine has an On this Mac provider
    this.historyCollapsed = this.host.prefs.get('historyCollapsed') ?? false;
    this.applyHistoryCollapsed(this.historyCollapsed);
    // the selection changes under a docked view without telling it; look again when the user comes to it
    root.addEventListener('pointerenter', () => this.refreshContext());
    root.addEventListener('focusin', () => this.refreshContext());
    // a change made in Settings shows here without a reload; at most one read every few seconds
    root.addEventListener('focusin', () => {
      const now = Date.now();
      if (this.running || now - (this.sourcesSyncedAt ?? 0) < 5000) return;
      this.sourcesSyncedAt = now;
      void this.syncSources();
    });
    this.scroller.addEventListener('pointerdown', () => { if (this.narrowMode && !this.historyCollapsed) this.setHistoryCollapsed(true); });
    this.doc.addEventListener('pointerdown', this.closeOptions = (event) => {
      if (!this.reportOptions.hidden && !this.reportOptions.contains(event.target) && !this.optionsButton.contains(event.target)) this.setOptionsOpen(false);
      if (this.picker?.isOpen && !this.picker.root.contains(event.target) && !this.attachButton.contains(event.target) && event.target !== this.input) this.picker.close();
    });
    this.narrow = new this.win.ResizeObserver(() => this.applyNarrow(root.clientWidth < 560));
    this.narrow.observe(root);
    return root;
  }

  /** Scope, years and thoroughness for a Research report; Find papers uses only the scope. Other modes hide the row. */
  buildReportOptions() {
    const row = this.el('div', 'sb-ai-row sb-ai-report-options');
    row.hidden = true;
    const field = (label, ...controls) => {
      const wrap = this.el('label', 'sb-ai-field');
      wrap.append(this.el('span', '', label), ...controls);
      return wrap;
    };
    this.scopeKind = /** @type {HTMLSelectElement} */ (this.el('select', 'sb-ai-select'));
    const scopeOptions = [['library', 'Whole library']];
    if (this.host.can.scopes) {
      scopeOptions.push(['collections', 'Collections'], ['tag', 'A tag'],
        ['savedSearch', 'A saved search', 'Only narrows the search when the AI runs on this computer; on the Veritas server it searches the whole library']);
    }
    for (const [value, label, title] of scopeOptions) {
      const option = /** @type {HTMLOptionElement} */ (this.el('option', '', label));
      option.value = value;
      if (title) option.title = title;
      this.scopeKind.append(option);
    }
    this.scopeName = /** @type {HTMLSelectElement} */ (this.el('select', 'sb-ai-select'));
    this.scopeName.hidden = true;
    // Spec 008 Z4: "Collections" swaps the name select for a tree of checkboxes (this.scopeTree, built the first
    // time fillScopeNames() sees that kind — the host's collections() may be a real fetch, Obsidian's over the
    // server route, so it isn't built eagerly at construction).
    this.scopeTreeWrap = this.el('div', 'sb-ai-scope-treewrap');
    this.scopeTreeWrap.hidden = true;
    this.scopeTree = null;
    this.scopeKind.addEventListener('change', () => { this.fillScopeNames(); this.renderOptionsButton(); });
    this.yearFrom = /** @type {HTMLInputElement} */ (this.el('input', 'sb-ai-year'));
    this.yearFrom.type = 'number';
    this.yearFrom.placeholder = 'from';
    this.yearTo = /** @type {HTMLInputElement} */ (this.el('input', 'sb-ai-year'));
    this.yearTo.type = 'number';
    this.yearTo.placeholder = 'to';
    this.depth = /** @type {HTMLSelectElement} */ (this.el('select', 'sb-ai-select'));
    // The select holds the value everything else reads; the slider below drives it (spec 011 U1). Stored values stay
    // quick / standard / deep (plus fastest, left of them), so saved requests and reviews keep working.
    for (const [value, label, title] of [['fastest', 'Fastest', 'abstracts only, no screening turn'], ['quick', 'Fast', '3 sub-questions'], ['standard', 'Balanced', '5 sub-questions'], ['deep', 'Smart', '8 sub-questions, more researchers']]) {
      const option = /** @type {HTMLOptionElement} */ (this.el('option', '', label));
      option.value = value;
      option.title = title;
      this.depth.append(option);
    }
    this.depth.value = 'standard';
    this.depthSlider = /** @type {HTMLInputElement} */ (this.el('input', 'sb-ai-depth'));
    this.depthSlider.type = 'range';
    this.depthSlider.min = '0'; this.depthSlider.max = String(this.depth.options.length - 1); this.depthSlider.step = '1';
    this.depthSlider.setAttribute('aria-label', 'Depth');
    this.depthLabel = this.el('span', 'sb-ai-depth-label');
    this.usageEl = this.el('span', 'sb-ai-usage-line');
    this.usageEl.hidden = true;
    this.depthSeq = 0;
    this.depthSlider.addEventListener('input', () => {
      this.depth.selectedIndex = Number(this.depthSlider.value);
      // Direct calls, not a synthetic `change`: `Event` is not a global in Zotero's script scope.
      this.syncDepth();
      this.renderOptionsButton();
    });
    this.depth.addEventListener('change', () => this.syncDepth());
    this.syncDepth();
    for (const control of [this.scopeName, this.yearFrom, this.yearTo, this.depth]) control.addEventListener('change', () => this.renderOptionsButton());
    row.addEventListener('keydown', (event) => { if (event.key === 'Escape') { this.setOptionsOpen(false); this.optionsButton.focus(); } });
    this.yearsField = field('Years', this.yearFrom, this.el('span', '', '–'), this.yearTo);
    this.depthField = field('Depth', this.depthSlider, this.depthLabel, this.usageEl);
    row.append(field('Look in', this.scopeKind, this.scopeName), this.yearsField, this.depthField, this.scopeTreeWrap);
    this.reportOptions = row;
    return row;
  }

  /** The options sit in a small panel above the controls row, opened from one button, so they never crowd the text. */
  setOptionsOpen(open) {
    this.reportOptions.hidden = !open;
    this.optionsButton.setAttribute('aria-expanded', String(open));
    this.optionsButton.classList.toggle('is-open', open);
    if (open) void this.refreshUsage();
  }

  /** The chosen AI's latest usage-window reading, from the engine; blank when it has none. Never throws. */
  async refreshUsage() {
    let text = '';
    try {
      const ai = await this.host.ai();
      const [statuses, roles] = await Promise.all([ai.providers.status(), ai.providers.roles()]);
      text = usageLine(statuses, (roles.lead ?? roles.chat)?.provider);
    } catch { /* the line is a nicety */ }
    this.usageEl.textContent = text;
    this.usageEl.hidden = !text;
  }

  /** The button says what's chosen: "Whole library", or for a report "Whole library · 2019-2024 · Deep". Spec
   *  008 Z4: for a collections scope, the single collection's name, or "N collections". */
  /** Moves the slider to the select's value and shows what that depth costs, in model turns (spec 011 U1). */
  syncDepth() {
    const name = this.depth.selectedOptions[0]?.textContent ?? '';
    this.depthSlider.value = String(this.depth.selectedIndex);
    this.depthLabel.textContent = name;
    this.depthSlider.setAttribute('aria-valuetext', name);
    const seq = ++this.depthSeq;
    const request = { depth: /** @type {"fastest"|"quick"|"standard"|"deep"} */ (this.depth.value), systematic: this.mode === 'systematic' };
    Promise.resolve().then(async () => {
      const ai = await this.host.ai();
      if (typeof ai.reviews?.estimate !== 'function') return;
      const estimate = await ai.reviews.estimate(request);
      if (seq !== this.depthSeq) return;
      const text = estimateText(name, estimate);
      this.depthLabel.textContent = text;
      this.depthLabel.title = `Between ${estimate.low} and ${estimate.high} model turns, depending on how many papers it finds`;
      this.depthSlider.setAttribute('aria-valuetext', text);
    }).catch(() => { /* the estimate is a nicety; the name alone stands */ });
  }

  renderOptionsButton() {
    const kind = this.scopeKind.value;
    const where = kind === 'library' ? 'Whole library' : kind === 'collections' ? this.collectionsLabel()
      : this.scopeName.value || this.scopeKind.selectedOptions[0]?.textContent;
    const parts = [where];
    if (isReviewMode(this.mode)) {
      const from = this.yearFrom.value, to = this.yearTo.value;
      if (from || to) parts.push(from && to ? `${from}–${to}` : from ? `${from} on` : `to ${to}`);
      if (this.depth.value !== 'standard') parts.push(this.depth.selectedOptions[0]?.textContent);
    }
    this.optionsButton.textContent = `${parts.join(' · ')} ▾`;
  }

  /** Collections/tags/saved searches for the scope picker, from the host. Empty (never throws) if it can't list
   *  one. `host.scopeNames` is typed as returning a Promise (host.d.ts), but Zotero's own list is plain
   *  synchronous data (Zotero.Collections.getByLibrary etc., no I/O) and its adapter hands it back as a bare
   *  array, not wrapped in one: the pre-005 Zotero harness test (t-chat-scope.js) sets the <select>'s value in
   *  the same script turn as the "change" event that calls this, with no await in between, which only a
   *  same-tick population (no Promise, not even an already-resolved one — awaiting always yields a microtask)
   *  satisfies. A host that genuinely needs to await (a future Obsidian API call) still works: the `.then`
   *  branch below. */
  fillScopeNames() {
    const kind = this.scopeKind.value;
    this.scopeName.hidden = kind === 'library' || kind === 'collections';
    this.scopeTreeWrap.hidden = kind !== 'collections';
    this.scopeName.replaceChildren();
    if (kind === 'collections') { this.fillScopeTree(); return; }
    if (kind === 'library' || !this.host.can.scopes) return;
    const populate = (names) => {
      for (const name of [...new Set(names)].sort()) {
        const option = /** @type {HTMLOptionElement} */ (this.el('option', '', name));
        option.value = name;
        this.scopeName.append(option);
      }
    };
    const result = this.host.scopeNames(kind);
    if (result && typeof result.then === 'function') result.then(populate).catch((error) => this.host.logError(error));
    else populate(result ?? []);
  }

  /** Builds (or rebuilds, if the tree's already there and the collection list simply hasn't changed) the tree
   *  from `host.collections()` and seeds it with whatever's currently selected, so reopening the picker doesn't
   *  lose a choice. Same bare-array-or-Promise tolerance as fillScopeNames, above. */
  fillScopeTree() {
    if (!this.host.can.scopes) return;
    const build = (nodes) => {
      const initial = this.scopeTree?.getKeys() ?? [];
      this.scopeTreeWrap.replaceChildren();
      this.scopeTree = new CollectionTree(this.doc, nodes ?? [], initial, () => this.renderOptionsButton());
      this.scopeTreeWrap.append(this.scopeTree.root);
      this.renderOptionsButton();
    };
    const result = this.host.collections();
    if (result && typeof result.then === 'function') result.then(build).catch((error) => this.host.logError(error));
    else build(result ?? []);
  }

  /** "Foraging Strategies…" for one collection, "3 collections" for several, a neutral label for none. */
  collectionsLabel() {
    const keys = this.scopeTree?.getKeys() ?? [];
    if (keys.length === 0) return 'Choose collections…';
    if (keys.length === 1) return this.scopeTree.byKey.get(keys[0])?.name ?? '1 collection';
    return `${keys.length} collections`;
  }

  scopeValue() {
    const kind = this.scopeKind.value;
    if (kind === 'collections') return { kind: 'collections', keys: this.scopeTree?.getKeys() ?? [] };
    const name = this.scopeName.value;
    return kind !== 'library' && name ? { kind, name } : { kind: 'library' };
  }

  /** Pull the pills from the engine's settings (the Sources chips write them), moving an old `chatSources` pref over
   *  once. Without the engine the pills keep what the pref said. */
  async syncSources() {
    try {
      const ai = await this.host.ai();
      const seen = this.sourceToggles ?? 0;
      const prefs = this.host.prefs;
      let settings = await ai.settings.get();
      // a different engine (the Zotero server came or went) is asked afresh
      if (this.sourcesEngine !== ai) { this.sourcesEngine = ai; this.sourcesUnsupported = false; }
      // an engine from before `sources` never returns the key (a current one returns null or an object)
      if (settings && !('sources' in settings)) this.sourcesUnsupported = true;
      if (!prefs.get('sourcesMigrated') && !this.sourcesUnsupported) {
        const pref = prefs.get('chatSources');
        const migration = migrationPatch(pref, settings);
        if (migration) {
          settings = await ai.settings.update(migration);
          // an engine from before `sources` drops the key: leave the move for when it is upgraded
          if (settings?.sources == null) this.sourcesUnsupported = true;
        }
        if (!this.sourcesUnsupported) prefs.set('sourcesMigrated', true);
      }
      // a pill was just flipped (writing, or flipped since this read began); its own write is the newer truth
      if (this.sourceWrites > 0 || (this.sourceToggles ?? 0) !== seen) return;
      this.engineSettings = settings;
      void this.refreshConnectors();
      // an engine without `sources` can't hold the switches: the pref is the truth there, all four pills
      const pills = this.sourcesUnsupported ? { ...this.sources } : pillsFrom(settings);
      if (!this.sourcesUnsupported) prefs.set('chatSources', pills); // the offline fallback follows the engine
      this.sources = pills;
      this.renderSources();
      this.renderSend();
    } catch (error) { this.host.logError?.(error); }
  }

  /** Reads either shape (spec 005 §5's "how saved things map", read-time only, nothing rewritten on disk): the
   *  pre-005 `{ library, scholarly, web }` expands library to both papers and notes; the current
   *  `{ papers, notes, scholarly, web }` is used as saved. Default when nothing is saved: papers, notes and
   *  scholarly on, web off. */
  savedSources() {
    const saved = this.host.prefs.get('chatSources');
    if (saved && typeof saved === 'object') {
      if ('papers' in saved || 'notes' in saved) {
        return { papers: saved.papers !== false, notes: saved.notes !== false, scholarly: saved.scholarly !== false, web: !!saved.web, ...(typeof saved.valency === 'boolean' ? { valency: saved.valency } : {}) };
      }
      if ('library' in saved) {
        return { papers: saved.library !== false, notes: saved.library !== false, scholarly: saved.scholarly !== false, web: !!saved.web };
      }
    }
    return { papers: true, notes: true, scholarly: true, web: false };
  }

  /** The Valency chip shows only while that connector is connected; a host without connectors keeps it hidden. */
  async refreshConnectors() {
    const btn = this.sourceButtons?.valency;
    if (!btn) return;
    /** @type {any} */ let reports = null;
    try { reports = await (await this.host.ai()).mcp?.list?.(); } catch (error) { this.host.logError?.(error); }
    // shown while the connector is enabled and has not failed (while it connects the hub reports "disabled")
    const on = Array.isArray(reports) && reports.some((r) => r?.config?.name === 'valency' && r.config.enabled !== false && r.state !== 'failed');
    if (btn.hidden === !on) return;
    btn.hidden = !on;
    this.renderSources();
    this.renderSend();
  }

  /** What a send carries for the pills: the web mode Research picked when the web pill is on, and a copy of the switches. */
  sendSources() {
    return { web: webFor(this.sources, this.engineSettings), sources: { ...this.sources } };
  }

  toggleSource(id) {
    const before = { ...this.sources };
    // valency is on while unset (an optional switch), so its first click turns it off
    this.sources[id] = id === 'valency' ? this.sources.valency === false : !this.sources[id];
    this.host.prefs.set('chatSources', this.sources);
    // the engine holds the same switches the Settings chips show; a failed write leaves the pill as the user set it
    this.sourcesSyncedAt = Date.now();
    this.sourceWrites = (this.sourceWrites ?? 0) + 1;
    this.sourceToggles = (this.sourceToggles ?? 0) + 1;
    void (async () => {
      try {
        const patch = togglePatch(id, before);
        this.engineSettings = await (await this.host.ai()).settings.update(patch);
        if (patch.sources && this.engineSettings?.sources == null) { this.sourcesUnsupported = true; this.sourcesEngine = await this.host.ai(); }
      } catch (error) { this.host.logError?.(error); } finally { this.sourceWrites -= 1; }
    })();
    this.renderSources();
    this.renderSend();
    const emptyText = this.thread.querySelector('.sb-ai-empty .sb-ai-empty-text');
    if (emptyText) emptyText.textContent = this.noSources ? 'Turn on at least one source.' : modeEmpty(this.host, this.modeInfo.empty);
  }

  /** All four pills show in every mode (spec 005 §5); Find papers disables Notes (the table lists papers, not
   *  notes — decision 1) and Web (not used there) with the reason as their tooltip. Notes gets an offline mark
   *  when the host can't search the vault right now (Zotero standalone, no server): the pill stays clickable
   *  (its value is kept for when the server comes back), just marked. */
  renderSources() {
    const disabledInFind = { notes: 'The table lists papers, not notes.', web: 'Find papers doesn’t search the web.', valency: 'Find papers searches its own databases; ask in Chat to use Valency.' };
    const offline = this.host.where() === 'local';
    for (const [id, btn] of Object.entries(this.sourceButtons)) {
      const disabledHere = this.mode === 'find' ? disabledInFind[id] : null;
      btn.disabled = !!disabledHere;
      const on = id === 'valency' ? this.sources.valency !== false : !!this.sources[id];
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('is-offline', id === 'notes' && offline);
      const [, , title] = ChatView.SOURCES.find(([sid]) => sid === id);
      const hint = hintOf(this.host, id, title);
      btn.title = disabledHere ?? (id === 'notes' && offline
        ? "Notes need the Veritas server, which isn't running" : `Search ${hint}`);
    }
  }

  /** True once every source pill is off — Send is disabled and the empty state explains why (spec 005 §5). */
  get noSources() {
    const valency = !this.sourceButtons?.valency?.hidden && this.sources.valency !== false;
    return !this.sources.papers && !this.sources.notes && !this.sources.scholarly && !this.sources.web && !valency;
  }

  destroy() {
    this.localMenu?.destroy();
    this.report?.stop();
    this.running?.abort();
    this.unlistenWhere?.();
    this.unlistenContext?.();
    this.narrow?.disconnect();
    this.routinesView?.dispose();
    this.follower.destroy();
    this.doc.removeEventListener('pointerdown', this.closeOptions);
    OPEN_VIEWS.delete(this);
  }

  // ------------------------------------------------------------------ the paper in context (sidebar)

  /** Asks the host what's being read now; a change shows as the context chips and in the suggestions. A chip
   *  taken out with × stays out only while the host keeps reporting that same item. */
  async refreshContext() {
    const items = await this.host.context();
    const key = items.map(contextItemKey).join('\n');
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.context = items;
    const present = new Set(items.map(contextItemKey));
    for (const dismissed of this.dismissed) if (!present.has(dismissed)) this.dismissed.delete(dismissed);
    this.renderChips();
  }

  /** The context that goes with the next message: what the user hasn't taken out, in modes that use it. */
  get activeContext() {
    if (isReviewMode(this.mode) || this.mode === 'find') return [];
    return this.context.filter((c) => !this.dismissed.has(contextItemKey(c))
      && !this.attachments.some((a) => attachmentKey(a.attachment) === attachmentKey(c.attachment)));
  }

  // ------------------------------------------------------------------ state

  /** The toggle and its tooltip live in the header regardless of state, so the list stays reachable through it;
   *  "New chat" gets its own header button when the side panel (which normally holds it) is hidden. */
  setHistoryCollapsed(collapsed) {
    this.historyCollapsed = collapsed;
    this.host.prefs.set('historyCollapsed', collapsed);
    this.applyHistoryCollapsed(collapsed);
  }

  applyHistoryCollapsed(collapsed) {
    this.root.classList.toggle('is-history-open', !collapsed);
    this.side.hidden = collapsed;
    this.historyNewChat.hidden = !collapsed;
    this.headerTitle.hidden = !collapsed;
    this.headerTitle.textContent = this.currentTitle;
    const label = collapsed ? 'Show chat history' : 'Hide chat history';
    this.historyToggle.title = label;
    this.historyToggle.setAttribute('aria-label', label);
    this.historyToggle.setAttribute('aria-expanded', String(!collapsed));
    this.historyToggle.textContent = collapsed ? '▶' : '◀';
    this.applyArtifactLayout();
  }

  /** Below ~560 px (the docked sidebar) the history list becomes a drawer over the thread, and the empty state and
   *  Find papers' table go to one column (see .sb-ai.is-narrow in the stylesheet). */
  applyNarrow(isNarrow) {
    this.side.style.insetBlockStart = isNarrow ? `${this.head.offsetHeight}px` : ''; // under the header, never over its toggle
    this.applyArtifactLayout();
    if (this.narrowMode === isNarrow) return;
    this.narrowMode = isNarrow;
    this.root.classList.toggle('is-narrow', isNarrow);
    this.historyNewChat.textContent = isNarrow ? '+' : 'New chat';
    this.historyNewChat.title = 'New chat';
  }

  setHeaderTitle(title) {
    this.currentTitle = title || 'New chat';
    if (this.historyCollapsed) this.headerTitle.textContent = this.currentTitle;
  }

  get modeInfo() {
    return ChatView.MODES.find((m) => m.id === this.mode) ?? ChatView.MODES[0];
  }

  /** Switches mode. `fresh` (the default) also starts an empty thread; opening something from the history
   *  switches without it and fills the thread itself. */
  setMode(mode, { fresh = true } = {}) {
    if (this.running) { this.modePick.value = this.mode; return; }
    if (PICKER_MODES.includes(mode) && fresh) { this.startPaperTool(mode); return; }
    this.picking = null;
    this.mode = mode;
    // Routines is a view, not a conversation: like the picker modes it is never remembered as the saved mode.
    if (!PICKER_MODES.includes(mode) && !VIEW_MODES.includes(mode)) this.host.prefs.set('chatMode', mode);
    this.composer.hidden = VIEW_MODES.includes(mode);
    if (mode !== 'routines') { this.routinesView?.dispose(); this.routinesView = null; }
    this.modePick.value = mode;
    this.localMenu?.setMode(mode);
    this.modeIcon.replaceChildren(this.icon(modeIconName(mode)));
    const report = isReviewMode(mode);
    const find = mode === 'find';
    this.setOptionsOpen(false);
    // "Look in" narrows search_library in every mode now; years and depth stay report-only.
    this.optionsButton.hidden = false;
    this.yearsField.hidden = this.depthField.hidden = !report;
    if (report) this.syncDepth();
    this.renderOptionsButton();
    if (this.picker) this.attachButton.title = report ? 'Skills' : 'Add notes, papers or collections (or type @), or use a skill';
    this.attachButton.hidden = find || (report && !this.picker); // the sidebar attaches what you're reading by itself (host.context()); in a report `+` is Skills
    if (this.skillsButton) this.skillsButton.hidden = !this.skillsApply;
    this.renderSources();
    this.renderChips();
    this.renderCurrent();
    if (!fresh) return;
    this.report?.stop();
    this.report = null;
    this.conversationID = null;
    this.reviewID = null;
    this.findID = null;
    this.resetArtifacts();
    this.findView = null;
    this.setHeaderTitle(mode === 'routines' ? 'Routines' : 'New chat');
    this.markSelected();
    if (mode === 'routines') this.showRoutines();
    else this.showEmpty();
  }

  /** Spec 011 U4: the Routines view fills the thread area; there is no composer in this mode. */
  showRoutines() {
    this.routinesView?.dispose();
    this.routinesView = new RoutinesView(this);
    this.thread.replaceChildren(this.routinesView.root);
    this.follower.disable();
  }

  /** "Create routine for this" (artifact More menu): the create sheet over the open table, prefilled to keep that table up
   *  to date. Nothing leaves the thread; the routine is listed under Routines. @param {{ id: string, title?: string }} result */
  openRoutines(result) {
    if (!this.sessionID) return;
    const draft = draftForArtifact({ session: this.sessionID, result: result.id, title: result.title });
    new RoutineSheet(this, { draft, onSaved: () => this.host.notice?.('Routine created. Find it under Routines in the mode menu.') }).open();
  }

  attach(items) {
    for (const item of items) {
      const key = attachmentKey(item.attachment);
      if (this.attachments.some((a) => attachmentKey(a.attachment) === key)) continue;
      this.attachments.push({ attachment: item.attachment, label: item.label });
    }
    this.renderChips();
  }

  /** "+ Add papers…": the host's own item picker, so a paper can be attached from the full "Second Brain AI" tab
   *  even when the library pane isn't visible. */
  async pickPapers() {
    const items = await this.host.pickPapers();
    if (!items.length) return;
    this.attach(items);
    this.input.focus();
  }

  /** Skills shape a chat message and a report; the other modes have no prompt of ours to put one in. */
  get skillsApply() { return this.mode === 'chat' || isReviewMode(this.mode); }

  /** "Use skill": a removable chip in the composer (once per skill). */
  useSkill(name) {
    if (!this.skills.includes(name)) this.skills.push(name);
    this.renderChips();
    this.input.focus();
  }

  dropSkill(name) {
    this.skills = this.skills.filter((n) => n !== name);
    this.renderChips();
  }

  /** One chip per thing in context (spec 008 C1/C2): the note or paper being read as "<title> Current", text
   *  selected in it as its own chip, papers selected in the library as one "N selected papers" chip, then what
   *  the user attached. Each × takes out only its own chip. */
  renderChips() {
    this.chips.replaceChildren();
    const context = this.activeContext;
    const skillsApply = this.skillsApply;
    this.chips.hidden = ((!this.attachments.length && !context.length) || isReviewMode(this.mode) || this.mode === 'find') && !(skillsApply && this.skills.length);
    const contextChip = (items, title, tag) => {
      const chip = this.el('span', 'sb-ai-chip sb-ai-context');
      chip.dataset.why = items[0].why;
      chip.title = items.map((c) => c.label).join('\n');
      const remove = this.el('button', 'sb-ai-chip-x', '×');
      remove.title = 'Leave this out of the next message';
      remove.addEventListener('click', () => {
        for (const item of items) this.dismissed.add(contextItemKey(item));
        this.renderChips();
      });
      chip.append(this.icon(ATTACHMENT_ICON[items[0].attachment.kind] ?? 'note'), this.el('span', 'sb-ai-context-title', title),
        this.el('span', 'sb-ai-chip-tag', tag), remove);
      this.chips.append(chip);
    };
    if (skillsApply) {
      for (const name of this.skills) {
        const chip = this.el('span', 'sb-ai-chip sb-ai-skill-chip');
        chip.title = `Skill: ${name}`;
        const remove = this.el('button', 'sb-ai-chip-x', '×');
        remove.title = 'Remove this skill';
        remove.addEventListener('click', () => this.dropSkill(name));
        chip.append(this.icon('sparkle'), this.el('span', 'sb-ai-chip-label', name), this.el('span', 'sb-ai-chip-tag', 'Skill'), remove);
        this.chips.append(chip);
      }
    }
    const showContext = !(isReviewMode(this.mode) || this.mode === 'find'); // attachments and context only travel with a chat message
    if (showContext) {
    for (const item of context.filter((c) => c.why === 'reading' || c.why === 'active-note')) contextChip([item], item.label, 'Current');
    for (const item of context.filter((c) => c.why === 'selection')) contextChip([item], item.label, 'Selection');
    const selected = context.filter((c) => c.why === 'selected');
    if (selected.length) contextChip(selected, selected.length === 1 ? selected[0].label : `${selected.length} selected papers`, 'Selected');
    for (const entry of this.attachments) {
      const chip = this.el('span', 'sb-ai-chip');
      chip.title = entry.attachment.kind === 'zoteroItem' ? `[@${entry.attachment.citekey}]` : entry.attachment.kind === 'note' ? `[[${entry.attachment.path}]]` : '';
      const remove = this.el('button', 'sb-ai-chip-x', '×');
      remove.title = 'Remove';
      remove.addEventListener('click', () => {
        this.attachments = this.attachments.filter((a) => a !== entry);
        this.renderChips();
      });
      chip.append(this.icon(ATTACHMENT_ICON[entry.attachment.kind] ?? 'note'), this.el('span', 'sb-ai-chip-label', entry.label), remove);
      this.chips.append(chip);
    }
    }
    const papers = this.attachments.length + context.length;
    const asks = this.mode === 'chat' || this.mode === 'ask';
    this.input.placeholder = asks && this.picker ? 'Ask anything · @ to add context'
      : asks && papers ? (papers === 1 ? 'Ask about this paper…' : 'Ask about these papers…') : this.modeInfo.placeholder;
    if (this.pendingAbout) this.input.placeholder = this.pendingAbout;
    this.renderSuggestions();
  }

  /** Pills at the foot of the empty thread, just above the message box. They name the papers attached, or else
   *  the ones selected in the library, so the obvious next question is one click away. */
  renderSuggestions() {
    const box = this.thread?.querySelector('.sb-ai-suggestions');
    if (!box) return;
    box.replaceChildren();
    const mode = this.modeInfo;
    if (PICKER_MODES.includes(this.mode)) return;
    const context = this.activeContext;
    const selected = this.attachments.length || context.length ? [] : this.selected;
    const papers = this.attachments.length || context.length ? [...context, ...this.attachments].map((a) => a.label) : selected.map((s) => s.label);
    const pill = (text, onClick) => {
      const btn = this.el('button', 'sb-ai-pill');
      btn.append(this.icon(modeIconName(mode.id)), this.el('span', '', text));
      btn.title = text;
      btn.addEventListener('click', onClick);
      box.append(btn);
    };
    // spec 011 U5: papers selected in the library can start a chat, a table or a report in one click
    const picked = selectedPapers(this.attachments.length ? [] : context.length ? context.filter((c) => c.why === 'selected') : this.selected);
    if (picked.length && (this.mode === 'chat' || this.mode === 'ask')) {
      box.append(selectionCard(this.doc, picked, { report: Boolean(this.engineCanReport) }, (kind) => this.startFromSelection(kind, picked)));
    }
    // spec 007 §7: up to three cards; the most recent sessions first, then the context suggestions
    const cards = cardSplit(this.recent);
    if (cards.length) {
      const row = this.el('div', 'sb-ai-cardrow');
      for (const session of cards) row.append(this.sessionCard(session));
      box.append(row);
    }
    for (const text of mode.suggest?.(papers) ?? []) {
      pill(text, () => {
        if (selected.length) this.attach(selected);
        this.input.value = text;
        this.submit();
      });
    }
    for (const text of mode.starters ?? []) {
      pill(`${text.trim()}…`, () => {
        this.input.value = text;
        this.fitInput();
        this.renderSend();
        this.input.focus();
        this.input.setSelectionRange(text.length, text.length);
      });
    }
  }

  fitInput() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(200, this.input.scrollHeight)}px`;
  }

  setRunning(controller) {
    this.running = controller;
    this.send.replaceChildren(this.icon(controller ? 'stop' : 'send'));
    this.send.setAttribute('aria-label', controller ? 'Stop' : 'Send');
    this.send.title = controller ? 'Stop the answer' : 'Send (Enter)';
    this.modePick.disabled = !!controller;
    this.renderSend();
    this.panel?.syncChatRunning();
    this.markRunning();
    if (!controller) this.renderAddStep();
  }

  /** Muted while there is nothing to send; full accent once there is, and while an answer can be stopped.
   *  Genuinely disabled (not just idle-styled), not just muted, when every source pill is off (spec 005 §5). */
  renderSend() {
    this.send.dataset.state = this.running ? 'stop' : this.input.value.trim() && !this.noSources ? 'ready' : 'idle';
    this.send.disabled = !this.running && this.noSources;
  }

  stop() {
    this.running?.abort();
  }

  // ------------------------------------------------------------------ conversations list

  async refreshList() {
    let ai;
    try {
      ai = await this.host.ai();
    } catch (error) {
      this.host.logError(error);
      return;
    }
    this.engineCanFill = Boolean(ai.sessions?.run && ai.sessions?.estimate && ai.sessions?.events);
    this.engineCanReport = Boolean(ai.reviews?.answer); // pipeline 2 (spec 007 E7): clarify cards and reports written from a table
    this.where.textContent = ai.where === 'server' ? 'Runs on the Veritas server' : 'Runs on this computer';
    this.canProject = Boolean(ai.projects);
    const [conversations, reviews, searches, projects] = await Promise.all([ai.conversations.list().catch(() => []),
      Promise.resolve().then(() => ai.reviews.list()).catch(() => []), FindView.list(this.host).catch(() => []),
      this.canProject ? ai.projects.list().catch(() => this.projects) : []]);
    this.projects = projects;
    this.newsById = new Map(conversations.filter((x) => x.news).map((x) => [x.id, x.news])); // the Routines view reads this
    if (this.projectId && !projects.some((p) => p.id === this.projectId)) this.setProject(null, { refresh: false }); // its project is gone
    this.switcher.hidden = !this.canProject;
    paintSwitcher(this, this.switcher);
    // spec 007 §1.4: a saved search whose JSON names an existing session is listed once, as that session
    const shown = historyEntries(conversations, searches);
    this.recent = shown.sessions.map((e) => ({ ...e.conversation, search: e.search })).sort((a, b) => (a.updated < b.updated ? 1 : -1));
    const all = [
      ...shown.sessions.map((e) => ({ kind: 'chat', at: e.conversation.updated, conversation: { ...e.conversation, search: e.search } })),
      ...reviews.map((progress) => ({ kind: 'report', at: progress.started ?? '', progress })),
      ...shown.searches.map((search) => ({ kind: 'find', at: search.at, search })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
    const known = projects.map((p) => p.id);
    const entries = filterEntries(all, this.projectId, known);
    this.recent = this.recent.filter((c) => entries.some((e) => e.kind === 'chat' && e.conversation.id === c.id));
    this.list.replaceChildren();
    if (!entries.length) this.list.append(this.el('div', 'sb-muted sb-ai-list-empty', emptyLine(projects.find((p) => p.id === this.projectId))));
    for (const entry of entries) {
      this.list.append(entry.kind === 'chat' ? this.chatRow(entry.conversation) : entry.kind === 'find' ? this.findRow(entry.search) : this.reportRow(entry.progress));
    }
    this.markSelected();
    if (this.thread.querySelector('.sb-ai-empty')) this.renderSuggestions();
    this.markRunning();
    this.renderAddStep();
  }

  /** Is this session's step running right now (the one open here)? A quiet dot, as reports have their status. */
  sessionRunning(conversation) {
    return Boolean(conversation.running) || (Boolean(this.running || this.panel?.run) && this.sessionID === conversation.id);
  }

  chatRow(conversation) {
    const row = this.el('div', `sb-ai-conv kind-${conversation.search ? 'find' : conversation.kind ?? 'chat'}${this.sessionRunning(conversation) ? ' is-running' : ''}`);
    // a session that holds a saved Find search is that search's row: same id and `is-find` as ever, plus its session
    row.dataset.id = conversation.search ? conversation.search.id : conversation.id;
    row.dataset.session = conversation.id;
    if (conversation.search) row.classList.add('is-find');
    const text = this.el('div', 'sb-ai-conv-text');
    const titleRow = this.el('div', 'sb-ai-conv-titlerow');
    titleRow.append(this.el('div', 'sb-ai-conv-title', conversation.title), ...this.newsBadge(conversation));
    text.append(titleRow, this.el('div', 'sb-ai-conv-date', this.when(conversation.updated)));
    const remove = this.el('button', 'sb-ai-conv-x', '×');
    remove.title = conversation.search ? 'Delete this search' : 'Delete this chat';
    remove.addEventListener('click', (event) => { event.stopPropagation(); this.remove(conversation); });
    row.append(this.icon(SESSION_KIND_ICON[conversation.search ? 'find' : conversation.kind ?? 'chat'] ?? 'chat'), text);
    if (conversation.routine) {
      const made = this.icon('clock', 'sb-ai-icon sb-ai-conv-routine');
      made.append(Object.assign(this.doc.createElementNS(SVG_NS, 'title'), { textContent: 'Made by a routine' }));
      row.append(made);
    }
    if (conversation.artifacts > 0) {
      const count = this.el('span', 'sb-ai-conv-count', String(conversation.artifacts));
      count.title = artifactsWord(conversation.artifacts);
      row.append(count);
    }
    row.append(this.el('span', 'sb-ai-conv-dot'), ...this.moreButton({ kind: 'chat', conversation }, row), remove);
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); openRowMenu(this, { kind: 'chat', conversation }, row); });
    row.addEventListener('click', () => this.openSession(conversation));
    row.addEventListener('dblclick', () => this.rename(conversation));
    row.title = 'Double-click to rename';
    return row;
  }

  /** The small "N new" badge for a session a routine added papers to since it was last opened ([] when there is none). */
  newsBadge(conversation) {
    const label = newsLabel(conversation.news);
    if (!label) return [];
    const badge = this.el('span', 'sb-ai-news', label);
    badge.title = newsTitle(conversation.news);
    return [badge];
  }

  /** The user opened this session: tells the engine (so the badge stays gone) and clears it here without a refresh.
   *  An older server has no `markSeen`; the badge then simply never appears. */
  markSeen(id) {
    for (const c of this.recent) if (c.id === id) delete c.news;
    for (const badge of Array.from(this.root.querySelectorAll('.sb-ai-news'))) {
      if (badge.closest('[data-id="' + id + '"], [data-session="' + id + '"]')) badge.remove();
    }
    if (this.newsById) this.newsById.delete(id);
    this.host.ai().then((ai) => ai.conversations.markSeen?.(id)).catch((error) => this.host.logError(error));
  }

  /** A session opens as what it is: the saved Find search it belongs to (the table with its summary), or the thread. */
  openSession(conversation) {
    if (conversation.search) { this.markSeen(conversation.id); return this.openFind(conversation.search.id); }
    return this.openConversation(conversation.id);
  }

  /** One suggestion card in the empty state: the title, then the kind, when, and how many artifacts it holds. */
  sessionCard(conversation) {
    const card = this.el('button', 'sb-ai-card');
    card.dataset.id = conversation.id;
    const kind = conversation.search ? 'find' : conversation.kind ?? 'chat';
    const meta = this.el('span', 'sb-ai-card-meta');
    meta.append(this.icon(SESSION_KIND_ICON[kind] ?? 'chat'), this.el('span', 'sb-ai-card-when', sessionMeta({ kind, updated: conversation.updated })));
    if (conversation.artifacts > 0) {
      const count = this.el('span', 'sb-ai-card-count', String(conversation.artifacts));
      count.title = artifactsWord(conversation.artifacts);
      meta.append(count);
    }
    meta.append(...this.newsBadge(conversation));
    card.append(this.el('span', 'sb-ai-card-title', conversation.title), meta);
    card.addEventListener('click', () => this.openSession(conversation));
    return card;
  }

  reportRow(progress) {
    const row = this.el('div', `sb-ai-conv is-report is-${progress.status.state}`);
    row.dataset.id = progress.id;
    const text = this.el('div', 'sb-ai-conv-text');
    const date = progress.started ? ` · ${this.when(progress.started)}` : '';
    text.append(this.el('div', 'sb-ai-conv-title', progress.question || 'Research report'),
      this.el('div', 'sb-ai-conv-date', ReportView.statusLine(progress) + date));
    row.append(this.icon('report'), text, ...this.moreButton({ kind: 'report', progress }, row));
    row.addEventListener('contextmenu', (event) => { event.preventDefault(); openRowMenu(this, { kind: 'report', progress }, row); });
    row.addEventListener('click', () => this.openReport(progress.id, progress.question));
    return row;
  }

  findRow(search) {
    const row = this.el('div', 'sb-ai-conv is-find');
    row.dataset.id = search.id;
    const text = this.el('div', 'sb-ai-conv-text');
    text.append(this.el('div', 'sb-ai-conv-title', search.query), this.el('div', 'sb-ai-conv-date', `${search.count} papers · ${this.when(search.at)}`));
    const remove = this.el('button', 'sb-ai-conv-x', '×');
    remove.title = 'Delete this search';
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!(await this.host.confirm(`Delete "${search.query}"? This can't be undone.`, { title: 'Delete search' }))) return;
      try { // its stored result goes with it, or the session would stay behind, unlisted
        const session = (await FindView.load(this.host, search.id)).session;
        if (session) await (await this.host.ai()).conversations.remove(session);
      } catch (error) { this.host.logError(error); }
      await FindView.remove(this.host, search.id);
      if (this.findID === search.id) this.setMode('find');
      ChatView.refreshAll();
    });
    row.append(this.icon('find'), text, remove);
    row.addEventListener('click', () => this.openFind(search.id));
    return row;
  }

  markSelected() {
    const open = new Set([this.conversationID, this.reviewID, this.findID, this.sessionID].filter(Boolean));
    for (const row of this.list?.children ?? []) row.classList.toggle('is-selected', open.has(row.dataset.id) || open.has(row.dataset.session));
  }

  /** The quiet dot on the open session's row while one of its steps runs. */
  markRunning() {
    const running = Boolean(this.running || this.panel?.run);
    for (const row of this.list?.children ?? []) {
      if (row.classList.contains('sb-ai-conv') && !row.classList.contains('is-report')) row.classList.toggle('is-running', running && (row.dataset.session ?? row.dataset.id) === this.sessionID);
    }
  }

  when(iso) {
    const date = new Date(iso);
    const today = new Date().toDateString() === date.toDateString();
    return today ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString();
  }

  /** What's open, so another view can show the same thing ("Open in a tab"). */
  handoff() {
    if (this.conversationID) return { kind: 'chat', id: this.conversationID };
    if (this.reviewID) return { kind: 'report', id: this.reviewID, question: this.currentTitle };
    if (this.findID) return { kind: 'find', id: this.findID };
    return null;
  }

  openHistoryItem(item) {
    if (item.kind === 'chat' && this.conversationID !== item.id) this.openConversation(item.id);
    else if (item.kind === 'report' && this.reviewID !== item.id) this.openReport(item.id, item.question);
    else if (item.kind === 'find' && this.findID !== item.id) this.openFind(item.id);
  }

  /** A new, empty thread in the current mode. */
  newChat() {
    if (this.running) return;
    void this.syncSources();
    this.setMode(VIEW_MODES.includes(this.mode) ? 'chat' : this.mode);
    this.input.focus();
  }

  async rename(conversation) {
    const value = await this.host.promptText('New name:', conversation.title, { title: 'Rename chat' });
    if (!value || !value.trim()) return;
    await (await this.host.ai()).conversations.rename(conversation.id, value.trim());
    if (this.conversationID === conversation.id) this.setHeaderTitle(value.trim());
    ChatView.refreshAll();
  }

  // ---- projects (spec 011 U5): labels for chats and reports; the switcher and each row's menu live in projects-menu.js

  /** The `conversations.create` option that puts a new chat in the open project. */
  projectOpt() {
    return this.projectId && this.canProject ? { project: this.projectId } : undefined;
  }

  /** The "..." on a history row; the same menu opens on right-click. @returns {HTMLElement[]} */
  moreButton(entry, row) {
    const more = this.el('button', 'sb-ai-conv-more');
    more.setAttribute('type', 'button');
    more.title = 'More';
    more.setAttribute('aria-label', 'More');
    more.append(this.icon('more'));
    more.addEventListener('click', (event) => { event.stopPropagation(); openRowMenu(this, entry, more); });
    return [more];
  }

  /** Opens a project (null: All chats) and remembers it. */
  setProject(id, { refresh = true } = {}) {
    this.projectId = id || null;
    this.host.prefs.set('chatProject', this.projectId ?? '');
    paintSwitcher(this, this.switcher);
    if (refresh) this.refreshList();
  }

  openProject(id) { this.setProject(id); }

  async createProject(name) {
    const project = await (await this.host.ai()).projects.create(name);
    this.projects = [...this.projects, project];
    return project;
  }

  async renameProject(id, name) {
    await (await this.host.ai()).projects.rename(id, name);
    ChatView.refreshAll();
  }

  async removeProject(id) {
    try { await (await this.host.ai()).projects.remove(id); } catch (error) { this.host.logError(error); this.host.notice(`Couldn't delete the project: ${error?.message ?? error}`); return; }
    if (this.projectId === id) this.setProject(null, { refresh: false });
    ChatView.refreshAll();
  }

  /** Moves a chat or report into a project; null takes it out of any. */
  async moveEntry(entry, projectId) {
    const target = entry.kind === 'chat' ? { kind: 'chat', id: entry.conversation.id } : { kind: 'review', id: entry.progress.id };
    try { await (await this.host.ai()).projects.assign(target, projectId); } catch (error) { this.host.logError(error); this.host.notice(`Couldn't move it: ${error?.message ?? error}`); return; }
    ChatView.refreshAll();
  }

  renameEntry(entry) { if (entry.kind === 'chat') this.rename(entry.conversation); }

  deleteEntry(entry) { if (entry.kind === 'chat') this.remove(entry.conversation); }

  async remove(conversation) {
    if (!(await this.host.confirm(`Delete "${conversation.title}"? This can't be undone.`, { title: conversation.search ? 'Delete search' : 'Delete chat' }))) return;
    await (await this.host.ai()).conversations.remove(conversation.id);
    if (conversation.search) await FindView.remove(this.host, conversation.search.id).catch((error) => this.host.logError(error));
    if (this.conversationID === conversation.id || (conversation.search && this.findID === conversation.search.id)) this.setMode('chat');
    ChatView.refreshAll();
  }

  async openConversation(id) {
    if (this.running) return;
    this.setMode('chat', { fresh: false });
    this.report?.stop();
    this.report = null;
    this.reviewID = null;
    this.findID = null;
    this.conversationID = id;
    this.resetArtifacts();
    this.sessionID = id;
    this.markSeen(id);
    this.setHeaderTitle(this.list.querySelector(`[data-id="${id}"] .sb-ai-conv-title`)?.textContent);
    this.markSelected();
    const ai = await this.host.ai();
    const records = await ai.conversations.load(id);
    // spec 007 E3: the results this session holds, and which answer made each (assistant.step -> step_end.writes)
    const view = await ai.sessions?.view(id).catch(() => null);
    this.artifacts = view?.results ?? [];
    this.sessionResults = this.artifacts;
    this.pickedRef = view?.current ?? null;
    this.showArtifactsButton();
    const summaries = new Map(records.filter((r) => r.type === 'result').map((r) => [`${r.summary.ref.id}@${r.summary.ref.version}`, r.summary]));
    const stepWrites = new Map(records.filter((r) => r.type === 'step_end').map((r) => [r.id, r.writes]));
    this.recordInfo = { records, summaries, stepWrites };
    this.columnTurns = new Set(records.filter((r) => r.columnChange).map((r) => r.at));
    const placed = new Set();
    let lastTurn = null;
    this.thread.replaceChildren();
    for (const record of records) {
      if (record.type === 'user') this.addUser(record.text, record.attachments, { on: record.on, skills: record.skills });
      else if (record.type === 'assistant') { lastTurn = this.paintRecordedAnswer(this.thread, record, placed); if (record.columnChange) this.addGapChip(lastTurn, record); }
      else if (record.type === 'failed') this.fail(this.addAnswer(), record.error);
    }
    // a version no answer wrote (a restore, a saved search's papers) sits under the last answer, or alone
    let home = lastTurn?.cards;
    for (const summary of this.artifacts) {
      if (placed.has(`${summary.ref.id}@${summary.ref.version}`)) continue;
      home ??= this.thread.appendChild(this.el('div', 'sb-art-cards'));
      this.addArtifactCard(home, summary);
    }
    this.scrollToEnd(true);
    this.renderAddStep();
  }

  /** Paints the turns a columns step wrote (the change asked, then how it went; spec 011 U2) that this thread has not
   *  shown yet. A reopened thread already paints them with the rest of its records. */
  async syncColumnTurns() {
    const id = this.sessionID;
    if (!id || this.running) return;
    try {
      const records = await (await this.host.ai()).conversations.load(id);
      const shown = (this.columnTurns ??= new Set());
      const fresh = records.filter((r) => r.columnChange && !shown.has(r.at));
      if (!fresh.length) return;
      this.recordInfo = {
        records,
        summaries: new Map(records.filter((r) => r.type === 'result').map((r) => [`${r.summary.ref.id}@${r.summary.ref.version}`, r.summary])),
        stepWrites: new Map(records.filter((r) => r.type === 'step_end').map((r) => [r.id, r.writes])),
      };
      for (const record of fresh) {
        shown.add(record.at);
        if (record.type === 'user') this.addUser(record.text, record.attachments);
        else if (record.type === 'assistant') this.addGapChip(this.paintRecordedAnswer(this.thread, record), record);
      }
      this.scrollToEnd(true);
      this.renderAddStep();
    } catch (error) { this.host.logError(error); }
  }

  /** Under the reply to a column change: when the newest version still has cells with no data, one chip that reads
   *  them again from a stronger text (spec 011 U2's gap fill). It sets nothing in the composer: a click runs it. */
  async addGapChip(turn, record) {
    const ref = (this.recordInfo?.stepWrites.get(record.step) ?? [])[0];
    if (!ref || !this.sessionID) return;
    try {
      const ai = await this.host.ai();
      if (!ai.sessions?.run) return;
      if (this.artifacts.find((a) => a.ref.id === ref.id)?.ref.version !== ref.version) return; // a newer version exists
      const result = await ai.sessions.read(this.sessionID, ref);
      if (!result || !hasGaps(result)) return;
      const chip = this.el('button', 'sb-ai-followup', 'Look again for the cells with no data');
      chip.setAttribute('type', 'button');
      chip.title = 'Read the papers more closely for the cells that came back with no data';
      chip.addEventListener('click', async () => {
        chip.disabled = true;
        try { await this.openArtifact(ref); await this.ensurePanel().fill([], 'gaps', 'best'); } catch (error) { this.host.logError(error); }
        chip.remove();
      });
      turn.root.append(chip);
    } catch (error) { this.host.logError(error); }
  }

  /** A stored answer as a turn in `container`: its cards, notice, folded activity and text. `placed` collects the
   *  result versions a card was drawn for. Used by a reopened thread and by the Chat with papers tab. */
  paintRecordedAnswer(container, record, placed = new Set()) {
    const { summaries, stepWrites } = this.recordInfo ?? { summaries: new Map(), stepWrites: new Map() };
    const turn = this.addAnswer(container);
    for (const ref of (record.step && stepWrites.get(record.step)) || []) {
      const summary = summaries.get(`${ref.id}@${ref.version}`);
      if (summary) { this.addArtifactCard(turn.cards, summary); placed.add(`${ref.id}@${ref.version}`); }
    }
    if (record.notice) turn.notice.textContent = record.notice;
    // spec 007 §3.1: a reopened chat folds exactly as it streamed. `lines` is what core.js stored when the
    // turn finished; a pre-E2 record has only `activities` and folds through linesFromLabels instead ("Used
    // N tools"), never one row per tool call again.
    const lines = record.lines ?? linesFromLabels(record.activities ?? []);
    this.paintActivityLines(turn, lines);
    this.finish(turn, record.answer.text, record.answer.citations);
    this.showPassages(turn, record.answer.passages);
    return turn;
  }

  // ------------------------------------------------------------------ research reports

  /** Shows a review in the thread (its question, then the ReportView) and follows it. */
  openReport(id, question) {
    if (this.running) return;
    this.setMode('report', { fresh: false });
    this.report?.stop();
    this.conversationID = null;
    this.findID = null;
    this.resetArtifacts();
    this.reviewID = id;
    this.setHeaderTitle(question || 'Research report');
    this.markSelected();
    this.thread.replaceChildren();
    if (question) this.addUser(question);
    this.follower.follow();
    this.report = new ReportView(this, id);
    this.report.root.append(this.el('div', 'sb-ai-text is-waiting', 'Loading…'));
    this.thread.append(this.report.root);
    this.report.watch();
  }

  // ------------------------------------------------------------------ paper searches

  async startFind(query) {
    this.input.value = '';
    this.fitInput();
    this.thread.querySelector('.sb-ai-empty')?.remove();
    this.follower.disable(); // a table of papers is read from the top
    this.addUser(query);
    const view = new FindView(this, { query, scope: this.scopeValue(), sources: { papers: this.sources.papers, scholarly: this.sources.scholarly } });
    this.findView = view;
    this.thread.append(view.root);
    this.findID = view.id;
    this.setHeaderTitle(query);
    await this.runInThread(async (signal) => {
      await view.run(signal);
      ChatView.refreshAll();
    });
  }

  async openFind(id) {
    if (this.running) return;
    let saved;
    try {
      saved = await FindView.load(this.host, id);
    } catch (error) {
      this.host.logError(error);
      return this.refreshList();
    }
    this.setMode('find', { fresh: false });
    this.report?.stop();
    this.report = null;
    this.conversationID = null;
    this.reviewID = null;
    this.findID = id;
    this.resetArtifacts();
    if (saved.session) this.useSession(saved.session);
    this.setHeaderTitle(saved.query);
    this.markSelected();
    this.thread.replaceChildren();
    this.addUser(saved.query);
    this.follower.disable();
    this.findView = new FindView(this, { saved });
    this.thread.append(this.findView.root);
    this.scroller.scrollTop = 0;
    this.renderAddStep();
  }

  /** Runs `work(signal)` as the thread's current job: Send turns into Stop until it ends. */
  async runInThread(work) {
    if (this.running) return;
    const controller = new this.win.AbortController();
    this.setRunning(controller);
    this.job = (async () => {
      try {
        await work(controller.signal);
      } catch (error) {
        this.host.logError(error);
      } finally {
        this.setRunning(null);
      }
    })();
    await this.job;
  }

  /** spec 007 E8: opens a systematic review's screened papers in the side panel while it waits on its unclear papers. It
   *  is a virtual result of the review itself (session id `review:<id>`), so it works for a review with no chat session. */
  async openScreening(review) {
    const panel = this.ensurePanel();
    if (!this.artifactOpen) this.threadScroll = this.scroller.scrollTop;
    this.artifactOpen = true;
    this.artifactPane.hidden = false;
    this.applyArtifactLayout();
    await panel.open(`review:${review}`, { id: 'screening' }, 1);
  }

  /** Called by the ReportView on each progress snapshot, so the history row's status stays current. A panel still showing
   *  this review's toggles is read again once the review is no longer waiting (the card answered it first). */
  onReviewProgress(progress) {
    if (progress?.status && progress.status.state !== 'awaiting_review' && this.panel?.state?.sessionId === `review:${progress.id}` && this.panel.gate()) this.panel.load();
    clearTimeout(this.listTimer);
    this.listTimer = setTimeout(() => this.refreshList(), 300);
  }

  async startReport(question) {
    const sources = Object.keys(this.sources).filter((id) => this.sources[id]);
    if (!sources.length) {
      this.thread.querySelector('.sb-ai-empty')?.remove();
      this.fail(this.addAnswer(), { message: 'Pick at least one place to search: Library, Scholarly or Web.' });
      return;
    }
    const request = {
      question, scope: this.scopeValue(), sources, depth: this.depth.value, pipeline: 2, ...(this.projectOpt() ?? {}), ...(this.mode === 'systematic' ? { systematic: true } : {}),
      years: { from: this.yearFrom.value ? Number(this.yearFrom.value) : null, to: this.yearTo.value ? Number(this.yearTo.value) : null },
      ...(this.skills.length ? { skills: this.skills.map((name) => ({ name })) } : {}),
    };
    this.input.value = '';
    this.fitInput();
    try {
      const id = await (await this.host.ai()).reviews.start(request);
      this.skills = [];
      this.renderChips();
      this.openReport(id, question);
      ChatView.refreshAll();
    } catch (error) {
      this.thread.querySelector('.sb-ai-empty')?.remove();
      this.fail(this.addAnswer(), { message: String(error?.message ?? error) });
    }
  }

  // ------------------------------------------------------------------ sending

  async submit() {
    const text = this.input.value.trim();
    if (!text || this.running || this.noSources || PICKER_MODES.includes(this.mode)) return;
    if (isReviewMode(this.mode)) return this.startReport(text);
    if (this.mode === 'find') return this.startFind(text);
    this.pendingAbout = null;
    const attachments = [...this.activeContext, ...this.attachments].map((a) => a.attachment);
    const { web, sources } = this.sendSources();
    const scope = this.scopeValue();
    const skills = this.mode === 'chat' ? [...this.skills] : [];
    this.input.value = '';
    this.fitInput();
    this.renderSend();
    this.attachments = [];
    this.skills = [];
    this.renderChips();
    this.thread.querySelector('.sb-ai-empty')?.remove();
    // The "On: <paper set> Vn" chip says the question is about that set, so it is asked as a Chat-with-papers turn on all
    // of it (the × on the chip is the way to ask without it). Other kinds of result stay context only.
    const current = this.mode === 'chat' ? this.currentSummary() : null;
    const on = current?.kind === 'papers' ? { result: { id: current.ref.id, version: current.ref.version }, rows: 'all' } : null;
    const user = this.addUser(text, attachments, on ? { skills, on } : { skills });
    const turn = this.addAnswer();
    turn.retry = { run: () => this.resendAfterSwitch(text, this.mode) };
    this.startLive(turn);
    this.reserveSpace(user, turn.root);
    this.follower.follow();
    const controller = new this.win.AbortController();
    this.setRunning(controller);
    try {
      const ai = await this.host.ai();
      if (this.mode === 'ask') {
        await this.stream(turn, ai.ask(text, { attachments, web, scope, sources, signal: controller.signal }), { streamText: false });
      } else {
        const fresh = !this.conversationID;
        this.conversationID ??= await ai.conversations.create('chat', this.projectOpt());
        this.sessionID = this.conversationID;
        if (fresh) {
          const title = text.replace(/\s+/g, ' ').slice(0, 60);
          await ai.conversations.rename(this.conversationID, title);
          this.setHeaderTitle(title);
        }
        // spec 007 §1.5/§3.2: read while streaming so a live "Read context · Referenced "title" Vn" line matches
        // what core.js will store; a session with no results yet (most chats) just gets an empty list.
        this.artifacts = await ai.sessions?.view(this.conversationID).then((v) => v.results, () => []) ?? [];
        this.sessionResults = this.artifacts;
        this.showArtifactsButton();
        await this.stream(turn, ai.conversations.send(this.conversationID, { text, attachments, web, scope, sources, ...(skills.length ? { skills } : {}), ...(on ? { on } : {}) }, { signal: controller.signal }), { streamText: true });
        ChatView.refreshAll();
      }
    } catch (error) {
      this.fail(turn, { kind: 'provider_crashed', message: String(error?.message ?? error) });
    } finally {
      this.endLive(turn, 'done');
      this.setRunning(null);
      if (turn.failKind === 'busy') {
        // The server was still answering an earlier question and took nothing: the question goes back in the box.
        user.remove();
        turn.root.remove();
        if (!this.input.value) this.input.value = text;
        this.fitInput();
        this.renderSend();
        this.host.notice(turn.failMessage);
      }
      this.input.focus();
    }
  }

  /** Asks `text` again once the user has moved to another AI. Whatever is typed in the box meanwhile stays there; if the
   *  user has since moved to another mode, the question goes back in the box instead. @param {string} text @param {string} mode */
  async resendAfterSwitch(text, mode) {
    const draft = this.input.value;
    this.input.value = text;
    if (this.mode !== mode || this.running) { this.fitInput(); this.renderSend(); return; }
    const sent = this.submit(); // clears the box before its first await
    this.input.value = draft;
    this.fitInput();
    this.renderSend();
    await sent;
  }

  /** `turn` is one turn, or several that show the same answer (the thread's and the Chat with papers tab's): every
   *  event goes to each, the first one is the primary (results and rate-limit notes are noted once). */
  async stream(turn, events, { streamText, onEvent }) {
    const turns = Array.isArray(turn) ? turn : [turn];
    for await (const event of events) {
      turns.forEach((t, i) => this.handleEvent(t, event, { streamText, primary: i === 0 }));
      onEvent?.(event);
    }
  }

  handleEvent(turn, event, { streamText, primary = true }) {
    if (event.type === 'text' && streamText) {
      turn.live.raw += event.delta;
      this.schedulePaint(turn);
      // Only the first delta of an answer run needs to reach compactActivities (it's just the flush boundary,
      // spec 007 §3.2 rule 1); pushing every streamed word would re-render the folded lines for nothing.
      if (!turn.textFlushed) {
        turn.events.push({ type: 'text', delta: event.delta });
        turn.textFlushed = true;
        this.renderActivities(turn);
      }
    } else if (event.type === 'activity' || event.type === 'reasoning' || event.type === 'line') {
      turn.events.push(event);
      turn.textFlushed = false;
      this.renderActivities(turn);
    } else if (event.type === 'notice' && event.kind === 'rate_limit') {
      if (!this.reportOptions.hidden) void this.refreshUsage();
      if (primary) this.where.textContent = `${this.where.textContent.split(' · ')[0]} · ${event.text}`;
    } else if (event.type === 'notice') {
      turn.notice.textContent = event.text;
    } else if (event.type === 'result') {
      // spec 007 §1.6: the answer made (or revised) a table; it arrives before `done`, and a card marks it in the thread
      if (primary) this.noteArtifact(event.summary);
      this.addArtifactCard(turn.cards, event.summary);
    } else if (event.type === 'done') {
      const structured = event.answer.structured;
      if (structured?.status === 'not_found') turn.root.classList.add('is-not-found');
      this.finish(turn, structured?.markdown ?? event.answer.text, event.answer.citations);
      this.showPassages(turn, event.answer.passages);
      if (event.notice) turn.notice.textContent = [turn.notice.textContent, event.notice].filter(Boolean).join(' ');
    } else if (event.type === 'failed') {
      this.fail(turn, event.error);
    }
  }

  // ------------------------------------------------------------------ the live turn (spec 008 S1-S5, A3)

  /** Gives a turn its live model and its "Worked for" line. Only the turn being answered has one; finished and
   *  reopened turns are never painted again.
   *  `live`: { raw: every text delta so far, painted: the visible text last put in the DOM, frame: the pending
   *  animation frame, startedAt/endedAt: ms, ticker: the 1 s interval, status, thinking: line id -> timing }. */
  startLive(turn) {
    const time = this.el('span', 'sb-ai-worked-time');
    const worked = this.el('div', 'sb-ai-worked');
    worked.append(spinner(this.doc), this.el('span', 'sb-ai-worked-label', 'Worked for'), ' ', time);
    turn.root.prepend(worked);
    turn.text.textContent = ''; // the "Worked for" line already says it's working
    turn.root.dataset.state = 'running';
    turn.live = { raw: '', painted: '', frame: null, startedAt: Date.now(), endedAt: null, ticker: null, status: 'running', time, thinking: new Map() };
    turn.live.ticker = this.win.setInterval(() => this.paintWorked(turn), 1000);
    this.paintWorked(turn);
  }

  paintWorked(turn) {
    const live = turn.live;
    if (!live.time) return; // a turn with no "Worked for" line (the Find papers summary)
    live.time.textContent = formatElapsed((live.endedAt ?? Date.now()) - live.startedAt);
  }

  /** At most one text paint per animation frame, with whatever text is newest by then. */
  schedulePaint(turn) {
    const live = turn.live;
    if (live.frame !== null) return;
    live.frame = this.win.requestAnimationFrame(() => { live.frame = null; this.paintText(turn); });
  }

  /** The whole visible text as Markdown, rendered the same way the final answer is; citations stay plain until
   *  `done` brings the checked list. */
  paintText(turn) {
    const live = turn.live;
    const shown = visibleText(live.raw);
    const making = hasTableBlock(live.raw); // the chat's table block is JSON, not for reading: say what's happening
    const key = `${shown}\u0000${making}`;
    if (key === live.painted) return;
    live.painted = key;
    const rendered = renderMarkdown(this.host, this.doc, shown, [], { pending: true });
    if (making) rendered.append(this.el('div', 'sb-ai-making', 'Making a table…'));
    if (live.mounted && turn.text.isConnected) reconcileChildren(turn.text, rendered);
    else {
      turn.text.replaceWith(rendered);
      turn.text = rendered;
      live.mounted = true;
    }
  }

  /** Freezes the clock and stops the motion; a no-op for a turn that isn't live (reopened, already ended). */
  endLive(turn, status) {
    const live = turn.live;
    if (!live || live.status !== 'running') return;
    if (live.frame !== null) this.win.cancelAnimationFrame(live.frame);
    live.frame = null;
    this.win.clearInterval(live.ticker);
    live.status = status;
    live.endedAt = Date.now();
    turn.root.dataset.state = status;
    this.paintWorked(turn);
    if (turn.events.length) this.renderActivities(turn);
  }

  /** The newest answer keeps at least a screen's height below its question, so the question sits at the top and
   *  the answer grows under it (spec 008 S3). */
  reserveSpace(user, answer) {
    if (this.reserved) this.reserved.style.minHeight = '';
    const style = this.win.getComputedStyle(this.thread);
    const room = this.scroller.clientHeight - user.offsetHeight - (parseFloat(style.rowGap) || 0)
      - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
    answer.style.minHeight = `${Math.max(0, room)}px`;
    this.reserved = answer;
  }

  // ------------------------------------------------------------------ the thread

  /** The mode's icon and name at the top; its suggestions sit at the bottom, just above the message box. All
   *  four source pills off replaces the mode's usual text with why nothing will happen yet (spec 005 §5). */
  showEmpty() {
    const mode = this.modeInfo;
    const empty = this.el('div', 'sb-ai-empty');
    empty.append(this.icon(modeIconName(mode.id), 'sb-ai-icon sb-ai-empty-icon'), this.el('div', 'sb-ai-empty-title', mode.label),
      this.el('div', 'sb-ai-empty-text', this.noSources ? 'Turn on at least one source.' : modeEmpty(this.host, mode.empty)), this.el('div', 'sb-ai-suggestions'));
    this.thread.replaceChildren(empty);
    this.follower.follow();
    this.renderSuggestions();
  }

  /** @param {string} text @param {any[]} [attachments] @param {{ into?: HTMLElement, on?: { result: any, rows: any } | null }} [opts]
   *  `into`: a container other than the thread (the Chat with papers tab); `on`: what the question was about (spec 007 §6). */
  addUser(text, attachments = [], opts = {}) {
    this.thread.querySelector('.sb-addstep')?.remove();
    const box = this.el('div', 'sb-ai-user has-avatar');
    // who said it: a person here, the AI mark on answers, so the two read apart at a glance
    const who = personAvatar(this.doc, { size: 20, label: 'You' });
    who.classList.add('sb-ai-avatar');
    box.append(who, this.el('div', 'sb-ai-user-text', text));
    if (opts.on) {
      const total = this.artifacts.find((a) => a.ref.id === opts.on.result?.id)?.rows ?? null;
      const said = describeOn(opts.on, total);
      if (said) box.append(this.el('div', 'sb-ai-user-on', said));
    }
    if (opts.skills?.length) box.append(this.el('div', 'sb-ai-user-on sb-ai-user-skills', usedLine(opts.skills)));
    if (attachments.length) {
      const chips = this.el('div', 'sb-ai-chips');
      for (const a of attachments) {
        const chip = this.el('span', 'sb-ai-chip', a.kind === 'quote' ? `“${quoteLabel(a.text)}”` : a.name ?? a.path ?? '');
        if (a.kind === 'zoteroItem') this.paperLabel(chip, a.citekey);
        chips.append(chip);
      }
      box.append(chips);
    }
    if (!opts.into) box.append(this.messageActions([
      ['Copy', 'Copy this message', (button) => this.copyText(text, button)],
      ['Edit', 'Put this message back in the box to change and resend', () => this.editPrompt(text)],
    ]));
    (opts.into ?? this.thread).append(box);
    return box;
  }

  /** A small row of text buttons under a message; it shows on hover or keyboard focus. @param {[string, string, (button: HTMLElement) => void][]} actions */
  messageActions(actions) {
    const row = this.el('div', 'sb-ai-msg-actions');
    for (const [label, title, run] of actions) {
      const button = this.el('button', 'sb-ai-msg-action', label);
      button.setAttribute('type', 'button');
      button.title = title;
      button.addEventListener('click', (event) => { event.stopPropagation(); run(button); });
      row.append(button);
    }
    return row;
  }

  /** Copies `text` to the clipboard and says so on the button for a moment. */
  async copyText(text, button) {
    let ok = false;
    try { await this.win.navigator.clipboard.writeText(text); ok = true; } catch { /* falls through to the textarea route */ }
    if (!ok) {
      const area = this.doc.createElementNS('http://www.w3.org/1999/xhtml', 'textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      (this.doc.body ?? this.doc.documentElement).append(area);
      area.select();
      try { ok = this.doc.execCommand('copy'); } catch { ok = false; }
      area.remove();
    }
    if (!button) return ok;
    const was = button.dataset.label ?? button.textContent;
    button.dataset.label = was;
    button.textContent = ok ? 'Copied' : "Couldn't copy";
    this.win.setTimeout(() => { button.textContent = was; }, 1400);
    return ok;
  }

  /** Edit: the message goes back in the box (the conversation isn't rewritten; sending it again asks a new question). */
  editPrompt(text) {
    if (this.running) { this.host.notice('Wait for the answer to finish, or press Stop, before editing.'); return; }
    this.input.value = text;
    this.input.dispatchEvent(new this.win.Event('input', { bubbles: true }));
    this.input.focus();
    this.input.setSelectionRange(text.length, text.length);
  }

  addAnswer(into = this.thread) {
    const root = this.el('div', 'sb-ai-answer has-avatar');
    const who = aiAvatar(this.doc, { size: 20, label: 'Veritas AI' });
    who.classList.add('sb-ai-avatar');
    root.append(who);
    const activities = this.el('div', 'sb-ai-activities');
    const text = this.el('div', 'sb-ai-text is-waiting', 'Thinking…');
    const notice = this.el('div', 'sb-ai-notice');
    const cards = this.el('div', 'sb-art-cards'); // spec 007 E3: result cards under the answer
    root.append(activities, text, notice, cards);
    into.append(root);
    // `events` is the raw AgentEvent stream for this turn (spec 007 §3.2), folded through the same
    // compactActivities agent-src exports, so live and reopened chats fold identically. `expanded` remembers
    // which folded line ids the user opened, across re-renders as more events arrive.
    return { root, activities, text, notice, cards, events: [], expanded: new Set(), textFlushed: false };
  }

  /** Re-folds `turn.events` into ActivityLine[] (spec 007 §3.2) and repaints. Called on every activity/reasoning/
   *  line event and once when the first answer-text delta flushes the group in progress. */
  renderActivities(turn) {
    const resolveResult = (id, version) => {
      const results = this.sessionResults ?? [];
      const exact = results.find((r) => r.ref.id === id && (version == null || r.ref.version === version));
      const match = exact ?? results.find((r) => r.ref.id === id);
      return match ? { title: match.title, version: version ?? match.ref.version } : null;
    };
    const lines = compactActivities(turn.events, { resolveResult });
    const live = turn.live;
    if (live) {
      // A reasoning-only line reads "Thinking" while reasoning is still arriving, then "Thought for Ns".
      const reasoningNow = live.status === 'running' && turn.events[turn.events.length - 1]?.type === 'reasoning';
      lines.forEach((line, i) => {
        if (line.icon !== 'thinking') return;
        if (!live.thinking.has(line.id)) live.thinking.set(line.id, { startedAt: Date.now(), endedAt: null });
        const timing = live.thinking.get(line.id);
        if (reasoningNow && i === lines.length - 1) lines[i] = { ...line, title: 'Thinking', state: 'running' };
        else {
          timing.endedAt ??= Date.now();
          lines[i] = { ...line, title: `Thought for ${formatElapsed(timing.endedAt - timing.startedAt)}` };
        }
      });
    }
    this.paintActivityLines(turn, lines);
  }

  /** Renders a fixed ActivityLine[] (from `record.lines`/`linesFromLabels` on a reopened chat, or live from
   *  renderActivities). One line per group of steps. While the turn runs its newest line is open and shows the
   *  steps as they happen (a list with an icon, a label, a small detail and a status mark per step); when the turn
   *  ends it folds into its one summary line, and the chevron reopens the list. A block the user opened or closed
   *  by hand stays that way (`turn.expanded` / `turn.closed`). */
  paintActivityLines(turn, lines) {
    const ended = turn.live && turn.live.status !== 'running'; // a stopped turn leaves no line shimmering
    const running = Boolean(turn.live) && !ended;
    turn.closed ??= new Set();
    turn.seenSteps ??= new Set();
    // Repainting rebuilds the rows, so keep where the user had scrolled the newest feed.
    const oldFeed = turn.activities.querySelector('.sb-ai-feed');
    const wasAtEnd = !oldFeed || oldFeed.scrollTop + oldFeed.clientHeight >= oldFeed.scrollHeight - 4;
    const oldTop = oldFeed?.scrollTop ?? 0;
    turn.activities.replaceChildren();
    lines.forEach((line, i) => {
      const live = running && i === lines.length - 1;
      const entries = line.entries?.length ? line.entries : entriesFromLabels(line.items ?? [], line.id);
      const shimmer = line.state === 'running' && !ended;
      const expandable = Boolean(line.reasoning) || entries.length > 0;
      const isOpen = () => expandable && !turn.closed.has(line.id) && (turn.expanded.has(line.id) || live);
      const row = this.el('div', `sb-ai-activity${shimmer ? ' is-running' : ''}${live ? ' is-live' : ''}${isOpen() ? ' is-expanded' : ''}`);
      const head = this.el('div', 'sb-ai-activity-head');
      // A step still "running" when its turn has ended was cut off (stopped, failed, over its limit): say so, never leave a
      // stale "Searching…" that looks alive.
      const cutOff = line.state === 'running' && ended;
      const label = this.el('span', 'sb-ai-activity-label', cutOff ? `${line.title} · Stopped before it finished` : line.detail ? `${line.title} · ${line.detail}` : line.title);
      head.append(this.icon(ACTIVITY_ICON[line.icon] ?? 'status', 'sb-ai-icon sb-ai-activity-icon'), label);
      if (expandable) {
        head.append(this.el('span', 'sb-ai-activity-chevron', '›'));
        head.setAttribute('role', 'button');
        head.setAttribute('tabindex', '0');
        head.setAttribute('aria-expanded', String(isOpen()));
        const toggle = () => {
          if (isOpen()) { turn.expanded.delete(line.id); turn.closed.add(line.id); }
          else { turn.closed.delete(line.id); turn.expanded.add(line.id); }
          row.classList.toggle('is-expanded', isOpen());
          head.setAttribute('aria-expanded', String(isOpen()));
        };
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
      }
      row.append(head);
      if (expandable) {
        const body = this.el('div', 'sb-ai-activity-body');
        if (line.reasoning) {
          const thinking = this.el('div', `sb-ai-activity-reasoning${live && shimmer ? ' is-live' : ''}`);
          thinking.append(this.el('span', 'sb-ai-reasoning-caption', live && shimmer ? 'Thinking' : 'Thought'), this.el('span', 'sb-ai-reasoning-text', line.reasoning));
          body.append(thinking);
        }
        if (entries.length) {
          const feed = this.el('div', 'sb-ai-feed');
          for (const entry of entries) feed.append(this.stepRow(turn, line, entry, ended));
          body.append(feed);
        }
        row.append(body);
      }
      turn.activities.append(row);
    });
    const feed = turn.activities.querySelector('.is-live .sb-ai-feed');
    if (feed) feed.scrollTop = wasAtEnd ? feed.scrollHeight : oldTop;
    const thinking = turn.activities.querySelector('.sb-ai-activity-reasoning.is-live');
    if (thinking) thinking.scrollTop = thinking.scrollHeight;
  }

  /** One step of the list. Present tense with the shimmer while it runs, past tense once it is done. */
  stepRow(turn, line, entry, ended) {
    const state = entry.state === 'running' && ended ? 'stopped' : entry.state;
    const key = `${line.id}/${entry.id}`;
    const fresh = Boolean(turn.live) && !turn.seenSteps.has(key);
    turn.seenSteps.add(key);
    const row = this.el('div', `sb-ai-step is-${state}${fresh ? ' is-new' : ''}`);
    let text = entry.state === 'running' ? entry.label : pastTense(entry.label);
    let detail = entry.detail ?? '';
    if (entry.source?.kind === 'web' && entry.state === 'done') {
      const host = entry.source.host ?? '';
      text = `Read ${entry.source.title || host}`;
      detail = entry.source.title && host && entry.source.title !== host ? host : detail;
    } else if (entry.source && entry.state === 'done') {
      text = `Read “${entry.source.title}”`;
    }
    if (entry.state === 'running') text = /[.…!?]$/.test(text) ? text : `${text}…`;
    const label = this.el('span', 'sb-ai-step-label', text);
    label.title = text;
    row.append(this.icon(stepIcon(entry), 'sb-ai-icon sb-ai-step-icon'), label);
    if (detail) row.append(this.el('span', 'sb-ai-step-detail', detail));
    const mark = this.el('span', 'sb-ai-step-mark');
    if (state === 'done') mark.append(this.icon('check', 'sb-ai-icon sb-ai-step-check'));
    else if (state === 'failed') { mark.append(this.icon('close', 'sb-ai-icon sb-ai-step-x')); mark.title = "This step didn't work"; }
    row.append(mark);
    return row;
  }

  finish(turn, markdown, citations = []) {
    this.endLive(turn, 'done');
    const rendered = renderMarkdown(this.host, this.doc, visibleText(markdown || ''), citations);
    turn.text.replaceWith(rendered);
    turn.text = rendered;
    if (turn.root.classList.contains('is-not-found')) turn.root.prepend(this.el('div', 'sb-ai-badge', 'Not in your library'));
    turn.root.querySelector('.sb-ai-msg-actions')?.remove();
    if (markdown) turn.root.append(this.messageActions([['Copy', 'Copy this answer as text', (button) => this.copyText(visibleText(markdown), button)]]));
    const unknown = citations.filter((c) => c.status === 'unknown').length;
    if (unknown) turn.notice.textContent = unknown === 1 ? "One citation couldn't be found in your library; it's marked in red."
      : `${unknown} citations couldn't be found in your library; they're marked in red.`;
  }

  /** spec 010: a local answer shows the passages it was given, folded under it ("Passages used (5)"). */
  showPassages(turn, passages) {
    turn.root.querySelector('.sb-ai-passages')?.remove();
    if (!passages?.length) return;
    const box = this.el('details', 'sb-ai-passages');
    box.append(this.el('summary', 'sb-ai-passages-head', `Passages used (${passages.length})`));
    const list = this.el('ol', 'sb-ai-passages-list');
    for (const p of passages) {
      const ref = p.ref.kind === 'paper' ? `@${p.ref.citekey}` : p.ref.kind === 'note' ? p.ref.path : p.ref.url;
      const item = this.el('li', 'sb-ai-passage');
      item.append(this.el('div', 'sb-ai-passage-title', p.title), this.el('div', 'sb-ai-passage-ref', ref), this.el('div', 'sb-ai-passage-text', p.snippet));
      list.append(item);
    }
    box.append(list);
    turn.cards.before(box);
  }

  fail(turn, error) {
    turn.failKind = error.kind;
    turn.failMessage = error.message;
    if (turn.live?.status === 'running' && error.kind === 'cancelled') this.paintText(turn); // keep what arrived
    this.endLive(turn, error.kind === 'cancelled' ? 'stopped' : 'failed');
    if (error.kind === 'cancelled') {
      if (turn.text.classList.contains('is-waiting')) turn.text.remove();
      turn.notice.textContent = 'Stopped.';
      return;
    }
    const box = this.el('div', 'sb-ai-error', error.message || 'Something went wrong.');
    turn.text.replaceWith(box);
    turn.text = box;
    // The chosen AI is not installed: offer the ones that are ready. Only a turn asked just now knows its question (`retry`).
    if (error.kind === NOT_INSTALLED && turn.retry) void offerSwitch(this, box, turn.retry.run);
  }

  /** `force` jumps to the end and follows from there; otherwise pins only if the thread is following. */
  scrollToEnd(force = false) {
    if (force) this.follower.follow();
    else if (this.follower.enabled && this.follower.following) this.follower.pin();
  }

  // ------------------------------------------------------------------ artifacts (spec 007 E3)

  /** A new thread, a reopened one or another kind of item: nothing of the old session's results stays on screen. */
  resetArtifacts() {
    this.closeArtifact();
    this.recordInfo = null;
    this.panel?.resetChat();
    this.sessionID = null;
    this.artifacts = [];
    this.sessionResults = this.artifacts;
    this.cards = [];
    this.pickedRef = null;
    this.currentCleared = false;
    this.pendingAbout = null;
    this.showArtifactsButton();
  }

  /** Points the header list and the panel at a stored session (a saved Find papers search remembers its own). */
  useSession(id) {
    this.sessionID = id;
    return this.refreshArtifacts();
  }

  async refreshArtifacts() {
    const id = this.sessionID;
    if (!id) return;
    try {
      const view = await (await this.host.ai()).sessions?.view(id);
      if (this.sessionID !== id || !view) return;
      this.artifacts = view.results;
      this.sessionResults = this.artifacts;
      this.pickedRef = view.current ?? null;
      this.showArtifactsButton();
      this.renderAddStep();
    } catch (error) {
      this.host.logError(error);
    }
  }

  /** "Artifacts (N)" in the header, only once the session has a result. */
  showArtifactsButton() {
    const n = this.artifacts.length;
    this.artifactsButton.hidden = n === 0;
    this.artifactsButton.textContent = `Artifacts (${n})`;
    this.artifactsButton.title = 'The tables and paper sets in this chat';
    this.renderCurrent();
    this.renderAddStep();
  }

  /** A result was written (or a new version of one): remember it, say so on older cards, follow it in the panel.
   *  @param {import("../../../agent/src/domain").ResultSummary} summary @param {{ skipPanel?: boolean }} [opts] */
  noteArtifact(summary, opts = {}) {
    const at = this.artifacts.findIndex((a) => a.ref.id === summary.ref.id);
    if (at >= 0) this.artifacts[at] = summary; else { this.artifacts.push(summary); this.pickedRef = null; }
    this.currentCleared = false;
    this.showArtifactsButton();
    this.syncCards();
    if (this.artifactOpen && !opts.skipPanel) this.panel?.refresh(summary);
  }

  /** A card under an answer. Only tables and paper sets get the download icon, and only where the host can save. */
  addArtifactCard(container, summary) {
    const downloadable = (summary.kind === 'papers' || summary.kind === 'table') && canSave(this.host, this.doc, 'csv');
    const card = new ArtifactCard(this.doc, summary, {
      onOpen: (ref) => this.openArtifact(ref),
      onDownload: downloadable ? (ref) => this.downloadArtifact(ref) : undefined,
    });
    this.cards.push(card);
    container.append(card.root);
    this.syncCards();
    return card;
  }

  /** Every card knows whether a newer version of its result exists ("V1 · a newer version exists"). */
  syncCards() {
    for (const card of this.cards) {
      const latest = this.artifacts.find((a) => a.ref.id === card.summary.ref.id)?.ref.version ?? card.summary.ref.version;
      card.setLatest(latest);
    }
  }

  async downloadArtifact(ref) {
    try {
      const result = await (await this.host.ai()).sessions.read(this.sessionID, { id: ref.id, version: ref.version });
      if (result) await downloadResult(this.host, this.doc, result, 'csv');
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't save that file.");
    }
  }

  /** The "Artifacts (N)" list: every result in the session, newest first. */
  openArtifactList() {
    openPopover(this.doc, this.head, this.artifactsButton, (pop, close) => {
      const newest = [...this.artifacts].sort((a, b) => (a.updated < b.updated ? 1 : -1));
      for (const a of newest) {
        pop.append(menuItem(this.doc, { icon: KIND_ICON[a.kind], label: a.title, hint: `${KIND_NAME[a.kind] ?? 'Result'} · V${a.ref.version}`, onClick: () => this.openArtifact(a.ref) }, close));
      }
    }, { className: 'sb-art-listmenu' });
  }

  ensurePanel() {
    if (this.panel) return this.panel;
    this.panel = new ArtifactPanel(this, {
      onClose: () => this.closeArtifact(),
      onExpand: () => { this.artifactExpanded = !this.artifactExpanded; this.applyArtifactLayout(); },
      onChanged: (summary) => { this.noteArtifact(summary, { skipPanel: true }); this.syncColumnTurns(); },
      chat: this,
      onNew: (summary) => { this.noteArtifact(summary, { skipPanel: true }); this.openArtifact(summary.ref); },
      onUse: (ref) => this.useResult(ref),
      onRoutine: (result) => this.openRoutines(result),
    });
    this.artifactPane.append(this.buildArtifactHandle(), this.panel.root);
    return this.panel;
  }

  /** @param {{ id: string, version?: number }} ref the version to show (a card for an older one opens that one) */
  async openArtifact(ref) {
    if (!this.sessionID) return;
    const panel = this.ensurePanel();
    if (!this.artifactOpen) this.threadScroll = this.scroller.scrollTop;
    this.artifactOpen = true;
    this.artifactPane.hidden = false;
    this.applyArtifactLayout();
    const latest = this.artifacts.find((a) => a.ref.id === ref.id)?.ref.version;
    await panel.open(this.sessionID, { id: ref.id, version: ref.version === latest ? undefined : ref.version }, latest ?? ref.version);
  }

  closeArtifact() {
    if (!this.artifactOpen) return;
    this.artifactOpen = false;
    this.artifactExpanded = false;
    this.artifactPane.hidden = true;
    this.applyArtifactLayout();
    if (this.threadScroll != null) this.scroller.scrollTop = this.threadScroll; // the thread was hidden, not rebuilt
  }

  /** spec 007 §4 "Widths": side by side from 960 px, over the thread from 560, full view below. */
  artifactMode() {
    const width = this.root.clientWidth;
    return width >= 960 ? 'side' : width >= 560 ? 'cover' : 'full';
  }

  applyArtifactLayout() {
    const mode = this.artifactMode();
    const open = this.artifactOpen;
    const expanded = open && mode === 'side' && this.artifactExpanded;
    this.root.classList.toggle('has-artifact', open);
    for (const m of ['side', 'cover', 'full']) this.root.classList.toggle(`is-art-${m}`, open && mode === m);
    this.root.classList.toggle('is-art-expanded', expanded);
    this.panel?.setLayout(mode, expanded);
    if (open && mode === 'side' && !expanded) this.artifactPane.style.width = `${this.clampArtifactWidth(this.host.prefs.get('artifactWidth'))}px`;
    else this.artifactPane.style.width = '';
  }

  /** The panel starts at half the room beside the history list, and neither it nor the thread goes under 360 px. */
  clampArtifactWidth(wanted) {
    const room = this.root.clientWidth - (this.side.hidden ? 0 : this.side.offsetWidth);
    const width = typeof wanted === 'number' ? wanted : room / 2;
    return Math.round(Math.min(Math.max(360, width), Math.max(360, room - 360)));
  }

  /** The drag handle on the panel's left edge (arrow keys move it too). */
  buildArtifactHandle() {
    const handle = this.el('div', 'sb-ai-artifact-handle');
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Resize the panel');
    handle.setAttribute('tabindex', '0');
    const set = (width) => {
      const clamped = this.clampArtifactWidth(width);
      this.artifactPane.style.width = `${clamped}px`;
      this.host.prefs.set('artifactWidth', clamped);
    };
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('is-dragging');
      const move = (e) => set(this.root.getBoundingClientRect().right - e.clientX);
      const stop = () => {
        handle.classList.remove('is-dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop);
      handle.addEventListener('pointercancel', stop);
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      set(this.artifactPane.offsetWidth + (event.key === 'ArrowLeft' ? 24 : -24));
    });
    return handle;
  }

  /** Called by a Find papers view once its rows are stored as a result. */
  setFindSession(view, sessionId, summary) {
    if (this.findID !== view.id) return;
    this.sessionID = sessionId;
    this.noteArtifact(summary);
  }

  // ------------------------------------------------------------------ chat with papers (spec 007 §6, E5)

  /** The stored turns about one result, for the tab's history: `[{ user, reply }]` from the records this thread was
   *  opened from. */
  storedTurnsOn(resultId) {
    return turnsOn(this.recordInfo?.records ?? [], resultId);
  }

  /** Asks a question about a paper set. It is an ordinary chat turn in the same session: it streams into the thread
   *  and, at the same time, into the Chat with papers tab (`tab.container`, a view of the turns about this result).
   *  @param {string} text @param {{ result: { id: string, version: number }, rows: string[] | "all" }} on
   *  @param {{ container: HTMLElement, follow?: () => void, done?: (turn: any, failed: boolean) => void }} tab */
  async askPapers(text, on, tab) {
    if (this.running || !this.sessionID) return;
    const id = this.sessionID;
    this.thread.querySelector('.sb-ai-empty')?.remove();
    const mainUser = this.addUser(text, [], { on });
    const main = this.addAnswer();
    const tabUser = this.addUser(text, [], { on, into: tab.container });
    const mine = this.addAnswer(tab.container);
    let asked = false; // both copies of the error offer the switch; the question goes out once
    main.retry = mine.retry = { run: () => { if (asked) return; asked = true; return this.askPapers(text, on, tab); } };
    tab.follow?.();
    this.startLive(main);
    this.startLive(mine);
    this.reserveSpace(mainUser, main.root);
    this.follower.follow();
    const controller = new this.win.AbortController();
    this.setRunning(controller);
    let failed = false;
    try {
      const ai = await this.host.ai();
      const { web, sources } = this.sendSources();
      await this.stream([main, mine], ai.conversations.send(id, { text, on, web, sources }, { signal: controller.signal }), {
        streamText: true, onEvent: (event) => { if (event.type === 'failed') failed = true; tab.follow?.(); },
      });
      ChatView.refreshAll();
    } catch (error) {
      failed = true;
      for (const t of [main, mine]) this.fail(t, { kind: 'provider_crashed', message: String(error?.message ?? error) });
    } finally {
      this.endLive(main, 'done');
      this.endLive(mine, 'done');
      this.setRunning(null);
      tab.done?.(mine, failed);
    }
  }

  // ------------------------------------------------------------------ current result, "+ Add step", the picker (spec 007 §7, E6)

  /** The result the next step works on, or null (none yet, or the user cleared it). */
  currentSummary() {
    return currentResult(this.artifacts, this.pickedRef, this.currentCleared);
  }

  /** "On: <title> V2 ×" in the composer, only while the session has results; × starts the next step fresh. */
  renderCurrent() {
    const summary = this.currentSummary();
    const show = Boolean(summary) && !isReviewMode(this.mode) && this.mode !== 'find';
    this.currentChip.hidden = !show;
    this.currentChip.replaceChildren();
    if (!show || !summary) return;
    const chip = this.el('span', 'sb-ai-chip sb-ai-on');
    const scoped = summary.kind === 'papers' && this.mode === 'chat';
    const label = this.el('span', 'sb-ai-chip-label', onLabel(summary));
    label.title = scoped ? `${onLabel(summary)}. Questions are answered from this set only` : onLabel(summary);
    const remove = this.el('button', 'sb-ai-chip-x', '×');
    remove.title = scoped ? 'Ask your whole library instead' : 'Start the next step fresh, not on this result';
    remove.setAttribute('aria-label', scoped ? 'Ask your whole library instead' : 'Start the next step fresh');
    remove.addEventListener('click', () => { this.currentCleared = true; this.pendingAbout = null; this.renderCurrent(); this.renderAddStep(); this.renderChips(); });
    chip.append(this.icon(KIND_ICON[summary.kind] ?? 'table'), label, remove);
    this.currentChip.append(chip);
  }

  /** "Use for next step" on an artifact: it becomes the current result (a `current` record). */
  async useResult(ref) {
    const summary = this.artifacts.find((a) => a.ref.id === ref.id);
    if (!summary || !this.sessionID) return;
    this.pickedRef = { id: ref.id, version: ref.version };
    this.currentCleared = false;
    this.renderCurrent();
    this.renderAddStep();
    try {
      await (await this.host.ai()).sessions.setCurrent(this.sessionID, ref);
    } catch (error) {
      this.host.logError(error);
    }
  }

  /** A saved Find search with no session yet counts as a paper set (it is imported when a step is picked). */
  addStepKind() {
    const summary = this.currentSummary();
    if (summary) return summary.kind;
    return !this.sessionID && this.findView?.rows?.length ? 'papers' : null;
  }

  /** The quiet "+ Add step" after the last thing in the thread; its menu lists only steps that fit the result. */
  renderAddStep() {
    this.thread?.querySelector('.sb-addstep')?.remove();
    if (this.running || this.picking || !this.thread) return;
    if (this.thread.querySelector('.sb-ai-empty')) return;
    const kind = this.addStepKind();
    const choices = stepChoices(kind, { columns: Boolean(this.engineCanFill), report: Boolean(this.engineCanReport) });
    if (!choices.length) return;
    const wrap = this.el('div', 'sb-addstep');
    const btn = this.el('button', 'sb-addstep-btn');
    btn.setAttribute('type', 'button');
    btn.append(this.icon('plus'), this.el('span', '', 'Add step'));
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      openPopover(this.doc, wrap, btn, (pop, close) => {
        for (const choice of stepChoices(this.addStepKind(), { columns: Boolean(this.engineCanFill), report: Boolean(this.engineCanReport) })) {
          pop.append(menuItem(this.doc, { icon: choice.icon, label: choice.label, onClick: () => this.takeStep(choice.id) }, close));
        }
      }, { className: 'sb-addstep-menu' });
    });
    wrap.append(btn);
    this.thread.append(wrap);
  }

  /** Picking a step sets the composer's mode and/or opens the panel's tab or popover. */
  async takeStep(step) {
    if (this.running) return;
    if (!this.sessionID && this.findView && !(await this.importFind())) return;
    const summary = this.currentSummary();
    if (!summary) return;
    if (step === 'report') { await this.reportFrom(summary); return; }
    if (step === 'chat' && summary.kind !== 'papers') {
      await this.useResult(summary.ref);
      this.pendingAbout = summary.kind === 'table' ? 'Ask about this table…' : 'Ask about this report…';
      if (this.mode !== 'chat') this.setMode('chat', { fresh: false });
      this.renderChips();
      this.input.focus();
      return;
    }
    await this.openArtifact(summary.ref);
    this.panel?.startStep(step);
  }

  /** "Report on these" / "Write a report from this" (spec 007 §2.1): a Research report started from a result of this
   *  session. A paper set skips the search but still asks and plans; a table goes straight to writing. The finished
   *  review adds its report and papers to this session. @param {import("../host").ResultSummary} summary */
  async reportFrom(summary) {
    const fromTable = summary.kind === 'table';
    const typed = this.input.value.trim();
    const question = typed || summary.title;
    const sources = Object.keys(this.sources).filter((id) => this.sources[id]);
    const request = {
      question, scope: this.scopeValue(), sources: sources.length ? sources : ['papers'], depth: this.depth.value, pipeline: 2,
      years: { from: this.yearFrom.value ? Number(this.yearFrom.value) : null, to: this.yearTo.value ? Number(this.yearTo.value) : null },
      session: this.sessionID, on: summary.ref, ...(this.projectOpt() ?? {}), ...(fromTable ? { fromTable: true, autoApprove: true } : {}),
    };
    try {
      const id = await (await this.host.ai()).reviews.start(request);
      this.input.value = '';
      this.fitInput();
      this.openReport(id, question);
      ChatView.refreshAll();
    } catch (error) {
      this.host.logError(error);
      this.host.notice(`Couldn't start the report: ${error?.message ?? error}`);
    }
  }

  /** An old saved Find search (no session in its JSON) becomes a session on the first step: an `import` step
   *  `from: "find:<id>"` with its rows, and the saved search remembers the session, so the history lists it once. */
  async importFind() {
    const view = this.findView;
    if (!view || !view.rows.length) return false;
    try {
      const ai = await this.host.ai();
      if (!ai.sessions?.put) return false;
      const id = await ai.conversations.create('chat', this.projectOpt());
      await ai.conversations.rename(id, view.query.replace(/\s+/g, ' ').slice(0, 200)); // the history row ellipsizes; the full query stays the title, as the saved search's row showed it
      const summary = await ai.sessions.put(id, { kind: 'import', from: `find:${view.id}`, label: view.query }, { ...view.papersResult(), change: 'Imported from a saved search' });
      view.session = id;
      await view.save();
      this.sessionID = id;
      this.noteArtifact(summary, { skipPanel: true });
      ChatView.refreshAll();
      return true;
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't open that search as a session.");
      return false;
    }
  }

  /** The paper set a paper tool would open: the current result when it is one, else the newest paper set. */
  papersInSession() {
    const current = this.currentSummary();
    if (current?.kind === 'papers') return current;
    return [...this.artifacts].filter((a) => a.kind === 'papers').sort((a, b) => (a.updated < b.updated ? 1 : -1))[0] ?? null;
  }

  /** Chat with papers / Extract data: straight to the session's paper set when it has one, else a picker first. */
  async startPaperTool(kind) {
    const open = (ref) => this.openPaperTool(kind, ref);
    const set = this.papersInSession();
    if (set) { this.modePick.value = this.mode; return open(set.ref); }
    if (!this.sessionID && this.findView && this.findView.rows.length && this.mode === 'find') {
      this.modePick.value = this.mode;
      if (await this.importFind()) return open(this.papersInSession()?.ref);
      return;
    }
    const keep = Boolean(this.sessionID && this.artifacts.length);
    this.setMode(kind, { fresh: false });
    if (!keep) {
      this.report?.stop();
      this.report = null;
      this.conversationID = null;
      this.reviewID = null;
      this.findID = null;
      this.findView = null;
      this.resetArtifacts();
      this.setHeaderTitle('New chat');
      this.markSelected();
      this.thread.replaceChildren();
    }
    this.picking = kind;
    this.renderCurrent();
    this.showPicker(kind);
  }

  async openPaperTool(kind, ref) {
    if (!ref) return;
    await this.openArtifact(ref);
    this.panel?.startStep(kind === 'papers' ? 'chat' : 'columns');
  }

  /** The picker: "Selected papers", a collection or a tag (where the host has scopes), or a saved Find search. */
  showPicker(kind) {
    this.thread.querySelector('.sb-ai-pick')?.remove();
    const mode = ChatView.MODES.find((m) => m.id === kind);
    const box = this.el('div', 'sb-ai-empty sb-ai-pick');
    const list = this.el('div', 'sb-ai-pick-list');
    const note = this.el('div', 'sb-ai-pick-note');
    const detail = this.el('div', 'sb-ai-pick-detail');
    box.append(this.icon(modeIconName(kind), 'sb-ai-icon sb-ai-empty-icon'), this.el('div', 'sb-ai-empty-title', mode.label),
      this.el('div', 'sb-ai-empty-text', mode.empty), list, detail, note);
    this.thread.append(box);
    const say = (text) => { note.textContent = text; };
    const row = (label, hint, iconName, onClick) => {
      const btn = this.el('button', 'sb-ai-pick-row');
      btn.setAttribute('type', 'button');
      btn.append(this.icon(iconName), this.el('span', 'sb-ai-pick-label', label));
      if (hint) btn.append(this.el('span', 'sb-ai-pick-hint', hint));
      btn.addEventListener('click', () => { say(''); onClick(); });
      list.append(btn);
      return btn;
    };
    const finish = async (getRows, label, from) => {
      say('Opening…');
      try {
        const rows = uniqueRows(await getRows());
        if (!rows.length) { say("Couldn't find any papers there. Try Find papers instead."); return; }
        await this.finishPick(kind, rows, label, from);
      } catch (error) {
        this.host.logError(error);
        say("Couldn't open those papers.");
      }
    };
    const scopeRows = async (scope) => (await this.host.searchLibrary('', scope, 200)).map(paperRowFromLibrary);
    (async () => {
      const items = (await this.host.context().catch(() => [])).filter((c) => c.why === 'selected' && c.attachment.kind === 'zoteroItem');
      if (items.length) {
        row('Selected papers', `${items.length} in your library`, 'paper', () => finish(() => this.rowsFromSelected(items), selectionLabel(items), 'selection'));
      }
      if (this.host.can.scopes) {
        row('A collection', null, 'duplicate', () => {
          detail.replaceChildren();
          Promise.resolve(this.host.collections()).then((nodes) => {
            const tree = new CollectionTree(this.doc, nodes ?? [], [], () => { use.disabled = tree.getKeys().length === 0; });
            const use = this.el('button', 'sb-button is-primary', 'Use these papers');
            use.disabled = true;
            use.addEventListener('click', () => {
              const keys = tree.getKeys();
              const names = keys.map((k) => tree.byKey.get(k)?.name).filter(Boolean);
              finish(() => scopeRows({ kind: 'collections', keys }), names.length === 1 ? names[0] : `${names.length} collections`, 'selection');
            });
            detail.replaceChildren(tree.root, use);
          }).catch((error) => this.host.logError(error));
        });
        row('A tag', null, 'duplicate', async () => {
          detail.replaceChildren();
          const names = [...new Set(await this.host.scopeNames('tag'))].sort();
          const select = /** @type {HTMLSelectElement} */ (this.el('select', 'sb-ai-select'));
          for (const name of names) { const o = /** @type {HTMLOptionElement} */ (this.el('option', '', name)); o.value = name; select.append(o); }
          const use = this.el('button', 'sb-button is-primary', 'Use these papers');
          use.addEventListener('click', () => finish(() => scopeRows({ kind: 'tag', name: select.value }), select.value, 'selection'));
          detail.replaceChildren(...(names.length ? [select, use] : [this.el('div', 'sb-muted', 'You have no tags yet.')]));
        });
      }
      const searches = (await FindView.list(this.host).catch(() => [])).filter((s) => s.count > 0).slice(0, 5);
      for (const search of searches) {
        row(search.query, `${search.count} papers · saved search`, 'find', () => this.pickSavedSearch(kind, search.id));
      }
      if (!list.children.length) say('Nothing to pick from yet. Select papers in your library, or start with Find papers.');
    })().catch((error) => this.host.logError(error));
  }

  /** A saved Find search as the paper set: its session when it has one, else it is imported (`import from: "find:<id>"`). */
  async pickSavedSearch(kind, id) {
    this.picking = null;
    await this.openFind(id);
    await this.refreshArtifacts();
    if (!this.sessionID && !(await this.importFind())) return;
    await this.openPaperTool(kind, this.papersInSession()?.ref);
  }

  /** The picked papers become an `import from: "selection"` step (in this session, or a new one) and open with the
   *  right tab (Chat with papers) or the Columns popover (Extract data). */
  async finishPick(kind, rows, label, from) {
    const ai = await this.host.ai();
    let id = this.sessionID;
    if (!id) {
      id = await ai.conversations.create('chat', this.projectOpt());
      await ai.conversations.rename(id, label.replace(/\s+/g, ' ').slice(0, 60));
    }
    const summary = await ai.sessions.put(id, { kind: 'import', from, label }, importDraft(label, rows));
    this.sessionID = id;
    if (!this.findID) this.conversationID ??= id;
    this.picking = null;
    this.setMode('chat', { fresh: false });
    this.thread.replaceChildren();
    const cards = this.thread.appendChild(this.el('div', 'sb-art-cards'));
    this.artifacts = await ai.sessions.view(id).then((v) => v.results, () => this.artifacts);
    this.sessionResults = this.artifacts;
    this.addArtifactCard(cards, summary);
    this.noteArtifact(summary, { skipPanel: true });
    this.setHeaderTitle(label);
    ChatView.refreshAll();
    await this.openPaperTool(kind, summary.ref);
  }

  // ------------------------------------------------------------------ citations

  /** "Hou et al. 2024" for a citekey; the key shows until the lookup answers. */
  paperLabel(node, citekey) {
    const cached = this.host.citeLabel(citekey);
    node.textContent = cached?.label ?? citekey;
    if (!cached) this.host.resolveLabel(citekey).then((label) => { node.textContent = label; });
  }

  /** Click a citation, or a report reference: select the paper in the library, or (⌘/Ctrl-click) open its note. */
  openPaper(citekey, openNote) {
    this.host.openRef({ kind: 'paper', citekey }, { newTab: openNote });
  }

  static style(doc) {
    installStyle(doc, 'second-brain-ai-style', CHAT_CSS);
  }

  /** The paper rows of library items (selected ones): the library's own record when it answers, else the bare item. */
  async rowsFromSelected(items) {
    const rows = await Promise.all(items.slice(0, 200).map(async (item) => {
      const hits = await this.host.searchLibrary(item.label, { kind: 'library' }, 5).catch(() => []);
      const hit = hits.find((h) => h.ref.kind === 'paper' && h.ref.citekey === item.attachment.citekey);
      return hit ? paperRowFromLibrary(hit) : paperRowFromContext(item);
    }));
    return rows.filter(Boolean);
  }

  /** New from selection (spec 011 U5): a new session over the selected library papers, then the Chat with papers tab
   *  (`'papers'`), the Columns popover (`'extract'`) or a Research report on the set (`'report'`). The selection card
   *  and the item context menu both come here. @param {'papers' | 'extract' | 'report'} kind @param {ContextItem[]} items */
  async startFromSelection(kind, items) {
    // One start at a time: a double click, or a menu command Zotero fires more than once, must not make two sessions.
    if (this.running || this.startingFromSelection) return;
    const papers = selectedPapers(items);
    if (!papers.length) return;
    this.startingFromSelection = true;
    try {
      this.setMode('chat'); // a new session, never the open one
      const rows = uniqueRows(await this.rowsFromSelected(papers));
      if (!rows.length) { this.host.notice("Couldn't find those papers."); return; }
      await this.finishPick(kind === 'report' ? 'papers' : kind, rows, selectionLabel(papers), 'selection');
      if (kind === 'report') {
        const set = this.papersInSession();
        if (set) await this.reportFrom(set);
      }
    } catch (error) {
      this.host.logError(error);
      this.host.notice("Couldn't start from those papers.");
    } finally {
      this.startingFromSelection = false;
    }
  }
}

/** The running mark (spec 008 A2): seven dots chasing round a ring, in the icon set's 16 px box and
 *  currentColor. Under prefers-reduced-motion only the still centre dot shows (CSS). */
function spinner(doc) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'sb-ai-spinner');
  svg.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 7; i++) {
    const angle = (i / 7) * 2 * Math.PI - Math.PI / 2;
    const dot = doc.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', (8 + 5.5 * Math.cos(angle)).toFixed(2));
    dot.setAttribute('cy', (8 + 5.5 * Math.sin(angle)).toFixed(2));
    dot.setAttribute('r', '1.3');
    dot.setAttribute('class', 'sb-ai-spinner-dot');
    dot.style.animationDelay = `${i * 155}ms`;
    svg.append(dot);
  }
  const still = doc.createElementNS(SVG_NS, 'circle');
  still.setAttribute('cx', '8');
  still.setAttribute('cy', '8');
  still.setAttribute('r', '2.5');
  still.setAttribute('class', 'sb-ai-spinner-still');
  svg.append(still);
  return svg;
}

/** A quoted selection on one short line. */
function quoteLabel(text) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

/** Chip icons by attachment kind (existing icon set, no new glyphs). */
const ATTACHMENT_ICON = { zoteroItem: 'paper', note: 'note', quote: 'chat', collection: 'duplicate', tag: 'duplicate' };

/** A context item's identity for dismissal: the same paper selected and then opened to read counts as new. */
function contextItemKey(item) {
  return `${item.why}:${attachmentKey(item.attachment)}`;
}

/** @param {import("../../../agent/src/domain").Attachment} attachment */
function attachmentKey(attachment) {
  if (attachment.kind === 'zoteroItem') return `zoteroItem:${attachment.citekey}`;
  if (attachment.kind === 'note') return `note:${attachment.path}`;
  return JSON.stringify(attachment);
}

const CHAT_CSS = `
tab-content:has(> .sb-ai) { display: flex; }
.sb-ai { flex: 1; display: flex; height: 100%; min-width: 0; background: var(--sb-ui-bg); color: var(--sb-ui-text); font-size: 13px; }
/* the chat's sizes: text 13 / 11.5 px, title 20 px; corners 6 (rows), 10 (chips, messages), 18 (message box), round (pills) */
.sb-ai-icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.sb-ai [hidden] { display: none !important; }
.sb-ai-side { width: 220px; flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 8px;
	border-inline-end: 1px solid var(--sb-ui-line); background: var(--sb-ui-bg-side); }
.sb-ai-new { align-self: stretch; }
.sb-ai-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 1px; }
.sb-ai-list-empty { padding: 4px 6px; }
.sb-ai-conv { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; }
.sb-ai-conv > .sb-ai-icon { width: 14px; height: 14px; opacity: .6; }
.sb-ai-conv:hover { background: var(--sb-ui-hover); }
.sb-ai-conv.is-selected { background: var(--sb-ui-accent); color: var(--sb-ui-on-accent); }
.sb-ai-conv-text { flex: 1; min-width: 0; }
.sb-ai-conv-titlerow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.sb-ai-conv-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sb-ai .sb-ai-news { flex: none; padding: 0 6px; border-radius: 8px; font-size: 10.5px; line-height: 16px; font-weight: 600; white-space: nowrap; background: var(--sb-ui-accent); color: var(--sb-ui-on-accent); }
.sb-ai-conv.is-selected .sb-ai-news { background: var(--sb-ui-on-accent); color: var(--sb-ui-accent); }
.sb-ai-conv-date { font-size: 11.5px; opacity: .7; }
/* .sb-ai in front: Obsidian's button rule (button:not(.clickable-icon)) would otherwise give these a grey box that is always shown */
.sb-ai .sb-ai-conv-x, .sb-ai .sb-ai-conv-more, .sb-ai .sb-ai-chip-x { border: none; background: none; box-shadow: none; height: auto; min-height: 0; color: inherit; font: inherit; cursor: pointer; opacity: 0; padding: 0 4px; }
/* At rest the row actions take no width, so a title gets the whole row; they open on hover or keyboard focus. */
.sb-ai .sb-ai-conv .sb-ai-conv-x, .sb-ai .sb-ai-conv .sb-ai-conv-more { max-width: 0; padding: 0; overflow: hidden; flex: none; }
.sb-ai .sb-ai-conv:hover .sb-ai-conv-x, .sb-ai .sb-ai-conv:hover .sb-ai-conv-more,
.sb-ai .sb-ai-conv:focus-within .sb-ai-conv-x, .sb-ai .sb-ai-conv:focus-within .sb-ai-conv-more { opacity: .7; max-width: 24px; padding: 0 4px; }
.sb-ai-conv-more .sb-ai-icon { width: 14px; height: 14px; }
.sb-ai-side { position: relative; }
/* Projects (spec 011 U5): one quiet switcher row; the actions sit behind menus */
.sb-ai .sb-ai-project { display: flex; align-items: center; justify-content: flex-start; gap: 4px; align-self: stretch; height: auto; min-height: 0; padding: 3px 6px; box-shadow: none; border: none;
	border-radius: 6px; background: transparent; color: var(--sb-ui-muted); font: inherit; font-size: 12px; cursor: pointer; white-space: normal; text-align: start; }
.sb-ai .sb-ai-project:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-ai-project-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-ai-project-chevron { width: 12px; height: 12px; }
.sb-ai-project-pop { max-width: 204px; }
.sb-ai-pop-sep { height: 1px; margin: 4px 2px; background: var(--sb-ui-line); }
.sb-ai-project-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.sb-ai-project-form .sb-art-pop-head { padding: 0; }
.sb-ai-project-input { box-sizing: border-box; width: 100%; padding: 5px 8px; border: 1px solid var(--sb-ui-line); border-radius: 6px; background: var(--sb-ui-bg); color: var(--sb-ui-text); font: inherit; }
.sb-ai-project-note { font-size: 11.5px; color: var(--sb-ui-danger); }
.sb-ai-project-ask { line-height: 1.45; overflow-wrap: anywhere; }
.sb-ai-project-buttons { display: flex; gap: 6px; justify-content: flex-end; }
.sb-ai .sb-ai-project-form .sb-button { white-space: normal; height: auto; min-height: 0; }
.sb-ai .sb-ai-chip-x { opacity: .6; padding: 0 0 0 2px; }
/* Obsidian styles every button:not(.clickable-icon) (0,1,1) with a fill, a shadow and a fixed height; the chat's
   quiet buttons need one more class to stay quiet there. */
.sb-ai .sb-ai-chip-x, .sb-ai .sb-ai-add, .sb-ai .sb-ai-picker-item, .sb-ai .sb-ai-picker-more, .sb-ai .sb-ai-jump {
	height: auto; min-height: 0; box-shadow: none; }
.sb-ai .sb-ai-chip-x, .sb-ai .sb-ai-picker-item, .sb-ai .sb-ai-picker-more { background: transparent; }
.sb-ai-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sb-ai-head { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--sb-ui-line); }
.sb-ai-history-toggle { border: none; background: transparent; color: var(--sb-ui-muted); font: inherit; font-size: 13px;
	line-height: 1; padding: 4px 6px; border-radius: 5px; cursor: pointer; }
.sb-ai-history-toggle:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-ai-history-newchat[hidden], .sb-ai-head-title[hidden] { display: none; }
.sb-ai-head-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sb-ui-muted); font-size: 12px; max-width: 220px; }
.sb-ai-where { margin-inline-start: auto; font-size: 11px; color: var(--sb-ui-muted); }
.sb-ai-scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
.sb-ai-thread { flex: 1 0 auto; box-sizing: border-box; width: 100%; max-width: 760px; margin: 0 auto; padding: 20px 24px 12px;
	display: flex; flex-direction: column; gap: 14px; }
.sb-ai-empty { flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding-top: 8px; }
.sb-ai-empty-icon { width: 28px; height: 28px; stroke-width: 1.25; color: var(--sb-ui-accent); margin-bottom: 4px; }
.sb-ai-empty-title { font-size: 20px; font-weight: 700; }
.sb-ai-empty-text { max-width: 460px; color: var(--sb-ui-muted); line-height: 1.45; }
.sb-ai-suggestions { margin-top: auto; padding-top: 24px; display: flex; flex-wrap: wrap; gap: 8px; max-width: 100%; }
.sb-ai-pill { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 7px 14px; border-radius: 999px; cursor: pointer;
	font: inherit; color: var(--sb-ui-text); background: transparent; border: 1px solid var(--sb-ui-line); }
.sb-ai-pill:hover { background: var(--sb-ui-hover); }
.sb-ai-pill > .sb-ai-icon { color: var(--sb-ui-accent); }
.sb-ai-pill > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-ai-user { align-self: flex-end; max-width: 85%; padding: 8px 12px; border-radius: 10px; background: var(--sb-ui-line); }
.sb-ai-msg-actions { display: flex; gap: 2px; margin-top: 4px; opacity: 0; transition: opacity 0.12s; }
.sb-ai-user .sb-ai-msg-actions { justify-content: flex-end; }
.sb-ai-user:hover .sb-ai-msg-actions, .sb-ai-answer:hover .sb-ai-msg-actions, .sb-ai-msg-actions:focus-within { opacity: 1; }
.sb-ai-msg-action { white-space: nowrap; border: none; background: none; color: var(--sb-ui-muted); font: inherit; font-size: 11.5px; padding: 1px 6px; border-radius: 5px; cursor: pointer; }
.sb-ai-msg-action:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-ai-user-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.sb-ai-user .sb-ai-chips { margin-top: 6px; }
.sb-ai-answer { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sb-ai-activities:empty, .sb-ai-notice:empty { display: none; }
.sb-ai-activities { display: flex; flex-direction: column; gap: 2px; }
/* spec 007 §3: one quiet, collapsed-by-default line per step; the chevron and reasoning/labels show only when
   opened by a click (spec 005 §4 rule 1: text first, controls on hover/focus -- here, on click, since a folded
   scrollback line has nothing to hover). */
.sb-ai-activity { font-size: 11.5px; color: var(--sb-ui-muted); }
.sb-ai-activity.is-running .sb-ai-activity-label { color: var(--sb-ui-text); }
.sb-ai-activity-head { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: default; }
.sb-ai-activity-head > .sb-ai-activity-icon { width: 12px; height: 12px; opacity: .7; }
.sb-ai-activity-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-ai-activity-chevron { margin-inline-start: 2px; cursor: pointer; color: var(--sb-ui-muted); }
.sb-ai-activity.is-expanded .sb-ai-activity-chevron { transform: rotate(90deg); }
.sb-ai-activity-body { display: none; margin: 2px 0 4px 6px; padding-inline-start: 8px; border-inline-start: 1px solid var(--sb-ui-line); min-width: 0; }
.sb-ai-activity.is-expanded .sb-ai-activity-body { display: block; }
.sb-ai-activity-head[role="button"] { cursor: pointer; }
.sb-ai-activity-head[role="button"]:focus-visible { outline: 1px solid var(--sb-ui-accent); outline-offset: 2px; border-radius: 4px; }
/* live feed: one row per step, at most nine visible, scrolling to the newest so the thread below does not jump */
.sb-ai-activity-reasoning { color: var(--sb-ui-muted); font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; margin-bottom: 4px; overflow-wrap: anywhere; }
.sb-ai-reasoning-caption { display: block; font-weight: 600; color: var(--sb-ui-faint); }
.sb-ai-activity-reasoning.is-live { max-height: calc(1.45em * 4); overflow-y: auto; overscroll-behavior: contain; }
.sb-ai-feed { display: flex; flex-direction: column; max-height: 198px; /* nine 22 px steps */ overflow-y: auto; overscroll-behavior: contain; min-width: 0; }
.sb-ai-step { flex: none; box-sizing: border-box; height: 22px; display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11.5px; color: var(--sb-ui-muted); white-space: normal; }
.sb-ai-step > .sb-ai-step-icon { width: 12px; height: 12px; opacity: .75; }
.sb-ai-step-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-ai-step.is-running .sb-ai-step-label { color: var(--sb-ui-text); }
.sb-ai-step.is-failed .sb-ai-step-label { color: var(--sb-ui-muted); }
.sb-ai-step-detail { flex: none; min-width: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sb-ui-faint); }
.sb-ai-step-mark { flex: none; width: 12px; height: 12px; display: flex; align-items: center; justify-content: center; }
.sb-ai-step.is-running .sb-ai-step-mark::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--sb-ui-accent); }
.sb-ai-step-check { width: 12px; height: 12px; color: var(--sb-ui-faint); }
.sb-ai-step-x { width: 12px; height: 12px; color: var(--sb-ui-danger); }
.sb-ai-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.sb-ai-text.is-waiting { color: var(--sb-ui-muted); }
.sb-ai-text.is-waiting:empty { display: none; }
.sb-ai-md .cite { white-space: nowrap; }
.sb-ai-md .cite.is-pending { color: var(--sb-ui-muted); }
.sb-ai-md .cite.missing, .sb-ai-md a.is-missing { color: var(--sb-ui-danger); }
/* spec 008 A2/A3: "Worked for Ns" with the dot chase while the turn runs; frozen, without the dots, after */
.sb-ai-worked { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--sb-ui-muted); }
.sb-ai-worked-time { font-variant-numeric: tabular-nums; margin-inline-start: -2px; }
.sb-ai-spinner { width: 12px; height: 12px; flex: none; fill: currentColor; color: var(--sb-ui-text); }
.sb-ai-answer:not([data-state="running"]) .sb-ai-spinner { display: none; }
.sb-ai-spinner-dot { display: none; }
.sb-ai-badge { align-self: flex-start; font-size: 11.5px; padding: 1px 6px; border-radius: 6px; background: var(--sb-ui-line); color: var(--sb-ui-muted); }
.sb-ai-notice { font-size: 11.5px; color: var(--sb-ui-muted); }
.sb-ai-error { padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--sb-ui-danger) 12%, transparent); }
.sb-ai-composer { padding: 4px 24px 16px; }
.sb-ai-composer-inner { max-width: 712px; margin: 0 auto; display: flex; flex-direction: column; gap: 6px; }
.sb-ai-box { display: flex; flex-direction: column; gap: 8px; padding: 12px 12px 10px 14px; border-radius: 18px;
	border: 1px solid var(--sb-ui-line); background: var(--sb-ui-bg); }
.sb-ai-box:focus-within { border-color: var(--sb-ui-accent); box-shadow: 0 0 10px color-mix(in srgb, var(--sb-ui-accent) 18%, transparent); }
.sb-ai-input { appearance: none; border: none; outline: none; resize: none; background: transparent; color: inherit; font: inherit; min-height: 36px; max-height: 200px; }
.sb-ai-input:focus, .sb-ai-input:focus-visible { outline: none; box-shadow: none; }
.sb-ai-inputrow { display: flex; align-items: flex-end; gap: 8px; min-width: 0; }
.sb-ai-inputrow > .sb-ai-input { flex: 1; min-width: 0; }
.sb-ai-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.sb-ai-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; box-sizing: border-box; font-size: 11.5px; padding: 3px 6px 3px 8px;
	border-radius: 10px; border: 1px solid var(--sb-ui-line); background: var(--sb-ui-bg); }
.sb-ai-chip > .sb-ai-icon { width: 12px; height: 12px; color: var(--sb-ui-muted); }
.sb-ai-chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-ai-chip-tag { flex: none; font-size: 10.5px; color: var(--sb-ui-faint); }
.sb-ai-row { display: flex; align-items: center; gap: 10px; font-size: 11.5px; color: var(--sb-ui-muted); flex-wrap: wrap; row-gap: 6px; }
.sb-ai-modewrap { position: relative; display: inline-flex; align-items: center; }
.sb-ai-modeicon { position: absolute; inset-inline-start: 9px; display: flex; pointer-events: none; color: var(--sb-ui-text); }
.sb-ai-modeicon > .sb-ai-icon { width: 14px; height: 14px; }
.sb-ai-modepick { appearance: none; font: inherit; font-weight: 600; color: var(--sb-ui-text); cursor: pointer;
	padding: 4px 22px 4px 28px; border-radius: 999px; border: 1px solid var(--sb-ui-line); background-color: var(--sb-ui-line);
	background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0l4 5 4-5z' fill='%23888'/%3E%3C/svg%3E");
	background-repeat: no-repeat; background-position: right 8px center; }
.sb-ai-sources { display: inline-flex; gap: 6px; }
.sb-ai-row > .sb-button { border-radius: 999px; padding: 3px 10px; background: transparent; }
.sb-ai-source { font: inherit; padding: 3px 10px; border-radius: 999px; cursor: pointer;
	border: 1px solid var(--sb-ui-line); background: transparent; color: var(--sb-ui-muted); }
.sb-ai-source.is-on { border-color: var(--sb-ui-accent); color: var(--sb-ui-text);
	background: color-mix(in srgb, var(--sb-ui-accent) 12%, transparent); }
.sb-ai-source:disabled { cursor: default; opacity: .45; }
.sb-ai-source.is-offline { border-style: dashed; }
.sb-ai-report-options { flex-wrap: wrap; row-gap: 6px; }
.sb-ai-scope-treewrap { flex-basis: 100%; }
.sb-ai-field { display: inline-flex; align-items: center; gap: 5px; }
.sb-ai-select, .sb-ai-year { font: inherit; padding: 2px 5px; border-radius: 6px;
	border: 1px solid var(--sb-ui-line); background: var(--sb-ui-bg); color: var(--sb-ui-text); }
.sb-ai-year { width: 56px; appearance: textfield; text-align: start; }
.sb-ai-year::-webkit-inner-spin-button, .sb-ai-year::-webkit-outer-spin-button { appearance: none; margin: 0; }
.sb-ai-conv.is-awaiting_approval .sb-ai-conv-date { color: var(--sb-ui-accent); }
.sb-ai-conv.is-selected .sb-ai-conv-date { color: inherit; }
/* options: one button in the controls row, a small panel above it */
.sb-ai-box { position: relative; }
.sb-ai-localbtn { display: inline-flex; align-items: center; gap: 5px; font: inherit; padding: 3px 10px; border-radius: 999px; cursor: pointer; max-width: 240px; min-width: 0;
	border: 1px solid var(--sb-ui-line); background: transparent; color: var(--sb-ui-muted); white-space: normal; text-align: left;
	height: auto; min-height: 0; box-shadow: none; }
.sb-ai-localbtn-text { min-width: 0; overflow-wrap: anywhere; }
.sb-ai-localbtn:hover, .sb-ai-localbtn.is-open { color: var(--sb-ui-text); background: var(--sb-ui-hover); }
.sb-ai-localbtn.is-local { color: var(--sb-ui-text); border-color: var(--sb-ui-accent); }
.sb-local-pop { width: 340px; max-height: min(70vh, 460px); }
.sb-local-pop .sb-art-item, .sb-local-pop .sb-art-item-label, .sb-local-pop .sb-art-item-hint { white-space: normal; text-align: left; }
.sb-local-pop .sb-art-item-label { overflow-wrap: anywhere; }
.sb-local-empty, .sb-local-status, .sb-local-note { padding: 4px 8px; font-size: 11.5px; color: var(--sb-ui-muted); white-space: normal; overflow-wrap: anywhere; }
/* "More models (N)": a quiet row that opens the untested models in place; rows grow with their text, whatever the host does to a <button> */
.sb-ai .sb-local-more { display: flex; align-items: center; justify-content: flex-start; gap: 6px; width: 100%; box-sizing: border-box; padding: 6px 8px; margin: 0; border: none; border-radius: 6px;
	background: transparent; box-shadow: none; color: var(--sb-ui-muted); font: inherit; font-size: 12px; text-align: left; white-space: normal; cursor: pointer; }
.sb-ai .sb-local-more:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-art-pop .sb-local-more { height: auto !important; min-height: 0 !important; max-height: none !important; }
.sb-local-more-chev { transform: rotate(-90deg); transition: transform .12s; }
.sb-local-more.is-open .sb-local-more-chev { transform: none; }
@media (prefers-reduced-motion: reduce) { .sb-local-more-chev { transition: none; } }
.sb-local-note { border-top: 1px solid var(--sb-ui-line); margin-top: 4px; padding-top: 8px; }
/* "Set as default": a quiet text row at the bottom, whatever the host does to a <button> */
.sb-ai .sb-local-default { display: block; width: 100%; box-sizing: border-box; padding: 6px 8px; margin: 4px 0 0; border: none; border-top: 1px solid var(--sb-ui-line); border-radius: 0 0 6px 6px;
	background: transparent; box-shadow: none; color: var(--sb-ui-muted); font: inherit; font-size: 12px; text-align: left; white-space: normal; cursor: pointer; }
.sb-ai button.sb-local-default:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-art-pop .sb-local-default { height: auto !important; min-height: 0 !important; max-height: none !important; }
.sb-ai .sb-local-default.is-current { cursor: default; }
.sb-ai-passages { margin: 8px 0 0; font-size: 12px; color: var(--sb-ui-muted); }
.sb-ai-passages-head { cursor: pointer; white-space: normal; }
.sb-ai-passages-list { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; }
.sb-ai-passage { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
.sb-ai-passage-title { color: var(--sb-ui-text); font-weight: 600; }
.sb-ai-passage-ref { font-size: 11px; }
.sb-ai-passage-text { margin-top: 2px; }
.sb-ai-usage-line { display: block; font-size: 11px; color: var(--sb-ui-muted); }
.sb-ai-options-button { font: inherit; padding: 3px 10px; border-radius: 999px; cursor: pointer; max-width: 260px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--sb-ui-line); background: transparent; color: var(--sb-ui-muted); }
.sb-ai-options-button:hover, .sb-ai-options-button.is-open { color: var(--sb-ui-text); background: var(--sb-ui-hover); }
.sb-ai-box > .sb-ai-report-options { position: absolute; inset-inline: 8px; bottom: calc(100% + 6px); z-index: 4; padding: 10px 12px;
	border-radius: 10px; border: 1px solid var(--sb-ui-line); background: var(--sb-ui-bg); box-shadow: var(--sb-ui-shadow); }
/* what the user is looking at (spec 008 C1/C2): "<title> Current", a selection, or the selected papers */
.sb-ai-context > .sb-ai-icon { color: var(--sb-ui-accent); }
.sb-ai-context-title { min-width: 0; max-width: 240px; font-weight: 500; color: var(--sb-ui-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* the + button and the @ picker (spec 008 C3) */
.sb-ai .sb-ai-add { flex: none; width: 26px; height: 26px; padding: 0; display: flex; align-items: center; justify-content: center; border-radius: 50%;
	border: 1px solid var(--sb-ui-line); background: transparent; box-shadow: none; color: var(--sb-ui-muted); font: inherit; font-size: 16px; line-height: 1; cursor: pointer; }
.sb-ai .sb-ai-add:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-ai-box > .sb-ai-picker { position: absolute; inset-inline: 8px; bottom: calc(100% + 6px); z-index: 5; display: flex; flex-direction: column;
	max-height: 320px; overflow: hidden; border-radius: 10px; border: 1px solid var(--sb-ui-line); background: var(--sb-ui-bg); }
.sb-ai-picker-search { font: inherit; margin: 8px 8px 2px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--sb-ui-line);
	background: var(--sb-ui-bg); color: var(--sb-ui-text); outline: none; box-shadow: none; }
.sb-ai-picker-search:focus { border-color: var(--sb-ui-accent); }
.sb-ai-picker-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px; display: flex; flex-direction: column; }
.sb-ai-picker-group { font-size: 10.5px; font-weight: 600; color: var(--sb-ui-faint); padding: 6px 8px 2px; }
.sb-ai-picker-item { flex: none; display: flex; align-items: center; gap: 8px; width: 100%; height: auto; text-align: start; font: inherit; color: var(--sb-ui-text);
	background: transparent; border: none; box-shadow: none; border-radius: 6px; padding: 5px 8px; cursor: pointer; }
.sb-ai-picker-item > .sb-ai-icon { width: 14px; height: 14px; color: var(--sb-ui-muted); }
.sb-ai .sb-ai-picker-item:hover, .sb-ai .sb-ai-picker-item[aria-selected="true"] { background: var(--sb-ui-hover); }
.sb-ai-picker-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-ai-picker-detail { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--sb-ui-faint); }
.sb-ai-picker-empty { padding: 8px; color: var(--sb-ui-muted); }
.sb-ai-picker-more { flex: none; display: flex; justify-content: flex-start; font: inherit; font-size: 11.5px; text-align: start; height: auto; padding: 7px 12px; border: none; border-radius: 0;
	border-top: 1px solid var(--sb-ui-line); background: transparent; box-shadow: none; color: var(--sb-ui-muted); cursor: pointer; }
.sb-ai .sb-ai-picker-more:hover { color: var(--sb-ui-text); background: var(--sb-ui-hover); }
/* "jump to latest" while following is paused (spec 008 S3) */
.sb-ai-composer-inner { position: relative; }
.sb-ai .sb-ai-jump { position: absolute; bottom: calc(100% + 8px); inset-inline-start: 50%; transform: translateX(-50%); z-index: 2; height: auto;
	font: inherit; font-size: 11.5px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--sb-ui-line); box-shadow: none;
	background: var(--sb-ui-bg); color: var(--sb-ui-text); cursor: pointer; }
.sb-ai .sb-ai-jump:hover { background: var(--sb-ui-hover); }
/* the docked sidebar and other narrow places */
.sb-ai { position: relative; }
.sb-ai-open-tab { border: none; background: transparent; color: var(--sb-ui-muted); font: inherit; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
.sb-ai-open-tab:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-ai-host-sidebar .sb-ai-where { display: none; }
.sb-ai.is-narrow .sb-ai-side { position: absolute; inset: 0 auto auto 0; width: min(320px, 85%); max-height: 70%; z-index: 3;
	box-shadow: var(--sb-ui-shadow); border-inline-end: none; border-bottom: 1px solid var(--sb-ui-line); }
.sb-ai.is-narrow .sb-ai-head { gap: 4px; padding: 6px 8px; }
.sb-ai.is-narrow .sb-ai-head-title { flex: 1; min-width: 0; max-width: none; }
.sb-ai.is-narrow .sb-ai-history-newchat { min-width: 26px; padding: 2px 6px; font-size: 15px; line-height: 1; }
.sb-ai.is-narrow .sb-ai-open-tab { margin-inline-start: auto; }
.sb-ai.is-narrow .sb-ai-thread { padding: 12px 12px 8px; gap: 10px; }
.sb-ai.is-narrow .sb-ai-composer { padding: 0 10px 10px; }
.sb-ai.is-narrow .sb-ai-composer-inner { max-width: none; }
.sb-ai.is-narrow .sb-ai-box { padding: 10px 10px 8px 12px; border-radius: 14px; }
.sb-ai.is-narrow .sb-ai-row { flex-wrap: wrap; row-gap: 6px; gap: 6px; }
.sb-ai.is-narrow .sb-ai-empty-icon { width: 22px; height: 22px; }
.sb-ai.is-narrow .sb-ai-empty-title { font-size: 16px; }
.sb-ai.is-narrow .sb-ai-empty-text { font-size: 12px; }
.sb-ai.is-narrow .sb-ai-suggestions { padding-top: 12px; gap: 6px; }
.sb-ai.is-narrow .sb-ai-pill { padding: 5px 11px; }
.sb-ai.is-narrow .sb-fp-row { grid-template-columns: 18px minmax(0, 1fr); }
.sb-ai.is-narrow .sb-fp-abstract { grid-column: 2; -webkit-line-clamp: 3; }
.sb-ai-send { flex: none; box-sizing: border-box; width: 30px; height: 30px; min-height: 0; padding: 0; white-space: nowrap; box-shadow: none; display: flex; align-items: center; justify-content: center;
	border: none; border-radius: 50%; cursor: pointer; color: var(--sb-ui-on-accent); background: var(--sb-ui-accent); }
.sb-ai-send > .sb-ai-icon { stroke-width: 1.75; }
.sb-ai-send[data-state="stop"] > .sb-ai-icon { fill: currentColor; }
.sb-ai-send[data-state="idle"] { cursor: default; background: color-mix(in srgb, var(--sb-ui-accent) 35%, var(--sb-ui-bg)); }
/* spec 008 A1/A2: every animation lives here, so prefers-reduced-motion gets plain text and one still dot */
@media (prefers-reduced-motion: no-preference) {
	.sb-ai-answer[data-state="running"] .sb-ai-worked-label, .sb-ai-activity.is-running .sb-ai-activity-label {
		background: linear-gradient(90deg, var(--sb-ui-muted) 0%, var(--sb-ui-text) 50%, var(--sb-ui-muted) 100%);
		background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
		animation: sb-ai-shimmer 2.5s ease-in-out infinite; }
	.sb-ai-spinner-dot { display: inline; animation: sb-ai-dot-chase 1.4s ease-in-out infinite; }
	.sb-ai-spinner-still { display: none; }
	.sb-ai-activity-chevron { transition: transform .12s ease; }
	.sb-ai-step.is-new { animation: sb-ai-step-in .18s ease-out both; }
	.sb-ai-step.is-running .sb-ai-step-mark::before { animation: sb-ai-step-pulse 1.2s ease-in-out infinite; }
}
@keyframes sb-ai-step-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes sb-ai-step-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@keyframes sb-ai-shimmer { from { background-position: -200% 0; } to { background-position: 200% 0; } }
@keyframes sb-ai-dot-chase { 0%, 100% { opacity: .2; } 30% { opacity: 1; } }
`;
