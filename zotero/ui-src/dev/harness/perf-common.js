// ui-src/dev/harness/perf-common.js. Shared driving code for dev/harness/perf.html and perf-obsidian.html
// (spec 009). Builds a deterministic scripted chat stream through the REAL ChatView code path (view.submit() ->
// createFakeHost's reply() -> view.stream()), not a hand-rolled simulation, and exposes win.__perfHarness so
// dev/perf.mjs can drive every scenario via page.evaluate. No test framework here: this is a perf probe, and its
// only contract is the shape of the objects it returns to perf.mjs.
import { createFakeHost } from './fake-host.js';

/** Page globals the perf pages and perf.mjs set; typed loosely because they are not part of the DOM lib. */
const win = /** @type {any} */ (window);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** mulberry32: a tiny seeded PRNG, good enough for reproducible timing jitter and chunk sizes. Not a dependency —
 *  perf.mjs's spec explicitly asks for this inline rather than pulling one in. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fixed markdown body every scripted stream assembles (content is fixed across runs for reproducibility;
 *  only the chunking and inter-delta delays are seeded-random). Covers every block markdown.js renders: headings,
 *  a bullet list, a numbered list, a fenced code block with a language tag, a table, and citations in this
 *  codebase's `[@citekey]` syntax (src/chat/markdown.js's `inline()` pattern group 5). */
export function buildFixedMarkdown() {
  return [
    '# Findings',
    '',
    '## Summary',
    'This is a performance harness answer used to exercise the chat renderer under load [@smith2020]. It covers headings, lists, code and a table so the markdown pipeline sees a realistic mix of content, the same shape a real streamed answer has in production [@lee2019].',
    '',
    '### Key points',
    '- Streaming text arrives in small chunks and must coalesce into one paint per animation frame',
    '- The renderer rebuilds the DOM node by node rather than using innerHTML',
    '- Citations are checked once the answer finishes, not while it is still streaming',
    '',
    '### Steps',
    '1. Mount the chat view against thirty prior turns',
    '2. Stream one hundred twenty deltas of markdown text',
    '3. Measure scripting time, frame intervals and long tasks',
    '',
    '```js',
    'function paintOnce(turn) {',
    '  const shown = visibleText(turn.live.raw);',
    '  if (shown === turn.live.painted) return;',
    '  turn.live.painted = shown;',
    '}',
    '```',
    '',
    '| Metric | Budget | Notes |',
    '| --- | --- | --- |',
    '| Scripting p95 | 6 ms | per update |',
    '| Frame interval p95 | 18 ms | animation frame |',
    '| Long tasks | 0 | over 50 ms |',
    '',
    'See also the related discussion in [@chen2021] for background on scroll-follow behaviour.',
  ].join('\n');
}

/** Chops `text` into `count` deltas, 5-40 chars each (seeded), covering the whole string exactly -- the harness
 *  needs fixed final content, not fixed chunk count, so the last chunk absorbs whatever remains once the budget
 *  runs out; in practice this lands within a couple of chunks of `count`. */
export function chopIntoDeltas(text, rng, count = 120) {
  const chunks = [];
  let remaining = text;
  for (let i = 0; i < count - 1 && remaining.length > 0; i++) {
    const leaveForRest = count - 1 - i;
    const maxLen = Math.max(1, remaining.length - leaveForRest);
    const wanted = 5 + Math.floor(rng() * 36);
    const take = Math.max(1, Math.min(wanted, maxLen, remaining.length));
    chunks.push(remaining.slice(0, take));
    remaining = remaining.slice(take);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

const FAKE_CITATIONS = [
  { ref: { kind: 'paper', citekey: 'smith2020' }, status: 'resolved', title: 'A Performance Harness Study' },
  { ref: { kind: 'paper', citekey: 'lee2019' }, status: 'resolved', title: 'Streaming Renderers in Practice' },
  { ref: { kind: 'paper', citekey: 'chen2021' }, status: 'resolved', title: 'Scroll-Follow Behaviour' },
];

const SHORT_MARKDOWN = [
  '**Short answer.** Yes, this behaves as expected [@smith2020].',
  '- one\n- two\n- three',
  '`inline code` and a plain sentence.',
  '## A short heading\nWith one line under it.',
  '1. first\n2. second',
  'Just a plain sentence with no formatting at all.',
];

// ---------------------------------------------------------------- instrumentation state

const state = {
  paintDurationsMs: /** @type {number[]} */ ([]),   // wall-clock ms spent inside ChatView.prototype.paintText per call (the render path)
  frameTimestamps: /** @type {number[]} */ ([]),    // performance.now() at each rAF tick while a stream runs
  longTasks: /** @type {{ start: number, duration: number }[]} */ ([]),          // { start, duration } from PerformanceObserver({entryTypes:['longtask']})
  rafHandle: /** @type {number | null} */ (null),
  longTaskObserver: /** @type {PerformanceObserver | null} */ (null),
  recalcLayoutSamples: [], // { t, recalcMs, layoutMs } filled by scenarioA's CDP-sampling hook, obsidian page only
};

let patched = false;
function patchPaintText() {
  if (patched) return;
  patched = true;
  const ChatView = win.SecondBrainUI.ChatView;
  const orig = ChatView.prototype.paintText;
  ChatView.prototype.paintText = function patchedPaintText(turn) {
    const t0 = performance.now();
    orig.call(this, turn);
    // --inject-slowdown (perf.mjs sets win.__injectSlowdown before mount): an actual CPU-blocking loop so it
    // shows up as scripting time, not a setTimeout that would just push the frame later without costing CPU.
    if (win.__injectSlowdown) {
      const end = performance.now() + 8;
      while (performance.now() < end) { /* busy-wait, deliberately */ }
    }
    const t1 = performance.now();
    state.paintDurationsMs.push(t1 - t0);
  };
}

function startFrameLoop() {
  state.frameTimestamps = [];
  const tick = () => {
    state.frameTimestamps.push(performance.now());
    state.rafHandle = requestAnimationFrame(tick);
  };
  state.rafHandle = requestAnimationFrame(tick);
}
function stopFrameLoop() {
  if (state.rafHandle !== null) cancelAnimationFrame(state.rafHandle);
  state.rafHandle = null;
}

function startLongTaskObserver() {
  state.longTasks = [];
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTasks.push({ start: entry.startTime, duration: entry.duration });
    });
    observer.observe({ entryTypes: ['longtask'] });
    state.longTaskObserver = observer;
  } catch { /* longtask entry type unsupported: leave state.longTasks empty rather than crash the harness */ }
}
function stopLongTaskObserver() {
  state.longTaskObserver?.disconnect();
  state.longTaskObserver = null;
}

// ---------------------------------------------------------------- host + view construction

function makeHost(extra = {}) {
  return createFakeHost({ kind: win.__perfCssKind === 'obsidian' ? 'obsidian' : win.__perfCssKind === 'web' ? 'web' : 'zotero', placement: win.__perfCssKind === 'web' ? 'page' : 'tab', calls: [], ...extra });
}

/** Scripted async-iterable reply for one turn: `deltas` text chunks at seeded 16-50ms cadence, then `done` with
 *  the fixed full text and fake citations. `onDelta` (optional) fires after each chunk lands, before the next
 *  sleep -- scenarioA's obsidian sampler uses it to call back into Node between updates. */
async function* scriptedReply(deltas, rng, onDelta) {
  let full = '';
  for (const delta of deltas) {
    await sleep(16 + Math.floor(rng() * 35));
    full += delta;
    if (onDelta) await onDelta(delta, full);
    yield { type: 'text', delta };
  }
  yield { type: 'done', answer: { text: full, citations: FAKE_CITATIONS, structured: null, usage: {} } };
}

/** Creates a fresh ChatView mounted at #root (clearing whatever was there), backed by a host whose `reply()` is
 *  driven by `nextReply` (set per-submit via `hostRef.reply`, since createFakeHost bakes `reply` in at
 *  construction -- we instead pass a mutable holder so successive submits can each script their own stream). */
function mountView() {
  const root = /** @type {HTMLElement} */ (document.getElementById('root'));
  root.replaceChildren();
  const replyHolder = { current: /** @type {any} */ (null) };
  const host = makeHost({ reply: (input) => replyHolder.current(input) });
  const view = new win.SecondBrainUI.ChatView(host, document);
  root.append(view.root);
  patchPaintText();
  return { view, host, replyHolder };
}

/** Adds `n` finished turns (alternating user/answer) synchronously, before any measurement window starts -- the
 *  30-message "realistic prior scroll height" setup the spec calls for. Uses the real `addUser`/`addAnswer`/
 *  `finish` path, the same one a reopened chat's history replay uses. */
function seedFinished(view, n) {
  for (let i = 0; i < n; i++) {
    view.addUser(`Prior question ${i + 1}: what about case ${i + 1}?`);
    const turn = view.addAnswer();
    view.finish(turn, SHORT_MARKDOWN[i % SHORT_MARKDOWN.length], []);
  }
}

/** @param {any} view @param {{ current: any }} replyHolder @param {{ seed?: any, deltaCount?: number, question?: string, onDelta?: any }} [opts] */
async function submitScripted(view, replyHolder, { seed, deltaCount = 120, question = 'Run the scripted benchmark stream, please.', onDelta } = {}) {
  const rng = mulberry32(seed);
  const deltas = chopIntoDeltas(buildFixedMarkdown(), rng, deltaCount);
  replyHolder.current = () => scriptedReply(deltas, rng, onDelta);
  view.input.value = question;
  view.input.dispatchEvent(new Event('input'));
  await view.submit();
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function frameIntervals(timestamps) {
  const out = [];
  for (let i = 1; i < timestamps.length; i++) out.push(timestamps[i] - timestamps[i - 1]);
  return out;
}

// ---------------------------------------------------------------- scenarios

win.__perfHarness = {
  ready: true,

  setInjectSlowdown(flag) { win.__injectSlowdown = !!flag; },

  /** Scenario A: mount with 30 finished turns, then one scripted 120-update stream. Measurement window starts
   *  only after the 30 seed turns are painted (they're synchronous, so "after" is just "after seedFinished()
   *  returns"). Returns raw samples; perf.mjs computes median/min/max across repeats. */
  async scenarioA({ seed = 1 } = {}) {
    const { view, replyHolder } = mountView();
    seedFinished(view, 30);
    state.paintDurationsMs = [];
    startFrameLoop();
    startLongTaskObserver();
    const t0 = performance.now();
    await submitScripted(view, replyHolder, { seed });
    const t1 = performance.now();
    stopFrameLoop();
    // Long-task entries can arrive slightly after the triggering task; give the observer a beat to flush.
    await sleep(50);
    stopLongTaskObserver();
    const intervals = frameIntervals(state.frameTimestamps.filter((t) => t >= t0 && t <= t1 + 50));
    const longTasksInWindow = state.longTasks.filter((lt) => lt.start >= t0 && lt.start <= t1 + 50);
    return {
      totalMs: t1 - t0,
      // renderMs: wall-clock time spent inside ChatView.prototype.paintText (the DOM-diff/paint path), NOT the
      // whole main-thread cost of the scenario -- perf.mjs additionally brackets this scenario with CDP
      // Performance.getMetrics (ScriptDuration/TaskDuration/RecalcStyleDuration/LayoutDuration) for that.
      renderDurationsMs: state.paintDurationsMs.slice(),
      renderP95Ms: percentile(state.paintDurationsMs, 95),
      renderTotalMs: state.paintDurationsMs.reduce((a, b) => a + b, 0),
      frameIntervalP95: percentile(intervals, 95),
      framesOver33: intervals.filter((ms) => ms > 33).length,
      longTasksOver50: longTasksInWindow.filter((lt) => lt.duration > 50).length,
    };
  },

  /** Scenario A, sampled: same as scenarioA but calls `win.__cdpSample(updateIndex)` (an exposeFunction
   *  binding perf.mjs installs before navigation, backed by a CDP `Performance.getMetrics` call) every 6th
   *  update, and returns the raw {t, recalcMs, layoutMs} cumulative-counter samples so perf.mjs can diff
   *  consecutive samples into a per-~6-updates style-recalc/layout cost. True per-update granularity isn't
   *  obtainable without a CDP round trip on every single delta, which would itself perturb the measurement far
   *  more than the 8ms budget it's trying to measure -- sampling every 6th update trades resolution for a
   *  bounded number of round trips (about 20 per run) while still resolving p95-ish behaviour across the stream. */
  async scenarioARecalcLayout({ seed = 1 } = {}) {
    const { view, replyHolder } = mountView();
    seedFinished(view, 30);
    const samples = [];
    let count = 0;
    const onDelta = async () => {
      count += 1;
      if (count % 6 !== 0) return;
      const m = await win.__cdpSample();
      samples.push({ t: performance.now(), recalcMs: m.recalc, layoutMs: m.layout });
    };
    const before = await win.__cdpSample();
    await submitScripted(view, replyHolder, { seed, onDelta });
    const after = await win.__cdpSample();
    return { before, after, samples };
  },

  /** Scenario B: 200 keydown+input events into the composer at a seeded 15-30ms cadence, concurrently with one
   *  scripted stream. `PerformanceObserver({entryTypes:['event']})` was tried first, but Chrome's Event Timing
   *  API only creates entries for *trusted* input (real hardware/OS-generated events); Playwright-dispatched
   *  synthetic `KeyboardEvent`s never triggered a single entry, silently giving a permanent 0 instead of a real
   *  reading. Measured directly instead: timestamp at dispatch, then the first `requestAnimationFrame` after it
   *  (the next paint opportunity) -- this is a direct measurement of "keydown -> next paint", exactly what the
   *  budget table asks for, and doesn't depend on trusted-event quirks.
   *
   *  The raw delay floors at ~one frame (16.7ms) whenever nothing is dropped, so a p95 that hugs 16ms just means
   *  "no dropped frame" and can't show a regression until it's already bad. Reported as framesLate = the number
   *  of EXTRA frame boundaries the delay crossed beyond the unavoidable first one
   *  (max(0, ceil(delay / 16.7) - 1)): 0 for a clean single-frame response, 1 the first time a frame is dropped,
   *  and so on -- a metric that moves off zero the moment a regression exists, instead of hugging a constant. */
  async scenarioB({ seed = 2 } = {}) {
    const { view, replyHolder } = mountView();
    seedFinished(view, 30);
    const durations = [];
    const rng = mulberry32(seed + 1000);
    const typed = 'The quick brown fox jumps over the lazy dog while the chat keeps streaming its answer below '.repeat(3);
    const typing = (async () => {
      for (let i = 0; i < 200; i++) {
        await sleep(15 + Math.floor(rng() * 16));
        const ch = typed[i % typed.length];
        const t0 = performance.now();
        view.input.value += ch;
        view.input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        view.input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        durations.push(performance.now() - t0);
      }
    })();
    const streaming = submitScripted(view, replyHolder, { seed });
    await Promise.all([typing, streaming]);
    const FRAME_MS = 1000 / 60; // ~16.7ms
    const framesLate = durations.map((d) => Math.max(0, Math.ceil(d / FRAME_MS) - 1));
    return {
      eventDurations: durations,
      eventDelayP95Ms: percentile(durations, 95),
      framesLateP95: percentile(framesLate, 95),
      framesLateMax: framesLate.length ? Math.max(...framesLate) : 0,
    };
  },

  /** Scenario C: scroll up mid-stream (follower should pause), then back to bottom (follower should resume),
   *  while counting jank frames (> 33ms) the whole time. Reads `view.follower.enabled`/`.following` directly --
   *  the same state ScrollFollower exposes to the "jump to latest" button (src/chat/scroll-follow.js). */
  async scenarioC({ seed = 3 } = {}) {
    const { view, replyHolder } = mountView();
    seedFinished(view, 30);
    startFrameLoop();
    const t0 = performance.now();
    let updateCount = 0;
    const onDelta = async () => {
      updateCount += 1;
      if (updateCount === 40) {
        view.scroller.scrollTop -= 400;
        view.scroller.dispatchEvent(new Event('scroll'));
      }
    };
    const streamDone = submitScripted(view, replyHolder, { seed, onDelta });
    // Wait until update 40 has landed and the pause has had a chance to register.
    while (updateCount < 40) await sleep(5);
    await sleep(300);
    const pausedAfterScrollUp = view.follower.enabled && !view.follower.following;
    view.scroller.scrollTop = view.scroller.scrollHeight;
    view.scroller.dispatchEvent(new Event('scroll'));
    await streamDone;
    const t1 = performance.now();
    stopFrameLoop();
    const resumedAtEnd = view.follower.following;
    const intervals = frameIntervals(state.frameTimestamps.filter((t) => t >= t0 && t <= t1 + 50));
    return {
      pausedAfterScrollUp,
      resumedAtEnd,
      framesOver33: intervals.filter((ms) => ms > 33).length,
    };
  },

  /** Scenario D: 20x create a detached ChatView, stream a short (20-delta) turn into it, then drop it. Heap is
   *  measured by perf.mjs via CDP before/after (HeapProfiler.collectGarbage + Runtime.getHeapUsage), since that
   *  needs the CDP session's own GC call, not anything obtainable from inside the page. */
  async scenarioD({ seed = 4, iterations = 20 } = {}) {
    for (let i = 0; i < iterations; i++) {
      const container = document.createElement('div');
      container.style.cssText = 'position:absolute; left:-9999px; width:400px; height:400px;';
      document.body.append(container);
      const replyHolder = { current: /** @type {any} */ (null) };
      const host = makeHost({ reply: (input) => replyHolder.current(input) });
      let view = new win.SecondBrainUI.ChatView(host, document);
      container.append(view.root);
      await submitScripted(view, replyHolder, { seed: seed * 1000 + i, deltaCount: 20 });
      view.destroy?.();
      container.remove();
      view = null;
    }
    return { iterations };
  },

  /** Scenario E: performance.now() immediately before `new ChatView` to the moment the composer textarea is in
   *  the document and not disabled. ChatView's constructor builds its whole DOM synchronously (build()/
   *  showEmpty() are plain sync calls, no microtask hop), so this mostly measures construction cost; it's still
   *  timed end-to-end rather than assumed, in case a future change makes any part of it async. */
  async scenarioE() {
    const root = /** @type {HTMLElement} */ (document.getElementById('root'));
    root.replaceChildren();
    const host = makeHost();
    const t0 = performance.now();
    const view = new win.SecondBrainUI.ChatView(host, document);
    root.append(view.root);
    while (view.input.disabled || !document.body.contains(view.input)) await sleep(1);
    const t1 = performance.now();
    return { ms: t1 - t0 };
  },
};
