// @ts-nocheck -- UI glue moved from content/*.js (spec 005 C1), which was never typechecked in Zotero either;
// host.d.ts, tools.d.ts and domain.d.ts are still the checked interfaces these files must match.
// ui-src/src/chat/report-view.js. Moved from content/report-view.js's SecondBrain.ReportView (spec 005 C1).
// Same behaviour and pixels as 0.22, including the calmer report card (stages()/planCard(), spec §4): one
// progress line, the plan as a plain numbered list with editable question and strategy text, × and field
// outlines on hover/focus only. This is the reference the older panels (stage 2) get redrawn to.
import { el, button, installStyle } from './dom-helpers.js';
import { renderMarkdown } from './markdown.js';
import { clarifyCard, foldedAnswers } from './clarify-card.js';
import { usedLine } from './skills-data.js';
import { addLabel } from '../host-words.js';

export class ReportView {
  static STAGES = [
    ['plan', 'Make a plan'],
    ['approve', 'Waiting for your approval'],
    ['research', 'Research each sub-question'],
    ['screen', 'Check sources and remove duplicates'],
    ['synthesize', 'Write the report'],
    ['publish', 'Save the note'],
  ];

  /** spec 007 §2.1: pipeline 2's stages, in order (a review whose progress carries `lines` runs these). */
  static STAGES_2 = [
    ['clarify', 'Check the question'],
    ['plan', 'Make a plan'],
    ['approve', 'Waiting for your approval'],
    ['search', 'Search for papers'],
    ['screen', 'Screen the papers'],
    ['extract', 'Read and extract'],
    ['synthesize', 'Write the report'],
    ['publish', 'Save the note'],
  ];

  /** spec 007 E8: a Systematic review adds the check on unclear papers after screening. */
  static STAGES_SYSTEMATIC = [
    ...ReportView.STAGES_2.slice(0, 5),
    ['review', 'Check the unclear papers'],
    ...ReportView.STAGES_2.slice(5),
  ];

  static AGENT_LABEL = { waiting: 'Waiting', running: 'Researching', done: 'Done', failed: "Couldn't finish" };

  static STRENGTH_LABEL = { strong: 'Strong', moderate: 'Moderate', weak: 'Weak' };

  /** What a history row says about a review. */
  static statusLine(progress) {
    const state = progress.status.state;
    const name = progress.systematic ? 'Systematic review' : 'Report';
    if (state === 'done') return `${name} · finished`;
    if (state === 'awaiting_answer') return `${name} · has a question for you`;
    if (state === 'awaiting_review') return `${name} · has papers for you to check`;
    if (state === 'awaiting_approval') return `${name} · waiting for your approval`;
    if (state === 'stopped') return `${name} · stopped`;
    return `${name} · working…`;
  }

  constructor(chat, id) {
    this.chat = chat;
    this.host = chat.host;
    this.id = id;
    this.plan = null; // the plan shown for approval, so research rows can show sub-question text
    this.added = new Set(); // citekey/doi/url/title of outside papers already added to Zotero
    this.watching = null;
    this.root = this.el('div', 'sb-ai-answer sb-rp');
  }

  el(tag, cls, text) { return el(this.chat.doc, tag, cls, text); }

  button(label, onClick, primary = false) { return button(this.chat.doc, label, onClick, primary); }

  async ai() { return this.host.ai(); }

  /** Follows the review until it is done, stopped or waiting for approval. Calling it again restarts the watch
   *  (approving and resuming end the previous one). */
  async watch() {
    this.watching?.abort();
    this.lastSnapshot = null; // a restarted watch (after an answer, an approval, a failed send) always repaints once
    const controller = new this.chat.win.AbortController();
    this.watching = controller;
    try {
      for await (const progress of (await this.ai()).reviews.watch(this.id, { signal: controller.signal })) {
        if (controller.signal.aborted) return;
        this.render(progress);
        this.chat.onReviewProgress(progress);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      this.host.logError(error);
      this.root.replaceChildren(this.el('div', 'sb-ai-error', error?.message ?? String(error)));
    }
  }

  stop() {
    this.watching?.abort();
    this.watching = null;
  }

  render(progress) {
    // An identical snapshot (the engine pushes the settled state twice) must not rebuild the view: it would close an
    // opened evidence claim and discard half-typed edits on the plan card.
    const key = JSON.stringify(progress);
    if (key === this.lastSnapshot) return;
    this.lastSnapshot = key;
    const status = progress.status;
    if (status.state === 'awaiting_approval') this.plan = status.plan;
    this.two = Array.isArray(progress.lines);
    this.systematic = Boolean(progress.systematic);
    this.root.replaceChildren();
    if (progress.skills?.length) this.root.append(this.skillLine(progress.skills));
    if (status.state === 'done') this.root.append(this.report(progress));
    else {
      this.root.append(this.stages(progress));
      if (status.state === 'awaiting_answer') this.root.append(this.clarify(status.questions));
      else if (status.state === 'awaiting_review') this.root.append(this.unclearCard(status));
      else if (status.state === 'awaiting_approval') this.root.append(this.planCard());
      else if (status.state === 'stopped') this.root.append(this.controls([this.button('Resume', () => this.resume(), true), this.cancelButton()]));
      else this.root.append(this.controls([this.button('Stop', () => this.cancel())]));
    }
    this.outsideSources = progress.outside ?? [];
    if (this.outsideSources.length) this.root.append(this.outside(this.outsideSources));
    this.chat.scrollToEnd();
  }

  /** spec 011 U3: the skills this report runs with, and the notice when one was cut to fit. */
  skillLine(skills) {
    const box = this.el('div', 'sb-rp-skills');
    box.append(this.el('span', 'sb-rp-skills-names', usedLine(skills.map((k) => k.name))));
    for (const k of skills) if (k.notice) box.append(this.el('span', 'sb-rp-skills-notice', k.notice));
    return box;
  }

  // ------------------------------------------------------------------ while it runs

  /** One quiet line for where the review is ("Step 2 of 6 · Waiting for your approval"); researchers are
   *  listed only while they run, where their state is worth seeing. */
  stages(progress) {
    const status = progress.status;
    const current = status.state === 'awaiting_approval' ? 'approve' : status.state === 'awaiting_answer' ? 'clarify' : status.state === 'awaiting_review' ? 'review' : status.stage;
    const stages = this.systematic ? ReportView.STAGES_SYSTEMATIC : this.two ? ReportView.STAGES_2 : ReportView.STAGES;
    const at = Math.max(0, stages.findIndex(([id]) => id === current));
    const box = this.el('div', `sb-rp-stages is-${status.state}`);
    if (this.two) {
      box.append(this.stageLines(progress.lines.filter((l) => l.state === 'done')));
      // The stage now running shows what its researchers are doing, as it happens (their searches and reads).
      const live = progress.lines.find((l) => l.state === 'running' && l.entries?.length);
      if (live) box.append(this.liveFeed(live));
    }
    const line = this.el('div', 'sb-rp-step');
    line.append(this.el('span', 'sb-rp-step-n', `Step ${at + 1} of ${stages.length}`), this.el('span', '', stages[at][1]));
    if (status.state === 'stopped') line.append(this.el('span', 'sb-rp-note', 'stopped, resume anytime'));
    const screened = stages.findIndex(([id]) => id === 'screen');
    if (!this.two && at > screened && progress.papersFound) line.append(this.el('span', 'sb-rp-note', `· ${progress.papersFound} ${progress.papersFound === 1 ? 'paper' : 'papers'} from your library`));
    box.append(line);
    if (this.two && progress.counts && status.state === 'running') line.append(this.el('span', 'sb-rp-note', `· ${progress.counts.candidates} papers found`));
    if (status.state === 'running' && (current === 'research' || current === 'search') && status.agents?.length) {
      for (const agent of status.agents) {
        const question = this.plan?.subQuestions.find((sq) => sq.id === agent.subQuestion)?.question ?? agent.subQuestion;
        const sub = this.el('div', `sb-rp-agent is-${agent.state}`);
        sub.append(this.el('span', 'sb-rp-agent-state', ReportView.AGENT_LABEL[agent.state] ?? agent.state), this.el('span', '', question));
        box.append(sub);
      }
    }
    return box;
  }

  /** The running stage's calls: a heading with the counts, then one row per call with a mark for its state. */
  liveFeed(line) {
    const feed = this.el('div', 'sb-rp-live');
    feed.append(this.el('div', 'sb-rp-live-head', line.detail ? `${line.title} · ${line.detail}` : line.title));
    const list = this.el('div', 'sb-rp-live-list');
    for (const entry of line.entries.slice(-12)) {
      const row = this.el('div', `sb-rp-live-row is-${entry.state}`);
      row.append(this.el('span', 'sb-rp-live-mark', entry.state === 'done' ? '✓' : entry.state === 'failed' ? '×' : '·'), this.el('span', 'sb-rp-live-text', entry.label));
      list.append(row);
    }
    feed.append(list);
    return feed;
  }

  /** The finished stages as quiet lines ("Ran searches · 14 searches, 212 papers"), derived by the engine from its files. */
  stageLines(lines) {
    const box = this.el('div', 'sb-rp-lines');
    for (const line of lines) {
      const row = this.el('div', `sb-rp-line is-${line.icon}`);
      row.append(this.el('span', 'sb-rp-line-title', line.title));
      if (line.detail) row.append(this.el('span', 'sb-rp-line-detail', line.detail));
      box.append(row);
    }
    return box;
  }

  /** spec 007 E8: more than 10% of the papers could not be settled against a strict criterion. "Include them all" keeps
   *  them (the default for an unclear paper); "Let me look" lists each with the criterion it was unclear on and a
   *  toggle, and Continue sends only the ones turned off. */
  unclearCard(status) {
    const card = this.el('div', 'sb-rp-unclear');
    const n = status.unclear.length;
    const text = this.el('div', 'sb-rp-unclear-text', `${n} of ${status.total} papers are unclear. The abstracts don't settle the strict criteria for them.`);
    card.append(text);
    const keep = new Map(status.unclear.map((u) => [u.id, u.include]));
    const send = async (overrides) => {
      card.classList.add('is-sent');
      try {
        await (await this.ai()).reviews.screened(this.id, overrides);
      } catch (error) {
        this.host.logError(error);
        this.host.notice(`Couldn't send that: ${error?.message ?? error}`);
      }
      this.watch();
    };
    const list = this.el('div', 'sb-rp-unclear-list');
    list.hidden = true;
    for (const u of status.unclear) {
      const row = this.el('div', 'sb-rp-unclear-row');
      const text = this.el('div', 'sb-rp-unclear-paper');
      text.append(this.el('div', 'sb-rp-unclear-title', `${u.title}${u.year ? ` (${u.year})` : ''}`));
      if (u.because.length) text.append(this.el('div', 'sb-rp-unclear-why', `Unclear on: ${u.because.join('; ')}`));
      const toggle = this.el('button', 'sb-rp-unclear-toggle', 'Included');
      toggle.setAttribute('type', 'button');
      toggle.addEventListener('click', () => {
        keep.set(u.id, !keep.get(u.id));
        toggle.textContent = keep.get(u.id) ? 'Included' : 'Left out';
        row.classList.toggle('is-out', !keep.get(u.id));
      });
      row.append(text, toggle);
      list.append(row);
    }
    const all = this.button('Include them all', () => send([]), true);
    // With the side panel available the list opens there (the screened papers, a toggle on each unclear row); the inline
    // list stays for a host without one.
    const look = this.button('Let me look', () => {
      if (typeof this.chat.openScreening === 'function') {
        look.hidden = true;
        text.textContent = `${n} of ${status.total} papers are unclear. The list is open beside the chat: turn off the ones to leave out, then continue there. Or include them all here.`;
        this.chat.openScreening(this.id).catch((error) => this.host.logError(error));
        return;
      }
      list.hidden = false; look.hidden = true; all.hidden = true; go.hidden = false;
    });
    look.classList.add('sb-rp-quiet');
    const go = this.button('Continue', () => send([...keep].filter(([, v]) => !v).map(([id]) => ({ id, include: false }))), true);
    go.hidden = true;
    card.append(list, this.controls([all, look, go]));
    return card;
  }

  /** The clarify card: the questions the lead needs answered before it plans (spec 007 §2.2). */
  clarify(questions) {
    return clarifyCard(this.chat.doc, questions, async (answers) => {
      this.root.replaceChildren(this.stageLines([{ icon: 'clarify', title: 'Scope', detail: foldedAnswers(questions, answers) }]));
      try {
        await (await this.ai()).reviews.answer(this.id, answers);
      } catch (error) {
        this.host.logError(error);
        this.host.notice(`Couldn't send your answer: ${error?.message ?? error}`);
      }
      this.watch();
    });
  }

  /** The plan reads as a numbered list; a line only turns into an edit field when clicked, so five sub-questions
   *  don't arrive as ten boxes. */
  planCard() {
    const card = this.el('div', 'sb-rp-plan');
    const head = this.el('div', 'sb-rp-plan-head');
    const count = this.el('span', 'sb-rp-plan-hint');
    head.append(this.el('span', 'sb-rp-plan-title', this.systematic ? 'Review protocol' : 'Research plan'), count);
    const list = this.el('ol', 'sb-rp-plan-list');
    const subQuestions = this.plan.subQuestions.map((sq) => ({ ...sq }));
    const editable = (cls, value, placeholder, onInput) => {
      const field = this.el('div', cls, value);
      field.setAttribute('contenteditable', 'plaintext-only');
      field.dataset.placeholder = placeholder;
      field.addEventListener('input', () => onInput(field.textContent.trim()));
      field.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); field.blur(); } });
      return field;
    };
    const renderRows = () => {
      list.replaceChildren();
      count.textContent = `${subQuestions.length} ${subQuestions.length === 1 ? 'question' : 'questions'} · click one to change it`;
      subQuestions.forEach((sq, index) => {
        const item = this.el('li', 'sb-rp-plan-item');
        const text = this.el('div', 'sb-rp-plan-text');
        text.append(editable('sb-rp-plan-q', sq.question, 'Sub-question', (v) => { sq.question = v; }),
          editable('sb-rp-plan-s', sq.strategy, 'How to look for it', (v) => { sq.strategy = v; }));
        const remove = this.el('button', 'sb-rp-plan-x', '×');
        remove.title = 'Remove this question';
        remove.addEventListener('click', () => { subQuestions.splice(index, 1); renderRows(); });
        item.append(text, remove);
        list.append(item);
      });
    };
    renderRows();
    const criteria = (this.plan.criteria ?? []).map((c) => ({ ...c }));
    const columns = (this.plan.columns ?? []).map((c) => ({ ...c }));
    const protocol = this.systematic && this.plan.protocol ? { ...this.plan.protocol } : null;
    const caps = this.plan.caps ? { ...this.plan.caps } : null;
    const extras = this.two ? this.planExtras(this.plan.assumed ?? [], criteria, columns, editable, protocol, caps) : null;
    const approve = this.button(this.systematic ? 'Start review' : 'Start research', async () => {
      const kept = subQuestions.filter((sq) => sq.question.trim());
      if (!kept.length) return;
      const usable = criteria.filter((c) => c.text.trim());
      if (this.systematic && !usable.some((c) => c.strict)) { this.host.notice('A systematic review needs at least one strict criterion.'); return; }
      const plan = this.two
        ? { ...this.plan, subQuestions: kept, criteria: usable.map((c, i) => ({ ...c, id: c.id || `criterion_${i + 1}` })), columns: columns.filter((c) => c.name.trim()).map((c) => ({ ...c, id: c.id || columnId(c.name, columns) })), ...(protocol ? { protocol } : {}), ...(caps ? { caps } : {}) }
        : { subQuestions: kept };
      await (await this.ai()).reviews.approvePlan(this.id, plan);
      this.watch();
    }, true);
    const add = this.button('Add a question', () => {
      subQuestions.push({ id: `sq-${Date.now()}-${subQuestions.length}`, question: '', strategy: '', sources: this.plan.subQuestions[0]?.sources ?? ['library', 'scholarly'] });
      renderRows();
      list.lastChild?.querySelector('.sb-rp-plan-q')?.focus();
    });
    const cancel = this.cancelButton();
    add.classList.add('sb-rp-quiet');
    cancel.classList.add('sb-rp-quiet');
    card.append(head, list);
    if (extras) card.append(extras);
    card.append(this.controls([approve, add, cancel]));
    return card;
  }

  /** Pipeline 2's extra plan lines, all plain editable text (spec 007 §2.3): what the lead assumed, the protocol (a
   *  systematic review), the criteria (a Strict / Preferred toggle that shows on hover) and the columns to extract
   *  (chips with × on hover). A systematic review keeps at least one strict criterion and shows its caps. */
  planExtras(assumed, criteria, columns, editable, protocol = null, caps = null) {
    const box = this.el('div', 'sb-rp-extras');
    if (assumed.length) box.append(this.el('div', 'sb-rp-assumed', assumed.join(' · ')));
    if (protocol) {
      const section = this.el('div', 'sb-rp-section');
      section.append(this.el('div', 'sb-rp-section-title', 'Protocol'));
      const fields = [['population', 'Population'], ['intervention', 'Intervention'], ['comparison', 'Comparison'], ['outcomes', 'Outcomes'], ['studyDesigns', 'Study designs']];
      for (const [key, label] of fields) {
        const row = this.el('div', 'sb-rp-protocol-row');
        const value = key === 'studyDesigns' ? (protocol.studyDesigns ?? []).map((d) => STUDY_DESIGN_LABEL[d] ?? d).join(', ') : (protocol[key] ?? '');
        row.append(this.el('span', 'sb-rp-protocol-label', label), editable('sb-rp-protocol-value', value, 'Not applicable', (v) => {
          if (key === 'studyDesigns') protocol.studyDesigns = v ? parseDesigns(v) : null;
          else protocol[key] = v || null;
        }));
        section.append(row);
      }
      box.append(section);
    }
    if (criteria.length || this.systematic) {
      const section = this.el('div', 'sb-rp-section');
      section.append(this.el('div', 'sb-rp-section-title', 'Criteria'));
      const list = this.el('div', 'sb-rp-criteria');
      const lastStrict = (c) => this.systematic && c.strict && criteria.filter((x) => x.strict).length === 1;
      const draw = () => {
        list.replaceChildren();
        criteria.forEach((c, index) => {
          const row = this.el('div', 'sb-rp-criterion');
          const toggle = this.el('button', 'sb-rp-strict', c.strict ? 'Strict' : 'Preferred');
          toggle.title = c.strict ? 'A paper that fails this is left out. Click to make it preferred.' : 'A paper that fails this is kept. Click to make it strict.';
          toggle.addEventListener('click', () => {
            if (lastStrict(c)) { this.host.notice('A systematic review needs at least one strict criterion.'); return; }
            c.strict = !c.strict;
            draw();
          });
          const remove = this.el('button', 'sb-rp-plan-x', '×');
          remove.title = 'Remove this criterion';
          remove.addEventListener('click', () => {
            if (lastStrict(c)) { this.host.notice('A systematic review needs at least one strict criterion.'); return; }
            criteria.splice(index, 1);
            draw();
          });
          row.append(editable('sb-rp-criterion-text', c.text, 'Criterion', (v) => { c.text = v; }), toggle, remove);
          list.append(row);
        });
      };
      draw();
      section.append(list);
      if (this.systematic) {
        const add = this.el('button', 'sb-rp-chip-add', 'Add a criterion');
        add.setAttribute('type', 'button');
        add.addEventListener('click', () => {
          criteria.push({ id: `criterion_${criteria.length + 1}`, text: '', strict: criteria.length === 0 });
          draw();
          list.lastChild?.querySelector('.sb-rp-criterion-text')?.focus();
        });
        section.append(add);
      }
      box.append(section);
    }
    const section = this.el('div', 'sb-rp-section');
    section.append(this.el('div', 'sb-rp-section-title', 'Columns to extract'));
    const chips = this.el('div', 'sb-rp-chips');
    const drawChips = () => {
      chips.replaceChildren();
      columns.forEach((c, index) => {
        const chip = this.el('span', 'sb-rp-chip');
        chip.append(this.el('span', 'sb-rp-chip-name', c.name));
        chip.title = c.instruction || c.name;
        const x = this.el('button', 'sb-rp-chip-x', '×');
        x.title = `Remove ${c.name}`;
        x.addEventListener('click', () => { columns.splice(index, 1); drawChips(); });
        chip.append(x);
        chips.append(chip);
      });
      const add = this.el('button', 'sb-rp-chip-add', 'Add a column');
      add.addEventListener('click', () => {
        const field = editable('sb-rp-chip-new', '', 'Column name', () => {});
        field.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter') return;
          const name = field.textContent.trim();
          if (name) columns.push({ id: columnId(name, columns), name, instruction: name, kind: 'text' });
          drawChips();
        });
        field.addEventListener('blur', () => { if (!field.textContent.trim()) drawChips(); });
        add.replaceWith(field);
        field.focus();
      });
      chips.append(add);
    };
    drawChips();
    section.append(chips);
    box.append(section);
    if (caps && this.systematic) {
      const row = this.el('div', 'sb-rp-caps');
      const number = (key, label) => {
        const input = this.el('input', 'sb-rp-caps-input');
        input.type = 'number';
        input.min = '1';
        input.max = '2000';
        input.value = String(caps[key]);
        input.addEventListener('input', () => { const n = Math.round(Number(input.value)); if (n >= 1 && n <= 2000) caps[key] = n; });
        const wrap = this.el('span', 'sb-rp-caps-item');
        wrap.append(this.el('span', '', label), input);
        return wrap;
      };
      row.append(number('candidates', 'Screen up to'), this.el('span', 'sb-rp-caps-sep', 'papers,'), number('extract', 'read up to'), this.el('span', 'sb-rp-caps-sep', 'of them. A bigger review takes longer and uses more of your plan.'));
      box.append(row);
    }
    return box;
  }

  controls(buttons) {
    const row = this.el('div', 'sb-rp-controls');
    row.append(...buttons);
    return row;
  }

  cancelButton() {
    return this.button('Cancel', () => this.cancel());
  }

  async cancel() {
    await (await this.ai()).reviews.cancel(this.id);
  }

  async resume() {
    await (await this.ai()).reviews.resume(this.id);
    this.watch();
  }

  // ------------------------------------------------------------------ the finished report

  report(progress) {
    const box = this.el('div', 'sb-rp-report');
    const report = progress.report;
    if (!report) {
      // An older Second Brain server sends no report with its progress; the note still has it.
      box.append(this.el('div', 'sb-muted', 'The review is finished. The note has the full report.'), this.exports(progress));
      return box;
    }
    const citations = report.references.filter((s) => s.citekey)
      .map((s) => ({ ref: { kind: 'paper', citekey: s.citekey }, status: 'resolved', title: s.title }));
    const md = (text) => renderMarkdown(this.host, this.chat.doc, text || '', citations);

    box.append(this.el('h2', 'sb-rp-title', report.title));
    const papers = (n) => `${n} ${n === 1 ? 'paper' : 'papers'}`;
    const counts = progress.counts
      ? [`${papers(progress.counts.included)} included`, `${progress.counts.candidates} found`]
      : [`${papers(report.references.length)} from your library`];
    if (!progress.counts && progress.outside?.length) counts.push(`${progress.outside.length} more found elsewhere`);
    box.append(this.el('div', 'sb-rp-sub', counts.join(' · ')));

    // A skill report is the skill's own text; its themes, evidence, disagreements and gaps are empty.
    if (report.body) box.append(md(report.body));

    for (const theme of report.themes ?? []) {
      box.append(this.el('h3', 'sb-rp-h', theme.heading), md(theme.body));
    }

    if (report.evidence?.length) {
      box.append(this.el('h3', 'sb-rp-h', 'Evidence'));
      const table = this.el('table', 'sb-rp-evidence');
      const head = this.el('tr');
      for (const label of ['Claim', 'Papers', 'Strength']) head.append(this.el('th', '', label));
      table.append(head);
      for (const row of report.evidence) {
        const tr = this.el('tr');
        const claim = this.el('td');
        claim.append(md(row.claim));
        const detail = row.cells?.length && progress.table ? this.evidenceCells(row.cells, progress.table, md) : null;
        if (detail) {
          tr.classList.add('is-linked');
          tr.title = 'Click to see the quotes this rests on';
          tr.addEventListener('click', (event) => {
            if (event.target.closest?.('.cite, a')) return;
            const open = tr.classList.toggle('is-open');
            if (open) tr.after(detail); else detail.remove();
          });
        }
        const papersCell = this.el('td', 'sb-rp-papers-cell');
        if (row.sources?.length) papersCell.append(md(`[@${row.sources.join('; @')}]`));
        const strength = this.el('td');
        strength.append(this.el('span', `sb-rp-strength is-${row.strength}`, ReportView.STRENGTH_LABEL[row.strength] ?? row.strength));
        tr.append(claim, papersCell, strength);
        table.append(tr);
      }
      box.append(table);
    }

    if (report.disagreements?.trim()) box.append(this.el('h3', 'sb-rp-h', 'Where the papers disagree'), md(report.disagreements));
    if (report.gaps?.trim()) box.append(this.el('h3', 'sb-rp-h', 'Gaps'), md(report.gaps));

    const how = this.el('details', 'sb-rp-details');
    how.append(this.el('summary', '', 'How this was done'));
    if (report.scope) how.append(md(report.scope));
    if (report.method) how.append(md(report.method));
    box.append(how);

    if (report.references.length) {
      const refs = this.el('details', 'sb-rp-details');
      refs.append(this.el('summary', '', `References (${report.references.length})`));
      const list = this.el('ol', 'sb-rp-refs');
      for (const source of report.references) {
        const li = this.el('li');
        const title = this.el('span', source.citekey ? 'sb-rp-ref is-link' : 'sb-rp-ref', source.title);
        if (source.citekey) {
          title.title = 'Click to show it in your library, ⌘-click to open its note';
          title.addEventListener('click', (event) => this.chat.openPaper(source.citekey, event.metaKey || event.ctrlKey));
        }
        li.append(title);
        if (source.year) li.append(` (${source.year})`);
        list.append(li);
      }
      refs.append(list);
      box.append(refs);
    }

    box.append(this.exports(progress));
    return box;
  }

  /** The row under an evidence claim: for each table cell it rests on, the paper, the column, the value and the
   *  quotes, the unverified ones marked (spec 007 §2.1, "clicking an evidence claim opens its cells' quotes"). */
  evidenceCells(cells, table, md) {
    const rows = new Map(table.rows.map((r) => [r.id, r]));
    const columns = new Map(table.columns.map((c) => [c.id, c]));
    const tr = this.el('tr', 'sb-rp-evidence-cells');
    const td = this.el('td');
    td.colSpan = 3;
    let shown = 0;
    for (const ref of cells) {
      const cell = table.cells?.[ref.row]?.[ref.column];
      const paper = rows.get(ref.row);
      if (cell?.state !== 'filled' || !paper) continue;
      shown += 1;
      const item = this.el('div', 'sb-rp-cell');
      item.append(this.el('div', 'sb-rp-cell-head', `${paper.title}${paper.year ? ` (${paper.year})` : ''} · ${columns.get(ref.column)?.name ?? ref.column}`), this.el('div', 'sb-rp-cell-value', cell.value));
      for (const quote of cell.quotes ?? []) {
        const q = this.el('div', `sb-rp-quote${quote.verified ? '' : ' is-unverified'}`, `“${quote.text}”`);
        if (!quote.verified) q.append(this.el('span', 'sb-rp-quote-flag', quote.unverified ? ' Unverified: abstract not checked' : ' Unverified'));
        item.append(q);
      }
      td.append(item);
    }
    if (!shown) return null;
    tr.append(td);
    void md;
    return tr;
  }

  exports(progress) {
    const row = this.controls([]);
    for (const [format, label] of [['docx', 'Export as Word'], ['pdf', 'Export as PDF'], ['md', 'Export as Markdown']]) {
      row.append(this.button(label, () => this.exportAs(format)));
    }
    const notePath = progress.status.notePath;
    if (notePath) {
      const show = this.el('a', 'sb-rp-link', 'Show the note');
      show.title = String(notePath);
      show.addEventListener('click', () => this.host.revealFile(notePath));
      row.append(show);
    }
    return row;
  }

  async exportAs(format) {
    try {
      const { path } = await (await this.ai()).reviews.export(this.id, format);
      this.host.revealFile(path);
    } catch (error) {
      this.host.notice(`Couldn't export: ${error?.message ?? error}`);
    }
  }

  // ------------------------------------------------------------------ papers outside the library

  outside(sources) {
    const box = this.el('details', 'sb-rp-details sb-rp-outside');
    box.open = sources.length <= 8;
    const summary = this.el('summary', '', `Papers not in your library (${sources.length})`);
    box.append(summary);
    const pending = sources.filter((s) => !this.added.has(this.paperKey(s)));
    if (pending.length > 1 && this.host.can.addToLibrary) box.append(this.controls([this.button(addLabel(this.host, 'all'), () => this.addPapers(pending, box))]));
    for (const source of sources) {
      const row = this.el('div', 'sb-rp-paper');
      const text = this.el('div', 'sb-rp-paper-text');
      text.append(this.el('div', 'sb-rp-paper-title', source.title), this.el('div', 'sb-rp-paper-meta', [source.year, source.doi].filter(Boolean).join(' · ')));
      const key = this.paperKey(source);
      const add = this.button(this.added.has(key) ? 'Added' : addLabel(this.host), () => this.addPapers([source], box));
      add.hidden = !this.host.can.addToLibrary;
      add.disabled = this.added.has(key);
      row.append(text, add);
      box.append(row);
    }
    return box;
  }

  paperKey(source) { return source.citekey || source.doi || source.url || source.title; }

  async addPapers(sources, box) {
    for (const source of sources) {
      const key = this.paperKey(source);
      if (this.added.has(key)) continue;
      try {
        const result = await this.host.addToLibrary?.([{ title: source.title, year: source.year, doi: source.doi, authors: [], source: 'review', abstract: '', url: source.doi ? `https://doi.org/${source.doi}` : source.url ?? null }]);
        if (result?.items?.[0]) this.added.add(key);
      } catch (error) {
        this.host.logError(error);
      }
    }
    box.replaceWith(this.outside(this.outsideSources));
  }

  static style(doc) {
    installStyle(doc, 'second-brain-report-style', REPORT_CSS);
  }
}

const STUDY_DESIGN_LABEL = { review: 'review', systematic_review: 'systematic review', meta_analysis: 'meta-analysis', rct: 'RCT', longitudinal: 'longitudinal', other: 'other' };

/** "RCT, meta-analysis" back to study-design ids; a word that names none is dropped. @param {string} text */
function parseDesigns(text) {
  const byLabel = new Map(Object.entries(STUDY_DESIGN_LABEL).flatMap(([id, label]) => [[label.toLowerCase(), id], [id.replace(/_/g, ' '), id], [id, id]]));
  const out = [];
  for (const part of String(text).split(/[,;]/)) { const id = byLabel.get(part.trim().toLowerCase()); if (id && !out.includes(id)) out.push(id); }
  return out.length ? out : null;
}

/** A column id from its name (the engine's slug rule), unique among `columns`. */
function columnId(name, columns) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
  let id = base;
  let n = 2;
  while (columns.some((c) => c.id === id)) id = `${base}_${n++}`;
  return id;
}

const REPORT_CSS = `
.sb-rp { gap: 10px; }
.sb-rp-skills { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; color: var(--sb-ui-muted); margin-bottom: 4px; }
.sb-rp-skills-notice { color: var(--sb-ui-danger); }
.sb-rp-stages { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--sb-ui-muted); }
.sb-rp-step { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.sb-rp-step-n { color: var(--sb-ui-faint); }
.sb-rp-stages.is-stopped .sb-rp-step { color: var(--sb-ui-danger); }
.sb-rp-note { color: var(--sb-ui-muted); }
.sb-rp-agent { display: flex; gap: 8px; margin-inline-start: 12px; font-size: 12px; color: var(--sb-ui-muted); }
.sb-rp-agent-state { flex: none; width: 82px; }
.sb-rp-agent.is-running .sb-rp-agent-state { color: var(--sb-ui-text); font-weight: 600; }
.sb-rp-agent.is-failed .sb-rp-agent-state { color: var(--sb-ui-danger); }
/* the plan: a numbered list that turns editable in place, no boxes or grips */
.sb-rp-plan { display: flex; flex-direction: column; gap: 8px; }
.sb-rp-plan-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.sb-rp-plan-title { font-weight: 600; }
.sb-rp-plan-hint { font-size: 11.5px; color: var(--sb-ui-faint); }
.sb-rp-plan-list { margin: 0; padding-inline-start: 1.6em; display: flex; flex-direction: column; gap: 8px; }
.sb-rp-plan-item { position: relative; padding-inline-end: 26px; }
.sb-rp-plan-item::marker { color: var(--sb-ui-faint); font-size: 12px; }
.sb-rp-plan-text { display: flex; flex-direction: column; gap: 2px; }
.sb-rp-plan-q, .sb-rp-plan-s { border-radius: 5px; padding: 2px 6px; margin: 0 -6px; outline: none; line-height: 1.45; cursor: text; }
.sb-rp-plan-s { font-size: 12px; color: var(--sb-ui-muted); }
.sb-rp-plan-q:hover, .sb-rp-plan-s:hover { background: var(--sb-ui-hover); }
.sb-rp-plan-q:focus, .sb-rp-plan-s:focus { background: var(--sb-ui-bg); box-shadow: 0 0 0 1px var(--sb-ui-line); }
.sb-rp-plan-q:empty::before, .sb-rp-plan-s:empty::before { content: attr(data-placeholder); color: var(--sb-ui-faint); }
.sb-rp-plan-x { position: absolute; inset-inline-end: 0; top: 0; border: none; background: none; color: var(--sb-ui-muted); font: inherit; cursor: pointer; padding: 2px 6px; border-radius: 5px; opacity: 0; }
.sb-rp-plan-item:hover .sb-rp-plan-x, .sb-rp-plan-x:focus-visible { opacity: 1; }
.sb-rp-plan-x:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-button.sb-rp-quiet { background: none; border-color: transparent; box-shadow: none; color: var(--sb-ui-muted); }
.sb-button.sb-rp-quiet:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-rp-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sb-rp-link { cursor: pointer; font-size: 12px; }
.sb-rp-report { display: flex; flex-direction: column; gap: 6px; }
.sb-rp-title { font-size: 17px; margin: 0; line-height: 1.3; }
.sb-rp-sub { font-size: 12px; color: var(--sb-ui-muted); margin-bottom: 4px; }
.sb-rp-h { font-size: 14px; margin: 10px 0 0; }
.sb-rp-evidence { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.sb-rp-evidence th { text-align: start; font-weight: 600; color: var(--sb-ui-muted); border-bottom: 1px solid var(--sb-ui-line); padding: 4px 8px 4px 0; }
.sb-rp-evidence td { vertical-align: top; border-bottom: 1px solid var(--sb-ui-line); padding: 6px 8px 6px 0; }
.sb-rp-evidence .sb-md p { margin: 0; }
.sb-rp-papers-cell { width: 28%; }
.sb-rp-strength { font-size: 11px; padding: 1px 6px; border-radius: 4px; white-space: nowrap; background: var(--sb-ui-line); }
.sb-rp-strength.is-strong { background: color-mix(in srgb, var(--sb-ui-ok) 18%, transparent); }
.sb-rp-strength.is-weak { background: color-mix(in srgb, var(--sb-ui-danger) 18%, transparent); }
.sb-rp-details { border-top: 1px solid var(--sb-ui-line); padding-top: 6px; }
.sb-rp-details > summary { cursor: pointer; font-size: 12.5px; color: var(--sb-ui-muted); }
.sb-rp-details[open] > summary { margin-bottom: 6px; }
.sb-rp-refs { margin: 0; padding-inline-start: 22px; font-size: 12.5px; display: flex; flex-direction: column; gap: 2px; }
.sb-rp-ref.is-link { cursor: pointer; }
.sb-rp-ref.is-link:hover { text-decoration: underline; }
/* pipeline 2: finished-stage lines, the clarify card, the plan's criteria and columns, and an evidence claim's quotes */
.sb-rp-live { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 6px; font-size: 12px; }
.sb-rp-live-head { color: var(--sb-ui-text); }
.sb-rp-live-list { display: flex; flex-direction: column; gap: 1px; padding-left: 4px; border-left: 2px solid var(--sb-ui-line); }
.sb-rp-live-row { display: flex; gap: 6px; align-items: baseline; color: var(--sb-ui-muted); overflow-wrap: anywhere; }
.sb-rp-live-row.is-running { color: var(--sb-ui-text); }
.sb-rp-live-row.is-failed { color: var(--sb-ui-danger); }
.sb-rp-live-mark { flex: none; width: 1em; text-align: center; }
.sb-rp-lines { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; }
.sb-rp-line { display: flex; gap: 8px; align-items: baseline; color: var(--sb-ui-muted); }
.sb-rp-line-title { color: var(--sb-ui-text); }
.sb-rp-line-detail { color: var(--sb-ui-muted); }
.sb-rp-clarify { display: flex; flex-direction: column; gap: 12px; outline: none; }
.sb-rp-clarify-head { font-size: 11.5px; color: var(--sb-ui-faint); text-transform: none; }
.sb-rp-clarify-q { display: flex; flex-direction: column; gap: 4px; }
.sb-rp-clarify-text { font-weight: 600; line-height: 1.4; }
.sb-rp-clarify-choice { display: flex; gap: 10px; align-items: baseline; text-align: start; white-space: normal; background: none; border: 1px solid transparent; border-radius: 6px; padding: 5px 8px; margin: 0 -8px; color: var(--sb-ui-text); font: inherit; cursor: pointer; }
.sb-rp-clarify-choice:hover { background: var(--sb-ui-hover); }
.sb-rp-clarify-choice.is-picked { border-color: var(--sb-ui-line); background: var(--sb-ui-hover); }
.sb-rp-clarify-n { flex: none; width: 1.2em; color: var(--sb-ui-faint); font-size: 12px; }
.sb-rp-clarify-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.sb-rp-clarify-other { border-radius: 6px; padding: 5px 8px; margin: 0 -8px; outline: none; cursor: text; }
.sb-rp-clarify-other:hover { background: var(--sb-ui-hover); }
.sb-rp-clarify-other:focus { background: var(--sb-ui-bg); box-shadow: 0 0 0 1px var(--sb-ui-line); }
.sb-rp-clarify-other:empty::before { content: attr(data-placeholder); color: var(--sb-ui-faint); }
.sb-rp-clarify-decide { align-self: flex-start; background: none; border: none; color: var(--sb-ui-muted); font: inherit; cursor: pointer; padding: 2px 0; }
.sb-rp-clarify-decide:hover { color: var(--sb-ui-text); }
.sb-rp-clarify.is-sent { opacity: 0.6; pointer-events: none; }
.sb-rp-extras { display: flex; flex-direction: column; gap: 10px; }
.sb-rp-assumed { font-size: 12px; color: var(--sb-ui-muted); }
.sb-rp-section { display: flex; flex-direction: column; gap: 4px; }
.sb-rp-section-title { font-size: 11.5px; color: var(--sb-ui-faint); }
.sb-rp-criteria { display: flex; flex-direction: column; gap: 2px; }
.sb-rp-criterion { position: relative; display: flex; gap: 8px; align-items: baseline; padding-inline-end: 26px; }
.sb-rp-criterion-text { flex: 1; min-width: 0; border-radius: 5px; padding: 2px 6px; margin: 0 -6px; outline: none; cursor: text; }
.sb-rp-criterion-text:hover { background: var(--sb-ui-hover); }
.sb-rp-criterion-text:focus { background: var(--sb-ui-bg); box-shadow: 0 0 0 1px var(--sb-ui-line); }
.sb-rp-strict { border: none; background: none; font: inherit; font-size: 11.5px; color: var(--sb-ui-faint); cursor: pointer; padding: 1px 6px; border-radius: 5px; opacity: 0; white-space: nowrap; }
.sb-rp-criterion:hover .sb-rp-strict, .sb-rp-strict:focus-visible { opacity: 1; }
.sb-rp-strict:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-rp-criterion .sb-rp-plan-x { top: 0; }
.sb-rp-criterion:hover .sb-rp-plan-x { opacity: 1; }
.sb-rp-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sb-rp-chip { display: inline-flex; align-items: center; gap: 2px; padding: 1px 4px 1px 8px; border-radius: 999px; background: var(--sb-ui-hover); font-size: 12px; }
.sb-rp-chip-x { border: none; background: none; color: var(--sb-ui-muted); font: inherit; cursor: pointer; padding: 0 4px; opacity: 0; }
.sb-rp-chip:hover .sb-rp-chip-x, .sb-rp-chip-x:focus-visible { opacity: 1; }
.sb-rp-chip-add { border: none; background: none; color: var(--sb-ui-muted); font: inherit; font-size: 12px; cursor: pointer; padding: 1px 6px; border-radius: 999px; white-space: nowrap; }
.sb-rp-section > .sb-rp-chip-add { align-self: flex-start; }
.sb-rp-chip-add:hover { background: var(--sb-ui-hover); color: var(--sb-ui-text); }
.sb-rp-chip-new { min-width: 8em; border-radius: 999px; padding: 1px 8px; outline: none; box-shadow: 0 0 0 1px var(--sb-ui-line); font-size: 12px; }
.sb-rp-chip-new:empty::before { content: attr(data-placeholder); color: var(--sb-ui-faint); }
.sb-rp-evidence tr.is-linked { cursor: pointer; }
.sb-rp-evidence tr.is-linked:hover td { background: var(--sb-ui-hover); }
.sb-rp-evidence-cells td { background: var(--sb-ui-hover); padding: 6px 10px; }
.sb-rp-cell { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
.sb-rp-cell + .sb-rp-cell { border-top: 1px solid var(--sb-ui-line); }
.sb-rp-cell-head { font-size: 11.5px; color: var(--sb-ui-muted); }
.sb-rp-quote { font-size: 12px; color: var(--sb-ui-muted); font-style: italic; overflow-wrap: anywhere; }
.sb-rp-quote.is-unverified { color: var(--sb-ui-danger); }
.sb-rp-quote-flag { font-style: normal; font-size: 11px; }
.sb-rp-protocol-row { display: flex; gap: 8px; align-items: baseline; }
.sb-rp-protocol-label { flex: none; width: 7.5em; font-size: 12px; color: var(--sb-ui-muted); }
.sb-rp-protocol-value { flex: 1; min-width: 0; border-radius: 5px; padding: 2px 6px; margin: 0 -6px; outline: none; cursor: text; overflow-wrap: anywhere; }
.sb-rp-protocol-value:hover { background: var(--sb-ui-hover); }
.sb-rp-protocol-value:focus { background: var(--sb-ui-bg); box-shadow: 0 0 0 1px var(--sb-ui-line); }
.sb-rp-protocol-value:empty::before { content: attr(data-placeholder); color: var(--sb-ui-faint); }
.sb-rp-caps { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--sb-ui-muted); }
.sb-rp-caps-item { display: inline-flex; gap: 6px; align-items: center; }
.sb-rp-caps-input { width: 4.5em; font: inherit; color: var(--sb-ui-text); background: var(--sb-ui-bg); border: 1px solid var(--sb-ui-line); border-radius: 5px; padding: 1px 6px; }
.sb-rp-unclear { display: flex; flex-direction: column; gap: 8px; }
.sb-rp-unclear.is-sent { opacity: 0.6; pointer-events: none; }
.sb-rp-unclear-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow: auto; }
.sb-rp-unclear-row { display: flex; gap: 10px; align-items: flex-start; padding: 5px 0; border-bottom: 1px solid var(--sb-ui-line); }
.sb-rp-unclear-paper { flex: 1; min-width: 0; }
.sb-rp-unclear-title { overflow-wrap: anywhere; }
.sb-rp-unclear-why { font-size: 11.5px; color: var(--sb-ui-muted); }
.sb-rp-unclear-toggle { flex: none; white-space: normal; border: 1px solid var(--sb-ui-line); background: none; color: var(--sb-ui-text); font: inherit; font-size: 12px; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
.sb-rp-unclear-row.is-out .sb-rp-unclear-title { color: var(--sb-ui-faint); text-decoration: line-through; }
.sb-rp-unclear-row.is-out .sb-rp-unclear-toggle { color: var(--sb-ui-danger); }
.sb-rp-outside { display: flex; flex-direction: column; gap: 4px; }
.sb-rp-paper { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.sb-rp-paper-text { flex: 1; min-width: 0; }
.sb-rp-paper-title { font-size: 12.5px; }
.sb-rp-paper-meta { font-size: 11px; color: var(--sb-ui-muted); }
`;
