// @ts-nocheck -- test scaffolding that fakes events and loose objects on purpose; fake-host.js is the checked part.
// ui-src/dev/harness/behavior.js. Spec 008's "Success checks" for the chat, run in a real browser against the
// built bundle. Each check mounts its own ChatView on a fake host whose answers come from a stream the check
// drives by hand, so timing (frames, seconds) is under the check's control. dev/run.mjs calls
// window.__sbBehavior.run(name) and prints PASS/FAIL per check.
import { createFakeHost } from './fake-host.js';

const { ChatView } = /** @type {any} */ (window).SecondBrainUI;

/** An event stream the check feeds by hand: push() queues events, end() finishes the stream. */
function channel() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    push(...events) { queue.push(...events); wake?.(); },
    end() { closed = true; wake?.(); },
    get drained() { return queue.length === 0; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (closed) return;
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
      }
    },
  };
}

const frames = async (n = 1) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(() => r())); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (delta) => ({ type: 'text', delta });
const done = (answerText, citations = []) => ({ type: 'done', answer: { text: answerText, citations, structured: null, usage: {} } });

function mount({ height = 420, width = 560, ...hostOpts } = {}) {
  const replies = [];
  const host = createFakeHost({ placement: 'tab', calls: [], reply: () => { const ch = channel(); replies.push(ch); return ch; }, ...hostOpts });
  const wrap = document.createElement('div');
  wrap.style.cssText = `width:${width}px; height:${height}px; display:flex; border:1px solid #ccc; margin-bottom:12px;`;
  document.body.append(wrap);
  const view = new ChatView(host, document);
  view.setHistoryCollapsed(true);
  wrap.append(view.root);
  return { host, view, wrap, replies };
}

/** Sends `question` and resolves once the host has handed out the reply stream for it. */
async function send(ctx, question) {
  const before = ctx.replies.length;
  ctx.view.input.value = question;
  ctx.view.input.dispatchEvent(new Event('input'));
  const finished = ctx.view.submit();
  for (let i = 0; i < 200 && ctx.replies.length === before; i++) await sleep(5);
  return { stream: ctx.replies[ctx.replies.length - 1], finished, answer: [...ctx.view.thread.querySelectorAll('.sb-ai-answer')].pop() };
}

/** The visible answer text of a turn (not its activity lines or its "Worked for" line). */
const answerText = (answer) => answer.querySelector(':scope > .sb-ai-md, :scope > .sb-ai-text')?.textContent ?? '';
const waitFor = async (predicate, ms = 2000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await sleep(10); return predicate(); };

/** Mutation records that touched an answer's text (ignoring its activity lines and "Worked for" line). */
function textWrites(records) {
  const skip = (node) => {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!el?.closest('.sb-ai-activities, .sb-ai-worked');
  };
  return records.filter((r) => {
    if (r.target.classList?.contains('sb-ai-thread')) return false;
    if (skip(r.target)) return false;
    if (r.target.classList?.contains('sb-ai-answer')) {
      return [...r.addedNodes, ...r.removedNodes].some((n) => n.classList?.contains('sb-ai-md') || n.classList?.contains('sb-ai-text'));
    }
    return true;
  }).length;
}

const CHECKS = {
  /** S1: a burst of deltas inside one frame reaches the DOM as one write, and the latest text wins. */
  async 'raf-coalescing'() {
    const ctx = mount();
    const records = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(ctx.view.thread, { subtree: true, childList: true, characterData: true });
    const { stream, answer, finished } = await send(ctx, 'Burst');
    observer.takeRecords();
    await frames(1);
    records.length = 0;
    const words = Array.from({ length: 100 }, (_, i) => `w${i} `);
    stream.push(...words.map(text));
    await waitFor(() => stream.drained);
    await frames(2);
    const writes = textWrites(observer.takeRecords().concat(records));
    const shown = answerText(answer).trim();
    stream.push(done(words.join(''))); stream.end(); await finished;
    observer.disconnect();
    return { ok: writes === 1 && shown === words.join('').trim(), detail: { writes, shownLength: shown.length } };
  },

  /** S2: finished turns are never re-rendered while the next answer streams. */
  async 'only-live-turn-renders'() {
    const ctx = mount();
    const first = await send(ctx, 'First');
    first.stream.push(text('First **answer**.'), done('First **answer**.')); first.stream.end(); await first.finished;
    const firstAnswer = first.answer;
    const records = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(firstAnswer, { subtree: true, childList: true, characterData: true });
    const second = await send(ctx, 'Second');
    for (let i = 0; i < 5; i++) { second.stream.push(text(`part ${i} `)); await frames(1); }
    second.stream.push(done('part 0 part 1 part 2 part 3 part 4')); second.stream.end(); await second.finished;
    await frames(1);
    observer.disconnect();
    const touched = records.concat(observer.takeRecords()).length;
    return { ok: touched === 0 && answerText(second.answer).includes('part 4'), detail: { touched } };
  },

  /** S2: Markdown renders while the answer streams; citations are plain until `done` links them. */
  async 'markdown-mid-stream'() {
    const ctx = mount();
    const { stream, answer, finished } = await send(ctx, 'Markdown');
    stream.push(text('## Voles\n\nThey forage **at night** [@vole2021]'));
    await frames(2);
    const live = {
      heading: !!answer.querySelector('h2'), bold: !!answer.querySelector('strong'),
      cite: !!answer.querySelector('.cite'), citeMarkedMissing: !!answer.querySelector('.cite.missing'),
    };
    stream.push(done('## Voles\n\nThey forage **at night** [@vole2021]', [{ ref: { kind: 'paper', citekey: 'vole2021' }, status: 'resolved', title: 'Vole paper' }]));
    stream.end(); await finished;
    const final = { cite: !!answer.querySelector('.cite:not(.missing)') };
    return { ok: live.heading && live.bold && live.cite && !live.citeMarkedMissing && final.cite, detail: { live, final } };
  },

  /** S5: <think>…</think> never shows, including a half-received tag and an unclosed block. */
  async 'think-stripped'() {
    const ctx = mount();
    const { stream, answer, finished } = await send(ctx, 'Think');
    const seen = [];
    for (const chunk of ['<thi', 'nk>secret ', 'plan</th', 'ink>Visible', ' answer <think>more secret']) {
      stream.push(text(chunk));
      await frames(2);
      seen.push(answerText(answer));
    }
    stream.push(done('<think>secret plan</think>Visible answer')); stream.end(); await finished;
    const final = answerText(answer);
    const leaked = seen.concat(final).filter((s) => /secret|<thi|think>/.test(s));
    return { ok: leaked.length === 0 && seen[3].includes('Visible') && final.trim() === 'Visible answer', detail: { seen, final } };
  },

  /** S3: follows while at the end, an upward scroll pauses, "jump to latest" resumes. */
  async 'scroll-follow-pause-resume'() {
    const ctx = mount({ height: 360 });
    const s = ctx.view.scroller;
    const gap = () => s.scrollHeight - s.clientHeight - s.scrollTop;
    const jump = () => ctx.view.root.querySelector('.sb-ai-jump');
    const { stream, finished } = await send(ctx, 'Long answer');
    const para = (i) => text(`Paragraph ${i} about voles and their long, winding burrows.\n\n`);
    for (let i = 0; i < 30; i++) stream.push(para(i));
    await waitFor(() => stream.drained); await frames(3);
    const followed = gap() <= 1;
    s.scrollTop = s.scrollTop - 150;
    await new Promise((r) => s.addEventListener('scroll', r, { once: true }));
    await frames(1);
    const pausedAt = s.scrollTop;
    for (let i = 30; i < 40; i++) stream.push(para(i));
    await waitFor(() => stream.drained); await frames(3);
    const stayedPaused = Math.abs(s.scrollTop - pausedAt) <= 1 && gap() > 24;
    const jumpShown = !!jump() && !jump().hidden;
    jump()?.click();
    await frames(2);
    const resumed = gap() <= 1;
    for (let i = 40; i < 50; i++) stream.push(para(i));
    await waitFor(() => stream.drained); await frames(3);
    const followsAgain = gap() <= 1 && (!jump() || jump().hidden);
    stream.push(done('end')); stream.end(); await finished;
    return { ok: followed && stayedPaused && jumpShown && resumed && followsAgain, detail: { followed, stayedPaused, jumpShown, resumed, followsAgain } };
  },

  /** S3: a new question lands at the top of the view, with the space below it kept for the answer. */
  async 'new-question-at-top'() {
    const ctx = mount({ height: 360 });
    const first = await send(ctx, 'First');
    const long = Array.from({ length: 20 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    first.stream.push(text(long), done(long)); first.stream.end(); await first.finished;
    const second = await send(ctx, 'Second question');
    second.stream.push(text('Short.'));
    await frames(3);
    const users = ctx.view.thread.querySelectorAll('.sb-ai-user');
    const offset = users[users.length - 1].getBoundingClientRect().top - ctx.view.scroller.getBoundingClientRect().top;
    second.stream.push(done('Short.')); second.stream.end(); await second.finished;
    return { ok: offset >= 0 && offset <= 40, detail: { offset } };
  },

  /** S4 (live feed): a running turn's block opens by itself; a block the user closes stays closed while more events
   *  re-render it and after `done`, and one they reopen afterwards stays open. */
  async 'fold-state-survives'() {
    const ctx = mount();
    const { stream, answer, finished } = await send(ctx, 'Fold');
    stream.push({ type: 'reasoning', delta: 'Weighing which sources to check.' },
      { type: 'activity', id: 'a1', phase: 'start', kind: 'library', label: 'Searching your papers for "voles"' });
    await frames(2);
    const openByItself = !!answer.querySelector('.sb-ai-activity.is-expanded');
    answer.querySelector('.sb-ai-activity-head')?.click();
    const closedNow = !answer.querySelector('.sb-ai-activity.is-expanded');
    stream.push({ type: 'activity', id: 'a1', phase: 'end', kind: 'library', label: 'Searching your papers for "voles"', ok: true },
      { type: 'activity', id: 'a2', phase: 'start', kind: 'scholarly', label: 'Searching the literature' });
    await frames(2);
    const closedAfterEvents = !answer.querySelector('.sb-ai-activity.is-expanded');
    stream.push({ type: 'activity', id: 'a2', phase: 'end', kind: 'scholarly', label: 'Searching the literature', ok: true }, text('Answer.'), done('Answer.'));
    stream.end(); await finished;
    const closedAfterDone = !answer.querySelector('.sb-ai-activity.is-expanded');
    answer.querySelector('.sb-ai-activity-head')?.click();
    const reopened = !!answer.querySelector('.sb-ai-activity.is-expanded');
    return { ok: openByItself && closedNow && closedAfterEvents && closedAfterDone && reopened, detail: { openByItself, closedNow, closedAfterEvents, closedAfterDone, reopened } };
  },

  /** A3: "Worked for Ns" ticks each second while running, then freezes; the spinner goes when it's done. */
  async 'worked-for-ticks-then-freezes'() {
    const ctx = mount();
    const { stream, answer, finished } = await send(ctx, 'Timer');
    const time = () => answer.querySelector('.sb-ai-worked')?.textContent ?? '';
    const spinnerShown = () => { const sp = answer.querySelector('.sb-ai-spinner'); return !!sp && getComputedStyle(sp).display !== 'none'; };
    await frames(1);
    const atStart = time();
    const spinningAtStart = spinnerShown();
    await sleep(2150);
    const running = time();
    stream.push(text('Done.'), done('Done.')); stream.end(); await finished;
    const frozen = time();
    await sleep(1200);
    const later = time();
    const ok = /Worked for 0s/.test(atStart) && /Worked for 2s/.test(running) && frozen === later && /Worked for 2s/.test(frozen)
      && spinningAtStart && !spinnerShown() && answer.dataset.state === 'done';
    return { ok, detail: { atStart, running, frozen, later, spinningAtStart, spinnerAfter: spinnerShown(), state: answer.dataset.state } };
  },

  /** A3: a reasoning-only step reads "Thinking" while it runs and "Thought for Ns" once the answer starts. */
  async 'thought-for'() {
    const ctx = mount();
    const { stream, answer, finished } = await send(ctx, 'Reason');
    stream.push({ type: 'reasoning', delta: 'Let me think. ' });
    await frames(2);
    const label = () => answer.querySelector('.sb-ai-activity-label')?.textContent ?? '';
    const whileThinking = label();
    const runningClass = !!answer.querySelector('.sb-ai-activity.is-running');
    await sleep(1100);
    stream.push({ type: 'reasoning', delta: 'Still thinking.' });
    await frames(1);
    stream.push(text('Answer.'));
    await frames(2);
    const after = label();
    stream.push(done('Answer.')); stream.end(); await finished;
    return { ok: /^Thinking/.test(whileThinking) && runningClass && /^Thought for 1s/.test(after), detail: { whileThinking, runningClass, after } };
  },

  /** A1/A2: what the motion looks like right now (dev/run.mjs compares it under both reduced-motion settings). */
  async 'motion-probe'() {
    const ctx = mount();
    const { stream, answer, finished } = await send(ctx, 'Motion');
    stream.push({ type: 'activity', id: 'm1', phase: 'start', kind: 'library', label: 'Searching your papers' });
    await frames(2);
    const style = (sel) => { const el = answer.querySelector(sel); return el ? getComputedStyle(el) : null; };
    const probe = {
      workedAnim: style('.sb-ai-worked-label')?.animationName ?? null,
      workedColor: style('.sb-ai-worked-label')?.color ?? null,
      activityAnim: style('.sb-ai-activity.is-running .sb-ai-activity-label')?.animationName ?? null,
      dotAnim: style('.sb-ai-spinner-dot')?.animationName ?? null,
      dotShown: style('.sb-ai-spinner-dot')?.display !== 'none',
      stillShown: style('.sb-ai-spinner-still') ? style('.sb-ai-spinner-still').display !== 'none' : false,
    };
    stream.push({ type: 'activity', id: 'm1', phase: 'end', kind: 'library', label: 'Searched', ok: true }, done('ok')); stream.end(); await finished;
    return { ok: true, detail: probe };
  },

  /** C1/C2: the note being read shows as "<title> Current", a selection as its own chip; each × removes only itself. */
  async 'current-chip'() {
    const note = { attachment: { kind: 'note', path: 'Field notes/Vole diary.md' }, label: 'Vole diary', why: 'active-note' };
    const quote = { attachment: { kind: 'quote', text: 'Voles dig shallow burrows' }, label: 'Voles dig shallow burrows', why: 'selection' };
    const ctx = mount({ context: [note] });
    await ctx.view.refreshContext();
    const chips = () => [...ctx.view.chips.querySelectorAll('.sb-ai-context')];
    const first = chips().map((c) => c.textContent);
    const current = first.length === 1 && first[0].includes('Vole diary') && first[0].includes('Current');
    ctx.host._setContext([note, quote]);
    await waitFor(() => chips().length === 2);
    const both = chips().length === 2;
    chips().find((c) => c.textContent.includes('Voles dig'))?.querySelector('.sb-ai-chip-x')?.click();
    const onlyNoteLeft = chips().length === 1 && chips()[0].textContent.includes('Vole diary')
      && ctx.view.activeContext.length === 1 && ctx.view.activeContext[0].attachment.kind === 'note';
    chips()[0]?.querySelector('.sb-ai-chip-x')?.click();
    const noneLeft = chips().length === 0;
    ctx.host._setContext([{ ...note, attachment: { kind: 'note', path: 'Field notes/Burrows.md' }, label: 'Burrows' }]);
    await waitFor(() => chips().length === 1);
    const nextNote = chips()[0]?.textContent.includes('Burrows') ?? false;
    return { ok: current && both && onlyNoteLeft && noneLeft && nextNote, detail: { first, both, onlyNoteLeft, noneLeft, nextNote } };
  },

  /** C3: typing @ opens the picker, filtered as you type, ≤30 results, categories in a fixed order; Enter attaches. */
  async 'at-picker'() {
    const candidates = [
      { category: 'paper', label: 'Foraging Strategies of the Lesser Spangled Vole', attachment: { kind: 'zoteroItem', citekey: 'bramblewood2021' } },
      { category: 'paper', label: 'A Unified Theory of Doorknob Ergonomics', attachment: { kind: 'zoteroItem', citekey: 'handlebar2019' } },
      { category: 'collection', label: 'Voles', attachment: { kind: 'collection', name: 'Voles' } },
      { category: 'note', label: 'Vole diary', detail: 'Field notes', attachment: { kind: 'note', path: 'Field notes/Vole diary.md' } },
      ...Array.from({ length: 40 }, (_, i) => ({ category: 'note', label: `Filler about voles ${i}`, attachment: { kind: 'note', path: `Filler/${i}.md` } })),
    ];
    const ctx = mount({ candidates });
    const input = ctx.view.input;
    const picker = () => ctx.view.root.querySelector('.sb-ai-picker');
    const items = () => [...(picker()?.querySelectorAll('.sb-ai-picker-item') ?? [])];
    input.focus();
    input.value = 'Tell me about @vol';
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input'));
    await waitFor(() => items().length > 0);
    const open = !!picker() && !picker().hidden;
    const labels = items().map((i) => i.textContent);
    const groups = [...picker().querySelectorAll('.sb-ai-picker-group')].map((g) => g.textContent);
    const order = ['Notes', 'Papers', 'Collections'];
    const inOrder = groups.every((g, i) => i === 0 || order.indexOf(groups[i - 1]) < order.indexOf(g));
    const filtered = labels.length <= 30 && !labels.some((l) => l.includes('Doorknob')) && labels.some((l) => l.includes('Lesser Spangled Vole'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await frames(1);
    const chip = ctx.view.chips.querySelector('.sb-ai-chip');
    const attached = ctx.view.attachments.length === 1 && input.value === 'Tell me about ' && !!chip && picker().hidden;
    ctx.view.root.querySelector('.sb-ai-add')?.click();
    await waitFor(() => items().length > 0);
    const search = picker()?.querySelector('.sb-ai-picker-search');
    const searchFocused = !!search && document.activeElement === search;
    if (search) { search.value = 'door'; search.dispatchEvent(new Event('input')); }
    await frames(1);
    const plusLabels = items().map((i) => i.textContent);
    const plusFiltered = plusLabels.length >= 1 && plusLabels[0].includes('Doorknob');
    search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const closed = !picker() || picker().hidden;
    return { ok: open && inOrder && filtered && attached && searchFocused && plusFiltered && closed,
      detail: { open, groups, count: labels.length, filtered, attached, value: input.value, searchFocused, plusLabels: plusLabels.slice(0, 3), closed } };
  },

  /** C4: the focused box has the accent border and a soft glow; the chat placeholder mentions @. */
  async 'composer-focus'() {
    const ctx = mount({ candidates: [] });
    ctx.view.input.focus();
    await frames(1);
    const box = getComputedStyle(ctx.view.root.querySelector('.sb-ai-box'));
    const accent = getComputedStyle(ctx.view.root).getPropertyValue('--sb-ui-accent').trim();
    const detail = { boxShadow: box.boxShadow, border: box.borderTopColor, accent, placeholder: ctx.view.input.placeholder };
    return { ok: box.boxShadow !== 'none' && /10px/.test(box.boxShadow) && ctx.view.input.placeholder === 'Ask anything · @ to add context', detail };
  },
};

/** @type {any} */ (window).__sbBehavior = {
  names: Object.keys(CHECKS),
  async run(name) {
    try {
      return await CHECKS[name]();
    } catch (error) {
      return { ok: false, detail: String(error?.stack ?? error) };
    }
  },
};
